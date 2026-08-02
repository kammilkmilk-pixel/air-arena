// ============================================================================
// main.js - wire map editor modules
// ============================================================================

(function () {
    const canvas = document.getElementById('viewport');
    window.MapEditorAssets.populateSelect(document.getElementById('asset-select'));
    window.MapEditorScene.init(canvas);
    window.MapEditorInspector.bind();
    window.MapEditorTools.bind();
    window.MapEditorIO.bind();

    window.MapDocument.onChange((doc, reason) => {
        window.MapEditorScene.syncFromDoc(doc, reason);
        if (reason !== 'live') {
            window.MapEditorInspector.refresh();
        } else {
            // keep numeric fields in sync while dragging without full rebuild
            const obj = window.MapDocument.getObject(window.MapDocument.selectedId);
            if (obj) {
                const x = document.getElementById('obj-x');
                const z = document.getElementById('obj-z');
                if (x) x.value = obj.x;
                if (z) z.value = obj.z;
            }
        }
        if (reason === 'select') {
            window.MapEditorTools.setStatus(
                window.MapDocument.selectedId
                    ? `已選取 ${window.MapDocument.selectedId}`
                    : '未選取'
            );
        }
    });

    async function boot() {
        if (window.MapDocument.loadDraft()) {
            window.MapEditorTools.setStatus('已還原本機草稿');
            return;
        }
        try {
            await window.MapEditorIO.loadDefault();
        } catch (err) {
            window.MapDocument.loadQuiet(window.MapDocument.emptyDoc());
            window.MapEditorTools.setStatus(`無預設地圖，使用空白文件（${err.message}）`);
        }
    }

    boot();
})();
