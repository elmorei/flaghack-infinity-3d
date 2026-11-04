const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
function harness() {
  const callbacks = []; let timeout, emitted = 0, cleared = 0;
  const attr = { count: 2048, data: { array: { byteLength: 262144 } }, getX: () => 1, getY: () => 2, getZ: () => 3, getW: () => 4 };
  const mesh = { visible: false, geometry: { instanceCount: 0, uuid: 'geometry', getAttribute: () => attr }, material: { uuid: 'material', uniforms: { uTime: { value: 10 } } } };
  const renderer = { ctx: { time: 10, quality: 'high', scene: { getObjectByName: () => mesh } }, renderer: { info: { render: { calls: 1, triangles: 2 } } }, onEvents: () => emitted++ };
  const ctx = vm.createContext({ window: { flaghack: { renderer } }, requestAnimationFrame: cb => callbacks.push(cb), setTimeout: cb => { timeout = cb; return 1; }, clearTimeout: () => cleared++ });
  vm.runInContext(readFileSync(join(__dirname, 'explosion-frame-snapshot.mjs'), 'utf8').replace('export function', 'function'), ctx);
  return { capture: ctx.captureExplosionFrame, mesh, frame: () => callbacks.shift()(), expire: () => timeout(), get emitted() { return emitted; }, get cleared() { return cleared; } };
}
test('waits for real particle publication, emits once, and returns an atomic snapshot', async () => {
  const h = harness(), promise = h.capture([{ t: 'sceneryDestroyed' }]);
  h.frame(); h.frame(); // More than one delayed render, no arbitrary millisecond assumption.
  assert.equal(h.emitted, 1);
  h.mesh.visible = true; h.mesh.geometry.instanceCount = 2; h.frame();
  h.mesh.visible = false; h.mesh.geometry.instanceCount = 0; // Later expiration cannot race the returned sample.
  const result = await promise;
  assert.equal(result.count, 2); assert.equal(result.visible, true); assert.equal(result.rows.length, 2);
  assert.equal(result.capacity, 2048); assert.equal(h.cleared, 1); assert.equal(h.emitted, 1);
});
test('missing rendered particles fail with diagnostics and no repeated emission', async () => {
  const h = harness(), promise = h.capture([{}]); h.frame(); h.expire();
  await assert.rejects(promise, /never reached a visible rendered frame.*"frames":1.*"count":0/);
  h.frame(); assert.equal(h.emitted, 1);
});
test('plain snapshots retain the real expired state without emitting', () => {
  const h = harness(), result = h.capture();
  assert.equal(result.count, 0); assert.equal(result.visible, false); assert.equal(h.emitted, 0);
});
