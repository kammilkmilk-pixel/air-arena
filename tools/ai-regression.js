#!/usr/bin/env node
/**
 * ai-regression.js
 *
 * Deterministic AI curriculum regression runner.
 * This is a fast Node-side surrogate for repeated safety checks. It does not
 * replace full in-game validation, but it gives every AI change a repeatable
 * crash/stall/urban-pressure score before manual testing.
 * Phase 4: decideAction mirrors pilot-ai Phase 1-3 (safety protect, urban defer,
 * merge/reacquire, gun lead, lateral pull-up).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CURRICULUM_FILE = path.join(ROOT, 'tools', 'curriculum', 'ai-curriculum.json');
const TUNING_FILE = path.join(ROOT, 'js', 'ai', 'pilot-tuning.local.js');
const sharedDefaults = require(path.join(ROOT, 'js', 'ai', 'pilot-tuning-defaults.js'));
const PARAM_KEYS = sharedDefaults.PARAM_KEYS;
const DEFAULT_PARAMS = Object.fromEntries(PARAM_KEYS.map((key) => [key, sharedDefaults[key]]));

const DEFAULTS = {
    seed: 20260707,
    runs: null,
    episodes: null,
    turns: null,
    stage: 'all',
    out: path.join(__dirname, 'reports', `regression-${Date.now()}.json`)
};

function parseArgs(argv) {
    const args = { ...DEFAULTS };
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        const value = argv[i + 1];
        if (!key.startsWith('--')) continue;
        const name = key.slice(2);
        if (!(name in args) || value === undefined || value.startsWith('--')) continue;
        args[name] = ['seed', 'runs', 'episodes', 'turns'].includes(name) ? Number(value) : value;
        i++;
    }
    return args;
}

function mulberry32(seed) {
    let t = seed >>> 0;
    return function rand() {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function pickRange(rand, min, max) {
    return min + (max - min) * rand();
}

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadTuningParams() {
    const params = { ...DEFAULT_PARAMS };
    if (!fs.existsSync(TUNING_FILE)) {
        return { params, source: 'built-in-defaults' };
    }
    const raw = fs.readFileSync(TUNING_FILE, 'utf8');
    for (const key of PARAM_KEYS) {
        const match = raw.match(new RegExp(`${key}:\\s*([-+]?\\d*\\.?\\d+)`));
        if (match) params[key] = Number(match[1]);
    }
    return { params, source: path.relative(ROOT, TUNING_FILE) };
}

function headingToVector(heading) {
    return { x: Math.sin(heading), z: Math.cos(heading) };
}

function normalizeAngle(angle) {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

function angleToTarget(state) {
    const desired = Math.atan2(state.enemyX - state.x, state.enemyZ - state.z);
    return normalizeAngle(desired - state.heading);
}

function distanceToEnemy(state) {
    return Math.hypot(state.enemyX - state.x, state.enemyZ - state.z);
}

function makeObstacle(x, z, radius, height = 70, id = 'building') {
    return { id, x, z, radius, height };
}

const CONFIG_DEFAULT_BUILDINGS = [
    { x: -10, z: 12, w: 4, d: 4, h: 18 },
    { x: -5, z: 32, w: 3, d: 4, h: 22 },
    { x: -12, z: 48, w: 4, d: 3, h: 15 },
    { x: 25, z: 15, w: 4, d: 3, h: 16 },
    { x: 22, z: 38, w: 3, d: 4, h: 24 },
    { x: 28, z: 55, w: 4, d: 4, h: 20 },
    { x: 5, z: 16, w: 3, d: 3, h: 20 },
    { x: 12, z: 28, w: 4, d: 3, h: 26 },
    { x: 4, z: 42, w: 3, d: 3, h: 22 },
    { x: 13, z: 54, w: 4, d: 4, h: 19 }
];

function buildingBoxToObstacle(building, id) {
    const radius = Math.max(building.w, building.d) * 0.55 + 1.1;
    return makeObstacle(building.x, building.z, radius, building.h, id);
}

function generateObstacles(stage, rand) {
    const env = stage.environment || {};
    const count = Number(env.building_count || 0);
    if (count <= 0 || env.building_density === 'none') return [];

    const obstacles = [];
    const layout = env.building_layout || 'spaced';
    const spacing = env.building_density === 'full' ? 30 : (env.building_density === 'medium' ? 38 : 54);
    const baseRadius = env.building_density === 'full' ? 11 : (env.building_density === 'medium' ? 9 : 7);

    if (layout === 'config-default') {
        const source = CONFIG_DEFAULT_BUILDINGS.slice(0, count);
        source.forEach((building, index) => {
            obstacles.push(buildingBoxToObstacle(building, `b${index + 1}`));
        });
        return obstacles;
    }

    for (let i = 0; i < count; i++) {
        let x;
        let z;
        if (layout === 'alternating-corridor') {
            x = (i % 2 === 0 ? -1 : 1) * (18 + (i % 3) * 7);
            z = -70 + i * spacing;
        } else {
            x = (i % 2 === 0 ? -1 : 1) * pickRange(rand, 24, 54);
            z = -55 + i * spacing + pickRange(rand, -8, 8);
        }
        obstacles.push(makeObstacle(x, z, baseRadius + pickRange(rand, -1.5, 2.5), pickRange(rand, 45, 95), `b${i + 1}`));
    }
    return obstacles;
}

function nearestObstacle(state, obstacles) {
    let nearest = {
        distance: Infinity,
        forwardDistance: Infinity,
        side: 1,
        id: null,
        collisionRisk: 'low',
        riskPriority: 3
    };
    const forward = headingToVector(state.heading);
    for (const obstacle of obstacles) {
        if (state.altitude > obstacle.height + 8) continue;
        const dx = obstacle.x - state.x;
        const dz = obstacle.z - state.z;
        const centerDist = Math.hypot(dx, dz);
        const edgeDist = centerDist - obstacle.radius;
        const forwardDist = dx * forward.x + dz * forward.z - obstacle.radius;
        const lateral = dx * forward.z - dz * forward.x;
        const behind = forwardDist < -obstacle.radius;
        const collisionRisk = behind && edgeDist >= 8
            ? 'low'
            : (edgeDist < 12 || (forwardDist > 0 && forwardDist < 24 && Math.abs(lateral) < obstacle.radius + 12)
                ? 'high'
                : (edgeDist < 26 || (forwardDist > 0 && forwardDist < 46 && Math.abs(lateral) < obstacle.radius + 18) ? 'medium' : 'low'));
        const riskPriority = collisionRisk === 'high' ? 0 : (collisionRisk === 'medium' ? 1 : 2);
        if (riskPriority < nearest.riskPriority || (riskPriority === nearest.riskPriority && edgeDist < nearest.distance)) {
            nearest = {
                distance: edgeDist,
                forwardDistance: forwardDist > -obstacle.radius ? forwardDist : Infinity,
                side: lateral >= 0 ? -1 : 1,
                id: obstacle.id,
                collisionRisk,
                riskPriority
            };
        }
    }
    return nearest;
}

function cloneProbeState(state) {
    return {
        ...state,
        hits: { ...(state.hits || {}) },
        stallDurations: [...(state.stallDurations || [])]
    };
}

function distancePointToSegment(px, pz, ax, az, bx, bz) {
    const vx = bx - ax;
    const vz = bz - az;
    const wx = px - ax;
    const wz = pz - az;
    const lenSq = vx * vx + vz * vz;
    if (lenSq <= 0.000001) return Math.hypot(px - ax, pz - az);
    const t = clamp((wx * vx + wz * vz) / lenSq, 0, 1);
    const cx = ax + vx * t;
    const cz = az + vz * t;
    return Math.hypot(px - cx, pz - cz);
}

function scoreUrbanAction(state, action, params, obstacles, cover = {}) {
    const sim = cloneProbeState(state);
    sim._obstacles = obstacles;
    let minClearance = Infinity;
    let hit = false;
    for (let i = 0; i < 3; i++) {
        const stepAction = i === 0
            ? action
            : {
                ...action,
                state: `${action.state}Continue`,
                joyX: clamp((action.joyX || 0) * 0.72, -0.78, 0.78),
                joyY: Math.max(action.joyY || 0, sim.altitude < 35 ? 0.24 : 0.1),
                fire: 'none'
            };
        applyAction(sim, stepAction, params, () => 1);
        const stepCover = nearestObstacle(sim, obstacles);
        minClearance = Math.min(minClearance, stepCover.distance);
        if (checkCrash(sim, obstacles)) hit = true;
    }
    const finalCover = nearestObstacle(sim, obstacles);
    let score =
        minClearance * 4 +
        finalCover.distance * 2 +
        sim.altitude * 0.5 +
        sim.ap * 0.12 -
        (hit ? 1000 : 0) -
        (sim.stalled ? 120 : 0) -
        (finalCover.collisionRisk === 'high' ? 140 : finalCover.collisionRisk === 'medium' ? 45 : 0);
    if (!hit) score += 80;
    if (finalCover.distance >= 12) score += finalCover.distance * 2;
    if (action.state === 'urbanPreemptiveAvoid' || action.state === 'urbanRouteEscape') score += 28;
    if (cover.collisionRisk === 'medium' && (action.state === 'urbanPreemptiveAvoid' || action.state === 'urbanRouteEscape')) score += 32;
    if (action.state === 'urbanBuildingWeave') {
        // Mid-clearance sweet spot (~10–24m): lane weave, not max-escape clearance.
        if (finalCover.distance >= 10 && finalCover.distance <= 24) score += 56;
        else if (finalCover.distance >= 8 && finalCover.distance < 10) score += 40;
        else if (finalCover.distance > 32) score -= 24;
        else if (finalCover.distance < 6) score -= 80;
        if ((action.joyY || 0) < 0.22) score += 12;
        if (cover.collisionRisk === 'high') score -= 100;
    }
    if (cover.collisionRisk === 'high') {
        if (action.state === 'obstacleEmergencyEscape' || action.state === 'obstacleEnergyClimb') score += 120;
        if (action.state === 'urbanClimbingTurn' && state.altitude < 50) score += 24;
        if (action.state === 'urbanPreemptiveAvoid' || action.state === 'urbanRouteEscape' || action.state === 'urbanBuildingWeave') score -= 110;
        score += Math.abs(action.joyX || 0) * 35;
    } else if (cover.collisionRisk === 'medium') {
        if (action.state === 'obstacleEmergencyEscape') {
            score += cover.distance < 22 || cover.forwardDistance < 30 ? 18 : -95;
        }
        if (action.state === 'urbanBuildingWeave') score += 36;
        if (action.state === 'urbanClimbingTurn' && finalCover.distance >= 8 && finalCover.distance <= 22) score -= 18;
        // Already in-band: reduce climb bias so weave/escape lanes stay preferred.
        if (action.state === 'urbanClimbingTurn' && state.altitude >= (params.combatBandMin || 35) + 8) score -= 12;
    }
    if (cover.distance < 14 || cover.forwardDistance < 18) {
        if (action.state === 'obstacleEmergencyEscape' || action.state === 'obstacleEnergyClimb') score += 70;
        if (action.state === 'urbanPreemptiveAvoid') score -= 55;
    }
    if (action.state === 'urbanBrakeTurn') {
        score += 16;
        if (cover.collisionRisk !== 'low') score -= 75;
        if (minClearance < 10) score -= 45;
        if (sim.ap < 72) score -= 40;
    }
    if (action.state === 'obstacleClimbGate') {
        if (!shouldAllowUrbanClimb(state.altitude, cover, obstacles.length >= 8, params)) score -= 130;
        else if (cover.collisionRisk === 'medium') score -= 35;
    }
    return { action, score };
}

function getCombatAltitudeProfile(altitude, params) {
    const bandMin = Number(params.combatBandMin || 35);
    const bandMax = Number(params.combatBandMax || 92);
    const bandHard = Number(params.combatBandHardMax || 108);
    const alt = Number(altitude || 0);
    const excess = Math.max(0, alt - bandMax);
    return {
        bandMin,
        bandMax,
        bandHard,
        excess,
        needsLevelOut: alt >= bandHard || alt >= bandMax + 2,
        needsSoftCap: alt >= bandMax - 2,
        levelOutJoyY: alt >= bandHard ? -0.42 : (alt >= bandMax + 10 ? -0.32 : -0.22)
    };
}

function interceptJoyY(state, params) {
    const profile = getCombatAltitudeProfile(state.altitude, params);
    if (state.altitude < 30) return 0.16;
    if (state.altitude < profile.bandMin) return 0.1;
    if (state.altitude > profile.bandHard) return -0.3;
    if (state.altitude > profile.bandMax + 4) return -0.2;
    if (state.altitude > profile.bandMax) return -0.12;
    return 0;
}

function shouldAllowUrbanClimb(altitude, cover, denseObstacles, params = {}) {
    const profile = getCombatAltitudeProfile(altitude, params);
    const alt = Number(altitude || 0);
    if (cover.collisionRisk === 'high') return true;
    if (alt < profile.bandMin + 4) return true;
    if (alt < profile.bandMin + 14 && cover.collisionRisk === 'medium' && alt < 52) return true;
    return false;
}

function adjustActionForCombatBand(action, state, cover, params) {
    if (!action || typeof action.joyY !== 'number') return action;
    const profile = getCombatAltitudeProfile(state.altitude, params);
    const climbExempt = new Set([
        'emergencyPullUp',
        'groundAvoid',
        'obstacleEmergencyEscape',
        'obstacleEnergyClimb',
        'altitudeBandLevelOut'
    ]);
    if (climbExempt.has(action.state)) return action;
    const veryLowAlt = state.altitude < 26;
    const divingFast = state.pitch < -0.18;
    const sinkingLow = state.altitude < 38 && state.pitch < -0.08;
    if (veryLowAlt || divingFast || sinkingLow) {
        const minJoyY = veryLowAlt ? (state.altitude < 22 ? 0.92 : 0.78) : (divingFast ? 0.68 : 0.42);
        if (action.joyY < minJoyY) action.joyY = minJoyY;
        if (veryLowAlt && typeof action.throttle === 'number' && action.throttle < 4) action.throttle = state.heat > 78 ? 4 : 5;
        if (action.fire !== 'none' && state.altitude < 30) action.fire = 'none';
        const lowApRisk = state.ap < 70 || Math.abs(action.joyX || 0) > 0.65;
        if (state.altitude < 32 && lowApRisk && Math.abs(action.joyX || 0) > 0.35) {
            action.joyX = clamp(action.joyX, -0.32, 0.32);
        }
        if (state.altitude < 28) action.joyX = clamp(action.joyX || 0, -0.22, 0.22);
        return action;
    }
    if (state.altitude < profile.bandMin && action.joyY > 0) return action;
    if (cover.collisionRisk === 'high' && state.altitude < profile.bandMax + 12) return action;
    if (profile.needsLevelOut && action.joyY > 0) {
        action.joyY = Math.min(action.joyY, profile.levelOutJoyY);
    } else if (profile.needsSoftCap && action.joyY > 0.08) {
        action.joyY = clamp(action.joyY * 0.15, -0.22, 0.06);
    } else if (state.altitude > profile.bandMax && action.joyY > 0) {
        action.joyY = Math.min(action.joyY, -0.08);
    }
    return action;
}

function planUrbanAction(state, params, obstacles, cover, preferredSide) {
    const lowAltitude = state.altitude < 30;
    const lowEnergy = state.ap < params.lowAp + 4;
    const denseObstacles = obstacles.length >= 8;
    const mediumUrban = obstacles.length >= 6;
    const bandMin = Number(params.combatBandMin || 35);
    const inBand = state.altitude >= bandMin + 4;
    const belowBand = denseObstacles && state.altitude < bandMin + 8;
    const sideJoyY = lowAltitude ? 0.42 : (belowBand ? 0.24 : (inBand ? 0.04 : 0.16));
    const preemptJoyY = lowAltitude ? 0.34 : (belowBand ? 0.16 : (inBand ? 0.02 : 0.1));
    const tightForward = cover.forwardDistance < 38;
    const sideOrder = [preferredSide || cover.side || 1, -(preferredSide || cover.side || 1)];
    const candidates = [];
    for (const side of sideOrder) {
        candidates.push({
            state: lowEnergy ? 'obstacleEnergyClimb' : 'obstacleEmergencyEscape',
            throttle: state.heat > 78 ? 4 : 5,
            joyX: clamp(side * (lowEnergy ? 0.42 : (cover.collisionRisk === 'high' ? 0.78 : 0.52)), -1, 1),
            joyY: lowAltitude ? 0.7 : (lowEnergy ? 0.34 : (cover.collisionRisk === 'high' ? 0.48 : 0.3)),
            fire: 'none'
        });
        candidates.push({
            state: 'urbanRouteEscape',
            throttle: state.heat > 78 ? 3 : 4,
            joyX: clamp(side * (tightForward ? 0.72 : 0.66), -0.82, 0.82),
            joyY: sideJoyY,
            fire: 'none'
        });
        candidates.push({
            state: 'urbanPreemptiveAvoid',
            throttle: state.heat > 78 ? 3 : 4,
            joyX: clamp(side * (tightForward ? 0.68 : 0.58), -0.72, 0.72),
            joyY: preemptJoyY,
            fire: 'none'
        });
        // Keep forward-clear medium weave; side-lane weave is gated in live pilot-ai (P0),
        // where 3D cover + avoid memory are stronger than this 2D proxy.
        const weaveEligible =
            cover.collisionRisk === 'medium' &&
            cover.distance >= 10 &&
            cover.distance <= 40 &&
            state.altitude >= 26 &&
            Number.isFinite(cover.forwardDistance) &&
            cover.forwardDistance > 14;
        if (weaveEligible) {
            candidates.push({
                state: 'urbanBuildingWeave',
                throttle: state.heat > 78 ? 3 : 4,
                joyX: clamp(side * 0.48, -0.62, 0.62),
                joyY: lowAltitude ? 0.2 : 0.05,
                fire: 'none'
            });
        }
        if (shouldAllowUrbanClimb(state.altitude, cover, denseObstacles, params)) {
            candidates.push({
                state: 'urbanClimbingTurn',
                throttle: state.heat > 78 ? 4 : 5,
                joyX: clamp(side * (denseObstacles ? 0.34 : 0.46), -0.58, 0.58),
                joyY: lowAltitude ? 0.68 : (denseObstacles ? 0.56 : 0.42),
                fire: 'none'
            });
        }
        const brakeTurnAllowed =
            !denseObstacles &&
            !mediumUrban &&
            !lowEnergy &&
            cover.collisionRisk === 'low' &&
            state.ap >= 88 &&
            state.altitude >= 26 &&
            cover.distance >= 18 &&
            (state.turn - state.lastBrakeTurn) > 3;
        if (brakeTurnAllowed) {
            candidates.push({
                state: 'urbanBrakeTurn',
                throttle: state.heat > 74 ? 2 : 3,
                joyX: clamp(side * 0.88, -1, 1),
                joyY: state.altitude < 32 ? 0.16 : 0.04,
                fire: 'none'
            });
        }
    }
    if (shouldAllowUrbanClimb(state.altitude, cover, denseObstacles, params) && (lowAltitude || cover.collisionRisk === 'high')) {
        candidates.push({
            state: 'obstacleClimbGate',
            throttle: state.heat > 78 ? 4 : 5,
            joyX: 0,
            joyY: lowAltitude ? 0.72 : 0.54,
            fire: 'none'
        });
    }

    const ranked = candidates
        .map((action) => {
            adjustActionForCombatBand(action, state, cover, params);
            return scoreUrbanAction(state, action, params, obstacles, cover);
        })
        .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best && best.action.state === 'urbanBrakeTurn') state.lastBrakeTurn = state.turn;
    return best.action;
}

function chooseAvoidSideByClearance(state, params, obstacles, defaultSide) {
    if (!obstacles || obstacles.length === 0) return defaultSide || 1;
    let best = { side: defaultSide || 1, score: -Infinity };
    for (const side of [-1, 1]) {
        const sim = cloneProbeState(state);
        sim._obstacles = obstacles;
        let minClearance = Infinity;
        let hit = false;
        for (let i = 0; i < 3; i++) {
            applyAction(sim, {
                state: 'avoidSideProbe',
                throttle: sim.heat > 78 ? 3 : 4,
                joyX: side * (i === 0 ? 0.74 : 0.58),
                joyY: sim.altitude < 30 ? 0.34 : 0.12,
                fire: 'none'
            }, params, () => 1);
            const cover = nearestObstacle(sim, obstacles);
            minClearance = Math.min(minClearance, cover.distance);
            if (checkCrash(sim, obstacles)) hit = true;
        }
        const finalCover = nearestObstacle(sim, obstacles);
        const score =
            minClearance * 2.5 +
            finalCover.distance +
            sim.ap * 0.08 -
            (hit ? 500 : 0);
        if (score > best.score) best = { side, score };
    }
    return best.side;
}

// --- Phase 4: surrogate sync with in-game pilot-ai Phase 1-3 behaviors ---

const PROTECTED_STATES = new Set([
    'emergencyPullUp', 'emergencyRecoverLock', 'postGroundClimbOut', 'groundAvoid', 'shallowDiveLevel',
    'obstacleEmergencyEscape', 'obstacleEnergyClimb', 'urbanPreemptiveAvoid', 'urbanBrakeTurn',
    'urbanClimbingTurn', 'urbanRouteEscape', 'urbanBuildingWeave', 'altitudeBandLevelOut', 'stallBreakout', 'energyRecover',
    'recover', 'reacquire', 'searchIntercept', 'orbitCutIn', 'intercept', 'mandatoryMergeBreak',
    'mergeBreak', 'gunAttack', 'missileAttack', 'missilePrep', 'corridorCombatIntercept',
    'hybridIntercept', 'heuristicIntercept'
]);

function getForwardY(state) {
    return Math.sin(state.pitch || 0);
}

function getLocalToEnemy(state) {
    const dx = state.enemyX - state.x;
    const dz = state.enemyZ - state.z;
    const dist = Math.hypot(dx, dz) || 1;
    const forward = headingToVector(state.heading);
    const rightX = forward.z;
    const rightZ = -forward.x;
    return {
        x: (dx * rightX + dz * rightZ) / dist,
        y: 0,
        z: (dx * forward.x + dz * forward.z) / dist
    };
}

function getClosureSpeed(state) {
    const angle = Math.abs(angleToTarget(state));
    const speedStep = clamp(state.ap / 11, 2.2, 13.5);
    return Math.max(0, Math.cos(angle) * speedStep * 0.08);
}

function getPredictedSeparation(state) {
    return distanceToEnemy(state) - getClosureSpeed(state) * 10;
}

function getEmergencyRecoveryThrottle(altitude, forwardY, heat = 0) {
    const steepDive = forwardY < -0.45;
    const diving = forwardY < -0.2;
    if (steepDive) return altitude < 10 ? (heat > 70 ? 4 : 3) : 3;
    if (diving && altitude < 35) return heat > 78 ? 4 : 4;
    return altitude < 8 ? 5 : 5;
}

function getEmergencyPullUpLateral(ctx = {}) {
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
        return { joyX: 0, joyYScale: 1, active: false };
    }
    const side = Math.abs(localX) > 0.08 ? Math.sign(localX) : breakSide;
    const auth = closeMerge ? (altitude < 12 ? 0.42 : 0.62) : 0.38;
    const joyX = clamp(side * auth, -0.72, 0.72);
    return {
        joyX,
        joyYScale: closeMerge ? 0.88 : 0.94,
        active: true
    };
}

function isCloseCombatUrbanDefer(ctx, params) {
    const coverInfo = (ctx && ctx.coverInfo) || {};
    const distance = Number(ctx && ctx.distance);
    const angleDeg = Number(ctx && ctx.angleDeg);
    const threatScore = Number((ctx && ctx.threatScore) || 0);
    const gunReach = Number(params.gunRange || 42) + 22;
    const knifeFight = Number.isFinite(distance) && distance > 0 && distance <= Number(params.gunRange || 42) + 12;
    const forwardDist = Number(coverInfo.forwardDistance);
    const coverDist = Number(coverInfo.distance);
    const imminentBuilding =
        coverInfo.collisionRisk === 'high' &&
        ((Number.isFinite(forwardDist) && forwardDist > 0 && forwardDist < 12) || coverDist < 8);
    if (imminentBuilding) return false;
    if (coverInfo.collisionRisk === 'high') return false;
    const tightUrban =
        (Number.isFinite(coverDist) && coverDist > 0 && coverDist < 14) ||
        (Number.isFinite(forwardDist) && forwardDist > 0 && forwardDist < 18);
    if (tightUrban) return false;
    if (ctx && (ctx.actualMissileThreat || ctx.missileThreatEvade || ctx.mandatoryMergeBreak)) return false;
    if (!(Number.isFinite(distance) && distance > 0 && distance <= gunReach)) return false;
    const lateralWeaveLane =
        coverInfo.collisionRisk === 'medium' &&
        coverDist >= 10 &&
        coverDist <= 32 &&
        Number.isFinite(forwardDist) &&
        forwardDist > 16;
    if (knifeFight && !lateralWeaveLane) return true;
    if (Number.isFinite(angleDeg) && angleDeg > 110) return false;
    if (threatScore >= 0.7) return false;
    return true;
}

function isSideLanePressure(coverInfo = {}) {
    const coverDist = Number(coverInfo.distance);
    const fwd = Number(coverInfo.forwardDistance);
    if (!(Number.isFinite(coverDist) && coverDist >= 12 && coverDist <= 36)) return false;
    if (Number.isFinite(fwd) && fwd > 0) return false;
    return true;
}

function isForwardBuildingPressure(coverInfo = {}, nearDist = 42, nearFwd = 56) {
    const dist = Number(coverInfo.distance);
    const fwd = Number(coverInfo.forwardDistance);
    if (coverInfo.collisionRisk === 'medium' || coverInfo.collisionRisk === 'high') return true;
    if (Number.isFinite(dist) && dist < nearDist && dist < 18) return true;
    if (Number.isFinite(fwd) && fwd > 2 && fwd < nearFwd) return true;
    return false;
}

function resolveTurnJoyX(joyX, localToEnemy, angleDeg, breakSide, minAuth = 0.5) {
    const localX = localToEnemy.x;
    const localZ = localToEnemy.z;
    const behind = localZ < -0.15;
    let turnSign = Math.sign(joyX) || Math.sign(breakSide) || 1;
    if (Math.abs(joyX) < 0.08 && Math.abs(localX) > 0.08) {
        turnSign = Math.sign(localX);
    }
    const min = minAuth;
    if (Math.abs(joyX) < min) {
        joyX = turnSign * (behind || angleDeg > 90 ? Math.max(min, 0.88) : min);
    }
    return clamp(joyX, -1, 1);
}

function getGunLeadAim(state, params) {
    const distance = Math.max(1, distanceToEnemy(state));
    const selfSpeedStep = Math.max(0.4, (state.ap || 100) * 0.015 / 100);
    const muzzleSpeed = 4.0;
    const closing = Math.max(1.2, muzzleSpeed + selfSpeedStep);
    const framesToImpact = clamp(distance / closing, 4, 28);
    const leadTurns = clamp(framesToImpact / 18, 0.45, 1.8);
    const local = getLocalToEnemy(state);
    const horizontalBias = clamp(-local.x * 1.45, -1, 1);
    const verticalBias = clamp(framesToImpact * framesToImpact * 0.0011, 0.15, 0.75);
    return { horizontalBias, verticalBias, leadTurns: Number(leadTurns.toFixed(2)) };
}

function getRangeMode(distance, params, openSky = false) {
    const gunBonus = openSky ? 22 : 12;
    const hysteresis = openSky ? 18 : 15;
    if (distance <= Number(params.gunRange || 42) + gunBonus) return 'gun';
    if (distance >= Number(params.missileMinRange || 18) && distance <= Number(params.missileMaxRange || 95) + (openSky ? 25 : 15)) return 'missile';
    return 'intercept';
}

function buildGunAttackAction(state, params, cover, options = {}) {
    const close = !!options.close;
    const openSky = (state._obstacles || []).length === 0;
    const targetAngle = angleToTarget(state);
    const angleDeg = Math.abs(targetAngle) * 180 / Math.PI;
    const turnTowardTarget = clamp(targetAngle / (Math.PI / 2), -1, 1);
    const lead = getGunLeadAim(state, params);
    const local = getLocalToEnemy(state);
    const breakSide = state.avoidSide || cover.side || 1;
    const dist = distanceToEnemy(state);
    const safeLowAlt = state.altitude > 50 && state.ap > 60;
    const turnBias = close ? 0.22 : (openSky ? 0.55 : 0.28);
    const leadBias = openSky ? 0.75 : 0.9;
    const joyX = resolveTurnJoyX(
        clamp(lead.horizontalBias * leadBias + turnTowardTarget * turnBias, -0.98, 0.98),
        local,
        angleDeg,
        breakSide,
        close ? 0.45 : (openSky ? 0.92 : 0.5)
    );
    const joyY = clamp(interceptJoyY(state, params) * (openSky ? 1.2 : 1.0) + lead.verticalBias * (close ? 0.35 : (openSky ? 0.42 : 0.2)), -0.55, 0.48);
    const openSkyThrottle = openSky && dist > 22 && state.heat < 62 ? (dist > 55 ? 5 : 4) : 3;
    const throttleCloseCombat = safeLowAlt ? 2 : 3;
    return {
        state: 'gunAttack',
        throttle: dist < 20 ? throttleCloseCombat : openSkyThrottle,
        joyX,
        joyY,
        fire: 'gun',
        leadTurns: lead.leadTurns
    };
}

function evaluateActionSafety(state, action, continuationActions, obstacles, params) {
    const sim = cloneProbeState(state);
    sim._obstacles = obstacles;
    let minAltitude = Infinity;
    let buildingHit = false;
    let nearestBuilding = Infinity;
    const steps = [action, ...continuationActions];
    for (let i = 0; i < steps.length; i++) {
        applyAction(sim, { ...steps[i], fire: 'none' }, params, () => 1);
        minAltitude = Math.min(minAltitude, sim.altitude);
        const cover = nearestObstacle(sim, obstacles);
        nearestBuilding = Math.min(nearestBuilding, Number.isFinite(cover.distance) ? cover.distance : Infinity);
        if (checkCrash(sim, obstacles)) buildingHit = true;
    }
    const finalAP = sim.ap;
    const startForwardY = getForwardY(state);
    const finalForwardY = getForwardY(sim);
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
    const angleDeg = Math.abs(angleToTarget(sim)) * 180 / Math.PI;
    score += clamp((90 - angleDeg) / 90, -1, 1) * 30;
    return {
        score: Number(score.toFixed(1)),
        safe: score > 0 && !buildingHit && minAltitude >= 3 && finalAP >= 45 && !climbLoopRisk,
        minAltitude: Number((Number.isFinite(minAltitude) ? minAltitude : -1).toFixed(1)),
        buildingHit,
        nearestBuilding: Number((Number.isFinite(nearestBuilding) ? nearestBuilding : -1).toFixed(1)),
        finalAP: Number(finalAP.toFixed(1))
    };
}

function isOffensiveSafetyProtected(action, cover, safetyEval) {
    if (!action || !safetyEval || safetyEval.buildingHit || !safetyEval.safe) return false;
    if (cover.collisionRisk === 'high') return false;
    if (action.state === 'gunAttack' && action.fire === 'gun') return true;
    if (action.state === 'missileAttack' && action.fire === 'missile') return true;
    if (action.state === 'missilePrep' && action.fire === 'missile') return true;
    if (['heuristicIntercept', 'hybridIntercept', 'corridorCombatIntercept'].includes(action.state) && action.fire === 'gun') return true;
    if (['heuristicIntercept', 'hybridIntercept', 'corridorCombatIntercept'].includes(action.state) && action.fire === 'missile') return true;
    return false;
}

function chooseSafeAction(state, action, obstacles, params) {
    const cover = nearestObstacle(state, obstacles);
    const originalEval = evaluateActionSafety(state, action, [], obstacles, params);
    const offensiveProtected = isOffensiveSafetyProtected(action, cover, originalEval);
    const hardProtectOk = !originalEval.buildingHit && (originalEval.minAltitude === null || originalEval.minAltitude >= 8);
    if ((PROTECTED_STATES.has(action.state) || offensiveProtected) && hardProtectOk) {
        return action;
    }
    if (originalEval.safe && originalEval.score > 20) return action;

    const base = { throttle: 4, fire: 'none' };
    let candidates = [
        action,
        { ...base, state: 'safetyLevelOut', joyX: 0, joyY: 0.05 },
        { ...base, state: 'safetyShallowClimb', joyX: 0, joyY: 0.18 },
        { ...base, state: 'safetyStallBreakout', throttle: 5, joyX: 0, joyY: state.altitude > 38 ? -0.45 : -0.18 }
    ];
    const obstaclePressure = cover.collisionRisk === 'high' || cover.distance < 10 || cover.forwardDistance < 14;
    if (obstaclePressure) {
        const side = Math.sign(action.joyX || 1);
        const escapePitch = state.altitude < 24 ? 0.72 : 0.52;
        candidates = [
            action,
            {
                state: 'safetyObstacleEscapePrimary',
                throttle: 5,
                joyX: clamp(side * 0.82, -0.9, 0.9),
                joyY: escapePitch,
                fire: 'none',
                obstacleFallback: true
            },
            ...candidates.slice(1)
        ];
    }

    const originalTurn = Math.abs(Number(action.joyX || 0));
    const knifeFightAltOk = state.altitude >= 18;
    const rejectZeroTurnClimb =
        originalTurn >= 0.35 &&
        knifeFightAltOk &&
        ['mandatoryMergeBreak', 'mergeBreak', 'reacquire', 'gunAttack', 'missilePrep'].includes(action.state);

    let bestAction = action;
    let bestEval = originalEval;
    for (const candidate of candidates.slice(1)) {
        if (rejectZeroTurnClimb && Math.abs(Number(candidate.joyX || 0)) < 0.2) continue;
        const continuation = candidate.obstacleFallback ? [{
            state: `${candidate.state}Continue`,
            throttle: 4,
            joyX: clamp((candidate.joyX || 0) * 0.45, -0.45, 0.45),
            joyY: clamp((candidate.joyY || 0) * 0.7, 0.08, 0.5),
            fire: 'none'
        }] : [];
        const safety = evaluateActionSafety(state, candidate, continuation, obstacles, params);
        if (!bestEval || safety.score > bestEval.score) {
            bestEval = safety;
            bestAction = candidate;
        }
    }

    if (PROTECTED_STATES.has(action.state) && bestAction !== action && !bestAction.obstacleFallback && bestEval && !bestEval.safe) {
        return action;
    }
    if (
        bestAction !== action &&
        rejectZeroTurnClimb &&
        Math.abs(Number(bestAction.joyX || 0)) < 0.25 &&
        !originalEval.buildingHit &&
        (originalEval.minAltitude === null || originalEval.minAltitude >= 12)
    ) {
        return action;
    }
    return bestAction;
}

function initEpisode(stage, policyMode, rand, runIndex, episodeIndex) {
    const env = stage.environment || {};
    const urban = Number(env.building_count || 0) > 0;
    const corridorUrban = urban && env.building_layout === 'alternating-corridor';
    const fullMapUrban = urban && env.building_layout === 'config-default';
    const lightUrban = urban && env.building_layout === 'spaced';
    const lowStart = urban && (episodeIndex % 4 === 0);
    const groundRecovery = env.spawn_profile === 'ground-recovery';
    const offset = (runIndex % 2 === 0 ? -1 : 1) * pickRange(rand, 5, 18);
    const state = {
        x: fullMapUrban ? pickRange(rand, 7, 13) : (corridorUrban ? pickRange(rand, -8, 8) : (lightUrban ? pickRange(rand, -10, 10) : offset)),
        z: fullMapUrban ? pickRange(rand, -38, -24) : (-115 + pickRange(rand, -10, 8)),
        heading: fullMapUrban ? pickRange(rand, -0.08, 0.08) : (corridorUrban ? pickRange(rand, -0.06, 0.06) : pickRange(rand, -0.14, 0.14)),
        altitude: groundRecovery ? pickRange(rand, 3.5, 18) : (lowStart ? pickRange(rand, fullMapUrban ? 28 : (corridorUrban ? 26 : 22), fullMapUrban ? 40 : (corridorUrban ? 36 : 34)) : pickRange(rand, fullMapUrban ? 38 : 34, fullMapUrban ? 58 : 62)),
        pitch: groundRecovery ? pickRange(rand, -0.62, -0.18) : pickRange(rand, -0.08, 0.22),
        ap: Math.round(groundRecovery ? pickRange(rand, 82, 130) : (lowStart ? pickRange(rand, 72, 104) : pickRange(rand, 86, 124))),
        heat: pickRange(rand, 12, 50),
        hp: 100,
        enemyHp: 100,
        enemyX: fullMapUrban ? pickRange(rand, 7, 13) : pickRange(rand, -18, 18),
        enemyZ: fullMapUrban ? pickRange(rand, 62, 78) : (105 + pickRange(rand, -10, 18)),
        missiles: 4,
        turn: 1,
        stalled: false,
        stallStart: null,
        stallDurations: [],
        hits: { gun: 0, missile: 0 },
        crashReason: null,
        lastBrakeTurn: -99,
        avoidSide: 0,
        avoidUntil: -1,
        policyMode
    };
    if (groundRecovery) {
        state.heading = pickRange(rand, -0.3, 0.3);
        state.enemyX = pickRange(rand, -55, 55);
        state.enemyZ = pickRange(rand, 70, 150);
    }
    return state;
}

function decideAction(state, policyMode, params, obstacles) {
    const targetAngle = angleToTarget(state);
    const angleDeg = Math.abs(targetAngle) * 180 / Math.PI;
    const distance = distanceToEnemy(state);
    const cover = nearestObstacle(state, obstacles);
    const turnTowardTarget = clamp(targetAngle / (Math.PI / 2), -1, 1);
    const localToEnemy = getLocalToEnemy(state);
    const headOnFactor = localToEnemy.z;
    const closureSpeed = getClosureSpeed(state);
    const predictedSeparation = getPredictedSeparation(state);
    const forwardY = getForwardY(state);
    const energyCritical = state.stalled || state.ap < params.energyCriticalAp;
    const energyLow = state.ap < params.lowAp;
    const groundRisk =
        state.altitude < 18 ||
        (state.altitude < 28 && forwardY < -0.12) ||
        (state.altitude < 40 && forwardY < -0.32) ||
        (state.altitude < 52 && forwardY < -0.55);
    const corridorUrban = obstacles.length >= 6 && obstacles.length < 8;
    const denseUrban = obstacles.length >= 8;
    const earlyDist = denseUrban ? 56 : (corridorUrban ? 48 : 42);
    const earlyForward = denseUrban ? 72 : (corridorUrban ? 64 : 56);
    const highEnergyEarlyAvoid =
        state.ap >= params.lowAp + 12 &&
        (
            cover.distance < earlyDist ||
            (Number.isFinite(cover.forwardDistance) && cover.forwardDistance > 2 && cover.forwardDistance < earlyForward)
        );
    const urbanPressure = cover.collisionRisk === 'medium' || cover.collisionRisk === 'high' || highEnergyEarlyAvoid;
    const threatScore = clamp((1 - distance / 180) * 0.4 + (1 - angleDeg / 180) * 0.3, 0, 1);
    const closeCombatDefer = isCloseCombatUrbanDefer({
        coverInfo: cover,
        distance,
        angleDeg,
        threatScore,
        actualMissileThreat: false,
        missileThreatEvade: false,
        mandatoryMergeBreak: false
    }, params);
    const corridorCombatWindow =
        corridorUrban &&
        cover.collisionRisk === 'low' &&
        cover.distance > 34 &&
        !energyCritical &&
        !state.stalled;
    const committedAvoidSide = state.turn <= state.avoidUntil && state.avoidSide ? state.avoidSide : 0;
    const avoidSide = committedAvoidSide || chooseAvoidSideByClearance(state, params, obstacles, cover.side);
    const gunAngleRad = params.gunAngle * Math.PI / 180;
    const openSky = obstacles.length === 0;
    const openSkyAggression = openSky ? 1.15 : 1.0;
    const rangeMode = getRangeMode(distance, params, openSky);

    if (state.altitude < 20 || (state.altitude < 45 && forwardY < -0.2)) {
        const lateral = getEmergencyPullUpLateral({
            distance,
            headOnFactor,
            localToEnemy,
            breakSide: avoidSide,
            altitude: state.altitude
        });
        const recoveryThrottle = getEmergencyRecoveryThrottle(state.altitude, forwardY, state.heat);
        return {
            state: 'emergencyPullUp',
            throttle: recoveryThrottle,
            joyX: lateral.joyX,
            joyY: lateral.active ? lateral.joyYScale : 1,
            fire: 'none'
        };
    }

    if (groundRisk) {
        return {
            state: state.altitude < 12 ? 'emergencyPullUp' : 'groundAvoid',
            throttle: getEmergencyRecoveryThrottle(state.altitude, forwardY, state.heat),
            joyX: 0,
            joyY: state.altitude < 18 ? 0.92 : (state.altitude < 28 ? 0.72 : 0.56),
            fire: 'none'
        };
    }

    const altitudeBand = getCombatAltitudeProfile(state.altitude, params);
    const sparseUrban = obstacles.length > 0 && obstacles.length < 8;
    if (
        (altitudeBand.needsLevelOut || ((openSky || sparseUrban) && state.altitude > altitudeBand.bandMax + 1)) &&
        cover.collisionRisk !== 'high'
    ) {
        return {
            state: 'altitudeBandLevelOut',
            throttle: state.heat > 78 ? 3 : 4,
            joyX: clamp(turnTowardTarget * 0.18, -0.32, 0.32),
            joyY: altitudeBand.levelOutJoyY,
            fire: 'none'
        };
    }

    if (urbanPressure && !committedAvoidSide && !closeCombatDefer) {
        state.avoidSide = avoidSide;
        state.avoidUntil = state.turn + (cover.collisionRisk === 'high' ? 6 : (denseUrban ? 5 : 4));
    }

    if (cover.collisionRisk === 'high') {
        const planned = planUrbanAction(state, params, obstacles, cover, avoidSide);
        state.avoidSide = planned.joyX >= 0 ? 1 : -1;
        state.avoidUntil = Math.max(state.avoidUntil, state.turn + 5);
        if (
            planned.state !== 'obstacleEmergencyEscape' &&
            planned.state !== 'obstacleEnergyClimb' &&
            (cover.distance < 18 || cover.forwardDistance < 16)
        ) {
            return {
                state: 'obstacleEmergencyEscape',
                throttle: state.heat > 78 ? 4 : 5,
                joyX: clamp(avoidSide * 0.76, -1, 1),
                joyY: state.altitude < 30 ? 0.62 : 0.44,
                fire: 'none'
            };
        }
        return planned;
    }

    if (state.stalled || (state.pitch > params.stallPitchThreshold && state.ap < params.lowAp)) {
        if (denseUrban && urbanPressure && !closeCombatDefer) {
            const planned = planUrbanAction(state, params, obstacles, cover, avoidSide);
            planned.joyY = Math.max(planned.joyY || 0, state.altitude < 32 ? 0.28 : (state.altitude < 42 ? 0.12 : 0));
            planned.throttle = Math.max(planned.throttle || 4, 4);
            state.avoidSide = planned.joyX >= 0 ? 1 : -1;
            state.avoidUntil = Math.max(state.avoidUntil, state.turn + 4);
            return planned;
        }
        return { state: 'stallBreakout', throttle: 5, joyX: 0, joyY: state.altitude > 34 ? -0.38 : -0.12, fire: 'none' };
    }

    if (energyCritical && !urbanPressure) {
        return { state: 'energyRecover', throttle: 5, joyX: 0.04, joyY: params.recoverPitchBias, fire: 'none' };
    }

    const lowAltitudeTacticalBan = state.altitude < 20 || (state.altitude < 45 && forwardY < -0.2);
    const imminentMerge = distance < 42 && closureSpeed > 0.12;
    const riskyHeadOn = distance < 95 && headOnFactor > 0.46 && predictedSeparation < 32;
    const mandatoryMergeBreak =
        !lowAltitudeTacticalBan &&
        cover.collisionRisk !== 'high' &&
        (
            (distance < 34 && predictedSeparation < 24) ||
            (headOnFactor > 0.62 && predictedSeparation < 20)
        );
    const forwardCommitWindow =
        localToEnemy.z > 0.86 &&
        Math.abs(targetAngle) < Math.PI / 8 &&
        distance > 34 &&
        distance < 62 &&
        predictedSeparation > 28 &&
        !riskyHeadOn &&
        !energyCritical &&
        !groundRisk;
    const openSkyGunBonus = openSky ? 1.35 : 1.0;
    const openSkyAngleBonus = openSky ? 1.7 : 1.0;
    const earlyGunWindow =
        distance < params.gunRange + (openSky ? 28 : 10) &&
        Math.abs(targetAngle) < gunAngleRad * openSkyAngleBonus &&
        predictedSeparation > (openSky ? 4 : 14) &&
        headOnFactor < (openSky ? 0.78 : 0.52);
    const gunShotWindow =
        distance <= (params.gunRange + 12) * openSkyGunBonus &&
        angleDeg < params.gunAngle * (openSky ? 1.45 : 1.05) &&
        predictedSeparation > (openSky ? 2 : 8);
    const skipMergeForGun = forwardCommitWindow || gunShotWindow || (earlyGunWindow && !riskyHeadOn && predictedSeparation > 20);
    const optionalMergeBreak =
        cover.collisionRisk !== 'high' &&
        !lowAltitudeTacticalBan &&
        !skipMergeForGun &&
        (
            (imminentMerge && headOnFactor > 0.5) ||
            (riskyHeadOn && predictedSeparation < 22) ||
            (predictedSeparation < 14 && headOnFactor > 0.48)
        );

    if (mandatoryMergeBreak || optionalMergeBreak) {
        const hardBreak = mandatoryMergeBreak || distance < 28;
        return {
            state: hardBreak ? 'mandatoryMergeBreak' : 'mergeBreak',
            throttle: state.heat > 76 ? 3 : 4,
            joyX: clamp(avoidSide * (hardBreak ? 0.92 : 0.72), -1, 1),
            joyY: state.altitude < 24 ? 0.34 : (hardBreak ? 0.12 : 0.04),
            fire: 'none'
        };
    }

    const brakeTurnAllowed =
        urbanPressure &&
        !closeCombatDefer &&
        policyMode === 'hybrid' &&
        obstacles.length < 6 &&
        cover.collisionRisk === 'low' &&
        !energyLow &&
        state.ap >= 88 &&
        state.altitude >= 28 &&
        cover.distance >= 20 &&
        (state.turn - state.lastBrakeTurn) > 3;
    if (brakeTurnAllowed) {
        state.lastBrakeTurn = state.turn;
        return {
            state: 'urbanBrakeTurn',
            throttle: state.heat > 74 ? 2 : 3,
            joyX: clamp(avoidSide * 0.88, -1, 1),
            joyY: state.altitude < 32 ? 0.16 : 0.04,
            fire: 'none'
        };
    }

    if (corridorCombatWindow) {
        if (distance < params.gunRange && angleDeg < params.gunAngle) {
            return buildGunAttackAction(state, params, cover, { close: true });
        }
        if (distance > params.missileMinRange && distance < params.missileMaxRange && angleDeg < params.missileAngle && state.missiles > 0) {
            return { state: 'missileAttack', throttle: 3, joyX: turnTowardTarget * 0.22, joyY: interceptJoyY(state, params), fire: 'missile' };
        }
        const aggression = policyMode === 'hybrid' ? params.hybridAggression : 0.28;
        const missileReady =
            state.missiles > 0 &&
            distance > params.missileMinRange &&
            distance < params.missileMaxRange &&
            angleDeg < params.missileAngle * (policyMode === 'hybrid' ? 1.15 : 1.08);
        const gunReady = distance < params.gunRange * 1.08 && angleDeg < params.gunAngle * 1.1;
        return {
            state: 'corridorCombatIntercept',
            throttle: 3,
            joyX: clamp(turnTowardTarget * (0.5 + aggression * 0.24), -0.84, 0.84),
            joyY: interceptJoyY(state, params),
            fire: missileReady ? 'missile' : (gunReady ? 'gun' : 'none')
        };
    }

    if (urbanPressure && !closeCombatDefer) {
        const planned = planUrbanAction(state, params, obstacles, cover, avoidSide);
        if (cover.collisionRisk === 'low' && distance < params.gunRange && angleDeg < params.gunAngle) {
            planned.fire = 'gun';
        } else if (
            cover.collisionRisk === 'low' &&
            state.missiles > 0 &&
            distance > params.missileMinRange &&
            distance < params.missileMaxRange &&
            angleDeg < params.missileAngle
        ) {
            planned.fire = 'missile';
        }
        state.avoidSide = planned.joyX >= 0 ? 1 : -1;
        state.avoidUntil = Math.max(state.avoidUntil, state.turn + (cover.collisionRisk === 'medium' ? 4 : 3));
        return planned;
    }

    const orbitStalemate =
        distance > (openSky ? 48 : 58) &&
        distance < 190 &&
        angleDeg > (openSky ? 34 : 42) &&
        headOnFactor < (openSky ? 0.62 : 0.55) &&
        closureSpeed < (openSky ? 0.12 : 0.09) &&
        predictedSeparation > distance * (openSky ? 0.82 : 0.9);
    if (orbitStalemate && cover.collisionRisk !== 'high' && !groundRisk) {
        const hybridBoost = policyMode === 'hybrid' ? 1.15 : 1.0;
        const cutGain = (1.08 + params.interceptTurnGain * 0.35) * openSkyAggression * hybridBoost;
        const preferMissileCut = rangeMode === 'missile' && state.missiles > 0 && distance > params.gunRange + 8;
        const cutJoyX = resolveTurnJoyX(
            turnTowardTarget * cutGain,
            localToEnemy,
            angleDeg,
            avoidSide,
            openSky ? 0.92 : 0.72
        );
        const fireInCut = openSky && distance < params.gunRange + (policyMode === 'hybrid' ? 32 : 22) && angleDeg < (policyMode === 'hybrid' ? 48 : 38)
            ? 'gun'
            : (preferMissileCut && openSky && angleDeg < 55 ? 'missile' : (openSky && distance < 100 ? 'gun' : 'none'));
        return {
            state: 'orbitCutIn',
            throttle: state.heat > 72 ? 4 : (openSky && state.heat < 64 && distance > 55 ? 5 : 4),
            joyX: cutJoyX,
            joyY: clamp(
                (Math.abs(cutJoyX) > 0.65 ? 0 : (interceptJoyY(state, params) * (openSky ? 1.25 : 1.0) * hybridBoost)) +
                (state.altitude < params.combatBandMin ? 0.12 : 0),
                -0.42,
                0.48
            ),
            fire: fireInCut
        };
    }

    const reacquireSoftGun =
        cover.collisionRisk === 'low' &&
        !groundRisk &&
        !energyCritical &&
        angleDeg > (openSky ? 35 : 45) &&
        angleDeg <= (openSky ? 80 : 60) &&
        distance < params.gunRange + (openSky ? 35 : 15) &&
        angleDeg < params.gunAngle * (openSky ? 2.1 : 1.1) &&
        predictedSeparation > (openSky ? 4 : 14);
    if (reacquireSoftGun) {
        const lead = getGunLeadAim(state, params);
        const openSkyLeadBoost = openSky ? 0.7 : 0.85;
        const openSkyTurnBoost = openSky ? 0.55 : 0.25;
        return {
            state: 'gunAttack',
            throttle: openSky && state.heat < 62 ? 5 : 3,
            joyX: resolveTurnJoyX(clamp(lead.horizontalBias * openSkyLeadBoost + turnTowardTarget * openSkyTurnBoost, -0.95, 0.95), localToEnemy, angleDeg, avoidSide, openSky ? 0.88 : 0.45),
            joyY: clamp(interceptJoyY(state, params) * (openSky ? 1.2 : 1.0) + lead.verticalBias * (openSky ? 0.42 : 0.25), -0.5, 0.42),
            fire: 'gun',
            leadTurns: lead.leadTurns
        };
    }

    if (distance < params.gunRange * openSkyGunBonus && angleDeg < params.gunAngle * openSkyAngleBonus) {
        return buildGunAttackAction(state, params, cover, { close: distance < params.gunRange - 8 });
    }
    if (earlyGunWindow && !mandatoryMergeBreak) {
        return buildGunAttackAction(state, params, cover, { close: distance < params.gunRange });
    }

    if (angleDeg > (openSky ? 40 : 60) && distance < params.gunRange + (openSky ? 50 : 25)) {
        return {
            state: 'reacquire',
            throttle: openSky && state.heat < 65 ? 5 : 3,
            joyX: resolveTurnJoyX(turnTowardTarget * (openSky ? 1.15 : 0.85), localToEnemy, angleDeg, avoidSide, openSky ? 0.88 : 0.5),
            joyY: clamp(interceptJoyY(state, params) * openSkyAggression * (openSky ? 1.2 : 1.0), -0.5, 0.5),
            fire: (openSky && (distance < params.gunRange + 45 || angleDeg < 52)) ? 'gun' : 'none'
        };
    }

    const inMissileEnvelope =
        state.missiles > 0 &&
        rangeMode === 'missile' &&
        distance > params.gunRange + (openSky ? 2 : 8) &&
        distance >= params.missileMinRange &&
        distance <= params.missileMaxRange + (openSky ? 30 : 8) &&
        angleDeg < (openSky ? 80 : 55) &&
        cover.collisionRisk !== 'high' &&
        !groundRisk &&
        !energyCritical &&
        headOnFactor < (openSky ? 0.82 : 0.62);
    if (inMissileEnvelope) {
        const extendedAttack = openSky && state.missiles > 0 && distance > 18 && distance <= 85 && Math.abs(targetAngle) <= gunAngleRad * 1.6 && localToEnemy.z > 0.55;
        const missileLock = (distance > 22 && distance <= 68 && Math.abs(targetAngle) <= gunAngleRad * 1.25 && localToEnemy.z > 0.68) || extendedAttack;
        return {
            state: missileLock ? 'missileAttack' : 'missilePrep',
            throttle: openSky && !missileLock && state.heat < 60 ? 5 : 3,
            joyX: resolveTurnJoyX(turnTowardTarget * (missileLock ? (openSky ? 0.52 : 0.35) : (openSky ? 1.0 : 0.7)), localToEnemy, angleDeg, avoidSide, missileLock ? 0.28 : (openSky ? 0.92 : 0.58)),
            joyY: clamp(interceptJoyY(state, params) * (openSky ? 1.1 : 1.0), -0.5, 0.5),
            fire: missileLock ? 'missile' : 'none'
        };
    }

    if (state.missiles > 0 && distance > params.missileMinRange && distance < (params.missileMaxRange + (openSky ? 28 : 0)) && angleDeg < params.missileAngle * (openSky ? 1.5 : 1.0)) {
        return { state: 'missileAttack', throttle: 3, joyX: turnTowardTarget * 0.22, joyY: interceptJoyY(state, params), fire: 'missile' };
    }

    if (policyMode === 'hybrid') {
        const aggression = (state.ap > params.lowAp ? params.hybridAggression : 0.2) * openSkyAggression * (openSky ? 1.5 : 1.0);
        const inGunWindow = distance < params.gunRange * (openSky ? 2.2 : 1.2) && angleDeg < params.gunAngle * (openSky ? 2.3 : 1.2);
        const inMissileWindow =
            state.missiles > 0 &&
            distance > params.missileMinRange &&
            distance < params.missileMaxRange + (openSky ? 35 : 0) &&
            angleDeg < params.missileAngle * (openSky ? 1.75 : 1.08);
        const sustainedFire = openSky && distance < 100 && angleDeg < 52;
        const fireNow = inGunWindow ? 'gun' : (inMissileWindow ? 'missile' : (sustainedFire ? 'gun' : 'none'));
        const bigTurn = angleDeg > (openSky ? 32 : 22);
        const safeAltitudeForBrake = state.altitude > 52 && state.ap > 62;
        const hybridThrottle =
            state.heat > 76 ? 3 :
            bigTurn && distance < 80 && safeAltitudeForBrake ? 2 :
            bigTurn ? 3 :
            (openSky && distance > 40 && state.heat < 65 ? 5 : 4);
        return {
            state: 'hybridIntercept',
            throttle: hybridThrottle,
            joyX: clamp(turnTowardTarget * ((openSky ? 0.82 : 0.38) + aggression * (openSky ? 0.92 : 0.3)), -0.98, 0.98),
            joyY: clamp(interceptJoyY(state, params) * openSkyAggression * (openSky ? 1.32 : 1.0), -0.55, 0.55),
            fire: fireNow
        };
    }

    const openSkyGun = distance < params.gunRange * (openSky ? 2.0 : 1.2) && angleDeg < params.gunAngle * (openSky ? 2.1 : 1.2);
    const fireIntercept = openSky ? (openSkyGun || (distance < 105 && angleDeg < 48) ? 'gun' : 'none') : (openSkyGun ? 'gun' : 'none');
    const heuristicAggression = openSky ? 1.45 : 1.0;
    const bigTurnH = angleDeg > (openSky ? 30 : 20);
    const safeAltH = state.altitude > 52 && state.ap > 62;
    const heuristicThrottle =
        state.heat > 78 ? 3 :
        bigTurnH && distance < 78 && safeAltH ? 2 :
        bigTurnH ? 3 :
        (openSky && distance > 45 && state.heat < 62 ? 5 : 4);
    return {
        state: 'heuristicIntercept',
        throttle: heuristicThrottle,
        joyX: clamp(turnTowardTarget * (openSky ? 0.72 : 0.42) * openSkyAggression * heuristicAggression, -0.92, 0.92),
        joyY: clamp(interceptJoyY(state, params) * openSkyAggression * heuristicAggression, -0.52, 0.52),
        fire: fireIntercept
    };
}

function applyAction(state, action, params, rand) {
    const cover = nearestObstacle(state, state._obstacles || []);
    adjustActionForCombatBand(action, state, cover, params);

    state.prevX = state.x;
    state.prevZ = state.z;
    state.prevAltitude = state.altitude;

    const throttle = clamp(Math.round(action.throttle || 3), 1, 5);
    const accel = [0, -5.4, -1.8, 1.2, 4.4, 7.4][throttle];
    const turnLoad = Math.abs(action.joyX || 0) * 7.8 + Math.max(0, action.joyY || 0) * params.climbPenalty;
    const stallPenalty = state.stalled ? 7.8 : 0;

    state.ap = clamp(state.ap + accel - turnLoad - stallPenalty, 18, 145);
    if (action.state === 'stallBreakout') {
        state.ap = clamp(state.ap + params.stallRecoverBonus, 18, 145);
        state.pitch = clamp(state.pitch - 0.3, -0.72, 0.72);
    } else {
        state.pitch = clamp(state.pitch + (action.joyY || 0) * 0.26 - (throttle <= 2 ? 0.05 : 0), -0.72, 0.72);
    }

    const turnThrottleBonus = throttle <= 3 ? 1.38 : 1;
    const turnRate = (0.045 + params.interceptTurnGain * 0.055) * turnThrottleBonus * (state.stalled ? 0.32 : 1) * clamp(state.ap / 92, 0.42, 1.35);
    state.heading = normalizeAngle(state.heading + (action.joyX || 0) * turnRate);

    const speedStep = clamp(state.ap / 11, 2.2, 13.5);
    const forward = headingToVector(state.heading);
    state.x += forward.x * speedStep;
    state.z += forward.z * speedStep;
    state.altitude = clamp(state.altitude + state.pitch * 2.8 + (state.ap - 82) * 0.018 - (state.stalled ? 2.2 : 0.18), 0, 180);
    const bandMax = Number(params.combatBandMax || 92);
    if (state.altitude > bandMax && (action.joyY || 0) <= 0.06) {
        state.altitude = clamp(state.altitude - Math.min(2.4, (state.altitude - bandMax) * 0.05), 0, 180);
    }
    state.heat = clamp(state.heat + (throttle === 5 ? 10 : throttle === 4 ? 3 : throttle <= 2 ? -8 : -3), 0, 140);

    const wasStalled = state.stalled;
    state.stalled = state.ap < 43 || (state.pitch > 0.42 && state.ap < 58);
    if (!wasStalled && state.stalled) state.stallStart = state.turn;
    if (wasStalled && !state.stalled && state.stallStart !== null) {
        state.stallDurations.push(state.turn - state.stallStart + 1);
        state.stallStart = null;
    }

    const distance = distanceToEnemy(state);
    const angleDeg = Math.abs(angleToTarget(state)) * 180 / Math.PI;
    const corridorStage = (state._obstacles || []).length >= 6 && (state._obstacles || []).length < 8;
    const openSky = !(state._obstacles || []).length;
    const combatFocus = corridorStage && ['gunAttack', 'missileAttack', 'corridorCombatIntercept', 'hybridIntercept', 'heuristicIntercept'].includes(action.state);
    if (action.fire === 'gun') {
        const openSkyBoost = openSky ? 1.35 : 1.0;
        const chance = clamp((params.gunRange - distance) / params.gunRange + (params.gunAngle - angleDeg) / params.gunAngle, -0.15, 0.92);
        const leadBonus = action.leadTurns ? clamp(action.leadTurns * 0.18, 0.08, 0.34) : 0;
        const hitScale = openSky ? (0.56 + leadBonus) * openSkyBoost : (combatFocus ? 0.4 + leadBonus : 0.34 + leadBonus * 0.85);
        if (rand() < chance * hitScale) {
            state.enemyHp -= Math.round(pickRange(rand, 11, 18));
            state.hits.gun += 1;
        }
    } else if (action.fire === 'missile' && state.missiles > 0) {
        state.missiles -= 1;
        const openSkyBoost = openSky ? 1.25 : 1.0;
        const chance = clamp((params.missileMaxRange - distance) / params.missileMaxRange + (params.missileAngle - angleDeg) / params.missileAngle, -0.2, 0.88);
        const hitScale = (combatFocus ? 0.55 : 0.48) * openSkyBoost;
        if (rand() < chance * hitScale) {
            state.enemyHp -= Math.round(pickRange(rand, 24, 40));
            state.hits.missile += 1;
        }
    }

    const incoming = clamp((92 - distance) / 92 + (28 - angleDeg) / 28 + (state.stalled ? 0.3 : 0), -0.2, 0.9);
    if (rand() < incoming * 0.1) state.hp -= Math.round(pickRange(rand, 4, 12));
}

function checkCrash(state, obstacles) {
    if (state.altitude <= 0) return 'ground-crash';
    const prevX = typeof state.prevX === 'number' ? state.prevX : state.x;
    const prevZ = typeof state.prevZ === 'number' ? state.prevZ : state.z;
    const prevAltitude = typeof state.prevAltitude === 'number' ? state.prevAltitude : state.altitude;
    for (const obstacle of obstacles) {
        if (Math.min(prevAltitude, state.altitude) > obstacle.height) continue;
        const dist = Math.hypot(state.x - obstacle.x, state.z - obstacle.z);
        const pathDist = distancePointToSegment(obstacle.x, obstacle.z, prevX, prevZ, state.x, state.z);
        if (pathDist <= obstacle.radius) return `building-collision:${obstacle.id}`;
        if (dist <= obstacle.radius) return `building-collision:${obstacle.id}`;
    }
    return null;
}

function runEpisode(stage, policyMode, params, maxTurns, seed, runIndex, episodeIndex) {
    const rand = mulberry32(seed);
    const obstacles = generateObstacles(stage, rand);
    const state = initEpisode(stage, policyMode, rand, runIndex, episodeIndex);
    state._obstacles = obstacles;
    const trace = [];
    let crash = false;
    let crashReason = null;
    let minObstacleDistance = Infinity;
    let minAltitude = state.altitude;
    let maxAltitude = state.altitude;
    let lowAltitudeTurns = 0;
    let highAltitudeTurns = 0;
    const bandMax = params.combatBandMax || 92;

    for (let turn = 1; turn <= maxTurns; turn++) {
        state.turn = turn;
        const cover = nearestObstacle(state, obstacles);
        minObstacleDistance = Math.min(minObstacleDistance, cover.distance);
        minAltitude = Math.min(minAltitude, state.altitude);
        maxAltitude = Math.max(maxAltitude, state.altitude);
        const highBeforeAction = state.altitude > bandMax;
        const lowBeforeAction = state.altitude < 18;
        const rawAction = decideAction(state, policyMode, params, obstacles);
        const action = chooseSafeAction(state, rawAction, obstacles, params);
        if (trace.length < 12 || cover.collisionRisk !== 'low' || action.state.includes('urban') || action.state.includes('obstacle')) {
            trace.push({
                turn,
                state: action.state,
                ap: Number(state.ap.toFixed(1)),
                alt: Number(state.altitude.toFixed(1)),
                cover: Number((Number.isFinite(cover.distance) ? cover.distance : -1).toFixed(1)),
                risk: cover.collisionRisk
            });
        }
        applyAction(state, action, params, rand);
        minAltitude = Math.min(minAltitude, state.altitude);
        maxAltitude = Math.max(maxAltitude, state.altitude);
        if (highBeforeAction || state.altitude > bandMax) highAltitudeTurns += 1;
        if (lowBeforeAction || state.altitude < 18) lowAltitudeTurns += 1;
        crashReason = checkCrash(state, obstacles);
        if (crashReason) {
            crash = true;
            state.hp = 0;
            state.crashReason = crashReason;
            break;
        }
        if (state.hp <= 0 || state.enemyHp <= 0) break;
    }

    if (state.stalled && state.stallStart !== null) {
        state.stallDurations.push(state.turn - state.stallStart + 1);
    }

    return {
        stageId: stage.id,
        policyMode,
        runIndex,
        episodeIndex,
        win: state.enemyHp <= 0 && state.hp > 0,
        survive: state.hp > 0,
        crash,
        crashReason,
        hpLeft: clamp(state.hp, 0, 100),
        enemyHpLeft: clamp(state.enemyHp, 0, 100),
        turns: state.turn,
        stallEvents: state.stallDurations.length,
        avgStallDuration: state.stallDurations.length
            ? state.stallDurations.reduce((a, b) => a + b, 0) / state.stallDurations.length
            : 0,
        gunHits: state.hits.gun,
        missileHits: state.hits.missile,
        minAltitude: Number(minAltitude.toFixed(1)),
        maxAltitude: Number(maxAltitude.toFixed(1)),
        lowAltitudeTurns,
        highAltitudeTurns,
        minObstacleDistance: Number((Number.isFinite(minObstacleDistance) ? minObstacleDistance : -1).toFixed(1)),
        trace
    };
}

function aggregateEpisodes(episodes) {
    const sum = (key) => episodes.reduce((acc, item) => acc + (item[key] || 0), 0);
    const avg = (key) => episodes.length ? sum(key) / episodes.length : 0;
    return {
        episodes: episodes.length,
        winRate: Number((sum('win') / episodes.length).toFixed(4)),
        surviveRate: Number((sum('survive') / episodes.length).toFixed(4)),
        crashRate: Number((sum('crash') / episodes.length).toFixed(4)),
        stallEventsPerEpisode: Number(avg('stallEvents').toFixed(3)),
        avgStallRecoveryTurns: Number(avg('avgStallDuration').toFixed(3)),
        avgHitsGun: Number(avg('gunHits').toFixed(3)),
        avgHitsMissile: Number(avg('missileHits').toFixed(3)),
        avgHpLeft: Number(avg('hpLeft').toFixed(2)),
        avgEnemyHpLeft: Number(avg('enemyHpLeft').toFixed(2)),
        avgTurns: Number(avg('turns').toFixed(2)),
        minAltitude: Number(Math.min(...episodes.map((item) => item.minAltitude)).toFixed(1)),
        maxAltitude: Number(Math.max(...episodes.map((item) => item.maxAltitude)).toFixed(1)),
        avgLowAltitudeTurns: Number(avg('lowAltitudeTurns').toFixed(2)),
        avgHighAltitudeTurns: Number(avg('highAltitudeTurns').toFixed(2)),
        buildingCollisionRate: Number((episodes.filter((item) => String(item.crashReason || '').startsWith('building-collision')).length / episodes.length).toFixed(4))
    };
}

function gatesForStage(curriculum, stage) {
    return {
        ...(curriculum.pass_gates || {}),
        ...(stage.pass_overrides || {})
    };
}

function evaluateGates(metrics, gates) {
    const checks = [
        ['crash_rate_max', 'crashRate', '<='],
        ['stall_events_per_episode_max', 'stallEventsPerEpisode', '<='],
        ['avg_stall_recovery_turns_max', 'avgStallRecoveryTurns', '<='],
        ['min_altitude_min', 'minAltitude', '>='],
        ['avg_low_altitude_turns_max', 'avgLowAltitudeTurns', '<='],
        ['max_altitude_max', 'maxAltitude', '<='],
        ['avg_high_altitude_turns_max', 'avgHighAltitudeTurns', '<='],
        ['avg_enemy_hp_left_max', 'avgEnemyHpLeft', '<='],
        ['avg_turns_max', 'avgTurns', '<='],
        ['win_rate_min', 'winRate', '>='],
        ['avg_hits_gun_min', 'avgHitsGun', '>=']
    ];
    const failed = [];
    for (const [gateKey, metricKey, op] of checks) {
        if (typeof gates[gateKey] !== 'number') continue;
        const failedCheck = op === '>='
            ? metrics[metricKey] < gates[gateKey]
            : metrics[metricKey] > gates[gateKey];
        if (failedCheck) {
            failed.push({
                gate: gateKey,
                metric: metricKey,
                actual: metrics[metricKey],
                limit: gates[gateKey],
                op
            });
        }
    }
    return failed;
}

const COMBAT_METRICS = new Set(['avgEnemyHpLeft', 'winRate', 'avgTurns', 'avgHitsGun']);

function combatGateFailures(failedGates) {
    return failedGates.filter((item) => COMBAT_METRICS.has(item.metric));
}

function safetyGateFailures(failedGates) {
    return failedGates.filter((item) => !COMBAT_METRICS.has(item.metric));
}

function policyPassed(failedGates, enforceCombatGates) {
    const failedCombatGates = combatGateFailures(failedGates);
    const failedSafetyGates = safetyGateFailures(failedGates);
    const safetyPassed = failedSafetyGates.length === 0;
    const combatPassed = failedCombatGates.length === 0;
    const passed = safetyPassed && (!enforceCombatGates || combatPassed);
    return { passed, safetyPassed, combatPassed, failedGates, failedCombatGates, failedSafetyGates };
}

function worstEpisodes(episodes, limit = 5) {
    return [...episodes]
        .sort((a, b) => {
            const scoreA = (a.crash ? 1000 : 0) + a.stallEvents * 80 + (100 - a.hpLeft) + Math.max(0, 40 - a.minObstacleDistance);
            const scoreB = (b.crash ? 1000 : 0) + b.stallEvents * 80 + (100 - b.hpLeft) + Math.max(0, 40 - b.minObstacleDistance);
            return scoreB - scoreA;
        })
        .slice(0, limit);
}

function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
    const args = parseArgs(process.argv);
    const curriculum = loadJson(CURRICULUM_FILE);
    const tuning = loadTuningParams();
    const runs = args.runs || curriculum.baseline.runs_per_stage || 3;
    const episodesPerRun = args.episodes || curriculum.baseline.episodes_per_run || 40;
    const maxTurns = args.turns || curriculum.baseline.max_turns || 80;
    const policyModes = curriculum.baseline.policy_modes || ['heuristic', 'hybrid'];
    const stages = curriculum.stages.filter((stage) => args.stage === 'all' || stage.id === args.stage);

    if (stages.length === 0) {
        console.error(`Unknown stage: ${args.stage}`);
        console.error(`Supported stages: all, ${curriculum.stages.map((stage) => stage.id).join(', ')}`);
        process.exit(1);
    }

    const stageReports = [];
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
        const stage = stages[stageIndex];
        const gates = gatesForStage(curriculum, stage);
        const enforceCombatGates = stage.enforce_combat_gates === true;
        const policyReports = {};
        for (const policyMode of policyModes) {
            const episodes = [];
            for (let runIndex = 0; runIndex < runs; runIndex++) {
                for (let episodeIndex = 0; episodeIndex < episodesPerRun; episodeIndex++) {
                    const seed = args.seed + stageIndex * 100000 + runIndex * 1000 + episodeIndex * 17 + (policyMode === 'hybrid' ? 503 : 0);
                    episodes.push(runEpisode(stage, policyMode, tuning.params, maxTurns, seed, runIndex, episodeIndex));
                }
            }
            const metrics = aggregateEpisodes(episodes);
            const gateResult = policyPassed(evaluateGates(metrics, gates), enforceCombatGates);
            policyReports[policyMode] = {
                metrics,
                passed: gateResult.passed,
                safetyPassed: gateResult.safetyPassed,
                combatPassed: gateResult.combatPassed,
                failedGates: gateResult.failedGates,
                failedCombatGates: gateResult.failedCombatGates,
                failedSafetyGates: gateResult.failedSafetyGates,
                worstEpisodes: worstEpisodes(episodes)
            };
        }
        stageReports.push({
            id: stage.id,
            name: stage.name,
            environment: stage.environment,
            enforceCombatGates,
            gates,
            policies: policyReports,
            passed: Object.values(policyReports).every((report) => report.passed),
            safetyPassed: Object.values(policyReports).every((report) => report.safetyPassed),
            combatPassed: Object.values(policyReports).every((report) => report.combatPassed)
        });
    }

    const report = {
        generatedAt: new Date().toISOString(),
        config: {
            seed: args.seed,
            runs,
            episodesPerRun,
            maxTurns,
            stage: args.stage,
            policyModes
        },
        tuning: {
            source: tuning.source,
            params: tuning.params
        },
        passed: stageReports.every((stage) => stage.passed),
        safetyPassed: stageReports.every((stage) => stage.safetyPassed),
        combatPassed: stageReports.every((stage) => !stage.enforceCombatGates || stage.combatPassed),
        stages: stageReports,
        notes: [
            'Fast deterministic regression surrogate; use for before/after AI checks.',
            'A pass here should be followed by in-game validation for full Three.js collision behavior.',
            'Only stages with enforceCombatGates=true block overall pass on combat gate failures; others report combat metrics only.'
        ]
    };

    ensureDir(args.out);
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');

    console.log('AI regression finished');
    console.log(`Report: ${args.out}`);
    console.log(`Overall: ${report.passed ? 'PASS' : 'FAIL'}`);
    console.log(`Safety: ${report.safetyPassed ? 'PASS' : 'FAIL'}`);
    console.log(`Combat: ${report.combatPassed ? 'PASS' : 'FAIL'}`);
    for (const stage of stageReports) {
        const parts = Object.entries(stage.policies).map(([policy, result]) => {
            const m = result.metrics;
            const combatTag = stage.enforceCombatGates ? ` combat=${result.combatPassed ? 'PASS' : 'FAIL'}` : '';
            return `${policy} ${result.passed ? 'PASS' : 'FAIL'} safety=${result.safetyPassed ? 'PASS' : 'FAIL'}${combatTag} crash=${m.crashRate} stall=${m.stallEventsPerEpisode} win=${m.winRate} gun=${m.avgHitsGun} enemyHp=${m.avgEnemyHpLeft} turns=${m.avgTurns} bldg=${m.buildingCollisionRate}`;
        });
        console.log(`${stage.id}: ${parts.join(' | ')}`);
        if (stage.enforceCombatGates) {
            for (const [policy, result] of Object.entries(stage.policies)) {
                if (result.failedCombatGates && result.failedCombatGates.length) {
                    const detail = result.failedCombatGates.map((g) => `${g.gate}=${g.actual}/${g.op}${g.limit}`).join(', ');
                    console.log(`  ${policy} combat failures: ${detail}`);
                }
            }
        }
    }

    if (!report.passed) process.exitCode = 1;
}

main();
