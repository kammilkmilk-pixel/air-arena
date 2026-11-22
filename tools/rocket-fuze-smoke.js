// ============================================================================
// rocket-fuze-smoke.js — VT (airburst) vs Impact (ground/direct) fuze & aim solver
// ============================================================================
'use strict';

const path = require('path');
const assert = require('assert');

class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x; this.y = y; this.z = z;
    }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    lerp(v, t) {
        this.x += (v.x - this.x) * t;
        this.y += (v.y - this.y) * t;
        this.z += (v.z - this.z) * t;
        return this;
    }
    lerpVectors(a, b, t) {
        this.x = a.x + (b.x - a.x) * t;
        this.y = a.y + (b.y - a.y) * t;
        this.z = a.z + (b.z - a.z) * t;
        return this;
    }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.lengthSq()); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    normalize() {
        const L = this.length() || 1;
        this.x /= L; this.y /= L; this.z /= L;
        return this;
    }
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
    constructor(x = 0, y = 0, z = 0, w = 1) {
        this.x = x; this.y = y; this.z = z; this.w = w;
    }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
    setFromAxisAngle(axis, angle) {
        const half = angle * 0.5;
        const s = Math.sin(half);
        this.x = axis.x * s;
        this.y = axis.y * s;
        this.z = axis.z * s;
        this.w = Math.cos(half);
        return this;
    }
    multiply(q) {
        const ax = this.x, ay = this.y, az = this.z, aw = this.w;
        const bx = q.x, by = q.y, bz = q.z, bw = q.w;
        this.x = ax * bw + aw * bx + ay * bz - az * by;
        this.y = ay * bw + aw * by + az * bx - ax * bz;
        this.z = az * bw + aw * bz + ax * by - ay * bx;
        this.w = aw * bw - ax * bx - ay * by - az * bz;
        return this;
    }
    setFromUnitVectors(vFrom, vTo) {
        let r = vFrom.dot(vTo) + 1;
        if (r < 1e-6) {
            r = 0;
            if (Math.abs(vFrom.x) > Math.abs(vFrom.z)) {
                this.x = -vFrom.y; this.y = vFrom.x; this.z = 0; this.w = r;
            } else {
                this.x = 0; this.y = -vFrom.z; this.z = vFrom.y; this.w = r;
            }
        } else {
            this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
            this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
            this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
            this.w = r;
        }
        const L = Math.hypot(this.x, this.y, this.z, this.w) || 1;
        this.x /= L; this.y /= L; this.z /= L; this.w /= L;
        return this;
    }
}

global.THREE = { Vector3, Quaternion, Raycaster: null };
global.CONFIG = require(path.join(__dirname, '../js/core/config.js'));
require(path.join(__dirname, '../js/logic/rocket.js'));

const R = global.AirArenaRocket;
assert(R, 'AirArenaRocket missing');

function makePitchQuat(pitchDeg, yawDeg = 0) {
    const qYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawDeg * Math.PI / 180);
    const qPitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitchDeg * Math.PI / 180);
    return qYaw.multiply(qPitch);
}

function makeTeam(id, pos, pitchDeg, yawDeg = 0) {
    const q = makePitchQuat(pitchDeg, yawDeg);
    const fwd = new Vector3(0, 0, 1).applyQuaternion(q);
    const end = pos.clone().addScaledVector(fwd, 15);
    return {
        id,
        hp: 100,
        isDestroyed: false,
        rocketFuze: 'vt',
        flightLength: 15,
        wrapper: { position: pos.clone(), quaternion: q.clone(), userData: { logicalQuat: q.clone() } },
        pylons: [{ id: 4, weaponType: 'rocket', state: 'armed', ammo: 9, ammoMax: 9, localPosition: new Vector3(0, 0, 0) }],
        pathPoints: [pos.clone(), end],
        pathQuats: [q.clone(), q.clone()]
    };
}

// 1. Fuze sanitization & state helpers
const dummy = { rocketFuze: 'vt' };
assert.strictEqual(R.getTeamFuzeMode(dummy), 'vt');
assert.strictEqual(R.setTeamFuzeMode(dummy, 'impact'), 'impact');
assert.strictEqual(R.getTeamFuzeMode(dummy), 'impact');
assert.strictEqual(R.setTeamFuzeMode(dummy, 'bogus'), 'vt');

// 2. VT aim solver: head-on enemy at 55m triggers VT airburst window
const redVt = makeTeam('red', new Vector3(0, 35, 0), -1.5, 0);
const blueHeadOn = makeTeam('blue', new Vector3(0, 34.2, 55), 0, 180);
R.setTeamFuzeMode(redVt, 'vt');
const solVt = R.computeRocketAimSolution(redVt, blueHeadOn);
assert(solVt && solVt.fuze === 'vt', 'VT solution missing');
assert.strictEqual(solVt.anyVtHit, true, 'Expected head-on VT salvo to register anyVtHit');
assert(solVt.bestCpaDist <= 6.0, 'Expected CPA <= 6m VT radius, got ' + solVt.bestCpaDist);
assert(solVt.targetEstWorld && solVt.aimWorld, 'Expected targetEstWorld and aimWorld in VT mode');

// 3. Impact aim solver: -28 deg dive hits ground (y ~ 0), while +45 deg climb reports ungrounded
const redDive = makeTeam('red', new Vector3(0, 35, 0), -28, 0);
R.setTeamFuzeMode(redDive, 'impact');
const solImp = R.computeRocketAimSolution(redDive, blueHeadOn);
assert(solImp && solImp.fuze === 'impact', 'Impact solution missing');
assert.strictEqual(solImp.grounded, true, 'Expected -28 deg dive to reach ground');
assert(Math.abs(solImp.aimWorld.y) < 0.25, 'Expected ground impact y ~ 0, got ' + solImp.aimWorld.y);

