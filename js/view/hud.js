// ============================================================================
// hud.js - 戰機火控雷達、雙框追蹤與 WE-GO 精確 LCOS 彈道預測系統 (無光灰/高亮紅 動態切換版)
// ============================================================================

// 🌟 1. 動態注入 LCOS：皇牌空戰風 — 內部倒 T + 外部圓環（轉彎時圓環滯後示意彈道）
(function initLcosPipper() {
    let pipper = document.getElementById('lcos-pipper');
    if (!pipper) {
        pipper = document.createElement('div');
        pipper.id = 'lcos-pipper';
        document.body.appendChild(pipper);
    }
    pipper.style.position = 'absolute';
    pipper.style.width = '56px';
    pipper.style.height = '56px';
    pipper.style.pointerEvents = 'none';
    pipper.style.zIndex = '8000';
    pipper.style.display = 'none';
    pipper.style.transform = 'translate(-50%, -50%)';
    pipper.style.transition = 'opacity 0.2s ease-in-out';
    pipper.style.touchAction = 'none';
    pipper.style.webkitUserSelect = 'none';
    pipper.style.userSelect = 'none';
    // 外圓平時顯示；倒 T / 中心點僅機砲排程後顯示
    // #lcos-grab-ring：拖曳調機頭；雙擊＝開火／飛彈排程（同 SMS ENT）
    // #lcos-grab-hit：更大透明命中區，減少邊緣滑出後觸發系統 pinch
    // #lcos-gun-heat-*：機砲過熱環（外環外側粗黑圈，溫度順時針填紅）
    pipper.innerHTML = `
        <svg viewBox="0 0 100 100" style="width: 100%; height: 100%; overflow: visible; filter: none; pointer-events: none; touch-action: none;">
            <circle id="lcos-gun-heat-track" cx="50" cy="50" r="46" stroke="#ffffff" stroke-width="5.5" fill="none" opacity="0.92" style="display: none;"/>
            <circle id="lcos-gun-heat-fill" cx="50" cy="50" r="46" stroke="#ff1a1a" stroke-width="5.5" fill="none"
                stroke-linecap="butt" transform="rotate(-90 50 50)" opacity="0.95" style="display: none;"/>
            <circle id="lcos-cone-circle" cx="50" cy="50" r="37.4" stroke="#ffffff" stroke-width="2.6" fill="none" opacity="0.9"/>
            <circle id="lcos-grab-hit" cx="50" cy="50" r="48" stroke="none" fill="rgba(255,255,255,0.001)"
                style="pointer-events: fill; touch-action: none; cursor: grab;"/>
            <circle id="lcos-grab-ring" cx="50" cy="50" r="37.4" stroke="none" fill="rgba(255,255,255,0.01)"
                style="pointer-events: fill; touch-action: none; cursor: grab;" title="拖曳調機頭｜雙擊開火／發射"/>
            <g id="lcos-aim-group" style="display: none; pointer-events: none;">
                <g id="lcos-inner-t" stroke="#e6c200" stroke-width="1.8" stroke-linecap="square" fill="none">
                    <line id="lcos-t-bar" x1="38" y1="52" x2="62" y2="52"/>
                    <line id="lcos-t-stem" x1="50" y1="52" x2="50" y2="34"/>
                </g>
                <circle id="lcos-center-dot" cx="50" cy="52" r="1.4" fill="#e6c200"/>
            </g>
            <g id="lcos-surface-reticle" style="display: none; pointer-events: none;" stroke="#ff9966" stroke-width="1.6" fill="none">
                <line x1="38" y1="50" x2="45" y2="50"/>
                <line x1="55" y1="50" x2="62" y2="50"/>
                <line x1="50" y1="38" x2="50" y2="45"/>
                <line x1="50" y1="55" x2="50" y2="62"/>
                <circle id="lcos-surface-dot" cx="50" cy="50" r="2.0" fill="#ff9966" stroke="none"/>
            </g>
        </svg>
        <div id="lcos-wpn-tag" class="lcos-wpn-tag" aria-hidden="true">
            <div class="lcos-wpn-name" id="lcos-wpn-name">—</div>
            <div class="lcos-wpn-status" id="lcos-wpn-status">—</div>
        </div>
    `;
    pipper.title = '拖曳調機頭｜雙擊開火／發射';
    const wpnNameEl = pipper.querySelector('#lcos-wpn-name');
    if (wpnNameEl) {
        wpnNameEl.addEventListener('click', (e) => {
            const activeId = (typeof GameContext !== 'undefined' && GameContext.getActiveTeamId)
                ? GameContext.getActiveTeamId()
                : null;
            const t = activeId && typeof teams !== 'undefined' ? teams[activeId] : null;
            if (!t || t.weapon !== 'rocket') return;
            e.preventDefault();
            e.stopPropagation();
            if (typeof window.uiToggleRocketFuze === 'function') {
                window.uiToggleRocketFuze(activeId);
            }
        });
    }
})();

/** Weapon type + status to the left of the LCOS aiming ring. */
function updateLcosWeaponTag(team, opts = {}) {
    let root = document.getElementById('lcos-wpn-tag');
    const pipper = document.getElementById('lcos-pipper');
    if (!root && pipper) {
        root = document.createElement('div');
        root.id = 'lcos-wpn-tag';
        root.className = 'lcos-wpn-tag';
        root.innerHTML = '<div class="lcos-wpn-name" id="lcos-wpn-name">—</div><div class="lcos-wpn-status" id="lcos-wpn-status">—</div>';
        pipper.appendChild(root);
    }
    if (!root) return;
    const nameEl = document.getElementById('lcos-wpn-name');
    const stEl = document.getElementById('lcos-wpn-status');
    if (!team || opts.hide) {
        root.style.display = 'none';
        root.setAttribute('aria-hidden', 'true');
        return;
    }
    const wpn = team.weapon || 'gun';
    const live = (typeof teamLiveMissileType === 'function') ? teamLiveMissileType(team) : null;
    let name = 'GUN';
    let status = '就緒';
    let tone = 'ready';

    if (wpn === 'missile') {
        name = live === 'fox1' ? 'FOX-1' : 'FOX-2';
        const isFox = (p) => {
            if (!p) return false;
            const wt = typeof pylonWeaponType === 'function' ? pylonWeaponType(p) : p.weaponType;
            return wt !== 'bomb' && wt !== 'rocket';
        };
        const armed = team.pylons
            ? team.pylons.filter((p) => p && p.state === 'armed' && isFox(p)).length
            : 0;
        const powering = team.pylons
            ? team.pylons.filter((p) => p && p.state === 'powering' && isFox(p)).length
            : 0;
        const dist = Number(opts.distance);
        const gate = (typeof describeMissileLaunchRange === 'function')
            ? describeMissileLaunchRange({ missileType: live || 'fox2', distance: dist })
            : { ok: false, reason: 'noTarget' };
        const guiding = !!(live === 'fox1' && typeof uiTeamHasFox1Flight === 'function' && uiTeamHasFox1Flight(team));
        const queued = !!(team.wpnQueued && team.queuedAction === 'missile');
        const inConeRange = !!opts.inRange;

        if (guiding) {
            status = '導引中';
            tone = 'guide';
        } else if (!armed && powering > 0) {
            status = '開機中';
            tone = 'warn';
        } else if (!armed) {
            status = '未通電';
            tone = 'bad';
        } else if (opts.obscured) {
            status = queued ? '已排程·遮擋' : '遮擋';
            tone = 'warn';
        } else if (queued && inConeRange) {
            status = '已排程·鎖定';
            tone = 'hot';
        } else if (queued && gate.ok) {
            status = '已排程·射程內';
            tone = 'queued';
        } else if (queued) {
            status = '已排程';
            tone = 'queued';
        } else if (inConeRange) {
            status = '進入射程';
            tone = 'hot';
        } else if (gate.reason === 'tooClose') {
            status = '過近';
            tone = 'warn';
        } else if (gate.reason === 'tooFar') {
            status = '未進入射程';
            tone = 'idle';
        } else {
            status = '就緒';
            tone = 'ready';
        }
    } else if (wpn === 'bomb') {
        name = 'BOMB';
        const bombs = (typeof AirArenaBomb !== 'undefined') ? AirArenaBomb.teamBombPylons(team) : [];
        const armed = bombs.filter((p) => p.state === 'armed').length;
        const anyLeft = bombs.some((p) => p.state !== 'empty');
        if (team.wpnQueued && team.queuedAction === 'bomb') {
            status = '已排程';
            tone = 'queued';
        } else if (armed > 0) {
            status = 'CCIP 就緒';
            tone = 'ready';
        } else if (!anyLeft) {
            status = '彈盡';
            tone = 'bad';
        } else {
            status = '未通電';
            tone = 'bad';
        }
    } else if (wpn === 'rocket') {
        const fuze = (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.getTeamFuzeMode === 'function')
            ? AirArenaRocket.getTeamFuzeMode(team)
            : (team.rocketFuze === 'impact' ? 'impact' : 'vt');
        name = fuze === 'impact' ? 'RKT·IMP ⇄' : 'RKT·VT ⇄';
        const pods = (typeof AirArenaRocket !== 'undefined') ? AirArenaRocket.teamRocketPylons(team) : [];
        const armedPod = pods.find((p) => p.state === 'armed') || null;
        const ammo = armedPod && typeof AirArenaRocket !== 'undefined'
            ? AirArenaRocket.ensurePodAmmo(armedPod) : 0;
        const anyAmmo = pods.some((p) => (typeof AirArenaRocket !== 'undefined' ? AirArenaRocket.ensurePodAmmo(p) : (p.ammo || 0)) > 0);
        const queued = !!(team.wpnQueued && team.queuedAction === 'rocket');
        if (!anyAmmo) {
            status = '彈盡';
            tone = 'bad';
        } else if (!armedPod || ammo <= 0) {
            status = '未通電';
            tone = 'bad';
        } else if (fuze === 'impact') {
            const dStr = Number.isFinite(Number(opts.slantDist)) ? ` ${Math.round(opts.slantDist)}m` : '';
            if (opts.grounded === false) {
                status = '仰角過高';
                tone = 'warn';
            } else if (queued) {
                status = `對地排程${dStr}`;
                tone = 'queued';
            } else if (opts.hitBuilding) {
                status = `建築落點${dStr}`;
                tone = 'ready';
            } else {
                status = `地面落點${dStr}`;
                tone = 'ready';
            }
        } else {
            // VT airburst mode
            const dist = Number(opts.distance);
            const rMax = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.rocket && Number(CONFIG.weapons.rocket.range)) || 120;
            if (opts.obscured) {
                status = queued ? '齊射·遮擋' : '遮擋';
                tone = 'warn';
            } else if (queued && opts.inRange) {
                status = '齊射·鎖定';
                tone = 'hot';
            } else if (queued) {
                status = '齊射排程';
                tone = 'queued';
            } else if (opts.inRange) {
                status = 'VT 命中窗';
                tone = 'hot';
            } else if (Number.isFinite(dist) && dist > rMax * 1.15) {
                status = '未進射程';
                tone = 'idle';
            } else {
                status = `就緒 ${ammo}發`;
                tone = 'ready';
            }
        }
    } else {
        name = 'GUN';
        const hot = !!(GameContext.stateMachine
            && typeof GameContext.stateMachine.isGunOverheated === 'function'
            && GameContext.stateMachine.isGunOverheated(team.id));
        if (hot) {
            status = '過熱';
            tone = 'bad';
        } else if (team.wpnQueued && team.queuedAction === 'gun') {
            status = opts.inRange ? '已排程·鎖定' : '已排程';
            tone = opts.inRange ? 'hot' : 'queued';
        } else if (opts.inRange) {
            status = '進入射程';
            tone = 'hot';
        } else if (opts.obscured) {
            status = '遮擋';
            tone = 'warn';
        } else {
            status = '就緒';
            tone = 'ready';
        }
    }

    if (nameEl) {
        nameEl.textContent = name;
        const canClick = wpn === 'rocket' && !team.aiEnabled && !team.ready
            && !(typeof GameContext !== 'undefined' && (GameContext.isAnimating() || GameContext.isReplayMode()));
        nameEl.classList.toggle('is-clickable', canClick);
        if (canClick) nameEl.title = '點擊切換 VT 對空／IMPACT 對地引信';
        else nameEl.removeAttribute('title');
    }
    if (stEl) stEl.textContent = status;
    root.dataset.tone = tone;
    root.style.display = 'flex';
    root.setAttribute('aria-hidden', 'false');
}

