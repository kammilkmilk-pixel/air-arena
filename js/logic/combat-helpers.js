// ============================================================================
// combat-helpers.js - roster helpers, pylon attach, spark generators
// ============================================================================
// ----------------------------------------------------------------------------
// 🛠️ 輔助工具區
// ----------------------------------------------------------------------------
function combatActiveIds() {
    if (typeof GameContext !== 'undefined' && GameContext.getActiveMatchIds) {
        return GameContext.getActiveMatchIds();
    }
    return ['red', 'blue'].filter((id) => teams[id] && teams[id].wrapper);
}

function combatEnemyOf(id) {
    const eid = (typeof GameContext !== 'undefined' && GameContext.getTargetId)
        ? GameContext.getTargetId(id)
        : ((typeof GameContext !== 'undefined' && GameContext.getNearestHostileId)
            ? GameContext.getNearestHostileId(id)
            : (String(id).startsWith('red') ? 'blue' : 'red'));
    return (eid && teams[eid]) ? teams[eid] : null;
}

function combatFactionOf(id) {
    if (typeof GameContext !== 'undefined' && GameContext.getFaction) return GameContext.getFaction(id);
    return String(id).startsWith('blue') ? 'blue' : 'red';
}

/**
 * Place nozzle / exhaust at the aft tip of a store body.
 * Flight convention: nose = +Z, so aft = local AABB min.z (with small pad).
 * Fixes legacy FOX glow at (0,-0.51,0) which sat under the belly, not the tail.
 */
function computeAftNozzleLocal(body, parent, padZ) {
    if (!body || !parent || typeof THREE === 'undefined') {
        return new THREE.Vector3(0, 0, -0.2);
    }
    parent.updateMatrixWorld(true);
    body.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(body);
    const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    box.applyMatrix4(inv);
    const pad = Number.isFinite(Number(padZ)) ? Number(padZ) : 0.02;
    const y = (box.min.y + box.max.y) * 0.5;
    return new THREE.Vector3(0, y, box.min.z - pad);
}

if (typeof window !== 'undefined') {
    window.computeAftNozzleLocal = computeAftNozzleLocal;
}

/** URL / CONFIG gate for visual-only bomb+rocket eye-check on pylons. */
function groundStoresPreviewEnabled() {
    try {
        if (typeof window !== 'undefined' && window.location && window.location.search) {
            const q = new URLSearchParams(window.location.search).get('storesPreview');
            if (q === '0' || q === 'false') return false;
            if (q === '1' || q === 'true') return true;
        }
    } catch (e) { /* ignore */ }
    return !!(typeof CONFIG !== 'undefined' && CONFIG.preview && CONFIG.preview.groundStores);
}

/** Pick store mesh for a pylon weaponType (fallback to preview indices or FOX mesh). */
function meshBaseForWeaponType(weaponType, idx) {
    if (weaponType === 'bomb' && typeof bombMeshBase !== 'undefined' && bombMeshBase) return bombMeshBase;
    if (weaponType === 'rocket' && typeof rocketMeshBase !== 'undefined' && rocketMeshBase) return rocketMeshBase;
    return meshBaseForPylonIndex(idx);
}

/** Pick store mesh for a pylon index (preview swaps bomb/rocket; else FOX mesh). */
function meshBaseForPylonIndex(idx) {
    if (groundStoresPreviewEnabled() && typeof CONFIG !== 'undefined' && CONFIG.preview) {
        const bombIdx = Number.isFinite(Number(CONFIG.preview.bombPylonIndex))
            ? Number(CONFIG.preview.bombPylonIndex) : 0;
        const rocketIdx = Number.isFinite(Number(CONFIG.preview.rocketPylonIndex))
            ? Number(CONFIG.preview.rocketPylonIndex) : 3;
        if (idx === bombIdx && typeof bombMeshBase !== 'undefined' && bombMeshBase) return bombMeshBase;
        if (idx === rocketIdx && typeof rocketMeshBase !== 'undefined' && rocketMeshBase) return rocketMeshBase;
    }
    return missileMeshBase;
}

