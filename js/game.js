// ============================================================================
// game.js - UI 橋樑、模型載入、主迴圈與 ACMI 重播系統 (無塵乾淨版)
// ============================================================================

const loader = new THREE.GLTFLoader();

// ============================================================================
// 🌟 尾焰生成器與模型掛載
// ============================================================================
function createExhaust() {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 512;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 128, 512);
    ctx.fillStyle = '#fff'; ctx.shadowBlur = 10; ctx.shadowColor = '#fff';
    for(let y=30; y<512; y+=80) { ctx.beginPath(); ctx.ellipse(64,y,64,15,0,0,Math.PI*2); ctx.fill(); }
    const machTex = new THREE.CanvasTexture(canvas); machTex.wrapS = machTex.wrapT = THREE.RepeatWrapping; 
    
    const canvas2 = document.createElement('canvas'); canvas2.width = 128; canvas2.height = 256;
    const ctx2 = canvas2.getContext('2d'); ctx2.fillStyle = '#000'; ctx2.fillRect(0, 0, 128, 256);
    ctx2.fillStyle = '#fff'; ctx2.shadowBlur = 5; ctx2.shadowColor = '#fff';
    for(let i=0; i<30; i++) ctx2.fillRect(Math.random()*128, 0, 2+Math.random()*3, 256);
    const outerTex = new THREE.CanvasTexture(canvas2); outerTex.wrapS = outerTex.wrapT = THREE.RepeatWrapping;

    const exhaustGroup = new THREE.Group(); 
    exhaustGroup.position.set(0, -0.08, -0.49);
    
    const innerMat = new THREE.MeshBasicMaterial({ map: machTex, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const outerMat = new THREE.MeshBasicMaterial({ map: outerTex, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    
    const flameLength = 2.0;
    const geoOuter = new THREE.CylinderGeometry(0.12, 0.05, flameLength, 16, 32, true);
    const geoInner = new THREE.CylinderGeometry(0.06, 0.02, flameLength, 16, 32, true);
    
    function applyFlameGradient(geo, length) {
        const count = geo.attributes.position.count; const colors = new Float32Array(count * 3); const pos = geo.attributes.position;
        const cY = new THREE.Color(1,1,0.6), cO = new THREE.Color(1,0.4,0), cB = new THREE.Color(0,0.3,1), cBlk = new THREE.Color(0,0,0);
        let tC = new THREE.Color();
        for(let i=0; i<count; i++) {
            let r = 1.0 - ((pos.getY(i) + length/2) / length);
            if(r<0.2) tC.lerpColors(cY,cO,r/0.2); else if(r<0.6) tC.lerpColors(cO,cB,(r-0.2)/0.4); else tC.lerpColors(cB,cBlk,(r-0.6)/0.4);
            colors[i*3]=tC.r; colors[i*3+1]=tC.g; colors[i*3+2]=tC.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    applyFlameGradient(geoOuter, flameLength); applyFlameGradient(geoInner, flameLength);
    [geoOuter, geoInner].forEach(g => { g.rotateX(Math.PI/2); g.translate(0, 0, -flameLength/2); });
    
    exhaustGroup.add(new THREE.Mesh(geoOuter, outerMat)); exhaustGroup.add(new THREE.Mesh(geoInner, innerMat));

    return { group: exhaustGroup, machTex: machTex, outerTex: outerTex };
}

function setupModel(gltfOrScene, x, z, yRot) {
    const source = gltfOrScene.scene || gltfOrScene;
    const model = source.clone(true);
    
    model.traverse(c => { 
        if (c.isMesh && c.material) { 
            c.castShadow = true;
            c.receiveShadow = true;
            c.material = c.material.clone();
            if (c.material.color) { c.userData.origColor = c.material.color.getHex(); }
        } 
    });

    const box = new THREE.Box3().setFromObject(model); const scale = 1.2 / Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).y, box.getSize(new THREE.Vector3()).z); model.scale.set(scale, scale, scale); const center = box.getCenter(new THREE.Vector3()); model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    const wrapper = new THREE.Group(); wrapper.add(model); 

    let exhaust = createExhaust();
    wrapper.add(exhaust.group);         
    wrapper.userData.exhaust = exhaust; 

    wrapper.position.set(x, 45, z); wrapper.rotation.y = yRot; wrapper.userData.logicalQuat = wrapper.quaternion.clone(); scene.add(wrapper); 
    return wrapper;
}

function loadModelAsync(url) {
    return new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
    });
}

async function loadModelWithFallback(url, fallbackColor) {
    try {
        return await loadModelAsync(url);
    } catch (error) {
        console.warn(`⚠ 模型缺失 (${url})，使用程序替代機型。`, error);
        return window.AssetFallbacks.createProceduralAircraftGltf(fallbackColor);
    }
}

async function bootGame() {
    try {
        const modelPaths = CONFIG.assets.models;
        const [redGltf, blueGltf, foxGltf] = await Promise.all([
            loadModelWithFallback(modelPaths.red, 0xff0055),
            loadModelWithFallback(modelPaths.blue, 0x00bcd4),
            loadModelAsync(modelPaths.fox2).catch(() => null)
        ]);
        await GameContext.vfxReadyPromise;

        GameContext.registerTeamWrapper('red', setupModel(redGltf, 10, -50, 0));
        GameContext.registerTeamWrapper('red2', setupModel(redGltf, 18, -54, 0));
        GameContext.registerTeamWrapper('blue', setupModel(blueGltf, 10, 50, Math.PI));
        GameContext.registerTeamWrapper('blue2', setupModel(blueGltf, 18, 54, Math.PI));
        // Wings stay invisible until Match Setup selects 2v2.
        ['red2', 'blue2'].forEach((id) => {
            const t = GameContext.getTeam(id);
            if (t) t.matchActive = false;
            if (t && t.wrapper) t.wrapper.visible = false;
        });
        // Guarantee mutual nose-on before planning (logicalQuat drives sim).
        if (GameContext.stateMachine && typeof GameContext.stateMachine.faceOpponent === 'function') {
            GameContext.stateMachine.faceOpponent('red');
            GameContext.stateMachine.faceOpponent('blue');
        }

        if (foxGltf) {
            const m = foxGltf.scene; 
            m.traverse(c => { if(c.isMesh) c.material = new THREE.MeshBasicMaterial({ color: 0xdddddd }); });
            const b = new THREE.Box3().setFromObject(m); 
            const s = 1.0 / Math.max(b.getSize(new THREE.Vector3()).x, b.getSize(new THREE.Vector3()).y, b.getSize(new THREE.Vector3()).z); 
            m.scale.set(s*MISSILE_SCALE, s*MISSILE_SCALE, s*MISSILE_SCALE); 
            m.rotation.set(MISSILE_ROT_X, MISSILE_ROT_Y, MISSILE_ROT_Z); 
            const c = b.getCenter(new THREE.Vector3()); 
            m.position.set(-c.x*s, -c.y*s, -c.z*s);
            missileMeshBase = m;
        } else {
            missileMeshBase = GameContext.callService('createProceduralMissileMesh');
            if (!missileMeshBase && typeof createProceduralMissileMesh === 'function') {
                missileMeshBase = createProceduralMissileMesh();
            }
            if (missileMeshBase) missileMeshBase.position.set(0, 0, 0); 
        }

        checkInit();

    } catch (error) {
        console.error("💥 啟動失敗：", error);
        let startup = document.getElementById('startup-screen');
        if (startup) {
            startup.innerHTML = '<div id="startup-text" style="color:#ff3355;">BOOT FAILED<br><span style="font-size:16px;">請確認本地伺服器已啟動且資源路徑正確</span></div>';
        }
    }
}

bootGame();

function selectTeam(teamId) {
    if (GameContext.isReplayMode()) return;
    const t = GameContext.getTeam(teamId);
    if (!t || t.matchActive === false) return;
    GameContext.setActiveTeamId(teamId);
    const active = GameContext.getActiveTeam();
    const faction = (GameContext.getFaction && GameContext.getFaction(teamId)) || teamId;
    document.body.className = `theme-${faction}`;
    zoomToAircraft(teamId);
    GameContext.state.cameraSoftFollow = true;
    GameContext.state.cameraZoomUntil = performance.now() + 520;
    GameContext.state.cameraFollowOverrideId = null;
    if (typeof window.uiSyncSelectionChrome === 'function') {
        window.uiSyncSelectionChrome(teamId);
    }
    // Avoid tactical preview reset while combat animation is playing.
    if (!GameContext.isAnimating()) {
        if (typeof updateDashboardUI === 'function') updateDashboardUI(active);
        GameContext.callService('updateTacticalPreview', active);
    } else if (typeof updateDashboardUI === 'function' && active && !active.aiEnabled) {
        updateDashboardUI(active);
    }
}

function zoomToAircraft(teamId) {
    const t = GameContext.getTeam(teamId) || GameContext.getActiveTeam();
    if (!t || !t.wrapper || GameContext.isReplayMode()) return;
    if (typeof camera === 'undefined' || typeof controls === 'undefined') return;
    const token = (GameContext.state.cameraZoomToken = (GameContext.state.cameraZoomToken || 0) + 1);
    const startTime = performance.now();
    const startCamPos = camera.position.clone();
    const startTarget = controls.target.clone();
    function doLerp(now) {
        if (token !== GameContext.state.cameraZoomToken) return;
        let elapsed = (now - startTime) / 500;
        if (elapsed > 1) elapsed = 1;
        // Re-read live position so combat-anim clicks track the moving jet.
        const live = GameContext.getTeam(teamId);
        if (!live || !live.wrapper) return;
        const look = resolveChaseLookTeam(live);
        const pose = getAircraftChaseCamPose(live, look);
        camera.position.lerpVectors(startCamPos, pose.camPos, elapsed);
        controls.target.lerpVectors(startTarget, pose.targetPos, elapsed);
        if (elapsed < 1) requestAnimationFrame(doLerp);
    }
    requestAnimationFrame(doLerp);
}

/** Predetermined chase distance from selected aircraft (world units). */
const CHASE_CAM_DIST = 8;
/** Seat-select default: place aircraft this fraction of viewport height lower in frame. */
const CHASE_CAM_FRAME_DOWN = 0.10;
const _chaseAway = new THREE.Vector3();

/** Prefer explicit camera override, else the selected aircraft's locked target. */
function resolveChaseLookTeam(host) {
    if (!host) return null;
    const overrideId = GameContext.state.cameraFollowOverrideId;
    if (overrideId) {
        const ov = GameContext.getTeam(overrideId);
        if (ov && ov.wrapper && !ov.isDestroyed && ov.matchActive !== false) return ov;
    }
    const lockId = host.lockedTargetId;
    if (lockId) {
        const lk = GameContext.getTeam(lockId);
        if (lk && lk.wrapper && !lk.isDestroyed && lk.matchActive !== false) return lk;
    }
    return null;
}

/**
 * Camera CHASE_CAM_DIST from selected aircraft; when a lock exists, sit on the aircraft→target axis
 * (aircraft as pivot) and aim at the locked target.
 * No-lock (team-button default): bias look-at up so the jet sits ~10% lower in frame.
 */
function getAircraftChaseCamPose(host, lookTeam) {
    const hostPos = host.wrapper.position;
    const quat = host.wrapper.quaternion;
    let targetPos;
    if (lookTeam && lookTeam.wrapper) {
        targetPos = lookTeam.wrapper.position.clone();
        _chaseAway.subVectors(hostPos, targetPos);
        if (_chaseAway.lengthSq() < 1e-4) {
            _chaseAway.set(0, 0.2, -1).applyQuaternion(quat);
        }
    } else {
        // No lock: behind the nose, orbit pivot on the aircraft.
        _chaseAway.set(0, 0.22, -1).applyQuaternion(quat);
        targetPos = hostPos.clone();
    }
    _chaseAway.normalize();
    // Mild elevation, then re-normalize so distance stays exactly CHASE_CAM_DIST.
    _chaseAway.y += 0.16;
    if (_chaseAway.lengthSq() < 1e-6) _chaseAway.set(0, 0.35, -1).applyQuaternion(quat);
    _chaseAway.normalize();
    const camPos = hostPos.clone().addScaledVector(_chaseAway, CHASE_CAM_DIST);
    // Default seat framing: raise look-at so aircraft sits ~10% lower on screen.
    if (!lookTeam) {
        const fovDeg = (typeof camera !== 'undefined' && Number.isFinite(camera.fov)) ? camera.fov : 60;
        const viewHalfH = CHASE_CAM_DIST * Math.tan((fovDeg * Math.PI / 180) * 0.5);
        targetPos.y += viewHalfH * 2 * CHASE_CAM_FRAME_DOWN;
    }
    return { camPos, targetPos };
}

/** Keep chase-cam on host aircraft, but aim look-at toward another unit (e.g. locked enemy). */
function lookAtFromAircraft(hostId, lookAtId) {
    const host = GameContext.getTeam(hostId);
    const look = GameContext.getTeam(lookAtId);
    if (!host || !host.wrapper || !look || !look.wrapper || GameContext.isReplayMode()) return;
    if (typeof camera === 'undefined' || typeof controls === 'undefined') return;
    const token = (GameContext.state.cameraZoomToken = (GameContext.state.cameraZoomToken || 0) + 1);
    const startTime = performance.now();
    const startCamPos = camera.position.clone();
    const startTarget = controls.target.clone();
    function doLerp(now) {
        if (token !== GameContext.state.cameraZoomToken) return;
        let elapsed = (now - startTime) / 450;
        if (elapsed > 1) elapsed = 1;
        const h = GameContext.getTeam(hostId);
        const l = GameContext.getTeam(lookAtId);
        if (!h || !h.wrapper || !l || !l.wrapper) return;
        const pose = getAircraftChaseCamPose(h, l);
        camera.position.lerpVectors(startCamPos, pose.camPos, elapsed);
        controls.target.lerpVectors(startTarget, pose.targetPos, elapsed);
        if (elapsed < 1) requestAnimationFrame(doLerp);
    }
    requestAnimationFrame(doLerp);
}

function zoomToSelf() {
    zoomToAircraft(GameContext.getActiveTeamId());
}

function findHumanLockOwnerForHostile(hostileId) {
    const hostileFaction = GameContext.getFaction ? GameContext.getFaction(hostileId) : null;
    if (!hostileFaction) return null;
    const living = (GameContext.getLivingTeamIds && GameContext.getLivingTeamIds()) || [];
    const humans = living.filter((id) => {
        const t = teams[id];
        if (!t || t.aiEnabled || t.isDestroyed) return false;
        const f = GameContext.getFaction ? GameContext.getFaction(id) : id;
        return f && f !== hostileFaction;
    });
    if (!humans.length) return null;
    const activeId = GameContext.getActiveTeamId();
    if (humans.includes(activeId)) return activeId;
    return humans[0];
}

function lockHostileTarget(hostileId) {
    const ownerId = findHumanLockOwnerForHostile(hostileId);
    if (!ownerId) return false;
    if (!GameContext.setLockedTarget(ownerId, hostileId)) return false;
    // Keep human as active (controls stay). Chase-cam stays on own jet; look-at aims at enemy.
    GameContext.setActiveTeamId(ownerId);
    const owner = GameContext.getTeam(ownerId);
    const faction = (GameContext.getFaction && GameContext.getFaction(ownerId)) || ownerId;
    document.body.className = `theme-${faction}`;
    GameContext.state.cameraSoftFollow = true;
    GameContext.state.cameraZoomUntil = performance.now() + 480;
    GameContext.state.cameraFollowOverrideId = hostileId;
    lookAtFromAircraft(ownerId, hostileId);
    if (typeof window.uiSyncSelectionChrome === 'function') {
        window.uiSyncSelectionChrome(ownerId);
    }
    if (!GameContext.isAnimating()) {
        if (typeof updateDashboardUI === 'function') updateDashboardUI(owner);
        GameContext.callService('updateTacticalPreview', owner);
    }
    if (typeof showSMSAlert === 'function') {
        showSMSAlert(`鎖定 ${String(hostileId).toUpperCase()}`, '#00ff88');
    }
    return true;
}

function updateSoftCameraFollow() {
    if (!GameContext.state.cameraSoftFollow) return;
    if (GameContext.isReplayMode()) return;
    const lockFollow = !!GameContext.state.cameraFollowOverrideId;
    // Chase during combat playback, or while lock-aim mode is active in planning.
    if (!GameContext.isAnimating() && !lockFollow) return;
    if (typeof camera === 'undefined' || typeof controls === 'undefined') return;
    if (performance.now() < (GameContext.state.cameraZoomUntil || 0)) return;
    const hostId = GameContext.getActiveTeamId();
    const host = GameContext.getTeam(hostId);
    if (!host || !host.wrapper) return;
    const look = resolveChaseLookTeam(host);
    const pose = getAircraftChaseCamPose(host, look);
    camera.position.lerp(pose.camPos, 0.16);
    controls.target.lerp(pose.targetPos, 0.2);
}

function initAircraftPickClick() {
    if (typeof renderer === 'undefined' || !renderer || !renderer.domElement) return;
    if (renderer.domElement.dataset.pickBound) return;
    renderer.domElement.dataset.pickBound = '1';
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    let downOk = false;

    renderer.domElement.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        downX = e.clientX;
        downY = e.clientY;
        downOk = true;
    });
    renderer.domElement.addEventListener('pointerup', (e) => {
        if (!downOk || e.button !== 0) return;
        downOk = false;
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 8) return;
        if (GameContext.isReplayMode()) return;

        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);

        const ids = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || ['red', 'blue'];
        const roots = [];
        ids.forEach((id) => {
            const t = teams[id];
            if (t && t.wrapper && t.wrapper.visible) roots.push(t.wrapper);
        });
        const hits = raycaster.intersectObjects(roots, true);
        if (!hits.length) return;

        let obj = hits[0].object;
        let teamId = null;
        while (obj) {
            if (obj.userData && obj.userData.teamId) {
                teamId = obj.userData.teamId;
                break;
            }
            obj = obj.parent;
        }
        if (!teamId) return;

        // Hostile click: switch fire/HUD lock for a living human, keep piloting that human.
        if (findHumanLockOwnerForHostile(teamId)) {
            if (lockHostileTarget(teamId)) return;
        }
        GameContext.state.cameraFollowOverrideId = null;
        selectTeam(teamId);
    });
}

