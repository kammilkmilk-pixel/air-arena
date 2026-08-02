// ============================================================================
// map-catalog.js - built-in original + packaged assets/maps + user-imported custom maps
// ============================================================================

window.MapCatalog = (function () {
    const STORAGE_KEY = 'airArenaMapCatalog';
    const SELECTED_KEY = 'airArenaSelectedMapId';
    const ORIGINAL_ID = 'original';
    const INDEX_URL = 'assets/maps/index.json';

    /** @type {{ id: string, name: string, path: string, data?: object|null }[]} */
    let packagedMaps = [];
    let initPromise = null;

    function readStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { maps: [] };
            const parsed = JSON.parse(raw);
            return { maps: Array.isArray(parsed.maps) ? parsed.maps : [] };
        } catch (e) {
            return { maps: [] };
        }
    }

    function writeStore(store) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (e) {
            console.warn('[MapCatalog] 無法寫入 localStorage', e);
            throw e;
        }
    }

    function getSelectedId() {
        try {
            return localStorage.getItem(SELECTED_KEY) || ORIGINAL_ID;
        } catch (e) {
            return ORIGINAL_ID;
        }
    }

    function setSelectedId(id) {
        try {
            localStorage.setItem(SELECTED_KEY, id || ORIGINAL_ID);
        } catch (e) { /* ignore */ }
    }

    function getPackaged(id) {
        return packagedMaps.find((m) => m.id === id) || null;
    }

    function list() {
        const store = readStore();
        const items = [
            {
                id: ORIGINAL_ID,
                name: '原版地圖',
                kind: 'builtin',
                removable: false,
                hint: 'city.glb / 程序建築（不改動）'
            }
        ];
        packagedMaps.forEach((m) => {
            items.push({
                id: m.id,
                name: m.name || m.id,
                kind: 'packaged',
                removable: false,
                hint: m.path || '內建 JSON'
            });
        });
        store.maps.forEach((m) => {
            items.push({
                id: m.id,
                name: m.name || m.id,
                kind: 'custom',
                removable: true,
                hint: '自訂 JSON'
            });
        });
        return items;
    }

    function getCustom(id) {
        return readStore().maps.find((m) => m.id === id) || null;
    }

    function addMap(doc) {
        const store = readStore();
        const name = String((doc && doc.name) || '未命名地圖');
        const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const entry = {
            id,
            name,
            addedAt: Date.now(),
            data: doc
        };
        store.maps.push(entry);
        writeStore(store);
        setSelectedId(id);
        return entry;
    }

    function removeMap(id) {
        if (!id || id === ORIGINAL_ID) return false;
        if (getPackaged(id)) return false;
        const store = readStore();
        const next = store.maps.filter((m) => m.id !== id);
        if (next.length === store.maps.length) return false;
        store.maps = next;
        writeStore(store);
        if (getSelectedId() === id) setSelectedId(ORIGINAL_ID);
        return true;
    }

    function renameMap(id, name) {
        const store = readStore();
        const entry = store.maps.find((m) => m.id === id);
        if (!entry) return false;
        entry.name = String(name || entry.name);
        if (entry.data) entry.data.name = entry.name;
        writeStore(store);
        return true;
    }

    async function fetchJson(url) {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.json();
    }

    async function ensurePackagedDoc(entry) {
        if (!entry) return null;
        if (entry.data) return entry.data;
        const raw = await fetchJson(entry.path);
        const doc = window.MapLoader ? window.MapLoader.normalizeDoc(raw) : raw;
        entry.data = doc;
        return doc;
    }

    /**
     * Load assets/maps/index.json and prefetch packaged map documents.
     * Safe to call multiple times; returns the same promise.
     */
    function init() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            try {
                const index = await fetchJson(INDEX_URL);
                const rows = Array.isArray(index && index.maps) ? index.maps : [];
                packagedMaps = rows
                    .filter((row) => row && row.id && row.path && row.id !== ORIGINAL_ID)
                    .map((row) => ({
                        id: String(row.id),
                        name: String(row.name || row.id),
                        path: String(row.path),
                        aiMapPath: row.aiMapPath
                            ? String(row.aiMapPath)
                            : (window.AirArenaAiMap && window.AirArenaAiMap.sidecarUrlFromMapPath
                                ? window.AirArenaAiMap.sidecarUrlFromMapPath(String(row.path))
                                : String(row.path).replace(/\.json$/i, '.ai-map.json')),
                        data: null
                    }));
                await Promise.all(packagedMaps.map((entry) =>
                    ensurePackagedDoc(entry).catch((err) => {
                        console.warn(`[MapCatalog] 無法載入包裝地圖 ${entry.id}`, err);
                        return null;
                    })
                ));
            } catch (err) {
                console.warn('[MapCatalog] 無法載入 maps/index.json', err);
                packagedMaps = [];
            }
            return packagedMaps;
        })();
        return initPromise;
    }

    /**
     * Resolve selection to a load plan.
     * Packaged maps without cached data fall back to original until init() finishes.
     * @returns {{ id: string, mode: 'original'|'json', doc?: object }}
     */
    function resolve(id) {
        const mapId = id || getSelectedId();
        if (!mapId || mapId === ORIGINAL_ID) {
            return { id: ORIGINAL_ID, mode: 'original' };
        }
        const packaged = getPackaged(mapId);
        if (packaged) {
            if (packaged.data) {
                return { id: mapId, mode: 'json', doc: packaged.data };
            }
            return { id: ORIGINAL_ID, mode: 'original' };
        }
        const custom = getCustom(mapId);
        if (!custom || !custom.data) {
            return { id: ORIGINAL_ID, mode: 'original' };
        }
        return { id: mapId, mode: 'json', doc: custom.data };
    }

    /**
     * Async resolve that waits for packaged map JSON when needed.
     * @returns {Promise<{ id: string, mode: 'original'|'json', doc?: object }>}
     */
    async function resolveAsync(id) {
        await init();
        const mapId = id || getSelectedId();
        if (!mapId || mapId === ORIGINAL_ID) {
            return { id: ORIGINAL_ID, mode: 'original' };
        }
        const packaged = getPackaged(mapId);
        if (packaged) {
            const doc = await ensurePackagedDoc(packaged);
            if (!doc) return { id: ORIGINAL_ID, mode: 'original' };
            return { id: mapId, mode: 'json', doc };
        }
        return resolve(mapId);
    }

    return {
        ORIGINAL_ID,
        init,
        list,
        getSelectedId,
        setSelectedId,
        addMap,
        removeMap,
        renameMap,
        getCustom,
        getPackaged,
        resolve,
        resolveAsync
    };
})();

// Prefetch packaged maps as soon as the catalog script loads.
if (window.MapCatalog && typeof window.MapCatalog.init === 'function') {
    window.MapCatalog.init();
}
