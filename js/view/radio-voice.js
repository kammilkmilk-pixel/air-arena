// ============================================================================
// radio-voice.js - English formant TTS through Web Audio (not speechSynthesis)
// ============================================================================
window.AirArenaRadioVoice = (function () {
    const SR = 22050;
    const LEX = {
        a: 'AH', aircraft: 'EH R K R AE F T', area: 'EH R IY AH', away: 'AH W EY',
        breaking: 'B R EY K IH NG', down: 'D AW N', egressing: 'IH G R EH S IH NG',
        fire: 'F AY ER', fox: 'F AA K S', friendly: 'F R EH N D L IY',
        guns: 'G AH N Z', illuminating: 'IH L UW M IH N EY T IH NG',
        is: 'IH Z', left: 'L EH F T', lock: 'L AA K', missile: 'M IH S AH L', off: 'AO F',
        one: 'W AH N', opening: 'OW P AH N IH NG', radar: 'R EY D AA R', right: 'R AY T',
        splash: 'S P L AE SH', target: 'T AA R G IH T', the: 'DH AH',
        two: 'T UW', urban: 'ER B AH N', wingman: 'W IH NG M AE N',
        break: 'B R EY K', chaff: 'CH AE F', flare: 'F L EH R',
        hawk: 'HH AO K', ember: 'EH M B ER', rei: 'R EY',
        kite: 'K AY T', nori: 'N AO R IY'
    };
    const LETTER = {
        a: 'EY', b: 'B IY', c: 'S IY', d: 'D IY', e: 'IY', f: 'EH F', g: 'JH IY',
        h: 'EY CH', i: 'AY', j: 'JH EY', k: 'K EY', l: 'EH L', m: 'EH M', n: 'EH N',
        o: 'OW', p: 'P IY', q: 'K Y UW', r: 'AA R', s: 'EH S', t: 'T IY',
        u: 'Y UW', v: 'V IY', w: 'D AH B AH L Y UW', x: 'EH K S', y: 'W AY', z: 'Z IY'
    };
    const P = {
        IY: [270, 2290, 3010, 90], IH: [390, 1990, 2550, 70], EH: [530, 1840, 2480, 80],
        AE: [660, 1720, 2410, 90], AA: [730, 1090, 2440, 90], AO: [570, 840, 2410, 90],
        UH: [440, 1020, 2240, 70], UW: [300, 870, 2240, 90], ER: [490, 1350, 1690, 100],
        AH: [520, 1190, 2390, 70], AX: [500, 1400, 2300, 60],
        EY: [480, 1720, 2500, 110], AY: [660, 1200, 2400, 120], OW: [570, 840, 2410, 110],
        OY: [550, 900, 2300, 120], AW: [660, 1200, 2400, 120],
        L: [420, 1040, 2500, 70], R: [490, 1350, 1690, 70], W: [300, 610, 2200, 60],
        Y: [300, 2200, 3000, 60], M: [360, 1170, 2200, 70], N: [270, 1400, 2500, 70],
        NG: [280, 2300, 2600, 80],
        P: [400, 1100, 2300, 50], B: [400, 1100, 2300, 55], T: [400, 1700, 2600, 45],
        D: [400, 1700, 2600, 50], K: [400, 2300, 3000, 50], G: [400, 2000, 2800, 55],
        F: [400, 1400, 2700, 70], V: [400, 1400, 2700, 70], TH: [400, 1800, 2800, 70],
        DH: [400, 1800, 2800, 70], S: [400, 2000, 3000, 80], Z: [400, 2000, 3000, 80],
        SH: [400, 1800, 2200, 90], ZH: [400, 1800, 2200, 90], HH: [400, 1400, 2500, 50],
        CH: [400, 1800, 2600, 70], JH: [400, 1800, 2600, 70],
        PAUSE: [0, 0, 0, 80]
    };
    const UNVOICED = { P: 1, T: 1, K: 1, F: 1, TH: 1, S: 1, SH: 1, HH: 1, CH: 1 };
    const STOP = { P: 1, B: 1, T: 1, D: 1, K: 1, G: 1, CH: 1, JH: 1 };

    function makeRes(freq, bw) {
        if (freq <= 0) return function () { return 0; };
        const r = Math.exp(-Math.PI * bw / SR);
        const a1 = 2 * r * Math.cos(2 * Math.PI * freq / SR);
        const a2 = -r * r;
        let y1 = 0;
        let y2 = 0;
        return function (x) {
            const y = x + a1 * y1 + a2 * y2;
            y2 = y1;
            y1 = y;
            return y;
        };
    }

    function phonesForToken(raw) {
        const w = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!w) return [];
        if (LEX[w]) return LEX[w].split(/\s+/);
        if (w.length <= 2) {
            return w.split('').reduce((acc, ch) => acc.concat((LETTER[ch] || 'AH').split(/\s+/)), []);
        }
        const naive = [];
        for (let i = 0; i < w.length; i++) {
            const a = w[i];
            const b = w[i + 1] || '';
            if (a === 'c' && b === 'h') { naive.push('CH'); i++; continue; }
            if (a === 's' && b === 'h') { naive.push('SH'); i++; continue; }
            if (a === 't' && b === 'h') { naive.push('TH'); i++; continue; }
            if (a === 'n' && b === 'g') { naive.push('NG'); i++; continue; }
            if ('aeiou'.indexOf(a) >= 0) {
                naive.push(a === 'a' ? 'AE' : a === 'e' ? 'EH' : a === 'i' ? 'IH' : a === 'o' ? 'AO' : 'UW');
                continue;
            }
            const map = {
                b: 'B', c: 'K', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'JH', k: 'K', l: 'L',
                m: 'M', n: 'N', p: 'P', q: 'K', r: 'R', s: 'S', t: 'T', v: 'V', w: 'W',
                x: 'K', y: 'Y', z: 'Z'
            };
            naive.push(map[a] || 'AH');
        }
        return naive;
    }

    function tokenize(text) {
        const out = [];
        String(text || '').split(/(\s+|[.,!?])/).forEach((tok) => {
            if (!tok || /^\s+$/.test(tok)) {
                if (tok) out.push('PAUSE');
                return;
            }
            if (/[.,!?]/.test(tok)) {
                out.push('PAUSE');
                return;
            }
            phonesForToken(tok).forEach((p) => out.push(p));
        });
        return out;
    }

    function render(text) {
        const phones = tokenize(text);
        if (!phones.length) return null;
        let total = 0;
        const segs = phones.map((name) => {
            const spec = P[name] || P.AH;
            const dur = (STOP[name] ? spec[3] * 0.7 : spec[3]) / 1000;
            total += dur;
            return { name, spec, dur, voiced: !UNVOICED[name] && name !== 'PAUSE' };
        });
        const n = Math.max(1, Math.floor(total * SR));
        const pcm = new Float32Array(n);
        const f0 = 118;
        const period = SR / f0;
        let idx = 0;
        let phase = 0;
        segs.forEach((seg) => {
            const len = Math.max(1, Math.floor(seg.dur * SR));
            const r1 = makeRes(seg.spec[0], 90);
            const r2 = makeRes(seg.spec[1], 110);
            const r3 = makeRes(seg.spec[2], 140);
            for (let i = 0; i < len && idx < n; i++, idx++) {
                let src = 0;
                if (seg.name === 'PAUSE') {
                    src = 0;
                } else if (seg.voiced) {
                    phase++;
                    if (phase >= period) {
                        phase -= period;
                        src = 0.9;
                    } else {
                        src = 0.02;
                    }
                } else {
                    src = (Math.random() * 2 - 1) * 0.35;
                }
                const env = Math.min(1, i / 40, (len - i) / 50);
                const y = r3(r2(r1(src)));
                pcm[idx] = y * env;
            }
        });
        let peak = 0;
        for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm[i]));
        if (peak > 0.0001) {
            const g = 0.55 / peak;
            for (let i = 0; i < n; i++) pcm[i] *= g;
        }
        return pcm;
    }

    return { render, sampleRate: SR };
})();
