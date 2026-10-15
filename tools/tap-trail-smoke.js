#!/usr/bin/env node
/**
 * Trail dump-only TAP fields (role / tap / tapGate) in js/view/ui.js.
 * Does not change skip or catalog.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'view', 'ui.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('function uiParseTapDumpFromTree('), 'missing uiParseTapDumpFromTree');
assert(src.includes('role: team.aiTacticalRole || null'), 'trail must store role');
assert(src.includes('tap: tapInfo.tap || null'), 'trail must store tap');
assert(src.includes('tapGate: tapInfo.tapGate || null'), 'trail must store tapGate');
assert(src.includes('prepTimeout: tapInfo.prepTimeout || null'), 'trail must store prepTimeout');
assert(src.includes('role=${f.role || \'-\'} tap=${f.tap || \'-\'}'), 'text dump must print role/tap');

assert(src.includes('alleyTime: tapInfo.alleyTime || null'), 'trail must store alleyTime');

function uiParseTapDumpFromTree(tree) {
    if (!Array.isArray(tree)) return { tap: null, tapGate: null, prepTimeout: null, alleyTime: null };
    let tap = null;
    let tapGate = null;
    let prepTimeout = null;
    let alleyTime = null;
    for (let i = tree.length - 1; i >= 0; i--) {
        const s = String(tree[i] || '');
        if (!tapGate && s.indexOf('tapRoleGate:') === 0) {
            tapGate = s.replace(/^tapRoleGate:\s*/, '') || null;
        }
        if (!alleyTime && s.indexOf('alleyTime:') === 0) {
            alleyTime = s.replace(/^alleyTime:\s*/, '') || null;
        }
        if (!prepTimeout && s.indexOf('missileGate: prepTimeoutShoot=') === 0) prepTimeout = 'shoot';
        else if (!prepTimeout && s.indexOf('missileGate: prepTimeoutHang=') === 0) prepTimeout = 'hang';
        if (!tap && s.indexOf('tacticalApproach:') === 0) {
            const sel = s.match(/\bselected=([A-Za-z0-9_]+)/);
            const skip = s.match(/\btapSkip=([A-Za-z0-9_]+)/);
            const none = s.match(/\btapNone=([A-Za-z0-9_]+)/);
            if (sel) tap = 'sel=' + sel[1];
            else if (skip) tap = 'skip=' + skip[1];
            else if (none) tap = 'none=' + none[1];
            else if (/\bskipped=1\b/.test(s)) tap = 'skip=other';
            else if (/\bnone\b/.test(s)) tap = 'none=unknown';
        }
        if (tap && tapGate && prepTimeout && alleyTime) break;
    }
    return { tap, tapGate, prepTimeout, alleyTime };
}

const pressSel = uiParseTapDumpFromTree([
    'tacticalApproach: preferOverReacquire=1',
    'tacticalApproach: selected=tacticalLeadIntercept score=180 horizon=3 nb=40 apN=90 ang=22',
    'tapRoleGate: role=press pref=tacticalLeadIntercept n=2 fallback=0'
]);
assert(pressSel.tap === 'sel=tacticalLeadIntercept', pressSel.tap);
assert(pressSel.tapGate.indexOf('role=press') >= 0 && pressSel.tapGate.indexOf('fallback=0') >= 0, pressSel.tapGate);

const skipMerge = uiParseTapDumpFromTree([
    'tacticalApproach: skipped=1 eligible=1 contact=1 tapSkip=merge tapRole=seek_angle'
]);
assert(skipMerge.tap === 'skip=merge', skipMerge.tap);
assert(skipMerge.tapGate == null, 'skip must not invent tapGate');

const noneFloor = uiParseTapDumpFromTree([
    'tacticalApproach: none tapNone=scoreFloor tapRole=press'
]);
assert(noneFloor.tap === 'none=scoreFloor', noneFloor.tap);

const lastWins = uiParseTapDumpFromTree([
    'tacticalApproach: skipped=1 eligible=1 contact=1 tapSkip=steepDive',
    'tacticalApproach: selected=tacticalLagPursuit score=40 horizon=3 nb=20 apN=80 ang=50',
    'tapRoleGate: pref=tacticalLagPursuit n=1 fallback=0'
]);
assert(lastWins.tap === 'sel=tacticalLagPursuit', lastWins.tap);

const oldSkip = uiParseTapDumpFromTree([
    'tacticalApproach: skipped=1 eligible=1 contact=1'
]);
assert(oldSkip.tap === 'skip=other', oldSkip.tap);

const ineligible = uiParseTapDumpFromTree([
    'tacticalApproach: skipped=0 eligible=0 contact=0'
]);
assert(ineligible.tap == null, 'ineligible TAP must not set tap');

const noTap = uiParseTapDumpFromTree([
    'selected: missileAttack-early',
    'urbanCombatGate: defer=false dist=86'
]);
assert(noTap.tap == null && noTap.tapGate == null, 'survival/weapon frames stay empty');
assert(noTap.prepTimeout == null, 'no prepTimeout on unrelated tree');

const shoot = uiParseTapDumpFromTree([
    'missileGate: prepTimeoutShoot=1 streak=3 ang=32.0',
    'tacticalApproach: skipped=1 eligible=1 contact=1 tapSkip=msl'
]);
assert(shoot.prepTimeout === 'shoot', shoot.prepTimeout);
assert(shoot.tap === 'skip=msl', shoot.tap);

const hang = uiParseTapDumpFromTree([
    'missileGate: prepTimeoutHang=1 streak=4 dist=142.0 ang=28.0 lz=0.80'
]);
assert(hang.prepTimeout === 'hang', hang.prepTimeout);

const alley = uiParseTapDumpFromTree([
    'alleyTime: in=0 left=0 held=0 why=hang dist=115.0 ang=110.0 lz=-0.34',
    'missileGate: prepTimeoutHang=1 streak=4 dist=115.0 ang=110.0 lz=-0.34'
]);
assert(alley.alleyTime && alley.alleyTime.indexOf('why=hang') >= 0, alley.alleyTime);
assert(alley.prepTimeout === 'hang', alley.prepTimeout);

console.log('tap-trail-smoke: ok');
