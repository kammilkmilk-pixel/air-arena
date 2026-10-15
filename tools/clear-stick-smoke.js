#!/usr/bin/env node
/**
 * Clear-stick path pick: hitting winner yields to a non-hit scored branch.
 * Do not widen the −160 floor. Do not restore awayFlip. No-alt leftover stays.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    isClearStickSwap('), 'missing isClearStickSwap');
assert(src.includes('clearStick=1'), 'missing clearStick reason needle');
assert(src.includes('clearStick: swap=1'), 'missing clearStick tree needle');
assert(src.includes('if (this.isClearStickSwap(best, bestNonHit))'), 'pick must swap hitting winner to non-hit');
assert(!src.includes('mandatoryClimbAlt: 48'), 'must not raise mandatoryClimbAlt');
const sliceStart = src.indexOf('isClearStickSwap');
assert(sliceStart >= 0, 'isClearStickSwap body missing');
assert(!/awayFlip/.test(src.slice(sliceStart, sliceStart + 600)), 'must not restore awayFlip in this knife');
assert(src.includes('Number.isFinite(n) && n > -160'), 'clear-stick floor must stay > -160');

function isClearStickSwap(winner, nonHit) {
    if (!winner || !nonHit || winner === nonHit) return false;
    if (!winner.buildingHit || nonHit.buildingHit) return false;
    const n = Number(nonHit.score);
    return Number.isFinite(n) && n > -160;
}

const hitWin = { buildingHit: true, score: -40 };
const clearAlt = { buildingHit: false, score: 12 };
assert(isClearStickSwap(hitWin, clearAlt), 'mild hit must yield when a clear branch exists');
assert(!isClearStickSwap(hitWin, { buildingHit: false, score: -160 }), 'must not swap into collapse floor');
assert(!isClearStickSwap(hitWin, { buildingHit: false, score: -407 }), 'must not swap into dead score');
assert(!isClearStickSwap(hitWin, { buildingHit: true, score: 20 }), 'must not swap to another hit');
assert(!isClearStickSwap({ buildingHit: false, score: 80 }, clearAlt), 'clear winner stays');
assert(!isClearStickSwap(hitWin, null), 'no-alt leftover stays');
assert(!isClearStickSwap(hitWin, hitWin), 'same row is not a swap');

console.log('clear-stick-smoke: ok');
