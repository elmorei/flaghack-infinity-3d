'use strict';

// Main-process integration with mocked Electron APIs. These tests verify wiring,
// not Chromium rendering or actual Windows installation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFile, writeFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, basename } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

function event() { return { prevented: false, preventDefault() { this.prevented = true; } }; }
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('Mocked main process did not reach the expected state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function loadMain(t, options = {}) {
  const userData = await mkdtemp(join(tmpdir(), 'flaghack-main-test-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  if (options.savedLauncher) await writeFile(join(userData, 'launcher.json'), JSON.stringify(options.savedLauncher));
  const windows = [];
  const handlers = new Map();
  const sessions = new Map();
  const hostCalls = [];
  let hostCloseCalls = 0;
  const behavior = { readinessError: options.readinessError || null };
  let gameUpdaterOptions;
  const gameUpdater = {
    initializeCalls: 0, checkCalls: 0, downloadCalls: 0, rollbackCalls: 0, branchCalls: [], launchFailures: [],
    playable: options.playable || { dir: join(__dirname, '..', 'dist'), branch: 'main', commit: 'a'.repeat(40), source: 'bundled' },
    state: { branch: 'main', status: 'idle', currentBranch: 'main', currentCommit: 'a'.repeat(40), source: 'bundled', tipCommit: null, canDownload: false, canRollback: false },
    emit(patch) { this.state = { ...this.state, ...patch }; gameUpdaterOptions.onState(this.getState()); return this.getState(); },
    getState() { return { ...this.state }; },
    async initialize() { this.initializeCalls += 1; return this.getState(); },
    async check() { this.checkCalls += 1; return this.emit({ status: 'current', tipCommit: this.playable.commit }); },
    async setBranch(branch) { this.branchCalls.push(branch); return this.emit({ branch, status: 'idle', tipCommit: null }); },
    async download() { this.downloadCalls += 1; return this.emit({ status: 'ready' }); },
    async rollback() { this.rollbackCalls += 1; return this.emit({ status: 'rolled-back' }); },
    async getPlayable() { return { ...this.playable }; },
    async reportLaunchFailure(selection) {
      this.launchFailures.push(selection);
      this.playable = { dir: gameUpdaterOptions.bundledDir, branch: gameUpdaterOptions.bundledBranch, commit: gameUpdaterOptions.bundledCommit, source: 'bundled' };
      return this.emit({ status: 'rolled-back', source: 'bundled', currentBranch: this.playable.branch, currentCommit: this.playable.commit });
    },
  };
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true, didEnableSandbox: false, finalQuits: 0,
    enableSandbox() { this.didEnableSandbox = true; },
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    getVersion: () => options.version || '1.0.0',
    getPath: name => name === 'appData' ? join(userData, '..') : userData,
    setPath(name, value) { this.paths ||= {}; this.paths[name] = value; },
    setName(name) { this.name = name; },
    exit() { this.finalQuits += 1; },
    quit() { const quitting = event(); this.emit('before-quit', quitting); if (!quitting.prevented) this.finalQuits += 1; },
  });
  class MockWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.shown = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '' }, sent: [], scripts: [],
        getURL: () => this.webContents.mainFrame.url,
        setWindowOpenHandler: (callback) => { this.webContents.openWindow = callback; },
        send: (...args) => this.webContents.sent.push(args),
        executeJavaScript: async script => {
          this.webContents.scripts.push(script);
          if (script === 'Boolean(window.flaghack)') {
            if (behavior.readinessError) throw behavior.readinessError;
            return true;
          }
          return this.preferences || {};
        },
      });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() { this.shown = true; }
    focus() { this.focused = true; }
    async loadFile(path) { this.webContents.mainFrame.url = pathToFileURL(path).href; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const session = {
    fromPartition(name) {
      if (!sessions.has(name)) {
        const current = {
          setPermissionRequestHandler(fn) { this.permissionRequest = fn; },
          setPermissionCheckHandler(fn) { this.permissionCheck = fn; },
          webRequest: {
            onBeforeRequest(fn) { this.beforeRequest = fn; },
            onHeadersReceived(fn) { this.headersReceived = fn; },
          },
        };
        sessions.set(name, current);
      }
      return sessions.get(name);
    },
  };
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  const dialog = {
    response: 0, confirmations: [], errors: [],
    showErrorBox(...args) { this.errors.push(args); },
    async showMessageBox(_parent, options) { this.confirmations.push(options); return { response: this.response }; },
  };
  const autoUpdater = new EventEmitter();
  Object.assign(autoUpdater, {
    checkCalls: 0, downloadCalls: 0, installCalls: [],
    setFeedURL(options) { this.feed = options; },
    async checkForUpdates() { this.checkCalls += 1; this.emit('update-available', { version: '1.1.0' }); },
    async downloadUpdate() { this.downloadCalls += 1; this.emit('update-downloaded', { version: '1.1.0' }); },
    quitAndInstall(...args) { this.installCalls.push(args); },
  });
  const electron = { app, BrowserWindow: MockWindow, ipcMain, dialog, session, Menu: { setApplicationMenu() {} } };
  const source = await readFile(join(__dirname, 'main.cjs'), 'utf8');
  // Execute production main unchanged and mock only its Electron, static-server,
  // and game-update boundaries. Launcher updater and storage stay real.
  const context = {
    __dirname, console, URL, setTimeout, clearTimeout,
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'electron-updater') return { autoUpdater };
      if (name === './game-server.cjs') return { startGameServer: async serverOptions => { hostCalls.push(serverOptions); return { port: 49321, close: async () => { hostCloseCalls += 1; } }; } };
      if (name === './game-updater.cjs') return { createGameUpdater: updaterOptions => { gameUpdaterOptions = updaterOptions; gameUpdater.state.branch = updaterOptions.initialBranch; return gameUpdater; } };
      if (name === '../package.json') return { desktopChannel: options.desktopChannel || 'stable' };
      return require(name);
    },
  };
  vm.runInNewContext(source, context, { filename: join(__dirname, 'main.cjs') });
  await until(() => windows.length > 0 && windows[0].shown);
  const launcher = windows[0];
  const sender = () => ({ sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame });
  const invoke = (name, ...args) => handlers.get(name)(sender(), ...args);
  return { app, windows, launcher, handlers, sessions, ipcMain, dialog, autoUpdater, gameUpdater, gameUpdaterOptions, behavior, hostCalls, getHostCloseCalls: () => hostCloseCalls, userData, invoke, sender };
}

