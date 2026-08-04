// ============================================================================
// render.js - 3D 視覺渲染器 (搭載受損焦黑塗裝切換與跨回合特效平滑過渡版)
// ============================================================================

// 🌟 建立 Scene、Camera 與 Controls
const scene = new THREE.Scene();
// Softer daylight: cooler haze, slightly muted overall brightness.
scene.background = new THREE.Color(0x8eb4d4);
scene.fog = new THREE.Fog(0x8eb4d4, 85, 540);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000); 
camera.position.set(10, 28.5, -40); 

const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('canvas-container').appendChild(renderer.domElement);
const controls = new THREE.OrbitControls(camera, renderer.domElement); 
controls.minPolarAngle = Math.PI / 6; controls.maxPolarAngle = Math.PI / 1.6; controls.enableDamping = true;
controls.target.set(10, 25, -30); controls.update();
// iPhone／觸控：關閉雙指 dolly，避免與瀏覽器 pinch 疊加造成「畫面與面板分離」
(function disableTouchOrbitZoom() {
    const touchLikely = ('ontouchstart' in window)
        || (navigator.maxTouchPoints > 0)
        || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (!touchLikely) return;
    controls.enableZoom = false;
    if (controls.touches && THREE.TOUCH) {
        controls.touches.ONE = THREE.TOUCH.ROTATE;
        controls.touches.TWO = THREE.TOUCH.ROTATE;
    }
})();

// Sky fill + warm ground bounce (kept soft, nudged darker).
const hemiLight = new THREE.HemisphereLight(0xc4d8ef, 0x5a564c, 0.98);
scene.add(hemiLight);
const ambientLight = new THREE.AmbientLight(0xb0bdc8, 0.28);
scene.add(ambientLight);
// legacy alias
const ambientFill = ambientLight;

const battlefieldCenter = new THREE.Vector3(10, 0, 20);
const sunDirection = new THREE.Vector3(-0.55, 0.82, -0.35).normalize();
const dirLight = new THREE.DirectionalLight(0xffefd6, 0.58);
dirLight.position.copy(battlefieldCenter).add(sunDirection.clone().multiplyScalar(180));
dirLight.target.position.copy(battlefieldCenter);
dirLight.castShadow = true;
dirLight.shadow.bias = -0.0002;
dirLight.shadow.normalBias = 0.035;
dirLight.shadow.radius = 3.5; // softer penumbra with PCFSoftShadowMap
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.left = -140;
dirLight.shadow.camera.right = 140;
dirLight.shadow.camera.top = 140;
dirLight.shadow.camera.bottom = -140;
dirLight.shadow.camera.near = 10;
dirLight.shadow.camera.far = 360;
scene.add(dirLight);
scene.add(dirLight.target);

const sunVisual = new THREE.Mesh(
    new THREE.SphereGeometry(12, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe6b8, fog: false, transparent: true, opacity: 0.75 })
);
sunVisual.name = 'TACTICAL_SUN_VISUAL';
sunVisual.position.copy(battlefieldCenter).add(sunDirection.clone().multiplyScalar(420));
scene.add(sunVisual);

const groundGeo = new THREE.PlaneGeometry(900, 900);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x4a5440, roughness: 0.98, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.name = 'TACTICAL_GROUND_PLANE';
ground.rotation.x = -Math.PI / 2;
ground.position.set(10, -0.02, 20);
ground.receiveShadow = true;
scene.add(ground);

const obstacles = [];
const cityObstacles = [];
const cityCollisionProxies = [];
let cityRoot = null;
const skyDomeHolder = { mesh: null };
let usingCustomMap = false;
/** @type {{ id: string, path: string|null, doc: object|null }|null} */
let activeMapMeta = null;

const ORIGINAL_ENV = {
    lighting: window.MapLoader ? window.MapLoader.defaultLighting() : null,
    sky: window.MapLoader ? window.MapLoader.defaultSky() : null,
    ground: { width: 900, depth: 900, color: 0x4a5440, centerX: 10, centerZ: 20 }
};

function getMapEnvContext() {
    return {
        scene,
        hemiLight,
        ambientLight,
        dirLight,
        sunVisual,
        battlefieldCenter,
        ground,
        skyDomeHolder
    };
}

function clearCityScene() {
    cityCollisionProxies.forEach((proxy) => {
        if (proxy) {
            scene.remove(proxy);
            if (window.MapLoader) window.MapLoader.disposeObject3D(proxy);
        }
    });
    cityCollisionProxies.length = 0;
    cityObstacles.length = 0;
    obstacles.length = 0;
    if (cityRoot) {
        scene.remove(cityRoot);
        if (window.MapLoader) window.MapLoader.disposeObject3D(cityRoot);
        cityRoot = null;
    }
}

function restoreOriginalEnvironment() {
    if (!window.MapLoader || !ORIGINAL_ENV.lighting) return;
    window.MapLoader.applyEnvironment(getMapEnvContext(), ORIGINAL_ENV.lighting, ORIGINAL_ENV.sky);
    window.MapLoader.applyGround(ground, ORIGINAL_ENV.ground);
}

const collisionProxyMaterial = new THREE.MeshBasicMaterial({
    color: 0xff00ff,
    transparent: true,
    opacity: 0,
    depthWrite: false
});

/**
 * Mesh-truth collision for pillar / building-gap flight.
 * When false (default): elevated-slab undercrofts stay open; only real city meshes
 * enter `obstacles` (same contract as sparse/medium-urban).
 * Legacy solid footprint proxies used to fill ground→roof under floating slabs and
 * blocked visually open gaps in dense-urban / buildings / obstacle-stress.
 */
const FOOTPRINT_PROXY_COLLISION = false;

function buildCityCollisionProxy(source) {
    if (!FOOTPRINT_PROXY_COLLISION || !source) return null;
    const box = new THREE.Box3().setFromObject(source);
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const footprint = Math.max(size.x, size.z);
    const elevated = box.min.y > 2.5;
    const slabLike = size.y > 0.2 && size.y < 6 && footprint > 5;
    if (!elevated || !slabLike) return null;

    const height = Math.max(box.max.y, 3);
    const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, height, size.z),
        collisionProxyMaterial
    );
    proxy.name = `CITY_SOLID_FOOTPRINT_PROXY_${source.name || 'mesh'}`;
    proxy.position.set(center.x, height / 2, center.z);
    proxy.userData.isCollisionProxy = true;
    proxy.userData.sourceCityObstacle = source;
    return proxy;
}

function pickCitySubset(mode, items) {
    if (!items.length) return [];
    if (mode === 'blank') return [];
    if (mode === 'visual-only' || mode === 'dense-urban' || mode === 'buildings' || mode === 'obstacle-stress') return [...items];

    const targetCount = mode === 'sparse-urban'
        ? Math.min(4, items.length)
        : Math.min(8, items.length);
    if (targetCount >= items.length) return [...items];

    const selected = [];
    const used = new Set();
    for (let i = 0; i < targetCount; i++) {
        const idx = targetCount === 1 ? 0 : Math.round(i * (items.length - 1) / (targetCount - 1));
        if (!used.has(idx)) {
            used.add(idx);
            selected.push(items[idx]);
        }
    }
    return selected;
}

function applyArenaMode(mode = (GameContext && GameContext.getArenaMode ? GameContext.getArenaMode() : 'buildings')) {
    const arenaMode = GameContext && GameContext.sanitizeArenaMode ? GameContext.sanitizeArenaMode(mode) : 'buildings';
    const buildingsVisible = arenaMode !== 'blank';
    const buildingCollisionEnabled = ['sparse-urban', 'medium-urban', 'dense-urban', 'buildings', 'obstacle-stress'].includes(arenaMode);
    const footprintProxyEnabled = FOOTPRINT_PROXY_COLLISION &&
        ['dense-urban', 'buildings', 'obstacle-stress'].includes(arenaMode);
    // Authored / packaged maps are intentional layouts — never thin them with sparse/medium subsetting.
    // (Original city.glb is often 1 merged mesh, so subsetting looked fine there but wiped custom maps.)
    const activeCityObstacles = usingCustomMap
        ? (buildingsVisible ? [...cityObstacles] : [])
        : pickCitySubset(arenaMode, cityObstacles);
    const activeSet = new Set(activeCityObstacles);

    if (cityRoot) cityRoot.visible = buildingsVisible;
    if (usingCustomMap) {
        // Keep every authored child visible; blank only hides via cityRoot.
        cityObstacles.forEach((obj) => {
            if (obj) obj.visible = buildingsVisible;
        });
    } else {
        cityObstacles.forEach((obj) => {
            if (obj) obj.visible = buildingsVisible && activeSet.has(obj);
        });
    }
    obstacles.length = 0;
    if (buildingCollisionEnabled) {
        activeCityObstacles.forEach((obj) => obstacles.push(obj));
        if (footprintProxyEnabled) {
            cityCollisionProxies.forEach((proxy) => {
                if (proxy && activeSet.has(proxy.userData.sourceCityObstacle)) obstacles.push(proxy);
            });
        }
    }
    window.obstacles = obstacles;
    if (GameContext && GameContext.three) {
        GameContext.three.obstacles = obstacles;
        GameContext.three.cityObstacles = cityObstacles;
        GameContext.three.cityCollisionProxies = cityCollisionProxies;
        GameContext.three.cityRoot = cityRoot;
    }
    if (CONFIG.debug) console.log(`[Arena] mode=${arenaMode} visible=${buildingsVisible} collision=${buildingCollisionEnabled} activeBuildings=${activeCityObstacles.length}/${cityObstacles.length} proxies=${footprintProxyEnabled ? cityCollisionProxies.length : 0} obstacles=${obstacles.length}`);
}

// ============================================================================
// 💨 TexturePacker 序列圖通用管理員與池化材质
// ============================================================================
class SpriteManager {
    constructor() { this.texture = null; this.frameData = []; this.isReady = false; }
    init(jsonPath, pngPath) {
        return new Promise((resolve) => {
            new THREE.FileLoader().load(jsonPath, (jsonData) => {
                const usePlaceholder = () => {
                    console.warn(`⚠ VFX 貼圖缺失 (${jsonPath})，使用占位材質。`);
                    this.texture = window.AssetFallbacks.createFlipbookPlaceholder();
                    // Single-frame UV so placeholder is not tiled as a sheet.
                    this.frameData = [[0, 1, 0, 1]];
                    this.isReady = true;
                    resolve(this);
                };

                try {
                    const data = JSON.parse(jsonData);
                    const meta = data.meta;
                    this.frameData = Object.keys(data.frames).map(k => {
                        const f = data.frames[k].frame;
                        return [ f.x/meta.size.w, (f.x+f.w)/meta.size.w, (meta.size.h-(f.y+f.h))/meta.size.h, (meta.size.h-f.y)/meta.size.h ];
                    });
                    const baseDir = jsonPath.substring(0, jsonPath.lastIndexOf('/') + 1);
                    const jsonFile = jsonPath.substring(jsonPath.lastIndexOf('/') + 1);
                    const inferredPng = baseDir + jsonFile.replace(/\.json$/i, '.png');
                    const candidates = [];
                    if (meta && meta.image) candidates.push(baseDir + meta.image);
                    if (pngPath) candidates.push(pngPath);
                    candidates.push(inferredPng);
                    if (meta && meta.image) {
                        candidates.push(baseDir + meta.image.toLowerCase());
                    }
                    const uniqueCandidates = [...new Set(candidates)];

                    const tryNext = (idx) => {
                        if (idx >= uniqueCandidates.length) { usePlaceholder(); return; }
                        new THREE.TextureLoader().load(uniqueCandidates[idx], (texture) => {
                            this.texture = texture;
                            this.isReady = true;
                            resolve(this);
                        }, undefined, () => tryNext(idx + 1));
                    };
                    tryNext(0);
                } catch (e) {
                    console.error("❌ 特效 JSON 解析失敗:", e);
                    usePlaceholder();
                }
            }, undefined, () => {
                console.error("❌ 特效 JSON 載入失敗:", jsonPath);
                this.texture = window.AssetFallbacks.createFlipbookPlaceholder();
                this.frameData = [[0, 1, 0, 1]];
                this.isReady = true;
                resolve(this);
            });
        });
    }

