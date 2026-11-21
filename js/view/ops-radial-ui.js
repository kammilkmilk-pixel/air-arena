// ============================================================================
// ops-radial-ui.js — semi-transparent radial ops HUD + classic panel collapse
// ============================================================================
(function () {
    const COLLAPSE_KEY = 'airarena.opsPanelCollapsed';
    /** SVG layout (viewBox 280², center 140). Center HP disc ≈2× prior r=58. */
    const SVG_CX = 140;
    const HP_R = 110;
    const HP_CIRC = 2 * Math.PI * HP_R;
    // Outer pylon/CM ring: ~2× annulus area (was r 114–132).
    const WEDGE_R0 = 114;
    const WEDGE_R1 = 150;

    const OpsRadial = {
        open: false,
        focus: null, // 'aircraft' | 'ghost'
        teamId: null,
        _raf: 0
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

    function pylonShortLabel(p) {
        if (!p) return '—';
        const wt = (typeof pylonWeaponType === 'function') ? pylonWeaponType(p) : p.weaponType;
        let w = 'F2';
        if (wt === 'fox1') w = 'F1';
        else if (wt === 'bomb') w = 'BMB';
        else if (wt === 'rocket') {
            const ammo = (typeof AirArenaRocket !== 'undefined')
                ? AirArenaRocket.ensurePodAmmo(p)
                : (Number(p.ammo) || 0);
            const max = Number(p.ammoMax) || 9;
            w = `R${ammo}`;
            void max;
        }
        const st = (p.state || 'standby').slice(0, 3).toUpperCase();
        return `P${p.id} ${w}\n${st}`;
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
        mode: null, // 'nose' | 'roll'
        pointerId: null,
        startX: 0,
        startY: 0,
        startJoyX: 0,
        startJoyY: 0,
        startRoll: 0,
        startAngle: 0,
        bound: false
    };

    const NOSE_DRAG = {
        softJoy: 0.40,
        softFrac: 0.09,
        softMin: 64,
        softMax: 96,
        fullFrac: 0.26,
        fullMin: 170,
        fullMax: 260
    };

    function canPilotTeam(teamId) {
        if (typeof GameContext === 'undefined' || typeof teams === 'undefined') return null;
        const id = teamId || OpsRadial.teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
        const t = id ? teams[id] : null;
        if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return null;
        if (GameContext.isReplayMode && GameContext.isReplayMode()) return null;
        return t;
    }

    function getNoseDragRadii() {
        const shortSide = Math.min(window.innerWidth || 800, window.innerHeight || 600);
        const softPx = Math.max(NOSE_DRAG.softMin, Math.min(NOSE_DRAG.softMax, shortSide * NOSE_DRAG.softFrac));
        const fullPx = Math.max(NOSE_DRAG.fullMin, Math.min(NOSE_DRAG.fullMax, shortSide * NOSE_DRAG.fullFrac));
        return { softPx, fullPx: Math.max(fullPx, softPx + 40) };
    }

    function mapDistToJoyMag(dist, softPx, fullPx) {
        if (!(dist > 0)) return 0;
        if (dist <= softPx) return (dist / softPx) * NOSE_DRAG.softJoy;
        const span = Math.max(1, fullPx - softPx);
        const t = Math.min(1, (dist - softPx) / span);
        return NOSE_DRAG.softJoy + (1 - NOSE_DRAG.softJoy) * (t * t);
    }

    function mapScreenDragToJoy(dx, dy, mag, team) {
        const dist = Math.hypot(dx, dy);
        if (!(dist > 0.001) || !(mag > 0)) return { joyX: 0, joyY: 0 };
        const cam = (typeof camera !== 'undefined') ? camera : null;
        const quat = team && team.wrapper
            ? (team.wrapper.userData.logicalQuat || team.wrapper.quaternion)
            : null;
        if (!cam || !quat || typeof THREE === 'undefined') {
            return { joyX: (-dx / dist) * mag, joyY: (-dy / dist) * mag };
        }
        const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const camUp = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
        const camFwd = new THREE.Vector3();
        cam.getWorldDirection(camFwd);
        const desired = camRight.clone().multiplyScalar(dx).add(camUp.clone().multiplyScalar(-dy));
        if (desired.lengthSq() < 1e-10) return { joyX: 0, joyY: 0 };
        desired.normalize();
        const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
        const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
        const rightScreen = bodyRight.clone().addScaledVector(camFwd, -bodyRight.dot(camFwd));
        const upScreen = bodyUp.clone().addScaledVector(camFwd, -bodyUp.dot(camFwd));
        if (rightScreen.lengthSq() < 1e-8 || upScreen.lengthSq() < 1e-8) {
            return { joyX: (-dx / dist) * mag, joyY: (-dy / dist) * mag };
        }
        rightScreen.normalize();
        upScreen.normalize();
        let jx = desired.dot(rightScreen);
        let jy = desired.dot(upScreen);
        const len = Math.hypot(jx, jy);
        if (len < 1e-6) return { joyX: 0, joyY: 0 };
        return { joyX: (-jx / len) * mag, joyY: (jy / len) * mag };
    }

    function clampJoy(joyX, joyY) {
        const len = Math.hypot(joyX, joyY);
        if (len <= 1 || len < 1e-8) return { joyX, joyY };
        return { joyX: joyX / len, joyY: joyY / len };
    }

    function syncCockpitJoy(joyX, joyY) {
        const joyZone = $('joystick-zone');
        const joyHandle = $('joystick-handle');
        if (!joyZone || !joyHandle) return;
        const maxRadius = Math.max(8, joyZone.getBoundingClientRect().width / 2 - 15);
        joyHandle.style.transform = `translate(${joyX * maxRadius}px, ${-joyY * maxRadius}px)`;
    }

    function syncCockpitRoll(angle) {
        const rollRing = $('roll-ring');
        if (rollRing) rollRing.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
        // SVG only — CSS rotate on <g> uses wrong origin and drifts off-axis.
        const ghostRoll = $('ghost-roll-ring');
        if (ghostRoll) {
            if (ghostRoll.style) ghostRoll.style.transform = 'none';
            ghostRoll.setAttribute('transform', `rotate(${(angle * 180) / Math.PI} 70 70)`);
        }
    }

    function setOrbitLocked(locked) {
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
        if (!t) return;
        if (typeof camera !== 'undefined' && camera && camera.updateMatrixWorld) camera.updateMatrixWorld();
        const dx = clientX - GhostSteer.startX;
        const dy = clientY - GhostSteer.startY;
        const dist = Math.hypot(dx, dy);
        if (dist < 2) {
            syncCockpitJoy(GhostSteer.startJoyX, GhostSteer.startJoyY);
            return;
        }
        const { softPx, fullPx } = getNoseDragRadii();
        const mag = mapDistToJoyMag(dist, softPx, fullPx);
        const delta = mapScreenDragToJoy(dx, dy, mag, t);
        const next = clampJoy(GhostSteer.startJoyX + delta.joyX, GhostSteer.startJoyY + delta.joyY);
        if (!GameContext.stateMachine.setJoystickInput(t.id, next.joyX, next.joyY)) return;
        syncCockpitJoy(next.joyX, next.joyY);
        updateGhostJoyPip(next.joyX, next.joyY);
        if (typeof uiRefreshPreview === 'function') uiRefreshPreview(t);
        else if (typeof updateDashboardUI === 'function') updateDashboardUI(t);
    }

    function applyRollDrag(clientX, clientY) {
        const t = canPilotTeam();
        if (!t) return;
        const hud = $('ghost-steer-hud');
        if (!hud) return;
        const rect = hud.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const ang = Math.atan2(clientX - cx, -(clientY - cy));
        let delta = ang - GhostSteer.startAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        const angle = GhostSteer.startRoll + delta;
        if (!GameContext.stateMachine.setRollInput(t.id, angle)) return;
        const applied = t.pendingRoll || 0;
        syncCockpitRoll(applied);
        if (typeof uiRefreshPreview === 'function') uiRefreshPreview(t);
    }

    function updateGhostJoyPip(joyX, joyY) {
        const pip = $('ghost-joy-pip');
        if (!pip) return;
        // viewBox center 70; map joy into ~22px radius
        pip.setAttribute('cx', String(70 + (Number(joyX) || 0) * 22));
        pip.setAttribute('cy', String(70 - (Number(joyY) || 0) * 22));
    }

    function endGhostSteer(e) {
        if (!GhostSteer.mode) return;
        if (e && GhostSteer.pointerId != null && e.pointerId !== GhostSteer.pointerId) return;
        const hud = $('ghost-steer-hud');
        if (hud) {
            hud.classList.remove('is-nose-dragging', 'is-roll-dragging');
        }
        GhostSteer.mode = null;
        GhostSteer.pointerId = null;
        setOrbitLocked(false);
        window.isDraggingGhostSteer = false;
        if (typeof isDraggingRollRing !== 'undefined') isDraggingRollRing = false;
    }

    function beginNose(e) {
        if (e.button != null && e.button !== 0) return;
        if (window.isDraggingLcosRing || (typeof isDraggingJoystick !== 'undefined' && isDraggingJoystick)) return;
        const t = canPilotTeam();
        if (!t) return;
        GhostSteer.mode = 'nose';
        GhostSteer.pointerId = e.pointerId;
        GhostSteer.startX = e.clientX;
        GhostSteer.startY = e.clientY;
        GhostSteer.startJoyX = Number(t.joyX) || 0;
        GhostSteer.startJoyY = Number(t.joyY) || 0;
        window.isDraggingGhostSteer = true;
        setOrbitLocked(true);
        const hud = $('ghost-steer-hud');
        if (hud) hud.classList.add('is-nose-dragging');
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        syncCockpitJoy(GhostSteer.startJoyX, GhostSteer.startJoyY);
        updateGhostJoyPip(GhostSteer.startJoyX, GhostSteer.startJoyY);
    }

    function beginRoll(e) {
        if (e.button != null && e.button !== 0) return;
        if (window.isDraggingLcosRing || window.isDraggingGhostSteer) return;
        const t = canPilotTeam();
        if (!t) return;
        const hud = $('ghost-steer-hud');
        if (!hud) return;
        const rect = hud.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        GhostSteer.mode = 'roll';
        GhostSteer.pointerId = e.pointerId;
        GhostSteer.startAngle = Math.atan2(e.clientX - cx, -(e.clientY - cy));
        GhostSteer.startRoll = (t.pendingRoll !== 0 && t.pendingRoll != null) ? t.pendingRoll : (Number(t.roll) || 0);
        window.isDraggingGhostSteer = true;
        if (typeof isDraggingRollRing !== 'undefined') isDraggingRollRing = true;
        setOrbitLocked(true);
        hud.classList.add('is-roll-dragging');
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
    }

    function onGhostSteerMove(e) {
        if (!GhostSteer.mode) return;
        if (GhostSteer.pointerId != null && e.pointerId !== GhostSteer.pointerId) return;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (GhostSteer.mode === 'nose') applyNoseDrag(e.clientX, e.clientY);
        else if (GhostSteer.mode === 'roll') applyRollDrag(e.clientX, e.clientY);
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
            el.addEventListener('pointermove', onGhostSteerMove, { passive: false });
            el.addEventListener('pointerup', endGhostSteer);
            el.addEventListener('pointercancel', endGhostSteer);
            el.addEventListener('lostpointercapture', endGhostSteer);
        });

        const rollTargets = [rollHit, left, right].filter(Boolean);
        rollTargets.forEach((el) => {
            el.addEventListener('pointerdown', beginRoll, { passive: false });
            el.addEventListener('pointermove', onGhostSteerMove, { passive: false });
            el.addEventListener('pointerup', endGhostSteer);
            el.addEventListener('pointercancel', endGhostSteer);
            el.addEventListener('lostpointercapture', endGhostSteer);
        });
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

    function syncGhostSteerHud(team) {
        const hud = $('ghost-steer-hud');
        if (!hud) return;
        const t = team || canPilotTeam();
        const show = !!(OpsRadial.open && t && window.ghostWrapper && window.ghostWrapper.visible
            && !GameContext.isReplayMode() && !GameContext.isAnimating());
        if (!show) {
            hud.hidden = true;
            hud.classList.remove('is-visible');
            hud.setAttribute('aria-hidden', 'true');
            return;
        }
        const scr = projectGhostScreen();
        if (!scr) {
            hud.hidden = true;
            hud.classList.remove('is-visible');
            return;
        }
        hud.hidden = false;
        hud.classList.add('is-visible');
        hud.setAttribute('aria-hidden', 'false');
        hud.style.left = `${scr.x}px`;
        hud.style.top = `${scr.y}px`;

        updateGhostJoyPip(Number(t.joyX) || 0, Number(t.joyY) || 0);
        const roll = (t.pendingRoll !== 0 && t.pendingRoll != null) ? t.pendingRoll : (Number(t.roll) || 0);
        syncCockpitRoll(roll);

        const thrEl = $('ghost-steer-thr');
        if (thrEl) {
            const thr = Number(t.throttle) || 4;
            thrEl.textContent = `THR ${thr.toFixed(1)} ${thrBandLabel(thr)}`;
        }
    }

    /** Legacy 3D gizmo removed — interaction is the screen-space ghost-steer HUD. */
    function sync3dOverlays(team) {
        if (OpsRadial._3d && OpsRadial._3d.gizmo) OpsRadial._3d.gizmo.visible = false;
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
        if (!window.ghostCtx || !window.ghostTex || !team) return;
        if (!OpsRadial.open) return;
        const thr = Number(team.throttle) || 4;
        const band = thrBandLabel(thr);
        const dist = (typeof team.flightLength === 'number') ? team.flightLength.toFixed(1) : '—';
        const ctx = window.ghostCtx;
        ctx.clearRect(0, 0, 128, 64);
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2; ctx.shadowBlur = 4;
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 22px Courier New';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`THR ${thr.toFixed(1)} ${band}`, 64, 24);
        ctx.font = 'bold 16px Courier New';
        ctx.fillStyle = '#ffeb3b';
        ctx.fillText(`${dist}m`, 64, 48);
        window.ghostTex.needsUpdate = true;
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
            startTrack();
        } else {
            stopTrack();
            const o = OpsRadial._3d;
            if (o && o.gizmo) o.gizmo.visible = false;
            const hud = $('ghost-steer-hud');
            if (hud) {
                hud.hidden = true;
                hud.classList.remove('is-visible', 'is-nose-dragging', 'is-roll-dragging');
            }
            endGhostSteer();
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
        // Idle = translucent black; selected/armed/powering = fully opaque.
        if (state === 'armed') return 'rgb(0, 120, 72)';
        if (state === 'powering') return 'rgb(180, 110, 0)';
        if (state === 'empty') return 'rgb(140, 0, 30)';
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

    function rebuildWedges(team) {
        const g = $('ops-radial-wedges');
        if (!g) return;
        while (g.firstChild) g.removeChild(g.firstChild);
        const mk = (a0, a1, fill, id, selected) => {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', wedgePath(a0, a1, WEDGE_R0, WEDGE_R1));
            path.setAttribute('fill', fill);
            path.setAttribute('stroke', selected ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.28)');
            path.setAttribute('stroke-width', selected ? '1.5' : '1');
            path.style.pointerEvents = 'fill';
            path.dataset.ops = id;
            if (selected) path.classList.add('is-selected');
            g.appendChild(path);
        };
        // Top 90° (−45…+45): flare then chaff. SVG 0° = up via polar helper.
        const flareArmed = !!(team && team.flaresArmed);
        const chaffArmed = !!(team && team.chaffArmed);
        mk(-45, 0, wedgeColor(flareArmed ? 'active' : 'idle'), 'flare', flareArmed);
        mk(0, 45, wedgeColor(chaffArmed ? 'active' : 'idle'), 'chaff', chaffArmed);
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
            const selected = st === 'armed' || st === 'powering';
            mk(a0, a1, wedgeColor(st), `pylon-${idx + 1}`, selected);
        });
    }

    function refresh(teamObj) {
        const id = OpsRadial.teamId || (typeof uiCurrentTeamId === 'function' ? uiCurrentTeamId() : null);
        const team = teamObj || (teams && teams[id]);
        if (!OpsRadial.open || !team) return;

        rebuildWedges(team);

        const fl = $('ops-label-flare');
        const ch = $('ops-label-chaff');
        if (fl) fl.textContent = `FLARE ${Number(team.flareAmmo) || 0}`;
        if (ch) ch.textContent = `CHAFF ${Number(team.chaffAmmo) || 0}`;

        const pylons = Array.isArray(team.pylons) ? team.pylons : [];
        [1, 2, 3, 4].forEach((n) => {
            const el = $(`ops-label-p${n}`);
            const hit = $(`ops-hit-p${n}`);
            const p = pylons[n - 1];
            if (el) el.textContent = pylonShortLabel(p);
            if (hit) {
                hit.hidden = !p;
                hit.classList.toggle('is-empty', !!(p && p.state === 'empty'));
                hit.classList.toggle('is-armed', !!(p && p.state === 'armed'));
                hit.classList.toggle('is-powering', !!(p && p.state === 'powering'));
            }
        });

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
        if (heat) heat.textContent = `${Math.round(Number(team.heat) || 150)}°`;
        if (ap) {
            const baseAp = (typeof team.ap === 'number') ? team.ap : 0;
            const cost = (typeof team.previewCostAp === 'number') ? team.previewCostAp : 0;
            ap.textContent = `${Math.round(Math.max(0, baseAp - cost))}`;
        }
        if (sms) {
            const src = $('sms-text-content');
            sms.textContent = (src && src.innerText) ? src.innerText : '狀態 [就緒]';
            sms.style.color = (src && src.style.color) ? src.style.color : '#ffeb3b';
        }

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
        const half = 180; // ~half of 360px ring
        if (!scr) {
            anchor.style.left = '50%';
            anchor.style.top = '55%';
            anchor.style.bottom = 'auto';
            anchor.style.transform = 'translate(-50%, -50%)';
            return;
        }
        const x = Math.max(half + 8, Math.min(window.innerWidth - half - 8, scr.x));
        const y = Math.max(half + 8, Math.min(window.innerHeight - half - 24, scr.y));
        anchor.style.left = `${x}px`;
        anchor.style.top = `${y}px`;
        anchor.style.bottom = 'auto';
        anchor.style.transform = 'translate(-50%, -50%)';
    }

    function startTrack() {
        stopTrack();
        const tick = () => {
            if (!OpsRadial.open) return;
            const id = OpsRadial.teamId;
            const team = teams && teams[id];
            if (team) {
                sync3dOverlays(team);
                layoutAnchor(team);
            }
            OpsRadial._raf = requestAnimationFrame(tick);
        };
        OpsRadial._raf = requestAnimationFrame(tick);
    }

    function stopTrack() {
        if (OpsRadial._raf) cancelAnimationFrame(OpsRadial._raf);
        OpsRadial._raf = 0;
    }

    function clickPylon(pylonId) {
        const stick = document.querySelector(`.pylon-switch-wrapper[data-pylon="${pylonId}"] .pylon-stick`)
            || $(`pylon-stick-${pylonId}`);
        if (stick) stick.click();
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

        const flare = $('ops-hit-flare');
        if (flare) flare.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const b = $('btn-flare'); if (b) b.click();
            refresh();
        });
        const chaff = $('ops-hit-chaff');
        if (chaff) chaff.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const b = $('btn-chaff'); if (b) b.click();
            refresh();
        });
        [1, 2, 3, 4].forEach((n) => {
            const hit = $(`ops-hit-p${n}`);
            if (hit) hit.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                clickPylon(n);
                refresh();
            });
        });

        // Drag stick tip on 3D gizmo via pointer on canvas is handled in game pick layer later;
        // HTML fallback: scroll wheel on radial adjusts throttle slightly.
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
            setClassicCollapsed
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
