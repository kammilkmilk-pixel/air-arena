// ============================================================================
// sarh-support-smoke.js — illumination range must NOT use minArmingRange
// ============================================================================
const path = require('path');
const assert = require('assert');

// Minimal THREE stub for sarh.js
global.THREE = {
    Vector3: class Vector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x; this.y = y; this.z = z;
        }
        clone() { return new THREE.Vector3(this.x, this.y, this.z); }
        sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
        add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
        length() { return Math.hypot(this.x, this.y, this.z); }
        lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
        normalize() {
            const L = this.length() || 1;
            this.x /= L; this.y /= L; this.z /= L;
            return this;
        }
        applyQuaternion() { return this; }
        angleTo(v) {
            const d = Math.max(-1, Math.min(1, this.x * v.x + this.y * v.y + this.z * v.z));
            return Math.acos(d);
        }
        dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
        crossVectors(a, b) {
            this.x = a.y * b.z - a.z * b.y;
            this.y = a.z * b.x - a.x * b.z;
            this.z = a.x * b.y - a.y * b.x;
            return this;
        }
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
        multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    },
    Quaternion: class Quaternion {
        constructor() {}
    }
};

const CONFIG = require(path.join(__dirname, '../js/core/config.js'));
global.CONFIG = CONFIG;
require(path.join(__dirname, '../js/logic/sarh.js'));

function main() {
    assert.ok(typeof computeSarhSupport === 'function', 'computeSarhSupport missing');
    assert.strictEqual(Number(CONFIG.weapons.fox1.supportMinRange), 8);

    const shooterPos = new THREE.Vector3(0, 40, 0);
    const shooterQuat = {
        // Identity-ish: applyQuaternion stub leaves (0,0,1) as-is via stub Vector3.applyQuaternion
    };
    // Patch applyQuaternion on this instance path: nose is +Z
    const targetClose = new THREE.Vector3(0, 40, 40); // 40m ahead — under old 70m arming floor
    const targetFar = new THREE.Vector3(0, 40, 120);

    const close = computeSarhSupport({
        shooterPos,
        shooterQuat: new THREE.Quaternion(),
        targetPos: targetClose,
        step: 0,
        losBlocked: false
    });
    assert.strictEqual(close.inRange, true, '40m must still illuminate (not minArming 70)');
    assert.ok(close.inGate, 'nose-on 40m should be in gate');
    assert.ok(close.supported, '40m nose-on must be supported');

    const far = computeSarhSupport({
        shooterPos,
        shooterQuat: new THREE.Quaternion(),
        targetPos: targetFar,
        step: 0,
        losBlocked: false
    });
    assert.ok(far.supported, '120m nose-on must be supported');

    const tooClose = computeSarhSupport({
        shooterPos,
        shooterQuat: new THREE.Quaternion(),
        targetPos: new THREE.Vector3(0, 40, 3),
        step: 0
    });
    assert.strictEqual(tooClose.inRange, false, '3m below supportMinRange');

    console.log('sarh-support-smoke: PASS');
    console.log(`  close(40m) supported=${close.supported} far(120m) supported=${far.supported}`);
}

main();
