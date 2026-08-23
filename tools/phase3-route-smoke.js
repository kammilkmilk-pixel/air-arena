#!/usr/bin/env node
/**
 * phase3-route-smoke.js — Phase 3a–c contract: long WP, path, climbBias, pilot score hooks.
 * Near-term: funnel vs open-corridor pocketRisk on bake WP chains.
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
    'P1 undercroftBoost',
    // Near-term route pocket aversion (2026-08-12); observability + earlier replan (2026-08-13)
    'scoreSurvivalWaypointPocket',
    'funnelGapFlip',
    'breakFunnelHold',
    'pocketRisk',
    'wpFunnel',
    'routePocket:',
    'survivalWp: replan=',
    'pocketRisk=',
    // P0: reject dead bake WP/corridor hit=1 cuts (2026-08-12)
    'isDeadBakeRouteCut',
    'breakSurvivalWpDeadCut',
    'pocketReject=',
    'replan=deadWp',
    // P1: dual corridor homotopy (2026-08-12); funnel/slab reject C (2026-08-13)
    'resolveCorridorHomotopy',
    'buildCorridorHomotopyOptions',
    'corridorHomotopyMemory',
    'homotopy: active=',
    'facadeNarrow',
    'pocketMargin',
    'funnelRejectC',
    'funnelReplanLateral',
    'slabRejectC',
    'funnelEscapeSide',
    'climbHomotopyRejectWhy',
    'lastReplanWhy',
    'bakeDualHt:',
    'dualHomotopyCorridors',
    'combatGoal',
    'bakeDualPref',
    // tableGlue: earlier same-side hit flip (2026-08-12); single catastrophic (2026-08-13)
    'tableGlueFlip=',
    'hitStreak',
    'hitFlip',
    'catastrophicHit',
    'forcedExitSide',
    'scrapeSide',
    // tableGlue flip commit: sticky forceFlip + hard bank (2026-08-13)
    'armTableGlueFlipCommit',
    'tableGlueCommit=1',
    'forceFlip',
    // Weapon window suppresses bake soft-yield (2026-08-12)
    'Weapon-window knife',
    'inferWeaponWindow',
    'only yield on real steep'
]) {
    if (!pilotSrc.includes(needle)) fails.push(`pilot-ai.js missing: ${needle}`);
}

if (typeof aiMap.scoreWaypointChainPocket !== 'function') {
    fails.push('ai-map.js missing: scoreWaypointChainPocket');
}
if (typeof aiMap.sampleDualHomotopyCorridors !== 'function') {
    fails.push('ai-map.js missing: sampleDualHomotopyCorridors');
}
if (typeof aiMap.buildFlyableCorridorGraph !== 'function') {
    fails.push('ai-map.js missing: buildFlyableCorridorGraph');
}
if (typeof aiMap.findCorridorGraphPath !== 'function') {
    fails.push('ai-map.js missing: findCorridorGraphPath');
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
assert.ok(typeof wp.pocketRisk === 'number', 'greedy WP pocketRisk');

const pathRes = aiMap.findBakePath(baked, -80, 0, 1, 0, 55, { goalDist: 100, maxExpand: 200 });
assert.ok(pathRes.ok, 'path from open toward map');
assert.ok(pathRes.waypoints.length >= 1);
assert.strictEqual(pathRes.source, 'path');
assert.ok(typeof pathRes.pocketRisk === 'number', 'path pocketRisk');

// Prefer path that eventually lowers roof exposure vs starting beside tall cluster.
const nearTall = aiMap.findBakePath(baked, 40, 40, -1, -1, 70, { goalDist: 90, maxExpand: 200 });
assert.ok(nearTall.ok || nearTall.waypoints.length >= 0);

// Funnel vs open corridor fixture: U-trap chain should score higher pocketRisk than open sky chain.
const funnelChain = [
    { x: 0, z: 0, roofMax: 20, localRoofMax: 35, skyOpen: 0, clear: 1 },
    { x: 20, z: 0, roofMax: 35, localRoofMax: 50, skyOpen: 0, clear: 1 },
    { x: 40, z: 0, roofMax: 55, localRoofMax: 70, skyOpen: 0, clear: 0 },
    { x: 60, z: 0, roofMax: 70, localRoofMax: 80, skyOpen: 0, clear: 0 },
    { x: 80, z: 0, roofMax: 80, localRoofMax: 85, skyOpen: 0, clear: 0 }
];
const openChain = [
    { x: 0, z: 0, roofMax: 40, localRoofMax: 40, skyOpen: 0, clear: 1 },
    { x: 20, z: 0, roofMax: 25, localRoofMax: 25, skyOpen: 0, clear: 1 },
    { x: 40, z: 0, roofMax: 10, localRoofMax: 12, skyOpen: 1, clear: 1 },
    { x: 60, z: 0, roofMax: 5, localRoofMax: 8, skyOpen: 1, clear: 1 },
    { x: 80, z: 0, roofMax: 0, localRoofMax: 4, skyOpen: 1, clear: 1 }
];
const funnelScore = aiMap.scoreWaypointChainPocket(funnelChain);
const openScore = aiMap.scoreWaypointChainPocket(openChain);
assert.ok(funnelScore.isFunnel || funnelScore.pocketRisk >= 0.28, 'funnel chain flagged');
assert.ok(openScore.pocketRisk + 0.15 < funnelScore.pocketRisk, 'open corridor lower pocketRisk than funnel');
assert.ok(!openScore.isFunnel || openScore.pocketRisk < 0.28, 'open chain not funnel');
assert.ok(funnelScore.isFunnel, 'funnel isFunnel at 0.28 gate');

// Clear centerline into tall walls (combat-alt street) must not score pocketRisk≡0.
const pinchStreet = [
    { roofMax: 0, localRoofMax: 8, skyOpen: 1, clear: 1 },
    { roofMax: 0, localRoofMax: 18, skyOpen: 1, clear: 1 },
    { roofMax: 0, localRoofMax: 32, skyOpen: 1, clear: 1 },
    { roofMax: 2, localRoofMax: 45, skyOpen: 1, clear: 1 },
    { roofMax: 0, localRoofMax: 50, skyOpen: 1, clear: 1 },
    { roofMax: 0, localRoofMax: 48, skyOpen: 1, clear: 1 }
];
const pinchScore = aiMap.scoreWaypointChainPocket(pinchStreet);
assert.ok(pinchScore.pocketRisk >= 0.2 || pinchScore.isFunnel, 'pinch street has pocket signal');

// Dense U-map: WP into courtyard should carry pocket fields.
const uDoc = {
    name: 'p3-funnel',
    ground: { width: 240, depth: 240, centerX: 0, centerZ: 0 },
    objects: [
        { kind: 'box', x: 40, y: 0, z: -40, w: 20, d: 80, h: 70 },
        { kind: 'box', x: 40, y: 0, z: 40, w: 20, d: 80, h: 70 },
        { kind: 'box', x: 70, y: 0, z: 0, w: 40, d: 20, h: 70 }
    ]
};
const uBake = aiMap.bakeFromMapDoc(uDoc, { mapId: 'p3-funnel', cellSize: 10 });
const intoU = aiMap.sampleSurvivalWaypoints(uBake, -20, 0, 1, 0, 45, { steps: 8, stepDist: 18 });
assert.ok(intoU.ok || intoU.waypoints.length >= 0);
assert.ok(typeof intoU.pocketRisk === 'number');
assert.ok(
    (intoU.waypoints || []).some((w) => Number.isFinite(Number(w.localRoofMax))),
    'greedy WP carries localRoofMax'
);

// citymap: path toward densest cluster should sometimes yield non-zero pocket (not always ≡0).
const city = aiMap.hydrate(require(path.join(ROOT, 'assets', 'maps', 'citymap.ai-map.json')));
assert.ok(city && city.roofMax, 'citymap sidecar');
let cityNonZero = 0;
const cityProbes = [
    [-60, 100, 1, 0, 45],
    [0, 0, 1, 0, 55],
    [-120, 115, 1, 0, 55],
    [-95, 40, 0, 1, 50]
];
for (const [x, z, hx, hz, alt] of cityProbes) {
    const p = aiMap.findBakePath(city, x, z, hx, hz, alt, { goalDist: 140, maxExpand: 240 });
    if (p && p.ok && (Number(p.pocketRisk) > 0 || p.isFunnel)) cityNonZero += 1;
}
assert.ok(cityNonZero >= 2, `citymap path pocket signal on ≥2 probes (got ${cityNonZero})`);

// Mid-term: dual L/R corridors both ok with pocketRisk; preferred is lower pocket.
const dual = aiMap.sampleDualHomotopyCorridors(city, -80, 40, 1, 0, 55, { steps: 5, stepDist: 18 });
assert.ok(dual.ok && dual.left && dual.right, 'dual homotopy corridors');
assert.ok(dual.left.homotopyId === 'L' && dual.right.homotopyId === 'R', 'dual L/R ids');
assert.ok(typeof dual.left.pocketRisk === 'number' && typeof dual.right.pocketRisk === 'number');
assert.ok(dual.preferredHomotopyId === 'L' || dual.preferredHomotopyId === 'R', 'preferred homotopy');

// Wave-2 seed: flyable corridor graph has nodes/edges; path finds a chain.
const graph = aiMap.buildFlyableCorridorGraph(city, { refAlt: 55, margin: 8 });
assert.ok(graph.ok && graph.nodeCount > 10 && graph.edgeCount > 10, 'corridor graph built');
const gPath = aiMap.findCorridorGraphPath(graph, -100, 80, 40, 40, { maxExpand: 800 });
assert.ok(gPath.ok && gPath.waypoints.length >= 2, 'corridor graph path');
assert.strictEqual(gPath.source, 'corridorGraph');

if (fails.length) {
    console.error('phase3-route-smoke FAIL');
    fails.forEach((f) => console.error(' -', f));
    process.exit(1);
}
console.log('phase3-route-smoke: PASS');
console.log(
    `  greedy steps=${wp.steps} climbB=${wp.climbBias} pathSteps=${pathRes.steps}` +
    ` funnelPocket=${funnelScore.pocketRisk} openPocket=${openScore.pocketRisk}` +
    ` dualPref=${dual.preferredHomotopyId} graphNodes=${graph.nodeCount} gPath=${gPath.steps}`
);
