// ============================================================================
// audit-bugs-regression-smoke.js — Regression checks for Critical/High/AI/Export
// audit bug fixes (C-1..C-3, H-1..H-6, M-1/M-4, L-1/L-2/L-4, AI-1..AI-3, EXP-1..2).
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function makeFakeTHREE() {
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
        dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
        distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
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
        lerp(v, a) {
            this.x += (v.x - this.x) * a;
            this.y += (v.y - this.y) * a;
            this.z += (v.z - this.z) * a;
            return this;
        }
        lerpVectors(a, b, t) {
            this.x = a.x + (b.x - a.x) * t;
            this.y = a.y + (b.y - a.y) * t;
            this.z = a.z + (b.z - a.z) * t;
            return this;
        }
    }
    class Quaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
        clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
        copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
        set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
        invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
        multiply(q) {
            const ax = this.x, ay = this.y, az = this.z, aw = this.w;
            const bx = q.x, by = q.y, bz = q.z, bw = q.w;
            this.x = ax * bw + aw * bx + ay * bz - az * by;
            this.y = ay * bw + aw * by + az * bx - ax * bz;
            this.z = az * bw + aw * bz + ax * by - ay * bx;
            this.w = aw * bw - ax * bx - ay * by - az * bz;
            return this;
        }
        setFromAxisAngle(axis, angle) {
            const half = angle * 0.5;
            const s = Math.sin(half);
            this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(half);
            return this;
        }
        setFromUnitVectors(a, b) {
            const dot = a.dot(b);
            if (dot > 0.9999) return this.set(0, 0, 0, 1);
            this.x = a.y * b.z - a.z * b.y;
            this.y = a.z * b.x - a.x * b.z;
            this.z = a.x * b.y - a.y * b.x;
            this.w = 1 + dot;
            const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
            this.x /= l; this.y /= l; this.z /= l; this.w /= l;
            return this;
        }
    }
    class Object3D {
        constructor() {
            this.position = new Vector3();
            this.quaternion = new Quaternion();
            this.userData = {};
        }
        rotateX(a) { this.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), a)); return this; }
        rotateY(a) { this.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a)); return this; }
        rotateZ(a) { this.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), a)); return this; }
        translateZ(d) { this.position.add(new Vector3(0, 0, d).applyQuaternion(this.quaternion)); return this; }
        updateMatrixWorld() {}
    }
    return { Vector3, Quaternion, Object3D };
}

const FakeTHREE = makeFakeTHREE();
global.THREE = FakeTHREE;
global.CONFIG = require(path.join(ROOT, 'js/core/config.js'));

// ----------------------------------------------------------------------------
// 1. [H-2] & [L-2] CONFIG.preview.groundStores defaults to false; HUD VT = 4.5m
// ----------------------------------------------------------------------------
assert.strictEqual(global.CONFIG.preview.groundStores, false, '[H-2] CONFIG.preview.groundStores must default to false');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
assert.ok(/ops-fuze-btn[\s\S]{0,200}4\.5m/.test(indexHtml), '[L-2] ops-fuze-btn title must match 4.5m VT radius');
assert.ok(!/ops-fuze-btn[\s\S]{0,200}近炸\s*6m/.test(indexHtml), '[L-2] stale 6m VT label must be removed');

// ----------------------------------------------------------------------------
// 2. [C-3] AirArenaGroundTargets.hydrate preserves destroyed/hp/hpMax
// ----------------------------------------------------------------------------
{
    const GT = require(path.join(ROOT, 'js/logic/ground-targets.js'));
    GT.hydrate([
        { id: 'gt_dead', name: 'Dead', x: 10, y: 0, z: 20, radius: 6, hp: 0, hpMax: 100, destroyed: true },
        { id: 'gt_hurt', name: 'Hurt', x: 30, y: 0, z: 40, radius: 6, hp: 35, hpMax: 100, destroyed: false }
    ]);
    const dead = GT.get('gt_dead');
    const hurt = GT.get('gt_hurt');
    assert.strictEqual(dead.hp, 0, '[C-3] dead ground target must keep hp=0');
    assert.strictEqual(dead.hpMax, 100, '[C-3] dead ground target must keep hpMax=100');
    assert.strictEqual(dead.destroyed, true, '[C-3] dead ground target must not resurrect');
    assert.strictEqual(hurt.hp, 35, '[C-3] hurt ground target must keep hp=35');
    assert.strictEqual(hurt.hpMax, 100, '[C-3] hurt ground target must keep hpMax=100');
    assert.strictEqual(hurt.destroyed, false, '[C-3] hurt ground target stays alive');
}

