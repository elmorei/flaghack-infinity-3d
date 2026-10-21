#!/usr/bin/env node
/** Real-socket smoke test of the standalone bundle. No relay, browser or external network needed. */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { copyFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { WebSocket } = require('ws');

const PAGES = 'https://elmorei.github.io';
const sockets = new Set();

/** Resolve either the HTTP rejection or the first protocol reply, with a bounded deadline. */
function handshake(url, message, origin = PAGES) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, handshakeTimeout: 5000 });
    let responseHeaders = {};
    ws.once('upgrade', (response) => { responseHeaders = response.headers; });
    sockets.add(ws);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Timed out waiting for the host handshake.')); }, 5000);
    const finish = (result) => { clearTimeout(timer); resolve(result); };
    ws.on('error', (error) => { clearTimeout(timer); reject(error); });
    ws.once('unexpected-response', (_request, response) => {
      finish({ status: response.statusCode });
      response.resume();
      ws.terminate();
    });
    ws.once('open', () => ws.send(JSON.stringify(message)));
    ws.once('message', (raw) => {
      try { finish({ status: 101, headers: responseHeaders, message: JSON.parse(raw.toString()) }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  });
}

async function main() {
  // Import the exact built bytes outside this repository. A mistakenly externalized runtime
  // dependency cannot be hidden by the development checkout's node_modules during this check.
  const isolated = await mkdtemp(join(tmpdir(), 'flaghack-host-runtime-'));
  let host;
  try {
    const bundle = join(isolated, 'host-api.mjs');
    await copyFile(join(__dirname, '..', 'dist-host', 'host-api.js'), bundle);
    const { startHost, BUILD_ID, PROTOCOL_VERSION } = await import(pathToFileURL(bundle).href);
    assert.match(BUILD_ID, /^[a-f0-9]{40}$/, 'release runtime must embed a full commit, not development');
    assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION >= 14);
    const password = randomBytes(24).toString('hex');
    host = await startHost({
      password, port: 0, bind: '127.0.0.1', staticDir: null,
      allowedOrigins: [PAGES], serverName: 'Standalone runtime smoke', log: () => {},
    });
    const base = `http://127.0.0.1:${host.port}`;
    const infoResponse = await fetch(`${base}/api/info`, { headers: { Origin: PAGES }, signal: AbortSignal.timeout(5000) });
    assert.equal(infoResponse.status, 200);
    assert.equal(infoResponse.headers.get('access-control-allow-origin'), PAGES);
    assert.equal(infoResponse.headers.get('access-control-allow-credentials'), null);
    const info = await infoResponse.json();
    assert.equal(info.build, BUILD_ID);
    assert.equal(info.protocol, PROTOCOL_VERSION);
    assert.equal(info.instanceId, host.instanceId);
    assert.match(info.instanceId, /^[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(info).includes(password), false);
    const nativeInfo = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(5000) });
    assert.equal(nativeInfo.status, 200);
    assert.equal(nativeInfo.headers.get('access-control-allow-origin'), null);
    await nativeInfo.arrayBuffer();
    const staticResponse = await fetch(base, { signal: AbortSignal.timeout(5000) });
    assert.equal(staticResponse.status, 404);
    await staticResponse.arrayBuffer();
    const blocked = await fetch(`${base}/api/info`, { headers: { Origin: 'https://untrusted.example' }, signal: AbortSignal.timeout(5000) });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
    await blocked.arrayBuffer();
    const preflight = await fetch(`${base}/api/info`, {
      method: 'OPTIONS', headers: { Origin: PAGES, 'Access-Control-Request-Method': 'GET' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, HEAD');

    const url = `ws://127.0.0.1:${host.port}/ws`;
    const hello = { t: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_ID, name: 'Smoke player', password, token: null };
    assert.equal((await handshake(url, hello, 'https://untrusted.example')).status, 403);
    const wrongBuild = await handshake(url, { ...hello, build: 'incompatible-build' });
    assert.equal(wrongBuild.message.t, 'denied');
    assert.equal(wrongBuild.message.reason, 'build');
    const wrongPassword = await handshake(url, { ...hello, password: 'wrong-password' });
    assert.equal(wrongPassword.message.reason, 'password');
    const joined = await handshake(url, hello);
    assert.equal(joined.status, 101);
    assert.equal(joined.message.t, 'welcome');
    assert.equal(joined.message.build, BUILD_ID);
    assert.equal(joined.message.protocol, PROTOCOL_VERSION);
    assert.equal(joined.headers['x-flaghack-instance'], info.instanceId);
    assert.equal(joined.headers['x-flaghack-build'], BUILD_ID);
    assert.equal(joined.headers['x-flaghack-protocol'], String(PROTOCOL_VERSION));
    console.log(`Standalone host runtime verified: protocol ${PROTOCOL_VERSION}, build ${BUILD_ID}.`);
    console.log('Passed isolated bundle import, loopback discovery/CORS, preflight, no static content, origin/password/build rejection and real WebSocket join.');
  } finally {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    if (host) await host.close();
    await rm(isolated, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