function checkInit() { 
    if(teams.red.wrapper && teams.blue.wrapper && missileMeshBase) { 
        try {
            const bootIds = (GameContext.getRosterIds && GameContext.getRosterIds()) || ['red', 'blue'];
            bootIds.forEach((id) => {
                const t = teams[id];
                if (!t || !t.wrapper) return;
                if (initialPositions[id]) {
                    initialPositions[id].pos.copy(t.wrapper.position);
                    initialPositions[id].quat.copy(t.wrapper.quaternion);
                }
                t.startPos = t.wrapper.position.clone();
                t.startQuat = t.wrapper.quaternion.clone();
            });
            if (typeof tryAttachAllPylons === 'function') tryAttachAllPylons(); 

            bootIds.forEach(id => {
                let t = teams[id];
                if (!t || !t.wrapper) return;
                t.ap = (CONFIG.aircrafts[t.type || 'mig21'] && CONFIG.aircrafts[t.type || 'mig21'].baseAp) || 165;   
                t.heat = (typeof getEngineHeatIdle === 'function') ? getEngineHeatIdle() : 150;
                t.gunHeat = 0;
                t.hp = 100;  
                t.chain = [{yaw:0, pitch:0, roll:0, throttle:t.throttle, fire:'none'}];
                let res = simulateFlight(t, t.chain); t.pathPoints = res.points; t.pathQuats = res.quats;
            });

            // Apply after default init so scenario spawn/AI/AP are not overwritten.
            // Match Setup holds the startup screen until ENGAGE (unless scenario/skipSetup).
            selectTeam('red');
            if (typeof initAircraftPickClick === 'function') initAircraftPickClick();
            if (typeof window.uiSyncSelectionChrome === 'function') {
                window.uiSyncSelectionChrome('red');
            }
            if (typeof window.uiBeginMatchOrShowSetup === 'function') {
                window.uiBeginMatchOrShowSetup();
            } else {
                setTimeout(() => {
                    let startup = document.getElementById('startup-screen');
                    if (startup) { startup.style.opacity = '0'; setTimeout(() => startup.style.display = 'none', 1200); }
                }, 1500);
            }
        } catch (error) {
            console.error("開機運算發生錯誤：", error);
        }
    } 
}

