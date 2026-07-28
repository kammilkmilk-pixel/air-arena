// ============================================================================
// ui.js - MFD 儀表板與輸入控制 (5檔磁吸滑軌控制)
// ============================================================================

function uiCurrentTeamId() { return GameContext.getActiveTeamId(); }
function uiCurrentTeam() { return GameContext.getActiveTeam(); }
function uiRefreshPreview(team) { GameContext.callService('updateTacticalPreview', team); }
let uiAutoAIBattleTimer = null;
let uiAutoAIFirstDelayDone = false;
let uiMatchSetupState = {
    mode: '1v1',
    seats: {
        'red-1': { control: 'human', loadout: 'standard' },
        'red-2': { control: 'ai', loadout: 'standard' },
        'blue-1': { control: 'ai', loadout: 'standard' },
        'blue-2': { control: 'ai', loadout: 'standard' }
    }
};
let uiMatchSetupBound = false;

function uiMatchSeatDefs(mode) {
    if (mode === '2v2') {
        return [
            { id: 'red-1', label: 'RED-1', faction: 'red', live: true },
            { id: 'red-2', label: 'RED-2', faction: 'red', live: true },
            { id: 'blue-1', label: 'BLUE-1', faction: 'blue', live: true },
            { id: 'blue-2', label: 'BLUE-2', faction: 'blue', live: true }
        ];
    }
    return [
        { id: 'red-1', label: 'RED-1', faction: 'red', live: true },
        { id: 'blue-1', label: 'BLUE-1', faction: 'blue', live: true }
    ];
}

function uiReadMatchSetupFromDom() {
    const modeBtn = document.querySelector('.match-mode-btn.is-active');
    const mode = (modeBtn && modeBtn.getAttribute('data-mode') === '2v2') ? '2v2' : '1v1';
    const seats = {
        'red-1': { control: 'human', loadout: 'standard' },
        'red-2': { control: 'ai', loadout: 'standard' },
        'blue-1': { control: 'ai', loadout: 'standard' },
        'blue-2': { control: 'ai', loadout: 'standard' }
    };
    uiMatchSeatDefs(mode).forEach((def) => {
        const controlEl = document.getElementById(`match-control-${def.id}`);
        const loadoutEl = document.getElementById(`match-loadout-${def.id}`);
        seats[def.id] = {
            control: (controlEl && controlEl.value === 'ai') ? 'ai' : 'human',
            loadout: (loadoutEl && loadoutEl.value) || 'standard'
        };
    });
    uiMatchSetupState = { mode, seats };
    return uiMatchSetupState;
}

function uiRenderMatchSeatList() {
    const list = document.getElementById('match-seat-list');
    if (!list) return;
    const mode = uiMatchSetupState.mode;
    const defs = uiMatchSeatDefs(mode);
    list.innerHTML = defs.map((def) => {
        const seat = uiMatchSetupState.seats[def.id] || { control: 'ai', loadout: 'standard' };
        const disabled = def.live ? '' : ' is-disabled';
        const note = def.live ? '' : ' title="此座位尚未啟用"';
        return `
            <div class="match-seat-row${disabled}" data-seat="${def.id}"${note}>
                <div class="match-seat-name ${def.faction}">${def.label}</div>
                <select id="match-control-${def.id}" aria-label="${def.label} control"${def.live ? '' : ' disabled'}>
                    <option value="human"${seat.control === 'human' ? ' selected' : ''}>人工</option>
                    <option value="ai"${seat.control === 'ai' ? ' selected' : ''}>AI</option>
                </select>
                <select id="match-loadout-${def.id}" aria-label="${def.label} loadout"${def.live ? '' : ' disabled'}>
                    <option value="standard"${seat.loadout === 'standard' ? ' selected' : ''}>標準 (Gun+FOX-2)</option>
                    <option value="gun-priority"${seat.loadout === 'gun-priority' ? ' selected' : ''}>機砲優先</option>
                    <option value="fox2-priority"${seat.loadout === 'fox2-priority' ? ' selected' : ''}>FOX-2 優先</option>
                </select>
            </div>
        `;
    }).join('');
    const hint = document.getElementById('match-mode-hint');
    if (hint) hint.classList.toggle('is-hidden', mode !== '2v2');
}

function uiBindMatchSetupOnce() {
    if (uiMatchSetupBound) return;
    const panel = document.getElementById('match-setup-panel');
    if (!panel) return;
    uiMatchSetupBound = true;

    panel.addEventListener('click', (e) => {
        const modeBtn = e.target.closest('.match-mode-btn');
        if (!modeBtn) return;
        uiReadMatchSetupFromDom();
        uiMatchSetupState.mode = modeBtn.getAttribute('data-mode') === '2v2' ? '2v2' : '1v1';
        document.querySelectorAll('.match-mode-btn').forEach((btn) => {
            btn.classList.toggle('is-active', btn === modeBtn);
        });
        uiRenderMatchSeatList();
    });

    panel.addEventListener('change', (e) => {
        if (!e.target.closest('#match-seat-list')) return;
        uiReadMatchSetupFromDom();
    });

    const engage = document.getElementById('btn-match-engage');
    if (engage) {
        engage.addEventListener('click', () => {
            uiConfirmMatchSetup();
        });
    }
}

function uiShowMatchSetup() {
    const screen = document.getElementById('startup-screen');
    const panel = document.getElementById('match-setup-panel');
    if (!screen || !panel) return false;
    uiBindMatchSetupOnce();
    if (!uiMatchSetupState.seats) {
        uiMatchSetupState = {
            mode: '1v1',
            seats: {
                'red-1': { control: 'human', loadout: 'standard' },
                'red-2': { control: 'ai', loadout: 'standard' },
                'blue-1': { control: 'ai', loadout: 'standard' },
                'blue-2': { control: 'ai', loadout: 'standard' }
            }
        };
    }
    document.querySelectorAll('.match-mode-btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-mode') === uiMatchSetupState.mode);
    });
    uiRenderMatchSeatList();
    panel.hidden = false;
    screen.classList.add('is-setup');
    screen.style.display = 'flex';
    screen.style.opacity = '1';
    screen.style.pointerEvents = 'auto';
    return true;
}

function uiDismissStartupScreen() {
    const startup = document.getElementById('startup-screen');
    if (!startup) return;
    startup.style.opacity = '0';
    setTimeout(() => {
        startup.style.display = 'none';
        startup.classList.remove('is-setup');
    }, 1200);
}

function uiConfirmMatchSetup() {
    const engage = document.getElementById('btn-match-engage');
    if (engage) engage.disabled = true;
    const draft = uiReadMatchSetupFromDom();
    const cfg = GameContext.stateMachine.applyMatchConfig(draft);
    uiRefreshTeamModeButtons();
    uiRefreshAIDebugPanel();

    let activeId = 'red';
    const seatPick = [
        ['red-1', 'red'],
        ['red-2', 'red2'],
        ['blue-1', 'blue'],
        ['blue-2', 'blue2']
    ];
    for (let i = 0; i < seatPick.length; i++) {
        const seatId = seatPick[i][0];
        const teamId = seatPick[i][1];
        if (cfg.seats[seatId] && cfg.seats[seatId].control === 'human' && teams[teamId] && teams[teamId].matchActive !== false) {
            activeId = teamId;
            break;
        }
    }
    if (teams[activeId] && teams[activeId].aiEnabled) {
        const living = (GameContext.getLivingTeamIds && GameContext.getLivingTeamIds()) || ['red', 'blue'];
        const human = living.find((id) => teams[id] && !teams[id].aiEnabled);
        if (human) activeId = human;
    }

    if (typeof window.selectTeam === 'function') window.selectTeam(activeId);
    else {
        updateDashboardUI(teams[activeId]);
        uiSyncSelectionChrome(activeId);
    }
    uiRefreshTeamModeButtons();

    if (typeof uiAreBothTeamsAI === 'function' && uiAreBothTeamsAI() && typeof uiScheduleBothAITurn === 'function') {
        uiScheduleBothAITurn();
    }

    if (typeof showSMSAlert === 'function') {
        const modeLabel = cfg.mode === '2v2' ? '2v2' : '1v1';
        showSMSAlert(`MATCH LOCKED: ${modeLabel}`, '#00ff88');
    }
    uiDismissStartupScreen();
}

function uiShouldSkipMatchSetup() {
    if (typeof window.AirArenaScenario !== 'undefined' && window.AirArenaScenario.isActive()) return true;
    try {
        const params = new URLSearchParams(window.location.search || '');
        if (params.get('skipSetup') === '1' || params.get('skipSetup') === 'true') return true;
        if (params.get('scenario')) return true;
    } catch (_) {}
    return false;
}

function uiBeginMatchOrShowSetup() {
    if (uiShouldSkipMatchSetup()) {
        const defaults = GameContext.createDefaultMatchConfig('1v1');
        GameContext.stateMachine.applyMatchConfig(defaults);
        if (typeof window.AirArenaScenario !== 'undefined' && window.AirArenaScenario.isActive()) {
            window.AirArenaScenario.apply();
        } else if (typeof uiAreBothTeamsAI === 'function' && uiAreBothTeamsAI() && typeof uiScheduleBothAITurn === 'function') {
            uiScheduleBothAITurn();
        }
        uiDismissStartupScreen();
        return;
    }
    uiShowMatchSetup();
}

window.uiShowMatchSetup = uiShowMatchSetup;
window.uiConfirmMatchSetup = uiConfirmMatchSetup;
window.uiBeginMatchOrShowSetup = uiBeginMatchOrShowSetup;
window.uiDismissStartupScreen = uiDismissStartupScreen;

function uiClearAutoAIBattleTimer() {
    if (uiAutoAIBattleTimer) {
        clearTimeout(uiAutoAIBattleTimer);
        uiAutoAIBattleTimer = null;
    }
}
window.uiClearAutoAIBattleTimer = uiClearAutoAIBattleTimer;
let uiPhaseBannerHideTimer = null;

