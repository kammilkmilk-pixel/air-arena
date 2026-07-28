// ============================================================================
// fallbacks.js - 資源缺失時的程序化替代方案
// ============================================================================

window.AssetFallbacks = {
    createFlipbookPlaceholder() {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'rgba(255, 220, 120, 0.95)');
        grad.addColorStop(0.5, 'rgba(255, 80, 0, 0.6)');
        grad.addColorStop(1, 'rgba(40, 40, 40, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 64);
        const tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        return tex;
    },

    createProceduralAircraftGltf(colorHex) {
        const group = new THREE.Group();
        const color = new THREE.Color(colorHex);

        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.18, 1.4, 10),
            new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.6 })
        );
        body.rotation.x = Math.PI / 2;
        group.add(body);

        const nose = new THREE.Mesh(
            new THREE.ConeGeometry(0.12, 0.35, 10),
            new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.3, roughness: 0.4 })
        );
        nose.rotation.x = Math.PI / 2;
        nose.position.z = 0.85;
        group.add(nose);

        const wing = new THREE.Mesh(
            new THREE.BoxGeometry(1.6, 0.03, 0.35),
            new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.7 })
        );
        wing.position.set(0, 0, 0.05);
        group.add(wing);

        const tail = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.03, 0.25),
            new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.7 })
        );
        tail.position.set(0, 0.18, -0.55);
        group.add(tail);

        const vTail = new THREE.Mesh(
            new THREE.BoxGeometry(0.03, 0.28, 0.22),
            new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.7 })
        );
        vTail.position.set(0, 0.18, -0.62);
        group.add(vTail);

        return { scene: group };
    },

    buildProceduralCity(scene, obstacles) {
        const cityGroup = new THREE.Group();
        cityGroup.name = 'PROCEDURAL_CITY_MESH';
        const buildings = (CONFIG.map && CONFIG.map.buildings) ? CONFIG.map.buildings : [];

        buildings.forEach((b) => {
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(b.w, b.h, b.d),
                new THREE.MeshStandardMaterial({ color: b.color || 0x2c2c2c, roughness: 0.85, metalness: 0.05 })
            );
            mesh.position.set(b.x, b.h / 2, b.z);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            cityGroup.add(mesh);
            obstacles.push(mesh);
        });

        scene.add(cityGroup);
        console.warn(`🏙️ 使用 CONFIG.map.buildings 程序城市 (${buildings.length} 棟)。可放入 assets/models/city.glb 以啟用完整場景。`);
        return cityGroup;
    }
};
