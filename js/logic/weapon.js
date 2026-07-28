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
 * 蒐集尋標頭可感知熱源：場上所有存活機（除發射者）+ 全部熱焰。
 * 不分敵我。
 */
function buildMissileHeatSources(shooterId, ratio, currentFlares) {
    const sources = [];
    const ids = (typeof combatActiveIds === 'function')
        ? combatActiveIds()
        : ((typeof GameContext !== 'undefined' && GameContext.getActiveMatchIds)
            ? GameContext.getActiveMatchIds()
            : Object.keys(typeof teams !== 'undefined' ? teams : {}));

    ids.forEach((id) => {
        if (id === shooterId) return;
        const t = (typeof teams !== 'undefined') ? teams[id] : null;
        if (!t || t.isDestroyed || !t.wrapper) return;

        let pos;
        let quat;
        if (typeof ratio === 'number' && t.pathPoints && t.pathPoints.length && typeof getPosAt === 'function') {
            pos = getPosAt(ratio, t.pathPoints);
            quat = (typeof getQuatAt === 'function' && t.pathQuats && t.pathQuats.length)
                ? getQuatAt(ratio, t.pathQuats)
                : t.wrapper.quaternion.clone();
        } else {
            pos = t.wrapper.position.clone();
            quat = t.wrapper.quaternion.clone();
        }
        sources.push({
            kind: 'aircraft',
            id,
            pos,
            quat,
            baseHeat: 100 + (Number(t.heat) || 0)
        });
    });

    (currentFlares || []).forEach((flare, idx) => {
        if (!flare || !flare.pos) return;
        const pos = (typeof flare.pos.clone === 'function')
            ? flare.pos.clone()
            : new THREE.Vector3(flare.pos.x, flare.pos.y, flare.pos.z);
        sources.push({
            kind: 'flare',
            id: `flare:${flare.teamId || 'x'}:${idx}`,
            ownerId: flare.teamId || null,
            pos,
            quat: null,
            baseHeat: Math.max(8, 180 - (Number(flare.age) || 0) * 12)
        });
    });

    return sources;
}

/**
 * 在尋標錐內挑選最強熱源（不分敵我）。
 * @returns {null|{ source, perceived, aspect, dist }}
 */
function pickHottestMissileTrack(mPos, mQuat, heatSources) {
    if (!heatSources || !heatSources.length) return null;
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(mQuat).normalize();
    const weaponCfg = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2) ? CONFIG.weapons.fox2 : {};
    const frontSeekerMult = weaponCfg.frontAspectSeekerAngleMult || 0.55;
    const seekerRange = (typeof SEEKER_RANGE !== 'undefined' && SEEKER_RANGE > 0) ? SEEKER_RANGE : 120;
    const seekerAngle = (typeof SEEKER_ANGLE !== 'undefined' && SEEKER_ANGLE > 0) ? SEEKER_ANGLE : Math.PI / 12;
    const minHeat = (typeof SEEKER_MIN_HEAT !== 'undefined') ? SEEKER_MIN_HEAT : 20;

    let best = null;
    heatSources.forEach((src) => {
        if (!src || !src.pos) return;
        const dist = mPos.distanceTo(src.pos);
        if (!(dist > 0.05) || dist > seekerRange) return;

        const toSrc = src.pos.clone().sub(mPos);
        if (toSrc.lengthSq() < 0.0001) return;
        toSrc.normalize();
        const angle = forward.angleTo(toSrc);

        let aspect = { frontAspect: false, frontDot: 0 };
        let rawHeat = Number(src.baseHeat) || 0;
        if (src.kind === 'aircraft' && src.quat) {
            aspect = getMissileAspect(src.pos, src.quat, mPos);
            rawHeat = calculateExposedHeat(src.baseHeat, src.pos, src.quat, mPos);
        }
        const fov = seekerAngle * (aspect.frontAspect ? frontSeekerMult : 1);
        if (angle > fov) return;

        const distRatio = Math.max(0.12, dist / seekerRange);
        const perceived = rawHeat / (distRatio * distRatio);
        if (perceived < minHeat) return;

        if (!best || perceived > best.perceived) {
            best = { source: src, perceived, aspect, dist, angle };
        }
    });
    return best;
}

