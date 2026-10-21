'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHostProcess } = require('./host-process.cjs');
function fixture({ timeoutMs = 1000 } = {}) {
  const child = new EventEmitter(); child.messages = []; child.postMessage = data => child.messages.push(data); child.kill = () => child.emit('exit', 0);
  let modulePath, forkOptions;
  const start = createHostProcess({ utilityProcess: { fork(path, _args, options) { modulePath = path; forkOptions = options; return child; } }, timeoutMs });
  const abort = new AbortController(); let exits = 0;
  const args = { password: 'secret', port: 8787, serverName: 'Name', allowedOrigins: ['https://pages.example.com'], signal: abort.signal, log: () => {}, onExit: () => { exits++; } };
  return { child, abort, start: () => start(args), path: () => modulePath, options: () => forkOptions, exits: () => exits };
}
test('runs only the bundled trusted worker and passes configuration through messages', async () => {
  const f = fixture(); const pending = f.start();
  assert.match(f.path(), /host-desktop[/\\]host-worker\.cjs$/); assert.equal(f.options().stdio, 'pipe');
  assert.equal(f.child.messages[0].type, 'start'); assert.equal(f.child.messages[0].options.password, 'secret');
  f.child.emit('message', { type: 'ready', port: 8787 }); const host = await pending;
  const closing = host.stop(); assert.equal(f.child.messages[1].type, 'stop'); f.child.emit('exit', 0); await closing; await host.stop(); assert.equal(f.exits(), 0);
});
test('aborted startup does not settle until child exits', async () => {
  const f = fixture(); const pending = f.start(); let settled = false;
  pending.catch(() => { settled = true; }); f.abort.abort(); await Promise.resolve(); assert.equal(settled, false); f.child.emit('exit', 0); await assert.rejects(pending, /canceled/);
});
test('startup error is sanitized and waits for child termination', async () => {
  const f = fixture(); const pending = f.start(); f.child.emit('message', { type: 'error', code: 'EADDRINUSE', message: 'secret' }); f.child.emit('exit', 1); await assert.rejects(pending, /port is already in use/);
});
test('unexpected exit after readiness is reported once', async () => {
  const f = fixture(); const pending = f.start(); f.child.emit('message', { type: 'ready', port: 8787 }); await pending; f.child.emit('exit', 1); assert.equal(f.exits(), 1);
});
test('rejects invalid ready messages and premature child exit', async () => {
  const f = fixture(); const pending = f.start(); f.child.emit('message', { type: 'ready', port: -1 }); f.child.emit('exit', 1); await assert.rejects(pending, /invalid port/);
  const g = fixture(); const next = g.start(); g.child.emit('exit', 1); await assert.rejects(next, /before it was ready/);
});
