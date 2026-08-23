// ============================================================================
// ai-model-registry.js - Named PilotAI brains for match-setup A/B
// Rei_03 = control baseline (2026-08-14 mid-term + bakeDualPref freeze);
// Rei_02 = prior control (2026-08-13 route near-term); Rei_01 = older historical;
// test_01 = live working PilotAI
// ============================================================================

(function initAirArenaAIRegistry(root) {
    const DEFAULT_MODEL = 'test_01';
    const MODELS = Object.freeze([
        { id: 'Rei_03', label: 'Rei_03', role: 'control' },
        { id: 'Rei_02', label: 'Rei_02', role: 'prior-control' },
        { id: 'Rei_01', label: 'Rei_01', role: 'historical' },
        { id: 'test_01', label: 'test_01', role: 'live' }
    ]);

    function migrateModelId(id) {
        // Legacy control seats → Rei_01 (oldest retained freeze).
        if (id === 'Rei_00' || id === 'ling_0') return 'Rei_01';
        return id;
    }

    function ensureModels() {
        root.AirArenaAIModels = root.AirArenaAIModels || {};
        if (root.AirArenaAI && !root.AirArenaAIModels.test_01) {
            root.AirArenaAIModels.test_01 = root.AirArenaAI;
        }
        if (root.AirArenaAIModels.test_01 && !root.AirArenaAIModels.test_01.modelId) {
            root.AirArenaAIModels.test_01.modelId = 'test_01';
            root.AirArenaAIModels.test_01.modelLabel = 'test_01';
        }
        return root.AirArenaAIModels;
    }

    function isKnownModel(id) {
        const m = migrateModelId(id);
        return m === 'Rei_03' || m === 'Rei_02' || m === 'Rei_01' || m === 'test_01';
    }

    /** Parse match-setup control <select> value → { control, aiModel }. */
    function normalizeControlValue(value) {
        const v = migrateModelId(String(value || ''));
        if (v === 'human') return { control: 'human', aiModel: null };
        if (isKnownModel(v)) return { control: 'ai', aiModel: v };
        if (v === 'ai') return { control: 'ai', aiModel: DEFAULT_MODEL };
        return { control: 'human', aiModel: null };
    }

    /** Value to show in the control <select>. */
    function controlSelectValue(seat) {
        if (!seat || seat.control === 'human') return 'human';
        const model = migrateModelId(seat.aiModel);
        if (isKnownModel(model)) return model;
        if (seat.control === 'ai') return DEFAULT_MODEL;
        return 'human';
    }

    function getPilot(modelId) {
        const models = ensureModels();
        const id = isKnownModel(modelId) ? migrateModelId(modelId) : DEFAULT_MODEL;
        return models[id] || models[DEFAULT_MODEL] || root.AirArenaAI || null;
    }

    function getPilotForTeam(teamId) {
        let modelId = DEFAULT_MODEL;
        try {
            if (typeof teams !== 'undefined' && teams && teams[teamId] && teams[teamId].aiModel) {
                modelId = teams[teamId].aiModel;
            }
        } catch (_) { /* ignore */ }
        return getPilot(modelId);
    }

    function listModels() {
        return MODELS.slice();
    }

    const api = {
        DEFAULT_MODEL,
        MODELS,
        migrateModelId,
        normalizeControlValue,
        controlSelectValue,
        getPilot,
        getPilotForTeam,
        listModels,
        isKnownModel,
        ensureModels
    };

    root.AirArenaAIRegistry = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