function uiShowPhaseBanner(html, persist = false) {
    const phaseBanner = document.getElementById('phase-banner');
    if (!phaseBanner) return;
    if (uiPhaseBannerHideTimer) {
        clearTimeout(uiPhaseBannerHideTimer);
        uiPhaseBannerHideTimer = null;
    }
    phaseBanner.innerHTML = html;
    phaseBanner.style.display = 'block';
    phaseBanner.style.opacity = '1';
    phaseBanner.style.zIndex = '9500';
    if (!persist) {
        uiPhaseBannerHideTimer = setTimeout(() => {
            phaseBanner.style.opacity = '0';
            uiPhaseBannerHideTimer = null;
        }, 2200);
    }
}
window.uiShowPhaseBanner = uiShowPhaseBanner;
function uiLivingTeamIds() {
    if (GameContext.getLivingTeamIds) return GameContext.getLivingTeamIds();
    return ['red', 'blue'].filter((id) => teams[id] && teams[id].matchActive !== false && !teams[id].isDestroyed);
}
function uiAreBothTeamsAI() {
    const living = uiLivingTeamIds();
    return living.length > 0 && living.every((id) => teams[id] && teams[id].aiEnabled);
}
function uiScheduleBothAITurn() {
    uiClearAutoAIBattleTimer();
    if (!uiAreBothTeamsAI() || GameContext.isAnimating() || GameContext.isReplayMode()) return;
    const turnNo = Number(GameContext.state.currentTurn || 1);
    if (turnNo <= 1 && Array.isArray(GameContext.state.battleLog) && GameContext.state.battleLog.length === 0) {
        uiAutoAIFirstDelayDone = false;
    }
    const delayMs = uiAutoAIFirstDelayDone ? 0 : 3000;
    const statusText = delayMs > 0 ? 'NPC: 3秒後自動提交' : 'NPC: 自動提交中';
    const living = uiLivingTeamIds();

    living.forEach((id) => GameContext.stateMachine.setAIStatus(id, 'autoplan', statusText));
    updateDashboardUI(teams[uiCurrentTeamId()]);

    uiAutoAIBattleTimer = setTimeout(() => {
        uiAutoAIBattleTimer = null;
        if (!uiAutoAIFirstDelayDone) uiAutoAIFirstDelayDone = true;
        if (!uiAreBothTeamsAI() || GameContext.isAnimating() || GameContext.isReplayMode()) return;
        living.forEach((id) => uiRunAI(id));
        if (GameContext.areAllLivingReady && GameContext.areAllLivingReady()) {
            if (window.executeTurnSimultaneously) window.executeTurnSimultaneously();
        }
    }, delayMs);
}
/** Kick both-AI loop from scenario boot / external tools (resets first-turn delay). */
function uiKickBothAIBattle(resetFirstDelay = true) {
    if (resetFirstDelay) uiAutoAIFirstDelayDone = false;
    uiScheduleBothAITurn();
}
window.uiKickBothAIBattle = uiKickBothAIBattle;
window.uiScheduleBothAITurn = uiScheduleBothAITurn;
window.uiAreBothTeamsAI = uiAreBothTeamsAI;
function uiFactionHasHuman(faction) {
    return uiLivingTeamIds().some((id) => {
        const t = teams[id];
        return t && !t.aiEnabled && (GameContext.getFaction ? GameContext.getFaction(id) : id) === faction;
    });
}
function uiIsNpcWingman(teamId) {
    const t = teams[teamId];
    if (!t || !t.aiEnabled || t.isDestroyed || t.matchActive === false) return false;
    const faction = GameContext.getFaction ? GameContext.getFaction(teamId) : teamId;
    return uiFactionHasHuman(faction);
}
function uiSetControlsVisible(visible) {
    const wrap = document.getElementById('ui-wrapper');
    if (!wrap) return;
    wrap.classList.toggle('is-controls-hidden', !visible);
}
function uiSyncSelectionChrome(teamId) {
    const id = teamId || uiCurrentTeamId();
    const t = teams[id];
    const showControls = !!(t && !t.aiEnabled && !t.isDestroyed && t.matchActive !== false && !GameContext.isReplayMode() && !GameContext.isAnimating());
    uiSetControlsVisible(showControls);
    uiRefreshWingmanOrderButtons(id);
    uiRefreshTeamModeButtons();
    if (showControls && typeof updateDashboardUI === 'function' && !GameContext.isAnimating()) {
        updateDashboardUI(t);
    }
}
function uiRefreshWingmanOrderButtons(teamId) {
    const hud = document.getElementById('wingman-order-hud');
    if (!hud) return;
    const id = teamId || uiCurrentTeamId();
    const show = uiIsNpcWingman(id) && !GameContext.isReplayMode();
    hud.hidden = !show;
    if (!show) return;
    const t = teams[id];
    const order = (t && t.wingmanOrder) || 'follow';
    hud.querySelectorAll('.wingman-order-btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-order') === order);
    });
}
function uiUpdateWingmanHud() {
    const hud = document.getElementById('wingman-order-hud');
    if (!hud || hud.hidden) return;
    if (typeof camera === 'undefined' || !camera) return;
    const id = uiCurrentTeamId();
    const t = teams[id];
    if (!t || !t.wrapper || !uiIsNpcWingman(id)) {
        hud.hidden = true;
        return;
    }
    const pos = t.wrapper.position.clone();
    pos.project(camera);
    if (pos.z > 1 || pos.x < -1.2 || pos.x > 1.2 || pos.y < -1.2 || pos.y > 1.2) {
        hud.style.visibility = 'hidden';
        return;
    }
    hud.style.visibility = 'visible';
    const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-pos.y * 0.5 + 0.5) * window.innerHeight;
    const frame = hud.querySelector('.wingman-frame');
    const orders = hud.querySelector('.wingman-orders');
    if (frame) {
        frame.style.left = `${x}px`;
        frame.style.top = `${y}px`;
    }
    if (orders) {
        orders.style.left = `${x}px`;
        orders.style.top = `${y}px`;
    }
}
function uiSetWingmanOrder(order) {
    const id = uiCurrentTeamId();
    if (!uiIsNpcWingman(id)) return;
    if (!GameContext.stateMachine.setWingmanOrder(id, order)) return;
    uiRefreshWingmanOrderButtons(id);
    const labels = { follow: '跟隨', attack: '攻擊我的目標', free: '主動進攻', cover: '掩護', break: '脫離' };
    if (typeof showSMSAlert === 'function') {
        showSMSAlert(`${id.toUpperCase()} 指令: ${labels[order] || order}`, '#ffffff');
    }
    // Apply immediately so status/path reflect the new order (don't wait for human Ready).
    const t = teams[id];
    if (t && t.aiEnabled && !t.ready && !t.isDestroyed) {
        uiRunAI(id);
    } else {
        updateDashboardUI(t || teams[uiCurrentTeamId()]);
    }
}
function uiBindWingmanOrderHudOnce() {
    const hud = document.getElementById('wingman-order-hud');
    if (!hud || hud.dataset.bound) return;
    hud.dataset.bound = '1';
    hud.addEventListener('click', (e) => {
        const btn = e.target.closest('.wingman-order-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        uiSetWingmanOrder(btn.getAttribute('data-order'));
    });
}
window.uiSyncSelectionChrome = uiSyncSelectionChrome;
window.uiUpdateWingmanHud = uiUpdateWingmanHud;
window.uiSetWingmanOrder = uiSetWingmanOrder;

function uiTeamLabel(teamId) {
    const t = teams[teamId];
    const seat = teamId === 'red2' ? 'RED-2' : teamId === 'blue2' ? 'BLUE-2'
        : teamId === 'blue' ? 'BLUE-1' : 'RED-1';
    return `${seat} [${t && t.aiEnabled ? 'AI' : 'P'}]`;
}
function uiSeatIds() {
    return ['red', 'red2', 'blue', 'blue2'];
}
function uiIsSeatLive(teamId) {
    const t = teams[teamId];
    return !!(t && t.wrapper && t.matchActive !== false);
}
function uiSelectSeat(teamId) {
    if (!uiIsSeatLive(teamId)) return;
    if (typeof selectTeam === 'function') selectTeam(teamId);
    uiRefreshTeamModeButtons();
    uiRenderTempScorePanel();
}
function uiRefreshTeamModeButtons() {
    const activeId = uiCurrentTeamId();
    uiSeatIds().forEach((id) => {
        const row = document.querySelector(`.team-seat-row[data-team-id="${id}"]`);
        const btn = document.getElementById(`btn-sel-${id}`);
        const live = uiIsSeatLive(id);
        if (row) row.hidden = !live;
        if (!btn) return;
        const faction = (GameContext.getFaction && GameContext.getFaction(id)) || id;
        btn.classList.toggle('faction-red', faction === 'red');
        btn.classList.toggle('faction-blue', faction === 'blue');
        btn.classList.toggle('is-active', live && activeId === id);
        btn.innerText = uiTeamLabel(id);
        btn.title = live
            ? `左鍵選擇 ${id.toUpperCase()}；右鍵或雙擊切換 PLAYER/AI`
            : '座位未啟用';
        btn.disabled = !live;
    });
}
function uiBindSeatControls(teamId) {
    const btnSel = document.getElementById(`btn-sel-${teamId}`);
    const btnEngage = document.getElementById(`btn-engage-${teamId}`);
    if (btnSel) {
        btnSel.addEventListener('click', () => uiSelectSeat(teamId));
        btnSel.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (uiIsSeatLive(teamId)) uiToggleAI(teamId);
        });
        btnSel.addEventListener('dblclick', (e) => {
            e.preventDefault();
            if (uiIsSeatLive(teamId)) uiToggleAI(teamId);
        });
    }
    if (btnEngage) {
        btnEngage.addEventListener('click', () => {
            if (!uiIsSeatLive(teamId)) return;
            const t = teams[teamId];
            if (t && t.aiEnabled) uiToggleAIDebugForTeam(teamId);
            else toggleReadyState(teamId);
        });
    }
}
function toggleReadyState(teamId) {
    let t = teams[teamId];
    if (!t || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed) return;
    if (t.aiEnabled) return;
    if (t.matchActive === false) return;

    const nextReady = !t.ready;
    if (!GameContext.stateMachine.setReady(teamId, nextReady)) return;

    if (nextReady) {
        if (uiCurrentTeamId() === teamId) resetJoystickUI();
    }

    updateDashboardUI(teams[uiCurrentTeamId()]);

    if (nextReady) {
        uiLivingTeamIds().forEach((id) => {
            const ot = teams[id];
            if (ot && ot.aiEnabled && !ot.ready && !ot.isDestroyed) uiRunAI(id);
        });
        if (GameContext.areAllLivingReady && GameContext.areAllLivingReady()) {
            if (window.executeTurnSimultaneously) window.executeTurnSimultaneously();
            return;
        }
        if (uiCurrentTeamId() === teamId) {
            const nextHuman = uiLivingTeamIds().find((id) =>
                teams[id] && !teams[id].aiEnabled && !teams[id].ready && !teams[id].isDestroyed && id !== teamId
            );
            if (nextHuman && window.selectTeam) window.selectTeam(nextHuman);
        }
    }
}
function uiToggleAI(teamId) {
    const t = teams[teamId];
    if (!t || t.ready || GameContext.isAnimating() || GameContext.isReplayMode()) return;
    GameContext.stateMachine.toggleAI(teamId);
    if (!t.aiEnabled && uiAIDebugExpandedTeam === teamId) uiAIDebugExpandedTeam = null;
    uiClearAutoAIBattleTimer();
    uiRefreshTeamModeButtons();
    updateDashboardUI(t);
    uiRefreshPreview(t);
    uiRefreshAIDebugPanel();
    uiRenderTempScorePanel();
    showSMSAlert(
        `${teamId.toUpperCase()} ${t.aiEnabled ? '切換為 NPC AI（已對準對手）' : '切換為玩家控制'}`,
        t.aiEnabled ? '#ffbb00' : '#00ff88'
    );
    if (uiAreBothTeamsAI()) uiScheduleBothAITurn();
}
function uiRunAI(teamId) {
    const t = teams[teamId];
    if (!t || !t.aiEnabled || t.ready || t.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode()) return false;
    if (!window.AirArenaAI) return false;
    const action = window.AirArenaAI.run(teamId);
    uiAppendAIDebugTrace(teamId, action);
    updateDashboardUI(t);
    if (!t.ready) uiRefreshPreview(t);
    uiRefreshAIDebugPanel();
    return !!action;
}
function uiMaybeRunAIAndResolve(teamId) {
    const t = teams[teamId];
    if (!t || !t.aiEnabled || t.ready || t.isDestroyed) return false;
    const didRun = uiRunAI(teamId);
    if (!didRun) return false;
    if (GameContext.areAllLivingReady && GameContext.areAllLivingReady()) {
        if (window.executeTurnSimultaneously) window.executeTurnSimultaneously();
    }
    return true;
}

