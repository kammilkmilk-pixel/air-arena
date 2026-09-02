// ============================================================================
// supabase-config.js - Optional BaaS credentials (override via local file or URL)
// Copy supabase-config.local.js from the example and fill url + anonKey.
// ============================================================================
(function initSupabaseConfig(root) {
    function fromUrl() {
        try {
            const p = new URLSearchParams(window.location.search || '');
            const url = p.get('supabaseUrl') || p.get('sbUrl');
            const anonKey = p.get('supabaseKey') || p.get('sbKey') || p.get('anonKey');
            if (url && anonKey) return { url: String(url), anonKey: String(anonKey), source: 'url' };
        } catch (e) { /* ignore */ }
        return null;
    }

    function fromStorage() {
        try {
            const url = localStorage.getItem('aa-supabase-url');
            const anonKey = localStorage.getItem('aa-supabase-key');
            if (url && anonKey) return { url, anonKey, source: 'localStorage' };
        } catch (e) { /* ignore */ }
        return null;
    }

    function fromWindow() {
        const w = root && root.AIRARENA_SUPABASE;
        if (w && w.url && w.anonKey) {
            return { url: String(w.url), anonKey: String(w.anonKey), source: 'window' };
        }
        return null;
    }

    function resolve() {
        return fromUrl() || fromWindow() || fromStorage() || null;
    }

    function isConfigured() {
        return !!resolve();
    }

    function saveLocal(url, anonKey) {
        try {
            if (url) localStorage.setItem('aa-supabase-url', String(url));
            if (anonKey) localStorage.setItem('aa-supabase-key', String(anonKey));
            return true;
        } catch (e) {
            return false;
        }
    }

    function clearLocal() {
        try {
            localStorage.removeItem('aa-supabase-url');
            localStorage.removeItem('aa-supabase-key');
        } catch (e) { /* ignore */ }
    }

    const api = { resolve, isConfigured, saveLocal, clearLocal, fromUrl, fromWindow, fromStorage };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaSupabaseConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
