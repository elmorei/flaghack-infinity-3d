'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ready = import('./verify-mobile-wizard.mjs').then(module => module.mobileWizardReadyAction);

async function probe({ phase = 'dialogue', index = 0, revision = 2, time = 10, readyAt = 5,
  page = index + 1, total = 3, action = page === total ? 'play' : 'next', disabled = false,
  visible = true, overlay = true, session = true, label = `A brief word · ${page} / ${total}` } = {}) {
  const control = { disabled, getClientRects: () => visible ? [{}] : [] };
  const world = { time, frickFrack: { sessions: { 0: session ? { phase, dialogueIndex: index, revision, readyAt } : undefined } } };
  const dom = { querySelector: selector => selector === '.ff-page-number' ? { textContent: label }
    : selector === `button[data-action="${action}"]` ? control : null };
  // Playwright serializes this callback, so verify it needs no module closure.
  const result = vm.runInNewContext(`(${(await ready).toString()})()`, {
    window: { flaghack: { world } }, document: { querySelector: () => overlay ? dom : null },
  });
  return result && JSON.parse(JSON.stringify(result));
}

test('wizard probe selects Continue only for the matching rendered nonfinal page', async () => {
  assert.deepEqual(await probe(), { phase: 'dialogue', revision: 2, dialogueIndex: 0, action: 'next' });
});
test('wizard probe waits through stale Continue DOM after final dialogue acknowledgement', async () => {
  assert.equal(await probe({ index: 2, page: 2, action: 'next' }), false);
  assert.deepEqual(await probe({ index: 2 }), { phase: 'dialogue', revision: 2, dialogueIndex: 2, action: 'play' });
});
test('wizard probe waits for timing gate, enabled visible action and matching DOM', async () => {
  for (const state of [{ time: 4 }, { disabled: true }, { visible: false }, { overlay: false },
    { action: 'play' }, { label: '' }, { session: false }, { phase: 'empty' }]) {
    assert.equal(await probe(state), false, JSON.stringify(state));
  }
});
test('wizard probe accepts betting acknowledgement without another dialogue tap', async () => {
  assert.deepEqual(await probe({ phase: 'betting', overlay: false }), { phase: 'betting', revision: 2 });
});
