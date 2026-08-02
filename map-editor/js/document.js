// ============================================================================
// document.js - MapDocument CRUD + undo + localStorage draft
// ============================================================================

window.MapDocument = (function () {
    const DRAFT_KEY = 'airArenaMapEditorDraft';
    let uid = 0;

    function nextId(prefix) {
        uid += 1;
        return `${prefix}_${Date.now().toString(36)}_${uid}`;
    }

    function emptyDoc() {
        return {
            version: 1,
            name: 'untitled',
            ground: {
                width: 900,
                depth: 900,
                color: 0x4a5440,
                centerX: 10,
                centerZ: 20
            },
            lighting: {
                hemiSky: 0xc4d8ef,
                hemiGround: 0x5a564c,
                hemiIntensity: 0.98,
                ambient: 0xb0bdc8,
                ambientIntensity: 0.28,
                sunColor: 0xffefd6,
                sunIntensity: 0.58,
                sunDirX: -0.55,
                sunDirY: 0.82,
                sunDirZ: -0.35
            },
            sky: {
                mode: 'color',
                color: 0x8eb4d4,
                fogColor: 0x8eb4d4,
                fogNear: 85,
                fogFar: 540,
                texture: '',
                radius: 800
            },
            objects: []
        };
    }

    function clone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function normalizeObject(raw) {
        const kind = raw.kind === 'glb' ? 'glb' : 'box';
        const o = {
            id: raw.id || nextId(kind === 'glb' ? 'p' : 'b'),
            kind,
            x: Number(raw.x) || 0,
            y: Number(raw.y) || 0,
            z: Number(raw.z) || 0,
            rotY: Number(raw.rotY) || 0,
            color: raw.color == null ? (kind === 'box' ? 0x2c2c2c : null) : Number(raw.color),
            collision: raw.collision !== false
        };
        if (kind === 'box') {
            o.w = Math.max(0.1, Number(raw.w) || 4);
            o.d = Math.max(0.1, Number(raw.d) || 4);
            o.h = Math.max(0.1, Number(raw.h) || 10);
        } else {
            let src = String(raw.src || 'assets/models/city.glb');
            if (window.MapEditorAssets && window.MapEditorAssets.normalizeGamePath) {
                src = window.MapEditorAssets.normalizeGamePath(src);
            } else {
                src = src.replace(/\\/g, '/');
                const idx = src.toLowerCase().lastIndexOf('/assets/');
                if (idx >= 0) src = src.slice(idx + 1);
            }
            o.src = src;
            o.scaleX = Math.max(0.001, Number(raw.scaleX != null ? raw.scaleX : 1));
            o.scaleY = Math.max(0.001, Number(raw.scaleY != null ? raw.scaleY : 1));
            o.scaleZ = Math.max(0.001, Number(raw.scaleZ != null ? raw.scaleZ : 1));
        }
        return o;
    }

    function normalizeDoc(raw) {
        const base = emptyDoc();
        if (!raw || typeof raw !== 'object') return base;
        const g = raw.ground || {};
        const L = raw.lighting || {};
        const S = raw.sky || {};
        return {
            version: 1,
            name: String(raw.name || 'untitled'),
            ground: {
                width: Number(g.width) || 900,
                depth: Number(g.depth) || 900,
                color: Number(g.color != null ? g.color : 0x4a5440),
                centerX: Number(g.centerX != null ? g.centerX : 10),
                centerZ: Number(g.centerZ != null ? g.centerZ : 20)
            },
            lighting: {
                hemiSky: Number(L.hemiSky != null ? L.hemiSky : base.lighting.hemiSky) >>> 0,
                hemiGround: Number(L.hemiGround != null ? L.hemiGround : base.lighting.hemiGround) >>> 0,
                hemiIntensity: Number(L.hemiIntensity != null ? L.hemiIntensity : base.lighting.hemiIntensity),
                ambient: Number(L.ambient != null ? L.ambient : base.lighting.ambient) >>> 0,
                ambientIntensity: Number(L.ambientIntensity != null ? L.ambientIntensity : base.lighting.ambientIntensity),
                sunColor: Number(L.sunColor != null ? L.sunColor : base.lighting.sunColor) >>> 0,
                sunIntensity: Number(L.sunIntensity != null ? L.sunIntensity : base.lighting.sunIntensity),
                sunDirX: Number(L.sunDirX != null ? L.sunDirX : base.lighting.sunDirX),
                sunDirY: Number(L.sunDirY != null ? L.sunDirY : base.lighting.sunDirY),
                sunDirZ: Number(L.sunDirZ != null ? L.sunDirZ : base.lighting.sunDirZ)
            },
            sky: {
                mode: S.mode === 'texture' ? 'texture' : 'color',
                color: Number(S.color != null ? S.color : base.sky.color) >>> 0,
                fogColor: Number(S.fogColor != null ? S.fogColor : base.sky.fogColor) >>> 0,
                fogNear: Number(S.fogNear != null ? S.fogNear : base.sky.fogNear),
                fogFar: Number(S.fogFar != null ? S.fogFar : base.sky.fogFar),
                texture: String(S.texture || ''),
                radius: Math.max(100, Number(S.radius != null ? S.radius : base.sky.radius))
            },
            objects: Array.isArray(raw.objects) ? raw.objects.map(normalizeObject) : []
        };
    }

    function fromLegacyBuildings(buildings) {
        const doc = emptyDoc();
        doc.name = 'from-config-buildings';
        doc.objects = (buildings || []).map((b) => normalizeObject({
            kind: 'box',
            x: b.x, z: b.z, y: 0,
            w: b.w, d: b.d, h: b.h,
            color: b.color,
            rotY: b.rotY || 0,
            collision: true
        }));
        return doc;
    }

    const api = {
        doc: emptyDoc(),
        selectedId: null,
        _undo: [],
        _listeners: [],

        onChange(fn) {
            this._listeners.push(fn);
        },

        _emit(reason) {
            this._listeners.forEach((fn) => fn(this.doc, reason));
            this.saveDraft();
        },

        pushUndo() {
            this._undo.push(clone(this.doc));
            if (this._undo.length > 40) this._undo.shift();
        },

        undo() {
            if (!this._undo.length) return false;
            this.doc = this._undo.pop();
            if (this.selectedId && !this.getObject(this.selectedId)) this.selectedId = null;
            this._emit('undo');
            return true;
        },

        setDoc(raw, reason) {
            this.pushUndo();
            this.doc = normalizeDoc(raw);
            if (this.selectedId && !this.getObject(this.selectedId)) this.selectedId = null;
            this._emit(reason || 'set');
        },

        loadQuiet(raw) {
            this.doc = normalizeDoc(raw);
            this.selectedId = null;
            this._undo = [];
            this._emit('load');
        },

        getObject(id) {
            return this.doc.objects.find((o) => o.id === id) || null;
        },

        select(id) {
            this.selectedId = id;
            this._emit('select');
        },

        addObject(partial, select) {
            this.pushUndo();
            const obj = normalizeObject(partial);
            this.doc.objects.push(obj);
            if (select !== false) this.selectedId = obj.id;
            this._emit('add');
            return obj;
        },

        updateObject(id, patch) {
            const obj = this.getObject(id);
            if (!obj) return;
            this.pushUndo();
            Object.assign(obj, patch);
            const idx = this.doc.objects.findIndex((o) => o.id === id);
            this.doc.objects[idx] = normalizeObject(obj);
            this._emit('update');
        },

        updateObjectLive(id, patch) {
            const obj = this.getObject(id);
            if (!obj) return;
            Object.assign(obj, patch);
            this._emit('live');
        },

        removeObject(id) {
            const idx = this.doc.objects.findIndex((o) => o.id === id);
            if (idx < 0) return;
            this.pushUndo();
            this.doc.objects.splice(idx, 1);
            if (this.selectedId === id) this.selectedId = null;
            this._emit('remove');
        },

        duplicateSelected() {
            const src = this.getObject(this.selectedId);
            if (!src) return null;
            const copy = clone(src);
            delete copy.id;
            copy.x += 2;
            copy.z += 2;
            return this.addObject(copy);
        },

        updateGround(patch) {
            this.pushUndo();
            Object.assign(this.doc.ground, patch);
            this._emit('ground');
        },

        updateLighting(patch) {
            this.pushUndo();
            Object.assign(this.doc.lighting, patch);
            this._emit('env');
        },

        updateSky(patch) {
            this.pushUndo();
            Object.assign(this.doc.sky, patch);
            this._emit('env');
        },

        updateMeta(patch) {
            if (patch.name != null) this.doc.name = String(patch.name);
            this._emit('meta');
        },

        toJSON() {
            return clone(this.doc);
        },

        saveDraft() {
            try {
                localStorage.setItem(DRAFT_KEY, JSON.stringify(this.doc));
            } catch (e) { /* ignore quota */ }
        },

        loadDraft() {
            try {
                const raw = localStorage.getItem(DRAFT_KEY);
                if (!raw) return false;
                this.loadQuiet(JSON.parse(raw));
                return true;
            } catch (e) {
                return false;
            }
        },

        emptyDoc,
        fromLegacyBuildings,
        normalizeDoc,
        nextId
    };

    return api;
})();
