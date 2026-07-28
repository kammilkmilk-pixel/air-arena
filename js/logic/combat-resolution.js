// ============================================================================
// combat-resolution.js - per-step guns, missiles, damage & death
// ============================================================================
function resolveGunsForStep(step, ratio, ctx) {
    combatActiveIds().forEach(id => {
        let t = teams[id]; let enemy = combatEnemyOf(id);
        if (!enemy || t.isDestroyed || enemy.isDestroyed || ctx.death[id] !== -1) return;

        if (t.chain && t.chain.length > 0 && t.chain[0].fire === 'gun') {
            let stats = CONFIG.aircrafts[t.type || 'mig21'].throttleStats[t.throttle || 2] || { gunAngleMult: 1.0, gunRangeMult: 1.0 };
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
                    ctx.log.vfxTriggers.push({
                        type: 'spark_explosion',
                        step: step,
                        pos: blockPoint,
                        velocities: genSparks(6, 0.28),
                        wind: fwd.clone().multiplyScalar(-0.028),
                        life: 14,
                        streak: 0.55,
                        gravity: 0.008,
                        windForce: 0.2
                    });
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
                
                if (expectedBulletPos.distanceTo(p2) <= forwardDist * Math.tan(dAngle)) {
                    // 安全判定：只有敵機在障礙物前面才會扣血
                    if (!isGunBlockedByBuilding || forwardDist < distToBlock) {
                        ctx.hp[enemy.id] -= (GUN_DAMAGE / 100);
                        ctx.log[enemy.id].damageTaken += (GUN_DAMAGE / 100);
                        
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
                            ctx.log.vfxTriggers.push({
                                type: 'spark_explosion',
                                step: step,
                                pos: hitPos,
                                velocities: genSparksFountain(10, 0.34),
                                wind: wakeWind,
                                life: 16,
                                streak: 0.55,
                                gravity: 0.007,
                                windForce: 0.26,
                                fountain: true
                            });
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
        let t = teams[id]; let enemy = combatEnemyOf(id);
        if (t.isDestroyed || !t.activeMissiles || !enemy) return;
        
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
                    ctx.log[`${id}MslTracks`][activeM.pylonId].push({ pos: activeM.pos.clone(), quat: activeM.quat.clone() });
                    return; 
                }
            }

            let oldPos = activeM.pos.clone();
            let targetPos = getPosAt(ratio, enemy.pathPoints); let targetQuat = getQuatAt(ratio, enemy.pathQuats);
            let stepRes = simulateMissileStep(activeM.pos, activeM.quat, targetPos, targetQuat, activeM.ap, t, enemy, cFlares, activeM);

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
                ctx.log.vfxTriggers.push({ type: 'spark_explosion', step: step, pos: activeM.pos.clone(), velocities: genSparks(80, 0.8), wind: mFwd.clone().multiplyScalar(-0.005) });
                ctx.log.vfxTriggers.push({ type: 'explosion', step: step, pos: activeM.pos.clone(), rot: Math.random() * Math.PI * 2, scale: 1.2 });
                ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: activeM.pos.clone(), rot: Math.random() * Math.PI * 2, scale: 1.5 });

                const fox2 = CONFIG.weapons['fox2'] || {};
                const fuseRange = fox2.fuseRange ? fox2.fuseRange : 3.5;
                const frontFuseMult = stepRes.frontAspect ? (fox2.frontAspectFuseRangeMult || 0.45) : 1;
                const frontDamageMult = stepRes.frontAspect ? (fox2.frontAspectDamageMult || 0.45) : 1;
                const effectiveFuseRange = (fuseRange * frontFuseMult) + (stepRes.frontAspect ? 0.25 : 1.1);
                if (!isMissileCrashedIntoBuilding && activeM.pos.distanceTo(targetPos) <= effectiveFuseRange) { 
                    const damage = MISSILE_DAMAGE * frontDamageMult;
                    ctx.hp[enemy.id] -= damage; ctx.log[enemy.id].damageTaken += damage;
                }
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
                    if (!ctx.log.softWreck) ctx.log.softWreck = {};
                    ctx.log.softWreck[id] = false;
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
            if (!ctx.log.softWreck) ctx.log.softWreck = {};
            ctx.log.softWreck[id] = false;
            ctx.log.vfxTriggers.push({ type: 'explosion', step: step, pos: currentPos.clone(), scale: 2.3, rot: Math.random()*Math.PI*2 });
            ctx.log.vfxTriggers.push({ type: 'spark_explosion', step: step, pos: currentPos.clone(), velocities: genSparks(60, 0.7), wind: new THREE.Vector3(0,0,0) });
            ctx.log.vfxTriggers.push({ type: 'flash', step: step, pos: currentPos.clone(), rot: Math.random()*Math.PI*2, scale: 1.5 });
            if (CONFIG.debug) console.log(`💥 [撞擊事故] ${id.toUpperCase()} 戰機規避失敗，直接撞毀於 ${collisionType === 'building' ? '城市建築' : '地面'}！`);
        }

        // Combat kill (gun/missile): mark death this step and soft-wreck fall for remaining path.
        if (!isFallingWreck && ctx.death[id] === -1 && ctx.hp[id] <= 0) {
            ctx.death[id] = step;
            if (!ctx.log.softWreck) ctx.log.softWreck = {};
            if (ctx.log.softWreck[id] !== false) ctx.log.softWreck[id] = true;
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
                ctx.log.vfxTriggers.push({ type: 'spark_explosion', step: step, pos: deadPos.clone(), velocities: genSparks(8, 0.4), wind: fwd.clone().multiplyScalar(-0.006) });
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
