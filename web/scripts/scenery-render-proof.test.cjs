'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assertMobileScenery} = require('./scenery-render-proof.cjs');
const models = () => ({visibleWorldModels: ['props', 'effigy', 'lumber-piles']});
test('mobile 3D scenery is required while buildings remain sprites', () => {
  assertMobileScenery(models(), {building: 4, signifier: 20, flag: 5});
  assertMobileScenery(models());
});
test('missing scenery, duplicate building models and scenery billboards fail the native contract', () => {
  for (const name of ['props', 'effigy', 'lumber-piles']) {
    const value=models();value.visibleWorldModels=value.visibleWorldModels.filter(item=>item!==name);
    assert.throws(()=>assertMobileScenery(value));
  }
  const duplicate=models();duplicate.visibleWorldModels.push('building-models-gcc');assert.throws(()=>assertMobileScenery(duplicate));
  for (const kind of ['scenery', 'effigy', 'pile']) assert.throws(()=>assertMobileScenery(models(), {building:4, [kind]:1}));
  assert.throws(()=>assertMobileScenery(models(), {building:0}));
});
