#!/usr/bin/env node
/**
 * Unit & integration smoke for realistic stall visual system:
 *  1. computeStallFactor() across normal flight, pre-stall onset, deep stall, and kinematic mushing.
 *  2. Condensation wake suppression: aft center white ribbon & wingtip condensation drop to 0 during stall
 *     while staying strong during high-speed attached climbs/turns.
 *  3. Airframe buffet/wing-rock offsets & compressor-stall sputtering exhaust modulation.
 *  4. turn-log-serialize round-trip of stalled / startAP / endAP seat fields.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

function makeThreeStub() {
    class Vector3 {
        constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
        copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
        clone() { return new Vector3(this.x, this.y, this.z); }
        subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
        divideScalar(s) { this.x /= s; this.y /= s; this.z /= s; return this; }
        length() { return Math.hypot(this.x, this.y, this.z); }
        dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    }
    class Quaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
        copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    }
    return { Vector3, Quaternion };
}

const THREE = makeThreeStub();
const sandbox = {
    window: {},
    location: { search: '' },
    URLSearchParams,
    THREE,
    console,
    Math
};
sandbox.window = sandbox;

vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/core/config.js'), 'utf8') + '\nthis.CONFIG = CONFIG;', sandbox);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/view/stall-vfx.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/view/condensation-vfx.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/core/turn-log-serialize.js'), 'utf8'), sandbox);

const Stall = sandbox.AirArenaStallVfx;
const Cond = sandbox.AirArenaCondensation;
const Ser = sandbox.AirArenaTurnLogSerialize;

assert(Stall && Cond && Ser, 'Required modules must initialize cleanly');

// 1) Stall intensity aerodynamics
const sfCruise = Stall.computeStallFactor({ stalled: false, ap: 140, forwardSpeed: 22, slipAngleDeg: 3 });
assert.strictEqual(sfCruise, 0, `Normal cruise must have stallFactor=0, got ${sfCruise}`);

// Real physics.js per-turn speeds (ECO≈2.5, MIL≈4.16 u/turn) must NEVER be misclassified as stalled
const sfEcoCruise = Stall.computeStallFactor({ stalled: false, ap: 120, forwardSpeed: 2.5, slipAngleDeg: 2 });
assert.strictEqual(sfEcoCruise, 0, `Normal ECO cruise (2.5 u/turn) must have stallFactor=0, got ${sfEcoCruise}`);
const sfMilCruise = Stall.computeStallFactor({ stalled: false, ap: 120, forwardSpeed: 4.16, slipAngleDeg: 2 });
assert.strictEqual(sfMilCruise, 0, `Normal MIL cruise (4.16 u/turn) must have stallFactor=0, got ${sfMilCruise}`);

const sfApexHang = Stall.computeStallFactor({ stalled: false, ap: 80, forwardSpeed: 0.7, slipAngleDeg: 2 });
assert(sfApexHang > 0.6, `True zero-airspeed apex hang (0.7 u/turn) must trigger stallFactor > 0.6, got ${sfApexHang}`);

const sfOnset = Stall.computeStallFactor({ stalled: false, ap: 39, forwardSpeed: 9, slipAngleDeg: 8 });
assert(sfOnset > 0.1 && sfOnset < 0.65, `Pre-stall AP=39 should give gradual onset, got ${sfOnset}`);

const sfDeep = Stall.computeStallFactor({ stalled: true, ap: 18, forwardSpeed: 3.0, slipAngleDeg: 36 });
assert(sfDeep >= 0.88, `Deep stall must yield high stallFactor >= 0.88, got ${sfDeep}`);

const sfKinematic = Stall.computeStallFactor({ stalled: false, forwardSpeed: 2.6, slipAngleDeg: 40 });
assert(sfKinematic >= 0.75, `Kinematic low-speed mushing must detect stall without flag, got ${sfKinematic}`);

// 2) Laminar wake & wingtip condensation suppression during stall
const cwCruise = Cond.centerWakeIntensity({ stallFactor: 0, forwardSpeed: 4.16 });
const cwEco = Cond.centerWakeIntensity({ stallFactor: 0, forwardSpeed: 2.5 });
const cwStall = Cond.centerWakeIntensity({ stallFactor: sfDeep, forwardSpeed: 3.0 });
assert.strictEqual(cwCruise, 1, `Center white wake should be 1.0 in normal MIL flight (4.16 u/turn), got ${cwCruise}`);
assert(cwEco > 0.75, `Center white wake should stay strong in ECO cruise (2.5 u/turn), got ${cwEco}`);
assert.strictEqual(cwStall, 0, `Center white wake must vanish during deep stall, got ${cwStall}`);

const tipHighSpeedClimb = Cond.tipCondensationIntensity({ climbDeg: 40, forwardSpeed: 20, stallFactor: 0 });
const tipStalledClimb = Cond.tipCondensationIntensity({ climbDeg: 40, forwardSpeed: 3.5, stallFactor: sfDeep });
assert(tipHighSpeedClimb > 0.8, `High-speed steep climb should keep strong wingtip condensation, got ${tipHighSpeedClimb}`);
assert.strictEqual(tipStalledClimb, 0, `Stalled nose-high climb must NOT draw smooth wingtip condensation, got ${tipStalledClimb}`);

// 3) Visual-only buffet & sputtering exhaust modulation
const bufNormal = Stall.computeBuffetOffsets(0, 2.5, 1.0);
assert.strictEqual(bufNormal.rotZ, 0);
assert.strictEqual(bufNormal.posY, 0);

let maxRoll = 0;
let minExhZ = 1.0;
for (let i = 0; i < 40; i++) {
    const b = Stall.computeBuffetOffsets(0.95, i * 0.08, 1.0);
    maxRoll = Math.max(maxRoll, Math.abs(b.rotZ));
    const em = Stall.computeExhaustMod(0.95, 4, i * 90, 1.0);
    minExhZ = Math.min(minExhZ, em.scaleZMult);
}
assert(maxRoll > 0.06, `Deep stall must produce visible wing rock (>0.06 rad), got ${maxRoll}`);
assert(minExhZ < 0.75, `Deep stall must sputter/shorten exhaust plume (<0.75x), got ${minExhZ}`);

const emNormal = Stall.computeExhaustMod(0, 4, 1234, 1.0);
assert.strictEqual(emNormal.scaleZMult, 1.0, 'Normal flight exhaust multiplier must stay 1.0');

// 4) Timeline sampling transitions smoothly from high-speed climb into stall
const log = [
    {
        turn: 1,
        red: {
            pts: Array.from({ length: 21 }, (_, i) => ({ x: 0, y: 20 + i * 0.6, z: i * 1.1 })),
            quats: Array.from({ length: 21 }, () => ({ x: -0.25, y: 0, z: 0, w: 0.968 })),
            stalled: false,
            startAP: 110,
            endAP: 95
        }
    },
    {
        turn: 2,
        red: {
            pts: Array.from({ length: 21 }, (_, i) => ({ x: 0, y: 32 - i * 0.25, z: 22 + i * 0.12 })),
            quats: Array.from({ length: 21 }, () => ({ x: -0.35, y: 0, z: 0, w: 0.936 })),
            stalled: true,
            startAP: 28,
            endAP: 18
        }
    }
];
const preStallSample = Stall.sampleStallAtU('red', 0.5, log);
const inStallSample = Stall.sampleStallAtU('red', 1.5, log);
assert.strictEqual(preStallSample.isStalled, false);
assert.strictEqual(inStallSample.isStalled, true);

// 5) Serialization round-trip preserves stalled / startAP / endAP
const wire = JSON.parse(JSON.stringify(Ser.serializeTurnLog(log[1])));
const hydrated = Ser.hydrateTurnLog(wire, THREE);
assert.strictEqual(hydrated.red.stalled, true);
assert.strictEqual(hydrated.red.startAP, 28);
assert.strictEqual(hydrated.red.endAP, 18);

console.log(`PASS stall-vfx-smoke (onset=${sfOnset.toFixed(2)}, deep=${sfDeep.toFixed(2)}, kinematic=${sfKinematic.toFixed(2)}, maxRoll=${(maxRoll * 180 / Math.PI).toFixed(1)}deg, minExhZ=${minExhZ.toFixed(2)})`);
