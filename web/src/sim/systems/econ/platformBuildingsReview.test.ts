import { expect, it } from 'vitest';
import { newMatch } from './testkit';
import { spawnBuilding, spawnHippie, spawnPiece } from '../../factory';
import { attachPiece, destroyPiece } from '../pieces';
import { registerBuildingShape } from '../buildings';
import { craftFlag } from '../flags';
import { buildingBaseHeight } from '../../buildingGeometry';
import { updateEconomy } from '../economy';
import { LEVEL_HEIGHT } from '../../constants';
import { act } from '../units/act';
import { brainOf } from '../units/brain';
import { unitsState } from '../units/state';
import { DRUMMERS_PER_CIRCLE } from '../../constants';
it.each([false, true])('cascades through stacked decks without refunds and handles flags for boss destruction=%s', bossDestroyed => {
  const { world } = newMatch('platform-review');
  const facet = world.lattice.facets.find(f => f.thick && !f.boundary)!;
  const lower = spawnPiece(world, 'floor', 0, -1, facet.id, 0, -1);
  const upper = spawnPiece(world, 'floor', 0, -1, facet.id, 1, -1);
  attachPiece(world, lower); attachPiece(world, upper);
  const b = spawnBuilding(world, 'workshop', 0, facet.id, 1, 2);
  registerBuildingShape(world, b);
  const flag = craftFlag(world, b.id)!;
  expect(flag).not.toBeNull();
  const base = buildingBaseHeight(world, b), lumber = world.factions[0].lumber;
  destroyPiece(world, lower, bossDestroyed);
  expect(world.pieces.has(upper.id)).toBe(false);
  expect(world.buildings.has(b.id)).toBe(false);
  expect(world.flags.has(flag.id)).toBe(!bossDestroyed);
  if (!bossDestroyed) {
    expect(world.flags.get(flag.id)?.state).toBe('loose');
    expect(world.flags.get(flag.id)?.pos.y).toBeCloseTo(world.collision.groundHeight(b.pos.x, b.pos.z));
  }
  expect(world.collision.blockedCircle(b.pos.x, b.pos.z, .1, base+.1, base+.5)).toBe(false);
  expect(world.factions[0].lumber).toBe(lumber);
});

it('does not earn ritual by drumming beneath an elevated circle, but permits same-level drumming', () => {
  const { world } = newMatch('platform-review');
  world.hippies.clear();
  for (const [id, b] of world.buildings) if (b.kind === 'drumcircle') world.buildings.delete(id);
  const circle = spawnBuilding(world, 'drumcircle', 0, 0, 1, 2);
  const h = spawnHippie(world, 0, {x:circle.pos.x,z:circle.pos.z});
  h.status = 'drumming';
  const before = world.factions[0].ritual;
  updateEconomy(world, .1);
  expect(world.factions[0].ritual).toBe(before);
  h.airborne = { y: 2 * LEVEL_HEIGHT, vy: 0 };
  updateEconomy(world, .1);
  expect(world.factions[0].ritual).toBeGreaterThan(before);
});


it.each(['build', 'repair', 'drum'] as const)('releases inaccessible elevated %s work rather than stranding ground workers', task => {
  const { world } = newMatch('platform-review');
  const building = spawnBuilding(world, task === 'drum' ? 'drumcircle' : 'workshop', 0, 0, task === 'build' ? .5 : 1, 2);
  if (task === 'repair') building.hp = building.maxHp / 2;
  const h = spawnHippie(world, 0, { ...building.pos });
  const brain = brainOf(h), sys = unitsState(world);
  brain.task = task; brain.target = building.id;
  h.status = task === 'drum' ? 'drumming' : task === 'build' ? 'building' : 'repairing';
  if (task === 'drum') {
    brain.slot = 0;
    const slots = new Int32Array(DRUMMERS_PER_CIRCLE).fill(-1); slots[0] = h.id;
    sys.drumSlots.set(building.id, slots);
  }
  act(world, sys, h, brain, 0, .1);
  expect(brain.task).toBe('none');
  expect(h.status).toBe('idle');
  expect(brain.avoidBuildings.get(building.id)).toBeGreaterThan(world.time);
  if (task === 'drum') expect(sys.drumSlots.get(building.id)![0]).toBe(-1);
});

it('abandons a horizontally reached but vertically inaccessible workshop delivery without losing cargo', () => {
  const { world } = newMatch('platform-review');
  const workshop = spawnBuilding(world, 'workshop', 0, 0, 1, 2);
  const h = spawnHippie(world, 0, { ...workshop.pos });
  const brain = brainOf(h), sys = unitsState(world);
  h.carryingLumber = 10;
  brain.task = 'haul'; brain.target = workshop.id; brain.px = h.pos.x; brain.pz = h.pos.z;
  act(world, sys, h, brain, 0, .1);
  expect(brain.task).toBe('none');
  expect(brain.avoidBuildings.get(workshop.id)).toBeGreaterThan(world.time);
  expect(h.carryingLumber).toBe(10);
});

it('abandons stock fetching after arriving below an elevated workshop', () => {
  const { world } = newMatch('platform-review');
  const workshop = spawnBuilding(world, 'workshop', 0, 0, 1, 2);
  const h = spawnHippie(world, 0, { ...workshop.pos });
  const neutral = spawnHippie(world, -1, { ...workshop.pos });
  h.order = {kind:'recruit',target:neutral.id};
  const brain = brainOf(h), sys = unitsState(world);
  brain.task = 'fetchStock'; brain.target = workshop.id; brain.px = h.pos.x; brain.pz = h.pos.z;
  act(world, sys, h, brain, 0, .1);
  expect(brain.task).toBe('none');
  expect(h.status).toBe('idle');
  expect(brain.avoidBuildings.get(workshop.id)).toBeGreaterThan(world.time);
});
