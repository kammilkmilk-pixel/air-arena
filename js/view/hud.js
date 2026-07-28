// ============================================================================
// hud.js - 戰機火控雷達、雙框追蹤與 WE-GO 精確 LCOS 彈道預測系統 (無光灰/高亮紅 動態切換版)
// ============================================================================

// 🌟 1. 動態注入 LCOS：皇牌空戰風 — 內部倒 T + 外部圓環（轉彎時圓環滯後示意彈道）
(function initLcosPipper() {
    let pipper = document.getElementById('lcos-pipper');
    if (!pipper) {
        pipper = document.createElement('div');
        pipper.id = 'lcos-pipper';
        document.body.appendChild(pipper);
    }
    pipper.style.position = 'absolute';
    pipper.style.width = '56px';
    pipper.style.height = '56px';
    pipper.style.pointerEvents = 'none';
    pipper.style.zIndex = '8000';
    pipper.style.display = 'none';
    pipper.style.transform = 'translate(-50%, -50%)';
    pipper.style.transition = 'opacity 0.2s ease-in-out';
    // 外圓平時顯示；倒 T / 中心點僅機砲排程後顯示
    pipper.innerHTML = `
        <svg viewBox="0 0 100 100" style="width: 100%; height: 100%; overflow: visible; filter: none;">
            <circle id="lcos-cone-circle" cx="50" cy="50" r="34" stroke="#e6c200" stroke-width="1.6" fill="none" opacity="0.9"/>
            <g id="lcos-aim-group" style="display: none;">
                <g id="lcos-inner-t" stroke="#e6c200" stroke-width="1.8" stroke-linecap="square" fill="none">
                    <line id="lcos-t-bar" x1="38" y1="52" x2="62" y2="52"/>
                    <line id="lcos-t-stem" x1="50" y1="52" x2="50" y2="34"/>
                </g>
                <circle id="lcos-center-dot" cx="50" cy="52" r="1.4" fill="#e6c200"/>
            </g>
        </svg>
    `;
})();

// 🌟 2. 動態注入敵機未來預估框 (Estimated Position Box)
if (!document.getElementById('ghost-hud')) {
    const ghostHud = document.createElement('div');
    ghostHud.id = 'ghost-hud';
    ghostHud.style.position = 'absolute';
    ghostHud.style.width = '32px';
    ghostHud.style.height = '32px';
    ghostHud.style.border = '2px dashed #00e5ff';
    ghostHud.style.pointerEvents = 'none';
    ghostHud.style.zIndex = '7500';
    ghostHud.style.display = 'none';
    ghostHud.style.transform = 'translate(-50%, -50%)';
    ghostHud.style.boxShadow = '0 0 8px rgba(0, 229, 255, 0.4)';
    
    // 加載標籤與轉折角線
    ghostHud.innerHTML = `
        <div style="position: absolute; top: -18px; left: 50%; transform: translateX(-50%); font-size: 9px; color: #00e5ff; font-weight: bold; white-space: nowrap; text-shadow: 0 0 4px #000; letter-spacing: 1px;">EST. POS</div>
    `;
    document.body.appendChild(ghostHud);
}

// 🌟 3. 初始化 HUD 點擊事件 (僅用於飛彈模式下開關包絡線)
if (typeof window.hudClickListenerRegistered === 'undefined') {
    window.hudClickListenerRegistered = true;
    const setupHudClick = () => {
        let hudElement = document.getElementById('dynamic-hud');
        if (hudElement && !hudElement.dataset.clickBound) {
            hudElement.dataset.clickBound = "true";
            hudElement.style.pointerEvents = "auto";
            hudElement.addEventListener('click', (e) => {
                let currentTeam = GameContext.getActiveTeamId();
                let enemyId = (typeof GameContext !== 'undefined' && GameContext.getTargetId)
                    ? GameContext.getTargetId(currentTeam)
                    : ((typeof GameContext !== 'undefined' && GameContext.getNearestHostileId)
                        ? GameContext.getNearestHostileId(currentTeam)
                        : (currentTeam === 'red' ? 'blue' : 'red'));
                let enemy = (typeof teams !== 'undefined') ? teams[enemyId] : null; 
                let t = teams[currentTeam];

                if (enemy) {
                    if (t && t.weapon === 'gun') {
                        showSMSAlert("⚠️ 機砲模式下強制隱藏包絡線，請專注 LCOS 瞄準", "#ffcc00");
                        return;
                    }

                    if (!enemy.userData) enemy.userData = {};
                    enemy.userData.showEnvelope = !enemy.userData.showEnvelope;
                    
                    if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) {
                        threatEnvGroup.visible = enemy.userData.showEnvelope;
                    }
                    if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemyId]) {
                        trajectoryMeshes[enemyId].visible = enemy.userData.showEnvelope;
                    }
                }
            });
        }
    };
    setupHudClick();
    setInterval(setupHudClick, 2000); 
}

