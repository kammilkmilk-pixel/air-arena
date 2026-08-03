// ============================================================================
// team-state.js - constants, team factories, TeamView accessors
// ============================================================================

if (typeof THREE === 'undefined') throw new Error("Three.js is not loaded.");
if (typeof GameContext === 'undefined') throw new Error("GameContext is not loaded.");

const state = GameContext.state;

const MAX_HP = CONFIG.aircrafts['mig21'].maxHp;
const MAX_HEAT = CONFIG.rules.maxHeat;
const MAX_AP = CONFIG.rules.maxAp;

const GUN_DAMAGE = CONFIG.weapons['gun'].damage;
const GUN_RANGE = CONFIG.weapons['gun'].range;
const GUN_ANGLE = CONFIG.weapons['gun'].angle;
const BULLET_SPEED = 4.0;
/** @deprecated Use GUN_RANGE — kept as alias for old call sites. */
const DYNAMIC_GUN_RANGE = GUN_RANGE;

// Legacy module globals mirror FOX-2 (IR default). Prefer getMissileWeaponConfig(type)
// or AirArenaWeaponEnvelope.getMissileCombatEnvelope(type) for typed munitions.
const _FOX2_WPN = CONFIG.weapons.fox2;
const MISSILE_DAMAGE = _FOX2_WPN.damage;
const MISSILE_SCALE = _FOX2_WPN.model.scale;
const MISSILE_ROT_X = _FOX2_WPN.model.rotX;
const MISSILE_ROT_Y = _FOX2_WPN.model.rotY;
const MISSILE_ROT_Z = _FOX2_WPN.model.rotZ;
const MISSILE_MAX_AP = _FOX2_WPN.maxAp;
const SEEKER_RANGE = _FOX2_WPN.seekerRange;
const SEEKER_ANGLE = _FOX2_WPN.seekerAngle;
const SEEKER_MIN_HEAT = _FOX2_WPN.seekerMinHeat;

const MISSILE_SPEED = _FOX2_WPN.speed;
const MISSILE_TURN_RATE = _FOX2_WPN.turnRate;
const MISSILE_DRAG = _FOX2_WPN.drag;

GameContext.constants = {
    MAX_HP, MAX_HEAT, MAX_AP,
    GUN_DAMAGE, GUN_RANGE, GUN_ANGLE, BULLET_SPEED, DYNAMIC_GUN_RANGE,
    MISSILE_DAMAGE, MISSILE_SCALE, MISSILE_ROT_X, MISSILE_ROT_Y, MISSILE_ROT_Z,
    MISSILE_MAX_AP, SEEKER_RANGE, SEEKER_ANGLE, SEEKER_MIN_HEAT,
    MISSILE_SPEED, MISSILE_TURN_RATE, MISSILE_DRAG
};

state.mslVisOffset = new THREE.Vector3(0.0, 0.0, 0.0);

function createTeamState(id, colorMain, matchActive = true) {
    return {
        id,
        type: 'mig21',
        colorMain,
        matchActive: !!matchActive,
        wrapper: null,
        hp: MAX_HP,
        isDestroyed: false,
        ap: CONFIG.aircrafts['mig21'].baseAp || 165,
        speed: CONFIG.aircrafts['mig21'].baseAp || 165,
        heat: (typeof getEngineHeatIdle === 'function') ? getEngineHeatIdle() : 150,
        /** Machine-gun barrel heat 0–1 (overheat blocks fire). */
        gunHeat: 0,
        flameout: false,
        throttle: 4,
        chain: [],
        stalled: false,
        gLimiterOn: true,
        weapon: 'gun',
        wpnQueued: false,
        flareAmmo: CONFIG.weapons['flare'].maxAmmo,
        chaffAmmo: (CONFIG.weapons.chaff && CONFIG.weapons.chaff.maxAmmo) ? CONFIG.weapons.chaff.maxAmmo : 3,
        flaresArmed: false,
        chaffArmed: false,
        pendingPylonLoadout: null,
        ready: false,
        aiEnabled: false,
        aiState: 'player',
        aiStatusText: 'PLAYER CONTROL',
        aiLastAction: null,
        aiPreDeathAction: null,
        aiManualOverride: 'auto',
        aiPolicyMode: 'heuristic',
        aiFox2OpeningAmbush: false,
        aiThreatLog: [],
        aiThreatLastTurn: -1,
        aiThreatActive: false,
        aiLastFlareTurn: -99,
        aiLastChaffTurn: -99,
        aiDebugTrace: [],
        aiDebugRecording: false,
        // Always-on compact decision ring buffer (export-all / death forensics).
        aiDecisionTrail: [],
        aiDecisionTrailFrozen: false,
        wingmanOrder: 'follow',
        lockedTargetId: null,
        wreckPhase: null,
        wreckBurstTurn: 0,
        pendingPitch: 0,
        pendingYaw: 0,
        pendingRoll: 0,
        pathPoints: [],
        pathQuats: [],
        flightCurve: null,
        pylons: null,
        activeMissiles: []
    };
}

state.initialPositions = {
    red: { pos: new THREE.Vector3(10, 45, -50), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)) },
    red2: { pos: new THREE.Vector3(18, 45, -54), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)) },
    blue: { pos: new THREE.Vector3(10, 45, 50), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)) },
    blue2: { pos: new THREE.Vector3(18, 45, 54), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)) }
};

state.teams = {
    red: createTeamState('red', '#ff0055', true),
    red2: createTeamState('red2', '#ff4488', false),
    blue: createTeamState('blue', '#00bcd4', true),
    blue2: createTeamState('blue2', '#44d4e8', false)
};

state.activeTeamId = 'red';
GameContext.view.trajectoryMeshes = state.trajectoryMeshes;
GameContext.view.pastTrajectories = state.pastTrajectories;

['red', 'red2', 'blue', 'blue2'].forEach(id => {
    const team = state.teams[id];

    Object.defineProperty(team, 'wrapper', {
        configurable: true,
        enumerable: false,
        get() { return GameContext.getTeamView(id).wrapper; },
        set(wrapper) { GameContext.registerTeamWrapper(id, wrapper); }
    });

    Object.defineProperty(team, 'userData', {
        configurable: true,
        enumerable: false,
        get() { return GameContext.getTeamUserData(id); },
        set(value) { GameContext.getTeamView(id).userData = value || {}; }
    });

    Object.defineProperty(team, 'realBeam', {
        configurable: true,
        enumerable: false,
        get() { return GameContext.getTeamView(id).realBeam; },
        set(value) { GameContext.getTeamView(id).realBeam = value; }
    });
});
