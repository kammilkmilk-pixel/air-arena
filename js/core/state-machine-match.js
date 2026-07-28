// ============================================================================
// state-machine-match.js - Match Setup / seat activation API mixin
// ============================================================================
window.StateMachineMatchApi = {
    applyMatchConfig(config) {
        const cfg = GameContext.setMatchConfig(config || GameContext.getMatchConfig());
        GameContext.state.matchReady = false;
        const is2v2 = cfg.mode === '2v2';

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
                t.wreckPhase = null;
                t.wreckBurstTurn = 0;
                t.hp = MAX_HP;
            } else {
                t.isDestroyed = false;
                t.wreckPhase = null;
                t.wreckBurstTurn = 0;
                t.hp = MAX_HP;
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
                else if (seat.loadout === 'gun-priority') t.aiPolicyMode = 'heuristic';
                else t.aiPolicyMode = 'hybrid';
                this.setAIEnabled(teamId, true);
                if (seat.loadout === 'fox2-priority') this.forceWeaponMode(teamId, 'missile');
                else this.forceWeaponMode(teamId, 'gun');
            } else {
                this.setAIEnabled(teamId, false);
                if (seat.loadout === 'fox2-priority') this.forceWeaponMode(teamId, 'missile');
                else this.forceWeaponMode(teamId, 'gun');
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
        }

        GameContext.state.matchReady = true;
        return cfg;
    }
};
