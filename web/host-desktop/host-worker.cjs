'use strict';
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
let host, starting, stopping = false;
const send = message => process.parentPort.postMessage(message);
async function stop() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(0), 2800);
  timer.unref();
  try { await starting; await host?.close(); } catch { /* The owning process also has a deadline. */ }
  process.exit(0);
}
process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'stop') { void stop(); return; }
  if (data?.type !== 'start' || starting || stopping) return;
  starting = (async () => {
    try {
      const { startHost } = await import(pathToFileURL(join(__dirname, '..', 'dist-host', 'host-api.js')).href);
      host = await startHost({ ...data.options, bind: '127.0.0.1', staticDir: null, log: line => send({ type: 'log', line }) });
      if (!stopping) send({ type: 'ready', port: host.port });
    } catch (error) {
      send({ type: 'error', code: error?.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'START_FAILED' });
      setTimeout(() => process.exit(1), 10);
    }
  })();
});
process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));