/** Upgrade bomb/rocket pylon visuals if async GLB assets finished loading after initial attach. */
function refreshStorePylonMeshes() {
    if (typeof teams === 'undefined') return;
    const ids = (typeof GameContext !== 'undefined' && GameContext.getRosterIds)
        ? GameContext.getRosterIds()
        : Object.keys(teams);
    ids.forEach((id) => {
        const t = teams[id];
        if (!t || !Array.isArray(t.pylons)) return;
        t.pylons.forEach((p, idx) => {
            if (!p || !p.mesh) return;
            const wt = p.weaponType;
            if (wt !== 'bomb' && wt !== 'rocket') return;
            const wantBase = (wt === 'bomb' && typeof bombMeshBase !== 'undefined' && bombMeshBase)
                ? bombMeshBase
                : ((wt === 'rocket' && typeof rocketMeshBase !== 'undefined' && rocketMeshBase) ? rocketMeshBase : null);
            if (!wantBase || p.mesh.userData.storeMeshKind === wt) return;
            while (p.mesh.children.length > 0) p.mesh.remove(p.mesh.children[0]);
            p.mesh.add(wantBase.clone());
            p.mesh.userData.storeMeshKind = wt;
        });
    });
}
if (typeof window !== 'undefined') window.refreshStorePylonMeshes = refreshStorePylonMeshes;

function tryAttachAllPylons() {
    const ids = (typeof GameContext !== 'undefined' && GameContext.getRosterIds)
        ? GameContext.getRosterIds()
        : ['red', 'blue'];
    if (!missileMeshBase) return;
    const matchCfg = (typeof GameContext !== 'undefined' && GameContext.getMatchConfig)
        ? GameContext.getMatchConfig()
        : null;
    ids.forEach(id => {
        const t = teams[id];
        if (!t || !t.wrapper || t.pylons) return;
        const acConfig = CONFIG.aircrafts[t.type || 'mig21'];
        let loadout = Array.isArray(t.pendingPylonLoadout)
            ? (typeof sanitizePylonLoadout === 'function' ? sanitizePylonLoadout(t.pendingPylonLoadout) : t.pendingPylonLoadout)
            : null;
        if (!loadout && matchCfg && matchCfg.seats) {
            const seat = Object.values(matchCfg.seats).find((s) => s && s.teamId === id);
            if (seat && seat.pylons) {
                loadout = typeof sanitizePylonLoadout === 'function'
                    ? sanitizePylonLoadout(seat.pylons)
                    : seat.pylons;
            }
        }
        t.pylons = acConfig.pylons.map((p, idx) => {
            const rawSlot = loadout && loadout[idx];
            const isEmpty = rawSlot === 'empty' || rawSlot === 'none' || rawSlot === 'gun';
            let weaponType = isEmpty
                ? 'empty'
                : ((rawSlot)
                    ? (typeof sanitizePylonWeapon === 'function' ? sanitizePylonWeapon(rawSlot) : rawSlot)
                    : (p.weapon || 'fox2'));
            // Preview mesh swap also tags store type for SMS / bomb path (opt-in via ?storesPreview=1).
            if (!isEmpty && groundStoresPreviewEnabled() && typeof CONFIG !== 'undefined' && CONFIG.preview) {
                const bombIdx = Number.isFinite(Number(CONFIG.preview.bombPylonIndex))
                    ? Number(CONFIG.preview.bombPylonIndex) : 0;
                const rocketIdx = Number.isFinite(Number(CONFIG.preview.rocketPylonIndex))
                    ? Number(CONFIG.preview.rocketPylonIndex) : 3;
                if (idx === bombIdx && typeof bombMeshBase !== 'undefined' && bombMeshBase) weaponType = 'bomb';
                else if (idx === rocketIdx && typeof rocketMeshBase !== 'undefined' && rocketMeshBase) weaponType = 'rocket';
            }
            const storeBase = meshBaseForWeaponType(weaponType, idx) || missileMeshBase;
            let pMesh = new THREE.Group(); pMesh.add(storeBase.clone());
            if ((weaponType === 'bomb' && storeBase === bombMeshBase) || (weaponType === 'rocket' && storeBase === rocketMeshBase)) {
                pMesh.userData.storeMeshKind = weaponType;
            }
            pMesh.position.set(p.position[0], p.position[1], p.position[2]); t.wrapper.add(pMesh);
            if (isEmpty) pMesh.visible = false;
            const pylonState = {
                id: p.id,
                localPosition: new THREE.Vector3(p.position[0], p.position[1], p.position[2]),
                weaponType,
                state: isEmpty ? 'empty' : 'standby'
            };
            if (weaponType === 'rocket') {
                const maxR = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.rocket
                    && Number(CONFIG.weapons.rocket.roundsPerPod)) || 9;
                pylonState.ammoMax = maxR;
                pylonState.ammo = maxR;
            }
            return GameContext.bindPylonView(id, pylonState, { mesh: pMesh, lineMesh: null });
        });
        t.activeMissiles = [];
        t.activeBombs = [];
        t.activeRockets = [];
        t.pendingPylonLoadout = null;
    });
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function sparkSeedFrom(step, pos) {
    const x = pos && Number.isFinite(Number(pos.x)) ? Math.floor(Number(pos.x) * 100) : 0;
    const y = pos && Number.isFinite(Number(pos.y)) ? Math.floor(Number(pos.y) * 100) : 0;
    const z = pos && Number.isFinite(Number(pos.z)) ? Math.floor(Number(pos.z) * 100) : 0;
    return ((Number(step) || 0) * 374761393 + x * 668265263 + y * 1274126177 + z * 2246822519) >>> 0;
}

