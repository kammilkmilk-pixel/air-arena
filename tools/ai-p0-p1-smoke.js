#!/usr/bin/env node
// ============================================================================
// ai-p0-p1-smoke.js — Regression tests for AI Pilot Optimization P0 + P1
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { spawnSync } = require('child_process');
const os = require('os');

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
        divideScalar(s) { const inv = s ? (1 / s) : 0; this.x *= inv; this.y *= inv; this.z *= inv; return this; }
        negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
        lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
        length() { return Math.sqrt(this.lengthSq()); }
        normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
        dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
        crossVectors(a, b) {
            const ax = a.x, ay = a.y, az = a.z;
            const bx = b.x, by = b.y, bz = b.z;
            this.x = ay * bz - az * by;
            this.y = az * bx - ax * bz;
            this.z = ax * by - ay * bx;
            return this;
        }
        distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
        angleTo(v) {
            const denom = Math.sqrt(this.lengthSq() * v.lengthSq());
            if (!denom) return Math.PI / 2;
            const theta = Math.max(-1, Math.min(1, this.dot(v) / denom));
            return Math.acos(theta);
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
        lerp(v, a) {
            this.x += (v.x - this.x) * a;
            this.y += (v.y - this.y) * a;
            this.z += (v.z - this.z) * a;
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
        slerp(qb, t) {
            const out = this.clone();
            out.x += (qb.x - out.x) * t;
            out.y += (qb.y - out.y) * t;
            out.z += (qb.z - out.z) * t;
            out.w += (qb.w - out.w) * t;
            const l = Math.hypot(out.x, out.y, out.z, out.w) || 1;
            out.x /= l; out.y /= l; out.z /= l; out.w /= l;
            return this.copy(out);
        }
    }
    class Box3 {
        constructor(min = new Vector3(), max = new Vector3()) { this.min = min; this.max = max; }
        copy(b) { this.min.copy(b.min); this.max.copy(b.max); return this; }
        setFromObject(obj) {
            if (obj && obj._box) {
                this.min.copy(obj._box.min);
                this.max.copy(obj._box.max);
            }
            return this;
        }
        clampPoint(pt, out) {
            out.x = Math.max(this.min.x, Math.min(this.max.x, pt.x));
            out.y = Math.max(this.min.y, Math.min(this.max.y, pt.y));
            out.z = Math.max(this.min.z, Math.min(this.max.z, pt.z));
            return out;
        }
        containsPoint(pt) {
            return pt.x >= this.min.x && pt.x <= this.max.x
                && pt.y >= this.min.y && pt.y <= this.max.y
                && pt.z >= this.min.z && pt.z <= this.max.z;
        }
    }
    class Raycaster {
        constructor(origin = new Vector3(), dir = new Vector3(0, 0, 1), near = 0, far = Infinity) {
            this.origin = origin.clone();
            this.dir = dir.clone();
            this.near = near;
            this.far = far;
        }
        set(origin, dir) { this.origin = origin.clone(); this.dir = dir.clone(); }
        intersectObjects(objs) {
            const hits = [];
            for (const o of (objs || [])) {
                const b = o && o._box;
                if (!b) continue;
                let tmin = this.near;
                let tmax = this.far;
                let hit = true;
                for (const ax of ['x', 'y', 'z']) {
                    const d = this.dir[ax];
                    const ro = this.origin[ax];
                    if (Math.abs(d) < 1e-8) {
                        if (ro < b.min[ax] || ro > b.max[ax]) { hit = false; break; }
                    } else {
                        let t1 = (b.min[ax] - ro) / d;
                        let t2 = (b.max[ax] - ro) / d;
                        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
                        tmin = Math.max(tmin, t1);
                        tmax = Math.min(tmax, t2);
                        if (tmin > tmax) { hit = false; break; }
                    }
                }
                if (hit && tmin >= this.near && tmin <= this.far) {
                    hits.push({ distance: tmin, object: o });
                }
            }
            hits.sort((a, b) => a.distance - b.distance);
            return hits;
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
    }
    return { Vector3, Quaternion, Box3, Raycaster, Object3D };
}

const FakeTHREE = makeFakeTHREE();
const CONFIG = require(path.join(ROOT, 'js/core/config.js'));
const BuildingRisk = require(path.join(ROOT, 'js/ai/building-risk.js'));
const StoresDoc = require(path.join(ROOT, 'js/ai/a2g-stores-doctrine.js'));

function loadAIHarness(initialTeams = {}, initialObstacles = []) {
    const physSrc = fs.readFileSync(path.join(ROOT, 'js/logic/physics.js'), 'utf8');
    const aiSrc = fs.readFileSync(path.join(ROOT, 'js/ai/pilot-ai.js'), 'utf8');
    const applied = [];
    const sb = {
        window: {},
        THREE: FakeTHREE,
        CONFIG,
        MAX_AP: (CONFIG.rules && CONFIG.rules.maxAp) || 240,
        STALL_AP: (CONFIG.rules && CONFIG.rules.stallAp) || 60,
        GUN_RANGE: (CONFIG.weapons && CONFIG.weapons.gun && CONFIG.weapons.gun.range) || 35,
        GUN_ANGLE: Math.PI / 12,
        AirArenaBuildingRisk: BuildingRisk,
        AirArenaA2GStoresDoctrine: StoresDoc,
        getEngineHeatLevel: (h) => Number(h) || 0,
        obstacles: initialObstacles,
        GameContext: {
            state: { currentTurn: 10, phase: 'planning', arenaMode: 'dense-urban' },
            getTeam: (id) => initialTeams[id] || null,
            getFaction: (id) => (String(id).startsWith('blue') ? 'blue' : 'red'),
            getLivingTeamIds: () => Object.keys(initialTeams).filter((k) => initialTeams[k] && !initialTeams[k].isDestroyed),
            getRosterIds: () => Object.keys(initialTeams),
            getArenaMode: () => 'dense-urban',
            getSerializableBattleState: () => ({ currentTurn: 10, teams: {} }),
            stateMachine: {
                applyPilotAction: (id, act) => { applied.push({ id, act }); }
            }
        },
        console
    };
    sb.window = sb;
    vm.createContext(sb);
    vm.runInContext(physSrc, sb);
    vm.runInContext(aiSrc, sb);
    const AI = sb.AirArenaAI;
    AI.getObstacles = () => sb.obstacles;
    AI.fillObstacleWorldBox = (obs, box) => box.setFromObject(obs);
    return { AI, sb, applied };
}

function makeTeam(id, pos, yawRad, opts = {}) {
    const q = new FakeTHREE.Quaternion().setFromAxisAngle(new FakeTHREE.Vector3(0, 1, 0), yawRad);
    return {
        id,
        type: 'mig21',
        hp: opts.hp != null ? opts.hp : 100,
        ap: opts.ap != null ? opts.ap : 150,
        throttle: opts.throttle != null ? opts.throttle : 4,
        heat: opts.heat != null ? opts.heat : 20,
        stalled: !!opts.stalled,
        isDestroyed: false,
        matchActive: true,
        ready: !!opts.ready,
        pylons: opts.pylons || [],
        wrapper: {
            position: new FakeTHREE.Vector3(pos[0], pos[1], pos[2]),
            quaternion: q.clone(),
            userData: { logicalQuat: q.clone() }
        },
        pathPoints: opts.pathPoints || null,
        pathQuats: opts.pathQuats || null
    };
}

function makeBoxObs(minArr, maxArr) {
    return {
        _box: new FakeTHREE.Box3(
            new FakeTHREE.Vector3(minArr[0], minArr[1], minArr[2]),
            new FakeTHREE.Vector3(maxArr[0], maxArr[1], maxArr[2])
        )
    };
}

// ============================================================================
// 1. P0-1: Open-sky besideTall (headroom >= 20m) not capped as undercroft + closing-rate abort
// ============================================================================
{
    const teams = {
        red: makeTeam('red', [0, 50, 0], 0, { ap: 200 }),
        blue: makeTeam('blue', [0, 50, 100], Math.PI, { ap: 150 })
    };
    const { AI } = loadAIHarness(teams, []);
    const coverOpenSkyBesideTall = {
        distance: 14,
        roofClearance: -12,
        headroom: 48,
        forwardDistance: 12,
        collisionRisk: 'medium',
        hardChokeKind: null
    };
    assert.strictEqual(
        AI.wantsTableEscapeStickOwner(coverOpenSkyBesideTall, {
            altitude: 50, forwardY: -0.05, teamId: 'red', turnNo: 10
        }),
        false,
        '[P0-1] Open-sky besideTall (headroom=48m) must NOT be claimed by tableStickOwner'
    );

    const climbAct = AI.buildNavClimbOutAction({
        altitude: 50,
        forwardY: -0.05,
        heat: 20,
        side: 1,
        targetAlt: 65,
        source: 'climbOut',
        coverInfo: coverOpenSkyBesideTall,
        teamId: 'red',
        turnNo: 10
    });
    assert.ok(climbAct.joyY >= 0.5, `[P0-1] Open-sky besideTall joyY must be >= 0.5 (got ${climbAct.joyY})`);
    assert.strictEqual(climbAct.throttle, 2, '[P0-1] High-AP close facade must decelerate (thr=2) to tighten turn radius');
    assert.ok(Math.abs(climbAct.joyX) >= 0.78, `[P0-1] High-AP close facade must turn firmly (got |joyX|=${Math.abs(climbAct.joyX)})`);

    // Closing-rate abort: 2 consecutive drops > 3m/turn with final coverDist < 16m
    AI.glueEscapeMemory.red = { side: 1, untilTurn: 20, source: 't38' };
    AI.noteCoverDistHistory('red', 23, 11);
    AI.noteCoverDistHistory('red', 17, 12);
    const abortRes = AI.noteCoverDistHistory('red', 11, 13);
    assert.strictEqual(abortRes.closingAbort, true, '[P0-1] 2 consecutive >3m/turn drops with cov<16 must trigger closingAbort');
    assert.strictEqual(AI.getGlueEscapeLock('red', 13).active, false, '[P0-1] closingAbort must clear glueEscapeLock');
    assert.strictEqual(AI.isCoverClosingAbortActive('red', 13), true, '[P0-1] isCoverClosingAbortActive must report true');

    // Structural check: glueLock & airspaceRimProtect must check !originalEval.buildingHit
    const aiSrc = fs.readFileSync(path.join(ROOT, 'js/ai/pilot-ai.js'), 'utf8');
    assert.ok(
        /glueLock\.active\s*&&\s*!action\.pullOver\s*&&\s*!originalEval\.buildingHit\s*&&\s*!originalEval\.twoTurnBuildingHit/.test(aiSrc),
        '[P0-1] glueLock must not bypass safetyFilter on buildingHit or twoTurnBuildingHit'
    );
    assert.ok(
        /action\.state === 'airspaceAvoid'\s*&&\s*action\.airspaceRimProtect\s*&&\s*!originalEval\.buildingHit\s*&&\s*!originalEval\.twoTurnBuildingHit/.test(aiSrc),
        '[P0-1] airspaceRimProtect must not bypass safetyFilter on buildingHit or twoTurnBuildingHit'
    );
}

// ============================================================================
// 2. P0-2: FAR 91.113(e) head-on same-sign right-turn + deterministic vertical split
// ============================================================================
{
    const { AI } = loadAIHarness();
    const redSide = AI.getMidairDivergeSide({ faction: 'red', teamId: 'red', headOnFactor: 0.95, localToEnemy: { x: 0.02 } });
    const blueSide = AI.getMidairDivergeSide({ faction: 'blue', teamId: 'blue', headOnFactor: 0.95, localToEnemy: { x: -0.02 } });
    assert.strictEqual(redSide, 1, '[P0-2] Head-on red must turn RIGHT (+1 body frame)');
    assert.strictEqual(blueSide, 1, '[P0-2] Head-on blue must ALSO turn RIGHT (+1 body frame) so world trajectories diverge');

    const redBreak = AI.buildCloseMidairBreakAction({
        distance: 10, altitude: 50, forwardY: 0, headOnFactor: 0.95,
        localToEnemy: { x: 0 }, faction: 'red', teamId: 'red', turnNo: 10, heat: 20, ap: 150
    });
    const blueBreak = AI.buildCloseMidairBreakAction({
        distance: 10, altitude: 50, forwardY: 0, headOnFactor: 0.95,
        localToEnemy: { x: 0 }, faction: 'blue', teamId: 'blue', turnNo: 10, heat: 20, ap: 150
    });
    assert.ok(redBreak.joyX > 0 && blueBreak.joyX > 0, '[P0-2] Both head-on jets must bank same body-frame direction (+joyX)');
    assert.ok(redBreak.joyY >= 0.25 && blueBreak.joyY <= -0.15, `[P0-2] Deterministic vertical split: red=${redBreak.joyY}, blue=${blueBreak.joyY}`);

    const lowBlueBreak = AI.buildCloseMidairBreakAction({
        distance: 10, altitude: 20, forwardY: 0, headOnFactor: 0.95,
        localToEnemy: { x: 0 }, faction: 'blue', teamId: 'blue', turnNo: 10, heat: 20, ap: 150
    });
    assert.ok(lowBlueBreak.joyY > 0, '[P0-2] Low-altitude blue (<25m) must NOT descend into terrain');
}

// ============================================================================
// 3. P0-3: Active stall (AP < 45 or stalled) forces throttle = 5 even when hot
// ============================================================================
{
    const { AI } = loadAIHarness();
    const stalledEnergy = { state: 'energyRecover', throttle: 3, joyX: 0.15, joyY: -0.25 };
    AI.enforceEnergyTurnConsistency(stalledEnergy, { heat: 85, ap: 12, stalled: true, energyCritical: true, lowAp: 65 });
    assert.strictEqual(stalledEnergy.throttle, 5, '[P0-3] enforceEnergyTurnConsistency must force thr=5 on active stall');

    const bandAct = { state: 'energyRecover', throttle: 5, joyX: 0.15, joyY: 0.1 };
    AI.adjustActionForCombatBand(bandAct, 45, { collisionRisk: 'low' }, AI.getTuning(), 0.25, 18);
    assert.strictEqual(bandAct.throttle, 5, '[P0-3] adjustActionForCombatBand must keep thr=5 when AP < 45');
}

// ============================================================================
// 4. P0-4: WEGO simultaneous planning (no enemy.queuedAction peeking + deferred plan)
// ============================================================================
{
    const aiSrc = fs.readFileSync(path.join(ROOT, 'js/ai/pilot-ai.js'), 'utf8');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'js/view/ui.js'), 'utf8');
    assert.ok(!/enemy\.queuedAction\s*===\s*'missile'/.test(aiSrc), '[P0-4] pilot-ai must not peek at enemy.queuedAction === missile');
    assert.ok(/const enemyMissileQueued = false;/.test(aiSrc), '[P0-4] enemyMissileQueued must be false');
    assert.ok(/plan\(teamId,\s*battleState/.test(aiSrc), '[P0-4] pilot-ai must expose plan(teamId, battleState)');
    assert.ok(/turnStartSnapshot/.test(uiSrc) && /uiCommitAIAction/.test(uiSrc), '[P0-4] ui.js must snapshot turn-start state and batch-commit AI actions');
}

