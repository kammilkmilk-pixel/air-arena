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
const DYNAMIC_GUN_RANGE = 70;

const MISSILE_DAMAGE = CONFIG.weapons['fox2'].damage;
const MISSILE_SCALE = CONFIG.weapons['fox2'].model.scale;
const MISSILE_ROT_X = CONFIG.weapons['fox2'].model.rotX;
const MISSILE_ROT_Y = CONFIG.weapons['fox2'].model.rotY;
const MISSILE_ROT_Z = CONFIG.weapons['fox2'].model.rotZ;
const MISSILE_MAX_AP = CONFIG.weapons['fox2'].maxAp;
const SEEKER_RANGE = CONFIG.weapons['fox2'].seekerRange;
const SEEKER_ANGLE = CONFIG.weapons['fox2'].seekerAngle;
const SEEKER_MIN_HEAT = CONFIG.weapons['fox2'].seekerMinHeat;

const MISSILE_SPEED = CONFIG.weapons['fox2'].speed;
const MISSILE_TURN_RATE = CONFIG.weapons['fox2'].turnRate;
const MISSILE_DRAG = CONFIG.weapons['fox2'].drag;

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
        ap: 120,
        speed: 120,
        heat: 0,
        flameout: false,
        throttle: 4,
        chain: [],
        stalled: false,
        gLimiterOn: true,
        weapon: 'gun',
        wpnQueued: false,
        flareAmmo: CONFIG.weapons['flare'].maxAmmo,
        flaresArmed: false,
        ready: false,
        aiEnabled: false,
        aiState: 'player',
        aiStatusText: 'PLAYER CONTROL',
        aiLastAction: null,
        aiManualOverride: 'auto',
        aiPolicyMode: 'heuristic',
        aiFox2OpeningAmbush: false,
        aiThreatLog: [],
        aiThreatLastTurn: -1,
        aiThreatActive: false,
        aiLastFlareTurn: -99,
        aiDebugTrace: [],
        aiDebugRecording: false,
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
    red: { pos: new THREE.Vector3(10, 25, -30), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)) },
    red2: { pos: new THREE.Vector3(18, 25, -34), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)) },
    blue: { pos: new THREE.Vector3(10, 25, 70), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)) },
    blue2: { pos: new THREE.Vector3(18, 25, 74), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)) }
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
