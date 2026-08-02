// ============================================================================
// physics.js - 物理與推演大腦 (5 檔暴力推重比與減速板物理優化版)
// ============================================================================

function getQuatAt(t, quats) { 
    if (!quats || quats.length === 0) return new THREE.Quaternion(); 
    if (t <= 0) return quats[0]; 
    if (t >= 1) return quats[quats.length - 1]; 
    let p = t * (quats.length - 1); 
    let idx = Math.floor(p); 
    return quats[idx].clone().slerp(quats[idx + 1], p - idx); 
}

/**
 * 核心飛行物理模擬 (支援 5 檔節流閥與減速板)
 * @param {Object} teamObj - 戰機狀態實體
 * @param {Array} chain - 操控指令鏈
 */
function simulateFlight(teamObj, chain) {
    if (!teamObj.wrapper) return { points: [], quats: [], finalAP: teamObj.ap };
    
    let simObj = new THREE.Object3D(); 
    simObj.position.copy(teamObj.wrapper.position); 
    simObj.quaternion.copy(teamObj.wrapper.userData.logicalQuat);
    
    let activeAP = teamObj.ap || 120; 
    let points = [simObj.position.clone()]; 
    let quats = [simObj.quaternion.clone()];
    const FRAMES = 30; 

    chain.forEach((cmd, idx) => {
        let thres = cmd.throttle || teamObj.throttle || 4; // 預設為 4 檔 (MIL)
        
        // 🌟 5 檔動力與控制極限常數 (自適應防衝突設計，確保解耦 config.js)
        let baseThrust = 65;
        let turnLimit = 0.7;
        let currentSpeedMult = 1.5;
        let brakeDrag = 0;

        if (thres === 5) {         // 5 檔 (AB 後燃器)
            baseThrust = 180;
            turnLimit = 0.4;
            currentSpeedMult = 2.5;
        } else if (thres === 4) {  // 4 檔 (MIL 最大軍規推力)
            baseThrust = 65;
            turnLimit = 0.7;
            currentSpeedMult = 1.5;
        } else if (thres === 3) {  // 3 檔 (ECO 經濟航巡模式)
            baseThrust = 30;
            turnLimit = 0.85;
            currentSpeedMult = 1.1;
        } else if (thres === 2) {  // 2 檔 (IDL 怠速冷卻模式)
            baseThrust = 5;
            turnLimit = 1.0;
            currentSpeedMult = 0.8;
        } else if (thres === 1) {  // 1 檔 (BRK 氣動減速板模式)
            baseThrust = 0;
            turnLimit = 1.0;
            currentSpeedMult = 0.4;
            brakeDrag = 140;       // 🔴 注入狂暴的空氣煞車阻力
        }

        let dYaw = ((cmd.yaw || 0) * turnLimit) / FRAMES; 
        let dPitch = ((cmd.pitch || 0) * turnLimit) / FRAMES; 
        let dRoll = (cmd.roll || 0) / FRAMES;

        for (let i = 0; i < FRAMES; i++) {
            let forwardVector = new THREE.Vector3(0, 0, 1).applyQuaternion(simObj.quaternion);
            
            // 💨 航空動力學阻力運算
            let yawDrag = Math.abs(dYaw * 180 / Math.PI) * FRAMES * 0.6;
            let pitchDrag = Math.abs(dPitch * 180 / Math.PI) * FRAMES * 0.25;
            let gravityDrag = forwardVector.y * 30; // 爬升掉AP，俯衝加AP
            // Thrust rebuilds AP inside the sim (not again in updateAP — that pinned energy at maxAp).
            // +10 flat rebuild per command (AP recovery speed +10).
            let thrustGain = baseThrust * 0.12 + 10;

            // 結算當前 AP
            activeAP = Math.max(-100, Math.min(MAX_AP, activeAP + (thrustGain - yawDrag - pitchDrag - brakeDrag) / FRAMES - gravityDrag / FRAMES));
            
            simObj.rotateY(dYaw); 
            simObj.rotateX(dPitch); 
            simObj.rotateZ(dRoll); 
            
            let rawSpeed = (Math.max(5, activeAP + baseThrust) * 0.015) / FRAMES;
            let gravityPull = forwardVector.y * 0.022 / 3; 
            let finalStepDistance = (rawSpeed * currentSpeedMult) - gravityPull;
            
            simObj.translateZ(Math.max(0.01, finalStepDistance)); 

            // 失速物理沉降：減輕懲罰（原每幀 0.08 → 0.05）
            if (teamObj.stalled) {
                simObj.position.y -= 0.05;
            }
            
            points.push(simObj.position.clone()); 
            quats.push(simObj.quaternion.clone());
        }
    });

    return { points, quats, finalAP: activeAP };
}

// 🌟 光速座標插值函數 (確保對齊)
function getPosAt(t, points) {
    if (!points || points.length === 0) return new THREE.Vector3();
    if (points.length === 1) return points[0].clone();
    if (t <= 0) return points[0].clone();
    if (t >= 1) return points[points.length - 1].clone();
    let p = t * (points.length - 1);
    let idx = Math.floor(p);
    return points[idx].clone().lerp(points[idx + 1], p - idx);
}