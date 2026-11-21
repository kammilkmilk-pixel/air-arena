// ============================================================================
// combat-turn.js - turn execution, finish settle, wreckFall auto-schedule
// ============================================================================
// ----------------------------------------------------------------------------
// 🎬 總指揮官 (Main Execution & Resolution) - Event Bus 廣播版
// ----------------------------------------------------------------------------

let wreckFallAutoTimer = null;
let turnExecutionLocked = false;

function clearWreckFallAutoTimer() {
    if (wreckFallAutoTimer) {
        clearTimeout(wreckFallAutoTimer);
        wreckFallAutoTimer = null;
    }
}

function scheduleWreckFallTurn(delayMs = 450) {
    clearWreckFallAutoTimer();
    if (typeof window.uiClearAutoAIBattleTimer === 'function') {
        window.uiClearAutoAIBattleTimer();
    }
    wreckFallAutoTimer = setTimeout(() => {
        wreckFallAutoTimer = null;
        if (typeof window.executeTurnSimultaneously === 'function') {
            window.executeTurnSimultaneously();
        }
    }, delayMs);
}

function executeTurnSimultaneously() {
    if (turnExecutionLocked || GameContext.isAnimating() || GameContext.isReplayMode()) return;
    // Guest never resolves — waits for host turn-log replay.
    if (typeof AirArenaNetplay !== 'undefined' && AirArenaNetplay.isGuest && AirArenaNetplay.isGuest()) {
        return;
    }
    turnExecutionLocked = true;
    clearWreckFallAutoTimer();
    if (typeof window.uiClearAutoAIBattleTimer === 'function') {
        window.uiClearAutoAIBattleTimer();
    }

    // Paint "運算中" before sync path/missile resolution blocks the main thread.
    window.dispatchEvent(new CustomEvent('EnginePhaseChanged', { detail: { phase: 'calculating' } }));
    if (typeof window.uiShowComputingOverlay === 'function') {
        window.uiShowComputingOverlay('戰術結算中…');
    }
    if (window.ghostWrapper) window.ghostWrapper.visible = false;

    const runHeavy = () => {
        const hitch = { t0: 0, paths: 0, resolve: 0, total: 0 };
        const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        hitch.t0 = nowMs();
        if (typeof performance !== 'undefined' && performance.mark) {
            performance.mark('aa-turn-start');
        }
        try {
            let steps = CONFIG.rules.stepsPerTurn; let arrayLen = steps + 1;
            const ids = combatActiveIds();

            let ctx = {
                log: { turn: currentTurn, flaresTrack: [], chaffTrack: [], vfxTriggers: [], hpTrack: {} },
                hp: {},
                death: {},
                flares: Array.from({ length: arrayLen }, () => []),
                chaff: Array.from({ length: arrayLen }, () => [])
            };
            ids.forEach((id) => {
                ctx.log[id] = {};
                ctx.log[`${id}MslTracks`] = {};
                ctx.log[`${id}ExplodedAt`] = {};
                ctx.hp[id] = teams[id].hp;
                ctx.death[id] = -1;
                ctx.log.hpTrack[id] = new Array(arrayLen).fill(0);
            });

            processFlightPaths(ctx);
            if (typeof AirArenaBomb !== 'undefined' && typeof AirArenaBomb.processBombDrops === 'function') {
                AirArenaBomb.processBombDrops(ctx);
            } else if (typeof GameContext !== 'undefined' && GameContext.callService) {
                GameContext.callService('processBombDrops', ctx);
            }
            processFlares(ctx);
            if (typeof processChaff === 'function') processChaff(ctx);
            hitch.paths = nowMs() - hitch.t0;
            if (typeof performance !== 'undefined' && performance.mark) performance.mark('aa-turn-paths');

            for (let step = 0; step <= steps; step++) {
                let ratio = step / steps;
                resolveGunsForStep(step, ratio, ctx);
                resolveMissilesForStep(step, ratio, ctx);
                if (typeof AirArenaBomb !== 'undefined' && typeof AirArenaBomb.resolveBombsForStep === 'function') {
                    AirArenaBomb.resolveBombsForStep(step, ratio, ctx);
                } else if (typeof GameContext !== 'undefined' && GameContext.callService) {
                    GameContext.callService('resolveBombsForStep', step, ratio, ctx);
                }
                resolveDamageAndDeathForStep(step, ratio, ctx);
            }
            hitch.resolve = nowMs() - hitch.t0 - hitch.paths;
            if (typeof performance !== 'undefined' && performance.mark) performance.mark('aa-turn-resolve');

            ctx.log.destroyed = {};
            ids.forEach((id) => {
                ctx.log.destroyed[id] = ctx.death[id] !== -1 || ctx.hp[id] <= 0;
            });
            const redGone = ids.filter((id) => combatFactionOf(id) === 'red').every((id) => ctx.log.destroyed[id]);
            const blueGone = ids.filter((id) => combatFactionOf(id) === 'blue').every((id) => ctx.log.destroyed[id]);
            if (redGone || blueGone) {
                ctx.log.winner = "DRAW (雙方同歸於盡)";
                if (redGone && !blueGone) ctx.log.winner = "BLUE TEAM 勝利";
                if (!redGone && blueGone) ctx.log.winner = "RED TEAM 勝利";
            }

            ids.forEach(id => {
                let t = teams[id];
                GameContext.stateMachine.pruneActiveMissiles(id);
                if (ctx.death[id] !== -1) {
                    if (typeof drawTrajectoryLine === 'function') drawTrajectoryLine(t);
                    if (trajectoryMeshes[id]) {
                        const splitHide = !!(window.AirArenaMultiView && window.AirArenaMultiView.isSplit && window.AirArenaMultiView.isSplit());
                        let isCurrentPlayer = (typeof tAct !== 'undefined' && id === tAct) || (id === window.tAct);
                        trajectoryMeshes[id].visible = splitHide ? false : (isCurrentPlayer ? true : !!(t.userData && t.userData.showEnvelope));
                    }
                }
            });

            hitch.total = nowMs() - hitch.t0;
            ctx.log.hitch = {
                pathsMs: Math.round(hitch.paths),
                resolveMs: Math.round(hitch.resolve),
                totalMs: Math.round(hitch.total)
            };
            if (typeof AirArenaRadioCues !== 'undefined' && AirArenaRadioCues.buildFromTurn) {
                ctx.log.radioCues = AirArenaRadioCues.buildFromTurn(ctx.log, {
                    teams,
                    activeIds: ids
                });
            }
            if (typeof window !== 'undefined') {
                window.AirArenaHitchLast = Object.assign({}, window.AirArenaHitchLast || {}, ctx.log.hitch);
            }
            if (typeof performance !== 'undefined' && performance.measure) {
                try {
                    performance.measure('aa-turn-paths', 'aa-turn-start', 'aa-turn-paths');
                    performance.measure('aa-turn-resolve', 'aa-turn-paths', 'aa-turn-resolve');
                } catch (e) { /* marks missing */ }
            }

            GameContext.stateMachine.commitTurn(ctx.log);
            if (typeof AirArenaHostAuthority !== 'undefined' && AirArenaHostAuthority.broadcastTurn) {
                AirArenaHostAuthority.broadcastTurn(ctx.log);
            }
            window.dispatchEvent(new CustomEvent('EnginePhaseChanged', { detail: { phase: 'playing', maxLog: battleLog.length } }));
            if (batchFast && typeof finishTurnSimultaneously === 'function') {
                finishTurnSimultaneously();
            } else if (GameContext.services.startCombatAnimation) {
                GameContext.callService('startCombatAnimation');
            } else {
                GameContext.setAnimating(true);
                GameContext.state.animProgress = 0;
            }
        } catch (error) {
            console.error('回合運算發生錯誤：', error);
            if (typeof window.uiHideComputingOverlay === 'function') {
                window.uiHideComputingOverlay();
            }
        } finally {
            // Unlock once animation owns the turn; finishTurn may start another turn later.
            turnExecutionLocked = false;
        }
    };

    const batchFast = !!(window.AirArenaBatchRun && typeof AirArenaBatchRun.isActive === 'function'
        && AirArenaBatchRun.isActive()
        && AirArenaBatchRun.readQuery
        && AirArenaBatchRun.readQuery().batchFast);
    if (batchFast) {
        runHeavy();
        return;
    }

    let started = false;
    const kick = () => {
        if (started) return;
        started = true;
        setTimeout(runHeavy, 0);
    };
    setTimeout(kick, 80);
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
            requestAnimationFrame(kick);
        });
    } else {
        kick();
    }
}
window.executeTurnSimultaneously = executeTurnSimultaneously;

