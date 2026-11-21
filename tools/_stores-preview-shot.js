const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

(async () => {
  const out = process.argv[2] || "stores-preview.png";
  const url = process.argv[3] || "http://127.0.0.1:8080/?lab=1&skipSetup=1&storesPreview=1";
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1600,900"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  page.on("console", (msg) => {
    const t = msg.text();
    if (/bomb|rocket|BOOT|⚠|Error|pylon|store/i.test(t)) console.log("[page]", t);
  });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => {
    try {
      return !!(window.GameContext && GameContext.state && GameContext.state.missileMeshBase
        && GameContext.state.teams && GameContext.state.teams.red && GameContext.state.teams.red.pylons
        && GameContext.state.teams.red.pylons.length >= 4);
    } catch (e) { return false; }
  }, { timeout: 60000 });
  // Give a couple frames for chase cam / startup fade
  await new Promise((r) => setTimeout(r, 2500));
  const info = await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    const types = (t.pylons || []).map((p, i) => {
      const child = p.mesh && p.mesh.children[0];
      let localBox = null;
      if (p.mesh) {
        p.mesh.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(p.mesh);
        const size = b.getSize(new THREE.Vector3());
        const center = b.getCenter(new THREE.Vector3());
        const inv = new THREE.Matrix4().copy(t.wrapper.matrixWorld).invert();
        center.applyMatrix4(inv);
        localBox = {
          cx: +center.x.toFixed(3),
          cy: +center.y.toFixed(3),
          cz: +center.z.toFixed(3),
          sy: +size.y.toFixed(3),
          sz: +size.z.toFixed(3)
        };
      }
      return {
        i,
        weaponType: p.weaponType,
        visible: !!(p.mesh && p.mesh.visible),
        childRot: child ? {
          x: +child.rotation.x.toFixed(3),
          y: +child.rotation.y.toFixed(3),
          z: +child.rotation.z.toFixed(3)
        } : null,
        childPos: child ? {
          x: +child.position.x.toFixed(3),
          y: +child.position.y.toFixed(3),
          z: +child.position.z.toFixed(3)
        } : null,
        localBox
      };
    });
    return {
      bombCfg: CONFIG.weapons.bomb && CONFIG.weapons.bomb.model,
      rocketCfg: CONFIG.weapons.rocket && CONFIG.weapons.rocket.model,
      pylons: types
    };
  });
  console.log(JSON.stringify(info, null, 2));
  // Rear-quarter under-wing view: FOX vs bomb/rocket height + nose direction
  await page.evaluate(() => {
    const t = GameContext.state.teams.red;
    if (!t || !t.wrapper || typeof camera === "undefined") return;
    const pos = t.wrapper.position.clone();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(t.wrapper.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(t.wrapper.quaternion);
    camera.position.copy(pos)
      .addScaledVector(forward, -3.8)
      .addScaledVector(right, 2.4)
      .add(new THREE.Vector3(0, -0.35, 0));
    camera.lookAt(pos.x, pos.y - 0.1, pos.z);
    if (typeof renderer !== "undefined" && renderer) renderer.render(scene, camera);
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: out, type: "png" });
  console.log("wrote", out);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