    /**
     * Apply one atlas frame to a mesh UV. Default PlaneGeometry UV is 0–1 (whole sheet) —
     * with a 3×3 explosion atlas that looks like 9 mirrored copies.
     * @param {THREE.Mesh} mesh
     * @param {number} lifeRatio 0..1 progress through the flipbook
     */
    applyFrameToMesh(mesh, lifeRatio = 0) {
        if (!mesh || !mesh.geometry || !this.frameData.length) return;
        let tileIdx = Math.floor(Number(lifeRatio) * this.frameData.length);
        if (tileIdx < 0) tileIdx = 0;
        if (tileIdx >= this.frameData.length) tileIdx = this.frameData.length - 1;
        const uv = this.frameData[tileIdx];
        const uvAttr = mesh.geometry.attributes.uv;
        if (!uvAttr) return;
        // PlaneGeometry verts: 0 TL, 1 TR, 2 BL, 3 BR in Three r128 UV layout (v up).
        uvAttr.setXY(0, uv[0], uv[3]);
        uvAttr.setXY(1, uv[1], uv[3]);
        uvAttr.setXY(2, uv[0], uv[2]);
        uvAttr.setXY(3, uv[1], uv[2]);
        uvAttr.needsUpdate = true;
        mesh.userData.flipbookFrame = tileIdx;
    }
}

/** Billboard + optional Z spin for VFX planes. */
function orientVfxBillboard(mesh, zRot = 0) {
    if (!mesh || typeof camera === 'undefined') return;
    mesh.quaternion.copy(camera.quaternion);
    if (zRot) {
        mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), zRot));
    }
}

// 實例化四種特效管理器
const smokeManager = new SpriteManager();
const explosionManager = new SpriteManager();
const flashManager = new SpriteManager();
const puffManager = new SpriteManager();

const smokeColor = (CONFIG.visuals && CONFIG.visuals.smoke) ? CONFIG.visuals.smoke.color : 0x444444;
const puffColor = (CONFIG.visuals && CONFIG.visuals.smoke) ? CONFIG.visuals.smoke.color * 2 : 0xdddddd; 

const mats = {
    smoke: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide, color: smokeColor }),
    explosion: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    flash: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    puff: new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide, color: puffColor })
};

const limitExp = (CONFIG.visuals && CONFIG.visuals.poolLimits) ? CONFIG.visuals.poolLimits.explosion : 10;
const limitFlash = (CONFIG.visuals && CONFIG.visuals.poolLimits) ? CONFIG.visuals.poolLimits.flash : 20;
const limitPuff = (CONFIG.visuals && CONFIG.visuals.poolLimits) ? CONFIG.visuals.poolLimits.puff : 80;

const explosionPool = [];
const flashPool = [];
const puffPool = [];
const aircraftDebris = [];

// Each pool mesh needs its own geometry — shared UV buffers made every sprite show the same frame,
// and default 0–1 UVs show the entire 3×3 explosion atlas (9 copies).
const expGeoTemplate = new THREE.PlaneGeometry(8, 8);
const flashGeoTemplate = new THREE.PlaneGeometry(0.12, 0.12);
const puffGeoTemplate = new THREE.PlaneGeometry(2, 2);

for (let i = 0; i < limitExp; i++) {
    let expMesh = new THREE.Mesh(expGeoTemplate.clone(), mats.explosion.clone());
    expMesh.visible = false;
    scene.add(expMesh);
    explosionPool.push(expMesh);
}
for (let i = 0; i < limitFlash; i++) {
    let flashMesh = new THREE.Mesh(flashGeoTemplate.clone(), mats.flash.clone());
    flashMesh.visible = false;
    scene.add(flashMesh);
    flashPool.push(flashMesh);
}
for (let i = 0; i < limitPuff; i++) {
    let puffMesh = new THREE.Mesh(puffGeoTemplate.clone(), mats.puff.clone());
    puffMesh.visible = false;
    scene.add(puffMesh);
    puffPool.push(puffMesh);
}

/**
 * Burst a destroyed aircraft into tumbling debris + a one-shot explosion sprite.
 */
function spawnAircraftDebris(pos, quat, colorHex) {
    if (!pos || typeof THREE === 'undefined' || typeof scene === 'undefined') return;
    const baseColor = (typeof colorHex === 'string') ? new THREE.Color(colorHex) : new THREE.Color(colorHex || 0x555555);
    const fwd = new THREE.Vector3(0, 0, 1);
    if (quat) fwd.applyQuaternion(quat);

    // Explosion + flash from existing pools (one-shot visual).
    // Must crop flipbook UVs — default 0–1 shows all 9 atlas cells at once.
    if (explosionPool && explosionPool.length) {
        const exp = explosionPool.find(m => !m.visible) || explosionPool[0];
        exp.visible = true;
        exp.position.copy(pos);
        exp.scale.setScalar(2.4);
        exp.userData.zRot = Math.random() * Math.PI * 2;
        exp.userData.debrisLife = 28;
        exp.userData.debrisMaxLife = 28;
        if (exp.material) exp.material.opacity = 1;
        if (explosionManager && explosionManager.isReady) explosionManager.applyFrameToMesh(exp, 0);
        orientVfxBillboard(exp, exp.userData.zRot);
    }
    if (flashPool && flashPool.length) {
        const fl = flashPool.find(m => !m.visible) || flashPool[0];
        fl.visible = true;
        fl.position.copy(pos);
        fl.scale.setScalar(2.0);
        fl.userData.zRot = Math.random() * Math.PI * 2;
        fl.userData.debrisLife = 12;
        fl.userData.debrisMaxLife = 12;
        if (fl.material) fl.material.opacity = 1;
        if (flashManager && flashManager.isReady) flashManager.applyFrameToMesh(fl, 0);
        orientVfxBillboard(fl, fl.userData.zRot);
    }

    const pieceCount = 16;
    for (let i = 0; i < pieceCount; i++) {
        const w = 0.12 + Math.random() * 0.28;
        const h = 0.03 + Math.random() * 0.06;
        const d = 0.08 + Math.random() * 0.32;
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, d),
            new THREE.MeshBasicMaterial({
                color: baseColor.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.25),
                transparent: true,
                opacity: 0.95
            })
        );
        mesh.position.copy(pos).add(new THREE.Vector3(
            (Math.random() - 0.5) * 0.6,
            (Math.random() - 0.5) * 0.4,
            (Math.random() - 0.5) * 0.6
        ));
        if (quat) mesh.quaternion.copy(quat);
        mesh.rotateX((Math.random() - 0.5) * 1.2);
        mesh.rotateY((Math.random() - 0.5) * 1.2);
        const blast = new THREE.Vector3(
            (Math.random() - 0.5) * 0.35,
            0.08 + Math.random() * 0.28,
            (Math.random() - 0.5) * 0.35
        ).add(fwd.clone().multiplyScalar(0.05 + Math.random() * 0.12));
        mesh.userData.vel = blast;
        mesh.userData.spin = new THREE.Vector3(
            (Math.random() - 0.5) * 0.25,
            (Math.random() - 0.5) * 0.25,
            (Math.random() - 0.5) * 0.25
        );
        mesh.userData.life = 70 + Math.floor(Math.random() * 40);
        mesh.userData.maxLife = mesh.userData.life;
        scene.add(mesh);
        aircraftDebris.push(mesh);
    }
}
window.spawnAircraftDebris = spawnAircraftDebris;

function updateAircraftDebris() {
    const minH = (CONFIG.rules && CONFIG.rules.minFlightHeight) ? CONFIG.rules.minFlightHeight : 0.5;
    for (let i = aircraftDebris.length - 1; i >= 0; i--) {
        const mesh = aircraftDebris[i];
        const ud = mesh.userData;
        ud.life -= 1;
        if (ud.vel) {
            mesh.position.add(ud.vel);
            ud.vel.y -= 0.012;
            ud.vel.multiplyScalar(0.985);
            if (mesh.position.y < minH) {
                mesh.position.y = minH;
                ud.vel.y *= -0.25;
                ud.vel.x *= 0.7;
                ud.vel.z *= 0.7;
            }
        }
        if (ud.spin) {
            mesh.rotation.x += ud.spin.x;
            mesh.rotation.y += ud.spin.y;
            mesh.rotation.z += ud.spin.z;
        }
        if (mesh.material && ud.maxLife) {
            mesh.material.opacity = Math.max(0, ud.life / ud.maxLife);
        }
        if (ud.life <= 0) {
            scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
            aircraftDebris.splice(i, 1);
        }
    }
    // Fade / animate one-shot explosion/flash tagged by debrisLife
    [explosionPool, flashPool].forEach((pool) => {
        if (!pool) return;
        const mgr = pool === explosionPool ? explosionManager : flashManager;
        pool.forEach((mesh) => {
            if (mesh.userData && typeof mesh.userData.debrisLife === 'number') {
                mesh.userData.debrisLife -= 1;
                const maxLife = Number(mesh.userData.debrisMaxLife) || 28;
                const lifeRatio = 1 - Math.max(0, mesh.userData.debrisLife) / maxLife;
                if (mgr && mgr.isReady) mgr.applyFrameToMesh(mesh, lifeRatio);
                orientVfxBillboard(mesh, mesh.userData.zRot || 0);
                mesh.visible = mesh.userData.debrisLife > 0;
                if (mesh.material) {
                    mesh.material.opacity = Math.max(0, mesh.userData.debrisLife / maxLife);
                }
                if (mesh.userData.debrisLife <= 0) {
                    mesh.visible = false;
                    delete mesh.userData.debrisLife;
                    delete mesh.userData.debrisMaxLife;
                }
            }
        });
    });
}
window.updateAircraftDebris = updateAircraftDebris;

// ============================================================================
// 🚀 動態連續絲帶 (Ribbon) 專用材質
// ============================================================================
function genRibbonTexture() {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 128, 0);
    grad.addColorStop(0.0, 'rgba(0,0,0,1)');   
    grad.addColorStop(0.3, 'rgba(128,128,128,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,1)'); 
    grad.addColorStop(0.7, 'rgba(128,128,128,1)');
    grad.addColorStop(1.0, 'rgba(0,0,0,1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
}
const ribbonTexShared = genRibbonTexture();
const mslTrailMatShared = new THREE.MeshBasicMaterial({ map: ribbonTexShared, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, vertexColors: true });

const vfxPaths = CONFIG.assets.vfx;
GameContext.vfxReadyPromise = Promise.all([
    smokeManager.init(vfxPaths.smoke, 'assets/vfx/smoke_flipbook.png'),
    explosionManager.init(vfxPaths.explosion, 'assets/vfx/explosion_flipbook.png'),
    flashManager.init(vfxPaths.flash, 'assets/vfx/flash_flipbook.png'),
    puffManager.init(vfxPaths.puff, 'assets/vfx/puff_flipbook.png')
]).then(() => {
    mats.smoke.map = smokeManager.texture; mats.smoke.needsUpdate = true;
    if (fighterVfxPool.red) fighterVfxPool.red.smokePool.forEach(m => { m.material.map = smokeManager.texture; m.material.needsUpdate = true; });
    if (fighterVfxPool.red2) fighterVfxPool.red2.smokePool.forEach(m => { m.material.map = smokeManager.texture; m.material.needsUpdate = true; });
    if (fighterVfxPool.blue) fighterVfxPool.blue.smokePool.forEach(m => { m.material.map = smokeManager.texture; m.material.needsUpdate = true; });
    if (fighterVfxPool.blue2) fighterVfxPool.blue2.smokePool.forEach(m => { m.material.map = smokeManager.texture; m.material.needsUpdate = true; });
    
    mats.explosion.map = explosionManager.texture; mats.explosion.needsUpdate = true; 
    explosionPool.forEach(m => {
        m.material.map = explosionManager.texture;
        m.material.needsUpdate = true;
        explosionManager.applyFrameToMesh(m, 0);
    });
    
    mats.flash.map = flashManager.texture; mats.flash.needsUpdate = true; 
    flashPool.forEach(m => {
        m.material.map = flashManager.texture;
        m.material.needsUpdate = true;
        flashManager.applyFrameToMesh(m, 0);
    });
    
    mats.puff.map = puffManager.texture; mats.puff.needsUpdate = true; 
    puffPool.forEach(m => {
        m.material.map = puffManager.texture;
        m.material.needsUpdate = true;
        puffManager.applyFrameToMesh(m, 0);
    });
    
    if (CONFIG.debug) console.log("🌟 所有 VFX 材質載入與綁定完成");
    return true;
}).catch(err => {
    console.error("❌ VFX 材質綁定失敗:", err);
    return false;
});

const fighterVfxPool = { red: null, red2: null, blue: null, blue2: null };
const particleCount = (CONFIG.visuals && CONFIG.visuals.sparks) ? CONFIG.visuals.sparks.count : 150;

function genSparkTextureShared() {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(16,16,0,16,16,16); g.addColorStop(0,'#fff'); g.addColorStop(0.3,'#ffb432'); g.addColorStop(0.6,'rgba(255,50,0,0.4)'); g.addColorStop(1,'transparent');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(16,16,16,0,Math.PI*2); ctx.fill(); return new THREE.CanvasTexture(canvas);
}
const sparkTexShared = genSparkTextureShared();

