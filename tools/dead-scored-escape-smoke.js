#!/usr/bin/env node
/**
 * Dead scored-escape cut: P0 must reject winning skim hit=1 and score < -160.
 * Bake keep hit-or-collapse. Do not widen the −160 floor. Do not restore awayFlip.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    isDeadBakeRouteCut('), 'missing isDeadBakeRouteCut');
assert(src.includes('    isDeadScoredEscapeCut('), 'missing isDeadScoredEscapeCut');
assert(src.includes('deadStick=1'), 'missing deadStick needle');
assert(src.includes('deadStick: reject=1'), 'missing deadStick tree needle');
assert(src.includes('isDeadScoredEscapeCut(best.mode, best.buildingHit, bestScore)'), 'pick must reject dead winning stick');
assert(!src.includes('mandatoryClimbAlt: 48'), 'must not raise mandatoryClimbAlt');
assert(!/awayFlip/.test(src.slice(src.indexOf('isDeadScoredEscapeCut'), src.indexOf('isDeadScoredEscapeCut') + 800)), 'must not restore awayFlip in this knife');

function isBakeRouteEscapeMode(mode) {
    return mode === 'scoreBakeWp' || mode === 'scoreBakeWpClimb' || mode === 'scoreBakeCut';
}

function isDeadBakeRouteCut(mode, buildingHit, score) {
    if (!isBakeRouteEscapeMode(mode)) return false;
    if (buildingHit) return true;
    return Number(score) < -160;
}

function isDeadScoredEscapeCut(mode, buildingHit, score) {
    if (isDeadBakeRouteCut(mode, buildingHit, score)) return true;
    if (isBakeRouteEscapeMode(mode)) return false;
    const n = Number(score);
    return !!buildingHit && Number.isFinite(n) && n < -160;
}

assert(isDeadBakeRouteCut('scoreBakeWp', true, -40), 'bake hit is dead');
assert(isDeadBakeRouteCut('scoreBakeWp', false, -161), 'bake collapse is dead');
assert(!isDeadBakeRouteCut('scoreBakeWp', false, -160), 'must not widen past -160');
assert(!isDeadBakeRouteCut('scoreOpp', true, -407), 'non-bake is not a bake cut');

assert(isDeadScoredEscapeCut('scoreOpp', true, -407.3), '80/140 skim -407 hit=1 must reject');
assert(isDeadScoredEscapeCut('scoreSide', true, -161), 'skim hit + collapse must reject');
assert(!isDeadScoredEscapeCut('scoreOpp', true, -160), 'must not widen past -160');
assert(!isDeadScoredEscapeCut('scoreOpp', true, -40), 'mild hit must stay selectable');
assert(!isDeadScoredEscapeCut('scoreOpp', false, -407), 'miss without hit is not this knife');
assert(isDeadScoredEscapeCut('scoreBakeCut', true, 12), 'bake hit still dead via bake rule');

console.log('dead-scored-escape-smoke: ok');
