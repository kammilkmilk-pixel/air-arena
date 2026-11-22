// ============================================================================
// weapon-envelope-smoke.js — Phase 0 typed envelope regression
// ============================================================================
const path = require('path');
const assert = require('assert');

const CONFIG = require(path.join(__dirname, '../js/core/config.js'));
global.CONFIG = CONFIG;

const env = require(path.join(__dirname, '../js/ai/weapon-envelope.js'));

function main() {
    env.refreshFromConfig(CONFIG);

    const fox2 = env.getMissileCombatEnvelope('fox2');
    const fox1 = env.getMissileCombatEnvelope('fox1');
    assert.strictEqual(fox2.missileType, 'fox2');
    assert.strictEqual(fox1.missileType, 'fox1');
    assert.strictEqual(fox2.missileMaxRange, CONFIG.weapons.fox2.maxFlightRange);
    assert.strictEqual(fox1.missileMaxRange, CONFIG.weapons.fox1.maxFlightRange);
    assert.strictEqual(fox1.missileMinRange, CONFIG.weapons.fox1.minArmingRange);
    assert.ok(fox1.missileMaxRange > fox2.missileMaxRange, 'fox1 should out-range fox2');

    const fieldsFox2 = env.getAiEnvelopeFields('fox2');
    const fieldsFox1 = env.getAiEnvelopeFields('fox1');
    assert.strictEqual(fieldsFox2.missileMaxRange, fox2.missileMaxRange);
    assert.strictEqual(fieldsFox1.missileMaxRange, fox1.missileMaxRange);
    assert.strictEqual(fieldsFox2.missileType, 'fox2');
    assert.strictEqual(fieldsFox1.missileType, 'fox1');

    const storeRkt = env.getStoreCombatEnvelope('rocket');
    const storeBomb = env.getStoreCombatEnvelope('bomb');
    assert.strictEqual(storeRkt.aiEnabled, !!CONFIG.weapons.rocket.aiEnabled);
    assert.strictEqual(storeRkt.range, CONFIG.weapons.rocket.range);
    assert.strictEqual(storeBomb.blastRadius, CONFIG.weapons.bomb.blastRadius);

    // Default (no arg) stays fox2 for legacy AIR_ARENA_AI_DEFAULTS
    const defaults = env.getAiEnvelopeFields();
    assert.strictEqual(defaults.missileType, 'fox2');
    assert.strictEqual(defaults.missileMaxRange, fox2.missileMaxRange);

    const teamFox1 = {
        id: 'red',
        pylons: [
            { id: 0, state: 'armed', weaponType: 'fox1' },
            { id: 1, state: 'empty', weaponType: 'fox2' }
        ]
    };
    assert.strictEqual(env.inferTeamMissileType(teamFox1), 'fox1');
    assert.strictEqual(env.inferThreatMissileType(teamFox1), 'fox1');

    const teamMixed = {
        id: 'blue',
        pylons: [
            { id: 0, state: 'armed', weaponType: 'fox1' },
            { id: 1, state: 'armed', weaponType: 'fox2' }
        ]
    };
    assert.strictEqual(
        env.inferTeamMissileType(teamMixed, { distance: 140, angleDeg: 10 }),
        'fox1',
        'mixed load in fox1 band prefers fox1'
    );
    assert.strictEqual(
        env.inferTeamMissileType(teamMixed, { distance: 40, angleDeg: 10 }),
        'fox2',
        'mixed load below fox1 min prefers fox2'
    );
    assert.strictEqual(
        env.inferTeamMissileType(teamMixed, { distance: 90, angleDeg: 10 }),
        'fox1',
        'overlap nose-on midband prefers fox1'
    );
    assert.strictEqual(
        env.inferTeamMissileType(teamMixed, { distance: 100, angleDeg: 22 }),
        'fox1',
        'overlap 80–120 aligned (not only ≤18°) prefers fox1'
    );
    assert.strictEqual(
        env.inferTeamMissileType(teamMixed, { distance: 90, angleDeg: 30 }),
        'fox2',
        'overlap loose aspect prefers fox2'
    );
    assert.strictEqual(
        env.inferTeamMissileType(teamMixed, { distance: 70, angleDeg: 10 }),
        'fox2',
        'overlap knife band prefers fox2'
    );

    // Live sticky must not override geometry (fox2 powering at fox1 standoff range).
    const teamStickyFox2 = {
        id: 'red',
        pylons: [
            { id: 0, state: 'standby', weaponType: 'fox1' },
            { id: 1, state: 'powering', weaponType: 'fox2' }
        ]
    };
    assert.strictEqual(
        env.inferTeamMissileType(teamStickyFox2, { distance: 140, angleDeg: 12 }),
        'fox1',
        'geometry prefers fox1 even when fox2 is powering'
    );
    assert.strictEqual(
        env.inferTeamMissileType(teamStickyFox2, { distance: 140, angleDeg: 12, respectLive: true }),
        'fox2',
        'respectLive keeps SMS sticky when requested'
    );

    const drift = env.assertMatchesConfig(CONFIG);
    assert.ok(drift.ok, `config drift: ${(drift.drift || []).join('; ')}`);

    console.log('weapon-envelope-smoke: PASS');
    console.log(`  fox2 max=${fox2.missileMaxRange} fox1 max=${fox1.missileMaxRange}`);
}

main();
