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

const fs = require('fs');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
assert.ok(/id="sms-salvo-picker"/.test(html) && /id="ops-wpn-salvo"/.test(html), 'stepper roots present');
assert.ok(/data-salvo-delta="-1"/.test(html) && /data-salvo-delta="1"/.test(html), 'minus/plus stepper');
assert.ok(!/sms-salvo-grid|ops-wpn-salvo-grid|data-salvo="9"/.test(html), '1–9 grid must be gone');
assert.strictEqual((html.match(/class="sms-salvo-step"/g) || []).length, 2);
assert.strictEqual((html.match(/class="ops-salvo-step"/g) || []).length, 2);

const hudSrc = fs.readFileSync(path.join(__dirname, '../js/view/hud.js'), 'utf8');
assert.ok(!/lcos-rocket-commit-x/.test(hudSrc), 'no commit X in the VT circle');
assert.ok(!/齊射×\$\{salvoN\}·鎖定/.test(hudSrc), 'rocket HUD must not keep 鎖定 after commit');
assert.ok(/paintPipperColor\(false, '#ffffff'\)/.test(hudSrc), 'enclose-without-ENT is white');
assert.ok(/lcosPipper\.style\.opacity = '0\.4'/.test(hudSrc), 'enclose-without-ENT lowers opacity');
assert.ok(/if \(queued && vtHit\) \{\s*paintPipperColor\(true\)/.test(hudSrc), 'ENT + enclose goes red');

const rocketSrc = fs.readFileSync(path.join(__dirname, '../js/logic/rocket.js'), 'utf8');
assert.ok(!/intensity = 0\.45 \+ 0\.25 \* Math\.sin/.test(rocketSrc), 'no nest idle glow at commit');
assert.ok(/Nest flame waits for actual launch/.test(rocketSrc), 'flame comment documents launch-only');
assert.ok(/commitHot \? 0xff0055 : \(enclosed \? 0xffffff/.test(rocketSrc), '3D VT ring white until ENT');
assert.ok(!/showCommitX/.test(rocketSrc), '3D VT disc has no commit X');

console.log('rocket-salvo-smoke: PASS');
