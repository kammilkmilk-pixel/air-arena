// ============================================================================
// physics.js - 物理與推演大腦 (連續節流閥 1.0–5.0 無段變速 + 減速板)
// ============================================================================

function getQuatAt(t, quats) { 
    if (!quats || quats.length === 0) return new THREE.Quaternion(); 
    if (t <= 0) return quats[0]; 
    if (t >= 1) return quats[quats.length - 1]; 
    let p = t * (quats.length - 1); 
    let idx = Math.floor(p); 
    return quats[idx].clone().slerp(quats[idx + 1], p - idx); 
}

/**
 * Resolve continuous throttle into sim knobs (thrust / turn / speed / brake).
 * Prefer CONFIG lerp via getThrottleStats; keep local fallback if config missing.
 */
function resolveThrottleSimKnobs(thres, aircraftType) {
    const t = (typeof clampThrottleLevel === 'function')
        ? clampThrottleLevel(thres)
        : Math.max(1, Math.min(5, Number(thres) || 4));
    if (typeof getThrottleStats === 'function') {
        const s = getThrottleStats(t, aircraftType);
        const speedMult = Array.isArray(s.speedProfile)
            ? (Number(s.speedProfile[0]) || 1)
            : 1.5;
        // BRK band: interpolate air-brake drag below throttle 2.
        let brakeDrag = 0;
        if (t < 2) brakeDrag = 140 * (2 - t);
        return {
            baseThrust: Number(s.thrust) || 0,
            turnLimit: Number(s.turnLimit) || 1,
            currentSpeedMult: speedMult,
            brakeDrag,
            heat: Number(s.heat) || 0
        };
    }
    // Legacy discrete fallback
    if (t >= 4.5) return { baseThrust: 180, turnLimit: 0.4, currentSpeedMult: 2.5, brakeDrag: 0 };
    if (t >= 3.5) return { baseThrust: 65, turnLimit: 0.7, currentSpeedMult: 1.5, brakeDrag: 0 };
    if (t >= 2.5) return { baseThrust: 30, turnLimit: 0.85, currentSpeedMult: 1.1, brakeDrag: 0 };
    if (t >= 1.5) return { baseThrust: 5, turnLimit: 1.0, currentSpeedMult: 0.8, brakeDrag: 0 };
    return { baseThrust: 0, turnLimit: 1.0, currentSpeedMult: 0.4, brakeDrag: 140 };
}

/**
 * 核心飛行物理模擬 (連續節流閥 + 減速板)
 * @param {Object} teamObj - 戰機狀態實體
 * @param {Array} chain - 操控指令鏈
 */