/**
 * 模擬飛彈單一影格 (Frame) 的物理飛行。
 * 尋標頭對場上所有熱源取最大（不分敵我）；targetPos/enemyObj 僅作無熱源時的後備參考。
 */
function simulateMissileStep(mPos, mQuat, targetPos, targetQuat, mAP, teamObj, enemyObj, currentFlares, activeM, opts) {
    let exploded = false;
    let lostTarget = false;
    let nextPos = mPos.clone();
    let nextQuat = mQuat.clone();
    const weaponCfg = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2) ? CONFIG.weapons.fox2 : {};
    const options = opts || {};
    const shooterId = options.shooterId || (teamObj && teamObj.id) || null;
    const ratio = (typeof options.ratio === 'number') ? options.ratio : null;

    let heatSources = options.heatSources;
    if (!heatSources) {
        heatSources = buildMissileHeatSources(shooterId, ratio, currentFlares);
        // Preview / legacy：若尚未有 roster 熱源，至少保留指定敵
        if ((!heatSources || !heatSources.length) && enemyObj && targetPos) {
            heatSources = [{
                kind: 'aircraft',
                id: enemyObj.id,
                pos: targetPos.clone ? targetPos.clone() : targetPos,
                quat: targetQuat,
                baseHeat: 100 + (Number(enemyObj.heat) || 0)
            }];
            (currentFlares || []).forEach((flare, idx) => {
                if (!flare || !flare.pos) return;
                heatSources.push({
                    kind: 'flare',
                    id: `flare:${flare.teamId || 'x'}:${idx}`,
                    ownerId: flare.teamId || null,
                    pos: flare.pos.clone ? flare.pos.clone() : flare.pos,
                    quat: null,
                    baseHeat: Math.max(8, 180 - (Number(flare.age) || 0) * 12)
                });
            });
        }
    }

    // 解制距離：飛過 minArmingRange 後才開尋標導引（預設 35m）
    const armRange = (weaponCfg.minArmingRange !== undefined) ? Number(weaponCfg.minArmingRange) : 35;
    if (activeM && !activeM.launchPos) activeM.launchPos = mPos.clone();
    const traveled = activeM
        ? (Number.isFinite(Number(activeM.traveled))
            ? Number(activeM.traveled)
            : (activeM.launchPos ? mPos.distanceTo(activeM.launchPos) : 0))
        : 0;
    const canGuide = traveled >= armRange;

    const track = canGuide ? pickHottestMissileTrack(mPos, mQuat, heatSources) : null;
    const trackSrc = track ? track.source : null;
    const trackPos = trackSrc ? trackSrc.pos : null;
    const trackQuat = trackSrc && trackSrc.quat ? trackSrc.quat : null;
    const aspect = (trackPos && trackQuat)
        ? getMissileAspect(trackPos, trackQuat, mPos)
        : { frontAspect: false, frontDot: 0 };
    const effectiveTurnRate = MISSILE_TURN_RATE * (aspect.frontAspect ? (weaponCfg.frontAspectTurnRateMult || 0.55) : 1);
    const directHitRange = aspect.frontAspect ? 0.85 : 1.65;

    // 慣性段也允許擦撞命中（不導引，但彈體仍有殺傷）
    const coastHit = (() => {
        if (!heatSources || !heatSources.length) return null;
        let hit = null;
        let bestD = directHitRange;
        heatSources.forEach((src) => {
            if (!src || src.kind !== 'aircraft' || !src.pos) return;
            const d = mPos.distanceTo(src.pos);
            if (d < bestD) {
                bestD = d;
                hit = src;
            }
        });
        return hit;
    })();

    // 1. 命中
    const hitSrc = (trackSrc && trackSrc.kind === 'aircraft' && mPos.distanceTo(trackSrc.pos) < directHitRange)
        ? trackSrc
        : coastHit;
    if (hitSrc) {
        exploded = true;
        return {
            pos: nextPos,
            quat: nextQuat,
            ap: 0,
            exploded: true,
            lostTarget: false,
            frontAspect: aspect.frontAspect,
            frontDot: aspect.frontDot,
            trackId: hitSrc.id,
            trackKind: 'aircraft',
            hitTargetId: hitSrc.id,
            guided: canGuide,
            traveled
        };
    }

    // 2. 尋標 / 丟鎖（未解制 = 視為尚未鎖定）
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(mQuat).normalize();
    if (!canGuide || !track || !trackPos) {
        lostTarget = !canGuide ? false : true;
    } else {
        const toTrack = trackPos.clone().sub(mPos);
        if (toTrack.lengthSq() < 0.0001) lostTarget = true;
        else if (forward.angleTo(toTrack.normalize()) > (SEEKER_ANGLE * (aspect.frontAspect ? (weaponCfg.frontAspectSeekerAngleMult || 0.55) : 1))) {
            lostTarget = true;
        }
    }

    // 3. 導引：解制前強制直線
    let speed = MISSILE_SPEED;
    if (canGuide && !lostTarget && trackPos) {
        let desiredDir = new THREE.Vector3().subVectors(trackPos, mPos).normalize();
        let desiredQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), desiredDir);
        nextQuat.slerp(desiredQuat, effectiveTurnRate);
    }

    let moveVec = new THREE.Vector3(0, 0, 1).applyQuaternion(nextQuat).multiplyScalar(speed);
    nextPos.add(moveVec);
    let nextAP = mAP - speed;
    const nextTraveled = traveled + speed;
    if (activeM) {
        activeM.traveled = nextTraveled;
        activeM.guided = nextTraveled >= armRange;
        if (!activeM.launchPos) activeM.launchPos = mPos.clone();
    }

    // 推進後再做一次近距命中（載機）
    let hitTargetId = null;
    let postHit = null;
    if (canGuide && trackSrc && trackSrc.kind === 'aircraft' && nextPos.distanceTo(trackSrc.pos) < directHitRange) {
        postHit = trackSrc;
    } else if (heatSources && heatSources.length) {
        heatSources.forEach((src) => {
            if (!src || src.kind !== 'aircraft' || !src.pos) return;
            if (nextPos.distanceTo(src.pos) < directHitRange) postHit = src;
        });
    }
    if (postHit) {
        exploded = true;
        hitTargetId = postHit.id;
        nextAP = 0;
    }

    return {
        pos: nextPos,
        quat: nextQuat,
        ap: nextAP,
        exploded,
        lostTarget: canGuide ? lostTarget : false,
        frontAspect: aspect.frontAspect,
        frontDot: aspect.frontDot,
        trackId: trackSrc ? trackSrc.id : (postHit ? postHit.id : null),
        trackKind: trackSrc ? trackSrc.kind : (postHit ? 'aircraft' : null),
        hitTargetId: hitTargetId || (exploded && postHit ? postHit.id : null),
        guided: canGuide,
        traveled: nextTraveled
    };
}

