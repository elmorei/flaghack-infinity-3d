'use strict';
/** Actual rendered match + trusted browser touch events. Deterministic local staging only;
 * no replacement input handlers or simulated command submissions. Not physical-phone QA. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { chromium } = require('playwright');
const DIST = resolve(__dirname, '../dist');
const OUT = resolve(__dirname, '../host-release/mobile-command-smoke');
const PROJECT = '/flaghack-infinity-3d/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!path.startsWith(PROJECT)) { res.writeHead(404); res.end(); return; }
  const relative = decodeURIComponent(path.slice(PROJECT.length)) || 'index.html';
  const file = resolve(DIST, relative);
  if (!file.startsWith(DIST + '/')) { res.writeHead(404); res.end(); return; }
  let body; try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
});
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const specs = [
  { name: 'phone-portrait', width: 390, height: 844, full: true },
  { name: 'small-phone', width: 320, height: 568, full: true },
  { name: 'phone-landscape', width: 844, height: 390, full: true },
  { name: 'desktop', width: 1366, height: 768, desktop: true },
];
async function main() {
  mkdirSync(OUT, { recursive: true });
  if (!process.env.LIVE_URL) await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = process.env.LIVE_URL || `http://127.0.0.1:${server.address().port}${PROJECT}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true, args: [] });
  const results = { url, checks: [], scenarios: [], completed: false, physicalDeviceTest: false };
  let page;
  const check = label => { results.checks.push(label); console.log('PASS ' + label); };
  const shot = name => page.screenshot({ path: join(OUT, name + '.png'), animations: 'disabled' });
  const uiTap = async locator => { await locator.scrollIntoViewIfNeeded(); await locator.tap({ noWaitAfter: true }); };
  const state = () => page.evaluate(() => {
    const a = window.flaghack, s = a.session, w = a.world;
    return { view: s.view, mode: s.mobileMode, menu: s.mobileMenu, facet: s.mobileBuildFacet, tool: s.tool, selection: [...s.selection], plan: [...w.factions[s.playerFaction].plan], buildings: [...w.buildings.keys()], camera: { ...s.camera }, order: w.hippies.get(window.__qa.worker)?.order, time: w.time };
  });
  const centerAt = async (x, z) => {
    await page.evaluate(({ x, z }) => { const s = window.flaghack.session; s.camera.cmdX = x; s.camera.cmdZ = z; }, { x, z });
    await page.waitForTimeout(350); // Existing camera interpolation, not test control replacement.
  };
  const project = pos => page.evaluate(pos => window.__qa.project(pos), pos);
  try {
    for (const spec of specs) {
      const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, userAgent: spec.desktop ? DESKTOP_UA : MOBILE_UA, hasTouch: !spec.desktop, isMobile: !spec.desktop, deviceScaleFactor: 1, recordVideo: process.env.RECORD_VIDEO === '1' && spec.name === 'phone-portrait' ? { dir: join(OUT, 'video'), size: { width: 390, height: 844 } } : undefined });
      page = await context.newPage();
      const entry = { name: spec.name, errors: [] }; results.scenarios.push(entry);
      page.on('pageerror', error => entry.errors.push(error.message));
      // Retain ordinary readiness, then use the real Skip control. The film is now 193s;
      // gameplay checks should not impose the previous 90s natural-ending deadline.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#startup[data-ready="true"]') || window.flaghack && !window.flaghack.startupPending, null, { timeout: 180_000 });
      if (await page.locator('#startup').count()) await page.getByRole('button', { name: 'Skip', exact: true }).click({ noWaitAfter: true });
      await page.locator('#startup').waitFor({ state: 'detached', timeout: 30_000 });
      // A deterministic real local match, with the usual production setup, simulation and renderer.
      await page.evaluate(() => {
        const a = window.flaghack;
        a.startMatch({ seed: 'mobile-command-native-qa', humans: [0], rtsFactions: [0], match: { ...a.session.settings.match, active: [0], bossMode: false, days: 3 } });
        window.__qa = { worker: -1, neutral: -1, facet: -1 };
        window.__qa.project = p => {
          const cam = a.renderer.camera;
          cam.updateMatrixWorld();
          const mul = (m, v) => [0, 1, 2, 3].map(r => m[r] * v[0] + m[4+r] * v[1] + m[8+r] * v[2] + m[12+r] * v[3]);
          const y = p.y ?? a.world.collision.groundHeight(p.x, p.z);
          const v = mul(cam.projectionMatrix.elements, mul(cam.matrixWorldInverse.elements, [p.x, y, p.z, 1]));
          return { x: (v[0] / v[3] + 1) * innerWidth / 2, y: (1 - v[1] / v[3]) * innerHeight / 2 };
        };
      });
      await page.waitForFunction(() => window.flaghack.session.screen === 'playing' && window.flaghack.session.view === 'command');
      await page.waitForTimeout(1000);
      if (spec.desktop) {
        assert.equal(await page.locator('.mobile-command:visible').count(), 0);
        assert.ok(await page.locator('.cmd-right:visible').count());
        const before = await page.evaluate(() => window.flaghack.session.camera.cmdHeight);
        await page.mouse.move(spec.width / 2, spec.height / 2); await page.mouse.wheel(0, 300);
        await page.waitForFunction(before => window.flaghack.session.camera.cmdHeight !== before, before);
        await shot('desktop-command');
        check('desktop: original command panels and mouse wheel zoom retained');
        assert.deepEqual(entry.errors, []); await context.close(); continue;
      }
      const cdp = await context.newCDPSession(page);
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 5, radiusY: 5, force: 1 })) });
      const drag = async (from, to) => {
        await touch('touchStart', [from]);
        for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: from.x + (to.x-from.x)*i/8, y: from.y+(to.y-from.y)*i/8 }]); await page.waitForTimeout(25); }
        await touch('touchEnd', []); await page.waitForTimeout(150);
      };
      const hold = async p => { await touch('touchStart', [p]); await page.waitForTimeout(680); await touch('touchEnd', []); await page.waitForTimeout(150); };
      const modes = page.locator('.mc-modes');
      await modes.waitFor();
      for (const label of ['Degen', 'Plan']) {
        const box = await modes.getByRole('button', { name: label, exact: true }).boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= spec.width, label + ' reachable touch target');
      }
      assert.equal(await page.locator('.cmd-right:visible,.cmd-left:visible,.cmd-deck:visible,.minimap:visible').count(), 0, 'No permanent desktop command clutter');
      assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth/2, innerHeight/2)?.id), 'game', 'Central field accepts map gestures');
      await shot(spec.name + '-field');
      const beforePan = await state();
      await drag({ x: spec.width * .35, y: spec.height * .45 }, { x: spec.width * .65, y: spec.height * .55 });
      const afterPan = await state();
      assert.ok(Math.hypot(afterPan.camera.cmdX-beforePan.camera.cmdX, afterPan.camera.cmdZ-beforePan.camera.cmdZ) > 1, 'Drag pans map');
      assert.equal(afterPan.camera.cmdHeight, beforePan.camera.cmdHeight, 'Panning does not zoom');
      assert.deepEqual(afterPan.selection, beforePan.selection); assert.deepEqual(afterPan.plan, beforePan.plan); assert.equal(afterPan.menu, null);
      // Pinch is deliberately unsupported, and must not leak a tap or long-press.
      const pinchBefore = await state();
      const pageScaleBefore = await page.evaluate(() => visualViewport?.scale ?? 1);
      await touch('touchStart', [{ x: spec.width*.4, y: spec.height*.45, id: 0 }]);
      await touch('touchStart', [{ x: spec.width*.4, y: spec.height*.45, id: 0 }, { x: spec.width*.6, y: spec.height*.55, id: 1 }]);
      await touch('touchMove', [{ x: spec.width*.25, y: spec.height*.4, id: 0 }, { x: spec.width*.75, y: spec.height*.6, id: 1 }]);
      await page.waitForTimeout(650); await touch('touchEnd', []); await page.waitForTimeout(150);
      const pinchAfter = await state();
      assert.equal(await page.evaluate(() => visualViewport?.scale ?? 1), pageScaleBefore, 'Pinch must not zoom the browser page either');
      assert.equal(pinchAfter.camera.cmdHeight, pinchBefore.camera.cmdHeight); assert.deepEqual(pinchAfter.selection, pinchBefore.selection); assert.deepEqual(pinchAfter.plan, pinchBefore.plan); assert.equal(pinchAfter.menu, null);
      check(`${spec.name}: minimal field, drag-pan and cancelled two-finger gesture without zoom/actions`);

      const staged = await page.evaluate(() => {
        const a = window.flaghack, w = a.world, f = a.session.playerFaction;
        w.factions[f].lumber = 2000;
        const facet = w.lattice.facets.findIndex((_, i) => window.fh.buildings.canPlaceBuilding(w, f, 'workshop', i).ok);
        if (facet < 0) throw Error('No valid empty owned workshop facet for deterministic fixture');
        const fc = w.lattice.facets[facet];
        const worker = window.fh.factory.spawnHippie(w, f, { x: fc.cx, z: fc.cz });
        worker.order = { kind: 'defend', at: { x: fc.cx, z: fc.cz } };
        const neutral = window.fh.factory.spawnHippie(w, -1, { x: fc.cx + 25, z: fc.cz + 25 });
        neutral.order = { kind: 'defend', at: { x: fc.cx + 25, z: fc.cz + 25 } };
        window.__qa.worker = worker.id; window.__qa.neutral = neutral.id; window.__qa.facet = facet;
        return { facet, x: fc.cx, z: fc.cz, worker: worker.id, neutral: neutral.id };
      });
      await centerAt(staged.x, staged.z);
      await uiTap(modes.getByRole('button', { name: 'Plan', exact: true }));
      const unitPoint = await page.evaluate(() => { const h=window.flaghack.world.hippies.get(window.__qa.worker); return window.__qa.project({ x:h.pos.x,z:h.pos.z,y:window.flaghack.world.collision.groundHeight(h.pos.x,h.pos.z)+1 }); });
      await page.touchscreen.tap(unitPoint.x + 12, unitPoint.y);
      await page.waitForFunction(id => window.flaghack.session.mobileMode === 'units' && window.flaghack.session.selection.has(id), staged.worker);
      await shot(spec.name + '-selected');
      check(`${spec.name}: tapping a unit in Plan switches to Degen and selects with finger-size tolerance`);
      const selectedBeforeMenu = await state();
      await uiTap(page.locator('.mobile-command').getByRole('button', { name: 'Menu', exact: true }));
      const menu = page.getByRole('dialog', { name: 'Command menu', exact: true });
      await menu.waitFor();
      await shot(spec.name + '-menu');
      const box = await menu.boundingBox(); assert.ok(box && box.width >= spec.width-2 && box.height >= spec.height-2, 'Command menu uses fullscreen');
      await drag({ x: spec.width*.6, y: spec.height*.7 }, { x: spec.width*.6, y: spec.height*.3 });
      const afterMenuScroll = await state();
      assert.equal(afterMenuScroll.camera.cmdX, selectedBeforeMenu.camera.cmdX); assert.equal(afterMenuScroll.camera.cmdZ, selectedBeforeMenu.camera.cmdZ);
      assert.deepEqual(afterMenuScroll.selection, selectedBeforeMenu.selection); assert.deepEqual(afterMenuScroll.plan, selectedBeforeMenu.plan);
      await uiTap(menu.getByRole('button', { name: 'Back to field', exact: true }));
      await menu.waitFor({ state: 'hidden' });
      assert.deepEqual((await state()).selection, selectedBeforeMenu.selection);
      // A neutral target is a real recruit order, not a second own-unit selection.
      const neutralPosition = await page.evaluate(() => { const h=window.flaghack.world.hippies.get(window.__qa.neutral); return {x:h.pos.x,z:h.pos.z}; });
      await centerAt(neutralPosition.x, neutralPosition.z);
      const neutralPoint = await page.evaluate(() => { const h=window.flaghack.world.hippies.get(window.__qa.neutral); return window.__qa.project({ x:h.pos.x,z:h.pos.z,y:window.flaghack.world.collision.groundHeight(h.pos.x,h.pos.z)+1 }); });
      await page.touchscreen.tap(neutralPoint.x, neutralPoint.y);
      await page.waitForFunction(() => window.flaghack.world.hippies.get(window.__qa.worker)?.order?.kind === 'recruit');
      check(`${spec.name}: fullscreen menu scroll is isolated, selection survives return and context recruit works`);

      // Move staged units away, retaining actual plan/build/terrain validation.
      const node = await page.evaluate(() => {
        const a=window.flaghack,w=a.world,fc=w.lattice.facets[window.__qa.facet];
        for(const id of [window.__qa.worker,window.__qa.neutral]) { const h=w.hippies.get(id); h.pos.x+=35;h.pos.z+=35;h.order={kind:'defend',at:{...h.pos}}; }
        a.session.selection.clear();
        const n=fc.nodes.find(i=>!w.lattice.nodes[i].blocked && w.survey.holder[i]!==a.session.playerFaction && window.fh.flags.canPlantAt(w,i,a.session.playerFaction));
        // The home facet may already be held; choose the nearest valid unheld node instead.
        const candidates=w.lattice.nodes.map((p,i)=>({i,p,d:(p.x-fc.cx)**2+(p.z-fc.cz)**2})).filter(({i,p})=>!p.blocked&&w.survey.holder[i]!==a.session.playerFaction&&window.fh.flags.canPlantAt(w,i,a.session.playerFaction)).sort((a,b)=>a.d-b.d);
        const chosen=n===undefined?candidates[0]?.i:n;
        if(chosen===undefined)throw Error('No valid planning node');
        const p=w.lattice.nodes[chosen]; return {id:chosen,x:p.x,z:p.z};
      });
      await centerAt(node.x,node.z);
      await uiTap(modes.getByRole('button', { name: 'Degen', exact: true }));
      const nodePoint=await project(node);
      const planBefore=(await state()).plan;
      await hold(nodePoint);
      await page.waitForFunction(()=>window.flaghack.session.mobileMode==='build');
      assert.deepEqual((await state()).plan,planBefore,'Node longpress changes mode but never toggles plan');
      await page.touchscreen.tap(nodePoint.x,nodePoint.y);
      await page.waitForFunction(id=>window.flaghack.world.factions[window.flaghack.session.playerFaction].plan.has(id),node.id);
      await shot(spec.name+'-plan-node');
      const planAfterTap=(await state()).plan;
      await touch('touchStart',[nodePoint]); await page.waitForTimeout(120); await touch('touchCancel',[]); await page.waitForTimeout(650);
      assert.deepEqual((await state()).plan,planAfterTap,'Cancelled touch never toggles a node');
      check(`${spec.name}: node longpress switches Plan without committing; tap targets node; touchcancel is inert`);

      await centerAt(staged.x,staged.z);
      const facetPoint=await project({x:staged.x,z:staged.z});
      const beforeBuild=(await state()).buildings;
      await hold(facetPoint);
      await menu.waitFor();
      assert.equal((await state()).facet,staged.facet,'Picker retains pressed facet');
      await shot(spec.name+'-building-picker');
      await uiTap(menu.getByRole('button',{name:/Workshop/}).first());
      await menu.waitFor({state:'hidden'});
      const placement=page.locator('.mc-placement'); await placement.waitFor();
      assert.deepEqual((await state()).buildings,beforeBuild,'Choosing building shows preview, not placement');
      await shot(spec.name+'-building-preview');
      await uiTap(placement.getByRole('button',{name:'Cancel',exact:true}));
      assert.deepEqual((await state()).buildings,beforeBuild,'Cancel preserves buildings');
      await hold(facetPoint); await menu.waitFor();
      await uiTap(menu.getByRole('button',{name:/Workshop/}).first()); await placement.waitFor();
      await uiTap(placement.getByRole('button',{name:'Confirm',exact:true}));
      await page.waitForFunction(facet=>[...window.flaghack.world.buildings.values()].some(b=>b.kind==='workshop'&&b.facet===facet),staged.facet);
      await shot(spec.name+'-building-confirmed');
      check(`${spec.name}: facet longpress opens full picker; preview/cancel/confirm uses original building rules`);
      // Rotation during a hold cancels it and preserves the fixed pixels-per-character framing.
      const rotateBefore=await state();
      await touch('touchStart',[{x:spec.width*.4,y:spec.height*.4}]);
      await page.setViewportSize({width:spec.height,height:spec.width});
      await page.waitForTimeout(700); await touch('touchEnd',[]); await page.waitForTimeout(150);
      assert.equal((await state()).menu,null); assert.deepEqual((await state()).plan,rotateBefore.plan);
      await shot(spec.name+'-rotated-field');
      assert.deepEqual(entry.errors,[],spec.name+' has no browser errors');
      check(`${spec.name}: rotation cancels pending hold and no page errors`);
      await context.close();
    }
    results.completed=true;
  } catch(error) {
    results.error=error.stack||String(error);
    if(page&&!page.isClosed()){results.failureState=await state().catch(()=>null);await shot('failure').catch(()=>{});}
    throw error;
  } finally { writeFileSync(join(OUT,'result.json'),JSON.stringify(results,null,2));await browser.close();server.close(); }
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