let uiAIDebugVisible = true;
let uiAIDebugExpandedTeam = null;
const uiTempScoreStorageKey = 'airarena_temp_score_v1';
let uiTempScore = {
    heuristic: 0,
    hybrid: 0,
    logs: []
};

function uiLoadTempScore() {
    try {
        const raw = window.localStorage.getItem(uiTempScoreStorageKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        uiTempScore.heuristic = Number(parsed.heuristic || 0);
        uiTempScore.hybrid = Number(parsed.hybrid || 0);
        uiTempScore.logs = Array.isArray(parsed.logs) ? parsed.logs.slice(0, 12) : [];
    } catch (err) {
        console.warn('[temp-score] load failed', err);
    }
}

function uiSaveTempScore() {
    try {
        window.localStorage.setItem(uiTempScoreStorageKey, JSON.stringify(uiTempScore));
    } catch (err) {
        console.warn('[temp-score] save failed', err);
    }
}

function uiActivePolicyMode() {
    const currentTeam = uiCurrentTeam();
    if (!currentTeam) return 'heuristic';
    return (currentTeam.aiPolicyMode === 'hybrid') ? 'hybrid' : 'heuristic';
}

function uiRenderTempScorePanel() {
    const heuristicEl = document.getElementById('temp-score-heuristic');
    const hybridEl = document.getElementById('temp-score-hybrid');
    const activeModeEl = document.getElementById('temp-score-active-mode');
    const logEl = document.getElementById('temp-score-log');
    if (!heuristicEl || !hybridEl || !activeModeEl || !logEl) return;

    heuristicEl.innerText = String(uiTempScore.heuristic || 0);
    hybridEl.innerText = String(uiTempScore.hybrid || 0);
    const activeMode = uiActivePolicyMode();
    activeModeEl.innerText = `目前模式: ${activeMode.toUpperCase()}`;

    if (!uiTempScore.logs.length) {
        logEl.innerHTML = '<div class="temp-score-log-entry">(尚無記錄)</div>';
        return;
    }
    logEl.innerHTML = uiTempScore.logs.map((entry) => {
        const delta = entry.delta > 0 ? `+${entry.delta}` : `${entry.delta}`;
        return `<div class="temp-score-log-entry">T${entry.turn} ${entry.mode.toUpperCase()} ${delta} ${entry.note ? `| ${entry.note}` : ''}</div>`;
    }).join('');
}

function uiPushTempScoreLog(mode, delta, note = '') {
    uiTempScore.logs.unshift({
        turn: Number(GameContext.state.currentTurn || 1),
        mode,
        delta,
        note: String(note || '').trim().slice(0, 80)
    });
    uiTempScore.logs = uiTempScore.logs.slice(0, 12);
}

function uiAdjustTempScore(mode, delta, note = '') {
    const normalizedMode = mode === 'hybrid' ? 'hybrid' : 'heuristic';
    const step = Number(delta || 0);
    if (!step) return;
    uiTempScore[normalizedMode] = Number(uiTempScore[normalizedMode] || 0) + step;
    uiPushTempScoreLog(normalizedMode, step, note);
    uiSaveTempScore();
    uiRenderTempScorePanel();
}

function uiResetTempScore() {
    uiTempScore = { heuristic: 0, hybrid: 0, logs: [] };
    uiSaveTempScore();
    uiRenderTempScorePanel();
}

function uiFormatTuningMetaLine() {
    const meta = (typeof window !== 'undefined' && window.AIR_ARENA_AI_TUNING_META) ? window.AIR_ARENA_AI_TUNING_META : null;
    if (!meta) return 'TUNING default';
    const sourceRaw = String(meta.source || 'unknown');
    const sourceName = sourceRaw.split(/[\\/]/).pop();
    const generated = meta.generatedAt ? String(meta.generatedAt).replace('T', ' ').replace('Z', ' UTC') : '-';
    return `TUNING ${sourceName} @ ${generated}`;
}

function uiThreatLevelClass(level) {
    if (level === 'high') return 'ai-threat-high';
    if (level === 'medium') return 'ai-threat-medium';
    return 'ai-threat-low';
}

function uiGetAIDebugTeam(teamId) {
    return teamId ? teams[teamId] : null;
}

function uiRoundVec3(pos) {
    if (!pos) return null;
    return { x: Number(pos.x.toFixed(2)), y: Number(pos.y.toFixed(2)), z: Number(pos.z.toFixed(2)) };
}

function uiBuildAIDebugSnapshot(teamId, opts = {}) {
    const team = uiGetAIDebugTeam(teamId);
    if (!team) return null;
    const includeJsonTail = opts.includeJsonTail !== false;
    const action = team.aiLastAction || null;
    const dbg = action && action.debug ? action.debug : null;
    const turn = Number((GameContext && GameContext.state && GameContext.state.currentTurn) || 1);
    const arenaMode = (GameContext && GameContext.getArenaMode) ? GameContext.getArenaMode() : 'buildings';
    const matchCfg = (GameContext && GameContext.getMatchConfig) ? GameContext.getMatchConfig() : null;
    const faction = (GameContext.getFaction && GameContext.getFaction(teamId))
        || (String(teamId).startsWith('blue') ? 'blue' : 'red');
    const control = team.aiEnabled ? 'ai' : 'human';
    const pos = team.wrapper && team.wrapper.position ? team.wrapper.position : null;
    const lockedTargetId = team.lockedTargetId || null;
    const targetId = (GameContext.getTargetId && GameContext.getTargetId(teamId))
        || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(teamId))
        || null;
    const enemyId = targetId
        || (String(teamId).startsWith('red') ? 'blue' : 'red');
    const enemy = teams[enemyId];
    const enemyPos = enemy && enemy.wrapper && enemy.wrapper.position ? enemy.wrapper.position : null;

    let leadId = null;
    let wingmanOrder = team.wingmanOrder || null;
    if (typeof window.AirArenaAI !== 'undefined' && window.AirArenaAI.getWingmanLeadId) {
        leadId = window.AirArenaAI.getWingmanLeadId(teamId);
    }
    if (typeof window.AirArenaAI !== 'undefined' && window.AirArenaAI.getWingmanOrder) {
        wingmanOrder = window.AirArenaAI.getWingmanOrder(teamId);
    }

    const allyIds = (GameContext.getAllyIds && GameContext.getAllyIds(teamId)) || [];
    const hostileIds = (GameContext.getHostileIds && GameContext.getHostileIds(teamId)) || [];
    const allies = allyIds.map((id) => {
        const a = teams[id];
        if (!a) return { id };
        const aPos = a.wrapper && a.wrapper.position ? a.wrapper.position : null;
        return {
            id,
            control: a.aiEnabled ? 'ai' : 'human',
            wingmanOrder: a.wingmanOrder || null,
            state: (a.aiLastAction && a.aiLastAction.state) || null,
            statusText: a.aiStatusText || null,
            hp: a.hp,
            ready: !!a.ready,
            isDestroyed: !!a.isDestroyed,
            distance: (pos && aPos) ? Number(pos.distanceTo(aPos).toFixed(1)) : null
        };
    });
    const hostiles = hostileIds.map((id) => {
        const h = teams[id];
        if (!h) return { id };
        const hPos = h.wrapper && h.wrapper.position ? h.wrapper.position : null;
        return {
            id,
            hp: h.hp,
            ap: h.ap,
            isDestroyed: !!h.isDestroyed,
            distance: (pos && hPos) ? Number(pos.distanceTo(hPos).toFixed(1)) : null
        };
    });

    return {
        schema: 'air-arena-ai-debug-v2',
        exportedAt: new Date().toISOString(),
        turn,
        teamId,
        faction,
        control,
        matchMode: matchCfg ? matchCfg.mode : null,
        enemyId,
        targetId,
        lockedTargetId,
        leadId,
        wingmanOrder,
        arenaMode,
        policyMode: team.aiPolicyMode || 'heuristic',
        manualOverride: team.aiManualOverride || 'auto',
        statusText: team.aiStatusText || null,
        ready: !!team.ready,
        isDestroyed: !!team.isDestroyed,
        matchActive: team.matchActive !== false,
        aircraft: {
            type: team.type || 'mig21',
            ap: team.ap,
            heat: team.heat,
            hp: team.hp,
            stalled: !!team.stalled,
            throttle: team.throttle,
            weapon: team.weapon,
            queuedAction: team.queuedAction || 'none',
            flareAmmo: team.flareAmmo,
            position: uiRoundVec3(pos)
        },
        enemy: enemy ? {
            hp: enemy.hp,
            ap: enemy.ap,
            position: uiRoundVec3(enemyPos),
            distance: (pos && enemyPos) ? Number(pos.distanceTo(enemyPos).toFixed(1)) : null
        } : null,
        allies,
        hostiles,
        action: action ? {
            state: action.state || null,
            statusText: action.statusText || null,
            reason: action.reason || null,
            throttle: action.throttle,
            joyX: action.joyX,
            joyY: action.joyY,
            pitchCmd: action.pitchCmd,
            yawCmd: action.yawCmd,
            roll: action.roll,
            weapon: action.weapon,
            queueAction: action.queueAction || 'none',
            powerPylons: !!action.powerPylons,
            singleMissile: !!action.singleMissile
        } : null,
        debug: dbg ? JSON.parse(JSON.stringify(dbg)) : null,
        tree: dbg && Array.isArray(dbg.tree) ? dbg.tree.slice() : [],
        threatLog: Array.isArray(team.aiThreatLog) ? team.aiThreatLog.slice() : [],
        tuningMeta: (typeof window !== 'undefined' && window.AIR_ARENA_AI_TUNING_META) ? { ...window.AIR_ARENA_AI_TUNING_META } : null,
        _includeJsonTail: includeJsonTail
    };
}

