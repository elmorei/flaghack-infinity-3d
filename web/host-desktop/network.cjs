'use strict';
const http = require('node:http');
const https = require('node:https');
const WebSocket = require('ws');
const { hostInfo, publicOrigin } = require('./security.cjs');
// No redirects, cookies, credentials, cache, or arbitrary paths. A response is capped before JSON parsing.
function readInfo(origin, { signal, timeoutMs = 3500, pagesOrigin } = {}) {
  const url = new URL('/api/info', origin);
  if (url.protocol === 'http:') {
    if (url.hostname !== '127.0.0.1' || !url.port) return Promise.reject(new Error('Only the local match can use HTTP.'));
  } else if (publicOrigin(origin) !== url.origin) return Promise.reject(new Error('Invalid host endpoint.'));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const headers = { Accept: 'application/json', 'Cache-Control': 'no-store' };
    if (pagesOrigin) headers.Origin = publicOrigin(pagesOrigin);
    const req = transport.get(url, { signal, headers }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('Host endpoint is not ready.')); return; }
      if (pagesOrigin && res.headers['access-control-allow-origin'] !== pagesOrigin) { res.resume(); reject(new Error('The HTTPS endpoint does not allow this Pages game origin. Check its CORS settings.')); return; }
      let body = '', length = 0, oversized = false;
      res.setEncoding('utf8');
      res.on('data', chunk => { length += Buffer.byteLength(chunk); if (length > 16384) { oversized = true; reject(new Error('Host response was too large.')); res.destroy(); req.destroy(); } else body += chunk; });
      res.on('error', reject);
      res.on('end', () => { if (oversized) return; try { resolve(hostInfo(JSON.parse(body))); } catch { reject(new Error('Endpoint did not return a compatible FLAGHACK host.')); } });
    });
    const timer = setTimeout(() => { reject(new Error('Host endpoint timed out.')); req.destroy(); }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Start canceled.')); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Start canceled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function verifyEndpoint(origin, localInfo, { signal, pagesOrigin, read = readInfo, probe = probeWebSocket, attempts = 30, pause = delay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal.aborted) throw new Error('Start canceled.');
    let info;
    try { info = await read(origin, { signal, pagesOrigin }); } catch { /* Tunnel propagation can take a moment. */ }
    if (info) {
      if (info.instanceId !== localInfo.instanceId) throw new Error('That HTTPS endpoint points to a different match. Check its forwarding address.');
      if (info.build !== localInfo.build || info.protocol !== localInfo.protocol) throw new Error('The host builds do not match. Update the host app and reload the Pages game.');
      await probe(origin, { signal, pagesOrigin, expectedInfo: localInfo });
      return;
    }
    if (attempt + 1 < attempts) await pause(1200, signal);
  }
  throw new Error('The HTTPS endpoint did not become reachable. Check your connection or use an existing HTTPS tunnel.');
}
// Upgrade only: do not send hello or acquire a player identity/leader seat.
function probeWebSocket(origin, { signal, pagesOrigin, expectedInfo, timeoutMs = 5000, WebSocketImpl = WebSocket } = {}) {
  const url = new URL('/ws', publicOrigin(origin));
  url.protocol = 'wss:';
  const allowedOrigin = publicOrigin(pagesOrigin);
  const expected = hostInfo(expectedInfo);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Start canceled.')); return; }
    const socket = new WebSocketImpl(url.href, { origin: allowedOrigin, followRedirects: false, rejectUnauthorized: true, handshakeTimeout: timeoutMs, perMessageDeflate: false, maxPayload: 1024 });
    let opened = false, verified = false, settled = false, closeTimer;
    const deadline = setTimeout(() => finish(new Error('The HTTPS endpoint did not accept a secure WebSocket connection.')), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(closeTimer);
      signal?.removeEventListener('abort', abort);
      if (error) { socket.terminate(); reject(error); } else resolve();
    }
    const abort = () => finish(new Error('Start canceled.'));
    socket.once('upgrade', response => {
      const headers = response.headers || {};
      verified = response.statusCode === 101 && headers['x-flaghack-instance'] === expected.instanceId && headers['x-flaghack-build'] === expected.build && headers['x-flaghack-protocol'] === String(expected.protocol);
      if (!verified) finish(new Error('The WebSocket endpoint does not reach this exact match and build. Check that /api/info and /ws forward to the same host.'));
    });
    socket.once('open', () => {
      if (settled) return;
      if (!verified) { finish(new Error('The WebSocket endpoint did not identify this match. Check its upgrade response headers.')); return; }
      opened = true;
      // The public socket must be closed before the invite is advertised.
      closeTimer = setTimeout(() => socket.terminate(), 750);
      socket.close(1000);
    });
    socket.once('error', () => finish(new Error('The HTTPS endpoint did not accept a secure WebSocket connection. Check WebSocket forwarding and the allowed Pages origin.')));
    socket.once('close', () => finish(opened ? null : new Error('The HTTPS endpoint closed before its WebSocket was ready.')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
module.exports = { readInfo, verifyEndpoint, probeWebSocket };
