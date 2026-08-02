// ============================================================================
// state-machine-wreck.js - soft-kill wreck fall / debris API mixin
// ============================================================================
window.StateMachineWreckApi = {
    markDestroyedFlightState(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        t.ap = 0;
        t.throttle = 1;
        t.ready = true;
        if (typeof this.markAIDestroyedStatus === 'function') {
            this.markAIDestroyedStatus(teamId);
        }
        return true;
    },

    beginWreckFall(teamId, burstAfterTurns = 1) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        t.isDestroyed = true;
        t.wreckPhase = 'falling';
        t.wreckBurstTurn = Number(GameContext.state.currentTurn || 1) + Math.max(1, burstAfterTurns);
        this.markDestroyedFlightState(teamId);
        if (t.wrapper) {
            t.wrapper.visible = true;
            if (t.wrapper.userData.exhaust) t.wrapper.userData.exhaust.group.visible = false;
        }
        return true;
    },

    finalizeWreckBurst(teamId) {
        const t = this.getTeamOrNull(teamId);
        if (!t) return false;
        const pos = t.wrapper ? t.wrapper.position.clone() : null;
        const quat = t.wrapper
            ? (t.wrapper.userData.logicalQuat || t.wrapper.quaternion).clone()
            : null;
        t.wreckPhase = 'gone';
        t.isDestroyed = true;
        this.markDestroyedFlightState(teamId);
        if (pos && typeof window.spawnAircraftDebris === 'function') {
            window.spawnAircraftDebris(pos, quat, t.colorMain);
        }
        if (t.wrapper) t.wrapper.visible = false;
        return true;
    }
};