function uiFormatAIDebugText(teamId, opts = {}) {
    const snap = uiBuildAIDebugSnapshot(teamId, opts);
    if (!snap) return `${String(teamId || '').toUpperCase()}: N/A`;
    const includeJsonTail = opts.includeJsonTail !== false && snap._includeJsonTail !== false;
    const lines = [];
    lines.push(`# Air Arena AI Debug Snapshot`);
    lines.push(`schema: ${snap.schema}`);
    lines.push(`exportedAt: ${snap.exportedAt}`);
    lines.push(`turn: ${snap.turn}  match: ${snap.matchMode || '-'}  arena: ${snap.arenaMode}`);
    lines.push(`team: ${snap.teamId}  faction: ${snap.faction}  control: ${snap.control}  ready=${snap.ready} destroyed=${snap.isDestroyed}`);
    lines.push(`target: ${snap.targetId || '-'}  locked: ${snap.lockedTargetId || '-'}  enemy: ${snap.enemyId || '-'}`);
    lines.push(`wingman: order=${snap.wingmanOrder || '-'} lead=${snap.leadId || '-'}`);
    lines.push(`policy: ${snap.policyMode}  override: ${snap.manualOverride}`);
    lines.push(`status: ${snap.statusText || '-'}`);
    if (snap.aircraft) {
        const a = snap.aircraft;
        const p = a.position;
        lines.push(`aircraft: ap=${a.ap} heat=${a.heat} hp=${a.hp} stalled=${a.stalled} thr=${a.throttle} wpn=${a.weapon} queue=${a.queuedAction}`);
        lines.push(`position: ${p ? `x=${p.x} y=${p.y} z=${p.z}` : '-'}`);
    }
    if (snap.enemy) {
        const e = snap.enemy;
        const p = e.position;
        lines.push(`enemy: hp=${e.hp} ap=${e.ap} dist=${e.distance ?? '-'} pos=${p ? `(${p.x},${p.y},${p.z})` : '-'}`);
    }
    if (snap.allies && snap.allies.length) {
        lines.push(`allies: ${snap.allies.map((a) => `${a.id}(${a.control},ord=${a.wingmanOrder || '-'},st=${a.state || '-'},d=${a.distance ?? '-'})`).join(' | ')}`);
    }
    if (snap.hostiles && snap.hostiles.length) {
        lines.push(`hostiles: ${snap.hostiles.map((h) => `${h.id}(hp=${h.hp},d=${h.distance ?? '-'})`).join(' | ')}`);
    }
    if (snap.control === 'human' && !snap.action) {
        lines.push(`action: (human — no AI decide)`);
    } else if (snap.action) {
        const act = snap.action;
        lines.push(`action: ${act.state} | ${act.statusText || act.reason || '-'}`);
        lines.push(`controls: thr=${act.throttle} joyX=${act.joyX} joyY=${act.joyY} pitchCmd=${act.pitchCmd ?? '-'} roll=${act.roll ?? '-'} queue=${act.queueAction}`);
    } else {
        lines.push(`action: (none)`);
    }
    if (snap.debug) {
        const d = snap.debug;
        lines.push(`telemetry: dist=${d.distance} ang=${d.angleDeg} closure=${d.closure} sep=${d.predictedSeparation} headOn=${d.headOn}`);
        lines.push(`sensor: contact=${d.contact} seen=${d.seenNow} mem=${d.memoryTurnsLeft} radar=${d.sensorRadar} visual=${d.sensorVisual} los=${d.sensorLOS} passive=${d.passiveSearchBearing} passiveRange=${d.passiveSearchRange}`);
        lines.push(`threat: level=${d.threatLevel || '-'} score=${d.threatScore} evade=${d.missileThreat} commit=${d.canOffensiveCommit ?? '-'}`);
        if (d.safety) {
            lines.push(`safety: selected=${d.safety.selected} score=${d.safety.score} minAlt=${d.safety.minAlt} ap=${d.safety.finalAP} override=${d.safety.overridden} protected=${d.safety.protected} offensive=${d.safety.offensiveProtected}`);
        }
        if (d.policy) {
            lines.push(`policyEval: mode=${d.policy.mode} selected=${d.policy.selectedState} base=${d.policy.baseState} score=${d.policy.selectedScore} override=${d.policy.overridden}`);
        }
    }
    lines.push(`tuning: ${uiFormatTuningMetaLine()}`);
    lines.push(`tree:`);
    if (snap.tree.length) {
        snap.tree.forEach((line) => lines.push(`- ${line}`));
    } else {
        lines.push(`- (none)`);
    }
    if (snap.threatLog.length) {
        lines.push(`threatLog:`);
        snap.threatLog.forEach((item) => {
            lines.push(`- T${item.turn} ${item.threatLevel || 'low'} D${item.distance} A${item.angleDeg} LOS:${item.losBlocked ? 'MASKED' : 'OPEN'} ${item.flare ? 'FLARE' : 'EVADE'}`);
        });
    }
    if (includeJsonTail) {
        const clean = { ...snap };
        delete clean._includeJsonTail;
        lines.push(`json:`);
        lines.push(JSON.stringify(clean, null, 2));
    }
    return lines.join('\n');
}

function uiActiveMatchIdsForDebug() {
    if (GameContext.getActiveMatchIds) return GameContext.getActiveMatchIds();
    return ['red', 'blue'].filter((id) => teams[id] && teams[id].matchActive !== false);
}

function uiBuildAIRosterSnapshot() {
    const ids = uiActiveMatchIdsForDebug();
    const turn = Number((GameContext && GameContext.state && GameContext.state.currentTurn) || 1);
    const arenaMode = (GameContext && GameContext.getArenaMode) ? GameContext.getArenaMode() : 'buildings';
    const matchCfg = (GameContext && GameContext.getMatchConfig) ? GameContext.getMatchConfig() : null;
    const units = {};
    const rosterSummary = [];
    ids.forEach((id) => {
        const snap = uiBuildAIDebugSnapshot(id, { includeJsonTail: false });
        if (!snap) return;
        const clean = { ...snap };
        delete clean._includeJsonTail;
        units[id] = clean;
        rosterSummary.push({
            id,
            faction: snap.faction,
            control: snap.control,
            ready: snap.ready,
            isDestroyed: snap.isDestroyed,
            hp: snap.aircraft ? snap.aircraft.hp : null,
            ap: snap.aircraft ? snap.aircraft.ap : null,
            wingmanOrder: snap.wingmanOrder,
            leadId: snap.leadId,
            lockedTargetId: snap.lockedTargetId,
            targetId: snap.targetId,
            state: snap.action ? snap.action.state : null,
            statusText: snap.statusText
        });
    });
    return {
        schema: 'air-arena-ai-debug-roster-v1',
        exportedAt: new Date().toISOString(),
        turn,
        matchMode: matchCfg ? matchCfg.mode : null,
        arenaMode,
        unitIds: ids.slice(),
        rosterSummary,
        units
    };
}

function uiFormatAIRosterText(roster) {
    const dump = roster || uiBuildAIRosterSnapshot();
    const lines = [];
    lines.push(`# Air Arena AI Roster Dump`);
    lines.push(`schema: ${dump.schema}`);
    lines.push(`exportedAt: ${dump.exportedAt}`);
    lines.push(`turn: ${dump.turn}  mode: ${dump.matchMode || '-'}  arena: ${dump.arenaMode}`);
    lines.push(`## Roster`);
    (dump.rosterSummary || []).forEach((r) => {
        lines.push(
            `- ${String(r.id).toUpperCase()}  ${r.faction}  ${String(r.control).toUpperCase()}` +
            `  ready=${r.ready} destroyed=${r.isDestroyed}` +
            `  hp=${r.hp ?? '-'} ap=${r.ap ?? '-'}` +
            `  order=${r.wingmanOrder || '-'} lead=${r.leadId || '-'}` +
            `  target=${r.targetId || '-'} locked=${r.lockedTargetId || '-'}` +
            `  state=${r.state || '-'}  ${r.statusText || ''}`
        );
    });
    (dump.unitIds || []).forEach((id) => {
        lines.push('');
        lines.push(`## ${String(id).toUpperCase()}`);
        lines.push(uiFormatAIDebugText(id, { includeJsonTail: false }));
    });
    return lines.join('\n');
}

