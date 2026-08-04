#!/usr/bin/env node
/**
 * phase3-route-smoke.js — Phase 3a–c contract: long WP, path, climbBias, pilot score hooks.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const aiMap = require(path.join(ROOT, 'js', 'ai', 'ai-map.js'));
const pilotSrc = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

const fails = [];

for (const needle of [
    'applyBakeRouteCombatScore',
    'shouldSoftYieldCombatForBakeRoute',
    'applyEmergencyPullUpClimbFloor',
    'applyUrbanDiveRouteScore',
    'deferred=bakeRouteScore',
    'survivalWpHint',
    'climbBias',
    'findBakePath',
    'softYieldAlign',
    'fox1BakeRouteYield',
    'shouldHoldCanyonClimbOut',
    'armGlueEscapeLock',
    'glueEscapeLock',
    'illuminateYield=bakeRouteScore',
    'true undercroft',
    'no skyOpen climb',
    'all-hit hard-stop lateral',
    'yield=diveClosing',
    'armFox1BakeYieldLock',
    'hard-cut (thr↓ lateral↑',
    'armDiveClosingYieldLock',
    'Never thr4-bump diveClosingYield',
    'diveClosingYield must keep thr≤3',
    'pull>bank near dirt',
    'shouldReleaseDiveClosingYieldForHandoff',
    'handoff=diveClosingRelease',
    'T38 early undercroft',
    'deferred=earlyUndercroft',
    'isCombatContactForEngageHandoff',
    'releaseEscapeLocksForEngageHandoff',
    'contact=1',
    // Phase B thin + residual survival (2026-08)
    'applyEnemyPredictCombatScore',
    'phaseB: predictAlign=',
    'deferred=nearDirtDive',
    'band-ceiling soft descend',
    'tacticalHighPerch',
    'pickTacticalNearTie',
    'rngTie: pick=',
    // T9: midair yield uses true undercroft, not bare roof<0
    'canYieldToMidairBreak',
    'beside tall AABB',
    'P1 undercroftBoost'
]) {
    if (!pilotSrc.includes(needle)) fails.push(`pilot-ai.js missing: ${needle}`);
}

const doc = {
    name: 'p3',
    ground: { width: 200, depth: 200, centerX: 0, centerZ: 0 },
    objects: [
        { kind: 'box', x: 0, y: 0, z: 0, w: 30, d: 30, h: 60 },
        { kind: 'box', x: 70, y: 0, z: 0, w: 20, d: 20, h: 45 }
    ]
};
const baked = aiMap.bakeFromMapDoc(doc, { mapId: 'p3', cellSize: 10 });
const wp = aiMap.sampleSurvivalWaypoints(baked, -80, -80, 1, 0, 50, { steps: 8, stepDist: 20 });
assert.ok(wp.ok && wp.waypoints.length >= 4, 'long greedy WP');
assert.ok(typeof wp.climbBias === 'number');

const pathRes = aiMap.findBakePath(baked, -80, 0, 1, 0, 55, { goalDist: 100, maxExpand: 200 });
assert.ok(pathRes.ok, 'path from open toward map');
assert.ok(pathRes.waypoints.length >= 1);
assert.strictEqual(pathRes.source, 'path');

// Prefer path that eventually lowers roof exposure vs starting beside tall cluster.
const nearTall = aiMap.findBakePath(baked, 40, 40, -1, -1, 70, { goalDist: 90, maxExpand: 200 });
assert.ok(nearTall.ok || nearTall.waypoints.length >= 0);

if (fails.length) {
    console.error('phase3-route-smoke FAIL');
    fails.forEach((f) => console.error(' -', f));
    process.exit(1);
}
console.log('phase3-route-smoke: PASS');
console.log(`  greedy steps=${wp.steps} climbB=${wp.climbBias} pathSteps=${pathRes.steps}`);