// ============================================================================
// 🎯 戰術預覽大腦 (完全解耦版)
// ============================================================================
window.updateTacticalPreview = function(teamObj) {
    if(!teamObj || !teamObj.wrapper || teamObj.isDestroyed) return;
    
    if (GameContext.isReplayMode()) { 
        if(window.ghostWrapper) window.ghostWrapper.visible = false; 
        if(typeof threatEnvGroup !== 'undefined' && threatEnvGroup) threatEnvGroup.visible = false; 
        return; 
    }

    // 將場上戰機重置到當前回合的起點，準備進行軌跡預演
    const previewIds = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || ['red', 'blue'];
    previewIds.forEach(id => {
        let t = teams[id];
        if (!t || !t.wrapper) return;
        if (t.startPos && t.startQuat) { 
            t.wrapper.position.copy(t.startPos); 
            t.wrapper.quaternion.copy(t.startQuat); 
            t.wrapper.userData.logicalQuat.copy(t.startQuat); 
        }
    });

    if (!GameContext.isAnimating() && !GameContext.isReplayMode()) {
        GameContext.callService('drawStaticFlares');
        GameContext.callService('drawStaticChaff');

        previewIds.forEach(id => {
            if (teams[id].pylons) {
                teams[id].pylons.forEach(p => {
                    let activeM = teams[id].activeMissiles ? teams[id].activeMissiles.find(m => m.pylonId === p.id) : null;
                    if (activeM && activeM.active && !activeM.exploded) {
                        if (p.flyingMesh) { 
                            let offset = GameContext.state.mslVisOffset.clone().applyQuaternion(activeM.quat);
                            p.flyingMesh.position.copy(activeM.pos).add(offset);
                            p.flyingMesh.quaternion.copy(activeM.quat);
                            p.flyingMesh.visible = true; 
                        }
                    } else { 
                        if (p.flyingMesh) p.flyingMesh.visible = false; 
                    }
                    if (p.boomMesh) p.boomMesh.visible = false;
                });
            }
        });
    }
    
    const acConfig = CONFIG.aircrafts[teamObj.type || 'mig21']; 
    let stats = acConfig.throttleStats[teamObj.throttle] || { heat: 0 };
    
    // 失速紅屏警告
    let stallScreen = document.getElementById('stall-screen');
    if (stallScreen) stallScreen.style.display = teamObj.stalled ? 'flex' : 'none';

    // 讀取 UI 輸入
    let currentYaw = teamObj.pendingYaw !== 0 ? teamObj.pendingYaw : (teamObj.joyX !== undefined ? -(teamObj.joyX * acConfig.maxYaw) : 0);
    let currentPitch = teamObj.pendingPitch !== 0 ? teamObj.pendingPitch : (teamObj.joyY !== undefined ? -(teamObj.joyY * acConfig.maxPitch) : 0);
    let currentRoll = teamObj.pendingRoll !== 0 ? teamObj.pendingRoll : (teamObj.roll !== undefined ? teamObj.roll : 0);

    if (teamObj.stalled) {
        const stallAlt = teamObj.wrapper ? teamObj.wrapper.position.y : 999;
        const wantsPullUp = currentPitch < -0.12 || (teamObj.joyY !== undefined && teamObj.joyY > 0.3);
        if (stallAlt < 40 && wantsPullUp) {
            // Low-altitude stall recovery: honor pull-up intent instead of forcing nose-down.
            currentYaw *= 0.4;
            currentRoll *= 0.4;
            currentPitch = Math.max(-acConfig.maxPitch, Math.min(-acConfig.maxPitch * 0.88, currentPitch));
            const recoveryThrottle = stallAlt < 18 ? Math.min(teamObj.throttle || 4, 3) : Math.min(teamObj.throttle || 4, 4);
            const recoveryStats = acConfig.throttleStats[recoveryThrottle] || { heat: 0 };
            let fireAct = teamObj.queuedAction || 'none';
            if (fireAct === 'gun' && GameContext.stateMachine.isGunOverheated(teamObj.id)) fireAct = 'none';
            teamObj.chain = [{ yaw: currentYaw, pitch: currentPitch, roll: currentRoll, throttle: recoveryThrottle, heatDelta: recoveryStats.heat, fire: fireAct }];
        } else {
            // 失速物理反饋：操縱靈敏度剩餘 15%，機頭自動下垂
            currentYaw *= 0.15; currentRoll *= 0.15;
            currentPitch = (currentPitch * 0.15) + (Math.PI / 12);
            teamObj.chain = [{ yaw: currentYaw, pitch: currentPitch, roll: currentRoll, throttle: 4, heatDelta: -2, fire: 'none' }];
        }
    } else {
        if (teamObj.gLimiterOn) { 
            currentYaw = Math.max(-acConfig.maxYaw, Math.min(acConfig.maxYaw, currentYaw)); 
            currentPitch = Math.max(-acConfig.maxPitch, Math.min(acConfig.maxPitch, currentPitch)); 
            currentRoll = Math.max(-acConfig.maxRoll, Math.min(acConfig.maxRoll, currentRoll)); 
        }
        let fireAct = teamObj.queuedAction || 'none';
        if (fireAct === 'gun' && GameContext.stateMachine.isGunOverheated(teamObj.id)) fireAct = 'none';
        teamObj.chain = [{ yaw: currentYaw, pitch: currentPitch, roll: currentRoll, throttle: teamObj.throttle, heatDelta: stats.heat, fire: fireAct }];
    }   
       
    // 呼叫物理引擎
    let res = simulateFlight(teamObj, teamObj.chain); 
    teamObj.pathPoints = res.points; teamObj.pathQuats = res.quats; 
    
    // 記錄預覽結算的消耗，供 UI 儀表板顯示
    if (teamObj.chain && teamObj.chain.length > 0) { 
        teamObj.chain[0].resultingAP = res.finalAP; 
        teamObj.previewCostAp = teamObj.ap - res.finalAP; 
        teamObj.previewAccumHeat = teamObj.chain[0].heatDelta; 
    }
    
    // 呼叫繪圖引擎
    if (typeof drawTrajectoryLine === 'function') drawTrajectoryLine(teamObj);
    
    // 🕷️ 敵軍預測蜘蛛網與包絡線更新
    const enemyId = (GameContext.getTargetId && GameContext.getTargetId(teamObj.id))
        || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(teamObj.id))
        || (String(teamObj.id).startsWith('red') ? 'blue' : 'red');
    if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemyId]) { 
        scene.remove(trajectoryMeshes[enemyId]); 
        trajectoryMeshes[enemyId] = null; 
    }
    
    const enemyObj = teams[enemyId];
    if (enemyObj && enemyObj.wrapper && !enemyObj.isDestroyed && typeof threatEnvGroup !== 'undefined') {
        while(threatEnvGroup.children.length > 0){ 
            let child = threatEnvGroup.children[0]; 
            if(child.geometry) child.geometry.dispose(); 
            threatEnvGroup.remove(child); 
        }
        threatEnvGroup.position.set(0, 0, 0); threatEnvGroup.quaternion.identity();
        
        const matT1 = new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending }); 
        const matT2 = new THREE.LineBasicMaterial({ color: 0x00aa55, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending }); 
        const matT3 = new THREE.LineBasicMaterial({ color: 0x006633, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending });
        
        function createEnvelopeNet(testThrottle, lineMat) { 
            const segments = 16; const pathSets = []; 
            for (let i = 0; i < segments; i++) { 
                let angle = (i / segments) * Math.PI * 2; 
                let tYaw = -Math.cos(angle) * (Math.PI / 4); 
                let tPitch = Math.sin(angle) * (Math.PI / 3); 
                let r = simulateFlight(enemyObj, [{yaw: tYaw, pitch: tPitch, roll: 0, throttle: testThrottle}]); 
                pathSets.push(r.points); 
            } 
            for (let i = 0; i < segments; i += 2) { 
                threatEnvGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pathSets[i]), lineMat)); 
            } 
            [15, 30].forEach(frame => { 
                let ringPts = []; 
                for (let i = 0; i < segments; i++) ringPts.push(pathSets[i][frame]); 
                ringPts.push(pathSets[0][frame]); 
                threatEnvGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), lineMat)); 
            }); 
        }
        createEnvelopeNet(1, matT1); createEnvelopeNet(2, matT2); createEnvelopeNet(3, matT3); 
        let centerRes = simulateFlight(enemyObj, [{yaw: 0, pitch: 0, roll: 0, throttle: enemyObj.throttle}]);
        let centerLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(centerRes.points), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })); 
        threatEnvGroup.add(centerLine); 
        
        // 🟢 蜘蛛網顯示權與 userData 開關綁定
        threatEnvGroup.visible = !!(enemyObj.userData && enemyObj.userData.showEnvelope);
    }

    if (typeof updateTargetingLock === 'function') updateTargetingLock(teamObj); 
    if (typeof updateMissilePreview === 'function') updateMissilePreview(teamObj); 
    if (typeof updateGunPreview === 'function') updateGunPreview(teamObj); 
    if (typeof updateDashboardUI === 'function') updateDashboardUI(teamObj);
    if (typeof updateDynamicHUD === 'function') updateDynamicHUD(); 
};

