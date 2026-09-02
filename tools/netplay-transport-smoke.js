'use strict';

const path = require('path');
const Proto = require('../js/core/netplay-protocol.js');
const Transports = require('../js/core/netplay-transports.js');
const SbCfg = require('../js/core/supabase-config.js');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(Transports.resolveKind, 'resolveKind');
assert(Transports.resolveKind({ transport: 'supabase' }) === 'supabase', 'explicit supabase');
assert(Transports.resolveKind({ transport: 'websocket' }) === 'websocket', 'explicit ws');
assert(Transports.resolveKind({ transport: 'broadcast' }) === 'broadcast', 'explicit bc');
assert(Transports.resolveKind({ action: 'create' }) === 'websocket', 'create defaults ws');

assert(typeof SbCfg.resolve === 'function', 'supabase config api');
assert(SbCfg.resolve() == null || (SbCfg.resolve().url && SbCfg.resolve().anonKey), 'resolve shape');

assert(Proto.MSG.TURN_INTENT === 'turn-intent', 'protocol intact');
assert(Transports.ROOM_TTL_MS >= 60 * 1000, 'ttl');

// Broadcast transport needs browser; skip if unavailable
if (typeof BroadcastChannel !== 'undefined') {
    let got = null;
    const t = Transports.createBroadcastTransport({
        roomId: 'SMOKE',
        onMessage: (m) => { got = m; }
    });
    assert(t && t.kind === 'broadcast', 'bc transport');
    t.send(Proto.envelope(Proto.MSG.PEER_STATUS, { connected: true }));
    t.close();
}

console.log('netplay-transport-smoke: ok', Proto.PROTOCOL);
