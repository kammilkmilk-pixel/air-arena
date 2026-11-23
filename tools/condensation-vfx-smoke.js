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
            aoaFogStart: 0.18,
            aoaFogFull: 0.42
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

assert(C.fogAmount(0.0, 0.18, 0.42) === 0, 'below start → fog 0');
assert(C.fogAmount(0.18, 0.18, 0.42) === 0, 'at start → fog 0');
assert(C.fogAmount(0.42, 0.18, 0.42) === 1, 'at full → fog 1');
const mid = C.fogAmount(0.30, 0.18, 0.42);
assert(mid > 0.4 && mid < 0.7, 'mid AoA fog in (0.4,0.7), got ' + mid);

const knobs = C.cfg();
assert(knobs.enabled === true, 'cfg.enabled');
assert(knobs.aoaFogStart === 0.18, 'cfg.aoaFogStart');
assert(knobs.trailPersistMs >= 2000, 'trailPersistMs should cover ~1–2 turns, got ' + knobs.trailPersistMs);
assert(knobs.vortexPts >= 64, 'vortexPts buffer for long wake, got ' + knobs.vortexPts);

console.log('condensation-vfx-smoke: PASS');
