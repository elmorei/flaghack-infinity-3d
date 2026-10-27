/** Actual-game staged VFX proof. Run against npm run dev on a supported WebGL browser.
 * Requires Playwright, Chrome and ffmpeg. No security or graphics policy overrides.
 * Boss blast function removes real props; no fake overlaid explosion or compositing.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const out = resolve('fireball-proof');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.addInitScript(() => { window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {}; });
  await page.goto(process.env.CAPTURE_URL || 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.flaghack && !!window.fh);
  const setup = await page.evaluate(async () => {
    const { blastBossEye } = await import('/src/sim/systems/boss/eye.ts');
    const { groundHeight } = await import('/src/sim/terrain.ts');
    const app = window.flaghack;
    app.session.settings.masterVolume = 0;
    app.startMatch({ seed: 'fireball-proof', difficulty: 'normal', match: { days: 0, bossMode: true, maxSignifiers: 0 } });
    window.fh.advance(90.15);
    const w = app.world;
    if (!w.boss) throw Error('Expected actual boss simulation');
    const prop = w.map.obstacles.find(p => p.kind === 'dome' && !w.destroyedScenery.has(p.id));
    if (!prop) throw Error('Expected intact dome');
    const y = groundHeight(prop.x, prop.z, w.map.half);
    const camera = app.renderer.camera;
    camera.fov = 55; camera.updateProjectionMatrix();
    camera.position.set(prop.x + 20, y + 11, prop.z + 25);
    camera.lookAt(prop.x, y + 3.5, prop.z); camera.updateMatrixWorld();
    app.renderer.render(0);
    window.fireballFrame = i => {
      // Keep a steady camera and deterministic presentation clock for comparing frames.
      w.time += 1 / 30;
      if (i === 30) {
        blastBossEye(w, w.boss, { x: prop.x, y: y + .5, z: prop.z });
        if (!w.destroyedScenery.has(prop.id)) throw Error('Boss blast failed to remove target');
        app.renderer.onEvents(w.drainEvents());
      }
      app.renderer.render(1 / 30);
      return document.querySelector('canvas#game').toDataURL('image/png').split(',')[1];
    };
    return { prop: prop.id, kind: prop.kind, position: { x: prop.x, y, z: prop.z }, clock: w.time };
  });
  for (let i = 0; i < 120; i++) {
    const data = await page.evaluate(i => window.fireballFrame(i), i);
    await writeFile(resolve(out, `${String(i).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
  }
  if (errors.length) throw Error(errors.join('\n'));
  execFileSync('ffmpeg', ['-y', '-framerate', '30', '-i', resolve(out, '%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', resolve(out, 'structure-fireball.mp4')]);
  await writeFile(resolve(out, 'provenance.json'), JSON.stringify({ setup, errors, note: 'Staged actual-game boss blast and production renderer. Fixed camera; no simulation rule edits or compositing.' }, null, 2));
} finally { await browser.close(); }