GameContext.registerService('updateTacticalPreview', window.updateTacticalPreview);

function updateTargetingLock(teamObj) {
    const enemyId = (GameContext.getTargetId && GameContext.getTargetId(teamObj.id))
        || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(teamObj.id))
        || (String(teamObj.id).startsWith('red') ? 'blue' : 'red');
    const enemyObj = teams[enemyId]; 
    const btnFireWpn = document.getElementById('btn-fire-wpn');
    if(!btnFireWpn || !teamObj.wrapper || !enemyObj || !enemyObj.wrapper || enemyObj.isDestroyed) return;
    
    if (teamObj.flaresArmed) { 
        if(!teamObj.wpnQueued) { 
            btnFireWpn.innerText = `🔆 放棄開火 (拋灑誘餌)`; 
            btnFireWpn.style.borderColor = '#ff9800'; 
            btnFireWpn.style.color = '#ff9800'; 
        } 
        return; 
    }
    
    const distance = teamObj.wrapper.position.distanceTo(enemyObj.wrapper.position); 
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(teamObj.wrapper.quaternion).normalize(); 
    const angle = forward.angleTo(new THREE.Vector3().subVectors(enemyObj.wrapper.position, teamObj.wrapper.position).normalize());
    
    let isLocked = false; 
    if (teamObj.weapon === 'gun') { 
        let stats = CONFIG.aircrafts[teamObj.type || 'mig21'].throttleStats[teamObj.throttle] || { gunAngleMult: 1.0, gunRangeMult: 1.0 };
        let dRange = GUN_RANGE * stats.gunRangeMult;
        let dAngle = GUN_ANGLE * stats.gunAngleMult;
        
        let vecToEnemy = new THREE.Vector3().subVectors(enemyObj.wrapper.position, teamObj.wrapper.position);
        let forwardDist = vecToEnemy.dot(forward);
        
        if (forwardDist > 0 && forwardDist <= dRange) {
            let timeSinceSpawn = forwardDist / (dRange * 2.0);
            let gravDrop = 0.5 * 9.8 * (timeSinceSpawn * 2) * (timeSinceSpawn * 2) * 0.5;
            let expectedBulletPos = teamObj.wrapper.position.clone().add(forward.clone().multiplyScalar(forwardDist));
            expectedBulletPos.y -= gravDrop;
            
            let coneRadius = forwardDist * Math.tan(dAngle);
            isLocked = (expectedBulletPos.distanceTo(enemyObj.wrapper.position) <= coneRadius);
        }
    } else { 
        btnFireWpn.innerText = `⛔ 取消排程 [${teamObj.weapon === 'gun' ? '機砲' : 'FOX-2'}]`; 
        btnFireWpn.style.borderColor = '#ff0055'; 
        btnFireWpn.style.color = '#fff'; 
    }
}

