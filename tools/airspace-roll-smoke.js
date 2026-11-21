#!/usr/bin/env node
/**
 * Bank target: roll is a per-beat rotation kept in the pose, so escape / pull-up
 * rolls are read as the bank wanted and flown as the roll from the current bank,
 * at the exit and inside the escape sims. Combat states keep the accumulating
 * roll. The airspace rim wants wings level.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    rollTowardBank(quat, targetBank, limit = Math.PI / 4) {'), 'missing bank-target roll helper');
assert(src.includes('    simulateBanked(team, actions, bankTarget = true) {'), 'missing per-command banked sim');
assert(src.includes('    applyBankTarget(teamId, action) {'), 'missing exit bank conversion');
assert(src.includes('if (safeAction) this.applyBankTarget(teamId, safeAction);'), 'exit must convert the decided roll');
assert(src.includes('    bankTargetAction(action) {'), 'missing escape-family bank gate');
assert(src.includes('if (!action || !this.bankTargetAction(action)) return action;'), 'exit converts only the escape family');
assert(/\|\| s === 'airspaceAvoid'\r?\n/.test(src), 'rim roll 0 must stay a wings-level target');
assert(/\|\| s === 'alignFirst'\r?\n/.test(src), 'align shallow bank is a bank target, not a per-beat roll');
assert(/\|\| s === 'mergeBreak'\r?\n\s*\|\| s === 'mandatoryMergeBreak'\r?\n/.test(src), 'merge break bank is a bank target, not a per-beat roll');
assert(/\|\| s === 'tacticalBeamReposition';/.test(src), 'beam reposition bank is a bank target, not a per-beat roll');
assert(/let pitchCmdRim = highAltRim\r?\n\s*\? maxPitchCmd \* \(outsideBand \|\| hardHighRim \? 0\.45 : 0\.32\)/.test(src), 'high rim descend pitchCmd must be nose-down (positive), matching its joyY');
assert(/\? -maxPitchCmd \* joyY\r?\n\s*: -maxPitchCmd \* 0\.08\);/.test(src), 'rim punch-out pitchCmd must follow its level/descend joyY, not pull nose-up');
assert(src.includes('                                    escapeBank: 1,'), 'scored escape writer tags escapeBank');
assert(src.includes('[action, ...continuationActions], this.bankTargetAction(action));'), 'safety sim follows the exit gate');
assert(src.includes('this.simulateBanked(liveSelf, [action, action], false);'), 'combat lead sim keeps accumulating roll');
assert(!src.includes('getWingsLevelRoll'), 'rim wings-level helper folded into the bank target');
assert(!src.includes('roll: this.clamp(inwardSide * rollAuth, -Math.PI / 3, Math.PI / 3),'), 'fixed rim bank stays out');
assert(src.includes('const bank = Math.atan2(right.y, up.y);'), 'bank is read from the pose');
assert(src.includes('if (Math.abs(fwd.y) > 0.85) return 1e-4;'), 'vertical nose sends no roll');
assert(src.includes('delta = Math.atan2(Math.sin(delta), Math.cos(delta));'), 'shortest roll to the bank wanted');

const simCalls = src.match(/simulateFlight\(/g) || [];
assert(simCalls.length === 1, `only simulateBanked calls simulateFlight (found ${simCalls.length})`);
assert(src.includes('this.simulateBanked(team, new Array(8).fill(action));'), 'held arcs fly the banked sim');
function rollTowardBank(bank, target, limit = Math.PI / 4, fwdY = 0) {
    const nonZero = (r) => (Math.abs(r) < 1e-4 ? 1e-4 : r);
    if (Math.abs(fwdY) > 0.85) return 1e-4;
    let d = target - bank;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return nonZero(Math.max(-limit, Math.min(limit, d)));
}

const deg = Math.PI / 180;
assert(Math.abs(rollTowardBank(30 * deg, 0) + 30 * deg) < 1e-9, 'right bank rolls back to level');
assert(Math.abs(rollTowardBank(20 * deg, 20 * deg) - 1e-4) < 1e-12, 'holding the bank wanted sends no roll');
assert(Math.abs(rollTowardBank(-123 * deg, 20 * deg) - Math.PI / 4) < 1e-9, 'inverted left rolls the short way, capped');
assert(Math.abs(rollTowardBank(170 * deg, -170 * deg) - 20 * deg) < 1e-9, 'wraps across inverted');
assert(rollTowardBank(80 * deg, 0, Math.PI / 4, 0.95) === 1e-4, 'vertical nose holds roll');
assert(rollTowardBank(0, 0) === 1e-4, 'level still sends a nonzero roll');

// Rim side: the AI must pick the same short turn inward as the game's forced-inward blend.
const airSrc = fs.readFileSync(path.join(ROOT, 'js', 'core', 'combat-airspace.js'), 'utf8');
assert(airSrc.includes('const crossY = fxx * oz - fzz * ox;'), 'game forced-inward crossY changed');
assert(airSrc.includes('const inwardSide = crossY >= 0 ? -1 : 1;'), 'game forced-inward side changed');
assert(src.includes('        const instant = crossY >= 0 ? 1 : -1;'), 'AI rim side must turn the short way');
assert(src.includes('crossY: fwdFlat.clone().cross(outFlat).y'), 'AI rim crossY is (fwd x outward).y');
assert(!src.includes('inwardSide: -sample.inwardSide'), 'test_01 must not locally negate envelope inwardSide');
const envSrc = fs.readFileSync(path.join(ROOT, 'js', 'core', 'arena-envelope.js'), 'utf8');
assert(envSrc.includes('inwardSide: crossY >= 0 ? 1 : -1'), 'envelope inwardSide must match PilotAI short turn');
for (let a = 0; a < 360; a += 7) {
    for (let b = 0; b < 360; b += 11) {
        const fx = Math.cos(a * deg), fz = Math.sin(a * deg);
        const ox = Math.cos(b * deg), oz = Math.sin(b * deg);
        const aiCross = fz * ox - fx * oz;
        if (Math.abs(aiCross) < 1e-6) continue;
        const ai = aiCross >= 0 ? 1 : -1;
        const game = (fx * oz - fz * ox) >= 0 ? -1 : 1;
        const env = (ox * fz - oz * fx) >= 0 ? 1 : -1;
        assert(ai === game, `AI rim side disagrees with game at fwd ${a} out ${b}`);
        assert(env === game, `envelope score side disagrees with game at fwd ${a} out ${b}`);
    }
}

console.log('airspace-roll-smoke: ok');
