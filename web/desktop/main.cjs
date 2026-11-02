'use strict';
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { startGameServer } = require('./game-server.cjs');
const { createGameUpdater } = require('./game-updater.cjs');
const { readFile } = require('node:fs/promises');
const { createStorageWriter } = require('./storage.cjs');
const storage = createStorageWriter();
const { autoUpdater } = require('electron-updater');
const { createUpdater } = require('./updater.cjs');
const launcherUrl = pathToFileURL(join(__dirname, 'launcher.html')).href;
let launcher, game, host, updater, gameUpdater, origin, quitting = false;
let closingHost = Promise.resolve();
const snapshot = () => ({ ...updater.getState(), game: gameUpdater?.getState() });
function sendState() { if (launcher && !launcher.isDestroyed() && updater) launcher.webContents.send('launcher:state', snapshot()); }
let gamePreferences = {}, savedPreferences = '', storagePath;
const gameKeys = ['fh.training.v1', 'fh.settings.v1', 'fh.handle.v1'];

// Keep existing profiles and game saves when the displayed product name changes.
const legacyUserData = app.isPackaged ? join(app.getPath('appData'), 'FLAGHACK Infinity') : app.getPath('userData');
app.setPath('userData', legacyUserData);
app.setPath('sessionData', legacyUserData);
app.setName('FLAGHACK∞3D');
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const win = game || launcher; if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(start).catch(fatal);
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const active = host;
  host = null;
  const deadline = setTimeout(() => app.exit(0), 3500);
  captureGamePreferences().then(() => Promise.all([active ? active.close() : Promise.resolve(), storage.flush()])).catch(console.error).finally(() => { clearTimeout(deadline); app.quit(); });
});

function fatal(error) {
  console.error(error);
  dialog.showErrorBox('FLAGHACK∞3D could not start', 'The local game could not start. No update was installed. Close the app and try again.\n\n' + (error instanceof Error ? error.message : String(error)));
  app.quit();
}
function lockWindow(win, allowed) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => dialog.showErrorBox('FLAGHACK∞3D window stopped', 'Close this window and reopen the game. Your installed files have not changed.'));
}
function sameOrigin(url) { try { return new URL(url).origin === origin; } catch { return false; } }
function launcherSender(event) { return launcher && !launcher.isDestroyed() && event.sender === launcher.webContents && event.senderFrame === launcher.webContents.mainFrame && event.senderFrame.url === launcherUrl; }
function handle(name, fn) { ipcMain.handle(name, (event, ...args) => { if (!launcherSender(event)) throw new Error('Untrusted launcher request'); return fn(...args); }); }

function saveGamePreferences(values) {
  if (!values || typeof values !== 'object') return;
  const clean = {};
  for (const key of gameKeys) if (typeof values[key] === 'string' && values[key].length <= 65536) clean[key] = values[key];
  const serialized = JSON.stringify(clean);
  if (serialized === savedPreferences) return;
  gamePreferences = clean;
  savedPreferences = serialized;
  storage.write(storagePath, clean).catch(error => { if (savedPreferences === serialized) savedPreferences = ''; console.error(error); });
}
async function captureGamePreferences() {
  if (!game || game.isDestroyed()) return;
  try {
    const values = await game.webContents.executeJavaScript('Object.fromEntries(' + JSON.stringify(gameKeys) + '.map(key => [key, localStorage.getItem(key)]))');
    saveGamePreferences(values);
  } catch (error) { console.error('Could not save final game preferences:', error); }
}

