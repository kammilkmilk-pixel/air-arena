// ============================================================================
// team-state.js - constants, team factories, TeamView accessors
// ============================================================================

if (typeof THREE === 'undefined') throw new Error("Three.js is not loaded.");
if (typeof GameContext === 'undefined') throw new Error("GameContext is not loaded.");

const state = GameContext.state;

const BULLET_SPEED = 4.0;

const _liveConstantGetters = {
    MAX_HP: () => (typeof CONFIG.getAircraftMaxHp === 'function' ? CONFIG.getAircraftMaxHp('mig21') : CONFIG.aircrafts['mig21'].maxHp),
    MAX_HEAT: () => (typeof CONFIG.getMaxHeat === 'function' ? CONFIG.getMaxHeat() : CONFIG.rules.maxHeat),
    MAX_AP: () => (typeof CONFIG.getMaxAp === 'function' ? CONFIG.getMaxAp() : CONFIG.rules.maxAp),
    GUN_DAMAGE: () => (typeof CONFIG.getGunDamage === 'function' ? CONFIG.getGunDamage() : CONFIG.weapons['gun'].damage),
    GUN_RANGE: () => (typeof CONFIG.getGunRange === 'function' ? CONFIG.getGunRange() : CONFIG.weapons['gun'].range),
    GUN_ANGLE: () => (typeof CONFIG.getGunAngle === 'function' ? CONFIG.getGunAngle() : CONFIG.weapons['gun'].angle),
    BULLET_SPEED: () => BULLET_SPEED,
    DYNAMIC_GUN_RANGE: () => (typeof CONFIG.getGunRange === 'function' ? CONFIG.getGunRange() : CONFIG.weapons['gun'].range),
    MISSILE_DAMAGE: () => Number(CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2').damage : CONFIG.weapons.fox2.damage),
    MISSILE_SCALE: () => Number((CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2') : CONFIG.weapons.fox2).model.scale),
    MISSILE_ROT_X: () => Number((CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2') : CONFIG.weapons.fox2).model.rotX),
    MISSILE_ROT_Y: () => Number((CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2') : CONFIG.weapons.fox2).model.rotY),
    MISSILE_ROT_Z: () => Number((CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2') : CONFIG.weapons.fox2).model.rotZ),
    MISSILE_MAX_AP: () => (typeof CONFIG.getMissileMaxAp === 'function' ? CONFIG.getMissileMaxAp('fox2') : CONFIG.weapons.fox2.maxAp),
    SEEKER_RANGE: () => (typeof CONFIG.getMissileSeekerRange === 'function' ? CONFIG.getMissileSeekerRange('fox2') : CONFIG.weapons.fox2.seekerRange),
    SEEKER_ANGLE: () => (typeof CONFIG.getMissileSeekerAngle === 'function' ? CONFIG.getMissileSeekerAngle('fox2') : CONFIG.weapons.fox2.seekerAngle),
    SEEKER_MIN_HEAT: () => Number(CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2').seekerMinHeat : CONFIG.weapons.fox2.seekerMinHeat),
    MISSILE_SPEED: () => Number(CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2').speed : CONFIG.weapons.fox2.speed),
    MISSILE_TURN_RATE: () => Number(CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2').turnRate : CONFIG.weapons.fox2.turnRate),
    MISSILE_DRAG: () => Number(CONFIG.getMissileConfig ? CONFIG.getMissileConfig('fox2').drag : CONFIG.weapons.fox2.drag)
};

const _constGlobalRoot = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
GameContext.constants = {};
Object.keys(_liveConstantGetters).forEach((key) => {
    const getter = _liveConstantGetters[key];
    Object.defineProperty(GameContext.constants, key, {
        get: getter,
        enumerable: true,
        configurable: true
    });
    if (_constGlobalRoot && key !== 'BULLET_SPEED') {
        Object.defineProperty(_constGlobalRoot, key, {
            get: getter,
            enumerable: false,
            configurable: true
        });
    }
});

/**
 * Lateral hit allowance at forwardDist (m): cone then clamp to fuselage-scale max.
 * Prevents long-range “virtual shotgun” hits when tracers clearly miss the airframe.
 */
function gunHitRadiusAt(forwardDist, coneAngleRad, gunCfg = (CONFIG.weapons && CONFIG.weapons.gun) || {}) {
    const dist = Math.max(0, Number(forwardDist) || 0);
    const ang = Number(coneAngleRad);
    const cone = Number.isFinite(ang) ? dist * Math.tan(ang) : dist * Math.tan(GUN_ANGLE || Math.PI / 36);
    const floor = Number.isFinite(Number(gunCfg.hitRadiusFloor)) ? Number(gunCfg.hitRadiusFloor) : 0.65;
    const maxR = Number.isFinite(Number(gunCfg.hitRadiusMax)) ? Number(gunCfg.hitRadiusMax) : 1.75;
    return Math.min(maxR, Math.max(floor, cone));
}
GameContext.gunHitRadiusAt = gunHitRadiusAt;

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
        ap: (typeof CONFIG.getAircraftBaseAp === 'function'
            ? CONFIG.getAircraftBaseAp('mig21')
            : (CONFIG.aircrafts['mig21'].baseAp || 165)),
        speed: (typeof CONFIG.getAircraftBaseAp === 'function'
            ? CONFIG.getAircraftBaseAp('mig21')
            : (CONFIG.aircrafts['mig21'].baseAp || 165)),
        heat: (typeof getEngineHeatIdle === 'function') ? getEngineHeatIdle() : 150,
        /** Machine-gun barrel heat 0–1 (overheat blocks fire). */
        gunHeat: 0,
        flameout: false,
        throttle: 4,
        chain: [],
        stalled: false,
        gLimiterOn: true,
        weapon: 'gun',
        rocketSalvoCount: 3,
        wpnQueued: false,
        flareAmmo: CONFIG.weapons['flare'].maxAmmo,
        chaffAmmo: (CONFIG.weapons.chaff && CONFIG.weapons.chaff.maxAmmo) ? CONFIG.weapons.chaff.maxAmmo : 3,
        flaresArmed: false,
        chaffArmed: false,
        pendingPylonLoadout: null,
        ready: false,
        aiEnabled: false,
        aiModel: null,
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
        aiTacticalRole: null,
        aiTacticalRoleWhy: null,
        aiTacticalRoleUntilTurn: -1,
        aiDebugTrace: [],
        aiDebugRecording: false,
        // Always-on compact decision ring buffer (export-all / death forensics).
        aiDecisionTrail: [],
        aiDecisionTrailFrozen: false,
        // Match-long weapon/CM tallies for A/B (not truncated by trailMax).
        aiWeaponCounters: null,
        killedBy: null,
        lastCombatHitBy: null,
        killCredited: false,
        combatKills: 0,
        combatKillsGun: 0,
        combatKillsMsl: 0,
        combatKillsFox1: 0,
        combatKillsFox2: 0,
        missileShots: [],
        wingmanOrder: 'follow',
        lockedTargetId: null,
        /** Phase B: designated ground-target id for strike / A2G HUD. */
        designatedGroundTargetId: null,
        wreckPhase: null,
        wreckBurstTurn: 0,
        pendingPitch: 0,
        pendingYaw: 0,
        pendingRoll: 0,
        pathPoints: [],
        pathQuats: [],
        flightCurve: null,
        pylons: null,
        activeMissiles: [],
        pilotId: null,
        callsign: null,
        voiceSetId: null,
        portraitColor: null
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
