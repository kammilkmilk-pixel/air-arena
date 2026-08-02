// ============================================================================
// inspector.js - property panel binding
// ============================================================================

window.MapEditorInspector = (function () {
    let suppress = false;

    function hexToInput(n) {
        const c = (Number(n) >>> 0) & 0xffffff;
        return '#' + c.toString(16).padStart(6, '0');
    }

    function inputToHex(str) {
        return parseInt(String(str).replace('#', ''), 16);
    }

    function el(id) {
        return document.getElementById(id);
    }

    function refreshList() {
        const list = el('object-list');
        if (!list) return;
        const doc = window.MapDocument.doc;
        const sel = window.MapDocument.selectedId;
        list.innerHTML = '';
        doc.objects.forEach((o) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = `${o.kind === 'glb' ? 'GLB' : 'BOX'} · ${o.id}`;
            if (o.id === sel) btn.classList.add('is-selected');
            btn.addEventListener('click', () => window.MapDocument.select(o.id));
            list.appendChild(btn);
        });
    }

    function refresh() {
        suppress = true;
        const doc = window.MapDocument.doc;
        el('map-name').value = doc.name || '';
        el('ground-width').value = doc.ground.width;
        el('ground-depth').value = doc.ground.depth;
        el('ground-cx').value = doc.ground.centerX;
        el('ground-cz').value = doc.ground.centerZ;
        el('ground-color').value = hexToInput(doc.ground.color);

        const L = doc.lighting || {};
        el('light-hemi-sky').value = hexToInput(L.hemiSky);
        el('light-hemi-ground').value = hexToInput(L.hemiGround);
        el('light-hemi-i').value = L.hemiIntensity;
        el('light-ambient').value = hexToInput(L.ambient);
        el('light-ambient-i').value = L.ambientIntensity;
        el('light-sun').value = hexToInput(L.sunColor);
        el('light-sun-i').value = L.sunIntensity;
        el('light-sun-x').value = L.sunDirX;
        el('light-sun-y').value = L.sunDirY;
        el('light-sun-z').value = L.sunDirZ;

        const S = doc.sky || {};
        el('sky-mode').value = S.mode === 'texture' ? 'texture' : 'color';
        el('sky-color').value = hexToInput(S.color);
        el('sky-fog-color').value = hexToInput(S.fogColor);
        el('sky-fog-near').value = S.fogNear;
        el('sky-fog-far').value = S.fogFar;
        el('sky-texture').value = S.texture || '';
        el('sky-radius').value = S.radius;

        refreshList();

        const obj = window.MapDocument.getObject(window.MapDocument.selectedId);
        const props = el('object-props');
        if (!obj) {
            props.hidden = true;
            suppress = false;
            return;
        }
        props.hidden = false;
        el('obj-id').value = obj.id;
        el('obj-kind').value = obj.kind;
        el('obj-x').value = obj.x;
        el('obj-y').value = obj.y;
        el('obj-z').value = obj.z;
        el('obj-roty').value = ((obj.rotY || 0) * 180 / Math.PI).toFixed(1);
        el('obj-collision').checked = obj.collision !== false;

        const boxDims = el('box-dims');
        const glbDims = el('glb-dims');
        if (obj.kind === 'box') {
            boxDims.hidden = false;
            glbDims.hidden = true;
            el('obj-w').value = obj.w;
            el('obj-d').value = obj.d;
            el('obj-h').value = obj.h;
            el('obj-color').value = hexToInput(obj.color != null ? obj.color : 0x2c2c2c);
            el('obj-color').disabled = false;
        } else {
            boxDims.hidden = true;
            glbDims.hidden = false;
            el('obj-sx').value = obj.scaleX;
            el('obj-sy').value = obj.scaleY;
            el('obj-sz').value = obj.scaleZ;
            el('obj-src').value = obj.src || '';
            if (obj.color == null) {
                el('obj-color').value = '#888888';
            } else {
                el('obj-color').value = hexToInput(obj.color);
            }
        }
        suppress = false;
    }

    function bind() {
        el('map-name').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateMeta({ name: el('map-name').value });
        });

        const groundFields = [
            ['ground-width', 'width'],
            ['ground-depth', 'depth'],
            ['ground-cx', 'centerX'],
            ['ground-cz', 'centerZ']
        ];
        groundFields.forEach(([id, key]) => {
            el(id).addEventListener('change', () => {
                if (suppress) return;
                window.MapDocument.updateGround({ [key]: Number(el(id).value) });
            });
        });
        el('ground-color').addEventListener('input', () => {
            if (suppress) return;
            window.MapDocument.updateGround({ color: inputToHex(el('ground-color').value) });
        });

        el('light-hemi-sky').addEventListener('input', () => {
            if (suppress) return;
            window.MapDocument.updateLighting({ hemiSky: inputToHex(el('light-hemi-sky').value) });
        });
        el('light-hemi-ground').addEventListener('input', () => {
            if (suppress) return;
            window.MapDocument.updateLighting({ hemiGround: inputToHex(el('light-hemi-ground').value) });
        });
        el('light-hemi-i').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateLighting({ hemiIntensity: Number(el('light-hemi-i').value) });
        });
        el('light-ambient').addEventListener('input', () => {
            if (suppress) return;
            window.MapDocument.updateLighting({ ambient: inputToHex(el('light-ambient').value) });
        });
        el('light-ambient-i').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateLighting({ ambientIntensity: Number(el('light-ambient-i').value) });
        });
        el('light-sun').addEventListener('input', () => {
            if (suppress) return;
            window.MapDocument.updateLighting({ sunColor: inputToHex(el('light-sun').value) });
        });
        el('light-sun-i').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateLighting({ sunIntensity: Number(el('light-sun-i').value) });
        });
        ['light-sun-x', 'light-sun-y', 'light-sun-z'].forEach((id) => {
            el(id).addEventListener('change', () => {
                if (suppress) return;
                window.MapDocument.updateLighting({
                    sunDirX: Number(el('light-sun-x').value),
                    sunDirY: Number(el('light-sun-y').value),
                    sunDirZ: Number(el('light-sun-z').value)
                });
            });
        });

        el('sky-mode').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateSky({ mode: el('sky-mode').value });
        });
        el('sky-color').addEventListener('input', () => {
            if (suppress) return;
            window.MapDocument.updateSky({ color: inputToHex(el('sky-color').value) });
        });
        el('sky-fog-color').addEventListener('input', () => {
            if (suppress) return;
            window.MapDocument.updateSky({ fogColor: inputToHex(el('sky-fog-color').value) });
        });
        el('sky-fog-near').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateSky({ fogNear: Number(el('sky-fog-near').value) });
        });
        el('sky-fog-far').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateSky({ fogFar: Number(el('sky-fog-far').value) });
        });
        el('sky-texture').addEventListener('change', () => {
            if (suppress) return;
            const texture = el('sky-texture').value.trim();
            window.MapDocument.updateSky({
                texture,
                mode: texture ? 'texture' : el('sky-mode').value
            });
            if (texture) el('sky-mode').value = 'texture';
        });
        el('sky-radius').addEventListener('change', () => {
            if (suppress) return;
            window.MapDocument.updateSky({ radius: Number(el('sky-radius').value) });
        });
        el('btn-sky-browse').addEventListener('click', () => {
            window.MapEditorTools.setStatus('請把天幕圖放到 assets/sky/，路徑例：assets/sky/my_sky.jpg（等距柱狀／橫向全景）');
        });

        function patchSelected(builder) {
            if (suppress) return;
            const id = window.MapDocument.selectedId;
            if (!id) return;
            window.MapDocument.updateObject(id, builder(window.MapDocument.getObject(id)));
        }

        ['obj-x', 'obj-y', 'obj-z'].forEach((id) => {
            el(id).addEventListener('change', () => {
                patchSelected(() => ({
                    x: Number(el('obj-x').value),
                    y: Number(el('obj-y').value),
                    z: Number(el('obj-z').value)
                }));
            });
        });
        el('obj-roty').addEventListener('change', () => {
            patchSelected(() => ({
                rotY: Number(el('obj-roty').value) * Math.PI / 180
            }));
        });
        ['obj-w', 'obj-d', 'obj-h'].forEach((id) => {
            el(id).addEventListener('change', () => {
                patchSelected(() => ({
                    w: Number(el('obj-w').value),
                    d: Number(el('obj-d').value),
                    h: Number(el('obj-h').value)
                }));
            });
        });
        ['obj-sx', 'obj-sy', 'obj-sz'].forEach((id) => {
            el(id).addEventListener('change', () => {
                patchSelected(() => ({
                    scaleX: Number(el('obj-sx').value),
                    scaleY: Number(el('obj-sy').value),
                    scaleZ: Number(el('obj-sz').value)
                }));
            });
        });
        el('obj-src').addEventListener('change', () => {
            const src = window.MapEditorAssets.normalizeGamePath(el('obj-src').value.trim());
            el('obj-src').value = src;
            patchSelected(() => ({ src }));
        });
        el('obj-color').addEventListener('input', () => {
            patchSelected(() => ({ color: inputToHex(el('obj-color').value) }));
        });
        el('btn-clear-color').addEventListener('click', () => {
            patchSelected((obj) => (obj.kind === 'glb' ? { color: null } : { color: 0x2c2c2c }));
        });
        el('obj-collision').addEventListener('change', () => {
            patchSelected(() => ({ collision: el('obj-collision').checked }));
        });
    }

    return { bind, refresh };
})();
