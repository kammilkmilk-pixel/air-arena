// ============================================================================
// scene.js - Three.js viewport, ground, object meshes, picking
// ============================================================================

window.MapEditorScene = (function () {
    const meshById = new Map();
    const gltfCache = new Map();
    let renderer, scene, camera, controls, groundMesh, gridHelper;
    let hemiLight, ambientLight, dirLight, sunVisual;
    let canvas, raycaster, pointer;
    let selectionHelper = null;
    let animId = 0;
    const skyDomeHolder = { mesh: null };
    const battlefieldCenter = new THREE.Vector3(10, 0, 20);

    function colorHex(n) {
        const c = new THREE.Color();
        c.setHex(Number(n) >>> 0);
        return c;
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

    function applyEnvironment(lighting, sky, ground) {
        const L = lighting || {};
        const S = sky || {};
        const g = ground || {};
        battlefieldCenter.set(
            Number(g.centerX != null ? g.centerX : 10),
            0,
            Number(g.centerZ != null ? g.centerZ : 20)
        );

        if (hemiLight) {
            hemiLight.color.setHex((L.hemiSky != null ? L.hemiSky : 0xc4d8ef) >>> 0);
            hemiLight.groundColor.setHex((L.hemiGround != null ? L.hemiGround : 0x5a564c) >>> 0);
            hemiLight.intensity = Number(L.hemiIntensity != null ? L.hemiIntensity : 0.98);
        }
        if (ambientLight) {
            ambientLight.color.setHex((L.ambient != null ? L.ambient : 0xb0bdc8) >>> 0);
            ambientLight.intensity = Number(L.ambientIntensity != null ? L.ambientIntensity : 0.28);
        }

        const sunDir = new THREE.Vector3(
            Number(L.sunDirX != null ? L.sunDirX : -0.55),
            Number(L.sunDirY != null ? L.sunDirY : 0.82),
            Number(L.sunDirZ != null ? L.sunDirZ : -0.35)
        ).normalize();
        if (dirLight) {
            dirLight.color.setHex((L.sunColor != null ? L.sunColor : 0xffefd6) >>> 0);
            dirLight.intensity = Number(L.sunIntensity != null ? L.sunIntensity : 0.58);
            dirLight.position.copy(battlefieldCenter).add(sunDir.clone().multiplyScalar(180));
            dirLight.target.position.copy(battlefieldCenter);
            dirLight.target.updateMatrixWorld();
        }
        if (sunVisual) {
            sunVisual.position.copy(battlefieldCenter).add(sunDir.clone().multiplyScalar(420));
            if (sunVisual.material && sunVisual.material.color) {
                sunVisual.material.color.setHex((L.sunColor != null ? L.sunColor : 0xffefd6) >>> 0);
            }
        }

        if (skyDomeHolder.mesh) {
            scene.remove(skyDomeHolder.mesh);
            disposeObject3D(skyDomeHolder.mesh);
            skyDomeHolder.mesh = null;
        }

        const skyColor = (S.color != null ? S.color : 0x8eb4d4) >>> 0;
        const fogColor = (S.fogColor != null ? S.fogColor : skyColor) >>> 0;
        const fogNear = Number(S.fogNear != null ? S.fogNear : 85);
        const fogFar = Number(S.fogFar != null ? S.fogFar : 540);
        scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);

        if (S.mode === 'texture' && S.texture) {
            const url = window.MapEditorAssets.resolveUrl(S.texture);
            const loader = new THREE.TextureLoader();
            loader.load(
                url,
                (tex) => {
                    tex.encoding = THREE.sRGBEncoding;
                    const radius = Math.max(100, Number(S.radius != null ? S.radius : 800));
                    const dome = new THREE.Mesh(
                        new THREE.SphereGeometry(radius, 48, 32),
                        new THREE.MeshBasicMaterial({
                            map: tex,
                            side: THREE.BackSide,
                            fog: false,
                            depthWrite: false
                        })
                    );
                    dome.name = 'EDITOR_SKY_DOME';
                    dome.position.copy(battlefieldCenter);
                    scene.add(dome);
                    skyDomeHolder.mesh = dome;
                    scene.background = null;
                },
                undefined,
                () => {
                    scene.background = new THREE.Color(skyColor);
                }
            );
        } else {
            scene.background = new THREE.Color(skyColor);
        }
    }

    function createGround(g) {
        if (groundMesh) {
            scene.remove(groundMesh);
            groundMesh.geometry.dispose();
            groundMesh.material.dispose();
        }
        const geo = new THREE.PlaneGeometry(g.width, g.depth);
        const mat = new THREE.MeshStandardMaterial({
            color: colorHex(g.color),
            roughness: 0.98,
            metalness: 0
        });
        groundMesh = new THREE.Mesh(geo, mat);
        groundMesh.name = 'EDITOR_GROUND';
        groundMesh.rotation.x = -Math.PI / 2;
        groundMesh.position.set(g.centerX, -0.02, g.centerZ);
        groundMesh.receiveShadow = true;
        scene.add(groundMesh);

        if (gridHelper) scene.remove(gridHelper);
        gridHelper = new THREE.GridHelper(Math.max(g.width, g.depth), 40, 0x556677, 0x333844);
        gridHelper.position.set(g.centerX, 0, g.centerZ);
        scene.add(gridHelper);
    }

    function tintObject(root, color) {
        if (color == null) return;
        const c = colorHex(color);
        root.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
                if (m && m.color) m.color.copy(c);
            });
        });
    }

    function buildBoxMesh(obj) {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(obj.w, obj.h, obj.d),
            new THREE.MeshStandardMaterial({
                color: colorHex(obj.color != null ? obj.color : 0x2c2c2c),
                roughness: 0.85,
                metalness: 0.05
            })
        );
        mesh.position.set(obj.x, obj.y + obj.h / 2, obj.z);
        mesh.rotation.y = obj.rotY || 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.mapObjectId = obj.id;
        return mesh;
    }

    function loadGlb(obj) {
        const group = new THREE.Group();
        group.userData.mapObjectId = obj.id;
        group.position.set(obj.x, obj.y, obj.z);
        group.rotation.y = obj.rotY || 0;
        group.scale.set(obj.scaleX, obj.scaleY, obj.scaleZ);

        const url = window.MapEditorAssets.resolveUrl(obj.src);
        const apply = (gltfScene) => {
            const clone = gltfScene.clone(true);
            clone.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    child.userData.mapObjectId = obj.id;
                }
            });
            tintObject(clone, obj.color);
            group.clear();
            group.add(clone);
        };

        if (gltfCache.has(url)) {
            apply(gltfCache.get(url));
            return group;
        }

        const loader = new THREE.GLTFLoader();
        loader.load(
            url,
            (gltf) => {
                gltfCache.set(url, gltf.scene);
                apply(gltf.scene);
            },
            undefined,
            (err) => {
                console.warn(`[MapEditor] GLB 載入失敗: ${url}`, err);
                if (window.MapEditorTools) {
                    window.MapEditorTools.setStatus(`GLB 載入失敗：${url}（請用 assets/models/xxx.glb，勿用 C:\\ 路徑）`);
                }
                const placeholder = new THREE.Mesh(
                    new THREE.BoxGeometry(2, 2, 2),
                    new THREE.MeshStandardMaterial({ color: 0xaa4444, wireframe: true })
                );
                placeholder.userData.mapObjectId = obj.id;
                group.clear();
                group.add(placeholder);
            }
        );
        return group;
    }

    function clearMeshes() {
        meshById.forEach((mesh) => {
            scene.remove(mesh);
            mesh.traverse((c) => {
                if (c.geometry) c.geometry.dispose();
                if (c.material) {
                    const mats = Array.isArray(c.material) ? c.material : [c.material];
                    mats.forEach((m) => m && m.dispose && m.dispose());
                }
            });
        });
        meshById.clear();
    }

    function applyObjectTransform(obj) {
        const mesh = meshById.get(obj.id);
        if (!mesh) return;
        if (obj.kind === 'box') {
            mesh.position.set(obj.x, obj.y + obj.h / 2, obj.z);
            mesh.rotation.y = obj.rotY || 0;
            // rebuild geometry if size changed
            const params = mesh.geometry && mesh.geometry.parameters;
            if (!params || params.width !== obj.w || params.height !== obj.h || params.depth !== obj.d) {
                mesh.geometry.dispose();
                mesh.geometry = new THREE.BoxGeometry(obj.w, obj.h, obj.d);
            }
            if (mesh.material && mesh.material.color && obj.color != null) {
                mesh.material.color.setHex(obj.color >>> 0);
            }
        } else {
            mesh.position.set(obj.x, obj.y, obj.z);
            mesh.rotation.y = obj.rotY || 0;
            mesh.scale.set(obj.scaleX, obj.scaleY, obj.scaleZ);
        }
        updateSelectionVisual(window.MapDocument.selectedId);
    }

    function syncFromDoc(doc, reason) {
        if (reason === 'live') {
            const obj = window.MapDocument.getObject(window.MapDocument.selectedId);
            if (obj) applyObjectTransform(obj);
            return;
        }
        if (reason === 'select') {
            updateSelectionVisual(window.MapDocument.selectedId);
            return;
        }
        if (reason === 'meta') return;

        if (reason === 'env' || reason === 'ground' || reason === 'load' || reason === 'set' || reason === 'import' || reason === 'undo' || !reason) {
            applyEnvironment(doc.lighting, doc.sky, doc.ground);
        }

        if (reason === 'env') return;

        createGround(doc.ground);
        const keep = new Set(doc.objects.map((o) => o.id));
        meshById.forEach((mesh, id) => {
            if (!keep.has(id)) {
                scene.remove(mesh);
                meshById.delete(id);
            }
        });

        doc.objects.forEach((obj) => {
            if (meshById.has(obj.id)) {
                scene.remove(meshById.get(obj.id));
                meshById.delete(obj.id);
            }
            const mesh = obj.kind === 'glb' ? loadGlb(obj) : buildBoxMesh(obj);
            meshById.set(obj.id, mesh);
            scene.add(mesh);
        });
        updateSelectionVisual(window.MapDocument.selectedId);
    }

    function updateSelectionVisual(id) {
        if (selectionHelper) {
            scene.remove(selectionHelper);
            selectionHelper = null;
        }
        if (!id || !meshById.has(id)) return;
        const target = meshById.get(id);
        const box = new THREE.Box3().setFromObject(target);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const helper = new THREE.Box3Helper(box, 0x3d9ead);
        selectionHelper = helper;
        scene.add(helper);
        // keep reference center for drag
        helper.userData.center = center.clone();
        helper.userData.size = size.clone();
    }

    function pickObjectId(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const roots = Array.from(meshById.values());
        const hits = raycaster.intersectObjects(roots, true);
        for (let i = 0; i < hits.length; i++) {
            let o = hits[i].object;
            while (o) {
                if (o.userData && o.userData.mapObjectId) return o.userData.mapObjectId;
                o = o.parent;
            }
        }
        return null;
    }

    function pickGroundPoint(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const target = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(plane, target)) return target;
        return null;
    }

    function getMesh(id) {
        return meshById.get(id) || null;
    }

    function init(canvasEl) {
        canvas = canvasEl;
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x8eb4d4);
        scene.fog = new THREE.Fog(0x8eb4d4, 120, 420);

        camera = new THREE.PerspectiveCamera(55, 1, 0.5, 2000);
        camera.position.set(40, 55, 80);

        controls = new THREE.OrbitControls(camera, canvas);
        controls.target.set(10, 0, 20);
        controls.enableDamping = true;
        // Left click = editor tools; right = orbit; wheel/middle = zoom
        controls.mouseButtons = {
            LEFT: -1,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.ROTATE
        };

        hemiLight = new THREE.HemisphereLight(0xc4d8ef, 0x5a564c, 0.98);
        scene.add(hemiLight);
        ambientLight = new THREE.AmbientLight(0xb0bdc8, 0.28);
        scene.add(ambientLight);
        dirLight = new THREE.DirectionalLight(0xffefd6, 0.58);
        dirLight.position.set(40, 80, 20);
        dirLight.castShadow = true;
        scene.add(dirLight);
        scene.add(dirLight.target);
        sunVisual = new THREE.Mesh(
            new THREE.SphereGeometry(12, 24, 12),
            new THREE.MeshBasicMaterial({ color: 0xffe6b8, fog: false, transparent: true, opacity: 0.75 })
        );
        sunVisual.position.set(-80, 160, -40);
        scene.add(sunVisual);

        raycaster = new THREE.Raycaster();
        pointer = new THREE.Vector2();

        createGround(window.MapDocument.doc.ground);
        applyEnvironment(
            window.MapDocument.doc.lighting,
            window.MapDocument.doc.sky,
            window.MapDocument.doc.ground
        );
        resize();
        window.addEventListener('resize', resize);

        function loop() {
            animId = requestAnimationFrame(loop);
            controls.update();
            renderer.render(scene, camera);
        }
        loop();
    }

    function resize() {
        if (!canvas || !renderer) return;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w < 1 || h < 1) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
    }

    function setOrbitEnabled(on) {
        if (controls) controls.enabled = on;
    }

    return {
        init,
        resize,
        syncFromDoc,
        updateSelectionVisual,
        pickObjectId,
        pickGroundPoint,
        getMesh,
        setOrbitEnabled,
        get camera() { return camera; },
        get controls() { return controls; },
        get scene() { return scene; }
    };
})();
