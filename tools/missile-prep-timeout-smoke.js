#!/usr/bin/env node
/**
 * Prep-timeout shoot: use missilePrepTimeoutShootAng (34), not a tighter 22/24 cone.
 * Live pilot-ai.js only. Does not widen envelope or drop nose lock.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    shouldPrepTimeoutShoot('), 'missing shouldPrepTimeoutShoot');
assert(src.includes('missileGate: prepTimeoutShoot=1'), 'missing prepTimeoutShoot needle');
assert(src.includes('missileGate: prepTimeoutHang=1'), 'missing prepTimeoutHang needle');
assert(!src.includes('fox2Seeker ? 24 : 22'), 'must not clamp timeout shoot to 22/24');
assert(src.includes('shootAng: prepShootAng'), 'timeout shoot must use prepShootAng');

function shouldPrepTimeoutShoot(flags) {
    const streak = Number(flags.streak) || 0;
    const timeoutN = Math.max(1, Number(flags.timeoutN) || 3);
    if (streak < timeoutN) return false;
    if (!flags.armed || !flags.inEnvelope || flags.frontBan || flags.losBlocked) return false;
    const dist = Number(flags.distance);
    const lockRange = Number(flags.lockRange);
    if (!Number.isFinite(dist) || !Number.isFinite(lockRange) || dist <= 25 || dist > lockRange + 4) {
        return false;
    }
    const ang = Number(flags.angleDeg);
    const shootAng = Number(flags.shootAng);
    if (!Number.isFinite(ang) || !Number.isFinite(shootAng) || ang > shootAng) return false;
    const lz = Number(flags.localZ);
    const nose = Number(flags.noseDot);
    if (!Number.isFinite(lz) || !Number.isFinite(nose) || lz <= nose) return false;
    return true;
}

const base = {
    streak: 3,
    timeoutN: 3,
    armed: true,
    inEnvelope: true,
    frontBan: false,
    losBlocked: false,
    distance: 142,
    lockRange: 200,
    angleDeg: 40,
    shootAng: 34,
    localZ: 0.80,
    noseDot: 0.74
};

assert(shouldPrepTimeoutShoot(base) === false, '40° > 34° still no shoot');
assert(shouldPrepTimeoutShoot(Object.assign({}, base, { angleDeg: 32 })) === true, '32° FOX-1 at 142m must shoot (old 22° cap blocked)');
assert(shouldPrepTimeoutShoot(Object.assign({}, base, { angleDeg: 32, noseDot: 0.78 })) === true, '32° FOX-2 at 142m must shoot (old 24° cap blocked)');
assert(shouldPrepTimeoutShoot(Object.assign({}, base, { angleDeg: 32, localZ: 0.70, noseDot: 0.78 })) === false, 'must keep FOX-2 nose 0.78');
assert(shouldPrepTimeoutShoot(Object.assign({}, base, { angleDeg: 32, inEnvelope: false })) === false, 'wide prep aspect must not timeout-shoot');
assert(shouldPrepTimeoutShoot(Object.assign({}, base, { angleDeg: 32, streak: 2 })) === false, 'need 3 prep turns');
assert(shouldPrepTimeoutShoot(Object.assign({}, base, { angleDeg: 32, frontBan: true })) === false, 'head-on ban stays');
assert(shouldPrepTimeoutShoot(Object.assign({}, base, { angleDeg: 32, distance: 60, lockRange: 50 })) === false, 'beyond lockRange+4 no timeout shoot');

console.log('missile-prep-timeout-smoke: ok');
