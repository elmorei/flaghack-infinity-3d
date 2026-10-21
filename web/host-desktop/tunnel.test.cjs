'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const { access, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { startQuickTunnel, extractQuickTunnelUrl, sanitizeLog } = require('./tunnel.cjs');

const executablePath = join(tmpdir(), 'bundled cloudflared.exe');
function mockChild(t, { manualKill = false } = {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killCalls = [];
  child.finish = (code = 0, signal = null) => {
    child.stdout.end(); child.stderr.end(); child.emit('exit', code, signal);
    setImmediate(() => child.emit('close', code, signal));
  };
  child.kill = signal => {
    child.killCalls.push(signal);
    if (!manualKill) child.finish(null, signal);
    return true;
  };
  let started;
  const spawned = new Promise(resolve => { started = resolve; });
  const spawn = t.mock.method(childProcess, 'spawn', (...args) => { started(args); return child; });
  return { child, spawned, spawn };
}

test('extracts only a strict generated HTTPS trycloudflare origin', () => {
  assert.equal(extractQuickTunnelUrl('INF | https://four-word-123.trycloudflare.com |'), 'https://four-word-123.trycloudflare.com');
  assert.equal(extractQuickTunnelUrl('"https://Abc.trycloudflare.com/"'), 'https://abc.trycloudflare.com');
  for (const value of [
    'http://abc.trycloudflare.com', 'https://trycloudflare.com',
    'https://abc.trycloudflare.com.evil.test', 'https://abc.trycloudflare.com@evil.test',
    'https://evil.test@abc.trycloudflare.com', 'https://abc.trycloudflare.com:443',
    'https://abc.trycloudflare.com/path', 'https://abc.trycloudflare.com?key=secret',
    'https://abc.trycloudflare.com#token', 'https://sub.abc.trycloudflare.com',
    'https://-abc.trycloudflare.com', 'https://abc-.trycloudflare.com',
    'https://abc.trycloudflare.com\\@evil.test', 'https://é.trycloudflare.com',
    `https://${'a'.repeat(64)}.trycloudflare.com`, 'prefixhttps://abc.trycloudflare.com',
    'https://evil.test/path/https://abc.trycloudflare.com',
    'ftp://https://abc.trycloudflare.com', 'bad@https://abc.trycloudflare.com',
  ]) assert.equal(extractQuickTunnelUrl(value), null, value);
});

test('diagnostics remove controls, paths, credentials, and URL secrets and are bounded', () => {
  const log = sanitizeLog('\u001b[31mERR\u001b[0m\0 /home/private/file token=HIDDEN password="TOP SECRET" authorization: Bearer SECRET https://user:pass@example.com/path?auth=SECRET#SECRET', ['/home/private']);
  assert.doesNotMatch(log, /HIDDEN|TOP SECRET|SECRET|user:pass|\u001b|\0|\/home\/private/);
  assert.match(log, /\[local path\]/);
  assert.match(log, /https:\/\/example.com\/\[details removed\]/);
  assert.equal(sanitizeLog('x'.repeat(2000)).length, 512);
});

test('spawns bundled binary without shell or credentials, with isolated config and loopback origin', async t => {
  const { child, spawned } = mockChild(t);
  t.mock.property(process, 'env', { ...process.env, TUNNEL_TOKEN: 'SECRET', TUNNEL_NAME: 'must-not-create', HTTPS_PROXY: 'http://managed-proxy.example:8080' });
  const pending = startQuickTunnel({ executablePath, port: 23456 });
  const [file, args, options] = await spawned;
  assert.equal(file, executablePath);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.env.TUNNEL_TOKEN, undefined); assert.equal(options.env.TUNNEL_NAME, undefined);
  assert.equal(options.env.HTTPS_PROXY, 'http://managed-proxy.example:8080');
  assert.deepEqual(args.slice(0, 2), ['--no-autoupdate', 'tunnel']);
  assert.equal(args[args.indexOf('--url') + 1], 'http://127.0.0.1:23456');
  assert.equal(args[args.indexOf('--metrics') + 1], '127.0.0.1:0');
  assert.equal(await readFile(args[args.indexOf('--config') + 1], 'utf8'), '{}\n');
  assert.equal(options.env.HOME, options.cwd);
  child.stderr.write('INF https://test-session.trycloudflare.com\n');
  const tunnel = await pending;
  assert.equal(tunnel.url, 'https://test-session.trycloudflare.com');
  const firstStop = tunnel.stop();
  assert.equal(firstStop, tunnel.stop());
  assert.equal((await firstStop).expected, true);
  assert.equal((await tunnel.exited).signal, 'SIGTERM');
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  await assert.rejects(access(options.cwd), { code: 'ENOENT' });
});

test('reassembles split URL output, but never accepts a partial lookalike', async t => {
  const { child, spawned } = mockChild(t);
  let resolved = false;
  const pending = startQuickTunnel({ executablePath, port: 1234 }).then(result => { resolved = true; return result; });
  await spawned;
  child.stderr.write('https://evil.trycloudflare.com');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  child.stderr.write('.evil.test\nhttps://real-');
  child.stderr.write('host.trycloudflare.com\n');
  const tunnel = await pending;
  assert.equal(tunnel.url, 'https://real-host.trycloudflare.com');
  await tunnel.stop();
});

