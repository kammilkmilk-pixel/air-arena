'use strict';

const Ser = require('../js/core/turn-log-serialize.js');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const log = {
    turn: 2,
    winner: null,
    destroyed: { blue: false },
    radioCues: [{ step: 0, speakerSeatId: 'red', callsign: 'REI', event: 'fire_gun', textKey: 'radio.fire_gun' }],
    vfxTriggers: [{
        type: 'spark_explosion',
        step: 4,
        pos: { x: 1, y: 2, z: 3, clone() { return this; } },
        seed: 99,
        count: 8,
        power: 0.4,
        velocities: [{ x: 9, y: 9, z: 9 }]
    }],
    red: {
        pts: [{ x: 10, y: 20, z: 30 }, { x: 11, y: 21, z: 31 }],
        quats: [{ x: 0, y: 0, z: 0, w: 1 }],
        damageTaken: 0,
        chain: [{ fire: 'gun', throttle: 4 }]
    }
};

const plain = Ser.serializeTurnLog(log);
assert(plain.protocol === Ser.PROTOCOL, 'protocol tag');
assert(plain.radioCues.length === 1, 'radioCues kept');
assert(plain.vfxTriggers[0].seed === 99, 'spark seed kept');
assert(plain.vfxTriggers[0].velocities == null, 'velocities stripped');
assert(plain.red.pts[0].x === 10, 'pts flattened');
const json = JSON.stringify(plain);
assert(json.indexOf('"x":10') >= 0, 'JSON roundtrip');
const back = Ser.hydrateTurnLog(JSON.parse(json), null);
assert(back.red.pts[0].x === 10, 'hydrate without THREE keeps xyz');
assert(back.vfxTriggers[0].count === 8, 'hydrate keeps spark meta');

console.log('turn-log-serialize-smoke: ok', json.length, 'bytes');
