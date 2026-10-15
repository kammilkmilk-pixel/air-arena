// ============================================================================
// radio-hud.js - 2D bust + comms lamp + subtitle, synced to ACMI step
// TTS fires once when the timeline advances onto a cue — never on frozen frames.
// ============================================================================
window.AirArenaRadioHud = (function () {
    let lastKey = '';
    let lastStep = -1;
    let lastCue = null;
    let lastBySeat = Object.create(null);
    let ttsEnabled = false;
    const AUDIO_PREF_KEY = 'airArenaRadioAudio';
    let scrubbing = false;
    const spokenKeys = Object.create(null);

    function els() {
        return {
            root: document.getElementById('radio-hud'),
            bust: document.getElementById('radio-bust'),
            lamp: document.getElementById('radio-lamp'),
            callsign: document.getElementById('radio-callsign'),
            sub: document.getElementById('radio-subtitle')
        };
    }

    function setTtsEnabled(on) {
        ttsEnabled = !!on;
        try { localStorage.setItem(AUDIO_PREF_KEY, ttsEnabled ? '1' : '0'); } catch (e) { /* ignore */ }
    }

    function ttsOn() {
        const el = document.getElementById('radio-tts-toggle');
        if (el) return !!el.checked;
        return false;
    }

    function isScrubbing() {
        return scrubbing;
    }

    function cueKey(cue) {
        return `${cue.step}|${cue.speakerSeatId}|${cue.event}`;
    }

    function hideVisual() {
        const speaking = !!(window.AirArenaAudio && AirArenaAudio.isVoiceSpeaking && AirArenaAudio.isVoiceSpeaking());
        if (speaking && lastCue) return;
        const e = els();
        if (e.root) e.root.classList.remove('is-live');
        if (e.lamp) e.lamp.classList.remove('is-on');
        if (e.callsign) e.callsign.textContent = 'RADIO';
        if (e.sub) e.sub.textContent = '電台待命';
        lastCue = null;
        lastKey = '';
    }

    function hide(opts) {
        hideVisual();
        if (opts && opts.stopVoice && window.AirArenaAudio && AirArenaAudio.stopVoice) {
            AirArenaAudio.stopVoice();
        }
        if (opts && opts.resetSpoken) {
            Object.keys(spokenKeys).forEach((k) => { delete spokenKeys[k]; });
        }
        lastBySeat = Object.create(null);
    }

    function formatLine(cue) {
        if (typeof AirArenaRadioCues !== 'undefined' && AirArenaRadioCues.formatCue) {
            return AirArenaRadioCues.formatCue(cue);
        }
        return cue ? `${cue.callsign}: ${cue.event}` : '';
    }

    function paintCue(cue, extraLines) {
        const e = els();
        if (!e.root || !cue) {
            hideVisual();
            return '';
        }
        const text = formatLine(cue);
        const color = (typeof AirArenaPilotRoster !== 'undefined' && AirArenaPilotRoster.portraitColor)
            ? AirArenaPilotRoster.portraitColor(cue.speakerSeatId && (typeof teams !== 'undefined' ? teams[cue.speakerSeatId] : null) || cue)
            : '#888';
        const team = (typeof teams !== 'undefined' && cue.speakerSeatId) ? teams[cue.speakerSeatId] : null;
        const bustColor = (team && team.portraitColor)
            || (typeof AirArenaPilotRoster !== 'undefined' && team && AirArenaPilotRoster.portraitColor(team))
            || color;

        e.root.classList.add('is-live');
        if (e.lamp) e.lamp.classList.add('is-on');
        if (e.callsign) {
            const names = extraLines && extraLines.length
                ? extraLines.map((c) => c.callsign).filter(Boolean)
                : [cue.callsign];
            e.callsign.textContent = names.join(' · ');
        }
        if (e.sub) {
            e.sub.textContent = extraLines && extraLines.length > 1
                ? extraLines.map(formatLine).join('\n')
                : text;
        }
        if (e.bust) {
            e.bust.style.background = bustColor;
            e.bust.textContent = String(cue.callsign || '?').slice(0, 2);
        }
        lastCue = cue;
        lastKey = cueKey(cue);
        return text;
    }

    function voiceSetOf(cue) {
        const team = (typeof teams !== 'undefined' && cue && cue.speakerSeatId) ? teams[cue.speakerSeatId] : null;
        if (team && team.voiceSetId) return team.voiceSetId;
        if (typeof AirArenaPilotRoster !== 'undefined' && AirArenaPilotRoster.get && team && team.pilotId) {
            const p = AirArenaPilotRoster.get(team.pilotId);
            if (p && p.voiceSetId) return p.voiceSetId;
        }
        return (team && team.pilotId) || 'rei';
    }

    function fireVoice(cue) {
        if (!cue) return;
        const key = cueKey(cue);
        if (spokenKeys[key]) return;
        spokenKeys[key] = 1;
        const text = formatLine(cue);
        if (!text) return;
        if (!ttsOn()) return;
        if (window.AirArenaAudio && AirArenaAudio.speakTts) {
            AirArenaAudio.speakTts(text, { voiceSetId: voiceSetOf(cue) });
        }
        if (window.AirArenaAudio && AirArenaAudio.beepSfx) {
            const kind = cue.event === 'fire_gun' ? 'gun'
                : (cue.event === 'fire_msl' || cue.event === 'fire_fox1' || cue.event === 'illuminate' ? 'missile'
                    : (cue.event === 'kill' || cue.event === 'wingman_down' ? 'kill' : 'tone'));
            AirArenaAudio.beepSfx(kind);
        }
    }

    function showCue(cue, opts) {
        const seeking = !!(opts && opts.seek) || scrubbing;
        const text = paintCue(cue);
        if (!cue || seeking) {
            if (seeking && window.AirArenaAudio && AirArenaAudio.stopVoice) AirArenaAudio.stopVoice();
            return;
        }
        fireVoice(cue);
    }

    function sync(step, cues, opts) {
        const s = Number(step) || 0;
        const seeking = !!(opts && opts.seek) || scrubbing;

        let from = lastStep;
        if (s + 1 < lastStep) {
            from = -1;
            Object.keys(spokenKeys).forEach((k) => { delete spokenKeys[k]; });
        } else if (seeking) {
            Object.keys(spokenKeys).forEach((k) => { delete spokenKeys[k]; });
        }
        const timeMoving = from < 0 || s > from;

        const hold = (opts && opts.holdSteps) || 22;
        const display = (typeof AirArenaRadioCues !== 'undefined' && AirArenaRadioCues.cueAtStep)
            ? AirArenaRadioCues.cueAtStep(cues, s, hold)
            : null;
        const batch = (!seeking && timeMoving && typeof AirArenaRadioCues !== 'undefined' && AirArenaRadioCues.cuesBetween)
            ? AirArenaRadioCues.cuesBetween(cues, from, s)
            : [];

        if (batch.length) batch.forEach((c) => fireVoice(c));

        if (display) {
            paintCue(display, batch.length > 1 ? batch : null);
        } else if (batch.length) {
            paintCue(batch[batch.length - 1], batch.length > 1 ? batch : null);
        } else if (window.AirArenaAudio && AirArenaAudio.isVoiceSpeaking && AirArenaAudio.isVoiceSpeaking() && lastCue) {
            paintCue(lastCue);
        } else {
            hideVisual();
        }
        if (typeof AirArenaRadioCues !== 'undefined' && AirArenaRadioCues.cuesBySeatAtStep) {
            lastBySeat = AirArenaRadioCues.cuesBySeatAtStep(cues, s, hold) || Object.create(null);
        } else {
            lastBySeat = Object.create(null);
        }
        if (lastCue && lastCue.speakerSeatId && !lastBySeat[lastCue.speakerSeatId]) {
            lastBySeat[lastCue.speakerSeatId] = lastCue;
        }
        lastStep = s;
        return display || (batch.length ? batch[batch.length - 1] : null);
    }

    function cueForSeat(seatId) {
        if (!seatId || !lastBySeat) return null;
        return lastBySeat[seatId] || null;
    }

    function bindTtsToggle() {
        const el = document.getElementById('radio-tts-toggle');
        if (!el) return;
        let on = false;
        try { on = localStorage.getItem(AUDIO_PREF_KEY) === '1'; } catch (e) { /* ignore */ }
        el.checked = on;
        setTtsEnabled(on);
        el.addEventListener('change', () => setTtsEnabled(el.checked));
        const preview = document.getElementById('radio-preview-btn');
        if (preview) {
            preview.addEventListener('click', () => {
                if (window.AirArenaAudio && AirArenaAudio.unlock) AirArenaAudio.unlock();
                const sample = (typeof AirArenaRadioCues !== 'undefined' && AirArenaRadioCues.formatCue)
                    ? AirArenaRadioCues.formatCue({ event: 'fire_gun', callsign: 'NORI' })
                    : 'NORI, Guns.';
                const e = els();
                if (e.callsign) e.callsign.textContent = 'NORI';
                if (e.sub) e.sub.textContent = sample;
                if (e.root) e.root.classList.add('is-live');
                if (window.AirArenaAudio && AirArenaAudio.speakTts) {
                    AirArenaAudio.speakTts(sample, { immediate: true, voiceSetId: 'nori' });
                }
                if (window.AirArenaAudio && AirArenaAudio.beepSfx) AirArenaAudio.beepSfx('gun');
            });
        }
    }

    function bindScrub() {
        const sld = document.getElementById('replay-slider');
        if (!sld) return;
        const on = (e) => { if (e && e.isTrusted) scrubbing = true; };
        const off = () => { scrubbing = false; };
        sld.addEventListener('pointerdown', on);
        sld.addEventListener('input', on);
        window.addEventListener('pointerup', off);
        window.addEventListener('pointercancel', off);
    }

    if (typeof document !== 'undefined') {
        const boot = () => {
            bindTtsToggle();
            bindScrub();
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot);
        } else {
            boot();
        }
    }

    return { sync, hide, showCue, cueForSeat, setTtsEnabled, ttsOn, isScrubbing };
})();
