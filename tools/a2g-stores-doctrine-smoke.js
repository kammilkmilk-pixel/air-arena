// ============================================================================
// a2g-stores-doctrine-smoke.js — AI rocket VT/Impact + bomb employment gates
// ============================================================================
'use strict';

const path = require('path');
const assert = require('assert');

global.CONFIG = require(path.join(__dirname, '../js/core/config.js'));
assert.strictEqual(CONFIG.weapons.rocket.aiEnabled, true, 'rocket.aiEnabled');
assert.strictEqual(CONFIG.weapons.bomb.aiEnabled, true, 'bomb.aiEnabled');
assert.ok(CONFIG.doctrine.munition.rocket, 'doctrine.munition.rocket');
assert.ok(CONFIG.doctrine.munition.bomb, 'doctrine.munition.bomb');

const env = require(path.join(__dirname, '../js/ai/weapon-envelope.js'));
const rktEnv = env.getStoreCombatEnvelope('rocket');
const bombEnv = env.getStoreCombatEnvelope('bomb');
assert.strictEqual(rktEnv.aiEnabled, true);
assert.strictEqual(rktEnv.vtRadius, CONFIG.weapons.rocket.vtRadius);
assert.strictEqual(bombEnv.blastRadius, CONFIG.weapons.bomb.blastRadius);

const Doc = require(path.join(__dirname, '../js/ai/a2g-stores-doctrine.js'));

