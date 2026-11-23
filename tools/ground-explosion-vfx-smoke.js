/**
 * Smoke: multi-layer 3D ground explosion helpers + netplay trigger serialization.
 * Run: node tools/ground-explosion-vfx-smoke.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

global.THREE = {
    Vector3: function Vector3(x, y, z) {
        this.x = x || 0; this.y = y || 0; this.z = z || 0;
    },
    Quaternion: function Quaternion() {},
    Euler: function Euler() {},
    Matrix4: function Matrix4() {},
    Color: function Color() {}
};

global.CONFIG = {
    visuals: {
        groundExplosion: {
            enabled: true,
            collarCount: 20,
            fireballLobes: 12,
            plumeCount: 18
        }
    }
};

require('../js/view/ground-explosion-vfx.js');
const TurnLogSer = require('../js/core/turn-log-serialize.js');

const G = global.AirArenaGroundExplosionVfx;
function assert(cond, msg) {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
}

assert(!!G, 'AirArenaGroundExplosionVfx global missing');

// 1. Trigger classification
assert(G.isGroundExplosionTrigger({ type: 'ground_explosion', pos: { x: 10, y: 0, z: 5 } }),
    'explicit ground_explosion trigger recognized');
assert(G.isGroundExplosionTrigger({ type: 'explosion', pos: { x: 10, y: 0.4, z: 5 } }),
    'legacy low-altitude explosion auto-upgraded to ground blast');
assert(!G.isGroundExplosionTrigger({ type: 'explosion', pos: { x: 10, y: 24, z: 5 } }),
    'mid-air explosion must NOT be hijacked as ground blast');
assert(!G.isGroundExplosionTrigger({ type: 'flash', pos: { x: 0, y: 0, z: 0 } }),
    'flash trigger not treated as ground explosion');

// 2. Surface detection (ground vs building wall/roof)
assert(G.isSurfaceGround({ type: 'ground_explosion', pos: { x: 0, y: 0, z: 0 }, surface: 'ground' }),
    'explicit ground surface');
assert(!G.isSurfaceGround({ type: 'ground_explosion', pos: { x: 0, y: 12, z: 0 }, surface: 'building' }),
    'building hit should skip ground crater/collar');

// 3. Blast spec normalization & deterministic seeding
const bombSpec = G.computeBlastSpec({ type: 'ground_explosion', pos: { x: 1, y: 0, z: 2 }, radius: 10, scale: 1.35, surface: 'ground' });
assert(bombSpec.isGround === true && bombSpec.radius === 10 && Math.abs(bombSpec.scale - 1.35) < 1e-6, 'bomb spec preserved');

const s1 = G.seedFromTrigger({ step: 14, pos: { x: 42.5, y: 0, z: -18.2 } });
const s2 = G.seedFromTrigger({ step: 14, pos: { x: 42.5, y: 0, z: -18.2 } });
assert(s1 === s2 && s1 > 0, 'deterministic seed for ACMI scrubbing');

// 4. Turn-log serializer preserves radius & surface for netplay
const sampleLog = {
    turn: 1,
    vfxTriggers: [{
        type: 'ground_explosion',
        step: 22,
        pos: { x: 58, y: 0, z: -52 },
        radius: 10,
        scale: 1.35,
        seed: 987654321,
        surface: 'ground'
    }]
};
const plain = TurnLogSer.serializeTurnLog(sampleLog);
const revived = TurnLogSer.hydrateTurnLog(plain);
const t0 = revived.vfxTriggers[0];
assert(t0.type === 'ground_explosion' && t0.radius === 10 && t0.surface === 'ground' && t0.seed === 987654321,
    'turn-log-serialize preserves ground_explosion fields');

// 5. Index loads ground-explosion-vfx.js
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert(indexSrc.includes('js/view/ground-explosion-vfx.js'), 'index.html must load ground-explosion-vfx.js');

console.log('ground-explosion-vfx-smoke: PASS');
