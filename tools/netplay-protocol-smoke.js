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

// Bomb / rocket intent roundtrip (ammo + queuedAction preserved on host)
const rktSeat = {
    throttle: 4.5,
    weapon: 'rocket',
    queuedAction: 'rocket',
    wpnQueued: true,
    pylons: [
        { id: 1, weaponType: 'bomb', state: 'standby' },
        { id: 4, weaponType: 'rocket', state: 'armed', ammo: 6, ammoMax: 9 }
    ]
};
const rktIntent = Proto.buildTurnIntent('blue', rktSeat, 5);
assert(rktIntent.pylons[1].ammo === 6 && rktIntent.pylons[1].ammoMax === 9, 'rocket ammo in intent');
const hostSeat = {
    isDestroyed: false,
    matchActive: true,
    pylons: [
        { id: 1, weaponType: 'bomb', state: 'standby' },
        { id: 4, weaponType: 'rocket', state: 'standby', ammo: 9, ammoMax: 9 }
    ]
};
let toggledRkt = 0;
let toggledBomb = 0;
const mockGC = {
    getTeam: () => hostSeat,
    setLockedTarget: () => {},
    stateMachine: {
        setThrottle: (_id, v) => { hostSeat.throttle = v; },
        setJoystickInput: () => {},
        setRollInput: () => {},
        setWeaponMode: (_id, w) => { hostSeat.weapon = w; },
        setWingmanOrder: () => {},
        toggleRocketQueue: () => { toggledRkt++; hostSeat.queuedAction = 'rocket'; hostSeat.wpnQueued = true; },
        toggleBombQueue: () => { toggledBomb++; hostSeat.queuedAction = 'bomb'; hostSeat.wpnQueued = true; },
        clearQueuedAction: () => { hostSeat.queuedAction = 'none'; hostSeat.wpnQueued = false; },
        setReady: (_id, r) => { hostSeat.ready = r; }
    }
};
assert(Proto.applyTurnIntent('blue', rktIntent, { GameContext: mockGC }), 'apply rocket intent');
assert(toggledRkt === 1 && hostSeat.queuedAction === 'rocket' && hostSeat.pylons[1].ammo === 6, 'rocket queued + ammo synced');
const bombIntent = Proto.buildTurnIntent('blue', {
    weapon: 'bomb',
    queuedAction: 'bomb',
    wpnQueued: true,
    pylons: [{ id: 1, weaponType: 'bomb', state: 'armed' }]
}, 6);
assert(Proto.applyTurnIntent('blue', bombIntent, { GameContext: mockGC }), 'apply bomb intent');
assert(toggledBomb === 1 && hostSeat.queuedAction === 'bomb', 'bomb queued on host');

console.log('netplay-protocol-smoke: ok', Proto.PROTOCOL, code, seed);
