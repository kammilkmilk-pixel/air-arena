/**
 * urban-avoid-side.js — M16 avoid-side authority + M15 roof/undercroft helpers + M19 handoff knobs.
 * Browser: window.AirArenaUrbanAvoidSide | Node: require()
 */
(function initUrbanAvoidSide(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AirArenaUrbanAvoidSide = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    /** Defaults for escape→engage handoff (override via pilot tuning). */
    const ENGAGE_HANDOFF_DEFAULTS = {
        lowDist: 14,
        highDistKeep: 18,
        mediumDist: 18,
        highClimbDist: 18,
        fwdBlock: 18,
        lowFy: -0.2,
        diveFy: -0.18,
        mediumFy: 0.12,
        highFy: 0.22,
        mediumAlt: 30,
        highAlt: 32,
        diveAltMax: 52,
        // Combat reclaim: weapon-envelope contact can hand off sooner than pure escape-clear.
        contactDist: 14,
        contactDiveFy: -0.42
    };

    const EMBED_FLIP_COOLDOWN = 8;
    const EMBED_FLIP_MIN_PUSH = 3;

    /**
     * M15: altitude relative to a building AABB top (selfY - box.max.y).
     * Positive = above that roof; negative = lower than that building's top
     * (often beside a taller AABB — NOT necessarily undercroft).
     */
    function getRoofHeightDelta(selfY, boxMaxY) {
        if (!Number.isFinite(Number(selfY)) || !Number.isFinite(Number(boxMaxY))) return 0;
        return Number(selfY) - Number(boxMaxY);
    }

    /**
     * True undercroft / mesh glue — requires proximity or tight headroom, not bare negative roof delta.
     */
    function isTrueUndercroft(coverInfo = {}, opts = {}) {
        const roof = Number(coverInfo.roofClearance);
        if (!(Number.isFinite(roof) && roof < 2)) return false;
        const dist = Number(coverInfo.distance);
        const headroom = Number(coverInfo.headroom);
        if (opts.hardContact) return true;
        if (Number.isFinite(dist) && dist < 14) return true;
        if (Number.isFinite(headroom) && headroom < 14) return true;
        return false;
    }

    /** Horizontal bank side that pushes out of the cover AABB (+1 / -1). */
    function computeAabbEscapeSide(direction, selfForward) {
        if (!direction || !selfForward) return 0;
        const dx = Number(direction.x);
        const dz = Number(direction.z);
        const fx = Number(selfForward.x);
        const fz = Number(selfForward.z);
        if (![dx, dz, fx, fz].every(Number.isFinite)) return 0;
        return Math.sign(dx * (-fz) + dz * fx) || 0;
    }

    function mergeHandoffTuning(tuning = {}) {
        return {
            ...ENGAGE_HANDOFF_DEFAULTS,
            lowDist: Number(tuning.engageHandoffLowDist) || ENGAGE_HANDOFF_DEFAULTS.lowDist,
            highDistKeep: Number(tuning.engageHandoffHighDistKeep) || ENGAGE_HANDOFF_DEFAULTS.highDistKeep,
            mediumDist: Number(tuning.engageHandoffMediumDist) || ENGAGE_HANDOFF_DEFAULTS.mediumDist,
            highClimbDist: Number(tuning.engageHandoffHighClimbDist) || ENGAGE_HANDOFF_DEFAULTS.highClimbDist,
            fwdBlock: Number(tuning.engageHandoffFwdBlock) || ENGAGE_HANDOFF_DEFAULTS.fwdBlock,
            lowFy: Number.isFinite(Number(tuning.engageHandoffLowFy))
                ? Number(tuning.engageHandoffLowFy)
                : ENGAGE_HANDOFF_DEFAULTS.lowFy,
            diveFy: Number.isFinite(Number(tuning.engageHandoffDiveFy))
                ? Number(tuning.engageHandoffDiveFy)
                : ENGAGE_HANDOFF_DEFAULTS.diveFy,
            mediumFy: Number.isFinite(Number(tuning.engageHandoffMediumFy))
                ? Number(tuning.engageHandoffMediumFy)
                : ENGAGE_HANDOFF_DEFAULTS.mediumFy,
            highFy: Number.isFinite(Number(tuning.engageHandoffHighFy))
                ? Number(tuning.engageHandoffHighFy)
                : ENGAGE_HANDOFF_DEFAULTS.highFy,
            mediumAlt: Number(tuning.engageHandoffMediumAlt) || ENGAGE_HANDOFF_DEFAULTS.mediumAlt,
            highAlt: Number(tuning.engageHandoffHighAlt) || ENGAGE_HANDOFF_DEFAULTS.highAlt,
            diveAltMax: Number(tuning.engageHandoffDiveAltMax) || ENGAGE_HANDOFF_DEFAULTS.diveAltMax,
            contactDist: Number(tuning.engageHandoffContactDist) || ENGAGE_HANDOFF_DEFAULTS.contactDist,
            contactDiveFy: Number.isFinite(Number(tuning.engageHandoffContactDiveFy))
                ? Number(tuning.engageHandoffContactDiveFy)
                : ENGAGE_HANDOFF_DEFAULTS.contactDiveFy
        };
    }

    /**
     * Escape clear enough to hand stick back to engagement/opening (M19).
     * Caller still must exclude hardContact / hardLock / true undercroft if desired.
     */
    function shouldHandoffEscapeToEngage(coverInfo = {}, opts = {}, tuning = {}) {
        if (opts.hardContact) return false;
        if (opts.trueUndercroft || isTrueUndercroft(coverInfo, opts)) return false;
        // Combat reclaim may ignore soft hardLock (AABB proximity) — never hardContact/undercroft.
        if (opts.hardLock && !opts.combatContact) return false;
        const h = mergeHandoffTuning(tuning);
        const risk = coverInfo.collisionRisk || 'low';
        const dist = Number(coverInfo.distance);
        const fwd = Number(coverInfo.forwardDistance);
        const alt = Number(opts.altitude);
        const fy = Number(opts.forwardY);
        // Soft aiMap: far above local roofs — stop escape thrash (not forced re-engage).
        // Allows handoff even while diving if buildings are not near (T150 beside-tall).
        if (
            (opts.aiMapClearAbove || opts.aiMapSkyOpen) &&
            risk !== 'high' &&
            Number.isFinite(dist) &&
            dist >= 40 &&
            !(Number.isFinite(fwd) && fwd > 0 && fwd < 14)
        ) {
            return true;
        }
        // Combat reclaim: LOS/weapon contact + not glued → return stick to fox2/engage.
        // Must NOT reclaim while still diving into facade (fought diveClosing / mesh).
        if (opts.combatContact) {
            const contactFloor = h.contactDist;
            const gluedClose =
                (Number.isFinite(dist) && dist < contactFloor) ||
                (risk === 'high' && Number.isFinite(dist) && dist < contactFloor + 2);
            const steepThreat =
                Number.isFinite(fy) &&
                fy < h.contactDiveFy &&
                Number.isFinite(alt) &&
                alt < h.diveAltMax;
            // Align with non-contact diveFy: mild dive into urban still belongs to escape.
            const diveUrban =
                Number.isFinite(fy) &&
                fy < h.diveFy &&
                Number.isFinite(alt) &&
                alt < h.diveAltMax &&
                (
                    risk !== 'low' ||
                    (Number.isFinite(fwd) && fwd > 0 && fwd < h.fwdBlock) ||
                    (Number.isFinite(dist) && dist < contactFloor + 8)
                );
            if (
                !gluedClose &&
                !steepThreat &&
                !diveUrban &&
                Number.isFinite(dist) &&
                dist >= contactFloor &&
                !(Number.isFinite(fwd) && fwd > 0 && fwd < 12 && risk !== 'low')
            ) {
                return true;
            }
        }
        if (Number.isFinite(fy) && fy < h.diveFy && Number.isFinite(alt) && alt < h.diveAltMax) {
            return false;
        }
        if (risk === 'high' && Number.isFinite(dist) && dist < h.highDistKeep) return false;
        if (Number.isFinite(fwd) && fwd > 0 && fwd < h.fwdBlock && risk !== 'low') return false;
        if (
            risk === 'low' &&
            (!Number.isFinite(dist) || dist >= h.lowDist) &&
            (!Number.isFinite(fy) || fy > h.lowFy)
        ) {
            return true;
        }
        if (
            risk === 'medium' &&
            Number.isFinite(dist) &&
            dist >= h.mediumDist &&
            Number.isFinite(fy) &&
            fy > h.mediumFy &&
            Number.isFinite(alt) &&
            alt >= h.mediumAlt
        ) {
            return true;
        }
        if (
            risk === 'high' &&
            Number.isFinite(dist) &&
            dist >= h.highClimbDist &&
            Number.isFinite(fy) &&
            fy > h.highFy &&
            Number.isFinite(alt) &&
            alt >= h.highAlt
        ) {
            return true;
        }
        return false;
    }

    /**
     * Single avoid-side authority (M16).
     * Priority: AABB(conflict+pressure) > deep glue flip > committed glue > AABB > gap/geom/break.
     *
     * @returns {{
     *   side: number,
     *   source: string,
     *   embedFlip: number,
     *   holdTurns: number,
     *   nextGlueStreak: number,
     *   applyMemory: boolean,
     *   treeNote: string|null,
     *   mode: 'hardEmbed'|'approach'|'passthrough'
     * }}
     */
    function resolveAvoidSideAuthority(ctx = {}) {
        const aabbEscapeSide = Math.sign(Number(ctx.aabbEscapeSide) || 0);
        const committedAvoidSide = Math.sign(Number(ctx.committedAvoidSide) || 0);
        const geometricAvoidSide = Math.sign(Number(ctx.geometricAvoidSide) || 0);
        const urbanAvoidSide = Math.sign(Number(ctx.urbanAvoidSide) || 0);
        const breakSide = Math.sign(Number(ctx.breakSide) || 0) || 1;
        const gapSide = Math.sign(Number(ctx.gapSide) || 0);
        const coverDistNow = Number(ctx.coverDistance);
        const turnNo = Number(ctx.turnNo) || 1;
        const lastFlipTurn = Number(ctx.lastFlipTurn);
        const gluePushStreak = Number(ctx.gluePushStreak) || 0;
        const hardBuildingContact = !!ctx.hardBuildingContact;
        const meshGlueContact = !!ctx.meshGlueContact;
        const deepEmbedContact = !!ctx.deepEmbedContact;
        const earlyBuildingApproach = !!ctx.earlyBuildingApproach;
        const facadeClosingNow = !!ctx.facadeClosingNow;
        const embeddedLane = !!ctx.embeddedLane;
        const risk = ctx.collisionRisk || 'low';
        const fwd = Number(ctx.forwardDistance);

        const aabbConflictsMemory =
            !!aabbEscapeSide && !!committedAvoidSide && aabbEscapeSide !== committedAvoidSide;
        const aabbShouldOwnSide =
            aabbConflictsMemory &&
            (
                hardBuildingContact ||
                meshGlueContact ||
                deepEmbedContact ||
                earlyBuildingApproach ||
                facadeClosingNow ||
                (risk === 'high' && Number.isFinite(coverDistNow) && coverDistNow < 16) ||
                (Number.isFinite(coverDistNow) && coverDistNow < 10)
            );

        const hardEmbed =
            hardBuildingContact &&
            (deepEmbedContact || embeddedLane || (Number.isFinite(coverDistNow) && coverDistNow < 3));

        const canFlip =
            !Number.isFinite(lastFlipTurn) ||
            lastFlipTurn < -900 ||
            (turnNo - lastFlipTurn) >= EMBED_FLIP_COOLDOWN;

        const fallbackSide =
            urbanAvoidSide || gapSide || geometricAvoidSide || breakSide || 1;

        if (hardEmbed) {
            let escSide = 0;
            let embedFlip = 0;
            let source = 'fallback';
            if (aabbShouldOwnSide && aabbEscapeSide) {
                escSide = aabbEscapeSide;
                embedFlip = committedAvoidSide && aabbEscapeSide !== committedAvoidSide ? 1 : 0;
                source = 'aabbOverMemory';
            } else if (meshGlueContact && committedAvoidSide) {
                escSide = committedAvoidSide;
                source = 'committedGlue';
                if (
                    deepEmbedContact &&
                    Number.isFinite(coverDistNow) &&
                    coverDistNow < 0.85 &&
                    canFlip &&
                    gluePushStreak >= EMBED_FLIP_MIN_PUSH
                ) {
                    escSide = -committedAvoidSide;
                    embedFlip = 1;
                    source = 'deepGlueFlip';
                }
            } else if (aabbEscapeSide) {
                escSide = aabbEscapeSide;
                source = 'aabb';
            } else {
                escSide = fallbackSide;
                source = 'geomBreak';
            }
            const holdTurns = meshGlueContact || deepEmbedContact ? 8 : 4;
            const prevSide = committedAvoidSide || Math.sign(Number(ctx.memorySide) || 0);
            const nextGlueStreak = embedFlip
                ? 1
                : (prevSide === Math.sign(escSide) ? gluePushStreak + 1 : 1);
            return {
                side: escSide,
                source,
                embedFlip,
                holdTurns,
                nextGlueStreak,
                applyMemory: true,
                treeNote: aabbShouldOwnSide
                    ? `avoidSide: override=aabbOverMemory aabb=${aabbEscapeSide} was=${committedAvoidSide || 0} dist=${Number.isFinite(coverDistNow) ? coverDistNow.toFixed(1) : 'n/a'}`
                    : null,
                mode: 'hardEmbed',
                aabbEscapeSide,
                aabbShouldOwnSide: aabbShouldOwnSide ? 1 : 0
            };
        }

        const approachOverride =
            aabbEscapeSide &&
            (!committedAvoidSide || committedAvoidSide !== aabbEscapeSide) &&
            (
                earlyBuildingApproach ||
                facadeClosingNow ||
                aabbShouldOwnSide ||
                (risk === 'high' && Number.isFinite(coverDistNow) && coverDistNow < 18) ||
                (
                    risk === 'medium' &&
                    Number.isFinite(coverDistNow) &&
                    coverDistNow < 14 &&
                    Number.isFinite(fwd) &&
                    fwd > 0 &&
                    fwd < 16
                )
            );

        if (approachOverride) {
            return {
                side: aabbEscapeSide,
                source: 'aabbApproach',
                embedFlip: 0,
                holdTurns: 3,
                nextGlueStreak: 1,
                applyMemory: true,
                treeNote:
                    `avoidSide: override=aabbApproach aabb=${aabbEscapeSide} was=${committedAvoidSide || 0} early=${earlyBuildingApproach ? 1 : 0} facade=${facadeClosingNow ? 1 : 0}`,
                mode: 'approach',
                aabbEscapeSide,
                aabbShouldOwnSide: aabbShouldOwnSide ? 1 : 0
            };
        }

        return {
            side: fallbackSide,
            source: committedAvoidSide ? 'committed' : (gapSide ? 'gap' : (geometricAvoidSide ? 'geom' : 'break')),
            embedFlip: 0,
            holdTurns: 0,
            nextGlueStreak: gluePushStreak,
            applyMemory: false,
            treeNote: null,
            mode: 'passthrough',
            aabbEscapeSide,
            aabbShouldOwnSide: aabbShouldOwnSide ? 1 : 0
        };
    }

    return {
        ENGAGE_HANDOFF_DEFAULTS,
        EMBED_FLIP_COOLDOWN,
        EMBED_FLIP_MIN_PUSH,
        getRoofHeightDelta,
        isTrueUndercroft,
        computeAabbEscapeSide,
        mergeHandoffTuning,
        shouldHandoffEscapeToEngage,
        resolveAvoidSideAuthority
    };
});