test('ignores overlong untrusted lines and keeps only bounded sanitized diagnostics', async t => {
  const { child, spawned } = mockChild(t);
  const pending = startQuickTunnel({ executablePath, port: 1234, log() { throw new Error('UI gone'); } });
  await spawned;
  child.stderr.write('x'.repeat(50000) + ' https://wrong.trycloudflare.com\n');
  for (let i = 0; i < 100; i++) child.stderr.write(`line ${i} token=SECRET\n`);
  child.stdout.write('https://good.trycloudflare.com\n');
  const tunnel = await pending;
  assert.equal(tunnel.url, 'https://good.trycloudflare.com');
  assert.equal(tunnel.getLogs().length, 40);
  assert.ok(tunnel.getLogs().every(line => line.length <= 512 && !line.includes('SECRET')));
  const copy = tunnel.getLogs(); copy.length = 0;
  assert.equal(tunnel.getLogs().length, 40);
  await tunnel.stop();
});

test('reports an unexpected exit after URL discovery', async t => {
  const { child, spawned } = mockChild(t);
  const pending = startQuickTunnel({ executablePath, port: 1234 });
  await spawned; child.stdout.write('https://good.trycloudflare.com\n');
  const tunnel = await pending;
  child.stderr.write('ERR connection failed\n'); child.finish(1);
  const exit = await tunnel.exited;
  assert.equal(exit.code, 1); assert.equal(exit.expected, false);
  assert.match(exit.diagnostics.join('\n'), /connection failed/);
  await tunnel.stop();
  assert.deepEqual(child.killCalls, []);
});

test('rejects when child exits before URL discovery and removes temporary files', async t => {
  const { child, spawned } = mockChild(t);
  const pending = startQuickTunnel({ executablePath, port: 1234 });
  const [, , options] = await spawned;
  child.finish(2);
  await assert.rejects(pending, { code: 'TUNNEL_EXIT' });
  await assert.rejects(access(options.cwd), { code: 'ENOENT' });
});

test('missing bundled binary rejects with a safe diagnostic rather than downloading', async t => {
  const { child, spawned } = mockChild(t);
  const pending = startQuickTunnel({ executablePath, port: 1234 });
  const [, , options] = await spawned;
  child.pid = undefined;
  child.emit('error', Object.assign(new Error('ENOENT private path'), { code: 'ENOENT' }));
  await assert.rejects(pending, error => error.code === 'TUNNEL_SPAWN' && !error.message.includes('private path'));
  await assert.rejects(access(options.cwd), { code: 'ENOENT' });
});

test('timeout terminates the child and rejects before returning any URL', async t => {
  const { child, spawned } = mockChild(t);
  const pending = startQuickTunnel({ executablePath, port: 1234, timeoutMs: 15 });
  await spawned;
  await assert.rejects(pending, { code: 'TUNNEL_TIMEOUT' });
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('abort before start never spawns a process', async t => {
  const { spawn } = mockChild(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startQuickTunnel({ executablePath, port: 1234, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(spawn.mock.callCount(), 0);
});

test('abort while starting waits for termination and rejects', async t => {
  const { child, spawned } = mockChild(t);
  const controller = new AbortController();
  const pending = startQuickTunnel({ executablePath, port: 1234, signal: controller.signal });
  await spawned; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('abort after URL discovery still stops the tunnel', async t => {
  const { child, spawned } = mockChild(t);
  const controller = new AbortController();
  const pending = startQuickTunnel({ executablePath, port: 1234, signal: controller.signal });
  await spawned; child.stderr.write('https://good.trycloudflare.com\n');
  const tunnel = await pending; controller.abort();
  assert.equal((await tunnel.exited).expected, true);
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('stop escalates to forced termination if child ignores the grace period', async t => {
  const { child, spawned } = mockChild(t, { manualKill: true });
  child.kill = signal => { child.killCalls.push(signal); if (signal === 'SIGKILL') child.finish(null, signal); return true; };
  const pending = startQuickTunnel({ executablePath, port: 1234, stopGraceMs: 10, stopTimeoutMs: 100 });
  await spawned; child.stderr.write('https://good.trycloudflare.com\n');
  const tunnel = await pending;
  assert.equal((await tunnel.stop()).signal, 'SIGKILL');
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
});

test('reports failure instead of claiming a stuck child has stopped', async t => {
  const { child, spawned } = mockChild(t, { manualKill: true });
  const pending = startQuickTunnel({ executablePath, port: 1234, stopGraceMs: 5, stopTimeoutMs: 20 });
  await spawned; child.stderr.write('https://good.trycloudflare.com\n');
  const tunnel = await pending;
  await assert.rejects(tunnel.stop(), { code: 'TUNNEL_STOP_TIMEOUT' });
  child.kill = signal => { child.killCalls.push(signal); child.finish(null, signal); return true; };
  await tunnel.stop();
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL', 'SIGTERM']);
  await tunnel.exited;
});

test('real subprocess is owned until stop and removed without lingering helper or config', async t => {
  const spawn = childProcess.spawn;
  let child, configurationDirectory;
  t.mock.method(childProcess, 'spawn', (_path, _args, options) => {
    configurationDirectory = options.cwd;
    child = spawn(process.execPath, ['-e', "process.stdout.write('https://fixture.trycloudflare.com\\n'); setInterval(() => {}, 1000);"], options);
    return child;
  });
  t.after(() => { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL'); });
  const tunnel = await startQuickTunnel({ executablePath, port: 1234 });
  assert.equal(tunnel.url, 'https://fixture.trycloudflare.com');
  assert.equal(process.kill(child.pid, 0), true);
  const exit = await tunnel.stop();
  assert.equal(exit.expected, true);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(configurationDirectory), { code: 'ENOENT' });
});

test('rejects non-absolute executable paths and invalid ports', async () => {
  await assert.rejects(startQuickTunnel({ executablePath: 'cloudflared', port: 1234 }), TypeError);
  for (const port of [0, -1, 65536, 1.5, '1234', '1;cmd']) {
    await assert.rejects(startQuickTunnel({ executablePath, port }), TypeError);
  }
});
