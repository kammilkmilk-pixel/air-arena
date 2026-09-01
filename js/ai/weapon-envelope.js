// ============================================================================
// weapon-envelope.js - Single source for combat ranges → AI tuning fields
// Combat hit cones live in CONFIG.weapons; AI soft angles are doctrine-only.
// Typed envelopes (fox1 / fox2) so decide no longer assumes FOX-2 everywhere.
// ============================================================================
(function initWeaponEnvelope(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AirArenaWeaponEnvelope = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    /**
     * Fallback mirror of CONFIG.weapons gun/fox2/fox1 ranges.
     * Browser always refreshes from live CONFIG; Node loads CONFIG via require when possible.
     */
    const FALLBACK_COMBAT = {
        gunRange: 70,
        gunAngleRad: Math.PI / 24,
        // FOX-2 (legacy "missile*" aliases)
        missileMinRange: 35,
        missileMaxRange: 120,
        seekerRange: 120,
        seekerAngleRad: Math.PI / 12,
        // FOX-1
        fox1MinRange: 70,
        fox1MaxRange: 200,
        fox1SeekerRange: 200,
        fox1SeekerAngleRad: Math.PI / 14
    };

    /** AI decision soft windows (degrees) — wider than combat hit cones on purpose. */
    const AI_SOFT_DEG = {
        gunAngle: 22,
        missileAngle: 27
    };

    let combat = { ...FALLBACK_COMBAT };

    function readConfigObject() {
        if (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.weapons) return CONFIG;
        if (typeof module !== 'undefined' && module.exports) {
            try {
                // eslint-disable-next-line global-require, import/no-dynamic-require
                return require('../core/config.js');
            } catch (_) {
                return null;
            }
        }
        return null;
    }

    function refreshFromConfig(config) {
        const cfg = config || readConfigObject();
        const gun = cfg && cfg.weapons && cfg.weapons.gun;
        const fox2 = cfg && cfg.weapons && cfg.weapons.fox2;
        const fox1 = cfg && cfg.weapons && cfg.weapons.fox1;
        if (gun) {
            if (Number.isFinite(gun.range)) combat.gunRange = Number(gun.range);
            if (Number.isFinite(gun.angle)) combat.gunAngleRad = Number(gun.angle);
        }
        if (fox2) {
            if (Number.isFinite(fox2.minArmingRange)) combat.missileMinRange = Number(fox2.minArmingRange);
            if (Number.isFinite(fox2.maxFlightRange)) combat.missileMaxRange = Number(fox2.maxFlightRange);
            if (Number.isFinite(fox2.seekerRange)) combat.seekerRange = Number(fox2.seekerRange);
            if (Number.isFinite(fox2.seekerAngle)) combat.seekerAngleRad = Number(fox2.seekerAngle);
        }
        if (fox1) {
            if (Number.isFinite(fox1.minArmingRange)) combat.fox1MinRange = Number(fox1.minArmingRange);
            if (Number.isFinite(fox1.maxFlightRange)) combat.fox1MaxRange = Number(fox1.maxFlightRange);
            if (Number.isFinite(fox1.seekerRange)) combat.fox1SeekerRange = Number(fox1.seekerRange);
            if (Number.isFinite(fox1.seekerAngle)) combat.fox1SeekerAngleRad = Number(fox1.seekerAngle);
        } else {
            combat.fox1MinRange = FALLBACK_COMBAT.fox1MinRange;
            combat.fox1MaxRange = FALLBACK_COMBAT.fox1MaxRange;
            combat.fox1SeekerRange = FALLBACK_COMBAT.fox1SeekerRange;
            combat.fox1SeekerAngleRad = FALLBACK_COMBAT.fox1SeekerAngleRad;
        }
        return getCombatRanges();
    }

    function normalizeMissileType(missileType) {
        return missileType === 'fox1' ? 'fox1' : 'fox2';
    }

    /** Full snapshot (gun + both missile types). */
    function getCombatRanges() {
        return {
            gunRange: combat.gunRange,
            gunAngleRad: combat.gunAngleRad,
            missileMinRange: combat.missileMinRange,
            missileMaxRange: combat.missileMaxRange,
            seekerRange: combat.seekerRange,
            seekerAngleRad: combat.seekerAngleRad,
            fox1MinRange: combat.fox1MinRange || 70,
            fox1MaxRange: combat.fox1MaxRange || 200,
            fox1SeekerRange: combat.fox1SeekerRange || 200,
            fox1SeekerAngleRad: combat.fox1SeekerAngleRad || Math.PI / 14
        };
    }

    /**
     * Typed combat envelope for one munition.
     * @param {'fox1'|'fox2'|string} missileType
     */
    function getMissileCombatEnvelope(missileType) {
        refreshFromConfig();
        const t = normalizeMissileType(missileType);
        if (t === 'fox1') {
            return {
                missileType: 'fox1',
                missileMinRange: combat.fox1MinRange || 70,
                missileMaxRange: combat.fox1MaxRange || 200,
                seekerRange: combat.fox1SeekerRange || combat.fox1MaxRange || 200,
                seekerAngleRad: combat.fox1SeekerAngleRad || Math.PI / 14
            };
        }
        return {
            missileType: 'fox2',
            missileMinRange: combat.missileMinRange,
            missileMaxRange: combat.missileMaxRange,
            seekerRange: combat.seekerRange,
            seekerAngleRad: combat.seekerAngleRad
        };
    }

    function pylonTypeOf(p) {
        if (typeof pylonWeaponType === 'function') return pylonWeaponType(p);
        return (p && p.weaponType) || 'fox2';
    }

    /**
     * Next remaining munition after a shot (armed/standby/powering/empty-excluded).
     * Used for FOX-1 post-illuminate sequel (standoff reattack vs FOX-2 close).
     */
    function peekNextMissileType(team, opts = {}) {
        if (!team) return null;
        const pylons = team.pylons || [];
        const live = pylons.filter((p) => p && p.state && p.state !== 'empty');
        const hasFox1 = live.some((p) => pylonTypeOf(p) === 'fox1');
        const hasFox2 = live.some((p) => pylonTypeOf(p) === 'fox2');
        if (!hasFox1 && !hasFox2) return null;
        if (hasFox1 && hasFox2) {
            if (opts.preferFox1 === true) return 'fox1';
            return inferTeamMissileType(team, opts);
        }
        if (hasFox1) return 'fox1';
        return 'fox2';
    }

    /**
     * Infer preferred missile type from team pylons / geometry.
     * When both fox1+fox2 remain: geometry / preferFox1 wins — do NOT sticky-lock on
     * powering/armed live type (that blocked fox1↔fox2 switches; AI reconcile drops conflict).
     * Pass opts.respectLive=true to keep old SMS sticky (UI / threat mirrors).
     */
    function inferTeamMissileType(team, opts = {}) {
        if (!team) return 'fox2';
        // CONFIG.weapons.rocket is a stub (aiEnabled:false). Never infer missileType from it.
        if (opts.missileType === 'fox1' || opts.missileType === 'fox2') {
            return opts.missileType;
        }
        const pylons = team.pylons || [];
        const hasFox1 = pylons.some((p) => p && p.state !== 'empty' && pylonTypeOf(p) === 'fox1');
        const hasFox2 = pylons.some((p) => p && p.state !== 'empty' && pylonTypeOf(p) === 'fox2');
        if (hasFox1 && hasFox2) {
            // Optional SMS sticky (UI / threat mirrors) — before geometry.
            if (opts.respectLive === true) {
                let live = null;
                if (typeof teamLiveMissileType === 'function') {
                    live = teamLiveMissileType(team);
                } else {
                    const liveP = pylons.find((p) => p && (p.state === 'armed' || p.state === 'powering'));
                    live = liveP ? pylonTypeOf(liveP) : null;
                }
                if (live === 'fox1' || live === 'fox2') return live;
            }
            if (opts.preferFox1 === true) return 'fox1';
            if (opts.preferFox2 === true) return 'fox2';
            const dist = Number(opts.distance);
            const angDeg = Number(opts.angleDeg);
            const env1 = getMissileCombatEnvelope('fox1');
            const env2 = getMissileCombatEnvelope('fox2');
            const angOk1 = !Number.isFinite(angDeg) || angDeg < 28;
            const angOk2 = !Number.isFinite(angDeg) || angDeg < 36;
            const inFox1Band =
                Number.isFinite(dist) &&
                dist >= env1.missileMinRange &&
                dist <= env1.missileMaxRange &&
                angOk1;
            const inFox2Band =
                Number.isFinite(dist) &&
                dist >= env2.missileMinRange &&
                dist <= env2.missileMaxRange &&
                angOk2;
            if (inFox1Band && !inFox2Band) return 'fox1';
            if (inFox2Band && !inFox1Band) return 'fox2';
            if (inFox1Band && inFox2Band) {
                // Overlap (~70–120): knife / loose aspect → fox2; nose-on midband → fox1 (kill Pk).
                if (dist < 80 || (Number.isFinite(angDeg) && angDeg > 26)) return 'fox2';
                if (Number.isFinite(angDeg) && angDeg <= 18 && dist >= 85) return 'fox1';
                if (dist < 95) return 'fox2';
                return 'fox1';
            }
            if (Number.isFinite(dist) && dist > env2.missileMaxRange && dist <= env1.missileMaxRange) {
                return 'fox1';
            }
            return 'fox2';
        }
        if (opts.respectLive === true && typeof teamLiveMissileType === 'function') {
            const live = teamLiveMissileType(team);
            if (live === 'fox1' || live === 'fox2') return live;
        }
        if (hasFox1) return 'fox1';
        return 'fox2';
    }

    /**
     * Enemy threat envelope: if they carry fox1, use fox1 (longer) for flare / evade distance.
     */
    function inferThreatMissileType(enemyTeam) {
        if (!enemyTeam) return 'fox2';
        if (typeof teamLiveMissileType === 'function') {
            const live = teamLiveMissileType(enemyTeam);
            if (live === 'fox1' || live === 'fox2') return live;
        }
        const pylons = enemyTeam.pylons || [];
        const hasFox1 = pylons.some((p) => p && p.state !== 'empty' && pylonTypeOf(p) === 'fox1');
        return hasFox1 ? 'fox1' : 'fox2';
    }

    /**
     * Fields merged into AIR_ARENA_AI_DEFAULTS / getTuning().
     * @param {object|string|null} teamOrOpts - team, {missileType}, or 'fox1'|'fox2'
     */
    function getAiEnvelopeFields(teamOrOpts) {
        refreshFromConfig();
        let missileType = 'fox2';
        if (typeof teamOrOpts === 'string') {
            missileType = teamOrOpts;
        } else if (teamOrOpts && typeof teamOrOpts === 'object') {
            if (teamOrOpts.missileType === 'fox1' || teamOrOpts.missileType === 'fox2') {
                missileType = teamOrOpts.missileType;
            } else if (teamOrOpts.pylons || teamOrOpts.id) {
                missileType = inferTeamMissileType(teamOrOpts, teamOrOpts);
            }
        }
        const m = getMissileCombatEnvelope(missileType);
        return {
            gunRange: combat.gunRange,
            gunAngle: AI_SOFT_DEG.gunAngle,
            missileMinRange: m.missileMinRange,
            missileMaxRange: m.missileMaxRange,
            missileAngle: AI_SOFT_DEG.missileAngle,
            missileType: m.missileType,
            seekerRange: m.seekerRange,
            seekerAngleRad: m.seekerAngleRad
        };
    }

    function assertMatchesConfig(config) {
        const cfg = config || readConfigObject();
        if (!cfg || !cfg.weapons) return { ok: true, skipped: true };
        refreshFromConfig(cfg);
        const gun = cfg.weapons.gun;
        const fox2 = cfg.weapons.fox2;
        const fox1 = cfg.weapons.fox1;
        const drift = [];
        if (gun && gun.range !== combat.gunRange) drift.push(`gun.range ${gun.range}≠${combat.gunRange}`);
        if (fox2 && fox2.minArmingRange !== combat.missileMinRange) {
            drift.push(`fox2.minArmingRange ${fox2.minArmingRange}≠${combat.missileMinRange}`);
        }
        if (fox2 && fox2.maxFlightRange !== combat.missileMaxRange) {
            drift.push(`fox2.maxFlightRange ${fox2.maxFlightRange}≠${combat.missileMaxRange}`);
        }
        if (fox1 && fox1.maxFlightRange !== combat.fox1MaxRange) {
            drift.push(`fox1.maxFlightRange ${fox1.maxFlightRange}≠${combat.fox1MaxRange}`);
        }
        if (fox1 && fox1.seekerRange !== combat.fox1SeekerRange) {
            drift.push(`fox1.seekerRange ${fox1.seekerRange}≠${combat.fox1SeekerRange}`);
        }
        return { ok: drift.length === 0, drift };
    }

    // Eager refresh when CONFIG already on the page.
    refreshFromConfig();

    return {
        FALLBACK_COMBAT,
        AI_SOFT_DEG,
        refreshFromConfig,
        getCombatRanges,
        getMissileCombatEnvelope,
        normalizeMissileType,
        inferTeamMissileType,
        peekNextMissileType,
        inferThreatMissileType,
        getAiEnvelopeFields,
        assertMatchesConfig
    };
});