// ==========================================
// 🌟 戰鬥動畫啟動入口 (安全鎖)
// ==========================================
window.startCombatAnimation = function() {
    GameContext.setReplayMode(false);
    isReplayingAuto = false;
    GameContext.state.animProgress = 0.0;
    GameContext.setAnimating(true);

    let btnExit = document.getElementById('btn-rep-exit');
    if (btnExit) btnExit.style.display = 'none';
    
    let tagR = document.getElementById('replay-tag-red');
    let tagB = document.getElementById('replay-tag-blue');
    if (tagR) tagR.style.display = 'none';
    if (tagB) tagB.style.display = 'none';

    ['red', 'red2', 'blue', 'blue2'].forEach(id => {
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[id]) trajectoryMeshes[id].visible = false;
        if (teams[id] && teams[id].userData && teams[id].userData.gunPreview) teams[id].userData.gunPreview.visible = false;
        if (teams[id] && teams[id].pylons) teams[id].pylons.forEach(p => { if (p.lineMesh) p.lineMesh.visible = false; });
    });
    if (window.ghostWrapper) window.ghostWrapper.visible = false;
    if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) threatEnvGroup.visible = false;
};

GameContext.registerService('startCombatAnimation', window.startCombatAnimation);

function animate() {
    requestAnimationFrame(animate); 
    if (typeof controls === 'undefined' || !controls || typeof renderer === 'undefined' || !renderer) return;

    controls.update(); 
    camera.updateMatrixWorld();
    if (typeof updateSoftCameraFollow === 'function') updateSoftCameraFollow();
    if (typeof window.uiUpdateWingmanHud === 'function') window.uiUpdateWingmanHud();

    // ==========================================
    // 🌟 全天候 Billboard 鏡頭對齊系統（確保特效面向攝影機）
    // ==========================================
    if (typeof explosionPool !== 'undefined') {
        [explosionPool, flashPool, puffPool].forEach(pool => {
            pool.forEach(mesh => {
                if (mesh.visible) {
                    mesh.quaternion.copy(camera.quaternion); 
                    if (mesh.userData.zRot !== undefined) {
                        const qZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), mesh.userData.zRot);
                        mesh.quaternion.multiply(qZ);
                    }
                }
            });
        });
    }

    if (typeof window.updateAircraftDebris === 'function') window.updateAircraftDebris();
    
    let now = performance.now();

    // ==========================================
    // 🌟 統一的尾焰物理動畫
    // ==========================================
    const exhaustIds = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || ['red', 'blue'];
    exhaustIds.forEach(id => {
        let t = teams[id];
        if (!t || !t.wrapper || !t.wrapper.userData || !t.wrapper.userData.exhaust || t.isDestroyed) return;
        let exhaust = t.wrapper.userData.exhaust;
        let throttle = t.throttle || 2;

        exhaust.machTex.offset.y -= 0.02 * throttle;
        exhaust.outerTex.offset.y -= 0.03 * throttle;
        let flicker = Math.sin(now * 0.05) * 0.02 * throttle;

        let scaleX = 0.5 * (0.8 + throttle * 0.1);
        let scaleY = 0.5 * (0.8 + throttle * 0.1);
        let scaleZ = 0.5 * (throttle * 0.45) + flicker;

        exhaust.group.scale.set(scaleX, scaleY, scaleZ);

        let targetOpacity = 0.05 + (throttle * 0.30);
        if (exhaust.group.children[0] && exhaust.group.children[0].material) {
            exhaust.group.children[0].material.opacity = targetOpacity;
        }
        if (exhaust.group.children[1] && exhaust.group.children[1].material) {
            exhaust.group.children[1].material.opacity = Math.min(1.0, targetOpacity * 1.2);
        }
    });

    if (typeof updateSpatialHelpers === 'function') updateSpatialHelpers();
    if (typeof updateDynamicHUD === 'function') updateDynamicHUD();
    if (typeof window.updateCombatAirspaceVfx === 'function') window.updateCombatAirspaceVfx();

    // ==========================================
    // 1. ACMI 重播模式
    // ==========================================
    if (GameContext.isReplayMode()) { 
        if (isReplayingAuto) {
            let dt = now - (GameContext.state.lastReplayTime || now);
            GameContext.state.lastReplayTime = now;
            
            if (GameContext.state.virtualReplayTime === undefined) GameContext.state.virtualReplayTime = 1.0;
            let maxTime = battleLog.length + 0.99;
            
            GameContext.state.virtualReplayTime += (dt / 1500);

            if (GameContext.state.virtualReplayTime >= maxTime) {
                GameContext.state.virtualReplayTime = maxTime;
                isReplayingAuto = false;
                let btnPlay = document.getElementById('btn-rep-play');
                if (btnPlay) btnPlay.innerText = "▶ 播放"; 
            }
            
            let sld = document.getElementById('replay-slider');
            if (sld) sld.value = GameContext.state.virtualReplayTime;
        }

        try {
            let val = GameContext.state.virtualReplayTime || 1.0;
            let maxTime = battleLog.length + 0.99;
            let turnIdx = Math.max(0, Math.min(battleLog.length - 1, Math.floor(val) - 1)); 
            let progress = val - Math.floor(val);
            if (progress >= 0.99 || val >= maxTime) { 
                progress = 1.0; 
                turnIdx = Math.max(0, Math.min(battleLog.length - 1, Math.floor(val - 0.01) - 1)); 
            }
            
            if (battleLog[turnIdx]) {
                if (typeof renderCombatFrame === 'function') renderCombatFrame(battleLog[turnIdx], progress);
                if (typeof updateReplayTags === 'function') updateReplayTags(battleLog[turnIdx], progress);
            }
        } catch (e) { 
            console.error("重播渲染遭遇亂流，已由裝甲攔截:", e); 
        }

        renderer.render(scene, camera);
        return;
    }

    // ==========================================
    // 2. 正常戰鬥播放模式
    // ==========================================
    if (GameContext.isAnimating() && teams.red.flightCurve && teams.blue.flightCurve) {
        try {
            GameContext.state.animProgress += 0.012;
            if (GameContext.state.animProgress > 1.0) GameContext.state.animProgress = 1.0;
            let currentLog = battleLog.length > 0 ? battleLog[battleLog.length - 1] : null; 
            if (currentLog && typeof renderCombatFrame === 'function') renderCombatFrame(currentLog, GameContext.state.animProgress);
            if (typeof updateReplayTags === 'function') updateReplayTags(currentLog, GameContext.state.animProgress);
            
            let trackIdx = Math.min(100, Math.floor(GameContext.state.animProgress * 100));
            const animIds = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || ['red', 'blue'];
            animIds.forEach(id => {
                let t = teams[id]; 
                if(!t || t.isDestroyed || !t.flightCurve) return; 
                if (t.pylons && currentLog) {
                    t.pylons.forEach(p => {
                        let explodeFrame = currentLog[`${id}ExplodedAt`] ? currentLog[`${id}ExplodedAt`][p.id] : undefined;
                        if (explodeFrame !== undefined && trackIdx >= explodeFrame && !p.hasBoomedThisTurn) {
                            let isSelfDestruct = currentLog[`${id}MslIsSelfDestruct`] ? currentLog[`${id}MslIsSelfDestruct`][p.id] : false;
                            if (isSelfDestruct && !GameContext.isReplayMode() && typeof window.uiShowPhaseBanner === 'function') {
                                window.uiShowPhaseBanner(`<span style="font-size:24px; color:#ff5500; font-weight:bold; text-shadow: 2px 2px 4px #000;">💥 飛彈達最大航程自毀</span>`);
                            }
                            p.hasBoomedThisTurn = true; 
                        }
                    });
                }
            });

            if (GameContext.state.animProgress >= 1.0 && typeof finishTurnSimultaneously === 'function') {
                let tagR = document.getElementById('replay-tag-red');
                let tagB = document.getElementById('replay-tag-blue');
                if (tagR) tagR.style.display = 'none';
                if (tagB) tagB.style.display = 'none';

                finishTurnSimultaneously();
            }
        } catch (err) { 
            console.error("戰鬥播放崩潰，已強制跳轉:", err); 
            if(typeof finishTurnSimultaneously === 'function') finishTurnSimultaneously(); 
        }
    } else if (!GameContext.isReplayMode()) {
        // Keep chaff sparkles flickering while planning between turns
        GameContext.callService('drawStaticChaff');
    }
    renderer.render(scene, camera);
}

