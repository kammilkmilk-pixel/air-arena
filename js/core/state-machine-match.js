// ============================================================================
// state-machine-match.js - Match Setup / seat activation API mixin
// ============================================================================
window.StateMachineMatchApi = {
    /**
     * Place teams by altitude + red/blue centerline separation (Z).
     * Preserves wingman lateral offsets (+8x, ±4z).
     */
    applySpawnLayout(opts = {}) {
        const cfg = GameContext.getMatchConfig ? GameContext.getMatchConfig() : {};
        const altitude = (GameContext.sanitizeSpawnAltitude
            ? GameContext.sanitizeSpawnAltitude(opts.altitude != null ? opts.altitude : cfg.spawnAltitude)
            : Number(opts.altitude || cfg.spawnAltitude || 45));
        const separation = (GameContext.sanitizeSpawnSeparation
            ? GameContext.sanitizeSpawnSeparation(opts.separation != null ? opts.separation : cfg.spawnSeparation)
            : Number(opts.separation || cfg.spawnSeparation || 100));
        const half = separation * 0.5;
        const wingX = 8;
        const wingZ = 4;
        const layout = {
            red: { x: 10, y: altitude, z: -half, yaw: 0 },
            red2: { x: 10 + wingX, y: altitude, z: -half - wingZ, yaw: 0 },
            blue: { x: 10, y: altitude, z: half, yaw: Math.PI },
            blue2: { x: 10 + wingX, y: altitude, z: half + wingZ, yaw: Math.PI }
        };
        Object.keys(layout).forEach((id) => {
            const t = this.getTeamOrNull(id);
            if (!t || !t.wrapper) return;
            const spot = layout[id];
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
            // Clear path preview so next plan starts from new spawn.
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
        }
        return { altitude, separation };
    },

    applyMatchConfig(config) {
        const cfg = GameContext.setMatchConfig(config || GameContext.getMatchConfig());
        GameContext.state.matchReady = false;
        const is2v2 = cfg.mode === '2v2';

        // Spawn altitude / separation before facing / AI enable.
        this.applySpawnLayout({
            altitude: cfg.spawnAltitude,
            separation: cfg.spawnSeparation
        });

        const setUnitActive = (teamId, active) => {
            const t = this.getTeamOrNull(teamId);
            if (!t) return;
            t.matchActive = !!active;
            if (t.wrapper) t.wrapper.visible = !!active;
            if (!active) {
                t.ready = false;
                t.aiEnabled = false;
                t.aiState = 'player';
                t.aiStatusText = 'STANDBY';
                t.isDestroyed = false;
                t.deathCause = null;
                t.deathStalled = null;
                t.deathAp = null;
                t.wreckPhase = null;
                t.wreckBurstTurn = 0;
                t.hp = MAX_HP;
                t.aiLastAction = null;
                t.aiPreDeathAction = null;
                t.aiDecisionTrail = [];
                t.aiDecisionTrailFrozen = false;
                if (Array.isArray(t.aiDebugTrace)) t.aiDebugTrace = [];
            } else {
                t.isDestroyed = false;
                t.deathCause = null;
                t.deathStalled = null;
                t.deathAp = null;
                t.wreckPhase = null;
                t.wreckBurstTurn = 0;
                t.hp = MAX_HP;
                t.aiLastAction = null;
                t.aiPreDeathAction = null;
                t.aiDecisionTrail = [];
                t.aiDecisionTrailFrozen = false;
                if (Array.isArray(t.aiDebugTrace)) t.aiDebugTrace = [];
                if (t.wrapper) t.wrapper.visible = true;
            }
        };

        setUnitActive('red', true);
        setUnitActive('blue', true);
        setUnitActive('red2', is2v2);
        setUnitActive('blue2', is2v2);

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
                this.setAIEnabled(teamId, true);
                if (seat.loadout === 'fox2-priority' || seat.loadout === 'fox1-priority') {
                    this.forceWeaponMode(teamId, 'missile');
                } else {
                    this.forceWeaponMode(teamId, 'gun');
                }
            } else {
                this.setAIEnabled(teamId, false);
                if (seat.loadout === 'fox2-priority' || seat.loadout === 'fox1-priority') {
                    this.forceWeaponMode(teamId, 'missile');
                } else {
                    this.forceWeaponMode(teamId, 'gun');
                }
            }
            let pylons = seat.pylons;
            if (seat.loadout === 'fox1-priority') {
                const hasFox1 = Array.isArray(pylons) && pylons.some((w) => w === 'fox1');
                if (!hasFox1) pylons = ['fox1', 'fox1', 'fox1', 'fox1'];
            } else if (seat.loadout === 'standard') {
                // Migrate legacy 4×FOX-2 "standard" seats to 2×F1+2×F2.
                const allFox2 = Array.isArray(pylons) && pylons.length >= 4 && pylons.every((w) => w === 'fox2');
                if (!Array.isArray(pylons) || pylons.length < 4 || allFox2) {
                    pylons = (typeof defaultPylonLoadout === 'function')
                        ? defaultPylonLoadout()
                        : ['fox1', 'fox2', 'fox2', 'fox1'];
                }
            } else if (seat.loadout === 'fox2-priority') {
                const hasFox2 = Array.isArray(pylons) && pylons.some((w) => w === 'fox2');
                if (!hasFox2) pylons = ['fox2', 'fox2', 'fox2', 'fox2'];
            }
            t.pendingPylonLoadout = (typeof sanitizePylonLoadout === 'function')
                ? sanitizePylonLoadout(pylons)
                : (Array.isArray(pylons) ? pylons.slice(0, 4) : ['fox1', 'fox2', 'fox2', 'fox1']);
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
            ['red', 'red2', 'blue', 'blue2'].forEach((id) => {
                const t = this.getTeamOrNull(id);
                if (!t || !t.matchActive) return;
                this.faceOpponent(id);
            });
        } else {
            if (cfg.seats['red-2']) {
                cfg.seats['red-2'].teamId = 'red2';
                cfg.seats['red-2'].deferred = true;
            }
            if (cfg.seats['blue-2']) {
                cfg.seats['blue-2'].teamId = 'blue2';
                cfg.seats['blue-2'].deferred = true;
            }
            this.faceOpponent('red');
            this.faceOpponent('blue');
            if (typeof tryAttachAllPylons === 'function') {
                try { tryAttachAllPylons(); } catch (e) { /* ignore */ }
            }
        }

        GameContext.state.matchReady = true;
        return cfg;
    }
};