async function uiExportAllAIDebug() {
    const roster = uiBuildAIRosterSnapshot();
    if (!roster.unitIds || !roster.unitIds.length) {
        showSMSAlert('沒有可匯出的參戰機', '#ffbb00');
        return false;
    }
    const text = uiFormatAIRosterText(roster);
    const turn = roster.turn || 0;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ai-debug-roster-T${turn}-${stamp}.json`;
    try {
        await uiCopyTextToClipboard(text);
        uiDownloadTextFile(filename, JSON.stringify(roster, null, 2), 'application/json;charset=utf-8');
        showSMSAlert(`全機決策已複製 + 下載 (${roster.unitIds.length}機)`, '#00ff88');
        return true;
    } catch (err) {
        console.error('[ai-debug] export-all failed', err);
        try {
            uiDownloadTextFile(filename, JSON.stringify(roster, null, 2), 'application/json;charset=utf-8');
            showSMSAlert('複製失敗，已改下載 JSON', '#ffbb00');
            return true;
        } catch (err2) {
            showSMSAlert('全機決策匯出失敗', '#ff5555');
            return false;
        }
    }
}

function uiCopyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            resolve();
        } catch (err) {
            reject(err);
        } finally {
            document.body.removeChild(ta);
        }
    });
}

function uiDownloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function uiAIDebugFilename(teamId, suffix, ext) {
    const turn = Number((GameContext && GameContext.state && GameContext.state.currentTurn) || 0);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `ai-debug-${teamId}-T${turn}-${suffix}-${stamp}.${ext}`;
}

function uiAppendAIDebugTrace(teamId, action) {
    const team = uiGetAIDebugTeam(teamId);
    if (!team || !team.aiDebugRecording || !action) return;
    if (!Array.isArray(team.aiDebugTrace)) team.aiDebugTrace = [];
    const snap = uiBuildAIDebugSnapshot(teamId);
    if (!snap) return;
    const clean = { ...snap };
    delete clean._includeJsonTail;
    team.aiDebugTrace.push(clean);
    if (team.aiDebugTrace.length > 600) team.aiDebugTrace.shift();
}

function uiRefreshAIDebugRecordControls() {
    const teamId = uiAIDebugExpandedTeam;
    const team = uiGetAIDebugTeam(teamId);
    const btnRecord = document.getElementById('btn-ai-debug-record');
    const btnDownloadTrace = document.getElementById('btn-ai-debug-download-trace');
    const status = document.getElementById('ai-debug-record-status');
    const recording = !!(team && team.aiDebugRecording);
    const count = team && Array.isArray(team.aiDebugTrace) ? team.aiDebugTrace.length : 0;
    if (btnRecord) btnRecord.textContent = recording ? '停止錄製' : '開始錄製';
    if (btnDownloadTrace) btnDownloadTrace.disabled = count === 0;
    if (status) status.textContent = `錄製: ${recording ? 'ON' : 'OFF'} (${count})`;
}

async function uiCopyAIDebugSnapshot() {
    const teamId = uiAIDebugExpandedTeam;
    if (!teamId) {
        showSMSAlert('請先展開 RED/BLUE 的 AI 決策樹', '#ffbb00');
        return;
    }
    const text = uiFormatAIDebugText(teamId);
    try {
        await uiCopyTextToClipboard(text);
        showSMSAlert(`${teamId.toUpperCase()} 決策樹已複製`, '#00ff88');
    } catch (err) {
        console.error('[ai-debug] copy failed', err);
        showSMSAlert('複製失敗，請改用下載 JSON', '#ff5555');
    }
}

function uiDownloadAIDebugSnapshot() {
    const teamId = uiAIDebugExpandedTeam;
    if (!teamId) {
        showSMSAlert('請先展開 RED/BLUE 的 AI 決策樹', '#ffbb00');
        return;
    }
    const snap = uiBuildAIDebugSnapshot(teamId);
    if (!snap) return;
    const clean = { ...snap };
    delete clean._includeJsonTail;
    uiDownloadTextFile(uiAIDebugFilename(teamId, 'snapshot', 'json'), JSON.stringify(clean, null, 2), 'application/json;charset=utf-8');
}

function uiToggleAIDebugRecording() {
    const teamId = uiAIDebugExpandedTeam;
    const team = uiGetAIDebugTeam(teamId);
    if (!team) {
        showSMSAlert('請先展開 RED/BLUE 的 AI 決策樹', '#ffbb00');
        return;
    }
    team.aiDebugRecording = !team.aiDebugRecording;
    if (team.aiDebugRecording && !Array.isArray(team.aiDebugTrace)) team.aiDebugTrace = [];
    uiRefreshAIDebugRecordControls();
    showSMSAlert(`${teamId.toUpperCase()} 決策錄製 ${team.aiDebugRecording ? '開始' : '停止'}`, team.aiDebugRecording ? '#00ff88' : '#ffbb00');
}

function uiDownloadAIDebugTrace() {
    const teamId = uiAIDebugExpandedTeam;
    const team = uiGetAIDebugTeam(teamId);
    if (!teamId || !team || !Array.isArray(team.aiDebugTrace) || !team.aiDebugTrace.length) {
        showSMSAlert('沒有可下載的錄製內容', '#ffbb00');
        return;
    }
    const payload = {
        schema: 'air-arena-ai-debug-trace-v1',
        exportedAt: new Date().toISOString(),
        teamId,
        frames: team.aiDebugTrace
    };
    uiDownloadTextFile(uiAIDebugFilename(teamId, 'trace', 'json'), JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
}

function uiThreatLogHtml(team) {
    const logs = Array.isArray(team.aiThreatLog) ? team.aiThreatLog.slice(0, 6) : [];
    if (!logs.length) return '<div class="ai-threat-log"><div class="ai-threat-title">THREAT LOG</div><div class="ai-threat-empty">(none)</div></div>';
    const rows = logs.map((item) => {
        const level = item.threatLevel || 'low';
        const sev = (typeof item.threatScore === 'number') ? item.threatScore.toFixed(2) : '-';
        const los = item.losBlocked ? 'MASKED' : 'OPEN';
        const dist = (item.distance !== undefined && item.distance !== null) ? item.distance : '-';
        const ang = (item.angleDeg !== undefined && item.angleDeg !== null) ? item.angleDeg : '-';
        const asp = (item.enemyAspectDeg !== undefined && item.enemyAspectDeg !== null) ? item.enemyAspectDeg : '-';
        const cover = (item.coverDistance !== undefined && item.coverDistance !== null) ? item.coverDistance : '-';
        const mask = (item.maskScore !== undefined && item.maskScore !== null) ? item.maskScore : '-';
        return `<div class="ai-threat-entry ${uiThreatLevelClass(level)}">` +
            `<span class="ai-threat-badge">${level.toUpperCase()}</span>` +
            `T${item.turn} ${item.flare ? 'FLARE' : 'EVADE'} D${dist} A${ang} ASP${asp} LOS:${los} CVR:${cover} MASK:${mask} ${item.maskState || 'none'} R:${item.collisionRisk || 'low'} S:${sev}` +
            `</div>`;
    }).join('');
    return `<div class="ai-threat-log"><div class="ai-threat-title">THREAT LOG</div>${rows}</div>`;
}

function uiFormatAIDebug(teamId) {
    const t = teams[teamId];
    if (!t) return `${teamId.toUpperCase()}: N/A`;
    if (!t.aiEnabled) return `<div>${teamId.toUpperCase()}: PLAYER</div>`;

    const action = t.aiLastAction;
    const dbg = action && action.debug ? action.debug : null;
    if (!dbg) return `<div>${teamId.toUpperCase()}: ${t.aiStatusText || 'NPC: 待機中'}</div>${uiThreatLogHtml(t)}`;

    const treeText = Array.isArray(dbg.tree) ? `- ${dbg.tree.join('\n- ')}` : '(none)';
    const threatLevelClass = uiThreatLevelClass(dbg.threatLevel || (dbg.missileThreat ? 'medium' : 'low'));
    const safety = dbg.safety || {};
    const policy = dbg.policy || {};
    return `<div>${teamId.toUpperCase()} | ${t.aiStatusText || dbg.mode || 'NPC'}</div>` +
        `<div>DST ${dbg.distance}m  ANG ${dbg.angleDeg}°</div>` +
        `<div>CLS ${dbg.closure}  SEP ${dbg.predictedSeparation}m</div>` +
        `<div>HEAD ${dbg.headOn}  THR ${action.throttle || '-'}  ${(action.weapon || 'gun').toUpperCase()}</div>` +
        `<div>SENSOR CONTACT ${dbg.contact ? 'YES' : 'NO'}  LIVE ${dbg.seenNow ? 'YES' : 'NO'}  MEM ${dbg.memoryTurnsLeft ?? 0}T  RADAR ${dbg.sensorRadar ? 'YES' : 'NO'}  VIS ${dbg.sensorVisual ? 'YES' : 'NO'}  LOS ${dbg.sensorLOS ? 'MASKED' : 'OPEN'}</div>` +
        `<div>LOCAL TARGET X ${dbg.targetLocalX ?? '-'}  Y ${dbg.targetLocalY ?? '-'}  Z ${dbg.targetLocalZ ?? '-'}</div>` +
        `<div>MSL-LOCK ${dbg.missileLock ? 'YES' : 'NO'}  RNG ${dbg.missileLockRange ?? '-'}m  ANG ${dbg.missileLockAngleDeg ?? '-'}°</div>` +
        `<div class="ai-threat-inline ${threatLevelClass}">MSL-THREAT ${(dbg.threatLevel || (dbg.missileThreat ? 'medium' : 'low')).toUpperCase()}  SCORE ${typeof dbg.threatScore === 'number' ? dbg.threatScore.toFixed(2) : '-'}  LOS ${dbg.losBlocked ? 'MASKED' : 'OPEN'}  EN-ASP ${dbg.enemyAspectDeg ?? '-'}°</div>` +
        `<div>COVER-DIST ${dbg.coverDistance ?? '-'}m  FWD ${dbg.coverForwardDistance ?? '-'}m  COLLISION-RISK ${(dbg.collisionRisk || 'low').toUpperCase()}  COVER-MODE ${(dbg.coverMode || 'clear').toUpperCase()}</div>` +
        `<div>MASK-SCORE ${dbg.maskScore ?? '-'}  MASK-DIST ${dbg.maskDistance ?? '-'}m  MASK-STATE ${(dbg.maskState || 'none').toUpperCase()}  PATH ${dbg.maskPathBlocked ? 'BLOCKED' : 'CLEAR'}  SAFE ${dbg.terrainSafeForMask ? 'YES' : 'NO'}</div>` +
        `<div>MASK-POINT ${dbg.maskPoint ? `(${dbg.maskPoint.x}, ${dbg.maskPoint.y}, ${dbg.maskPoint.z})` : '-'}</div>` +
        `<div>${uiFormatTuningMetaLine()}</div>` +
        `<div>POLICY ${(t.aiPolicyMode || 'heuristic').toUpperCase()}  PICK ${(policy.selectedState || dbg.mode || '-').toUpperCase()}  BASE ${(policy.baseState || '-').toUpperCase()}  SCORE ${policy.selectedScore ?? '-'}  OVERRIDE ${policy.overridden ? 'YES' : 'NO'}</div>` +
        `<div>SAFETY ${safety.overridden ? 'OVERRIDE' : 'OK'}  SEL ${(safety.selected || '-').toUpperCase()}  MINALT ${safety.minAlt ?? '-'}  AP ${safety.finalAP ?? '-'}  BLDG ${safety.buildingHit ? 'HIT' : 'CLEAR'}  FWDY ${safety.finalForwardY ?? '-'}  LOOP ${safety.climbLoopRisk ? 'YES' : 'NO'}</div>` +
        `<div>OVR ${(t.aiManualOverride || 'auto').toUpperCase()}  FLARE ${dbg.flareReserve ?? '-'}  CD ${dbg.flareCooldown ? 'WAIT' : 'READY'}  ACT-MSL ${dbg.actualMissileThreat ? 'YES' : 'NO'}</div>` +
        `<div>TREE:</div><div class="ai-tree">` + treeText + `</div>` +
        uiThreatLogHtml(t);
}
function uiPositionAIDebugPanel(teamId) {
    const panel = document.getElementById('ai-debug-panel');
    const anchor = document.getElementById(`btn-engage-${teamId}`);
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 420;
    const viewportWidth = window.innerWidth;
    let left = rect.left + (rect.width / 2) - (panelWidth / 2);
    left = Math.max(8, Math.min(viewportWidth - panelWidth - 8, left));
    panel.style.left = `${left}px`;
    panel.style.top = `${rect.bottom + 8}px`;
}
function uiRefreshAIDebugPanel() {
    const panel = document.getElementById('ai-debug-panel');
    const body = document.getElementById('ai-debug-body');
    const btnToggle = document.getElementById('btn-toggle-ai-debug');
    const title = document.getElementById('ai-debug-title');
    const content = document.getElementById('ai-debug-content');
    const overrideSelect = document.getElementById('ai-override-active');
    const policyModeSelect = document.getElementById('ai-policy-mode');
    if (!panel || !body || !btnToggle || !title || !content || !overrideSelect || !policyModeSelect) return;

    const teamId = uiAIDebugExpandedTeam;
    const team = teamId ? teams[teamId] : null;
    const isOpen = !!(teamId && team && team.aiEnabled);

    panel.style.display = isOpen ? 'block' : 'none';
    if (!isOpen) return;

    body.style.display = uiAIDebugVisible ? 'grid' : 'none';
    btnToggle.innerText = uiAIDebugVisible ? '隱藏' : '顯示';
    title.innerText = `${teamId.toUpperCase()} NPC 決策樹`;
    content.innerHTML = uiFormatAIDebug(teamId);
    overrideSelect.value = team.aiManualOverride || 'auto';
    policyModeSelect.value = team.aiPolicyMode || 'heuristic';
    uiRefreshAIDebugRecordControls();
    uiPositionAIDebugPanel(teamId);
}
function uiToggleAIDebugPanel() {
    uiAIDebugVisible = !uiAIDebugVisible;
    uiRefreshAIDebugPanel();
}
function uiApplyAIOverride(mode) {
    if (!uiAIDebugExpandedTeam) return;
    const teamId = uiAIDebugExpandedTeam;
    GameContext.stateMachine.setAIManualOverride(teamId, mode);
    uiRefreshAIDebugPanel();
    const t = teams[teamId];
    if (t && t.aiEnabled && !t.ready) {
        uiRunAI(teamId);
    }
}
function uiApplyAIPolicyMode(mode) {
    if (!uiAIDebugExpandedTeam) return;
    const teamId = uiAIDebugExpandedTeam;
    GameContext.stateMachine.setAIPolicyMode(teamId, mode);
    uiRefreshAIDebugPanel();
    const t = teams[teamId];
    if (t && t.aiEnabled) {
        uiRefreshPreview(t);
        if (!t.ready) uiRunAI(teamId);
    }
    uiRenderTempScorePanel();
}
function uiToggleAIDebugForTeam(teamId) {
    const t = teams[teamId];
    if (!t || !t.aiEnabled) return;
    if (uiAIDebugExpandedTeam === teamId) {
        uiAIDebugExpandedTeam = null;
    } else {
        uiAIDebugExpandedTeam = teamId;
        uiAIDebugVisible = true;
    }
    uiRefreshAIDebugPanel();
}

function uiArenaModeStatus(mode) {
    const arenaMode = GameContext && GameContext.sanitizeArenaMode ? GameContext.sanitizeArenaMode(mode) : 'buildings';
    if (arenaMode === 'blank') return '建築物: OFF / 碰撞: OFF / AI障礙: OFF';
    if (arenaMode === 'visual-only') return '建築物: ON / 碰撞: OFF / AI障礙: OFF';
    if (arenaMode === 'sparse-urban') return '建築物: 稀疏 / 碰撞: ON / AI障礙: ON';
    if (arenaMode === 'medium-urban') return '建築物: 中等 / 碰撞: ON / AI障礙: ON';
    if (arenaMode === 'dense-urban' || arenaMode === 'buildings') return '建築物: 密集 / 碰撞: ON / AI障礙: ON';
    if (arenaMode === 'obstacle-stress') return '建築物: ON / 碰撞: ON / AI障礙: ON / 壓力測試';
    return '建築物: ON / 碰撞: ON / AI障礙: ON';
}

function uiApplyDevPanelVisibility() {
    const dev = !!(CONFIG && CONFIG.debug);
    ['arena-mode-panel', 'temp-score-panel'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = dev ? '' : 'none';
    });
    const aiPanel = document.getElementById('ai-debug-panel');
    if (aiPanel) aiPanel.style.display = '';
}

function uiRefreshArenaModePanel() {
    const select = document.getElementById('arena-mode-select');
    const status = document.getElementById('arena-mode-status');
    if (!select || !status || !GameContext) return;
    const mode = GameContext.getArenaMode ? GameContext.getArenaMode() : (GameContext.state && GameContext.state.arenaMode) || 'buildings';
    select.value = mode;
    status.textContent = uiArenaModeStatus(mode);
}

function uiApplyArenaMode(mode) {
    if (!GameContext || !GameContext.setArenaMode) return;
    const applied = GameContext.setArenaMode(mode);
    uiRefreshArenaModePanel();
    if (CONFIG.debug) console.log(`[UI] 場地模式切換: ${applied}`);
}

let isDraggingJoystick = false;
let isDraggingRollRing = false;
let initialMouseAngle = 0; 
let initialRingRoll = 0;   
window.lastRenderedTeamId = null;

document.addEventListener("DOMContentLoaded", () => {
    uiApplyDevPanelVisibility();
    if (CONFIG.debug) console.log("✈️ UI Manager initialized.");

    uiSeatIds().forEach((id) => uiBindSeatControls(id));
    uiBindWingmanOrderHudOnce();
    uiSetControlsVisible(false);
    uiRefreshTeamModeButtons();

    const btnToggleAIDebug = document.getElementById('btn-toggle-ai-debug');
    if (btnToggleAIDebug) btnToggleAIDebug.addEventListener('click', uiToggleAIDebugPanel);
    const btnAIDebugCopy = document.getElementById('btn-ai-debug-copy');
    if (btnAIDebugCopy) btnAIDebugCopy.addEventListener('click', () => { uiCopyAIDebugSnapshot(); });
    const btnAIDebugDownload = document.getElementById('btn-ai-debug-download');
    if (btnAIDebugDownload) btnAIDebugDownload.addEventListener('click', () => { uiDownloadAIDebugSnapshot(); });
    const btnAIDebugRecord = document.getElementById('btn-ai-debug-record');
    if (btnAIDebugRecord) btnAIDebugRecord.addEventListener('click', () => { uiToggleAIDebugRecording(); });
    const btnAIDebugDownloadTrace = document.getElementById('btn-ai-debug-download-trace');
    if (btnAIDebugDownloadTrace) btnAIDebugDownloadTrace.addEventListener('click', () => { uiDownloadAIDebugTrace(); });
    const btnAIDebugExportAll = document.getElementById('btn-ai-debug-export-all');
    if (btnAIDebugExportAll) btnAIDebugExportAll.addEventListener('click', () => { uiExportAllAIDebug(); });
    const overrideActive = document.getElementById('ai-override-active');
    if (overrideActive) overrideActive.addEventListener('change', (e) => uiApplyAIOverride(e.target.value));
    const policyModeActive = document.getElementById('ai-policy-mode');
    if (policyModeActive) policyModeActive.addEventListener('change', (e) => uiApplyAIPolicyMode(e.target.value));
    const arenaModeSelect = document.getElementById('arena-mode-select');
    if (arenaModeSelect) arenaModeSelect.addEventListener('change', (e) => uiApplyArenaMode(e.target.value));
    uiRefreshArenaModePanel();
    uiLoadTempScore();
    document.querySelectorAll('.temp-score-btn[data-score-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-score-mode') || 'heuristic';
            const delta = Number(btn.getAttribute('data-score-delta') || 0);
            uiAdjustTempScore(mode, delta, 'manual');
        });
    });
    const btnScoreActivePlus = document.getElementById('btn-temp-score-active-plus');
    if (btnScoreActivePlus) btnScoreActivePlus.addEventListener('click', () => uiAdjustTempScore(uiActivePolicyMode(), 1, 'active-mode'));
    const btnScoreActiveMinus = document.getElementById('btn-temp-score-active-minus');
    if (btnScoreActiveMinus) btnScoreActiveMinus.addEventListener('click', () => uiAdjustTempScore(uiActivePolicyMode(), -1, 'active-mode'));
    const btnScoreReset = document.getElementById('btn-temp-score-reset');
    if (btnScoreReset) btnScoreReset.addEventListener('click', () => uiResetTempScore());
    const btnScoreNote = document.getElementById('btn-temp-score-note');
    const scoreNoteInput = document.getElementById('temp-score-note');
    if (btnScoreNote && scoreNoteInput) {
        btnScoreNote.addEventListener('click', () => {
            const note = String(scoreNoteInput.value || '').trim();
            if (!note) return;
            uiPushTempScoreLog(uiActivePolicyMode(), 0, note);
            uiSaveTempScore();
            uiRenderTempScorePanel();
            scoreNoteInput.value = '';
        });
    }
    uiRenderTempScorePanel();
    window.addEventListener('resize', () => uiRefreshAIDebugPanel());
    uiRefreshAIDebugPanel();

    // 🚀 全新節流閥：5 檔磁吸滑軌控制
    const thrTrack = document.getElementById('throttle-track');
    const thrHandle = document.getElementById('throttle-handle');
    let isDraggingThrottle = false;

    if (thrTrack && thrHandle) {
        const updateThrottleLogic = (clientY) => {
            let currentTeam = uiCurrentTeamId();
            let t = teams[currentTeam]; 
            if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return;
            
            const rect = thrTrack.getBoundingClientRect();
            let percent = 1.0 - ((clientY - rect.top) / rect.height);
            percent = Math.max(0, Math.min(1, percent));

            // 🟢 5 檔磁吸邊界計算
            let newLevel = 4; // 預設 MIL (4檔)
            if (percent > 0.9) newLevel = 5;      // AB
            else if (percent > 0.7) newLevel = 4; // MIL
            else if (percent > 0.45) newLevel = 3; // ECO
            else if (percent > 0.2) newLevel = 2; // IDL
            else newLevel = 1;                    // BRK (空氣減速板)

            // 後燃器過熱保險鎖定
            if (newLevel === 5 && t.heat > 40) {
                newLevel = 4; 
                showSMSAlert("🛑 溫度過高：必須低於 40°C 才能點火後燃器！", "#ff0055");
            }

            if (t.throttle !== newLevel) {
                if (!GameContext.stateMachine.setThrottle(currentTeam, newLevel)) return;
                updateDashboardUI(t); // 自動吸附定位
                uiRefreshPreview(t);
            }
        };

        thrHandle.addEventListener('mousedown', (e) => { isDraggingThrottle = true; });
        window.addEventListener('mousemove', (e) => { if (isDraggingThrottle) updateThrottleLogic(e.clientY); });
        window.addEventListener('mouseup', () => { isDraggingThrottle = false; });

        thrHandle.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); isDraggingThrottle = true; }, { passive: false });
        window.addEventListener('touchmove', (e) => { 
            if (isDraggingThrottle) {
                if (e.cancelable) e.preventDefault();
                let touch = Array.from(e.touches).find(evt => evt.target.closest('#throttle-track') || evt.target === thrHandle);
                if (touch) updateThrottleLogic(touch.clientY);
            }
        }, { passive: false });
        window.addEventListener('touchend', () => { isDraggingThrottle = false; });
    }

    // 🌟 SMS 武器切換
    let smsContent = document.getElementById('sms-text-content');
    if(smsContent) smsContent.addEventListener('click', () => {
        let currentTeam = uiCurrentTeamId();
        let t = teams[currentTeam]; 
        if (!t || t.aiEnabled || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed || t.ready) return;
        
        const nextWeapon = GameContext.stateMachine.toggleWeaponMode(currentTeam);
        if (nextWeapon === 'missile') {
            showSMSAlert("🚀 FOX-2 飛彈系統通電中... [請點擊掛架開機]", "#ffbb00");
        } else {
            showSMSAlert("⚠️ 主保險關閉：切換至機砲模式", "#ff0055");
        }
        updateDashboardUI(t); 
        uiRefreshPreview(t);
    });

    // 🌟 掛架控制
    document.querySelectorAll('.pylon-switch-wrapper').forEach(el => {
        el.addEventListener('click', (e) => {
            let currentTeam = uiCurrentTeamId();
            let t = teams[currentTeam]; 
            if (!t || t.aiEnabled || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed || t.ready) return;
            
            if (t.weapon !== 'missile') { showSMSAlert("⚠️ 錯誤：請先將 SMS 切換至飛彈模式", "#ffcc00"); return; }
            if (!t.pylons) { showSMSAlert("🛑 掛架系統尚未初始化", "#ff0055"); return; }
            let pylonId = parseInt(e.currentTarget.getAttribute('data-pylon'));
            let p = t.pylons.find(item => item.id === pylonId);
            if (!p || p.state === 'empty') { showSMSAlert("🛑 警告：該掛架彈藥耗盡", "#ff0055"); return; }
            const nextState = GameContext.stateMachine.togglePylonPower(currentTeam, pylonId);
            if (nextState === 'powering') showSMSAlert(`⚡ PYLON ${pylonId} 開始開機通電`, "#ffbb00");
            else if (nextState === 'standby') showSMSAlert(`ℹ️ PYLON ${pylonId} 電源切斷`, "#aaa");
            updateDashboardUI(t); 
            uiRefreshPreview(t);
        });
    });

    // 🌟 武器確認發射
    let btnEnt = document.getElementById('sms-enter-btn');
    if(btnEnt) btnEnt.addEventListener('click', () => {
        let currentTeam = uiCurrentTeamId();
        let t = teams[currentTeam]; 
        if (!t || t.aiEnabled || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed || t.ready) return;
        
        if (t.weapon === 'gun') {
            const wasQueued = t.wpnQueued && t.queuedAction === 'gun';
            GameContext.stateMachine.toggleGunQueue(currentTeam);
            showSMSAlert(wasQueued ? "⚠️ 機砲保險已關閉" : "⚡ 機砲射擊線已通電", wasQueued ? "#aaa" : "#00ff88");
        } else {
            let armedCount = t.pylons ? t.pylons.filter(item => item.state === 'armed').length : 0;
            let poweringCount = t.pylons ? t.pylons.filter(item => item.state === 'powering').length : 0;
            if (armedCount > 0) {
                const wasQueued = t.wpnQueued && t.queuedAction === 'missile';
                GameContext.stateMachine.toggleMissileQueue(currentTeam);
                showSMSAlert(wasQueued ? "⚠️ 飛彈發射排程已取消" : `⚡ 飛彈排程鎖定 (${armedCount} 枚)`, wasQueued ? "#aaa" : "#00ffff");
            } else if (poweringCount > 0) { showSMSAlert("🛑 尋標頭開機中！", "#ffbb00");
            } else { GameContext.stateMachine.clearQueuedAction(currentTeam); showSMSAlert("🛑 無掛架就緒", "#ff0055"); }
        }
        updateDashboardUI(t); 
        uiRefreshPreview(t);
    });

    // 🌟 頂部 Flare 釋放與武裝事件
    const btnFlare = document.getElementById('btn-flare');
    if (btnFlare) {
        btnFlare.addEventListener('click', () => {
            let currentTeam = uiCurrentTeamId();
            let t = teams[currentTeam]; 
            if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return;
            
            if (t.flareAmmo <= 0) { showSMSAlert("🛑 FLARE EMPTY", "#ff0055"); return; }
            const wasArmed = t.flaresArmed;
            GameContext.stateMachine.toggleFlares(currentTeam);
            showSMSAlert(wasArmed ? "⚠️ 熱焰彈解除" : "🔆 熱焰彈排程中", wasArmed ? "#aaa" : "#ff9800");
            updateDashboardUI(t); 
            uiRefreshPreview(t);
        });
    }

    // 🌟 搖桿觸控事件
    const joyZone = document.getElementById('joystick-zone');
    if (joyZone) {
        joyZone.addEventListener('mousedown', startJoystickDrag); window.addEventListener('mousemove', doJoystickDrag); window.addEventListener('mouseup', endJoystickDrag);
        joyZone.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); startJoystickDrag(e.touches[0]); }, { passive: false }); 
        window.addEventListener('touchmove', (e) => { if (isDraggingJoystick) { if (e.cancelable) e.preventDefault(); doJoystickDrag(e.touches[0]); } }, { passive: false }); 
        window.addEventListener('touchend', endJoystickDrag);
    }

    // 🌟 滾轉輪 (Roll Ring) 觸控與旋轉
    const rollRing = document.getElementById('roll-ring'); const staticCenter = document.getElementById('control-assembly-center'); 
    if (rollRing && staticCenter) {
        function startRoll(clientX, clientY, e) {
            let currentTeam = uiCurrentTeamId();
            let t = teams[currentTeam]; 
            if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return;
            
            isDraggingRollRing = true; if(e && e.stopPropagation) e.stopPropagation(); 
            const rect = staticCenter.getBoundingClientRect(); initialMouseAngle = Math.atan2(clientX - (rect.left + rect.width / 2), -(clientY - (rect.top + rect.height / 2)));
            initialRingRoll = t.pendingRoll !== 0 ? t.pendingRoll : (t.roll || 0);
        }
        function doRoll(clientX, clientY) {
            if (!isDraggingRollRing) return; 
            let currentTeam = uiCurrentTeamId();
            let t = teams[currentTeam]; if (!t) return;
            
            const rect = staticCenter.getBoundingClientRect(); let currentMouseAngle = Math.atan2(clientX - (rect.left + rect.width / 2), -(clientY - (rect.top + rect.height / 2)));
            let deltaAngle = currentMouseAngle - initialMouseAngle; if (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2; if (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
            let angle = initialRingRoll + deltaAngle;
            if (!GameContext.stateMachine.setRollInput(currentTeam, angle)) return;
            angle = t.pendingRoll || 0;
            
            rollRing.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`; 
            uiRefreshPreview(t);
        }
        function endRoll() { isDraggingRollRing = false; }

        rollRing.addEventListener('mousedown', (e) => startRoll(e.clientX, e.clientY, e));
        window.addEventListener('mousemove', (e) => doRoll(e.clientX, e.clientY));
        window.addEventListener('mouseup', endRoll);
        rollRing.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); startRoll(e.touches[0].clientX, e.touches[0].clientY, e); }, { passive: false });
        window.addEventListener('touchmove', (e) => { if (isDraggingRollRing) { if (e.cancelable) e.preventDefault(); doRoll(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
        window.addEventListener('touchend', endRoll);
    }

    window.updateDashboardUI = updateDashboardUI;
});

function startJoystickDrag(e) { 
    let currentTeam = uiCurrentTeamId(); 
    let t = teams[currentTeam]; 
    if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return;
    if (window.isDraggingLcosRing) return;
    isDraggingJoystick = true; updateJoystickPosition(e); 
}
function doJoystickDrag(e) { if (!isDraggingJoystick) return; updateJoystickPosition(e); }
function endJoystickDrag() { isDraggingJoystick = false; }

function updateJoystickPosition(e) {
    const joyZone = document.getElementById('joystick-zone'); const joyHandle = document.getElementById('joystick-handle');
    if (!joyZone || !joyHandle) return;
    const rect = joyZone.getBoundingClientRect(); const centerX = rect.left + rect.width / 2; const centerY = rect.top + rect.height / 2; const maxRadius = rect.width / 2 - 15; 
    let dx = e.clientX - centerX; let dy = e.clientY - centerY; let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxRadius) { dx = (dx / dist) * maxRadius; dy = (dy / dist) * maxRadius; dist = maxRadius; }
    joyHandle.style.transform = `translate(${dx}px, ${dy}px)`;
    let currentTeam = uiCurrentTeamId();
    let t = teams[currentTeam];
    if (t) { 
        if (t.aiEnabled) return;
        GameContext.stateMachine.setJoystickInput(currentTeam, dx / maxRadius, -dy / maxRadius);
        uiRefreshPreview(t); 
    }
}

