'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeArchivePaths } = require('./package-paths.cjs');
test('package verification accepts the actual ASAR list format on Windows and POSIX', () => {
  const expected = ['/dist-host/host-api.js', '/host-desktop/host-worker.cjs', '/node_modules/ws/index.js'];
  assert.deepEqual(normalizeArchivePaths(expected), expected);
  assert.deepEqual(normalizeArchivePaths(expected.map(path => path.replace(/\//g, '\\'))), expected);
  assert.ok(!normalizeArchivePaths(['/dist-host/not-host-api.js']).includes('/dist-host/host-api.js'));
});
