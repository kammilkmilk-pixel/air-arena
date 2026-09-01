// ============================================================================
// host-authority.js - WEGO host-authority netplay session (BC + WebSocket)
// Host resolves combat; Guest replays turn-log. Activate via UI or ?hostRoom=
// ============================================================================
(function initHostAuthority(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        root.AirArenaHostAuthority = api;
        root.AirArenaNetplay = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const Proto = () => (typeof AirArenaNetplayProtocol !== 'undefined' ? AirArenaNetplayProtocol : null);
    const PROTOCOL = () => {
        const p = Proto();
        return (p && p.PROTOCOL) || 'airarena-wego-v1';
    };
    const MSG = () => {
        const p = Proto();
        return (p && p.MSG) || {};
    };

    let transport = null;
    let role = null; // 'host' | 'guest' | null
    let room = null;
    let localSeatId = 'red';
    let remoteSeatId = 'blue';
    let seatToken = null;
    let matchSeed = null;
    let matchConfig = null;
    let peerConnected = false;
    let pendingRemoteIntent = null;
    let intentTimer = null;
    let statusText = '';
    let reconnectToken = null;
    let queueMode = null;
    let engaged = false;
    let lastError = null;

    function emitUi(detail) {
        if (typeof window === 'undefined') return;
        window.dispatchEvent(new CustomEvent('AirArenaNetplayStatus', { detail: detail || {} }));
    }

    function setStatus(text, extra) {
        statusText = text || '';
        emitUi(Object.assign({ status: statusText, role, room, peerConnected, engaged }, extra || {}));
    }

    function roomFromUrl() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            const id = params.get('hostRoom') || params.get('room');
            if (id) return String(id);
            if (params.get('host') === '1') return 'local';
            return null;
        } catch (e) {
            return null;
        }
    }

    function roleFromUrl() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            const r = params.get('netRole');
            if (r === 'host' || r === 'guest') return r;
            if (params.get('join') === '1') return 'guest';
            return null;
        } catch (e) {
            return null;
        }
    }

    function seatFromUrl() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            const s = params.get('netSeat');
            if (s === 'red' || s === 'blue') return s;
            return null;
        } catch (e) {
            return null;
        }
    }

    function defaultWsUrl() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            const override = params.get('roomServer') || params.get('ws');
            if (override) return override;
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.hostname || '127.0.0.1';
            const port = params.get('roomPort') || '8081';
            return `${proto}//${host}:${port}`;
        } catch (e) {
            return 'ws://127.0.0.1:8081';
        }
    }

    function encodeTurn(log) {
        const ser = (typeof AirArenaTurnLogSerialize !== 'undefined')
            ? AirArenaTurnLogSerialize.serializeTurnLog(log)
            : log;
        const p = Proto();
        return p
            ? p.envelope(MSG().TURN_LOG || 'turn-log', ser, { room, role })
            : { type: 'turn-log', protocol: PROTOCOL(), payload: ser };
    }

    function decodeTurn(msg) {
        if (!msg || (msg.type !== 'turn-log' && msg.type !== (MSG().TURN_LOG || 'turn-log'))) return null;
        if (typeof AirArenaTurnLogSerialize !== 'undefined' && AirArenaTurnLogSerialize.hydrateTurnLog) {
            return AirArenaTurnLogSerialize.hydrateTurnLog(msg.payload);
        }
        return msg.payload;
    }

    function clearIntentTimer() {
        if (intentTimer) {
            clearTimeout(intentTimer);
            intentTimer = null;
        }
    }

    function armIntentTimer() {
        clearIntentTimer();
        const p = Proto();
        const ms = (p && p.INTENT_TIMEOUT_MS) || 90000;
        intentTimer = setTimeout(() => {
            intentTimer = null;
            if (role !== 'host' || !engaged) return;
            setStatus('對手超時 — 以待機姿態代操作', { timeout: true });
            const intent = {
                seatId: remoteSeatId,
                turn: (typeof GameContext !== 'undefined' && GameContext.state)
                    ? Number(GameContext.state.currentTurn) || 1
                    : 1,
                joyX: 0,
                joyY: 0,
                roll: 0,
                throttle: 2,
                weapon: 'gun',
                queuedAction: 'none',
                ready: true,
                afk: true
            };
            onRemoteIntent(intent);
        }, ms);
    }

    function post(msg) {
        if (!transport || !transport.send) return false;
        try {
            transport.send(msg);
            return true;
        } catch (e) {
            return false;
        }
    }

    function handleMessage(data) {
        const p = Proto();
        if (!data || (p && !p.isCompatible(data))) return;
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('AirArenaHostMessage', { detail: data }));
        }

        const type = data.type;
        const m = MSG();

        if (type === m.WELCOME || type === 'welcome') {
            const pay = data.payload || {};
            if (pay.seatToken) seatToken = pay.seatToken;
            if (pay.reconnectToken) reconnectToken = pay.reconnectToken;
            if (pay.role) role = pay.role;
            if (pay.seatId) localSeatId = pay.seatId;
            if (pay.remoteSeatId) remoteSeatId = pay.remoteSeatId;
            if (pay.room) room = pay.room;
            setStatus(pay.message || `已連線房間 ${room}`);
            return;
        }

        if (type === m.PEER_STATUS || type === 'peer-status') {
            const pay = data.payload || {};
            peerConnected = !!pay.connected;
            setStatus(peerConnected ? '對手已入房' : '等待對手…', { peer: pay });
            if (role === 'host' && peerConnected && matchConfig) {
                sendMatchConfig();
            }
            return;
        }

        if (type === m.MATCH_CONFIG || type === 'match-config') {
            if (role !== 'guest') return;
            const pay = data.payload || {};
            matchConfig = pay.matchConfig || pay.config || null;
            matchSeed = pay.matchSeed != null ? pay.matchSeed : pay.seed;
            if (p && p.applyMatchSeed) p.applyMatchSeed(matchSeed);
            setStatus('已收到開局設定 — 可 ENGAGE', { matchConfig, matchSeed });
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('AirArenaNetplayMatchConfig', {
                    detail: { matchConfig, matchSeed, localSeatId, remoteSeatId }
                }));
            }
            return;
        }

        if (type === m.TURN_INTENT || type === 'turn-intent') {
            if (role !== 'host') return;
            onRemoteIntent(data.payload);
            return;
        }

        if (type === m.TURN_LOG || type === 'turn-log') {
            if (role !== 'guest') return;
            guestApplyTurnLog(data);
            return;
        }

        if (type === m.QUEUE_MATCHED || type === 'queue-matched') {
            const pay = data.payload || {};
            room = pay.room || room;
            role = pay.role || role;
            localSeatId = pay.seatId || localSeatId;
            remoteSeatId = pay.remoteSeatId || remoteSeatId;
            seatToken = pay.seatToken || seatToken;
            reconnectToken = pay.reconnectToken || reconnectToken;
            queueMode = null;
            if (role === 'host') {
                peerConnected = true;
                if (!matchConfig && p && p.defaultNetMatchConfig) {
                    matchConfig = p.defaultNetMatchConfig('red');
                }
                if (matchSeed == null && p && p.makeMatchSeed) matchSeed = p.makeMatchSeed();
            } else if (role === 'guest') {
                peerConnected = true;
            }
            setStatus(`配對成功：房間 ${room}（${role}）`, { matched: pay });
            return;
        }

        if (type === m.PONG || type === 'pong') return;

        if (type === m.ERROR || type === 'error') {
            lastError = (data.payload && data.payload.message) || '連線錯誤';
            setStatus(lastError, { error: true });
            return;
        }

        if (type === m.PING || type === 'ping') {
            const p2 = Proto();
            post(p2 ? p2.envelope(m.PONG || 'pong', { t: data.ts }) : { type: 'pong', protocol: PROTOCOL() });
        }
    }

    function createBroadcastTransport(roomId) {
        if (typeof BroadcastChannel === 'undefined') return null;
        const channel = new BroadcastChannel(`airarena-host-${roomId}`);
        const selfId = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        channel.onmessage = (ev) => {
            const data = ev && ev.data;
            if (!data || data._from === selfId) return;
            handleMessage(data);
        };
        return {
            kind: 'broadcast',
            send(msg) {
                const out = Object.assign({}, msg, { _from: selfId, room: roomId });
                channel.postMessage(out);
            },
            close() {
                if (channel.close) channel.close();
            }
        };
    }

    function createWsTransport(url) {
        let ws = null;
        let closed = false;
        const queue = [];
        function flush() {
            while (ws && ws.readyState === 1 && queue.length) {
                ws.send(JSON.stringify(queue.shift()));
            }
        }
        try {
            ws = new WebSocket(url);
        } catch (e) {
            return null;
        }
        ws.onopen = () => {
            flush();
            setStatus('WebSocket 已連線');
            // hello / create / join is sent by start()
        };
        ws.onmessage = (ev) => {
            let data = null;
            try {
                data = JSON.parse(ev.data);
            } catch (e) {
                return;
            }
            handleMessage(data);
        };
        ws.onclose = () => {
            if (!closed) setStatus('連線中斷 — 可嘗試重連', { disconnected: true });
        };
        ws.onerror = () => {
            lastError = 'WebSocket 錯誤';
        };
        return {
            kind: 'websocket',
            send(msg) {
                const raw = JSON.stringify(msg);
                if (ws && ws.readyState === 1) ws.send(raw);
                else queue.push(msg);
            },
            close() {
                closed = true;
                try { if (ws) ws.close(); } catch (e) { /* ignore */ }
                ws = null;
            },
            getWs() { return ws; }
        };
    }

    function sendHello(action, extra) {
        const p = Proto();
        const m = MSG();
        const payload = Object.assign({
            action: action, // create | join | queue | reconnect
            room: room,
            role: role,
            seatId: localSeatId,
            seatToken: seatToken,
            reconnectToken: reconnectToken,
            clientVersion: (p && p.CLIENT_VERSION) || '3.0.0-netplay'
        }, extra || {});
        post(p ? p.envelope(m.HELLO || 'hello', payload) : { type: 'hello', protocol: PROTOCOL(), payload });
    }

    function sendMatchConfig() {
        if (role !== 'host' || !matchConfig) return false;
        const p = Proto();
        const m = MSG();
        const payload = {
            matchConfig: matchConfig,
            matchSeed: matchSeed,
            hostSeatId: localSeatId,
            guestSeatId: remoteSeatId
        };
        return post(p
            ? p.envelope(m.MATCH_CONFIG || 'match-config', payload, { room })
            : { type: 'match-config', protocol: PROTOCOL(), payload });
    }

    function onRemoteIntent(intent) {
        if (!intent || role !== 'host') return;
        const seat = intent.seatId || remoteSeatId;
        if (seat !== remoteSeatId && seat !== 'blue' && seat !== 'red') {
            // allow explicit seat from guest
        }
        const applySeat = intent.seatId || remoteSeatId;
        pendingRemoteIntent = intent;
        clearIntentTimer();
        const p = Proto();
        if (p && p.applyTurnIntent) {
            p.applyTurnIntent(applySeat, intent, { GameContext: typeof GameContext !== 'undefined' ? GameContext : null });
        }
        setStatus('已收到對手指令', { intent: true });
        maybeResolveHostTurn();
    }

    function maybeResolveHostTurn() {
        if (role !== 'host' || !engaged) return false;
        if (typeof GameContext === 'undefined') return false;
        const local = GameContext.getTeam(localSeatId);
        if (!local || !local.ready) {
            setStatus('等待本機 Ready…');
            return false;
        }
        const remote = GameContext.getTeam(remoteSeatId);
        if (!remote || !remote.ready) {
            setStatus('等待對手 Ready…');
            armIntentTimer();
            return false;
        }
        clearIntentTimer();
        // Run AI wingmen if any, then resolve.
        if (typeof window !== 'undefined' && window.uiRunPendingAIAndMaybeResolve) {
            window.uiRunPendingAIAndMaybeResolve();
        } else if (typeof window !== 'undefined' && window.executeTurnSimultaneously) {
            window.executeTurnSimultaneously();
        }
        return true;
    }

    function guestApplyTurnLog(msg) {
        const log = decodeTurn(msg);
        if (!log || typeof GameContext === 'undefined') return false;
        if (GameContext.isAnimating && GameContext.isAnimating()) return false;

        GameContext.stateMachine.commitTurn(log);
        pendingRemoteIntent = null;
        // Clear local ready flags — finishTurn will advance planning.
        const living = GameContext.getLivingTeamIds ? GameContext.getLivingTeamIds() : [];
        living.forEach((id) => {
            const t = GameContext.getTeam(id);
            if (t) t.ready = false;
        });

        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('EnginePhaseChanged', {
                detail: { phase: 'playing', maxLog: GameContext.state.battleLog.length, netplayGuest: true }
            }));
        }
        if (GameContext.services && GameContext.services.startCombatAnimation) {
            GameContext.callService('startCombatAnimation');
        } else if (typeof window !== 'undefined' && window.startCombatAnimation) {
            window.startCombatAnimation();
        } else {
            GameContext.setAnimating(true);
            GameContext.state.animProgress = 0;
        }
        setStatus(`重播回合 ${log.turn != null ? log.turn : ''}`);
        return true;
    }

    function broadcastTurn(log) {
        if (role !== 'host') return false;
        return post(encodeTurn(log));
    }

    function captureAndSendLocalIntent(teamId) {
        if (!engaged || !role) return false;
        const seat = teamId || localSeatId;
        if (seat !== localSeatId) return false;
        const p = Proto();
        const t = (typeof GameContext !== 'undefined') ? GameContext.getTeam(seat) : null;
        const turn = (typeof GameContext !== 'undefined' && GameContext.state)
            ? Number(GameContext.state.currentTurn) || 1
            : 1;
        const intent = p && p.buildTurnIntent
            ? p.buildTurnIntent(seat, t, turn)
            : { seatId: seat, turn, ready: true };

        if (role === 'guest') {
            const m = MSG();
            const ok = post(p
                ? p.envelope(m.TURN_INTENT || 'turn-intent', intent, { room })
                : { type: 'turn-intent', protocol: PROTOCOL(), payload: intent });
            setStatus(ok ? '已送出指令，等待房主結算…' : '送出指令失敗');
            return ok;
        }

        // Host local ready: wait for remote or resolve.
        if (role === 'host') {
            setStatus('本機已 Ready');
            maybeResolveHostTurn();
            return true;
        }
        return false;
    }

    function isActive() {
        return !!(role && transport);
    }

    function isHost() {
        return role === 'host' && !!transport;
    }

    function isGuest() {
        return role === 'guest' && !!transport;
    }

    function shouldInterceptReady(teamId) {
        if (!isActive() || !engaged) return false;
        return teamId === localSeatId;
    }

    function shouldBlockLocalResolve() {
        // Guest never resolves; Host resolves only via maybeResolveHostTurn.
        return isActive() && engaged;
    }

    function beginEngaged(cfg, seed) {
        engaged = true;
        if (cfg) matchConfig = cfg;
        if (seed != null) matchSeed = seed;
        const p = Proto();
        if (p && p.applyMatchSeed) p.applyMatchSeed(matchSeed);
        if (role === 'host') {
            sendMatchConfig();
            setStatus('交戰中（房主權威）');
            if (peerConnected) armIntentTimer();
        } else {
            setStatus('交戰中（訪客重播）');
        }
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('EnginePhaseChanged', (e) => {
            const phase = e && e.detail && e.detail.phase;
            if (!engaged || !role) return;
            if (phase === 'planning' && role === 'host' && !e.detail.wreckFall) {
                pendingRemoteIntent = null;
                armIntentTimer();
                setStatus('規劃中 — 等待雙方 Ready');
            }
            if (phase === 'game_over') {
                clearIntentTimer();
                setStatus('戰鬥結束');
            }
        });
    }

    /**
     * Start netplay transport.
     * opts: { role, room, seatId, transport: 'broadcast'|'websocket', wsUrl, action, matchConfig, matchSeed }
     */
    function start(opts) {
        stop();
        const o = opts || {};
        const p = Proto();
        role = o.role || roleFromUrl() || 'host';
        room = o.room || roomFromUrl();
        localSeatId = o.seatId || seatFromUrl() || (role === 'guest' ? 'blue' : 'red');
        remoteSeatId = localSeatId === 'red' ? 'blue' : 'red';
        matchConfig = o.matchConfig || (p && p.defaultNetMatchConfig
            ? p.defaultNetMatchConfig(localSeatId === 'blue' ? 'blue' : 'red')
            : null);
        matchSeed = o.matchSeed != null ? o.matchSeed : (p && p.makeMatchSeed ? p.makeMatchSeed() : 1);
        seatToken = o.seatToken || (p && p.makeSeatToken ? p.makeSeatToken() : null);
        reconnectToken = o.reconnectToken || null;
        peerConnected = false;
        pendingRemoteIntent = null;
        engaged = false;
        lastError = null;

        const preferWs = o.transport === 'websocket'
            || o.wsUrl
            || (typeof window !== 'undefined' && /[?&](roomServer|ws|roomPort)=/.test(window.location.search || ''))
            || (o.action === 'create' || o.action === 'join' || o.action === 'queue');

        if (preferWs && o.transport !== 'broadcast') {
            const url = o.wsUrl || defaultWsUrl();
            transport = createWsTransport(url);
            if (!transport) {
                setStatus('無法開啟 WebSocket');
                return false;
            }
            // Defer hello until socket may be open — queue in transport.
            const action = o.action || (role === 'guest' ? 'join' : 'create');
            if (!room && action === 'create' && p && p.makeInviteCode) {
                room = p.makeInviteCode();
            }
            sendHello(action, {
                mode: o.mode || '1v1',
                queue: !!o.queue
            });
            setStatus(action === 'queue' ? '排隊配對中…' : `連線中（${room || '新房間'}）…`);
            return true;
        }

        // BroadcastChannel local proof
        if (!room) room = 'local';
        transport = createBroadcastTransport(room);
        if (!transport) {
            setStatus('BroadcastChannel 不可用');
            return false;
        }
        peerConnected = true; // same-origin tabs announce via peer-status
        const p2 = Proto();
        const m = MSG();
        post(p2
            ? p2.envelope(m.PEER_STATUS || 'peer-status', { connected: true, seatId: localSeatId, role }, { room })
            : { type: 'peer-status', protocol: PROTOCOL(), payload: { connected: true } });
        if (role === 'host') {
            // Fake welcome for BC
            setStatus(`本機房間 ${room}（BroadcastChannel）`);
        } else {
            setStatus(`已加入本機房間 ${room}`);
        }
        return true;
    }

    function startHostRoom(opts) {
        const p = Proto();
        const code = (opts && opts.room) || (p && p.makeInviteCode && p.makeInviteCode()) || 'ROOM';
        const useWs = !opts || opts.transport !== 'broadcast';
        return start(Object.assign({
            role: 'host',
            room: code,
            seatId: 'red',
            action: 'create',
            transport: useWs ? 'websocket' : 'broadcast',
            matchSeed: p && p.makeMatchSeed ? p.makeMatchSeed() : 1,
            matchConfig: (opts && opts.matchConfig) || (p && p.defaultNetMatchConfig
                ? p.defaultNetMatchConfig('red')
                : null)
        }, opts || {}));
    }

    function joinRoom(code, opts) {
        const p = Proto();
        return start(Object.assign({
            role: 'guest',
            room: String(code || '').trim().toUpperCase(),
            seatId: 'blue',
            action: 'join',
            transport: 'websocket',
            matchConfig: p && p.defaultNetMatchConfig ? p.defaultNetMatchConfig('blue') : null
        }, opts || {}));
    }

    function joinQueue(opts) {
        return start(Object.assign({
            role: 'host', // server assigns
            room: null,
            seatId: 'red',
            action: 'queue',
            transport: 'websocket',
            queue: true,
            mode: (opts && opts.mode) || '1v1'
        }, opts || {}));
    }

    function tryReconnect() {
        if (!reconnectToken || !room) return false;
        return start({
            role: role || 'guest',
            room: room,
            seatId: localSeatId,
            action: 'reconnect',
            transport: 'websocket',
            seatToken: seatToken,
            reconnectToken: reconnectToken
        });
    }

    function stop() {
        clearIntentTimer();
        if (transport && transport.close) transport.close();
        transport = null;
        role = null;
        room = null;
        peerConnected = false;
        pendingRemoteIntent = null;
        engaged = false;
        queueMode = null;
    }

    // Auto-boot from URL for dual-tab BC debug
    if (typeof window !== 'undefined') {
        window.addEventListener('DOMContentLoaded', () => {
            const r = roomFromUrl();
            const netRole = roleFromUrl();
            if (r && netRole) {
                start({
                    role: netRole,
                    room: r,
                    seatId: seatFromUrl() || (netRole === 'guest' ? 'blue' : 'red'),
                    transport: 'broadcast'
                });
            } else if (r && !netRole) {
                // Legacy: hostRoom alone → host BC
                start({ role: 'host', room: r, transport: 'broadcast' });
            }
        });
    }

    return {
        PROTOCOL: PROTOCOL(),
        roomFromUrl,
        roleFromUrl,
        encodeTurn,
        decodeTurn,
        start,
        startHostRoom,
        joinRoom,
        joinQueue,
        tryReconnect,
        stop,
        broadcastTurn,
        sendMatchConfig,
        beginEngaged,
        captureAndSendLocalIntent,
        guestApplyTurnLog,
        maybeResolveHostTurn,
        isActive,
        isHost,
        isGuest,
        shouldInterceptReady,
        shouldBlockLocalResolve,
        getRole() { return role; },
        getRoom() { return room; },
        getLocalSeatId() { return localSeatId; },
        getRemoteSeatId() { return remoteSeatId; },
        getMatchConfig() { return matchConfig; },
        getMatchSeed() { return matchSeed; },
        getStatus() { return statusText; },
        getSeatToken() { return seatToken; },
        getReconnectToken() { return reconnectToken; },
        isPeerConnected() { return peerConnected; },
        isEngaged() { return engaged; },
        defaultWsUrl
    };
});
