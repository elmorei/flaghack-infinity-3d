'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const yaml = require('js-yaml');
const workflow = yaml.load(readFileSync(join(__dirname, '../../.github/workflows/pages-host-release.yml'), 'utf8'));
test('only main publication can create a host release and deploy Pages', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on.push.branches, ['main']);
  for (const id of ['publish-host', 'deploy-pages']) {
    assert.match(workflow.jobs[id].if, /github\.event_name != 'pull_request'/);
    assert.match(workflow.jobs[id].if, /github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow.jobs[id].if, /github\.repository == 'elmorei\/flaghack-infinity-3d'/);
  }
  assert.deepEqual(workflow.jobs['publish-host'].needs, ['client', 'windows-host', 'startup-browser', 'update-browser']);
  assert.deepEqual(workflow.jobs['deploy-pages'].needs, ['client', 'publish-host']);
  assert.deepEqual(workflow.jobs['publish-host'].permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs['deploy-pages'].permissions, { pages: 'write', 'id-token': 'write' });
});
test('all third-party actions are immutable and builds have no write token', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
  }
  for (const id of ['client', 'windows-host', 'startup-browser', 'update-browser']) {
    assert.equal(workflow.jobs[id].permissions, undefined);
    const checkout = workflow.jobs[id].steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with['persist-credentials'], false);
    assert.ok(!workflow.jobs[id].steps.some(step => /gh release|git push/.test(step.run || '')));
  }
});
test('immutable releases are checksummed and never overwritten', () => {
  const publish = workflow.jobs['publish-host'].steps.find(step => step.run)?.run;
  assert.match(publish, /sha256sum --check/);
  assert.match(publish, /TAG="host-\$BUILD_ID"/);
  assert.match(publish, /\[\[ "\$TARGET" == "\$BUILD_ID" \]\]/);
  assert.match(publish, /cd existing && sha256sum --check/);
  assert.ok(!publish.includes('--clobber'));
});

test('real startup browser validation gates publication of the same built client', () => {
  const browser = workflow.jobs['startup-browser'];
  assert.deepEqual(browser.needs, ['client']);
  assert.equal(browser['runs-on'], 'macos-15');
  const artifact = browser.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(artifact.with.name, 'github-pages');
  const run = browser.steps.find(step => step.run)?.run;
  assert.match(run, /artifact\.tar/);
  assert.match(run, /playwright@1\.56\.1/);
  assert.match(run, /verify-startup-browser\.cjs/);
  assert.doesNotMatch(run, /--no-sandbox|--ignore-gpu-blocklist|--enable-unsafe/);
});

test('host package smoke launches the configured branded executable, not the legacy name', () => {
  const host = require('../electron-host-builder.cjs');
  const verify = readFileSync(join(__dirname, 'verify-host-package.cjs'), 'utf8');
  assert.equal(host.win.executableName, 'FLAGHACK∞3D Match Host');
  assert.equal(host.win.executableName, host.productName);
  assert.ok(verify.includes("require('../electron-host-builder.cjs')"));
  assert.ok(verify.includes('`${hostBuild.win.executableName}.exe`'));
  assert.ok(verify.includes('existsSync(executable)'));
  assert.ok(verify.includes('spawn(executable,'));
  assert.ok(!verify.includes('FLAGHACK Match Host.exe'));
  assert.equal(host.portable.artifactName, 'Flaghack-Host-Windows-x64.${ext}');
});

test('mobile sprites, pixel HUD, Crow and explosion checks gate publication against the built Pages artifact', () => {
  const browser = workflow.jobs['update-browser'];
  assert.deepEqual(browser.needs, ['client']);
  assert.equal(browser['runs-on'], 'macos-15');
  const artifact = browser.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(artifact.with.name, 'github-pages');
  const runs = browser.steps.map(step => step.run || '').join('\n');
  assert.match(runs, /npm run build:server/);
  assert.match(runs, /artifact\.tar/);
  assert.doesNotMatch(runs, /npm run build(?:\s|:pages)/);
  assert.ok(browser['timeout-minutes'] >= 60);
  const evidence = browser.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(evidence.if, 'always()');
  for (const directory of ['mobile-sprites-smoke', 'mobile-pixel-smoke', 'mobile-hud-smoke', 'auto-style-smoke', 'explosion-smoke', 'mobile-ley-smoke']) assert.ok(evidence.with.path.includes(`web/host-release/${directory}/`));
  for (const script of ['verify-mobile-sprites-browser.mjs', 'verify-mobile-pixel-browser.mjs', 'verify-mobile-hud-browser.mjs', 'verify-auto-style-browser.mjs', 'verify-explosion-browser.mjs', 'verify-mobile-ley-browser.mjs']) assert.ok(runs.includes(script));
  assert.doesNotMatch(runs, /--no-sandbox|--ignore-gpu-blocklist|--enable-unsafe/);
});


test('mobile preview keeps Pages and native checks without enforcing legacy solo bundle limits', () => {
  const preview = yaml.load(readFileSync(join(__dirname, '../../.github/workflows/mobile-sprites-preview.yml'), 'utf8'));
  const fullRuns = preview.jobs['full-checks'].steps.map(step => step.run || '').join('\n');
  for (const command of ['npm run build:pages', 'npm run build:server', 'npm run host-app:test', 'npm run host-app:build', 'node scripts/verify-pages-build.cjs']) assert.ok(fullRuns.includes(command));
  const allRuns = Object.values(preview.jobs).flatMap(job => job.steps.map(step => step.run || '')).join('\n');
  assert.doesNotMatch(allRuns, /build-game-bundle|preview-main-bundle|preview-iteration-bundle/);
  const native = preview.jobs['native-browser'];
  assert.equal(native['runs-on'], 'macos-15');
  const nativeRuns = native.steps.map(step => step.run || '').join('\n');
  for (const name of ['startup', 'mobile-sprites', 'mobile-pixel', 'mobile-hud', 'mobile-command', 'auto-style', 'explosion', 'mobile-ley']) assert.match(nativeRuns, new RegExp(`verify-${name}-browser\\.(?:mjs|cjs)`));
  assert.doesNotMatch(nativeRuns, /--no-sandbox|--ignore-gpu-blocklist|--enable-unsafe/);
});