/** iOS Safari：封鎖 pinch／雙擊頁面縮放（會造成 3D 與控制面板「分離」） */
(function installViewportZoomGuard() {
    const blockMultiTouch = (e) => {
        if (!e.touches || e.touches.length < 2) return;
        if (e.cancelable) e.preventDefault();
    };
    const blockGesture = (e) => {
        if (e.cancelable) e.preventDefault();
    };
    document.addEventListener('touchmove', blockMultiTouch, { passive: false, capture: true });
    document.addEventListener('touchstart', blockMultiTouch, { passive: false, capture: true });
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
        document.addEventListener(type, blockGesture, { passive: false, capture: true });
    });

    // 雙擊縮放：僅在 3D／瞄準區攔截過密 touchend（表單／Setup 不受影響）
    let lastTouchEndAt = 0;
    document.addEventListener('touchend', (e) => {
        const t = e.target;
        const inGameTouch = !!(t && t.closest && t.closest(
            '#canvas-container, #lcos-pipper, #lcos-drag-shield, #ui-wrapper, #dynamic-hud'
        ));
        if (!inGameTouch) {
            lastTouchEndAt = Date.now();
            return;
        }
        const now = Date.now();
        if (now - lastTouchEndAt < 320) {
            if (e.cancelable) e.preventDefault();
        }
        lastTouchEndAt = now;
    }, { passive: false, capture: true });

    const lockViewportMeta = () => {
        const meta = document.querySelector('meta[name="viewport"]');
        if (!meta) return;
        meta.setAttribute(
            'content',
            'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, shrink-to-fit=no'
        );
    };
    lockViewportMeta();

    const vv = window.visualViewport;
    if (vv) {
        let recovering = false;
        const recover = () => {
            if (recovering) return;
            if (Math.abs((vv.scale || 1) - 1) < 0.01 && window.scrollX === 0 && window.scrollY === 0) return;
            recovering = true;
            lockViewportMeta();
            window.scrollTo(0, 0);
            if (document.documentElement) document.documentElement.scrollTop = 0;
            if (document.body) document.body.scrollTop = 0;
            setTimeout(() => { recovering = false; }, 50);
        };
        vv.addEventListener('resize', recover);
        vv.addEventListener('scroll', recover);
    }
})();

// 飛彈 seeker：外環四角加粗斜槓 → 鎖定後移到敵機組成 X
(function initMissileSeekerBrackets() {
    if (document.getElementById('missile-seeker-brackets')) return;
    const el = document.createElement('div');
    el.id = 'missile-seeker-brackets';
    el.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'width:56px',
        'height:56px',
        'pointer-events:none',
        'z-index:8100',
        'display:none',
        'transform:translate(-50%,-50%)',
        'transition:none'
    ].join(';');
    el.innerHTML = `
        <svg viewBox="0 0 100 100" style="width:100%;height:100%;overflow:visible;pointer-events:none;">
            <g id="missile-seeker-marks" stroke="#ffffff" stroke-width="3.6" stroke-linecap="square" fill="none" opacity="0.95">
                <line id="msl-b-0" x1="0" y1="0" x2="0" y2="0"/>
                <line id="msl-b-1" x1="0" y1="0" x2="0" y2="0"/>
                <line id="msl-b-2" x1="0" y1="0" x2="0" y2="0"/>
                <line id="msl-b-3" x1="0" y1="0" x2="0" y2="0"/>
            </g>
        </svg>
    `;
    document.body.appendChild(el);
})();

/**
 * Missile mode seeker marks on LCOS ring:
 * - unlocked / in-window: 4 bold corner ticks pointing outward
 * - missile queued + lock (in shoot window): hollow X (same position)
 * @param {{visible:boolean, lockedX:boolean, pipperX:number, pipperY:number, pipperSize:number, ringR?:number, color?:string}} opts
 */
function updateMissileSeekerBrackets(opts) {
    const el = document.getElementById('missile-seeker-brackets');
    if (!el) return;
    if (!opts || !opts.visible) {
        el.style.display = 'none';
        if (window._mslBracketAnim) window._mslBracketAnim.xT = 0;
        return;
    }

    const wantX = !!opts.lockedX;
    const anim = window._mslBracketAnim || (window._mslBracketAnim = { xT: 0 });
    const targetT = wantX ? 1 : 0;
    const step = wantX ? 0.22 : 0.28;
    if (anim.xT < targetT) anim.xT = Math.min(targetT, anim.xT + step);
    else if (anim.xT > targetT) anim.xT = Math.max(targetT, anim.xT - step);
    const t = anim.xT;

    const pipX = Number(opts.pipperX) || 0;
    const pipY = Number(opts.pipperY) || 0;
    const pipSize = Math.max(40, Number(opts.pipperSize) || 56);
    const ringR = Number.isFinite(opts.ringR) ? opts.ringR : 37.4;
    const k = 0.70710678;

    // 外環四角短斜槓：朝外
    const tickLen = 11;
    const corners = [
        { ox: 50 - ringR * k, oy: 50 - ringR * k, dx: -1, dy: -1 }, // TL out
        { ox: 50 + ringR * k, oy: 50 - ringR * k, dx: 1, dy: -1 },  // TR out
        { ox: 50 - ringR * k, oy: 50 + ringR * k, dx: -1, dy: 1 },  // BL out
        { ox: 50 + ringR * k, oy: 50 + ringR * k, dx: 1, dy: 1 }    // BR out
    ];
    // 空心 X：兩條對角線，中心留空
    const xArm = 20;
    const xGap = 5.5;
    const xSegs = [
        { x1: 50 - xArm, y1: 50 - xArm, x2: 50 - xGap, y2: 50 - xGap },
        { x1: 50 + xArm, y1: 50 - xArm, x2: 50 + xGap, y2: 50 - xGap },
        { x1: 50 - xArm, y1: 50 + xArm, x2: 50 - xGap, y2: 50 + xGap },
        { x1: 50 + xArm, y1: 50 + xArm, x2: 50 + xGap, y2: 50 + xGap }
    ];

    const color = opts.color || '#ffffff';
    const marks = document.getElementById('missile-seeker-marks');
    if (marks) {
        marks.setAttribute('stroke', color);
        marks.setAttribute('stroke-width', t > 0.5 ? '4.0' : '3.6');
    }

    for (let i = 0; i < 4; i++) {
        const line = document.getElementById(`msl-b-${i}`);
        if (!line) continue;
        const c = corners[i];
        // tick: from ring corner outward
        const x0 = c.ox;
        const y0 = c.oy;
        const x1 = c.ox + c.dx * tickLen * k;
        const y1 = c.oy + c.dy * tickLen * k;
        const xs = xSegs[i];
        line.setAttribute('x1', String(x0 + (xs.x1 - x0) * t));
        line.setAttribute('y1', String(y0 + (xs.y1 - y0) * t));
        line.setAttribute('x2', String(x1 + (xs.x2 - x1) * t));
        line.setAttribute('y2', String(y1 + (xs.y2 - y1) * t));
    }

    el.style.display = 'block';
    el.style.left = `${pipX}px`;
    el.style.top = `${pipY}px`;
    el.style.width = `${pipSize}px`;
    el.style.height = `${pipSize}px`;
    el.style.filter = color === '#ff0055'
        ? 'drop-shadow(0 0 5px #ff0055)'
        : 'drop-shadow(0 0 2px rgba(255,255,255,0.55))';
    el.style.opacity = '0.95';
}

function ensureFox1RingCaption() {
    let cap = document.getElementById('fox1-hit-ring-cap');
    if (cap) return cap;
    cap = document.createElement('div');
    cap.id = 'fox1-hit-ring-cap';
    cap.style.cssText = 'position:fixed;pointer-events:none;z-index:8051;transform:translate(-50%,0);display:none;font:11px/1.15 "Share Tech Mono",monospace;letter-spacing:0.12em;text-shadow:0 0 5px #000;white-space:nowrap;';
    document.body.appendChild(cap);
    return cap;
}

function hideFox1RingCaption() {
    const cap = document.getElementById('fox1-hit-ring-cap');
    if (cap) cap.style.display = 'none';
}

function syncFox1RingCaption(x, y, text, color) {
    const cap = ensureFox1RingCaption();
    if (!text) {
        cap.style.display = 'none';
        return;
    }
    cap.textContent = text;
    cap.style.display = 'block';
    cap.style.left = `${x}px`;
    cap.style.top = `${y}px`;
    cap.style.color = color || '#9ec0dc';
}

