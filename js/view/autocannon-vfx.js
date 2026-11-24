// ============================================================================
// autocannon-vfx.js — High-performance unified autocannon tracers, barrel-locked
// muzzle flashes, and surface-aware impact VFX (aircraft / building / ground).
//
// Zero per-frame allocations & GPU InstancedMesh batching:
//   - All flying tracer bolts rendered in 2 InstancedMesh draw calls (outer halo + core)
//   - Barrel-locked twin muzzle flash cones + gun-gas synced to aircraft pose
//   - Surface-specific gun_hit impacts (metal ricochet sparks + slipstream smoke on
//     aircraft; concrete dust + normal-reflected sparks on buildings; bottom-feathered
//     vertical dirt spouts on ground) in O(1) analytic closed-form motion
// ============================================================================

(function initAutocannonVfx(root) {
    const _pos = new THREE.Vector3();
    const _quat = new THREE.Quaternion();
    const _acVel = new THREE.Vector3();
    const _muzzle = new THREE.Vector3();
    const _vel0 = new THREE.Vector3();
    const _head = new THREE.Vector3();
    const _velNow = new THREE.Vector3();
    const _dir = new THREE.Vector3();
    const _tailMid = new THREE.Vector3();
    const _tmpA = new THREE.Vector3();
    const _tmpB = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0);
    const _axisZ = new THREE.Vector3(0, 0, 1);
    const _qAlign = new THREE.Quaternion();
    const _qZ = new THREE.Quaternion();
    const _scale = new THREE.Vector3();
    const _mat4 = new THREE.Matrix4();
    const _col = new THREE.Color();

    const MAX_TRACERS = 180;
    const MAX_HIT_SPARKS = 320;
    const MAX_HIT_FLASHES = 32;
    const MAX_HIT_PUFFS = 48;

    function ballistics() {
        return (typeof window !== 'undefined' && window.AirArenaGunBallistics)
            ? window.AirArenaGunBallistics
            : (typeof AirArenaGunBallistics !== 'undefined' ? AirArenaGunBallistics : null);
    }

    function mulberry32(seed) {
        let a = (seed >>> 0) || 0x9e3779b9;
        return function next() {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function smoothstep(e0, e1, x) {
        const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
        return t * t * (3 - 2 * t);
    }

    /**
     * Crossed 2-plane 3D bolt geometry extending along -Z from head (0) to tail (-1).
     * Visible from side, chase, and top-down angles without ever collapsing edge-on.
     */
    function createCrossBoltGeometry() {
        // Plane 1 (XZ horizontal) + Plane 2 (YZ vertical)
        const positions = new Float32Array([
            // Horizontal quad: X in [-0.5, 0.5], Z in [0, -1]
            -0.5, 0,  0,   0.5, 0,  0,   0.5, 0, -1,
            -0.5, 0,  0,   0.5, 0, -1,  -0.5, 0, -1,
            // Vertical quad: Y in [-0.5, 0.5], Z in [0, -1]
             0, -0.5, 0,   0, 0.5,  0,   0, 0.5, -1,
             0, -0.5, 0,   0, 0.5, -1,   0, -0.5, -1
        ]);
        // UV: u across thickness [0..1], v = 1 at head (Z=0), v = 0 at tail (Z=-1)
        const uvs = new Float32Array([
            0, 1,  1, 1,  1, 0,
            0, 1,  1, 0,  0, 0,
            0, 1,  1, 1,  1, 0,
            0, 1,  1, 0,  0, 0
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        return geo;
    }

    /** Forward-pointing muzzle flame cone (Z in [0, +1]). */
    function createMuzzleConeGeometry() {
        const positions = new Float32Array([
            -0.5, 0, 0,   0.5, 0, 0,   0.5, 0, 1,
            -0.5, 0, 0,   0.5, 0, 1,  -0.5, 0, 1,
             0, -0.5, 0,  0, 0.5, 0,   0, 0.5, 1,
             0, -0.5, 0,  0, 0.5, 1,   0, -0.5, 1
        ]);
        const uvs = new Float32Array([
            0, 1,  1, 1,  1, 0,
            0, 1,  1, 0,  0, 0,
            0, 1,  1, 1,  1, 0,
            0, 1,  1, 0,  0, 0
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        return geo;
    }

    const textures = {
        ready: false,
        tracerHalo: null,
        tracerCore: null,
        muzzleCone: null,
        hitFlash: null,
        hitPuff: null,
        groundSpout: null
    };

    function buildTextures() {
        if (textures.ready || typeof document === 'undefined') return;
        textures.ready = true;

        // 1. Tracer Outer Halo (NormalBlending orange-amber so it reads clearly against bright sky/buildings)
        {
            const W = 32, H = 128;
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(W, H);
            const d = img.data;
            for (let y = 0; y < H; y++) {
                const v = y / (H - 1); // 0 = hot head, 1 = tail end
                const lenMask = smoothstep(0.0, 0.05, v) * Math.pow(1 - v, 1.35);
                const headHot = Math.pow(Math.max(0, 1 - v * 2.4), 1.4);
                for (let x = 0; x < W; x++) {
                    const u = Math.abs((x / (W - 1)) * 2 - 1);
                    const widthProfile = Math.max(0.22, 1 - v * 0.65);
                    const radial = Math.max(0, 1 - Math.pow(u / widthProfile, 1.85));
                    const a = radial * lenMask;
                    const idx = (y * W + x) * 4;
                    d[idx] = 255;
                    d[idx + 1] = Math.round(115 + headHot * 125);
                    d[idx + 2] = Math.round(18 + headHot * 130);
                    d[idx + 3] = Math.round(Math.min(1, a * 1.15) * 235);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.tracerHalo = new THREE.CanvasTexture(c);
            textures.tracerHalo.needsUpdate = true;
        }

        // 2. Tracer Incandescent Core (AdditiveBlending white-gold needle)
        {
            const W = 32, H = 128;
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(W, H);
            const d = img.data;
            for (let y = 0; y < H; y++) {
                const v = y / (H - 1);
                const lenMask = smoothstep(0.0, 0.04, v) * Math.pow(1 - v, 1.65);
                for (let x = 0; x < W; x++) {
                    const u = Math.abs((x / (W - 1)) * 2 - 1);
                    const radial = Math.max(0, 1 - Math.pow(u / 0.52, 2.0));
                    const a = radial * lenMask;
                    const idx = (y * W + x) * 4;
                    d[idx] = 255;
                    d[idx + 1] = Math.round(245 - v * 75);
                    d[idx + 2] = Math.round(215 - v * 175);
                    d[idx + 3] = Math.round(Math.min(1, a * 1.25) * 255);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.tracerCore = new THREE.CanvasTexture(c);
            textures.tracerCore.needsUpdate = true;
        }

        // 3. Muzzle Flash Jet Cone (AdditiveBlending, y=0 at barrel root → y=1 tip)
        {
            const W = 64, H = 64;
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(W, H);
            const d = img.data;
            for (let y = 0; y < H; y++) {
                const v = y / (H - 1); // 0 = barrel root, 1 = flame tip
                const coneW = Math.max(0.06, (1 - v) * 0.92);
                const axial = smoothstep(0.0, 0.08, v) * Math.pow(1 - v, 1.15);
                for (let x = 0; x < W; x++) {
                    const u = Math.abs((x / (W - 1)) * 2 - 1);
                    const radial = Math.max(0, 1 - Math.pow(u / coneW, 1.6));
                    // Side gas jet ears near root (v ≈ 0.12..0.28)
                    const ear = Math.exp(-Math.pow((v - 0.16) / 0.10, 2)) * Math.max(0, 1 - u * 1.05) * 0.55;
                    const vTot = Math.min(1, radial * axial * 1.25 + ear);
                    const idx = (y * W + x) * 4;
                    d[idx] = 255;
                    d[idx + 1] = Math.round(165 + vTot * 88);
                    d[idx + 2] = Math.round(45 + vTot * 185);
                    d[idx + 3] = Math.round(vTot * 255);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.muzzleCone = new THREE.CanvasTexture(c);
            textures.muzzleCone.needsUpdate = true;
        }

        // 4. Crisp Star Impact Flash (64x64, AdditiveBlending)
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
                    const core = Math.pow(Math.max(0, 1 - r), 2.5);
                    const cross = Math.exp(-Math.abs(nx) * 7) * Math.max(0, 1 - Math.abs(ny))
                        + Math.exp(-Math.abs(ny) * 7) * Math.max(0, 1 - Math.abs(nx));
                    const v = Math.min(1, core * 1.15 + cross * 0.48 * Math.max(0, 1 - r));
                    const idx = (y * S + x) * 4;
                    d[idx] = 255;
                    d[idx + 1] = Math.round(170 + v * 85);
                    d[idx + 2] = Math.round(55 + v * 195);
                    d[idx + 3] = Math.round(v * 255);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.hitFlash = new THREE.CanvasTexture(c);
            textures.hitFlash.needsUpdate = true;
        }

        // 5. Shaded Impact Dust / Smoke Puff & Bottom-Feathered Ground Dirt Spout
        function makePuffTex(bottomFeather) {
            const S = 64;
            const c = document.createElement('canvas');
            c.width = S; c.height = S;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(S, S);
            const d = img.data;
            for (let y = 0; y < S; y++) {
                for (let x = 0; x < S; x++) {
                    const nx = (x / (S - 1)) * 2 - 1;
                    const ny = 1 - (y / (S - 1)) * 2;
                    const r = Math.hypot(nx, ny);
                    const n = 0.5 + 0.25 * Math.sin(nx * 5.2 + ny * 3.7) + 0.25 * Math.cos(nx * 4.1 - ny * 6.3);
                    let a = 1 - smoothstep(0.28, 0.94, r + (n - 0.5) * 0.34);
                    if (bottomFeather) {
                        a *= smoothstep(0.04, 0.36, (ny + 1) * 0.5);
                    }
                    const lit = Math.max(0, Math.min(1, 0.5 + ny * 0.32 + nx * 0.16));
                    const lum = Math.round(125 + lit * 125);
                    const idx = (y * S + x) * 4;
                    d[idx] = lum;
                    d[idx + 1] = Math.round(lum * 0.97);
                    d[idx + 2] = Math.round(lum * 0.94);
                    d[idx + 3] = Math.round(Math.max(0, Math.min(1, a)) * 240);
                }
            }
            ctx.putImageData(img, 0, 0);
            const tex = new THREE.CanvasTexture(c);
            tex.needsUpdate = true;
            return tex;
        }

        textures.hitPuff = makePuffTex(false);
        textures.groundSpout = makePuffTex(true);
    }

    const pools = {
        ready: false,
        tracerHalo: null,
        tracerCore: null,
        hitSparks: null,
        hitFlashes: [],
        hitPuffs: [],
        muzzleRigs: {}
    };

    function ensurePools() {
        if (pools.ready || typeof scene === 'undefined' || !scene) return;
        buildTextures();
        if (!textures.ready) return;
        pools.ready = true;

        const boltGeo = createCrossBoltGeometry();
        const haloMat = new THREE.MeshBasicMaterial({
            map: textures.tracerHalo,
            color: 0xffffff,
            transparent: true,
            opacity: 0.92,
            blending: THREE.NormalBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false
        });
        pools.tracerHalo = new THREE.InstancedMesh(boltGeo, haloMat, MAX_TRACERS);
        pools.tracerHalo.count = 0;
        pools.tracerHalo.frustumCulled = false;
        pools.tracerHalo.renderOrder = 6;
        pools.tracerHalo.visible = false;
        scene.add(pools.tracerHalo);

        const coreMat = new THREE.MeshBasicMaterial({
            map: textures.tracerCore,
            color: 0xffffff,
            transparent: true,
            opacity: 0.98,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false
        });
        pools.tracerCore = new THREE.InstancedMesh(boltGeo, coreMat, MAX_TRACERS);
        pools.tracerCore.count = 0;
        pools.tracerCore.frustumCulled = false;
        pools.tracerCore.renderOrder = 7;
        pools.tracerCore.visible = false;
        scene.add(pools.tracerCore);

        // InstancedMesh for ricochet & impact sparks (reuses cross bolt geometry, 1 draw call!)
        const sparkMat = new THREE.MeshBasicMaterial({
            map: textures.tracerCore,
            color: 0xffd27a,
            transparent: true,
            opacity: 0.96,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
            fog: false
        });
        pools.hitSparks = new THREE.InstancedMesh(boltGeo, sparkMat, MAX_HIT_SPARKS);
        pools.hitSparks.count = 0;
        pools.hitSparks.frustumCulled = false;
        pools.hitSparks.renderOrder = 7;
        pools.hitSparks.visible = false;
        scene.add(pools.hitSparks);

        const planeGeo = new THREE.PlaneGeometry(1, 1);
        for (let i = 0; i < MAX_HIT_FLASHES; i++) {
            const m = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({
                map: textures.hitFlash,
                color: 0xffffff,
                transparent: true,
                opacity: 0,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: false
            }));
            m.visible = false;
            m.frustumCulled = false;
            m.renderOrder = 8;
            scene.add(m);
            pools.hitFlashes.push(m);
        }

        for (let i = 0; i < MAX_HIT_PUFFS; i++) {
            const m = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({
                map: textures.hitPuff,
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
            m.renderOrder = 5;
            scene.add(m);
            pools.hitPuffs.push(m);
        }
    }

    function ensureMuzzleRig(id) {
        if (pools.muzzleRigs[id]) return pools.muzzleRigs[id];
        if (typeof scene === 'undefined' || !scene) return null;
        ensurePools();
        if (!pools.ready) return null;

        const rootGrp = new THREE.Group();
        rootGrp.name = 'autocannonMuzzleRig_' + id;
        rootGrp.visible = false;

        const coneGeo = createMuzzleConeGeometry();
        const discGeo = new THREE.PlaneGeometry(1, 1);
        const barrels = [];
        for (let b = 0; b < 2; b++) {
            const bGrp = new THREE.Group();
            const cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
                map: textures.muzzleCone,
                color: 0xffe49a,
                transparent: true,
                opacity: 0,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: false
            }));
            cone.renderOrder = 8;
            const star = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
                map: textures.hitFlash,
                color: 0xfff0b8,
                transparent: true,
                opacity: 0,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: false
            }));
            star.renderOrder = 8;
            const gas = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
                map: textures.hitPuff,
                color: 0xcbc6be,
                transparent: true,
                opacity: 0,
                blending: THREE.NormalBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                fog: true
            }));
            gas.renderOrder = 5;
            bGrp.add(cone, star, gas);
            rootGrp.add(bGrp);
            barrels.push({ grp: bGrp, cone, star, gas });
        }

        scene.add(rootGrp);
        pools.muzzleRigs[id] = { root: rootGrp, barrels };
        return pools.muzzleRigs[id];
    }

    function hideAll() {
        if (!pools.ready) return;
        if (pools.tracerHalo) { pools.tracerHalo.count = 0; pools.tracerHalo.visible = false; }
        if (pools.tracerCore) { pools.tracerCore.count = 0; pools.tracerCore.visible = false; }
        if (pools.hitSparks) { pools.hitSparks.count = 0; pools.hitSparks.visible = false; }
        for (let i = 0; i < pools.hitFlashes.length; i++) pools.hitFlashes[i].visible = false;
        for (let i = 0; i < pools.hitPuffs.length; i++) pools.hitPuffs[i].visible = false;
        Object.keys(pools.muzzleRigs).forEach((id) => {
            if (pools.muzzleRigs[id]) pools.muzzleRigs[id].root.visible = false;
        });
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
     * Render all autocannon tracers, barrel-locked muzzle flashes, and `gun_hit` impacts
     * for the current combat/ACMI frame. 100% deterministic and zero-allocation.
     */
    function renderCombatAutocannon(battleLogRef, turnIdx, animProgress, activeIds) {
        const B = ballistics();
        if (!B) return;
        const vcfg = B.vfxConfig();
        if (!vcfg.enabled) {
            hideAll();
            return;
        }
        ensurePools();
        if (!pools.ready) return;

        hideAll();
        if (!Array.isArray(battleLogRef) || !battleLogRef.length || turnIdx < 0) return;

        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? Number(CONFIG.rules.stepsPerTurn) : 100;
        const trackIdx = Math.min(stepsPerTurn, Math.floor(animProgress * stepsPerTurn));
        const ids = Array.isArray(activeIds) ? activeIds : ['red', 'red2', 'blue', 'blue2'];
        const rounds = vcfg.roundsPerTurn;
        const maxFlight = vcfg.maxFlightTime;

        let tracerCount = 0;

        // 1) Flying 3D tracers + barrel-locked twin muzzle flashes
        for (let ii = 0; ii < ids.length; ii++) {
            const id = ids[ii];
            const team = (typeof teams !== 'undefined') ? teams[id] : null;
            if (!team || team.matchActive === false) continue;
            const acType = team.type || 'mig21';

            // Current-turn barrel-locked muzzle flash (only when this plane is alive & firing)
            const curLog = battleLogRef[turnIdx];
            const curEntry = curLog && curLog[id];
            const curHpArr = curLog && curLog.hpTrack && Array.isArray(curLog.hpTrack[id]) ? curLog.hpTrack[id] : null;
            const aliveAtCurStep = !curHpArr || curHpArr.length === 0
                || Number(curHpArr[Math.min(curHpArr.length - 1, trackIdx)]) > 0;
            const isFiringNow = !!(aliveAtCurStep && curEntry && Array.isArray(curEntry.chain) && curEntry.chain.length > 0
                && curEntry.chain[0].fire === 'gun' && curEntry.pts && curEntry.pts.length >= 2
                && team.wrapper && team.wrapper.visible);

            if (isFiringNow && animProgress < 0.985) {
                const rig = ensureMuzzleRig(id);
                if (rig) {
                    const params = B.resolveGunParams(acType, curEntry.chain[0].throttle);
                    rig.root.position.copy(team.wrapper.position);
                    rig.root.quaternion.copy(team.wrapper.quaternion);
                    rig.root.visible = true;

                    // Rapid twin-barrel fire pulse locked to round cadence:
                    // GSh-23 fires alternating barrels fast enough that one barrel is always flashing hot.
                    const phase = animProgress * rounds;
                    const roundIdx = Math.floor(phase);
                    const sub = phase - roundIdx; // 0..1 within current shot interval
                    const hotPulse = 0.35 + 0.65 * Math.pow(Math.max(0, 1 - sub * 1.15), 1.1);
                    const coolPulse = Math.max(0.08, (1 - sub) * 0.42);
                    const activeBarrel = roundIdx % Math.max(1, params.barrels.length);

                    for (let bi = 0; bi < rig.barrels.length; bi++) {
                        const br = rig.barrels[bi];
                        const off = params.barrels[bi % params.barrels.length];
                        br.grp.position.set(off[0], off[1], off[2]);

                        const isHot = (bi === activeBarrel);
                        const inten = isHot ? hotPulse : coolPulse;

                        if (inten > 0.04) {
                            const jitter = 0.86 + 0.28 * Math.sin(roundIdx * 7.3 + bi * 2.7);
                            const flameLen = (0.58 + 0.68 * inten) * jitter;
                            const flameW = (0.20 + 0.22 * inten) * (0.9 + 0.2 * jitter);
                            br.cone.visible = true;
                            br.cone.scale.set(flameW, flameW, flameLen);
                            br.cone.rotation.z = (roundIdx * 1.37 + bi * 2.1) % (Math.PI * 2);
                            br.cone.material.opacity = Math.min(1, inten * 1.15);

                            br.star.visible = true;
                            br.star.position.set(0, 0, 0.08);
                            const starSz = 0.34 + 0.38 * inten;
                            br.star.scale.set(starSz, starSz, 1);
                            if (typeof camera !== 'undefined' && camera) {
                                _qAlign.copy(team.wrapper.quaternion).invert().multiply(camera.quaternion);
                                br.star.quaternion.copy(_qAlign);
                            }
                            br.star.material.opacity = Math.min(1, inten * 1.0);
                        } else {
                            br.cone.visible = false;
                            br.star.visible = false;
                        }

                        // Subtle forward muzzle gun-gas puff
                        const gasSub = (phase * 0.5 + bi * 0.5) % 1;
                        const gasOp = smoothstep(0, 0.15, gasSub) * (1 - gasSub) * 0.32;
                        if (gasOp > 0.02) {
                            br.gas.visible = true;
                            br.gas.position.set(0, 0.02 * gasSub, 0.15 + gasSub * 0.55);
                            const gSz = 0.18 + gasSub * 0.42;
                            br.gas.scale.set(gSz, gSz, 1);
                            if (typeof camera !== 'undefined' && camera) {
                                _qAlign.copy(team.wrapper.quaternion).invert().multiply(camera.quaternion);
                                br.gas.quaternion.copy(_qAlign);
                            }
                            br.gas.material.opacity = gasOp;
                        } else {
                            br.gas.visible = false;
                        }
                    }
                }
            }

            // Flying rounds from current turn (age=0) and previous turn (age=1)
            for (let age = 0; age <= 1; age++) {
                const logIdx = turnIdx - age;
                if (logIdx < 0) continue;
                const pastLog = battleLogRef[logIdx];
                const entry = pastLog && pastLog[id];
                if (!entry || !Array.isArray(entry.chain) || !entry.chain.length || entry.chain[0].fire !== 'gun') continue;
                if (!entry.pts || entry.pts.length < 2 || !entry.quats || entry.quats.length < 2) continue;

                const params = B.resolveGunParams(acType, entry.chain[0].throttle);
                const gunStops = Array.isArray(entry.gunStops) ? entry.gunStops : null;
                const pastHpArr = pastLog && pastLog.hpTrack && Array.isArray(pastLog.hpTrack[id]) ? pastLog.hpTrack[id] : null;

                for (let b = 0; b < rounds; b++) {
                    if (tracerCount >= MAX_TRACERS) break;
                    const tSpawn = B.roundSpawnTime(b, rounds);
                    // Truncate rounds scheduled after the shooter died mid-turn.
                    if (pastHpArr && pastHpArr.length > 0) {
                        const spawnStep = Math.min(pastHpArr.length - 1, Math.max(0, Math.floor(tSpawn * stepsPerTurn)));
                        if (Number(pastHpArr[spawnStep]) <= 0) continue;
                    }
                    const dt = animProgress - tSpawn + age;
                    if (dt <= 0.0005 || dt > maxFlight) continue;

                    // Precomputed obstacle/target stop time (zero raycasts during playback!)
                    const stopDt = (gunStops && Number.isFinite(Number(gunStops[b])))
                        ? Number(gunStops[b])
                        : maxFlight;
                    if (dt > stopDt + 0.008) continue;

                    B.samplePosAt(tSpawn, entry.pts, _pos);
                    B.sampleQuatAt(tSpawn, entry.quats, _quat);
                    B.sampleAircraftVelocity(tSpawn, entry.pts, _acVel, _tmpA, _tmpB);

                    const barrel = params.barrels[b % params.barrels.length];
                    B.computeMuzzleWorldPos(_pos, _quat, barrel, _muzzle);

                    const sp = B.roundSpread(b, logIdx, vcfg.spreadRad);
                    B.computeBulletVelocity(_quat, _acVel, params.muzzleSpeed, params.elevation, sp.right, sp.up, _vel0);

                    // Analytic ground cutoff so tracers never burrow underground
                    const gHitT = B.groundImpactTime(_muzzle.y, _vel0.y, params.gravity, vcfg.groundY);
                    const effectiveStop = (gHitT != null && gHitT < stopDt) ? gHitT : stopDt;
                    if (dt > effectiveStop + 0.006) continue;

                    const clampedDt = Math.min(dt, effectiveStop);
                    B.evalBallisticPoint(_muzzle, _vel0, params.gravity, clampedDt, _head);
                    B.evalBallisticVel(_vel0, params.gravity, clampedDt, _velNow);

                    const speedNow = _velNow.length();
                    if (speedNow < 1e-4) continue;
                    _dir.copy(_velNow).divideScalar(speedNow);

                    // Clamp tracer length right after muzzle exit so tail never pokes behind barrel
                    const distTraveled = _head.distanceTo(_muzzle);
                    const fade = Math.max(0, 1 - (clampedDt / maxFlight));
                    const len = Math.min(distTraveled, vcfg.tracerLength * (0.7 + 0.3 * fade));
                    if (len < 0.06) continue;

                    const wHalo = vcfg.tracerWidth * (1.75 - 0.35 * (1 - fade));
                    const wCore = vcfg.tracerWidth * 0.72;

                    _qAlign.setFromUnitVectors(_axisZ, _dir);

                    // Outer amber-orange halo
                    _scale.set(wHalo, wHalo, len);
                    _mat4.compose(_head, _qAlign, _scale);
                    pools.tracerHalo.setMatrixAt(tracerCount, _mat4);

                    // Bright incandescent white-gold core
                    _scale.set(wCore, wCore, len * 0.88);
                    _mat4.compose(_head, _qAlign, _scale);
                    pools.tracerCore.setMatrixAt(tracerCount, _mat4);

                    tracerCount++;
                }
            }
        }

        if (pools.tracerHalo) {
            pools.tracerHalo.count = tracerCount;
            pools.tracerHalo.visible = tracerCount > 0;
            if (tracerCount > 0) pools.tracerHalo.instanceMatrix.needsUpdate = true;
        }
        if (pools.tracerCore) {
            pools.tracerCore.count = tracerCount;
            pools.tracerCore.visible = tracerCount > 0;
            if (tracerCount > 0) pools.tracerCore.instanceMatrix.needsUpdate = true;
        }

        // 2) Surface-aware autocannon impact VFX (`type: 'gun_hit'`)
        let sparkCount = 0;
        let flashSlot = 0;
        let puffSlot = 0;

        const minTurn = Math.max(0, turnIdx - 1);
        for (let ti = minTurn; ti <= turnIdx; ti++) {
            const log = battleLogRef[ti];
            if (!log || !Array.isArray(log.vfxTriggers)) continue;
            const turnOffset = (turnIdx - ti) * stepsPerTurn;

            for (let j = 0; j < log.vfxTriggers.length; j++) {
                const trig = log.vfxTriggers[j];
                if (!trig || trig.type !== 'gun_hit' || !trig.pos) continue;

                const ageFrames = turnOffset + (trackIdx - (Number(trig.step) || 0));
                if (ageFrames < 0 || ageFrames > 34) continue;

                const surf = trig.surface || 'aircraft';
                const baseSeed = (Number(trig.seed) || (j * 2654435761 + (Number(trig.step) || 1))) >>> 0;
                const rngFlash = mulberry32((baseSeed ^ 0x9e3779b1) >>> 0);
                const rngPuff = mulberry32((baseSeed ^ 0x85ebca77) >>> 0);
                const rngSpark = mulberry32((baseSeed ^ 0xc2b2ae3d) >>> 0);
                const basePos = trig.pos;

                // Surface normal (default up for ground, toward shooter for aircraft)
                if (trig.normal) {
                    _tmpA.set(trig.normal.x || 0, trig.normal.y || 0, trig.normal.z || 0);
                    if (_tmpA.lengthSq() < 1e-6) _tmpA.set(0, 1, 0);
                    else _tmpA.normalize();
                } else {
                    _tmpA.set(0, 1, 0);
                }

                // Slipstream wind (for aircraft hits)
                if (trig.wind) {
                    _tmpB.set(trig.wind.x || 0, trig.wind.y || 0, trig.wind.z || 0);
                } else {
                    _tmpB.set(0, 0, 0);
                }

                // A) Crisp impact flash star (age 0..5)
                const flashLife = surf === 'aircraft' ? 6 : 5;
                if (ageFrames < flashLife && flashSlot < pools.hitFlashes.length) {
                    const t = ageFrames / flashLife;
                    const fm = pools.hitFlashes[flashSlot++];
                    const fScale = (surf === 'aircraft' ? 0.85 : (surf === 'building' ? 0.72 : 0.62)) * (0.55 + 0.75 * (1 - t));
                    fm.position.set(
                        basePos.x + _tmpA.x * 0.08,
                        surf === 'ground' ? Math.max(vcfg.groundY + fScale * 0.35, basePos.y + 0.12) : basePos.y + _tmpA.y * 0.08,
                        basePos.z + _tmpA.z * 0.08
                    );
                    orientBillboard(fm, rngFlash() * Math.PI * 2);
                    fm.scale.set(fScale, fScale, 1);
                    fm.material.color.setHex(surf === 'aircraft' ? 0xfff3c4 : (surf === 'building' ? 0xffc66e : 0xffaa44));
                    fm.material.opacity = Math.pow(1 - t, 1.45);
                    fm.visible = true;
                }

                // B) Surface-specific smoke / dust / dirt puff
                const puffLife = surf === 'aircraft' ? 22 : (surf === 'building' ? 30 : 28);
                if (ageFrames < puffLife && puffSlot < pools.hitPuffs.length) {
                    const t = ageFrames / puffLife;
                    const pm = pools.hitPuffs[puffSlot++];
                    const ease = 1 - Math.pow(1 - t, 3);

                    if (surf === 'ground') {
                        pm.material.map = textures.groundSpout;
                        const w = (0.45 + 1.35 * ease);
                        const h = (0.75 + 2.05 * ease);
                        pm.position.set(
                            basePos.x + (rngPuff() - 0.5) * 0.25,
                            vcfg.groundY + h * 0.42,
                            basePos.z + (rngPuff() - 0.5) * 0.25
                        );
                        orientBillboard(pm, (rngPuff() - 0.5) * 0.25);
                        pm.scale.set(w, h, 1);
                        pm.material.color.setHex(t < 0.2 ? 0xa6835c : 0x726453);
                        pm.material.opacity = smoothstep(0, 0.1, t) * Math.pow(1 - t, 1.35) * 0.78;
                    } else if (surf === 'building') {
                        pm.material.map = textures.hitPuff;
                        const sz = 0.55 + 1.85 * ease;
                        pm.position.set(
                            basePos.x + _tmpA.x * (0.25 + 1.1 * ease),
                            basePos.y + _tmpA.y * (0.25 + 1.1 * ease) + 0.35 * ease,
                            basePos.z + _tmpA.z * (0.25 + 1.1 * ease)
                        );
                        orientBillboard(pm, rngPuff() * Math.PI * 2 + t * 0.8);
                        pm.scale.set(sz, sz, 1);
                        pm.material.color.setHex(0xb8b2a8);
                        pm.material.opacity = smoothstep(0, 0.1, t) * Math.pow(1 - t, 1.4) * 0.72;
                    } else {
                        // Aircraft hit: charred dark-amber shrapnel smoke streaming aft
                        pm.material.map = textures.hitPuff;
                        const sz = 0.35 + 1.15 * ease;
                        pm.position.set(
                            basePos.x + _tmpB.x * ageFrames * 0.9,
                            basePos.y + _tmpB.y * ageFrames * 0.9,
                            basePos.z + _tmpB.z * ageFrames * 0.9
                        );
                        orientBillboard(pm, rngPuff() * Math.PI * 2 + t * 1.4);
                        pm.scale.set(sz, sz, 1);
                        pm.material.color.setHex(t < 0.25 ? 0x6b3a1c : 0x2c2926);
                        pm.material.opacity = smoothstep(0, 0.08, t) * Math.pow(1 - t, 1.35) * 0.68;
                    }
                    pm.visible = pm.material.opacity > 0.02;
                }

                // C) Analytic O(1) ricochet sparks & shrapnel streaks (InstancedMesh)
                const sparkLife = surf === 'aircraft' ? 16 : 14;
                if (ageFrames < sparkLife) {
                    const nSparks = surf === 'aircraft' ? 10 : (surf === 'building' ? 7 : 6);
                    const t = ageFrames;
                    const lifeFrac = t / sparkLife;
                    const dragK = 0.14;
                    const dragT = (1 - Math.exp(-dragK * t)) / dragK;
                    const grav = surf === 'aircraft' ? 0.007 : 0.014;

                    for (let k = 0; k < nSparks; k++) {
                        if (sparkCount >= MAX_HIT_SPARKS) break;
                        // Random unit hemisphere biased around surface normal
                        let rx = (rngSpark() - 0.5) * 2;
                        let ry = (rngSpark() - 0.5) * 2;
                        let rz = (rngSpark() - 0.5) * 2;
                        const rLen = Math.hypot(rx, ry, rz) || 1;
                        rx /= rLen; ry /= rLen; rz /= rLen;
                        if (rx * _tmpA.x + ry * _tmpA.y + rz * _tmpA.z < 0) {
                            rx = -rx; ry = -ry; rz = -rz;
                        }
                        const spd = (surf === 'aircraft' ? 0.16 : 0.13) * (0.55 + rngSpark() * 1.15);
                        const vx0 = (rx * 0.65 + _tmpA.x * 0.55) * spd;
                        const vy0 = (ry * 0.65 + _tmpA.y * 0.55) * spd;
                        const vz0 = (rz * 0.65 + _tmpA.z * 0.55) * spd;

                        // Analytic position & instantaneous velocity (zero loop!)
                        const expK = Math.exp(-dragK * t);
                        const wx = _tmpB.x * 1.8;
                        const wy = _tmpB.y * 1.8;
                        const wz = _tmpB.z * 1.8;

                        const px = basePos.x + vx0 * dragT + wx * t;
                        let py = basePos.y + vy0 * dragT + wy * t - 0.5 * grav * t * t;
                        const pz = basePos.z + vz0 * dragT + wz * t;
                        if (surf === 'ground' && py < vcfg.groundY + 0.03) py = vcfg.groundY + 0.03;

                        const vxNow = vx0 * expK + wx;
                        const vyNow = vy0 * expK + wy - grav * t;
                        const vzNow = vz0 * expK + wz;
                        const sNow = Math.hypot(vxNow, vyNow, vzNow);
                        if (sNow < 1e-4) continue;

                        _dir.set(vxNow / sNow, vyNow / sNow, vzNow / sNow);
                        _head.set(px, py, pz);
                        _qAlign.setFromUnitVectors(_axisZ, _dir);

                        const fade = Math.max(0, 1 - lifeFrac);
                        const sLen = Math.min(0.95, (0.14 + sNow * 3.4) * fade);
                        const sWid = (surf === 'aircraft' ? 0.055 : 0.048) * (0.5 + 0.5 * fade);
                        _scale.set(sWid, sWid, Math.max(0.06, sLen));
                        _mat4.compose(_head, _qAlign, _scale);
                        pools.hitSparks.setMatrixAt(sparkCount++, _mat4);
                    }
                }
            }
        }

        if (pools.hitSparks) {
            pools.hitSparks.count = sparkCount;
            pools.hitSparks.visible = sparkCount > 0;
            if (sparkCount > 0) pools.hitSparks.instanceMatrix.needsUpdate = true;
        }
    }

    root.AirArenaAutocannonVfx = {
        renderCombatAutocannon,
        hideAll,
        MAX_TRACERS,
        MAX_HIT_SPARKS
    };
})(typeof window !== 'undefined' ? window : globalThis);