function resetJoystickUI() { const joyHandle = document.getElementById('joystick-handle'); if (joyHandle) joyHandle.style.transform = `translate(0px, 0px)`; }


function updateDashboardUI(teamObj) {
    let currentTeam = uiCurrentTeamId();
    if (!teamObj || teamObj.id !== currentTeam) return;

    // 🚀 5 檔磁吸滑動位置
    let handle = document.getElementById('throttle-handle');
    if (handle) {
        if (teamObj.throttle === 5) handle.style.top = '0%';
        else if (teamObj.throttle === 4) handle.style.top = '25%';
        else if (teamObj.throttle === 3) handle.style.top = '50%';
        else if (teamObj.throttle === 2) handle.style.top = '75%';
        else handle.style.top = '100%';
    }

    // 將各個文字檔亮燈
    document.querySelectorAll('#throttle-track .thr-mark').forEach((el, index) => {
        let level = 5 - index;
        if (teamObj.throttle === level) {
            el.classList.add('mark-active');
        } else {
            el.classList.remove('mark-active');
        }
    });

    let baseAp = (typeof teamObj.ap === 'number' && !isNaN(teamObj.ap)) ? teamObj.ap : 120;
    let costAp = (typeof teamObj.previewCostAp === 'number' && !isNaN(teamObj.previewCostAp)) ? teamObj.previewCostAp : 0;
    let previewAp = Math.max(0, baseAp - costAp);

    let baseHeat = (typeof teamObj.heat === 'number' && !isNaN(teamObj.heat)) ? teamObj.heat : 0;
    let accHeat = (typeof teamObj.previewAccumHeat === 'number' && !isNaN(teamObj.previewAccumHeat)) ? teamObj.previewAccumHeat : 0;
    let previewHeat = Math.min(100, baseHeat + accHeat);

    let apVal = document.getElementById('hud-val-ap'); let apNeedle = document.getElementById('needle-ap');
    if (apVal) apVal.innerText = Math.floor(previewAp);
    // 🌟 解鎖 AP 指針上限到 250
    if (apNeedle) {
        let maxGaugeAP = 250; let deg = -90 + (previewAp / maxGaugeAP) * 180; if (isNaN(deg)) deg = -90; deg = Math.max(-90, Math.min(90, deg));
        let theta = deg * Math.PI / 180; let x2 = 50 + 28 * Math.sin(theta); let y2 = 50 - 28 * Math.cos(theta);
        apNeedle.setAttribute('x2', x2); apNeedle.setAttribute('y2', y2); apNeedle.style.transform = ''; 
    }

    let heatVal = document.getElementById('hud-val-heat'); let heatNeedle = document.getElementById('needle-heat');
    if (heatVal) heatVal.innerText = Math.floor(previewHeat);
    // 🌟 指針上限調整至 100 滿表
    if (heatNeedle) {
        let maxGaugeHeat = 100; let deg = -90 + (previewHeat / maxGaugeHeat) * 180; if (isNaN(deg)) deg = -90; deg = Math.max(-90, Math.min(90, deg));
        let theta = deg * Math.PI / 180; let x2 = 50 + 28 * Math.sin(theta); let y2 = 50 - 28 * Math.cos(theta);
        heatNeedle.setAttribute('x2', x2); heatNeedle.setAttribute('y2', y2); heatNeedle.style.transform = ''; 
    }

    let hpFill = document.getElementById('hud-hp-fill-vertical');
    if (hpFill) {
        let currentHp = (typeof teamObj.hp === 'number' && !isNaN(teamObj.hp)) ? teamObj.hp : 100;
        let maxHp = (typeof MAX_HP !== 'undefined' && !isNaN(MAX_HP)) ? MAX_HP : 100;
        let hpPercent = Math.max(0, Math.min(100, (currentHp / maxHp) * 100)); if (isNaN(hpPercent)) hpPercent = 100;
        hpFill.style.height = `${hpPercent}%`;
        if (hpPercent < 30) { hpFill.style.backgroundColor = '#ff1100'; hpFill.style.boxShadow = '0 0 10px #ff1100'; } 
        else { let faction = (GameContext.getFaction && GameContext.getFaction(teamObj.id)) || teamObj.id; let tColor = faction === 'blue' ? '#00bcd4' : '#ff0055'; hpFill.style.backgroundColor = tColor; hpFill.style.boxShadow = `0 0 10px ${tColor}`; }
    }

    let isLocked = false;
    const enemyId = (GameContext.getTargetId && GameContext.getTargetId(teamObj.id))
        || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(teamObj.id))
        || (String(teamObj.id).startsWith('red') ? 'blue' : 'red');
    const enemyObj = teams[enemyId];
    if (teamObj.wrapper && enemyObj && enemyObj.wrapper && !enemyObj.isDestroyed) {
        let distance = teamObj.wrapper.position.distanceTo(enemyObj.wrapper.position); let forward = new THREE.Vector3(0, 0, 1).applyQuaternion(teamObj.wrapper.quaternion).normalize(); let angle = forward.angleTo(new THREE.Vector3().subVectors(enemyObj.wrapper.position, teamObj.wrapper.position).normalize());
        isLocked = teamObj.weapon === 'gun' ? (distance <= (typeof GUN_RANGE !== 'undefined' ? GUN_RANGE : 70) && angle <= Math.PI/12) : (distance <= 60 && angle <= Math.PI/12);
    }

    let elSmsContent = document.getElementById('sms-text-content');
    if (elSmsContent) {
        let wpnName = teamObj.weapon === 'gun' ? '機砲' : '飛彈'; let statusText = '[就緒]';
        if (teamObj.wpnQueued) { statusText = '[已排程]'; } 
        else if (teamObj.weapon === 'missile') {
            let armedCount = teamObj.pylons ? teamObj.pylons.filter(p => p.state === 'armed').length : 0; let poweringCount = teamObj.pylons ? teamObj.pylons.filter(p => p.state === 'powering').length : 0;
            statusText = armedCount > 0 ? (isLocked ? '[已鎖定]' : '[就緒]') : (poweringCount > 0 ? '[開機中]' : '[未通電]');
        } else { statusText = isLocked ? '[已鎖定]' : '[就緒]'; wpnName = `機砲 [INF]`; }
        elSmsContent.innerText = `狀態 ${statusText} ${wpnName}`;
    }

    if (teamObj.pylons) {
        teamObj.pylons.forEach(p => {
            let stick = document.getElementById(`pylon-stick-${p.id}`); 
            if (stick) {
                stick.className = 'pylon-stick';
                if (p.state === 'empty') { stick.style.background = '#ff0033'; stick.style.boxShadow = '0 0 10px #ff0033'; } 
                else if (p.state === 'powering') { stick.style.background = '#ffaa00'; stick.style.boxShadow = '0 0 12px #ffaa00'; } 
                else if (p.state === 'armed') { stick.style.background = '#00ff88'; stick.style.boxShadow = '0 0 15px #00ff88'; } 
                else { stick.style.background = '#222'; stick.style.boxShadow = 'inset 0 2px 4px #000'; }
            }
        });
    }

    // 🌟 Flare 亮燈
    const btnFlare = document.getElementById('btn-flare');
    if (btnFlare) {
        if (teamObj.flareAmmo <= 0) { 
            btnFlare.className = 'sms-top-btn'; 
            btnFlare.innerText = 'FLARE [0]'; 
            btnFlare.style.color = '#555'; 
            btnFlare.style.borderColor = '#333'; 
            btnFlare.style.background = '#111';
            btnFlare.style.boxShadow = 'none';
        } 
        else if (teamObj.flaresArmed) { 
            btnFlare.className = 'sms-top-btn'; 
            btnFlare.innerText = `FLARE [${teamObj.flareAmmo}]`; 
            btnFlare.style.color = '#fff'; 
            btnFlare.style.borderColor = '#ff9800'; 
            btnFlare.style.background = '#ff6600'; 
            btnFlare.style.boxShadow = '0 0 12px #ff9800';
        } 
        else { 
            btnFlare.className = 'sms-top-btn'; 
            btnFlare.innerText = `FLARE [${teamObj.flareAmmo}]`; 
            btnFlare.style.color = '#ff9800'; 
            btnFlare.style.borderColor = '#ff9800'; 
            btnFlare.style.background = '#111'; 
            btnFlare.style.boxShadow = 'none';
        } 
    }

    // 🌟 每機獨立待命／AI 狀態按鈕
    uiSeatIds().forEach((id) => {
        let btnEngage = document.getElementById(`btn-engage-${id}`);
        let t = teams[id];
        if (!btnEngage || !t || !uiIsSeatLive(id)) return;
        const faction = (GameContext.getFaction && GameContext.getFaction(id)) || id;
        if (t.aiEnabled) {
            const action = t.aiLastAction;
            const detail = action ? ` | THR ${action.throttle || '-'} | ${action.weapon ? action.weapon.toUpperCase() : 'GUN'}` : '';
            btnEngage.innerText = `${t.aiStatusText || 'NPC: 待機中'}${detail}`;
            btnEngage.style.borderColor = '#ffbb00';
            btnEngage.style.color = '#ffbb00';
            btnEngage.style.boxShadow = '0 0 10px rgba(255,187,0,0.65), inset 0 0 5px rgba(255,187,0,0.35)';
            btnEngage.style.cursor = 'pointer';
            btnEngage.title = '點擊展開/收合 AI 決策樹';
        } else if (t.ready) {
            btnEngage.innerText = '待命中';
            let glowColor = faction === 'blue' ? '#00bcd4' : '#ff0055';
            btnEngage.style.borderColor = glowColor;
            btnEngage.style.color = glowColor;
            btnEngage.style.boxShadow = `0 0 10px ${glowColor}, inset 0 0 5px ${glowColor}`;
            btnEngage.style.cursor = 'pointer';
            btnEngage.title = '';
        } else {
            btnEngage.innerText = '規劃中';
            btnEngage.style.borderColor = '#aaa';
            btnEngage.style.color = '#fff';
            btnEngage.style.boxShadow = 'none';
            btnEngage.style.cursor = 'pointer';
            btnEngage.title = '';
        }
    });
    uiRefreshTeamModeButtons();
    uiRefreshAIDebugPanel();
}

