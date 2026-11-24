// ============================================================================
// combat-resolution.js - per-step guns, missiles, damage & death
// ============================================================================
function recordCombatHit(ctx, victimId, attackerId, weapon, step) {
    if (!ctx || !ctx.log || !victimId || !attackerId || victimId === attackerId) return;
    if (!ctx.log.damageFrom) ctx.log.damageFrom = {};
    const friendly = (typeof combatFactionOf === 'function')
        ? combatFactionOf(victimId) === combatFactionOf(attackerId)
        : false;
    ctx.log.damageFrom[victimId] = { attackerId, weapon: weapon || 'unknown', friendly, step };
}

function combatCurrentTurn() {
    return (typeof GameContext !== 'undefined' && GameContext.state)
        ? GameContext.state.currentTurn
        : 0;
}

function finishLiveMissileShot(team, missile, outcome) {
    if (typeof closeMissileShot === 'function') {
        closeMissileShot(team, missile, outcome, combatCurrentTurn());
    }
}

/**
 * Precompute per-round ballistic stop times (`log[id].gunStops`) and surface
 * impact triggers (`building` / `ground`) once per turn so render playback
 * needs ZERO per-frame raycasts and tracers stop cleanly at exact impact points.
 */
function precomputeGunRoundStops(id, t, ctx) {
    const B = (typeof AirArenaGunBallistics !== 'undefined') ? AirArenaGunBallistics : null;
    if (!B || !t || !t.pathPoints || t.pathPoints.length < 2 || !t.pathQuats || t.pathQuats.length < 2) return;
    if (!ctx || !ctx.log || !ctx.log[id]) return;

    const vcfg = B.vfxConfig();
    const rounds = vcfg.roundsPerTurn;
    const maxFlight = vcfg.maxFlightTime;
    const throttle = (t.chain && t.chain[0] && t.chain[0].throttle != null) ? t.chain[0].throttle : (t.throttle || 4);
    const params = B.resolveGunParams(t.type || 'mig21', throttle);
    const stops = new Array(rounds);
    const logIdx = (typeof battleLog !== 'undefined' && Array.isArray(battleLog)) ? battleLog.length : 0;
    const hasObs = (typeof obstacles !== 'undefined' && Array.isArray(obstacles) && obstacles.length > 0);
    const ray = hasObs ? new THREE.Raycaster() : null;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const acVel = new THREE.Vector3();
    const muzzle = new THREE.Vector3();
    const vel0 = new THREE.Vector3();
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    const segDir = new THREE.Vector3();
    const hitNorm = new THREE.Vector3();
    const scratchA = new THREE.Vector3();
    const scratchB = new THREE.Vector3();
    const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
        ? Number(CONFIG.rules.stepsPerTurn) : 100;

    for (let b = 0; b < rounds; b++) {
        const tSpawn = B.roundSpawnTime(b, rounds);
        B.samplePosAt(tSpawn, t.pathPoints, pos);
        B.sampleQuatAt(tSpawn, t.pathQuats, quat);
        B.sampleAircraftVelocity(tSpawn, t.pathPoints, acVel, scratchA, scratchB);
        const barrel = params.barrels[b % params.barrels.length];
        B.computeMuzzleWorldPos(pos, quat, barrel, muzzle);
        const sp = B.roundSpread(b, logIdx, vcfg.spreadRad);
        B.computeBulletVelocity(quat, acVel, params.muzzleSpeed, params.elevation, sp.right, sp.up, vel0);

        let bestT = maxFlight;
        let hitKind = null;
        const hitPos = new THREE.Vector3();

        // Analytic ground intersection
        const gHitT = B.groundImpactTime(muzzle.y, vel0.y, params.gravity, vcfg.groundY);
        if (gHitT != null && gHitT > 0.002 && gHitT < bestT) {
            bestT = gHitT;
            hitKind = 'ground';
            B.evalBallisticPoint(muzzle, vel0, params.gravity, gHitT, hitPos);
            hitPos.y = Math.max(vcfg.groundY + 0.02, hitPos.y);
            hitNorm.set(0, 1, 0);
        }

        // Parabolic chord-sampled building intersection (4 chords covers full arc accurately)
        if (ray) {
            const chords = 4;
            B.evalBallisticPoint(muzzle, vel0, params.gravity, 0, pA);
            for (let c = 1; c <= chords; c++) {
                const t0 = ((c - 1) / chords) * bestT;
                const t1 = (c / chords) * bestT;
                B.evalBallisticPoint(muzzle, vel0, params.gravity, t1, pB);
                segDir.subVectors(pB, pA);
                const segLen = segDir.length();
                if (segLen > 1e-4) {
                    segDir.divideScalar(segLen);
                    ray.set(pA, segDir);
                    ray.far = segLen;
                    const hits = ray.intersectObjects(obstacles, false);
                    if (hits.length > 0 && hits[0].distance <= segLen) {
                        const frac = hits[0].distance / segLen;
                        bestT = t0 + (t1 - t0) * frac;
                        hitKind = 'building';
                        hitPos.copy(hits[0].point);
                        if (hits[0].face && hits[0].face.normal) {
                            hitNorm.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld).normalize();
                        } else {
                            hitNorm.copy(segDir).negate();
                        }
                        break;
                    }
                }
                pA.copy(pB);
            }
        }

        stops[b] = Number(bestT.toFixed(4));

        // Emit surface gun_hit trigger at exact arrival step (staggered every 2nd round to keep VFX crisp & fast)
        if (hitKind && (b % 2 === 0)) {
            const arrivalStep = Math.round((tSpawn + bestT) * stepsPerTurn);
            if (arrivalStep >= 0 && arrivalStep <= stepsPerTurn + 40) {
                const seed = (typeof sparkSeedFrom === 'function')
                    ? sparkSeedFrom(arrivalStep, hitPos)
                    : (((b + 1) * 73856093) >>> 0);
                ctx.log.vfxTriggers.push({
                    type: 'gun_hit',
                    step: arrivalStep,
                    pos: hitPos.clone(),
                    normal: hitNorm.clone(),
                    surface: hitKind,
                    seed
                });
            }
        }
    }

    ctx.log[id].gunStops = stops;
}