test('launcher starts sandboxed, local-only and with explicit-action IPC', async (t) => {
  const context = await loadMain(t);
  assert.equal(context.app.didEnableSandbox, true);
  const prefs = context.launcher.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webviewTag, false);
  assert.equal(basename(prefs.preload), 'preload.cjs');
  assert.equal(context.autoUpdater.checkCalls, 0);
  assert.equal(context.gameUpdater.initializeCalls, 1);
  assert.equal(context.gameUpdater.checkCalls, 1);
  assert.equal(context.gameUpdaterOptions.initialBranch, 'main');
  assert.equal(context.gameUpdaterOptions.cacheRoot, join(context.userData, 'game-cache'));
  assert.equal(context.invoke('launcher:get').channel, 'stable');
  assert.equal(context.invoke('launcher:get').game.branch, 'main');
  assert.equal(context.invoke('launcher:get').game.status, 'current');
  assert.equal(context.launcher.webContents.openWindow({ url: 'https://example.invalid' }).action, 'deny');
  const navigation = event();
  context.launcher.webContents.emit('will-navigate', navigation, 'https://example.invalid');
  assert.equal(navigation.prevented, true);
  const local = context.sessions.get('flaghack-launcher');
  assert.equal(local.permissionCheck(), false);
  let result;
  local.webRequest.beforeRequest({ url: 'https://example.invalid/script.js' }, (value) => { result = value; });
  assert.equal(result.cancel, true);
  local.webRequest.beforeRequest({ url: pathToFileURL(join(__dirname, 'launcher.js')).href }, (value) => { result = value; });
  assert.equal(result.cancel, false);
});

test('launcher IPC rejects other renderers, child frames and unexpected documents', async (t) => {
  const context = await loadMain(t);
  const original = context.launcher.webContents.mainFrame.url;
  for (const name of ['launcher:get', 'launcher:channel', 'launcher:check', 'launcher:download', 'launcher:install', 'launcher:play', 'launcher:game-check', 'launcher:game-download', 'launcher:game-rollback']) {
    const handler = context.handlers.get(name);
    assert.equal(typeof handler, 'function', name);
    assert.throws(() => handler({ sender: {}, senderFrame: context.launcher.webContents.mainFrame }), /Untrusted/, name);
    assert.throws(() => handler({ sender: context.launcher.webContents, senderFrame: { url: original } }), /Untrusted/, name);
    context.launcher.webContents.mainFrame.url = pathToFileURL(join(__dirname, 'other.html')).href;
    assert.throws(() => handler(context.sender()), /Untrusted/, name);
    context.launcher.webContents.mainFrame.url = original;
  }
  assert.equal(context.autoUpdater.checkCalls, 0);
  assert.equal(context.gameUpdater.checkCalls, 1);
  assert.equal(context.gameUpdater.downloadCalls, 0);
  assert.equal(context.gameUpdater.rollbackCalls, 0);
});