function simulateFlight(teamObj, chain) {
    if (!teamObj.wrapper) return { points: [], quats: [], finalAP: teamObj.ap };
    
    let simObj = new THREE.Object3D(); 
    simObj.position.copy(teamObj.wrapper.position); 
    simObj.quaternion.copy(teamObj.wrapper.userData.logicalQuat);
    
    let activeAP = Number.isFinite(Number(teamObj.ap)) ? Number(teamObj.ap) : 120; 
    let points = [simObj.position.clone()]; 
    let quats = [simObj.quaternion.clone()];
    const FRAMES = 30; 

    chain.forEach((cmd) => {
        let thres = (cmd.throttle != null ? cmd.throttle : teamObj.throttle) || 4;
        const knobs = resolveThrottleSimKnobs(thres, teamObj.type || 'mig21');
        const baseThrust = knobs.baseThrust;
        const turnLimit = knobs.turnLimit;
        const currentSpeedMult = knobs.currentSpeedMult;
        const brakeDrag = knobs.brakeDrag;

        let dYaw = ((cmd.yaw || 0) * turnLimit) / FRAMES; 
        let dPitch = ((cmd.pitch || 0) * turnLimit) / FRAMES; 
        let dRoll = (cmd.roll || 0) / FRAMES;

        for (let i = 0; i < FRAMES; i++) {
            let forwardVector = new THREE.Vector3(0, 0, 1).applyQuaternion(simObj.quaternion);
            
            // 💨 航空動力學阻力運算
            let yawDrag = Math.abs(dYaw * 180 / Math.PI) * FRAMES * 0.6;
            let pitchDrag = Math.abs(dPitch * 180 / Math.PI) * FRAMES * 0.25;
            let gravityDrag = forwardVector.y * 30; // 爬升掉AP，俯衝加AP
            // Thrust rebuilds AP inside the sim (not again in updateAP — that pinned energy at maxAp).
            // +10 flat rebuild per command (AP recovery speed +10).
            let thrustGain = baseThrust * 0.12 + 10;

            // 結算當前 AP
            activeAP = Math.max(-100, Math.min(MAX_AP, activeAP + (thrustGain - yawDrag - pitchDrag - brakeDrag) / FRAMES - gravityDrag / FRAMES));
            
            simObj.rotateY(dYaw); 
            simObj.rotateX(dPitch); 
            simObj.rotateZ(dRoll); 
            
            let rawSpeed = (Math.max(5, activeAP + baseThrust) * 0.015) / FRAMES;
            let gravityPull = forwardVector.y * 0.022 / 3; 
            let finalStepDistance = (rawSpeed * currentSpeedMult) - gravityPull;
            
            simObj.translateZ(Math.max(0.01, finalStepDistance)); 

            // 失速物理沉降：減輕懲罰（原每幀 0.08 → 0.05）
            if (teamObj.stalled) {
                simObj.position.y -= 0.05;
            }
            
            points.push(simObj.position.clone()); 
            quats.push(simObj.quaternion.clone());
        }
    });

    return { points, quats, finalAP: activeAP };
}

// ----------------------------------------------------------------------------
// C1 flight-path sampling (cubic Bézier / heading Hermite)
// Linear lerp of simulateFlight samples is a polyline splice: chords at a
// turn junction do not match aircraft heading, so the preview ribbon and the
// flown path show a sharp kink. Restore cubic Bézier with endpoint tangents
// equal to heading (when quats are provided) or Catmull-Rom (points only) so
// heading is C1-smooth. Preview ribbons, combat playback, guns, and AI must
// all call these helpers so planned and executed flight match.
// ----------------------------------------------------------------------------
const _pathScratch = {
    t0: null, t1: null, b0: null, b1: null, b2: null, b3: null, fwd: null
};
const _joinScratch = {
    p0: null, p3: null, t0: null, t1: null, b1: null, b2: null
};
function _ensurePathScratch() {
    if (_pathScratch.t0 || typeof THREE === 'undefined') return _pathScratch;
    _pathScratch.t0 = new THREE.Vector3();
    _pathScratch.t1 = new THREE.Vector3();
    _pathScratch.b0 = new THREE.Vector3();
    _pathScratch.b1 = new THREE.Vector3();
    _pathScratch.b2 = new THREE.Vector3();
    _pathScratch.b3 = new THREE.Vector3();
    _pathScratch.fwd = new THREE.Vector3();
    _joinScratch.p0 = new THREE.Vector3();
    _joinScratch.p3 = new THREE.Vector3();
    _joinScratch.t0 = new THREE.Vector3();
    _joinScratch.t1 = new THREE.Vector3();
    _joinScratch.b1 = new THREE.Vector3();
    _joinScratch.b2 = new THREE.Vector3();
    return _pathScratch;
}

function _pathChordLen(points, i) {
    const n = points.length;
    if (i < n - 1) return points[i].distanceTo(points[i + 1]);
    if (i > 0) return points[i].distanceTo(points[i - 1]);
    return 1;
}

