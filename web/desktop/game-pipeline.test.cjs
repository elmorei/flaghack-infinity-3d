'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, relative, sep } = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const { build } = require('../../.github/scripts/build-game-bundle.cjs');
const { validateBundle, inspectBundle } = require('./game-bundle.cjs');
const workflowPath = join(__dirname, '../../.github/workflows/game-bundles.yml');
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const PACKAGES = ['three', '@fontsource/bungee', '@fontsource/cinzel', '@fontsource/cinzel-decorative', '@fontsource/rubik', '@fontsource/stardos-stencil'];
const workflow = () => yaml.load(require('node:fs').readFileSync(workflowPath, 'utf8'));
const prepareScript = () => workflow().jobs['native-browser'].steps.find(step => step.id === 'prepare-browser').run.match(/^node <<'JS'\n([\s\S]+)\nJS\s*$/)[1];

test('CI packer produces a compatible browser-only bundle with required credits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'flaghack-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'web'), dist = join(web, 'dist'), out = join(root, 'out');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(join(dist, 'audio/boss'), { recursive: true });
  for (const family of ['rider-waite', 'parody']) {
    await mkdir(join(dist, 'cards', family), { recursive: true });
    await writeFile(join(dist, 'cards', family, 'sample.webp'), Buffer.from([1, 2, 3]));
  }
  await writeFile(join(dist, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/assets/game.js"></script></body></html>');
  await writeFile(join(dist, 'assets/game.js'), 'window.flaghack = {};');
  await writeFile(join(dist, 'audio/boss/CREDITS.md'), 'Fixture audio attribution');
  for (const pkg of ['three', '@fontsource/bungee', '@fontsource/cinzel', '@fontsource/cinzel-decorative', '@fontsource/rubik', '@fontsource/stardos-stencil']) {
    const dir = join(web, 'node_modules', pkg); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'LICENSE'), pkg + ' fixture license');
  }
  const manifest = await build({ branch: 'main', commit: 'a'.repeat(40), dist, out });
  const content = validateBundle(await readFile(join(out, manifest.bundle)), manifest);
  assert.equal(content.branch, 'main');
  assert.ok(content.files.some(file => file.path === 'LICENSES.txt'));
  assert.ok(content.files.some(file => file.path === 'audio/boss/CREDITS.md'));
  for (const family of ['rider-waite', 'parody']) assert.ok(content.files.some(file => file.path === `cards/${family}/sample.webp`));
  await mkdir(join(dist, 'cards-evil'));
  await assert.rejects(build({ branch: 'main', commit: 'a'.repeat(40), dist, out }), /Unexpected output directory/);
  await rm(join(dist, 'cards-evil'), { recursive: true });
  await writeFile(join(dist, 'run.exe'), 'not allowed');
  await assert.rejects(build({ branch: 'main', commit: 'a'.repeat(40), dist, out }), /Unexpected output/);
});

test('manual legacy bundle publication requires opt-in, checks tip, and publishes payload before manifest', async () => {
  const workflow = yaml.load(await readFile(join(__dirname, '../../.github/workflows/game-bundles.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'], 'Legacy solo feeds must not publish automatically on pushes or schedules');
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.branch.options, ['main', 'iteration']);
  assert.equal(inputs.publish_legacy_bundle.type, 'boolean');
  assert.equal(inputs.publish_legacy_bundle.required, true);
  assert.equal(inputs.publish_legacy_bundle.default, false);
  assert.match(inputs.publish_legacy_bundle.description, /compatibility is not maintained/);
  for (const job of [workflow.jobs.build, workflow.jobs.publish]) {
    assert.match(job.if, /github\.event_name == 'workflow_dispatch'/);
    assert.match(job.if, /inputs\.publish_legacy_bundle == true/);
  }
  assert.equal(workflow.jobs.build.env.GAME_BRANCH, '${{ inputs.branch }}');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.jobs.build.steps.some(step => step.run === 'npm test -- --maxWorkers=2'));
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'write' });
  const checkout = workflow.jobs.build.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with.ref, '${{ inputs.branch }}');
  const publish = workflow.jobs.publish.steps.find(step => step.run)?.run;
  assert.match(publish, /m\.sha256 !== crypto\.createHash\('sha256'\)/);
  assert.match(publish, /if \[\[ "\$TIP" != "\$GAME_COMMIT" \]\]/);
  assert.ok(publish.indexOf('gh release upload "$TAG" "bundle/$BUNDLE"') < publish.indexOf('gh release upload "$TAG" bundle/latest.json --clobber'));
  assert.ok(!publish.includes('npm '));
  assert.ok(!publish.includes('git push'));
});


