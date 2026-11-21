// ============================================================================
// ops-radial-ui.js — semi-transparent radial ops HUD + classic panel collapse
// ============================================================================
(function () {
    const COLLAPSE_KEY = 'airarena.opsPanelCollapsed';
    const RADIAL_SIZE = 220;

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

    function projectWorld(pos, camera) {
        if (!pos || !camera) return null;
        const v = pos.clone();
        v.project(camera);
        if (v.z > 1) return null;
        return {
            x: (v.x * 0.5 + 0.5) * window.innerWidth,
            y: (-v.y * 0.5 + 0.5) * window.innerHeight
        };
    }

    function ensure3dOverlays() {
        if (typeof THREE === 'undefined' || typeof scene === 'undefined') return null;
        if (OpsRadial._3d) return OpsRadial._3d;

        const whiteMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.85,
            depthWrite: false, side: THREE.DoubleSide
        });
        const ringMat = whiteMat.clone();
        ringMat.opacity = 0.55;

        const gizmo = new THREE.Group();
        gizmo.name = 'opsGhostGizmo';
        gizmo.visible = false;

        const outer = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.62, 48), ringMat);
        outer.rotation.x = Math.PI / 2;
        const inner = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.34, 32), ringMat.clone());
        inner.rotation.x = Math.PI / 2;
        gizmo.add(outer, inner);

        const pts = [];
        const dirs = [
            new THREE.Vector3(0.48, 0, 0),
            new THREE.Vector3(-0.48, 0, 0),
            new THREE.Vector3(0, 0, 0.48),
            new THREE.Vector3(0, 0, -0.48)
        ];
        dirs.forEach((d, i) => {
            const s = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 12), whiteMat.clone());
            s.position.copy(d);
            s.userData.opsPoint = i;
            gizmo.add(s);
            pts.push(s);
        });
        // Stick tip (joy)
        const stick = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), whiteMat.clone());
        stick.name = 'opsStickTip';
        gizmo.add(stick);

        if (window.ghostWrapper) window.ghostWrapper.add(gizmo);
        else scene.add(gizmo);

        const hpRing = new THREE.Mesh(
            new THREE.RingGeometry(0.85, 0.95, 64),
            new THREE.MeshBasicMaterial({
                color: 0x00ff88, transparent: true, opacity: 0.7,
                depthWrite: false, side: THREE.DoubleSide
            })
        );
        hpRing.name = 'opsHpRing';
        hpRing.rotation.x = Math.PI / 2;
        hpRing.visible = false;
        scene.add(hpRing);

        OpsRadial._3d = { gizmo, pts, stick, hpRing, outer, inner };
        return OpsRadial._3d;
    }

    function sync3dOverlays(team) {
        const o = ensure3dOverlays();
        if (!o || !team) return;
        const show = !!OpsRadial.open && !GameContext.isReplayMode() && !GameContext.isAnimating();

        // Ghost gizmo
        if (o.gizmo) {
            const ghostOn = show && window.ghostWrapper && window.ghostWrapper.visible;
            o.gizmo.visible = !!ghostOn;
            if (ghostOn && o.stick) {
                const jx = Number(team.joyX) || 0;
                const jy = Number(team.joyY) || 0;
                o.stick.position.set(jx * 0.42, 0.02, -jy * 0.42);
            }
            if (ghostOn && o.outer) {
                const roll = (team.pendingRoll != null && team.pendingRoll !== 0)
                    ? team.pendingRoll
                    : (Number(team.roll) || 0);
                o.outer.rotation.z = -roll;
            }
        }

        // HP ring on aircraft body
        if (o.hpRing && team.wrapper) {
            const onAc = show && team.wrapper.visible && !team.isDestroyed;
            o.hpRing.visible = !!onAc;
            if (onAc) {
                const hp = Math.max(0, Math.min(100, Number(team.hp) || 0));
                const col = hp > 60 ? 0x00ff88 : (hp > 30 ? 0xffaa00 : 0xff3355);
                o.hpRing.material.color.setHex(col);
                o.hpRing.material.opacity = 0.45 + 0.4 * (hp / 100);
                team.wrapper.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(team.wrapper);
                const c = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const r = Math.max(0.6, Math.max(size.x, size.z) * 0.55);
                o.hpRing.geometry.dispose();
                o.hpRing.geometry = new THREE.RingGeometry(r * 0.92, r, 64);
                o.hpRing.position.copy(c);
                o.hpRing.position.y = box.min.y + 0.05;
                o.hpRing.quaternion.copy(team.wrapper.quaternion);
                // Keep ring roughly body-horizontal: use world up tilt from aircraft
                o.hpRing.rotation.x = Math.PI / 2;
                o.hpRing.rotation.z = 0;
            }
        }
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
            if (o) {
                if (o.gizmo) o.gizmo.visible = false;
                if (o.hpRing) o.hpRing.visible = false;
            }
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
        if (state === 'armed') return 'rgba(0,255,136,0.35)';
        if (state === 'powering') return 'rgba(255,170,0,0.35)';
        if (state === 'empty') return 'rgba(255,0,51,0.28)';
        if (state === 'active') return 'rgba(255,255,255,0.28)';
        return 'rgba(255,255,255,0.12)';
    }

    function polar(cx, cy, r, deg) {
        const a = (deg - 90) * Math.PI / 180;
        return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    }

    function wedgePath(a0, a1, r0, r1) {
        const c = 100;
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
        const mk = (a0, a1, fill, id) => {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', wedgePath(a0, a1, 40, 90));
            path.setAttribute('fill', fill);
            path.setAttribute('stroke', 'rgba(255,255,255,0.45)');
            path.setAttribute('stroke-width', '1');
            path.dataset.ops = id;
            g.appendChild(path);
        };
        // Top 90° (−45…+45): flare then chaff. SVG 0° = up via polar helper.
        const flareArmed = !!(team && team.flaresArmed);
        const chaffArmed = !!(team && team.chaffArmed);
        mk(-45, 0, wedgeColor(flareArmed ? 'active' : 'idle'), 'flare');
        mk(0, 45, wedgeColor(chaffArmed ? 'active' : 'idle'), 'chaff');
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
            mk(a0, a1, wedgeColor(p && p.state), `pylon-${idx + 1}`);
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

        const ok = $('ops-radial-ok');
        if (ok) {
            const live = (typeof uiIsSeatLive === 'function') ? uiIsSeatLive(team.id) : true;
            ok.disabled = !live || !!team.isDestroyed || GameContext.isAnimating() || GameContext.isReplayMode();
            ok.classList.toggle('is-ready', !!team.ready && !team.aiEnabled);
            ok.classList.toggle('is-ai', !!team.aiEnabled);
            if (!live || team.isDestroyed) ok.textContent = '—';
            else if (team.aiEnabled) ok.textContent = 'AI';
            else if (team.ready) ok.textContent = '待命';
            else ok.textContent = 'OK';
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

    function layoutAnchor(team) {
        const anchor = $('ops-radial-anchor');
        if (!anchor || typeof camera === 'undefined') return;
        let world = null;
        if (OpsRadial.focus === 'ghost' && window.ghostWrapper && window.ghostWrapper.visible) {
            world = window.ghostWrapper.position;
        } else if (team && team.wrapper) {
            world = team.wrapper.position;
        }
        const scr = projectWorld(world, camera);
        if (!scr) {
            anchor.style.left = '50%';
            anchor.style.top = '58%';
            return;
        }
        const half = RADIAL_SIZE * 0.5;
        const x = Math.max(half + 8, Math.min(window.innerWidth - half - 8, scr.x));
        // Bias below selection so it doesn't cover the aircraft silhouette.
        const y = Math.max(half + 8, Math.min(window.innerHeight - 160, scr.y + 70));
        anchor.style.left = `${x}px`;
        anchor.style.top = `${y}px`;
    }

    function startTrack() {
        stopTrack();
        const tick = () => {
            if (!OpsRadial.open) return;
            const id = OpsRadial.teamId;
            const team = teams && teams[id];
            if (team) {
                layoutAnchor(team);
                sync3dOverlays(team);
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
        ensure3dOverlays();
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
