#!/usr/bin/env node
'use strict';
/**
 * Air Arena WEGO room relay + invite codes + public queue.
 * Usage: node tools/room-server.js
 * Env: ROOM_PORT=8081
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const Proto = require(path.join(__dirname, '..', 'js', 'core', 'netplay-protocol.js'));

const PORT = Number(process.env.ROOM_PORT || 8081);
const PROTOCOL = Proto.PROTOCOL;
const ROOM_TTL_MS = Proto.ROOM_TTL_MS || 45 * 60 * 1000;
const RECONNECT_TTL_MS = Proto.RECONNECT_TTL_MS || 120000;

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {{ ws: import('ws').WebSocket, mode: string, joinedAt: number }[]} */
const queue = [];

/**
 * @typedef {object} Seat
 * @property {import('ws').WebSocket|null} ws
 * @property {string} seatToken
 * @property {string} reconnectToken
 * @property {string} role
 * @property {number} lastSeen
 */

/**
 * @typedef {object} Room
 * @property {string} code
 * @property {Seat|null} host
 * @property {Seat|null} guest
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {object|null} lastMatchConfig
 */

function log(...args) {
    console.log('[room-server]', ...args);
}

function makeCode() {
    return Proto.makeInviteCode();
}

function makeToken() {
    return Proto.makeSeatToken();
}

function makeReconnect() {
    return `r_${crypto.randomBytes(12).toString('hex')}`;
}

function send(ws, msg) {
    if (!ws || ws.readyState !== 1) return;
    try {
        ws.send(JSON.stringify(msg));
    } catch (e) {
        /* ignore */
    }
}

function envelope(type, payload, extra) {
    return Proto.envelope(type, payload, extra);
}

function purgeExpired() {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (room.expiresAt < now) {
            rooms.delete(code);
            log('expired', code);
        }
    }
    while (queue.length && now - queue[0].joinedAt > 10 * 60 * 1000) {
        const q = queue.shift();
        send(q.ws, envelope(Proto.MSG.ERROR, { message: '排隊逾時' }));
    }
}

function seatOf(room, role) {
    return role === 'guest' ? room.guest : room.host;
}

function otherSeat(room, role) {
    return role === 'guest' ? room.host : room.guest;
}

function bindWsRoom(ws, roomCode, role) {
    ws._aaRoom = roomCode;
    ws._aaRole = role;
}

function notifyPeer(room, connected, whoRole) {
    const other = otherSeat(room, whoRole);
    if (other && other.ws) {
        send(other.ws, envelope(Proto.MSG.PEER_STATUS, {
            connected: !!connected,
            peerRole: whoRole
        }, { room: room.code }));
    }
}

function welcome(ws, room, role, seatId) {
    const seat = seatOf(room, role);
    send(ws, envelope(Proto.MSG.WELCOME, {
        room: room.code,
        role,
        seatId,
        remoteSeatId: seatId === 'red' ? 'blue' : 'red',
        seatToken: seat && seat.seatToken,
        reconnectToken: seat && seat.reconnectToken,
        message: `房間 ${room.code}`
    }, { room: room.code }));
}

function createRoom(ws, preferredCode) {
    let code = String(preferredCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code) || rooms.has(code)) {
        code = makeCode();
        while (rooms.has(code)) code = makeCode();
    }
    const room = {
        code,
        host: {
            ws,
            seatToken: makeToken(),
            reconnectToken: makeReconnect(),
            role: 'host',
            lastSeen: Date.now()
        },
        guest: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + ROOM_TTL_MS,
        lastMatchConfig: null
    };
    rooms.set(code, room);
    bindWsRoom(ws, code, 'host');
    welcome(ws, room, 'host', 'red');
    send(ws, envelope(Proto.MSG.PEER_STATUS, { connected: false }, { room: code }));
    log('create', code);
    return room;
}

