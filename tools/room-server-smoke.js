'use strict';
/**
 * Smoke: room create/join, relay turn-intent + turn-log, queue match, reconnect token.
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 18081;
const Proto = require('../js/core/netplay-protocol.js');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

function wsConnect(url) {
    const WebSocket = require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const inbox = [];
        ws.on('open', () => resolve({ ws, inbox }));
        ws.on('error', reject);
        ws.on('message', (raw) => {
            try { inbox.push(JSON.parse(String(raw))); } catch (_) { /* ignore */ }
        });
    });
}

function waitMsg(inbox, type, ms = 3000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            const hit = inbox.find((m) => m.type === type);
            if (hit) return resolve(hit);
            if (Date.now() - start > ms) return reject(new Error(`timeout waiting ${type}`));
            setTimeout(tick, 20);
        };
        tick();
    });
}

async function main() {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'room-server.js')], {
        env: Object.assign({}, process.env, { ROOM_PORT: String(PORT) }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let boot = '';
    child.stdout.on('data', (d) => { boot += String(d); });
    child.stderr.on('data', (d) => { boot += String(d); });

    try {
        for (let i = 0; i < 50; i++) {
            try {
                await new Promise((resolve, reject) => {
                    http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
                        let body = '';
                        res.on('data', (c) => { body += c; });
                        res.on('end', () => {
                            const j = JSON.parse(body);
                            assert(j.ok && j.protocol === Proto.PROTOCOL, 'health');
                            resolve();
                        });
                    }).on('error', reject);
                });
                break;
            } catch (e) {
                if (i === 49) throw e;
                await sleep(100);
            }
        }

        const host = await wsConnect(`ws://127.0.0.1:${PORT}`);
        host.ws.send(JSON.stringify(Proto.envelope(Proto.MSG.HELLO, {
            action: 'create',
            room: 'SMK001',
            role: 'host',
            seatId: 'red',
            clientVersion: Proto.CLIENT_VERSION
        })));
        const welcome = await waitMsg(host.inbox, Proto.MSG.WELCOME);
        assert(welcome.payload.room === 'SMK001', 'preferred room code');
        assert(welcome.payload.reconnectToken, 'host reconnect token');

        const guest = await wsConnect(`ws://127.0.0.1:${PORT}`);
        guest.ws.send(JSON.stringify(Proto.envelope(Proto.MSG.HELLO, {
            action: 'join',
            room: 'SMK001',
            role: 'guest',
            seatId: 'blue',
            clientVersion: Proto.CLIENT_VERSION
        })));
        await waitMsg(guest.inbox, Proto.MSG.WELCOME);
        await waitMsg(host.inbox, Proto.MSG.PEER_STATUS);

        const intent = Proto.buildTurnIntent('blue', { joyX: 0.5, throttle: 3 }, 1);
        guest.ws.send(JSON.stringify(Proto.envelope(Proto.MSG.TURN_INTENT, intent, { room: 'SMK001' })));
        const gotIntent = await waitMsg(host.inbox, Proto.MSG.TURN_INTENT);
        assert(gotIntent.payload.joyX === 0.5, 'intent relay');

        host.ws.send(JSON.stringify(Proto.envelope(Proto.MSG.TURN_LOG, { turn: 1, protocol: Proto.PROTOCOL }, { room: 'SMK001' })));
        const gotLog = await waitMsg(guest.inbox, Proto.MSG.TURN_LOG);
        assert(gotLog.payload.turn === 1, 'turn-log relay');

        // Queue match
        const q1 = await wsConnect(`ws://127.0.0.1:${PORT}`);
        const q2 = await wsConnect(`ws://127.0.0.1:${PORT}`);
        q1.ws.send(JSON.stringify(Proto.envelope(Proto.MSG.HELLO, { action: 'queue', mode: '1v1' })));
        q2.ws.send(JSON.stringify(Proto.envelope(Proto.MSG.HELLO, { action: 'queue', mode: '1v1' })));
        await waitMsg(q1.inbox, Proto.MSG.QUEUE_MATCHED, 4000);
        await waitMsg(q2.inbox, Proto.MSG.QUEUE_MATCHED, 4000);

        console.log('room-server-smoke: ok');
    } finally {
        try { child.kill(); } catch (_) { /* ignore */ }
    }
}

main().catch((err) => {
    console.error('room-server-smoke FAIL', err);
    process.exit(1);
});
