'use strict';

const RadioCues = require('../js/core/radio-cues.js');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

const teams = {
    red: {
        id: 'red',
        matchActive: true,
        callsign: 'REI',
        chain: [{ fire: 'gun' }],
        pylons: [],
        aiLastAction: { state: 'urbanRouteEscape', reason: 'building-escaping' }
    },
    red2: { id: 'red2', matchActive: true, callsign: 'HAWK', chain: [] },
    blue: {
        id: 'blue',
        matchActive: true,
        callsign: 'FOX',
        chain: [{ fire: 'missile' }],
        pylons: [{ weaponType: 'fox1', state: 'armed' }],
        activeMissiles: [{ launchStep: 12, missileType: 'fox1' }]
    },
    blue2: {
        id: 'blue2',
        matchActive: true,
        callsign: 'EMBER',
        chain: [],
        aiLastAction: { state: 'safetyBreakRight', joyX: 0.55 }
    },
    red3: {
        id: 'red3',
        matchActive: true,
        callsign: 'KITE',
        chain: [{ fire: 'missile' }],
        pylons: [{ weaponType: 'fox2', state: 'empty' }],
        activeMissiles: [{ launchStep: 8, missileType: 'fox2' }],
        aiLastAction: { state: 'mandatoryMergeBreak', joyX: -0.8 },
        wasFlaresArmedThisTurn: true,
        wasChaffArmedThisTurn: true
    }
};

const log = {
    turn: 3,
    destroyed: { red2: true },
    killedBy: { red2: { attackerId: 'blue', weapon: 'missile', step: 40 } }
};

const cues = RadioCues.buildFromTurn(log, {
    teams,
    activeIds: ['red', 'red2', 'blue', 'blue2', 'red3']
});

const events = cues.map((c) => `${c.speakerSeatId}:${c.event}`);
assert(events.indexOf('red:fire_gun') >= 0, 'expected fire_gun from red');
assert(events.indexOf('red:urban_escape') < 0, 'urban_escape radio is silenced');
assert(events.indexOf('blue:illuminate') >= 0, 'expected radar lock from blue FOX-1');
assert(events.indexOf('blue:fire_fox1') >= 0, 'expected Fox 1 launch call');
assert(events.indexOf('red3:fire_msl') >= 0, 'expected Fox 2 launch call');
assert(events.indexOf('red3:break_left') >= 0, 'expected break left');
assert(events.indexOf('blue2:break_right') >= 0, 'expected break right');
assert(events.indexOf('red3:chaff_away') >= 0, 'expected chaff away');
assert(events.indexOf('red3:flare_away') >= 0, 'expected flare away');
assert(events.indexOf('blue:kill') >= 0, 'expected kill from blue');
assert(events.indexOf('red:wingman_down') >= 0, 'expected wingman_down from living red');
assert(RadioCues.EVENTS.length === 11, 'frozen event set size');
assert(RadioCues.formatCue({ event: 'illuminate', callsign: 'FOX' }) === 'FOX, Radar lock.', 'radar lock line');
assert(RadioCues.formatCue({ event: 'fire_fox1', callsign: 'FOX' }) === 'FOX, Fox 1.', 'fox 1 line');
assert(RadioCues.formatCue({ event: 'break_right', callsign: 'HAWK' }) === 'HAWK, Break right.', 'break right line');
assert(RadioCues.formatCue({ event: 'chaff_away', callsign: 'REI' }) === 'REI, Chaff away.', 'chaff line');
assert(RadioCues.formatCue({ event: 'flare_away', callsign: 'REI' }) === 'REI, Flare away.', 'flare line');
const at = RadioCues.cueAtStep(cues, 40, 22);
assert(at && at.event, 'cueAtStep finds a live cue');
assert(RadioCues.formatCue(at).indexOf(at.callsign) >= 0, 'format includes callsign');
assert(
    RadioCues.formatCue({ event: 'fire_gun', callsign: 'REI' }) === 'REI, Guns.',
    'short gun brevity'
);
assert(!RadioCues.formatCue({ event: 'urban_escape', callsign: 'FOX' }), 'no urban area line');
['illuminate', 'fire_gun', 'fire_msl', 'fire_fox1', 'break_left', 'break_right', 'chaff_away', 'flare_away', 'kill', 'wingman_down'].forEach((ev) => {
    const line = RadioCues.formatCue({ event: ev, callsign: 'FOX' });
    assert(line.indexOf('FOX') === 0, `voice line starts with callsign: ${ev}`);
    assert(!/[\u4e00-\u9fff]/.test(line), `no CJK in voice line: ${ev}`);
    assert(/\./.test(line), `complete english sentence: ${ev}`);
    assert(!/breaking off|urban area|Opening fire|Illuminating|Friendly aircraft/i.test(line), `short brevity: ${ev}`);
    assert(line.split(/\s+/).length <= 5, `few words: ${ev}`);
});

const sameStep = RadioCues.cuesBetween(cues, -1, 0);
assert(sameStep.some((c) => c.event === 'fire_gun'), 'cuesBetween includes step 0 gun');
assert(sameStep.every((c) => Number(c.step) <= 0), 'cuesBetween respects range');
const killBatch = RadioCues.cuesBetween(cues, 39, 44);
assert(killBatch.some((c) => c.event === 'kill'), 'cuesBetween includes kill');
assert(killBatch.some((c) => c.event === 'wingman_down'), 'same-time window keeps wingman_down');

console.log('radio-cues-smoke: ok', events.join(', '));
