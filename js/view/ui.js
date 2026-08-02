// ============================================================================
// ui.js - MFD 儀表板與輸入控制 (5檔磁吸滑軌控制)
// ============================================================================

function uiCurrentTeamId() { return GameContext.getActiveTeamId(); }
function uiCurrentTeam() { return GameContext.getActiveTeam(); }
function uiRefreshPreview(team) { GameContext.callService('updateTacticalPreview', team); }
let uiAutoAIBattleTimer = null;
let uiAutoAIFirstDelayDone = false;
let uiTurnComputeBusy = false;

/** Yield so the browser can paint the computing overlay before sync AI / resolution. */
function uiYieldPaint() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame !== 'function') {
            setTimeout(resolve, 0);
            return;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => setTimeout(resolve, 0));
        });
    });
}

function uiShowComputingOverlay(subtitle = '戰術結算與 AI 決策') {
    const lock = document.getElementById('combat-lock-screen');
    if (lock) {
        lock.style.display = 'block';
        lock.classList.add('is-visible');
        lock.setAttribute('aria-busy', 'true');
    }
    const bar = document.getElementById('replay-control-bar');
    if (bar) bar.classList.add('is-computing');
    // Status/spinner live in the fold — expand so players can see computing feedback.
    if (uiIsReplayMainCollapsed()) uiSetReplayMainCollapsed(false);
    const repStatus = document.getElementById('replay-status');
    if (repStatus) {
        repStatus.innerText = '狀態: 運算中';
        repStatus.style.color = '#ffcc66';
    }
    uiSetComputeSub(subtitle);
    const dashboard = document.getElementById('ui-dashboard');
    if (dashboard) {
        dashboard.style.pointerEvents = 'none';
        dashboard.style.opacity = '0.2';
    }
    uiSetControlsVisible(false);
}

function uiHideComputingOverlay() {
    const lock = document.getElementById('combat-lock-screen');
    if (lock) {
        lock.style.display = 'none';
        lock.classList.remove('is-visible');
        lock.setAttribute('aria-busy', 'false');
    }
    const bar = document.getElementById('replay-control-bar');
    if (bar) bar.classList.remove('is-computing');
    const sub = document.getElementById('compute-lock-sub');
    if (sub) {
        sub.textContent = '';
        sub.hidden = true;
    }
}

function uiSetComputeSub(subtitle) {
    const sub = document.getElementById('compute-lock-sub');
    if (!sub) return;
    const text = subtitle != null ? String(subtitle) : '';
    sub.textContent = text;
    sub.hidden = !text;
}

/**
 * Run pending AI seats (with paint yields), then resolve the turn if everyone is ready.
 * Shows computing feedback in the top status row (spinner + 狀態) while JS blocks.
 */
async function uiRunPendingAIAndMaybeResolve() {
    if (uiTurnComputeBusy || GameContext.isAnimating() || GameContext.isReplayMode()) return false;
    uiTurnComputeBusy = true;
    let handedToTurnExec = false;
    try {
        const living = uiLivingTeamIds();
        const pendingAi = living.filter((id) => {
            const t = teams[id];
            return !!(t && t.aiEnabled && !t.ready && !t.isDestroyed && t.matchActive !== false);
        });
        const allReadyAlready = !!(GameContext.areAllLivingReady && GameContext.areAllLivingReady());
        if (!pendingAi.length && !allReadyAlready) return false;

        uiShowComputingOverlay(pendingAi.length ? 'NPC 決策中…' : '戰術結算中…');
        await uiYieldPaint();

        for (let i = 0; i < pendingAi.length; i++) {
            const id = pendingAi[i];
            uiSetComputeSub(`NPC 決策 ${String(id).toUpperCase()} (${i + 1}/${pendingAi.length})…`);
            uiRunAI(id);
            await uiYieldPaint();
        }

        if (GameContext.areAllLivingReady && GameContext.areAllLivingReady()) {
            uiSetComputeSub('戰術結算中…');
            await uiYieldPaint();
            handedToTurnExec = true;
            if (window.executeTurnSimultaneously) window.executeTurnSimultaneously();
            return true;
        }
        uiHideComputingOverlay();
        return false;
    } catch (err) {
        console.error('回合提交運算失敗：', err);
        uiHideComputingOverlay();
        return false;
    } finally {
        if (!handedToTurnExec) uiTurnComputeBusy = false;
        else {
            // Turn exec owns the lock screen until playing; release busy after schedule.
            uiTurnComputeBusy = false;
        }
    }
}
window.uiShowComputingOverlay = uiShowComputingOverlay;
window.uiHideComputingOverlay = uiHideComputingOverlay;
window.uiRunPendingAIAndMaybeResolve = uiRunPendingAIAndMaybeResolve;
let uiMatchSetupState = {
    mode: '1v1',
    mapId: 'original',
    spawnAltitude: 45,
    spawnSeparation: 100,
    seats: {
        'red-1': { control: 'human', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] },
        'red-2': { control: 'ai', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] },
        'blue-1': { control: 'ai', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] },
        'blue-2': { control: 'ai', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] }
    }
};
let uiMatchSetupBound = false;

function uiSanitizeSpawnAltitude(alt) {
    if (GameContext && GameContext.sanitizeSpawnAltitude) return GameContext.sanitizeSpawnAltitude(alt);
    const n = Math.round(Number(alt));
    return [28, 45, 60, 80].includes(n) ? n : 45;
}

function uiSanitizeSpawnSeparation(sep) {
    if (GameContext && GameContext.sanitizeSpawnSeparation) return GameContext.sanitizeSpawnSeparation(sep);
    const n = Math.round(Number(sep));
    return [60, 100, 140, 200].includes(n) ? n : 100;
}

function uiSyncSpawnSelects(altitude, separation) {
    const alt = String(uiSanitizeSpawnAltitude(altitude));
    const sep = String(uiSanitizeSpawnSeparation(separation));
    ['match-spawn-alt', 'arena-spawn-alt'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = alt;
    });
    ['match-spawn-sep', 'arena-spawn-sep'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = sep;
    });
}

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

function uiRefreshMapSelect() {
    const select = document.getElementById('match-map-select');
    if (!select || !window.MapCatalog) return;
    const paint = () => {
        const selected = window.MapCatalog.getSelectedId();
        const items = window.MapCatalog.list();
        select.innerHTML = '';
        items.forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.id;
            if (item.kind === 'custom') opt.textContent = `${item.name} (自訂)`;
            else opt.textContent = item.name;
            select.appendChild(opt);
        });
        const exists = items.some((i) => i.id === selected);
        select.value = exists ? selected : window.MapCatalog.ORIGINAL_ID;
        uiMatchSetupState.mapId = select.value;
        uiUpdateMapDeleteButton();
    };
    paint();
    if (typeof window.MapCatalog.init === 'function') {
        window.MapCatalog.init().then(paint).catch(() => paint());
    }
}

function uiUpdateMapDeleteButton() {
    const btn = document.getElementById('btn-map-delete');
    const select = document.getElementById('match-map-select');
    if (!btn || !select || !window.MapCatalog) return;
    const item = window.MapCatalog.list().find((m) => m.id === select.value);
    btn.disabled = !(item && item.removable);
}

function uiReadMatchSetupFromDom() {
    const modeBtn = document.querySelector('.match-mode-btn.is-active');
    const mode = (modeBtn && modeBtn.getAttribute('data-mode') === '2v2') ? '2v2' : '1v1';
    const mapSelect = document.getElementById('match-map-select');
    const mapId = (mapSelect && mapSelect.value) || (window.MapCatalog && window.MapCatalog.ORIGINAL_ID) || 'original';
    const altEl = document.getElementById('match-spawn-alt');
    const sepEl = document.getElementById('match-spawn-sep');
    const spawnAltitude = uiSanitizeSpawnAltitude(altEl ? altEl.value : uiMatchSetupState.spawnAltitude);
    const spawnSeparation = uiSanitizeSpawnSeparation(sepEl ? sepEl.value : uiMatchSetupState.spawnSeparation);
    const seats = {
        'red-1': { control: 'human', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] },
        'red-2': { control: 'ai', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] },
        'blue-1': { control: 'ai', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] },
        'blue-2': { control: 'ai', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] }
    };
    uiMatchSeatDefs(mode).forEach((def) => {
        const controlEl = document.getElementById(`match-control-${def.id}`);
        const loadoutEl = document.getElementById(`match-loadout-${def.id}`);
        seats[def.id] = {
            control: (controlEl && controlEl.value === 'ai') ? 'ai' : 'human',
            loadout: (loadoutEl && loadoutEl.value) || 'standard',
            pylons: [1, 2, 3, 4].map((n) => {
                const el = document.getElementById(`match-pylon-${def.id}-${n}`);
                const v = el && el.value === 'fox1' ? 'fox1' : 'fox2';
                return v;
            })
        };
    });
    uiMatchSetupState = { mode, mapId, spawnAltitude, spawnSeparation, seats };
    uiSyncSpawnSelects(spawnAltitude, spawnSeparation);
    return uiMatchSetupState;
}