// ----------------------------------------------------------------------------
// 3. [C-1] & [M-1] Bomb non-lethal damage, kill attribution, hpTrack, low-alt dud
// ----------------------------------------------------------------------------
{
    const bombSrc = fs.readFileSync(path.join(ROOT, 'js/logic/bomb.js'), 'utf8');
    const hits = [];
    const sb = {
        window: {},
        THREE: FakeTHREE,
        CONFIG: global.CONFIG,
        teams: {
            red: {
                id: 'red', hp: 100, isDestroyed: false,
                wrapper: { position: new FakeTHREE.Vector3(100, 50, 0), quaternion: new FakeTHREE.Quaternion(), userData: {} },
                pathPoints: [new FakeTHREE.Vector3(100, 50, 0), new FakeTHREE.Vector3(100, 50, 10)],
                activeBombs: [{
                    pylonId: 1, ownerId: 'red', active: true, exploded: false,
                    launchStep: -1, ageSteps: 20,
                    pos: new FakeTHREE.Vector3(0, 0.05, 0),
                    vel: new FakeTHREE.Vector3(0, -30, 0),
                    quat: new FakeTHREE.Quaternion(),
                    mesh: null, trailPoints: []
                }]
            },
            blue: {
                id: 'blue', hp: 100, isDestroyed: false,
                wrapper: { position: new FakeTHREE.Vector3(2, 1, 0), quaternion: new FakeTHREE.Quaternion(), userData: {} },
                pathPoints: [new FakeTHREE.Vector3(2, 1, 0), new FakeTHREE.Vector3(2, 1, 0)],
                activeBombs: []
            }
        },
        scene: { remove() {}, add() {} },
        getPosAt: (r, pts) => pts[0].clone(),
        checkObstacleCollision: () => false,
        recordCombatHit: (ctx, vid, aid, w, step) => { hits.push({ vid, aid, w, step }); },
        combatActiveIds: () => ['red', 'blue'],
        console
    };
    vm.createContext(sb);
    vm.runInContext(bombSrc, sb);

    const ctx = {
        activeIds: ['red', 'blue'],
        turn: 1,
        hp: { red: 100, blue: 100 },
        destroyed: { red: false, blue: false },
        log: {
            red: { pts: [new FakeTHREE.Vector3(100, 50, 0)], damageTaken: 0, damageSteps: [] },
            blue: { pts: [new FakeTHREE.Vector3(2, 1, 0)], damageTaken: 0, damageSteps: [] },
            hpTrack: { red: [100], blue: [100] },
            vfxTriggers: [],
            redBombTracks: {},
            redBombExplodedAt: {},
            blueBombTracks: {},
            blueBombExplodedAt: {}
        }
    };
    sb.window.AirArenaBomb.resolveBombsForStep(0, 0, ctx);
    assert.strictEqual(ctx.hp.blue, 20, '[C-1] non-lethal bomb should reduce hp from 100 to 20');
    assert.strictEqual(ctx.log.blue.damageTaken, 80, '[C-1] non-lethal bomb must record damageTaken=80');
    assert.ok(ctx.log.blue.damageSteps.includes(0), '[C-1] bomb damageSteps must include step 0');
    assert.strictEqual(hits.length, 1, '[C-1] bomb must call recordCombatHit');
    assert.strictEqual(hits[0].vid, 'blue');
    assert.strictEqual(hits[0].aid, 'red');
    assert.strictEqual(hits[0].w, 'bomb');
    assert.strictEqual(ctx.log.weaponDamageDealt.red.bomb, 80, '[C-1] weaponDamageDealt.red.bomb must be 80');
    assert.strictEqual(ctx.log.hpTrack.blue.length, 1, '[C-1] bomb must not corrupt hpTrack length');

    // [M-1] Low-altitude ground hit before fuseDelay becomes a dud instead of falling underground
    const dudBomb = {
        pylonId: 2, ownerId: 'red', active: true, exploded: false,
        launchStep: 1, ageSteps: 0,
        pos: new FakeTHREE.Vector3(0, 0.05, 0),
        vel: new FakeTHREE.Vector3(0, -30, 0),
        quat: new FakeTHREE.Quaternion(),
        mesh: null, trailPoints: []
    };
    sb.teams.red.activeBombs = [dudBomb];
    sb.window.AirArenaBomb.resolveBombsForStep(1, 0.01, ctx);
    assert.strictEqual(dudBomb.exploded, true, '[M-1] low-alt dud bomb must mark exploded=true');
    assert.strictEqual(dudBomb.dud, true, '[M-1] low-alt dud bomb must mark dud=true');
}