const redClimb = makeTeam('red', new Vector3(0, 35, 0), 45, 0);
R.setTeamFuzeMode(redClimb, 'impact');
const solSky = R.computeRocketAimSolution(redClimb, blueHeadOn);
assert(solSky && solSky.grounded === false, 'Expected +45 deg climb to be ungrounded');

// 4. Runtime resolution difference: VT proximity-bursts at 4m miss & 3.5m floor; IMPACT flies past both to y=0
const vtPrediction = R.predictRocketImpact(new Vector3(0, 20, 0), new Vector3(0, -18, 45), new Quaternion(), { fuze: 'vt' });
const impPrediction = R.predictRocketImpact(new Vector3(0, 20, 0), new Vector3(0, -18, 45), new Quaternion(), { fuze: 'impact' });
assert.strictEqual(vtPrediction.hitKind, 'vt_ground', 'VT rocket should airburst at vtGroundHeight (~3.5m)');
assert(vtPrediction.impact.y > 0.5 && vtPrediction.impact.y <= 3.6, 'VT airburst height should stop near 3.5m, got ' + vtPrediction.impact.y);
assert.strictEqual(impPrediction.hitKind, 'ground', 'Impact rocket should fly all the way to ground');
assert.strictEqual(impPrediction.impact.y, 0, 'Impact rocket should detonate at y = 0');

// Near-miss 4m away from enemy airframe: VT detonates, IMPACT ignores proximity
const enemyNear = makeTeam('blue', new Vector3(4.0, 35, 10.6), 0, 180);
const shooter = makeTeam('red', new Vector3(0, 35, 0), 0, 0);
shooter.activeRockets = [
    {
        trackId: 'r_vt', pylonId: 4, fuze: 'vt', vt: true, active: true, exploded: false,
        launchStep: 0, ageSteps: 6, pos: new Vector3(0, 35, 9.5), vel: new Vector3(0, 0, 55), quat: new Quaternion()
    },
    {
        trackId: 'r_imp', pylonId: 4, fuze: 'impact', vt: false, active: true, exploded: false,
        launchStep: 0, ageSteps: 6, pos: new Vector3(0, 35, 9.5), vel: new Vector3(0, 0, 55), quat: new Quaternion()
    }
];
global.teams = { red: shooter, blue: enemyNear };
const stepCtx = { log: {}, hp: { red: 100, blue: 100 } };
R.resolveRocketsForStep(10, 0.2, stepCtx);
assert.strictEqual(shooter.activeRockets.length, 1, 'VT rocket should burst at 4m proximity while IMPACT rocket keeps flying');
assert.strictEqual(shooter.activeRockets[0].fuze, 'impact', 'Remaining rocket must be the impact-fuzed rocket');
assert(stepCtx.hp.blue < 100, 'VT proximity burst should damage enemy within 6m');

// 5. Obstacle broadphase: building hit still found, open-air segments skip the narrow-phase raycast.
class Box3 {
    constructor() { this.min = new Vector3(Infinity, Infinity, Infinity); this.max = new Vector3(-Infinity, -Infinity, -Infinity); }
    setFromObject(obj) { this.min.copy(obj.userData.box.min); this.max.copy(obj.userData.box.max); return this; }
    intersectsBox(b) {
        return !(b.max.x < this.min.x || b.min.x > this.max.x || b.max.y < this.min.y || b.min.y > this.max.y || b.max.z < this.min.z || b.min.z > this.max.z);
    }
}
let narrowCalls = 0;
class Raycaster {
    constructor() { this.origin = new Vector3(); this.dir = new Vector3(); this.near = 0; this.far = Infinity; }
    set(o, d) { this.origin.copy(o); this.dir.copy(d); }
    intersectObjects(objs) {
        narrowCalls++;
        const out = [];
        objs.forEach((obj) => {
            const b = obj.userData.box;
            let t0 = this.near, t1 = this.far;
            for (const ax of ['x', 'y', 'z']) {
                const o = this.origin[ax], d = this.dir[ax];
                if (Math.abs(d) < 1e-9) { if (o < b.min[ax] || o > b.max[ax]) return; continue; }
                let ta = (b.min[ax] - o) / d, tb = (b.max[ax] - o) / d;
                if (ta > tb) [ta, tb] = [tb, ta];
                t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
                if (t0 > t1) return;
            }
            out.push({ distance: t0, point: this.origin.clone().addScaledVector(this.dir, t0), object: obj, face: null });
        });
        return out.sort((a, b) => a.distance - b.distance);
    }
}
THREE.Box3 = Box3;
THREE.Raycaster = Raycaster;
const wall = { userData: { box: { min: new Vector3(-20, 0, 30), max: new Vector3(20, 60, 34) } } };
global.obstacles = [wall];
const wallHit = R.predictRocketImpact(new Vector3(0, 20, 0), new Vector3(0, 0, 60), new Quaternion(), { fuze: 'impact' });
assert.strictEqual(wallHit.hitKind, 'building', 'Impact rocket should stop on building face');
assert(Math.abs(wallHit.impact.z - 30) < 0.01, 'Building impact should be on the wall face, got z=' + wallHit.impact.z);
assert(narrowCalls <= 2, 'Broadphase should skip open-air segments, narrow calls=' + narrowCalls);
global.obstacles = [];

console.log('rocket-fuze-smoke: PASS');
