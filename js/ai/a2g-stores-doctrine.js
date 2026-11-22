// ============================================================================
// a2g-stores-doctrine.js — AI employment for rocket (VT/Impact) + bomb
// Soft overlay only: does not rewrite stick geometry. Phase B ground-target
// schema still pending; Impact/bomb currently target dirt-skimming air foes.
// ============================================================================
(function initA2GStoresDoctrine(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AirArenaA2GStoresDoctrine = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    function readConfig() {
        if (typeof CONFIG !== 'undefined' && CONFIG) return CONFIG;
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

    function weaponAiEnabled(kind) {
        const cfg = readConfig();
        const row = cfg && cfg.weapons && cfg.weapons[kind];
        return !!(row && row.aiEnabled);
    }

    function pylonTypeOf(p) {
        if (typeof pylonWeaponType === 'function') return pylonWeaponType(p);
        return (p && p.weaponType) || 'fox2';
    }

    function teamRocketAmmo(team) {
        if (!team || !team.pylons) return 0;
        let n = 0;
        for (let i = 0; i < team.pylons.length; i++) {
            const p = team.pylons[i];
            if (!p || pylonTypeOf(p) !== 'rocket' || p.state === 'empty') continue;
            if (typeof AirArenaRocket !== 'undefined' && AirArenaRocket.ensurePodAmmo) {
                n += AirArenaRocket.ensurePodAmmo(p);
            } else {
                n += Math.max(0, Number(p.ammo) || 0);
            }
        }
        return n;
    }

    function teamBombReady(team) {
        if (!team || !team.pylons) return false;
        return team.pylons.some((p) => {
            if (!p || pylonTypeOf(p) !== 'bomb' || p.state === 'empty') return false;
            return p.state === 'armed' || p.state === 'standby' || p.state === 'powering';
        });
    }

    function teamHasFoxMissile(team) {
        if (!team || !team.pylons) return false;
        return team.pylons.some((p) => {
            if (!p || p.state === 'empty') return false;
            const t = pylonTypeOf(p);
            if (t !== 'fox1' && t !== 'fox2') return false;
            return p.state === 'armed' || p.state === 'standby' || p.state === 'powering';
        });
    }

    function getRocketDoctrine() {
        const cfg = readConfig();
        const row = cfg && cfg.doctrine && cfg.doctrine.munition && cfg.doctrine.munition.rocket;
        const wpn = cfg && cfg.weapons && cfg.weapons.rocket;
        return {
            vtMaxLaunchAngleDeg: Number(row && row.vtMaxLaunchAngleDeg) || 22,
            vtMinRange: Number(row && row.vtMinRange) || 18,
            vtMaxRange: Number(row && row.vtMaxRange) || (Number(wpn && wpn.range) || 120),
            vtWhenMissileDry: row && row.vtWhenMissileDry != null ? !!row.vtWhenMissileDry : true,
            vtWhenOutOfMissileEnvelope: row && row.vtWhenOutOfMissileEnvelope != null
                ? !!row.vtWhenOutOfMissileEnvelope : true,
            vtFillSoftHold: row && row.vtFillSoftHold != null ? !!row.vtFillSoftHold : true,
            impactEnemyAltMax: Number(row && row.impactEnemyAltMax) || 12,
            impactMissMaxFrac: Number(row && row.impactMissMaxFrac) || 0.9,
            impactMinSlant: Number(row && row.impactMinSlant) || 12,
            impactMaxSlant: Number(row && row.impactMaxSlant) || 140,
            vtRadius: Number(wpn && wpn.vtRadius) || 6,
            blastRadius: Number(wpn && wpn.blastRadius) || 8
        };
    }

    function getBombDoctrine() {
        const cfg = readConfig();
        const row = cfg && cfg.doctrine && cfg.doctrine.munition && cfg.doctrine.munition.bomb;
        const wpn = cfg && cfg.weapons && cfg.weapons.bomb;
        return {
            enemyAltMax: Number(row && row.enemyAltMax) || 10,
            missMaxFrac: Number(row && row.missMaxFrac) || 0.85,
            minSlant: Number(row && row.minSlant) || 10,
            maxSlant: Number(row && row.maxSlant) || 160,
            blastRadius: Number(wpn && wpn.blastRadius) || 10
        };
    }

    function horizDist(a, b) {
        if (!a || !b) return Infinity;
        const dx = (Number(a.x) || 0) - (Number(b.x) || 0);
        const dz = (Number(a.z) || 0) - (Number(b.z) || 0);
        return Math.hypot(dx, dz);
    }

    function withRocketFuze(team, fuze, fn) {
        const prev = team ? team.rocketFuze : undefined;
        if (team && typeof AirArenaRocket !== 'undefined' && AirArenaRocket.setTeamFuzeMode) {
            AirArenaRocket.setTeamFuzeMode(team, fuze);
        } else if (team) {
            team.rocketFuze = fuze === 'impact' ? 'impact' : 'vt';
        }
        try {
            return fn();
        } finally {
            if (team && typeof AirArenaRocket !== 'undefined' && AirArenaRocket.setTeamFuzeMode) {
                AirArenaRocket.setTeamFuzeMode(team, prev === 'impact' ? 'impact' : 'vt');
            } else if (team && prev != null) {
                team.rocketFuze = prev;
            }
        }
    }

    /**
     * VT (air-to-air) rocket window against a live air enemy.
     */
    function evaluateRocketVtShot(team, enemy, ctx = {}) {
        if (!weaponAiEnabled('rocket')) return { ok: false, reason: 'disabled' };
        if (!teamRocketAmmo(team)) return { ok: false, reason: 'noAmmo' };
        if (!enemy || !enemy.wrapper) return { ok: false, reason: 'noEnemy' };
        if (ctx.lineOfSightBlocked) return { ok: false, reason: 'los' };
        const doc = getRocketDoctrine();
        const dist = Number(ctx.distance);
        const ang = Number(ctx.angleDeg);
        if (Number.isFinite(dist) && (dist < doc.vtMinRange || dist > doc.vtMaxRange)) {
            return { ok: false, reason: 'range', dist };
        }
        if (Number.isFinite(ang) && ang > doc.vtMaxLaunchAngleDeg) {
            return { ok: false, reason: 'angle', angleDeg: ang };
        }
        if (typeof AirArenaRocket === 'undefined' || typeof AirArenaRocket.computeRocketAimSolution !== 'function') {
            // Geometric fallback (Node / missing solver): nose-on mid band.
            const lz = Number(ctx.localZ);
            const soft = Number.isFinite(ang) && ang <= doc.vtMaxLaunchAngleDeg * 0.85
                && (!Number.isFinite(lz) || lz >= 0.72);
            return soft
                ? { ok: true, reason: 'geomFallback', fuze: 'vt', sol: null }
                : { ok: false, reason: 'noSolver' };
        }
        const sol = withRocketFuze(team, 'vt', () => AirArenaRocket.computeRocketAimSolution(team, enemy));
        if (!sol || sol.fuze !== 'vt') return { ok: false, reason: 'noSol' };
        const vtR = Number(sol.vtRadius) || doc.vtRadius;
        const hit = !!sol.anyVtHit
            || (Number.isFinite(sol.bestCpaDist) && sol.bestCpaDist <= vtR * 1.05);
        if (!hit) return { ok: false, reason: 'noWindow', sol, bestCpaDist: sol.bestCpaDist };
        return { ok: true, reason: 'vtHit', fuze: 'vt', sol };
    }

    /**
     * Impact fuze vs dirt-skimming foe (blast / building / ground near them).
     */
    function evaluateRocketImpactShot(team, enemy, ctx = {}) {
        if (!weaponAiEnabled('rocket')) return { ok: false, reason: 'disabled' };
        if (!teamRocketAmmo(team)) return { ok: false, reason: 'noAmmo' };
        if (!enemy || !enemy.wrapper) return { ok: false, reason: 'noEnemy' };
        const doc = getRocketDoctrine();
        const enemyAlt = enemy.wrapper.position ? Number(enemy.wrapper.position.y) : NaN;
        if (!Number.isFinite(enemyAlt) || enemyAlt > doc.impactEnemyAltMax) {
            return { ok: false, reason: 'enemyHigh', enemyAlt };
        }
        if (typeof AirArenaRocket === 'undefined' || typeof AirArenaRocket.computeRocketAimSolution !== 'function') {
            return { ok: false, reason: 'noSolver' };
        }
        const sol = withRocketFuze(team, 'impact', () => AirArenaRocket.computeRocketAimSolution(team, enemy));
        if (!sol || sol.fuze !== 'impact' || !sol.grounded || !sol.aimWorld) {
            return { ok: false, reason: 'ungrounded', sol };
        }
        const miss = horizDist(sol.aimWorld, enemy.wrapper.position);
        const missMax = (Number(sol.blastRadius) || doc.blastRadius) * doc.impactMissMaxFrac;
        if (!(miss <= missMax)) return { ok: false, reason: 'miss', miss, missMax, sol };
        const slant = Number(sol.slantDist);
        if (Number.isFinite(slant) && (slant < doc.impactMinSlant || slant > doc.impactMaxSlant)) {
            return { ok: false, reason: 'slant', slant, sol };
        }
        return { ok: true, reason: 'impactNear', fuze: 'impact', sol, miss };
    }

    /**
     * Bomb CCIP vs dirt-skimming foe (blast on ground under / near them).
     */
    function evaluateBombShot(team, enemy, ctx = {}) {
        if (!weaponAiEnabled('bomb')) return { ok: false, reason: 'disabled' };
        if (!teamBombReady(team)) return { ok: false, reason: 'noAmmo' };
        if (!enemy || !enemy.wrapper) return { ok: false, reason: 'noEnemy' };
        const doc = getBombDoctrine();
        const enemyAlt = enemy.wrapper.position ? Number(enemy.wrapper.position.y) : NaN;
        if (!Number.isFinite(enemyAlt) || enemyAlt > doc.enemyAltMax) {
            return { ok: false, reason: 'enemyHigh', enemyAlt };
        }
        if (typeof AirArenaBomb === 'undefined'
            || typeof AirArenaBomb.estimateReleaseState !== 'function'
            || typeof AirArenaBomb.computeBallisticPath !== 'function') {
            return { ok: false, reason: 'noSolver' };
        }
        const pods = (typeof AirArenaBomb.teamBombPylons === 'function')
            ? AirArenaBomb.teamBombPylons(team)
            : (team.pylons || []).filter((p) => pylonTypeOf(p) === 'bomb');
        const pod = pods.find((p) => p && p.state !== 'empty') || pods[0];
        if (!pod) return { ok: false, reason: 'noPod' };
        const rel = AirArenaBomb.estimateReleaseState(team, pod);
        const path = AirArenaBomb.computeBallisticPath(rel.pos, rel.vel, {});
        if (!path || !path.hitGround || !path.impact) return { ok: false, reason: 'noImpact' };
        const miss = horizDist(path.impact, enemy.wrapper.position);
        const missMax = doc.blastRadius * doc.missMaxFrac;
        if (!(miss <= missMax)) return { ok: false, reason: 'miss', miss, missMax, path };
        const slant = rel.pos && path.impact ? rel.pos.distanceTo(path.impact) : NaN;
        if (Number.isFinite(slant) && (slant < doc.minSlant || slant > doc.maxSlant)) {
            return { ok: false, reason: 'slant', slant };
        }
        return { ok: true, reason: 'ccipNear', path, miss, slant };
    }

    function isSurvivalState(state) {
        const s = String(state || '');
        return /escape|avoid|recover|stall|ground|terrain|embed|pullUp|obstacleEmergency|postGround|energyCritical|defensive/i.test(s);
    }

    function missileOutOfEnvelope(ctx = {}) {
        const dist = Number(ctx.distance);
        const ang = Number(ctx.angleDeg);
        const mslMin = Number(ctx.missileMinRange);
        const mslMax = Number(ctx.missileMaxRange);
        if (!Number.isFinite(dist) || !Number.isFinite(mslMin) || !Number.isFinite(mslMax)) return false;
        if (dist < mslMin * 0.92 || dist > mslMax * 0.98) return true;
        const softAng = Number(ctx.missileAngleDeg) || 27;
        if (Number.isFinite(ang) && ang > softAng * 1.15) return true;
        return false;
    }

    /**
     * Pick a stores commit that may replace a soft gun/missile/none queue.
     * Never steals CM, survival, or FOX-1 illuminate commits.
     */
    function pickStoresCommit(action, team, enemy, ctx = {}) {
        if (!action || !team) return null;
        const q = action.queueAction || 'none';
        if (q === 'flare' || q === 'chaff') return null;
        if (isSurvivalState(action.state)) return null;
        if (ctx.actualMissileThreat && (ctx.shouldFlareNow || ctx.shouldChaffNow)) return null;
        if (q === 'missile' && (action.missileType === 'fox1' || ctx.aiMissileType === 'fox1')) return null;
        if (ctx.fox1IlluminateHold) return null;

        const docR = getRocketDoctrine();
        const hasFox = teamHasFoxMissile(team);
        const outEnv = missileOutOfEnvelope(ctx);
        const gunSweet = !!ctx.gunSweetSpot;
        if (q === 'gun' && gunSweet) return null;

        const vt = evaluateRocketVtShot(team, enemy, ctx);
        // Conservative: do not steal in-envelope FOX. VT fills dry racks or out-of-envelope soft holds.
        const preferVt = vt.ok && (
            (!hasFox && docR.vtWhenMissileDry) ||
            (hasFox && outEnv && docR.vtWhenOutOfMissileEnvelope) ||
            (!hasFox && docR.vtFillSoftHold && (q === 'none' || q === 'missile'))
        );

        if (preferVt) {
            return {
                weapon: 'rocket',
                queueAction: 'rocket',
                rocketFuze: 'vt',
                state: 'rocketAttack',
                statusText: '火箭 VT',
                reason: `stores VT ${vt.reason}`,
                note: vt.reason,
                sol: vt.sol || null
            };
        }

        const impact = evaluateRocketImpactShot(team, enemy, ctx);
        if (impact.ok && (q === 'none' || q === 'gun' || !hasFox || outEnv)) {
            return {
                weapon: 'rocket',
                queueAction: 'rocket',
                rocketFuze: 'impact',
                state: 'rocketAttack',
                statusText: '火箭 IMPACT',
                reason: `stores Impact ${impact.reason}`,
                note: impact.reason,
                sol: impact.sol || null
            };
        }

        const bomb = evaluateBombShot(team, enemy, ctx);
        if (bomb.ok && (q === 'none' || q === 'gun' || !hasFox || outEnv)) {
            return {
                weapon: 'bomb',
                queueAction: 'bomb',
                state: 'bombAttack',
                statusText: '炸彈 CCIP',
                reason: `stores Bomb ${bomb.reason}`,
                note: bomb.reason,
                path: bomb.path || null
            };
        }

        return null;
    }

    /**
     * Apply a stores commit onto an AI action (mutates). Returns action.
     */
    function applyStoresCommit(action, commit) {
        if (!action || !commit) return action;
        action.weapon = commit.weapon;
        action.queueAction = commit.queueAction;
        if (commit.rocketFuze) action.rocketFuze = commit.rocketFuze;
        action.powerPylons = false;
        action.singleMissile = false;
        if (commit.state) action.state = commit.state;
        if (commit.statusText) action.statusText = commit.statusText;
        if (commit.reason) {
            action.reason = action.reason
                ? `${action.reason} | ${commit.reason}`
                : commit.reason;
        }
        if (!action.debug) action.debug = {};
        action.debug.storesCommit = commit.note || commit.queueAction;
        action.debug.storesFuze = commit.rocketFuze || null;
        if (Array.isArray(action.debug.tree)) {
            action.debug.tree.push(
                `storesDoctrine: q=${commit.queueAction} fuze=${commit.rocketFuze || '-'} note=${commit.note || ''}`
            );
        }
        return action;
    }

    return {
        weaponAiEnabled,
        teamRocketAmmo,
        teamBombReady,
        teamHasFoxMissile,
        getRocketDoctrine,
        getBombDoctrine,
        evaluateRocketVtShot,
        evaluateRocketImpactShot,
        evaluateBombShot,
        pickStoresCommit,
        applyStoresCommit,
        isSurvivalState,
        missileOutOfEnvelope
    };
});