// ----------------------------------------------------------------------------
// 4. [C-1] Rocket self-blast exclusion + non-lethal damage + recordCombatHit
// ----------------------------------------------------------------------------
{
    const rktSrc = fs.readFileSync(path.join(ROOT, 'js/logic/rocket.js'), 'utf8');
    const hits = [];
    const sb = {
        window: {},
        THREE: FakeTHREE,
        CONFIG: global.CONFIG,
        teams: {
            red: {
                id: 'red', hp: 100, isDestroyed: false, rocketShots: [],
                wrapper: { position: new FakeTHREE.Vector3(1.0, 40, 1.0), quaternion: new FakeTHREE.Quaternion(), userData: {} },
                pathPoints: [new FakeTHREE.Vector3(1.0, 40, 1.0), new FakeTHREE.Vector3(1.0, 40, 1.0)],
                activeRockets: [{
                    trackId: '1_0', pylonId: 1, ownerId: 'red', fuze: 'vt', active: true, exploded: false,
                    launchStep: -1, ageSteps: 12,
                    pos: new FakeTHREE.Vector3(0, 40, 0),
                    vel: new FakeTHREE.Vector3(0, 0, 10),
                    quat: new FakeTHREE.Quaternion(),
                    mesh: null, trailPoints: []
                }]
            },
            blue: {
                id: 'blue', hp: 100, isDestroyed: false,
                wrapper: { position: new FakeTHREE.Vector3(0.5, 40, 1.5), quaternion: new FakeTHREE.Quaternion(), userData: {} },
                pathPoints: [new FakeTHREE.Vector3(0.5, 40, 1.5), new FakeTHREE.Vector3(0.5, 40, 1.5)],
                activeRockets: []
            }
        },
        scene: { remove() {}, add() {} },
        getPosAt: (r, pts) => pts[0].clone(),
        checkObstacleCollision: () => false,
        recordCombatHit: (ctx, vid, aid, w, step) => { hits.push({ vid, aid, w, step }); },
        combatActiveIds: () => ['red', 'blue'],
        console
    };
    vm.createContext(sb);
    vm.runInContext(rktSrc, sb);

    const ctx = {
        activeIds: ['red', 'blue'],
        turn: 2,
        hp: { red: 100, blue: 100 },
        destroyed: { red: false, blue: false },
        log: {
            red: { pts: [], damageTaken: 0, damageSteps: [] },
            blue: { pts: [], damageTaken: 0, damageSteps: [] },
            hpTrack: { red: [100], blue: [100] },
            vfxTriggers: [],
            redRktTracks: {},
            redRktExplodedAt: {},
            blueRktTracks: {},
            blueRktExplodedAt: {}
        }
    };
    // Both red (shooter) and blue (target) are within blast radius of rocket
    sb.window.AirArenaRocket.resolveRocketsForStep(5, 0.05, ctx);
    assert.strictEqual(ctx.hp.red, 100, '[C-1] rocket VT must NOT self-damage shooter');
    assert.strictEqual(ctx.log.red.damageTaken, 0, '[C-1] shooter damageTaken must stay 0');
    assert.strictEqual(ctx.hp.blue, 78, '[C-1] rocket VT must deal 22 damage to enemy');
    assert.strictEqual(ctx.log.blue.damageTaken, 22, '[C-1] rocket must record blue damageTaken=22');
    assert.ok(ctx.log.blue.damageSteps.includes(5), '[C-1] rocket must push damage step');
    assert.strictEqual(hits.length, 1, '[C-1] rocket must call recordCombatHit once (enemy only)');
    assert.strictEqual(hits[0].vid, 'blue');
    assert.strictEqual(hits[0].w, 'rocket');
    assert.strictEqual(ctx.log.weaponDamageDealt.red.rocket, 22, '[C-1] weaponDamageDealt.red.rocket must be 22');
    assert.strictEqual(sb.teams.red.rocketShots.length, 1, '[C-1] rocketShots telemetry recorded');
}

