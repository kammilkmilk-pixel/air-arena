#!/usr/bin/env node
/**
 * mandatoryClimb defer must win selection (A2a-183 facade).
 * Do not raise mandatoryClimbAlt. Open-canyon T25 climb must still arm.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    wantsMandatoryClimb('), 'missing wantsMandatoryClimb');
assert(src.includes('    isNavClimbOutFacadeUnsafe('), 'missing isNavClimbOutFacadeUnsafe');
assert(src.includes('    shouldYieldClimbOutToTableEscape('), 'missing shouldYieldClimbOutToTableEscape');
assert(src.includes('mandatoryClimbAlt: 36'), 'must not raise mandatoryClimbAlt');
assert(src.includes('!underRoofGE && !facadeUnsafeGE'), 'mandClimbLow must lose to facadeUnsafeGE');
assert(src.includes('(!embedOrHardLow || mandClimbLow) && !facadeUnsafeGE'), 'roofExitLow must lose to facadeUnsafeGE');
assert(src.includes('!underRoofNow && !facadeUnsafeOE'), 'mandClimbNow must lose to facadeUnsafeOE');
assert(src.includes('const mandFacadeBan = this.isNavClimbOutFacadeUnsafe(coverInfo, mandCoverOpts)'), 'arm must check facade before navClimbOut');
assert(src.includes('if (mandFacadeBan)'), 'arm must skip when facade unsafe');

function mandClimbLow(flags) {
    return (!!flags.mandatoryClimb || flags.altitude < flags.climbFloor)
        && !flags.noseHigh
        && !flags.underRoof
        && !flags.facadeUnsafe;
}

function roofExitLow(flags) {
    const mand = mandClimbLow(flags);
    return (flags.preferRoofExit || mand)
        && !flags.noseHigh
        && (!flags.embedOrHardLow || mand)
        && !flags.facadeUnsafe;
}

function selectedMandatoryClimb(flags) {
    return roofExitLow(flags) || mandClimbLow(flags);
}

const gold183 = {
    mandatoryClimb: true,
    altitude: 9,
    climbFloor: 36,
    noseHigh: false,
    underRoof: false,
    facadeUnsafe: true,
    preferRoofExit: true,
    embedOrHardLow: false
};
assert(!selectedMandatoryClimb(gold183), 'A2a-183 defer must win (cov≈4 roof+4 alt9)');

const t25Open = {
    mandatoryClimb: true,
    altitude: 20,
    climbFloor: 36,
    noseHigh: false,
    underRoof: false,
    facadeUnsafe: false,
    preferRoofExit: true,
    embedOrHardLow: false
};
assert(selectedMandatoryClimb(t25Open), 'T25 open canyon must still select climb');

console.log('climb-defer-smoke: ok');