// ============================================================================
// 👇 ACMI 戰術重播系統大腦
// ============================================================================

let replayInterval = null;
let isReplayingAuto = false;

function enterReplayMode() {
    if (!GameContext.isReplayMode()) {
        GameContext.setReplayMode(true);
        
        let btnExit = document.getElementById('btn-rep-exit');
        if (btnExit) btnExit.style.display = 'inline-block';
        
        let rs = document.getElementById('replay-status');
        if (rs) { rs.innerText = "🔴 歷史回放中"; rs.style.color = "#ff3355"; }
        
        ['red', 'red2', 'blue', 'blue2'].forEach(id => {
            if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[id]) trajectoryMeshes[id].visible = false;
            if (teams[id] && teams[id].userData && teams[id].userData.gunPreview) teams[id].userData.gunPreview.visible = false;
            if (teams[id] && teams[id].pylons) teams[id].pylons.forEach(p => { if (p.lineMesh) p.lineMesh.visible = false; });
        });
        if (window.ghostWrapper) window.ghostWrapper.visible = false;
        if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) threatEnvGroup.visible = false;
    }
}

function exitReplayMode() {
    GameContext.setReplayMode(false);
    isReplayingAuto = false;
    if (replayInterval) cancelAnimationFrame(replayInterval);
    
    let btnPlay = document.getElementById('btn-rep-play');
    if (btnPlay) btnPlay.innerText = "▶ 播放";
    
    let btnExit = document.getElementById('btn-rep-exit');
    if (btnExit) btnExit.style.display = 'none';
    
    let rs = document.getElementById('replay-status');
    if (rs) { rs.innerText = "狀態: 戰術規劃中"; rs.style.color = "#aaa"; }
    
    let tagR = document.getElementById('replay-tag-red');
    let tagB = document.getElementById('replay-tag-blue');
    if (tagR) tagR.style.display = 'none';
    if (tagB) tagB.style.display = 'none';

    let sld = document.getElementById('replay-slider');
    if (sld) sld.value = sld.max; 

    // Restore live visibility after ACMI may have re-shown historically-alive wrecks.
    ['red', 'red2', 'blue', 'blue2'].forEach((id) => {
        const t = teams[id];
        if (!t || !t.wrapper) return;
        if (t.matchActive === false) {
            t.wrapper.visible = false;
            return;
        }
        const gone = t.isDestroyed && t.wreckPhase !== 'falling';
        t.wrapper.visible = !gone;
        if (t.wrapper.userData.exhaust) {
            t.wrapper.userData.exhaust.group.visible = !t.isDestroyed;
        }
    });
    
    const currentTeam = GameContext.getActiveTeamId();
    if (GameContext.getTeam(currentTeam)) GameContext.callService('updateTacticalPreview', GameContext.getTeam(currentTeam));
}

