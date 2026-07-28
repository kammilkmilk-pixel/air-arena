// ============================================================================
// combat-pipeline.js - flight paths, flares, soft-wreck descent synthesis
// ============================================================================
// ----------------------------------------------------------------------------
// 🏭 戰鬥管線處理器 (Pipeline Processors)
// ----------------------------------------------------------------------------

/** Soft wreck descent for the turn after a combat kill (gun/missile). */
function synthesizeWreckFallPath(id, t, ctx) {
    const minH = CONFIG.rules.minFlightHeight || 0.5;
    const frames = 30;
    const simPos = t.wrapper.position.clone();
    const simQuat = (t.wrapper.userData.logicalQuat || t.wrapper.quaternion).clone();
    const points = [simPos.clone()];
    const quats = [simQuat.clone()];
    let hitGround = false;

    for (let i = 0; i < frames; i++) {
        simQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.045));
        simQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.028));
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(simQuat);
        simPos.add(fwd.multiplyScalar(0.14));
        simPos.y -= 0.22;
        if (simPos.y <= minH) {
            simPos.y = minH;
            hitGround = true;
        }
        points.push(simPos.clone());
        quats.push(simQuat.clone());
    }

    t.pathPoints = points;
    t.pathQuats = quats;
    t.flightCurve = new THREE.CatmullRomCurve3(t.pathPoints, false, 'catmullrom', 0);
    t.chain = [{ yaw: 0, pitch: 0, roll: 0, throttle: 1, resultingAP: 0 }];
    ctx.log[id] = {
        pts: [...t.pathPoints],
        quats: [...t.pathQuats],
        chain: [...t.chain],
        wasFlaresArmed: false,
        damageTaken: 0
    };
    if (!ctx.log.softWreck) ctx.log.softWreck = {};
    ctx.log.softWreck[id] = true;
    if (hitGround) {
        if (!ctx.log.wreckGroundBurst) ctx.log.wreckGroundBurst = {};
        ctx.log.wreckGroundBurst[id] = true;
    }
}

function processFlightPaths(ctx) {
    combatActiveIds().forEach(id => {
        let t = teams[id]; 
        if (t.wrapper && t.userData && t.userData.gunPreview) t.userData.gunPreview.visible = false;

        // Destroyed wrecks still falling: synthesize a slow descent path for this turn.
        if (t.isDestroyed && t.wreckPhase === 'falling') {
            synthesizeWreckFallPath(id, t, ctx);
            return;
        }
        if (t.isDestroyed) return;

        t.wasFlaresArmedThisTurn = t.flaresArmed; 
        if (t.flaresArmed) { t.flareAmmo--; t.flaresArmed = false; } 
        
        let res;
        if (!t.pathPoints || t.pathPoints.length < 2) {
            let fallbackChain = t.chain && t.chain.length > 0 ? t.chain : [{yaw:0, pitch:0, roll:0, throttle:t.throttle}];
            res = simulateFlight(t, fallbackChain); 
            t.pathPoints = res.points; t.pathQuats = res.quats; 
        } else {
            res = simulateFlight(t, t.chain);
        }
        if (t.chain && t.chain.length > 0) t.chain[0].resultingAP = res.finalAP; 

        if (typeof drawTrajectoryLine === 'function') drawTrajectoryLine(t);
        if (trajectoryMeshes[id]) {
            let isCurrentPlayer = (typeof tAct !== 'undefined' && id === tAct) || (id === window.tAct);
            trajectoryMeshes[id].visible = isCurrentPlayer ? true : !!(t.userData && t.userData.showEnvelope);
        }

        t.flightCurve = new THREE.CatmullRomCurve3(t.pathPoints, false, 'catmullrom', 0);
        ctx.log[id] = { pts: [...t.pathPoints], quats: [...t.pathQuats], chain: [...t.chain], wasFlaresArmed: t.wasFlaresArmedThisTurn, damageTaken: 0 };

        let fireDelayCounter = 0; 
        let singleMissileFired = false;
        if (t.pylons) {
            t.pylons.forEach(p => {
                let isFiringNow = p.state === 'armed' && t.wpnQueued && t.weapon === 'missile' && !(t.singleMissileShot && singleMissileFired);
                let activeM = t.activeMissiles ? t.activeMissiles.find(m => m.pylonId === p.id) : null;
                
               if (isFiringNow && !activeM) {
                    let launchStep = fireDelayCounter * CONFIG.rules.missileLaunchDelay; 
                    fireDelayCounter++; 
                    singleMissileFired = true;
                    let initAP = (typeof MISSILE_MAX_AP !== 'undefined') ? MISSILE_MAX_AP : 150;
                    activeM = {
                        pylonId: p.id,
                        active: false,
                        launchStep: launchStep,
                        ap: initAP,
                        pos: new THREE.Vector3(),
                        quat: new THREE.Quaternion(),
                        exploded: false,
                        launchPos: null,
                        traveled: 0,
                        guided: false
                    };
                    t.activeMissiles.push(activeM); p.state = 'empty'; 
                }
                if (activeM && !activeM.exploded) ctx.log[`${id}MslTracks`][p.id] = []; 
            });
        }
        t.singleMissileShot = false;
    });
}

function processFlares(ctx) {
    let activeTurnFlares = [];
    if (typeof globalFlares !== 'undefined') {
        globalFlares.forEach(gf => { activeTurnFlares.push({ pos: gf.pos.clone(), vel: gf.vel.clone(), age: gf.age, teamId: gf.teamId, startFrame: 0 }); });
    }

    combatActiveIds().forEach(id => {
        let t = teams[id];
        if (t.wasFlaresArmedThisTurn && t.flightCurve) {
            let acSpeed = t.flightCurve.getLength() / 100;
            for (let burst = 0; burst < 4; burst++) { 
                let startFrame = burst * 15; 
                let sPos = t.flightCurve.getPointAt(startFrame / 100);
                let sQuat = getQuatAt(startFrame / 100, t.pathQuats);
                let vel = new THREE.Vector3((Math.random()-0.5)*0.12, -0.01, acSpeed + 0.01 + Math.random()*0.02).applyQuaternion(sQuat);
                activeTurnFlares.push({ pos: sPos.clone(), vel: vel, age: 0, teamId: id, startFrame: startFrame });
            }
        }
    });

    activeTurnFlares.forEach(f => {
        let currentPos = f.pos.clone(); let currentVel = f.vel.clone();
        let stages = CONFIG.weapons['flare'].stages || [{heat:500},{heat:150},{heat:0}];
        let heatVal = stages[f.age] ? stages[f.age].heat : 0;

        let totalSteps = CONFIG.rules.stepsPerTurn;
        for(let step = 0; step <= totalSteps; step++) { 
            if (step >= f.startFrame) {
                currentPos.add(currentVel); currentVel.multiplyScalar(0.96); currentVel.y -= 0.0005;           
                ctx.flares[step].push({ pos: currentPos.clone(), heat: heatVal, age: f.age, teamId: f.teamId, vel: currentVel.clone() });
            }
        }
    });
    ctx.log.flaresTrack = ctx.flares;
}