function joinRoom(ws, code) {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) {
        send(ws, envelope(Proto.MSG.ERROR, { message: '找不到房間' }));
        return null;
    }
    if (room.guest && room.guest.ws && room.guest.ws.readyState === 1) {
        send(ws, envelope(Proto.MSG.ERROR, { message: '房間已滿' }));
        return null;
    }
    room.guest = {
        ws,
        seatToken: makeToken(),
        reconnectToken: makeReconnect(),
        role: 'guest',
        lastSeen: Date.now()
    };
    room.expiresAt = Date.now() + ROOM_TTL_MS;
    bindWsRoom(ws, room.code, 'guest');
    welcome(ws, room, 'guest', 'blue');
    notifyPeer(room, true, 'guest');
    send(ws, envelope(Proto.MSG.PEER_STATUS, { connected: !!(room.host && room.host.ws) }, { room: room.code }));
    log('join', room.code);
    return room;
}

function reconnectSeat(ws, payload) {
    const code = String(payload.room || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
        send(ws, envelope(Proto.MSG.ERROR, { message: '重連失敗：房間不存在' }));
        return null;
    }
    const token = payload.reconnectToken;
    let role = null;
    if (room.host && room.host.reconnectToken === token) role = 'host';
    else if (room.guest && room.guest.reconnectToken === token) role = 'guest';
    if (!role) {
        send(ws, envelope(Proto.MSG.ERROR, { message: '重連失敗：token 無效' }));
        return null;
    }
    const seat = seatOf(room, role);
    if (Date.now() - (seat.lastSeen || 0) > RECONNECT_TTL_MS && seat.ws && seat.ws.readyState === 1) {
        // still connected elsewhere
    }
    seat.ws = ws;
    seat.lastSeen = Date.now();
    room.expiresAt = Date.now() + ROOM_TTL_MS;
    bindWsRoom(ws, room.code, role);
    welcome(ws, room, role, role === 'host' ? 'red' : 'blue');
    notifyPeer(room, true, role);
    log('reconnect', room.code, role);
    return room;
}

function leaveQueue(ws) {
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].ws === ws) queue.splice(i, 1);
    }
}

function tryMatchQueue() {
    while (queue.length >= 2) {
        const a = queue.shift();
        const b = queue.shift();
        if (!a.ws || a.ws.readyState !== 1) {
            if (b) queue.unshift(b);
            continue;
        }
        if (!b.ws || b.ws.readyState !== 1) {
            queue.unshift(a);
            continue;
        }
        const room = createRoom(a.ws);
        // createRoom already welcomed a as host — now attach b as guest
        room.guest = {
            ws: b.ws,
            seatToken: makeToken(),
            reconnectToken: makeReconnect(),
            role: 'guest',
            lastSeen: Date.now()
        };
        bindWsRoom(b.ws, room.code, 'guest');
        const matchedPayload = (role, seatId) => ({
            room: room.code,
            role,
            seatId,
            remoteSeatId: seatId === 'red' ? 'blue' : 'red',
            seatToken: seatOf(room, role).seatToken,
            reconnectToken: seatOf(room, role).reconnectToken
        });
        send(a.ws, envelope(Proto.MSG.QUEUE_MATCHED, matchedPayload('host', 'red'), { room: room.code }));
        welcome(b.ws, room, 'guest', 'blue');
        send(b.ws, envelope(Proto.MSG.QUEUE_MATCHED, matchedPayload('guest', 'blue'), { room: room.code }));
        notifyPeer(room, true, 'guest');
        send(a.ws, envelope(Proto.MSG.PEER_STATUS, { connected: true }, { room: room.code }));
        log('matched', room.code);
    }
}

function enqueue(ws, mode) {
    leaveQueue(ws);
    queue.push({ ws, mode: mode || '1v1', joinedAt: Date.now() });
    send(ws, envelope(Proto.MSG.WELCOME, { message: '排隊中…', queue: true }));
    tryMatchQueue();
}

