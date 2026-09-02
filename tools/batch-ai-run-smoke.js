'use strict';

const Batch = require('../js/core/batch-ai-run.js');

function SPAWN_OK(alt, sep) {
    return Batch.SPAWN_ALTS_ALL.indexOf(alt) >= 0 && Batch.SPAWN_SEPS.indexOf(sep) >= 0;
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const q = Batch.parseSearch(
    '?skipSetup=1&lab=1&mode=2v2&arena=dense-urban&brains=Rei_03&batch=3&batchIndex=2&ingest=http://127.0.0.1:8091/dump&session=b2-test'
);
assert(q.brains === 'Rei_03', 'brains');
assert(q.mode === '2v2', 'mode');
assert(q.arena === 'dense-urban', 'arena');
assert(q.batchN === 3 && q.batchIndex === 2, 'batch');
assert(q.autoExport === true, 'autoExport');
assert(q.batchFast === true, 'batchFast default');
assert(q.ingest.indexOf('127.0.0.1:8091') >= 0, 'ingest');
assert(q.hasBatchHint === true, 'hint');
assert(q.mapId === 'citymap', 'default map is packaged City Map');
assert(Batch.parseSearch('?brains=test_01&map=original').mapId === 'original', 'map override');

assert(Batch.sanitizeBrain('ling_0') === 'Rei_01', 'legacy brain');
assert(Batch.sanitizeBrain('nope') === 'test_01', 'unknown brain');
assert(Batch.sanitizeArena('buildings') === 'dense-urban', 'arena alias');

const blocked = Batch.parseSearch('?ingest=http://example.com/steal');
assert(blocked.ingest === '', 'ingest host lock');

assert(q.spawnMix === true, 'spawn mix default');
assert(q.spawnFormation === 'cross', 'batch 2v2 cross');
assert(q.spawnFacing === 'tangent', 'cross default tangent');
assert(Batch.SPAWN_ALTS_ROOF.indexOf(q.spawnAltitude) >= 0, 'cross mix uses roof alts');
assert(Batch.SPAWN_SEPS_CROSS.indexOf(q.spawnSeparation) >= 0, 'cross mix drops sep 60');
assert(SPAWN_OK(q.spawnAltitude, q.spawnSeparation), 'mixed spawn legal');
const q2 = Batch.parseSearch(
    '?skipSetup=1&brains=Rei_03&batch=3&batchIndex=3&session=b2-test'
);
assert(q2.spawnAltitude !== q.spawnAltitude || q2.spawnSeparation !== q.spawnSeparation, 'index changes spawn');

const locked = Batch.parseSearch('?brains=test_01&alt=60&sep=200');
assert(locked.spawnAltitude === 60 && locked.spawnSeparation === 200 && locked.spawnMix === false, 'spawn lock');
const gold = Batch.parseSearch(
    '?skipSetup=1&lab=1&mode=2v2&arena=dense-urban&map=citymap&brains=test_01&batch=3&alt=80&sep=200&spawnFormation=cross&spawnFacing=tangent&spawnMix=0'
);
assert(gold.spawnAltitude === 80 && gold.spawnSeparation === 200, 'gold 80/200 lock');
assert(gold.spawnFormation === 'cross' && gold.spawnFacing === 'tangent', 'gold cross tangent');
assert(gold.batchN === 3 && gold.spawnMix === false, 'gold n=3 no mix');

const nomix = Batch.parseSearch('?brains=test_01&spawnMix=0');
assert(nomix.spawnFormation === 'cross', 'mix-off still cross');
assert(nomix.spawnFacing === 'tangent', 'mix-off tangent');
assert(nomix.spawnAltitude === 80 && nomix.spawnSeparation === 100, 'cross mix-off roof default');

const pair = Batch.parseSearch('?brains=test_01&spawnFormation=pair&spawnMix=0');
assert(pair.spawnFormation === 'pair' && pair.spawnAltitude === 45 && pair.spawnFacing === 'face', 'pair mix-off');

const outbound = Batch.parseSearch('?brains=test_01&spawnFacing=outbound');
assert(outbound.spawnFacing === 'outbound', 'facing override');

const seen = {};
for (let i = 1; i <= 16; i++) {
    const sp = Batch.pickSpawnLayout('sess', i);
    seen[sp.altitude + 'x' + sp.separation] = true;
}
const seenCross = {};
for (let i = 1; i <= 6; i++) {
    const sp = Batch.pickSpawnLayout('sess', i, Batch.SPAWN_ALTS_ROOF, Batch.SPAWN_SEPS_CROSS);
    seenCross[sp.altitude + 'x' + sp.separation] = true;
}
assert(Object.keys(seenCross).length === 6, '6 unique cross roof pairs');
assert(!seenCross['80x60'] && !seenCross['92x60'], 'cross mix has no sep 60');

const cfg = Batch.buildMatchConfigFrom(q);
assert(cfg.mode === '2v2', 'cfg mode');
assert(cfg.spawnAltitude === q.spawnAltitude && cfg.spawnSeparation === q.spawnSeparation, 'cfg spawn');
assert(cfg.spawnFormation === 'cross', 'cfg formation');
assert(cfg.spawnFacing === 'tangent', 'cfg facing');
assert(cfg.challengeId === 'lab', 'lab');
assert(cfg.seats['red-1'].control === 'ai' && cfg.seats['red-1'].aiModel === 'Rei_03', 'red-1');
assert(cfg.seats['blue-2'].aiModel === 'Rei_03', 'blue-2');
assert(cfg.mapId === 'citymap', 'cfg map');

const one = Batch.parseSearch('?brains=test_01&mode=1v1');
const cfg1 = Batch.buildMatchConfigFrom(one);
assert(cfg1.mode === '1v1', '1v1');
assert(cfg1.seats['red-1'].control === 'ai', '1v1 red ai');

console.log('batch-ai-run-smoke: ok');
