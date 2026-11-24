// ============================================================================
// stall-vfx.js — Realistic Aerodynamic Stall Visuals
// Replaces laminar high-speed wake illusions during stall with:
//   1. Continuous stall-intensity evaluation (explicit flag + AP onset + kinematic mushing)
//   2. Visual-only airframe buffet shudder & post-stall wing rock on `modelPivot`
//   3. Separated turbulent wing-surface airflow eddies & shredded vortex wisps
//   4. Engine compressor-stall sputtering exhaust modulation & intermittent dark cough puffs
// Deterministic & ACMI-scrub-safe; zero per-frame allocations.
// ============================================================================
(function initAirArenaStallVfx(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        root.AirArenaStallVfx = api;
        root.updateStallVfx = api.updateStallVfx;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    'use strict';

    const DEFAULT_CFG = {
        enabled: true,
        onsetApOffset: 8,
        buffetRollRad: 0.135,
        buffetPitchRad: 0.042,
        buffetYawRad: 0.045,
        buffetPosAmp: 0.018,
        eddiesPerAircraft: 14,
        smokePerAircraft: 6,
        eddyOpacity: 0.52,
        smokeOpacity: 0.44
    };

    function getCfg() {
        const user = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.visuals && CONFIG.visuals.stall)
            ? CONFIG.visuals.stall
            : null;
        return user ? Object.assign({}, DEFAULT_CFG, user) : DEFAULT_CFG;
    }

    function getStallSpeedAP() {
        return (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.rules && Number.isFinite(Number(CONFIG.rules.stallSpeedAP)))
            ? Number(CONFIG.rules.stallSpeedAP)
            : 35;
    }

    function smooth01(e0, e1, x) {
        if (Math.abs(e1 - e0) < 1e-5) return x >= e1 ? 1 : 0;
        const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
    }

    function hash01(n) {
        const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
        return s - Math.floor(s);
    }

    /**
     * Pure aerodynamic stall intensity in [0, 1].
     * Combines explicit stall flag, AP margin around stallSpeedAP, and
     * kinematic airflow separation (high mushing slip angle at low forward airspeed).
     */
    function computeStallFactor(metrics) {
        const m = metrics || {};
        const c = getCfg();
        if (!c.enabled) return 0;

        const stallAP = Number.isFinite(Number(m.stallSpeedAP)) ? Number(m.stallSpeedAP) : getStallSpeedAP();
        const onsetAP = stallAP + (Number(c.onsetApOffset) || 8);

        let factor = 0;

        if (m.stalled) {
            factor = Math.max(factor, 0.88);
        }

        if (Number.isFinite(Number(m.ap))) {
            const ap = Number(m.ap);
            // Smooth onset from onsetAP (e.g. 43) down to stallAP (35) and deeper below stallAP
            const onset = smooth01(onsetAP, stallAP, ap) * 0.55;
            const deep = smooth01(stallAP + 1, Math.max(5, stallAP - 16), ap);
            factor = Math.max(factor, onset, deep);
        }

        // Kinematic mushing detection (critical for legacy logs or mid-turn vertical stall):
        // High slip/AoA angle (>18 deg) combined with collapsed forward airspeed (<6.8 units/turn)
        if (Number.isFinite(Number(m.forwardSpeed)) && Number.isFinite(Number(m.slipAngleDeg))) {
            const fwdSpd = Number(m.forwardSpeed);
            const slipDeg = Math.abs(Number(m.slipAngleDeg));
            const lowSpeed = smooth01(7.2, 2.2, fwdSpd);
            const highSlip = smooth01(16, 42, slipDeg);
            const kinematic = lowSpeed * highSlip;
            // Pure very-low forward speed (hanging on nose at apex) also indicates stall.
            // Threshold sits below normal IDL/ECO cruise (~1.7–3.2 u/turn) so cruising jets are not flagged stalled.
            const apexHang = smooth01(1.6, 0.55, fwdSpd) * 0.85;
            factor = Math.max(factor, kinematic, apexHang);
        }

        return Math.max(0, Math.min(1, factor));
    }

    /**
     * Deterministic visual-only buffet & wing-rock offsets for `modelPivot`.
     */
    function computeBuffetOffsets(stallFactor, phaseSec, seedOffset) {
        const s = Math.max(0, Math.min(1, Number(stallFactor) || 0));
        if (s <= 0.02) {
            return { rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, posZ: 0 };
        }
        const c = getCfg();
        const t = Number(phaseSec) || 0;
        const ph = Number(seedOffset) || 0;
        const amp = Math.pow(s, 1.25);

        // Organic low-frequency wing rock (2.1..3.3 Hz) + high-frequency separated-flow shudder (15..22 Hz)
        const wingRock = Math.sin(t * 14.5 + ph) * 0.65 + Math.sin(t * 21.3 + ph * 1.7) * 0.35;
        const hfRoll = Math.sin(t * 96.0 + ph * 3.1) * 0.24;
        const rotZ = (wingRock * 0.78 + hfRoll * 0.22) * c.buffetRollRad * amp;

        const pitchShudder = Math.sin(t * 78.0 + ph * 2.3) * 0.55 + Math.sin(t * 19.0 + ph) * 0.45;
        const rotX = pitchShudder * c.buffetPitchRad * amp;

        const yawWander = Math.sin(t * 11.2 + ph * 0.9) * 0.7 + Math.sin(t * 64.0 + ph * 4.1) * 0.3;
        const rotY = yawWander * c.buffetYawRad * amp;

        const posY = Math.sin(t * 88.0 + ph * 1.3) * c.buffetPosAmp * amp;
        const posX = Math.cos(t * 71.0 + ph * 2.9) * c.buffetPosAmp * 0.65 * amp;
        return { rotX, rotY, rotZ, posX, posY, posZ: 0 };
    }

    /**
     * Engine compressor-stall / sputtering exhaust modulation during stall.
     * Normal flight (stallFactor <= 0.05) returns neutral multipliers (1.0).
     */
    function computeExhaustMod(stallFactor, throttle, nowMs, seedOffset) {
        const s = Math.max(0, Math.min(1, Number(stallFactor) || 0));
        if (s <= 0.05) {
            return { scaleZMult: 1.0, scaleXYMult: 1.0, opacityMult: 1.0, surgePop: 0 };
        }
        const t = (Number(nowMs) || 0) * 0.001;
        const ph = Number(seedOffset) || 0;
        const thr = Math.max(1, Math.min(5, Number(throttle) || 2));
        // Higher throttle during stall suffers stronger intake distortion / compressor chugging
        const thrDistort = 0.55 + (thr - 1) * 0.14;
        const chug = 0.5 + 0.5 * Math.sin(t * 31.0 + ph) * Math.cos(t * 19.0 + ph * 1.9);
        // Occasional sharp compressor-stall flame pop
        const burstWave = Math.sin(t * 7.8 + ph * 2.3) * Math.sin(t * 13.7 + ph * 0.7);
        const surgePop = burstWave > 0.78 ? Math.min(1, (burstWave - 0.78) / 0.22) * s * thrDistort : 0;

        // Overall plume shortens & flickers erratically when starved of clean intake air
        const sputterCut = s * thrDistort * (0.42 + 0.38 * chug);
        const scaleZMult = Math.max(0.18, 1.0 - sputterCut + surgePop * 0.45);
        const scaleXYMult = Math.max(0.55, 1.0 - s * 0.18 + surgePop * 0.38);
        const opacityMult = Math.max(0.22, 1.0 - s * (0.35 + 0.4 * chug) + surgePop * 0.35);
        return { scaleZMult, scaleXYMult, opacityMult, surgePop };
    }

    // ------------------------------------------------------------------------
    // Browser-side timeline sampler & zero-GC 3D pooled VFX renderer
    // ------------------------------------------------------------------------
    const seatStallState = Object.create(null);

    function currentTimelineCursor(battleLogRef) {
        const logArr = battleLogRef || (typeof battleLog !== 'undefined' ? battleLog : null);
        if (!Array.isArray(logArr) || !logArr.length) return null;
        if (typeof GameContext !== 'undefined' && GameContext.isReplayMode && GameContext.isReplayMode()) {
            const val = Number(GameContext.state && GameContext.state.virtualReplayTime) || 1.0;
            return Math.max(0, Math.min(logArr.length, val - 1.0));
        }
        if (typeof GameContext !== 'undefined' && GameContext.isAnimating && GameContext.isAnimating()) {
            const prog = Math.max(0, Math.min(1, Number(GameContext.state && GameContext.state.animProgress) || 0));
            return (logArr.length - 1) + prog;
        }
        return null; // Planning idle -> use live team.stalled & team.ap
    }

    function samplePosePlain(entry, frac) {
        if (!entry || !Array.isArray(entry.pts) || entry.pts.length < 2) return null;
        const f = Math.max(0, Math.min(1, frac));
        const n = entry.pts.length - 1;
        const posF = f * n;
        const i0 = Math.min(n, Math.floor(posF));
        const i1 = Math.min(n, i0 + 1);
        const t = posF - i0;
        const a = entry.pts[i0], b = entry.pts[i1];
        const pos = {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t
        };
        const qArr = entry.quats;
        const q = (Array.isArray(qArr) && qArr.length)
            ? qArr[Math.min(qArr.length - 1, Math.round(f * (qArr.length - 1)))]
            : { x: 0, y: 0, z: 0, w: 1 };
        return { pos, quat: q || { x: 0, y: 0, z: 0, w: 1 } };
    }

    function applyQuatToForward(q) {
        const qx = q.x || 0, qy = q.y || 0, qz = q.z || 0, qw = (q.w != null ? q.w : 1);
        // Forward (0, 0, 1) rotated by quaternion q
        const x = 2 * (qx * qz + qw * qy);
        const y = 2 * (qy * qz - qw * qx);
        const z = 1 - 2 * (qx * qx + qy * qy);
        const l = Math.hypot(x, y, z) || 1;
        return { x: x / l, y: y / l, z: z / l };
    }

    /**
     * Evaluate stall telemetry for aircraft `id` at timeline cursor `u` (or live planning state if u == null).
     */
    function sampleStallAtU(id, u, battleLogRef, teamsRef) {
        const logArr = battleLogRef || (typeof battleLog !== 'undefined' ? battleLog : null);
        const tMap = teamsRef || (typeof teams !== 'undefined' ? teams : null);
        const team = tMap ? tMap[id] : null;

        if (u == null || !Array.isArray(logArr) || !logArr.length) {
            if (!team) return { stallFactor: 0, forwardSpeed: 15, slipAngleDeg: 0, isStalled: false };
            const sf = computeStallFactor({ stalled: !!team.stalled, ap: team.ap });
            return { stallFactor: sf, forwardSpeed: team.stalled ? 3.5 : 18, slipAngleDeg: team.stalled ? 28 : 0, isStalled: sf >= 0.45 };
        }

        let tIdx = Math.floor(u);
        let frac = u - tIdx;
        if (tIdx >= logArr.length) {
            tIdx = logArr.length - 1;
            frac = 1.0;
        }
        if (tIdx < 0) tIdx = 0;

        const entry = logArr[tIdx] && logArr[tIdx][id];
        if (!entry || !Array.isArray(entry.pts) || entry.pts.length < 2) {
            return { stallFactor: 0, forwardSpeed: 15, slipAngleDeg: 0, isStalled: false };
        }

        // Kinematic velocity & slip angle from local path derivative
        const halfDf = 0.03;
        const f0 = Math.max(0, frac - halfDf);
        const f1 = Math.min(1, frac + halfDf);
        const df = Math.max(1e-4, f1 - f0);
        const s0 = samplePosePlain(entry, f0);
        const s1 = samplePosePlain(entry, f1);
        const sMid = samplePosePlain(entry, frac);

        let forwardSpeed = 15;
        let slipAngleDeg = 0;
        if (s0 && s1 && sMid) {
            const vx = (s1.pos.x - s0.pos.x) / df;
            const vy = (s1.pos.y - s0.pos.y) / df;
            const vz = (s1.pos.z - s0.pos.z) / df;
            const spd = Math.hypot(vx, vy, vz);
            const nose = applyQuatToForward(sMid.quat);
            forwardSpeed = vx * nose.x + vy * nose.y + vz * nose.z;
            if (spd > 1e-4) {
                const dot = Math.max(-1, Math.min(1, forwardSpeed / spd));
                slipAngleDeg = Math.acos(dot) * (180 / Math.PI);
            }
        }

        // Interpolated AP if recorded on turn log
        let ap = undefined;
        const startAP = Number.isFinite(Number(entry.startAP)) ? Number(entry.startAP) : NaN;
        const endAP = Number.isFinite(Number(entry.endAP))
            ? Number(entry.endAP)
            : (entry.chain && entry.chain[0] && Number.isFinite(Number(entry.chain[0].resultingAP))
                ? Number(entry.chain[0].resultingAP)
                : NaN);
        if (Number.isFinite(startAP) && Number.isFinite(endAP)) {
            ap = startAP + (endAP - startAP) * frac;
        } else if (Number.isFinite(endAP)) {
            ap = endAP;
        }

        const stalledFlag = !!entry.stalled;
        const sf = computeStallFactor({
            stalled: stalledFlag,
            ap,
            forwardSpeed,
            slipAngleDeg
        });

        return {
            stallFactor: sf,
            forwardSpeed,
            slipAngleDeg,
            isStalled: sf >= 0.45
        };
    }

    // ------------------------------------------------------------------------
    // Three.js Pooled Turbulent Wing Eddies & Compressor-Stall Cough Smoke
    // ------------------------------------------------------------------------
    let sharedReady = false;
    let eddyTex = null;
    let smokeTex = null;
    let eddyGeo = null;
    const fxByTeam = Object.create(null);

    const _vPos = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _vLocal = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _vFwd = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _vUp = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _vRight = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _vRelWind = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _vPosA = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _vPosB = (typeof THREE !== 'undefined') ? new THREE.Vector3() : null;
    const _qTmp = (typeof THREE !== 'undefined') ? new THREE.Quaternion() : null;
    const _qZ = (typeof THREE !== 'undefined') ? new THREE.Quaternion() : null;
    const _axisZ = (typeof THREE !== 'undefined') ? new THREE.Vector3(0, 0, 1) : null;

    function buildTextures() {
        if (sharedReady || typeof document === 'undefined' || typeof THREE === 'undefined') return;
        sharedReady = true;
        eddyGeo = new THREE.PlaneGeometry(1, 1);

        // 1) Shredded turbulent boundary-layer shear eddy texture (broken curl, NOT a clean circle)
        {
            const S = 64;
            const c = document.createElement('canvas');
            c.width = S; c.height = S;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(S, S);
            const d = img.data;
            for (let y = 0; y < S; y++) {
                for (let x = 0; x < S; x++) {
                    const nx = (x / (S - 1)) * 2 - 1;
                    const ny = (y / (S - 1)) * 2 - 1;
                    const r = Math.hypot(nx, ny);
                    const ang = Math.atan2(ny, nx);
                    // Swirling asymmetric curl representing separated turbulent airflow eddy
                    const swirl = 0.55 + 0.45 * Math.sin(ang * 2.0 + r * 5.2);
                    const wisp = 0.65 + 0.35 * Math.cos(ang * 3.0 - r * 3.4);
                    const radial = Math.max(0, 1 - r) * smooth01(0.05, 0.35, r) + Math.max(0, 1 - r * 1.45) * 0.45;
                    const a = Math.max(0, Math.min(1, radial * swirl * wisp * 1.15));
                    const idx = (y * S + x) * 4;
                    // Cool pale mist-slate (visibly turbulent, never glowing white contrail)
                    const shade = Math.round(215 + 28 * (1 - r));
                    d[idx] = shade - 10;
                    d[idx + 1] = shade - 2;
                    d[idx + 2] = Math.min(255, shade + 12);
                    d[idx + 3] = Math.round(a * 205);
                }
            }
            ctx.putImageData(img, 0, 0);
            eddyTex = new THREE.CanvasTexture(c);
            eddyTex.needsUpdate = true;
        }

        // 2) Dark compressor-stall unburned-fuel cough smoke puff
        {
            const S = 64;
            const c = document.createElement('canvas');
            c.width = S; c.height = S;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(S, S);
            const d = img.data;
            for (let y = 0; y < S; y++) {
                for (let x = 0; x < S; x++) {
                    const nx = (x / (S - 1)) * 2 - 1;
                    const ny = (y / (S - 1)) * 2 - 1;
                    const r = Math.hypot(nx, ny);
                    const ang = Math.atan2(ny, nx);
                    const billow = 0.72 + 0.28 * Math.sin(ang * 3 + r * 3.8);
                    const a = Math.pow(Math.max(0, 1 - r), 1.45) * billow;
                    const shade = Math.round(48 + 42 * (1 - ny * 0.5) * (1 - r * 0.4));
                    const idx = (y * S + x) * 4;
                    d[idx] = shade + 6;
                    d[idx + 1] = shade + 2;
                    d[idx + 2] = shade;
                    d[idx + 3] = Math.round(Math.min(1, a) * 215);
                }
            }
            ctx.putImageData(img, 0, 0);
            smokeTex = new THREE.CanvasTexture(c);
            smokeTex.needsUpdate = true;
        }
    }

    function ensureTeamPool(id) {
        if (fxByTeam[id]) return fxByTeam[id];
        if (typeof scene === 'undefined' || !scene || typeof THREE === 'undefined') return null;
        buildTextures();
        if (!sharedReady) return null;

        const c = getCfg();
        const eddies = [];
        const smokes = [];

        for (let i = 0; i < c.eddiesPerAircraft; i++) {
            const m = new THREE.Mesh(eddyGeo, new THREE.MeshBasicMaterial({
                map: eddyTex,
                color: 0xdce6f0,
                transparent: true,
                opacity: 0,
                blending: THREE.NormalBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: true
            }));
            m.visible = false;
            m.frustumCulled = false;
            m.renderOrder = 4;
            m.name = 'stallWingEddy_' + id + '_' + i;
            scene.add(m);
            eddies.push(m);
        }

        for (let i = 0; i < c.smokePerAircraft; i++) {
            const m = new THREE.Mesh(eddyGeo, new THREE.MeshBasicMaterial({
                map: smokeTex,
                color: 0xffffff,
                transparent: true,
                opacity: 0,
                blending: THREE.NormalBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: true
            }));
            m.visible = false;
            m.frustumCulled = false;
            m.renderOrder = 4;
            m.name = 'stallEngineSmoke_' + id + '_' + i;
            scene.add(m);
            smokes.push(m);
        }

        fxByTeam[id] = { eddies, smokes };
        return fxByTeam[id];
    }

    function hideTeamPool(id) {
        const pool = fxByTeam[id];
        if (!pool) return;
        for (let i = 0; i < pool.eddies.length; i++) pool.eddies[i].visible = false;
        for (let i = 0; i < pool.smokes.length; i++) pool.smokes[i].visible = false;
    }

    function resetModelPivot(team) {
        const pivot = team && team.wrapper && team.wrapper.userData && team.wrapper.userData.modelPivot;
        if (!pivot) return;
        pivot.rotation.set(0, 0, 0);
        pivot.position.set(0, 0, 0);
    }

    function hideAll() {
        Object.keys(fxByTeam).forEach(hideTeamPool);
        if (typeof teams !== 'undefined' && teams) {
            Object.keys(teams).forEach((id) => {
                resetModelPivot(teams[id]);
                seatStallState[id] = 0;
            });
        }
    }

    function activeIds() {
        if (typeof GameContext !== 'undefined' && GameContext.getActiveMatchIds) {
            return GameContext.getActiveMatchIds();
        }
        return ['red', 'blue'];
    }

    function orientBillboard(mesh, zRot) {
        if (typeof camera === 'undefined' || !camera) return;
        mesh.quaternion.copy(camera.quaternion);
        if (zRot) {
            _qZ.setFromAxisAngle(_axisZ, zRot);
            mesh.quaternion.multiply(_qZ);
        }
    }

    /**
     * Per-frame update for all active aircraft:
     *  - Evaluates stall intensity (deterministic from battleLog during flight/replay, live in planning)
     *  - Applies visual-only airframe buffet & wing-rock to `modelPivot`
     *  - Renders separated upper-wing turbulent eddies & compressor-stall exhaust smoke puffs
     */
    function updateStallVfx() {
        const c = getCfg();
        if (!c.enabled || typeof teams === 'undefined') {
            hideAll();
            return;
        }

        const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const uNow = currentTimelineCursor();
        const isFlight = uNow !== null;
        const isReplay = !!(typeof window !== 'undefined' && window.replayMode);
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && Number(CONFIG.rules.stepsPerTurn)) || 100;
        const isAliveAtCursor = (id) => {
            if (uNow == null || typeof battleLog === 'undefined' || !Array.isArray(battleLog) || !battleLog.length) return true;
            const tIdx = Math.min(battleLog.length - 1, Math.max(0, Math.floor(uNow)));
            const frac = Math.max(0, Math.min(1, uNow - tIdx));
            const sIdx = Math.min(stepsPerTurn, Math.floor(frac * stepsPerTurn));
            const log = battleLog[tIdx];
            if (!log || !log[id] || !Array.isArray(log[id].pts) || log[id].pts.length < 2) return false;
            if (log.hpTrack && Array.isArray(log.hpTrack[id]) && log.hpTrack[id].length > 0) {
                const hp = Number(log.hpTrack[id][Math.min(log.hpTrack[id].length - 1, sIdx)]);
                if (Number.isFinite(hp) && hp <= 0) return false;
            }
            return true;
        };
        const ids = activeIds();

        // Upper-wing turbulent separation spawn stations (left/right inner & mid wing + tailplane)
        const stations = [
            [-0.18, 0.06,  0.04], [ 0.18, 0.06,  0.04],
            [-0.29, 0.05, -0.06], [ 0.29, 0.05, -0.06],
            [-0.37, 0.04, -0.14], [ 0.37, 0.04, -0.14],
            [-0.14, 0.07, -0.34], [ 0.14, 0.07, -0.34]
        ];

        for (let ii = 0; ii < ids.length; ii++) {
            const id = ids[ii];
            const team = teams[id];
            const aliveNow = isReplay ? isAliveAtCursor(id) : !(team && team.isDestroyed);
            if (!team || !team.wrapper || !aliveNow || team.matchActive === false || !team.wrapper.visible) {
                hideTeamPool(id);
                resetModelPivot(team);
                seatStallState[id] = 0;
                continue;
            }

            const info = sampleStallAtU(id, uNow);
            const sf = info.stallFactor;
            seatStallState[id] = sf;

            if (sf <= 0.04) {
                hideTeamPool(id);
                resetModelPivot(team);
                continue;
            }

            // Use deterministic phase during replay/combat (scrub-safe), wall-clock in idle planning
            const phaseSec = isFlight ? (uNow * 1.55) : (nowMs * 0.001);
            const seedOff = (ii + 1) * 1.93;

            // 1) Visual-only airframe buffet shudder & post-stall wing rock on `modelPivot`
            const pivot = team.wrapper.userData && team.wrapper.userData.modelPivot;
            if (pivot) {
                // During planning idle, keep buffet gentler (35%) so the jet trembles warningly without distracting aiming
                const buffetScale = isFlight ? 1.0 : 0.35;
                const off = computeBuffetOffsets(sf * buffetScale, phaseSec, seedOff);
                pivot.rotation.set(off.rotX, off.rotY, off.rotZ);
                pivot.position.set(off.posX, off.posY, off.posZ);
            }

            // 2) Separated turbulent upper-wing airflow eddies & compressor-stall smoke puffs
            // Only render world-space turbulent shed eddies during combat flight / ACMI replay
            if (!isFlight) {
                hideTeamPool(id);
                continue;
            }

            const pool = ensureTeamPool(id);
            if (!pool) continue;

            const wPos = team.wrapper.position;
            const wQuat = team.wrapper.quaternion;
            _vFwd.set(0, 0, 1).applyQuaternion(wQuat).normalize();
            _vUp.set(0, 1, 0).applyQuaternion(wQuat).normalize();
            _vRight.set(1, 0, 0).applyQuaternion(wQuat).normalize();

            // Estimate true separated relative wind direction (aft + upward over stalled upper wing)
            _vRelWind.copy(_vFwd).multiplyScalar(-0.78).addScaledVector(_vUp, 0.48);
            if (Array.isArray(battleLog) && battleLog.length) {
                const tIdx = Math.min(battleLog.length - 1, Math.max(0, Math.floor(uNow)));
                const frac = Math.max(0, Math.min(1, uNow - tIdx));
                const entry = battleLog[tIdx] && battleLog[tIdx][id];
                if (entry && Array.isArray(entry.pts) && entry.pts.length >= 2) {
                    const pA = samplePosePlain(entry, Math.max(0, frac - 0.04));
                    const pB = samplePosePlain(entry, Math.min(1, frac + 0.04));
                    if (pA && pB) {
                        _vPosA.set(pA.pos.x, pA.pos.y, pA.pos.z);
                        _vPosB.set(pB.pos.x, pB.pos.y, pB.pos.z);
                        _vPosB.sub(_vPosA);
                        const len = _vPosB.length();
                        if (len > 1e-4) {
                            // Opposite of flight velocity = true incoming relative wind; add slight upward separation curl
                            _vRelWind.copy(_vPosB).divideScalar(-len).addScaledVector(_vUp, 0.28).normalize();
                        }
                    }
                }
            } else {
                _vRelWind.normalize();
            }

            // A) Separated upper-wing turbulent eddies (broken swirling wisps detaching off wing upper surfaces)
            const cycleRate = 3.2; // cycles per turn
            const nEddies = pool.eddies.length;
            for (let k = 0; k < nEddies; k++) {
                const m = pool.eddies[k];
                const rawPhase = uNow * cycleRate + (k / nEddies) + hash01(k * 13.7 + ii * 5.3) * 0.25;
                const cycleId = Math.floor(rawPhase);
                const age = rawPhase - cycleId; // 0 (detaching on wing) -> 1 (dissipated eddy)

                const st = stations[(k + cycleId) % stations.length];
                const jitterR = (hash01(cycleId * 17.3 + k * 3.1) - 0.5) * 0.14;
                const jitterU = (hash01(cycleId * 29.1 + k * 7.7) - 0.5) * 0.10;

                _vLocal.set(st[0] + jitterR, st[1], st[2]);
                _vPos.copy(_vLocal).applyQuaternion(wQuat).add(wPos);

                // Drift chaotically along separated relative wind with vortex curl wobble
                const driftDist = age * (1.25 + 0.85 * sf);
                const curlWobble = Math.sin(age * 9.5 + cycleId * 2.1 + k) * 0.16 * age;
                _vPos.addScaledVector(_vRelWind, driftDist);
                _vPos.addScaledVector(_vRight, curlWobble + jitterR * age * 1.4);
                _vPos.addScaledVector(_vUp, (0.14 + jitterU) * age * (1 + 0.5 * sf));

                m.position.copy(_vPos);
                const size = (0.22 + 0.54 * age) * (0.8 + 0.45 * sf);
                m.scale.set(size * 1.25, size * 0.85, 1);
                orientBillboard(m, (cycleId * 1.7 + k * 0.9) + age * (k % 2 === 0 ? 2.4 : -2.4));

                const alpha = smooth01(0.0, 0.14, age) * Math.pow(1 - age, 1.25) * c.eddyOpacity * sf;
                m.material.opacity = alpha;
                m.visible = alpha > 0.02;
            }

            // B) Intermittent dark compressor-stall exhaust cough puffs behind nozzle
            const nSmoke = pool.smokes.length;
            const smokeRate = 2.8;
            for (let k = 0; k < nSmoke; k++) {
                const m = pool.smokes[k];
                const rawPhase = uNow * smokeRate + (k / nSmoke);
                const cycleId = Math.floor(rawPhase);
                const age = rawPhase - cycleId;
                // Only puff intermittently (~72% of cycles) so it reads as irregular engine coughing
                const coughGate = hash01(cycleId * 41.3 + k * 19.7 + ii * 7.1) > 0.28 ? 1.0 : 0.0;
                if (!coughGate) {
                    m.visible = false;
                    continue;
                }

                _vLocal.set(0, -0.08, -0.55);
                _vPos.copy(_vLocal).applyQuaternion(wQuat).add(wPos);
                const drift = age * (1.6 + 0.95 * sf);
                const swirlX = (hash01(cycleId * 11.3 + k) - 0.5) * 0.28 * age;
                _vPos.addScaledVector(_vRelWind, drift);
                _vPos.addScaledVector(_vRight, swirlX);
                _vPos.addScaledVector(_vUp, 0.14 * age);

                m.position.copy(_vPos);
                const sz = (0.24 + 0.62 * age) * (0.75 + 0.45 * sf);
                m.scale.set(sz, sz, 1);
                orientBillboard(m, cycleId * 2.3 + age * 1.8);

                const alpha = smooth01(0.0, 0.10, age) * Math.pow(1 - age, 1.35) * c.smokeOpacity * sf;
                m.material.opacity = alpha;
                m.visible = alpha > 0.02;
            }
        }
    }

    function getExhaustMod(id, throttle, nowMs) {
        const sf = seatStallState[id] || 0;
        const seed = (id === 'red2' ? 2.1 : id === 'blue' ? 4.3 : id === 'blue2' ? 6.7 : 0.8);
        return computeExhaustMod(sf, throttle, nowMs, seed);
    }

    function getSeatStallFactor(id) {
        return seatStallState[id] || 0;
    }

    return {
        getCfg,
        computeStallFactor,
        computeBuffetOffsets,
        computeExhaustMod,
        sampleStallAtU,
        updateStallVfx,
        getExhaustMod,
        getSeatStallFactor,
        hideAll
    };
});