const teamDryFox = {
    id: 'red',
    rocketFuze: 'vt',
    pylons: [
        { id: 1, weaponType: 'bomb', state: 'standby' },
        { id: 4, weaponType: 'rocket', state: 'standby', ammo: 9, ammoMax: 9 }
    ],
    wrapper: { position: { x: 0, y: 35, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
};
const foeMid = {
    id: 'blue',
    wrapper: { position: { x: 0, y: 34, z: 55 }, quaternion: { x: 0, y: 1, z: 0, w: 0 } }
};
const foeDirt = {
    id: 'blue',
    wrapper: { position: { x: 2, y: 6, z: 40 }, quaternion: { x: 0, y: 1, z: 0, w: 0 } }
};

assert.strictEqual(Doc.teamRocketAmmo(teamDryFox), 9);
assert.strictEqual(Doc.teamBombReady(teamDryFox), true);
assert.strictEqual(Doc.teamHasFoxMissile(teamDryFox), false);

// Geometric VT fallback when AirArenaRocket is absent
const vtGeom = Doc.evaluateRocketVtShot(teamDryFox, foeMid, {
    distance: 55, angleDeg: 12, localZ: 0.9, lineOfSightBlocked: false
});
assert.strictEqual(vtGeom.ok, true, 'VT geom fallback should pass nose-on mid band');
assert.strictEqual(vtGeom.fuze, 'vt');

const vtWide = Doc.evaluateRocketVtShot(teamDryFox, foeMid, {
    distance: 55, angleDeg: 40, localZ: 0.4, lineOfSightBlocked: false
});
assert.strictEqual(vtWide.ok, false, 'VT should reject wide aspect');

const vtLos = Doc.evaluateRocketVtShot(teamDryFox, foeMid, {
    distance: 55, angleDeg: 10, lineOfSightBlocked: true
});
assert.strictEqual(vtLos.ok, false, 'VT should require LOS');

// Mock solvers for Impact + bomb
global.THREE = {
    Vector3: class Vector3 {
        constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
        clone() { return new THREE.Vector3(this.x, this.y, this.z); }
        distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    }
};
global.AirArenaRocket = {
    ensurePodAmmo: (p) => Math.max(0, Number(p.ammo) || 0),
    setTeamFuzeMode: (t, f) => { t.rocketFuze = f; return f; },
    getTeamFuzeMode: (t) => (t.rocketFuze === 'impact' ? 'impact' : 'vt'),
    computeRocketAimSolution: (team, enemy) => {
        const fuze = team.rocketFuze === 'impact' ? 'impact' : 'vt';
        if (fuze === 'vt') {
            return {
                fuze: 'vt', anyVtHit: true, bestCpaDist: 3.2, vtRadius: 6,
                aimWorld: { x: 0, y: 34, z: 48 }, slantDist: 50
            };
        }
        const e = enemy.wrapper.position;
        return {
            fuze: 'impact', grounded: true, blastRadius: 8,
            aimWorld: { x: e.x, y: 0, z: e.z },
            slantDist: 45
        };
    }
};
global.AirArenaBomb = {
    teamBombPylons: (t) => (t.pylons || []).filter((p) => p.weaponType === 'bomb'),
    estimateReleaseState: () => ({
        pos: new THREE.Vector3(0, 35, 0),
        vel: new THREE.Vector3(0, -5, 40)
    }),
    computeBallisticPath: (_o, _v) => ({
        hitGround: true,
        impact: new THREE.Vector3(2, 0, 40),
        points: []
    })
};

const vtSol = Doc.evaluateRocketVtShot(teamDryFox, foeMid, {
    distance: 55, angleDeg: 10, lineOfSightBlocked: false
});
assert.strictEqual(vtSol.ok, true);
assert.strictEqual(vtSol.reason, 'vtHit');

const impHigh = Doc.evaluateRocketImpactShot(teamDryFox, foeMid, {});
assert.strictEqual(impHigh.ok, false, 'Impact should reject mid-altitude foe');

const impLow = Doc.evaluateRocketImpactShot(teamDryFox, foeDirt, {});
assert.strictEqual(impLow.ok, true, 'Impact should accept dirt-skimming foe with near CCIP');

const bombLow = Doc.evaluateBombShot(teamDryFox, foeDirt, {});
assert.strictEqual(bombLow.ok, true, 'Bomb should accept dirt-skimming foe under blast');

const bombHigh = Doc.evaluateBombShot(teamDryFox, foeMid, {});
assert.strictEqual(bombHigh.ok, false, 'Bomb should reject mid-altitude foe');

// pickStoresCommit: dry FOX + VT window → rocket VT; never steal CM / FOX-1 / gun sweet
const commitVt = Doc.pickStoresCommit(
    { queueAction: 'none', state: 'alignFirst', debug: { tree: [] } },
    teamDryFox,
    foeMid,
    { distance: 55, angleDeg: 10, lineOfSightBlocked: false, missileMinRange: 20, missileMaxRange: 120 }
);
assert.ok(commitVt && commitVt.queueAction === 'rocket' && commitVt.rocketFuze === 'vt', 'dry FOX should pick VT rocket');

const stealCm = Doc.pickStoresCommit(
    { queueAction: 'flare', state: 'defensiveFlare' },
    teamDryFox,
    foeMid,
    { distance: 55, angleDeg: 10 }
);
assert.strictEqual(stealCm, null, 'must not steal flare');

const stealFox1 = Doc.pickStoresCommit(
    { queueAction: 'missile', missileType: 'fox1', state: 'missileAttack' },
    teamDryFox,
    foeMid,
    { distance: 55, angleDeg: 10 }
);
assert.strictEqual(stealFox1, null, 'must not steal FOX-1');

const stealGunSweet = Doc.pickStoresCommit(
    { queueAction: 'gun', state: 'gunAttack' },
    teamDryFox,
    foeMid,
    { distance: 40, angleDeg: 10, gunSweetSpot: true }
);
assert.strictEqual(stealGunSweet, null, 'must not steal gun sweet spot');

const teamWithFox = {
    ...teamDryFox,
    pylons: [
        { id: 0, weaponType: 'fox2', state: 'armed' },
        { id: 4, weaponType: 'rocket', state: 'standby', ammo: 9, ammoMax: 9 }
    ]
};
const commitHoldFox = Doc.pickStoresCommit(
    { queueAction: 'none', state: 'alignFirst', debug: { tree: [] } },
    teamWithFox,
    foeMid,
    {
        distance: 55, angleDeg: 10, lineOfSightBlocked: false,
        missileMinRange: 20, missileMaxRange: 120, missileAngleDeg: 27
    }
);
assert.strictEqual(commitHoldFox, null, 'in-envelope FOX must keep missile priority over VT');

const commitOutEnv = Doc.pickStoresCommit(
    { queueAction: 'none', state: 'alignFirst', debug: { tree: [] } },
    teamWithFox,
    foeMid,
    {
        // Inside VT band (18–110) but below FOX min arming → out-of-envelope fill.
        distance: 22, angleDeg: 10, lineOfSightBlocked: false,
        missileMinRange: 50, missileMaxRange: 120, missileAngleDeg: 27
    }
);
assert.ok(commitOutEnv && commitOutEnv.rocketFuze === 'vt', 'out-of-FOX-envelope may fill with VT');

const commitImpact = Doc.pickStoresCommit(
    { queueAction: 'none', state: 'alignFirst', debug: { tree: [] } },
    teamDryFox,
    foeDirt,
    {
        distance: 40, angleDeg: 35, lineOfSightBlocked: false,
        missileMinRange: 20, missileMaxRange: 120
    }
);
assert.ok(
    commitImpact && (commitImpact.rocketFuze === 'impact' || commitImpact.queueAction === 'bomb'),
    'dirt-skimming should pick Impact rocket or bomb'
);

const action = { queueAction: 'none', state: 'alignFirst', debug: { tree: [] }, reason: 'base' };
Doc.applyStoresCommit(action, commitVt);
assert.strictEqual(action.queueAction, 'rocket');
assert.strictEqual(action.weapon, 'rocket');
assert.strictEqual(action.rocketFuze, 'vt');
assert.strictEqual(action.powerPylons, false);
assert.ok(String(action.debug.storesCommit).length > 0);

console.log('a2g-stores-doctrine-smoke: PASS');
