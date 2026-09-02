#!/usr/bin/env node
/**
 * A.1 intercept corridor: bake heading + dual L/R toward predicted enemy XZ (live pilot-ai.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');
const aiMap = require(path.join(ROOT, 'js', 'ai', 'ai-map.js'));

function check(cond, msg) {
    if (!cond) throw new Error(msg);
}

check(src.includes('    resolveInterceptCorridorHeading('), 'missing resolveInterceptCorridorHeading');
check(src.includes('dualHomotopyCorridors.goalSource) || \'nose\'}'), 'missing bakeDualHt goal= needle');
check(src.includes('sensor.hasContact ? enemyLeadPos.x'), 'sampleAiMapContext must receive intercept XZ');
check(src.includes('survivalPressure: this.shouldUseSurvivalWaypoints(coverInfo, {})'), 'survival pressure must keep nose escape');
check(src.includes('if (dot >= 0.15)'), 'ahead-dot mix floor must stay 0.15');
check(src.includes('out.x = nx * 0.4 + ix * 0.6'), 'nose/goal mix weights must stay 0.4/0.6');
check(typeof aiMap.pickDualHomotopyTowardGoal === 'function', 'ai-map missing pickDualHomotopyTowardGoal');

function resolveInterceptCorridorHeading(selfPos, noseFwd, opts = {}) {
    const nx0 = Number(noseFwd && noseFwd.x) || 0;
    const nz0 = Number(noseFwd && noseFwd.z) || 0;
    const nlen = Math.hypot(nx0, nz0);
    const nx = nlen > 1e-4 ? nx0 / nlen : 0;
    const nz = nlen > 1e-4 ? nz0 / nlen : 1;
    const out = {
        x: nx,
        z: nz,
        goalSource: 'nose',
        goalDist: 0,
        useGoalPick: false
    };
    if (opts.survivalPressure) return out;
    const gx = Number(opts.goalX);
    const gz = Number(opts.goalZ);
    const sx = Number(selfPos && selfPos.x);
    const sz = Number(selfPos && selfPos.z);
    if (!Number.isFinite(gx) || !Number.isFinite(gz) || !Number.isFinite(sx) || !Number.isFinite(sz)) {
        return out;
    }
    const dx = gx - sx;
    const dz = gz - sz;
    const glen = Math.hypot(dx, dz);
    out.goalDist = glen;
    if (glen < 12) return out;
    const ix = dx / glen;
    const iz = dz / glen;
    const dot = nx * ix + nz * iz;
    out.useGoalPick = true;
    if (dot >= 0.15) {
        out.x = nx * 0.4 + ix * 0.6;
        out.z = nz * 0.4 + iz * 0.6;
        out.goalSource = 'intercept';
    }
    return out;
}

const ahead = resolveInterceptCorridorHeading({ x: 0, z: 0 }, { x: 1, z: 0 }, { goalX: 80, goalZ: 0 });
check(ahead.goalSource === 'intercept', 'ahead contact must mix intercept heading');
check(ahead.useGoalPick, 'ahead contact must enable L/R goal pick');
check(ahead.x > 0.9 && Math.abs(ahead.z) < 1e-6, 'ahead mix stays on intercept axis');

const behind = resolveInterceptCorridorHeading({ x: 0, z: 0 }, { x: 1, z: 0 }, { goalX: -80, goalZ: 0 });
check(behind.goalSource === 'nose', 'behind contact must keep nose heading');
check(behind.useGoalPick, 'behind contact may still pick L/R toward intercept');
check(Math.abs(behind.x - 1) < 1e-6 && Math.abs(behind.z) < 1e-6, 'behind must not reverse into the tail');

const abeam = resolveInterceptCorridorHeading({ x: 0, z: 0 }, { x: 1, z: 0 }, { goalX: 0, goalZ: 80 });
check(abeam.goalSource === 'nose', 'abeam contact keeps nose walk');
check(abeam.useGoalPick, 'abeam still picks the formable street toward intercept');

const pressure = resolveInterceptCorridorHeading(
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { goalX: 80, goalZ: 0, survivalPressure: true }
);
check(pressure.goalSource === 'nose' && !pressure.useGoalPick, 'survival pressure must ignore intercept');

const close = resolveInterceptCorridorHeading({ x: 0, z: 0 }, { x: 1, z: 0 }, { goalX: 5, goalZ: 0 });
check(close.goalSource === 'nose' && !close.useGoalPick, 'too-close intercept must keep nose');

const fakeL = {
    pocketRisk: 0.22,
    isFunnel: false,
    corridorOpen: true,
    waypoints: [{ x: -20, z: 0 }]
};
const fakeR = {
    pocketRisk: 0.20,
    isFunnel: false,
    corridorOpen: true,
    waypoints: [{ x: 80, z: 0 }]
};
assert.strictEqual(aiMap.pickDualHomotopyTowardGoal(fakeL, fakeR), 'R', 'no goal → lower pocket');
assert.strictEqual(aiMap.pickDualHomotopyTowardGoal(fakeL, fakeR, -30, 0), 'L', 'open L closer to goal');
assert.strictEqual(aiMap.pickDualHomotopyTowardGoal(fakeL, fakeR, 90, 0), 'R', 'open R closer to goal');

const funnelL = {
    pocketRisk: 0.10,
    isFunnel: true,
    corridorOpen: false,
    waypoints: [{ x: -5, z: 0 }]
};
assert.strictEqual(
    aiMap.pickDualHomotopyTowardGoal(funnelL, fakeR, -5, 0),
    'R',
    'funnel closer to goal still loses to formable street'
);

console.log('intercept-corridor-smoke: PASS');
