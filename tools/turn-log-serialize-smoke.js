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
    },
    redBombTracks: {
        1: [{ pos: { x: 5, y: 40, z: 6 }, quat: { x: 0, y: 0, z: 0, w: 1 } }, null]
    },
    redBombExplodedAt: { 1: 42 },
    redRktTracks: {
        '4_0': [{ pos: { x: 7, y: 41, z: 8 }, quat: { x: 0, y: 0, z: 0, w: 1 } }]
    },
    redRktExplodedAt: { '4_0': 18 }
};

const plain = Ser.serializeTurnLog(log);
assert(plain.protocol === Ser.PROTOCOL, 'protocol tag');
assert(plain.radioCues.length === 1, 'radioCues kept');
assert(plain.vfxTriggers[0].seed === 99, 'spark seed kept');
assert(plain.vfxTriggers[0].velocities == null, 'velocities stripped');
assert(plain.red.pts[0].x === 10, 'pts flattened');
assert(plain.redBombTracks[1][0].pos.y === 40, 'bomb track serialized');
assert(plain.redRktTracks['4_0'][0].pos.z === 8, 'rocket track serialized');
assert(plain.redBombExplodedAt[1] === 42 && plain.redRktExplodedAt['4_0'] === 18, 'A2G explodedAt kept');
const json = JSON.stringify(plain);
assert(json.indexOf('"x":10') >= 0, 'JSON roundtrip');
const back = Ser.hydrateTurnLog(JSON.parse(json), null);
assert(back.red.pts[0].x === 10, 'hydrate without THREE keeps xyz');
assert(back.vfxTriggers[0].count === 8, 'hydrate keeps spark meta');
assert(back.redBombTracks[1][0].quat.w === 1, 'hydrate keeps bomb quat');
assert(back.redRktTracks['4_0'][0].pos.x === 7, 'hydrate keeps rocket pos');

console.log('turn-log-serialize-smoke: ok', json.length, 'bytes');
