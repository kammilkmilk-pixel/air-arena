// ============================================================================
// ground-explosion-vfx.js — Multi-layer 3D ground/surface explosion VFX
//
// Designed to eliminate the flat billboard/ground-plane clipping seam:
//   1. Persistent ground scorch crater decal (polygon-offset, zero Z-fighting)
//   2. Crater ember & ground bounce glow (cools white-orange → deep red)
//   3. Crisp supersonic pressure shockwave ring (subtle, fast-dissipating)
//   4. Dual-ring 3D base-surge ground-contact dust & smoke collar (20 overlapping
//      bottom-feathered, cauliflower-shaded clouds anchored cleanly above ground
//      so no flat cut seam appears from any angle)
//   5. Transient blinding core flash + pooled PointLight scene illumination
//   6. 3D multi-lobe cauliflower fireball (12 lobes, incandescent core → orange
//      → crimson, strictly above ground)
//   7. Tall billowing sunlit-top / charcoal-belly mushroom smoke plume (18 lobes)
//      wrapping and rising out of the fireball, lingering across turn boundary
//   8. 3D ballistic soil/concrete clods & hot shrapnel chunks (InstancedMesh,
//      snappy gravity arc + ground bounce, 100% deterministic for ACMI scrub)
// ============================================================================

(function initGroundExplosionVfx(root) {
    const _v3a = new THREE.Vector3();
    const _qTmp = new THREE.Quaternion();
    const _qZ = new THREE.Quaternion();
    const _axisZ = new THREE.Vector3(0, 0, 1);
    const _euler = new THREE.Euler();
    const _scale = new THREE.Vector3();
    const _mat4 = new THREE.Matrix4();
    const _colA = new THREE.Color();
    const _colB = new THREE.Color();

    const DEFAULTS = {
        enabled: true,
        maxActiveBlasts: 8,
        maxCraters: 28,
        collarCount: 20,
        fireballLobes: 12,
        plumeCount: 18,
        clodCount: 26,
        hotChunkCount: 12,
        groundY: -0.02,
        fireLife: 34,
        collarLife: 138,
        plumeLife: 172,
        shockLife: 13,
        dustWaveLife: 28,
        emberLife: 76,
        clodLife: 62,
        lightIntensity: 5.2,
        lightDistance: 48,
        craterPersistTurns: 12
    };

    function cfg() {
        const v = (typeof CONFIG !== 'undefined' && CONFIG.visuals && CONFIG.visuals.groundExplosion)
            ? CONFIG.visuals.groundExplosion
            : {};
        return Object.assign({}, DEFAULTS, v);
    }

    /** Deterministic fast PRNG (Mulberry32) so ACMI scrubbing is 100% repeatable. */
    function mulberry32(seed) {
        let a = (seed >>> 0) || 0x9e3779b9;
        return function next() {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seedFromTrigger(trigger) {
        if (trigger && Number.isFinite(Number(trigger.seed)) && Number(trigger.seed) !== 0) {
            return (Number(trigger.seed) >>> 0);
        }
        const p = (trigger && trigger.pos) || { x: 0, y: 0, z: 0 };
        const h = (Math.imul(Math.round((p.x || 0) * 100), 73856093)
            ^ Math.imul(Math.round((p.y || 0) * 100), 19349663)
            ^ Math.imul(Math.round((p.z || 0) * 100), 83492791)
            ^ Math.imul(Number(trigger && trigger.step) || 1, 2654435761)) >>> 0;
        return h || 1337;
    }

    function hash2(ix, iy, seed) {
        let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
        n = (n ^ (n >>> 13)) >>> 0;
        n = Math.imul(n, 1274126177) >>> 0;
        return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    }

    function valueNoise2(x, y, seed) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const fx = x - ix;
        const fy = y - iy;
        const ux = fx * fx * (3 - 2 * fx);
        const uy = fy * fy * (3 - 2 * fy);
        const a = hash2(ix, iy, seed);
        const b = hash2(ix + 1, iy, seed);
        const c = hash2(ix, iy + 1, seed);
        const d = hash2(ix + 1, iy + 1, seed);
        return (a + (b - a) * ux) + ((c - a) + (a - b - c + d) * ux) * uy;
    }

    function fbm2(x, y, seed, octaves) {
        let sum = 0;
        let amp = 0.55;
        let freq = 1;
        let norm = 0;
        for (let o = 0; o < octaves; o++) {
            sum += amp * valueNoise2(x * freq, y * freq, seed + o * 31);
            norm += amp;
            amp *= 0.5;
            freq *= 2.05;
        }
        return sum / Math.max(1e-6, norm);
    }

    function smoothstep(e0, e1, x) {
        const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
        return t * t * (3 - 2 * t);
    }

    function easeOutQuart(t) {
        const u = 1 - Math.max(0, Math.min(1, t));
        return 1 - u * u * u * u;
    }

    function easeOutExpo(t) {
        const c = Math.max(0, Math.min(1, t));
        return c >= 1 ? 1 : 1 - Math.pow(2, -7.5 * c);
    }

    const textures = {
        ready: false,
        crater: null,
        ember: null,
        shockRing: null,
        dustRing: null,
        collarSmoke: null,
        plumeSmoke: null,
        fireCore: null,
        flash: null
    };

    function buildTextures() {
        if (textures.ready || typeof document === 'undefined') return;
        textures.ready = true;

        // 1. Ground Scorch Crater Decal (256x256): jagged charcoal pit + radial blast streaks + soil rim
        {
            const S = 256;
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
                    const rays = fbm2(Math.cos(ang) * 5.2 + 4, Math.sin(ang) * 5.2 + 4, 17, 3);
                    const grain = fbm2(nx * 6.5 + 10, ny * 6.5 + 10, 41, 4);
                    const warpedR = r + (rays - 0.5) * 0.28 + (grain - 0.5) * 0.16;

                    const outerMask = 1 - smoothstep(0.36, 0.92, warpedR);
                    const pitMask = 1 - smoothstep(0.06, 0.36, warpedR);
                    const rimMask = smoothstep(0.24, 0.44, warpedR) * (1 - smoothstep(0.46, 0.72, warpedR));
                    const streak = smoothstep(0.55, 0.85, rays) * (1 - smoothstep(0.35, 0.88, r));

                    const rCol = 16 + rimMask * 38 + grain * 14 - pitMask * 12 + streak * 8;
                    const gCol = 15 + rimMask * 31 + grain * 12 - pitMask * 11 + streak * 6;
                    const bCol = 13 + rimMask * 22 + grain * 9 - pitMask * 9 + streak * 4;
                    const alpha = Math.max(0, Math.min(1, outerMask * (0.82 - r * 0.28 + pitMask * 0.22) + streak * 0.24));

                    const idx = (y * S + x) * 4;
                    d[idx] = Math.max(0, Math.min(255, Math.round(rCol)));
                    d[idx + 1] = Math.max(0, Math.min(255, Math.round(gCol)));
                    d[idx + 2] = Math.max(0, Math.min(255, Math.round(bCol)));
                    d[idx + 3] = Math.round(alpha * 255);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.crater = new THREE.CanvasTexture(c);
            textures.crater.needsUpdate = true;
        }

        // 2. Crater Ember / Ground Bounce Glow (128x128, Additive)
        {
            const S = 128;
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
                    const n = fbm2(nx * 5.0 + 2, ny * 5.0 + 2, 73, 3);
                    const glow = Math.pow(Math.max(0, 1 - r), 2.3);
                    const cracks = smoothstep(0.46, 0.72, n) * Math.max(0, 1 - r * 1.15);
                    const v = Math.min(1, glow * 0.82 + cracks * 0.52);
                    const idx = (y * S + x) * 4;
                    d[idx] = 255;
                    d[idx + 1] = Math.round(85 + v * 155);
                    d[idx + 2] = Math.round(12 + v * 90);
                    d[idx + 3] = Math.round(v * 255);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.ember = new THREE.CanvasTexture(c);
            textures.ember.needsUpdate = true;
        }

        // 3. Thin Supersonic Shockwave Pressure Ring (256x256, Additive — crisp, not thick halo)
        {
            const S = 256;
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
                    const wobble = (fbm2(Math.cos(ang) * 5 + 3, Math.sin(ang) * 5 + 3, 91, 2) - 0.5) * 0.035;
                    const rr = r + wobble;
                    // Razor-crisp leading compression lip at 0.89..0.95 with subtle inward wash
                    const outer = 1 - smoothstep(0.89, 0.96, rr);
                    const inner = smoothstep(0.70, 0.89, rr);
                    const ring = outer * Math.pow(inner, 2.6);
                    const idx = (y * S + x) * 4;
                    d[idx] = 255;
                    d[idx + 1] = Math.round(230 + ring * 25);
                    d[idx + 2] = Math.round(195 + ring * 55);
                    d[idx + 3] = Math.round(ring * 235);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.shockRing = new THREE.CanvasTexture(c);
            textures.shockRing.needsUpdate = true;
        }

        // 4. Organic Broken Ground-Scouring Dust Fingers (256x256, NormalBlending)
        {
            const S = 256;
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
                    const streaks = fbm2(Math.cos(ang) * 6.0 + 7, Math.sin(ang) * 6.0 + 7, 131, 3);
                    const tufts = fbm2(nx * 5.8 + 3, ny * 5.8 + 3, 157, 4);
                    const warpedR = r + (streaks - 0.5) * 0.22 + (tufts - 0.5) * 0.14;
                    const outer = 1 - smoothstep(0.45, 0.94, warpedR);
                    const inner = smoothstep(0.14, 0.48, warpedR);
                    const alpha = outer * inner * smoothstep(0.28, 0.78, tufts * 0.65 + streaks * 0.35);
                    const shade = 0.68 + 0.32 * tufts;
                    const idx = (y * S + x) * 4;
                    d[idx] = Math.round(148 * shade);
                    d[idx + 1] = Math.round(132 * shade);
                    d[idx + 2] = Math.round(110 * shade);
                    d[idx + 3] = Math.round(alpha * 195);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.dustRing = new THREE.CanvasTexture(c);
            textures.dustRing.needsUpdate = true;
        }

        // 5. Cauliflower-Shaded Volumetric Cloud Texture (128x128)
        // Multiple sub-lobes + directional top-right sunlight + cool shadowed belly → reads 3D!
        function makeCauliflowerCloudTex(bottomFeather, seed) {
            const S = 128;
            const c = document.createElement('canvas');
            c.width = S; c.height = S;
            const ctx = c.getContext('2d');
            const img = ctx.createImageData(S, S);
            const d = img.data;
            // 5 lumpy sub-puffs give an unmistakable billowing cauliflower silhouette
            const lobes = [
                { x: 0.0, y: 0.05, r: 0.54 },
                { x: -0.28, y: -0.06, r: 0.42 },
                { x: 0.28, y: -0.04, r: 0.42 },
                { x: -0.14, y: 0.24, r: 0.38 },
                { x: 0.16, y: 0.22, r: 0.36 }
            ];
            for (let y = 0; y < S; y++) {
                for (let x = 0; x < S; x++) {
                    const nx = (x / (S - 1)) * 2 - 1;
                    const ny = 1 - (y / (S - 1)) * 2;
                    const n1 = fbm2(nx * 3.4 + 5, ny * 3.4 + 5, seed, 4);
                    const n2 = fbm2(nx * 7.2 + 12, ny * 7.2 + 12, seed + 53, 3);

                    let density = 0;
                    let bestLit = 0.2;
                    for (let k = 0; k < lobes.length; k++) {
                        const lb = lobes[k];
                        const dx = nx - lb.x;
                        const dy = ny - lb.y;
                        const dist = Math.hypot(dx, dy) / lb.r + (n1 - 0.5) * 0.48 + (n2 - 0.5) * 0.18;
                        const a = 1 - smoothstep(0.42, 1.04, dist);
                        if (a > density) density = a;
                        if (a > 0.02) {
                            // Local lobe normal lighting (sun from upper-right)
                            const lLit = 0.46 + (dy / lb.r) * 0.38 + (dx / lb.r) * 0.24;
                            bestLit = Math.max(bestLit, lLit * a);
                        }
                    }

                    let alpha = Math.max(0, Math.min(1, density * (0.78 + 0.35 * n1)));
                    // Smooth edge kill near quad border so quad corners never show
                    const edgeKill = 1 - smoothstep(0.76, 0.98, Math.max(Math.abs(nx), Math.abs(ny)));
                    alpha *= edgeKill;
                    // Soft bottom feather completely erases hard ground-plane clipping seams
                    if (bottomFeather) {
                        const upFrac = (ny + 1) * 0.5;
                        alpha *= smoothstep(0.05, 0.34, upFrac);
                    }

                    // High-contrast sunlit cloud top (245) vs deep shadowed underside (78)
                    const globalSun = 0.42 + ny * 0.34 + nx * 0.16;
                    const shade = Math.max(0, Math.min(1, globalSun * 0.55 + bestLit * 0.45 + (n2 - 0.5) * 0.28));
                    const lum = Math.round(78 + shade * 172);
                    const idx = (y * S + x) * 4;
                    d[idx] = lum;
                    d[idx + 1] = Math.round(lum * 0.97);
                    d[idx + 2] = Math.round(lum * 0.94);
                    d[idx + 3] = Math.round(alpha * 255);
                }
            }
            ctx.putImageData(img, 0, 0);
            const tex = new THREE.CanvasTexture(c);
            tex.needsUpdate = true;
            return tex;
        }

        textures.collarSmoke = makeCauliflowerCloudTex(true, 211);
        textures.plumeSmoke = makeCauliflowerCloudTex(false, 307);

        // 6. Turbulent Billowing Fireball Lobe Texture (128x128)
        // Bright incandescent pockets framed by fiery orange and dark smoky-red crust!
        {
            const S = 128;
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
                    const n1 = fbm2(nx * 3.4 + 8, ny * 3.4 + 8, 409, 4);
                    const n2 = fbm2(nx * 7.0 + 19, ny * 7.0 + 19, 521, 3);
                    const warped = r + (n1 - 0.5) * 0.42 + (n2 - 0.5) * 0.16;
                    const alpha = (1 - smoothstep(0.32, 0.94, warped))
                        * (1 - smoothstep(0.78, 0.98, Math.max(Math.abs(nx), Math.abs(ny))));
                    // Hot incandescent core pockets + turbulent smoky rim
                    const heat = Math.max(0, Math.min(1, 1.06 - warped * 0.98 + (n2 - 0.45) * 0.48));
                    const rr = Math.round(Math.min(255, 70 + Math.pow(heat, 0.65) * 215));
                    const gg = Math.round(Math.min(255, Math.pow(heat, 1.45) * 255));
                    const bb = Math.round(Math.min(255, Math.pow(Math.max(0, heat - 0.48) / 0.52, 1.7) * 245));
                    const idx = (y * S + x) * 4;
                    d[idx] = rr;
                    d[idx + 1] = gg;
                    d[idx + 2] = bb;
                    d[idx + 3] = Math.round(alpha * 255);
                }
            }
            ctx.putImageData(img, 0, 0);
            textures.fireCore = new THREE.CanvasTexture(c);
            textures.fireCore.needsUpdate = true;
        }

        // 7. Intense Radial Flash Core (64x64, Additive)
        {
            const S = 64;
            const c = document.createElement('canvas');
            c.width = S; c.height = S;
            const ctx = c.getContext('2d');
            const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
            g.addColorStop(0.0, 'rgba(255,255,245,1)');
            g.addColorStop(0.20, 'rgba(255,228,145,0.88)');
            g.addColorStop(0.50, 'rgba(255,125,28,0.32)');
            g.addColorStop(1.0, 'rgba(255,50,0,0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, S, S);
            textures.flash = new THREE.CanvasTexture(c);
            textures.flash.needsUpdate = true;
        }
    }

    /** Crisp jagged rock/dirt clod geometry for ballistic ejecta. */
    function createClodGeometry() {
        const geo = new THREE.IcosahedronGeometry(0.11, 0);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const vx = pos.getX(i);
            const vy = pos.getY(i);
            const vz = pos.getZ(i);
            const k = 0.68 + 0.62 * hash2(Math.round(vx * 70), Math.round((vy + vz) * 70), 991);
            pos.setXYZ(i, vx * k, vy * k * 0.78, vz * k);
        }
        geo.computeVertexNormals();
        return geo;
    }

    const pools = {
        ready: false,
        craters: [],
        embers: [],
        shockRings: [],
        dustRings: [],
        flashes: [],
        collarPuffs: [],
        fireLobes: [],
        plumePuffs: [],
        lights: [],
        clodMesh: null,
        hotChunkMesh: null,
        maxClods: 0,
        maxHotChunks: 0
    };

    function ensurePools() {
        if (pools.ready || typeof scene === 'undefined' || !scene) return;
        buildTextures();
        if (!textures.ready) return;
        pools.ready = true;

        const c = cfg();
        const planeGeo = new THREE.PlaneGeometry(1, 1);

        function makeHorizPool(count, tex, opts) {
            const arr = [];
            for (let i = 0; i < count; i++) {
                const mat = new THREE.MeshBasicMaterial({
                    map: tex,
                    color: opts.color || 0xffffff,
                    transparent: true,
                    opacity: 0,
                    blending: opts.blending || THREE.NormalBlending,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                    polygonOffset: !!opts.polygonOffset,
                    polygonOffsetFactor: opts.polygonOffset ? -2 : 0,
                    polygonOffsetUnits: opts.polygonOffset ? -2 : 0,
                    fog: opts.fog !== false
                });
                const m = new THREE.Mesh(planeGeo, mat);
                m.rotation.x = -Math.PI / 2;
                m.visible = false;
                m.frustumCulled = false;
                m.renderOrder = opts.renderOrder || 1;
                scene.add(m);
                arr.push(m);
            }
            return arr;
        }

        function makeBillPool(count, tex, opts) {
            const arr = [];
            for (let i = 0; i < count; i++) {
                const mat = new THREE.MeshBasicMaterial({
                    map: tex,
                    color: opts.color || 0xffffff,
                    transparent: true,
                    opacity: 0,
                    blending: opts.blending || THREE.NormalBlending,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                    fog: opts.fog !== false
                });
                const m = new THREE.Mesh(planeGeo, mat);
                m.visible = false;
                m.frustumCulled = false;
                m.renderOrder = opts.renderOrder || 3;
                scene.add(m);
                arr.push(m);
            }
            return arr;
        }

        pools.craters = makeHorizPool(c.maxCraters, textures.crater, {
            renderOrder: 1, polygonOffset: true, fog: true
        });
        pools.embers = makeHorizPool(c.maxActiveBlasts, textures.ember, {
            blending: THREE.AdditiveBlending, renderOrder: 2, polygonOffset: true, fog: false
        });
        pools.dustRings = makeHorizPool(c.maxActiveBlasts, textures.dustRing, {
            renderOrder: 2, fog: true
        });
        pools.shockRings = makeHorizPool(c.maxActiveBlasts, textures.shockRing, {
            blending: THREE.AdditiveBlending, renderOrder: 3, fog: false
        });
        pools.flashes = makeBillPool(c.maxActiveBlasts, textures.flash, {
            blending: THREE.AdditiveBlending, renderOrder: 8, fog: false
        });

        pools.collarPuffs = makeBillPool(c.maxActiveBlasts * c.collarCount, textures.collarSmoke, {
            renderOrder: 4, fog: true
        });
        pools.plumePuffs = makeBillPool(c.maxActiveBlasts * c.plumeCount, textures.plumeSmoke, {
            renderOrder: 5, fog: true
        });
        pools.fireLobes = makeBillPool(c.maxActiveBlasts * c.fireballLobes, textures.fireCore, {
            blending: THREE.NormalBlending, renderOrder: 6, fog: false
        });

        // Pre-allocate 3 PointLights at intensity 0 so adding a blast never recompiles shaders.
        for (let i = 0; i < 3; i++) {
            const lt = new THREE.PointLight(0xff9c3b, 0, c.lightDistance, 1.6);
            lt.visible = false;
            scene.add(lt);
            pools.lights.push(lt);
        }

        const clodGeo = createClodGeometry();
        pools.maxClods = c.maxActiveBlasts * c.clodCount;
        const clodMat = new THREE.MeshStandardMaterial({
            color: 0x3b3329,
            roughness: 0.96,
            metalness: 0.04
        });
        pools.clodMesh = new THREE.InstancedMesh(clodGeo, clodMat, pools.maxClods);
        pools.clodMesh.count = 0;
        pools.clodMesh.frustumCulled = false;
        pools.clodMesh.visible = false;
        scene.add(pools.clodMesh);

        pools.maxHotChunks = c.maxActiveBlasts * c.hotChunkCount;
        const hotMat = new THREE.MeshBasicMaterial({
            color: 0xff922b,
            fog: false
        });
        pools.hotChunkMesh = new THREE.InstancedMesh(clodGeo, hotMat, pools.maxHotChunks);
        pools.hotChunkMesh.count = 0;
        pools.hotChunkMesh.frustumCulled = false;
        pools.hotChunkMesh.visible = false;
        scene.add(pools.hotChunkMesh);
    }

    function orientBillboard(mesh, zRot) {
        if (typeof camera === 'undefined' || !camera) return;
        mesh.quaternion.copy(camera.quaternion);
        if (zRot) {
            _qZ.setFromAxisAngle(_axisZ, zRot);
            mesh.quaternion.multiply(_qZ);
        }
    }

    function hideAllPools(keepCraters) {
        if (!pools.ready) return;
        if (!keepCraters) pools.craters.forEach((m) => { m.visible = false; });
        pools.embers.forEach((m) => { m.visible = false; });
        pools.shockRings.forEach((m) => { m.visible = false; });
        pools.dustRings.forEach((m) => { m.visible = false; });
        pools.flashes.forEach((m) => { m.visible = false; });
        pools.collarPuffs.forEach((m) => { m.visible = false; });
        pools.plumePuffs.forEach((m) => { m.visible = false; });
        pools.fireLobes.forEach((m) => { m.visible = false; });
        pools.lights.forEach((lt) => { lt.intensity = 0; lt.visible = false; });
        if (pools.clodMesh) { pools.clodMesh.count = 0; pools.clodMesh.visible = false; }
        if (pools.hotChunkMesh) { pools.hotChunkMesh.count = 0; pools.hotChunkMesh.visible = false; }
    }

    function isGroundExplosionTrigger(trigger) {
        if (!trigger || !trigger.pos) return false;
        if (trigger.type === 'ground_explosion') return true;
        if (trigger.type === 'explosion' && Number(trigger.pos.y) <= 1.8) return true;
        return false;
    }

    function isSurfaceGround(trigger) {
        if (!trigger || !trigger.pos) return false;
        if (trigger.surface === 'building') return false;
        if (trigger.surface === 'ground') return true;
        return Number(trigger.pos.y) <= 1.8;
    }

    function computeBlastSpec(trigger) {
        const isGround = isSurfaceGround(trigger);
        const rawScale = Number(trigger && trigger.scale);
        const scale = Number.isFinite(rawScale) && rawScale > 0
            ? (trigger.type === 'ground_explosion' ? rawScale : Math.max(0.7, Math.min(1.6, rawScale * 0.52)))
            : 1.0;
        const rawR = Number(trigger && trigger.radius);
        const radius = Number.isFinite(rawR) && rawR > 0 ? rawR : (scale * 6.5);
        return { isGround, scale, radius };
    }

    let lastRenderMode = '';
    let lastPlanningLen = -1;

    function renderGroundExplosions(battleLogRef, turnIdx, trackIdx) {
        lastRenderMode = 'combat';
        lastPlanningLen = -1;
        const c = cfg();
        if (!c.enabled) {
            hideAllPools(false);
            return;
        }
        ensurePools();
        if (!pools.ready) return;

        hideAllPools(false);
        if (!Array.isArray(battleLogRef) || !battleLogRef.length || turnIdx < 0) return;

        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? Number(CONFIG.rules.stepsPerTurn) : 100;
        const groundY = Number(c.groundY);

        let craterSlot = 0;
        let activeIdx = 0;
        let collarIdx = 0;
        let fireIdx = 0;
        let plumeIdx = 0;
        let clodIdx = 0;
        let hotIdx = 0;
        let lightIdx = 0;

        const minCraterTurn = Math.max(0, turnIdx - c.craterPersistTurns);
        const activeBlasts = [];

        for (let ti = minCraterTurn; ti <= turnIdx; ti++) {
            const log = battleLogRef[ti];
            if (!log || !Array.isArray(log.vfxTriggers)) continue;
            const turnOffset = (turnIdx - ti) * stepsPerTurn;

            for (let j = 0; j < log.vfxTriggers.length; j++) {
                const trig = log.vfxTriggers[j];
                if (!isGroundExplosionTrigger(trig)) continue;

                const ageFrames = turnOffset + (trackIdx - (Number(trig.step) || 0));
                if (ageFrames < 0) continue;

                const spec = computeBlastSpec(trig);
                const seed = seedFromTrigger(trig);

                // Layer 1: Persistent ground scorch crater
                if (spec.isGround && craterSlot < pools.craters.length) {
                    const m = pools.craters[craterSlot++];
                    const grow = smoothstep(0, 5, ageFrames);
                    const craterDiam = spec.radius * (0.95 + 0.45 * grow);
                    const turnFade = ti === minCraterTurn && (turnIdx - ti) >= c.craterPersistTurns
                        ? 0.45 : 1.0;
                    m.position.set(trig.pos.x, groundY + 0.03 + (craterSlot % 5) * 0.002, trig.pos.z);
                    m.rotation.set(-Math.PI / 2, 0, (seed % 628) * 0.01);
                    m.scale.set(craterDiam, craterDiam, 1);
                    m.material.opacity = 0.88 * grow * turnFade;
                    m.visible = true;
                }

                if (ageFrames <= c.plumeLife + 10) {
                    activeBlasts.push({ trig, ageFrames, spec, seed });
                }
            }
        }

        activeBlasts.sort((a, b) => a.ageFrames - b.ageFrames);
        const blastCount = Math.min(activeBlasts.length, c.maxActiveBlasts);

        for (let b = 0; b < blastCount; b++) {
            const { trig, ageFrames, spec, seed } = activeBlasts[b];
            const rng = mulberry32(seed);
            const s = spec.scale;
            const R = spec.radius;
            const baseX = trig.pos.x;
            const baseZ = trig.pos.z;
            const baseY = spec.isGround ? groundY : trig.pos.y;
            const slot = activeIdx++;

            // -----------------------------------------------------------------
            // Layer 2: Crater Ember & Ground Bounce Glow
            // -----------------------------------------------------------------
            if (spec.isGround && ageFrames < c.emberLife && slot < pools.embers.length) {
                const t = ageFrames / c.emberLife;
                const m = pools.embers[slot];
                const pulse = 0.92 + 0.08 * Math.sin(ageFrames * 0.55 + seed);
                const diam = R * (0.52 + 0.65 * easeOutQuart(Math.min(1, ageFrames / 10)));
                m.position.set(baseX, groundY + 0.055, baseZ);
                m.rotation.set(-Math.PI / 2, 0, (seed % 314) * 0.02);
                m.scale.set(diam, diam, 1);
                if (t < 0.14) {
                    m.material.color.setHex(0xfff1c4);
                } else {
                    _colA.setHex(0xff841c);
                    _colB.setHex(0x8c1805);
                    m.material.color.copy(_colA).lerp(_colB, smoothstep(0.14, 0.85, t));
                }
                m.material.opacity = Math.pow(1 - t, 1.6) * 0.88 * pulse;
                m.visible = m.material.opacity > 0.015;
            }

            // -----------------------------------------------------------------
            // Layer 3: Subtle Crisp Shockwave Lip + Organic Dust Sweep Fingers
            // -----------------------------------------------------------------
            if (spec.isGround && ageFrames < c.shockLife && slot < pools.shockRings.length) {
                const t = ageFrames / c.shockLife;
                const m = pools.shockRings[slot];
                const diam = R * (0.45 + 2.15 * easeOutQuart(t));
                m.position.set(baseX, groundY + 0.085, baseZ);
                m.rotation.set(-Math.PI / 2, 0, rng() * Math.PI * 2);
                m.scale.set(diam, diam, 1);
                m.material.color.setHex(t < 0.35 ? 0xffe9ba : 0xd8a878);
                m.material.opacity = Math.pow(1 - t, 1.65) * 0.42;
                m.visible = m.material.opacity > 0.015;
            }
            if (spec.isGround && ageFrames >= 1 && ageFrames < c.dustWaveLife && slot < pools.dustRings.length) {
                const t = (ageFrames - 1) / (c.dustWaveLife - 1);
                const m = pools.dustRings[slot];
                const diam = R * (0.55 + 1.55 * easeOutQuart(t));
                m.position.set(baseX, groundY + 0.075, baseZ);
                m.rotation.set(-Math.PI / 2, 0, rng() * Math.PI * 2);
                m.scale.set(diam, diam, 1);
                m.material.color.setHex(0x7c6e5b);
                m.material.opacity = smoothstep(0, 0.14, t) * Math.pow(1 - t, 1.5) * 0.44;
                m.visible = m.material.opacity > 0.015;
            }

            // -----------------------------------------------------------------
            // Layer 4: Dual-Ring 3D Base-Surge Ground-Contact Dust & Smoke Collar
            // Inner skirt hugs the crater rim (seals the base); outer surge rolls
            // radially across the terrain with overlapping cauliflower puffs.
            // -----------------------------------------------------------------
            if (spec.isGround && ageFrames < c.collarLife) {
                const innerCount = Math.floor(c.collarCount * 0.4); // 8 inner crater-hug puffs
                const outerCount = c.collarCount - innerCount;      // 12 outer rolling surge puffs
                for (let i = 0; i < c.collarCount; i++) {
                    if (collarIdx >= pools.collarPuffs.length) break;
                    const isInner = i < innerCount;
                    const ringIdx = isInner ? i : (i - innerCount);
                    const ringN = isInner ? innerCount : outerCount;
                    const ang = (ringIdx / ringN) * Math.PI * 2 + (isInner ? 0.25 : 0) + (rng() - 0.5) * 0.32;
                    const delay = isInner ? Math.floor(rng() * 2.5) : (1 + Math.floor(rng() * 4));
                    const speedMul = 0.82 + rng() * 0.36;
                    const sizeMul = 0.85 + rng() * 0.42;
                    const spin0 = (rng() - 0.5) * 0.38; // small tilt keeps bottom-feather aligned to ground
                    const liftMul = 0.7 + rng() * 0.55;

                    const localAge = ageFrames - delay;
                    if (localAge < 0 || localAge >= c.collarLife) continue;
                    const t = localAge / c.collarLife;
                    const m = pools.collarPuffs[collarIdx++];

                    const radialDist = isInner
                        ? R * (0.06 + 0.34 * easeOutExpo(t * 1.3) * speedMul)
                        : R * (0.18 + 0.64 * easeOutExpo(t * 1.55) * speedMul);
                    const sizeX = (isInner ? (2.4 + 3.8 * easeOutQuart(t)) : (2.1 + 4.3 * easeOutQuart(t))) * s * sizeMul;
                    const squash = isInner
                        ? (0.76 + 0.20 * smoothstep(0.1, 0.8, t))
                        : (0.64 + 0.28 * smoothstep(0.15, 0.85, t));
                    const sizeY = sizeX * squash;
                    const lift = smoothstep(0.22, 1.0, t) * (isInner ? 1.85 : 1.25) * s * liftMul;
                    const py = groundY + sizeY * 0.39 + lift;

                    const windX = t * t * 1.5 * s;
                    const windZ = t * t * 0.65 * s;

                    m.position.set(
                        baseX + Math.cos(ang) * radialDist + windX,
                        py,
                        baseZ + Math.sin(ang) * radialDist + windZ
                    );
                    orientBillboard(m, spin0);
                    m.scale.set(sizeX, sizeY, 1);

                    // Fire-lit dusty ochre early -> warm taupe earth smoke -> soft weathered grey
                    if (t < 0.18) {
                        _colA.setHex(isInner ? 0xeb9244 : 0xc68854);
                        _colB.setHex(isInner ? 0x625548 : 0x827462);
                        m.material.color.copy(_colA).lerp(_colB, t / 0.18);
                    } else {
                        _colA.setHex(isInner ? 0x625548 : 0x827462);
                        _colB.setHex(0x55504a);
                        m.material.color.copy(_colA).lerp(_colB, smoothstep(0.18, 0.82, t));
                    }
                    const fadeIn = smoothstep(0, 0.04, t);
                    const fadeOut = Math.pow(1 - t, 1.38);
                    m.material.opacity = fadeIn * fadeOut * (isInner ? 0.86 : 0.78);
                    m.visible = m.material.opacity > 0.015;
                }
            }

            // -----------------------------------------------------------------
            // Layer 5: Instant Blinding Core Flash + Pooled Scene PointLight
            // -----------------------------------------------------------------
            if (ageFrames < 11 && slot < pools.flashes.length) {
                const t = ageFrames / 11;
                const m = pools.flashes[slot];
                const diam = (3.8 + 4.4 * easeOutQuart(t)) * s;
                m.position.set(baseX, baseY + Math.max(0.95 * s, diam * 0.34), baseZ);
                orientBillboard(m, rng() * Math.PI * 2);
                m.scale.set(diam, diam, 1);
                m.material.opacity = Math.pow(1 - t, 2.0) * 0.92;
                m.visible = m.material.opacity > 0.02;
            }
            if (ageFrames < 22 && lightIdx < pools.lights.length) {
                const t = ageFrames / 22;
                const lt = pools.lights[lightIdx++];
                lt.position.set(baseX, baseY + 2.2 * s, baseZ);
                lt.intensity = c.lightIntensity * Math.pow(1 - t, 2.1) * Math.min(1.4, s);
                lt.distance = c.lightDistance * Math.max(0.75, s);
                lt.color.setHex(t < 0.22 ? 0xffe4a0 : 0xff8c28);
                lt.visible = lt.intensity > 0.05;
            }

            // -----------------------------------------------------------------
            // Layer 6: 3D Multi-Lobe Cauliflower Rising Fireball (12 lobes)
            // -----------------------------------------------------------------
            if (ageFrames < c.fireLife) {
                for (let i = 0; i < c.fireballLobes; i++) {
                    if (fireIdx >= pools.fireLobes.length) break;
                    const isCore = i < 4;
                    const ang = (i / Math.max(1, c.fireballLobes - 4)) * Math.PI * 2 + rng() * 0.75;
                    const delay = isCore ? i * 0.9 : Math.floor(rng() * 3.8);
                    const spread = isCore ? (0.18 + rng() * 0.38) : (0.65 + rng() * 0.92);
                    const riseSpeed = isCore ? (2.8 + i * 1.1) : (1.15 + rng() * 1.85);
                    const sizeMul = isCore ? (1.35 - i * 0.1) : (0.95 + rng() * 0.5);
                    const rot0 = rng() * Math.PI * 2;
                    const rotSpd = (rng() - 0.5) * 0.065;

                    const localAge = ageFrames - delay;
                    if (localAge < 0 || localAge >= c.fireLife) continue;
                    const t = localAge / c.fireLife;
                    const m = pools.fireLobes[fireIdx++];

                    const expand = easeOutQuart(t);
                    const diam = (1.65 + 3.55 * expand) * s * sizeMul;
                    const rOff = spread * (0.45 + 1.55 * expand) * s;
                    const rawY = baseY + (0.65 + riseSpeed * easeOutQuart(t * 1.12)) * s;
                    const minY = spec.isGround ? (groundY + diam * 0.42) : rawY;

                    m.position.set(
                        baseX + Math.cos(ang) * rOff,
                        Math.max(minY, rawY),
                        baseZ + Math.sin(ang) * rOff
                    );
                    orientBillboard(m, rot0 + localAge * rotSpd);
                    m.scale.set(diam, diam, 1);

                    // Blackbody cooling: white-gold -> vivid flame orange -> deep ember crimson -> soot
                    if (t < 0.24) {
                        _colA.setHex(0xfff6d2);
                        _colB.setHex(0xff9c24);
                        m.material.color.copy(_colA).lerp(_colB, t / 0.24);
                    } else if (t < 0.65) {
                        _colA.setHex(0xff9c24);
                        _colB.setHex(0xd4360a);
                        m.material.color.copy(_colA).lerp(_colB, (t - 0.24) / 0.41);
                    } else {
                        _colA.setHex(0xd4360a);
                        _colB.setHex(0x3a1c12);
                        m.material.color.copy(_colA).lerp(_colB, (t - 0.65) / 0.35);
                    }
                    const fadeIn = smoothstep(0, 0.06, t);
                    const fadeOut = Math.pow(1 - t, 1.32);
                    m.material.opacity = fadeIn * fadeOut * 0.94;
                    m.visible = m.material.opacity > 0.015;
                }
            }

            // -----------------------------------------------------------------
            // Layer 7: Tall Sculptural Sun-Lit / Dark-Belly Mushroom Smoke Plume
            // -----------------------------------------------------------------
            if (ageFrames >= 2 && ageFrames < c.plumeLife) {
                const stemN = 7;
                for (let i = 0; i < c.plumeCount; i++) {
                    if (plumeIdx >= pools.plumePuffs.length) break;
                    const isCap = i >= stemN;
                    const capIdx = i - stemN;
                    const ang = isCap
                        ? (capIdx / Math.max(1, c.plumeCount - stemN)) * Math.PI * 2 + (rng() - 0.5) * 0.42
                        : (i / stemN) * Math.PI * 2 + rng() * 0.6;
                    const delay = isCap ? (3 + Math.floor(rng() * 9)) : (2 + i * 1.8);
                    const sizeMul = isCap ? (1.15 + rng() * 0.55) : (0.95 + rng() * 0.42);
                    const targetH = isCap ? (4.6 + rng() * 4.8) : (0.9 + i * 0.78 + rng() * 0.55);
                    const capSpread = isCap ? (1.65 + rng() * 2.45) : (0.45 + rng() * 0.65);
                    const rot0 = (rng() - 0.5) * 0.75; // keep sunlit tops facing skyward!
                    const rotSpd = (rng() - 0.5) * 0.018;

                    const localAge = ageFrames - delay;
                    if (localAge < 0 || localAge >= c.plumeLife) continue;
                    const t = localAge / c.plumeLife;
                    const m = pools.plumePuffs[plumeIdx++];

                    const riseCurve = easeOutQuart(Math.min(1, t * 1.12));
                    const diam = (2.1 + (isCap ? 5.6 : 3.8) * easeOutQuart(t)) * s * sizeMul;
                    const spreadCurve = isCap
                        ? smoothstep(0.05, 0.72, t) * capSpread * s
                        : (0.28 + 0.72 * t) * capSpread * s;
                    const rawY = baseY + (0.75 + targetH * riseCurve) * s;
                    const minY = spec.isGround ? (groundY + diam * 0.43) : rawY;

                    const windX = Math.pow(t, 1.55) * (isCap ? 3.6 : 1.7) * s;
                    const windZ = Math.pow(t, 1.55) * (isCap ? 1.5 : 0.7) * s;

                    m.position.set(
                        baseX + Math.cos(ang) * spreadCurve + windX,
                        Math.max(minY, rawY),
                        baseZ + Math.sin(ang) * spreadCurve + windZ
                    );
                    orientBillboard(m, rot0 + localAge * rotSpd);
                    m.scale.set(diam, diam * (isCap ? 0.88 : 1.02), 1);

                    // Fire-warmed soot early -> textured dark-warm charcoal (NOT flat black) -> sunlit grey-taupe
                    if (t < 0.14) {
                        _colA.setHex(0x884824);
                        _colB.setHex(0x47413c);
                        m.material.color.copy(_colA).lerp(_colB, t / 0.14);
                    } else {
                        _colA.setHex(isCap ? 0x4b4642 : 0x3c3733);
                        _colB.setHex(0x6e6963);
                        m.material.color.copy(_colA).lerp(_colB, smoothstep(0.14, 0.88, t));
                    }
                    const fadeIn = smoothstep(0, 0.07, t);
                    const fadeOut = Math.pow(1 - t, 1.32);
                    m.material.opacity = fadeIn * fadeOut * (isCap ? 0.88 : 0.84);
                    m.visible = m.material.opacity > 0.015;
                }
            }

            // -----------------------------------------------------------------
            // Layer 8: 3D Ballistic Dirt Clods & Hot Shrapnel (InstancedMesh)
            // Crisp ballistic gravity arc + ground bounce + settle
            // -----------------------------------------------------------------
            if (ageFrames < c.clodLife) {
                const g = 0.025;
                const fillChunks = (count, isHot) => {
                    for (let i = 0; i < count; i++) {
                        if (!isHot && clodIdx >= pools.maxClods) break;
                        if (isHot && hotIdx >= pools.maxHotChunks) break;

                        const ang = rng() * Math.PI * 2;
                        const horizSpd = (0.08 + rng() * 0.25) * s * (isHot ? 1.25 : 1.0);
                        const upSpd = (0.18 + rng() * 0.34) * s * (isHot ? 1.15 : 1.0);
                        const sz = (isHot ? (0.42 + rng() * 0.55) : (0.55 + rng() * 0.95)) * s;
                        const rx = rng() * 6.28, ry = rng() * 6.28, rz = rng() * 6.28;
                        const rsx = (rng() - 0.5) * 0.42;
                        const rsy = (rng() - 0.5) * 0.42;
                        const lifeLim = isHot ? c.clodLife * 0.52 : c.clodLife;

                        if (ageFrames >= lifeLim) continue;
                        const t = ageFrames;
                        const dragT = (1 - Math.exp(-0.028 * t)) / 0.028;
                        let px = baseX + Math.cos(ang) * horizSpd * dragT;
                        let pz = baseZ + Math.sin(ang) * horizSpd * dragT;
                        let py = baseY + 0.22 + upSpd * t - 0.5 * g * t * t;

                        const floorY = groundY + 0.06 * sz;
                        if (spec.isGround && py < floorY) {
                            const tHit = (upSpd + Math.sqrt(Math.max(0, upSpd * upSpd + 2 * g * 0.22))) / g;
                            const dtAfter = Math.max(0, t - tHit);
                            const bounceV = upSpd * 0.24;
                            const py2 = floorY + bounceV * dtAfter - 0.5 * g * dtAfter * dtAfter;
                            py = Math.max(floorY, py2);
                            const extraDrag = Math.exp(-0.14 * dtAfter);
                            px = baseX + Math.cos(ang) * horizSpd * (tHit * 0.76 + dtAfter * 0.20 * extraDrag);
                            pz = baseZ + Math.sin(ang) * horizSpd * (tHit * 0.76 + dtAfter * 0.20 * extraDrag);
                        }

                        const shrink = 1 - smoothstep(lifeLim * 0.65, lifeLim, t);
                        if (shrink <= 0.02) continue;

                        _v3a.set(px, py, pz);
                        _euler.set(rx + t * rsx, ry + t * rsy, rz);
                        _qTmp.setFromEuler(_euler);
                        _scale.setScalar(sz * shrink);
                        _mat4.compose(_v3a, _qTmp, _scale);

                        if (isHot) {
                            pools.hotChunkMesh.setMatrixAt(hotIdx++, _mat4);
                        } else {
                            pools.clodMesh.setMatrixAt(clodIdx++, _mat4);
                        }
                    }
                };
                fillChunks(c.clodCount, false);
                fillChunks(c.hotChunkCount, true);
            }
        }

        if (pools.clodMesh) {
            pools.clodMesh.count = clodIdx;
            pools.clodMesh.visible = clodIdx > 0;
            if (clodIdx > 0) pools.clodMesh.instanceMatrix.needsUpdate = true;
        }
        if (pools.hotChunkMesh) {
            pools.hotChunkMesh.count = hotIdx;
            pools.hotChunkMesh.visible = hotIdx > 0;
            if (hotIdx > 0) pools.hotChunkMesh.instanceMatrix.needsUpdate = true;
        }
    }

    function syncPlanningCraters(battleLogRef) {
        const len = Array.isArray(battleLogRef) ? battleLogRef.length : 0;
        if (lastRenderMode === 'planning' && lastPlanningLen === len) return;
        lastRenderMode = 'planning';
        lastPlanningLen = len;

        const c = cfg();
        if (!c.enabled) {
            hideAllPools(false);
            return;
        }
        ensurePools();
        if (!pools.ready) return;

        hideAllPools(false);
        if (!Array.isArray(battleLogRef) || !battleLogRef.length) return;

        const groundY = Number(c.groundY);
        const turnIdx = battleLogRef.length - 1;
        const minTurn = Math.max(0, turnIdx - c.craterPersistTurns);
        let craterSlot = 0;

        for (let ti = minTurn; ti <= turnIdx; ti++) {
            const log = battleLogRef[ti];
            if (!log || !Array.isArray(log.vfxTriggers)) continue;
            for (let j = 0; j < log.vfxTriggers.length; j++) {
                const trig = log.vfxTriggers[j];
                if (!isGroundExplosionTrigger(trig)) continue;
                const spec = computeBlastSpec(trig);
                if (!spec.isGround || craterSlot >= pools.craters.length) continue;

                const seed = seedFromTrigger(trig);
                const m = pools.craters[craterSlot++];
                const craterDiam = spec.radius * 1.4;
                m.position.set(trig.pos.x, groundY + 0.03 + (craterSlot % 5) * 0.002, trig.pos.z);
                m.rotation.set(-Math.PI / 2, 0, (seed % 628) * 0.01);
                m.scale.set(craterDiam, craterDiam, 1);
                m.material.opacity = 0.86;
                m.visible = true;
            }
        }
    }

    function clearAll() {
        lastRenderMode = '';
        lastPlanningLen = -1;
        hideAllPools(false);
    }

    root.AirArenaGroundExplosionVfx = {
        renderGroundExplosions,
        syncPlanningCraters,
        clearAll,
        isGroundExplosionTrigger,
        isSurfaceGround,
        computeBlastSpec,
        seedFromTrigger,
        cfg
    };
})(typeof window !== 'undefined' ? window : globalThis);
