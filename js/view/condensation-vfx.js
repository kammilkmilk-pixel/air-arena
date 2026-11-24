// ============================================================================
// condensation-vfx.js — aft white wake ribbon + short wingtip wake ribbons + LE fog
// Forward planning ribbon keeps team red/cyan; flown wake behind aircraft is white.
// ============================================================================

(function initCondensationVfx(root) {
    const _tmpNose = new THREE.Vector3();
    const _tmpVel = new THREE.Vector3();
    const _tmpWing = new THREE.Vector3();
    const _tmpUp = new THREE.Vector3();
    const _tmpLocal = new THREE.Vector3();
    const _tmpCenter = new THREE.Vector3();
    const _tmpA = new THREE.Vector3();
    const _tmpB = new THREE.Vector3();

    let vaporTex = null;
    let wakeFadeTex = null;
    let whiteRibbonMat = null;
    let fogMat = null;
    let lastNow = 0;

    function cfg() {
        const v = (typeof CONFIG !== 'undefined' && CONFIG.visuals && CONFIG.visuals.condensation)
            ? CONFIG.visuals.condensation
            : {};
        return {
            enabled: v.enabled !== false,
            onlyDuringFlightAnim: v.onlyDuringFlightAnim !== false,
            centerWakeTurns: Math.max(0.2, Math.min(3.0, Number(v.centerWakeTurns) || 1.6)),
            centerWakeWidth: Math.max(0.02, Number(v.centerWakeWidth) || 0.24),
            centerWakeOpacity: Math.max(0.05, Math.min(1, Number(v.centerWakeOpacity) || 0.95)),
            tipWakeTurns: Math.max(0.08, Math.min(2.5, Number(v.tipWakeTurns) || 0.55)),
            tipWakeWidth: Math.max(0.015, Number(v.tipWakeWidth) || 0.13),
            tipWakeOpacity: Math.max(0.05, Math.min(1, Number(v.tipWakeOpacity) || 0.95)),
            tipPullStartRad: Number.isFinite(Number(v.tipPullStartRad)) ? Number(v.tipPullStartRad) : 0.24,
            tipPullFullRad: Number.isFinite(Number(v.tipPullFullRad)) ? Number(v.tipPullFullRad) : 0.58,
            tipClimbStartDeg: Number.isFinite(Number(v.tipClimbStartDeg)) ? Number(v.tipClimbStartDeg) : 22,
            tipClimbFullDeg: Number.isFinite(Number(v.tipClimbFullDeg)) ? Number(v.tipClimbFullDeg) : 42,
            tipRollStartRad: Number.isFinite(Number(v.tipRollStartRad)) ? Number(v.tipRollStartRad) : 0.26,
            tipRollFullRad: Number.isFinite(Number(v.tipRollFullRad)) ? Number(v.tipRollFullRad) : 0.62,
            tipTurnStartRad: Number.isFinite(Number(v.tipTurnStartRad)) ? Number(v.tipTurnStartRad) : 0.34,
            tipTurnFullRad: Number.isFinite(Number(v.tipTurnFullRad)) ? Number(v.tipTurnFullRad) : 0.65,
            vortexPts: Math.max(24, Math.min(180, Number(v.vortexPts) || 96)),
            trailPersistMs: Math.max(800, Number(v.trailPersistMs) || 2800),
            aoaFogStart: Number(v.aoaFogStart) || 0.55,
            aoaFogFull: Number(v.aoaFogFull) || 1.8,
            leFogMaxOpacity: Number(v.leFogMaxOpacity) || 0.72,
            leFogScale: Number(v.leFogScale) || 0.28
        };
    }

    function isFlightAnimActive() {
        if (typeof GameContext !== 'undefined') {
            if (GameContext.isAnimating && GameContext.isAnimating()) return true;
            if (GameContext.isReplayMode && GameContext.isReplayMode()) return true;
        }
        return !!(typeof window !== 'undefined' && window.replayMode);
    }

    function aircraftVisuals(team) {
        const type = (team && team.type) || 'mig21';
        const ac = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts && CONFIG.aircrafts[type])
            ? CONFIG.aircrafts[type]
            : null;
        const vis = (ac && ac.visuals) || {};
        return {
            engineOffsetY: Number.isFinite(Number(vis.engineOffsetY)) ? Number(vis.engineOffsetY) : -0.08,
            tailOffsetZ: Number.isFinite(Number(vis.tailOffsetZ)) ? Number(vis.tailOffsetZ) : -0.45,
            wingTipL: Array.isArray(vis.wingTipL) ? vis.wingTipL : [-0.38, -0.08, -0.15],
            wingTipR: Array.isArray(vis.wingTipR) ? vis.wingTipR : [0.38, -0.08, -0.15],
            wingLeL: Array.isArray(vis.wingLeL) ? vis.wingLeL : [[-0.14, 0.02, 0.16], [-0.26, 0.015, 0.12], [-0.36, 0.01, 0.06]],
            wingLeR: Array.isArray(vis.wingLeR) ? vis.wingLeR : [[0.14, 0.02, 0.16], [0.26, 0.015, 0.12], [0.36, 0.01, 0.06]]
        };
    }

    function ensureSharedMats() {
        if (!vaporTex) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
            g.addColorStop(0.35, 'rgba(230,240,255,0.55)');
            g.addColorStop(0.7, 'rgba(200,220,240,0.18)');
            g.addColorStop(1.0, 'rgba(180,200,220,0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, 64, 64);
            vaporTex = new THREE.CanvasTexture(canvas);
            vaporTex.needsUpdate = true;
        }
        if (!wakeFadeTex) {
            // 1D vertical white → transparent alpha gradient (Three r128 safe; UV.y = age 0..1).
            const c2 = document.createElement('canvas');
            c2.width = 32;
            c2.height = 128;
            const gctx = c2.getContext('2d');
            // Crisp light-ribbon cross-section (solid bright white core + cool vapor edge so it
            // reads clearly over both dark terrain and bright white buildings) × smooth tail fade.
            const img = gctx.createImageData(32, 128);
            const data = img.data;
            for (let y = 0; y < 128; y++) {
                const v = y / 127; // 0 = emitter head, 1 = tail end
                // Hold strong brightness near aircraft, then taper cleanly to transparent tail
                const fadeT = Math.max(0, (v - 0.22) / 0.78);
                const tailAlpha = Math.pow(1 - fadeT, 1.35);
                for (let x = 0; x < 32; x++) {
                    const u = Math.abs((x / 31) * 2 - 1); // 0 center .. 1 outer edge
                    // Keep 82% of ribbon width full-solid like drawTrajectoryLine, soften only outermost 18%
                    const edge = u < 0.82 ? 1.0 : Math.max(0, 1 - (u - 0.82) / 0.18);
                    const a = Math.round(255 * tailAlpha * edge);
                    // Pure white core (u < 0.65) with cool ice-blue vapor rim (u >= 0.65) for contrast on white roofs
                    const rim = u < 0.65 ? 0 : (u - 0.65) / 0.35;
                    const p = (y * 32 + x) * 4;
                    data[p] = Math.round(255 - rim * 95);
                    data[p + 1] = Math.round(255 - rim * 55);
                    data[p + 2] = 255;
                    data[p + 3] = a;
                }
            }
            gctx.putImageData(img, 0, 0);
            wakeFadeTex = new THREE.CanvasTexture(c2);
            wakeFadeTex.wrapS = THREE.ClampToEdgeWrapping;
            wakeFadeTex.wrapT = THREE.ClampToEdgeWrapping;
            wakeFadeTex.needsUpdate = true;
        }
        if (!whiteRibbonMat) {
            whiteRibbonMat = new THREE.MeshBasicMaterial({
                map: wakeFadeTex,
                color: 0xffffff,
                transparent: true,
                opacity: 0.95,
                blending: THREE.NormalBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: false
            });
        }
        if (!fogMat) {
            fogMat = new THREE.MeshBasicMaterial({
                map: vaporTex,
                color: 0xe8f2ff,
                transparent: true,
                opacity: 0,
                blending: THREE.NormalBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: true
            });
        }
    }

    function makeWakeRibbon(maxPts, name) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 3), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 2), 2));
        const indices = [];
        for (let i = 0; i < maxPts - 1; i++) {
            indices.push(i * 2, i * 2 + 1, i * 2 + 2);
            indices.push(i * 2 + 2, i * 2 + 1, i * 2 + 3);
        }
        geo.setIndex(indices);
        geo.setDrawRange(0, 0);
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
        const mesh = new THREE.Mesh(geo, whiteRibbonMat.clone());
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;
        mesh.visible = false;
        mesh.name = name || 'condensationWakeRibbon';
        return mesh;
    }

    function makeFogSprite(scale) {
        const geo = new THREE.PlaneGeometry(1, 1);
        const mesh = new THREE.Mesh(geo, fogMat.clone());
        mesh.scale.setScalar(scale);
        mesh.renderOrder = 4;
        mesh.visible = false;
        mesh.name = 'condensationLeFog';
        return mesh;
    }

    function disposeMeshes(list) {
        (list || []).forEach((m) => {
            if (!m) return;
            if (m.parent) m.parent.remove(m);
            else if (typeof scene !== 'undefined' && scene) scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
        });
    }

    function ensureFx(team) {
        if (!team || !team.wrapper) return null;
        if (typeof scene === 'undefined' || !scene) return null;
        ensureSharedMats();
        const c = cfg();
        const vis = aircraftVisuals(team);
        let fx = team.wrapper.userData.condensation;

        if (fx && (fx.capPts !== c.vortexPts || !fx.center)) {
            disposeMeshes([fx.center, fx.left, fx.right]);
            fx.center = makeWakeRibbon(c.vortexPts, 'condensationCenterWake');
            fx.left = makeWakeRibbon(c.vortexPts, 'condensationTipWakeL');
            fx.right = makeWakeRibbon(c.vortexPts, 'condensationTipWakeR');
            scene.add(fx.center, fx.left, fx.right);
            fx.capPts = c.vortexPts;
        }

        if (fx) return fx;

        const center = makeWakeRibbon(c.vortexPts, 'condensationCenterWake');
        const left = makeWakeRibbon(c.vortexPts, 'condensationTipWakeL');
        const right = makeWakeRibbon(c.vortexPts, 'condensationTipWakeR');
        scene.add(center, left, right);

        const fogGroup = new THREE.Group();
        fogGroup.name = 'condensationLeFogGroup';
        fogGroup.userData.isCondensationVfx = true;
        const fogSprites = [];
        const places = [].concat(vis.wingLeL || [], vis.wingLeR || []);
        places.forEach((p, i) => {
            const spr = makeFogSprite(c.leFogScale * (0.85 + (i % 3) * 0.12));
            spr.position.set(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
            spr.userData.isCondensationVfx = true;
            fogGroup.add(spr);
            fogSprites.push(spr);
        });
        team.wrapper.add(fogGroup);

        fx = {
            center,
            left,
            right,
            fogGroup,
            fogSprites,
            capPts: c.vortexPts,
            prevPos: null,
            prevQuat: null,
            prevVel: null,
            wasFlight: false,
            aoa: 0
        };
        team.wrapper.userData.condensation = fx;
        return fx;
    }

    function hideFog(fx) {
        if (!fx || !fx.fogSprites) return;
        fx.fogSprites.forEach((s) => {
            s.visible = false;
            if (s.material) s.material.opacity = 0;
        });
    }

    function hideAllMeshes(fx) {
        if (!fx) return;
        if (fx.center) fx.center.visible = false;
        if (fx.left) fx.left.visible = false;
        if (fx.right) fx.right.visible = false;
        hideFog(fx);
    }

    /**
     * Resolve continuous timeline cursor `u` in turn units:
     *   Turn 1 start = 0.0, Turn 1 end = 1.0, Turn 2 mid = 1.5, etc.
     */
    function currentTimelineCursor() {
        if (typeof battleLog === 'undefined' || !Array.isArray(battleLog) || battleLog.length === 0) {
            return null;
        }
        if (typeof GameContext !== 'undefined' && GameContext.isReplayMode && GameContext.isReplayMode()) {
            const val = Number(GameContext.state && GameContext.state.virtualReplayTime) || 1.0;
            const maxU = battleLog.length;
            // virtualReplayTime: 1.0 = start of battleLog[0], 1.99 = end of battleLog[0]
            return Math.max(0, Math.min(maxU, val - 1.0));
        }
        if (typeof GameContext !== 'undefined' && GameContext.isAnimating && GameContext.isAnimating()) {
            const prog = Math.max(0, Math.min(1, Number(GameContext.state && GameContext.state.animProgress) || 0));
            return (battleLog.length - 1) + prog;
        }
        // Planning between turns (Turn 2+): aircraft sits at end of last resolved turn.
        return battleLog.length;
    }

    /** Sample historical pose for `id` at timeline cursor `u` in [0, battleLog.length]. */
    function samplePoseAtU(id, u, outPos, outQuat) {
        if (u < 0 || !Array.isArray(battleLog) || !battleLog.length) return false;
        let tIdx = Math.floor(u);
        let frac = u - tIdx;
        if (tIdx >= battleLog.length) {
            tIdx = battleLog.length - 1;
            frac = 1.0;
        }
        const entry = battleLog[tIdx] && battleLog[tIdx][id];
        if (!entry || !entry.pts || entry.pts.length < 2 || !entry.quats || entry.quats.length < 2) {
            return false;
        }
        const p = (typeof getPosAt === 'function')
            ? getPosAt(frac, entry.pts)
            : entry.pts[Math.min(entry.pts.length - 1, Math.floor(frac * (entry.pts.length - 1)))];
        const q = (typeof getQuatAt === 'function')
            ? getQuatAt(frac, entry.quats)
            : entry.quats[Math.min(entry.quats.length - 1, Math.floor(frac * (entry.quats.length - 1)))];
        outPos.copy(p);
        outQuat.copy(q);
        return true;
    }

    const _samplePos = new THREE.Vector3();
    const _sampleQuat = new THREE.Quaternion();
    const _samplePosA = new THREE.Vector3();
    const _sampleQuatA = new THREE.Quaternion();
    const _samplePosB = new THREE.Vector3();
    const _sampleQuatB = new THREE.Quaternion();
    const _noseA = new THREE.Vector3();
    const _noseB = new THREE.Vector3();
    const _upA = new THREE.Vector3();
    const _wingA = new THREE.Vector3();
    const _wingB = new THREE.Vector3();
    const _prevCenter = new THREE.Vector3();
    const _tangent = new THREE.Vector3();
    const _toCam = new THREE.Vector3();
    const _camSide = new THREE.Vector3();

    function smooth01(e0, e1, x) {
        const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-4, e1 - e0)));
        return t * t * (3 - 2 * t);
    }

    /**
     * Evaluate aft center white wake intensity in [0, 1].
     * Smooth laminar contrail/wake requires attached forward airflow; during aerodynamic
     * stall or collapsed forward airspeed it breaks up and fades away.
     */
    function centerWakeIntensity(metrics) {
        const m = metrics || {};
        const stallFactor = Math.max(0, Math.min(1, Number(m.stallFactor) || 0));
        const stallGate = 1 - smooth01(0.18, 0.62, stallFactor);
        if (stallGate <= 1e-4) return 0;
        const fwdSpeed = Number.isFinite(Number(m.forwardSpeed))
            ? Number(m.forwardSpeed)
            : (Number.isFinite(Number(m.speed)) ? Number(m.speed) : 5.0);
        // Calibrated to real physics.js per-turn flight distances (ECO≈2.5–3.2, MIL≈3.7–8.2, AB≈11–18 u/turn).
        const speedGate = smooth01(1.1, 3.0, fwdSpeed);
        return Math.max(0, Math.min(1, stallGate * speedGate));
    }

    /**
     * Evaluate wingtip condensation intensity in [0, 1] from aerodynamic maneuver metrics.
     * Triggers on:
     *   - Positive-G pull-ups (high pitch-up rate)
     *   - Steep climb attitude (while maintaining climb, not hard push-over)
     *   - Rolling maneuvers (high roll rate around nose axis)
     *   - Hard banked turns (high turn rate combined with bank angle)
     * Suppressed during straight/level cruise, gentle maneuvers, or aerodynamic stall/low forward airspeed.
     */
    function tipCondensationIntensity(metrics, c) {
        const m = metrics || {};
        const k = c || cfg();
        const stallFactor = Math.max(0, Math.min(1, Number(m.stallFactor) || 0));
        const stallGate = 1 - smooth01(0.15, 0.52, stallFactor);
        if (stallGate <= 1e-4) return 0;

        const fwdSpeed = Number.isFinite(Number(m.forwardSpeed))
            ? Number(m.forwardSpeed)
            : Number(m.speed);
        const speedFactor = Number.isFinite(fwdSpeed) ? smooth01(1.8, 4.2, fwdSpeed) : 1.0;
        if (speedFactor <= 1e-4) return 0;

        const pullRate = Number(m.pullRate) || 0;      // rad/turn (+ = pull-up, - = push-over)
        const rollRate = Math.abs(Number(m.rollRate) || 0); // rad/turn
        const turnRate = Math.abs(Number(m.turnRate) || 0); // rad/turn
        const climbDeg = Number(m.climbDeg) || 0;      // deg (+ = nose above horizon)
        const bankDeg = Math.abs(Number(m.bankDeg) || 0);   // deg

        const pullScore = smooth01(k.tipPullStartRad, k.tipPullFullRad, pullRate);
        const climbGate = pullRate > -0.25 ? 1.0 : 0.35;
        const climbScore = smooth01(k.tipClimbStartDeg, k.tipClimbFullDeg, climbDeg) * climbGate;
        const rollScore = smooth01(k.tipRollStartRad, k.tipRollFullRad, rollRate);
        const bankTurnScore = smooth01(k.tipTurnStartRad, k.tipTurnFullRad, turnRate)
            * smooth01(15, 32, bankDeg);

        return Math.max(0, Math.min(1, Math.max(pullScore, climbScore, rollScore, bankTurnScore) * speedFactor * stallGate));
    }

    function sampleCenterIntensityAtU(id, u) {
        if (!Array.isArray(battleLog) || !battleLog.length) return 1.0;
        const stallApi = (typeof window !== 'undefined' && window.AirArenaStallVfx) ? window.AirArenaStallVfx : null;
        if (stallApi && typeof stallApi.sampleStallAtU === 'function') {
            const st = stallApi.sampleStallAtU(id, u);
            return centerWakeIntensity({ stallFactor: st.stallFactor, forwardSpeed: st.forwardSpeed });
        }
        return 1.0;
    }

    /** Sample local aerodynamic maneuver intensity at timeline cursor `u` from battleLog poses. */
    function sampleTipIntensityAtU(id, u, c) {
        if (!Array.isArray(battleLog) || !battleLog.length) return 0;
        const maxU = battleLog.length;
        const halfDu = 0.025;
        const u0 = Math.max(0, u - halfDu);
        const u1 = Math.min(maxU, u + halfDu);
        const du = u1 - u0;
        if (du < 1e-4) return 0;
        if (!samplePoseAtU(id, u0, _samplePosA, _sampleQuatA)) return 0;
        if (!samplePoseAtU(id, u1, _samplePosB, _sampleQuatB)) return 0;

        _noseA.set(0, 0, 1).applyQuaternion(_sampleQuatA).normalize();
        _noseB.set(0, 0, 1).applyQuaternion(_sampleQuatB).normalize();
        _upA.set(0, 1, 0).applyQuaternion(_sampleQuatA).normalize();
        _wingA.set(1, 0, 0).applyQuaternion(_sampleQuatA).normalize();
        _wingB.set(1, 0, 0).applyQuaternion(_sampleQuatB).normalize();

        const pullRate = Math.atan2(_noseB.dot(_upA), Math.max(1e-4, _noseB.dot(_noseA))) / du;
        const rollRate = Math.abs(Math.atan2(_wingB.dot(_upA), Math.max(1e-4, _wingB.dot(_wingA)))) / du;
        const turnRate = Math.abs(Math.atan2(_noseB.dot(_wingA), Math.max(1e-4, _noseB.dot(_noseA)))) / du;
        const climbDeg = Math.asin(Math.max(-1, Math.min(1, _noseB.y))) * (180 / Math.PI);
        const bankDeg = Math.abs(Math.asin(Math.max(-1, Math.min(1, _wingB.y)))) * (180 / Math.PI);
        _tmpVel.subVectors(_samplePosB, _samplePosA).divideScalar(du);
        const speed = _tmpVel.length();
        const forwardSpeed = _tmpVel.dot(_noseB);

        let stallFactor = 0;
        const stallApi = (typeof window !== 'undefined' && window.AirArenaStallVfx) ? window.AirArenaStallVfx : null;
        if (stallApi && typeof stallApi.sampleStallAtU === 'function') {
            stallFactor = stallApi.sampleStallAtU(id, u).stallFactor;
        }

        return tipCondensationIntensity({ pullRate, rollRate, turnRate, climbDeg, bankDeg, speed, forwardSpeed, stallFactor }, c);
    }

    /**
     * Build a white vapor ribbon from `uNow` backward over `spanTurns`,
     * emitted at `localOffset` ([x, y, z] in wrapper-local coordinates).
     * Uses billboard-assisted width so ribbons stay visible from top-down AND edge-on bank angles.
     * Optional `intensityFn(u)` modulates per-segment visibility/width for maneuver-gated wingtip trails.
     */
    function buildHistoryRibbon(mesh, id, uNow, spanTurns, maxPts, localOffset, halfWidth, baseOpacity, fadePow, intensityFn) {
        if (!mesh || uNow <= 0.005 || spanTurns <= 0.01) {
            if (mesh) mesh.visible = false;
            return;
        }
        const uStart = Math.max(0, uNow - spanTurns);
        const actualSpan = uNow - uStart;
        if (actualSpan <= 0.005) {
            mesh.visible = false;
            return;
        }

        const segs = Math.max(8, Math.min(maxPts - 1, Math.round((actualSpan / Math.max(0.25, spanTurns)) * (maxPts - 1))));
        const posArr = mesh.geometry.attributes.position.array;
        const uvArr = mesh.geometry.attributes.uv.array;
        const cam = (typeof camera !== 'undefined') ? camera : null;
        let valid = 0;
        let maxIntensity = 0;

        for (let i = 0; i <= segs; i++) {
            const frac = i / segs; // 0 at aircraft (newest) → 1 at oldest tail end
            const u = uNow - frac * actualSpan;
            if (!samplePoseAtU(id, u, _samplePos, _sampleQuat)) break;

            const age = Math.min(1, Math.max(0, (uNow - u) / spanTurns));
            const intensity = intensityFn ? Math.max(0, Math.min(1, intensityFn(u))) : 1.0;
            if (intensity > maxIntensity) maxIntensity = intensity;

            _tmpLocal.set(Number(localOffset[0]) || 0, Number(localOffset[1]) || 0, Number(localOffset[2]) || 0);
            _tmpCenter.copy(_tmpLocal).applyQuaternion(_sampleQuat).add(_samplePos);

            // Wing-horizontal basis blended with camera-facing perpendicular so steep banks never collapse to 0px.
            _tmpWing.set(1, 0, 0).applyQuaternion(_sampleQuat).normalize();
            if (cam) {
                if (i === 0) {
                    _tangent.set(0, 0, 1).applyQuaternion(_sampleQuat).normalize();
                } else {
                    _tangent.subVectors(_prevCenter, _tmpCenter);
                    if (_tangent.lengthSq() < 1e-8) _tangent.set(0, 0, 1).applyQuaternion(_sampleQuat);
                    _tangent.normalize();
                }
                _toCam.subVectors(cam.position, _tmpCenter).normalize();
                _camSide.crossVectors(_tangent, _toCam);
                if (_camSide.lengthSq() > 1e-6) {
                    _camSide.normalize();
                    if (_camSide.dot(_tmpWing) < 0) _camSide.negate();
                    _tmpWing.lerp(_camSide, 0.65).normalize();
                }
            }
            _prevCenter.copy(_tmpCenter);
            const widthScale = intensityFn ? (0.65 + 0.35 * intensity) : 1.0;
            const w = halfWidth * widthScale * (1.0 + age * 0.35);
            _tmpWing.multiplyScalar(w);

            const idx = valid * 2;
            posArr[idx * 3 + 0] = _tmpCenter.x + _tmpWing.x;
            posArr[idx * 3 + 1] = _tmpCenter.y + _tmpWing.y;
            posArr[idx * 3 + 2] = _tmpCenter.z + _tmpWing.z;
            posArr[idx * 3 + 3] = _tmpCenter.x - _tmpWing.x;
            posArr[idx * 3 + 4] = _tmpCenter.y - _tmpWing.y;
            posArr[idx * 3 + 5] = _tmpCenter.z - _tmpWing.z;

            // CanvasTexture flipY=true in Three r128: UV v=1 samples canvas top (y=0, full alpha), v=0 samples bottom (y=127, transparent).
            // Modulating vCoord by maneuver intensity fades wingtip trails in/out smoothly without RGBA vertex colors.
            const vCoord = Math.pow(1 - age, fadePow) * intensity;
            uvArr[idx * 2 + 0] = 0;
            uvArr[idx * 2 + 1] = vCoord;
            uvArr[idx * 2 + 2] = 1;
            uvArr[idx * 2 + 3] = vCoord;
            valid++;
        }

        if (valid > 1 && maxIntensity > 0.03) {
            mesh.geometry.setDrawRange(0, (valid - 1) * 6);
            mesh.geometry.attributes.position.needsUpdate = true;
            mesh.geometry.attributes.uv.needsUpdate = true;
            if (mesh.material) mesh.material.opacity = baseOpacity;
            mesh.visible = true;
        } else {
            mesh.visible = false;
        }
    }

    function estimateFlightLoad(wrapper, fx, dtSec) {
        let speed = 0;
        if (fx.prevPos && dtSec > 1e-4) {
            _tmpVel.subVectors(wrapper.position, fx.prevPos).divideScalar(dtSec);
            speed = _tmpVel.length();
        }
        let pitchRate = 0;
        if (fx.prevQuat && dtSec > 1e-4) {
            _tmpNose.set(0, 0, 1).applyQuaternion(wrapper.quaternion);
            _tmpUp.set(0, 1, 0).applyQuaternion(wrapper.quaternion);
            _tmpA.set(0, 0, 1).applyQuaternion(fx.prevQuat);
            _tmpB.copy(_tmpNose).sub(_tmpA);
            pitchRate = Math.abs(_tmpB.dot(_tmpUp) / Math.max(dtSec, 1e-3));
        }
        let pathAoa = 0;
        if (fx.prevVel && speed > 0.08 && fx.prevVel.lengthSq() > 1e-4) {
            _tmpA.copy(fx.prevVel).normalize();
            _tmpB.copy(_tmpVel).normalize();
            const dot = Math.max(-1, Math.min(1, _tmpA.dot(_tmpB)));
            pathAoa = Math.acos(dot) / Math.max(dtSec, 1e-3) * 0.35;
        }
        return { aoa: Math.max(pitchRate, pathAoa), speed };
    }

    const _invWrapperQ = (typeof THREE !== 'undefined' && THREE.Quaternion) ? new THREE.Quaternion() : null;

    function updateLeFog(fx, aoa, c, now, wrapper) {
        const span = Math.max(1e-3, c.aoaFogFull - c.aoaFogStart);
        let t = (aoa - c.aoaFogStart) / span;
        t = Math.max(0, Math.min(1, t));
        t = t * t * (3 - 2 * t);
        const pulse = 0.92 + 0.08 * Math.sin(now * 0.009);
        const opacity = t * c.leFogMaxOpacity * pulse;
        const camQ = (typeof camera !== 'undefined' && camera) ? camera.quaternion : null;
        if (camQ && wrapper && wrapper.quaternion && _invWrapperQ) {
            _invWrapperQ.copy(wrapper.quaternion).invert().multiply(camQ);
        }

        fx.fogSprites.forEach((spr, i) => {
            if (opacity < 0.02) {
                spr.visible = false;
                if (spr.material) spr.material.opacity = 0;
                return;
            }
            spr.visible = true;
            if (spr.material) {
                spr.material.opacity = opacity * (0.75 + 0.25 * Math.sin(now * 0.011 + i));
            }
            const grow = c.leFogScale * (0.7 + 0.55 * t) * (0.9 + 0.15 * ((i % 3) / 2));
            spr.scale.setScalar(grow);
            if (camQ) {
                if (wrapper && wrapper.quaternion && _invWrapperQ) {
                    spr.quaternion.copy(_invWrapperQ);
                } else {
                    spr.quaternion.copy(camQ);
                }
            }
        });
    }

    function isAliveAtCursor(id, uNow) {
        if (uNow == null || typeof battleLog === 'undefined' || !Array.isArray(battleLog) || !battleLog.length) {
            return true;
        }
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && Number(CONFIG.rules.stepsPerTurn)) || 100;
        const turnIdx = Math.min(battleLog.length - 1, Math.max(0, Math.floor(uNow)));
        const frac = Math.max(0, Math.min(1, uNow - turnIdx));
        const stepIdx = Math.min(stepsPerTurn, Math.floor(frac * stepsPerTurn));
        const log = battleLog[turnIdx];
        if (!log || !log[id] || !Array.isArray(log[id].pts) || log[id].pts.length < 2) return false;
        if (log.hpTrack && Array.isArray(log.hpTrack[id]) && log.hpTrack[id].length > 0) {
            const hp = Number(log.hpTrack[id][Math.min(log.hpTrack[id].length - 1, stepIdx)]);
            if (Number.isFinite(hp) && hp <= 0) return false;
        }
        return true;
    }

    function activeIds() {
        if (typeof GameContext !== 'undefined' && GameContext.getActiveMatchIds) {
            return GameContext.getActiveMatchIds();
        }
        return ['red', 'blue'];
    }

    function updateCondensationVfx() {
        const c = cfg();
        if (!c.enabled || typeof teams === 'undefined') return;

        const now = performance.now();
        const dtSec = lastNow ? Math.min(0.05, Math.max(0.008, (now - lastNow) / 1000)) : 0.016;
        lastNow = now;

        const uNow = currentTimelineCursor();
        const inFlightAnim = isFlightAnimActive();
        const isReplay = !!(typeof window !== 'undefined' && window.replayMode);
        const splitView = !!(typeof window !== 'undefined' && window.AirArenaMultiView && window.AirArenaMultiView.isSplit && window.AirArenaMultiView.isSplit());

        ensureSharedMats();
        const ids = activeIds();
        ids.forEach((id) => {
            const team = teams[id];
            const aliveNow = isReplay ? isAliveAtCursor(id, uNow) : !(team && team.isDestroyed);
            if (!team || !team.wrapper || !aliveNow || team.matchActive === false || !team.wrapper.visible) {
                if (team && team.wrapper && team.wrapper.userData.condensation) {
                    hideAllMeshes(team.wrapper.userData.condensation);
                }
                return;
            }

            const fx = ensureFx(team);
            if (!fx) return;
            const vis = aircraftVisuals(team);

            // 1) White wake ribbons behind the aircraft (from battleLog history — never on planning ghost).
            if (uNow == null || uNow <= 0.005 || splitView) {
                if (fx.center) fx.center.visible = false;
                if (fx.left) fx.left.visible = false;
                if (fx.right) fx.right.visible = false;
            } else {
                const centerEmitter = [0, vis.engineOffsetY, 0];
                const centerIntensityFn = (u) => sampleCenterIntensityAtU(id, u);
                const tipIntensityFn = (u) => sampleTipIntensityAtU(id, u, c);
                buildHistoryRibbon(
                    fx.center, id, uNow,
                    c.centerWakeTurns, c.vortexPts,
                    centerEmitter, c.centerWakeWidth * 0.5, c.centerWakeOpacity, 1.15, centerIntensityFn
                );
                buildHistoryRibbon(
                    fx.left, id, uNow,
                    c.tipWakeTurns, c.vortexPts,
                    vis.wingTipL, c.tipWakeWidth * 0.5, c.tipWakeOpacity, 0.95, tipIntensityFn
                );
                buildHistoryRibbon(
                    fx.right, id, uNow,
                    c.tipWakeTurns, c.vortexPts,
                    vis.wingTipR, c.tipWakeWidth * 0.5, c.tipWakeOpacity, 0.95, tipIntensityFn
                );
            }

            // 2) High-AoA leading-edge fog — ONLY during high-speed combat animation / replay (suppressed in stall).
            if (!inFlightAnim && c.onlyDuringFlightAnim) {
                hideFog(fx);
                fx.wasFlight = false;
                fx.prevVel = null;
                return;
            }

            if (!fx.wasFlight) {
                fx.prevPos = team.wrapper.position.clone();
                fx.prevQuat = team.wrapper.quaternion.clone();
                fx.prevVel = null;
                fx.wasFlight = true;
                hideFog(fx);
                return;
            }

            const { aoa, speed } = estimateFlightLoad(team.wrapper, fx, dtSec);
            const stallApiNow = (typeof window !== 'undefined' && window.AirArenaStallVfx) ? window.AirArenaStallVfx : null;
            const stallNow = (stallApiNow && typeof stallApiNow.sampleStallAtU === 'function')
                ? stallApiNow.sampleStallAtU(id, uNow)
                : { stallFactor: team.stalled ? 1 : 0, forwardSpeed: speed };
            const fogGate = (1 - smooth01(0.18, 0.45, stallNow.stallFactor)) * smooth01(4.5, 9.5, stallNow.forwardSpeed);
            fx.aoa = aoa;
            updateLeFog(fx, (speed > 0.03 && fogGate > 0.05) ? aoa * fogGate : 0, c, now, team.wrapper);

            if (!fx.prevPos) fx.prevPos = team.wrapper.position.clone();
            else fx.prevPos.copy(team.wrapper.position);
            if (!fx.prevQuat) fx.prevQuat = team.wrapper.quaternion.clone();
            else fx.prevQuat.copy(team.wrapper.quaternion);
            if (!fx.prevVel) fx.prevVel = _tmpVel.clone();
            else fx.prevVel.copy(_tmpVel);
        });
    }

    function disposeTeamCondensation(team) {
        if (!team || !team.wrapper || !team.wrapper.userData.condensation) return;
        const fx = team.wrapper.userData.condensation;
        disposeMeshes([fx.center, fx.left, fx.right]);
        if (fx.fogGroup && fx.fogGroup.parent) fx.fogGroup.parent.remove(fx.fogGroup);
        fx.fogSprites.forEach((s) => {
            if (s.geometry) s.geometry.dispose();
            if (s.material) s.material.dispose();
        });
        delete team.wrapper.userData.condensation;
    }

    root.updateCondensationVfx = updateCondensationVfx;
    root.disposeTeamCondensation = disposeTeamCondensation;
    root.AirArenaCondensation = {
        estimateAoaFromNoseVel(noseDotVel) {
            const d = Math.max(-1, Math.min(1, Number(noseDotVel) || 0));
            return Math.acos(d);
        },
        fogAmount(aoa, start, full) {
            const s = Number(start) || 0.55;
            const f = Number(full) || 1.8;
            let t = (Number(aoa) - s) / Math.max(1e-3, f - s);
            t = Math.max(0, Math.min(1, t));
            return t * t * (3 - 2 * t);
        },
        tipCondensationIntensity,
        centerWakeIntensity,
        cfg
    };
})(typeof window !== 'undefined' ? window : globalThis);
