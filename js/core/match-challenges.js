// ============================================================================
// match-challenges.js - Thin catalog: map + mode + win hint (not a campaign)
// ============================================================================
(function initMatchChallenges(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaChallenges = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const BUILTIN = [
        {
            id: 'lab',
            name: '測試',
            hint: '原本 Match Setup：人工／Rei_03（對照）／test_01（現行）。供 AI A/B，不改挑戰規則。',
            mapId: null,
            mode: null,
            win: null,
            lab: true
        },
        {
            id: 'skirmish',
            name: '自由交戰',
            hint: '自選地圖與模式，無額外勝負條件。',
            mapId: null,
            mode: null,
            win: null
        },
        {
            id: 'city-1v1',
            name: '城區單挑',
            hint: '1v1 · 原版／城區圖 · 擊墜對方。',
            mapId: 'original',
            mode: '1v1',
            win: 'faction-wipe'
        },
        {
            id: 'city-2v2',
            name: '城區 2v2',
            hint: '2v2 · 城區 · 陣營全滅。',
            mapId: 'citymap',
            mode: '2v2',
            win: 'faction-wipe'
        },
        {
            id: 'survive-t80',
            name: '存活挑戰 T80',
            hint: '2v2 城區，撐到第 80 回合仍有己方存活（提示條件，尚未強制裁判）。',
            mapId: 'citymap',
            mode: '2v2',
            win: 'survive-turns',
            surviveTurns: 80
        }
    ];

    function list() {
        return BUILTIN.slice();
    }

    function get(id) {
        return BUILTIN.find((c) => c.id === id)
            || BUILTIN.find((c) => c.id === 'skirmish')
            || BUILTIN[0];
    }

    function applyToDraft(draft, challengeId) {
        const ch = get(challengeId);
        const next = draft && typeof draft === 'object' ? draft : {};
        next.challengeId = ch.id;
        if (ch.mode) next.mode = ch.mode;
        if (ch.mapId) next.mapId = ch.mapId;
        next.win = ch.win || null;
        next.surviveTurns = ch.surviveTurns || null;
        return next;
    }

    function isLab(id) {
        const ch = get(id);
        return !!(ch && ch.lab);
    }

    return { list, get, applyToDraft, isLab, BUILTIN };
});
