#!/usr/bin/env node
/**
 * Unit & scenario smoke for AirArenaReplayDirector (1v1 & 2v2 multi-aircraft):
 *  1. 1v1 battle: opening overview -> dogfight -> gun hit -> missile intercept -> missile kill.
 *  2. 2v2 battle: discovers all 4 seats, rotates focus across multiple jets (roster fairness),
 *     tracks wingman gun kill, frames wide furball overview cleanly.
 *  3. Anti-thrash hold floor + deterministic scrub-safe getShotAt().
 *  4. All 6 camera archetypes produce finite poses with terrain altitude clamping.
 *  5. Manual OrbitControls yield, seat focus/unlock toggle, angle cycling.
 */
'use strict';

const assert = require('assert');
const Director = require('../js/view/replay-director.js');

function makeStraightPath(x0, y0, z0, dx, dy, dz) {
    const pts = [];
    const quats = [];
    const len = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(dx / len, dz / len);
    const half = yaw * 0.5;
    const q = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        pts.push({ x: x0 + dx * t, y: y0 + dy * t, z: z0 + dz * t });
        quats.push(q);
    }
    return { pts, quats };
}

function makeMslTrack(p0, p1) {
    const track = [];
    for (let i = 0; i <= 100; i++) {
        const t = i / 100;
        track.push({
            pos: {
                x: p0.x + (p1.x - p0.x) * t,
                y: p0.y + (p1.y - p0.y) * t,
                z: p0.z + (p1.z - p0.z) * t
            },
            quat: { x: 0, y: 0, z: 0, w: 1 }
        });
    }
    return track;
}

