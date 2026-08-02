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
        env.inferTeamMissileType(teamMixed, { distance: 50, angleDeg: 10 }),
        'fox2',
        'mixed load outside fox1 min prefers fox2'
    );

    const drift = env.assertMatchesConfig(CONFIG);
    assert.ok(drift.ok, `config drift: ${(drift.drift || []).join('; ')}`);

    console.log('weapon-envelope-smoke: PASS');
    console.log(`  fox2 max=${fox2.missileMaxRange} fox1 max=${fox1.missileMaxRange}`);
}

main();
