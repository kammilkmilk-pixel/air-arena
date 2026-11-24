// ============================================================================
// physics.js - 物理與推演大腦 (連續節流閥 1.0–5.0 無段變速 + 減速板)
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
 * Resolve continuous throttle into sim knobs (thrust / turn / speed / brake).
 * Prefer CONFIG lerp via getThrottleStats; keep local fallback if config missing.
 */
function resolveThrottleSimKnobs(thres, aircraftType) {
    const t = (typeof clampThrottleLevel === 'function')
        ? clampThrottleLevel(thres)
        : Math.max(1, Math.min(5, Number(thres) || 4));
    if (typeof getThrottleStats === 'function') {
        const s = getThrottleStats(t, aircraftType);
        const speedMult = Array.isArray(s.speedProfile)
            ? (Number(s.speedProfile[0]) || 1)
            : 1.5;
        // BRK band: interpolate air-brake drag below throttle 2.
        let brakeDrag = 0;
        if (t < 2) brakeDrag = 140 * (2 - t);
        return {
            baseThrust: Number(s.thrust) || 0,
            turnLimit: Number(s.turnLimit) || 1,
            currentSpeedMult: speedMult,
            brakeDrag,
            heat: Number(s.heat) || 0
        };
    }
    // Legacy discrete fallback
    if (t >= 4.5) return { baseThrust: 180, turnLimit: 0.4, currentSpeedMult: 2.5, brakeDrag: 0 };
    if (t >= 3.5) return { baseThrust: 65, turnLimit: 0.7, currentSpeedMult: 1.5, brakeDrag: 0 };
    if (t >= 2.5) return { baseThrust: 30, turnLimit: 0.85, currentSpeedMult: 1.1, brakeDrag: 0 };
    if (t >= 1.5) return { baseThrust: 5, turnLimit: 1.0, currentSpeedMult: 0.8, brakeDrag: 0 };
    return { baseThrust: 0, turnLimit: 1.0, currentSpeedMult: 0.4, brakeDrag: 140 };
}

/**
 * 核心飛行物理模擬 (連續節流閥 + 減速板)
 * @param {Object} teamObj - 戰機狀態實體
 * @param {Array} chain - 操控指令鏈
 */
function simulateFlight(teamObj, chain) {
    if (!teamObj.wrapper) return { points: [], quats: [], finalAP: teamObj.ap };
    
    let simObj = new THREE.Object3D(); 
    simObj.position.copy(teamObj.wrapper.position); 
    simObj.quaternion.copy(teamObj.wrapper.userData.logicalQuat);
    
    let activeAP = Number.isFinite(Number(teamObj.ap)) ? Number(teamObj.ap) : 120; 
    let points = [simObj.position.clone()]; 
    let quats = [simObj.quaternion.clone()];
    const FRAMES = 30; 

    chain.forEach((cmd) => {
        let thres = (cmd.throttle != null ? cmd.throttle : teamObj.throttle) || 4;
        const knobs = resolveThrottleSimKnobs(thres, teamObj.type || 'mig21');
        const baseThrust = knobs.baseThrust;
        const turnLimit = knobs.turnLimit;
        const currentSpeedMult = knobs.currentSpeedMult;
        const brakeDrag = knobs.brakeDrag;

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