async function start() {
  Menu.setApplicationMenu(null);
  storagePath = join(app.getPath('userData'), 'game-preferences.json');
  try { gamePreferences = JSON.parse(await readFile(storagePath, 'utf8')); } catch { gamePreferences = {}; }
  const gameSender = event => game && !game.isDestroyed() && event.sender === game.webContents && event.senderFrame === game.webContents.mainFrame && sameOrigin(event.senderFrame.url);
  ipcMain.on('game:restore', event => { event.returnValue = gameSender(event) ? gamePreferences : {}; });
  ipcMain.on('game:save', (event, values) => {
    if (!gameSender(event) || !values || typeof values !== 'object') return;
    saveGamePreferences(values);
  });
  const prefsPath = join(app.getPath('userData'), 'launcher.json');
  const channel = require('../package.json').desktopChannel || (app.getVersion().includes('-iteration.') ? 'iteration' : 'stable');
  let gameBranch = channel === 'stable' ? 'main' : 'iteration';
  try { const saved = JSON.parse(await readFile(prefsPath, 'utf8')); if (['main', 'iteration'].includes(saved.gameBranch)) gameBranch = saved.gameBranch; else if (['stable', 'iteration'].includes(saved.channel)) gameBranch = saved.channel === 'stable' ? 'main' : 'iteration'; } catch {}
  updater = createUpdater({ autoUpdater, isPackaged: app.isPackaged, version: app.getVersion(), initialChannel: channel,
    onState: sendState,

  });
  let bundled = { branch: channel === 'stable' ? 'main' : 'iteration', commit: null };
  try { bundled = JSON.parse(await readFile(join(__dirname, 'bundled-game.json'), 'utf8')); } catch {}
  gameUpdater = createGameUpdater({ cacheRoot: join(app.getPath('userData'), 'game-cache'), bundledDir: join(__dirname, '..', 'dist'), bundledBranch: bundled.branch, bundledCommit: bundled.commit, initialBranch: gameBranch, onState: sendState });
  await gameUpdater.initialize();
  const launcherSession = session.fromPartition('flaghack-launcher');
  launcherSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  launcherSession.setPermissionCheckHandler(() => false);
  const root = pathToFileURL(__dirname + '/').href;
  launcherSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(root) }));
  launcher = new BrowserWindow({ width: 900, height: 760, minWidth: 760, minHeight: 640, show: false, backgroundColor: '#100d19', title: 'FLAGHACK∞3D Launcher', icon: join(__dirname, 'icon.png'), webPreferences: { preload: join(__dirname, 'preload.cjs'), partition: 'flaghack-launcher', contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
  lockWindow(launcher, url => url === launcherUrl);
  handle('launcher:get', snapshot);
  handle('launcher:channel', async value => {
    if (!['stable', 'iteration'].includes(value)) throw new Error('Unknown channel');
    if (game || startingGame || confirmingInstall || ['checking', 'downloading', 'downloaded', 'installing'].includes(updater.getState().status)) throw new Error('Close the game and finish the current launcher update before changing branches.');
    await gameUpdater.setBranch(value === 'stable' ? 'main' : 'iteration');
    await storage.write(prefsPath, { gameBranch: value === 'stable' ? 'main' : 'iteration' });
    void gameUpdater.check();
    return snapshot();
  });
  handle('launcher:game-check', async () => { await gameUpdater.check(); return snapshot(); });
  handle('launcher:game-download', async () => { if (game || startingGame || confirmingInstall || quitting || updater.getState().status === 'installing') throw new Error('Close the game and finish the launcher update action before applying game content.'); await gameUpdater.download(); return snapshot(); });
  handle('launcher:game-rollback', async () => { if (game || startingGame || confirmingInstall || quitting || updater.getState().status === 'installing') throw new Error('Close the game and finish the launcher update action before restoring game content.'); await gameUpdater.rollback(); return snapshot(); });
  handle('launcher:check', async () => { await updater.check(); return snapshot(); });
  handle('launcher:download', async () => { await updater.download(); return snapshot(); });
  handle('launcher:install', async () => {
    if (startingGame || confirmingInstall || gameUpdater.getState().status === 'downloading' || (game && !game.isDestroyed())) return { message: 'Close the game before installing an update.' };
    if (!updater.getState().canInstall) throw new Error('No update is ready');
    confirmingInstall = true;
    let choice;
    try { choice = await dialog.showMessageBox(launcher, { type: 'question', buttons: ['Cancel', 'Install and restart'], defaultId: 0, cancelId: 0, title: 'Install FLAGHACK∞3D update?', message: 'The launcher will close and run the downloaded Windows installer.', detail: 'Only install updates you intended to download. Save or finish any game first.' }); } finally { confirmingInstall = false; }
    if (choice.response === 1 && !game && !startingGame && !quitting) updater.install();
    return snapshot();
  });
  handle('launcher:play', async () => { await play(); return { message: 'Game opened. Close its window to return to the launcher.' }; });
  await launcher.loadFile(join(__dirname, 'launcher.html'));
  launcher.show();
  void gameUpdater.check();
}
let startingGame, confirmingInstall = false;
async function play() {
  if (quitting || confirmingInstall || updater.getState().status === 'installing' || gameUpdater.getState().status === 'downloading') throw new Error('Wait for the update action to finish before opening the game.');
  if (game && !game.isDestroyed()) { game.show(); game.focus(); return; }
  if (startingGame) return startingGame;
  startingGame = openGame();
  try { await startingGame; } finally { startingGame = null; }
}
async function openGame() {
  await closingHost;
  const selection = await gameUpdater.getPlayable();
  host = await startGameServer({ staticDir: selection.dir });
  origin = `http://127.0.0.1:${host.port}`;
  const wsOrigin = origin.replace('http:', 'ws:');
  const gameSession = session.fromPartition('persist:flaghack-game');
  gameSession.setPermissionRequestHandler((wc, permission, callback) => callback(!!wc && sameOrigin(wc.getURL()) && ['pointerLock', 'fullscreen'].includes(permission)));
  gameSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => !!wc && sameOrigin(requestingOrigin) && ['pointerLock', 'fullscreen'].includes(permission));
  gameSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    callback({ cancel: url === origin + '/api/info' || !(sameOrigin(url) || url.startsWith(wsOrigin + '/') || url.startsWith('data:') || url.startsWith('blob:')) });
  });
  gameSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders,
    'Content-Security-Policy': [`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' ${wsOrigin}; object-src 'none'; frame-src 'none'; base-uri 'none'`],
  } }));
  game = new BrowserWindow({ width: 1440, height: 900, minWidth: 960, minHeight: 600, show: false, backgroundColor: '#100d19', title: 'FLAGHACK∞3D', icon: join(__dirname, 'icon.png'), webPreferences: { preload: join(__dirname, 'game-preload.cjs'), partition: 'persist:flaghack-game', contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
  const current = game;
  let closing = false;
  current.on('close', event => {
    if (closing || quitting) return;
    event.preventDefault();
    closing = true;
    const deadline = setTimeout(() => { if (!current.isDestroyed()) current.destroy(); }, 3000);
    captureGamePreferences().then(() => storage.flush()).catch(console.error).finally(() => { clearTimeout(deadline); if (!current.isDestroyed()) current.destroy(); });
  });
  lockWindow(current, sameOrigin);
  current.on('closed', () => {
    game = null;
    const ended = host; host = null;
    if (ended) closingHost = ended.close().catch(console.error);
    if (launcher && !launcher.isDestroyed()) { launcher.show(); launcher.focus(); }
  });
  try {
    await current.loadURL(origin + '/');
    current.show();
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (current.isDestroyed()) return;
      if (await current.webContents.executeJavaScript('Boolean(window.flaghack)')) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('The game did not finish starting.');
  } catch (error) {
    if (!closing) await gameUpdater.reportLaunchFailure(selection);
    if (!current.isDestroyed()) current.destroy();
    if (!closing) throw new Error('The game could not start. Play again to use the previous verified build or bundled fallback.');
  }
}
