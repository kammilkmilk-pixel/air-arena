// ============================================================================
// decide-pipeline.js - Named decide() gate order (H3)
// Doctrine priority is this list — not comment order inside decide().
// ============================================================================
(function initDecidePipeline(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AirArenaDecidePipeline = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    /**
     * Full decide() gate order.
     * Prefix gates run before MAIN context is fully built; MAIN gates run via runDecidePipeline.
     */
    const PREFIX_GATE_ORDER = Object.freeze([
        'wingmanSupport',
        'noValidTarget',
        'sensorBlind'
    ]);

    const MAIN_GATE_ORDER = Object.freeze([
        'obstacleEmergency', // buildings before dive pull-up
        'groundEmergency',   // pull-up / recover lock / post-ground
        'airspaceBoundary',  // soft inward bias near combat AO edge
        'fox2Opening',       // opening shot / alignFirst / roof / prep (includes align)
        'altitudeTerrain',   // band level-out / terrain / groundAvoid / shallow
        'stallEnergy',       // stallBreakout / stallRecover / energyRecover
        'urbanCollision',    // preUrban flare / urban preempt / collision / manual / antiLoop
        'engagement'         // tacticalApproach then merge/weapons; orbit/reacquire fallback
    ]);

    const DECIDE_GATE_ORDER = Object.freeze([...PREFIX_GATE_ORDER, ...MAIN_GATE_ORDER]);

    const GATE_DOCS = Object.freeze({
        wingmanSupport: 'follow/cover/break support; attack fallback',
        noValidTarget: 'idle when no living enemy',
        sensorBlind: 'no track: search ground safety or bearing search',
        obstacleEmergency: 'high building risk escape before dive pull-up',
        groundEmergency: 'emergencyPullUp / recoverLock / navClimbOut(postGroundClimbOut commitment)',
        airspaceBoundary: 'AO rim inward; yield to buildings; punch-out only near hard with open cover',
        alignFirst: 'clear-LOS nose align (handled inside fox2Opening gate)',
        fox2Opening: 'FOX2-FIRST opening shot / alignFirst / roof dash / prep',
        altitudeTerrain: 'combat band / terrainEscape / groundAvoid / shallowDive',
        stallEnergy: 'stallBreakout / stallRecover / energyRecover',
        urbanCollision: 'urban preempt / collisionAvoid / manual / antiLoop',
        engagement: 'tacticalApproach (n-step) then merge/weapons/mask; orbit/reacquire fallback'
    });

    function assertUniqueOrder(order) {
        const seen = new Set();
        const dup = [];
        for (const id of order) {
            if (seen.has(id)) dup.push(id);
            seen.add(id);
        }
        return { ok: dup.length === 0, dup };
    }

    function assertCompleteHandlers(order, handlers) {
        const missing = order.filter((id) => typeof handlers[id] !== 'function');
        return { ok: missing.length === 0, missing };
    }

    /**
     * Extract tryDecideGate('id' / runDecidePipeline ['id' occurrences in source order.
     */
    function extractGateInvocationsFromSource(sourceText) {
        const found = [];
        const re = /tryDecideGate\(\s*['"]([a-zA-Z0-9_]+)['"]|\[\s*['"]([a-zA-Z0-9_]+)['"]\s*,/g;
        let m;
        while ((m = re.exec(sourceText))) {
            found.push(m[1] || m[2]);
        }
        return found;
    }

    function assertSourceMatchesOrder(sourceText, expectedOrder) {
        const found = extractGateInvocationsFromSource(sourceText);
        // Keep first occurrence of each expected gate in source order.
        const firstHits = [];
        const seen = new Set();
        for (const id of found) {
            if (!expectedOrder.includes(id) || seen.has(id)) continue;
            seen.add(id);
            firstHits.push(id);
        }
        const missing = expectedOrder.filter((id) => !seen.has(id));
        let orderOk = missing.length === 0;
        if (orderOk) {
            for (let i = 0; i < expectedOrder.length; i++) {
                if (firstHits[i] !== expectedOrder[i]) {
                    orderOk = false;
                    break;
                }
            }
        }
        return { ok: orderOk && missing.length === 0, firstHits, missing, expected: expectedOrder.slice() };
    }

    return {
        PREFIX_GATE_ORDER,
        MAIN_GATE_ORDER,
        DECIDE_GATE_ORDER,
        GATE_DOCS,
        assertUniqueOrder,
        assertCompleteHandlers,
        extractGateInvocationsFromSource,
        assertSourceMatchesOrder
    };
});
