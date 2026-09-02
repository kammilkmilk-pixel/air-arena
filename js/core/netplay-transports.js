// ============================================================================
// netplay-transports.js - Pluggable transports: broadcast | websocket | supabase
// Common shape: { kind, send(msg), close(), whenReady?(), url? }
// ============================================================================
(function initNetplayTransports(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaNetplayTransports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const ROOM_TTL_MS = (typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.ROOM_TTL_MS)
        ? AirArenaNetplayProtocol.ROOM_TTL_MS
        : 45 * 60 * 1000;
    const PROTOCOL = (typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.PROTOCOL)
        ? AirArenaNetplayProtocol.PROTOCOL
        : 'airarena-wego-v1';
    const CLIENT_VERSION = (typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.CLIENT_VERSION)
        ? AirArenaNetplayProtocol.CLIENT_VERSION
        : '3.0.0-netplay';
    const MSG = (typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.MSG)
        ? AirArenaNetplayProtocol.MSG
        : {};

    function envelope(type, payload, extra) {
        if (typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.envelope) {
            return AirArenaNetplayProtocol.envelope(type, payload, extra);
        }
        return Object.assign({ type, protocol: PROTOCOL, clientVersion: CLIENT_VERSION, ts: Date.now(), payload }, extra || {});
    }

    /**
     * @param {object} opts
     * @param {function} opts.onMessage
     * @param {string} opts.roomId
     */
    function createBroadcastTransport(opts) {
        const onMessage = opts && opts.onMessage;
        const roomId = (opts && opts.roomId) || 'local';
        if (typeof BroadcastChannel === 'undefined') return null;
        const channel = new BroadcastChannel(`airarena-host-${roomId}`);
        const selfId = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        channel.onmessage = (ev) => {
            const data = ev && ev.data;
            if (!data || data._from === selfId) return;
            if (typeof onMessage === 'function') onMessage(data);
        };
        return {
            kind: 'broadcast',
            roomId,
            send(msg) {
                channel.postMessage(Object.assign({}, msg, { _from: selfId, room: roomId }));
            },
            close() {
                try { if (channel.close) channel.close(); } catch (e) { /* ignore */ }
            },
            whenReady() { return Promise.resolve(); }
        };
    }

    /**
     * @param {object} opts
     * @param {function} opts.onMessage
     * @param {string} opts.url
     * @param {function} [opts.onStatus]
     */
    function createWebSocketTransport(opts) {
        const onMessage = opts && opts.onMessage;
        const onStatus = opts && opts.onStatus;
        const url = opts && opts.url;
        if (!url) return null;
        let ws = null;
        let closed = false;
        const queue = [];
        let settleReady = null;
        const ready = new Promise((resolve, reject) => {
            settleReady = { resolve, reject };
        });
        function flush() {
            while (ws && ws.readyState === 1 && queue.length) {
                ws.send(JSON.stringify(queue.shift()));
            }
        }
        try {
            ws = new WebSocket(url);
        } catch (e) {
            if (settleReady) settleReady.reject(e);
            return null;
        }
        const failTimer = setTimeout(() => {
            if (settleReady) {
                settleReady.reject(new Error('timeout'));
                settleReady = null;
            }
        }, 10000);
        ws.onopen = () => {
            clearTimeout(failTimer);
            flush();
            if (settleReady) {
                settleReady.resolve();
                settleReady = null;
            }
            if (typeof onStatus === 'function') onStatus('WebSocket 已連線');
        };
        ws.onmessage = (ev) => {
            let data = null;
            try {
                data = JSON.parse(ev.data);
            } catch (e) {
                return;
            }
            if (typeof onMessage === 'function') onMessage(data);
        };
        ws.onclose = () => {
            clearTimeout(failTimer);
            if (settleReady) {
                settleReady.reject(new Error('closed'));
                settleReady = null;
            }
            if (!closed && typeof onStatus === 'function') {
                onStatus('連線中斷 — 可嘗試重連', { disconnected: true, error: true });
            }
        };
        ws.onerror = () => {
            clearTimeout(failTimer);
            if (settleReady) {
                settleReady.reject(new Error('error'));
                settleReady = null;
            }
        };
        return {
            kind: 'websocket',
            url,
            whenReady() { return ready; },
            send(msg) {
                const raw = JSON.stringify(msg);
                if (ws && ws.readyState === 1) ws.send(raw);
                else queue.push(msg);
            },
            close() {
                closed = true;
                clearTimeout(failTimer);
                try { if (ws) ws.close(); } catch (e) { /* ignore */ }
                ws = null;
            },
            getWs() { return ws; }
        };
    }

    function getSupabaseCreateClient() {
        if (typeof supabase !== 'undefined' && supabase.createClient) return supabase.createClient.bind(supabase);
        if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
            return window.supabase.createClient.bind(window.supabase);
        }
        return null;
    }

    /**
     * Peer mesh over Supabase Realtime Broadcast + Presence (no Node room server).
     * Host synthesizes welcome/peer-status from presence.
     *
     * @param {object} opts
     * @param {function} opts.onMessage
     * @param {function} [opts.onStatus]
     * @param {string} opts.action create|join|queue|reconnect
     * @param {string} [opts.room]
     * @param {string} opts.role
     * @param {string} opts.seatId
     * @param {string} [opts.seatToken]
     * @param {string} [opts.reconnectToken]
     * @param {string} [opts.mode]
     * @param {object} [opts.config] { url, anonKey }
     */
    function createSupabaseTransport(opts) {
        const onMessage = opts && opts.onMessage;
        const onStatus = opts && opts.onStatus;
        const cfg = (opts && opts.config)
            || (typeof AirArenaSupabaseConfig !== 'undefined' && AirArenaSupabaseConfig.resolve
                ? AirArenaSupabaseConfig.resolve()
                : null);
        const createClient = getSupabaseCreateClient();
        if (!cfg || !cfg.url || !cfg.anonKey) {
            if (typeof onStatus === 'function') {
                onStatus('未設定 Supabase（url／anonKey）。請填雲端設定或 supabase-config.local.js', { error: true });
            }
            return null;
        }
        if (!createClient) {
            if (typeof onStatus === 'function') {
                onStatus('未載入 @supabase/supabase-js CDN', { error: true });
            }
            return null;
        }

        let closed = false;
        let client = null;
        let channel = null;
        let queueChannel = null;
        let roomCode = opts.room ? String(opts.room).toUpperCase() : null;
        let role = opts.role || 'host';
        let seatId = opts.seatId || (role === 'guest' ? 'blue' : 'red');
        let seatToken = opts.seatToken || null;
        let reconnectToken = opts.reconnectToken || null;
        let action = opts.action || 'create';
        let createdAt = Date.now();
        let peerSeen = false;
        let welcomeSent = false;
        const outbound = [];
        let settleReady = null;
        const ready = new Promise((resolve, reject) => {
            settleReady = { resolve, reject };
        });

        function emit(msg) {
            if (typeof onMessage === 'function') onMessage(msg);
        }

        function status(text, extra) {
            if (typeof onStatus === 'function') onStatus(text, extra);
        }

        function flush() {
            while (channel && outbound.length) {
                const msg = outbound.shift();
                channel.send({
                    type: 'broadcast',
                    event: 'aa',
                    payload: msg
                }).catch(() => { /* ignore */ });
            }
        }

        function presencePayload() {
            return {
                role,
                seatId,
                seatToken,
                reconnectToken,
                clientVersion: CLIENT_VERSION,
                protocol: PROTOCOL,
                createdAt,
                action
            };
        }

        function synthesizeWelcome() {
            if (welcomeSent) return;
            welcomeSent = true;
            emit(envelope(MSG.WELCOME || 'welcome', {
                room: roomCode,
                role,
                seatId,
                remoteSeatId: seatId === 'red' ? 'blue' : 'red',
                seatToken,
                reconnectToken,
                message: `雲端房間 ${roomCode}`,
                transport: 'supabase'
            }, { room: roomCode }));
        }

        function onPresenceSync() {
            if (!channel || closed) return;
            const state = channel.presenceState() || {};
            const peers = [];
            Object.keys(state).forEach((key) => {
                const arr = state[key] || [];
                arr.forEach((meta) => peers.push(meta));
            });
            // TTL: if host presence is too old, reject join
            const hostMeta = peers.find((p) => p.role === 'host');
            if (action === 'join' && hostMeta && hostMeta.createdAt) {
                const age = Date.now() - Number(hostMeta.createdAt);
                if (age > ROOM_TTL_MS) {
                    emit(envelope(MSG.ERROR || 'error', { message: '房間已過期（超過 TTL）' }, { room: roomCode }));
                    return;
                }
            }
            const hasHost = peers.some((p) => p.role === 'host');
            const hasGuest = peers.some((p) => p.role === 'guest');
            const connected = !!(hasHost && hasGuest);
            if (connected && !peerSeen) {
                peerSeen = true;
                emit(envelope(MSG.PEER_STATUS || 'peer-status', {
                    connected: true,
                    peerRole: role === 'host' ? 'guest' : 'host'
                }, { room: roomCode }));
            } else if (!connected && peerSeen) {
                peerSeen = false;
                emit(envelope(MSG.PEER_STATUS || 'peer-status', { connected: false }, { room: roomCode }));
            }
            if ((action === 'create' || action === 'reconnect' || role === 'host') && hasHost) {
                synthesizeWelcome();
            }
            if ((action === 'join' || role === 'guest') && hasHost) {
                synthesizeWelcome();
            }
        }

        async function attachRoomChannel(code) {
            roomCode = String(code || '').toUpperCase();
            channel = client.channel(`airarena:room:${roomCode}`, {
                config: {
                    broadcast: { self: false, ack: false },
                    presence: { key: seatToken || `${role}-${seatId}` }
                }
            });
            channel.on('broadcast', { event: 'aa' }, ({ payload }) => {
                if (payload && typeof onMessage === 'function') onMessage(payload);
            });
            channel.on('presence', { event: 'sync' }, onPresenceSync);
            channel.on('presence', { event: 'join' }, onPresenceSync);
            channel.on('presence', { event: 'leave' }, onPresenceSync);

            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('subscribe-timeout')), 12000);
                channel.subscribe(async (statusName) => {
                    if (statusName === 'SUBSCRIBED') {
                        clearTimeout(t);
                        try {
                            await channel.track(presencePayload());
                            flush();
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    } else if (statusName === 'CHANNEL_ERROR' || statusName === 'TIMED_OUT') {
                        clearTimeout(t);
                        reject(new Error(statusName));
                    }
                });
            });
        }

        async function runQueue() {
            const mode = (opts && opts.mode) || '1v1';
            const myId = seatToken || `q_${Date.now().toString(36)}`;
            queueChannel = client.channel(`airarena:queue:${mode}`, {
                config: { presence: { key: myId }, broadcast: { self: true } }
            });
            let matched = false;

            function tryPair() {
                if (matched || closed) return;
                const state = queueChannel.presenceState() || {};
                const keys = Object.keys(state).sort();
                if (keys.length < 2) return;
                const a = keys[0];
                const b = keys[1];
                if (myId !== a) return;
                matched = true;
                const code = (typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.makeInviteCode)
                    ? AirArenaNetplayProtocol.makeInviteCode()
                    : `Q${Date.now().toString(36).slice(-5).toUpperCase()}`;
                queueChannel.send({
                    type: 'broadcast',
                    event: 'match',
                    payload: {
                        room: code,
                        members: [a, b],
                        hostKey: a,
                        guestKey: b
                    }
                });
            }

            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('queue-subscribe-timeout')), 12000);
                queueChannel.on('presence', { event: 'sync' }, tryPair);
                queueChannel.on('presence', { event: 'join' }, tryPair);
                queueChannel.on('broadcast', { event: 'match' }, async ({ payload }) => {
                    if (!payload || !payload.members || payload.members.indexOf(myId) < 0) return;
                    if (roomCode) return;
                    matched = true;
                    const amHost = payload.hostKey === myId;
                    role = amHost ? 'host' : 'guest';
                    seatId = amHost ? 'red' : 'blue';
                    roomCode = String(payload.room).toUpperCase();
                    createdAt = Date.now();
                    try {
                        await queueChannel.untrack();
                        await client.removeChannel(queueChannel);
                    } catch (e) { /* ignore */ }
                    queueChannel = null;
                    try {
                        await attachRoomChannel(roomCode);
                        emit(envelope(MSG.QUEUE_MATCHED || 'queue-matched', {
                            room: roomCode,
                            role,
                            seatId,
                            remoteSeatId: seatId === 'red' ? 'blue' : 'red',
                            seatToken,
                            reconnectToken
                        }, { room: roomCode }));
                        synthesizeWelcome();
                    } catch (e) {
                        emit(envelope(MSG.ERROR || 'error', { message: String(e && e.message || e) }));
                    }
                });
                queueChannel.subscribe(async (statusName) => {
                    if (statusName === 'SUBSCRIBED') {
                        clearTimeout(t);
                        try {
                            await queueChannel.track({
                                id: myId,
                                mode,
                                protocol: PROTOCOL,
                                clientVersion: CLIENT_VERSION,
                                joinedAt: Date.now()
                            });
                            emit(envelope(MSG.WELCOME || 'welcome', { message: '雲端排隊中…', queue: true }));
                            tryPair();
                            // whenReady resolves once queued; match arrives later via messages.
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    } else if (statusName === 'CHANNEL_ERROR' || statusName === 'TIMED_OUT') {
                        clearTimeout(t);
                        reject(new Error(statusName));
                    }
                });
            });
        }

        async function boot() {
            client = createClient(cfg.url, cfg.anonKey, {
                auth: { persistSession: false, autoRefreshToken: false }
            });
            const { error: authErr } = await client.auth.signInAnonymously();
            if (authErr) {
                // Some projects disable anonymous — try continue without session for public channels
                status(`匿名登入警告：${authErr.message}（若 Realtime 允許仍可繼續）`);
            }

            if (!seatToken && typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.makeSeatToken) {
                seatToken = AirArenaNetplayProtocol.makeSeatToken();
            }
            if (!reconnectToken && typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.makeSeatToken) {
                reconnectToken = `r_${AirArenaNetplayProtocol.makeSeatToken().slice(2)}`;
            }

            if (action === 'queue') {
                await runQueue();
            } else {
                if (action === 'create' && !roomCode) {
                    roomCode = (typeof AirArenaNetplayProtocol !== 'undefined' && AirArenaNetplayProtocol.makeInviteCode)
                        ? AirArenaNetplayProtocol.makeInviteCode()
                        : `R${Date.now().toString(36).slice(-5).toUpperCase()}`;
                }
                if (!roomCode) throw new Error('missing room code');
                if (action === 'create') createdAt = Date.now();
                await attachRoomChannel(roomCode);
                synthesizeWelcome();
                if (action === 'create') {
                    emit(envelope(MSG.PEER_STATUS || 'peer-status', { connected: false }, { room: roomCode }));
                }
            }

            if (settleReady) {
                settleReady.resolve();
                settleReady = null;
            }
            status(`Supabase 已連線（${roomCode || 'queue'}）`);
        }

        boot().catch((err) => {
            const msg = String(err && err.message || err);
            status(`Supabase 連線失敗：${msg}`, { error: true });
            if (settleReady) {
                settleReady.reject(err);
                settleReady = null;
            }
        });

        return {
            kind: 'supabase',
            getRoom() { return roomCode; },
            getRole() { return role; },
            getSeatId() { return seatId; },
            getSeatToken() { return seatToken; },
            getReconnectToken() { return reconnectToken; },
            whenReady() { return ready; },
            send(msg) {
                if (!channel) {
                    outbound.push(msg);
                    return;
                }
                channel.send({
                    type: 'broadcast',
                    event: 'aa',
                    payload: msg
                }).catch(() => {
                    outbound.push(msg);
                });
            },
            close() {
                closed = true;
                try {
                    if (channel) client.removeChannel(channel);
                    if (queueChannel) client.removeChannel(queueChannel);
                    if (client && client.auth) client.auth.signOut();
                } catch (e) { /* ignore */ }
                channel = null;
                queueChannel = null;
                client = null;
            }
        };
    }

    /**
     * Prefer: explicit opts.transport → supabase if configured & cloud → websocket → broadcast
     */
    function resolveKind(opts) {
        const o = opts || {};
        if (o.transport === 'broadcast' || o.transport === 'websocket' || o.transport === 'supabase') {
            return o.transport;
        }
        if (o.preferCloud || o.cloud) {
            const cfg = typeof AirArenaSupabaseConfig !== 'undefined' && AirArenaSupabaseConfig.isConfigured
                ? AirArenaSupabaseConfig.isConfigured()
                : false;
            if (cfg) return 'supabase';
        }
        if (typeof window !== 'undefined') {
            try {
                const p = new URLSearchParams(window.location.search || '');
                if (p.get('cloud') === '1' || p.get('baas') === '1') {
                    if (typeof AirArenaSupabaseConfig !== 'undefined' && AirArenaSupabaseConfig.isConfigured()) {
                        return 'supabase';
                    }
                }
            } catch (e) { /* ignore */ }
        }
        if (o.action === 'create' || o.action === 'join' || o.action === 'queue' || o.action === 'reconnect' || o.wsUrl) {
            return 'websocket';
        }
        return 'broadcast';
    }

    return {
        ROOM_TTL_MS,
        createBroadcastTransport,
        createWebSocketTransport,
        createSupabaseTransport,
        resolveKind,
        getSupabaseCreateClient
    };
});
