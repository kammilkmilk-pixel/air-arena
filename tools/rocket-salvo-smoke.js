// ============================================================================
// rocket-salvo-smoke.js — human 1–9 picker, ammo cap, AI default 3, persist
// ============================================================================
'use strict';

const path = require('path');
const assert = require('assert');

const store = {};
global.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
};

global.CONFIG = require(path.join(__dirname, '../js/core/config.js'));
require(path.join(__dirname, '../js/logic/rocket.js'));
const R = global.AirArenaRocket;
assert(R, 'AirArenaRocket missing');

assert.strictEqual(R.salvoPerTurn(), 3, 'CONFIG default salvo remains 3 (AI fallback)');
assert.strictEqual(R.salvoPickerMax(), 9, 'picker max is 9');
assert.strictEqual(R.sanitizeSalvoCount(0), 1);
assert.strictEqual(R.sanitizeSalvoCount(99), 9);
assert.strictEqual(R.sanitizeSalvoCount(5, 7), 5);
assert.strictEqual(R.sanitizeSalvoCount(9, 7), 7, '7 left → picker/fire cap 7');
assert.strictEqual(R.sanitizeSalvoCount('x', 4), 3);

const human = {
    id: 'red',
    aiEnabled: false,
    matchSeatId: 'red-1',
    matchLoadout: 'fox2-rocket',
    rocketSalvoCount: 3,
    pylons: [{ id: 4, weaponType: 'rocket', state: 'armed', ammo: 7, ammoMax: 9 }]
};
assert.strictEqual(R.remainingFiringPodAmmo(human), 7);
assert.strictEqual(R.getTeamSalvoCount(human), 3);
human.rocketSalvoCount = 9;
assert.strictEqual(R.getTeamSalvoCount(human), 7, 'human pick 9 with 7 ammo fires 7');
assert.strictEqual(R.setTeamSalvoCount(human, 5), 5);
assert.strictEqual(human.rocketSalvoCount, 5);
assert.strictEqual(R.loadPersistedSalvo('red-1', 'fox2-rocket'), 5, 'persist per seat/loadout');
assert.strictEqual(R.loadPersistedSalvo('red-1', 'strike'), null, 'other loadout stays default');

const ai = {
    id: 'blue',
    aiEnabled: true,
    rocketSalvoCount: 9,
    pylons: [{ id: 4, weaponType: 'rocket', state: 'armed', ammo: 9, ammoMax: 9 }]
};
assert.strictEqual(R.getTeamSalvoCount(ai), 3, 'AI ignores picker and keeps default 3');
ai.pylons[0].ammo = 2;
assert.strictEqual(R.getTeamSalvoCount(ai), 2, 'AI uses remaining when less than 3');

const delay = R.launchDelaySteps();
assert.strictEqual(R.launchStepForIndex(0, 3), delay);
assert.strictEqual(R.launchStepForIndex(1, 3), delay + R.intervalSteps());
assert.strictEqual(R.launchStepForIndex(2, 3), delay + 2 * R.intervalSteps());
const last9 = R.launchStepForIndex(8, 9);
assert.ok(last9 <= 100, '9-round salvo must fit in the turn, last=' + last9);
assert.ok(R.launchStepForIndex(1, 9) < R.launchStepForIndex(2, 9), 'compressed salvo stays ordered');

console.log('rocket-salvo-smoke: PASS');
