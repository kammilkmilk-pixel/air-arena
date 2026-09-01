#!/usr/bin/env node
/**
 * A.0 seek_angle TAP preferred catalog + safety fallback (live pilot-ai.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    pickSeekAngleTacticalWinner('), 'missing pickSeekAngleTacticalWinner');
assert(src.includes('    isSeekAnglePreferredTapState('), 'missing isSeekAnglePreferredTapState');
assert(src.includes('    tapApproachEntryUsable('), 'missing tapApproachEntryUsable');
assert(src.includes("ctx._tacticalRole === 'seek_angle'"), 'planTacticalApproach missing seek_angle gate');
assert(src.includes('tapRoleGate: pref='), 'missing tapRoleGate needle');
assert(src.includes("st === 'tacticalLagPursuit'"), 'lag not in preferred set');
assert(src.includes("st === 'tacticalBeamReposition'"), 'beam not in preferred set');
assert(src.includes('if (!Number.isFinite(score) || score < 20) return false;'), 'usable score floor must stay 20');
assert(src.includes('ev.buildingHit && Number.isFinite(ev.minAltitude) && ev.minAltitude < 12'), 'usable buildingHit floor must stay 12');

function isSeekAnglePreferredTapState(state) {
    const st = String(state || '');
    return st === 'tacticalLagPursuit' || st === 'tacticalBeamReposition';
}

function tapApproachEntryUsable(entry) {
    if (!entry || !entry.evalResult || !entry.candidate) return false;
    const score = Number(entry.score);
    if (!Number.isFinite(score) || score < 20) return false;
    const ev = entry.evalResult;
    if (ev.buildingHit && Number.isFinite(ev.minAltitude) && ev.minAltitude < 12) return false;
    return true;
}

function pickSeekAngleTacticalWinner(scored) {
    const list = Array.isArray(scored) ? scored : [];
    const pickFrom = (pool) => {
        if (!pool.length) return { pick: null };
        return {
            pick: pool.reduce((a, b) => (Number(b.score) > Number(a.score) ? b : a), pool[0])
        };
    };
    const preferred = list.filter((e) => isSeekAnglePreferredTapState(e.candidate && e.candidate.state));
    const prefTied = pickFrom(preferred);
    if (tapApproachEntryUsable(prefTied.pick)) {
        const st = prefTied.pick.candidate.state;
        return {
            entry: prefTied.pick,
            gateNote: `tapRoleGate: pref=${st} n=${preferred.length} fallback=0`
        };
    }
    const fullTied = pickFrom(list);
    const fb = fullTied.pick && fullTied.pick.candidate ? fullTied.pick.candidate.state : 'none';
    return {
        entry: fullTied.pick,
        gateNote: `tapRoleGate: pref=none n=${preferred.length} fallback=1 pick=${fb}`
    };
}

function entry(state, score, extra) {
    return {
        candidate: { state },
        score,
        evalResult: Object.assign({ buildingHit: false, minAltitude: 40 }, extra || {})
    };
}

const t92 = [
    entry('tacticalEnergyCruise', 291),
    entry('tacticalHighPerch', 281.1),
    entry('tacticalLagPursuit', 200),
    entry('tacticalBeamReposition', 190)
];
const win = pickSeekAngleTacticalWinner(t92);
assert(win.entry.candidate.state === 'tacticalLagPursuit', 'T92 should pick lag over cruise 291');
assert(win.gateNote.indexOf('fallback=0') >= 0, win.gateNote);
assert(win.gateNote.indexOf('pref=tacticalLagPursuit') >= 0, win.gateNote);

const unsafeLag = [
    entry('tacticalEnergyCruise', 291),
    entry('tacticalLagPursuit', 80, { buildingHit: true, minAltitude: 8 }),
    entry('tacticalBeamReposition', 15)
];
const fb = pickSeekAngleTacticalWinner(unsafeLag);
assert(fb.entry.candidate.state === 'tacticalEnergyCruise', 'unsafe pref falls back to cruise');
assert(fb.gateNote.indexOf('fallback=1') >= 0, fb.gateNote);

const noPref = [entry('tacticalEnergyCruise', 100), entry('tacticalHighPerch', 90)];
const np = pickSeekAngleTacticalWinner(noPref);
assert(np.entry.candidate.state === 'tacticalEnergyCruise', 'no pref keeps cruise');
assert(np.gateNote.indexOf('n=0') >= 0 && np.gateNote.indexOf('fallback=1') >= 0, np.gateNote);

const beamOnly = [entry('tacticalEnergyCruise', 250), entry('tacticalBeamReposition', 40)];
const bo = pickSeekAngleTacticalWinner(beamOnly);
assert(bo.entry.candidate.state === 'tacticalBeamReposition', 'beam preferred when lag absent');
assert(bo.gateNote.indexOf('fallback=0') >= 0, bo.gateNote);

console.log('tap-role-gate-smoke: ok');
