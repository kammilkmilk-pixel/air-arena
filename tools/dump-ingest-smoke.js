'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Ingest = require('./dump-ingest.js');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function req(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const r = http.request({
            host: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {}
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (_) { /* raw */ }
                resolve({ status: res.statusCode, json, text });
            });
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

assert(Ingest.safeFilename('../x.json') === 'x.json', 'basename');
assert(Ingest.sanitizeToken('a b/c', 8) === 'abc', 'token');

(async () => {
    const port = 18091;
    const server = await Ingest.start(port, '127.0.0.1');
    const session = 'smoke-ingest';
    const filename = 'ai-debug-roster-T2-test_01-smoke.json';
    const rosterSmoke = {
        schema: 'air-arena-ai-debug-roster-v2',
        turn: 2,
        unitIds: ['red'],
        rosterSummary: [{ id: 'red', isDestroyed: true, deathCause: 'combat' }],
        units: { red: { decisionTrail: [{ pos: { x: 1, y: 2, z: 3 } }] } }
    };
    const post = await req(port, 'POST', '/dump', JSON.stringify({
        filename,
        sessionId: session,
        roster: rosterSmoke
    }));
    assert(post.status === 200 && post.json && post.json.ok, 'post');
    const dest = path.join(Ingest.ROOT, session, filename);
    assert(fs.existsSync(dest), 'wrote');
    const dup = await req(port, 'POST', '/dump', JSON.stringify({
        filename: 'ai-debug-roster-T2-test_01-smoke-dup.json',
        sessionId: session,
        roster: rosterSmoke
    }));
    assert(dup.status === 200 && dup.json && dup.json.duplicate === true, 'duplicate skipped');
    assert(!fs.existsSync(path.join(Ingest.ROOT, session, 'ai-debug-roster-T2-test_01-smoke-dup.json')), 'dup not written');
    const samePlay = {
        ...rosterSmoke,
        batch: { batchIndex: 1, batchN: 3 }
    };
    const slot1 = await req(port, 'POST', '/dump', JSON.stringify({
        filename: 'ai-debug-roster-T2-test_01-smoke-i1.json',
        sessionId: session,
        roster: samePlay
    }));
    assert(slot1.status === 200 && slot1.json && slot1.json.ok, 'batchIndex 1 writes');
    const slot1dup = await req(port, 'POST', '/dump', JSON.stringify({
        filename: 'ai-debug-roster-T2-test_01-smoke-i1-dup.json',
        sessionId: session,
        roster: samePlay
    }));
    assert(slot1dup.json && slot1dup.json.duplicate === true, 'same batchIndex re-POST skipped');
    const slot2Name = 'ai-debug-roster-T2-test_01-smoke-i2.json';
    const slot2 = await req(port, 'POST', '/dump', JSON.stringify({
        filename: slot2Name,
        sessionId: session,
        roster: { ...rosterSmoke, batch: { batchIndex: 2, batchN: 3 } }
    }));
    assert(slot2.status === 200 && slot2.json && !slot2.json.duplicate, 'next batchIndex kept');
    const slot2Path = path.join(Ingest.ROOT, session, slot2Name);
    assert(fs.existsSync(slot2Path), 'batchIndex 2 wrote');
    assert(typeof Ingest.rosterFingerprint === 'function', 'fingerprint export');
    assert(Ingest.rosterFingerprint(samePlay) !== Ingest.rosterFingerprint({
        ...rosterSmoke,
        batch: { batchIndex: 2 }
    }), 'fingerprint includes batchIndex');
    const st = await req(port, 'GET', '/status?session=' + session);
    assert(st.json && st.json.count >= 1, 'status count');
    const blocked = await req(port, 'POST', '/dump', JSON.stringify({ filename: 'nope.json' }));
    assert(blocked.status === 400, 'missing roster');
    fs.unlinkSync(dest);
    try { fs.unlinkSync(path.join(Ingest.ROOT, session, 'ai-debug-roster-T2-test_01-smoke-i1.json')); } catch (_) { /* keep */ }
    try { fs.unlinkSync(slot2Path); } catch (_) { /* keep */ }
    try { fs.rmdirSync(path.join(Ingest.ROOT, session)); } catch (_) { /* keep */ }
    server.close();
    console.log('dump-ingest-smoke: ok');
})().catch((err) => {
    console.error('dump-ingest-smoke FAILED', err);
    process.exit(1);
});