/**
 * AI / 發射預檢：尋標錐內若友軍熱源不弱於指定敵，視為誤擊風險。
 */
function isMissileFratricideRisk(shooterId, preferredEnemyId) {
    const shooter = (typeof teams !== 'undefined') ? teams[shooterId] : null;
    if (!shooter || !shooter.wrapper) return false;
    const mPos = shooter.wrapper.position.clone();
    const mQuat = shooter.wrapper.quaternion.clone();
    const sources = buildMissileHeatSources(shooterId, null, []);
    const track = pickHottestMissileTrack(mPos, mQuat, sources);
    if (!track || !track.source || track.source.kind !== 'aircraft') return false;

    const factionOf = (id) => {
        if (typeof GameContext !== 'undefined' && GameContext.getFaction) return GameContext.getFaction(id);
        return String(id).startsWith('blue') ? 'blue' : 'red';
    };
    const shootFaction = factionOf(shooterId);
    const trackFaction = factionOf(track.source.id);
    if (trackFaction === shootFaction) return true;

    // 友軍在錐內且距離明顯近於指定敵
    if (!preferredEnemyId) return false;
    const allyCloser = sources.some((src) => {
        if (src.kind !== 'aircraft') return false;
        if (factionOf(src.id) !== shootFaction) return false;
        const enemy = sources.find((s) => s.kind === 'aircraft' && s.id === preferredEnemyId);
        if (!enemy) return false;
        const allyTrack = pickHottestMissileTrack(mPos, mQuat, [src]);
        const enemyTrack = pickHottestMissileTrack(mPos, mQuat, [enemy]);
        if (!allyTrack) return false;
        if (!enemyTrack) return true;
        return allyTrack.dist < enemyTrack.dist * 0.85 || allyTrack.perceived > enemyTrack.perceived * 0.9;
    });
    return allyCloser;
}
