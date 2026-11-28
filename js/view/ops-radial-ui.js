// ============================================================================
// ops-radial-ui.js — semi-transparent radial ops HUD + classic panel collapse
// ============================================================================
(function () {
    const COLLAPSE_KEY = 'airarena.opsPanelCollapsed';
    /** SVG layout — center HP disc doubled again (was r=110 → 220). */
    const SVG_CX = 280;
    const HP_R = 220;
    const HP_CIRC = 2 * Math.PI * HP_R;
    // Outer pylon/CM ring outside the larger center disc.
    const WEDGE_R0 = 228;
    const WEDGE_R1 = 310;
    const WEDGE_MID_R = (WEDGE_R0 + WEDGE_R1) * 0.5;
    /** Screen-Y stack inside a wedge cell: logo above text (SVG +y is down). */
    const WEDGE_STACK_DY = 16;
    const OpsDetail = { kind: null, pylonId: null, a0: null, a1: null }; // kind: 'gun' | 'pylon'

    const OpsRadial = {
        open: false,
        focus: null, // 'aircraft' | 'ghost'
        teamId: null,
        _raf: 0,
        _outsideBound: false,
        _outsideArmAt: 0, // ignore outside closes until after the opening pick settles
        _suppressPickOpenUntil: 0 // hollow/outside close must not be reopened by the same 3D pick
    };

    function $(id) { return document.getElementById(id); }

    function thrBandLabel(thr) {
        const t = Number(thr) || 4;
        if (t >= 4.5) return 'AB';
        if (t >= 3.5) return 'MIL';
        if (t >= 2.5) return 'ECO';
        if (t >= 1.5) return 'IDL';
        return 'BRK';
    }

    function pylonShortLabel(p, team) {
        if (!p) return '—';
        const wt = (typeof pylonWeaponType === 'function') ? pylonWeaponType(p) : p.weaponType;
        let w = 'F2';
        let st = (p.state || 'standby').slice(0, 3).toUpperCase();
        if (wt === 'fox1') w = 'F1';
        else if (wt === 'bomb') w = 'BMB';
        else if (wt === 'rocket') {
            const ammo = (typeof AirArenaRocket !== 'undefined')
                ? AirArenaRocket.ensurePodAmmo(p)
                : (Number(p.ammo) || 0);
            const fuze = (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.getTeamFuzeMode === 'function')
                ? AirArenaRocket.getTeamFuzeMode(team)
                : ((team && team.rocketFuze === 'impact') ? 'impact' : 'vt');
            w = `R${ammo}`;
            if (p.state !== 'empty') st = `${st}·${fuze === 'impact' ? 'IM' : 'VT'}`;
        }
        return `P${p.id} ${w}\n${st}`;
    }

    /** Two-line label for in-wedge text area (e.g. "P4 R2" / "ARM·VT"). */
    function pylonWedgeLines(p, team) {
        if (!p) return ['—', ''];
        const raw = pylonShortLabel(p, team).split('\n');
        return [raw[0] || '—', raw[1] || ''];
    }

    function setClassicCollapsed(collapsed) {
        const wrap = $('ui-wrapper');
        const btn = $('btn-ops-panel-toggle');
        if (!wrap) return;
        wrap.classList.toggle('is-ops-collapsed', !!collapsed);
        if (btn) {
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            btn.textContent = collapsed ? '▴' : '▾';
            btn.title = collapsed ? '打開操作面板' : '收合操作面板';
        }
        try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) { /* ignore */ }
    }

    function initCollapseToggle() {
        const btn = $('btn-ops-panel-toggle');
        if (!btn || btn.dataset.bound) return;
        btn.dataset.bound = '1';
        let prefer = false;
        try { prefer = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (_) { /* ignore */ }
        setClassicCollapsed(prefer);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const wrap = $('ui-wrapper');
            const next = !(wrap && wrap.classList.contains('is-ops-collapsed'));
            setClassicCollapsed(next);
        });
    }

    // -------------------------------------------------------------------------
    // Ghost steer HUD — same job as LCOS/FOX grab ring: hold+drag = nose (joy),
    // outer ring + L/R handles = roll.
    // -------------------------------------------------------------------------
    const GhostSteer = {
        mode: null, // 'nose' | 'roll' | 'throttle'
        pointerId: null,
        startX: 0,
        startY: 0,
        startJoyX: 0,
        startJoyY: 0,
        startRoll: 0,
        startAngle: 0,
        lastAngle: 0,
        accumRoll: 0,
        startRadius: 0,
        startThrottle: 4,
        /** Frozen HUD centre in client px for the whole gesture (ghost must not move the pivot). */
        anchorCx: 0,
        anchorCy: 0,
        bankEnabled: false, // true only when dragging L/R handles
        ringFactor: 1,
        bound: false,
        winBound: false
    };
    /** Nominal roll-ring radius in HUD CSS px (matches SVG r≈62 on 120px box). */
    const ROLL_RING_BASE_PX = 53;
    /** Resting ring radius in SVG user units (viewBox 140). */
    const ROLL_RING_R0_SVG = 62;
    /** Inner white nose ring (SVG r=32) in CSS px on the 120×140 HUD mapping. */
    const ROLL_INNER_STOP_PX = 32 * (120 / 140);
    /** Outward radial drag (px) that maps +1.0 throttle above start. */
    const ROLL_THR_SOFT_PX = 36;
    const ROLL_THR_MIN = 1;
    const ROLL_THR_MAX = 5;
    /** Below this radius, bank is frozen and lastAngle re-baselines (no atan2 spike). */
    const ROLL_BANK_MIN_PX = ROLL_INNER_STOP_PX;
    /** Expand factor: 1 at rest, up to 2× radius (stroke/handle size unchanged). */
    const ROLL_SCALE_MIN = 1.0;
    const ROLL_SCALE_MAX = 2.0;

    /** Commanded bank for HUD: during roll-drag pendingRoll is authoritative (incl. 0). */
    function commandRollRad(t) {
        if (!t) return 0;
        if (GhostSteer.mode === 'roll' || GhostSteer.mode === 'throttle') {
            return (t.pendingRoll != null && !Number.isNaN(Number(t.pendingRoll)))
                ? Number(t.pendingRoll)
                : (GhostSteer.startRoll || 0);
        }
        if (t.pendingRoll !== 0 && t.pendingRoll != null) return Number(t.pendingRoll);
        return Number(t.roll) || 0;
    }

    function canPilotTeam(teamId) {
        if (typeof GameContext === 'undefined' || typeof teams === 'undefined') return null;
        const id = teamId || OpsRadial.teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
        const t = id ? teams[id] : null;
        if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return null;
        if (GameContext.isReplayMode && GameContext.isReplayMode()) return null;
        return t;
    }

    function syncCockpitJoy(joyX, joyY) {
        if (window.AirArenaNoseDrag && typeof window.AirArenaNoseDrag.syncCockpitJoy === 'function') {
            window.AirArenaNoseDrag.syncCockpitJoy(joyX, joyY);
            return;
        }
        const joyZone = $('joystick-zone');
        const joyHandle = $('joystick-handle');
        if (!joyZone || !joyHandle) return;
        const maxRadius = Math.max(8, joyZone.getBoundingClientRect().width / 2 - 15);
        joyHandle.style.transform = `translate(${joyX * maxRadius}px, ${-joyY * maxRadius}px)`;
    }

    /** Ghost bank on screen (wing-up vs camera) so handles follow phantom attitude. */
    function getGhostVisualBankRad() {
        if (!window.ghostWrapper || !window.ghostWrapper.visible) return null;
        if (typeof THREE === 'undefined' || typeof camera === 'undefined' || !camera) return null;
        if (camera.updateMatrixWorld) camera.updateMatrixWorld();
        window.ghostWrapper.updateMatrixWorld(true);
        const q = window.ghostWrapper.quaternion;
        const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
        const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
        const camFwd = new THREE.Vector3();
        camera.getWorldDirection(camFwd);
        const upScreen = bodyUp.clone().addScaledVector(camFwd, -bodyUp.dot(camFwd));
        if (upScreen.lengthSq() < 1e-8) return null;
        upScreen.normalize();
        // 0 = upright on screen; + = bank that lifts aircraft right wing toward screen-right.
        return Math.atan2(upScreen.dot(camRight), upScreen.dot(camUp));
    }

    function syncCockpitRoll(angle, opts) {
        const skipCockpit = !!(opts && opts.skipCockpit);
        if (!skipCockpit) {
            const rollRing = $('roll-ring');
            if (rollRing) rollRing.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
        }
        // SVG transform attribute only — CSS rotate on <g> drifts off-axis.
        // Never set style.transform = 'none': inline CSS transform:none overrides
        // the SVG transform="..." attribute in SVG2/Chromium and locks rotation at 0.
        const deg = (angle * 180) / Math.PI;
        const rot = `rotate(${deg} 70 70)`;
        const ghostRoll = $('ghost-roll-ring');
        if (ghostRoll) {
            if (ghostRoll.style && ghostRoll.style.transform) {
                ghostRoll.style.removeProperty('transform');
            }
            ghostRoll.setAttribute('transform', rot);
        }
        // Hit pads sit above #ghost-roll-hit — keep them locked to the same bank.
        const handleLayer = $('ghost-handle-layer');
        if (handleLayer) {
            if (handleLayer.style && handleLayer.style.transform) {
                handleLayer.style.removeProperty('transform');
            }
            handleLayer.setAttribute('transform', rot);
        }
        // HEAT/AP HTML layer banks with the grips (CSS rotate about HUD centre).
        const stats = $('ghost-handle-stats');
        if (stats) stats.style.transform = `rotate(${deg}deg)`;
    }

    function setOrbitLocked(locked) {
        if (window.AirArenaNoseDrag && typeof window.AirArenaNoseDrag.setOrbitLocked === 'function') {
            window.AirArenaNoseDrag.setOrbitLocked(locked, '_ghostSteerOrbitBackup');
            return;
        }
        if (typeof controls === 'undefined' || !controls) return;
        if (!controls.userData) controls.userData = {};
        if (locked) {
            if (!controls.userData._ghostSteerOrbitBackup) {
                controls.userData._ghostSteerOrbitBackup = {
                    enableZoom: controls.enableZoom,
                    enablePan: controls.enablePan,
                    enableRotate: controls.enableRotate
                };
            }
            controls.enableZoom = false;
            controls.enablePan = false;
            controls.enableRotate = false;
        } else if (controls.userData._ghostSteerOrbitBackup) {
            const b = controls.userData._ghostSteerOrbitBackup;
            controls.enableZoom = b.enableZoom !== false;
            controls.enablePan = b.enablePan !== false;
            controls.enableRotate = b.enableRotate !== false;
            controls.userData._ghostSteerOrbitBackup = null;
        }
    }

    function applyNoseDrag(clientX, clientY) {
        const t = canPilotTeam();
        const nd = window.AirArenaNoseDrag;
        if (!t || !nd) return;
        if (typeof camera !== 'undefined' && camera && camera.updateMatrixWorld) camera.updateMatrixWorld();
        const dx = clientX - GhostSteer.startX;
        const dy = clientY - GhostSteer.startY;
        const dist = Math.hypot(dx, dy);
        if (dist < 2) {
            syncCockpitJoy(GhostSteer.startJoyX, GhostSteer.startJoyY);
            return;
        }
        const { softPx, fullPx } = nd.getRadii();
        const mag = nd.mapDistToJoyMag(dist, softPx, fullPx);
        const delta = nd.mapScreenDragToJoy(dx, dy, mag, t);
        const next = nd.clampJoyVector(GhostSteer.startJoyX + delta.joyX, GhostSteer.startJoyY + delta.joyY);
        if (!GameContext.stateMachine.setJoystickInput(t.id, next.joyX, next.joyY)) return;
        syncCockpitJoy(next.joyX, next.joyY);
        updateGhostJoyPip(next.joyX, next.joyY);
        if (typeof uiRefreshPreview === 'function') uiRefreshPreview(t);
        else if (typeof updateDashboardUI === 'function') updateDashboardUI(t);
    }

    /** Grow ring radius only — stroke width and handle size stay constant. */
    function setRollRingScale(scale) {
        const s = Math.max(ROLL_SCALE_MIN, Math.min(ROLL_SCALE_MAX, Number(scale) || 1));
        GhostSteer.ringFactor = s;
        const r = ROLL_RING_R0_SVG * s;
        const setR = (id) => {
            const el = $(id);
            if (el) el.setAttribute('r', String(r));
        };
        setR('ghost-roll-track');
        setR('ghost-roll-stroke');
        setR('ghost-roll-hit');
        const port = $('ghost-roll-port');
        const stbd = $('ghost-roll-stbd');
        if (port) {
            port.setAttribute('cx', String(70 - r));
            port.setAttribute('cy', '70');
        }
        if (stbd) {
            stbd.setAttribute('cx', String(70 + r));
            stbd.setAttribute('cy', '70');
        }
        const vLeft = $('ghost-handle-visual-left');
        const vRight = $('ghost-handle-visual-right');
        if (vLeft) vLeft.setAttribute('transform', `translate(${70 - r} 70)`);
        if (vRight) vRight.setAttribute('transform', `translate(${70 + r} 70)`);
        const hLeft = $('ghost-handle-left');
        const hRight = $('ghost-handle-right');
        if (hLeft) hLeft.setAttribute('transform', `translate(${70 - r} 70)`);
        if (hRight) hRight.setAttribute('transform', `translate(${70 + r} 70)`);
        // HEAT/AP ride the grips in HUD % space (viewBox 140 → 100%).
        const heat = document.querySelector('#ghost-handle-stats .ghost-handle-stat-heat');
        const ap = document.querySelector('#ghost-handle-stats .ghost-handle-stat-ap');
        const leftPct = ((70 - r) / 140) * 100;
        const rightPct = ((70 + r) / 140) * 100;
        // Clear the grip half-width (~11 SVG ≈ 9px) plus a readable gap.
        const gapPx = 16;
        if (heat) {
            heat.style.left = `${leftPct}%`;
            heat.style.top = '50%';
            heat.style.transform = `translate(calc(-100% - ${gapPx}px), -50%)`;
        }
        if (ap) {
            ap.style.left = `${rightPct}%`;
            ap.style.top = '50%';
            ap.style.transform = `translate(${gapPx}px, -50%)`;
        }
    }

    function previewHeatForTeam(t) {
        if (!t) return null;
        const idle = (typeof getEngineHeatIdle === 'function') ? getEngineHeatIdle() : 150;
        const maxH = (typeof getEngineHeatMax === 'function') ? getEngineHeatMax() : 250;
        const base = Number.isFinite(Number(t.heat)) ? Number(t.heat) : idle;
        let delta = 0;
        if (typeof getThrottleStats === 'function') {
            const st = getThrottleStats(Number(t.throttle) || 4, t.type);
            delta = Number(st && st.heat) || 0;
        } else if (Number.isFinite(Number(t.previewAccumHeat))) {
            delta = Number(t.previewAccumHeat);
        }
        return Math.min(maxH, Math.max(idle, base + delta));
    }

    function applyRingDrag(clientX, clientY) {
        const t = canPilotTeam();
        if (!t) return;
        // Use gesture-start anchor — live HUD rect moves with the ghost and caused 跳舵.
        const cx = GhostSteer.anchorCx;
        const cy = GhostSteer.anchorCy;
        const dx = clientX - cx;
        const dy = clientY - cy;
        const ang = Math.atan2(dx, -dy);
        const radiusAbs = Math.hypot(dx, dy);
        // Project onto the grab ray so crossing the centre never reads as outward on the far side.
        const ux = Math.sin(GhostSteer.startAngle);
        const uy = -Math.cos(GhostSteer.startAngle);
        const signedR = dx * ux + dy * uy;
        // Stop at the inner white nose ring — no travel through centre.
        const radiusThr = Math.max(ROLL_INNER_STOP_PX, signedR);

        // Bank only from L/R handles. Incremental lastAngle + deadzone re-baseline
        // so inward pulls (and near-center atan2 flips) never spike pendingRoll.
        if (GhostSteer.bankEnabled) {
            if (radiusAbs >= ROLL_BANK_MIN_PX && signedR >= ROLL_INNER_STOP_PX) {
                let delta = ang - GhostSteer.lastAngle;
                if (delta > Math.PI) delta -= Math.PI * 2;
                if (delta < -Math.PI) delta += Math.PI * 2;
                GhostSteer.lastAngle = ang;
                GhostSteer.accumRoll += delta;
                GameContext.stateMachine.setRollInput(t.id, GhostSteer.accumRoll);
                syncCockpitRoll(GhostSteer.accumRoll);
            } else {
                GhostSteer.lastAngle = ang; // re-baseline; do not emit bank
                syncCockpitRoll(GhostSteer.accumRoll);
            }
        }

        // Radial throttle: white ring → min; start ring → startThrottle; outward → max.
        const baseR = GhostSteer.startRadius > 8 ? GhostSteer.startRadius : ROLL_RING_BASE_PX;
        const startThr = Math.max(ROLL_THR_MIN, Math.min(ROLL_THR_MAX, GhostSteer.startThrottle));
        let nextThr;
        if (radiusThr <= baseR) {
            const span = Math.max(1, baseR - ROLL_INNER_STOP_PX);
            const tNorm = Math.max(0, Math.min(1, (radiusThr - ROLL_INNER_STOP_PX) / span));
            nextThr = ROLL_THR_MIN + tNorm * (startThr - ROLL_THR_MIN);
        } else {
            nextThr = Math.min(ROLL_THR_MAX, startThr + (radiusThr - baseR) / ROLL_THR_SOFT_PX);
        }
        if (GameContext.stateMachine && GameContext.stateMachine.setThrottle) {
            GameContext.stateMachine.setThrottle(t.id, nextThr);
        } else {
            t.throttle = nextThr;
        }
        // Visual: expand up to 2× outward only; inward / far-side never enlarges.
        const scale = radiusThr <= baseR
            ? 1
            : Math.min(ROLL_SCALE_MAX, radiusThr / Math.max(8, baseR));
        setRollRingScale(scale);
        syncGhostSteerMeta(t);
        if (typeof uiRefreshPreview === 'function') uiRefreshPreview(t);
    }

    function updateGhostJoyPip(joyX, joyY) {
        const pip = $('ghost-joy-pip');
        if (!pip) return;
        // viewBox center 70; map joy into ~22px radius
        pip.setAttribute('cx', String(70 + (Number(joyX) || 0) * 22));
        pip.setAttribute('cy', String(70 - (Number(joyY) || 0) * 22));
    }

    function unbindGhostSteerWindow() {
        if (!GhostSteer.winBound) return;
        window.removeEventListener('pointermove', onGhostSteerMove, true);
        window.removeEventListener('pointerup', endGhostSteer, true);
        window.removeEventListener('pointercancel', endGhostSteer, true);
        GhostSteer.winBound = false;
    }

    function bindGhostSteerWindow() {
        if (GhostSteer.winBound) return;
        // Window capture so drag keeps updating when pointer leaves the thin ring/handles.
        window.addEventListener('pointermove', onGhostSteerMove, { capture: true, passive: false });
        window.addEventListener('pointerup', endGhostSteer, { capture: true });
        window.addEventListener('pointercancel', endGhostSteer, { capture: true });
        GhostSteer.winBound = true;
    }

    function endGhostSteer(e) {
        if (!GhostSteer.mode) return;
        if (e && GhostSteer.pointerId != null && e.pointerId !== GhostSteer.pointerId) return;
        const wasRing = GhostSteer.mode === 'roll' || GhostSteer.mode === 'throttle';
        const hud = $('ghost-steer-hud');
        if (hud) {
            hud.classList.remove('is-nose-dragging', 'is-roll-dragging', 'is-throttle-dragging', 'is-drag-frozen');
        }
        GhostSteer.mode = null;
        GhostSteer.pointerId = null;
        GhostSteer.bankEnabled = false;
        unbindGhostSteerWindow();
        setOrbitLocked(false);
        // Do NOT toggle isDraggingRollRing — that flag drives the classic cockpit
        // roll-ring window mousemove handler and must stay false during ghost drag.
        window.isDraggingGhostSteer = false;
        if (wasRing) setRollRingScale(1);
    }

    function beginNose(e) {
        if (e.button != null && e.button !== 0) return;
        if (window.isDraggingLcosRing || (typeof isDraggingJoystick !== 'undefined' && isDraggingJoystick)) return;
        if (window.isDraggingGhostSteer) return;
        const t = canPilotTeam();
        if (!t) return;
        GhostSteer.mode = 'nose';
        GhostSteer.bankEnabled = false;
        GhostSteer.pointerId = e.pointerId;
        GhostSteer.startX = e.clientX;
        GhostSteer.startY = e.clientY;
        GhostSteer.startJoyX = Number(t.joyX) || 0;
        GhostSteer.startJoyY = Number(t.joyY) || 0;
        window.isDraggingGhostSteer = true;
        setOrbitLocked(true);
        bindGhostSteerWindow();
        const hud = $('ghost-steer-hud');
        if (hud) hud.classList.add('is-nose-dragging');
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        syncCockpitJoy(GhostSteer.startJoyX, GhostSteer.startJoyY);
        updateGhostJoyPip(GhostSteer.startJoyX, GhostSteer.startJoyY);
    }

    function beginRingGesture(e, opts) {
        if (e.button != null && e.button !== 0) return;
        if (window.isDraggingLcosRing || window.isDraggingGhostSteer) return;
        if (typeof isDraggingRollRing !== 'undefined' && isDraggingRollRing) return;
        const t = canPilotTeam();
        if (!t) return;
        const hud = $('ghost-steer-hud');
        if (!hud) return;
        const bankEnabled = !!(opts && opts.bankEnabled);
        const rect = hud.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const ang0 = Math.atan2(e.clientX - cx, -(e.clientY - cy));
        const startRoll = (t.pendingRoll !== 0 && t.pendingRoll != null) ? t.pendingRoll : (Number(t.roll) || 0);
        GhostSteer.mode = bankEnabled ? 'roll' : 'throttle';
        GhostSteer.bankEnabled = bankEnabled;
        GhostSteer.pointerId = e.pointerId;
        GhostSteer.anchorCx = cx;
        GhostSteer.anchorCy = cy;
        GhostSteer.startAngle = ang0;
        GhostSteer.lastAngle = ang0;
        GhostSteer.accumRoll = startRoll;
        GhostSteer.startRadius = Math.hypot(e.clientX - cx, e.clientY - cy);
        GhostSteer.startThrottle = Number(t.throttle) || 4;
        GhostSteer.startRoll = startRoll;
        if (bankEnabled) {
            GameContext.stateMachine.setRollInput(t.id, GhostSteer.startRoll);
            syncCockpitRoll(GhostSteer.startRoll);
        }
        // Start at rest scale; outward pull may grow up to 2×.
        setRollRingScale(1);
        window.isDraggingGhostSteer = true;
        setOrbitLocked(true);
        bindGhostSteerWindow();
        hud.classList.add(bankEnabled ? 'is-roll-dragging' : 'is-throttle-dragging');
        hud.classList.add('is-drag-frozen');
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
    }

    function beginRollHandle(e) {
        beginRingGesture(e, { bankEnabled: true });
    }

    function beginThrottleRing(e) {
        // Ring stroke: throttle only — no bank.
        beginRingGesture(e, { bankEnabled: false });
    }

    function onGhostSteerMove(e) {
        if (!GhostSteer.mode) return;
        if (GhostSteer.pointerId != null && e.pointerId !== GhostSteer.pointerId) return;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (GhostSteer.mode === 'nose') applyNoseDrag(e.clientX, e.clientY);
        else if (GhostSteer.mode === 'roll' || GhostSteer.mode === 'throttle') {
            applyRingDrag(e.clientX, e.clientY);
        }
    }

    function bindGhostSteerHud() {
        if (GhostSteer.bound) return;
        const grab = $('ghost-grab-hit');
        const grabRing = $('ghost-grab-ring');
        const rollHit = $('ghost-roll-hit');
        const left = $('ghost-handle-left');
        const right = $('ghost-handle-right');
        if (!grab || !rollHit) return;
        GhostSteer.bound = true;

        const noseTargets = [grab, grabRing].filter(Boolean);
        noseTargets.forEach((el) => {
            el.addEventListener('pointerdown', beginNose, { passive: false });
        });

        // Handles only: bank + throttle. Ring stroke: throttle only.
        [left, right].filter(Boolean).forEach((el) => {
            el.addEventListener('pointerdown', beginRollHandle, { passive: false });
        });
        rollHit.addEventListener('pointerdown', beginThrottleRing, { passive: false });
        setRollRingScale(1);
    }

    function projectGhostScreen() {
        if (!window.ghostWrapper || !window.ghostWrapper.visible || typeof camera === 'undefined' || !camera) return null;
        if (typeof THREE === 'undefined') return null;
        const v = window.ghostWrapper.position.clone();
        v.project(camera);
        if (v.z > 1) return null;
        return {
            x: (v.x * 0.5 + 0.5) * window.innerWidth,
            y: (-v.y * 0.5 + 0.5) * window.innerHeight
        };
    }

    function ghostSteerShouldShow(team) {
        const t = team || canPilotTeam() || (teams && teams[OpsRadial.teamId]);
        if (!t || t.isDestroyed || t.matchActive === false) return false;
        if (GameContext.isReplayMode && GameContext.isReplayMode()) return false;
        if (GameContext.isAnimating && GameContext.isAnimating()) return false;
        return !!(window.ghostWrapper && window.ghostWrapper.visible);
    }

    function syncGhostSteerMeta(team) {
        const t = team;
        const altEl = $('ghost-steer-alt');
        if (altEl) {
            const y = (window.ghostWrapper && window.ghostWrapper.visible)
                ? Number(window.ghostWrapper.position.y)
                : (t && t.wrapper ? Number(t.wrapper.position.y) : NaN);
            altEl.textContent = Number.isFinite(y) ? `ALT ${y.toFixed(1)}m` : 'ALT —';
        }
        const thrEl = $('ghost-steer-thr');
        if (thrEl && t) {
            const thr = Number(t.throttle) || 4;
            thrEl.textContent = `THR ${thr.toFixed(1)} ${thrBandLabel(thr)}`;
        }
        // HEAT / AP sit beside L/R roll grips — HEAT tracks throttle preview delta.
        const heat = $('ops-val-heat');
        const ap = $('ops-val-ap');
        if (heat) {
            const ph = previewHeatForTeam(t);
            heat.textContent = ph != null ? `${Math.round(ph)}°` : '—';
        }
        if (ap) {
            if (!t) {
                ap.textContent = '—';
            } else {
                const baseAp = (typeof t.ap === 'number') ? t.ap : 0;
                const cost = (typeof t.previewCostAp === 'number') ? t.previewCostAp : 0;
                ap.textContent = `${Math.round(Math.max(0, baseAp - cost))}`;
            }
        }
    }

    function syncGhostSteerHud(team) {
        const hud = $('ghost-steer-hud');
        if (!hud) return;
        const id = OpsRadial.teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
        const t = team || canPilotTeam() || (teams && teams[id]);
        // Persistent while the forward ghost is on screen (not only when ops radial is open).
        const show = ghostSteerShouldShow(t);
        if (!show) {
            if (GhostSteer.mode) endGhostSteer();
            hud.hidden = true;
            hud.classList.remove('is-visible');
            hud.setAttribute('aria-hidden', 'true');
            return;
        }
        const ringDrag = GhostSteer.mode === 'roll' || GhostSteer.mode === 'throttle';
        const scr = projectGhostScreen();
        if (!scr && !ringDrag) {
            if (GhostSteer.mode) endGhostSteer();
            hud.hidden = true;
            hud.classList.remove('is-visible');
            return;
        }
        hud.hidden = false;
        hud.classList.add('is-visible');
        hud.setAttribute('aria-hidden', 'false');
        // Freeze screen position while ring/handle dragging — a moving pivot = 跳舵.
        if (!ringDrag && scr) {
            hud.style.left = `${scr.x}px`;
            hud.style.top = `${scr.y}px`;
        }

        if (t) updateGhostJoyPip(Number(t.joyX) || 0, Number(t.joyY) || 0);
        // While dragging ring/handles, keep commanded bank (frozen during throttle-only).
        // Idle: match ghost on-screen bank so handles sit on the phantom wings.
        if (ringDrag) {
            syncCockpitRoll(commandRollRad(t));
        } else {
            const visual = getGhostVisualBankRad();
            const bank = (visual != null) ? visual : commandRollRad(t);
            syncCockpitRoll(bank, { skipCockpit: visual != null });
            setRollRingScale(1);
        }

        syncGhostSteerMeta(t);
        ensureGhostSteerTrack();
    }

    function sync3dOverlays(team) {
        syncGhostSteerHud(team);
    }

    function syncHpRing(team) {
        const el = $('ops-hp-ring');
        if (!el) return;
        const hp = Math.max(0, Math.min(100, Number(team && team.hp) || 0));
        const filled = (hp / 100) * HP_CIRC;
        el.setAttribute('stroke-dasharray', `${filled} ${HP_CIRC}`);
        el.setAttribute('stroke-dashoffset', '0');
        let col = '#00ff88';
        if (hp <= 30) col = '#ff3355';
        else if (hp <= 60) col = '#ffaa00';
        el.setAttribute('stroke', col);
        el.setAttribute('title', `HP ${Math.round(hp)}`);
    }

    function paintGhostThrottle(team) {
        syncGhostSteerHud(team);
    }

    function ensureGhostSteerTrack() {
        if (OpsRadial._raf) return;
        const tick = () => {
            const id = OpsRadial.teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
            const team = teams && teams[id];
            const needGhost = ghostSteerShouldShow(team);
            if (!OpsRadial.open && !needGhost) {
                OpsRadial._raf = 0;
                if (GhostSteer.mode) endGhostSteer();
                const hud = $('ghost-steer-hud');
                if (hud) {
                    hud.hidden = true;
                    hud.classList.remove('is-visible');
                }
                return;
            }
            if (OpsRadial.open && team) {
                sync3dOverlays(team);
                layoutAnchor(team);
            } else if (needGhost) {
                syncGhostSteerHud(team);
            }
            OpsRadial._raf = requestAnimationFrame(tick);
        };
        OpsRadial._raf = requestAnimationFrame(tick);
    }

    function isOpsRingChrome(el) {
        if (!el || !el.closest) return false;
        if (el.closest('#ops-radial-ring')) return true;
        if (el.closest('#ops-weapon-detail')) return true;
        return false;
    }

    /**
     * True only on the weapon wedge annulus (not the hollow HP disc).
     * Hollow-center clicks pass through and should close the ring.
     */
    function isInsideOpsWedgeAnnulus(clientX, clientY) {
        const ring = $('ops-radial-ring');
        if (!ring) return false;
        const rect = ring.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // SVG viewBox width 640 maps onto the ring box.
        const unit = Math.min(rect.width, rect.height) / 640;
        const r = Math.hypot(clientX - cx, clientY - cy);
        const rInner = WEDGE_R0 * unit;
        const rOuter = Math.max(WEDGE_R1 * unit, Math.min(rect.width, rect.height) * 0.5);
        return r >= rInner && r <= rOuter;
    }

    function onOpsOutsidePointerDown(e) {
        if (!OpsRadial.open) return;
        if (Date.now() < OpsRadial._outsideArmAt) return;
        // Only primary button / touch; ignore while ghost-steer / LCOS drag is active.
        if (e.button != null && e.button !== 0) return;
        if (window.isDraggingGhostSteer || window.isDraggingLcosRing) return;
        // OK / wedges / detail / hollow-hit are real targets — keep open here
        // (hollow-hit closes itself via its own handler).
        if (isOpsRingChrome(e.target)) return;
        // Wedge-annulus gaps (pointer-events none) keep open; hollow / outside close.
        if (isInsideOpsWedgeAnnulus(e.clientX, e.clientY)) return;
        OpsRadial._suppressPickOpenUntil = Date.now() + 360;
        setOpen(false);
    }

    function bindOpsOutsideClose(enable) {
        if (enable) {
            if (!OpsRadial._outsideBound) {
                window.addEventListener('pointerdown', onOpsOutsidePointerDown, true);
                OpsRadial._outsideBound = true;
            }
            // Opening pick arrives in the same gesture — arm after it settles.
            OpsRadial._outsideArmAt = Date.now() + 320;
        } else if (OpsRadial._outsideBound) {
            window.removeEventListener('pointerdown', onOpsOutsidePointerDown, true);
            OpsRadial._outsideBound = false;
            OpsRadial._outsideArmAt = 0;
        }
    }

    function setOpen(open, focus, teamId) {
        OpsRadial.open = !!open;
        OpsRadial.focus = focus || null;
        OpsRadial.teamId = teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
        const root = $('ops-radial-root');
        if (root) {
            root.hidden = !OpsRadial.open;
            root.setAttribute('aria-hidden', OpsRadial.open ? 'false' : 'true');
        }
        if (OpsRadial.open) {
            // Prefer collapsed classic panel so the new HUD owns the view.
            setClassicCollapsed(true);
            refresh();
            ensureGhostSteerTrack();
            bindOpsOutsideClose(true);
        } else {
            bindOpsOutsideClose(false);
            hideWeaponDetail();
            const o = OpsRadial._3d;
            if (o && o.gizmo) o.gizmo.visible = false;
            // Ghost steer ring stays resident while the forward phantom is visible.
            endGhostSteer();
            ensureGhostSteerTrack();
        }
    }

    function toggleForTeam(teamId, focus) {
        const id = teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
        const t = teams && teams[id];
        if (!t || t.isDestroyed || t.matchActive === false) {
            setOpen(false);
            return;
        }
        if (OpsRadial.open && OpsRadial.teamId === id && OpsRadial.focus === focus) {
            setOpen(false);
            return;
        }
        if (typeof selectTeam === 'function' && id) selectTeam(id);
        setOpen(true, focus || 'aircraft', id);
    }

    function wedgeColor(state) {
        // Idle = translucent black; selected/armed/powering = fully opaque; empty = transparent.
        if (state === 'armed') return 'rgb(0, 120, 72)';
        if (state === 'powering') return 'rgb(180, 110, 0)';
        if (state === 'empty') return 'rgba(255, 255, 255, 0.04)';
        if (state === 'active') return 'rgb(40, 40, 40)';
        return 'rgba(0, 0, 0, 0.55)';
    }

    function polar(cx, cy, r, deg) {
        const a = (deg - 90) * Math.PI / 180;
        return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    }

    function wedgePath(a0, a1, r0, r1) {
        const c = SVG_CX;
        const large = (a1 - a0) > 180 ? 1 : 0;
        const p0 = polar(c, c, r1, a0);
        const p1 = polar(c, c, r1, a1);
        const p2 = polar(c, c, r0, a1);
        const p3 = polar(c, c, r0, a0);
        return `M ${p0.x} ${p0.y} A ${r1} ${r1} 0 ${large} 1 ${p1.x} ${p1.y} L ${p2.x} ${p2.y} A ${r0} ${r0} 0 ${large} 0 ${p3.x} ${p3.y} Z`;
    }

    function weaponIconKind(opsId, team, pylon) {
        if (opsId === 'flare') return 'flare';
        if (opsId === 'chaff') return 'chaff';
        if (opsId === 'gun') return 'gun';
        if (!pylon) return 'fox2';
        const wt = (typeof pylonWeaponType === 'function')
            ? pylonWeaponType(pylon)
            : (pylon.weaponType || pylon.weapon || 'fox2');
        if (wt === 'fox1' || wt === 'bomb' || wt === 'rocket' || wt === 'fox2') return wt;
        return 'fox2';
    }

    /**
     * Screen-space grid cell at wedge mid-angle / mid-radius:
     * logo above text on the screen (SVG +y = down), not ring-inner/outer.
     */
    function wedgeCellAnchor(a0, a1) {
        const ang = a0 + (a1 - a0) * 0.5;
        return { ang, pt: polar(SVG_CX, SVG_CX, WEDGE_MID_R, ang) };
    }

    /** White silhouette logo — screen-above the text. */
    function appendWeaponIcon(parent, kind, a0, a1, empty) {
        const NS = 'http://www.w3.org/2000/svg';
        const { pt } = wedgeCellAnchor(a0, a1);
        const ig = document.createElementNS(NS, 'g');
        ig.setAttribute('class', empty ? 'ops-wedge-icon is-empty' : 'ops-wedge-icon');
        ig.setAttribute('transform', `translate(${pt.x.toFixed(2)} ${(pt.y - WEDGE_STACK_DY).toFixed(2)})`);
        ig.style.pointerEvents = 'none';
        const use = document.createElementNS(NS, 'use');
        use.setAttribute('href', `#ops-icon-${kind}`);
        use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#ops-icon-${kind}`);
        use.setAttribute('x', '-12');
        use.setAttribute('y', '-12');
        use.setAttribute('width', '24');
        use.setAttribute('height', '24');
        ig.appendChild(use);
        parent.appendChild(ig);
    }

    /** Multi-line text — screen-below the logo. */
    function appendWedgeText(parent, lines, a0, a1, empty) {
        const NS = 'http://www.w3.org/2000/svg';
        const { pt } = wedgeCellAnchor(a0, a1);
        const tg = document.createElementNS(NS, 'g');
        tg.setAttribute('class', empty ? 'ops-wedge-text is-empty' : 'ops-wedge-text');
        tg.setAttribute('transform', `translate(${pt.x.toFixed(2)} ${(pt.y + WEDGE_STACK_DY).toFixed(2)})`);
        tg.style.pointerEvents = 'none';
        const rows = (lines || []).filter((s) => s != null && String(s).length);
        rows.forEach((line, i) => {
            const text = document.createElementNS(NS, 'text');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'middle');
            text.setAttribute('x', '0');
            text.setAttribute('y', String((i - (rows.length - 1) * 0.5) * 10));
            text.setAttribute('fill', empty ? 'rgba(255,255,255,0.35)' : '#ffffff');
            text.setAttribute('font-family', 'Courier New, monospace');
            text.setAttribute('font-size', '9');
            text.setAttribute('font-weight', 'bold');
            text.style.pointerEvents = 'none';
            text.textContent = String(line);
            tg.appendChild(text);
        });
        parent.appendChild(tg);
    }

    function rebuildWedges(team) {
        const g = $('ops-radial-wedges');
        if (!g) return;
        while (g.firstChild) g.removeChild(g.firstChild);
        const NS = 'http://www.w3.org/2000/svg';
        // One fill wedge + logo-above-text grid cell (no divider).
        const mk = (a0, a1, fill, id, selected, iconKind, textLines, empty) => {
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', wedgePath(a0, a1, WEDGE_R0, WEDGE_R1));
            path.setAttribute('fill', fill);
            path.setAttribute('stroke', empty
                ? 'rgba(255,255,255,0.12)'
                : (selected ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.28)'));
            path.setAttribute('stroke-width', selected && !empty ? '1.5' : '1');
            path.style.pointerEvents = empty ? 'none' : 'fill';
            path.dataset.ops = id;
            if (selected) path.classList.add('is-selected');
            if (empty) path.classList.add('is-empty');
            g.appendChild(path);
            appendWeaponIcon(g, iconKind || 'fox2', a0, a1, empty);
            appendWedgeText(g, textLines || [], a0, a1, empty);
        };
        // Top 90° (−45…+45): flare | gun (center) | chaff.
        const flareArmed = !!(team && team.flaresArmed);
        const chaffArmed = !!(team && team.chaffArmed);
        const flareN = Number(team && team.flareAmmo) || 0;
        const chaffN = Number(team && team.chaffAmmo) || 0;
        const gunSelected = !!(team && team.weapon === 'gun');
        const gunHot = !!(team && GameContext.stateMachine
            && typeof GameContext.stateMachine.isGunOverheated === 'function'
            && GameContext.stateMachine.isGunOverheated(team.id));
        const gunQueued = !!(team && team.wpnQueued && team.queuedAction === 'gun');
        mk(-45, -15, wedgeColor(flareN <= 0 ? 'empty' : (flareArmed ? 'active' : 'idle')), 'flare', flareArmed, 'flare',
            ['FLARE', String(flareN)], flareN <= 0);
        mk(-15, 15, wedgeColor(gunHot ? 'empty' : (gunSelected || gunQueued ? 'active' : 'idle')), 'gun',
            gunSelected || gunQueued, 'gun',
            ['GUN', gunHot ? 'HOT' : (gunQueued ? 'QUE' : (gunSelected ? 'RDY' : 'OFF'))],
            false);
        mk(15, 45, wedgeColor(chaffN <= 0 ? 'empty' : (chaffArmed ? 'active' : 'idle')), 'chaff', chaffArmed, 'chaff',
            ['CHAFF', String(chaffN)], chaffN <= 0);
        // Bottom 270°: four pylons (45 → 315)
        const pylons = (team && Array.isArray(team.pylons)) ? team.pylons : [];
        const spans = [
            [45, 112.5, 0],
            [112.5, 180, 1],
            [180, 247.5, 2],
            [247.5, 315, 3]
        ];
        spans.forEach(([a0, a1, idx]) => {
            const p = pylons[idx];
            const st = p && p.state;
            const empty = !p || st === 'empty';
            const wt = p && (typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : p.weaponType);
            const modeMatch = (wt === 'bomb' && team && team.weapon === 'bomb')
                || (wt === 'rocket' && team && team.weapon === 'rocket')
                || (wt !== 'bomb' && wt !== 'rocket' && team && team.weapon === 'missile');
            const selected = !empty && modeMatch && (st === 'armed' || st === 'powering');
            const colorState = empty
                ? 'empty'
                : (modeMatch ? st : ((st === 'armed' || st === 'powering') ? 'idle' : st));
            const kind = weaponIconKind(`pylon-${idx + 1}`, team, p);
            mk(a0, a1, wedgeColor(colorState), `pylon-${idx + 1}`, selected, kind, pylonWedgeLines(p, team), empty);
        });
    }

    function refresh(teamObj) {
        const id = OpsRadial.teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
        const team = teamObj || (teams && teams[id]);
        if (!OpsRadial.open || !team) return;

        rebuildWedges(team);
        syncHpRing(team);

        const ok = $('ops-radial-ok');
        const ring = $('ops-radial-ring');
        const live = (typeof uiIsSeatLive === 'function') ? uiIsSeatLive(team.id) : true;
        const ready = !!team.ready && !team.aiEnabled;
        const isAi = !!team.aiEnabled;
        if (ok) {
            ok.disabled = !live || !!team.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode();
            ok.classList.toggle('is-ready', ready);
            ok.classList.toggle('is-ai', isAi);
            if (!live || team.isDestroyed) ok.textContent = '—';
            else if (isAi) ok.textContent = 'AI';
            else if (ready) ok.textContent = '待命';
            else ok.textContent = 'OK';
        }
        if (ring) {
            ring.classList.toggle('is-ok-ready', ready);
            ring.classList.toggle('is-ok-ai', isAi);
        }

        const heat = $('ops-val-heat');
        const ap = $('ops-val-ap');
        const sms = $('ops-sms-text');
        if (heat) {
            const ph = previewHeatForTeam(team);
            heat.textContent = ph != null ? `${Math.round(ph)}°` : '—';
        }
        if (ap) {
            const baseAp = (typeof team.ap === 'number') ? team.ap : 0;
            const cost = (typeof team.previewCostAp === 'number') ? team.previewCostAp : 0;
            ap.textContent = `${Math.round(Math.max(0, baseAp - cost))}`;
        }
        if (sms) {
            // Status only — no CCIP/RKT impact-range lines in the tactical computer.
            const src = $('sms-text-content');
            sms.textContent = (src && src.innerText) ? src.innerText : '狀態 [就緒]';
            sms.style.color = (src && src.style.color) ? src.style.color : '#ffeb3b';
            sms.classList.remove('is-ccip');
        }

        if (OpsDetail.kind) syncWeaponDetail(team);
        sync3dOverlays(team);
        paintGhostThrottle(team);
        layoutAnchor(team);
    }

    function projectWorldToScreen(worldPos) {
        if (!worldPos || typeof camera === 'undefined' || !camera || typeof THREE === 'undefined') return null;
        const v = worldPos.clone();
        v.project(camera);
        if (v.z > 1) return null;
        return {
            x: (v.x * 0.5 + 0.5) * window.innerWidth,
            y: (-v.y * 0.5 + 0.5) * window.innerHeight
        };
    }

    function layoutAnchor(team) {
        const anchor = $('ops-radial-anchor');
        if (!anchor) return;
        // Keep ops ring centered on the aircraft while the camera orbits.
        // (Steer HUD stays on the forward ghost; this ring stays on the plane.)
        const t = team || (teams && teams[OpsRadial.teamId]);
        const world = (t && t.wrapper) ? t.wrapper.position : null;
        const scr = projectWorldToScreen(world);
        const ringEl = $('ops-radial-ring');
        const ringRect = ringEl ? ringEl.getBoundingClientRect() : null;
        const half = (ringRect && ringRect.width > 0)
            ? ringRect.width * 0.5
            : Math.min(350, window.innerWidth * 0.46);
        if (!scr) {
            anchor.style.left = '50%';
            anchor.style.top = '55%';
            anchor.style.bottom = 'auto';
            anchor.style.transform = 'translate(-50%, -50%)';
            layoutWeaponDetailPanel();
            return;
        }
        const minX = half + 8;
        const maxX = window.innerWidth - half - 8;
        const minY = half + 8;
        const maxY = window.innerHeight - half - 24;
        const x = minX > maxX ? window.innerWidth * 0.5 : Math.max(minX, Math.min(maxX, scr.x));
        const y = minY > maxY ? window.innerHeight * 0.5 : Math.max(minY, Math.min(maxY, scr.y));
        anchor.style.left = `${x}px`;
        anchor.style.top = `${y}px`;
        anchor.style.bottom = 'auto';
        anchor.style.transform = 'translate(-50%, -50%)';
        layoutWeaponDetailPanel();
    }

    function clickPylon(pylonId) {
        // Listener is on the wrapper, not the stick.
        const wrap = document.querySelector(`.pylon-switch-wrapper[data-pylon="${pylonId}"]`);
        if (wrap) {
            wrap.click();
            return;
        }
        const stick = $(`pylon-stick-${pylonId}`);
        if (stick) stick.click();
    }

    function weaponCfgForPylon(p) {
        const wt = (typeof pylonWeaponType === 'function')
            ? pylonWeaponType(p)
            : (p && (p.weaponType || p.weapon)) || 'fox2';
        const table = (typeof CONFIG !== 'undefined' && CONFIG.weapons) ? CONFIG.weapons : {};
        return { wt, cfg: table[wt] || table.fox2 || {} };
    }

    function buildWeaponStatRows(p, wt, cfg, team) {
        const rows = [];
        const st = (p && p.state) || '—';
        rows.push(['掛架', `P${p && p.id != null ? p.id : '—'} · ${String(st).toUpperCase()}`]);
        rows.push(['武器', cfg.name || wt || '—']);
        if (cfg.damage != null) rows.push(['傷害', String(cfg.damage)]);
        if (wt === 'fox1' || wt === 'fox2') {
            if (cfg.seekerRange != null) rows.push(['尋標距離', `${cfg.seekerRange} m`]);
            if (cfg.maxFlightRange != null) rows.push(['最大射程', `${cfg.maxFlightRange} m`]);
            if (cfg.minArmingRange != null) rows.push(['最短解鎖', `${cfg.minArmingRange} m`]);
            if (cfg.fuseRange != null) rows.push(['引信半徑', `${cfg.fuseRange} m`]);
            if (cfg.guidance) rows.push(['導引', String(cfg.guidance).toUpperCase()]);
            if (cfg.speed != null) rows.push(['速度', String(cfg.speed)]);
            if (cfg.turnRate != null) rows.push(['轉率', String(cfg.turnRate)]);
        } else if (wt === 'rocket') {
            const ammo = (typeof AirArenaRocket !== 'undefined')
                ? AirArenaRocket.ensurePodAmmo(p)
                : (Number(p && p.ammo) || 0);
            const fallbackPodMax = (typeof CONFIG !== 'undefined' && CONFIG && typeof CONFIG.getRocketRoundsPerPod === 'function')
                ? CONFIG.getRocketRoundsPerPod()
                : (cfg.roundsPerPod || 9);
            const max = Number(p && p.ammoMax) || fallbackPodMax;
            const fuze = (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.getTeamFuzeMode === 'function')
                ? AirArenaRocket.getTeamFuzeMode(team)
                : ((team && team.rocketFuze === 'impact') ? 'impact' : 'vt');
            rows.push(['彈藥', `${ammo} / ${max}`]);
            const salvo = (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.getTeamSalvoCount === 'function')
                ? AirArenaRocket.getTeamSalvoCount(team, ammo)
                : (cfg.salvoPerTurn != null ? cfg.salvoPerTurn : 3);
            rows.push(['齊射', `${salvo} / 回`]);
            rows.push(['引信', fuze === 'impact' ? 'IMPACT 撞擊對地' : 'VT 對空近發']);
            if (fuze === 'vt') {
                if (cfg.range != null) rows.push(['對空射程', `${cfg.range} m`]);
                if (cfg.vtRadius != null) rows.push(['VT 半徑', `${cfg.vtRadius} m`]);
            } else {
                rows.push(['觸發', '觸地／建築／直擊']);
            }
            if (cfg.blastRadius != null) rows.push(['爆震半徑', `${cfg.blastRadius} m`]);
        } else if (wt === 'bomb') {
            if (cfg.blastRadius != null) rows.push(['爆震半徑', `${cfg.blastRadius} m`]);
            rows.push(['模式', 'CCIP']);
        }
        return rows;
    }

    function pylonSpanForId(pylonId) {
        const spans = [
            [45, 112.5, 1],
            [112.5, 180, 2],
            [180, 247.5, 3],
            [247.5, 315, 4]
        ];
        return spans.find((s) => s[2] === pylonId) || null;
    }

    function hideWeaponDetail() {
        OpsDetail.kind = null;
        OpsDetail.pylonId = null;
        OpsDetail.a0 = null;
        OpsDetail.a1 = null;
        const panel = $('ops-weapon-detail');
        if (panel) {
            panel.hidden = true;
            panel.setAttribute('aria-hidden', 'true');
            panel.classList.remove('is-left', 'is-right');
        }
        const salvoWrap = $('ops-wpn-salvo');
        if (salvoWrap) salvoWrap.hidden = true;
    }

    /**
     * Dock the detail box beside the pressed wedge: screen-left of left-side
     * buttons, screen-right of right-side buttons.
     */
    function layoutWeaponDetailPanel() {
        const panel = $('ops-weapon-detail');
        if (!panel || panel.hidden || !OpsDetail.kind) return;
        const svg = $('ops-radial-svg');
        const ring = $('ops-radial-ring');
        if (!svg || !ring) return;

        const a0 = OpsDetail.a0;
        const a1 = OpsDetail.a1;
        if (a0 == null || a1 == null) return;
        const { pt } = wedgeCellAnchor(a0, a1);

        // Map SVG user point → screen via the rendered SVG rect / viewBox.
        const vb = svg.viewBox && svg.viewBox.baseVal
            ? svg.viewBox.baseVal
            : { x: -40, y: -40, width: 640, height: 640 };
        const rect = svg.getBoundingClientRect();
        const sx = rect.left + ((pt.x - vb.x) / vb.width) * rect.width;
        const sy = rect.top + ((pt.y - vb.y) / vb.height) * rect.height;

        const gap = 14;
        const panelW = Math.min(280, window.innerWidth * 0.9);
        const panelH = Math.min(panel.offsetHeight || 220, window.innerHeight - 16);
        // Prefer outward toward the nearer screen edge (left wedges → left, right → right).
        const preferLeft = sx < window.innerWidth * 0.5;
        let left;
        if (preferLeft) {
            left = sx - gap - panelW;
            if (left < 8) left = Math.min(window.innerWidth - panelW - 8, sx + gap);
        } else {
            left = sx + gap;
            if (left + panelW > window.innerWidth - 8) {
                left = Math.max(8, sx - gap - panelW);
            }
        }
        let top = sy - panelH * 0.35;
        top = Math.max(8, Math.min(window.innerHeight - panelH - 8, top));

        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        panel.classList.toggle('is-left', preferLeft);
        panel.classList.toggle('is-right', !preferLeft);
    }

    function buildGunStatRows(team) {
        const cfg = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.gun)
            ? CONFIG.weapons.gun
            : {};
        const rows = [];
        rows.push(['武器', cfg.name || '機砲']);
        if (cfg.damage != null) rows.push(['傷害', String(cfg.damage)]);
        if (cfg.range != null) rows.push(['射程', `${cfg.range} m`]);
        if (cfg.angle != null) rows.push(['錐角', `${((cfg.angle * 180) / Math.PI).toFixed(1)}°`]);
        const heat = Number(team && team.gunHeat);
        if (Number.isFinite(heat)) rows.push(['炮管熱', `${Math.round(heat * 100)}%`]);
        const hot = !!(team && GameContext.stateMachine
            && typeof GameContext.stateMachine.isGunOverheated === 'function'
            && GameContext.stateMachine.isGunOverheated(team.id));
        rows.push(['狀態', hot ? '過熱' : (team && team.weapon === 'gun' ? '就緒' : '未選')]);
        return rows;
    }

    function syncWeaponDetail(team) {
        const panel = $('ops-weapon-detail');
        if (!panel || !OpsDetail.kind) return;
        const t = team || (teams && teams[OpsRadial.teamId]);
        if (!t) {
            hideWeaponDetail();
            return;
        }

        const fuzeWrap = $('ops-wpn-fuze');
        const salvoWrap = $('ops-wpn-salvo');
        if (OpsDetail.kind === 'gun') {
            if (fuzeWrap) fuzeWrap.hidden = true;
            if (salvoWrap) salvoWrap.hidden = true;
            const cfg = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.gun)
                ? CONFIG.weapons.gun
                : {};
            const title = $('ops-wpn-title');
            if (title) title.textContent = cfg.name || '機關炮';
            const list = $('ops-wpn-stats');
            if (list) {
                list.innerHTML = '';
                buildGunStatRows(t).forEach(([k, v]) => {
                    const li = document.createElement('li');
                    li.innerHTML = `<span class="ops-wpn-k">${k}</span><span class="ops-wpn-v">${v}</span>`;
                    list.appendChild(li);
                });
            }
            const fire = $('ops-wpn-fire');
            if (fire) {
                const hot = !!(GameContext.stateMachine
                    && typeof GameContext.stateMachine.isGunOverheated === 'function'
                    && GameContext.stateMachine.isGunOverheated(t.id));
                const canFire = t.weapon === 'gun' && !hot;
                const queued = !!(t.wpnQueued && t.queuedAction === 'gun');
                fire.disabled = !canFire;
                fire.classList.toggle('is-armed-ready', canFire && !queued);
                fire.classList.toggle('is-queued', canFire && queued);
                fire.textContent = '射擊 ENT';
                fire.title = hot
                    ? '機砲過熱'
                    : (queued ? '已排程 — 再按可取消' : '按 ENT 排程射擊');
            }
            panel.hidden = false;
            panel.setAttribute('aria-hidden', 'false');
            layoutWeaponDetailPanel();
            return;
        }

        const p = t && Array.isArray(t.pylons)
            ? t.pylons.find((x) => x && x.id === OpsDetail.pylonId)
            : null;
        if (!p || p.state === 'empty') {
            hideWeaponDetail();
            return;
        }
        const { wt, cfg } = weaponCfgForPylon(p);
        const title = $('ops-wpn-title');
        if (title) title.textContent = `P${p.id} · ${cfg.name || wt}`;
        const list = $('ops-wpn-stats');
        if (list) {
            list.innerHTML = '';
            buildWeaponStatRows(p, wt, cfg, t).forEach(([k, v]) => {
                const li = document.createElement('li');
                li.innerHTML = `<span class="ops-wpn-k">${k}</span><span class="ops-wpn-v">${v}</span>`;
                list.appendChild(li);
            });
        }
        if (fuzeWrap) {
            if (wt === 'rocket') {
                fuzeWrap.hidden = false;
                const curFuze = (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.getTeamFuzeMode === 'function')
                    ? AirArenaRocket.getTeamFuzeMode(t)
                    : (t.rocketFuze === 'impact' ? 'impact' : 'vt');
                const tips = (typeof CONFIG !== 'undefined' && CONFIG && typeof CONFIG.formatRocketFuzeTooltips === 'function')
                    ? CONFIG.formatRocketFuzeTooltips()
                    : null;
                fuzeWrap.querySelectorAll('.ops-fuze-btn').forEach((btn) => {
                    const fz = btn.getAttribute('data-fuze');
                    btn.classList.toggle('is-active', fz === curFuze);
                    if (tips) {
                        btn.title = fz === 'impact' ? tips.impactTitle : tips.vtTitle;
                    }
                });
            } else {
                fuzeWrap.hidden = true;
            }
        }
        if (salvoWrap) {
            if (wt === 'rocket' && t && !t.aiEnabled) {
                salvoWrap.hidden = false;
                if (typeof window.uiSyncRocketSalvoPicker === 'function') {
                    window.uiSyncRocketSalvoPicker(t);
                }
            } else {
                salvoWrap.hidden = true;
            }
        }
        const fire = $('ops-wpn-fire');
        if (fire) {
            const canFire = p.state === 'armed';
            const queueAct = (wt === 'bomb' || wt === 'rocket') ? wt : 'missile';
            const queued = !!(t && t.wpnQueued && t.queuedAction === queueAct);
            fire.disabled = !canFire;
            fire.classList.toggle('is-armed-ready', canFire && !queued);
            fire.classList.toggle('is-queued', canFire && queued);
            fire.textContent = wt === 'bomb' ? '投放 ENT' : (wt === 'rocket' ? '齊射 ENT' : '發射 ENT');
            fire.title = !canFire
                ? (p.state === 'powering' ? '尋標頭開機中' : '需先通電就緒')
                : (queued ? '已排程 — 再按可取消' : '通電就緒 — 按 ENT 排程發射');
        }
        panel.hidden = false;
        panel.setAttribute('aria-hidden', 'false');
        layoutWeaponDetailPanel();
    }

    function openGunDetail() {
        OpsDetail.kind = 'gun';
        OpsDetail.pylonId = null;
        OpsDetail.a0 = -15;
        OpsDetail.a1 = 15;
        const teamId = OpsRadial.teamId;
        if (teamId && typeof selectTeam === 'function') {
            try { selectTeam(teamId); } catch (_) { /* ignore */ }
        }
        if (teamId && GameContext.stateMachine && typeof GameContext.stateMachine.setWeaponMode === 'function') {
            GameContext.stateMachine.setWeaponMode(teamId, 'gun');
            if (typeof showSMSAlert === 'function') {
                showSMSAlert('⚠️ 主武裝：機關炮', '#ffaa00');
            }
        }
        const t = teams && teams[teamId];
        if (typeof updateDashboardUI === 'function' && t) updateDashboardUI(t);
        if (typeof uiRefreshPreview === 'function' && t) uiRefreshPreview(t);
        syncWeaponDetail(t);
        refresh(t);
    }

    function openWeaponDetail(pylonId) {
        const span = pylonSpanForId(pylonId);
        OpsDetail.kind = 'pylon';
        OpsDetail.pylonId = pylonId;
        OpsDetail.a0 = span ? span[0] : null;
        OpsDetail.a1 = span ? span[1] : null;
        const teamId = OpsRadial.teamId;
        if (teamId && typeof selectTeam === 'function') {
            try { selectTeam(teamId); } catch (_) { /* ignore */ }
        }
        // One-way power-up via classic pylon path (SMS alerts + mode switch).
        clickPylon(pylonId);
        const t = teams && teams[teamId];
        syncWeaponDetail(t);
        refresh(t);
    }

    let _lastOpsAt = 0;
    function handleOpsAction(opsId) {
        if (!opsId) return;
        const now = Date.now();
        if (now - _lastOpsAt < 280) return; // swallow click+pointerup doubles
        _lastOpsAt = now;
        // Ensure SMS handlers see the seat this radial was opened for.
        const teamId = OpsRadial.teamId;
        if (teamId && typeof selectTeam === 'function') {
            try { selectTeam(teamId); } catch (_) { /* ignore */ }
        }
        if (opsId === 'flare') {
            hideWeaponDetail();
            const b = $('btn-flare'); if (b) b.click();
        } else if (opsId === 'chaff') {
            hideWeaponDetail();
            const b = $('btn-chaff'); if (b) b.click();
        } else if (opsId === 'gun') {
            openGunDetail();
            return;
        } else if (opsId.indexOf('pylon-') === 0) {
            const n = parseInt(opsId.slice(6), 10);
            if (n >= 1 && n <= 4) openWeaponDetail(n);
            return;
        }
        refresh();
    }

    function bindActions() {
        const root = $('ops-radial-root');
        if (!root || root.dataset.bound) return;
        root.dataset.bound = '1';

        const ok = $('ops-radial-ok');
        if (ok) {
            ok.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const btn = $('sms-exec-btn');
                if (btn) btn.click();
                else {
                    const teamId = OpsRadial.teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
                    if (teamId && typeof toggleReadyState === 'function') toggleReadyState(teamId);
                }
                refresh();
            });
        }

        const hollow = $('ops-hollow-hit');
        if (hollow) {
            const dismissHollow = (e) => {
                e.preventDefault();
                e.stopPropagation();
                OpsRadial._suppressPickOpenUntil = Date.now() + 360;
                setOpen(false);
            };
            hollow.addEventListener('click', dismissHollow);
            hollow.addEventListener('pointerup', (e) => {
                if (e.pointerType === 'touch' || e.pointerType === 'pen') dismissHollow(e);
            });
        }

        const wpnClose = $('ops-wpn-close');
        if (wpnClose) wpnClose.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            hideWeaponDetail();
        });
        const wpnFuze = $('ops-wpn-fuze');
        if (wpnFuze) {
            wpnFuze.addEventListener('click', (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('.ops-fuze-btn') : null;
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                const mode = btn.getAttribute('data-fuze');
                const teamId = OpsRadial.teamId;
                if (typeof window.uiToggleRocketFuze === 'function') {
                    window.uiToggleRocketFuze(teamId, mode);
                } else if (teamId && GameContext.stateMachine && typeof GameContext.stateMachine.setRocketFuze === 'function') {
                    GameContext.stateMachine.setRocketFuze(teamId, mode);
                }
                const t = teams && teams[teamId];
                syncWeaponDetail(t);
                refresh(t);
            });
        }
        const wpnSalvo = $('ops-wpn-salvo');
        if (wpnSalvo) {
            wpnSalvo.addEventListener('click', (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('.ops-salvo-step') : null;
                if (!btn || btn.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                const delta = parseInt(btn.getAttribute('data-salvo-delta'), 10);
                const teamId = OpsRadial.teamId;
                if (typeof window.uiNudgeRocketSalvo === 'function') {
                    window.uiNudgeRocketSalvo(teamId, delta);
                }
                const t = teams && teams[teamId];
                syncWeaponDetail(t);
                refresh(t);
            });
        }
        const wpnFire = $('ops-wpn-fire');
        if (wpnFire) wpnFire.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const teamId = OpsRadial.teamId;
            if (teamId && typeof selectTeam === 'function') {
                try { selectTeam(teamId); } catch (_) { /* ignore */ }
            }
            const before = !!(teams && teams[teamId] && teams[teamId].wpnQueued);
            if (typeof uiToggleWeaponFireQueue === 'function') uiToggleWeaponFireQueue(teamId);
            const t = teams && teams[teamId];
            const queued = !!(t && t.wpnQueued);
            // After choosing fire (newly queued), dismiss the weapon ring.
            if (queued && !before) {
                setOpen(false);
                return;
            }
            syncWeaponDetail(t);
            refresh(t);
        });

        // Full SVG annulus wedges (paths are rebuilt often — delegate on stable <g>).
        const wedges = $('ops-radial-wedges');
        if (wedges && !wedges.dataset.bound) {
            wedges.dataset.bound = '1';
            const onWedge = (e) => {
                let el = e.target;
                while (el && el !== wedges) {
                    if (el.getAttribute && el.getAttribute('data-ops')) break;
                    el = el.parentNode;
                }
                if (!el || el === wedges) return;
                const opsId = el.getAttribute('data-ops');
                if (!opsId) return;
                e.preventDefault();
                e.stopPropagation();
                handleOpsAction(opsId);
            };
            wedges.addEventListener('click', onWedge);
            wedges.addEventListener('pointerup', (e) => {
                // Touch: path click can be flaky; treat short taps via pointerup.
                if (e.pointerType === 'touch' || e.pointerType === 'pen') onWedge(e);
            });
        }

        const ring = $('ops-radial-ring');
        if (ring) {
            ring.addEventListener('wheel', (e) => {
                if (!OpsRadial.open) return;
                const id = OpsRadial.teamId;
                const t = teams && teams[id];
                if (!t || t.aiEnabled || t.ready || GameContext.isAnimating()) return;
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.15 : 0.15;
                const next = Math.max(1, Math.min(5, (Number(t.throttle) || 4) + delta));
                if (GameContext.stateMachine && GameContext.stateMachine.setThrottle) {
                    GameContext.stateMachine.setThrottle(id, next);
                } else {
                    t.throttle = next;
                }
                if (typeof updateDashboardUI === 'function') updateDashboardUI(t);
                if (typeof uiRefreshPreview === 'function') uiRefreshPreview(t);
                refresh(t);
            }, { passive: false });
        }
    }

    function onAircraftOrGhostPicked(teamId, focus) {
        // Same gesture that dismissed via hollow/outside must not reopen via 3D pick.
        if (Date.now() < OpsRadial._suppressPickOpenUntil && !OpsRadial.open) return;
        toggleForTeam(teamId, focus || 'aircraft');
    }

    function init() {
        initCollapseToggle();
        bindActions();
        bindGhostSteerHud();
        window.AirArenaOpsRadial = {
            open: setOpen,
            toggle: toggleForTeam,
            refresh,
            isOpen: () => OpsRadial.open,
            state: OpsRadial,
            onPick: onAircraftOrGhostPicked,
            setClassicCollapsed,
            syncGhostSteer: syncGhostSteerHud
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