function relay(ws, msg) {
    const code = ws._aaRoom;
    const role = ws._aaRole;
    if (!code || !role) return;
    const room = rooms.get(code);
    if (!room) return;
    const seat = seatOf(room, role);
    if (seat) seat.lastSeen = Date.now();
    room.expiresAt = Date.now() + ROOM_TTL_MS;

    if (msg.type === Proto.MSG.MATCH_CONFIG) {
        room.lastMatchConfig = msg.payload;
    }

    const other = otherSeat(room, role);
    if (other && other.ws && other.ws !== ws) {
        send(other.ws, msg);
    }
}

function onHello(ws, msg) {
    const payload = msg.payload || {};
    const action = payload.action || 'create';
    if (action === 'create') {
        createRoom(ws, payload.room);
        return;
    }
    if (action === 'join') {
        joinRoom(ws, payload.room);
        return;
    }
    if (action === 'queue') {
        enqueue(ws, payload.mode || '1v1');
        return;
    }
    if (action === 'reconnect') {
        reconnectSeat(ws, payload);
        return;
    }
    send(ws, envelope(Proto.MSG.ERROR, { message: `未知 action: ${action}` }));
}

function onMessage(ws, raw) {
    let msg;
    try {
        msg = JSON.parse(String(raw));
    } catch (e) {
        return;
    }
    if (!Proto.isCompatible(msg)) {
        send(ws, envelope(Proto.MSG.ERROR, { message: 'protocol mismatch', expected: PROTOCOL }));
        return;
    }
    if (msg.clientVersion && msg.clientVersion !== Proto.CLIENT_VERSION) {
        // Soft warn — still allow same PROTOCOL for now
        log('version skew', msg.clientVersion, '!=', Proto.CLIENT_VERSION);
    }

    if (msg.type === Proto.MSG.HELLO) {
        onHello(ws, msg);
        return;
    }
    if (msg.type === Proto.MSG.QUEUE_LEAVE) {
        leaveQueue(ws);
        return;
    }
    if (msg.type === Proto.MSG.PING) {
        send(ws, envelope(Proto.MSG.PONG, { t: msg.ts }));
        return;
    }
    if (msg.type === Proto.MSG.RECONNECT) {
        reconnectSeat(ws, msg.payload || {});
        return;
    }
    // Relay game traffic
    if (
        msg.type === Proto.MSG.MATCH_CONFIG
        || msg.type === Proto.MSG.TURN_INTENT
        || msg.type === Proto.MSG.TURN_LOG
        || msg.type === Proto.MSG.PEER_STATUS
    ) {
        relay(ws, msg);
    }
}

function onClose(ws) {
    leaveQueue(ws);
    const code = ws._aaRoom;
    const role = ws._aaRole;
    if (!code || !role) return;
    const room = rooms.get(code);
    if (!room) return;
    const seat = seatOf(room, role);
    if (seat && seat.ws === ws) {
        seat.ws = null;
        seat.lastSeen = Date.now();
        notifyPeer(room, false, role);
        log('disconnect', code, role);
    }
}

async function main() {
    let WebSocketServer;
    try {
        ({ WebSocketServer } = require('ws'));
    } catch (e) {
        console.error('Missing dependency: ws. Run: npm install ws');
        process.exit(1);
    }

    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ok: true,
                protocol: PROTOCOL,
                rooms: rooms.size,
                queue: queue.length
            }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Air Arena room server (${PROTOCOL})\nWS on same port\nRooms: ${rooms.size} Queue: ${queue.length}\n`);
    });

    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
        ws.on('message', (data) => onMessage(ws, data));
        ws.on('close', () => onClose(ws));
    });

    setInterval(purgeExpired, 30000);

    server.listen(PORT, '0.0.0.0', () => {
        log(`listening on :${PORT} protocol=${PROTOCOL}`);
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