test('Play starts one loopback host, restricts game requests and returns to launcher after saving', async (t) => {
  const context = await loadMain(t);
  await Promise.all([context.invoke('launcher:play'), context.invoke('launcher:play')]);
  assert.equal(context.hostCalls.length, 1);
  assert.deepEqual(Object.keys(context.hostCalls[0]), ['staticDir']);
  assert.equal(basename(context.hostCalls[0].staticDir), 'dist');
  assert.equal(context.windows.length, 2);
  const game = context.windows[1];
  assert.equal(game.options.webPreferences.nodeIntegration, false);
  assert.equal(game.options.webPreferences.contextIsolation, true);
  assert.equal(game.options.webPreferences.sandbox, true);
  assert.equal(game.webContents.getURL(), 'http://127.0.0.1:49321/');
  assert.deepEqual(game.webContents.scripts, ['Boolean(window.flaghack)']);
  const current = context.sessions.get('persist:flaghack-game');
  for (const [url, allowed] of [
    ['http://127.0.0.1:49321/assets/main.js', true],
    ['http://127.0.0.1:49321/api/info', false],
    ['http://127.0.0.1:49322/assets/main.js', false],
    ['https://example.invalid/script.js', false],
    ['file:///etc/passwd', false],
  ]) {
    let result;
    current.webRequest.beforeRequest({ url }, (value) => { result = value; });
    assert.equal(result.cancel, !allowed);
  }
  assert.equal(current.permissionCheck(game.webContents, 'media', 'http://127.0.0.1:49321'), false);
  assert.equal(current.permissionCheck(game.webContents, 'pointerLock', 'http://127.0.0.1:49321'), true);
  assert.equal(current.permissionCheck(game.webContents, 'pointerLock', 'https://example.invalid'), false);
  game.preferences = { 'fh.settings.v1': '{"volume":0.4}', 'fh.training.v1': '{"seals":["arrival"]}', unknown: 'ignored' };
  const closing = event();
  game.emit('close', closing);
  assert.equal(closing.prevented, true);
  await until(() => game.isDestroyed());
  const saved = JSON.parse(await readFile(join(context.userData, 'game-preferences.json'), 'utf8'));
  assert.deepEqual(saved, { 'fh.settings.v1': '{"volume":0.4}', 'fh.training.v1': '{"seals":["arrival"]}' });
  assert.equal(context.launcher.focused, true);
  assert.equal(context.getHostCloseCalls(), 1);
  assert.ok(game.webContents.scripts.some(script => script.includes('localStorage.getItem')));
});

test('branch selection maps stable to main while keeping the packaged Electron update feed', async t => {
  const context = await loadMain(t);
  let result = await context.invoke('launcher:channel', 'iteration');
  assert.equal(result.channel, 'stable');
  assert.equal(result.game.branch, 'iteration');
  assert.equal(context.gameUpdater.checkCalls, 2);
  result = await context.invoke('launcher:channel', 'stable');
  assert.equal(result.channel, 'stable');
  assert.equal(result.game.branch, 'main');
  assert.deepEqual(context.gameUpdater.branchCalls, ['iteration', 'main']);
  assert.equal(context.gameUpdater.checkCalls, 3);
  assert.equal(context.autoUpdater.checkCalls, 0);
  assert.equal(context.gameUpdater.downloadCalls, 0);
  await assert.rejects(context.invoke('launcher:channel', 'feature'), /Unknown channel/);
  await until(() => context.launcher.webContents.sent.some(([name, state]) => name === 'launcher:state' && state.game?.branch === 'iteration'));
  context.app.quit();
  await until(() => context.app.finalQuits === 1);
  assert.deepEqual(JSON.parse(await readFile(join(context.userData, 'launcher.json'), 'utf8')), { gameBranch: 'main' });
});

test('saved game branch and legacy channel preferences cannot change the packaged Electron feed', async t => {
  for (const savedLauncher of [{ gameBranch: 'main' }, { channel: 'stable' }]) {
    await t.test(JSON.stringify(savedLauncher), async t => {
      const context = await loadMain(t, { desktopChannel: 'iteration', version: '1.0.0-iteration.1', savedLauncher });
      assert.equal(context.gameUpdaterOptions.initialBranch, 'main');
      assert.equal(context.invoke('launcher:get').game.branch, 'main');
      assert.equal(context.invoke('launcher:get').channel, 'iteration');
      assert.match(context.autoUpdater.feed.url, /desktop-iteration\/$/);
      await context.invoke('launcher:channel', 'iteration');
      assert.equal(context.invoke('launcher:get').game.branch, 'iteration');
      assert.equal(context.invoke('launcher:get').channel, 'iteration');
    });
  }
});