// ----------------------------------------------------------------------------
// 5. [C-2] & [L-1] Turn-log serialize/hydrate flares, chaff, airspace, seatEndState
// ----------------------------------------------------------------------------
{
    const Ser = require(path.join(ROOT, 'js/core/turn-log-serialize.js'));
    const rawLog = {
        turn: 1,
        winner: null,
        destroyed: { red: false, blue: false },
        airspacePenalty: { red: 14, blue: 0 },
        airspaceOutsideHit: { red: true, blue: false },
        groundTargetHits: [{ id: 'gt_1', dmg: 50, destroyed: false }],
        groundTargetsState: [{ id: 'gt_1', hp: 50, hpMax: 100, destroyed: false }],
        seatEndState: { blue: { hp: 78, flareAmmo: 3, chaffAmmo: 4, rocketFuze: 'vt', pylons: [] } },
        weaponDamageDealt: { red: { gun: 0, fox1: 0, fox2: 0, rocket: 22, bomb: 0 } },
        globalChaffEnd: [{ owner: 'blue', pos: new FakeTHREE.Vector3(1, 2, 3), vel: new FakeTHREE.Vector3(4, 5, 6), life: 1.5 }],
        flaresTrack: [[{ pos: new FakeTHREE.Vector3(1, 40, 2), vel: new FakeTHREE.Vector3(-1, 0, -2), life: 2.5 }]],
        chaffTrack: [[{ pos: new FakeTHREE.Vector3(3, 40, 4), vel: new FakeTHREE.Vector3(1, 0, -1), life: 3.0 }]],
        red: {
            pts: [new FakeTHREE.Vector3(0, 40, 0), new FakeTHREE.Vector3(0, 40, 10)],
            quats: [new FakeTHREE.Quaternion(), new FakeTHREE.Quaternion()],
            damageTaken: 0,
            chain: [{ yaw: 0, pitch: 0, roll: 0, throttle: 4 }]
        }
    };
    const wire = JSON.parse(JSON.stringify(Ser.serializeTurnLog(rawLog)));
    const hyd = Ser.hydrateTurnLog(wire, FakeTHREE);
    assert.ok(hyd.flaresTrack[0][0].pos instanceof FakeTHREE.Vector3, '[C-2] flaresTrack.pos hydrated to Vector3');
    assert.ok(hyd.flaresTrack[0][0].vel instanceof FakeTHREE.Vector3, '[C-2] flaresTrack.vel hydrated to Vector3');
    assert.ok(hyd.chaffTrack[0][0].pos instanceof FakeTHREE.Vector3, '[C-2] chaffTrack.pos hydrated to Vector3');
    assert.ok(hyd.globalChaffEnd[0].pos instanceof FakeTHREE.Vector3, '[C-2] globalChaffEnd.pos hydrated to Vector3');
    assert.strictEqual(hyd.airspacePenalty.red, 14, '[L-1] airspacePenalty preserved');
    assert.strictEqual(hyd.airspaceOutsideHit.red, true, '[L-1] airspaceOutsideHit preserved');
    assert.strictEqual(hyd.groundTargetsState[0].hp, 50, '[C-2] groundTargetsState preserved');
    assert.strictEqual(hyd.seatEndState.blue.hp, 78, '[C-2] seatEndState preserved');
    assert.strictEqual(hyd.weaponDamageDealt.red.rocket, 22, '[C-2] weaponDamageDealt preserved');

    // [C-2] game.js playback does not gate on flightCurve
    const gameSrc = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
    assert.ok(!/teams\.red\.flightCurve\s*&&\s*teams\.blue\.flightCurve/.test(gameSrc), '[C-2] game.js must not gate combat playback on flightCurve');
}

