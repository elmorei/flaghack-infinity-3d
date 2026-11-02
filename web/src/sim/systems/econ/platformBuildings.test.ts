import { describe, expect, it } from 'vitest';
import { buildingBaseHeight } from '../../buildingGeometry';
import { BUILDINGS, BUILDING_HEIGHT, LEVEL_HEIGHT, MAX_BUILD_LEVEL } from '../../constants';
import { spawnBuilding, spawnPiece } from '../../factory';
import { canPlaceBuilding, cmdPlaceBuilding, registerBuildingShape, updateBuildings } from '../buildings';
import { attachPiece, destroyPiece } from '../pieces';
import { facetInradius } from './pieceGeometry';
import { newMatch } from './testkit';
import { SnapshotEncoder } from '../../../net/codec';
import { NetMirror } from '../../../net/mirror';

function fixture() {
  const { world } = newMatch('platform-buildings');
  world.factions[0].lumber = 1000;
  const facet = world.lattice.facets.find(fc => facetInradius(world.lattice, fc.id) >= 3 && canPlaceBuilding(world, 0, 'workshop', fc.id).ok)!;
  expect(facet).toBeDefined();
  const deck = spawnPiece(world, 'floor', 0, -1, facet.id, 0, -1);
  attachPiece(world, deck);
  return { world, facet, deck };
}

describe('buildings on elevated platforms', () => {
  it('places all hand-built building types on a flat deck with normal cost and elevated collision', () => {
    for (const kind of ['workshop', 'ward', 'drumcircle', 'druglab'] as const) {
      const { world, facet } = fixture();
      expect(canPlaceBuilding(world, 0, kind, facet.id, 1)).toEqual({ ok: true, reason: '' });
      const before = world.factions[0].lumber;
      cmdPlaceBuilding(world, { t: 'placeBuilding', faction: 0, kind, facet: facet.id, level: 1 });
      const building = [...world.buildings.values()].find(b => b.facet === facet.id)!;
      expect(building.level).toBe(1);
      expect(world.factions[0].lumber).toBe(before - BUILDINGS[kind].cost);
      const base = buildingBaseHeight(world, building);
      expect(base).toBeCloseTo(world.collision.groundHeight(facet.cx, facet.cz) + LEVEL_HEIGHT);
      expect(world.collision.blockedCircle(facet.cx, facet.cz, .2, base + .1, base + .5)).toBe(true);
      expect(canPlaceBuilding(world, 0, kind, facet.id, 1).ok).toBe(false);
    }
  });
  it('requires flat, footprint-sized support and a valid integer level, without charging failures', () => {
    const { world, facet, deck } = fixture();
    const before = world.factions[0].lumber;
    for (const level of [-1, .5, NaN, Infinity, MAX_BUILD_LEVEL + 2, 2]) {
      expect(canPlaceBuilding(world, 0, 'workshop', facet.id, level).ok).toBe(false);
      cmdPlaceBuilding(world, { t: 'placeBuilding', faction: 0, kind: 'workshop', facet: facet.id, level });
    }
    destroyPiece(world, deck);
    const ramp = spawnPiece(world, 'ramp', 0, -1, facet.id, 0, 0); attachPiece(world, ramp);
    expect(canPlaceBuilding(world, 0, 'workshop', facet.id, 1).ok).toBe(false);
    expect(world.factions[0].lumber).toBe(before);
  });
  it('keeps survey, vertical clearance, ground construction and separate vertical occupancy', () => {
    const { world, facet, deck } = fixture();
    expect(canPlaceBuilding(world, 1, 'workshop', facet.id, 1).ok).toBe(false);
    // The taller platform now has enough headroom for the tallest camp building.
    expect(canPlaceBuilding(world, 0, 'ward', facet.id, 0).ok).toBe(true);
    const ceiling = spawnPiece(world, 'floor', 0, -1, facet.id, 1, -1); attachPiece(world, ceiling);
    expect(canPlaceBuilding(world, 0, 'ward', facet.id, 1).ok).toBe(true);
    const base = world.collision.groundHeight(facet.cx, facet.cz) + LEVEL_HEIGHT;
    const lowCeiling = world.collision.addBox(facet.cx, facet.cz, 4, 4, 0, base + BUILDING_HEIGHT.ward - .1, base + BUILDING_HEIGHT.ward + .1, -999);
    expect(canPlaceBuilding(world, 0, 'ward', facet.id, 1).ok).toBe(false);
    world.collision.remove(lowCeiling);
    destroyPiece(world, ceiling);
    const ground = spawnBuilding(world, 'drumcircle', 0, facet.id, 1); registerBuildingShape(world, ground);
    expect(canPlaceBuilding(world, 0, 'workshop', facet.id, 1).ok).toBe(true);
    world.buildings.delete(ground.id); registerBuildingShape(world, ground);
    destroyPiece(world, deck);
    expect(canPlaceBuilding(world, 0, 'workshop', facet.id).ok).toBe(true);
  });
  it('does not accelerate construction or repair through the platform floor', () => {
    const { world, facet } = fixture();
    cmdPlaceBuilding(world, { t: 'placeBuilding', faction: 0, kind: 'workshop', facet: facet.id, level: 1 });
    const b = [...world.buildings.values()].find(b => b.facet === facet.id)!;
    const av = world.avatarOf(0);
    av.pos = { x: facet.cx, y: world.collision.groundHeight(facet.cx, facet.cz), z: facet.cz };
    updateBuildings(world, 1); const unhelped = b.built;
    b.built = 0; av.pos.y += LEVEL_HEIGHT;
    updateBuildings(world, 1); expect(b.built).toBeGreaterThan(unhelped);
  });
  it('replicates elevated geometry to live clients and late joins, then removes it with its deck', () => {
    const { world, facet, deck } = fixture();
    const encoder = new SnapshotEncoder(world);
    const mirror = NetMirror.create(world.options, JSON.parse(JSON.stringify(encoder.full())));
    cmdPlaceBuilding(world, { t: 'placeBuilding', faction: 0, kind: 'workshop', facet: facet.id, level: 1 });
    const building = [...world.buildings.values()].find(b => b.facet === facet.id)!;
    const sync = () => { world.tick++; world.time++; mirror.push(JSON.parse(JSON.stringify({ tick: world.tick, time: world.time, acks: {}, delta: encoder.delta([]), events: [] }))); mirror.catchUp(); };
    sync();
    const late = NetMirror.create(world.options, JSON.parse(JSON.stringify(encoder.full())));
    for (const w of [world, mirror.world, late.world]) {
      const b = w.buildings.get(building.id)!;
      expect(b.level).toBe(1);
      expect(w.collision.blockedCircle(b.pos.x, b.pos.z, .1, buildingBaseHeight(w, b) + .1, buildingBaseHeight(w, b) + BUILDING_HEIGHT[b.kind])).toBe(true);
    }
    destroyPiece(world, deck); sync();
    expect(world.buildings.has(building.id)).toBe(false);
    expect(mirror.world.buildings.has(building.id)).toBe(false);
    expect(world.wreckage.some(w => w.id === `building:${building.id}`)).toBe(true);
  });
});
