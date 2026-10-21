'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const text = name => readFileSync(join(__dirname, name), 'utf8');
test('renderer has restrictive security flags, permission denial, CSP and navigation locks', () => {
  const main = text('main.cjs'), html = text('host.html'), preload = text('preload.cjs');
  for (const expected of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webviewTag: false', 'event.senderFrame === window.webContents.mainFrame', 'event.senderFrame.url === uiUrl', "setWindowOpenHandler(() => ({ action: 'deny' }))", "on('will-redirect', event => event.preventDefault())", 'setPermissionCheckHandler(() => false)', "cancel: !assets.has(details.url)"]) assert.ok(main.includes(expected), expected);
  for (const expected of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"]) assert.ok(html.includes(expected), expected);
  assert.ok(!preload.includes('send:')); assert.ok(!preload.includes('require:'));
  assert.ok(!main.includes('autoUpdater')); assert.ok(!text('host-worker.cjs').includes('https:'));
});
test('standalone packaging keeps distinct app identity and trusted runtime', () => {
  const host = require('../electron-host-builder.cjs'), launcher = require('../electron-builder.cjs');
  assert.notEqual(host.appId, launcher.appId); assert.equal(host.extraMetadata.main, 'host-desktop/main.cjs'); assert.equal(host.directories.output, 'host-release'); assert.equal(host.publish, null); assert.equal(host.win.target[0].target, 'portable'); assert.ok(host.files.includes('dist-host/**/*'));
  assert.ok(!host.files.includes('dist/**/*')); assert.equal(host.extraResources[0].to, 'vendor');
});
