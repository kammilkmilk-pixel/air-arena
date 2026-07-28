// ============================================================================
// state-machine.js - GameContext.stateMachine core + AI / weapons / turn settle
// ============================================================================

GameContext.stateMachine = {
    getTeamOrNull(teamId) {
        return GameContext.getTeam(teamId) || null;
    },

    applyDamage(teamId, amount) {
        const t = GameContext.getTeam(teamId);
        if (!t || t.isDestroyed) return false;
        t.hp = Math.max(0, t.hp - amount);
        if (t.hp <= 0) {
            t.hp = 0;
            t.isDestroyed = true;
            if (CONFIG.debug) console.log(`💀 [系統結算] ${teamId.toUpperCase()} 小隊戰機已墜毀！`);
        }
        return t.isDestroyed;
    },

    updateHeat(teamId, delta) {
        const t = GameContext.getTeam(teamId);
        if (!t) return;
        const maxH = MAX_HEAT;
        const throttle = t.throttle || 4;

        if (t.flameout === undefined) t.flameout = false;

        if (t.flameout) {
            t.heat = Math.max(0, (t.heat || 0) - 15);
            if (t.heat < 40) {
                t.flameout = false;
                if (CONFIG.debug) console.log(`❄️ [系統提示] ${teamId.toUpperCase()} 引擎冷卻完成，重新點火！`);
            }
        } else if (delta !== undefined) {
            t.heat = Math.max(0, Math.min(maxH, (t.heat || 0) + delta));
        } else {
            if (throttle === 5) t.heat = (t.heat || 0) + 22;
            else if (throttle === 4) t.heat = Math.max(0, (t.heat || 0) - 2);
            else if (throttle === 3) t.heat = Math.max(0, (t.heat || 0) - 6);
            else if (throttle === 2) t.heat = Math.max(0, (t.heat || 0) - 12);
            else if (throttle === 1) t.heat = Math.max(0, (t.heat || 0) - 18);

            if (t.heat >= maxH) {
                t.flameout = true;
                t.throttle = 2;
                if (CONFIG.debug) console.log(`🔥 [警報] ${teamId.toUpperCase()} 引擎過熱 (FLAMEOUT)！強制關機保護！`);
            }
        }
    },

    updateAP(teamId, rawSpeed, thrustBonus) {
        const t = GameContext.getTeam(teamId);
        if (!t) return;
        const stallAP = CONFIG.rules.stallSpeedAP || 45;
        const minH = CONFIG.rules.minFlightHeight || 0.5;

        const actualThrust = thrustBonus || 35;
        let newAP = rawSpeed + (actualThrust * 0.25);
        newAP = Math.min(MAX_AP, newAP);

        t.speed = newAP;
        t.ap = Math.floor(newAP);

        if (t.wrapper) {
            t.stalled = (t.ap < stallAP || t.wrapper.position.y < minH);
            if (t.stalled) {
                if (CONFIG.debug) console.log(`⚠ [警報] ${teamId.toUpperCase()} 戰機空速不足 (${t.ap}m/s)，進入氣動失速！`);
            }
        }
    },

    setThrottle(teamId, level) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed || GameContext.isAnimating() || t.ready) return false;
        const nextLevel = Math.max(1, Math.min(5, Math.round(level)));
        if (nextLevel === 5 && t.heat > 40) return false;
        t.throttle = nextLevel;
        return true;
    },

    /** Point aircraft nose at nearest hostile. Slight pitch toward target altitude; writes logicalQuat. */
    faceOpponent(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.wrapper) return false;
        const enemyId = GameContext.getNearestHostileId(teamId)
            || (String(teamId).startsWith('red') ? 'blue' : 'red');
        const enemy = this.getTeamOrNull(enemyId);
        if (!enemy || !enemy.wrapper) return false;
        const from = t.wrapper.position;
        const to = enemy.wrapper.position;
        const dir = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
        if (dir.lengthSq() < 0.0001) return false;
        // Cap pitch so face-on does not plant a steep climb/dive at enable.
        const horiz = Math.hypot(dir.x, dir.z);
        if (horiz > 0.001) dir.y = Math.max(-horiz * 0.22, Math.min(horiz * 0.22, dir.y));
        else dir.y = 0;
        dir.normalize();
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        t.wrapper.quaternion.copy(quat);
        t.wrapper.rotation.setFromQuaternion(quat);
        t.wrapper.userData.logicalQuat = quat.clone();
        if (!t.startPos) t.startPos = from.clone();
        else t.startPos.copy(from);
        if (!t.startQuat) t.startQuat = quat.clone();
        else t.startQuat.copy(quat);
        if (typeof initialPositions !== 'undefined' && initialPositions[teamId]) {
            if (initialPositions[teamId].pos) initialPositions[teamId].pos.copy(from);
            if (initialPositions[teamId].quat) initialPositions[teamId].quat.copy(quat);
        }
        return true;
    },

    /**
     * FOX2-FIRST opening ambush: ~20% of enables get the perch + pre-arm rush.
     * Rolled once per enable/policy switch so the opening stays consistent that fight.
     */
    rollFox2OpeningAmbush(teamId, chance = 0.2) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        t.aiFox2OpeningAmbush = Math.random() < Math.max(0, Math.min(1, chance));
        return !!t.aiFox2OpeningAmbush;
    },

    hasFox2OpeningAmbush(teamId) {
        const t = this.getTeamOrNull(teamId);
        return !!(t && t.aiFox2OpeningAmbush);
    },

    /**
     * FOX2-FIRST opening: perch altitude + stand-off approach lane facing the human.
     * Place inside FOX-2 envelope (45–120). Turn 1 only powers seekers; shoot from turn 2.
     */
    applyFox2OpeningPerch(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.aiEnabled || !t.wrapper) return false;
        const enemyId = GameContext.getNearestHostileId(teamId)
            || (String(teamId).startsWith('red') ? 'blue' : 'red');
        const enemy = this.getTeamOrNull(enemyId);
        if (!enemy || !enemy.wrapper) {
            return this.faceOpponent(teamId);
        }
        const perchY = 44;
        const approachDist = 72; // mid FOX-2 envelope (min 45 / max 120)
        const pos = t.wrapper.position;
        const enemyPos = enemy.wrapper.position;
        let offset = new THREE.Vector3(pos.x - enemyPos.x, 0, pos.z - enemyPos.z);
        const horizDist = offset.length();
        if (horizDist < 0.5) {
            offset.set(0, 0, -1);
        } else {
            offset.multiplyScalar(1 / horizDist);
        }
        // Always snap into opening shot lane for fox2-first ambush.
        if (t.aiPolicyMode === 'fox2-first' && (horizDist < 50 || horizDist > 110 || Math.abs(horizDist - approachDist) > 18)) {
            pos.x = enemyPos.x + offset.x * approachDist;
            pos.z = enemyPos.z + offset.z * approachDist;
        }
        if (t.aiPolicyMode === 'fox2-first' && pos.y < perchY - 1) {
            pos.y = perchY;
        }
        this.armFox2OpeningMissiles(teamId);
        return this.faceOpponent(teamId);
    },

    /**
     * Opening FOX-2: begin seeker power-up only (standby → powering).
     * Must NOT jump to armed — that would let turn 1 launch (cheat).
     * powering → armed happens in resetTurnStatus after the turn resolves.
     */
    armFox2OpeningMissiles(teamId, count = 2) {
        if (typeof tryAttachAllPylons === 'function') {
            try { tryAttachAllPylons(); } catch (e) { /* ignore */ }
        }
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.pylons || !Array.isArray(t.pylons)) return false;
        let powered = 0;
        for (let i = 0; i < t.pylons.length; i++) {
            const p = t.pylons[i];
            if (!p || p.state === 'empty') continue;
            if (powered >= count) break;
            if (p.state === 'standby') {
                p.state = 'powering';
                if (p.mesh) p.mesh.visible = true;
                powered += 1;
            } else if (p.state === 'powering' || p.state === 'armed') {
                powered += 1;
            }
        }
        if (powered > 0) {
            t.weapon = 'missile';
            // Never queue a launch while still powering.
            if (!t.pylons.some(p => p.state === 'armed')) {
                this.clearQueuedAction(teamId);
            }
            return true;
        }
        return false;
    },

    setAIEnabled(teamId, enabled) {
        const t = this.getTeamOrNull(teamId);
        if (!t || GameContext.isAnimating() || GameContext.isReplayMode()) return false;
        t.aiEnabled = !!enabled;
        t.aiState = t.aiEnabled ? 'idle' : 'player';
        t.aiStatusText = t.aiEnabled ? 'NPC: 待機中' : 'PLAYER CONTROL';
        t.aiLastAction = null;
        t.aiManualOverride = t.aiManualOverride || 'auto';
        t.aiPolicyMode = ['heuristic', 'hybrid', 'fox2-first'].includes(t.aiPolicyMode) ? t.aiPolicyMode : 'heuristic';
        t.aiThreatActive = false;
        t.aiLastFlareTurn = t.aiLastFlareTurn ?? -99;
        if (t.aiEnabled) {
            t.ready = false;
            this.clearQueuedAction(teamId);
            this.resetPilotInput(teamId);
            // Always nose-on; fox2-first ambush (~20%) also gets perch + seeker power-up (launch next turn).
            if (t.aiPolicyMode === 'fox2-first') {
                if (this.rollFox2OpeningAmbush(teamId, 0.2)) this.applyFox2OpeningPerch(teamId);
                else {
                    t.aiFox2OpeningAmbush = false;
                    this.faceOpponent(teamId);
                }
            } else {
                t.aiFox2OpeningAmbush = false;
                this.faceOpponent(teamId);
            }
        } else {
            t.aiFox2OpeningAmbush = false;
        }
        return true;
    },

    toggleAI(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        return this.setAIEnabled(teamId, !t.aiEnabled);
    },

    setAIStatus(teamId, state, text, action = null) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        t.aiState = state || 'idle';
        t.aiStatusText = text || `NPC: ${t.aiState}`;
        if (action) t.aiLastAction = action;
        return true;
    },

    setAIManualOverride(teamId, mode) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        const normalized = ['auto', 'evade', 'gun', 'missile'].includes(mode) ? mode : 'auto';
        t.aiManualOverride = normalized;
        return true;
    },

    setAIPolicyMode(teamId, mode) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        const normalized = ['heuristic', 'hybrid', 'fox2-first'].includes(mode) ? mode : 'heuristic';
        t.aiPolicyMode = normalized;
        if (t.aiEnabled) {
            if (normalized === 'fox2-first') {
                if (this.rollFox2OpeningAmbush(teamId, 0.2)) this.applyFox2OpeningPerch(teamId);
                else {
                    t.aiFox2OpeningAmbush = false;
                    this.faceOpponent(teamId);
                }
            } else {
                t.aiFox2OpeningAmbush = false;
                this.faceOpponent(teamId);
            }
        }
        return true;
    },

    logAIMissileThreat(teamId, action) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !action || !action.debug || !action.debug.missileThreat) return false;
        const turnNo = Math.max(1, Number(GameContext.state.currentTurn || 1));
        if (t.aiThreatLastTurn === turnNo && t.aiThreatActive) return false;

        const dbg = action.debug;
        const entry = {
            turn: turnNo,
            distance: dbg.distance,
            angleDeg: dbg.angleDeg,
            closure: dbg.closure,
            predictedSeparation: dbg.predictedSeparation,
            enemyAspectDeg: dbg.enemyAspectDeg,
            threatLevel: dbg.threatLevel || 'medium',
            threatScore: typeof dbg.threatScore === 'number' ? dbg.threatScore : 0.5,
            losBlocked: !!dbg.losBlocked,
            coverDistance: dbg.coverDistance,
            coverMode: dbg.coverMode || 'clear',
            collisionRisk: dbg.collisionRisk || 'low',
            maskScore: dbg.maskScore,
            maskDistance: dbg.maskDistance,
            maskState: dbg.maskState || 'none',
            maskPathBlocked: !!dbg.maskPathBlocked,
            flare: action.queueAction === 'flare',
            state: action.state || 'evade'
        };

        if (!Array.isArray(t.aiThreatLog)) t.aiThreatLog = [];
        t.aiThreatLog.unshift(entry);
        t.aiThreatLog = t.aiThreatLog.slice(0, 12);
        t.aiThreatLastTurn = turnNo;
        return true;
    },

    applyPilotAction(teamId, action) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !action || t.isDestroyed) return false;

        this.setAIStatus(teamId, action.state || 'thinking', action.statusText || action.reason || 'NPC: 決策中', action);
        // Only tag wingman orders when a living human lead exists (solo AI has no pair).
        if (t.aiEnabled && t.wingmanOrder && typeof AirArenaAI !== 'undefined' && AirArenaAI.getWingmanLeadId) {
            const leadId = AirArenaAI.getWingmanLeadId(teamId);
            if (leadId) {
                const labels = { follow: '跟隨', attack: '攻擊我的目標', free: '主動進攻', cover: '掩護', break: '脫離' };
                const label = labels[t.wingmanOrder];
                if (label && t.aiStatusText && t.aiStatusText.indexOf(label) < 0) {
                    t.aiStatusText = `${t.aiStatusText}｜${label}`;
                }
            }
        }
        if (action.debug && action.debug.missileThreat) {
            t.aiThreatActive = true;
            this.logAIMissileThreat(teamId, action);
        } else {
            t.aiThreatActive = false;
        }

        if (typeof action.throttle === 'number') this.setThrottle(teamId, action.throttle);
        if (typeof action.joyX === 'number' || typeof action.joyY === 'number') {
            this.setJoystickInput(teamId, action.joyX || 0, action.joyY || 0);
        }
        if (typeof action.yawCmd === 'number') {
            t.pendingYaw = action.yawCmd;
        }
        if (typeof action.pitchCmd === 'number') {
            t.pendingPitch = action.pitchCmd;
        }
        if (typeof action.roll === 'number') this.setRollInput(teamId, action.roll);
        if (action.weapon) this.setWeaponMode(teamId, action.weapon);
        t.singleMissileShot = !!action.singleMissile;

        if (action.powerPylons && t.pylons) {
            // Power up standby pylons (通電). Do not invent armed state — that takes a full turn.
            const standbyPylons = t.pylons.filter(p => p.state === 'standby');
            const alreadyLive = t.pylons.filter(p => p.state === 'armed' || p.state === 'powering').length;
            const want = Math.max(0, Math.min(2, 2 - alreadyLive));
            for (let i = 0; i < want && i < standbyPylons.length; i++) {
                this.togglePylonPower(teamId, standbyPylons[i].id);
            }
        }

        if (action.queueAction) {
            if (action.queueAction === 'gun') this.queueAction(teamId, 'gun');
            else if (action.queueAction === 'missile') {
                // Hard rule: cannot schedule launch until at least one pylon is armed (post-powering turn).
                const armedCount = t.pylons ? t.pylons.filter(p => p.state === 'armed').length : 0;
                if (armedCount > 0) this.toggleMissileQueue(teamId);
                else this.clearQueuedAction(teamId);
            }
            else if (action.queueAction === 'flare') {
                if (!t.flaresArmed && t.flareAmmo > 0 && this.queueAction(teamId, 'flare')) {
                    t.aiLastFlareTurn = Number(GameContext.state.currentTurn || 1);
                }
            }
            else this.clearQueuedAction(teamId);
        } else {
            this.clearQueuedAction(teamId);
        }

        if (action.ready) {
            GameContext.callService('updateTacticalPreview', t);
            this.setReady(teamId, true);
        }
        return true;
    },

    setWeaponMode(teamId, weapon) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode() || t.ready) return false;
        t.weapon = weapon === 'missile' ? 'missile' : 'gun';
        this.clearQueuedAction(teamId);
        return true;
    },

    /** Force weapon mode during Match Setup (ignores ready/anim gates). */
    forceWeaponMode(teamId, weapon) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed) return false;
        t.weapon = weapon === 'missile' ? 'missile' : 'gun';
        this.clearQueuedAction(teamId);
        return true;
    },

    toggleWeaponMode(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return null;
        const nextWeapon = t.weapon === 'gun' ? 'missile' : 'gun';
        return this.setWeaponMode(teamId, nextWeapon) ? nextWeapon : null;
    },

    clearQueuedAction(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        t.wpnQueued = false;
        t.queuedAction = 'none';
        t.singleMissileShot = false;
        if (t.flaresArmed) t.flaresArmed = false;
        return true;
    },

    queueAction(teamId, action) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode() || t.ready) return false;
        if (action === 'none') return this.clearQueuedAction(teamId);
        t.wpnQueued = action === 'gun' || action === 'missile';
        t.queuedAction = action;
        t.flaresArmed = action === 'flare';
        return true;
    },

    toggleGunQueue(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.weapon !== 'gun') return false;
        if (t.wpnQueued && t.queuedAction === 'gun') return this.clearQueuedAction(teamId);
        return this.queueAction(teamId, 'gun');
    },

    toggleMissileQueue(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.weapon !== 'missile' || !t.pylons) return false;
        const armedCount = t.pylons.filter(item => item.state === 'armed').length;
        if (armedCount <= 0) {
            this.clearQueuedAction(teamId);
            return false;
        }
        if (t.wpnQueued && t.queuedAction === 'missile') return this.clearQueuedAction(teamId);
        return this.queueAction(teamId, 'missile');
    },

    toggleFlares(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed || GameContext.isAnimating() || t.ready || t.flareAmmo <= 0) return false;
        if (t.flaresArmed) {
            t.flaresArmed = false;
            t.queuedAction = 'none';
            return true;
        }
        t.flaresArmed = true;
        t.wpnQueued = false;
        t.queuedAction = 'flare';
        return true;
    },

    togglePylonPower(teamId, pylonId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.pylons || t.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode() || t.ready) return null;
        const p = t.pylons.find(item => item.id === pylonId);
        if (!p || p.state === 'empty') return null;
        if (p.state === 'standby') {
            p.state = 'powering';
        } else if (p.state === 'powering' || p.state === 'armed') {
            p.state = 'standby';
            if (!t.pylons.some(item => item.state === 'armed')) this.clearQueuedAction(teamId);
        }
        return p.state;
    },

    setWingmanOrder(teamId, order) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        const normalized = ['follow', 'attack', 'free', 'cover', 'break'].includes(order) ? order : 'follow';
        t.wingmanOrder = normalized;
        const labels = { follow: '跟隨', attack: '攻擊我的目標', free: '主動進攻', cover: '掩護', break: '脫離' };
        if (t.aiEnabled) {
            t.aiStatusText = `NPC: 僚機令｜${labels[normalized]}`;
        }
        return true;
    },

    setLockedTarget(teamId, targetId) {
        return GameContext.setLockedTarget(teamId, targetId);
    },

    setReady(teamId, ready) {
        const t = this.getTeamOrNull(teamId);
        if (!t || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed) return false;
        t.ready = !!ready;
        if (t.ready) this.resetPilotInput(teamId);
        return true;
    },

    toggleReady(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        return this.setReady(teamId, !t.ready);
    },

    resetPilotInput(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        t.joyX = 0;
        t.joyY = 0;
        t.roll = 0;
        t.pendingRoll = 0;
        t.pendingYaw = 0;
        t.pendingPitch = 0;
        return true;
    },

    setRollInput(teamId, roll) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed || GameContext.isAnimating() || t.ready) return false;
        let nextRoll = roll;
        if (t.gLimiterOn) {
            const maxRollLimit = Math.PI / 4;
            nextRoll = Math.max(-maxRollLimit, Math.min(maxRollLimit, nextRoll));
        }
        t.pendingRoll = nextRoll;
        return true;
    },

    setJoystickInput(teamId, joyX, joyY) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed || GameContext.isAnimating() || t.ready) return false;
        t.joyX = joyX;
        t.joyY = joyY;
        t.pendingRoll = 0;
        t.roll = joyX * (Math.PI / 4);
        return true;
    },

    setGlobalFlares(flares) {
        GameContext.state.globalFlares.length = 0;
        GameContext.state.globalFlares.push(...flares);
        return true;
    },

    pruneActiveMissiles(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.activeMissiles) return false;
        t.activeMissiles = t.activeMissiles.filter(m => !m.exploded && m.ap > 0);
        return true;
    },

    setPostTurnPose(teamId, finalPos, finalQuat) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.wrapper) return false;
        t.wrapper.position.copy(finalPos);
        t.wrapper.quaternion.copy(finalQuat);
        t.wrapper.userData.logicalQuat = finalQuat.clone();
        t.startPos = finalPos.clone();
        t.startQuat = finalQuat.clone();
        return true;
    },

    resetPlanningChain(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        t.chain = [{ yaw: 0, pitch: 0, roll: 0, throttle: t.throttle || 2, fire: 'none' }];
        return true;
    },

    commitTurn(log) {
        GameContext.state.battleLog.push(log);
        return GameContext.state.battleLog.length;
    },

    advanceTurn() {
        GameContext.state.currentTurn += 1;
        return GameContext.state.currentTurn;
    },

    resetTurnStatus(teamId) {
        const t = GameContext.getTeam(teamId);
        if (!t) return;
        t.ready = false;
        t.wpnQueued = false;
        t.queuedAction = 'none';

        if (t.pylons && typeof scene !== 'undefined') {
            t.pylons.forEach(p => {
                p.hasBoomedThisTurn = false;
                if (p.flyingMesh) { scene.remove(p.flyingMesh); p.flyingMesh = null; }
                if (p.boomMesh) {
                    scene.remove(p.boomMesh);
                    if (p.boomMesh.geometry) p.boomMesh.geometry.dispose();
                    if (p.boomMesh.material) p.boomMesh.material.dispose();
                    p.boomMesh = null;
                }
                if (p.state === 'powering') p.state = 'armed';
                if (p.mesh) p.mesh.visible = (p.state !== 'empty');
            });
        }
    }
};

Object.assign(
    GameContext.stateMachine,
    window.StateMachineMatchApi || {},
    window.StateMachineWreckApi || {}
);

/** @deprecated 使用 GameContext.stateMachine */
window.StateMachine = GameContext.stateMachine;