// 🌟 4. 核心渲染更新：每影格刷新雙框定位與 LCOS 物理投影
window.updateDynamicHUD = function() {
    let currentTeam = GameContext.getActiveTeamId();
    let t = teams[currentTeam];
    let enemyId = (GameContext.getTargetId && GameContext.getTargetId(currentTeam))
        || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(currentTeam))
        || (currentTeam === 'red' ? 'blue' : 'red');
    let enemy = teams[enemyId];
    const gunFireRange = (typeof GUN_RANGE !== 'undefined' && GUN_RANGE > 0) ? GUN_RANGE : 70;
    
    let hudShape = document.getElementById('hud-shape');
    let dynamicHud = document.getElementById('dynamic-hud');
    let ghostHud = document.getElementById('ghost-hud');
    let lcosPipper = document.getElementById('lcos-pipper');
    let lcosConeCircle = document.getElementById('lcos-cone-circle');

    if (!t || !enemy || !t.wrapper || !enemy.wrapper || t.isDestroyed || enemy.isDestroyed) {
        if(dynamicHud) dynamicHud.style.display = 'none';
        if(ghostHud) ghostHud.style.display = 'none';
        if(lcosPipper) lcosPipper.style.display = 'none';
        return;
    }

    if (GameContext.isReplayMode()) {
        if(dynamicHud) dynamicHud.style.display = 'none';
        if(ghostHud) ghostHud.style.display = 'none';
        if(lcosPipper) lcosPipper.style.display = 'none';
        return;
    }

    let myGhostPos = (t.pathPoints && t.pathPoints.length > 0) ? t.pathPoints[t.pathPoints.length - 1] : t.wrapper.position;
    let myGhostQuat = (t.pathQuats && t.pathQuats.length > 0) ? t.pathQuats[t.pathQuats.length - 1] : t.wrapper.quaternion;
    
    let enemyCurrentPos = enemy.wrapper.position.clone(); 
    let enemyGhostPos = (enemy.pathPoints && enemy.pathPoints.length > 0) ? enemy.pathPoints[enemy.pathPoints.length - 1] : enemy.wrapper.position; 

    let isObscured = false;
    if (typeof obstacles !== 'undefined' && obstacles.length > 0) {
        let dir = new THREE.Vector3().subVectors(enemyCurrentPos, t.wrapper.position).normalize();
        let dist = t.wrapper.position.distanceTo(enemyCurrentPos);
        let ray = new THREE.Raycaster(t.wrapper.position, dir, 0.1, dist);
        let hits = ray.intersectObjects(obstacles, true);
        if (hits.length > 0) isObscured = true;
    }

    // ========================================================================
    // 🔲 框 1：【主追蹤框 (dynamic-hud)】
    // ========================================================================
    let currentProj = enemyCurrentPos.clone();
    currentProj.project(camera);

    if (currentProj.z > 1.0) {
        if(dynamicHud) dynamicHud.style.display = 'none';
    } else {
        if(dynamicHud) dynamicHud.style.display = 'block';
        let x = (currentProj.x * 0.5 + 0.5) * window.innerWidth;
        let y = (currentProj.y * -0.5 + 0.5) * window.innerHeight;
        
        dynamicHud.style.left = `${x}px`;
        dynamicHud.style.top = `${y}px`;

        if (isObscured) {
            hudShape.style.borderColor = '#ff9800'; 
            hudShape.style.backgroundColor = 'transparent';
            hudShape.style.boxShadow = 'none';
            hudShape.style.borderStyle = 'dashed';
            hudShape.innerHTML = '<span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #ff9800; font-weight: 900; font-size: 14px; text-shadow: 0 0 4px #ff9800;">X</span>';
        } else {
            hudShape.style.borderStyle = 'solid';
            let distance = t.wrapper.position.distanceTo(enemyCurrentPos);
            let forward = new THREE.Vector3(0, 0, 1).applyQuaternion(t.wrapper.quaternion).normalize();
            let angle = forward.angleTo(new THREE.Vector3().subVectors(enemyCurrentPos, t.wrapper.position).normalize());
            
            let isLocked = t.weapon === 'gun' ? (distance <= gunFireRange && angle <= Math.PI/8) : (distance <= 600 && angle <= Math.PI/12);
            
            if (isLocked) {
                hudShape.style.borderColor = '#00ff88';
                hudShape.style.backgroundColor = 'rgba(0, 255, 136, 0.12)';
                hudShape.style.boxShadow = '0 0 15px rgba(0, 255, 136, 0.4)';
                hudShape.innerHTML = '<span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #00ff88; font-weight: 900; font-size: 14px; text-shadow: 0 0 5px #00ff88;">O</span>';
            } else {
                hudShape.style.borderColor = '#00bcd4';
                hudShape.style.backgroundColor = 'transparent';
                hudShape.style.boxShadow = 'none';
                hudShape.innerHTML = '<span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #00bcd4; font-weight: 900; font-size: 14px;">X</span>';
            }
        }
    }

    // ========================================================================
    // 🎯 準星：外細圓環平時顯示（機砲 / 飛彈）；倒 T 僅機砲排程後
    // ========================================================================
    const missileHitRange = (typeof SEEKER_RANGE !== 'undefined' && SEEKER_RANGE > 0)
        ? SEEKER_RANGE
        : ((typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.seekerRange)
            ? CONFIG.weapons.fox2.seekerRange
            : 52);
    const missileHitAngle = (typeof SEEKER_ANGLE !== 'undefined' && SEEKER_ANGLE > 0)
        ? SEEKER_ANGLE
        : ((typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.seekerAngle)
            ? CONFIG.weapons.fox2.seekerAngle
            : Math.PI / 12);

    const showInnerT =
        t.weapon === 'gun' && (
            !!t.ready ||
            !!(t.wpnQueued && t.weapon === 'gun') ||
            (typeof GameContext !== 'undefined' && GameContext.isAnimating && GameContext.isAnimating())
        );

    const hidePipper = () => {
        if (lcosPipper) lcosPipper.style.display = 'none';
        if (ghostHud) ghostHud.style.display = 'none';
    };

    const paintPipperColor = (inRange) => {
        const stroke = inRange ? '#ff0055' : '#e6c200';
        if (inRange) {
            lcosPipper.style.opacity = '1.0';
            lcosPipper.querySelector('svg').style.filter = 'drop-shadow(0 0 5px #ff0055)';
        } else {
            lcosPipper.style.opacity = '0.85';
            lcosPipper.querySelector('svg').style.filter = 'drop-shadow(0 0 3px rgba(230, 194, 0, 0.55))';
        }
        if (lcosConeCircle) lcosConeCircle.setAttribute('stroke', stroke);
        const innerT = document.getElementById('lcos-inner-t');
        if (innerT) innerT.setAttribute('stroke', stroke);
        const centerDot = document.getElementById('lcos-center-dot');
        if (centerDot) centerDot.setAttribute('fill', inRange ? '#ff0055' : '#e6c200');
    };

    if (t.weapon === 'gun') {
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemy.id]) trajectoryMeshes[enemy.id].visible = false;
        if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) threatEnvGroup.visible = false;
        if (t.userData && t.userData.gunPreview) t.userData.gunPreview.visible = false;

        if (isObscured) {
            hidePipper();
        } else {
            let ghostProj = enemyGhostPos.clone();
            ghostProj.project(camera);
            if (ghostProj.z > 1.0) {
                if (ghostHud) ghostHud.style.display = 'none';
            } else {
                if (ghostHud) ghostHud.style.display = 'block';
                ghostHud.style.left = `${(ghostProj.x * 0.5 + 0.5) * window.innerWidth}px`;
                ghostHud.style.top = `${(ghostProj.y * -0.5 + 0.5) * window.innerHeight}px`;
            }

            let dist = myGhostPos.distanceTo(enemyGhostPos);
            let aircraftSpeedPerFrame = (t.speed || 107) * 0.015 / 100;
            let muzzleSpeedPerFrame = 4.0;
            let effectiveBulletSpeed = muzzleSpeedPerFrame + aircraftSpeedPerFrame;
            let framesToImpact = dist / effectiveBulletSpeed;
            let myGhostForward = new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).normalize();
            let enemyForward = new THREE.Vector3(0, 0, 1).applyQuaternion(enemy.wrapper.quaternion).normalize();
            let myVel = myGhostForward.clone().multiplyScalar(aircraftSpeedPerFrame);
            let enemySpeedPerFrame = (enemy.flightLength || (enemy.ap * 0.015)) / 100;
            let enemyVel = enemyForward.clone().multiplyScalar(enemySpeedPerFrame);
            let relativeVel = enemyVel.clone().sub(myVel);
            let bulletImpactPos = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(dist));
            let gFrame = 0.0022;
            let gravityDrop = 0.5 * gFrame * framesToImpact * (framesToImpact + 1);
            bulletImpactPos.y -= gravityDrop;
            bulletImpactPos.add(relativeVel.multiplyScalar(framesToImpact * 0.5));

            let aimPoint = bulletImpactPos.clone();
            aimPoint.project(camera);

            if (aimPoint.z > 1.0) {
                hidePipper();
            } else {
                lcosPipper.style.display = 'block';
                let px = (aimPoint.x * 0.5 + 0.5) * window.innerWidth;
                let py = (aimPoint.y * -0.5 + 0.5) * window.innerHeight;
                if (!window.lcosLastPos) {
                    window.lcosLastPos = new THREE.Vector2(px, py);
                } else {
                    let screenDist = window.lcosLastPos.distanceTo(new THREE.Vector2(px, py));
                    if (screenDist > 400) window.lcosLastPos.set(px, py);
                    else window.lcosLastPos.lerp(new THREE.Vector2(px, py), 0.35);
                }
                lcosPipper.style.left = `${window.lcosLastPos.x}px`;
                lcosPipper.style.top = `${window.lcosLastPos.y}px`;

                const joyX = Number(t.joyX || 0);
                const joyY = Number(t.joyY || 0);
                const turnMag = Math.min(1, Math.hypot(joyX, joyY));
                const aircraftDistance = t.wrapper.position.distanceTo(enemy.wrapper.position);
                const minDistance = Math.min(20, gunFireRange * 0.35);
                const maxDistance = Math.max(gunFireRange * 2.5, 120);
                const normalizedDistance = Math.max(0, Math.min(1, (aircraftDistance - minDistance) / (maxDistance - minDistance)));
                const pipperSizePx = 64 - (normalizedDistance * 24);
                lcosPipper.style.width = `${pipperSizePx}px`;
                lcosPipper.style.height = `${pipperSizePx}px`;

                const bankQuat = myGhostQuat || t.wrapper.quaternion;
                const bankEuler = new THREE.Euler().setFromQuaternion(bankQuat, 'YXZ');
                const rollDeg = bankEuler.z * (180 / Math.PI);
                const leavePx = showInnerT ? (5 + turnMag * 5) : 0;
                const dirLen = Math.hypot(joyX, joyY);
                const leaveXPx = (showInnerT && dirLen > 0.02) ? (joyX / dirLen) * leavePx : 0;
                const leaveYPx = (showInnerT && dirLen > 0.02) ? (joyY / dirLen) * leavePx : 0;
                const svgPerPx = 100 / Math.max(1, pipperSizePx);
                const leaveXSvg = leaveXPx * svgPerPx;
                const leaveYSvg = leaveYPx * svgPerPx;

                if (lcosConeCircle) {
                    const funnelR = 32 + turnMag * (showInnerT ? 5 : 2);
                    lcosConeCircle.setAttribute('cx', String(50 - leaveXSvg * 0.35));
                    lcosConeCircle.setAttribute('cy', String(50 - leaveYSvg * 0.35));
                    lcosConeCircle.setAttribute('r', String(funnelR));
                }

                const aimGroup = document.getElementById('lcos-aim-group');
                const innerT = document.getElementById('lcos-inner-t');
                if (aimGroup) {
                    aimGroup.style.display = showInnerT ? 'block' : 'none';
                    if (showInnerT) {
                        aimGroup.setAttribute(
                            'transform',
                            `translate(${leaveXSvg.toFixed(2)} ${leaveYSvg.toFixed(2)})`
                        );
                    } else {
                        aimGroup.setAttribute('transform', 'translate(0 0)');
                    }
                }
                if (innerT && showInnerT) {
                    innerT.setAttribute('transform', `rotate(${rollDeg.toFixed(2)} 50 52)`);
                }

                paintPipperColor(dist < gunFireRange);
            }
        }
    } else if (t.weapon === 'missile') {
        // 飛彈：僅外細圓環，平時黃、進入 seeker 命中窗變紅
        let shouldShowEnv = !!(enemy.userData && enemy.userData.showEnvelope && !isObscured);
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemy.id]) {
            trajectoryMeshes[enemy.id].visible = shouldShowEnv;
        }
        if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) {
            threatEnvGroup.visible = shouldShowEnv;
        }
        if (ghostHud) ghostHud.style.display = 'none';

        if (isObscured) {
            hidePipper();
        } else {
            const myGhostForward = new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).normalize();
            const toEnemy = enemyGhostPos.clone().sub(myGhostPos);
            const dist = toEnemy.length();
            const toEnemyNorm = dist > 0.001 ? toEnemy.clone().normalize() : myGhostForward.clone();
            const angleToEnemy = myGhostForward.angleTo(toEnemyNorm);
            const aimDist = Math.max(18, Math.min(dist || missileHitRange, missileHitRange + 8));
            const aimWorld = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(aimDist));
            const aimPoint = aimWorld.clone();
            aimPoint.project(camera);

            if (aimPoint.z > 1.0) {
                hidePipper();
            } else {
                lcosPipper.style.display = 'block';
                const px = (aimPoint.x * 0.5 + 0.5) * window.innerWidth;
                const py = (aimPoint.y * -0.5 + 0.5) * window.innerHeight;
                if (!window.lcosLastPos) {
                    window.lcosLastPos = new THREE.Vector2(px, py);
                } else {
                    const screenDist = window.lcosLastPos.distanceTo(new THREE.Vector2(px, py));
                    if (screenDist > 400) window.lcosLastPos.set(px, py);
                    else window.lcosLastPos.lerp(new THREE.Vector2(px, py), 0.4);
                }
                lcosPipper.style.left = `${window.lcosLastPos.x}px`;
                lcosPipper.style.top = `${window.lcosLastPos.y}px`;

                const joyX = Number(t.joyX || 0);
                const joyY = Number(t.joyY || 0);
                const turnMag = Math.min(1, Math.hypot(joyX, joyY));
                const normalizedDistance = Math.max(0, Math.min(1, (dist - 20) / Math.max(40, missileHitRange)));
                const pipperSizePx = 58 - (normalizedDistance * 16);
                lcosPipper.style.width = `${pipperSizePx}px`;
                lcosPipper.style.height = `${pipperSizePx}px`;

                if (lcosConeCircle) {
                    lcosConeCircle.setAttribute('cx', '50');
                    lcosConeCircle.setAttribute('cy', '50');
                    lcosConeCircle.setAttribute('r', String(32 + turnMag * 3));
                }
                const aimGroup = document.getElementById('lcos-aim-group');
                if (aimGroup) {
                    aimGroup.style.display = 'none';
                    aimGroup.setAttribute('transform', 'translate(0 0)');
                }

                const inRange =
                    dist <= missileHitRange &&
                    dist >= 8 &&
                    angleToEnemy <= missileHitAngle &&
                    myGhostForward.dot(toEnemyNorm) > 0.55;
                paintPipperColor(inRange);
            }
        }
    } else {
        hidePipper();
    }
    
    if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[t.id]) {
        trajectoryMeshes[t.id].visible = true;
    }

    let tgtType = document.getElementById('hud-tgt-type');
    if (tgtType) {
        tgtType.innerText = isObscured ? 'OBSCURED' : (enemy.type ? enemy.type.toUpperCase() : 'TARGET');
        tgtType.style.color = isObscured ? '#ff9800' : '#00ff88';
    }
    let tgtAlt = document.getElementById('hud-tgt-alt');
    if (tgtAlt) tgtAlt.innerText = Math.floor(enemyCurrentPos.y);
    let tgtDist = document.getElementById('hud-tgt-dist');
    if (tgtDist) tgtDist.innerText = Math.floor(t.wrapper.position.distanceTo(enemyCurrentPos));
};
