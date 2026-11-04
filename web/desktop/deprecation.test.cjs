'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const text = path => readFileSync(join(__dirname, '..', '..', path), 'utf8');

test('legacy launcher carries a browser migration notice without blocked external links', () => {
  const html = text('web/desktop/launcher.html');
  assert.match(html, /aria-labelledby="deprecation-title"/);
  assert.match(html, /Solo launcher deprecated/);
  assert.match(html, /https:\/\/elmorei\.github\.io\/flaghack-infinity-3d\//);
  assert.match(html, /Existing offline play and saved preferences remain available/);
  assert.match(html, /Browser progress is separate/);
  assert.match(html, /multiplayer match host is not deprecated/);
  assert.doesNotMatch(html, /<a\b|window\.open|shell\.openExternal/);
  for (const id of ['play', 'channel', 'game-check', 'game-download', 'game-rollback']) {
    assert.ok(html.includes(`id="${id}"`), `existing ${id} control must remain available`);
  }
});

test('documentation distinguishes deprecated solo launcher from current browser and match host', () => {
  assert.match(text('README.md'), /solo launcher is deprecated/);
  assert.doesNotMatch(text('README.md'), /offline launcher remains a separate option/);
  const guide = text('docs/desktop-launcher.md');
  assert.match(guide, /not automatically\s+transferred/);
  assert.match(guide, /does not freeze or redirect the update feeds/);
  assert.match(guide, /last working assets and existing local data/);
  assert.match(text('docs/pages-and-host.md'), /Windows match host described here is not deprecated/);
  assert.doesNotMatch(text('web/host-desktop/host.html'), /deprecated/i);
});
