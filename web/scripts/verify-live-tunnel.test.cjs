'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runLiveTunnelSmoke, authenticateWebSocket, PAGES_ORIGIN } = require('./verify-live-tunnel.cjs');
const BUILD = 'a'.repeat(40);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'flaghack-live-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let password;
  const local = { build: BUILD, protocol: 14, instanceId: 'exact-instance' };
  const host = { port: 12345, instanceId: local.instanceId, close: async () => { calls.push('host-close'); } };
  const tunnel = { url: 'https://smoke.trycloudflare.com', exited: new Promise(() => {}), stop: async () => { calls.push('tunnel-stop'); } };
  const options = {
    root, platform: 'win32', expectedBuild: BUILD, onStage: value => calls.push(value),
    loadHost: async () => ({ BUILD_ID: BUILD, PROTOCOL_VERSION: 14, startHost: async args => {
      assert.equal(args.bind, '127.0.0.1'); assert.equal(args.port, 0); assert.equal(args.staticDir, null);
      assert.deepEqual(args.allowedOrigins, [PAGES_ORIGIN]);
      password = args.password; calls.push('host-start'); return host;
    } }),
    checkBinary: async path => { assert.match(path, /cloudflared\.exe$/); calls.push('checksum'); },
    startTunnel: async args => { assert.equal(args.port, host.port); calls.push('tunnel-create'); return tunnel; },
    read: async () => local,
    verify: async (url, info, options) => { assert.equal(url, tunnel.url); assert.equal(info, local); assert.equal(options.pagesOrigin, PAGES_ORIGIN); calls.push('public-match-and-cors'); },
    authenticate: async (_url, options) => { assert.equal(options.password, password); assert.equal(options.build, BUILD); assert.equal(options.protocol, 14); assert.equal(options.instanceId, host.instanceId); calls.push('hello'); },
  };
  return { root, calls, host, tunnel, local, options, password: () => password };
}

test('single successful live smoke writes pass only after both processes are closed, never secrets', async t => {
  const fixture = await setup(t);
  const report = await runLiveTunnelSmoke(fixture.options);
  assert.deepEqual(report, { ok: true, build: BUILD, stage: 'complete' });
  assert.equal(fixture.calls.filter(value => value === 'tunnel-create').length, 1);
  assert.ok(fixture.calls.includes('public-match-and-cors')); assert.ok(fixture.calls.includes('hello'));
  assert.deepEqual(fixture.calls.slice(-2), ['tunnel-stop', 'host-close']);
  const saved = await readFile(join(fixture.root, 'host-release/live-tunnel-smoke.json'), 'utf8');
  assert.doesNotMatch(saved, /password|trycloudflare|token/);
  assert.ok(!saved.includes(fixture.password()));
});

test('provider failure remains a failed report and closes the host without another tunnel attempt', async t => {
  const fixture = await setup(t); let attempts = 0;
  fixture.options.startTunnel = async () => { attempts++; throw new Error('Provider unavailable'); };
  const report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false); assert.equal(report.stage, 'tunnel-start'); assert.match(report.error, /Provider unavailable/);
  assert.equal(attempts, 1); assert.ok(fixture.calls.includes('host-close'));
});

test('discovery mismatch fails before hello and still closes tunnel plus host', async t => {
  const fixture = await setup(t);
  fixture.options.verify = async () => { throw new Error('Wrong host instance'); };
  const report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false); assert.equal(report.stage, 'public-discovery');
  assert.ok(!fixture.calls.includes('hello'));
  assert.deepEqual(fixture.calls.slice(-2), ['tunnel-stop', 'host-close']);
});

test('time limit aborts propagation and reserves time to clean up', async t => {
  const fixture = await setup(t); fixture.options.timeoutMs = 100;
  fixture.options.verify = async (_url, _info, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false); assert.match(report.error, /time limit/);
  assert.deepEqual(fixture.calls.slice(-2), ['tunnel-stop', 'host-close']);
});

test('CI cancellation still writes failure and closes the temporary resources', async t => {
  const fixture = await setup(t); const controller = new AbortController();
  fixture.options.signal = controller.signal;
  fixture.options.verify = async () => { controller.abort(); throw new Error('aborted'); };
  const report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false); assert.match(report.error, /cancelled/);
  assert.deepEqual(fixture.calls.slice(-2), ['tunnel-stop', 'host-close']);
});

test('failed cleanup never produces a passing result', async t => {
  const fixture = await setup(t);
  fixture.tunnel.stop = async () => { throw new Error('Helper did not stop'); };
  const report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false); assert.equal(report.stage, 'cleanup'); assert.match(report.error, /Helper did not stop/);
  assert.ok(fixture.calls.includes('host-close'));
});

