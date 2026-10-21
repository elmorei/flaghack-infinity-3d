'use strict';
const { app, BrowserWindow, ipcMain, session, Menu, clipboard, shell, dialog, utilityProcess } = require('electron');
const { join } = require('node:path');
const smokeMode = process.argv.includes('--smoke-test');
const { pathToFileURL } = require('node:url');
const { createHostController } = require('./controller.cjs');
const { createHostProcess } = require('./host-process.cjs');
const { startQuickTunnel } = require('./tunnel.cjs');
const { DEFAULT_PAGES_URL } = require('./security.cjs');
const uiUrl = pathToFileURL(join(__dirname, 'host.html')).href;
let window, controller, quitting = false;
app.setName('FLAGHACK Match Host');
app.enableSandbox();
if (!smokeMode && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(smokeMode ? smoke : start).catch(() => { dialog.showErrorBox('Host app could not start', 'Close the app and reopen it. If the problem continues, install the matching FLAGHACK Match Host release.'); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const cleanupWarning = () => dialog.showErrorBox('Check for a background host', 'A match or tunnel could not be stopped cleanly. End cloudflared.exe and FLAGHACK Match Host in Task Manager before starting another match.');
  const deadline = setTimeout(() => { cleanupWarning(); app.exit(1); }, 6500);
  Promise.resolve(controller?.dispose()).then(state => { if (state?.status === 'error') cleanupWarning(); }, cleanupWarning).finally(() => { clearTimeout(deadline); app.quit(); });
});
function trusted(event) { return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === uiUrl; }
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted host app request.');
    if (quitting) throw new Error('The host app is closing.');
    return fn(...args);
  });
}
async function start() {
  Menu.setApplicationMenu(null);
  // An in-memory, isolated session prevents any game page or remote content from acquiring IPC.
  const localSession = session.fromPartition('flaghack-match-host');
  localSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  localSession.setPermissionCheckHandler(() => false);
  const assets = new Set(['host.html', 'host.css', 'host.js'].map(name => pathToFileURL(join(__dirname, name)).href));
  localSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assets.has(details.url) }));
  controller = createHostController({
    startHost: createHostProcess({ utilityProcess }),
    startTunnel: options => startQuickTunnel({ ...options, executablePath: app.isPackaged ? join(process.resourcesPath, 'vendor', 'cloudflared.exe') : join(__dirname, 'vendor', 'cloudflared.exe') }),
    onState: state => { if (window && !window.isDestroyed()) window.webContents.send('host:state', state); },
  });
  window = new BrowserWindow({ width: 900, height: 840, minWidth: 740, minHeight: 640, show: false, backgroundColor: '#111421', title: 'FLAGHACK Match Host', icon: join(__dirname, '..', 'desktop', 'icon.png'), webPreferences: { preload: join(__dirname, 'preload.cjs'), partition: 'flaghack-match-host', contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { void controller.stop(); });
  window.on('closed', () => { window = null; });
  handle('host:get', () => ({ ...controller.getState(), defaults: { pagesUrl: DEFAULT_PAGES_URL, serverName: 'My FLAGHACK match', port: 8787 }, version: app.getVersion() }));
  handle('host:start', options => controller.start(options));
  handle('host:stop', () => controller.stop());
  handle('host:copy-invite', () => { const state = controller.getState(); if (state.status !== 'running' || !state.invite) throw new Error('An invite is not ready yet.'); clipboard.writeText(state.invite); return true; });
  handle('host:open-game', async () => { const state = controller.getState(); if (state.status !== 'running' || !state.invite) throw new Error('An invite is not ready yet.'); await shell.openExternal(state.invite, { activate: true }); return true; });
  handle('host:copy-password', () => { const state = controller.getState(); if (state.status !== 'running' || !state.password) throw new Error('A password is not ready yet.'); clipboard.writeText(state.password); return true; });
  await window.loadURL(uiUrl);
  window.show();
}

// Release CI runs the actual packaged entrypoint without creating a renderer or using a public tunnel.
async function smoke() {
  const { writeFile } = require('node:fs/promises');
  const { resolve, dirname, basename } = require('node:path');
  const { tmpdir } = require('node:os');
  const { readInfo } = require('./network.cjs');
  const { password } = require('./security.cjs');
  const index = process.argv.indexOf('--smoke-result');
  const resultPath = index >= 0 ? resolve(process.argv[index + 1] || '') : null;
  // Test mode cannot become an arbitrary file-writing interface.
  if (!resultPath || resolve(dirname(resultPath)).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !/^flaghack-host-smoke-[a-z0-9-]+\.json$/i.test(basename(resultPath))) { app.exit(2); return; }
  let host, result, code = 1;
  const abort = new AbortController();
  const deadline = setTimeout(() => { abort.abort(); app.exit(3); }, 25000);
  try {
    host = await createHostProcess({ utilityProcess })({ password: password(), port: 0, serverName: 'Release smoke test', allowedOrigins: [new URL(DEFAULT_PAGES_URL).origin], signal: abort.signal, log: () => {}, onExit: () => {} });
    const info = await readInfo(`http://127.0.0.1:${host.port}`);
    await host.stop();
    let closed = false;
    try { await readInfo(`http://127.0.0.1:${host.port}`, { timeoutMs: 1000 }); } catch { closed = true; }
    if (!closed) throw new Error('The match port did not close.');
    result = { ok: true, build: info.build, protocol: info.protocol, portClosed: true, packaged: app.isPackaged };
    code = 0;
  } catch { result = { ok: false, error: 'Packaged host startup, status, or cleanup failed.', packaged: app.isPackaged }; }
  finally { await host?.stop().catch(() => {}); clearTimeout(deadline); }
  await writeFile(resultPath, JSON.stringify(result) + '\n', { encoding: 'utf8', flag: 'wx' });
  app.exit(code);
}
