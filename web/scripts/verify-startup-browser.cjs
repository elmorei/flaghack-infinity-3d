'use strict';
/** Real browser smoke, run by CI beside its temporary local static server. No runtime dependency. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { chromium } = require('playwright');

const DIST = resolve(__dirname, '../dist');
const OUT = resolve(__dirname, '../host-release/startup-smoke');
const PROJECT = '/flaghack-infinity-3d/';
const CACHE_PREFIX = 'flaghack.startup-cache.v1:';
const requests = [];
let failMedia = false;
let failGame = false;
let noStoreTitle = false;
let holdGame = true;
const heldGameResponses = [];
function releaseGame() {
  holdGame = false;
  for (const send of heldGameResponses.splice(0)) send();
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  requests.push(path);
  if (!path.startsWith(PROJECT)) { res.writeHead(404); res.end(); return; }
  const relative = decodeURIComponent(path.slice(PROJECT.length)) || 'index.html';
  const file = resolve(DIST, relative);
  if (!file.startsWith(DIST + '/')) { res.writeHead(404); res.end(); return; }
  if ((failMedia && extname(file) === '.mp4') || (failGame && /\/main-[^/]+\.js$/.test(file))) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return;
  }
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  const headers = {
    'Content-Type': types[extname(file)] || 'application/octet-stream',
    'Cache-Control': noStoreTitle && /title-wordmark-.*\.svg$/.test(relative) ? 'no-store' : relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Accept-Ranges': 'bytes',
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]), end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
    if (start > end || start >= body.length) { res.writeHead(416); res.end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
    body = body.subarray(start, end + 1);
  }
  headers['Content-Length'] = body.length;
  const send = () => { res.writeHead(range ? 206 : 200, headers); res.end(body); };
  // Real server delay, not routing interception (which would disable HTTP cache).
  if (holdGame && /\/main-[^/]+\.js$/.test(file)) heldGameResponses.push(send);
  else send();
});

async function main() {
  mkdirSync(OUT, { recursive: true });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}${PROJECT}`;
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    chromiumSandbox: true,
    args: [], // Stock macOS Chrome uses its supported native Metal backend.
  });
  const results = { checks: [], requests, completed: false };
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const makePlaybackPage = async (context) => {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__introMedia = { plays: 0, srcChanges: 0 };
      new MutationObserver((records) => {
        window.__introMedia.srcChanges += records.filter((record) => record.target.id === 'startup-video').length;
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['src'] });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        // Test-only loop keeps the ready state observable on slow CI GPUs. The actual
        // 25 s MP4 still decodes normally; the natural-ending case explicitly turns this off.
        if (this.id === 'startup-video') { this.loop = true; window.__introMedia.plays++; }
        return play.call(this);
      };
    });
    return page;
  };
  const page = await makePlaybackPage(context);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const check = (label) => { results.checks.push(label); console.log(`PASS ${label}`); };
  const mediaRequests = () => requests.filter((path) => path.endsWith('.mp4')).length;
  const ready = () => page.locator('#startup[data-ready="true"]').waitFor({ timeout: 180_000 });
  const leave = async () => {
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.locator('#startup').waitFor({ state: 'detached' });
  };
  const readState = () => page.evaluate(() => ({
    cache: document.documentElement.dataset.startupCache,
    pending: window.flaghack.startupPending,
    time: window.flaghack.world.time,
    screen: window.flaghack.session.screen,
    audio: window.flaghack.audio.stats().state,
    inert: document.getElementById('app').inert,
    videoTime: document.querySelector('video')?.currentTime,
  }));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('video')?.getAttribute('src'));
    assert.equal(await page.getByRole('button', { name: 'Loading…', exact: true }).isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
    assert.equal(await page.locator('video').evaluate((video) => video.duration), 30);
    releaseGame();
    await ready();
    let state = await readState();
    assert.equal(state.cache, 'miss'); assert.equal(state.pending, true); assert.equal(state.screen, 'title');
    assert.equal(state.audio, 'locked'); assert.equal(state.inert, true);
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
    assert.equal((await readState()).time, state.time, 'Simulation must not advance behind the intro');
    assert.equal(await page.locator('#startup-sound').isVisible(), false, 'Silent montage must not offer a dead sound toggle');
    await page.screenshot({ path: join(OUT, 'cold-ready.png') });
    check('cold video plays while title prepares; ready enables Skip without cutting playback');
    await leave();
    state = await readState(); assert.equal(state.pending, false); assert.equal(state.inert, false);
    await page.waitForFunction((prefix) => Object.keys(localStorage).some((key) => key.startsWith(prefix)), CACHE_PREFIX);
    const record = await page.evaluate((prefix) => JSON.parse(localStorage[Object.keys(localStorage).find((key) => key.startsWith(prefix))]), CACHE_PREFIX);
    assert.ok(record.assets.some((asset) => /main-.*\.js$/.test(asset)));
    assert.ok(record.assets.some((asset) => /main-.*\.css$/.test(asset)));
    assert.ok(record.assets.some((asset) => /title-wordmark-.*\.svg$/.test(asset)));
    check('Skip releases the game; cache proof includes real module, styles, fonts and title image');

    const beforeWarm = mediaRequests();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#startup').waitFor({ state: 'detached', timeout: 180_000 });
    assert.equal((await readState()).cache, 'hit'); assert.equal(mediaRequests(), beforeWarm);
    assert.deepEqual(await page.evaluate(() => window.__introMedia), { plays: 0, srcChanges: 0 });
    check('verified warm reload never requests video bytes');

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    assert.equal((await readState()).cache, 'miss'); assert.ok(mediaRequests() > beforeWarm);
    await leave(); check('clearing HTTP cache replays intro even with visit metadata retained');

    await page.evaluate((prefix) => {
      const key = Object.keys(localStorage).find((item) => item.startsWith(prefix));
      const record = JSON.parse(localStorage[key]); record.buildId = '0'.repeat(40); localStorage[key] = JSON.stringify(record);
    }, CACHE_PREFIX);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    assert.equal((await readState()).cache, 'miss'); check('different source build cannot use the previous warm marker');
    await page.evaluate(() => {
      const video = document.querySelector('video'); video.loop = false; video.currentTime = Math.max(0, video.duration - 0.25);
    });
    await page.locator('#startup').waitFor({ state: 'detached', timeout: 10_000 });
    assert.equal((await readState()).pending, false); check('natural video ending releases an already-ready game');

    noStoreTitle = true;
    const partialContext = await browser.newContext(); const partial = await makePlaybackPage(partialContext);
    await partial.goto(url, { waitUntil: 'domcontentloaded' });
    await partial.locator('#startup[data-ready="true"]').waitFor({ timeout: 180_000 });
    await partial.getByRole('button', { name: 'Skip', exact: true }).click();
    await partial.waitForFunction((prefix) => Object.keys(localStorage).some((key) => key.startsWith(prefix)), CACHE_PREFIX);
    await partial.reload({ waitUntil: 'domcontentloaded' });
    await partial.waitForFunction(() => document.documentElement.dataset.startupCache === 'miss');
    await partial.waitForFunction(() => !!document.querySelector('video')?.getAttribute('src'));
    await partialContext.close(); noStoreTitle = false;
    check('one uncached required title asset prevents false warm bypass while other assets are cached');

    holdGame = true;
    const slowContext = await browser.newContext(); const slow = await slowContext.newPage();
    await slow.goto(url, { waitUntil: 'domcontentloaded' });
    await slow.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    await slow.evaluate(() => {
      const video = document.querySelector('video'); video.currentTime = video.duration - 0.25;
    });
    await slow.waitForFunction(() => document.querySelector('video')?.ended === true);
    assert.equal(await slow.getByRole('button', { name: 'Loading…', exact: true }).isDisabled(), true);
    assert.ok(await slow.locator('video').getAttribute('src'));
    assert.equal(await slow.locator('#startup').getAttribute('data-video'), 'playing');
    await slow.screenshot({ path: join(OUT, 'ended-still-loading.png') });
    releaseGame();
    await slow.locator('#startup').waitFor({ state: 'detached', timeout: 180_000 });
    assert.equal(await slow.evaluate(() => window.flaghack.startupPending), false);
    await slowContext.close(); check('video ending before readiness retains its last frame and Loading until game readiness');

    const autoplayContext = await browser.newContext();
    const autoplay = await autoplayContext.newPage();
    await autoplay.addInitScript(() => { HTMLMediaElement.prototype.play = function () { return Promise.reject(new Error('Test: autoplay blocked')); }; });
    await autoplay.goto(url, { waitUntil: 'domcontentloaded' });
    await autoplay.locator('#startup').waitFor({ state: 'detached', timeout: 180_000 });
    assert.equal(await autoplay.evaluate(() => window.flaghack.startupPending), false);
    await autoplayContext.close(); check('blocked autoplay cannot block game startup');

    failMedia = true;
    const missingContext = await browser.newContext(); const missing = await missingContext.newPage();
    await missing.goto(url, { waitUntil: 'domcontentloaded' });
    await missing.locator('#startup').waitFor({ state: 'detached', timeout: 180_000 });
    assert.equal(await missing.evaluate(() => window.flaghack.startupPending), false);
    await missingContext.close(); failMedia = false; check('missing media falls back to ordinary loading');

    failGame = true;
    const failureContext = await browser.newContext(); const failure = await failureContext.newPage();
    await failure.goto(url, { waitUntil: 'domcontentloaded' });
    await failure.getByRole('button', { name: 'Reload', exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(await failure.locator('#app').getAttribute('inert'), '');
    await failureContext.close(); failGame = false; check('game-code failure presents Reload instead of exposing an unready game');
    assert.deepEqual(pageErrors, []);
    results.completed = true;
  } catch (error) {
    results.error = error.stack || String(error);
    await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    writeFileSync(join(OUT, 'result.json'), JSON.stringify(results, null, 2));
    releaseGame(); await browser.close(); server.close();
  }
}
main().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