/** FOX-1 SARH illuminate ring = unstable nose/look lock cone + missile status boxes.
 *  Separate from LCOS/方向盤 seeker brackets (those stay on for FOX-1 too). */
function updateFox1SupportHud(team, enemy, enemyPos, enemyProj, isObscured) {
    let ring = document.getElementById('fox1-hit-ring');
    if (!ring) {
        ring = document.createElement('div');
        ring.id = 'fox1-hit-ring';
        ring.style.cssText = 'position:fixed;pointer-events:none;z-index:8050;border:2px solid #ffaa00;border-radius:50%;transform:translate(-50%,-50%);display:none;box-sizing:border-box;';
        document.body.appendChild(ring);
    }
    let boxHost = document.getElementById('fox1-missile-boxes');
    if (!boxHost) {
        boxHost = document.createElement('div');
        boxHost.id = 'fox1-missile-boxes';
        boxHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8060;';
        document.body.appendChild(boxHost);
    }

    const live = (typeof teamLiveMissileType === 'function') ? teamLiveMissileType(team) : null;
    const hasFox1Flight = (typeof teamHasFox1InFlight === 'function')
        ? teamHasFox1InFlight(team)
        : !!(team && team.activeMissiles && team.activeMissiles.some(
            (m) => m && m.missileType === 'fox1' && !m.exploded && Number(m.ap) > 0
        ));
    const showFox1 = !!(team && team.weapon === 'missile' && (live === 'fox1' || hasFox1Flight));
    if (!showFox1 || !team || !team.wrapper) {
        ring.style.display = 'none';
        hideFox1RingCaption();
        boxHost.innerHTML = '';
        return;
    }

    const cfg = typeof getMissileWeaponConfig === 'function' ? getMissileWeaponConfig('fox1') : {};
    const shooterPos = team.wrapper.position;
    const shooterQuat = team.wrapper.quaternion;
    const nowStep = (typeof performance !== 'undefined' ? performance.now() * 0.06 : 0);
    const chaffList = (typeof globalChaff !== 'undefined' && Array.isArray(globalChaff))
        ? globalChaff.map((c) => ({ pos: c.pos, ageSteps: c.ageSteps || c.age || 0 }))
        : [];
    let losBlocked = false;
    if (enemyPos && typeof obstacles !== 'undefined' && obstacles.length) {
        const dir = enemyPos.clone().sub(shooterPos);
        const dist = dir.length();
        if (dist > 0.2) {
            const ray = new THREE.Raycaster(shooterPos, dir.normalize(), 0.1, dist);
            losBlocked = ray.intersectObjects(obstacles, true).length > 0;
        }
    }

    const baseAngle = Number(cfg.supportBaseAngle) || (Math.PI / 18);
    let support = {
        angle: baseAngle,
        inRange: false,
        supported: false,
        inGate: false,
        flicker: false,
        breathe: 1,
        lookDir: null
    };
    if (enemyPos && typeof computeSarhSupport === 'function') {
        support = computeSarhSupport({
            shooterPos,
            shooterQuat,
            targetPos: enemyPos,
            chaffList,
            step: nowStep,
            shooterId: team && team.id,
            targetId: enemy && enemy.id,
            losBlocked
        });
    }

    // Illuminate axis = stable nose (no look jitter on the ring)
    const noseFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(shooterQuat).normalize();
    const lookDir = noseFwd;
    const enemyDist = enemyPos ? shooterPos.distanceTo(enemyPos) : 0;
    const maxR = Number(cfg.seekerRange) || 200;
    const aimDist = enemyDist > 1
        ? Math.max(40, Math.min(maxR, enemyDist))
        : Math.max(60, maxR * 0.45);
    const lookWorld = shooterPos.clone().add(lookDir.clone().multiplyScalar(aimDist));
    const lookProj = lookWorld.clone().project(camera);
    if (lookProj.z > 1) {
        ring.style.display = 'none';
        hideFox1RingCaption();
    } else {
        const sx = (lookProj.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (lookProj.y * -0.5 + 0.5) * window.innerHeight;
        // Screen radius from angular illuminate gate (grows/shrinks with support.angle)
        const focal = Math.max(window.innerHeight, 480) * 0.72;
        let pxR = Math.tan(Math.max(0.004, support.angle || baseAngle)) * focal;
        pxR = Math.max(8, Math.min(90, pxR));
        if (window._fox1RingR == null) window._fox1RingR = pxR;
        window._fox1RingR += (pxR - window._fox1RingR) * 0.28;

        const physicsHot = !!(support.supported || (support.inRange && support.inGate));
        const ringMode = (typeof describeFox1RingMode === 'function')
            ? describeFox1RingMode({ distance: enemyDist, inFlight: hasFox1Flight })
            : {
                mode: hasFox1Flight ? 'support' : ((enemyDist >= 70) ? 'fire' : 'hold'),
                lookFire: !hasFox1Flight && enemyDist >= 70,
                lookSupport: !!(hasFox1Flight || enemyDist < 70)
            };
        // M23: pre-launch <70 never looks fireable. In-flight 8–200 stays bright for support.
        const holdLook = ringMode.mode === 'hold';
        const lookHot = holdLook ? false : physicsHot;
        const col = holdLook ? '#7aa2c8' : (lookHot ? '#ff0055' : '#ffaa00');
        ring.style.display = 'block';
        ring.style.left = `${sx}px`;
        ring.style.top = `${sy}px`;
        ring.style.width = `${window._fox1RingR * 2}px`;
        ring.style.height = `${window._fox1RingR * 2}px`;
        ring.style.borderStyle = holdLook ? 'dashed' : 'solid';
        ring.style.borderWidth = holdLook ? '1.5px' : '2px';
        ring.style.borderColor = col;
        const breathe = support.breathe != null ? support.breathe : 1;
        const flickerDim = support.flicker && (Date.now() % 160 < 80) ? 0.35 : 1;
        ring.style.opacity = String(breathe * flickerDim * (holdLook ? 0.42 : 0.88));
        ring.style.boxShadow = holdLook
            ? '0 0 4px rgba(122,162,200,0.28)'
            : (lookHot
                ? '0 0 10px rgba(255,0,85,0.55)'
                : '0 0 6px rgba(255,170,0,0.35)');
        hideFox1RingCaption();
        if (typeof uiApplyFox1TacticalSms === 'function') {
            uiApplyFox1TacticalSms(team, { distance: enemyDist, inFlight: hasFox1Flight });
        }
    }

    // Missile boxes (still track missile / enemy)
    boxHost.innerHTML = '';
    if (!enemyPos || isObscured) return;
    (team.activeMissiles || []).forEach((m) => {
        if (!m || m.missileType !== 'fox1' || m.exploded || m.ap <= 0 || !m.active || !m.pos) return;
        const mp = m.pos.clone();
        mp.project(camera);
        if (mp.z > 1) return;
        const mx = (mp.x * 0.5 + 0.5) * window.innerWidth;
        const my = (mp.y * -0.5 + 0.5) * window.innerHeight;
        const md = enemyPos ? m.pos.distanceTo(enemyPos) : 0;
        const locked = !!m.supportLocked;
        const el = document.createElement('div');
        el.style.cssText = `position:fixed;left:${mx}px;top:${my}px;transform:translate(-50%,-50%);border:1px solid ${locked ? '#ff0055' : '#aaa'};color:${locked ? '#ff0055' : '#ccc'};font:10px/1.2 monospace;padding:2px 4px;background:rgba(0,0,0,0.65);white-space:nowrap;`;
        el.textContent = `${Math.floor(md)}m ${locked ? 'LOCK' : 'COAST'}`;
        boxHost.appendChild(el);
    });
}

/** Gun overheat ring outside LCOS outer cone: black track + clockwise red fill. */
function syncLcosGrabGeometry(cx, cy, r) {
    const grabRing = document.getElementById('lcos-grab-ring');
    const grabHit = document.getElementById('lcos-grab-hit');
    const rad = Number(r) || 37.4;
    if (grabRing) {
        grabRing.setAttribute('cx', String(cx));
        grabRing.setAttribute('cy', String(cy));
        grabRing.setAttribute('r', String(rad));
    }
    if (grabHit) {
        grabHit.setAttribute('cx', String(cx));
        grabHit.setAttribute('cy', String(cy));
        // Larger invisible pad so edge drags stay on the pipper, not the canvas.
        grabHit.setAttribute('r', String(Math.max(rad + 12, 48)));
    }
}

function updateLcosGunHeatRing(team, coneCx = 50, coneCy = 50, coneR = 37.4, visible = true) {
    const track = document.getElementById('lcos-gun-heat-track');
    const fill = document.getElementById('lcos-gun-heat-fill');
    if (!track || !fill) return;
    if (!visible || !team || team.weapon !== 'gun') {
        track.style.display = 'none';
        fill.style.display = 'none';
        return;
    }
    const heat = Math.max(0, Math.min(1, Number(team.gunHeat) || 0));
    const cx = Number(coneCx);
    const cy = Number(coneCy);
    const baseR = Number(coneR);
    const r = (Number.isFinite(baseR) ? baseR : 37.4) + 8.6;
    const circ = 2 * Math.PI * r;
    track.setAttribute('cx', String(cx));
    track.setAttribute('cy', String(cy));
    track.setAttribute('r', String(r));
    track.style.display = 'block';
    fill.setAttribute('cx', String(cx));
    fill.setAttribute('cy', String(cy));
    fill.setAttribute('r', String(r));
    fill.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
    fill.setAttribute('stroke-dasharray', String(circ.toFixed(2)));
    fill.setAttribute('stroke-dashoffset', String((circ * (1 - heat)).toFixed(2)));
    fill.style.display = heat > 0.001 ? 'block' : 'none';
}

// 準星外環拖曳 → 調整機頭方向（與座艙搖桿同一套 joyX / joyY）
// 輕點雙擊（幾乎無拖移）→ 切換機砲／飛彈開火排程
(function initLcosRingDrag() {
    window.isDraggingLcosRing = false;
    let activePointerId = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let startJoyX = 0;
    let startJoyY = 0;
    let dragMoved = false;
    let lastTapAt = 0;
    const TAP_MOVE_PX = 8;
    const DBLTAP_MS = 380;

    // 短距近乎與手指同步；超過 soft 區才增幅拉滿
    const LCOS_DRAG = {
        softJoy: 0.40,   // soft 區末端對應的搖桿量（不提早拉滿）
        softFrac: 0.09,  // soft 區約為短邊 9%
        softMin: 64,
        softMax: 96,
        fullFrac: 0.26,  // 拉滿約為短邊 26%
        fullMin: 170,
        fullMax: 260
    };

    function canPilotActive() {
        if (typeof GameContext === 'undefined' || typeof teams === 'undefined') return null;
        const teamId = GameContext.getActiveTeamId ? GameContext.getActiveTeamId() : null;
        const t = teamId ? teams[teamId] : null;
        if (!t || t.aiEnabled || t.isDestroyed || GameContext.isAnimating() || t.ready) return null;
        if (GameContext.isReplayMode && GameContext.isReplayMode()) return null;
        return t;
    }

    function getDragRadii() {
        const shortSide = Math.min(window.innerWidth || 800, window.innerHeight || 600);
        const softPx = Math.max(LCOS_DRAG.softMin, Math.min(LCOS_DRAG.softMax, shortSide * LCOS_DRAG.softFrac));
        const fullPx = Math.max(LCOS_DRAG.fullMin, Math.min(LCOS_DRAG.fullMax, shortSide * LCOS_DRAG.fullFrac));
        return { softPx, fullPx: Math.max(fullPx, softPx + 40) };
    }

    /** 距離 → 搖桿幅度：短距線性近似同步，長距才二次增幅 */
    function mapDistToJoyMag(dist, softPx, fullPx) {
        if (!(dist > 0)) return 0;
        const softJoy = LCOS_DRAG.softJoy;
        if (dist <= softPx) {
            return (dist / softPx) * softJoy;
        }
        const span = Math.max(1, fullPx - softPx);
        const t = Math.min(1, (dist - softPx) / span);
        // t²：越拉越遠增幅越明顯，短距過渡不突兀
        return softJoy + (1 - softJoy) * (t * t);
    }

    function syncJoystickHandle(joyX, joyY) {
        const joyZone = document.getElementById('joystick-zone');
        const joyHandle = document.getElementById('joystick-handle');
        if (!joyZone || !joyHandle) return;
        const maxRadius = Math.max(8, joyZone.getBoundingClientRect().width / 2 - 15);
        joyHandle.style.transform = `translate(${joyX * maxRadius}px, ${-joyY * maxRadius}px)`;
    }

    /**
     * Map screen drag to body-frame stick so inverted / banked flight stays
     * "drag toward where you want the nose on screen" (not reversed).
     * dx: screen-right, dy: screen-down (DOM).
     */
    function mapScreenDragToJoy(dx, dy, mag, team) {
        const dist = Math.hypot(dx, dy);
        if (!(dist > 0.001) || !(mag > 0)) return { joyX: 0, joyY: 0 };

        const cam = (typeof camera !== 'undefined') ? camera : null;
        const quat = team && team.wrapper
            ? (team.wrapper.userData.logicalQuat || team.wrapper.quaternion)
            : null;
        if (!cam || !quat || typeof THREE === 'undefined') {
            // Match cockpit stick: screen-right = +joyX was reversed for nose-on-screen
            // after camera/body remap; keep Y, flip X.
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

        // Project body axes onto the camera plane so screen sense matches.
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
        // Negate X so drag-right moves nose right on screen (Y already correct).
        return { joyX: (-jx / len) * mag, joyY: (jy / len) * mag };
    }

    function clampJoyVector(joyX, joyY) {
        const len = Math.hypot(joyX, joyY);
        if (len <= 1 || len < 1e-8) return { joyX, joyY };
        return { joyX: joyX / len, joyY: joyY / len };
    }

    /** Relative drag: preserve stick on pointer-down; only change after move. */
    function applyNoseFromPointer(clientX, clientY) {
        const t = canPilotActive();
        if (!t) return;
        if (typeof camera !== 'undefined' && camera && camera.updateMatrixWorld) {
            camera.updateMatrixWorld();
        }
        const dx = clientX - dragStartX;
        const dy = clientY - dragStartY;
        const dist = Math.hypot(dx, dy);
        // Tiny jitter on press: keep starting stick exactly.
        if (dist < 2) {
            syncJoystickHandle(startJoyX, startJoyY);
            return;
        }
        const { softPx, fullPx } = getDragRadii();
        const mag = mapDistToJoyMag(dist, softPx, fullPx);
        const delta = mapScreenDragToJoy(dx, dy, mag, t);
        const next = clampJoyVector(startJoyX + delta.joyX, startJoyY + delta.joyY);
        if (!GameContext.stateMachine.setJoystickInput(t.id, next.joyX, next.joyY)) return;
        syncJoystickHandle(next.joyX, next.joyY);
        if (typeof uiRefreshPreview === 'function') uiRefreshPreview(t);
        else if (typeof updateDashboardUI === 'function') updateDashboardUI(t);
    }

    function setOrbitLocked(locked, backupKey = '_lcosOrbitBackup') {
        if (typeof controls === 'undefined' || !controls) return;
        if (!controls.userData) controls.userData = {};
        const touchLikely = ('ontouchstart' in window)
            || (navigator.maxTouchPoints > 0)
            || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        if (locked) {
            if (!controls.userData[backupKey]) {
                controls.userData[backupKey] = {
                    enableZoom: controls.enableZoom,
                    enablePan: controls.enablePan,
                    enableRotate: controls.enableRotate
                };
            }
            controls.enableZoom = false;
            controls.enablePan = false;
            controls.enableRotate = false;
        } else if (controls.userData[backupKey]) {
            const b = controls.userData[backupKey];
            // Touch devices keep zoom off permanently (browser pinch is the real hazard).
            controls.enableZoom = touchLikely ? false : (b.enableZoom !== false);
            controls.enablePan = b.enablePan !== false;
            controls.enableRotate = b.enableRotate !== false;
            controls.userData[backupKey] = null;
        }
    }

    window.AirArenaNoseDrag = {
        DRAG_CONFIG: LCOS_DRAG,
        getRadii: getDragRadii,
        mapDistToJoyMag,
        mapScreenDragToJoy,
        clampJoyVector,
        syncCockpitJoy: syncJoystickHandle,
        setOrbitLocked
    };

    function getLcosDragShield() {
        let shield = document.getElementById('lcos-drag-shield');
        if (shield) return shield;
        shield = document.createElement('div');
        shield.id = 'lcos-drag-shield';
        document.body.appendChild(shield);
        const block = (e) => {
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
        };
        shield.addEventListener('touchstart', block, { passive: false });
        shield.addEventListener('touchmove', block, { passive: false });
        shield.addEventListener('gesturestart', block, { passive: false });
        shield.addEventListener('gesturechange', block, { passive: false });
        shield.addEventListener('pointermove', (e) => {
            if (!window.isDraggingLcosRing) return;
            if (activePointerId != null && e.pointerId !== activePointerId) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (!dragMoved && Math.hypot(dx, dy) >= TAP_MOVE_PX) dragMoved = true;
            if (e.cancelable) e.preventDefault();
            applyNoseFromPointer(e.clientX, e.clientY);
        }, { passive: false });
        shield.addEventListener('pointerup', endDrag);
        shield.addEventListener('pointercancel', endDrag);
        return shield;
    }

    function setLcosDragShield(on) {
        const shield = getLcosDragShield();
        shield.style.display = on ? 'block' : 'none';
        if (on && activePointerId != null) {
            try { shield.setPointerCapture(activePointerId); } catch (_) { /* ignore */ }
        }
    }

    function endDrag(e) {
        if (!window.isDraggingLcosRing) return;
        if (e && activePointerId != null && e.pointerId !== activePointerId) return;
        const wasDrag = dragMoved;
        window.isDraggingLcosRing = false;
        activePointerId = null;
        setOrbitLocked(false, '_lcosOrbitBackup');
        setLcosDragShield(false);
        ['lcos-grab-ring', 'lcos-grab-hit'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.style.cursor = 'grab';
        });
        const pipper = document.getElementById('lcos-pipper');
        if (pipper) pipper.classList.remove('lcos-dragging');
        const cone = document.getElementById('lcos-cone-circle');
        if (cone) cone.setAttribute('stroke-width', '2.6');

        // Double-tap (no meaningful drag): same as SMS ENT — queue gun / missile.
        if (!wasDrag && canPilotActive()) {
            const now = Date.now();
            if (now - lastTapAt <= DBLTAP_MS) {
                lastTapAt = 0;
                if (typeof window.uiToggleWeaponFireQueue === 'function') {
                    window.uiToggleWeaponFireQueue();
                }
            } else {
                lastTapAt = now;
            }
        } else {
            lastTapAt = 0;
        }
    }

    function onGrabPointerDown(e) {
        if (e.button != null && e.button !== 0) return;
        if (typeof isDraggingJoystick !== 'undefined' && isDraggingJoystick) return;
        if (typeof isDraggingRollRing !== 'undefined' && isDraggingRollRing) return;
        if (window.isDraggingGhostSteer) return;
        const t = canPilotActive();
        if (!t) return;

        const pipper = document.getElementById('lcos-pipper');
        if (!pipper || pipper.style.display === 'none') return;

        // Relative grab — do not snap stick to click-vs-center (that auto-centered).
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        startJoyX = Number(t.joyX) || 0;
        startJoyY = Number(t.joyY) || 0;
        dragMoved = false;

        window.isDraggingLcosRing = true;
        activePointerId = e.pointerId;
        setOrbitLocked(true, '_lcosOrbitBackup');
        setLcosDragShield(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        e.currentTarget.style.cursor = 'grabbing';
        pipper.classList.add('lcos-dragging');
        const cone = document.getElementById('lcos-cone-circle');
        if (cone) cone.setAttribute('stroke-width', '3.4');

        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        syncJoystickHandle(startJoyX, startJoyY);
    }

    function onGrabPointerMove(e) {
        if (!window.isDraggingLcosRing) return;
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!dragMoved && Math.hypot(dx, dy) >= TAP_MOVE_PX) dragMoved = true;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        applyNoseFromPointer(e.clientX, e.clientY);
    }

    function bindGrabRing() {
        const targets = [
            document.getElementById('lcos-grab-hit'),
            document.getElementById('lcos-grab-ring')
        ].filter(Boolean);
        targets.forEach((grab) => {
            if (grab.dataset.dragBound === 'true') return;
            grab.dataset.dragBound = 'true';
            grab.setAttribute('title', '拖曳調機頭｜雙擊開火／發射');
            grab.addEventListener('pointerdown', onGrabPointerDown, { passive: false });
            grab.addEventListener('pointermove', onGrabPointerMove, { passive: false });
            grab.addEventListener('pointerup', endDrag);
            grab.addEventListener('pointercancel', endDrag);
            grab.addEventListener('lostpointercapture', endDrag);
            grab.addEventListener('touchstart', (e) => {
                if (e.cancelable) e.preventDefault();
            }, { passive: false });
            grab.addEventListener('touchmove', (e) => {
                if (e.cancelable) e.preventDefault();
            }, { passive: false });
        });
    }

    bindGrabRing();
    setInterval(bindGrabRing, 2000);
})();

// 🌟 2. 動態注入敵機未來預估框 (Estimated Position Box)
if (!document.getElementById('ghost-hud')) {
    const ghostHud = document.createElement('div');
    ghostHud.id = 'ghost-hud';
    ghostHud.style.position = 'absolute';
    ghostHud.style.width = '32px';
    ghostHud.style.height = '32px';
    ghostHud.style.border = '2px dashed #00e5ff';
    ghostHud.style.pointerEvents = 'none';
    ghostHud.style.zIndex = '7500';
    ghostHud.style.display = 'none';
    ghostHud.style.transform = 'translate(-50%, -50%)';
    ghostHud.style.boxShadow = '0 0 8px rgba(0, 229, 255, 0.4)';
    
    // 加載標籤與轉折角線
    ghostHud.innerHTML = `
        <div style="position: absolute; top: -18px; left: 50%; transform: translateX(-50%); font-size: 9px; color: #00e5ff; font-weight: bold; white-space: nowrap; text-shadow: 0 0 4px #000; letter-spacing: 1px;">EST. POS</div>
    `;
    document.body.appendChild(ghostHud);
}

// 🌟 3. 初始化 HUD 點擊事件 (僅用於飛彈模式下開關包絡線)
if (typeof window.hudClickListenerRegistered === 'undefined') {
    window.hudClickListenerRegistered = true;
    const setupHudClick = () => {
        let hudElement = document.getElementById('dynamic-hud');
        if (hudElement && !hudElement.dataset.clickBound) {
            hudElement.dataset.clickBound = "true";
            hudElement.style.pointerEvents = "auto";
            hudElement.addEventListener('click', (e) => {
                let currentTeam = GameContext.getActiveTeamId();
                let enemyId = (typeof GameContext !== 'undefined' && GameContext.getTargetId)
                    ? GameContext.getTargetId(currentTeam)
                    : ((typeof GameContext !== 'undefined' && GameContext.getNearestHostileId)
                        ? GameContext.getNearestHostileId(currentTeam)
                        : (currentTeam === 'red' ? 'blue' : 'red'));
                let enemy = (typeof teams !== 'undefined') ? teams[enemyId] : null; 
                let t = teams[currentTeam];

                if (enemy) {
                    if (t && t.weapon === 'gun') {
                        showSMSAlert("⚠️ 機砲模式下強制隱藏包絡線，請專注 LCOS 瞄準", "#ffcc00");
                        return;
                    }

                    if (!enemy.userData) enemy.userData = {};
                    enemy.userData.showEnvelope = !enemy.userData.showEnvelope;
                    
                    if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) {
                        threatEnvGroup.visible = enemy.userData.showEnvelope;
                    }
                    if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemyId]) {
                        trajectoryMeshes[enemyId].visible = enemy.userData.showEnvelope;
                    }
                }
            });
        }
    };
    setupHudClick();
    setInterval(setupHudClick, 2000); 
}

