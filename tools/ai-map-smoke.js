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

    const open = aiMap.query(baked, -40, -40);
    assert.ok(open.ok);
    assert.ok(open.roofMax < 5);
    assert.strictEqual(open.skyOpen, true);
    assert.strictEqual(open.sarhPerch, true);

    const local = aiMap.queryRoofMaxInRadius(baked, 0, 0, 30);
    assert.ok(local.ok);
    assert.ok(local.roofMax >= 49);

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
