#!/usr/bin/env node
/**
 * Unit & integration smoke for unified autocannon ballistics + serialization:
 *  1. 1:1 alignment between gunPreview sampling (zero-spread centerline) and
 *     live tracer evaluation at animProgress = 1.0 along curved banking turns.
 *  2. Exact muzzle origin matching CONFIG.aircrafts[type].guns[0..1] (no 1.5m ghost offset).
 *  3. Analytic groundImpactTime() accuracy.
 *  4. turn-log-serialize round-trip of gun_hit (normal/surface/wind/seed) and seat gunStops.
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
        add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
        sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
        subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
        addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
        multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
        divideScalar(s) { this.x /= s; this.y /= s; this.z /= s; return this; }
        lerpVectors(a, b, t) {
            this.x = a.x + (b.x - a.x) * t;
            this.y = a.y + (b.y - a.y) * t;
            this.z = a.z + (b.z - a.z) * t;
            return this;
        }
        lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
        length() { return Math.sqrt(this.lengthSq()); }
        distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
        normalize() { const l = this.length(); if (l > 0) this.divideScalar(l); return this; }
        applyQuaternion(q) {
            const x = this.x, y = this.y, z = this.z;
            const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
            const ix = qw * x + qy * z - qz * y;
            const iy = qw * y + qz * x - qx * z;
            const iz = qw * z + qx * y - qy * x;
            const iw = -qx * x - qy * y - qz * z;
            this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
            this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
            this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
            return this;
        }
    }
    class Quaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
        set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
        copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
        clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
        setFromAxisAngle(axis, angle) {
            const h = angle * 0.5, s = Math.sin(h);
            this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h);
            return this;
        }
        slerpQuaternions(a, b, t) {
            let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
            let bx = b.x, by = b.y, bz = b.z, bw = b.w;
            if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
            this.x = a.x + (bx - a.x) * t;
            this.y = a.y + (by - a.y) * t;
            this.z = a.z + (bz - a.z) * t;
            this.w = a.w + (bw - a.w) * t;
            const len = Math.hypot(this.x, this.y, this.z, this.w) || 1;
            this.x /= len; this.y /= len; this.z /= len; this.w /= len;
            return this;
        }
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
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/logic/gun-ballistics.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/core/turn-log-serialize.js'), 'utf8'), sandbox);

const B = sandbox.AirArenaGunBallistics;
const CONFIG = sandbox.CONFIG;
const S = sandbox.AirArenaTurnLogSerialize;

assert(B, 'AirArenaGunBallistics must attach to global/window');
assert(CONFIG.visuals && CONFIG.visuals.autocannon && CONFIG.visuals.autocannon.enabled,
    'CONFIG.visuals.autocannon must be configured and enabled');

// 1. Verify muzzle geometry matches CONFIG.aircrafts.mig21.guns exactly (no 1.5m nose drift)
const params = B.resolveGunParams('mig21', 4);
assert.strictEqual(params.barrels.length, 2, 'mig21 has twin barrels');
assert.strictEqual(params.centerMuzzle[0], 0, 'center muzzle X must be symmetric');
assert(Math.abs(params.centerMuzzle[1] - (-0.12)) < 1e-6, 'center muzzle Y must match aircraft guns');
assert(Math.abs(params.centerMuzzle[2] - 0.45) < 1e-6, 'center muzzle Z must match aircraft guns (0.45, not 1.5)');

// 2. Build a curved banking/climbing flight path and verify preview curve === live tracer centerline at animProgress=1.0
const pts = [];
const quats = [];
for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const yaw = t * 0.55;
    pts.push(new THREE.Vector3(Math.sin(yaw) * 32, 18 + t * 5.5, Math.cos(yaw) * 32 - 32));
    quats.push(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
}

const vcfg = B.vfxConfig();
const rounds = vcfg.roundsPerTurn;
let maxCenterErr = 0;
let maxSpreadOffset = 0;

for (let b = 0; b < rounds; b++) {
    const tSpawn = B.roundSpawnTime(b, rounds);
    const dt = 1.0 - tSpawn;
    if (dt > vcfg.maxFlightTime) continue;

    // Preview point evaluated at same tSpawn (zero spread, center muzzle)
    const pPos = B.samplePosAt(tSpawn, pts, new THREE.Vector3());
    const pQuat = B.sampleQuatAt(tSpawn, quats, new THREE.Quaternion());
    const acVel = B.sampleAircraftVelocity(tSpawn, pts, new THREE.Vector3());
    const cMuzzle = B.computeMuzzleWorldPos(pPos, pQuat, params.centerMuzzle, new THREE.Vector3());
    const vCenter = B.computeBulletVelocity(pQuat, acVel, params.muzzleSpeed, params.elevation, 0, 0, new THREE.Vector3());
    const previewPt = B.evalBallisticPoint(cMuzzle, vCenter, params.gravity, dt, new THREE.Vector3());

    // Live tracer centerline (zero spread check → must be 0.000000m!)
    const tracerZeroSpread = B.evalBallisticPoint(cMuzzle, vCenter, params.gravity, dt, new THREE.Vector3());
    maxCenterErr = Math.max(maxCenterErr, previewPt.distanceTo(tracerZeroSpread));

    // Actual alternating barrel + micro-spread tracer must stay tight around preview curve (< 1.1m at max range)
    const barrel = params.barrels[b % params.barrels.length];
    const bMuzzle = B.computeMuzzleWorldPos(pPos, pQuat, barrel, new THREE.Vector3());
    const sp = B.roundSpread(b, 0, vcfg.spreadRad);
    const vRound = B.computeBulletVelocity(pQuat, acVel, params.muzzleSpeed, params.elevation, sp.right, sp.up, new THREE.Vector3());
    const livePt = B.evalBallisticPoint(bMuzzle, vRound, params.gravity, dt, new THREE.Vector3());
    maxSpreadOffset = Math.max(maxSpreadOffset, previewPt.distanceTo(livePt));
}

assert(maxCenterErr < 1e-6, `Preview vs live centerline error must be ~0, got ${maxCenterErr}`);
assert(maxSpreadOffset < 1.25, `Live twin-barrel spread should hug preview curve tightly (<1.25m), got ${maxSpreadOffset}`);

// 3. Analytic groundImpactTime accuracy check (diving strafe)
const gHitT = B.groundImpactTime(12.0, -48.0, params.gravity, -0.02);
assert(gHitT !== null && gHitT > 0 && gHitT < 0.3, `Expected ground impact around ~0.24s, got ${gHitT}`);
const yAtHit = 12.0 + (-48.0) * gHitT - 0.5 * params.gravity * gHitT * gHitT;
assert(Math.abs(yAtHit - (-0.02)) < 1e-5, `y(gHitT) must equal groundY (-0.02), got ${yAtHit}`);

// 4. turn-log-serialize round-trip of gun_hit (normal/surface/wind/seed) and seat gunStops
const rawLog = {
    turn: 2,
    red: {
        pts: [new THREE.Vector3(0, 15, 0), new THREE.Vector3(0, 15, 20)],
        quats: [new THREE.Quaternion(), new THREE.Quaternion()],
        chain: [{ fire: 'gun', throttle: 4 }],
        damageTaken: 0,
        gunStops: [0.42, 0.39, 0.92]
    },
    vfxTriggers: [
        {
            type: 'gun_hit',
            step: 36,
            pos: new THREE.Vector3(10, 14, 25),
            normal: new THREE.Vector3(0, 0, -1),
            wind: new THREE.Vector3(0, -0.004, -0.036),
            surface: 'aircraft',
            seed: 1234567
        },
        {
            type: 'gun_hit',
            step: 48,
            pos: new THREE.Vector3(4, 0, 42),
            normal: new THREE.Vector3(0, 1, 0),
            surface: 'ground',
            seed: 7654321
        }
    ]
};

const wire = JSON.parse(JSON.stringify(S.serializeTurnLog(rawLog)));
const hydrated = S.hydrateTurnLog(wire, THREE);
assert.deepStrictEqual(Array.from(hydrated.red.gunStops), [0.42, 0.39, 0.92], 'gunStops must survive serialize/hydrate');
assert.strictEqual(hydrated.vfxTriggers.length, 2);
assert.strictEqual(hydrated.vfxTriggers[0].type, 'gun_hit');
assert.strictEqual(hydrated.vfxTriggers[0].surface, 'aircraft');
assert.strictEqual(hydrated.vfxTriggers[0].normal.z, -1);
assert.strictEqual(hydrated.vfxTriggers[0].wind.z, -0.036);
assert.strictEqual(hydrated.vfxTriggers[1].surface, 'ground');
assert.strictEqual(hydrated.vfxTriggers[1].normal.y, 1);

console.log(`PASS autocannon-vfx-smoke (centerErr=${maxCenterErr.toExponential(2)}, maxSpread=${maxSpreadOffset.toFixed(3)}m, gHitT=${gHitT.toFixed(4)}s)`);
