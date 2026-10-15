#!/usr/bin/env node
/**
 * A.2b alley-time notice needle only. Does not change shoot / envelope.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    describeAlleyShotWindow('), 'missing describeAlleyShotWindow');
assert(src.includes('    formatAlleyTimeNeedle('), 'missing formatAlleyTimeNeedle');
assert(src.includes('alleyTime: in='), 'missing alleyTime needle');
assert(src.includes('this.formatAlleyTimeNeedle({'), 'needle must be pushed from decide');
assert(src.includes('    shouldAlleyHangYield('), 'missing shouldAlleyHangYield');
assert(src.includes('missileGate: deferred=alleyHang'), 'missing alleyHang yield needle');
assert(!/shouldShootMissile\s*=\s*alleyNotice/.test(src), 'notice must not drive shoot');
assert(!/shouldShootMissile\s*=\s*true[\s\S]{0,80}alleyHang/.test(src), 'hang yield must not shoot');

function describeAlleyShotWindow(flags = {}) {
    const dist = Number(flags.distance);
    const lockRange = Number(flags.lockRange);
    const ang = Number(flags.angleDeg);
    const shootAng = Number(flags.shootAng);
    const lz = Number(flags.localZ);
    const nose = Number(flags.noseDot);
    if (!Number.isFinite(dist) || !Number.isFinite(ang)) {
        return { in: 0, left: 0, held: 0, why: 'nodata' };
    }
    if (flags.losBlocked) return { in: 0, left: 0, held: 0, why: 'los' };
    if (Number.isFinite(lockRange) && dist > lockRange + 4) {
        return { in: 0, left: 0, held: 0, why: 'far' };
    }
    const hang = !Number.isFinite(shootAng) || ang > shootAng
        || !Number.isFinite(lz) || !Number.isFinite(nose) || lz <= nose;
    if (hang || !flags.inEnvelope) {
        return { in: 0, left: 0, held: 0, why: hang ? 'hang' : 'off' };
    }
    return { in: 1, left: 0, held: 0, why: 'window' };
}

const t115 = describeAlleyShotWindow({
    distance: 115,
    lockRange: 140,
    angleDeg: 110,
    shootAng: 34,
    localZ: -0.34,
    noseDot: 0.78,
    inEnvelope: false,
    losBlocked: false
});
assert(t115.in === 0 && t115.why === 'hang' && t115.left === 0, JSON.stringify(t115));

const windowOpen = describeAlleyShotWindow({
    distance: 90,
    lockRange: 140,
    angleDeg: 22,
    shootAng: 34,
    localZ: 0.86,
    noseDot: 0.78,
    inEnvelope: true,
    losBlocked: false
});
assert(windowOpen.in === 1 && windowOpen.why === 'window' && windowOpen.left === 0, JSON.stringify(windowOpen));

const far = describeAlleyShotWindow({
    distance: 200,
    lockRange: 140,
    angleDeg: 20,
    shootAng: 34,
    localZ: 0.9,
    noseDot: 0.78,
    inEnvelope: true
});
assert(far.why === 'far' && far.in === 0, JSON.stringify(far));

function shouldAlleyHangYield(flags = {}) {
    if (flags.stickOwns) return false;
    if (String(flags.why || '') !== 'hang') return false;
    const timeoutN = Math.max(1, Number(flags.timeoutN) || 3);
    return (Number(flags.streak) || 0) >= timeoutN;
}

assert(shouldAlleyHangYield({ why: 'hang', streak: 3, timeoutN: 3 }) === true, 'T115-class hang yields after timeout');
assert(shouldAlleyHangYield({ why: 'hang', streak: 2, timeoutN: 3 }) === false, 'do not yield before timeout');
assert(shouldAlleyHangYield({ why: 'window', streak: 4, timeoutN: 3 }) === false, 'in-window must not hang-yield');
assert(shouldAlleyHangYield({ why: 'hang', streak: 4, timeoutN: 3, stickOwns: true }) === false, 'stick owns stays hang');
assert(shouldAlleyHangYield({ why: 'far', streak: 4, timeoutN: 3 }) === false, 'far is not this hang door');

console.log('alley-time-smoke: ok');
