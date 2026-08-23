// ============================================================================
// combat-airspace.js - circular combat AO (soft/warn steer + optional outside penalty)
// Default: outside is HP penalty + forced inward, not instant kill.
// ============================================================================

(function initCombatAirspace(root) {
    function cfg() {
        return (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.combatAirspace)
            ? CONFIG.rules.combatAirspace
            : {};
    }

    function getCombatAirspace() {
        const c = cfg();
        const enabled = c.enabled !== false;
        const diameter = Number.isFinite(Number(c.diameter)) ? Number(c.diameter) : 900;
        const radius = Math.max(50, diameter * 0.5);
        const softMargin = Number.isFinite(Number(c.softMargin)) ? Number(c.softMargin) : 320;
        const warnMargin = Number.isFinite(Number(c.warnMargin)) ? Number(c.warnMargin) : 280;
        // Legacy instant kill only when explicitly enabled.
        const outsideKill = c.outsideKill === true;
        const outsideHpPenalty = Number.isFinite(Number(c.outsideHpPenalty))
            ? Number(c.outsideHpPenalty)
            : 14;

        let cx = Number.isFinite(Number(c.centerX)) ? Number(c.centerX) : null;
        let cz = Number.isFinite(Number(c.centerZ)) ? Number(c.centerZ) : null;
        if (cx == null || cz == null) {
            if (typeof battlefieldCenter !== 'undefined' && battlefieldCenter) {
                if (cx == null) cx = battlefieldCenter.x;
                if (cz == null) cz = battlefieldCenter.z;
            } else if (typeof ground !== 'undefined' && ground && ground.position) {
                if (cx == null) cx = ground.position.x;
                if (cz == null) cz = ground.position.z;
            }
        }
        if (cx == null) cx = 10;
        if (cz == null) cz = 20;

        // Independent bands: larger margins → soft/warn start further inward.
        const softRadius = Math.max(40, radius - Math.max(0, softMargin));
        const warnRadius = Math.max(40, radius - Math.max(0, warnMargin));
        return {
            enabled,
            diameter,
            radius,
            softRadius,
            warnRadius,
            softMargin,
            warnMargin,
            outsideKill,
            outsideHpPenalty,
            cx,
            cz
        };
    }

    function getHorizontalAirspaceOffset(pos) {
        const a = getCombatAirspace();
        const x = pos && Number.isFinite(Number(pos.x)) ? Number(pos.x) : a.cx;
        const z = pos && Number.isFinite(Number(pos.z)) ? Number(pos.z) : a.cz;
        const dx = x - a.cx;
        const dz = z - a.cz;
        const radial = Math.hypot(dx, dz);
        return { airspace: a, dx, dz, radial };
    }

    function isOutsideCombatAirspace(pos) {
        const info = getHorizontalAirspaceOffset(pos);
        if (!info.airspace.enabled) return false;
        return info.radial > info.airspace.radius + 1e-3;
    }

    function getAirspacePressure(pos) {
        const info = getHorizontalAirspaceOffset(pos);
        const a = info.airspace;
        if (!a.enabled) {
            return { ...info, band: 'clear', t: 0, outward: { x: 0, z: 0 } };
        }
        let band = 'clear';
        let t = 0;
        if (info.radial >= a.radius) {
            band = 'outside';
            t = 1;
        } else if (info.radial >= a.warnRadius) {
            band = 'warn';
            t = a.radius > a.warnRadius
                ? (info.radial - a.warnRadius) / (a.radius - a.warnRadius)
                : 1;
        } else if (info.radial >= a.softRadius) {
            // Soft-only pocket when soft starts before warn (softMargin > warnMargin).
            band = 'soft';
            const softEnd = Math.min(a.warnRadius, a.radius);
            t = softEnd > a.softRadius
                ? (info.radial - a.softRadius) / (softEnd - a.softRadius)
                : 1;
        }
        const inv = info.radial > 1e-4 ? 1 / info.radial : 0;
        return {
            ...info,
            band,
            t: Math.max(0, Math.min(1, t)),
            outward: { x: info.dx * inv, z: info.dz * inv }
        };
    }

    function sampleOutboundDot(pos, forward, pressure) {
        const p = pressure || getAirspacePressure(pos);
        if (!p || !p.outward) return 0;
        let fx = 0;
        let fz = 1;
        if (forward) {
            if (typeof forward.x === 'number') fx = forward.x;
            if (typeof forward.z === 'number') fz = forward.z;
        }
        const fl = Math.hypot(fx, fz);
        if (fl < 1e-6) return 0;
        fx /= fl;
        fz /= fl;
        return fx * p.outward.x + fz * p.outward.z;
    }

    /** Short forward probe — do not shove inward into a facade. */
    function probeForwardBuildingHit(pos, forward, maxDist) {
        if (typeof THREE === 'undefined') return false;
        if (typeof obstacles === 'undefined' || !obstacles || !obstacles.length) return false;
        if (!pos) return false;
        let fx = 0;
        let fy = 0;
        let fz = 1;
        if (forward) {
            if (typeof forward.x === 'number') fx = forward.x;
            if (typeof forward.y === 'number') fy = forward.y;
            if (typeof forward.z === 'number') fz = forward.z;
        }
        const len = Math.hypot(fx, fy, fz);
        if (len < 1e-6) return false;
        fx /= len;
        fy /= len;
        fz /= len;
        const origin = new THREE.Vector3(
            Number(pos.x) || 0,
            (Number(pos.y) || 40) + 0.4,
            Number(pos.z) || 0
        );
        const dir = new THREE.Vector3(fx, fy, fz);
        const reach = Number.isFinite(Number(maxDist)) ? Number(maxDist) : 26;
        try {
            const ray = new THREE.Raycaster(origin, dir, 0.4, Math.max(6, reach));
            return ray.intersectObjects(obstacles, true).length > 0;
        } catch (_) {
            return false;
        }
    }

    /**
     * Forced inward stick when outside (and deep warn outbound).
     * Skips when a building is close ahead so we do not push into walls.
     */
    function blendForcedInwardJoystick(pos, forward, joyX, joyY, opts = {}) {
        const pressure = getAirspacePressure(pos);
        if (!pressure || !pressure.airspace || !pressure.airspace.enabled) {
            return { joyX, joyY, forced: false };
        }
        if (pressure.band === 'clear' || pressure.band === 'soft') {
            return { joyX, joyY, forced: false };
        }
        const outDot = sampleOutboundDot(pos, forward, pressure);
        const deepWarn =
            pressure.band === 'warn' &&
            outDot > 0.45 &&
            pressure.t > 0.55;
        const outside = pressure.band === 'outside';
        if (!outside && !deepWarn) {
            return { joyX, joyY, forced: false, outDot };
        }

        const probeDist = outside ? 22 : 28;
        if (opts.allowBuildingDefer !== false && probeForwardBuildingHit(pos, forward, probeDist)) {
            return {
                joyX,
                joyY,
                forced: false,
                deferredBuilding: true,
                outDot,
                band: pressure.band
            };
        }

        // Inward bank side from radial cross (same sign convention as PilotAI rim).
        const fx = forward && typeof forward.x === 'number' ? forward.x : 0;
        const fz = forward && typeof forward.z === 'number' ? forward.z : 1;
        const fl = Math.hypot(fx, fz) || 1;
        const fxx = fx / fl;
        const fzz = fz / fl;
        const ox = pressure.outward.x;
        const oz = pressure.outward.z;
        const crossY = fxx * oz - fzz * ox;
        const inwardSide = crossY >= 0 ? -1 : 1;

        const alreadyIn = outDot < 0.12;
        const auth = outside ? (alreadyIn ? 0.28 : 0.62) : (alreadyIn ? 0.18 : 0.48);
        const bx = inwardSide * auth;
        const w = outside ? 0.72 : 0.55;
        const nextX = (Number(joyX) || 0) * (1 - w) + bx * w;
        let nextY = Number(joyY) || 0;
        const alt = Number(pos && pos.y);
        if (Number.isFinite(alt) && alt < 28) {
            nextY = Math.max(nextY, 0.12);
        } else if (Number.isFinite(alt) && alt >= 100) {
            // T137: high-alt outside must dump altitude, not hold.
            nextY = Math.min(nextY, outside ? -0.48 : -0.32);
        } else if (outside && outDot > 0.5) {
            nextY = Math.min(nextY, 0.06);
        }
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        return {
            joyX: clamp(nextX, -0.85, 0.85),
            joyY: clamp(nextY, -0.45, 0.45),
            forced: true,
            outDot,
            band: pressure.band,
            inwardSide
        };
    }

    const api = {
        getCombatAirspace,
        getHorizontalAirspaceOffset,
        isOutsideCombatAirspace,
        getAirspacePressure,
        sampleOutboundDot,
        probeForwardBuildingHit,
        blendForcedInwardJoystick
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        root.AirArenaCombatAirspace = api;
        root.getCombatAirspace = getCombatAirspace;
        root.getHorizontalAirspaceOffset = getHorizontalAirspaceOffset;
        root.isOutsideCombatAirspace = isOutsideCombatAirspace;
        root.getAirspacePressure = getAirspacePressure;
        root.sampleOutboundDot = sampleOutboundDot;
        root.probeForwardBuildingHit = probeForwardBuildingHit;
        root.blendForcedInwardJoystick = blendForcedInwardJoystick;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
