'use strict';
const assert = require('node:assert/strict');
/** The mobile scene deliberately mixes volumetric scenery with sprite actors/buildings. */
function assertMobileScenery(models, counts) {
  assert.deepEqual([...models.visibleWorldModels].sort(), ['effigy', 'lumber-piles', 'props'],
    'Original 3D props, effigy and resource piles remain visible, without duplicate building models');
  if (counts) {
    for (const kind of ['scenery', 'effigy', 'pile']) assert.equal(counts[kind] ?? 0, 0, `${kind} must not also submit billboard substitutes`);
    assert.ok(counts.building > 0, 'Constructed buildings retain their sprite presentation');
  }
}
module.exports = {assertMobileScenery};