test('native bundle gate tests the exact selected-branch payload before publication', () => {
  const jobs = workflow().jobs, native = jobs['native-browser'];
  assert.deepEqual(jobs.publish.needs, ['build', 'native-browser']);
  assert.deepEqual(native.needs, ['build']);
  assert.equal(native['runs-on'], 'macos-15');
  assert.ok(native['timeout-minutes'] >= 60);
  assert.equal(native.env.GAME_BRANCH, '${{ needs.build.outputs.branch }}');
  assert.equal(native.env.GAME_COMMIT, '${{ needs.build.outputs.commit }}');
  assert.equal(native.env.FLAGHACK_BUILD_ID, '${{ needs.build.outputs.commit }}');
  assert.equal(native.env.BROWSER_DIST, '${{ github.workspace }}/web/dist');
  assert.equal(native.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ needs.build.outputs.commit }}');
  assert.ok(jobs.build.steps.some(step => step.run === 'npm run desktop:test'), 'Bundle and workflow guards run before packaging');
  assert.equal(jobs.build.steps.find(step => step.run === 'npm run build').env.FLAGHACK_BUILD_ID, '${{ steps.identity.outputs.commit }}');
  const runs = native.steps.map(step => step.run || '').join('\n');
  assert.match(runs, /test "\$\(git rev-parse HEAD\)" = "\$GAME_COMMIT"/);
  assert.match(runs, /npm run build:server/);
  assert.doesNotMatch(runs, /npm run build(?:\s|:pages)/, 'Native QA must never rebuild the distributed browser');
  assert.match(runs, /export GITHUB_SHA="\$GAME_COMMIT"/);
  assert.match(runs, /playwright@1\.56\.1/);
  assert.doesNotMatch(runs, /--no-sandbox|--ignore-gpu-blocklist|--enable-unsafe/);
  for (const id of ['build', 'native-browser']) {
    assert.equal(jobs[id].permissions, undefined, 'Build and browser checks inherit only read access');
    assert.equal(jobs[id].steps.find(step => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
    assert.ok(!jobs[id].steps.some(step => /gh release|git push/.test(step.run || '')));
  }
  for (const job of Object.values(jobs)) for (const step of job.steps) if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
  for (const job of [native, jobs.publish]) assert.equal(job.steps.find(step => step.uses?.startsWith('actions/download-artifact@')).with.name, 'verified-game-build');
  const evidence = native.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(evidence.if, 'always()');
  assert.equal(evidence.with.name, 'game-bundle-native-smoke');
  for (const name of ['mobile-sprites', 'mobile-pixel', 'mobile-hud', 'mobile-command', 'auto-style', 'explosion', 'mobile-ley']) {
    assert.match(runs, new RegExp(`node scripts/verify-${name}-browser\\.(?:mjs|cjs)`));
    assert.ok(evidence.with.path.includes(`web/host-release/${name}-smoke/`));
  }
  assert.ok(!native.steps.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.with.name === 'verified-game-build'), 'QA never replaces the release payload');
  const verifier = require('node:fs').readFileSync(join(__dirname, '../scripts/verify-mobile-sprites-browser.mjs'), 'utf8');
  assert.match(verifier, /process\.env\.GITHUB_SHA/);
  assert.match(verifier, /sourceDirty/);
  assert.match(verifier, /CI must test the exact clean committed revision/);
  assert.match(verifier, /Built JavaScript must embed the expected commit/);
  assert.match(verifier, /chromiumSandbox:true/);
});