function uiRenderMatchSeatList() {
    const list = document.getElementById('match-seat-list');
    if (!list) return;
    const mode = uiMatchSetupState.mode;
    const defs = uiMatchSeatDefs(mode);
    list.innerHTML = defs.map((def) => {
        const seat = uiMatchSetupState.seats[def.id] || { control: 'ai', loadout: 'standard', pylons: ['fox1', 'fox2', 'fox2', 'fox1'] };
        const pylons = (typeof sanitizePylonLoadout === 'function')
            ? sanitizePylonLoadout(seat.pylons)
            : (seat.pylons || ['fox1', 'fox2', 'fox2', 'fox1']);
        const disabled = def.live ? '' : ' is-disabled';
        const note = def.live ? '' : ' title="此座位尚未啟用"';
        const pylonSelects = [0, 1, 2, 3].map((i) => {
            const w = pylons[i] === 'fox1' ? 'fox1' : 'fox2';
            return `<select id="match-pylon-${def.id}-${i + 1}" class="match-pylon-select" aria-label="${def.label} pylon ${i + 1}"${def.live ? '' : ' disabled'}>
                <option value="fox2"${w === 'fox2' ? ' selected' : ''}>P${i + 1} FOX-2</option>
                <option value="fox1"${w === 'fox1' ? ' selected' : ''}>P${i + 1} FOX-1</option>
            </select>`;
        }).join('');
        return `
            <div class="match-seat-row${disabled}" data-seat="${def.id}"${note}>
                <div class="match-seat-name ${def.faction}">${def.label}</div>
                <select id="match-control-${def.id}" aria-label="${def.label} control"${def.live ? '' : ' disabled'}>
                    <option value="human"${seat.control === 'human' ? ' selected' : ''}>人工</option>
                    <option value="ai"${seat.control === 'ai' ? ' selected' : ''}>AI</option>
                </select>
                <select id="match-loadout-${def.id}" aria-label="${def.label} loadout"${def.live ? '' : ' disabled'}>
                    <option value="standard"${seat.loadout === 'standard' ? ' selected' : ''}>標準 (2×F1+2×F2+Gun)</option>
                    <option value="gun-priority"${seat.loadout === 'gun-priority' ? ' selected' : ''}>機砲優先</option>
                    <option value="fox2-priority"${seat.loadout === 'fox2-priority' ? ' selected' : ''}>FOX-2 優先</option>
                    <option value="fox1-priority"${seat.loadout === 'fox1-priority' ? ' selected' : ''}>FOX-1 優先</option>
                </select>
                <div class="match-pylon-row">${pylonSelects}</div>
            </div>
        `;
    }).join('');
    const hint = document.getElementById('match-mode-hint');
    if (hint) {
        hint.classList.remove('is-hidden');
        if (mode === '2v2') {
            hint.textContent =
                '2v2：紅藍各兩架（RED-1/2、BLUE-1/2）。翼機可收僚機令——跟隨、攻擊我的目標、主動進攻、掩護、脫離。建議 RED-1 人工、RED-2 AI 測編隊；兩席皆可設 AI 對打。';
        } else {
            hint.textContent =
                '1v1：紅藍各一架，適合單挑與練習武器／箔條。僅 RED-1 與 BLUE-1 參戰。';
        }
    }
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
        if (e.target && e.target.id === 'match-map-select') {
            const id = e.target.value;
            if (window.MapCatalog) window.MapCatalog.setSelectedId(id);
            uiMatchSetupState.mapId = id;
            uiUpdateMapDeleteButton();
            return;
        }
        if (e.target && (e.target.id === 'match-spawn-alt' || e.target.id === 'match-spawn-sep')) {
            uiReadMatchSetupFromDom();
            return;
        }
        if (!e.target.closest('#match-seat-list')) return;
        // Loadout presets: fill pylons when switching doctrine dropdown.
        if (e.target && String(e.target.id || '').indexOf('match-loadout-') === 0) {
            const seatId = String(e.target.id).replace('match-loadout-', '');
            const preset = e.target.value;
            const applyPylons = (types) => {
                [1, 2, 3, 4].forEach((n) => {
                    const el = document.getElementById(`match-pylon-${seatId}-${n}`);
                    if (el) el.value = types[n - 1] || 'fox2';
                });
            };
            if (preset === 'standard') {
                applyPylons(
                    (typeof defaultPylonLoadout === 'function')
                        ? defaultPylonLoadout()
                        : ['fox1', 'fox2', 'fox2', 'fox1']
                );
            } else if (preset === 'fox1-priority') {
                const vals = [1, 2, 3, 4].map((n) => {
                    const el = document.getElementById(`match-pylon-${seatId}-${n}`);
                    return el ? el.value : 'fox2';
                });
                if (vals.every((v) => v !== 'fox1')) applyPylons(['fox1', 'fox1', 'fox1', 'fox1']);
            } else if (preset === 'fox2-priority') {
                const vals = [1, 2, 3, 4].map((n) => {
                    const el = document.getElementById(`match-pylon-${seatId}-${n}`);
                    return el ? el.value : 'fox2';
                });
                if (vals.every((v) => v !== 'fox2')) applyPylons(['fox2', 'fox2', 'fox2', 'fox2']);
            }
        }
        uiReadMatchSetupFromDom();
    });

    const importBtn = document.getElementById('btn-map-import');
    const fileInput = document.getElementById('match-map-file');
    const deleteBtn = document.getElementById('btn-map-delete');
    if (importBtn && fileInput) {
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file || !window.MapCatalog) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const json = JSON.parse(String(reader.result));
                    const doc = window.MapLoader ? window.MapLoader.normalizeDoc(json) : json;
                    const entry = window.MapCatalog.addMap(doc);
                    uiRefreshMapSelect();
                    const select = document.getElementById('match-map-select');
                    if (select) select.value = entry.id;
                    uiMatchSetupState.mapId = entry.id;
                    uiUpdateMapDeleteButton();
                    if (typeof showSMSAlert === 'function') {
                        showSMSAlert(`地圖已加入: ${entry.name}`, '#00ff88');
                    }
                } catch (err) {
                    console.warn('[MapCatalog] 匯入失敗', err);
                    if (typeof showSMSAlert === 'function') {
                        showSMSAlert('地圖匯入失敗', '#ff3355');
                    }
                }
            };
            reader.readAsText(file);
            fileInput.value = '';
        });
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            const select = document.getElementById('match-map-select');
            if (!select || !window.MapCatalog) return;
            const id = select.value;
            const item = window.MapCatalog.list().find((m) => m.id === id);
            if (!item || !item.removable) return;
            if (!window.confirm(`刪除自訂地圖「${item.name}」？`)) return;
            window.MapCatalog.removeMap(id);
            uiRefreshMapSelect();
        });
    }

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
    const footer = document.getElementById('startup-setup-footer');
    const scroller = document.getElementById('startup-scroll');
    if (!screen || !panel) return false;
    uiBindMatchSetupOnce();
    if (!uiMatchSetupState.seats) {
        uiMatchSetupState = {
            mode: '1v1',
            mapId: (window.MapCatalog && window.MapCatalog.getSelectedId()) || 'original',
            spawnAltitude: 45,
            spawnSeparation: 100,
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
    uiRefreshMapSelect();
    uiSyncSpawnSelects(uiMatchSetupState.spawnAltitude, uiMatchSetupState.spawnSeparation);
    uiRenderMatchSeatList();
    panel.hidden = false;
    if (footer) footer.hidden = false;
    screen.classList.remove('is-entering');
    screen.style.display = '';
    screen.style.opacity = '1';
    screen.style.pointerEvents = 'auto';
    document.documentElement.classList.add('startup-lock');
    document.body.classList.add('startup-lock');
    if (scroller) scroller.scrollTop = 0;
    // Two-frame swap so opacity fade runs after ENTERING splash.
    requestAnimationFrame(() => {
        screen.classList.add('is-setup');
        if (scroller) scroller.scrollTop = 0;
    });
    return true;
}

function uiDismissStartupScreen() {
    const startup = document.getElementById('startup-screen');
    if (!startup) return;
    startup.style.opacity = '0';
    document.documentElement.classList.remove('startup-lock');
    document.body.classList.remove('startup-lock');
    setTimeout(() => {
        startup.style.display = 'none';
        startup.classList.remove('is-setup', 'is-entering');
        const footer = document.getElementById('startup-setup-footer');
        if (footer) footer.hidden = true;
    }, 1200);
}

function uiConfirmMatchSetup() {
    const engage = document.getElementById('btn-match-engage');
    if (engage) engage.disabled = true;
    const draft = uiReadMatchSetupFromDom();
    if (window.MapCatalog) window.MapCatalog.setSelectedId(draft.mapId);

    const finishEngage = () => {
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
            let mapLabel = '原版';
            if (window.MapCatalog) {
                const found = window.MapCatalog.list().find((m) => m.id === draft.mapId);
                if (found) mapLabel = found.name;
            }
            showSMSAlert(
                `MATCH LOCKED: ${modeLabel} · ${mapLabel} · ALT ${cfg.spawnAltitude}m · SEP ${cfg.spawnSeparation}m`,
                '#00ff88'
            );
        }
        uiDismissStartupScreen();
    };

    const applyMap = (typeof applySelectedMap === 'function')
        ? applySelectedMap
        : (GameContext.callService ? (id) => GameContext.callService('applySelectedMap', id) : null);

    const mapPromise = applyMap ? Promise.resolve(applyMap(draft.mapId)) : Promise.resolve();
    mapPromise
        .catch((err) => console.warn('[MatchSetup] 地圖套用失敗', err))
        .finally(() => {
            finishEngage();
        });
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
    const screen = document.getElementById('startup-screen');
    if (screen) {
        screen.classList.add('is-entering');
        screen.classList.remove('is-setup');
        screen.style.display = '';
        screen.style.opacity = '1';
        screen.style.pointerEvents = 'auto';
    }
    document.documentElement.classList.add('startup-lock');
    document.body.classList.add('startup-lock');
    // Keep ENTERING splash ~1s after boot, then fade into Match Setup.
    setTimeout(() => {
        uiShowMatchSetup();
    }, 1000);
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
/** Strip leading "NPC:" from seat status labels (keep AI internals unchanged). */
function uiStripNpcStatusPrefix(text) {
    return String(text || '').replace(/^NPC[:：]\s*/i, '').trim() || '待機中';
}
function uiScheduleBothAITurn() {
    uiClearAutoAIBattleTimer();
    if (!uiAreBothTeamsAI() || GameContext.isAnimating() || GameContext.isReplayMode()) return;
    const turnNo = Number(GameContext.state.currentTurn || 1);
    if (turnNo <= 1 && Array.isArray(GameContext.state.battleLog) && GameContext.state.battleLog.length === 0) {
        uiAutoAIFirstDelayDone = false;
    }
    const delayMs = uiAutoAIFirstDelayDone ? 0 : 3000;
    const statusText = delayMs > 0 ? '3秒後自動提交' : '自動提交中';
    const living = uiLivingTeamIds();

    living.forEach((id) => GameContext.stateMachine.setAIStatus(id, 'autoplan', statusText));
    updateDashboardUI(teams[uiCurrentTeamId()]);

    uiAutoAIBattleTimer = setTimeout(() => {
        uiAutoAIBattleTimer = null;
        if (!uiAutoAIFirstDelayDone) uiAutoAIFirstDelayDone = true;
        if (!uiAreBothTeamsAI() || GameContext.isAnimating() || GameContext.isReplayMode()) return;
        uiRunPendingAIAndMaybeResolve();
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
/**
 * Wingman orders: only for AI seats whose faction already has a human.
 * Enemy-faction wingman stays closed unless someone switches that other team to human control.
 */
function uiIsNpcWingman(teamId) {
    const t = teams[teamId];
    if (!t || !t.aiEnabled || t.isDestroyed || t.matchActive === false) return false;
    const faction = GameContext.getFaction ? GameContext.getFaction(teamId) : teamId;
    return uiFactionHasHuman(faction);
}
/** Player may issue wingman UI for this AI seat (own side, or other side only after human takeover). */
function uiCanCommandWingman(teamId) {
    return uiIsNpcWingman(teamId) && !GameContext.isReplayMode();
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
    const show = uiCanCommandWingman(id);
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
    if (!t || !t.wrapper || !uiCanCommandWingman(id)) {
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
function uiSetWingmanOrder(order, teamId = null) {
    const id = teamId || uiCurrentTeamId();
    const t = teams[id];
    if (!t || !t.aiEnabled || t.isDestroyed) return;
    // Enemy wingman stays closed until that faction has a human seat.
    if (!uiCanCommandWingman(id)) return;
    if (!GameContext.stateMachine.setWingmanOrder(id, order)) return;
    uiRefreshWingmanOrderButtons(id);
    uiRefreshAIDebugWingmanOrders(id);
    const labels = { follow: '跟隨', attack: '攻擊我的目標', free: '主動進攻', cover: '掩護', break: '脫離' };
    if (typeof showSMSAlert === 'function') {
        showSMSAlert(`${id.toUpperCase()} 指令: ${labels[order] || order}`, '#ffffff');
    }
    // Apply immediately so status/path reflect the new order (don't wait for human Ready).
    if (t.aiEnabled && !t.ready && !t.isDestroyed) {
        uiRunAI(id);
    } else {
        updateDashboardUI(t || teams[uiCurrentTeamId()]);
    }
}
function uiRefreshAIDebugWingmanOrders(teamId) {
    const wrap = document.getElementById('ai-debug-wingman');
    if (!wrap) return;
    const id = teamId || uiAIDebugExpandedTeam;
    const t = id ? teams[id] : null;
    const show = !!(t && uiCanCommandWingman(id));
    wrap.hidden = !show;
    if (!show) return;
    const order = t.wingmanOrder || 'follow';
    wrap.querySelectorAll('.ai-debug-wingman-btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-order') === order);
    });
}
function uiBindAIDebugWingmanOnce() {
    const wrap = document.getElementById('ai-debug-wingman');
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = '1';
    wrap.addEventListener('click', (e) => {
        const btn = e.target.closest('.ai-debug-wingman-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const id = uiAIDebugExpandedTeam;
        if (!id) return;
        uiSetWingmanOrder(btn.getAttribute('data-order'), id);
    });
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

const UI_REPLAY_MAIN_COLLAPSE_KEY = 'airarena.replayMainCollapsed';
function uiIsReplayMainCollapsed() {
    const bar = document.getElementById('replay-control-bar');
    return !!(bar && bar.classList.contains('is-main-collapsed'));
}
function uiSetReplayMainCollapsed(collapsed) {
    const bar = document.getElementById('replay-control-bar');
    const btn = document.getElementById('btn-replay-main-toggle');
    if (!bar || !btn) return;
    const on = !!collapsed;
    bar.classList.toggle('is-main-collapsed', on);
    btn.setAttribute('aria-expanded', on ? 'false' : 'true');
    btn.textContent = on ? '▾' : '▴';
    btn.title = on ? '展開隊伍／狀態／決策樹' : '收合隊伍／狀態／決策樹';
    btn.setAttribute('aria-label', btn.title);
    const aiPanel = document.getElementById('ai-debug-panel');
    if (aiPanel) aiPanel.classList.toggle('is-bar-collapsed', on);
    try { localStorage.setItem(UI_REPLAY_MAIN_COLLAPSE_KEY, on ? '1' : '0'); } catch (_) { /* ignore */ }
    if (!on && uiAIDebugExpandedTeam) uiPositionAIDebugPanel(uiAIDebugExpandedTeam);
}
function uiToggleReplayMainCollapsed() {
    uiSetReplayMainCollapsed(!uiIsReplayMainCollapsed());
}
function uiBindReplayMainCollapseOnce() {
    const btn = document.getElementById('btn-replay-main-toggle');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        uiToggleReplayMainCollapsed();
    });
    let preferCollapsed = false;
    try { preferCollapsed = localStorage.getItem(UI_REPLAY_MAIN_COLLAPSE_KEY) === '1'; } catch (_) { /* ignore */ }
    uiSetReplayMainCollapsed(preferCollapsed);
}

function uiPylonTypeLabel(p) {
    const type = (typeof pylonWeaponType === 'function')
        ? pylonWeaponType(p)
        : (p && (p.weaponType || p.weapon)) || 'fox2';
    if (type === 'fox1') return 'F1';
    if (type === 'fox2') return 'F2';
    return String(type || '?').slice(0, 2).toUpperCase();
}
function uiRefreshSeatVitals() {
    const maxHp = (typeof MAX_HP === 'number' && MAX_HP > 0) ? MAX_HP : 100;
    const maxAp = (typeof MAX_AP === 'number' && MAX_AP > 0) ? MAX_AP : 300;
    uiSeatIds().forEach((id) => {
        const t = teams[id];
        const live = uiIsSeatLive(id);
        const hpFill = document.getElementById(`seat-hp-${id}`);
        const apFill = document.getElementById(`seat-ap-${id}`);
        const hpBar = hpFill && hpFill.parentElement;
        const apBar = apFill && apFill.parentElement;
        const pylonsEl = document.getElementById(`seat-pylons-${id}`);
        if (!live || !t) {
            if (hpFill) hpFill.style.transform = 'scaleX(0)';
            if (apFill) apFill.style.transform = 'scaleX(0)';
            if (hpBar) {
                hpBar.classList.remove('is-low');
                hpBar.title = 'HP';
            }
            if (apBar) {
                apBar.classList.remove('is-low');
                apBar.title = 'AP';
            }
            if (pylonsEl) pylonsEl.innerHTML = '';
            return;
        }
        const hp = (typeof t.hp === 'number' && !isNaN(t.hp)) ? t.hp : maxHp;
        const ap = (typeof t.ap === 'number' && !isNaN(t.ap)) ? t.ap : 0;
        const hpPct = Math.max(0, Math.min(1, hp / maxHp));
        const apPct = Math.max(0, Math.min(1, ap / maxAp));
        if (hpFill) hpFill.style.transform = `scaleX(${hpPct})`;
        if (apFill) apFill.style.transform = `scaleX(${apPct})`;
        if (hpBar) {
            hpBar.classList.toggle('is-low', hpPct < 0.3);
            hpBar.title = `HP ${Math.round(hp)}/${maxHp}`;
        }
        if (apBar) {
            apBar.classList.toggle('is-low', apPct < 0.25);
            apBar.title = `AP ${Math.round(ap)}/${maxAp}`;
        }
        if (!pylonsEl) return;
        const pylons = Array.isArray(t.pylons) ? t.pylons : [];
        const liveCount = pylons.filter((p) => p && p.state && p.state !== 'empty').length;
        const armedCount = pylons.filter((p) => p && p.state === 'armed').length;
        const poweringCount = pylons.filter((p) => p && p.state === 'powering').length;
        let statusWord = '空';
        if (armedCount > 0) statusWord = 'ARM';
        else if (poweringCount > 0) statusWord = 'PWR';
        else if (liveCount > 0) statusWord = 'STBY';
        const slots = pylons.map((p) => {
            const state = (p && p.state) || 'empty';
            const type = (typeof pylonWeaponType === 'function')
                ? pylonWeaponType(p)
                : (p && (p.weaponType || p.weapon)) || 'fox2';
            const label = uiPylonTypeLabel(p);
            return `<span class="seat-pylon-slot is-${state}" data-type="${type}" title="${label} ${state}"></span>`;
        }).join('');
        pylonsEl.innerHTML =
            `<span class="seat-pylon-meta">${liveCount}/${pylons.length || 0} ${statusWord}</span>${slots}`;
        pylonsEl.title = `掛架 ${liveCount}/${pylons.length || 0}｜ARM ${armedCount}｜PWR ${poweringCount}`;
    });
}

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
function uiSeatRowEl(teamId) {
    return document.querySelector(`.team-seat-col[data-team-id="${teamId}"], .team-seat-row[data-team-id="${teamId}"]`);
}
function uiRefreshTeamModeButtons() {
    const activeId = uiCurrentTeamId();
    uiSeatIds().forEach((id) => {
        const row = uiSeatRowEl(id);
        const btn = document.getElementById(`btn-sel-${id}`);
        const live = uiIsSeatLive(id);
        if (row) {
            // New roster uses [hidden] but still occupies a grid cell via CSS.
            // Legacy seat rows toggle display when there is no #replay-team-roster.
            if (row.classList.contains('team-seat-col')) row.hidden = !live;
            else row.style.display = live ? '' : 'none';
        }
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
        // Async: show 運算中, yield paint, then AI + turn resolve (keeps spinner alive during freeze).
        uiRunPendingAIAndMaybeResolve().then((resolved) => {
            if (resolved) return;
            if (uiCurrentTeamId() === teamId) {
                const nextHuman = uiLivingTeamIds().find((id) =>
                    teams[id] && !teams[id].aiEnabled && !teams[id].ready && !teams[id].isDestroyed && id !== teamId
                );
                if (nextHuman && window.selectTeam) window.selectTeam(nextHuman);
            }
        });
        return;
    }
}
function uiToggleAI(teamId) {
    const t = teams[teamId];
    if (!t || t.ready || GameContext.isAnimating() || GameContext.isReplayMode()) return;
    GameContext.stateMachine.toggleAI(teamId);
    if (!t.aiEnabled && uiAIDebugExpandedTeam === teamId) uiAIDebugExpandedTeam = null;
    uiClearAutoAIBattleTimer();
    uiRefreshTeamModeButtons();
    uiSyncSelectionChrome(uiCurrentTeamId());
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
    uiAppendAIDecisionTrail(teamId, action);
    uiAppendAIDebugTrace(teamId, action);
    updateDashboardUI(t);
    if (!t.ready) uiRefreshPreview(t);
    uiRefreshAIDebugPanel();
    return !!action;
}
function uiMaybeRunAIAndResolve(teamId) {
    const t = teams[teamId];
    if (!t || !t.aiEnabled || t.ready || t.isDestroyed) return false;
    uiRunPendingAIAndMaybeResolve();
    return true;
}

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

/** Always-on compact decision ring buffer length (export-all / death forensics). */
const AI_DECISION_TRAIL_MAX = 40;

function uiGetAircraftForward(team) {
    if (!team || !team.wrapper || !team.wrapper.quaternion || typeof THREE === 'undefined') {
        return { forward: null, fwdY: null };
    }
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(team.wrapper.quaternion).normalize();
    return {
        forward: {
            x: Number(f.x.toFixed(3)),
            y: Number(f.y.toFixed(3)),
            z: Number(f.z.toFixed(3))
        },
        fwdY: Number(f.y.toFixed(3))
    };
}

function uiParseAltitudeLaneFromTree(tree) {
    if (!Array.isArray(tree)) return {};
    let line = null;
    for (let i = tree.length - 1; i >= 0; i--) {
        if (String(tree[i] || '').indexOf('altitudeLane:') === 0) {
            line = String(tree[i]);
            break;
        }
    }
    if (!line) return {};
    const get = (key) => {
        const m = line.match(new RegExp(`${key}=([^\\s]+)`));
        return m ? m[1] : null;
    };
    const numOrNull = (v) => (v == null || v === 'n/a' ? null : Number(v));
    return {
        lane: get('lane'),
        roofExit: numOrNull(get('roofExit')),
        straightClimb: numOrNull(get('straightClimb')),
        sky: numOrNull(get('sky')),
        facade: numOrNull(get('facade'))
    };
}

function uiBuildCompactDecisionFrame(teamId, action) {
    const team = uiGetAIDebugTeam(teamId);
    if (!team || !action) return null;
    const turn = Number((GameContext && GameContext.state && GameContext.state.currentTurn) || 0);
    const dbg = action.debug || {};
    const tree = Array.isArray(dbg.tree) ? dbg.tree : [];
    const pos = team.wrapper && team.wrapper.position ? team.wrapper.position : null;
    const fwdInfo = uiGetAircraftForward(team);
    const ur = action.urbanRoute || dbg.urbanRoute || null;
    const laneInfo = uiParseAltitudeLaneFromTree(tree);
    return {
        turn,
        state: action.state || null,
        thr: typeof action.throttle === 'number' ? action.throttle : null,
        joyX: typeof action.joyX === 'number' ? Number(action.joyX.toFixed(2)) : null,
        joyY: typeof action.joyY === 'number' ? Number(action.joyY.toFixed(2)) : null,
        ap: typeof team.ap === 'number' ? Number(team.ap.toFixed(1)) : null,
        alt: pos ? Number(pos.y.toFixed(1)) : null,
        pos: uiRoundVec3(pos),
        forward: fwdInfo.forward,
        fwdY: fwdInfo.fwdY,
        enemyDist: dbg.distance != null ? Number(dbg.distance) : null,
        coverDist: dbg.coverDistance != null ? Number(dbg.coverDistance) : null,
        coverFwd: dbg.coverForwardDistance != null ? Number(dbg.coverForwardDistance) : null,
        roof: dbg.roofClearance != null ? Number(dbg.roofClearance) : null,
        headroom: dbg.headroom != null ? Number(dbg.headroom) : null,
        risk: dbg.collisionRisk || null,
        gate: dbg.decideGate || null,
        lane: (ur && ur.lane) || laneInfo.lane || null,
        roofExit: ur && ur.roofExit != null ? ur.roofExit : laneInfo.roofExit,
        straightClimb: ur && ur.straightClimb != null ? ur.straightClimb : laneInfo.straightClimb,
        sky: laneInfo.sky,
        facade: ur && ur.facadeClosing != null ? ur.facadeClosing : laneInfo.facade,
        urbanSrc: ur && ur.source ? ur.source : null,
        urbanScore: ur && ur.score != null ? ur.score : null,
        queue: action.queueAction || 'none',
        chaff: dbg.shouldChaffNow ? 1 : 0,
        flare: dbg.shouldFlareNow ? 1 : (dbg.flare ? 1 : 0),
        chaffAmmo: dbg.chaffReserve != null ? dbg.chaffReserve : (team.chaffAmmo != null ? team.chaffAmmo : null),
        reason: action.reason || null
    };
}

function uiAppendAIDecisionTrail(teamId, action) {
    const team = uiGetAIDebugTeam(teamId);
    if (!team || !team.aiEnabled || !action) return;
    if (team.aiDecisionTrailFrozen || team.isDestroyed) return;
    if (action.state === 'destroyed') return;
    if (!Array.isArray(team.aiDecisionTrail)) team.aiDecisionTrail = [];
    const frame = uiBuildCompactDecisionFrame(teamId, action);
    if (!frame) return;
    const last = team.aiDecisionTrail[team.aiDecisionTrail.length - 1];
    if (last && last.turn === frame.turn) {
        team.aiDecisionTrail[team.aiDecisionTrail.length - 1] = frame;
    } else {
        team.aiDecisionTrail.push(frame);
    }
    if (team.aiDecisionTrail.length > AI_DECISION_TRAIL_MAX) {
        team.aiDecisionTrail.splice(0, team.aiDecisionTrail.length - AI_DECISION_TRAIL_MAX);
    }
}

function uiGetAIDecisionTrail(teamId) {
    const team = uiGetAIDebugTeam(teamId);
    if (!team || !Array.isArray(team.aiDecisionTrail)) return [];
    return team.aiDecisionTrail.slice();
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
    const fwdInfo = uiGetAircraftForward(team);
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
        deathCause: team.deathCause || (action && action.deathCause) || null,
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
            chaffAmmo: team.chaffAmmo != null ? team.chaffAmmo : 0,
            position: uiRoundVec3(pos),
            forward: fwdInfo.forward,
            fwdY: fwdInfo.fwdY
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
            deathCause: action.deathCause || team.deathCause || null,
            deathStalled: action.deathStalled != null ? action.deathStalled : (team.deathStalled ? 1 : 0),
            lastAliveState: action.lastAliveState || null,
            lastAliveStatusText: action.lastAliveStatusText || null,
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
        preDeath: team.aiPreDeathAction ? {
            state: team.aiPreDeathAction.state || null,
            statusText: team.aiPreDeathAction.statusText || null,
            reason: team.aiPreDeathAction.reason || null,
            throttle: team.aiPreDeathAction.throttle,
            joyX: team.aiPreDeathAction.joyX,
            joyY: team.aiPreDeathAction.joyY,
            weapon: team.aiPreDeathAction.weapon || null,
            queueAction: team.aiPreDeathAction.queueAction || 'none',
            debug: team.aiPreDeathAction.debug
                ? JSON.parse(JSON.stringify(team.aiPreDeathAction.debug))
                : null
        } : null,
        threatLog: Array.isArray(team.aiThreatLog) ? team.aiThreatLog.slice() : [],
        decisionTrail: uiGetAIDecisionTrail(teamId),
        deathTrail: (team.isDestroyed || (typeof team.hp === 'number' && team.hp <= 0))
            ? uiGetAIDecisionTrail(teamId)
            : null,
        trailMeta: {
            max: AI_DECISION_TRAIL_MAX,
            frozen: !!team.aiDecisionTrailFrozen,
            count: Array.isArray(team.aiDecisionTrail) ? team.aiDecisionTrail.length : 0
        },
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
    lines.push(`state: ${(snap.action && snap.action.state) || '-'}  status: ${snap.statusText || '-'}`);
    if (snap.isDestroyed) {
        const act = snap.action || {};
        lines.push(`death: cause=${act.deathCause || snap.deathCause || '-'} stalled=${act.deathStalled ?? '-'} lastAlive=${act.lastAliveState || '-'} (${act.lastAliveStatusText || '-'})`);
    }
    if (snap.aircraft) {
        const a = snap.aircraft;
        const p = a.position;
        const f = a.forward;
        lines.push(`aircraft: ap=${a.ap} heat=${a.heat} hp=${a.hp} stalled=${a.stalled} thr=${a.throttle} wpn=${a.weapon} queue=${a.queuedAction}`);
        lines.push(`position: ${p ? `x=${p.x} y=${p.y} z=${p.z}` : '-'}`);
        lines.push(`forward: ${f ? `x=${f.x} y=${f.y} z=${f.z} fwdY=${a.fwdY ?? '-'}` : '-'}`);
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
    const trail = Array.isArray(snap.decisionTrail) ? snap.decisionTrail : [];
    if (trail.length) {
        const meta = snap.trailMeta || {};
        lines.push(`decisionTrail: count=${trail.length}/${meta.max || AI_DECISION_TRAIL_MAX} frozen=${meta.frozen ? 1 : 0}`);
        trail.forEach((f) => {
            lines.push(
                `- T${f.turn} ${f.state || '-'} thr=${f.thr} joy=${f.joyX},${f.joyY} alt=${f.alt} ap=${f.ap} ` +
                `cvr=${f.coverDist}/${f.coverFwd} roof=${f.roof} risk=${f.risk} gate=${f.gate || '-'} ` +
                `src=${f.urbanSrc || '-'} sc=${f.straightClimb ?? '-'} fac=${f.facade ?? '-'}`
            );
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
            deathCause: snap.deathCause || null,
            hp: snap.aircraft ? snap.aircraft.hp : null,
            ap: snap.aircraft ? snap.aircraft.ap : null,
            wingmanOrder: snap.wingmanOrder,
            leadId: snap.leadId,
            lockedTargetId: snap.lockedTargetId,
            targetId: snap.targetId,
            state: snap.action ? snap.action.state : null,
            statusText: snap.statusText,
            trailCount: snap.trailMeta ? snap.trailMeta.count : 0,
            trailFrozen: snap.trailMeta ? !!snap.trailMeta.frozen : false
        });
    });
    return {
        schema: 'air-arena-ai-debug-roster-v2',
        exportedAt: new Date().toISOString(),
        turn,
        matchMode: matchCfg ? matchCfg.mode : null,
        arenaMode,
        unitIds: ids.slice(),
        trailMax: AI_DECISION_TRAIL_MAX,
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
    lines.push(`turn: ${dump.turn}  mode: ${dump.matchMode || '-'}  arena: ${dump.arenaMode}  trailMax=${dump.trailMax || AI_DECISION_TRAIL_MAX}`);
    lines.push(`## Roster`);
    (dump.rosterSummary || []).forEach((r) => {
        lines.push(
            `- ${String(r.id).toUpperCase()}  ${r.faction}  ${String(r.control).toUpperCase()}` +
            `  ready=${r.ready} destroyed=${r.isDestroyed}` +
            `  hp=${r.hp ?? '-'} ap=${r.ap ?? '-'}` +
            `  order=${r.wingmanOrder || '-'} lead=${r.leadId || '-'}` +
            `  target=${r.targetId || '-'} locked=${r.lockedTargetId || '-'}` +
            `  trail=${r.trailCount ?? 0}${r.trailFrozen ? 'F' : ''}` +
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
        showSMSAlert(`全機決策已複製 + 下載 (${roster.unitIds.length}機, 含自動軌跡)`, '#00ff88');
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
    // Per-team copy/download/record UI removed; roster export remains on the replay bar.
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
    showSMSAlert(`${teamId.toUpperCase()} 完整錄製 ${team.aiDebugRecording ? '開始' : '停止'}（自動軌跡仍持續）`, team.aiDebugRecording ? '#00ff88' : '#ffbb00');
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

    if (t.isDestroyed || (typeof t.hp === 'number' && t.hp <= 0)) {
        const deadLabel = (t.aiLastAction && t.aiLastAction.statusText) || t.aiStatusText || '被擊墜';
        const deadReason = (t.aiLastAction && t.aiLastAction.reason) || '';
        const deadCause = (t.aiLastAction && t.aiLastAction.deathCause) || t.deathCause || 'combat';
        const lastAlive = (t.aiLastAction && t.aiLastAction.lastAliveState)
            || (t.aiPreDeathAction && t.aiPreDeathAction.state)
            || '-';
        const deadTree = (t.aiLastAction && t.aiLastAction.debug && Array.isArray(t.aiLastAction.debug.tree))
            ? t.aiLastAction.debug.tree
            : ((t.aiPreDeathAction && t.aiPreDeathAction.debug && Array.isArray(t.aiPreDeathAction.debug.tree))
                ? t.aiPreDeathAction.debug.tree.concat([`--- death ---`, deadLabel, `deathCause=${deadCause}`])
                : [deadLabel]);
        return `<div>${teamId.toUpperCase()} | ${deadLabel}</div>` +
            `<div>HP 0  STATE DESTROYED  CAUSE ${String(deadCause).toUpperCase()}  LAST ${String(lastAlive).toUpperCase()}${deadReason ? `  ${deadReason}` : ''}</div>` +
            `<div>TREE (pre-death preserved):</div><div class="ai-tree">- ${deadTree.join('\n- ')}</div>` +
            uiThreatLogHtml(t);
    }

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
        `<div>PICK ${(policy.selectedState || dbg.mode || '-').toUpperCase()}  BASE ${(policy.baseState || '-').toUpperCase()}  SCORE ${policy.selectedScore ?? '-'}</div>` +
        `<div>SAFETY ${safety.overridden ? 'OVERRIDE' : 'OK'}  SEL ${(safety.selected || '-').toUpperCase()}  MINALT ${safety.minAlt ?? '-'}  AP ${safety.finalAP ?? '-'}  BLDG ${safety.buildingHit ? 'HIT' : 'CLEAR'}  FWDY ${safety.finalForwardY ?? '-'}  LOOP ${safety.climbLoopRisk ? 'YES' : 'NO'}</div>` +
        `<div>FLARE ${dbg.flareReserve ?? '-'}  CD ${dbg.flareCooldown ? 'WAIT' : 'READY'}  ACT-MSL ${dbg.actualMissileThreat ? 'YES' : 'NO'}</div>` +
        `<div>TREE:</div><div class="ai-tree">` + treeText + `</div>` +
        uiThreatLogHtml(t);
}
function uiPositionAIDebugPanel(teamId) {
    const panel = document.getElementById('ai-debug-panel');
    const bar = document.getElementById('replay-control-bar');
    const body = document.getElementById('ai-debug-body');
    if (!panel) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const isMobile = viewportWidth <= 768;
    const panelWidth = panel.offsetWidth || Math.min(isMobile ? viewportWidth * 0.94 : 480, viewportWidth - 16);

    let left = (viewportWidth - panelWidth) / 2;
    let top = 140;

    // Always clear the whole replay/seat bar so 待機中／規劃中 stay clickable.
    if (bar && bar.getClientRects().length) {
        const barRect = bar.getBoundingClientRect();
        top = Math.ceil(barRect.bottom + 8);
        left = barRect.left + (barRect.width / 2) - (panelWidth / 2);
    }

    // Desktop: nudge horizontally toward the clicked seat button, still under the bar.
    if (!isMobile && teamId) {
        const anchor = document.getElementById(`btn-engage-${teamId}`);
        if (anchor && anchor.getClientRects().length) {
            const rect = anchor.getBoundingClientRect();
            left = rect.left + (rect.width / 2) - (panelWidth / 2);
        }
    }

    left = Math.max(8, Math.min(viewportWidth - panelWidth - 8, left));

    // Reserve bottom cockpit HUD on phones so the tree doesn't swallow the screen.
    const bottomReserve = isMobile
        ? Math.max(150, Math.round(viewportHeight * 0.2))
        : 28;
    const maxH = Math.max(140, viewportHeight - top - bottomReserve);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.maxHeight = `${Math.round(maxH)}px`;

    if (body) {
        const header = panel.querySelector('.ai-debug-header');
        const wing = document.getElementById('ai-debug-wingman');
        const chrome = (header ? header.offsetHeight : 36)
            + (wing && !wing.hidden ? wing.offsetHeight + 8 : 0)
            + 16;
        body.style.maxHeight = `${Math.max(96, Math.round(maxH - chrome))}px`;
    }
}
function uiRefreshAIDebugPanel() {
    const panel = document.getElementById('ai-debug-panel');
    const body = document.getElementById('ai-debug-body');
    const title = document.getElementById('ai-debug-title');
    const content = document.getElementById('ai-debug-content');
    if (!panel || !body || !title || !content) return;

    const teamId = uiAIDebugExpandedTeam;
    const team = teamId ? teams[teamId] : null;
    const isOpen = !!(teamId && team && team.aiEnabled);

    panel.style.display = isOpen ? 'flex' : 'none';
    if (!isOpen) {
        uiRefreshAIDebugWingmanOrders(null);
        return;
    }

    body.style.display = 'grid';
    title.innerText = `${teamId.toUpperCase()} NPC 決策樹`;
    content.innerHTML = uiFormatAIDebug(teamId);
    uiRefreshAIDebugWingmanOrders(teamId);
    uiPositionAIDebugPanel(teamId);
}
function uiToggleAIDebugForTeam(teamId) {
    const t = teams[teamId];
    if (!t || !t.aiEnabled) return;
    uiAIDebugExpandedTeam = (uiAIDebugExpandedTeam === teamId) ? null : teamId;
    if (uiAIDebugExpandedTeam && uiIsReplayMainCollapsed()) uiSetReplayMainCollapsed(false);
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
    const cfg = GameContext.getMatchConfig ? GameContext.getMatchConfig() : null;
    if (cfg) uiSyncSpawnSelects(cfg.spawnAltitude, cfg.spawnSeparation);
}

function uiApplyArenaMode(mode) {
    if (!GameContext || !GameContext.setArenaMode) return;
    const applied = GameContext.setArenaMode(mode);
    uiRefreshArenaModePanel();
    if (CONFIG.debug) console.log(`[UI] 場地模式切換: ${applied}`);
}

function uiApplyArenaSpawnFromPanel() {
    if (GameContext.isAnimating && GameContext.isAnimating()) {
        if (typeof showSMSAlert === 'function') showSMSAlert('動畫中無法套用起飛位置', '#ffaa00');
        return false;
    }
    const altEl = document.getElementById('arena-spawn-alt');
    const sepEl = document.getElementById('arena-spawn-sep');
    const altitude = uiSanitizeSpawnAltitude(altEl ? altEl.value : 45);
    const separation = uiSanitizeSpawnSeparation(sepEl ? sepEl.value : 100);
    uiMatchSetupState.spawnAltitude = altitude;
    uiMatchSetupState.spawnSeparation = separation;
    uiSyncSpawnSelects(altitude, separation);
    const sm = GameContext.stateMachine;
    if (!sm || typeof sm.applySpawnLayout !== 'function') return false;
    const applied = sm.applySpawnLayout({ altitude, separation });
    const ids = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || ['red', 'blue'];
    ids.forEach((id) => {
        if (typeof sm.faceOpponent === 'function') sm.faceOpponent(id);
        const t = GameContext.getTeam(id);
        if (t && typeof window.updateTacticalPreview === 'function') window.updateTacticalPreview(t);
    });
    if (typeof showSMSAlert === 'function') {
        showSMSAlert(`起飛位置: ALT ${applied.altitude}m · SEP ${applied.separation}m`, '#00ff88');
    }
    return true;
}

let isDraggingJoystick = false;
let joyGrabOffsetX = 0;
let joyGrabOffsetY = 0;
let isDraggingRollRing = false;
let initialMouseAngle = 0; 
let initialRingRoll = 0;   
window.lastRenderedTeamId = null;

document.addEventListener("DOMContentLoaded", () => {
    uiApplyDevPanelVisibility();
    if (CONFIG.debug) console.log("✈️ UI Manager initialized.");

    uiSeatIds().forEach((id) => uiBindSeatControls(id));
    uiBindWingmanOrderHudOnce();
    uiBindAIDebugWingmanOnce();
    uiBindReplayMainCollapseOnce();
    uiSetControlsVisible(false);
    uiRefreshTeamModeButtons();
    uiRefreshSeatVitals();

    const btnAIDebugExportAll = document.getElementById('btn-ai-debug-export-all');
    if (btnAIDebugExportAll) btnAIDebugExportAll.addEventListener('click', () => { uiExportAllAIDebug(); });
    const arenaModeSelect = document.getElementById('arena-mode-select');
    if (arenaModeSelect) arenaModeSelect.addEventListener('change', (e) => uiApplyArenaMode(e.target.value));
    const btnArenaSpawn = document.getElementById('btn-arena-apply-spawn');
    if (btnArenaSpawn) btnArenaSpawn.addEventListener('click', () => uiApplyArenaSpawnFromPanel());
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

    // 🌟 SMS 武器切換（wrap 在鎖定警報時仍可點／hover 看原狀態）
    let smsContent = document.getElementById('sms-text-content');
    let smsWrap = document.getElementById('sms-text-wrap') || smsContent;
    if(smsWrap) smsWrap.addEventListener('click', () => {
        let currentTeam = uiCurrentTeamId();
        let t = teams[currentTeam]; 
        if (!t || t.aiEnabled || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed || t.ready) return;
        
        const nextWeapon = GameContext.stateMachine.toggleWeaponMode(currentTeam);
        if (nextWeapon === 'missile') {
            const live = typeof teamLiveMissileType === 'function' ? teamLiveMissileType(t) : null;
            showSMSAlert(
                live === 'fox1'
                    ? '🚀 FOX-1 半主動雷達通電中... [請點擊掛架開機]'
                    : '🚀 FOX-2 飛彈系統通電中... [請點擊掛架開機]',
                '#ffbb00'
            );
        } else {
            showSMSAlert("⚠️ 主保險關閉：切換至機砲模式", "#ff0055");
        }
        updateDashboardUI(t); 
        uiRefreshPreview(t);
    });

    // 🌟 掛架控制（可不經 SMS 飛彈模式，直接點掛架開始通電）
    document.querySelectorAll('.pylon-switch-wrapper').forEach(el => {
        el.addEventListener('click', (e) => {
            let currentTeam = uiCurrentTeamId();
            let t = teams[currentTeam]; 
            if (!t || t.aiEnabled || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed || t.ready) return;
            
            if (!t.pylons) { showSMSAlert("🛑 掛架系統尚未初始化", "#ff0055"); return; }
            let pylonId = parseInt(e.currentTarget.getAttribute('data-pylon'));
            let p = t.pylons.find(item => item.id === pylonId);
            if (!p || p.state === 'empty') { showSMSAlert("🛑 警告：該掛架彈藥耗盡", "#ff0055"); return; }
            // Clicking a pylon implies missile employment — auto-arm SMS if still on gun.
            let switchedToMissile = false;
            if (t.weapon !== 'missile') {
                if (!GameContext.stateMachine.setWeaponMode(currentTeam, 'missile')) return;
                switchedToMissile = true;
            }
            const nextState = GameContext.stateMachine.togglePylonPower(currentTeam, pylonId);
            if (nextState === 'powering') {
                showSMSAlert(
                    switchedToMissile
                        ? `🚀 飛彈模式｜PYLON ${pylonId} 開始開機通電`
                        : `⚡ PYLON ${pylonId} 開始開機通電`,
                    "#ffbb00"
                );
            } else if (nextState === 'standby') {
                showSMSAlert(`ℹ️ PYLON ${pylonId} 電源切斷`, "#aaa");
            }
            updateDashboardUI(t); 
            uiRefreshPreview(t);
        });
    });

    // 🌟 武器確認發射（SMS ENT / LCOS 瞄準環雙擊共用）
    let btnEnt = document.getElementById('sms-enter-btn');
    if(btnEnt) btnEnt.addEventListener('click', () => {
        uiToggleWeaponFireQueue();
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

    const btnChaff = document.getElementById('btn-chaff');
    if (btnChaff) {
        btnChaff.addEventListener('click', () => {
            let currentTeam = uiCurrentTeamId();
            let t = teams[currentTeam];
            if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return;
            if ((t.chaffAmmo || 0) <= 0) { showSMSAlert('🛑 CHAFF EMPTY', '#ff0055'); return; }
            const wasArmed = !!t.chaffArmed;
            if (GameContext.stateMachine.toggleChaff) GameContext.stateMachine.toggleChaff(currentTeam);
            showSMSAlert(wasArmed ? '⚠️ 箔條解除' : '📡 箔條干擾排程中', wasArmed ? '#aaa' : '#00e5ff');
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
    isDraggingJoystick = true;

    // Relative grab: keep current stick; do not snap/center on pointer-down.
    const joyZone = document.getElementById('joystick-zone');
    if (joyZone) {
        const rect = joyZone.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const maxRadius = Math.max(8, rect.width / 2 - 15);
        const curX = (Number(t.joyX) || 0) * maxRadius;
        const curY = -(Number(t.joyY) || 0) * maxRadius;
        joyGrabOffsetX = e.clientX - (centerX + curX);
        joyGrabOffsetY = e.clientY - (centerY + curY);
    } else {
        joyGrabOffsetX = 0;
        joyGrabOffsetY = 0;
    }
}
function doJoystickDrag(e) { if (!isDraggingJoystick) return; updateJoystickPosition(e); }
function endJoystickDrag() { isDraggingJoystick = false; joyGrabOffsetX = 0; joyGrabOffsetY = 0; }

function updateJoystickPosition(e) {
    const joyZone = document.getElementById('joystick-zone'); const joyHandle = document.getElementById('joystick-handle');
    if (!joyZone || !joyHandle) return;
    const rect = joyZone.getBoundingClientRect(); const centerX = rect.left + rect.width / 2; const centerY = rect.top + rect.height / 2; const maxRadius = rect.width / 2 - 15; 
    let dx = e.clientX - centerX - joyGrabOffsetX; let dy = e.clientY - centerY - joyGrabOffsetY; let dist = Math.sqrt(dx * dx + dy * dy);
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

    const stallScreen = document.getElementById('stall-screen');
    if (stallScreen) {
        stallScreen.style.display = teamObj.stalled && !teamObj.isDestroyed ? 'flex' : 'none';
    }

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
    // Gauge scale matches CONFIG.rules.maxAp (was hard-capped at 250 → 250–300 looked "stuck").
    if (apNeedle) {
        let maxGaugeAP = (typeof MAX_AP === 'number' && MAX_AP > 0) ? MAX_AP : 300;
        let deg = -90 + (previewAp / maxGaugeAP) * 180; if (isNaN(deg)) deg = -90; deg = Math.max(-90, Math.min(90, deg));
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
        isLocked = teamObj.weapon === 'gun'
            ? (distance <= (typeof GUN_RANGE !== 'undefined' ? GUN_RANGE : 70) && angle <= Math.PI/12)
            : (() => {
                const live = typeof teamLiveMissileType === 'function' ? teamLiveMissileType(teamObj) : 'fox2';
                if (live === 'fox1') {
                    const cfg = typeof getMissileWeaponConfig === 'function' ? getMissileWeaponConfig('fox1') : (CONFIG.weapons.fox1 || {});
                    const minR = Number(cfg.minArmingRange) || 70;
                    const maxR = Number(cfg.seekerRange) || 200;
                    return distance >= minR && distance <= maxR && angle <= (Number(cfg.seekerAngle) || Math.PI / 14);
                }
                return distance <= (typeof SEEKER_RANGE !== 'undefined' ? SEEKER_RANGE : 120) && angle <= Math.PI/12;
            })();
    }

    let elSmsContent = document.getElementById('sms-text-content');
    if (elSmsContent) {
        const liveType = teamObj.weapon === 'missile'
            ? (typeof teamLiveMissileType === 'function' ? teamLiveMissileType(teamObj) : 'fox2')
            : null;
        let wpnName = teamObj.weapon === 'gun' ? '機砲' : (liveType === 'fox1' ? 'FOX-1' : 'FOX-2');
        let statusText = '[就緒]';
        if (teamObj.wpnQueued) { statusText = '[已排程]'; } 
        else if (teamObj.weapon === 'missile') {
            let armedCount = teamObj.pylons ? teamObj.pylons.filter(p => p.state === 'armed').length : 0; let poweringCount = teamObj.pylons ? teamObj.pylons.filter(p => p.state === 'powering').length : 0;
            statusText = armedCount > 0 ? (isLocked ? '[已鎖定]' : '[就緒]') : (poweringCount > 0 ? '[開機中]' : '[未通電]');
        } else { statusText = isLocked ? '[已鎖定]' : '[就緒]'; wpnName = `機砲 [INF]`; }
        elSmsContent.innerText = `狀態 ${statusText} ${wpnName}`;
        elSmsContent.style.color = '#ffeb3b';
    }
    uiUpdateSmsRadarLockWarn(teamObj);

    if (teamObj.pylons) {
        teamObj.pylons.forEach(p => {
            let stick = document.getElementById(`pylon-stick-${p.id}`);
            let label = document.querySelector(`.pylon-switch-wrapper[data-pylon="${p.id}"] .pylon-label`);
            const wLabel = (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : p.weaponType) === 'fox1' ? 'F1' : 'F2';
            if (label) label.innerText = `PYLON ${p.id} ${wLabel}`;
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

    const btnChaff = document.getElementById('btn-chaff');
    if (btnChaff) {
        const ammo = Number(teamObj.chaffAmmo) || 0;
        if (ammo <= 0) {
            btnChaff.innerText = 'CHAFF [0]';
            btnChaff.style.color = '#555';
            btnChaff.style.borderColor = '#333';
            btnChaff.style.background = '#111';
            btnChaff.style.boxShadow = 'none';
        } else if (teamObj.chaffArmed) {
            btnChaff.innerText = `CHAFF [${ammo}]`;
            btnChaff.style.color = '#fff';
            btnChaff.style.borderColor = '#00e5ff';
            btnChaff.style.background = '#0088aa';
            btnChaff.style.boxShadow = '0 0 12px #00e5ff';
        } else {
            btnChaff.innerText = `CHAFF [${ammo}]`;
            btnChaff.style.color = '#00e5ff';
            btnChaff.style.borderColor = '#00e5ff';
            btnChaff.style.background = '#111';
            btnChaff.style.boxShadow = 'none';
        }
    }

    // 🌟 每機獨立待命／AI 狀態按鈕（文案去掉 NPC: 前綴；寬度由席位 1/4 欄位限制）
    uiSeatIds().forEach((id) => {
        let btnEngage = document.getElementById(`btn-engage-${id}`);
        let t = teams[id];
        if (!btnEngage || !t || !uiIsSeatLive(id)) return;
        const faction = (GameContext.getFaction && GameContext.getFaction(id)) || id;
        if (t.aiEnabled) {
            if (t.isDestroyed || (typeof t.hp === 'number' && t.hp <= 0)) {
                btnEngage.innerText = (t.aiLastAction && t.aiLastAction.statusText) || t.aiStatusText || '被擊墜';
                btnEngage.title = '點擊打開／收合決策卷軸';
            } else {
                const action = t.aiLastAction;
                const detail = action ? ` | THR ${action.throttle || '-'} | ${action.weapon ? action.weapon.toUpperCase() : 'GUN'}` : '';
                const label = `${uiStripNpcStatusPrefix(t.aiStatusText || '待機中')}${detail}`;
                btnEngage.innerText = label;
                btnEngage.title = `${label}\n點擊打開／收合決策卷軸`;
            }
            btnEngage.style.borderColor = '#ffbb00';
            btnEngage.style.color = '#ffbb00';
            btnEngage.style.boxShadow = '0 0 10px rgba(255,187,0,0.65), inset 0 0 5px rgba(255,187,0,0.35)';
            btnEngage.style.cursor = 'pointer';
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
    uiRefreshSeatVitals();
    uiRefreshAIDebugPanel();
}

function showSMSAlert(text, color) {
    let elSmsContent = document.getElementById('sms-text-content');
    if (elSmsContent) {
        elSmsContent.innerText = text; elSmsContent.style.color = color || '#00ff88';
        // Temporary alerts should be readable even during radar-lock marquee.
        const wrap = document.getElementById('sms-text-wrap');
        if (wrap) wrap.classList.add('sms-alert-force');
        if(window.smsAlertTimeout) clearTimeout(window.smsAlertTimeout);
        window.smsAlertTimeout = setTimeout(() => { 
            let currentTeam = uiCurrentTeamId(); 
            let t = teams[currentTeam]; 
            if (wrap) wrap.classList.remove('sms-alert-force');
            if(t) { elSmsContent.style.color = '#ffeb3b'; updateDashboardUI(t); } 
        }, 1800);
    }
}

/**
 * True when a hostile SARH (FOX-1) illuminate gate currently paints this aircraft.
 * Used for SMS 「被鎖定」 warning — no aim-ring jitter.
 */
function uiEvalHostileSarhLock(selfTeam) {
    if (!selfTeam || selfTeam.isDestroyed || !selfTeam.wrapper || typeof computeSarhSupport !== 'function') {
        return { locked: false, by: null };
    }
    if (typeof THREE === 'undefined') return { locked: false, by: null };
    const selfId = selfTeam.id;
    const selfPos = selfTeam.wrapper.position;
    const hostiles = (typeof GameContext !== 'undefined' && GameContext.getHostileIds)
        ? GameContext.getHostileIds(selfId).map((id) => GameContext.getTeam(id)).filter(Boolean)
        : [];
    const typeOf = (p) => (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : (p && p.weaponType) || 'fox2');
    for (let i = 0; i < hostiles.length; i++) {
        const foe = hostiles[i];
        if (!foe || foe.isDestroyed || !foe.wrapper) continue;
        const hasFox1Missile = (foe.activeMissiles || []).some(
            (m) => m && m.missileType === 'fox1' && m.active && !m.exploded && Number(m.ap) > 0
        );
        const hasFox1Load = (foe.pylons || []).some((p) => p && p.state !== 'empty' && typeOf(p) === 'fox1');
        if (!hasFox1Missile && !hasFox1Load) continue;
        let losBlocked = false;
        if (typeof obstacles !== 'undefined' && obstacles && obstacles.length) {
            const dir = selfPos.clone().sub(foe.wrapper.position);
            const dist = dir.length();
            if (dist > 0.2) {
                const ray = new THREE.Raycaster(foe.wrapper.position, dir.normalize(), 0.1, dist);
                losBlocked = ray.intersectObjects(obstacles, true).length > 0;
            }
        }
        const chaffList = (typeof globalChaff !== 'undefined' && Array.isArray(globalChaff))
            ? globalChaff.map((c) => ({ pos: c.pos, ageSteps: c.ageSteps || c.age || 0 }))
            : [];
        const support = computeSarhSupport({
            shooterPos: foe.wrapper.position,
            shooterQuat: foe.wrapper.quaternion,
            targetPos: selfPos,
            chaffList,
            step: (typeof performance !== 'undefined' ? performance.now() * 0.06 : 0),
            losBlocked
        });
        if (support && support.supported) {
            return { locked: true, by: foe.id, support };
        }
    }
    return { locked: false, by: null };
}

function uiUpdateSmsRadarLockWarn(selfTeam) {
    const wrap = document.getElementById('sms-text-wrap');
    const warn = document.getElementById('sms-lock-warn');
    if (!wrap || !warn) return false;
    const evalLock = uiEvalHostileSarhLock(selfTeam);
    const locked = !!(evalLock && evalLock.locked) && !!(selfTeam && !selfTeam.aiEnabled);
    wrap.classList.toggle('is-radar-locked', locked);
    warn.hidden = !locked;
    warn.setAttribute('aria-hidden', locked ? 'false' : 'true');
    if (locked && evalLock.by) wrap.dataset.lockBy = String(evalLock.by);
    else delete wrap.dataset.lockBy;
    return locked;
}

/** Toggle gun fire / missile launch queue for the active human seat (SMS ENT + LCOS double-tap). */
function uiToggleWeaponFireQueue(teamId = null) {
    const currentTeam = teamId || uiCurrentTeamId();
    const t = teams[currentTeam];
    if (!t || t.aiEnabled || GameContext.isAnimating() || GameContext.isReplayMode() || t.isDestroyed || t.ready) {
        return false;
    }

    if (t.weapon === 'gun') {
        const wasQueued = t.wpnQueued && t.queuedAction === 'gun';
        if (!wasQueued && GameContext.stateMachine.isGunOverheated(currentTeam)) {
            showSMSAlert('🔥 機砲過熱！停火冷卻', '#ff4400');
            updateDashboardUI(t);
            return false;
        }
        const ok = GameContext.stateMachine.toggleGunQueue(currentTeam);
        if (!ok && !wasQueued) {
            showSMSAlert('🔥 機砲過熱！停火冷卻', '#ff4400');
        } else {
            showSMSAlert(wasQueued ? '⚠️ 機砲保險已關閉' : '⚡ 機砲射擊線已通電', wasQueued ? '#aaa' : '#00ff88');
        }
    } else {
        const armedCount = t.pylons ? t.pylons.filter((item) => item.state === 'armed').length : 0;
        const poweringCount = t.pylons ? t.pylons.filter((item) => item.state === 'powering').length : 0;
        if (armedCount > 0) {
            const wasQueued = t.wpnQueued && t.queuedAction === 'missile';
            const liveType = typeof pylonWeaponType === 'function'
                ? pylonWeaponType(t.pylons.find((p) => p.state === 'armed'))
                : 'fox2';
            const ok = GameContext.stateMachine.toggleMissileQueue(currentTeam);
            if (!wasQueued && !ok && liveType === 'fox1') {
                showSMSAlert('🛑 FOX-1 需在 70–200m 內鎖定', '#ff0055');
            } else {
                const label = liveType === 'fox1' ? 'FOX-1' : 'FOX-2';
                showSMSAlert(
                    wasQueued ? `⚠️ ${label} 發射排程已取消` : `⚡ ${label} 排程鎖定 (${armedCount} 枚)`,
                    wasQueued ? '#aaa' : '#00ffff'
                );
            }
        } else if (poweringCount > 0) {
            showSMSAlert('🛑 尋標頭開機中！', '#ffbb00');
        } else {
            GameContext.stateMachine.clearQueuedAction(currentTeam);
            showSMSAlert('🛑 無掛架就緒', '#ff0055');
        }
    }
    updateDashboardUI(t);
    uiRefreshPreview(t);
    return true;
}
window.uiToggleWeaponFireQueue = uiToggleWeaponFireQueue;

// ----------------------------------------------------------------------------
// Event Bus: EnginePhaseChanged (ui.js 結構整理：事件處理邏輯抽成函式)
// ----------------------------------------------------------------------------
function uiOnEnginePhaseChanged(e) {
    const data = e.detail;
    let dashboard = document.getElementById('ui-dashboard');
    let repStatus = document.getElementById('replay-status');
    let repSlider = document.getElementById('replay-slider');

    switch(data.phase) {
        case 'calculating':
            uiClearAutoAIBattleTimer();
            uiShowComputingOverlay(
                (document.getElementById('compute-lock-sub') && document.getElementById('compute-lock-sub').textContent) ||
                '戰術結算中…'
            );
            if(repStatus) { repStatus.innerText = "狀態: 運算中"; repStatus.style.color = "#ffcc66"; }
            break;
        case 'playing':
            uiClearAutoAIBattleTimer();
            uiHideComputingOverlay();
            if(repStatus) { repStatus.innerText = "狀態: 播放中"; repStatus.style.color = "#aaa"; }
            if(repSlider) { 
                repSlider.min = 1; 
                repSlider.max = data.maxLog + 0.99; 
                repSlider.step = 0.01; 
                repSlider.disabled = false; 
            }
            uiSyncSelectionChrome(uiCurrentTeamId());
            break;
        case 'planning':
            uiHideComputingOverlay();
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
            uiHideComputingOverlay();
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
    },
    getDecisionTrail(teamId) {
        return uiGetAIDecisionTrail(teamId || uiAIDebugExpandedTeam);
    },
    trailMax: AI_DECISION_TRAIL_MAX
};