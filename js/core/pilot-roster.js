// ============================================================================
// pilot-roster.js - Callsign / portrait / voiceSet (presentation only; not decide)
// ============================================================================
(function initPilotRoster(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaPilotRoster = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const STORAGE_KEY = 'airArenaPilotPicks';

    const DEFAULTS = [
        { id: 'rei', callsign: 'REI', portrait: null, voiceSetId: 'rei', color: '#7ec8e3' },
        { id: 'hawk', callsign: 'HAWK', portrait: null, voiceSetId: 'hawk', color: '#e8b86d' },
        { id: 'fox', callsign: 'FOX', portrait: null, voiceSetId: 'fox', color: '#d4a0ff' },
        { id: 'ember', callsign: 'EMBER', portrait: null, voiceSetId: 'ember', color: '#ff7a6e' },
        { id: 'kite', callsign: 'KITE', portrait: null, voiceSetId: 'kite', color: '#8fd4a8' },
        { id: 'nori', callsign: 'NORI', portrait: null, voiceSetId: 'nori', color: '#c5d0dc' }
    ];

    const PLAYER_PILOT_ID = 'nori';
    const AI_PILOT_IDS = ['rei', 'hawk', 'fox', 'kite'];

    const SEAT_DEFAULT = {
        'red-1': 'rei',
        'red-2': 'hawk',
        'blue-1': 'fox',
        'blue-2': 'ember'
    };

    const CATALOG_SEAT_DEFAULT = {
        'red-1': 'rei',
        'red-2': 'hawk',
        'blue-1': 'fox',
        'blue-2': 'kite'
    };

    let extra = [];

    function list() {
        const byId = {};
        DEFAULTS.concat(extra).forEach((p) => {
            if (p && p.id) byId[p.id] = p;
        });
        return Object.keys(byId).map((k) => byId[k]);
    }

    function get(id) {
        if (id === 'random' || !id) return null;
        return list().find((p) => p.id === id) || null;
    }

    function hashSeed(str) {
        let h = 2166136261;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function pickRandom(used, seedKey) {
        const pool = list().filter((p) => used.indexOf(p.id) < 0);
        const src = pool.length ? pool : list();
        const idx = hashSeed(seedKey || String(Date.now())) % src.length;
        return src[idx];
    }

    function resolveSeatPilotId(seatId, requested, used, seedKey) {
        if (requested && requested !== 'random' && get(requested) && used.indexOf(requested) < 0) {
            return requested;
        }
        const fallback = SEAT_DEFAULT[seatId];
        if (fallback && used.indexOf(fallback) < 0 && get(fallback)) return fallback;
        const picked = pickRandom(used, seedKey || seatId);
        return picked ? picked.id : 'rei';
    }

    function callsignForTeam(team) {
        if (team && team.callsign) return String(team.callsign);
        const p = team && team.pilotId ? get(team.pilotId) : null;
        if (p) return p.callsign;
        return team && team.id ? String(team.id).toUpperCase() : 'UNKNOWN';
    }

    function portraitColor(teamOrId) {
        const id = typeof teamOrId === 'string' ? teamOrId : (teamOrId && teamOrId.pilotId);
        const p = get(id);
        return (p && p.color) || '#888888';
    }

    function applyToTeam(team, pilotId) {
        if (!team) return null;
        const p = get(pilotId) || get('rei');
        team.pilotId = p.id;
        team.callsign = p.callsign;
        team.voiceSetId = p.voiceSetId;
        team.portraitColor = p.color;
        return p;
    }

    function assignCatalogPilots(seats, seatIds) {
        const ids = Array.isArray(seatIds) && seatIds.length
            ? seatIds
            : ['red-1', 'red-2', 'blue-1', 'blue-2'];
        const used = [];
        ids.forEach((sid) => {
            const seat = seats && seats[sid];
            if (!seat) return;
            if (seat.control === 'human') {
                seat.pilotId = PLAYER_PILOT_ID;
                return;
            }
            const preferred = CATALOG_SEAT_DEFAULT[sid];
            const pick = (preferred && AI_PILOT_IDS.indexOf(preferred) >= 0 && used.indexOf(preferred) < 0)
                ? preferred
                : (AI_PILOT_IDS.find((id) => used.indexOf(id) < 0) || AI_PILOT_IDS[0]);
            seat.pilotId = pick;
            used.push(pick);
        });
        return seats;
    }

    function applyControlVoice(team, isHuman, others) {
        if (!team) return null;
        if (isHuman) return applyToTeam(team, PLAYER_PILOT_ID);
        const used = (others || [])
            .filter((o) => o && o !== team)
            .map((o) => o.pilotId)
            .filter(Boolean);
        const keep = team.pilotId
            && team.pilotId !== PLAYER_PILOT_ID
            && used.indexOf(team.pilotId) < 0
            && get(team.pilotId);
        if (keep) return applyToTeam(team, team.pilotId);
        const pool = AI_PILOT_IDS.concat(['ember']);
        const pick = pool.find((id) => used.indexOf(id) < 0) || AI_PILOT_IDS[0];
        return applyToTeam(team, pick);
    }

    function readPicks() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function writePicks(picks) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(picks || {}));
        } catch (e) { /* ignore */ }
    }

    return {
        DEFAULTS,
        SEAT_DEFAULT,
        PLAYER_PILOT_ID,
        AI_PILOT_IDS,
        list,
        get,
        pickRandom,
        resolveSeatPilotId,
        assignCatalogPilots,
        applyControlVoice,
        callsignForTeam,
        portraitColor,
        applyToTeam,
        readPicks,
        writePicks
    };
});