function resolveGunsForStep(step, ratio, ctx) {
    const B = (typeof AirArenaGunBallistics !== 'undefined') ? AirArenaGunBallistics : null;
    const allIds = combatActiveIds();
    allIds.forEach(id => {
        let t = teams[id];
        if (!t || t.isDestroyed || ctx.death[id] !== -1) return;

        if (t.chain && t.chain.length > 0 && t.chain[0].fire === 'gun') {
            if (step === 0 && B) precomputeGunRoundStops(id, t, ctx);

            const myFac = combatFactionOf(id);
            const enemyTargets = allIds
                .map((eid) => teams[eid])
                .filter((et) => et && !et.isDestroyed && ctx.death[et.id] === -1 && combatFactionOf(et.id) !== myFac && et.pathPoints && et.pathPoints.length);
            if (!enemyTargets.length) return;

            const throttle = (t.chain[0].throttle != null) ? t.chain[0].throttle : (t.throttle || 2);
            const params = B ? B.resolveGunParams(t.type || 'mig21', throttle) : null;
            let stats = (typeof getThrottleStats === 'function')
                ? getThrottleStats(throttle, t.type || 'mig21')
                : (CONFIG.aircrafts[t.type || 'mig21'].throttleStats[Math.round(throttle)] || { gunAngleMult: 1.0, gunRangeMult: 1.0 });
            let dRange = params ? params.dRange : ((typeof GUN_RANGE !== 'undefined' ? GUN_RANGE : 35) * stats.gunRangeMult);
            let dAngle = params ? params.dAngle : ((typeof GUN_ANGLE !== 'undefined' ? GUN_ANGLE : Math.PI/12) * stats.gunAngleMult);

            let p1 = getPosAt(ratio, t.pathPoints);
            let q1 = getQuatAt(ratio, t.pathQuats); 
            
            let el = params ? params.elevation : (CONFIG.weapons['gun'].elevation || 0);
            let fwd = new THREE.Vector3(0, Math.sin(el), Math.cos(el)).applyQuaternion(q1).normalize();
            let gunMuzzlePos = params
                ? B.computeMuzzleWorldPos(p1, q1, params.centerMuzzle, new THREE.Vector3())
                : p1.clone().add(new THREE.Vector3(0, -0.12, 0.45).applyQuaternion(q1));

            let muzzleSpeed = params ? params.muzzleSpeed : (dRange * 2.0);
            let gravity = params ? params.gravity : (CONFIG.rules.gravity * (CONFIG.weapons['gun'].gravityMult !== undefined ? CONFIG.weapons['gun'].gravityMult : 1.0));
            let acVel = B ? B.sampleAircraftVelocity(ratio, t.pathPoints, new THREE.Vector3()) : new THREE.Vector3();
            let v0 = B
                ? B.computeBulletVelocity(q1, acVel, muzzleSpeed, el, 0, 0, new THREE.Vector3())
                : fwd.clone().multiplyScalar(muzzleSpeed);
            let closingSpeed = Math.max(1.0, v0.dot(fwd));
            const gunCfg = CONFIG.weapons.gun || {};

            // Check every living hostile in 2v2 (sorted nearest along bore so bullets hit closest jet first).
            let hitCandidates = [];
            for (let ei = 0; ei < enemyTargets.length; ei++) {
                const enemy = enemyTargets[ei];
                const p2 = getPosAt(ratio, enemy.pathPoints);
                const vecToEnemy = new THREE.Vector3().subVectors(p2, gunMuzzlePos);
                const forwardDist = vecToEnemy.dot(fwd);
                if (forwardDist > 0 && forwardDist <= dRange) {
                    hitCandidates.push({ enemy, p2, forwardDist });
                }
            }
            if (!hitCandidates.length) return;
            hitCandidates.sort((a, b) => a.forwardDist - b.forwardDist);

            for (let ci = 0; ci < hitCandidates.length; ci++) {
                const { enemy, p2, forwardDist } = hitCandidates[ci];
                let timeSinceSpawn = forwardDist / closingSpeed;
                let expectedBulletPos = B
                    ? B.evalBallisticPoint(gunMuzzlePos, v0, gravity, timeSinceSpawn, new THREE.Vector3())
                    : gunMuzzlePos.clone().add(fwd.clone().multiplyScalar(forwardDist)).add(new THREE.Vector3(0, -0.5 * gravity * timeSinceSpawn * timeSinceSpawn, 0));

                const hitRadius = typeof gunHitRadiusAt === 'function'
                    ? gunHitRadiusAt(forwardDist, dAngle, gunCfg)
                    : Math.min(1.75, Math.max(0.65, forwardDist * Math.tan(dAngle)));

                if (expectedBulletPos.distanceTo(p2) <= hitRadius) {
                    // Building occlusion raycast ONLY when target is actually inside hit envelope (big perf win!)
                    let isGunBlockedByBuilding = false;
                    if (typeof obstacles !== 'undefined' && obstacles.length > 0) {
                        const losDir = new THREE.Vector3().subVectors(p2, gunMuzzlePos);
                        const losDist = losDir.length();
                        if (losDist > 1e-4) {
                            const raycaster = new THREE.Raycaster(gunMuzzlePos, losDir.divideScalar(losDist), 0, losDist);
                            const hits = raycaster.intersectObjects(obstacles, false);
                            if (hits.length > 0 && hits[0].distance < losDist) {
                                isGunBlockedByBuilding = true;
                            }
                        }
                    }

                    if (!isGunBlockedByBuilding) {
                        // Range falloff: ≤hitFalloffStart → 100%; beyond that −hitFalloffPerBand per band.
                        const falloffStart = Number.isFinite(Number(gunCfg.hitFalloffStart)) ? Number(gunCfg.hitFalloffStart) : 45;
                        const falloffBand = Number.isFinite(Number(gunCfg.hitFalloffBand)) ? Number(gunCfg.hitFalloffBand) : 10;
                        const falloffPer = Number.isFinite(Number(gunCfg.hitFalloffPerBand)) ? Number(gunCfg.hitFalloffPerBand) : 0.15;
                        let hitChance = 1;
                        if (forwardDist > falloffStart && falloffBand > 0) {
                            hitChance = Math.max(0, 1 - falloffPer * ((forwardDist - falloffStart) / falloffBand));
                        }
                        if (hitChance < 1 && Math.random() > hitChance) {
                            continue;
                        }
                        const gunStepDmg = GUN_DAMAGE / 100;
                        ctx.hp[enemy.id] -= gunStepDmg;
                        ctx.log[enemy.id].damageTaken += gunStepDmg;
                        if (!Array.isArray(ctx.log[enemy.id].damageSteps)) ctx.log[enemy.id].damageSteps = [];
                        ctx.log[enemy.id].damageSteps.push(step);
                        recordCombatHit(ctx, enemy.id, id, 'gun', step);
                        if (!ctx.log.weaponDamageDealt) ctx.log.weaponDamageDealt = {};
                        if (!ctx.log.weaponDamageDealt[id]) ctx.log.weaponDamageDealt[id] = {};
                        ctx.log.weaponDamageDealt[id].gun = (ctx.log.weaponDamageDealt[id].gun || 0) + gunStepDmg;
                        ctx.log.weaponDamageDealt[id].gunSteps = (ctx.log.weaponDamageDealt[id].gunSteps || 0) + 1;

                        // Clamp nearest tracer round stop time so bullets terminate on the enemy fuselage
                        if (B && ctx.log[id] && Array.isArray(ctx.log[id].gunStops)) {
                            const rounds = ctx.log[id].gunStops.length;
                            const rIdx = Math.min(rounds - 1, Math.max(0, Math.round((ratio / 0.96) * (rounds - 1))));
                            if (timeSinceSpawn < ctx.log[id].gunStops[rIdx]) {
                                ctx.log[id].gunStops[rIdx] = Number(timeSinceSpawn.toFixed(4));
                            }
                        }

                        // Compact GPU-batched aircraft skin hit effect (metallic sparks + flash + slipstream smoke)
                        if (step % 3 === 0) {
                            const q2 = getQuatAt(ratio, enemy.pathQuats);
                            const noseDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q2).normalize();
                            const tailDir = noseDir.clone().multiplyScalar(-1);
                            const towardShooter = new THREE.Vector3().subVectors(p1, p2);
                            if (towardShooter.lengthSq() < 1e-6) towardShooter.copy(fwd).multiplyScalar(-1);
                            else towardShooter.normalize();
                            const skinOffset = 0.18;
                            const hitPos = p2.clone()
                                .add(towardShooter.clone().multiplyScalar(skinOffset))
                                .add(new THREE.Vector3(
                                    (Math.random() - 0.5) * 0.12,
                                    (Math.random() - 0.5) * 0.08,
                                    (Math.random() - 0.5) * 0.16
                                ).applyQuaternion(q2));
                            const wakeWind = tailDir.clone().multiplyScalar(0.036).add(new THREE.Vector3(0, -0.004, 0));
                            const seed = (typeof sparkSeedFrom === 'function')
                                ? sparkSeedFrom(step, hitPos)
                                : (((step + 1) * 2654435761) >>> 0);
                            ctx.log.vfxTriggers.push({
                                type: 'gun_hit',
                                step: step,
                                pos: hitPos,
                                normal: towardShooter,
                                wind: wakeWind,
                                surface: 'aircraft',
                                seed
                            });
                        }
                        break; // Round struck the nearest hostile along the stream.
                    }
                }
            }
        }
    });
}

