'use strict';

const Proto = require('../js/core/netplay-protocol.js');
const Ser = require('../js/core/turn-log-serialize.js');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(Proto.PROTOCOL === Ser.PROTOCOL, 'protocol aligns with turn-log');
assert(Proto.CLIENT_VERSION, 'client version');
assert(Proto.MSG.TURN_INTENT === 'turn-intent', 'intent msg');
assert(Proto.MSG.QUEUE_MATCHED === 'queue-matched', 'queue msg');

const seed = Proto.makeMatchSeed();
assert(Number.isFinite(seed) && seed > 0, 'match seed');

const code = Proto.makeInviteCode();
assert(/^[A-Z0-9]{6}$/.test(code), 'invite code shape');

const intent = Proto.buildTurnIntent('blue', {
    joyX: 0.2,
    joyY: -0.1,
    throttle: 4,
    weapon: 'gun',
    queuedAction: 'none',
    lockedTargetId: 'red',
    pylons: [{ id: 'p1', weaponType: 'fox1', state: 'armed' }]
}, 3);
assert(intent.seatId === 'blue' && intent.turn === 3 && intent.ready === true, 'build intent');

const env = Proto.envelope(Proto.MSG.TURN_INTENT, intent, { room: 'ABC123' });
assert(Proto.isCompatible(env), 'envelope compatible');
assert(env.room === 'ABC123', 'extra fields');

const cfg = Proto.defaultNetMatchConfig('red');
assert(cfg.mode === '1v1', 'default 1v1');
assert(cfg.seats['red-1'].control === 'human', 'red human');
assert(cfg.seats['blue-1'].control === 'human', 'blue human');

console.log('netplay-protocol-smoke: ok', Proto.PROTOCOL, code, seed);
