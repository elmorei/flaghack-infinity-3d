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
  assert.deepEqual(workflow.jobs['publish-host'].needs, ['client', 'windows-host', 'startup-browser']);
  assert.deepEqual(workflow.jobs['deploy-pages'].needs, ['client', 'publish-host']);
  assert.deepEqual(workflow.jobs['publish-host'].permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs['deploy-pages'].permissions, { pages: 'write', 'id-token': 'write' });
});
test('all third-party actions are immutable and builds have no write token', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
  }
  for (const id of ['client', 'windows-host', 'startup-browser']) {
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
  assert.equal(browser['runs-on'], 'macos-15-intel');
  const artifact = browser.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(artifact.with.name, 'github-pages');
  const run = browser.steps.find(step => step.run)?.run;
  assert.match(run, /artifact\.tar/);
  assert.match(run, /playwright@1\.56\.1/);
  assert.match(run, /verify-startup-browser\.cjs/);
  assert.doesNotMatch(run, /--no-sandbox|--ignore-gpu-blocklist|--enable-unsafe/);
});
