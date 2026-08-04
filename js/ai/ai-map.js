// ============================================================================
// ai-map.js - Baked AI spatial OS (Phase 1–3 MVP)
// Sidecar: assets/maps/<mapId>.ai-map.json  |  missing → bake from obstacles/doc at load
// Soft authority: roofMax / skyOpen / sarhPerch / mapLane (roof band).
// Phase 2: samplePlannerCorridor feeds planUrbanRoute / scored escape (not pathfinding).
// Phase 3a–c: sampleSurvivalWaypoints (long greedy + climbBias) + findBakePath (grid A*);
// PilotAI consumes via scored combat/escape — pressure-armed stick bias only, no hard force.
// Not a full stick planner — PilotAI flightBand + decide stack consume these flags.
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

    /**
     * Phase 2 planner feed: forward + ±lateral roof/sky samples along heading XZ.
     * Prefer open (low roof / skyOpen) side for joyX; not a waypoint path.
     * preferredSide matches AABB gap convention: -1 = left more open, +1 = right.
     */
    function samplePlannerCorridor(map, x, z, headingX, headingZ, altitude, opts = {}) {
        const empty = {
            ok: false,
            preferredSide: 0,
            strength: 0,
            forwardClear: false,
            forwardSkyOpen: false,
            forwardRoofMax: 0,
            leftClear: false,
            rightClear: false,
            leftRoofMax: 0,
            rightRoofMax: 0,
            corridorOpen: false,
            mapLaneAhead: null
        };
        if (!map) return empty;
        let fx = Number(headingX) || 0;
        let fz = Number(headingZ) || 0;
        const flen = Math.hypot(fx, fz);
        if (flen < 1e-4) {
            fx = 0;
            fz = 1;
        } else {
            fx /= flen;
            fz /= flen;
        }
        // Left of forward in XZ: (-fz, fx)
        const lx = -fz;
        const lz = fx;
        const cell = Math.max(4, Number(map.cellSize) || DEFAULT_CELL);
        const look = Number(opts.lookAhead) || cell * 3;
        const lateral = Number(opts.lateral) || cell * 1.5;
        const margin = Number(opts.margin) || 8;
        const alt = Number(altitude);
        const altOk = Number.isFinite(alt);

        function sampleAt(wx, wz) {
            const q = query(map, wx, wz);
            const roof = q && Number.isFinite(Number(q.roofMax)) ? Number(q.roofMax) : 0;
            const sky = !!(q && (q.skyOpen || q.outOfBounds));
            const clear = sky || (altOk && alt >= roof + margin);
            return {
                roofMax: roof,
                skyOpen: sky,
                clear,
                mapLane: q && q.ok ? q.lane : null
            };
        }

        const fwdDists = [look * 0.5, look, look * 1.5];
        let forwardRoofMax = 0;
        let forwardSkyVotes = 0;
        let forwardClearVotes = 0;
        let mapLaneAhead = null;
        for (let i = 0; i < fwdDists.length; i++) {
            const d = fwdDists[i];
            const s = sampleAt(x + fx * d, z + fz * d);
            if (s.roofMax > forwardRoofMax) forwardRoofMax = s.roofMax;
            if (s.skyOpen) forwardSkyVotes += 1;
            if (s.clear) forwardClearVotes += 1;
            if (!mapLaneAhead && s.mapLane) mapLaneAhead = s.mapLane;
        }
        const forwardSkyOpen = forwardSkyVotes >= 2;
        const forwardClear = forwardClearVotes >= 2 || (forwardSkyOpen && altOk && alt >= forwardRoofMax + margin);

        function sideStats(sign) {
            let roofMax = 0;
            let clearVotes = 0;
            let skyVotes = 0;
            for (let i = 0; i < fwdDists.length; i++) {
                const d = fwdDists[i];
                const s = sampleAt(
                    x + fx * d + lx * lateral * sign,
                    z + fz * d + lz * lateral * sign
                );
                if (s.roofMax > roofMax) roofMax = s.roofMax;
                if (s.clear) clearVotes += 1;
                if (s.skyOpen) skyVotes += 1;
            }
            return {
                roofMax,
                clear: clearVotes >= 2,
                skyOpen: skyVotes >= 2,
                clearVotes
            };
        }
        // sign +1 = world-left samples (lx,lz); sign -1 = world-right
        const left = sideStats(1);
        const right = sideStats(-1);
        const leftOpen = left.clearVotes + (left.skyOpen ? 1 : 0);
        const rightOpen = right.clearVotes + (right.skyOpen ? 1 : 0);
        const openDiff = leftOpen - rightOpen;
        const roofDiff = right.roofMax - left.roofMax; // positive → left lower roof (prefer left)
        let preferredSide = 0;
        let strength = 0;
        if (Math.abs(openDiff) >= 2 || Math.abs(roofDiff) >= 12) {
            preferredSide = openDiff !== 0
                ? (openDiff > 0 ? -1 : 1)
                : (roofDiff > 0 ? -1 : 1);
            strength = (Math.abs(openDiff) >= 3 || Math.abs(roofDiff) >= 24) ? 2 : 1;
        } else if (Math.abs(openDiff) >= 1 || Math.abs(roofDiff) >= 6) {
            preferredSide = openDiff !== 0
                ? (openDiff > 0 ? -1 : 1)
                : (roofDiff > 0 ? -1 : 1);
            strength = 1;
        }
        const corridorOpen =
            (left.clear && right.clear) ||
            (forwardClear && (left.clear || right.clear)) ||
            (left.clearVotes + right.clearVotes >= 4);

        return {
            ok: true,
            preferredSide,
            strength,
            forwardClear,
            forwardSkyOpen,
            forwardRoofMax,
            leftClear: left.clear,
            rightClear: right.clear,
            leftRoofMax: left.roofMax,
            rightRoofMax: right.roofMax,
            corridorOpen,
            mapLaneAhead
        };
    }

    function waypointSteerSummary(waypoints, x, z, fx, fz, stepDist, alt, margin) {
        const empty = {
            preferredSide: 0,
            climbBias: 0,
            targetAlt: null,
            firstClear: false,
            strength: 0
        };
        if (!waypoints || !waypoints.length) return empty;
        const first = waypoints[0];
        const firstDx = first.x - (Number(x) || 0);
        const firstDz = first.z - (Number(z) || 0);
        const crossY = fx * firstDz - fz * firstDx;
        let preferredSide = 0;
        const sideThresh = Math.max(4, (Number(stepDist) || 20) * 0.12);
        if (Math.abs(crossY) > sideThresh) {
            preferredSide = crossY > 0 ? -1 : 1;
        }
        const clearCount = waypoints.filter((w) => w.clear).length;
        const strength = clearCount >= 3 ? 2 : (clearCount >= 1 || first.clear ? 1 : 0);
        const peakRoof = waypoints.reduce((m, w) => Math.max(m, Number(w.roofMax) || 0), 0);
        const m = Number(margin) || 8;
        const a = Number(alt);
        let climbBias = 0;
        let targetAlt = Number.isFinite(a) ? a : null;
        if (Number.isFinite(a)) {
            const need = peakRoof + m + 4;
            if (a < need) {
                climbBias = clamp((need - a) / 24, 0.15, 1);
                targetAlt = Number(need.toFixed(1));
            } else if (!preferredSide && (first.clear || first.skyOpen)) {
                climbBias = 0.35;
                targetAlt = Number(Math.max(a, peakRoof + m).toFixed(1));
            }
        }
        return {
            preferredSide,
            climbBias,
            targetAlt,
            firstClear: !!first.clear,
            strength
        };
    }

    /**
     * Phase 3b: greedy open-cell chain (default 6–12 steps / ~150–250m), not A*.
     * Returns XZ waypoints + preferredSide + climbBias / targetAlt.
     */
    function sampleSurvivalWaypoints(map, x, z, headingX, headingZ, altitude, opts = {}) {
        const empty = {
            ok: false,
            waypoints: [],
            preferredSide: 0,
            strength: 0,
            firstClear: false,
            steps: 0,
            climbBias: 0,
            targetAlt: null,
            source: 'greedy'
        };
        if (!map) return empty;
        let fx = Number(headingX) || 0;
        let fz = Number(headingZ) || 0;
        const flen = Math.hypot(fx, fz);
        if (flen < 1e-4) {
            fx = 0;
            fz = 1;
        } else {
            fx /= flen;
            fz /= flen;
        }
        const cell = Math.max(4, Number(map.cellSize) || DEFAULT_CELL);
        const stepDist = Number(opts.stepDist) || cell * 2;
        const steps = Math.max(2, Math.min(12, Math.round(Number(opts.steps) || 8)));
        const lateral = Number(opts.lateral) || cell * 1.25;
        const margin = Number(opts.margin) || 8;
        const alt = Number(altitude);
        const altOk = Number.isFinite(alt);

        function sampleAt(wx, wz) {
            const q = query(map, wx, wz);
            const roof = q && Number.isFinite(Number(q.roofMax)) ? Number(q.roofMax) : 0;
            const sky = !!(q && (q.skyOpen || q.outOfBounds));
            const clear = sky || (altOk && alt >= roof + margin);
            const headroom = altOk ? alt - roof : 0;
            return {
                x: wx,
                z: wz,
                roofMax: roof,
                skyOpen: sky,
                clear,
                headroom,
                mapLane: q && q.ok ? q.lane : null
            };
        }

        function scoreCell(s) {
            let sc = 0;
            if (s.clear) sc += 40;
            if (s.skyOpen) sc += 18;
            sc += Math.max(0, 36 - Math.min(36, s.roofMax * 0.45));
            if (s.mapLane === 'dirt' || s.mapLane === 'canyon') sc += 4;
            // Prefer cells with altitude margin; punish flying under/near tall roofs.
            if (altOk) {
                if (s.headroom >= margin) sc += Math.min(22, s.headroom * 0.55);
                else if (s.headroom < 0) sc -= Math.min(50, -s.headroom * 0.8);
                else sc -= Math.min(24, (margin - s.headroom) * 1.2);
            }
            return sc;
        }

        const offsets = [
            { f: 1, l: 0 },
            { f: 1, l: 0.85 },
            { f: 1, l: -0.85 },
            { f: 0.55, l: 1.15 },
            { f: 0.55, l: -1.15 }
        ];

        let cx = Number(x) || 0;
        let cz = Number(z) || 0;
        let hfx = fx;
        let hfz = fz;
        const waypoints = [];
        for (let step = 0; step < steps; step++) {
            let best = null;
            let bestScore = -Infinity;
            for (let i = 0; i < offsets.length; i++) {
                const o = offsets[i];
                const wx = cx + hfx * stepDist * o.f + (-hfz) * lateral * o.l;
                const wz = cz + hfz * stepDist * o.f + hfx * lateral * o.l;
                const s = sampleAt(wx, wz);
                const sc = scoreCell(s);
                if (sc > bestScore) {
                    bestScore = sc;
                    best = s;
                }
            }
            if (!best) break;
            waypoints.push({
                x: Number(best.x.toFixed(2)),
                z: Number(best.z.toFixed(2)),
                roofMax: best.roofMax,
                skyOpen: best.skyOpen ? 1 : 0,
                clear: best.clear ? 1 : 0,
                score: Number(bestScore.toFixed(1)),
                targetAlt: altOk
                    ? Number(Math.max(alt, best.roofMax + margin).toFixed(1))
                    : null
            });
            const dx = best.x - cx;
            const dz = best.z - cz;
            const dl = Math.hypot(dx, dz);
            if (dl > 1e-3) {
                hfx = dx / dl;
                hfz = dz / dl;
            }
            cx = best.x;
            cz = best.z;
        }

        if (!waypoints.length) return empty;
        const steer = waypointSteerSummary(waypoints, x, z, fx, fz, stepDist, alt, margin);
        return {
            ok: steer.strength >= 1 || waypoints.length >= 2,
            waypoints,
            preferredSide: steer.preferredSide,
            strength: steer.strength,
            firstClear: steer.firstClear,
            steps: waypoints.length,
            climbBias: steer.climbBias,
            targetAlt: steer.targetAlt,
            source: 'greedy'
        };
    }

    /**
     * Phase 3c: short-horizon A* on bake cells toward open/low-roof goal in heading cone.
     * Cost = travel + high roof + low altitude margin + turn. Falls back empty if no path.
     */
    function findBakePath(map, x, z, headingX, headingZ, altitude, opts = {}) {
        const empty = {
            ok: false,
            waypoints: [],
            preferredSide: 0,
            strength: 0,
            firstClear: false,
            steps: 0,
            climbBias: 0,
            targetAlt: null,
            source: 'path'
        };
        if (!map || !map.roofMax) return empty;
        const cell = Math.max(4, Number(map.cellSize) || DEFAULT_CELL);
        const cols = Number(map.cols) || 0;
        const rows = Number(map.rows) || 0;
        if (cols < 2 || rows < 2) return empty;
        const originX = Number(map.originX) || 0;
        const originZ = Number(map.originZ) || 0;
        let fx = Number(headingX) || 0;
        let fz = Number(headingZ) || 0;
        const flen = Math.hypot(fx, fz);
        if (flen < 1e-4) {
            fx = 0;
            fz = 1;
        } else {
            fx /= flen;
            fz /= flen;
        }
        const margin = Number(opts.margin) || 8;
        const alt = Number(altitude);
        const altOk = Number.isFinite(alt);
        const maxExpand = Math.max(40, Math.min(220, Math.round(Number(opts.maxExpand) || 140)));
        const goalDist = Number(opts.goalDist) || cell * 10;
        const startIdx = indexAt(map, x, z);
        if (startIdx < 0) return empty;

        function cellCenter(idx) {
            const c = idx % cols;
            const r = Math.floor(idx / cols);
            return {
                x: originX + (c + 0.5) * cell,
                z: originZ + (r + 0.5) * cell,
                c,
                r
            };
        }

        function roofAt(idx) {
            return Number(map.roofMax[idx]) || 0;
        }

        function cellClear(idx) {
            const roof = roofAt(idx);
            const sky = roof < 40;
            return sky || (altOk && alt >= roof + margin);
        }

        function stepCost(fromIdx, toIdx, fromDirC, fromDirR) {
            const roof = roofAt(toIdx);
            let cost = 1;
            cost += Math.min(18, roof * 0.12);
            if (altOk) {
                const head = alt - roof;
                if (head < 0) cost += Math.min(40, -head * 0.9);
                else if (head < margin) cost += (margin - head) * 0.55;
            }
            if (!cellClear(toIdx)) cost += 10;
            const to = cellCenter(toIdx);
            const from = cellCenter(fromIdx);
            const dc = Math.sign(to.c - from.c);
            const dr = Math.sign(to.r - from.r);
            if (fromDirC !== 0 || fromDirR !== 0) {
                if (dc !== fromDirC || dr !== fromDirR) cost += 1.6;
            }
            // Prefer staying in forward hemisphere.
            const dx = to.x - (Number(x) || 0);
            const dz = to.z - (Number(z) || 0);
            const dot = dx * fx + dz * fz;
            if (dot < 0) cost += 4;
            return cost;
        }

        function clampWorldToMap(wx, wz) {
            const minX = originX + cell * 0.5;
            const maxX = originX + cols * cell - cell * 0.5;
            const minZ = originZ + cell * 0.5;
            const maxZ = originZ + rows * cell - cell * 0.5;
            return {
                x: clamp(wx, minX, maxX),
                z: clamp(wz, minZ, maxZ)
            };
        }

        function scoreGoalIdx(idx) {
            if (idx < 0 || idx === startIdx) return -Infinity;
            const p = cellCenter(idx);
            const dx = p.x - (Number(x) || 0);
            const dz = p.z - (Number(z) || 0);
            const dist = Math.hypot(dx, dz);
            const dot = dx * fx + dz * fz;
            const roof = roofAt(idx);
            let sc = cellClear(idx) ? 40 : 0;
            sc += Math.max(0, 50 - roof);
            if (altOk && alt >= roof + margin) sc += 20;
            sc += Math.min(30, Math.max(0, dot)); // prefer forward
            sc += Math.min(18, dist / cell); // prefer some standoff
            if (dot < -cell) sc -= 25;
            return sc;
        }

        // Goal: best open/low-roof cell near look-ahead (clamped in-bounds).
        const maxGoalR = Math.min(goalDist * 1.35, Math.hypot(cols, rows) * cell * 0.85);
        const goalProbe = [
            Math.min(goalDist * 0.4, maxGoalR),
            Math.min(goalDist * 0.7, maxGoalR),
            Math.min(goalDist, maxGoalR),
            Math.min(goalDist * 1.2, maxGoalR)
        ];
        let goalIdx = -1;
        let bestGoalScore = -Infinity;
        for (let i = 0; i < goalProbe.length; i++) {
            const d = goalProbe[i];
            for (const lat of [0, cell * 1.2, -cell * 1.2, cell * 2.2, -cell * 2.2, cell * 3.5, -cell * 3.5]) {
                const rawX = Number(x) + fx * d + (-fz) * lat;
                const rawZ = Number(z) + fz * d + fx * lat;
                const clamped = clampWorldToMap(rawX, rawZ);
                const idx = indexAt(map, clamped.x, clamped.z);
                const sc = scoreGoalIdx(idx);
                if (sc > bestGoalScore) {
                    bestGoalScore = sc;
                    goalIdx = idx;
                }
            }
        }
        // Map-edge / OOB heading: scan nearby cells for a usable goal.
        if (goalIdx < 0 || goalIdx === startIdx || bestGoalScore < 0) {
            const start = cellCenter(startIdx);
            const scanR = Math.max(2, Math.min(8, Math.ceil(maxGoalR / cell)));
            for (let dr = -scanR; dr <= scanR; dr++) {
                for (let dc = -scanR; dc <= scanR; dc++) {
                    if (dc === 0 && dr === 0) continue;
                    const nc = start.c + dc;
                    const nr = start.r + dr;
                    if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                    const idx = nr * cols + nc;
                    const sc = scoreGoalIdx(idx);
                    if (sc > bestGoalScore) {
                        bestGoalScore = sc;
                        goalIdx = idx;
                    }
                }
            }
        }
        if (goalIdx < 0) goalIdx = startIdx;

        function heuristic(idx) {
            const a = cellCenter(idx);
            const b = cellCenter(goalIdx);
            return Math.hypot(a.x - b.x, a.z - b.z) / cell;
        }

        const open = [{ idx: startIdx, g: 0, f: heuristic(startIdx), pc: 0, pr: 0, parent: -1 }];
        const bestG = new Map([[startIdx, 0]]);
        const parent = new Map();
        const parentDir = new Map([[startIdx, { c: 0, r: 0 }]]);
        let expansions = 0;
        let found = false;

        while (open.length && expansions < maxExpand) {
            open.sort((a, b) => a.f - b.f);
            const cur = open.shift();
            expansions += 1;
            if (cur.idx === goalIdx) {
                found = true;
                break;
            }
            const curPos = cellCenter(cur.idx);
            const dirs = [
                [1, 0], [-1, 0], [0, 1], [0, -1],
                [1, 1], [1, -1], [-1, 1], [-1, -1]
            ];
            for (let i = 0; i < dirs.length; i++) {
                const nc = curPos.c + dirs[i][0];
                const nr = curPos.r + dirs[i][1];
                if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
                const nIdx = nr * cols + nc;
                const g = cur.g + stepCost(cur.idx, nIdx, cur.pc, cur.pr);
                const prev = bestG.get(nIdx);
                if (prev != null && g >= prev - 1e-6) continue;
                bestG.set(nIdx, g);
                parent.set(nIdx, cur.idx);
                parentDir.set(nIdx, { c: dirs[i][0], r: dirs[i][1] });
                open.push({
                    idx: nIdx,
                    g,
                    f: g + heuristic(nIdx),
                    pc: dirs[i][0],
                    pr: dirs[i][1],
                    parent: cur.idx
                });
            }
        }

        if (!found && !bestG.has(goalIdx)) {
            // Take best expanded node by (clear + forward + low roof).
            let bestIdx = -1;
            let bestSc = -Infinity;
            bestG.forEach((_, idx) => {
                if (idx === startIdx) return;
                const p = cellCenter(idx);
                const dx = p.x - (Number(x) || 0);
                const dz = p.z - (Number(z) || 0);
                const dot = dx * fx + dz * fz;
                if (dot < cell * 0.5) return;
                let sc = cellClear(idx) ? 30 : 0;
                sc += Math.max(0, 40 - roofAt(idx) * 0.5);
                sc += Math.min(20, dot / cell);
                if (sc > bestSc) {
                    bestSc = sc;
                    bestIdx = idx;
                }
            });
            if (bestIdx < 0) return empty;
            goalIdx = bestIdx;
        }

        const chain = [];
        let walk = goalIdx;
        let guard = 0;
        while (walk >= 0 && guard++ < 80) {
            chain.push(walk);
            if (walk === startIdx) break;
            walk = parent.has(walk) ? parent.get(walk) : -1;
        }
        chain.reverse();
        if (chain.length < 2) return empty;

        // Decimate to ~cell*1.6 spacing; always keep first step + goal.
        const waypoints = [];
        let lastX = Number(x) || 0;
        let lastZ = Number(z) || 0;
        const minSep = cell * 1.35;
        for (let i = 1; i < chain.length; i++) {
            const p = cellCenter(chain[i]);
            const isLast = i === chain.length - 1;
            const dist = Math.hypot(p.x - lastX, p.z - lastZ);
            if (!isLast && dist < minSep && waypoints.length > 0) continue;
            const roof = roofAt(chain[i]);
            const clear = cellClear(chain[i]);
            waypoints.push({
                x: Number(p.x.toFixed(2)),
                z: Number(p.z.toFixed(2)),
                roofMax: roof,
                skyOpen: roof < 40 ? 1 : 0,
                clear: clear ? 1 : 0,
                score: Number(((clear ? 40 : 0) + Math.max(0, 36 - roof * 0.45)).toFixed(1)),
                targetAlt: altOk ? Number(Math.max(alt, roof + margin).toFixed(1)) : null
            });
            lastX = p.x;
            lastZ = p.z;
            if (waypoints.length >= 12) break;
        }
        if (!waypoints.length) return empty;
        const steer = waypointSteerSummary(waypoints, x, z, fx, fz, cell * 2, alt, margin);
        return {
            ok: true,
            waypoints,
            preferredSide: steer.preferredSide,
            strength: Math.max(1, steer.strength),
            firstClear: steer.firstClear,
            steps: waypoints.length,
            climbBias: steer.climbBias,
            targetAlt: steer.targetAlt,
            source: 'path',
            expansions
        };
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
        samplePlannerCorridor,
        sampleSurvivalWaypoints,
        findBakePath,
        ensureAiMap,
        installOnGameContext,
        tryFetchJson
    };
});