// ============================================================================
// 5. P0-5: Turn-limit game_over sets GameContext.state.phase + midair death tracking
// ============================================================================
{
    const ctSrc = fs.readFileSync(path.join(ROOT, 'js/logic/combat-turn.js'), 'utf8');
    const gameOverMatches = ctSrc.match(/GameContext\.state\.phase\s*=\s*'game_over'/g) || [];
    assert.ok(gameOverMatches.length >= 2, '[P0-5] combat-turn.js must set GameContext.state.phase = game_over on both elimination and turn_limit');

    const tmpDump = path.join(os.tmpdir(), `air-arena-midair-smoke-${Date.now()}.json`);
    fs.writeFileSync(tmpDump, JSON.stringify({
        turn: 150,
        arenaMode: 'dense-urban',
        matchMode: '2v2',
        winner: 'draw',
        endReason: 'turn_limit',
        rosterSummary: [
            { id: 'red', isDestroyed: true, deathCause: 'midair' },
            { id: 'blue', isDestroyed: true, deathCause: 'midair' },
            { id: 'red2', isDestroyed: false, deathCause: null },
            { id: 'blue2', isDestroyed: false, deathCause: null }
        ],
        units: {}
    }));
    const res = spawnSync(process.execPath, [path.join(ROOT, 'tools/weapon-efficiency-dump.js'), tmpDump], { encoding: 'utf8' });
    try { fs.unlinkSync(tmpDump); } catch (_) {}
    assert.strictEqual(res.status, 0, '[P0-5] weapon-efficiency-dump must exit 0');
    assert.ok(/b0\/g0\/m2\/a0\/c0/.test(res.stdout), `[P0-5] dump must report m2 for 2 midair deaths:\n${res.stdout}`);
    assert.ok(/midair=2/.test(res.stdout), `[P0-5] summary must report midair=2:\n${res.stdout}`);
    assert.ok(/gatePass=0\/1/.test(res.stdout), `[P0-5] midair deaths must fail safety GATE:\n${res.stdout}`);
}

