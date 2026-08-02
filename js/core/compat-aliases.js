// ============================================================================
// compat-aliases.js - deprecated window / script-scope aliases
// ============================================================================

// ---------------------------------------------------------------------------
// @deprecated Phase 1 相容別名 — 新程式碼請用 GameContext.state.*
// ---------------------------------------------------------------------------
let battleLog = state.battleLog;
let globalFlares = state.globalFlares;
let globalChaff = state.globalChaff;
let globalBullets = state.globalBullets;

let initialPositions = state.initialPositions;
let teams = state.teams;
let pastTrajectories = state.pastTrajectories;
let trajectoryMeshes = state.trajectoryMeshes;

Object.defineProperty(window, 'missileMeshBase', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.missileMeshBase; },
    set(v) { GameContext.state.missileMeshBase = v; }
});

Object.defineProperty(window, 'tAct', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.activeTeamId; },
    set(v) { GameContext.state.activeTeamId = v; }
});

Object.defineProperty(window, 'P', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.getActiveTeam(); },
    set() { /* derived; use GameContext.setActiveTeamId */ }
});

Object.defineProperty(window, 'isAnimating', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.isAnimating; },
    set(v) { GameContext.state.isAnimating = !!v; }
});

Object.defineProperty(window, 'animProgress', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.animProgress; },
    set(v) { GameContext.state.animProgress = v; }
});

Object.defineProperty(window, 'currentTurn', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.currentTurn; },
    set(v) { GameContext.state.currentTurn = v; }
});

Object.defineProperty(window, 'replayMode', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.replayMode; },
    set(v) { GameContext.state.replayMode = !!v; }
});

Object.defineProperty(window, 'activeTeamId', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.activeTeamId; },
    set(v) { GameContext.state.activeTeamId = v; }
});

Object.defineProperty(window, 'mslVisOffset', {
    configurable: true,
    enumerable: true,
    get() { return GameContext.state.mslVisOffset; },
    set(v) { GameContext.state.mslVisOffset = v; }
});
