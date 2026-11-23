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

function resolveGunsForStep(step, ratio, ctx) {
    combatActiveIds().forEach(id => {
        let t = teams[id]; let enemy = combatEnemyOf(id);
        if (!enemy || t.isDestroyed || enemy.isDestroyed || ctx.death[id] !== -1) return;

        if (t.chain && t.chain.length > 0 && t.chain[0].fire === 'gun') {
            let stats = (typeof getThrottleStats === 'function')
                ? getThrottleStats(t.throttle || 2, t.type || 'mig21')
                : (CONFIG.aircrafts[t.type || 'mig21'].throttleStats[Math.round(t.throttle || 2)] || { gunAngleMult: 1.0, gunRangeMult: 1.0 });
            let dRange = (typeof GUN_RANGE !== 'undefined' ? GUN_RANGE : 35) * stats.gunRangeMult;
            let dAngle = (typeof GUN_ANGLE !== 'undefined' ? GUN_ANGLE : Math.PI/12) * stats.gunAngleMult;

            let p1 = getPosAt(ratio, t.pathPoints); let p2 = getPosAt(ratio, enemy.pathPoints);
            let q1 = getQuatAt(ratio, t.pathQuats); 
            
            let el = CONFIG.weapons['gun'].elevation || 0;
            let fwd = new THREE.Vector3(0, Math.sin(el), Math.cos(el)).applyQuaternion(q1).normalize();

            // 生成砲口火光
            if (step % 2 === 0) {
                let gunPorts = CONFIG.aircrafts[t.type || 'mig21'].guns || [{ id: 1, position: [0, -0.05, 1.2] }];
                gunPorts.forEach(gun => {
                    let gunPos = p1.clone().add(new THREE.Vector3(gun.position[0], gun.position[1], gun.position[2]).applyQuaternion(q1));
                    ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: gunPos.clone(), fwd: fwd.clone(), rot: Math.random() * Math.PI * 2 });
                    if (step % 8 === 0) {
                        let puffPos = gunPos.clone().add(new THREE.Vector3((Math.random()-0.5)*0.2, (Math.random()-0.5)*0.2, 0).applyQuaternion(q1));
                        ctx.log.vfxTriggers.push({ type: 'puff', step: step, pos: puffPos, rot: Math.random() * Math.PI * 2, scale: 0.35, opacity: 0.16 });
                    }
                });
            }
            
            // Raycaster 機砲射線掃描城市模型
            let gunMuzzlePos = p1.clone().add(new THREE.Vector3(0, -0.12, 0.45).applyQuaternion(q1));
            let isGunBlockedByBuilding = false;
            let blockPoint = new THREE.Vector3();
            let distToBlock = 99999;

            if (typeof obstacles !== 'undefined' && obstacles.length > 0) {
                let raycaster = new THREE.Raycaster(gunMuzzlePos, fwd);
                let hits = raycaster.intersectObjects(obstacles, false); 
                if (hits.length > 0) {
                    isGunBlockedByBuilding = true;
                    distToBlock = hits[0].distance;
                    blockPoint.copy(hits[0].point);
                }
            }

            // 機砲打中大廈牆面的火花特效
            if (isGunBlockedByBuilding && distToBlock <= dRange) {
                if (step % 4 === 0) {
                    ctx.log.vfxTriggers.push({ type: 'puff', step: step, pos: blockPoint, rot: Math.random()*Math.PI*2, scale: 0.5, opacity: 0.28 });
                    ctx.log.vfxTriggers.push(sparkBurstTrigger(step, blockPoint, 6, 0.28, {
                        wind: fwd.clone().multiplyScalar(-0.028),
                        life: 14,
                        streak: 0.55,
                        gravity: 0.008,
                        windForce: 0.2
                    }));
                }
            }

            // 判斷是否打中敵機
            let vecToEnemy = new THREE.Vector3().subVectors(p2, p1);
            let forwardDist = vecToEnemy.dot(fwd);

            if (forwardDist > 0 && forwardDist <= dRange) {
                let muzzleSpeed = dRange * 2.0; 
                let timeSinceSpawn = forwardDist / muzzleSpeed;
                let expectedBulletPos = p1.clone().add(fwd.clone().multiplyScalar(forwardDist));
                
                let gunGravMult = CONFIG.weapons['gun'].gravityMult !== undefined ? CONFIG.weapons['gun'].gravityMult : 1.0;
                expectedBulletPos.y -= 0.5 * (CONFIG.rules.gravity * gunGravMult) * (timeSinceSpawn * timeSinceSpawn);
                const gunCfg = CONFIG.weapons.gun || {};
                const hitRadius = typeof gunHitRadiusAt === 'function'
                    ? gunHitRadiusAt(forwardDist, dAngle, gunCfg)
                    : Math.min(1.75, Math.max(0.65, forwardDist * Math.tan(dAngle)));

                if (expectedBulletPos.distanceTo(p2) <= hitRadius) {
                    // 安全判定：只有敵機在障礙物前面才會扣血
                    if (!isGunBlockedByBuilding || forwardDist < distToBlock) {
                        // Range falloff: ≤hitFalloffStart → 100%; beyond that −hitFalloffPerBand per band.
                        const falloffStart = Number.isFinite(Number(gunCfg.hitFalloffStart)) ? Number(gunCfg.hitFalloffStart) : 45;
                        const falloffBand = Number.isFinite(Number(gunCfg.hitFalloffBand)) ? Number(gunCfg.hitFalloffBand) : 10;
                        const falloffPer = Number.isFinite(Number(gunCfg.hitFalloffPerBand)) ? Number(gunCfg.hitFalloffPerBand) : 0.15;
                        let hitChance = 1;
                        if (forwardDist > falloffStart && falloffBand > 0) {
                            hitChance = Math.max(0, 1 - falloffPer * ((forwardDist - falloffStart) / falloffBand));
                        }
                        if (hitChance < 1 && Math.random() > hitChance) {
                            return;
                        }
                        ctx.hp[enemy.id] -= (GUN_DAMAGE / 100);
                        ctx.log[enemy.id].damageTaken += (GUN_DAMAGE / 100);
                        if (!Array.isArray(ctx.log[enemy.id].damageSteps)) ctx.log[enemy.id].damageSteps = [];
                        ctx.log[enemy.id].damageSteps.push(step);
                        recordCombatHit(ctx, enemy.id, id, 'gun', step);
                        
                        // 機身命中：噴泉式四周彈開，再被風壓往機尾飄
                        // 機模縮放到最大邊長 ~1.2，爆發點必須貼在機身表面附近。
                        if (step % 2 === 0) {
                            const q2 = getQuatAt(ratio, enemy.pathQuats);
                            const noseDir = new THREE.Vector3(0, 0, 1).applyQuaternion(q2).normalize();
                            const tailDir = noseDir.clone().multiplyScalar(-1);
                            // Impact on the skin facing the shooter (scaled fuselage half-width ≈ 0.15–0.22).
                            const towardShooter = new THREE.Vector3().subVectors(p1, p2);
                            if (towardShooter.lengthSq() < 1e-6) towardShooter.copy(fwd).multiplyScalar(-1);
                            else towardShooter.normalize();
                            const skinOffset = 0.16;
                            const hitPos = p2.clone()
                                .add(towardShooter.multiplyScalar(skinOffset))
                                .add(new THREE.Vector3(
                                    (Math.random() - 0.5) * 0.1,
                                    (Math.random() - 0.5) * 0.06,
                                    (Math.random() - 0.5) * 0.14
                                ).applyQuaternion(q2));
                            const wakeWind = tailDir.clone().multiplyScalar(0.036).add(new THREE.Vector3(0, -0.004, 0));
                            ctx.log.vfxTriggers.push(sparkBurstTrigger(step, hitPos, 10, 0.34, {
                                wind: wakeWind,
                                life: 16,
                                streak: 0.55,
                                gravity: 0.007,
                                windForce: 0.26,
                                fountain: true
                            }));
                            ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: hitPos, rot: Math.random()*Math.PI*2, scale: 0.4 });
                            ctx.log.vfxTriggers.push({
                                type: 'puff',
                                step: step,
                                pos: hitPos,
                                rot: Math.random()*Math.PI*2,
                                scale: 0.32,
                                opacity: 0.28,
                                drift: tailDir.clone().multiplyScalar(0.012)
                            });
                        }
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
