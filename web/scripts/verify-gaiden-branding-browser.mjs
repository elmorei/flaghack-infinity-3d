/** Native sandboxed Chrome, production dist. Device emulation is not physical-phone QA.
 * Only the startup fallback fixture delays game JS and rejects intro media. All title,
 * navigation, rotation and lobby checks use the actual production UI and renderer.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist'), OUT = join(ROOT, 'host-release/gaiden-branding-smoke');
const PROJECT = '/flaghack-infinity-3d/';
const PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.woff2':'font/woff2', '.json':'application/json', '.webp':'image/webp', '.png':'image/png' };
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (!pathname.startsWith(PROJECT)) { res.writeHead(404).end(); return; }
  const file = resolve(DIST, decodeURIComponent(pathname.slice(PROJECT.length)) || 'index.html');
  if (!file.startsWith(DIST + '/')) { res.writeHead(404).end(); return; }
  try {
    let body = readFileSync(file);
    const headers = { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
      if (start > end || start >= body.length) { res.writeHead(416).end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      body = body.subarray(start, end + 1);
    }
    headers['Content-Length'] = body.length;
    res.writeHead(range ? 206 : 200, headers).end(body);
  } catch { res.writeHead(404).end(); }
});
const report = { completed:false, commit:process.env.GITHUB_SHA || null, physicalDeviceTest:false, renderer:'Native headful Chrome; sandbox enabled; no GPU flags', fixtures:'First phone startup delays main JS and rejects intro media to expose the real fallback brand. All title and navigation checks use the production UI.', scenarios:[], errors:[] };
let browser, activePage;
async function metadata(page, mobile) {
  const name = mobile ? 'Flaghack Gaiden' : 'FLAGHACK∞3D';
  const value = await page.evaluate(() => ({ title:document.title, layout:document.documentElement.dataset.deviceLayout,
    application:document.querySelector('meta[name="application-name"]')?.content,
    apple:document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
    manifest:document.querySelector('link[rel="manifest"]')?.href || null }));
  assert.deepEqual(value, { title:name, layout:mobile?'mobile':'desktop', application:name, apple:name, manifest:null });
  return value;
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#startup[data-ready="true"]') || window.flaghack && !window.flaghack.startupPending, null, { timeout:180000 });
  const skip = page.locator('#startup-skip');
  if (await skip.count() && await skip.isVisible() && await skip.isEnabled()) await skip.click({ noWaitAfter:true });
  await page.locator('#startup').waitFor({ state:'detached', timeout:30000 });
  await page.waitForFunction(() => window.flaghack?.session.screen === 'title' && !window.flaghack.startupPending);
  await page.locator('.title-wordmark').evaluate(image => image.decode());
}
async function title(page, mobile, label) {
  const name = mobile ? 'Flaghack Gaiden' : 'FLAGHACK∞3D';
  const data = await metadata(page, mobile);
  assert.equal(await page.locator('.title-wordmark').getAttribute('alt'), `${name} — SURVEY FLAGS`);
  const art = await page.locator('.title-wordmark').getAttribute('src');
  assert.equal(art.includes('mobile-title-wordmark-'), mobile);
  assert.equal(await page.locator('.warning-label').textContent(), `Under no conditions should you attempt to play a game that claims to be ${name}.`);
  await page.locator('.title-wordmark').scrollIntoViewIfNeeded();
  const box = await page.locator('.title-wordmark').boundingBox(), viewport = page.viewportSize();
  assert.ok(box && box.width > 0 && box.height > 0, `${label}: wordmark renders`);
  const fits = box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1;
  // Forcing the unchanged 560px desktop column onto a phone is a routing test,
  // not a claim that this branding change redesigns the desktop layout.
  if (mobile || viewport.width >= 600) assert.ok(fits, `${label}: logo fits without clipping`);
  if (mobile) assert.equal(await page.locator('.title-wordmark').evaluate(image => getComputedStyle(image).animationName), 'none');
  await page.screenshot({ path:join(OUT, `${label}.png`) });
  return { ...data, artwork:art, bounds:box, fitsViewport:fits };
}
const cases = [
  {name:'phone-portrait',w:390,h:844,ua:PHONE,touch:true,mobile:true,fallback:true},
  {name:'small-phone',w:320,h:568,ua:PHONE,touch:true,mobile:true},
  {name:'phone-landscape',w:844,h:390,ua:PHONE,touch:true,mobile:true},
  {name:'ipad-desktop-ua',w:820,h:1180,ua:IPAD,touch:true,mobile:true},
  {name:'desktop',w:1366,h:768,ua:PC,touch:false,mobile:false},
  {name:'narrow-touch-desktop',w:390,h:844,ua:PC,touch:true,mobile:false},
  {name:'desktop-mobile-override',w:1280,h:720,ua:PC,touch:false,mobile:true,query:'?view=mobile'},
  {name:'phone-desktop-override',w:390,h:844,ua:PHONE,touch:true,mobile:false,query:'?view=desktop'},
];
try {
  mkdirSync(OUT, {recursive:true});
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}${PROJECT}`;
  browser = await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  report.browser = browser.version();
  for (const spec of cases) {
    const context = await browser.newContext({viewport:{width:spec.w,height:spec.h},userAgent:spec.ua,hasTouch:spec.touch,isMobile:spec.ua !== PC,deviceScaleFactor:1});
    const page = await context.newPage(); activePage = page;
    page.on('pageerror', error => report.errors.push({scenario:spec.name,error:String(error)}));
    if (spec.ua === IPAD) await page.addInitScript(() => { Object.defineProperty(navigator,'platform',{get:()=>'MacIntel'}); Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5}); });
    let release;
    if (spec.fallback) {
      const held = new Promise(done => { release = done; });
      await page.route('**/assets/main-*.js', async route => { await held; await route.continue(); });
      await page.route('**/*.mp4', route => route.abort());
    }
    await page.goto(base + (spec.query || ''), {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => !!document.documentElement.dataset.deviceLayout);
    const entry = {name:spec.name,startup:await metadata(page,spec.mobile)}; report.scenarios.push(entry);
    if (spec.fallback) {
      assert.equal(await page.locator('#startup').getAttribute('aria-label'), `${entry.startup.title} startup`);
      assert.equal(await page.locator('.startup-brand').textContent(), entry.startup.title);
      await page.locator('.startup-brand').waitFor({state:'visible'});
      await page.screenshot({path:join(OUT,'phone-loading-fallback.png')});
      assert.equal(await page.locator('#app').evaluate(app=>app.inert),true);
      release();
    }
    await ready(page); entry.title = await title(page,spec.mobile,spec.name);
    if (spec.fallback) {
      await page.unrouteAll({behavior:'wait'});
      await page.getByRole('button',{name:'Begin the Survey',exact:true}).click();
      await page.locator('.lobby').getByRole('button',{name:'Back to title',exact:true}).click();
      await title(page,true,'phone-return-from-lobby');
      await page.setViewportSize({width:844,height:390});
      await title(page,true,'phone-rotated');
      await page.setViewportSize({width:390,height:844});
      await page.reload({waitUntil:'domcontentloaded'}); await ready(page);
      entry.reload = await title(page,true,'phone-reloaded');
      const pc = page.getByRole('link',{name:'FLAGHACK∞3D · PC',exact:true});
      await pc.click(); await ready(page); entry.pcOverride = await title(page,false,'phone-switched-to-pc');
      await page.goBack({waitUntil:'domcontentloaded'}); await ready(page);
      entry.back = await title(page,true,'phone-back-to-gaiden');
    }
    assert.equal(report.errors.filter(error=>error.scenario===spec.name).length,0,`${spec.name}: no page errors`);
    console.log(`PASS ${spec.name}: ${entry.title.title}`);
    await context.close(); activePage = null;
  }
  report.completed = true;
} catch (error) {
  report.error = String(error?.stack || error); process.exitCode = 1;
  if (activePage) await activePage.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});
} finally {
  writeFileSync(join(OUT,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  await browser?.close(); server.close();
}
