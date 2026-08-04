#!/usr/bin/env node
/**
 * ai-map-smoke.js — bake/query contract + write sidecars for packaged maps.
 * Usage:
 *   node tools/ai-map-smoke.js
 *   node tools/ai-map-smoke.js --write   # regenerate assets/maps/*.ai-map.json from map JSON
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const aiMap = require(path.join(ROOT, 'js', 'ai', 'ai-map.js'));

function main() {
    const write = process.argv.includes('--write');

    assert.strictEqual(aiMap.sidecarUrlFromMapPath('assets/maps/citymap.json'), 'assets/maps/citymap.ai-map.json');
    assert.strictEqual(aiMap.sidecarUrlFromMapPath('assets/maps/default.json'), 'assets/maps/default.ai-map.json');

    const sampleDoc = {
        name: 'smoke',
        ground: { width: 100, depth: 100, centerX: 0, centerZ: 0 },
        objects: [
            { kind: 'box', x: 0, y: 0, z: 0, w: 20, d: 20, h: 50 },
            { kind: 'box', x: 40, y: 0, z: 40, w: 10, d: 10, h: 12 }
        ]
    };
    const baked = aiMap.bakeFromMapDoc(sampleDoc, { mapId: 'smoke', cellSize: 10 });
    assert.ok(baked.cols >= 10 && baked.rows >= 10);
    assert.strictEqual(baked.source, 'mapDoc');

    const center = aiMap.query(baked, 0, 0);
    assert.ok(center.ok);
    assert.ok(center.roofMax >= 49, `expected tall roof near origin, got ${center.roofMax}`);
    assert.strictEqual(center.skyOpen, false);
    assert.strictEqual(center.sarhPerch, false);
    assert.strictEqual(center.lane, 'combat'); // mapLane vocabulary (roof band), not flightBand

    const open = aiMap.query(baked, -40, -40);
    assert.ok(open.ok);
    assert.ok(open.roofMax < 5);
    assert.strictEqual(open.skyOpen, true);
    assert.strictEqual(open.sarhPerch, true);
    assert.strictEqual(open.lane, 'dirt');

    const local = aiMap.queryRoofMaxInRadius(baked, 0, 0, 30);
    assert.ok(local.ok);
    assert.ok(local.roofMax >= 49);
    // Phase 1: clearAbove-style margin — flying above local roof with open cell nearby.
    assert.ok((55 - local.roofMax) < 8, 'tall cell should not count as clearAbove at combat alt');
    assert.ok((12 - open.roofMax) >= 8 && open.skyOpen, 'open cell supports clearAbove margin');

    // Phase 2: planner corridor samples lateral/forward roof along heading.
    assert.ok(typeof aiMap.samplePlannerCorridor === 'function');
    const corrTowardTall = aiMap.samplePlannerCorridor(baked, -40, -40, 1, 0, 48, { lookAhead: 40, lateral: 20 });
    assert.ok(corrTowardTall.ok);
    const corrOpen = aiMap.samplePlannerCorridor(baked, -40, -40, -1, 0, 48, { lookAhead: 30, lateral: 15 });
    assert.ok(corrOpen.ok);
    assert.ok(corrOpen.forwardClear || corrOpen.forwardSkyOpen || corrOpen.corridorOpen,
        'open-sky heading should report clear/corridor');
    const corrAtTall = aiMap.samplePlannerCorridor(baked, 0, 0, 0, 1, 20, { lookAhead: 20, lateral: 15 });
    assert.ok(corrAtTall.ok);
    assert.ok(corrAtTall.forwardRoofMax >= 40 || !corrAtTall.forwardClear,
        'near tall box at low alt should not be forwardClear');

    // Phase 3 MVP: greedy survival waypoints bend away from tall cell.
    assert.ok(typeof aiMap.sampleSurvivalWaypoints === 'function');
    const wpAway = aiMap.sampleSurvivalWaypoints(baked, -40, -40, -1, 0, 48, { steps: 8, stepDist: 20, lateral: 15 });
    assert.ok(wpAway.ok, 'open-sky heading should yield survival waypoints');
    assert.ok(wpAway.waypoints.length >= 4, `expected longer WP chain (>=4), got ${wpAway.waypoints.length}`);
    assert.ok(wpAway.waypoints.every((w) => w.clear || w.skyOpen), 'open path waypoints should be clear/sky');
    assert.ok(typeof wpAway.climbBias === 'number', 'climbBias present');
    const wpIntoTall = aiMap.sampleSurvivalWaypoints(baked, -30, 0, 1, 0, 20, { steps: 6, stepDist: 15, lateral: 12 });
    assert.ok(wpIntoTall.ok || wpIntoTall.waypoints.length >= 1, 'should still sample near tall');
    if (wpIntoTall.ok && wpIntoTall.preferredSide !== 0) {
        assert.ok(Math.abs(wpIntoTall.preferredSide) === 1, 'preferredSide is -1|1 when set');
    }
    // Low alt near tall box should request climb bias / targetAlt.
    const wpLow = aiMap.sampleSurvivalWaypoints(baked, 0, -30, 0, 1, 22, { steps: 6, stepDist: 15, lateral: 12 });
    if (wpLow.ok && wpLow.waypoints.some((w) => (w.roofMax || 0) > 30)) {
        assert.ok(wpLow.climbBias > 0 || (wpLow.targetAlt != null && wpLow.targetAlt > 22),
            'near-tall low alt should climbBias or raise targetAlt');
    }

    // Phase 3c: bake-grid pathfinding prefers open cells away from tall roof.
    assert.ok(typeof aiMap.findBakePath === 'function');
    const pathAway = aiMap.findBakePath(baked, -40, -40, -1, 0, 48, { goalDist: 80, maxExpand: 160 });
    assert.ok(pathAway.ok, 'open heading should find bake path');
    assert.ok(pathAway.waypoints.length >= 1, 'path should have waypoints');
    assert.strictEqual(pathAway.source, 'path');
    // Prefer path that does not dive into the tall origin cell as first hop when flying open.
    if (pathAway.waypoints.length >= 1) {
        assert.ok((pathAway.waypoints[0].roofMax || 0) < 40, 'first path hop should stay open-ish');
    }
    const pathFromTall = aiMap.findBakePath(baked, 5, 5, -1, -1, 55, { goalDist: 70, maxExpand: 180 });
    assert.ok(pathFromTall.ok || pathFromTall.waypoints.length >= 1, 'path near tall should still sample');
    if (pathFromTall.ok) {
        assert.ok(pathFromTall.waypoints.length >= 1);
        assert.ok(typeof pathFromTall.climbBias === 'number');
    }

    const roundTrip = aiMap.hydrate(aiMap.toJSON(baked));
    assert.ok(roundTrip);
    assert.strictEqual(roundTrip.cols, baked.cols);
    assert.strictEqual(aiMap.query(roundTrip, 0, 0).roofMax, center.roofMax);

    // Packaged maps: bake + optional write sidecar
    const mapFiles = [
        { id: 'citymap', json: 'assets/maps/citymap.json' },
        { id: 'default', json: 'assets/maps/default.json' }
    ];
    for (const entry of mapFiles) {
        const abs = path.join(ROOT, entry.json);
        if (!fs.existsSync(abs)) continue;
        const doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
        const map = aiMap.bakeFromMapDoc(doc, { mapId: entry.id, cellSize: 10 });
        assert.ok(map.cols > 0 && map.rows > 0, entry.id);
        const sidecarRel = aiMap.sidecarUrlFromMapPath(entry.json);
        const sidecarAbs = path.join(ROOT, sidecarRel);
        if (write) {
            fs.writeFileSync(sidecarAbs, JSON.stringify(aiMap.toJSON(map)));
            console.log(`wrote ${sidecarRel} (${map.cols}x${map.rows})`);
        } else if (fs.existsSync(sidecarAbs)) {
            const hydrated = aiMap.hydrate(JSON.parse(fs.readFileSync(sidecarAbs, 'utf8')));
            assert.ok(hydrated, `hydrate ${sidecarRel}`);
            assert.strictEqual(hydrated.cols, map.cols);
        }
    }

    console.log('ai-map-smoke: PASS');
}

main();
