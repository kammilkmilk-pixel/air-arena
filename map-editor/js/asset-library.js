// ============================================================================
// asset-library.js - known / discoverable model paths for the map editor
// ============================================================================

window.MapEditorAssets = {
    DEFAULT_MODELS: [
        { label: 'city.glb', path: 'assets/models/city.glb' },
        { label: 'city1.glb', path: 'assets/models/city1.glb' },
        { label: 'city2.glb', path: 'assets/models/city2.glb' },
        { label: 'city3.glb', path: 'assets/models/city3.glb' },
        { label: 'city4.glb', path: 'assets/models/city4.glb' },
        { label: 'city5.glb', path: 'assets/models/city5.glb' },
        { label: 'city6.glb', path: 'assets/models/city6.glb' },
        { label: 'mig21_red.glb', path: 'assets/models/mig21_red.glb' },
        { label: 'mig21_blue.glb', path: 'assets/models/mig21_blue.glb' },
        { label: 'fox_two.glb', path: 'assets/models/fox_two.glb' }
    ],

    populateSelect(selectEl) {
        if (!selectEl) return;
        selectEl.innerHTML = '';
        this.DEFAULT_MODELS.forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.path;
            opt.textContent = item.label;
            selectEl.appendChild(opt);
        });
    },

    /**
     * Normalize user input (Windows absolute / backslash / map-editor relative)
     * into a game-root relative path like assets/models/city1.glb
     */
    normalizeGamePath(input) {
        if (!input) return '';
        let p = String(input).trim().replace(/\\/g, '/');

        if (/^(https?:|blob:|data:)/i.test(p)) return p;

        // Strip file://
        p = p.replace(/^file:\/\//i, '');
        // file:///C:/... → C:/...
        p = p.replace(/^\/([A-Za-z]:\/)/, '$1');

        // Extract from .../assets/... anywhere in an absolute path
        const assetsIdx = p.toLowerCase().lastIndexOf('/assets/');
        if (assetsIdx >= 0) {
            p = p.slice(assetsIdx + 1); // "assets/..."
        } else {
            // Drive letter leftover with no assets segment
            p = p.replace(/^[A-Za-z]:\//, '');
            p = p.replace(/^\.\.\//, '');
            p = p.replace(/^\.\//, '');
            if (p.toLowerCase().startsWith('map-editor/')) {
                p = p.slice('map-editor/'.length);
            }
            if (!p.toLowerCase().startsWith('assets/') && /\.glb$/i.test(p)) {
                // Bare filename → assume models folder
                const base = p.split('/').pop();
                p = 'assets/models/' + base;
            }
        }

        return p.replace(/^\/+/, '');
    },

    /** Editor runs under /map-editor/ so game asset paths need ../ prefix for fetch/load. */
    resolveUrl(gameRelativePath) {
        if (!gameRelativePath) return '';
        if (/^(https?:|blob:|data:)/i.test(gameRelativePath)) return gameRelativePath;
        const normalized = this.normalizeGamePath(gameRelativePath);
        if (/^(https?:|blob:|data:)/i.test(normalized)) return normalized;
        if (normalized.startsWith('../')) return normalized;
        return '../' + normalized.replace(/^\.\//, '');
    }
};
