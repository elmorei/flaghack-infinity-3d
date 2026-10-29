'use strict';
/** Real native-Chrome rendering with mobile device emulation, not physical-device certification. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { chromium } = require('playwright');
const DIST = resolve(__dirname, '../dist');
const OUT = resolve(__dirname, '../host-release/mobile-smoke');
const PROJECT = '/flaghack-infinity-3d/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!path.startsWith(PROJECT)) { res.writeHead(404); res.end(); return; }
  const relative = decodeURIComponent(path.slice(PROJECT.length)) || 'index.html';
  const file = resolve(DIST, relative);
  if (!file.startsWith(DIST + '/')) { res.writeHead(404); res.end(); return; }
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  const headers = { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]), end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
    if (start > end || start >= body.length) { res.writeHead(416); res.end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
    body = body.subarray(start, end + 1);
  }
  headers['Content-Length'] = body.length;
  res.writeHead(range ? 206 : 200, headers); res.end(body);
});
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const cases = [
  { name: 'iphone-portrait', width: 390, height: 844, ua: IPHONE, touch: true, mobile: true, full: true, rotate: true },
  { name: 'small-phone-portrait', width: 320, height: 568, ua: IPHONE, touch: true, mobile: true, full: true },
  { name: 'android-landscape', width: 844, height: 390, ua: ANDROID, touch: true, mobile: true, full: true },
  { name: 'ipad-portrait', width: 820, height: 1180, ua: IPAD, touch: true, mobile: true, maxTouchPoints: 5 },
  { name: 'desktop-touchscreen', width: 1366, height: 768, ua: DESKTOP, touch: true, mobile: false, full: true },
  { name: 'phone-desktop-override', width: 390, height: 844, ua: IPHONE, touch: true, mobile: false, query: '?view=desktop', routingOnly: true },
  { name: 'desktop-mobile-override', width: 1280, height: 720, ua: DESKTOP, touch: false, mobile: true, query: '?view=mobile', routingOnly: true },
];
async function main() {
  mkdirSync(OUT, { recursive: true });
  if (!process.env.LIVE_URL) await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = process.env.LIVE_URL || `http://127.0.0.1:${server.address().port}${PROJECT}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true, args: [] });
  const results = { url, checks: [], scenarios: [], completed: false, physicalDeviceTest: false };
  let page;
  const check = label => { results.checks.push(label); console.log(`PASS ${label}`); };
  const shot = name => page.screenshot({ path: join(OUT, name + '.png') });
  const tap = async (locator, touch) => {
    await locator.scrollIntoViewIfNeeded();
    if (touch) await locator.tap({ noWaitAfter: true });
    else await locator.click({ noWaitAfter: true });
  };
  async function fits(locator, label) {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box, `${label} exists`);
    assert.ok(box.x >= -1 && box.x + box.width <= viewport.width + 1, `${label} fits horizontally: ${JSON.stringify(box)}`);
  }
  async function touchTarget(locator, label) {
    const box = await locator.boundingBox();
    assert.ok(box && box.width >= 43 && box.height >= 43, `${label} has a 44px touch target: ${JSON.stringify(box)}`);
  }
  try {
    for (const spec of cases) {
      const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, userAgent: spec.ua, hasTouch: spec.touch, isMobile: spec.mobile && spec.ua !== DESKTOP, deviceScaleFactor: 1 });
      page = await context.newPage();
      const entry = { name: spec.name, pageErrors: [], mediaRequests: [] };
      results.scenarios.push(entry);
      page.on('pageerror', error => entry.pageErrors.push(error.message));
      page.on('request', request => { if (/\.mp4(?:\?|$)/.test(request.url())) entry.mediaRequests.push(request.url()); });
      await page.addInitScript(({ maxTouchPoints }) => {
        if (maxTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', { get: () => maxTouchPoints });
        // Keep actual video playing until Skip can be tested, even on a slow native GPU.
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () { if (this.id === 'startup-video') this.loop = true; return play.call(this); };
      }, { maxTouchPoints: spec.maxTouchPoints });
      await page.goto(url + (spec.query || ''), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!document.documentElement.dataset.deviceLayout);
      entry.layout = await page.evaluate(() => document.documentElement.dataset.deviceLayout);
      assert.equal(entry.layout, spec.mobile ? 'mobile' : 'desktop', spec.name);
      check(`${spec.name}: correct automatic/explicit layout`);
      if (spec.routingOnly) { await context.close(); continue; }
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1, null, { timeout: 180_000 });
      entry.media = await page.locator('video').evaluate(v => ({ src: v.currentSrc, duration: v.duration, width: v.videoWidth, height: v.videoHeight }));
      assert.equal(entry.media.duration, 25);
      assert.equal(new Set(entry.mediaRequests.map(value => new URL(value).pathname)).size, 1, 'Only the selected intro should download');
      if (spec.mobile && spec.width < spec.height) assert.ok(entry.media.width < entry.media.height && /mobile/.test(entry.media.src), 'portrait device decodes cropped mobile video');
      else assert.ok(entry.media.width > entry.media.height, 'landscape/desktop decodes widescreen original');
      await page.locator('#startup[data-ready="true"]').waitFor({ timeout: 180_000 });
      const skip = page.getByRole('button', { name: 'Skip', exact: true });
      await fits(skip, `${spec.name} Skip`);
      if (spec.mobile) await touchTarget(skip, 'Skip');
      await shot(spec.name + '-intro');
      await tap(skip, spec.touch);
      await page.locator('#startup').waitFor({ state: 'detached', timeout: 30_000 });
      await page.waitForFunction(() => window.flaghack?.session.screen === 'title' && !window.flaghack.startupPending);
      assert.equal(await page.getByText(/Download Windows host|Windows launcher/i).count(), 0);
      await fits(page.locator('.title-wordmark'), `${spec.name} title wordmark`);
      await shot(spec.name + '-title');
      check(`${spec.name}: actual video decodes and touch/click Skip opens title without launcher references`);
      if (spec.full) {
        const title = page.locator('.title');
        const begin = title.getByRole('button', { name: 'Begin the Survey', exact: true });
        await fits(begin, 'Begin');
        if (spec.mobile) await touchTarget(begin, 'Begin');
        await tap(title.getByRole('button', { name: 'Settings', exact: true }), spec.touch);
        const settings = page.locator('.settings:not(.is-off)');
        await settings.waitFor();
        await fits(settings.locator('.settings-box'), 'Settings box');
        await shot(spec.name + '-settings');
        if (spec.mobile) {
          await tap(settings.locator('.control-settings summary'), spec.touch);
          const controls = settings.locator('.control-settings');
          await fits(controls, 'Control settings scroll region');
          await controls.evaluate(el => { el.scrollLeft = el.scrollWidth; });
          assert.ok(await controls.evaluate(el => el.scrollWidth <= el.clientWidth || el.scrollLeft > 0), 'Wide controls can scroll horizontally');
          await shot(spec.name + '-controls');
          await controls.evaluate(el => { el.scrollLeft = 0; });
          await tap(controls.locator('summary'), spec.touch);
        }
        const done = settings.getByRole('button', { name: 'Done', exact: true });
        await tap(done, spec.touch);
        await settings.waitFor({ state: 'hidden' });
        await tap(title.getByRole('button', { name: 'Liber HH', exact: true }), spec.touch);
        const codex = page.locator('.codex:not(.is-off)');
        await codex.waitFor();
        await fits(codex.locator('.codex-book'), 'Liber HH book');
        await tap(codex.locator('.codex-tab').last(), spec.touch);
        await shot(spec.name + '-liber');
        await tap(codex.locator('.codex-x'), spec.touch);
        await codex.waitFor({ state: 'hidden' });
        await tap(begin, spec.touch);
        const lobby = page.locator('.lobby:not(.is-off)');
        await lobby.waitFor();
        await fits(lobby.locator('.lobby-box'), 'Lobby box');
        await shot(spec.name + '-lobby');
        const advancedButton = lobby.getByRole('button', { name: 'Advanced Game Settings', exact: true });
        await tap(advancedButton, spec.touch);
        const advanced = page.locator('.advanced-settings:not(.is-off)');
        await advanced.waitFor();
        await fits(advanced.locator('.advanced-box'), 'Advanced box');
        await shot(spec.name + '-advanced');
        // The final field must be reachable through the real scroll container.
        const lastField = advanced.locator('input[type="number"]').last();
        await lastField.scrollIntoViewIfNeeded();
        await fits(lastField, 'Last advanced field');
        const before = await lastField.inputValue();
        await lastField.fill(before); await lastField.blur();
        await tap(advanced.getByRole('button', { name: 'Done', exact: true }), spec.touch);
        await advanced.waitFor({ state: 'hidden' });
        assert.equal(await lobby.getAttribute('inert'), null, 'Closing advanced restores lobby interaction');
        // Repeated open/close must not leave the lobby inert.
        await tap(advancedButton, spec.touch);
        await tap(page.getByRole('button', { name: 'Close advanced game settings', exact: true }), spec.touch);
        await advanced.waitFor({ state: 'hidden' });
        if (spec.rotate) {
          await page.setViewportSize({ width: spec.height, height: spec.width });
          await fits(lobby.locator('.lobby-box'), 'Rotated landscape lobby');
          await shot(spec.name + '-rotated-lobby');
          assert.equal(new Set(entry.mediaRequests.map(value => new URL(value).pathname)).size, 1, 'Rotation must not fetch a second movie');
          await tap(advancedButton, spec.touch);
          await fits(advanced.locator('.advanced-box'), 'Rotated landscape advanced box');
          await shot(spec.name + '-rotated-advanced');
          await tap(advanced.getByRole('button', { name: 'Done', exact: true }), spec.touch);
        }
        await tap(lobby.getByRole('button', { name: 'Back to title', exact: true }), spec.touch);
        await title.waitFor({ state: 'visible' });
        check(`${spec.name}: settings, scrollable lobby/advanced fields, repeated dismissal${spec.rotate ? ' and orientation change' : ''}`);
      }
      assert.deepEqual(entry.pageErrors, [], `${spec.name} has no page errors`);
      await context.close();
    }
    results.completed = true;
  } catch (error) {
    results.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      results.failureState = await page.evaluate(() => ({ layout: document.documentElement.dataset.deviceLayout, screen: window.flaghack?.session.screen, pending: window.flaghack?.startupPending, ready: document.getElementById('startup')?.dataset.ready })).catch(() => null);
      await shot('failure').catch(() => {});
    }
    throw error;
  } finally {
    writeFileSync(join(OUT, 'result.json'), JSON.stringify(results, null, 2));
    await browser.close(); server.close();
  }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