test('wrong platform or checksum cannot launch a public tunnel', async t => {
  const fixture = await setup(t); fixture.options.platform = 'linux';
  let report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false); assert.match(report.error, /Windows/);
  assert.ok(!fixture.calls.includes('host-start'));
  fixture.options.platform = 'win32'; fixture.options.checkBinary = async () => { throw new Error('Checksum mismatch'); };
  report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false); assert.match(report.error, /Checksum/);
  assert.ok(!fixture.calls.includes('host-start'));
});

test('errors redact password and temporary endpoint', async t => {
  const fixture = await setup(t);
  fixture.options.authenticate = async () => { throw new Error('failed password=' + fixture.password() + ' at ' + fixture.tunnel.url); };
  const report = await runLiveTunnelSmoke(fixture.options);
  assert.equal(report.ok, false);
  assert.ok(!report.error.includes(fixture.password())); assert.ok(!report.error.includes('trycloudflare'));
});

function socketFixture() {
  let instance;
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; instance = this; }
    send(value) { this.sent = JSON.parse(value); }
    close() { this.closed = true; setImmediate(() => this.emit('close')); }
    terminate() { this.terminated = true; setImmediate(() => this.emit('close')); }
  }
  return { Socket, current: () => instance };
}

test('WSS hello checks build/protocol and waits until socket is closed without exposing welcome token', async () => {
  const fixture = socketFixture();
  const work = authenticateWebSocket('https://smoke.trycloudflare.com', { password: 'test-secret', build: BUILD, protocol: 14, instanceId: 'match-instance', WebSocketImpl: fixture.Socket });
  const socket = fixture.current();
  assert.equal(socket.url, 'wss://smoke.trycloudflare.com/ws');
  assert.equal(socket.options.origin, PAGES_ORIGIN); assert.equal(socket.options.followRedirects, false); assert.equal(socket.options.rejectUnauthorized, true);
  socket.emit('upgrade', { headers: { 'x-flaghack-instance': 'match-instance', 'x-flaghack-build': BUILD, 'x-flaghack-protocol': '14' } });
  socket.emit('open');
  assert.deepEqual(socket.sent, { t: 'hello', protocol: 14, build: BUILD, name: 'CI tunnel check', password: 'test-secret', token: null });
  socket.emit('message', Buffer.from(JSON.stringify({ t: 'welcome', build: BUILD, protocol: 14, token: 'RECONNECT_SECRET' })));
  await work;
  assert.equal(socket.closed, true);
});

test('WSS rejects mismatched or denied hello and terminates socket without payload disclosure', async () => {
  for (const message of [{ t: 'welcome', build: 'b'.repeat(40), protocol: 14, token: 'SECRET' }, { t: 'denied', reason: 'SECRET' }]) {
    const fixture = socketFixture();
    const work = authenticateWebSocket('https://smoke.trycloudflare.com', { password: 'pw', build: BUILD, protocol: 14, instanceId: 'match-instance', WebSocketImpl: fixture.Socket });
    fixture.current().emit('upgrade', { headers: { 'x-flaghack-instance': 'match-instance', 'x-flaghack-build': BUILD, 'x-flaghack-protocol': '14' } });
    fixture.current().emit('open'); fixture.current().emit('message', Buffer.from(JSON.stringify(message)));
    await assert.rejects(work, error => !error.message.includes('SECRET'));
    assert.equal(fixture.current().terminated, true);
  }
});

test('authenticated WebSocket never sends the password to an upgrade for a different instance', async () => {
  const fixture = socketFixture();
  const work = authenticateWebSocket('https://smoke.trycloudflare.com', { password: 'pw', build: BUILD, protocol: 14, instanceId: 'wanted-instance', WebSocketImpl: fixture.Socket });
  fixture.current().emit('upgrade', { headers: { 'x-flaghack-instance': 'different-instance', 'x-flaghack-build': BUILD, 'x-flaghack-protocol': '14' } });
  fixture.current().emit('open');
  await assert.rejects(work, /did not match/);
  assert.equal(fixture.current().sent, undefined);
  assert.equal(fixture.current().terminated, true);
});

test('WSS abort terminates an in-progress authenticated connection', async () => {
  const fixture = socketFixture(); const abort = new AbortController();
  const work = authenticateWebSocket('https://smoke.trycloudflare.com', { password: 'pw', build: BUILD, protocol: 14, WebSocketImpl: fixture.Socket, signal: abort.signal });
  abort.abort(); await assert.rejects(work, /cancelled/);
  assert.equal(fixture.current().terminated, true);
});
