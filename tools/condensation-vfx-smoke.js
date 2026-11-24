/**
 * Smoke: condensation AoA / fog-amount helpers (no WebGL).
 * Run: node tools/condensation-vfx-smoke.js
 */
'use strict';

global.THREE = {
    Vector3: function Vector3(x, y, z) {
        this.x = x || 0; this.y = y || 0; this.z = z || 0;
    },
    Quaternion: function Quaternion() {},
    Sphere: function Sphere() {},
    BufferGeometry: function BufferGeometry() {},
    BufferAttribute: function BufferAttribute() {},
    PlaneGeometry: function PlaneGeometry() {},
    Mesh: function Mesh() {},
    MeshBasicMaterial: function MeshBasicMaterial() {},
    CanvasTexture: function CanvasTexture() {},
    AdditiveBlending: 2,
    DoubleSide: 2
};
THREE.Vector3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
THREE.Vector3.prototype.copy = function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; };
THREE.Vector3.prototype.clone = function () { return new THREE.Vector3(this.x, this.y, this.z); };
THREE.Vector3.prototype.add = function () { return this; };
THREE.Vector3.prototype.subVectors = function () { return this; };
THREE.Vector3.prototype.divideScalar = function () { return this; };
THREE.Vector3.prototype.length = function () { return 0; };
THREE.Vector3.prototype.lengthSq = function () { return 0; };
THREE.Vector3.prototype.normalize = function () { return this; };
THREE.Vector3.prototype.applyQuaternion = function () { return this; };
THREE.Vector3.prototype.dot = function () { return 1; };
THREE.Vector3.prototype.crossVectors = function () { return this; };
THREE.Vector3.prototype.multiplyScalar = function () { return this; };

global.CONFIG = {
    visuals: {
        condensation: {
            enabled: true,
            onlyDuringFlightAnim: true,
            vortexPts: 96,
            trailPersistMs: 2800,
            aoaFogStart: 0.55,
            aoaFogFull: 1.8
        }
    }
};

require('../js/view/condensation-vfx.js');

const C = global.AirArenaCondensation;
if (!C) {
    console.error('condensation-vfx-smoke: AirArenaCondensation missing');
    process.exit(1);
}

function assert(cond, msg) {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
}

const aligned = C.estimateAoaFromNoseVel(1);
assert(aligned < 1e-6, 'nose||vel → AoA≈0, got ' + aligned);

const ninety = C.estimateAoaFromNoseVel(0);
assert(Math.abs(ninety - Math.PI / 2) < 1e-6, 'perp → AoA≈π/2, got ' + ninety);

assert(C.fogAmount(0.0, 0.55, 1.8) === 0, 'below start → fog 0');
assert(C.fogAmount(0.55, 0.55, 1.8) === 0, 'at start → fog 0');
assert(C.fogAmount(1.8, 0.55, 1.8) === 1, 'at full → fog 1');
const mid = C.fogAmount(1.175, 0.55, 1.8);
assert(mid > 0.4 && mid < 0.7, 'mid AoA fog in (0.4,0.7), got ' + mid);

const knobs = C.cfg();
assert(knobs.enabled === true, 'cfg.enabled');
assert(knobs.onlyDuringFlightAnim === true, 'onlyDuringFlightAnim');
assert(knobs.aoaFogStart === 0.55, 'cfg.aoaFogStart');
assert(knobs.trailPersistMs >= 2000, 'trailPersistMs should cover ~1–2 turns, got ' + knobs.trailPersistMs);
assert(knobs.vortexPts >= 64, 'vortexPts buffer for long wake, got ' + knobs.vortexPts);
assert(knobs.centerWakeTurns > knobs.tipWakeTurns, 'centerWakeTurns (' + knobs.centerWakeTurns + ') must exceed shorter tipWakeTurns (' + knobs.tipWakeTurns + ')');
assert(knobs.centerWakeWidth >= 0.2, 'centerWakeWidth must be wide enough over city/ground, got ' + knobs.centerWakeWidth);
assert(knobs.centerWakeOpacity >= 0.9, 'centerWakeOpacity must stay crisp, got ' + knobs.centerWakeOpacity);
assert(C.centerWakeIntensity({ stallFactor: 0, forwardSpeed: 4.16 }) === 1, 'MIL cruise (4.16 u/turn) must render full center wake');
assert(C.centerWakeIntensity({ stallFactor: 0, forwardSpeed: 0.5 }) === 0, 'near-zero speed must suppress center wake');

// Wingtip condensation maneuver gating checks
assert(typeof C.tipCondensationIntensity === 'function', 'tipCondensationIntensity exported');
assert(C.tipCondensationIntensity({ pullRate: 0, rollRate: 0, turnRate: 0, climbDeg: 0, bankDeg: 0, speed: 20 }) === 0,
    'straight & level cruise must have 0 wingtip condensation');
assert(C.tipCondensationIntensity({ pullRate: 0.12, rollRate: 0.10, turnRate: 0.10, climbDeg: 8, bankDeg: 10, speed: 20 }) === 0,
    'gentle climb/turn must have 0 wingtip condensation');
assert(C.tipCondensationIntensity({ pullRate: -0.35, rollRate: 0, turnRate: 0, climbDeg: -15, bankDeg: 0, speed: 25 }) === 0,
    'push-over dive must have 0 wingtip condensation');
assert(C.tipCondensationIntensity({ pullRate: 0.8, rollRate: 0.8, turnRate: 0, climbDeg: 40, bankDeg: 45, speed: 0.5 }) === 0,
    'near-zero speed / stall must suppress wingtip condensation');
assert(C.tipCondensationIntensity({ pullRate: 0.65, rollRate: 0, turnRate: 0, climbDeg: 18, bankDeg: 0, speed: 20 }) > 0.9,
    'high-G pull-up must strongly trigger wingtip condensation');
assert(C.tipCondensationIntensity({ pullRate: 0.05, rollRate: 0, turnRate: 0, climbDeg: 38, bankDeg: 0, speed: 20 }) > 0.7,
    'steep climb attitude must trigger wingtip condensation');
assert(C.tipCondensationIntensity({ pullRate: 0, rollRate: 0.60, turnRate: 0, climbDeg: 0, bankDeg: 35, speed: 20 }) > 0.9,
    'hard roll must strongly trigger wingtip condensation');
assert(C.tipCondensationIntensity({ pullRate: 0, rollRate: 0.05, turnRate: 0.60, climbDeg: 0, bankDeg: 38, speed: 20 }) > 0.7,
    'hard banked turn must trigger wingtip condensation');

console.log('condensation-vfx-smoke: PASS');