// ============================================================================
// 6. P1-1: evaluateActionSafety — 2-turn lookahead, wingspan margin, enemy/ally separation
// ============================================================================
{
    // 6a. Head-on midair trajectory separation penalty
    const teamsMidair = {
        red: makeTeam('red', [0, 50, 0], 0, { ap: 150, throttle: 4 }),
        blue: makeTeam('blue', [0, 50, 9.5], Math.PI, { ap: 150, throttle: 4 }),
        red2: makeTeam('red2', [2.5, 50, 0], 0, { ap: 150, throttle: 4 })
    };
    const { AI: aiSep } = loadAIHarness(teamsMidair, []);
    aiSep.getEnemyId = () => 'blue';
    const evalStraight = aiSep.evaluateActionSafety('red', { throttle: 4, joyX: 0, joyY: 0, roll: 0, queueAction: 'none' });
    assert.strictEqual(evalStraight.midairHit, true, `[P1-1] Head-on collision path must set midairHit=true (minEnemySep=${evalStraight.minEnemySep})`);
    assert.strictEqual(evalStraight.safe, false, '[P1-1] Head-on collision path must be unsafe');
    assert.ok(evalStraight.minAllySep < 5.0, `[P1-1] Close wingman must register minAllySep < 5.0 (got ${evalStraight.minAllySep})`);

    // 6b. Wingspan margin (nearMissHard when passing within 2.2m of wall)
    const wallSide = makeBoxObs([1.8, 0, -20], [20, 100, 40]);
    const teamsWing = {
        red: makeTeam('red', [0, 50, 0], 0, { ap: 150, throttle: 4 }),
        blue: makeTeam('blue', [0, 50, 120], Math.PI, { ap: 150, throttle: 4 })
    };
    const { AI: aiWing } = loadAIHarness(teamsWing, [wallSide]);
    aiWing.getEnemyId = () => 'blue';
    const evalWing = aiWing.evaluateActionSafety('red', { throttle: 4, joyX: 0, joyY: 0, roll: 0, queueAction: 'none' });
    assert.strictEqual(evalWing.buildingHit, false, '[P1-1] Center ray misses wall at x=1.8');
    assert.strictEqual(evalWing.nearMissHard, true, '[P1-1] Wingspan margin (x=1.8 < 2.2m) must flag nearMissHard=true');

    // 6c. 2-turn lookahead trap (Turn 1 flies into dead-end box; Turn 2 all escapes hit wall)
    const deadEndWall = makeBoxObs([-60, 0, 5.5], [60, 120, 40]);
    const teamsTrap = {
        red: makeTeam('red', [0, 40, 0], 0, { ap: 150, throttle: 4 }),
        blue: makeTeam('blue', [0, 40, 120], Math.PI, { ap: 150, throttle: 4 })
    };
    const { AI: aiTrap } = loadAIHarness(teamsTrap, [deadEndWall]);
    aiTrap.getEnemyId = () => 'blue';
    const evalTrap = aiTrap.evaluateActionSafety('red', { throttle: 4, joyX: 0, joyY: 0, roll: 0, queueAction: 'none' });
    assert.strictEqual(evalTrap.buildingHit, false, '[P1-1] Turn 1 ends at z≈4.8 before wall at z=5.5');
    assert.strictEqual(evalTrap.twoTurnBuildingHit, true, '[P1-1] 2-turn lookahead must detect Turn-2 inescapable wall trap');
    assert.strictEqual(evalTrap.safe, false, '[P1-1] 2-turn trap must mark action unsafe');
}

