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
    const post = await req(port, 'POST', '/dump', JSON.stringify({
        filename,
        sessionId: session,
        roster: { schema: 'air-arena-ai-debug-roster-v2', turn: 2, unitIds: ['red'] }
    }));
    assert(post.status === 200 && post.json && post.json.ok, 'post');
    const dest = path.join(Ingest.ROOT, session, filename);
    assert(fs.existsSync(dest), 'wrote');
    const st = await req(port, 'GET', '/status?session=' + session);
    assert(st.json && st.json.count >= 1, 'status count');
    const blocked = await req(port, 'POST', '/dump', JSON.stringify({ filename: 'nope.json' }));
    assert(blocked.status === 400, 'missing roster');
    fs.unlinkSync(dest);
    try { fs.rmdirSync(path.join(Ingest.ROOT, session)); } catch (_) { /* keep */ }
    server.close();
    console.log('dump-ingest-smoke: ok');
})().catch((err) => {
    console.error('dump-ingest-smoke FAILED', err);
    process.exit(1);
});