const genSparksSeeded = (count, power, seed, fountain) => {
    const rnd = mulberry32((Number(seed) || 1) >>> 0);
    const vels = [];
    const n = Math.max(0, Number(count) || 0);
    const pwr = Number(power) || 0.4;
    for (let i = 0; i < n; i++) {
        const phi = rnd() * Math.PI * 2;
        const theta = Math.acos(rnd() * 2 - 1);
        const dir = new THREE.Vector3(
            Math.sin(theta) * Math.cos(phi),
            Math.sin(theta) * Math.sin(phi),
            Math.cos(theta)
        );
        if (fountain) {
            dir.y += 0.42 + rnd() * 0.25;
            dir.normalize();
            vels.push(dir.multiplyScalar(pwr * (0.85 + rnd() * 0.4)));
        } else {
            vels.push(dir.multiplyScalar(pwr * (0.8 + rnd() * 0.4)));
        }
    }
    return vels;
};

const genSparks = (count, power) => genSparksSeeded(count, power, (Math.random() * 0xffffffff) >>> 0, false);

/** Fountain burst: spray outward in all directions with a slight upward lift. */
const genSparksFountain = (count, power) => genSparksSeeded(count, power, (Math.random() * 0xffffffff) >>> 0, true);

/** Compact spark_explosion trigger: store seed instead of velocity arrays. */
function sparkBurstTrigger(step, pos, count, power, extra) {
    const seed = sparkSeedFrom(step, pos);
    return Object.assign({
        type: 'spark_explosion',
        step,
        pos: pos && pos.clone ? pos.clone() : pos,
        seed,
        count,
        power,
        fountain: false
    }, extra || {});
}

function sparkVelocitiesOf(trigger) {
    if (!trigger) return [];
    if (trigger.velocities && trigger.velocities.length) return trigger.velocities;
    const count = Number(trigger.count) || 0;
    if (count <= 0) return [];
    return genSparksSeeded(count, trigger.power || 0.4, trigger.seed || 1, !!trigger.fountain);
}
