// ============================================================================
// ground-targets-smoke.js — Phase B ground-target schema + strike stores + blast
// ============================================================================
'use strict';

const path = require('path');
const assert = require('assert');

global.CONFIG = require(path.join(__dirname, '../js/core/config.js'));
const GT = require(path.join(__dirname, '../js/logic/ground-targets.js'));
const Doc = require(path.join(__dirname, '../js/ai/a2g-stores-doctrine.js'));
const MapLoader = (() => {
    // Minimal normalize via requiring is awkward (window.MapLoader). Inline schema check.
    return null;
})();

// Schema normalize
const n = GT.normalizeGroundTarget({ id: 'gt_x', name: 'X', x: 1, z: 2, radius: 5, hp: 50, kind: 'radar' }, 0);
assert.strictEqual(n.id, 'gt_x');
assert.strictEqual(n.hp, 50);
assert.strictEqual(n.hpMax, 50);

// Load authored list
const loaded = GT.loadFromMapDoc({
    ground: { centerX: 10, centerZ: 20 },
    groundTargets: [
        { id: 'gt_a', name: 'A', x: 0, y: 0, z: 40, radius: 6, hp: 100, kind: 'depot' },
        { id: 'gt_b', name: 'B', x: 30, y: 0, z: 10, radius: 7, hp: 80, kind: 'aaa' }
    ]
});
assert.strictEqual(loaded.length, 2);
assert.strictEqual(GT.get('gt_a').name, 'A');

// Seed defaults when empty
GT.loadFromMapDoc({ ground: { centerX: 10, centerZ: 20 } });
assert.ok(GT.list().length >= 3, 'default seed should provide ≥3 targets');

// Designate + cycle via mock GameContext
const team = { designatedGroundTargetId: null };
global.GameContext = {
    getTeam: (id) => (id === 'red2' ? team : null),
    registerService: () => {}
};
GT.bindGameContext();
assert.strictEqual(GT.setDesignated('red2', GT.list()[0].id), true);
assert.strictEqual(GT.getDesignated('red2').id, GT.list()[0].id);
const cycled = GameContext.cycleDesignatedGroundTarget('red2', 1);
assert.ok(cycled && cycled.id);
assert.notStrictEqual(cycled.id, GT.list()[0].id);

// Nearest
const nearest = GT.getNearest({ x: 8, y: 40, z: 35 }, {});
assert.ok(nearest);

// Blast damage destroys
const tgt = GT.list()[0];
const beforeHp = tgt.hp;
const hits = GT.applyBlastDamage({ x: tgt.x, y: 1, z: tgt.z }, 10, beforeHp, { ownerId: 'red' });
assert.ok(hits.length >= 1);
assert.strictEqual(GT.get(tgt.id).destroyed, true);

// Strike stores with mock solvers
GT.resetHp();
const gt = GT.list()[0];
const shooter = {
    id: 'red',
    rocketFuze: 'vt',
    pylons: [
        { id: 1, weaponType: 'bomb', state: 'standby' },
        { id: 4, weaponType: 'rocket', state: 'standby', ammo: 9, ammoMax: 9 }
    ],
    wrapper: { position: { x: gt.x - 40, y: 42, z: gt.z - 5 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
};
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
    computeRocketAimSolution: () => ({
        fuze: 'impact', grounded: true, blastRadius: 6,
        aimWorld: { x: gt.x, y: 0, z: gt.z }, slantDist: 45
    })
};
global.AirArenaBomb = {
    teamBombPylons: (t) => (t.pylons || []).filter((p) => p.weaponType === 'bomb'),
    estimateReleaseState: () => ({
        pos: new THREE.Vector3(gt.x - 30, 40, gt.z),
        vel: new THREE.Vector3(20, -8, 0)
    }),
    computeBallisticPath: () => ({
        hitGround: true,
        impact: new THREE.Vector3(gt.x, 0, gt.z),
        points: []
    })
};

const bombEval = Doc.evaluateBombVsGround(shooter, gt, { distance: 30 });
assert.strictEqual(bombEval.ok, true, 'bomb vs ground should hit');
const impactEval = Doc.evaluateRocketImpactVsGround(shooter, gt, { distance: 45 });
assert.strictEqual(impactEval.ok, true, 'impact vs ground should hit');

const commit = Doc.pickStrikeStoresCommit(
    { queueAction: 'none', state: 'wingmanStrike', debug: { tree: [] } },
    shooter,
    gt,
    { distance: 30 }
);
assert.ok(commit && commit.queueAction === 'bomb', 'strike prefers bomb when window open');
assert.strictEqual(commit.groundTargetId, gt.id);

const stealCm = Doc.pickStrikeStoresCommit(
    { queueAction: 'flare', state: 'defensiveFlare' },
    shooter,
    gt,
    {}
);
assert.strictEqual(stealCm, null, 'strike must not steal flare');

// Map-loader schema field exists on normalize path via AirArenaGroundTargets
assert.ok(Array.isArray(require(path.join(__dirname, '../assets/maps/default.json')).groundTargets));
assert.ok(require(path.join(__dirname, '../assets/maps/default.json')).groundTargets.length >= 3);

console.log('ground-targets-smoke: PASS');
