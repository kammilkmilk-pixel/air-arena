// ============================================================================
// arena-envelope.js - Venue-linked combat envelope (AO + altitude bands + soft score)
// Doctrine: map/venue owns sizes; PilotAI only samples pressure and soft-scores candidates.
// See docs/Arena-Map-Onboarding-Memo.md — bake + envelope required for every new map.
// ============================================================================

(function initArenaEnvelope(root) {
    /** Active map override (null = CONFIG + ground inference only). */
    let mapOverride = null;

    function num(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function cfgAirspace() {
        return (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.combatAirspace)
            ? CONFIG.rules.combatAirspace
            : {};
    }

    function cfgAltitudeDefaults() {
        const t = (typeof AirArenaPilotTuningDefaults !== 'undefined' && AirArenaPilotTuningDefaults.getDefaults)
            ? AirArenaPilotTuningDefaults.getDefaults()
            : {};
        return {
            bandMin: num(t.combatBandMin, 35),
            bandMax: num(t.combatBandMax, 92),
            bandHardMax: num(t.combatBandHardMax, 108),
            mandatoryClimbAlt: num(t.mandatoryClimbAlt, 36)
        };
    }

    /**
     * Normalize optional map.envelope / map.combatAirspace / ground-derived defaults.
     */
    function normalizeEnvelopeFromDoc(doc) {
        if (!doc || typeof doc !== 'object') return null;
        const g = doc.ground || {};
        const e = doc.envelope || doc.combatAirspace || {};
        const alt = e.altitude || doc.altitudeEnvelope || {};
        const gw = num(g.width, 0);
        const gd = num(g.depth, 0);
        const groundSpan = Math.max(gw, gd);
        const diameter = num(e.diameter, groundSpan > 0 ? groundSpan : NaN);
        const out = {
            mapId: String(doc.id || doc.name || ''),
            enabled: e.enabled !== false,
            diameter: Number.isFinite(diameter) ? diameter : null,
            softMargin: e.softMargin != null ? num(e.softMargin, 220) : null,
            warnMargin: e.warnMargin != null ? num(e.warnMargin, 200) : null,
            centerX: e.centerX != null ? num(e.centerX, NaN) : (g.centerX != null ? num(g.centerX, NaN) : null),
            centerZ: e.centerZ != null ? num(e.centerZ, NaN) : (g.centerZ != null ? num(g.centerZ, NaN) : null),
            altitude: {
                bandMin: alt.bandMin != null ? num(alt.bandMin, 35) : null,
                bandMax: alt.bandMax != null ? num(alt.bandMax, 92) : null,
                bandHardMax: alt.bandHardMax != null ? num(alt.bandHardMax, 108) : null,
                mandatoryClimbAlt: alt.mandatoryClimbAlt != null ? num(alt.mandatoryClimbAlt, 36) : null
            },
            /** Soft score weights (venue-tunable). */
            score: {
                radialWeight: num(e.score && e.score.radialWeight, 1),
                altitudeWeight: num(e.score && e.score.altitudeWeight, 1),
                highAltFox1Scale: num(e.score && e.score.highAltFox1Scale, 0.35)
            }
        };
        return out;
    }

    /**
     * Push venue AO into CONFIG so combat-airspace.js hard-kill stays single-sourced.
     */
    function syncConfigAirspace(profile) {
        if (typeof CONFIG === 'undefined' || !CONFIG.rules) return;
        if (!CONFIG.rules.combatAirspace) CONFIG.rules.combatAirspace = {};
        const c = CONFIG.rules.combatAirspace;
        if (profile.diameter != null) c.diameter = profile.diameter;
        if (profile.softMargin != null) c.softMargin = profile.softMargin;
        if (profile.warnMargin != null) c.warnMargin = profile.warnMargin;
        if (Number.isFinite(profile.centerX)) c.centerX = profile.centerX;
        if (Number.isFinite(profile.centerZ)) c.centerZ = profile.centerZ;
        if (profile.enabled === false) c.enabled = false;
        else if (profile.enabled === true) c.enabled = true;
    }

    function applyFromMapDoc(doc) {
        mapOverride = normalizeEnvelopeFromDoc(doc);
        const profile = getProfile();
        syncConfigAirspace(profile);
        return profile;
    }

    function clearMapOverride() {
        mapOverride = null;
    }

    /**
     * Resolved venue profile (absolute meters from map/CONFIG; PilotAI should prefer sample() ratios).
     */
    function getProfile() {
        const c = cfgAirspace();
        const altDef = cfgAltitudeDefaults();
        const o = mapOverride || {};
        const oAlt = (o.altitude) || {};
        const diameter = num(o.diameter != null ? o.diameter : c.diameter, 900);
        const radius = Math.max(50, diameter * 0.5);
        const softMargin = num(o.softMargin != null ? o.softMargin : c.softMargin, 220);
        const warnMargin = num(o.warnMargin != null ? o.warnMargin : c.warnMargin, 200);
        let cx = o.centerX != null && Number.isFinite(Number(o.centerX))
            ? Number(o.centerX)
            : (c.centerX != null && Number.isFinite(Number(c.centerX)) ? Number(c.centerX) : null);
        let cz = o.centerZ != null && Number.isFinite(Number(o.centerZ))
            ? Number(o.centerZ)
            : (c.centerZ != null && Number.isFinite(Number(c.centerZ)) ? Number(c.centerZ) : null);
        if (cx == null || cz == null) {
            if (typeof battlefieldCenter !== 'undefined' && battlefieldCenter) {
                if (cx == null) cx = battlefieldCenter.x;
                if (cz == null) cz = battlefieldCenter.z;
            }
        }
        if (cx == null) cx = 10;
        if (cz == null) cz = 20;
        const softRadius = Math.max(40, radius - Math.max(0, softMargin));
        const warnRadius = Math.max(40, radius - Math.max(0, warnMargin));
        const score = (o.score) || {};
        return {
            mapId: o.mapId || '',
            enabled: o.enabled !== false && c.enabled !== false,
            diameter,
            radius,
            softRadius,
            warnRadius,
            softMargin,
            warnMargin,
            cx,
            cz,
            altitude: {
                bandMin: num(oAlt.bandMin != null ? oAlt.bandMin : altDef.bandMin, 35),
                bandMax: num(oAlt.bandMax != null ? oAlt.bandMax : altDef.bandMax, 92),
                bandHardMax: num(oAlt.bandHardMax != null ? oAlt.bandHardMax : altDef.bandHardMax, 108),
                mandatoryClimbAlt: num(
                    oAlt.mandatoryClimbAlt != null ? oAlt.mandatoryClimbAlt : altDef.mandatoryClimbAlt,
                    36
                )
            },
            score: {
                radialWeight: num(score.radialWeight, 1),
                altitudeWeight: num(score.altitudeWeight, 1),
                highAltFox1Scale: num(score.highAltFox1Scale, 0.35)
            }
        };
    }

    function sampleHorizontal(pos, forward) {
        const profile = getProfile();
        const x = pos && Number.isFinite(Number(pos.x)) ? Number(pos.x) : profile.cx;
        const z = pos && Number.isFinite(Number(pos.z)) ? Number(pos.z) : profile.cz;
        const dx = x - profile.cx;
        const dz = z - profile.cz;
        const radial = Math.hypot(dx, dz);
        const inv = radial > 1e-4 ? 1 / radial : 0;
        const outward = { x: dx * inv, z: dz * inv };
        let band = 'clear';
        let t = 0;
        if (!profile.enabled) {
            band = 'clear';
        } else if (radial >= profile.radius) {
            band = 'outside';
            t = 1;
        } else if (radial >= profile.warnRadius) {
            band = 'warn';
            t = profile.radius > profile.warnRadius
                ? (radial - profile.warnRadius) / (profile.radius - profile.warnRadius)
                : 1;
        } else if (radial >= profile.softRadius) {
            band = 'soft';
            const softEnd = Math.min(profile.warnRadius, profile.radius);
            t = softEnd > profile.softRadius
                ? (radial - profile.softRadius) / (softEnd - profile.softRadius)
                : 1;
        }
        t = Math.max(0, Math.min(1, t));
        // Fraction of hard radius used (0 = center, 1 = hard rim) — size-independent.
        const radialFrac = profile.radius > 1e-3 ? Math.min(1.5, radial / profile.radius) : 0;
        // Soft-band progress: 0 inside softRadius, 1 at hard.
        const softSpan = Math.max(1e-3, profile.radius - profile.softRadius);
        const softProgress = Math.max(0, Math.min(1, (radial - profile.softRadius) / softSpan));

        let outboundDot = 0;
        let crossY = 0;
        if (forward && Number.isFinite(Number(forward.x)) && Number.isFinite(Number(forward.z))) {
            const fx = Number(forward.x);
            const fz = Number(forward.z);
            const fl = Math.hypot(fx, fz) || 1;
            const nx = fx / fl;
            const nz = fz / fl;
            outboundDot = nx * outward.x + nz * outward.z;
            crossY = outward.x * nz - outward.z * nx;
        }
        const hardClearance = profile.radius - radial;
        return {
            profile,
            band,
            t,
            radial,
            radialFrac,
            softProgress,
            hardClearance,
            outboundDot,
            crossY,
            outward,
            inwardSide: crossY >= 0 ? -1 : 1
        };
    }

    function sampleAltitude(altitude) {
        const profile = getProfile();
        const a = profile.altitude;
        const alt = Number(altitude);
        if (!Number.isFinite(alt)) {
            return { zone: 'unknown', altNorm: 0, belowBand: false, aboveBand: false, pressure: 0 };
        }
        let zone = 'combat';
        if (alt < 14) zone = 'dirt';
        else if (alt < a.mandatoryClimbAlt) zone = 'canyon';
        else if (alt >= a.bandHardMax) zone = 'hardHigh';
        else if (alt >= a.bandMax) zone = 'high';
        else if (alt >= a.bandMin) zone = 'combat';
        else zone = 'low';

        const belowBand = alt < a.bandMin;
        const aboveBand = alt > a.bandMax;
        let altNorm = 0;
        if (belowBand) {
            const span = Math.max(1e-3, a.bandMin);
            altNorm = -Math.max(0, Math.min(1, (a.bandMin - alt) / span));
        } else if (aboveBand) {
            const span = Math.max(1e-3, a.bandHardMax - a.bandMax);
            altNorm = Math.max(0, Math.min(1.2, (alt - a.bandMax) / span));
        }
        const pressure = Math.abs(altNorm);
        return { zone, altNorm, belowBand, aboveBand, pressure, bandMin: a.bandMin, bandMax: a.bandMax };
    }

    /**
     * Combined per-frame sample for PilotAI.
     * @param {object} pos
     * @param {object} [forward] — world forward (x,z used for outboundDot)
     * @param {number} [altitude]
     */
    function sample(pos, forward, altitude) {
        const horiz = sampleHorizontal(pos, forward);
        const alt = sampleAltitude(
            altitude != null
                ? altitude
                : (pos && Number.isFinite(Number(pos.y)) ? Number(pos.y) : NaN)
        );
        return { ...horiz, altitude: alt };
    }

    function isFox1ish(state, meta) {
        const s = String(state || '');
        const r = String((meta && meta.reason) || '');
        return (
            /fox1|Illuminate|SARH|HighPerch/i.test(s) ||
            /fox1|SARH|perch/i.test(r) ||
            (meta && meta.role === 'fox1')
        );
    }

    /**
     * Soft score: centrifugal penalty / centripetal reward + low/high altitude bias.
     * Uses relative softProgress / altNorm — safe across venue diameters.
     * Survival gates must still outrank this layer.
     */
    function scoreCandidate(score, meta = {}, envSample = null, opts = {}) {
        let s = Number(score) || 0;
        const samp = envSample || opts.sample;
        if (!samp || !samp.profile || samp.profile.enabled === false) return s;

        const wR = num(samp.profile.score && samp.profile.score.radialWeight, 1);
        const wA = num(samp.profile.score && samp.profile.score.altitudeWeight, 1);
        const foxScale = num(samp.profile.score && samp.profile.score.highAltFox1Scale, 0.35);

        const state = String(meta.state || '');
        const joyX = Number(meta.joyX) || 0;
        const joyY = Number(meta.joyY) || 0;
        const sx = Math.sign(joyX) || 0;
        const hardBuilding = !!(opts.hardBuilding || opts.hardContact || meta.buildingHit);
        // Mesh survival: do not let envelope soft score fight glue/dirt sticks.
        if (hardBuilding) return s;

        const softP = Number(samp.softProgress) || 0;
        const outDot = Number(samp.outboundDot) || 0;
        const inward = Math.sign(samp.inwardSide || 0) || 0;
        const band = String(samp.band || 'clear');
        const radialFrac = Number(samp.radialFrac) || 0;
        // Early approach (still clear band but far out): light centrifugal bias.
        const approachP = band === 'clear'
            ? Math.max(0, Math.min(1, (radialFrac - 0.55) / 0.35))
            : softP;

        if (wR > 0 && (softP > 0.05 || approachP > 0.15)) {
            const useP = Math.max(softP, approachP * 0.65);
            const radialPush = useP * (0.55 + 0.45 * Math.max(0, outDot));
            // Centrifugal: outbound heading near rim.
            if (outDot > 0.25) s -= (18 + 42 * radialPush) * wR;
            else if (outDot < -0.15) s += (10 + 22 * useP) * wR;
            // Centripetal stick: joyX toward inward when committed bank.
            if (inward && Math.abs(joyX) >= 0.28) {
                if (sx === inward) s += (12 + 28 * useP) * wR;
                else if (sx === -inward) s -= (16 + 36 * useP) * wR;
            }
            // Align / chase thrash near rim while punching out.
            if ((/alignFirst|hybridPress|hybridBlitz|missilePrep|tacticalLead|tacticalLag/i.test(state)) && outDot > 0.35) {
                s -= (22 + 30 * useP) * wR;
            }
            if (/airspaceAvoid|EnergyCruise|ClimbOut/i.test(state) && outDot < 0.1) {
                s += 8 * useP * wR;
            }
        }

        const alt = samp.altitude || {};
        const altNorm = Number(alt.altNorm) || 0;
        const zone = String(alt.zone || '');
        if (wA > 0 && Math.abs(altNorm) > 0.08) {
            let scale = wA;
            if (altNorm > 0 && isFox1ish(state, meta)) scale *= foxScale;
            if (altNorm < 0) {
                // Low / canyon: punish nose-down thrash; reward climb floor.
                if (joyY < 0.05) s -= (20 + 40 * Math.abs(altNorm)) * scale;
                if (joyY >= 0.28) s += (14 + 28 * Math.abs(altNorm)) * scale;
                if (/Weave|RouteSide|Preemptive|alignFirst/i.test(state) && joyY < 0.22) {
                    s -= (18 + 24 * Math.abs(altNorm)) * scale;
                }
            } else {
                // High: punish sustained climb; reward level / shallow descend.
                if (joyY > 0.2) s -= (16 + 36 * altNorm) * scale;
                if (joyY <= 0.08 && joyY >= -0.25) s += (10 + 20 * altNorm) * scale;
                if (/HighPerch|fox1Illuminate|fox1Reattack/i.test(state)) {
                    s += 6 * altNorm * scale; // partial credit for intentional perch
                }
            }
        }
        // T69: hardHigh + rim — heavily prefer descend+inward over align/chase climb.
        if (
            wR > 0 &&
            wA > 0 &&
            (zone === 'hardHigh' || zone === 'high') &&
            radialFrac >= 0.72 &&
            outDot > 0.2
        ) {
            if (/alignFirst|hybridPress|missilePrep|tacticalLead|tacticalLag/i.test(state)) {
                s -= (36 + 40 * softP) * wR;
            }
            if (joyY <= -0.15 && inward && sx === inward) s += 28 * wA;
            if (joyY > 0.15) s -= 24 * wA;
        }

        return s;
    }

    const api = {
        normalizeEnvelopeFromDoc,
        applyFromMapDoc,
        clearMapOverride,
        getProfile,
        sample,
        sampleHorizontal,
        sampleAltitude,
        scoreCandidate,
        syncConfigAirspace
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        root.AirArenaArenaEnvelope = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