function finishTurnSimultaneously() {
    GameContext.state.animProgress = 0;
    GameContext.setAnimating(false);
    let lastLog = battleLog[battleLog.length - 1];
    try {
        lastLog = battleLog[battleLog.length-1];

        combatActiveIds().forEach(id => {
            let t = teams[id];
            if (!t) return;
            const destroyedByLog = !!(lastLog && lastLog.destroyed && lastLog.destroyed[id]);
            const logCause = lastLog && lastLog.deathCause ? lastLog.deathCause[id] : null;
            const flags = lastLog && lastLog.deathFlags ? lastLog.deathFlags[id] : null;
            const softFlag = lastLog && lastLog.softWreck ? lastLog.softWreck[id] : null;
            const inferredCause = logCause
                || (softFlag === false && destroyedByLog ? 'impact' : null)
                || 'combat';
            const hitInfo = lastLog && lastLog.damageFrom ? lastLog.damageFrom[id] : null;
            const killInfo = lastLog && lastLog.killedBy ? lastLog.killedBy[id] : null;
            if (hitInfo) t.lastCombatHitBy = hitInfo;
            const deathMeta = {
                cause: inferredCause,
                stalled: flags && flags.stalled != null ? !!flags.stalled : !!t.stalled,
                ap: flags && Number.isFinite(Number(flags.ap)) ? Number(flags.ap) : t.ap,
                lastHit: hitInfo || t.lastCombatHitBy || null,
                killedBy: killInfo
                    || (inferredCause === 'combat' ? (hitInfo || t.lastCombatHitBy || null) : null)
            };
            if (!t.isDestroyed && lastLog[id] && lastLog[id].damageTaken > 0) {
                GameContext.stateMachine.applyDamage(id, lastLog[id].damageTaken, deathMeta);
            }
            if (!t.isDestroyed && destroyedByLog) {
                GameContext.stateMachine.applyDamage(id, Math.max(100, t.hp || 100), deathMeta);
            }
            if (
                (destroyedByLog || (t.isDestroyed && inferredCause === 'airspace')) &&
                inferredCause === 'airspace' &&
                !t.aiEnabled &&
                typeof showSMSAlert === 'function'
            ) {
                showSMSAlert(`${String(id).toUpperCase()} 離開作戰空域 — 判定擊落`, '#ffeb3b');
            } else if (
                !t.isDestroyed &&
                lastLog &&
                lastLog.airspacePenalty &&
                lastLog.airspacePenalty[id] &&
                !t.aiEnabled &&
                typeof showSMSAlert === 'function'
            ) {
                const pen = Number(lastLog.airspacePenalty[id]) || 0;
                showSMSAlert(
                    `${String(id).toUpperCase()} 空域越界 −${pen} HP（強制回場）`,
                    '#ffeb3b'
                );
            }

            const finalPos = (t.flightCurve && t.pathQuats && t.pathQuats.length)
                ? t.flightCurve.getPointAt(1.0)
                : (t.wrapper ? t.wrapper.position.clone() : null);
            const finalQuat = (t.pathQuats && t.pathQuats.length)
                ? getQuatAt(1.0, t.pathQuats)
                : (t.wrapper && t.wrapper.userData.logicalQuat
                    ? t.wrapper.userData.logicalQuat.clone()
                    : (t.wrapper ? t.wrapper.quaternion.clone() : null));
            
            if (t.isDestroyed || destroyedByLog) {
                t.isDestroyed = true;
                if (trajectoryMeshes[id]) { scene.remove(trajectoryMeshes[id]); trajectoryMeshes[id] = null; }

                if (finalPos && finalQuat) GameContext.stateMachine.setPostTurnPose(id, finalPos, finalQuat);

                const softKill = !!(lastLog && lastLog.softWreck && lastLog.softWreck[id]);
                const groundBurst = !!(lastLog && lastLog.wreckGroundBurst && lastLog.wreckGroundBurst[id]);
                const turnNow = Number(GameContext.state.currentTurn || 1);

                if (t.wreckPhase === 'falling') {
                    if (groundBurst || turnNow >= (t.wreckBurstTurn || turnNow)) {
                        GameContext.stateMachine.finalizeWreckBurst(id);
                    } else {
                        GameContext.stateMachine.markDestroyedFlightState(id);
                        if (t.wrapper) t.wrapper.visible = true;
                    }
                    return;
                }

                if (t.wreckPhase === 'gone') {
                    GameContext.stateMachine.markDestroyedFlightState(id);
                    if (t.wrapper) t.wrapper.visible = false;
                    return;
                }

                // Fresh kill this turn.
                if (softKill && !groundBurst) {
                    GameContext.stateMachine.beginWreckFall(id, 1);
                } else {
                    t.wreckPhase = 'gone';
                    GameContext.stateMachine.markDestroyedFlightState(id);
                    if (t.wrapper) t.wrapper.visible = false;
                    if (softKill && groundBurst && typeof window.spawnAircraftDebris === 'function' && t.wrapper) {
                        window.spawnAircraftDebris(t.wrapper.position.clone(), t.wrapper.quaternion.clone(), t.colorMain);
                    }
                    if (window.AirArenaMultiView) {
                        if (typeof window.AirArenaMultiView.close === 'function') window.AirArenaMultiView.close(id);
                        if (typeof window.AirArenaMultiView.pruneDestroyed === 'function') window.AirArenaMultiView.pruneDestroyed();
                        if (typeof window.uiRefreshTeamModeButtons === 'function') window.uiRefreshTeamModeButtons();
                    }
                }
                return; 
            }
            
            GameContext.stateMachine.setPostTurnPose(id, finalPos, finalQuat);

            let finalStepAP = (t.chain && t.chain.length > 0 && typeof t.chain[0].resultingAP === 'number' && !isNaN(t.chain[0].resultingAP)) ? t.chain[0].resultingAP : simulateFlight(t, t.chain && t.chain.length > 0 ? t.chain : [{yaw:0, pitch:0, roll:0, throttle:t.throttle}]).finalAP;
            let stats = (typeof getThrottleStats === 'function')
                ? getThrottleStats(t.throttle, t.type || 'mig21')
                : (CONFIG.aircrafts[t.type || 'mig21'].throttleStats[Math.round(t.throttle)] || { thrust: 15, heat: 0 });
            let heatDelta = (t.chain && t.chain.length > 0 && typeof t.chain[0].heatDelta === 'number') ? t.chain[0].heatDelta : stats.heat;
            
            GameContext.stateMachine.updateHeat(id, heatDelta);
            GameContext.stateMachine.updateAP(id, finalStepAP, stats.thrust);
            const firedGun = !!(t.chain && t.chain.length > 0 && t.chain[0].fire === 'gun');
            GameContext.stateMachine.settleGunHeat(id, firedGun);
            GameContext.stateMachine.resetPlanningChain(id);
            let freshRes = simulateFlight(t, t.chain); t.pathPoints = freshRes.points; t.pathQuats = freshRes.quats;
            GameContext.stateMachine.resetTurnStatus(id);

            // 1. 先處理舊回合的殘影
            if (trajectoryMeshes[id]) { 
                trajectoryMeshes[id].material = trajectoryMeshes[id].material.clone();
                pastTrajectories.push(trajectoryMeshes[id]); if (pastTrajectories.length > 4) scene.remove(pastTrajectories.shift()); 
                pastTrajectories.forEach((mesh, idx) => { mesh.material.opacity = (pastTrajectories.length - 1 - idx) <= 1 ? 0.35 : 0.12; }); 
                trajectoryMeshes[id] = null; 
            }

            // 2. 🟢 救命神藥：確保新回合一開始，立刻為敵方建立未來網格，否則 HUD 將無實體可操作！
            if (typeof drawTrajectoryLine === 'function') {
                drawTrajectoryLine(t);
                if (trajectoryMeshes[id]) {
                    const splitHide = !!(window.AirArenaMultiView && window.AirArenaMultiView.isSplit && window.AirArenaMultiView.isSplit());
                    let isCurrentPlayer = (typeof tAct !== 'undefined' && id === tAct) || (id === window.tAct);
                    trajectoryMeshes[id].visible = splitHide ? false : (isCurrentPlayer ? true : !!(t.userData && t.userData.showEnvelope));
                }
            }
        });

        // Carry flares AFTER destroy settle — never keep a dead aircraft's flares into wreck/ACMI turns.
        {
            const stepN = (CONFIG.rules && CONFIG.rules.stepsPerTurn) || 100;
            const finalFlares = (lastLog && lastLog.flaresTrack && lastLog.flaresTrack[stepN])
                ? lastLog.flaresTrack[stepN]
                : [];
            const maxAge = (typeof getFlareMaxAge === 'function') ? getFlareMaxAge() : 2;
            const carried = finalFlares
                .filter((f) => f && f.teamId && Number.isFinite(Number(f.age)) && Number(f.age) < maxAge)
                .filter((f) => !(typeof isFlareOwnerGone === 'function' && isFlareOwnerGone(f.teamId)))
                .filter((f) => {
                    const heat = (typeof getFlareStageHeat === 'function')
                        ? getFlareStageHeat(f.age)
                        : (Number(f.heat) || 0);
                    return heat > 0;
                })
                .map((f) => ({
                    pos: f.pos.clone(),
                    vel: f.vel ? f.vel.clone() : new THREE.Vector3(0, -0.0005, 0),
                    age: Number(f.age) + 1,
                    teamId: f.teamId
                }));
            GameContext.stateMachine.setGlobalFlares(carried);
        }
    } catch (error) { console.error("回合結算錯誤：", error); }

    const redElim = GameContext.isFactionEliminated('red');
    const blueElim = GameContext.isFactionEliminated('blue');
    const wreckPending = combatActiveIds().some((id) => teams[id] && teams[id].wreckPhase === 'falling');

    if (redElim || blueElim) {
        let settleLog = battleLog[battleLog.length-1];
        let winner = (settleLog && settleLog.winner) ? settleLog.winner : "DRAW (雙方同歸於盡)";
        if (redElim && !blueElim) winner = "BLUE TEAM 勝利";
        if (!redElim && blueElim) winner = "RED TEAM 勝利";
        if (redElim && blueElim) winner = "DRAW (雙方同歸於盡)";

        if (wreckPending) {
            // Delay game-over until soft wrecks finish their fall + debris burst.
            // Single auto-path only — do not also schedule the both-AI planner.
            GameContext.stateMachine.advanceTurn();
            if (typeof window.uiForceHumanControlView === 'function') {
                window.uiForceHumanControlView();
            } else {
                const living = GameContext.getLivingTeamIds ? GameContext.getLivingTeamIds() : [];
                const humanIds = living.filter((id) => teams[id] && !teams[id].aiEnabled);
                let nextControlTeam = humanIds[0] || GameContext.getActiveTeamId() || 'red';
                if (humanIds.includes(GameContext.getActiveTeamId())) nextControlTeam = GameContext.getActiveTeamId();
                if (typeof selectTeam === 'function') selectTeam(nextControlTeam);
            }
            window.dispatchEvent(new CustomEvent('EnginePhaseChanged', { detail: { phase: 'planning', turn: currentTurn, wreckFall: true } }));
            scheduleWreckFallTurn(450);
            return;
        }

        combatActiveIds().forEach((id) => {
            if (teams[id] && teams[id].isDestroyed) GameContext.stateMachine.markDestroyedFlightState(id);
        });
        clearWreckFallAutoTimer();
        window.dispatchEvent(new CustomEvent('EnginePhaseChanged', { detail: { phase: 'game_over', winner: winner } }));
        return; 
    }

    const maxEngagementTurns = Number(CONFIG.rules.maxEngagementTurns || 0);
    const turnNow = Number(GameContext.state.currentTurn || 1);
    if (maxEngagementTurns > 0 && turnNow >= maxEngagementTurns) {
        const winner = 'DRAW (回合上限)';
        if (lastLog) lastLog.winner = winner;
        clearWreckFallAutoTimer();
        window.dispatchEvent(new CustomEvent('EnginePhaseChanged', { detail: { phase: 'game_over', winner } }));
        return;
    }
    
    GameContext.stateMachine.advanceTurn();
    // Prefer living human seat + stick panel (planning event also re-asserts this).
    if (typeof window.uiForceHumanControlView === 'function') {
        window.uiForceHumanControlView();
    } else {
        const living = GameContext.getLivingTeamIds ? GameContext.getLivingTeamIds() : combatActiveIds();
        const humanIds = living.filter((id) => teams[id] && !teams[id].aiEnabled);
        let nextControlTeam = humanIds[0] || GameContext.getActiveTeamId() || 'red';
        if (humanIds.includes(GameContext.getActiveTeamId())) nextControlTeam = GameContext.getActiveTeamId();
        selectTeam(nextControlTeam);
    }
    window.dispatchEvent(new CustomEvent('EnginePhaseChanged', { detail: { phase: 'planning', turn: currentTurn } }));
}
