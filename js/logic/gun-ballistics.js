// ============================================================================
// gun-ballistics.js — Single source of truth for autocannon ballistics
// Shared by planning preview (updateGunPreview), combat hit resolution
// (combat-resolution.js), and live/ACMI tracer rendering (autocannon-vfx.js).
// Pure math + scratch-vector friendly so preview curve, muzzle fire, tracers,
// and hit points align 1:1 with zero per-frame garbage collection.
// ============================================================================

(function initGunBallistics(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaGunBallistics = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const DEFAULT_BARRELS = [
        [-0.05, -0.12, 0.45],
        [0.05, -0.12, 0.45]
    ];
    const DEFAULT_CENTER_MUZZLE = [0, -0.12, 0.45];

    function num(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function gunConfig() {
        return (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.gun)
            ? CONFIG.weapons.gun
            : {};
    }

    function vfxConfig() {
        const v = (typeof CONFIG !== 'undefined' && CONFIG.visuals && CONFIG.visuals.autocannon)
            ? CONFIG.visuals.autocannon
            : {};
        return {
            enabled: v.enabled !== false,
            roundsPerTurn: Math.max(12, Math.min(48, Math.round(num(v.roundsPerTurn, 28)))),
            maxFlightTime: Math.max(0.4, Math.min(2.0, num(v.maxFlightTime, 0.85))),
            spreadRad: Math.max(0, Math.min(0.03, num(v.spreadRad, 0.0055))),
            tracerLength: Math.max(0.8, Math.min(6.0, num(v.tracerLength, 2.75))),
            tracerWidth: Math.max(0.03, Math.min(0.35, num(v.tracerWidth, 0.095))),
            groundY: num(v.groundY, -0.02)
        };
    }

    function getBarrels(aircraftType) {
        const type = aircraftType || 'mig21';
        const ac = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts && CONFIG.aircrafts[type])
            ? CONFIG.aircrafts[type]
            : null;
        if (ac && Array.isArray(ac.guns) && ac.guns.length > 0) {
            return ac.guns.map((g) => (Array.isArray(g.position) ? g.position : DEFAULT_CENTER_MUZZLE));
        }
        return DEFAULT_BARRELS;
    }

    function getCenterMuzzle(aircraftType) {
        const barrels = getBarrels(aircraftType);
        if (!barrels.length) return DEFAULT_CENTER_MUZZLE.slice();
        let x = 0, y = 0, z = 0;
        for (let i = 0; i < barrels.length; i++) {
            x += num(barrels[i][0], 0);
            y += num(barrels[i][1], -0.12);
            z += num(barrels[i][2], 0.45);
        }
        const inv = 1 / barrels.length;
        return [x * inv, y * inv, z * inv];
    }

    /** Resolve throttle-scaled gun range, muzzle speed (world units / turn), gravity, and elevation. */
    function resolveGunParams(aircraftType, throttle) {
        const type = aircraftType || 'mig21';
        const gcfg = gunConfig();
        const baseRange = (typeof GUN_RANGE !== 'undefined' && Number.isFinite(Number(GUN_RANGE)))
            ? Number(GUN_RANGE)
            : num(gcfg.range, 70);
        const baseAngle = (typeof GUN_ANGLE !== 'undefined' && Number.isFinite(Number(GUN_ANGLE)))
            ? Number(GUN_ANGLE)
            : num(gcfg.angle, Math.PI / 36);
        const stats = (typeof getThrottleStats === 'function')
            ? getThrottleStats(throttle != null ? throttle : 4, type)
            : { gunRangeMult: 1.0, gunAngleMult: 1.0 };

        const dRange = baseRange * num(stats.gunRangeMult, 1.0);
        const dAngle = baseAngle * num(stats.gunAngleMult, 1.0);
        const muzzleSpeed = dRange * 2.0; // world units per turn-unit (1 turn = 1.0)
        const baseGravity = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.gravity != null)
            ? Number(CONFIG.rules.gravity)
            : 9.8;
        const gravMult = gcfg.gravityMult != null ? Number(gcfg.gravityMult) : 1.2;
        const gravity = baseGravity * gravMult;
        const elevation = num(gcfg.elevation, 0);

        return {
            dRange,
            dAngle,
            muzzleSpeed,
            gravity,
            elevation,
            barrels: getBarrels(type),
            centerMuzzle: getCenterMuzzle(type)
        };
    }

    /** Exact linear interpolation of position array (matches getPosAt without allocating). */
    function samplePosAt(t, pts, out) {
        if (!pts || !pts.length) {
            out.set(0, 0, 0);
            return out;
        }
        if (pts.length === 1 || t <= 0) {
            out.copy(pts[0]);
            return out;
        }
        if (t >= 1) {
            out.copy(pts[pts.length - 1]);
            return out;
        }
        const p = t * (pts.length - 1);
        const idx = Math.floor(p);
        const f = p - idx;
        const a = pts[idx];
        const b = pts[Math.min(pts.length - 1, idx + 1)];
        out.set(
            a.x + (b.x - a.x) * f,
            a.y + (b.y - a.y) * f,
            a.z + (b.z - a.z) * f
        );
        return out;
    }

    /** Exact quaternion slerp (matches getQuatAt without cloning extra objects). */
    function sampleQuatAt(t, quats, out) {
        if (!quats || !quats.length) {
            out.set(0, 0, 0, 1);
            return out;
        }
        if (quats.length === 1 || t <= 0) {
            out.copy(quats[0]);
            return out;
        }
        if (t >= 1) {
            out.copy(quats[quats.length - 1]);
            return out;
        }
        const p = t * (quats.length - 1);
        const idx = Math.floor(p);
        const f = p - idx;
        out.copy(quats[idx]);
        const next = quats[Math.min(quats.length - 1, idx + 1)];
        if (typeof out.slerp === 'function') out.slerp(next, f);
        return out;
    }

    /** Finite-difference aircraft velocity (world units per turn-unit) at t in [0, 1]. */
    function sampleAircraftVelocity(t, pts, outVel, scratchA, scratchB) {
        const dt = 0.02;
        if (!pts || pts.length < 2) {
            outVel.set(0, 0, 0);
            return outVel;
        }
        const t0 = Math.max(0, t - dt * 0.5);
        const t1 = Math.min(1, t + dt * 0.5);
        const span = Math.max(1e-4, t1 - t0);
        const a = scratchA || { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; } };
        const b = scratchB || { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; } };
        samplePosAt(t0, pts, a);
        samplePosAt(t1, pts, b);
        outVel.set((b.x - a.x) / span, (b.y - a.y) / span, (b.z - a.z) / span);
        return outVel;
    }

    /** Transform wrapper-local muzzle/barrel offset into world space. */
    function computeMuzzleWorldPos(acPos, acQuat, localOffset, outPos) {
        outPos.set(
            num(localOffset && localOffset[0], 0),
            num(localOffset && localOffset[1], -0.12),
            num(localOffset && localOffset[2], 0.45)
        );
        if (acQuat && typeof outPos.applyQuaternion === 'function') {
            outPos.applyQuaternion(acQuat);
        }
        outPos.x += acPos.x;
        outPos.y += acPos.y;
        outPos.z += acPos.z;
        return outPos;
    }

    /**
     * Compute initial bullet velocity in world space (world units / turn):
     *   v0 = dir(quat, elevation, spreadRight, spreadUp) * muzzleSpeed + acVel
     */
    function computeBulletVelocity(acQuat, acVel, muzzleSpeed, elevation, spreadRight, spreadUp, outVel) {
        const el = num(elevation, 0);
        const sx = num(spreadRight, 0);
        const sy = num(spreadUp, 0);
        outVel.set(sx, Math.sin(el) + sy, Math.cos(el));
        if (typeof outVel.normalize === 'function') outVel.normalize();
        if (acQuat && typeof outVel.applyQuaternion === 'function') {
            outVel.applyQuaternion(acQuat);
        }
        outVel.x = outVel.x * muzzleSpeed + (acVel ? acVel.x : 0);
        outVel.y = outVel.y * muzzleSpeed + (acVel ? acVel.y : 0);
        outVel.z = outVel.z * muzzleSpeed + (acVel ? acVel.z : 0);
        return outVel;
    }

    /** Deterministic round spread (rad) for round index `b` and turn index `logIdx`. */
    function roundSpread(b, logIdx, spreadRad) {
        const amp = num(spreadRad, 0.0055);
        if (amp <= 0) return { right: 0, up: 0 };
        const h1 = Math.sin((b + 1) * 12.9898 + (logIdx + 1) * 78.233) * 43758.5453;
        const h2 = Math.sin((b + 1) * 93.9898 + (logIdx + 1) * 67.345) * 24634.6345;
        const r1 = (h1 - Math.floor(h1)) * 2 - 1;
        const r2 = (h2 - Math.floor(h2)) * 2 - 1;
        return { right: r1 * amp, up: r2 * amp };
    }

    /** Round spawn timestamp t_spawn in [0, 0.96] for round index b in [0, roundsPerTurn-1]. */
    function roundSpawnTime(b, roundsPerTurn) {
        const n = Math.max(1, roundsPerTurn || 28);
        if (n <= 1) return 0;
        return (b / (n - 1)) * 0.96;
    }

    /** Exact parabolic bullet position at elapsed time dt (in turns). */
    function evalBallisticPoint(startPos, vel0, gravity, dt, outPos) {
        const t = Math.max(0, dt);
        outPos.set(
            startPos.x + vel0.x * t,
            startPos.y + vel0.y * t - 0.5 * gravity * t * t,
            startPos.z + vel0.z * t
        );
        return outPos;
    }

    /** Exact parabolic bullet velocity tangent at elapsed time dt (in turns). */
    function evalBallisticVel(vel0, gravity, dt, outVel) {
        const t = Math.max(0, dt);
        outVel.set(vel0.x, vel0.y - gravity * t, vel0.z);
        return outVel;
    }

    /** Analytic time dt > 0 when parabola hits plane y = groundY (or null if never). */
    function groundImpactTime(startY, velY, gravity, groundY) {
        const y0 = startY - groundY;
        if (y0 <= 0) return 0;
        if (gravity <= 1e-6) {
            return velY < -1e-6 ? (y0 / -velY) : null;
        }
        // -0.5*g*t^2 + vy*t + y0 = 0 => 0.5*g*t^2 - vy*t - y0 = 0
        const a = 0.5 * gravity;
        const disc = velY * velY + 4 * a * y0;
        if (disc < 0) return null;
        const t = (velY + Math.sqrt(disc)) / (2 * a);
        return t >= 0 ? t : null;
    }

    return {
        vfxConfig,
        getBarrels,
        getCenterMuzzle,
        resolveGunParams,
        samplePosAt,
        sampleQuatAt,
        sampleAircraftVelocity,
        computeMuzzleWorldPos,
        computeBulletVelocity,
        roundSpread,
        roundSpawnTime,
        evalBallisticPoint,
        evalBallisticVel,
        groundImpactTime
    };
});