test('game update IPC returns combined snapshots without invoking the Electron installer', async t => {
  const context = await loadMain(t);
  const checked = await context.invoke('launcher:game-check');
  assert.equal(checked.game.status, 'current');
  assert.equal(context.gameUpdater.checkCalls, 2);
  assert.equal((await context.invoke('launcher:game-download')).game.status, 'ready');
  assert.equal(context.gameUpdater.downloadCalls, 1);
  assert.equal((await context.invoke('launcher:game-rollback')).game.status, 'rolled-back');
  assert.equal(context.gameUpdater.rollbackCalls, 1);
  assert.equal(context.autoUpdater.checkCalls, 0);
  assert.equal(context.autoUpdater.downloadCalls, 0);
  assert.deepEqual(context.autoUpdater.installCalls, []);
});

test('Play serves the controller-selected cached directory and keeps downloaded code outside Node', async t => {
  const playable = { dir: '/fixture/game-cache/main-' + 'b'.repeat(40), branch: 'main', commit: 'b'.repeat(40), source: 'cached' };
  const context = await loadMain(t, { playable });
  await context.invoke('launcher:play');
  assert.equal(context.hostCalls.length, 1);
  assert.equal(context.hostCalls[0].staticDir, playable.dir);
  assert.deepEqual(Object.keys(context.hostCalls[0]), ['staticDir']);
  assert.equal(context.windows[1].options.webPreferences.nodeIntegration, false);
  assert.equal(basename(context.windows[1].options.webPreferences.preload), 'game-preload.cjs');
  assert.equal(context.gameUpdater.launchFailures.length, 0);
});

test('game download, rollback and branch changes are blocked while the game is open', async t => {
  const context = await loadMain(t);
  await context.invoke('launcher:play');
  await assert.rejects(context.invoke('launcher:game-download'), /Close the game/);
  await assert.rejects(context.invoke('launcher:game-rollback'), /Close the game/);
  await assert.rejects(context.invoke('launcher:channel', 'iteration'), /Close the game/);
  assert.equal(context.gameUpdater.downloadCalls, 0);
  assert.equal(context.gameUpdater.rollbackCalls, 0);
  assert.deepEqual(context.gameUpdater.branchCalls, []);
  await context.invoke('launcher:game-check');
  assert.equal(context.gameUpdater.checkCalls, 2);
  const game = context.windows[1];
  game.emit('close', event());
  await until(() => game.isDestroyed());
  await context.invoke('launcher:game-download');
  assert.equal(context.gameUpdater.downloadCalls, 1);
});

test('updates and branch changes cannot race initial cached-build selection', async t => {
  const context = await loadMain(t);
  let resolveSelection;
  context.gameUpdater.getPlayable = () => new Promise(resolve => { resolveSelection = resolve; });
  const playing = context.invoke('launcher:play');
  await until(() => !!resolveSelection);
  await assert.rejects(context.invoke('launcher:game-download'), /Close the game/);
  await assert.rejects(context.invoke('launcher:game-rollback'), /Close the game/);
  await assert.rejects(context.invoke('launcher:channel', 'iteration'), /Close the game/);
  assert.equal(context.gameUpdater.downloadCalls, 0);
  assert.equal(context.gameUpdater.rollbackCalls, 0);
  resolveSelection(context.gameUpdater.playable);
  await playing;
  assert.equal(context.hostCalls.length, 1);
});

test('Play and native install are blocked while game content is downloading', async t => {
  const context = await loadMain(t);
  await context.invoke('launcher:check');
  await context.invoke('launcher:download');
  context.gameUpdater.emit({ status: 'downloading' });
  await assert.rejects(context.invoke('launcher:play'), /update action/);
  await context.invoke('launcher:install');
  assert.equal(context.hostCalls.length, 0);
  assert.equal(context.dialog.confirmations.length, 0);
  assert.deepEqual(context.autoUpdater.installCalls, []);
  context.gameUpdater.emit({ status: 'ready' });
  await context.invoke('launcher:play');
  assert.equal(context.hostCalls.length, 1);
});