/** Hermite tangent at sample i: aircraft heading * chord, else Catmull-Rom. */
function evalFlightPathTangentAtIndex(points, quats, i, out) {
    const n = points.length;
    const idx = Math.max(0, Math.min(n - 1, i | 0));
    if (!out) out = new THREE.Vector3();
    if (n < 2) {
        out.set(0, 0, 0);
        return out;
    }
    const chord = Math.max(1e-4, _pathChordLen(points, idx));
    const q = quats && quats[idx];
    if (q) {
        out.set(0, 0, 1);
        if (typeof out.applyQuaternion === 'function') out.applyQuaternion(q);
        const len = out.length();
        if (len > 1e-8) out.multiplyScalar(chord / len);
        else out.set(0, 0, chord);
        return out;
    }
    const i0 = Math.max(0, idx - 1);
    const i1 = Math.min(n - 1, idx + 1);
    out.copy(points[i1]);
    if (typeof out.sub === 'function') out.sub(points[i0]);
    else out.subVectors(points[i1], points[i0]);
    const span = Math.max(1, i1 - i0);
    out.multiplyScalar(1 / span);
    return out;
}

function _evalCubicBezier(p0, p1, p2, p3, t, out) {
    const u = 1 - t;
    const uu = u * u;
    const tt = t * t;
    const uuu = uu * u;
    const ttt = tt * t;
    out.set(
        uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
        uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
        uuu * p0.z + 3 * uu * t * p1.z + 3 * u * tt * p2.z + ttt * p3.z
    );
    return out;
}

function _evalCubicBezierDeriv(p0, p1, p2, p3, t, out) {
    const u = 1 - t;
    const uu = u * u;
    const tt = t * t;
    out.set(
        3 * uu * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * tt * (p3.x - p2.x),
        3 * uu * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * tt * (p3.y - p2.y),
        3 * uu * (p1.z - p0.z) + 6 * u * t * (p2.z - p1.z) + 3 * tt * (p3.z - p2.z)
    );
    return out;
}

/**
 * Evaluate C1 cubic Bézier along a sampled flight path.
 * @param {number} t in [0, 1] over the whole path
 * @param {Array} points THREE.Vector3 samples
 * @param {Array} [quats] matching headings (optional; Catmull-Rom tangents if omitted)
 * @param {THREE.Vector3} out
 */
function evalFlightPathPos(t, points, quats, out) {
    if (!out) out = new THREE.Vector3();
    if (!points || points.length === 0) {
        out.set(0, 0, 0);
        return out;
    }
    if (points.length === 1 || t <= 0) {
        out.copy(points[0]);
        return out;
    }
    if (t >= 1) {
        out.copy(points[points.length - 1]);
        return out;
    }
    const nseg = points.length - 1;
    const p = t * nseg;
    const idx = Math.min(nseg - 1, Math.max(0, Math.floor(p)));
    const local = p - idx;
    if (nseg === 1 && !(quats && quats.length >= 2)) {
        const a = points[0];
        const b = points[1];
        out.set(a.x + (b.x - a.x) * local, a.y + (b.y - a.y) * local, a.z + (b.z - a.z) * local);
        return out;
    }
    const S = _ensurePathScratch();
    evalFlightPathTangentAtIndex(points, quats, idx, S.t0);
    evalFlightPathTangentAtIndex(points, quats, idx + 1, S.t1);
    S.b0.copy(points[idx]);
    S.b3.copy(points[idx + 1]);
    S.b1.copy(S.b0).addScaledVector(S.t0, 1 / 3);
    S.b2.copy(S.b3).addScaledVector(S.t1, -1 / 3);
    return _evalCubicBezier(S.b0, S.b1, S.b2, S.b3, local, out);
}

/** dP/dt (t in [0,1] over the whole path). */
function evalFlightPathTangent(t, points, quats, out) {
    if (!out) out = new THREE.Vector3();
    if (!points || points.length < 2) {
        out.set(0, 0, 0);
        return out;
    }
    const tt = Math.max(0, Math.min(1, t));
    const nseg = points.length - 1;
    const p = tt * nseg;
    const idx = Math.min(nseg - 1, Math.max(0, Math.floor(p)));
    const local = p - idx;
    const S = _ensurePathScratch();
    evalFlightPathTangentAtIndex(points, quats, idx, S.t0);
    evalFlightPathTangentAtIndex(points, quats, idx + 1, S.t1);
    S.b0.copy(points[idx]);
    S.b3.copy(points[idx + 1]);
    S.b1.copy(S.b0).addScaledVector(S.t0, 1 / 3);
    S.b2.copy(S.b3).addScaledVector(S.t1, -1 / 3);
    _evalCubicBezierDeriv(S.b0, S.b1, S.b2, S.b3, local, out);
    out.multiplyScalar(nseg);
    return out;
}

