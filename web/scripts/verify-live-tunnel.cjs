'use strict';

// Optional hosted-Windows CI smoke. A provider/network failure is a FAILED smoke,
// not a passing test. The workflow may continue packaging while publishing this
// separate report. No accounts, services, or persistent configuration are used.
const { randomBytes } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');
const { startQuickTunnel, sanitizeLog } = require('../host-desktop/tunnel.cjs');
const { readInfo, verifyEndpoint } = require('../host-desktop/network.cjs');
const { publicOrigin } = require('../host-desktop/security.cjs');
const { ASSETS, hashFile } = require('./fetch-cloudflared.cjs');

const PAGES_ORIGIN = 'https://elmorei.github.io';
const DEFAULT_TIMEOUT_MS = 120000;

function authenticateWebSocket(origin, { password, build, protocol, instanceId, signal, pagesOrigin = PAGES_ORIGIN,
  timeoutMs = 12000, WebSocketImpl = WebSocket } = {}) {
  const endpoint = new URL('/ws', publicOrigin(origin));
  endpoint.protocol = 'wss:';
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Live tunnel smoke cancelled.')); return; }
    const socket = new WebSocketImpl(endpoint.href, { origin: publicOrigin(pagesOrigin),
      followRedirects: false, rejectUnauthorized: true, perMessageDeflate: false,
      handshakeTimeout: timeoutMs, maxPayload: 65536 });
    let settled = false, welcomed = false, identityVerified = false, closeTimer;
    const timer = setTimeout(() => finish(new Error('Authenticated public WebSocket hello timed out.')), timeoutMs);
    const abort = () => finish(new Error('Live tunnel smoke cancelled.'));
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      signal?.removeEventListener('abort', abort);
      if (error) { socket.terminate(); reject(error); }
      else resolve();
    }
    socket.once('upgrade', response => {
      const headers = response.headers;
      if (typeof instanceId !== 'string' || !instanceId || headers['x-flaghack-instance'] !== instanceId ||
          headers['x-flaghack-build'] !== build || headers['x-flaghack-protocol'] !== String(protocol)) {
        finish(new Error('Authenticated WebSocket upgrade did not match the trusted host instance, build and protocol.'));
        return;
      }
      identityVerified = true;
    });
    socket.once('open', () => {
      if (settled) return;
      if (!identityVerified) { finish(new Error('Authenticated WebSocket did not provide verified host identity.')); return; }
      socket.send(JSON.stringify({ t: 'hello', protocol, build, name: 'CI tunnel check', password, token: null }));
    });
    socket.on('message', raw => {
      if (settled || welcomed) return;
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { finish(new Error('Public WebSocket returned invalid JSON.')); return; }
      // Never include response payloads: welcome contains a reconnect token.
      if (message.t === 'denied') { finish(new Error('Public WebSocket denied the authenticated smoke test.')); return; }
      if (message.t !== 'welcome') return;
      if (message.build !== build || message.protocol !== protocol) {
        finish(new Error('Public WebSocket welcome did not match the trusted build and protocol.')); return;
      }
      welcomed = true;
      closeTimer = setTimeout(() => socket.terminate(), 750);
      socket.close(1000);
    });
    socket.once('error', () => finish(new Error('Authenticated public WebSocket connection failed.')));
    socket.once('close', () => finish(welcomed ? null : new Error('Public WebSocket closed before authenticated welcome.')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function verifyBinary(executablePath) {
  if (await hashFile(executablePath) !== ASSETS[0].sha256) throw new Error('Packaged tunnel helper does not match the pinned official Windows checksum.');
}

async function runLiveTunnelSmoke({
  root = join(__dirname, '..'), platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS,
  expectedBuild = process.env.GITHUB_SHA, pagesOrigin = PAGES_ORIGIN, signal,
  executablePath = join(root, 'host-release', 'win-unpacked', 'resources', 'vendor', 'cloudflared.exe'),
  reportPath = join(root, 'host-release', 'live-tunnel-smoke.json'),
  loadHost = () => import(pathToFileURL(join(root, 'dist-host', 'host-api.js')).href),
  checkBinary = verifyBinary, startTunnel = startQuickTunnel,
  read = readInfo, verify = verifyEndpoint, authenticate = authenticateWebSocket,
  onStage = stage => console.log(`Live tunnel smoke: ${stage}`),
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 40 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new TypeError('Live smoke timeout must be at most 120 seconds.');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Live tunnel smoke cancelled.'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  // Reserve ten seconds of the total bound for closing the socket, helper and
  // local host. Runtime helper shutdown is itself bounded to four seconds.
  const cleanupReserve = Math.min(10000, Math.floor(timeoutMs / 4));
  const deadline = setTimeout(() => controller.abort(new Error('Live tunnel smoke exceeded its time limit.')), timeoutMs - cleanupReserve);
  const report = { ok: false, build: expectedBuild || null, stage: 'preflight' };
  const password = randomBytes(24).toString('hex');
  let host, tunnel;
  const stage = value => { report.stage = value; onStage(value); controller.signal.throwIfAborted(); };
  const safeError = error => {
    let text = error instanceof Error ? error.message : 'Live tunnel smoke failed.';
    text = text.split(password).join('[redacted]');
    if (tunnel?.url) text = text.split(tunnel.url).join('[temporary tunnel]');
    return sanitizeLog(text, [root]);
  };
  try {
    stage('preflight');
    const api = await loadHost();
    report.build = api.BUILD_ID;
    if (!/^[a-f0-9]{40}$/.test(api.BUILD_ID) || (expectedBuild && expectedBuild !== api.BUILD_ID)) throw new Error('Trusted host build does not match the expected source revision.');
    if (platform !== 'win32') throw new Error('Live packaged tunnel smoke requires the Windows hosted runner.');
    await checkBinary(executablePath);
    stage('local-host');
    host = await api.startHost({ password, port: 0, bind: '127.0.0.1', staticDir: null,
      allowedOrigins: [pagesOrigin], serverName: 'Temporary CI tunnel check', log: () => {} });
    const local = await read(`http://127.0.0.1:${host.port}`, { signal: controller.signal });
    if (local.instanceId !== host.instanceId || local.build !== api.BUILD_ID || local.protocol !== api.PROTOCOL_VERSION) throw new Error('Local discovery did not match the trusted host instance, build and protocol.');
    stage('tunnel-start');
    // Exactly one tunnel creation attempt; only ordinary propagation readiness
    // is polled below. No provider fallback, second tunnel, or global changes.
    tunnel = await startTunnel({ executablePath, port: host.port, signal: controller.signal });
    tunnel.exited.then(exit => {
      if (!exit.expected && !controller.signal.aborted) controller.abort(new Error('Temporary Cloudflare tunnel exited unexpectedly.'));
    });
    stage('public-discovery');
    await verify(tunnel.url, local, { signal: controller.signal, pagesOrigin });
    stage('authenticated-websocket');
    await authenticate(tunnel.url, { password, build: api.BUILD_ID, protocol: api.PROTOCOL_VERSION, instanceId: host.instanceId, pagesOrigin, signal: controller.signal });
    controller.signal.throwIfAborted();
    report.ok = true;
    report.stage = 'complete';
  } catch (error) {
    report.error = safeError(controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
    const results = await Promise.allSettled([
      tunnel ? Promise.resolve().then(() => tunnel.stop()) : Promise.resolve(),
      host ? Promise.resolve().then(() => host.close()) : Promise.resolve(),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      report.ok = false;
      report.stage = 'cleanup';
      report.error = safeError(failure.reason);
    }
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (require.main === module) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  runLiveTunnelSmoke({ signal: cancellation.signal }).then(report => {
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  }, error => { console.error(sanitizeLog(error.message)); process.exitCode = 1; }).finally(() => {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  });
}

module.exports = { runLiveTunnelSmoke, authenticateWebSocket, verifyBinary, PAGES_ORIGIN, DEFAULT_TIMEOUT_MS };
