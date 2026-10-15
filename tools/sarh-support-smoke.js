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
        distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
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

    assert.ok(typeof describeFox1RingMode === 'function', 'describeFox1RingMode missing');
    const hold = describeFox1RingMode({ distance: 40, inFlight: false });
    assert.strictEqual(hold.mode, 'hold', 'pre-launch 40m is illuminate-hold, not fire');
    assert.strictEqual(hold.lookFire, false, 'pre-launch <50 must not look fireable');
    assert.strictEqual(describeFox1SmsLine({ distance: 40, inFlight: false }).text, '', 'no 照射中 after hit / next pylon');

    const fireNear = describeFox1RingMode({ distance: 55, inFlight: false });
    assert.strictEqual(fireNear.mode, 'fire', 'pre-launch 55m is past new 50 floor');
    const fireLook = describeFox1RingMode({ distance: 90, inFlight: false });
    assert.strictEqual(fireLook.mode, 'fire', 'pre-launch 90m may look fireable');
    assert.strictEqual(fireLook.lookFire, true);
    assert.strictEqual(describeFox1SmsLine({ distance: 90, inFlight: false }).text, '');

    const supportClose = describeFox1RingMode({ distance: 40, inFlight: true });
    assert.strictEqual(supportClose.mode, 'support', 'in-flight 40m stays support');
    assert.strictEqual(supportClose.lookSupport, true);
    assert.strictEqual(supportClose.lookFire, false);
    assert.strictEqual(describeFox1SmsLine({ distance: 40, inFlight: true }).text, 'FOX-1 導引中');

    const supportFar = describeFox1RingMode({ distance: 180, inFlight: true });
    assert.strictEqual(supportFar.mode, 'support');

    assert.ok(typeof teamHasFox1InFlight === 'function', 'teamHasFox1InFlight missing');
    const leftover = {
        activeMissiles: [{ missileType: 'fox1', exploded: false, ap: 180, active: false }]
    };
    assert.strictEqual(teamHasFox1InFlight(leftover), true, 'pre-activate / leftover FOX-1 still in flight');
    assert.strictEqual(
        describeFox1SmsLine({ distance: 40, inFlight: teamHasFox1InFlight(leftover) }).text,
        'FOX-1 導引中',
        'selecting next FOX-1 while first is out must stay 導引中'
    );
    assert.strictEqual(teamHasFox1InFlight({ activeMissiles: [] }), false);
    assert.strictEqual(
        describeFox1SmsLine({
            distance: 40,
            inFlight: teamHasFox1InFlight({ activeMissiles: [{ missileType: 'fox1', exploded: true, ap: 0 }] })
        }).text,
        '',
        'first FOX-1 already hit → SMS not 照射中'
    );

    const noneNear = describeFox1RingMode({ distance: 4, inFlight: true });
    assert.strictEqual(noneNear.mode, 'none', 'below supportMinRange');
    const noneFar = describeFox1RingMode({ distance: 250, inFlight: false });
    assert.strictEqual(noneFar.mode, 'none');

    assert.ok(typeof describeMissileLaunchRange === 'function', 'describeMissileLaunchRange missing');
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox1', distance: 40 }).reason, 'tooClose');
    assert.strictEqual(missileLaunchRangeSms('tooClose'), '少於最短射程');
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox1', distance: 250 }).reason, 'tooFar');
    assert.strictEqual(missileLaunchRangeSms('tooFar'), '未進入射程');
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox1', distance: 90 }).ok, true);
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox1', distance: 55 }).ok, true);
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox2', distance: 15 }).reason, 'tooClose');
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox2', distance: 20 }).ok, true);
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox2', distance: 150 }).reason, 'tooFar');
    assert.strictEqual(describeMissileLaunchRange({ missileType: 'fox2', distance: 80 }).ok, true);

    assert.strictEqual(CONFIG.weapons.chaff.breakSupportOnLos, true);
    assert.strictEqual(Number(CONFIG.weapons.chaff.breakChance), 0.5);
    assert.strictEqual(Number(CONFIG.weapons.chaff.breakTurns), 1);
    const chaffCloud = [{ pos: new THREE.Vector3(0, 40, 120), ageSteps: 40 }];
    const chaffed = computeSarhSupport({
        shooterPos,
        shooterQuat: new THREE.Quaternion(),
        targetPos: targetFar,
        step: 0,
        losBlocked: false,
        chaffBreakForce: true,
        chaffList: chaffCloud
    });
    assert.strictEqual(chaffed.supported, false, 'M24: forced break drops nose-on support');
    assert.strictEqual(chaffed.reason, 'chaff');
    assert.strictEqual(chaffed.flicker, true);

    const held = computeSarhSupport({
        shooterPos,
        shooterQuat: new THREE.Quaternion(),
        targetPos: targetFar,
        step: 0,
        losBlocked: false,
        chaffBreakForce: false,
        chaffList: chaffCloud
    });
    assert.strictEqual(held.supported, true, 'M24 miss roll: nose-on still supported');
    assert.strictEqual(held.reason, 'ok');
    assert.strictEqual(held.flicker, true, 'cloud still shrinks / flickers on a miss');

    const rollA = computeSarhSupport({
        shooterPos,
        shooterQuat: new THREE.Quaternion(),
        targetPos: targetFar,
        turn: 4,
        shooterId: 'blue-1',
        targetId: 'red-2',
        shotId: '0',
        chaffList: chaffCloud
    });
    const rollB = computeSarhSupport({
        shooterPos,
        shooterQuat: new THREE.Quaternion(),
        targetPos: targetFar,
        turn: 4,
        shooterId: 'blue-1',
        targetId: 'red-2',
        shotId: '0',
        chaffList: chaffCloud
    });
    assert.strictEqual(rollA.supported, rollB.supported, 'same pair+turn+shot must not re-roll');
    assert.ok(typeof resolveSarhChaffBreak === 'function', 'resolveSarhChaffBreak exported');
    const baseBreak = resolveSarhChaffBreak({
        turn: 16, shooterId: 'red', targetId: 'blue', shotId: '0', matchSalt: 's:1'
    }, CONFIG.weapons.chaff, true);
    const sameAgain = resolveSarhChaffBreak({
        turn: 16, shooterId: 'red', targetId: 'blue', shotId: '0', matchSalt: 's:1'
    }, CONFIG.weapons.chaff, true);
    assert.strictEqual(sameAgain, baseBreak, 'same shot+match must not re-roll');
    let flipped = false;
    for (let i = 1; i < 24; i++) {
        const byShot = resolveSarhChaffBreak({
            turn: 16, shooterId: 'red', targetId: 'blue', shotId: String(i), matchSalt: 's:1'
        }, CONFIG.weapons.chaff, true);
        const byMatch = resolveSarhChaffBreak({
            turn: 16, shooterId: 'red', targetId: 'blue', shotId: '0', matchSalt: 's:' + i
        }, CONFIG.weapons.chaff, true);
        if (byShot !== baseBreak || byMatch !== baseBreak) {
            flipped = true;
            break;
        }
    }
    assert.ok(flipped, 'different shotId or matchSalt must be able to roll the other way');

    console.log('sarh-support-smoke: PASS');
    console.log(`  close(40m) supported=${close.supported} far(120m) supported=${far.supported}`);
    console.log(`  ring hold@40=${hold.mode} fire@90=${fireLook.mode} support@40=${supportClose.mode}`);
}

main();
