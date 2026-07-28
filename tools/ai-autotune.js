#!/usr/bin/env node
/**
 * ai-autotune.js
 *
 * Lightweight surrogate auto-tuner for AirArena AI thresholds.
 * This does not run Three.js physics; it runs a fast combat surrogate
 * model so we can compare parameter sets consistently.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharedDefaults = require(path.join(ROOT, 'js', 'ai', 'pilot-tuning-defaults.js'));
const PARAM_KEYS = sharedDefaults.PARAM_KEYS;
const DEFAULT_BASE_PARAMS = Object.fromEntries(PARAM_KEYS.map((key) => [key, sharedDefaults[key]]));

const DEFAULTS = {
    seed: 20260706,
    iterations: 80,
    episodes: 40,
    turns: 70,
    scenario: 'normal',
    objective: 'balanced',
    out: path.join(__dirname, 'reports', `autotune-${Date.now()}.json`)
};

const SCENARIOS = new Set(['normal', 'low-altitude', 'low-energy', 'high-threat', 'mixed-stress']);
const OBJECTIVES = new Set(['safety-first', 'balanced', 'aggressive']);
const TUNING_FILE = path.join(ROOT, 'js', 'ai', 'pilot-tuning.local.js');

function loadBaseParams() {
    const params = { ...DEFAULT_BASE_PARAMS };
    if (!fs.existsSync(TUNING_FILE)) {
        return { params, source: 'built-in-defaults' };
    }
    const raw = fs.readFileSync(TUNING_FILE, 'utf8');
    for (const key of PARAM_KEYS) {
        const match = raw.match(new RegExp(`${key}:\\s*([-+]?\\d*\\.?\\d+)`));
        if (match) {
            params[key] = Number(match[1]);
        }
    }
    return { params, source: path.relative(process.cwd(), TUNING_FILE) };
}

function parseArgs(argv) {
    const args = { ...DEFAULTS };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const v = argv[i + 1];
        if (!k.startsWith('--')) continue;
        const key = k.slice(2);
        if (key in args && v !== undefined && !v.startsWith('--')) {
            args[key] = (typeof args[key] === 'number') ? Number(v) : v;
            i++;
        }
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

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function pickRange(rand, min, max) {
    return min + (max - min) * rand();
}

function pickStressScenario(rand, scenario) {
    if (scenario !== 'mixed-stress') return scenario;
    const options = ['low-altitude', 'low-energy', 'high-threat'];
    return options[Math.floor(rand() * options.length)];
}

function mutateParams(rand, base = DEFAULT_BASE_PARAMS) {
    return {
        energyCriticalAp: Math.round(pickRange(rand, 46, 62)),
        lowAp: Math.round(pickRange(rand, 60, 76)),
        stallPitchThreshold: pickRange(rand, 0.08, 0.28),
        minRecoverAlt: Math.round(pickRange(rand, 12, 34)),
        stallRecoverBonus: pickRange(rand, 5.0, 12.0),
        climbPenalty: pickRange(rand, 4.0, 9.5),
        gunRange: Math.round(pickRange(rand, 34, 50)),
        gunAngle: Math.round(pickRange(rand, 16, 30)),
        missileMinRange: Math.round(pickRange(rand, 24, 44)),
        missileMaxRange: Math.round(pickRange(rand, 82, 126)),
        missileAngle: Math.round(pickRange(rand, 18, 38)),
        interceptTurnGain: pickRange(rand, 0.14, 0.34),
        recoverPitchBias: pickRange(rand, -0.36, -0.06),
        hybridAggression: pickRange(rand, 0.25, 0.85),
        _basedOn: base
    };
}

function decideAction(state, policyMode, p) {
    const groundRisk = state.altitude < 24 || (state.altitude < 45 && state.pitch < -0.05);
    if (groundRisk) {
        return {
            state: 'groundAvoid',
            throttle: state.heat > 70 ? 4 : 5,
            joyY: state.ap < p.lowAp ? 0.36 : 0.58,
            joyX: 0.0,
            weapon: 'gun',
            fire: 'none'
        };
    }
    const stallTrap = state.stalled && state.pitch > p.stallPitchThreshold && state.altitude > p.minRecoverAlt;
    if (stallTrap) {
        return { state: 'stallBreakout', throttle: 5, joyY: -0.42, joyX: 0.0, weapon: 'gun', fire: 'none' };
    }
    if (state.ap < p.energyCriticalAp) {
        return { state: 'energyRecover', throttle: 5, joyY: p.recoverPitchBias, joyX: 0.05, weapon: 'gun', fire: 'none' };
    }
    if (state.distance < p.gunRange && state.angleDeg < p.gunAngle) {
        return { state: 'gunAttack', throttle: 3, joyY: -0.05, joyX: 0.20, weapon: 'gun', fire: 'gun' };
    }
    if (
        state.distance > p.missileMinRange &&
        state.distance < p.missileMaxRange &&
        state.angleDeg < p.missileAngle &&
        state.missiles > 0
    ) {
        return { state: 'missileAttack', throttle: 3, joyY: 0.0, joyX: 0.16, weapon: 'missile', fire: 'missile' };
    }

    const baseIntercept = { state: 'intercept', throttle: 4, joyY: 0.0, joyX: 0.26, weapon: 'gun', fire: 'none' };
    if (policyMode === 'hybrid') {
        const aggressive = state.ap > p.lowAp && state.threat < 0.55;
        if (aggressive) {
            return {
                ...baseIntercept,
                state: 'hybridPress',
                throttle: 4,
                joyX: clamp(baseIntercept.joyX + p.hybridAggression * 0.28, 0, 0.75),
                joyY: -0.04
            };
        }
        return {
            ...baseIntercept,
            state: 'hybridConserve',
            throttle: 3,
            joyX: clamp(baseIntercept.joyX * 0.6, 0.05, 0.28),
            joyY: clamp(p.recoverPitchBias * 0.45, -0.16, -0.02)
        };
    }
    return baseIntercept;
}

function applyAction(state, action, p, rand, scenario) {
    const throttleAccel = [0, -4, 0, 2.5, 5.2, 8.2];
    const throttle = clamp(Math.round(action.throttle || 3), 1, 5);
    const turnCostMultiplier = scenario === 'high-threat' ? 1.15 : 1;
    const turnCost = (Math.abs(action.joyX || 0) * 6.8 + Math.max(0, action.joyY || 0) * p.climbPenalty) * turnCostMultiplier;
    const stallPenalty = state.stalled ? (scenario === 'low-energy' ? 9.5 : 7.5) : 0;
    state.ap = clamp(state.ap + throttleAccel[throttle] - turnCost - stallPenalty, 18, 140);

    if (action.state === 'stallBreakout') {
        state.ap = clamp(state.ap + p.stallRecoverBonus, 18, 140);
        state.pitch = clamp(state.pitch - 0.30, -0.75, 0.75);
    } else {
        state.pitch = clamp(state.pitch + (action.joyY || 0) * 0.32, -0.75, 0.75);
    }

    // Simplified kinematics surrogate
    const altitudeStress = scenario === 'low-altitude' ? 0.7 : (scenario === 'low-energy' ? 0.7 : 0);
    const turbulence = scenario === 'high-threat' ? 4.2 : (scenario === 'low-altitude' ? 3.6 : 2.6);
    state.altitude = clamp(state.altitude + (state.pitch * 2.4) + (state.ap - 85) * 0.02 - (state.stalled ? 2.1 : 0.25) - altitudeStress, 0, 160);
    state.angleDeg = clamp(state.angleDeg - (action.joyX || 0) * (12 + p.interceptTurnGain * 20) + pickRange(rand, -turbulence, turbulence), 0, 120);
    state.distance = clamp(state.distance - (state.ap / 25) + Math.abs(state.angleDeg - 15) * 0.08 + pickRange(rand, -1.8, 2.2), 8, 240);
    state.heat = clamp(state.heat + (throttle === 5 ? 11 : throttle === 4 ? 3 : -4), 0, 140);

    const wasStalled = state.stalled;
    state.stalled = state.ap < 45 || (state.pitch > 0.42 && state.ap < 56);
    if (!wasStalled && state.stalled) state.stallStart = state.turn;
    if (wasStalled && !state.stalled && state.stallStart !== null) {
        state.stallDurations.push(state.turn - state.stallStart + 1);
        state.stallStart = null;
    }

    // Enemy pressure model
    const scenarioPressure = scenario === 'high-threat' ? 0.22 : (scenario === 'low-energy' ? 0.08 : 0);
    const pressure = clamp((state.distance < 80 ? 0.28 : 0.08) + (state.angleDeg < 24 ? 0.2 : 0) + (state.stalled ? 0.25 : 0) + scenarioPressure, 0, 0.9);
    state.threat = clamp(pressure + pickRange(rand, -0.12, 0.12), 0, 1);

    // Weapon effects
    if (action.fire === 'gun') {
        const gunHitChance = clamp((p.gunRange - state.distance) / p.gunRange + (p.gunAngle - state.angleDeg) / p.gunAngle, -0.2, 0.85);
        if (rand() < gunHitChance * 0.25) {
            state.enemyHp -= Math.round(pickRange(rand, 7, 13));
            state.hits.gun++;
        }
    } else if (action.fire === 'missile' && state.missiles > 0) {
        state.missiles -= 1;
        const mslHitChance = clamp((p.missileMaxRange - state.distance) / p.missileMaxRange + (p.missileAngle - state.angleDeg) / p.missileAngle, -0.3, 0.9);
        if (rand() < mslHitChance * 0.42) {
            state.enemyHp -= Math.round(pickRange(rand, 18, 38));
            state.hits.missile++;
        }
    }

    // Incoming enemy damage (scripted adversary)
    const incomingChance = clamp((95 - state.distance) / 95 + (30 - state.angleDeg) / 30 + (state.stalled ? 0.35 : 0), -0.2, 0.9);
    const incomingMultiplier = scenario === 'high-threat' ? 0.18 : 0.12;
    if (rand() < incomingChance * incomingMultiplier) {
        state.hp -= Math.round(pickRange(rand, 4, 14));
    }
}

function initEpisodeState(rand, scenario) {
    const state = {
        turn: 1,
        ap: Math.round(pickRange(rand, 78, 124)),
        altitude: pickRange(rand, 18, 56),
        pitch: pickRange(rand, -0.18, 0.36),
        distance: pickRange(rand, 36, 135),
        angleDeg: pickRange(rand, 8, 78),
        heat: pickRange(rand, 8, 52),
        hp: 100,
        enemyHp: 100,
        missiles: 4,
        stalled: false,
        stallStart: null,
        stallDurations: [],
        threat: 0.2,
        hits: { gun: 0, missile: 0 }
    };
    if (scenario === 'low-altitude') {
        state.altitude = pickRange(rand, 5, 22);
        state.pitch = pickRange(rand, -0.02, 0.42);
        state.ap = Math.round(pickRange(rand, 58, 96));
    } else if (scenario === 'low-energy') {
        state.ap = Math.round(pickRange(rand, 36, 72));
        state.altitude = pickRange(rand, 10, 40);
        state.pitch = pickRange(rand, 0.16, 0.58);
    } else if (scenario === 'high-threat') {
        state.distance = pickRange(rand, 18, 72);
        state.angleDeg = pickRange(rand, 22, 96);
        state.ap = Math.round(pickRange(rand, 62, 104));
        state.threat = pickRange(rand, 0.52, 0.86);
    }
    state.stalled = state.ap < 45 || (state.pitch > 0.42 && state.ap < 56);
    if (state.stalled) state.stallStart = 1;
    return state;
}

function runEpisode(policyMode, p, maxTurns, rand, scenario) {
    const activeScenario = pickStressScenario(rand, scenario);
    const state = initEpisodeState(rand, activeScenario);
    let crash = false;

    for (let t = 1; t <= maxTurns; t++) {
        state.turn = t;
        const action = decideAction(state, policyMode, p);
        applyAction(state, action, p, rand, activeScenario);
        if (state.altitude <= 0) {
            crash = true;
            state.hp = 0;
            break;
        }
        if (state.hp <= 0 || state.enemyHp <= 0) break;
    }
    if (state.stalled && state.stallStart !== null) {
        state.stallDurations.push(state.turn - state.stallStart + 1);
    }
    return {
        win: state.enemyHp <= 0 && state.hp > 0,
        crash,
        survive: state.hp > 0,
        hpLeft: clamp(state.hp, 0, 100),
        enemyHpLeft: clamp(state.enemyHp, 0, 100),
        turns: state.turn,
        stallEvents: state.stallDurations.length,
        avgStallDuration: state.stallDurations.length
            ? state.stallDurations.reduce((a, b) => a + b, 0) / state.stallDurations.length
            : 0,
        gunHits: state.hits.gun,
        missileHits: state.hits.missile
    };
}

function scoreAggregate(metrics, objective) {
    if (objective === 'safety-first') {
        return (
            metrics.winRate * 60 +
            metrics.surviveRate * 80 +
            metrics.avgHpLeft * 0.25 +
            metrics.avgGunHits * 1.5 +
            metrics.avgMissileHits * 2.5 -
            metrics.crashRate * 220 -
            metrics.avgStallEvents * 22 -
            metrics.avgStallDuration * 7
        );
    }
    if (objective === 'aggressive') {
        return (
            metrics.winRate * 130 +
            metrics.surviveRate * 35 +
            metrics.avgGunHits * 4.5 +
            metrics.avgMissileHits * 8 -
            metrics.crashRate * 80 -
            metrics.avgStallEvents * 5 -
            metrics.avgStallDuration * 1.5 -
            metrics.avgTurns * 0.15
        );
    }
    return (
        metrics.winRate * 100 +
        metrics.surviveRate * 60 +
        metrics.avgGunHits * 3 +
        metrics.avgMissileHits * 5 -
        metrics.crashRate * 90 -
        metrics.avgStallEvents * 8 -
        metrics.avgStallDuration * 2.6
    );
}

function aggregateEpisodes(episodes, objective) {
    const sum = (key) => episodes.reduce((acc, item) => acc + (item[key] || 0), 0);
    const avg = (key) => episodes.length ? sum(key) / episodes.length : 0;
    const winRate = episodes.length ? sum('win') / episodes.length : 0;
    const crashRate = episodes.length ? sum('crash') / episodes.length : 0;
    const surviveRate = episodes.length ? sum('survive') / episodes.length : 0;
    const metrics = {
        episodes: episodes.length,
        winRate: Number(winRate.toFixed(4)),
        surviveRate: Number(surviveRate.toFixed(4)),
        crashRate: Number(crashRate.toFixed(4)),
        avgTurns: Number(avg('turns').toFixed(2)),
        avgStallEvents: Number(avg('stallEvents').toFixed(3)),
        avgStallDuration: Number(avg('avgStallDuration').toFixed(3)),
        avgGunHits: Number(avg('gunHits').toFixed(3)),
        avgMissileHits: Number(avg('missileHits').toFixed(3)),
        avgHpLeft: Number(avg('hpLeft').toFixed(2)),
        avgEnemyHpLeft: Number(avg('enemyHpLeft').toFixed(2))
    };
    return {
        ...metrics,
        objective,
        score: Number(scoreAggregate(metrics, objective).toFixed(3))
    };
}

function evaluateParams(params, cfg, randSeed) {
    const randA = mulberry32(randSeed);
    const randB = mulberry32(randSeed + 991);
    const episodesHeuristic = [];
    const episodesHybrid = [];

    for (let i = 0; i < cfg.episodes; i++) {
        episodesHeuristic.push(runEpisode('heuristic', params, cfg.turns, randA, cfg.scenario));
        episodesHybrid.push(runEpisode('hybrid', params, cfg.turns, randB, cfg.scenario));
    }

    const heuristic = aggregateEpisodes(episodesHeuristic, cfg.objective);
    const hybrid = aggregateEpisodes(episodesHybrid, cfg.objective);
    const stress = cfg.scenario === 'normal' ? null : {
        stressScore: hybrid.score,
        stressCrashRate: hybrid.crashRate,
        stressWinRate: hybrid.winRate,
        stressAvgStallEvents: hybrid.avgStallEvents,
        stressAvgStallDuration: hybrid.avgStallDuration
    };
    return {
        params,
        scenario: cfg.scenario,
        objective: cfg.objective,
        heuristic,
        hybrid,
        stress,
        delta: {
            score: Number((hybrid.score - heuristic.score).toFixed(3)),
            winRate: Number((hybrid.winRate - heuristic.winRate).toFixed(4)),
            stallEvents: Number((hybrid.avgStallEvents - heuristic.avgStallEvents).toFixed(4)),
            crashRate: Number((hybrid.crashRate - heuristic.crashRate).toFixed(4))
        }
    };
}

function rankResults(results) {
    return [...results].sort((a, b) => b.hybrid.score - a.hybrid.score);
}

function summarizeTop(results, n = 8) {
    return rankResults(results).slice(0, n).map((item, idx) => ({
        rank: idx + 1,
        hybridScore: item.hybrid.score,
        heuristicScore: item.heuristic.score,
        deltaScore: item.delta.score,
        deltaWinRate: item.delta.winRate,
        deltaCrashRate: item.delta.crashRate,
        stressScore: item.stress ? item.stress.stressScore : null,
        stressCrashRate: item.stress ? item.stress.stressCrashRate : null,
        scenario: item.scenario,
        objective: item.objective,
        params: item.params
    }));
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

function main() {
    const cfg = parseArgs(process.argv);
    if (!SCENARIOS.has(cfg.scenario)) {
        console.error(`Unknown scenario: ${cfg.scenario}`);
        console.error(`Supported scenarios: ${[...SCENARIOS].join(', ')}`);
        process.exit(1);
    }
    if (!OBJECTIVES.has(cfg.objective)) {
        console.error(`Unknown objective: ${cfg.objective}`);
        console.error(`Supported objectives: ${[...OBJECTIVES].join(', ')}`);
        process.exit(1);
    }
    const rand = mulberry32(cfg.seed);
    const base = loadBaseParams();
    const baseParams = base.params;
    const trials = [];

    // Include baseline first
    trials.push(evaluateParams(baseParams, cfg, cfg.seed + 7));
    for (let i = 0; i < cfg.iterations; i++) {
        const params = mutateParams(rand, baseParams);
        trials.push(evaluateParams(params, cfg, cfg.seed + 1000 + i * 13));
    }

    const ranked = rankResults(trials);
    const report = {
        generatedAt: new Date().toISOString(),
        config: cfg,
        baseParamsSource: base.source,
        baseline: trials[0],
        best: ranked[0],
        top: summarizeTop(ranked, 10),
        notes: [
            'This report comes from a surrogate model (fast approximation).',
            'Use it to shortlist threshold candidates before in-game validation.'
        ]
    };

    ensureDir(cfg.out);
    fs.writeFileSync(cfg.out, JSON.stringify(report, null, 2), 'utf8');

    console.log('AI autotune finished');
    console.log(`Scenario: ${cfg.scenario}`);
    console.log(`Objective: ${cfg.objective}`);
    console.log(`Base params: ${base.source}`);
    console.log(`Report: ${cfg.out}`);
    console.log(`Best hybrid score: ${ranked[0].hybrid.score} (delta vs heuristic: ${ranked[0].delta.score})`);
}

main();