function genSparkStreakTexture() {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 128; const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(16, 0, 16, 128);
    grad.addColorStop(0.0, 'transparent');
    grad.addColorStop(0.12, '#ffffff');
    grad.addColorStop(0.35, '#ffcc55');
    grad.addColorStop(0.7, '#ff5500');
    grad.addColorStop(1.0, 'transparent');
    ctx.fillStyle = grad; ctx.fillRect(10, 0, 12, 128);
    const tex = new THREE.CanvasTexture(canvas); tex.encoding = THREE.sRGBEncoding; return tex;
}
const sparkStreakTex = genSparkStreakTexture();
const SPARK_STREAK_LIMIT = 220;
const sparkStreakPool = [];
const sparkStreakGeo = new THREE.PlaneGeometry(0.075, 1.0);
sparkStreakGeo.translate(0, 0.5, 0);
sparkStreakGeo.rotateX(Math.PI / 2);
const sparkStreakMat = new THREE.MeshBasicMaterial({
    map: sparkStreakTex,
    color: 0xffe8b0,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
});
for (let i = 0; i < SPARK_STREAK_LIMIT; i++) {
    const mesh = new THREE.Mesh(sparkStreakGeo, sparkStreakMat.clone());
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    sparkStreakPool.push(mesh);
}

['red', 'red2', 'blue', 'blue2'].forEach(id => {
    const hGeo = new THREE.BufferGeometry(); hGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    const hSystem = new THREE.Points(hGeo, new THREE.PointsMaterial({ size: CONFIG.visuals?.sparks?.size || 6, sizeAttenuation: false, map: sparkTexShared, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    hSystem.visible = false; scene.add(hSystem);

    const tGeo = new THREE.BufferGeometry(); const tColors = new Float32Array(particleCount * 6);
    for(let i=0; i<particleCount; i++) { tColors[i*6]=1; tColors[i*6+1]=0.5; tColors[i*6+2]=0.1; tColors[i*6+3]=0.3; } 
    tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particleCount * 6), 3)); tGeo.setAttribute('color', new THREE.BufferAttribute(tColors, 3));
    const tSystem = new THREE.LineSegments(tGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    tSystem.visible = false; scene.add(tSystem);

    const teamSmokeMeshes = [];
    const smokeBaseO = (CONFIG.visuals && CONFIG.visuals.smoke) ? CONFIG.visuals.smoke.baseOpacity : 0.38;
    for(let i=0; i<particleCount; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mats.smoke.clone());
        m.material.opacity = smokeBaseO;
        m.visible = false;
        scene.add(m);
        teamSmokeMeshes.push(m);
    }
    fighterVfxPool[id] = { head: hSystem, tail: tSystem, smokePool: teamSmokeMeshes };
});

const threatEnvGroup = new THREE.Group(); scene.add(threatEnvGroup);
window.ghostWrapper = new THREE.Group(); window.ghostWrapper.visible = false; scene.add(window.ghostWrapper);
const ringGeo1 = new THREE.RingGeometry(0.4, 0.45, 32);
window.ghostRing = new THREE.Mesh(ringGeo1, new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false}));
window.ghostRing.rotation.x = Math.PI / 2; window.ghostRing.position.y = -0.08;
const ghostCanvas = document.createElement('canvas'); ghostCanvas.width = 128; ghostCanvas.height = 64;
window.ghostCtx = ghostCanvas.getContext('2d'); window.ghostTex = new THREE.CanvasTexture(ghostCanvas);
const ghostTextPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), new THREE.MeshBasicMaterial({map: window.ghostTex, transparent: true, side: THREE.DoubleSide, depthTest: false}));
ghostTextPlane.position.set(0, 0.1, -0.5); ghostTextPlane.rotation.set(-Math.PI / 2, 0, Math.PI);

window.ghostWrapper.add(window.ghostRing, ghostTextPlane);

const trackMaterialRed = new THREE.MeshBasicMaterial({ color: 0xff0055, transparent: true, opacity: 0.65, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }); 
const trackMaterialBlue = new THREE.MeshBasicMaterial({ color: 0x00bcd4, transparent: true, opacity: 0.65, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
const flareGeo = new THREE.SphereGeometry(0.4, 8, 8); const expGeo = new THREE.SphereGeometry(1, 16, 16); const expMat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
const flareMats = [ new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }), new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }), new THREE.MeshBasicMaterial({ color: 0x886655, transparent: true, opacity: 0.28, depthWrite: false }) ];
const visualFlaresPool = [];

const maxVisualBullets = 150; 
const visualBullets = [];
for (let i = 0; i < maxVisualBullets; i++) {
    let pts = new Float32Array(6); 
    let cols = new Float32Array(6); 
    let geo = new THREE.BufferGeometry(); 
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3)); 
    let mesh = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, linewidth: 2, blending: THREE.AdditiveBlending }));
    mesh.visible = false; scene.add(mesh); visualBullets.push(mesh);
}

function createProceduralMissileMesh() {
    let group = new THREE.Group();
    let bodyGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.8, 8); bodyGeo.rotateX(Math.PI / 2);
    let body = new THREE.Mesh(bodyGeo, new THREE.MeshBasicMaterial({ color: 0xeeeeee })); group.add(body);
    let headGeo = new THREE.ConeGeometry(0.05, 0.2, 8); headGeo.rotateX(Math.PI / 2); headGeo.translate(0, 0, 0.5);
    let head = new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial({ color: 0xff3333 })); group.add(head);
    for(let i=0; i<4; i++) {
        let finGeo = new THREE.BoxGeometry(0.01, 0.18, 0.15); finGeo.translate(0, 0.08, -0.3);
        let fin = new THREE.Mesh(finGeo, new THREE.MeshBasicMaterial({ color: 0xffcc00 })); fin.rotation.z = (Math.PI / 2) * i; group.add(fin);
    }
    return group;
}
window.createProceduralMissileMesh = createProceduralMissileMesh;
GameContext.registerService('createProceduralMissileMesh', createProceduralMissileMesh);

const ghostBeam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,-1,0)]), new THREE.LineBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.6})); 
scene.add(ghostBeam);

window.drawStaticFlares = function() {
    visualFlaresPool.forEach(f => f.visible = false);
    if (GameContext.state.globalFlares.length > 0 || typeof globalFlares !== 'undefined') {
        const flares = GameContext.state.globalFlares;
        flares.forEach((gf, i) => {
            if (!visualFlaresPool[i]) { let nm = new THREE.Mesh(flareGeo, flareMats[0]); scene.add(nm); visualFlaresPool.push(nm); }
            let fMesh = visualFlaresPool[i]; fMesh.position.copy(gf.pos);
            if (gf.age === 0) { fMesh.material = flareMats[0]; fMesh.scale.set(0.5, 0.5, 0.5); } 
            else if (gf.age === 1) { fMesh.material = flareMats[1]; fMesh.scale.set(1.0, 1.0, 1.0); } 
            else { fMesh.material = flareMats[2]; fMesh.scale.set(1.5, 1.5, 1.5); }
            fMesh.visible = true;
        });
    }
};
GameContext.registerService('drawStaticFlares', window.drawStaticFlares);

/** Soft white smoke billboard texture for chaff clouds. */
function genChaffSmokeTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx2d = canvas.getContext('2d');
    const g = ctx2d.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.35, 'rgba(245,248,255,0.55)');
    g.addColorStop(0.7, 'rgba(230,235,245,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx2d.fillStyle = g;
    ctx2d.beginPath();
    ctx2d.arc(32, 32, 30, 0, Math.PI * 2);
    ctx2d.fill();
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
}
const chaffSmokeTex = genChaffSmokeTexture();
const chaffSmokeGeo = new THREE.PlaneGeometry(1, 1);
const chaffSparkGeo = new THREE.SphereGeometry(0.12, 6, 6);
const visualChaffPool = [];

function createChaffVisualEntry() {
    const group = new THREE.Group();
    const smokes = [];
    for (let i = 0; i < 5; i++) {
        const mat = new THREE.MeshBasicMaterial({
            map: chaffSmokeTex,
            color: 0xffffff,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.NormalBlending
        });
        const m = new THREE.Mesh(chaffSmokeGeo, mat);
        m.frustumCulled = false;
        m.userData.offset = new THREE.Vector3(
            (Math.random() - 0.5) * 0.45,
            (Math.random() - 0.5) * 0.35,
            (Math.random() - 0.5) * 0.45
        );
        m.userData.scaleMul = 0.65 + Math.random() * 0.55;
        group.add(m);
        smokes.push(m);
    }
    const sparkN =
        (CONFIG.weapons && CONFIG.weapons.chaff && CONFIG.weapons.chaff.visual &&
            CONFIG.weapons.chaff.visual.sparksPerCloud) || 32;
    const sparks = [];
    for (let i = 0; i < sparkN; i++) {
        let x; let y; let z; let d2;
        do {
            x = Math.random() * 2 - 1;
            y = Math.random() * 2 - 1;
            z = Math.random() * 2 - 1;
            d2 = x * x + y * y + z * z;
        } while (d2 > 1 || d2 < 0.04);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        const m = new THREE.Mesh(chaffSparkGeo, mat);
        m.frustumCulled = false;
        m.userData.local = new THREE.Vector3(x, y, z).multiplyScalar(0.82);
        m.userData.phase = Math.random() * Math.PI * 2;
        m.userData.hzJitter = 0.7 + Math.random() * 0.9;
        group.add(m);
        sparks.push(m);
    }
    group.visible = false;
    scene.add(group);
    return { group, smokes, sparks };
}

function ensureChaffVisual(i) {
    while (visualChaffPool.length <= i) visualChaffPool.push(createChaffVisualEntry());
    return visualChaffPool[i];
}

/** Scratch vectors for chaff camera-occlusion tests (avoid per-frame alloc). */
const _chaffCamOcclusion = {
    camToCraft: new THREE.Vector3(),
    camToCloud: new THREE.Vector3(),
    closest: new THREE.Vector3()
};

/**
 * When a chaff cloud sits on the camera→aircraft line of sight, fade it so the plane stays readable.
 * Returns opacity multiplier in ~[0.22, 1].
 */
function chaffCameraOcclusionFade(cloudPos, cloudRadius) {
    if (typeof camera === 'undefined' || !camera || !cloudPos) return 1;
    if (typeof teams === 'undefined' || !teams) return 1;
    const camPos = camera.position;
    const ids =
        (typeof GameContext !== 'undefined' && GameContext.getRosterIds && GameContext.getRosterIds()) ||
        (typeof GameContext !== 'undefined' && GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) ||
        ['red', 'red2', 'blue', 'blue2'];
    const influenceR = Math.max(6, (Number(cloudRadius) || 12) * 0.9 + 3);
    let fade = 1;
    for (let i = 0; i < ids.length; i++) {
        const t = teams[ids[i]];
        if (!t || !t.wrapper || t.isDestroyed || t.matchActive === false) continue;
        if (t.wrapper.visible === false) continue;
        const craftPos = t.wrapper.position;
        const camToCraft = _chaffCamOcclusion.camToCraft.subVectors(craftPos, camPos);
        const craftDist = camToCraft.length();
        if (craftDist < 1.5) continue;
        const dirLen = craftDist;
        camToCraft.multiplyScalar(1 / dirLen);
        const camToCloud = _chaffCamOcclusion.camToCloud.subVectors(cloudPos, camPos);
        const along = camToCloud.dot(camToCraft);
        // Must lie strictly between camera and aircraft
        if (along < 1.0 || along > dirLen - 0.5) continue;
        _chaffCamOcclusion.closest.copy(camPos).addScaledVector(camToCraft, along);
        const lateral = cloudPos.distanceTo(_chaffCamOcclusion.closest);
        if (lateral > influenceR) continue;
        const center = 1 - lateral / influenceR;
        // Stronger fade when cloud is large relative to remaining craft depth
        const depthWeight = 0.55 + 0.45 * (1 - along / dirLen);
        const block = center * center * depthWeight;
        fade = Math.min(fade, 1 - block * 0.78);
    }
    return Math.max(0.22, fade);
}

