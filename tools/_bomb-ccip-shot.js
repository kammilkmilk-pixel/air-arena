/**
 * Screenshot: tinted stores + bomb CCIP preview.
 * Usage: node tools/_bomb-ccip-shot.js [out.png] [url]
 */
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

(async () => {
  const out = process.argv[2] || "bomb-ccip.png";
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
        && GameContext.state.teams.red.pylons.length >= 4
        && typeof AirArenaBomb !== "undefined");
    } catch (e) { return false; }
  }, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 2000));

  const info = await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    // Switch to bomb mode + refresh CCIP
    if (GameContext.stateMachine && GameContext.stateMachine.setWeaponMode) {
      GameContext.stateMachine.setWeaponMode("red", "bomb");
    }
    t.weapon = "bomb";
    if (typeof AirArenaBomb !== "undefined") AirArenaBomb.armBombPylons(t);
    if (typeof updateTacticalPreview === "function") updateTacticalPreview(t);
    const mats = (t.pylons || []).map((p) => {
      let color = null;
      let metal = null;
      let rough = null;
      if (p.mesh) {
        p.mesh.traverse((c) => {
          if (c.isMesh && c.material && color == null) {
            if (c.material.color) color = "#" + c.material.color.getHexString();
            metal = c.material.metalness;
            rough = c.material.roughness;
          }
        });
      }
      return {
        id: p.id,
        weaponType: p.weaponType,
        state: p.state,
        color,
        metalness: metal,
        roughness: rough
      };
    });
    const path = (typeof AirArenaBomb !== "undefined")
      ? AirArenaBomb.updateCcipPreview(t)
      : null;
    return {
      weapon: t.weapon,
      bombModule: typeof AirArenaBomb !== "undefined",
      pylons: mats,
      impact: path && path.impact
        ? { x: +path.impact.x.toFixed(2), y: +path.impact.y.toFixed(2), z: +path.impact.z.toFixed(2) }
        : null,
      hitGround: !!(path && path.hitGround),
      hud: (document.getElementById("bomb-ccip-hud") || {}).innerText || null
    };
  });
  console.log(JSON.stringify(info, null, 2));

  // Camera: high rear-quarter so CCIP line + impact ring read clearly
  await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    if (!t || !t.wrapper || typeof camera === "undefined") return;
    const pos = t.wrapper.position.clone();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(t.wrapper.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(t.wrapper.quaternion);
    const up = new THREE.Vector3(0, 1, 0);
    camera.position.copy(pos).addScaledVector(forward, -28).addScaledVector(right, 18).addScaledVector(up, 16);
    camera.lookAt(pos.clone().addScaledVector(forward, 40).addScaledVector(up, -8));
    camera.updateProjectionMatrix();
    if (typeof renderer !== "undefined" && renderer && typeof scene !== "undefined") {
      renderer.render(scene, camera);
    }
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: out, type: "png" });

  // Close-up underwing tint check
  const tintOut = out.replace(/\.png$/i, "-tints.png");
  await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    if (!t || !t.wrapper || typeof camera === "undefined") return;
    const pos = t.wrapper.position.clone();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(t.wrapper.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(t.wrapper.quaternion);
    const up = new THREE.Vector3(0, 1, 0);
    camera.position.copy(pos).addScaledVector(forward, -6).addScaledVector(right, -4).addScaledVector(up, 1.2);
    camera.lookAt(pos.clone().addScaledVector(up, -0.4));
    if (typeof renderer !== "undefined" && renderer && typeof scene !== "undefined") {
      renderer.render(scene, camera);
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: tintOut, type: "png" });
  console.log("wrote", out, tintOut);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