function resolveMissilesForStep(step, ratio, ctx) {
    let cFlares = ctx.flares[step] || [];
    combatActiveIds().forEach(id => {
        let t = teams[id];
        if (t.isDestroyed || !t.activeMissiles) return;
        const preferredEnemy = combatEnemyOf(id);
        
        t.activeMissiles.forEach(activeM => {
            if (activeM.exploded || activeM.ap <= 0) return; 
            
            if (!activeM.active) {
                if (step < activeM.launchStep) { ctx.log[`${id}MslTracks`][activeM.pylonId].push(null); return; }
                if (step === activeM.launchStep) {
                    activeM.active = true; 
                    let acPos = getPosAt(ratio, t.pathPoints); let acQuat = getQuatAt(ratio, t.pathQuats);
                    let pylonConfig = t.pylons.find(p => p.id === activeM.pylonId);
                    activeM.pos.copy(acPos).add(pylonConfig.localPosition.clone().add(new THREE.Vector3(0, -0.05, 0.2)).applyQuaternion(acQuat));
                    activeM.quat.copy(acQuat);
                    activeM.launchPos = activeM.pos.clone();
                    activeM.traveled = 0;
                    activeM.guided = false;
                    const tgtId = activeM.supportTargetId
                        || (preferredEnemy && preferredEnemy.id)
                        || null;
                    const tgtTeam = (tgtId && typeof teams !== 'undefined' && teams[tgtId])
                        ? teams[tgtId]
                        : preferredEnemy;
                    let tgtPos = null;
                    if (tgtTeam && tgtTeam.pathPoints && tgtTeam.pathPoints.length) {
                        tgtPos = getPosAt(ratio, tgtTeam.pathPoints);
                    } else if (tgtTeam && tgtTeam.wrapper && tgtTeam.wrapper.position) {
                        tgtPos = tgtTeam.wrapper.position;
                    }
                    const tgtFwd = tgtTeam && tgtTeam.wrapper
                        ? (tgtTeam.wrapper.quaternion || tgtTeam.wrapper.forward)
                        : null;
                    const geom = (typeof computeMissileLaunchGeometry === 'function')
                        ? computeMissileLaunchGeometry(activeM.pos, activeM.quat, tgtPos, tgtFwd)
                        : { dist: null, angDeg: null, frontAspect: false };
                    if (typeof openMissileShot === 'function') {
                        openMissileShot(t, activeM, geom, combatCurrentTurn(), tgtId);
                    }
                    ctx.log[`${id}MslTracks`][activeM.pylonId].push({ pos: activeM.pos.clone(), quat: activeM.quat.clone() });
                    return; 
                }
            }

            let oldPos = activeM.pos.clone();
            const heatSources = buildMissileHeatSources(id, ratio, cFlares);
            let fallbackPos = null;
            let fallbackQuat = null;
            if (preferredEnemy && preferredEnemy.pathPoints && preferredEnemy.pathPoints.length) {
                fallbackPos = getPosAt(ratio, preferredEnemy.pathPoints);
                fallbackQuat = getQuatAt(ratio, preferredEnemy.pathQuats);
            }
            let stepRes = simulateMissileStep(
                activeM.pos,
                activeM.quat,
                fallbackPos,
                fallbackQuat,
                activeM.ap,
                t,
                preferredEnemy,
                cFlares,
                activeM,
                {
                    shooterId: id,
                    ratio,
                    heatSources,
                    step,
                    turn: (typeof GameContext !== 'undefined' && GameContext.state)
                        ? GameContext.state.currentTurn
                        : undefined,
                    chaffList: (ctx.chaff && ctx.chaff[step]) ? ctx.chaff[step] : [],
                    illuminatorPos: getPosAt(ratio, t.pathPoints),
                    illuminatorQuat: getQuatAt(ratio, t.pathQuats)
                }
            );

            let isMissileCrashedIntoBuilding = false;
            if (typeof obstacles !== 'undefined' && obstacles.length > 0 && stepRes.pos) {
                let moveVec = new THREE.Vector3().subVectors(stepRes.pos, oldPos);
                let dist = moveVec.length();
                if (dist > 0.0001) {
                    let raycaster = new THREE.Raycaster(oldPos, moveVec.normalize());
                    let hits = raycaster.intersectObjects(obstacles, false);
                    if (hits.length > 0 && hits[0].distance <= dist) {
                        isMissileCrashedIntoBuilding = true;
                        stepRes.pos.copy(hits[0].point); 
                    }
                }
            }    

            if (stepRes.pos) activeM.pos.copy(stepRes.pos); 
            if (stepRes.quat) activeM.quat.copy(stepRes.quat); 
            if (stepRes.ap !== undefined) activeM.ap = stepRes.ap;
            if (stepRes.trackId) activeM.trackId = stepRes.trackId;
            if (stepRes.trackKind) activeM.trackKind = stepRes.trackKind;
            if (typeof stepRes.traveled === 'number') activeM.traveled = stepRes.traveled;
            if (typeof stepRes.guided === 'boolean') activeM.guided = stepRes.guided;
            if (stepRes.lostTarget) activeM.lostTarget = true;

            if (isMissileCrashedIntoBuilding) {
                stepRes.exploded = true;
                activeM.ap = 0; 
                if (CONFIG.debug) console.log(`🚀💥 [武器事故] 飛彈在攔截途中撞擊城市建築物，發生劇烈殉爆！`);
            }

            ctx.log[`${id}MslTracks`][activeM.pylonId].push({ pos: activeM.pos.clone(), quat: activeM.quat.clone() });

            if (stepRes.exploded) { 
                activeM.exploded = true; ctx.log[`${id}ExplodedAt`][activeM.pylonId] = step;
                ctx.log[`${id}MslIsSelfDestruct`] = ctx.log[`${id}MslIsSelfDestruct`] || {}; 
                ctx.log[`${id}MslIsSelfDestruct`][activeM.pylonId] = stepRes.lostTarget || stepRes.selfDestructed; 
                
                let mFwd = new THREE.Vector3(0,0,1).applyQuaternion(activeM.quat);
                ctx.log.vfxTriggers.push(sparkBurstTrigger(step, activeM.pos, 80, 0.8, {
                    wind: mFwd.clone().multiplyScalar(-0.005)
                }));
                ctx.log.vfxTriggers.push({ type: 'explosion', step: step, pos: activeM.pos.clone(), rot: Math.random() * Math.PI * 2, scale: 1.2 });
                ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: activeM.pos.clone(), rot: Math.random() * Math.PI * 2, scale: 1.5 });

                const mType = activeM.missileType === 'fox1' ? 'fox1' : 'fox2';
                const mCfg = (CONFIG.weapons && CONFIG.weapons[mType]) ? CONFIG.weapons[mType] : (CONFIG.weapons['fox2'] || {});
                const fuseRange = mCfg.fuseRange ? mCfg.fuseRange : 3.5;
                const frontFuseMult = (mType === 'fox2' && stepRes.frontAspect) ? (mCfg.frontAspectFuseRangeMult || 0.45) : 1;
                const frontDamageMult = (mType === 'fox2' && stepRes.frontAspect) ? (mCfg.frontAspectDamageMult || 0.45) : 1;
                const effectiveFuseRange = (fuseRange * frontFuseMult) + ((mType === 'fox2' && stepRes.frontAspect) ? 0.25 : 1.1);

                // 傷害對象 = 實際追蹤載機；追熱焰時改打近炸範圍內最近載機（可含友軍）
                let victimId = stepRes.hitTargetId || null;
                if (!victimId && stepRes.trackKind === 'aircraft' && stepRes.trackId) {
                    const victimSrc = heatSources.find((s) => s.kind === 'aircraft' && s.id === stepRes.trackId);
                    if (victimSrc && activeM.pos.distanceTo(victimSrc.pos) <= effectiveFuseRange) {
                        victimId = stepRes.trackId;
                    }
                }
                if (!victimId && !isMissileCrashedIntoBuilding && mType === 'fox2') {
                    let bestD = effectiveFuseRange;
                    heatSources.forEach((src) => {
                        if (!src || src.kind !== 'aircraft' || !src.pos) return;
                        const d = activeM.pos.distanceTo(src.pos);
                        if (d <= bestD) {
                            bestD = d;
                            victimId = src.id;
                        }
                    });
                }

                if (!isMissileCrashedIntoBuilding && victimId && ctx.hp[victimId] !== undefined) {
                    const baseDmg = Number(mCfg.damage);
                    const damage = (Number.isFinite(baseDmg) ? baseDmg : MISSILE_DAMAGE) * frontDamageMult;
                    ctx.hp[victimId] -= damage;
                    if (ctx.log[victimId]) {
                        ctx.log[victimId].damageTaken += damage;
                        if (!Array.isArray(ctx.log[victimId].damageSteps)) ctx.log[victimId].damageSteps = [];
                        ctx.log[victimId].damageSteps.push(step);
                    }
                    recordCombatHit(ctx, victimId, id, mType, step);
                    if (!ctx.log.weaponDamageDealt) ctx.log.weaponDamageDealt = {};
                    if (!ctx.log.weaponDamageDealt[id]) ctx.log.weaponDamageDealt[id] = {};
                    ctx.log.weaponDamageDealt[id][mType] = (ctx.log.weaponDamageDealt[id][mType] || 0) + damage;
                    finishLiveMissileShot(t, activeM, 'hit');
                } else if (isMissileCrashedIntoBuilding) {
                    finishLiveMissileShot(t, activeM, 'building');
                } else if (stepRes.lostTarget || stepRes.selfDestructed || activeM.lostTarget) {
                    finishLiveMissileShot(t, activeM, 'coast');
                } else {
                    finishLiveMissileShot(t, activeM, 'exhausted');
                }
            } else if (activeM.ap <= 0) {
                if (activeM.lostTarget || stepRes.lostTarget) finishLiveMissileShot(t, activeM, 'coast');
                else finishLiveMissileShot(t, activeM, 'exhausted');
            }
        });
    });
}

