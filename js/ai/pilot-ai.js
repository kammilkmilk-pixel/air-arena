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
    weaponRangeMemory: {},
    brakeTurnMemory: {},
    urbanAvoidMemory: {},
    raycaster: new THREE.Raycaster(),
    tuningDefaults: null,

    getBuiltinDefaults() {
        if (window.AIR_ARENA_AI_DEFAULTS) return { ...window.AIR_ARENA_AI_DEFAULTS };
        return {
            energyCriticalAp: 52,
            lowAp: 65,
            stallPitchThreshold: 0.16,
            minRecoverAlt: 22,
            stallRecoverBonus: 7.5,
            climbPenalty: 6.2,
            gunRange: 70,
            gunAngle: 22,
            missileMinRange: 35,
            missileMaxRange: 120,
            missileAngle: 27,
            interceptTurnGain: 0.22,
            recoverPitchBias: -0.2,
            hybridAggression: 0.55,
            combatBandMin: 35,
            combatBandMax: 92,
            combatBandHardMax: 108
        };
    },

    getTuning() {
        const external = (typeof window !== 'undefined' && window.AIR_ARENA_AI_TUNING) ? window.AIR_ARENA_AI_TUNING : {};
        return { ...this.getBuiltinDefaults(), ...(external || {}) };
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
        const angleDeg = Number(ctx.angleDeg || 0);
        const localZ = Number(ctx.localZ);
        const steep = Number(ctx.forwardY || 0) > 0.38;
        if (steep && (angleDeg > 28 || !(Number.isFinite(localZ)) || localZ < 0.55)) return true;
        return angleDeg > 38 || (Number.isFinite(localZ) && localZ < 0.42);
    },

    buildAlignBeforeAccelControls(ctx = {}) {
        const angleDeg = Number(ctx.angleDeg || 0);
        const local = ctx.localToEnemy || { x: 0, y: 0, z: 1 };
        const fwdY = Number(ctx.forwardY || 0);
        const altitude = Number(ctx.altitude || 50);
        const breakSide = ctx.breakSide || 1;
        const baseHx = typeof ctx.baseHorizontalBias === 'number'
            ? ctx.baseHorizontalBias
            : this.clamp(-(local.x || 0) * 1.25, -1, 1);
        const joyX = this.resolveTurnJoyX(baseHx * 1.55, local, angleDeg, breakSide, 0.95);
        let joyY = this.clamp((local.y || 0) * 0.32, -0.35, 0.35);
        // Unload balloon climb first — body-frame localY is unreliable when nearly vertical.
        if (fwdY > 0.28) {
            joyY = Math.min(joyY, -0.28 - Math.min(0.55, (fwdY - 0.28) * 1.15));
        } else if (fwdY < -0.28 && altitude > 28) {
            joyY = Math.max(joyY, 0.12);
        }
        if (altitude > 48 && joyY > 0.06) joyY = Math.min(joyY, 0.06);
        const throttle = (angleDeg > 55 || fwdY > 0.45) ? 2 : 3;
        return {
            joyX: this.clamp(joyX, -1, 1),
            joyY: this.clamp(joyY, -0.75, 0.42),
            roll: this.clamp(joyX * Math.PI / 3.2, -Math.PI / 3.2, Math.PI / 3.2),
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
     */
    pickThrottleForTurn(requestedThrottle, joyX, opts = {}) {
        let thr = Math.max(1, Math.min(5, Math.round(Number(requestedThrottle) || 4)));
        const turnAuth = Math.abs(Number(joyX) || 0);
        const heat = Number(opts.heat || 0);
        const ap = Number(opts.ap);
        const energyTight = (Number.isFinite(ap) && ap < Number(opts.lowAp || 65))
            || !!opts.energyCritical
            || !!opts.stalled;
        let maxThr = 5;
        if (turnAuth >= 0.62 || (energyTight && turnAuth >= 0.28)) maxThr = 3;
        else if (turnAuth >= 0.38) maxThr = 4;
        else if (energyTight && turnAuth >= 0.15) maxThr = 4;
        // Heat already blocks AB often; keep MIL when hot + turning.
        if (heat > 78 && maxThr >= 5) maxThr = 4;
        if (heat > 86 && maxThr >= 4) maxThr = 3;
        return Math.min(thr, maxThr);
    },

    /** States that must keep AB/MIL for climb-out / ground escape. */
    isEnergyTurnExemptState(state) {
        const s = String(state || '');
        return (
            s === 'emergencyPullUp' ||
            s === 'emergencyRecoverLock' ||
            s === 'postGroundClimbOut' ||
            s === 'obstacleEmergencyEscape' ||
            s === 'terrainEscape' ||
            s === 'groundAvoid' ||
            s === 'wingmanPullUp' ||
            s.indexOf('safetyObstacle') === 0 ||
            s.indexOf('safetyStall') === 0
        );
    },

    /**
     * Phase A exit gate: hard-turn actions cannot keep thr 4–5.
     * Mutates action in place; tags debug.energyTurn.
     */
    enforceEnergyTurnConsistency(action, ctx = {}) {
        if (!action || typeof action !== 'object') return action;
        if (this.isEnergyTurnExemptState(action.state)) return action;
        const before = Math.max(1, Math.min(5, Math.round(Number(action.throttle) || 4)));
        const joyX = Number(action.joyX) || 0;
        const after = this.pickThrottleForTurn(before, joyX, ctx);
        if (after !== before) {
            action.throttle = after;
            if (!action.debug) action.debug = {};
            action.debug.energyTurn = {
                before,
                after,
                joyX: Number(joyX.toFixed(3)),
                reason: Math.abs(joyX) >= 0.38 ? 'capThrottleForTurnAuth' : 'capThrottleForEnergy'
            };
            if (Array.isArray(action.debug.tree)) {
                action.debug.tree.push(`energyTurnGate: thr ${before}->${after} |joyX|=${Math.abs(joyX).toFixed(2)}`);
            }
            if (action.statusText && String(action.statusText).indexOf('ECO轉') < 0 && after <= 3 && Math.abs(joyX) >= 0.38) {
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
        const closeMerge = Number.isFinite(distance) && distance > 0 && distance < 18;
        const nearMerge = Number.isFinite(distance) && distance > 0 && distance < 28;
        const enemyAhead = localZ > 0.25 || (Number.isFinite(headOn) && headOn > 0.28);
        if (!(closeMerge || (nearMerge && enemyAhead))) {
            return { joyX: 0, roll: 0, joyYScale: 1, active: false };
        }
        // Prefer opposite of enemy lateral so paths diverge; fall back to team break side.
        const side = Math.abs(localX) > 0.08 ? Math.sign(localX) : breakSide;
        const auth = closeMerge ? (altitude < 12 ? 0.42 : 0.62) : 0.38;
        const joyX = this.clamp(side * auth, -0.72, 0.72);
        return {
            joyX,
            roll: this.clamp(joyX * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5),
            joyYScale: closeMerge ? 0.88 : 0.94,
            active: true
        };
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
        if (live && live.isDestroyed) return false;
        const snap = battleState && battleState.teams ? battleState.teams[enemyId] : null;
        if (!snap || snap.isDestroyed || !snap.position) return false;
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
            return !!(t && !t.aiEnabled && !t.isDestroyed);
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
        if (!snap || !snap.position) return null;
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
        const leadPose = this.getWingmanLeadPose(leadId, battleState);
        if (!self || !leadSnap || !leadPose || !self.position || self.isDestroyed || leadSnap.isDestroyed) return null;

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
        const hostile = hostileId ? battleState.teams[hostileId] : null;
        const hostileAlive = !!(hostile && !hostile.isDestroyed && hostile.position);
        const hostilePos = hostileAlive ? this.toVector3(hostile.position) : null;
        const distToLead = selfPos.distanceTo(leadPos);
        const distToHostile = hostilePos ? selfPos.distanceTo(hostilePos) : 9999;
        const canFlare = !!(liveSelf && liveSelf.flareAmmo > 0 && !liveSelf.flaresArmed);
        const needFlare = canFlare && distToHostile < 55 && hostilePos
            && selfForward.angleTo(hostilePos.clone().sub(selfPos).normalize()) > Math.PI * 0.45;
        const poseTag = leadPose.fromPath ? 'ghost' : 'now';

        // Low altitude safety always wins.
        if (selfPos.y < 16 || (selfPos.y < 28 && selfForward.y < -0.35)) {
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
            // Threat pressing the lead: cut in and engage.
            const leadThreatDist = hostilePos ? leadPos.distanceTo(hostilePos) : 9999;
            if (hostilePos && leadThreatDist < 95) {
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
        const steer = this.steerTowardWorldPoint(selfPos, selfQuat, slot);
        const onStation = steer.dist < 12;
        // Also nudge to match lead nose when close to station.
        let joyX = steer.joyX;
        let joyY = steer.joyY;
        if (onStation) {
            const leadLocal = leadForward.clone().applyQuaternion(selfQuat.clone().invert());
            joyX = this.clamp(joyX * 0.35 + (-leadLocal.x) * 0.4, -0.55, 0.55);
            joyY = this.clamp(joyY * 0.35 + leadLocal.y * 0.35, -0.28, 0.35);
        }
        return this.withDebug({
            state: 'wingmanFollow',
            statusText: onStation ? `NPC: 僚機編隊｜${label}` : `NPC: 僚機歸隊｜${label}`,
            throttle: onStation ? leadThrottle : Math.min(5, leadThrottle + 1),
            joyX,
            joyY,
            roll: this.clamp(joyX * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
            weapon: 'gun',
            queueAction: needFlare ? 'flare' : 'none',
            ready: true,
            reason: leadPose.fromPath
                ? 'Wingman follow lead planned end pose'
                : 'Wingman follow lead current pose'
        }, { wingmanOrder: order, leadId, distToLead, slotDist: steer.dist, leadPose: poseTag }, [
            `wingman: follow slotDist=${steer.dist.toFixed(1)} onStation=${onStation ? 1 : 0} pose=${poseTag}`
        ], 'wingmanFollow');
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

    getCombatAltitudeProfile(altitude, tuning = this.getTuning()) {
        const bandMin = Number(tuning.combatBandMin || 35);
        const bandMax = Number(tuning.combatBandMax || 92);
        const bandHard = Number(tuning.combatBandHardMax || 108);
        const alt = Number(altitude || 0);
        const excess = Math.max(0, alt - bandMax);
        const hardExcess = Math.max(0, alt - bandHard);
        const needsLevelOut = alt >= bandHard || (alt >= bandMax + 2);
        const needsSoftCap = alt >= bandMax - 2;
        let zone = 'in-band';
        if (alt < bandMin) zone = 'below-band';
        else if (alt >= bandHard) zone = 'hard-high';
        else if (alt >= bandMax) zone = 'high';
        return {
            bandMin,
            bandMax,
            bandHard,
            excess,
            hardExcess,
            needsLevelOut,
            needsSoftCap,
            zone,
            levelOutJoyY: alt >= bandHard ? -0.42 : (alt >= bandMax + 18 ? -0.32 : -0.2),
            levelOutPitch: alt >= bandHard ? 0.34 : 0.22
        };
    },

    shouldAllowUrbanClimb(altitude, coverInfo = {}, denseUrban = false, tuning = this.getTuning()) {
        const profile = this.getCombatAltitudeProfile(altitude, tuning);
        const alt = Number(altitude || 0);
        if (coverInfo.collisionRisk === 'high') return true;
        if (alt < profile.bandMin + 4) return true;
        if (alt < profile.bandMin + 14 && coverInfo.collisionRisk === 'medium' && alt < 52) return true;
        return false;
    },

    adjustActionForCombatBand(action, altitude, coverInfo = {}, tuning = this.getTuning(), selfPitch = null, selfAp = null) {
        if (!action || typeof action.joyY !== 'number') return action;
        const profile = this.getCombatAltitudeProfile(altitude, tuning);
        const climbExempt = new Set([
            'emergencyPullUp',
            'emergencyRecoverLock',
            'postGroundClimbOut',
            'groundAvoid',
            'obstacleEmergencyEscape',
            'obstacleEnergyClimb',
            'terrainEscape',
            'altitudeBandLevelOut',
            'openingRoofDash'
        ]);
        if (climbExempt.has(action.state)) return action;
        const veryLowAlt = altitude < 26;
        const divingFast = selfPitch != null && selfPitch < -0.18;
        const sinkingLow = altitude < 38 && selfPitch != null && selfPitch < -0.08;
        if (veryLowAlt || divingFast || sinkingLow) {
            const minJoyY = veryLowAlt ? (altitude < 22 ? 0.92 : 0.78) : (divingFast ? 0.68 : 0.42);
            if (action.joyY < minJoyY) action.joyY = minJoyY;
            if (veryLowAlt && typeof action.throttle === 'number' && action.throttle < 4) {
                action.throttle = 4;
            }
            if (action.fire !== 'none' && altitude < 30) action.fire = 'none';
            const lowApRisk = (selfAp != null && selfAp < 70) || Math.abs(action.joyX || 0) > 0.65;
            if (altitude < 32 && lowApRisk && Math.abs(action.joyX || 0) > 0.35) {
                action.joyX = this.clamp(action.joyX, -0.32, 0.32);
            }
            if (altitude < 28) action.joyX = this.clamp(action.joyX || 0, -0.22, 0.22);
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
        const key = `${teamId}|postGroundRecover`;
        const prev = this.postGroundRecoveryMemory[key] || { untilTurn: -1 };
        let untilTurn = Number(prev.untilTurn || -1);
        if (altitude < 10 || (altitude < 24 && forwardY < -0.25)) {
            if (turnNo > untilTurn) untilTurn = turnNo + 8;
        } else if (altitude >= 28 && forwardY > -0.12) {
            untilTurn = -1;
        }
        const active = untilTurn >= 0 && turnNo <= untilTurn;
        this.postGroundRecoveryMemory[key] = { untilTurn };
        return { active, untilTurn };
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

    buildUrbanRouteContinuation(base, candidate, team, altitude, stepIndex) {
        const scale = stepIndex === 1 ? 0.72 : 0.58;
        return {
            ...base,
            state: `${candidate.state}Continue${stepIndex}`,
            throttle: candidate.brakeTurn ? (team.heat > 78 ? 3 : 5) : candidate.throttle,
            joyX: this.clamp((candidate.joyX || 0) * scale, -0.82, 0.82),
            joyY: this.clamp(
                Math.max(candidate.joyY || 0, altitude < 35 ? 0.24 : 0.1),
                -0.15,
                0.72
            ),
            roll: this.clamp((candidate.roll || 0) * (stepIndex === 1 ? 0.7 : 0.55), -Math.PI / 8, Math.PI / 8),
            reason: 'Urban planner continuation'
        };
    },

    pickUrbanRoute(teamId, ctx, debugBase, tree) {
        const urbanRoute = this.planUrbanRoute(teamId, ctx);
        if (!urbanRoute) return null;
        const urbanMode = urbanRoute.state;
        tree.push(`urbanRouteGate: selected=${urbanRoute.urbanRoute.source} score=${urbanRoute.urbanRoute.score} nb=${urbanRoute.urbanRoute.nearestBuilding}`);
        if (
            urbanMode === 'urbanBuildingWeave' ||
            (urbanRoute.urbanRoute && urbanRoute.urbanRoute.source === 'urbanBuildingWeave')
        ) {
            const weaveSide = Math.sign(urbanRoute.joyX || 0) || Math.sign(ctx.preferredSide || 0) || 1;
            this.updateUrbanAvoidMemory(teamId, weaveSide, Number(ctx.turnNo || 1), 4);
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

    getUrbanAvoidMemory(teamId) {
        return this.urbanAvoidMemory[teamId] || { side: 0, untilTurn: -1 };
    },

    updateUrbanAvoidMemory(teamId, side, turnNo = 1, holdTurns = 4) {
        const stableSide = Math.sign(side || 0);
        if (!stableSide) return this.getUrbanAvoidMemory(teamId);
        this.urbanAvoidMemory[teamId] = {
            side: stableSide,
            untilTurn: turnNo + holdTurns
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
        const gunClose = Number(tuning.gunRange || 42) + (openSky ? 22 : 10);
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
                box.setFromObject(obstacles[j]);
                box.clampPoint(points[i], clamped);
                nearestBuilding = Math.min(nearestBuilding, clamped.distanceTo(points[i]));
                if (i > 2 && box.containsPoint(points[i])) buildingHit = true;
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
        let score = 100;
        if (buildingHit) score -= 220;
        if (minAltitude < 3) score -= 220;
        else if (minAltitude < 10) score -= 120;
        else if (minAltitude < 18) score -= 45;
        if (nearestBuilding < 4) score -= 140;
        else if (nearestBuilding < 10) score -= 55;
        if (finalAP < 45) score -= 120;
        else if (finalAP < 55) score -= 45;
        const climbLoopRisk = finalAP < 75 && finalForwardY > 0.28;
        if (climbLoopRisk) score -= 110;
        if (finalAP < 85 && startForwardY > 0.25 && finalForwardY > startForwardY - 0.03) score -= 70;
        score += this.clamp((90 - finalAngleDeg) / 90, -1, 1) * 30;
        if (action.queueAction === 'missile' && action.debug && !action.debug.missileLock) score -= 80;

        return {
            score: Number(score.toFixed(1)),
            safe: score > 0 && !buildingHit && minAltitude >= 3 && finalAP >= 45 && !climbLoopRisk,
            minAltitude: Number((Number.isFinite(minAltitude) ? minAltitude : -1).toFixed(1)),
            buildingHit,
            nearestBuilding: Number((Number.isFinite(nearestBuilding) ? nearestBuilding : -1).toFixed(1)),
            finalAP: Number(finalAP.toFixed(1)),
            finalAngleDeg: Number(finalAngleDeg.toFixed(1)),
            finalForwardY: Number(finalForwardY.toFixed(2)),
            climbLoopRisk
        };
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
        if (action.singleMissile) chosen.singleMissile = action.singleMissile;
        return chosen;
    },

    chooseSafeAction(teamId, action) {
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (!team) return action;
        const tuning = this.getTuning();
        const base = { weapon: 'gun', queueAction: 'none', ready: true };
        const teamForwardY = team.wrapper ? new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).y : 0;
        const lowEnergy = (team.ap || 120) < 75;
        const stallTrapNow = !!team.stalled && teamForwardY > tuning.stallPitchThreshold && !!(team.wrapper && team.wrapper.position && team.wrapper.position.y > tuning.minRecoverAlt);
        const selfPos = team.wrapper && team.wrapper.position ? team.wrapper.position : null;
        const selfForward = team.wrapper ? new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize() : null;
        const coverInfo = (selfPos && selfForward) ? this.getCoverInfo(selfPos, selfForward, team.ap || team.speed || 120) : { collisionRisk: 'low', distance: Infinity, forwardDistance: Infinity };
        const obstaclePressure = coverInfo.collisionRisk === 'high' || coverInfo.distance < 10 || coverInfo.forwardDistance < 14;
        const acConfig = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts) ? CONFIG.aircrafts[team.type || 'mig21'] : null;
        const maxPitchCmd = acConfig ? acConfig.maxPitch : Math.PI / 3;
        let candidates = [
            action,
            { ...base, state: 'safetyLevelOut', statusText: 'NPC: 安全預演-放平加速', throttle: team.heat > 78 ? 3 : 5, joyX: 0, joyY: 0.05, roll: 0, reason: 'Safety fallback level-out' },
            { ...base, state: 'safetyShallowClimb', statusText: 'NPC: 安全預演-淺爬升', throttle: team.heat > 78 ? 3 : 4, joyX: 0, joyY: 0.18, roll: 0, reason: 'Safety fallback shallow climb' },
            { ...base, state: 'safetyUnclimb', statusText: 'NPC: 安全預演-放平回能', throttle: team.heat > 78 ? 3 : 4, joyX: 0, joyY: team.wrapper && team.wrapper.position.y > 24 ? -0.08 : 0, roll: 0, reason: 'Safety fallback break climb loop' },
            { ...base, state: 'safetyStallBreakout', statusText: 'NPC: 安全預演-失速改出', throttle: team.heat > 78 ? 4 : 5, joyX: 0, joyY: team.wrapper && team.wrapper.position.y > 38 ? -0.45 : -0.18, pitchCmd: team.wrapper && team.wrapper.position.y > 38 ? Math.PI / 7 : Math.PI / 10, roll: 0, reason: `Safety fallback stall breakout bonus=${Number(tuning.stallRecoverBonus).toFixed(2)}` },
            { ...base, state: 'safetyBreakLeft', statusText: 'NPC: 安全預演-左脫離', throttle: 4, joyX: -0.55, joyY: 0.12, roll: -Math.PI / 6, reason: 'Safety fallback left break' },
            { ...base, state: 'safetyBreakRight', statusText: 'NPC: 安全預演-右脫離', throttle: 4, joyX: 0.55, joyY: 0.12, roll: Math.PI / 6, reason: 'Safety fallback right break' }
        ];
        if (obstaclePressure) {
            const actionTurn = Math.sign(action.joyX || 0);
            const defaultSide = actionTurn || ((GameContext.getFaction && GameContext.getFaction(team.id)) === 'blue' ? -1 : 1);
            const escapePitch = selfPos && selfPos.y < 24 ? 0.72 : 0.52;
            const escapeThrottle = team.heat > 76 ? 4 : 5;
            const escapeRoll = Math.PI / 5.5;
            candidates = [
                action,
                { ...base, state: 'safetyObstacleEscapePrimary', statusText: 'NPC: 安全預演-建築主脫離', throttle: escapeThrottle, joyX: this.clamp(defaultSide * 0.82, -0.9, 0.9), joyY: escapePitch, pitchCmd: -maxPitchCmd * 0.62, roll: this.clamp(defaultSide * escapeRoll, -escapeRoll, escapeRoll), obstacleFallback: true, reason: 'Safety fallback keeps obstacle escape direction' },
                { ...base, state: 'safetyObstacleEscapeOpposite', statusText: 'NPC: 安全預演-建築反向脫離', throttle: escapeThrottle, joyX: this.clamp(-defaultSide * 0.82, -0.9, 0.9), joyY: escapePitch, pitchCmd: -maxPitchCmd * 0.62, roll: this.clamp(-defaultSide * escapeRoll, -escapeRoll, escapeRoll), obstacleFallback: true, reason: 'Safety fallback tries opposite side of obstacle' },
                { ...base, state: 'safetyObstacleClimbOut', statusText: 'NPC: 安全預演-建築爬升脫離', throttle: escapeThrottle, joyX: this.clamp(defaultSide * 0.28, -0.35, 0.35), joyY: selfPos && selfPos.y < 22 ? 0.9 : 0.68, pitchCmd: -maxPitchCmd * 0.78, roll: this.clamp(defaultSide * Math.PI / 12, -Math.PI / 12, Math.PI / 12), obstacleFallback: true, reason: 'Safety fallback climb out of obstacle envelope' },
                ...candidates.slice(1)
            ];
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
            'wingmanFollow',
            'wingmanCover',
            'wingmanCoverEngage',
            'wingmanBreak',
            'wingmanPullUp'
        ]);
        // Protect merge/reacquire unless we are about to hit terrain/building.
        const hardProtectOk = !originalEval.buildingHit &&
            (originalEval.minAltitude === null || originalEval.minAltitude >= 8);
        if ((protectedStates.has(action.state) || offensiveProtected) && hardProtectOk) {
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
                    offensiveProtected
                },
                tree: [
                    ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                    `safetyEval: protected=${action.state || 'unknown'} offensive=${offensiveProtected} score=${originalEval.score} minAlt=${originalEval.minAltitude} ap=${originalEval.finalAP} override=false`
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
        const originalTurn = Math.abs(Number(action.joyX || 0));
        const knifeFightAltOk = selfPos && selfPos.y >= 18;
        const rejectZeroTurnClimb =
            originalTurn >= 0.35 &&
            knifeFightAltOk &&
            ['mandatoryMergeBreak', 'mergeBreak', 'reacquire', 'orbitCutIn', 'antiLoopBreak', 'gunAttack', 'missilePrep'].includes(action.state);
        candidates.slice(1).forEach(candidate => {
            if (candidate.state === 'safetyShallowClimb' && lowEnergy && teamForwardY > 0.2) return;
            if (stallTrapNow && !['safetyStallBreakout', 'safetyUnclimb', 'safetyLevelOut'].includes(candidate.state)) return;
            // Do not replace a hard turn with joyX=0 climb during knife-fight / merge break.
            if (rejectZeroTurnClimb && Math.abs(Number(candidate.joyX || 0)) < 0.2) return;
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
            if (!bestEval || safety.score > bestEval.score) {
                bestEval = safety;
                bestAction = candidate;
            }
        });

        if (protectedStates.has(action.state) && bestAction !== action && !bestAction.obstacleFallback && bestEval && !bestEval.safe) {
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
                    overrideRejected: bestAction.state || 'unknown'
                },
                tree: [
                    ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                    `safetyEval: rejectedUnsafeOverride=${bestAction.state || 'unknown'} score=${bestEval.score} keep=${action.state || 'unknown'}`
                ]
            };
            return action;
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

        const chosen = bestAction === action ? action : {
            ...bestAction,
            debug: action.debug,
            safetyOverrideFrom: action.state || 'unknown'
        };
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
                offensiveQueuePreserved: bestAction !== action && this.isOffensiveSafetyProtected(action, coverInfo, originalEval)
            },
            tree: [
                ...((action.debug && Array.isArray(action.debug.tree)) ? action.debug.tree : []),
                `safetyEval: selected=${chosen.state || 'unknown'} score=${bestEval ? bestEval.score : 'n/a'} minAlt=${bestEval ? bestEval.minAltitude : 'n/a'} ap=${bestEval ? bestEval.finalAP : 'n/a'} override=${bestAction !== action}`
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
        const gunReach = Number(tuning.gunRange || 42) + 22;
        const knifeFight = Number.isFinite(distance) && distance > 0 && distance <= Number(tuning.gunRange || 42) + 12;
        const forwardDist = Number(coverInfo.forwardDistance);
        const coverDist = Number(coverInfo.distance);
        const imminentBuilding =
            coverInfo.collisionRisk === 'high' &&
            ((Number.isFinite(forwardDist) && forwardDist > 0 && forwardDist < 12) || coverDist < 8);
        if (imminentBuilding) return false;
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

    // Only positive forward clearance counts as approach pressure; 0/negative is side/behind clutter.
    isForwardBuildingPressure(coverInfo = {}, nearDist = 42, nearFwd = 56) {
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
        const preferredSide = Math.sign(ctx.preferredSide || breakSide || 1) || 1;
        const maskInfo = ctx.maskInfo || {};
        const coverInfo = ctx.coverInfo || {};
        const turnNo = Number(ctx.turnNo || 1);
        const obstacles = this.getObstacles();
        const denseUrban = !!ctx.denseUrban || this.isDenseUrbanContext(ctx.arenaMode, obstacles);
        const brakeTurnMemory = this.getBrakeTurnMemory(teamId);
        const recentlyBrakeTurned = (turnNo - Number(brakeTurnMemory.lastTurn || -99)) <= 3;
        const tuning = this.getTuning();
        const threatScore = Number(ctx.threatScore || 0);
        const closeCombatDefer = this.isCloseCombatUrbanDefer(ctx, tuning);
        const fwdClear = Number(coverInfo.forwardDistance);
        // Near gun range with low threat: do not divert to long mask routes.
        // Side buildings (fwd≈0) must not block combat defer.
        if (closeCombatDefer && !(Number.isFinite(fwdClear) && fwdClear > 0 && fwdClear < 12)) {
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

        const climbY = altitude < 20 ? 0.48 : (energyLow ? 0.22 : (altitude >= tuning.combatBandMin + 4 ? 0.04 : 0.14));
        const throttle = team.heat > 78 ? 3 : (energyLow ? 5 : 4);
        const candidates = [];
        const sideOrder = [preferredSide, -preferredSide];
        for (const side of sideOrder) {
            candidates.push(
                { ...base, state: 'urbanRouteSide', statusText: 'NPC: 城市規劃-側向繞行', throttle, joyX: this.clamp(side * 0.62, -0.82, 0.82), joyY: climbY, roll: this.clamp(side * Math.PI / 7, -Math.PI / 7, Math.PI / 7), reason: 'Urban planner side route' },
                { ...base, state: 'urbanPreemptiveRoute', statusText: 'NPC: 城市規劃-提前繞行', throttle, joyX: this.clamp(side * 0.58, -0.72, 0.72), joyY: altitude < 28 ? 0.34 : (altitude >= tuning.combatBandMin + 4 ? 0.02 : 0.1), roll: this.clamp(side * Math.PI / 8, -Math.PI / 8, Math.PI / 8), reason: 'Urban planner preemptive route' },
                { ...base, state: 'urbanRouteBreakSide', statusText: 'NPC: 城市規劃-標準脫離', throttle, joyX: this.clamp(side * 0.58, -0.7, 0.7), joyY: climbY, roll: this.clamp(side * Math.PI / 7, -Math.PI / 7, Math.PI / 7), reason: 'Urban planner break-side route' }
            );
            // Climbing turn is a poor FOX-2 response — only allow when buildings force it.
            const allowClimb =
                this.shouldAllowUrbanClimb(altitude, coverInfo, denseUrban, tuning) &&
                (!ctx.actualMissileThreat || coverInfo.collisionRisk === 'high');
            if (allowClimb) {
                candidates.push({
                    ...base,
                    state: 'urbanClimbingTurn',
                    statusText: 'NPC: 城市規劃-爬升轉向',
                    throttle: team.heat > 78 ? 4 : 5,
                    joyX: this.clamp(side * (denseUrban ? 0.34 : 0.46), -0.58, 0.58),
                    joyY: altitude < 30 ? 0.68 : (denseUrban ? 0.56 : 0.42),
                    roll: this.clamp(side * Math.PI / 10, -Math.PI / 10, Math.PI / 10),
                    reason: 'Urban planner climbing turn'
                });
            }
            if (coverInfo.collisionRisk === 'high') {
                candidates.push({
                    ...base,
                    state: energyLow ? 'obstacleEnergyClimbRoute' : 'obstacleEmergencyRoute',
                    statusText: energyLow ? 'NPC: 城市規劃-低能爬升' : 'NPC: 城市規劃-緊急脫離',
                    throttle: team.heat > 78 ? 4 : 5,
                    joyX: this.clamp(side * (energyLow ? 0.42 : 0.94), -1, 1),
                    joyY: altitude < 30 ? 0.7 : (energyLow ? 0.34 : 0.52),
                    roll: this.clamp(side * Math.PI / 6.5, -Math.PI / 6.5, Math.PI / 6.5),
                    reason: 'Urban planner emergency route'
                });
            }
        }

        candidates.push({
            ...base,
            state: 'urbanRouteClimbOut',
            statusText: 'NPC: 城市規劃-爬升脫離',
            throttle: team.heat > 78 ? 3 : 5,
            joyX: this.clamp(breakSide * 0.22, -0.3, 0.3),
            joyY: altitude < 26 ? 0.55 : 0.35,
            roll: this.clamp(breakSide * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
            reason: 'Urban planner climb-out route'
        });
        if (altitude >= tuning.combatBandMin + 6) {
            candidates.pop();
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
            Number(ctx.distance) > Number(tuning.gunRange || 42) + 35;
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

        // Building weave: stay in a mid-clearance lane beside structures instead of climbing out or gun-diving.
        const weaveEligible =
            altitude >= 26 &&
            Number(coverInfo.distance) >= 12 &&
            Number(coverInfo.distance) <= 36 &&
            (
                (coverInfo.collisionRisk === 'medium' && Number.isFinite(fwdClear) && fwdClear > 14) ||
                (sideLanePressure && Number(coverInfo.distance) >= 16)
            );
        if (weaveEligible) {
            const weaveJoyY = altitude < 30 ? 0.2 : 0.05;
            for (const side of sideOrder) {
                candidates.push({
                    ...base,
                    state: 'urbanBuildingWeave',
                    statusText: 'NPC: 城市規劃-建築穿梭',
                    throttle: team.heat > 78 ? 3 : 4,
                    joyX: this.clamp(side * 0.48, -0.62, 0.62),
                    joyY: weaveJoyY,
                    roll: this.clamp(side * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
                    reason: sideLanePressure
                        ? 'Urban planner side-lane weave'
                        : 'Urban planner building-lane weave'
                });
            }
        }

        const routeSelfPitch = (team && team.wrapper)
            ? Math.asin(this.clamp(new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize().y, -1, 1))
            : null;
        const routeSelfAp = (team && typeof team.ap === 'number') ? team.ap : null;
        let best = null;
        for (const candidate of candidates) {
            this.adjustActionForCombatBand(candidate, altitude, coverInfo, tuning, routeSelfPitch, routeSelfAp);
            const continuation1 = this.buildUrbanRouteContinuation(base, candidate, team, altitude, 1);
            const continuation2 = this.buildUrbanRouteContinuation(base, candidate, team, altitude, 2);
            this.adjustActionForCombatBand(continuation1, altitude, coverInfo, tuning, routeSelfPitch, routeSelfAp);
            this.adjustActionForCombatBand(continuation2, altitude, coverInfo, tuning, routeSelfPitch, routeSelfAp);
            const eval2 = this.evaluateActionSafety(teamId, candidate, [continuation1, continuation2]);
            let routeScore = eval2.score;
            if (!eval2.buildingHit) routeScore += 80;
            if (candidate.state === 'urbanBuildingWeave') {
                const nb = Number(eval2.nearestBuilding);
                // Mid-clearance sweet spot (~10–24m): lane weave, not max-escape clearance.
                if (nb >= 10 && nb <= 24) routeScore += 58;
                else if (nb >= 8 && nb < 10) routeScore += 36;
                else if (nb > 32) routeScore -= 28;
                else if (Number.isFinite(nb) && nb < 6) routeScore -= 90;
                if ((candidate.joyY || 0) < 0.22) routeScore += 14;
                if (Number.isFinite(nb) && nb < 8) routeScore -= 40;
            } else if (eval2.nearestBuilding >= 12) {
                routeScore += eval2.nearestBuilding * 4;
            } else if (eval2.nearestBuilding >= 8) {
                routeScore += 16;
            }
            if (eval2.finalAP >= 80) routeScore += 22;
            else if (eval2.finalAP < 60) routeScore -= 35;
            if (candidate.state === 'urbanRouteMask') {
                routeScore += Math.min(45, (maskInfo.score || 0) * 0.18);
                // Long mask ingress is a combat killer when already inside gun envelope.
                if (Number(maskInfo.distance) > 55) routeScore -= 90;
                if (Number(ctx.distance) < Number(tuning.gunRange || 42) + 25) routeScore -= 70;
            }
            if (candidate.state === 'urbanClimbingTurn') {
                routeScore += denseUrban ? 28 : 12;
                if (weaveEligible) routeScore -= 22;
                // Already in combat band: climbing turn escapes the city and kills weave lanes.
                if (altitude >= tuning.combatBandMin + 4) routeScore -= denseUrban ? 28 : 18;
                if (ctx.actualMissileThreat || ctx.missileThreatEvade) routeScore -= 80;
            }
            if (altitude > tuning.combatBandMax && (candidate.joyY || 0) > 0.1) routeScore -= 45;
            if (candidate.brakeTurn) {
                routeScore += 18;
                if (coverInfo.collisionRisk !== 'low') routeScore -= 60;
                if (eval2.finalAP < 72) routeScore -= 45;
                if (eval2.nearestBuilding < 10) routeScore -= 40;
            }
            if ((candidate.state === 'urbanRouteSide' || candidate.state === 'urbanPreemptiveRoute') && coverInfo.collisionRisk === 'medium') {
                routeScore += 30;
            }
            if (candidate.state === 'obstacleEmergencyRoute' && coverInfo.collisionRisk === 'medium') routeScore -= 80;
            if (ctx.mandatoryMergeBreak && Math.sign(candidate.joyX || 0) === Math.sign(breakSide)) routeScore += 12;
            if (Math.sign(candidate.joyX || 0) === preferredSide) routeScore += 8;
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
                        : (best.action.state === 'urbanPreemptiveRoute' ? 'urbanPreemptiveAvoid'
                            : (best.action.state === 'urbanClimbingTurn' ? 'urbanClimbingTurn'
                                : (best.action.state === 'urbanBuildingWeave' ? 'urbanBuildingWeave' : 'urbanRouteEscape')))));
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
                nearestBuilding: best.eval.nearestBuilding
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

    getCoverInfo(selfPos, selfForward, ap = 120) {
        const obstacles = this.getObstacles();
        const info = {
            available: false,
            direction: null,
            distance: Infinity,
            forwardDistance: Infinity,
            collisionRisk: 'low',
            mode: 'clear'
        };
        if (!obstacles || obstacles.length === 0) return info;

        const box = new THREE.Box3();
        const nearestPoint = new THREE.Vector3();
        const clampedPoint = new THREE.Vector3();
        const flatForward = selfForward.clone();
        flatForward.y = 0;
        if (flatForward.lengthSq() < 0.0001) flatForward.set(0, 0, 1);
        flatForward.normalize();

        let bestThreat = { riskPriority: 3, distance: Infinity, forwardDist: Infinity, collisionRisk: 'low', nearestPoint: null };

        for (let i = 0; i < obstacles.length; i++) {
            const obj = obstacles[i];
            if (!obj) continue;
            box.setFromObject(obj);
            box.clampPoint(selfPos, clampedPoint);
            const dist = clampedPoint.distanceTo(selfPos);
            const toBuilding = clampedPoint.clone().sub(selfPos);
            const flatTo = toBuilding.clone();
            flatTo.y = 0;
            const flatDist = flatTo.length();
            const forwardDist = flatDist > 0.001 ? flatTo.normalize().dot(flatForward) * flatDist : 0;
            const lateral = flatForward.x * toBuilding.z - flatForward.z * toBuilding.x;
            const behind = forwardDist < -4;
            const collisionRisk = behind && dist >= 8
                ? 'low'
                : (dist < 12 || (forwardDist > 0 && forwardDist < 24 && Math.abs(lateral) < 18)
                    ? 'high'
                    : (dist < 26 || (forwardDist > 0 && forwardDist < 46 && Math.abs(lateral) < 24) ? 'medium' : 'low'));
            const riskPriority = collisionRisk === 'high' ? 0 : (collisionRisk === 'medium' ? 1 : 2);
            if (riskPriority < bestThreat.riskPriority || (riskPriority === bestThreat.riskPriority && dist < bestThreat.distance)) {
                bestThreat = {
                    riskPriority,
                    distance: dist,
                    forwardDist: forwardDist,
                    collisionRisk,
                    nearestPoint: clampedPoint.clone()
                };
            }
        }

        if (bestThreat.nearestPoint) {
            info.available = true;
            info.distance = bestThreat.distance;
            info.forwardDistance = bestThreat.forwardDist;
            info.collisionRisk = bestThreat.collisionRisk;
            nearestPoint.copy(bestThreat.nearestPoint);
            const awayFromBuilding = nearestPoint.clone().sub(selfPos);
            if (awayFromBuilding.lengthSq() < 0.0001) {
                info.direction = new THREE.Vector3(0, 1, 0);
            } else {
                info.direction = awayFromBuilding.normalize();
            }
            if (info.collisionRisk === 'high') {
                info.mode = 'collisionAvoid';
            } else if (info.collisionRisk === 'medium') {
                info.mode = 'coverMaskTurn';
            } else if (info.distance > 32) {
                info.mode = 'coverIngress';
            } else {
                info.mode = 'coverMaskTurn';
            }
        }

        const forwardCheckDistance = this.clamp(24 + (ap * 0.28), 32, 72);
        this.raycaster.set(selfPos, selfForward.clone().normalize());
        this.raycaster.near = 0.1;
        this.raycaster.far = forwardCheckDistance;
        const hits = this.raycaster.intersectObjects(obstacles, true);
        if (hits.length > 0) {
            info.forwardDistance = Math.min(info.forwardDistance, hits[0].distance);
            if (hits[0].distance < 24) info.collisionRisk = 'high';
            else if (hits[0].distance < 46 && info.collisionRisk !== 'high') info.collisionRisk = 'medium';
            if (info.collisionRisk === 'high') info.mode = 'collisionAvoid';
        }

        return info;
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
            box.setFromObject(obj);
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

    decide(teamId, battleState = GameContext.getSerializableBattleState()) {
        const self = battleState.teams[teamId];
        const liveSelf = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        const leadId = this.getWingmanLeadId(teamId);
        const wingmanOrder = this.getWingmanOrder(teamId);

        // Phase 1: wingman support orders (follow / cover / break).
        // attack = lead's target; free = independent hunt (full combat AI).
        if (leadId && liveSelf && liveSelf.aiEnabled && this.isWingmanSupportOrder(wingmanOrder)) {
            const support = this.decideWingmanSupport(teamId, battleState, leadId, wingmanOrder);
            if (support) return support;
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
                const support = this.decideWingmanSupport(teamId, battleState, leadId, 'follow');
                if (support) {
                    support.statusText = (support.statusText || 'NPC: 僚機') + '｜無目標改跟隨';
                    if (!support.debug) support.debug = {};
                    support.debug.wingmanOrder = 'attack';
                    support.debug.wingmanFallback = 'follow';
                    support.debug.leadId = leadId;
                    return support;
                }
                enemyId = null;
            }
        }
        // free / 主動進攻: keep enemyId from getEnemyId (own nearest hostile).

        const enemy = (enemyId && battleState.teams) ? battleState.teams[enemyId] : null;
        const enemyAlive = this.isLivingEnemy(enemyId, battleState);

        if (!self || self.isDestroyed || !self.position || !enemyAlive || !enemy) {
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
                return this.withDebug({
                    state: 'emergencyPullUp',
                    statusText: ultraLow ? `NPC: 極低空改出 ${selfPos.y.toFixed(1)}m` : `NPC: 搜索中地面避撞 ${selfPos.y.toFixed(1)}m`,
                    throttle: recoveryThrottle,
                    joyX: 0,
                    joyY: 1,
                    pitchCmd: -maxPitchCmd,
                    roll: 0,
                    weapon: 'gun',
                    queueAction: 'none',
                    ready: true,
                    reason: selfForward.y < -0.45
                        ? 'Steep dive recovery uses high turn-rate throttle'
                        : (ultraLow ? 'No-contact ultra-low climb-out' : 'No-contact search is overridden by ground safety')
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
        }
        const tuning = this.getTuning();
        const acConfig = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts) ? CONFIG.aircrafts[self.type || 'mig21'] : null;
        const maxPitchCmd = acConfig ? acConfig.maxPitch : Math.PI / 3;
        const coverInfo = this.getCoverInfo(selfPos, selfForward, self.ap || self.speed || 120);
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
        const missileLockRange = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.seekerRange) ? CONFIG.weapons.fox2.seekerRange : 60;
        const missileLockAngle = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.seekerAngle) ? CONFIG.weapons.fox2.seekerAngle : Math.PI / 12;
        const flareTriggerDistance = missileLockRange + (policyMode === 'heuristic' ? 14 : 8);
        const enemyCanLaunchSoon = sensor.seenNow && enemy.weapon === 'missile' && enemyMissileReady && enemyAspectToSelf < Math.PI / 3 && distance < flareTriggerDistance;
        const predictedShotWindow = sensor.seenNow && enemy.weapon === 'missile' && enemyMissileReady && distance < (flareTriggerDistance + 10) && headOnFactor > 0.45 && predictedSeparation < 30;
        const lineOfSightBlocked = this.hasObstacleBetween(enemyPos, selfPos);
        const maskInfo = this.findBestMaskPoint(selfPos, enemyPos, selfForward, self.ap || self.speed || 120);
        const missileMaxRange = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.maxFlightRange)
            ? CONFIG.weapons.fox2.maxFlightRange
            : 65;
        const flareUseDistance = missileMaxRange + 18;
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
        const canUseFlare = (self.flareAmmo || 0) > 0;
        const lowFlareReserve = (self.flareAmmo || 0) <= 1;
        const urgentMissileThreat = actualMissileThreat || (threatLevel === 'high' && distance < flareTriggerDistance);
        const shouldSaveFlare = lowFlareReserve && !urgentMissileThreat;
        const lastFlareTurn = liveSelf ? Number(liveSelf.aiLastFlareTurn || -99) : -99;
        const flareCooldownReady = (turnNo - lastFlareTurn) >= 2;
        const urbanArenaMode = ['sparse-urban', 'medium-urban', 'dense-urban', 'obstacle-stress'].includes(arenaMode);
        const maskCoverAllowed = coverInfo.collisionRisk === 'low' ||
            (urbanArenaMode && coverInfo.collisionRisk === 'medium' && maskInfo.available && maskInfo.score >= 80 && !maskInfo.pathBlocked);
        const terrainSafeForMask = altitude > 24 && maskCoverAllowed && selfForward.y > -0.25;
        const maskUsable = terrainSafeForMask && maskInfo.available && maskInfo.score >= 55 && !maskInfo.pathBlocked;
        const lowAltitudeTacticalBan = altitude < 10 || lowAltRecoverLock.active;
        // Actual inbound FOX-2: flare even if a mask point scores high (mask must not suppress IR defense).
        const heuristicDefensiveFlare =
            policyMode === 'heuristic' &&
            canUseFlare &&
            !lineOfSightBlocked &&
            flareCooldownReady &&
            !shouldSaveFlare &&
            (
                actualMissileThreat ||
                (!maskUsable && missileThreatLikely && enemyCanLaunchSoon && distance <= (flareTriggerDistance + 6))
            );
        const closeRangeActualThreat = actualMissileThreat && distance <= (flareTriggerDistance + 12);
        const shouldFlareNow = !lowAltitudeTacticalBan &&
            canUseFlare &&
            flareCooldownReady &&
            !lineOfSightBlocked &&
            !shouldSaveFlare &&
            (
                actualMissileThreat ||
                (
                    missileThreatLikely &&
                    !maskUsable &&
                    (
                        closeRangeActualThreat ||
                        (threatLevel === 'high' && enemyCanLaunchSoon && distance <= flareTriggerDistance)
                    )
                )
            ) ||
            heuristicDefensiveFlare;
        const missileLock = distance > 25 && distance <= missileLockRange && angleToTarget <= missileLockAngle && !lineOfSightBlocked && localToEnemy.z > 0.82;
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
            flareReserve: self.flareAmmo || 0,
            flareCooldown: flareCooldownReady ? 0 : 1,
            actualMissileThreat: actualMissileThreat ? 1 : 0,
            closeRangeActualThreat: closeRangeActualThreat ? 1 : 0,
            flareTriggerDistance,
            policyMode,
            missileLock: missileLock ? 1 : 0,
            missileLockRange,
            missileLockAngleDeg: Number((missileLockAngle * 180 / Math.PI).toFixed(1)),
            targetLocalX: Number(localToEnemy.x.toFixed(2)),
            targetLocalY: Number(localToEnemy.y.toFixed(2)),
            targetLocalZ: Number(localToEnemy.z.toFixed(2)),
            coverDistance: Number((Number.isFinite(coverInfo.distance) ? coverInfo.distance : -1).toFixed(1)),
            coverForwardDistance: Number((Number.isFinite(coverInfo.forwardDistance) ? coverInfo.forwardDistance : -1).toFixed(1)),
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
            postGroundRecoveryLock: postGroundRecoveryLock.active ? 1 : 0
        };
        const tree = [];
        tree.push(`sensorGate: contact=${sensor.hasContact} seenNow=${sensor.seenNow} mem=${sensor.memoryTurnsLeft} radar=${sensor.radarContact} visual=${sensor.visualContact} los=${sensor.losBlocked} passiveBearing=${passiveSearchBearing ? 1 : 0} passiveRange=${passiveSearchRange} radarR=${this.getSensorProfile(arenaMode).radarRange}`);
        tree.push(`offenseAssist: vsHuman=${offenseAssist.vsHuman ? 1 : 0} pathLead=${offenseAssist.pathLeadCheat ? 1 : 0} deferLevel=${offenseAssist.deferLevelOut ? 1 : 0} gunMul=${offenseAssist.gunRangeMul.toFixed(2)}`);
        tree.push(`lookaheadGate: enabled=${lookaheadAllowed} lead=${lookaheadPlan.leadTurns} profile=${lookaheadPlan.profile} score=${lookaheadPlan.score ?? 'n/a'} angle=${lookaheadPlan.finalAngleDeg ?? '-'} dist=${lookaheadPlan.finalDistance ?? '-'}`);
        tree.push(`loopGate: trap=${loopEval.loopTrap} count=${loopEval.loopCount} dist=${distance.toFixed(1)} ang=${angleToTargetDeg.toFixed(1)} lx=${localToEnemy.x.toFixed(2)}`);
        tree.push(`lowAltLock: active=${lowAltRecoverLock.active} until=${lowAltRecoverLock.untilTurn}`);
        tree.push(`postGroundLock: active=${postGroundRecoveryLock.active} until=${postGroundRecoveryLock.untilTurn}`);
        tree.push(`recoverGate: ap=${Math.floor(self.ap)} stalled=${!!self.stalled} alt=${altitude.toFixed(1)}`);
        tree.push(`coverGate: dist=${debugBase.coverDistance} fwd=${debugBase.coverForwardDistance} risk=${coverInfo.collisionRisk} mode=${coverInfo.mode}`);
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
        const hasAnyMissile = hasArmedMissile || hasStandbyMissile;
        let rangeMode = this.updateWeaponRangeMode(teamId, distance, tuning, urbanArenaMode, coverInfo);
        // FORCE MISSILE: stay in missile mode while pylons remain so gun hysteresis cannot block FOX-2.
        if (overrideMode === 'missile' && hasAnyMissile) {
            rangeMode = 'missile';
            this.weaponRangeMemory[teamId] = 'missile';
        }
        // FOX2-FIRST ambush: start seeker power-up only (never skip to armed / same-turn launch).
        if (
            policyMode === 'fox2-first' &&
            liveSelf && liveSelf.aiFox2OpeningAmbush &&
            hasAnyMissile &&
            !hasArmedMissile &&
            typeof GameContext !== 'undefined' &&
            GameContext.stateMachine &&
            typeof GameContext.stateMachine.armFox2OpeningMissiles === 'function'
        ) {
            GameContext.stateMachine.armFox2OpeningMissiles(teamId, 2);
            hasArmedMissile = (self.pylons || []).some(p => p.state === 'armed');
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
            collisionHigh: coverInfo.collisionRisk === 'high',
            imminentBuildingHit:
                coverInfo.collisionRisk === 'high' &&
                (coverInfo.forwardDistance < 12 || coverInfo.distance < 8),
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
        // fox2-first stays missile-biased; hybrid opening only forces missile while rushing in urban.
        if (openingFox2Rush || policyMode === 'fox2-first') {
            rangeMode = 'missile';
            this.weaponRangeMemory[teamId] = 'missile';
        }
        tree.push(`rangeMode: ${rangeMode} dist=${distance.toFixed(1)}`);
        tree.push(`openingFox2: rush=${openingFox2Rush ? 1 : 0} ambush=${fox2OpeningAmbush ? 1 : 0} policy=${policyMode}`);
        const steepClimb = selfForward.y > 0.42;
        const stallTrap = self.stalled && selfForward.y > tuning.stallPitchThreshold && altitude > tuning.minRecoverAlt;
        tree.push(`energyGate: critical=${energyCritical} low=${energyLow} steepClimb=${steepClimb} stallTrap=${stallTrap}`);

        // Hard ground risk only when altitude/dive actually threaten terrain.
        // Mild dive inside combat band (e.g. 51m / fwdY=-0.22) must NOT force groundAvoid.
        const groundRisk =
            altitude < 18 ||
            (altitude < 28 && selfForward.y < -0.12) ||
            (altitude < 40 && selfForward.y < -0.32) ||
            (altitude < 52 && selfForward.y < -0.55);
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
        const urbanAvoidSide = committedAvoidSide || rawAvoidSide || breakSide;
        tree.push(`urbanAvoidMemory: side=${urbanAvoidSide} geom=${geometricAvoidSide} committed=${committedAvoidSide ? 1 : 0} until=${urbanAvoidMemory.untilTurn}`);

        const urbanObstacles = this.getObstacles();
        const denseUrban = this.isDenseUrbanContext(arenaMode, urbanObstacles);
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
            angleDeg: angleToTargetDeg
        };
        const closeCombatUrbanDefer = this.isCloseCombatUrbanDefer(urbanRouteCtx, tuning);
        const imminentBuildingHit =
            coverInfo.collisionRisk === 'high' &&
            (coverInfo.forwardDistance < 12 || coverInfo.distance < 8);
        // Hard-only building abort for fox2 perch (side clutter must not cancel rooftop climb).
        const strictImminentBuilding =
            coverInfo.distance < 6 ||
            (coverInfo.collisionRisk === 'high' &&
                Number.isFinite(coverInfo.forwardDistance) &&
                coverInfo.forwardDistance > 0 &&
                coverInfo.forwardDistance < 10);
        const fox2PerchWindow =
            policyMode === 'fox2-first' &&
            fox2OpeningAmbush &&
            turnNo <= 24 &&
            hasAnyMissile &&
            !actualMissileThreat &&
            !enemyMissileInFlight &&
            !strictImminentBuilding;
        tree.push(`urbanCombatGate: defer=${closeCombatUrbanDefer} imminentBldg=${imminentBuildingHit} strictBldg=${strictImminentBuilding} perch=${fox2PerchWindow ? 1 : 0} dist=${distance.toFixed(1)} ang=${angleToTargetDeg.toFixed(1)}`);

        const imminentGroundImpact = altitude < 12 || (altitude < 26 && selfForward.y < -0.45);
        // High building risk: run urban escape before dive pull-up, including mid-band altitudes in dense maps.
        // FOX2-FIRST opening perch: only hard building hits may cancel the climb-out.
        if (
            !imminentGroundImpact &&
            urbanArenaMode &&
            !(fox2PerchWindow || openingFox2Rush) &&
            (
                (coverInfo.collisionRisk === 'high' && (altitude < 42 || denseUrban || Number(coverInfo.distance) < 14 || Number(coverInfo.forwardDistance) < 16)) ||
                (obstacleStressMode && coverInfo.collisionRisk === 'medium' && altitude < 34)
            )
        ) {
            this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 5);
            const routedEmergency = this.pickUrbanRoute(teamId, urbanRouteCtx, debugBase, tree);
            if (routedEmergency) return routedEmergency;
            const tightEscape = coverInfo.distance < 6 || coverInfo.forwardDistance < 10;
            const lowAltitudeEscape = altitude < 22;
            const lowEnergyEscape = self.ap < tuning.lowAp + 4 && !lowAltitudeEscape;
            const flareWhileEscape =
                actualMissileThreat &&
                canUseFlare &&
                flareCooldownReady &&
                !shouldSaveFlare &&
                !lineOfSightBlocked &&
                altitude >= 14;
            return this.withDebug({
                state: flareWhileEscape ? 'defensiveFlare' : (lowEnergyEscape ? 'obstacleEnergyClimb' : 'obstacleEmergencyEscape'),
                statusText: flareWhileEscape
                    ? `NPC: 避撞熱焰 ${debugBase.coverDistance}m`
                    : `NPC: 建築緊急脫離 ${debugBase.coverDistance}m`,
                throttle: lowAltitudeEscape ? (self.heat > 72 ? 4 : 5) : (self.heat > 76 ? 3 : 4),
                joyX: this.clamp(urbanAvoidSide * (lowEnergyEscape ? 0.34 : (tightEscape ? 0.58 : 0.44)), -0.68, 0.68),
                joyY: lowAltitudeEscape ? 0.68 : (lowEnergyEscape ? 0.28 : 0.38),
                pitchCmd: -maxPitchCmd * (lowAltitudeEscape ? 0.68 : (lowEnergyEscape ? 0.32 : 0.42)),
                roll: this.clamp(urbanAvoidSide * (lowEnergyEscape ? Math.PI / 12 : Math.PI / 6.5), -Math.PI / 6.5, Math.PI / 6.5),
                weapon: 'gun',
                queueAction: flareWhileEscape ? 'flare' : 'none',
                ready: true,
                reason: flareWhileEscape
                    ? 'Actual missile threat: flare while obstacle-escaping'
                    : 'Obstacle escape uses brake-turn unless low altitude requires climb'
            }, debugBase, [...tree, `selected: ${flareWhileEscape ? 'defensiveFlare-obstacleEscape' : 'obstacleEmergencyEscape'}`], flareWhileEscape ? 'defensiveFlare' : 'obstacleEmergencyEscape');
        }

        if (altitude < 20 || (altitude < 45 && selfForward.y < -0.2)) {
            const extremeLow = altitude < 8;
            const steepDive = selfForward.y < -0.45;
            const hardGroundAbort = altitude < 14 || (altitude < 20 && selfForward.y < -0.5);
            const recoveryThrottle = this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0);
            const lateral = this.getEmergencyPullUpLateral({
                distance,
                headOnFactor,
                localToEnemy,
                breakSide: urbanAvoidSide || breakSide,
                altitude
            });
            // Actual FOX-2 inbound: do not let pull-up fully suppress flares while still flyable.
            const flareDuringPull =
                actualMissileThreat &&
                canUseFlare &&
                flareCooldownReady &&
                altitude >= 18 &&
                !hardGroundAbort &&
                !extremeLow;
            if (flareDuringPull) {
                const breakJoyX = lateral.active
                    ? lateral.joyX
                    : this.clamp((-horizontalBias * 0.55) + (0.4 * (urbanAvoidSide || breakSide)), -0.9, 0.9);
                return this.withDebug({
                    state: 'defensiveFlare',
                    statusText: `NPC: 低空熱焰+拉起 ${altitude.toFixed(1)}m`,
                    throttle: recoveryThrottle,
                    joyX: breakJoyX,
                    joyY: Math.max(0.58, (lateral.active ? lateral.joyYScale : 1) * 0.78),
                    pitchCmd: -maxPitchCmd * (lateral.active ? 0.78 : 0.85),
                    roll: lateral.active
                        ? lateral.roll
                        : this.clamp(breakJoyX * Math.PI / 5, -Math.PI / 5, Math.PI / 5),
                    weapon: 'gun',
                    queueAction: 'flare',
                    ready: true,
                    reason: 'Actual missile threat: flare while recovering from dive'
                }, debugBase, [...tree, `selected: defensiveFlare-pullUp lateral=${lateral.active ? 1 : 0}`], 'defensiveFlare');
            }
            return this.withDebug({
                state: 'emergencyPullUp',
                statusText: lateral.active
                    ? `NPC: 緊急拉起脫離 ${altitude.toFixed(1)}m`
                    : `NPC: 緊急拉起 ${altitude.toFixed(1)}m`,
                throttle: recoveryThrottle,
                joyX: lateral.joyX,
                joyY: lateral.joyYScale,
                pitchCmd: -maxPitchCmd * (lateral.active ? 0.92 : 1),
                roll: lateral.roll,
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: lateral.active
                    ? 'Low-altitude pull-up with lateral break to avoid midair co-track'
                    : (steepDive
                        ? 'Steep dive recovery prioritizes turn rate over AB thrust'
                        : (extremeLow ? 'Extreme low altitude full-power pull-up' : 'Low altitude overrides all collision logic'))
            }, debugBase, [...tree, `selected: emergencyPullUp lateral=${lateral.active ? 1 : 0}`], 'emergencyPullUp');
        }

        if (lowAltRecoverLock.active) {
            const lowAltRecover = altitude < 10;
            const recoveryThrottle = this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0);
            const lateral = this.getEmergencyPullUpLateral({
                distance,
                headOnFactor,
                localToEnemy,
                breakSide: urbanAvoidSide || breakSide,
                altitude
            });
            return this.withDebug({
                state: 'emergencyRecoverLock',
                statusText: `NPC: 低空保命鎖定 ${altitude.toFixed(1)}m`,
                throttle: lowAltRecover ? recoveryThrottle : (self.heat > 40 ? 4 : recoveryThrottle),
                joyX: lateral.active ? lateral.joyX : 0,
                joyY: (lowAltRecover ? 0.95 : 0.55) * (lateral.active ? lateral.joyYScale : 1),
                pitchCmd: lowAltRecover ? -maxPitchCmd : -(maxPitchCmd * 0.65),
                roll: lateral.active ? lateral.roll : 0,
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: lateral.active
                    ? 'Low-alt recovery lock with lateral separation'
                    : 'Two-turn low-altitude recovery lock'
            }, debugBase, [...tree, `selected: emergencyRecoverLock lateral=${lateral.active ? 1 : 0}`], 'emergencyRecoverLock');
        }

        if (postGroundRecoveryLock.active && altitude < tuning.combatBandMin) {
            const combatEngaged = sensor.hasContact && distance < 220 && angleToTargetDeg < 115;
            // Do not swallow missile defense while climbing out — flare/evade must remain reachable.
            const missileDefenseNeeded = actualMissileThreat && altitude >= 18 && (self.flareAmmo || 0) > 0;
            // Opening FOX-2: keep climbing toward rooftop perch while turning — do not freeze joyX=0.
            if (!combatEngaged && !missileDefenseNeeded && !openingFox2Rush) {
            const bandRemaining = tuning.combatBandMin - altitude;
            const steepDive = selfForward.y < -0.35;
            const recoveryThrottle = steepDive
                ? this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0)
                : (self.heat > 78 ? 4 : 5);
            return this.withDebug({
                state: 'postGroundClimbOut',
                statusText: `NPC: 低空改出延伸 ${altitude.toFixed(1)}m`,
                throttle: recoveryThrottle,
                joyX: 0,
                joyY: steepDive ? 0.95 : (bandRemaining > 12 ? 0.58 : (bandRemaining > 6 ? 0.34 : 0.1)),
                pitchCmd: steepDive ? -maxPitchCmd : (-maxPitchCmd * (bandRemaining > 10 ? 0.48 : 0.28)),
                roll: 0,
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: 'Extend climb only until combat band minimum before reacquiring target'
            }, debugBase, [...tree, 'selected: postGroundClimbOut'], 'postGroundClimbOut');
            }
            tree.push(`postGroundGate: deferred=${missileDefenseNeeded ? 'missileThreat' : (openingFox2Rush ? 'openingFox2' : 'combat')} dist=${distance.toFixed(1)} ang=${angleToTargetDeg.toFixed(1)}`);
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
            forwardY: selfForward.y
        });
        tree.push(`alignFirstGate: need=${alignBeforeAccel ? 1 : 0} losClear=${lineOfSightBlocked ? 0 : 1} seen=${sensor.seenNow ? 1 : 0} ang=${angleToTargetDeg.toFixed(1)} lz=${localToEnemy.z.toFixed(2)} fwdY=${selfForward.y.toFixed(2)}`);

        // FOX2-FIRST opening: power seekers first; only shoot once a pylon is armed (next turn).
        const openingHardGround =
            altitude < 14 ||
            (altitude < 20 && selfForward.y < -0.45) ||
            (altitude < 28 && selfForward.y < -0.55);
        const openingEnvelope =
            (openingFox2Rush || fox2PerchWindow) &&
            coverInfo.collisionRisk !== 'high' &&
            !strictImminentBuilding &&
            !openingHardGround &&
            !lineOfSightBlocked &&
            !actualMissileThreat;
        const openingShotReady =
            openingEnvelope &&
            hasArmedMissile &&
            distance >= tuning.missileMinRange &&
            distance <= Math.max(missileLockRange + 8, tuning.missileMaxRange) &&
            angleToTargetDeg < 48 &&
            localToEnemy.z > 0.52;
        if (openingShotReady) {
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

        if (alignBeforeAccel && !(openingFox2Rush || fox2PerchWindow)) {
            const alignCtrl = this.buildAlignBeforeAccelControls({
                angleDeg: angleToTargetDeg,
                localToEnemy,
                forwardY: selfForward.y,
                altitude,
                breakSide: urbanAvoidSide || breakSide,
                baseHorizontalBias
            });
            const preferMsl = hasAnyMissile && (rangeMode === 'missile' || policyMode === 'fox2-first' || openingFox2Rush);
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
        if (alignBeforeAccel && (openingFox2Rush || fox2PerchWindow) && !openingShotReady) {
            const alignCtrl = this.buildAlignBeforeAccelControls({
                angleDeg: angleToTargetDeg,
                localToEnemy,
                forwardY: selfForward.y,
                altitude,
                breakSide: urbanAvoidSide || breakSide,
                baseHorizontalBias
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
                distance >= tuning.missileMinRange &&
                distance <= Math.max(missileLockRange + 8, tuning.missileMaxRange) &&
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
                queueAction: 'none',
                ready: true,
                reason: behind
                    ? 'Opening fox2-first: MIL/ECO reverse toward target (AB blocked while off-boresight)'
                    : 'Opening fox2-first: already at perch — power pylons and close'
            }, debugBase, [...tree, `selected: ${behind ? 'reacquire-opening' : 'missilePrep-opening'} roof=0 aspect=${aspectOk ? 1 : 0} noseSeek=${noseSeeking ? 1 : 0} thr=${rushThrottle}`], behind ? 'reacquire' : 'missilePrep');
        }

        const altitudeBand = this.getCombatAltitudeProfile(altitude, tuning);
        tree.push(`altitudeBandGate: zone=${altitudeBand.zone} excess=${altitudeBand.excess.toFixed(1)}`);
        if (altitudeBand.needsLevelOut && !groundRisk && coverInfo.collisionRisk !== 'high' && !offenseAssist.deferLevelOut && !openingFox2Rush) {
            return this.withDebug({
                state: 'altitudeBandLevelOut',
                statusText: `NPC: 作戰高度回收 ${altitude.toFixed(1)}m`,
                throttle: self.heat > 78 ? 3 : 4,
                joyX: this.clamp(horizontalBias * 0.22, -0.32, 0.32),
                joyY: altitudeBand.levelOutJoyY,
                pitchCmd: maxPitchCmd * altitudeBand.levelOutPitch,
                roll: 0,
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: 'Descend back into combat altitude band instead of escaping vertically'
            }, debugBase, [...tree, 'selected: altitudeBandLevelOut'], 'altitudeBandLevelOut');
        }

        if (coverInfo.distance < 3 || (coverInfo.collisionRisk === 'high' && altitude < 22)) {
            const obstacleDir = coverInfo.direction || new THREE.Vector3(breakSide, 0, 0);
            const sideSign = Math.sign(selfForward.clone().cross(obstacleDir).y || breakSide);
            return this.withDebug({
                state: 'terrainEscape',
                statusText: `NPC: 地形脫離 ALT ${altitude.toFixed(1)} CVR ${debugBase.coverDistance}m`,
                throttle: self.heat > 78 ? 3 : 5,
                joyX: this.clamp(sideSign * 0.28, -0.34, 0.34),
                joyY: altitude < 28 ? 0.8 : 0.45,
                pitchCmd: -maxPitchCmd * 0.8,
                roll: this.clamp(sideSign * Math.PI / 12, -Math.PI / 12, Math.PI / 12),
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: 'Too close to terrain/building for lateral evade'
            }, debugBase, [...tree, 'selected: terrainEscape'], 'terrainEscape');
        }

        if (groundRisk) {
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
        if (shallowDiveLevel && offenseAssist.deferLevelOut) {
            tree.push('shallowDiveGate: deferred=offenseAssist');
        }
        if (shallowDiveLevel && openingFox2Rush) {
            tree.push('shallowDiveGate: deferred=openingFox2');
        }
        if (shallowDiveLevel && actualMissileThreat) {
            tree.push('shallowDiveGate: deferred=missileThreat');
        }
        if (shallowDiveLevel && !offenseAssist.deferLevelOut && !openingFox2Rush && !actualMissileThreat) {
            // Soft nose-up only; keep turning toward target instead of freezing joyX=0.
            const preferMissile = rangeMode === 'missile' && hasAnyMissile && distance > tuning.gunRange + 8;
            const nearMissileLock =
                preferMissile &&
                hasArmedMissile &&
                distance <= missileLockRange + 8 &&
                angleToTarget <= Math.max(missileLockAngle * 1.35, (tuning.missileAngle * Math.PI / 180)) &&
                localToEnemy.z > 0.7 &&
                !lineOfSightBlocked;
            return this.withDebug({
                state: nearMissileLock ? 'missileAttack' : 'shallowDiveLevel',
                statusText: nearMissileLock
                    ? `NPC: 改平 FOX-2 ${Math.floor(distance)}m`
                    : `NPC: 淺俯衝改平 ${altitude.toFixed(1)}m`,
                throttle: self.heat > 78 ? 3 : 4,
                joyX: this.clamp(horizontalBias * (nearMissileLock ? 0.35 : 0.55), -0.7, 0.7),
                joyY: this.clamp(0.18 + Math.min(0.22, Math.abs(selfForward.y) * 0.35), 0.12, 0.4),
                pitchCmd: -maxPitchCmd * 0.28,
                roll: this.clamp(horizontalBias * Math.PI / 6, -Math.PI / 6, Math.PI / 6),
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

        if (stallTrap && coverInfo.collisionRisk !== 'high') {
            const unloadPitch = altitude > 40 ? 0.4 : 0.18;
            const breakJoyX = this.clamp(horizontalBias * 0.2, -0.18, 0.18);
            const breakThr = this.pickThrottleForTurn(
                self.heat > 78 ? 3 : 4,
                breakJoyX,
                { heat: self.heat || 0, ap: self.ap, energyCritical: true }
            );
            return this.withDebug({
                state: 'stallBreakout',
                statusText: `NPC: 失速改出 AP ${Math.floor(self.ap)} FWDY ${selfForward.y.toFixed(2)}`,
                throttle: breakThr,
                joyX: breakJoyX,
                joyY: altitude > 40 ? -0.45 : -0.16,
                pitchCmd: maxPitchCmd * unloadPitch,
                roll: 0,
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: 'Break stall by unloading nose and rebuilding airflow'
            }, debugBase, [...tree, 'selected: stallBreakout'], 'stallBreakout');
        }

        if (self.stalled && coverInfo.collisionRisk !== 'high') {
            const lowAltRecover = altitude < 26;
            const divingStall = selfForward.y < -0.12;
            const recoverPitchCmd = (lowAltRecover && divingStall)
                ? -maxPitchCmd
                : (lowAltRecover ? -maxPitchCmd * 0.32 : maxPitchCmd * 0.26);
            // Ultra-low diving stall: keep nose authority; otherwise ECO + light turn toward fight.
            const recoveryThrottle = (lowAltRecover && divingStall)
                ? this.getEmergencyRecoveryThrottle(altitude, selfForward.y, self.heat || 0)
                : this.pickThrottleForTurn(3, 0.45, { heat: self.heat || 0, ap: self.ap, stalled: true, energyCritical: true });
            const recoverJoyX = (lowAltRecover && divingStall)
                ? 0
                : this.clamp(horizontalBias * 0.42, -0.48, 0.48);
            return this.withDebug({
                state: 'stallRecoverNoRoll',
                statusText: recoverJoyX
                    ? `NPC: 失速ECO改出 AP ${Math.floor(self.ap)} ALT ${altitude.toFixed(1)}`
                    : `NPC: 失速強制改出 AP ${Math.floor(self.ap)} ALT ${altitude.toFixed(1)}`,
                throttle: recoveryThrottle,
                joyX: recoverJoyX,
                joyY: (lowAltRecover && divingStall) ? 1 : (lowAltRecover ? 0.22 : -0.34),
                pitchCmd: recoverPitchCmd,
                roll: this.clamp(recoverJoyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8),
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: recoverJoyX
                    ? 'Stall recovery with ECO turn authority (Phase A)'
                    : 'Force no-roll stall recovery to regain controllability'
            }, debugBase, [...tree, `selected: stallRecoverNoRoll turn=${recoverJoyX ? 1 : 0}`], 'stallRecoverNoRoll');
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
            (
                coverInfo.collisionRisk === 'medium' ||
                coverInfo.collisionRisk === 'high' ||
                (!energyLow && this.isForwardBuildingPressure(coverInfo, 28, 40)) ||
                (maskInfo.available && maskInfo.distance < 58 && !closeCombatUrbanDefer && distance > tuning.gunRange + 25)
            );
        if (earlyUrbanPressure) {
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
                joyY: altitude < 28 ? 0.38 : (wideTurn ? 0.08 : 0.18),
                roll: this.clamp(preemptJoyX * Math.PI / 5.5, -Math.PI / 5.5, Math.PI / 5.5),
                weapon: 'gun',
                queueAction: 'none',
                ready: true,
                reason: 'Preempt medium urban collision risk before emergency distance'
            }, debugBase, [...tree, 'selected: urbanPreemptiveAvoid'], 'urbanPreemptiveAvoid');
        }

        const obstacleLoopRisk = loopEval.loopTrap || energyLow || self.stalled || self.ap < 72;
        if (
            (coverInfo.collisionRisk === 'high' || (obstacleStressMode && coverInfo.collisionRisk === 'medium')) &&
            !(closeCombatUrbanDefer && !imminentBuildingHit)
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

        const imminentMerge = distance < 42 && closureSpeed > 0.12;
        const riskyHeadOn = distance < 95 && headOnFactor > 0.46 && predictedSeparation < 32;
        const mandatoryMergeBreak =
            !lowAltitudeTacticalBan &&
            coverInfo.collisionRisk !== 'high' &&
            (
                (distance < 34 && predictedSeparation < 24) ||
                (headOnFactor > 0.62 && predictedSeparation < 20)
            );
        const forwardCommitWindow =
            !lineOfSightBlocked &&
            localToEnemy.z > 0.86 &&
            angleToTarget < Math.PI / 8 &&
            distance > 34 &&
            distance < 62 &&
            predictedSeparation > 28 &&
            !riskyHeadOn &&
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
        tree.push(`orbitGate: stalemate=${orbitStalemate} openSky=${openSkyOrbit ? 1 : 0} closure=${closureSpeed.toFixed(3)} sep=${predictedSeparation.toFixed(1)} headOn=${headOnFactor.toFixed(2)}`);

        // Missile envelope comes before orbit cut-in so FOX-2 can arm/lock instead of gun-only circling.
        const missileAngleRadEarly = (tuning.missileAngle * Math.PI / 180);
        const forceMissileOverride = overrideMode === 'missile' && hasAnyMissile;
        const inMissileEnvelope =
            hasAnyMissile &&
            (forceMissileOverride || rangeMode === 'missile') &&
            distance >= tuning.missileMinRange &&
            distance <= Math.max(tuning.missileMaxRange, missileLockRange + 8) &&
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
            const shouldShootMissile = earlyMissileLock && !frontAspectHardBan;
            const prepJoyX = this.resolveTurnJoyX(
                horizontalBias * (shouldShootMissile ? 0.35 : 1.1),
                localToEnemy,
                angleToTargetDeg,
                urbanAvoidSide || breakSide,
                shouldShootMissile ? 0.28 : 0.7
            );
            return this.withDebug({
                state: shouldShootMissile ? 'missileAttack' : 'missilePrep',
                statusText: shouldShootMissile
                    ? `NPC: FOX-2 LOCK ${Math.floor(distance)}m`
                    : `NPC: 飛彈通電/對準 ${Math.floor(distance)}m`,
                throttle: self.heat > 72 ? 3 : 4,
                joyX: prepJoyX,
                joyY: this.clamp(
                    shouldShootMissile
                        ? verticalBias * 0.22
                        : (Math.abs(prepJoyX) > 0.7 ? Math.min(verticalBias * 0.25, 0.12) : verticalBias * 0.42),
                    -0.28,
                    0.32
                ),
                roll: this.clamp(prepJoyX * (shouldShootMissile ? Math.PI / 8 : Math.PI / 4), -Math.PI / 4, Math.PI / 4),
                weapon: 'missile',
                powerPylons: !hasArmedMissile,
                queueAction: shouldShootMissile ? 'missile' : 'none',
                singleMissile: shouldShootMissile,
                ready: true,
                reason: shouldShootMissile
                    ? 'Missile seeker lock in envelope'
                    : 'Power pylons and nose toward target before orbit/gun logic'
            }, debugBase, [...tree, `selected: ${shouldShootMissile ? 'missileAttack-early' : 'missilePrep-early'}`], shouldShootMissile ? 'missileAttack' : 'missilePrep');
        }

        if (orbitStalemate && coverInfo.collisionRisk !== 'high' && !groundRisk) {
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
            distance < Math.max(tuning.gunRange + 22, tuning.missileMaxRange);
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
            (mediumLane || sideLanePressure) &&
            (
                sideLanePressure ||
                angleToTargetDeg > 40 ||
                headOnFactor > 0.62 ||
                coverFwd <= 0 ||
                (maskInfo.available && Number(maskInfo.score) >= 60)
            );
        tree.push(`weaveGate: window=${offensiveWeaveWindow ? 1 : 0} sideLane=${sideLanePressure ? 1 : 0} cover=${Number.isFinite(Number(coverInfo.distance)) ? Number(coverInfo.distance).toFixed(1) : '-'} fwd=${Number.isFinite(coverFwd) ? coverFwd.toFixed(1) : '-'}`);
        // Never steal mandatory deconfliction; weave only wins over optional merge / reacquire / gun.
        if (offensiveWeaveWindow && !mandatoryMergeBreak) {
            this.updateUrbanAvoidMemory(teamId, urbanAvoidSide, turnNo, 4);
            const routedWeave = this.pickUrbanRoute(teamId, urbanRouteCtx, debugBase, tree);
            if (
                routedWeave &&
                (routedWeave.state === 'urbanBuildingWeave' ||
                    (routedWeave.urbanRoute && routedWeave.urbanRoute.source === 'urbanBuildingWeave'))
            ) {
                return routedWeave;
            }
            // Planner may skip weave when risk=low side lane; force a level side weave instead of gun-dive.
            if ((sideLanePressure || coverFwd <= 0 || !Number.isFinite(coverFwd)) && Number(coverInfo.distance) >= 14) {
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
            tree.push('weaveGate: deferred=plannerNonWeave');
        }

        if ((mandatoryMergeBreak || optionalMergeBreak) && !holdMissileThroughMerge) {
            const hardBreak = mandatoryMergeBreak || distance < 28;
            const flareOnMerge =
                actualMissileThreat &&
                canUseFlare &&
                flareCooldownReady &&
                !shouldSaveFlare &&
                altitude >= 14;
            const mergeJoyX = this.clamp(breakSide * (hardBreak ? 0.92 : 0.72), -1, 1);
            const mergeThr = this.pickThrottleForTurn(
                self.heat > 76 ? 3 : 4,
                mergeJoyX,
                { heat: self.heat || 0, ap: self.ap, lowAp: tuning.lowAp }
            );
            return this.withDebug({
                state: flareOnMerge ? 'defensiveFlare' : (hardBreak ? 'mandatoryMergeBreak' : 'mergeBreak'),
                statusText: flareOnMerge
                    ? `NPC: 迎頭熱焰脫離 ${Math.floor(distance)}m`
                    : `NPC: 迎頭避撞 ${Math.floor(distance)}m`,
                throttle: mergeThr,
                joyX: mergeJoyX,
                joyY: altitude < 24 ? 0.34 : (hardBreak ? 0.12 : 0.04),
                roll: this.clamp(breakSide * (hardBreak ? Math.PI / 4 : Math.PI / 5), -Math.PI / 4, Math.PI / 5),
                weapon: 'gun',
                queueAction: flareOnMerge ? 'flare' : 'none',
                ready: true,
                reason: flareOnMerge
                    ? 'Merge break with flare under actual missile threat'
                    : (hardBreak ? 'Mandatory deconfliction before head-on collision' : 'Break merge before missile tactics')
            }, debugBase, [...tree, `selected: ${flareOnMerge ? 'defensiveFlare-merge' : (hardBreak ? 'mandatoryMergeBreak' : 'mergeBreak')} thr=${mergeThr}`], flareOnMerge ? 'defensiveFlare' : (hardBreak ? 'mandatoryMergeBreak' : 'mergeBreak'));
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
            distance < Math.max(tuning.gunRange + 22, tuning.missileMaxRange);
        const yieldReacquireForLane = sideLanePressure && reacquireCombatBand;
        const reacquireHardNeeded = !actualMissileThreat &&
            coverInfo.collisionRisk === 'low' &&
            !yieldReacquireForLane &&
            !groundRisk &&
            !energyCritical &&
            angleToTarget > (offenseAssist.hardReacquireBoost ? Math.PI / 4.5 : Math.PI / 3);
        const reacquireSoftGun =
            !actualMissileThreat &&
            coverInfo.collisionRisk === 'low' &&
            !yieldReacquireForLane &&
            !groundRisk &&
            !energyCritical &&
            angleToTarget > Math.PI / 4 &&
            angleToTarget <= Math.PI / 3 &&
            distance < tuning.gunRange + 15 &&
            angleToTarget < ((tuning.gunAngle * Math.PI / 180)) &&
            predictedSeparation > 14;
        tree.push(`reacquireGate: hard=${reacquireHardNeeded} softGun=${reacquireSoftGun} yieldLane=${yieldReacquireForLane ? 1 : 0} forceMsl=${forceMissileOverride ? 1 : 0} localX=${debugBase.targetLocalX} localY=${debugBase.targetLocalY} localZ=${debugBase.targetLocalZ}`);
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
                        (distance >= tuning.missileMinRange &&
                            distance <= Math.max(tuning.missileMaxRange, missileLockRange + 8) &&
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
                    queueAction: forceShoot ? 'missile' : 'none',
                    singleMissile: forceShoot,
                    ready: true,
                    reason: forceShoot
                        ? 'FORCE MISSILE lock while recovering aspect'
                        : 'FORCE MISSILE turn-back with pylons powered'
                }, debugBase, [...tree, `selected: ${forceShoot ? 'missileAttack-forceReacquire' : 'missilePrep-forceReacquire'}`], forceShoot ? 'missileAttack' : 'missilePrep');
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
            !lineOfSightBlocked &&
            localToEnemy.z > (distance < tuning.gunRange + 12 ? 0.84 : 0.88) &&
            angleToTarget < (distance < tuning.gunRange + 12 ? Math.PI / 7 : Math.PI / 9) &&
            distance < (distance < tuning.gunRange + 12 ? tuning.gunRange + 15 : 65);
        tree.push(`missileThreat: active=${enemyMissileInFlight} queued=${enemyMissileQueued} ready=${enemyMissileReady} LOS=${lineOfSightBlocked} level=${threatLevel} score=${threatScore.toFixed(2)} evade=${missileThreatEvade} reserve=${self.flareAmmo || 0} flareNow=${shouldFlareNow} commit=${canOffensiveCommit}`);
        if (missileThreatEvade && !canOffensiveCommit) {
            const useMaskPoint = maskUsable && !shouldFlareNow && (self.flareAmmo || 0) > 0;
            const maskState = maskInfo.masked ? 'maskedHold' : maskInfo.state;
            const maskDirection = maskInfo.direction;
            const maskJoyX = maskDirection ? this.clamp(maskDirection.x * (maskState === 'maskIngress' ? 0.95 : 0.55), -0.8, 0.8) : this.clamp(horizontalBias * 0.2, -0.35, 0.35);
            const maskJoyY = maskDirection ? this.clamp(maskDirection.y * 0.35, -0.3, 0.3) : this.clamp(verticalBias * 0.18 + 0.1, -0.3, 0.3);
            // Empty flares + inbound FOX-2: hard lateral break and unload steep climb (do not balloon into the seeker).
            const emptyFlarePanic = actualMissileThreat && !canUseFlare;
            const panicSide = urbanAvoidSide || breakSide;
            const evadeJoyX = useMaskPoint
                ? maskJoyX
                : (emptyFlarePanic
                    ? this.clamp((-horizontalBias * 0.25) + (0.95 * panicSide), -1, 1)
                    : this.clamp((-horizontalBias * 0.85) + (0.45 * breakSide), -1, 1));
            const evadeJoyY = useMaskPoint
                ? maskJoyY
                : (emptyFlarePanic
                    ? (steepClimb || selfForward.y > 0.35
                        ? -0.22
                        : (altitude < 20 ? 0.42 : 0.12))
                    : (altitude < 14 ? 0.6 : this.clamp(verticalBias * 0.2 + 0.25, -0.25, 0.55)));
            return this.withDebug({
                state: shouldFlareNow ? 'defensiveFlare' : (useMaskPoint ? maskState : 'evade'),
                statusText: shouldFlareNow
                    ? `NPC: 飛彈威脅，釋放熱焰`
                    : (useMaskPoint
                        ? (maskState === 'maskIngress' ? 'NPC: 前往遮蔽點' : (maskState === 'maskedHold' ? 'NPC: 保持遮蔽' : 'NPC: 轉入遮蔽點'))
                        : (emptyFlarePanic ? 'NPC: 無熱焰硬脫離' : 'NPC: 飛彈威脅，急轉規避')),
                throttle: useMaskPoint
                    ? (maskState === 'maskIngress' ? 4 : 3)
                    : (emptyFlarePanic ? (self.heat > 78 ? 3 : 4) : (self.heat > 70 ? 3 : 4)),
                joyX: evadeJoyX,
                joyY: evadeJoyY,
                roll: useMaskPoint
                    ? this.clamp(maskJoyX * Math.PI / 4, -Math.PI / 4, Math.PI / 4)
                    : this.clamp(evadeJoyX * Math.PI / 3.6, -Math.PI / 3.6, Math.PI / 3.6),
                weapon: hasArmedMissile ? 'missile' : 'gun',
                queueAction: shouldFlareNow ? 'flare' : 'none',
                ready: true,
                reason: emptyFlarePanic
                    ? 'No flares left: hard break and unload to defeat IR seeker'
                    : 'Likely incoming missile'
            }, debugBase, [...tree, `selected: ${shouldFlareNow ? 'defensiveFlare' : (useMaskPoint ? maskState : (emptyFlarePanic ? 'evadeEmptyFlare' : 'evadeNoFlare'))}`], shouldFlareNow ? 'defensiveFlare' : (useMaskPoint ? maskState : 'evade'));
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
        const missilePrepWindow = hasAnyMissile && !hasArmedMissile && distance >= tuning.missileMinRange && distance < (tuning.missileMaxRange + (!urbanArenaMode && coverInfo.collisionRisk === 'low' ? 90 : 65)) && angleToTarget < (!urbanArenaMode && coverInfo.collisionRisk === 'low' ? Math.PI * 0.55 : Math.PI / 2) && (forceMissileOverride || rangeMode === 'missile');
        const extendedMissileAttack = hasArmedMissile && !urbanArenaMode && coverInfo.collisionRisk === 'low' && !frontAspectPenalty &&
            distance >= tuning.missileMinRange && distance <= Math.min(tuning.missileMaxRange, missileLockRange + 28) &&
            angleToTarget <= Math.max(missileAngleRad * 1.6, missileLockAngle * 1.25) && localToEnemy.z > 0.55 && !lineOfSightBlocked;
        const missileAttackWindow = (hasArmedMissile && missileLock && !frontAspectPenalty && distance >= tuning.missileMinRange && distance <= Math.min(tuning.missileMaxRange, missileLockRange + 8) && angleToTarget <= Math.max(missileAngleRad * 1.25, missileLockAngle * 1.1)) || extendedMissileAttack;
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
            const mslJoyX = this.resolveTurnJoyX(
                horizontalBias * (shouldShootMissile ? 0.28 : 1.05),
                localToEnemy,
                angleToTargetDeg,
                urbanAvoidSide || breakSide,
                shouldShootMissile ? 0.22 : 0.65
            );
            const openSkyMsl = !urbanArenaMode && coverInfo.collisionRisk === 'low';
            const mslThrottle =
                self.heat > (openSkyMsl ? 76 : 68) ? 3 :
                shouldShootMissile ? 3 :
                (openSkyMsl && self.heat < 60 && distance > 55 ? 5 : 4);
            const mslStatus = forcedMissile
                ? (shouldShootMissile ? `NPC: 人工 FOX-2 LOCK` : `NPC: 人工飛彈對準中`)
                : (shouldShootMissile ? (extendedMissileAttack ? `NPC: FOX-2 開闊窗口 ${Math.floor(distance)}m` : `NPC: FOX-2 LOCK ${Math.floor(distance)}m`) : 'NPC: 飛彈通電/保持角度');
            const mslReason = shouldShootMissile
                ? (extendedMissileAttack ? 'Extended open-sky missile window' : 'Missile seeker lock confirmed')
                : 'Power pylons or keep turning for lock';
            return this.withDebug({
                state: shouldShootMissile ? 'missileAttack' : 'missilePrep',
                statusText: mslStatus,
                throttle: mslThrottle,
                joyX: mslJoyX,
                joyY: shouldShootMissile
                    ? this.clamp(verticalBias * 0.2, -0.18, 0.22)
                    : this.clamp(Math.abs(mslJoyX) > 0.7 ? Math.min(verticalBias * 0.22, 0.1) : verticalBias * 0.4, -0.25, 0.3),
                roll: shouldShootMissile
                    ? this.clamp(mslJoyX * Math.PI / 8, -Math.PI / 8, Math.PI / 8)
                    : this.clamp(mslJoyX * Math.PI / 4, -Math.PI / 4, Math.PI / 4),
                weapon: 'missile',
                powerPylons: !hasArmedMissile,
                queueAction: shouldShootMissile ? 'missile' : 'none',
                singleMissile: shouldShootMissile,
                ready: true,
                reason: mslReason
            }, debugBase, [...tree, `selected: ${shouldShootMissile ? (extendedMissileAttack ? 'missileAttack-extended' : 'missileAttack') : 'missilePrep'}`], shouldShootMissile ? 'missileAttack' : 'missilePrep');
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
    },

    normalizePolicyMode(mode) {
        return ['heuristic', 'hybrid', 'fox2-first'].includes(mode) ? mode : 'heuristic';
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
        const gunSweetSpot = distance < (urbanPressure ? 50 : 65) && angleDeg < (urbanPressure ? 25 : 30);
        if (action.queueAction === 'missile') {
            const missileGood = distance > 30 && distance < (urbanPressure ? 95 : 105) && angleDeg < (urbanPressure ? 28 : 32);
            score += missileGood ? (urbanPressure ? 55 : 70) : -35;
        }
        if (action.queueAction === 'gun') {
            score += gunSweetSpot ? (urbanPressure ? 42 : 58) : -18;
            if (distance < 35 && angleDeg < 22) score += 12;
        }
        if (!gunSweetSpot && distance < 110 && angleDeg < 45 && (action.queueAction === 'none' || !action.queueAction)) {
            score -= 10 * openSkyBonus;
        }
        if (ap < 70 && throttle >= 4) score += 18;
        if (ap < 58 && joyMag > 1.0) score -= (22 + tuning.climbPenalty * 0.75);
        if (ap < 55 && throttle === 5) score -= 34;
        if (action.state && String(action.state).includes('recover')) score += (10 + tuning.stallRecoverBonus * 0.45);
        if (action.powerPylons && distance > 40 && distance < 120 && !urbanPressure) score += 18;
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
        const hasAnyMissile = hasArmedMissile || (self.pylons || []).some(p => p.state === 'standby');

        const baseGunIntent = baseAction.queueAction === 'gun' || baseAction.state === 'gunAttack';
        const baseMissileIntent = baseAction.queueAction === 'missile' || baseAction.state === 'missileAttack';
        const pressGunWindow = dist < tuning.gunRange + (urbanPressure ? 15 : 25) && angle < tuning.gunAngle * (urbanPressure ? 1.15 : 1.4);
        const pressMissileWindow = hasArmedMissile && dist > 32 && dist < (urbanPressure ? 95 : 110) && angle < (urbanPressure ? 26 : 34);
        const aggression = tuning.hybridAggression * openSkyFactor;
        let pressQueue = 'none';
        if (baseGunIntent && pressGunWindow) {
            pressQueue = 'gun';
        } else if (baseMissileIntent && pressMissileWindow) {
            pressQueue = 'missile';
        } else if (pressMissileWindow) {
            pressQueue = 'missile';
        } else if (pressGunWindow || (dist < (urbanPressure ? 42 : 55) && angle < (urbanPressure ? 22 : 28))) {
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
        // fox2-first keeps pure FSM decisions — hybridPress must never override flares/level-outs.
        if (mode === 'heuristic' || mode === 'fox2-first' || !action) {
            if (action) {
                action.debug = {
                    ...(action.debug || {}),
                    policy: {
                        mode,
                        selectedState: action.state || 'unknown',
                        baseState: action.state || 'unknown',
                        selectedScore: null,
                        overridden: false,
                        ...(mode === 'fox2-first' ? { lockedByDoctrine: true } : {})
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
            'openingRoofDash'
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
        const battleState = GameContext.getSerializableBattleState();
        const leadId = this.getWingmanLeadId(teamId);
        const wingmanOrder = this.getWingmanOrder(teamId);
        const action = this.decide(teamId, battleState);
        const isWingmanSupport = !!(leadId && this.isWingmanSupportOrder(wingmanOrder) && action && String(action.state || '').indexOf('wingman') === 0);
        const policyAction = isWingmanSupport ? action : this.applyPolicyMode(teamId, action, battleState);
        const safeAction = this.chooseSafeAction(teamId, policyAction);
        const team = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(teamId) : null;
        if (team && team.wrapper && safeAction && !isWingmanSupport) {
            const selfPos = team.wrapper.position;
            const selfForward = new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize();
            const selfPitch = Math.asin(this.clamp(selfForward.y, -1, 1));
            const selfAp = typeof team.ap === 'number' ? team.ap : (team.speed || 120);
            const coverInfo = this.getCoverInfo(selfPos, selfForward, selfAp);
            this.adjustActionForCombatBand(safeAction, selfPos.y, coverInfo, this.getTuning(), selfPitch, selfAp);
        }
        if (leadId && (wingmanOrder === 'attack' || wingmanOrder === 'free') && safeAction) {
            const label = this.getWingmanOrderLabel(wingmanOrder);
            if (safeAction.statusText && String(safeAction.statusText).indexOf(label) < 0) {
                safeAction.statusText = `${safeAction.statusText}｜${label}`;
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

        // Phase A: hard turns keep ECO/MIL — never AB while demanding turn authority.
        if (safeAction && team) {
            const tuning = this.getTuning();
            this.enforceEnergyTurnConsistency(safeAction, {
                heat: team.heat || 0,
                ap: typeof team.ap === 'number' ? team.ap : null,
                energyCritical: typeof team.ap === 'number' && team.ap < tuning.energyCriticalAp,
                stalled: !!team.stalled,
                lowAp: tuning.lowAp
            });
        }

        GameContext.stateMachine.applyPilotAction(teamId, safeAction);
        return safeAction;
    }
};
