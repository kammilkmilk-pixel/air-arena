#!/usr/bin/env node
// ============================================================================
// bezier-path-smoke.js — C1 cubic Bézier flight-path sampling + AI retune guards
// Run: node tools/bezier-path-smoke.js
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.lengthSq()); }
    normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    lerp(v, a) {
        this.x += (v.x - this.x) * a;
        this.y += (v.y - this.y) * a;
        this.z += (v.z - this.z) * a;
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
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
}

const THREE = { Vector3, Quaternion, Object3D: function Object3D() { this.position = new Vector3(); this.quaternion = new Quaternion(); } };
const sandbox = { THREE, MAX_AP: 300, console, Math };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/logic/physics.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/logic/gun-ballistics.js'), 'utf8'), sandbox);

const {
    getPosAt, getPathTangentAt, evalFlightPathPos, evalFlightPathTangent,
    evalFlightPathPosAcrossTurns
} = sandbox;
const B = sandbox.AirArenaGunBallistics;

function yawQuat(rad) {
    const h = rad * 0.5;
    return new Quaternion(0, Math.sin(h), 0, Math.cos(h));
}

function headingOf(q) {
    return new Vector3(0, 0, 1).applyQuaternion(q).normalize();
}

function finiteDiff(t, pts, quats) {
    const dt = 0.002;
    const a = getPosAt(Math.max(0, t - dt), pts, quats);
    const b = getPosAt(Math.min(1, t + dt), pts, quats);
    return b.sub(a).normalize();
}

// ----------------------------------------------------------------------------
// 1. Two-point, no quats: still the old linear splice (regression for sparse tests)
// ----------------------------------------------------------------------------
{
    const pts = [new Vector3(0, 10, 0), new Vector3(10, 10, 0)];
    const mid = getPosAt(0.5, pts);
    assert.ok(Math.abs(mid.x - 5) < 1e-6 && Math.abs(mid.z) < 1e-6, '2-pt no-quat stays linear');
}

// ----------------------------------------------------------------------------
// 2. Heading-aligned cubic Bézier at turn start: tangent matches incoming heading,
//    not the first polyline chord (the kink the old lerp produced).
// ----------------------------------------------------------------------------
{
    const q0 = yawQuat(0); // +Z
    const q1 = yawQuat(-Math.PI / 2); // +X
    const pts = [
        new Vector3(0, 50, 0),
        new Vector3(2.2, 50, 0.35),
        new Vector3(5.0, 50, 0.45),
        new Vector3(8.5, 50, 0.40)
    ];
    const quats = [q0, q1, q1, q1];
    const tan0 = finiteDiff(0.0005, pts, quats);
    const head0 = headingOf(q0);
    const chord = pts[1].clone().sub(pts[0]).normalize();
    assert.ok(tan0.dot(head0) > 0.97, `t=0 Bézier tangent must match heading (dot=${tan0.dot(head0).toFixed(3)})`);
    assert.ok(chord.dot(head0) < 0.85, 'sanity: first chord is NOT aligned with heading (the old kink)');
}

// ----------------------------------------------------------------------------
// 3. Interior C1: left/right finite-diff tangents agree at a sample
// ----------------------------------------------------------------------------
{
    const pts = [];
    const quats = [];
    for (let i = 0; i < 9; i++) {
        const yaw = -0.18 * i;
        quats.push(yawQuat(yaw));
        const h = headingOf(quats[i]);
        if (i === 0) pts.push(new Vector3(0, 40, 0));
        else pts.push(pts[i - 1].clone().add(h.multiplyScalar(1.4)));
    }
    const t = 4 / 8;
    const left = finiteDiff(t - 0.004, pts, quats);
    const right = finiteDiff(t + 0.004, pts, quats);
    assert.ok(left.dot(right) > 0.985, `interior C1 (dot=${left.dot(right).toFixed(4)})`);
}