// ----------------------------------------------------------------------------
// 6. [C-2] HostAuthority seat validation, Guest pendingTurnLogs queue, reconnect seat
// ----------------------------------------------------------------------------
{
    const haSrc = fs.readFileSync(path.join(ROOT, 'js/core/host-authority.js'), 'utf8');
    assert.ok(/intent\.seatId !== remoteSeatId/.test(haSrc), '[C-2] HostAuthority must validate intent.seatId === remoteSeatId');
    assert.ok(/pendingTurnLogs/.test(haSrc), '[C-2] HostAuthority must queue out-of-order turn logs on Guest');
    assert.ok(/sessionStorage\.getItem\('aa-net-seat'\)/.test(haSrc), '[C-2] tryReconnectAsync must read persisted seat from sessionStorage');
}

// ----------------------------------------------------------------------------
// 7. [H-1] replay-director.js uses kb.attackerId & does not freeze on already-dead unit in 2v2
// ----------------------------------------------------------------------------
{
    const RD = require(path.join(ROOT, 'js/view/replay-director.js'));
    const mkPt = (x, y, z) => new FakeTHREE.Vector3(x, y, z);
    const pts = (x0, z0, dz) => Array.from({ length: 101 }, (_, i) => mkPt(x0, 50, z0 + i * dz));
    const quats = () => Array.from({ length: 101 }, () => new FakeTHREE.Quaternion());
    const logT0 = {
        turn: 1,
        hpTrack: {
            red: Array(101).fill(100),
            red2: Array(101).fill(100),
            blue: Array(101).fill(100),
            blue2: Array(101).fill(100)
        },
        destroyed: { red: false, red2: false, blue: false, blue2: false },
        killedBy: {},
        red: { pts: pts(0, -50, 0.5), quats: quats() },
        red2: { pts: pts(-30, -50, 0.5), quats: quats() },
        blue: { pts: pts(0, 0, 0.35), quats: quats() },
        blue2: { pts: pts(40, 0, 0.35), quats: quats() },
        vfxTriggers: []
    };
    const logT1 = {
        turn: 2,
        hpTrack: {
            red: Array(101).fill(100),
            red2: Array(101).fill(100),
            blue: Array.from({ length: 101 }, (_, i) => (i < 60 ? 100 : 0)),
            blue2: Array(101).fill(100)
        },
        destroyed: { red: false, red2: false, blue: true, blue2: false },
        killedBy: { blue: { attackerId: 'red', weapon: 'gun', step: 60 } },
        red: { pts: pts(0, 0, 1), quats: quats() },
        red2: { pts: pts(-30, 0, 1), quats: quats() },
        blue: { pts: pts(0, 35, 0.5), quats: quats() },
        blue2: { pts: pts(40, 35, 0.5), quats: quats() },
        vfxTriggers: []
    };
    const logT2 = {
        turn: 3,
        hpTrack: {
            red: Array(101).fill(100),
            red2: Array(101).fill(100),
            blue: Array(101).fill(0),
            blue2: Array(101).fill(100)
        },
        destroyed: { red: false, red2: false, blue: true, blue2: false },
        killedBy: {},
        red: { pts: pts(0, 100, 1), quats: quats() },
        red2: { pts: pts(-30, 100, 1), quats: quats() },
        blue: { pts: [], quats: [] },
        blue2: { pts: pts(40, 85, 0.5), quats: quats() },
        vfxTriggers: []
    };
    const sb2v2 = RD.analyzeTimeline([logT0, logT1, logT2]);
    const killShotT2 = RD.getShotAt(sb2v2, 2.60);
    assert.strictEqual(killShotT2.reason, 'kill_gun', '[H-1] kill_gun must resolve kb.attackerId');
    assert.strictEqual(killShotT2.primaryId, 'red', '[H-1] kill_gun primaryId must be attackerId (red)');
    assert.strictEqual(killShotT2.secondaryId, 'blue', '[H-1] kill_gun secondaryId must be victim (blue)');

    const t3Shots = sb2v2.shots.filter((s) => s.startTime >= 3.0 - 1e-6);
    assert.ok(t3Shots.length >= 1, '[H-1] turn 3 must produce valid camera shots');
    assert.ok(!t3Shots.some((s) => s.reason === 'kill_crash' && s.primaryId === 'blue'), '[H-1] turn 3 must not re-trigger kill_crash for already-dead blue');
    assert.ok(t3Shots.some((s) => s.primaryId !== 'blue'), '[H-1] turn 3 must keep tracking living aircraft');
}

