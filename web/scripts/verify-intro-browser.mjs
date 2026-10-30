/** Native installed Chrome QA against dist, served under a Pages-style subdirectory.
 * No providers, LIVE_URL, mocked media, disabled sandbox, or cache-disabling routes.
 * Run after a production build (40-character BUILD_ID), with playwright on NODE_PATH.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '../dist');
const OUT = resolve(HERE, '../host-release/intro-smoke');
const PROJECT = '/flaghack-infinity-3d/';
const PREFIX = 'flaghack.startup-cache.v1:';
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.mp4':'video/mp4', '.woff2':'font/woff2', '.woff':'font/woff', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.json':'application/json' };
let gameGate;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!path.startsWith(PROJECT)) { res.writeHead(404).end(); return; }
    const file = resolve(DIST, decodeURIComponent(path.slice(PROJECT.length)) || 'index.html');
    if (!file.startsWith(DIST + '/')) { res.writeHead(404).end(); return; }
    let body;
    try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
    // Hold the actual game module, not the movie/entry, for a deterministic unready check.
    if (/\/main-[^/]+\.js$/.test(file) && gameGate) await gameGate;
    const headers = {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
      // Enforce local-only browser traffic without Playwright routing (which disables cache).
      'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self'; frame-src 'none'; object-src 'none'",
    };
    const size = body.length;
    const rawRange = req.headers.range;
    let status = 200;
    if (rawRange) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
      let start, end;
      if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end(); return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      body = body.subarray(start, end + 1);
      status = 206;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
});
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const specs = [
  { name:'desktop', width:1280, height:720, mobile:false },
  { name:'mobile-portrait', width:390, height:844, mobile:true },
  { name:'mobile-landscape', width:844, height:390, mobile:true },
];
const results = { completed:false, physicalDeviceTest:false, checks:[], scenarios:[] };
const check = label => { results.checks.push(label); console.log('PASS ' + label); };
let page, browser, releaseGame;
const shot = name => page.screenshot({ path:join(OUT, name + '.png'), animations:'disabled' });
const movieState = () => page.locator('#startup-video').evaluate(v => ({
  src:v.currentSrc || v.src, width:v.videoWidth, height:v.videoHeight, duration:v.duration,
  muted:v.muted, defaultMuted:v.defaultMuted, paused:v.paused, time:v.currentTime,
  rate:v.playbackRate, inline:v.playsInline, audioBytes:v.webkitAudioDecodedByteCount ?? 0,
  fit:getComputedStyle(v).objectFit,
}));
async function title() {
  await page.locator('#startup').waitFor({ state:'detached', timeout:180_000 });
  await page.waitForFunction(() => window.flaghack?.session.screen === 'title' && !window.flaghack.startupPending && !document.querySelector('#app').inert);
  await page.locator('.title').waitFor({ state:'visible' });
}
async function remember() {
  await page.waitForFunction(prefix => Object.keys(localStorage).some(k => k.startsWith(prefix)), PREFIX, { timeout:30_000 });
  const record = await page.evaluate(prefix => {
    const key = Object.keys(localStorage).find(k => k.startsWith(prefix));
    return { key, value:JSON.parse(localStorage.getItem(key)) };
  }, PREFIX);
  assert.match(record.value.buildId, /^[a-f0-9]{40}$/, 'Build must have a real production revision');
  assert.ok(record.value.assets.length >= 3, 'Real readiness records the loaded asset proof');
  return record;
}
async function main() {
  mkdirSync(OUT, { recursive:true });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    results.url = origin + PROJECT;
    browser = await chromium.launch({ channel:'chrome', headless:false, chromiumSandbox:true, args:[] });
    for (const spec of specs) {
      const context = await browser.newContext({ viewport:{width:spec.width,height:spec.height}, userAgent:spec.mobile?ANDROID:DESKTOP, hasTouch:spec.mobile, isMobile:spec.mobile, deviceScaleFactor:1, serviceWorkers:'block' });
      const entry = { name:spec.name, pageErrors:[], externalRequests:[], videoRequests:[], phases:[] };
      results.scenarios.push(entry);
      let phase = 'cold';
      page = await context.newPage();
      page.on('pageerror', error => entry.pageErrors.push(error.message));
      page.on('request', req => {
        const url = req.url();
        if (/^https?:/.test(url) && new URL(url).origin !== origin) entry.externalRequests.push(url);
        if (/\.mp4(?:\?|$)/.test(url)) entry.videoRequests.push({ phase, url, range:req.headers().range ?? null });
      });
      // Observational only: detect transient warm src assignments, early Skip enablement,
      // and reloads of the same movie even if the browser satisfies them from cache.
      await page.addInitScript(() => {
        window.__introQa = { sources:[], loadstarts:0, earlySkip:[] };
        document.addEventListener('loadstart', e => {
          if (e.target.id === 'startup-video' && e.target.getAttribute('src')) window.__introQa.loadstarts++;
        }, true);
        new MutationObserver(records => {
          for (const r of records) {
            if (r.target.id === 'startup-video' && r.attributeName === 'src' && r.target.getAttribute('src')) window.__introQa.sources.push(r.target.getAttribute('src'));
          }
          const root = document.querySelector('#startup'), skip = document.querySelector('#startup-skip');
          if (root && skip && !skip.disabled && root.dataset.ready !== 'true') window.__introQa.earlySkip.push(root.dataset.ready ?? null);
        }).observe(document, { subtree:true, childList:true, attributes:true, attributeFilter:['src','disabled','data-ready'] });
      });
      gameGate = new Promise(done => { releaseGame = done; });
      await page.goto(origin + PROJECT + (spec.mobile ? '?view=mobile' : '?view=desktop'), { waitUntil:'domcontentloaded' });
      await page.waitForFunction(() => { const v = document.querySelector('#startup-video'); return v?.videoWidth > 0 && !v.paused && v.currentTime > .15; }, null, { timeout:30_000 });
      const initial = await movieState();
      entry.initial = initial;
      assert.equal(initial.width, spec.mobile ? 720 : 1280);
      assert.equal(initial.height, 720);
      assert.ok(Math.abs(initial.duration - 193.002) < .1, 'Full 193.002-second film');
      assert.equal(initial.muted, true); assert.equal(initial.defaultMuted, true);
      assert.equal(initial.rate, 1); assert.equal(initial.inline, true); assert.equal(initial.fit, 'contain');
      assert.equal(await page.locator('html').getAttribute('data-startup-cache'), 'miss');
      assert.equal(await page.locator('html').getAttribute('data-device-layout'), spec.mobile?'mobile':'desktop');
      assert.equal(await page.locator('#startup-skip').isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#startup').count(), 1, 'Escape cannot reveal an unready game');
      await shot(spec.name + '-cold-loading');
      releaseGame(); gameGate = undefined; releaseGame = undefined;
      await page.getByRole('button', { name:'Sound on', exact:true }).click();
      await page.waitForFunction(() => { const v = document.querySelector('#startup-video'); return !v.muted && !v.paused && v.webkitAudioDecodedByteCount > 0; });
      assert.equal(await page.locator('#startup-sound').getAttribute('aria-pressed'), 'true');
      entry.audible = await movieState();
      await page.getByRole('button', { name:'Mute', exact:true }).click();
      assert.equal((await movieState()).muted, true);
      assert.equal(await page.locator('#startup-sound').getAttribute('aria-pressed'), 'false');
      await page.getByRole('button', { name:'Sound on', exact:true }).waitFor();
      check(`${spec.name}: native full-length ${initial.width}x720 playback, 1x speed, muted autoplay, decoded audio and sound toggle`);
      await page.locator('#startup[data-ready="true"]').waitFor({ timeout:180_000 });
      assert.equal(await page.getByRole('button', {name:'Skip',exact:true}).isEnabled(), true);
      assert.equal((await movieState()).paused, false, 'Ready does not end the movie');
      assert.deepEqual(await page.evaluate(() => window.__introQa.earlySkip), []);
      if (spec.mobile) {
        // The 193-second media range can stay open while Chrome buffers playback.
        // Wait for the real game/font readiness proof, not whole-page network silence.
        // Keep the rotation request-count and source/decoder assertions below intact.
        entry.rotationReadyRecord = await remember();
        const before = await movieState();
        const count = entry.videoRequests.length;
        const observation = await page.evaluate(() => ({...window.__introQa}));
        await page.setViewportSize({ width:spec.height, height:spec.width });
        await page.waitForFunction(t => document.querySelector('#startup-video')?.currentTime > t + .5, before.time);
        const after = await movieState();
        assert.equal(after.src, before.src); assert.equal(after.width, 720); assert.equal(after.height, 720);
        assert.equal(entry.videoRequests.length, count, 'Rotation issues no second video request');
        assert.deepEqual(await page.evaluate(() => window.__introQa), observation, 'Rotation neither replaces source nor reloads decoder');
        await shot(spec.name + '-rotated');
        check(`${spec.name}: rotation preserves square source, playback and request count`);
        await page.setViewportSize({width:spec.width,height:spec.height});
      }
      await shot(spec.name + '-ready');
      entry.record = await remember();
      await page.getByRole('button', {name:'Skip',exact:true}).click();
      await title(); await shot(spec.name + '-title');
      check(`${spec.name}: Skip is gated by readiness and opens the real game title`);
      phase = 'warm';
      await page.reload({ waitUntil:'domcontentloaded' });
      await title();
      assert.equal(await page.locator('html').getAttribute('data-startup-cache'), 'hit');
      assert.deepEqual(entry.videoRequests.filter(r => r.phase === phase), []);
      assert.deepEqual(await page.evaluate(() => window.__introQa.sources), []);
      await shot(spec.name + '-warm-title');
      check(`${spec.name}: same-context verified warm reload never assigns or requests a movie`);
      // Keep real visit metadata while evicting the actual HTTP bodies. A localStorage
      // visit marker must never masquerade as cached JS/CSS/font/title assets.
      phase = 'evicted';
      const saved = await remember();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.clearBrowserCache');
      assert.deepEqual(await page.evaluate(k => JSON.parse(localStorage.getItem(k)), saved.key), saved.value);
      await page.reload({ waitUntil:'domcontentloaded' });
      await page.waitForFunction(() => { const v = document.querySelector('#startup-video'); return v?.videoWidth > 0 && !v.paused && v.currentTime > .15; }, null, {timeout:30_000});
      assert.equal(await page.locator('html').getAttribute('data-startup-cache'), 'miss');
      entry.evicted = await movieState();
      assert.equal(entry.evicted.width, spec.mobile?720:1280);
      // Clearing the HTTP cache can leave Chrome's separate media memory cache alive.
      // Replay must be proved by the real source/decoder/playback, not a new network
      // request: cached movie bytes are fine when the game-asset probes miss.
      entry.evictedObservation = await page.evaluate(() => ({...window.__introQa}));
      assert.deepEqual(entry.evictedObservation.sources, [entry.evicted.src], 'Missing game bodies assign the real intro source again');
      assert.equal(entry.evictedObservation.loadstarts, 1, 'Missing game bodies start the intro decoder again');
      assert.deepEqual(entry.evictedObservation.earlySkip, []);
      await page.waitForFunction(t => document.querySelector('#startup-video')?.currentTime > t + .5, entry.evicted.time);
      await shot(spec.name + '-evicted-cold');
      await page.locator('#startup[data-ready="true"]').waitFor({timeout:180_000});
      await page.getByRole('button', {name:'Skip',exact:true}).click();
      await title();
      check(`${spec.name}: retained visit metadata cannot skip after HTTP cache eviction`);
      assert.deepEqual(entry.pageErrors, []);
      assert.deepEqual(entry.externalRequests, [], 'No external provider or media requests');
      await context.close();
    }
    results.completed = true;
  } catch (error) {
    results.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      results.failureState = await page.evaluate(() => ({ html:document.documentElement.dataset, startup:document.querySelector('#startup')?.outerHTML, qa:window.__introQa })).catch(() => null);
      await shot('failure').catch(() => {});
    }
    throw error;
  } finally {
    releaseGame?.(); gameGate = undefined;
    writeFileSync(join(OUT, 'result.json'), JSON.stringify(results, null, 2));
    await browser?.close();
    await new Promise(done => server.close(done));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