/** Size / opacity / spark gate from ageSteps (5-turn chaff life). */
function chaffAgeVisual(ageSteps) {
    const spt = (CONFIG.rules && CONFIG.rules.stepsPerTurn) || 100;
    const age = Math.max(0, Number(ageSteps) || 0);
    const ageTurn = Math.min(4, Math.floor(Math.max(0, age - 1) / spt));
    const tIn = ((Math.max(0, age - 1) % spt) + 1) / spt;
    const vis = (CONFIG.weapons && CONFIG.weapons.chaff && CONFIG.weapons.chaff.visual) || {};
    const opacArr = vis.smokeOpacity || [0.78, 0.88, 0.52, 0.28, 0.1];
    let sizeNorm;
    if (age <= spt) {
        // Turn 1: fast burst then settle
        const u = age / spt;
        const burst = Math.min(1, u / 0.28);
        sizeNorm = 0.22 + 0.48 * burst + 0.12 * u;
    } else if (age <= spt * 2) {
        // Turn 2: expand to max
        const u = (age - spt) / spt;
        sizeNorm = 0.82 + 0.18 * Math.min(1, u / 0.45);
    } else {
        // Turns 3–5: slight shrink while fading
        const u = (age - spt * 2) / (spt * 3);
        sizeNorm = 1.0 - 0.28 * Math.min(1, u);
    }
    const o0 = opacArr[ageTurn] != null ? opacArr[ageTurn] : 0.5;
    const o1 = opacArr[Math.min(4, ageTurn + 1)] != null ? opacArr[Math.min(4, ageTurn + 1)] : o0;
    const opacity = Math.max(0, o0 + (o1 - o0) * tIn * 0.4);
    const sparkTurns = vis.sparkTurns != null ? vis.sparkTurns : 4;
    return { ageTurn, sizeNorm, opacity, sparks: ageTurn < sparkTurns };
}

function applyChaffCloudVisual(entry, cloud, nowMs) {
    if (!entry || !cloud || !cloud.pos) return;
    const age = cloud.ageSteps != null ? cloud.ageSteps : (cloud.age || 0);
    const params = chaffAgeVisual(age);
    const maxR = (CONFIG.weapons && CONFIG.weapons.chaff && CONFIG.weapons.chaff.cloudRadiusMax) || 32;
    const physR = cloud.radius != null ? Number(cloud.radius) : maxR * params.sizeNorm;
    const size = Math.max(3.5, physR * (0.55 + 0.45 * params.sizeNorm));
    const t = (nowMs || (typeof performance !== 'undefined' ? performance.now() : Date.now())) * 0.001;
    const hz = (CONFIG.weapons && CONFIG.weapons.chaff && CONFIG.weapons.chaff.flickerHz) || 14;
    const viewFade = chaffCameraOcclusionFade(cloud.pos, size);

    entry.group.position.copy(cloud.pos);
    entry.group.visible = true;

    entry.smokes.forEach((m, idx) => {
        orientVfxBillboard(m, t * 0.15 * (idx + 1));
        const off = m.userData.offset.clone().multiplyScalar(size * 0.38);
        m.position.copy(off);
        const s = size * (m.userData.scaleMul || 1);
        m.scale.set(s, s, 1);
        m.material.opacity = params.opacity * (0.5 + 0.12 * (idx % 4)) * viewFade;
        m.visible = params.opacity > 0.02;
    });

    entry.sparks.forEach((sp) => {
        if (!params.sparks) {
            sp.visible = false;
            return;
        }
        const phase = sp.userData.phase || 0;
        const j = sp.userData.hzJitter || 1;
        const flicker = Math.sin(t * hz * Math.PI * 2 * j + phase);
        const flicker2 = Math.sin(t * hz * 3.4 * Math.PI + phase * 1.7);
        const on = flicker > -0.15 || flicker2 > 0.35;
        sp.visible = on;
        if (!on) return;
        const bright = (0.35 + 0.65 * Math.max(0, flicker)) * Math.max(0.35, viewFade);
        sp.material.opacity = bright;
        const sc = 0.45 + bright * 1.1;
        sp.scale.setScalar(sc);
        sp.position.copy(sp.userData.local).multiplyScalar(size * 0.48);
    });
}

function updateChaffVisuals(list, nowMs) {
    visualChaffPool.forEach((e) => { if (e && e.group) e.group.visible = false; });
    if (!list || !list.length) return;
    const t = nowMs != null ? nowMs : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (let i = 0; i < list.length; i++) {
        const cloud = list[i];
        if (!cloud || !cloud.pos) continue;
        applyChaffCloudVisual(ensureChaffVisual(i), cloud, t);
    }
}

window.drawStaticChaff = function() {
    const list =
        (GameContext.state && Array.isArray(GameContext.state.globalChaff) && GameContext.state.globalChaff.length)
            ? GameContext.state.globalChaff
            : (typeof globalChaff !== 'undefined' && Array.isArray(globalChaff) ? globalChaff : []);
    // Static planning view: keep sparkles alive by using wall-clock time
    updateChaffVisuals(list, typeof performance !== 'undefined' ? performance.now() : Date.now());
};
GameContext.registerService('drawStaticChaff', window.drawStaticChaff);
GameContext.registerService('updateChaffVisuals', updateChaffVisuals);

function updateSpatialHelpers() {
    if (!teams || typeof P === 'undefined' || !P) return;
    let isReplaying = window.replayMode || (typeof isAnimating !== 'undefined' && isAnimating);
    const ids = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || ['red', 'blue'];
    ids.forEach(id => {
        let t = teams[id];
        if (!t) return;
        let label = document.getElementById(`alt-label-${id}`);
        const faction = (GameContext.getFaction && GameContext.getFaction(id)) || id;
        const color = faction === 'blue' ? 0x00bcd4 : 0xff0055;
        const colorCss = faction === 'blue' ? '#00bcd4' : '#ff0055';
        if (!t.realBeam) { t.realBeam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,-1,0)]), new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.5})); scene.add(t.realBeam); }
        if (id !== window.activeTeamId && !isReplaying) { if(t.realBeam) t.realBeam.visible = false; if(label) label.style.display = 'none'; return; }
        if (t.wrapper && !t.isDestroyed && t.matchActive !== false) { 
            let correctedY = t.wrapper.position.y - 0.08; t.realBeam.position.set(t.wrapper.position.x, correctedY, t.wrapper.position.z); t.realBeam.scale.set(1, Math.max(0.01, correctedY), 1); t.realBeam.visible = true; 
            if (isReplaying) { if(label) label.style.display = 'none'; } else {
                let pos = t.wrapper.position.clone(); pos.y = pos.y * 0.8; pos.project(camera);
                if (label) { label.style.left = `${(pos.x*.5+.5)*window.innerWidth}px`; label.style.top = `${(pos.y*-.5+.5)*window.innerHeight}px`; label.style.color = colorCss; label.innerText = `${t.wrapper.position.y.toFixed(1)}m`; label.style.display = 'block'; }
            }
        } else { if(t.realBeam) t.realBeam.visible = false; if(label) label.style.display = 'none'; }
    });
    
    let ghostLabel = document.getElementById('alt-label-ghost');
    const activeFaction = (GameContext.getFaction && GameContext.getFaction(window.activeTeamId)) || window.activeTeamId;
    if (window.ghostWrapper && window.ghostWrapper.visible && !isReplaying) { 
        let correctedGhostY = window.ghostWrapper.position.y - 0.08; ghostBeam.position.set(window.ghostWrapper.position.x, correctedGhostY, window.ghostWrapper.position.z); ghostBeam.scale.set(1, Math.max(0.01, correctedGhostY), 1); ghostBeam.visible = true; 
        let pos = window.ghostWrapper.position.clone(); pos.y = pos.y * 0.8; pos.project(camera);
        if (ghostLabel) { ghostLabel.style.left = `${(pos.x*.5+.5)*window.innerWidth}px`; ghostLabel.style.top = `${(pos.y*-.5+.5)*window.innerHeight}px`; ghostLabel.style.color = activeFaction === 'blue' ? '#00bcd4' : '#ff0055'; ghostLabel.innerText = `${window.ghostWrapper.position.y.toFixed(1)}m`; ghostLabel.style.display = 'block'; }
    } else { ghostBeam.visible = false; if(ghostLabel) ghostLabel.style.display = 'none'; }
}

function drawTrajectoryLine(teamObj) {
    if (trajectoryMeshes[teamObj.id]) { scene.remove(trajectoryMeshes[teamObj.id]); trajectoryMeshes[teamObj.id] = null; }
    if (teamObj.pathPoints.length < 2) { if (teamObj.id === tAct) window.ghostWrapper.visible = false; return; }
    
    let pathLen = 0; 
    for(let i=0; i<teamObj.pathPoints.length-1; i++) pathLen += teamObj.pathPoints[i].distanceTo(teamObj.pathPoints[i+1]);
    teamObj.flightLength = pathLen;
    
    const vis = CONFIG.aircrafts['mig21'].visuals; 
    const vertexArray = []; const leftPts = []; const rightPts = []; 
    const steps = teamObj.pathPoints.length * 2;
    
    // 生成絲帶節點
    for (let i = 0; i <= steps; i++) { 
        let t = i / steps; 
        let pos = getPosAt(t, teamObj.pathPoints); 
        let q = getQuatAt(t, teamObj.pathQuats); 
        let wingDir = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize(); 
        let centerPos = pos.clone().add(new THREE.Vector3(0, vis.engineOffsetY, 0).applyQuaternion(q)); 
        leftPts.push(centerPos.clone().add(wingDir.clone().multiplyScalar(vis.ribbonWidth / 2))); 
        rightPts.push(centerPos.clone().sub(wingDir.clone().multiplyScalar(vis.ribbonWidth / 2))); 
    }
    
    // 縫合三角面
    for (let i = 0; i < steps; i++) { 
        vertexArray.push(leftPts[i].x, leftPts[i].y, leftPts[i].z, rightPts[i].x, rightPts[i].y, rightPts[i].z, leftPts[i+1].x, leftPts[i+1].y, leftPts[i+1].z); 
        vertexArray.push(rightPts[i].x, rightPts[i].y, rightPts[i].z, rightPts[i+1].x, rightPts[i+1].y, rightPts[i+1].z, leftPts[i+1].x, leftPts[i+1].y, leftPts[i+1].z); 
    }
    
   
    const geo = new THREE.BufferGeometry(); 
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertexArray, 3)); 
    
    // 🟢 刪除原本的 computeBoundingSphere(); 替換成以下這行！
    // 這會賦予光帶一個無限大的邊界球，徹底免疫任何極端大角度機動造成的 WebGL 引擎誤判剔除！
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000000); 
    
    const trackMat = ((GameContext.getFaction && GameContext.getFaction(teamObj.id)) === 'blue') ? trackMaterialBlue : trackMaterialRed;
    trajectoryMeshes[teamObj.id] = new THREE.Mesh(geo, trackMat); 
    trajectoryMeshes[teamObj.id].frustumCulled = false;
    
    scene.add(trajectoryMeshes[teamObj.id]);

    // 🟢 嚴格遵守 HUD 的包絡線點擊開關
    if (trajectoryMeshes[teamObj.id]) {
        // 如果是自己，永遠顯示；如果是敵人，必須根據 showEnvelope 決定
        let currentTeam = typeof tAct !== 'undefined' ? tAct : window.activeTeamId;
        if (teamObj.id === currentTeam) {
            trajectoryMeshes[teamObj.id].visible = true;
        } else {
            // 這是關鍵：讀取敵機的 userData 狀態
            trajectoryMeshes[teamObj.id].visible = !!(teamObj.userData && teamObj.userData.showEnvelope);
        }
    }
    
    // ============================================
    // 👇 下方保留你原本的 Ghost Plane (幽靈戰機) 邏輯
    if (!isAnimating && !window.replayMode && teamObj.id === tAct && !teamObj.isDestroyed) {
        window.ghostWrapper.visible = true;
        window.ghostWrapper.position.copy(teamObj.pathPoints[teamObj.pathPoints.length - 1]);
        window.ghostWrapper.quaternion.copy(teamObj.pathQuats[teamObj.pathQuats.length - 1]);
        
        if (window.ghostPlaneMesh) {
            window.ghostWrapper.remove(window.ghostPlaneMesh);
        }

        if (teamObj.wrapper) {
            if (teamObj.wrapper.userData.exhaust && teamObj.wrapper.userData.exhaust.group) {
                teamObj.wrapper.userData.exhaust.group.traverse(node => {
                    node.userData.isExhaustComponent = true;
                });
            }

            window.ghostPlaneMesh = teamObj.wrapper.clone();
            window.ghostPlaneMesh.position.set(0, 0, 0);
            window.ghostPlaneMesh.quaternion.set(0, 0, 0, 1);
            
            let teamColor = ((GameContext.getFaction && GameContext.getFaction(teamObj.id)) === 'blue') ? 0x00bcd4 : 0xff0055;
            let ghostMat = new THREE.MeshBasicMaterial({
                color: teamColor,
                transparent: true,
                opacity: 0.35,              
                side: THREE.DoubleSide,
                depthWrite: false
            });

            window.ghostPlaneMesh.traverse(c => {
                let isExhaust = c.userData.isExhaustComponent || 
                                (c.name && c.name.toLowerCase().includes('exhaust')) || 
                                (c.parent && c.parent.name && c.parent.name.toLowerCase().includes('exhaust')) ||
                                c.name === 'flyingGlowMesh';

                if (isExhaust) {
                    c.visible = false; 
                } 
                else if (c.isMesh) {
                    c.material = ghostMat;
                    c.visible = true;
                }
            });

            window.ghostWrapper.add(window.ghostPlaneMesh);
        }

        let teamColor = ((GameContext.getFaction && GameContext.getFaction(teamObj.id)) === 'blue') ? 0x00bcd4 : 0xff0055;
        if (window.ghostRing) window.ghostRing.material.color.setHex(teamColor);

        window.ghostCtx.clearRect(0,0,128,64); 
        window.ghostCtx.shadowColor = 'rgba(0,0,0,0.9)'; window.ghostCtx.shadowOffsetX = 2; window.ghostCtx.shadowOffsetY = 2; window.ghostCtx.shadowBlur = 4; 
        window.ghostCtx.fillStyle = '#ffeb3b'; window.ghostCtx.font = 'bold 30px Courier New'; window.ghostCtx.textAlign = 'center'; window.ghostCtx.textBaseline = 'middle'; 
        window.ghostCtx.fillText(teamObj.flightLength.toFixed(1) + 'm', 64, 32); 
        window.ghostTex.needsUpdate = true;
    } else if (teamObj.id === tAct) { 
        window.ghostWrapper.visible = false; 
    }
}

