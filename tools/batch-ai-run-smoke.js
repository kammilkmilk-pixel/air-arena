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
    '?skipSetup=1&lab=1&mode=2v2&arena=dense-urban&map=citymap&brains=test_01&batch=3&alt=80&sep=283&spawnFormation=cross&spawnFacing=tangent&spawnMix=0'
);
assert(gold.spawnAltitude === 80 && gold.spawnSeparation === 283, 'gold 80/283 lock');
assert(gold.spawnFormation === 'cross' && gold.spawnFacing === 'tangent', 'gold cross tangent');
assert(gold.batchN === 3 && gold.spawnMix === false, 'gold n=3 no mix');

const facingMix1 = Batch.parseSearch(
    '?skipSetup=1&lab=1&mode=2v2&brains=test_01&batch=6&batchIndex=1&session=face-mix&alt=80&sep=283&spawnFacing=mix&spawnMix=0'
);
const facingMix2 = Batch.parseSearch(
    '?skipSetup=1&lab=1&mode=2v2&brains=test_01&batch=6&batchIndex=2&session=face-mix&alt=80&sep=283&spawnFacing=mix&spawnMix=0'
);
const facingMix3 = Batch.parseSearch(
    '?skipSetup=1&lab=1&mode=2v2&brains=test_01&batch=6&batchIndex=3&session=face-mix&alt=80&sep=283&spawnFacing=mix&spawnMix=0'
);
assert(facingMix1.facingMix === true, 'facing mix flag');
assert(facingMix1.spawnAltitude === 80 && facingMix1.spawnSeparation === 283, 'facing mix keeps 80/283');
assert(['tangent', 'face', 'outbound'].indexOf(facingMix1.spawnFacing) >= 0, 'mix facing legal');
assert(facingMix1.spawnFacing !== facingMix2.spawnFacing, 'index 1 vs 2 changes facing');
assert(
    facingMix2.spawnFacing !== facingMix3.spawnFacing || facingMix1.spawnFacing !== facingMix3.spawnFacing,
    'n=3 uses more than one facing'
);
assert(Batch.SPAWN_FACINGS_CROSS.length === 3, 'cross facing set');
assert(Batch.pickSpawnFacing('face-mix', 1) === facingMix1.spawnFacing, 'pickSpawnFacing matches parse');
const matchSrc = require('fs').readFileSync(require('path').join(__dirname, 'batch-ai-matches.js'), 'utf8');
assert(/opts\.spawnFacing === 'mix'/.test(matchSrc), 'buildUrl must pass spawnFacing=mix');

const nomix = Batch.parseSearch('?brains=test_01&spawnMix=0');
assert(nomix.spawnFormation === 'cross', 'mix-off still cross');
assert(nomix.spawnFacing === 'tangent', 'mix-off tangent');
assert(nomix.spawnAltitude === 80 && nomix.spawnSeparation === 100, 'cross mix-off roof default');

const pair = Batch.parseSearch('?brains=test_01&spawnFormation=pair&spawnMix=0');
assert(pair.spawnFormation === 'pair' && pair.spawnAltitude === 45 && pair.spawnFacing === 'face', 'pair mix-off');

const outbound = Batch.parseSearch('?brains=test_01&spawnFacing=outbound');
assert(outbound.spawnFacing === 'outbound', 'facing override');

const weapon = Batch.parseSearch(
    '?skipSetup=1&lab=1&mode=1v1&arena=blank&brains=test_01&batch=3&alt=80&sep=140&spawnFormation=pair&spawnFacing=chase&spawnMix=0&maxTurns=60'
);
assert(weapon.mode === '1v1' && weapon.arena === 'blank', 'weapon booth mode/arena');
assert(weapon.spawnFormation === 'pair' && weapon.spawnFacing === 'chase', 'weapon booth chase');
assert(weapon.spawnAltitude === 80 && weapon.spawnSeparation === 140 && weapon.spawnMix === false, 'weapon booth spawn');
assert(weapon.maxTurns === 60, 'weapon booth maxTurns');
const cfgW = Batch.buildMatchConfigFrom(weapon);
assert(cfgW.mode === '1v1' && cfgW.spawnFacing === 'chase', 'weapon cfg chase');
assert(cfgW.seats['red-1'] && cfgW.seats['blue-1'] && !cfgW.seats['red-2'], 'weapon 1v1 seats');

const smSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'core', 'state-machine.js'), 'utf8');
assert(/facing === 'tangent' \|\| facing === 'outbound' \|\| facing === 'chase'/.test(smSrc), 'keepSpawnFacing must keep chase');
assert(Math.abs(Batch.chaseHeadingRad(1)) < 1e-9, 'chase idx1 +Z');
assert(Math.abs(Batch.chaseHeadingRad(2) - Math.PI / 2) < 1e-9, 'chase idx2 +X');
assert(Math.abs(Batch.chaseHeadingRad(3) - Math.PI) < 1e-9, 'chase idx3 -Z');

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
assert(cfg.seats['red-1'].loadout === 'standard', 'gold default loadout standard');
assert(
    JSON.stringify(cfg.seats['red-1'].pylons) === JSON.stringify(['fox1', 'fox2', 'fox2', 'fox1']),
    'standard pylons 2+2'
);

assert(Batch.sanitizeLoadout('fox2-only') === 'fox2-priority', 'fox2-only alias');
assert(Batch.sanitizeLoadout('nope') === 'standard', 'unknown loadout');
assert(
    JSON.stringify(Batch.pylonsForLoadout('fox2-priority')) === JSON.stringify(['fox2', 'fox2', 'fox2', 'fox2']),
    'fox2-priority four IR'
);
assert(
    JSON.stringify(Batch.pylonsForLoadout('standard')) === JSON.stringify(['fox1', 'fox2', 'fox2', 'fox1']),
    'standard mix'
);

const fox2q = Batch.parseSearch(
    '?skipSetup=1&lab=1&mode=2v2&brains=test_01&batch=6&alt=80&sep=283&spawnFacing=tangent&spawnMix=0&loadout=fox2-priority'
);
assert(fox2q.loadout === 'fox2-priority', 'query fox2-priority');
const cfgF2 = Batch.buildMatchConfigFrom(fox2q);
assert(cfgF2.seats['red-1'].loadout === 'fox2-priority', 'fox2 seat loadout');
assert(cfgF2.seats['blue-2'].loadout === 'fox2-priority', 'fox2 all seats');
assert(
    JSON.stringify(cfgF2.seats['red-1'].pylons) === JSON.stringify(['fox2', 'fox2', 'fox2', 'fox2']),
    'fox2 seat pylons'
);
assert(gold.loadout === 'standard', 'gold URL stays standard');
const matchSrc2 = require('fs').readFileSync(require('path').join(__dirname, 'batch-ai-matches.js'), 'utf8');
assert(/--loadout/.test(matchSrc2), 'batch-ai-matches --loadout');
assert(/opts\.loadout !== 'standard'/.test(matchSrc2), 'buildUrl passes non-standard loadout');
const smMatch = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'core', 'state-machine-match.js'), 'utf8');
assert(/pylonsForLoadout/.test(smMatch) || /fox2-priority/.test(smMatch), 'match apply keeps fox2-priority');

const one = Batch.parseSearch('?brains=test_01&mode=1v1');
const cfg1 = Batch.buildMatchConfigFrom(one);
assert(cfg1.mode === '1v1', '1v1');
assert(cfg1.seats['red-1'].control === 'ai', '1v1 red ai');

console.log('batch-ai-run-smoke: ok');
