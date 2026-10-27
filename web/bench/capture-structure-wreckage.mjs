/** Actual-game staged VFX proof. Run against npm run dev on a supported WebGL browser.
 * Requires Playwright, Chrome and ffmpeg. No security or graphics policy overrides.
 * Boss blast function removes real props; no fake overlaid explosion or compositing.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const out = resolve('wreckage-proof');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [], consoleErrors = [], resourceErrors = [];
  page.on('response', response => { if (response.status() >= 400) resourceErrors.push({ url: response.url(), status: response.status() }); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await page.addInitScript(() => { window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {}; });
  await page.goto(process.env.CAPTURE_URL || 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.flaghack && !!window.fh);
  const setup = await page.evaluate(async () => {
    const { blastBossEye } = await import('/src/sim/systems/boss/eye.ts');
    const { groundHeight } = await import('/src/sim/terrain.ts');
    const THREE = await import('/node_modules/three/build/three.module.js');
    const app = window.flaghack;
    app.session.settings.masterVolume = 0;
    // Offline capture has no audio clock: keep stage-light beat continuous and positive.
    window.captureBeat = 0;
    app.renderer.beatSource = () => window.captureBeat;
    app.startMatch({ seed: 'wreckage-proof', difficulty: 'normal', match: { days: 0, bossMode: true, maxSignifiers: 0 } });
    window.fh.advance(100);
    const w = app.world;
    if (!w.boss) throw Error('Expected actual boss simulation');
    const camera = app.renderer.camera;
    camera.fov = 42; camera.updateProjectionMatrix();
    app.renderer.render(0);
    await new Promise(resolve => setTimeout(resolve, 2500));
    app.renderer.render(0);
    const scene = app.renderer.ctx.scene; scene.updateMatrixWorld(true);
    // Test the ACTUAL rendered opaque geometry, including tree canopies, not just trunks.
    const opaque = [];
    scene.traverse(o => {
      if (!o.isMesh) return;
      for (let a = o; a; a = a.parent) if (!a.visible) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some(m => m.transparent || m.isShaderMaterial)) return;
      opaque.push(o);
    });
    const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), direction = new THREE.Vector3();
    let prop, y, framing;
    const candidates = w.map.obstacles.filter(p => p.kind === 'dome' && !w.destroyedScenery.has(p.id))
      .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    for (const p of candidates) {
      const gy = groundHeight(p.x, p.z, w.map.half);
      const radius = p.shape === 'circle' ? p.radius : Math.max(p.hx, p.hz);
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
        origin.set(p.x + Math.sin(angle) * 21, gy + 24, p.z + Math.cos(angle) * 21);
        let clear = true;
        for (const dx of [-2, 0, 2]) {
          direction.set(p.x + dx, gy + 3.5, p.z).sub(origin);
          const distance = direction.length(); direction.normalize();
          ray.set(origin, direction); ray.near = .1; ray.far = Math.max(.2, distance - radius * 1.2);
          if (ray.intersectObjects(opaque, false).length) { clear = false; break; }
        }
        if (!clear) continue;
        prop = p; y = gy; framing = { angle, origin: origin.toArray(), testedOpaqueMeshes: opaque.length };
        camera.position.copy(origin); camera.lookAt(p.x, gy + 3.5, p.z); camera.updateMatrixWorld(); break;
      }
      if (prop) break;
    }
    if (!prop) throw Error('No clear actual-geometry camera view of an intact dome');
    app.renderer.render(0);
    await new Promise(resolve => setTimeout(resolve, 500));
    window.fireballFrame = i => {
      // Keep a steady camera and deterministic presentation clock for comparing frames.
      w.time += 1 / 30;
      window.captureBeat += 1 / 15;
      if (i === 30) {
        blastBossEye(w, w.boss, { x: prop.x, y: y + .5, z: prop.z });
        if (!w.destroyedScenery.has(prop.id)) throw Error('Boss blast failed to remove target');
        app.renderer.onEvents(w.drainEvents());
      }
      app.renderer.render(1 / 30);
      if (i === 239 && !app.renderer.ctx.scene.getObjectByName('persistent-structure-wreckage')?.children.some(m => m.count > 0)) throw Error('Missing persistent wreckage');
      return document.querySelector('canvas#game').toDataURL('image/png').split(',')[1];
    };
    return { prop: prop.id, kind: prop.kind, position: { x: prop.x, y, z: prop.z }, clock: w.time, framing };
  });
  for (let i = 0; i < 240; i++) {
    const data = await page.evaluate(i => window.fireballFrame(i), i);
    await writeFile(resolve(out, `${String(i).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
  }
  execFileSync('ffmpeg', ['-y', '-framerate', '30', '-i', resolve(out, '%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', resolve(out, 'structure-wreckage.mp4')]);
  await writeFile(resolve(out, 'provenance.json'), JSON.stringify({ setup, errors, consoleErrors, resourceErrors, note: 'Staged actual-game boss blast and production renderer. Fixed camera; no simulation rule edits or compositing.' }, null, 2));
  if (errors.length) throw Error(errors.join('\n'));
  if (consoleErrors.some(e => /shader|WebGL|compile|link/i.test(e))) throw Error(consoleErrors.join('\n'));
} finally { await browser.close(); }