// ----------------------------------------------------------------------------
// 4. Cross-turn junction: heading C1 across integer u
// ----------------------------------------------------------------------------
{
    const qId = yawQuat(0);
    const turnA = {
        pts: [new Vector3(0, 40, 0), new Vector3(0, 40, 4), new Vector3(0, 40, 8)],
        quats: [qId, qId, qId]
    };
    const qTurn = yawQuat(-0.7);
    const turnB = {
        pts: [new Vector3(0, 40, 8), new Vector3(1.6, 40, 8.4), new Vector3(3.8, 40, 8.6)],
        quats: [qId, qTurn, qTurn]
    };
    const logs = [turnA, turnB];
    const p0 = new Vector3();
    const p1 = new Vector3();
    evalFlightPathPosAcrossTurns(logs, 0.97, 0.08, p0);
    evalFlightPathPosAcrossTurns(logs, 1.03, 0.08, p1);
    const joinTan = p1.clone().sub(p0).normalize();
    const head = headingOf(qId);
    assert.ok(joinTan.dot(head) > 0.92, `cross-turn Bézier keeps +Z heading (dot=${joinTan.dot(head).toFixed(3)})`);
}

// ----------------------------------------------------------------------------
// 5. samplePosAt matches getPosAt (preview gun / combat / ribbon)
// ----------------------------------------------------------------------------
{
    const pts = [new Vector3(0, 20, 0), new Vector3(0, 20, 3), new Vector3(1, 20, 6)];
    const quats = [yawQuat(0), yawQuat(-0.2), yawQuat(-0.4)];
    const a = getPosAt(0.37, pts, quats);
    const b = new Vector3();
    B.samplePosAt(0.37, pts, b, quats);
    assert.ok(a.distanceTo(b) < 1e-8, 'samplePosAt matches getPosAt');
    const vel = new Vector3();
    B.sampleAircraftVelocity(0.37, pts, vel, new Vector3(), new Vector3(), quats);
    assert.ok(vel.length() > 0.5, 'Bézier aircraft velocity is non-zero on a moving path');
}

// ----------------------------------------------------------------------------
// 6. Source guards: Bézier in sampler, ribbons, AI; no HUD / ground-target hide
// ----------------------------------------------------------------------------
{
    const physicsSrc = fs.readFileSync(path.join(ROOT, 'js/logic/physics.js'), 'utf8');
    assert.ok(/function evalFlightPathPos/.test(physicsSrc), 'evalFlightPathPos present');
    assert.ok(/function getPosAt\(t, points, quats\)/.test(physicsSrc), 'getPosAt accepts quats');
    assert.ok(!/return points\[idx\]\.clone\(\)\.lerp\(points\[idx \+ 1\], p - idx\);/.test(physicsSrc),
        'old linear splice must not be the getPosAt body');

    const renderSrc = fs.readFileSync(path.join(ROOT, 'js/view/render.js'), 'utf8');
    assert.ok(/getPosAt\(t, pathPoints, pathQuats\)/.test(renderSrc), 'preview ribbon samples Bézier with quats');
    assert.ok(/getPosAt\(animProgress, currentLog\[id\]\.pts, currentLog\[id\]\.quats\)/.test(renderSrc),
        'executed playback samples the same Bézier');

    const condSrc = fs.readFileSync(path.join(ROOT, 'js/view/condensation-vfx.js'), 'utf8');
    assert.ok(/evalFlightPathPosAcrossTurns\(battleLog, u, 0\.08, outPos, id\)/.test(condSrc),
        'wake ribbon uses cross-turn Bézier');

    const aiSrc = fs.readFileSync(path.join(ROOT, 'js/ai/pilot-ai.js'), 'utf8');
    assert.ok(/getPosAt\(ratio, pts, quats\)/.test(aiSrc), 'gun intercept flies the Bézier path');
    assert.ok(/framesToImpact \/ 17\.4/.test(aiSrc), 'gun LCOS retuned for Bézier lag');
    assert.ok(/Bézier fillet sits inside the polyline chord/.test(aiSrc), 'safety filter probes Bézier midpoint');
    assert.ok(/predictLeadTurns: 1\.14/.test(aiSrc),
        'FOX-2 predict lead retuned for Bézier');

    const gtSrc = fs.readFileSync(path.join(ROOT, 'js/logic/ground-targets.js'), 'utf8');
    const hudSrc = fs.readFileSync(path.join(ROOT, 'js/view/hud.js'), 'utf8');
    assert.ok(gtSrc.length > 100, 'ground-targets.js untouched length');
    assert.ok(hudSrc.length > 100, 'hud.js not emptied');
}

console.log('bezier-path-smoke: PASS (6/6 groups)');
