/**
 * Verify rocket pod salvo (3/turn, 9 ammo, VT) + reduced bomb drag.
 * Usage: node tools/_rocket-salvo-shot.js [out.png] [url]
 */
const puppeteer = require("puppeteer");

(async () => {
  const out = process.argv[2] || "rocket-salvo.png";
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
        && typeof AirArenaRocket !== "undefined"
        && typeof AirArenaBomb !== "undefined");
    } catch (e) { return false; }
  }, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1800));

  const info = await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    const bombDrag = CONFIG.weapons.bomb.drag;
    const rcfg = CONFIG.weapons.rocket;

    GameContext.stateMachine.setWeaponMode("red", "rocket");
    AirArenaRocket.armRocketPylons(t);
    if (typeof updateTacticalPreview === "function") updateTacticalPreview(t);
    GameContext.stateMachine.toggleRocketQueue("red");

    const pod = AirArenaRocket.teamRocketPylons(t)[0];
    const ammoBefore = pod ? AirArenaRocket.ensurePodAmmo(pod) : null;

    const steps = CONFIG.rules.stepsPerTurn || 100;
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
      if (!team.pathPoints || team.pathPoints.length < 2) {
        const r = simulateFlight(team, [{ yaw: 0, pitch: 0, roll: 0, throttle: team.throttle || 4 }]);
        team.pathPoints = r.points;
        team.pathQuats = r.quats;
      }
    });

    AirArenaRocket.processRocketSalvos(ctx);
    const launches = [];
    for (let step = 0; step <= steps; step++) {
      AirArenaRocket.resolveRocketsForStep(step, step / steps, ctx);
      (t.activeRockets || []).forEach((rk) => {
        if (rk.active && rk.launchStep === step && !launches.includes(step)) launches.push(step);
      });
      // also detect from tracks birth
      const tracks = ctx.log.redRktTracks || {};
      Object.keys(tracks).forEach((tid) => {
        const tr = tracks[tid][step];
        if (tr && tr.pos && !launches.includes(rkLaunchHint(tid, step, tracks))) {
          /* filled below */
        }
      });
    }
    function rkLaunchHint() { return -1; }

    // Collect launch steps from rockets that were created
    const launchSteps = [];
    Object.keys(ctx.log.redRktTracks || {}).forEach((tid) => {
      const arr = ctx.log.redRktTracks[tid];
      for (let s = 0; s < arr.length; s++) {
        if (arr[s] && arr[s].pos) { launchSteps.push(s); break; }
      }
    });
    launchSteps.sort((a, b) => a - b);

    const vfx = (ctx.log.vfxTriggers || []).map((v) => v.type);
    const ammoAfter = pod ? AirArenaRocket.ensurePodAmmo(pod) : null;

    // Camera: look along rocket aim
    if (typeof camera !== "undefined" && t.wrapper) {
      const pos = t.wrapper.position.clone();
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(t.wrapper.quaternion);
      camera.position.copy(pos).addScaledVector(fwd, -20).add(new THREE.Vector3(12, 10, 0));
      camera.lookAt(pos.clone().addScaledVector(fwd, 40));
      if (renderer && scene) renderer.render(scene, camera);
    }
    if (typeof updateDashboardUI === "function") updateDashboardUI(t);

    return {
      bombDrag,
      rocket: {
        roundsPerPod: rcfg.roundsPerPod,
        salvoPerTurn: rcfg.salvoPerTurn,
        intervalSteps: rcfg.intervalSteps,
        vtRadius: rcfg.vtRadius
      },
      ammoBefore,
      ammoAfter,
      launchSteps,
      intervals: launchSteps.slice(1).map((s, i) => s - launchSteps[i]),
      rocketsSpawned: Object.keys(ctx.log.redRktTracks || {}).length,
      vfxTypes: [...new Set(vfx)],
      vfxCount: vfx.length,
      queuedCleared: t.queuedAction,
      hud: (document.getElementById("rocket-aim-hud") || {}).innerText || null
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: out, type: "png" });
  console.log("wrote", out);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
