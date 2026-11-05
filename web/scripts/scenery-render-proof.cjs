'use strict';
const assert = require('node:assert/strict');
/** The mobile scene deliberately mixes volumetric scenery with sprite actors/buildings. */
function assertMobileScenery(models, counts) {
  const names=models.visibleWorldModels;
  assert.equal(new Set(names).size,names.length,'Each 3D environment batch is reported once');
  assert.deepEqual(names.filter(name=>!/^wreckage-fragments-[012]$/.test(name)).sort(), ['effigy', 'lumber-piles', 'props'],
    'Original 3D props, effigy and resource piles remain visible; optional debris uses only real fragment batches');
  if (counts) {
    for (const kind of ['scenery', 'effigy', 'pile', 'wreckage']) assert.equal(counts[kind] ?? 0, 0, `${kind} must not also submit billboard substitutes`);
    assert.ok(counts.building > 0, 'Constructed buildings retain their sprite presentation');
  }
}
module.exports = {assertMobileScenery};
