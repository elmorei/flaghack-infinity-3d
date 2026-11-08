'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const source = name => readFileSync(join(__dirname, name), 'utf8');
function harness() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: '', classList: { toggle() {} }, addEventListener() {} });
    return elements.get(id);
  };
  const canvas = get('qr-canvas'), rects = [];
  const ctx = { fillStyle: '', fillRect(...args) { rects.push([this.fillStyle, ...args]); } };
  canvas.getContext = () => ctx;
  const context = vm.createContext({ document: { getElementById: get }, window: { matchHost: { onState() {}, get: () => new Promise(() => {}) } }, setTimeout, clearTimeout });
  vm.runInContext(source('qrcode.js'), context);
  vm.runInContext(source('host.js'), context);
  return { get, canvas, rects, show: state => context.displayQr(state) };
}
const invite = 'https://elmorei.github.io/flaghack-infinity-3d/#host=https%3A%2F%2Fexample.trycloudflare.com&pw=sample-password';
test('QR is generated locally for the exact invite, with quiet zone and integer pixels', () => {
  const h = harness();
  h.show({ status: 'running', invite });
  assert.equal(h.get('invite-qr').hidden, false);
  assert.equal(h.get('qr-error').hidden, true);
  assert.ok(h.canvas.width >= 280);
  assert.equal(h.canvas.width, h.canvas.height);
  assert.deepEqual(h.rects[0], ['#fff', 0, 0, h.canvas.width, h.canvas.height]);
  for (const [color, x, y, w, ht] of h.rects.slice(1)) {
    assert.equal(color, '#000'); assert.equal(w, ht);
    assert.ok(x >= 4*w && y >= 4*w);
    assert.ok(x+w <= h.canvas.width-4*w && y+ht <= h.canvas.height-4*w);
  }
  const n = h.rects.length;
  h.show({ status: 'running', invite });
  assert.equal(h.rects.length, n, 'polling does not redraw');
  h.show({ status: 'stopping', invite });
  assert.equal(h.get('invite-qr').hidden, true);
  assert.equal(h.canvas.width, 0);
  h.show({ status: 'running', invite: invite + '2' });
  assert.equal(h.get('invite-qr').hidden, false);
  assert.ok(h.rects.length > n);
});
test('encoding failure leaves copy-invite flow available and hides obsolete QR', () => {
  const h = harness();
  h.show({ status: 'running', invite: 'x'.repeat(10000) });
  assert.equal(h.get('invite-qr').hidden, true);
  assert.equal(h.get('qr-error').hidden, false);
  h.show({ status: 'idle' });
  assert.equal(h.get('qr-error').hidden, true);
});
test('QR library is packaged and allowlisted without enabling remote requests', () => {
  assert.ok(source('host.html').includes('src="qrcode.js" defer'));
  assert.ok(source('main.cjs').includes("'host.js', 'qrcode.js'"));
  assert.ok(source('host.html').includes("connect-src 'none'"));
});
module.exports = { harness, invite };
