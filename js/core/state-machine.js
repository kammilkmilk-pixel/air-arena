// ============================================================================
// state-machine.js - GameContext.stateMachine core + AI / weapons / turn settle
// ============================================================================

GameContext.stateMachine = {
    getTeamOrNull(teamId) {
        return GameContext.getTeam(teamId) || null;
    },

    applyDamage(teamId, amount, meta = null) {
        const t = GameContext.getTeam(teamId);
        if (!t || t.isDestroyed) return false;
        t.hp = Math.max(0, t.hp - amount);
        if (t.hp <= 0) {
            t.hp = 0;
            t.isDestroyed = true;
            if (meta && meta.cause) t.deathCause = meta.cause;
            if (meta && meta.stalled != null) t.deathStalled = !!meta.stalled;
            else if (t.deathStalled == null) t.deathStalled = !!t.stalled;
            if (meta && Number.isFinite(Number(meta.ap))) t.deathAp = Number(meta.ap);
            this.markAIDestroyedStatus(teamId);
            if (CONFIG.debug) console.log(`💀 [系統結算] ${teamId.toUpperCase()} 小隊戰機已墜毀！ cause=${t.deathCause || 'combat'}`);
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

    getGunHeatConfig() {
        const gun = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.gun) ? CONFIG.weapons.gun : {};
        return {
            heatPerShot: Number.isFinite(Number(gun.heatPerShot)) ? Number(gun.heatPerShot) : 0.3,
            coolPerTurn: Number.isFinite(Number(gun.coolPerTurn)) ? Number(gun.coolPerTurn) : 0.4,
            overheatAt: Number.isFinite(Number(gun.overheatAt)) ? Number(gun.overheatAt) : 1.0
        };
    },

    getGunHeat(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return 0;
        return Math.max(0, Math.min(1, Number(t.gunHeat) || 0));
    },

    isGunOverheated(teamId) {
        const cfg = this.getGunHeatConfig();
        return this.getGunHeat(teamId) >= cfg.overheatAt - 1e-6;
    },

    /** Apply +heat on fire or −cool when idle. Call once per team at turn settle. */
    settleGunHeat(teamId, firedGun) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed) return 0;
        const cfg = this.getGunHeatConfig();
        let next = Number(t.gunHeat) || 0;
        if (firedGun) next += cfg.heatPerShot;
        else next -= cfg.coolPerTurn;
        t.gunHeat = Math.max(0, Math.min(1, next));
        return t.gunHeat;
    },

    updateAP(teamId, rawSpeed, thrustBonus) {
        const t = GameContext.getTeam(teamId);
        if (!t) return;
        const stallAP = CONFIG.rules.stallSpeedAP || 35;
        const minH = CONFIG.rules.minFlightHeight || 0.5;

        // rawSpeed is simulateFlight.finalAP (drag + in-sim thrust already applied).
        // Do not add thrustBonus again — that kept AP glued to maxAp (300) every settle.
        let newAP = Number(rawSpeed);
        if (!Number.isFinite(newAP)) newAP = typeof t.ap === 'number' ? t.ap : 120;
        newAP = Math.max(-100, Math.min(MAX_AP, newAP));

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
     * FOX2-FIRST opening ambush chance from CONFIG.doctrine (fallback 0.2).
     * Explicit arg still wins when finite — prefer omitting it so CONFIG is single source.
     */
    getFox2OpeningAmbushChance(explicitChance) {
        if (Number.isFinite(explicitChance)) {
            return Math.max(0, Math.min(1, Number(explicitChance)));
        }
        const fromCfg = (typeof CONFIG !== 'undefined' && CONFIG.doctrine)
            ? Number(CONFIG.doctrine.fox2OpeningAmbushChance)
            : NaN;
        return Number.isFinite(fromCfg) ? Math.max(0, Math.min(1, fromCfg)) : 0.2;
    },

    /**
     * QA force: URL `fox2Ambush=1|0|true|false` overrides CONFIG.doctrine.fox2OpeningAmbushForce.
     * @returns {boolean|null} null = roll normally
     */
    getFox2OpeningAmbushForce() {
        if (typeof window !== 'undefined' && window.location && window.location.search) {
            try {
                const sp = new URLSearchParams(window.location.search);
                if (sp.has('fox2Ambush')) {
                    const v = String(sp.get('fox2Ambush') || '').toLowerCase();
                    if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
                    if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
                }
            } catch (_) { /* ignore */ }
        }
        const f = (typeof CONFIG !== 'undefined' && CONFIG.doctrine)
            ? CONFIG.doctrine.fox2OpeningAmbushForce
            : null;
        if (f === true || f === false) return f;
        return null;
    },

    /** Seeded RNG for QA, else Math.random. Seed from URL `fox2AmbushSeed` or CONFIG. */
    getFox2OpeningAmbushRng() {
        let seed = NaN;
        if (typeof window !== 'undefined' && window.location && window.location.search) {
            try {
                const sp = new URLSearchParams(window.location.search);
                if (sp.has('fox2AmbushSeed')) seed = Number(sp.get('fox2AmbushSeed'));
            } catch (_) { /* ignore */ }
        }
        if (!Number.isFinite(seed) && typeof CONFIG !== 'undefined' && CONFIG.doctrine) {
            seed = Number(CONFIG.doctrine.fox2OpeningAmbushSeed);
        }
        if (!Number.isFinite(seed)) return Math.random.bind(Math);
        // mulberry32
        let t = (seed >>> 0);
        return function fox2AmbushRand() {
            t += 0x6D2B79F5;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    },

    /**
     * FOX2-FIRST opening ambush: chance from CONFIG.doctrine.fox2OpeningAmbushChance (~20%).
     * Rolled once per enable/policy switch so the opening stays consistent that fight.
     * QA: force via URL/CONFIG; seed via fox2AmbushSeed for deterministic repro.
     */
    rollFox2OpeningAmbush(teamId, chance = null) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        const force = this.getFox2OpeningAmbushForce();
        if (force === true || force === false) {
            t.aiFox2OpeningAmbush = force;
            return force;
        }
        const p = this.getFox2OpeningAmbushChance(chance);
        const rand = this.getFox2OpeningAmbushRng();
        t.aiFox2OpeningAmbush = rand() < p;
        return !!t.aiFox2OpeningAmbush;
    },

    hasFox2OpeningAmbush(teamId) {
        const t = this.getTeamOrNull(teamId);
        return !!(t && t.aiFox2OpeningAmbush);
    },

    /**
     * FOX2-FIRST opening: perch altitude + stand-off approach lane facing the human.
     * Place inside FOX-2 envelope (CONFIG minArming–maxFlight; approach ~72). Turn 1 only powers seekers; shoot from turn 2.
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
        const approachDist = 72; // mid FOX-2 envelope
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
        this.beginFox2OpeningPowerUp(teamId);
        return this.faceOpponent(teamId);
    },

    /**
     * One-way pylon FSM: standby → powering only (never armed, never toggle-off).
     * Opening ambush and AI powerPylons must use this — not raw state writes.
     */
    beginPylonPowerUp(teamId, pylonId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.pylons || t.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode()) return null;
        const p = t.pylons.find(item => item.id === pylonId);
        if (!p || p.state === 'empty') return null;
        if (p.state === 'standby') {
            const wType = typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p.weaponType || 'fox2');
            if (typeof dropConflictingPylonPower === 'function') dropConflictingPylonPower(t, wType);
            p.state = 'powering';
            if (p.mesh) p.mesh.visible = true;
            return 'powering';
        }
        // Already in the arming pipeline.
        if (p.state === 'powering' || p.state === 'armed') return p.state;
        return null;
    },

    logDoctrineEvent(evt) {
        if (!GameContext.state.doctrineEvents) GameContext.state.doctrineEvents = [];
        const entry = {
            turn: Math.max(0, Number(GameContext.state.currentTurn || 0)),
            at: Date.now(),
            ...(evt || {})
        };
        GameContext.state.doctrineEvents.push(entry);
        if (typeof CONFIG !== 'undefined' && CONFIG.debug) {
            try { console.log('[doctrine]', entry); } catch (_) { /* ignore */ }
        }
        return entry;
    },

    isFox2OpeningInstantArmEnabled() {
        return !!(typeof CONFIG !== 'undefined' && CONFIG.doctrine && CONFIG.doctrine.fox2OpeningInstantArm === true);
    },

    /**
     * Explicit QA/scenario bypass: standby|powering → armed (same-turn launch possible).
     * Blocked unless CONFIG.doctrine.fox2OpeningInstantArm === true.
     */
    instantArmFox2OpeningMissiles(teamId, count = 2) {
        if (!this.isFox2OpeningInstantArmEnabled()) {
            this.logDoctrineEvent({
                type: 'fox2OpeningInstantArmBlocked',
                teamId,
                reason: 'fox2OpeningInstantArm=false'
            });
            return false;
        }
        if (typeof tryAttachAllPylons === 'function') {
            try { tryAttachAllPylons(); } catch (e) { /* ignore */ }
        }
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.pylons || !Array.isArray(t.pylons)) return false;
        const armedIds = [];
        for (let i = 0; i < t.pylons.length; i++) {
            const p = t.pylons[i];
            if (!p || p.state === 'empty') continue;
            if (armedIds.length >= count) break;
            if (p.state === 'standby' || p.state === 'powering' || p.state === 'armed') {
                p.state = 'armed';
                if (p.mesh) p.mesh.visible = true;
                armedIds.push(p.id);
            }
        }
        if (armedIds.length > 0) {
            t.weapon = 'missile';
            this.logDoctrineEvent({
                type: 'fox2OpeningInstantArm',
                teamId,
                pylonIds: armedIds,
                mode: 'instant-arm'
            });
            return true;
        }
        return false;
    },

    /**
     * FOX2-FIRST opening: one-turn seeker power-up (standby → powering).
     * powering → armed happens in resetTurnStatus after the turn resolves — never same-turn launch.
     * Set CONFIG.doctrine.fox2OpeningInstantArm for explicit QA instant-arm instead.
     */
    beginFox2OpeningPowerUp(teamId, count = 2) {
        if (this.isFox2OpeningInstantArmEnabled()) {
            return this.instantArmFox2OpeningMissiles(teamId, count);
        }
        if (typeof tryAttachAllPylons === 'function') {
            try { tryAttachAllPylons(); } catch (e) { /* ignore */ }
        }
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.pylons || !Array.isArray(t.pylons)) return false;
        const started = [];
        const already = [];
        for (let i = 0; i < t.pylons.length; i++) {
            const p = t.pylons[i];
            if (!p || p.state === 'empty') continue;
            if (started.length + already.length >= count) break;
            if (p.state === 'standby') {
                if (this.beginPylonPowerUp(teamId, p.id) === 'powering') started.push(p.id);
            } else if (p.state === 'powering' || p.state === 'armed') {
                already.push(p.id);
            }
        }
        if (started.length + already.length > 0) {
            t.weapon = 'missile';
            // Never queue a launch while still powering.
            if (!t.pylons.some(p => p.state === 'armed')) {
                this.clearQueuedAction(teamId);
            }
            this.logDoctrineEvent({
                type: 'fox2OpeningPowerUp',
                teamId,
                started,
                already,
                mode: 'one-turn-powering'
            });
            return true;
        }
        this.logDoctrineEvent({
            type: 'fox2OpeningPowerUpEmpty',
            teamId,
            reason: 'no-standby-pylons'
        });
        return false;
    },

    /** @deprecated use beginFox2OpeningPowerUp — kept for call-site compatibility */
    armFox2OpeningMissiles(teamId, count = 2) {
        return this.beginFox2OpeningPowerUp(teamId, count);
    },

    setAIEnabled(teamId, enabled) {
        const t = this.getTeamOrNull(teamId);
        if (!t || GameContext.isAnimating() || GameContext.isReplayMode()) return false;
        t.aiEnabled = !!enabled;
        t.aiState = t.aiEnabled ? 'idle' : 'player';
        t.aiStatusText = t.aiEnabled ? 'NPC: 待機中' : 'PLAYER CONTROL';
        t.aiLastAction = null;
        t.aiPreDeathAction = null;
        t.aiManualOverride = t.aiManualOverride || 'auto';
        t.aiPolicyMode = ['heuristic', 'hybrid', 'fox2-first', 'fox1-first'].includes(t.aiPolicyMode) ? t.aiPolicyMode : 'heuristic';
        t.aiThreatActive = false;
        t.aiLastFlareTurn = t.aiLastFlareTurn ?? -99;
        t.aiLastChaffTurn = t.aiLastChaffTurn ?? -99;
        t.aiDecisionTrail = [];
        t.aiDecisionTrailFrozen = false;
        if (Array.isArray(t.aiDebugTrace)) t.aiDebugTrace = [];
        if (t.aiEnabled) {
            t.ready = false;
            this.clearQueuedAction(teamId);
            this.resetPilotInput(teamId);
            // Always nose-on; fox2-first ambush (CONFIG.doctrine.fox2OpeningAmbushChance) also gets perch + seeker power-up (launch next turn).
            if (t.aiPolicyMode === 'fox2-first') {
                if (this.rollFox2OpeningAmbush(teamId)) this.applyFox2OpeningPerch(teamId);
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
        // Keep destroyed NPCs pinned to 被擊墜 in the decision tree / engage HUD.
        if (t.isDestroyed || (typeof t.hp === 'number' && t.hp <= 0)) {
            return this.markAIDestroyedStatus(teamId);
        }
        t.aiState = state || 'idle';
        t.aiStatusText = text || `NPC: ${t.aiState}`;
        if (action) t.aiLastAction = action;
        return true;
    },

    /** Pin NPC status after HP reaches 0 — keep last living decision tree for debug export. */
    markAIDestroyedStatus(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        if (!t.aiEnabled) {
            t.aiState = 'destroyed';
            return true;
        }
        const cause = t.deathCause || 'combat';
        const stalled = t.deathStalled != null ? !!t.deathStalled : !!t.stalled;
        let statusText = '被擊墜';
        let reason = 'HP depleted — shot down';
        if (cause === 'building') {
            statusText = stalled ? '失速撞樓' : '撞毀於建築';
            reason = stalled ? 'Stall crash into building' : 'Building collision';
        } else if (cause === 'ground') {
            statusText = stalled ? '失速墜地' : '撞毀於地面';
            reason = stalled ? 'Stall crash into ground' : 'Ground collision';
        } else if (cause === 'midair') {
            statusText = '空中相撞';
            reason = 'Mid-air collision';
        } else if (cause === 'impact') {
            statusText = stalled ? '失速撞毀' : '撞擊墜毀';
            reason = stalled ? 'Stall impact (unspecified)' : 'Impact destruction';
        }
        t.aiState = 'destroyed';
        t.aiStatusText = statusText;

        const prev = t.aiLastAction;
        // Freeze the last living decide() output once; wreck / setAIStatus must not wipe it.
        if (prev && prev.state !== 'destroyed' && !t.aiPreDeathAction) {
            try {
                t.aiPreDeathAction = JSON.parse(JSON.stringify(prev));
            } catch (err) {
                t.aiPreDeathAction = prev;
            }
        }
        const alive = t.aiPreDeathAction || (prev && prev.state !== 'destroyed' ? prev : null);
        const aliveDebug = alive && alive.debug ? alive.debug : null;
        let aliveDebugCopy = {};
        if (aliveDebug) {
            try {
                aliveDebugCopy = JSON.parse(JSON.stringify(aliveDebug));
            } catch (err) {
                aliveDebugCopy = { mode: aliveDebug.mode || null };
            }
        }
        const aliveTree = aliveDebug && Array.isArray(aliveDebug.tree) ? aliveDebug.tree.slice() : [];
        const deathFooter = [
            '--- death ---',
            `selected: destroyed`,
            statusText,
            `deathCause=${cause} stalled=${stalled ? 1 : 0}`,
            alive && alive.state ? `lastAliveState=${alive.state}` : null,
            alive && alive.statusText ? `lastAliveStatus=${alive.statusText}` : null
        ].filter(Boolean);

        // Already pinned with preserved tree: only refresh cause/status labels.
        if (prev && prev.state === 'destroyed' && prev.debug && prev.debug.preDeathPreserved) {
            prev.statusText = statusText;
            prev.reason = reason;
            prev.deathCause = cause;
            prev.deathStalled = stalled ? 1 : 0;
            prev.debug.mode = 'destroyed';
            prev.debug.deathCause = cause;
            prev.debug.deathStalled = stalled ? 1 : 0;
            const tree = Array.isArray(prev.debug.tree) ? prev.debug.tree : [];
            const cut = tree.findIndex((line) => line === '--- death ---');
            prev.debug.tree = (cut >= 0 ? tree.slice(0, cut) : tree).concat(deathFooter);
            t.aiDecisionTrailFrozen = true;
            return true;
        }

        t.aiLastAction = {
            state: 'destroyed',
            statusText,
            reason,
            // Keep last stick/throttle for forensics (not flown after death).
            throttle: alive && typeof alive.throttle === 'number' ? alive.throttle : 0,
            joyX: alive && typeof alive.joyX === 'number' ? alive.joyX : 0,
            joyY: alive && typeof alive.joyY === 'number' ? alive.joyY : 0,
            pitchCmd: alive && alive.pitchCmd != null ? alive.pitchCmd : undefined,
            yawCmd: alive && alive.yawCmd != null ? alive.yawCmd : undefined,
            roll: alive && alive.roll != null ? alive.roll : undefined,
            weapon: (alive && alive.weapon) || 'gun',
            queueAction: 'none',
            ready: true,
            deathCause: cause,
            deathStalled: stalled ? 1 : 0,
            lastAliveState: alive ? alive.state : null,
            lastAliveStatusText: alive ? alive.statusText : null,
            debug: {
                ...aliveDebugCopy,
                mode: 'destroyed',
                deathCause: cause,
                deathStalled: stalled ? 1 : 0,
                preDeathPreserved: 1,
                lastAliveMode: aliveDebug && aliveDebug.mode ? aliveDebug.mode : (alive && alive.state) || null,
                tree: aliveTree.concat(deathFooter)
            }
        };
        // Freeze always-on decision trail at first death pin.
        t.aiDecisionTrailFrozen = true;
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
        const normalized = ['heuristic', 'hybrid', 'fox2-first', 'fox1-first'].includes(mode) ? mode : 'heuristic';
        t.aiPolicyMode = normalized;
        if (t.aiEnabled) {
            if (normalized === 'fox2-first') {
                if (this.rollFox2OpeningAmbush(teamId)) this.applyFox2OpeningPerch(teamId);
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
            // Prefer powering pylons matching desired missile type (fox1 vs fox2) without mixing.
            const wantType = action.missileType
                ? (typeof sanitizePylonWeapon === 'function' ? sanitizePylonWeapon(action.missileType) : action.missileType)
                : null;
            let standbyPylons = t.pylons.filter(p => p.state === 'standby');
            if (wantType) {
                const typed = standbyPylons.filter(p =>
                    (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : p.weaponType) === wantType
                );
                if (typed.length) standbyPylons = typed;
            }
            const liveType = typeof teamLiveMissileType === 'function' ? teamLiveMissileType(t) : null;
            if (liveType && wantType && liveType !== wantType && typeof dropConflictingPylonPower === 'function') {
                dropConflictingPylonPower(t, wantType);
            }
            const alreadyLive = t.pylons.filter(p => p.state === 'armed' || p.state === 'powering').length;
            const maxPower = Math.max(1, Math.min(2, Number(action.powerPylonCount) || 2));
            const want = Math.max(0, Math.min(maxPower, maxPower - alreadyLive));
            for (let i = 0; i < want && i < standbyPylons.length; i++) {
                this.beginPylonPowerUp(teamId, standbyPylons[i].id);
            }
        }

        if (action.queueAction) {
            if (action.queueAction === 'gun') {
                if (!this.queueAction(teamId, 'gun')) this.clearQueuedAction(teamId);
            }
            else if (action.queueAction === 'missile') {
                const armedCount = t.pylons ? t.pylons.filter(p => p.state === 'armed').length : 0;
                if (armedCount > 0) this.toggleMissileQueue(teamId);
                else this.clearQueuedAction(teamId);
            }
            else if (action.queueAction === 'flare') {
                if (!t.flaresArmed && t.flareAmmo > 0 && this.queueAction(teamId, 'flare')) {
                    t.aiLastFlareTurn = Number(GameContext.state.currentTurn || 1);
                }
            }
            else if (action.queueAction === 'chaff') {
                if (!t.chaffArmed && (t.chaffAmmo || 0) > 0) {
                    this.toggleChaff(teamId);
                    t.aiLastChaffTurn = Number(GameContext.state.currentTurn || 1);
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
        if (action === 'gun' && this.isGunOverheated(teamId)) {
            this.clearQueuedAction(teamId);
            return false;
        }
        t.wpnQueued = action === 'gun' || action === 'missile';
        t.queuedAction = action;
        t.flaresArmed = action === 'flare';
        return true;
    },

    toggleGunQueue(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.weapon !== 'gun') return false;
        if (t.wpnQueued && t.queuedAction === 'gun') return this.clearQueuedAction(teamId);
        if (this.isGunOverheated(teamId)) return false;
        return this.queueAction(teamId, 'gun');
    },

    toggleMissileQueue(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.weapon !== 'missile' || !t.pylons) return false;
        const armed = t.pylons.filter(item => item.state === 'armed');
        if (armed.length <= 0) {
            this.clearQueuedAction(teamId);
            return false;
        }
        if (t.wpnQueued && t.queuedAction === 'missile') return this.clearQueuedAction(teamId);

        const liveType = typeof pylonWeaponType === 'function'
            ? pylonWeaponType(armed[0])
            : (armed[0].weaponType || 'fox2');
        // FOX-1: require target in 70–200 envelope before queue.
        if (liveType === 'fox1') {
            const enemy = combatEnemyOf
                ? combatEnemyOf(teamId)
                : (GameContext.getNearestHostileId && teams[GameContext.getNearestHostileId(teamId)]);
            if (!enemy || !enemy.wrapper || enemy.isDestroyed || !t.wrapper) return false;
            const cfg = typeof getMissileWeaponConfig === 'function'
                ? getMissileWeaponConfig('fox1')
                : (CONFIG.weapons.fox1 || {});
            const dist = t.wrapper.position.distanceTo(enemy.wrapper.position);
            const minR = Number(cfg.minArmingRange) || 70;
            const maxR = Number(cfg.seekerRange) || 200;
            if (dist < minR || dist > maxR) return false;
            t.fox1SupportTargetId = enemy.id;
        }
        t.queuedMissileType = liveType;
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
        t.chaffArmed = false;
        t.flaresArmed = true;
        t.wpnQueued = false;
        t.queuedAction = 'flare';
        return true;
    },

    toggleChaff(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || t.isDestroyed || GameContext.isAnimating() || t.ready || (t.chaffAmmo || 0) <= 0) return false;
        if (t.chaffArmed) {
            t.chaffArmed = false;
            t.queuedAction = 'none';
            return true;
        }
        t.flaresArmed = false;
        t.chaffArmed = true;
        t.wpnQueued = false;
        t.queuedAction = 'chaff';
        return true;
    },

    togglePylonPower(teamId, pylonId) {
        const t = this.getTeamOrNull(teamId);
        if (!t || !t.pylons || t.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode() || t.ready) return null;
        const p = t.pylons.find(item => item.id === pylonId);
        if (!p || p.state === 'empty') return null;
        if (p.state === 'standby') {
            const wType = typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p.weaponType || 'fox2');
            const dropped = typeof dropConflictingPylonPower === 'function'
                ? dropConflictingPylonPower(t, wType)
                : 0;
            p.state = 'powering';
            if (dropped > 0 && t.wpnQueued && t.queuedAction === 'missile') this.clearQueuedAction(teamId);
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
        if (t.aiEnabled && !t.isDestroyed && !(typeof t.hp === 'number' && t.hp <= 0)) {
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

    setGlobalChaff(chaff) {
        if (!GameContext.state.globalChaff) GameContext.state.globalChaff = [];
        GameContext.state.globalChaff.length = 0;
        GameContext.state.globalChaff.push(...(chaff || []));
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

        if (t.pylons) {
            t.pylons.forEach(p => {
                p.hasBoomedThisTurn = false;
                if (typeof scene !== 'undefined') {
                    if (p.flyingMesh) { scene.remove(p.flyingMesh); p.flyingMesh = null; }
                    if (p.boomMesh) {
                        scene.remove(p.boomMesh);
                        if (p.boomMesh.geometry) p.boomMesh.geometry.dispose();
                        if (p.boomMesh.material) p.boomMesh.material.dispose();
                        p.boomMesh = null;
                    }
                }
                // One-turn powering → armed (H2 FSM). Not gated on scene existence.
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
