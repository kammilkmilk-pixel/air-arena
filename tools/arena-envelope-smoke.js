#!/usr/bin/env node
/**
 * arena-envelope-smoke.js — venue envelope profile + relative soft score.
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const api = require(path.join(ROOT, 'js', 'core', 'arena-envelope.js'));

const fails = [];

// Map-sized city: diameter from ground/envelope.
const cityDoc = {
    name: 'citymap',
    ground: { width: 1000, depth: 1000, centerX: 10, centerZ: 20 },
    envelope: {
        diameter: 1000,
        softMargin: 240,
        warnMargin: 220,
        centerX: 10,
        centerZ: 20,
        altitude: { bandMin: 35, bandMax: 92, bandHardMax: 108, mandatoryClimbAlt: 36 }
    }
};
const profile = api.applyFromMapDoc(cityDoc);
assert.strictEqual(profile.diameter, 1000, 'city diameter');
assert.ok(Math.abs(profile.radius - 500) < 1e-6);
assert.strictEqual(profile.altitude.bandMin, 35);

// Center sample = clear.
const mid = api.sample({ x: 10, y: 50, z: 20 }, { x: 0, z: 1 }, 50);
assert.strictEqual(mid.band, 'clear');
assert.ok(mid.softProgress < 0.01);

// Near hard rim, outbound heading — centrifugal penalty on align.
const rimPos = { x: 10 + 480, y: 90, z: 20 };
const outFwd = { x: 1, z: 0 };
const rim = api.sample(rimPos, outFwd, 90);
assert.ok(rim.band === 'warn' || rim.band === 'soft' || rim.band === 'outside', `rim band=${rim.band}`);
assert.ok(rim.outboundDot > 0.5, `outDot=${rim.outboundDot}`);

const base = 100;
const alignOut = api.scoreCandidate(base, { state: 'alignFirst', joyX: 0.5, joyY: 0.06 }, rim);
const inwardJoy = api.scoreCandidate(base, { state: 'urbanRouteEscape', joyX: rim.inwardSide * 0.5, joyY: 0.2 }, rim);
assert.ok(alignOut < base, `centrifugal alignOut=${alignOut}`);
assert.ok(inwardJoy > alignOut, `centripetal ${inwardJoy} > ${alignOut}`);

// Low alt: climb rewarded vs weave flat.
const low = api.sample({ x: 10, y: 18, z: 20 }, { x: 0, z: 1 }, 18);
const climb = api.scoreCandidate(base, { state: 'urbanRouteClimbOut', joyX: 0.2, joyY: 0.5 }, low);
const weave = api.scoreCandidate(base, { state: 'urbanBuildingWeave', joyX: 0.5, joyY: 0.08 }, low);
assert.ok(climb > weave, `low-alt climb ${climb} > weave ${weave}`);

// High alt: FOX-1 less punished than hybrid climb.
const high = api.sample({ x: 10, y: 110, z: 20 }, { x: 0, z: 1 }, 110);
const fox = api.scoreCandidate(base, { state: 'fox1Illuminate', joyX: 0, joyY: 0.25 }, high);
const hyb = api.scoreCandidate(base, { state: 'hybridPress', joyX: 0.3, joyY: 0.35 }, high);
assert.ok(fox > hyb, `fox1 high ${fox} > hybrid ${hyb}`);

// Hard building skips radial soft score.
const skip = api.scoreCandidate(base, { state: 'alignFirst', joyX: 0.5, joyY: 0.06 }, rim, { hardBuilding: true });
assert.strictEqual(skip, base, 'hard building bypass');

// High alt + rim: prefer inward descend over align chase.
const highRim = api.sample({ x: 10 + 460, y: 120, z: 20 }, { x: 1, z: 0 }, 120);
assert.ok(highRim.altitude.zone === 'hardHigh' || highRim.altitude.zone === 'high');
const alignHigh = api.scoreCandidate(100, { state: 'alignFirst', joyX: 0.5, joyY: 0.1 }, highRim);
const descendIn = api.scoreCandidate(100, {
    state: 'airspaceAvoid',
    joyX: highRim.inwardSide * 0.5,
    joyY: -0.28
}, highRim);
assert.ok(descendIn > alignHigh, `highRim descendIn ${descendIn} > align ${alignHigh}`);

const pilotSrc = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');
for (const needle of [
    'applyArenaEnvelopeScore',
    'arenaEnvelope:',
    'AirArenaArenaEnvelope',
    'hardHigh inward descend',
    'airspaceRimProtect'
]) {
    if (!pilotSrc.includes(needle)) fails.push(`pilot-ai missing ${needle}`);
}
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!indexSrc.includes('js/core/arena-envelope.js')) fails.push('index.html must load arena-envelope.js');

const memo = fs.readFileSync(path.join(ROOT, 'docs', 'Arena-Map-Onboarding-Memo.md'), 'utf8');
if (!memo.includes('arena-envelope')) fails.push('memo should mention arena-envelope module');

if (fails.length) {
    console.error('arena-envelope-smoke FAIL');
    fails.forEach((f) => console.error(' -', f));
    process.exit(1);
}

console.log('arena-envelope-smoke: PASS');
console.log(`  diameter=${profile.diameter} rimBand=${rim.band} softP=${rim.softProgress.toFixed(2)} alignOut=${alignOut.toFixed(1)} inward=${inwardJoy.toFixed(1)}`);