function toggleReplayPlay() {
    let sld = document.getElementById('replay-slider');
    if (!sld || battleLog.length === 0) return;
    
    let btnPlay = document.getElementById('btn-rep-play');
    
    if (isReplayingAuto) {
        isReplayingAuto = false;
        if (btnPlay) btnPlay.innerText = "▶ 播放";
    } else {
        enterReplayMode();
        isReplayingAuto = true;
        
        GameContext.state.lastReplayTime = performance.now();
        
        if (btnPlay) btnPlay.innerText = "⏸ 暫停";
        if (parseFloat(sld.value) >= parseFloat(sld.max)) sld.value = sld.min; 
    }
}

document.addEventListener("DOMContentLoaded", () => {
    let sld = document.getElementById('replay-slider');
    if (sld) {
        sld.addEventListener('input', (e) => {
            enterReplayMode(); 
            
            if (e.isTrusted && isReplayingAuto) {
                isReplayingAuto = false;
                let btnPlay = document.getElementById('btn-rep-play');
                if (btnPlay) btnPlay.innerText = "▶ 播放";
            }
            
            let val = parseFloat(e.target.value); 
            GameContext.state.virtualReplayTime = val; 

            let turnIdx = Math.floor(val) - 1; 
            let progress = val - Math.floor(val);
            if (progress >= 0.99 || val === parseFloat(sld.max)) { progress = 1.0; turnIdx = Math.floor(val - 0.01) - 1; }
            if (turnIdx < 0) turnIdx = 0; 
            if (turnIdx >= battleLog.length) turnIdx = battleLog.length - 1;
            
            let currentLog = battleLog[turnIdx];
            if (currentLog && typeof renderCombatFrame === 'function') { 
                renderCombatFrame(currentLog, progress); 
                if (typeof updateReplayTags === 'function') updateReplayTags(currentLog, progress);
                renderer.render(scene, camera); 
            }
        });
    }

    let btnPlay = document.getElementById('btn-rep-play');
    if (btnPlay) btnPlay.addEventListener('click', toggleReplayPlay);

    let btnExit = document.getElementById('btn-rep-exit');
    if (btnExit) btnExit.addEventListener('click', exitReplayMode);
});

window.onresize = () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); };

animate();