// ============================================================================
// 7. P1-2: Active rocketLeadAttack state
// ============================================================================
{
    const teamsRkt = {
        red: makeTeam('red', [0, 50, 0], 0, {
            ap: 150,
            pylons: [
                { id: 0, weaponType: 'rocket', state: 'standby', ammo: 9, ammoMax: 9 },
                { id: 1, weaponType: 'fox2', state: 'empty', ammo: 0 }
            ]
        }),
        blue: makeTeam('blue', [4, 50, 52], Math.PI, { hp: 38, ap: 150 })
    };
    const { AI: aiRkt, sb: sbRkt } = loadAIHarness(teamsRkt, []);
    sbRkt.AirArenaRocket = {
        ensurePodAmmo: (p) => Number(p.ammo) || 0,
        setTeamFuzeMode: (t, f) => { t.rocketFuze = f; return f; },
        computeRocketAimSolution: () => ({ fuze: 'vt', anyVtHit: true, bestCpaDist: 2.1, vtRadius: 4.5 })
    };
    const rktAct = aiRkt.buildRocketLeadAttackAction('red', {
        liveSelf: teamsRkt.red,
        liveEnemy: teamsRkt.blue,
        enemy: { hp: 38 },
        distance: 52,
        angleDeg: 14,
        headOnFactor: 0.9,
        frontAspect: true,
        lineOfSightBlocked: false,
        coverInfo: { collisionRisk: 'low' },
        hasAnyMissile: false,
        hasArmedMissile: false,
        missileAttackWindow: false,
        aiMissileType: 'fox2',
        fox1Hold: false
    });
    assert.ok(rktAct && rktAct.state === 'rocketLeadAttack', '[P1-2] FOX-2 dry / front-aspect / low-HP must produce rocketLeadAttack');
    assert.strictEqual(rktAct.queueAction, 'rocket', '[P1-2] rocketLeadAttack must queue rocket');
    assert.strictEqual(rktAct.rocketFuze, 'vt', '[P1-2] rocketLeadAttack must select VT fuze');

    // Must NOT steal a clean in-envelope FOX-2 launch against full-HP non-front-aspect target
    teamsRkt.blue.hp = 100;
    const noSteal = aiRkt.buildRocketLeadAttackAction('red', {
        liveSelf: teamsRkt.red,
        liveEnemy: teamsRkt.blue,
        enemy: { hp: 100 },
        distance: 52,
        angleDeg: 6,
        headOnFactor: -0.6,
        frontAspect: false,
        frontAspectPenalty: false,
        lineOfSightBlocked: false,
        coverInfo: { collisionRisk: 'low' },
        hasAnyMissile: true,
        hasArmedMissile: true,
        missileAttackWindow: true,
        aiMissileType: 'fox2',
        fox1Hold: false
    });
    assert.strictEqual(noSteal, null, '[P1-2] rocketLeadAttack must NOT steal clean in-envelope FOX-2 shot');
}

