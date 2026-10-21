'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostController } = require('./controller.cjs');
const { DEFAULT_PAGES_URL } = require('./security.cjs');
const config = { serverName: 'Host', port: 8787, mode: 'quick', pagesUrl: DEFAULT_PAGES_URL };
const info = { protocol: 14, build: 'abc', instanceId: 'instance', phase: 'lobby', players: 0, seated: 0 };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const counts = { hosts: 0, tunnels: 0, hostStops: 0, tunnelStops: 0, verifies: 0 };
  const tunnelExit = deferred(); let hostOptions;
  const controller = createHostController({
    startHost: async options => { counts.hosts++; hostOptions = options; return { port: 8787, stop: async () => { counts.hostStops++; } }; },
    startTunnel: async () => { counts.tunnels++; return { url: 'https://abc.trycloudflare.com', stop: async () => { counts.tunnelStops++; }, exited: tunnelExit.promise }; },
    read: async () => info, verify: async () => { counts.verifies++; }, makePassword: () => 'private-secret', pollMs: 100000,
    ...overrides,
  });
  return { controller, counts, tunnelExit, hostOptions: () => hostOptions };
}
test('starts exactly one loopback host; verifies before invite; stops both resources', async () => {
  const { controller, counts, hostOptions } = fixture();
  const first = controller.start(config); await controller.start(config); const state = await first;
  assert.equal(state.status, 'running'); assert.equal(counts.hosts, 1); assert.equal(counts.verifies, 1);
  assert.deepEqual(hostOptions().allowedOrigins, ['https://elmorei.github.io']);
  assert.equal(new URLSearchParams(new URL(state.invite).hash.slice(1)).get('pw'), 'private-secret');
  await controller.stop(); assert.equal(controller.getState().status, 'idle'); assert.equal(counts.hostStops, 1); assert.equal(counts.tunnelStops, 1); assert.equal(controller.getState().password, null);
});
test('existing endpoint skips Cloudflare and still verifies exact host', async () => {
  const { controller, counts } = fixture();
  await controller.start({ ...config, mode: 'existing', endpoint: 'https://own.example.com' });
  assert.equal(counts.tunnels, 0); assert.equal(counts.verifies, 1); await controller.dispose();
});
test('invalid options never launch a process', async () => {
  const { controller, counts } = fixture(); await controller.start({ ...config, port: 80 }); assert.equal(counts.hosts, 0); assert.equal(controller.getState().status, 'error');
});
test('cancel during delayed host startup cleans a late resource and rejects racing restart', async () => {
  const pending = deferred(); let stops = 0;
  const { controller, counts } = fixture({ startHost: () => pending.promise });
  const starting = controller.start(config); const stopping = controller.stop();
  assert.equal((await controller.start(config)).status, 'stopping');
  pending.resolve({ port: 8787, stop: async () => { stops++; } });
  const [startResult] = await Promise.all([starting, stopping]);
  assert.ok(startResult && typeof startResult.status === 'string');
  assert.equal(controller.getState().status, 'idle'); assert.equal(stops, 1); assert.equal(counts.tunnels, 0);
});
test('cancel during delayed tunnel startup cleans host and late tunnel', async () => {
  const pending = deferred(); let stops = 0;
  const { controller, counts, tunnelExit } = fixture({ startTunnel: () => pending.promise });
  const starting = controller.start(config); await tick(); const stopping = controller.stop();
  pending.resolve({ url: 'https://abc.trycloudflare.com', stop: async () => { stops++; }, exited: tunnelExit.promise });
  const [startResult] = await Promise.all([starting, stopping]);
  assert.ok(startResult && typeof startResult.status === 'string');
  assert.equal(controller.getState().status, 'idle'); assert.equal(stops, 1); assert.equal(counts.hostStops, 1);
});
test('failed verification shuts down all resources; secrets are redacted', async () => {
  const { controller, counts } = fixture({ verify: async () => { throw new Error('Failed private-secret #pw=private-secret'); } });
  const state = await controller.start(config); assert.equal(state.status, 'error'); assert.equal(state.invite, null); assert.equal(state.password, null); assert.ok(!JSON.stringify(state).includes('private-secret')); assert.equal(counts.hostStops, 1); assert.equal(counts.tunnelStops, 1);
});
test('unexpected tunnel loss invalidates invite and terminates the match', async () => {
  const { controller, counts, tunnelExit } = fixture(); await controller.start(config); tunnelExit.resolve({ expected: false }); await tick(); assert.equal(controller.getState().status, 'error'); assert.equal(controller.getState().invite, null); assert.equal(counts.hostStops, 1);
});
test('unexpected server exit stops its tunnel and clears invite', async () => {
  const { controller, counts, hostOptions } = fixture(); await controller.start(config); hostOptions().onExit(); await tick(); assert.equal(controller.getState().status, 'error'); assert.equal(controller.getState().invite, null); assert.equal(counts.tunnelStops, 1);
});
test('dispose is idempotent and prevents future starts', async () => {
  const { controller, counts } = fixture(); await controller.start(config); await Promise.all([controller.dispose(), controller.dispose()]); assert.equal(counts.hostStops, 1); assert.equal(counts.tunnelStops, 1); await assert.rejects(controller.start(config), /closing/);
});
test('late poll results never restore state after stop', async () => {
  const late = deferred(); let reads = 0;
  const { controller } = fixture({ read: async () => { if (++reads > 1) return late.promise; return info; }, pollMs: 5 });
  await controller.start(config); await new Promise(resolve => setTimeout(resolve, 10)); await controller.stop(); late.resolve({ ...info, players: 5 }); await tick(); assert.equal(controller.getState().status, 'idle'); assert.equal(controller.getState().info, null);
});
test('a failed process stop never claims success or permits another match', async () => {
  const pendingExit = deferred(); let starts = 0;
  const { controller } = fixture({ startTunnel: async () => ({ url: 'https://abc.trycloudflare.com', exited: pendingExit.promise, stop: async () => { throw new Error('cannot kill'); } }), startHost: async () => { starts++; return { port: 8787, stop: async () => {} }; } });
  await controller.start(config); await controller.stop(); assert.equal(controller.getState().status, 'error'); assert.match(controller.getState().error, /could not be stopped/); await controller.start(config); assert.equal(starts, 1);
});
test('a tunnel startup termination failure remains blocked even before a handle is returned', async () => {
  let hosts = 0;
  const { controller } = fixture({ startHost: async () => { hosts++; return { port: 8787, stop: async () => {} }; }, startTunnel: async () => { const error = new Error('Helper did not stop'); error.code = 'TUNNEL_STOP_TIMEOUT'; throw error; } });
  await controller.start(config); assert.equal(controller.getState().status, 'error'); assert.match(controller.getState().error, /could not be stopped/); await controller.stop(); await controller.start(config); assert.equal(hosts, 1);
});
test('cancellation during info read or endpoint verification always returns a renderable snapshot', async () => {
  for (const phase of ['read', 'verify']) {
    const waiting = deferred();
    const overrides = phase === 'read' ? { read: () => waiting.promise } : { verify: () => waiting.promise };
    const { controller } = fixture(overrides);
    const starting = controller.start(config); await tick(); const stopping = controller.stop(); waiting.resolve(info);
    const [state] = await Promise.all([starting, stopping]);
    assert.ok(state && typeof state.status === 'string'); assert.equal(controller.getState().status, 'idle');
  }
});