function updateGunPreview(teamObj) {
    if (!teamObj.wrapper) return;
    if (!teamObj.userData) teamObj.userData = {};
    if (!teamObj.userData.gunPreview) { let pts = new Float32Array(32 * 3); let geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pts, 3)); let g = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.7, linewidth: 2 })); scene.add(g); teamObj.userData.gunPreview = g; }
    
    if (teamObj.wpnQueued && teamObj.weapon === 'gun' && !isAnimating && !window.replayMode && teamObj.pathPoints && teamObj.pathPoints.length >= 2) {
        let stats = CONFIG.aircrafts[teamObj.type || 'mig21'].throttleStats[teamObj.throttle] || { gunRangeMult: 1.0 };
        let dRange = GUN_RANGE * stats.gunRangeMult; let posArr = teamObj.userData.gunPreview.geometry.attributes.position.array; let ptIdx = 0; let T_now = 1.0; 
        for (let i = 0; i <= 30; i++) {
            let t_spawn = (i / 30) * 1.0; 
            let sPos = getPosAt(t_spawn, teamObj.pathPoints); 
            let sQuat = getQuatAt(t_spawn, teamObj.pathQuats); 
            
            let nPos = sPos.clone().add(new THREE.Vector3(0, -0.2, 0.5).applyQuaternion(sQuat)); 
            
            let el = CONFIG.weapons['gun'].elevation || 0;
            let fwd = new THREE.Vector3(0, Math.sin(el), Math.cos(el)).applyQuaternion(sQuat).normalize();
            
            let dt = Math.max(0, T_now - t_spawn); 
            let muzzleSpeed = dRange * 2.0; 
            let travelDist = muzzleSpeed * dt; 
            let pt = nPos.clone().add(fwd.multiplyScalar(travelDist)); 
            
            let gunGravMult = CONFIG.weapons['gun'].gravityMult !== undefined ? CONFIG.weapons['gun'].gravityMult : 1.0;
            pt.y -= 0.5 * (CONFIG.rules.gravity * gunGravMult) * (dt * dt);
            
            posArr[ptIdx*3] = pt.x; posArr[ptIdx*3+1] = pt.y; posArr[ptIdx*3+2] = pt.z; ptIdx++;
        }
        teamObj.userData.gunPreview.geometry.setDrawRange(0, ptIdx); teamObj.userData.gunPreview.geometry.attributes.position.needsUpdate = true; teamObj.userData.gunPreview.visible = true;
    } else { if(teamObj.userData.gunPreview) teamObj.userData.gunPreview.visible = false; }
}

function updateMissilePreview(teamObj) {
    if (!teamObj.pylons) return;
    const enemyId = (GameContext.getTargetId && GameContext.getTargetId(teamObj.id))
        || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(teamObj.id))
        || (String(teamObj.id).startsWith('red') ? 'blue' : 'red');
    const enemyObj = teams[enemyId]; 
    if (isAnimating || window.replayMode) { teamObj.pylons.forEach(p => { if (p.lineMesh) { scene.remove(p.lineMesh); p.lineMesh = null; } }); return; }
    if (!enemyObj || !enemyObj.wrapper || enemyObj.isDestroyed) {
        teamObj.pylons.forEach(p => { if (p.lineMesh) { scene.remove(p.lineMesh); p.lineMesh = null; } });
        return;
    }

    let hasPath = teamObj.pathPoints && teamObj.pathPoints.length > 0;
    teamObj.pylons.forEach(p => {
        if(p.lineMesh) { scene.remove(p.lineMesh); p.lineMesh = null; }
        let isFiringNow = p.state === 'armed' && teamObj.wpnQueued && teamObj.weapon === 'missile';
        let activeM = teamObj.activeMissiles ? teamObj.activeMissiles.find(m => m.pylonId === p.id) : null;
        let isFlying = activeM && activeM.active;

        if (p.mesh) { let glowMesh = p.mesh.children.find(child => child.geometry && child.geometry.type === "SphereGeometry"); if (glowMesh) glowMesh.visible = false; }
        if (!isFiringNow && !isFlying) { if (p.mesh) p.mesh.visible = (p.state !== 'empty'); return; }
        if (p.mesh) p.mesh.visible = false;

        let mPos, mQuat, mAP;
        if (isFiringNow && !isFlying) {
            let launchQuat = hasPath ? teamObj.pathQuats[0] : teamObj.wrapper.quaternion;
            let visualLineOffset = new THREE.Vector3(0, -0.5, 0.2); let worldOffset = p.localPosition.clone().add(visualLineOffset).applyQuaternion(launchQuat);
            mPos = (hasPath ? teamObj.pathPoints[0].clone() : teamObj.wrapper.position.clone()).add(worldOffset); mQuat = launchQuat.clone(); mAP = MISSILE_MAX_AP;
        } else { mPos = activeM.pos.clone(); mQuat = activeM.quat.clone(); mAP = activeM.ap; }

        let mPoints = [mPos.clone()]; let simPos = mPos.clone(); let simQuat = mQuat.clone(); let simAP = mAP;
        const previewSources = (typeof buildMissileHeatSources === 'function')
            ? buildMissileHeatSources(teamObj.id, null, [])
            : null;
        for (let step = 0; step <= 100; step++) { 
            let ratio = step / 100;
            // Rebuild aircraft poses along paths for no-IFF preview when possible
            let heatSources = previewSources;
            if (typeof buildMissileHeatSources === 'function') {
                heatSources = buildMissileHeatSources(teamObj.id, ratio, []);
            }
            let eIdx = Math.min(enemyObj.pathPoints.length - 1, Math.floor(ratio * enemyObj.pathPoints.length));
            let targetPos = enemyObj.pathPoints[eIdx] || enemyObj.wrapper.position;
            let targetQuat = enemyObj.pathQuats[eIdx] || enemyObj.wrapper.quaternion;
            let stepRes = simulateMissileStep(simPos, simQuat, targetPos, targetQuat, simAP, teamObj, enemyObj, [], null, {
                shooterId: teamObj.id,
                ratio,
                heatSources
            });
            simPos = stepRes.pos; simQuat = stepRes.quat; simAP = stepRes.ap; mPoints.push(simPos.clone()); 
            if (stepRes.exploded || simAP <= 0) break; 
        }
        
        if (mPoints.length >= 2) {
            let isTracking = mPoints.length < 100 || (mPoints.length > 10 && mPoints[mPoints.length-1].distanceTo(enemyObj.wrapper.position) < 10);
            let lineColor = isTracking ? teamObj.colorMain : 0xffffff; let lineOpacity = isTracking ? 0.8 : 0.4;
            const geo = new THREE.BufferGeometry().setFromPoints(mPoints);
            p.lineMesh = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: lineOpacity, linewidth: 2 }));
            scene.add(p.lineMesh); 
        }
    });
}

