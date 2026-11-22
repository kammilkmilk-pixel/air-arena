// ============================================================================
// ground-targets.js — Phase B map ground-target schema + runtime registry
// Schema (map JSON): groundTargets: [{ id, name, x, y, z, radius, hp, kind, faction }]
// Runtime: designate per team, blast damage from bomb/rocket Impact, 3D markers.
// ============================================================================
(function initGroundTargets(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AirArenaGroundTargets = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    /** @type {object[]} */
    let targets = [];
    let _group = null;
    let _markerGeo = null;
    let _ringGeo = null;

    const DEFAULT_SEED = [
        { id: 'gt_radar', name: '雷達站', x: 8, y: 0, z: 35, radius: 7, hp: 120, kind: 'radar' },
        { id: 'gt_depot', name: '彈藥庫', x: -15, y: 0, z: 50, radius: 8, hp: 100, kind: 'depot' },
        { id: 'gt_aaa', name: '防空陣地', x: 22, y: 0, z: 28, radius: 6, hp: 80, kind: 'aaa' }
    ];

    const KIND_COLOR = {
        radar: 0xffcc66,
        depot: 0xff8866,
        aaa: 0xff5566,
        bunker: 0xccaa88,
        default: 0xffd24a
    };

    function normalizeGroundTarget(raw, index) {
        const i = Number(index) || 0;
        const id = String((raw && raw.id) || `gt_${i}`);
        const hpMax = Math.max(1, Number(raw && raw.hp != null ? raw.hp : 100));
        return {
            id,
            name: String((raw && raw.name) || id),
            x: Number(raw && raw.x) || 0,
            y: Number(raw && raw.y) || 0,
            z: Number(raw && raw.z) || 0,
            radius: Math.max(2, Number(raw && raw.radius) || 6),
            hp: hpMax,
            hpMax,
            kind: String((raw && raw.kind) || 'default'),
            faction: (raw && raw.faction) || 'neutral',
            destroyed: false
        };
    }

    function normalizeList(rawList) {
        if (!Array.isArray(rawList)) return [];
        return rawList.map((r, i) => normalizeGroundTarget(r, i));
    }

    function defaultSeed(center) {
        const cx = center && Number.isFinite(center.x) ? Number(center.x) : 10;
        const cz = center && Number.isFinite(center.z) ? Number(center.z) : 20;
        return DEFAULT_SEED.map((t, i) => normalizeGroundTarget({
            ...t,
            x: t.x + (cx - 10) * 0.15,
            z: t.z + (cz - 20) * 0.15
        }, i));
    }

    function list(opts) {
        const aliveOnly = !(opts && opts.includeDestroyed);
        return targets.filter((t) => t && (!aliveOnly || !t.destroyed));
    }

    function get(id) {
        if (!id) return null;
        return targets.find((t) => t && t.id === id) || null;
    }

    function clearVisuals() {
        if (_group && typeof scene !== 'undefined' && scene) {
            scene.remove(_group);
        }
        if (_group) {
            _group.traverse((ch) => {
                if (ch.geometry && ch.geometry !== _markerGeo && ch.geometry !== _ringGeo) {
                    try { ch.geometry.dispose(); } catch (_) { /* ignore */ }
                }
                if (ch.material) {
                    const mats = Array.isArray(ch.material) ? ch.material : [ch.material];
                    mats.forEach((m) => { try { m.dispose(); } catch (_) { /* ignore */ } });
                }
            });
        }
        _group = null;
    }

    function clear() {
        clearVisuals();
        targets = [];
    }

    function ensureMarkerAssets() {
        if (typeof THREE === 'undefined') return false;
        if (!_markerGeo) _markerGeo = new THREE.ConeGeometry(1.1, 2.4, 4);
        if (!_ringGeo) _ringGeo = new THREE.RingGeometry(0.85, 1.0, 32);
        return true;
    }

    function syncVisuals() {
        if (typeof scene === 'undefined' || !scene || typeof THREE === 'undefined') return;
        if (!ensureMarkerAssets()) return;
        if (!_group) {
            _group = new THREE.Group();
            _group.name = 'groundTargets';
            scene.add(_group);
        }
        // Rebuild children each sync (few targets).
        while (_group.children.length) {
            const ch = _group.children[0];
            _group.remove(ch);
        }
        targets.forEach((t) => {
            if (!t || t.destroyed) return;
            const col = KIND_COLOR[t.kind] || KIND_COLOR.default;
            const marker = new THREE.Mesh(
                _markerGeo,
                new THREE.MeshBasicMaterial({
                    color: col, transparent: true, opacity: 0.85, depthWrite: false
                })
            );
            marker.position.set(t.x, t.y + 1.4, t.z);
            marker.rotation.x = Math.PI;
            marker.userData.groundTargetId = t.id;

            const ring = new THREE.Mesh(
                _ringGeo,
                new THREE.MeshBasicMaterial({
                    color: col, transparent: true, opacity: 0.35,
                    side: THREE.DoubleSide, depthWrite: false
                })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(t.x, t.y + 0.08, t.z);
            ring.scale.setScalar(t.radius);
            ring.userData.groundTargetId = t.id;

            _group.add(marker, ring);
        });
        _group.visible = targets.some((t) => t && !t.destroyed);
    }

    /**
     * Load from map doc. If doc has no groundTargets, seed defaults (unless opts.seed === false).
     */
    function loadFromMapDoc(doc, opts) {
        clear();
        const authored = doc && Array.isArray(doc.groundTargets) ? normalizeList(doc.groundTargets) : [];
        if (authored.length) {
            targets = authored;
        } else if (!(opts && opts.seed === false)) {
            const g = doc && doc.ground;
            targets = defaultSeed({
                x: g ? Number(g.centerX) || 10 : 10,
                z: g ? Number(g.centerZ) || 20 : 20
            });
        }
        syncVisuals();
        return list();
    }

    function resetHp() {
        targets.forEach((t) => {
            if (!t) return;
            t.hp = t.hpMax;
            t.destroyed = false;
        });
        syncVisuals();
    }

    function positionOf(t) {
        if (!t) return null;
        if (typeof THREE !== 'undefined' && THREE.Vector3) {
            return new THREE.Vector3(t.x, t.y, t.z);
        }
        return { x: t.x, y: t.y, z: t.z };
    }

    function horizDist(ax, az, bx, bz) {
        return Math.hypot((ax || 0) - (bx || 0), (az || 0) - (bz || 0));
    }

    function getNearest(worldPos, opts) {
        if (!worldPos) return null;
        const maxR = opts && Number.isFinite(opts.maxRange) ? Number(opts.maxRange) : Infinity;
        let best = null;
        let bestD = Infinity;
        list().forEach((t) => {
            const d = horizDist(worldPos.x, worldPos.z, t.x, t.z);
            if (d <= maxR && d < bestD) {
                bestD = d;
                best = t;
            }
        });
        return best;
    }

    function cycleId(currentId, dir) {
        const alive = list();
        if (!alive.length) return null;
        const step = dir < 0 ? -1 : 1;
        let idx = alive.findIndex((t) => t.id === currentId);
        if (idx < 0) return alive[0].id;
        idx = (idx + step + alive.length) % alive.length;
        return alive[idx].id;
    }

    function setDesignated(teamId, targetId) {
        if (typeof GameContext === 'undefined' || !GameContext.getTeam) return false;
        const team = GameContext.getTeam(teamId);
        if (!team) return false;
        if (!targetId) {
            team.designatedGroundTargetId = null;
            return true;
        }
        const t = get(targetId);
        if (!t || t.destroyed) return false;
        team.designatedGroundTargetId = targetId;
        return true;
    }

    function getDesignated(teamId) {
        if (typeof GameContext === 'undefined' || !GameContext.getTeam) return null;
        const team = GameContext.getTeam(teamId);
        if (!team || !team.designatedGroundTargetId) return null;
        const t = get(team.designatedGroundTargetId);
        if (!t || t.destroyed) {
            team.designatedGroundTargetId = null;
            return null;
        }
        return t;
    }

    /**
     * Resolve strike target for an AI seat: own designation → lead designation → nearest.
     */
    function resolveStrikeTarget(teamId, leadId, selfPos) {
        let t = getDesignated(teamId);
        if (t) return t;
        if (leadId) {
            t = getDesignated(leadId);
            if (t) return t;
        }
        return getNearest(selfPos, {});
    }

    function applyBlastDamage(worldPos, blastRadius, damage, opts) {
        if (!worldPos || !Number.isFinite(blastRadius)) return [];
        const dmg = Math.max(0, Number(damage) || 0);
        const hits = [];
        list().forEach((t) => {
            const d = horizDist(worldPos.x, worldPos.z, t.x, t.z);
            // Vertical: blast near ground — also accept slightly elevated detonations.
            const dy = Math.abs((Number(worldPos.y) || 0) - (Number(t.y) || 0));
            if (d <= blastRadius + t.radius * 0.35 && dy <= Math.max(blastRadius, 12)) {
                const before = t.hp;
                t.hp = Math.max(0, t.hp - dmg);
                if (t.hp <= 0 && !t.destroyed) {
                    t.destroyed = true;
                    t.destroyedBy = (opts && opts.ownerId) || null;
                }
                hits.push({
                    id: t.id,
                    damage: before - t.hp,
                    destroyed: t.destroyed,
                    hp: t.hp
                });
            }
        });
        if (hits.length) syncVisuals();
        return hits;
    }

    function toSerializable() {
        return targets.map((t) => ({
            id: t.id,
            name: t.name,
            x: t.x,
            y: t.y,
            z: t.z,
            radius: t.radius,
            hp: t.hp,
            hpMax: t.hpMax,
            kind: t.kind,
            faction: t.faction,
            destroyed: !!t.destroyed
        }));
    }

    function hydrate(listIn) {
        clear();
        targets = normalizeList(listIn || []).map((t) => {
            const row = { ...t };
            row.destroyed = !!t.destroyed || (Number(t.hp) <= 0);
            row.hp = row.destroyed ? 0 : Math.max(0, Number(t.hp) || row.hpMax);
            return row;
        });
        syncVisuals();
        return list({ includeDestroyed: true });
    }

    // Register on GameContext when available.
    function bindGameContext() {
        if (typeof GameContext === 'undefined' || !GameContext.registerService) return;
        GameContext.registerService('loadGroundTargets', loadFromMapDoc);
        GameContext.registerService('clearGroundTargets', clear);
        GameContext.registerService('resetGroundTargets', resetHp);
        GameContext.getGroundTargets = (opts) => list(opts);
        GameContext.getGroundTarget = (id) => get(id);
        GameContext.setDesignatedGroundTarget = (teamId, id) => setDesignated(teamId, id);
        GameContext.getDesignatedGroundTarget = (teamId) => getDesignated(teamId);
        GameContext.cycleDesignatedGroundTarget = (teamId, dir) => {
            const cur = getDesignated(teamId);
            const next = cycleId(cur && cur.id, dir);
            setDesignated(teamId, next);
            return get(next);
        };
    }

    if (typeof GameContext !== 'undefined') bindGameContext();
    else if (typeof setTimeout === 'function') {
        setTimeout(bindGameContext, 0);
    }

    return {
        DEFAULT_SEED,
        normalizeGroundTarget,
        normalizeList,
        defaultSeed,
        loadFromMapDoc,
        clear,
        resetHp,
        list,
        get,
        getNearest,
        positionOf,
        cycleId,
        setDesignated,
        getDesignated,
        resolveStrikeTarget,
        applyBlastDamage,
        syncVisuals,
        toSerializable,
        hydrate,
        bindGameContext
    };
});
