'use strict';
const { join } = require('node:path');
// Only a trusted, bundled script can be run. No paths or script URLs come from the renderer.
function createHostProcess({ utilityProcess, timeoutMs = 15000 }) {
  return ({ password, port, serverName, allowedOrigins, signal, log, onExit }) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Start canceled.')); return; }
    const child = utilityProcess.fork(join(__dirname, 'host-worker.cjs'), [], { serviceName: 'FLAGHACK match host', stdio: 'pipe' });
    let ready = false, stopping = false, exited = false, stopWork, killTimer, startupError;
    let finishExit;
    const exitPromise = new Promise(done => { finishExit = done; });
    function stop() {
      if (stopWork) return stopWork;
      stopping = true;
      clearTimeout(startTimer);
      if (!exited) {
        try { child.postMessage({ type: 'stop' }); } catch { child.kill(); }
        killTimer = setTimeout(() => { if (!exited) child.kill(); }, 3000);
        killTimer.unref?.();
      }
      stopWork = exitPromise;
      return stopWork;
    }
    const fail = message => { startupError = new Error(message); void stop(); };
    const abort = () => fail('Start canceled.');
    const startTimer = setTimeout(() => fail('The local match took too long to start.'), timeoutMs);
    child.on('message', data => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ready' && !ready && !stopping) {
        if (!Number.isInteger(data.port) || data.port < 1024 || data.port > 65535) { fail('The local match returned an invalid port.'); return; }
        ready = true;
        clearTimeout(startTimer);
        resolve({ port: data.port, stop });
      } else if (data.type === 'log' && typeof data.line === 'string') log(data.line);
      else if (data.type === 'error') {
        fail(data.code === 'EADDRINUSE' ? 'That port is already in use. Choose another port.' : 'The bundled match server could not start. Reinstall the matching host release.');
      }
    });
    child.once('exit', () => {
      exited = true;
      clearTimeout(startTimer); clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      finishExit();
      if (!ready) reject(startupError || new Error('The bundled match process exited before it was ready.'));
      else if (!stopping) onExit();
    });
    // Never echo raw stdout/stderr: an unexpected library trace could contain room secrets.
    child.stdout?.resume(); child.stderr?.resume();
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => fail('The match process encountered a fatal error.'));
    try { child.postMessage({ type: 'start', options: { password, port, serverName, allowedOrigins } }); } catch { fail('The match process could not be initialized.'); }
  });
}
module.exports = { createHostProcess };
