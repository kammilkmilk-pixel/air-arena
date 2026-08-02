// ============================================================================
// ai-map.js - Thin baked AI spatial summary (layer B)
// Sidecar: assets/maps/<mapId>.ai-map.json  |  missing → bake from obstacles/doc at load
// ============================================================================
(function initAiMap(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AirArenaAiMap = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const VERSION = 1;
    const DEFAULT_CELL = 10;
    const LANE = Object.freeze({
        dirt: 0,
        canyon: 1,
        combat: 2,
        rooftop: 3,
        high: 4
    });
    const LANE_NAME = Object.freeze(['dirt', 'canyon', 'combat', 'rooftop', 'high']);

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function sidecarUrlFromMapPath(mapPath) {
        if (!mapPath || typeof mapPath !== 'string') return null;
        if (/\.ai-map\.json$/i.test(mapPath)) return mapPath;
        if (/\.json$/i.test(mapPath)) return mapPath.replace(/\.json$/i, '.ai-map.json');
        return `${mapPath}.ai-map.json`;
    }

    function laneFromRoofMax(roofMax) {
        const h = Number(roofMax) || 0;
        if (h < 14) return LANE.dirt;
        if (h < 30) return LANE.canyon;
        if (h < 55) return LANE.combat;
        if (h < 80) return LANE.rooftop;
        return LANE.high;
    }

    function skyOpenFromRoofMax(roofMax) {
        // Combat-band flight (~48) clear of this cell's roof with ~8m margin.
        return (Number(roofMax) || 0) < 40 ? 1 : 0;
    }

    function sarhPerchFromRoofMax(roofMax) {
        // Open / low-roof cells suitable as FOX-1 standoff / illuminate perch.
        return (Number(roofMax) || 0) < 32 ? 1 : 0;
    }

    function emptyGrid(cols, rows) {
        const n = cols * rows;
        return {
            roofMax: new Array(n).fill(0),
            lane: new Array(n).fill(LANE.dirt),
            skyOpen: new Array(n).fill(1),
            sarhPerch: new Array(n).fill(1)
        };
    }

    function finalizeCellFlags(grid) {
        const n = grid.roofMax.length;
        for (let i = 0; i < n; i++) {
            const h = Number(grid.roofMax[i]) || 0;
            grid.roofMax[i] = Number(h.toFixed(1));
            grid.lane[i] = laneFromRoofMax(h);
            grid.skyOpen[i] = skyOpenFromRoofMax(h);
            grid.sarhPerch[i] = sarhPerchFromRoofMax(h);
        }
        return grid;
    }

    /**
     * @param {Array<{minX:number,maxX:number,minZ:number,maxZ:number,roofY:number}>} roofs
     * @param {{originX:number,originZ:number,width:number,depth:number,cellSize?:number,mapId?:string}} bounds
     */
    function bakeFromRoofBoxes(roofs, bounds = {}) {
        const cellSize = Math.max(4, Number(bounds.cellSize) || DEFAULT_CELL);
        const width = Math.max(cellSize, Number(bounds.width) || 900);
        const depth = Math.max(cellSize, Number(bounds.depth) || 900);
        const originX = Number.isFinite(bounds.originX) ? bounds.originX : -width * 0.5;
        const originZ = Number.isFinite(bounds.originZ) ? bounds.originZ : -depth * 0.5;
        const cols = Math.max(1, Math.ceil(width / cellSize));
        const rows = Math.max(1, Math.ceil(depth / cellSize));
        const grid = emptyGrid(cols, rows);
        const list = Array.isArray(roofs) ? roofs : [];

        for (let r = 0; r < list.length; r++) {
            const box = list[r];
            if (!box) continue;
            const roofY = Math.max(0, Number(box.roofY) || 0);
            if (roofY <= 0) continue;
            const minX = Number(box.minX);
            const maxX = Number(box.maxX);
            const minZ = Number(box.minZ);
            const maxZ = Number(box.maxZ);
            if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) continue;
            const c0 = clamp(Math.floor((minX - originX) / cellSize), 0, cols - 1);
            const c1 = clamp(Math.floor((maxX - originX) / cellSize), 0, cols - 1);
            const r0 = clamp(Math.floor((minZ - originZ) / cellSize), 0, rows - 1);
            const r1 = clamp(Math.floor((maxZ - originZ) / cellSize), 0, rows - 1);
            for (let row = r0; row <= r1; row++) {
                for (let col = c0; col <= c1; col++) {
                    const idx = row * cols + col;
                    if (roofY > grid.roofMax[idx]) grid.roofMax[idx] = roofY;
                }
            }
        }

        finalizeCellFlags(grid);
        return {
            version: VERSION,
            mapId: bounds.mapId || null,
            source: bounds.source || 'bake',
            cellSize,
            originX: Number(originX.toFixed(2)),
            originZ: Number(originZ.toFixed(2)),
            width: Number(width.toFixed(2)),
            depth: Number(depth.toFixed(2)),
            cols,
            rows,
            roofMax: grid.roofMax,
            lane: grid.lane,
            skyOpen: grid.skyOpen,
            sarhPerch: grid.sarhPerch
        };
    }

    /** Bake from map JSON box objects (+ optional ground bounds). */
    function bakeFromMapDoc(doc, opts = {}) {
        const ground = (doc && doc.ground) || {};
        const width = Number(ground.width) || 900;
        const depth = Number(ground.depth) || 900;
        const centerX = Number(ground.centerX) || 0;
        const centerZ = Number(ground.centerZ) || 0;
        const objects = (doc && Array.isArray(doc.objects)) ? doc.objects : [];
        const roofs = [];
        for (let i = 0; i < objects.length; i++) {
            const o = objects[i];
            if (!o || o.kind === 'glb') continue;
            if (o.collision === false) continue;
            const w = Math.max(0.1, Number(o.w) || 4);
            const d = Math.max(0.1, Number(o.d) || 4);
            const h = Math.max(0.1, Number(o.h) || 10);
            const x = Number(o.x) || 0;
            const y = Number(o.y) || 0;
            const z = Number(o.z) || 0;
            roofs.push({
                minX: x - w * 0.5,
                maxX: x + w * 0.5,
                minZ: z - d * 0.5,
                maxZ: z + d * 0.5,
                roofY: y + h
            });
        }
        return bakeFromRoofBoxes(roofs, {
            cellSize: opts.cellSize || DEFAULT_CELL,
            originX: centerX - width * 0.5,
            originZ: centerZ - depth * 0.5,
            width,
            depth,
            mapId: opts.mapId || (doc && doc.name) || null,
            source: 'mapDoc'
        });
    }

    /** Bake from live THREE obstacle meshes (AABB tops). */
    function bakeFromObstacles(obstacles, opts = {}) {
        const list = Array.isArray(obstacles) ? obstacles : [];
        const roofs = [];
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        const hasTHREE = typeof THREE !== 'undefined' && THREE.Box3;
        const box = hasTHREE ? new THREE.Box3() : null;

        for (let i = 0; i < list.length; i++) {
            const obj = list[i];
            if (!obj) continue;
            if (obj.userData && obj.userData.isCollisionProxy) continue;
            let minx;
            let maxx;
            let minz;
            let maxz;
            let roofY;
            if (box && typeof obj.updateWorldMatrix === 'function') {
                box.setFromObject(obj);
                if (!Number.isFinite(box.max.y)) continue;
                minx = box.min.x;
                maxx = box.max.x;
                minz = box.min.z;
                maxz = box.max.z;
                roofY = box.max.y;
            } else if (obj._box) {
                minx = obj._box.min.x;
                maxx = obj._box.max.x;
                minz = obj._box.min.z;
                maxz = obj._box.max.z;
                roofY = obj._box.max.y;
            } else continue;
            roofs.push({ minX: minx, maxX: maxx, minZ: minz, maxZ: maxz, roofY });
            minX = Math.min(minX, minx);
            maxX = Math.max(maxX, maxx);
            minZ = Math.min(minZ, minz);
            maxZ = Math.max(maxZ, maxz);
        }

        let originX;
        let originZ;
        let width;
        let depth;
        if (Number.isFinite(opts.originX) && Number.isFinite(opts.width)) {
            originX = opts.originX;
            originZ = opts.originZ;
            width = opts.width;
            depth = opts.depth;
        } else if (Number.isFinite(minX) && minX !== Infinity) {
            const pad = Number(opts.pad) || 40;
            originX = minX - pad;
            originZ = minZ - pad;
            width = (maxX - minX) + pad * 2;
            depth = (maxZ - minZ) + pad * 2;
        } else {
            originX = -450;
            originZ = -450;
            width = 900;
            depth = 900;
        }

        return bakeFromRoofBoxes(roofs, {
            cellSize: opts.cellSize || DEFAULT_CELL,
            originX,
            originZ,
            width,
            depth,
            mapId: opts.mapId || null,
            source: 'obstacles'
        });
    }

    function hydrate(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const cols = Math.max(1, Number(raw.cols) || 0);
        const rows = Math.max(1, Number(raw.rows) || 0);
        const n = cols * rows;
        if (!Array.isArray(raw.roofMax) || raw.roofMax.length < n) return null;
        const map = {
            version: Number(raw.version) || VERSION,
            mapId: raw.mapId || null,
            source: raw.source || 'sidecar',
            cellSize: Math.max(4, Number(raw.cellSize) || DEFAULT_CELL),
            originX: Number(raw.originX) || 0,
            originZ: Number(raw.originZ) || 0,
            width: Number(raw.width) || cols * DEFAULT_CELL,
            depth: Number(raw.depth) || rows * DEFAULT_CELL,
            cols,
            rows,
            roofMax: raw.roofMax.slice(0, n).map((v) => Number(v) || 0),
            lane: Array.isArray(raw.lane) && raw.lane.length >= n
                ? raw.lane.slice(0, n).map((v) => clamp(Number(v) || 0, 0, 4))
                : null,
            skyOpen: Array.isArray(raw.skyOpen) && raw.skyOpen.length >= n
                ? raw.skyOpen.slice(0, n).map((v) => (v ? 1 : 0))
                : null,
            sarhPerch: Array.isArray(raw.sarhPerch) && raw.sarhPerch.length >= n
                ? raw.sarhPerch.slice(0, n).map((v) => (v ? 1 : 0))
                : null
        };
        if (!map.lane || !map.skyOpen || !map.sarhPerch) {
            const grid = {
                roofMax: map.roofMax.slice(),
                lane: new Array(n),
                skyOpen: new Array(n),
                sarhPerch: new Array(n)
            };
            finalizeCellFlags(grid);
            map.lane = grid.lane;
            map.skyOpen = grid.skyOpen;
            map.sarhPerch = grid.sarhPerch;
        }
        return map;
    }

    function toJSON(map) {
        if (!map) return null;
        return {
            version: map.version || VERSION,
            mapId: map.mapId || null,
            source: map.source || 'bake',
            cellSize: map.cellSize,
            originX: map.originX,
            originZ: map.originZ,
            width: map.width,
            depth: map.depth,
            cols: map.cols,
            rows: map.rows,
            roofMax: map.roofMax,
            lane: map.lane,
            skyOpen: map.skyOpen,
            sarhPerch: map.sarhPerch
        };
    }

    function indexAt(map, x, z) {
        if (!map) return -1;
        const col = Math.floor((Number(x) - map.originX) / map.cellSize);
        const row = Math.floor((Number(z) - map.originZ) / map.cellSize);
        if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return -1;
        return row * map.cols + col;
    }

    /**
     * @returns {{ ok:boolean, col:number, row:number, roofMax:number, lane:string, skyOpen:boolean, sarhPerch:boolean }|null}
     */
    function query(map, x, z) {
        if (!map) return null;
        const col = Math.floor((Number(x) - map.originX) / map.cellSize);
        const row = Math.floor((Number(z) - map.originZ) / map.cellSize);
        if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) {
            return {
                ok: false,
                col,
                row,
                roofMax: 0,
                lane: 'dirt',
                skyOpen: true,
                sarhPerch: true,
                outOfBounds: true
            };
        }
        const idx = row * map.cols + col;
        const roofMax = Number(map.roofMax[idx]) || 0;
        const laneIdx = Number(map.lane[idx]) || 0;
        return {
            ok: true,
            col,
            row,
            idx,
            roofMax,
            lane: LANE_NAME[laneIdx] || 'dirt',
            laneId: laneIdx,
            skyOpen: !!(map.skyOpen && map.skyOpen[idx]),
            sarhPerch: !!(map.sarhPerch && map.sarhPerch[idx]),
            outOfBounds: false
        };
    }

    /** Local max roof in a world-radius (for FOX-1 / open-sky checks). */
    function queryRoofMaxInRadius(map, x, z, radius = 80) {
        if (!map) return { ok: false, roofMax: 0, samples: 0 };
        const r = Math.max(0, Number(radius) || 0);
        const cell = map.cellSize;
        const c0 = Math.floor((x - r - map.originX) / cell);
        const c1 = Math.floor((x + r - map.originX) / cell);
        const r0 = Math.floor((z - r - map.originZ) / cell);
        const r1 = Math.floor((z + r - map.originZ) / cell);
        let roofMax = 0;
        let samples = 0;
        for (let row = r0; row <= r1; row++) {
            if (row < 0 || row >= map.rows) continue;
            for (let col = c0; col <= c1; col++) {
                if (col < 0 || col >= map.cols) continue;
                const cx = map.originX + (col + 0.5) * cell;
                const cz = map.originZ + (row + 0.5) * cell;
                const dx = cx - x;
                const dz = cz - z;
                if ((dx * dx + dz * dz) > r * r) continue;
                const h = Number(map.roofMax[row * map.cols + col]) || 0;
                if (h > roofMax) roofMax = h;
                samples++;
            }
        }
        return { ok: samples > 0, roofMax, samples };
    }

    async function tryFetchJson(url) {
        if (!url || typeof fetch !== 'function') return null;
        try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (!res.ok) return null;
            return await res.json();
        } catch (_) {
            return null;
        }
    }

    /**
     * Prefer sidecar file; else bake from doc boxes; else bake from live obstacles.
     */
    async function ensureAiMap(opts = {}) {
        const mapId = opts.mapId || null;
        const mapPath = opts.mapPath || null;
        const sidecar =
            opts.aiMapPath ||
            (mapPath ? sidecarUrlFromMapPath(mapPath) : null) ||
            (mapId && mapId !== 'original' ? `assets/maps/${mapId}.ai-map.json` : null);

        if (sidecar) {
            const raw = await tryFetchJson(sidecar);
            const hydrated = hydrate(raw);
            if (hydrated) {
                hydrated.mapId = hydrated.mapId || mapId;
                hydrated.source = 'sidecar';
                return hydrated;
            }
        }

        if (opts.doc && opts.doc.objects) {
            return bakeFromMapDoc(opts.doc, { mapId, cellSize: opts.cellSize });
        }

        if (opts.obstacles && opts.obstacles.length) {
            return bakeFromObstacles(opts.obstacles, {
                mapId,
                cellSize: opts.cellSize,
                originX: opts.originX,
                originZ: opts.originZ,
                width: opts.width,
                depth: opts.depth
            });
        }

        return bakeFromRoofBoxes([], {
            mapId,
            cellSize: opts.cellSize || DEFAULT_CELL,
            originX: -450,
            originZ: -450,
            width: 900,
            depth: 900,
            source: 'empty'
        });
    }

    function installOnGameContext(map) {
        if (typeof GameContext === 'undefined' || !GameContext.three) return map;
        GameContext.three.aiMap = map || null;
        return map;
    }

    return {
        VERSION,
        DEFAULT_CELL,
        LANE,
        LANE_NAME,
        sidecarUrlFromMapPath,
        bakeFromRoofBoxes,
        bakeFromMapDoc,
        bakeFromObstacles,
        hydrate,
        toJSON,
        indexAt,
        query,
        queryRoofMaxInRadius,
        ensureAiMap,
        installOnGameContext,
        tryFetchJson
    };
});
