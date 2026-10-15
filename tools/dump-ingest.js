#!/usr/bin/env node
'use strict';
/**
 * Local roster ingest for browser batch runs.
 * POST /dump  { filename, sessionId, roster }
 * GET  /health
 * GET  /status?session=
 * Bind: 127.0.0.1:8091 (DUMP_INGEST_PORT)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.DUMP_INGEST_HOST || '127.0.0.1';
const PORT = Number(process.env.DUMP_INGEST_PORT || 8091);
const ROOT = path.join(__dirname, 'reports', 'dumps');
const MAX_BYTES = 20 * 1024 * 1024;

function sanitizeToken(raw, max) {
    return String(raw || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, max || 80);
}

function safeFilename(raw) {
    const base = path.basename(String(raw || ''));
    const cleaned = sanitizeToken(base.replace(/\.json$/i, ''), 120);
    return (cleaned || 'ai-debug-roster') + '.json';
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function sessionDir(sessionId) {
    const sid = sanitizeToken(sessionId, 80) || 'anon';
    return path.join(ROOT, sid);
}

function listJson(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.json'))
        .map((n) => path.join(dir, n));
}

function roundPos(p) {
    if (!p) return '';
    if (Array.isArray(p)) return p.map((n) => Math.round(Number(n))).join(',');
    if (typeof p === 'object') {
        return [p.x, p.y, p.z].map((n) => Math.round(Number(n))).join(',');
    }
    return String(p);
}

function unitTrailPos(u) {
    if (!u) return '';
    const t = (u.decisionTrail && u.decisionTrail[0]) || (u.deathTrail && u.deathTrail[0]);
    return roundPos(t && t.pos);
}

/** Gameplay fingerprint. Same-session re-POST skip; different batchIndex is a new slot. */
function rosterFingerprint(roster) {
    if (!roster || typeof roster !== 'object') return '';
    const units = roster.units || {};
    const summary = roster.rosterSummary || [];
    const causeOf = {};
    for (let i = 0; i < summary.length; i++) {
        const r = summary[i];
        if (r && r.id) causeOf[r.id] = String(r.deathCause || '');
    }
    const ids = Object.keys(units).sort();
    const parts = ids.map((id) => {
        const u = units[id];
        return id + '@' + unitTrailPos(u) + ':' + (causeOf[id] || '') + ':T' + String(roster.turn || '');
    });
    const batch = roster.batch && typeof roster.batch === 'object' ? roster.batch : null;
    const idx = batch ? Number(batch.batchIndex) : NaN;
    const slot = Number.isFinite(idx) && idx > 0 ? 'i' + idx : 'i0';
    return slot + '|' + parts.join('|');
}

function sessionFingerprints(dir) {
    const seen = {};
    listJson(dir).forEach((file) => {
        try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            const fp = rosterFingerprint(j);
            if (fp) seen[fp] = path.basename(file);
        } catch (_) { /* skip unreadable */ }
    });
    return seen;
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, code, obj) {
    cors(res);
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

function handlePostDump(req, res, body) {
    let payload;
    try {
        payload = JSON.parse(body || '{}');
    } catch (err) {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
        return;
    }
    if (!payload || typeof payload !== 'object' || !payload.roster) {
        sendJson(res, 400, { ok: false, error: 'missing roster' });
        return;
    }
    const sid = sanitizeToken(payload.sessionId, 80) || 'anon';
    const dir = sessionDir(sid);
    ensureDir(dir);
    const filename = safeFilename(payload.filename);
    const dest = path.join(dir, filename);
    const fp = rosterFingerprint(payload.roster);
    const seen = sessionFingerprints(dir);
    if (fp && seen[fp]) {
        const files = listJson(dir);
        console.log('[dump-ingest]', sid, 'duplicate skip', filename, 'same as', seen[fp], 'n=' + files.length);
        sendJson(res, 200, {
            ok: true,
            duplicate: true,
            sessionId: sid,
            filename,
            count: files.length
        });
        return;
    }
    fs.writeFileSync(dest, JSON.stringify(payload.roster, null, 2), 'utf8');
    const files = listJson(dir);
    console.log('[dump-ingest]', sid, filename, 'n=' + files.length);
    sendJson(res, 200, { ok: true, sessionId: sid, filename, path: dest, count: files.length });
}

function handle(req, res) {
    cors(res);
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        sendJson(res, 200, { ok: true, host: HOST, port: PORT, root: ROOT, dedup: true });
        return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
        const sid = sanitizeToken(url.searchParams.get('session'), 80);
        const dir = sid ? sessionDir(sid) : ROOT;
        const files = sid ? listJson(dir) : [];
        sendJson(res, 200, {
            ok: true,
            sessionId: sid || null,
            count: files.length,
            files: files.map((f) => path.basename(f))
        });
        return;
    }
    if (req.method === 'POST' && (url.pathname === '/dump' || url.pathname === '/')) {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BYTES) {
                req.destroy();
                sendJson(res, 413, { ok: false, error: 'too large' });
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            handlePostDump(req, res, Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', () => {
            sendJson(res, 400, { ok: false, error: 'read failed' });
        });
        return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
}

function start(port, host) {
    const p = port != null ? port : PORT;
    const h = host || HOST;
    ensureDir(ROOT);
    const server = http.createServer(handle);
    return new Promise((resolve, reject) => {
        server.listen(p, h, () => {
            console.log('[dump-ingest] http://' + h + ':' + p + '/  →  ' + ROOT);
            resolve(server);
        });
        server.on('error', reject);
    });
}

module.exports = {
    handle,
    start,
    sanitizeToken,
    safeFilename,
    sessionDir,
    rosterFingerprint,
    ROOT,
    PORT,
    HOST
};

if (require.main === module) {
    start().catch((err) => {
        console.error('[dump-ingest] failed', err);
        process.exit(1);
    });
}
