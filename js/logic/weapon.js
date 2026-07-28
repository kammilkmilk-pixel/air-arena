// ============================================================================
// weapons.js - 武器與干擾物理引擎模組
// ============================================================================

/**
 * 計算目標暴露給飛彈尋標頭的有效熱源
 */
function calculateExposedHeat(baseHeat, targetPos, targetQuat, observerPos) {
    // 取得目標的「正後方」向量 (引擎噴嘴方向)
    const targetBackward = new THREE.Vector3(0, 0, -1).applyQuaternion(targetQuat).normalize();
    // 取得從目標指向飛彈/觀察者的向量
    const toObserver = new THREE.Vector3().subVectors(observerPos, targetPos).normalize();
    
    // 計算夾角 (0度代表飛彈正對著噴嘴，180度代表飛彈在目標正前方)
    const angle = targetBackward.angleTo(toObserver);
    
    // 尾部熱源最強，越往機頭熱源越弱 (簡單的 Cosine 衰減模型)
    let heatExposureRatio = (Math.cos(angle) + 1) / 2; // 範圍 0.0 ~ 1.0
    const frontHeatFloor = (CONFIG.weapons.fox2 && CONFIG.weapons.fox2.frontAspectHeatFloor !== undefined)
        ? CONFIG.weapons.fox2.frontAspectHeatFloor
        : 0.06;
    // 給予一個基礎底線 (機體摩擦熱)，加上尾管熱源
    let finalHeat = (baseHeat * frontHeatFloor) + (baseHeat * (1 - frontHeatFloor) * heatExposureRatio);
    
    return finalHeat;
}

function getMissileAspect(targetPos, targetQuat, observerPos) {
    const targetForward = new THREE.Vector3(0, 0, 1).applyQuaternion(targetQuat).normalize();
    const toObserver = new THREE.Vector3().subVectors(observerPos, targetPos).normalize();
    const frontDot = targetForward.dot(toObserver);
    const threshold = (CONFIG.weapons.fox2 && CONFIG.weapons.fox2.frontAspectDot !== undefined)
        ? CONFIG.weapons.fox2.frontAspectDot
        : 0.45;
    return {
        frontDot,
        frontAspect: frontDot > threshold
    };
}

/**
 * 模擬飛彈單一影格 (Frame) 的物理飛行
 */
function simulateMissileStep(mPos, mQuat, targetPos, targetQuat, mAP, teamObj, enemyObj, currentFlares) {
    let exploded = false;
    let lostTarget = false;
    let nextPos = mPos.clone();
    let nextQuat = mQuat.clone();
    const aspect = getMissileAspect(targetPos, targetQuat, mPos);
    const weaponCfg = CONFIG.weapons.fox2 || {};
    const effectiveSeekerAngle = SEEKER_ANGLE * (aspect.frontAspect ? (weaponCfg.frontAspectSeekerAngleMult || 0.55) : 1);
    const effectiveTurnRate = MISSILE_TURN_RATE * (aspect.frontAspect ? (weaponCfg.frontAspectTurnRateMult || 0.55) : 1);
        const directHitRange = aspect.frontAspect ? 0.85 : 1.65;

    // 1. 判定是否命中 (Hit Detection)
    if (mPos.distanceTo(targetPos) < directHitRange) {
        exploded = true;
        return { pos: nextPos, quat: nextQuat, ap: 0, exploded: true, lostTarget: false, frontAspect: aspect.frontAspect, frontDot: aspect.frontDot };
    }

    // 2. 尋標頭熱源判定與誘餌干擾
    let forward = new THREE.Vector3(0, 0, 1).applyQuaternion(mQuat).normalize();
    let toTarget = new THREE.Vector3().subVectors(targetPos, mPos).normalize();
    let angleToTarget = forward.angleTo(toTarget);
    
    let targetHeat = calculateExposedHeat(100 + enemyObj.heat, targetPos, targetQuat, mPos);
    let bestTargetPos = targetPos;
    let highestHeat = targetHeat;

    // 檢查是否有熱焰彈干擾
    if (currentFlares && currentFlares.length > 0) {
        // Flare heat decays slower so decoys compete longer against IR seekers.
        currentFlares.forEach(flare => {
            if (flare.teamId === enemyObj.id) {
                let toFlare = new THREE.Vector3().subVectors(flare.pos, mPos).normalize();
                let angleToFlare = forward.angleTo(toFlare);
                
                // 如果熱焰彈在尋標頭視角內
                if (angleToFlare <= effectiveSeekerAngle) {
                    let flareHeat = 180 - (flare.age * 12);
                    let distRatio = Math.max(0.12, mPos.distanceTo(flare.pos) / SEEKER_RANGE);
                    let perceivedFlareHeat = flareHeat / (distRatio * distRatio); // 距離平方反比
                    
                    if (perceivedFlareHeat > highestHeat) {
                        highestHeat = perceivedFlareHeat;
                        bestTargetPos = flare.pos;
                        // 熱源轉移，飛彈被騙走了！
                    }
                }
            }
        });
    }

    // 3. 尋標頭丟失判定
    if (highestHeat < SEEKER_MIN_HEAT || forward.angleTo(new THREE.Vector3().subVectors(bestTargetPos, mPos).normalize()) > effectiveSeekerAngle) {
        lostTarget = true;
    }

    // 4. 空氣動力學飛行運算 (Proportional Navigation)
    let speed = MISSILE_SPEED; // 每幀移動距離
    
    if (!lostTarget) {
        // 如果有目標，進行轉向
        let desiredDir = new THREE.Vector3().subVectors(bestTargetPos, mPos).normalize();
        let desiredQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), desiredDir);
        nextQuat.slerp(desiredQuat, effectiveTurnRate); 
    } 
    // 如果丟失目標 (lostTarget)，nextQuat 不會改變，飛彈將沿著原來的方向直飛！

    // 往前推進
    let moveVec = new THREE.Vector3(0, 0, 1).applyQuaternion(nextQuat).multiplyScalar(speed);
    nextPos.add(moveVec);

    // 消耗動力 (AP)
    let nextAP = mAP - speed;

    return { pos: nextPos, quat: nextQuat, ap: nextAP, exploded: false, lostTarget: lostTarget, frontAspect: aspect.frontAspect, frontDot: aspect.frontDot };
}