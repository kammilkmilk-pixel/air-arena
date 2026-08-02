// ============================================================================
// context.js - 單一應用上下文 (Phase 1: 收斂全局狀態與服務註冊)
// ============================================================================
//
// 依賴方向: config → context → globals/logic → view → game
// 新程式碼請使用 GameContext，勿再新增 window.* 出口。

window.GameContext = {
    config: typeof CONFIG !== 'undefined' ? CONFIG : null,

    /** @type {Record<string, number|string|boolean>} */
    constants: {},

    state: {
        battleLog: [],
        /** Lightweight doctrine/AI events (not ACMI path frames). */
        doctrineEvents: [],
        globalFlares: [],
        globalChaff: [],
        globalBullets: [],
        missileMeshBase: null,
        initialPositions: null,
        teams: null,
        activeTeamId: 'red',
        currentTurn: 1,
        isAnimating: false,
        animProgress: 0,
        pastTrajectories: [],
        trajectoryMeshes: { red: null, red2: null, blue: null, blue2: null },
        replayMode: false,
        mslVisOffset: null,
        virtualReplayTime: undefined,
        lastReplayTime: undefined,
        cameraSoftFollow: false,
        cameraZoomToken: 0,
        cameraZoomUntil: 0,
        cameraFollowOverrideId: null,
        arenaMode: 'dense-urban',
        matchConfig: null,
        matchReady: false,
        rosterIds: ['red', 'red2', 'blue', 'blue2']
    },
    services: {},

    view: {
        teams: {
            red: { wrapper: null, userData: {}, realBeam: null, gunPreview: null, pylonViews: {} },
            red2: { wrapper: null, userData: {}, realBeam: null, gunPreview: null, pylonViews: {} },
            blue: { wrapper: null, userData: {}, realBeam: null, gunPreview: null, pylonViews: {} },
            blue2: { wrapper: null, userData: {}, realBeam: null, gunPreview: null, pylonViews: {} }
        },
        trajectoryMeshes: null,
        pastTrajectories: null
    },

    /** 由 render.js 注入: { scene, camera, renderer, controls, ... } */
    three: null,

    /** 由 state-machine.js 注入 */
    stateMachine: null,

    registerService(name, fn) {
        if (typeof fn !== 'function') {
            console.warn(`[GameContext] registerService("${name}") 需要 function`);
            return;
        }
        this.services[name] = fn;
    },

    callService(name, ...args) {
        const fn = this.services[name];
        if (typeof fn !== 'function') return undefined;
        return fn(...args);
    },

    sanitizeArenaMode(mode) {
        if (mode === 'buildings') return 'dense-urban';
        const modes = ['blank', 'visual-only', 'sparse-urban', 'medium-urban', 'dense-urban', 'buildings', 'obstacle-stress'];
        return modes.includes(mode) ? mode : 'dense-urban';
    },

    setArenaMode(mode) {
        const nextMode = this.sanitizeArenaMode(mode);
        this.state.arenaMode = nextMode;
        try {
            window.localStorage && window.localStorage.setItem('airArenaArenaMode', nextMode);
        } catch (_) {}
        this.callService('setArenaMode', nextMode);
        return nextMode;
    },

    getArenaMode() {
        return this.sanitizeArenaMode(this.state.arenaMode);
    },

    sanitizeMatchMode(mode) {
        return mode === '2v2' ? '2v2' : '1v1';
    },

    sanitizeMatchControl(control) {
        return control === 'ai' ? 'ai' : 'human';
    },

    sanitizeMatchLoadout(loadout) {
        const allowed = ['standard', 'gun-priority', 'fox2-priority', 'fox1-priority'];
        return allowed.includes(loadout) ? loadout : 'standard';
    },

    sanitizePylonLoadout(arr) {
        if (typeof sanitizePylonLoadout === 'function') return sanitizePylonLoadout(arr);
        return ['fox1', 'fox2', 'fox2', 'fox1'];
    },

    sanitizeSpawnAltitude(alt) {
        const n = Math.round(Number(alt));
        const allowed = [28, 45, 60, 80];
        return allowed.includes(n) ? n : 45;
    },

    sanitizeSpawnSeparation(sep) {
        const n = Math.round(Number(sep));
        const allowed = [60, 100, 140, 200];
        return allowed.includes(n) ? n : 100;
    },

    createDefaultMatchConfig(mode = '1v1') {
        const matchMode = this.sanitizeMatchMode(mode);
        const defaultPylons = this.sanitizePylonLoadout(null);
        return {
            mode: matchMode,
            spawnAltitude: 45,
            spawnSeparation: 100,
            seats: {
                'red-1': { control: 'human', loadout: 'standard', pylons: defaultPylons.slice(), teamId: 'red' },
                'red-2': { control: 'ai', loadout: 'standard', pylons: defaultPylons.slice(), teamId: 'red2', deferred: matchMode !== '2v2' },
                'blue-1': { control: 'ai', loadout: 'standard', pylons: defaultPylons.slice(), teamId: 'blue' },
                'blue-2': { control: 'ai', loadout: 'standard', pylons: defaultPylons.slice(), teamId: 'blue2', deferred: matchMode !== '2v2' }
            }
        };
    },

    seatIdToTeamId(seatId) {
        const map = { 'red-1': 'red', 'red-2': 'red2', 'blue-1': 'blue', 'blue-2': 'blue2' };
        return map[seatId] || null;
    },

    getRosterIds() {
        return (this.state.rosterIds || ['red', 'red2', 'blue', 'blue2']).slice();
    },

    getFaction(teamId) {
        if (!teamId) return null;
        if (String(teamId).startsWith('red')) return 'red';
        if (String(teamId).startsWith('blue')) return 'blue';
        return null;
    },

    getActiveMatchIds() {
        const teams = this.state.teams || {};
        return this.getRosterIds().filter((id) => {
            const t = teams[id];
            return !!(t && t.matchActive !== false && t.wrapper);
        });
    },

    getLivingTeamIds() {
        const teams = this.state.teams || {};
        return this.getActiveMatchIds().filter((id) => {
            const t = teams[id];
            return !!(t && !t.isDestroyed);
        });
    },

    getHostileIds(teamId) {
        const faction = this.getFaction(teamId);
        if (!faction) return [];
        return this.getLivingTeamIds().filter((id) => this.getFaction(id) && this.getFaction(id) !== faction);
    },

    getAllyIds(teamId) {
        const faction = this.getFaction(teamId);
        if (!faction) return [];
        return this.getLivingTeamIds().filter((id) => id !== teamId && this.getFaction(id) === faction);
    },

    getNearestHostileId(teamId) {
        const self = this.getTeam(teamId);
        if (!self || !self.wrapper) return null;
        const hostiles = this.getHostileIds(teamId);
        if (hostiles.length === 0) return null;
        let best = null;
        let bestDist = Infinity;
        const from = self.wrapper.position;
        hostiles.forEach((hid) => {
            const ht = this.getTeam(hid);
            if (!ht || !ht.wrapper) return;
            const d = from.distanceTo(ht.wrapper.position);
            if (d < bestDist) {
                bestDist = d;
                best = hid;
            }
        });
        return best;
    },

    /** Manual lock if still a living hostile; otherwise nearest hostile. */
    getTargetId(teamId) {
        const self = this.getTeam(teamId);
        if (!self) return this.getNearestHostileId(teamId);
        const locked = self.lockedTargetId;
        if (locked) {
            const hostiles = this.getHostileIds(teamId);
            if (hostiles.includes(locked)) {
                const ht = this.getTeam(locked);
                if (ht && ht.wrapper && !ht.isDestroyed) return locked;
            }
            self.lockedTargetId = null;
        }
        return this.getNearestHostileId(teamId);
    },

    setLockedTarget(teamId, targetId) {
        const self = this.getTeam(teamId);
        if (!self) return false;
        if (!targetId) {
            self.lockedTargetId = null;
            return true;
        }
        const hostiles = this.getHostileIds(teamId);
        if (!hostiles.includes(targetId)) return false;
        const ht = this.getTeam(targetId);
        if (!ht || ht.isDestroyed) return false;
        self.lockedTargetId = targetId;
        return true;
    },

    areAllLivingReady() {
        const living = this.getLivingTeamIds();
        if (living.length === 0) return false;
        return living.every((id) => {
            const t = this.getTeam(id);
            return !!(t && (t.ready || t.isDestroyed));
        });
    },

    isFactionEliminated(faction) {
        const living = this.getLivingTeamIds().filter((id) => this.getFaction(id) === faction);
        return living.length === 0;
    },

    getMatchConfig() {
        return this.state.matchConfig || this.createDefaultMatchConfig('1v1');
    },

    setMatchConfig(config) {
        const mode = this.sanitizeMatchMode(config && config.mode);
        const base = this.createDefaultMatchConfig(mode);
        const incoming = (config && config.seats) || {};
        Object.keys(base.seats).forEach((seatId) => {
            const src = incoming[seatId] || {};
            base.seats[seatId].control = this.sanitizeMatchControl(src.control || base.seats[seatId].control);
            base.seats[seatId].loadout = this.sanitizeMatchLoadout(src.loadout || base.seats[seatId].loadout);
            base.seats[seatId].pylons = this.sanitizePylonLoadout(src.pylons || base.seats[seatId].pylons);
        });
        base.spawnAltitude = this.sanitizeSpawnAltitude(
            config && config.spawnAltitude != null ? config.spawnAltitude : base.spawnAltitude
        );
        base.spawnSeparation = this.sanitizeSpawnSeparation(
            config && config.spawnSeparation != null ? config.spawnSeparation : base.spawnSeparation
        );
        this.state.matchConfig = base;
        return base;
    },

    isBuildingCollisionEnabled() {
        return ['sparse-urban', 'medium-urban', 'dense-urban', 'buildings', 'obstacle-stress'].includes(this.getArenaMode());
    },

    areBuildingsVisible() {
        return this.getArenaMode() !== 'blank';
    },

    getActiveTeamId() {
        return this.state.activeTeamId;
    },

    setActiveTeamId(id) {
        if (!this.state.teams || !this.state.teams[id]) return;
        this.state.activeTeamId = id;
    },

    getActiveTeam() {
        return this.state.teams ? this.state.teams[this.state.activeTeamId] : null;
    },

    getTeam(id) {
        return this.state.teams ? this.state.teams[id] : null;
    },

    getTeamView(id) {
        if (!this.view.teams[id]) {
            this.view.teams[id] = { wrapper: null, userData: {}, realBeam: null, gunPreview: null, pylonViews: {} };
        }
        return this.view.teams[id];
    },

    registerTeamWrapper(id, wrapper) {
        const view = this.getTeamView(id);
        view.wrapper = wrapper;
        if (wrapper) {
            if (!wrapper.userData) wrapper.userData = {};
            wrapper.userData.teamId = id;
        }
        return wrapper;
    },

    getTeamWrapper(id) {
        return this.getTeamView(id).wrapper;
    },

    getTeamUserData(id) {
        return this.getTeamView(id).userData;
    },

    getPylonView(teamId, pylonId) {
        const teamView = this.getTeamView(teamId);
        if (!teamView.pylonViews[pylonId]) {
            teamView.pylonViews[pylonId] = {};
        }
        return teamView.pylonViews[pylonId];
    },

    bindPylonView(teamId, pylonState, initialView = {}) {
        const pylonView = this.getPylonView(teamId, pylonState.id);
        Object.assign(pylonView, initialView);

        ['mesh', 'lineMesh', 'flyingMesh', 'boomMesh', 'trailMesh', 'flyingGlowMesh'].forEach(prop => {
            if (Object.prototype.hasOwnProperty.call(pylonState, prop)) delete pylonState[prop];
            Object.defineProperty(pylonState, prop, {
                configurable: true,
                enumerable: false,
                get() { return pylonView[prop] || null; },
                set(value) { pylonView[prop] = value; }
            });
        });

        return pylonState;
    },

    getSerializableTeamState(id) {
        const team = this.getTeam(id);
        if (!team) return null;
        const wrapper = this.getTeamWrapper(id);
        const position = wrapper ? wrapper.position : null;
        const forward = wrapper ? new THREE.Vector3(0, 0, 1).applyQuaternion(wrapper.quaternion).normalize() : null;
        // Backfill for teams created before chaff existed (hot-reload / old sessions).
        if (team.chaffAmmo == null) {
            team.chaffAmmo = (CONFIG.weapons && CONFIG.weapons.chaff && CONFIG.weapons.chaff.maxAmmo) || 3;
        }
        if (team.chaffArmed == null) team.chaffArmed = false;
        if (team.aiLastChaffTurn == null) team.aiLastChaffTurn = -99;

        return {
            id: team.id,
            type: team.type,
            position: position ? { x: position.x, y: position.y, z: position.z } : null,
            forward: forward ? { x: forward.x, y: forward.y, z: forward.z } : null,
            hp: team.hp,
            isDestroyed: team.isDestroyed,
            ap: team.ap,
            speed: team.speed,
            heat: team.heat,
            flameout: team.flameout,
            throttle: team.throttle,
            stalled: team.stalled,
            gLimiterOn: team.gLimiterOn,
            weapon: team.weapon,
            wpnQueued: team.wpnQueued,
            queuedAction: team.queuedAction || 'none',
            flareAmmo: team.flareAmmo,
            flaresArmed: team.flaresArmed,
            chaffAmmo: team.chaffAmmo,
            chaffArmed: !!team.chaffArmed,
            ready: team.ready,
            aiEnabled: !!team.aiEnabled,
            aiState: team.aiState || 'player',
            aiStatusText: team.aiStatusText || 'PLAYER CONTROL',
            aiManualOverride: team.aiManualOverride || 'auto',
            aiPolicyMode: team.aiPolicyMode || 'heuristic',
            wingmanOrder: team.wingmanOrder || 'follow',
            lockedTargetId: team.lockedTargetId || null,
            pendingPitch: team.pendingPitch,
            pendingYaw: team.pendingYaw,
            pendingRoll: team.pendingRoll,
            joyX: team.joyX || 0,
            joyY: team.joyY || 0,
            roll: team.roll || 0,
            pylons: (team.pylons || []).map(p => ({
                id: p.id,
                weaponType: p.weaponType,
                state: p.state
            })),
            activeMissiles: (team.activeMissiles || []).map(m => ({
                pylonId: m.pylonId,
                missileType: m.missileType || 'fox2',
                active: m.active,
                exploded: m.exploded,
                ap: m.ap,
                supportLocked: !!m.supportLocked,
                traveled: Number(m.traveled) || 0
            }))
        };
    },

    getSerializableBattleState() {
        return {
            activeTeamId: this.state.activeTeamId,
            currentTurn: this.state.currentTurn,
            isAnimating: this.state.isAnimating,
            replayMode: this.state.replayMode,
            teams: Object.fromEntries(
                (this.getRosterIds ? this.getRosterIds() : ['red', 'blue']).map((id) => [id, this.getSerializableTeamState(id)])
            )
        };
    },

    isReplayMode() {
        return !!this.state.replayMode;
    },

    setReplayMode(value) {
        this.state.replayMode = !!value;
    },

    isAnimating() {
        return !!this.state.isAnimating;
    },

    setAnimating(value) {
        this.state.isAnimating = !!value;
    }
};

/** @deprecated 使用 GameContext */
const ctx = () => GameContext;