// 🌟 4. 核心渲染更新：每影格刷新雙框定位與 LCOS 物理投影
/**
 * Keep LCOS near aircraft forward on screen. Full world-impact projection often
 * flies off the top of the viewport in top-down / planning cams.
 */
function resolveLcosScreenPos(aimPoint, noseAnchorWorld, opts) {
    const w = window.innerWidth || 800;
    const h = window.innerHeight || 600;
    const nose = noseAnchorWorld.clone().project(camera);
    let nx = (nose.x * 0.5 + 0.5) * w;
    let ny = (nose.y * -0.5 + 0.5) * h;
    const noseOk = !(nose.z > 1.0);

    let px;
    let py;
    let aimOk = aimPoint && !(aimPoint.z > 1.0);
    if (aimOk) {
        px = (aimPoint.x * 0.5 + 0.5) * w;
        py = (aimPoint.y * -0.5 + 0.5) * h;
    } else if (noseOk) {
        px = nx;
        py = ny;
    } else {
        return null;
    }

    // Direct world mode (rocket VT intercept / surface CCIP): keep exact 3D-to-2D projection
    // whenever on screen so the 2D pipper sits directly on the 3D ballistic point.
    const directWorld = !!(opts && opts.directWorld);
    if (!directWorld && noseOk) {
        const maxLeadPx = Math.min(w, h) * 0.2;
        let dx = px - nx;
        let dy = py - ny;
        const d = Math.hypot(dx, dy);
        if (d > maxLeadPx && d > 0.001) {
            px = nx + (dx / d) * maxLeadPx;
            py = ny + (dy / d) * maxLeadPx;
        }
    }

    const margin = 42;
    px = Math.max(margin, Math.min(w - margin, px));
    py = Math.max(margin, Math.min(h - margin, py));
    return { px, py };
}

