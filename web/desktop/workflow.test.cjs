'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('js-yaml');
const workflow = yaml.load(readFileSync(join(__dirname, '../../.github/workflows/desktop-build.yml'), 'utf8'));
const job = workflow.jobs.windows;
const marker = 'Build canonical launcher [desktop-build:0.1.3-iteration.1:20261102]';
test('iteration push build is restricted to the exact authorized repository, branch and marker', () => {
  assert.deepEqual(workflow.on.push.branches, ['iteration']);
  assert.equal(job.if.replace(/\s+/g, ' ').trim(), `github.event_name == 'workflow_dispatch' || (github.repository == 'elmorei/flaghack-infinity-3d' && github.event_name == 'push' && github.ref == 'refs/heads/iteration' && github.event.head_commit.message == '${marker}')`);
  // Exercise the exact restricted expression, with GitHub context objects only.
  const enabled = github => runInNewContext(job.if, { github });
  const event = (name, ref, message, repository = 'elmorei/flaghack-infinity-3d') => ({ repository, event_name: name, ref, event: { head_commit: { message } } });
  assert.equal(enabled(event('push', 'refs/heads/iteration', marker)), true);
  assert.equal(enabled(event('push', 'refs/heads/iteration', 'Ordinary later commit')), false);
  assert.equal(enabled(event('push', 'refs/heads/main', marker)), false);
  assert.equal(enabled(event('push', 'refs/heads/qa/beacon-card-drops-20261101', marker)), false);
  assert.equal(enabled(event('push', 'refs/heads/iteration', marker, 'someone/fork')), false);
  assert.equal(enabled(event('push', 'refs/heads/iteration', marker + '\n')), false);
  assert.equal(enabled(event('pull_request', 'refs/heads/iteration', marker)), false);
  assert.equal(enabled(event('workflow_dispatch', 'refs/heads/iteration', '')), true);
});
test('push builds pin the event commit and fixed channel/version without credentials', () => {
  assert.equal(job.env.FLAGHACK_CHANNEL, "${{ github.event_name == 'push' && 'iteration' || inputs.channel }}");
  assert.equal(job.env.DESKTOP_VERSION, "${{ github.event_name == 'push' && '0.1.3-iteration.1' || inputs.version }}");
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, "${{ github.event_name == 'push' && github.sha || (inputs.channel == 'stable' && 'main' || 'iteration') }}");
  assert.equal(checkout.with['persist-credentials'], false);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job.steps.find(step => step.name === 'Test game').run, 'npm test -- --maxWorkers=2');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ['stable', 'iteration']);
  assert.ok(!job.steps.some(step => /gh release|git push|--publish always/.test(step.run || '')));
});
test('workflow executes the intended stable/prerelease version validation', () => {
  const source = job.steps.find(step => step.name === 'Validate channel and release version').run.match(/@'\r?\n([\s\S]+?)\r?\n\s*'@/)[1];
  const check = (channel, version) => runInNewContext(source, { process: { env: { FLAGHACK_CHANNEL: channel, DESKTOP_VERSION: version } }, console: { log() {} } });
  for (const [channel, version] of [['stable', '1.2.3'], ['stable', '0.0.0'], ['iteration', '0.1.1-iteration.1'], ['iteration', '1.2.3-iteration.0']]) assert.doesNotThrow(() => check(channel, version));
  for (const [channel, version] of [['stable', '01.2.3'], ['stable', '1x2x3'], ['stable', '1.2.3-iteration.1'], ['iteration', '1.2.3'], ['iteration', '1.2.3-iteration.01'], ['iteration', '1.2.3-iteration.1+extra'], ['other', '1.2.3'], ['stable', '1.2.3\nthrow Error()']]) assert.throws(() => check(channel, version));
});
