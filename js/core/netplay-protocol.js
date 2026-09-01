// ============================================================================
// netplay-protocol.js - Shared WEGO netplay message contract (browser + Node)
// ============================================================================
(function initNetplayProtocol(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaNetplayProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const PROTOCOL = (typeof AirArenaTurnLogSerialize !== 'undefined' && AirArenaTurnLogSerialize.PROTOCOL)
        ? AirArenaTurnLogSerialize.PROTOCOL
        : 'airarena-wego-v1';
    const CLIENT_VERSION = '3.0.0-netplay';
    const INTENT_TIMEOUT_MS = 90000;
    const ROOM_TTL_MS = 45 * 60 * 1000;
    const RECONNECT_TTL_MS = 120000;

    const MSG = Object.freeze({
        HELLO: 'hello',
        WELCOME: 'welcome',
        MATCH_CONFIG: 'match-config',
        TURN_INTENT: 'turn-intent',
        TURN_LOG: 'turn-log',
        PEER_STATUS: 'peer-status',
        PING: 'ping',
        PONG: 'pong',
        QUEUE_JOIN: 'queue-join',
        QUEUE_LEAVE: 'queue-leave',
        QUEUE_MATCHED: 'queue-matched',
        RECONNECT: 'reconnect',
        ERROR: 'error'
    });

    function envelope(type, payload, extra) {
        const msg = {
            type: type,
            protocol: PROTOCOL,
            clientVersion: CLIENT_VERSION,
            ts: Date.now(),
            payload: payload == null ? null : payload
        };
        if (extra && typeof extra === 'object') {
            Object.keys(extra).forEach((k) => {
                if (msg[k] === undefined) msg[k] = extra[k];
            });
        }
        return msg;
    }

    function isCompatible(msg) {
        return !!(msg && msg.protocol === PROTOCOL);
    }

    function makeMatchSeed() {
        const a = (Math.random() * 0xffffffff) >>> 0;
        const b = (Date.now() & 0xffffffff) >>> 0;
        return ((a ^ b) >>> 0) || 1;
    }

    function makeInviteCode() {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let out = '';
        for (let i = 0; i < 6; i++) {
            out += alphabet[(Math.random() * alphabet.length) | 0];
        }
        return out;
    }

    function makeSeatToken() {
        return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }

    function buildTurnIntent(teamId, team, turn) {
        const t = team || {};
        const pylons = Array.isArray(t.pylons)
            ? t.pylons.map((p) => ({
                id: p.id,
                weaponType: p.weaponType,
                state: p.state
            }))
            : [];
        return {
            seatId: teamId,
            turn: Number(turn) || 1,
            joyX: Number(t.joyX) || 0,
            joyY: Number(t.joyY) || 0,
            roll: Number(t.pendingRoll != null ? t.pendingRoll : t.roll) || 0,
            pendingYaw: Number(t.pendingYaw) || 0,
            pendingPitch: Number(t.pendingPitch) || 0,
            throttle: Number(t.throttle) || 2,
            weapon: t.weapon || 'gun',
            queuedAction: t.queuedAction || 'none',
            wpnQueued: !!t.wpnQueued,
            flaresArmed: !!t.flaresArmed,
            chaffArmed: !!t.chaffArmed,
            lockedTargetId: t.lockedTargetId || null,
            wingmanOrder: t.wingmanOrder || 'follow',
            pylons: pylons,
            ready: true,
            singleMissileShot: !!t.singleMissileShot
        };
    }

    /**
     * Apply a remote TurnIntent onto a living human seat (Host authority path).
     * Clears ready first so setJoystick / queues can write, then sets ready.
     */
    function applyTurnIntent(teamId, intent, deps) {
        const GC = (deps && deps.GameContext) || (typeof GameContext !== 'undefined' ? GameContext : null);
        if (!GC || !GC.stateMachine || !intent) return false;
        const t = GC.getTeam(teamId);
        if (!t || t.isDestroyed || t.matchActive === false) return false;

        // Unlock writes if previously ready from a stale local click.
        t.ready = false;

        if (typeof intent.throttle === 'number') GC.stateMachine.setThrottle(teamId, intent.throttle);
        GC.stateMachine.setJoystickInput(teamId, Number(intent.joyX) || 0, Number(intent.joyY) || 0);
        if (typeof intent.roll === 'number') GC.stateMachine.setRollInput(teamId, intent.roll);
        if (intent.pendingYaw != null) t.pendingYaw = Number(intent.pendingYaw) || 0;
        if (intent.pendingPitch != null) t.pendingPitch = Number(intent.pendingPitch) || 0;
        if (intent.weapon) GC.stateMachine.setWeaponMode(teamId, intent.weapon);

        if (Array.isArray(intent.pylons) && Array.isArray(t.pylons)) {
            intent.pylons.forEach((src) => {
                const p = t.pylons.find((x) => x.id === src.id);
                if (!p || !src) return;
                if (src.state === 'powering' || src.state === 'armed' || src.state === 'standby' || src.state === 'empty') {
                    p.state = src.state;
                }
                if (src.weaponType) p.weaponType = src.weaponType;
            });
        }

        t.flaresArmed = !!intent.flaresArmed;
        t.chaffArmed = !!intent.chaffArmed;
        t.singleMissileShot = !!intent.singleMissileShot;
        if (intent.lockedTargetId) GC.setLockedTarget(teamId, intent.lockedTargetId);
        else t.lockedTargetId = null;
        if (intent.wingmanOrder) GC.stateMachine.setWingmanOrder(teamId, intent.wingmanOrder);

        const qa = intent.queuedAction || 'none';
        if (qa === 'gun') GC.stateMachine.queueAction(teamId, 'gun');
        else if (qa === 'missile') {
            if (t.pylons && t.pylons.some((p) => p.state === 'armed')) GC.stateMachine.toggleMissileQueue(teamId);
            else GC.stateMachine.clearQueuedAction(teamId);
        } else if (qa === 'flare') GC.stateMachine.queueAction(teamId, 'flare');
        else if (qa === 'chaff') {
            if (!t.chaffArmed && (t.chaffAmmo || 0) > 0) GC.stateMachine.toggleChaff(teamId);
        } else {
            GC.stateMachine.clearQueuedAction(teamId);
        }

        if (intent.ready !== false) {
            if (typeof GC.callService === 'function') {
                try { GC.callService('updateTacticalPreview', t); } catch (e) { /* optional */ }
            } else if (typeof window !== 'undefined' && typeof window.updateTacticalPreview === 'function') {
                try { window.updateTacticalPreview(t); } catch (e) { /* optional */ }
            }
            GC.stateMachine.setReady(teamId, true);
        }
        return true;
    }

    function applyMatchSeed(seed) {
        const n = Number(seed);
        if (!Number.isFinite(n)) return null;
        const s = (n >>> 0) || 1;
        if (typeof GameContext !== 'undefined' && GameContext.state) {
            GameContext.state.matchSeed = s;
        }
        if (typeof CONFIG !== 'undefined') {
            if (!CONFIG.doctrine) CONFIG.doctrine = {};
            CONFIG.doctrine.fox2OpeningAmbushSeed = s;
        }
        return s;
    }

    function defaultNetMatchConfig(localFaction) {
        const faction = localFaction === 'blue' ? 'blue' : 'red';
        const other = faction === 'red' ? 'blue' : 'red';
        return {
            mode: '1v1',
            mapId: 'original',
            spawnAltitude: 45,
            spawnSeparation: 100,
            playerFaction: faction,
            challengeId: 'skirmish',
            seats: {
                'red-1': {
                    control: 'human',
                    aiModel: null,
                    loadout: 'standard',
                    pylons: ['fox1', 'fox2', 'fox2', 'fox1'],
                    pilotId: faction === 'red' ? 'nori' : 'fox'
                },
                'red-2': {
                    control: 'ai',
                    aiModel: 'test_01',
                    loadout: 'standard',
                    pylons: ['fox1', 'fox2', 'fox2', 'fox1'],
                    pilotId: 'hawk'
                },
                'blue-1': {
                    control: 'human',
                    aiModel: null,
                    loadout: 'standard',
                    pylons: ['fox1', 'fox2', 'fox2', 'fox1'],
                    pilotId: other === 'blue' && faction === 'red' ? 'fox' : 'nori'
                },
                'blue-2': {
                    control: 'ai',
                    aiModel: 'test_01',
                    loadout: 'standard',
                    pylons: ['fox1', 'fox2', 'fox2', 'fox1'],
                    pilotId: 'kite'
                }
            }
        };
    }

    return {
        PROTOCOL,
        CLIENT_VERSION,
        INTENT_TIMEOUT_MS,
        ROOM_TTL_MS,
        RECONNECT_TTL_MS,
        MSG,
        envelope,
        isCompatible,
        makeMatchSeed,
        makeInviteCode,
        makeSeatToken,
        buildTurnIntent,
        applyTurnIntent,
        applyMatchSeed,
        defaultNetMatchConfig
    };
});