// ============================================================================
// 8. P1-3: 1-Turn Gun Boresight Intercept Check & hybridPress LCOS
// ============================================================================
{
    const teamsGun = {
        red: makeTeam('red', [0, 50, 0], 0, { ap: 140, throttle: 3 }),
        blueAligned: makeTeam('blueAligned', [0, 49.4, 24], 0, { ap: 140, throttle: 3 }),
        blueOffBore: makeTeam('blueOffBore', [16, 50, 24], 0, { ap: 140, throttle: 3 })
    };
    const { AI: aiGun } = loadAIHarness(teamsGun, []);
    const straight = { throttle: 3, joyX: 0, joyY: 0, roll: 0, queueAction: 'gun' };
    const hitRes = aiGun.checkGunBoresightIntercept('red', teamsGun.red, straight, teamsGun.blueAligned);
    const missRes = aiGun.checkGunBoresightIntercept('red', teamsGun.red, straight, teamsGun.blueOffBore);
    assert.strictEqual(hitRes.ok, true, `[P1-3] Aligned boresight must pass intercept check (miss=${hitRes.minMissDist})`);
    assert.strictEqual(missRes.ok, false, `[P1-3] Off-boresight target must fail intercept check (miss=${missRes.minMissDist})`);

    const aiSrc = fs.readFileSync(path.join(ROOT, 'js/ai/pilot-ai.js'), 'utf8');
    assert.ok(/pressBoresight = this\.checkGunBoresightIntercept/.test(aiSrc), '[P1-3] hybridPress must verify 1-turn boresight intercept');
    assert.ok(/pressGunLead = wantPressGun[\s\S]{0,120}this\.getGunLeadAim/.test(aiSrc), '[P1-3] hybridPress must use LCOS getGunLeadAim');
}

console.log('ai-p0-p1-smoke: PASS (8/8 groups)');