function renderCombatFrame(currentLog, animProgress) {
    if (!currentLog || !battleLog) return;
    let turnIdx = battleLog.indexOf(currentLog); if (turnIdx === -1) return;
    let trackIdx = Math.min(100, Math.floor(animProgress * 100));

    explosionPool.forEach(p => {
        if (!(p.userData && typeof p.userData.debrisLife === 'number')) p.visible = false;
    });
    flashPool.forEach(p => {
        if (!(p.userData && typeof p.userData.debrisLife === 'number')) p.visible = false;
    });
    puffPool.forEach(p => p.visible = false);
    sparkStreakPool.forEach(p => { p.visible = false; });

    let vfxToRender = [];
    
    if (currentLog.vfxTriggers) {
        currentLog.vfxTriggers.forEach(t => {
            vfxToRender.push({ trigger: t, ageFrames: trackIdx - t.step });
        });
    }
    
    if (turnIdx > 0 && battleLog[turnIdx - 1] && battleLog[turnIdx - 1].vfxTriggers) {
        battleLog[turnIdx - 1].vfxTriggers.forEach(t => {
            let pastAge = (100 - t.step) + trackIdx;
            vfxToRender.push({ trigger: t, ageFrames: pastAge });
        });
    }

    const smokeCfg = (CONFIG.visuals && CONFIG.visuals.smoke) ? CONFIG.visuals.smoke : { baseOpacity: 0.38 };
    const sparkCfg = (CONFIG.visuals && CONFIG.visuals.sparks) ? CONFIG.visuals.sparks : { drag: 0.93, gravity: 0.007, life: 16, streak: 0.65, wind: 0.18 };
    const sparkDrag = Number(sparkCfg.drag) || 0.93;
    const sparkGrav = Number(sparkCfg.gravity) || 0.007;
    const sparkLifeDefault = Number(sparkCfg.life) || 16;
    const sparkStreakDefault = Number(sparkCfg.streak) || 0.65;
    const sparkWindForce = Number(sparkCfg.wind) || 0.18;
    let sparkIdx = 0;

    let activeCounts = { explosion: 0, flash: 0, puff: 0 };
    vfxToRender.forEach(({ trigger, ageFrames }) => {
        if (ageFrames < 0) return;

        if (trigger.type === 'spark_explosion') {
            const maxLife = Number(trigger.life) > 0 ? Number(trigger.life) : sparkLifeDefault;
            if (ageFrames >= maxLife) return;
            const streakMul = Number(trigger.streak) > 0 ? Number(trigger.streak) : sparkStreakDefault;
            const gravMul = Number.isFinite(Number(trigger.gravity)) ? Number(trigger.gravity) : sparkGrav;
            const windMul = Number.isFinite(Number(trigger.windForce)) ? Number(trigger.windForce) : sparkWindForce;
            const wind = (trigger.wind && trigger.wind.clone) ? trigger.wind.clone() : new THREE.Vector3();
            // Continuous wind pressure along trigger wind dir (or mild rearward fallback).
            let windDir = wind.lengthSq() > 1e-8 ? wind.clone().normalize() : new THREE.Vector3(0, -0.15, -1).normalize();
            const windAccel = windDir.multiplyScalar(windMul * 0.12);
            const fountain = !!trigger.fountain;
            const vels = trigger.velocities || [];
            for (let i = 0; i < vels.length; i++) {
                if (sparkIdx >= sparkStreakPool.length) break;
                let p = trigger.pos.clone();
                let v = vels[i].clone();
                for (let f = 0; f < ageFrames; f++) {
                    v.multiplyScalar(sparkDrag);
                    v.y -= gravMul;
                    // Fountain: burst outward first, then ramp wind so sparks stream aft.
                    const windGate = fountain
                        ? Math.min(1, Math.max(0, (f - 2) / 6))
                        : 1;
                    v.addScaledVector(windAccel, windGate);
                    if (wind.lengthSq() > 1e-8) v.addScaledVector(wind, 1.15 * windGate);
                    p.add(v);
                }
                const mesh = sparkStreakPool[sparkIdx++];
                mesh.position.copy(p);
                const speed = v.length();
                const width = 1.35;
                if (speed > 0.0005) {
                    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v.clone().normalize());
                    // Keep streak length formula unchanged; only widen the spark body.
                    const sLen = Math.min(1.15, 0.18 + speed * 9 * streakMul);
                    mesh.scale.set(width, width, sLen);
                } else {
                    mesh.scale.set(0.9, 0.9, 0.25);
                }
                const lifeRatio = 1 - (ageFrames / maxLife);
                mesh.material.opacity = Math.min(1, Math.pow(Math.max(0, lifeRatio), 1.1) * 1.25);
                mesh.visible = true;
            }
            return;
        }

        if (trigger.type !== 'explosion' && trigger.type !== 'flash' && trigger.type !== 'puff') return;

        let maxLife = trigger.type === 'flash' ? 8 : (trigger.type === 'puff' ? 60 : 60);
        if (ageFrames >= maxLife) return;

        let mgr = trigger.type === 'explosion' ? explosionManager : (trigger.type === 'flash' ? flashManager : puffManager);
        let pool = trigger.type === 'explosion' ? explosionPool : (trigger.type === 'flash' ? flashPool : puffPool);
        let countKey = trigger.type;

        if (mgr.isReady && activeCounts[countKey] < pool.length) {
            // Prefer a free slot; skip debris one-shots still playing.
            let mesh = pool.find((m) =>
                !(m.userData && typeof m.userData.debrisLife === 'number') && !m.visible
            );
            if (!mesh) return;
            mesh.position.copy(trigger.pos);
            if (trigger.type === 'puff' && trigger.drift) {
                mesh.position.add(trigger.drift.clone().multiplyScalar(ageFrames));
            }
            let currentZRot = trigger.rot + (trigger.type === 'puff' ? ageFrames * 0.05 : 0);
            mesh.userData.zRot = currentZRot;
            orientVfxBillboard(mesh, currentZRot);

            let lifeRatio = ageFrames / maxLife;
            if (trigger.type === 'flash') {
                let s = (trigger.scale || 1.0) * (1.0 - (lifeRatio * 0.4)); mesh.scale.set(s, s, s); mesh.material.opacity = 1.0 - Math.pow(lifeRatio, 2);
            } else if (trigger.type === 'puff') {
                let baseS = trigger.scale || 1.0;
                let baseO = (trigger.opacity !== undefined ? trigger.opacity : smokeCfg.baseOpacity);
                let s = (0.5 + (lifeRatio * 2.5)) * baseS;
                mesh.scale.set(s, s, s);
                mesh.material.opacity = (1.0 - Math.pow(lifeRatio, 2)) * baseO;
            } else if (trigger.type === 'explosion') {
                let s = (trigger.scale || 1.0) * (0.4 + (lifeRatio * 0.6));
                mesh.scale.set(s, s, s);
                mesh.material.opacity = (1.0 - Math.pow(lifeRatio, 1.5)) * Math.min(1, smokeCfg.baseOpacity + 0.35);
            }

            mgr.applyFrameToMesh(mesh, lifeRatio);
            mesh.visible = true; activeCounts[countKey]++;
        }
    });

    visualFlaresPool.forEach(f => f.visible = false); 
    let cFlares = currentLog.flaresTrack[trackIdx] || [];
    cFlares.forEach((cf, i) => {
        if (!visualFlaresPool[i]) { let nm = new THREE.Mesh(flareGeo, flareMats[0]); scene.add(nm); visualFlaresPool.push(nm); }
        let fMesh = visualFlaresPool[i]; fMesh.position.copy(cf.pos);
        if (cf.age === 0) { fMesh.material = flareMats[0]; fMesh.scale.set(0.5, 0.5, 0.5); } 
        else if (cf.age === 1) { fMesh.material = flareMats[1]; fMesh.scale.set(1.0, 1.0, 1.0); } 
        else { fMesh.material = flareMats[2]; fMesh.scale.set(1.5, 1.5, 1.5); }
        fMesh.visible = true;
    });

    const cChaff = (currentLog.chaffTrack && currentLog.chaffTrack[trackIdx]) || [];
    if (typeof updateChaffVisuals === 'function') {
        updateChaffVisuals(cChaff, typeof performance !== 'undefined' ? performance.now() : Date.now());
    } else if (GameContext.callService) {
        GameContext.callService('updateChaffVisuals', cChaff, typeof performance !== 'undefined' ? performance.now() : Date.now());
    }

    let bulletIdx = 0;
    const frameIds = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || ['red', 'blue'];
    frameIds.forEach(id => {
        let t = teams[id];
        if (!t || !t.wrapper) return;

        // Gone wrecks leave no log entry on later turns; keep them hidden.
        // Earlier turns still have path data — restore visibility so ACMI scrub shows wingmen again.
        if (!currentLog[id]) {
            t.wrapper.visible = false;
            return;
        }

        if (t.activeMissiles) {
            t.activeMissiles.forEach(am => {
                if (am.mesh) am.mesh.visible = false; 
            });
        }
        
        let hpNow = currentLog.hpTrack && currentLog.hpTrack[id]
            ? currentLog.hpTrack[id][trackIdx]
            : t.hp;
        let isDead = hpNow <= 0;
        let targetColorMultiplier = isDead ? 0.15 : 1.0; 
        
        if (t.wrapper.userData.isDeadState !== isDead) {
            t.wrapper.traverse(c => {
                if (c.isMesh && !c.isAAA_V3 && c.userData.origColor !== undefined) {
                    if (!t.wrapper.userData.exhaust || c.parent !== t.wrapper.userData.exhaust.group) {
                        let orig = new THREE.Color(c.userData.origColor);
                        c.material.color.setRGB(orig.r * targetColorMultiplier, orig.g * targetColorMultiplier, orig.b * targetColorMultiplier);
                    }
                }
            });
            t.wrapper.userData.isDeadState = isDead;
            
            if (t.wrapper.userData.exhaust) {
                t.wrapper.userData.exhaust.group.visible = !isDead;
            }
        }

        let currentPlanePos = t.wrapper.position.clone();
        let currentPlaneQuat = t.wrapper.quaternion.clone();
        const hasReplayPath = currentLog[id].pts && currentLog[id].quats && currentLog[id].pts.length >= 2 && currentLog[id].quats.length >= 2;
        // Drive mesh visibility from history — live finalizeWreck sets visible=false permanently.
        t.wrapper.visible = !!hasReplayPath;
        if (hasReplayPath) {
            currentPlanePos = getPosAt(animProgress, currentLog[id].pts); currentPlaneQuat = getQuatAt(animProgress, currentLog[id].quats);
            t.wrapper.position.copy(currentPlanePos); t.wrapper.quaternion.copy(currentPlaneQuat);
            if (id === tAct) { let adi = document.getElementById('adi-sky-ground'); if(adi) adi.style.transform = `rotate(${(new THREE.Euler().setFromQuaternion(currentPlaneQuat, 'YXZ').z * 180) / Math.PI}deg) translateY(${-(new THREE.Euler().setFromQuaternion(currentPlaneQuat, 'YXZ').x * 180) / Math.PI * 1.5}px)`; }
        } else {
            return;
        }

        if (t.userData && t.userData.gunPreview) t.userData.gunPreview.visible = false;
        let currentNosePos = currentPlanePos.clone().add(new THREE.Vector3(0, -0.2, 1.5).applyQuaternion(currentPlaneQuat));
        
        for (let age = 0; age <= 2; age++) {
            let logIdx = turnIdx - age; if (logIdx < 0) continue; let pastLog = battleLog[logIdx]; if (!pastLog || !pastLog[id]) continue;
            let logChain = pastLog[id].chain;
            if (logChain && logChain.length > 0 && logChain[0].fire === 'gun' && pastLog[id].pts && pastLog[id].pts.length >= 2) {
                let stats = CONFIG.aircrafts[t.type || 'mig21'].throttleStats[logChain[0].throttle || 2] || { gunRangeMult: 1.0 }; 
                let dRange = GUN_RANGE * stats.gunRangeMult;
                
                for (let b = 0; b < 24; b++) {
                    if (bulletIdx >= visualBullets.length) break;
                    let mesh = visualBullets[bulletIdx]; 
                    let t_spawn = (b / 23) * 0.95; 
                    let timeSinceSpawn = animProgress - t_spawn + age; 
                    if (timeSinceSpawn < 0 || timeSinceSpawn > 1.5) continue;
                    
                    let spawnPos = getPosAt(t_spawn, pastLog[id].pts); 
                    let spawnQuat = getQuatAt(t_spawn, pastLog[id].quats);
                    
                    let dt = 0.02; 
                    let acVelocity;
                    
                    if (t_spawn >= dt) {
                        let t_prev = t_spawn - dt;
                        let prevPos = getPosAt(t_prev, pastLog[id].pts);
                        acVelocity = new THREE.Vector3().subVectors(spawnPos, prevPos).divideScalar(dt);
                    } else {
                        let t_next = t_spawn + dt;
                        let nextPos = getPosAt(t_next, pastLog[id].pts);
                        acVelocity = new THREE.Vector3().subVectors(nextPos, spawnPos).divideScalar(dt);
                    }

                    let startPos = spawnPos.clone().add(new THREE.Vector3(0, -0.2, 1.5).applyQuaternion(spawnQuat));
                    let forward = new THREE.Vector3(0, 0, 1).applyQuaternion(spawnQuat);
                    
                    let spreadX = Math.sin(b * 123.45 + logIdx) * 0.015; let spreadY = Math.cos(b * 678.90 + logIdx) * 0.015;
                    let right = new THREE.Vector3(1, 0, 0).applyQuaternion(spawnQuat); let up = new THREE.Vector3(0, 1, 0).applyQuaternion(spawnQuat);
                    forward.add(right.multiplyScalar(spreadX)).add(up.multiplyScalar(spreadY)).normalize();
                    
                    let muzzleSpeed = dRange * 2.0; 
                    let bulletVelocity = forward.clone().multiplyScalar(muzzleSpeed).add(acVelocity);

                    let headPos = startPos.clone().add(bulletVelocity.clone().multiplyScalar(timeSinceSpawn));
                    
                    let gunGravMult = CONFIG.weapons['gun'].gravityMult !== undefined ? CONFIG.weapons['gun'].gravityMult : 1.0;
                    let gravDrop = 0.5 * (CONFIG.rules.gravity * gunGravMult) * (timeSinceSpawn * timeSinceSpawn);
                    headPos.y -= gravDrop;
                    
                    let tracerLen = 4; let tailPos;
                    if (age === 0 && (bulletVelocity.length() * timeSinceSpawn) < tracerLen) { 
                        tailPos = currentNosePos.clone(); 
                    } else { 
                        let visualDir = bulletVelocity.clone().normalize();
                        tailPos = headPos.clone().sub(visualDir.multiplyScalar(tracerLen)); 
                    }
                    
                    mesh.geometry.attributes.position.setXYZ(0, headPos.x, headPos.y, headPos.z); 
                    mesh.geometry.attributes.position.setXYZ(1, tailPos.x, tailPos.y, tailPos.z); 
                    mesh.geometry.attributes.position.needsUpdate = true;

                    let lifeRatio = Math.min(1.0, timeSinceSpawn / 1.5); 
                    let colAttr = mesh.geometry.attributes.color;

                    let curR = 1.0;
                    let curG = 1.0 - (lifeRatio * 0.9); 
                    let curB = 0.2 * (1.0 - lifeRatio); 

                    colAttr.setXYZ(0, curR, curG, curB); 
                    colAttr.setXYZ(1, curR * 0.8, curG * 0.8, curB * 0.8); 
                    colAttr.needsUpdate = true;
                    
                    mesh.material.opacity = Math.max(0, 1.0 - (timeSinceSpawn / 1.5)); 
                    mesh.visible = true;
                    bulletIdx++;
                }
            }
        }
        
        if (t.pylons) {
            t.pylons.forEach(p => {
                let mTracks = currentLog[`${id}MslTracks`] ? currentLog[`${id}MslTracks`][p.id] : null; 
                let explodeFrame = currentLog[`${id}ExplodedAt`] ? currentLog[`${id}ExplodedAt`][p.id] : undefined;
                
                const masterMissileOffset = typeof window.mslVisOffset !== 'undefined' ? window.mslVisOffset : new THREE.Vector3(0.0, 0.0, 0.0);
                const nozzleOffset = new THREE.Vector3(0.0, -0.51, -0.0);
                
                if (p.flyingMesh && !p.flyingMesh.isAAA_V3) {
                    scene.remove(p.flyingMesh);
                    p.flyingMesh = null;
                }
                
                if (mTracks) {
                    if (!p.flyingMesh && typeof missileMeshBase !== 'undefined' && missileMeshBase) {
                        p.flyingMesh = new THREE.Group(); 
                        p.flyingMesh.isAAA_V3 = true; 
                        
                        let mBody = missileMeshBase.clone(); 
                        mBody.traverse(c => { if(c.isMesh) c.visible = true; }); 
                        mBody.scale.set(2.5, 2.5, 2.5); 
                        p.flyingMesh.add(mBody);
                        
                        let fGlowGroup = new THREE.Group();
                        let fOuterMat = new THREE.MeshBasicMaterial({ map: sparkTexShared, color: 0xff4400, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
                        let fOuterGeo = new THREE.PlaneGeometry(0.3, 1.8); fOuterGeo.translate(0, -0.9, 0); fOuterGeo.rotateX(Math.PI / 2);  
                        let outer1 = new THREE.Mesh(fOuterGeo, fOuterMat); let outer2 = new THREE.Mesh(fOuterGeo, fOuterMat); outer2.rotateZ(Math.PI / 2); 
                        
                        let fInnerMat = new THREE.MeshBasicMaterial({ map: sparkTexShared, color: 0xffffff, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
                        let fInnerGeo = new THREE.PlaneGeometry(0.12, 0.8); fInnerGeo.translate(0, -0.4, 0); fInnerGeo.rotateX(Math.PI / 2); 
                        let inner1 = new THREE.Mesh(fInnerGeo, fInnerMat); let inner2 = new THREE.Mesh(fInnerGeo, fInnerMat); inner2.rotateZ(Math.PI / 2);
                        
                        let fHaloMat = new THREE.MeshBasicMaterial({ map: sparkTexShared, color: 0xff8800, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
                        let fHalo = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), fHaloMat); fHalo.name = 'halo';
                        
                        fGlowGroup.add(outer1, outer2, inner1, inner2, fHalo);
                        fGlowGroup.position.copy(nozzleOffset); 
                        
                        p.flyingGlowMesh = fGlowGroup; 
                        p.flyingMesh.add(p.flyingGlowMesh); 
                        scene.add(p.flyingMesh);
                    }
                    
                    let mTrack = mTracks[trackIdx];
                    if (mTrack && mTrack.pos && !isNaN(mTrack.pos.x)) { 
                        if (p.flyingMesh) {
                            let offset = masterMissileOffset.clone().applyQuaternion(mTrack.quat);
                            p.flyingMesh.position.copy(mTrack.pos).add(offset);
                            p.flyingMesh.quaternion.copy(mTrack.quat); 
                            p.flyingMesh.visible = true; 
                            
                            if (p.flyingGlowMesh) {
                                let pulseXY = 0.9 + Math.random() * 0.2; let pulseZ = 0.8 + Math.random() * 0.4;
                                p.flyingGlowMesh.scale.set(pulseXY, pulseXY, pulseZ); 
                                let halo = p.flyingGlowMesh.children.find(c => c.name === 'halo');
                                if (halo) { let invQ = p.flyingMesh.quaternion.clone().invert(); halo.quaternion.copy(invQ.multiply(camera.quaternion)); }
                            }
                        }
                    } else { 
                        if (p.flyingMesh) p.flyingMesh.visible = false; 
                    }
                    if (explodeFrame !== undefined && trackIdx >= explodeFrame) {
                        if (p.flyingMesh) p.flyingMesh.visible = false;
                    }
                    
                    const maxPts = 65; 
                    if (p.trailMesh && !p.trailMesh.isAAA_V3) { scene.remove(p.trailMesh); p.trailMesh = null; }
                    
                    if (!p.trailMesh) {
                        const tGeo = new THREE.BufferGeometry();
                        tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 3), 3));
                        tGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 3), 3));
                        tGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(maxPts * 2 * 2), 2));
                        const indices = []; for (let i = 0; i < maxPts - 1; i++) { indices.push(i*2, i*2+1, i*2+2); indices.push(i*2+2, i*2+1, i*2+3); } tGeo.setIndex(indices);
                        p.trailMesh = new THREE.Mesh(tGeo, mslTrailMatShared.clone());
                        p.trailMesh.frustumCulled = false; p.trailMesh.isAAA_V3 = true;
                        scene.add(p.trailMesh);
                    }
                    
                    let posArr = p.trailMesh.geometry.attributes.position.array; let colArr = p.trailMesh.geometry.attributes.color.array; let uvArr = p.trailMesh.geometry.attributes.uv.array;
                    let validPts = 0;
                    
                    for (let h = 0; h < maxPts; h++) {
                        let pastStep = trackIdx - h; let htmlPos = null; let histQuat = null;
                        if (pastStep >= 0) {
                            if (mTracks[pastStep] && mTracks[pastStep].pos) { htmlPos = mTracks[pastStep].pos.clone(); histQuat = mTracks[pastStep].quat; }
                        } else {
                            let prevTurnIdx = turnIdx - 1;
                            if (prevTurnIdx >= 0 && battleLog[prevTurnIdx] && battleLog[prevTurnIdx][`${id}MslTracks`] && battleLog[prevTurnIdx][`${id}MslTracks`][p.id]) {
                                let prevTracks = battleLog[prevTurnIdx][`${id}MslTracks`][p.id]; let prevStep = 100 + pastStep; 
                                if (prevStep >= 0 && prevTracks[prevStep] && prevTracks[prevStep].pos) { htmlPos = prevTracks[prevStep].pos.clone(); histQuat = prevTracks[prevStep].quat; }
                            }
                        }
                        
                        if (htmlPos && histQuat) {
                            let lifeRatio = h / maxPts; 
                            let offset = masterMissileOffset.clone().applyQuaternion(histQuat);
                            htmlPos.add(offset);
                            
                            let localNozzle = nozzleOffset.clone().applyQuaternion(histQuat);
                            let nozzlePos = htmlPos.clone().add(localNozzle);
                            
                            let width = 0.05 + (lifeRatio * 1.5); 
                            let toCam = new THREE.Vector3().subVectors(camera.position, nozzlePos).normalize();
                            let right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,0,1).applyQuaternion(histQuat).normalize(), toCam);
                            if (right.lengthSq() < 0.0001) right.set(1,0,0).applyQuaternion(histQuat);
                            right.normalize().multiplyScalar(width);
                            
                            let leftP = nozzlePos.clone().add(right); let rightP = nozzlePos.clone().sub(right);
                            let idx = validPts * 2;
                            posArr[idx*3+0] = leftP.x;  posArr[idx*3+1] = leftP.y;  posArr[idx*3+2] = leftP.z;
                            posArr[idx*3+3] = rightP.x; posArr[idx*3+4] = rightP.y; posArr[idx*3+5] = rightP.z;
                            
                            let intensity = Math.pow(1.0 - lifeRatio, 1.8); 
                            let r = intensity * 1.0; let g = intensity * 0.9; let b = intensity * 0.8;
                            colArr[idx*3+0] = r; colArr[idx*3+1] = g; colArr[idx*3+2] = b; colArr[idx*3+3] = r; colArr[idx*3+4] = g; colArr[idx*3+5] = b;
                            
                            let v = h / maxPts; uvArr[idx*2+0] = 0; uvArr[idx*2+1] = v; uvArr[idx*2+2] = 1; uvArr[idx*2+3] = v;
                            validPts++;
                        }
                    }
                    
                    if (validPts > 1) { p.trailMesh.geometry.setDrawRange(0, (validPts - 1) * 6); p.trailMesh.geometry.attributes.position.needsUpdate = true; p.trailMesh.geometry.attributes.color.needsUpdate = true; p.trailMesh.geometry.attributes.uv.needsUpdate = true; p.trailMesh.visible = true; } else { p.trailMesh.visible = false; }
                } else { if (p.flyingMesh) p.flyingMesh.visible = false; if (p.trailMesh) p.trailMesh.visible = false; }
            });
        }
    });

    for (; bulletIdx < visualBullets.length; bulletIdx++) { visualBullets[bulletIdx].visible = false; }
}

