// ============================================================================
// state-machine-match.js - Match Setup / seat activation API mixin
// ============================================================================
window.StateMachineMatchApi = {
    /**
     * Place teams by altitude + red/blue centerline separation (Z).
     * Cross: axis opponents = sep; 斜鄰 = sep/√2 (283 → 200).
     * Pair: preserves wingman lateral offsets (+8x, ±4z).
     */
    applySpawnLayout(opts = {}) {
        const cfg = GameContext.getMatchConfig ? GameContext.getMatchConfig() : {};
        const altitude = (GameContext.sanitizeSpawnAltitude
            ? GameContext.sanitizeSpawnAltitude(opts.altitude != null ? opts.altitude : cfg.spawnAltitude)
            : Number(opts.altitude || cfg.spawnAltitude || 45));
        const separation = (GameContext.sanitizeSpawnSeparation
            ? GameContext.sanitizeSpawnSeparation(opts.separation != null ? opts.separation : cfg.spawnSeparation)
            : Number(opts.separation || cfg.spawnSeparation || 100));
        const formation = (opts.formation === 'cross' || cfg.spawnFormation === 'cross')
            ? 'cross'
            : 'pair';
        const facingRaw = opts.facing || opts.spawnFacing || cfg.spawnFacing;
        const facing = (facingRaw === 'face' || facingRaw === 'outbound' || facingRaw === 'tangent' || facingRaw === 'chase')
            ? facingRaw
            : (formation === 'cross' ? 'tangent' : 'face');
        const half = separation * 0.5;
        let cx = 10;
        let cz = 0;
        try {
            const map = (typeof CONFIG !== 'undefined' && CONFIG.map) ? CONFIG.map : {};
            if (Number.isFinite(Number(map.centerX))) cx = Number(map.centerX);
            if (formation === 'cross' && Number.isFinite(Number(map.centerZ))) cz = Number(map.centerZ);
        } catch (_) { /* keep defaults */ }
        let spots;
        if (formation === 'cross') {
            // Cardinal cross around map center: red N, blue S, red2 W, blue2 E.
            // inbound yaw flies at the city; tangent = +90° clockwise orbit;
            // outbound = +180° away from center. faceOpponent is skipped unless facing=face.
            const inbound = {
                red: 0,
                blue: Math.PI,
                red2: Math.PI / 2,
                blue2: -Math.PI / 2
            };
            const extra = facing === 'outbound'
                ? Math.PI
                : (facing === 'tangent' || facing === 'chase' ? Math.PI / 2 : 0);
            spots = {
                red: { x: cx, y: altitude, z: cz - half, yaw: inbound.red + extra },
                blue: { x: cx, y: altitude, z: cz + half, yaw: inbound.blue + extra },
                red2: { x: cx - half, y: altitude, z: cz, yaw: inbound.red2 + extra },
                blue2: { x: cx + half, y: altitude, z: cz, yaw: inbound.blue2 + extra }
            };
        } else if (facing === 'chase') {
            // Lab booth: red behind blue, same heading. Rotate by batchIndex (0/90/180/270).
            let yaw = 0;
            try {
                const idx = (typeof AirArenaBatchRun !== 'undefined' && AirArenaBatchRun.readQuery)
                    ? AirArenaBatchRun.readQuery().batchIndex
                    : (cfg && cfg.batchIndex);
                yaw = (typeof AirArenaBatchRun !== 'undefined' && AirArenaBatchRun.chaseHeadingRad)
                    ? AirArenaBatchRun.chaseHeadingRad(idx)
                    : ((((Number(idx) || 1) - 1) % 4) * Math.PI / 2);
            } catch (_) { yaw = 0; }
            const fwdX = Math.sin(yaw);
            const fwdZ = Math.cos(yaw);
            const rightX = Math.cos(yaw);
            const rightZ = -Math.sin(yaw);
            const place = (along, right) => ({
                x: cx + fwdX * along + rightX * right,
                y: altitude,
                z: fwdZ * along + rightZ * right,
                yaw
            });
            spots = {
                red: place(-half, 0),
                red2: place(-half - 4, 8),
                blue: place(half, 0),
                blue2: place(half + 4, 8)
            };
        } else {
            const wingX = 8;
            const wingZ = 4;
            spots = {
                red: { x: cx, y: altitude, z: -half, yaw: 0 },
                red2: { x: cx + wingX, y: altitude, z: -half - wingZ, yaw: 0 },
                blue: { x: cx, y: altitude, z: half, yaw: Math.PI },
                blue2: { x: cx + wingX, y: altitude, z: half + wingZ, yaw: Math.PI }
            };
        }
        Object.keys(spots).forEach((id) => {
            const t = this.getTeamOrNull(id);
            if (!t || !t.wrapper) return;
            const spot = spots[id];
            t.wrapper.position.set(spot.x, spot.y, spot.z);
            t.wrapper.rotation.set(0, spot.yaw, 0);
            t.wrapper.quaternion.setFromEuler(t.wrapper.rotation);
            t.wrapper.userData.logicalQuat = t.wrapper.quaternion.clone();
            if (!t.startPos) t.startPos = t.wrapper.position.clone();
            else t.startPos.copy(t.wrapper.position);
            if (!t.startQuat) t.startQuat = t.wrapper.quaternion.clone();
            else t.startQuat.copy(t.wrapper.quaternion);
            if (typeof initialPositions !== 'undefined' && initialPositions[id]) {
                if (initialPositions[id].pos) initialPositions[id].pos.copy(t.wrapper.position);
                if (initialPositions[id].quat) initialPositions[id].quat.copy(t.wrapper.quaternion);
            }
            t.pathPoints = null;
            t.pathQuats = null;
            t.chain = null;
        });
        if (GameContext.state) {
            if (!GameContext.state.matchConfig) {
                GameContext.state.matchConfig = GameContext.createDefaultMatchConfig(
                    (cfg && cfg.mode) || '1v1'
                );
            }
            GameContext.state.matchConfig.spawnAltitude = altitude;
            GameContext.state.matchConfig.spawnSeparation = separation;
            GameContext.state.matchConfig.spawnFormation = formation;
            GameContext.state.matchConfig.spawnFacing = facing;
        }
        return { altitude, separation, formation, facing };
    },

    applyMatchConfig(config) {
        const cfg = GameContext.setMatchConfig(config || GameContext.getMatchConfig());
        GameContext.state.matchReady = false;
        const is2v2 = cfg.mode === '2v2';
        const usedPilots = [];
        if (typeof window.clearAircraftDebris === 'function') {
            try { window.clearAircraftDebris(); } catch (_) { /* ignore */ }
        }
        if (typeof AirArenaBomb !== 'undefined' && typeof AirArenaBomb.clearBombVisuals === 'function') {
            try { AirArenaBomb.clearBombVisuals({ dispose: true }); } catch (_) { /* ignore */ }
        }
        if (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.clearRocketVisuals === 'function') {
            try { AirArenaRocket.clearRocketVisuals({ dispose: true }); } catch (_) { /* ignore */ }
        }
        if (typeof AirArenaGroundTargets !== 'undefined' && typeof AirArenaGroundTargets.resetHp === 'function') {
            try { AirArenaGroundTargets.resetHp(); } catch (_) { /* ignore */ }
        }
        if (typeof AirArenaAI !== 'undefined' && AirArenaAI.mergeDivergeMemory) {
            AirArenaAI.mergeDivergeMemory = {};
        }

        // Spawn altitude / separation before facing / AI enable.
        const laid = this.applySpawnLayout({
            altitude: cfg.spawnAltitude,
            separation: cfg.spawnSeparation,
            formation: cfg.spawnFormation,
            facing: cfg.spawnFacing
        });
        const faceOnEnable = !laid || laid.facing === 'face';

        const setUnitActive = (teamId, active) => {
            const t = this.getTeamOrNull(teamId);
            if (!t) return;
            const acCfg = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts && CONFIG.aircrafts[t.type || 'mig21'])
                || { startAp: 120, startSpeed: 30 };
            const idleHeat = (typeof getEngineHeatIdle === 'function')
                ? getEngineHeatIdle()
                : ((typeof CONFIG !== 'undefined' && CONFIG.rules && Number.isFinite(Number(CONFIG.rules.minHeat))) ? Number(CONFIG.rules.minHeat) : 150);
            const initFlareAmmo = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.flare && Number.isFinite(Number(CONFIG.weapons.flare.ammo)))
                ? Number(CONFIG.weapons.flare.ammo) : 3;
            const initChaffAmmo = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.chaff && Number.isFinite(Number(CONFIG.weapons.chaff.ammo)))
                ? Number(CONFIG.weapons.chaff.ammo) : 3;
            const defFuze = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.rocket && CONFIG.weapons.rocket.defaultFuze === 'impact')
                ? 'impact' : 'vt';

            t.matchActive = !!active;
            if (t.wrapper) t.wrapper.visible = !!active;
            t.ready = false;
            t.wpnQueued = false;
            t.queuedAction = 'none';
            t.isDestroyed = false;
            t.deathCause = null;
            t.deathStalled = null;
            t.deathAp = null;
            t.killedBy = null;
            t.lastCombatHitBy = null;
            t.killCredited = false;
            t.combatKills = 0;
            t.combatKillsGun = 0;
            t.combatKillsMsl = 0;
            t.combatKillsFox1 = 0;
            t.combatKillsFox2 = 0;
            t.missileShots = [];
            t.rocketShots = [];
            t.damageDealtByWeapon = { gun: 0, fox1: 0, fox2: 0, rocket: 0, bomb: 0 };
            t.gunHitTurns = 0;
            t.gunHitSteps = 0;
            t.stallTurns = 0;
            t.flaresExpended = 0;
            t.chaffExpended = 0;
            t.wreckPhase = null;
            t.wreckBurstTurn = 0;
            t.hp = MAX_HP;
            t.ap = Number.isFinite(Number(acCfg.startAp)) ? Number(acCfg.startAp) : 120;
            t.speed = Number.isFinite(Number(acCfg.startSpeed)) ? Number(acCfg.startSpeed) : 30;
            t.heat = idleHeat;
            t.flameout = false;
            t.gunHeat = 0;
            t.stalled = false;
            t.flareAmmo = initFlareAmmo;
            t.chaffAmmo = initChaffAmmo;
            t.flaresArmed = false;
            t.chaffArmed = false;
            t.wasFlaresArmedThisTurn = false;
            t.wasChaffArmedThisTurn = false;
            t.lockedTargetId = null;
            t.designatedGroundTargetId = null;
            t.rocketFuze = defFuze;
            t.fox2LaunchCommit = null;
            t.activeMissiles = [];
            t.activeBombs = [];
            t.activeRockets = [];
            t.aiLastAction = null;
            t.aiPreDeathAction = null;
            t.aiTacticalRole = null;
            t.aiTacticalRoleWhy = null;
            t.aiTacticalRoleUntilTurn = -1;
            t.aiDecisionTrail = [];
            t.aiDecisionTrailFrozen = false;
            t.aiWeaponCounters = null;
            if (Array.isArray(t.aiDebugTrace)) t.aiDebugTrace = [];
            if (!active) {
                t.aiEnabled = false;
                t.aiState = 'player';
                t.aiStatusText = 'STANDBY';
            } else {
                if (t.wrapper) t.wrapper.visible = true;
            }
        };

        setUnitActive('red', true);
        setUnitActive('blue', true);
        setUnitActive('red2', is2v2);
        setUnitActive('blue2', is2v2);

        const lab = typeof AirArenaChallenges !== 'undefined'
            && AirArenaChallenges.isLab
            && AirArenaChallenges.isLab(cfg.challengeId);
        if (!lab && typeof AirArenaPilotRoster !== 'undefined' && AirArenaPilotRoster.assignCatalogPilots) {
            AirArenaPilotRoster.assignCatalogPilots(
                cfg.seats,
                is2v2 ? ['red-1', 'red-2', 'blue-1', 'blue-2'] : ['red-1', 'blue-1']
            );
        }

        const applySeat = (seatId, teamId) => {
            const seat = cfg.seats[seatId];
            if (!seat || !teamId) return;
            const t = this.getTeamOrNull(teamId);
            if (!t || t.matchActive === false) return;
            seat.teamId = teamId;
            seat.deferred = false;

            if (seat.control === 'ai') {
                if (seat.loadout === 'fox2-priority') t.aiPolicyMode = 'fox2-first';
                else if (seat.loadout === 'fox1-priority') t.aiPolicyMode = 'fox1-first';
                else if (seat.loadout === 'gun-priority') t.aiPolicyMode = 'heuristic';
                else t.aiPolicyMode = 'hybrid';
                const modelId = (typeof AirArenaAIRegistry !== 'undefined' && AirArenaAIRegistry.isKnownModel && AirArenaAIRegistry.isKnownModel(seat.aiModel))
                    ? seat.aiModel
                    : ((typeof AirArenaAIRegistry !== 'undefined' && AirArenaAIRegistry.DEFAULT_MODEL) || 'test_01');
                t.aiModel = modelId;
                this.setAIEnabled(teamId, true);
                if (seat.loadout === 'fox2-priority' || seat.loadout === 'fox1-priority') {
                    this.forceWeaponMode(teamId, 'missile');
                } else {
                    this.forceWeaponMode(teamId, 'gun');
                }
            } else {
                t.aiModel = null;
                this.setAIEnabled(teamId, false);
                if (seat.loadout === 'fox2-priority' || seat.loadout === 'fox1-priority') {
                    this.forceWeaponMode(teamId, 'missile');
                } else {
                    this.forceWeaponMode(teamId, 'gun');
                }
            }
            let pylons = seat.pylons;
            if (seat.loadout === 'gun-priority' || seat.loadout === 'fox1-priority' || seat.loadout === 'fox2-priority') {
                pylons = (typeof pylonsForLoadout === 'function')
                    ? pylonsForLoadout(seat.loadout)
                    : (seat.loadout === 'gun-priority'
                        ? ['empty', 'empty', 'empty', 'empty']
                        : (seat.loadout === 'fox1-priority'
                            ? ['fox1', 'fox1', 'fox1', 'fox1']
                            : ['fox2', 'fox2', 'fox2', 'fox2']));
            } else if (seat.loadout === 'standard') {
                // Migrate legacy 4×FOX-2 / empty "standard" seats to 2×F1+2×F2.
                const allFox2 = Array.isArray(pylons) && pylons.length >= 4 && pylons.every((w) => w === 'fox2');
                const allEmpty = Array.isArray(pylons) && pylons.length >= 4 && pylons.every((w) => w === 'empty');
                if (!Array.isArray(pylons) || pylons.length < 4 || allFox2 || allEmpty) {
                    pylons = (typeof defaultPylonLoadout === 'function')
                        ? defaultPylonLoadout()
                        : ['fox1', 'fox2', 'fox2', 'fox1'];
                }
            }
            t.pendingPylonLoadout = (typeof sanitizePylonLoadout === 'function')
                ? sanitizePylonLoadout(pylons)
                : (Array.isArray(pylons) ? pylons.slice(0, 4) : ['fox1', 'fox2', 'fox2', 'fox1']);
            if (typeof AirArenaPilotRoster !== 'undefined' && AirArenaPilotRoster.applyToTeam) {
                const requested = seat.pilotId === 'random' ? null : seat.pilotId;
                const pid = AirArenaPilotRoster.resolveSeatPilotId(
                    seatId,
                    requested,
                    usedPilots,
                    `${cfg.challengeId || 'skirmish'}:${seatId}:${cfg.playerFaction || 'red'}`
                );
                seat.pilotId = pid;
                usedPilots.push(pid);
                AirArenaPilotRoster.applyToTeam(t, pid);
            }
            if (t.pylons) {
                t.pylons.forEach((p) => {
                    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
                });
                t.pylons = null;
            }
        };

        applySeat('red-1', 'red');
        applySeat('blue-1', 'blue');

        if (is2v2) {
            applySeat('red-2', 'red2');
            applySeat('blue-2', 'blue2');
            if (typeof tryAttachAllPylons === 'function') {
                try { tryAttachAllPylons(); } catch (e) { /* ignore */ }
            }
            if (faceOnEnable) {
                ['red', 'red2', 'blue', 'blue2'].forEach((id) => {
                    const t = this.getTeamOrNull(id);
                    if (!t || !t.matchActive) return;
                    this.faceOpponent(id);
                });
            }
        } else {
            if (cfg.seats['red-2']) {
                cfg.seats['red-2'].teamId = 'red2';
                cfg.seats['red-2'].deferred = true;
            }
            if (cfg.seats['blue-2']) {
                cfg.seats['blue-2'].teamId = 'blue2';
                cfg.seats['blue-2'].deferred = true;
            }
            if (faceOnEnable) {
                this.faceOpponent('red');
                this.faceOpponent('blue');
            }
            if (typeof tryAttachAllPylons === 'function') {
                try { tryAttachAllPylons(); } catch (e) { /* ignore */ }
            }
        }

        GameContext.state.matchReady = true;
        if (window.AirArenaMultiView && typeof window.AirArenaMultiView.resetTo === 'function') {
            const prefer = (GameContext.getActiveTeamId && GameContext.getActiveTeamId()) || 'red';
            window.AirArenaMultiView.resetTo(prefer);
        }
        if (typeof window.uiRefreshTeamModeButtons === 'function') window.uiRefreshTeamModeButtons();
        return cfg;
    }
};
