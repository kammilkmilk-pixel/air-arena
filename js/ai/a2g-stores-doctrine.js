// ============================================================================
// a2g-stores-doctrine.js — AI employment for rocket (VT/Impact) + bomb
// Soft overlay only: does not rewrite stick geometry.
// Supports dirt-skimming air foes + Phase B map groundTargets (strike order).
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
            vtRadius: Number(wpn && wpn.vtRadius) || 4.5,
            blastRadius: Number(wpn && wpn.blastRadius) || 6
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
        const hadOwn = !!(team && Object.prototype.hasOwnProperty.call(team, 'rocketFuze'));
        const prev = team ? team.rocketFuze : undefined;
        if (team && typeof AirArenaRocket !== 'undefined' && AirArenaRocket.setTeamFuzeMode) {
            AirArenaRocket.setTeamFuzeMode(team, fuze);
        } else if (team) {
            team.rocketFuze = fuze === 'impact' ? 'impact' : 'vt';
        }
        try {
            return fn();
        } finally {
            if (team) {
                if (prev === undefined) {
                    if (hadOwn) team.rocketFuze = undefined;
                    else delete team.rocketFuze;
                } else if (typeof AirArenaRocket !== 'undefined' && AirArenaRocket.setTeamFuzeMode) {
                    AirArenaRocket.setTeamFuzeMode(team, prev);
                } else {
                    team.rocketFuze = prev;
                }
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
            || (Number.isFinite(sol.bestCpaDist) && sol.bestCpaDist <= vtR * 1.15);
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

    function groundPoint(gt) {
        if (!gt) return null;
        if (gt.wrapper && gt.wrapper.position) return gt.wrapper.position;
        if (typeof THREE !== 'undefined' && THREE.Vector3) {
            return new THREE.Vector3(Number(gt.x) || 0, Number(gt.y) || 0, Number(gt.z) || 0);
        }
        return { x: Number(gt.x) || 0, y: Number(gt.y) || 0, z: Number(gt.z) || 0 };
    }

    /** Impact rocket vs map ground target (blast / surface centroid). */
    function evaluateRocketImpactVsGround(team, groundTarget, ctx = {}) {
        if (!weaponAiEnabled('rocket')) return { ok: false, reason: 'disabled' };
        if (!teamRocketAmmo(team)) return { ok: false, reason: 'noAmmo' };
        if (!groundTarget || groundTarget.destroyed) return { ok: false, reason: 'noTarget' };
        const doc = getRocketDoctrine();
        const gp = groundPoint(groundTarget);
        if (typeof AirArenaRocket === 'undefined' || typeof AirArenaRocket.computeRocketAimSolution !== 'function') {
            const dist = Number(ctx.distance);
            const ang = Number(ctx.angleDeg);
            const soft = Number.isFinite(dist) && dist >= doc.impactMinSlant && dist <= doc.impactMaxSlant
                && Number.isFinite(ang) && ang <= 35;
            return soft
                ? { ok: true, reason: 'geomFallback', fuze: 'impact', groundTarget }
                : { ok: false, reason: 'noSolver' };
        }
        // Fake a grounded "enemy" at the objective so the existing impact solver can run.
        const fakeEnemy = {
            id: groundTarget.id,
            isDestroyed: false,
            wrapper: { position: gp, quaternion: (team.wrapper && team.wrapper.quaternion) || { x: 0, y: 0, z: 0, w: 1 } },
            flightLength: 0,
            pathPoints: null
        };
        const sol = withRocketFuze(team, 'impact', () => AirArenaRocket.computeRocketAimSolution(team, fakeEnemy));
        if (!sol || sol.fuze !== 'impact' || !sol.grounded || !sol.aimWorld) {
            return { ok: false, reason: 'ungrounded', sol };
        }
        const miss = horizDist(sol.aimWorld, gp);
        const missMax = (Number(sol.blastRadius) || doc.blastRadius) * doc.impactMissMaxFrac
            + (Number(groundTarget.radius) || 0) * 0.35;
        if (!(miss <= missMax)) return { ok: false, reason: 'miss', miss, missMax, sol };
        const slant = Number(sol.slantDist);
        if (Number.isFinite(slant) && (slant < doc.impactMinSlant || slant > doc.impactMaxSlant)) {
            return { ok: false, reason: 'slant', slant, sol };
        }
        return { ok: true, reason: 'gtImpact', fuze: 'impact', sol, miss, groundTarget };
    }

    /** Bomb CCIP vs map ground target. */
    function evaluateBombVsGround(team, groundTarget, ctx = {}) {
        if (!weaponAiEnabled('bomb')) return { ok: false, reason: 'disabled' };
        if (!teamBombReady(team)) return { ok: false, reason: 'noAmmo' };
        if (!groundTarget || groundTarget.destroyed) return { ok: false, reason: 'noTarget' };
        const doc = getBombDoctrine();
        const gp = groundPoint(groundTarget);
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
        const miss = horizDist(path.impact, gp);
        const missMax = doc.blastRadius * doc.missMaxFrac + (Number(groundTarget.radius) || 0) * 0.35;
        if (!(miss <= missMax)) return { ok: false, reason: 'miss', miss, missMax, path };
        const slant = rel.pos && path.impact && rel.pos.distanceTo
            ? rel.pos.distanceTo(path.impact)
            : Math.hypot(
                (rel.pos.x || 0) - (path.impact.x || 0),
                (rel.pos.y || 0) - (path.impact.y || 0),
                (rel.pos.z || 0) - (path.impact.z || 0)
            );
        if (Number.isFinite(slant) && (slant < doc.minSlant || slant > doc.maxSlant)) {
            return { ok: false, reason: 'slant', slant };
        }
        return { ok: true, reason: 'gtBomb', path, miss, slant, groundTarget };
    }

    /**
     * Strike-order stores pick: prefer bomb, then Impact rocket against a ground target.
     * Ignores air FOX priority (strike is an explicit A2G command).
     */
    function pickStrikeStoresCommit(action, team, groundTarget, ctx = {}) {
        if (!action || !team || !groundTarget || groundTarget.destroyed) return null;
        const q = action.queueAction || 'none';
        if (q === 'flare' || q === 'chaff') return null;
        if (isSurvivalState(action.state) && !/wingman/i.test(String(action.state || ''))) return null;

        const bomb = evaluateBombVsGround(team, groundTarget, ctx);
        if (bomb.ok) {
            return {
                weapon: 'bomb',
                queueAction: 'bomb',
                state: 'bombAttack',
                statusText: `炸彈｜${groundTarget.name || groundTarget.id}`,
                reason: `strike Bomb ${bomb.reason}`,
                note: bomb.reason,
                path: bomb.path || null,
                groundTargetId: groundTarget.id
            };
        }
        const impact = evaluateRocketImpactVsGround(team, groundTarget, ctx);
        if (impact.ok) {
            return {
                weapon: 'rocket',
                queueAction: 'rocket',
                rocketFuze: 'impact',
                state: 'rocketAttack',
                statusText: `火箭 IMPACT｜${groundTarget.name || groundTarget.id}`,
                reason: `strike Impact ${impact.reason}`,
                note: impact.reason,
                sol: impact.sol || null,
                groundTargetId: groundTarget.id
            };
        }
        return null;
    }

    function isSurvivalState(state) {
        const s = String(state || '');
        return /escape|avoid|recover|stall|ground|terrain|embed|pullUp|obstacleEmergency|postGround|energyCritical|defensive/i.test(s);
    }

    function missileOutOfEnvelope(ctx = {}) {
        if (ctx.fox2LaunchHold) return true;
        const dist = Number(ctx.distance);
        const ang = Number(ctx.angleDeg);
        const mslMin = Number(ctx.missileMinRange);
        const mslMax = Number(ctx.missileMaxRange);
        if (!Number.isFinite(dist) || !Number.isFinite(mslMin) || !Number.isFinite(mslMax)) return false;
        if (dist < mslMin || dist > mslMax * 0.98) return true;
        const cfg = readConfig();
        const mType = ctx.aiMissileType === 'fox1' ? 'fox1' : 'fox2';
        const mun = cfg && cfg.doctrine && cfg.doctrine.munition && cfg.doctrine.munition[mType];
        let launchCapDeg = Number(mun && mun.maxLaunchAngleDeg);
        if (!Number.isFinite(launchCapDeg)) {
            launchCapDeg = mType === 'fox1' ? 18 : 10;
        }
        if (mType === 'fox2' && ctx.frontAspect) {
            const wpn = cfg && cfg.weapons && cfg.weapons.fox2;
            const mult = (wpn && Number.isFinite(Number(wpn.frontAspectSeekerAngleMult)))
                ? Number(wpn.frontAspectSeekerAngleMult) : 0.4;
            launchCapDeg *= mult;
        }
        if (Number.isFinite(ang) && ang > launchCapDeg) return true;
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
        if (action.state === 'rocketLeadAttack' && q === 'rocket') return null;
        if (isSurvivalState(action.state)) return null;
        if (ctx.actualMissileThreat && (ctx.shouldFlareNow || ctx.shouldChaffNow)) return null;
        if (q === 'missile' && (action.missileType === 'fox1' || ctx.aiMissileType === 'fox1')) return null;
        if (ctx.fox1IlluminateHold) return null;

        const docR = getRocketDoctrine();
        const hasFox = teamHasFoxMissile(team);
        const outEnv = missileOutOfEnvelope(ctx);
        const enemyLowHp = !!ctx.enemyLowHp
            || (enemy && Number.isFinite(Number(enemy.hp)) && Number(enemy.hp) > 0 && Number(enemy.hp) <= 44);
        const gunSweet = !!ctx.gunSweetSpot;
        if (q === 'gun' && gunSweet) return null;

        const vt = evaluateRocketVtShot(team, enemy, ctx);
        // Conservative: do not steal in-envelope FOX unless enemy is low-HP finisher (<=44 HP).
        // VT fills dry racks, out-of-envelope soft holds, front-aspect holds, or low-HP finishers.
        const preferVt = vt.ok && (
            (!hasFox && docR.vtWhenMissileDry) ||
            (hasFox && outEnv && docR.vtWhenOutOfMissileEnvelope) ||
            (enemyLowHp && q !== 'missile') ||
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
        evaluateRocketImpactVsGround,
        evaluateBombVsGround,
        pickStoresCommit,
        pickStrikeStoresCommit,
        applyStoresCommit,
        isSurvivalState,
        missileOutOfEnvelope
    };
});
