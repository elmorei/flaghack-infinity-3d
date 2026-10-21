'use strict';
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = join(__dirname, '..');
const output = join(root, 'host-release');
const portable = join(output, 'Flaghack-Host-Windows-x64.exe');
const unpacked = join(output, 'win-unpacked');
const resources = join(unpacked, 'resources');
const archive = join(resources, 'app.asar');
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(metadata.main, 'host-desktop/main.cjs');
const files = asar.listPackage(archive);
assert.ok(files.includes('/dist-host/host-api.js'));
assert.ok(files.includes('/host-desktop/host-worker.cjs'));
assert.ok(files.includes('/node_modules/ws/index.js'), 'Main-process WSS probe dependency must be packaged');
assert.ok(!files.includes('/desktop/main.cjs'), 'Offline launcher must not be the host executable');
assert.ok(!files.includes('/desktop/game-updater.cjs'), 'Host must not load browser update bundles as server code');
const vendor = join(resources, 'vendor');
const manifest = JSON.parse(readFileSync(join(vendor, 'cloudflared-manifest.json'), 'utf8'));
assert.ok(existsSync(join(vendor, 'cloudflared-LICENSE.txt')));
assert.ok(existsSync(join(vendor, 'cloudflared.exe')));
assert.ok(manifest.version, 'Pinned tunnel identity is included');
const digest = createHash('sha256').update(readFileSync(portable)).digest('hex');
writeFileSync(join(output, 'SHA256SUMS.txt'), `${digest}  Flaghack-Host-Windows-x64.exe\n`);
async function smoke() {
  if (process.platform !== 'win32') throw new Error('Packaged Windows smoke requires Windows');
  const tunnelVersion = execFileSync(join(vendor, 'cloudflared.exe'), ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ok(tunnelVersion.includes(manifest.version), 'Packaged official tunnel executable runs and matches manifest');
  const result = join(tmpdir(), `flaghack-host-smoke-${randomUUID()}.json`);
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(join(unpacked, 'FLAGHACK Match Host.exe'), ['--smoke-test', '--smoke-result', result], { windowsHide: true, stdio: 'ignore' });
      const deadline = setTimeout(() => { child.kill(); reject(new Error('Packaged host smoke timed out')); }, 45000);
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('exit', code => { clearTimeout(deadline); resolve(code); });
    });
    assert.equal(code, 0, 'Packaged host process exit');
    const report = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(report.ok, true);
    assert.equal(report.packaged, true);
    assert.equal(report.portClosed, true);
    const expected = process.env.GITHUB_SHA || require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(report.build, expected);
    console.log(`Packaged Windows utilityProcess host starts, reports ${report.build}, and closes its port; SHA256 ${digest}`);
  } finally { rmSync(result, { force: true }); }
}
smoke().catch(error => { console.error(error); process.exitCode = 1; });
