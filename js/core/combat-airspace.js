// ============================================================================
// combat-airspace.js - circular combat AO (soft AI bias + hard leave-kill)
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
        const softMargin = Number.isFinite(Number(c.softMargin)) ? Number(c.softMargin) : 220;
        const warnMargin = Number.isFinite(Number(c.warnMargin)) ? Number(c.warnMargin) : 200;

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

        // Independent bands: warn can start further in than soft (tape at warnMargin from hard edge).
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

    const api = {
        getCombatAirspace,
        getHorizontalAirspaceOffset,
        isOutsideCombatAirspace,
        getAirspacePressure
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        root.AirArenaCombatAirspace = api;
        root.getCombatAirspace = getCombatAirspace;
        root.getHorizontalAirspaceOffset = getHorizontalAirspaceOffset;
        root.isOutsideCombatAirspace = isOutsideCombatAirspace;
        root.getAirspacePressure = getAirspacePressure;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