function showSMSAlert(text, color) {
    let elSmsContent = document.getElementById('sms-text-content');
    if (elSmsContent) {
        elSmsContent.innerText = text; elSmsContent.style.color = color || '#00ff88';
        if(window.smsAlertTimeout) clearTimeout(window.smsAlertTimeout);
        window.smsAlertTimeout = setTimeout(() => { 
            let currentTeam = uiCurrentTeamId(); 
            let t = teams[currentTeam]; 
            if(t) { elSmsContent.style.color = '#ffeb3b'; updateDashboardUI(t); } 
        }, 1800);
    }
}

// ----------------------------------------------------------------------------
// Event Bus: EnginePhaseChanged (ui.js 結構整理：事件處理邏輯抽成函式)
// ----------------------------------------------------------------------------
function uiOnEnginePhaseChanged(e) {
    const data = e.detail;
    let lockScreen = document.getElementById('combat-lock-screen');
    let dashboard = document.getElementById('ui-dashboard');
    let repStatus = document.getElementById('replay-status');
    let repSlider = document.getElementById('replay-slider');

    switch(data.phase) {
        case 'calculating':
            uiClearAutoAIBattleTimer();
            if(lockScreen) lockScreen.style.display = 'block';
            if(dashboard) { dashboard.style.pointerEvents = 'none'; dashboard.style.opacity = '0.2'; }
            if(repStatus) repStatus.innerText = "狀態: 運算中";
            uiSetControlsVisible(false);
            break;
        case 'playing':
            uiClearAutoAIBattleTimer();
            if(lockScreen) lockScreen.style.display = 'none';
            if(repStatus) repStatus.innerText = "狀態: 播放中";
            if(repSlider) { 
                repSlider.min = 1; 
                repSlider.max = data.maxLog + 0.99; 
                repSlider.step = 0.01; 
                repSlider.disabled = false; 
            }
            uiSyncSelectionChrome(uiCurrentTeamId());
            break;
        case 'planning':
            if(lockScreen) lockScreen.style.display = 'none';
            if(dashboard) { dashboard.style.pointerEvents = 'auto'; dashboard.style.opacity = '1.0'; }
            if (data.wreckFall) {
                // Wreck auto-turn is owned by combat.scheduleWreckFallTurn — never also schedule AI.
                uiClearAutoAIBattleTimer();
                if(repStatus) { repStatus.innerText = "狀態: 殘骸墜落中"; repStatus.style.color = "#ff9800"; }
                uiShowPhaseBanner(`ROUND ${data.turn}<br><span style="font-size: 20px; color: #eee; letter-spacing: 4px; text-shadow: 2px 2px 4px #000;">殘骸墜落</span>`);
                uiSyncSelectionChrome(uiCurrentTeamId());
                break;
            }
            if(repStatus) { repStatus.innerText = "狀態: 戰術規劃中"; repStatus.style.color = "#aaa"; }
            uiShowPhaseBanner(`ROUND ${data.turn}<br><span style="font-size: 20px; color: #eee; letter-spacing: 4px; text-shadow: 2px 2px 4px #000;">戰術規劃階段</span>`);
            uiSyncSelectionChrome(uiCurrentTeamId());
            if (uiAreBothTeamsAI()) {
                uiScheduleBothAITurn();
            } else {
                uiClearAutoAIBattleTimer();
            }
            break;
        case 'game_over':
            uiClearAutoAIBattleTimer();
            if(lockScreen) lockScreen.style.display = 'none';
            if(dashboard) { dashboard.style.pointerEvents = 'auto'; dashboard.style.opacity = '1.0'; }
            if(repStatus) { repStatus.innerText = `狀態: 戰鬥結束 - ${data.winner || ''}`; repStatus.style.color = "#ffeb3b"; }
            if(repSlider) {
                repSlider.min = 1;
                repSlider.max = (typeof battleLog !== 'undefined' ? (battleLog.length + 0.99) : 1.99);
                repSlider.step = 0.01;
                repSlider.disabled = false;
            }
            uiShowPhaseBanner(`<span style="font-size: 40px; color: #ffeb3b; text-shadow: 2px 2px 10px #ff0000;">ENGAGEMENT OVER</span><br><span style="font-size: 24px; color: #fff;">${data.winner || 'RESULT UNKNOWN'}</span>`, true);
            showSMSAlert(`戰鬥結束：${data.winner || 'RESULT UNKNOWN'}`, '#ffeb3b');
            break;
    }
    uiRefreshAIDebugPanel();
}