// ============================================================================
// 🏙️ 3D 城市地圖加載引擎 (完美保留模型原色 / 淺灰軍規切換完全體)
// ============================================================================
function loadCityGlbFallback() {
    return new Promise((resolve) => {
        const gltfLoader = new THREE.GLTFLoader();
        const cityUrl = CONFIG.assets.models.city;
        if (CONFIG.debug) console.log(`⏳ 開始加載城市模型 (${cityUrl})...`);

        gltfLoader.load(
            cityUrl,
            function (gltf) {
                const cityModel = gltf.scene;
                cityModel.name = "TACTICAL_CITY_MESH";
                cityRoot = cityModel;

                // 🟢 控制開關：如果你想放棄模型原色，全部強制換成「軍規淺灰色」，請把 false 改成 true
                const FORCE_LIGHT_GRAY = false;

                // 註冊 CSS 全域幾何變數大腦
                document.documentElement.style.setProperty('--city-scale', '1.0');
                document.documentElement.style.setProperty('--city-x', '0');
                document.documentElement.style.setProperty('--city-z', '0');
                document.documentElement.style.setProperty('--city-y', '0');

                // 即時變數連動公式
                window.updateCityGeometry = function() {
                    const s = parseFloat(document.documentElement.style.getPropertyValue('--city-scale') || 1.0);
                    const x = parseFloat(document.documentElement.style.getPropertyValue('--city-x') || 0);
                    const y = parseFloat(document.documentElement.style.getPropertyValue('--city-y') || 0);
                    const z = parseFloat(document.documentElement.style.getPropertyValue('--city-z') || 0);

                    cityModel.scale.set(0.15, 0.15, 0.15);
                    cityModel.position.set(9.5, 0, 20);
                };

                window.updateCityGeometry();

                // 建立淺灰色材質備用
                const lightGrayMaterial = new THREE.MeshStandardMaterial({
                    color: 0xc8c8c8,
                    roughness: 0.88,
                    metalness: 0.04
                });

                // 遍歷 3D 城市模型的每一個子網格
                cityModel.traverse(function (child) {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;

                        if (FORCE_LIGHT_GRAY) {
                            // 🧱 方案 A：強制換成高質感淺灰色
                            child.material = lightGrayMaterial;
                        } else {
                            // 🎨 方案 B：保留原色，略提高霧面以減弱硬光高光
                            if (child.material) {
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
                            }
                        }

                        // Store city meshes separately; arena mode decides if they enter the active collision matrix.
                        cityObstacles.push(child);
                    }
                });

                scene.add(cityModel);
                cityModel.updateMatrixWorld(true);
                cityObstacles.forEach((child) => {
                    const proxy = buildCityCollisionProxy(child);
                    if (!proxy) return;
                    scene.add(proxy);
                    cityCollisionProxies.push(proxy);
                });
                applyArenaMode();
                if (CONFIG.debug) console.log(`🏙️ [加載成功] 城市模型部署完畢。已登記 ${cityObstacles.length} 個建築網格，${cityCollisionProxies.length} 個足跡代理碰撞。`);
                activeMapMeta = { id: 'original', path: null, doc: null, aiMapPath: null };
                refreshAirArenaAiMap({ mapId: 'original', reason: 'city-glb' });
                resolve(cityRoot);
            },
            function (xhr) {
                if (CONFIG.debug && xhr.total > 0) console.log(`⏳ 城市下載進度: ${(xhr.loaded / xhr.total * 100).toFixed(1)}%`);
            },
            function (error) {
                console.warn(`❌ 城市模型載入失敗 (${cityUrl})，改用程序建築群。`, error);
                cityRoot = window.AssetFallbacks.buildProceduralCity(scene, cityObstacles);
                cityRoot.updateMatrixWorld(true);
                applyArenaMode();
                activeMapMeta = { id: 'original', path: null, doc: null, aiMapPath: null };
                refreshAirArenaAiMap({ mapId: 'original', reason: 'procedural-city' });
                resolve(cityRoot);
            }
        );
    });
}

function finishMapBuild(root, mapDoc) {
    cityRoot = root;
    cityObstacles.forEach((child) => {
        const proxy = buildCityCollisionProxy(child);
        if (!proxy) return;
        scene.add(proxy);
        cityCollisionProxies.push(proxy);
    });
    // Authored maps can span ~1km; editor uses far=2000.
    if (mapDoc && mapDoc.ground && typeof camera !== 'undefined') {
        const span = Math.max(Number(mapDoc.ground.width) || 0, Number(mapDoc.ground.depth) || 0);
        camera.far = Math.max(1000, span * 1.5 + 400);
        camera.updateProjectionMatrix();
    }
    applyArenaMode();
}

/**
 * Load sidecar assets/maps/<id>.ai-map.json or bake from doc/obstacles into GameContext.three.aiMap.
 */
function refreshAirArenaAiMap(opts = {}) {
    const api = (typeof AirArenaAiMap !== 'undefined') ? AirArenaAiMap : null;
    if (!api || typeof api.ensureAiMap !== 'function') return Promise.resolve(null);

    const meta = activeMapMeta || {};
    const mapId = opts.mapId || meta.id || 'original';
    const ground = (opts.doc && opts.doc.ground) || (meta.doc && meta.doc.ground) || null;
    const job = api.ensureAiMap({
        mapId,
        mapPath: opts.mapPath || meta.path || null,
        aiMapPath: opts.aiMapPath || meta.aiMapPath || null,
        doc: opts.doc || meta.doc || null,
        obstacles: (typeof obstacles !== 'undefined' && obstacles.length) ? obstacles : cityObstacles,
        originX: ground ? (Number(ground.centerX) || 0) - (Number(ground.width) || 900) * 0.5 : undefined,
        originZ: ground ? (Number(ground.centerZ) || 0) - (Number(ground.depth) || 900) * 0.5 : undefined,
        width: ground ? Number(ground.width) || 900 : undefined,
        depth: ground ? Number(ground.depth) || 900 : undefined
    }).then((map) => {
        if (api.installOnGameContext) api.installOnGameContext(map);
        else if (GameContext && GameContext.three) GameContext.three.aiMap = map;
        if (CONFIG.debug && map) {
            console.log(
                `[AiMap] source=${map.source} id=${map.mapId || mapId} ` +
                `${map.cols}x${map.rows} cell=${map.cellSize} (${opts.reason || 'refresh'})`
            );
        }
        return map;
    }).catch((err) => {
        console.warn('[AiMap] refresh failed', err);
        if (GameContext && GameContext.three) GameContext.three.aiMap = null;
        return null;
    });
    return job;
}
window.refreshAirArenaAiMap = refreshAirArenaAiMap;