window.updateDynamicHUD = function() {
    let currentTeam = GameContext.getActiveTeamId();
    let t = teams[currentTeam];
    let enemyId = (GameContext.getTargetId && GameContext.getTargetId(currentTeam))
        || (GameContext.getNearestHostileId && GameContext.getNearestHostileId(currentTeam))
        || (currentTeam === 'red' ? 'blue' : 'red');
    let enemy = teams[enemyId];
    const gunFireRange = (typeof GUN_RANGE !== 'undefined' && GUN_RANGE > 0) ? GUN_RANGE : 70;
    
    let hudShape = document.getElementById('hud-shape');
    let dynamicHud = document.getElementById('dynamic-hud');
    let ghostHud = document.getElementById('ghost-hud');
    let lcosPipper = document.getElementById('lcos-pipper');
    let lcosConeCircle = document.getElementById('lcos-cone-circle');

    const ringDragging = !!window.isDraggingLcosRing;

    if (!t || !enemy || !t.wrapper || !enemy.wrapper || t.isDestroyed || enemy.isDestroyed) {
        if(dynamicHud) dynamicHud.style.display = 'none';
        if(ghostHud) ghostHud.style.display = 'none';
        if(lcosPipper && !ringDragging) lcosPipper.style.display = 'none';
        updateLcosGunHeatRing(null, 50, 50, 37.4, false);
        updateMissileSeekerBrackets({ visible: false });
        updateLcosWeaponTag(null, { hide: true });
        if (typeof updateFox1SupportHud === 'function') updateFox1SupportHud(null, null, null, null, true);
        return;
    }

    if (GameContext.isReplayMode()) {
        if(dynamicHud) dynamicHud.style.display = 'none';
        if(ghostHud) ghostHud.style.display = 'none';
        if(lcosPipper && !ringDragging) lcosPipper.style.display = 'none';
        updateLcosGunHeatRing(null, 50, 50, 37.4, false);
        updateMissileSeekerBrackets({ visible: false });
        updateLcosWeaponTag(null, { hide: true });
        if (typeof updateFox1SupportHud === 'function') updateFox1SupportHud(null, null, null, null, true);
        return;
    }

    const splitView = !!(window.AirArenaMultiView
        && typeof window.AirArenaMultiView.isSplit === 'function'
        && window.AirArenaMultiView.isSplit());
    // Split uses per-pane cameras; a single full-window lock box would sit on the wrong pane.
    // Per-pane clones would cost more (N projections + N DOM). Hide lock HUD and skip LOS/FOX-1 work.
    if (splitView) {
        if (dynamicHud) dynamicHud.style.display = 'none';
        if (ghostHud) ghostHud.style.display = 'none';
        if (lcosPipper) lcosPipper.style.display = 'none';
        const lockLabel = document.getElementById('hud-tgt-lock');
        if (lockLabel) {
            lockLabel.classList.remove('is-on');
            lockLabel.hidden = true;
        }
        window.isDraggingLcosRing = false;
        updateLcosGunHeatRing(null, 50, 50, 37.4, false);
        updateMissileSeekerBrackets({ visible: false });
        updateLcosWeaponTag(null, { hide: true });
        if (typeof updateFox1SupportHud === 'function') updateFox1SupportHud(null, null, null, null, true);
        if (typeof uiUpdateSmsRadarLockWarn === 'function') uiUpdateSmsRadarLockWarn(t);
        return;
    }

    let myGhostPos = (t.pathPoints && t.pathPoints.length > 0) ? t.pathPoints[t.pathPoints.length - 1] : t.wrapper.position;
    let myGhostQuat = (t.pathQuats && t.pathQuats.length > 0) ? t.pathQuats[t.pathQuats.length - 1] : t.wrapper.quaternion;
    
    let enemyCurrentPos = enemy.wrapper.position.clone(); 
    let enemyGhostPos = (enemy.pathPoints && enemy.pathPoints.length > 0) ? enemy.pathPoints[enemy.pathPoints.length - 1] : enemy.wrapper.position; 

    let isObscured = false;
    if (typeof obstacles !== 'undefined' && obstacles.length > 0) {
        let dir = new THREE.Vector3().subVectors(enemyCurrentPos, t.wrapper.position).normalize();
        let dist = t.wrapper.position.distanceTo(enemyCurrentPos);
        let ray = new THREE.Raycaster(t.wrapper.position, dir, 0.1, dist);
        let hits = ray.intersectObjects(obstacles, true);
        if (hits.length > 0) isObscured = true;
    }

    // ========================================================================
    // 🔲 框 1：【主追蹤框 (dynamic-hud)】
    // ========================================================================
    let currentProj = enemyCurrentPos.clone();
    currentProj.project(camera);

    if (currentProj.z > 1.0) {
        if(dynamicHud) dynamicHud.style.display = 'none';
    } else {
        if(dynamicHud) dynamicHud.style.display = 'block';
        let x = (currentProj.x * 0.5 + 0.5) * window.innerWidth;
        let y = (currentProj.y * -0.5 + 0.5) * window.innerHeight;
        
        dynamicHud.style.left = `${x}px`;
        dynamicHud.style.top = `${y}px`;

        if (isObscured) {
            hudShape.style.borderColor = '#ff9800'; 
            hudShape.style.backgroundColor = 'transparent';
            hudShape.style.boxShadow = 'none';
            hudShape.style.borderStyle = 'dashed';
            hudShape.innerHTML = '<span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #ff9800; font-weight: 900; font-size: 14px; text-shadow: 0 0 4px #ff9800;">X</span>';
            const lockLabel = document.getElementById('hud-tgt-lock');
            if (lockLabel) {
                lockLabel.classList.remove('is-on');
                lockLabel.hidden = true;
            }
        } else {
            hudShape.style.borderStyle = 'solid';
            let distance = t.wrapper.position.distanceTo(enemyCurrentPos);
            let forward = new THREE.Vector3(0, 0, 1).applyQuaternion(t.wrapper.quaternion).normalize();
            let angle = forward.angleTo(new THREE.Vector3().subVectors(enemyCurrentPos, t.wrapper.position).normalize());
            
            const liveMsl = (typeof teamLiveMissileType === 'function') ? teamLiveMissileType(t) : 'fox2';
            const fox1Cfg = (typeof getMissileWeaponConfig === 'function')
                ? getMissileWeaponConfig('fox1')
                : ((CONFIG.weapons && CONFIG.weapons.fox1) ? CONFIG.weapons.fox1 : {});
            const missileLockRange = liveMsl === 'fox1'
                ? (Number(fox1Cfg.seekerRange) || 200)
                : ((typeof SEEKER_RANGE !== 'undefined' && SEEKER_RANGE > 0) ? SEEKER_RANGE : 120);
            const missileLockMin = liveMsl === 'fox1' ? (Number(fox1Cfg.minArmingRange) || 50) : 0;
            const missileLockAng = liveMsl === 'fox1'
                ? (Number(fox1Cfg.seekerAngle) || Math.PI / 14)
                : Math.PI / 12;
            const rktCfg = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.rocket)
                ? CONFIG.weapons.rocket
                : {};
            let isLocked = false;
            if (t.weapon === 'gun') {
                isLocked = distance <= gunFireRange && angle <= Math.PI / 8;
            } else if (t.weapon === 'missile') {
                isLocked = distance <= missileLockRange && distance >= missileLockMin && angle <= missileLockAng;
            } else if (t.weapon === 'rocket') {
                const rSol = (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.computeRocketAimSolution === 'function')
                    ? AirArenaRocket.computeRocketAimSolution(t, enemy)
                    : null;
                isLocked = !!(rSol && rSol.fuze === 'vt' && rSol.anyVtHit);
            }

            const fox1Active = liveMsl === 'fox1' && t.weapon === 'missile' && (
                !!(t.wpnQueued && t.queuedAction === 'missile') ||
                (t.activeMissiles && t.activeMissiles.some(m => m.missileType === 'fox1' && !m.exploded && m.ap > 0))
            );
            const showFox1LockLabel = !!(fox1Active && isLocked);

            if (fox1Active && isLocked) {
                hudShape.style.borderColor = '#ff0055';
                hudShape.style.backgroundColor = 'rgba(255, 0, 85, 0.14)';
                hudShape.style.boxShadow = '0 0 15px rgba(255, 0, 85, 0.45)';
                hudShape.innerHTML = '<span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #ff0055; font-weight: 900; font-size: 14px; text-shadow: 0 0 5px #ff0055;">O</span>';
            } else if (isLocked) {
                hudShape.style.borderColor = '#00ff88';
                hudShape.style.backgroundColor = 'rgba(0, 255, 136, 0.12)';
                hudShape.style.boxShadow = '0 0 15px rgba(0, 255, 136, 0.4)';
                hudShape.innerHTML = '<span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #00ff88; font-weight: 900; font-size: 14px; text-shadow: 0 0 5px #00ff88;">O</span>';
            } else {
                hudShape.style.borderColor = '#00bcd4';
                hudShape.style.backgroundColor = 'transparent';
                hudShape.style.boxShadow = 'none';
                hudShape.innerHTML = '<span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #00bcd4; font-weight: 900; font-size: 14px;">X</span>';
            }

            const lockLabel = document.getElementById('hud-tgt-lock');
            if (lockLabel) {
                lockLabel.classList.toggle('is-on', showFox1LockLabel);
                lockLabel.hidden = !showFox1LockLabel;
            }
        }
    }

    updateFox1SupportHud(t, enemy, enemyCurrentPos, currentProj, isObscured);
    if (typeof uiUpdateSmsRadarLockWarn === 'function') uiUpdateSmsRadarLockWarn(t);

    // ========================================================================
    // 🎯 準星：外細圓環平時顯示（機砲 / 飛彈）；倒 T 僅機砲排程後
    // ========================================================================
    const missileHitRange = (typeof SEEKER_RANGE !== 'undefined' && SEEKER_RANGE > 0)
        ? SEEKER_RANGE
        : ((typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.seekerRange)
            ? CONFIG.weapons.fox2.seekerRange
            : 52);
    const missileHitAngle = (typeof SEEKER_ANGLE !== 'undefined' && SEEKER_ANGLE > 0)
        ? SEEKER_ANGLE
        : ((typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2 && CONFIG.weapons.fox2.seekerAngle)
            ? CONFIG.weapons.fox2.seekerAngle
            : Math.PI / 12);

    const showInnerT =
        t.weapon === 'gun' && (
            !!t.ready ||
            !!(t.wpnQueued && t.weapon === 'gun') ||
            (typeof GameContext !== 'undefined' && GameContext.isAnimating && GameContext.isAnimating())
        );

    const surfaceReticle = document.getElementById('lcos-surface-reticle');
    const surfaceDot = document.getElementById('lcos-surface-dot');
    const setSurfaceReticle = (visible, color) => {
        if (!surfaceReticle) return;
        surfaceReticle.style.display = visible ? 'block' : 'none';
        if (visible && color) {
            surfaceReticle.setAttribute('stroke', color);
            if (surfaceDot) surfaceDot.setAttribute('fill', color);
        }
    };

    const hidePipper = () => {
        if (window.isDraggingLcosRing) return;
        if (lcosPipper) lcosPipper.style.display = 'none';
        if (ghostHud) ghostHud.style.display = 'none';
        setSurfaceReticle(false);
        updateLcosGunHeatRing(t, 50, 50, 37.4, false);
        updateMissileSeekerBrackets({ visible: false });
        updateLcosWeaponTag(null, { hide: true });
    };

    const paintPipperColor = (inRange, customColor) => {
        const ringStroke = customColor || (inRange ? '#ff0055' : '#ffffff');
        const aimStroke = inRange ? '#ff0055' : '#e6c200';
        if (inRange) {
            lcosPipper.style.opacity = '1.0';
            lcosPipper.querySelector('svg').style.filter = 'drop-shadow(0 0 5px #ff0055)';
        } else {
            lcosPipper.style.opacity = customColor ? '0.95' : '0.85';
            lcosPipper.querySelector('svg').style.filter = customColor
                ? `drop-shadow(0 0 4px ${customColor})`
                : 'drop-shadow(0 0 3px rgba(255, 255, 255, 0.45))';
        }
        if (lcosConeCircle) lcosConeCircle.setAttribute('stroke', ringStroke);
        const innerT = document.getElementById('lcos-inner-t');
        if (innerT) innerT.setAttribute('stroke', aimStroke);
        const centerDot = document.getElementById('lcos-center-dot');
        if (centerDot) centerDot.setAttribute('fill', inRange ? '#ff0055' : '#e6c200');
    };

    // 飛彈已排程（SMS ENT / 雙擊）；空心 X 還需同時在射擊窗內（準星紅）
    const missileQueued =
        t.weapon === 'missile' && (!!t.ready || !!t.wpnQueued);

    if (t.weapon === 'gun') {
        setSurfaceReticle(false);
        updateMissileSeekerBrackets({ visible: false });
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemy.id]) trajectoryMeshes[enemy.id].visible = false;
        if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) threatEnvGroup.visible = false;
        if (t.userData && t.userData.gunPreview) t.userData.gunPreview.visible = false;

        if (isObscured) {
            // Keep outer ring visible for nose steering even when LOS is blocked.
            const noseAnchor = myGhostPos.clone().add(
                new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).multiplyScalar(18)
            );
            const screenPos = resolveLcosScreenPos(null, noseAnchor);
            if (!screenPos) {
                hidePipper();
            } else {
                lcosPipper.style.display = 'block';
                if (!window.lcosLastPos) window.lcosLastPos = new THREE.Vector2(screenPos.px, screenPos.py);
                else window.lcosLastPos.lerp(new THREE.Vector2(screenPos.px, screenPos.py), 0.4);
                lcosPipper.style.left = `${window.lcosLastPos.x}px`;
                lcosPipper.style.top = `${window.lcosLastPos.y}px`;
                lcosPipper.style.width = '56px';
                lcosPipper.style.height = '56px';
                lcosPipper.style.opacity = '0.9';
                if (lcosConeCircle) {
                    lcosConeCircle.setAttribute('cx', '50');
                    lcosConeCircle.setAttribute('cy', '50');
                    lcosConeCircle.setAttribute('r', '35.2');
                    lcosConeCircle.setAttribute('stroke', '#ffffff');
                    lcosConeCircle.setAttribute('stroke-width', '3.2');
                    syncLcosGrabGeometry(50, 50, 35.2);
                    updateLcosGunHeatRing(t, 50, 50, 35.2, true);
                }
                const aimGroup = document.getElementById('lcos-aim-group');
                if (aimGroup) aimGroup.style.display = 'none';
                if (ghostHud) ghostHud.style.display = 'none';
                updateLcosWeaponTag(t, { obscured: true, inRange: false });
            }
        } else {
            let ghostProj = enemyGhostPos.clone();
            ghostProj.project(camera);
            if (ghostProj.z > 1.0) {
                if (ghostHud) ghostHud.style.display = 'none';
            } else {
                if (ghostHud) ghostHud.style.display = 'block';
                ghostHud.style.left = `${(ghostProj.x * 0.5 + 0.5) * window.innerWidth}px`;
                ghostHud.style.top = `${(ghostProj.y * -0.5 + 0.5) * window.innerHeight}px`;
            }

            let dist = myGhostPos.distanceTo(enemyGhostPos);
            let aircraftSpeedPerFrame = (t.speed || 107) * 0.015 / 100;
            let muzzleSpeedPerFrame = 4.0;
            let effectiveBulletSpeed = muzzleSpeedPerFrame + aircraftSpeedPerFrame;
            let framesToImpact = dist / effectiveBulletSpeed;
            let myGhostForward = new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).normalize();
            let enemyForward = new THREE.Vector3(0, 0, 1).applyQuaternion(enemy.wrapper.quaternion).normalize();
            let myVel = myGhostForward.clone().multiplyScalar(aircraftSpeedPerFrame);
            let enemySpeedPerFrame = (enemy.flightLength || (enemy.ap * 0.015)) / 100;
            let enemyVel = enemyForward.clone().multiplyScalar(enemySpeedPerFrame);
            let relativeVel = enemyVel.clone().sub(myVel);
            let bulletImpactPos = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(dist));
            let gFrame = 0.0022;
            let gravityDrop = 0.5 * gFrame * framesToImpact * (framesToImpact + 1);
            bulletImpactPos.y -= gravityDrop;
            bulletImpactPos.add(relativeVel.multiplyScalar(framesToImpact * 0.5));

            let aimPoint = bulletImpactPos.clone();
            aimPoint.project(camera);

            const noseAnchor = myGhostPos.clone().add(
                new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).multiplyScalar(18)
            );
            const screenPos = resolveLcosScreenPos(aimPoint, noseAnchor);
            if (!screenPos) {
                hidePipper();
            } else {
                lcosPipper.style.display = 'block';
                let px = screenPos.px;
                let py = screenPos.py;
                if (!window.lcosLastPos) {
                    window.lcosLastPos = new THREE.Vector2(px, py);
                } else {
                    let screenDist = window.lcosLastPos.distanceTo(new THREE.Vector2(px, py));
                    if (screenDist > 400) window.lcosLastPos.set(px, py);
                    else window.lcosLastPos.lerp(new THREE.Vector2(px, py), 0.35);
                }
                lcosPipper.style.left = `${window.lcosLastPos.x}px`;
                lcosPipper.style.top = `${window.lcosLastPos.y}px`;

                const joyX = Number(t.joyX || 0);
                const joyY = Number(t.joyY || 0);
                const turnMag = Math.min(1, Math.hypot(joyX, joyY));
                const aircraftDistance = t.wrapper.position.distanceTo(enemy.wrapper.position);
                const minDistance = Math.min(20, gunFireRange * 0.35);
                const maxDistance = Math.max(gunFireRange * 2.5, 120);
                const normalizedDistance = Math.max(0, Math.min(1, (aircraftDistance - minDistance) / (maxDistance - minDistance)));
                const pipperSizePx = 64 - (normalizedDistance * 24);
                lcosPipper.style.width = `${pipperSizePx}px`;
                lcosPipper.style.height = `${pipperSizePx}px`;

                const bankQuat = myGhostQuat || t.wrapper.quaternion;
                const bankEuler = new THREE.Euler().setFromQuaternion(bankQuat, 'YXZ');
                const rollDeg = bankEuler.z * (180 / Math.PI);
                const leavePx = showInnerT ? (5 + turnMag * 5) : 0;
                const dirLen = Math.hypot(joyX, joyY);
                const leaveXPx = (showInnerT && dirLen > 0.02) ? (joyX / dirLen) * leavePx : 0;
                const leaveYPx = (showInnerT && dirLen > 0.02) ? (joyY / dirLen) * leavePx : 0;
                const svgPerPx = 100 / Math.max(1, pipperSizePx);
                const leaveXSvg = leaveXPx * svgPerPx;
                const leaveYSvg = leaveYPx * svgPerPx;

                if (lcosConeCircle) {
                    const funnelR = (32 + turnMag * (showInnerT ? 5 : 2)) * 1.1;
                    const cx = 50 - leaveXSvg * 0.35;
                    const cy = 50 - leaveYSvg * 0.35;
                    lcosConeCircle.setAttribute('cx', String(cx));
                    lcosConeCircle.setAttribute('cy', String(cy));
                    lcosConeCircle.setAttribute('r', String(funnelR));
                    syncLcosGrabGeometry(cx, cy, funnelR);
                    updateLcosGunHeatRing(t, cx, cy, funnelR, true);
                }

                const aimGroup = document.getElementById('lcos-aim-group');
                const innerT = document.getElementById('lcos-inner-t');
                if (aimGroup) {
                    aimGroup.style.display = showInnerT ? 'block' : 'none';
                    if (showInnerT) {
                        aimGroup.setAttribute(
                            'transform',
                            `translate(${leaveXSvg.toFixed(2)} ${leaveYSvg.toFixed(2)})`
                        );
                    } else {
                        aimGroup.setAttribute('transform', 'translate(0 0)');
                    }
                }
                if (innerT && showInnerT) {
                    innerT.setAttribute('transform', `rotate(${rollDeg.toFixed(2)} 50 52)`);
                }

                const gunInRange = dist < gunFireRange;
                paintPipperColor(gunInRange);
                updateLcosWeaponTag(t, {
                    distance: dist,
                    inRange: gunInRange,
                    obscured: false
                });
            }
        }
    } else if (t.weapon === 'missile') {
        setSurfaceReticle(false);
        updateLcosGunHeatRing(t, 50, 50, 37.4, false);
        // 飛彈：僅外細圓環，平時黃、進入 seeker 命中窗變紅
        let shouldShowEnv = !!(enemy.userData && enemy.userData.showEnvelope && !isObscured);
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemy.id]) {
            trajectoryMeshes[enemy.id].visible = shouldShowEnv;
        }
        if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) {
            threatEnvGroup.visible = shouldShowEnv;
        }
        if (ghostHud) ghostHud.style.display = 'none';

        if (isObscured) {
            const myGhostForward = new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).normalize();
            const noseAnchor = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(18));
            const screenPos = resolveLcosScreenPos(null, noseAnchor);
            if (!screenPos) {
                hidePipper();
            } else {
                lcosPipper.style.display = 'block';
                if (!window.lcosLastPos) window.lcosLastPos = new THREE.Vector2(screenPos.px, screenPos.py);
                else window.lcosLastPos.lerp(new THREE.Vector2(screenPos.px, screenPos.py), 0.4);
                lcosPipper.style.left = `${window.lcosLastPos.x}px`;
                lcosPipper.style.top = `${window.lcosLastPos.y}px`;
                lcosPipper.style.width = '52px';
                lcosPipper.style.height = '52px';
                lcosPipper.style.opacity = '0.9';
                if (lcosConeCircle) {
                    lcosConeCircle.setAttribute('cx', '50');
                    lcosConeCircle.setAttribute('cy', '50');
                    lcosConeCircle.setAttribute('r', '35.2');
                    lcosConeCircle.setAttribute('stroke', '#ffffff');
                    lcosConeCircle.setAttribute('stroke-width', '3.2');
                    syncLcosGrabGeometry(50, 50, 35.2);
                }
                const aimGroup = document.getElementById('lcos-aim-group');
                if (aimGroup) aimGroup.style.display = 'none';
                updateMissileSeekerBrackets({
                    visible: true,
                    lockedX: false,
                    pipperX: window.lcosLastPos.x,
                    pipperY: window.lcosLastPos.y,
                    pipperSize: 52,
                    ringR: 35.2,
                    color: '#ffffff'
                });
                updateLcosWeaponTag(t, { obscured: true, inRange: false });
            }
        } else {
            const myGhostForward = new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).normalize();
            const toEnemy = enemyGhostPos.clone().sub(myGhostPos);
            const dist = toEnemy.length();
            const toEnemyNorm = dist > 0.001 ? toEnemy.clone().normalize() : myGhostForward.clone();
            const angleToEnemy = myGhostForward.angleTo(toEnemyNorm);
            const aimDist = Math.max(18, Math.min(dist || missileHitRange, missileHitRange + 8));
            const aimWorld = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(aimDist));
            const aimPoint = aimWorld.clone();
            aimPoint.project(camera);

            const noseAnchor = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(18));
            const screenPos = resolveLcosScreenPos(aimPoint, noseAnchor);
            if (!screenPos) {
                hidePipper();
            } else {
                lcosPipper.style.display = 'block';
                const px = screenPos.px;
                const py = screenPos.py;
                if (!window.lcosLastPos) {
                    window.lcosLastPos = new THREE.Vector2(px, py);
                } else {
                    const screenDist = window.lcosLastPos.distanceTo(new THREE.Vector2(px, py));
                    if (screenDist > 400) window.lcosLastPos.set(px, py);
                    else window.lcosLastPos.lerp(new THREE.Vector2(px, py), 0.4);
                }
                lcosPipper.style.left = `${window.lcosLastPos.x}px`;
                lcosPipper.style.top = `${window.lcosLastPos.y}px`;

                const joyX = Number(t.joyX || 0);
                const joyY = Number(t.joyY || 0);
                const turnMag = Math.min(1, Math.hypot(joyX, joyY));
                const normalizedDistance = Math.max(0, Math.min(1, (dist - 20) / Math.max(40, missileHitRange)));
                const pipperSizePx = 58 - (normalizedDistance * 16);
                lcosPipper.style.width = `${pipperSizePx}px`;
                lcosPipper.style.height = `${pipperSizePx}px`;

                const funnelR = (32 + turnMag * 3) * 1.1;
                if (lcosConeCircle) {
                    lcosConeCircle.setAttribute('cx', '50');
                    lcosConeCircle.setAttribute('cy', '50');
                    lcosConeCircle.setAttribute('r', String(funnelR));
                    syncLcosGrabGeometry(50, 50, funnelR);
                }
                const aimGroup = document.getElementById('lcos-aim-group');
                if (aimGroup) {
                    aimGroup.style.display = 'none';
                    aimGroup.setAttribute('transform', 'translate(0 0)');
                }

                const liveM = (typeof teamLiveMissileType === 'function') ? teamLiveMissileType(t) : 'fox2';
                const fox1c = (typeof getMissileWeaponConfig === 'function') ? getMissileWeaponConfig('fox1') : {};
                const hitMax = liveM === 'fox1' ? (Number(fox1c.seekerRange) || 200) : missileHitRange;
                const hitMin = liveM === 'fox1' ? (Number(fox1c.minArmingRange) || 50) : 8;
                const hitAng = liveM === 'fox1' ? (Number(fox1c.seekerAngle) || Math.PI / 14) : missileHitAngle;
                const inRange =
                    dist <= hitMax &&
                    dist >= hitMin &&
                    angleToEnemy <= hitAng &&
                    myGhostForward.dot(toEnemyNorm) > 0.55;
                paintPipperColor(inRange);
                // 方向盤 / seeker brackets stay on for FOX-1; illuminate ring is separate
                updateMissileSeekerBrackets({
                    visible: true,
                    lockedX: !!(missileQueued && inRange),
                    pipperX: window.lcosLastPos.x,
                    pipperY: window.lcosLastPos.y,
                    pipperSize: pipperSizePx,
                    ringR: funnelR,
                    color: inRange ? '#ff0055' : '#ffffff'
                });
                updateLcosWeaponTag(t, {
                    distance: dist,
                    inRange,
                    obscured: false
                });
            }
        }
    } else if (t.weapon === 'rocket') {
        updateLcosGunHeatRing(t, 50, 50, 37.4, false);
        updateMissileSeekerBrackets({ visible: false });
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemy.id]) {
            trajectoryMeshes[enemy.id].visible = false;
        }
        if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) {
            threatEnvGroup.visible = false;
        }
        if (t.userData && t.userData.gunPreview) t.userData.gunPreview.visible = false;

        const myGhostForward = new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).normalize();
        const noseAnchor = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(18));
        const sol = (typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.computeRocketAimSolution === 'function')
            ? AirArenaRocket.computeRocketAimSolution(t, enemy)
            : null;
        const fuze = (sol && sol.fuze)
            || ((typeof AirArenaRocket !== 'undefined' && typeof AirArenaRocket.getTeamFuzeMode === 'function')
                ? AirArenaRocket.getTeamFuzeMode(t)
                : (t.rocketFuze === 'impact' ? 'impact' : 'vt'));

        // Show EST. POS box only in VT air-to-air mode when LOS is clear.
        if (fuze === 'vt' && !isObscured && sol && sol.targetEstWorld && ghostHud) {
            const estProj = sol.targetEstWorld.clone().project(camera);
            if (estProj.z > 1.0) {
                ghostHud.style.display = 'none';
            } else {
                ghostHud.style.display = 'block';
                ghostHud.style.left = `${(estProj.x * 0.5 + 0.5) * window.innerWidth}px`;
                ghostHud.style.top = `${(estProj.y * -0.5 + 0.5) * window.innerHeight}px`;
            }
        } else if (ghostHud) {
            ghostHud.style.display = 'none';
        }

        const hasDirectAim = !!(sol && sol.aimWorld && (fuze === 'vt' || sol.grounded));
        const aimWorld = hasDirectAim
            ? sol.aimWorld
            : myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(42));
        const aimPoint = aimWorld.clone().project(camera);
        const screenPos = resolveLcosScreenPos(aimPoint, noseAnchor, { directWorld: hasDirectAim });

        if (!screenPos) {
            hidePipper();
        } else {
            lcosPipper.style.display = 'block';
            const px = screenPos.px;
            const py = screenPos.py;
            if (!window.lcosLastPos) {
                window.lcosLastPos = new THREE.Vector2(px, py);
            } else {
                const screenDist = window.lcosLastPos.distanceTo(new THREE.Vector2(px, py));
                if (screenDist > 400) window.lcosLastPos.set(px, py);
                else window.lcosLastPos.lerp(new THREE.Vector2(px, py), 0.42);
            }
            lcosPipper.style.left = `${window.lcosLastPos.x}px`;
            lcosPipper.style.top = `${window.lcosLastPos.y}px`;

            // Scale pipper diameter to physical VT / blast radius at aim point.
            const physRadius = fuze === 'impact'
                ? ((sol && sol.blastRadius) || 6)
                : ((sol && sol.vtRadius) || 4.5);
            const camDist = Math.max(12, camera.position.distanceTo(aimWorld));
            const focal = Math.max(window.innerHeight || 600, 480) * 0.72;
            const rawDiamPx = 2 * (physRadius / camDist) * focal;
            const pipperSizePx = Math.max(42, Math.min(96, rawDiamPx));
            lcosPipper.style.width = `${pipperSizePx.toFixed(1)}px`;
            lcosPipper.style.height = `${pipperSizePx.toFixed(1)}px`;

            const joyX = Number(t.joyX || 0);
            const joyY = Number(t.joyY || 0);
            const turnMag = Math.min(1, Math.hypot(joyX, joyY));
            const funnelR = (34 + turnMag * 2) * 1.05;
            if (lcosConeCircle) {
                lcosConeCircle.setAttribute('cx', '50');
                lcosConeCircle.setAttribute('cy', '50');
                lcosConeCircle.setAttribute('r', String(funnelR));
                syncLcosGrabGeometry(50, 50, funnelR);
            }
            const aimGroup = document.getElementById('lcos-aim-group');
            if (aimGroup) {
                aimGroup.style.display = 'none';
                aimGroup.setAttribute('transform', 'translate(0 0)');
            }

            const distToEnemy = myGhostPos.distanceTo(enemyGhostPos);
            if (fuze === 'impact') {
                const queued = !!(t.wpnQueued && t.queuedAction === 'rocket');
                const impCol = (sol && sol.grounded === false)
                    ? '#ff9800'
                    : (queued ? '#00e5ff' : '#ff9966');
                setSurfaceReticle(true, impCol);
                paintPipperColor(false, impCol);
                updateLcosWeaponTag(t, {
                    distance: distToEnemy,
                    slantDist: sol ? sol.slantDist : NaN,
                    grounded: sol ? sol.grounded : false,
                    hitBuilding: !!(sol && sol.hitBuilding),
                    inRange: false,
                    obscured: isObscured
                });
            } else {
                setSurfaceReticle(false);
                const vtHit = !!(sol && sol.anyVtHit && !isObscured);
                const vtBaseCol = (t.wpnQueued && t.queuedAction === 'rocket') ? '#4dd0e1' : null;
                paintPipperColor(vtHit, vtHit ? null : vtBaseCol);
                updateLcosWeaponTag(t, {
                    distance: distToEnemy,
                    inRange: vtHit,
                    obscured: isObscured
                });
            }
        }
    } else if (t.weapon === 'bomb') {
        updateLcosGunHeatRing(t, 50, 50, 37.4, false);
        updateMissileSeekerBrackets({ visible: false });
        if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[enemy.id]) {
            trajectoryMeshes[enemy.id].visible = false;
        }
        if (typeof threatEnvGroup !== 'undefined' && threatEnvGroup) {
            threatEnvGroup.visible = false;
        }
        if (t.userData && t.userData.gunPreview) t.userData.gunPreview.visible = false;
        if (ghostHud) ghostHud.style.display = 'none';

        const myGhostForward = new THREE.Vector3(0, 0, 1).applyQuaternion(myGhostQuat).normalize();
        const noseAnchor = myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(18));
        let bombImpact = null;
        if (typeof AirArenaBomb !== 'undefined'
            && typeof AirArenaBomb.estimateReleaseState === 'function'
            && typeof AirArenaBomb.computeBallisticPath === 'function') {
            const rel = AirArenaBomb.estimateReleaseState(t);
            if (rel && rel.pos && rel.vel) {
                const sig = `${t.id || ''}|${rel.pos.x.toFixed(2)},${rel.pos.y.toFixed(2)},${rel.pos.z.toFixed(2)}|${rel.vel.x.toFixed(2)},${rel.vel.y.toFixed(2)},${rel.vel.z.toFixed(2)}`;
                if (t._hudBombCcipCache && t._hudBombCcipCache.sig === sig) {
                    bombImpact = t._hudBombCcipCache.impact;
                } else {
                    const path = AirArenaBomb.computeBallisticPath(rel.pos, rel.vel, {});
                    bombImpact = (path && path.impact) ? path.impact.clone() : null;
                    t._hudBombCcipCache = { sig, impact: bombImpact };
                }
            }
        }
        const aimWorld = bombImpact || myGhostPos.clone().add(myGhostForward.clone().multiplyScalar(42));
        const aimPoint = aimWorld.clone().project(camera);
        const screenPos = resolveLcosScreenPos(aimPoint, noseAnchor, { directWorld: !!bombImpact });

        if (!screenPos) {
            hidePipper();
        } else {
            lcosPipper.style.display = 'block';
            const px = screenPos.px;
            const py = screenPos.py;
            if (!window.lcosLastPos) {
                window.lcosLastPos = new THREE.Vector2(px, py);
            } else {
                const screenDist = window.lcosLastPos.distanceTo(new THREE.Vector2(px, py));
                if (screenDist > 400) window.lcosLastPos.set(px, py);
                else window.lcosLastPos.lerp(new THREE.Vector2(px, py), 0.42);
            }
            lcosPipper.style.left = `${window.lcosLastPos.x}px`;
            lcosPipper.style.top = `${window.lcosLastPos.y}px`;
            lcosPipper.style.width = '56px';
            lcosPipper.style.height = '56px';

            const joyX = Number(t.joyX || 0);
            const joyY = Number(t.joyY || 0);
            const turnMag = Math.min(1, Math.hypot(joyX, joyY));
            const funnelR = (34 + turnMag * 2) * 1.05;
            if (lcosConeCircle) {
                lcosConeCircle.setAttribute('cx', '50');
                lcosConeCircle.setAttribute('cy', '50');
                lcosConeCircle.setAttribute('r', String(funnelR));
                syncLcosGrabGeometry(50, 50, funnelR);
            }
            const aimGroup = document.getElementById('lcos-aim-group');
            if (aimGroup) {
                aimGroup.style.display = 'none';
                aimGroup.setAttribute('transform', 'translate(0 0)');
            }
            const bCol = (t.wpnQueued && t.queuedAction === 'bomb') ? '#00e5ff' : '#c8e06a';
            setSurfaceReticle(true, bCol);
            paintPipperColor(false, bCol);
            updateLcosWeaponTag(t, {
                distance: myGhostPos.distanceTo(enemyGhostPos),
                inRange: false,
                obscured: isObscured
            });
        }
    } else {
        hidePipper();
    }
    
    if (typeof trajectoryMeshes !== 'undefined' && trajectoryMeshes[t.id]) {
        trajectoryMeshes[t.id].visible = true;
    }

    let tgtType = document.getElementById('hud-tgt-type');
    if (tgtType) {
        tgtType.innerText = isObscured ? 'OBSCURED' : (enemy.type ? enemy.type.toUpperCase() : 'TARGET');
        tgtType.style.color = isObscured ? '#ff9800' : '#00ff88';
    }
    let tgtAlt = document.getElementById('hud-tgt-alt');
    if (tgtAlt) tgtAlt.innerText = Math.floor(enemyCurrentPos.y);
    let tgtDist = document.getElementById('hud-tgt-dist');
    if (tgtDist) tgtDist.innerText = Math.floor(t.wrapper.position.distanceTo(enemyCurrentPos));
};
