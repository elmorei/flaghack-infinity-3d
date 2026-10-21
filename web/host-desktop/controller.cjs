'use strict';
const security = require('./security.cjs');
const { readInfo, verifyEndpoint } = require('./network.cjs');
function createHostController({ startHost, startTunnel, onState = () => {}, read = readInfo, verify = verifyEndpoint, makePassword = security.password, pollMs = 1500 }) {
  let active = null, startWork = null, stopWork = null, disposed = false;
  let state = { status: 'idle', stage: 'Ready to host', serverName: '', port: null, endpoint: null, invite: null, password: null, info: null, error: null, logs: [] };
  const snapshot = () => ({ ...state, info: state.info && { ...state.info }, logs: [...state.logs] });
  const publish = patch => { state = { ...state, ...patch }; onState(snapshot()); };
  function log(value, run = active) {
    if (!run || active !== run) return;
    const line = security.cleanLog(value, run.password);
    if (line) publish({ logs: [...state.logs.slice(-79), line] });
  }
  function current(run) { return active === run && !run.abort.signal.aborted; }
  async function cleanup(run) {
    if (run.cleanup) return run.cleanup;
    run.abort.abort();
    clearInterval(run.timer);
    run.cleanup = Promise.allSettled([Promise.resolve().then(() => run.tunnel?.stop()), Promise.resolve().then(() => run.host?.stop())]).then(results => {
      if (run.cleanupUncertain || results.some(result => result.status === 'rejected')) {
        run.cleanupFailed = true;
        if (active === run) publish({ status: 'error', stage: 'Cleanup needs attention', error: 'A host process could not be stopped. End cloudflared.exe and this app in Task Manager before starting another match.', endpoint: null, invite: null, password: null });
        return false;
      }
      run.cleanupFailed = false;
      return true;
    });
    return run.cleanup;
  }
  function unexpected(run, what) {
    if (!current(run)) return;
    publish({ status: 'error', stage: 'Host stopped', error: what, invite: null, endpoint: null, password: null });
    log(what, run);
    void cleanup(run).then(cleaned => { if (cleaned && active === run) active = null; });
  }
  async function poll(run) {
    if (!current(run) || run.polling) return;
    run.polling = true;
    try {
      const info = await read(run.localOrigin, { signal: run.abort.signal });
      if (current(run)) publish({ info, stage: 'Host running' });
      run.failedPolls = 0;
    } catch {
      if (current(run) && ++run.failedPolls >= 3) unexpected(run, 'The local match stopped responding. Start a new match to continue.');
    } finally { run.polling = false; }
  }
  function start(raw) {
    if (disposed) return Promise.reject(new Error('The host app is closing.'));
    if (state.status === 'starting' || state.status === 'running' || state.status === 'stopping' || startWork || stopWork || active) return Promise.resolve(snapshot());
    let config;
    try { config = security.settings(raw); } catch (error) { publish({ status: 'error', error: error.message }); return Promise.resolve(snapshot()); }
    const run = { abort: new AbortController(), password: makePassword(), host: null, tunnel: null, timer: null, failedPolls: 0 };
    active = run;
    publish({ status: 'starting', stage: 'Starting the local match…', serverName: config.serverName, port: config.port, endpoint: null, invite: null, password: null, info: null, error: null, logs: [] });
    startWork = (async () => {
      try {
        run.host = await startHost({ password: run.password, port: config.port, serverName: config.serverName, allowedOrigins: [new URL(config.pagesUrl).origin], signal: run.abort.signal, log: value => log(value, run), onExit: () => unexpected(run, 'The match process exited. Start a new match to continue.') });
        if (!current(run)) return;
        run.localOrigin = `http://127.0.0.1:${run.host.port}`;
        const info = await read(run.localOrigin, { signal: run.abort.signal });
        if (!current(run)) return;
        publish({ info, port: run.host.port, stage: config.mode === 'quick' ? 'Opening an experimental Cloudflare tunnel…' : 'Checking your HTTPS endpoint…' });
        let endpoint = config.endpoint;
        if (config.mode === 'quick') {
          run.tunnel = await startTunnel({ port: run.host.port, signal: run.abort.signal, log: value => log(value, run) });
          if (!current(run)) return;
          endpoint = security.publicOrigin(run.tunnel.url);
          run.tunnel.exited.then(exit => { if (!exit.expected) unexpected(run, 'The Cloudflare tunnel disconnected. Start again for a new invite, or use your own HTTPS endpoint.'); }).catch(() => unexpected(run, 'The Cloudflare tunnel disconnected.'));
        }
        publish({ stage: 'Verifying the public connection…' });
        await verify(endpoint, info, { signal: run.abort.signal, pagesOrigin: new URL(config.pagesUrl).origin, read });
        if (!current(run)) return;
        publish({ status: 'running', stage: 'Match is online', endpoint, password: run.password, invite: security.invite(config.pagesUrl, endpoint, run.password) });
        log('Public endpoint verified. The invite is ready.', run);
        run.timer = setInterval(() => void poll(run), pollMs);
        run.timer.unref?.();
      } catch (error) {
        // A helper can fail to terminate before it returns its handle. Never forget that uncertain process.
        if (error?.code === 'TUNNEL_STOP_TIMEOUT') run.cleanupUncertain = true;
        if (current(run)) {
          const message = security.cleanLog(error instanceof Error ? error.message : 'The match could not start.', run.password);
          publish({ status: 'error', stage: 'Could not start', error: message, invite: null, password: null, endpoint: null });
          log(message, run);
        }
      } finally {
        if (state.status !== 'running' || !current(run)) {
          // Handles resources which resolved after cancellation, as well as partial starts.
          run.cleanup = null;
          const cleaned = await cleanup(run);
          if (cleaned && active === run) active = null;
        }
      }
      return snapshot();
    })().then(() => snapshot()).finally(() => { startWork = null; });
    return startWork;
  }
  function stop() {
    if (stopWork) return stopWork;
    const run = active;
    if (!run) { publish({ status: 'idle', stage: 'Ready to host', endpoint: null, invite: null, password: null, info: null, error: null }); return Promise.resolve(snapshot()); }
    publish({ status: 'stopping', stage: 'Closing the match and tunnel…', invite: null, password: null, endpoint: null });
    run.abort.abort();
    clearInterval(run.timer);
    stopWork = (async () => {
      await startWork?.catch(() => {});
      // A previous cleanup attempt may have timed out; an explicit Stop/quit can retry owned handles.
      if (run.cleanupFailed) run.cleanup = null;
      const cleaned = await cleanup(run);
      if (!cleaned) return snapshot();
      if (active === run) active = null;
      publish({ status: 'idle', stage: 'Ready to host', port: null, info: null, error: null });
      return snapshot();
    })().finally(() => { stopWork = null; });
    return stopWork;
  }
  return { start, stop, getState: snapshot, async dispose() { disposed = true; return stop(); } };
}
module.exports = { createHostController };
