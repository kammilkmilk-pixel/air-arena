// ============================================================================
// radio-cues.js - Frozen speech events for ACMI radio (not dump needles)
// Events: illuminate | fire_gun | fire_msl | fire_fox1 | break_left | break_right
//         | chaff_away | flare_away | urban_escape | kill | wingman_down
// ============================================================================
(function initRadioCues(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaRadioCues = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const EVENTS = Object.freeze([
        'illuminate',
        'fire_gun',
        'fire_msl',
        'fire_fox1',
        'break_left',
        'break_right',
        'chaff_away',
        'flare_away',
        'urban_escape',
        'kill',
        'wingman_down'
    ]);

    const TEXT = Object.freeze({
        illuminate: '{callsign}, Radar lock.',
        fire_gun: '{callsign}, Guns.',
        fire_msl: '{callsign}, Fox 2.',
        fire_fox1: '{callsign}, Fox 1.',
        break_left: '{callsign}, Break left.',
        break_right: '{callsign}, Break right.',
        chaff_away: '{callsign}, Chaff away.',
        flare_away: '{callsign}, Flare away.',
        urban_escape: '',
        kill: '{callsign}, Splash.',
        wingman_down: '{callsign}, Wingman down.'
    });

    const URBAN_RE = /urban|escape|obstacleEmergency|building-escaping|urbanRoute|chaff while building|flare while building/i;

    function factionOf(teamId) {
        if (typeof GameContext !== 'undefined' && GameContext.getFaction) {
            return GameContext.getFaction(teamId);
        }
        const s = String(teamId || '');
        if (s.indexOf('blue') === 0) return 'blue';
        if (s.indexOf('red') === 0) return 'red';
        return null;
    }

    function callsignOf(teamId, teams) {
        const t = teams && teams[teamId];
        if (t && t.callsign) return String(t.callsign);
        if (typeof AirArenaPilotRoster !== 'undefined' && AirArenaPilotRoster.callsignForTeam) {
            return AirArenaPilotRoster.callsignForTeam(t || { id: teamId });
        }
        return String(teamId || 'UNKNOWN').toUpperCase();
    }

    function textFor(event, callsign) {
        const tpl = TEXT[event];
        if (!tpl) return '';
        return tpl.replace(/\{callsign\}/g, callsign || 'UNKNOWN');
    }

    function isUrbanEscapeAction(action) {
        if (!action) return false;
        const blob = `${action.state || ''} ${action.reason || ''}`;
        return URBAN_RE.test(blob);
    }

    function chainFire(team) {
        const chain = team && team.chain;
        if (!chain || !chain.length) return null;
        return chain[0] && chain[0].fire ? String(chain[0].fire) : null;
    }

    function hasFox1Commit(team) {
        const pylons = (team && team.pylons) || [];
        return pylons.some((p) => {
            const typ = p && (p.weaponType || p.weapon);
            const st = p && p.state;
            return typ === 'fox1' && (st === 'armed' || st === 'powering' || st === 'empty');
        });
    }

    function isIlluminating(team) {
        const st = String((team && team.aiLastAction && team.aiLastAction.state) || '');
        if (/fox1Illuminate/i.test(st)) return true;
        const pylons = (team && team.pylons) || [];
        return pylons.some((p) => {
            const typ = p && (p.weaponType || p.weapon);
            const pst = p && p.state;
            return typ === 'fox1' && (pst === 'armed' || pst === 'powering');
        });
    }

    function missileLaunchInfo(team) {
        let launch = 0;
        let type = null;
        const list = (team && team.activeMissiles) || [];
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (!m) continue;
            const ls = Number(m.launchStep);
            if (!Number.isFinite(ls)) continue;
            if (ls >= launch) {
                launch = ls;
                type = m.missileType || type;
            }
        }
        if (!type && hasFox1Commit(team)) type = 'fox1';
        return { launch, type: type || 'fox2' };
    }

    function breakSideOf(action) {
        if (!action) return null;
        const st = String(action.state || '');
        if (st === 'safetyBreakLeft') return 'left';
        if (st === 'safetyBreakRight') return 'right';
        if (!/^(mergeBreak|mandatoryMergeBreak|fox1IlluminateBreak)$/.test(st)) return null;
        const x = Number(action.joyX);
        if (!Number.isFinite(x) || Math.abs(x) < 0.35) return null;
        return x < 0 ? 'left' : 'right';
    }

    function firstDropStep(track, teamId, ageKey, maxNewAge) {
        if (!Array.isArray(track)) return 0;
        const cap = Number.isFinite(Number(maxNewAge)) ? Number(maxNewAge) : 2;
        for (let s = 0; s < track.length; s++) {
            const list = track[s] || [];
            for (let i = 0; i < list.length; i++) {
                const item = list[i];
                if (!item || item.teamId !== teamId) continue;
                const age = Number(item[ageKey]) || 0;
                if (age <= cap) return s;
            }
        }
        return 0;
    }

    function droppedFlareThisTurn(team, log, id) {
        if (team && team.wasFlaresArmedThisTurn) return true;
        const block = log && log[id];
        return !!(block && block.wasFlaresArmed);
    }

    function droppedChaffThisTurn(team, log, id) {
        if (team && team.wasChaffArmedThisTurn) return true;
        const block = log && log[id];
        return !!(block && block.wasChaffArmed);
    }

    function pushCue(cues, seen, cue) {
        if (!cue || EVENTS.indexOf(cue.event) < 0) return;
        const key = `${cue.speakerSeatId}|${cue.event}`;
        if (seen[key] != null && seen[key] <= cue.step) return;
        const next = {
            step: Math.max(0, Number(cue.step) || 0),
            speakerSeatId: String(cue.speakerSeatId),
            callsign: String(cue.callsign || cue.speakerSeatId).toUpperCase(),
            event: cue.event,
            textKey: `radio.${cue.event}`
        };
        if (seen[key] != null) {
            const idx = cues.findIndex((c) => c.speakerSeatId === next.speakerSeatId && c.event === next.event);
            if (idx >= 0) cues.splice(idx, 1);
        }
        seen[key] = next.step;
        cues.push(next);
    }

    /**
     * Build sparse radioCues for one settled turn log.
     * Combat events come from the log; urban_escape may read team.aiLastAction.
     */
    function buildFromTurn(log, opts) {
        const teams = (opts && opts.teams) || {};
        const ids = (opts && opts.activeIds)
            || (typeof GameContext !== 'undefined' && GameContext.getActiveMatchIds
                ? GameContext.getActiveMatchIds()
                : Object.keys(teams));
        const cues = [];
        const seen = {};
        const steps = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? CONFIG.rules.stepsPerTurn
            : 100;

        ids.forEach((id) => {
            const t = teams[id];
            if (!t || t.matchActive === false) return;
            const cs = callsignOf(id, teams);
            const fire = chainFire(t);
            const launchInfo = missileLaunchInfo(t);
            const fox1Shot = fire === 'missile' && launchInfo.type === 'fox1';
            if (isIlluminating(t) || fox1Shot) {
                const illumStep = fox1Shot ? Math.max(0, launchInfo.launch - 10) : 0;
                pushCue(cues, seen, { step: illumStep, speakerSeatId: id, callsign: cs, event: 'illuminate' });
            }
            if (fire === 'gun') {
                pushCue(cues, seen, { step: 0, speakerSeatId: id, callsign: cs, event: 'fire_gun' });
            }
            if (fire === 'missile') {
                pushCue(cues, seen, {
                    step: launchInfo.launch,
                    speakerSeatId: id,
                    callsign: cs,
                    event: fox1Shot ? 'fire_fox1' : 'fire_msl'
                });
            }
            const side = breakSideOf(t.aiLastAction);
            if (side) {
                pushCue(cues, seen, {
                    step: 0,
                    speakerSeatId: id,
                    callsign: cs,
                    event: side === 'left' ? 'break_left' : 'break_right'
                });
            }
            if (droppedFlareThisTurn(t, log, id)) {
                pushCue(cues, seen, {
                    step: firstDropStep(log && log.flaresTrack, id, 'age', 0),
                    speakerSeatId: id,
                    callsign: cs,
                    event: 'flare_away'
                });
            }
            if (droppedChaffThisTurn(t, log, id)) {
                pushCue(cues, seen, {
                    step: firstDropStep(log && log.chaffTrack, id, 'ageSteps', 4) || 4,
                    speakerSeatId: id,
                    callsign: cs,
                    event: 'chaff_away'
                });
            }
            if (isUrbanEscapeAction(t.aiLastAction)) {
                // silenced — no "urban area" radio call
            }
        });

        const killedBy = (log && log.killedBy) || {};
        const damageFrom = (log && log.damageFrom) || {};
        const destroyed = (log && log.destroyed) || {};
        ids.forEach((victimId) => {
            if (!destroyed[victimId] && !killedBy[victimId] && !damageFrom[victimId]) return;
            const hit = killedBy[victimId] || damageFrom[victimId] || {};
            const step = Number.isFinite(Number(hit.step)) ? Number(hit.step) : Math.floor(steps * 0.55);
            const attackerId = hit.attackerId;
            if (attackerId && ids.indexOf(attackerId) >= 0 && attackerId !== victimId) {
                pushCue(cues, seen, {
                    step,
                    speakerSeatId: attackerId,
                    callsign: callsignOf(attackerId, teams),
                    event: 'kill'
                });
            }
            const fac = factionOf(victimId);
            ids.forEach((allyId) => {
                if (allyId === victimId) return;
                if (factionOf(allyId) !== fac) return;
                const ally = teams[allyId];
                if (!ally || ally.matchActive === false) return;
                if (destroyed[allyId]) return;
                pushCue(cues, seen, {
                    step: Math.min(steps, step + 4),
                    speakerSeatId: allyId,
                    callsign: callsignOf(allyId, teams),
                    event: 'wingman_down'
                });
            });
        });

        cues.sort((a, b) => a.step - b.step || String(a.speakerSeatId).localeCompare(b.speakerSeatId));
        return cues;
    }

    function cuesBetween(cues, fromExclusive, toInclusive) {
        const list = Array.isArray(cues) ? cues : [];
        const lo = Number.isFinite(Number(fromExclusive)) ? Number(fromExclusive) : -1;
        const hi = Number.isFinite(Number(toInclusive)) ? Number(toInclusive) : lo;
        return list.filter((c) => {
            if (!c) return false;
            const st = Number(c.step) || 0;
            return st > lo && st <= hi;
        });
    }

    function cueAtStep(cues, step, holdSteps) {
        const list = Array.isArray(cues) ? cues : [];
        const s = Number(step) || 0;
        const hold = Number.isFinite(Number(holdSteps)) ? Number(holdSteps) : 22;
        let best = null;
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            if (!c || c.step > s) break;
            if (s - c.step <= hold) best = c;
        }
        return best;
    }

    function cuesBySeatAtStep(cues, step, holdSteps) {
        const list = Array.isArray(cues) ? cues : [];
        const s = Number(step) || 0;
        const hold = Number.isFinite(Number(holdSteps)) ? Number(holdSteps) : 22;
        const map = Object.create(null);
        for (let i = 0; i < list.length; i++) {
            const c = list[i];
            if (!c) continue;
            const st = Number(c.step) || 0;
            if (st > s || (s - st) > hold) continue;
            const id = c.speakerSeatId;
            if (!id) continue;
            const prev = map[id];
            if (!prev || st >= (Number(prev.step) || 0)) map[id] = c;
        }
        return map;
    }

    function formatCue(cue) {
        if (!cue) return '';
        return textFor(cue.event, cue.callsign);
    }

    return {
        EVENTS,
        TEXT,
        buildFromTurn,
        cueAtStep,
        cuesBySeatAtStep,
        cuesBetween,
        formatCue,
        textFor,
        isUrbanEscapeAction
    };
});
