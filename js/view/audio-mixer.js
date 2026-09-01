// ============================================================================
// audio-mixer.js - Shared AudioContext: master / music / sfx / voice
// Unlock on first user gesture. Slider seek must stop voice + sfx.
// Voice lines use the system human TTS (speechSynthesis).
// ============================================================================
window.AirArenaAudio = (function () {
    let ctx = null;
    let master = null;
    let musicGain = null;
    let sfxGain = null;
    let voiceGain = null;
    let unlocked = false;
    let musicEl = null;
    let activeSfx = [];
    let activeVoice = [];
    let liveCount = 0;
    let pumpTimer = null;
    const pendingLines = [];
    const ttsUtters = [];

    const volumes = { master: 0.85, music: 0.35, sfx: 0.7, voice: 0.9 };

    function ensure() {
        if (ctx) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        musicGain = ctx.createGain();
        sfxGain = ctx.createGain();
        voiceGain = ctx.createGain();
        musicGain.connect(master);
        sfxGain.connect(master);
        voiceGain.connect(master);
        master.connect(ctx.destination);
        applyVolumes();
        return ctx;
    }

    function applyVolumes() {
        if (master) master.gain.value = volumes.master;
        if (musicGain) musicGain.gain.value = volumes.music;
        if (sfxGain) sfxGain.gain.value = volumes.sfx;
        if (voiceGain) voiceGain.gain.value = volumes.voice;
        if (musicEl) musicEl.volume = Math.max(0, Math.min(1, volumes.master * volumes.music));
    }

    function unlock() {
        ensure();
        unlocked = true;
        if (typeof window.speechSynthesis !== 'undefined') {
            try { window.speechSynthesis.getVoices(); } catch (e) { /* ignore */ }
        }
        if (ctx && ctx.state === 'suspended' && ctx.resume) {
            ctx.resume().catch(() => {});
        }
        return ctx;
    }

    function setVolume(bus, value) {
        const v = Math.max(0, Math.min(1, Number(value)));
        if (!Number.isFinite(v)) return;
        if (bus === 'master' || bus === 'music' || bus === 'sfx' || bus === 'voice') {
            volumes[bus] = v;
            applyVolumes();
        }
    }

    function dropVoice(src) {
        if (src) activeVoice = activeVoice.filter((n) => n !== src);
        liveCount = Math.max(0, liveCount - 1);
    }

    const VOICE_SET_IDS = ['rei', 'hawk', 'fox', 'ember', 'kite', 'nori'];
    const VOICE_SETS = {
        rei: { pitch: 1.08, rate: 1.04 },
        hawk: { pitch: 0.82, rate: 0.96 },
        fox: { pitch: 1.18, rate: 1.10 },
        ember: { pitch: 0.90, rate: 1.00 },
        kite: { pitch: 1.24, rate: 1.12 },
        nori: { pitch: 0.75, rate: 0.90 }
    };

    function voiceProfile(voiceSetId) {
        return VOICE_SETS[voiceSetId] || VOICE_SETS.rei;
    }

    function speakTextForVoice(str) {
        return String(str || '').replace(/[.。]+$/g, '');
    }

    function pickHumanVoice(voiceSetId) {
        if (typeof window.speechSynthesis === 'undefined') return null;
        const voices = window.speechSynthesis.getVoices() || [];
        if (!voices.length) return null;
        const en = voices.filter((v) => v && /^(en)([-_]|$)/i.test(v.lang || ''));
        const pool = en.length ? en : voices;
        const idx = Math.max(0, VOICE_SET_IDS.indexOf(voiceSetId));
        return pool[idx % pool.length] || pool[0] || null;
    }

    function dropUtter(u) {
        const i = ttsUtters.indexOf(u);
        if (i >= 0) ttsUtters.splice(i, 1);
    }

    function stopVoice() {
        pendingLines.length = 0;
        if (pumpTimer != null) {
            clearTimeout(pumpTimer);
            pumpTimer = null;
        }
        ttsUtters.length = 0;
        if (typeof window.speechSynthesis !== 'undefined') {
            try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
        }
        activeVoice.forEach((n) => {
            try { if (n.stop) n.stop(); } catch (e) { /* ignore */ }
        });
        activeVoice = [];
        liveCount = 0;
        activeSfx.forEach((n) => {
            try { if (n.stop) n.stop(); } catch (e) { /* ignore */ }
        });
        activeSfx = [];
    }

    function isVoiceSpeaking() {
        if (pendingLines.length > 0 || ttsUtters.length > 0) return true;
        if (liveCount > 0 || activeVoice.length > 0) return true;
        try {
            if (typeof window.speechSynthesis !== 'undefined'
                && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function waitForVoiceIdle(cb, timeoutMs) {
        const fn = typeof cb === 'function' ? cb : () => {};
        const cap = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 12000;
        const kick = () => {
            if (!isVoiceSpeaking()) {
                fn();
                return true;
            }
            return false;
        };
        if (kick()) return;
        const t0 = Date.now();
        const id = setInterval(() => {
            if (kick()) {
                clearInterval(id);
                return;
            }
            if (Date.now() - t0 >= cap) {
                clearInterval(id);
                fn();
            }
        }, 50);
    }

    function playPcm(pcm, sampleRate) {
        const ac = unlock();
        if (!ac || !voiceGain || !pcm || !pcm.length) return false;
        liveCount += 1;
        const run = () => {
            try {
                if (!ac || ac.state === 'suspended') {
                    dropVoice(null);
                    return;
                }
                const rate = ac.sampleRate || sampleRate || 22050;
                let data = pcm;
                if (Math.abs(rate - sampleRate) > 1) {
                    const n = Math.max(1, Math.ceil(pcm.length * rate / sampleRate));
                    data = new Float32Array(n);
                    const srcRate = sampleRate || 22050;
                    for (let i = 0; i < n; i++) {
                        const x = i * srcRate / rate;
                        const j = Math.min(pcm.length - 1, Math.floor(x));
                        const k = Math.min(pcm.length - 1, j + 1);
                        const f = x - j;
                        data[i] = pcm[j] * (1 - f) + pcm[k] * f;
                    }
                }
                const buf = ac.createBuffer(1, data.length, rate);
                buf.getChannelData(0).set(data);
                const src = ac.createBufferSource();
                src.buffer = buf;
                src.connect(voiceGain);
                activeVoice.push(src);
                src.onended = () => dropVoice(src);
                src.start();
            } catch (e) {
                dropVoice(null);
            }
        };
        if (ac.state === 'suspended' && ac.resume) {
            ac.resume().then(run).catch(() => dropVoice(null));
            return true;
        }
        run();
        return true;
    }

    function synthBusy() {
        if (ttsUtters.length > 0) return true;
        try {
            if (typeof window.speechSynthesis !== 'undefined'
                && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function overlayRadio(text) {
        const spoken = speakTextForVoice(text);
        if (!spoken) return false;
        const Voice = window.AirArenaRadioVoice;
        if (!Voice || typeof Voice.render !== 'function') return false;
        const pcm = Voice.render(spoken);
        if (!pcm || !pcm.length) return false;
        const quiet = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) quiet[i] = pcm[i] * 0.62;
        return playPcm(quiet, Voice.sampleRate || 22050);
    }

    function dispatchHuman(str, voiceSetId) {
        if (typeof window.speechSynthesis === 'undefined' || !window.SpeechSynthesisUtterance) {
            return false;
        }
        try {
            const spoken = speakTextForVoice(str);
            if (!spoken) return false;
            const u = new SpeechSynthesisUtterance(spoken);
            const prof = voiceProfile(voiceSetId);
            u.rate = Math.min(1.28, (prof.rate || 1) * 1.06);
            u.pitch = prof.pitch;
            u.volume = Math.max(0, Math.min(1, volumes.voice * volumes.master));
            const voice = pickHumanVoice(voiceSetId);
            if (voice) {
                try { u.voice = voice; } catch (e) { /* ignore */ }
                if (voice.lang) u.lang = voice.lang;
            }
            u.onend = () => dropUtter(u);
            u.onerror = () => dropUtter(u);
            ttsUtters.push(u);
            try { if (window.speechSynthesis.paused) window.speechSynthesis.resume(); } catch (e) { /* ignore */ }
            window.speechSynthesis.speak(u);
            return true;
        } catch (e) {
            return false;
        }
    }

    function pumpHuman() {
        pumpTimer = null;
        if (typeof window.speechSynthesis === 'undefined') {
            pendingLines.length = 0;
            return;
        }
        try { window.speechSynthesis.getVoices(); } catch (e) { /* ignore */ }
        try { if (window.speechSynthesis.paused) window.speechSynthesis.resume(); } catch (e) { /* ignore */ }
        if (!pendingLines.length) return;
        if (synthBusy()) {
            while (pendingLines.length) {
                const item = pendingLines.shift();
                if (!item) continue;
                const text = typeof item === 'string' ? item : item.text;
                if (!overlayRadio(text)) dispatchHuman(text, typeof item === 'string' ? undefined : item.voiceSetId);
            }
            return;
        }
        const batch = pendingLines.splice(0, pendingLines.length);
        const parts = [];
        let voiceSetId;
        batch.forEach((item) => {
            if (!item) return;
            const text = speakTextForVoice(typeof item === 'string' ? item : item.text);
            if (!text) return;
            parts.push(text);
            if (!voiceSetId && item && item.voiceSetId) voiceSetId = item.voiceSetId;
        });
        if (!parts.length) return;
        dispatchHuman(parts.join(', '), voiceSetId);
    }

    function speakTts(text, opts) {
        if (!text) return false;
        unlock();
        if (opts && opts.interrupt) stopVoice();
        const str = String(text);
        if (typeof window.speechSynthesis === 'undefined') return false;
        pendingLines.push({ text: str, voiceSetId: opts && opts.voiceSetId });
        if (opts && opts.immediate) {
            pumpHuman();
            return true;
        }
        if (pumpTimer == null) pumpTimer = setTimeout(pumpHuman, 0);
        return true;
    }

    function beepSfx(kind) {
        const ac = unlock();
        if (!ac || !sfxGain) return false;
        const play = () => {
            if (!ac || ac.state === 'suspended') return;
            const osc = ac.createOscillator();
            const g = ac.createGain();
            const now = ac.currentTime;
            const freq = kind === 'kill' ? 180 : (kind === 'missile' ? 420 : (kind === 'gun' ? 620 : 280));
            osc.frequency.setValueAtTime(freq, now);
            osc.type = kind === 'gun' ? 'square' : 'sawtooth';
            g.gain.setValueAtTime(0.0001, now);
            g.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
            g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
            osc.connect(g);
            g.connect(sfxGain);
            osc.start(now);
            osc.stop(now + 0.13);
            activeSfx.push(osc);
            osc.onended = () => {
                activeSfx = activeSfx.filter((n) => n !== osc);
            };
        };
        if (ac.state === 'suspended' && ac.resume) {
            ac.resume().then(play).catch(() => {});
            return true;
        }
        play();
        return true;
    }

    function playMusic(url) {
        unlock();
        if (!url) return false;
        if (!musicEl) {
            musicEl = new Audio();
            musicEl.loop = true;
        }
        if (musicEl.src !== url) musicEl.src = url;
        applyVolumes();
        const p = musicEl.play();
        if (p && p.catch) p.catch(() => {});
        return true;
    }

    function stopMusic() {
        if (musicEl) {
            try { musicEl.pause(); } catch (e) { /* ignore */ }
        }
    }

    function bindUnlockOnce() {
        const go = () => unlock();
        window.addEventListener('pointerdown', go, { once: true, capture: true });
        window.addEventListener('keydown', go, { once: true, capture: true });
    }

    if (typeof window !== 'undefined') bindUnlockOnce();

    return {
        unlock,
        setVolume,
        stopVoice,
        speakTts,
        isVoiceSpeaking,
        waitForVoiceIdle,
        beepSfx,
        playMusic,
        stopMusic,
        volumes,
        isUnlocked() { return unlocked; }
    };
})();
