#!/usr/bin/env node
/**
 * Turn clearance: held-stick arc may swap before the nest.
 * Temporary thaw on this swap only (ignores −160, may bank opposite).
 * Both arcs hitting does not swap. Dead-cut and clear-stick floors stay.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    shouldTurnClearanceSwap('), 'missing shouldTurnClearanceSwap');
assert(src.includes('    heldStickArcHits('), 'missing heldStickArcHits');
assert(src.includes('    turnClearNeedYaw('), 'missing turnClearNeedYaw');
assert(src.includes('    turnClearWallDir('), 'missing turnClearWallDir');
assert(src.includes("return pack(null, 'cap');"), 'cap must not count as a clean miss');
assert(src.includes("if (yaw >= needYaw) return pack(false, 'cover');"), 'cover stops on yaw, not meters');
assert(!src.includes('traveled >= need'), 'meter stop must stay out');
assert(src.includes('turnClear=1'), 'missing turnClear reason needle');
assert(src.includes('routeGate: swap=1'), 'missing route-gate swap needle');
assert(src.includes('routeGate: hard=1'), 'cap retest must name a hard keep');
assert(src.includes("own.stop === 'cap'"), 'hard retest only after a cap');
assert(src.includes('thrDown=1'), 'cap must be able to drop one throttle detent');
assert(src.includes('thrOwnStop='), 'probe must name the lower-throttle retest');
assert(src.includes("own.stop === 'hit' && other.stop === 'hit'"), 'both-hit retest only when both arcs hit');
assert(src.includes('hitOwnStop='), 'probe must name the both-hit throttle retest');
assert(!src.includes('hitLater=1'), 'hit-later keep stays reverted');
assert(!src.includes('closeKeep=1'), 'closing first-command rule stays reverted');
assert(!src.includes('noseKeep=1'), 'nose-on-point rule stays reverted');
assert(src.includes('    urbanRouteLowerThrottle('), 'missing urbanRouteLowerThrottle');
assert(src.includes('    heldClimbArc('), 'missing held climb arc');
assert(src.includes('pitchCmd: -maxPitch * climbScale'), 'climb arc must be simulated as flown');
assert(src.includes('best.pitchScale = climbScale'), 'flown pitch must match the simulated climb');
assert(src.includes('routeGate: climb=1'), 'climb keep must be named');
assert(src.includes("if (!ownOk && !otherOk && climbOpen)"), 'climb only after both sides stay illegal');
assert(src.includes('straightClimbOpen: !!altitudeLane.preferStraightClimb && !underRoofNow'), 'climb opens only on the lane flag and never under a slab');
assert(src.includes('!!opts.straightClimbOpen && !tableChoke'), 'table choke keeps climb closed');
assert(src.includes('out.pitchScale = out.routeGatePitchScale'), 'climb pitch must be restored after later writers');
assert(src.includes('if (!stick || stick.routeGate) return stick;'), 'table owner must not rewrite a gated stick');
assert(src.includes('if (!action || action.routeGate || !this.shouldHoldSoftUrbanThrottle(action)) return action;'), 'soft clamp must not rewrite a gated stick');
assert(src.includes('    routeFlownAction('), 'missing flown-command builder');
assert(src.includes('this.heldStickArcHits(teamId, this.routeFlownAction(teamId, ownAction), wallDir)'), 'own arc must be simulated as flown');
assert(src.includes('this.heldStickArcHits(teamId, this.routeFlownAction(teamId, otherAction), wallDir)'), 'other arc must be simulated as flown');
assert(!src.includes('this.heldStickArcHits(teamId, ownAction, wallDir)'), 'no raw joyY arc left');
assert(src.includes("pitchCmd: -maxPitch * (Number(action.pitchScale) || 0.28)"), 'flown pitch matches the escape writer default');
assert(src.includes('pitchCmd: -maxPitchCmd * (scoredEsc.pitchScale || 0.28)'), 'escape writer pitch is the one simulated');
assert(src.includes('out.rollAuth = out.routeGateRollAuth;'), 'gated roll authority must be restored');
assert(src.includes('routeGate: scoredEsc.routeGate || undefined,'), 'escape output must carry the gate tag');
assert(src.includes('const need = Math.max(0, -roof) + 4;'), 'climb cover is the roof deficit plus 4');
assert(src.includes("return pack(false, 'stall', ap);"), 'a climb that stalls is not cover');
assert(src.includes('this.applyUrbanRouteGate('), 'pick must run the route gate');
assert(src.includes('turnClearProbe:'), 'missing turn-clear probe');
assert(src.includes('ownAlt='), 'probe must name the altitude half');
assert(src.includes('best.turnClearAway = 1'), 'accepted stick must keep its bank');
assert(src.includes('out.joyX = out.routeGateJoyX;'), 'accepted stick must be restored after later writers');
assert(src.includes('!scoredEsc.turnClearAway'), 'glue lock must keep the gated bank');
assert(src.includes('if (stick.routeGate || stick.turnClearAway || opts.routeGate || opts.turnClearAway) return stick;'), 'recovery and nest exit must not level a gated stick');
assert(src.includes('Number.isFinite(n) && n > -160'), 'clear-stick floor must stay');
assert(src.includes('n < -160'), 'dead-cut floor must stay');

const gateAt = src.indexOf('this.applyUrbanRouteGate(');
const deadAt = src.indexOf('if (best && !best.routeGate && this.isDeadScoredEscapeCut(');
assert(gateAt > 0 && deadAt > gateAt, 'route gate must run before dead-cut');

function shouldTurnClearanceSwap(ownHit, otherHit) {
    return ownHit === true && otherHit === false;
}

assert(shouldTurnClearanceSwap(true, false), 'own hit and clean other side swaps');
assert(!shouldTurnClearanceSwap(true, true), 'both arcs hitting stays');
assert(!shouldTurnClearanceSwap(false, false), 'clean own side stays');
assert(!shouldTurnClearanceSwap(false, true), 'clean own side stays when the other hits');
assert(shouldTurnClearanceSwap(true, false), 'swap ignores a winner score above -160');
assert(!shouldTurnClearanceSwap(true, null), 'cap on the other side does not swap');
assert(!shouldTurnClearanceSwap(null, false), 'cap on the own side does not swap');

function turnClearNeedYaw(alpha) {
    const a = Math.abs(Number(alpha) || 0);
    let needYaw = Math.PI / 2 - Math.min(a, Math.PI / 2);
    if (needYaw < 0.05) needYaw = Math.PI / 2;
    return needYaw;
}

assert(Math.abs(turnClearNeedYaw(0) - Math.PI / 2) < 1e-9, 'dead-ahead stop is a quarter turn');
assert(Math.abs(turnClearNeedYaw(Math.PI / 6) - (Math.PI / 2 - Math.PI / 6)) < 1e-9, 'off-nose stop is the yaw left to abeam');
assert(Math.abs(turnClearNeedYaw(Math.PI / 2) - Math.PI / 2) < 1e-9, 'abeam stop still flies a quarter turn');

function urbanRouteLowerThrottle(throttle) {
    const t = Math.round(Number(throttle) || 0);
    if (t <= 1 || t > 5) return null;
    return t - 1;
}

assert(urbanRouteLowerThrottle(5) === 4, 'afterburner drops to military');
assert(urbanRouteLowerThrottle(4) === 3, 'military drops to cruise');
assert(urbanRouteLowerThrottle(2) === 1, 'idle drops to brake');
assert(urbanRouteLowerThrottle(1) === null, 'brake has no lower detent');

console.log('turn-clear-smoke: ok');