// ----------------------------------------------------------------------------
// 8. [H-5] Independent per-layer PRNG in ground-explosion-vfx.js & autocannon-vfx.js
// ----------------------------------------------------------------------------
{
    const gVfxSrc = fs.readFileSync(path.join(ROOT, 'js/view/ground-explosion-vfx.js'), 'utf8');
    const aVfxSrc = fs.readFileSync(path.join(ROOT, 'js/view/autocannon-vfx.js'), 'utf8');
    assert.ok(/mulberry32\(\(\w+ \^ 0x/i.test(gVfxSrc), '[H-5] ground-explosion-vfx must derive independent per-layer PRNGs');
    assert.ok(/mulberry32\(\(\w+ \^ 0x/i.test(aVfxSrc), '[H-5] autocannon-vfx must derive independent per-layer PRNGs');
}

// ----------------------------------------------------------------------------
// 9. [H-6] Complete rematch reset in state-machine-match.js
// ----------------------------------------------------------------------------
{
    const smMatchSrc = fs.readFileSync(path.join(ROOT, 'js/core/state-machine-match.js'), 'utf8');
    for (const field of ['t.ap =', 't.heat =', 't.stalled = false', 't.flareAmmo =', 't.chaffAmmo =', 't.lockedTargetId = null', 't.fox2LaunchCommit = null', 't.activeRockets = []', 't.activeBombs = []']) {
        assert.ok(smMatchSrc.includes(field), `[H-6] setUnitActive must reset ${field}`);
    }
}

// ----------------------------------------------------------------------------
// 10. [M-4] physics.js simulateFlight must not coerce ap=0 to 120
// ----------------------------------------------------------------------------
{
    const physSrc = fs.readFileSync(path.join(ROOT, 'js/logic/physics.js'), 'utf8');
    const sb = {
        THREE: FakeTHREE,
        CONFIG: global.CONFIG,
        MAX_AP: (global.CONFIG.rules && global.CONFIG.rules.maxAp) || 240,
        STALL_AP: (global.CONFIG.rules && global.CONFIG.rules.stallAp) || 60,
        console
    };
    vm.createContext(sb);
    vm.runInContext(physSrc, sb);
    const zeroApTeam = {
        type: 'mig21',
        ap: 0,
        throttle: 0,
        wrapper: {
            position: new FakeTHREE.Vector3(0, 60, 0),
            quaternion: new FakeTHREE.Quaternion(),
            userData: { logicalQuat: new FakeTHREE.Quaternion() }
        }
    };
    const resZero = sb.simulateFlight(zeroApTeam, [{ yaw: 0, pitch: 0, roll: 0, throttle: 0 }]);
    const resNormal = sb.simulateFlight(Object.assign({}, zeroApTeam, { ap: 120 }), [{ yaw: 0, pitch: 0, roll: 0, throttle: 0 }]);
    assert.ok(resZero.finalAP < resNormal.finalAP - 40, '[M-4] ap=0 must not be coerced to 120 in simulateFlight');
}

// ----------------------------------------------------------------------------
// 11. [L-4] & [AI-3] withRocketFuze preserves undefined; missileOutOfEnvelope opens VT window
// ----------------------------------------------------------------------------
{
    const Doc = require(path.join(ROOT, 'js/ai/a2g-stores-doctrine.js'));
    const tNoFuze = {
        id: 'red',
        pylons: [{ id: 1, weaponType: 'rocket', state: 'standby', ammo: 9, ammoMax: 9 }],
        wrapper: { position: new FakeTHREE.Vector3(0, 40, 0), quaternion: new FakeTHREE.Quaternion() }
    };
    global.AirArenaRocket = {
        ensurePodAmmo: (p) => Math.max(0, Number(p.ammo) || 0),
        setTeamFuzeMode: (t, f) => { t.rocketFuze = f; return f; },
        computeRocketAimSolution: () => ({ fuze: 'vt', cpaDist: 1.5, slantDist: 60, aimWorld: new FakeTHREE.Vector3(0, 40, 60) })
    };
    Doc.evaluateRocketVtShot(tNoFuze, { wrapper: { position: new FakeTHREE.Vector3(0, 40, 60) } }, { distance: 60, angleDeg: 14, localZ: 0.97 });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(tNoFuze, 'rocketFuze'), false, '[L-4] withRocketFuze must not leave rocketFuze="vt" when originally undefined');

    // [AI-3] FOX-2 launch angle cap is 10 deg (4 deg front-aspect): 14 deg is out-of-envelope for FOX-2
    assert.strictEqual(Doc.missileOutOfEnvelope({
        distance: 60, angleDeg: 14, missileMinRange: 20, missileMaxRange: 120, aiMissileType: 'fox2'
    }), true, '[AI-3] 14 deg off-boresight is out of FOX-2 envelope (allows VT rocket)');
    assert.strictEqual(Doc.missileOutOfEnvelope({
        distance: 60, angleDeg: 10, missileMinRange: 20, missileMaxRange: 120, aiMissileType: 'fox2'
    }), false, '[AI-3] 10 deg non-front-aspect stays in FOX-2 envelope');
    assert.strictEqual(Doc.missileOutOfEnvelope({
        distance: 60, angleDeg: 6, missileMinRange: 20, missileMaxRange: 120, aiMissileType: 'fox2', frontAspect: true
    }), true, '[AI-3] 6 deg front-aspect exceeds 4 deg FOX-2 cap');
    assert.strictEqual(Doc.missileOutOfEnvelope({
        distance: 60, angleDeg: 5, missileMinRange: 20, missileMaxRange: 120, fox2LaunchHold: true
    }), true, '[AI-3] fox2LaunchHold opens VT window');
}

// ----------------------------------------------------------------------------
// 12. [AI-1] [AI-2] [H-3] pilot-ai.js structural guards + planned trajectory
// ----------------------------------------------------------------------------
{
    const aiSrc = fs.readFileSync(path.join(ROOT, 'js/ai/pilot-ai.js'), 'utf8');
    assert.ok(/isFoxPylonEarly\(p\) && p\.state === 'armed'/.test(aiSrc), '[AI-1] pilot-ai must exclude bomb/rocket from hasArmedMissile');
    assert.ok(/else if \(safeAction\.queueAction === 'missile' && ownMissileType !== 'fox1'\)/.test(aiSrc), '[AI-2] pilot-ai must run gateFox2MissileShoot on FOX-2-only aircraft');
    assert.ok(/buildPlannedTeamForStores\s*\(/.test(aiSrc), '[H-3] pilot-ai must simulate planned maneuver before stores doctrine');
}

// ----------------------------------------------------------------------------
// 13. [EXP-1] & [EXP-2] batch-ai-run.js loadout detection + ui.js flare counter separation
// ----------------------------------------------------------------------------
{
    const Batch = require(path.join(ROOT, 'js/core/batch-ai-run.js'));
    assert.deepStrictEqual(Batch.pylonsForLoadout('fox2-rocket'), ['rocket', 'fox2', 'fox2', 'rocket'], '[EXP-2] fox2-rocket loadout preset');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'js/view/ui.js'), 'utf8');
    assert.ok(/flare:\s*\(action\.queueAction === 'flare'/.test(uiSrc), '[EXP-1] ui.js frame.flare must require queueAction === flare');
    assert.ok(/flareRequested:/.test(uiSrc), '[EXP-1] ui.js must separate flareRequested from actual flare');
    assert.ok(/rocketShots:/.test(uiSrc) && /damageDealtByWeapon:/.test(uiSrc) && /winner,/.test(uiSrc), '[EXP-2] ui.js roster export must include rocketShots, damageDealtByWeapon, winner');
}

console.log('audit-bugs-regression-smoke: PASS (13/13 groups)');