/**
 * Cubic Bézier spanning two consecutive WE-GO turns around their shared junction.
 * `u` is in turn units (0 = start of log[0], 1 = junction, 1.5 = mid of log[1]).
 * Blend window is ±`blend` turns so heading stays C1 across the integer boundary.
 */
function _pathLogEntry(logs, idx, teamId) {
    const block = logs && logs[idx];
    if (!block) return null;
    if (teamId != null && block[teamId] && block[teamId].pts) return block[teamId];
    if (block.pts) return block;
    return null;
}

function evalFlightPathPosAcrossTurns(logs, u, blend, out, teamId) {
    if (!out) out = new THREE.Vector3();
    if (!Array.isArray(logs) || !logs.length) {
        out.set(0, 0, 0);
        return out;
    }
    const w = Math.max(0.02, Math.min(0.2, blend == null ? 0.08 : blend));
    const maxU = logs.length;
    const uu = Math.max(0, Math.min(maxU, u));
    let tIdx = Math.floor(uu);
    let frac = uu - tIdx;
    if (tIdx >= logs.length) {
        tIdx = logs.length - 1;
        frac = 1;
    }
    const sampleTurn = (idx, f, dest) => {
        const entry = _pathLogEntry(logs, idx, teamId);
        if (!entry || !entry.pts || entry.pts.length < 2) return false;
        evalFlightPathPos(f, entry.pts, entry.quats, dest);
        return true;
    };
    const k = Math.round(uu);
    if (k >= 1 && k <= logs.length - 1 && Math.abs(uu - k) < w) {
        const S = _ensurePathScratch();
        const u0 = k - w;
        const u1 = k + w;
        const i0 = Math.max(0, Math.floor(u0));
        const i1 = Math.min(logs.length - 1, Math.floor(u1));
        const f0 = Math.max(0, Math.min(1, u0 - i0));
        const f1 = i1 >= logs.length ? 1 : Math.max(0, Math.min(1, u1 - i1));
        const e0 = _pathLogEntry(logs, i0, teamId);
        const e1 = _pathLogEntry(logs, i1, teamId);
        const J = _joinScratch;
        if (e0 && e1 && J.p0 && sampleTurn(i0, f0, J.p0) && sampleTurn(i1, f1, J.p3)) {
            evalFlightPathTangent(f0, e0.pts, e0.quats, J.t0);
            evalFlightPathTangent(f1, e1.pts, e1.quats, J.t1);
            J.t0.multiplyScalar(2 * w);
            J.t1.multiplyScalar(2 * w);
            J.b1.copy(J.p0).addScaledVector(J.t0, 1 / 3);
            J.b2.copy(J.p3).addScaledVector(J.t1, -1 / 3);
            const local = (uu - u0) / Math.max(1e-4, u1 - u0);
            return _evalCubicBezier(J.p0, J.b1, J.b2, J.p3, local, out);
        }
    }
    const entry = _pathLogEntry(logs, tIdx, teamId);
    if (!entry || !entry.pts) {
        out.set(0, 0, 0);
        return out;
    }
    return evalFlightPathPos(frac, entry.pts, entry.quats, out);
}

function getPosAt(t, points, quats) {
    const out = new THREE.Vector3();
    return evalFlightPathPos(t, points, quats, out);
}

function getPathTangentAt(t, points, quats) {
    const out = new THREE.Vector3();
    return evalFlightPathTangent(t, points, quats, out);
}