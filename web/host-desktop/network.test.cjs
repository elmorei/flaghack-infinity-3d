'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readInfo, verifyEndpoint, probeWebSocket } = require('./network.cjs');
const info = { protocol: 14, build: 'abc', instanceId: 'instance', phase: 'lobby', players: 0, seated: 0 };
async function local(handler, run) {
  const server = http.createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
test('polls only loopback HTTP or public HTTPS and validates status', async () => {
  await local((_req, res) => res.end(JSON.stringify(info)), async origin => { assert.deepEqual(await readInfo(origin), info); });
  await assert.rejects(readInfo('http://example.com:1234'), /Only the local/);
});
test('rejects redirects, oversized and malformed responses', async () => {
  for (const handler of [(_req, res) => res.writeHead(302, { Location: 'http://127.0.0.1:80' }).end(), (_req, res) => res.end('x'.repeat(17000)), (_req, res) => res.end('{}')]) await local(handler, async origin => { await assert.rejects(readInfo(origin)); });
});
test('absolute request deadline and abort terminate unresponsive polls', async () => {
  await local(() => {}, async origin => {
    await assert.rejects(readInfo(origin, { timeoutMs: 20 }), /timed out/);
    const controller = new AbortController();
    const pending = readInfo(origin, { signal: controller.signal }); controller.abort();
    await assert.rejects(pending, /aborted/);
  });
});
test('public verification waits for readiness but never accepts another match or build', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  await verifyEndpoint('https://match.example', info, { signal, pagesOrigin: 'https://pages.example', probe: async () => {}, read: async () => { if (++calls < 3) throw new Error('not ready'); return info; }, pause: async () => {} });
  assert.equal(calls, 3);
  await assert.rejects(verifyEndpoint('https://match.example', info, { signal, read: async () => ({ ...info, instanceId: 'wrong' }) }), /different match/);
  await assert.rejects(verifyEndpoint('https://match.example', info, { signal, read: async () => ({ ...info, build: 'old' }) }), /builds do not match/);
  await assert.rejects(verifyEndpoint('https://match.example', info, { signal, read: async () => { throw new Error('offline'); }, pause: async () => {}, attempts: 2 }), /did not become reachable/);
});
test('public readiness sends the configured Origin and rejects missing or wildcard CORS', async () => {
  const pagesOrigin = 'https://pages.example';
  await local((req, res) => { assert.equal(req.headers.origin, pagesOrigin); res.setHeader('Access-Control-Allow-Origin', pagesOrigin); res.end(JSON.stringify(info)); }, async origin => { assert.deepEqual(await readInfo(origin, { pagesOrigin }), info); });
  for (const cors of [undefined, '*', 'https://wrong.example']) await local((_req, res) => { if (cors) res.setHeader('Access-Control-Allow-Origin', cors); res.end(JSON.stringify(info)); }, async origin => { await assert.rejects(readInfo(origin, { pagesOrigin }), /CORS/); });
});
test('readiness verifies WebSocket with Pages Origin after checking public identity', async () => {
  const pagesOrigin = 'https://pages.example', signal = new AbortController().signal;
  let probed = false;
  await verifyEndpoint('https://match.example', info, { signal, pagesOrigin, read: async (_origin, options) => { assert.equal(options.pagesOrigin, pagesOrigin); return info; }, probe: async (origin, options) => { assert.equal(origin, 'https://match.example'); assert.equal(options.pagesOrigin, pagesOrigin); assert.deepEqual(options.expectedInfo, info); probed = true; } });
  assert.equal(probed, true);
  await assert.rejects(verifyEndpoint('https://match.example', info, { signal, pagesOrigin, read: async () => info, probe: async () => { throw new Error('No WSS'); } }), /No WSS/);
});
test('WebSocket probe upgrades with exact Origin, sends no hello, and closes before resolving', async () => {
  const { EventEmitter } = require('node:events'); let socket, target, options;
  class FakeSocket extends EventEmitter { constructor(url, config) { super(); socket = this; target = url; options = config; this.closed = false; this.sent = []; } close(code) { assert.equal(code, 1000); this.closed = true; queueMicrotask(() => this.emit('close')); } send(data) { this.sent.push(data); } terminate() { this.emit('close'); } }
  const pending = probeWebSocket('https://match.example:8443', { expectedInfo: info, pagesOrigin: 'https://pages.example', signal: new AbortController().signal, WebSocketImpl: FakeSocket });
  socket.emit('upgrade', { statusCode: 101, headers: { 'x-flaghack-instance': info.instanceId, 'x-flaghack-build': info.build, 'x-flaghack-protocol': String(info.protocol) } });
  socket.emit('open'); await pending;
  assert.equal(target, 'wss://match.example:8443/ws'); assert.equal(options.origin, 'https://pages.example'); assert.equal(options.followRedirects, false); assert.equal(options.rejectUnauthorized, true); assert.equal(socket.closed, true); assert.deepEqual(socket.sent, []);
});
test('WebSocket failure, timeout, or cancellation terminates the readiness socket', async () => {
  const { EventEmitter } = require('node:events'); let socket;
  class FakeSocket extends EventEmitter { constructor() { super(); socket = this; this.terminated = false; } terminate() { this.terminated = true; this.emit('close'); } }
  let pending = probeWebSocket('https://match.example', { expectedInfo: info, pagesOrigin: 'https://pages.example', WebSocketImpl: FakeSocket }); socket.emit('error', new Error('secret detail')); await assert.rejects(pending, /secure WebSocket/); assert.equal(socket.terminated, true);
  pending = probeWebSocket('https://match.example', { expectedInfo: info, pagesOrigin: 'https://pages.example', WebSocketImpl: FakeSocket, timeoutMs: 10 }); await assert.rejects(pending, /secure WebSocket/); assert.equal(socket.terminated, true);
  const abort = new AbortController(); pending = probeWebSocket('https://match.example', { expectedInfo: info, pagesOrigin: 'https://pages.example', WebSocketImpl: FakeSocket, signal: abort.signal }); abort.abort(); await assert.rejects(pending, /canceled/); assert.equal(socket.terminated, true);
});
test('WebSocket identity rejects split routing, wrong build/protocol, missing or duplicated headers', async () => {
  const { EventEmitter } = require('node:events');
  const correct = { 'x-flaghack-instance': info.instanceId, 'x-flaghack-build': info.build, 'x-flaghack-protocol': String(info.protocol) };
  for (const patch of [{ 'x-flaghack-instance': 'other-room' }, { 'x-flaghack-build': 'different-build' }, { 'x-flaghack-protocol': '13' }, { 'x-flaghack-instance': undefined }, { 'x-flaghack-instance': [info.instanceId, info.instanceId] }]) {
    let socket;
    class FakeSocket extends EventEmitter { constructor() { super(); socket = this; this.terminated = false; this.sent = []; } send(value) { this.sent.push(value); } terminate() { this.terminated = true; this.emit('close'); } }
    const pending = probeWebSocket('https://match.example', { expectedInfo: info, pagesOrigin: 'https://pages.example', WebSocketImpl: FakeSocket });
    socket.emit('upgrade', { statusCode: 101, headers: { ...correct, ...patch } }); socket.emit('open');
    await assert.rejects(pending, /exact match and build/); assert.equal(socket.terminated, true); assert.deepEqual(socket.sent, []);
  }
});
test('a plain WebSocket upgrade cannot pass without FLAGHACK instance headers', async () => {
  const { EventEmitter } = require('node:events'); let socket;
  class FakeSocket extends EventEmitter { constructor() { super(); socket = this; } terminate() { this.emit('close'); } }
  const pending = probeWebSocket('https://match.example', { expectedInfo: info, pagesOrigin: 'https://pages.example', WebSocketImpl: FakeSocket });
  socket.emit('open'); await assert.rejects(pending, /did not identify this match/);
});
test('correct public info cannot conceal a WebSocket route to another room', async () => {
  const { EventEmitter } = require('node:events');
  class OtherRoomSocket extends EventEmitter { constructor() { super(); queueMicrotask(() => { this.emit('upgrade', { statusCode: 101, headers: { 'x-flaghack-instance': 'wrong-room', 'x-flaghack-build': info.build, 'x-flaghack-protocol': String(info.protocol) } }); this.emit('open'); }); } terminate() { this.emit('close'); } }
  await assert.rejects(verifyEndpoint('https://split.example', info, { signal: new AbortController().signal, pagesOrigin: 'https://pages.example', read: async () => info, probe: (origin, options) => probeWebSocket(origin, { ...options, WebSocketImpl: OtherRoomSocket }) }), /exact match and build/);
});
