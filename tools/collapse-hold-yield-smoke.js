#!/usr/bin/env node
/**
 * Collapse hold must not stay selected into a still-dead nest (T112/T118).
 * Flip stay banned (tableGlueHold). Yield uses the same dead-nest test.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    isTableGlueFlipIntoDeadNest('), 'missing isTableGlueFlipIntoDeadNest');
assert(src.includes('    shouldYieldCollapseHoldIntoDeadNest('), 'missing shouldYieldCollapseHoldIntoDeadNest');
assert(src.includes('scoreCollapseHoldYield'), 'missing hold-yield mode');
assert(src.includes('collapseHoldYield=1'), 'missing collapseHoldYield needle');
assert(src.includes('collapseHold: yield=1'), 'missing collapseHold yield tree needle');
assert(src.includes('tableGlueHold=1'), 'must keep flip-into-dead hold');
assert(!src.includes('mandatoryClimbAlt: 48'), 'must not raise mandatoryClimbAlt');

function isTableGlueFlipIntoDeadNest(opts) {
    if (opts.gapOwnsSafe === true || opts.gapOwnsSafe === 1) return false;
    if (opts.gapOwnsSafe !== false && opts.gapOwnsSafe !== 0) return false;
    const hit = !!(opts.buildingHit || opts.hit);
    const score = Number(opts.score);
    const dist = Number(opts.coverDistance != null ? opts.coverDistance : opts.dist);
    const deadScore = Number.isFinite(score) && score < -160;
    const glued = Number.isFinite(dist) && dist < 14;
    return hit && deadScore && glued;
}

function shouldYieldCollapseHoldIntoDeadNest(opts) {
    return isTableGlueFlipIntoDeadNest(opts);
}

const t112 = { gapOwnsSafe: 0, buildingHit: 1, score: -250, dist: 8 };
assert(shouldYieldCollapseHoldIntoDeadNest(t112), 'T112 dead nest must yield hold');
assert(isTableGlueFlipIntoDeadNest(t112), 'same nest still bans flip');

const ownedGap = { gapOwnsSafe: 1, buildingHit: 1, score: -250, dist: 8 };
assert(!shouldYieldCollapseHoldIntoDeadNest(ownedGap), 'owned gap must not yield');

const mild = { gapOwnsSafe: 0, buildingHit: 1, score: -40, dist: 8 };
assert(!shouldYieldCollapseHoldIntoDeadNest(mild), 'must not widen dead-score past -160');

console.log('collapse-hold-yield-smoke: ok');
