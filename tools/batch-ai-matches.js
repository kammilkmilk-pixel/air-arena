#!/usr/bin/env node
'use strict';
/**
 * Drive real-browser dumps (not tools/ai-regression.js).
 *
 *   node tools/batch-ai-matches.js --brains test_01 --n 3
 *   node tools/batch-ai-gold.js --brains test_01
 *   node tools/batch-ai-weapon.js --brains test_01
 *   node tools/batch-ai-matches.js --smoke
 *   node tools/batch-ai-matches.js --brains test_01 --n 6 --session b2-test_01-<id>   (same-spawn A/B)
 *
 * Leaves the game window open. Each match reloads after game_over POST.
 */
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const INGEST = require('./dump-ingest.js');
const Batch = require('../js/core/batch-ai-run.js');

function parseArgs(argv) {
    const out = {
        brains: 'test_01',
        n: 1,
        mode: '2v2',
        arena: 'dense-urban',
        map: 'citymap',
        port: 8080,
        ingestPort: Number(process.env.DUMP_INGEST_PORT || 8091),
        timeoutSec: 720,
        ab: false,
        smoke: false,
        open: true,
        spawnMix: true,
        alt: null,
        sep: null,
        spawnFormation: 'cross',
        spawnFacing: 'tangent',
        maxTurns: null,
        loadout: 'standard',
        session: null
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = argv[i + 1];
        if (a === '--brains' || a === '--brain') { out.brains = next; i++; }
        else if (a === '--n' || a === '--count') { out.n = Math.max(1, parseInt(next, 10) || 1); i++; }
        else if (a === '--mode') { out.mode = next === '1v1' ? '1v1' : '2v2'; i++; }
        else if (a === '--arena') { out.arena = next; i++; }
        else if (a === '--map') { out.map = next; i++; }
        else if (a === '--port') { out.port = parseInt(next, 10) || 8080; i++; }
        else if (a === '--ingest-port') { out.ingestPort = parseInt(next, 10) || 8091; i++; }
        else if (a === '--timeout') { out.timeoutSec = Math.max(30, parseInt(next, 10) || 720); i++; }
        else if (a === '--max-turns' || a === '--maxTurns') {
            const n = parseInt(next, 10);
            out.maxTurns = Number.isFinite(n) ? Math.max(1, Math.min(150, n)) : null;
            i++;
        }
        else if (a === '--ab') out.ab = true;
        else if (a === '--smoke') {
            out.smoke = true;
            out.n = 1;
            out.timeoutSec = 180;
        }
        else if (a === '--no-open') out.open = false;
        else if (a === '--no-spawn-mix') out.spawnMix = false;
        else if (a === '--alt') { out.alt = parseInt(next, 10); i++; }
        else if (a === '--sep') { out.sep = parseInt(next, 10); i++; }
        else if (a === '--spawn-formation' || a === '--formation') { out.spawnFormation = next === 'pair' ? 'pair' : 'cross'; i++; }
        else if (a === '--spawn-facing' || a === '--facing') {
            out.spawnFacing = (next === 'face' || next === 'outbound' || next === 'chase' || next === 'mix')
                ? next
                : 'tangent';
            i++;
        }
        else if (a === '--loadout') {
            out.loadout = Batch.sanitizeLoadout ? Batch.sanitizeLoadout(next) : String(next || 'standard');
            i++;
        }
        else if (a === '--session') {
            out.session = String(next || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || null;
            i++;
        }
    }
    return out;
}

function fetchJson(url, opts) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, Object.assign({ method: 'GET' }, opts || {}), (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 400) {
                    reject(new Error(url + ' HTTP ' + res.statusCode));
                    return;
                }
                try { resolve(JSON.parse(text)); }
                catch (_) { resolve({ ok: true, raw: text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(4000, () => {
            req.destroy();
            reject(new Error('timeout ' + url));
        });
        if (opts && opts.body) req.write(opts.body);
        req.end();
    });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitHttpOk(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fetchJson(url);
            return true;
        } catch (_) {
            await sleep(400);
        }
    }
    return false;
}

function startServe(port) {
    const bin = path.join(ROOT, 'node_modules', 'serve', 'build', 'main.js');
    if (!fs.existsSync(bin)) throw new Error('serve missing — run npm install');
    const child = spawn(process.execPath, [bin, '-l', String(port)], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
    return child;
}

async function ensureGameServer(port) {
    try {
        await fetchJson(`http://127.0.0.1:${port}/`);
        console.log('[batch-ai] game server already on :' + port);
        return { owned: false };
    } catch (_) { /* start */ }
    console.log('[batch-ai] starting game server on :' + port);
    startServe(port);
    const ok = await waitHttpOk(`http://127.0.0.1:${port}/`, 20000);
    if (ok) return { owned: true };
    const ps1 = path.join(ROOT, 'tools', 'ensure-dev-server.ps1');
    const r = spawnSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1
    ], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('could not start game server on :' + port);
    return { owned: false };
}

