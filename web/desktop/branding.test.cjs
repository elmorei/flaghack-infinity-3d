'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const text = file => readFileSync(join(__dirname, '..', file), 'utf8');

test('launcher and host present the exact product name without changing distribution identities', () => {
  const launcher = require('../electron-builder.cjs');
  const host = require('../electron-host-builder.cjs');
  assert.equal(launcher.productName, 'FLAGHACK∞3D');
  assert.equal(host.productName, 'FLAGHACK∞3D Match Host');
  assert.equal(launcher.appId, 'com.flaghack.infinity');
  assert.equal(host.appId, 'com.flaghack.infinity.matchhost');
  assert.equal(launcher.nsis.artifactName, 'Flaghack-Setup-${version}-${arch}.${ext}');
  assert.equal(host.portable.artifactName, 'Flaghack-Host-Windows-x64.${ext}');
  assert.match(launcher.publish[0].url, /^https:\/\/github.com\/elmorei\/flaghack-infinity-3d\/releases\/download\/desktop-(stable|iteration)\/$/);
  const launcherHtml = text('desktop/launcher.html');
  assert.ok(launcherHtml.includes('<title>FLAGHACK∞3D Launcher</title>'));
  assert.equal(launcherHtml.match(/<h1>(.*?)<\/h1>/)[1].replace(/<[^>]+>/g, ''), 'FLAGHACK∞3D');
  assert.ok(text('host-desktop/host.html').includes('<title>FLAGHACK∞3D Match Host</title>'));
});

test('renaming preserves packaged and development profile paths before startup', () => {
  for (const [file, isPackaged, expected] of [
    ['desktop/main.cjs', true, join('/profiles', 'FLAGHACK Infinity')],
    ['desktop/main.cjs', false, '/development-profile'],
    ['host-desktop/main.cjs', true, join('/profiles', 'FLAGHACK Match Host')],
    ['host-desktop/main.cjs', false, join('/profiles', 'FLAGHACK Match Host')],
  ]) {
    const paths = {}, calls = [];
    const app = { isPackaged, getPath: name => name === 'appData' ? '/profiles' : '/development-profile', setPath: (name, value) => { paths[name] = value; calls.push(name); }, setName: name => calls.push(name) };
    const source = text(file);
    const start = source.indexOf('const legacyUserData =');
    const end = source.indexOf('app.enableSandbox();');
    assert.ok(start >= 0 && end > start);
    runInNewContext(source.slice(start, end), { app, join });
    assert.deepEqual(paths, { userData: expected, sessionData: expected });
    assert.deepEqual(calls, ['userData', 'sessionData', file.startsWith('desktop/') ? 'FLAGHACK∞3D' : 'FLAGHACK∞3D Match Host']);
    assert.ok(end < source.indexOf('app.requestSingleInstanceLock()'));
  }
});
