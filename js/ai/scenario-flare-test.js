// ============================================================================
// scenario-flare-test.js — 開闊高空飛彈 vs 熱焰測試（URL 啟動）
//
// 用法:
//   ?scenario=flare-test
//   ?scenario=flare-test&defender=ai     → BLUE AI 自動嘗試 flare
//   ?scenario=flare-test&defender=player → BLUE 玩家手動按 FLARE（預設）
//   建議加 &dev=1
// ============================================================================

(function () {
    const SCENARIO_IDS = new Set(['flare-test', 'missile-flare', 'missile-duel']);
    // High open-sky: start inside FOX-2 envelope so the first exchange is missile vs flare, not a merge knife-fight.
    const ALT = 70;
    const HALF_SEP = 52;

    function readParams() {
        if (typeof window === 'undefined') return new URLSearchParams();
        return new URLSearchParams(window.location.search);
    }

    function getScenarioId() {
        const id = readParams().get('scenario') || '';
        return SCENARIO_IDS.has(id) ? id : '';
    }

    function getDefenderMode() {
        const mode = (readParams().get('defender') || 'player').toLowerCase();
        return mode === 'ai' ? 'ai' : 'player';
    }

    function isActive() {
        return !!getScenarioId();
    }

    function clearAiRecoveryMemory() {
        const ai = typeof window !== 'undefined' ? window.AirArenaAI : null;
        if (!ai) return;
        ai.lowAltRecoveryMemory = {};
        ai.postGroundRecoveryMemory = {};
        ai.weaponRangeMemory = {};
        ai.urbanAvoidMemory = {};
        ai.loopMemory = {};
    }

    function placeTeam(teamId, x, y, z, yaw) {
        const t = typeof teams !== 'undefined' ? teams[teamId] : null;
        if (!t || !t.wrapper || typeof THREE === 'undefined') return;
        t.wrapper.position.set(x, y, z);
        t.wrapper.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
        t.wrapper.userData.logicalQuat = t.wrapper.quaternion.clone();
        if (typeof initialPositions !== 'undefined' && initialPositions[teamId]) {
            initialPositions[teamId].pos.set(x, y, z);
            initialPositions[teamId].quat.copy(t.wrapper.quaternion);
        }
        t.startPos = t.wrapper.position.clone();
        t.startQuat = t.wrapper.quaternion.clone();
    }

    function armMissiles(teamId, count = 1) {
        const t = typeof teams !== 'undefined' ? teams[teamId] : null;
        if (!t || !Array.isArray(t.pylons)) return;
        let armed = 0;
        t.pylons.forEach((p) => {
            if (armed >= count) return;
            if (p.state === 'empty') return;
            p.state = 'armed';
            if (p.mesh) p.mesh.visible = true;
            armed += 1;
        });
    }

    function resetCombatState(teamId) {
        const t = typeof teams !== 'undefined' ? teams[teamId] : null;
        if (!t) return;
        t.hp = typeof MAX_HP !== 'undefined' ? MAX_HP : 100;
        t.isDestroyed = false;
        t.ap = 130;
        t.speed = 130;
        t.heat = 0;
        t.flameout = false;
        t.stalled = false;
        t.ready = false;
        t.wpnQueued = false;
        t.queuedAction = 'none';
        t.flaresArmed = false;
        // Extra flares for a longer open-sky duel observation window.
        t.flareAmmo = Math.max(
            5,
            (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.flare)
                ? CONFIG.weapons.flare.maxAmmo
                : 3
        );
        t.aiLastFlareTurn = -99;
        t.aiThreatLog = [];
        t.aiThreatActive = false;
        t.activeMissiles = [];
        t.throttle = 4;
        t.chain = [{ yaw: 0, pitch: 0, roll: 0, throttle: t.throttle, fire: 'none' }];
        if (typeof GameContext !== 'undefined' && GameContext.stateMachine && GameContext.stateMachine.clearQueuedAction) {
            GameContext.stateMachine.clearQueuedAction(teamId);
        }
    }

    function configureAttacker() {
        const t = teams.red;
        if (!t) return;
        resetCombatState('red');
        t.aiEnabled = true;
        t.aiManualOverride = 'missile';
        t.aiPolicyMode = 'heuristic';
        t.weapon = 'missile';
        t.aiState = 'npc';
        t.aiStatusText = 'NPC: 飛彈測試-迎頭';
        armMissiles('red', 2);
    }

    function configureDefender() {
        const t = teams.blue;
        if (!t) return;
        resetCombatState('blue');
        const defender = getDefenderMode();
        if (defender === 'ai') {
            t.aiEnabled = true;
            t.aiManualOverride = 'auto';
            t.aiPolicyMode = 'heuristic';
            t.weapon = 'gun';
            t.aiState = 'npc';
            t.aiStatusText = 'NPC: 熱焰測試-防守';
        } else {
            t.aiEnabled = false;
            t.aiManualOverride = 'auto';
            t.weapon = 'gun';
            t.aiState = 'player';
            t.aiStatusText = 'PLAYER CONTROL';
        }
    }

    function refreshPreviewPaths() {
        ['red', 'blue'].forEach((id) => {
            const t = teams[id];
            if (!t || !t.wrapper || typeof simulateFlight !== 'function') return;
            const res = simulateFlight(t, t.chain);
            t.pathPoints = res.points;
            t.pathQuats = res.quats;
        });
    }

    function showBanner() {
        const el = document.getElementById('scenario-test-banner');
        if (!el) return;
        const defender = getDefenderMode();
        el.style.display = 'block';
        el.innerHTML =
            '<strong>SCENARIO: HIGH OPEN-SKY MISSILE / FLARE</strong><br>' +
            `RED AI 迎頭 + FORCE MISSILE｜空白場｜高度 ${ALT}m｜距離 ~${HALF_SEP * 2}m<br>` +
            (defender === 'ai'
                ? 'BLUE = AI（看 <code>flareNow=1</code> / <code>defensiveFlare</code>）'
                : 'BLUE = 玩家：選 BLUE → <code>FLARE</code> → 雙方 READY') +
            '<br><span class="scenario-hint">?scenario=flare-test&amp;defender=player|ai&amp;dev=1</span>';
    }

    function applyScenario() {
        if (!isActive()) return false;
        if (typeof GameContext === 'undefined' || !teams || !teams.red || !teams.blue) return false;
        if (!teams.red.wrapper || !teams.blue.wrapper) return false;

        if (GameContext.setArenaMode) {
            GameContext.setArenaMode('blank');
        }
        try {
            window.localStorage && window.localStorage.setItem('airArenaArenaMode', 'blank');
        } catch (_) {}
        const arenaSelect = document.getElementById('arena-mode-select');
        if (arenaSelect) arenaSelect.value = 'blank';
        if (typeof uiRefreshArenaModePanel === 'function') {
            uiRefreshArenaModePanel();
        }

        clearAiRecoveryMemory();
        // Head-on high merge: stay above combat band so pull-up/postGround do not steal the duel.
        placeTeam('red', 0, ALT, -HALF_SEP, 0);
        placeTeam('blue', 0, ALT, HALF_SEP, Math.PI);

        configureAttacker();
        configureDefender();
        // Keep both sides in missile range-mode so open-sky gun hysteresis does not steal the duel.
        if (typeof window !== 'undefined' && window.AirArenaAI && window.AirArenaAI.weaponRangeMemory) {
            window.AirArenaAI.weaponRangeMemory.red = 'missile';
            window.AirArenaAI.weaponRangeMemory.blue = 'missile';
        }
        refreshPreviewPaths();

        if (typeof uiRefreshTeamModeButtons === 'function') uiRefreshTeamModeButtons();
        if (typeof uiRefreshAIDebugPanel === 'function') uiRefreshAIDebugPanel();
        showBanner();

        // Scenario sets aiEnabled directly — must kick the both-AI planner (toggleAI path does this).
        if (teams.red.aiEnabled && teams.blue.aiEnabled) {
            if (typeof window.uiKickBothAIBattle === 'function') {
                window.uiKickBothAIBattle(true);
            } else if (typeof uiScheduleBothAITurn === 'function') {
                uiScheduleBothAITurn();
            }
        }

        if (typeof showSMSAlert === 'function') {
            const defender = getDefenderMode();
            showSMSAlert(
                defender === 'ai'
                    ? 'FLARE TEST: RED 飛彈 AI vs BLUE 防守 AI'
                    : 'FLARE TEST: RED 飛彈 AI vs 玩家手動 FLARE',
                '#ffbb00'
            );
        }

        if (typeof CONFIG !== 'undefined' && CONFIG.debug) {
            console.log('[Scenario] flare-test applied', {
                defender: getDefenderMode(),
                red: teams.red.wrapper.position.toArray(),
                blue: teams.blue.wrapper.position.toArray()
            });
        }
        return true;
    }

    window.AirArenaScenario = {
        isActive,
        getScenarioId,
        getDefenderMode,
        apply: applyScenario
    };
})();
