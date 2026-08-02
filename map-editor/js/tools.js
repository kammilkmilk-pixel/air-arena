// ============================================================================
// tools.js - select / place box / move XZ
// ============================================================================

window.MapEditorTools = (function () {
    let tool = 'select';
    let dragging = false;
    let dragId = null;
    let dragOffset = new THREE.Vector3();

    function setStatus(msg) {
        const el = document.getElementById('status');
        if (el) el.textContent = msg || '';
    }

    function setTool(next) {
        tool = next;
        document.querySelectorAll('.tool-btn').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.tool === tool);
        });
        setStatus(`工具：${tool}`);
    }

    function onPointerDown(e) {
        if (e.button !== 0) return;
        const canvas = document.getElementById('viewport');

        if (tool === 'box') {
            const pt = window.MapEditorScene.pickGroundPoint(e.clientX, e.clientY);
            if (!pt) return;
            window.MapDocument.addObject({
                kind: 'box',
                x: Math.round(pt.x * 2) / 2,
                y: 0,
                z: Math.round(pt.z * 2) / 2,
                w: 4, d: 4, h: 16,
                rotY: 0,
                color: 0x2c2c2c,
                collision: true
            });
            return;
        }

        if (tool === 'select' || tool === 'move') {
            const id = window.MapEditorScene.pickObjectId(e.clientX, e.clientY);
            if (id) {
                window.MapDocument.select(id);
                if (tool === 'move') {
                    const pt = window.MapEditorScene.pickGroundPoint(e.clientX, e.clientY);
                    const obj = window.MapDocument.getObject(id);
                    if (pt && obj) {
                        dragging = true;
                        dragId = id;
                        dragOffset.set(obj.x - pt.x, 0, obj.z - pt.z);
                        window.MapEditorScene.setOrbitEnabled(false);
                        window.MapDocument.pushUndo();
                    }
                }
            } else if (tool === 'select') {
                window.MapDocument.select(null);
            }
        }
    }

    function onPointerMove(e) {
        if (!dragging || !dragId) return;
        const pt = window.MapEditorScene.pickGroundPoint(e.clientX, e.clientY);
        if (!pt) return;
        window.MapDocument.updateObjectLive(dragId, {
            x: Math.round((pt.x + dragOffset.x) * 2) / 2,
            z: Math.round((pt.z + dragOffset.z) * 2) / 2
        });
    }

    function onPointerUp() {
        if (dragging) {
            dragging = false;
            dragId = null;
            window.MapEditorScene.setOrbitEnabled(true);
        }
    }

    function bind() {
        document.querySelectorAll('.tool-btn').forEach((btn) => {
            btn.addEventListener('click', () => setTool(btn.dataset.tool));
        });

        const canvas = document.getElementById('viewport');
        canvas.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);

        document.getElementById('btn-delete').addEventListener('click', () => {
            if (window.MapDocument.selectedId) {
                window.MapDocument.removeObject(window.MapDocument.selectedId);
            }
        });
        document.getElementById('btn-duplicate').addEventListener('click', () => {
            window.MapDocument.duplicateSelected();
        });

        const picker = document.getElementById('asset-picker');
        document.getElementById('btn-add-glb').addEventListener('click', () => {
            picker.hidden = !picker.hidden;
        });
        document.getElementById('btn-cancel-glb').addEventListener('click', () => {
            picker.hidden = true;
        });
        document.getElementById('btn-place-glb').addEventListener('click', () => {
            const custom = document.getElementById('asset-custom').value.trim();
            const selected = document.getElementById('asset-select').value;
            let src = custom || selected;
            if (!src) return;
            src = window.MapEditorAssets.normalizeGamePath(src);
            document.getElementById('asset-custom').value = src;
            const g = window.MapDocument.doc.ground;
            window.MapDocument.addObject({
                kind: 'glb',
                src,
                x: g.centerX,
                y: 0,
                z: g.centerZ,
                rotY: 0,
                scaleX: 1,
                scaleY: 1,
                scaleZ: 1,
                color: null,
                collision: true
            });
            picker.hidden = true;
            setTool('select');
            setStatus(`已放置 GLB：${src}（若仍見紅線框，請確認檔案可經 http 開啟）`);
        });

        window.addEventListener('keydown', (e) => {
            if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (window.MapDocument.selectedId) {
                    e.preventDefault();
                    window.MapDocument.removeObject(window.MapDocument.selectedId);
                }
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                window.MapDocument.undo();
            }
            if (e.key === 'v' || e.key === 'V') setTool('select');
            if (e.key === 'b' || e.key === 'B') setTool('box');
            if (e.key === 'g' || e.key === 'G') setTool('move');
        });
    }

    return { bind, setTool, get tool() { return tool; }, setStatus };
})();
