// ============================================================================
// pilot-tuning-defaults.js - Shared AI tuning defaults (browser + Node)
// Keep in sync across pilot-ai.js, ai-regression.js, ai-autotune.js
// ============================================================================
(function initPilotTuningDefaults(root, factory) {
    const defaults = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = defaults;
        module.exports.PARAM_KEYS = Object.keys(defaults);
    }
    if (root) {
        root.AIR_ARENA_AI_DEFAULTS = defaults;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    return {
        energyCriticalAp: 52,
        lowAp: 65,
        stallPitchThreshold: 0.16,
        minRecoverAlt: 22,
        stallRecoverBonus: 7.5,
        climbPenalty: 6.2,
        gunRange: 70,
        gunAngle: 22,
        missileMinRange: 35,
        missileMaxRange: 120,
        missileAngle: 27,
        interceptTurnGain: 0.22,
        recoverPitchBias: -0.2,
        hybridAggression: 0.55,
        combatBandMin: 35,
        combatBandMax: 92,
        combatBandHardMax: 108
    };
});