window.addEventListener('EnginePhaseChanged', uiOnEnginePhaseChanged);

window.AirArenaAIDebug = {
    buildSnapshot(teamId) {
        return uiBuildAIDebugSnapshot(teamId || uiAIDebugExpandedTeam);
    },
    formatText(teamId) {
        return uiFormatAIDebugText(teamId || uiAIDebugExpandedTeam);
    },
    buildRoster() {
        return uiBuildAIRosterSnapshot();
    },
    formatRosterText() {
        return uiFormatAIRosterText();
    },
    exportAll() {
        return uiExportAllAIDebug();
    },
    copy(teamId) {
        if (teamId) uiAIDebugExpandedTeam = teamId;
        return uiCopyAIDebugSnapshot();
    },
    download(teamId) {
        if (teamId) uiAIDebugExpandedTeam = teamId;
        uiDownloadAIDebugSnapshot();
    },
    startRecording(teamId) {
        const t = uiGetAIDebugTeam(teamId || uiAIDebugExpandedTeam);
        if (!t) return false;
        t.aiDebugRecording = true;
        if (!Array.isArray(t.aiDebugTrace)) t.aiDebugTrace = [];
        uiRefreshAIDebugRecordControls();
        return true;
    },
    stopRecording(teamId) {
        const t = uiGetAIDebugTeam(teamId || uiAIDebugExpandedTeam);
        if (!t) return false;
        t.aiDebugRecording = false;
        uiRefreshAIDebugRecordControls();
        return true;
    },
    downloadTrace(teamId) {
        if (teamId) uiAIDebugExpandedTeam = teamId;
        uiDownloadAIDebugTrace();
    },
    getTrace(teamId) {
        const t = uiGetAIDebugTeam(teamId || uiAIDebugExpandedTeam);
        return t && Array.isArray(t.aiDebugTrace) ? t.aiDebugTrace.slice() : [];
    }
};