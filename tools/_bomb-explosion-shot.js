/**
 * Drop a bomb, advance combat resolve, screenshot explosion + continuous throttle.
 * Usage: node tools/_bomb-explosion-shot.js [out.png] [url]
 */
const puppeteer = require("puppeteer");

(async () => {
  const out = process.argv[2] || "bomb-explosion.png";
  const url = process.argv[3] || "http://127.0.0.1:8080/?lab=1&skipSetup=1&storesPreview=1";
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1600,900"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => {
    try {
      return !!(window.GameContext && GameContext.state && GameContext.state.teams
        && GameContext.state.teams.red && GameContext.state.teams.red.pylons
        && typeof AirArenaBomb !== "undefined"
        && typeof getThrottleStats === "function");
    } catch (e) { return false; }
  }, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1800));

  const prep = await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    // Continuous throttle sample
    GameContext.stateMachine.setThrottle("red", 3.35);
    const thr = t.throttle;
    const stats = getThrottleStats(thr, t.type || "mig21");

    // Climb a bit for a longer fall, then bomb mode
    if (t.wrapper) {
      t.wrapper.position.y = Math.max(t.wrapper.position.y, 55);
      if (t.startPos) t.startPos.y = t.wrapper.position.y;
    }
    GameContext.stateMachine.setWeaponMode("red", "bomb");
    AirArenaBomb.armBombPylons(t);
    GameContext.stateMachine.toggleBombQueue("red");
    if (typeof updateTacticalPreview === "function") updateTacticalPreview(t);
    const path = AirArenaBomb.updateCcipPreview(t);
    return {
      throttle: thr,
      thrust: stats.thrust,
      heat: stats.heat,
      queued: t.queuedAction,
      weapon: t.weapon,
      impactSteps: path && path.steps,
      hitGround: !!(path && path.hitGround),
      impact: path && path.impact
        ? { x: +path.impact.x.toFixed(1), y: +path.impact.y.toFixed(1), z: +path.impact.z.toFixed(1) }
        : null
    };
  });
  console.log("prep", JSON.stringify(prep, null, 2));

  // Throttle continuous UI screenshot
  const thrOut = out.replace(/\.png$/i, "-throttle.png");
  await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    if (typeof updateDashboardUI === "function") updateDashboardUI(t);
    if (typeof camera !== "undefined" && t.wrapper) {
      const pos = t.wrapper.position.clone();
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(t.wrapper.quaternion);
      camera.position.copy(pos).addScaledVector(fwd, -22).add(new THREE.Vector3(14, 12, 0));
      camera.lookAt(pos.clone().addScaledVector(fwd, 30));
      if (renderer && scene) renderer.render(scene, camera);
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: thrOut, type: "png" });

  // Run one combat turn resolve in-page (lightweight path used by lab)
  const boom = await page.evaluate(async () => {
    const t = GameContext.state.teams.red;
    // Ensure blue also has a path so turn can resolve
    const b = GameContext.state.teams.blue;
    if (typeof updateTacticalPreview === "function") {
      updateTacticalPreview(t);
      if (b) updateTacticalPreview(b);
    }
    // Mark ready and force turn if helpers exist; else manually run bomb pipeline.
    const steps = (CONFIG.rules && CONFIG.rules.stepsPerTurn) || 100;
    const ctx = {
      log: { turn: 1, flaresTrack: [], chaffTrack: [], vfxTriggers: [], hpTrack: {} },
      hp: {},
      death: {},
      flares: Array.from({ length: steps + 1 }, () => []),
      chaff: Array.from({ length: steps + 1 }, () => [])
    };
    ["red", "blue"].forEach((id) => {
      const team = teams[id];
      if (!team) return;
      ctx.hp[id] = team.hp;
      ctx.death[id] = -1;
      ctx.log.hpTrack[id] = new Array(steps + 1).fill(0);
      ctx.log[`${id}BombTracks`] = {};
      ctx.log[`${id}BombExplodedAt`] = {};
      if (!team.pathPoints || team.pathPoints.length < 2) {
        const r = simulateFlight(team, [{ yaw: 0, pitch: 0, roll: 0, throttle: team.throttle || 4 }]);
        team.pathPoints = r.points;
        team.pathQuats = r.quats;
      }
    });

    // Keep releasing until impact across up to 8 simulated turns
    let exploded = false;
    let explodedStep = null;
    let turns = 0;
    let lastY = null;
    for (let turn = 0; turn < 8 && !exploded; turn++) {
      turns = turn + 1;
      if (turn === 0) {
        // first drop already queued
      } else {
        // continue flying bombs; clear per-turn tracks
        t.wpnQueued = false;
      }
      AirArenaBomb.processBombDrops(ctx);
      for (let step = 0; step <= steps; step++) {
        const ratio = step / steps;
        AirArenaBomb.resolveBombsForStep(step, ratio, ctx);
        const bombs = t.activeBombs || [];
        bombs.forEach((bb) => {
          if (bb && bb.pos) lastY = bb.pos.y;
          if (bb && bb.exploded) {
            exploded = true;
            explodedStep = step;
          }
        });
        // also check pruned exploded via log
        if (ctx.log.redBombExplodedAt) {
          Object.keys(ctx.log.redBombExplodedAt).forEach((pid) => {
            if (ctx.log.redBombExplodedAt[pid] != null) {
              exploded = true;
              explodedStep = ctx.log.redBombExplodedAt[pid];
            }
          });
        }
        if (exploded) break;
      }
      // Carry state into next turn: rebuild ctx tracks but keep activeBombs
      if (!exploded) {
        ctx.log.vfxTriggers = ctx.log.vfxTriggers || [];
        ctx.log.redBombTracks = {};
        ctx.log.redBombExplodedAt = {};
      }
    }

    const vfx = (ctx.log.vfxTriggers || []).map((v) => v.type);
    // Pose camera at impact / last bomb pos
    let look = t.wrapper.position.clone();
    const live = (t.activeBombs || []).find((bb) => bb && bb.pos) || null;
    if (live) look = live.pos.clone();
    else if (ctx.log.vfxTriggers && ctx.log.vfxTriggers[0] && ctx.log.vfxTriggers[0].pos) {
      look = ctx.log.vfxTriggers[0].pos.clone();
    }
    if (typeof camera !== "undefined") {
      camera.position.set(look.x + 18, look.y + 14, look.z + 18);
      camera.lookAt(look);
      if (renderer && scene) renderer.render(scene, camera);
    }

    // Apply last-frame bomb visuals + force-show explosion pool if VFX managers ready
    if (exploded && typeof AirArenaBomb.applyBombVisuals === "function") {
      AirArenaBomb.applyBombVisuals(explodedStep || 0, ctx.log);
    }
    // Manually show explosion sprites at impact for screenshot certainty
    if (exploded && typeof explosionPool !== "undefined" && explosionPool[0] && ctx.log.vfxTriggers[0]) {
      const tr = ctx.log.vfxTriggers.find((x) => x.type === "explosion") || ctx.log.vfxTriggers[0];
      const mesh = explosionPool[0];
      mesh.position.copy(tr.pos);
      mesh.visible = true;
      mesh.scale.setScalar(tr.scale || 2.6);
      if (flashPool && flashPool[0]) {
        flashPool[0].position.copy(tr.pos);
        flashPool[0].visible = true;
        flashPool[0].scale.setScalar(3);
      }
      if (renderer && scene) renderer.render(scene, camera);
    }

    return {
      turns,
      exploded,
      explodedStep,
      lastY,
      vfxTypes: vfx,
      activeLeft: (t.activeBombs || []).length,
      impactLook: { x: +look.x.toFixed(1), y: +look.y.toFixed(1), z: +look.z.toFixed(1) }
    };
  });
  console.log("boom", JSON.stringify(boom, null, 2));
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: out, type: "png" });
  console.log("wrote", out, thrOut);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
