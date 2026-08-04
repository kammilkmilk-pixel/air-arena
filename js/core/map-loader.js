// ============================================================================
// map-loader.js - load authored map JSON, environment (light/sky), and build obstacles
// ============================================================================

window.MapLoader = (function () {
    function defaultLighting() {
        return {
            hemiSky: 0xc4d8ef,
            hemiGround: 0x5a564c,
            hemiIntensity: 0.98,
            ambient: 0xb0bdc8,
            ambientIntensity: 0.28,
            sunColor: 0xffefd6,
            sunIntensity: 0.58,
            sunDirX: -0.55,
            sunDirY: 0.82,
            sunDirZ: -0.35
        };
    }

    function defaultSky() {
        return {
            mode: 'color',
            color: 0x8eb4d4,
            fogColor: 0x8eb4d4,
            fogNear: 85,
            fogFar: 540,
            texture: '',
            radius: 800
        };
    }

    function normalizeObject(raw, index) {
        const kind = raw && raw.kind === 'glb' ? 'glb' : 'box';
        const base = {
            id: (raw && raw.id) || `${kind}_${index}`,
            kind,
            x: Number(raw && raw.x) || 0,
            y: Number(raw && raw.y) || 0,
            z: Number(raw && raw.z) || 0,
            rotY: Number(raw && raw.rotY) || 0,
            color: raw && raw.color != null ? Number(raw.color) : (kind === 'box' ? 0x2c2c2c : null),
            collision: !(raw && raw.collision === false)
        };
        if (kind === 'box') {
            base.w = Math.max(0.1, Number(raw.w) || 4);
            base.d = Math.max(0.1, Number(raw.d) || 4);
            base.h = Math.max(0.1, Number(raw.h) || 10);
        } else {
            base.src = String((raw && raw.src) || (CONFIG.assets && CONFIG.assets.models && CONFIG.assets.models.city) || 'assets/models/city.glb');
            base.scaleX = Math.max(0.001, Number(raw.scaleX != null ? raw.scaleX : 1));
            base.scaleY = Math.max(0.001, Number(raw.scaleY != null ? raw.scaleY : 1));
            base.scaleZ = Math.max(0.001, Number(raw.scaleZ != null ? raw.scaleZ : 1));
        }
        return base;
    }

    function normalizeLighting(raw) {
        const d = defaultLighting();
        const L = raw || {};
        return {
            hemiSky: Number(L.hemiSky != null ? L.hemiSky : d.hemiSky) >>> 0,
            hemiGround: Number(L.hemiGround != null ? L.hemiGround : d.hemiGround) >>> 0,
            hemiIntensity: Number(L.hemiIntensity != null ? L.hemiIntensity : d.hemiIntensity),
            ambient: Number(L.ambient != null ? L.ambient : d.ambient) >>> 0,
            ambientIntensity: Number(L.ambientIntensity != null ? L.ambientIntensity : d.ambientIntensity),
            sunColor: Number(L.sunColor != null ? L.sunColor : d.sunColor) >>> 0,
            sunIntensity: Number(L.sunIntensity != null ? L.sunIntensity : d.sunIntensity),
            sunDirX: Number(L.sunDirX != null ? L.sunDirX : d.sunDirX),
            sunDirY: Number(L.sunDirY != null ? L.sunDirY : d.sunDirY),
            sunDirZ: Number(L.sunDirZ != null ? L.sunDirZ : d.sunDirZ)
        };
    }

    function normalizeSky(raw) {
        const d = defaultSky();
        const S = raw || {};
        const mode = S.mode === 'texture' ? 'texture' : 'color';
        return {
            mode,
            color: Number(S.color != null ? S.color : d.color) >>> 0,
            fogColor: Number(S.fogColor != null ? S.fogColor : d.fogColor) >>> 0,
            fogNear: Number(S.fogNear != null ? S.fogNear : d.fogNear),
            fogFar: Number(S.fogFar != null ? S.fogFar : d.fogFar),
            texture: String(S.texture || ''),
            radius: Math.max(100, Number(S.radius != null ? S.radius : d.radius))
        };
    }

    function normalizeDoc(raw) {
        const g = (raw && raw.ground) || {};
        const doc = {
            version: 1,
            name: String((raw && raw.name) || 'map'),
            ground: {
                width: Number(g.width) || 900,
                depth: Number(g.depth) || 900,
                color: Number(g.color != null ? g.color : 0x4a5440),
                centerX: Number(g.centerX != null ? g.centerX : 10),
                centerZ: Number(g.centerZ != null ? g.centerZ : 20)
            },
            lighting: normalizeLighting(raw && raw.lighting),
            sky: normalizeSky(raw && raw.sky),
            objects: Array.isArray(raw && raw.objects)
                ? raw.objects.map((o, i) => normalizeObject(o, i))
                : []
        };
        // Venue envelope (AO + altitude) — kept on doc; applied via AirArenaArenaEnvelope on load.
        if (raw && (raw.envelope || raw.combatAirspace || raw.altitudeEnvelope)) {
            doc.envelope = raw.envelope || raw.combatAirspace || {};
            if (raw.altitudeEnvelope && !doc.envelope.altitude) {
                doc.envelope.altitude = raw.altitudeEnvelope;
            }
        }
        return doc;
    }

    function fromLegacyBuildings(buildings) {
        return normalizeDoc({
            name: 'legacy-buildings',
            objects: (buildings || []).map((b, i) => ({
                id: `b_legacy_${i}`,
                kind: 'box',
                x: b.x, y: 0, z: b.z,
                w: b.w, d: b.d, h: b.h,
                rotY: b.rotY || 0,
                color: b.color,
                collision: true
            }))
        });
    }

    function applyGround(groundMesh, ground) {
        if (!groundMesh || !ground) return;
        groundMesh.position.set(ground.centerX, groundMesh.position.y, ground.centerZ);
        if (groundMesh.material && groundMesh.material.color) {
            groundMesh.material.color.setHex(ground.color >>> 0);
        }
        if (groundMesh.geometry) {
            groundMesh.geometry.dispose();
            groundMesh.geometry = new THREE.PlaneGeometry(ground.width, ground.depth);
        }
    }

    function disposeObject3D(obj) {
        if (!obj) return;
        obj.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => {
                    if (!m) return;
                    if (m.map) m.map.dispose();
                    m.dispose();
                });
            }
        });
    }

    /**
     * @param {object} ctx
     * @param {THREE.Scene} ctx.scene
     * @param {THREE.HemisphereLight} ctx.hemiLight
     * @param {THREE.AmbientLight} ctx.ambientLight
     * @param {THREE.DirectionalLight} ctx.dirLight
     * @param {THREE.Mesh} [ctx.sunVisual]
     * @param {THREE.Vector3} [ctx.battlefieldCenter]
     * @param {{ mesh: THREE.Mesh|null }} ctx.skyDomeHolder
     * @param {object} lighting
     * @param {object} sky
     * @param {function(string):string} [resolveUrl]
     */
    function applyEnvironment(ctx, lighting, sky, resolveUrl) {
        const L = normalizeLighting(lighting);
        const S = normalizeSky(sky);
        const resolve = resolveUrl || ((p) => p);

        if (ctx.hemiLight) {
            ctx.hemiLight.color.setHex(L.hemiSky);
            ctx.hemiLight.groundColor.setHex(L.hemiGround);
            ctx.hemiLight.intensity = L.hemiIntensity;
        }
        if (ctx.ambientLight) {
            ctx.ambientLight.color.setHex(L.ambient);
            ctx.ambientLight.intensity = L.ambientIntensity;
        }

        const center = ctx.battlefieldCenter || new THREE.Vector3(
            (ctx.ground && ctx.ground.position.x) || 10,
            0,
            (ctx.ground && ctx.ground.position.z) || 20
        );
        const sunDir = new THREE.Vector3(L.sunDirX, L.sunDirY, L.sunDirZ).normalize();
        if (ctx.dirLight) {
            ctx.dirLight.color.setHex(L.sunColor);
            ctx.dirLight.intensity = L.sunIntensity;
            ctx.dirLight.position.copy(center).add(sunDir.clone().multiplyScalar(180));
            if (ctx.dirLight.target) {
                ctx.dirLight.target.position.copy(center);
                ctx.dirLight.target.updateMatrixWorld();
            }
        }
        if (ctx.sunVisual) {
            ctx.sunVisual.position.copy(center).add(sunDir.clone().multiplyScalar(420));
            if (ctx.sunVisual.material && ctx.sunVisual.material.color) {
                ctx.sunVisual.material.color.setHex(L.sunColor);
            }
        }

        if (ctx.skyDomeHolder && ctx.skyDomeHolder.mesh) {
            ctx.scene.remove(ctx.skyDomeHolder.mesh);
            disposeObject3D(ctx.skyDomeHolder.mesh);
            ctx.skyDomeHolder.mesh = null;
        }

        if (S.mode === 'texture' && S.texture) {
            const url = resolve(S.texture);
            const loader = new THREE.TextureLoader();
            loader.load(
                url,
                (tex) => {
                    tex.encoding = THREE.sRGBEncoding;
                    const geo = new THREE.SphereGeometry(S.radius, 48, 32);
                    const mat = new THREE.MeshBasicMaterial({
                        map: tex,
                        side: THREE.BackSide,
                        fog: false,
                        depthWrite: false
                    });
                    const dome = new THREE.Mesh(geo, mat);
                    dome.name = 'MAP_SKY_DOME';
                    dome.position.copy(center);
                    ctx.scene.add(dome);
                    if (ctx.skyDomeHolder) ctx.skyDomeHolder.mesh = dome;
                    ctx.scene.background = null;
                },
                undefined,
                () => {
                    console.warn(`[MapLoader] 天幕貼圖載入失敗: ${url}`);
                    ctx.scene.background = new THREE.Color(S.color);
                }
            );
        } else {
            ctx.scene.background = new THREE.Color(S.color);
        }

        ctx.scene.fog = new THREE.Fog(S.fogColor, S.fogNear, S.fogFar);
    }

    function tintRoot(root, color) {
        if (color == null || !root) return;
        const c = new THREE.Color(color >>> 0);
        root.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (mat && mat.color) mat.color.copy(c);
            });
        });
    }

    function buildBox(obj) {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(obj.w, obj.h, obj.d),
            new THREE.MeshStandardMaterial({
                color: (obj.color != null ? obj.color : 0x2c2c2c) >>> 0,
                roughness: 0.85,
                metalness: 0.05
            })
        );
        mesh.name = obj.id || 'MAP_BOX';
        mesh.position.set(obj.x, obj.y + obj.h / 2, obj.z);
        mesh.rotation.y = obj.rotY || 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.mapObjectId = obj.id;
        mesh.userData.mapCollision = obj.collision !== false;
        return mesh;
    }

    const gltfSourceCache = new Map();

    function prepareGlbMaterials(root) {
        if (!root) return;
        root.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            child.frustumCulled = false;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (!mat) return;
                mat.side = THREE.DoubleSide;
                if (mat.map) mat.map.encoding = THREE.sRGBEncoding;
                if (typeof mat.roughness === 'number') {
                    mat.roughness = Math.min(1, Math.max(mat.roughness, 0.72) + 0.12);
                }
                if (typeof mat.metalness === 'number') {
                    mat.metalness = Math.min(mat.metalness, 0.18);
                }
            });
        });
    }

    function loadGlbObject(obj) {
        return new Promise((resolve) => {
            const group = new THREE.Group();
            group.name = obj.id || 'MAP_GLB';
            group.position.set(obj.x, obj.y, obj.z);
            group.rotation.y = obj.rotY || 0;
            group.scale.set(obj.scaleX, obj.scaleY, obj.scaleZ);
            group.userData.mapObjectId = obj.id;
            group.userData.mapCollision = obj.collision !== false;
            group.frustumCulled = false;

            const applyModel = (sourceScene) => {
                const model = sourceScene.clone(true);
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                        child.frustumCulled = false;
                        child.userData.mapObjectId = obj.id;
                        child.userData.mapCollision = obj.collision !== false;
                    }
                });
                prepareGlbMaterials(model);
                tintRoot(model, obj.color);
                group.add(model);
                resolve(group);
            };

            if (gltfSourceCache.has(obj.src)) {
                applyModel(gltfSourceCache.get(obj.src));
                return;
            }

            const loader = new THREE.GLTFLoader();
            loader.load(
                obj.src,
                (gltf) => {
                    gltfSourceCache.set(obj.src, gltf.scene);
                    applyModel(gltf.scene);
                },
                undefined,
                (err) => {
                    console.warn(`[MapLoader] GLB 載入失敗 (${obj.src})`, err);
                    const placeholder = new THREE.Mesh(
                        new THREE.BoxGeometry(2, 2, 2),
                        new THREE.MeshStandardMaterial({ color: 0xaa4444, wireframe: true })
                    );
                    placeholder.userData.mapCollision = false;
                    group.add(placeholder);
                    resolve(group);
                }
            );
        });
    }

    async function buildMap(doc, scene, obstaclesOut, groundMesh, envCtx) {
        const map = normalizeDoc(doc);
        applyGround(groundMesh, map.ground);
        if (envCtx) {
            applyEnvironment(envCtx, map.lighting, map.sky);
        }
        // Bind venue envelope from this map (diameter/center/bands) — see Arena-Map-Onboarding-Memo.
        if (typeof AirArenaArenaEnvelope !== 'undefined' && AirArenaArenaEnvelope.applyFromMapDoc) {
            AirArenaArenaEnvelope.applyFromMapDoc(map);
        }

        const root = new THREE.Group();
        root.name = 'AUTHORED_MAP_MESH';

        const glbJobs = [];
        map.objects.forEach((obj) => {
            if (obj.kind === 'box') {
                const mesh = buildBox(obj);
                root.add(mesh);
                if (obj.collision !== false) obstaclesOut.push(mesh);
            } else {
                glbJobs.push(
                    loadGlbObject(obj).then((group) => {
                        root.add(group);
                        if (obj.collision !== false) {
                            group.traverse((child) => {
                                if (child.isMesh && child.userData.mapCollision !== false) {
                                    obstaclesOut.push(child);
                                }
                            });
                        }
                    })
                );
            }
        });

        await Promise.all(glbJobs);
        scene.add(root);
        root.updateMatrixWorld(true);
        if (CONFIG.debug) {
            console.log(`[MapLoader] 載入地圖「${map.name}」objects=${map.objects.length} obstacles=${obstaclesOut.length}`);
        }
        return root;
    }

    function fetchMap(url) {
        return fetch(url, { cache: 'no-store' })
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
                return res.json();
            })
            .then((json) => normalizeDoc(json));
    }

    return {
        defaultLighting,
        defaultSky,
        normalizeDoc,
        normalizeLighting,
        normalizeSky,
        fromLegacyBuildings,
        applyGround,
        applyEnvironment,
        disposeObject3D,
        buildMap,
        fetchMap
    };
})();
