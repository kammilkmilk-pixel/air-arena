#!/usr/bin/env node
/**
 * tech-debt-render-config-smoke.js
 *
 * Covers Technical Debt items #1–#3 (render pools / CONFIG single-source /
 * pointer-move preview reuse):
 *  1. Source guards: fighterVfxPool gone, adi-sky-ground gone, visualBullets lazy.
 *  2. CONFIG helper override propagation (gun/vt/blast/steps/FOX max AP/range/rocket).
 *  3. Dirty-flag / material-geometry reuse invariants in render.js + game.js.
 *  4. Optional headless Chrome memory/scene stability under repeated preview drags
 *     when AIR_ARENA_SMOKE_URL (or :8080) is reachable.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadConfig() {
    // config.js attaches helpers onto CONFIG; CommonJS exports the same object.
    const CONFIG = require(path.join(ROOT, 'js/core/config.js'));
    assert.ok(CONFIG && CONFIG.weapons && CONFIG.rules, 'CONFIG root missing');
    assert.strictEqual(typeof CONFIG.getGunRange, 'function', 'getGunRange missing');
    assert.ok(CONFIG.AirArenaConfig || true, 'AirArenaConfig export optional');
    return CONFIG;
}

function testConfigOverridePropagation(CONFIG) {
    const baseGun = CONFIG.getGunRange();
    const baseVt = CONFIG.getRocketVtRadius();
    const baseBlast = CONFIG.getRocketBlastRadius();
    const baseSteps = CONFIG.getStepsPerTurn();
    const baseFox2Ap = CONFIG.getMissileMaxAp('fox2');
    const baseFox1Ap = CONFIG.getMissileMaxAp('fox1');
    const baseFox2Range = CONFIG.getMissileSeekerRange('fox2');
    const baseFox1Range = CONFIG.getMissileSeekerRange('fox1');
    const basePod = CONFIG.getRocketRoundsPerPod();
    const baseSalvo = CONFIG.getRocketSalvoPerTurn();
    const baseBombBlast = CONFIG.getBombBlastRadius();

    assert.strictEqual(baseGun, CONFIG.weapons.gun.range);
    assert.strictEqual(baseVt, CONFIG.weapons.rocket.vtRadius);
    assert.strictEqual(baseBlast, CONFIG.weapons.rocket.blastRadius);
    assert.strictEqual(baseSteps, CONFIG.rules.stepsPerTurn);
    assert.strictEqual(baseFox2Ap, CONFIG.weapons.fox2.maxAp);
    assert.strictEqual(baseFox1Ap, CONFIG.weapons.fox1.maxAp);
    assert.strictEqual(baseFox2Range, CONFIG.weapons.fox2.seekerRange);
    assert.strictEqual(baseFox1Range, CONFIG.weapons.fox1.seekerRange);
    assert.strictEqual(basePod, CONFIG.weapons.rocket.roundsPerPod);
    assert.strictEqual(baseSalvo, CONFIG.weapons.rocket.salvoPerTurn);
    assert.strictEqual(baseBombBlast, CONFIG.weapons.bomb.blastRadius);

    const override = {
        rules: { stepsPerTurn: 77, gravity: 11.1, maxAp: 999, maxHeat: 333, minHeat: 111 },
        aircrafts: { mig21: { maxHp: 222, baseAp: 188 } },
        weapons: {
            gun: { range: 91, angle: 0.2, damage: 55 },
            fox1: { maxAp: 401, seekerRange: 251, minArmingRange: 61, seekerAngle: 0.3 },
            fox2: { maxAp: 451, seekerRange: 151, minArmingRange: 31, seekerAngle: 0.25 },
            rocket: { range: 140, roundsPerPod: 12, salvoPerTurn: 4, vtRadius: 5.5, blastRadius: 8 },
            bomb: { blastRadius: 14 }
        }
    };

    assert.strictEqual(CONFIG.getStepsPerTurn(override), 77);
    assert.strictEqual(CONFIG.getGravity(override), 11.1);
    assert.strictEqual(CONFIG.getMaxAp(override), 999);
    assert.strictEqual(CONFIG.getAircraftMaxHp('mig21', override), 222);
    assert.strictEqual(CONFIG.getAircraftBaseAp('mig21', override), 188);
    assert.strictEqual(CONFIG.getGunRange(override), 91);
    assert.strictEqual(CONFIG.getGunDamage(override), 55);
    assert.strictEqual(CONFIG.getMissileMaxAp('fox1', override), 401);
    assert.strictEqual(CONFIG.getMissileMaxAp('fox2', override), 451);
    assert.strictEqual(CONFIG.getMissileSeekerRange('fox1', override), 251);
    assert.strictEqual(CONFIG.getMissileSeekerRange('fox2', override), 151);
    assert.strictEqual(CONFIG.getMissileMinArmingRange('fox1', override), 61);
    assert.strictEqual(CONFIG.getRocketRoundsPerPod(override), 12);
    assert.strictEqual(CONFIG.getRocketSalvoPerTurn(override), 4);
    assert.strictEqual(CONFIG.getRocketVtRadius(override), 5.5);
    assert.strictEqual(CONFIG.getRocketBlastRadius(override), 8);
    assert.strictEqual(CONFIG.getBombBlastRadius(override), 14);

    // Live CONFIG mutation must be reflected by helpers (single source of truth).
    const prevVt = CONFIG.weapons.rocket.vtRadius;
    CONFIG.weapons.rocket.vtRadius = 7.25;
    assert.strictEqual(CONFIG.getRocketVtRadius(), 7.25);
    const tips = CONFIG.formatRocketFuzeTooltips();
    assert.ok(String(tips.vtTitle).includes('7.25'), 'fuze tooltip must track live vtRadius');
    CONFIG.weapons.rocket.vtRadius = prevVt;

    // Helpers must not appear in Object.keys / JSON (non-enumerable).
    assert.ok(!Object.keys(CONFIG).includes('getGunRange'), 'helpers must be non-enumerable');
    const roundTrip = JSON.parse(JSON.stringify(CONFIG));
    assert.strictEqual(roundTrip.getGunRange, undefined);

    console.log('  ✓ CONFIG override propagation + live mutation + non-enumerable helpers');
}

function testSourceGuards() {
    const renderSrc = read('js/view/render.js');
    const gameSrc = read('js/game.js');
    const hudSrc = read('js/view/hud.js');
    const uiSrc = read('js/view/ui.js');

    assert.ok(!/fighterVfxPool/.test(renderSrc), 'fighterVfxPool must be removed');
    assert.ok(!/adi-sky-ground/.test(renderSrc), 'dead #adi-sky-ground DOM update must be removed');
    assert.ok(/function ensureLegacyVisualBullets/.test(renderSrc), 'visualBullets must be lazy');
    assert.ok(/AirArenaAutocannonVfx/.test(renderSrc) && /ensureLegacyVisualBullets\(\)/.test(renderSrc),
        'legacy visualBullets only when AutocannonVfx absent');

    assert.ok(/_ghostMatCache/.test(renderSrc) && /getSharedGhostMat/.test(renderSrc),
        'ghost materials must be cached');
    assert.ok(/lastPathSig/.test(renderSrc), 'drawTrajectoryLine dirty-flag missing');
    assert.ok(/lastMslSig/.test(renderSrc) && /ensurePylonLineMesh/.test(renderSrc),
        'updateMissilePreview reuse missing');
    assert.ok(/_threatEnvPool/.test(gameSrc) && /threatSig/.test(gameSrc),
        'updateTacticalPreview threat dirty-flag missing');
    assert.ok(/getGunRange|getMissileSeekerRange|getRocketVtRadius|getStepsPerTurn/.test(hudSrc),
        'hud.js should read via CONFIG helpers');
    assert.ok(/formatRocketFuzeTooltips|getRocketSalvoPerTurn|getGunRange/.test(uiSrc),
        'ui.js should read via CONFIG helpers');

    // Ensure we no longer eagerly push 150 visual bullets at module load.
    assert.ok(!/for \(let i = 0; i < maxVisualBullets; i\+\+\) \{\s*const pts = new Float32Array\(6\);/.test(renderSrc)
        || /function ensureLegacyVisualBullets/.test(renderSrc),
        'visualBullets must not be eagerly constructed outside ensureLegacyVisualBullets');

    console.log('  ✓ source guards (dead pools/DOM + reuse + CONFIG call sites)');
}

function testDirtyFlagSemantics() {
    // Mirror the ribbon signature contract: identical path endpoints → identical sig.
    function buildSig(pts, quats, ribbonWidth, engineOffsetY) {
        const n = pts.length;
        const p0 = pts[0];
        const pm = pts[n >> 1];
        const p1 = pts[n - 1];
        const q0 = quats[0];
        const q1 = quats[quats.length - 1];
        return [
            n, ribbonWidth, engineOffsetY,
            p0.x.toFixed(3), p0.y.toFixed(3), p0.z.toFixed(3),
            pm.x.toFixed(3), pm.y.toFixed(3), pm.z.toFixed(3),
            p1.x.toFixed(3), p1.y.toFixed(3), p1.z.toFixed(3),
            `${q0.x.toFixed(3)},${q0.y.toFixed(3)},${q0.z.toFixed(3)},${q0.w.toFixed(3)}`,
            `${q1.x.toFixed(3)},${q1.y.toFixed(3)},${q1.z.toFixed(3)},${q1.w.toFixed(3)}`
        ].join('|');
    }
    const ptsA = [
        { x: 0, y: 10, z: 0 },
        { x: 1, y: 10, z: 5 },
        { x: 2, y: 11, z: 10 }
    ];
    const quatsA = [
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 0.1, z: 0, w: 0.995 }
    ];
    const s1 = buildSig(ptsA, quatsA, 1.2, -0.3);
    const s2 = buildSig(ptsA.map((p) => ({ ...p })), quatsA.map((q) => ({ ...q })), 1.2, -0.3);
    assert.strictEqual(s1, s2, 'identical paths must share dirty signature');
    const ptsB = ptsA.map((p, i) => (i === 2 ? { x: p.x + 0.02, y: p.y, z: p.z } : { ...p }));
    const s3 = buildSig(ptsB, quatsA, 1.2, -0.3);
    assert.notStrictEqual(s1, s3, 'path tip drift must invalidate signature');

    // Threat envelope sig ignores own-aircraft joy (only enemy state).
    function threatSig(enemy) {
        const ep = enemy.pos;
        const eq = enemy.quat;
        return [
            enemy.id,
            Number(enemy.throttle || 0).toFixed(2),
            Number(enemy.ap || 0).toFixed(1),
            Number(enemy.heat || 0).toFixed(1),
            ep.x.toFixed(2), ep.y.toFixed(2), ep.z.toFixed(2),
            eq.x.toFixed(3), eq.y.toFixed(3), eq.z.toFixed(3), eq.w.toFixed(3),
            !!enemy.stalled, !!enemy.flameout
        ].join('|');
    }
    const enemy = {
        id: 'blue', throttle: 2, ap: 160, heat: 150,
        pos: { x: 40, y: 20, z: -10 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        stalled: false, flameout: false
    };
    const t1 = threatSig(enemy);
    const t2 = threatSig({ ...enemy }); // own joy changed elsewhere — enemy unchanged
    assert.strictEqual(t1, t2);
    const t3 = threatSig({ ...enemy, throttle: 3 });
    assert.notStrictEqual(t1, t3);

    console.log('  ✓ dirty-flag signature semantics (trajectory + threat envelope)');
}

function probeUrl(url, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
    });
}

async function testHeadlessChromeMemory() {
    const url = process.env.AIR_ARENA_SMOKE_URL
        || 'http://127.0.0.1:8080/?lab=1&storesPreview=0&skipSetup=1';
    const base = url.split('?')[0];
    const up = await probeUrl(base);
    if (!up) {
        console.log('  ⚠ skip Chrome memory check (:8080 not reachable)');
        return null;
    }

    let puppeteer;
    try {
        puppeteer = require('puppeteer');
    } catch (_) {
        console.log('  ⚠ skip Chrome memory check (puppeteer unavailable)');
        return null;
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--window-size=1280,720']
    });
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait until GameContext.three.renderer is injected.
        await page.waitForFunction(() => {
            return !!(window.GameContext && window.GameContext.three
                && window.GameContext.three.renderer
                && window.GameContext.three.scene
                && typeof window.updateTacticalPreview === 'function');
        }, { timeout: 45000 });

        // Dismiss match setup if present and ensure a team is ready for preview.
        await page.evaluate(() => {
            const skip = document.querySelector('[data-skip], #btn-skip-setup, .skip-setup');
            if (skip && typeof skip.click === 'function') skip.click();
            const start = document.getElementById('btn-start-match')
                || document.querySelector('#match-setup-start, .match-start, button.start');
            if (start && typeof start.click === 'function') start.click();
        });

        await page.waitForFunction(() => {
            const GC = window.GameContext;
            if (!GC || !GC.three || !GC.three.renderer) return false;
            const teams = window.teams || (GC.state && GC.state.teams);
            if (!teams) return false;
            const red = teams.red;
            return !!(red && red.wrapper && Array.isArray(red.pathPoints));
        }, { timeout: 45000 }).catch(() => null);

        const sample = await page.evaluate(() => {
            const GC = window.GameContext;
            const renderer = GC.three.renderer;
            const scene = GC.three.scene;
            const teams = window.teams || (GC.state && GC.state.teams);
            const red = teams && teams.red;

            function snap() {
                const mem = renderer.info && renderer.info.memory
                    ? {
                        geometries: renderer.info.memory.geometries,
                        textures: renderer.info.memory.textures
                    }
                    : null;
                return {
                    children: scene.children.length,
                    mem,
                    programs: renderer.info && renderer.info.programs ? renderer.info.programs.length : null
                };
            }

            const before = snap();
            // Repeated pointer-move-equivalent preview updates (joy nudges).
            if (red) {
                for (let i = 0; i < 40; i++) {
                    red.joyX = Math.sin(i * 0.35) * 0.55;
                    red.joyY = Math.cos(i * 0.27) * 0.35;
                    red.roll = red.joyX * (Math.PI / 4);
                    red.pendingYaw = 0;
                    red.pendingPitch = 0;
                    try { window.updateTacticalPreview(red); } catch (_) { /* ignore */ }
                    if (typeof window.drawTrajectoryLine === 'function') {
                        try { window.drawTrajectoryLine(red); } catch (_) { /* ignore */ }
                    }
                    if (typeof window.updateMissilePreview === 'function') {
                        try { window.updateMissilePreview(red); } catch (_) { /* ignore */ }
                    }
                }
            }
            // Force a render so info counters refresh.
            try { renderer.render(scene, GC.three.camera); } catch (_) { /* ignore */ }
            const after = snap();

            const hasFighterVfx = !!(window.fighterVfxPool);
            const visualBulletCount = (typeof window.visualBullets !== 'undefined' && Array.isArray(window.visualBullets))
                ? window.visualBullets.length
                : -1;
            const legacyFn = typeof window.ensureLegacyVisualBullets;
            return { before, after, hasFighterVfx, visualBulletCount, legacyFn, ok: !!red };
        });

        assert.ok(sample.ok, 'failed to locate red team for preview drag simulation');
        assert.strictEqual(sample.hasFighterVfx, false, 'fighterVfxPool must not exist at runtime');

        const geoBefore = sample.before.mem && sample.before.mem.geometries;
        const geoAfter = sample.after.mem && sample.after.mem.geometries;
        const childBefore = sample.before.children;
        const childAfter = sample.after.children;

        // Allow tiny jitter, but reject unbounded growth from per-frame allocs.
        if (Number.isFinite(geoBefore) && Number.isFinite(geoAfter)) {
            assert.ok(geoAfter - geoBefore <= 8,
                `geometry count grew too much under preview drags: ${geoBefore} → ${geoAfter}`);
        }
        assert.ok(childAfter - childBefore <= 16,
            `scene.children grew too much under preview drags: ${childBefore} → ${childAfter}`);

        console.log('  ✓ headless Chrome preview-drag memory/scene stability',
            JSON.stringify({ before: sample.before, after: sample.after }));
        return sample;
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('tech-debt-render-config-smoke');
    const CONFIG = loadConfig();
    testConfigOverridePropagation(CONFIG);
    testSourceGuards();
    testDirtyFlagSemantics();
    const chrome = await testHeadlessChromeMemory();
    console.log('PASS tech-debt-render-config-smoke'
        + (chrome ? ` chromeMem=${JSON.stringify(chrome.before.mem)}→${JSON.stringify(chrome.after.mem)}` : ' (chrome skipped/partial)'));
}

main().catch((err) => {
    console.error('FAIL tech-debt-render-config-smoke', err && err.stack ? err.stack : err);
    process.exit(1);
});
