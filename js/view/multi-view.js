// ============================================================================
// multi-view.js - Team chase-cam panes (toggle via seat buttons; auto-close on crash)
// ============================================================================
(function initAirArenaMultiView(root) {
    const MAX_PANES = 4;
    const camerasByTeam = Object.create(null);

    function state() {
        return (typeof GameContext !== 'undefined' && GameContext.state) ? GameContext.state : null;
    }

    function ensureState() {
        const st = state();
        if (!st) return null;
        if (!Array.isArray(st.viewPaneIds)) st.viewPaneIds = [];
        if (!Array.isArray(st.viewPaneIdsSaved)) {
            st.viewPaneIdsSaved = st.viewPaneIds.slice();
        }
        return st;
    }

    function liveTeam(teamId) {
        if (typeof GameContext === 'undefined' || !GameContext.getTeam) return null;
        const t = GameContext.getTeam(teamId);
        if (!t || !t.wrapper || t.matchActive === false) return null;
        if (t.isDestroyed || (typeof t.hp === 'number' && t.hp <= 0)) return null;
        if (t.wreckPhase === 'falling' || t.wreckPhase === 'gone') return null;
        return t;
    }

    function hasHumanPlayer() {
        if (typeof GameContext === 'undefined' || !GameContext.getTeam) return false;
        const ids = (GameContext.getLivingTeamIds && GameContext.getLivingTeamIds())
            || (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds())
            || [];
        for (let i = 0; i < ids.length; i++) {
            const t = GameContext.getTeam(ids[i]);
            if (t && !t.aiEnabled && !t.isDestroyed && t.matchActive !== false) return true;
        }
        return false;
    }

    /** Human planning: live chase is single-seat; split only during combat anim / replay. */
    function shouldHoldSplitForHuman() {
        if (!hasHumanPlayer()) return false;
        if (typeof GameContext === 'undefined') return false;
        if (GameContext.isReplayMode && GameContext.isReplayMode()) return false;
        if (GameContext.isAnimating && GameContext.isAnimating()) return false;
        return true;
    }

    function getSavedIds() {
        const st = ensureState();
        if (!st) return [];
        return (st.viewPaneIdsSaved || []).filter((id) => !!liveTeam(id));
    }

    function setSavedIds(ids) {
        const st = ensureState();
        if (!st) return [];
        const next = [];
        const seen = Object.create(null);
        (ids || []).forEach((id) => {
            if (!id || seen[id] || !liveTeam(id)) return;
            if (next.length >= MAX_PANES) return;
            seen[id] = 1;
            next.push(id);
        });
        st.viewPaneIdsSaved = next;
        return next;
    }

    function syncSavedFromLive() {
        const live = getOpenIds();
        if (live.length > 1) setSavedIds(live);
        else if (live.length === 1 && getSavedIds().length <= 1) setSavedIds(live);
        return getSavedIds();
    }

    function preferredPlayerId() {
        const active = GameContext.getActiveTeamId && GameContext.getActiveTeamId();
        if (active && liveTeam(active)) {
            const t = GameContext.getTeam(active);
            if (t && !t.aiEnabled) return active;
        }
        const ids = (GameContext.getLivingTeamIds && GameContext.getLivingTeamIds())
            || (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds())
            || [];
        for (let i = 0; i < ids.length; i++) {
            const t = GameContext.getTeam(ids[i]);
            if (t && !t.aiEnabled && liveTeam(ids[i])) return ids[i];
        }
        if (active && liveTeam(active)) return active;
        for (let i = 0; i < ids.length; i++) {
            if (liveTeam(ids[i])) return ids[i];
        }
        return 'red';
    }

    function getOpenIds() {
        const st = ensureState();
        if (!st) return [];
        return st.viewPaneIds.filter((id) => !!liveTeam(id));
    }

    /** Live split (2+ chase panes). Saved combat layout during human planning does not count. */
    function isSplit() {
        return getOpenIds().length > 1;
    }

    function hideSplitExclusiveScene() {
        if (window.ghostWrapper) window.ghostWrapper.visible = false;
        if (window.ghostBeam) window.ghostBeam.visible = false;
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes) {
            Object.keys(trajectoryMeshes).forEach((id) => {
                if (trajectoryMeshes[id]) trajectoryMeshes[id].visible = false;
            });
        }
    }

    function hideSplitExclusiveDom() {
        const pipper = document.getElementById('lcos-pipper');
        if (pipper) pipper.style.display = 'none';
        const ghostHud = document.getElementById('ghost-hud');
        if (ghostHud) ghostHud.style.display = 'none';
        const ghostLabel = document.getElementById('alt-label-ghost');
        if (ghostLabel) ghostLabel.style.display = 'none';
        const shield = document.getElementById('lcos-drag-shield');
        if (shield) shield.style.display = 'none';
        const dynamicHud = document.getElementById('dynamic-hud');
        if (dynamicHud) dynamicHud.style.display = 'none';
        const fox1Ring = document.getElementById('fox1-hit-ring');
        if (fox1Ring) fox1Ring.style.display = 'none';
        const fox1Boxes = document.getElementById('fox1-missile-boxes');
        if (fox1Boxes) fox1Boxes.innerHTML = '';
        const lockLabel = document.getElementById('hud-tgt-lock');
        if (lockLabel) {
            lockLabel.classList.remove('is-on');
            lockLabel.hidden = true;
        }
        ['red', 'red2', 'blue', 'blue2'].forEach((id) => {
            const alt = document.getElementById(`alt-label-${id}`);
            if (alt) alt.style.display = 'none';
        });
        if (typeof updateMissileSeekerBrackets === 'function') {
            updateMissileSeekerBrackets({ visible: false });
        }
        if (typeof updateLcosGunHeatRing === 'function') {
            updateLcosGunHeatRing(null, 50, 50, 37.4, false);
        }
        window.isDraggingLcosRing = false;
    }

    let _wasSplit = false;
    function restorePlanningOverlays() {
        if (typeof GameContext === 'undefined') return;
        if (GameContext.isAnimating && GameContext.isAnimating()) return;
        if (GameContext.isReplayMode && GameContext.isReplayMode()) return;
        const id = GameContext.getActiveTeamId && GameContext.getActiveTeamId();
        const t = id && GameContext.getTeam && GameContext.getTeam(id);
        if (t && typeof window.updateTacticalPreview === 'function') {
            window.updateTacticalPreview(t);
        }
    }

    /** Hide aiming ring / ghost plane / planned path so every chase pane shows the same scene. */
    function applySplitOverlayPolicy() {
        const split = isSplit();
        if (document.body) document.body.classList.toggle('is-split-panes', split);
        if (split) {
            hideSplitExclusiveScene();
            hideSplitExclusiveDom();
        } else if (_wasSplit) {
            restorePlanningOverlays();
        }
        _wasSplit = split;
        return split;
    }

    function isOpen(teamId) {
        if (!liveTeam(teamId)) return false;
        // While human planning holds split, seat chrome reflects remembered combat layout.
        if (shouldHoldSplitForHuman()) {
            return getSavedIds().indexOf(teamId) >= 0;
        }
        const st = ensureState();
        return !!(st && st.viewPaneIds.indexOf(teamId) >= 0);
    }

    function getOrCreateCamera(teamId) {
        if (typeof THREE === 'undefined') return null;
        if (camerasByTeam[teamId]) return camerasByTeam[teamId];
        const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
        cam.position.set(10, 28.5, -40);
        camerasByTeam[teamId] = cam;
        return cam;
    }

    function setOpenIds(ids) {
        const st = ensureState();
        if (!st) return [];
        const next = [];
        const seen = Object.create(null);
        (ids || []).forEach((id) => {
            if (!id || seen[id] || !liveTeam(id)) return;
            if (next.length >= MAX_PANES) return;
            seen[id] = 1;
            next.push(id);
        });
        st.viewPaneIds = next;
        return next;
    }

    function open(teamId) {
        if (!liveTeam(teamId)) return getOpenIds();
        // Human planning: selecting a seat focuses that chase only (split remembered separately).
        if (shouldHoldSplitForHuman()) {
            setOpenIds([teamId]);
            return getOpenIds();
        }
        const st = ensureState();
        if (!st) return [];
        if (st.viewPaneIds.indexOf(teamId) < 0) {
            if (st.viewPaneIds.length >= MAX_PANES) {
                // Drop oldest non-active pane when full.
                const active = GameContext.getActiveTeamId && GameContext.getActiveTeamId();
                const dropIdx = st.viewPaneIds.findIndex((id) => id !== active);
                if (dropIdx >= 0) st.viewPaneIds.splice(dropIdx, 1);
                else if (st.viewPaneIds.length) st.viewPaneIds.shift();
            }
            st.viewPaneIds.push(teamId);
        }
        syncSavedFromLive();
        applySplitOverlayPolicy();
        return getOpenIds();
    }

    function close(teamId) {
        const st = ensureState();
        if (!st) return [];
        st.viewPaneIds = st.viewPaneIds.filter((id) => id !== teamId);
        if (shouldHoldSplitForHuman()) {
            setSavedIds(getSavedIds().filter((id) => id !== teamId));
        } else {
            syncSavedFromLive();
        }
        applySplitOverlayPolicy();
        return getOpenIds();
    }

    function pruneDestroyed() {
        const st = ensureState();
        if (!st) return [];
        setSavedIds(st.viewPaneIdsSaved || []);
        const before = st.viewPaneIds.slice();
        const next = setOpenIds(before);
        if (next.length === 0) {
            const active = (GameContext.getActiveTeamId && GameContext.getActiveTeamId()) || 'red';
            if (liveTeam(active)) {
                if (shouldHoldSplitForHuman()) setOpenIds([active]);
                else open(active);
            } else {
                const ids = (GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || [];
                for (let i = 0; i < ids.length; i++) {
                    if (liveTeam(ids[i])) {
                        if (shouldHoldSplitForHuman()) setOpenIds([ids[i]]);
                        else open(ids[i]);
                        break;
                    }
                }
            }
        }
        // If active seat crashed, hand control to another open (or living) seat.
        const activeId = GameContext.getActiveTeamId && GameContext.getActiveTeamId();
        if (activeId && !liveTeam(activeId)) {
            const panes = shouldHoldSplitForHuman() ? getSavedIds() : getOpenIds();
            const fallback = panes[0] || ((GameContext.getActiveMatchIds && GameContext.getActiveMatchIds()) || [])
                .find((id) => liveTeam(id));
            if (fallback && typeof selectTeam === 'function') selectTeam(fallback);
            else if (fallback) setOpenIds([fallback]);
        }
        return getOpenIds();
    }

    function resetTo(teamId) {
        const id = liveTeam(teamId) ? teamId : 'red';
        const ids = liveTeam(id) ? [id] : [];
        setOpenIds(ids);
        setSavedIds(ids);
        if (!getOpenIds().length) pruneDestroyed();
        applySplitOverlayPolicy();
        return getOpenIds();
    }

    /** Restore remembered split for combat playback (human matches only). */
    function restoreCombatSplit() {
        if (!hasHumanPlayer()) return getOpenIds();
        const saved = getSavedIds();
        if (saved.length > 1) {
            setOpenIds(saved);
        } else {
            const focus = preferredPlayerId();
            if (liveTeam(focus)) setOpenIds([focus]);
            else if (saved.length === 1) setOpenIds(saved);
        }
        if (typeof root.uiRefreshTeamModeButtons === 'function') root.uiRefreshTeamModeButtons();
        syncOverlayLabels();
        syncStallOverlays();
        applySplitOverlayPolicy();
        return getOpenIds();
    }

    /** After combat: remember split, collapse to selected / human seat. */
    function collapseForHumanPlanning(focusId) {
        if (!hasHumanPlayer()) return getOpenIds();
        const live = getOpenIds();
        if (live.length > 1) setSavedIds(live);
        else setSavedIds(getSavedIds());
        const focus = (focusId && liveTeam(focusId)) ? focusId : preferredPlayerId();
        setOpenIds(liveTeam(focus) ? [focus] : []);
        if (!getOpenIds().length) pruneDestroyed();
        if (typeof GameContext !== 'undefined' && GameContext.state) {
            GameContext.state.cameraSoftFollow = true;
            GameContext.state.cameraFollowOverrideId = null;
        }
        if (typeof root.uiRefreshTeamModeButtons === 'function') root.uiRefreshTeamModeButtons();
        syncOverlayLabels();
        syncStallOverlays();
        applySplitOverlayPolicy();
        return getOpenIds();
    }

    /**
     * Seat button: open view + select; if already open, focus first;
     * click again while focused closes (keep ≥1 pane).
     * Human planning edits remembered combat split; live chase stays single-seat.
     */
    function toggleFromSeatButton(teamId) {
        if (!liveTeam(teamId)) return { opened: false, ids: getOpenIds(), saved: getSavedIds() };
        const activeId = GameContext.getActiveTeamId && GameContext.getActiveTeamId();

        if (shouldHoldSplitForHuman()) {
            let saved = getSavedIds();
            const already = saved.indexOf(teamId) >= 0;
            if (!already) {
                if (saved.length >= MAX_PANES) {
                    const dropIdx = saved.findIndex((id) => id !== activeId && id !== teamId);
                    if (dropIdx >= 0) saved.splice(dropIdx, 1);
                    else if (saved.length) saved.shift();
                }
                saved.push(teamId);
                setSavedIds(saved);
                if (typeof selectTeam === 'function') selectTeam(teamId);
                else setOpenIds([teamId]);
                return { opened: true, ids: getOpenIds(), saved: getSavedIds() };
            }
            if (activeId !== teamId) {
                if (typeof selectTeam === 'function') selectTeam(teamId);
                else setOpenIds([teamId]);
                return { opened: true, ids: getOpenIds(), saved: getSavedIds() };
            }
            if (saved.length > 1) {
                saved = saved.filter((id) => id !== teamId);
                setSavedIds(saved);
                const next = saved[0];
                if (next && typeof selectTeam === 'function') selectTeam(next);
                else if (next) setOpenIds([next]);
                return { opened: false, ids: getOpenIds(), saved: getSavedIds() };
            }
            if (typeof selectTeam === 'function') selectTeam(teamId);
            return { opened: true, ids: getOpenIds(), saved: getSavedIds() };
        }

        const st = ensureState();
        const already = st && st.viewPaneIds.indexOf(teamId) >= 0;
        if (!already) {
            open(teamId);
            if (typeof selectTeam === 'function') selectTeam(teamId);
            return { opened: true, ids: getOpenIds(), saved: getSavedIds() };
        }
        // Open but not focused → focus only (do not close).
        if (activeId !== teamId) {
            if (typeof selectTeam === 'function') selectTeam(teamId);
            return { opened: true, ids: getOpenIds(), saved: getSavedIds() };
        }
        // Focused + open: close if another pane remains.
        if (getOpenIds().length > 1) {
            close(teamId);
            const panes = getOpenIds();
            if (panes[0] && typeof selectTeam === 'function') selectTeam(panes[0]);
            return { opened: false, ids: panes, saved: getSavedIds() };
        }
        if (typeof selectTeam === 'function') selectTeam(teamId);
        return { opened: true, ids: getOpenIds(), saved: getSavedIds() };
    }

    /** Viewport rects in CSS pixels; y origin top-left (converted for GL later). */
    function layoutRects(count, width, height) {
        const n = Math.max(1, Math.min(MAX_PANES, count | 0));
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        if (n === 1) return [{ x: 0, y: 0, width: w, height: h }];
        if (n === 2) {
            const hw = Math.floor(w / 2);
            return [
                { x: 0, y: 0, width: hw, height: h },
                { x: hw, y: 0, width: w - hw, height: h }
            ];
        }
        if (n === 3) {
            const hw = Math.floor(w / 2);
            const hh = Math.floor(h / 2);
            return [
                { x: 0, y: 0, width: hw, height: h },
                { x: hw, y: 0, width: w - hw, height: hh },
                { x: hw, y: hh, width: w - hw, height: h - hh }
            ];
        }
        const hw = Math.floor(w / 2);
        const hh = Math.floor(h / 2);
        return [
            { x: 0, y: 0, width: hw, height: hh },
            { x: hw, y: 0, width: w - hw, height: hh },
            { x: 0, y: hh, width: hw, height: h - hh },
            { x: hw, y: hh, width: w - hw, height: h - hh }
        ];
    }

    function factionOf(id) {
        if (typeof GameContext !== 'undefined' && GameContext.getFaction) {
            return GameContext.getFaction(id) || id;
        }
        return String(id || '').startsWith('blue') ? 'blue' : 'red';
    }

    function displayPaneIds() {
        const rank = { red: 0, red2: 1, blue: 2, blue2: 3 };
        return getOpenIds().slice().sort((a, b) => {
            const fa = factionOf(a) === 'blue' ? 1 : 0;
            const fb = factionOf(b) === 'blue' ? 1 : 0;
            if (fa !== fb) return fa - fb;
            return (rank[a] != null ? rank[a] : 50) - (rank[b] != null ? rank[b] : 50);
        });
    }

    function stackColumn(count, x, y, w, h) {
        const n = Math.max(1, count | 0);
        if (n === 1) return [{ x: x, y: y, width: w, height: h }];
        const rects = [];
        let y0 = y;
        const slice = Math.floor(h / n);
        for (let i = 0; i < n; i++) {
            const hh = (i === n - 1) ? (y + h - y0) : slice;
            rects.push({ x: x, y: y0, width: w, height: hh });
            y0 += hh;
        }
        return rects;
    }

    /** Red column on the left, blue column on the right when both factions are open. */
    function layoutRectsForIds(ids, width, height) {
        const list = ids || [];
        const n = Math.max(1, Math.min(MAX_PANES, list.length));
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        if (n <= 1) return layoutRects(n, w, h);
        const shown = list.slice(0, n);
        const reds = shown.filter((id) => factionOf(id) !== 'blue');
        const blues = shown.filter((id) => factionOf(id) === 'blue');
        if (reds.length && blues.length) {
            const hw = Math.floor(w / 2);
            const left = stackColumn(reds.length, 0, 0, hw, h);
            const right = stackColumn(blues.length, hw, 0, w - hw, h);
            const byId = Object.create(null);
            reds.forEach((id, i) => { byId[id] = left[i]; });
            blues.forEach((id, i) => { byId[id] = right[i]; });
            return shown.map((id) => byId[id]);
        }
        return layoutRects(n, w, h);
    }

    function paneSeatLabel(id) {
        if (id === 'red2') return 'RED-2';
        if (id === 'blue2') return 'BLUE-2';
        if (id === 'blue') return 'BLUE-1';
        return 'RED-1';
    }

    function paneCallsign(id) {
        const t = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(id) : null;
        if (t && t.callsign) return String(t.callsign);
        if (typeof AirArenaPilotRoster !== 'undefined' && AirArenaPilotRoster.callsignForTeam) {
            return AirArenaPilotRoster.callsignForTeam(t || { id: id }) || '';
        }
        return '';
    }

    function paneBustColor(id, cue) {
        const t = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(id) : null;
        if (t && t.portraitColor) return t.portraitColor;
        if (typeof AirArenaPilotRoster !== 'undefined' && AirArenaPilotRoster.portraitColor) {
            return AirArenaPilotRoster.portraitColor(t || cue || { id: id }) || '#888';
        }
        return factionOf(id) === 'blue' ? '#66e0ef' : '#ff6688';
    }

    function escHtml(s) {
        return String(s || '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function canvasBounds() {
        const canvas = (typeof renderer !== 'undefined' && renderer && renderer.domElement)
            ? renderer.domElement
            : document.getElementById('canvas-container');
        return canvas && canvas.getBoundingClientRect
            ? canvas.getBoundingClientRect()
            : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }

    function syncCameraToTeam(cam, teamId) {
        if (!cam || typeof getAircraftChaseCamPose !== 'function') return;
        const host = liveTeam(teamId) || (GameContext.getTeam && GameContext.getTeam(teamId));
        if (!host || !host.wrapper) return;
        const look = (typeof resolveChaseLookTeam === 'function') ? resolveChaseLookTeam(host) : null;
        const pose = getAircraftChaseCamPose(host, look);
        cam.position.copy(pose.camPos);
        cam.lookAt(pose.targetPos);
        cam.updateMatrixWorld();
    }

    function updateCameras() {
        const ids = getOpenIds();
        const st = ensureState();
        const activeId = (GameContext.getActiveTeamId && GameContext.getActiveTeamId()) || null;
        // Single pane: keep OrbitControls ownership on global camera.
        if (ids.length <= 1) {
            const id = ids[0] || activeId;
            if (id && typeof camera !== 'undefined' && camera) {
                // During multi→single handoff, snap chase once if soft-follow idle.
                if (GameContext.isAnimating && GameContext.isAnimating()) {
                    syncCameraToTeam(camera, id);
                    if (typeof controls !== 'undefined' && controls) {
                        const host = liveTeam(id);
                        if (host && host.wrapper && typeof getAircraftChaseCamPose === 'function') {
                            const look = resolveChaseLookTeam(host);
                            const pose = getAircraftChaseCamPose(host, look);
                            controls.target.copy(pose.targetPos);
                        }
                    }
                }
            }
            return ids;
        }
        ids.forEach((id) => {
            const cam = getOrCreateCamera(id);
            syncCameraToTeam(cam, id);
            // Keep main camera aligned with active pane for HUD/billboards/picking.
            if (id === activeId && typeof camera !== 'undefined' && camera) {
                camera.position.copy(cam.position);
                camera.quaternion.copy(cam.quaternion);
                camera.aspect = cam.aspect;
                if (typeof controls !== 'undefined' && controls) {
                    const host = liveTeam(id);
                    if (host && host.wrapper && typeof getAircraftChaseCamPose === 'function') {
                        const look = resolveChaseLookTeam(host);
                        const pose = getAircraftChaseCamPose(host, look);
                        controls.target.copy(pose.targetPos);
                    }
                }
            }
        });
        return ids;
    }

    function render(scene, renderer) {
        if (!scene || !renderer) return false;
        pruneDestroyed();
        applySplitOverlayPolicy();
        const liveIds = getOpenIds();
        if (!liveIds.length) {
            if (typeof camera !== 'undefined' && camera) renderer.render(scene, camera);
            syncStallOverlays();
            return false;
        }
        const canvas = renderer.domElement;
        const width = canvas.clientWidth || canvas.width || 1;
        const height = canvas.clientHeight || canvas.height || 1;
        const activeId = (GameContext.getActiveTeamId && GameContext.getActiveTeamId()) || liveIds[0];

        if (liveIds.length === 1) {
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, width, height);
            const only = liveIds[0];
            if (only !== activeId || !(typeof camera !== 'undefined' && camera)) {
                const cam = getOrCreateCamera(only);
                cam.aspect = width / Math.max(1, height);
                cam.updateProjectionMatrix();
                syncCameraToTeam(cam, only);
                applyCameraShake(cam, only);
                renderer.render(scene, cam);
            } else {
                camera.aspect = width / Math.max(1, height);
                camera.updateProjectionMatrix();
                applyCameraShake(camera, only);
                renderer.render(scene, camera);
            }
            syncStallOverlays();
            return true;
        }

        const ids = displayPaneIds();
        const rects = layoutRectsForIds(ids, width, height);
        updateCameras();
        renderer.setScissorTest(true);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const r = rects[i];
            // GL scissor/viewport: y from bottom.
            const gy = height - r.y - r.height;
            const cam = (id === activeId && typeof camera !== 'undefined' && camera)
                ? camera
                : getOrCreateCamera(id);
            cam.aspect = r.width / Math.max(1, r.height);
            cam.updateProjectionMatrix();
            syncCameraToTeam(cam, id);
            applyCameraShake(cam, id);
            renderer.setViewport(r.x, gy, r.width, r.height);
            renderer.setScissor(r.x, gy, r.width, r.height);
            renderer.render(scene, cam);
        }
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, width, height);
        syncStallOverlays();
        return true;
    }

    function setSplitRadioHud(split) {
        const radioHud = document.getElementById('radio-hud');
        if (radioHud) radioHud.classList.toggle('is-split-paned', !!split);
    }

    function syncOverlayLabels() {
        let rootEl = document.getElementById('multi-view-labels');
        if (!rootEl) {
            rootEl = document.createElement('div');
            rootEl.id = 'multi-view-labels';
            rootEl.setAttribute('aria-hidden', 'true');
            document.body.appendChild(rootEl);
        }
        const ids = displayPaneIds();
        setSplitRadioHud(ids.length > 1);
        if (ids.length <= 1) {
            rootEl.innerHTML = '';
            rootEl.style.display = 'none';
            return;
        }
        const bounds = canvasBounds();
        const rects = layoutRectsForIds(ids, bounds.width, bounds.height);
        rootEl.style.display = 'block';
        rootEl.innerHTML = ids.map((id, i) => {
            const r = rects[i];
            if (!r) return '';
            const faction = factionOf(id);
            const active = (GameContext.getActiveTeamId && GameContext.getActiveTeamId()) === id;
            const cs = paneCallsign(id);
            const cue = (window.AirArenaRadioHud && typeof window.AirArenaRadioHud.cueForSeat === 'function')
                ? window.AirArenaRadioHud.cueForSeat(id)
                : null;
            const line = cue && typeof AirArenaRadioCues !== 'undefined' && AirArenaRadioCues.formatCue
                ? AirArenaRadioCues.formatCue(cue)
                : '';
            const left = Math.round(bounds.left + r.x + 8);
            const top = Math.round(bounds.top + r.y + r.height - 10);
            const tag = cs ? `${paneSeatLabel(id)}  ${cs}` : paneSeatLabel(id);
            const bustName = (cue && cue.callsign) || cs || paneSeatLabel(id);
            const bust = `<div class="multi-view-bust" style="background:${escHtml(paneBustColor(id, cue))}">${escHtml(String(bustName).slice(0, 2))}</div>`;
            const sub = line
                ? `<div class="multi-view-sub is-live">${escHtml(line)}</div>`
                : '';
            return `<div class="multi-view-pane-chrome faction-${faction}${active ? ' is-active' : ''}${line ? ' is-live' : ''}" style="left:${left}px;top:${top}px"><div class="multi-view-radio">${bust}${sub}</div><div class="multi-view-label">${escHtml(tag)}</div></div>`;
        }).join('');
    }

    /** Stall red flash only on panes whose aircraft is stalled (not full-screen bleed). */
    function syncStallOverlays() {
        let rootEl = document.getElementById('multi-view-stalls');
        if (!rootEl) {
            rootEl = document.createElement('div');
            rootEl.id = 'multi-view-stalls';
            rootEl.setAttribute('aria-hidden', 'true');
            document.body.appendChild(rootEl);
        }
        const globalStall = document.getElementById('stall-screen');
        const ids = displayPaneIds();
        const bounds = canvasBounds();

        const stalledOpen = ids.filter((id) => {
            const t = (typeof GameContext !== 'undefined' && GameContext.getTeam) ? GameContext.getTeam(id) : null;
            return !!(t && t.stalled && !t.isDestroyed && t.matchActive !== false);
        });

        if (ids.length <= 1) {
            rootEl.innerHTML = '';
            rootEl.style.display = 'none';
            const only = ids[0] || ((typeof GameContext !== 'undefined' && GameContext.getActiveTeamId)
                ? GameContext.getActiveTeamId()
                : null);
            const t = only && GameContext.getTeam ? GameContext.getTeam(only) : null;
            if (globalStall) {
                globalStall.style.display = (t && t.stalled && !t.isDestroyed) ? 'flex' : 'none';
                globalStall.style.left = '';
                globalStall.style.top = '';
                globalStall.style.width = '';
                globalStall.style.height = '';
            }
            return;
        }

        if (globalStall) globalStall.style.display = 'none';
        if (!stalledOpen.length) {
            rootEl.innerHTML = '';
            rootEl.style.display = 'none';
            return;
        }
        const rects = layoutRectsForIds(ids, bounds.width, bounds.height);
        rootEl.style.display = 'block';
        rootEl.innerHTML = ids.map((id, i) => {
            const t = GameContext.getTeam ? GameContext.getTeam(id) : null;
            if (!(t && t.stalled && !t.isDestroyed)) return '';
            const r = rects[i];
            return `<div class="pane-stall-overlay" style="left:${Math.round(bounds.left + r.x)}px;top:${Math.round(bounds.top + r.y)}px;width:${Math.round(r.width)}px;height:${Math.round(r.height)}px"><div class="pane-stall-text">⚠ STALL ⚠<br><span>失速臨界</span></div></div>`;
        }).join('');
    }

    function applyCameraShake(cam, teamId) {
        if (!cam || !teamId || typeof GameContext === 'undefined' || !GameContext.state) return;
        const map = GameContext.state.cameraShakeByTeam || {};
        const sh = map[teamId];
        if (!sh) return;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now >= Number(sh.until || 0)) {
            delete map[teamId];
            return;
        }
        const left = Math.max(0, Number(sh.until) - now);
        const amp = Number(sh.amp) || 0.12;
        const fall = Math.min(1, left / 220);
        const mag = amp * fall;
        cam.position.x += (Math.random() - 0.5) * mag * 1.05;
        cam.position.y += (Math.random() - 0.5) * mag * 0.75;
        cam.position.z += (Math.random() - 0.5) * mag * 1.05;
    }

    function triggerViewCameraShake(teamId, amp = 0.22) {
        if (!teamId || typeof GameContext === 'undefined' || !GameContext.state) return;
        const open = getOpenIds();
        const active = GameContext.getActiveTeamId && GameContext.getActiveTeamId();
        const viewing = open.indexOf(teamId) >= 0 || active === teamId;
        if (!viewing) return;
        if (!GameContext.state.cameraShakeByTeam) GameContext.state.cameraShakeByTeam = {};
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const prev = GameContext.state.cameraShakeByTeam[teamId];
        GameContext.state.cameraShakeByTeam[teamId] = {
            until: Math.max(Number(prev && prev.until) || 0, now + 260),
            amp: Math.max(Number(prev && prev.amp) || 0, Math.min(0.45, Number(amp) || 0.22))
        };
    }

    root.triggerViewCameraShake = triggerViewCameraShake;

    root.AirArenaMultiView = {
        getOpenIds,
        getSavedIds,
        isSplit,
        applySplitOverlayPolicy,
        isOpen,
        open,
        close,
        pruneDestroyed,
        resetTo,
        toggleFromSeatButton,
        hasHumanPlayer,
        shouldHoldSplitForHuman,
        restoreCombatSplit,
        collapseForHumanPlanning,
        updateCameras,
        render,
        syncOverlayLabels,
        syncStallOverlays,
        applyCameraShake,
        triggerViewCameraShake,
        layoutRects
    };
})(window);