function resolveDamageAndDeathForStep(step, ratio, ctx) {
    const ids = combatActiveIds();

    // Mid-air: any opposing pair within fuse distance.
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i];
            const b = ids[j];
            if (combatFactionOf(a) === combatFactionOf(b)) continue;
            if (teams[a].isDestroyed || teams[b].isDestroyed) continue;
            if (ctx.death[a] !== -1 || ctx.death[b] !== -1) continue;
            const pA = getPosAt(ratio, teams[a].pathPoints);
            const pB = getPosAt(ratio, teams[b].pathPoints);
            if (pA.distanceTo(pB) < 1.8) {
                [a, b].forEach((id) => {
                    ctx.hp[id] = 0;
                    ctx.death[id] = step;
                    ctx.log[id].damageTaken = 100;
                    if (!Array.isArray(ctx.log[id].damageSteps)) ctx.log[id].damageSteps = [];
                    ctx.log[id].damageSteps.push(step);
                    if (!ctx.log.softWreck) ctx.log.softWreck = {};
                    ctx.log.softWreck[id] = false;
                    if (!ctx.log.deathCause) ctx.log.deathCause = {};
                    ctx.log.deathCause[id] = 'midair';
                });
                ctx.log.vfxTriggers.push({
                    type: 'explosion',
                    step,
                    pos: pA.clone().add(pB).multiplyScalar(0.5),
                    scale: 2.8,
                    rot: Math.random() * Math.PI
                });
            }
        }
    }

    ids.forEach(id => {
        let t = teams[id];
        const isFallingWreck = t.isDestroyed && t.wreckPhase === 'falling';
        if (t.isDestroyed && !isFallingWreck) return;

        let steps = CONFIG.rules.stepsPerTurn;
        let prevRatio = Math.max(0, ratio - (1/steps));
        let pPrev = getPosAt(prevRatio, t.pathPoints);
        let currentPos = getPosAt(ratio, t.pathPoints);
        let currentQuat = getQuatAt(ratio, t.pathQuats);
        
        let hasCollided = false; let collisionType = "";
        let minH = CONFIG.rules.minFlightHeight || 0.5;

        let moveVec = new THREE.Vector3().subVectors(currentPos, pPrev);
        let dist = moveVec.length();

        if (!isFallingWreck && ctx.death[id] === -1 && typeof obstacles !== 'undefined' && obstacles.length > 0 && dist > 0.0001) {
            let raycaster = new THREE.Raycaster(pPrev, moveVec.normalize());
            let hits = raycaster.intersectObjects(obstacles, false);
            if (hits.length > 0 && hits[0].distance <= dist) {
                hasCollided = true; collisionType = "building";
                currentPos.copy(hits[0].point);
            }
        }

        if (!isFallingWreck && ctx.death[id] === -1 && !hasCollided && currentPos.y <= minH + 0.15) {
            hasCollided = true; collisionType = "ground";
        }

        // Left combat airspace (horizontal cylinder around battlefield center).
        // Default: HP penalty (once/turn) + forced inward elsewhere — not instant kill.
        if (
            !isFallingWreck &&
            ctx.death[id] === -1 &&
            !hasCollided &&
            typeof isOutsideCombatAirspace === 'function' &&
            isOutsideCombatAirspace(currentPos)
        ) {
            const air = (typeof getCombatAirspace === 'function') ? getCombatAirspace() : null;
            const outsideKill = !!(air && air.outsideKill === true);
            if (outsideKill) {
                hasCollided = true;
                collisionType = 'airspace';
            } else {
                if (!ctx.log.airspaceOutsideHit) ctx.log.airspaceOutsideHit = {};
                if (!ctx.log.airspaceOutsideHit[id]) {
                    ctx.log.airspaceOutsideHit[id] = true;
                    const pen = air && Number.isFinite(Number(air.outsideHpPenalty))
                        ? Number(air.outsideHpPenalty)
                        : 14;
                    const dmg = Math.max(1, pen);
                    if (typeof ctx.hp[id] === 'number') {
                        ctx.hp[id] = Math.max(0, ctx.hp[id] - dmg);
                    }
                    if (ctx.log[id]) {
                        ctx.log[id].damageTaken += dmg;
                        if (!Array.isArray(ctx.log[id].damageSteps)) ctx.log[id].damageSteps = [];
                        ctx.log[id].damageSteps.push(step);
                    }
                    if (!ctx.log.airspacePenalty) ctx.log.airspacePenalty = {};
                    ctx.log.airspacePenalty[id] = dmg;
                    // Bleed-out while camping outside still counts as airspace loss.
                    if (typeof ctx.hp[id] === 'number' && ctx.hp[id] <= 0) {
                        hasCollided = true;
                        collisionType = 'airspace';
                    }
                }
            }
        }

        if (isFallingWreck && currentPos.y <= minH + 0.15) {
            if (!ctx.log.wreckGroundBurst) ctx.log.wreckGroundBurst = {};
            ctx.log.wreckGroundBurst[id] = true;
            if (step % 8 === 0) {
                ctx.log.vfxTriggers.push({ type: 'puff', step: step, pos: currentPos.clone(), rot: Math.random()*Math.PI*2, scale: 1.2, opacity: 0.5, drift: new THREE.Vector3(0, 0.01, 0) });
            }
            if (ctx.log.hpTrack[id]) ctx.log.hpTrack[id][step] = 0;
            return;
        }

        if (hasCollided && ctx.death[id] === -1) {
            ctx.hp[id] = 0; ctx.death[id] = step; ctx.log[id].damageTaken = 100;
            if (!Array.isArray(ctx.log[id].damageSteps)) ctx.log[id].damageSteps = [];
            ctx.log[id].damageSteps.push(step);
            if (!ctx.log.softWreck) ctx.log.softWreck = {};
            ctx.log.softWreck[id] = false;
            if (!ctx.log.deathCause) ctx.log.deathCause = {};
            ctx.log.deathCause[id] = collisionType === 'ground'
                ? 'ground'
                : (collisionType === 'airspace' ? 'airspace' : 'building');
            if (!ctx.log.deathFlags) ctx.log.deathFlags = {};
            const stallAp = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stallSpeedAP) ? CONFIG.rules.stallSpeedAP : 35;
            const pathAp = (t.chain && t.chain[0] && typeof t.chain[0].resultingAP === 'number') ? t.chain[0].resultingAP : null;
            const stalledAtImpact = !!t.stalled || (Number.isFinite(pathAp) && pathAp < stallAp);
            ctx.log.deathFlags[id] = {
                stalled: stalledAtImpact,
                ap: Number.isFinite(pathAp) ? pathAp : (typeof t.ap === 'number' ? t.ap : null)
            };
            if (collisionType === 'airspace') {
                ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: currentPos.clone(), rot: Math.random()*Math.PI*2, scale: 1.2 });
                if (CONFIG.debug) console.log(`🚫 [空域] ${id.toUpperCase()} 離開作戰空域，判定擊落！`);
            } else {
                const crashSurf = collisionType === 'ground' ? 'ground' : 'building';
                const crashSeed = (typeof sparkSeedFrom === 'function')
                    ? sparkSeedFrom(step, currentPos)
                    : ((Math.random() * 0xffffffff) >>> 0);
                ctx.log.vfxTriggers.push({
                    type: 'ground_explosion',
                    step: step,
                    pos: currentPos.clone(),
                    radius: 9.0,
                    scale: 1.25,
                    seed: crashSeed,
                    surface: crashSurf
                });
                ctx.log.vfxTriggers.push(sparkBurstTrigger(step, currentPos, 60, 0.7, {
                    fountain: crashSurf === 'ground',
                    wind: new THREE.Vector3(0, crashSurf === 'ground' ? 0.35 : 0, 0)
                }));
                ctx.log.vfxTriggers.push({
                    type: 'debris',
                    step,
                    pos: currentPos.clone(),
                    color: t.colorMain || '#555555'
                });
                if (CONFIG.debug) console.log(`💥 [撞擊事故] ${id.toUpperCase()} 戰機規避失敗，直接撞毀於 ${collisionType === 'building' ? '城市建築' : '地面'}！`);
            }
        }

        // Combat kill (gun/missile): mark death this step and soft-wreck fall for remaining path.
        if (!isFallingWreck && ctx.death[id] === -1 && ctx.hp[id] <= 0) {
            ctx.death[id] = step;
            if (!ctx.log.softWreck) ctx.log.softWreck = {};
            if (ctx.log.softWreck[id] !== false) ctx.log.softWreck[id] = true;
            if (!ctx.log.deathCause) ctx.log.deathCause = {};
            if (!ctx.log.deathCause[id]) ctx.log.deathCause[id] = 'combat';
            if (ctx.log.deathCause[id] === 'combat' && ctx.log.damageFrom && ctx.log.damageFrom[id]) {
                if (!ctx.log.killedBy) ctx.log.killedBy = {};
                if (!ctx.log.killedBy[id]) ctx.log.killedBy[id] = ctx.log.damageFrom[id];
            }
        }

        if (ctx.death[id] === step || (ctx.death[id] !== -1 && step === ctx.death[id])) {
            let deathRatio = step / CONFIG.rules.stepsPerTurn;
            let simPos = getPosAt(deathRatio, t.pathPoints); let simQuat = getQuatAt(deathRatio, t.pathQuats);
            const soft = !!(ctx.log.softWreck && ctx.log.softWreck[id]);
            const tumbleZ = soft ? 0.05 : 0.16;
            const tumbleX = soft ? -0.03 : -0.07;
            const glide = soft ? 0.16 : 0.28;
            const sink = soft ? 0.18 : 0.42;

            for (let i = Math.max(0, Math.floor(deathRatio * (t.pathPoints.length - 1))) + 1; i < t.pathPoints.length; i++) {
                simQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), tumbleZ)); 
                simQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), tumbleX)); 
                let fwd = new THREE.Vector3(0,0,1).applyQuaternion(simQuat);
                simPos.add(fwd.multiplyScalar(glide)); simPos.y -= sink; 
                if (simPos.y < minH) {
                    simPos.y = minH;
                    if (soft) {
                        if (!ctx.log.wreckGroundBurst) ctx.log.wreckGroundBurst = {};
                        ctx.log.wreckGroundBurst[id] = true;
                    }
                }
                
                t.pathPoints[i] = simPos.clone(); t.pathQuats[i] = simQuat.clone();
                ctx.log[id].pts[i] = simPos.clone(); ctx.log[id].quats[i] = simQuat.clone();
            }
        }
        
        if (ctx.log.hpTrack[id]) ctx.log.hpTrack[id][step] = Math.max(0, ctx.hp[id]);

        if (isFallingWreck || (ctx.death[id] !== -1 && step >= ctx.death[id])) {
            let deadPos = getPosAt(ratio, t.pathPoints); let deadQuat = getQuatAt(ratio, t.pathQuats);
            let fwd = new THREE.Vector3(0,0,1).applyQuaternion(deadQuat);
            const soft = isFallingWreck || !!(ctx.log.softWreck && ctx.log.softWreck[id]);
            if (soft) {
                if (step % 4 === 0 && deadPos.y > minH + 0.1) {
                    ctx.log.vfxTriggers.push({ type: 'puff', step: step, pos: deadPos.clone(), rot: Math.random()*Math.PI*2, scale: 1.1, opacity: 0.4, drift: fwd.clone().multiplyScalar(-0.02) });
                }
            } else if (step % 2 === 0 && deadPos.y > minH + 0.1) {
                ctx.log.vfxTriggers.push(sparkBurstTrigger(step, deadPos, 8, 0.4, {
                    wind: fwd.clone().multiplyScalar(-0.006)
                }));
                ctx.log.vfxTriggers.push({ type: 'puff', step: step, pos: deadPos.clone(), rot: Math.random()*Math.PI*2, scale: 1.5, opacity: 0.45, drift: fwd.clone().multiplyScalar(-0.025) });
                ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: deadPos.clone().add(new THREE.Vector3((Math.random()-0.5), (Math.random()-0.5), (Math.random()-0.5))), rot: Math.random()*Math.PI*2, scale: 0.8 });
            }
        } else if (ctx.hp[id] > 0) {
            let acPos = getPosAt(ratio, t.pathPoints); let acQuat = getQuatAt(ratio, t.pathQuats);
            if (ctx.hp[id] <= 30) {
                if (step % 3 === 0) ctx.log.vfxTriggers.push({ type: 'puff', step: step, pos: acPos.clone(), rot: Math.random()*Math.PI*2, scale: 1.0, opacity: 0.4, drift: new THREE.Vector3(0,0,1).applyQuaternion(acQuat).multiplyScalar(-0.02) });
                if (step % 15 === 0) ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: acPos.clone(), rot: Math.random()*Math.PI*2, scale: 0.6 });
            } else if (ctx.hp[id] <= 80) {
                if (step % 10 === 0) ctx.log.vfxTriggers.push({ type: 'puff', step: step, pos: acPos.clone(), rot: Math.random()*Math.PI*2, scale: 0.5, opacity: 0.24, drift: new THREE.Vector3(0,0,1).applyQuaternion(acQuat).multiplyScalar(-0.02) });
            }
        }
    });
}
