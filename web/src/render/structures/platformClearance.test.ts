import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BUILDING_HEIGHT, LEVEL_HEIGHT, TALLEST_BUILDABLE_STRUCTURE_HEIGHT, PLATFORM_CLEARANCE_EPSILON } from '../../sim/constants';
import { DECK_THICKNESS } from '../../sim/systems/econ/pieceGeometry';
import { StructureKit, type ModelRecipe } from './kit';
import { WORKSHOP_MODEL } from './workshopView';
import { DRUMCIRCLE_MODEL } from './drumCircleView';
import { DRUGLAB_MODEL } from './drugLabView';
import { HEARTH_MODEL } from './hearthView';
import { WARD_MODEL, WARD_EYE_MODEL, WARD_EYE_Y } from './wardView';
import { easeOutBack } from './util';
import { buildScaffold } from './buildingView';

function top(recipe: ModelRecipe) {
  const kit = new StructureKit({ capabilities: { getMaxAnisotropy: () => 1 } } as unknown as THREE.WebGLRenderer, 'low');
  const model = kit.model(recipe.name, recipe.build);
  let y = 0;
  for (const geo of model.values()) {
    geo.computeBoundingBox();
    y = Math.max(y, geo.boundingBox!.max.y);
  }
  kit.dispose();
  return y;
}

describe('platform clearance includes visible structure geometry', () => {
  it('measures the Ward eye rather than its shorter collision proxy', () => {
    const wardTop = Math.max(top(WARD_MODEL), WARD_EYE_Y + top(WARD_EYE_MODEL));
    expect(wardTop).toBeCloseTo(5.405, 5);
    expect(wardTop).toBeGreaterThan(BUILDING_HEIGHT.ward);
    const buildables = [top(WORKSHOP_MODEL), top(DRUMCIRCLE_MODEL), top(DRUGLAB_MODEL), wardTop];
    expect(Math.max(...buildables)).toBe(wardTop);
    // Completion bounce is presentation-only but must still fit below a deck.
    // easeOutBack derivative vanishes at t = 1 - 2*c1/(3*(c1+1)).
    const c1 = 1.70158, peakT = 1 - 2 * c1 / (3 * (c1 + 1));
    const maxPop = .82 + .18 * easeOutBack(peakT);
    expect(maxPop).toBeCloseTo(1.01800073275, 8);
    expect(wardTop * maxPop).toBeCloseTo(TALLEST_BUILDABLE_STRUCTURE_HEIGHT, 6);
    for (const height of buildables) expect(height * maxPop).toBeLessThan(LEVEL_HEIGHT - DECK_THICKNESS);
    for (const height of Object.values(BUILDING_HEIGHT)) expect(height).toBeLessThan(LEVEL_HEIGHT - DECK_THICKNESS);
  });
  it('uses the smallest whole-centimeter clearance with a numerical separation', () => {
    const needed = TALLEST_BUILDABLE_STRUCTURE_HEIGHT + DECK_THICKNESS + PLATFORM_CLEARANCE_EPSILON;
    expect(LEVEL_HEIGHT).toBe(5.77);
    expect(LEVEL_HEIGHT).toBeGreaterThanOrEqual(needed);
    expect(LEVEL_HEIGHT - .01).toBeLessThan(needed);
  });
  it('records temporary scaffolds without requiring them to fit the finished-building clearance', () => {
    for (const [name, radius, height] of [['workshop', 2.8, 3], ['drumcircle', 3, 2.4], ['ward', 2.2, WARD_EYE_Y + .5], ['druglab', 2.8, 3.2]] as const) {
      const scaffold = top({ name: 'test-scaffold-' + name, build: mb => buildScaffold(mb, radius, height) });
      expect(scaffold).toBeCloseTo(height + .5, 5);
      if (name === 'ward') expect(scaffold).toBeGreaterThan(LEVEL_HEIGHT - DECK_THICKNESS);
    }
  });
  it('records the unique Hearth flagpole exception explicitly', () => {
    expect(top(HEARTH_MODEL)).toBeCloseTo(8.41, 5);
  });
});