async function ensureIngest(port) {
    const health = `http://127.0.0.1:${port}/health`;
    try {
        const h = await fetchJson(health);
        console.log('[batch-ai] ingest already on :' + port);
        if (!h || h.dedup !== true) {
            console.warn('[batch-ai] ingest is old (no dump dedup). Stop the process on :' + port + ' and rerun so tools/dump-ingest.js restarts.');
        }
        return { child: null };
    } catch (_) { /* start */ }
    console.log('[batch-ai] starting dump ingest on :' + port);
    const child = spawn(process.execPath, [path.join(__dirname, 'dump-ingest.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { DUMP_INGEST_PORT: String(port) }),
        stdio: 'inherit'
    });
    const ok = await waitHttpOk(health, 12000);
    if (!ok) {
        try { child.kill(); } catch (_) { /* ignore */ }
        throw new Error('dump-ingest did not start');
    }
    return { child };
}

function findWindowsBrowser() {
    const names = [
        ['PROGRAMFILES', 'Google\\Chrome\\Application\\chrome.exe'],
        ['PROGRAMFILES(X86)', 'Google\\Chrome\\Application\\chrome.exe'],
        ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
        ['PROGRAMFILES', 'Microsoft\\Edge\\Application\\msedge.exe'],
        ['PROGRAMFILES(X86)', 'Microsoft\\Edge\\Application\\msedge.exe']
    ];
    for (let i = 0; i < names.length; i++) {
        const root = process.env[names[i][0]];
        if (!root) continue;
        const exe = path.join(root, names[i][1]);
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}

function chromeBatchProfile(session) {
    const sid = String(session || 'anon').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || 'anon';
    const dir = path.join(ROOT, 'tools', 'reports', '.chrome-batch', sid);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function openBrowser(url, session) {
    const profile = chromeBatchProfile(session);
    const chromeArgs = [
        '--user-data-dir=' + profile,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--new-window',
        url
    ];
    if (process.platform === 'win32') {
        const exe = findWindowsBrowser();
        if (exe) {
            console.log('[batch-ai] isolated browser profile', profile);
            spawn(exe, chromeArgs, { detached: true, stdio: 'ignore' }).unref();
            return;
        }
        spawn('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-Command', `Start-Process -FilePath '${String(url).replace(/'/g, "''")}'`
        ], { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    if (process.platform === 'darwin') {
        spawn('open', ['-na', 'Google Chrome', '--args'].concat(chromeArgs), {
            detached: true,
            stdio: 'ignore'
        }).unref();
        return;
    }
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function buildUrl(opts, brains, session) {
    const q = new URLSearchParams({
        skipSetup: '1',
        lab: '1',
        mode: opts.mode,
        arena: opts.arena,
        map: opts.map,
        brains,
        autoExport: '1',
        ingest: `http://127.0.0.1:${opts.ingestPort}/dump`,
        batch: String(opts.n),
        batchIndex: '1',
        session,
        batchFast: '1'
    });
    if (opts.smoke) q.set('maxTurns', '2');
    else if (opts.maxTurns != null && Number.isFinite(opts.maxTurns)) q.set('maxTurns', String(opts.maxTurns));
    if (!opts.spawnMix) q.set('spawnMix', '0');
    if (opts.alt != null && Number.isFinite(opts.alt)) q.set('alt', String(opts.alt));
    if (opts.sep != null && Number.isFinite(opts.sep)) q.set('sep', String(opts.sep));
    q.set('spawnFormation', opts.spawnFormation === 'pair' ? 'pair' : 'cross');
    if (opts.spawnFacing === 'face' || opts.spawnFacing === 'outbound' || opts.spawnFacing === 'chase' || opts.spawnFacing === 'mix') {
        q.set('spawnFacing', opts.spawnFacing);
    } else {
        q.set('spawnFacing', 'tangent');
    }
    if (opts.loadout && opts.loadout !== 'standard') q.set('loadout', opts.loadout);
    return `http://127.0.0.1:${opts.port}/?${q.toString()}`;
}

async function waitForDumps(ingestPort, session, n, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    let last = 0;
    while (Date.now() < deadline) {
        try {
            const st = await fetchJson(`http://127.0.0.1:${ingestPort}/status?session=${encodeURIComponent(session)}`);
            const count = Number(st.count || 0);
            if (count !== last) {
                last = count;
                console.log(`[batch-ai] received ${count}/${n}`);
            }
            if (count >= n) return st;
        } catch (_) { /* ingest blip */ }
        await sleep(2000);
    }
    throw new Error(`timeout waiting for ${n} dumps (session ${session})`);
}

function scoreFiles(label, files) {
    if (!files.length) {
        console.log('[batch-ai] no files to score for', label);
        return;
    }
    const args = [path.join(__dirname, 'weapon-efficiency-dump.js'), '--group', label].concat(files);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) console.warn('[batch-ai] scorer exit', r.status);
}

async function runSeries(opts, brains) {
    // A reused session replays the same spawn/facing/seed cycle (same-spawn A/B).
    const session = opts.session && !opts.ab
        ? opts.session
        : `b2-${brains.replace(/[^A-Za-z0-9._-]/g, '')}-${Date.now()}`;
    if (opts.session && !opts.ab) {
        const prior = path.join(INGEST.ROOT, session);
        const left = fs.existsSync(prior) ? fs.readdirSync(prior).filter((f) => f.endsWith('.json')) : [];
        // Ingest dedups and counts by this folder, so old dumps would satisfy the wait.
        if (left.length) throw new Error(`session ${session} already has ${left.length} dumps; move them aside first`);
    }
    const url = buildUrl(opts, brains, session);
    console.log('\n[batch-ai] =====', brains, 'n=' + opts.n, opts.smoke ? '(smoke T2)' : (opts.maxTurns != null ? '(T' + opts.maxTurns + ')' : '(T150)'));
    console.log('[batch-ai] session', session);
    console.log('[batch-ai] loadout', opts.loadout === 'fox2-priority' ? 'fox2-priority (4×IR)' : (opts.loadout || 'standard'));
    console.log('[batch-ai] formation', opts.spawnFormation === 'pair' ? 'pair' : 'cross');
    console.log(
        '[batch-ai] facing',
        opts.spawnFacing === 'mix'
            ? 'mix (tangent/face/outbound)'
            : ((opts.spawnFacing === 'face' || opts.spawnFacing === 'outbound' || opts.spawnFacing === 'chase')
                ? opts.spawnFacing
                : 'tangent')
    );
    if (opts.spawnFacing === 'mix') {
        for (let i = 1; i <= opts.n; i++) {
            console.log(`[batch-ai] match ${i}/${opts.n} facing=${Batch.pickSpawnFacing(session, i)}`);
        }
    }
    if (opts.spawnMix && opts.alt == null && opts.sep == null) {
        const mixAlts = opts.spawnFormation === 'pair' ? Batch.SPAWN_ALTS : Batch.SPAWN_ALTS_ROOF;
        const mixSeps = opts.spawnFormation === 'pair' ? Batch.SPAWN_SEPS : Batch.SPAWN_SEPS_CROSS;
        for (let i = 1; i <= opts.n; i++) {
            const sp = Batch.pickSpawnLayout(session, i, mixAlts, mixSeps);
            console.log(`[batch-ai] match ${i}/${opts.n} spawn alt=${sp.altitude} sep=${sp.separation}`);
        }
    } else {
        const defAlt = opts.spawnFormation === 'cross' ? 80 : 45;
        console.log('[batch-ai] spawn locked', 'alt=' + (opts.alt != null ? opts.alt : defAlt), 'sep=' + (opts.sep != null ? opts.sep : 100));
    }
    console.log('[batch-ai] open', url);
    if (opts.open) openBrowser(url, session);
    else console.log('[batch-ai] --no-open: paste the URL yourself');
    const perMatch = opts.smoke ? opts.timeoutSec : opts.timeoutSec;
    const st = await waitForDumps(opts.ingestPort, session, opts.n, perMatch * opts.n);
    const dir = path.join(INGEST.ROOT, session);
    const files = (st.files || []).map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
    scoreFiles(brains, files);
    return { session, files };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await ensureGameServer(opts.port);
    const ingest = await ensureIngest(opts.ingestPort);
    const cleanup = () => {
        if (ingest.child) {
            try { ingest.child.kill(); } catch (_) { /* ignore */ }
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
        cleanup();
        process.exit(130);
    });

    const brainsList = opts.ab ? ['test_01', 'Rei_03'] : [opts.brains];
    const all = [];
    for (const brains of brainsList) {
        const r = await runSeries(opts, brains);
        all.push(r);
    }
    console.log('\n[batch-ai] done');
    all.forEach((r) => {
        console.log('  ', r.session, r.files.length, 'files');
        r.files.forEach((f) => console.log('    ', f));
    });
    cleanup();
}

main().catch((err) => {
    console.error('[batch-ai] FAILED', err && err.message ? err.message : err);
    process.exit(1);
});
