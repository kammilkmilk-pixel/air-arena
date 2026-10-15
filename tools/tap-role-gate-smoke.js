#!/usr/bin/env node
/**
 * A.0 seek_angle + A.2a press/extend + B2 recommit/defend TAP preferred catalog + safety fallback.
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
assert(src.includes('    pickRoleCatalogWinner('), 'missing pickRoleCatalogWinner');
assert(src.includes('    isSeekAnglePreferredTapState('), 'missing isSeekAnglePreferredTapState');
assert(src.includes('    isPressPreferredTapState('), 'missing isPressPreferredTapState');
assert(src.includes('    isExtendPreferredTapState('), 'missing isExtendPreferredTapState');
assert(src.includes('    isRecommitPreferredTapState('), 'missing isRecommitPreferredTapState');
assert(src.includes('    isDefendPreferredTapState('), 'missing isDefendPreferredTapState');
assert(src.includes('    tapApproachEntryUsable('), 'missing tapApproachEntryUsable');
assert(src.includes("ctx._tacticalRole === 'seek_angle'"), 'planTacticalApproach missing seek_angle gate');
assert(src.includes("ctx._tacticalRole === 'press'"), 'planTacticalApproach missing press gate');
assert(src.includes("ctx._tacticalRole === 'extend'"), 'planTacticalApproach missing extend gate');
assert(src.includes("ctx._tacticalRole === 'recommit'"), 'planTacticalApproach missing recommit gate');
assert(src.includes("ctx._tacticalRole === 'defend'"), 'planTacticalApproach missing defend gate');
assert(src.includes('tapRoleGate: ${rolePrefix}pref='), 'missing tapRoleGate needle');
assert(src.includes('role=${role} '), 'press/extend needle must tag role=');
assert(src.includes('    nameTacticalApproachSkip('), 'missing nameTacticalApproachSkip');
assert(src.includes('    tapDumpHeldRoleSuffix('), 'missing tapDumpHeldRoleSuffix');
assert(src.includes('tapSkip=${this.nameTacticalApproachSkip({'), 'missing tapSkip needle');
assert(src.includes('tacticalApproach: none tapNone=${why}'), 'missing tapNone needle');
assert(src.includes("return 'merge'"), 'tapSkip must name merge');
assert(src.includes("return 'steepDive'"), 'tapSkip must name steepDive');
assert(src.includes("return fail('emptyScored')"), 'tapNone must name emptyScored');
assert(src.includes("return fail('buildingHit')"), 'tapNone must name buildingHit');
assert(src.includes("return fail('scoreFloor')"), 'tapNone must name scoreFloor');
assert(src.includes("st === 'tacticalLagPursuit'"), 'lag not in preferred set');
assert(src.includes("st === 'tacticalBeamReposition'"), 'beam not in preferred set');
assert(src.includes("st === 'tacticalLeadIntercept'"), 'lead not in press preferred set');
assert(src.includes("st === 'tacticalCorridorCut'"), 'corridorCut not in press preferred set');
assert(src.includes("st === 'tacticalEnergyCruise'"), 'cruise not in extend preferred set');
assert(src.includes('if (!Number.isFinite(score) || score < 20) return false;'), 'usable score floor must stay 20');
assert(src.includes('ev.buildingHit && Number.isFinite(ev.minAltitude) && ev.minAltitude < 12'), 'usable buildingHit floor must stay 12');

function nameTacticalApproachSkip(flags) {
    if (flags.climb) return 'climb';
    if (flags.ground) return 'ground';
    if (flags.energy) return 'energy';
    if (flags.msl) return 'msl';
    if (flags.merge) return 'merge';
    if (flags.knife) return 'knife';
    if (flags.highCover) return 'highCover';
    if (flags.gun) return 'gun';
    if (flags.earlyLock) return 'earlyLock';
    if (flags.steepDive) return 'steepDive';
    return 'other';
}

assert(nameTacticalApproachSkip({ merge: true, steepDive: true }) === 'merge', 'first-true skip is merge before steepDive');
assert(nameTacticalApproachSkip({ steepDive: true }) === 'steepDive', 'steepDive when merge off');
assert(nameTacticalApproachSkip({ climb: true, merge: true }) === 'climb', 'first-true skip is climb');
assert(nameTacticalApproachSkip({}) === 'other', 'empty flags is other');

function isRolePreferredTapState(role, state) {
    const st = String(state || '');
    if (role === 'seek_angle') return st === 'tacticalLagPursuit' || st === 'tacticalBeamReposition';
    if (role === 'press') return st === 'tacticalLeadIntercept' || st === 'tacticalCorridorCut';
    if (role === 'extend') return st === 'tacticalEnergyCruise' || st === 'tacticalEnergyCruiseCut';
    if (role === 'recommit') return st === 'tacticalLeadIntercept' || st === 'tacticalCorridorCut';
    if (role === 'defend') return st === 'tacticalBeamReposition';
    return false;
}

function tapApproachEntryUsable(entry) {
    if (!entry || !entry.evalResult || !entry.candidate) return false;
    const score = Number(entry.score);
    if (!Number.isFinite(score) || score < 20) return false;
    const ev = entry.evalResult;
    if (ev.buildingHit && Number.isFinite(ev.minAltitude) && ev.minAltitude < 12) return false;
    return true;
}

function pickRoleCatalogWinner(scored, role) {
    const list = Array.isArray(scored) ? scored : [];
    const pickFrom = (pool) => {
        if (!pool.length) return { pick: null };
        return {
            pick: pool.reduce((a, b) => (Number(b.score) > Number(a.score) ? b : a), pool[0])
        };
    };
    const preferred = list.filter((e) => isRolePreferredTapState(role, e.candidate && e.candidate.state));
    const prefTied = pickFrom(preferred);
    const rolePrefix = role === 'seek_angle' ? '' : `role=${role} `;
    if (tapApproachEntryUsable(prefTied.pick)) {
        const st = prefTied.pick.candidate.state;
        return {
            entry: prefTied.pick,
            gateNote: `tapRoleGate: ${rolePrefix}pref=${st} n=${preferred.length} fallback=0`
        };
    }
    const fullTied = pickFrom(list);
    const fb = fullTied.pick && fullTied.pick.candidate ? fullTied.pick.candidate.state : 'none';
    return {
        entry: fullTied.pick,
        gateNote: `tapRoleGate: ${rolePrefix}pref=none n=${preferred.length} fallback=1 pick=${fb}`
    };
}

function pickSeekAngleTacticalWinner(scored) {
    return pickRoleCatalogWinner(scored, 'seek_angle');
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

const pressWin = pickRoleCatalogWinner([
    entry('tacticalEnergyCruise', 291),
    entry('tacticalLagPursuit', 210),
    entry('tacticalLeadIntercept', 180),
    entry('tacticalCorridorCut', 160)
], 'press');
assert(pressWin.entry.candidate.state === 'tacticalLeadIntercept', 'press should pick lead over cruise 291');
assert(pressWin.gateNote.indexOf('role=press') >= 0 && pressWin.gateNote.indexOf('fallback=0') >= 0, pressWin.gateNote);

const pressUnsafe = pickRoleCatalogWinner([
    entry('tacticalEnergyCruise', 291),
    entry('tacticalLeadIntercept', 80, { buildingHit: true, minAltitude: 8 }),
    entry('tacticalCorridorCut', 15)
], 'press');
assert(pressUnsafe.entry.candidate.state === 'tacticalEnergyCruise', 'unsafe press pref falls back to cruise');
assert(pressUnsafe.gateNote.indexOf('role=press') >= 0 && pressUnsafe.gateNote.indexOf('fallback=1') >= 0, pressUnsafe.gateNote);

const extendWin = pickRoleCatalogWinner([
    entry('tacticalLeadIntercept', 240),
    entry('tacticalLagPursuit', 200),
    entry('tacticalEnergyCruise', 90)
], 'extend');
assert(extendWin.entry.candidate.state === 'tacticalEnergyCruise', 'extend should pick cruise over lead 240');
assert(extendWin.gateNote.indexOf('role=extend') >= 0 && extendWin.gateNote.indexOf('fallback=0') >= 0, extendWin.gateNote);

const extendUnsafe = pickRoleCatalogWinner([
    entry('tacticalLeadIntercept', 240),
    entry('tacticalEnergyCruise', 80, { buildingHit: true, minAltitude: 8 }),
    entry('tacticalEnergyCruiseCut', 15)
], 'extend');
assert(extendUnsafe.entry.candidate.state === 'tacticalLeadIntercept', 'unsafe extend pref falls back to lead');
assert(extendUnsafe.gateNote.indexOf('fallback=1') >= 0, extendUnsafe.gateNote);

const recommitWin = pickRoleCatalogWinner([
    entry('tacticalEnergyCruise', 291),
    entry('tacticalLagPursuit', 210),
    entry('tacticalLeadIntercept', 180),
    entry('tacticalCorridorCut', 160)
], 'recommit');
assert(recommitWin.entry.candidate.state === 'tacticalLeadIntercept', 'recommit should pick lead over cruise 291 / lag 210');
assert(recommitWin.gateNote.indexOf('role=recommit') >= 0 && recommitWin.gateNote.indexOf('fallback=0') >= 0, recommitWin.gateNote);

const recommitUnsafe = pickRoleCatalogWinner([
    entry('tacticalLagPursuit', 210),
    entry('tacticalLeadIntercept', 80, { buildingHit: true, minAltitude: 8 }),
    entry('tacticalCorridorCut', 15)
], 'recommit');
assert(recommitUnsafe.entry.candidate.state === 'tacticalLagPursuit', 'unsafe recommit pref falls back to lag');
assert(recommitUnsafe.gateNote.indexOf('role=recommit') >= 0 && recommitUnsafe.gateNote.indexOf('fallback=1') >= 0, recommitUnsafe.gateNote);

const defendWin = pickRoleCatalogWinner([
    entry('tacticalLeadIntercept', 240),
    entry('tacticalLagPursuit', 210),
    entry('tacticalBeamReposition', 40)
], 'defend');
assert(defendWin.entry.candidate.state === 'tacticalBeamReposition', 'defend should pick beam over lead 240 / lag 210');
assert(defendWin.gateNote.indexOf('role=defend') >= 0 && defendWin.gateNote.indexOf('fallback=0') >= 0, defendWin.gateNote);

const defendUnsafe = pickRoleCatalogWinner([
    entry('tacticalLagPursuit', 210),
    entry('tacticalBeamReposition', 80, { buildingHit: true, minAltitude: 8 })
], 'defend');
assert(defendUnsafe.entry.candidate.state === 'tacticalLagPursuit', 'unsafe defend pref falls back to lag');
assert(defendUnsafe.gateNote.indexOf('role=defend') >= 0 && defendUnsafe.gateNote.indexOf('fallback=1') >= 0, defendUnsafe.gateNote);

console.log('tap-role-gate-smoke: ok');
