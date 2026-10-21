'use strict';
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const dist = resolve(__dirname, '../dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const base = 'https://example.github.io/flaghack-infinity-3d/';
let assets = 0;
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  const value = match[1];
  if (value.startsWith('data:')) continue;
  const url = new URL(value, base);
  assert.equal(url.origin, new URL(base).origin, `Unexpected external build asset ${value}`);
  assert.ok(url.pathname.startsWith('/flaghack-infinity-3d/'), `Asset escapes project path: ${value}`);
  const relative = decodeURIComponent(url.pathname.slice('/flaghack-infinity-3d/'.length));
  assert.ok(existsSync(join(dist, relative)), `Missing built asset ${relative}`);
  assets++;
}
assert.ok(assets >= 2, 'Expected bundled script and stylesheet');
assert.ok(existsSync(join(dist, '.nojekyll')));
assert.ok(readFileSync(join(dist, 'LICENSES.txt'), 'utf8').includes('three'));
const metadata = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'));
assert.match(metadata.build, /^[a-f0-9]{40}$/);
assert.equal(metadata.hostDownload, `https://github.com/elmorei/flaghack-infinity-3d/releases/download/host-${metadata.build}/Flaghack-Host-Windows-x64.exe`);
console.log(`Pages assets resolve under project subpath; matching build ${metadata.build}`);
