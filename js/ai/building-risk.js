// ============================================================================
// building-risk.js - Shared roof clearance + Scheme B + M2 radii + corridor helpers
// ============================================================================
(function initBuildingRisk(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AirArenaBuildingRisk = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const ROOF_CLEAR_M = 8;
    const ROOF_SOFT_M = 4;
    /** Overhead / undercroft ceiling: hard = must not climb; soft = cap climb. */
    const HEADROOM_HARD_M = 4;
    const HEADROOM_SOFT_M = 8;
    const HEADROOM_WARN_M = 14;

    /** M2 named radii — default `gap` enables pillar / building-lane flight. */
    const BUILDING_RISK_PROFILES = {
        legacy: {
            id: 'legacy',
            highDist: 12,
            highFwd: 24,
            highLat: 18,
            medDist: 26,
            medFwd: 46,
            medLat: 24,
            rayHigh: 24,
            rayMed: 46,
            corridorProbe: 42,
            corridorMinGap: 8
        },
        gap: {
            id: 'gap',
            highDist: 6,
            highFwd: 14,
            highLat: 10,
            medDist: 14,
            medFwd: 28,
            medLat: 16,
            rayHigh: 14,
            rayMed: 28,
            corridorProbe: 36,
            corridorMinGap: 5.5
        }
    };

    function getBuildingRiskProfile(name) {
        const key = String(name || 'gap').toLowerCase();
        return BUILDING_RISK_PROFILES[key] || BUILDING_RISK_PROFILES.gap;
    }

    /**
     * Cap climb stick when under an elevated slab / ceiling.
     * Returns max allowed joyY (may be negative).
     */
    function maxJoyYForHeadroom(headroom) {
        const h = Number(headroom);
        if (!Number.isFinite(h)) return 1;
        if (h < HEADROOM_HARD_M) return -0.12;
        if (h < HEADROOM_SOFT_M) return 0.06;
        if (h < HEADROOM_WARN_M) return 0.32;
        return 1;
    }

    /**
     * Horizontal AABB bubble risk from distance / forward / lateral (profile radii).
     */
    function classifyHorizontalRisk(dist, forwardDist, lateral, profile, behind) {
        const p = profile || BUILDING_RISK_PROFILES.gap;
        const lat = Math.abs(Number(lateral) || 0);
        const fwd = Number(forwardDist);
        const d = Number(dist);
        if (behind && d >= Math.max(6, p.highDist * 0.65)) return 'low';
        if (d < p.highDist || (fwd > 0 && fwd < p.highFwd && lat < p.highLat)) return 'high';
        if (d < p.medDist || (fwd > 0 && fwd < p.medFwd && lat < p.medLat)) return 'medium';
        return 'low';
    }

    function classifyRayRisk(hitFwd, profile) {
        const p = profile || BUILDING_RISK_PROFILES.gap;
        const d = Number(hitFwd);
        if (!Number.isFinite(d)) return 'low';
        if (d < p.rayHigh) return 'high';
        if (d < p.rayMed) return 'medium';
        return 'low';
    }

    /**
     * Downgrade / ignore horizontal building bubble when already clear above the roof.
     * Diving into the footprint keeps real risk.
     */
    function applyRoofClearanceToRisk(baseRisk, clearance, selfForwardY, forwardDist, lateral) {
        const divingInto =
            Number(selfForwardY) < -0.2 &&
            Number.isFinite(forwardDist) &&
            forwardDist > 0 &&
            forwardDist < 42 &&
            Math.abs(Number(lateral) || 0) < 22;
        if (clearance >= ROOF_CLEAR_M && !divingInto) return 'low';
        if (clearance >= ROOF_SOFT_M && !divingInto) {
            if (baseRisk === 'high') return 'medium';
            if (baseRisk === 'medium') return 'low';
        }
        if (clearance >= ROOF_CLEAR_M && divingInto && baseRisk === 'low') return 'medium';
        // Below a taller AABB roof (often beside, not under slab): keep at least medium so
        // planner/beam can score a route — do not treat as open-sky low (T76 red2/blue2).
        if (Number.isFinite(clearance) && clearance < 0 && (baseRisk === 'low' || !baseRisk)) {
            return 'medium';
        }
        return baseRisk || 'low';
    }

    /** Scheme B: shift risk down N tiers (high→medium→low). */
    function downgradeBuildingRisk(risk, steps = 1) {
        const n = Math.max(0, Math.floor(Number(steps) || 0));
        if (n <= 0) return risk || 'low';
        let r = risk || 'low';
        for (let i = 0; i < n; i++) {
            if (r === 'high') r = 'medium';
            else if (r === 'medium') r = 'low';
            else break;
        }
        return r;
    }

    function riskPriority(risk) {
        if (risk === 'high') return 0;
        if (risk === 'medium') return 1;
        return 2;
    }

    /**
     * Forward ray clear + lateral channel wide enough for aircraft (~1.2) × margin.
     * @returns {{ clear: boolean, fwdClear: number, gapWidth: number, leftClear: number, rightClear: number }}
     */
    /** Invalidate cached world AABBs once per AI run (buildings are static mid-decide). */
    let obstacleBoxCacheGen = 0;
    function bumpObstacleBoxCache() {
        obstacleBoxCacheGen = (obstacleBoxCacheGen + 1) | 0;
    }
    function getCachedWorldBox(obj, outBox) {
        const box = outBox || new THREE.Box3();
        if (!obj) {
            box.makeEmpty();
            return box;
        }
        const ud = obj.userData || (obj.userData = {});
        if (ud._brBoxGen === obstacleBoxCacheGen && ud._brBox) {
            box.copy(ud._brBox);
            return box;
        }
        box.setFromObject(obj);
        if (!ud._brBox) ud._brBox = box.clone();
        else ud._brBox.copy(box);
        ud._brBoxGen = obstacleBoxCacheGen;
        return box;
    }

    function evaluateCorridorClear(selfPos, flatForward, obstacles, raycaster, profile) {
        const p = profile || BUILDING_RISK_PROFILES.gap;
        const probe = Number(p.corridorProbe) || 36;
        const minGap = Number(p.corridorMinGap) || 5.5;
        const empty = {
            clear: true,
            fwdClear: probe,
            gapWidth: Infinity,
            leftClear: Infinity,
            rightClear: Infinity
        };
        if (!selfPos || !flatForward || !raycaster) return empty;
        if (!obstacles || obstacles.length === 0) return empty;

        const fwd = flatForward.clone();
        fwd.y = 0;
        if (fwd.lengthSq() < 0.0001) fwd.set(0, 0, 1);
        else fwd.normalize();

        raycaster.set(selfPos, fwd);
        raycaster.near = 0.2;
        raycaster.far = probe;
        const hits = raycaster.intersectObjects(obstacles, true);
        let fwdClear = probe;
        if (hits.length > 0 && Number.isFinite(hits[0].distance)) {
            fwdClear = hits[0].distance;
        }
        if (fwdClear < Math.min(probe, minGap + 4)) {
            return {
                clear: false,
                fwdClear,
                gapWidth: 0,
                leftClear: 0,
                rightClear: 0
            };
        }

        const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
        const box = new THREE.Box3();
        const clamped = new THREE.Vector3();
        const samples = [
            selfPos,
            selfPos.clone().add(fwd.clone().multiplyScalar(Math.min(18, fwdClear * 0.45)))
        ];
        let leftClear = Infinity;
        let rightClear = Infinity;
        for (let s = 0; s < samples.length; s++) {
            const sample = samples[s];
            for (let i = 0; i < obstacles.length; i++) {
                const obj = obstacles[i];
                if (!obj || (obj.userData && obj.userData.isCollisionProxy)) continue;
                getCachedWorldBox(obj, box);
                box.clampPoint(sample, clamped);
                const to = clamped.clone().sub(sample);
                to.y = 0;
                const dist = to.length();
                if (dist < 0.05) continue;
                const lat = right.dot(to);
                if (lat >= 0) rightClear = Math.min(rightClear, dist);
                else leftClear = Math.min(leftClear, dist);
            }
        }
        if (!Number.isFinite(leftClear)) leftClear = probe;
        if (!Number.isFinite(rightClear)) rightClear = probe;
        const gapWidth = leftClear + rightClear;
        const clear =
            fwdClear >= Math.min(22, probe * 0.55) &&
            Math.min(leftClear, rightClear) >= minGap * 0.42 &&
            gapWidth >= minGap;
        return {
            clear: !!clear,
            fwdClear: Number(fwdClear.toFixed(1)),
            gapWidth: Number(gapWidth.toFixed(1)),
            leftClear: Number(leftClear.toFixed(1)),
            rightClear: Number(rightClear.toFixed(1))
        };
    }

    /**
     * Mesh contact / under-roof embed / early envelope: never treat as soft medium after Scheme B.
     * Early abort: dist<6 with roof<0 (or soft roof) so we do not wait until dist=0.
     * @returns {boolean}
     */
    function isHardBuildingContact(coverInfo = {}) {
        const dist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        const roof = Number(coverInfo.roofClearance);
        if (Number.isFinite(dist) && dist < 4) return true;
        // Early around-building abort before embed.
        if (Number.isFinite(roof) && roof < 0 && Number.isFinite(dist) && dist < 12) return true;
        if (Number.isFinite(roof) && roof < 2 && Number.isFinite(dist) && dist < 6) return true;
        if (
            Number.isFinite(roof) &&
            roof < 0 &&
            Number.isFinite(fwd) &&
            fwd > 0 &&
            fwd < 12
        ) {
            return true;
        }
        if (coverInfo.collisionRisk === 'high' && Number.isFinite(dist) && dist < 8) return true;
        if (
            coverInfo.collisionRisk === 'high' &&
            Number.isFinite(fwd) &&
            fwd > 0 &&
            fwd < 10
        ) {
            return true;
        }
        return false;
    }

    /**
     * Scheme B may soft-downgrade, but contact / negative roof stay high.
     */
    function finalizeBuildingRisk(risk, coverLike = {}, allowCorridorSoft = false) {
        let r = risk || 'low';
        if (isHardBuildingContact(coverLike)) return 'high';
        if (allowCorridorSoft && r === 'high' && coverLike.corridorClear && Number(coverLike.distance) >= 2.5) {
            return 'medium';
        }
        return r;
    }

    /**
     * Hard urban choke (central “table” / dead undercroft gap).
     * Fair difficult terrain — AI should prefer overfly / exit, not treat gap=0 as a street.
     * severity 0=none | 1=approach/tight | 2=boxed undercroft (T14 blue2 class).
     */
    function classifyUrbanHardChoke(coverInfo = {}, opts = {}) {
        const roof = Number(coverInfo.roofClearance);
        const dist = Number(coverInfo.distance);
        const fwd = Number(
            Number.isFinite(Number(coverInfo.corridorFwdClear))
                ? coverInfo.corridorFwdClear
                : coverInfo.forwardDistance
        );
        const gap = Number(coverInfo.corridorGap);
        const left = Number(coverInfo.corridorLeftClear);
        const right = Number(coverInfo.corridorRightClear);
        const minGap = Number(opts.minGap) || Number(
            (opts.profile && opts.profile.corridorMinGap) || 5.5
        );

        const underSlab = Number.isFinite(roof) && roof < 2;
        const deepUnder = Number.isFinite(roof) && roof < 0;
        const sidesPinched =
            Number.isFinite(left) &&
            Number.isFinite(right) &&
            left < 4 &&
            right < 4;
        const gapDead =
            coverInfo.corridorClear !== true &&
            (
                (Number.isFinite(gap) && gap < minGap) ||
                (Number.isFinite(gap) && gap <= 0) ||
                sidesPinched
            );
        const close =
            (Number.isFinite(dist) && dist < 16) ||
            (Number.isFinite(dist) && dist < 1.5) ||
            (Number.isFinite(fwd) && fwd >= 0 && fwd < 18);

        let severity = 0;
        let kind = null;
        if (deepUnder && gapDead && close) {
            severity = 2;
            kind = 'tableUndercroft';
        } else if (underSlab && gapDead && close) {
            severity = 1;
            kind = 'tightUndercroft';
        }
        // Map-authored hazard tags deferred — stabilize generic AI first; then airframe/weapon packs.

        return {
            active: severity > 0,
            severity,
            kind: kind || null
        };
    }

    return {
        ROOF_CLEAR_M,
        ROOF_SOFT_M,
        HEADROOM_HARD_M,
        HEADROOM_SOFT_M,
        HEADROOM_WARN_M,
        BUILDING_RISK_PROFILES,
        getBuildingRiskProfile,
        classifyHorizontalRisk,
        classifyRayRisk,
        evaluateCorridorClear,
        bumpObstacleBoxCache,
        getCachedWorldBox,
        maxJoyYForHeadroom,
        applyRoofClearanceToRisk,
        downgradeBuildingRisk,
        riskPriority,
        isHardBuildingContact,
        finalizeBuildingRisk,
        classifyUrbanHardChoke
    };
});