/**
 * Apply map chosen on Match Setup. Original leaves city.glb / buildings untouched
 * unless a custom map was previously applied this session.
 * @param {string} mapId
 * @returns {Promise<void>}
 */
function applySelectedMap(mapId) {
    const resolvePlan = window.MapCatalog
        ? (typeof window.MapCatalog.resolveAsync === 'function'
            ? window.MapCatalog.resolveAsync(mapId)
            : Promise.resolve(window.MapCatalog.resolve(mapId)))
        : Promise.resolve({ id: 'original', mode: 'original' });

    return resolvePlan.then((plan) => {
        if (plan.mode === 'original') {
            activeMapMeta = { id: 'original', path: null, doc: null, aiMapPath: null };
            if (typeof AirArenaArenaEnvelope !== 'undefined' && AirArenaArenaEnvelope.applyFromMapDoc) {
                AirArenaArenaEnvelope.applyFromMapDoc({
                    name: 'original',
                    ground: ORIGINAL_ENV.ground,
                    envelope: {
                        diameter: Math.max(ORIGINAL_ENV.ground.width, ORIGINAL_ENV.ground.depth),
                        centerX: ORIGINAL_ENV.ground.centerX,
                        centerZ: ORIGINAL_ENV.ground.centerZ
                    }
                });
            }
            if (!usingCustomMap) {
                if (CONFIG.debug) console.log('[Map] 維持原版地圖');
                return refreshAirArenaAiMap({ mapId: 'original', reason: 'original-keep' });
            }
            clearCityScene();
            restoreOriginalEnvironment();
            usingCustomMap = false;
            if (typeof camera !== 'undefined') {
                camera.far = 1000;
                camera.updateProjectionMatrix();
            }
            return loadCityGlbFallback().then(() =>
                refreshAirArenaAiMap({ mapId: 'original', reason: 'original-restore' })
            );
        }

        if (!window.MapLoader || !plan.doc) {
            console.warn('[Map] 自訂地圖無效，維持現況');
            return;
        }

        clearCityScene();
        usingCustomMap = true;
        const packaged = window.MapCatalog && window.MapCatalog.getPackaged
            ? window.MapCatalog.getPackaged(plan.id)
            : null;
        activeMapMeta = {
            id: plan.id,
            path: packaged && packaged.path ? packaged.path : null,
            aiMapPath: packaged && packaged.aiMapPath ? packaged.aiMapPath : null,
            doc: plan.doc
        };
        return window.MapLoader
            .buildMap(plan.doc, scene, cityObstacles, ground, getMapEnvContext())
            .then((root) => {
                finishMapBuild(root, plan.doc);
                if (CONFIG.debug) console.log(`🗺️ [自訂地圖] ${plan.id} obstacles=${cityObstacles.length}`);
                return refreshAirArenaAiMap({
                    mapId: plan.id,
                    mapPath: activeMapMeta.path,
                    aiMapPath: activeMapMeta.aiMapPath,
                    doc: plan.doc,
                    reason: 'custom-map'
                });
            })
            .catch((err) => {
                console.warn('[Map] 自訂地圖載入失敗，還原原版', err);
                clearCityScene();
                restoreOriginalEnvironment();
                usingCustomMap = false;
                activeMapMeta = { id: 'original', path: null, doc: null, aiMapPath: null };
                if (typeof camera !== 'undefined') {
                    camera.far = 1000;
                    camera.updateProjectionMatrix();
                }
                return loadCityGlbFallback().then(() =>
                    refreshAirArenaAiMap({ mapId: 'original', reason: 'custom-fallback' })
                );
            });
    });
}

function initCityMapModel() {
    if (typeof obstacles === 'undefined') window.obstacles = [];
    // Always boot with original city.glb → procedural buildings. Custom maps apply at ENGAGE.
    loadCityGlbFallback();
}

// 啟動城市地圖（原版）
initCityMapModel();

// ============================================================================
// 作戰空域：地面硬邊圈 + 人類接近邊界時的半透明黃色斜槓封鎖膠帶
// ============================================================================
(function initCombatAirspaceVfx() {
    const TAPE_H = 12;
    const TAPE_STYLE = 4; // bump when stripe/text look changes
    const state = {
        group: null,
        rim: null,
        tape: null,
        tapeTex: null,
        tapeMat: null,
        tapeStyle: 0,
        builtRadius: -1,
        builtCx: null,
        builtCz: null,
        builtTapeH: -1
    };

    function makeCautionTapeTexture() {
        // One period: 10 elongated yellow diagonals (wide gaps) + warning caption.
        // Keep period wide so UV repeats stay low and text stays readable on R≈450 ring.
        const stripeW = 56;
        const gapW = 48;
        const stripeCount = 10;
        const textPanelW = 420;
        const slant = 44;
        const h = 128;
        const period = stripeCount * (stripeW + gapW) + textPanelW;
        const canvas = document.createElement('canvas');
        canvas.width = period;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, period, h);

        ctx.fillStyle = 'rgba(255, 214, 0, 0.92)';
        let x = 0;
        for (let i = 0; i < stripeCount; i++) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x + stripeW, 0);
            ctx.lineTo(x + stripeW + slant, h);
            ctx.lineTo(x + slant, h);
            ctx.closePath();
            ctx.fill();
            x += stripeW + gapW;
        }

        const label = '離開作戰空域警告';
        const cx = x + textPanelW * 0.5;
        const cy = h * 0.5;
        ctx.font = 'bold 52px "Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Soft outline so yellow text reads on sky / city without black bars.
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(120, 90, 0, 0.55)';
        ctx.strokeText(label, cx, cy);
        ctx.fillStyle = 'rgba(255, 230, 60, 0.98)';
        ctx.fillText(label, cx, cy);

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // ~2 cycles around hard ring so each caption + 10-stripe group is large.
        const approxR = 450;
        const repeats = Math.max(2, Math.round((2 * Math.PI * approxR) / period));
        tex.repeat.set(repeats, 1);
        tex.needsUpdate = true;
        return tex;
    }

    function clearChild(mesh) {
        if (!mesh) return;
        if (state.group) state.group.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material && mesh.material !== state.tapeMat) {
            if (mesh.material.map && mesh.material.map !== state.tapeTex) mesh.material.map.dispose();
            mesh.material.dispose();
        }
    }

    function ensureTapeMaterial() {
        if (state.tapeStyle === TAPE_STYLE && state.tapeTex && state.tapeMat) return;
        if (state.tapeTex) {
            state.tapeTex.dispose();
            state.tapeTex = null;
        }
        state.tapeTex = makeCautionTapeTexture();
        if (!state.tapeMat) {
            state.tapeMat = new THREE.MeshBasicMaterial({
                map: state.tapeTex,
                transparent: true,
                opacity: 0.72,
                side: THREE.DoubleSide,
                depthWrite: false,
                alphaTest: 0.08,
                fog: true
            });
        } else {
            state.tapeMat.map = state.tapeTex;
            state.tapeMat.opacity = 0.72;
            state.tapeMat.alphaTest = 0.08;
            state.tapeMat.needsUpdate = true;
        }
        state.tapeStyle = TAPE_STYLE;
        state.builtTapeH = -1; // force cylinder rebuild with new look
    }

    function ensureCombatAirspaceMeshes(a) {
        if (!state.group) {
            state.group = new THREE.Group();
            state.group.name = 'COMBAT_AIRSPACE_VFX';
            state.group.renderOrder = 2;
            scene.add(state.group);
        }
        ensureTapeMaterial();

        const needRebuild =
            Math.abs(state.builtRadius - a.radius) > 0.5 ||
            state.builtCx !== a.cx ||
            state.builtCz !== a.cz ||
            state.builtTapeH !== TAPE_H;

        if (!needRebuild) return;

        clearChild(state.rim);
        clearChild(state.tape);
        state.rim = null;
        state.tape = null;

        const rimInner = Math.max(1, a.radius - 1.8);
        const rimOuter = a.radius + 1.8;
        const rimGeo = new THREE.RingGeometry(rimInner, rimOuter, 128);
        const rimMat = new THREE.MeshBasicMaterial({
            color: 0xffe066,
            transparent: true,
            opacity: 0.14,
            side: THREE.DoubleSide,
            depthWrite: false,
            fog: true
        });
        state.rim = new THREE.Mesh(rimGeo, rimMat);
        state.rim.name = 'COMBAT_AIRSPACE_RIM';
        state.rim.rotation.x = -Math.PI / 2;
        state.rim.position.y = 0.35;
        state.group.add(state.rim);

        const tapeGeo = new THREE.CylinderGeometry(a.radius, a.radius, TAPE_H, 96, 1, true);
        state.tape = new THREE.Mesh(tapeGeo, state.tapeMat);
        state.tape.name = 'COMBAT_AIRSPACE_TAPE';
        state.tape.visible = false;
        state.group.add(state.tape);

        state.group.position.set(a.cx, 0, a.cz);
        state.builtRadius = a.radius;
        state.builtCx = a.cx;
        state.builtCz = a.cz;
        state.builtTapeH = TAPE_H;
    }

    function updateCombatAirspaceVfx() {
        if (typeof getCombatAirspace !== 'function') return;
        const a = getCombatAirspace();
        if (!a || !a.enabled) {
            if (state.group) state.group.visible = false;
            return;
        }

        ensureCombatAirspaceMeshes(a);
        state.group.visible = true;
        state.group.position.set(a.cx, 0, a.cz);

        if (state.rim) {
            state.rim.visible = true;
            if (state.rim.material) state.rim.material.opacity = 0.12;
        }

        let showTape = false;
        let pressureT = 0;
        let alt = 36;
        try {
            const id = (typeof GameContext !== 'undefined' && GameContext.getActiveTeamId)
                ? GameContext.getActiveTeamId()
                : null;
            const t = (id && typeof teams !== 'undefined') ? teams[id] : null;
            if (
                t &&
                t.wrapper &&
                !t.isDestroyed &&
                !t.aiEnabled &&
                typeof getAirspacePressure === 'function'
            ) {
                const p = getAirspacePressure(t.wrapper.position);
                // Show from warnMargin (200) inward of hard edge.
                if (p && (p.band === 'warn' || p.band === 'outside')) {
                    showTape = true;
                    pressureT = Number(p.t) || 0;
                    alt = Math.max(10, Math.min(140, Number(t.wrapper.position.y) || 36));
                }
            }
        } catch (_) { /* ignore */ }

        if (!state.tape) return;
        state.tape.visible = showTape;
        if (!showTape) return;

        state.tape.position.y = alt;
        if (state.tapeMat) {
            state.tapeMat.opacity = 0.55 + 0.35 * Math.max(0, Math.min(1, pressureT));
        }
        if (state.tapeTex) {
            state.tapeTex.offset.x = (performance.now() * 0.00009) % 1;
            state.tapeTex.needsUpdate = true;
        }
    }

    window.updateCombatAirspaceVfx = updateCombatAirspaceVfx;
})();

GameContext.three = {
    scene,
    camera,
    renderer,
    controls,
    obstacles,
    cityObstacles,
    cityCollisionProxies,
    cityRoot,
    aiMap: null,
    applyArenaMode,
    applySelectedMap,
    refreshAirArenaAiMap,
    threatEnvGroup,
    get ghost() {
        return {
            wrapper: window.ghostWrapper,
            ring: window.ghostRing,
            ctx: window.ghostCtx,
            tex: window.ghostTex,
            planeMesh: window.ghostPlaneMesh || null
        };
    }
};

GameContext.registerService('setArenaMode', applyArenaMode);
GameContext.registerService('applySelectedMap', applySelectedMap);
try {
    const savedArenaMode = window.localStorage && window.localStorage.getItem('airArenaArenaMode');
    if (savedArenaMode) GameContext.state.arenaMode = GameContext.sanitizeArenaMode(savedArenaMode);
} catch (_) {}
applyArenaMode();
