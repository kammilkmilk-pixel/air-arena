// ============================================================================
// condensation-vfx.js — wingtip vortex ribbons + high-AoA leading-edge vapor fog
// Visual-only. Driven each frame from aircraft pose / velocity / stick load.
// ============================================================================

(function initCondensationVfx(root) {
    const _tmpNose = new THREE.Vector3();
    const _tmpVel = new THREE.Vector3();
    const _tmpRight = new THREE.Vector3();
    const _tmpUp = new THREE.Vector3();
    const _tmpLocal = new THREE.Vector3();
    const _tmpWorld = new THREE.Vector3();
    const _tmpCam = new THREE.Vector3();
    const _tmpA = new THREE.Vector3();
    const _tmpB = new THREE.Vector3();

    let vaporTex = null;
    let vortexMat = null;
    let fogMat = null;
    let lastNow = 0;

    function cfg() {
        const v = (typeof CONFIG !== 'undefined' && CONFIG.visuals && CONFIG.visuals.condensation)
            ? CONFIG.visuals.condensation
            : {};
        return {
            enabled: v.enabled !== false,
            vortexPts: Math.max(16, Math.min(160, Number(v.vortexPts) || 96)),
            vortexBaseWidth: Number(v.vortexBaseWidth) || 0.035,
            vortexGrow: Number(v.vortexGrow) || 0.7,
            vortexIdle: Number(v.vortexIdle) || 0.12,
            vortexTurnBoost: Number(v.vortexTurnBoost) || 1.35,
            vortexAoaBoost: Number(v.vortexAoaBoost) || 0.9,
            vortexMinSpeed: Number(v.vortexMinSpeed) || 0.08,
            trailPersistMs: Math.max(800, Number(v.trailPersistMs) || 2800),
            sampleMinDist: Math.max(0.05, Number(v.sampleMinDist) || 0.35),
            aoaFogStart: Number(v.aoaFogStart) || 0.18,
            aoaFogFull: Number(v.aoaFogFull) || 0.42,
            leFogMaxOpacity: Number(v.leFogMaxOpacity) || 0.55,
            leFogScale: Number(v.leFogScale) || 0.22
        };
    }

    function aircraftVisuals(team) {
        const type = (team && team.type) || 'mig21';
        const ac = (typeof CONFIG !== 'undefined' && CONFIG.aircrafts && CONFIG.aircrafts[type])
            ? CONFIG.aircrafts[type]
            : null;
        const vis = (ac && ac.visuals) || {};
        return {
            wingTipL: Array.isArray(vis.wingTipL) ? vis.wingTipL : [-0.38, 0.01, 0.02],
            wingTipR: Array.isArray(vis.wingTipR) ? vis.wingTipR : [0.38, 0.01, 0.02],
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
        if (!vortexMat) {
            const map = (typeof window !== 'undefined' && window.ribbonTexShared)
                ? window.ribbonTexShared
                : vaporTex;
            vortexMat = new THREE.MeshBasicMaterial({
                map,
                transparent: true,
                opacity: 1,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                vertexColors: true,
                fog: true
            });
        }
        if (!fogMat) {
            fogMat = new THREE.MeshBasicMaterial({
                map: vaporTex,
                color: 0xe8f2ff,
                transparent: true,
                opacity: 0,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: true
            });
        }
    }

    function makeRibbon(maxPts) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 3), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 3), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 2), 2));
        const indices = [];
        for (let i = 0; i < maxPts - 1; i++) {
            indices.push(i * 2, i * 2 + 1, i * 2 + 2);
            indices.push(i * 2 + 2, i * 2 + 1, i * 2 + 3);
        }
        geo.setIndex(indices);
        geo.setDrawRange(0, 0);
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
        const mesh = new THREE.Mesh(geo, vortexMat.clone());
        mesh.frustumCulled = false;
        mesh.renderOrder = 3;
        mesh.visible = false;
        mesh.name = 'condensationVortex';
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

    function disposeRibbonPair(fx) {
        if (!fx) return;
        [fx.left, fx.right].forEach((m) => {
            if (!m) return;
            if (m.parent) m.parent.remove(m);
            else if (typeof scene !== 'undefined' && scene) scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
        });
        fx.left = null;
        fx.right = null;
    }

    function ensureFx(team) {
        if (!team || !team.wrapper) return null;
        if (typeof scene === 'undefined' || !scene) return null;
        ensureSharedMats();
        const c = cfg();
        const vis = aircraftVisuals(team);
        let fx = team.wrapper.userData.condensation;

        // Rebuild ribbon buffers if capacity grew (e.g. longer persist).
        if (fx && fx.capPts !== c.vortexPts) {
            disposeRibbonPair(fx);
            fx.left = makeRibbon(c.vortexPts);
            fx.right = makeRibbon(c.vortexPts);
            scene.add(fx.left);
            scene.add(fx.right);
            fx.capPts = c.vortexPts;
        }

        if (fx) return fx;

        const left = makeRibbon(c.vortexPts);
        const right = makeRibbon(c.vortexPts);
        scene.add(left);
        scene.add(right);

        const fogGroup = new THREE.Group();
        fogGroup.name = 'condensationLeFogGroup';
        // Tag so ghostWrapper.clone() can strip these (same pattern as exhaust).
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
            left,
            right,
            fogGroup,
            fogSprites,
            histL: [],
            histR: [],
            capPts: c.vortexPts,
            prevPos: null,
            prevQuat: null,
            intensity: 0,
            aoa: 0
        };
        team.wrapper.userData.condensation = fx;
        return fx;
    }

    function pushTipSample(hist, worldPos, now, c) {
        const newest = hist[0];
        if (newest && newest.p.distanceToSquared(worldPos) < c.sampleMinDist * c.sampleMinDist) {
            // Refresh tip timestamp / position without adding density.
            newest.p.copy(worldPos);
            newest.t = now;
            return;
        }
        hist.unshift({ p: worldPos.clone(), t: now });
        while (hist.length > c.vortexPts) hist.pop();
        const cutoff = now - c.trailPersistMs;
        while (hist.length && hist[hist.length - 1].t < cutoff) hist.pop();
    }

    function pruneHist(hist, now, c) {
        const cutoff = now - c.trailPersistMs;
        while (hist.length && hist[hist.length - 1].t < cutoff) hist.pop();
        while (hist.length > c.vortexPts) hist.pop();
    }

    function hideFx(fx) {
        if (!fx) return;
        if (fx.left) fx.left.visible = false;
        if (fx.right) fx.right.visible = false;
        if (fx.fogSprites) {
            fx.fogSprites.forEach((s) => {
                s.visible = false;
                if (s.material) s.material.opacity = 0;
            });
        }
        fx.histL.length = 0;
        fx.histR.length = 0;
    }

    function localToWorld(wrapper, localArr, out) {
        _tmpLocal.set(Number(localArr[0]) || 0, Number(localArr[1]) || 0, Number(localArr[2]) || 0);
        return out.copy(_tmpLocal).applyQuaternion(wrapper.quaternion).add(wrapper.position);
    }

    /**
     * Estimate geometric AoA (rad) from nose vs world velocity.
     * Falls back to stick pitch demand when velocity is tiny (hover / stall preview).
     */
    function estimateAoa(team, wrapper, fx, dtSec) {
        _tmpNose.set(0, 0, 1).applyQuaternion(wrapper.quaternion);
        let speed = 0;
        if (fx.prevPos && dtSec > 1e-4) {
            _tmpVel.subVectors(wrapper.position, fx.prevPos).divideScalar(dtSec);
            speed = _tmpVel.length();
        } else {
            _tmpVel.set(0, 0, 0);
        }

        let aoa = 0;
        if (speed > 0.05) {
            _tmpVel.normalize();
            const dot = Math.max(-1, Math.min(1, _tmpNose.dot(_tmpVel)));
            aoa = Math.acos(dot);
        } else {
            const pitchCmd = Math.abs(Number(team.joyY) || 0);
            aoa = pitchCmd * 0.55;
        }

        // Stick / path pitch demand can push fog earlier during planning.
        const pitchPush = Math.abs(Number(team.joyY) || 0) * 0.35;
        if (team.chain && team.chain[0] && team.chain[0].pitch != null) {
            aoa = Math.max(aoa, Math.abs(Number(team.chain[0].pitch)) * 0.85);
        }
        aoa = Math.max(aoa, pitchPush);
        return { aoa, speed };
    }

    function estimateTurnLoad(team, wrapper, fx, dtSec) {
        let turn = Math.hypot(Number(team.joyX) || 0, Number(team.joyY) || 0);
        if (team.chain && team.chain[0]) {
            const cmd = team.chain[0];
            turn = Math.max(
                turn,
                Math.hypot(Number(cmd.yaw) || 0, Number(cmd.pitch) || 0) / (Math.PI / 3)
            );
        }
        if (fx.prevQuat && dtSec > 1e-4) {
            const ang = fx.prevQuat.angleTo(wrapper.quaternion) / Math.max(dtSec, 1e-3);
            turn = Math.max(turn, Math.min(1.6, ang / 1.8));
        }
        return Math.max(0, Math.min(1.5, turn));
    }

    function writeRibbon(mesh, hist, intensity, c, now) {
        if (!mesh || !hist || hist.length < 2) {
            if (mesh) mesh.visible = false;
            return;
        }
        // Even if current tip intensity is low, keep fading the persisted wake.
        const drawIntensity = Math.max(intensity, 0.18);
        const maxPts = c.vortexPts;
        const persist = Math.max(1, c.trailPersistMs);
        const posArr = mesh.geometry.attributes.position.array;
        const colArr = mesh.geometry.attributes.color.array;
        const uvArr = mesh.geometry.attributes.uv.array;
        const cam = (typeof camera !== 'undefined') ? camera : null;
        let valid = 0;

        for (let h = 0; h < hist.length && h < maxPts; h++) {
            const sample = hist[h];
            if (!sample || !sample.p) continue;
            const age = Math.max(0, (now - sample.t) / persist);
            if (age >= 1) continue;
            const life = age; // 0 at tip → 1 at oldest (time-based, not index-based)
            const width = (c.vortexBaseWidth + life * c.vortexGrow) * (0.55 + 0.7 * drawIntensity);
            _tmpWorld.copy(sample.p);
            if (cam) {
                _tmpCam.subVectors(cam.position, _tmpWorld).normalize();
            } else {
                _tmpCam.set(0, 1, 0);
            }
            const next = hist[Math.min(h + 1, hist.length - 1)];
            const nextP = (next && next.p) ? next.p : sample.p;
            _tmpA.subVectors(_tmpWorld, nextP);
            if (_tmpA.lengthSq() < 1e-8) _tmpA.set(0, 0, 1);
            else _tmpA.normalize();
            _tmpRight.crossVectors(_tmpA, _tmpCam);
            if (_tmpRight.lengthSq() < 1e-6) {
                _tmpUp.set(0, 1, 0);
                _tmpRight.crossVectors(_tmpA, _tmpUp);
            }
            _tmpRight.normalize().multiplyScalar(width);

            const idx = valid * 2;
            posArr[idx * 3 + 0] = _tmpWorld.x + _tmpRight.x;
            posArr[idx * 3 + 1] = _tmpWorld.y + _tmpRight.y;
            posArr[idx * 3 + 2] = _tmpWorld.z + _tmpRight.z;
            posArr[idx * 3 + 3] = _tmpWorld.x - _tmpRight.x;
            posArr[idx * 3 + 4] = _tmpWorld.y - _tmpRight.y;
            posArr[idx * 3 + 5] = _tmpWorld.z - _tmpRight.z;

            // Gentler falloff so the wake stays readable across ~2 turns.
            const fade = Math.pow(1 - life, 1.05) * drawIntensity * (0.55 + 0.45 * intensity);
            const r = 0.78 * fade;
            const g = 0.88 * fade;
            const b = 1.0 * fade;
            colArr[idx * 3 + 0] = r; colArr[idx * 3 + 1] = g; colArr[idx * 3 + 2] = b;
            colArr[idx * 3 + 3] = r; colArr[idx * 3 + 4] = g; colArr[idx * 3 + 5] = b;
            uvArr[idx * 2 + 0] = 0; uvArr[idx * 2 + 1] = life;
            uvArr[idx * 2 + 2] = 1; uvArr[idx * 2 + 3] = life;
            valid++;
        }

        if (valid > 1) {
            mesh.geometry.setDrawRange(0, (valid - 1) * 6);
            mesh.geometry.attributes.position.needsUpdate = true;
            mesh.geometry.attributes.color.needsUpdate = true;
            mesh.geometry.attributes.uv.needsUpdate = true;
            mesh.visible = true;
            if (mesh.material) mesh.material.opacity = Math.min(1, 0.3 + drawIntensity * 0.7);
        } else {
            mesh.visible = false;
        }
    }

    function updateLeFog(fx, aoa, c, now) {
        const span = Math.max(1e-3, c.aoaFogFull - c.aoaFogStart);
        let t = (aoa - c.aoaFogStart) / span;
        t = Math.max(0, Math.min(1, t));
        t = t * t * (3 - 2 * t); // smoothstep
        const pulse = 0.92 + 0.08 * Math.sin(now * 0.009);
        const opacity = t * c.leFogMaxOpacity * pulse;
        const camQ = (typeof camera !== 'undefined' && camera) ? camera.quaternion : null;

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
            if (camQ) spr.quaternion.copy(camQ);
        });
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

        ensureSharedMats();
        const ids = activeIds();
        ids.forEach((id) => {
            const team = teams[id];
            if (!team || !team.wrapper || team.isDestroyed || team.matchActive === false) {
                if (team && team.wrapper && team.wrapper.userData.condensation) {
                    hideFx(team.wrapper.userData.condensation);
                }
                return;
            }
            if (!team.wrapper.visible) {
                if (team.wrapper.userData.condensation) hideFx(team.wrapper.userData.condensation);
                return;
            }

            const fx = ensureFx(team);
            if (!fx) return;
            const vis = aircraftVisuals(team);
            const { aoa, speed } = estimateAoa(team, team.wrapper, fx, dtSec);
            const turn = estimateTurnLoad(team, team.wrapper, fx, dtSec);
            fx.aoa = aoa;

            const speedGate = speed < c.vortexMinSpeed
                ? Math.max(0.15, speed / Math.max(c.vortexMinSpeed, 1e-3))
                : 1;
            let intensity = c.vortexIdle
                + turn * c.vortexTurnBoost
                + Math.min(1.2, aoa / Math.max(c.aoaFogFull, 1e-3)) * c.vortexAoaBoost;
            intensity *= speedGate;
            // Throttle / energy: AB slightly thicker vapor.
            const th = Number(team.throttle) || 2;
            intensity *= 0.85 + Math.min(0.35, (th - 2) * 0.08);
            intensity = Math.max(0, Math.min(1.85, intensity));
            fx.intensity = intensity;

            // Sample wing tips (distance-gated) and age out beyond ~1.5–2 turns.
            localToWorld(team.wrapper, vis.wingTipL, _tmpA);
            localToWorld(team.wrapper, vis.wingTipR, _tmpB);
            if (intensity >= 0.06 && speedGate > 0.2) {
                pushTipSample(fx.histL, _tmpA, now, c);
                pushTipSample(fx.histR, _tmpB, now, c);
            } else {
                pruneHist(fx.histL, now, c);
                pruneHist(fx.histR, now, c);
            }

            writeRibbon(fx.left, fx.histL, intensity, c, now);
            writeRibbon(fx.right, fx.histR, intensity, c, now);
            updateLeFog(fx, aoa, c, now);

            if (!fx.prevPos) fx.prevPos = team.wrapper.position.clone();
            else fx.prevPos.copy(team.wrapper.position);
            if (!fx.prevQuat) fx.prevQuat = team.wrapper.quaternion.clone();
            else fx.prevQuat.copy(team.wrapper.quaternion);
        });
    }

    function disposeTeamCondensation(team) {
        if (!team || !team.wrapper || !team.wrapper.userData.condensation) return;
        const fx = team.wrapper.userData.condensation;
        [fx.left, fx.right].forEach((m) => {
            if (!m) return;
            if (m.parent) m.parent.remove(m);
            else if (typeof scene !== 'undefined' && scene) scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
        });
        if (fx.fogGroup && fx.fogGroup.parent) fx.fogGroup.parent.remove(fx.fogGroup);
        fx.fogSprites.forEach((s) => {
            if (s.geometry) s.geometry.dispose();
            if (s.material) s.material.dispose();
        });
        delete team.wrapper.userData.condensation;
    }

    root.updateCondensationVfx = updateCondensationVfx;
    root.disposeTeamCondensation = disposeTeamCondensation;
    // Node-friendly helpers for smoke tests (no WebGL).
    root.AirArenaCondensation = {
        estimateAoaFromNoseVel(noseDotVel) {
            const d = Math.max(-1, Math.min(1, Number(noseDotVel) || 0));
            return Math.acos(d);
        },
        fogAmount(aoa, start, full) {
            const s = Number(start) || 0.18;
            const f = Number(full) || 0.42;
            let t = (Number(aoa) - s) / Math.max(1e-3, f - s);
            t = Math.max(0, Math.min(1, t));
            return t * t * (3 - 2 * t);
        },
        cfg
    };
})(typeof window !== 'undefined' ? window : globalThis);
