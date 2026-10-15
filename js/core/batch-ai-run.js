// ============================================================================
// batch-ai-run.js — URL one-shot all-AI match + auto-export roster on game_over
// Query: skipSetup=1&lab=1&mode=2v2&arena=dense-urban&map=citymap&brains=test_01
//        &autoExport=1&ingest=http://127.0.0.1:8091/dump
//        &batch=3&batchIndex=1&session=...&batchFast=1
// Does not replace in-game decide(); only boots the real browser match.
// ============================================================================
(function initAirArenaBatchRun(root) {
    const KNOWN = Object.freeze(['test_01', 'Rei_03', 'Rei_02', 'Rei_01']);
    const ARENAS = Object.freeze([
        'blank', 'visual-only', 'sparse-urban', 'medium-urban',
        'dense-urban', 'buildings', 'obstacle-stress'
    ]);
    const SPAWN_ALTS = Object.freeze([28, 45, 60, 80]);
    const SPAWN_ALTS_ROOF = Object.freeze([80, 92]);
    const SPAWN_ALTS_ALL = Object.freeze([28, 45, 60, 80, 92]);
    const SPAWN_SEPS = Object.freeze([60, 100, 140, 200, 283]);
    const SPAWN_SEPS_CROSS = Object.freeze([100, 140, 200]);
    const SPAWN_FACINGS_CROSS = Object.freeze(['tangent', 'face', 'outbound']);

    function parseSearch(search) {
        const q = new URLSearchParams(typeof search === 'string' ? search : '');
        const flag = (key) => {
            const v = q.get(key);
            return v === '1' || v === 'true';
        };
        const brains = sanitizeBrain(q.get('brains') || q.get('brain'));
        const batchN = clampInt(q.get('batch'), 1, 40, 1);
        const batchIndex = clampInt(q.get('batchIndex'), 1, 40, 1);
        const maxTurns = q.get('maxTurns') != null && q.get('maxTurns') !== ''
            ? clampInt(q.get('maxTurns'), 1, 150, 150)
            : null;
        const ingest = sanitizeIngest(q.get('ingest'));
        const session = sanitizeToken(q.get('session'), 80) || '';
        const hasBatchHint = !!(q.get('batch') || q.get('brains') || q.get('brain') || flag('autoExport'));
        const mode = q.get('mode') === '1v1' ? '1v1' : '2v2';
        const spawnFormation = (q.get('spawnFormation') === 'pair' || q.get('formation') === 'pair')
            ? 'pair'
            : ((hasBatchHint && mode === '2v2') ? 'cross' : 'pair');
        const facingRaw = q.get('spawnFacing') || q.get('facing');
        const facingMix = facingRaw === 'mix' || flag('facingMix');
        const spawnFacing = facingMix
            ? pickSpawnFacing(session, batchIndex, SPAWN_FACINGS_CROSS)
            : ((facingRaw === 'face' || facingRaw === 'outbound' || facingRaw === 'tangent' || facingRaw === 'chase')
                ? facingRaw
                : (spawnFormation === 'cross' ? 'tangent' : 'face'));
        const spawnMix = q.has('spawnMix') ? flag('spawnMix') : hasBatchHint;
        const altRaw = q.get('alt') || q.get('spawnAltitude');
        const sepRaw = q.get('sep') || q.get('spawnSeparation');
        const spawnLocked = (altRaw != null && altRaw !== '') || (sepRaw != null && sepRaw !== '') || !spawnMix;
        const mixAlts = spawnFormation === 'cross' ? SPAWN_ALTS_ROOF : SPAWN_ALTS;
        const mixSeps = spawnFormation === 'cross' ? SPAWN_SEPS_CROSS : SPAWN_SEPS;
        const mixed = pickSpawnLayout(session, batchIndex, mixAlts, mixSeps);
        const altFallback = spawnFormation === 'cross' ? 80 : 45;
        const spawnAltitude = spawnLocked
            ? sanitizeSpawnAltitude(altRaw, altFallback)
            : mixed.altitude;
        const spawnSeparation = spawnLocked
            ? sanitizeSpawnSeparation(sepRaw)
            : mixed.separation;
        const fox2AmbushSeed = hashSeed32(`${session || 'batch'}:${batchIndex}:${brains}`);
        const loadout = sanitizeLoadout(q.get('loadout'));
        return {
            skipSetup: flag('skipSetup') || hasBatchHint,
            lab: flag('lab') || hasBatchHint,
            mode,
            arena: sanitizeArena(q.get('arena')),
            mapId: sanitizeToken(q.get('map'), 40) || 'citymap',
            brains,
            autoExport: flag('autoExport') || !!ingest || hasBatchHint,
            ingest,
            batchN,
            batchIndex,
            session,
            batchFast: q.has('batchFast') ? flag('batchFast') : hasBatchHint,
            maxTurns,
            hasBatchHint,
            spawnMix: spawnMix && !spawnLocked,
            spawnAltitude,
            spawnSeparation,
            spawnFormation,
            spawnFacing,
            facingMix,
            fox2AmbushSeed,
            loadout
        };
    }

    const LOADOUTS = Object.freeze(['standard', 'gun-priority', 'fox2-priority', 'fox1-priority']);

    function sanitizeLoadout(raw) {
        const id = String(raw || 'standard').trim().toLowerCase();
        if (id === 'fox2-only' || id === 'fox2only' || id === 'fox2') return 'fox2-priority';
        return LOADOUTS.indexOf(id) >= 0 ? id : 'standard';
    }

    function pylonsForLoadout(loadout) {
        if (loadout === 'gun-priority') return ['empty', 'empty', 'empty', 'empty'];
        if (loadout === 'fox1-priority') return ['fox1', 'fox1', 'fox1', 'fox1'];
        if (loadout === 'fox2-priority') return ['fox2', 'fox2', 'fox2', 'fox2'];
        return ['fox1', 'fox2', 'fox2', 'fox1'];
    }

    function sanitizeBrain(raw) {
        const id = String(raw || 'test_01').trim();
        if (id === 'Rei_00' || id === 'ling_0') return 'Rei_01';
        return KNOWN.indexOf(id) >= 0 ? id : 'test_01';
    }

    function sanitizeArena(raw) {
        const id = String(raw || 'dense-urban').trim();
        if (id === 'buildings') return 'dense-urban';
        return ARENAS.indexOf(id) >= 0 ? id : 'dense-urban';
    }

    function sanitizeToken(raw, max) {
        const s = String(raw || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, max || 64);
        return s;
    }

    function sanitizeIngest(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        try {
            const u = new URL(s);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return '';
            return u.toString();
        } catch (_) {
            return '';
        }
    }

    function clampInt(raw, min, max, fallback) {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function sanitizeSpawnAltitude(raw, fallback) {
        const n = Math.round(Number(raw));
        if (SPAWN_ALTS_ALL.indexOf(n) >= 0) return n;
        return fallback != null ? fallback : 45;
    }

    function sanitizeSpawnSeparation(raw) {
        const n = Math.round(Number(raw));
        return SPAWN_SEPS.indexOf(n) >= 0 ? n : 100;
    }

    function hashSeed32(key) {
        const s = String(key || '');
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    /** Cycle tangent / face / outbound by session + match index. Not chase (lab 1v1). */
    function pickSpawnFacing(session, batchIndex, facings) {
        const list = (facings && facings.length) ? facings : SPAWN_FACINGS_CROSS;
        const slot = (hashSeed32((session || 'batch') + ':facing') + Math.max(0, (Number(batchIndex) || 1) - 1)) % list.length;
        return list[slot];
    }

    /** Cycle the legal spawn grid by session + match index (not decide() noise). */
    function pickSpawnLayout(session, batchIndex, alts, seps) {
        const altList = (alts && alts.length) ? alts : SPAWN_ALTS;
        const sepList = (seps && seps.length) ? seps : SPAWN_SEPS;
        const n = altList.length * sepList.length;
        const slot = (hashSeed32(session || 'batch') + Math.max(0, (Number(batchIndex) || 1) - 1)) % n;
        return {
            altitude: altList[slot % altList.length],
            separation: sepList[Math.floor(slot / altList.length) % sepList.length]
        };
    }

    function readQuery() {
        try {
            return parseSearch(typeof location !== 'undefined' ? location.search : '');
        } catch (_) {
            return parseSearch('');
        }
    }

    let cached = null;
    function opts() {
        if (!cached) cached = readQuery();
        return cached;
    }

    function isActive() {
        const o = opts();
        return !!(o.skipSetup && o.hasBatchHint);
    }

    function skipFirstDelay() {
        return isActive();
    }

    function skipVoiceWait() {
        return isActive();
    }

    function animStep() {
        if (!isActive()) return 0.012;
        return opts().batchFast ? 0.25 : 0.012;
    }

    function buildMatchConfigFrom(o) {
        o = o || opts();
        const mode = o.mode || '2v2';
        const brains = o.brains || 'test_01';
        const cfg = (typeof GameContext !== 'undefined' && GameContext.createDefaultMatchConfig)
            ? GameContext.createDefaultMatchConfig(mode)
            : {
                mode,
                spawnAltitude: 45,
                spawnSeparation: 100,
                playerFaction: 'red',
                challengeId: 'lab',
                mapId: o.mapId,
                seats: {}
            };
        cfg.challengeId = 'lab';
        cfg.mapId = o.mapId;
        cfg.spawnAltitude = o.spawnAltitude != null ? o.spawnAltitude : 45;
        cfg.spawnSeparation = o.spawnSeparation != null ? o.spawnSeparation : 100;
        cfg.spawnFormation = o.spawnFormation === 'cross' ? 'cross' : 'pair';
        cfg.spawnFacing = (o.spawnFacing === 'face' || o.spawnFacing === 'outbound' || o.spawnFacing === 'tangent' || o.spawnFacing === 'chase')
            ? o.spawnFacing
            : (cfg.spawnFormation === 'cross' ? 'tangent' : 'face');
        const seatIds = mode === '2v2'
            ? ['red-1', 'red-2', 'blue-1', 'blue-2']
            : ['red-1', 'blue-1'];
        const loadout = o.loadout || 'standard';
        const pylons = pylonsForLoadout(loadout);
        seatIds.forEach((seatId) => {
            const prev = cfg.seats[seatId] || {};
            cfg.seats[seatId] = Object.assign({}, prev, {
                control: 'ai',
                aiModel: brains,
                loadout,
                pylons: pylons.slice()
            });
        });
        return cfg;
    }

    function buildMatchConfig() {
        return buildMatchConfigFrom(opts());
    }

    function applyArena() {
        const o = opts();
        if (typeof GameContext !== 'undefined' && GameContext.setArenaMode) {
            GameContext.setArenaMode(o.arena);
        }
        if (o.maxTurns != null && typeof CONFIG !== 'undefined' && CONFIG.rules) {
            CONFIG.rules.maxEngagementTurns = o.maxTurns;
        }
        if (o.fox2AmbushSeed != null && typeof CONFIG !== 'undefined' && CONFIG.doctrine) {
            CONFIG.doctrine.fox2OpeningAmbushSeed = o.fox2AmbushSeed;
        }
    }

    /** Lab chase: rotate the pursuit line by batchIndex so n=3 dumps are not identical. */
    function chaseHeadingRad(batchIndex) {
        const slot = (Math.max(1, Number(batchIndex) || 1) - 1) % 4;
        return slot * Math.PI / 2;
    }

    function stampName() {
        return new Date().toISOString().replace(/[:.]/g, '-');
    }

    function buildFilename(roster) {
        const o = opts();
        const turn = (roster && roster.turn) || 0;
        const brains = sanitizeToken(o.brains, 16) || 'ai';
        return `ai-debug-roster-T${turn}-${brains}-${stampName()}.json`;
    }

    function decorateRoster(roster) {
        const o = opts();
        const next = roster || {};
        next.batch = {
            brains: o.brains,
            mode: o.mode,
            arena: o.arena,
            mapId: o.mapId,
            batchIndex: o.batchIndex,
            batchN: o.batchN,
            session: o.session || null,
            maxTurns: o.maxTurns,
            spawnMix: !!o.spawnMix,
            spawnAltitude: o.spawnAltitude,
            spawnSeparation: o.spawnSeparation,
            spawnFormation: o.spawnFormation || 'pair',
            spawnFacing: o.spawnFacing || 'face',
            facingMix: !!o.facingMix,
            fox2AmbushSeed: o.fox2AmbushSeed,
            chaseYawDeg: Math.round(chaseHeadingRad(o.batchIndex) * 180 / Math.PI),
            loadout: o.loadout || 'standard'
        };
        return next;
    }

    let exported = false;

    function nextUrl() {
        const o = opts();
        if (o.batchIndex >= o.batchN) return null;
        const u = new URL(location.href);
        u.searchParams.set('batchIndex', String(o.batchIndex + 1));
        if (!u.searchParams.get('skipSetup')) u.searchParams.set('skipSetup', '1');
        return u.toString();
    }

    function postDump(filename, roster) {
        const o = opts();
        if (!o.ingest) return Promise.resolve({ ok: false, skipped: true });
        return fetch(o.ingest, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename,
                sessionId: o.session,
                roster
            })
        }).then((res) => {
            if (!res.ok) throw new Error('ingest HTTP ' + res.status);
            return res.json().catch(() => ({ ok: true }));
        });
    }

    function exportRoster() {
        if (exported) return Promise.resolve(false);
        exported = true;
        let roster = null;
        try {
            if (window.AirArenaAIDebug && typeof window.AirArenaAIDebug.buildRoster === 'function') {
                roster = decorateRoster(window.AirArenaAIDebug.buildRoster());
            }
        } catch (err) {
            console.error('[batch-ai] buildRoster failed', err);
        }
        if (!roster || !roster.unitIds || !roster.unitIds.length) {
            exported = false;
            return Promise.resolve(false);
        }
        const filename = buildFilename(roster);
        const o = opts();
        const goNext = () => {
            const href = nextUrl();
            if (href) location.replace(href);
        };
        if (o.ingest) {
            return postDump(filename, roster)
                .then(() => {
                    if (typeof showSMSAlert === 'function') {
                        showSMSAlert(`BATCH ${o.batchIndex}/${o.batchN} 已寫入 dump`, '#00ff88');
                    }
                    goNext();
                    return true;
                })
                .catch((err) => {
                    console.error('[batch-ai] ingest failed', err);
                    exported = false;
                    if (typeof showSMSAlert === 'function') {
                        showSMSAlert('BATCH dump 寫入失敗（可重試）', '#ff5555');
                    }
                    return false;
                });
        }
        if (typeof window.uiExportAllAIDebug === 'function') {
            return Promise.resolve(window.uiExportAllAIDebug()).then((ok) => {
                goNext();
                return !!ok;
            });
        }
        goNext();
        return Promise.resolve(true);
    }

    function onPhase(e) {
        const phase = e && e.detail ? e.detail.phase : null;
        if (phase !== 'game_over') return;
        if (!isActive() || !opts().autoExport) return;
        exportRoster();
    }

    function init() {
        if (typeof window === 'undefined') return;
        if (!isActive()) return;
        window.addEventListener('EnginePhaseChanged', onPhase);
    }

    const api = {
        KNOWN,
        SPAWN_ALTS,
        SPAWN_ALTS_ROOF,
        SPAWN_ALTS_ALL,
        SPAWN_SEPS,
        SPAWN_SEPS_CROSS,
        SPAWN_FACINGS_CROSS,
        parseSearch,
        sanitizeBrain,
        sanitizeArena,
        pickSpawnLayout,
        sanitizeLoadout,
        pylonsForLoadout,
        pickSpawnFacing,
        isActive,
        skipFirstDelay,
        skipVoiceWait,
        animStep,
        buildMatchConfig,
        buildMatchConfigFrom,
        applyArena,
        exportRoster,
        chaseHeadingRad,
        readQuery: opts,
        init
    };

    root.AirArenaBatchRun = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
