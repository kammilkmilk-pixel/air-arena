// ============================================================================
// hover-help.js — notes on buttons and readouts, shown after a 1s hover
// ============================================================================
(function initHoverHelp(root) {
    const DELAY_MS = 1000;
    const TIP_ID = 'hover-help-tip';

    const BY_ID = {
        'btn-match-engage': '用目前的地圖、人數和機組開始這一局。',
        'btn-map-import': '把地圖編輯器匯出的 JSON 加進本機地圖清單。',
        'btn-map-delete': '刪除目前選中的自訂地圖。內建地圖不能刪。',
        'btn-pilot-random': '替參戰機組重新抽一組呼號。',
        'btn-match-host': '建立私人房間，把邀請碼給另一台裝置加入。',
        'btn-match-join': '用下方邀請碼加入已建立的房間。',
        'btn-match-queue': '公開排隊，配對另一位 1 對 1 的玩家。',
        'btn-match-reconnect': '用上次留下的座位憑證重新連上房間。',
        'btn-match-cloud-cfg': '填寫雲端對戰用的 Supabase 網址和金鑰。',
        'btn-match-copy-invite': '複製一條連結，讓手機或其他電腦直接加入。',
        'match-challenge-select': '選自由交戰，或選一個會帶入建議地圖和人數的挑戰。',
        'match-map-select': '這一局使用的地圖。',
        'match-spawn-alt': '雙方起飛高度。數字愈高，離地面和屋頂愈遠。',
        'match-spawn-sep': '雙方起飛時的水平距離。',
        'match-net-mode': '連線方式：同一區網的電腦開服，或雲端配對。',
        'match-join-code': '房間邀請碼。加入房間時填這裡。',
        'btn-rep-play': '播放或暫停這一局的戰術重播。',
        'btn-rep-director': '重播時自動換焦點戰機和鏡頭。拖曳畫面會改回手動。',
        'btn-rep-angle': '循環重播鏡頭：自動、尾隨、越肩、纏鬥雙機、機側掠影、戰術全景。',
        'btn-rep-exit': '離開重播，回到座艙規劃。',
        'replay-slider': '這一局的時間軸。拖曳可以跳到某個時刻。',
        'btn-ai-debug-export-all': '複製全部戰機的決策文字，並下載含飛行軌跡的 JSON。',
        'btn-replay-main-toggle': '收合或展開下面的席位、狀態和電台。',
        'replay-status': '現在是在規劃、計算回合，還是播放重播。',
        'replay-director-badge': '重播導播目前盯著誰、用哪個鏡頭、為什麼切過去。',
        'radio-tts-toggle': '開關電台語音。關掉之後字幕還在，只是不唸出來。',
        'radio-preview-btn': '試聽目前這句電台通話。',
        'radio-callsign': '正在說話的機組呼號。',
        'radio-subtitle': '電台字幕。內容跟著當下的通話走。',
        'wingman-gt-cycle': '換成下一個對地目標，給僚機的對地攻擊用。',
        'ai-debug-gt-cycle': '換成下一個對地目標。',
        'arena-mode-select': '場上建築要不要顯示、要不要擋飛機。',
        'arena-spawn-alt': '套用後的起飛高度。',
        'arena-spawn-sep': '套用後兩機的水平距離。',
        'btn-arena-apply-spawn': '把上面的高度和距離套到雙方現在的位置。',
        'arena-mode-status': '建築顯示和碰撞現在是開還是關。',
        'btn-temp-score-reset': '把臨時評分和紀錄清掉。',
        'btn-temp-score-active-plus': '給目前啟用的評分模式加 1 分。',
        'btn-temp-score-active-minus': '給目前啟用的評分模式減 1 分。',
        'temp-score-note': '給這一筆評分留一句備註。',
        'btn-temp-score-note': '把目前分數和備註寫進下面的紀錄。',
        'temp-score-heuristic': 'Heuristic 模式的臨時分數。',
        'temp-score-hybrid': 'Hybrid 模式的臨時分數。',
        'temp-score-active-mode': '現在哪一種評分模式在收「目前 +1／−1」。',
        'ghost-grab-hit': '按住拖曳，改變機頭指向。',
        'ghost-roll-hit': '按住外圈拖曳，調整油門。',
        'ghost-handle-left': '按住左側握把上下拖，讓飛機向左或向右滾轉。',
        'ghost-handle-right': '按住右側握把上下拖，讓飛機向左或向右滾轉。',
        'ghost-steer-alt': '高度，單位是公尺。',
        'ghost-steer-thr': '油門檔。愈高推力愈大，也愈容易累積溫度。',
        'ops-val-heat': '引擎核心溫度。太高時推力會受限。',
        'ops-val-ap': '空速。失速附近飛機會變鈍，凝結尾也會改成紊流。',
        'ops-radial-ok': '確認目前的操縱和武器，開始這一回合。',
        'ops-tac-screen': '環形操作盤上的戰術電腦摘要。',
        'ops-sms-text': '目前武器和掛架狀態的短句。',
        'ops-wpn-close': '關掉這個武器的性能說明。',
        'ops-wpn-fire': '把這個武器排進本回合發射，效果和戰術電腦的 ENT 相同。',
        'btn-ops-panel-toggle': '收合或打開底部座艙面板。',
        'btn-flare': '排程本回合投放熱焰彈，用來誘偏紅外線飛彈。再點一次取消。括號是剩餘數量。',
        'btn-chaff': '排程本回合投放箔條，用來干擾雷達飛彈。再點一次取消。括號是剩餘數量。',
        'sms-exec-btn': '確認這架戰機本回合的操縱和武器，然後開始交戰。',
        'sms-text-content': '戰術電腦目前的武器狀態。黃字是已選武器，通電或待發會寫在這裡。',
        'sms-fuze-btn': '切換火箭引信。VT 對空會在靠近飛機時空爆，IMP 對地要撞上才炸。',
        'sms-enter-btn': '把目前選中的武器排進本回合發射。',
        'hud-val-heat': '引擎核心溫度，單位是 °C。',
        'hud-val-ap': '空速，單位是公尺每秒。',
        'hud-data-tag': '鎖定框上的目標機種、高度和距離。',
        'hud-tgt-alt': '目標高度，單位是公尺。',
        'hud-tgt-dist': '和目標的距離，單位是公尺。',
        'joystick-zone': '拖曳搖桿改變機頭。畫面中央的操縱環做同一件事。',
        'throttle-handle': '沿軌道上下拖，切換油門檔。',
        'hud-hp-fill-vertical': '這架戰機剩下的生命值。條愈滿愈完整。'
    };

    const BY_ORDER = {
        follow: '僚機跟著你飛，不自己找目標。',
        attack: '僚機攻擊你鎖定的空中目標。',
        strike: '僚機攻擊你指定的地面目標。',
        free: '僚機自己找空中目標進攻。',
        cover: '僚機留在你附近掩護。',
        break: '僚機脫離當下的交戰。',
        __gt_cycle__: '換成下一個對地目標。'
    };

    const BY_MODE = {
        '1v1': '紅藍各一架。適合單挑，也方便試武器和箔條。',
        '2v2': '紅藍各兩架。僚機可以受你指揮。'
    };

    const BY_FACTION = {
        red: '這一局你扮演紅方。',
        blue: '這一局你扮演藍方。'
    };

    const BY_FUZE = {
        vt: '近發引信。火箭靠近飛機就空爆，用來打空中目標。',
        impact: '撞擊引信。碰到地面或建築才炸，不會提前空爆。'
    };

    const BY_OPS = {
        flare: '熱焰彈。點一下排程本回合投放。',
        gun: '機砲。選中後，交戰時沿著機頭射擊。',
        chaff: '箔條。點一下排程本回合投放。'
    };

    function tipEl() {
        let el = document.getElementById(TIP_ID);
        if (el) return el;
        el = document.createElement('div');
        el.id = TIP_ID;
        el.setAttribute('role', 'tooltip');
        el.hidden = true;
        document.body.appendChild(el);
        return el;
    }

    function textOf(el) {
        if (!el) return '';
        const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return raw;
    }

    function byClass(el) {
        if (el.classList.contains('team-sel-btn')) {
            return '選這架戰機的畫面。已經聚焦時再點一次，可關掉多餘的分屏。';
        }
        if (el.classList.contains('cockpit-rect-btn')) {
            return '這架戰機確認或取消本回合。規劃中表示還沒交戰，待戰中表示已經確認。';
        }
        if (el.classList.contains('seat-bar-hp')) return '生命值。綠條愈滿，機體愈完整。';
        if (el.classList.contains('seat-bar-ap')) return '空速條。愈滿飛得愈快。';
        if (el.classList.contains('seat-pylons') || el.classList.contains('seat-pylon-slot')) {
            return '掛架。灰是待命，黃是通電中，綠是可以發射，暗掉表示已經打空。';
        }
        if (el.classList.contains('pylon-switch-wrapper') || el.classList.contains('pylon-stick')) {
            return '點這個掛架開始通電。通電完成才能發射，而且不能中途斷電。';
        }
        if (el.classList.contains('digital-val')) {
            return el.querySelector('#hud-val-heat, #ops-val-heat')
                ? BY_ID['hud-val-heat']
                : BY_ID['hud-val-ap'];
        }
        if (el.classList.contains('ghost-handle-stat-heat')) return BY_ID['ops-val-heat'];
        if (el.classList.contains('ghost-handle-stat-ap')) return BY_ID['ops-val-ap'];
        if (el.classList.contains('match-control-select')) return '這架戰機由玩家操縱，還是交給電腦。';
        if (el.classList.contains('match-pylon-select')) return '這個掛架出發時掛什麼：飛彈、火箭、炸彈或空架。';
        if (el.classList.contains('match-mode-btn')) return BY_MODE[el.getAttribute('data-mode')] || '';
        if (el.classList.contains('match-faction-btn')) return BY_FACTION[el.getAttribute('data-faction')] || '';
        if (el.classList.contains('wingman-order-btn') || el.classList.contains('ai-debug-wingman-btn')) {
            return BY_ORDER[el.getAttribute('data-order')] || '';
        }
        if (el.classList.contains('ops-fuze-btn') || el.classList.contains('sms-fuze-btn')) {
            return BY_FUZE[el.getAttribute('data-fuze')] || BY_ID['sms-fuze-btn'];
        }
        if (el.classList.contains('temp-score-btn')) {
            const mode = el.getAttribute('data-score-mode');
            const delta = el.getAttribute('data-score-delta');
            if (mode && delta) {
                const name = mode === 'hybrid' ? 'Hybrid' : 'Heuristic';
                return delta === '1' ? ('給 ' + name + ' 臨時分數加 1。') : ('給 ' + name + ' 臨時分數減 1。');
            }
        }
        if (el.classList.contains('temp-score-value')) return '這一欄的臨時分數。';
        return '';
    }

    function isValue(el) {
        return el.classList.contains('digital-val')
            || el.classList.contains('ghost-handle-stat')
            || el.classList.contains('ghost-steer-alt')
            || el.classList.contains('ghost-steer-thr')
            || el.classList.contains('temp-score-value')
            || el.classList.contains('seat-bar')
            || el.id === 'sms-text-content'
            || el.id === 'ops-sms-text'
            || el.id === 'replay-status'
            || el.id === 'replay-director-badge'
            || el.id === 'arena-mode-status'
            || el.id === 'ghost-steer-alt'
            || el.id === 'ghost-steer-thr'
            || el.id === 'ops-val-heat'
            || el.id === 'ops-val-ap'
            || el.id === 'hud-val-heat'
            || el.id === 'hud-val-ap'
            || el.id === 'hud-tgt-alt'
            || el.id === 'hud-tgt-dist'
            || el.id === 'radio-subtitle'
            || el.id === 'radio-callsign';
    }

    function helpFor(el) {
        if (!el) return '';
        const explicit = el.getAttribute('data-help');
        const ops = el.getAttribute('data-ops');
        let base = explicit
            || (el.id && BY_ID[el.id])
            || (ops && (BY_OPS[ops] || (ops.indexOf('pylon-') === 0 ? '這個掛架。點一下選它，再按確認發射。' : '')))
            || byClass(el)
            || el.getAttribute('title')
            || el.getAttribute('aria-label')
            || '';
        if (!base) {
            const label = textOf(el);
            if (!label || label.length > 24) return '';
            const tag = (el.tagName || '').toLowerCase();
            if (tag === 'button') base = '按鈕「' + label + '」。';
            else if (tag === 'select') base = '選項「' + label + '」。';
            else return '';
        }
        if (isValue(el)) {
            const now = textOf(el);
            if (now && now.length <= 42 && base.indexOf(now) === -1) base += ' 目前：' + now + '。';
        }
        return base;
    }

    const SELECTOR = [
        'button',
        'select',
        'input',
        'textarea',
        '[data-ops]',
        '[role="button"]',
        '.digital-val',
        '.seat-bar',
        '.seat-pylons',
        '.seat-pylon-slot',
        '.pylon-switch-wrapper',
        '.pylon-stick',
        '.ghost-handle-stat',
        '.temp-score-value',
        '#ghost-steer-alt',
        '#ghost-steer-thr',
        '#sms-text-content',
        '#ops-sms-text',
        '#replay-status',
        '#replay-director-badge',
        '#arena-mode-status',
        '#hud-data-tag',
        '#radio-subtitle',
        '#radio-callsign',
        '.radio-tts-label'
    ].join(',');

    function targetOf(node) {
        if (!node || !node.closest) return null;
        const el = node.closest(SELECTOR);
        if (!el || el.id === TIP_ID) return null;
        if (el.closest && el.closest('#' + TIP_ID)) return null;
        const rects = el.getClientRects();
        if (!rects || !rects.length) return null;
        return el;
    }

    let timer = 0;
    let current = null;
    let stashedTitle = null;

    function restoreTitle() {
        if (current && stashedTitle != null && !current.getAttribute('title')) {
            current.setAttribute('title', stashedTitle);
        }
        stashedTitle = null;
    }

    function hide() {
        if (timer) clearTimeout(timer);
        timer = 0;
        restoreTitle();
        current = null;
        const tip = document.getElementById(TIP_ID);
        if (tip) {
            tip.hidden = true;
            tip.classList.remove('is-on');
            tip.textContent = '';
        }
    }

    function place(x, y) {
        const tip = tipEl();
        const pad = 14;
        const w = tip.offsetWidth || 180;
        const h = tip.offsetHeight || 36;
        let left = x + 16;
        let top = y + 18;
        const maxL = window.innerWidth - w - pad;
        const maxT = window.innerHeight - h - pad;
        if (left > maxL) left = Math.max(pad, x - w - 12);
        if (top > maxT) top = Math.max(pad, y - h - 12);
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    }

    function show(el, x, y) {
        if (current !== el) return;
        const text = helpFor(el);
        if (!text) {
            hide();
            return;
        }
        const tip = tipEl();
        tip.textContent = text;
        tip.hidden = false;
        tip.classList.add('is-on');
        place(x, y);
    }

    function hideTipOnly() {
        const tip = document.getElementById(TIP_ID);
        if (!tip) return;
        tip.hidden = true;
        tip.classList.remove('is-on');
        tip.textContent = '';
    }

    function arm(el, x, y) {
        if (timer) clearTimeout(timer);
        restoreTitle();
        hideTipOnly();
        current = el;
        const title = el.getAttribute('title');
        if (title) {
            stashedTitle = title;
            el.removeAttribute('title');
        } else {
            stashedTitle = null;
        }
        timer = setTimeout(() => show(el, x, y), DELAY_MS);
    }

    document.addEventListener('pointerover', (ev) => {
        if (ev.pointerType && ev.pointerType !== 'mouse') return;
        const el = targetOf(ev.target);
        if (!el) return;
        if (el === current) return;
        arm(el, ev.clientX, ev.clientY);
    }, true);

    document.addEventListener('pointerout', (ev) => {
        if (!current) return;
        const next = ev.relatedTarget;
        if (next && current.contains && current.contains(next)) return;
        const landed = targetOf(next);
        if (landed && landed === current) return;
        hide();
    }, true);

    document.addEventListener('pointermove', (ev) => {
        if (ev.pointerType && ev.pointerType !== 'mouse') return;
        const tip = document.getElementById(TIP_ID);
        if (!tip || tip.hidden || !current) return;
        place(ev.clientX, ev.clientY);
    }, true);

    document.addEventListener('pointerdown', () => hide(), true);
    window.addEventListener('scroll', () => hide(), true);
    window.addEventListener('blur', () => hide());

    root.AirArenaHoverHelp = {
        delayMs: DELAY_MS,
        helpFor,
        hide
    };
})(window);
