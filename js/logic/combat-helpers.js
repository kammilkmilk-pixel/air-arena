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

function tryAttachAllPylons() {
    const ids = (typeof GameContext !== 'undefined' && GameContext.getRosterIds)
        ? GameContext.getRosterIds()
        : ['red', 'blue'];
    if (!missileMeshBase) return;
    ids.forEach(id => {
        const t = teams[id];
        if (!t || !t.wrapper || t.pylons) return;
        const acConfig = CONFIG.aircrafts[t.type || 'mig21'];
        t.pylons = acConfig.pylons.map(p => {
            let pMesh = new THREE.Group(); pMesh.add(missileMeshBase.clone());
            pMesh.position.set(p.position[0], p.position[1], p.position[2]); t.wrapper.add(pMesh); 
            const pylonState = { id: p.id, localPosition: new THREE.Vector3(p.position[0], p.position[1], p.position[2]), weaponType: p.weapon, state: 'standby' };
            return GameContext.bindPylonView(id, pylonState, { mesh: pMesh, lineMesh: null });
        });
        t.activeMissiles = [];
    });
}

const genSparks = (count, power) => {
    let vels = [];
    for(let i=0; i<count; i++) {
        let phi = Math.random() * Math.PI * 2; let theta = Math.acos(Math.random() * 2 - 1);
        vels.push(new THREE.Vector3(Math.sin(theta)*Math.cos(phi), Math.sin(theta)*Math.sin(phi), Math.cos(theta)).multiplyScalar(power * (0.8 + Math.random() * 0.4)));
    }
    return vels;
};

/** Fountain burst: spray outward in all directions with a slight upward lift. */
const genSparksFountain = (count, power) => {
    const vels = [];
    for (let i = 0; i < count; i++) {
        const phi = Math.random() * Math.PI * 2;
        const theta = Math.acos(Math.random() * 2 - 1);
        const dir = new THREE.Vector3(
            Math.sin(theta) * Math.cos(phi),
            Math.sin(theta) * Math.sin(phi),
            Math.cos(theta)
        );
        dir.y += 0.42 + Math.random() * 0.25;
        dir.normalize();
        vels.push(dir.multiplyScalar(power * (0.85 + Math.random() * 0.4)));
    }
    return vels;
};
