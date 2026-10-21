'use strict';

// This module never downloads, installs, updates, or signs in to cloudflared.
// The pinned executable is fetched and verified by scripts/fetch-cloudflared.cjs.
const childProcess = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, isAbsolute } = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { stripVTControlCharacters } = require('node:util');

const MAX_LINE = 8192;
const MAX_LOG_LINE = 512;
const MAX_LOG_LINES = 40;

function extractQuickTunnelUrl(line) {
  // Parse complete tokens, not a valid-looking substring of an untrusted URL.
  // Deliberately disallow credentials, ports, paths, query strings, fragments,
  // nested subdomains, unicode hostnames, and suffix tricks such as .com.evil.
  const tokens = String(line).split(/[\s<>"'`|]+/);
  for (const token of tokens) {
    if (/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/i.test(token)) {
      return new URL(token).origin;
    }
  }
  return null;
}

function sanitizeLog(line, privatePaths = []) {
  let clean = stripVTControlCharacters(String(line))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
  for (const path of privatePaths) if (path) clean = clean.split(path).join('[local path]');
  clean = clean.replace(/\bhttps?:\/\/[^\s<>"'`|]+/gi, value => {
    try {
      const url = new URL(value);
      return url.origin + (url.pathname !== '/' || url.search || url.hash || url.username || url.password ? '/[details removed]' : '');
    } catch { return '[URL removed]'; }
  });
  clean = clean.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  clean = clean.replace(/\b(token|secret|password|authorization|credentials?|api[-_]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]');
  return clean.trim().slice(0, MAX_LOG_LINE);
}

function tunnelError(message, code, logs) {
  const error = new Error(message);
  error.code = code;
  error.diagnostics = logs.slice();
  if (code === 'ABORT_ERR') error.name = 'AbortError';
  return error;
}

function isolatedEnvironment(directory) {
  // Do not inherit TUNNEL_*, Cloudflare account credentials, or arbitrary flags.
  // Preserve basic OS variables and existing standard proxy routing so managed
  // networks are respected rather than attempting to bypass their proxy.
  const allowed = /^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|PATH|PATHEXT|TEMP|TMP|LANG|LC_ALL|TZ|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  return { ...env, HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory };
}

/**
 * Start an experimental, account-free Quick Tunnel to the loopback game server.
 * Resolves after URL discovery, NOT public readiness. The controller must verify
 * public /api/info against the local host instance/build before sharing a link.
 *
 * `exited` always resolves after child termination; `expected` distinguishes a
 * requested stop/abort from a crash. Keep observing it after URL discovery.
 */
async function startQuickTunnel({ executablePath, port, signal, log, timeoutMs = 45000,
  stopGraceMs = 1500, stopTimeoutMs = 4000 } = {}) {
  if (typeof executablePath !== 'string' || !isAbsolute(executablePath) || executablePath.includes('\0')) {
    throw new TypeError('A bundled absolute cloudflared executable path is required.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('A valid loopback server port is required.');
  for (const [name, value] of Object.entries({ timeoutMs, stopGraceMs, stopTimeoutMs })) {
    if (!Number.isInteger(value) || value < 1 || value > 300000) throw new TypeError(`Invalid ${name}.`);
  }
  if (stopTimeoutMs <= stopGraceMs) throw new TypeError('Stop timeout must exceed the grace period.');
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('Invalid abort signal.');
  }
  if (signal?.aborted) throw tunnelError('Tunnel start cancelled.', 'ABORT_ERR', []);

  const directory = await mkdtemp(join(tmpdir(), 'flaghack-tunnel-'));
  let child;
  try {
    // An explicit empty config prevents existing user/system configuration from
    // silently changing the origin or creating a named, authenticated tunnel.
    const config = join(directory, 'config.json');
    await writeFile(config, '{}\n', { mode: 0o600 });
    if (signal?.aborted) throw tunnelError('Tunnel start cancelled.', 'ABORT_ERR', []);
    child = childProcess.spawn(executablePath, [
      '--no-autoupdate', 'tunnel', '--config', config,
      '--url', `http://127.0.0.1:${port}`, '--metrics', '127.0.0.1:0',
    ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      cwd: directory, env: isolatedEnvironment(directory) });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error.name === 'AbortError') throw error;
    throw tunnelError('Could not launch the bundled tunnel helper. Reinstall the hosting app and try again.', 'TUNNEL_SPAWN', []);
  }

  const logs = [];
  let readySettled = false, finished = false, expected = false, processError = null;
  let startupTimer, forceTimer, stopTimer, stopPromise;
  let resolveReady, rejectReady, resolveExited;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise(resolve => { resolveExited = resolve; });
  const privatePaths = [directory, process.env.USERPROFILE, process.env.HOME];

  function record(line) {
    const clean = sanitizeLog(line, privatePaths);
    if (!clean) return;
    logs.push(clean);
    if (logs.length > MAX_LOG_LINES) logs.shift();
    try { log?.(clean); } catch { /* A log view must not break process cleanup. */ }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    expected = true;
    if (finished) return exited;
    stopPromise = new Promise((resolve, reject) => {
      exited.then(resolve);
      forceTimer = setTimeout(() => {
        if (!finished) {
          try { child.kill('SIGKILL'); } catch { record('Could not force-stop the tunnel helper.'); }
        }
      }, stopGraceMs);
      stopTimer = setTimeout(() => {
        // Keep concurrent stops idempotent, but allow a deliberate retry after
        // a failed stop rather than permanently caching a failed operation.
        stopPromise = null;
        reject(tunnelError('The tunnel helper did not stop. Close the hosting app and end cloudflared in Task Manager.', 'TUNNEL_STOP_TIMEOUT', logs));
      }, stopTimeoutMs);
      try { child.kill('SIGTERM'); } catch { record('Could not request tunnel shutdown; attempting forced shutdown.'); }
    });
    return stopPromise;
  }

  function failStartup(error) {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(startupTimer);
    stop().then(() => rejectReady(error), cleanupError => rejectReady(cleanupError));
  }

  const abort = () => {
    if (!readySettled) failStartup(tunnelError('Tunnel start cancelled.', 'ABORT_ERR', logs));
    else stop().catch(error => record(error.message));
  };

  function consume(line, oversized) {
    record(oversized ? `${line} [overlong line omitted]` : line);
    if (readySettled || finished || oversized) return;
    const url = extractQuickTunnelUrl(stripVTControlCharacters(line));
    if (!url) return;
    readySettled = true;
    clearTimeout(startupTimer);
    resolveReady({ url, stop, exited, getLogs: () => logs.slice() });
  }

  function readLines(stream) {
    const decoder = new StringDecoder('utf8');
    let pending = '', oversized = false;
    function append(text) {
      for (const part of text.split(/(?<=\n)/)) {
        const newline = part.endsWith('\n');
        if (pending.length + part.length > MAX_LINE) oversized = true;
        pending += part.slice(0, Math.max(0, MAX_LINE - pending.length));
        if (newline) {
          consume(pending.replace(/[\r\n]+$/, ''), oversized);
          pending = ''; oversized = false;
        }
      }
    }
    stream.on('data', chunk => append(decoder.write(chunk)));
    stream.on('end', () => { append(decoder.end()); if (pending) consume(pending, oversized); });
    stream.on('error', () => record('Tunnel diagnostic stream closed unexpectedly.'));
  }

  async function finish(code, exitSignal) {
    if (finished) return;
    finished = true;
    clearTimeout(startupTimer); clearTimeout(forceTimer); clearTimeout(stopTimer);
    signal?.removeEventListener('abort', abort);
    try { await rm(directory, { recursive: true, force: true }); }
    catch { record('Could not remove the temporary empty tunnel configuration.'); }
    const result = { code, signal: exitSignal, expected, error: processError, diagnostics: logs.slice() };
    resolveExited(result);
    if (!readySettled) {
      readySettled = true;
      rejectReady(tunnelError(processError
        ? 'Could not launch the bundled tunnel helper. Reinstall the hosting app and try again.'
        : 'The tunnel helper exited before returning a public URL. Check your Internet connection and try again.',
      processError ? 'TUNNEL_SPAWN' : 'TUNNEL_EXIT', logs));
    }
  }

  readLines(child.stdout);
  readLines(child.stderr);
  child.on('error', error => {
    processError = sanitizeLog(error.code || 'Tunnel process error');
    record(`Tunnel process error: ${processError}`);
    if (!child.pid) void finish(null, null);
  });
  // 'close' follows final stdout/stderr output; 'exit' can arrive before it.
  child.once('close', (code, exitSignal) => { void finish(code, exitSignal); });
  startupTimer = setTimeout(() => failStartup(tunnelError(
    'Timed out waiting for a Cloudflare Quick Tunnel. Check your Internet connection and try again.',
    'TUNNEL_TIMEOUT', logs)), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return ready;
}

module.exports = { startQuickTunnel, extractQuickTunnelUrl, sanitizeLog };
