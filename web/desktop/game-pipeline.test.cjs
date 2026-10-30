'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const yaml = require('js-yaml');
const { build } = require('../../.github/scripts/build-game-bundle.cjs');
const { validateBundle } = require('./game-bundle.cjs');

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

test('branch bundle CI builds immutable source, checks tip, and publishes browser payload before manifest', async () => {
  const workflow = yaml.load(await readFile(join(__dirname, '../../.github/workflows/game-bundles.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main', 'iteration']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.jobs.build.steps.some(step => step.run === 'npm test -- --maxWorkers=2'));
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'write' });
  const checkout = workflow.jobs.build.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  assert.match(checkout.with.ref, /github.sha/);
  const publish = workflow.jobs.publish.steps.find(step => step.run)?.run;
  assert.match(publish, /m\.sha256 !== crypto\.createHash\('sha256'\)/);
  assert.match(publish, /if \[\[ "\$TIP" != "\$GAME_COMMIT" \]\]/);
  assert.ok(publish.indexOf('gh release upload "$TAG" "bundle/$BUNDLE"') < publish.indexOf('gh release upload "$TAG" bundle/latest.json --clobber'));
  assert.ok(!publish.includes('npm '));
  assert.ok(!publish.includes('git push'));
});
