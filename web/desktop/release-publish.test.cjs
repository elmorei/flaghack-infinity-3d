'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const yaml = require('js-yaml');

const root = join(__dirname, '../..');
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/desktop-publish.yml'), 'utf8'));
const marker = 'Publish verified iteration desktop 0.1.3-iteration.1 [release:20261102]';
const python = process.platform === 'win32' ? 'python' : 'python3';

test('publisher trigger allows only the exact approved iteration push', () => {
  assert.deepEqual(workflow.on.push.branches, ['iteration']);
  assert.deepEqual(Object.keys(workflow.on), ['push']);
  const enabled = (name, ref, message, repository = 'elmorei/flaghack-infinity-3d') =>
    runInNewContext(workflow.jobs.publish.if, { github: { repository, event_name: name, ref, event: { head_commit: { message } } } });
  assert.equal(enabled('push', 'refs/heads/iteration', marker), true);
  assert.equal(enabled('workflow_dispatch', 'refs/heads/iteration', marker), false);
  assert.equal(enabled('push', 'refs/heads/iteration', 'Ordinary later commit'), false);
  assert.equal(enabled('push', 'refs/heads/iteration', marker + '\n'), false);
  assert.equal(enabled('push', 'refs/heads/main', marker), false);
  assert.equal(enabled('pull_request', 'refs/heads/iteration', marker), false);
  assert.equal(enabled('push', 'refs/heads/iteration', marker, 'someone/fork'), false);
});

test('publisher uses ephemeral job permissions, pinned checkout, no saved credentials, and shared feed serialization', () => {
  const job = workflow.jobs.publish;
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(job.permissions, { actions: 'read', contents: 'write' });
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 20);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.match(checkout.uses, /@[0-9a-f]{40}$/);
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  const publish = job.steps.find(step => step.run?.includes('--publish'));
  assert.deepEqual(publish.env, { GH_TOKEN: '${{ github.token }}', GH_REPO: 'elmorei/flaghack-infinity-3d' });
  assert.equal(publish.run.trim(), 'python3 .github/scripts/publish-iteration-desktop.py --publish');
  const verify = job.steps.find(step => step.run === 'python3 .github/scripts/test-publish-iteration-desktop.py');
  assert.ok(verify && job.steps.indexOf(verify) < job.steps.indexOf(publish));
  const acceptance = job.steps.find(step => step.run === 'node .github/scripts/verify-live-game-updater.cjs');
  assert.ok(acceptance && job.steps.indexOf(acceptance) < job.steps.indexOf(publish));
  assert.equal(acceptance['timeout-minutes'], 11);
  assert.ok(!acceptance.env?.GH_TOKEN);
  const setupNode = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.match(setupNode.uses, /@[0-9a-f]{40}$/);
  assert.equal(setupNode.with['node-version'], '24');
  assert.ok(!verify.env?.GH_TOKEN && !job.env?.GH_TOKEN && !workflow.env?.GH_TOKEN);
  assert.equal(workflow.concurrency.group, 'publish-desktop-iteration');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('publisher offline fake-gh suite verifies checksums, feed-last ordering, races, and idempotency', () => {
  const result = spawnSync(python, [join(root, '.github/scripts/test-publish-iteration-desktop.py')], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran [0-9]+ tests/);
  assert.match(result.stderr, /\nOK\s*$/);
});

test('live game acceptance harness passes its offline production-updater scenarios', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', join(root, '.github/scripts/test-live-game-updater.cjs')], {
    encoding: 'utf8', timeout: 30000, windowsHide: true, env,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /tests 5/);
});