// ============================================================================
// 1. 1v1 Scenario (opening -> merge -> gun hit -> missile kill)
// ============================================================================
const log1v1 = [
    // Turn 1: Opening approach (wide overview)
    {
        turn: 1,
        red: Object.assign(makeStraightPath(0, 20, -60, 0, 0, 30), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(15, 22, 60, 0, 0, -30), { chain: [{ fire: 'none', throttle: 4 }] }),
        vfxTriggers: []
    },
    // Turn 2: Close merge & dogfight
    {
        turn: 2,
        red: Object.assign(makeStraightPath(0, 20, -12, 8, 2, 22), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(10, 21, 16, -6, 1, -20), { chain: [{ fire: 'none', throttle: 4 }] }),
        vfxTriggers: []
    },
    // Turn 3: Red autocannon burst hitting Blue
    {
        turn: 3,
        red: Object.assign(makeStraightPath(8, 22, 10, 0, 0, 25), { chain: [{ fire: 'gun', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(8, 22, 34, 0, 0, 22), { chain: [{ fire: 'none', throttle: 3 }], damageSteps: [25, 35, 45, 55] }),
        vfxTriggers: []
    },
    // Turn 4: Red FOX-2 missile intercept & kill on Blue at step 60
    {
        turn: 4,
        red: Object.assign(makeStraightPath(8, 22, 35, 0, 0, 20), { chain: [{ fire: 'fox2', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(8, 22, 56, 0, 0, 18), { chain: [{ fire: 'none', throttle: 3 }] }),
        redMslTracks: { 'p1': makeMslTrack({ x: 8, y: 22, z: 36 }, { x: 8, y: 22, z: 67 }) },
        redExplodedAt: { 'p1': 60 },
        destroyed: { blue: 60 },
        killedBy: { blue: { by: 'red', weapon: 'fox2', step: 60 } },
        deathCause: { blue: 'fox2' },
        vfxTriggers: []
    }
];

const sb1v1 = Director.analyzeTimeline(log1v1);
assert.deepStrictEqual(sb1v1.roster, ['red', 'blue'], '1v1 roster discovery');
assert(sb1v1.shots.length >= 3, `1v1 should produce multiple dynamic cuts, got ${sb1v1.shots.length}`);

// Opening turn should establish with tactical_wide
const openShot = Director.getShotAt(sb1v1, 1.05);
assert.strictEqual(openShot.mode, 'tactical_wide', 'Opening beat should be tactical_wide');

// Turn 3 mid-turn gun hit should frame over_shoulder from red -> blue
const gunShot = Director.getShotAt(sb1v1, 3.45);
assert.strictEqual(gunShot.mode, 'over_shoulder', `Gun hit should use over_shoulder, got ${gunShot.mode}`);
assert.strictEqual(gunShot.primaryId, 'red');
assert.strictEqual(gunShot.secondaryId, 'blue');

// Turn 4 missile kill at step 60 (replayTime = 4.60) should lock missile cam / kill_missile
const killShot = Director.getShotAt(sb1v1, 4.60);
assert.strictEqual(killShot.reason, 'kill_missile', `Kill beat should be kill_missile, got ${killShot.reason}`);
assert.strictEqual(killShot.mode, 'missile', `Missile kill should use missile cam, got ${killShot.mode}`);

// Anti-thrash: every non-final shot must hold >= 0.25 turns
for (let i = 0; i < sb1v1.shots.length - 1; i++) {
    const dur = sb1v1.shots[i].endTime - sb1v1.shots[i].startTime;
    assert(dur >= 0.25 - 1e-6, `Shot ${i} too short (${dur})`);
}

// Scrub determinism: scrubbing forward then backward returns identical shot
assert.deepStrictEqual(Director.getShotAt(sb1v1, 3.45), gunShot, 'Scrubbing back must be deterministic');

// ============================================================================
// 2. 2v2 Multi-Aircraft Scenario (4 jets: red, red2, blue, blue2)
// ============================================================================
const log2v2 = [
    // Turn 1: Wide 4-ship opening
    {
        turn: 1,
        red: Object.assign(makeStraightPath(-20, 22, -50, 5, 0, 26), { chain: [{ fire: 'none', throttle: 4 }] }),
        red2: Object.assign(makeStraightPath(22, 24, -55, -4, 0, 26), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(-18, 22, 50, 4, 0, -26), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue2: Object.assign(makeStraightPath(24, 24, 52, -5, 0, -26), { chain: [{ fire: 'none', throttle: 4 }] }),
        vfxTriggers: []
    },
    // Turn 2: Furball with all 4 jets within 60m
    {
        turn: 2,
        red: Object.assign(makeStraightPath(-15, 22, -24, 6, 1, 22), { chain: [{ fire: 'none', throttle: 4 }] }),
        red2: Object.assign(makeStraightPath(18, 24, -29, -2, 1, 24), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(-14, 22, 24, 2, 0, -22), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue2: Object.assign(makeStraightPath(19, 24, 26, -2, 0, -24), { chain: [{ fire: 'none', throttle: 4 }] }),
        vfxTriggers: []
    },
    // Turn 3: BLUE-1 maneuvers & fires gun on RED-1
    {
        turn: 3,
        red: Object.assign(makeStraightPath(-9, 23, -2, 0, 0, 20), { chain: [{ fire: 'none', throttle: 3 }], damageSteps: [30, 42] }),
        red2: Object.assign(makeStraightPath(16, 25, -5, 0, 0, 24), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(-9, 23, -24, 0, 0, 24), { chain: [{ fire: 'gun', throttle: 4 }] }),
        blue2: Object.assign(makeStraightPath(17, 25, 2, 0, 0, 22), { chain: [{ fire: 'none', throttle: 3 }] }),
        vfxTriggers: []
    },
    // Turn 4: RED-2 gun kills BLUE-2!
    {
        turn: 4,
        red: Object.assign(makeStraightPath(-9, 23, 18, -5, 0, 20), { chain: [{ fire: 'none', throttle: 4 }] }),
        red2: Object.assign(makeStraightPath(17, 25, 19, 0, 0, 25), { chain: [{ fire: 'gun', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(-12, 23, 0, -4, 0, 22), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue2: Object.assign(makeStraightPath(17, 25, 36, 0, 0, 20), { chain: [{ fire: 'none', throttle: 3 }], damageSteps: [20, 35, 50] }),
        destroyed: { blue2: 50 },
        killedBy: { blue2: { by: 'red2', weapon: 'gun', step: 50 } },
        deathCause: { blue2: 'gun' },
        vfxTriggers: []
    },
    // Turn 5: Ground strike explosion near low altitude
    {
        turn: 5,
        red: Object.assign(makeStraightPath(-14, 8, 38, 0, -2, 22), { chain: [{ fire: 'bomb', throttle: 4 }] }),
        red2: Object.assign(makeStraightPath(17, 25, 44, -6, 0, 20), { chain: [{ fire: 'none', throttle: 4 }] }),
        blue: Object.assign(makeStraightPath(-16, 23, 22, 4, 0, 22), { chain: [{ fire: 'none', throttle: 4 }] }),
        vfxTriggers: [{ type: 'ground_explosion', step: 45, pos: { x: -14, y: 0, z: 54 } }]
    }
];

const sb2v2 = Director.analyzeTimeline(log2v2);
assert.deepStrictEqual(sb2v2.roster, ['red', 'red2', 'blue', 'blue2'], '2v2 roster must discover all 4 aircraft');
const focusedSubjects = new Set(sb2v2.shots.map((s) => s.primaryId));
assert(focusedSubjects.size >= 3, `2v2 director should cover multiple aircraft across both flights, covered: ${Array.from(focusedSubjects).join(',')}`);

// Turn 4 wingman gun kill must cut to red2 -> blue2
const wingmanKill = Director.getShotAt(sb2v2, 4.50);
assert.strictEqual(wingmanKill.primaryId, 'red2', `Expected red2 on wingman gun kill, got ${wingmanKill.primaryId}`);
assert.strictEqual(wingmanKill.secondaryId, 'blue2');
assert.strictEqual(wingmanKill.mode, 'over_shoulder');
assert.strictEqual(wingmanKill.reason, 'kill_gun');

// ============================================================================
// 3. All 6 Camera Archetypes + Terrain Floor Clamp
// ============================================================================
for (const mode of Director.CAMERA_MODES) {
    const sampleShot = {
        startTime: 4.0,
        endTime: 5.0,
        primaryId: 'red',
        secondaryId: 'blue',
        mode,
        missileKey: 'red:p1',
        reason: mode === 'flyby_hero' ? 'ground_strike' : 'maneuver',
        impactPos: { x: 0, y: 0.1, z: 40 },
        focusTurnIdx: 3
    };
    const pose = Director.computeShotPose(sampleShot, log1v1, 3, 0.5, null);
    assert(pose && pose.camPos && pose.targetPos, `Pose must exist for mode=${mode}`);
    assert(Number.isFinite(pose.camPos.x) && Number.isFinite(pose.camPos.y) && Number.isFinite(pose.camPos.z), `Finite camPos for ${mode}`);
    assert(pose.camPos.y >= 2.0, `Terrain clamp violated for mode=${mode}: y=${pose.camPos.y}`);
}

// ============================================================================
// 4. Runtime Manual Override, Seat Lock/Unlock, Angle Cycle
// ============================================================================
Director.setEnabled(true);
assert.strictEqual(Director.getState().enabled, true);
Director.onUserCameraInteract();
assert.strictEqual(Director.getState().enabled, false, 'Manual OrbitControls interaction must yield director');
assert.strictEqual(Director.focusSeat('blue2'), 'blue2', 'Clicking seat locks focus and re-enables director');
assert.strictEqual(Director.getState().enabled, true);
assert.strictEqual(Director.focusSeat('blue2'), null, 'Clicking locked seat again releases back to full auto');
const firstAngle = Director.cycleAngleOverride();
assert(Director.CAMERA_MODES.includes(firstAngle), 'cycleAngleOverride selects a valid camera mode');
for (let i = 0; i < 6; i++) Director.cycleAngleOverride();

console.log(`PASS replay-director-smoke (1v1 shots=${sb1v1.shots.length}, 2v2 shots=${sb2v2.shots.length}, 2v2 subjects=${Array.from(focusedSubjects).join('/')})`);
