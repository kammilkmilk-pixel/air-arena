#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

global.THREE = {
    Vector3: class Vector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        applyQuaternion() { return this; }
    }
};

const Sarh = require(path.join(__dirname, '../js/logic/sarh.js'));

assert.strictEqual(Sarh.isMissileKillWeapon('fox1'), true);
assert.strictEqual(Sarh.isMissileKillWeapon('fox2'), true);
assert.strictEqual(Sarh.isMissileKillWeapon('missile'), true);
assert.strictEqual(Sarh.isMissileKillWeapon('gun'), false);

const nose = Sarh.computeMissileLaunchGeometry(
    { x: 0, y: 40, z: 0 },
    {},
    { x: 0, y: 40, z: 100 }
);
assert.strictEqual(nose.dist, 100);
assert.ok(nose.angDeg != null && nose.angDeg < 1, `head-on ang ${nose.angDeg}`);

const beam = Sarh.computeMissileLaunchGeometry(
    { x: 0, y: 40, z: 0 },
    {},
    { x: 100, y: 40, z: 0 }
);
assert.ok(Math.abs(beam.angDeg - 90) < 1, `abeam ang ${beam.angDeg}`);

const team = { missileShots: [] };
const m = { missileType: 'fox1', supportTargetId: 'blue' };
const opened = Sarh.openMissileShot(team, m, nose, 12, 'blue');
assert.ok(opened);
assert.strictEqual(opened.type, 'fox1');
assert.strictEqual(opened.dist, 100);
assert.strictEqual(opened.outcome, null);
assert.strictEqual(opened.why, null);
assert.strictEqual(Sarh.openMissileShot(team, m, nose, 12, 'blue'), null, 'open once');

assert.strictEqual(Sarh.classifyFox1SupportWhy({ reason: 'gate' }, { shooterAlive: true }), 'gate');
assert.strictEqual(Sarh.classifyFox1SupportWhy({ reason: 'los-blocked' }, { shooterAlive: false }), 'dead');
Sarh.stampFox1SupportWhy(m, { reason: 'ok' }, { shooterAlive: true, canGuide: false });
Sarh.stampFox1SupportWhy(m, { reason: 'gate' }, { shooterAlive: true, canGuide: true });
Sarh.stampFox1SupportWhy(m, { reason: 'range' }, { shooterAlive: true, canGuide: true });
assert.strictEqual(m.fox1DropWhy, 'gate', 'first post-arm drop wins');

const closed = Sarh.closeMissileShot(team, m, 'coast', 14);
assert.strictEqual(closed.outcome, 'coast');
assert.strictEqual(closed.why, 'gate');
assert.strictEqual(closed.endTurn, 14);
assert.strictEqual(Sarh.closeMissileShot(team, m, 'hit', 15), null, 'close once');

const mHit = { missileType: 'fox1' };
Sarh.openMissileShot(team, mHit, { dist: 80, angDeg: 3 }, 62, 'blue');
Sarh.stampFox1SupportWhy(mHit, { reason: 'ok' }, { shooterAlive: true, canGuide: true });
const hitRec = Sarh.closeMissileShot(team, mHit, 'hit', 64);
assert.strictEqual(hitRec.why, 'hit');

const m2 = { missileType: 'fox2' };
Sarh.openMissileShot(team, m2, { dist: 40, angDeg: 18 }, 13, 'red');
const fox2Hit = Sarh.closeMissileShot(team, m2, 'hit', 13);
assert.strictEqual(fox2Hit.why, 'hit');

assert.strictEqual(Sarh.classifyFox2TrackWhy({ canGuide: true, trackKind: 'flare' }), 'flare');
assert.strictEqual(Sarh.classifyFox2TrackWhy({
    canGuide: true, trackKind: null, nearDist: 140, seekerRange: 120
}), 'range');
assert.strictEqual(Sarh.classifyFox2TrackWhy({
    canGuide: true, trackKind: null, nearDist: 40, seekerRange: 120, inFovCold: true
}), 'heat');
assert.strictEqual(Sarh.classifyFox2TrackWhy({
    canGuide: true, trackKind: null, nearDist: 40, seekerRange: 120
}), 'gate');

assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 14.9 }, 15), true, '14.9 inside cone');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 15 }, 15), true, '15 on cone');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 15.7 }, 15), false, '15.7 leak');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 31.6 }, 15), false, 'wide leak');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: null }, 15), false, 'missing angle fail-closed');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: undefined }, 15), false, 'undefined fail-closed');
assert.strictEqual(Sarh.fox2LaunchAngleOk({}, 15), false, 'empty geom fail-closed');
assert.strictEqual(Sarh.fox2LaunchAngleOk(null, 15), false, 'null geom fail-closed');
assert.strictEqual(Sarh.fox2MaxLaunchAngleDeg(), 10);
assert.ok(Math.abs(Sarh.fox2FrontLaunchAngleDeg() - 6) < 0.05, 'front squeeze 6°');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 5.9 }, 10), true, '5.9 rear ok');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 10 }, 10), true, '10 on rear door');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 10.1 }, 10), false, '10.1 rear hold');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 11.2 }, 10), false, 'T50 11.2 gate waste');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 12.1 }, 10), false, 'T98 12.1 gate waste');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 5.9, frontAspect: true }, 10), true, 'front 5.9 ok');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 6 }, 10), true, 'front 6 on squeeze');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 6.1, frontAspect: true }, 10), false, 'front 6.1 hold');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 8, frontAspect: false }, 10), true, 'rear 8 inside 10');
assert.strictEqual(Sarh.fox2LaunchAngleOk({ angDeg: 10, frontAspect: false }, 15), true, 'caller cap 15 still rear 10');
assert.strictEqual(Sarh.fox2IsFrontAspect({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), true, 'nose-on is front');
assert.strictEqual(Sarh.fox2IsFrontAspect({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), false, 'tail-on is rear');

global.GameContext = { state: { currentTurn: 7 } };
assert.strictEqual(Sarh.fox2SameTurnCommitOk({ fox2LaunchCommit: { turn: 7, angDeg: 8, front: false } }, 10), true, 'honor same-turn 8°');
assert.strictEqual(Sarh.fox2SameTurnCommitOk({ fox2LaunchCommit: { turn: 7, angDeg: 11.2, front: false } }, 10), false, 'stamp still respects 10°');
assert.strictEqual(Sarh.fox2SameTurnCommitOk({ fox2LaunchCommit: { turn: 6, angDeg: 8, front: false } }, 10), false, 'stale turn');
assert.strictEqual(Sarh.fox2SameTurnCommitOk({ fox2LaunchCommit: { turn: 7, angDeg: 6.1, front: true } }, 10), false, 'front stamp still 6°');
assert.strictEqual(Sarh.fox2SameTurnCommitOk({}, 10), false, 'missing commit fail-closed');

const m2c = { missileType: 'fox2' };
Sarh.openMissileShot(team, m2c, { dist: 35, angDeg: 12 }, 20, 'blue');
Sarh.stampFox2TrackWhy(m2c, { canGuide: true, trackKind: 'aircraft' }, { canGuide: true });
Sarh.stampFox2TrackWhy(m2c, { canGuide: true, trackKind: 'flare' }, { canGuide: true });
Sarh.stampFox2TrackWhy(m2c, { canGuide: true, trackKind: null, nearDist: 40, seekerRange: 120 }, { canGuide: true });
assert.strictEqual(m2c.fox2DropWhy, 'flare', 'first post-arm leave-aircraft wins');
m2c.fox2CoastSteer = 1;
const fox2Coast = Sarh.closeMissileShot(team, m2c, 'coast', 22);
assert.strictEqual(fox2Coast.why, 'flare');
assert.strictEqual(fox2Coast.coastSteer, 1, 'arming coast inside the launch door stamps coastSteer');

const sum = Sarh.summarizeMissileShots(team.missileShots);
assert.strictEqual(sum.n, 4);
assert.strictEqual(sum.fox1, 2);
assert.strictEqual(sum.fox2, 2);
assert.strictEqual(sum.coast, 2);
assert.strictEqual(sum.hit, 2);
assert.ok(sum.fox1Why.indexOf('gate:1') >= 0, sum.fox1Why);
assert.ok(sum.fox1Why.indexOf('hit:1') >= 0, sum.fox1Why);
assert.ok(sum.fox2Why.indexOf('hit:1') >= 0, sum.fox2Why);
assert.ok(sum.fox2Why.indexOf('flare:1') >= 0, sum.fox2Why);

const weaponSrc = fs.readFileSync(path.join(__dirname, '../js/logic/weapon.js'), 'utf8');
assert.ok(weaponSrc.includes('activeM.fox2CoastSteer = 1'), 'coast steer must stamp fox2CoastSteer');
assert.ok(weaponSrc.includes('fox2LaunchAngleOk({ angDeg, frontAspect }, door)'), 'coast steer must use the launch door');
assert.ok(!weaponSrc.includes('maxLaunchAngleDeg: 15'), 'must not widen the 10° door');

console.log('missile-shot-smoke: ok');
