// ============================================================================
// pilot-tuning-defaults.js - Shared AI tuning defaults (browser + Node)
// Combat ranges come from weapon-envelope.js ← CONFIG.weapons (H1 single source).
// ============================================================================
(function initPilotTuningDefaults(root, factory) {
    const defaults = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = defaults;
        module.exports.PARAM_KEYS = Object.keys(defaults);
    }
    if (root) {
        root.AIR_ARENA_AI_DEFAULTS = defaults;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (root) {
    let envelopeApi = (root && root.AirArenaWeaponEnvelope) || null;
    if (!envelopeApi && typeof module !== 'undefined' && module.exports) {
        try {
            // eslint-disable-next-line global-require
            envelopeApi = require('./weapon-envelope.js');
        } catch (_) {
            envelopeApi = null;
        }
    }

    const fromEnvelope = envelopeApi && typeof envelopeApi.getAiEnvelopeFields === 'function'
        ? envelopeApi.getAiEnvelopeFields()
        : {
            gunRange: 70,
            gunAngle: 22,
            missileMinRange: 20,
            missileMaxRange: 120,
            missileAngle: 27
        };

    return {
        energyCriticalAp: 52,
        lowAp: 65,
        stallPitchThreshold: 0.16,
        minRecoverAlt: 22,
        stallRecoverBonus: 7.5,
        climbPenalty: 6.2,
        // Combat ranges: CONFIG.weapons via weapon-envelope (do not hardcode elsewhere).
        gunRange: fromEnvelope.gunRange,
        gunAngle: fromEnvelope.gunAngle,
        missileMinRange: fromEnvelope.missileMinRange,
        missileMaxRange: fromEnvelope.missileMaxRange,
        missileAngle: fromEnvelope.missileAngle,
        interceptTurnGain: 0.22,
        recoverPitchBias: -0.2,
        hybridAggression: 0.55,
        combatBandMin: 35,
        combatBandMax: 92,
        combatBandHardMax: 108,
        // Below this alt (~canyon top): prioritize climb-out. Under-roof still lateral-first.
        // T130: 32→36 — reduce canyon dive→dirt-embed (r2 class).
        mandatoryClimbAlt: 36,
        // Scheme B: soften building pressure one tier (high→medium, medium→low).
        // T130: 1→0 — keep medium risk so planner/beam arm earlier.
        buildingRiskDowngrade: 0,
        // M2 radii profile: 'gap' (default) or 'legacy'. Override with ?buildingRisk=legacy
        buildingRiskProfile: 'gap',
        // WEGO route simulate horizon (1 current + N-1 continuations).
        // T130: 4→5 — see one more step of dive-into-facade.
        routePlanHorizon: 5,
        routeBeamWidth: 2,
        // Only run branched beam when cover risk is at least this ('low'|'medium'|'high').
        // T130: medium→low — beam during approach, not only after medium pressure.
        routeBeamMinRisk: 'low',
        // M19: escape → engage handoff thresholds (dense-urban survival).
        // T130 b1: tighter handoff so alignFirst/shallowDive cannot steal after escape.
        engageHandoffLowDist: 14,
        engageHandoffHighDistKeep: 18,
        engageHandoffMediumDist: 18,
        engageHandoffHighClimbDist: 18,
        engageHandoffFwdBlock: 18,
        engageHandoffLowFy: -0.2,
        engageHandoffDiveFy: -0.18,
        engageHandoffMediumFy: 0.12,
        engageHandoffHighFy: 0.22,
        engageHandoffMediumAlt: 30,
        engageHandoffHighAlt: 32,
        engageHandoffDiveAltMax: 52,
        engageHandoffContactDist: 14,
        engageHandoffContactDiveFy: -0.42,
        // Missile salvo vs enemy flares: prefer single when foe can waste both FOX-2s.
        enemyFlareLikelyAmmo: 2,
        missileSalvoDualChance: 0.22,
        missileSalvoDualChanceNoFlare: 0.48,
        // Flare decision jitter (1 = always keep when gate says flare).
        flareUrgentKeepChance: 0.96,
        flareSoftKeepChance: 0.72,
        // Tactical approach: random among near-ties only (|Δscore|≤eps). 0 disables.
        tacticalTieEps: 12,
        tacticalTieRandom: 1,
        // Phase B full roles: hold current TAP role this many turns (defend / head-on extend switch now).
        tacticalRoleHoldTurns: 2,
        // T88: merge-break S-turn — hold diverge side this many turns (localX flip after a pass).
        mergeDivergeHoldTurns: 3,
        // Soft-yield thin knife (crash vs combat efficiency): align/airspace/band reclaim.
        // Dump T140/T150: angMax 52 never overlapped alignFirst (need ang>38) → raise gun window.
        alignSoftFire: 1,
        // Missile soft fire ≤ doctrine maxLaunch (~32°); gun knife stays wide via gunAngMax.
        alignSoftFireAngMax: 34,
        alignSoftFireGunAngMax: 92,
        alignSoftFireLocalZMin: 0.18,
        alignSoftFireGunLocalZMin: 0.06,
        alignSoftFireKnifeDist: 32,
        alignSoftFireKnifeAngMax: 98,
        airspaceSoftBlend: 1,
        airspaceSoftBlendClearMin: 70,
        bandSoftCombat: 1,
        bandSoftCombatDist: 120,
        bandSoftCombatAngMax: 55,
        engageHandoffSoftReclaim: 1,
        engageHandoffSoftScoreMin: 0.58,
        // Lookahead: dense-urban almost never risk=low — allow medium at reduced blend weight.
        lookaheadMediumWeight: 0.52,
        lookaheadHighFarWeight: 0.22,
        lookaheadHighFarCoverDist: 28,
        // Far/high: band level-out yields to re-engage toward contact (T150 red/blue2 med>200).
        bandSoftCombatFarDist: 480,
        bandSoftCombatFarAngMax: 155,
        // Extreme off-boresight: do not park on alignFirst forever — yield to lead-capable gates.
        alignExtremeYieldAng: 105,
        missilePrepTimeoutTurns: 3,
        missilePrepTimeoutShootAng: 34,
        missilePrepTimeoutGunDistPad: 28,
        // Far disengage → airspace (T83/T76): score + rim blend toward fight.
        farReengageDist: 150,
        farReengageVeryDist: 250,
        airspaceFarBlend: 1,
        // Radial bleed (T100/T76): close fight still slides off-map — frac of hard radius + outDot.
        radialBleedFrac: 0.52,
        radialBleedDeepFrac: 0.72,
        radialBleedOutDot: 0.42,
        airspaceRadialBlend: 1,
        bandSoftRadialBleed: 1
    };
});
