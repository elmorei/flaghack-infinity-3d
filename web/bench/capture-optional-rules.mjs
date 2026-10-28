/** Actual-game optional-rules proof. Run from web/ with Vite serving.
 * Supported headed Chrome, sandbox enabled. No synthetic overlays, replacement
 * collision world, or shipped simulation edits. Scene entities and Survey masks
 * are staged; production capture, pull defense, attacks, UI and rendering run.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, copyFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const out = resolve(process.env.CAPTURE_OUT || 'optional-rules-proof');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
const errors = [], pageErrors = [], responses = [], scenes = [];
let frame = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { pageErrors.push(String(e)); errors.push(String(e)); });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) responses.push({ url: r.url(), status: r.status() }); });
  page.on('requestfailed', r => responses.push({ url: r.url(), failure: r.failure()?.errorText }));
  await page.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.captureFrozen = false; window.requestAnimationFrame = fn => raf(time => { if (!window.captureFrozen) fn(time); }); });
  await page.goto(process.env.CAPTURE_URL || 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.flaghack && !!window.fh, null, { polling: 100, timeout: 90000 });
  const introSkipped = await page.evaluate(async () => { await window.flaghack.ready; const skip = document.querySelector('#startup-skip'); skip?.click(); return !!skip; });
  await page.waitForFunction(() => !document.querySelector('#startup'), null, { polling: 100, timeout: 30000 });
  await page.evaluate(() => { window.captureFrozen = true; const app = window.flaghack; app.openLobby(); app.ui.update(0); });
  await page.getByRole('button', { name: 'Advanced Game Settings', exact: true }).click();
  const names = ['Building Capture', 'Crystal Flag Protection', 'Crystal Attacks'];
  const checks = names.map(name => page.locator('.advanced-settings label').filter({ has: page.locator('span', { hasText: name }) }).locator('input[type=checkbox]'));
  for (const check of checks) if (!await check.isChecked()) throw Error('Optional rule must default ON');
  await checks[1].scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(out, 'settings-on.png') });
  for (const check of checks) await check.uncheck();
  const disabled = await page.evaluate(() => window.flaghack.session.settings.match);
  if (['buildingCapture', 'crystalFlagProtection', 'crystalAttacks'].some(key => disabled[key] !== false)) throw Error('UI toggles did not update production settings');
  await page.screenshot({ path: resolve(out, 'settings-off.png') });
  for (const check of checks) await check.check();
  scenes.push({ mode: 'settings', defaultOn: true, disabled, reenabled: true });
  for (const name of ['settings-on.png', 'settings-off.png']) for (let i = 0; i < 45; i++) await copyFile(resolve(out, name), resolve(out, `${String(frame++).padStart(4, '0')}.png`));
  await page.getByRole('button', { name: 'Close advanced game settings' }).click();
  const captureRules = await page.evaluate(async () => {
    const { createMatch } = await import('/src/sim/setup.ts');
    const { normalizeMatch } = await import('/src/sim/matchSettings.ts');
    const { spawnBuilding } = await import('/src/sim/factory.ts');
    const { updateCapture } = await import('/src/sim/systems/capture.ts');
    const { updateStructureCapture } = await import('/src/sim/systems/structureCapture.ts');
    const { CAPTURE } = await import('/src/sim/constants.ts');
    const result = [];
    for (const enabled of [false, true]) {
      const w = createMatch({ seed: 'capture-structures', difficulty: 'normal', mode: 'standard', humans: [0, 1, 2, 3], match: normalizeMatch({ maxSignifiers: 0, buildingCapture: enabled }) });
      for (const a of w.avatars.values()) a.pos = { x: -1000, y: 0, z: -1000 };
      const facet = w.lattice.facets.find(f => !f.boundary && Math.hypot(f.cx, f.cz) < 30);
      const b = spawnBuilding(w, 'workshop', 1, facet.id, 1);
      w.survey.facetSurvey.fill(1); w.survey.version++;
      w.time += 20; updateStructureCapture(w, 20); w.time += 3; updateStructureCapture(w, 3);
      if (b.faction !== (enabled ? 0 : 1)) throw Error('Building Capture did not gate production capture');
      const buildingOwnerBeforeAltar = b.faction;
      const altar = w.hearthOf(1); updateCapture(w, 20);
      if (altar.hearth.stage !== 'overwritten') throw Error('Altar pressure was incorrectly disabled');
      w.time += CAPTURE.overwriteTime + .01; updateCapture(w, .01);
      if (altar.faction !== 0) throw Error('Altar capture failed');
      result.push({ enabled, buildingOwnerBeforeAltar, altarOwner: altar.faction, staging: 'Survey enclosure masks staged; production state machines advance pressure and transfer ownership.' });
    }
    return result;
  });
  scenes.push({ mode: 'capture-rules', results: captureRules });
  for (const owner of [0, 1, 2, 3]) {
    const setup = await page.evaluate(async owner => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { spawnCrystal, spawnHippie, spawnFlag } = await import('/src/sim/factory.ts');
      const { updateCrystalAttacks, crystalAttackOrigin, crystalAttackAim } = await import('/src/sim/systems/crystalAttacks.ts');
      const { defendedPullRate } = await import('/src/sim/systems/flags.ts');
      const { setLightningPalette } = await import('/src/render/vfx/lightningPalette.ts');
      const app = window.flaghack;
      app.session.settings.masterVolume = 0; app.session.settings.quality = 'medium';
      window.captureBeat = 0; app.renderer.beatSource = () => window.captureBeat;
      app.startMatch({ seed: 'optional-rules-proof', difficulty: 'normal', humans: [0, 1, 2, 3], match: { days: -1, bossMode: false, maxSignifiers: 0, buildingCapture: true, crystalFlagProtection: true, crystalAttacks: true } });
      app.ai.clear(); const w = app.world; w.time = 470; w.hippies.clear(); w.crystals.clear();
      for (const a of w.avatars.values()) a.pos = { x: -1000, y: 0, z: -1000 };
      const c = spawnCrystal(w, 0, owner, []); c.growth = 1; c.scale = 1;
      const target = spawnHippie(w, (owner + 1) % 4, { x: 0, z: 0 });
      let node = null;
      for (const n of w.lattice.nodes.filter(n => !n.blocked && Math.hypot(n.x, n.z) < 100).sort((a,b) => Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))) {
        if (w.collision.blockedCircle(n.x, n.z, 2, .1, 12) || w.collision.blockedCircle(n.x + 10, n.z, 2, .1, 8)) continue;
        c.pos = { x: n.x, z: n.z }; target.pos = { x: n.x + 10, z: n.z };
        const a = crystalAttackOrigin(w, c), b = crystalAttackAim(w, target);
        if (w.collision.raycast(a.x, a.y, a.z, b.x-a.x, b.y-a.y, b.z-a.z, Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z)-.05)) continue;
        node = n; break;
      }
      if (!node) throw Error('No unobstructed real-map crystal attack footprint');
      c.node = node.id;
      const fn = w.lattice.nodes.filter(n => !n.blocked && n.id !== node.id).sort((a,b) => Math.hypot(a.x-node.x,a.z-node.z)-Math.hypot(b.x-node.x,b.z-node.z))[0];
      c.pentacle = [fn.id];
      const flag = spawnFlag(w, { state: 'planted', owner, node: fn.id, pos: { x: fn.x, y: w.collision.groundHeight(fn.x,fn.z), z: fn.z } });
      const protectedRate = defendedPullRate(w, flag, (owner+1)%4);
      w.options.match.crystalFlagProtection = false;
      const unprotectedRate = defendedPullRate(w, flag, (owner+1)%4);
      w.options.match.crystalFlagProtection = true;
      if (protectedRate !== .5 || unprotectedRate !== 1) throw Error('Crystal Flag Protection did not independently toggle 2x pull protection');
      const camera = app.renderer.camera; camera.fov = 45; camera.updateProjectionMatrix();
      const y = w.collision.groundHeight(node.x,node.z);
      camera.position.set(node.x+9,y+22,node.z+36); camera.lookAt(node.x+5,y+3,node.z); camera.updateMatrixWorld();
      w.drainEvents(); app.renderer.render(0); await new Promise(r => setTimeout(r,2500)); app.renderer.render(0);
      const history = [], initialHp = target.hp; let disabledHp = null;
      updateCrystalAttacks(w,0);
      if (!c.attack || c.attack.target !== target.id) throw Error('Production crystal target acquisition failed');
      window.optionalFrame = i => {
        if (i === 60) { w.options.match.crystalAttacks = false; disabledHp = target.hp; }
        w.time += 1/30; w.tick++; window.captureBeat += 1/15; updateCrystalAttacks(w,1/30);
        app.renderer.onEvents(w.drainEvents()); app.renderer.render(1/30); app.ui.update(1/30);
        const arc = app.renderer.ctx.scene.getObjectByName(`crystal-unit-lightning-${c.id}`);
        const ring = app.renderer.ctx.scene.getObjectByName(`crystal-unit-warning-${c.id}`);
        if (i < 29 && (!ring?.visible || target.hp !== initialHp)) throw Error('Warning must be visible and harmless');
        if (i >= 32 && i < 60 && (ring?.visible || target.hp >= initialHp)) throw Error('Firing must follow warning and damage target');
        if (i >= 60 && (arc || ring || c.attack || target.hp !== disabledHp)) throw Error('Disabled attacks must clean up visuals and damage');
        if (arc) {
          const core = new THREE.Color(), glow = new THREE.Color(); setLightningPalette(core,glow,w.factions[owner].color);
          const actual = arc.material.uniforms.uGlow.value;
          if (Math.abs(actual.r-glow.r)+Math.abs(actual.g-glow.g)+Math.abs(actual.b-glow.b)>1e-6) throw Error('Lightning not source-owner colored');
        }
        if ([0,28,32,59,60,89].includes(i)) history.push({ frame:i, hp:target.hp, warning:!!ring?.visible, arc:!!arc, attacks:w.options.match.crystalAttacks });
      };
      window.optionalResult = () => ({ history, initialHp, finalHp:target.hp, protectedRate, unprotectedRate, assertions:'passed' });
      return { owner, color:w.factions[owner].color, crystal:c.pos, target:target.pos, camera:camera.position.toArray(), staging:'Grown crystal and hostile unit at a real unobstructed lattice footprint. All terrain/collision retained. First second warning, next second attack, final second disabled.' };
    }, owner);
    for (let i = 0; i < 90; i++) { await page.evaluate(i => window.optionalFrame(i),i); await page.screenshot({ path:resolve(out,`${String(frame++).padStart(4,'0')}.png`) }); }
    scenes.push({ mode:'crystal-attack', setup, result:await page.evaluate(() => window.optionalResult()) });
    await writeFile(resolve(out,'provenance.json'),JSON.stringify({ scenes, errors, pageErrors, responses },null,2));
  }
  const info = new URL('/api/info', process.env.CAPTURE_URL || 'http://127.0.0.1:5173/').href;
  const hostFailures = responses.filter(r => r.url === info && (r.status === 502 || r.failure === 'net::ERR_ABORTED'));
  // Skipping the real startup video intentionally cancels its in-flight media request.
  const intro = new URL('/src/startup/assets/flaghack-gameplay-intro-25s.mp4', info).href;
  const skippedIntro = responses.filter(r => introSkipped && r.url === intro && r.failure === 'net::ERR_ABORTED');
  const optionalOnly = pageErrors.length === 0 && hostFailures.some(r => r.status === 502) && responses.length === hostFailures.length + skippedIntro.length && errors.length <= hostFailures.length && errors.every(e => e.startsWith('Failed to load resource:'));
  if (errors.length && !optionalOnly) throw Error(errors.join('\n'));
  execFileSync('ffmpeg',['-y','-framerate','30','-i',resolve(out,'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-movflags','+faststart',resolve(out,'optional-rules.mp4')]);
  for (let i=0;i<frame;i++) if (i>=90 && ![0,28,32,59,60,89].includes((i-90)%90)) await unlink(resolve(out,`${String(i).padStart(4,'0')}.png`));
  await writeFile(resolve(out,'provenance.json'),JSON.stringify({ scenes, errors, pageErrors, responses, commit:process.env.GITHUB_SHA??null, frames:frame, note:'15 seconds of production UI/game pixels; staged simulation, not player-input gameplay. Capture rule assertions recorded separately, not depicted as live enclosure construction.' },null,2));
} finally { await writeFile(resolve(out,'capture-diagnostics.json'),JSON.stringify({ scenes, errors, pageErrors, responses, frames:frame },null,2)); await browser.close(); }
