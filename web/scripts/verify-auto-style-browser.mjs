/** Native Chrome / real Node host proof of automatic human play styles.
 * No match, faction, mode, handshake or world state is injected. Device emulation is
 * browser-only, not a physical Android test. All starts and joins use production UI.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'host-release/auto-style-smoke');
const ORIGIN = 'http://127.0.0.1:18787', PASSWORD = 'native-auto-style-fixture';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const desktop = { name: 'desktop', mobile: false, width: 1280, height: 800, expected: 'avatar' };
const android = { name: 'android', mobile: true, width: 390, height: 844, expected: 'rts' };
const result = { completed: false, physicalDeviceTest: false, fixtureDisclosure: 'Native headful Chrome. Android user-agent/touch/viewport emulation and explicit view overrides only; no injected match or control modes. Real production title/lobby/Join controls and built Node host.', checks: [], scenarios: [], errors: [] };
let browser, host, activePage, hostLog = '';
const check = label => { result.checks.push(label); console.log('PASS ' + label); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function startHost() {
  host = spawn(process.execPath, ['dist-server/main.js', '--port', '18787', '--bind', '127.0.0.1', '--password', PASSWORD, '--name', 'Native automatic style QA'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.on('data', data => { hostLog += data; });
  host.stderr.on('data', data => { hostLog += data; });
  host.on('error', error => { hostLog += String(error); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw Error('Host exited: ' + hostLog);
    try { const r = await fetch(ORIGIN + '/api/info'); if (r.ok) return; } catch {}
    await delay(100);
  }
  throw Error('Built host did not become ready: ' + hostLog);
}
async function stopHost() {
  if (!host) return;
  const process = host; host = null;
  if (process.exitCode === null && process.signalCode === null) {
    const closed = once(process, 'close'); process.kill('SIGTERM'); await closed;
  }
}
async function open(spec) {
  const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, userAgent: spec.mobile ? ANDROID : DESKTOP, hasTouch: spec.mobile, isMobile: spec.mobile, deviceScaleFactor: 1 });
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => result.errors.push({ scenario: spec.name, message: String(error) }));
  await page.goto(ORIGIN + '/' + (spec.query ?? ''), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#startup[data-ready="true"]') || window.flaghack && !window.flaghack.startupPending, null, { timeout: 180_000 });
  if (await page.locator('#startup').count()) await page.getByRole('button', { name: 'Skip', exact: true }).click({ noWaitAfter: true });
  await page.locator('#startup').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.flaghack?.session.screen === 'title' && !window.flaghack.startupPending);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.deviceLayout), spec.expected === 'rts' ? 'mobile' : 'desktop');
  return { context, page, spec };
}
async function press(p, locator) { activePage = p.page; await p.page.bringToFront(); if (p.spec.mobile) await locator.tap({ noWaitAfter: true }); else await locator.click({ noWaitAfter: true }); }
async function noSelector(p, name) {
  const lobby = p.page.locator('.lobby:not(.is-off)'); await lobby.waitFor();
  assert.equal(await lobby.getByLabel('Your play style', { exact: true }).count(), 0);
  assert.equal(await lobby.getByText(/Your play style|Choose before the match/).count(), 0);
  assert.equal(await lobby.locator('select option[value="rts"], select option[value="avatar"]').count(), 0);
  await p.page.screenshot({ path: join(OUT, name + '-lobby.png') });
}
async function matchState(page) {
  await page.waitForFunction(() => window.flaghack?.session.screen === 'playing' && window.flaghack.world, null, { timeout: 90_000 });
  return page.evaluate(() => {
    const a = window.flaghack, w = a.world;
    return { layout: document.documentElement.dataset.deviceLayout, seat: a.session.playerFaction, humans: w.options.humans, rtsFactions: w.options.rtsFactions ?? [], modes: w.factions.map(f => f.controlMode), avatars: w.factions.map((_, i) => !!w.avatarOf(i)), online: !!a.net, build: a.net?.lobby?.settings?.build ?? null };
  });
}
async function solo(spec) {
  const p = await open(spec);
  try {
    await press(p, p.page.getByRole('button', { name: 'Begin the Survey', exact: true }));
    await noSelector(p, spec.name);
    await press(p, p.page.locator('.lobby').getByRole('button', { name: 'Light the burn', exact: true }));
    const state = await matchState(p.page);
    assert.equal(state.online, false);
    assert.deepEqual(state.humans, [state.seat]);
    assert.deepEqual(state.rtsFactions, spec.expected === 'rts' ? [state.seat] : []);
    assert.equal(state.modes[state.seat], spec.expected);
    assert.equal(state.avatars[state.seat], spec.expected === 'avatar');
    for (let i = 0; i < state.modes.length; i++) if (i !== state.seat) {
      const mode = i === 1 ? 'rts' : 'avatar';
      assert.equal(state.modes[i], mode, 'NPC Crow is Degen; other AI defaults stay Regular');
      assert.equal(state.avatars[i], mode === 'avatar');
    }
    await p.page.screenshot({ path: join(OUT, spec.name + '-playing.png') });
    result.scenarios.push({ name: spec.name, state });
    check(spec.name + ': no selector; actual solo start assigns human ' + spec.expected + ' while NPC Crow commands without a body');
  } finally { await p.context.close(); }
}
async function joinHost(p, name) {
  await p.page.bringToFront();
  const form = p.page.locator('.join:not(.is-off)'); await form.waitFor();
  await form.getByPlaceholder('https://your-host.example').fill(ORIGIN);
  await form.getByPlaceholder('Your name at the burn').fill(name);
  await form.getByPlaceholder('From your host').fill(PASSWORD);
  await press(p, form.getByRole('button', { name: 'Join the burn', exact: true }));
  await p.page.waitForFunction(() => window.flaghack?.net?.status === 'lobby', null, { timeout: 30_000 });
  await noSelector(p, name);
}
async function mixed(first, second) {
  // Fresh process guarantees a clean lobby and no left-over disconnected seats.
  await stopHost(); await startHost();
  const leader = await open(first), guest = await open(second);
  const name = first.name + '-leads-' + second.name;
  try {
    await joinHost(leader, name + '-leader'); await joinHost(guest, name + '-guest');
    const expected = [first.expected, second.expected];
    for (const p of [leader, guest]) {
      await p.page.waitForFunction(() => window.flaghack.net.lobby.players.length === 2);
      assert.deepEqual(await p.page.evaluate(() => window.flaghack.net.lobby.players.map(p => ({ seat: p.seat, mode: p.controlMode }))), expected.map((mode, seat) => ({ seat, mode })));
    }
    await press(leader, leader.page.locator('.lobby').getByRole('button', { name: 'Light the burn', exact: true }));
    const states = await Promise.all([matchState(leader.page), matchState(guest.page)]);
    const rts = expected.flatMap((mode, i) => mode === 'rts' ? [i] : []);
    for (const [i, state] of states.entries()) {
      assert.equal(state.online, true); assert.equal(state.seat, i);
      assert.deepEqual(state.humans, [0, 1]); assert.deepEqual(state.rtsFactions, rts);
      assert.deepEqual(state.modes, [...expected, 'avatar', 'avatar']);
      assert.deepEqual(state.avatars, [...expected.map(mode => mode === 'avatar'), true, true]);
    }
    // Reload and rejoin using the browser's real saved reclaim token: host retains seat/style.
    await guest.page.reload({ waitUntil: 'domcontentloaded' });
    await guest.page.waitForFunction(() => document.querySelector('#startup[data-ready="true"]') || window.flaghack && !window.flaghack.startupPending, null, { timeout: 180_000 });
    if (await guest.page.locator('#startup').count()) await guest.page.getByRole('button', { name: 'Skip', exact: true }).click({ noWaitAfter: true });
    await guest.page.locator('#startup').waitFor({ state: 'detached' });
    const form = guest.page.locator('.join:not(.is-off)'); await form.waitFor();
    await form.getByPlaceholder('From your host').fill(PASSWORD);
    await press(guest, form.getByRole('button', { name: 'Join the burn', exact: true }));
    const resumed = await matchState(guest.page);
    assert.equal(resumed.seat, 1); assert.deepEqual(resumed.modes, states[1].modes); assert.deepEqual(resumed.rtsFactions, rts);
    await guest.page.screenshot({ path: join(OUT, name + '-reconnected.png') });
    result.scenarios.push({ name, states, resumed });
    check(name + ': real mixed browser clients agree on independent human styles; AI unchanged; reload/rejoin retains seat');
  } finally { await leader.context.close(); await guest.context.close(); }
}
mkdirSync(OUT, { recursive: true });
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true, args: [] });
  await startHost();
  for (const spec of [desktop, android, { ...desktop, name: 'narrow-pc', width: 390, height: 844 }, { ...android, name: 'android-pc-override', query: '?view=desktop', expected: 'avatar' }, { ...desktop, name: 'pc-mobile-override', query: '?view=mobile', expected: 'rts' }]) await solo(spec);
  await mixed(desktop, android); await mixed(android, desktop);
  assert.deepEqual(result.errors, [], 'No browser runtime errors');
  result.completed = true;
} catch (error) {
  result.error = String(error.stack ?? error); console.error(error);
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
    result.failureState = await activePage.evaluate(() => ({ screen: window.flaghack?.session.screen, layout: document.documentElement.dataset.deviceLayout, joinError: window.flaghack?.joinError, net: window.flaghack?.net?.status })).catch(() => null);
  }
  process.exitCode = 1;
} finally {
  await browser?.close(); await stopHost();
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(OUT, 'host.log'), hostLog);
}
