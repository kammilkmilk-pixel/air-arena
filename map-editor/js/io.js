// ============================================================================
// io.js - import / export / load default map JSON
// ============================================================================

window.MapEditorIO = (function () {
    const DEFAULT_URL = '../assets/maps/default.json';

    function setStatus(msg) {
        if (window.MapEditorTools) window.MapEditorTools.setStatus(msg);
    }

    function downloadJson(doc) {
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        const name = (doc.name || 'map').replace(/[^\w\-]+/g, '_');
        a.href = URL.createObjectURL(blob);
        a.download = `${name}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        setStatus(`已匯出 ${a.download} — 請放到 assets/maps/ 供遊戲載入`);
    }

    async function loadDefault() {
        const res = await fetch(DEFAULT_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        window.MapDocument.loadQuiet(json);
        setStatus(`已載入 ${DEFAULT_URL}`);
    }

    function bind() {
        document.getElementById('btn-export').addEventListener('click', () => {
            downloadJson(window.MapDocument.toJSON());
        });

        document.getElementById('btn-load-default').addEventListener('click', () => {
            loadDefault().catch((err) => setStatus(`載入預設失敗：${err.message}`));
        });

        const fileInput = document.getElementById('file-import');
        document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const json = JSON.parse(String(reader.result));
                    window.MapDocument.setDoc(json, 'import');
                    setStatus(`已匯入 ${file.name}`);
                } catch (err) {
                    setStatus(`匯入失敗：${err.message}`);
                }
            };
            reader.readAsText(file);
            fileInput.value = '';
        });
    }

    return { bind, loadDefault, downloadJson };
})();