async function browserFixture(t, { embeddedCommit = COMMIT } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flaghack-native-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'build-web'), dist = join(web, 'dist'), out = join(root, 'game-bundle');
  const files = {
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="./assets/game.css"></head><body><script type="module" src="./assets/game.js"></script></body></html>',
    'assets/game.js': `window.flaghack = { build: "${embeddedCommit}" };`,
    'assets/game.css': '@font-face{font-family:pixel;src:url(./pixel.woff2)}',
    'assets/pixel.woff2': Buffer.from([0, 1, 2]),
    'assets/mobile-sprites/atlas.png': Buffer.from([3, 4, 5]),
    'assets/licenses/pixel-fonts/NOTICE.txt': 'Pixel font license fixture',
    'audio/boss/CREDITS.md': 'Audio fixture credits',
    'models/fixture.glb': Buffer.from([6, 7, 8]),
    'cards/parody/fixture.webp': Buffer.from([9, 10, 11]),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(dist, name, '..'), { recursive: true });
    await writeFile(join(dist, name), bytes);
  }
  for (const pkg of PACKAGES) {
    const dir = join(web, 'node_modules', pkg);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'LICENSE'), pkg + ' fixture license');
  }
  const manifest = await build({ branch: 'iteration', commit: COMMIT, dist, out });
  const bundlePath = join(out, manifest.bundle), browserDist = join(root, 'browser-dist');
  const env = { ...process.env, RUNNER_TEMP: root, GAME_BRANCH: 'iteration', GAME_COMMIT: COMMIT, BROWSER_DIST: browserDist, GITHUB_SHA: OTHER_COMMIT };
  const run = overrides => execFileSync(process.execPath, ['-e', prepareScript()], { cwd: resolve(__dirname, '../..'), env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { root, out, dist, files, manifest, bundlePath, browserDist, run };
}

test('workflow unpacker preserves actual packaged file list and bytes, adding metadata only to a disposable copy', async t => {
  const fixture = await browserFixture(t);
  const before = await readFile(fixture.bundlePath), manifestBefore = await readFile(join(fixture.out, 'latest.json'));
  const bundle = validateBundle(before, fixture.manifest);
  assert.deepEqual(bundle.files.map(file => file.path).sort(), [...Object.keys(fixture.files), 'LICENSES.txt'].sort());
  const result = JSON.parse(fixture.run());
  assert.equal(result.commit, COMMIT, 'Selected branch identity wins over workflow_dispatch github.sha');
  assert.equal(result.verifiedFileCount, bundle.files.length);
  assert.equal(result.bundleSha256, fixture.manifest.sha256);
  assert.deepEqual(await readFile(fixture.bundlePath), before, 'Distributed compressed payload is untouched');
  assert.deepEqual(await readFile(join(fixture.out, 'latest.json')), manifestBefore);
  const actual = (await require('node:fs/promises').readdir(fixture.browserDist, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => relative(fixture.browserDist, join(entry.parentPath, entry.name)).split(sep).join('/')).sort();
  assert.deepEqual(actual, [...bundle.files.map(file => file.path), 'build.json'].sort());
  for (const file of bundle.files) assert.deepEqual(await readFile(join(fixture.browserDist, file.path)), file.data, file.path);
  assert.deepEqual(JSON.parse(await readFile(join(fixture.browserDist, 'build.json'), 'utf8')), { build: COMMIT });
  assert.ok(!bundle.files.some(file => ['build.json', 'bundle.json'].includes(file.path)), 'Neither CI nor installer metadata is shipped');
  const cache = join(fixture.root, 'verified-game-cache', `iteration-${COMMIT}`);
  await inspectBundle(await require('node:fs/promises').realpath(cache), fixture.manifest);
  await assert.rejects(readFile(join(cache, 'build.json')), { code: 'ENOENT' }, 'Installed cache remains valid without test metadata');
});

test('workflow unpacker rejects wrong branch, source SHA, payload name, corrupt bytes and existing output', async t => {
  const fixture = await browserFixture(t);
  assert.throws(() => fixture.run({ GAME_COMMIT: OTHER_COMMIT }), /exact build commit/);
  assert.throws(() => fixture.run({ GAME_BRANCH: 'main' }), /selected branch/);
  const manifestPath = join(fixture.out, 'latest.json');
  await writeFile(manifestPath, JSON.stringify({ ...fixture.manifest, bundle: '../other.json.gz' }));
  assert.throws(() => fixture.run(), /AssertionError/);
  await writeFile(manifestPath, JSON.stringify(fixture.manifest));
  const original = await readFile(fixture.bundlePath), corrupted = Buffer.from(original);
  corrupted[corrupted.length - 1] ^= 1;
  await writeFile(fixture.bundlePath, corrupted);
  assert.throws(() => fixture.run(), /checksum/);
  await writeFile(fixture.bundlePath, original);
  await mkdir(fixture.browserDist);
  await writeFile(join(fixture.browserDist, 'stale.js'), 'must not be silently retained or replaced');
  assert.throws(() => fixture.run(), /must start empty/);
  assert.equal(await readFile(join(fixture.browserDist, 'stale.js'), 'utf8'), 'must not be silently retained or replaced');
});

test('valid hashes and synthetic metadata cannot hide a different embedded browser commit', async t => {
  const fixture = await browserFixture(t, { embeddedCommit: OTHER_COMMIT });
  assert.throws(() => fixture.run(), /JavaScript must embed the exact build commit/);
  await assert.rejects(readFile(join(fixture.browserDist, 'build.json')), { code: 'ENOENT' });
});

test('browser-test metadata remains forbidden in the distributed launcher payload', async t => {
  const fixture = await browserFixture(t);
  await writeFile(join(fixture.dist, 'build.json'), JSON.stringify({ build: COMMIT }));
  await assert.rejects(build({ branch: 'iteration', commit: COMMIT, dist: fixture.dist, out: fixture.out }), /Unexpected output file/);
});
