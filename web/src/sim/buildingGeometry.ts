/** Shared authoritative base for ground buildings and buildings resting on decks. */
import { LEVEL_HEIGHT } from './constants';
import type { Building } from './types';
import type { World } from './world';
export function buildingLevel(building: Building): number { return building.level ?? 0; }
export function buildingBaseHeight(world: World, building: Building): number {
  return world.collision.groundHeight(building.pos.x, building.pos.z) + buildingLevel(building) * LEVEL_HEIGHT;
}

/** Command Centers retain their body and HP under every destruction path. */
export function isIndestructibleBuilding(building: Pick<Building, 'kind'>): boolean { return building.kind === 'gcc'; }
