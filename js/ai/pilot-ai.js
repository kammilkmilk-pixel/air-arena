// ============================================================================
// pilot-ai.js - MVP NPC Pilot (FSM + lightweight utility)
// ============================================================================

window.AirArenaAI = {
    // Per-team memory used for non-cheating constant-velocity estimates.
    trackMemory: {},
    contactMemory: {},
    loopMemory: {},
    lowAltRecoveryMemory: {},
    postGroundRecoveryMemory: {},
    /** Multi-turn nav commitment: climbOut corridor until target alt (not single-gate stick patches). */
    navIntentMemory: {},
    weaponRangeMemory: {},
    brakeTurnMemory: {},
    urbanAvoidMemory: {},
    raycaster: new THREE.Raycaster(),
    tuningDefaults: null,

    getBuiltinDefaults() {
        if (window.AIR_ARENA_AI_DEFAULTS) return { ...window.AIR_ARENA_AI_DEFAULTS };
        const env = (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.getAiEnvelopeFields)
            ? AirArenaWeaponEnvelope.getAiEnvelopeFields()
            : {
                gunRange: 70,
                gunAngle: 22,
                missileMinRange: 35,
                missileMaxRange: 120,
                missileAngle: 27
            };
        return {
            energyCriticalAp: 52,
            lowAp: 65,
            stallPitchThreshold: 0.16,
            minRecoverAlt: 22,
            stallRecoverBonus: 7.5,
            climbPenalty: 6.2,
            gunRange: env.gunRange,
            gunAngle: env.gunAngle,
            missileMinRange: env.missileMinRange,
            missileMaxRange: env.missileMaxRange,
            missileAngle: env.missileAngle,
            interceptTurnGain: 0.22,
            recoverPitchBias: -0.2,
            hybridAggression: 0.55,
            combatBandMin: 35,
            combatBandMax: 92,
            combatBandHardMax: 108,
            mandatoryClimbAlt: 36,
            buildingRiskDowngrade: 0,
            buildingRiskProfile: 'gap',
            routePlanHorizon: 5,
            routeBeamWidth: 2,
            routeBeamMinRisk: 'low',
            engageHandoffLowDist: 14,
            engageHandoffHighDistKeep: 18,
            engageHandoffMediumDist: 18,
            engageHandoffHighClimbDist: 18,
            engageHandoffFwdBlock: 18,
            engageHandoffLowFy: -0.2,
            engageHandoffDiveFy: -0.18,
            engageHandoffMediumFy: 0.12,
            engageHandoffHighFy: 0.22,
            engageHandoffMediumAlt: 30,
            engageHandoffHighAlt: 32,
            engageHandoffDiveAltMax: 52,
            enemyFlareLikelyAmmo: 2,
            missileSalvoDualChance: 0.22,
            missileSalvoDualChanceNoFlare: 0.48,
            flareUrgentKeepChance: 0.96,
            flareSoftKeepChance: 0.72
        };
    },

    getMandatoryClimbAlt(tuning = this.getTuning()) {
        return Math.max(8, Number(tuning.mandatoryClimbAlt) || 36);
    },

    getMandatoryClimbJoyY(altitude, forwardY = null) {
        const alt = Number(altitude) || 0;
        const fwdY = Number(forwardY);
        // Residual dive (T61 red2): 0.55–0.58 was not enough — still sank through canyon.
        const diving = Number.isFinite(fwdY) && fwdY < -0.12;
        if (alt < 10) return diving ? 0.88 : 0.72;
        if (alt < 14) return diving ? 0.78 : 0.62;
        if (alt < 22) return diving ? 0.72 : 0.55;
        return diving ? 0.62 : 0.48;
    },

    /**
     * Below mandatoryClimbAlt: climb hard unless truly under a slab.
     * Dense-urban canyon headroom is often <8–10 while still climbable (T35: sky=0 → mandClimb never fired).
     * Only block on roofClearance / underRoof / nose-into-slab.
     */
    wantsMandatoryClimb(altitude, coverInfo = {}, opts = {}) {
        const floor = this.getMandatoryClimbAlt(opts.tuning || this.getTuning());
        if (!(Number(altitude) < floor)) return false;
        if (opts.steepIntoBldg || opts.underRoof) return false;
        const roofClear = Number(coverInfo.roofClearance);
        if (Number.isFinite(roofClear) && roofClear < 2) return false;
        return true;
    },

    /** Combat gun range with safe fallback to shared envelope (never stale 42). */
    gunRangeOr(tuning, fallback) {
        const n = Number(tuning && tuning.gunRange);
        if (Number.isFinite(n) && n > 0) return n;
        if (Number.isFinite(fallback) && fallback > 0) return fallback;
        if (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.getCombatRanges) {
            return AirArenaWeaponEnvelope.getCombatRanges().gunRange;
        }
        return 70;
    },

    missileMinOr(tuning, fallback) {
        const n = Number(tuning && tuning.missileMinRange);
        if (Number.isFinite(n) && n > 0) return n;
        if (Number.isFinite(fallback) && fallback > 0) return fallback;
        if (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.getCombatRanges) {
            return AirArenaWeaponEnvelope.getCombatRanges().missileMinRange;
        }
        return 35;
    },

    missileMaxOr(tuning, fallback) {
        const n = Number(tuning && tuning.missileMaxRange);
        if (Number.isFinite(n) && n > 0) return n;
        if (Number.isFinite(fallback) && fallback > 0) return fallback;
        if (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.getCombatRanges) {
            return AirArenaWeaponEnvelope.getCombatRanges().missileMaxRange;
        }
        return 120;
    },

    /** Typed munition envelope (fox1 / fox2) from weapon-envelope ← CONFIG. */
    getMissileEnvelope(missileType) {
        if (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.getMissileCombatEnvelope) {
            return AirArenaWeaponEnvelope.getMissileCombatEnvelope(missileType);
        }
        if (missileType === 'fox1') {
            return {
                missileType: 'fox1',
                missileMinRange: 70,
                missileMaxRange: 200,
                seekerRange: 200,
                seekerAngleRad: Math.PI / 14
            };
        }
        return {
            missileType: 'fox2',
            missileMinRange: 35,
            missileMaxRange: 120,
            seekerRange: 120,
            seekerAngleRad: Math.PI / 12
        };
    },

    inferThreatMissileType(enemy) {
        if (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.inferThreatMissileType) {
            return AirArenaWeaponEnvelope.inferThreatMissileType(enemy);
        }
        const pylons = (enemy && enemy.pylons) || [];
        const typeOf = (p) => (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p.weaponType || 'fox2'));
        return pylons.some((p) => p && p.state !== 'empty' && typeOf(p) === 'fox1') ? 'fox1' : 'fox2';
    },

    /** Classify inbound missiles from a foe (typed CM doctrine). */
    classifyInboundMissiles(enemy) {
        const list = (enemy && enemy.activeMissiles) || [];
        let fox1 = 0;
        let fox2 = 0;
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (!m || !m.active || m.exploded) continue;
            if (m.missileType === 'fox1') fox1 += 1;
            else fox2 += 1;
        }
        return { fox1, fox2, any: fox1 + fox2 > 0 };
    },

    /**
     * Soft: are we inside a hostile FOX-1 illuminate gate?
     * Used for chaff decision + SMS lock parity (no aim-ring jitter).
     */
    evalUnderHostileSarhLock(self, primaryEnemy = null) {
        if (!self || !self.wrapper || typeof computeSarhSupport !== 'function' || typeof THREE === 'undefined') {
            return { locked: false, by: null };
        }
        const selfId = self.id;
        const selfPos = self.wrapper.position;
        let foes = [];
        if (typeof GameContext !== 'undefined' && GameContext.getHostileIds) {
            foes = GameContext.getHostileIds(selfId)
                .map((id) => GameContext.getTeam(id))
                .filter(Boolean);
        } else if (primaryEnemy) {
            foes = [primaryEnemy];
        }
        const typeOf = (p) => (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p && p.weaponType) || 'fox2');
        for (let i = 0; i < foes.length; i++) {
            const foe = foes[i];
            if (!foe || foe.isDestroyed || !foe.wrapper) continue;
            const hasFox1Missile = (foe.activeMissiles || []).some(
                (m) => m && m.missileType === 'fox1' && m.active && !m.exploded && Number(m.ap) > 0
            );
            const hasFox1Load = (foe.pylons || []).some((p) => p && p.state !== 'empty' && typeOf(p) === 'fox1');
            if (!hasFox1Missile && !hasFox1Load) continue;
            const losBlocked = this.hasObstacleBetween
                ? this.hasObstacleBetween(foe.wrapper.position, selfPos)
                : false;
            const support = computeSarhSupport({
                shooterPos: foe.wrapper.position,
                shooterQuat: foe.wrapper.quaternion,
                targetPos: selfPos,
                chaffList: [],
                step: 0,
                losBlocked
            });
            if (support && support.supported) {
                return { locked: true, by: foe.id, support };
            }
        }
        return { locked: false, by: null };
    },

    pickAiMissileType(self, distance, angleToTargetDeg) {
        if (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.inferTeamMissileType) {
            const policy = this.normalizePolicyMode(self && self.aiPolicyMode);
            return AirArenaWeaponEnvelope.inferTeamMissileType(self, {
                distance,
                angleDeg: angleToTargetDeg,
                preferFox1: policy === 'fox1-first'
            });
        }
        const typeOf = (p) => (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p.weaponType || 'fox2'));
        const pylons = (self && self.pylons) || [];
        const hasFox1 = pylons.some((p) => p && p.state !== 'empty' && typeOf(p) === 'fox1');
        const hasFox2 = pylons.some((p) => p && p.state !== 'empty' && typeOf(p) === 'fox2');
        const policy = this.normalizePolicyMode(self && self.aiPolicyMode);
        if (policy === 'fox1-first' && hasFox1) return 'fox1';
        const env1 = this.getMissileEnvelope('fox1');
        const preferFox1 =
            hasFox1 &&
            distance >= env1.missileMinRange &&
            distance <= env1.missileMaxRange &&
            angleToTargetDeg < 28;
        if (preferFox1) return 'fox1';
        if (hasFox2) return 'fox2';
        return hasFox1 ? 'fox1' : 'fox2';
    },

    fox1WasInFlightByTeam: Object.create(null),
    fox1SequelByTeam: Object.create(null),

    /** Munition doctrine overlay from CONFIG.doctrine.munition (flags only). */
    getMunitionDoctrine(missileType) {
        const table = (typeof CONFIG !== 'undefined' && CONFIG.doctrine && CONFIG.doctrine.munition)
            ? CONFIG.doctrine.munition
            : null;
        const key = missileType === 'fox1' ? 'fox1' : (missileType === 'gun' ? 'gun' : 'fox2');
        const row = table && table[key] ? table[key] : null;
        if (key === 'fox1') {
            return {
                dualSalvoOk: !!(row && row.dualSalvoOk),
                requireLos: row && row.requireLos != null ? !!row.requireLos : true,
                illuminateHold: row && row.illuminateHold != null ? !!row.illuminateHold : true,
                preferStandoff: row && row.preferStandoff != null ? !!row.preferStandoff : true,
                maxLaunchAngleDeg: Number(row && row.maxLaunchAngleDeg) || 28,
                holdNoseGain: Number(row && row.holdNoseGain) || 0.58,
                holdMaxJoy: Number(row && row.holdMaxJoy) || 0.62,
                minLaunchAlt: Number(row && row.minLaunchAlt) || 48,
                minLaunchAltUrban: Number(row && row.minLaunchAltUrban) || 42,
                clearPathTurns: Math.max(2, Math.min(6, Number(row && row.clearPathTurns) || 4)),
                clearPathMinAlt: Number(row && row.clearPathMinAlt) || 40,
                useGunLeadHold: row && row.useGunLeadHold != null ? !!row.useGunLeadHold : true,
                reattackPredictTurns: Math.max(1, Math.min(5, Number(row && row.reattackPredictTurns) || 3)),
                reattackStandoffMin: Number(row && row.reattackStandoffMin) || 95,
                reattackStandoffIdeal: Number(row && row.reattackStandoffIdeal) || 130
            };
        }
        if (key === 'gun') {
            return { preferClose: !!(row && row.preferClose) };
        }
        return {
            dualSalvoOk: row && row.dualSalvoOk != null ? !!row.dualSalvoOk : true,
            requireLos: row && row.requireLos != null ? !!row.requireLos : true,
            illuminateHold: false,
            preferStandoff: false,
            maxLaunchAngleDeg: Number(row && row.maxLaunchAngleDeg) || 32,
            holdNoseGain: 0,
            holdMaxJoy: 0.5
        };
    },

    hasOwnFox1InFlight(team) {
        const list = (team && team.activeMissiles) || [];
        // Do NOT require m.active — missiles spawn active:false until launchStep mid-turn.
        return list.some((m) =>
            m && m.missileType === 'fox1' && !m.exploded && Number(m.ap) > 0
        );
    },

    /** @deprecated alias — illuminate uses in-flight FOX-1 including pre-activate. */
    hasActiveFox1NeedingSupport(team) {
        return this.hasOwnFox1InFlight(team);
    },

    /** Remaining munition after current shot / for post-illuminate sequel. */
    peekNextMissileType(team, opts = {}) {
        if (typeof AirArenaWeaponEnvelope !== 'undefined' && AirArenaWeaponEnvelope.peekNextMissileType) {
            const policy = this.normalizePolicyMode(team && team.aiPolicyMode);
            return AirArenaWeaponEnvelope.peekNextMissileType(team, {
                ...opts,
                preferFox1: opts.preferFox1 != null ? opts.preferFox1 : policy === 'fox1-first'
            });
        }
        const typeOf = (p) => (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p.weaponType || 'fox2'));
        const live = ((team && team.pylons) || []).filter((p) => p && p.state && p.state !== 'empty');
        const hasFox1 = live.some((p) => typeOf(p) === 'fox1');
        const hasFox2 = live.some((p) => typeOf(p) === 'fox2');
        if (!hasFox1 && !hasFox2) return null;
        const policy = this.normalizePolicyMode(team && team.aiPolicyMode);
        if (hasFox1 && (policy === 'fox1-first' || opts.preferFox1)) return 'fox1';
        if (hasFox1 && !hasFox2) return 'fox1';
        return hasFox2 ? 'fox2' : 'fox1';
    },

    /**
     * Only true dirt / imminent mesh-smash may cancel FOX-1 illuminate.
     * Soft urbanRoute / soft obstacle / flare / postGround at safe alt must yield to SARH.
     */
    isFox1IlluminateHardAbort(action, team, ctx = {}) {
        if (!action) return false;
        const alt = Number(
            ctx.altitude != null
                ? ctx.altitude
                : (team && team.wrapper && team.wrapper.position ? team.wrapper.position.y : NaN)
        );
        const coverFwd = Number(
            ctx.coverForwardDistance != null
                ? ctx.coverForwardDistance
                : (action.debug && action.debug.coverForwardDistance)
        );
        const hardBldg = !!(action.hardBuilding || ctx.hardBuildingContact);

        if (action.state === 'groundAvoid' || action.state === 'terrainEscape') return true;
        if (action.state === 'safetyEmbedPushOut') return true;
        // Ultra-low pull-up / climb-out only
        if (action.state === 'emergencyPullUp' && Number.isFinite(alt) && alt < 24) return true;
        if (action.state === 'postGroundClimbOut' && Number.isFinite(alt) && alt < 26) return true;
        // Soft obstacleEmergencyEscape / urban* do NOT abort unless smash-imminent.
        if (
            hardBldg &&
            (action.state === 'obstacleEmergencyEscape' ||
                action.state === 'urbanRouteEscape' ||
                action.state === 'urbanBuildingWeave') &&
            Number.isFinite(coverFwd) &&
            coverFwd >= 0 &&
            coverFwd < 10 &&
            Number.isFinite(alt) &&
            alt < 42
        ) {
            return true;
        }
        return false;
    },

    /** Gun-like LCOS / geometry stick for FOX-1 prep + illuminate. */
    buildFox1HoldStick(teamId, team, ctx = {}, doctrine = null) {
        const doc = doctrine || this.getMunitionDoctrine('fox1');
        const maxJ = Math.max(0.55, Number(doc.holdMaxJoy) || 0.45);
        const gain = Number(doc.holdNoseGain) || 0.58;
        let holdX = 0;
        let holdY = 0;
        let usedLead = false;
        if (
            doc.useGunLeadHold &&
            team && team.wrapper &&
            ctx.enemyPos &&
            typeof this.getGunLeadAim === 'function'
        ) {
            const selfForward = ctx.selfForward || new THREE.Vector3(0, 0, 1)
                .applyQuaternion(team.wrapper.quaternion).normalize();
            const enemyForward = ctx.enemyForward || selfForward;
            const lead = this.getGunLeadAim(
                teamId,
                team.wrapper.position,
                selfForward,
                ctx.enemyPos,
                enemyForward,
                typeof team.ap === 'number' ? team.ap : 120,
                ctx.enemyAp || 120,
                team,
                ctx.assistedVelocity || null
            );
            const lx = ctx.localToEnemy ? Number(ctx.localToEnemy.x) || 0 : 0;
            const ly = ctx.localToEnemy ? Number(ctx.localToEnemy.y) || 0 : 0;
            holdX = this.clamp(lead.horizontalBias * 0.88 + (-lx) * 0.18, -maxJ, maxJ);
            holdY = this.clamp(lead.verticalBias * 0.72 + ly * 0.2, -maxJ * 0.9, maxJ * 0.9);
            usedLead = true;
        } else if (ctx.localToEnemy) {
            const lx = Number(ctx.localToEnemy.x) || 0;
            const ly = Number(ctx.localToEnemy.y) || 0;
            holdX = this.clamp(-lx * gain * 1.35, -maxJ, maxJ);
            holdY = this.clamp(ly * gain * 1.15, -maxJ * 0.9, maxJ * 0.9);
        }
        return {
            joyX: holdX,
            joyY: holdY,
            roll: this.clamp(holdX * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
            throttle: 4,
            usedLead
        };
    },

    evaluateFox1IlluminatePath(teamId, holdAction, doctrine = null) {
        const doc = doctrine || this.getMunitionDoctrine('fox1');
        const turns = doc.clearPathTurns || 4;
        const cont = [];
        for (let i = 1; i < turns; i++) {
            cont.push({
                joyX: holdAction.joyX,
                joyY: holdAction.joyY,
                roll: holdAction.roll,
                throttle: holdAction.throttle || 4,
                queueAction: 'none'
            });
        }
        const ev = this.evaluateActionSafety(teamId, {
            joyX: holdAction.joyX,
            joyY: holdAction.joyY,
            roll: holdAction.roll,
            throttle: holdAction.throttle || 4,
            queueAction: 'none'
        }, cont);
        const minAltOk = !Number.isFinite(ev.minAltitude) || ev.minAltitude >= doc.clearPathMinAlt;
        const ok = !ev.buildingHit && !!ev.safe && minAltOk;
        return { ok, eval: ev, minAltOk, buildingHit: !!ev.buildingHit };
    },

    /** Effective FOX-1 launch floor — urban rooftop band is slightly lower than open sky. */
    getFox1MinLaunchAlt(ctx = {}, doctrine = null) {
        const doc = doctrine || this.getMunitionDoctrine('fox1');
        const arenaMode = ctx.arenaMode
            || ((typeof GameContext !== 'undefined' && GameContext.getArenaMode)
                ? GameContext.getArenaMode()
                : 'buildings');
        const urban =
            ctx.urbanArenaMode === true ||
            arenaMode === 'dense-urban' ||
            arenaMode === 'medium-urban' ||
            arenaMode === 'buildings' ||
            arenaMode === 'obstacle-stress' ||
            arenaMode === 'sparse-urban';
        const urbanFloor = Number(doc.minLaunchAltUrban) || 42;
        const openFloor = Number(doc.minLaunchAlt) || 48;
        // Soft: sky-open / SARH perch from aiMap uses urban floor (not a hard force to shoot).
        if (urban || ctx.aiMapSarhPerch || ctx.aiMapClearAbove || ctx.aiMapSkyOpen) {
            return urbanFloor;
        }
        return openFloor;
    },

    /**
     * FOX-1 launch commit: altitude + LOS + angle + clear 3–4 turn illuminate path + standoff sequel.
     */
    canCommitFox1Launch(teamId, team, ctx = {}) {
        const doctrine = this.getMunitionDoctrine('fox1');
        const reasons = [];
        const alt = Number(
            ctx.altitude != null
                ? ctx.altitude
                : (team && team.wrapper && team.wrapper.position ? team.wrapper.position.y : NaN)
        );
        const minAlt = this.getFox1MinLaunchAlt(ctx, doctrine);
        if (!Number.isFinite(alt) || alt < minAlt) reasons.push('alt');
        if (doctrine.requireLos && ctx.lineOfSightBlocked) reasons.push('los');
        if (Number.isFinite(ctx.angleDeg) && ctx.angleDeg > doctrine.maxLaunchAngleDeg) reasons.push('angle');

        const sequel = this.fox1SequelByTeam[teamId];
        const dist = Number(ctx.distance);
        if (sequel && sequel.active && Number.isFinite(dist) && dist < doctrine.reattackStandoffMin) {
            reasons.push('standoff');
        }

        const stick = this.buildFox1HoldStick(teamId, team, ctx, doctrine);
        const path = this.evaluateFox1IlluminatePath(teamId, stick, doctrine);
        if (!path.ok) reasons.push('path');

        return {
            ok: reasons.length === 0,
            reasons,
            path,
            stick,
            doctrine
        };
    },

    /** Convert a would-be FOX-1 shot into prep/climb when launch gates fail. */
    gateFox1MissileShoot(teamId, team, action, ctx = {}) {
        if (!action || action.queueAction !== 'missile') return action;
        if ((action.missileType || ctx.missileType || ctx.aiMissileType) !== 'fox1') return action;
        const commit = this.canCommitFox1Launch(teamId, team, ctx);
        if (commit.ok) {
            if (!action.debug) action.debug = {};
            action.debug.fox1LaunchOk = 1;
            return action;
        }
        action.queueAction = 'none';
        action.singleMissile = false;
        action.state = 'missilePrep';
        action.powerPylons = action.powerPylons || false;
        const stick = commit.stick || this.buildFox1HoldStick(teamId, team, ctx, commit.doctrine);
        action.joyX = stick.joyX;
        action.joyY = stick.joyY;
        if (commit.reasons.indexOf('alt') >= 0) {
            action.joyY = Math.max(action.joyY, 0.42);
            action.throttle = Math.min(action.throttle || 4, 4);
        }
        action.roll = stick.roll;
        if (!action.debug) action.debug = {};
        action.debug.fox1LaunchHold = 1;
        action.debug.fox1LaunchHoldReasons = commit.reasons.slice();
        if (commit.reasons.indexOf('alt') >= 0) action.debug.fox1LaunchHoldAlt = 1;
        if (commit.reasons.indexOf('path') >= 0) action.debug.fox1LaunchHoldPath = 1;
        if (commit.reasons.indexOf('standoff') >= 0) action.debug.fox1LaunchHoldStandoff = 1;
        const why = commit.reasons.join('+') || '?';
        action.statusText = `NPC: FOX-1 待機｜${why}`;
        action.reason = `FOX-1 launch held: ${why}`;
        const tree = action.debug.tree;
        if (Array.isArray(tree)) tree.push(`fox1LaunchGate: hold reasons=${why}`);
        return action;
    },

    updateFox1SequelState(teamId, team, ctx = {}) {
        const inFlight = this.hasOwnFox1InFlight(team);
        const was = !!this.fox1WasInFlightByTeam[teamId];
        if (was && !inFlight) {
            const next = this.peekNextMissileType(team, {
                distance: ctx.distance,
                angleDeg: ctx.angleDeg
            });
            if (next === 'fox1') {
                const doctrine = this.getMunitionDoctrine('fox1');
                const predictTurns = doctrine.reattackPredictTurns;
                let predictPos = ctx.enemyPos || null;
                if (predictPos && typeof this.predictEnemyPosition === 'function') {
                    predictPos = this.predictEnemyPosition(
                        teamId,
                        predictPos,
                        predictTurns,
                        false,
                        ctx.assistedVelocity || null
                    );
                }
                this.fox1SequelByTeam[teamId] = {
                    active: true,
                    nextMunition: 'fox1',
                    predictPos: predictPos || null,
                    startedTurn: Number(GameContext && GameContext.state && GameContext.state.currentTurn) || 0
                };
            } else {
                this.fox1SequelByTeam[teamId] = {
                    active: false,
                    nextMunition: next || 'fox2',
                    predictPos: null
                };
            }
        }
        this.fox1WasInFlightByTeam[teamId] = inFlight;

        const sequel = this.fox1SequelByTeam[teamId];
        if (sequel && sequel.active) {
            const dist = Number(ctx.distance);
            const doctrine = this.getMunitionDoctrine('fox1');
            if (Number.isFinite(dist) && dist >= doctrine.reattackStandoffMin) {
                sequel.active = false;
                sequel.opened = true;
            }
        }
        return this.fox1SequelByTeam[teamId] || null;
    },

    applyFox1ReattackSetup(action, teamId, team, ctx = {}, sequel, doctrine) {
        if (!action || !sequel || !sequel.active || sequel.nextMunition !== 'fox1') return action;
        if (this.isFox1IlluminateHardAbort(action, team, ctx)) return action;

        const dist = Number(ctx.distance);
        const ideal = doctrine.reattackStandoffIdeal;
        const minS = doctrine.reattackStandoffMin;
        if (!Number.isFinite(dist) || dist >= minS) return action;

        // Beam / open away from predicted target, keep altitude for next SARH wave.
        let breakSign = 1;
        if (ctx.localToEnemy && Number.isFinite(ctx.localToEnemy.x)) {
            breakSign = ctx.localToEnemy.x >= 0 ? 1 : -1;
        }
        const openNeed = this.clamp((minS - dist) / Math.max(20, ideal - minS), 0.35, 1);
        // Soft: when aiMap says sky is open, prefer climb-extend over hard beam (less range collapse).
        const skySoft = !!(ctx.aiMapSkyOpen || ctx.aiMapClearAbove || ctx.aiMapSarhPerch);
        const beamScale = skySoft ? 0.62 : 1;
        const joyX = this.clamp(breakSign * (0.55 + openNeed * 0.35) * beamScale, -0.95, 0.95);
        const alt = Number(ctx.altitude);
        const minAlt = this.getFox1MinLaunchAlt(ctx, doctrine);
        let joyY = skySoft ? 0.2 : 0.12;
        if (Number.isFinite(alt) && alt < minAlt) joyY = 0.48;
        else if (Number.isFinite(alt) && alt < minAlt + 10) joyY = Math.max(joyY, 0.28);

        const prevState = action.state;
        action.joyX = joyX;
        action.joyY = joyY;
        action.roll = this.clamp(joyX * Math.PI / 5, -Math.PI / 5, Math.PI / 5);
        action.throttle = (skySoft || dist < minS * 0.75) ? 5 : 4;
        if (action.queueAction === 'missile') {
            action.queueAction = 'none';
            action.singleMissile = false;
        }
        action.state = 'fox1ReattackSetup';
        action.statusText = `NPC: FOX-1 拉開再攻 ${Math.floor(dist)}m→${Math.floor(minS)}m`;
        action.reason = 'FOX-1 sequel: open range + predict bearing before next SARH wave';
        if (!action.debug) action.debug = {};
        action.debug.fox1ReattackSetup = 1;
        action.debug.fox1NextMunition = 'fox1';
        action.debug.fox1OverrodeState = prevState && prevState !== 'fox1ReattackSetup' ? prevState : action.debug.fox1OverrodeState;
        const tree = action.debug.tree;
        if (Array.isArray(tree)) {
            tree.push(
                `fox1Sequel: reattackSetup dist=${dist.toFixed(1)} min=${minS} break=${breakSign} skySoft=${skySoft ? 1 : 0}`
            );
        }
        return action;
    },

    /**
     * SARH illuminate (gun-lead) + launch gate + post-shot sequel.
     * In-flight nose-track beats soft urban / flare-break.
     */
    applyFox1DoctrineOverlay(action, team, ctx = {}) {
        if (!action || !team) return action;
        const teamId = ctx.teamId || team.id || null;
        const doctrine = this.getMunitionDoctrine('fox1');
        const angleDeg = Number(ctx.angleDeg);
        const missileType = ctx.missileType || ctx.aiMissileType || action.missileType || 'fox1';
        const tree = (action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : null;
        const committingFox1 =
            missileType === 'fox1' &&
            (action.queueAction === 'missile' || !!action.powerPylons);

        // Don't dual-salvo SARH while illuminating.
        if (action.queueAction === 'missile' && missileType === 'fox1' && !doctrine.dualSalvoOk) {
            action.singleMissile = true;
            if (action.debug) action.debug.fox1SingleOnly = 1;
        }

        // Hold launch if off-support (too wide for reliable illuminate).
        if (
            action.queueAction === 'missile' &&
            missileType === 'fox1' &&
            Number.isFinite(angleDeg) &&
            angleDeg > doctrine.maxLaunchAngleDeg
        ) {
            action.queueAction = 'none';
            if (action.singleMissile) action.singleMissile = false;
            if (action.statusText && String(action.statusText).indexOf('照射角') < 0) {
                action.statusText = `${action.statusText}｜照射角不足`;
            }
            if (!action.debug) action.debug = {};
            action.debug.fox1LaunchHold = 1;
            if (tree) tree.push(`fox1Doctrine: launchHold ang=${angleDeg.toFixed(1)}>${doctrine.maxLaunchAngleDeg}`);
        }

        // Full launch gates (alt / path / standoff) as last safety net before illuminate.
        if (action.queueAction === 'missile' && missileType === 'fox1' && teamId) {
            this.gateFox1MissileShoot(teamId, team, action, ctx);
        }

        const inFlight = this.hasOwnFox1InFlight(team);
        if (teamId) this.updateFox1SequelState(teamId, team, ctx);

        const needHold = doctrine.illuminateHold && (inFlight || committingFox1);
        const hardAbort = this.isFox1IlluminateHardAbort(action, team, ctx);
        if (needHold && hardAbort) {
            if (!action.debug) action.debug = {};
            action.debug.fox1IlluminateAbort = 1;
            if (tree) tree.push(`fox1Doctrine: illuminateAbort=1 state=${action.state || '?'}`);
            return action;
        }
        if (needHold && !hardAbort) {
            const stick = this.buildFox1HoldStick(teamId, team, ctx, doctrine);
            const prevState = action.state;
            // Soft self-defense: inbound missile / under hostile paint — limited beam + CM, not full abandon.
            const inboundThreat = !!(ctx.actualMissileThreat || ctx.inboundFox1 || ctx.inboundFox2 || ctx.underSarhPaint);
            const softSelfDef =
                inboundThreat &&
                (
                    !!ctx.inboundFox1 ||
                    !!ctx.underSarhPaint ||
                    (Number.isFinite(angleDeg) && angleDeg > doctrine.maxLaunchAngleDeg * 0.85) ||
                    !!ctx.shouldChaffNow ||
                    !!ctx.shouldFlareNow
                );
            if (softSelfDef) {
                let breakSign = 1;
                if (ctx.localToEnemy && Number.isFinite(ctx.localToEnemy.x)) {
                    breakSign = ctx.localToEnemy.x >= 0 ? 1 : -1;
                }
                const beam = ctx.inboundFox1 || ctx.underSarhPaint || ctx.shouldChaffNow ? 0.62 : 0.42;
                action.joyX = this.clamp(stick.joyX * 0.28 + breakSign * beam, -0.95, 0.95);
                action.joyY = this.clamp(stick.joyY * 0.55 + 0.08, -0.35, 0.45);
                action.roll = this.clamp(action.joyX * Math.PI / 5, -Math.PI / 5, Math.PI / 5);
                if (action.throttle >= 5) action.throttle = 4;
                if (ctx.shouldChaffNow) action.queueAction = 'chaff';
                else if (ctx.shouldFlareNow) action.queueAction = 'flare';
                else if (action.queueAction === 'missile' && inFlight) {
                    action.queueAction = 'none';
                    action.singleMissile = false;
                }
                if (!action.debug) action.debug = {};
                action.debug.fox1IlluminateSoftBreak = 1;
                action.debug.fox1InFlight = inFlight ? 1 : 0;
                action.debug.fox1OverrodeState = prevState && prevState !== 'fox1IlluminateBreak' ? prevState : action.debug.fox1OverrodeState;
                action.state = 'fox1IlluminateBreak';
                action.statusText = ctx.shouldChaffNow
                    ? 'NPC: FOX-1 照射邊beam邊箔條'
                    : (ctx.shouldFlareNow ? 'NPC: FOX-1 照射邊beam邊熱焰' : 'NPC: FOX-1 照射軟beam自衛');
                action.reason = 'SARH: soft beam self-defense while own FOX-1 in flight';
                if (tree) {
                    tree.push(
                        `fox1Doctrine: illuminateSoftBreak=1 chaff=${ctx.shouldChaffNow ? 1 : 0} flare=${ctx.shouldFlareNow ? 1 : 0} paint=${ctx.underSarhPaint ? 1 : 0}`
                    );
                }
                return action;
            }
            action.joyX = stick.joyX;
            action.joyY = stick.joyY;
            action.roll = stick.roll;
            if (action.throttle >= 5) action.throttle = 4;
            // Keep illuminating; drop breakaway / second-shot queues.
            if (action.queueAction === 'missile' && inFlight) {
                action.queueAction = 'none';
                action.singleMissile = false;
            }
            if (!action.debug) action.debug = {};
            action.debug.fox1IlluminateHold = 1;
            action.debug.fox1InFlight = inFlight ? 1 : 0;
            action.debug.fox1GunLead = stick.usedLead ? 1 : 0;
            if (prevState && prevState !== 'fox1Illuminate') {
                action.debug.fox1OverrodeState = prevState;
            }
            if (inFlight) {
                action.state = 'fox1Illuminate';
                action.statusText = `NPC: FOX-1 照射保持 ${Number.isFinite(angleDeg) ? Math.floor(angleDeg) : '?'}°`;
                action.reason = 'SARH: gun-like nose hold while FOX-1 in flight';
            } else if (action.statusText && String(action.statusText).indexOf('照射') < 0) {
                action.statusText = `${action.statusText}｜SARH照射`;
            }
            if (tree) {
                tree.push(
                    `fox1Doctrine: illuminateHold=1 inFlight=${inFlight ? 1 : 0} lead=${stick.usedLead ? 1 : 0}` +
                    ` overrode=${prevState || 'n/a'} joy=${stick.joyX.toFixed(2)},${stick.joyY.toFixed(2)}`
                );
            }
            return action;
        }

        // Post-illuminate: if another FOX-1 remains, open range before next wave.
        const sequel = teamId ? this.fox1SequelByTeam[teamId] : null;
        if (!action.debug) action.debug = {};
        if (sequel && sequel.nextMunition) action.debug.fox1NextMunition = sequel.nextMunition;
        if (sequel && sequel.active && sequel.nextMunition === 'fox1') {
            this.applyFox1ReattackSetup(action, teamId, team, ctx, sequel, doctrine);
        }
        return action;
    },

    getTuning() {
        const external = (typeof window !== 'undefined' && window.AIR_ARENA_AI_TUNING) ? window.AIR_ARENA_AI_TUNING : {};
        const merged = { ...this.getBuiltinDefaults(), ...(external || {}) };
        try {
            if (typeof window !== 'undefined' && window.location && window.location.search) {
                const br = new URLSearchParams(window.location.search).get('buildingRisk');
                if (br === 'legacy' || br === 'gap') merged.buildingRiskProfile = br;
            }
        } catch (_) { /* ignore */ }
        return merged;
    },

    /** True when the opposing seat is human-controlled (not another NPC). */
    isHumanOpponent(enemyId) {
        const live = (typeof GameContext !== 'undefined' && GameContext.getTeam)
            ? GameContext.getTeam(enemyId)
            : null;
        if (!live) return false;
        return !live.aiEnabled || live.aiState === 'player';
    },

    /**
     * Mild vs-human offense assist ("cheat"): better lead, wider gun, never freeze on level-out
     * while the nose is off in a knife fight. Disabled vs AI so regression stays honest.
     */
    getOffensiveAssist(enemyId, ctx = {}) {
        const vsHuman = this.isHumanOpponent(enemyId);
        const distance = Number(ctx.distance || 999);
        const angleDeg = Number(ctx.angleDeg || 0);
        const localZ = ctx.localZ;
        const knifeFight = distance < 100;
        const noseOff = angleDeg > 65 || (Number.isFinite(localZ) && localZ < 0.28);
        return {
            vsHuman,
            perfectTrack: vsHuman,
            pathLeadCheat: vsHuman,
            deferLevelOut: vsHuman && knifeFight && noseOff,
            gunRangeMul: vsHuman ? 1.14 : 1,
            gunAngleMul: vsHuman ? 1.18 : 1,
            interceptMul: vsHuman ? 1.22 : 1,
            earlyGunInUrban: vsHuman,
            hardReacquireBoost: vsHuman && noseOff
        };
    },

    /** Prefer player's committed path / true velocity over noisy one-frame deltas. */
    getAssistedEnemyVelocity(enemyId, enemyPos, enemyForward, enemyAp = 120) {
        const live = (typeof GameContext !== 'undefined' && GameContext.getTeam)
            ? GameContext.getTeam(enemyId)
            : null;
        const fallbackStep = Math.max(0.35, (enemyAp || 100) * 0.015 / 100);
        const fallback = (enemyForward && enemyForward.lengthSq() > 0.0001)
            ? enemyForward.clone().normalize().multiplyScalar(fallbackStep * 18)
            : new THREE.Vector3(0, 0, 0);
        if (!live) return fallback;
        // Committed turn path: sample near-term displacement (strong but fair "HUD ghost" awareness).
        if (Array.isArray(live.pathPoints) && live.pathPoints.length >= 3 && enemyPos) {
            const a = live.pathPoints[0];
            const b = live.pathPoints[Math.min(live.pathPoints.length - 1, 8)];
            if (a && b && typeof a.distanceTo === 'function') {
                const delta = b.clone().sub(a);
                if (delta.lengthSq() > 0.01) return delta.multiplyScalar(1 / 8);
            }
        }
        // Blend pending stick intent into forward estimate.
        const pitch = Number(live.pendingPitch || 0);
        const yaw = Number(live.pendingYaw || 0);
        if ((Math.abs(pitch) > 0.02 || Math.abs(yaw) > 0.02) && enemyForward) {
            const intent = enemyForward.clone().normalize();
            intent.y += this.clamp(-pitch * 0.35, -0.45, 0.45);
            intent.x += this.clamp(yaw * 0.35, -0.45, 0.45);
            if (intent.lengthSq() > 0.0001) intent.normalize();
            return intent.multiplyScalar(fallbackStep * 18);
        }
        return fallback;
    },

    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    },

    // When target is mostly above/behind, localX≈0 makes joyX≈0 and the AI only climbs.
    resolveTurnJoyX(horizontalBias, localToEnemy, angleDeg, breakSide = 1, minAuth = 0.55) {
        let joyX = this.clamp(horizontalBias, -1, 1);
        const behind = localToEnemy && localToEnemy.z < 0.15;
        const offBoresight = angleDeg > 40;
        if (offBoresight && Math.abs(joyX) < minAuth) {
            const side = Math.sign((localToEnemy && localToEnemy.x) || 0) || Math.sign(breakSide) || 1;
            // localX is left/right in body frame; joyX uses opposite sign via horizontalBias=-localX.
            const turnSign = localToEnemy && Math.abs(localToEnemy.x) > 0.08
                ? -Math.sign(localToEnemy.x)
                : side;
            joyX = turnSign * (behind || angleDeg > 90 ? Math.max(minAuth, 0.88) : minAuth);
        }
        return this.clamp(joyX, -1, 1);
    },

    /**
     * Clear contact + open LOS: nose-on before power.
     * Prevents AB/climb while staring at sky or broadside (snapshot T16: fwdY≈0.9, ang≈80°).
     */
    wantsAlignBeforeAccel(ctx = {}) {
        if (!ctx.seenNow || ctx.lineOfSightBlocked) return false;
        if (ctx.actualMissileThreat || ctx.imminentBuildingHit || ctx.groundRisk) return false;
        if (ctx.energyCritical || ctx.stalled || ctx.imminentGroundImpact) return false;
        if (ctx.collisionRisk === 'high' && Number(ctx.coverForwardDistance) < 16) return false;
        const altitude = Number(ctx.altitude);
        const forwardY = Number(ctx.forwardY || 0);
        const lane = String(ctx.altitudeLane || '');
        // T40: combat-lane fox2 align while near-vertical dive (fwdY≪0) into facades — refuse any lane.
        if (forwardY < -0.35) return false;
        // T66/T92: after partial recover, alignFirst re-banks into canyon sink.
        if (Number.isFinite(altitude) && altitude < 48 && forwardY < -0.12) return false;
        if ((lane === 'dirt' || lane === 'canyon') && forwardY < -0.08) return false;
        if ((lane === 'dirt' || lane === 'canyon') && Number.isFinite(altitude) && altitude < 36) return false;
        if (ctx.postGroundRecovery || ctx.lowAltRecover) return false;
        const angleDeg = Number(ctx.angleDeg || 0);
        const localZ = Number(ctx.localZ);
        const steep = forwardY > 0.38;
        if (steep && (angleDeg > 28 || !(Number.isFinite(localZ)) || localZ < 0.55)) return true;
        return angleDeg > 38 || (Number.isFinite(localZ) && localZ < 0.42);
    },

    buildAlignBeforeAccelControls(ctx = {}) {
        const angleDeg = Number(ctx.angleDeg || 0);
        const local = ctx.localToEnemy || { x: 0, y: 0, z: 1 };
        const fwdY = Number(ctx.forwardY || 0);
        const altitude = Number(ctx.altitude || 50);
        const breakSide = ctx.breakSide || 1;
        const openSoft =
            ctx.collisionRisk === 'low' ||
            ctx.openSkyAlign === true ||
            (Number.isFinite(Number(ctx.coverForwardDistance)) &&
                Number(ctx.coverForwardDistance) <= 0 &&
                ctx.collisionRisk !== 'high');
        const baseHx = typeof ctx.baseHorizontalBias === 'number'
            ? ctx.baseHorizontalBias
            : this.clamp(-(local.x || 0) * 1.25, -1, 1);
        // Open / soft cover: shallow bank + speed (player doctrine). Hard joyX+thr2 = slow serpentine.
        const turnCap = openSoft ? (angleDeg > 70 ? 0.58 : 0.48) : 0.95;
        const hxScale = openSoft ? 1.05 : 1.55;
        const joyX = this.clamp(
            this.resolveTurnJoyX(baseHx * hxScale, local, angleDeg, breakSide, turnCap),
            -turnCap,
            turnCap
        );
        let joyY = this.clamp((local.y || 0) * 0.32, -0.35, 0.35);
        let alignJoyX = joyX;
        // Unload balloon climb first — body-frame localY is unreliable when nearly vertical.
        if (fwdY > 0.28) {
            joyY = Math.min(joyY, -0.28 - Math.min(0.55, (fwdY - 0.28) * 1.15));
        } else if (fwdY < -0.28) {
            // T40: if align still runs while diving, force real level-off (was joyY≈0.12 + hard bank).
            const divePull = fwdY < -0.55 ? 0.55 : (fwdY < -0.4 ? 0.38 : 0.22);
            joyY = Math.max(joyY, divePull);
            alignJoyX = this.clamp(alignJoyX, -0.32, 0.32);
        }
        if (altitude > 48 && joyY > 0.06 && fwdY >= -0.28) joyY = Math.min(joyY, 0.06);
        if (openSoft && joyY < -0.12) joyY = Math.max(joyY, -0.12);
        // Keep MIL/ECO speed while aligning in the open — thr2 hard bank is the snake circle.
        const throttle = openSoft
            ? (angleDeg > 80 ? 3 : 4)
            : ((angleDeg > 55 || fwdY > 0.45) ? 2 : 3);
        return {
            joyX: this.clamp(alignJoyX, -1, 1),
            joyY: this.clamp(joyY, -0.75, fwdY < -0.28 ? 0.62 : 0.42),
            roll: this.clamp(alignJoyX * Math.PI / (openSoft ? 5 : 3.2), -Math.PI / 3.2, Math.PI / 3.2),
            throttle
        };
    },

    // AB (5) cuts turn rate; steep dives need MIL/ECO throttle for pitch authority.
    getEmergencyRecoveryThrottle(altitude, forwardY, heat = 0) {
        const steepDive = forwardY < -0.45;
        const diving = forwardY < -0.2;
        if (steepDive) return altitude < 10 ? (heat > 70 ? 4 : 3) : 3;
        if (diving && altitude < 35) return heat > 78 ? 4 : 4;
        return altitude < 8 ? 5 : 5;
    },

    /**
     * Phase A: map turn demand → max throttle (physics turnLimit: AB0.4 / MIL0.7 / ECO0.85 / IDL1.0).
     * Never raises throttle; only caps so hard turns keep authority.
     * T50: soft urban must not sit at thr3 forever (stall precursor / sitting duck vs human).
     * Hard ECO only when opts.hardBuilding (imminent smash) or extreme stick.
     */
    pickThrottleForTurn(requestedThrottle, joyX, opts = {}) {
        let thr = Math.max(1, Math.min(5, Math.round(Number(requestedThrottle) || 4)));
        const turnAuth = Math.abs(Number(joyX) || 0);
        const heat = Number(opts.heat || 0);
        const ap = Number(opts.ap);
        const energyTight = (Number.isFinite(ap) && ap < Number(opts.lowAp || 65))
            || !!opts.energyCritical
            || !!opts.stalled;
        const hardBuilding = !!opts.hardBuilding;
        let maxThr = 5;
        if (hardBuilding) {
            // Imminent building smash: keep turn authority (old aggressive ECO).
            if (turnAuth >= 0.55 || (energyTight && turnAuth >= 0.28)) maxThr = 3;
            else if (turnAuth >= 0.38) maxThr = 4;
            else if (energyTight && turnAuth >= 0.15) maxThr = 4;
        } else {
            // Soft weave / combat: thr4 at moderate turn; thr3 only on very hard stick or energy-tight turn.
            if (turnAuth >= 0.82 || (energyTight && turnAuth >= 0.55)) maxThr = 3;
            else if (turnAuth >= 0.5 || (energyTight && turnAuth >= 0.28)) maxThr = 4;
            else if (energyTight && turnAuth >= 0.15) maxThr = 4;
        }
        // Heat already blocks AB often; keep MIL when hot + turning.
        if (heat > 78 && maxThr >= 5) maxThr = 4;
        if (heat > 86 && maxThr >= 4) maxThr = 3;
        return Math.min(thr, maxThr);
    },

    /** Hard survival: keep AB/MIL for ground smash / post-ground climb / stall breakout. */
    isHardEnergyExemptState(state) {
        const s = String(state || '');
        return (
            s === 'emergencyPullUp' ||
            s === 'emergencyRecoverLock' ||
            s === 'postGroundClimbOut' ||
            s === 'terrainEscape' ||
            s === 'groundAvoid' ||
            s === 'wingmanPullUp' ||
            s.indexOf('safetyStall') === 0
        );
    },

    /** Soft obstacle escapes — gated when stalled / AP-critical (H6 / T51). */
    isSoftObstacleEscapeState(state) {
        const s = String(state || '');
        return (
            s === 'obstacleEmergencyEscape' ||
            s === 'obstacleEnergyClimb' ||
            s.indexOf('safetyObstacle') === 0
        );
    },

    /** Dive-level / dirt-floor sticks must not be joyY-capped as "climb into mesh". */
    isDiveLevelPullAction(action) {
        if (!action || typeof action !== 'object') return false;
        if (action.diveLevelPull || action.dirtPullFloor || action.groundPull) return true;
        const reason = String(action.reason || '');
        const status = String(action.statusText || '');
        return (
            reason.indexOf('pull level') >= 0 ||
            reason.indexOf('face-dive') >= 0 ||
            reason.indexOf('dirt pull') >= 0 ||
            status.indexOf('俯衝改平') >= 0 ||
            status.indexOf('近地嵌樓側拉') >= 0 ||
            status.indexOf('街谷俯衝改平') >= 0
        );
    },

    /**
     * Embed joyY band: mesh ceiling vs dirt floor vs dive-level pull.
     * Mode-aware so decide divePull is not soft-capped to ~0.22 (T42).
     */
    getEmbedJoyYBand(altNow, teamForwardY, action) {
        if (this.isDiveLevelPullAction(action)) {
            const maxY = altNow < 12 ? 0.88 : 0.72;
            const minY = altNow < 3
                ? (teamForwardY < -0.35 ? 0.62 : 0.5)
                : (teamForwardY < -0.55 ? (altNow < 22 ? 0.48 : 0.42) : null);
            return { maxY, minY };
        }
        const reason = String((action && action.reason) || '');
        const mode = String((action && action.mode) || (action && action.state) || '');
        // T25 mandatory climb: do not soft-cap joyY down to lateral thrash band.
        if (
            mode.indexOf('mandatoryClimb') >= 0 ||
            reason.indexOf('mandatory climb') >= 0 ||
            reason.indexOf('低空強制爬升') >= 0
        ) {
            const floor = this.getMandatoryClimbJoyY(altNow);
            return { maxY: Math.max(0.78, floor + 0.1), minY: floor };
        }
        const maxY = altNow < 3
            ? (teamForwardY < -0.35 ? 0.78 : 0.62)
            : (altNow < 8
                ? (teamForwardY < -0.35 ? 0.62 : 0.52)
                : (altNow < 12
                    ? (teamForwardY < -0.35 ? 0.48 : 0.32)
                    : (teamForwardY < -0.35 ? 0.22 : 0.12)));
        const minY = altNow < 3 ? (teamForwardY < -0.35 ? 0.62 : 0.5) : null;
        return { maxY, minY };
    },

    applyEmbedJoyYBand(action, altNow, teamForwardY) {
        if (!action || typeof action.joyY !== 'number') return action;
        const band = this.getEmbedJoyYBand(altNow, teamForwardY, action);
        if (!band) return action;
        if (action.joyY > band.maxY) action.joyY = band.maxY;
        if (band.minY != null && action.joyY < band.minY) action.joyY = band.minY;
        return action;
    },

    /**
     * Hard obstacleEmergencyEscape sticks — same doctrine as urbanEmbedPushOut score bias.
     * Priority (never invert): diveFacade/divePull > noseUnload > steepInto > embedDivePull >
     * mandatoryClimb (>floor) > embedPush thr4 > roofExit > hardLateral.
     * Conflict rules:
     * - diveLevelPull keeps high joyY (not joyY-capped as climb-into-mesh).
     * - embed keeps |joyX|≤0.52 so thr4 is possible (no thr3 ±0.66 snake).
     * - dirt composite / midair yield remain caller-owned (alt<8 defer, tryCloseMidairBreak).
     * - under-roof glue still lateral-first; mandatoryClimb only when sky clear.
     */
    resolveUrbanHardEscapeStick(opts = {}) {
        const side = Math.sign(Number(opts.side) || 0) || 1;
        const altitude = Number(opts.altitude);
        const forwardY = Number(opts.forwardY) || 0;
        const alt = Number.isFinite(altitude) ? altitude : 40;
        const embedNow = !!opts.embedNow;
        const deepEmbed = !!opts.deepEmbed;
        const underRoof = !!opts.underRoof;
        const diveIntoFacade = !!opts.diveIntoFacade;
        const divingAtBldg = !!opts.divingAtBldg;
        const steepFaceDive = !!opts.steepFaceDive;
        const steepIntoBldg = !!opts.steepIntoBldg;
        const hardContact = !!opts.hardContact;
        const roofExitNow = !!opts.roofExitNow;
        const climbJoyY = Number(opts.climbJoyY);
        const tightEscape = !!opts.tightEscape;
        const lowAltitudeEscape = !!opts.lowAltitudeEscape;
        const lowEnergyEscape = !!opts.lowEnergyEscape;
        const climbTowardRoof = !!opts.climbTowardRoof;
        const energyCritical = !!opts.energyCritical;
        const heat = Number(opts.heat) || 0;
        const flareWhileEscape = !!opts.flareWhileEscape;
        const mandatoryClimb = !!opts.mandatoryClimb || this.wantsMandatoryClimb(alt, {
            roofClearance: opts.roofClearance,
            headroom: opts.headroom
        }, { underRoof, steepIntoBldg });
        const climbFloorY = Number.isFinite(climbJoyY)
            ? Math.max(climbJoyY, this.getMandatoryClimbJoyY(alt, forwardY))
            : this.getMandatoryClimbJoyY(alt, forwardY);

        const diveFirst =
            divingAtBldg && (!embedNow || steepFaceDive || diveIntoFacade || forwardY < -0.55);
        // Once nose is near level below the floor, stop dive-pull thrash and climb (T35/T70 spiral).
        const diveOwnsStick = diveFirst && !(mandatoryClimb && forwardY > -0.5);

        // T66/T53: under-roof hardLock with joyY≈0.1–0.5 while alt<14 still dug into dirt.
        // Near-dirt nose-down always levels first; lateral only after the nose rises.
        if (alt < 14 && forwardY < -0.15 && (embedNow || underRoof || deepEmbed || hardContact || divingAtBldg)) {
            const joyY = alt < 6 ? 0.92 : (alt < 10 ? 0.82 : 0.72);
            // T61 dirt: |joyX|≈0.48 while fwdY≪0 stole the pull — keep bank soft.
            const bank = forwardY < -0.55
                ? (alt < 8 ? 0.18 : 0.22)
                : (mandatoryClimb ? (alt < 8 ? 0.2 : 0.24) : (alt < 8 ? 0.28 : 0.36));
            return {
                mode: 'dirtEmbedPull',
                joyX: this.clamp(side * bank, -0.4, 0.4),
                joyY,
                throttle: energyCritical || heat > 86 ? 3 : 4,
                pitchScale: 0.78,
                rollAuth: Math.PI / 12,
                diveLevelPull: true,
                dirtPullFloor: true,
                statusText: `NPC: 近地嵌樓拉起 ${opts.coverLabel || ''}`,
                reason: mandatoryClimb
                    ? 'Near-dirt: pull level then mandatory climb (soft bank)'
                    : 'Near-dirt embed/under-roof: pull level before lateral (do not low-climb into ground)'
            };
        }

        // T61/T40/T38: nose into slab — unload + strong thr4 lateral so we exit AABB (was joyX≤0.28 thrash).
        if (steepIntoBldg && !diveOwnsStick && (embedNow || underRoof || deepEmbed)) {
            const coverDist = Number(opts.coverDistance);
            const glued = deepEmbed || underRoof || (Number.isFinite(coverDist) && coverDist < 3);
            const unloadX = glued ? (deepEmbed || (Number.isFinite(coverDist) && coverDist < 1.5) ? 0.56 : 0.5) : 0.35;
            return {
                mode: 'noseUnload',
                joyX: this.clamp(side * unloadX, -0.58, 0.58),
                joyY: alt < 16 ? -0.08 : -0.14,
                throttle: energyCritical || heat > 82 ? 3 : 4,
                pitchScale: 0.1,
                rollAuth: Math.PI / 10,
                diveLevelPull: false,
                dirtPullFloor: alt < 5,
                statusText: `NPC: 嵌樓抬頭放平 ${opts.coverLabel || ''}`,
                reason: glued
                    ? 'T38 glued nose-high: unload + strong thr4 lateral exit (no climb into slab)'
                    : 'Deep embed nose-high: unload + thr4 lateral (no climb into slab)'
            };
        }

        if (steepIntoBldg && !diveOwnsStick) {
            return {
                mode: 'steepInto',
                joyX: this.clamp(side * 0.35, -0.38, 0.38),
                joyY: 0.06,
                throttle: energyCritical || heat > 82 ? 3 : 4,
                pitchScale: 0.18,
                rollAuth: Math.PI / 12,
                diveLevelPull: false,
                dirtPullFloor: alt < 5,
                statusText: `NPC: 建築緊急脫離 ${opts.coverLabel || ''}`,
                reason: 'Hard building contact: nose into slab — lateral only, no climb'
            };
        }

        if (diveOwnsStick) {
            const coverDist = Number(opts.coverDistance);
            const gluedClose = Number.isFinite(coverDist) && coverDist < 4;
            const noseNearLevel = forwardY > -0.32;
            const riskHigh = opts.collisionRisk === 'high' || hardContact || embedNow || deepEmbed;
            // T61: endless "level out before lateral" while alt sank 20→2 — once nose recovers, climb.
            const sinkCascadeGate =
                (alt < 22 && forwardY > -0.55) ||
                (alt < 28 && noseNearLevel) ||
                (alt < 36 && noseNearLevel && riskHigh);
            if (sinkCascadeGate) {
                const climbY = alt < 12
                    ? 0.9
                    : (alt < 22 ? 0.82 : Math.max(climbFloorY, 0.68));
                return {
                    mode: 'diveAltGate',
                    joyX: this.clamp(side * (mandatoryClimb ? 0.22 : 0.28), -0.32, 0.32),
                    joyY: climbY,
                    throttle: energyCritical || heat > 86 ? 3 : 4,
                    pitchScale: 0.78,
                    rollAuth: Math.PI / 12,
                    diveLevelPull: forwardY < -0.2,
                    dirtPullFloor: alt < 8,
                    statusText: `NPC: 俯衝改平後爬升 ${opts.coverLabel || ''}`,
                    reason: 'Dive-level altitude gate: climb after nose near-level (stop sink cascade)'
                };
            }
            // T61 red: cover≈1.5m + diveFacade leveled into the wall — break glue laterally first.
            if (gluedClose && diveIntoFacade && alt >= 24) {
                return {
                    mode: 'diveGlueBreak',
                    joyX: this.clamp(side * 0.52, -0.55, 0.55),
                    joyY: forwardY < -0.45 ? 0.55 : (forwardY < -0.2 ? 0.28 : 0.08),
                    throttle: energyCritical || heat > 82 ? 3 : 4,
                    pitchScale: forwardY < -0.45 ? 0.55 : 0.28,
                    rollAuth: Math.PI / 10,
                    diveLevelPull: forwardY < -0.35,
                    dirtPullFloor: alt < 8,
                    statusText: `NPC: 貼牆俯衝側破 ${opts.coverLabel || ''}`,
                    reason: 'Dive into glued facade: lateral break before level-out into wall'
                };
            }
            // T40: near-vertical (fwdY≪-0.85) mid-alt divePull was only joyY=0.52 — not enough.
            let joyY = diveIntoFacade
                ? (alt < 28 ? 0.88 : (alt < 40 ? 0.78 : 0.62))
                : (alt < 16 ? 0.82 : (alt < 28 ? 0.68 : 0.52));
            if (forwardY < -0.85) joyY = Math.max(joyY, alt < 48 ? 0.88 : 0.78);
            else if (forwardY < -0.7) joyY = Math.max(joyY, alt < 48 ? 0.78 : 0.68);
            // T150 blue2: open gap on one side but divePull bank≤0.28 (±0.32) flew into near wall.
            const gapAsym = this.getCorridorGapAsymmetry({
                corridorLeftClear: opts.corridorLeftClear,
                corridorRightClear: opts.corridorRightClear,
                corridorClear: opts.corridorClear,
                corridorGap: opts.corridorGap
            });
            const cutSide = (gapAsym.strength >= 1 && gapAsym.side) ? gapAsym.side : side;
            const needHardCut =
                hardContact ||
                embedNow ||
                deepEmbed ||
                gapAsym.strength >= 1 ||
                gluedClose ||
                (Number.isFinite(coverDist) && coverDist < 10);
            let bank = mandatoryClimb ? 0.18 : (diveIntoFacade ? 0.26 : 0.28);
            if (needHardCut) {
                bank = gapAsym.strength >= 2
                    ? 0.52
                    : (diveIntoFacade || hardContact || gluedClose ? 0.48 : 0.42);
            }
            return {
                mode: diveIntoFacade ? 'diveFacade' : 'divePull',
                joyX: this.clamp(cutSide * bank, needHardCut ? -0.55 : -0.32, needHardCut ? 0.55 : 0.32),
                joyY,
                throttle: energyCritical || heat > 86 ? 3 : 4,
                pitchScale: diveIntoFacade || forwardY < -0.7 ? 0.82 : 0.65,
                rollAuth: Math.PI / 12,
                diveLevelPull: true,
                dirtPullFloor: alt < 8 && (embedNow || hardContact),
                statusText: diveIntoFacade
                    ? `NPC: 俯衝立面改平 ${opts.coverLabel || ''}`
                    : `NPC: 俯衝改平脫離 ${opts.coverLabel || ''}`,
                reason: diveIntoFacade
                    ? 'Steep dive into closing facade: level out before lateral'
                    : (needHardCut
                        ? 'Steep face-dive: pull level + gap/open-side cut'
                        : 'Steep face-dive into building: pull level then lateral')
            };
        }

        // T41: embed + steep nose — level before thr4 lateral (do not thrash while fwdY≪0).
        if ((embedNow || underRoof || deepEmbed) && forwardY < -0.55 && !mandatoryClimb) {
            return {
                mode: 'embedDivePull',
                joyX: this.clamp(side * 0.26, -0.3, 0.3),
                joyY: alt < 14 ? 0.85 : (alt < 24 ? 0.72 : 0.58),
                throttle: energyCritical || heat > 82 ? 3 : 4,
                pitchScale: 0.7,
                rollAuth: Math.PI / 12,
                diveLevelPull: true,
                dirtPullFloor: alt < 8,
                statusText: `NPC: 嵌樓俯衝改平 ${opts.coverLabel || ''}`,
                reason: 'Embed steep dive: level nose before thr4 lateral push'
            };
        }

        // T25/T35: below mandatoryClimbAlt — climb out of canyon (not flat-bank forever).
        // Only blocked by true under-roof / nose-into-slab (not dense-urban headroom).
        if (mandatoryClimb && !diveOwnsStick && !steepIntoBldg) {
            return {
                mode: 'mandatoryClimb',
                joyX: this.clamp(side * (hardContact || embedNow ? 0.28 : 0.22), -0.34, 0.34),
                joyY: climbFloorY,
                throttle: energyCritical || heat > 82 || lowEnergyEscape ? 3 : 4,
                pitchScale: 0.58,
                rollAuth: Math.PI / 12,
                diveLevelPull: forwardY < -0.2,
                dirtPullFloor: alt < 5,
                statusText: `NPC: 低空強制爬升 ${opts.coverLabel || ''}`,
                reason: 'T35 mandatory climb below floor: climb out of canyon (not under slab)'
            };
        }

        if (embedNow || underRoof) {
            const coverDist = Number(opts.coverDistance);
            const roofClear = Number(opts.roofClearance);
            const glued =
                deepEmbed ||
                (Number.isFinite(coverDist) && coverDist < 3) ||
                (Number.isFinite(roofClear) && roofClear < 0);
            const noseHigh = forwardY > 0.22;
            const noseDown = forwardY < -0.35;
            const steepNose = forwardY < -0.55;
            const mildDescend = forwardY < -0.2;

            // T38: glued under roof / cd≈0 — horizontal AABB exit first. Never climb into slab.
            // When a corridor/gap is still flyable, keep a climb floor — flat joyY≈0 was dump death (T50).
            const gapOpen = !!opts.gapOpen || this.isFlyableCorridorGap({
                corridorClear: opts.corridorClear,
                corridorGap: opts.corridorGap,
                roofClearance: opts.roofClearance
            }, { underRoof });
            if (glued && noseHigh) {
                return {
                    mode: 'noseUnload',
                    joyX: this.clamp(side * (deepEmbed || coverDist < 1.5 ? 0.56 : 0.5), -0.58, 0.58),
                    joyY: gapOpen ? (alt < 22 ? 0.22 : 0.12) : (alt < 16 ? -0.08 : -0.14),
                    throttle: energyCritical || heat > 82 || lowEnergyEscape ? 3 : 4,
                    pitchScale: gapOpen ? 0.22 : 0.1,
                    rollAuth: Math.PI / 10,
                    diveLevelPull: false,
                    dirtPullFloor: alt < 5,
                    statusText: 'NPC: 嵌樓抬頭側推 ' + (opts.coverLabel || ''),
                    reason: gapOpen
                        ? 'T38 gap-open: unload lateral + climb floor (no flat glue)'
                        : 'T38 glued under-roof: unload + strong lateral exit (no slab climb)'
                };
            }
            if (glued && !noseDown) {
                const auth = (Number.isFinite(coverDist) && coverDist < 1.5) || deepEmbed ? 0.58 : 0.52;
                const flatY = mildDescend ? (alt < 16 ? 0.18 : 0.1) : (alt < 10 ? 0.06 : 0.02);
                const gapY = mildDescend
                    ? (alt < 16 ? 0.36 : 0.28)
                    : (alt < 22 ? 0.22 : 0.14);
                return {
                    mode: deepEmbed ? 'embedFlip' : (gapOpen ? 'embedGapPush' : 'embedPush'),
                    joyX: this.clamp(side * auth, -0.62, 0.62),
                    joyY: gapOpen ? gapY : flatY,
                    throttle: energyCritical || heat > 82 || lowEnergyEscape ? 3 : 4,
                    pitchScale: gapOpen ? (mildDescend ? 0.36 : 0.2) : (mildDescend ? 0.22 : 0.06),
                    rollAuth: Math.PI / 10,
                    diveLevelPull: !!mildDescend && alt < 20,
                    dirtPullFloor: alt < 5,
                    statusText: deepEmbed
                        ? ('NPC: 嵌樓反側推出 ' + (opts.coverLabel || ''))
                        : ('NPC: 嵌樓側推脫離 ' + (opts.coverLabel || '')),
                    reason: gapOpen
                        ? 'T38 gap-open: thr4 lateral + climb floor (no flat glue)'
                        : 'T38 glued mesh: sustained thr4 horizontal push-out (climb only after clear)'
                };
            }

            const joyY = steepNose
                ? (alt < 14 ? 0.72 : (alt < 22 ? 0.58 : 0.42))
                : (noseDown
                    ? (alt < 14 ? 0.55 : (alt < 22 ? 0.4 : 0.28))
                    : (mildDescend
                        ? (alt < 16 ? 0.36 : 0.22)
                        : (alt < 12 ? 0.16 : 0.08)));
            let auth = (noseDown || mildDescend)
                ? (deepEmbed ? 0.48 : 0.42)
                : (deepEmbed ? 0.55 : 0.5);
            if (Number.isFinite(roofClear) && roofClear < -2 && alt < 40) {
                auth = Math.min(0.62, auth + 0.08);
            }
            return {
                mode: deepEmbed ? 'embedFlip' : 'embedPush',
                joyX: this.clamp(side * auth, -0.62, 0.62),
                joyY,
                throttle: energyCritical || heat > 82 || lowEnergyEscape ? 3 : 4,
                pitchScale: steepNose ? 0.52 : (noseDown || mildDescend ? 0.36 : 0.12),
                rollAuth: Math.PI / 10,
                diveLevelPull: !!(noseDown || (mildDescend && alt < 20)),
                dirtPullFloor: alt < 5,
                statusText: deepEmbed
                    ? ('NPC: 嵌樓反側推出 ' + (opts.coverLabel || ''))
                    : ('NPC: 嵌樓側推脫離 ' + (opts.coverLabel || '')),
                reason: deepEmbed
                    ? 'Deep embed: preferred-side thr4 push-out (AABB/flip already on side)'
                    : (mildDescend
                        ? 'Embed/under-roof: thr4 lateral + level while descending'
                        : 'Embed/under-roof: sustained thr4 lateral push-out, low climb')
            };
        }
        if (roofExitNow || mandatoryClimb) {
            return {
                mode: mandatoryClimb ? 'mandatoryClimb' : 'roofLane',
                joyX: this.clamp(side * (tightEscape ? (mandatoryClimb ? 0.32 : 0.55) : (mandatoryClimb ? 0.28 : 0.42)), -0.7, 0.7),
                joyY: mandatoryClimb
                    ? climbFloorY
                    : (Number.isFinite(climbJoyY) ? climbJoyY : (alt < 36 ? 0.48 : 0.36)),
                throttle: lowEnergyEscape ? 3 : (heat > 76 ? 4 : 5),
                pitchScale: mandatoryClimb ? 0.55 : 0.48,
                rollAuth: Math.PI / 10,
                diveLevelPull: !!mandatoryClimb && forwardY < -0.2,
                dirtPullFloor: !!mandatoryClimb && alt < 5,
                statusText: mandatoryClimb
                    ? `NPC: 低空強制爬升 ${opts.coverLabel || ''}`
                    : `NPC: 街谷爬升脫離 ${opts.coverLabel || ''}`,
                reason: mandatoryClimb
                    ? 'T25 mandatory climb below floor: climb out of canyon (sky clear)'
                    : 'Canyon lane: climb toward rooftop instead of hard side thrash'
            };
        }

        const hardAuth = hardContact
            ? (tightEscape ? 0.55 : 0.5)
            : (lowEnergyEscape ? 0.52 : (tightEscape ? 0.62 : 0.55));
        const joyY = hardContact
            ? 0.14
            : (lowAltitudeEscape
                ? 0.28
                : (lowEnergyEscape ? 0.2 : (climbTowardRoof ? 0.22 : 0.16)));
        return {
            mode: hardContact ? 'hardLateral' : (lowEnergyEscape ? 'energyClimb' : 'softEscape'),
            joyX: this.clamp(side * hardAuth, -0.7, 0.7),
            joyY,
            throttle: flareWhileEscape
                ? (heat > 76 ? 3 : 4)
                : (lowEnergyEscape
                    ? 3
                    : (lowAltitudeEscape
                        ? (heat > 72 ? 4 : 5)
                        : (heat > 76 ? 3 : 4))),
            pitchScale: hardContact
                ? 0.16
                : (lowAltitudeEscape ? 0.28 : (lowEnergyEscape ? 0.24 : 0.28)),
            rollAuth: lowEnergyEscape || hardContact ? Math.PI / 10 : Math.PI / 6,
            diveLevelPull: false,
            dirtPullFloor: !!(alt < 5 && hardContact),
            statusText: `NPC: 建築緊急脫離 ${opts.coverLabel || ''}`,
            reason: hardContact
                ? 'Hard building contact: thr4-band lateral around-building abort'
                : 'Obstacle escape prioritizes lateral around-building route'
        };
    },

    /**
     * Closing facade / short forward clearance: never keep near-zero bank (T76 blue dead-center).
     * Mutates action joyX toward preferredSide when too weak.
     */
    enforceFacadeLateralFloor(action, coverInfo = {}, preferredSide = 1) {
        if (!action) return action;
        const fwd = Number(coverInfo.forwardDistance);
        const dist = Number(coverInfo.distance);
        const risk = coverInfo.collisionRisk;
        const closing =
            this.isFacadeClosingScore(coverInfo) ||
            (Number.isFinite(fwd) && fwd > 0 && fwd < 24) ||
            (Number.isFinite(dist) && dist < 22 && risk !== 'low') ||
            (risk === 'high' && Number.isFinite(dist) && dist < 28);
        if (!closing) return action;
        const side = Math.sign(Number(action.joyX) || 0) || Math.sign(preferredSide) || 1;
        const minAuth =
            (Number.isFinite(fwd) && fwd < 10) || (Number.isFinite(dist) && dist < 10)
                ? 0.5
                : ((Number.isFinite(fwd) && fwd < 18) || (Number.isFinite(dist) && dist < 16)
                    ? 0.42
                    : 0.36);
        if (Math.abs(Number(action.joyX) || 0) < minAuth) {
            action.joyX = this.clamp(side * minAuth, -0.58, 0.58);
            if (!action.debug) action.debug = {};
            action.debug.facadeLateralFloor = minAuth;
        }
        return action;
    },

    /**
     * Short-horizon scored escape (±side / climb / level) — prefer route quality over T38 flat glue.
     * Returns null when true undercroft glue should keep hard lateral, or when sim unavailable.
     */
    pickScoredUrbanEscapeStick(teamId, opts = {}) {
        const trueUnder = !!opts.trueUnderRoof || this.isTrueUnderRoof({
            roofClearance: opts.roofClearance,
            distance: opts.coverDistance,
            headroom: opts.headroom
        }, { hardContact: opts.hardContact });
        const dist = Number(opts.coverDistance);
        // Real glue: keep dedicated T38/hard stick — scoring thrash wastes the exit window.
        if (trueUnder && Number.isFinite(dist) && dist < 6) return null;
        if (opts.diveOwnsStick && Number(opts.forwardY) < -0.65 && Number(opts.altitude) < 28) return null;

        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam)
            ? GameContext.getTeam(teamId)
            : null;
        if (!team || !team.wrapper || typeof simulateFlight !== 'function') return null;

        const coverInfo = opts.coverInfo || {};
        const gapAsym = this.getCorridorGapAsymmetry(coverInfo);
        const gapSide = gapAsym.side || this.getCorridorGapSide(coverInfo);
        // One-sided open street: prefer gap over memory side (T150 red2 L≪R).
        const memSide = Math.sign(Number(opts.side) || 0) || 1;
        const side = (gapAsym.strength >= 1 && gapSide) ? gapSide : memSide;
        const alt = Number.isFinite(Number(opts.altitude)) ? Number(opts.altitude) : 40;
        const forwardY = Number(opts.forwardY) || 0;
        const heat = Number(opts.heat) || 0;
        const thr = opts.energyCritical || heat > 82 || opts.lowEnergyEscape ? 3 : 4;
        const fwd = Number(coverInfo.forwardDistance);
        const facadeClosing =
            this.isFacadeClosingScore(coverInfo) ||
            (Number.isFinite(fwd) && fwd > 0 && fwd < 22) ||
            (Number.isFinite(dist) && dist < 20 && coverInfo.collisionRisk !== 'low');
        const fwdTight =
            (Number.isFinite(fwd) && fwd > 0 && fwd < 12) ||
            (Number.isFinite(dist) && dist < 8);
        const climbFloor = forwardY < -0.45
            ? (alt < 22 ? 0.58 : 0.48)
            : (forwardY < -0.2 ? (alt < 28 ? 0.42 : 0.32) : (alt < 28 ? 0.22 : 0.14));
        const sideAuth = facadeClosing ? (gapAsym.strength >= 2 ? 0.55 : 0.52) : 0.48;
        const climbAuth = facadeClosing ? (fwdTight ? 0.36 : 0.42) : 0.28;
        const base = {
            state: 'obstacleEmergencyEscape',
            weapon: 'gun',
            queueAction: 'none',
            ready: true
        };
        const prototypes = [];
        if (gapAsym.strength >= 1 && gapSide) {
            prototypes.push({
                mode: 'scoreGapCut',
                branch: 'gapCut',
                joyX: this.clamp(gapSide * (facadeClosing ? 0.55 : 0.5), -0.58, 0.58),
                joyY: Math.max(climbFloor, facadeClosing || forwardY < -0.25 ? 0.48 : climbFloor),
                reason: 'Scored escape: gap-open side cut'
            });
        }
        prototypes.push(
            {
                mode: 'scoreSide',
                branch: 'side',
                joyX: this.clamp(side * sideAuth, -0.55, 0.55),
                joyY: climbFloor,
                reason: 'Scored escape: preferred-side hold + climb floor'
            },
            {
                mode: 'scoreOpp',
                branch: 'flip',
                joyX: this.clamp(-side * sideAuth, -0.55, 0.55),
                joyY: climbFloor,
                reason: 'Scored escape: opposite-side cut + climb floor'
            },
            {
                mode: 'scoreClimb',
                branch: 'climb',
                joyX: this.clamp(side * climbAuth, -0.48, 0.48),
                joyY: Math.max(climbFloor, alt < 36 ? 0.52 : 0.4),
                reason: 'Scored escape: climb-biased exit'
            },
            {
                mode: 'scoreLevel',
                branch: 'level',
                joyX: this.clamp(side * (facadeClosing ? 0.48 : 0.36), -0.52, 0.52),
                joyY: Math.max(climbFloor * 0.9, alt < 28 ? 0.36 : 0.24),
                reason: 'Scored escape: level-hold exit'
            }
        );

        const horizon = 3;
        let best = null;
        let bestScore = -Infinity;
        let hitCount = 0;
        let scoredCount = 0;
        for (let i = 0; i < prototypes.length; i++) {
            const proto = prototypes[i];
            const candidate = {
                ...base,
                throttle: thr,
                joyX: proto.joyX,
                joyY: proto.joyY,
                roll: this.clamp(proto.joyX * Math.PI / 10, -Math.PI / 10, Math.PI / 10),
                diveLevelPull: forwardY < -0.25,
                reason: proto.reason
            };
            const conts = this.buildLinearRouteContinuations(
                base,
                candidate,
                team,
                alt,
                !!opts.energyCritical || !!opts.lowEnergyEscape,
                { coverInfo },
                horizon
            );
            const ev = this.evaluateActionSafety(teamId, candidate, conts);
            if (!ev) continue;
            scoredCount += 1;
            let score = Number(ev.score) || 0;
            if (ev.buildingHit) {
                hitCount += 1;
                score -= facadeClosing ? (fwdTight ? 140 : 110) : 55;
            }
            const sx = Math.sign(Number(proto.joyX) || 0) || 0;
            // Closing face: lateral cut > climb-into-wall (T76 blue scoreClimb hit).
            if (facadeClosing) {
                if (proto.branch === 'side' || proto.branch === 'flip' || proto.branch === 'gapCut') score += 36;
                if (proto.branch === 'climb') score -= fwdTight ? 85 : 55;
                if (Math.abs(proto.joyX) >= 0.45) score += 18;
            } else if (proto.branch === 'climb' && forwardY < -0.35) {
                score += 12;
            }
            // One-sided gap: open-side joyX wins; opposite / flip into wall loses (T150).
            if (gapAsym.strength >= 1 && gapSide && sx) {
                if (sx === gapSide) score += gapAsym.strength >= 2 ? 55 : 32;
                else if (sx === -gapSide) score -= gapAsym.strength >= 2 ? 75 : 42;
            }
            if (proto.branch === 'flip' && gapAsym.strength >= 2 && sx === -gapSide) score -= 40;
            if (proto.branch === 'flip' && opts.deepEmbed && gapAsym.strength < 1) score += 8;
            if (proto.branch === 'gapCut' && !ev.buildingHit) score += 20;
            if (score > bestScore) {
                bestScore = score;
                best = {
                    mode: proto.mode,
                    joyX: candidate.joyX,
                    joyY: candidate.joyY,
                    throttle: candidate.throttle,
                    pitchScale: forwardY < -0.35 ? 0.48 : 0.28,
                    rollAuth: Math.PI / 10,
                    diveLevelPull: !!candidate.diveLevelPull,
                    dirtPullFloor: alt < 5,
                    statusText: `NPC: 評分脫離(${proto.branch}) ${opts.coverLabel || ''}`,
                    reason: `${proto.reason} score=${score.toFixed(1)} hit=${ev.buildingHit ? 1 : 0} nb=${ev.nearestBuilding}`,
                    score: Number(score.toFixed(1)),
                    branch: proto.branch,
                    buildingHit: !!ev.buildingHit
                };
            }
        }
        if (best) {
            this.enforceFacadeLateralFloor(best, coverInfo, side);
            // All short-horizon options smash: gap-biased cut + pull, not memory thrash (T150).
            const allHit = scoredCount > 0 && hitCount >= scoredCount;
            if (best.buildingHit && bestScore < 0 && facadeClosing) {
                const cutSide = (gapAsym.strength >= 1 && gapSide) ? gapSide : side;
                best.joyX = this.clamp(cutSide * 0.55, -0.58, 0.58);
                best.joyY = Math.max(
                    Number(best.joyY) || 0,
                    Math.max(climbFloor, forwardY < -0.25 ? 0.52 : (fwdTight ? 0.42 : climbFloor))
                );
                best.diveLevelPull = best.diveLevelPull || forwardY < -0.2;
                best.mode = (gapAsym.strength >= 1 && gapSide) ? 'scoreGapForce' : 'scoreSideForce';
                best.branch = (gapAsym.strength >= 1 && gapSide) ? 'gapForce' : 'sideForce';
                best.reason = allHit || bestScore < -150
                    ? `Scored escape: all-hit — gap-side cut bias score=${bestScore.toFixed(1)}`
                    : `Scored escape: force lateral off closing facade score=${bestScore.toFixed(1)}`;
            }
        }
        return best;
    },

    /** @deprecated use isHardEnergyExemptState / isSoftObstacleEscapeState */
    isEnergyTurnExemptState(state) {
        return this.isHardEnergyExemptState(state) || this.isSoftObstacleEscapeState(state);
    },

    /**
     * Phase A exit gate: hard-turn actions cannot keep thr 4–5.
     * Soft obstacle escapes keep climb thr only when energy is healthy.
     * Mutates action in place; tags debug.energyTurn.
     */
    enforceEnergyTurnConsistency(action, ctx = {}) {
        if (!action || typeof action !== 'object') return action;
        if (this.isHardEnergyExemptState(action.state)) return action;

        const softEscape = this.isSoftObstacleEscapeState(action.state);
        const ap = Number(ctx.ap);
        const critFloor = Number(ctx.energyCriticalAp);
        const energyBad = !!ctx.energyCritical
            || !!ctx.stalled
            || (Number.isFinite(ap) && Number.isFinite(critFloor) && ap < critFloor)
            || (Number.isFinite(ap) && !Number.isFinite(critFloor) && ap < Number(ctx.lowAp || 52));

        // Soft escape with healthy energy: preserve requested thr.
        // Energy-bad soft escape always caps (even near ground) — T25 death spiral was thr5 climb at alt≈21.
        if (softEscape && !energyBad) return action;

        const before = Math.max(1, Math.min(5, Math.round(Number(action.throttle) || 4)));
        const joyX = Number(action.joyX) || 0;
        let after = this.pickThrottleForTurn(before, joyX, ctx);
        // T51/T25: stalled/critical soft escape must never AB/MIL-climb the energy death spiral.
        // Cap thr to ECO, but do not flatten dirt/dive pull joyY (T42 conflict).
        if (softEscape && energyBad) {
            after = Math.min(after, 3);
            const alt = Number(ctx.altitude);
            const keepPullJoyY =
                this.isDiveLevelPullAction(action) ||
                (Number.isFinite(alt) && alt < 5);
            const joyY = Number(action.joyY);
            if (!keepPullJoyY && Number.isFinite(joyY) && joyY > 0.22) {
                action.joyY = 0.22;
            }
        }
        if (after !== before) {
            action.throttle = after;
            if (!action.debug) action.debug = {};
            action.debug.energyTurn = {
                before,
                after,
                joyX: Number(joyX.toFixed(3)),
                softEscape: softEscape ? 1 : 0,
                reason: softEscape && energyBad
                    ? 'capSoftObstacleEscapeEnergy'
                    : (Math.abs(joyX) >= 0.38 ? 'capThrottleForTurnAuth' : 'capThrottleForEnergy')
            };
            if (Array.isArray(action.debug.tree)) {
                action.debug.tree.push(`energyTurnGate: thr ${before}->${after} |joyX|=${Math.abs(joyX).toFixed(2)}${softEscape && energyBad ? ' softEsc' : ''}`);
            }
            if (action.statusText && String(action.statusText).indexOf('ECO轉') < 0 && after <= 3 && (Math.abs(joyX) >= 0.38 || (softEscape && energyBad))) {
                action.statusText = `${action.statusText}｜ECO轉`;
            }
        }
        return action;
    },

    // Near midair merge while pulling up: keep climb, but bank away so both sides don't share one vertical track.
    getEmergencyPullUpLateral(ctx = {}) {
        const distance = Number(ctx.distance);
        const headOn = Number(ctx.headOnFactor);
        const localZ = ctx.localToEnemy ? Number(ctx.localToEnemy.z) : 0;
        const localX = ctx.localToEnemy ? Number(ctx.localToEnemy.x) : 0;
        const breakSide = Math.sign(ctx.breakSide || 1) || 1;
        const altitude = Number(ctx.altitude || 99);
        const steepDive = Number(ctx.forwardY) < -0.45;
        const closeMerge = Number.isFinite(distance) && distance > 0 && distance < 18;
        const nearMerge = Number.isFinite(distance) && distance > 0 && distance < 28;
        const enemyAhead = localZ > 0.25 || (Number.isFinite(headOn) && headOn > 0.28);
        if (!(closeMerge || (nearMerge && enemyAhead))) {
            return { joyX: 0, roll: 0, joyYScale: 1, active: false };
        }
        // Prefer opposite of enemy lateral so paths diverge; fall back to team break side.
        const side = Math.abs(localX) > 0.08 ? Math.sign(localX) : breakSide;
        // T66/T61: while steep diving or near dirt, keep bank mild so thr4 pitch authority wins.
        const dirtLow = altitude < 12;
        const auth = steepDive
            ? (dirtLow ? 0.28 : (closeMerge ? 0.32 : 0.28))
            : (dirtLow
                ? (closeMerge ? 0.32 : 0.28)
                : (closeMerge ? (altitude < 12 ? 0.42 : 0.62) : 0.38));
        const cap = (steepDive || dirtLow) ? 0.35 : 0.72;
        const joyX = this.clamp(side * auth, -cap, cap);
        return {
            joyX,
            roll: this.clamp(joyX * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5),
            joyYScale: closeMerge ? 0.88 : 0.94,
            active: true
        };
    },

    /**
     * Knife-range midair threat — eligibility only (no new force-command stack).
     * Soft band out to ~20m so groundAvoid / urban side thrash do not eat the merge.
     */
    isCloseMidairThreat(ctx = {}) {
        const distance = Number(ctx.distance);
        const predSep = Number(ctx.predictedSeparation);
        const headOn = Number(ctx.headOnFactor);
        const closure = Number(ctx.closureSpeed);
        const localZ = ctx.localToEnemy ? Number(ctx.localToEnemy.z) : null;
        if (!(Number.isFinite(distance) && distance > 0 && distance <= 20)) return false;
        // Knife glue: always break.
        if (distance <= 10) return true;
        // 10–20m: need closing / head-on — beam chase must not spam mergeBreak serpentine.
        const closingGeom =
            (Number.isFinite(headOn) && headOn >= 0.35) ||
            (Number.isFinite(closure) && closure > 0.1) ||
            (Number.isFinite(localZ) && localZ > 0.4) ||
            (Number.isFinite(predSep) && predSep <= distance * 0.85);
        if (!closingGeom) return false;
        if (Number.isFinite(predSep) && predSep <= 14) return true;
        if (Number.isFinite(headOn) && headOn >= 0.4 && distance <= 18) return true;
        if (Number.isFinite(closure) && closure > 0.1 && distance <= 18) return true;
        if (Number.isFinite(localZ) && localZ > 0.55 && distance <= 16) return true;
        return false;
    },

    /**
     * Midair may win over building/ground soft escapes unless already mesh-glued or dirt-diving.
     */
    canYieldToMidairBreak(coverInfo = {}, altitude = 40, forwardY = 0) {
        const dist = Number(coverInfo.distance);
        const roof = Number(coverInfo.roofClearance);
        const headroom = Number(coverInfo.headroom);
        if (Number.isFinite(dist) && dist < 1.5) return false;
        // T64: under-slab / embed always owns sticks — midair must not steal opening frames.
        if (Number.isFinite(roof) && roof < 0) return false;
        if (Number.isFinite(dist) && dist >= 0 && dist < 8) return false;
        if (Number.isFinite(headroom) && headroom < 4 && Number.isFinite(dist) && dist < 4) return false;
        if (altitude < 10 && forwardY < -0.55) return false;
        return true;
    },

    /**
     * True undercroft / mesh glue — not merely flying beside a taller AABB (selfY &lt; box.max.y).
     * T76: roof=-17 @ dist=26 with headroom=48 was "beside tall building", not under slab.
     * M15: delegates to AirArenaUrbanAvoidSide.isTrueUndercroft when available.
     */
    isTrueUnderRoof(coverInfo = {}, opts = {}) {
        const hard = !!(opts.hardContact || this.isHardBuildingContact(coverInfo));
        if (typeof AirArenaUrbanAvoidSide !== 'undefined' && AirArenaUrbanAvoidSide.isTrueUndercroft) {
            return AirArenaUrbanAvoidSide.isTrueUndercroft(coverInfo, { ...opts, hardContact: hard });
        }
        const roof = Number(coverInfo.roofClearance);
        if (!(Number.isFinite(roof) && roof < 2)) return false;
        const dist = Number(coverInfo.distance);
        const headroom = Number(coverInfo.headroom);
        if (hard) return true;
        if (Number.isFinite(dist) && dist < 14) return true;
        if (Number.isFinite(headroom) && headroom < 14) return true;
        return false;
    },

    /**
     * Hard-lock obstacleEmergency: true undercroft / near building — not bare roof&lt;0 at long range.
     * Bare negative roof beside a tall AABB should prefer scored routes (medium risk), not T38.
     * T66/T53: near-dirt nose-down must NOT hard-lock over groundEmergency.
     */
    isObstacleEmergencyHardLock(coverInfo = {}, opts = {}) {
        const roof = Number(coverInfo.roofClearance);
        const dist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        const alt = Number(opts.altitude);
        const forwardY = Number(opts.forwardY);
        // Near dirt while diving: groundEmergency owns the stick.
        if (
            Number.isFinite(alt) &&
            alt < 12 &&
            Number.isFinite(forwardY) &&
            forwardY < -0.2
        ) {
            return false;
        }
        if (this.isTrueUnderRoof(coverInfo, opts)) return true;
        // Negative roof only hard-locks when already close (true proximity pressure).
        if (Number.isFinite(roof) && roof < 0 && Number.isFinite(dist) && dist < 18) return true;
        if (Number.isFinite(dist) && dist >= 0 && dist < 8) return true;
        if (
            Number.isFinite(fwd) &&
            fwd > 0 &&
            fwd < 8 &&
            coverInfo.collisionRisk !== 'low'
        ) {
            return true;
        }
        return false;
    },

    /**
     * Escape succeeded / pressure soft enough — hand stick back to fox2Opening/engagement (T150 / M19).
     * Thresholds live in pilot tuning (`engageHandoff*`).
     */
    shouldHandoffEscapeToEngage(coverInfo = {}, opts = {}) {
        const hardContact = !!(opts.hardContact || this.isHardBuildingContact(coverInfo));
        const hardLock = !!opts.hardLock || this.isObstacleEmergencyHardLock(coverInfo, opts);
        const trueUndercroft = this.isTrueUnderRoof(coverInfo, { ...opts, hardContact });
        const tuning = opts.tuning || this.getTuning();
        if (typeof AirArenaUrbanAvoidSide !== 'undefined' && AirArenaUrbanAvoidSide.shouldHandoffEscapeToEngage) {
            return AirArenaUrbanAvoidSide.shouldHandoffEscapeToEngage(coverInfo, {
                ...opts,
                hardContact,
                hardLock,
                trueUndercroft
            }, tuning);
        }
        if (hardContact || trueUndercroft || hardLock) return false;
        const risk = coverInfo.collisionRisk || 'low';
        const dist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        const alt = Number(opts.altitude);
        const fy = Number(opts.forwardY);
        if (Number.isFinite(fy) && fy < -0.28 && Number.isFinite(alt) && alt < 52) return false;
        if (risk === 'high' && Number.isFinite(dist) && dist < 18) return false;
        if (Number.isFinite(fwd) && fwd > 0 && fwd < 12 && risk !== 'low') return false;
        if (risk === 'low' && (!Number.isFinite(dist) || dist >= 16) && (!Number.isFinite(fy) || fy > -0.2)) {
            return true;
        }
        if (
            risk === 'medium' &&
            Number.isFinite(dist) && dist >= 22 &&
            Number.isFinite(fy) && fy > 0.12 &&
            Number.isFinite(alt) && alt >= 30
        ) {
            return true;
        }
        if (
            risk === 'high' &&
            Number.isFinite(dist) && dist >= 18 &&
            Number.isFinite(fy) && fy > 0.22 &&
            Number.isFinite(alt) && alt >= 32
        ) {
            return true;
        }
        // Soft: baked aiMap clearAbove — beside-tall clutter, not forced re-engage; just stop escape thrash.
        if (
            (opts.aiMapClearAbove || opts.aiMapSkyOpen) &&
            risk !== 'high' &&
            (!Number.isFinite(fy) || fy > -0.22) &&
            (!Number.isFinite(dist) || dist >= 12)
        ) {
            return true;
        }
        return false;
    },

    /**
     * Keep fox2Opening/alignFirst from stealing sticks while urban pressure remains.
     * After escape clears (low risk / climb-out), do NOT keep blocking — hand back to fight (T150).
     * Soft: baked aiMap clearAbove may ignore beside-tall negative roof (not a hard force).
     */
    shouldBlockOpeningForUrbanPressure(coverInfo = {}, opts = {}) {
        if (this.shouldHandoffEscapeToEngage(coverInfo, opts)) return null;
        if (this.isObstacleEmergencyHardLock(coverInfo, opts)) return 'obstacleHardLock';
        const roof = Number(coverInfo.roofClearance);
        const dist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        const risk = coverInfo.collisionRisk;
        const fy = Number(opts.forwardY);
        const aiClear = !!(opts.aiMapClearAbove || opts.aiMapSkyOpen);
        if (risk === 'high') return 'risk=high';
        // Medium only blocks when still close or diving — not forever at long range.
        // Soft: if aiMap says we are clear above local roofs, ignore medium bubble alone.
        if (
            risk === 'medium' &&
            !aiClear &&
            (
                (Number.isFinite(dist) && dist < 22) ||
                (Number.isFinite(fwd) && fwd > 0 && fwd < 18) ||
                (Number.isFinite(fy) && fy < -0.15)
            )
        ) {
            return 'risk=medium';
        }
        if (opts.altitudeLane && (opts.altitudeLane.embedded || opts.altitudeLane.underRoof)) {
            if (!(Number.isFinite(dist) && dist >= 20 && risk === 'low')) {
                return 'altitudeLaneEmbed';
            }
        }
        // Negative roof alone: only while still near the building (bare tall AABB at range → fight).
        // Soft: aiMap clearAbove means the negative roof is beside-tall clutter, not an overhead slab.
        if (
            Number.isFinite(roof) &&
            roof < 0 &&
            !aiClear &&
            (
                (Number.isFinite(dist) && dist < 24) ||
                risk === 'medium' ||
                risk === 'high'
            )
        ) {
            return 'roofNegative';
        }
        if (
            Number.isFinite(roof) &&
            roof < 8 &&
            Number.isFinite(dist) &&
            dist < 28 &&
            risk !== 'low' &&
            !aiClear
        ) {
            return 'roofApproach';
        }
        if (Number.isFinite(dist) && dist < 12 && risk !== 'low') return 'coverClose';
        return null;
    },

    /**
     * Steep dive into a closing facade (score + soft escape path).
     * Broader than hardContact steepFaceDive — catches medium-risk approach while nose-down.
     */
    isSteepDiveIntoFacade(coverInfo = {}, forwardY = 0, altitude = 40) {
        if (!(Number.isFinite(forwardY) && forwardY < -0.4)) return false;
        if (!(altitude >= 12 && altitude < 52)) return false;
        const fwd = Number(coverInfo.forwardDistance);
        const dist = Number(coverInfo.distance);
        const roof = Number(coverInfo.roofClearance);
        const risk = coverInfo.collisionRisk;
        if (!(Number.isFinite(fwd) && fwd > 1 && fwd <= 42)) return false;
        if (risk === 'high' || risk === 'medium') return true;
        if (Number.isFinite(roof) && roof < 10 && Number.isFinite(dist) && dist < 48) return true;
        return this.isFacadeClosingScore(coverInfo) && forwardY < -0.48;
    },

    /** Diverge side for merge break: relative lateral first, else faction so AI vs AI don't share one bank. */
    getMidairDivergeSide(ctx = {}) {
        const localX = ctx.localToEnemy ? Number(ctx.localToEnemy.x) : 0;
        if (Number.isFinite(localX) && Math.abs(localX) > 0.1) return Math.sign(localX);
        const faction = ctx.faction || (ctx.teamId && GameContext.getFaction && GameContext.getFaction(ctx.teamId));
        if (faction === 'blue') return -1;
        if (faction === 'red') return 1;
        return Math.sign(ctx.breakSide || 1) || 1;
    },

    buildCloseMidairBreakAction(ctx = {}) {
        const distance = Number(ctx.distance) || 0;
        const altitude = Number(ctx.altitude) || 40;
        const hard = distance <= 12;
        const side = this.getMidairDivergeSide(ctx);
        const heat = Number(ctx.heat) || 0;
        const noseDown = Number(ctx.forwardY);
        const divingHard = Number.isFinite(noseDown) && noseDown < -0.35;
        const divingSoft = Number.isFinite(noseDown) && noseDown < -0.25;
        const needPull = altitude < 26 || divingSoft;
        // T66: ±0.95 thr3 + weak joyY while diving dumps altitude into dirt.
        // Dive/low: soften bank so thr can stay 4, raise pull, tag diveLevelPull.
        const divePullPriority =
            divingHard ||
            (altitude < 22 && divingSoft) ||
            (altitude < 18 && needPull);
        let auth = hard ? 0.95 : 0.78;
        let joyY = needPull ? (altitude < 22 ? 0.42 : 0.28) : (altitude < 28 ? 0.18 : 0.08);
        let diveLevelPull = false;
        if (divePullPriority) {
            auth = Math.min(auth, altitude < 14 ? 0.42 : 0.55);
            joyY = altitude < 18 ? 0.72 : (altitude < 26 ? 0.62 : 0.55);
            diveLevelPull = true;
        }
        const joyX = this.clamp(side * auth, -1, 1);
        const thr = this.pickThrottleForTurn(heat > 76 ? 3 : 4, joyX, {
            heat,
            ap: ctx.ap,
            lowAp: ctx.lowAp
        });
        return {
            state: hard ? 'mandatoryMergeBreak' : 'mergeBreak',
            statusText: `NPC: 近距避撞 ${Math.floor(distance)}m`,
            throttle: thr,
            joyX,
            joyY,
            roll: this.clamp(side * (divePullPriority ? Math.PI / 7 : (hard ? Math.PI / 4 : Math.PI / 5)), -Math.PI / 4, Math.PI / 4),
            weapon: 'gun',
            queueAction: 'none',
            ready: true,
            diveLevelPull,
            reason: divePullPriority
                ? (hard
                    ? 'Close midair while diving: level-out first, soft diverge'
                    : 'Near midair while diving: level-out first, soft diverge')
                : (hard
                    ? 'Close midair: mandatory diverge before opening/press/groundAvoid'
                    : 'Near midair (~20m): diverge before merge collision')
        };
    },

    /** Shared midair ctx for decide gates. */
    buildMidairThreatCtx(parts = {}) {
        return {
            distance: parts.distance,
            predictedSeparation: parts.predictedSeparation,
            headOnFactor: parts.headOnFactor,
            closureSpeed: parts.closureSpeed,
            altitude: parts.altitude,
            forwardY: parts.forwardY,
            localToEnemy: parts.localToEnemy,
            breakSide: parts.breakSide,
            teamId: parts.teamId,
            heat: parts.heat || 0,
            ap: parts.ap,
            lowAp: parts.lowAp,
            faction: parts.faction
        };
    },

    tryCloseMidairBreak(parts = {}, coverInfo = {}, tree = null, tag = 'midair') {
        const midairCtx = this.buildMidairThreatCtx(parts);
        if (!this.isCloseMidairThreat(midairCtx)) return null;
        if (!this.canYieldToMidairBreak(coverInfo, Number(parts.altitude) || 40, Number(parts.forwardY) || 0)) {
            if (Array.isArray(tree)) tree.push(`${tag}: deferred=embedOrDirt`);
            return null;
        }
        const coverD = Number(coverInfo.distance);
        const enemyD = Number(parts.distance);
        // High building risk ahead may still yield when enemy is as near or nearer, or knife glue.
        if (
            coverInfo.collisionRisk === 'high' &&
            Number.isFinite(coverD) &&
            Number.isFinite(enemyD) &&
            coverD < 6 &&
            Number(coverInfo.forwardDistance) > 1 &&
            enemyD > coverD + 4 &&
            enemyD > 12
        ) {
            if (Array.isArray(tree)) tree.push(`${tag}: deferred=buildingNearer`);
            return null;
        }
        return this.buildCloseMidairBreakAction(midairCtx);
    },

    toVector3(raw) {
        return raw ? new THREE.Vector3(raw.x, raw.y, raw.z) : new THREE.Vector3();
    },

    /** Living hostile only — never fall back to a faction default corpse. */
    getEnemyId(teamId) {
        if (typeof GameContext !== 'undefined' && GameContext.getTargetId) {
            const locked = GameContext.getTargetId(teamId);
            if (locked) {
                const ht = GameContext.getTeam ? GameContext.getTeam(locked) : null;
                if (ht && !ht.isDestroyed) return locked;
            }
        }
        if (typeof GameContext !== 'undefined' && GameContext.getNearestHostileId) {
            const nearest = GameContext.getNearestHostileId(teamId);
            if (nearest) {
                const ht = GameContext.getTeam ? GameContext.getTeam(nearest) : null;
                if (ht && !ht.isDestroyed) return nearest;
            }
        }
        return null;
    },

    isLivingEnemy(enemyId, battleState) {
        if (!enemyId) return false;
        const live = (typeof GameContext !== 'undefined' && GameContext.getTeam)
            ? GameContext.getTeam(enemyId) : null;
        if (live) {
            if (live.isDestroyed) return false;
            if (typeof live.hp === 'number' && live.hp <= 0) return false;
        }
        const snap = battleState && battleState.teams ? battleState.teams[enemyId] : null;
        if (!snap || snap.isDestroyed || !snap.position) return false;
        if (typeof snap.hp === 'number' && snap.hp <= 0) return false;
        return true;
    },

    getWingmanLeadId(teamId) {
        if (typeof GameContext === 'undefined' || !GameContext.getFaction || !GameContext.getLivingTeamIds) return null;
        const self = GameContext.getTeam(teamId);
        if (!self || !self.aiEnabled) return null;
        const faction = GameContext.getFaction(teamId);
        if (!faction) return null;
        const humans = GameContext.getLivingTeamIds().filter((id) => {
            if (id === teamId) return false;
            if (GameContext.getFaction(id) !== faction) return false;
            const t = GameContext.getTeam(id);
            return !!(t && !t.aiEnabled && !t.isDestroyed && !(typeof t.hp === 'number' && t.hp <= 0));
        });
        if (!humans.length) return null;
        const activeId = GameContext.getActiveTeamId && GameContext.getActiveTeamId();
        if (activeId && humans.includes(activeId)) return activeId;
        return humans[0];
    },

    getWingmanOrder(teamId) {
        const t = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        const order = t && t.wingmanOrder;
        return ['follow', 'attack', 'free', 'cover', 'break'].includes(order) ? order : 'follow';
    },

    getWingmanOrderLabel(order) {
        return ({
            follow: '跟隨',
            attack: '攻擊我的目標',
            free: '主動進攻',
            cover: '掩護',
            break: '脫離'
        })[order] || order;
    },

    /** Orders that use formation / support FSM (not independent combat). */
    isWingmanSupportOrder(order) {
        return order === 'follow' || order === 'cover' || order === 'break';
    },

    /**
     * Lead pose for formation: prefer planned end-of-turn (WE-GO ghost),
     * else current wrapper / serialized pose.
     */
    getWingmanLeadPose(leadId, battleState) {
        const live = (typeof GameContext !== 'undefined' && GameContext.getTeam)
            ? GameContext.getTeam(leadId) : null;
        if (live && (live.isDestroyed || (typeof live.hp === 'number' && live.hp <= 0))) {
            return null;
        }
        if (live && !live.isDestroyed && live.wrapper) {
            const pts = live.pathPoints;
            const quats = live.pathQuats;
            if (Array.isArray(pts) && pts.length > 0) {
                const last = pts[pts.length - 1];
                const pos = (last && typeof last.clone === 'function')
                    ? last.clone()
                    : new THREE.Vector3(last.x, last.y, last.z);
                let forward;
                if (Array.isArray(quats) && quats.length > 0) {
                    const q = quats[quats.length - 1];
                    forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
                } else {
                    forward = new THREE.Vector3(0, 0, 1).applyQuaternion(live.wrapper.quaternion).normalize();
                }
                return { pos, forward, fromPath: true };
            }
            return {
                pos: live.wrapper.position.clone(),
                forward: new THREE.Vector3(0, 0, 1).applyQuaternion(live.wrapper.quaternion).normalize(),
                fromPath: false
            };
        }
        const snap = battleState && battleState.teams ? battleState.teams[leadId] : null;
        if (!snap || !snap.position || snap.isDestroyed) return null;
        if (typeof snap.hp === 'number' && snap.hp <= 0) return null;
        return {
            pos: this.toVector3(snap.position),
            forward: this.toVector3(snap.forward).normalize(),
            fromPath: false
        };
    },

    /** Formation / cover slot in world space relative to lead. */
    getWingmanSlotPos(leadPos, leadForward, teamId, mode = 'follow') {
        const fwd = leadForward.clone().normalize();
        let right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
        if (right.lengthSq() < 0.0001) right = new THREE.Vector3(1, 0, 0);
        else right.normalize();
        const sideSign = String(teamId).endsWith('2') ? 1 : -1;
        if (mode === 'cover') {
            return leadPos.clone()
                .add(right.multiplyScalar(sideSign * 7))
                .add(fwd.multiplyScalar(-24))
                .add(new THREE.Vector3(0, 2.5, 0));
        }
        // follow: tighter combat wing on lead's planned end pose
        return leadPos.clone()
            .add(right.multiplyScalar(sideSign * 9))
            .add(fwd.multiplyScalar(-12))
            .add(new THREE.Vector3(0, 1.0, 0));
    },

    steerTowardWorldPoint(selfPos, selfQuat, targetPos) {
        const to = targetPos.clone().sub(selfPos);
        const dist = to.length();
        if (dist < 0.001) {
            return { dist: 0, joyX: 0, joyY: 0, roll: 0, local: new THREE.Vector3(0, 0, 1) };
        }
        const local = to.clone().normalize().applyQuaternion(selfQuat.clone().invert()).normalize();
        const joyX = this.clamp(-local.x * 0.95, -0.88, 0.88);
        const joyY = this.clamp(local.y * 0.85, -0.55, 0.72);
        return {
            dist,
            joyX,
            joyY,
            roll: this.clamp(joyX * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5),
            local
        };
    },

    /**
     * Support orders (follow / cover / break). Attack uses main decide with lead's target.
     * Returns null to fall through to independent combat AI.
     */
    decideWingmanSupport(teamId, battleState, leadId, order) {
        const self = battleState.teams[teamId];
        const leadSnap = battleState.teams[leadId];
        const liveSelf = GameContext.getTeam(teamId);
        const liveLead = GameContext.getTeam(leadId);
        // Live lead wins over stale snapshot — never form on a corpse / ghost lead.
        if (!liveLead || liveLead.isDestroyed || (typeof liveLead.hp === 'number' && liveLead.hp <= 0)) {
            return null;
        }
        const leadPose = this.getWingmanLeadPose(leadId, battleState);
        if (!self || !leadSnap || !leadPose || !self.position || self.isDestroyed || leadSnap.isDestroyed) return null;
        if (typeof leadSnap.hp === 'number' && leadSnap.hp <= 0) return null;

        const selfPos = this.toVector3(self.position);
        const leadPos = leadPose.pos;
        const leadForward = leadPose.forward.clone().normalize();
        const selfForward = this.toVector3(self.forward).normalize();
        const selfQuat = (liveSelf && liveSelf.wrapper)
            ? liveSelf.wrapper.quaternion.clone()
            : new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), selfForward);
        const label = this.getWingmanOrderLabel(order);
        const leadThrottle = Math.max(2, Math.min(5, Number(leadSnap.throttle) || 4));
        const hostileId = (GameContext.getTargetId && GameContext.getTargetId(leadId))
            || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(leadId))
            || this.getEnemyId(teamId);
        const hostileAlive = this.isLivingEnemy(hostileId, battleState);
        const hostile = hostileAlive && hostileId ? battleState.teams[hostileId] : null;
        const hostilePos = hostile && hostile.position ? this.toVector3(hostile.position) : null;
        const distToLead = selfPos.distanceTo(leadPos);
        const distToHostile = hostilePos ? selfPos.distanceTo(hostilePos) : 9999;
        const canFlare = !!(liveSelf && liveSelf.flareAmmo > 0 && !liveSelf.flaresArmed);
        const needFlare = canFlare && distToHostile < 55 && hostilePos
            && selfForward.angleTo(hostilePos.clone().sub(selfPos).normalize()) > Math.PI * 0.45;
        const poseTag = leadPose.fromPath ? 'ghost' : 'now';

        // Low altitude safety — but never pull into an undercroft ceiling.
        const headroomNow = this.getOverheadHeadroom(selfPos);
        if (selfPos.y < 16 || (selfPos.y < 28 && selfForward.y < -0.35)) {
            if (Number.isFinite(headroomNow) && headroomNow < 10) {
                const flatFwd = selfForward.clone();
                flatFwd.y = 0;
                if (flatFwd.lengthSq() < 0.0001) flatFwd.set(0, 0, 1);
                else flatFwd.normalize();
                const steerOut = this.steerTowardWorldPoint(
                    selfPos,
                    selfQuat,
                    selfPos.clone().add(flatFwd.multiplyScalar(40))
                );
                return this.withDebug({
                    state: 'wingmanCeilingLevel',
                    statusText: `NPC: 僚機頂空受限｜${label}`,
                    throttle: self.heat > 75 ? 3 : 4,
                    joyX: this.clamp(steerOut.joyX, -0.55, 0.55),
                    joyY: this.maxJoyYForHeadroom(headroomNow),
                    roll: this.clamp(steerOut.roll, -0.35, 0.35),
                    weapon: 'gun',
                    queueAction: needFlare ? 'flare' : 'none',
                    ready: true,
                    reason: 'Wingman undercroft: level instead of pull-up into ceiling'
                }, { wingmanOrder: order, leadId, distToLead, leadPose: poseTag, headroom: Number(headroomNow.toFixed(1)) }, [
                    `wingman: order=${order} ceilingLevel headroom=${headroomNow.toFixed(1)} pose=${poseTag}`
                ], 'wingmanCeilingLevel');
            }
            return this.withDebug({
                state: 'wingmanPullUp',
                statusText: `NPC: 僚機拉起｜${label}`,
                throttle: self.heat > 75 ? 4 : 5,
                joyX: 0,
                joyY: 0.9,
                roll: 0,
                weapon: 'gun',
                queueAction: needFlare ? 'flare' : 'none',
                ready: true,
                reason: 'Wingman ground safety'
            }, { wingmanOrder: order, leadId, distToLead, leadPose: poseTag }, [`wingman: order=${order} pullUp pose=${poseTag}`], 'wingmanPullUp');
        }

        if (order === 'break') {
            let escapeDir = selfForward.clone();
            if (hostilePos) {
                escapeDir = selfPos.clone().sub(hostilePos);
                escapeDir.y = 0;
                if (escapeDir.lengthSq() < 0.01) escapeDir = selfForward.clone();
                else escapeDir.normalize();
            } else {
                escapeDir = selfForward.clone();
                escapeDir.y = 0;
                if (escapeDir.lengthSq() > 0.01) escapeDir.normalize();
            }
            const aim = selfPos.clone().add(escapeDir.multiplyScalar(80)).add(new THREE.Vector3(0, 8, 0));
            const steer = this.steerTowardWorldPoint(selfPos, selfQuat, aim);
            const farEnough = distToHostile > 140;
            return this.withDebug({
                state: 'wingmanBreak',
                statusText: farEnough ? `NPC: 僚機重整｜${label}` : `NPC: 僚機脫離｜${label}`,
                throttle: farEnough ? 3 : (self.heat > 78 ? 4 : 5),
                joyX: steer.joyX,
                joyY: farEnough ? Math.min(0.2, steer.joyY) : Math.max(0.15, steer.joyY),
                roll: steer.roll,
                weapon: 'gun',
                queueAction: needFlare ? 'flare' : 'none',
                ready: true,
                reason: 'Wingman break / extend'
            }, { wingmanOrder: order, leadId, distToLead, distToHostile, leadPose: poseTag }, [`wingman: order=break distH=${distToHostile.toFixed(1)} pose=${poseTag}`], 'wingmanBreak');
        }

        if (order === 'cover') {
            // Threat pressing the lead: cut in and engage (living hostiles only).
            const leadThreatDist = hostilePos ? leadPos.distanceTo(hostilePos) : 9999;
            if (hostilePos && hostileAlive && leadThreatDist < 95) {
                const steerThreat = this.steerTowardWorldPoint(selfPos, selfQuat, hostilePos);
                const toH = hostilePos.clone().sub(selfPos).normalize();
                const ang = selfForward.angleTo(toH) * 180 / Math.PI;
                const inGun = distToHostile <= 70 && ang < 22;
                return this.withDebug({
                    state: 'wingmanCoverEngage',
                    statusText: `NPC: 僚機掩護接敵｜${label}`,
                    throttle: distToHostile < 40 ? 3 : 4,
                    joyX: steerThreat.joyX,
                    joyY: this.clamp(steerThreat.joyY, -0.35, 0.55),
                    roll: steerThreat.roll,
                    weapon: 'gun',
                    queueAction: needFlare ? 'flare' : (inGun ? 'gun' : 'none'),
                    ready: true,
                    reason: 'Cover: engage threat near lead'
                }, { wingmanOrder: order, leadId, leadThreatDist, distToHostile, leadPose: poseTag }, [
                    `wingman: cover engage threat=${hostileId} leadThreat=${leadThreatDist.toFixed(1)} pose=${poseTag}`
                ], 'wingmanCoverEngage');
            }
            const slot = this.getWingmanSlotPos(leadPos, leadForward, teamId, 'cover');
            const steer = this.steerTowardWorldPoint(selfPos, selfQuat, slot);
            const onStation = steer.dist < 18;
            return this.withDebug({
                state: 'wingmanCover',
                statusText: `NPC: 僚機掩護站位｜${label}`,
                throttle: onStation ? Math.max(2, leadThrottle - 1) : leadThrottle,
                joyX: onStation ? steer.joyX * 0.45 : steer.joyX,
                joyY: onStation ? this.clamp(steer.joyY * 0.4, -0.2, 0.25) : steer.joyY,
                roll: onStation ? steer.roll * 0.5 : steer.roll,
                weapon: 'gun',
                queueAction: needFlare ? 'flare' : 'none',
                ready: true,
                reason: 'Cover: hold six / trail station'
            }, { wingmanOrder: order, leadId, distToLead, slotDist: steer.dist, leadPose: poseTag }, [
                `wingman: cover station dist=${steer.dist.toFixed(1)} pose=${poseTag}`
            ], 'wingmanCover');
        }

        // follow (default support)
        const slot = this.getWingmanSlotPos(leadPos, leadForward, teamId, 'follow');
        let aimPoint = slot.clone();
        let pathBlocked = this.hasObstacleBetween(selfPos, slot);
        let detourSide = 0;
        let undercroftJoin = 0;
        const leadHeadroom = this.getOverheadHeadroom(leadPos);
        const slotHeadroom = this.getOverheadHeadroom(slot);
        const selfHeadroom = this.getOverheadHeadroom(selfPos);
        const leadUndercroft = (Number.isFinite(leadHeadroom) && leadHeadroom < 14) ||
            (Number.isFinite(slotHeadroom) && slotHeadroom < 14);
        const urbanDrop = this.getObstacles().length > 0 && selfPos.y > slot.y + 5;
        const divingIntoUndercroft = (leadUndercroft || urbanDrop) && selfPos.y > slot.y + 4 &&
            (!Number.isFinite(selfHeadroom) || selfHeadroom >= 12);

        // Straight ray to slot can miss the elevated-slab lip; check L-path (flat then down).
        const lipRisk = divingIntoUndercroft || (selfPos.y > slot.y + 6 && pathBlocked);
        if (lipRisk || pathBlocked) {
            const flatAim = new THREE.Vector3(slot.x, selfPos.y - 0.5, slot.z);
            const flatClear = !this.hasObstacleBetween(selfPos, flatAim);
            const dropClear = flatClear && !this.hasObstacleBetween(flatAim, slot);
            if (divingIntoUndercroft && flatClear) {
                // Almost-join case: stay high, close horizontal gap first, then descend next turns.
                const horiz = Math.hypot(slot.x - selfPos.x, slot.z - selfPos.z);
                if (horiz > 10) {
                    aimPoint = flatAim;
                    undercroftJoin = 1;
                    pathBlocked = false;
                } else if (dropClear) {
                    aimPoint = slot.clone();
                    aimPoint.y = selfPos.y - Math.min(5, selfPos.y - slot.y);
                    undercroftJoin = 1;
                    pathBlocked = false;
                }
            }
            if (!undercroftJoin && pathBlocked) {
                const flatLead = leadForward.clone();
                flatLead.y = 0;
                if (flatLead.lengthSq() < 0.0001) flatLead.set(0, 0, 1);
                else flatLead.normalize();
                const right = new THREE.Vector3(flatLead.z, 0, -flatLead.x);
                const toSlot = slot.clone().sub(selfPos);
                const prefer = Math.sign(right.dot(toSlot)) || ((GameContext.getFaction && GameContext.getFaction(teamId)) === 'blue' ? -1 : 1);
                for (const side of [prefer, -prefer]) {
                    const via = selfPos.clone()
                        .add(right.clone().multiplyScalar(side * 26))
                        .add(flatLead.clone().multiplyScalar(18));
                    via.y = this.clamp(via.y, Math.min(selfPos.y, slot.y) - 2, Math.max(selfPos.y, slot.y) + 4);
                    if (Number.isFinite(selfHeadroom) && selfHeadroom < 10) {
                        via.y = Math.min(via.y, selfPos.y + Math.max(0, selfHeadroom - 3));
                    }
                    if (divingIntoUndercroft) via.y = Math.max(via.y, selfPos.y - 1.5);
                    if (!this.hasObstacleBetween(selfPos, via)) {
                        aimPoint = via;
                        detourSide = side;
                        pathBlocked = false;
                        break;
                    }
                }
            }
        }
        const steer = this.steerTowardWorldPoint(selfPos, selfQuat, aimPoint);
        const onStation = !detourSide && !undercroftJoin && steer.dist < 12;
        let joyX = steer.joyX;
        let joyY = steer.joyY;
        if (onStation) {
            const leadLocal = leadForward.clone().applyQuaternion(selfQuat.clone().invert());
            joyX = this.clamp(joyX * 0.35 + (-leadLocal.x) * 0.4, -0.55, 0.55);
            joyY = this.clamp(joyY * 0.35 + leadLocal.y * 0.35, -0.28, 0.35);
        } else if (detourSide) {
            joyX = this.clamp(joyX + detourSide * 0.18, -0.85, 0.85);
            joyY = this.clamp(joyY, -0.2, 0.28);
        } else if (undercroftJoin) {
            // Cap dive so we don't slam the slab lip while closing from open sky.
            joyY = this.clamp(joyY, -0.18, 0.2);
            joyX = this.clamp(joyX, -0.72, 0.72);
        }
        const followState = detourSide ? 'wingmanFollowDetour' : (undercroftJoin ? 'wingmanFollowUndercroft' : 'wingmanFollow');
        const followStatus = detourSide
            ? `NPC: 僚機繞樓歸隊｜${label}`
            : (undercroftJoin
                ? `NPC: 僚機平進板下｜${label}`
                : (onStation ? `NPC: 僚機編隊｜${label}` : `NPC: 僚機歸隊｜${label}`));
        return this.withDebug({
            state: followState,
            statusText: followStatus,
            throttle: onStation ? leadThrottle : Math.min(5, leadThrottle + 1),
            joyX,
            joyY,
            roll: this.clamp(joyX * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
            weapon: 'gun',
            queueAction: needFlare ? 'flare' : 'none',
            ready: true,
            reason: detourSide
                ? 'Wingman follow: lateral detour — direct slot path blocked by building'
                : (undercroftJoin
                    ? 'Wingman follow: level approach then descend into undercroft (avoid slab lip)'
                    : (leadPose.fromPath
                        ? 'Wingman follow lead planned end pose'
                        : 'Wingman follow lead current pose'))
        }, {
            wingmanOrder: order,
            leadId,
            distToLead,
            slotDist: steer.dist,
            leadPose: poseTag,
            pathBlocked: pathBlocked ? 1 : 0,
            detourSide,
            undercroftJoin,
            leadHeadroom: Number.isFinite(leadHeadroom) ? Number(leadHeadroom.toFixed(1)) : null
        }, [
            `wingman: follow slotDist=${steer.dist.toFixed(1)} onStation=${onStation ? 1 : 0} detour=${detourSide} undercroft=${undercroftJoin} blocked=${pathBlocked ? 1 : 0} leadHR=${Number.isFinite(leadHeadroom) ? leadHeadroom.toFixed(1) : 'n/a'} pose=${poseTag}`
        ], followState);
    },

    getPassiveSearchRange(arenaMode = 'buildings') {
        if (arenaMode === 'blank' || arenaMode === 'visual-only') return 820;
        if (arenaMode === 'sparse-urban') return 680;
        if (arenaMode === 'medium-urban') return 620;
        return 680;
    },

    getSensorProfile(arenaMode = 'buildings') {
        const openArena = arenaMode === 'blank' || arenaMode === 'visual-only';
        return {
            radarRange: openArena ? 280 : (arenaMode === 'sparse-urban' ? 245 : 225),
            visualRange: openArena ? 170 : 150,
            visualAngleDeg: 98,
            radarLosRange: 95,
            memoryClear: 8,
            memoryBlocked: 6
        };
    },

    capCombatVerticalJoy(joyY, altitude, selfForwardY, tuning, hasCombatContact) {
        if (!hasCombatContact) return joyY;
        const bandMin = Number(tuning.combatBandMin || 35);
        const alt = Number(altitude || 0);
        const fwdY = Number(selfForwardY || 0);
        let capped = joyY;
        if (alt >= bandMin - 2) capped = Math.min(capped, 0.05);
        else if (alt >= bandMin - 12) capped = Math.min(capped, 0.12);
        if (fwdY > Number(tuning.stallPitchThreshold || 0.16) && alt > 26) {
            capped = Math.min(capped, tuning.recoverPitchBias || -0.12);
        }
        return capped;
    },

    getCombatAltitudeProfile(altitude, tuning = this.getTuning(), forwardY = null) {
        const bandMin = Number(tuning.combatBandMin || 35);
        const bandMax = Number(tuning.combatBandMax || 92);
        const bandHard = Number(tuning.combatBandHardMax || 108);
        const alt = Number(altitude || 0);
        const fwdY = Number(forwardY);
        const noseHigh = Number.isFinite(fwdY) && fwdY > 0.35;
        const noseVeryHigh = Number.isFinite(fwdY) && fwdY > 0.5;
        const excess = Math.max(0, alt - bandMax);
        const hardExcess = Math.max(0, alt - bandHard);
        // T61 blue2: waited until 100m+ with fwdY≈0.7; intervene earlier while still climbing.
        const needsLevelOut =
            alt >= bandHard ||
            (alt >= bandMax + 2) ||
            (alt >= bandMax - 8 && noseVeryHigh) ||
            (alt >= bandMax && noseHigh);
        const needsSoftCap = alt >= bandMax - 2 || (alt >= bandMax - 12 && noseHigh);
        let zone = 'in-band';
        if (alt < bandMin) zone = 'below-band';
        else if (alt >= bandHard) zone = 'hard-high';
        else if (alt >= bandMax) zone = 'high';
        // Weak -0.42 left nose-high jets climbing 20m+ over several turns (T61 blue2).
        let levelOutJoyY = alt >= bandHard ? -0.42 : (alt >= bandMax + 18 ? -0.32 : -0.2);
        let levelOutPitch = alt >= bandHard ? 0.34 : 0.22;
        let levelOutThrottle = 4;
        if (needsLevelOut && Number.isFinite(fwdY) && fwdY > 0.25) {
            if (fwdY > 0.6) {
                levelOutJoyY = -0.78;
                levelOutPitch = 0.55;
                levelOutThrottle = 3;
            } else if (fwdY > 0.45) {
                levelOutJoyY = -0.62;
                levelOutPitch = 0.45;
                levelOutThrottle = 3;
            } else {
                levelOutJoyY = Math.min(levelOutJoyY, -0.48);
                levelOutPitch = Math.max(levelOutPitch, 0.36);
            }
        }
        return {
            bandMin,
            bandMax,
            bandHard,
            excess,
            hardExcess,
            needsLevelOut,
            needsSoftCap,
            zone,
            levelOutJoyY,
            levelOutPitch,
            levelOutThrottle
        };
    },

    /**
     * Urban altitude lanes (Slice B):
     * dirt <14 | canyon <~bandMin (forced-turn street) | combat | rooftop ~80 | high.
     * preferRoofExit / preferStraightClimb: score-bias toward climb-out when sky is clear —
     * not a stick rewrite on every side route. Under-roof (roofClearance) blocks it.
     * Below mandatoryClimbAlt (~32 / canyon): force climb bias (T25/T70 low circling).
     * AP/stall relaxed: bank altitude when open sky beats low-speed weave.
     */
    getUrbanAltitudeLane(altitude, coverInfo = {}, tuning = this.getTuning(), opts = {}) {
        const profile = this.getCombatAltitudeProfile(altitude, tuning);
        const alt = Number(altitude || 0);
        const roofEscape = Math.min(Number(tuning.combatBandMax) || 92, 80);
        const canyonMax = Math.max(28, profile.bandMin - 2);
        const climbFloor = this.getMandatoryClimbAlt(tuning);
        const headroom = Number(coverInfo.headroom);
        const roofClear = Number(coverInfo.roofClearance);
        const dist = Number(coverInfo.distance);
        const apNow = Number(opts.ap);
        const critAp = Number(tuning.energyCriticalAp || 52);
        // Milder than pre-AP-relax: only stall / true critical blocks roof-exit bias.
        const energyOk = !opts.stalled && !(Number.isFinite(apNow) && apNow < critAp);
        let lane = 'combat';
        if (alt < 14) lane = 'dirt';
        else if (alt < canyonMax) lane = 'canyon';
        else if (alt >= roofEscape - 4) lane = alt >= profile.bandHard ? 'high' : 'rooftop';
        else if (alt >= profile.bandMin) lane = 'combat';
        else lane = 'canyon';
        const buildingPressure =
            coverInfo.collisionRisk === 'medium' ||
            coverInfo.collisionRisk === 'high' ||
            !!opts.denseUrban ||
            this.isHardBuildingContact(coverInfo);
        // headroom can stay large while parked under an overhang — trust roofClearance too (T25).
        // T76: roof&lt;2 beside a taller AABB is NOT undercroft when dist/headroom are open.
        const underRoof = this.isTrueUnderRoof(coverInfo, {
            hardContact: this.isHardBuildingContact(coverInfo)
        });
        // Soften slab gate: only tight overhead blocks climb bias (was headroom<12).
        const underSlab = (Number.isFinite(headroom) && headroom < 8) || underRoof;
        const embedded =
            this.isHardBuildingContact(coverInfo) &&
            ((Number.isFinite(dist) && dist < 3) || (Number.isFinite(roofClear) && roofClear < 0 && Number.isFinite(dist) && dist < 6));
        const skyOpen = !underRoof && (!Number.isFinite(headroom) || headroom >= 10);
        // T35: do not require skyOpen/headroom — canyon streets rarely pass that gate below 20m.
        const mandatoryClimb =
            energyOk &&
            !underRoof &&
            alt < climbFloor;
        // Prefer banking height when sky is open and still below rooftop band.
        let preferStraightClimb =
            energyOk &&
            skyOpen &&
            !underSlab &&
            (!embedded || mandatoryClimb) &&
            alt >= 8 &&
            alt < roofEscape - 6;
        if (mandatoryClimb) preferStraightClimb = true;
        const preferRoofExit =
            preferStraightClimb &&
            (
                mandatoryClimb ||
                buildingPressure ||
                lane === 'canyon' ||
                lane === 'dirt' ||
                alt < profile.bandMin + 16
            );
        return {
            lane,
            canyonMax,
            roofEscape,
            bandMin: profile.bandMin,
            climbFloor,
            mandatoryClimb,
            preferRoofExit,
            preferStraightClimb,
            buildingPressure,
            underSlab,
            underRoof,
            embedded,
            skyOpen,
            climbJoyY: preferRoofExit || preferStraightClimb
                ? (mandatoryClimb
                    ? this.getMandatoryClimbJoyY(alt)
                    : (alt < 28 ? 0.58 : (alt < 42 ? 0.46 : 0.36)))
                : null,
            climbJoyXScale: preferRoofExit || preferStraightClimb
                ? (mandatoryClimb ? 0.36 : 0.48)
                : 1
        };
    },

    shouldAllowUrbanClimb(altitude, coverInfo = {}, denseUrban = false, tuning = this.getTuning()) {
        const profile = this.getCombatAltitudeProfile(altitude, tuning);
        const alt = Number(altitude || 0);
        const headroom = Number(coverInfo.headroom);
        const roofClear = Number(coverInfo.roofClearance);
        // Rooftop-band climb (~80m) is valid; open-sky climb beats low-speed weave when eligible.
        const roofEscape = Math.min(Number(tuning.combatBandMax) || 92, 80);
        if (Number.isFinite(roofClear) && roofClear < 2) return false;
        if (Number.isFinite(headroom) && headroom < 8) return false;
        if (coverInfo.collisionRisk === 'high') return true;
        // Open sky below rooftop: allow dedicated climb candidates (score decides).
        const skyOpen = !Number.isFinite(headroom) || headroom >= 10;
        if (skyOpen && alt < roofEscape - 6) return true;
        if (alt < profile.bandMin + 4) return true;
        if (alt < profile.bandMin + 14 && coverInfo.collisionRisk === 'medium' && alt < 52) return true;
        if (
            alt < roofEscape - 6 &&
            (coverInfo.collisionRisk === 'medium' || coverInfo.collisionRisk === 'high' || denseUrban)
        ) {
            return true;
        }
        return false;
    },

    adjustActionForCombatBand(action, altitude, coverInfo = {}, tuning = this.getTuning(), selfPitch = null, selfAp = null) {
        if (!action || typeof action.joyY !== 'number') return action;
        const fwdY = selfPitch != null ? Math.sin(Number(selfPitch)) : null;
        const profile = this.getCombatAltitudeProfile(altitude, tuning, fwdY);
        const climbExempt = new Set([
            'emergencyPullUp',
            'emergencyRecoverLock',
            'postGroundClimbOut',
            'groundAvoid',
            'obstacleEmergencyEscape',
            'obstacleEnergyClimb',
            'terrainEscape',
            'altitudeBandLevelOut',
            'openingRoofDash',
            'safetyEmbedPushOut',
            'safetyCanyonDivePull',
            'safetyGroundPull',
            'safetyGroundPullLat'
        ]);
        if (climbExempt.has(action.state)) return action;

        // Energy recover: do not AB-climb death spiral.
        // Near-ground vertical pull into stall is expected physics — correct urban answer is lateral around buildings.
        // Only mild lift when actually diving into dirt; nose-high stall unloads instead of pulling harder.
        const energyRecoverStates = new Set([
            'stallRecoverNoRoll',
            'stallBreakout',
            'energyRecover',
            'recover',
            'safetyStallBreakout',
            'safetyUnclimb',
            'safetyLevelOut'
        ]);
        const energyCriticalAp = Number(tuning.energyCriticalAp || 52);
        const energyBad = Number.isFinite(Number(selfAp)) && Number(selfAp) < energyCriticalAp;
        const urbanLateral =
            coverInfo.collisionRisk === 'medium' ||
            coverInfo.collisionRisk === 'high' ||
            !!coverInfo.corridorClear;
        const divingIntoDirt = altitude < 22 && selfPitch != null && selfPitch < -0.08;
        const noseHigh = selfPitch != null && selfPitch > 0.2;
        if (energyRecoverStates.has(action.state) || energyBad) {
            if (divingIntoDirt) {
                if (action.joyY < 0.32) action.joyY = 0.32;
                if (typeof action.throttle === 'number' && action.throttle < 4) action.throttle = 4;
            } else if (noseHigh && coverInfo.collisionRisk !== 'high' && !this.isHardBuildingContact(coverInfo)) {
                if (action.joyY > 0.08) action.joyY = 0.08;
                if (typeof action.throttle === 'number' && action.throttle > 3) action.throttle = 3;
            } else if (altitude >= 26 && action.joyY > 0.28) {
                action.joyY = 0.28;
                if (typeof action.throttle === 'number' && action.throttle > 3) action.throttle = 3;
            } else if (altitude < 26 && action.joyY > 0.35) {
                action.joyY = 0.35;
                if (typeof action.throttle === 'number' && action.throttle > 3) action.throttle = 3;
            }
            // Keep lateral authority for around-building / corridor escape.
            if (!urbanLateral && Math.abs(action.joyX || 0) > 0.42) {
                action.joyX = this.clamp(action.joyX, -0.42, 0.42);
            }
            if (action.debug && Array.isArray(action.debug.tree)) {
                action.debug.tree.push(
                    `combatBandEnergy: dive=${divingIntoDirt ? 1 : 0} noseHigh=${noseHigh ? 1 : 0} urbanLat=${urbanLateral ? 1 : 0} joyY=${Number(action.joyY).toFixed(2)} thr=${action.throttle}`
                );
            }
            return action;
        }

        const headroom = Number(coverInfo.headroom);
        // Undercroft ceiling: never force pull-up into slab (overrides low-alt climb boost).
        if (Number.isFinite(headroom) && headroom < 10) {
            this.applyHeadroomClimbLimit(action, headroom);
            return action;
        }
        const veryLowAlt = altitude < 26;
        const divingFast = selfPitch != null && selfPitch < -0.18;
        const sinkingLow = altitude < 38 && selfPitch != null && selfPitch < -0.08;
        // Open-ground dive recovery only. Urban building pressure: leave joyX free for weave / side route.
        if ((veryLowAlt || divingFast || sinkingLow) && !urbanLateral) {
            const minJoyY = veryLowAlt ? (altitude < 22 ? 0.72 : 0.55) : (divingFast ? 0.55 : 0.35);
            if (action.joyY < minJoyY) action.joyY = minJoyY;
            if (veryLowAlt && typeof action.throttle === 'number' && action.throttle < 4) {
                action.throttle = 4;
            }
            if (action.fire !== 'none' && altitude < 30) action.fire = 'none';
            const lowApRisk = (selfAp != null && selfAp < 70) || Math.abs(action.joyX || 0) > 0.65;
            if (altitude < 32 && lowApRisk && Math.abs(action.joyX || 0) > 0.35) {
                action.joyX = this.clamp(action.joyX, -0.32, 0.32);
            }
            if (altitude < 28) action.joyX = this.clamp(action.joyX || 0, -0.28, 0.28);
            return action;
        }
        if (urbanLateral && veryLowAlt && divingFast && action.joyY < 0.22) {
            action.joyY = 0.22;
            if (action.fire !== 'none') action.fire = 'none';
            return action;
        }
        if (altitude < profile.bandMin && action.joyY > 0) return action;
        if (coverInfo.collisionRisk === 'high' && altitude < profile.bandMax + 12) return action;
        if (profile.needsLevelOut && action.joyY > 0) {
            action.joyY = Math.min(action.joyY, profile.levelOutJoyY);
        } else if (profile.needsSoftCap && action.joyY > 0.08 && coverInfo.collisionRisk !== 'high') {
            action.joyY = this.clamp(action.joyY * 0.15, -0.22, 0.06);
        } else if (altitude > profile.bandMax && action.joyY > 0) {
            action.joyY = Math.min(action.joyY, -0.08);
        }
        return action;
    },

    getTrackKey(teamId) {
        return `${teamId}->${this.getEnemyId(teamId)}`;
    },

    getContactKey(teamId) {
        return `${teamId}|contact`;
    },

    updateContactMemory(teamId, payload) {
        const key = this.getContactKey(teamId);
        this.contactMemory[key] = {
            ...(this.contactMemory[key] || {}),
            ...payload
        };
        return this.contactMemory[key];
    },

    getContactMemory(teamId) {
        return this.contactMemory[this.getContactKey(teamId)] || null;
    },

    getLoopKey(teamId) {
        return `${teamId}|loop`;
    },

    updateLoopMemory(teamId, payload) {
        const key = this.getLoopKey(teamId);
        this.loopMemory[key] = {
            ...(this.loopMemory[key] || {}),
            ...payload
        };
        return this.loopMemory[key];
    },

    evaluateLoopTrap(teamId, distance, angleDeg, localX, turnNo = 1) {
        const key = this.getLoopKey(teamId);
        const prev = this.loopMemory[key] || null;
        let loopCount = prev ? Number(prev.loopCount || 0) : 0;
        if (prev && Number.isFinite(prev.distance) && Number.isFinite(prev.angleDeg) && Number.isFinite(prev.localX)) {
            const distDelta = Math.abs(distance - prev.distance);
            const angleDelta = Math.abs(angleDeg - prev.angleDeg);
            const localXDelta = Math.abs(localX - prev.localX);
            const circleLikely = distance < 95 && distDelta < 4.5 && angleDelta < 9 && localXDelta < 0.35;
            if (circleLikely) loopCount += 1;
            else loopCount = Math.max(0, loopCount - 1);
        }
        this.updateLoopMemory(teamId, { distance, angleDeg, localX, loopCount, turnNo });
        return {
            loopCount,
            loopTrap: loopCount >= 3
        };
    },

    updateLowAltRecoveryLock(teamId, altitude, turnNo = 1) {
        const key = `${teamId}|lowAltRecover`;
        const prev = this.lowAltRecoveryMemory[key] || { untilTurn: -1 };
        let untilTurn = Number(prev.untilTurn || -1);
        if (altitude < 6) {
            if (turnNo > untilTurn) untilTurn = turnNo + 5;
        } else if (altitude >= 18) {
            untilTurn = -1;
        }
        const active = untilTurn >= 0 && turnNo <= untilTurn;
        this.lowAltRecoveryMemory[key] = { untilTurn };
        return { active, untilTurn };
    },

    updatePostGroundRecoveryLock(teamId, altitude, forwardY, turnNo = 1) {
        const tuning = this.getTuning();
        const clearAlt = Number(tuning.combatBandMin) || 35;
        const climbFloor = this.getMandatoryClimbAlt(tuning);
        const key = `${teamId}|postGroundRecover`;
        const prev = this.postGroundRecoveryMemory[key] || { untilTurn: -1 };
        let untilTurn = Number(prev.untilTurn || -1);
        if (altitude < climbFloor || (altitude < 24 && forwardY < -0.25)) {
            if (turnNo > untilTurn) untilTurn = turnNo + 8;
            // Arm multi-turn climb-out so engagement/opening cannot steal the next sticks.
            this.armNavClimbOut(teamId, {
                turnNo,
                holdTurns: 8,
                targetAlt: clearAlt,
                source: altitude < climbFloor ? 'mandatoryClimb' : 'postGround'
            });
        } else if (altitude >= clearAlt && forwardY > -0.12) {
            untilTurn = -1;
        }
        const active = untilTurn >= 0 && turnNo <= untilTurn;
        this.postGroundRecoveryMemory[key] = { untilTurn };
        return { active, untilTurn };
    },

    armNavClimbOut(teamId, {
        turnNo = 1,
        side = 0,
        targetAlt = null,
        holdTurns = 8,
        source = 'climbOut'
    } = {}) {
        const tuning = this.getTuning();
        const target = Number.isFinite(Number(targetAlt))
            ? Number(targetAlt)
            : (Number(tuning.combatBandMin) || 35);
        const prev = this.navIntentMemory[teamId];
        const nextUntil = turnNo + Math.max(1, Number(holdTurns) || 8);
        const sameMode = prev && prev.mode === 'climbOut';
        const keepUntil = sameMode && Number.isFinite(Number(prev.untilTurn))
            ? Math.max(nextUntil, Number(prev.untilTurn))
            : nextUntil;
        const sideSign = Math.sign(side || 0) || (sameMode ? Math.sign(prev.side || 0) : 0);
        this.navIntentMemory[teamId] = {
            mode: 'climbOut',
            side: sideSign,
            targetAlt: sameMode
                ? Math.max(Number(prev.targetAlt) || 0, target)
                : target,
            untilTurn: keepUntil,
            source: source || (sameMode ? prev.source : 'climbOut')
        };
        return this.navIntentMemory[teamId];
    },

    clearNavIntent(teamId) {
        if (this.navIntentMemory[teamId]) delete this.navIntentMemory[teamId];
    },

    /**
     * Clear climb-out only when truly out of the canyon/roof trap — not merely past combatBandMin.
     * T41: alt≈41 with roof≈0–1 still cleared → alignFirst/orbit dumped the jet.
     * T112: target ratcheted to 72 via preferRoofExit while already lane=combat + clear roof → stuck climb.
     */
    isNavClimbOutClearanceOk(altitude, forwardY, coverInfo = {}, altitudeLane = null, targetAlt = 35, opts = {}) {
        const alt = Number(altitude);
        const fwdY = Number(forwardY);
        const tuning = this.getTuning();
        const bandMin = Number(tuning.combatBandMin) || 35;
        const target = Number.isFinite(Number(targetAlt)) ? Number(targetAlt) : bandMin;
        if (!Number.isFinite(alt)) return false;
        if (!Number.isFinite(fwdY) || fwdY < -0.12) return false;
        const roof = Number(coverInfo && coverInfo.roofClearance);
        const coverDist = Number(coverInfo && coverInfo.distance);
        const aiSoftClear = !!(opts.aiMapClearAbove || opts.aiMapSkyOpen);
        // Soft: beside-tall AABB roof<4 is not a climb trap when aiMap says clear above (T150 red2).
        const roofTrap =
            Number.isFinite(roof) &&
            roof < 4 &&
            !(
                aiSoftClear &&
                alt >= bandMin &&
                coverInfo.collisionRisk !== 'high' &&
                (!Number.isFinite(coverDist) || coverDist >= 18)
            );
        if (roofTrap) return false;
        const lane = altitudeLane && altitudeLane.lane;
        if (lane === 'dirt') return false;
        if (lane === 'canyon' && !(aiSoftClear && alt >= bandMin)) return false;
        // Escaped trap: combat/rooftop band with open roof — do not demand full roofEscape (72m).
        const openLane = lane === 'combat' || lane === 'rooftop' || lane === 'high' || !lane;
        const roofOpen =
            !Number.isFinite(roof) ||
            roof >= 6 ||
            (
                aiSoftClear &&
                coverInfo.collisionRisk !== 'high' &&
                (!Number.isFinite(coverDist) || coverDist >= 18)
            );
        if (openLane && alt >= bandMin && roofOpen) {
            return true;
        }
        // Soft: past combat band with aiMap clear — stop chasing stale 72m roof target.
        if (aiSoftClear && alt >= bandMin && coverInfo.collisionRisk !== 'high') {
            return true;
        }
        if (alt < target) return false;
        if (altitudeLane && altitudeLane.preferRoofExit) {
            const roofBand = Number(altitudeLane.roofEscape) || 80;
            if (alt < Math.min(target, roofBand - 8) && Number.isFinite(roof) && roof < 10 && !aiSoftClear) return false;
        }
        return true;
    },

    resolveNavClimbOutTarget(altitudeLane = null, coverInfo = {}, fallback = 35, opts = {}) {
        const bandMin = Number.isFinite(Number(fallback)) ? Number(fallback) : 35;
        const roofEscape = Number(altitudeLane && altitudeLane.roofEscape) || 80;
        const roof = Number(coverInfo && coverInfo.roofClearance);
        const coverDist = Number(coverInfo && coverInfo.distance);
        // Soft: bare roof<4 at range / aiMap clear is beside-tall, not canyon trap (T150).
        const underRoof =
            this.isTrueUnderRoof(coverInfo, opts) ||
            (
                Number.isFinite(roof) &&
                roof < 4 &&
                Number.isFinite(coverDist) &&
                coverDist < 16 &&
                !(opts.aiMapClearAbove || opts.aiMapSkyOpen)
            );
        const lane = altitudeLane && altitudeLane.lane;
        // Only raise toward roof band while actually trapped — not merely preferRoofExit in combat lane (T112).
        const canyonish =
            underRoof ||
            lane === 'canyon' ||
            lane === 'dirt';
        if (canyonish) return Math.max(bandMin, Math.min(roofEscape - 4, 72));
        return bandMin;
    },

    /**
     * Sync climb-out nav intent: refresh side/target, clear only when canyon/roof-safe.
     * Combat/opening must not cancel this.
     */
    syncNavClimbOut(teamId, {
        altitude,
        forwardY,
        turnNo = 1,
        side = 0,
        postGroundActive = false,
        coverInfo = null,
        altitudeLane = null,
        aiMapClearAbove = false,
        aiMapSkyOpen = false
    } = {}) {
        const tuning = this.getTuning();
        const bandMin = Number(tuning.combatBandMin) || 35;
        const aiMapOpts = { aiMapClearAbove: !!aiMapClearAbove, aiMapSkyOpen: !!aiMapSkyOpen };
        const desiredTarget = this.resolveNavClimbOutTarget(altitudeLane, coverInfo || {}, bandMin, aiMapOpts);
        let intent = this.navIntentMemory[teamId] || null;

        if (postGroundActive && (!intent || intent.mode !== 'climbOut')) {
            intent = this.armNavClimbOut(teamId, {
                turnNo,
                side,
                targetAlt: desiredTarget,
                holdTurns: 8,
                source: 'postGround'
            });
        }

        if (!intent || intent.mode !== 'climbOut') {
            return {
                active: false,
                untilTurn: -1,
                targetAlt: desiredTarget,
                side: 0,
                source: null,
                clearanceOk: true
            };
        }

        // Raise while trapped; lower back to bandMin once out of canyon/roof (do not ratchet forever to 72).
        const roofNow = Number(coverInfo && coverInfo.roofClearance);
        const laneNow = altitudeLane && altitudeLane.lane;
        const escapedTrap =
            (!Number.isFinite(roofNow) || roofNow >= 6) &&
            laneNow !== 'canyon' &&
            laneNow !== 'dirt';
        if (escapedTrap) {
            intent.targetAlt = Math.min(Number(intent.targetAlt) || desiredTarget, desiredTarget);
        } else {
            intent.targetAlt = Math.max(Number(intent.targetAlt) || 0, desiredTarget);
        }

        const targetAlt = Number.isFinite(Number(intent.targetAlt)) ? Number(intent.targetAlt) : desiredTarget;
        const sideSign = Math.sign(side || 0) || Math.sign(intent.side || 0) || 0;
        if (sideSign && sideSign !== Math.sign(intent.side || 0)) {
            if (!intent.side) intent.side = sideSign;
        } else if (sideSign) {
            intent.side = sideSign;
        }

        const clearanceOk = this.isNavClimbOutClearanceOk(
            altitude,
            forwardY,
            coverInfo || {},
            altitudeLane,
            targetAlt,
            aiMapOpts
        );
        if (clearanceOk) {
            this.clearNavIntent(teamId);
            return {
                active: false,
                untilTurn: -1,
                targetAlt,
                side: intent.side || 0,
                source: intent.source || null,
                clearanceOk: true
            };
        }

        if (turnNo > Number(intent.untilTurn || -1)) {
            // Still trapped: extend rather than hand sticks to alignFirst/orbit.
            intent.untilTurn = turnNo + 5;
        }

        this.navIntentMemory[teamId] = intent;
        return {
            active: true,
            untilTurn: intent.untilTurn,
            targetAlt,
            side: intent.side || 0,
            source: intent.source || 'climbOut',
            clearanceOk: false
        };
    },

    isNavClimbOutActive(teamId, turnNo = 1) {
        const intent = this.navIntentMemory[teamId];
        if (!intent || intent.mode !== 'climbOut') return false;
        return turnNo <= Number(intent.untilTurn || -1);
    },

    buildNavClimbOutAction({
        altitude,
        forwardY,
        heat = 0,
        side = 0,
        targetAlt = 35,
        maxPitchCmd = 1,
        source = 'climbOut',
        coverInfo = null
    } = {}) {
        const tuning = this.getTuning();
        const bandMin = Number(tuning.combatBandMin) || 35;
        // Once past combat band, do not keep yanking toward a stale 72m roof target (T112 blue).
        const climbGoal = altitude >= bandMin
            ? Math.min(Number(targetAlt) || bandMin, Math.max(bandMin, altitude + 6))
            : (Number(targetAlt) || bandMin);
        const bandRemaining = Math.max(0, climbGoal - altitude);
        const steepDive = forwardY < -0.35;
        const recoveryThrottle = steepDive
            ? this.getEmergencyRecoveryThrottle(altitude, forwardY, heat)
            : (heat > 78 ? 4 : 5);
        const sideSign = Math.sign(side || 0);
        // Mild committed bank only — hard reacquire joyX is what dumps altitude after climb.
        const joyX = sideSign
            ? this.clamp(sideSign * (altitude < 18 ? 0.22 : 0.28), -0.32, 0.32)
            : 0;
        const roof = Number(coverInfo && coverInfo.roofClearance);
        const roofPressure = Number.isFinite(roof) && roof < 4;
        const sinking = forwardY < -0.05;
        // T150 blue2: alt≥bandMin used joyY≈0.22 beside tall AABB (roof<0) while “open” fwd —
        // soft climb → nose drop → dive into next facade in visually open lane.
        let joyY;
        if (steepDive) {
            joyY = 0.95;
        } else if (roofPressure || sinking) {
            joyY = altitude < 28 ? 0.72 : (altitude < 42 ? 0.58 : 0.48);
            if (Number.isFinite(roof) && roof < 0) joyY = Math.max(joyY, 0.52);
            if (sinking) joyY = Math.max(joyY, altitude < 40 ? 0.68 : 0.58);
        } else if (altitude >= bandMin) {
            const hardTarget = Number(targetAlt) || bandMin;
            const toHard = hardTarget - altitude;
            if (toHard > 12 && forwardY < 0.12) joyY = 0.42;
            else if (bandRemaining > 4) joyY = 0.28;
            else joyY = 0.08;
        } else {
            joyY = altitude < this.getMandatoryClimbAlt(tuning)
                ? Math.max(0.58, this.getMandatoryClimbJoyY(altitude))
                : (bandRemaining > 20 ? 0.62 : (bandRemaining > 12 ? 0.52 : (bandRemaining > 6 ? 0.38 : 0.22)));
        }
        return {
            state: 'postGroundClimbOut',
            statusText: `NPC: 航路爬升脫谷 ${altitude.toFixed(1)}m→${Math.round(climbGoal)}m`,
            throttle: recoveryThrottle,
            joyX,
            joyY,
            pitchCmd: steepDive
                ? -maxPitchCmd
                : (-maxPitchCmd * (altitude >= bandMin
                    ? ((roofPressure || sinking) ? 0.42 : 0.22)
                    : (bandRemaining > 10 ? 0.52 : 0.34))),
            roll: this.clamp(joyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
            weapon: 'gun',
            queueAction: 'none',
            ready: true,
            navMode: 'climbOut',
            reason: `Nav climb-out commitment (${source}): hold until roof/canyon-clear before reacquire`
        };
    },

    getBrakeTurnMemory(teamId) {
        return this.brakeTurnMemory[teamId] || { lastTurn: -99 };
    },

    markBrakeTurn(teamId, turnNo = 1) {
        this.brakeTurnMemory[teamId] = { lastTurn: turnNo };
    },

    isDenseUrbanContext(arenaMode, obstacles) {
        const count = Array.isArray(obstacles) ? obstacles.length : 0;
        return arenaMode === 'dense-urban' || arenaMode === 'obstacle-stress' || count >= 8;
    },

    getRoutePlanHorizon() {
        const n = Number(this.getTuning().routePlanHorizon);
        if (Number.isFinite(n) && n >= 2 && n <= 8) return Math.floor(n);
        return 4;
    },

    getRouteBeamWidth() {
        const n = Number(this.getTuning().routeBeamWidth);
        if (Number.isFinite(n) && n >= 2 && n <= 6) return Math.floor(n);
        return 2;
    },

    shouldUseRouteBeam(coverInfo = {}, opts = {}) {
        if (opts.beam === false) return false;
        if (opts.beam === true) return true;
        const minRisk = String(
            (opts.tuning && opts.tuning.routeBeamMinRisk) ||
            this.getTuning().routeBeamMinRisk ||
            'medium'
        );
        const risk = String((coverInfo && coverInfo.collisionRisk) || 'low');
        if (minRisk === 'low') return true;
        if (minRisk === 'high') return risk === 'high';
        // medium (default): medium or high
        return risk === 'medium' || risk === 'high';
    },

    buildUrbanRouteContinuation(base, candidate, team, altitude, stepIndex, energyBad = false) {
        // Soften further steps so raising horizon does not echo hard yanks.
        const scale = energyBad
            ? (stepIndex === 1 ? 0.48 : (stepIndex === 2 ? 0.32 : (stepIndex <= 4 ? 0.24 : 0.18)))
            : (stepIndex === 1 ? 0.72 : (stepIndex === 2 ? 0.58 : (stepIndex === 3 ? 0.48 : 0.38)));
        const joyXCap = energyBad ? 0.55 : 0.82;
        const minJoyY = energyBad
            ? (altitude < 22 ? 0.18 : 0.06)
            : (altitude < 35 ? 0.24 : 0.1);
        const maxJoyY = energyBad ? 0.42 : 0.72;
        const rollScale = stepIndex === 1 ? 0.7 : (stepIndex === 2 ? 0.55 : (stepIndex === 3 ? 0.45 : 0.35));
        const thr = candidate.brakeTurn
            ? (team.heat > 78 ? 3 : (energyBad ? 3 : 5))
            : (energyBad
                ? this.pickThrottleForTurn(candidate.throttle || 3, (candidate.joyX || 0) * scale, {
                    heat: team.heat || 0,
                    ap: team.ap,
                    energyCritical: true,
                    lowAp: this.getTuning().lowAp
                })
                : candidate.throttle);
        return {
            ...base,
            state: `${candidate.state}Continue${stepIndex}`,
            throttle: thr,
            joyX: this.clamp((candidate.joyX || 0) * scale, -joyXCap, joyXCap),
            joyY: this.clamp(
                Math.max(candidate.joyY || 0, minJoyY) * (energyBad ? 0.75 : 1),
                -0.15,
                maxJoyY
            ),
            roll: this.clamp((candidate.roll || 0) * rollScale, -Math.PI / 8, Math.PI / 8),
            reason: energyBad ? 'Urban planner continuation (energy-soft)' : 'Urban planner continuation'
        };
    },

    /**
     * Limited strategy branches for step N (not same-stick echo only).
     * Prototypes: hold | flip | climb | levelHold.
     */
    buildRouteBranchActions(base, candidate, team, altitude, stepIndex, energyBad = false, opts = {}) {
        const coverInfo = opts.coverInfo || {};
        const gapW = Number(coverInfo.corridorGap);
        const corridorOpen =
            !!coverInfo.corridorClear ||
            (Number.isFinite(gapW) && gapW >= 8);
        const side = Math.sign(Number(candidate.joyX) || 0)
            || Math.sign(Number(opts.preferredSide) || 0)
            || 1;
        const hold = this.buildUrbanRouteContinuation(base, candidate, team, altitude, stepIndex, energyBad);
        hold.branch = 'hold';
        hold.state = `${candidate.state}Hold${stepIndex}`;

        const climbAuth = energyBad ? 0.22 : 0.28;
        const climbY = energyBad
            ? (altitude < 28 ? 0.36 : 0.22)
            : (altitude < 22 ? 0.58 : (altitude < 36 ? 0.46 : 0.32));
        const climb = {
            ...base,
            state: `${candidate.state}Climb${stepIndex}`,
            branch: 'climb',
            throttle: team.heat > 78 ? 3 : (energyBad ? 3 : 4),
            joyX: this.clamp(side * climbAuth, -0.36, 0.36),
            joyY: climbY,
            roll: this.clamp(side * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
            reason: 'Urban planner branch: climb / stop sink'
        };

        const levelY = altitude < 28 ? 0.42 : (altitude < 40 ? 0.28 : 0.14);
        const levelHold = {
            ...base,
            state: `${candidate.state}Level${stepIndex}`,
            branch: 'levelHold',
            throttle: team.heat > 82 ? 3 : 4,
            joyX: this.clamp(side * (energyBad ? 0.26 : 0.34), -0.42, 0.42),
            joyY: levelY,
            roll: this.clamp(side * Math.PI / 11, -Math.PI / 11, Math.PI / 11),
            reason: 'Urban planner branch: level-hold altitude'
        };

        const flip = {
            ...base,
            state: `${candidate.state}Flip${stepIndex}`,
            branch: 'flip',
            throttle: hold.throttle,
            joyX: this.clamp(-side * Math.min(0.48, Math.abs(Number(hold.joyX) || 0.32) + 0.08), -0.55, 0.55),
            joyY: Math.max(Number(hold.joyY) || 0, altitude < 30 ? 0.28 : 0.12),
            roll: this.clamp(-side * Math.PI / 10, -Math.PI / 10, Math.PI / 10),
            reason: 'Urban planner branch: opposite-side cut'
        };

        const branches = [];
        // Corridor open: do not expand flat thr4 lateral (joyY≈0) — prefer climb/level.
        const holdFlat = Math.abs(Number(hold.joyY) || 0) < 0.12 && Math.abs(Number(hold.joyX) || 0) >= 0.4;
        if (!(corridorOpen && holdFlat)) branches.push(hold);
        branches.push(climb);
        branches.push(levelHold);
        if (!opts.meshEmbed && stepIndex <= 3) branches.push(flip);
        return branches;
    },

    shouldPruneRouteEval(evalResult, team, stepIndex = 1) {
        if (!evalResult) return true;
        if (evalResult.buildingHit) return true;
        if (Number.isFinite(evalResult.minAltitude) && evalResult.minAltitude < 6) return true;
        const startY = team && team.wrapper ? Number(team.wrapper.position.y) : null;
        if (
            Number.isFinite(startY) &&
            Number.isFinite(evalResult.minAltitude) &&
            stepIndex >= 2 &&
            (startY - evalResult.minAltitude) > 22
        ) {
            return true;
        }
        if (Number.isFinite(evalResult.sink) && evalResult.sink > 26 && stepIndex >= 3) return true;
        return false;
    },

    /**
     * Beam-search branched continuations for WEGO multi-step scoring.
     * horizon=5 → root + 4 branched steps; beam keeps top-K survivors.
     */
    beamSearchRouteContinuations(teamId, base, candidate, team, altitude, energyBad = false, opts = {}) {
        const horizon = Math.max(2, Number(opts.horizon) || this.getRoutePlanHorizon());
        const beamWidth = Math.max(2, Number(opts.beamWidth) || this.getRouteBeamWidth());
        const coverInfo = opts.coverInfo || {};
        const tuning = opts.tuning || this.getTuning();
        const pitch = opts.selfPitch;
        const ap = opts.selfAp;

        const rootEval = this.evaluateActionSafety(teamId, candidate, []);
        if (this.shouldPruneRouteEval(rootEval, team, 1)) {
            return { conts: [], eval: rootEval, pruned: true, beam: true };
        }

        let beam = [{ conts: [], eval: rootEval }];
        for (let step = 1; step < horizon; step++) {
            const next = [];
            for (let b = 0; b < beam.length; b++) {
                const node = beam[b];
                const branches = this.buildRouteBranchActions(
                    base, candidate, team, altitude, step, energyBad, opts
                );
                for (let i = 0; i < branches.length; i++) {
                    const br = branches[i];
                    if (typeof this.adjustActionForCombatBand === 'function') {
                        this.adjustActionForCombatBand(br, altitude, coverInfo, tuning, pitch, ap);
                    }
                    const conts = node.conts.concat([br]);
                    const ev = this.evaluateActionSafety(teamId, candidate, conts);
                    if (this.shouldPruneRouteEval(ev, team, step + 1)) continue;
                    next.push({ conts, eval: ev });
                }
            }
            if (!next.length) {
                // All branches pruned — fall back to linear softened hold chain.
                const linear = this.buildLinearRouteContinuations(
                    base, candidate, team, altitude, energyBad, opts, horizon
                );
                const linEval = this.evaluateActionSafety(teamId, candidate, linear);
                return {
                    conts: linear,
                    eval: linEval,
                    pruned: this.shouldPruneRouteEval(linEval, team, horizon),
                    beam: true,
                    fallback: true
                };
            }
            next.sort((a, b) => (b.eval.score || 0) - (a.eval.score || 0));
            beam = next.slice(0, beamWidth);
        }
        return { conts: beam[0].conts, eval: beam[0].eval, pruned: false, beam: true };
    },

    buildLinearRouteContinuations(base, candidate, team, altitude, energyBad, opts, horizon) {
        const coverInfo = opts.coverInfo || {};
        const tuning = opts.tuning || this.getTuning();
        const pitch = opts.selfPitch;
        const ap = opts.selfAp;
        const conts = [];
        const h = Math.max(2, Number(horizon) || this.getRoutePlanHorizon());
        for (let i = 1; i < h; i++) {
            const cont = this.buildUrbanRouteContinuation(base, candidate, team, altitude, i, energyBad);
            if (typeof this.adjustActionForCombatBand === 'function') {
                this.adjustActionForCombatBand(cont, altitude, coverInfo, tuning, pitch, ap);
            }
            conts.push(cont);
        }
        return conts;
    },

    /**
     * Build horizon continuations. Prefer beamSearchRouteContinuations when eval is needed.
     * Without teamId, falls back to linear softened holds.
     */
    buildRouteContinuations(base, candidate, team, altitude, energyBad = false, opts = {}) {
        const horizon = opts.horizon || this.getRoutePlanHorizon();
        if (opts.beam === false || !opts.teamId) {
            return this.buildLinearRouteContinuations(
                base, candidate, team, altitude, energyBad, opts, horizon
            );
        }
        const result = this.beamSearchRouteContinuations(
            opts.teamId, base, candidate, team, altitude, energyBad, opts
        );
        return result.conts;
    },

    pickUrbanRoute(teamId, ctx, debugBase, tree) {
        const urbanRoute = this.planUrbanRoute(teamId, ctx);
        if (!urbanRoute) return null;
        const urbanMode = urbanRoute.state;
        tree.push(`urbanRouteGate: selected=${urbanRoute.urbanRoute.source} score=${urbanRoute.urbanRoute.score} nb=${urbanRoute.urbanRoute.nearestBuilding}`);
        const ur = urbanRoute.urbanRoute || {};
        tree.push(
            `routeEnergy: ap0=${ur.startAP != null ? ur.startAP : 'n/a'} apN=${ur.finalAP != null ? ur.finalAP : 'n/a'} drop=${ur.apDrop != null ? ur.apDrop : 'n/a'} sink=${ur.sink != null ? ur.sink : 'n/a'} joyX=${ur.joyX != null ? ur.joyX : 'n/a'} thr=${ur.thr != null ? ur.thr : 'n/a'} bad=${ur.energyBad || 0} pick=${ur.source || urbanMode}`
        );
        tree.push(`routeBeam: horizon=${this.getRoutePlanHorizon()} beam=${this.getRouteBeamWidth()} gated=${this.shouldUseRouteBeam(ctx.coverInfo || {}, { tuning: this.getTuning() }) ? 1 : 0}`);
        tree.push(`altitudeLane: lane=${ur.lane || 'n/a'} roofExit=${ur.roofExit || 0} straightClimb=${ur.straightClimb || 0} facade=${ur.facadeClosing || 0} embed=${ur.meshEmbed || 0}`);
        if (
            urbanMode === 'urbanBuildingWeave' ||
            (urbanRoute.urbanRoute && urbanRoute.urbanRoute.source === 'urbanBuildingWeave')
        ) {
            const weaveSide = Math.sign(urbanRoute.joyX || 0) || Math.sign(ctx.preferredSide || 0) || 1;
            const gapTier = this.getCorridorGapTier(ctx.coverInfo || {}).tier;
            const holdTurns = (gapTier === 'wide' || gapTier === 'ok' || !!(ctx.coverInfo && ctx.coverInfo.corridorClear))
                ? 3
                : 4;
            this.updateUrbanAvoidMemory(teamId, weaveSide, Number(ctx.turnNo || 1), holdTurns, {
                gapHoldUntil: Number(ctx.turnNo || 1) + holdTurns,
                gapHoldSource: 'urbanBuildingWeave'
            });
            tree.push(`gapHold: arm=1 side=${weaveSide} until=${Number(ctx.turnNo || 1) + holdTurns} tier=${gapTier}`);
        } else if (
            urbanRoute.urbanRoute &&
            (urbanRoute.urbanRoute.gapTier === 'wide' || urbanRoute.urbanRoute.gapTier === 'ok') &&
            (urbanMode === 'urbanRouteEscape' || urbanMode === 'urbanRouteSide' || urbanMode === 'urbanPreemptiveRoute')
        ) {
            const holdSide = Math.sign(urbanRoute.joyX || 0) || Math.sign(ctx.preferredSide || 0) || 1;
            this.updateUrbanAvoidMemory(teamId, holdSide, Number(ctx.turnNo || 1), 3, {
                gapHoldUntil: Number(ctx.turnNo || 1) + 3,
                gapHoldSource: urbanRoute.urbanRoute.source || urbanMode
            });
            tree.push(`gapHold: arm=1 side=${holdSide} until=${Number(ctx.turnNo || 1) + 3} tier=${urbanRoute.urbanRoute.gapTier}`);
        }
        // Climb-out / roof-lane picks arm multi-turn nav so engagement cannot cancel next turn.
        const climbOutStates = new Set([
            'urbanRouteClimbOut',
            'urbanRoofClimb'
        ]);
        const climbSource = (urbanRoute.urbanRoute && urbanRoute.urbanRoute.source) || urbanMode;
        if (
            climbOutStates.has(urbanMode) ||
            climbOutStates.has(climbSource) ||
            (typeof climbSource === 'string' && /RouteClimbOut|RoofClimb|climbOut/i.test(climbSource))
        ) {
            const climbSide = Math.sign(urbanRoute.joyX || 0) || Math.sign(ctx.preferredSide || 0) || 0;
            this.armNavClimbOut(teamId, {
                turnNo: Number(ctx.turnNo || 1),
                side: climbSide,
                targetAlt: this.resolveNavClimbOutTarget(
                    ctx.altitudeLane || null,
                    ctx.coverInfo || {},
                    Number(this.getTuning().combatBandMin) || 35
                ),
                holdTurns: 6,
                source: climbSource || 'urbanRoute'
            });
        }
        // Building escape must not drop IR defense: flare on the same stick inputs when FOX-2 is inbound.
        const flareWhileEscape =
            !!ctx.actualMissileThreat &&
            !!ctx.canUseFlare &&
            !!ctx.flareCooldownReady &&
            !ctx.shouldSaveFlare &&
            !ctx.lineOfSightBlocked &&
            Number(ctx.altitude) >= 14;
        if (flareWhileEscape) {
            tree.push('urbanRouteGate: flareWhileEscape=1');
        }
        this.enforceFacadeLateralFloor(
            urbanRoute,
            ctx.coverInfo || {},
            Math.sign(urbanRoute.joyX || 0) || Math.sign(ctx.preferredSide || 0) || 1
        );
        return this.withDebug({
            ...urbanRoute,
            state: flareWhileEscape ? 'defensiveFlare' : urbanMode,
            statusText: flareWhileEscape
                ? `NPC: 避撞熱焰 ${Math.floor(Number(debugBase.coverDistance) || Number(ctx.coverInfo && ctx.coverInfo.distance) || 0)}m`
                : urbanRoute.statusText,
            weapon: 'gun',
            queueAction: flareWhileEscape ? 'flare' : 'none',
            ready: true,
            reason: flareWhileEscape
                ? `${urbanRoute.reason || 'Urban escape'} | flare while building-escaping`
                : (urbanRoute.reason || 'WEGO urban route planner selected a safe multi-step route')
        }, debugBase, [...tree, `selected: ${flareWhileEscape ? 'defensiveFlare-urbanEscape' : `${urbanMode}(${urbanRoute.urbanRoute.source})`}`], flareWhileEscape ? 'defensiveFlare' : urbanMode);
    },

    /**
     * Score a simulated approach for energy + corridor geometry + tactical geometry vs enemy.
     * Base safety comes from evaluateActionSafety; this layer prefers "平时" doctrine.
     */
    scoreTacticalApproach(evalResult, candidate, ctx = {}) {
        let score = Number(evalResult && evalResult.score) || 0;
        const tuning = this.getTuning();
        const bandMin = Number(tuning.combatBandMin) || 35;
        const bandMax = Number(tuning.combatBandMax) || 92;
        const coverInfo = ctx.coverInfo || {};
        const corridor = !!coverInfo.corridorClear;
        const urban = !!ctx.urbanArenaMode;
        const nb = Number(evalResult && evalResult.nearestBuilding);
        const finalAP = Number(evalResult && evalResult.finalAP);
        const apDrop = Number(evalResult && evalResult.apDrop);
        const finalAngle = Number(evalResult && evalResult.finalAngleDeg);
        const minAlt = Number(evalResult && evalResult.minAltitude);
        const turnAuth = Math.abs(Number(candidate.joyX) || 0);
        const thr = Number(candidate.throttle) || 0;
        const startAngle = Number(ctx.angleDeg);
        const headOn = Number(ctx.headOnFactor);
        const distance = Number(ctx.distance);
        const altitude = Number(ctx.altitude);

        if (evalResult && evalResult.buildingHit) score -= 80;
        if (Number.isFinite(minAlt) && minAlt < 12) score -= 60;

        // Energy: prefer rebuild / retain AP.
        if (Number.isFinite(finalAP)) {
            if (finalAP >= 100) score += 36;
            else if (finalAP >= 90) score += 28;
            else if (finalAP >= 80) score += 16;
            else if (finalAP < 65) score -= 40;
            else if (finalAP < 75) score -= 18;
        }
        if (Number.isFinite(apDrop) && apDrop > 18) {
            score -= Math.min(50, (apDrop - 18) * (turnAuth >= 0.5 ? 2.0 : 1.1));
        }
        if (thr >= 4 && turnAuth <= 0.4) score += 22;
        if (thr >= 5 && turnAuth <= 0.28) score += 12;
        if (turnAuth >= 0.7) score -= urban ? 28 : 18;

        // Building corridor: sweet-spot distance / shallow cut.
        if (urban && Number.isFinite(nb)) {
            if (corridor && nb >= 6 && nb <= 14) score += 48;
            else if (nb >= 8 && nb <= 22) score += 28;
            else if (nb < 5) score -= corridor ? 35 : 70;
            else if (nb > 40) score -= 12;
            if (corridor) score += 16;
        }

        // Altitude band / perch.
        if (Number.isFinite(minAlt)) {
            if (minAlt >= bandMin && minAlt <= bandMax) score += 24;
            else if (minAlt < bandMin - 6) score -= 22;
            else if (minAlt > bandMax + 8) score -= 16;
        }
        if (Number.isFinite(altitude) && altitude < bandMin && (candidate.joyY || 0) > 0.08 && (candidate.joyY || 0) < 0.45) {
            score += 14;
        }

        // Tactical geometry: close angle without forcing head-on knife.
        if (Number.isFinite(finalAngle) && Number.isFinite(startAngle)) {
            const improved = startAngle - finalAngle;
            if (improved > 8) score += Math.min(36, improved * 0.55);
            if (finalAngle < 35) score += 18;
            else if (finalAngle < 55) score += 10;
            else if (finalAngle > 110) score -= 12;
        }
        if (Number.isFinite(headOn) && headOn > 0.55 && Number.isFinite(distance) && distance < 70) {
            score -= 30;
        }
        if (Number.isFinite(distance) && distance > 90 && turnAuth <= 0.35 && thr >= 4) {
            score += 12; // patient close from afar
        }

        // Candidate role bias.
        const st = String(candidate.state || '');
        if (st === 'tacticalEnergyCruise' || st === 'tacticalEnergyCruiseCut') score += 18;
        if (st === 'tacticalCorridorCut') score += urban ? 20 : 4;
        if (st === 'tacticalLagPursuit') score += 14;
        if (st === 'tacticalHighPerch') score += 10;
        if (st === 'tacticalBeamReposition') score += 8;
        if (st === 'tacticalLeadIntercept') score += urban ? 4 : 16;
        if (st === 'tacticalSearchCruise') score += 20;

        return Number(score.toFixed(1));
    },

    planTacticalApproach(teamId, ctx) {
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (!team || !ctx) return null;
        // Allow memory / passive bearing search — not only live contact (T112 searchIntercept joy≈0).
        if (!ctx.sensorContact && !ctx.sensorMemory && !ctx.passiveSearch) return null;
        if (ctx.navClimbOutActive || ctx.groundRisk || ctx.energyCritical) return null;
        if (ctx.actualMissileThreat) return null;
        if (ctx.mandatoryMergeBreak || ctx.knifeMidair) return null;
        if (ctx.collisionRisk === 'high') return null;
        if (ctx.reliableShootWindow) return null;

        const tuning = this.getTuning();
        const altitude = Number(ctx.altitude || 0);
        const coverInfo = ctx.coverInfo || {};
        const urban = !!ctx.urbanArenaMode;
        const side = Math.sign(ctx.preferredSide || ctx.breakSide || 1) || 1;
        const hx = Number(ctx.horizontalBias) || 0;
        const vy = Number(ctx.verticalBias) || 0;
        const heat = Number(team.heat) || 0;
        const energyBad = !!ctx.energyLow || (Number(team.ap) || 0) < (tuning.lowAp || 65);
        const bandMin = Number(tuning.combatBandMin) || 35;
        const cruiseThr = heat > 78 ? 4 : 5;
        const base = { weapon: 'gun', queueAction: 'none', ready: true };
        const horizon = this.getRoutePlanHorizon();

        const candidates = [];
        candidates.push({
            ...base,
            state: 'tacticalEnergyCruise',
            statusText: 'NPC: 戰術接近-補能直飛',
            throttle: cruiseThr,
            joyX: this.clamp(side * 0.08, -0.14, 0.14),
            joyY: altitude < bandMin ? 0.22 : (altitude < bandMin + 20 ? 0.1 : 0.02),
            roll: this.clamp(side * Math.PI / 18, -Math.PI / 16, Math.PI / 16),
            reason: 'Tactical approach: energy cruise toward band'
        });
        candidates.push({
            ...base,
            state: 'tacticalEnergyCruiseCut',
            statusText: 'NPC: 戰術接近-補能淺切',
            throttle: cruiseThr,
            joyX: this.clamp(side * 0.28, -0.36, 0.36),
            joyY: altitude < bandMin ? 0.18 : 0.08,
            roll: this.clamp(side * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
            reason: 'Tactical approach: shallow energy cut'
        });
        if (urban) {
            candidates.push({
                ...base,
                state: 'tacticalCorridorCut',
                statusText: 'NPC: 戰術接近-縫道淺切',
                throttle: heat > 82 ? 3 : 4,
                joyX: this.clamp(side * (coverInfo.corridorClear ? 0.32 : 0.4), -0.48, 0.48),
                joyY: altitude < bandMin ? 0.2 : 0.06,
                roll: this.clamp(side * Math.PI / 10, -Math.PI / 9, Math.PI / 9),
                reason: 'Tactical approach: corridor-friendly shallow cut'
            });
        }
        candidates.push({
            ...base,
            state: 'tacticalLagPursuit',
            statusText: 'NPC: 戰術接近-落後追擊',
            throttle: heat > 75 ? 3 : 4,
            joyX: this.clamp(hx * 0.55 + side * 0.12, -0.55, 0.55),
            joyY: this.clamp(vy * 0.35 + (altitude < bandMin ? 0.12 : 0), -0.2, 0.32),
            roll: this.clamp((hx * 0.55) * Math.PI / 7, -Math.PI / 7, Math.PI / 7),
            reason: 'Tactical approach: lag pursuit (avoid head-on thrash)'
        });
        candidates.push({
            ...base,
            state: 'tacticalHighPerch',
            statusText: 'NPC: 戰術接近-高度優勢',
            throttle: cruiseThr,
            joyX: this.clamp(hx * 0.35, -0.4, 0.4),
            joyY: altitude < bandMin + 10 ? 0.34 : (altitude < bandMin + 28 ? 0.16 : -0.06),
            roll: this.clamp(hx * Math.PI / 9, -Math.PI / 8, Math.PI / 8),
            reason: 'Tactical approach: climb/hold combat perch'
        });
        candidates.push({
            ...base,
            state: 'tacticalBeamReposition',
            statusText: 'NPC: 戰術接近-側向占位',
            throttle: heat > 78 ? 3 : 4,
            joyX: this.clamp(side * 0.48, -0.58, 0.58),
            joyY: altitude < bandMin ? 0.16 : 0.04,
            roll: this.clamp(side * Math.PI / 8, -Math.PI / 7, Math.PI / 7),
            reason: 'Tactical approach: beam reposition for better aspect'
        });
        if (!urban || coverInfo.collisionRisk === 'low') {
            candidates.push({
                ...base,
                state: 'tacticalLeadIntercept',
                statusText: 'NPC: 戰術接近-前置攔截',
                throttle: heat > 72 ? 3 : 4,
                joyX: this.clamp(hx * 0.85, -0.7, 0.7),
                joyY: this.clamp(vy * 0.45, -0.22, 0.28),
                roll: this.clamp(hx * Math.PI / 5.5, -Math.PI / 5, Math.PI / 5),
                reason: 'Tactical approach: lead intercept (open/low building risk)'
            });
        }
        if (ctx.passiveSearch || (!ctx.sensorContact && ctx.sensorMemory)) {
            candidates.push({
                ...base,
                state: 'tacticalSearchCruise',
                statusText: 'NPC: 戰術接近-搜索補能',
                throttle: cruiseThr,
                joyX: this.clamp((hx || side * 0.2) * 0.4, -0.42, 0.42),
                joyY: altitude < bandMin ? 0.18 : 0.06,
                roll: this.clamp(side * Math.PI / 14, -Math.PI / 12, Math.PI / 12),
                reason: 'Tactical approach: search cruise instead of zero-stick searchIntercept'
            });
        }

        let best = null;
        let bestScore = -9999;
        let bestEval = null;
        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            if (energyBad && Math.abs(candidate.joyX || 0) > 0.55) {
                candidate.joyX = this.clamp(candidate.joyX, -0.5, 0.5);
            }
            // Tactical approach: linear continuations only (beam was expensive every calm turn).
            const conts = this.buildLinearRouteContinuations(
                base, candidate, team, altitude, energyBad,
                { coverInfo, tuning, selfPitch: ctx.forwardY, selfAp: team.ap },
                Math.min(3, this.getRoutePlanHorizon())
            );
            const ev = this.evaluateActionSafety(teamId, candidate, conts);
            // Do not hard-skip urban buildingHit — score penalty handles it (T112 all-skip → searchIntercept).
            if (Number.isFinite(ev.minAltitude) && ev.minAltitude < 6) continue;
            const score = this.scoreTacticalApproach(ev, candidate, ctx);
            if (score > bestScore) {
                bestScore = score;
                best = candidate;
                bestEval = ev;
            }
        }
        if (!best || !bestEval) return null;
        // Reject only clearly suicidal winners.
        if (bestEval.buildingHit && Number.isFinite(bestEval.minAltitude) && bestEval.minAltitude < 12) {
            return null;
        }
        if (bestScore < 20) return null;

        return {
            ...best,
            tacticalApproach: {
                source: best.state,
                score: bestScore,
                horizon,
                nearestBuilding: bestEval.nearestBuilding,
                finalAP: bestEval.finalAP,
                apDrop: bestEval.apDrop,
                finalAngleDeg: bestEval.finalAngleDeg,
                minAltitude: bestEval.minAltitude
            }
        };
    },

    pickTacticalApproach(teamId, ctx, debugBase, tree) {
        const planned = this.planTacticalApproach(teamId, ctx);
        if (!planned) {
            if (Array.isArray(tree)) tree.push('tacticalApproach: none');
            return null;
        }
        const meta = planned.tacticalApproach || {};
        if (Array.isArray(tree)) {
            tree.push(
                `tacticalApproach: selected=${meta.source} score=${meta.score} horizon=${meta.horizon} nb=${meta.nearestBuilding} apN=${meta.finalAP} ang=${meta.finalAngleDeg}`
            );
        }
        return this.withDebug({
            ...planned,
            ready: true,
            weapon: planned.weapon || 'gun',
            queueAction: planned.queueAction || 'none'
        }, debugBase, [...(tree || []), `selected: ${planned.state}`], planned.state);
    },

    getUrbanAvoidMemory(teamId) {
        return this.urbanAvoidMemory[teamId] || {
            side: 0,
            untilTurn: -1,
            lastFlipTurn: -999,
            gluePushStreak: 0,
            gapHoldUntil: -1,
            gapHoldSource: null
        };
    },

    updateUrbanAvoidMemory(teamId, side, turnNo = 1, holdTurns = 4, patch = null) {
        const prev = this.getUrbanAvoidMemory(teamId);
        const stableSide = Math.sign(side || 0);
        if (!stableSide) return prev;
        const nextUntil = turnNo + holdTurns;
        const prevUntil = Number(prev.untilTurn);
        // Same-side refresh must not shrink a longer mesh-glue lock (T29).
        const untilTurn = (stableSide === Math.sign(prev.side || 0) && Number.isFinite(prevUntil))
            ? Math.max(nextUntil, prevUntil)
            : nextUntil;
        const prevStreak = Number(prev.gluePushStreak) || 0;
        const sameSide = stableSide === Math.sign(prev.side || 0);
        // Only embed-glue path passes gluePushStreak explicitly; other refreshes preserve/reset.
        const gluePushStreak = (patch && patch.gluePushStreak != null)
            ? Number(patch.gluePushStreak)
            : (sameSide ? prevStreak : 0);
        const { gluePushStreak: _dropStreak, ...restPatch } =
            (patch && typeof patch === 'object') ? patch : {};
        // Preserve gap-hold fields unless patch replaces them or side flips.
        const gapHoldUntil = (restPatch.gapHoldUntil != null)
            ? Number(restPatch.gapHoldUntil)
            : (sameSide ? Number(prev.gapHoldUntil || -1) : -1);
        const gapHoldSource = (restPatch.gapHoldSource != null)
            ? restPatch.gapHoldSource
            : (sameSide ? prev.gapHoldSource : null);
        this.urbanAvoidMemory[teamId] = {
            side: stableSide,
            untilTurn,
            lastFlipTurn: Number.isFinite(Number(prev.lastFlipTurn)) ? Number(prev.lastFlipTurn) : -999,
            gluePushStreak,
            gapHoldUntil,
            gapHoldSource,
            ...restPatch
        };
        return this.urbanAvoidMemory[teamId];
    },

    evaluateSensorContact(teamId, selfPos, selfForward, enemyPos, enemyForward, turnNo = 1, arenaMode = 'buildings') {
        const distance = selfPos.distanceTo(enemyPos);
        const toEnemy = enemyPos.clone().sub(selfPos);
        const toEnemyNorm = toEnemy.lengthSq() > 0.0001 ? toEnemy.clone().normalize() : new THREE.Vector3(0, 0, 1);
        const angleDeg = selfForward.angleTo(toEnemyNorm) * 180 / Math.PI;
        const losBlocked = this.hasObstacleBetween(selfPos, enemyPos);
        const enemyAspectDeg = enemyForward.angleTo(selfPos.clone().sub(enemyPos).normalize()) * 180 / Math.PI;
        const sensorProfile = this.getSensorProfile(arenaMode);

        // Radar: range + limited off-boresight; visual stays angle-sensitive.
        const radarRange = sensorProfile.radarRange;
        const visualRange = sensorProfile.visualRange;
        const radarContact = distance <= radarRange && (!losBlocked || distance < sensorProfile.radarLosRange);
        const visualContact = distance <= visualRange && angleDeg < sensorProfile.visualAngleDeg && !losBlocked;
        const closeMergeContact = distance < 36;
        const seenNow = radarContact || visualContact || closeMergeContact;

        const prev = this.getContactMemory(teamId);
        let memoryTurnsLeft = prev ? Number(prev.memoryTurnsLeft || 0) : 0;
        if (seenNow) {
            memoryTurnsLeft = losBlocked ? sensorProfile.memoryBlocked : sensorProfile.memoryClear;
            this.updateContactMemory(teamId, {
                turn: turnNo,
                lastSeenPos: enemyPos.clone(),
                lastSeenForward: enemyForward.clone(),
                memoryTurnsLeft,
                seenNow: true
            });
        } else if (prev) {
            memoryTurnsLeft = Math.max(0, memoryTurnsLeft - 1);
            this.updateContactMemory(teamId, {
                ...prev,
                memoryTurnsLeft,
                seenNow: false
            });
        }

        const memory = this.getContactMemory(teamId);
        const hasMemory = !!(memory && memory.lastSeenPos && memory.memoryTurnsLeft > 0);
        const hasContact = seenNow || hasMemory;

        return {
            hasContact,
            seenNow,
            hasMemory,
            distance: Number(distance.toFixed(1)),
            angleDeg: Number(angleDeg.toFixed(1)),
            enemyAspectDeg: Number(enemyAspectDeg.toFixed(1)),
            losBlocked,
            radarContact,
            visualContact,
            closeMergeContact,
            memoryTurnsLeft,
            memoryPos: hasMemory ? memory.lastSeenPos.clone() : null,
            memoryForward: hasMemory && memory.lastSeenForward ? memory.lastSeenForward.clone() : null
        };
    },

    updateWeaponRangeMode(teamId, distance, tuning = this.getTuning(), urbanArenaMode = false, coverInfo = null) {
        const openSky = !urbanArenaMode && (!coverInfo || coverInfo.collisionRisk === 'low');
        const gunClose = this.gunRangeOr(tuning) + (openSky ? 22 : 10);
        const hysteresis = openSky ? 18 : 15;
        const prev = this.weaponRangeMemory[teamId] || 'missile';
        let next = prev;
        if (distance < gunClose) {
            next = 'gun';
        } else if (prev === 'gun') {
            if (distance > (gunClose + hysteresis)) next = 'missile';
        } else if (distance < (gunClose - 8)) {
            next = 'gun';
        }
        this.weaponRangeMemory[teamId] = next;
        return next;
    },

    getObstacles() {
        if (typeof GameContext !== 'undefined' && GameContext.three && Array.isArray(GameContext.three.obstacles)) {
            return GameContext.three.obstacles;
        }
        if (typeof window !== 'undefined' && Array.isArray(window.obstacles)) return window.obstacles;
        return [];
    },

    /** Thin baked AI map (layer B). Null until map load finishes bake/sidecar. */
    getAiMap() {
        if (typeof GameContext !== 'undefined' && GameContext.three && GameContext.three.aiMap) {
            return GameContext.three.aiMap;
        }
        return null;
    },

    queryAiMap(x, z) {
        const map = this.getAiMap();
        if (!map || typeof AirArenaAiMap === 'undefined' || !AirArenaAiMap.query) return null;
        return AirArenaAiMap.query(map, x, z);
    },

    queryAiMapRoofMaxInRadius(x, z, radius = 80) {
        const map = this.getAiMap();
        if (!map || typeof AirArenaAiMap === 'undefined' || !AirArenaAiMap.queryRoofMaxInRadius) {
            return null;
        }
        return AirArenaAiMap.queryRoofMaxInRadius(map, x, z, radius);
    },

    /**
     * Soft spatial read from baked AI map (layer B). Never hard-forces sticks —
     * only clears false "beside-tall-AABB" pressure when locally sky-open.
     */
    sampleAiMapContext(selfPos, opts = {}) {
        const empty = {
            available: false,
            skyOpen: false,
            sarhPerch: false,
            cellRoofMax: 0,
            localRoofMax: 0,
            clearAbove: false,
            margin: null
        };
        if (!selfPos) return empty;
        const cell = this.queryAiMap(selfPos.x, selfPos.z);
        const local = this.queryAiMapRoofMaxInRadius(
            selfPos.x,
            selfPos.z,
            Number(opts.radius) || 80
        );
        if (!cell && !(local && local.ok)) return empty;
        const cellRoof = cell && cell.ok ? Number(cell.roofMax) || 0 : 0;
        const localRoof = (local && local.ok) ? Number(local.roofMax) || 0 : cellRoof;
        const alt = Number(opts.altitude != null ? opts.altitude : selfPos.y);
        const margin = Number.isFinite(alt) ? alt - localRoof : null;
        const skyOpen = !!(cell && cell.skyOpen) || (Number.isFinite(margin) && margin >= 8);
        const sarhPerch = !!(cell && cell.sarhPerch) || (Number.isFinite(margin) && margin >= 12 && localRoof < 32);
        const clearAbove =
            Number.isFinite(margin) &&
            margin >= 8 &&
            (skyOpen || sarhPerch || localRoof < 40);
        return {
            available: true,
            skyOpen,
            sarhPerch,
            cellRoofMax: cellRoof,
            localRoofMax: localRoof,
            clearAbove,
            margin: Number.isFinite(margin) ? Number(margin.toFixed(1)) : null,
            lane: cell && cell.lane ? cell.lane : null
        };
    },

    /** Prefer cached world AABB within one AI run (buildings static mid-decide). */
    fillObstacleWorldBox(obj, box) {
        if (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.getCachedWorldBox) {
            return AirArenaBuildingRisk.getCachedWorldBox(obj, box);
        }
        box.setFromObject(obj);
        return box;
    },

    hasObstacleBetween(fromPos, toPos) {
        const obstacles = this.getObstacles();
        if (!obstacles || obstacles.length === 0) return false;
        const dir = toPos.clone().sub(fromPos);
        const dist = dir.length();
        if (dist < 0.001) return false;
        this.raycaster.set(fromPos, dir.normalize());
        this.raycaster.near = 0.1;
        this.raycaster.far = dist;
        const hits = this.raycaster.intersectObjects(obstacles, true);
        return hits.length > 0 && hits[0].distance < dist;
    },

    actionToCommand(team, action) {
        const acConfig = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts) ? CONFIG.aircrafts[team.type || 'mig21'] : null;
        const maxYaw = acConfig ? acConfig.maxYaw : Math.PI / 4;
        const maxPitch = acConfig ? acConfig.maxPitch : Math.PI / 3;
        const maxRoll = acConfig ? acConfig.maxRoll : Math.PI / 4;
        const joyX = typeof action.joyX === 'number' ? action.joyX : (team.joyX || 0);
        const joyY = typeof action.joyY === 'number' ? action.joyY : (team.joyY || 0);
        const yawCmd = typeof action.yawCmd === 'number' ? action.yawCmd : null;
        const pitchCmd = typeof action.pitchCmd === 'number' ? action.pitchCmd : null;
        let roll = typeof action.roll === 'number' ? action.roll : joyX * (Math.PI / 4);
        if (team.gLimiterOn) roll = this.clamp(roll, -maxRoll, maxRoll);
        return {
            yaw: yawCmd !== null ? this.clamp(yawCmd, -maxYaw, maxYaw) : this.clamp(-(joyX * maxYaw), -maxYaw, maxYaw),
            pitch: pitchCmd !== null ? this.clamp(pitchCmd, -maxPitch, maxPitch) : this.clamp(-(joyY * maxPitch), -maxPitch, maxPitch),
            roll,
            throttle: action.throttle || team.throttle || 4,
            fire: action.queueAction || 'none'
        };
    },

    evaluateActionSafety(teamId, action, continuationActions = []) {
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        const enemy = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(this.getEnemyId(teamId)) : null;
        if (!team || !team.wrapper || typeof simulateFlight !== 'function') {
            return { score: 0, safe: true, minAltitude: null, buildingHit: false, finalAP: null };
        }

        const commands = [action, ...continuationActions].map((item) => this.actionToCommand(team, item));
        const sim = simulateFlight(team, commands);
        const points = sim.points || [];
        const obstacles = this.getObstacles();
        let minAltitude = Infinity;
        let buildingHit = false;
        let nearestBuilding = Infinity;
        const box = new THREE.Box3();
        const clamped = new THREE.Vector3();

        for (let i = 0; i < points.length; i++) {
            minAltitude = Math.min(minAltitude, points[i].y);
            for (let j = 0; j < obstacles.length; j++) {
                this.fillObstacleWorldBox(obstacles[j], box);
                box.clampPoint(points[i], clamped);
                nearestBuilding = Math.min(nearestBuilding, clamped.distanceTo(points[i]));
                // AABB contain is soft proximity only — fat boxes false-positive in gaps.
                // Hard buildingHit comes from segment raycast against real meshes below.
            }
            if (i > 0 && obstacles.length > 0) {
                const move = points[i].clone().sub(points[i - 1]);
                const dist = move.length();
                if (dist > 0.0001) {
                    this.raycaster.set(points[i - 1], move.normalize());
                    this.raycaster.near = 0;
                    this.raycaster.far = dist;
                    if (this.raycaster.intersectObjects(obstacles, true).length > 0) buildingHit = true;
                }
            }
        }

        const finalPos = points.length ? points[points.length - 1] : team.wrapper.position;
        const finalQuat = sim.quats && sim.quats.length ? sim.quats[sim.quats.length - 1] : team.wrapper.quaternion;
        const finalForward = new THREE.Vector3(0, 0, 1).applyQuaternion(finalQuat).normalize();
        const startForward = new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize();
        const finalForwardY = finalForward.y;
        const startForwardY = startForward.y;
        let finalAngleDeg = 180;
        if (enemy && enemy.wrapper) {
            const toEnemy = enemy.wrapper.position.clone().sub(finalPos).normalize();
            finalAngleDeg = finalForward.angleTo(toEnemy) * 180 / Math.PI;
        }

        const finalAP = typeof sim.finalAP === 'number' ? sim.finalAP : team.ap;
        const startAP = Number.isFinite(Number(team.ap)) ? Number(team.ap) : finalAP;
        const apDrop = Math.max(0, startAP - finalAP);
        const turnAuth = Math.abs(Number(action.joyX) || 0);
        const startAlt = Number(team.wrapper.position.y);
        const sink = (Number.isFinite(minAltitude) && Number.isFinite(startAlt))
            ? Math.max(0, startAlt - minAltitude)
            : 0;
        let score = 100;
        if (buildingHit) score -= 220;
        if (minAltitude < 3) score -= 220;
        else if (minAltitude < 10) score -= 120;
        else if (minAltitude < 14) score -= 90;
        else if (minAltitude < 18) score -= 65;
        if (nearestBuilding < 4) score -= 140;
        else if (nearestBuilding < 10) score -= 55;
        // Graded AP survival: punish burn before the stall floor (mid-low hard-turn death spiral).
        if (finalAP < 45) score -= 120;
        else if (finalAP < 55) score -= 70;
        else if (finalAP < 65) score -= 40;
        else if (finalAP < 75) score -= 18;
        if (apDrop > 35 && turnAuth >= 0.55) score -= 55;
        else if (apDrop > 25 && turnAuth >= 0.45) score -= 35;
        else if (apDrop > 18 && turnAuth >= 0.55) score -= 22;
        if (minAltitude < 38 && turnAuth >= 0.7 && finalAP < 80) score -= 28;
        // Net altitude bleed over the horizon (dump sink cascades).
        if (sink > 6) score -= Math.min(90, (sink - 6) * 4);
        if (sink > 14) score -= Math.min(80, (sink - 14) * 5);
        if (finalForwardY < -0.45) score -= 50;
        else if (finalForwardY < -0.28) score -= 28;
        if (startForwardY < -0.25 && finalForwardY < -0.2 && sink > 4) score -= 40;
        const climbLoopRisk = finalAP < 75 && finalForwardY > 0.28;
        if (climbLoopRisk) score -= 110;
        if (finalAP < 85 && startForwardY > 0.25 && finalForwardY > startForwardY - 0.03) score -= 70;
        score += this.clamp((90 - finalAngleDeg) / 90, -1, 1) * 30;
        if (action.queueAction === 'missile' && action.debug && !action.debug.missileLock) score -= 80;

        return {
            score: Number(score.toFixed(1)),
            safe: score > 0 && !buildingHit && minAltitude >= 3 && finalAP >= (Number((typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stallSpeedAP) || 35)) && !climbLoopRisk,
            minAltitude: Number((Number.isFinite(minAltitude) ? minAltitude : -1).toFixed(1)),
            buildingHit,
            nearestBuilding: Number((Number.isFinite(nearestBuilding) ? nearestBuilding : -1).toFixed(1)),
            finalAP: Number(finalAP.toFixed(1)),
            startAP: Number(startAP.toFixed(1)),
            apDrop: Number(apDrop.toFixed(1)),
            sink: Number(sink.toFixed(1)),
            finalAngleDeg: Number(finalAngleDeg.toFixed(1)),
            finalForwardY: Number(finalForwardY.toFixed(2)),
            climbLoopRisk
        };
    },

    /**
     * How likely the targeted foe will dump flares into our FOX-2 (ammo + geometry).
     */
    estimateEnemyFlareWasteRisk(enemy, opts = {}) {
        const ammo = Math.max(0, Number(enemy && enemy.flareAmmo) || 0);
        const dist = Number(opts.distance);
        const flareUseDistance = Number(opts.flareUseDistance);
        const losBlocked = !!opts.lineOfSightBlocked;
        let score = 0;
        if (ammo >= 3) score += 0.55;
        else if (ammo >= 2) score += 0.4;
        else if (ammo === 1) score += 0.18;
        if (Number.isFinite(dist) && Number.isFinite(flareUseDistance) && dist < flareUseDistance) score += 0.22;
        else if (Number.isFinite(dist) && dist < 90) score += 0.12;
        if (!losBlocked) score += 0.14;
        const aspect = Number(opts.enemyAspectDeg);
        if (Number.isFinite(aspect) && aspect < 70) score += 0.1;
        score = this.clamp(score, 0, 1);
        const ammoGate = Number(opts.likelyAmmo != null ? opts.likelyAmmo : 2);
        const likely = ammo >= ammoGate || score >= 0.55;
        return { ammo, score, likely };
    },

    /**
     * Prefer single FOX-2 when foe can flare-waste a salvo; otherwise roll dual chance.
     * Returns { singleMissile, dual, reason, enemyFlare }.
     */
    resolveMissileSalvoMode(enemy, opts = {}, tuning = this.getTuning(), rng = Math.random) {
        const doctrine = this.getMunitionDoctrine(opts.missileType || 'fox2');
        if (doctrine && doctrine.dualSalvoOk === false) {
            return {
                singleMissile: true,
                dual: false,
                reason: 'munitionDoctrineSingle',
                enemyFlare: this.estimateEnemyFlareWasteRisk(enemy, {
                    distance: opts.distance,
                    flareUseDistance: opts.flareUseDistance,
                    lineOfSightBlocked: opts.lineOfSightBlocked,
                    enemyAspectDeg: opts.enemyAspectDeg,
                    likelyAmmo: tuning.enemyFlareLikelyAmmo
                }),
                roll: 0
            };
        }
        const risk = this.estimateEnemyFlareWasteRisk(enemy, {
            distance: opts.distance,
            flareUseDistance: opts.flareUseDistance,
            lineOfSightBlocked: opts.lineOfSightBlocked,
            enemyAspectDeg: opts.enemyAspectDeg,
            likelyAmmo: tuning.enemyFlareLikelyAmmo
        });
        const roll = typeof rng === 'function' ? rng() : Math.random();
        if (risk.likely) {
            return { singleMissile: true, dual: false, reason: 'enemyFlareLikely', enemyFlare: risk, roll };
        }
        const dualChance = risk.ammo <= 0
            ? (Number(tuning.missileSalvoDualChanceNoFlare) || 0.48)
            : (Number(tuning.missileSalvoDualChance) || 0.22) * (risk.ammo === 1 ? 0.45 : 1);
        const dual = roll < dualChance;
        return {
            singleMissile: !dual,
            dual,
            reason: dual ? (risk.ammo <= 0 ? 'dualNoEnemyFlare' : 'dualRoll') : 'singleRoll',
            enemyFlare: risk,
            roll
        };
    },

    /**
     * Soften deterministic flare dumps: urgent inbound almost always kept; soft threats jitter.
     */
    applyFlareDecisionJitter(shouldFlare, opts = {}, tuning = this.getTuning(), rng = Math.random) {
        if (!shouldFlare) return false;
        const roll = typeof rng === 'function' ? rng() : Math.random();
        if (opts.actualMissileThreat || opts.urgentMissileThreat) {
            const keep = Number(tuning.flareUrgentKeepChance);
            return roll < (Number.isFinite(keep) ? keep : 0.96);
        }
        const soft = Number(tuning.flareSoftKeepChance);
        return roll < (Number.isFinite(soft) ? soft : 0.72);
    },

    /**
     * Final gate: salvo mode + flare jitter tags on the chosen action.
     */
    applyMissileSalvoAndFlareDoctrine(action, ctx = {}) {
        if (!action || typeof action !== 'object') return action;
        const tuning = ctx.tuning || this.getTuning();
        const enemy = ctx.enemy || null;
        const tree = (action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : null;

        if (action.queueAction === 'flare') {
            const keep = this.applyFlareDecisionJitter(true, {
                actualMissileThreat: ctx.actualMissileThreat,
                urgentMissileThreat: ctx.urgentMissileThreat
            }, tuning, ctx.rng);
            if (!keep) {
                action.queueAction = 'none';
                if (action.state === 'defensiveFlare') {
                    action.state = 'evade';
                    action.statusText = (action.statusText || 'NPC: 飛彈威脅').replace('釋放熱焰', '急轉規避');
                    action.reason = `${action.reason || 'Flare'} | flareJitterSkip`;
                }
                if (!action.debug) action.debug = {};
                action.debug.flareJitterSkip = 1;
                if (tree) tree.push('flareDoctrine: jitterSkip=1');
            } else if (tree) {
                tree.push('flareDoctrine: jitterKeep=1');
            }
        }

        const shooting = action.queueAction === 'missile';
        const prepping = !!action.powerPylons && action.weapon === 'missile';
        if (shooting || prepping) {
            const salvo = this.resolveMissileSalvoMode(enemy, {
                distance: ctx.distance,
                flareUseDistance: ctx.flareUseDistance,
                lineOfSightBlocked: ctx.lineOfSightBlocked,
                enemyAspectDeg: ctx.enemyAspectDeg,
                missileType: ctx.missileType || action.missileType || (action.debug && action.debug.aiMissileType) || 'fox2'
            }, tuning, ctx.rng);
            if (shooting) {
                action.singleMissile = !!salvo.singleMissile;
            }
            if (prepping || shooting) {
                action.powerPylonCount = salvo.singleMissile ? 1 : 2;
            }
            if (!action.debug) action.debug = {};
            action.debug.missileSalvo = salvo.reason;
            action.debug.enemyFlareRisk = Number((salvo.enemyFlare && salvo.enemyFlare.score) || 0).toFixed(2);
            action.debug.enemyFlareAmmo = (salvo.enemyFlare && salvo.enemyFlare.ammo) || 0;
            if (tree) {
                tree.push(
                    `missileSalvo: single=${salvo.singleMissile ? 1 : 0} reason=${salvo.reason} foeFlare=${action.debug.enemyFlareAmmo}@${action.debug.enemyFlareRisk}`
                );
            }
        }
        return action;
    },

    isOffensiveSafetyProtected(action, coverInfo = {}, safetyEval = {}) {
        if (!action || !safetyEval || safetyEval.buildingHit || !safetyEval.safe) return false;
        if (coverInfo.collisionRisk === 'high') return false;
        if (action.state === 'gunAttack' && action.queueAction === 'gun') return true;
        if (action.state === 'missileAttack' && action.queueAction === 'missile') return true;
        if (action.state === 'missilePrep' && (action.powerPylons || action.queueAction === 'missile')) return true;
        return false;
    },

    preserveOffensiveQueue(chosen, action, coverInfo, safetyEval) {
        if (!chosen || !action || chosen === action) return chosen;
        if (!this.isOffensiveSafetyProtected(action, coverInfo, safetyEval)) return chosen;
        if (action.queueAction && action.queueAction !== 'none') {
            chosen.queueAction = action.queueAction;
            chosen.weapon = action.weapon || chosen.weapon;
        }
        if (action.powerPylons) chosen.powerPylons = true;
        if (action.powerPylonCount != null) chosen.powerPylonCount = action.powerPylonCount;
        if (action.singleMissile != null) chosen.singleMissile = !!action.singleMissile;
        return chosen;
    },

    chooseSafeAction(teamId, action) {
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (!team) return action;
        const tuning = this.getTuning();
        const base = { weapon: 'gun', queueAction: 'none', ready: true };
        const teamForwardY = team.wrapper ? new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).y : 0;
        const lowEnergy = (team.ap || 120) < 75;
        const energyCriticalNow = !!team.stalled || (Number(team.ap) < Number(tuning.energyCriticalAp || 52));
        // Do not gate stall-trap on minRecoverAlt — T25 stalled at ~20m and skipped nose-down filter.
        const stallTrapNow = !!team.stalled && teamForwardY > tuning.stallPitchThreshold;
        const selfPos = team.wrapper && team.wrapper.position ? team.wrapper.position : null;
        const selfForward = team.wrapper ? new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize() : null;
        const coverInfo = (selfPos && selfForward) ? this.getCoverInfo(selfPos, selfForward, team.ap || team.speed || 120) : { collisionRisk: 'low', distance: Infinity, forwardDistance: Infinity };
        // Only count buildings ahead — negative forwardDistance means behind and must not force climb-out.
        const fwdAhead = Number(coverInfo.forwardDistance);
        const aheadThreat = Number.isFinite(fwdAhead) && fwdAhead > 0 && fwdAhead < 14;
        const corridorOk = !!coverInfo.corridorClear && coverInfo.collisionRisk !== 'high';
        const hardContact = this.isHardBuildingContact(coverInfo);
        const obstaclePressure =
            !corridorOk &&
            (
                hardContact ||
                coverInfo.collisionRisk === 'high' ||
                coverInfo.distance < 8 ||
                aheadThreat ||
                (coverInfo.collisionRisk === 'medium' && coverInfo.distance < 12)
            );
        const acConfig = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts) ? CONFIG.aircrafts[team.type || 'mig21'] : null;
        const maxPitchCmd = acConfig ? acConfig.maxPitch : Math.PI / 3;
        const altNow = selfPos ? Number(selfPos.y) : 99;
        // Near-dirt SURVIVAL (not only dive): T29 red2 was stalled/flat at alt~2.6 and still got safetyBreak.
        const nearDirtCrisis =
            altNow < 10 &&
            (
                teamForwardY < -0.08 ||
                !!team.stalled ||
                energyCriticalNow ||
                (altNow < 6 && teamForwardY < 0.15)
            );
        const dirtDiveThreat = (altNow < 16 && teamForwardY < -0.12) || nearDirtCrisis;
        const dirtDiveHard = (altNow < 10 && teamForwardY < -0.28) || (nearDirtCrisis && altNow < 6);
        const embedNow =
            hardContact &&
            ((Number.isFinite(Number(coverInfo.distance)) && Number(coverInfo.distance) < 3) ||
                (Number.isFinite(Number(coverInfo.roofClearance)) &&
                    Number(coverInfo.roofClearance) < 0 &&
                    Number.isFinite(Number(coverInfo.distance)) &&
                    Number(coverInfo.distance) < 6));
        // T28: stalled+embed must not nose-down / level-out inside mesh.
        const embedStallCrisis = embedNow && (!!team.stalled || energyCriticalNow || altNow < 22);
        // T31: already glued to mesh (cover≈0.3) even without stall — lateral push, not canyonDivePull.
        const embedMeshCrisis =
            embedNow ||
            (hardContact && Number.isFinite(Number(coverInfo.distance)) && Number(coverInfo.distance) < 2);
        let candidates = [
            action,
            { ...base, state: 'safetyLevelOut', statusText: 'NPC: 安全預演-放平加速', throttle: team.heat > 78 ? 3 : 5, joyX: 0, joyY: 0.05, roll: 0, reason: 'Safety fallback level-out' },
            { ...base, state: 'safetyShallowClimb', statusText: 'NPC: 安全預演-淺爬升', throttle: team.heat > 78 ? 3 : 4, joyX: 0, joyY: 0.18, roll: 0, reason: 'Safety fallback shallow climb' },
            { ...base, state: 'safetyUnclimb', statusText: 'NPC: 安全預演-放平回能', throttle: team.heat > 78 ? 3 : 4, joyX: 0, joyY: team.wrapper && team.wrapper.position.y > 24 ? -0.08 : 0, roll: 0, reason: 'Safety fallback break climb loop' },
            { ...base, state: 'safetyStallBreakout', statusText: 'NPC: 安全預演-失速改出', throttle: team.heat > 78 ? 4 : 5, joyX: 0, joyY: selfPos && selfPos.y < 22 ? 0.62 : (selfPos && selfPos.y > 38 ? -0.45 : -0.08), pitchCmd: selfPos && selfPos.y < 22 ? -(maxPitchCmd * 0.5) : (selfPos && selfPos.y > 38 ? Math.PI / 7 : Math.PI / 10), roll: 0, reason: `Safety fallback stall breakout bonus=${Number(tuning.stallRecoverBonus).toFixed(2)}` },
            { ...base, state: 'safetyBreakLeft', statusText: 'NPC: 安全預演-左脫離', throttle: 4, joyX: -0.55, joyY: 0.12, roll: -Math.PI / 6, reason: 'Safety fallback left break' },
            { ...base, state: 'safetyBreakRight', statusText: 'NPC: 安全預演-右脫離', throttle: 4, joyX: 0.55, joyY: 0.12, roll: Math.PI / 6, reason: 'Safety fallback right break' }
        ];
        // Soft stall breakout when near buildings — never joyY≤0 into mesh (T28 red at alt~23).
        if (hardContact || embedNow || altNow < 28) {
            candidates = candidates.map((c) => {
                if (c.state !== 'safetyStallBreakout') return c;
                return {
                    ...c,
                    joyX: this.clamp((Math.sign(action.joyX || 0) || 1) * 0.42, -0.55, 0.55),
                    joyY: altNow < 18 ? 0.55 : 0.28,
                    pitchCmd: -maxPitchCmd * 0.35,
                    throttle: 3,
                    roll: this.clamp((Math.sign(action.joyX || 0) || 1) * Math.PI / 10, -Math.PI / 10, Math.PI / 10),
                    reason: 'Safety stall breakout near buildings: soft lateral, no nose-down into mesh'
                };
            });
        }
        if (embedStallCrisis || embedMeshCrisis) {
            const pushSide = Math.sign(action.joyX || 0)
                || ((coverInfo.direction && selfForward)
                    ? Math.sign(
                        coverInfo.direction.x * (-selfForward.z) + coverInfo.direction.z * selfForward.x
                    )
                    : 0)
                || ((coverInfo.direction && selfForward)
                    ? Math.sign(selfForward.clone().cross(coverInfo.direction).y || 0)
                    : 0)
                || 1;
            const deepEmbedSafety =
                Number.isFinite(Number(coverInfo.distance)) && Number(coverInfo.distance) < 1.5;
            // T9: steep dive into mesh at alt~40 with joyY=0.48 still smashed — lateral first;
            // only pull hard when truly near dirt. T26: alt~2 needs dirt budget.
            const steepDiveEmbed = teamForwardY < -0.35;
            const embedJoyY = altNow < 3
                ? (steepDiveEmbed ? 0.78 : 0.62)
                : (altNow < 12
                    ? (steepDiveEmbed ? 0.62 : 0.5)
                    : (steepDiveEmbed
                        ? (altNow < 22 ? 0.36 : 0.22)
                        : (altNow < 16 ? 0.28 : 0.1)));
            const embedPitchScale = altNow < 3
                ? 0.7
                : (altNow < 12
                    ? (steepDiveEmbed ? 0.55 : 0.4)
                    : (steepDiveEmbed ? 0.28 : 0.12));
            const embedPush = {
                ...base,
                state: 'safetyEmbedPushOut',
                statusText: 'NPC: 安全預演-嵌樓推出',
                throttle: team.heat > 82 ? 3 : 4,
                joyX: this.clamp(pushSide * (deepEmbedSafety ? 0.56 : 0.52), -0.62, 0.62),
                joyY: embedJoyY,
                pitchCmd: -maxPitchCmd * embedPitchScale,
                roll: this.clamp(pushSide * Math.PI / 9, -Math.PI / 9, Math.PI / 9),
                obstacleFallback: true,
                diveLevelPull: !!(steepDiveEmbed && altNow < 18),
                reason: steepDiveEmbed
                    ? 'Safety embed steep-dive: thr4 lateral, soft level (no climb into mesh)'
                    : (embedStallCrisis
                        ? 'Safety embed+stall: thr4 horizontal push-out, no level/nose-down'
                        : 'Safety embed mesh: thr4 preferred-side push-out before canyon dive-pull')
            };
            candidates.splice(1, 0, embedPush);
            if (deepEmbedSafety) {
                candidates.splice(2, 0, {
                    ...embedPush,
                    state: 'safetyEmbedPushOutOpposite',
                    statusText: 'NPC: 安全預演-嵌樓反側',
                    joyX: this.clamp(-pushSide * 0.5, -0.52, 0.52),
                    roll: this.clamp(-pushSide * Math.PI / 9, -Math.PI / 9, Math.PI / 9),
                    reason: 'Safety deep embed: try opposite thr4 lateral push-out'
                });
            }
        }
        if (dirtDiveThreat || nearDirtCrisis) {
            const pullSide = Math.sign(action.joyX || 0) || ((GameContext.getFaction && GameContext.getFaction(team.id)) === 'blue' ? -1 : 1);
            const pullY = dirtDiveHard || nearDirtCrisis ? 0.88 : 0.72;
            candidates.splice(1, 0,
                {
                    ...base,
                    state: 'safetyGroundPull',
                    statusText: 'NPC: 安全預演-近地拉起',
                    throttle: team.heat > 86 ? 4 : 5,
                    joyX: this.clamp(pullSide * 0.28, -0.4, 0.4),
                    joyY: pullY,
                    pitchCmd: -maxPitchCmd * (dirtDiveHard || nearDirtCrisis ? 0.85 : 0.7),
                    roll: this.clamp(pullSide * Math.PI / 10, -Math.PI / 10, Math.PI / 10),
                    groundPull: true,
                    reason: 'Safety near-dirt survival pull-up'
                },
                {
                    ...base,
                    state: 'safetyGroundPullLat',
                    statusText: 'NPC: 安全預演-近地側拉',
                    throttle: team.heat > 86 ? 4 : 5,
                    joyX: this.clamp(pullSide * 0.55, -0.7, 0.7),
                    joyY: Math.max(0.7, pullY * 0.9),
                    pitchCmd: -maxPitchCmd * 0.72,
                    roll: this.clamp(pullSide * Math.PI / 7, -Math.PI / 7, Math.PI / 7),
                    groundPull: true,
                    reason: 'Safety near-dirt survival pull with lateral'
                }
            );
            // Weak breaks cannot win against ground smash / stall sink.
            candidates = candidates.map((c) => {
                if (c.state === 'safetyBreakLeft' || c.state === 'safetyBreakRight') {
                    return { ...c, joyY: Math.max(0.7, Number(c.joyY) || 0), pitchCmd: -maxPitchCmd * 0.6 };
                }
                if (c.state === 'safetyLevelOut' || c.state === 'safetyUnclimb') {
                    return { ...c, joyY: Math.max(0.62, Number(c.joyY) || 0) };
                }
                return c;
            });
        }
        if (obstaclePressure) {
            const actionTurn = Math.sign(action.joyX || 0);
            const geomSide = (coverInfo.direction && selfForward)
                ? Math.sign(selfForward.clone().cross(coverInfo.direction).y || 0)
                : 0;
            // Prefer AABB push-out side when embedded (coverInfo.direction is horizontal escape).
            const pushSide = (hardContact && coverInfo.direction)
                ? Math.sign(coverInfo.direction.x * (selfForward ? -selfForward.z : 0) + coverInfo.direction.z * (selfForward ? selfForward.x : 1)) || 0
                : 0;
            const defaultSide = actionTurn || pushSide || geomSide || ((GameContext.getFaction && GameContext.getFaction(team.id)) === 'blue' ? -1 : 1);
            const steepIntoBldg = hardContact && teamForwardY > 0.35;
            const roofClear = Number(coverInfo.roofClearance);
            const embedDist = Number(coverInfo.distance);
            const embedded =
                hardContact &&
                ((Number.isFinite(embedDist) && embedDist < 3) ||
                    (Number.isFinite(roofClear) && roofClear < 0 && Number.isFinite(embedDist) && embedDist < 6));
            const divingAtBldg = teamForwardY < -0.35 && altNow < 40;
            const headroom = Number(coverInfo.headroom);
            const underRoof = Number.isFinite(roofClear) && roofClear < 2;
            const skyOpen = !underRoof && (!Number.isFinite(headroom) || headroom >= 14);
            // T27/T31: embed + thr5 joyX=0.95 still smashed; soften stick, never AB into mesh.
            // T32: headroom can stay large under overhang — trust roofClearance for climb authority.
            // Align with hard-gate thr4 embed doctrine (|joyX|≤0.52).
            const escapeJoy = embedded || underRoof ? 0.48 : (divingAtBldg ? 0.55 : (hardContact ? 0.55 : 0.72));
            const escapePitch = energyCriticalNow
                ? (altNow < 18 ? 0.2 : 0.06)
                : ((embedded || underRoof)
                    ? (teamForwardY < -0.35 ? 0.28 : 0.1)
                    : (divingAtBldg
                        ? (altNow < 22 ? 0.62 : 0.48)
                        : (hardContact
                            ? (steepIntoBldg ? 0.06 : (skyOpen ? 0.28 : 0.14))
                            : (altNow < 24 ? 0.72 : 0.52))));
            const escapeThrottle = energyCriticalNow
                ? 3
                : ((embedded || underRoof)
                    ? (team.heat > 82 ? 3 : 4)
                    : (divingAtBldg ? 4 : (team.heat > 76 ? 4 : 5)));
            const escapeRoll = embedded || underRoof || divingAtBldg ? Math.PI / 8 : Math.PI / 5.5;
            const obstacleCandidates = [
                { ...base, state: 'safetyObstacleEscapePrimary', statusText: 'NPC: 安全預演-建築主脫離', throttle: escapeThrottle, joyX: this.clamp(defaultSide * escapeJoy, -1, 1), joyY: escapePitch, pitchCmd: -maxPitchCmd * ((embedded || underRoof) ? (teamForwardY < -0.35 ? 0.28 : 0.12) : (divingAtBldg ? 0.55 : (hardContact || energyCriticalNow ? 0.16 : 0.62))), roll: this.clamp(defaultSide * escapeRoll, -escapeRoll, escapeRoll), obstacleFallback: true, reason: (embedded || underRoof) ? 'Safety embed/under-roof: lateral push-out, low climb' : (hardContact ? 'Safety hard-contact lateral around building' : 'Safety fallback keeps obstacle escape direction') },
                { ...base, state: 'safetyObstacleEscapeOpposite', statusText: 'NPC: 安全預演-建築反向脫離', throttle: escapeThrottle, joyX: this.clamp(-defaultSide * escapeJoy, -1, 1), joyY: escapePitch, pitchCmd: -maxPitchCmd * ((embedded || underRoof) ? (teamForwardY < -0.35 ? 0.28 : 0.12) : (divingAtBldg ? 0.55 : (hardContact || energyCriticalNow ? 0.16 : 0.62))), roll: this.clamp(-defaultSide * escapeRoll, -escapeRoll, escapeRoll), obstacleFallback: true, reason: 'Safety fallback tries opposite side of obstacle' }
            ];
            if (divingAtBldg && !embedded && !underRoof && Number.isFinite(embedDist) && embedDist >= 2) {
                const pullSide = defaultSide || 1;
                obstacleCandidates.unshift({
                    ...base,
                    state: 'safetyCanyonDivePull',
                    statusText: 'NPC: 安全預演-街谷俯衝改平',
                    throttle: energyCriticalNow ? 3 : 4,
                    joyX: this.clamp(pullSide * 0.32, -0.42, 0.42),
                    joyY: altNow < 18 ? 0.78 : 0.58,
                    pitchCmd: -maxPitchCmd * 0.72,
                    roll: this.clamp(pullSide * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
                    obstacleFallback: true,
                    groundPull: altNow < 16,
                    reason: 'Safety canyon dive: pull level before hard side thrash'
                });
            }
            if (!energyCriticalNow && !embedded && !underRoof && !steepIntoBldg && skyOpen) {
                obstacleCandidates.push({
                    ...base,
                    state: 'safetyObstacleClimbOut',
                    statusText: 'NPC: 安全預演-建築爬升脫離',
                    throttle: escapeThrottle,
                    joyX: this.clamp(defaultSide * (hardContact ? 0.22 : 0.28), -0.35, 0.35),
                    joyY: selfPos && selfPos.y < 22 ? 0.9 : (hardContact ? 0.52 : 0.68),
                    pitchCmd: -maxPitchCmd * (hardContact ? 0.55 : 0.78),
                    roll: this.clamp(defaultSide * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
                    obstacleFallback: true,
                    reason: hardContact
                        ? 'Safety soft climb-out when sky open (no embed)'
                        : 'Safety fallback climb out of obstacle envelope'
                });
            }
            candidates = [action, ...obstacleCandidates, ...candidates.slice(1)];
        }
        const originalEval = this.evaluateActionSafety(teamId, action);
        const offensiveProtected = this.isOffensiveSafetyProtected(action, coverInfo, originalEval);
        const protectedStates = new Set([
            'emergencyPullUp',
            'emergencyRecoverLock',
            'postGroundClimbOut',
            'obstacleEmergencyEscape',
            'terrainEscape',
            'groundAvoid',
            'shallowDiveLevel',
            'collisionAvoid',
            'obstacleDisengage',
            'obstacleEnergyClimb',
            'urbanPreemptiveAvoid',
            'urbanBrakeTurn',
            'urbanClimbingTurn',
            'urbanRouteEscape',
            'urbanBuildingWeave',
            'altitudeBandLevelOut',
            'stallBreakout',
            'stallRecoverNoRoll',
            'energyRecover',
            'recover',
            'reacquire',
            'alignFirst',
            'searchIntercept',
            'orbitCutIn',
            'intercept',
            'mandatoryMergeBreak',
            'mergeBreak',
            'antiLoopBreak',
            'gunAttack',
            'missileAttack',
            'missilePrep',
            'openingRoofDash',
            'manualEvadeRecover',
            'manualEvade',
            'defensiveFlare',
            'defensiveChaff',
            'wingmanFollow',
            'wingmanFollowDetour',
            'wingmanFollowUndercroft',
            'wingmanCover',
            'wingmanCoverEngage',
            'wingmanBreak',
            'wingmanPullUp',
            'wingmanCeilingLevel'
        ]);
        const groundSurvivalStates = new Set([
            'emergencyPullUp',
            'emergencyRecoverLock',
            'groundAvoid',
            'postGroundClimbOut',
            'stallBreakout',
            'stallRecoverNoRoll',
            'safetyStallBreakout',
            'safetyGroundPull',
            'safetyGroundPullLat',
            'safetyEmbedPushOut',
            'safetyEmbedPushOutOpposite',
            'obstacleEnergyClimb',
            'obstacleEmergencyEscape'
        ]);
        const nearDirtSurvival =
            nearDirtCrisis ||
            dirtDiveThreat ||
            embedStallCrisis ||
            embedMeshCrisis ||
            (Number.isFinite(originalEval.minAltitude) &&
                originalEval.minAltitude < 3 &&
                altNow < 14);
        // Climb-into-mesh: high joyY + weak lateral while glued — exclude dive/dirt pull sticks (T42).
        // thr4 embed (|joyX|≈0.48) is not "weak lateral" — only true zero-turn climbs.
        const climbIntoMesh =
            embedMeshCrisis &&
            !this.isDiveLevelPullAction(action) &&
            Number(action.joyY || 0) >= 0.45 &&
            Math.abs(Number(action.joyX || 0)) < 0.35;
        // Protect survival stick through predicted ground smash / stall sink (T30 dive, T29 stall-flat).
        // Never early-protect a climb-into-mesh stick — must compete with lateral escape.
        const hardProtectOk = !originalEval.buildingHit && !climbIntoMesh && (
            (groundSurvivalStates.has(action.state) && nearDirtSurvival) ||
            (originalEval.minAltitude === null || originalEval.minAltitude >= 8)
        );
        if ((protectedStates.has(action.state) || offensiveProtected) && hardProtectOk) {
            if (groundSurvivalStates.has(action.state) && nearDirtSurvival) {
                if (embedMeshCrisis || hardContact) {
                    // Building first: ensure thr4-band lateral (do not amplify into thr3 snake).
                    if (typeof action.joyX === 'number') {
                        const absX = Math.abs(action.joyX);
                        const side = Math.sign(action.joyX) || 1;
                        if (absX < 0.28) action.joyX = this.clamp(side * 0.48, -0.52, 0.52);
                        else if (absX > 0.52) action.joyX = this.clamp(side * 0.5, -0.52, 0.52);
                    }
                    this.applyEmbedJoyYBand(action, altNow, teamForwardY);
                } else {
                    const minPull = (dirtDiveHard || nearDirtCrisis || (Number.isFinite(originalEval.minAltitude) && originalEval.minAltitude < 3))
                        ? 0.82
                        : 0.62;
                    if (typeof action.joyY === 'number' && action.joyY < minPull) action.joyY = minPull;
                    if (typeof action.throttle === 'number' && action.throttle < 4 && !(team.stalled && teamForwardY > 0.35)) {
                        action.throttle = 4;
                    }
                }
            }
            action.debug = {
                ...(action.debug || {}),
                safety: {
                    selected: action.state || 'unknown',
                    original: action.state || 'unknown',
                    score: originalEval.score,
                    minAlt: originalEval.minAltitude,
                    finalAP: originalEval.finalAP,
                    nearestBuilding: originalEval.nearestBuilding,
                    buildingHit: originalEval.buildingHit,
                    overridden: false,
                    protected: true,
                    dirtDive: nearDirtSurvival ? 1 : 0,
                    nearDirtCrisis: nearDirtCrisis ? 1 : 0,
                    offensiveProtected
                },
                tree: [
                    ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                    `safetyEval: protected=${action.state || 'unknown'} nearDirt=${nearDirtSurvival ? 1 : 0} crisis=${nearDirtCrisis ? 1 : 0} offensive=${offensiveProtected} score=${originalEval.score} minAlt=${originalEval.minAltitude} ap=${originalEval.finalAP} override=false`
                ]
            };
            return action;
        }
        if (!stallTrapNow && originalEval.safe && originalEval.score > 20) {
            action.debug = {
                ...(action.debug || {}),
                safety: {
                    selected: action.state || 'unknown',
                    original: action.state || 'unknown',
                    score: originalEval.score,
                    minAlt: originalEval.minAltitude,
                    finalAP: originalEval.finalAP,
                    nearestBuilding: originalEval.nearestBuilding,
                    buildingHit: originalEval.buildingHit,
                    overridden: false
                },
                tree: [
                    ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                    `safetyEval: selected=${action.state || 'unknown'} score=${originalEval.score} minAlt=${originalEval.minAltitude} ap=${originalEval.finalAP} override=false`
                ]
            };
            return action;
        }

        let bestAction = action;
        let bestEval = originalEval;
        let bestClearAction = null;
        let bestClearEval = null;
        let bestEscapeAction = null;
        let bestEscapeEval = null;
        const originalTurn = Math.abs(Number(action.joyX || 0));
        const knifeFightAltOk = selfPos && selfPos.y >= 18;
        const rejectZeroTurnClimb =
            originalTurn >= 0.35 &&
            knifeFightAltOk &&
            ['mandatoryMergeBreak', 'mergeBreak', 'reacquire', 'orbitCutIn', 'antiLoopBreak', 'gunAttack', 'missilePrep'].includes(action.state);
        candidates.slice(1).forEach(candidate => {
            if (candidate.state === 'safetyShallowClimb' && lowEnergy && teamForwardY > 0.2) return;
            // Stall trap: nose-down breakout only — except near-dirt groundPull / embed push-out (T28).
            if (stallTrapNow) {
                if (embedStallCrisis || embedMeshCrisis || hardContact) {
                    // Inside mesh: only soft push / groundPull / softened stallBreakout — never level-out.
                    if (
                        !candidate.groundPull &&
                        !candidate.obstacleFallback &&
                        candidate.state !== 'safetyStallBreakout' &&
                        candidate.state !== 'safetyEmbedPushOut' &&
                        candidate.state !== 'safetyEmbedPushOutOpposite'
                    ) return;
                    if (candidate.state === 'safetyLevelOut' || candidate.state === 'safetyUnclimb') return;
                } else if (
                    !candidate.groundPull &&
                    !['safetyStallBreakout', 'safetyUnclimb', 'safetyLevelOut'].includes(candidate.state)
                ) {
                    return;
                }
            }
            // Do not replace a hard turn with joyX=0 climb during knife-fight / merge break.
            if (rejectZeroTurnClimb && Math.abs(Number(candidate.joyX || 0)) < 0.2) return;
            // Near-dirt / embed-stall survival lock: never consider weak breaks / level-outs.
            const underRoofCrisis =
                Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 0;
            if (
                (nearDirtSurvival || embedStallCrisis || embedMeshCrisis || underRoofCrisis || altNow < 12) &&
                !candidate.groundPull &&
                !candidate.obstacleFallback &&
                (candidate.state === 'safetyBreakLeft' ||
                    candidate.state === 'safetyBreakRight' ||
                    candidate.state === 'safetyLevelOut' ||
                    candidate.state === 'safetyUnclimb')
            ) {
                return;
            }
            const continuation = candidate.obstacleFallback
                ? [{
                    ...base,
                    state: `${candidate.state}Continue`,
                    throttle: team.heat > 78 ? 3 : 5,
                    joyX: this.clamp((candidate.joyX || 0) * 0.45, -0.45, 0.45),
                    joyY: this.clamp((candidate.joyY || 0) * 0.7, 0.08, 0.5),
                    pitchCmd: -maxPitchCmd * 0.38,
                    roll: this.clamp((candidate.roll || 0) * 0.45, -Math.PI / 10, Math.PI / 10),
                    reason: 'Obstacle safety continuation'
                }]
                : [];
            const safety = this.evaluateActionSafety(teamId, candidate, continuation);
            if (!safety.buildingHit && (!bestClearEval || safety.score > bestClearEval.score)) {
                bestClearAction = candidate;
                bestClearEval = safety;
            }
            if (candidate.obstacleFallback && (!bestEscapeEval || safety.score > bestEscapeEval.score)) {
                bestEscapeAction = candidate;
                bestEscapeEval = safety;
            }
            if (candidate.groundPull && nearDirtSurvival) {
                // Embed/mesh: do not auto-prefer pure ground-pull over lateral escape (T32 blue2).
                if (embedMeshCrisis && !candidate.obstacleFallback) {
                    if (!safety.buildingHit && (!bestClearEval || safety.score > bestClearEval.score)) {
                        bestClearAction = candidate;
                        bestClearEval = safety;
                    }
                    return;
                }
                // Prefer ground-pull when predicting dirt impact / stall sink.
                if (!bestEval || safety.minAltitude > (bestEval.minAltitude ?? -99) || safety.score > bestEval.score + 20) {
                    bestEval = safety;
                    bestAction = candidate;
                }
                return;
            }
            if (!bestEval || safety.score > bestEval.score) {
                bestEval = safety;
                bestAction = candidate;
            }
        });

        // Already flying into geometry: prefer a clear path, else dedicated obstacle escape.
        // Canyon dive: prefer soft dive-pull over thr5 hard side yank into mesh (T27).
        // Embed+stall: prefer push-out over level/nose-down (T28).
        // T31: never force canyonDivePull while embedded if that path still hits the mesh.
        if (originalEval.buildingHit) {
            const embedPush = candidates.find(c => c && c.state === 'safetyEmbedPushOut');
            const canyonPull = candidates.find(c => c && c.state === 'safetyCanyonDivePull');
            if ((embedStallCrisis || embedMeshCrisis) && embedPush) {
                const pushEval = this.evaluateActionSafety(teamId, embedPush);
                const embedOpp = candidates.find(c => c && c.state === 'safetyEmbedPushOutOpposite');
                const oppEval = embedOpp ? this.evaluateActionSafety(teamId, embedOpp) : null;
                // Deep embed: prefer opposite if primary still hits / scores worse (T34/T26).
                if (
                    oppEval &&
                    (
                        (!oppEval.buildingHit && pushEval.buildingHit) ||
                        oppEval.score > pushEval.score + 15 ||
                        (Number.isFinite(oppEval.nearestBuilding) &&
                            Number.isFinite(pushEval.nearestBuilding) &&
                            oppEval.nearestBuilding > pushEval.nearestBuilding + 0.4)
                    )
                ) {
                    bestAction = embedOpp;
                    bestEval = oppEval;
                } else if (!pushEval.buildingHit || pushEval.score > originalEval.score + 40) {
                    bestAction = embedPush;
                    bestEval = pushEval;
                } else if (bestClearAction && bestClearEval && !bestClearEval.buildingHit) {
                    bestAction = bestClearAction;
                    bestEval = bestClearEval;
                } else if (
                    bestEscapeAction &&
                    bestEscapeEval &&
                    (!bestEscapeEval.buildingHit || bestEscapeEval.score > pushEval.score)
                ) {
                    bestAction = bestEscapeAction;
                    bestEval = bestEscapeEval;
                }
                // else: leave loop best / original — keepProtected will refuse worse override
            } else if (
                canyonPull &&
                teamForwardY < -0.35 &&
                altNow < 40 &&
                !embedMeshCrisis
            ) {
                const pullEval = this.evaluateActionSafety(teamId, canyonPull);
                if (!pullEval.buildingHit || pullEval.score > originalEval.score + 50) {
                    bestAction = canyonPull;
                    bestEval = pullEval;
                } else if (bestClearAction && bestClearEval) {
                    bestAction = bestClearAction;
                    bestEval = bestClearEval;
                } else if (bestEscapeAction && bestEscapeEval) {
                    bestAction = bestEscapeAction;
                    bestEval = bestEscapeEval;
                }
            } else if (bestClearAction && bestClearEval) {
                bestAction = bestClearAction;
                bestEval = bestClearEval;
            } else if (bestEscapeAction && bestEscapeEval) {
                // Prefer milder joyX escape when embedded.
                const embedPick = hardContact && Number(coverInfo.distance) < 3;
                if (embedPick && Math.abs(Number(bestEscapeAction.joyX || 0)) > 0.7) {
                    const soft = candidates.find(c =>
                        c && c.obstacleFallback && Math.abs(Number(c.joyX || 0)) <= 0.55 && c.state !== bestEscapeAction.state
                    );
                    if (soft) {
                        bestAction = soft;
                        bestEval = this.evaluateActionSafety(teamId, soft);
                    } else {
                        bestAction = bestEscapeAction;
                        bestEval = bestEscapeEval;
                    }
                } else {
                    bestAction = bestEscapeAction;
                    bestEval = bestEscapeEval;
                }
            }
        }

        const canyonDiveStick =
            action.state === 'emergencyPullUp' &&
            teamForwardY < -0.35 &&
            altNow < 40 &&
            Number(action.joyY || 0) >= 0.55;

        if (
            protectedStates.has(action.state) &&
            bestAction !== action &&
            bestEval &&
            !bestEval.safe &&
            (!bestAction.obstacleFallback || canyonDiveStick || nearDirtSurvival)
        ) {
            // Keep protected stick only when original path is not already hitting building/terrain.
            // Near-dirt / canyon-dive: never replace pull-up with weaker joyY hard side thrash.
            const weakOverride =
                bestAction.state === 'safetyBreakLeft' ||
                bestAction.state === 'safetyBreakRight' ||
                bestAction.state === 'safetyLevelOut' ||
                bestAction.state === 'safetyUnclimb' ||
                (Math.abs(Number(bestAction.joyX || 0)) >= 0.7 && Number(bestAction.joyY || 0) + 0.12 < Number(action.joyY || 0)) ||
                Number(bestAction.joyY || 0) + 0.12 < Number(action.joyY || 0);
            const canyonPullStillHits =
                bestAction.state === 'safetyCanyonDivePull' &&
                bestEval &&
                bestEval.buildingHit;
            const embedPushStillHits =
                bestAction.state === 'safetyEmbedPushOut' &&
                bestEval &&
                bestEval.buildingHit;
            const overrideNotBetter =
                bestEval &&
                bestEval.buildingHit &&
                (
                    originalEval.score >= bestEval.score - 15 ||
                    (Number.isFinite(originalEval.nearestBuilding) &&
                        Number.isFinite(bestEval.nearestBuilding) &&
                        originalEval.nearestBuilding >= bestEval.nearestBuilding - 0.5)
                );
            // Building-first: never keep a climb-into-mesh pull when a lateral escape candidate exists.
            const preferEmbedEscape =
                climbIntoMesh &&
                bestAction &&
                (bestAction.obstacleFallback || bestAction.state === 'safetyEmbedPushOut');
            const keepProtected =
                !preferEmbedEscape &&
                (
                    (groundSurvivalStates.has(action.state) && nearDirtSurvival && weakOverride && !embedMeshCrisis) ||
                    (canyonDiveStick && weakOverride && !embedMeshCrisis) ||
                    (canyonDiveStick && canyonPullStillHits && !embedMeshCrisis) ||
                    (embedMeshCrisis &&
                        (canyonPullStillHits || embedPushStillHits) &&
                        !climbIntoMesh &&
                        !originalEval.buildingHit) ||
                    (embedMeshCrisis &&
                        overrideNotBetter &&
                        !climbIntoMesh &&
                        action.state === 'obstacleEmergencyEscape') ||
                    (bestEval &&
                        bestEval.buildingHit &&
                        originalEval.buildingHit &&
                        overrideNotBetter &&
                        protectedStates.has(action.state) &&
                        !climbIntoMesh) ||
                    (!originalEval.buildingHit &&
                        !embedMeshCrisis &&
                        (originalEval.minAltitude === null || originalEval.minAltitude >= 8))
                );
            if (keepProtected) {
                if ((groundSurvivalStates.has(action.state) && nearDirtSurvival && !embedMeshCrisis) || canyonDiveStick) {
                    const minPull = dirtDiveHard || nearDirtCrisis || canyonDiveStick ? 0.82 : 0.62;
                    if (typeof action.joyY === 'number' && action.joyY < minPull) action.joyY = minPull;
                    if (canyonDiveStick && Math.abs(Number(action.joyX || 0)) > 0.5) {
                        action.joyX = this.clamp(action.joyX, -0.45, 0.45);
                    }
                }
                // Embedded: favor thr4-band lateral; mode-aware joyY (divePull / dirt floor preserved).
                if (embedMeshCrisis) {
                    if (typeof action.joyX === 'number') {
                        const absX = Math.abs(action.joyX);
                        const side = Math.sign(action.joyX) || 1;
                        if (absX < 0.28) action.joyX = this.clamp(side * 0.48, -0.52, 0.52);
                        else if (absX > 0.52) action.joyX = this.clamp(side * 0.5, -0.52, 0.52);
                    }
                    this.applyEmbedJoyYBand(action, altNow, teamForwardY);
                }
                action.debug = {
                    ...(action.debug || {}),
                    safety: {
                        selected: action.state || 'unknown',
                        original: action.state || 'unknown',
                        score: originalEval.score,
                        minAlt: originalEval.minAltitude,
                        finalAP: originalEval.finalAP,
                        nearestBuilding: originalEval.nearestBuilding,
                        buildingHit: originalEval.buildingHit,
                        overridden: false,
                        overrideRejected: bestAction.state || 'unknown',
                        dirtDive: nearDirtSurvival ? 1 : 0,
                        nearDirtCrisis: nearDirtCrisis ? 1 : 0,
                        canyonDive: canyonDiveStick ? 1 : 0,
                        embedMesh: embedMeshCrisis ? 1 : 0
                    },
                    tree: [
                        ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                        `safetyEval: rejectedUnsafeOverride=${bestAction.state || 'unknown'} nearDirt=${nearDirtSurvival ? 1 : 0} canyonDive=${canyonDiveStick ? 1 : 0} embed=${embedMeshCrisis ? 1 : 0} score=${bestEval.score} keep=${action.state || 'unknown'}`
                    ]
                };
                return action;
            }
            if (action.debug && Array.isArray(action.debug.tree)) {
                action.debug.tree.push(
                    `safetyEval: forceOverride hit=${originalEval.buildingHit ? 1 : 0} alt=${originalEval.minAltitude} → ${bestAction.state || 'unknown'}`
                );
            }
        }

        // Prefer keeping original merge/reacquire turn if fallback only wins by climbing straight.
        if (
            bestAction !== action &&
            rejectZeroTurnClimb &&
            Math.abs(Number(bestAction.joyX || 0)) < 0.25 &&
            !originalEval.buildingHit &&
            (originalEval.minAltitude === null || originalEval.minAltitude >= 12)
        ) {
            action.debug = {
                ...(action.debug || {}),
                safety: {
                    selected: action.state || 'unknown',
                    original: action.state || 'unknown',
                    score: originalEval.score,
                    minAlt: originalEval.minAltitude,
                    finalAP: originalEval.finalAP,
                    nearestBuilding: originalEval.nearestBuilding,
                    buildingHit: originalEval.buildingHit,
                    overridden: false,
                    overrideRejected: bestAction.state || 'unknown',
                    keepTurn: true
                },
                tree: [
                    ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                    `safetyEval: rejectedZeroTurn=${bestAction.state || 'unknown'} keep=${action.state || 'unknown'} score=${originalEval.score}`
                ]
            };
            return action;
        }

        // Final near-dirt guard: if somehow still on a weak break, force ground pull.
        // Embedded: prefer lateral push-out, not pure climb pull into mesh.
        if (
            nearDirtSurvival &&
            bestAction &&
            !bestAction.groundPull &&
            (bestAction.state === 'safetyBreakLeft' ||
                bestAction.state === 'safetyBreakRight' ||
                bestAction.state === 'safetyLevelOut' ||
                bestAction.state === 'safetyUnclimb')
        ) {
            const pull = embedMeshCrisis
                ? (candidates.find(c => c && (c.state === 'safetyEmbedPushOut' || c.state === 'safetyEmbedPushOutOpposite'))
                    || candidates.find(c => c && c.obstacleFallback)
                    || candidates.find(c => c && c.groundPull && c.state === 'safetyGroundPullLat')
                    || candidates.find(c => c && c.groundPull && c.state === 'safetyGroundPull')
                    || candidates.find(c => c && c.groundPull))
                : (candidates.find(c => c && c.groundPull && c.state === 'safetyGroundPull')
                    || candidates.find(c => c && c.groundPull));
            if (pull) {
                bestAction = pull;
                bestEval = this.evaluateActionSafety(teamId, pull);
            }
        }

        const chosen = bestAction === action ? action : {
            ...bestAction,
            debug: action.debug,
            safetyOverrideFrom: action.state || 'unknown'
        };
        // Soft stick bound: mode-aware embed band (divePull not crushed to 0.22 — T42).
        if (embedMeshCrisis && chosen) {
            this.applyEmbedJoyYBand(chosen, altNow, teamForwardY);
            if (typeof chosen.joyX === 'number') {
                const absX = Math.abs(chosen.joyX);
                const side = Math.sign(chosen.joyX) || 1;
                if (absX < 0.28) chosen.joyX = this.clamp(side * 0.48, -0.52, 0.52);
                else if (absX > 0.52) chosen.joyX = this.clamp(side * 0.5, -0.52, 0.52);
            }
        }
        this.preserveOffensiveQueue(chosen, action, coverInfo, originalEval);
        chosen.debug = {
            ...(action.debug || {}),
            safety: {
                selected: chosen.state || 'unknown',
                original: action.state || 'unknown',
                score: bestEval ? bestEval.score : null,
                minAlt: bestEval ? bestEval.minAltitude : null,
                finalAP: bestEval ? bestEval.finalAP : null,
                nearestBuilding: bestEval ? bestEval.nearestBuilding : null,
                buildingHit: bestEval ? bestEval.buildingHit : false,
                overridden: bestAction !== action,
                dirtDive: nearDirtSurvival ? 1 : 0,
                nearDirtCrisis: nearDirtCrisis ? 1 : 0,
                offensiveQueuePreserved: bestAction !== action && this.isOffensiveSafetyProtected(action, coverInfo, originalEval)
            },
            tree: [
                ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                `safetyEval: selected=${chosen.state || 'unknown'} score=${bestEval ? bestEval.score : 'n/a'} minAlt=${bestEval ? bestEval.minAltitude : 'n/a'} ap=${bestEval ? bestEval.finalAP : 'n/a'} override=${bestAction !== action} nearDirt=${nearDirtSurvival ? 1 : 0} crisis=${nearDirtCrisis ? 1 : 0}`
            ]
        };
        return chosen;
    },

    chooseUrbanAvoidSide(teamId, ctx = {}) {
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (!team) return ctx.defaultSide || 1;
        const base = { weapon: 'gun', queueAction: 'none', ready: true };
        const altitude = Number(ctx.altitude || (team.wrapper && team.wrapper.position ? team.wrapper.position.y : 40));
        const heat = Number(team.heat || 0);
        let best = { side: ctx.defaultSide || 1, score: -Infinity };
        for (const side of [-1, 1]) {
            const probeSteps = [
                { joyX: side * 0.74, joyY: altitude < 28 ? 0.36 : 0.12, roll: this.clamp(side * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5) },
                { joyX: side * 0.58, joyY: altitude < 28 ? 0.28 : 0.1, roll: this.clamp(side * Math.PI / 8, -Math.PI / 8, Math.PI / 8) },
                { joyX: side * 0.46, joyY: altitude < 30 ? 0.22 : 0.08, roll: this.clamp(side * Math.PI / 10, -Math.PI / 10, Math.PI / 10) }
            ];
            const action = {
                ...base,
                state: 'urbanAvoidSideProbe',
                throttle: heat > 78 ? 3 : 4,
                ...probeSteps[0],
                reason: 'Probe urban avoid side'
            };
            const continuations = probeSteps.slice(1).map((step, index) => ({
                ...base,
                state: `urbanAvoidSideProbeContinue${index + 1}`,
                throttle: heat > 78 ? 3 : 4,
                ...step,
                reason: 'Probe urban avoid side continuation'
            }));
            const safety = this.evaluateActionSafety(teamId, action, continuations);
            const score =
                safety.score +
                (Number(safety.nearestBuilding || 0) * 7) +
                (Number(safety.finalAP || 0) * 0.16) -
                (safety.buildingHit ? 500 : 0);
            if (score > best.score) best = { side, score };
        }
        return best.side || ctx.defaultSide || 1;
    },

    isCloseCombatUrbanDefer(ctx, tuning = this.getTuning()) {
        const coverInfo = (ctx && ctx.coverInfo) || {};
        const distance = Number(ctx && ctx.distance);
        const angleDeg = Number(ctx && ctx.angleDeg);
        const threatScore = Number(ctx && ctx.threatScore || 0);
        const gunReach = this.gunRangeOr(tuning) + 22;
        const knifeFight = Number.isFinite(distance) && distance > 0 && distance <= this.gunRangeOr(tuning) + 12;
        const forwardDist = Number(coverInfo.forwardDistance);
        const coverDist = Number(coverInfo.distance);
        const imminentBuilding =
            coverInfo.collisionRisk === 'high' &&
            ((Number.isFinite(forwardDist) && forwardDist > 0 && forwardDist < 12) || coverDist < 8);
        if (imminentBuilding) return false;
        // Clear forward corridor: keep urban weave available in knife-fight.
        if (coverInfo.corridorClear) return false;
        // Dense / high building risk: never defer city routing for knife-fight guns.
        if (coverInfo.collisionRisk === 'high') return false;
        // Side-lane buildings are weave opportunities, not close-combat defer.
        if (this.isSideLanePressure(coverInfo, !!(ctx && ctx.urbanArenaMode)) && coverDist >= 16) return false;
        const tightUrban =
            (Number.isFinite(coverDist) && coverDist > 0 && coverDist < 14) ||
            (Number.isFinite(forwardDist) && forwardDist > 0 && forwardDist < 18);
        if (tightUrban) return false;
        if (ctx && (ctx.actualMissileThreat || ctx.missileThreatEvade || ctx.mandatoryMergeBreak)) return false;
        if (!(Number.isFinite(distance) && distance > 0 && distance <= gunReach)) return false;
        // Lateral building lane: keep urban planner alive so knife-fight can weave instead of gun-diving.
        // Defer-break stays forward-clear only; side-lane weave is handled in weaveEligible / weaveGate.
        const lateralWeaveLane =
            coverInfo.collisionRisk === 'medium' &&
            coverDist >= 10 &&
            coverDist <= 32 &&
            Number.isFinite(forwardDist) &&
            forwardDist > 16;
        // Knife-fight: prefer turn/fire over city routing, unless a side-building weave lane exists.
        if (knifeFight && !lateralWeaveLane) return true;
        if (Number.isFinite(angleDeg) && angleDeg > 110) return false;
        if (threatScore >= 0.7) return false;
        return true;
    },

    // Combat/rooftop band + close merge: soft urban preemptive/climb must not steal merge/gun (T48 midair).
    isHighAltCloseContactUrbanDefer(ctx, coverInfo = {}, tuning = this.getTuning()) {
        const altitude = Number(ctx && ctx.altitude);
        const distance = Number(ctx && ctx.distance);
        const predSep = Number(ctx && ctx.predictedSeparation);
        const bandFloor = Math.max(Number(tuning.combatBandMin || 35) + 10, 48);
        if (!(Number.isFinite(altitude) && altitude >= bandFloor)) return false;
        if (this.isHardBuildingContact(coverInfo)) return false;
        if (coverInfo.collisionRisk === 'high') return false;
        const coverDist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        if (Number.isFinite(coverDist) && coverDist > 0 && coverDist < 8) return false;
        if (Number.isFinite(fwd) && fwd > 0 && fwd < 6) return false;
        const closeEnemy =
            (Number.isFinite(distance) && distance > 0 && distance <= 16) ||
            (Number.isFinite(predSep) && predSep <= 14);
        return !!closeEnemy;
    },

    /**
     * Conservative early building approach: still have clearance, closing on facade.
     * Narrow eligibility for mild sticks — wider look-ahead is score-only (isFacadeClosingScore).
     */
    isEarlyBuildingApproach(coverInfo = {}) {
        if (this.isHardBuildingContact(coverInfo)) {
            const dist = Number(coverInfo.distance);
            // Already glued: not "early".
            if (Number.isFinite(dist) && dist < 2) return false;
        }
        const fwd = Number(coverInfo.forwardDistance);
        const risk = coverInfo.collisionRisk;
        // Ahead-only facade close: side/behind clutter must not trigger early weave (open snake).
        if (!(Number.isFinite(fwd) && fwd > 2 && fwd <= 18)) return false;
        return risk === 'high' || risk === 'medium';
    },

    /**
     * Score-only facade closing (wider than earlyApproach). No stick rewrite / emergency force.
     */
    isFacadeClosingScore(coverInfo = {}) {
        if (this.isHardBuildingContact(coverInfo)) {
            const dist = Number(coverInfo.distance);
            if (Number.isFinite(dist) && dist < 1.5) return false;
        }
        const fwd = Number(coverInfo.forwardDistance);
        const dist = Number(coverInfo.distance);
        const roof = Number(coverInfo.roofClearance);
        const risk = coverInfo.collisionRisk;
        if (!(Number.isFinite(fwd) && fwd > 2 && fwd <= 36)) return false;
        if (risk === 'high' || risk === 'medium') return true;
        if (Number.isFinite(roof) && roof < 2 && Number.isFinite(dist) && dist < 42) return true;
        if (Number.isFinite(dist) && dist < 28 && Number.isFinite(roof) && roof < 6) return true;
        return false;
    },

    // Only positive forward clearance counts as approach pressure; 0/negative is side/behind clutter.
    isForwardBuildingPressure(coverInfo = {}, nearDist = 42, nearFwd = 56) {
        const roofClear = Number(coverInfo.roofClearance);
        // Already clear above rooftops: do not invent approach pressure from 3D clamp distance.
        if (Number.isFinite(roofClear) && roofClear >= 8) {
            return coverInfo.collisionRisk === 'medium' || coverInfo.collisionRisk === 'high';
        }
        const dist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        if (coverInfo.collisionRisk === 'medium' || coverInfo.collisionRisk === 'high') return true;
        if (Number.isFinite(dist) && dist < nearDist && dist < 18) return true;
        if (Number.isFinite(fwd) && fwd > 2 && fwd < nearFwd) return true;
        return false;
    },

    // Side/behind buildings at mid range: lane weave pressure even when collisionRisk stays low.
    isSideLanePressure(coverInfo = {}, urbanArenaMode = false) {
        if (!urbanArenaMode) return false;
        const roofClear = Number(coverInfo.roofClearance);
        if (Number.isFinite(roofClear) && roofClear >= 8) return false;
        const coverDist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        if (!(Number.isFinite(coverDist) && coverDist >= 12 && coverDist <= 36)) return false;
        // Strict side/behind clutter only (small positive fwd is still approach geometry).
        if (Number.isFinite(fwd) && fwd > 0) return false;
        return true;
    },

    planUrbanRoute(teamId, ctx) {
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (!team || !ctx || !ctx.urbanArenaMode) return null;
        const base = { weapon: 'gun', queueAction: 'none', ready: true };
        const altitude = Number(ctx.altitude || 0);
        const energyLow = !!ctx.energyLow;
        const breakSide = ctx.breakSide || 1;
        const coverInfo = ctx.coverInfo || {};
        const turnNo = Number(ctx.turnNo || 1);
        const gapSide = this.getCorridorGapSide(coverInfo);
        const gapHold = this.getGapRouteHold(teamId, turnNo, coverInfo);
        const preferredSide = Math.sign(
            (gapHold && gapHold.side) ||
            gapSide ||
            ctx.preferredSide ||
            breakSide ||
            1
        ) || 1;
        const maskInfo = ctx.maskInfo || {};
        const obstacles = this.getObstacles();
        const denseUrban = !!ctx.denseUrban || this.isDenseUrbanContext(ctx.arenaMode, obstacles);
        const brakeTurnMemory = this.getBrakeTurnMemory(teamId);
        const recentlyBrakeTurned = (turnNo - Number(brakeTurnMemory.lastTurn || -99)) <= 3;
        const tuning = this.getTuning();
        const threatScore = Number(ctx.threatScore || 0);
        const closeCombatDefer = this.isCloseCombatUrbanDefer(ctx, tuning);
        const closeContactDefer = this.isHighAltCloseContactUrbanDefer(ctx, coverInfo, tuning);
        const fwdClear = Number(
            Number.isFinite(Number(coverInfo.corridorFwdClear))
                ? coverInfo.corridorFwdClear
                : coverInfo.forwardDistance
        );
        const gapMeta = this.getCorridorGapTier(coverInfo, tuning);
        // Near gun range with low threat: do not divert to long mask routes.
        // Side buildings (fwd≈0) must not block combat defer.
        if (closeCombatDefer && !(Number.isFinite(fwdClear) && fwdClear > 0 && fwdClear < 12)) {
            return null;
        }
        // T48: high-alt mutual weave caused midair — defer soft planner to merge/gun.
        if (closeContactDefer) {
            return null;
        }
        // Missile defense is handled by flare/evade gates — do not treat inbound FOX-2 alone as urban-route pressure
        // (that previously selected urbanClimbingTurn over defensiveFlare).
        const sideLanePressure = this.isSideLanePressure(coverInfo, true);
        const buildingPressure =
            this.isForwardBuildingPressure(coverInfo) ||
            coverInfo.collisionRisk === 'medium' ||
            coverInfo.collisionRisk === 'high' ||
            sideLanePressure;
        const pressure = buildingPressure || ctx.mandatoryMergeBreak;
        if (!pressure) return null;

        if (
            coverInfo.collisionRisk === 'low' &&
            threatScore < 0.45 &&
            altitude >= tuning.combatBandMin - 6 &&
            !ctx.mandatoryMergeBreak &&
            !sideLanePressure
        ) {
            return null;
        }
        // Under actual missile threat with only soft urban pressure: defer to flare/evade instead of climbing.
        if (
            ctx.actualMissileThreat &&
            coverInfo.collisionRisk === 'low' &&
            !ctx.mandatoryMergeBreak &&
            !this.isForwardBuildingPressure(coverInfo, 22, 28)
        ) {
            return null;
        }

        // Lateral around buildings when under/into mesh; open-sky climb banks altitude vs low-speed weave.
        // Soft doctrine: side/preemptive stay shallow; dedicated climb-out / cruise carry height.
        const roofEscape = Math.min(Number(tuning.combatBandMax) || 92, 80);
        const needRoofClimb = altitude < roofEscape - 8;
        const altitudeLane = this.getUrbanAltitudeLane(altitude, coverInfo, tuning, {
            energyBad: energyLow,
            stalled: !!team.stalled,
            ap: team.ap,
            denseUrban
        });
        const preferRoofExit = !!altitudeLane.preferRoofExit;
        const preferStraightClimb = !!altitudeLane.preferStraightClimb || preferRoofExit;
        // Soft: bare roofClearance<2 at long range is beside-tall AABB, not undercroft (T150).
        const underRoof = !!altitudeLane.underRoof ||
            (
                Number.isFinite(Number(coverInfo.roofClearance)) &&
                Number(coverInfo.roofClearance) < 2 &&
                Number.isFinite(Number(coverInfo.distance)) &&
                Number(coverInfo.distance) < 16
            );
        const hardBuilding =
            coverInfo.collisionRisk === 'high' ||
            underRoof ||
            this.isHardBuildingContact(coverInfo) ||
            (Number.isFinite(Number(coverInfo.distance)) && Number(coverInfo.distance) > 0 && Number(coverInfo.distance) < 8) ||
            (Number.isFinite(fwdClear) && fwdClear > 0 && fwdClear < 10);
        const combatPressure =
            !hardBuilding &&
            (
                threatScore >= 0.45 ||
                !!ctx.vsHuman ||
                !!ctx.missileThreatEvade ||
                (
                    Number.isFinite(Number(ctx.distance)) &&
                    Number(ctx.distance) > 0 &&
                    Number(ctx.distance) <= this.gunRangeOr(tuning) + 30 &&
                    threatScore >= 0.3
                )
            );
        // Player doctrine: mild climb + high-speed straight rebuilds AP better than low-speed turning.
        // Medium continuous turns only score well in high / open bands; canyon prefers cruise cycle.
        const apNow = Number(team.ap);
        const coverDistEarly = Number(coverInfo.distance);
        const openTurnBand =
            !underRoof &&
            (
                altitude >= Math.max(Number(tuning.combatBandMin || 35) + 12, 50) ||
                (
                    !!coverInfo.corridorClear &&
                    coverInfo.collisionRisk !== 'high' &&
                    Number.isFinite(coverDistEarly) &&
                    coverDistEarly >= 18
                ) ||
                (
                    Number.isFinite(Number(coverInfo.roofClearance)) &&
                    Number(coverInfo.roofClearance) >= 14 &&
                    coverInfo.collisionRisk === 'low'
                )
            );
        const energyCruisePreferred =
            !hardBuilding &&
            (
                energyLow ||
                !!team.stalled ||
                (Number.isFinite(apNow) && apNow < Number(tuning.energyCriticalAp || 52) + 24) ||
                altitudeLane.lane === 'canyon' ||
                altitudeLane.lane === 'dirt' ||
                combatPressure ||
                !openTurnBand
            );
        // T50: under threat prefer shallow cuts so thr stays 4–5; hard smash keeps stronger lateral.
        let sideJoyScale;
        let preemptScale;
        let breakScale;
        if (hardBuilding) {
            sideJoyScale = preferRoofExit ? 0.52 : 0.62;
            preemptScale = preferRoofExit ? 0.48 : 0.58;
            breakScale = preferRoofExit ? 0.5 : 0.58;
        } else if (energyCruisePreferred && !openTurnBand) {
            // Canyon / low-energy: tiny cuts only — cruise candidates carry the rebuild.
            sideJoyScale = 0.32;
            preemptScale = 0.28;
            breakScale = 0.3;
        } else if (combatPressure) {
            sideJoyScale = 0.42;
            preemptScale = 0.38;
            breakScale = 0.4;
        } else if (openTurnBand) {
            // Open / clear roof: keep shallow — continuous medium bank is the open-area snake.
            sideJoyScale = preferRoofExit ? 0.36 : 0.38;
            preemptScale = 0.32;
            breakScale = 0.34;
        } else {
            sideJoyScale = 0.38;
            preemptScale = 0.34;
            breakScale = 0.36;
        }
        // Conservative early approach: keep shallow sticks (no thrash circle).
        const earlyApproach = !!ctx.earlyBuildingApproach || this.isEarlyBuildingApproach(coverInfo);
        if (earlyApproach && !hardBuilding) {
            sideJoyScale = Math.min(sideJoyScale, 0.4);
            preemptScale = Math.min(preemptScale, 0.36);
            breakScale = Math.min(breakScale, 0.38);
        }
        // Deep mesh glue: keep joyX in thr4 band (≤~0.52) so score can pick sustained push-out, not thr3 snake.
        const coverDistEmbed = Number(coverInfo.distance);
        // Soft: aiMap clearAbove + far cover — do not invent mesh embed from beside-tall roof.
        const aiMapFarClear =
            !!(ctx.aiMapClearAbove || ctx.aiMapSkyOpen) &&
            Number.isFinite(coverDistEmbed) &&
            coverDistEmbed >= 40 &&
            !this.isHardBuildingContact(coverInfo);
        const meshEmbed =
            !aiMapFarClear &&
            (
                !!altitudeLane.embedded ||
                underRoof ||
                (
                    this.isHardBuildingContact(coverInfo) &&
                    Number.isFinite(coverDistEmbed) &&
                    coverDistEmbed < 3.5
                ) ||
                (
                    coverInfo.collisionRisk === 'high' &&
                    Number.isFinite(coverDistEmbed) &&
                    coverDistEmbed < 2.5
                )
            );
        if (meshEmbed) {
            sideJoyScale = Math.min(sideJoyScale, 0.5);
            preemptScale = Math.min(preemptScale, 0.46);
            breakScale = Math.min(breakScale, 0.48);
        }
        const sideJoyY = meshEmbed
            ? (Number(ctx.forwardY) < -0.35
                ? (altitude < 16 ? 0.36 : 0.24)
                : (altitude < 14 ? 0.2 : 0.12))
            : (preferStraightClimb
                ? (altitude < 28 ? 0.22 : (altitude < 48 ? 0.14 : 0.06))
                : (energyLow
                    ? (altitude < 24 ? 0.16 : 0.06)
                    : (altitude < 22 ? 0.2 : (altitude < 36 ? 0.08 : 0.02))));
        const preemptJoyY = meshEmbed
            ? sideJoyY
            : (preferStraightClimb
                ? (altitude < 30 ? 0.2 : (altitude < 50 ? 0.12 : 0.04))
                : (altitude < 26 ? 0.18 : (altitude < 40 ? 0.06 : 0.0)));
        const throttle = team.heat > 78
            ? 3
            : (meshEmbed ? 4 : (energyLow || energyCruisePreferred || combatPressure ? 5 : 4));
        const candidates = [];
        // Embed: preferred side first (and only once for dedicated push); still score both sides.
        const sideOrder = meshEmbed
            ? [preferredSide, -preferredSide]
            : [preferredSide, -preferredSide];
        for (const side of sideOrder) {
            candidates.push(
                { ...base, state: 'urbanRouteSide', statusText: 'NPC: 城市規劃-側向繞行', throttle, joyX: this.clamp(side * sideJoyScale, -0.82, 0.82), joyY: sideJoyY, roll: this.clamp(side * Math.PI / 7, -Math.PI / 7, Math.PI / 7), reason: energyCruisePreferred ? 'Urban planner side cut (energy-cruise cycle)' : (combatPressure ? 'Urban planner side route (combat-shallow)' : 'Urban planner side route') },
                { ...base, state: 'urbanPreemptiveRoute', statusText: 'NPC: 城市規劃-提前繞行', throttle, joyX: this.clamp(side * preemptScale, -0.72, 0.72), joyY: preemptJoyY, roll: this.clamp(side * Math.PI / 8, -Math.PI / 8, Math.PI / 8), reason: energyCruisePreferred ? 'Urban planner preemptive cut (energy-cruise)' : (combatPressure ? 'Urban planner preemptive (combat-shallow)' : 'Urban planner preemptive route') },
                { ...base, state: 'urbanRouteBreakSide', statusText: 'NPC: 城市規劃-標準脫離', throttle, joyX: this.clamp(side * breakScale, -0.7, 0.7), joyY: sideJoyY, roll: this.clamp(side * Math.PI / 7, -Math.PI / 7, Math.PI / 7), reason: energyCruisePreferred ? 'Urban planner break cut (energy-cruise)' : (combatPressure ? 'Urban planner break-side (combat-shallow)' : 'Urban planner break-side route') }
            );
            // Dedicated climb candidates only — compete via routeScore, not stick rewrite on every side route.
            const allowClimb =
                !underRoof &&
                this.shouldAllowUrbanClimb(altitude, coverInfo, denseUrban, tuning) &&
                (!ctx.actualMissileThreat || coverInfo.collisionRisk === 'high' || preferStraightClimb);
            if (allowClimb) {
                const climbJoyX = preferStraightClimb
                    ? (preferRoofExit ? 0.26 : 0.34)
                    : (denseUrban ? 0.42 : 0.5);
                const fwdClimb = Number(coverInfo.forwardDistance);
                const climbFacade =
                    this.isFacadeClosingScore(coverInfo) ||
                    (Number.isFinite(fwdClimb) && fwdClimb > 0 && fwdClimb < 28);
                const climbAuth = climbFacade
                    ? Math.max(climbJoyX, preferStraightClimb ? 0.4 : 0.46)
                    : climbJoyX;
                candidates.push({
                    ...base,
                    state: 'urbanClimbingTurn',
                    statusText: 'NPC: 城市規劃-爬升轉向',
                    throttle: team.heat > 78 ? 4 : 5,
                    joyX: this.clamp(side * climbAuth, -0.62, 0.62),
                    joyY: preferStraightClimb
                        ? (altitudeLane.climbJoyY || (altitude < 36 ? 0.48 : 0.36))
                        : (altitude < 36 ? 0.42 : (needRoofClimb ? (denseUrban ? 0.32 : 0.26) : 0.16)),
                    roll: this.clamp(side * Math.PI / 10, -Math.PI / 10, Math.PI / 10),
                    reason: preferRoofExit
                        ? 'Urban planner roof-lane climb out of canyon'
                        : (preferStraightClimb
                            ? 'Urban planner straight-climb bank toward rooftop band'
                            : 'Urban planner climbing turn toward rooftop band')
                });
            }
            if (coverInfo.collisionRisk === 'high' || (earlyApproach && coverInfo.collisionRisk === 'medium')) {
                // Early medium approach: mild lateral only — never 0.94 thrash (circling risk).
                // Mesh embed: keep auth ≤0.52 so thr can stay 4 under hardBuilding throttle map.
                const escAuth = meshEmbed
                    ? 0.5
                    : (hardBuilding
                        ? (preferRoofExit ? 0.58 : (energyLow ? 0.62 : 0.78))
                        : (earlyApproach ? (preferRoofExit ? 0.4 : 0.46) : (preferRoofExit ? 0.58 : (energyLow ? 0.62 : 0.94))));
                candidates.push({
                    ...base,
                    state: energyLow ? 'obstacleEnergyClimbRoute' : 'obstacleEmergencyRoute',
                    statusText: energyLow ? 'NPC: 城市規劃-低能繞脫' : (meshEmbed ? 'NPC: 城市規劃-嵌樓推出' : (earlyApproach && !hardBuilding ? 'NPC: 城市規劃-提前繞樓' : 'NPC: 城市規劃-緊急脫離')),
                    throttle: team.heat > 78 ? 4 : (meshEmbed ? 4 : 5),
                    joyX: this.clamp(side * escAuth, -1, 1),
                    joyY: meshEmbed
                        ? sideJoyY
                        : (preferStraightClimb && !hardBuilding
                            ? (altitude < 28 ? 0.32 : 0.2)
                            : (altitude < 22 ? 0.28 : (energyLow ? 0.14 : 0.1))),
                    roll: this.clamp(side * Math.PI / 6.5, -Math.PI / 6.5, Math.PI / 6.5),
                    reason: meshEmbed
                        ? 'Urban planner embed push (thr4 band, single-side bias via score)'
                        : (earlyApproach && !hardBuilding
                            ? 'Urban planner early facade cut (shallow, no thrash)'
                            : 'Urban planner emergency route')
                });
            }
        }

        // Dedicated preferred-side embed push-out — competes on score vs opposite thrash.
        if (meshEmbed) {
            const pushSide = Math.sign(preferredSide || breakSide || 1) || 1;
            const diveNose = Number(ctx.forwardY) < -0.35;
            const mildDescend = Number(ctx.forwardY) < -0.2;
            // T66: while descending under mesh, keep level band (not joyY≈0.1 flat thrash).
            const pushY = diveNose
                ? (altitude < 14 ? 0.48 : (altitude < 22 ? 0.36 : 0.26))
                : (mildDescend
                    ? (altitude < 16 ? 0.42 : 0.32)
                    : (altitude < 12 ? 0.28 : 0.14));
            const levelPull = !!(diveNose || (mildDescend && altitude < 20));
            candidates.push({
                ...base,
                state: 'urbanEmbedPushOut',
                statusText: 'NPC: 城市規劃-單側嵌樓推出',
                throttle: team.heat > 82 ? 3 : 4,
                joyX: this.clamp(pushSide * 0.48, -0.52, 0.52),
                joyY: pushY,
                roll: this.clamp(pushSide * Math.PI / 9, -Math.PI / 9, Math.PI / 9),
                diveLevelPull: levelPull,
                reason: levelPull
                    ? 'Urban embed: preferred-side push + level while descending'
                    : 'Urban embed: sustained preferred-side push-out (score vs snake)'
            });
            candidates.push({
                ...base,
                state: 'urbanEmbedPushOut',
                statusText: 'NPC: 城市規劃-單側嵌樓推出',
                throttle: team.heat > 82 ? 3 : 4,
                joyX: this.clamp(pushSide * 0.42, -0.48, 0.48),
                joyY: levelPull ? Math.min(0.42, Math.max(0.28, pushY * 0.85)) : Math.min(0.22, pushY),
                roll: this.clamp(pushSide * Math.PI / 10, -Math.PI / 10, Math.PI / 10),
                diveLevelPull: levelPull,
                reason: levelPull
                    ? 'Urban embed: milder push + level while descending'
                    : 'Urban embed: milder preferred-side push (keep thr4)'
            });
        }

        if (!underRoof && altitude < roofEscape - 6 && this.shouldAllowUrbanClimb(altitude, coverInfo, denseUrban, tuning)) {
            // T76 blue: preferStraightClimb joyX=0.16 flew dead-center into facade while coverFwd collapsed.
            const fwdThreat = Number(coverInfo.forwardDistance);
            const facadeThreat =
                this.isFacadeClosingScore(coverInfo) ||
                (Number.isFinite(fwdThreat) && fwdThreat > 0 && fwdThreat < 28) ||
                coverInfo.collisionRisk === 'high' ||
                (coverInfo.collisionRisk === 'medium' && Number.isFinite(fwdThreat) && fwdThreat < 36);
            const climbOutAuth = facadeThreat
                ? (preferStraightClimb ? 0.4 : 0.48)
                : (preferStraightClimb ? 0.16 : 0.28);
            candidates.push({
                ...base,
                state: 'urbanRouteClimbOut',
                statusText: 'NPC: 城市規劃-爬升脫離',
                throttle: team.heat > 78 ? 4 : 5,
                joyX: this.clamp(breakSide * climbOutAuth, -0.55, 0.55),
                joyY: preferStraightClimb
                    ? Math.max(0.44, altitudeLane.climbJoyY || 0.44)
                    : (altitude < 40 ? 0.42 : (needRoofClimb ? 0.28 : 0.12)),
                roll: this.clamp(breakSide * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
                reason: preferRoofExit
                    ? 'Urban planner climb-out: leave canyon forced-turn band'
                    : (preferStraightClimb
                        ? (facadeThreat
                            ? 'Urban planner climb-out with lateral cut (facade closing)'
                            : 'Urban planner straight climb-out toward rooftop band (~80m)')
                        : 'Urban planner climb-out toward rooftop band (~80m)')
            });
        }

        // Straight / mild-climb energy rebuild (player doctrine) — competes on score, not forced.
        if (!hardBuilding && !underRoof) {
            const cruiseThr = team.heat > 82 ? 4 : 5;
            const cruiseClimb = preferStraightClimb
                ? (altitude < 28 ? 0.28 : (altitude < 52 ? 0.2 : 0.1))
                : (altitude < 22 ? 0.16 : (altitude < 48 ? 0.12 : 0.06));
            candidates.push({
                ...base,
                state: 'urbanEnergyCruise',
                statusText: 'NPC: 城市規劃-直線補能',
                throttle: cruiseThr,
                joyX: this.clamp(breakSide * 0.08, -0.14, 0.14),
                joyY: cruiseClimb,
                roll: this.clamp(breakSide * Math.PI / 18, -Math.PI / 16, Math.PI / 16),
                reason: preferStraightClimb
                    ? 'Urban energy cruise: straight climb + high-speed rebuild AP/altitude'
                    : 'Urban energy cruise: mild climb + high-speed straight rebuild AP'
            });
            for (const side of sideOrder) {
                candidates.push({
                    ...base,
                    state: 'urbanEnergyCruiseCut',
                    statusText: 'NPC: 城市規劃-補能淺切',
                    throttle: cruiseThr,
                    joyX: this.clamp(side * (preferStraightClimb ? 0.2 : 0.26), -0.32, 0.32),
                    joyY: cruiseClimb * 0.85,
                    roll: this.clamp(side * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
                    reason: 'Urban energy cruise with shallow cut (repeat cycle)'
                });
            }
        }

        const brakeTurnAllowed =
            !denseUrban &&
            obstacles.length < 6 &&
            !recentlyBrakeTurned &&
            !energyLow &&
            !ctx.actualMissileThreat &&
            !ctx.lowAltitudeTacticalBan &&
            coverInfo.collisionRisk === 'low' &&
            (team.ap || 0) >= 88 &&
            altitude >= 24 &&
            Number(coverInfo.distance || Infinity) >= 18;
        if (brakeTurnAllowed) {
            const brakeThrottle = team.heat > 74 ? 2 : 3;
            const brakeJoyY = altitude < 32 ? 0.18 : 0.02;
            const brakeRoll = Math.PI / 4.8;
            candidates.push(
                { ...base, state: 'urbanBrakeTurnLeft', statusText: 'NPC: 城市規劃-減速左急轉', throttle: brakeThrottle, joyX: -0.92, joyY: brakeJoyY, roll: -brakeRoll, brakeTurn: true, reason: 'Urban brake turn left; one-turn speed trade for turn radius' },
                { ...base, state: 'urbanBrakeTurnRight', statusText: 'NPC: 城市規劃-減速右急轉', throttle: brakeThrottle, joyX: 0.92, joyY: brakeJoyY, roll: brakeRoll, brakeTurn: true, reason: 'Urban brake turn right; one-turn speed trade for turn radius' },
                { ...base, state: 'urbanBrakeTurnBreakSide', statusText: 'NPC: 城市規劃-減速脫離轉向', throttle: brakeThrottle, joyX: this.clamp(breakSide * 0.88, -0.95, 0.95), joyY: brakeJoyY, roll: this.clamp(breakSide * brakeRoll, -brakeRoll, brakeRoll), brakeTurn: true, reason: 'Urban brake turn toward merge-break side' }
            );
        }

        const maskUsefulForThreat =
            !!ctx.actualMissileThreat ||
            !!ctx.missileThreatEvade ||
            threatScore >= 0.55 ||
            Number(ctx.distance) > this.gunRangeOr(tuning) + 35;
        if (
            maskInfo.available &&
            maskInfo.direction &&
            !maskInfo.pathBlocked &&
            maskInfo.score >= 70 &&
            !closeCombatDefer &&
            maskUsefulForThreat
        ) {
            candidates.push({
                ...base,
                state: 'urbanRouteMask',
                statusText: 'NPC: 城市規劃-遮蔽航線',
                throttle: maskInfo.distance > 45 ? 4 : 3,
                joyX: this.clamp(maskInfo.direction.x * 0.82, -0.72, 0.72),
                joyY: this.clamp(maskInfo.direction.y * 0.32 + (altitude < 24 ? 0.18 : 0), -0.18, 0.42),
                roll: this.clamp(maskInfo.direction.x * Math.PI / 5, -Math.PI / 5, Math.PI / 5),
                reason: 'Urban planner high-score mask route'
            });
        }

        // Building weave stays a scored candidate — open-sky climb wins via routeScore, not a hard skip.
        const corridorClear = !!coverInfo.corridorClear;
        const coverDistNum = Number(coverInfo.distance);
        const gapTier = gapMeta.tier;
        const weaveEligible =
            altitude >= 16 &&
            gapTier !== 'blocked' &&
            (openTurnBand || corridorClear || gapTier === 'wide' || gapTier === 'ok' || hardBuilding) &&
            (
                (
                    coverDistNum >= 12 &&
                    coverDistNum <= 36 &&
                    (
                        (coverInfo.collisionRisk === 'medium' && Number.isFinite(fwdClear) && fwdClear > 14) ||
                        (sideLanePressure && coverDistNum >= 16)
                    )
                ) ||
                (
                    (corridorClear || gapTier === 'wide' || gapTier === 'ok') &&
                    coverDistNum >= 5 &&
                    coverDistNum <= 28 &&
                    Number.isFinite(fwdClear) &&
                    fwdClear > 10
                ) ||
                (!!gapHold && coverDistNum >= 5 && coverDistNum <= 32)
            );
        if (weaveEligible) {
            const weaveJoyY = gapTier === 'wide'
                ? (altitude < 30 ? 0.14 : 0.04)
                : (altitude < 30 ? 0.2 : 0.05);
            const weaveJoyScale = combatPressure
                ? (gapTier === 'wide' ? 0.28 : (corridorClear ? 0.32 : 0.38))
                : (gapTier === 'wide' ? 0.34 : (corridorClear ? 0.38 : 0.48));
            // Gap hold / asymmetric corridor: commit wider side first (avoid flip thrash).
            const weaveSides = gapHold
                ? [preferredSide]
                : (gapSide ? [preferredSide, -preferredSide] : sideOrder);
            for (const side of weaveSides) {
                candidates.push({
                    ...base,
                    state: 'urbanBuildingWeave',
                    statusText: (corridorClear || gapTier === 'wide' || gapTier === 'ok')
                        ? 'NPC: 城市規劃-縫道穿梭'
                        : 'NPC: 城市規劃-建築穿梭',
                    throttle: team.heat > 78 ? 3 : (combatPressure ? 5 : 4),
                    joyX: this.clamp(side * weaveJoyScale, -0.62, 0.62),
                    joyY: weaveJoyY,
                    roll: this.clamp(side * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
                    reason: gapHold
                        ? 'Urban planner gap-hold corridor weave'
                        : (corridorClear || gapTier === 'ok' || gapTier === 'wide'
                            ? 'Urban planner corridor weave'
                            : (sideLanePressure
                                ? 'Urban planner side-lane weave'
                                : 'Urban planner building-lane weave'))
                });
            }
        }

        const facadeClosing =
            earlyApproach ||
            !!ctx.facadeClosingScore ||
            this.isFacadeClosingScore(coverInfo);
        const startClear = Number(coverInfo.distance);

        const routeSelfPitch = (team && team.wrapper)
            ? Math.asin(this.clamp(new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize().y, -1, 1))
            : null;
        const routeSelfAp = (team && typeof team.ap === 'number') ? team.ap : null;
        const energyCriticalNow = !!team.stalled
            || (Number.isFinite(routeSelfAp) && routeSelfAp < Number(tuning.energyCriticalAp || 52));
        const energyBad = energyLow || energyCriticalNow;
        const thrOpts = {
            heat: team.heat || 0,
            ap: routeSelfAp,
            energyCritical: energyCriticalNow,
            lowAp: tuning.lowAp,
            // Embed push candidates need thr4 authority — don't ECO-cap them as smash thrash.
            hardBuilding: hardBuilding && !meshEmbed
        };
        let best = null;
        for (const candidate of candidates) {
            // Phase A: cap thr to match turn physics before sim (AB kills turnLimit).
            if (!candidate.brakeTurn) {
                const embedSoftThr = candidate.state === 'urbanEmbedPushOut' || meshEmbed;
                candidate.throttle = this.pickThrottleForTurn(candidate.throttle || 4, candidate.joyX || 0, {
                    ...thrOpts,
                    hardBuilding: embedSoftThr ? false : thrOpts.hardBuilding
                });
            } else if (energyBad) {
                candidate.throttle = this.pickThrottleForTurn(Math.min(candidate.throttle || 3, 3), candidate.joyX || 0, thrOpts);
            }
            // Mid-low energy: soften hard emergency sticks before scoring.
            if (
                energyBad &&
                altitude < 48 &&
                (candidate.state === 'obstacleEmergencyRoute' || candidate.state === 'obstacleEnergyClimbRoute') &&
                Math.abs(candidate.joyX || 0) > 0.7
            ) {
                candidate.joyX = this.clamp(candidate.joyX, -0.62, 0.62);
                if ((candidate.joyY || 0) > 0.28) candidate.joyY = 0.22;
            }
            this.adjustActionForCombatBand(candidate, altitude, coverInfo, tuning, routeSelfPitch, routeSelfAp);
            const useBeam = this.shouldUseRouteBeam(coverInfo, { tuning });
            let eval2;
            if (useBeam) {
                const beam = this.beamSearchRouteContinuations(teamId, base, candidate, team, altitude, energyBad, {
                    coverInfo,
                    tuning,
                    selfPitch: routeSelfPitch,
                    selfAp: routeSelfAp,
                    preferredSide,
                    meshEmbed,
                    horizon: this.getRoutePlanHorizon(),
                    beamWidth: this.getRouteBeamWidth()
                });
                if (beam.pruned) continue;
                eval2 = beam.eval;
            } else {
                const conts = this.buildLinearRouteContinuations(
                    base, candidate, team, altitude, energyBad,
                    { coverInfo, tuning, selfPitch: routeSelfPitch, selfAp: routeSelfAp },
                    Math.min(3, this.getRoutePlanHorizon())
                );
                eval2 = this.evaluateActionSafety(teamId, candidate, conts);
                if (this.shouldPruneRouteEval(eval2, team, 2)) continue;
            }
            let routeScore = eval2.score;
            const turnAuth = Math.abs(Number(candidate.joyX) || 0);
            const sideSign = Math.sign(Number(candidate.joyX) || 0) || 0;
            const gapAsym = this.getCorridorGapAsymmetry(coverInfo);
            const fwdTight =
                (Number.isFinite(fwdClear) && fwdClear > 0 && fwdClear < 12) ||
                (Number.isFinite(Number(coverInfo.forwardDistance)) &&
                    Number(coverInfo.forwardDistance) > 0 &&
                    Number(coverInfo.forwardDistance) < 10);
            const apDrop = Number(eval2.apDrop);
            const finalAP = Number(eval2.finalAP);
            if (Number.isFinite(eval2.sink) && eval2.sink <= 6) routeScore += 14;
            else if (Number.isFinite(eval2.sink) && eval2.sink > 12) routeScore -= Math.min(40, (eval2.sink - 12) * 2);
            if (!eval2.buildingHit) routeScore += 80;
            // All candidates: one-sided gap bias (not weave-only).
            if (gapAsym.strength >= 1 && sideSign) {
                if (sideSign === gapAsym.side) routeScore += gapAsym.strength >= 2 ? 64 : 36;
                else if (sideSign === -gapAsym.side) routeScore -= gapAsym.strength >= 2 ? 82 : 46;
            }
            if (candidate.state === 'urbanBuildingWeave') {
                const nb = Number(eval2.nearestBuilding);
                const corridor = !!coverInfo.corridorClear;
                const gapW = Number(coverInfo.corridorGap);
                // Corridor sweet spot ~6–14m; legacy mid-lane ~10–24m.
                if (corridor && nb >= 6 && nb <= 14) routeScore += 72;
                else if (nb >= 10 && nb <= 24) routeScore += 58;
                else if (nb >= 8 && nb < 10) routeScore += 36;
                else if (nb > 32) routeScore -= 28;
                else if (Number.isFinite(nb) && nb < 6) routeScore -= corridor ? 40 : 90;
                if ((candidate.joyY || 0) < 0.22) routeScore += 14;
                if (Number.isFinite(nb) && nb < 8 && !corridor) routeScore -= 40;
                if (corridor) routeScore += 24;
                // Continuous gapWidth scoring (was boolean-only).
                if (Number.isFinite(gapW)) {
                    if (gapW >= 10) routeScore += 36;
                    else if (gapW >= gapMeta.minGap) routeScore += 22;
                    else if (gapW >= gapMeta.minGap * 0.75) routeScore += 6;
                    else routeScore -= 28;
                }
                if (gapHold && sideSign === preferredSide) routeScore += 40;
                if (gapSide && sideSign === gapSide) routeScore += 28;
                else if (gapSide && sideSign === -gapSide) routeScore -= 34;
                // Stay in flyable street when gap is open — climb thrash loses score.
                if ((corridor || gapMeta.tier === 'wide') && Number.isFinite(fwdClear) && fwdClear >= 18) {
                    if ((candidate.joyY || 0) <= 0.22) routeScore += 18;
                }
                // Mild weave preserves AP in the turn-forced mid-low band.
                if (turnAuth <= 0.55) routeScore += energyBad ? 28 : 12;
            } else if (eval2.nearestBuilding >= 12) {
                routeScore += eval2.nearestBuilding * 4;
            } else if (eval2.nearestBuilding >= 8) {
                routeScore += 16;
            }
            // Energy-aware route: prefer AP retention over hard lateral thrash.
            if (finalAP >= 90) routeScore += 28;
            else if (finalAP >= 80) routeScore += 22;
            else if (finalAP < 60) routeScore -= energyBad ? 55 : 35;
            else if (finalAP < 72) routeScore -= energyBad ? 28 : 12;
            if (Number.isFinite(apDrop) && apDrop > 22) {
                routeScore -= Math.min(70, (apDrop - 22) * (turnAuth >= 0.55 ? 2.2 : 1.2));
            }
            if (altitude < 48 && turnAuth >= 0.75) {
                routeScore -= energyBad ? 48 : 22;
                if ((candidate.joyY || 0) > 0.3) routeScore -= 18;
            } else if (altitude < 48 && turnAuth <= 0.55 && !eval2.buildingHit) {
                routeScore += energyBad ? 20 : 8;
            }
            // T50: under combat pressure prefer shallow+fast over ECO serpentine (sitting duck).
            if (
                combatPressure &&
                (candidate.state === 'urbanRouteSide' ||
                    candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanRouteBreakSide' ||
                    candidate.state === 'urbanBuildingWeave')
            ) {
                if (turnAuth <= 0.48) routeScore += 32;
                if (turnAuth >= 0.58) routeScore -= 40;
                if ((candidate.throttle || 0) >= 4) routeScore += 14;
                if ((candidate.throttle || 0) <= 3 && turnAuth >= 0.5) routeScore -= 22;
            }
            // Player doctrine: straight + climb + thr4–5 rebuilds AP/altitude; medium turns only in open/high.
            const isEnergyCruise =
                candidate.state === 'urbanEnergyCruise' ||
                candidate.state === 'urbanEnergyCruiseCut';
            if (isEnergyCruise && !eval2.buildingHit) {
                routeScore += energyCruisePreferred ? 56 : 28;
                if (preferStraightClimb) routeScore += 36;
                if ((candidate.throttle || 0) >= 4) routeScore += 22;
                if (turnAuth <= 0.3) routeScore += 26;
                if ((candidate.joyY || 0) >= 0.05 && (candidate.joyY || 0) <= 0.32) routeScore += 18;
                if (Number.isFinite(apDrop) && apDrop <= 10) routeScore += 20;
                if (Number.isFinite(finalAP) && Number.isFinite(apNow) && finalAP >= apNow - 4) routeScore += 16;
            }
            // Open-sky altitude bank: score preference vs low-speed snake (candidates still compete).
            if (preferStraightClimb && !hardBuilding && !eval2.buildingHit) {
                if (candidate.state === 'urbanBuildingWeave' && !corridorClear) {
                    routeScore -= 55;
                    if ((candidate.throttle || 0) <= 3) routeScore -= 28;
                    if (turnAuth >= 0.36) routeScore -= 22;
                } else if (
                    candidate.state === 'urbanRouteSide' ||
                    candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanRouteBreakSide'
                ) {
                    if (turnAuth >= 0.45) routeScore -= 24;
                    if ((candidate.throttle || 0) <= 3 && turnAuth >= 0.32) routeScore -= 18;
                    if ((candidate.joyY || 0) >= 0.1 && turnAuth <= 0.36) routeScore += 18;
                }
                if (candidate.state === 'urbanRouteClimbOut' || candidate.state === 'urbanClimbingTurn') {
                    routeScore += 24;
                }
                if (isEnergyCruise) routeScore += 20;
            }
            // Hard choke / central table: weave into dead gap loses; prefer overfly / hard exit (T14).
            const chokeSev = Number(coverInfo.hardChokeSeverity) || 0;
            if (coverInfo.hardChoke && chokeSev >= 1) {
                if (candidate.state === 'urbanBuildingWeave') {
                    routeScore -= chokeSev >= 2 ? 120 : 72;
                }
                if (
                    candidate.state === 'urbanEnergyCruise' ||
                    candidate.state === 'urbanEnergyCruiseCut'
                ) {
                    routeScore -= chokeSev >= 2 ? 70 : 36;
                }
                if (
                    !underRoof &&
                    (candidate.state === 'urbanRouteClimbOut' ||
                        candidate.state === 'urbanClimbingTurn' ||
                        candidate.state === 'obstacleEnergyClimbRoute')
                ) {
                    routeScore += chokeSev >= 2 ? 48 : 28;
                    if ((candidate.joyY || 0) >= 0.28) routeScore += 18;
                }
                if (
                    underRoof &&
                    (candidate.state === 'urbanEmbedPushOut' ||
                        candidate.state === 'obstacleEmergencyRoute' ||
                        candidate.state === 'urbanRouteSide' ||
                        candidate.state === 'urbanRouteBreakSide')
                ) {
                    routeScore += 36;
                    if (turnAuth >= 0.4) routeScore += 16;
                }
            }
            // Facade closing (score-only, wider than earlyApproach): reward opening clearance.
            if (facadeClosing && !underRoof) {
                const nb = Number(eval2.nearestBuilding);
                // Weak bank into a closing face = dead-center smash (T76 blue climbOut joyX≈0.16).
                if (turnAuth < 0.32) routeScore -= 70;
                else if (turnAuth < 0.4) routeScore -= 28;
                if (fwdTight && turnAuth < 0.42) routeScore -= 55;
                const climbish =
                    candidate.state === 'urbanRouteClimbOut' ||
                    candidate.state === 'urbanClimbingTurn' ||
                    candidate.state === 'urbanEnergyCruise' ||
                    candidate.state === 'urbanEnergyCruiseCut';
                if (turnAuth < 0.36 && climbish) {
                    routeScore -= 55;
                }
                // Facade + tiny fwd: climb/weak bank loses hard to gap cut (T150 red2).
                if (fwdTight && (candidate.state === 'urbanClimbingTurn' || candidate.state === 'urbanRouteClimbOut')) {
                    routeScore -= turnAuth < 0.48 ? 110 : 55;
                    if (gapAsym.strength >= 1 && sideSign === -gapAsym.side) routeScore -= 70;
                }
                if (gapAsym.strength >= 2 && sideSign === gapAsym.side && turnAuth >= 0.4 && !eval2.buildingHit) {
                    routeScore += 52;
                }
                if (!eval2.buildingHit) {
                    const lateralCut =
                        candidate.state === 'urbanPreemptiveRoute' ||
                        candidate.state === 'urbanRouteSide' ||
                        candidate.state === 'urbanRouteBreakSide' ||
                        candidate.state === 'obstacleEmergencyRoute' ||
                        candidate.state === 'obstacleEnergyClimbRoute' ||
                        candidate.state === 'urbanEmbedPushOut';
                    // Prefer hard lateral over climb-into-wall when gap is one-sided / fwd tight.
                    if (lateralCut || (!fwdTight && !gapAsym.strength && (
                        candidate.state === 'urbanClimbingTurn' ||
                        candidate.state === 'urbanRouteClimbOut'
                    ))) {
                        if (turnAuth >= 0.36 && turnAuth <= 0.62) routeScore += 52;
                        if (turnAuth >= 0.4) routeScore += 24;
                        if ((candidate.throttle || 0) >= 4 && turnAuth <= 0.62) routeScore += 14;
                        if (Number.isFinite(nb) && nb >= 12) routeScore += 28;
                        if (preferStraightClimb && (candidate.joyY || 0) >= 0.14 && turnAuth >= 0.36) routeScore += 22;
                    }
                    if (
                        !fwdTight &&
                        gapAsym.strength < 2 &&
                        (candidate.state === 'urbanClimbingTurn' || candidate.state === 'urbanRouteClimbOut') &&
                        turnAuth >= 0.4
                    ) {
                        if (turnAuth >= 0.36 && turnAuth <= 0.62) routeScore += 28;
                        if (turnAuth >= 0.4) routeScore += 12;
                    }
                    if (Number.isFinite(startClear) && Number.isFinite(nb)) {
                        if (nb >= startClear + 4) routeScore += 48;
                        else if (nb <= startClear - 3) routeScore -= 40;
                    }
                }
                if (isEnergyCruise && Number.isFinite(fwdClear) && fwdClear > 2 && fwdClear < 28) {
                    // Straight into closing facade loses to cut/climb on score.
                    routeScore -= preferStraightClimb ? 36 : 64;
                }
                if (candidate.state === 'urbanBuildingWeave' && !corridorClear) {
                    routeScore -= 48;
                }
                if (
                    preferStraightClimb &&
                    !fwdTight &&
                    (candidate.state === 'urbanClimbingTurn' || candidate.state === 'urbanRouteClimbOut') &&
                    !eval2.buildingHit
                ) {
                    routeScore += 36;
                }
            }
            // Steep dive into facade: level-out sticks win; hard lateral thrash loses (T68 blue2).
            const diveIntoFacade =
                !!ctx.diveIntoFacade ||
                this.isSteepDiveIntoFacade(coverInfo, Number(ctx.forwardY) || 0, altitude);
            if (diveIntoFacade && !underRoof && !eval2.buildingHit) {
                if ((candidate.joyY || 0) >= 0.45 && turnAuth <= 0.4) routeScore += 70;
                if ((candidate.joyY || 0) >= 0.55 && turnAuth <= 0.35) routeScore += 28;
                if (turnAuth >= 0.55) routeScore -= 55;
                if (isEnergyCruise) routeScore -= 50;
                if (candidate.state === 'urbanBuildingWeave') routeScore -= 60;
                if (
                    candidate.state === 'urbanClimbingTurn' ||
                    candidate.state === 'urbanRouteClimbOut' ||
                    candidate.state === 'obstacleEmergencyRoute' ||
                    candidate.state === 'obstacleEnergyClimbRoute'
                ) {
                    if ((candidate.joyY || 0) >= 0.4) routeScore += 36;
                }
            }
            // Conservative early facade sticks: shallow side wins; thrash loses (still score, not ban).
            if (earlyApproach && !hardBuilding) {
                if (isEnergyCruise) routeScore -= preferStraightClimb ? 20 : 56;
                if (candidate.state === 'urbanBuildingWeave') routeScore -= preferStraightClimb ? 60 : 40;
                if (
                    candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanRouteSide' ||
                    candidate.state === 'urbanRouteBreakSide' ||
                    candidate.state === 'obstacleEmergencyRoute'
                ) {
                    if (preferStraightClimb && (candidate.joyY || 0) >= 0.14 && turnAuth <= 0.4) {
                        routeScore += 24;
                    } else if (turnAuth <= 0.48) {
                        routeScore += 40;
                    }
                    if (turnAuth >= 0.7) routeScore -= 50;
                    if ((candidate.throttle || 0) >= 4 && turnAuth <= 0.5) routeScore += 10;
                }
                if (
                    preferStraightClimb &&
                    (candidate.state === 'urbanClimbingTurn' || candidate.state === 'urbanRouteClimbOut')
                ) {
                    routeScore += 32;
                }
            }
            if (!openTurnBand && !hardBuilding && !isEnergyCruise) {
                if (turnAuth >= 0.45) routeScore -= 42;
                if (turnAuth >= 0.55) routeScore -= 28;
                if ((candidate.throttle || 0) <= 3 && turnAuth >= 0.4) routeScore -= 24;
            }
            // Open band: prefer straight cruise, penalize continuous medium turn (open snake).
            if (openTurnBand && !hardBuilding) {
                if (isEnergyCruise) routeScore += 44;
                if (!isEnergyCruise && turnAuth >= 0.36) routeScore -= 38;
                if (!isEnergyCruise && turnAuth >= 0.5) routeScore -= 28;
                if ((candidate.throttle || 0) <= 3 && turnAuth >= 0.35) routeScore -= 30;
            }
            if (candidate.state === 'urbanRouteMask') {
                routeScore += Math.min(45, (maskInfo.score || 0) * 0.18);
                // Long mask ingress is a combat killer when already inside gun envelope.
                if (Number(maskInfo.distance) > 55) routeScore -= 90;
                if (Number(ctx.distance) < this.gunRangeOr(tuning) + 25) routeScore -= 70;
            }
            // High band + closing contact: soft preemptive/climb loses to merge deconfliction.
            if (
                altitude >= Math.max(Number(tuning.combatBandMin || 35) + 10, 48) &&
                Number.isFinite(Number(ctx.distance)) &&
                Number(ctx.distance) > 0 &&
                Number(ctx.distance) <= 18 &&
                (candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanClimbingTurn' ||
                    candidate.state === 'urbanRouteSide')
            ) {
                routeScore -= candidate.state === 'urbanClimbingTurn' ? 110 : 85;
            }
            if (candidate.state === 'urbanClimbingTurn' || candidate.state === 'urbanRouteClimbOut') {
                const roofEscapeScore = Math.min(Number(tuning.combatBandMax) || 92, 80);
                const hardContactRoute = this.isHardBuildingContact(coverInfo);
                const roofNeg = Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 2;
                // Under-roof / hard contact: climb candidates lose on score (no stick ban beyond eligibility).
                if (hardContactRoute || roofNeg || underRoof) {
                    routeScore -= 120;
                    if ((candidate.joyY || 0) > 0.22) routeScore -= 40;
                } else if (preferRoofExit || preferStraightClimb) {
                    // Soft Slice B: bias climb-out / straight climb when sky is clear.
                    routeScore += preferRoofExit ? (denseUrban ? 58 : 44) : (denseUrban ? 48 : 36);
                    if (candidate.state === 'urbanRouteClimbOut') routeScore += 22;
                    if (turnAuth <= 0.36) routeScore += 16;
                    if ((candidate.throttle || 0) >= 4) routeScore += 12;
                } else if (!weaveEligible && altitude < roofEscapeScore - 8) {
                    routeScore += denseUrban ? 28 : 18;
                } else {
                    routeScore += denseUrban ? 12 : 8;
                }
                // Weave competes on score; open-sky climb gets a mild edge (not a ban).
                if (weaveEligible && !preferStraightClimb) routeScore -= 24;
                if (preferStraightClimb && weaveEligible && candidate.state !== 'urbanBuildingWeave') routeScore += 12;
                // Mild climb under energy pressure is OK after AP/stall relax; only punish thrash-climb.
                if (energyLow && (candidate.joyY || 0) > 0.5) routeScore -= 16;
                else if (energyLow && (candidate.joyY || 0) > 0.35 && !preferStraightClimb) routeScore -= 12;
                // Past rooftop band: climbing turn leaves the city and kills weave lanes.
                if (altitude >= roofEscapeScore - 4) routeScore -= denseUrban ? 28 : 18;
                if (ctx.actualMissileThreat || ctx.missileThreatEvade) routeScore -= 80;
            }
            // Prefer level side routes when under overhang (score, not forced stick).
            // T66: while descending, do NOT reward joyY≤0.12 flat thrash into dirt/mesh.
            const embedDescending = Number(ctx.forwardY) < -0.2;
            if (
                underRoof &&
                (candidate.state === 'urbanRouteSide' ||
                    candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanRouteBreakSide' ||
                    candidate.state === 'urbanBuildingWeave')
            ) {
                routeScore += 36;
                if ((candidate.joyY || 0) <= 0.12) {
                    routeScore += embedDescending ? -24 : 12;
                } else if (embedDescending && (candidate.joyY || 0) >= 0.28) {
                    routeScore += 28;
                }
            }
            // Soft: never prefer embed push when aiMap says far clear (even if meshEmbed slipped).
            if (
                candidate.state === 'urbanEmbedPushOut' &&
                (ctx.aiMapClearAbove || ctx.aiMapSkyOpen) &&
                Number.isFinite(Number(coverInfo.distance)) &&
                Number(coverInfo.distance) >= 40 &&
                !this.isHardBuildingContact(coverInfo)
            ) {
                routeScore -= 220;
            }
            // Deep mesh embed: sustained preferred-side thr4 push beats thr3 left/right snake (T56).
            if (meshEmbed) {
                const sideSign = Math.sign(Number(candidate.joyX) || 0) || 0;
                const prefer = Math.sign(preferredSide || breakSide || 1) || 1;
                if (candidate.state === 'urbanEmbedPushOut') {
                    routeScore += 72;
                    if ((candidate.throttle || 0) >= 4) routeScore += 28;
                    if (turnAuth <= 0.52) routeScore += 22;
                }
                if (sideSign === prefer) routeScore += 52;
                else if (sideSign === -prefer) routeScore -= 62;
                if (turnAuth >= 0.55) routeScore -= 48;
                if (turnAuth >= 0.28 && turnAuth <= 0.52 && (candidate.throttle || 0) >= 4) routeScore += 50;
                if ((candidate.throttle || 0) <= 3 && turnAuth >= 0.42) routeScore -= 44;
                if (embedDescending || Number(ctx.forwardY) < -0.3) {
                    if ((candidate.joyY || 0) >= 0.36 && (candidate.joyY || 0) <= 0.55) routeScore += 48;
                    if ((candidate.joyY || 0) >= 0.18 && (candidate.joyY || 0) <= 0.5) routeScore += 20;
                    if ((candidate.joyY || 0) <= 0.12 && turnAuth >= 0.36) routeScore -= 40;
                    if ((candidate.joyY || 0) < 0.1 && turnAuth >= 0.45) routeScore -= 28;
                } else if ((candidate.joyY || 0) >= 0.08 && (candidate.joyY || 0) <= 0.28) {
                    routeScore += 16;
                }
                if (candidate.state === 'urbanBuildingWeave') routeScore -= 80;
                if (isEnergyCruise) routeScore -= 55;
                if (
                    candidate.state === 'urbanRouteSide' ||
                    candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanRouteBreakSide' ||
                    candidate.state === 'obstacleEmergencyRoute'
                ) {
                    if (sideSign === prefer && turnAuth <= 0.52) routeScore += 28;
                }
            }
            // T66 fix6: dirt/canyon altitude bleed — climb over hard side thrash (score only).
            const laneNow = String((altitudeLane && altitudeLane.lane) || '');
            const altBleed =
                (laneNow === 'dirt' || laneNow === 'canyon') &&
                Number(ctx.forwardY) < -0.15 &&
                !underRoof;
            if (altBleed && !eval2.buildingHit) {
                if (
                    candidate.state === 'urbanClimbingTurn' ||
                    candidate.state === 'urbanRouteClimbOut' ||
                    isEnergyCruise
                ) {
                    routeScore += 44;
                    if ((candidate.joyY || 0) >= 0.28) routeScore += 18;
                }
                if (
                    candidate.state === 'urbanRouteSide' ||
                    candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanRouteBreakSide' ||
                    candidate.state === 'urbanBuildingWeave'
                ) {
                    if (turnAuth >= 0.36) routeScore -= 36;
                    if (turnAuth >= 0.55) routeScore -= 28;
                }
                if (turnAuth >= 0.55 && (candidate.joyY || 0) < 0.28) routeScore -= 24;
            }
            if (altitude > tuning.combatBandMax && (candidate.joyY || 0) > 0.1) routeScore -= 45;
            if (candidate.brakeTurn) {
                routeScore += 18;
                if (coverInfo.collisionRisk !== 'low') routeScore -= 60;
                if (finalAP < 72) routeScore -= 45;
                if (eval2.nearestBuilding < 10) routeScore -= 40;
                if (energyBad) routeScore -= 40;
            }
            if ((candidate.state === 'urbanRouteSide' || candidate.state === 'urbanPreemptiveRoute') && coverInfo.collisionRisk === 'medium') {
                routeScore += 30;
            }
            // Prefer around-building / corridor over vertical escape when energy is poor OR gap is open.
            if ((corridorClear || gapMeta.tier === 'wide' || gapMeta.tier === 'ok') && !underRoof && !eval2.buildingHit) {
                if (candidate.state === 'urbanBuildingWeave') routeScore += gapMeta.tier === 'wide' ? 28 : 16;
                if (
                    (candidate.state === 'urbanRouteClimbOut' || candidate.state === 'urbanClimbingTurn') &&
                    Number.isFinite(Number(coverInfo.corridorGap)) &&
                    Number(coverInfo.corridorGap) >= 10 &&
                    Number.isFinite(fwdClear) &&
                    fwdClear >= 20
                ) {
                    routeScore -= 32;
                }
            }
            // Prefer around-building / corridor over vertical escape when energy is poor.
            // In canyon, prefer energy-cruise over sustained side thrash.
            if (energyBad) {
                if (isEnergyCruise) {
                    routeScore += openTurnBand ? 56 : 40;
                } else if (
                    candidate.state === 'urbanRouteSide' ||
                    candidate.state === 'urbanPreemptiveRoute' ||
                    candidate.state === 'urbanRouteBreakSide' ||
                    candidate.state === 'urbanBuildingWeave'
                ) {
                    // Open band: do not reward continuous side thrash while energy-poor.
                    if (openTurnBand) {
                        routeScore -= turnAuth >= 0.36 ? 20 : 0;
                        if (turnAuth <= 0.28) routeScore += 12;
                    } else {
                        routeScore += 6;
                        if (turnAuth <= 0.4) routeScore += 16;
                    }
                }
            }
            if (candidate.state === 'obstacleEmergencyRoute' && coverInfo.collisionRisk === 'medium') routeScore -= 80;
            if (energyBad && (candidate.state === 'obstacleEmergencyRoute' || candidate.state === 'obstacleEnergyClimbRoute')) {
                routeScore -= 24;
            }
            if (ctx.mandatoryMergeBreak && Math.sign(candidate.joyX || 0) === Math.sign(breakSide)) routeScore += 12;
            if (Math.sign(candidate.joyX || 0) === preferredSide) routeScore += meshEmbed ? 22 : 8;
            if (!best || routeScore > best.routeScore) {
                best = { action: candidate, eval: eval2, routeScore: Number(routeScore.toFixed(1)) };
            }
        }

        if (!best || best.eval.buildingHit || best.eval.score < -35) return null;
        if (best.action.brakeTurn) this.markBrakeTurn(teamId, turnNo);
        const mappedState =
            best.action.brakeTurn ? 'urbanBrakeTurn'
                : (best.action.state === 'obstacleEnergyClimbRoute' ? 'obstacleEnergyClimb'
                    : (best.action.state === 'obstacleEmergencyRoute' ? 'obstacleEmergencyEscape'
                        : (best.action.state === 'urbanEmbedPushOut' ? 'obstacleEmergencyEscape'
                            : (best.action.state === 'urbanPreemptiveRoute' ? 'urbanPreemptiveAvoid'
                                : (best.action.state === 'urbanClimbingTurn' ? 'urbanClimbingTurn'
                                    : (best.action.state === 'urbanBuildingWeave' ? 'urbanBuildingWeave' : 'urbanRouteEscape'))))));
        return {
            ...best.action,
            state: mappedState,
            statusText: best.action.statusText,
            urbanRoute: {
                source: best.action.state,
                brakeTurn: best.action.brakeTurn ? 1 : 0,
                score: best.routeScore,
                safetyScore: best.eval.score,
                minAlt: best.eval.minAltitude,
                finalAP: best.eval.finalAP,
                startAP: best.eval.startAP,
                apDrop: best.eval.apDrop,
                sink: best.eval.sink,
                joyX: Number(Number(best.action.joyX || 0).toFixed(2)),
                thr: best.action.throttle,
                nearestBuilding: best.eval.nearestBuilding,
                energyBad: energyBad ? 1 : 0,
                horizon: this.getRoutePlanHorizon(),
                beamWidth: this.getRouteBeamWidth(),
                lane: altitudeLane.lane,
                roofExit: preferRoofExit ? 1 : 0,
                straightClimb: preferStraightClimb ? 1 : 0,
                facadeClosing: facadeClosing ? 1 : 0,
                meshEmbed: meshEmbed ? 1 : 0,
                gapTier: gapMeta.tier,
                gapWidth: Number.isFinite(Number(coverInfo.corridorGap)) ? Number(coverInfo.corridorGap) : null,
                gapSide: gapSide || 0,
                gapHold: gapHold ? 1 : 0
            }
        };
    },

    findNearestCoverDirection(selfPos) {
        const obstacles = this.getObstacles();
        if (!obstacles || obstacles.length === 0) return null;
        let nearest = null;
        let bestDistSq = Infinity;
        const sample = new THREE.Vector3();
        for (let i = 0; i < obstacles.length; i++) {
            const obj = obstacles[i];
            if (!obj || typeof obj.getWorldPosition !== 'function') continue;
            obj.getWorldPosition(sample);
            const distSq = sample.distanceToSquared(selfPos);
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                nearest = sample.clone();
            }
        }
        if (!nearest) return null;
        return nearest.sub(selfPos).normalize();
    },

    /**
     * Roof height delta vs building AABB top (M15). Positive = aircraft above that roof.
     * Alias of getBuildingRoofClearance — prefer this name in new code.
     * Not the same as undercroft / headroom (see isTrueUnderRoof).
     */
    getRoofHeightDelta(selfPos, box) {
        if (typeof AirArenaUrbanAvoidSide !== 'undefined' && AirArenaUrbanAvoidSide.getRoofHeightDelta &&
            selfPos && box && Number.isFinite(box.max && box.max.y)) {
            return AirArenaUrbanAvoidSide.getRoofHeightDelta(selfPos.y, box.max.y);
        }
        return this.getBuildingRoofClearance(selfPos, box);
    },

    /**
     * Roof clearance vs building AABB. Positive = aircraft above roof.
     * Used so high-altitude flight is not treated as flat city maze pressure.
     * M15 note: this is roof *height delta*, not undercroft clearance (use headroom / isTrueUnderRoof).
     */
    getBuildingRoofClearance(selfPos, box) {
        if (!selfPos || !box || !Number.isFinite(box.max.y)) return 0;
        if (typeof AirArenaUrbanAvoidSide !== 'undefined' && AirArenaUrbanAvoidSide.getRoofHeightDelta) {
            return AirArenaUrbanAvoidSide.getRoofHeightDelta(selfPos.y, box.max.y);
        }
        return selfPos.y - box.max.y;
    },

    /**
     * Overhead headroom under elevated slabs / ceilings (undercroft after mesh-truth collision).
     * Positive = meters to underside of overhead mesh. Large = open sky.
     */
    getOverheadHeadroom(selfPos, maxProbe = 48) {
        const probe = Math.max(8, Number(maxProbe) || 48);
        if (!selfPos) return probe;
        const obstacles = this.getObstacles();
        let headroom = probe;

        if (obstacles && obstacles.length > 0) {
            this.raycaster.set(selfPos, new THREE.Vector3(0, 1, 0));
            this.raycaster.near = 0.15;
            this.raycaster.far = probe;
            const hits = this.raycaster.intersectObjects(obstacles, true);
            if (hits.length > 0 && Number.isFinite(hits[0].distance)) {
                headroom = Math.min(headroom, hits[0].distance);
            }

            // Elevated AABB underside: catches thin slabs where ray may graze past edges.
            const box = new THREE.Box3();
            const margin = 0.35;
            for (let i = 0; i < obstacles.length; i++) {
                const obj = obstacles[i];
                if (!obj || (obj.userData && obj.userData.isCollisionProxy)) continue;
                this.fillObstacleWorldBox(obj, box);
                if (!Number.isFinite(box.min.y) || box.min.y <= selfPos.y + 0.2) continue;
                // Only treat as ceiling if we are under the footprint and the underside is elevated.
                if (box.min.y < 2.5) continue;
                if (selfPos.x < box.min.x - margin || selfPos.x > box.max.x + margin) continue;
                if (selfPos.z < box.min.z - margin || selfPos.z > box.max.z + margin) continue;
                const gap = box.min.y - selfPos.y;
                if (gap > 0) headroom = Math.min(headroom, gap);
            }
        }
        return headroom;
    },

    maxJoyYForHeadroom(headroom) {
        if (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.maxJoyYForHeadroom) {
            return AirArenaBuildingRisk.maxJoyYForHeadroom(headroom);
        }
        const h = Number(headroom);
        if (!Number.isFinite(h)) return 1;
        if (h < 4) return -0.12;
        if (h < 8) return 0.06;
        if (h < 14) return 0.32;
        return 1;
    },

    /** Clamp climb when under a ceiling; never fights a forced dive (joyY already low). */
    applyHeadroomClimbLimit(action, headroom, opts = {}) {
        if (!action || typeof action.joyY !== 'number') return action;
        const alt = Number(opts.altitude);
        // Dive/dirt level-out must never be nose-down capped as climb-into-mesh (T66/T42).
        if (this.isDiveLevelPullAction(action)) {
            const h = Number(headroom);
            const maxY = Number.isFinite(h) && h < 4
                ? 0.55
                : (Number.isFinite(h) && h < 8 ? 0.72 : 0.88);
            if (action.joyY > maxY) action.joyY = maxY;
            if (Number.isFinite(alt) && alt < 22 && action.joyY < 0.28) action.joyY = 0.28;
            if (action.debug) {
                action.debug.headroom = Number.isFinite(h) ? Number(h.toFixed(1)) : null;
                action.debug.headroomCap = maxY;
                action.debug.headroomDivePull = 1;
            }
            return action;
        }
        const survival =
            action.state === 'emergencyPullUp' ||
            action.state === 'emergencyRecoverLock' ||
            action.state === 'groundAvoid' ||
            action.state === 'postGroundClimbOut' ||
            !!action.groundPull ||
            String(action.state || '').indexOf('GroundPull') >= 0;
        // T28 red2: h=3.8 forced joyY=-0.12 at alt=1.6 → smashed dirt under slab.
        // Near dirt undercroft: lateral exit + keep enough pull; never nose-down into floor.
        if (survival && Number.isFinite(alt) && alt < 14 && Number.isFinite(Number(headroom)) && Number(headroom) < 10) {
            const h = Number(headroom);
            if (Math.abs(Number(action.joyX) || 0) < 0.4) {
                const side = Math.sign(Number(action.joyX) || 0) || (opts.defaultSide || 1);
                action.joyX = this.clamp(side * 0.48, -0.52, 0.52);
            }
            const softCap = h < 4 ? 0.35 : 0.42;
            // Single band — do not soft-cap then force a higher min (self-conflict).
            if (action.joyY > softCap) action.joyY = softCap;
            else if (action.joyY < Math.min(0.32, softCap)) action.joyY = Math.min(0.32, softCap);
            if (typeof action.throttle === 'number' && action.throttle > 4) action.throttle = 4;
            if (action.debug) {
                action.debug.headroom = Number(h.toFixed(1));
                action.debug.headroomCap = softCap;
                action.debug.headroomDirtExit = 1;
            }
            return action;
        }
        const maxJoy = this.maxJoyYForHeadroom(headroom);
        if (action.joyY > maxJoy) action.joyY = maxJoy;
        if (Number.isFinite(headroom) && headroom < 8 && action.debug) {
            action.debug.headroom = Number(headroom.toFixed(1));
            action.debug.headroomCap = Number(maxJoy.toFixed(2));
        }
        return action;
    },

    /**
     * Downgrade / ignore horizontal building bubble when already clear above the roof.
     * Diving into the footprint keeps real risk.
     */
    applyRoofClearanceToRisk(baseRisk, clearance, selfForward, forwardDist, lateral) {
        if (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.applyRoofClearanceToRisk) {
            return AirArenaBuildingRisk.applyRoofClearanceToRisk(
                baseRisk,
                clearance,
                selfForward && selfForward.y,
                forwardDist,
                lateral
            );
        }
        const CLEAR = 8;
        const SOFT = 4;
        const divingInto =
            Number(selfForward && selfForward.y) < -0.2 &&
            Number.isFinite(forwardDist) &&
            forwardDist > 0 &&
            forwardDist < 42 &&
            Math.abs(Number(lateral) || 0) < 22;
        if (clearance >= CLEAR && !divingInto) return 'low';
        if (clearance >= SOFT && !divingInto) {
            if (baseRisk === 'high') return 'medium';
            if (baseRisk === 'medium') return 'low';
        }
        if (clearance >= CLEAR && divingInto && baseRisk === 'low') return 'medium';
        if (Number.isFinite(clearance) && clearance < 0 && (baseRisk === 'low' || !baseRisk)) {
            return 'medium';
        }
        return baseRisk;
    },

    /** Scheme B: shift risk down N tiers (high→medium→low). */
    downgradeBuildingRisk(risk, steps = 1) {
        if (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.downgradeBuildingRisk) {
            return AirArenaBuildingRisk.downgradeBuildingRisk(risk, steps);
        }
        const n = Math.max(0, Math.floor(Number(steps) || 0));
        if (n <= 0) return risk || 'low';
        let r = risk || 'low';
        for (let i = 0; i < n; i++) {
            if (r === 'high') r = 'medium';
            else if (r === 'medium') r = 'low';
            else break;
        }
        return r;
    },

    applyCoverModeFromRisk(info) {
        if (!info) return info;
        if (info.collisionRisk === 'high') info.mode = 'collisionAvoid';
        else if (info.collisionRisk === 'medium') info.mode = 'coverMaskTurn';
        else if (Number.isFinite(info.distance) && info.distance > 32) info.mode = 'coverIngress';
        else if (info.available) info.mode = 'coverMaskTurn';
        else info.mode = 'clear';
        return info;
    },

    getCoverInfo(selfPos, selfForward, ap = 120) {
        const obstacles = this.getObstacles();
        const tuning = this.getTuning();
        const riskDowngrade = Number(tuning.buildingRiskDowngrade);
        const riskProfile = (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.getBuildingRiskProfile)
            ? AirArenaBuildingRisk.getBuildingRiskProfile(tuning.buildingRiskProfile)
            : {
                highDist: 6, highFwd: 14, highLat: 10,
                medDist: 14, medFwd: 28, medLat: 16,
                rayHigh: 14, rayMed: 28,
                corridorProbe: 36, corridorMinGap: 5.5, id: 'gap'
            };
        const info = {
            available: false,
            direction: null,
            distance: Infinity,
            forwardDistance: Infinity,
            collisionRisk: 'low',
            mode: 'clear',
            roofClearance: null,
            headroom: null,
            corridorClear: false,
            corridorGap: null,
            corridorLeftClear: null,
            corridorRightClear: null,
            corridorFwdClear: null,
            riskProfile: riskProfile.id || 'gap',
            riskDowngrade: Number.isFinite(riskDowngrade) ? riskDowngrade : 0,
            hardChoke: false,
            hardChokeSeverity: 0,
            hardChokeKind: null
        };
        if (!obstacles || obstacles.length === 0) {
            info.headroom = this.getOverheadHeadroom(selfPos);
            info.corridorClear = true;
            info.corridorGap = 999;
            info.corridorLeftClear = 999;
            info.corridorRightClear = 999;
            info.corridorFwdClear = Number(riskProfile.corridorProbe) || 36;
            return info;
        }

        const box = new THREE.Box3();
        const nearestPoint = new THREE.Vector3();
        const clampedPoint = new THREE.Vector3();
        const flatForward = selfForward.clone();
        flatForward.y = 0;
        if (flatForward.lengthSq() < 0.0001) flatForward.set(0, 0, 1);
        flatForward.normalize();

        let bestThreat = {
            riskPriority: 3,
            distance: Infinity,
            forwardDist: Infinity,
            collisionRisk: 'low',
            nearestPoint: null,
            roofClearance: null,
            box: null
        };

        for (let i = 0; i < obstacles.length; i++) {
            const obj = obstacles[i];
            if (!obj) continue;
            this.fillObstacleWorldBox(obj, box);
            box.clampPoint(selfPos, clampedPoint);
            const dist = clampedPoint.distanceTo(selfPos);
            const clearance = this.getBuildingRoofClearance(selfPos, box);
            const toBuilding = clampedPoint.clone().sub(selfPos);
            const flatTo = toBuilding.clone();
            flatTo.y = 0;
            const flatDist = flatTo.length();
            const forwardDist = flatDist > 0.001 ? flatTo.normalize().dot(flatForward) * flatDist : 0;
            const lateral = flatForward.x * toBuilding.z - flatForward.z * toBuilding.x;
            const behind = forwardDist < -4;
            let collisionRisk = (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.classifyHorizontalRisk)
                ? AirArenaBuildingRisk.classifyHorizontalRisk(dist, forwardDist, lateral, riskProfile, behind)
                : (behind && dist >= 8
                    ? 'low'
                    : (dist < riskProfile.highDist || (forwardDist > 0 && forwardDist < riskProfile.highFwd && Math.abs(lateral) < riskProfile.highLat)
                        ? 'high'
                        : (dist < riskProfile.medDist || (forwardDist > 0 && forwardDist < riskProfile.medFwd && Math.abs(lateral) < riskProfile.medLat) ? 'medium' : 'low')));
            collisionRisk = this.applyRoofClearanceToRisk(
                collisionRisk,
                clearance,
                selfForward,
                forwardDist,
                lateral
            );
            // Contact / early under-roof envelope must stay high — Scheme B must not soft-pedal.
            const contactLike =
                dist < 4 ||
                (Number.isFinite(clearance) && clearance < 0 && dist < 12) ||
                (Number.isFinite(clearance) && clearance < 2 && dist < 6);
            // Beside taller AABB (roof negative, still open laterally): never Scheme-B all the way to low.
            const roofPressure =
                Number.isFinite(clearance) && clearance < 0 && dist < 40;
            if (!contactLike) {
                collisionRisk = this.downgradeBuildingRisk(collisionRisk, riskDowngrade);
                if (roofPressure && collisionRisk === 'low') collisionRisk = 'medium';
            } else {
                collisionRisk = 'high';
            }
            // Purely overhead clutter with solid clearance: do not compete as "nearest threat".
            if (collisionRisk === 'low' && clearance >= 8 && flatDist < 28) continue;

            const riskPriority = collisionRisk === 'high' ? 0 : (collisionRisk === 'medium' ? 1 : 2);
            if (riskPriority < bestThreat.riskPriority || (riskPriority === bestThreat.riskPriority && dist < bestThreat.distance)) {
                bestThreat = {
                    riskPriority,
                    distance: dist,
                    forwardDist: forwardDist,
                    collisionRisk,
                    nearestPoint: clampedPoint.clone(),
                    roofClearance: clearance,
                    box: box.clone()
                };
            }
        }

        if (bestThreat.nearestPoint) {
            info.available = true;
            info.distance = bestThreat.distance;
            info.forwardDistance = bestThreat.forwardDist;
            info.collisionRisk = bestThreat.collisionRisk;
            info.roofClearance = Number.isFinite(bestThreat.roofClearance)
                ? Number(bestThreat.roofClearance.toFixed(1))
                : null;
            nearestPoint.copy(bestThreat.nearestPoint);
            // Embedded (clamp≈self): push out of AABB horizontally — never invent "up" as escape.
            if (bestThreat.distance < 1.5 && bestThreat.box) {
                const outside = this.clampPointOutsideBox(selfPos, bestThreat.box, 8);
                const push = outside.clone().sub(selfPos);
                push.y = 0;
                if (push.lengthSq() > 0.0001) {
                    info.direction = push.normalize();
                } else {
                    info.direction = new THREE.Vector3(-flatForward.z, 0, flatForward.x).normalize();
                }
            } else {
                const awayFromBuilding = nearestPoint.clone().sub(selfPos);
                if (awayFromBuilding.lengthSq() < 0.0001) {
                    info.direction = new THREE.Vector3(-flatForward.z, 0, flatForward.x).normalize();
                } else {
                    info.direction = awayFromBuilding.normalize();
                }
            }
            this.applyCoverModeFromRisk(info);
        }

        const forwardCheckDistance = this.clamp(24 + (ap * 0.28), 32, 72);
        const rayDir = selfForward.clone().normalize();
        this.raycaster.set(selfPos, rayDir);
        this.raycaster.near = 0.1;
        this.raycaster.far = forwardCheckDistance;
        const hits = this.raycaster.intersectObjects(obstacles, true);
        for (let h = 0; h < hits.length; h++) {
            const hit = hits[h];
            if (!hit || !hit.object) continue;
            // Walk up to a city obstacle root for AABB roof height.
            let root = hit.object;
            while (root.parent && obstacles.indexOf(root) < 0) root = root.parent;
            this.fillObstacleWorldBox(obstacles.indexOf(root) >= 0 ? root : hit.object, box);
            const hitClearance = this.getBuildingRoofClearance(selfPos, box);
            const hitFwd = hit.distance;
            // Level/climb flight that only graze-sees a lower roof: ignore.
            if (hitClearance >= 8 && rayDir.y > -0.18) continue;
            if (hitClearance >= 4 && rayDir.y > -0.08 && hitFwd > 28) continue;

            info.forwardDistance = Math.min(info.forwardDistance, hitFwd);
            let rayRisk = (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.classifyRayRisk)
                ? AirArenaBuildingRisk.classifyRayRisk(hitFwd, riskProfile)
                : (hitFwd < riskProfile.rayHigh ? 'high' : (hitFwd < riskProfile.rayMed ? 'medium' : 'low'));
            rayRisk = this.applyRoofClearanceToRisk(rayRisk, hitClearance, selfForward, hitFwd, 0);
            if (!(
                hitFwd < 4 ||
                (Number.isFinite(hitClearance) && hitClearance < 0 && hitFwd < 12) ||
                (Number.isFinite(hitClearance) && hitClearance < 2 && hitFwd < 6)
            )) {
                rayRisk = this.downgradeBuildingRisk(rayRisk, riskDowngrade);
            } else {
                rayRisk = 'high';
            }
            if (rayRisk === 'high') {
                info.collisionRisk = 'high';
            } else if (rayRisk === 'medium' && info.collisionRisk !== 'high') {
                info.collisionRisk = 'medium';
            }
            if (info.roofClearance == null || hitClearance < info.roofClearance) {
                info.roofClearance = Number(hitClearance.toFixed(1));
            }
            this.applyCoverModeFromRisk(info);
            break;
        }

        info.headroom = Number(this.getOverheadHeadroom(selfPos).toFixed(1));

        // Corridor: flyable channel ahead (mesh-truth gaps / pillar lanes).
        const corridor = (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.evaluateCorridorClear)
            ? AirArenaBuildingRisk.evaluateCorridorClear(selfPos, flatForward, obstacles, this.raycaster, riskProfile)
            : { clear: false, fwdClear: info.forwardDistance, gapWidth: 0, leftClear: 0, rightClear: 0 };
        info.corridorClear = !!corridor.clear;
        info.corridorGap = Number.isFinite(corridor.gapWidth) ? corridor.gapWidth : null;
        info.corridorLeftClear = Number.isFinite(corridor.leftClear) ? corridor.leftClear : null;
        info.corridorRightClear = Number.isFinite(corridor.rightClear) ? corridor.rightClear : null;
        info.corridorFwdClear = Number.isFinite(corridor.fwdClear) ? corridor.fwdClear : null;
        // Hard contact / negative roof: never soft-pedal via corridor or Scheme B leftovers.
        if (this.isHardBuildingContact(info)) {
            info.collisionRisk = 'high';
            this.applyCoverModeFromRisk(info);
        } else if (info.corridorClear && info.collisionRisk === 'high' && Number(info.distance) >= 2.5) {
            // Side proximity alone should not abort a clear forward lane.
            info.collisionRisk = 'medium';
            this.applyCoverModeFromRisk(info);
        }
        const choke = (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.classifyUrbanHardChoke)
            ? AirArenaBuildingRisk.classifyUrbanHardChoke(info, { minGap: riskProfile.corridorMinGap, profile: riskProfile })
            : { active: false, severity: 0, kind: null };
        info.hardChoke = !!choke.active;
        info.hardChokeSeverity = Number(choke.severity) || 0;
        info.hardChokeKind = choke.kind || null;
        // Hard choke is never a soft corridor (geometry-generic; not map-tagged).
        if (info.hardChokeSeverity >= 2) {
            info.corridorClear = false;
            if (info.collisionRisk !== 'high') {
                info.collisionRisk = 'high';
                this.applyCoverModeFromRisk(info);
            }
        }
        return info;
    },

    isHardBuildingContact(coverInfo = {}) {
        if (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.isHardBuildingContact) {
            return AirArenaBuildingRisk.isHardBuildingContact(coverInfo);
        }
        const dist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        const roof = Number(coverInfo.roofClearance);
        if (Number.isFinite(dist) && dist < 4) return true;
        if (Number.isFinite(roof) && roof < 0 && Number.isFinite(dist) && dist < 12) return true;
        if (Number.isFinite(roof) && roof < 2 && Number.isFinite(dist) && dist < 6) return true;
        if (
            Number.isFinite(roof) &&
            roof < 0 &&
            Number.isFinite(fwd) &&
            fwd > 0 &&
            fwd < 12
        ) {
            return true;
        }
        if (coverInfo.collisionRisk === 'high' && Number.isFinite(dist) && dist < 8) return true;
        if (
            coverInfo.collisionRisk === 'high' &&
            Number.isFinite(fwd) &&
            fwd > 0 &&
            fwd < 10
        ) {
            return true;
        }
        return false;
    },

    /** Wider side of measured corridor (+1 right / -1 left). 0 = symmetric or unknown. */
    getCorridorGapSide(coverInfo = {}) {
        const left = Number(coverInfo.corridorLeftClear);
        const right = Number(coverInfo.corridorRightClear);
        if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
        const diff = left - right;
        if (Math.abs(diff) < 1.2) return 0;
        return diff > 0 ? -1 : 1;
    },

    /**
     * One-sided street opening (T150: L≪R or R≪L).
     * strength 0=none | 1=mild | 2=strong open vs tight wall.
     */
    getCorridorGapAsymmetry(coverInfo = {}) {
        const left = Number(coverInfo.corridorLeftClear);
        const right = Number(coverInfo.corridorRightClear);
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
            return { side: 0, strength: 0, open: null, closed: null };
        }
        const diff = left - right;
        const abs = Math.abs(diff);
        const open = Math.max(left, right);
        const closed = Math.min(left, right);
        if (abs < 1.2) return { side: 0, strength: 0, open, closed };
        const side = diff > 0 ? -1 : 1;
        let strength = 0;
        if ((closed < 4 && open >= 8) || abs >= 10) strength = 2;
        else if (abs >= 3 || (closed < 6 && open >= 7)) strength = 1;
        return { side, strength, open, closed };
    },

    /**
     * Gap width tiers for weave scoring (M2 corridorMinGap).
     * wide ≥~10 | ok ≥ minGap | tight ≥ 0.75·min | blocked
     */
    getCorridorGapTier(coverInfo = {}, tuning = this.getTuning()) {
        const profile = (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.getBuildingRiskProfile)
            ? AirArenaBuildingRisk.getBuildingRiskProfile(tuning.buildingRiskProfile)
            : { corridorMinGap: 5.5 };
        const minGap = Number(profile.corridorMinGap) || 5.5;
        const gap = Number(coverInfo.corridorGap);
        if (!Number.isFinite(gap)) return { tier: 'none', minGap, gap: null };
        if (gap >= Math.max(10, minGap * 1.8)) return { tier: 'wide', minGap, gap };
        if (gap >= minGap || !!coverInfo.corridorClear) return { tier: 'ok', minGap, gap };
        if (gap >= minGap * 0.75) return { tier: 'tight', minGap, gap };
        return { tier: 'blocked', minGap, gap };
    },

    /** True when a street gap/corridor is flyable (not under slab). Prefer planner over T38 flat glue. */
    isFlyableCorridorGap(coverInfo = {}, opts = {}) {
        if (opts.underRoof) return false;
        const roof = Number(coverInfo.roofClearance);
        if (Number.isFinite(roof) && roof < 2 && !opts.allowUnderRoof) return false;
        // Central table / dead undercroft: never treat as flyable street (T14).
        const sev = Number(coverInfo.hardChokeSeverity);
        if (coverInfo.hardChoke && (sev >= 2 || (sev >= 1 && Number.isFinite(roof) && roof < 0))) {
            return false;
        }
        if (coverInfo.corridorClear) return true;
        const tier = this.getCorridorGapTier(coverInfo, opts.tuning || this.getTuning()).tier;
        return tier === 'wide' || tier === 'ok';
    },

    /** Active multi-turn gap-route hold (side commitment while corridor still usable). */
    getGapRouteHold(teamId, turnNo = 1, coverInfo = {}) {
        const mem = this.getUrbanAvoidMemory(teamId);
        if (!(turnNo <= Number(mem.gapHoldUntil || -1))) return null;
        const side = Math.sign(mem.side || 0);
        if (!side) return null;
        const tier = this.getCorridorGapTier(coverInfo).tier;
        const underRoof =
            Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 2;
        if (underRoof) return null;
        if (coverInfo.hardChoke && Number(coverInfo.hardChokeSeverity) >= 1) return null;
        if (tier === 'blocked' && !coverInfo.corridorClear) return null;
        return {
            side,
            until: Number(mem.gapHoldUntil),
            source: mem.gapHoldSource || 'gap',
            tier
        };
    },

    clampPointOutsideBox(point, box, margin = 7) {
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const halfX = Math.max(size.x / 2, 1);
        const halfZ = Math.max(size.z / 2, 1);
        const out = point.clone();
        const localX = out.x - center.x;
        const localZ = out.z - center.z;
        if (Math.abs(localX) < halfX + margin && Math.abs(localZ) < halfZ + margin) {
            if (Math.abs(localX / halfX) > Math.abs(localZ / halfZ)) {
                out.x = center.x + Math.sign(localX || 1) * (halfX + margin);
            } else {
                out.z = center.z + Math.sign(localZ || 1) * (halfZ + margin);
            }
        }
        return out;
    },

    findBestMaskPoint(selfPos, enemyPos, selfForward, ap = 120) {
        const obstacles = this.getObstacles();
        const result = {
            available: false,
            point: null,
            direction: null,
            score: -999,
            masked: false,
            pathBlocked: false,
            distance: Infinity,
            clearance: 0,
            turnCostDeg: 180,
            state: 'none'
        };
        if (!obstacles || obstacles.length === 0) return result;

        const box = new THREE.Box3();
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        const enemyFlat = new THREE.Vector3();
        const candidate = new THREE.Vector3();
        const clamped = new THREE.Vector3();
        const maxConsiderDistance = 135;

        for (let i = 0; i < obstacles.length; i++) {
            const obj = obstacles[i];
            if (!obj) continue;
            this.fillObstacleWorldBox(obj, box);
            box.getCenter(center);
            box.getSize(size);

            const radius = Math.max(size.x, size.z) / 2 + 18;
            enemyFlat.subVectors(center, enemyPos);
            enemyFlat.y = 0;
            if (enemyFlat.lengthSq() < 0.001) enemyFlat.set(0, 0, 1);
            enemyFlat.normalize();
            const side = new THREE.Vector3(-enemyFlat.z, 0, enemyFlat.x);
            const y = Math.max(24, Math.min(Math.max(selfPos.y, 24), box.max.y + 8));
            const rawCandidates = [
                center.clone().add(enemyFlat.clone().multiplyScalar(radius)),
                center.clone().add(side.clone().multiplyScalar(radius)),
                center.clone().add(side.clone().multiplyScalar(-radius)),
                center.clone().add(enemyFlat.clone().multiplyScalar(radius * 0.75)).add(side.clone().multiplyScalar(radius * 0.75)),
                center.clone().add(enemyFlat.clone().multiplyScalar(radius * 0.75)).add(side.clone().multiplyScalar(-radius * 0.75))
            ];

            for (let c = 0; c < rawCandidates.length; c++) {
                candidate.copy(rawCandidates[c]);
                candidate.y = y;
                candidate.copy(this.clampPointOutsideBox(candidate, box, 14));
                box.clampPoint(candidate, clamped);
                const clearance = clamped.distanceTo(candidate);
                const dist = candidate.distanceTo(selfPos);
                if (dist > maxConsiderDistance || clearance < 12) continue;

                const toCandidate = candidate.clone().sub(selfPos);
                const dir = toCandidate.clone().normalize();
                const turnCost = selfForward.angleTo(dir) * 180 / Math.PI;
                const masked = this.hasObstacleBetween(enemyPos, candidate);
                const pathBlocked = this.hasObstacleBetween(selfPos, candidate);
                const reachable = turnCost < (ap > 140 ? 95 : 125);
                let score = 0;
                if (masked) score += 100;
                if (!pathBlocked) score += 35;
                if (reachable) score += 25;
                score += this.clamp((maxConsiderDistance - dist) / maxConsiderDistance, 0, 1) * 20;
                score += this.clamp((clearance - 5) / 20, 0, 1) * 15;
                score -= Math.max(0, turnCost - 45) * 0.35;
                if (pathBlocked) score -= 45;
                if (turnCost > 135) score -= 55;

                if (score > result.score) {
                    result.available = true;
                    result.point = candidate.clone();
                    result.direction = dir;
                    result.score = Number(score.toFixed(1));
                    result.masked = masked;
                    result.pathBlocked = pathBlocked;
                    result.distance = Number(dist.toFixed(1));
                    result.clearance = Number(clearance.toFixed(1));
                    result.turnCostDeg = Number(turnCost.toFixed(1));
                    result.state = dist > 45 ? 'maskIngress' : (masked ? 'maskedHold' : 'maskTurn');
                }
            }
        }

        return result;
    },

    updateEnemyTrack(teamId, enemyPos, canUpdate = true, assistedVelocity = null) {
        const key = this.getTrackKey(teamId);
        const prev = this.trackMemory[key];
        if (canUpdate && enemyPos) {
            let velocity = prev && prev.pos ? enemyPos.clone().sub(prev.pos) : new THREE.Vector3(0, 0, 0);
            if (assistedVelocity && assistedVelocity.lengthSq() > 0.0001) {
                // Prefer assisted (vs-human) velocity; keep a little measured delta for noise realism.
                velocity = assistedVelocity.clone().multiplyScalar(0.82).add(velocity.multiplyScalar(0.18));
            }
            this.trackMemory[key] = { pos: enemyPos.clone(), velocity };
            return this.trackMemory[key];
        }
        return prev || { pos: enemyPos ? enemyPos.clone() : null, velocity: new THREE.Vector3(0, 0, 0) };
    },

    predictEnemyPosition(teamId, enemyPos, leadTurns, canUpdateTrack = true, assistedVelocity = null) {
        const track = this.updateEnemyTrack(teamId, enemyPos, canUpdateTrack, assistedVelocity);
        const basePos = (canUpdateTrack && enemyPos)
            ? enemyPos
            : (track && track.pos ? track.pos : enemyPos);
        if (!basePos) return new THREE.Vector3();
        const vel = (assistedVelocity && assistedVelocity.lengthSq() > 0.0001)
            ? assistedVelocity
            : (track.velocity || new THREE.Vector3(0, 0, 0));
        return basePos.clone().add(vel.clone().multiplyScalar(leadTurns));
    },

    // Approximate LCOS lead for gun attacks (aligned with HUD pipper idea).
    getGunLeadAim(teamId, selfPos, selfForward, enemyPos, enemyForward, selfAp = 120, enemyAp = 120, liveSelf = null, assistedVelocity = null) {
        const distance = Math.max(1, selfPos.distanceTo(enemyPos));
        const selfSpeedStep = Math.max(0.4, (selfAp || 100) * 0.015 / 100);
        const enemySpeedStep = Math.max(0.35, (enemyAp || 100) * 0.015 / 100);
        const muzzleSpeed = 4.0;
        const closing = Math.max(1.2, muzzleSpeed + selfSpeedStep);
        // Convert frame-ish TOF into turn-lead units used by track velocity (per decide cycle).
        const framesToImpact = this.clamp(distance / closing, 4, 28);
        const leadTurns = this.clamp(framesToImpact / 18, 0.45, 1.8);
        const track = this.updateEnemyTrack(teamId, enemyPos, false);
        const trackVel = (assistedVelocity && assistedVelocity.lengthSq() > 0.0001)
            ? assistedVelocity.clone()
            : ((track && track.velocity) ? track.velocity.clone() : enemyForward.clone().multiplyScalar(enemySpeedStep));
        let aimPos = enemyPos.clone().add(trackVel.multiplyScalar(leadTurns));
        // Vs-human path cheat: bias aim toward committed ghost endpoint when available.
        const enemyId = this.getEnemyId(teamId);
        if (this.isHumanOpponent(enemyId)) {
            const liveEnemy = (typeof GameContext !== 'undefined' && GameContext.getTeam)
                ? GameContext.getTeam(enemyId)
                : null;
            if (liveEnemy && Array.isArray(liveEnemy.pathPoints) && liveEnemy.pathPoints.length >= 2) {
                const ghost = liveEnemy.pathPoints[Math.min(liveEnemy.pathPoints.length - 1, Math.max(2, Math.floor(leadTurns * 4)))];
                if (ghost && typeof ghost.clone === 'function') {
                    aimPos = aimPos.multiplyScalar(0.45).add(ghost.clone().multiplyScalar(0.55));
                }
            }
        }
        // Gravity drop compensation: aim slightly above predicted point.
        aimPos.y += this.clamp(framesToImpact * framesToImpact * 0.0011, 0.15, 2.8);
        const toAim = aimPos.clone().sub(selfPos);
        if (toAim.lengthSq() < 0.0001) {
            return {
                horizontalBias: 0,
                verticalBias: 0,
                leadTurns,
                aimDistance: distance,
                local: new THREE.Vector3(0, 0, 1)
            };
        }
        const toAimNorm = toAim.normalize();
        let local = toAimNorm.clone();
        if (liveSelf && liveSelf.wrapper) {
            local.applyQuaternion(liveSelf.wrapper.quaternion.clone().invert()).normalize();
        } else {
            // Fallback: project against current forward only.
            const right = new THREE.Vector3().crossVectors(selfForward, new THREE.Vector3(0, 1, 0));
            if (right.lengthSq() > 0.0001) {
                right.normalize();
                const up = new THREE.Vector3().crossVectors(right, selfForward).normalize();
                local = new THREE.Vector3(toAimNorm.dot(right), toAimNorm.dot(up), toAimNorm.dot(selfForward));
            }
        }
        return {
            horizontalBias: this.clamp(-local.x * 1.45, -1, 1),
            verticalBias: this.clamp(local.y * 1.05, -0.75, 0.75),
            leadTurns: Number(leadTurns.toFixed(2)),
            aimDistance: Number(toAim.length().toFixed(1)),
            local
        };
    },

    planLookaheadIntercept(teamId, selfForward, localToEnemy, enemyPos, sensorSeenNow, liveSelf, tuning) {
        const fallback = {
            horizontalBias: this.clamp(-localToEnemy.x * 1.25, -1, 1),
            verticalBias: this.clamp(localToEnemy.y * 0.85, -0.65, 0.65),
            leadTurns: 0.8,
            profile: 'direct',
            score: null
        };
        if (!liveSelf || !liveSelf.wrapper || typeof simulateFlight !== 'function') return fallback;

        const leadCandidates = [0.6, 1.0, 1.4];
        const actionProfiles = [
            { id: 'direct', x: 1.0, y: 1.0, throttle: 4 },
            { id: 'cut', x: 1.25, y: 0.9, throttle: 4 },
            { id: 'lag', x: 0.72, y: 0.65, throttle: 3 }
        ];

        let best = { ...fallback, score: -9999 };
        for (let i = 0; i < leadCandidates.length; i++) {
            const lead = leadCandidates[i];
            const enemyFuture1 = this.predictEnemyPosition(teamId, enemyPos, lead, false);
            const enemyFuture2 = this.predictEnemyPosition(teamId, enemyPos, lead + 0.8, false);
            const toFuture1 = enemyFuture1.clone().sub(liveSelf.wrapper.position);
            if (toFuture1.lengthSq() < 0.0001) continue;
            const toFuture1Norm = toFuture1.clone().normalize();
            const localFuture1 = toFuture1Norm.clone().applyQuaternion(liveSelf.wrapper.quaternion.clone().invert()).normalize();
            const baseX = this.clamp(-localFuture1.x * 1.2, -1, 1);
            const baseY = this.clamp(localFuture1.y * 0.85, -0.65, 0.65);

            for (let j = 0; j < actionProfiles.length; j++) {
                const profile = actionProfiles[j];
                const action = {
                    joyX: this.clamp(baseX * profile.x, -1, 1),
                    joyY: this.clamp(baseY * profile.y, -0.75, 0.75),
                    throttle: profile.throttle,
                    queueAction: 'none'
                };
                const command = this.actionToCommand(liveSelf, action);
                const sim = simulateFlight(liveSelf, [command, command]);
                const points = sim.points || [];
                const quats = sim.quats || [];
                if (!points.length || !quats.length) continue;
                const finalPos = points[points.length - 1];
                const finalQuat = quats[quats.length - 1];
                const finalForward = new THREE.Vector3(0, 0, 1).applyQuaternion(finalQuat).normalize();
                const toEnemy2 = enemyFuture2.clone().sub(finalPos);
                if (toEnemy2.lengthSq() < 0.0001) continue;
                const toEnemy2Norm = toEnemy2.clone().normalize();
                const finalAngleDeg = finalForward.angleTo(toEnemy2Norm) * 180 / Math.PI;
                const finalDistance = toEnemy2.length();
                const localFinal = toEnemy2Norm.clone().applyQuaternion(finalQuat.clone().invert()).normalize();

                let score = 0;
                score += this.clamp((95 - finalAngleDeg) / 95, -1, 1) * 75;
                score += this.clamp((52 - Math.abs(localFinal.x * 100)) / 52, -1, 1) * 28;
                score += this.clamp((42 - Math.abs(localFinal.y * 100)) / 42, -1, 1) * 16;
                score += this.clamp((130 - finalDistance) / 130, -1, 1) * 20;
                score -= Math.max(0, finalDistance - 90) * 0.08;
                score -= Math.max(0, Math.abs(action.joyX) - 0.8) * 25;
                score -= Math.max(0, Math.abs(action.joyY) - 0.55) * 18;
                if (profile.id === 'cut' && finalDistance < 26) score -= 12;
                score += (tuning && typeof tuning.interceptTurnGain === 'number') ? tuning.interceptTurnGain * 6 : 0;

                if (score > best.score) {
                    best = {
                        horizontalBias: action.joyX,
                        verticalBias: action.joyY,
                        leadTurns: lead,
                        profile: profile.id,
                        score: Number(score.toFixed(2)),
                        finalAngleDeg: Number(finalAngleDeg.toFixed(1)),
                        finalDistance: Number(finalDistance.toFixed(1))
                    };
                }
            }
        }

        return Number.isFinite(best.score) ? best : fallback;
    },

    withDebug(action, debugBase, tree, mode) {
        return {
            ...action,
            debug: { ...debugBase, tree, mode }
        };
    },

    /**
     * H3: stamp which named decide gate produced this action.
     */
    finishDecideGate(gateId, action) {
        if (!action) return null;
        if (!action.debug) action.debug = {};
        action.debug.decideGate = gateId;
        const order = (typeof AirArenaDecidePipeline !== 'undefined' && AirArenaDecidePipeline.DECIDE_GATE_ORDER)
            ? AirArenaDecidePipeline.DECIDE_GATE_ORDER
            : [];
        action.debug.decideGateOrder = order.indexOf(gateId);
        if (Array.isArray(action.debug.tree)) {
            action.debug.tree.push(`decidePipeline: gate=${gateId} idx=${action.debug.decideGateOrder}`);
        } else {
            action.debug.tree = [`decidePipeline: gate=${gateId}`];
        }
        return action;
    },

    /**
     * Run one named gate. Return stamped action or null if gate declines.
     */
    tryDecideGate(gateId, fn) {
        let action = null;
        try {
            action = typeof fn === 'function' ? fn() : null;
        } catch (err) {
            if (typeof CONFIG !== 'undefined' && CONFIG.debug) {
                try { console.error('[decideGate]', gateId, err); } catch (_) { /* ignore */ }
            }
            throw err;
        }
        if (!action) return null;
        return this.finishDecideGate(gateId, action);
    },

    /**
     * Named priority pipeline: first gate that returns an action wins.
     * @param {Array<[string, Function]>} gates ordered [gateId, fn] pairs
     */
    runDecidePipeline(gates) {
        const pipeline = (typeof AirArenaDecidePipeline !== 'undefined') ? AirArenaDecidePipeline : null;
        if (pipeline) {
            const ids = gates.map((g) => g[0]);
            const uniq = pipeline.assertUniqueOrder(ids);
            if (!uniq.ok && typeof CONFIG !== 'undefined' && CONFIG.debug) {
                console.warn('[decidePipeline] duplicate gates', uniq.dup);
            }
            // Soft check: MAIN order should match declared MAIN_GATE_ORDER when lengths match.
            if (ids.length === pipeline.MAIN_GATE_ORDER.length) {
                for (let i = 0; i < ids.length; i++) {
                    if (ids[i] !== pipeline.MAIN_GATE_ORDER[i] && typeof CONFIG !== 'undefined' && CONFIG.debug) {
                        console.warn(`[decidePipeline] order drift at ${i}: got ${ids[i]} expected ${pipeline.MAIN_GATE_ORDER[i]}`);
                        break;
                    }
                }
            }
        }
        for (let i = 0; i < gates.length; i++) {
            const gateId = gates[i][0];
            const fn = gates[i][1];
            const action = this.tryDecideGate(gateId, fn);
            if (action) return action;
        }
        return null;
    },

    decide(teamId, battleState = GameContext.getSerializableBattleState()) {
        const self = battleState.teams[teamId];
        const liveSelf = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        const leadId = this.getWingmanLeadId(teamId);
        const wingmanOrder = this.getWingmanOrder(teamId);

        // Phase 1: wingman support orders (follow / cover / break).
        // attack = lead's target; free = independent hunt (full combat AI).
        {
            const wingmanAction = this.tryDecideGate('wingmanSupport', () => {
                if (!(leadId && liveSelf && liveSelf.aiEnabled && this.isWingmanSupportOrder(wingmanOrder))) return null;
                return this.decideWingmanSupport(teamId, battleState, leadId, wingmanOrder) || null;
            });
            if (wingmanAction) return wingmanAction;
        }

        // Attack-my-target: lead lock / nearest living hostile of lead only.
        let enemyId = this.getEnemyId(teamId);
        if (leadId && liveSelf && liveSelf.aiEnabled && wingmanOrder === 'attack') {
            const leadTarget = (GameContext.getTargetId && GameContext.getTargetId(leadId))
                || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(leadId));
            if (leadTarget && this.isLivingEnemy(leadTarget, battleState)) {
                enemyId = leadTarget;
            } else {
                // No living target for attack → fall back to formation follow.
                const supportFallback = this.tryDecideGate('wingmanSupport', () => {
                    const support = this.decideWingmanSupport(teamId, battleState, leadId, 'follow');
                    if (!support) return null;
                    support.statusText = (support.statusText || 'NPC: 僚機') + '｜無目標改跟隨';
                    if (!support.debug) support.debug = {};
                    support.debug.wingmanOrder = 'attack';
                    support.debug.wingmanFallback = 'follow';
                    support.debug.leadId = leadId;
                    return support;
                });
                if (supportFallback) return supportFallback;
                enemyId = null;
            }
        }
        // free / 主動進攻: keep enemyId from getEnemyId (own nearest hostile).

        const enemy = (enemyId && battleState.teams) ? battleState.teams[enemyId] : null;
        const enemyAlive = this.isLivingEnemy(enemyId, battleState);

        {
            const idleAction = this.tryDecideGate('noValidTarget', () => {
                if (!(!self || self.isDestroyed || !self.position || !enemyAlive || !enemy)) return null;
                return {
                    state: 'idle',
                    statusText: 'NPC: 無有效目標',
                    throttle: 3,
                    joyX: 0,
                    joyY: 0,
                    roll: 0,
                    weapon: 'gun',
                    queueAction: 'none',
                    ready: true,
                    reason: 'No valid target'
                };
            });
            if (idleAction) return idleAction;
        }

        const selfPos = this.toVector3(self.position);
        const enemyPos = this.toVector3(enemy.position);
        const selfForward = this.toVector3(self.forward).normalize();
        const enemyForward = this.toVector3(enemy.forward).normalize();
        const turnNo = Number(battleState.currentTurn || ((typeof GameContext !== 'undefined' && GameContext.state) ? GameContext.state.currentTurn : 1) || 1);
        const arenaMode = (typeof GameContext !== 'undefined' && GameContext.getArenaMode) ? GameContext.getArenaMode() : 'buildings';
        const sensor = this.evaluateSensorContact(teamId, selfPos, selfForward, enemyPos, enemyForward, turnNo, arenaMode);
        const passiveSearchRange = this.getPassiveSearchRange(arenaMode);
        const passiveSearchBearing = !sensor.seenNow && !sensor.hasMemory && sensor.distance <= passiveSearchRange;
        const trackedEnemyPos = sensor.seenNow
            ? enemyPos
            : (sensor.memoryPos || (passiveSearchBearing ? enemyPos : null));
        if (!trackedEnemyPos) {
            const sensorBlindAction = this.tryDecideGate('sensorBlind', () => {
            const acConfig = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts) ? CONFIG.aircrafts[self.type || 'mig21'] : null;
            const maxPitchCmd = acConfig ? acConfig.maxPitch : Math.PI / 3;
            const searchGroundRisk =
                selfPos.y < 18 ||
                (selfPos.y < 28 && selfForward.y < -0.12) ||
                (selfPos.y < 40 && selfForward.y < -0.32) ||
                (selfPos.y < 52 && selfForward.y < -0.55);
            if (searchGroundRisk) {
                const ultraLow = selfPos.y < 12;
                const recoveryThrottle = this.getEmergencyRecoveryThrottle(selfPos.y, selfForward.y, self.heat || 0);
                const noseHighBlind = selfForward.y > 0.22;
                const diveBlind = selfForward.y < -0.2;
                return this.withDebug({
                    state: 'emergencyPullUp',
                    statusText: ultraLow ? `NPC: 極低空改出 ${selfPos.y.toFixed(1)}m` : `NPC: 搜索中地面避撞 ${selfPos.y.toFixed(1)}m`,
                    throttle: noseHighBlind ? Math.min(recoveryThrottle, 3) : recoveryThrottle,
                    joyX: 0.35,
                    joyY: noseHighBlind ? (ultraLow ? 0.28 : -0.08) : (diveBlind ? (ultraLow ? 0.65 : 0.48) : 0.38),
                    pitchCmd: noseHighBlind ? maxPitchCmd * 0.18 : -maxPitchCmd * (ultraLow ? 0.55 : 0.4),
                    roll: Math.PI / 8,
                    weapon: 'gun',
                    queueAction: 'none',
                    ready: true,
                    reason: noseHighBlind
                        ? 'No-contact low-alt: unload (no joyY=1 thrash)'
                        : (selfForward.y < -0.45
                            ? 'Steep dive recovery uses capped pull'
                            : (ultraLow ? 'No-contact ultra-low level-out' : 'No-contact search is overridden by ground safety'))
                }, {
                    contact: 0,
                    seenNow: 0,
                    memoryTurnsLeft: 0,
                    sensorDistance: sensor.distance,
                    sensorAngleDeg: sensor.angleDeg,
                    sensorLOS: sensor.losBlocked ? 1 : 0,
                    altitude: Number(selfPos.y.toFixed(1)),
                    forwardY: Number(selfForward.y.toFixed(2))
                }, [
                    `sensorGate: contact=0 seen=0 mem=0 dist=${sensor.distance} ang=${sensor.angleDeg}`,
                    `searchGroundGate: alt=${selfPos.y.toFixed(1)} fwdY=${selfForward.y.toFixed(2)} risk=true ultra=${ultraLow}`,
                    'selected: emergencyPullUp'
                ], 'emergencyPullUp');
            }
            const toEnemyBlind = enemyPos.clone().sub(selfPos);
            const blindLocal = toEnemyBlind.lengthSq() > 0.0001
                ? toEnemyBlind.clone().normalize().applyQuaternion(
                    liveSelf && liveSelf.wrapper
                        ? liveSelf.wrapper.quaternion.clone().invert()
                        : new THREE.Quaternion()
                ).normalize()
                : new THREE.Vector3(0, 0, 1);
            const searchYaw = this.clamp(-blindLocal.x * 0.55, -0.72, 0.72);
            return this.withDebug({
                state: 'search',
                statusText: `NPC: 遠距搜索 ${Math.floor(sensor.distance)}m`,
                throttle: self.heat > 78 ? 3 : 4,
                joyX: searchYaw,
                joyY: this.clamp(blindLocal.y * 0.35 + (selfPos.y < 24 ? 0.18 : 0.04), -0.25, 0.35),
                roll: this.clamp(searchYaw * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: 'Beyond passive search range; coarse bearing sweep'
            }, {
                contact: 0,
                seenNow: 0,
                memoryTurnsLeft: 0,
                sensorDistance: sensor.distance,
                sensorAngleDeg: sensor.angleDeg,
                sensorLOS: sensor.losBlocked ? 1 : 0
            }, [`sensorGate: contact=0 seen=0 mem=0 dist=${sensor.distance} ang=${sensor.angleDeg} passiveRange=${passiveSearchRange}`], 'search');
            });
            if (sensorBlindAction) return sensorBlindAction;
        }
        const tuning = this.getTuning();
        const acConfig = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts) ? CONFIG.aircrafts[self.type || 'mig21'] : null;
        const maxPitchCmd = acConfig ? acConfig.maxPitch : Math.PI / 3;
        const coverInfo = this.getCoverInfo(selfPos, selfForward, self.ap || self.speed || 120);
        const aiMapCtx = this.sampleAiMapContext(selfPos, {
            altitude: selfPos.y,
            radius: 80
        });
        const obstacleStressMode = arenaMode === 'obstacle-stress';

        const trackedEnemyForward = sensor.seenNow
            ? enemyForward
            : (sensor.memoryForward || enemyForward);
        const rawToEnemy = trackedEnemyPos.clone().sub(selfPos);
        const rawDistance = Math.max(0.001, rawToEnemy.length());
        const rawAngleDeg = selfForward.angleTo(rawToEnemy.clone().normalize()) * 180 / Math.PI;
        let offenseAssist = this.getOffensiveAssist(enemyId, {
            distance: rawDistance,
            angleDeg: rawAngleDeg
        });
        const assistedVelocity = offenseAssist.perfectTrack
            ? this.getAssistedEnemyVelocity(enemyId, trackedEnemyPos, trackedEnemyForward, enemy.ap || enemy.speed || 120)
            : null;
        const enemyLeadPos = this.predictEnemyPosition(teamId, trackedEnemyPos, 0.8, sensor.seenNow, assistedVelocity);
        const toEnemy = enemyLeadPos.clone().sub(selfPos);
        const distance = toEnemy.length();
        const toEnemyNorm = toEnemy.clone().normalize();
        const localToEnemy = toEnemyNorm.clone();
        if (liveSelf && liveSelf.wrapper) {
            localToEnemy.applyQuaternion(liveSelf.wrapper.quaternion.clone().invert()).normalize();
        }
        const angleToTarget = selfForward.angleTo(toEnemyNorm);
        const angleToTargetDeg = angleToTarget * 180 / Math.PI;
        offenseAssist = this.getOffensiveAssist(enemyId, {
            distance,
            angleDeg: angleToTargetDeg,
            localZ: localToEnemy.z
        });
        const loopEval = this.evaluateLoopTrap(teamId, distance, angleToTargetDeg, localToEnemy.x, turnNo);
        const lowAltRecoverLock = this.updateLowAltRecoveryLock(teamId, selfPos.y, turnNo);
        const postGroundRecoveryLock = this.updatePostGroundRecoveryLock(teamId, selfPos.y, selfForward.y, turnNo);
        const altitude = selfPos.y;
        const targetAbove = enemyLeadPos.y - selfPos.y;

        const selfSpeedStep = (self.speed || self.ap || 100) * 0.015 / 100;
        const enemySpeedStep = (enemy.speed || enemy.ap || 100) * 0.015 / 100;
        const selfVel = selfForward.clone().multiplyScalar(selfSpeedStep);
        const enemyVel = trackedEnemyForward.clone().multiplyScalar(enemySpeedStep);
        const relativeVel = selfVel.clone().sub(enemyVel);
        const closureSpeed = relativeVel.dot(toEnemyNorm);
        const predictedSeparation = distance - (closureSpeed * 40);
        const headOnFactor = trackedEnemyForward.dot(selfPos.clone().sub(enemyLeadPos).normalize());
        const overrideMode = self.aiManualOverride || 'auto';
        const policyMode = this.normalizePolicyMode(self.aiPolicyMode || this.getPolicyMode(teamId));
        const enemyToSelf = selfPos.clone().sub(enemyLeadPos).normalize();
        const enemyAspectToSelf = trackedEnemyForward.angleTo(enemyToSelf);
        const enemyMissileArmed = (enemy.pylons || []).some(p => p.state === 'armed');
        const enemyMissileStandby = (enemy.pylons || []).some(p => p.state === 'standby');
        const enemyMissileReady = enemyMissileArmed || enemyMissileStandby;
        const enemyMissileQueued = enemy.queuedAction === 'missile';
        const enemyMissileInFlight = (enemy.activeMissiles || []).some(m => m.active && !m.exploded);
        // Phase 0: typed envelopes — own attack windows vs enemy threat/flare distances.
        const pylonTypeOfEarly = (p) => (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p.weaponType || 'fox2'));
        const hasFox1LoadEarly = (self.pylons || []).some((p) => p.state !== 'empty' && pylonTypeOfEarly(p) === 'fox1');
        const hasFox2LoadEarly = (self.pylons || []).some((p) => p.state !== 'empty' && pylonTypeOfEarly(p) === 'fox2');
        const aiMissileType = this.pickAiMissileType(self, distance, angleToTargetDeg);
        const ownEnv = this.getMissileEnvelope(aiMissileType);
        const missileMinRange = ownEnv.missileMinRange;
        const missileMaxRange = ownEnv.missileMaxRange;
        const missileLockRange = ownEnv.seekerRange;
        // FOX-1 lock uses illuminate/support cone (not IR seekerAngle); min = arming floor.
        let missileLockAngle = ownEnv.seekerAngleRad;
        let missileLockMinDist = 25;
        let missileLockNoseDot = 0.82;
        if (aiMissileType === 'fox1') {
            const fox1Cfg = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox1)
                ? CONFIG.weapons.fox1
                : {};
            const supportAng = Number(fox1Cfg.supportBaseAngle) || (Math.PI / 18);
            missileLockAngle = Math.max(supportAng * 1.2, ownEnv.seekerAngleRad * 0.85);
            missileLockMinDist = missileMinRange;
            missileLockNoseDot = 0.72;
        }
        const threatType = this.inferThreatMissileType(enemy);
        const threatEnv = this.getMissileEnvelope(threatType);
        const flareTriggerDistance = threatEnv.seekerRange + (policyMode === 'heuristic' ? 14 : 8);
        const enemyCanLaunchSoon = sensor.seenNow && enemy.weapon === 'missile' && enemyMissileReady && enemyAspectToSelf < Math.PI / 3 && distance < flareTriggerDistance;
        const predictedShotWindow = sensor.seenNow && enemy.weapon === 'missile' && enemyMissileReady && distance < (flareTriggerDistance + 10) && headOnFactor > 0.45 && predictedSeparation < 30;
        const lineOfSightBlocked = this.hasObstacleBetween(enemyPos, selfPos);
        const maskInfo = this.findBestMaskPoint(selfPos, enemyPos, selfForward, self.ap || self.speed || 120);
        const flareUseDistance = threatEnv.missileMaxRange + 18;
        const missileThreatScore =
            (enemyMissileInFlight ? 0.74 : 0) +
            (enemyMissileQueued ? 0.58 : 0) +
            (enemyCanLaunchSoon ? 0.34 : 0) +
            (predictedShotWindow ? 0.26 : 0) +
            (distance < flareUseDistance ? 0.24 : 0) +
            (enemyAspectToSelf < Math.PI / 4 ? 0.16 : 0) +
            (headOnFactor > 0.58 ? 0.12 : 0) -
            (lineOfSightBlocked ? 0.25 : 0);
        const threatScore = this.clamp(missileThreatScore, 0, 1);
        const threatLevel = threatScore >= 0.78 ? 'high' : (threatScore >= 0.45 ? 'medium' : 'low');
        const missileThreatLikely = threatScore >= 0.55;
        const actualMissileThreat = enemyMissileInFlight || enemyMissileQueued;
        const missileThreatEvade =
            actualMissileThreat ||
            (threatLevel === 'high' && enemyCanLaunchSoon && distance < flareTriggerDistance) ||
            (threatScore >= 0.68 && (predictedShotWindow || enemyMissileQueued));
        const inboundClass = this.classifyInboundMissiles(enemy);
        const underSarhPaint = this.evalUnderHostileSarhLock(liveSelf || self, enemy);
        const underSarhPaintNow = !!(underSarhPaint && underSarhPaint.locked);
        const inboundFox1 = inboundClass.fox1 > 0;
        const inboundFox2 = inboundClass.fox2 > 0;
        const canUseFlare = ((liveSelf && liveSelf.flareAmmo != null ? liveSelf.flareAmmo : self.flareAmmo) || 0) > 0;
        const canUseChaff = ((liveSelf && liveSelf.chaffAmmo != null ? liveSelf.chaffAmmo : self.chaffAmmo) || 0) > 0;
        const flareAmmoNow = (liveSelf && liveSelf.flareAmmo != null ? liveSelf.flareAmmo : self.flareAmmo) || 0;
        const chaffAmmoNow = (liveSelf && liveSelf.chaffAmmo != null ? liveSelf.chaffAmmo : self.chaffAmmo) || 0;
        const lowFlareReserve = flareAmmoNow <= 1;
        const lowChaffReserve = chaffAmmoNow <= 1;
        const urgentMissileThreat = actualMissileThreat || (threatLevel === 'high' && distance < flareTriggerDistance);
        const shouldSaveFlare = lowFlareReserve && !urgentMissileThreat && !inboundFox2;
        const shouldSaveChaff = lowChaffReserve && !inboundFox1 && !underSarhPaintNow;
        const lastFlareTurn = liveSelf ? Number(liveSelf.aiLastFlareTurn || -99) : -99;
        const lastChaffTurn = liveSelf ? Number(liveSelf.aiLastChaffTurn || -99) : -99;
        const flareCooldownReady = (turnNo - lastFlareTurn) >= 2;
        const chaffCooldownReady = (turnNo - lastChaffTurn) >= 2;
        const urbanArenaMode = ['sparse-urban', 'medium-urban', 'dense-urban', 'obstacle-stress'].includes(arenaMode);
        const maskCoverAllowed = coverInfo.collisionRisk === 'low' ||
            (urbanArenaMode && coverInfo.collisionRisk === 'medium' && maskInfo.available && maskInfo.score >= 80 && !maskInfo.pathBlocked);
        const terrainSafeForMask = altitude > 24 && maskCoverAllowed && selfForward.y > -0.25;
        const maskUsable = terrainSafeForMask && maskInfo.available && maskInfo.score >= 55 && !maskInfo.pathBlocked;
        const lowAltitudeTacticalBan = altitude < 10 || lowAltRecoverLock.active;
        const fox1CmThreat =
            inboundFox1 ||
            underSarhPaintNow ||
            (threatType === 'fox1' && (enemyMissileQueued || (enemyCanLaunchSoon && threatLevel !== 'low')));
        const fox2CmThreat =
            inboundFox2 ||
            (!inboundFox1 && actualMissileThreat && threatType !== 'fox1') ||
            (threatType === 'fox2' && (enemyMissileQueued || (enemyCanLaunchSoon && missileThreatLikely)));
        // Typed CM: FOX-1 → chaff/beam; FOX-2 → flare. Do not dump IR flares at SARH.
        const shouldChaffNow =
            !lowAltitudeTacticalBan &&
            canUseChaff &&
            chaffCooldownReady &&
            !shouldSaveChaff &&
            fox1CmThreat &&
            (inboundFox1 || underSarhPaintNow || (enemyMissileQueued && threatType === 'fox1') ||
                (threatType === 'fox1' && enemyCanLaunchSoon && distance <= flareTriggerDistance));
        // Actual inbound FOX-2: flare even if a mask point scores high (mask must not suppress IR defense).
        const heuristicDefensiveFlare =
            policyMode === 'heuristic' &&
            canUseFlare &&
            !lineOfSightBlocked &&
            flareCooldownReady &&
            !shouldSaveFlare &&
            fox2CmThreat &&
            !inboundFox1 &&
            (
                inboundFox2 ||
                (!maskUsable && missileThreatLikely && enemyCanLaunchSoon && distance <= (flareTriggerDistance + 6))
            );
        const closeRangeActualThreat = actualMissileThreat && distance <= (flareTriggerDistance + 12);
        const shouldFlareNow = (
            !lowAltitudeTacticalBan &&
            canUseFlare &&
            flareCooldownReady &&
            !lineOfSightBlocked &&
            !shouldSaveFlare &&
            fox2CmThreat &&
            !inboundFox1 &&
            (
                inboundFox2 ||
                (
                    missileThreatLikely &&
                    !maskUsable &&
                    (
                        closeRangeActualThreat ||
                        (threatLevel === 'high' && enemyCanLaunchSoon && distance <= flareTriggerDistance)
                    )
                )
            )
        ) || heuristicDefensiveFlare;
        const missileLock = distance >= missileLockMinDist && distance <= missileLockRange && angleToTarget <= missileLockAngle && !lineOfSightBlocked && localToEnemy.z > missileLockNoseDot;
        const baseHorizontalBias = this.clamp(-localToEnemy.x * 1.25, -1, 1);
        const baseVerticalBias = this.clamp(localToEnemy.y * 0.85, -0.65, 0.65);
        const lookaheadAllowed =
            !self.stalled &&
            (self.ap || 0) > (tuning.lowAp + 6) &&
            altitude > 26 &&
            coverInfo.collisionRisk === 'low' &&
            !loopEval.loopTrap;
        const lookaheadPlan = lookaheadAllowed
            ? this.planLookaheadIntercept(
                teamId,
                selfForward,
                localToEnemy,
                enemyLeadPos,
                sensor.seenNow,
                liveSelf,
                tuning
            )
            : {
                horizontalBias: baseHorizontalBias,
                verticalBias: baseVerticalBias,
                leadTurns: 0.8,
                profile: 'disabled',
                score: null,
                finalAngleDeg: null,
                finalDistance: null
            };
        const debugBase = {
            distance: Number(distance.toFixed(1)),
            angleDeg: Number((angleToTarget * 180 / Math.PI).toFixed(1)),
            closure: Number(closureSpeed.toFixed(3)),
            predictedSeparation: Number(predictedSeparation.toFixed(1)),
            headOn: Number(headOnFactor.toFixed(3)),
            override: overrideMode,
            missileThreat: missileThreatEvade ? 1 : 0,
            enemyAspectDeg: Number((enemyAspectToSelf * 180 / Math.PI).toFixed(1)),
            threatScore: Number(threatScore.toFixed(2)),
            threatLevel,
            losBlocked: lineOfSightBlocked ? 1 : 0,
            flareReserve: flareAmmoNow,
            flareCooldown: flareCooldownReady ? 0 : 1,
            actualMissileThreat: actualMissileThreat ? 1 : 0,
            closeRangeActualThreat: closeRangeActualThreat ? 1 : 0,
            inboundFox1: inboundFox1 ? 1 : 0,
            inboundFox2: inboundFox2 ? 1 : 0,
            underSarhPaint: underSarhPaintNow ? 1 : 0,
            shouldChaffNow: shouldChaffNow ? 1 : 0,
            shouldFlareNow: shouldFlareNow ? 1 : 0,
            chaffReserve: chaffAmmoNow,
            flareTriggerDistance,
            policyMode,
            missileLock: missileLock ? 1 : 0,
            missileLockRange,
            missileLockAngleDeg: Number((missileLockAngle * 180 / Math.PI).toFixed(1)),
            aiMissileType,
            threatMissileType: threatType,
            missileMinRange,
            missileMaxRange,
            targetLocalX: Number(localToEnemy.x.toFixed(2)),
            targetLocalY: Number(localToEnemy.y.toFixed(2)),
            targetLocalZ: Number(localToEnemy.z.toFixed(2)),
            coverDistance: Number((Number.isFinite(coverInfo.distance) ? coverInfo.distance : -1).toFixed(1)),
            coverForwardDistance: Number((Number.isFinite(coverInfo.forwardDistance) ? coverInfo.forwardDistance : -1).toFixed(1)),
            roofClearance: coverInfo.roofClearance == null ? null : Number(coverInfo.roofClearance),
            headroom: coverInfo.headroom == null ? null : Number(coverInfo.headroom),
            corridorClear: coverInfo.corridorClear ? 1 : 0,
            corridorGap: coverInfo.corridorGap == null ? null : Number(coverInfo.corridorGap),
            corridorLeft: coverInfo.corridorLeftClear == null ? null : Number(coverInfo.corridorLeftClear),
            corridorRight: coverInfo.corridorRightClear == null ? null : Number(coverInfo.corridorRightClear),
            riskProfile: coverInfo.riskProfile || tuning.buildingRiskProfile || 'gap',
            riskDowngrade: coverInfo.riskDowngrade == null ? 0 : Number(coverInfo.riskDowngrade),
            hardChoke: coverInfo.hardChoke ? 1 : 0,
            hardChokeSeverity: Number(coverInfo.hardChokeSeverity) || 0,
            hardChokeKind: coverInfo.hardChokeKind || null,
            collisionRisk: coverInfo.collisionRisk,
            coverMode: coverInfo.mode,
            maskScore: maskInfo.available ? maskInfo.score : -1,
            maskDistance: Number((Number.isFinite(maskInfo.distance) ? maskInfo.distance : -1).toFixed(1)),
            maskClearance: maskInfo.clearance || 0,
            maskTurnCost: maskInfo.turnCostDeg || 180,
            maskState: maskInfo.state,
            maskPathBlocked: maskInfo.pathBlocked ? 1 : 0,
            maskPoint: maskInfo.point ? {
                x: Number(maskInfo.point.x.toFixed(1)),
                y: Number(maskInfo.point.y.toFixed(1)),
                z: Number(maskInfo.point.z.toFixed(1))
            } : null,
            terrainSafeForMask: terrainSafeForMask ? 1 : 0,
            contact: sensor.hasContact ? 1 : 0,
            seenNow: sensor.seenNow ? 1 : 0,
            memoryContact: sensor.hasMemory && !sensor.seenNow ? 1 : 0,
            memoryTurnsLeft: sensor.memoryTurnsLeft,
            sensorDistance: sensor.distance,
            sensorAngleDeg: sensor.angleDeg,
            sensorLOS: sensor.losBlocked ? 1 : 0,
            sensorRadar: sensor.radarContact ? 1 : 0,
            sensorVisual: sensor.visualContact ? 1 : 0,
            passiveSearchBearing: passiveSearchBearing ? 1 : 0,
            passiveSearchRange,
            loopCount: loopEval.loopCount,
            loopTrap: loopEval.loopTrap ? 1 : 0,
            lookaheadEnabled: lookaheadAllowed ? 1 : 0,
            lookaheadLead: lookaheadPlan.leadTurns,
            lookaheadProfile: lookaheadPlan.profile,
            lookaheadScore: lookaheadPlan.score,
            lookaheadAngle: lookaheadPlan.finalAngleDeg ?? null,
            lookaheadDistance: lookaheadPlan.finalDistance ?? null,
            lowAltRecoverLock: lowAltRecoverLock.active ? 1 : 0,
            postGroundRecoveryLock: postGroundRecoveryLock.active ? 1 : 0,
            navClimbOut: 0,
            aiMapAvailable: aiMapCtx.available ? 1 : 0,
            aiMapSkyOpen: aiMapCtx.skyOpen ? 1 : 0,
            aiMapSarhPerch: aiMapCtx.sarhPerch ? 1 : 0,
            aiMapClearAbove: aiMapCtx.clearAbove ? 1 : 0,
            aiMapLocalRoof: aiMapCtx.available ? Number(Number(aiMapCtx.localRoofMax).toFixed(1)) : null,
            aiMapMargin: aiMapCtx.margin == null ? null : Number(Number(aiMapCtx.margin).toFixed(1))
        };
        const tree = [];
        tree.push(`sensorGate: contact=${sensor.hasContact} seenNow=${sensor.seenNow} mem=${sensor.memoryTurnsLeft} radar=${sensor.radarContact} visual=${sensor.visualContact} los=${sensor.losBlocked} passiveBearing=${passiveSearchBearing ? 1 : 0} passiveRange=${passiveSearchRange} radarR=${this.getSensorProfile(arenaMode).radarRange}`);
        tree.push(`aiMapGate: avail=${aiMapCtx.available ? 1 : 0} sky=${aiMapCtx.skyOpen ? 1 : 0} perch=${aiMapCtx.sarhPerch ? 1 : 0} clear=${aiMapCtx.clearAbove ? 1 : 0} roof=${aiMapCtx.available ? Number(aiMapCtx.localRoofMax).toFixed(1) : 'n/a'} margin=${aiMapCtx.margin == null ? 'n/a' : Number(aiMapCtx.margin).toFixed(1)}`);
        tree.push(`offenseAssist: vsHuman=${offenseAssist.vsHuman ? 1 : 0} pathLead=${offenseAssist.pathLeadCheat ? 1 : 0} deferLevel=${offenseAssist.deferLevelOut ? 1 : 0} gunMul=${offenseAssist.gunRangeMul.toFixed(2)}`);
        tree.push(`lookaheadGate: enabled=${lookaheadAllowed} lead=${lookaheadPlan.leadTurns} profile=${lookaheadPlan.profile} score=${lookaheadPlan.score ?? 'n/a'} angle=${lookaheadPlan.finalAngleDeg ?? '-'} dist=${lookaheadPlan.finalDistance ?? '-'}`);
        tree.push(`loopGate: trap=${loopEval.loopTrap} count=${loopEval.loopCount} dist=${distance.toFixed(1)} ang=${angleToTargetDeg.toFixed(1)} lx=${localToEnemy.x.toFixed(2)}`);
        tree.push(`lowAltLock: active=${lowAltRecoverLock.active} until=${lowAltRecoverLock.untilTurn}`);
        tree.push(`postGroundLock: active=${postGroundRecoveryLock.active} until=${postGroundRecoveryLock.untilTurn}`);
        tree.push(`recoverGate: ap=${Math.floor(self.ap)} stalled=${!!self.stalled} alt=${altitude.toFixed(1)}`);
        tree.push(`coverGate: dist=${debugBase.coverDistance} fwd=${debugBase.coverForwardDistance} roof=${debugBase.roofClearance == null ? 'n/a' : debugBase.roofClearance} headroom=${debugBase.headroom == null ? 'n/a' : debugBase.headroom} corridor=${debugBase.corridorClear || 0} gap=${debugBase.corridorGap == null ? 'n/a' : debugBase.corridorGap} L=${debugBase.corridorLeft == null ? 'n/a' : debugBase.corridorLeft} R=${debugBase.corridorRight == null ? 'n/a' : debugBase.corridorRight} risk=${coverInfo.collisionRisk} profile=${debugBase.riskProfile || 'gap'} down=${debugBase.riskDowngrade || 0} mode=${coverInfo.mode} choke=${debugBase.hardChoke || 0}:${debugBase.hardChokeSeverity || 0}:${debugBase.hardChokeKind || 'n/a'}`);
        tree.push(`maskGate: score=${debugBase.maskScore} dist=${debugBase.maskDistance} turn=${debugBase.maskTurnCost} blocked=${!!debugBase.maskPathBlocked} state=${debugBase.maskState}`);

        const plannedX = (lookaheadPlan && typeof lookaheadPlan.horizontalBias === 'number') ? lookaheadPlan.horizontalBias : baseHorizontalBias;
        const plannedY = (lookaheadPlan && typeof lookaheadPlan.verticalBias === 'number') ? lookaheadPlan.verticalBias : baseVerticalBias;
        const horizontalBias = this.clamp(
            lookaheadAllowed ? (plannedX * 0.75 + baseHorizontalBias * 0.25) : baseHorizontalBias,
            -1,
            1
        );
        const verticalBias = this.clamp(
            lookaheadAllowed ? (plannedY * 0.65 + baseVerticalBias * 0.35) : baseVerticalBias,
            -0.65,
            0.65
        );
        const roll = this.clamp(horizontalBias * 0.42, -Math.PI / 4, Math.PI / 4);
        const breakSide = ((typeof GameContext !== 'undefined' && GameContext.getFaction && GameContext.getFaction(teamId) === 'blue') || String(teamId).startsWith('blue')) ? -1 : 1;
        let hasArmedMissile = (self.pylons || []).some(p => p.state === 'armed');
        const hasStandbyMissile = (self.pylons || []).some(p => p.state === 'standby');
        const hasPoweringMissile = (self.pylons || []).some(p => p.state === 'powering');
        // powering counts — opening ambush leaves seekers mid-boot for one turn (H2).
        let hasAnyMissile = hasArmedMissile || hasStandbyMissile || hasPoweringMissile;
        const hasFox1Load = hasFox1LoadEarly;
        const hasFox2Load = hasFox2LoadEarly;
        // aiMissileType / ownEnv already resolved (Phase 0 typed envelope)
        // When powering, ask state-machine for matching munition type (mutex).
        const powerPylonsTyped = (want) => ({ powerPylons: true, missileType: want || aiMissileType });
        let rangeMode = this.updateWeaponRangeMode(teamId, distance, tuning, urbanArenaMode, coverInfo);
        // FORCE MISSILE: stay in missile mode while pylons remain so gun hysteresis cannot block FOX-2.
        if (overrideMode === 'missile' && hasAnyMissile) {
            rangeMode = 'missile';
            this.weaponRangeMemory[teamId] = 'missile';
        }
        // FOX2-FIRST ambush: one-turn power-up only (never skip to armed / same-turn launch unless QA instant-arm).
        if (
            policyMode === 'fox2-first' &&
            liveSelf && liveSelf.aiFox2OpeningAmbush &&
            hasAnyMissile &&
            !hasArmedMissile &&
            typeof GameContext !== 'undefined' &&
            GameContext.stateMachine &&
            typeof GameContext.stateMachine.beginFox2OpeningPowerUp === 'function'
        ) {
            GameContext.stateMachine.beginFox2OpeningPowerUp(teamId, 2);
            hasArmedMissile = (self.pylons || []).some(p => p.state === 'armed');
            hasAnyMissile = hasArmedMissile
                || (self.pylons || []).some(p => p.state === 'standby' || p.state === 'powering');
        }
        const energyCritical = self.stalled || self.ap < tuning.energyCriticalAp;
        const energyLow = self.ap < tuning.lowAp;
        const fox2OpeningAmbush = !!(liveSelf && liveSelf.aiFox2OpeningAmbush);
        const openingFox2RushRaw = this.wantsOpeningFox2Rush(policyMode, turnNo, hasAnyMissile, {
            actualMissileThreat,
            enemyMissileInFlight,
            urbanArenaMode,
            imminentIncoming:
                threatLevel === 'high' &&
                enemyAspectToSelf < (Math.PI / 5) &&
                distance < (flareTriggerDistance + 18),
            collisionHigh: coverInfo.collisionRisk === 'high' || this.isHardBuildingContact(coverInfo),
            imminentBuildingHit:
                this.isHardBuildingContact(coverInfo) ||
                (coverInfo.collisionRisk === 'high' &&
                    (coverInfo.forwardDistance < 12 || coverInfo.distance < 8)),
            hardGroundRisk:
                altitude < 14 ||
                (altitude < 20 && selfForward.y < -0.45) ||
                (altitude < 28 && selfForward.y < -0.55),
            energyCritical,
            stalled: !!self.stalled,
            altitude
        });
        // fox2-first: ambush roll (~20%) unlocks opening rush; otherwise keep missile bias only.
        const openingFox2Rush =
            policyMode === 'fox2-first'
                ? (openingFox2RushRaw && fox2OpeningAmbush)
                : openingFox2RushRaw;
        // fox2-first / fox1-first stay missile-biased; hybrid opening only forces missile while rushing in urban.
        if (openingFox2Rush || policyMode === 'fox2-first' || policyMode === 'fox1-first') {
            rangeMode = 'missile';
            this.weaponRangeMemory[teamId] = 'missile';
        }
        tree.push(`rangeMode: ${rangeMode} dist=${distance.toFixed(1)}`);
        tree.push(`envelope: type=${aiMissileType} min=${missileMinRange} max=${missileMaxRange} lock=${missileLockRange} threat=${threatType}`);
        tree.push(`openingFox2: rush=${openingFox2Rush ? 1 : 0} ambush=${fox2OpeningAmbush ? 1 : 0} policy=${policyMode}`);
        const steepClimb = selfForward.y > 0.42;
        const stallTrap = self.stalled && selfForward.y > tuning.stallPitchThreshold && altitude > tuning.minRecoverAlt;
        tree.push(`energyGate: critical=${energyCritical} low=${energyLow} steepClimb=${steepClimb} stallTrap=${stallTrap}`);

        // Hard ground risk only when altitude/dive actually threaten terrain.
        // Mild dive inside combat band (e.g. 51m / fwdY=-0.22) must NOT force groundAvoid.
        // T40: combat-band near-vertical (alt~52, fwdY=-0.78) still missed risk and kept fox2 align.
        const groundRisk =
            altitude < 18 ||
            (altitude < 28 && selfForward.y < -0.12) ||
            (altitude < 36 && selfForward.y < -0.14) ||
            (altitude < 40 && selfForward.y < -0.32) ||
            (altitude < 52 && selfForward.y < -0.55) ||
            (altitude < 58 && selfForward.y < -0.7);
        const shallowDiveLevel =
            !groundRisk &&
            altitude < 58 &&
            selfForward.y < -0.14 &&
            coverInfo.collisionRisk !== 'high';
        tree.push(`groundGate: alt=${altitude.toFixed(1)} fwdY=${selfForward.y.toFixed(2)} risk=${groundRisk} shallow=${shallowDiveLevel}`);
        const obstacleDirForAvoidance = coverInfo.direction || new THREE.Vector3(breakSide, 0, 0);
        const geometricAvoidSide = Math.sign(selfForward.clone().cross(obstacleDirForAvoidance).y || breakSide);
        const rawAvoidSide = this.chooseUrbanAvoidSide(teamId, {
            defaultSide: geometricAvoidSide,
            altitude
        });
        const urbanAvoidMemory = this.getUrbanAvoidMemory(teamId);
        const committedAvoidSide = (turnNo <= Number(urbanAvoidMemory.untilTurn || -1) && urbanAvoidMemory.side)
            ? Math.sign(urbanAvoidMemory.side)
            : 0;
        let urbanAvoidSide = committedAvoidSide || rawAvoidSide || breakSide;
        tree.push(`urbanAvoidMemory: side=${urbanAvoidSide} geom=${geometricAvoidSide} committed=${committedAvoidSide ? 1 : 0} until=${urbanAvoidMemory.untilTurn}`);

        const urbanObstacles = this.getObstacles();
        const denseUrban = this.isDenseUrbanContext(arenaMode, urbanObstacles);
        const altitudeLane = this.getUrbanAltitudeLane(altitude, coverInfo, tuning, {
            energyBad: energyLow || energyCritical,
            stalled: !!self.stalled,
            ap: self.ap,
            denseUrban
        });
        tree.push(
            `altitudeLane: lane=${altitudeLane.lane} roofExit=${altitudeLane.preferRoofExit ? 1 : 0} straightClimb=${altitudeLane.preferStraightClimb ? 1 : 0} sky=${altitudeLane.skyOpen ? 1 : 0} canyon<${altitudeLane.canyonMax} roof=${altitudeLane.roofEscape} embed=${altitudeLane.embedded ? 1 : 0} mandClimb=${altitudeLane.mandatoryClimb ? 1 : 0}`
        );

        if (altitudeLane.mandatoryClimb) {
            this.armNavClimbOut(teamId, {
                turnNo,
                holdTurns: 6,
                targetAlt: Math.max(Number(tuning.combatBandMin) || 35, altitudeLane.climbFloor + 16),
                side: urbanAvoidSide || breakSide,
                source: 'mandatoryClimb'
            });
            tree.push(`mandatoryClimb: floor=${altitudeLane.climbFloor} arm=1`);
        }

        const navClimbOut = this.syncNavClimbOut(teamId, {
            altitude,
            forwardY: selfForward.y,
            turnNo,
            side: urbanAvoidSide || breakSide,
            postGroundActive: postGroundRecoveryLock.active,
            coverInfo,
            altitudeLane,
            aiMapClearAbove: !!(aiMapCtx && aiMapCtx.clearAbove),
            aiMapSkyOpen: !!(aiMapCtx && aiMapCtx.skyOpen)
        });
        debugBase.navClimbOut = navClimbOut.active ? 1 : 0;
        debugBase.navClimbOutUntil = navClimbOut.untilTurn;
        debugBase.navClimbOutTarget = navClimbOut.targetAlt;
        tree.push(
            `navClimbOut: active=${navClimbOut.active ? 1 : 0} until=${navClimbOut.untilTurn} target=${navClimbOut.targetAlt} side=${navClimbOut.side || 0} src=${navClimbOut.source || 'n/a'} clear=${navClimbOut.clearanceOk ? 1 : 0} lane=${altitudeLane.lane}`
        );

        const urbanRouteCtx = {
            urbanArenaMode,
            arenaMode,
            denseUrban,
            coverInfo,
            maskInfo,
            altitude,
            energyLow,
            breakSide,
            preferredSide: urbanAvoidSide,
            policyMode,
            missileThreatLikely,
            missileThreatEvade,
            threatScore,
            actualMissileThreat,
            canUseFlare,
            flareCooldownReady,
            shouldSaveFlare,
            lineOfSightBlocked,
            mandatoryMergeBreak: false,
            lowAltitudeTacticalBan,
            turnNo,
            distance,
            predictedSeparation,
            angleDeg: angleToTargetDeg,
            altitudeLane,
            vsHuman: !!(offenseAssist && offenseAssist.vsHuman),
            aiMapClearAbove: !!(aiMapCtx && aiMapCtx.clearAbove),
            aiMapSkyOpen: !!(aiMapCtx && aiMapCtx.skyOpen),
            aiMapSarhPerch: !!(aiMapCtx && aiMapCtx.sarhPerch)
        };
        const closeCombatUrbanDefer = this.isCloseCombatUrbanDefer(urbanRouteCtx, tuning);
        const closeContactUrbanDefer = this.isHighAltCloseContactUrbanDefer(urbanRouteCtx, coverInfo, tuning);
        const hardBuildingContact = this.isHardBuildingContact(coverInfo);
        // Already inside / glued to mesh: lock committed side (T29: AABB rewrite each frame = thr4 snake).
        const coverDistNow = Number(coverInfo.distance);
        const roofClearNow = Number(coverInfo.roofClearance);
        const deepEmbedContact =
            hardBuildingContact &&
            Number.isFinite(coverDistNow) &&
            coverDistNow < 1.5;
        const meshGlueContact =
            hardBuildingContact &&
            (
                deepEmbedContact ||
                !!altitudeLane.embedded ||
                (Number.isFinite(coverDistNow) && coverDistNow < 2.2) ||
                (
                    Number.isFinite(roofClearNow) &&
                    roofClearNow < 0 &&
                    Number.isFinite(coverDistNow) &&
                    coverDistNow < 8
                )
            );
        let aabbEscapeSide = 0;
        if (typeof AirArenaUrbanAvoidSide !== 'undefined' && AirArenaUrbanAvoidSide.computeAabbEscapeSide) {
            aabbEscapeSide = AirArenaUrbanAvoidSide.computeAabbEscapeSide(coverInfo.direction, selfForward);
        } else if (coverInfo.direction) {
            aabbEscapeSide = Math.sign(
                coverInfo.direction.x * (-selfForward.z) + coverInfo.direction.z * selfForward.x
            ) || 0;
        }
        let embedFlip = 0;
        const earlyBuildingApproach = this.isEarlyBuildingApproach(coverInfo);
        const facadeClosingNow =
            this.isFacadeClosingScore(coverInfo) ||
            this.isSteepDiveIntoFacade(coverInfo, selfForward.y, altitude);
        const gapSideNow = this.getCorridorGapSide(coverInfo);
        const sideAuth = (typeof AirArenaUrbanAvoidSide !== 'undefined' &&
            AirArenaUrbanAvoidSide.resolveAvoidSideAuthority)
            ? AirArenaUrbanAvoidSide.resolveAvoidSideAuthority({
                aabbEscapeSide,
                committedAvoidSide,
                geometricAvoidSide,
                urbanAvoidSide,
                breakSide,
                gapSide: gapSideNow,
                coverDistance: coverDistNow,
                forwardDistance: coverInfo.forwardDistance,
                turnNo,
                lastFlipTurn: urbanAvoidMemory.lastFlipTurn,
                gluePushStreak: urbanAvoidMemory.gluePushStreak,
                memorySide: urbanAvoidMemory.side,
                hardBuildingContact,
                meshGlueContact,
                deepEmbedContact,
                earlyBuildingApproach,
                facadeClosingNow,
                embeddedLane: !!altitudeLane.embedded,
                collisionRisk: coverInfo.collisionRisk
            })
            : null;
        if (sideAuth && sideAuth.applyMemory) {
            this.updateUrbanAvoidMemory(
                teamId,
                sideAuth.side,
                turnNo,
                sideAuth.holdTurns,
                {
                    gluePushStreak: sideAuth.nextGlueStreak,
                    ...(sideAuth.embedFlip ? { lastFlipTurn: turnNo } : {})
                }
            );
            urbanAvoidSide = sideAuth.side;
            urbanRouteCtx.preferredSide = sideAuth.side;
            embedFlip = sideAuth.embedFlip || 0;
            if (sideAuth.treeNote) tree.push(sideAuth.treeNote);
        }
        aabbEscapeSide = (sideAuth && sideAuth.aabbEscapeSide) || aabbEscapeSide;
        if (
            embedFlip ||
            deepEmbedContact ||
            meshGlueContact ||
            earlyBuildingApproach ||
            (sideAuth && sideAuth.aabbShouldOwnSide)
        ) {
            const streakNow = Number((this.getUrbanAvoidMemory(teamId) || {}).gluePushStreak) || 0;
            tree.push(
                `embedEscape: deep=${deepEmbedContact ? 1 : 0} glue=${meshGlueContact ? 1 : 0} early=${earlyBuildingApproach ? 1 : 0} flip=${embedFlip} push=${streakNow} aabb=${aabbEscapeSide} side=${urbanAvoidSide} src=${(sideAuth && sideAuth.source) || 'legacy'} dist=${Number.isFinite(coverDistNow) ? coverDistNow.toFixed(1) : 'n/a'}`
            );
        }
        urbanRouteCtx.earlyBuildingApproach = earlyBuildingApproach;
        urbanRouteCtx.facadeClosingScore = this.isFacadeClosingScore(coverInfo);
        urbanRouteCtx.forwardY = selfForward.y;
        urbanRouteCtx.diveIntoFacade = this.isSteepDiveIntoFacade(coverInfo, selfForward.y, altitude);
        const midairParts = {
            distance,
            predictedSeparation,
            headOnFactor,
            closureSpeed,
            altitude,
            forwardY: selfForward.y,
            localToEnemy,
            breakSide: urbanAvoidSide || breakSide,
            teamId,
            heat: self.heat || 0,
            ap: self.ap,
            lowAp: tuning.lowAp
        };
        const imminentBuildingHit =
            hardBuildingContact ||
            earlyBuildingApproach ||
            (coverInfo.collisionRisk === 'high' &&
                (coverInfo.forwardDistance < 16 || coverInfo.distance < 12));
        // Hard-only building abort for fox2 perch (side clutter must not cancel rooftop climb).
        const strictImminentBuilding =
            hardBuildingContact ||
            coverInfo.distance < 7 ||
            (coverInfo.collisionRisk === 'high' &&
                Number.isFinite(coverInfo.forwardDistance) &&
                coverInfo.forwardDistance > 0 &&
                coverInfo.forwardDistance < 14);
        const fox2PerchWindow =
            policyMode === 'fox2-first' &&
            fox2OpeningAmbush &&
            turnNo <= 24 &&
            hasAnyMissile &&
            !actualMissileThreat &&
            !enemyMissileInFlight &&
            !strictImminentBuilding;
        tree.push(`urbanCombatGate: defer=${closeCombatUrbanDefer} closeContact=${closeContactUrbanDefer ? 1 : 0} imminentBldg=${imminentBuildingHit ? 1 : 0} strictBldg=${strictImminentBuilding ? 1 : 0} hardContact=${hardBuildingContact ? 1 : 0} perch=${fox2PerchWindow ? 1 : 0} dist=${distance.toFixed(1)} ang=${angleToTargetDeg.toFixed(1)}`);

        const imminentGroundImpact = altitude < 12 || (altitude < 26 && selfForward.y < -0.45);

        // H3 named priority pipeline (order owned by AirArenaDecidePipeline.MAIN_GATE_ORDER).
        const __pipelineAction = this.runDecidePipeline([
            ['obstacleEmergency', () => {
                        const emergencyHardLock = this.isObstacleEmergencyHardLock(coverInfo, {
                            altitude,
                            forwardY: selfForward.y
                        });
                        // Near-dirt steep dive: yield to groundEmergency.
                        // T70: once nose near level (fwdY>-0.55) do NOT defer — stay for mandatory climb lock.
                        if (
                            altitude < 12 &&
                            selfForward.y < -0.55 &&
                            (
                                (Number.isFinite(roofClearNow) && roofClearNow < 0) ||
                                (Number.isFinite(coverDistNow) && coverDistNow < 8) ||
                                hardBuildingContact ||
                                deepEmbedContact
                            )
                        ) {
                            tree.push(
                                `obstacleEmergency: deferred=nearDirtDive alt=${altitude.toFixed(1)} fwdY=${selfForward.y.toFixed(2)}`
                            );
                            return null;
                        }
                        // Knife midair beats pure urban side thrash unless already mesh-glued / hard-locked.
                        const midairOverUrban = this.tryCloseMidairBreak(midairParts, coverInfo, tree, 'midairOverUrban');
                        if (
                            midairOverUrban &&
                            !deepEmbedContact &&
                            !(Number.isFinite(coverDistNow) && coverDistNow < 2) &&
                            !emergencyHardLock &&
                            this.canYieldToMidairBreak(coverInfo, altitude, selfForward.y)
                        ) {
                            return this.withDebug(
                                midairOverUrban,
                                debugBase,
                                [...tree, `selected: ${midairOverUrban.state}-overUrban dist=${distance.toFixed(1)}`],
                                midairOverUrban.state
                            );
                        }
                        // Hard contact / high risk / tight medium: urban lateral escape before terrain climb thrash.
                        // FOX2-FIRST opening perch: only hard building hits may cancel the climb-out.
                        // T64 hardLock: roof<0 or coverDist<8 always owns this gate (blocks fox2Opening).
                        const highAltSoft = altitude >= Math.max(Number(tuning.combatBandMin || 35) + 10, 48);
                        // Soft: aiMap clearAbove — skip mediumTight soft-escape (beside-tall AABB), keep hard contact.
                        const aiMapSoftClear = !!(aiMapCtx.clearAbove || aiMapCtx.skyOpen);
                        const mediumTight =
                            !aiMapSoftClear &&
                            coverInfo.collisionRisk === 'medium' &&
                            (
                                Number(coverInfo.distance) < (highAltSoft ? 8 : 10) ||
                                (Number.isFinite(Number(coverInfo.forwardDistance)) &&
                                    Number(coverInfo.forwardDistance) > 0 &&
                                    Number(coverInfo.forwardDistance) < (highAltSoft ? 9 : 14))
                            );
                        // Conservative earlier approach: still have clearance, not glued (no joyX thrash).
                        const earlyHardApproach =
                            hardBuildingContact ||
                            earlyBuildingApproach ||
                            (
                                coverInfo.collisionRisk === 'high' &&
                                Number.isFinite(Number(coverInfo.distance)) &&
                                Number(coverInfo.distance) < 14
                            ) ||
                            (
                                Number.isFinite(Number(coverInfo.forwardDistance)) &&
                                Number(coverInfo.forwardDistance) > 2 &&
                                Number(coverInfo.forwardDistance) < 18 &&
                                coverInfo.collisionRisk !== 'low'
                            );
                        if (
                            (emergencyHardLock && urbanArenaMode) ||
                            (
                                (!imminentGroundImpact || hardBuildingContact || deepEmbedContact) &&
                                urbanArenaMode &&
                                !(fox2PerchWindow || (openingFox2Rush && !hardBuildingContact && !strictImminentBuilding)) &&
                                (
                                    earlyHardApproach ||
                                    strictImminentBuilding ||
                                    (coverInfo.collisionRisk === 'high' && (altitude < 48 || denseUrban || Number(coverInfo.distance) < 16 || Number(coverInfo.forwardDistance) < 18)) ||
                                    (mediumTight && (denseUrban || altitude < 48)) ||
                                    (obstacleStressMode && coverInfo.collisionRisk === 'medium' && altitude < 34 && !aiMapSoftClear)
                                )
                            )
                        ) {
                            // T150: once climbing clear of mesh pressure, yield to engagement/opening.
                            if (
                                !emergencyHardLock &&
                                this.shouldHandoffEscapeToEngage(coverInfo, {
                                    altitude,
                                    forwardY: selfForward.y,
                                    hardContact: hardBuildingContact,
                                    aiMapClearAbove: aiMapCtx.clearAbove,
                                    aiMapSkyOpen: aiMapCtx.skyOpen
                                })
                            ) {
                                tree.push(
                                    `obstacleEmergency: deferred=engageHandoff risk=${coverInfo.collisionRisk || 'n/a'} dist=${Number.isFinite(Number(coverInfo.distance)) ? Number(coverInfo.distance).toFixed(1) : 'n/a'} fwdY=${selfForward.y.toFixed(2)}`
                                );
                                return null;
                            }
                            if (emergencyHardLock) {
                                tree.push(
                                    `obstacleEmergency: hardLock=1 roof=${Number.isFinite(roofClearNow) ? roofClearNow.toFixed(1) : 'n/a'} dist=${Number.isFinite(coverDistNow) ? coverDistNow.toFixed(1) : 'n/a'}`
                                );
                            }
                            if (earlyBuildingApproach) {
                                tree.push(`earlyBuildingApproach: fwd=${Number.isFinite(Number(coverInfo.forwardDistance)) ? Number(coverInfo.forwardDistance).toFixed(1) : 'n/a'} dist=${Number.isFinite(Number(coverInfo.distance)) ? Number(coverInfo.distance).toFixed(1) : 'n/a'}`);
                            }
                            // T35/T70: once inside urban emergency, climb below floor beats glue/lateral thrash.
                            // After dive-level (fwdY>-0.55) lock climb — do not re-enter flat bank spiral.
                            {
                                const roofClearMand = Number(coverInfo.roofClearance);
                                const underRoofMand =
                                    (Number.isFinite(roofClearMand) && roofClearMand < 2) ||
                                    !!altitudeLane.underRoof;
                                const climbFloorNow = this.getMandatoryClimbAlt(tuning);
                                const gapOpenForRoute =
                                    !underRoofMand &&
                                    (
                                        !!coverInfo.corridorClear ||
                                        this.getCorridorGapTier(coverInfo).tier === 'wide' ||
                                        this.getCorridorGapTier(coverInfo).tier === 'ok'
                                    );
                                const wantMandClimb =
                                    altitude < climbFloorNow &&
                                    !underRoofMand &&
                                    selfForward.y > -0.55 &&
                                    !(selfForward.y > 0.35 && hardBuildingContact) &&
                                    // Prefer corridor planner over forced climb when a gap is flyable.
                                    !gapOpenForRoute;
                                if (wantMandClimb) {
                                    const climbSide = navClimbOut.side || urbanAvoidSide || breakSide || 0;
                                    const climbTarget = Math.max(
                                        Number(navClimbOut.targetAlt) || 0,
                                        Number(tuning.combatBandMin) || 35,
                                        climbFloorNow + 8
                                    );
                                    this.armNavClimbOut(teamId, {
                                        turnNo,
                                        side: climbSide,
                                        targetAlt: climbTarget,
                                        holdTurns: 8,
                                        source: 'mandatoryClimb'
                                    });
                                    return this.withDebug(
                                        this.buildNavClimbOutAction({
                                            altitude,
                                            forwardY: selfForward.y,
                                            heat: self.heat || 0,
                                            side: climbSide,
                                            targetAlt: climbTarget,
                                            maxPitchCmd,
                                            source: 'mandatoryClimb',
                                            coverInfo
                                        }),
                                        debugBase,
                                        [...tree, `selected: postGroundClimbOut-mandatoryOverObstacle alt=${altitude.toFixed(1)}`],
                                        'postGroundClimbOut'
                                    );
                                }
                            }
                            // Soft medium at combat/rooftop + close enemy → merge/gun, not mutual urban weave (T48).
                            // Never defer when hard-locked under roof / near mesh.
                            if (
                                closeContactUrbanDefer &&
                                !emergencyHardLock &&
                                !hardBuildingContact &&
                                !strictImminentBuilding &&
                                coverInfo.collisionRisk !== 'high'
                            ) {
                                tree.push('urbanRouteGate: deferred=closeContact');
                                return null;
                            }
                            this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 5);
                            const underRoofNow = this.isTrueUnderRoof(coverInfo, {
                                hardContact: hardBuildingContact
                            });
                            // Extreme-low / near-dirt dive: groundEmergency owns composite dirt+lateral stick.
                            // T66/T53: hardLock embed low-climb at alt≈1–5 still hit dirt after partial pull-up.
                            if (
                                (altitude < 8 && (hardBuildingContact || deepEmbedContact || emergencyHardLock)) ||
                                (altitude < 12 && selfForward.y < -0.25 && emergencyHardLock)
                            ) {
                                tree.push(
                                    `obstacleEmergency: deferred=groundDirtComposite alt=${altitude.toFixed(1)} fwdY=${selfForward.y.toFixed(2)} hardLock=${emergencyHardLock ? 1 : 0}`
                                );
                                return null;
                            }
                            const steepFaceDiveEarly =
                                hardBuildingContact &&
                                selfForward.y < -0.55 &&
                                altitude >= 16 &&
                                altitude < 50 &&
                                !(Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 0);
                            const diveIntoFacade = !!urbanRouteCtx.diveIntoFacade ||
                                this.isSteepDiveIntoFacade(coverInfo, selfForward.y, altitude);
                            const divingEarly =
                                diveIntoFacade ||
                                (
                                    selfForward.y < -0.35 &&
                                    altitude < 48 &&
                                    (steepFaceDiveEarly || (!underRoofNow && selfForward.y < -0.55))
                                );
                            const gapOpenPrefer = this.isFlyableCorridorGap(coverInfo, { underRoof: underRoofNow });
                            const routedEmergency = this.pickUrbanRoute(teamId, urbanRouteCtx, debugBase, tree);
                            // Hard dive owns sticks unless a flyable gap says prefer planner (T50).
                            const forceHardDive =
                                (diveIntoFacade || steepFaceDiveEarly) &&
                                !(gapOpenPrefer && altitude >= 20 && !(altitude < 16 && selfForward.y < -0.75));
                            const plannerEmbed =
                                !!routedEmergency &&
                                (
                                    routedEmergency.state === 'urbanEmbedPushOut' ||
                                    String(routedEmergency.reason || '').indexOf('embed') >= 0 ||
                                    String(routedEmergency.statusText || '').indexOf('嵌樓') >= 0
                                );
                            const plannerGap =
                                !!routedEmergency &&
                                gapOpenPrefer &&
                                (
                                    routedEmergency.state === 'urbanBuildingWeave' ||
                                    routedEmergency.state === 'urbanRouteEscape' ||
                                    routedEmergency.state === 'urbanPreemptiveAvoid' ||
                                    routedEmergency.state === 'urbanClimbingTurn' ||
                                    routedEmergency.state === 'urbanRouteClimbOut' ||
                                    String(routedEmergency.reason || '').indexOf('corridor') >= 0 ||
                                    String(routedEmergency.reason || '').indexOf('gap-hold') >= 0 ||
                                    String(routedEmergency.reason || '').indexOf('planner') >= 0 ||
                                    String(routedEmergency.statusText || '').indexOf('縫道') >= 0 ||
                                    String(routedEmergency.statusText || '').indexOf('城市規劃') >= 0 ||
                                    (
                                        routedEmergency.urbanRoute &&
                                        (routedEmergency.urbanRoute.gapTier === 'wide' ||
                                            routedEmergency.urbanRoute.gapTier === 'ok')
                                    )
                                );
                            // Gap open OR beside-taller-AABB (not true undercroft): prefer planner over T38.
                            const roofBesidePressure =
                                !underRoofNow &&
                                Number.isFinite(Number(coverInfo.roofClearance)) &&
                                Number(coverInfo.roofClearance) < 0;
                            if (
                                routedEmergency &&
                                !forceHardDive &&
                                (plannerEmbed || plannerGap || gapOpenPrefer || roofBesidePressure || !divingEarly)
                            ) {
                                // T38: weak urbanRouteEscape under glued roof — fall through to hard lateral stick.
                                const glueDist = Number(coverInfo.distance);
                                const gluedRoof =
                                    underRoofNow &&
                                    (
                                        (Number.isFinite(glueDist) && glueDist < 4) ||
                                        (Number.isFinite(Number(coverInfo.roofClearance)) &&
                                            Number(coverInfo.roofClearance) < 0)
                                    );
                                if (gluedRoof && !plannerEmbed && !gapOpenPrefer) {
                                    tree.push('urbanRouteGate: deferred=underRoofGlue');
                                } else {
                                if (roofBesidePressure && !gapOpenPrefer) {
                                    tree.push(
                                        `urbanRouteGate: prefer=roofBesideOverHardStick roof=${coverInfo.roofClearance} dist=${coverInfo.distance == null ? 'n/a' : coverInfo.distance}`
                                    );
                                }
                                if (gapOpenPrefer) {
                                    const gapTier = this.getCorridorGapTier(coverInfo);
                                    tree.push(
                                        `urbanRouteGate: prefer=gapOpenOverHardDive tier=${gapTier.tier} gap=${coverInfo.corridorGap == null ? 'n/a' : coverInfo.corridorGap}`
                                    );
                                    // Keep climb floor so planner path does not flatten into mesh.
                                    const minY = selfForward.y < -0.45
                                        ? 0.48
                                        : (selfForward.y < -0.2 ? 0.32 : 0.14);
                                    if (Number(routedEmergency.joyY) < minY) routedEmergency.joyY = minY;
                                    const gapSide = this.getCorridorGapSide(coverInfo);
                                    if (gapSide) {
                                        const cur = Math.sign(Number(routedEmergency.joyX) || 0);
                                        if (cur !== gapSide) {
                                            routedEmergency.joyX = this.clamp(
                                                gapSide * Math.max(0.34, Math.abs(Number(routedEmergency.joyX) || 0.34)),
                                                -0.55,
                                                0.55
                                            );
                                        }
                                    }
                                } else if (plannerGap) {
                                    tree.push(
                                        `urbanRouteGate: prefer=corridorGap tier=${this.getCorridorGapTier(coverInfo).tier} gap=${coverInfo.corridorGap == null ? 'n/a' : coverInfo.corridorGap}`
                                    );
                                }
                                const noseDown = selfForward.y < -0.35;
                                if ((hardBuildingContact || underRoofNow) && !gapOpenPrefer) {
                                    const maxY = plannerEmbed || routedEmergency.diveLevelPull || noseDown
                                        ? (underRoofNow
                                            ? (noseDown ? 0.42 : 0.12)
                                            : (noseDown ? 0.48 : 0.22))
                                        : (underRoofNow ? 0.06 : 0.18);
                                    if (Number(routedEmergency.joyY) > maxY) {
                                        routedEmergency.joyY = underRoofNow && !(plannerEmbed || noseDown)
                                            ? 0.04
                                            : maxY;
                                    }
                                    if (gluedRoof || plannerEmbed) {
                                        const push = Math.sign(Number(routedEmergency.joyX) || urbanAvoidSide) || 1;
                                        const need = gluedRoof ? 0.52 : 0.42;
                                        if (Math.abs(Number(routedEmergency.joyX) || 0) < need) {
                                            routedEmergency.joyX = this.clamp(push * need, -0.62, 0.62);
                                        }
                                    }
                                }
                                if (hardBuildingContact && selfForward.y > 0.35 && Number(routedEmergency.joyY) > 0.08 && !gapOpenPrefer) {
                                    routedEmergency.joyY = 0.02;
                                }
                                return routedEmergency;
                                }
                            }
                            if (routedEmergency && (forceHardDive || divingEarly)) {
                                tree.push(
                                    gapOpenPrefer
                                        ? 'urbanRouteGate: deferred=diveDespiteGap'
                                        : (diveIntoFacade ? 'urbanRouteGate: deferred=diveIntoFacade' : 'urbanRouteGate: deferred=divePull')
                                );
                            }
                            const tightEscape = hardBuildingContact || coverInfo.distance < 6 || coverInfo.forwardDistance < 10;
                            const lowAltitudeEscape = altitude < 22;
                            const lowEnergyEscape = self.ap < tuning.lowAp + 4 && !lowAltitudeEscape;
                            const roofEscape = Math.min(Number(tuning.combatBandMax) || 92, 80);
                            const climbTowardRoof = !hardBuildingContact && !underRoofNow && altitude < roofEscape - 10;
                            const steepIntoBldg = hardBuildingContact && selfForward.y > 0.35;
                            const roofExitNow = (altitudeLane.preferRoofExit || altitudeLane.mandatoryClimb) && !steepIntoBldg && !underRoofNow && !diveIntoFacade;
                            const mandClimbNow = !!altitudeLane.mandatoryClimb && !steepIntoBldg && !underRoofNow;
                            const embedNow =
                                underRoofNow ||
                                altitudeLane.embedded ||
                                (hardBuildingContact && Number(coverInfo.distance) < 3);
                            const deepEmbed =
                                embedNow &&
                                Number.isFinite(Number(coverInfo.distance)) &&
                                Number(coverInfo.distance) < 1.5;
                            // Mid-alt steep face-dive: pull level even when "embedded" if not deep under slab (T26 red).
                            const steepFaceDive =
                                hardBuildingContact &&
                                selfForward.y < -0.55 &&
                                altitude >= 16 &&
                                altitude < 50 &&
                                !(Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 0);
                            // Under slab / deep embed: never open-sky climb; steep nose may still level first (T41).
                            const divingAtBldg =
                                diveIntoFacade ||
                                (
                                    selfForward.y < -0.35 &&
                                    altitude < 48 &&
                                    (
                                        steepFaceDive ||
                                        selfForward.y < -0.55 ||
                                        (
                                            !underRoofNow &&
                                            (
                                                !embedNow ||
                                                (Number.isFinite(Number(coverInfo.distance)) &&
                                                    Number(coverInfo.distance) >= 1.2 &&
                                                    selfForward.y < -0.55)
                                            )
                                        )
                                    )
                                );
                            const flareWhileEscape =
                                actualMissileThreat &&
                                canUseFlare &&
                                flareCooldownReady &&
                                !shouldSaveFlare &&
                                !lineOfSightBlocked &&
                                altitude >= 14;
                            // Prefer short-horizon scored ±side/climb/level over fixed T38 (少強制、優選路).
                            const diveOwnsForScore =
                                (diveIntoFacade || steepFaceDiveEarly) &&
                                !(gapOpenPrefer && altitude >= 20);
                            const scoredEsc = (!forceHardDive || roofBesidePressure)
                                ? this.pickScoredUrbanEscapeStick(teamId, {
                                    side: urbanAvoidSide,
                                    altitude,
                                    forwardY: selfForward.y,
                                    coverDistance: coverInfo.distance,
                                    roofClearance: coverInfo.roofClearance,
                                    headroom: coverInfo.headroom,
                                    hardContact: hardBuildingContact,
                                    deepEmbed,
                                    trueUnderRoof: underRoofNow,
                                    diveOwnsStick: diveOwnsForScore,
                                    energyCritical,
                                    lowEnergyEscape,
                                    heat: self.heat || 0,
                                    coverLabel: `${debugBase.coverDistance}m`,
                                    coverInfo
                                })
                                : null;
                            if (scoredEsc) {
                                tree.push(
                                    `urbanEscapeScore: branch=${scoredEsc.branch} score=${scoredEsc.score} mode=${scoredEsc.mode}`
                                );
                                return this.withDebug({
                                    state: flareWhileEscape
                                        ? 'defensiveFlare'
                                        : 'obstacleEmergencyEscape',
                                    statusText: flareWhileEscape
                                        ? `NPC: 避撞熱焰 ${debugBase.coverDistance}m`
                                        : scoredEsc.statusText,
                                    throttle: scoredEsc.throttle,
                                    joyX: scoredEsc.joyX,
                                    joyY: scoredEsc.joyY,
                                    pitchCmd: -maxPitchCmd * (scoredEsc.pitchScale || 0.28),
                                    roll: this.clamp(
                                        scoredEsc.joyX * (scoredEsc.rollAuth || Math.PI / 10),
                                        -(scoredEsc.rollAuth || Math.PI / 10),
                                        scoredEsc.rollAuth || Math.PI / 10
                                    ),
                                    weapon: 'gun',
                                    queueAction: flareWhileEscape ? 'flare' : 'none',
                                    ready: true,
                                    diveLevelPull: !!scoredEsc.diveLevelPull,
                                    dirtPullFloor: !!scoredEsc.dirtPullFloor,
                                    reason: flareWhileEscape
                                        ? 'Actual missile threat: flare while obstacle-escaping'
                                        : scoredEsc.reason
                                }, debugBase, [...tree, `selected: ${flareWhileEscape ? 'defensiveFlare-obstacleEscape' : `obstacleEmergencyEscape-${scoredEsc.mode}`} hardContact=${hardBuildingContact ? 1 : 0} embed=${embedNow ? 1 : 0} joyX=${Number(scoredEsc.joyX).toFixed(2)} thr=${scoredEsc.throttle}`], flareWhileEscape ? 'defensiveFlare' : 'obstacleEmergencyEscape');
                            }
                            const escStick = this.resolveUrbanHardEscapeStick({
                                side: urbanAvoidSide,
                                roofClearance: coverInfo.roofClearance,
                                headroom: coverInfo.headroom,
                                coverDistance: coverInfo.distance,
                                collisionRisk: coverInfo.collisionRisk,
                                altitude,
                                forwardY: selfForward.y,
                                embedNow,
                                deepEmbed,
                                underRoof: underRoofNow,
                                diveIntoFacade,
                                divingAtBldg,
                                steepFaceDive,
                                steepIntoBldg,
                                hardContact: hardBuildingContact,
                                roofExitNow,
                                mandatoryClimb: mandClimbNow,
                                climbJoyY: altitudeLane.climbJoyY,
                                tightEscape,
                                lowAltitudeEscape,
                                lowEnergyEscape,
                                climbTowardRoof,
                                energyCritical,
                                heat: self.heat || 0,
                                flareWhileEscape,
                                coverLabel: `${debugBase.coverDistance}m`,
                                gapOpen: gapOpenPrefer,
                                corridorClear: coverInfo.corridorClear,
                                corridorGap: coverInfo.corridorGap,
                                corridorLeftClear: coverInfo.corridorLeftClear,
                                corridorRightClear: coverInfo.corridorRightClear
                            });
                            return this.withDebug({
                                state: flareWhileEscape
                                    ? 'defensiveFlare'
                                    : (escStick.mode === 'energyClimb' || lowEnergyEscape
                                        ? 'obstacleEnergyClimb'
                                        : 'obstacleEmergencyEscape'),
                                statusText: flareWhileEscape
                                    ? `NPC: 避撞熱焰 ${debugBase.coverDistance}m`
                                    : escStick.statusText,
                                throttle: escStick.throttle,
                                joyX: escStick.joyX,
                                joyY: escStick.joyY,
                                pitchCmd: -maxPitchCmd * escStick.pitchScale,
                                roll: this.clamp(urbanAvoidSide * escStick.rollAuth, -Math.PI / 6, Math.PI / 6),
                                weapon: 'gun',
                                queueAction: flareWhileEscape ? 'flare' : 'none',
                                ready: true,
                                diveLevelPull: !!escStick.diveLevelPull,
                                dirtPullFloor: !!escStick.dirtPullFloor,
                                reason: flareWhileEscape
                                    ? 'Actual missile threat: flare while obstacle-escaping'
                                    : escStick.reason
                            }, debugBase, [...tree, `selected: ${flareWhileEscape ? 'defensiveFlare-obstacleEscape' : `obstacleEmergencyEscape-${escStick.mode}`} hardContact=${hardBuildingContact ? 1 : 0} embed=${embedNow ? 1 : 0} flip=${embedFlip} joyX=${Number(escStick.joyX).toFixed(2)} thr=${escStick.throttle}`], flareWhileEscape ? 'defensiveFlare' : 'obstacleEmergencyEscape');
                        }
                return null;
            }],
            ['groundEmergency', () => {
                const climbFloorGE = this.getMandatoryClimbAlt(tuning);
                const underRoofGE =
                    (Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 2) ||
                    !!altitudeLane.underRoof;
                // T70: after dive-level / below canyon floor — lock climb before dirt-lateral thrash.
                if (
                    altitude < climbFloorGE &&
                    !underRoofGE &&
                    selfForward.y > -0.55 &&
                    !(selfForward.y > 0.35 && hardBuildingContact) &&
                    (
                        !!altitudeLane.mandatoryClimb ||
                        !!navClimbOut.active ||
                        altitude < 14 ||
                        (altitude < 20 && selfForward.y < -0.05)
                    )
                ) {
                    const climbSide = navClimbOut.side || urbanAvoidSide || breakSide || 0;
                    const climbTarget = Math.max(
                        Number(navClimbOut.targetAlt) || 0,
                        Number(tuning.combatBandMin) || 35,
                        climbFloorGE + 8
                    );
                    this.armNavClimbOut(teamId, {
                        turnNo,
                        side: climbSide,
                        targetAlt: climbTarget,
                        holdTurns: 8,
                        source: 'mandatoryClimb'
                    });
                    return this.withDebug(
                        this.buildNavClimbOutAction({
                            altitude,
                            forwardY: selfForward.y,
                            heat: self.heat || 0,
                            side: climbSide,
                            targetAlt: climbTarget,
                            maxPitchCmd,
                            source: 'mandatoryClimb',
                            coverInfo
                        }),
                        debugBase,
                        [...tree, `selected: postGroundClimbOut-mandatoryAfterDiveLevel alt=${altitude.toFixed(1)} fwdY=${selfForward.y.toFixed(2)}`],
                        'postGroundClimbOut'
                    );
                }
                if (altitude < climbFloorGE || (altitude < 48 && selfForward.y < -0.18)) {
                            const extremeLow = altitude < 8;
                            const steepDive = selfForward.y < -0.45;
                            // T92: mid-alt moderate dive (fwdY≈-0.28 @40m) was not steepDive → joyY=0.38 bleed.
                            const moderateDive = !steepDive && selfForward.y < -0.22;
                            const hardGroundAbort = altitude < 14 || (altitude < climbFloorGE && selfForward.y < -0.5);
                            const noseHigh = selfForward.y > 0.22;
                            const stalledNow = !!self.stalled || energyCritical;
                            const mandClimbLow = (!!altitudeLane.mandatoryClimb || altitude < climbFloorGE) && !noseHigh && !underRoofGE;
                            const urbanEnvelope =
                                urbanArenaMode &&
                                (hardBuildingContact ||
                                    (Number.isFinite(Number(coverInfo.roofClearance)) &&
                                        Number(coverInfo.roofClearance) < 0 &&
                                        Number(coverInfo.distance) < 16) ||
                                    coverInfo.collisionRisk === 'high');
                            const embedOrHardLow =
                                hardBuildingContact ||
                                !!altitudeLane.embedded ||
                                (Number.isFinite(Number(coverInfo.distance)) && Number(coverInfo.distance) < 3) ||
                                (Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 2);
                            // Urban building envelope at low alt: around-building first, not vertical thrash.
                            // T27/T31: steep dive in canyon must pull FIRST — lateral thrash while fwdY≪0 digs into dirt/mesh.
                            // T32: extremeLow used to skip urban path → joyY≈0.82 into mesh while cover≈0.7.
                            // T25: mandatoryClimb overrides lateral-only when sky is open.
                            const canyonDiveAbort =
                                (steepDive || (moderateDive && altitude < 40)) &&
                                altitude < 42 &&
                                altitude >= 10 &&
                                !noseHigh &&
                                !embedOrHardLow;
                            if (urbanEnvelope && (!extremeLow || embedOrHardLow) && !canyonDiveAbort) {
                                this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 5);
                                const roofExitLow = (altitudeLane.preferRoofExit || mandClimbLow) && !noseHigh && (!embedOrHardLow || mandClimbLow);
                                const routedLow = this.pickUrbanRoute(teamId, {
                                    ...urbanRouteCtx,
                                    energyLow: energyLow || energyCritical || (!roofExitLow && (stalledNow || altitude < 22))
                                }, debugBase, tree);
                                if (routedLow) {
                                    if (noseHigh && embedOrHardLow && !mandClimbLow) {
                                        // Unload into mesh exit — do not soft-cap to climb band.
                                        routedLow.joyY = Math.min(Number(routedLow.joyY) || 0, -0.18);
                                    } else if (noseHigh && Number(routedLow.joyY) > 0.18) {
                                        routedLow.joyY = 0.1;
                                    }
                                    if (embedOrHardLow && steepDive && !noseHigh) {
                                        // T41: steep nose under embed — do not crush pull; soft bank.
                                        const minPull = altitude < 16 ? 0.78 : 0.62;
                                        if (Number(routedLow.joyY) < minPull) routedLow.joyY = minPull;
                                        routedLow.joyX = this.clamp(
                                            (Math.sign(Number(routedLow.joyX) || urbanAvoidSide) || 1) * 0.26,
                                            -0.3,
                                            0.3
                                        );
                                        routedLow.diveLevelPull = true;
                                        if (altitude < 8) routedLow.dirtPullFloor = true;
                                        if ((routedLow.throttle || 0) >= 5) routedLow.throttle = 4;
                                    // Soft-cap climb into slab — but never when extreme-low and still diving (T51 dirt death).
                                    } else if (embedOrHardLow && !mandClimbLow) {
                                        const extremeDirtDive = altitude < 8 && !noseHigh && selfForward.y < -0.05;
                                        if (extremeDirtDive) {
                                            const minPull = altitude < 3 ? 0.92 : (altitude < 5 ? 0.88 : 0.82);
                                            if (Number(routedLow.joyY) < minPull) routedLow.joyY = minPull;
                                            routedLow.joyX = this.clamp(
                                                (Math.sign(Number(routedLow.joyX) || urbanAvoidSide) || 1) * 0.28,
                                                -0.32,
                                                0.32
                                            );
                                            routedLow.diveLevelPull = true;
                                            routedLow.dirtPullFloor = true;
                                            if ((routedLow.throttle || 0) >= 5) routedLow.throttle = 4;
                                        } else {
                                        const maxRouteY = altitude < 3
                                            ? (steepDive ? 0.78 : 0.62)
                                            : (altitude < 8
                                                ? (steepDive ? 0.62 : 0.52)
                                                : (altitude < 12 ? (steepDive ? 0.48 : 0.32) : 0.16));
                                        if (!noseHigh && Number(routedLow.joyY) > maxRouteY) routedLow.joyY = maxRouteY;
                                        if (altitude < 4 && !noseHigh && Number(routedLow.joyY) < (steepDive ? 0.62 : 0.5)) {
                                            routedLow.joyY = steepDive ? 0.62 : 0.5;
                                        }
                                        if (altitude < 5) routedLow.dirtPullFloor = true;
                                        const absX = Math.abs(Number(routedLow.joyX) || 0);
                                        const side = Math.sign(Number(routedLow.joyX) || urbanAvoidSide) || urbanAvoidSide || 1;
                                        const pullCap = (steepDive || extremeLow || altitude < 12) ? 0.35 : 0.52;
                                        const pullAuth = (steepDive || extremeLow || altitude < 12) ? 0.32 : 0.48;
                                        if (absX < 0.22 || absX > pullCap) {
                                            routedLow.joyX = this.clamp(side * pullAuth, -pullCap, pullCap);
                                        }
                                        if ((routedLow.throttle || 0) >= 5) routedLow.throttle = 4;
                                        }
                                    } else if (mandClimbLow) {
                                        const minClimb = this.getMandatoryClimbJoyY(altitude, selfForward.y);
                                        if (Number(routedLow.joyY) < minClimb) routedLow.joyY = minClimb;
                                        routedLow.joyX = this.clamp(
                                            (Math.sign(Number(routedLow.joyX) || urbanAvoidSide) || 1) * 0.3,
                                            -0.36,
                                            0.36
                                        );
                                        if ((routedLow.throttle || 0) >= 5) routedLow.throttle = 4;
                                    }
                                    return routedLow;
                                }
                                const dirtBank = steepDive || extremeLow || altitude < 12;
                                const lowJoyX = (roofExitLow || mandClimbLow)
                                    ? this.clamp(urbanAvoidSide * (dirtBank ? 0.28 : 0.32), -0.38, 0.38)
                                    : this.clamp(
                                        urbanAvoidSide * (embedOrHardLow
                                            ? (steepDive ? 0.26 : (dirtBank ? 0.32 : 0.48))
                                            : (dirtBank ? 0.32 : 0.55)),
                                        steepDive ? -0.3 : (dirtBank ? -0.35 : (embedOrHardLow ? -0.52 : -0.7)),
                                        steepDive ? 0.3 : (dirtBank ? 0.35 : (embedOrHardLow ? 0.52 : 0.7))
                                    );
                                let lowJoyY = (roofExitLow || mandClimbLow)
                                    ? Math.max(
                                        altitudeLane.climbJoyY || 0,
                                        this.getMandatoryClimbJoyY(altitude, selfForward.y),
                                        steepDive ? 0.72 : 0.5
                                    )
                                    : (noseHigh || stalledNow ? (steepDive ? 0.22 : 0.06) : (steepDive ? 0.55 : 0.18));
                                if (embedOrHardLow && !mandClimbLow) {
                                    // T41: steep dive owns pull; mild bank only until nose near level.
                                    // T51: alt≈2–4 with mild fwdY still used joyY=0.52 and hit dirt — force dirt pull.
                                    if (steepDive && !noseHigh) {
                                        lowJoyY = altitude < 3 ? 0.92 : (altitude < 12 ? 0.85 : (extremeLow ? 0.78 : 0.62));
                                    } else if (altitude < 8 && !noseHigh && selfForward.y < -0.05) {
                                        lowJoyY = altitude < 3 ? 0.95 : (altitude < 5 ? 0.9 : 0.85);
                                    } else if (altitude < 3) {
                                        lowJoyY = 0.82;
                                    } else if (extremeLow) {
                                        lowJoyY = selfForward.y < 0 ? 0.78 : 0.62;
                                    } else if (altitude < 12) {
                                        lowJoyY = selfForward.y < -0.1 ? 0.55 : 0.28;
                                    } else {
                                        lowJoyY = 0.14;
                                    }
                                }
                                // T61: while still diving into dirt, never thrash with |joyX|>0.3.
                                const lowJoyXClamped = (steepDive || (altitude < 10 && selfForward.y < -0.35))
                                    ? this.clamp(lowJoyX, -0.28, 0.28)
                                    : lowJoyX;
                                return this.withDebug({
                                    state: 'obstacleEmergencyEscape',
                                    statusText: (roofExitLow || mandClimbLow)
                                        ? `NPC: 近地強制爬升 ${altitude.toFixed(1)}m`
                                        : (embedOrHardLow
                                            ? (altitude < 3
                                                ? `NPC: 近地嵌樓側拉 ${altitude.toFixed(1)}m`
                                                : `NPC: 近地嵌樓側推 ${altitude.toFixed(1)}m`)
                                            : `NPC: 近地繞樓脫離 ${altitude.toFixed(1)}m`),
                                    throttle: stalledNow
                                        ? 3
                                        : (embedOrHardLow && !mandClimbLow
                                            ? (extremeLow || self.heat > 82 ? 3 : 4)
                                            : (self.heat > 76 ? 3 : 4)),
                                    joyX: lowJoyXClamped,
                                    joyY: lowJoyY,
                                    pitchCmd: noseHigh
                                        ? maxPitchCmd * 0.18
                                        : -maxPitchCmd * ((roofExitLow || mandClimbLow)
                                            ? 0.55
                                            : (embedOrHardLow
                                                ? (altitude < 3 ? 0.72 : (steepDive ? 0.48 : 0.28))
                                                : (steepDive ? 0.35 : 0.18))),
                                    roll: this.clamp(urbanAvoidSide * ((roofExitLow || mandClimbLow || embedOrHardLow) ? Math.PI / 10 : Math.PI / 6), -Math.PI / 6, Math.PI / 6),
                                    weapon: 'gun',
                                    queueAction: 'none',
                                    ready: true,
                                    dirtPullFloor: altitude < 8 && !!embedOrHardLow && !mandClimbLow,
                                    diveLevelPull: !!(steepDive && !noseHigh) || (altitude < 8 && !noseHigh && selfForward.y < -0.05),
                                    reason: (roofExitLow || mandClimbLow)
                                        ? 'T25 mandatory climb below floor: climb out of canyon (sky clear)'
                                        : (embedOrHardLow
                                            ? (altitude < 8 && !noseHigh && selfForward.y < -0.05
                                                ? 'Extreme-low embed: dirt pull first (T51)'
                                                : (steepDive && !noseHigh
                                                    ? 'Low-alt embed steep dive: level nose before lateral'
                                                    : (altitude < 3
                                                        ? 'Extreme-low embed: lateral + dirt pull budget'
                                                        : 'Low-alt embed/hard contact: lateral push-out before pull thrash')))
                                            : 'Low-alt urban: lateral around buildings (no joyY=1 pull thrash)')
                                }, debugBase, [...tree, `selected: ${(roofExitLow || mandClimbLow) ? 'obstacleEmergencyEscape-mandatoryClimb' : (embedOrHardLow ? (steepDive && !noseHigh ? 'obstacleEmergencyEscape-lowEmbedDivePull' : (altitude < 3 ? 'obstacleEmergencyEscape-lowEmbedDirt' : 'obstacleEmergencyEscape-lowEmbed')) : 'obstacleEmergencyEscape-lowUrban')} embed=${embedOrHardLow ? 1 : 0}`], 'obstacleEmergencyEscape');
                            }
                            if (canyonDiveAbort && urbanArenaMode) {
                                const side = urbanAvoidSide || breakSide || 1;
                                const recoveryThrottle = this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0);
                                const divePull = steepDive
                                    ? (altitude < 18 ? 0.88 : (altitude < 28 ? 0.78 : 0.7))
                                    : (altitude < 22 ? 0.72 : 0.62);
                                return this.withDebug({
                                    state: 'emergencyPullUp',
                                    statusText: `NPC: 街谷俯衝改平 ${altitude.toFixed(1)}m`,
                                    throttle: Math.min(recoveryThrottle, 4),
                                    joyX: this.clamp(side * 0.28, -0.32, 0.32),
                                    joyY: divePull,
                                    pitchCmd: -maxPitchCmd * (steepDive ? 0.78 : 0.62),
                                    roll: this.clamp(side * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
                                    weapon: 'gun',
                                    queueAction: 'none',
                                    ready: true,
                                    diveLevelPull: true,
                                    reason: 'Canyon steep/moderate dive: pull level before building lateral thrash'
                                }, debugBase, [...tree, 'selected: emergencyPullUp-canyonDive'], 'emergencyPullUp');
                            }
                            const recoveryThrottle = this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0);
                            const lateral = this.getEmergencyPullUpLateral({
                                distance,
                                headOnFactor,
                                localToEnemy,
                                breakSide: urbanAvoidSide || breakSide,
                                altitude,
                                forwardY: selfForward.y
                            });
                            // Always keep some lateral in dense urban / when stalled — never joyX=0 + joyY=1.
                            const side = urbanAvoidSide || breakSide || 1;
                            const forceLat = urbanArenaMode || stalledNow || noseHigh;
                            let joyX = lateral.active
                                ? lateral.joyX
                                : (forceLat ? this.clamp(side * (stalledNow ? 0.42 : 0.32), -0.55, 0.55) : 0);
                            // T61: dirt / steep pull — bank ≤0.28–0.35 so pitch owns the stick.
                            const dirtPull = extremeLow || altitude < 12 || altitudeLane.lane === 'dirt';
                            if (steepDive || dirtPull) {
                                const cap = (steepDive && altitude < 14) || extremeLow ? 0.28 : 0.35;
                                const seeded = Math.abs(Number(joyX) || 0) > 0.05 ? joyX : side * Math.min(0.28, cap);
                                joyX = this.clamp(seeded, -cap, cap);
                            }
                            // Cap climb: diving → strong pull near dirt; nose-high/stall → unload/level.
                            let joyY;
                            if (noseHigh || (stalledNow && !steepDive && !moderateDive)) {
                                joyY = altitude < 12 ? 0.28 : -0.12;
                            } else if (steepDive || moderateDive) {
                                // T92: mid-alt dive bleed — need real pull above 12m, not joyY=0.38/0.55.
                                if (altitude < 12) joyY = 0.92;
                                else if (altitude < 22) joyY = steepDive ? 0.88 : 0.78;
                                else if (altitude < 36) joyY = steepDive ? 0.82 : 0.72;
                                else joyY = steepDive ? 0.72 : 0.62;
                            } else {
                                joyY = extremeLow ? 0.7 : (altitude < 14 ? 0.55 : 0.38);
                            }
                            if (lateral.active) {
                                joyY = Math.max(
                                    joyY * lateral.joyYScale,
                                    altitude < 12 && (steepDive || moderateDive) ? 0.72 : joyY * 0.85
                                );
                            }
                            // Building-first safety net if urban path did not fire: never slab-climb while hard contact.
                            if (embedOrHardLow) {
                                const push = Math.sign(joyX) || side;
                                const roofN = Number(coverInfo.roofClearance);
                                const gluedLow =
                                    (Number.isFinite(Number(coverInfo.distance)) && Number(coverInfo.distance) < 3) ||
                                    (Number.isFinite(roofN) && roofN < 0);
                                const gapOpenLow = this.isFlyableCorridorGap(coverInfo, { underRoof: underRoofGE });
                                if (noseHigh) {
                                    // T38: unload + strong thr4 bank — exit AABB, do not climb into slab.
                                    // Gap open: keep climb floor (flat joyY≈0 was dump death).
                                    joyX = this.clamp(push * (gluedLow ? 0.55 : 0.48), -0.58, 0.58);
                                    joyY = gapOpenLow
                                        ? (altitude < 22 ? 0.22 : 0.12)
                                        : (altitude < 16 ? -0.08 : -0.14);
                                } else if (altitude < 3) {
                                    joyX = this.clamp(push * 0.32, -0.35, 0.35);
                                    joyY = Math.max(joyY, steepDive ? 0.78 : 0.62);
                                    joyY = Math.min(joyY, 0.82);
                                } else if (steepDive || extremeLow || altitude < 12) {
                                    joyX = this.clamp(push * (gluedLow ? 0.36 : 0.28), -0.4, 0.4);
                                    joyY = Math.max(joyY, altitude < 8 ? 0.62 : 0.48);
                                    joyY = Math.min(joyY, altitude < 8 ? 0.72 : 0.58);
                                } else if (gluedLow) {
                                    joyX = this.clamp(push * 0.55, -0.62, 0.62);
                                    joyY = gapOpenLow
                                        ? Math.max(joyY, altitude < 22 ? 0.22 : 0.14)
                                        : Math.min(joyY, altitude < 12 ? 0.08 : 0.04);
                                } else {
                                    joyX = this.clamp(push * 0.48, -0.52, 0.52);
                                    joyY = Math.min(joyY, altitude < 8 ? 0.52 : 0.28);
                                }
                            }
                            const flareDuringPull =
                                actualMissileThreat &&
                                canUseFlare &&
                                flareCooldownReady &&
                                altitude >= 18 &&
                                !hardGroundAbort &&
                                !extremeLow;
                            if (flareDuringPull) {
                                const breakJoyX = joyX || this.clamp((-horizontalBias * 0.55) + (0.4 * side), -0.9, 0.9);
                                return this.withDebug({
                                    state: 'defensiveFlare',
                                    statusText: `NPC: 低空熱焰+改平 ${altitude.toFixed(1)}m`,
                                    throttle: recoveryThrottle,
                                    joyX: breakJoyX,
                                    joyY: Math.max(0.28, Math.min(0.62, joyY)),
                                    pitchCmd: noseHigh ? maxPitchCmd * 0.15 : -maxPitchCmd * 0.55,
                                    roll: this.clamp(breakJoyX * Math.PI / 5, -Math.PI / 5, Math.PI / 5),
                                    weapon: 'gun',
                                    queueAction: 'flare',
                                    ready: true,
                                    reason: 'Actual missile threat: flare while recovering from dive'
                                }, debugBase, [...tree, `selected: defensiveFlare-pullUp lateral=${lateral.active || forceLat ? 1 : 0}`], 'defensiveFlare');
                            }
                            return this.withDebug({
                                state: 'emergencyPullUp',
                                statusText: (lateral.active || forceLat)
                                    ? `NPC: 緊急改平脫離 ${altitude.toFixed(1)}m`
                                    : `NPC: 緊急改平 ${altitude.toFixed(1)}m`,
                                throttle: (stalledNow && !steepDive) ? Math.min(recoveryThrottle, 3) : recoveryThrottle,
                                joyX,
                                joyY,
                                pitchCmd: noseHigh
                                    ? maxPitchCmd * 0.2
                                    : -maxPitchCmd * (steepDive ? (altitude < 12 ? 0.9 : 0.75) : (extremeLow ? 0.6 : 0.4)),
                                roll: this.clamp(joyX * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                diveLevelPull: !!steepDive,
                                dirtPullFloor: !!(extremeLow && steepDive),
                                reason: noseHigh || stalledNow
                                    ? 'Low-alt stall/nose-high: unload + lateral (no vertical thrash)'
                                    : (lateral.active || forceLat
                                        ? 'Low-altitude recovery with lateral break'
                                        : (steepDive
                                            ? 'Steep dive recovery with capped pull'
                                            : 'Low altitude level recovery'))
                            }, debugBase, [...tree, `selected: emergencyPullUp lateral=${lateral.active || forceLat ? 1 : 0} noseHigh=${noseHigh ? 1 : 0} stall=${stalledNow ? 1 : 0}`], 'emergencyPullUp');
                        }

                        if (lowAltRecoverLock.active) {
                            const lowAltRecover = altitude < 10;
                            const recoveryThrottle = this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0);
                            const noseHighLock = selfForward.y > 0.22;
                            const stalledLock = !!self.stalled || energyCritical;
                            const side = urbanAvoidSide || breakSide || 1;
                            const lateral = this.getEmergencyPullUpLateral({
                                distance,
                                headOnFactor,
                                localToEnemy,
                                breakSide: side,
                                altitude,
                                forwardY: selfForward.y
                            });
                            const joyX = lateral.active
                                ? lateral.joyX
                                : this.clamp(side * 0.48, -0.65, 0.65);
                            const joyY = noseHighLock || stalledLock
                                ? (lowAltRecover ? 0.28 : -0.08)
                                : (lowAltRecover ? 0.55 : 0.38) * (lateral.active ? lateral.joyYScale : 1);
                            return this.withDebug({
                                state: 'emergencyRecoverLock',
                                statusText: `NPC: 低空保命鎖定 ${altitude.toFixed(1)}m`,
                                throttle: (stalledLock && !lowAltRecover) ? 3 : (lowAltRecover ? recoveryThrottle : (self.heat > 40 ? 4 : recoveryThrottle)),
                                joyX,
                                joyY,
                                pitchCmd: noseHighLock ? maxPitchCmd * 0.18 : (lowAltRecover ? -maxPitchCmd * 0.55 : -(maxPitchCmd * 0.4)),
                                roll: this.clamp(joyX * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: noseHighLock || stalledLock
                                    ? 'Low-alt recovery lock: unload/lateral (no joyY=1)'
                                    : 'Two-turn low-altitude recovery lock with lateral'
                            }, debugBase, [...tree, `selected: emergencyRecoverLock lateral=1 noseHigh=${noseHighLock ? 1 : 0}`], 'emergencyRecoverLock');
                        }

                        if (postGroundRecoveryLock.active || navClimbOut.active) {
                            const climbTarget = navClimbOut.targetAlt || tuning.combatBandMin || 35;
                            const stillClimbing = navClimbOut.active
                                ? !navClimbOut.clearanceOk
                                : (altitude < climbTarget || selfForward.y < -0.15 ||
                                    altitudeLane.lane === 'canyon' || altitudeLane.lane === 'dirt' ||
                                    (Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 4 &&
                                        !(aiMapCtx.clearAbove || aiMapCtx.skyOpen)));
                            // Do not swallow missile defense while climbing out — flare/evade must remain reachable.
                            const missileDefenseNeeded = actualMissileThreat && altitude >= 18 && (self.flareAmmo || 0) > 0;
                            // Soft: aiMap clear + past band — yield to engagement/close (T150 climb lock).
                            const bandMinNow = Number(tuning.combatBandMin) || 35;
                            const aiMapEngageYield =
                                !!(aiMapCtx.clearAbove || aiMapCtx.skyOpen) &&
                                !hardBuildingContact &&
                                altitude >= bandMinNow &&
                                altitudeLane.lane !== 'dirt' &&
                                selfForward.y > -0.35 &&
                                coverInfo.collisionRisk !== 'high' &&
                                (
                                    (sensor.hasContact && Number.isFinite(distance) && distance <= Number(missileMaxRange) * 1.05) ||
                                    (Number.isFinite(distance) && distance > Number(missileMaxRange) * 0.9)
                                );
                            if (aiMapEngageYield && (stillClimbing || navClimbOut.active)) {
                                this.clearNavIntent(teamId);
                                navClimbOut.active = false;
                                navClimbOut.clearanceOk = true;
                                tree.push(
                                    `postGroundGate: deferred=aiMapEngageYield alt=${altitude.toFixed(1)} dist=${distance.toFixed(1)} clear=${aiMapCtx.clearAbove ? 1 : 0}`
                                );
                            } else if (stillClimbing && !missileDefenseNeeded) {
                                const climbSide = navClimbOut.side || urbanAvoidSide || breakSide || 0;
                                this.armNavClimbOut(teamId, {
                                    turnNo,
                                    side: climbSide,
                                    targetAlt: climbTarget,
                                    holdTurns: 4,
                                    source: navClimbOut.source || 'postGround'
                                });
                                return this.withDebug(
                                    this.buildNavClimbOutAction({
                                        altitude,
                                        forwardY: selfForward.y,
                                        heat: self.heat || 0,
                                        side: climbSide,
                                        targetAlt: climbTarget,
                                        maxPitchCmd,
                                        source: navClimbOut.source || 'postGround',
                                        coverInfo
                                    }),
                                    debugBase,
                                    [...tree, 'selected: postGroundClimbOut navCommit=1'],
                                    'postGroundClimbOut'
                                );
                            }
                            if (missileDefenseNeeded) {
                                tree.push(`postGroundGate: deferred=missileThreat dist=${distance.toFixed(1)} ang=${angleToTargetDeg.toFixed(1)}`);
                            } else {
                                tree.push(`postGroundGate: cleared alt=${altitude.toFixed(1)} target=${climbTarget}`);
                            }
                        }
                return null;
            }],
            ['fox2Opening', () => {
                // Prefer planner/emergency while urban pressure remains (少強制、優選路 — T76).
                        const openingUrbanBlock = this.shouldBlockOpeningForUrbanPressure(coverInfo, {
                            altitude,
                            forwardY: selfForward.y,
                            altitudeLane,
                            aiMapClearAbove: aiMapCtx.clearAbove,
                            aiMapSkyOpen: aiMapCtx.skyOpen
                        });
                        if (openingUrbanBlock) {
                            tree.push(
                                `fox2Opening: blocked=${openingUrbanBlock} roof=${Number.isFinite(Number(coverInfo.roofClearance)) ? Number(coverInfo.roofClearance).toFixed(1) : 'n/a'} dist=${Number.isFinite(Number(coverInfo.distance)) ? Number(coverInfo.distance).toFixed(1) : 'n/a'} risk=${coverInfo.collisionRisk || 'n/a'}`
                            );
                            return null;
                        }
                        // Nav climb-out commitment: opening/alignFirst wait until canyon/roof-clear (T41).
                        // Soft: aiMap clear + past band — do not keep blocking fight (T150).
                        if (navClimbOut.active) {
                            const softClearNav =
                                !!(aiMapCtx.clearAbove || aiMapCtx.skyOpen) &&
                                !hardBuildingContact &&
                                altitude >= (Number(tuning.combatBandMin) || 35) &&
                                altitudeLane.lane !== 'dirt' &&
                                coverInfo.collisionRisk !== 'high';
                            if (softClearNav) {
                                this.clearNavIntent(teamId);
                                navClimbOut.active = false;
                                tree.push(
                                    `fox2Opening: navClimbOut softCleared aiMap alt=${altitude.toFixed(1)} clear=${aiMapCtx.clearAbove ? 1 : 0}`
                                );
                            } else {
                                tree.push(
                                    `fox2Opening: blocked=navClimbOut alt=${altitude.toFixed(1)} target=${navClimbOut.targetAlt} lane=${altitudeLane.lane}`
                                );
                                return null;
                            }
                        }
                        // T92: recovery window — do not steal sticks during/after pull-up into opening align.
                        if (postGroundRecoveryLock.active || lowAltRecoverLock.active) {
                            tree.push(
                                `fox2Opening: blocked=recoveryLock postGround=${postGroundRecoveryLock.active ? 1 : 0} lowAlt=${lowAltRecoverLock.active ? 1 : 0}`
                            );
                            return null;
                        }
                        if (
                            altitudeLane.lane === 'canyon' ||
                            altitudeLane.lane === 'dirt' ||
                            (altitude < 48 && selfForward.y < -0.12) ||
                            (altitude < 50 && Number.isFinite(Number(coverInfo.roofClearance)) && Number(coverInfo.roofClearance) < 8 && selfForward.y < 0.05)
                        ) {
                            tree.push(
                                `fox2Opening: blocked=recoveryGeometry alt=${altitude.toFixed(1)} fwdY=${selfForward.y.toFixed(2)} lane=${altitudeLane.lane} roof=${Number.isFinite(Number(coverInfo.roofClearance)) ? Number(coverInfo.roofClearance).toFixed(1) : 'n/a'}`
                            );
                            return null;
                        }
                        // T66: open-area spiral — alignFirst after partial pull-up re-banks and bleeds altitude.
                        if (altitude < 38 || groundRisk || (altitude < 46 && selfForward.y < -0.05)) {
                            tree.push(
                                `fox2Opening: blocked=lowAltOrGroundRisk alt=${altitude.toFixed(1)} fwdY=${selfForward.y.toFixed(2)}`
                            );
                            return null;
                        }
                // Knife-range midair before opening align/press (T20/T36; soft band ~20m vs groundAvoid/urban).
                        const midairBreak = this.tryCloseMidairBreak(midairParts, coverInfo, tree, 'midairPreOpening');
                        if (midairBreak) {
                            return this.withDebug(
                                midairBreak,
                                debugBase,
                                [...tree, `selected: ${midairBreak.state}-preOpening dist=${distance.toFixed(1)}`],
                                midairBreak.state
                            );
                        }
                // Doctrine: seen + clear LOS → align nose first, accelerate only after aspect is usable.
                        const alignBeforeAccel = this.wantsAlignBeforeAccel({
                            seenNow: sensor.seenNow,
                            lineOfSightBlocked,
                            actualMissileThreat,
                            imminentBuildingHit: imminentBuildingHit || strictImminentBuilding,
                            groundRisk,
                            energyCritical,
                            stalled: !!self.stalled,
                            imminentGroundImpact,
                            collisionRisk: coverInfo.collisionRisk,
                            coverForwardDistance: coverInfo.forwardDistance,
                            angleDeg: angleToTargetDeg,
                            localZ: localToEnemy.z,
                            forwardY: selfForward.y,
                            altitude,
                            altitudeLane: altitudeLane.lane,
                            postGroundRecovery: !!postGroundRecoveryLock.active,
                            lowAltRecover: !!lowAltRecoverLock.active
                        });
                        tree.push(`alignFirstGate: need=${alignBeforeAccel ? 1 : 0} losClear=${lineOfSightBlocked ? 0 : 1} seen=${sensor.seenNow ? 1 : 0} ang=${angleToTargetDeg.toFixed(1)} lz=${localToEnemy.z.toFixed(2)} fwdY=${selfForward.y.toFixed(2)}`);

                        // FOX2-FIRST opening: power seekers first; only shoot once a pylon is armed (next turn).
                        // T40: refuse opening envelope while already diving (combat-lane align suicide).
                        const openingHardGround =
                            altitude < 14 ||
                            (altitude < 20 && selfForward.y < -0.45) ||
                            (altitude < 28 && selfForward.y < -0.55) ||
                            selfForward.y < -0.35;
                        const openingEnvelope =
                            (openingFox2Rush || fox2PerchWindow) &&
                            coverInfo.collisionRisk !== 'high' &&
                            !strictImminentBuilding &&
                            !openingHardGround &&
                            !lineOfSightBlocked &&
                            !actualMissileThreat;
                        // Opening shot/align also refuse knife midair (belt after early break).
                        const openingTooClose = distance <= 18 || predictedSeparation <= 12;
                        const openingShotReady =
                            openingEnvelope &&
                            hasArmedMissile &&
                            distance >= missileMinRange &&
                            distance <= Math.max(missileLockRange + 8, missileMaxRange) &&
                            angleToTargetDeg < 48 &&
                            localToEnemy.z > 0.52;
                        if (openingShotReady && !openingTooClose) {
                            const shootJoyX = this.resolveTurnJoyX(
                                baseHorizontalBias * 0.4,
                                localToEnemy,
                                angleToTargetDeg,
                                urbanAvoidSide || breakSide,
                                0.25
                            );
                            return this.withDebug({
                                state: 'missileAttack',
                                statusText: `NPC: 開局 FOX-2 ${Math.floor(distance)}m`,
                                throttle: self.heat > 86 ? 4 : 5,
                                joyX: shootJoyX,
                                joyY: this.clamp(baseVerticalBias * 0.2, -0.18, 0.22),
                                roll: this.clamp(shootJoyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
                                weapon: 'missile',
                                powerPylons: false,
                                queueAction: 'missile',
                                singleMissile: true,
                                ready: true,
                                reason: 'Opening fox2-first: immediate shot in envelope'
                            }, debugBase, [...tree, 'selected: missileAttack-openingImmediate'], 'missileAttack');
                        }

                        if (alignBeforeAccel && !(openingFox2Rush || fox2PerchWindow) && !openingTooClose) {
                            const alignCtrl = this.buildAlignBeforeAccelControls({
                                angleDeg: angleToTargetDeg,
                                localToEnemy,
                                forwardY: selfForward.y,
                                altitude,
                                breakSide: urbanAvoidSide || breakSide,
                                baseHorizontalBias,
                                collisionRisk: coverInfo.collisionRisk,
                                coverForwardDistance: coverInfo.forwardDistance,
                                openSkyAlign: coverInfo.collisionRisk === 'low' || !!coverInfo.corridorClear
                            });
                            const preferMsl = hasAnyMissile && (rangeMode === 'missile' || policyMode === 'fox2-first' || policyMode === 'fox1-first' || openingFox2Rush);
                            return this.withDebug({
                                state: 'alignFirst',
                                statusText: `NPC: 先對準再加速 ${Math.floor(angleToTargetDeg)}°`,
                                throttle: alignCtrl.throttle,
                                joyX: alignCtrl.joyX,
                                joyY: alignCtrl.joyY,
                                pitchCmd: selfForward.y > 0.45 ? maxPitchCmd * 0.35 : undefined,
                                roll: alignCtrl.roll,
                                weapon: preferMsl ? 'missile' : 'gun',
                                powerPylons: preferMsl && !hasArmedMissile,
                                queueAction: 'none',
                                ready: true,
                                reason: 'Clear LOS contact: align nose before accelerate'
                            }, debugBase, [...tree, `selected: alignFirst thr=${alignCtrl.throttle} fwdY=${selfForward.y.toFixed(2)}`], 'alignFirst');
                        }
                        // During fox2 opening, still align if badly off — but keep missile powered.
                        if (alignBeforeAccel && (openingFox2Rush || fox2PerchWindow) && !openingShotReady && !openingTooClose) {
                            const alignCtrl = this.buildAlignBeforeAccelControls({
                                angleDeg: angleToTargetDeg,
                                localToEnemy,
                                forwardY: selfForward.y,
                                altitude,
                                breakSide: urbanAvoidSide || breakSide,
                                baseHorizontalBias,
                                collisionRisk: coverInfo.collisionRisk,
                                coverForwardDistance: coverInfo.forwardDistance,
                                openSkyAlign: coverInfo.collisionRisk === 'low' || !!coverInfo.corridorClear
                            });
                            return this.withDebug({
                                state: 'alignFirst',
                                statusText: `NPC: 開局對準搶射 ${Math.floor(angleToTargetDeg)}°`,
                                throttle: alignCtrl.throttle,
                                joyX: alignCtrl.joyX,
                                joyY: alignCtrl.joyY,
                                pitchCmd: selfForward.y > 0.45 ? maxPitchCmd * 0.35 : undefined,
                                roll: alignCtrl.roll,
                                weapon: 'missile',
                                powerPylons: !hasArmedMissile,
                                missileType: aiMissileType,
                                queueAction: 'none',
                                ready: true,
                                reason: 'Opening fox2-first: align then shoot next'
                            }, debugBase, [...tree, `selected: alignFirst-opening thr=${alignCtrl.throttle}`], 'alignFirst');
                        }

                        // Opening fox2-first: spawn is already at perch — only climb if still well below rooftops.
                        // Nose-on + armed: AB to close/shoot. Do NOT balloon-climb.
                        if (openingEnvelope) {
                            const roofTargetAlt = Math.max(Number(tuning.combatBandMin || 35) + 8, urbanArenaMode ? 46 : 38);
                            const needRoofClimb = urbanArenaMode && altitude < (roofTargetAlt - 8);
                            const aspectOk = localToEnemy.z > 0.45 && angleToTargetDeg < 55;
                            const noseSeeking = !aspectOk || angleToTargetDeg > 40 || localToEnemy.z < 0.35;
                            const openingTurnBias = noseSeeking ? baseHorizontalBias : horizontalBias;
                            const abThrottle = self.heat > 86 ? 4 : 5;
                            const turnThrottle = 3;
                            const rushThrottle = noseSeeking ? turnThrottle : abThrottle;
                            const missileAngleRadRush = (tuning.missileAngle * Math.PI / 180);
                            const rushLock =
                                aspectOk &&
                                hasArmedMissile &&
                                distance >= missileMinRange &&
                                distance <= Math.max(missileLockRange + 8, missileMaxRange) &&
                                angleToTarget <= Math.max(missileLockAngle * 1.45, missileAngleRadRush * 1.45) &&
                                localToEnemy.z > 0.55 &&
                                !lineOfSightBlocked;
                            const dashJoyX = this.resolveTurnJoyX(
                                openingTurnBias * (rushLock ? 0.38 : (noseSeeking ? 1.45 : 1.2)),
                                localToEnemy,
                                angleToTargetDeg,
                                urbanAvoidSide || breakSide,
                                rushLock ? 0.28 : (noseSeeking ? 0.95 : 0.88)
                            );
                            if (rushLock) {
                                return this.withDebug({
                                    state: 'missileAttack',
                                    statusText: `NPC: 開局 FOX-2 ${Math.floor(distance)}m`,
                                    throttle: abThrottle,
                                    joyX: dashJoyX,
                                    joyY: this.clamp(verticalBias * 0.18, -0.15, 0.2),
                                    roll: this.clamp(dashJoyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
                                    weapon: 'missile',
                                    powerPylons: false,
                                    queueAction: 'missile',
                                    singleMissile: true,
                                    ready: true,
                                    reason: 'Opening fox2-first: shoot from perch'
                                }, debugBase, [...tree, 'selected: missileAttack-opening'], 'missileAttack');
                            }
                            if (needRoofClimb && aspectOk && !noseSeeking) {
                                return this.withDebug({
                                    state: 'openingRoofDash',
                                    statusText: `NPC: 開局躍升搶位 ${altitude.toFixed(0)}m→${Math.floor(roofTargetAlt)}m`,
                                    throttle: noseSeeking ? turnThrottle : abThrottle,
                                    joyX: dashJoyX,
                                    joyY: altitude < 28 ? 0.72 : 0.48,
                                    pitchCmd: -maxPitchCmd * (altitude < 30 ? 0.5 : 0.32),
                                    roll: this.clamp(dashJoyX * Math.PI / 4.5, -Math.PI / 4.5, Math.PI / 4.5),
                                    weapon: 'missile',
                                    powerPylons: !hasArmedMissile,
                                missileType: aiMissileType,
                                    queueAction: 'none',
                                    ready: true,
                                    reason: 'Opening fox2-first: climb only until above urban canopy'
                                }, debugBase, [...tree, `selected: openingRoofDash roof=1 aspect=${aspectOk ? 1 : 0}`], 'openingRoofDash');
                            }
                            const behind = localToEnemy.z < 0.25 || angleToTargetDeg > 70;
                            return this.withDebug({
                                state: behind ? 'reacquire' : 'missilePrep',
                                statusText: behind
                                    ? `NPC: 開局回轉對準 ${Math.floor(angleToTargetDeg)}°`
                                    : `NPC: 開局全速搶射 ${Math.floor(distance)}m`,
                                throttle: rushThrottle,
                                joyX: dashJoyX,
                                joyY: this.clamp(
                                    (selfForward.y < -0.2 ? 0.22 : 0) +
                                    (altitude < tuning.combatBandMin ? 0.12 : 0) +
                                    (noseSeeking ? baseVerticalBias * 0.35 : verticalBias * 0.2),
                                    -0.22,
                                    0.32
                                ),
                                roll: this.clamp(dashJoyX * Math.PI / 3.4, -Math.PI / 3.4, Math.PI / 3.4),
                                weapon: 'missile',
                                powerPylons: !hasArmedMissile,
                                missileType: aiMissileType,
                                queueAction: 'none',
                                ready: true,
                                reason: behind
                                    ? 'Opening fox2-first: MIL/ECO reverse toward target (AB blocked while off-boresight)'
                                    : 'Opening fox2-first: already at perch — power pylons and close'
                            }, debugBase, [...tree, `selected: ${behind ? 'reacquire-opening' : 'missilePrep-opening'} roof=0 aspect=${aspectOk ? 1 : 0} noseSeek=${noseSeeking ? 1 : 0} thr=${rushThrottle}`], behind ? 'reacquire' : 'missilePrep');
                        }
                return null;
            }],
            ['altitudeTerrain', () => {
                // Midair soft band before groundAvoid / terrainEscape (T68).
                        const midairOverAlt = this.tryCloseMidairBreak(midairParts, coverInfo, tree, 'midairOverAltitude');
                        if (midairOverAlt) {
                            return this.withDebug(
                                midairOverAlt,
                                debugBase,
                                [...tree, `selected: ${midairOverAlt.state}-overAltitude dist=${distance.toFixed(1)}`],
                                midairOverAlt.state
                            );
                        }
                const altitudeBand = this.getCombatAltitudeProfile(altitude, tuning, selfForward.y);
                        tree.push(`altitudeBandGate: zone=${altitudeBand.zone} excess=${altitudeBand.excess.toFixed(1)} fwdY=${selfForward.y.toFixed(2)}`);
                        // Soft: fox1/fox2-first beyond envelope — prefer close over pure levelOut thrash (T150).
                        const fox1ClosePrefer =
                            (policyMode === 'fox1-first' || policyMode === 'fox2-first') &&
                            Number.isFinite(distance) &&
                            distance > Math.max(160, Number(missileMaxRange) * 0.9) &&
                            altitude < (Number(tuning.combatBandHardMax) || 108) &&
                            !(Number.isFinite(selfForward.y) && selfForward.y > 0.55) &&
                            !groundRisk &&
                            coverInfo.collisionRisk !== 'high' &&
                            (aiMapCtx.clearAbove || aiMapCtx.skyOpen || coverInfo.collisionRisk === 'low');
                        if (fox1ClosePrefer && altitudeBand.needsLevelOut) {
                            tree.push(
                                `altitudeBandGate: deferred=fox1ClosePrefer dist=${distance.toFixed(1)} max=${missileMaxRange} clear=${aiMapCtx.clearAbove ? 1 : 0}`
                            );
                        }
                        if (
                            altitudeBand.needsLevelOut &&
                            !fox1ClosePrefer &&
                            !groundRisk &&
                            coverInfo.collisionRisk !== 'high' &&
                            !offenseAssist.deferLevelOut &&
                            !openingFox2Rush
                        ) {
                            return this.withDebug({
                                state: 'altitudeBandLevelOut',
                                statusText: `NPC: 作戰高度回收 ${altitude.toFixed(1)}m`,
                                throttle: self.heat > 78 ? 3 : (altitudeBand.levelOutThrottle || 4),
                                joyX: this.clamp(horizontalBias * 0.18, -0.28, 0.28),
                                joyY: altitudeBand.levelOutJoyY,
                                pitchCmd: maxPitchCmd * altitudeBand.levelOutPitch,
                                roll: 0,
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Descend back into combat altitude band instead of escaping vertically'
                            }, debugBase, [...tree, `selected: altitudeBandLevelOut joyY=${Number(altitudeBand.levelOutJoyY).toFixed(2)} thr=${altitudeBand.levelOutThrottle || 4}`], 'altitudeBandLevelOut');
                        }

                        if (coverInfo.distance < 3 || hardBuildingContact || (coverInfo.collisionRisk === 'high' && altitude < 22)) {
                            const obstacleDir = coverInfo.direction || new THREE.Vector3(breakSide, 0, 0);
                            const sideSign = Math.sign(
                                (urbanAvoidSide || 0) ||
                                selfForward.clone().cross(obstacleDir).y ||
                                breakSide
                            ) || breakSide;
                            const steepInto = selfForward.y > 0.35;
                            // Urban / hard contact: lateral around building — not vertical thrash.
                            const urbanHard = urbanArenaMode || hardBuildingContact;
                            return this.withDebug({
                                state: 'terrainEscape',
                                statusText: `NPC: 地形脫離 ALT ${altitude.toFixed(1)} CVR ${debugBase.coverDistance}m`,
                                throttle: self.heat > 78 ? 3 : 5,
                                joyX: this.clamp(sideSign * (urbanHard ? 0.88 : 0.34), -1, 1),
                                joyY: urbanHard
                                    ? (steepInto ? 0.08 : 0.22)
                                    : (altitude < 28 ? 0.8 : 0.45),
                                pitchCmd: -maxPitchCmd * (urbanHard ? (steepInto ? 0.15 : 0.28) : 0.8),
                                roll: this.clamp(sideSign * (urbanHard ? Math.PI / 6 : Math.PI / 12), -Math.PI / 6, Math.PI / 6),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: urbanHard
                                    ? 'Building contact: lateral around-building escape (not vertical thrash)'
                                    : 'Too close to terrain/building for lateral evade'
                            }, debugBase, [...tree, `selected: terrainEscape hardContact=${hardBuildingContact ? 1 : 0}`], 'terrainEscape');
                        }

                        if (groundRisk) {
                            // Midair <~20m beats groundAvoid (T68: pull-up into merge).
                            const midairOverGround = this.tryCloseMidairBreak(midairParts, coverInfo, tree, 'midairOverGround');
                            if (midairOverGround) {
                                return this.withDebug(
                                    midairOverGround,
                                    debugBase,
                                    [...tree, `selected: ${midairOverGround.state}-overGroundAvoid dist=${distance.toFixed(1)}`],
                                    midairOverGround.state
                                );
                            }
                            const recoveryThrottle = this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0);
                            const safePull = altitude < 28 ? 0.82 : (energyLow ? 0.46 : 0.62);
                            // Above ~28m: keep some turn toward target while pulling up (avoid joyX=0 freeze).
                            const canSteer = altitude >= 28 && sensor.hasContact && coverInfo.collisionRisk !== 'high';
                            const preferMissile = canSteer && rangeMode === 'missile' && hasAnyMissile && distance > tuning.gunRange + 8;
                            const flareDuringGroundAvoid =
                                actualMissileThreat &&
                                canUseFlare &&
                                flareCooldownReady &&
                                altitude >= 22;
                            if (flareDuringGroundAvoid) {
                                return this.withDebug({
                                    state: 'defensiveFlare',
                                    statusText: `NPC: 地面避撞熱焰 ${altitude.toFixed(1)}m`,
                                    throttle: recoveryThrottle,
                                    joyX: canSteer
                                        ? this.clamp((-horizontalBias * 0.45) + (0.35 * (urbanAvoidSide || breakSide)), -0.7, 0.7)
                                        : this.clamp(0.4 * (urbanAvoidSide || breakSide), -0.55, 0.55),
                                    joyY: Math.max(safePull, 0.55),
                                    pitchCmd: -maxPitchCmd * (altitude < 28 ? 0.72 : 0.5),
                                    roll: this.clamp((urbanAvoidSide || breakSide) * Math.PI / 7, -Math.PI / 7, Math.PI / 7),
                                    weapon: 'gun',
                                    queueAction: 'flare',
                                    ready: true,
                                    reason: 'Actual missile threat: flare while ground-avoiding'
                                }, debugBase, [...tree, 'selected: defensiveFlare-groundAvoid'], 'defensiveFlare');
                            }
                            return this.withDebug({
                                state: 'groundAvoid',
                                statusText: `NPC: 地面避撞 ${altitude.toFixed(1)}m`,
                                throttle: recoveryThrottle,
                                joyX: canSteer ? this.clamp(horizontalBias * 0.42, -0.55, 0.55) : 0,
                                joyY: safePull,
                                pitchCmd: -maxPitchCmd * (altitude < 28 ? 0.78 : 0.55),
                                roll: canSteer ? this.clamp(horizontalBias * Math.PI / 8, -Math.PI / 8, Math.PI / 8) : 0,
                                weapon: preferMissile ? 'missile' : 'gun',
                                powerPylons: preferMissile && !hasArmedMissile,
                                queueAction: 'none',
                                ready: true,
                                reason: canSteer
                                    ? 'Pull up from steep dive while keeping intercept turn'
                                    : 'Ground avoidance overrides stall and energy recovery'
                            }, debugBase, [...tree, 'selected: groundAvoid'], 'groundAvoid');
                        }

                        // Inbound FOX-2: flare before shallow level-out / dive recovery soft gates.
                        if (
                            actualMissileThreat &&
                            canUseFlare &&
                            flareCooldownReady &&
                            !shouldSaveFlare &&
                            !lineOfSightBlocked &&
                            altitude >= 18 &&
                            coverInfo.collisionRisk !== 'high' &&
                            !imminentBuildingHit
                        ) {
                            const breakJoyX = this.clamp((-horizontalBias * 0.75) + (0.5 * (urbanAvoidSide || breakSide)), -1, 1);
                            return this.withDebug({
                                state: 'defensiveFlare',
                                statusText: `NPC: 飛彈威脅，釋放熱焰`,
                                throttle: self.heat > 70 ? 3 : 4,
                                joyX: breakJoyX,
                                joyY: altitude < 22 ? 0.48 : this.clamp(verticalBias * 0.15 + 0.22, -0.2, 0.45),
                                roll: this.clamp(breakJoyX * Math.PI / 4.5, -Math.PI / 4, Math.PI / 4),
                                weapon: 'gun',
                                queueAction: 'flare',
                                ready: true,
                                reason: 'Actual missile threat: flare before shallowDive/level-out'
                            }, debugBase, [...tree, 'selected: defensiveFlare-preDive'], 'defensiveFlare');
                        }

                        // Nose-off knife fight vs human: do not waste the turn leveling — fall through to hard reacquire.
                        // T40: opening must NOT defer level-out once dive is steep (fwdY < -0.35).
                        const deferShallowForOpening = openingFox2Rush && selfForward.y > -0.35;
                        if (shallowDiveLevel && offenseAssist.deferLevelOut) {
                            tree.push('shallowDiveGate: deferred=offenseAssist');
                        }
                        if (shallowDiveLevel && deferShallowForOpening) {
                            tree.push('shallowDiveGate: deferred=openingFox2');
                        }
                        if (shallowDiveLevel && actualMissileThreat) {
                            tree.push('shallowDiveGate: deferred=missileThreat');
                        }
                        if (shallowDiveLevel && !offenseAssist.deferLevelOut && !deferShallowForOpening && !actualMissileThreat) {
                            // Soft nose-up only; keep turning toward target instead of freezing joyX=0.
                            const preferMissile = rangeMode === 'missile' && hasAnyMissile && distance > tuning.gunRange + 8;
                            const nearMissileLock =
                                preferMissile &&
                                hasArmedMissile &&
                                distance <= missileLockRange + 8 &&
                                angleToTarget <= Math.max(missileLockAngle * 1.35, (tuning.missileAngle * Math.PI / 180)) &&
                                localToEnemy.z > 0.7 &&
                                !lineOfSightBlocked;
                            const divePullY = selfForward.y < -0.45
                                ? this.clamp(0.42 + Math.min(0.28, Math.abs(selfForward.y) * 0.4), 0.42, 0.7)
                                : this.clamp(0.18 + Math.min(0.22, Math.abs(selfForward.y) * 0.35), 0.12, 0.4);
                            const diveBankCap = selfForward.y < -0.45 ? 0.32 : 0.7;
                            return this.withDebug({
                                state: nearMissileLock ? 'missileAttack' : 'shallowDiveLevel',
                                statusText: nearMissileLock
                                    ? `NPC: 改平 FOX-2 ${Math.floor(distance)}m`
                                    : `NPC: 淺俯衝改平 ${altitude.toFixed(1)}m`,
                                throttle: self.heat > 78 ? 3 : 4,
                                joyX: this.clamp(horizontalBias * (nearMissileLock ? 0.35 : (selfForward.y < -0.45 ? 0.28 : 0.55)), -diveBankCap, diveBankCap),
                                joyY: divePullY,
                                pitchCmd: -maxPitchCmd * (selfForward.y < -0.45 ? 0.55 : 0.28),
                                roll: this.clamp(horizontalBias * Math.PI / (selfForward.y < -0.45 ? 10 : 6), -Math.PI / 6, Math.PI / 6),
                                weapon: preferMissile ? 'missile' : 'gun',
                                powerPylons: preferMissile && !hasArmedMissile,
                                queueAction: nearMissileLock ? 'missile' : 'none',
                                singleMissile: nearMissileLock,
                                ready: true,
                                reason: nearMissileLock
                                    ? 'Shallow level-out with missile lock opportunity'
                                    : 'Mild dive inside combat band; level while continuing intercept'
                            }, debugBase, [...tree, `selected: ${nearMissileLock ? 'missileAttack-shallow' : 'shallowDiveLevel'}`], nearMissileLock ? 'missileAttack' : 'shallowDiveLevel');
                        }
                return null;
            }],
            ['stallEnergy', () => {
                const urbanBuildingEscape =
                    urbanArenaMode &&
                    (
                        coverInfo.collisionRisk === 'medium' ||
                        coverInfo.collisionRisk === 'high' ||
                        this.isForwardBuildingPressure(coverInfo) ||
                        this.isSideLanePressure(coverInfo, true) ||
                        !!coverInfo.corridorClear
                    );
                // Phase 2/3: when stalled/low-energy in the city, route around buildings first.
                // Near-ground vertical pull into stall is expected if chosen — not the doctrine answer.
                if (urbanBuildingEscape && (stallTrap || self.stalled || energyCritical)) {
                    this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 5);
                    const routedStall = this.pickUrbanRoute(teamId, {
                        ...urbanRouteCtx,
                        energyLow: true
                    }, debugBase, tree);
                    if (routedStall) {
                        if (self.stalled && selfForward.y > 0.15 && Number(routedStall.joyY) > 0.22) {
                            routedStall.joyY = 0.16;
                        }
                        if (self.stalled && typeof routedStall.throttle === 'number' && routedStall.throttle > 4) {
                            routedStall.throttle = 4;
                        }
                        return this.withDebug(
                            routedStall,
                            debugBase,
                            [...tree, 'selected: urbanRoute-stallAroundBuildings'],
                            routedStall.state || 'urbanRouteEscape'
                        );
                    }
                    const diveDirt = altitude < 18 && selfForward.y < -0.12;
                    return this.withDebug({
                        state: 'stallRecoverNoRoll',
                        statusText: `NPC: 失速繞樓脫離 AP ${Math.floor(self.ap)} ALT ${altitude.toFixed(1)}`,
                        throttle: diveDirt ? (self.heat > 86 ? 4 : 5) : this.pickThrottleForTurn(3, 0.55, {
                            heat: self.heat || 0,
                            ap: self.ap,
                            stalled: true,
                            energyCritical: true
                        }),
                        joyX: this.clamp(urbanAvoidSide * 0.62, -0.78, 0.78),
                        joyY: diveDirt ? 0.35 : (selfForward.y > 0.18 ? -0.18 : 0.12),
                        pitchCmd: diveDirt ? -maxPitchCmd * 0.35 : (selfForward.y > 0.18 ? maxPitchCmd * 0.22 : -maxPitchCmd * 0.12),
                        roll: this.clamp(urbanAvoidSide * Math.PI / 7, -Math.PI / 7, Math.PI / 7),
                        weapon: 'gun',
                        queueAction: 'none',
                        ready: true,
                        reason: 'Urban stall: lateral around buildings (not vertical pull thrash)'
                    }, debugBase, [...tree, 'selected: stallRecover-aroundBuildings'], 'stallRecoverNoRoll');
                }

                if (stallTrap && coverInfo.collisionRisk !== 'high') {
                            // Pull only when diving into open dirt; nose-high stall unloads.
                            const divingIntoDirt = altitude < 22 && selfForward.y < -0.1;
                            const noseHighStall = selfForward.y > 0.18;
                            const unloadPitch = divingIntoDirt ? 0.08 : (altitude > 40 ? 0.4 : 0.18);
                            const breakJoyX = this.clamp(horizontalBias * (divingIntoDirt ? 0.12 : 0.28), -0.28, 0.28);
                            const breakThr = divingIntoDirt
                                ? (self.heat > 86 ? 4 : 5)
                                : this.pickThrottleForTurn(
                                    self.heat > 78 ? 3 : 4,
                                    breakJoyX,
                                    { heat: self.heat || 0, ap: self.ap, energyCritical: true }
                                );
                            return this.withDebug({
                                state: 'stallBreakout',
                                statusText: divingIntoDirt
                                    ? `NPC: 失速改平拉升 AP ${Math.floor(self.ap)} ALT ${altitude.toFixed(1)}`
                                    : `NPC: 失速改出 AP ${Math.floor(self.ap)} FWDY ${selfForward.y.toFixed(2)}`,
                                throttle: breakThr,
                                joyX: breakJoyX,
                                joyY: divingIntoDirt ? 0.42 : (noseHighStall || altitude > 40 ? -0.4 : -0.08),
                                pitchCmd: divingIntoDirt ? -maxPitchCmd * 0.4 : maxPitchCmd * unloadPitch,
                                roll: 0,
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: divingIntoDirt
                                    ? 'Open-ground dive stall: level before impact'
                                    : 'Break stall by unloading nose and rebuilding airflow'
                            }, debugBase, [...tree, `selected: stallBreakout diveDirt=${divingIntoDirt ? 1 : 0}`], 'stallBreakout');
                        }

                        if (self.stalled && coverInfo.collisionRisk !== 'high') {
                            const divingIntoDirt = altitude < 22 && selfForward.y < -0.1;
                            const lowAltRecover = altitude < 26;
                            const divingStall = selfForward.y < -0.12;
                            const noseHigh = selfForward.y > 0.22;
                            const recoverPitchCmd = divingIntoDirt
                                ? -maxPitchCmd * 0.45
                                : (noseHigh && altitude >= 20
                                    ? maxPitchCmd * 0.28
                                    : (lowAltRecover && divingStall
                                        ? -maxPitchCmd * 0.28
                                        : maxPitchCmd * 0.26));
                            const recoveryThrottle = divingIntoDirt
                                ? this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0)
                                : this.pickThrottleForTurn(3, 0.45, { heat: self.heat || 0, ap: self.ap, stalled: true, energyCritical: true });
                            const recoverJoyX = divingIntoDirt
                                ? this.clamp(horizontalBias * 0.18, -0.24, 0.24)
                                : this.clamp(horizontalBias * 0.42, -0.48, 0.48);
                            const recoverJoyY = divingIntoDirt
                                ? 0.42
                                : (noseHigh
                                    ? -0.22
                                    : (lowAltRecover && divingStall ? 0.28 : -0.34));
                            return this.withDebug({
                                state: 'stallRecoverNoRoll',
                                statusText: divingIntoDirt
                                    ? `NPC: 失速改平 AP ${Math.floor(self.ap)} ALT ${altitude.toFixed(1)}`
                                    : (recoverJoyX
                                        ? `NPC: 失速ECO改出 AP ${Math.floor(self.ap)} ALT ${altitude.toFixed(1)}`
                                        : `NPC: 失速強制改出 AP ${Math.floor(self.ap)} ALT ${altitude.toFixed(1)}`),
                                throttle: recoveryThrottle,
                                joyX: recoverJoyX,
                                joyY: recoverJoyY,
                                pitchCmd: recoverPitchCmd,
                                roll: this.clamp(recoverJoyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: divingIntoDirt
                                    ? 'Open-ground dive stall: level, do not vertical-thrash'
                                    : (noseHigh
                                        ? 'Stall recovery: unload steep nose with ECO turn'
                                        : 'Stall recovery with ECO turn authority (Phase A)')
                            }, debugBase, [...tree, `selected: stallRecoverNoRoll diveDirt=${divingIntoDirt ? 1 : 0} noseHigh=${noseHigh ? 1 : 0}`], 'stallRecoverNoRoll');
                        }

                        if (energyCritical && altitude > 18 && coverInfo.collisionRisk !== 'high') {
                            let recoverJoyY = self.stalled
                                ? (altitude > 32 ? tuning.recoverPitchBias : 0.15)
                                : (altitude < 28 ? 0.22 : tuning.recoverPitchBias * 0.25);
                            if (steepClimb || selfForward.y > tuning.stallPitchThreshold) {
                                recoverJoyY = Math.min(recoverJoyY, tuning.recoverPitchBias);
                            }
                            if (altitude >= tuning.combatBandMin - 6) {
                                recoverJoyY = Math.min(recoverJoyY, 0.06);
                            }
                            recoverJoyY = this.capCombatVerticalJoy(recoverJoyY, altitude, selfForward.y, tuning, sensor.hasContact);
                            // Phase A: rebuild energy while ECO-turning toward target (not joyX=0 freeze).
                            const recoverJoyX = this.clamp(horizontalBias * 0.55, -0.62, 0.62);
                            const recoverThr = this.pickThrottleForTurn(
                                self.heat > 78 ? 3 : 3,
                                recoverJoyX,
                                { heat: self.heat || 0, ap: self.ap, energyCritical: true, lowAp: tuning.lowAp }
                            );
                            return this.withDebug({
                                state: 'energyRecover',
                                statusText: `NPC: 低能ECO回轉 AP ${Math.floor(self.ap)}`,
                                throttle: recoverThr,
                                joyX: recoverJoyX,
                                joyY: recoverJoyY,
                                ...(self.stalled && altitude > 30 ? { pitchCmd: maxPitchCmd * 0.14 } : {}),
                                roll: this.clamp(recoverJoyX * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Recover energy with ECO turn authority (Phase A)'
                            }, debugBase, [...tree, `selected: energyRecover joyX=${recoverJoyX.toFixed(2)} thr=${recoverThr}`], 'energyRecover');
                        }

                        // FOX-2 inbound with flares available: break+flare before any urban climb/route.
                return null;
            }],
            ['urbanCollision', () => {
                        const midairOverUrbanCol = this.tryCloseMidairBreak(midairParts, coverInfo, tree, 'midairOverUrbanCol');
                        if (midairOverUrbanCol && !deepEmbedContact) {
                            return this.withDebug(
                                midairOverUrbanCol,
                                debugBase,
                                [...tree, `selected: ${midairOverUrbanCol.state}-overUrbanCol dist=${distance.toFixed(1)}`],
                                midairOverUrbanCol.state
                            );
                        }
                const missileDefenseUrgent =
                            actualMissileThreat &&
                            canUseFlare &&
                            flareCooldownReady &&
                            !shouldSaveFlare &&
                            !lineOfSightBlocked &&
                            altitude >= 18 &&
                            coverInfo.collisionRisk !== 'high' &&
                            !imminentBuildingHit;
                        if (missileDefenseUrgent) {
                            const breakJoyX = this.clamp((-horizontalBias * 0.75) + (0.5 * (urbanAvoidSide || breakSide)), -1, 1);
                            return this.withDebug({
                                state: 'defensiveFlare',
                                statusText: `NPC: 飛彈威脅，釋放熱焰`,
                                throttle: self.heat > 70 ? 3 : 4,
                                joyX: breakJoyX,
                                joyY: altitude < 22 ? 0.48 : this.clamp(verticalBias * 0.15 + 0.22, -0.2, 0.45),
                                roll: this.clamp(breakJoyX * Math.PI / 4.5, -Math.PI / 4, Math.PI / 4),
                                weapon: 'gun',
                                queueAction: 'flare',
                                ready: true,
                                reason: 'Actual missile threat: flare before urban route/climb'
                            }, debugBase, [...tree, 'selected: defensiveFlare-preUrban'], 'defensiveFlare');
                        }

                        const earlyUrbanPressure =
                            urbanArenaMode &&
                            !lowAltitudeTacticalBan &&
                            !energyCritical &&
                            !self.stalled &&
                            !actualMissileThreat &&
                            !openingFox2Rush &&
                            !fox2PerchWindow &&
                            !(closeCombatUrbanDefer && !imminentBuildingHit) &&
                            !(closeContactUrbanDefer && !imminentBuildingHit) &&
                            (
                                coverInfo.collisionRisk === 'medium' ||
                                coverInfo.collisionRisk === 'high' ||
                                (!energyLow && this.isForwardBuildingPressure(coverInfo, 28, 40)) ||
                                (maskInfo.available && maskInfo.distance < 58 && !closeCombatUrbanDefer && distance > tuning.gunRange + 25)
                            );
                        if (earlyUrbanPressure) {
                            // T150: do not keep preemptive weave when escape already clear for fight.
                            const coverDistUrban = Number(coverInfo.distance);
                            const coverFwdUrban = Number(coverInfo.forwardDistance);
                            const aiMapUrbanClear =
                                !!(aiMapCtx.clearAbove || aiMapCtx.skyOpen) &&
                                !hardBuildingContact &&
                                Number.isFinite(coverDistUrban) &&
                                coverDistUrban >= 40 &&
                                !(Number.isFinite(coverFwdUrban) && coverFwdUrban > 0 && coverFwdUrban < 28);
                            if (
                                this.shouldHandoffEscapeToEngage(coverInfo, {
                                    altitude,
                                    forwardY: selfForward.y,
                                    hardContact: hardBuildingContact,
                                    aiMapClearAbove: aiMapCtx.clearAbove,
                                    aiMapSkyOpen: aiMapCtx.skyOpen
                                }) ||
                                aiMapUrbanClear
                            ) {
                                tree.push(
                                    `urbanCollision: deferred=${aiMapUrbanClear ? 'aiMapClearAbove' : 'engageHandoff'} risk=${coverInfo.collisionRisk || 'n/a'} dist=${Number.isFinite(coverDistUrban) ? coverDistUrban.toFixed(1) : 'n/a'} clear=${aiMapCtx.clearAbove ? 1 : 0}`
                                );
                            } else {
                            this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 4);
                            const routedEarly = this.pickUrbanRoute(teamId, urbanRouteCtx, debugBase, tree);
                            if (routedEarly) return routedEarly;
                            const wideTurn = coverInfo.distance > 20;
                            const preemptJoyX = this.clamp(urbanAvoidSide * (wideTurn ? 0.74 : 0.62), -0.82, 0.82);
                            return this.withDebug({
                                state: 'urbanPreemptiveAvoid',
                                statusText: `NPC: 城市提前繞行 ${debugBase.coverDistance}m`,
                                throttle: self.heat > 78 ? 3 : (wideTurn ? 3 : 4),
                                joyX: this.clamp(urbanAvoidSide * (wideTurn ? 0.74 : 0.62), -0.82, 0.82),
                                joyY: altitude < 28 ? 0.22 : (wideTurn ? 0.08 : 0.14),
                                roll: this.clamp(preemptJoyX * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Preempt medium urban collision risk before emergency distance'
                            }, debugBase, [...tree, 'selected: urbanPreemptiveAvoid'], 'urbanPreemptiveAvoid');
                            }
                        }

                        const obstacleLoopRisk = loopEval.loopTrap || energyLow || self.stalled || self.ap < 72;
                        if (
                            (coverInfo.collisionRisk === 'high' || (obstacleStressMode && coverInfo.collisionRisk === 'medium')) &&
                            !(closeCombatUrbanDefer && !imminentBuildingHit) &&
                            !(closeContactUrbanDefer && !imminentBuildingHit)
                        ) {
                            this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 5);
                            const routedCollision = this.pickUrbanRoute(teamId, urbanRouteCtx, debugBase, tree);
                            if (routedCollision) return routedCollision;
                            const lowAltitude = altitude < 18;
                            const disengage = obstacleLoopRisk || obstacleStressMode;
                            const escapeJoyX = disengage
                                ? this.clamp(urbanAvoidSide * (lowAltitude ? 0.22 : 0.42), -0.5, 0.5)
                                : this.clamp(urbanAvoidSide * 0.68, -0.75, 0.75);
                            const escapeJoyY = lowAltitude ? 0.52 : (disengage ? 0.34 : (energyLow ? 0.24 : 0.18));
                            const flareWhileEscape =
                                actualMissileThreat &&
                                canUseFlare &&
                                flareCooldownReady &&
                                !shouldSaveFlare &&
                                !lineOfSightBlocked &&
                                altitude >= 14;
                            return this.withDebug({
                                state: flareWhileEscape ? 'defensiveFlare' : (disengage ? 'obstacleDisengage' : 'collisionAvoid'),
                                statusText: flareWhileEscape
                                    ? `NPC: 避撞熱焰 ${debugBase.coverForwardDistance}m`
                                    : (disengage ? `NPC: 建築脫離 AP ${Math.floor(self.ap)}` : `NPC: 建築物避撞 ${debugBase.coverForwardDistance}m`),
                                throttle: self.heat > 78 ? 3 : (lowAltitude || energyLow ? 5 : 4),
                                joyX: escapeJoyX,
                                joyY: escapeJoyY,
                                pitchCmd: -maxPitchCmd * (lowAltitude ? 0.55 : 0.34),
                                roll: this.clamp(escapeJoyX * Math.PI / 6, -Math.PI / 9, Math.PI / 9),
                                weapon: 'gun',
                                queueAction: flareWhileEscape ? 'flare' : 'none',
                                ready: true,
                                reason: flareWhileEscape
                                    ? 'Actual missile threat: flare while collision-avoiding'
                                    : (disengage ? 'Disengage from obstacle instead of circling into stall' : 'Immediate building collision risk')
                            }, debugBase, [...tree, `selected: ${flareWhileEscape ? 'defensiveFlare-collisionEscape' : (disengage ? 'obstacleDisengage' : 'collisionAvoid')}`], flareWhileEscape ? 'defensiveFlare' : (disengage ? 'obstacleDisengage' : 'collisionAvoid'));
                        }

                        if (overrideMode === 'evade' && (self.ap < 85 || self.stalled || altitude < 12)) {
                            return this.withDebug({
                                state: 'manualEvadeRecover',
                                statusText: `NPC: 人工迴避-恢復能量 AP ${Math.floor(self.ap)}`,
                                throttle: self.heat > 75 ? 3 : 5,
                                joyX: this.clamp(breakSide * 0.25, -0.35, 0.35),
                                joyY: altitude < 18 ? 0.28 : 0,
                                roll: this.clamp(breakSide * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Manual evade would stall; recover energy first'
                            }, debugBase, [...tree, 'selected: manualEvadeRecover'], 'manualEvadeRecover');
                        }

                        if (overrideMode === 'evade') {
                            return this.withDebug({
                                state: 'manualEvade',
                                statusText: `NPC: 人工干預 EVADE`,
                                throttle: self.heat > 72 ? 3 : 4,
                                joyX: this.clamp(breakSide * 0.7, -0.8, 0.8),
                                joyY: altitude < 24 ? 0.35 : 0.08,
                                roll: this.clamp(breakSide * Math.PI / 5, -Math.PI / 5, Math.PI / 5),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Manual override energy-preserving evade'
                            }, debugBase, [...tree, 'selected: manualEvade'], 'manualEvade');
                        }

                        if (loopEval.loopTrap && coverInfo.collisionRisk !== 'high' && !groundRisk && !energyCritical && !offenseAssist.hardReacquireBoost) {
                            const antiLoopFlare = canUseFlare && flareCooldownReady && !lineOfSightBlocked && actualMissileThreat;
                            const antiJoyX = this.clamp(breakSide * 0.9, -1, 1);
                            const antiThr = this.pickThrottleForTurn(
                                self.heat > 76 ? 3 : 4,
                                antiJoyX,
                                { heat: self.heat || 0, ap: self.ap, lowAp: tuning.lowAp }
                            );
                            return this.withDebug({
                                state: 'antiLoopBreak',
                                statusText: `NPC: 脫離打圈 LOOP ${loopEval.loopCount}`,
                                throttle: antiThr,
                                joyX: antiJoyX,
                                joyY: altitude < 24 ? 0.28 : 0.08,
                                roll: this.clamp(breakSide * Math.PI / 4, -Math.PI / 4, Math.PI / 4),
                                weapon: hasArmedMissile ? 'missile' : 'gun',
                                queueAction: antiLoopFlare ? 'flare' : 'none',
                                ready: true,
                                reason: 'Break repetitive circle trap'
                            }, debugBase, [...tree, `selected: antiLoopBreak flare=${antiLoopFlare} thr=${antiThr}`], 'antiLoopBreak');
                        }
                return null;
            }],
            ['engagement', () => {
                // Safety net: if climb-out commitment somehow fell through earlier gates, honor it here.
                        // Soft: aiMap clear + past band — let engagement shoot/close instead (T150).
                        if (
                            navClimbOut.active &&
                            !!(aiMapCtx.clearAbove || aiMapCtx.skyOpen) &&
                            !hardBuildingContact &&
                            altitude >= (Number(tuning.combatBandMin) || 35) &&
                            altitudeLane.lane !== 'dirt' &&
                            coverInfo.collisionRisk !== 'high'
                        ) {
                            this.clearNavIntent(teamId);
                            navClimbOut.active = false;
                            tree.push(
                                `engagement: navClimbOut softCleared aiMap alt=${altitude.toFixed(1)} dist=${distance.toFixed(1)}`
                            );
                        }
                        if (
                            navClimbOut.active &&
                            !(actualMissileThreat && altitude >= 18 && (self.flareAmmo || 0) > 0)
                        ) {
                            const climbSide = navClimbOut.side || urbanAvoidSide || breakSide || 0;
                            return this.withDebug(
                                this.buildNavClimbOutAction({
                                    altitude,
                                    forwardY: selfForward.y,
                                    heat: self.heat || 0,
                                    side: climbSide,
                                    targetAlt: navClimbOut.targetAlt || tuning.combatBandMin || 35,
                                    maxPitchCmd,
                                    source: navClimbOut.source || 'engagementSafety',
                                    coverInfo
                                }),
                                debugBase,
                                [...tree, 'selected: postGroundClimbOut-engagementSafety'],
                                'postGroundClimbOut'
                            );
                        }
                const imminentMerge = distance < 42 && closureSpeed > 0.12;
                        const riskyHeadOn = distance < 95 && headOnFactor > 0.46 && predictedSeparation < 32;
                        const knifeMidair =
                            this.isCloseMidairThreat({
                                distance,
                                predictedSeparation,
                                headOnFactor,
                                closureSpeed
                            });
                        const mandatoryMergeBreak =
                            !lowAltitudeTacticalBan &&
                            coverInfo.collisionRisk !== 'high' &&
                            (
                                knifeMidair ||
                                (distance < 38 && predictedSeparation < 26) ||
                                (distance < 28 && closureSpeed > 0.1) ||
                                (headOnFactor > 0.55 && predictedSeparation < 22)
                            );
                        const forwardCommitWindow =
                            !lineOfSightBlocked &&
                            localToEnemy.z > 0.86 &&
                            angleToTarget < Math.PI / 8 &&
                            distance > 34 &&
                            distance < 62 &&
                            predictedSeparation > 28 &&
                            !riskyHeadOn &&
                            !knifeMidair &&
                            !energyCritical &&
                            !groundRisk;
                        const gunAngleRadEarly = (tuning.gunAngle * Math.PI / 180);
                        const preMergeEarlyGunWindow =
                            distance < tuning.gunRange + 10 &&
                            angleToTarget < gunAngleRadEarly &&
                            predictedSeparation > 14 &&
                            headOnFactor < 0.52;
                        const skipMergeForGun = forwardCommitWindow || (preMergeEarlyGunWindow && !riskyHeadOn && predictedSeparation > 20);
                        const openSkyOrbit = !urbanArenaMode && coverInfo.collisionRisk === 'low';
                        const orbitStalemate =
                            sensor.hasContact &&
                            !actualMissileThreat &&
                            distance > (openSkyOrbit ? 48 : 58) &&
                            distance < 190 &&
                            angleToTarget > ((openSkyOrbit ? 34 : 42) * Math.PI / 180) &&
                            // Co-orbit is beam/lag geometry. High head-on is a merge, not an orbit.
                            headOnFactor < (openSkyOrbit ? 0.62 : 0.55) &&
                            closureSpeed < (openSkyOrbit ? 0.12 : 0.09) &&
                            predictedSeparation > distance * (openSkyOrbit ? 0.82 : 0.9);
                        tree.push(`orbitGate: stalemate=${orbitStalemate} openSky=${openSkyOrbit ? 1 : 0} closure=${closureSpeed.toFixed(3)} sep=${predictedSeparation.toFixed(1)} headOn=${headOnFactor.toFixed(2)} navBlock=${navClimbOut.active ? 1 : 0}`);

                        // Missile envelope comes before orbit cut-in so FOX-2 can arm/lock instead of gun-only circling.
                        const missileAngleRadEarly = (tuning.missileAngle * Math.PI / 180);
                        const forceMissileOverride = overrideMode === 'missile' && hasAnyMissile;
                        const inMissileEnvelope =
                            hasAnyMissile &&
                            (forceMissileOverride || rangeMode === 'missile') &&
                            distance >= missileMinRange &&
                            distance <= Math.max(missileMaxRange, missileLockRange + 8) &&
                            angleToTarget < Math.PI * 0.55 &&
                            !lineOfSightBlocked &&
                            coverInfo.collisionRisk !== 'high' &&
                            !groundRisk &&
                            !energyCritical;
                        const earlyMissileLock =
                            hasArmedMissile &&
                            distance > 25 &&
                            distance <= missileLockRange &&
                            angleToTarget <= Math.max(missileLockAngle, missileAngleRadEarly) &&
                            localToEnemy.z > 0.72 &&
                            !lineOfSightBlocked;
                        // Front-aspect FOX-2 is weak, but do not ban all head-on shots outside knife-fight merge.
                        const frontAspectHardBan = headOnFactor > 0.62 && predictedSeparation < 28;
                        if (inMissileEnvelope && !frontAspectHardBan && (overrideMode === 'missile' || overrideMode === 'auto')) {
                            let shouldShootMissile = earlyMissileLock && !frontAspectHardBan;
                            const fox1Prep = aiMissileType === 'fox1';
                            let prepJoyX;
                            let prepJoyY;
                            if (fox1Prep) {
                                const foxLead = this.getGunLeadAim(
                                    teamId,
                                    selfPos,
                                    selfForward,
                                    trackedEnemyPos,
                                    trackedEnemyForward,
                                    self.ap || self.speed || 120,
                                    enemy.ap || enemy.speed || 120,
                                    liveSelf,
                                    assistedVelocity
                                );
                                prepJoyX = this.clamp(
                                    foxLead.horizontalBias * (shouldShootMissile ? 0.9 : 0.82) + horizontalBias * 0.2,
                                    -0.85,
                                    0.85
                                );
                                prepJoyY = this.clamp(
                                    foxLead.verticalBias * (shouldShootMissile ? 0.7 : 0.6) + verticalBias * 0.22,
                                    -0.45,
                                    0.55
                                );
                                if (selfPos.y < this.getFox1MinLaunchAlt({ arenaMode, urbanArenaMode })) {
                                    prepJoyY = Math.max(prepJoyY, 0.4);
                                }
                            } else {
                                prepJoyX = this.resolveTurnJoyX(
                                    horizontalBias * (shouldShootMissile ? 0.35 : 1.1),
                                    localToEnemy,
                                    angleToTargetDeg,
                                    urbanAvoidSide || breakSide,
                                    shouldShootMissile ? 0.28 : 0.7
                                );
                                prepJoyY = this.clamp(
                                    shouldShootMissile
                                        ? verticalBias * 0.22
                                        : (Math.abs(prepJoyX) > 0.7 ? Math.min(verticalBias * 0.25, 0.12) : verticalBias * 0.42),
                                    -0.28,
                                    0.32
                                );
                            }
                            const mslTag = aiMissileType === 'fox1' ? 'FOX-1' : 'FOX-2';
                            let earlyAction = this.withDebug({
                                state: shouldShootMissile ? 'missileAttack' : 'missilePrep',
                                statusText: shouldShootMissile
                                    ? `NPC: ${mslTag} LOCK ${Math.floor(distance)}m`
                                    : `NPC: ${mslTag} 通電/對準 ${Math.floor(distance)}m`,
                                throttle: self.heat > 72 ? 3 : 4,
                                joyX: prepJoyX,
                                joyY: prepJoyY,
                                roll: this.clamp(prepJoyX * (shouldShootMissile ? Math.PI / 8 : (fox1Prep ? Math.PI / 6 : Math.PI / 4)), -Math.PI / 4, Math.PI / 4),
                                weapon: 'missile',
                                powerPylons: !hasArmedMissile,
                                missileType: aiMissileType,
                                queueAction: shouldShootMissile ? 'missile' : 'none',
                                singleMissile: shouldShootMissile,
                                ready: true,
                                reason: shouldShootMissile
                                    ? 'Missile seeker lock in envelope'
                                    : 'Power pylons and nose toward target before orbit/gun logic'
                            }, debugBase, [...tree, `selected: ${shouldShootMissile ? 'missileAttack-early' : 'missilePrep-early'}`], shouldShootMissile ? 'missileAttack' : 'missilePrep');
                            if (fox1Prep && shouldShootMissile) {
                                earlyAction = this.gateFox1MissileShoot(teamId, liveSelf || self, earlyAction, {
                                    altitude: selfPos.y,
                                    angleDeg: angleToTargetDeg,
                                    distance,
                                    lineOfSightBlocked,
                                    localToEnemy,
                                    enemyPos: trackedEnemyPos,
                                    enemyForward: trackedEnemyForward,
                                    enemyAp: enemy.ap || enemy.speed || 120,
                                    selfForward,
                                    assistedVelocity,
                                    arenaMode,
                                    urbanArenaMode,
                                    aiMapSkyOpen: aiMapCtx.skyOpen,
                                    aiMapSarhPerch: aiMapCtx.sarhPerch,
                                    aiMapClearAbove: aiMapCtx.clearAbove
                                });
                            }
                            return earlyAction;
                        }

                        // 平时战术接近（n-step）：无紧急时取代裸 orbit/reacquire/searchIntercept。
                        const reliableGunWindow =
                            distance < tuning.gunRange + 6 &&
                            angleToTargetDeg < (tuning.gunAngle || 22) &&
                            localToEnemy.z > 0.72 &&
                            !lineOfSightBlocked;
                        const skipTacticalApproach =
                            navClimbOut.active ||
                            groundRisk ||
                            energyCritical ||
                            actualMissileThreat ||
                            mandatoryMergeBreak ||
                            knifeMidair ||
                            coverInfo.collisionRisk === 'high' ||
                            reliableGunWindow ||
                            (earlyMissileLock && !frontAspectHardBan);
                        const tapEligible =
                            sensor.hasContact || sensor.hasMemory || !!passiveSearchBearing;
                        const buildTapCtx = () => ({
                            sensorContact: !!sensor.hasContact,
                            sensorMemory: !!(sensor.hasMemory && !sensor.seenNow),
                            passiveSearch: !!passiveSearchBearing,
                            urbanArenaMode,
                            altitude,
                            coverInfo,
                            preferredSide: urbanAvoidSide || breakSide,
                            breakSide,
                            horizontalBias,
                            verticalBias,
                            forwardY: selfForward.y,
                            angleDeg: angleToTargetDeg,
                            distance,
                            headOnFactor,
                            energyLow,
                            energyCritical,
                            groundRisk,
                            actualMissileThreat,
                            mandatoryMergeBreak,
                            knifeMidair,
                            collisionRisk: coverInfo.collisionRisk,
                            navClimbOutActive: !!navClimbOut.active,
                            reliableShootWindow: reliableGunWindow,
                            turnNo
                        });
                        if (!skipTacticalApproach && tapEligible) {
                            const tap = this.pickTacticalApproach(teamId, buildTapCtx(), debugBase, tree);
                            if (tap) return tap;
                        } else {
                            tree.push(
                                `tacticalApproach: skipped=${skipTacticalApproach ? 1 : 0} eligible=${tapEligible ? 1 : 0} contact=${sensor.hasContact ? 1 : 0}`
                            );
                        }

                        if (orbitStalemate && coverInfo.collisionRisk !== 'high' && !groundRisk && !navClimbOut.active) {
                            const openSkyOrbitBoost = !urbanArenaMode && coverInfo.collisionRisk === 'low' ? 1.25 : 1.0;
                            const cutGain = (1.08 + tuning.interceptTurnGain * 0.35) * openSkyOrbitBoost;
                            const preferMissileCut = rangeMode === 'missile' && hasAnyMissile && distance > tuning.gunRange + 8;
                            const cutJoyX = this.resolveTurnJoyX(
                                horizontalBias * cutGain,
                                localToEnemy,
                                angleToTargetDeg,
                                urbanAvoidSide || breakSide,
                                openSkyOrbitBoost > 1.0 ? 0.88 : 0.72
                            );
                            const openSkyCutThrottle = !urbanArenaMode && self.heat < 62 && distance > 70 ? 5 : 4;
                            const orbitThr = this.pickThrottleForTurn(
                                self.heat > 72 ? 3 : (openSkyOrbitBoost > 1.0 ? openSkyCutThrottle : 4),
                                cutJoyX,
                                { heat: self.heat || 0, ap: self.ap, lowAp: tuning.lowAp }
                            );
                            return this.withDebug({
                                state: 'orbitCutIn',
                                statusText: openSkyOrbitBoost > 1.0 ? `NPC: 開闊空域強切 ${Math.floor(distance)}m` : `NPC: 切入接敵 ${Math.floor(distance)}m`,
                                throttle: orbitThr,
                                joyX: cutJoyX,
                                joyY: this.clamp(
                                    (Math.abs(cutJoyX) > 0.65 ? verticalBias * 0.28 : verticalBias * (openSkyOrbitBoost > 1.0 ? 0.72 : 0.55)) +
                                    (altitude < tuning.combatBandMin ? 0.12 : 0),
                                    -0.38,
                                    0.45
                                ),
                                roll: this.clamp(cutJoyX * (openSkyOrbitBoost > 1.0 ? Math.PI / 3.6 : Math.PI / 4), -Math.PI / 3.6, Math.PI / 3.6),
                                weapon: preferMissileCut ? 'missile' : 'gun',
                                powerPylons: preferMissileCut && !hasArmedMissile,
                                queueAction: openSkyOrbitBoost > 1.0 && distance < tuning.gunRange + 22 && angleToTargetDeg < 38 ? 'gun' : 'none',
                                ready: true,
                                reason: `Break co-orbit stalemate and force closure (openSkyBoost=${openSkyOrbitBoost.toFixed(2)}; energyTurn thr=${orbitThr})`
                            }, debugBase, [...tree, `selected: orbitCutIn openSkyBoost=${openSkyOrbitBoost.toFixed(2)} thr=${orbitThr}`], 'orbitCutIn');
                        }
                        const optionalMergeBreak =
                            coverInfo.collisionRisk !== 'high' &&
                            !lowAltitudeTacticalBan &&
                            !skipMergeForGun &&
                            (
                                (imminentMerge && headOnFactor > 0.5) ||
                                (riskyHeadOn && predictedSeparation < 22) ||
                                (predictedSeparation < 14 && headOnFactor > 0.48)
                            );
                        // FORCE MISSILE duel: hold through soft merges while still outside knife-fight; always break if about to hit.
                        const holdMissileThroughMerge =
                            forceMissileOverride &&
                            distance > 20 &&
                            predictedSeparation >= 10;
                        tree.push(`evadeGate: merge=${imminentMerge} headOn=${riskyHeadOn} mandatory=${mandatoryMergeBreak} sep=${predictedSeparation.toFixed(1)} commit=${forwardCommitWindow} earlyGun=${preMergeEarlyGunWindow} skipMerge=${skipMergeForGun} holdMsl=${holdMissileThroughMerge ? 1 : 0}`);
                        urbanRouteCtx.mandatoryMergeBreak = mandatoryMergeBreak;
                        // Soft urban must never steal the stick under inbound FOX-2 (merge break / flare handle survival).
                        const deferUrbanForMissile =
                            actualMissileThreat &&
                            !strictImminentBuilding;
                        if (deferUrbanForMissile) {
                            tree.push('urbanRouteGate: deferred=missileThreat');
                        } else if (closeContactUrbanDefer && !imminentBuildingHit) {
                            tree.push('urbanRouteGate: deferred=closeContact');
                        } else if (!(closeCombatUrbanDefer && !imminentBuildingHit)) {
                            const urbanRoute = this.pickUrbanRoute(teamId, urbanRouteCtx, debugBase, tree);
                            if (urbanRoute) return urbanRoute;
                        } else {
                            tree.push('urbanRouteGate: deferred=closeCombat');
                        }

                        // Offensive weave before merge/reacquire: mid-fight lane must beat gun/hard turn-ins.
                        // Side/behind clutter (fwd<=0) counts as a lateral lane; close nose-on buildings (0<fwd<=16) do not.
                        const sideLanePressure = this.isSideLanePressure(coverInfo, urbanArenaMode);
                        const coverFwd = Number(coverInfo.forwardDistance);
                        const sideOrClearLane =
                            !Number.isFinite(coverFwd) ||
                            coverFwd <= 0 ||
                            coverFwd > 16;
                        const mediumLane =
                            coverInfo.collisionRisk === 'medium' &&
                            Number(coverInfo.distance) >= 10 &&
                            Number(coverInfo.distance) <= 40 &&
                            sideOrClearLane;
                        const weaveCombatBand =
                            distance > 16 &&
                            distance < Math.max(tuning.gunRange + 22, missileMaxRange);
                        const offensiveWeaveWindow =
                            urbanArenaMode &&
                            !actualMissileThreat &&
                            !missileThreatEvade &&
                            overrideMode !== 'gun' &&
                            overrideMode !== 'missile' &&
                            !energyCritical &&
                            !self.stalled &&
                            altitude >= 28 &&
                            weaveCombatBand &&
                            (mediumLane || sideLanePressure || !!coverInfo.corridorClear) &&
                            (
                                sideLanePressure ||
                                !!coverInfo.corridorClear ||
                                angleToTargetDeg > 40 ||
                                headOnFactor > 0.62 ||
                                coverFwd <= 0 ||
                                (maskInfo.available && Number(maskInfo.score) >= 60)
                            );
                        tree.push(`weaveGate: window=${offensiveWeaveWindow ? 1 : 0} sideLane=${sideLanePressure ? 1 : 0} corridor=${coverInfo.corridorClear ? 1 : 0} cover=${Number.isFinite(Number(coverInfo.distance)) ? Number(coverInfo.distance).toFixed(1) : '-'} fwd=${Number.isFinite(coverFwd) ? coverFwd.toFixed(1) : '-'}`);
                        // Score-driven planner: accept climb/cruise/side/weave winner — do not hard-require weave.
                        if (offensiveWeaveWindow && !mandatoryMergeBreak) {
                            this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 4);
                            const routedWeave = this.pickUrbanRoute(teamId, urbanRouteCtx, debugBase, tree);
                            if (routedWeave) {
                                const src = (routedWeave.urbanRoute && routedWeave.urbanRoute.source) || routedWeave.state;
                                if (routedWeave.debug && Array.isArray(routedWeave.debug.tree)) {
                                    routedWeave.debug.tree.push(`weaveGate: acceptPlanner src=${src}`);
                                } else {
                                    tree.push(`weaveGate: acceptPlanner src=${src}`);
                                }
                                return routedWeave;
                            }
                            const climbLane = this.getUrbanAltitudeLane(altitude, coverInfo, tuning, {
                                energyBad: energyLow || energyCritical,
                                stalled: !!self.stalled,
                                ap: self.ap,
                                denseUrban: this.isDenseUrbanContext(arenaMode, this.getObstacles())
                            });
                            // Soft fallback only when planner null and climb is not the score preference.
                            if (
                                !climbLane.preferStraightClimb &&
                                !climbLane.preferRoofExit &&
                                (sideLanePressure || coverFwd <= 0 || !Number.isFinite(coverFwd)) &&
                                Number(coverInfo.distance) >= 14
                            ) {
                                const weaveJoyX = this.clamp(urbanAvoidSide * 0.42, -0.55, 0.55);
                                return this.withDebug({
                                    state: 'urbanBuildingWeave',
                                    statusText: `NPC: 側向建築穿梭 ${Math.floor(Number(coverInfo.distance))}m`,
                                    throttle: self.heat > 78 ? 3 : 4,
                                    joyX: weaveJoyX,
                                    joyY: altitude < 30 ? 0.18 : 0.05,
                                    roll: this.clamp(weaveJoyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
                                    weapon: 'gun',
                                    queueAction: 'none',
                                    ready: true,
                                    reason: 'Side-building lane weave before merge/reacquire'
                                }, debugBase, [...tree, 'selected: urbanBuildingWeave-side'], 'urbanBuildingWeave');
                            }
                            tree.push(
                                climbLane.preferStraightClimb || climbLane.preferRoofExit
                                    ? 'weaveGate: deferred=climbScorePreferred'
                                    : 'weaveGate: deferred=plannerNull'
                            );
                        }

                        if ((mandatoryMergeBreak || optionalMergeBreak) && !holdMissileThroughMerge) {
                            const hardBreak = mandatoryMergeBreak || distance < 28 || knifeMidair;
                            const flareOnMerge =
                                actualMissileThreat &&
                                canUseFlare &&
                                flareCooldownReady &&
                                !shouldSaveFlare &&
                                altitude >= 14 &&
                                distance > 10;
                            const mergeSide = this.getMidairDivergeSide({
                                localToEnemy,
                                breakSide: urbanAvoidSide || breakSide,
                                teamId
                            });
                            const mergeJoyX = this.clamp(mergeSide * (hardBreak ? 0.95 : 0.72), -1, 1);
                            const mergeThr = this.pickThrottleForTurn(
                                self.heat > 76 ? 3 : 4,
                                mergeJoyX,
                                { heat: self.heat || 0, ap: self.ap, lowAp: tuning.lowAp }
                            );
                            return this.withDebug({
                                state: flareOnMerge ? 'defensiveFlare' : (hardBreak ? 'mandatoryMergeBreak' : 'mergeBreak'),
                                statusText: flareOnMerge
                                    ? `NPC: 迎頭熱焰脫離 ${Math.floor(distance)}m`
                                    : (knifeMidair
                                        ? `NPC: 近距避撞 ${Math.floor(distance)}m`
                                        : `NPC: 迎頭避撞 ${Math.floor(distance)}m`),
                                throttle: mergeThr,
                                joyX: mergeJoyX,
                                joyY: altitude < 24 ? 0.34 : (hardBreak ? 0.12 : 0.04),
                                roll: this.clamp(mergeSide * (hardBreak ? Math.PI / 4 : Math.PI / 5), -Math.PI / 4, Math.PI / 5),
                                weapon: 'gun',
                                queueAction: flareOnMerge ? 'flare' : 'none',
                                ready: true,
                                reason: flareOnMerge
                                    ? 'Merge break with flare under actual missile threat'
                                    : (hardBreak ? 'Mandatory deconfliction before head-on collision' : 'Break merge before missile tactics')
                            }, debugBase, [...tree, `selected: ${flareOnMerge ? 'defensiveFlare-merge' : (hardBreak ? 'mandatoryMergeBreak' : 'mergeBreak')} thr=${mergeThr} side=${mergeSide}`], flareOnMerge ? 'defensiveFlare' : (hardBreak ? 'mandatoryMergeBreak' : 'mergeBreak'));
                        }

                        // Survival first — Phase A: ECO turn while rebuilding energy (no AB + joyX freeze).
                        if (self.ap < 65 || self.stalled || altitude < 5) {
                            const recoverJoyX = this.clamp(horizontalBias * 0.52, -0.58, 0.58);
                            const recoverThr = this.pickThrottleForTurn(
                                3,
                                recoverJoyX,
                                {
                                    heat: self.heat || 0,
                                    ap: self.ap,
                                    energyCritical: self.ap < tuning.energyCriticalAp,
                                    stalled: !!self.stalled,
                                    lowAp: tuning.lowAp
                                }
                            );
                            return this.withDebug({
                                state: 'recover',
                                statusText: `NPC: 能量ECO恢復 AP ${Math.floor(self.ap)}`,
                                throttle: recoverThr,
                                joyX: recoverJoyX,
                                joyY: altitude < 18 ? 0.28 : -0.05,
                                roll: this.clamp(recoverJoyX * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Recover speed/altitude with ECO turn authority (Phase A)'
                            }, debugBase, [...tree, `selected: recover thr=${recoverThr} joyX=${recoverJoyX.toFixed(2)}`], 'recover');
                        }

                        if (self.heat > 82) {
                            return this.withDebug({
                                state: 'cooldown',
                                statusText: `NPC: 降溫 ${Math.floor(self.heat)}°C`,
                                throttle: 2,
                                joyX: this.clamp(horizontalBias * 0.45, -0.55, 0.55),
                                joyY: verticalBias,
                                roll,
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Cool engine'
                            }, debugBase, [...tree, 'selected: cooldown'], 'cooldown');
                        }

                        const reacquireCombatBand =
                            distance > 16 &&
                            distance < Math.max(tuning.gunRange + 22, missileMaxRange);
                        const yieldReacquireForLane = sideLanePressure && reacquireCombatBand;
                        const navBlocksReacquire = !!navClimbOut.active;
                        const reacquireHardNeeded = !actualMissileThreat &&
                            !navBlocksReacquire &&
                            coverInfo.collisionRisk === 'low' &&
                            !yieldReacquireForLane &&
                            !groundRisk &&
                            !energyCritical &&
                            angleToTarget > (offenseAssist.hardReacquireBoost ? Math.PI / 4.5 : Math.PI / 3);
                        const reacquireSoftGun =
                            !actualMissileThreat &&
                            !navBlocksReacquire &&
                            coverInfo.collisionRisk === 'low' &&
                            !yieldReacquireForLane &&
                            !groundRisk &&
                            !energyCritical &&
                            angleToTarget > Math.PI / 4 &&
                            angleToTarget <= Math.PI / 3 &&
                            distance < tuning.gunRange + 15 &&
                            angleToTarget < ((tuning.gunAngle * Math.PI / 180)) &&
                            predictedSeparation > 14;
                        tree.push(`reacquireGate: hard=${reacquireHardNeeded} softGun=${reacquireSoftGun} yieldLane=${yieldReacquireForLane ? 1 : 0} forceMsl=${forceMissileOverride ? 1 : 0} navBlock=${navBlocksReacquire ? 1 : 0} localX=${debugBase.targetLocalX} localY=${debugBase.targetLocalY} localZ=${debugBase.targetLocalZ}`);
                        // Soft gun reacquire must not steal FORCE MISSILE duels.
                        if (reacquireSoftGun && !forceMissileOverride) {
                            const softLead = this.getGunLeadAim(
                                teamId,
                                selfPos,
                                selfForward,
                                trackedEnemyPos,
                                trackedEnemyForward,
                                self.ap || self.speed || 120,
                                enemy.ap || enemy.speed || 120,
                                liveSelf,
                                assistedVelocity
                            );
                            const softJoyX = this.clamp(softLead.horizontalBias * 0.85 + horizontalBias * 0.25, -0.9, 0.9);
                            return this.withDebug({
                                state: 'gunAttack',
                                statusText: `NPC: 偏航追瞄 ${Math.floor(angleToTarget * 180 / Math.PI)}°`,
                                throttle: distance < 24 ? 2 : 3,
                                joyX: softJoyX,
                                joyY: this.clamp(softLead.verticalBias * 0.55 + verticalBias * 0.2, -0.3, 0.4),
                                roll: this.clamp(softJoyX * Math.PI / 5, -Math.PI / 5, Math.PI / 5),
                                weapon: 'gun',
                                queueAction: 'gun',
                                ready: true,
                                reason: `Close reacquire with gun lead ${softLead.leadTurns}T`
                            }, debugBase, [...tree, 'selected: gunAttack-softReacquire'], 'gunAttack');
                        }
                        const notClosing = closureSpeed < 0.08 && distance > 50;
                        if (reacquireHardNeeded) {
                            const behindTarget = localToEnemy.z < 0.12 || angleToTargetDeg > 100;
                            const reacquireGain = 1.25 + (notClosing ? 0.18 : 0) + (passiveSearchBearing ? 0.12 : 0) + (behindTarget ? 0.2 : 0) + (offenseAssist.hardReacquireBoost ? 0.28 : 0);
                            const reacquireJoyX = this.resolveTurnJoyX(
                                horizontalBias * reacquireGain,
                                localToEnemy,
                                angleToTargetDeg,
                                urbanAvoidSide || breakSide,
                                behindTarget ? 0.9 : 0.7
                            );
                            const reacquireJoyY = this.capCombatVerticalJoy(
                                altitude < 24
                                    ? 0.25
                                    : this.clamp(
                                        behindTarget
                                            ? Math.min(verticalBias * 0.25, 0.08)
                                            : verticalBias * (notClosing ? 0.52 : 0.45),
                                        -0.2,
                                        0.32
                                    ),
                                altitude,
                                selfForward.y,
                                tuning,
                                sensor.hasContact
                            );
                            // FORCE MISSILE: keep missile prep/attack intent while turning back — do not drop into bare reacquire.
                            if (forceMissileOverride) {
                                const forceShoot =
                                    hasArmedMissile &&
                                    (missileLock ||
                                        (distance >= missileMinRange &&
                                            distance <= Math.max(missileMaxRange, missileLockRange + 8) &&
                                            angleToTarget <= Math.max(missileAngleRadEarly, missileLockAngle) &&
                                            localToEnemy.z > 0.55 &&
                                            !lineOfSightBlocked));
                                return this.withDebug({
                                    state: forceShoot ? 'missileAttack' : 'missilePrep',
                                    statusText: forceShoot
                                        ? `NPC: 人工 FOX-2 LOCK`
                                        : `NPC: 人工飛彈回轉 ${Math.floor(angleToTargetDeg)}°`,
                                    throttle: distance > 120 ? (self.heat > 72 ? 4 : 5) : (behindTarget ? 4 : 3),
                                    joyX: reacquireJoyX,
                                    joyY: reacquireJoyY,
                                    roll: this.clamp(reacquireJoyX * Math.PI / 4, -Math.PI / 4, Math.PI / 4),
                                    weapon: 'missile',
                                    powerPylons: !hasArmedMissile,
                                missileType: aiMissileType,
                                    queueAction: forceShoot ? 'missile' : 'none',
                                    singleMissile: forceShoot,
                                    ready: true,
                                    reason: forceShoot
                                        ? 'FORCE MISSILE lock while recovering aspect'
                                        : 'FORCE MISSILE turn-back with pylons powered'
                                }, debugBase, [...tree, `selected: ${forceShoot ? 'missileAttack-forceReacquire' : 'missilePrep-forceReacquire'}`], forceShoot ? 'missileAttack' : 'missilePrep');
                            }
                            // Prefer n-step tactical approach over bare searchIntercept/reacquire (T112).
                            if (!skipTacticalApproach && tapEligible) {
                                const tapReacq = this.pickTacticalApproach(teamId, buildTapCtx(), debugBase, tree);
                                if (tapReacq) {
                                    tree.push('tacticalApproach: preferOverReacquire=1');
                                    return tapReacq;
                                }
                            }
                            return this.withDebug({
                                state: passiveSearchBearing ? 'searchIntercept' : 'reacquire',
                                statusText: passiveSearchBearing
                                    ? `NPC: 搜索接敵 ${Math.floor(distance)}m`
                                    : `NPC: 重新索敵 ${Math.floor(angleToTarget * 180 / Math.PI)}°`,
                                throttle: distance > 120 ? (self.heat > 72 ? 4 : 5) : (behindTarget ? 4 : 3),
                                joyX: reacquireJoyX,
                                joyY: reacquireJoyY,
                                roll: this.clamp(reacquireJoyX * Math.PI / 4, -Math.PI / 4, Math.PI / 4),
                                weapon: hasAnyMissile ? 'missile' : 'gun',
                                powerPylons: hasAnyMissile && !hasArmedMissile,
                                queueAction: 'none',
                                ready: true,
                                reason: passiveSearchBearing
                                    ? 'No sensor contact; steer toward threat bearing to enter radar envelope'
                                    : (behindTarget
                                        ? 'Hard reverse turn toward target behind the aircraft'
                                        : 'Turn back toward target before weapon selection')
                            }, debugBase, [...tree, `selected: ${passiveSearchBearing ? 'searchIntercept' : 'reacquire'}`], passiveSearchBearing ? 'searchIntercept' : 'reacquire');
                        }

                        if (!sensor.seenNow && sensor.hasMemory && coverInfo.collisionRisk !== 'high') {
                            return this.withDebug({
                                state: 'memoryTrack',
                                statusText: `NPC: 記憶追蹤 ${sensor.memoryTurnsLeft}T`,
                                throttle: self.heat > 72 ? 3 : 4,
                                joyX: this.clamp(horizontalBias * 0.85, -0.8, 0.8),
                                joyY: altitude < 24 ? 0.2 : this.clamp(verticalBias * 0.3, -0.2, 0.22),
                                roll: this.clamp(horizontalBias * Math.PI / 5, -Math.PI / 5, Math.PI / 5),
                                weapon: hasAnyMissile ? 'missile' : 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Advance to last known target position'
                            }, debugBase, [...tree, 'selected: memoryTrack'], 'memoryTrack');
                        }

                        const canOffensiveCommit =
                            !actualMissileThreat &&
                            !shouldFlareNow &&
                            !shouldChaffNow &&
                            !lineOfSightBlocked &&
                            localToEnemy.z > (distance < tuning.gunRange + 12 ? 0.84 : 0.88) &&
                            angleToTarget < (distance < tuning.gunRange + 12 ? Math.PI / 7 : Math.PI / 9) &&
                            distance < (distance < tuning.gunRange + 12 ? tuning.gunRange + 15 : 65);
                        tree.push(`missileThreat: active=${enemyMissileInFlight} queued=${enemyMissileQueued} ready=${enemyMissileReady} LOS=${lineOfSightBlocked} level=${threatLevel} score=${threatScore.toFixed(2)} evade=${missileThreatEvade} flare=${flareAmmoNow} chaff=${chaffAmmoNow} flareNow=${shouldFlareNow ? 1 : 0} chaffNow=${shouldChaffNow ? 1 : 0} paint=${underSarhPaintNow ? 1 : 0} inF1=${inboundFox1 ? 1 : 0} inF2=${inboundFox2 ? 1 : 0} commit=${canOffensiveCommit}`);
                        if ((missileThreatEvade || shouldChaffNow || underSarhPaintNow) && !canOffensiveCommit) {
                            const cmNow = shouldChaffNow || shouldFlareNow;
                            const useMaskPoint = maskUsable && !cmNow && (flareAmmoNow > 0 || chaffAmmoNow > 0);
                            const maskState = maskInfo.masked ? 'maskedHold' : maskInfo.state;
                            const maskDirection = maskInfo.direction;
                            const maskJoyX = maskDirection ? this.clamp(maskDirection.x * (maskState === 'maskIngress' ? 0.95 : 0.55), -0.8, 0.8) : this.clamp(horizontalBias * 0.2, -0.35, 0.35);
                            const maskJoyY = maskDirection ? this.clamp(maskDirection.y * 0.35, -0.3, 0.3) : this.clamp(verticalBias * 0.18 + 0.1, -0.3, 0.3);
                            // Empty CM + inbound: hard lateral break (typed — fox1 prefers beam without IR dump).
                            const emptyCmPanic = actualMissileThreat && !canUseFlare && !canUseChaff;
                            const panicSide = urbanAvoidSide || breakSide;
                            const beamForSarh = shouldChaffNow || inboundFox1 || underSarhPaintNow;
                            const evadeJoyX = useMaskPoint
                                ? maskJoyX
                                : (emptyCmPanic
                                    ? this.clamp((-horizontalBias * 0.25) + (0.95 * panicSide), -1, 1)
                                    : (beamForSarh
                                        ? this.clamp((-horizontalBias * 0.35) + (0.72 * (urbanAvoidSide || breakSide)), -1, 1)
                                        : this.clamp((-horizontalBias * 0.85) + (0.45 * breakSide), -1, 1)));
                            const evadeJoyY = useMaskPoint
                                ? maskJoyY
                                : (emptyCmPanic
                                    ? (steepClimb || selfForward.y > 0.35
                                        ? -0.22
                                        : (altitude < 20 ? 0.42 : 0.12))
                                    : (altitude < 14 ? 0.6 : this.clamp(verticalBias * 0.2 + 0.25, -0.25, 0.55)));
                            const cmState = shouldChaffNow ? 'defensiveChaff' : (shouldFlareNow ? 'defensiveFlare' : (useMaskPoint ? maskState : 'evade'));
                            const cmQueue = shouldChaffNow ? 'chaff' : (shouldFlareNow ? 'flare' : 'none');
                            return this.withDebug({
                                state: cmState,
                                statusText: shouldChaffNow
                                    ? `NPC: 雷達威脅，釋放箔條`
                                    : (shouldFlareNow
                                        ? `NPC: 飛彈威脅，釋放熱焰`
                                        : (useMaskPoint
                                            ? (maskState === 'maskIngress' ? 'NPC: 前往遮蔽點' : (maskState === 'maskedHold' ? 'NPC: 保持遮蔽' : 'NPC: 轉入遮蔽點'))
                                            : (emptyCmPanic ? 'NPC: 無干擾硬脫離' : 'NPC: 飛彈威脅，急轉規避'))),
                                throttle: useMaskPoint
                                    ? (maskState === 'maskIngress' ? 4 : 3)
                                    : (emptyCmPanic ? (self.heat > 78 ? 3 : 4) : (self.heat > 70 ? 3 : 4)),
                                joyX: evadeJoyX,
                                joyY: evadeJoyY,
                                roll: useMaskPoint
                                    ? this.clamp(maskJoyX * Math.PI / 4, -Math.PI / 4, Math.PI / 4)
                                    : this.clamp(evadeJoyX * Math.PI / 3.6, -Math.PI / 3.6, Math.PI / 3.6),
                                weapon: hasArmedMissile ? 'missile' : 'gun',
                                queueAction: cmQueue,
                                ready: true,
                                reason: emptyCmPanic
                                    ? 'No CM left: hard break away from inbound missile'
                                    : (shouldChaffNow
                                        ? 'Inbound SARH / radar paint: chaff + beam'
                                        : (shouldFlareNow ? 'Inbound IR: flare break' : 'Likely incoming missile'))
                            }, debugBase, [...tree, `selected: ${shouldChaffNow ? 'defensiveChaff' : (shouldFlareNow ? 'defensiveFlare' : (useMaskPoint ? maskState : (emptyCmPanic ? 'evadeEmptyCm' : 'evadeNoCm')))}`], shouldChaffNow ? 'defensiveChaff' : (shouldFlareNow ? 'defensiveFlare' : (useMaskPoint ? maskState : 'evade')));
                        }

                        const stealthAdvanceWindow = !openingFox2Rush && enemyMissileReady && maskUsable && maskCoverAllowed && distance > 55 && distance < 160 && !actualMissileThreat;
                        tree.push(`stealthAdvance: enemyMsl=${enemyMissileReady} maskUsable=${maskUsable} window=${stealthAdvanceWindow}`);
                        if (stealthAdvanceWindow) {
                            const maskState = maskInfo.masked ? 'maskedHold' : maskInfo.state;
                            const maskJoyX = this.clamp(maskInfo.direction.x * (maskState === 'maskIngress' ? 0.9 : 0.55), -0.75, 0.75);
                            const maskJoyY = this.clamp(maskInfo.direction.y * 0.25, -0.25, 0.25);
                            return this.withDebug({
                                state: maskState,
                                statusText: maskState === 'maskIngress' ? 'NPC: 隱蔽前進' : (maskState === 'maskedHold' ? 'NPC: 遮蔽保持' : 'NPC: 進入遮蔽角'),
                                throttle: maskState === 'maskIngress' ? 4 : 3,
                                joyX: maskJoyX,
                                joyY: maskJoyY,
                                roll: this.clamp(maskJoyX * Math.PI / 4, -Math.PI / 4, Math.PI / 4),
                                weapon: 'gun',
                                queueAction: 'none',
                                ready: true,
                                reason: 'Advance under building mask'
                            }, debugBase, [...tree, `selected: ${maskState}`], maskState);
                        }

                        const gunAngleRad = (tuning.gunAngle * Math.PI / 180);
                        const openSkyGunBonus = !urbanArenaMode && coverInfo.collisionRisk === 'low' ? 1.35 : 1.0;
                        const openSkyAngleBonus = !urbanArenaMode && coverInfo.collisionRisk === 'low' ? 1.7 : 1.0;
                        const assistGunRange = tuning.gunRange * openSkyGunBonus * offenseAssist.gunRangeMul;
                        const assistGunAngle = gunAngleRad * openSkyAngleBonus * offenseAssist.gunAngleMul;
                        const gunWindow = distance < assistGunRange && angleToTarget < assistGunAngle && predictedSeparation > 4 && headOnFactor < 0.78;
                        const earlyGunWindow = (!urbanArenaMode || offenseAssist.earlyGunInUrban) &&
                            distance < tuning.gunRange + (offenseAssist.earlyGunInUrban ? 36 : 28) &&
                            angleToTarget < assistGunAngle &&
                            predictedSeparation > 2 &&
                            headOnFactor < 0.78 &&
                            coverInfo.collisionRisk === 'low';
                        const closeDogfight = distance < (tuning.gunRange + 10);
                        const gunLead = (gunWindow || closeDogfight || earlyGunWindow || overrideMode === 'gun')
                            ? this.getGunLeadAim(
                                teamId,
                                selfPos,
                                selfForward,
                                trackedEnemyPos,
                                trackedEnemyForward,
                                self.ap || self.speed || 120,
                                enemy.ap || enemy.speed || 120,
                                liveSelf,
                                assistedVelocity
                            )
                            : null;
                        const gunJoyX = gunLead
                            ? this.clamp(gunLead.horizontalBias * (earlyGunWindow ? 0.85 : 0.92) + horizontalBias * (earlyGunWindow ? 0.3 : 0.18), -0.9, 0.9)
                            : this.clamp(horizontalBias * 0.42, -0.55, 0.55);
                        const gunJoyY = gunLead
                            ? this.clamp(gunLead.verticalBias * (earlyGunWindow ? 0.6 : 0.7) + verticalBias * (earlyGunWindow ? 0.3 : 0.2), -0.5, 0.55)
                            : this.clamp(verticalBias * 0.35, -0.25, 0.35);
                        const missileAngleRad = (tuning.missileAngle * Math.PI / 180);
                        const openSkyMissileBonus = !urbanArenaMode && coverInfo.collisionRisk === 'low' ? 1.5 : 1.0;
                        const frontAspectPenalty = headOnFactor > 0.82 && predictedSeparation < 28;
                        const missilePrepWindow = hasAnyMissile && !hasArmedMissile && distance >= missileMinRange && distance < (missileMaxRange + (!urbanArenaMode && coverInfo.collisionRisk === 'low' ? 90 : 65)) && angleToTarget < (!urbanArenaMode && coverInfo.collisionRisk === 'low' ? Math.PI * 0.55 : Math.PI / 2) && (forceMissileOverride || rangeMode === 'missile');
                        const extendedMissileAttack = hasArmedMissile && !urbanArenaMode && coverInfo.collisionRisk === 'low' && !frontAspectPenalty &&
                            distance >= missileMinRange && distance <= Math.min(missileMaxRange, missileLockRange + 28) &&
                            angleToTarget <= Math.max(missileAngleRad * 1.6, missileLockAngle * 1.25) && localToEnemy.z > 0.55 && !lineOfSightBlocked;
                        const missileAttackWindow = (hasArmedMissile && missileLock && !frontAspectPenalty && distance >= missileMinRange && distance <= Math.min(missileMaxRange, missileLockRange + 8) && angleToTarget <= Math.max(missileAngleRad * 1.25, missileLockAngle * 1.1)) || extendedMissileAttack;
                        const gunAttackActive = (overrideMode === 'gun') || gunWindow || (earlyGunWindow && !missileThreatEvade && !missilePrepWindow);
                        tree.push(`gunGate: window=${gunWindow} close=${closeDogfight} earlyGun=${earlyGunWindow} openSkyBonus=${openSkyGunBonus.toFixed(2)} override=${overrideMode === 'gun'} lead=${gunLead ? gunLead.leadTurns : 'n/a'} active=${gunAttackActive}`);
                        if (overrideMode !== 'missile' && !mandatoryMergeBreak && (rangeMode === 'gun' || gunAttackActive || closeDogfight)) {
                            const forcedGun = overrideMode === 'gun';
                            const extendedGun = earlyGunWindow;
                            const closeIn = closeDogfight && distance < tuning.gunRange - 4;
                            const gunThrottle =
                                distance < 22 ? 2 :
                                closeIn ? 3 :
                                forcedGun || extendedGun ? (!urbanArenaMode && coverInfo.collisionRisk === 'low' && self.heat < 62 && distance > 45 ? 5 : 4) : 3;
                            const rollScale = forcedGun ? Math.PI / 5.2 : (extendedGun ? Math.PI / 4.5 : Math.PI / 5);
                            const gunLabel = forcedGun
                                ? 'NPC: 人工干預 GUN'
                                : (extendedGun ? `NPC: 開闊空域機砲 ${Math.floor(distance)}m` : `NPC: 近戰機砲 ${Math.floor(distance)}m`);
                            const gunReason = gunLead
                                ? `Gun attack with LCOS lead ${gunLead.leadTurns}T${extendedGun ? ' (open-sky extended)' : ''}${forcedGun ? ' [override]' : ''}`
                                : (forcedGun ? 'Manual gun override' : 'Dogfight range prefers gun');
                            return this.withDebug({
                                state: 'gunAttack',
                                statusText: gunLabel,
                                throttle: gunThrottle,
                                joyX: gunJoyX,
                                joyY: gunJoyY,
                                roll: this.clamp(gunJoyX * rollScale, -rollScale, rollScale),
                                weapon: 'gun',
                                queueAction: 'gun',
                                ready: true,
                                reason: gunReason
                            }, debugBase, [...tree, `selected: gunAttack-${forcedGun ? 'override' : (extendedGun ? 'earlyOpenSky' : (closeIn ? 'close' : 'range'))}`], 'gunAttack');
                        }

                        tree.push(`missileGate: any=${hasAnyMissile} lock=${missileLock} prep=${missilePrepWindow} attack=${missileAttackWindow} extAttack=${extendedMissileAttack} frontPenalty=${frontAspectPenalty} armed=${hasArmedMissile} openSkyBonus=${openSkyMissileBonus.toFixed(2)} dist=${distance.toFixed(1)} ang=${(angleToTarget * 180 / Math.PI).toFixed(1)}`);

                        if ((overrideMode === 'missile' || missilePrepWindow || missileAttackWindow) && hasAnyMissile) {
                            const forcedMissile = overrideMode === 'missile';
                            const shouldShootMissile = hasArmedMissile && (forcedMissile ? (missileLock || extendedMissileAttack) : missileAttackWindow);
                            const fox1Prep = aiMissileType === 'fox1';
                            let mslJoyX;
                            let mslJoyY;
                            if (fox1Prep) {
                                const foxLead = this.getGunLeadAim(
                                    teamId,
                                    selfPos,
                                    selfForward,
                                    trackedEnemyPos,
                                    trackedEnemyForward,
                                    self.ap || self.speed || 120,
                                    enemy.ap || enemy.speed || 120,
                                    liveSelf,
                                    assistedVelocity
                                );
                                mslJoyX = this.clamp(
                                    foxLead.horizontalBias * (shouldShootMissile ? 0.9 : 0.82) + horizontalBias * 0.18,
                                    -0.9,
                                    0.9
                                );
                                mslJoyY = this.clamp(
                                    foxLead.verticalBias * (shouldShootMissile ? 0.7 : 0.6) + verticalBias * 0.2,
                                    -0.5,
                                    0.55
                                );
                                if (altitude < this.getFox1MinLaunchAlt({ arenaMode, urbanArenaMode })) {
                                    mslJoyY = Math.max(mslJoyY, 0.4);
                                }
                            } else {
                                mslJoyX = this.resolveTurnJoyX(
                                    horizontalBias * (shouldShootMissile ? 0.28 : 1.05),
                                    localToEnemy,
                                    angleToTargetDeg,
                                    urbanAvoidSide || breakSide,
                                    shouldShootMissile ? 0.22 : 0.65
                                );
                                mslJoyY = shouldShootMissile
                                    ? this.clamp(verticalBias * 0.2, -0.18, 0.22)
                                    : this.clamp(Math.abs(mslJoyX) > 0.7 ? Math.min(verticalBias * 0.22, 0.1) : verticalBias * 0.4, -0.25, 0.3);
                            }
                            const openSkyMsl = !urbanArenaMode && coverInfo.collisionRisk === 'low';
                            const mslThrottle =
                                self.heat > (openSkyMsl ? 76 : 68) ? 3 :
                                shouldShootMissile ? 3 :
                                (openSkyMsl && self.heat < 60 && distance > 55 ? 5 : 4);
                            const mslTag = aiMissileType === 'fox1' ? 'FOX-1' : 'FOX-2';
                            const mslStatus = forcedMissile
                                ? (shouldShootMissile ? `NPC: 人工 ${mslTag} LOCK` : `NPC: 人工飛彈對準中`)
                                : (shouldShootMissile ? (extendedMissileAttack ? `NPC: ${mslTag} 開闊窗口 ${Math.floor(distance)}m` : `NPC: ${mslTag} LOCK ${Math.floor(distance)}m`) : `NPC: ${mslTag} 通電/保持角度`);
                            const mslReason = shouldShootMissile
                                ? (extendedMissileAttack ? 'Extended open-sky missile window' : 'Missile seeker lock confirmed')
                                : 'Power pylons or keep turning for lock';
                            let mslAction = this.withDebug({
                                state: shouldShootMissile ? 'missileAttack' : 'missilePrep',
                                statusText: mslStatus,
                                throttle: mslThrottle,
                                joyX: mslJoyX,
                                joyY: mslJoyY,
                                roll: shouldShootMissile
                                    ? this.clamp(mslJoyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8)
                                    : this.clamp(mslJoyX * Math.PI / (fox1Prep ? 6 : 4), -Math.PI / 4, Math.PI / 4),
                                weapon: 'missile',
                                powerPylons: !hasArmedMissile,
                                missileType: aiMissileType,
                                queueAction: shouldShootMissile ? 'missile' : 'none',
                                singleMissile: shouldShootMissile,
                                ready: true,
                                reason: mslReason
                            }, debugBase, [...tree, `selected: ${shouldShootMissile ? (extendedMissileAttack ? 'missileAttack-extended' : 'missileAttack') : 'missilePrep'}`], shouldShootMissile ? 'missileAttack' : 'missilePrep');
                            if (fox1Prep && shouldShootMissile) {
                                mslAction = this.gateFox1MissileShoot(teamId, liveSelf || self, mslAction, {
                                    altitude,
                                    angleDeg: angleToTargetDeg,
                                    distance,
                                    lineOfSightBlocked,
                                    localToEnemy,
                                    enemyPos: trackedEnemyPos,
                                    enemyForward: trackedEnemyForward,
                                    enemyAp: enemy.ap || enemy.speed || 120,
                                    selfForward,
                                    assistedVelocity,
                                    arenaMode,
                                    urbanArenaMode,
                                    aiMapSkyOpen: aiMapCtx.skyOpen,
                                    aiMapSarhPerch: aiMapCtx.sarhPerch,
                                    aiMapClearAbove: aiMapCtx.clearAbove
                                });
                            }
                            return mslAction;
                        }

                        const combatContact = sensor.hasContact || sensor.seenNow;
                        const openSkyAggression = !urbanArenaMode && coverInfo.collisionRisk === 'low' ? 1.45 : 1.0;
                        const interceptGain = (0.8 + tuning.interceptTurnGain + (notClosing ? 0.28 : 0)) * openSkyAggression * offenseAssist.interceptMul;
                        const interceptThrottle = distance > 45
                            ? (self.heat > 78 ? 3 : (self.heat < 62 ? 5 : 4))
                            : (notClosing && distance > 55 ? (self.heat > 72 ? 4 : 5) : 4);
                        const interceptJoyY = this.capCombatVerticalJoy(
                            this.clamp(verticalBias * (0.75 + tuning.interceptTurnGain * 0.4 + (notClosing ? 0.08 : 0)) * openSkyAggression, -0.7, 0.7),
                            altitude,
                            selfForward.y,
                            tuning,
                            combatContact
                        );
                        const preferMissileForIntercept = hasAnyMissile && rangeMode === 'missile' && distance > tuning.gunRange + 8 && !lineOfSightBlocked;
                        if (!skipTacticalApproach && tapEligible) {
                            const tapFinal = this.pickTacticalApproach(teamId, buildTapCtx(), debugBase, tree);
                            if (tapFinal) {
                                tree.push('tacticalApproach: preferOverIntercept=1');
                                return tapFinal;
                            }
                        }
                        return this.withDebug({
                            state: passiveSearchBearing ? 'searchIntercept' : 'intercept',
                            statusText: passiveSearchBearing
                                ? `NPC: 搜索接敵 ${Math.floor(distance)}m`
                                : `NPC: 轉向攔截 ${Math.floor(distance)}m`,
                            throttle: interceptThrottle,
                            joyX: this.clamp(horizontalBias * interceptGain, -1, 1),
                            joyY: interceptJoyY,
                            roll,
                            weapon: preferMissileForIntercept ? 'missile' : 'gun',
                            powerPylons: preferMissileForIntercept && !hasArmedMissile,
                            queueAction: 'none',
                            ready: true,
                            reason: passiveSearchBearing
                                ? 'Close toward threat bearing until radar contact'
                                : (openSkyAggression > 1.0
                                    ? 'Open-sky aggressive intercept: close faster and align nose'
                                    : 'Close distance and align nose')
                        }, debugBase, [...tree, `selected: ${passiveSearchBearing ? 'searchIntercept' : 'intercept'} openSkyAggression=${openSkyAggression.toFixed(2)}`], passiveSearchBearing ? 'searchIntercept' : 'intercept');
                return null;
            }]
        ]);
        if (__pipelineAction) return __pipelineAction;
        return this.finishDecideGate('engagement', this.withDebug({
            state: 'intercept',
            statusText: 'NPC: 管線後備攔截',
            throttle: 3,
            joyX: 0,
            joyY: 0,
            roll: 0,
            weapon: 'gun',
            queueAction: 'none',
            ready: true,
            reason: 'Decide pipeline fallback'
        }, debugBase, [...tree, 'selected: intercept-fallback'], 'intercept'));
    },

    normalizePolicyMode(mode) {
        return ['heuristic', 'hybrid', 'fox2-first', 'fox1-first'].includes(mode) ? mode : 'heuristic';
    },

    getPolicyMode(teamId) {
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        return this.normalizePolicyMode(team && team.aiPolicyMode ? team.aiPolicyMode : 'heuristic');
    },

    /** Opening doctrine: skip soft cover/mask and drive nose-on for FOX-2 before the fight goes defensive. */
    wantsOpeningFox2Rush(policyMode, turnNo, hasAnyMissile, threats = {}) {
        // fox2-first always; hybrid only in urban (open-sky hybrid must keep gun pressure for combat gates).
        const doctrine =
            policyMode === 'fox2-first' ||
            (policyMode === 'hybrid' && !!threats.urbanArenaMode);
        if (!doctrine || !hasAnyMissile) return false;
        const windowTurns = policyMode === 'fox2-first' ? 28 : 16;
        if (turnNo > windowTurns) return false;
        if (threats.actualMissileThreat || threats.enemyMissileInFlight) return false;
        // Abort climb-in when the human already has a kill shot lining up.
        if (threats.imminentIncoming) return false;
        if (threats.collisionHigh || threats.imminentBuildingHit) return false;
        // Only hard ground aborts the rush; mild dive still allows rooftop climb-in.
        if (threats.hardGroundRisk || threats.energyCritical || threats.stalled) return false;
        if (Number(threats.altitude) < 16) return false;
        return true;
    },

    evaluatePolicyUtility(action, self, enemy) {
        const tuning = this.getTuning();
        if (!action || !self || !enemy || !self.position || !enemy.position || !self.forward) return -999;
        const selfPos = this.toVector3(self.position);
        const enemyPos = this.toVector3(enemy.position);
        const selfForward = this.toVector3(self.forward).normalize();
        const toEnemy = enemyPos.clone().sub(selfPos);
        const distance = toEnemy.length();
        if (distance < 0.001) return 0;
        const angleDeg = selfForward.angleTo(toEnemy.normalize()) * 180 / Math.PI;
        const ap = Number(self.ap || self.speed || 100);
        const throttle = Number(action.throttle || 3);
        const joyMag = Math.abs(Number(action.joyX || 0)) + Math.abs(Number(action.joyY || 0));
        const obstacles = this.getObstacles();
        const urbanPressure = Array.isArray(obstacles) && obstacles.length > 0;
        const openSkyBonus = urbanPressure ? 1.0 : 1.2;

        let score = 0;
        score += this.clamp((130 - distance) / 130, -1, 1) * 55 * openSkyBonus;
        score += this.clamp((90 - angleDeg) / 90, -1, 1) * 48 * openSkyBonus;
        const gunR = this.gunRangeOr(tuning);
        const mslMin = this.missileMinOr(tuning);
        const mslMax = this.missileMaxOr(tuning);
        const gunSweetSpot = distance < gunR * (urbanPressure ? 0.72 : 0.93) && angleDeg < (urbanPressure ? 25 : 30);
        if (action.queueAction === 'missile') {
            const losBlocked = this.hasObstacleBetween(selfPos, enemyPos);
            const missileGood = !losBlocked && distance > mslMin * 0.85 && distance < mslMax * (urbanPressure ? 0.79 : 0.88) && angleDeg < (urbanPressure ? 28 : 32);
            score += missileGood ? (urbanPressure ? 55 : 70) : -35;
            if (losBlocked) score -= 90;
        }
        if (action.queueAction === 'gun') {
            score += gunSweetSpot ? (urbanPressure ? 42 : 58) : -18;
            if (distance < gunR * 0.5 && angleDeg < 22) score += 12;
        }
        if (!gunSweetSpot && distance < mslMax * 0.92 && angleDeg < 45 && (action.queueAction === 'none' || !action.queueAction)) {
            score -= 10 * openSkyBonus;
        }
        if (ap < 70 && throttle >= 4) score += 18;
        if (ap < 58 && joyMag > 1.0) score -= (22 + tuning.climbPenalty * 0.75);
        if (ap < 55 && throttle === 5) score -= 34;
        if (action.state && String(action.state).includes('recover')) score += (10 + tuning.stallRecoverBonus * 0.45);
        if (action.powerPylons && distance > mslMin && distance < mslMax && !urbanPressure) score += 18;
        return Number(score.toFixed(1));
    },

    buildHybridCandidates(teamId, baseAction, battleState) {
        const tuning = this.getTuning();
        const self = battleState && battleState.teams ? battleState.teams[teamId] : null;
        const enemy = battleState && battleState.teams ? battleState.teams[this.getEnemyId(teamId)] : null;
        if (!self || !enemy || !self.position || !enemy.position) return [baseAction];
        const selfPos = this.toVector3(self.position);
        const enemyPos = this.toVector3(enemy.position);
        const selfForward = this.toVector3(self.forward).normalize();
        const toEnemy = enemyPos.clone().sub(selfPos);
        const dist = toEnemy.length();
        const dir = toEnemy.clone().normalize();
        const angle = selfForward.angleTo(dir) * 180 / Math.PI;
        const local = dir.clone();
        const liveSelf = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (liveSelf && liveSelf.wrapper) local.applyQuaternion(liveSelf.wrapper.quaternion.clone().invert()).normalize();
        const obstacles = this.getObstacles();
        const urbanPressure = Array.isArray(obstacles) && obstacles.length > 0;
        const openSkyFactor = urbanPressure ? 1.0 : 1.25;
        const hBias = this.clamp(-local.x * (1.15 * openSkyFactor), -1, 1);
        const vBias = this.clamp(local.y * (0.75 * openSkyFactor), -0.65, 0.65);
        const hasArmedMissile = (self.pylons || []).some(p => p.state === 'armed');
        const hasAnyMissile = hasArmedMissile || (self.pylons || []).some(p => p.state === 'standby' || p.state === 'powering');
        const missileLosBlocked = this.hasObstacleBetween(selfPos, enemyPos);

        const baseGunIntent = baseAction.queueAction === 'gun' || baseAction.state === 'gunAttack';
        const baseMissileIntent = baseAction.queueAction === 'missile' || baseAction.state === 'missileAttack';
        const pressGunWindow = dist < tuning.gunRange + (urbanPressure ? 15 : 25) && angle < tuning.gunAngle * (urbanPressure ? 1.15 : 1.4);
        const mslMin = this.missileMinOr(tuning);
        const mslMax = this.missileMaxOr(tuning);
        const pressMissileWindow = hasArmedMissile && !missileLosBlocked && dist > mslMin * 0.9 && dist < mslMax * (urbanPressure ? 0.79 : 0.92) && angle < (urbanPressure ? 26 : 34);
        const aggression = tuning.hybridAggression * openSkyFactor;
        let pressQueue = 'none';
        if (baseGunIntent && pressGunWindow) {
            pressQueue = 'gun';
        } else if (baseMissileIntent && pressMissileWindow) {
            pressQueue = 'missile';
        } else if (pressMissileWindow) {
            pressQueue = 'missile';
        } else if (pressGunWindow || (dist < this.gunRangeOr(tuning) * (urbanPressure ? 0.6 : 0.79) && angle < (urbanPressure ? 22 : 28))) {
            pressQueue = 'gun';
        }

        const press = {
            ...baseAction,
            state: 'hybridPress',
            statusText: `NPC: HYBRID 壓制 ${Math.floor(dist)}m`,
            throttle: self.heat > 70 ? 3 : (dist > 60 && !urbanPressure && self.heat < 58 ? 5 : 4),
            joyX: this.clamp(hBias * (0.72 + aggression * 0.85), -1, 1),
            joyY: this.clamp(vBias * (0.85 + aggression * 0.2), -0.42, 0.42),
            roll: this.clamp(hBias * (Math.PI / 3.8), -Math.PI / 3.8, Math.PI / 3.8),
            weapon: pressQueue === 'missile' ? 'missile' : 'gun',
            powerPylons: hasAnyMissile && !hasArmedMissile && pressQueue !== 'gun' && dist > 45 && !urbanPressure,
            queueAction: pressQueue,
            ready: true,
            reason: baseGunIntent ? 'Hybrid candidate: preserve gun pressure' : `Hybrid candidate: pressure and close angle (openSky=${openSkyFactor.toFixed(2)})`
        };
        const blitz = {
            ...baseAction,
            state: 'hybridBlitz',
            statusText: `NPC: HYBRID 閃擊 ${Math.floor(dist)}m`,
            throttle: self.heat > 65 ? 3 : (urbanPressure ? 4 : 5),
            joyX: this.clamp(hBias * (0.92 + aggression), -1, 1),
            joyY: this.clamp(vBias * 0.9, -0.5, 0.5),
            roll: this.clamp(hBias * Math.PI / 3.5, -Math.PI / 3.5, Math.PI / 3.5),
            weapon: dist < (urbanPressure ? 48 : 60) ? 'gun' : (hasArmedMissile ? 'missile' : 'gun'),
            powerPylons: hasAnyMissile && !hasArmedMissile && dist > 50 && !urbanPressure,
            queueAction: dist < (urbanPressure ? 55 : 70) && angle < (urbanPressure ? 30 : 38) ? (dist < (urbanPressure ? 50 : 60) ? 'gun' : (pressMissileWindow ? 'missile' : 'gun')) : 'none',
            ready: true,
            reason: 'Hybrid candidate: aggressive blitz for open-sky or near-weapon window'
        };
        const conserve = {
            ...baseAction,
            state: 'hybridConserve',
            statusText: `NPC: HYBRID 節能轉位`,
            throttle: self.heat > 80 ? 2 : 3,
            joyX: this.clamp(hBias * 0.5, -0.55, 0.55),
            joyY: selfPos.y < 24 ? 0.18 : this.clamp(vBias * 0.25, -0.18, 0.22),
            roll: this.clamp(hBias * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
            weapon: hasAnyMissile ? 'missile' : 'gun',
            queueAction: 'none',
            ready: true,
            reason: 'Hybrid candidate: conserve AP and reposition'
        };
        return urbanPressure ? [baseAction, press, conserve] : [baseAction, blitz, press, conserve];
    },

    applyPolicyMode(teamId, action, battleState = GameContext.getSerializableBattleState()) {
        const mode = this.getPolicyMode(teamId);
        // fox2-first / fox1-first keep pure FSM decisions — hybridPress must never override flares/level-outs.
        if (mode === 'heuristic' || mode === 'fox2-first' || mode === 'fox1-first' || !action) {
            if (action) {
                action.debug = {
                    ...(action.debug || {}),
                    policy: {
                        mode,
                        selectedState: action.state || 'unknown',
                        baseState: action.state || 'unknown',
                        selectedScore: null,
                        overridden: false,
                        ...(mode === 'fox2-first' || mode === 'fox1-first' ? { lockedByDoctrine: true } : {})
                    }
                };
            }
            return action;
        }

        const hardSafetyStates = new Set([
            'emergencyPullUp',
            'emergencyRecoverLock',
            'obstacleEmergencyEscape',
            'postGroundClimbOut',
            'terrainEscape',
            'groundAvoid',
            'collisionAvoid',
            'stallBreakout',
            'stallRecoverNoRoll',
            'energyRecover',
            'recover',
            'manualEvadeRecover',
            'mandatoryMergeBreak',
            'mergeBreak',
            'antiLoopBreak',
            'obstacleEnergyClimb',
            'urbanPreemptiveAvoid',
            'urbanBrakeTurn',
            'urbanClimbingTurn',
            'urbanRouteEscape',
            'urbanBuildingWeave',
            'altitudeBandLevelOut',
            'defensiveFlare',
            'alignFirst',
            'openingRoofDash',
            'safetyStallBreakout',
            'safetyUnclimb',
            'safetyLevelOut'
        ]);
        if (hardSafetyStates.has(action.state)) {
            action.debug = {
                ...(action.debug || {}),
                policy: {
                    mode,
                    selectedState: action.state || 'unknown',
                    baseState: action.state || 'unknown',
                    selectedScore: null,
                    overridden: false,
                    lockedBySafety: true
                }
            };
            return action;
        }

        const self = battleState && battleState.teams ? battleState.teams[teamId] : null;
        const enemy = battleState && battleState.teams ? battleState.teams[this.getEnemyId(teamId)] : null;
        if (!self || !enemy) return action;

        // T25: never hybrid-press while stalled / AP-critical — keep FSM recover path.
        const tuning = this.getTuning();
        const liveAp = Number(self.ap);
        const energyLocked =
            !!self.stalled ||
            (Number.isFinite(liveAp) && liveAp < Number(tuning.energyCriticalAp || 52));
        if (energyLocked) {
            action.debug = {
                ...(action.debug || {}),
                policy: {
                    mode,
                    selectedState: action.state || 'unknown',
                    baseState: action.state || 'unknown',
                    selectedScore: null,
                    overridden: false,
                    lockedByEnergy: true
                },
                tree: [
                    ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                    `policyEval: mode=${mode} lockedByEnergy=1 stalled=${self.stalled ? 1 : 0} ap=${Number.isFinite(liveAp) ? liveAp : 'n/a'} keep=${action.state || 'unknown'}`
                ]
            };
            return action;
        }

        // T20: hybridPress at ~3m with joyX≈0 overrode missilePrep → midair. Lock FSM on knife contact.
        let midairDist = null;
        if (self.position && enemy.position) {
            midairDist = this.toVector3(self.position).distanceTo(this.toVector3(enemy.position));
        }
        if (Number.isFinite(midairDist) && midairDist > 0 && midairDist <= 14) {
            action.debug = {
                ...(action.debug || {}),
                policy: {
                    mode,
                    selectedState: action.state || 'unknown',
                    baseState: action.state || 'unknown',
                    selectedScore: null,
                    overridden: false,
                    lockedByMidair: true
                },
                tree: [
                    ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                    `policyEval: mode=${mode} lockedByMidair=1 dist=${midairDist.toFixed(1)} keep=${action.state || 'unknown'}`
                ]
            };
            return action;
        }

        const candidates = this.buildHybridCandidates(teamId, action, battleState);
        let bestAction = action;
        let bestScore = this.evaluatePolicyUtility(action, self, enemy);
        for (let i = 1; i < candidates.length; i++) {
            const score = this.evaluatePolicyUtility(candidates[i], self, enemy);
            if (score > bestScore) {
                bestScore = score;
                bestAction = candidates[i];
            }
        }

        const selected = bestAction === action ? action : {
            ...bestAction,
            debug: action.debug,
            policyOverrideFrom: action.state || 'unknown'
        };
        const baseTree = (action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : [];
        selected.debug = {
            ...(action.debug || {}),
            policy: {
                mode,
                selectedState: selected.state || 'unknown',
                baseState: action.state || 'unknown',
                selectedScore: bestScore,
                overridden: bestAction !== action
            },
            tree: [
                ...baseTree,
                `policyEval: mode=${mode} selected=${selected.state || 'unknown'} base=${action.state || 'unknown'} score=${bestScore} override=${bestAction !== action}`
            ]
        };
        return selected;
    },

    run(teamId) {
        if (typeof AirArenaBuildingRisk !== 'undefined' && AirArenaBuildingRisk.bumpObstacleBoxCache) {
            AirArenaBuildingRisk.bumpObstacleBoxCache();
        }
        const battleState = GameContext.getSerializableBattleState();
        const leadId = this.getWingmanLeadId(teamId);
        const wingmanOrder = this.getWingmanOrder(teamId);
        const action = this.decide(teamId, battleState);
        const isWingmanSupport = !!(leadId && this.isWingmanSupportOrder(wingmanOrder) && action && String(action.state || '').indexOf('wingman') === 0);
        const policyAction = isWingmanSupport ? action : this.applyPolicyMode(teamId, action, battleState);
        const safeAction = this.chooseSafeAction(teamId, policyAction);
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (team && team.wrapper && safeAction) {
            const selfPos = team.wrapper.position;
            const selfForward = new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize();
            const selfPitch = Math.asin(this.clamp(selfForward.y, -1, 1));
            const selfAp = typeof team.ap === 'number' ? team.ap : (team.speed || 120);
            const coverInfo = this.getCoverInfo(selfPos, selfForward, selfAp);
            if (!isWingmanSupport) {
                this.adjustActionForCombatBand(safeAction, selfPos.y, coverInfo, this.getTuning(), selfPitch, selfAp);
            }
            const headroom = Number.isFinite(coverInfo.headroom)
                ? coverInfo.headroom
                : this.getOverheadHeadroom(selfPos);
            this.applyHeadroomClimbLimit(safeAction, headroom, {
                altitude: selfPos.y,
                defaultSide: (GameContext.getFaction && GameContext.getFaction(teamId)) === 'blue' ? -1 : 1
            });
            if (!safeAction.debug) safeAction.debug = {};
            safeAction.debug.headroom = Number(Number(headroom).toFixed(1));
            if (Array.isArray(safeAction.debug.tree) && Number(headroom) < 14) {
                const capNote = safeAction.debug.headroomDirtExit
                    ? `dirtExit joyY=${Number(safeAction.joyY).toFixed(2)}`
                    : `maxJoyY=${this.maxJoyYForHeadroom(headroom).toFixed(2)}`;
                safeAction.debug.tree.push(`headroomGate: h=${Number(headroom).toFixed(1)} ${capNote}`);
            }
        }
        if (leadId && (wingmanOrder === 'attack' || wingmanOrder === 'free') && safeAction) {
            const energyBusy = String(safeAction.state || '').indexOf('stall') === 0
                || String(safeAction.state || '').indexOf('energy') === 0
                || String(safeAction.state || '') === 'recover'
                || (team && (team.stalled || (typeof team.ap === 'number' && team.ap < this.getTuning().energyCriticalAp)));
            if (!energyBusy) {
                const label = this.getWingmanOrderLabel(wingmanOrder);
                if (safeAction.statusText && String(safeAction.statusText).indexOf(label) < 0) {
                    safeAction.statusText = `${safeAction.statusText}｜${label}`;
                }
            }
            if (!safeAction.debug) safeAction.debug = {};
            safeAction.debug.wingmanOrder = wingmanOrder;
            safeAction.debug.leadId = leadId;
        } else if (!leadId && wingmanOrder && safeAction && team && team.aiEnabled) {
            // Order stuck on follow/cover but human lead is gone → free fight (explicit).
            if (safeAction.statusText && String(safeAction.statusText).indexOf('無長機') < 0) {
                safeAction.statusText = `${safeAction.statusText}｜無長機自由作戰`;
            }
            if (!safeAction.debug) safeAction.debug = {};
            safeAction.debug.wingmanOrder = wingmanOrder;
            safeAction.debug.leadId = null;
            safeAction.debug.wingmanOrphan = true;
        }

        // No-IFF IR: withhold missile if seeker would prefer a friendly heat source.
        if (safeAction && safeAction.queueAction === 'missile' && typeof isMissileFratricideRisk === 'function') {
            const preferred = this.getEnemyId(teamId);
            if (isMissileFratricideRisk(teamId, preferred)) {
                safeAction.queueAction = 'none';
                if (safeAction.statusText && String(safeAction.statusText).indexOf('避免誤擊') < 0) {
                    safeAction.statusText = `${safeAction.statusText}｜避免誤擊`;
                }
                if (!safeAction.debug) safeAction.debug = {};
                safeAction.debug.fratricideHold = 1;
                if (Array.isArray(safeAction.debug.tree)) {
                    safeAction.debug.tree.push('fratricideGate: hold=1 (friendly heat in seeker)');
                }
            }
        }

        // Withhold FOX-2 when terrain/buildings block the shot line — do not waste pylons.
        if (safeAction && safeAction.queueAction === 'missile' && team && team.wrapper) {
            const preferredId = this.getEnemyId(teamId);
            const preferred = (typeof GameContext !== 'undefined' && GameContext.getTeam)
                ? GameContext.getTeam(preferredId)
                : null;
            const targetPos = preferred && preferred.wrapper && preferred.wrapper.position
                ? preferred.wrapper.position
                : null;
            if (targetPos && this.hasObstacleBetween(team.wrapper.position, targetPos)) {
                safeAction.queueAction = 'none';
                if (safeAction.singleMissile) safeAction.singleMissile = false;
                if (safeAction.statusText && String(safeAction.statusText).indexOf('障礙阻擋') < 0) {
                    safeAction.statusText = `${safeAction.statusText}｜障礙阻擋`;
                }
                if (!safeAction.debug) safeAction.debug = {};
                safeAction.debug.missileLosHold = 1;
                if (Array.isArray(safeAction.debug.tree)) {
                    safeAction.debug.tree.push('missileLosGate: hold=1 (obstacle between self and target)');
                }
            }
        }

        // Salvo vs enemy flares + flare jitter (after LOS hold so we do not tag withheld shots).
        if (safeAction && team) {
            const foeId = this.getEnemyId(teamId);
            const foe = (typeof GameContext !== 'undefined' && GameContext.getTeam)
                ? GameContext.getTeam(foeId)
                : null;
            const selfPos = team.wrapper && team.wrapper.position;
            const foePos = foe && foe.wrapper && foe.wrapper.position;
            const dist = (selfPos && foePos) ? selfPos.distanceTo(foePos) : Number(safeAction.debug && safeAction.debug.distance);
            const threatMax = (typeof this.getMissileEnvelope === 'function')
                ? this.getMissileEnvelope(this.inferThreatMissileType(foe)).missileMaxRange
                : ((typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.maxFlightRange)
                    ? CONFIG.weapons.fox2.maxFlightRange
                    : 120);
            const dbg = safeAction.debug || {};
            const ownMissileType = dbg.aiMissileType || safeAction.missileType || 'fox2';
            this.applyMissileSalvoAndFlareDoctrine(safeAction, {
                enemy: foe,
                distance: dist,
                flareUseDistance: threatMax + 18,
                lineOfSightBlocked: !!dbg.losBlocked,
                enemyAspectDeg: dbg.enemyAspectDeg,
                actualMissileThreat: !!dbg.actualMissileThreat,
                urgentMissileThreat: !!dbg.actualMissileThreat || !!dbg.missileThreat,
                missileType: ownMissileType,
                tuning: this.getTuning()
            });
        }

        // Phase A: hard turns keep ECO/MIL — never AB while demanding turn authority.
        // Soft urban (default) keeps speed; hardBuilding only when smash-imminent sticks.
        if (safeAction && team) {
            const tuning = this.getTuning();
            const smashStick =
                this.isSoftObstacleEscapeState(safeAction.state) ||
                safeAction.state === 'safetyEmbedPushOut' ||
                (typeof safeAction.joyX === 'number' && Math.abs(safeAction.joyX) >= 0.7);
            this.enforceEnergyTurnConsistency(safeAction, {
                heat: team.heat || 0,
                ap: typeof team.ap === 'number' ? team.ap : null,
                energyCritical: typeof team.ap === 'number' && team.ap < tuning.energyCriticalAp,
                energyCriticalAp: tuning.energyCriticalAp,
                stalled: !!team.stalled,
                lowAp: tuning.lowAp,
                altitude: team.wrapper && team.wrapper.position ? team.wrapper.position.y : null,
                hardBuilding: smashStick && (
                    this.isSoftObstacleEscapeState(safeAction.state) ||
                    safeAction.state === 'safetyEmbedPushOut'
                )
            });
        }

        // FOX-1 illuminate / reattack LAST so energy/flare/soft-urban sticks cannot wipe nose-hold.
        if (safeAction && team) {
            const dbg = safeAction.debug || {};
            const ownMissileType = dbg.aiMissileType || safeAction.missileType || 'fox2';
            const sequelActive = !!(this.fox1SequelByTeam[teamId] && this.fox1SequelByTeam[teamId].active);
            // Include wasInFlight so the frame a FOX-1 dies still enters overlay → sequel setup.
            if (
                ownMissileType === 'fox1' ||
                this.hasOwnFox1InFlight(team) ||
                sequelActive ||
                !!this.fox1WasInFlightByTeam[teamId]
            ) {
                const foeId = this.getEnemyId(teamId);
                const foe = (typeof GameContext !== 'undefined' && GameContext.getTeam)
                    ? GameContext.getTeam(foeId)
                    : null;
                let local = (dbg.targetLocalX != null)
                    ? new THREE.Vector3(
                        Number(dbg.targetLocalX) || 0,
                        Number(dbg.targetLocalY) || 0,
                        Number(dbg.targetLocalZ) || 0
                    )
                    : null;
                // Soft urban / early gates may omit targetLocal — recompute for SARH hold.
                if (!local && team.wrapper && foe && foe.wrapper && foe.wrapper.position && typeof THREE !== 'undefined') {
                    local = foe.wrapper.position.clone().sub(team.wrapper.position);
                    if (local.lengthSq() > 1e-8) {
                        local.applyQuaternion(team.wrapper.quaternion.clone().invert()).normalize();
                    }
                }
                const selfForward = team.wrapper
                    ? new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize()
                    : null;
                const enemyForward = foe && foe.wrapper
                    ? new THREE.Vector3(0, 0, 1).applyQuaternion(foe.wrapper.quaternion).normalize()
                    : null;
                const dist = Number(dbg.distance);
                const distLive = (team.wrapper && foe && foe.wrapper)
                    ? team.wrapper.position.distanceTo(foe.wrapper.position)
                    : dist;
                const arenaModeNow = (typeof GameContext !== 'undefined' && GameContext.getArenaMode)
                    ? GameContext.getArenaMode()
                    : 'buildings';
                const urbanNow = ['sparse-urban', 'medium-urban', 'dense-urban', 'obstacle-stress', 'buildings'].includes(arenaModeNow);
                const overlayPos = team.wrapper && team.wrapper.position ? team.wrapper.position : null;
                const overlayAlt = overlayPos ? overlayPos.y : dbg.altitude;
                const overlayAiMap = this.sampleAiMapContext(overlayPos, { altitude: overlayAlt, radius: 80 });
                this.applyFox1DoctrineOverlay(safeAction, team, {
                    teamId,
                    angleDeg: dbg.angleDeg,
                    distance: Number.isFinite(distLive) ? distLive : dist,
                    missileType: ownMissileType,
                    aiMissileType: ownMissileType,
                    localToEnemy: local,
                    altitude: overlayAlt,
                    coverForwardDistance: dbg.coverForwardDistance,
                    hardBuildingContact: !!dbg.hardBuildingContact || !!safeAction.hardBuilding,
                    lineOfSightBlocked: !!dbg.losBlocked,
                    enemyPos: foe && foe.wrapper ? foe.wrapper.position : null,
                    enemyForward,
                    enemyAp: (foe && (typeof foe.ap === 'number' ? foe.ap : foe.speed)) || 120,
                    selfForward,
                    assistedVelocity: null,
                    arenaMode: arenaModeNow,
                    urbanArenaMode: urbanNow,
                    aiMapSkyOpen: overlayAiMap.skyOpen,
                    aiMapSarhPerch: overlayAiMap.sarhPerch,
                    aiMapClearAbove: overlayAiMap.clearAbove,
                    actualMissileThreat: !!dbg.actualMissileThreat,
                    inboundFox1: !!dbg.inboundFox1,
                    inboundFox2: !!dbg.inboundFox2,
                    underSarhPaint: !!dbg.underSarhPaint,
                    shouldChaffNow: !!dbg.shouldChaffNow,
                    shouldFlareNow: !!dbg.shouldFlareNow
                });
            }
        }

        GameContext.stateMachine.applyPilotAction(teamId, safeAction);
        return safeAction;
    }
};
