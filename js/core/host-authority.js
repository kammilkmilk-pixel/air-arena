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
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.hostname || '127.0.0.1';
            if (override) {
                const o = String(override).trim();
                if (/^wss?:\/\//i.test(o)) return o;
                if (o.startsWith('/')) {
                    const portPart = window.location.port ? `:${window.location.port}` : '';
                    return `${proto}//${host}${portPart}${o}`;
                }
                // host:port form
                if (o.indexOf('://') < 0) return `${proto}//${o}`;
                return o;
            }
            // Same origin as the page (required for phone ↔ PC LAN).
            // Legacy split: ?roomPort=8081 when static is on another port.
            if (params.get('roomPort')) {
                return `${proto}//${host}:${params.get('roomPort')}`;
            }
            const portPart = window.location.port ? `:${window.location.port}` : '';
            return `${proto}//${host}${portPart}`;
        } catch (e) {
            return 'ws://127.0.0.1:8080';
        }
    }

    function inviteJoinUrl(code) {
        try {
            const u = new URL(window.location.href);
            u.searchParams.set('room', String(code || '').toUpperCase());
            u.searchParams.set('join', '1');
            u.searchParams.delete('hostRoom');
            u.searchParams.delete('netRole');
            u.searchParams.delete('bc');
            if (typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud) {
                u.searchParams.set('cloud', '1');
            }
            return u.toString();
        } catch (e) {
            const cloud = (typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud) ? '&cloud=1' : '';
            return `?room=${encodeURIComponent(code)}&join=1${cloud}`;
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
        const T = typeof AirArenaNetplayTransports !== 'undefined' ? AirArenaNetplayTransports : null;
        if (T && T.createBroadcastTransport) {
            return T.createBroadcastTransport({
                roomId,
                onMessage: handleMessage
            });
        }
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
                channel.postMessage(Object.assign({}, msg, { _from: selfId, room: roomId }));
            },
            close() {
                if (channel.close) channel.close();
            },
            whenReady() { return Promise.resolve(); }
        };
    }

    function createWsTransport(url) {
        const T = typeof AirArenaNetplayTransports !== 'undefined' ? AirArenaNetplayTransports : null;
        if (T && T.createWebSocketTransport) {
            return T.createWebSocketTransport({
                url,
                onMessage: handleMessage,
                onStatus: (text, extra) => setStatus(text, extra)
            });
        }
        return null;
    }

    function createSupabaseTransport(opts) {
        const T = typeof AirArenaNetplayTransports !== 'undefined' ? AirArenaNetplayTransports : null;
        if (!T || !T.createSupabaseTransport) return null;
        return T.createSupabaseTransport(Object.assign({
            onMessage: handleMessage,
            onStatus: (text, extra) => setStatus(text, extra || {})
        }, opts || {}));
    }

    function preferredTransportKind(o) {
        const T = typeof AirArenaNetplayTransports !== 'undefined' ? AirArenaNetplayTransports : null;
        if (o && o.transport) return o.transport;
        if (T && T.resolveKind) return T.resolveKind(o);
        if (o && (o.action === 'create' || o.action === 'join' || o.action === 'queue')) return 'websocket';
        return 'broadcast';
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
     * opts: { role, room, seatId, transport: 'broadcast'|'websocket'|'supabase', wsUrl, action, matchConfig, matchSeed, preferCloud }
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

        const kind = preferredTransportKind(Object.assign({}, o, {
            preferCloud: o.preferCloud != null ? o.preferCloud : (typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud)
        }));

        if (kind === 'supabase') {
            const action = o.action || (role === 'guest' ? 'join' : 'create');
            if (!room && action === 'create' && p && p.makeInviteCode) {
                room = p.makeInviteCode();
            }
            transport = createSupabaseTransport({
                action,
                room,
                role,
                seatId: localSeatId,
                seatToken,
                reconnectToken,
                mode: o.mode || '1v1'
            });
            if (!transport) {
                setStatus('無法開啟 Supabase 傳輸（檢查雲端設定）', { error: true });
                return false;
            }
            // Sync tokens/room from transport after boot via welcome; provisional room for UI
            if (transport.getRoom && transport.getRoom()) room = transport.getRoom();
            setStatus(action === 'queue' ? '雲端排隊中…' : `雲端連線中（${room || '新房間'}）…`);
            return true;
        }

        if (kind === 'websocket') {
            const url = o.wsUrl || defaultWsUrl();
            transport = createWsTransport(url);
            if (!transport) {
                setStatus('無法開啟 WebSocket', { error: true });
                return false;
            }
            const action = o.action || (role === 'guest' ? 'join' : 'create');
            if (!room && action === 'create' && p && p.makeInviteCode) {
                room = p.makeInviteCode();
            }
            sendHello(action, {
                mode: o.mode || '1v1',
                queue: !!o.queue
            });
            setStatus(action === 'queue' ? '排隊配對中…' : `連線中 ${url}（${room || '新房間'}）…`);
            return true;
        }

        // BroadcastChannel: same-browser tabs only (NOT phones).
        if (!room) room = 'local';
        transport = createBroadcastTransport(room);
        if (!transport) {
            setStatus('BroadcastChannel 不可用', { error: true });
            return false;
        }
        peerConnected = true;
        const p2 = Proto();
        const m = MSG();
        post(p2
            ? p2.envelope(m.PEER_STATUS || 'peer-status', { connected: true, seatId: localSeatId, role }, { room })
            : { type: 'peer-status', protocol: PROTOCOL(), payload: { connected: true } });
        setStatus(role === 'host'
            ? `本機房間 ${room}（僅同瀏覽器分頁）`
            : `已加入本機房間 ${room}`);
        return true;
    }

    /**
     * Async start: waits for transport ready (and optionally WELCOME).
     */
    function startAsync(opts) {
        const started = start(opts);
        if (!started) {
            return Promise.resolve({
                ok: false,
                error: lastError || statusText || 'start failed',
                url: null,
                room: null
            });
        }
        const kind = transport && transport.kind;
        if (kind === 'broadcast') {
            return Promise.resolve({
                ok: true,
                room,
                url: null,
                transport: 'broadcast',
                inviteUrl: room ? inviteJoinUrl(room) : null
            });
        }
        const url = transport.url || (kind === 'supabase' ? 'supabase' : defaultWsUrl());
        const readyFn = transport.whenReady
            ? transport.whenReady()
            : Promise.resolve();
        return readyFn.then(() => {
            if (transport.getRoom && transport.getRoom()) room = transport.getRoom();
            if (transport.getRole && transport.getRole()) role = transport.getRole();
            if (transport.getSeatId && transport.getSeatId()) {
                localSeatId = transport.getSeatId();
                remoteSeatId = localSeatId === 'red' ? 'blue' : 'red';
            }
            if (transport.getSeatToken && transport.getSeatToken()) seatToken = transport.getSeatToken();
            if (transport.getReconnectToken && transport.getReconnectToken()) {
                reconnectToken = transport.getReconnectToken();
            }
            return new Promise((resolve) => {
                let done = false;
                const finish = (ok, extra) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    window.removeEventListener('AirArenaHostMessage', onMsg);
                    resolve(Object.assign({
                        ok,
                        room,
                        url,
                        transport: kind,
                        inviteUrl: room ? inviteJoinUrl(room) : null
                    }, extra || {}));
                };
                const timer = setTimeout(() => {
                    finish(true, { warn: 'welcome-timeout' });
                }, kind === 'supabase' ? 6000 : 4000);
                function onMsg(ev) {
                    const data = ev && ev.detail;
                    if (!data) return;
                    if (data.type === 'welcome' || data.type === (MSG().WELCOME || 'welcome')) {
                        if (data.payload && data.payload.room) room = data.payload.room;
                        finish(true);
                    }
                    if (data.type === 'queue-matched' || data.type === (MSG().QUEUE_MATCHED || 'queue-matched')) {
                        if (data.payload && data.payload.room) room = data.payload.room;
                        finish(true, { matched: true });
                    }
                    if (data.type === 'error' || data.type === (MSG().ERROR || 'error')) {
                        const msg = (data.payload && data.payload.message) || 'server error';
                        lastError = msg;
                        setStatus(msg, { error: true });
                        finish(false, { error: msg });
                    }
                }
                window.addEventListener('AirArenaHostMessage', onMsg);
            });
        }).catch((err) => {
            const hint = kind === 'supabase'
                ? `無法連線 Supabase：${String(err && err.message || err)}。請檢查專案 URL／anon key，並啟用 Anonymous Auth + Realtime。`
                : `無法連線房間伺服器（${url}）。請在電腦執行 npm start，手機用同一 Wi‑Fi 開啟電腦顯示的 http://LAN-IP:埠/ ，不要用 127.0.0.1。`;
            lastError = String(err && err.message || err);
            setStatus(hint, { error: true });
            try { stop(); } catch (e) { /* ignore */ }
            return { ok: false, error: lastError, url, room: null, hint };
        });
    }

    function startHostRoom(opts) {
        const p = Proto();
        const code = (opts && opts.room) || (p && p.makeInviteCode && p.makeInviteCode()) || 'ROOM';
        const cloud = !!(opts && (opts.preferCloud || opts.transport === 'supabase'));
        return start(Object.assign({
            role: 'host',
            room: code,
            seatId: 'red',
            action: 'create',
            transport: cloud ? 'supabase' : ((opts && opts.transport) || 'websocket'),
            preferCloud: cloud,
            matchSeed: p && p.makeMatchSeed ? p.makeMatchSeed() : 1,
            matchConfig: (opts && opts.matchConfig) || (p && p.defaultNetMatchConfig
                ? p.defaultNetMatchConfig('red')
                : null)
        }, opts || {}));
    }

    function startHostRoomAsync(opts) {
        const p = Proto();
        const code = (opts && opts.room) || (p && p.makeInviteCode && p.makeInviteCode()) || 'ROOM';
        const cloud = !!(opts && (opts.preferCloud || opts.transport === 'supabase'
            || (typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud)));
        return startAsync(Object.assign({
            role: 'host',
            room: code,
            seatId: 'red',
            action: 'create',
            transport: cloud ? 'supabase' : 'websocket',
            preferCloud: cloud,
            matchSeed: p && p.makeMatchSeed ? p.makeMatchSeed() : 1,
            matchConfig: (opts && opts.matchConfig) || (p && p.defaultNetMatchConfig
                ? p.defaultNetMatchConfig('red')
                : null)
        }, opts || {}));
    }

    function joinRoom(code, opts) {
        const p = Proto();
        const cloud = !!(opts && (opts.preferCloud || opts.transport === 'supabase'));
        return start(Object.assign({
            role: 'guest',
            room: String(code || '').trim().toUpperCase(),
            seatId: 'blue',
            action: 'join',
            transport: cloud ? 'supabase' : 'websocket',
            preferCloud: cloud,
            matchConfig: p && p.defaultNetMatchConfig ? p.defaultNetMatchConfig('blue') : null
        }, opts || {}));
    }

    function joinRoomAsync(code, opts) {
        const p = Proto();
        const cloud = !!(opts && (opts.preferCloud || opts.transport === 'supabase'
            || (typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud)));
        return startAsync(Object.assign({
            role: 'guest',
            room: String(code || '').trim().toUpperCase(),
            seatId: 'blue',
            action: 'join',
            transport: cloud ? 'supabase' : 'websocket',
            preferCloud: cloud,
            matchConfig: p && p.defaultNetMatchConfig ? p.defaultNetMatchConfig('blue') : null
        }, opts || {}));
    }

    function joinQueue(opts) {
        const cloud = !!(opts && (opts.preferCloud || opts.transport === 'supabase'
            || (typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud)));
        return start(Object.assign({
            role: 'host',
            room: null,
            seatId: 'red',
            action: 'queue',
            transport: cloud ? 'supabase' : 'websocket',
            preferCloud: cloud,
            queue: true,
            mode: (opts && opts.mode) || '1v1'
        }, opts || {}));
    }

    function joinQueueAsync(opts) {
        const cloud = !!(opts && (opts.preferCloud || opts.transport === 'supabase'
            || (typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud)));
        return startAsync(Object.assign({
            role: 'host',
            room: null,
            seatId: 'red',
            action: 'queue',
            transport: cloud ? 'supabase' : 'websocket',
            preferCloud: cloud,
            queue: true,
            mode: (opts && opts.mode) || '1v1'
        }, opts || {}));
    }

    function tryReconnect() {
        if (!reconnectToken || !room) return false;
        const cloud = !!(typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud);
        return start({
            role: role || 'guest',
            room: room,
            seatId: localSeatId,
            action: 'reconnect',
            transport: cloud ? 'supabase' : 'websocket',
            preferCloud: cloud,
            seatToken: seatToken,
            reconnectToken: reconnectToken
        });
    }

    function tryReconnectAsync() {
        if (!reconnectToken && typeof sessionStorage !== 'undefined') {
            try {
                reconnectToken = sessionStorage.getItem('aa-net-reconnect') || reconnectToken;
                room = room || sessionStorage.getItem('aa-net-room');
                localSeatId = localSeatId || sessionStorage.getItem('aa-net-seat') || 'red';
                role = role || sessionStorage.getItem('aa-net-role') || 'guest';
            } catch (e) { /* ignore */ }
        }
        if (!reconnectToken || !room) {
            return Promise.resolve({ ok: false, error: '無重連 token' });
        }
        const cloud = !!(typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud)
            || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('aa-net-cloud') === '1');
        return startAsync({
            role: role || 'guest',
            room: room,
            seatId: localSeatId,
            action: 'reconnect',
            transport: cloud ? 'supabase' : 'websocket',
            preferCloud: cloud,
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

    // URL boot: cross-device join uses WebSocket or Supabase; BC only with ?bc=1
    if (typeof window !== 'undefined') {
        window.addEventListener('DOMContentLoaded', () => {
            try {
                const params = new URLSearchParams(window.location.search || '');
                if (params.get('cloud') === '1' || params.get('baas') === '1') {
                    window.AirArenaNetplayPreferCloud = true;
                }
                const r = roomFromUrl();
                const netRole = roleFromUrl();
                const wantBc = params.get('bc') === '1';
                const wantJoin = params.get('join') === '1' || netRole === 'guest';
                const cloud = !!window.AirArenaNetplayPreferCloud
                    && (typeof AirArenaSupabaseConfig !== 'undefined' && AirArenaSupabaseConfig.isConfigured());
                if (r && wantJoin && !wantBc) {
                    startAsync({
                        role: 'guest',
                        room: r,
                        seatId: seatFromUrl() || 'blue',
                        action: 'join',
                        transport: cloud ? 'supabase' : 'websocket',
                        preferCloud: cloud
                    }).then((res) => {
                        if (res && res.ok) setStatus(`已加入房間 ${res.room || r}，等待／按 ENGAGE`);
                    });
                    return;
                }
                if (r && wantBc) {
                    start({
                        role: netRole || 'host',
                        room: r,
                        seatId: seatFromUrl() || ((netRole === 'guest') ? 'blue' : 'red'),
                        transport: 'broadcast'
                    });
                }
            } catch (e) { /* ignore */ }
        });
    }

    return {
        PROTOCOL: PROTOCOL(),
        roomFromUrl,
        roleFromUrl,
        encodeTurn,
        decodeTurn,
        start,
        startAsync,
        startHostRoom,
        startHostRoomAsync,
        joinRoom,
        joinRoomAsync,
        joinQueue,
        joinQueueAsync,
        tryReconnect,
        tryReconnectAsync,
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
        inviteJoinUrl,
        preferredTransportKind,
        isCloudConfigured() {
            return !!(typeof AirArenaSupabaseConfig !== 'undefined' && AirArenaSupabaseConfig.isConfigured
                && AirArenaSupabaseConfig.isConfigured());
        },
        setPreferCloud(on) {
            if (typeof window !== 'undefined') window.AirArenaNetplayPreferCloud = !!on;
            try { sessionStorage.setItem('aa-net-cloud', on ? '1' : '0'); } catch (e) { /* ignore */ }
        },
        getPreferCloud() {
            return !!(typeof window !== 'undefined' && window.AirArenaNetplayPreferCloud);
        },
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