test('failed game readiness reports the selected build, closes its host and permits fallback Play', async t => {
  const playable = { dir: '/fixture/game-cache/main-' + 'c'.repeat(40), branch: 'main', commit: 'c'.repeat(40), source: 'cached' };
  const context = await loadMain(t, { playable, readinessError: new Error('Fixture renderer failed before ready') });
  await assert.rejects(context.invoke('launcher:play'), /Play again to use the previous verified build or bundled fallback/);
  assert.deepEqual(context.gameUpdater.launchFailures, [playable]);
  assert.equal(context.windows[1].isDestroyed(), true);
  assert.equal(context.getHostCloseCalls(), 1);
  assert.equal(context.launcher.focused, true);
  assert.equal(context.invoke('launcher:get').game.status, 'rolled-back');
  assert.deepEqual(context.windows[1].webContents.scripts, ['Boolean(window.flaghack)']);
  context.behavior.readinessError = null;
  await context.invoke('launcher:play');
  assert.equal(context.hostCalls.length, 2);
  assert.equal(context.hostCalls[1].staticDir, context.gameUpdaterOptions.bundledDir);
  assert.equal(context.windows[2].shown, true);
  assert.equal(context.gameUpdater.launchFailures.length, 1);
});

test('native install confirmation defaults to Cancel and only confirmation invokes installer', async (t) => {
  const context = await loadMain(t);
  await context.invoke('launcher:check');
  await context.invoke('launcher:download');
  assert.deepEqual(context.autoUpdater.installCalls, []);
  await context.invoke('launcher:install');
  assert.deepEqual(context.autoUpdater.installCalls, []);
  assert.equal(context.dialog.confirmations[0].defaultId, 0);
  assert.equal(context.dialog.confirmations[0].cancelId, 0);
  context.dialog.response = 1;
  await context.invoke('launcher:install');
  assert.deepEqual(context.autoUpdater.installCalls, [[false, true]]);
  await assert.rejects(context.invoke('launcher:game-download'), /update|install/i);
  await assert.rejects(context.invoke('launcher:game-rollback'), /update|install/i);
  assert.equal(context.gameUpdater.downloadCalls, 0);
  assert.equal(context.gameUpdater.rollbackCalls, 0);
});

test('quit snapshots game settings, flushes storage and closes the host once', async (t) => {
  const context = await loadMain(t);
  await context.invoke('launcher:play');
  context.windows[1].preferences = { 'fh.handle.v1': 'Fixture Player' };
  context.app.quit();
  await until(() => context.app.finalQuits === 1);
  assert.equal(context.getHostCloseCalls(), 1);
  assert.deepEqual(JSON.parse(await readFile(join(context.userData, 'game-preferences.json'), 'utf8')), { 'fh.handle.v1': 'Fixture Player' });
  // Session callbacks may still receive requests while windows are closing.
  const current = context.sessions.get('persist:flaghack-game');
  assert.doesNotThrow(() => current.webRequest.beforeRequest({ url: 'https://example.invalid/' }, () => {}));
  assert.doesNotThrow(() => current.webRequest.headersReceived({ responseHeaders: {} }, () => {}));
});

test('Play and duplicate install requests cannot race an open native confirmation', async (t) => {
  const context = await loadMain(t);
  await context.invoke('launcher:check');
  await context.invoke('launcher:download');
  let resolveConfirmation;
  let confirmations = 0;
  context.dialog.showMessageBox = () => {
    confirmations += 1;
    return new Promise((resolve) => { resolveConfirmation = resolve; });
  };
  const pendingInstall = context.invoke('launcher:install');
  await assert.rejects(context.invoke('launcher:play'), /update action/);
  await assert.rejects(context.invoke('launcher:game-download'), /update|install/i);
  await assert.rejects(context.invoke('launcher:game-rollback'), /update|install/i);
  await context.invoke('launcher:install');
  assert.equal(confirmations, 1);
  assert.equal(context.gameUpdater.downloadCalls, 0);
  assert.equal(context.gameUpdater.rollbackCalls, 0);
  assert.equal(context.hostCalls.length, 0);
  assert.equal(context.windows.length, 1);
  resolveConfirmation({ response: 0 });
  await pendingInstall;
  assert.deepEqual(context.autoUpdater.installCalls, []);
  await context.invoke('launcher:play');
  assert.equal(context.hostCalls.length, 1);
});

 test('launcher branding preserves the legacy packaged profile and partition IDs', async t => {
  const context = await loadMain(t);
  assert.equal(context.app.name, 'FLAGHACK∞3D');
  assert.equal(context.app.paths.userData, join(context.userData, '..', 'FLAGHACK Infinity'));
  assert.equal(context.app.paths.sessionData, context.app.paths.userData);
  assert.equal(context.launcher.options.title, 'FLAGHACK∞3D Launcher');
  assert.ok(context.sessions.has('flaghack-launcher'));
});
