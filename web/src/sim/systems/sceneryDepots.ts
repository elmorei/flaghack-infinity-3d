/** Real flag storage in captured vehicles; no generated inventory or virtual buildings. */
import type { Obstacle } from '../map/mapgen';
import type { V2 } from '../math';
import type { FactionId, Owner } from '../types';
import type { World } from '../world';
import { sceneryById, sceneryBenefitActive, sceneryServicePoint } from './sceneryBenefits';
import { dropLoose } from './flags';

export const VEHICLE_FLAG_CAPACITY = [3, 6, 10] as const;
/** -1 remains the ordinary unheld sentinel. Scenery IDs never alias entity IDs. */
export function depotHolder(id: number): number { return -2 - id; }
export function depotSceneryId(holder: number): number | null { return holder <= -2 ? -holder - 2 : null; }
export function vehicleCapacity(o: Obstacle): number { return VEHICLE_FLAG_CAPACITY[o.variant] ?? 3; }
export interface DepotTarget {
  kind: 'car'; id: number; faction: FactionId; built: 1; pos: V2;
  obstacle: Obstacle; servicePoint: V2;
}
export function getDepot(world: World, holder: number, at?: V2): DepotTarget | undefined {
  const id = depotSceneryId(holder);
  if (id === null) return;
  const o = sceneryById(world,id);
  if (!o || o.kind !== 'car' || !sceneryBenefitActive(world,id)) return;
  const f = world.sceneryCapture.get(id)?.faction;
  if (f === undefined || f === -1) return;
  const point = sceneryServicePoint(world, o, at);
  if (!point) return;
  return { kind: 'car', id: holder, faction: f, built: 1, pos: { x: o.x, z: o.z }, obstacle: o, servicePoint: point };
}
export function depotStock(world: World, holder: number): number {
  let n = 0;
  for (const fl of world.flags.values()) if (fl.state === 'stock' && fl.holder === holder) n++;
  return n;
}
/** Counts even temporarily paused stock, so contesting never hides hoarding. */
export function stockOwner(world: World, holder: number): Owner {
  const id = depotSceneryId(holder);
  if (id === null) return world.buildings.get(holder)?.faction ?? -1;
  return world.destroyedScenery.has(id) ? -1 : world.sceneryCapture.get(id)?.faction ?? -1;
}
/** Ownership changes transfer actual stock; destroyed/neutral depots release every flag once. */
export function updateSceneryDepots(world: World): void {
  for (const fl of world.flags.values()) {
    if (fl.state !== 'stock') continue;
    const id = depotSceneryId(fl.holder);
    if (id === null) continue;
    const candidate = sceneryById(world,id);
    const o = candidate?.kind === 'car' ? candidate : undefined;
    const owner = world.sceneryCapture.get(id)?.faction ?? -1;
    if (!o || world.destroyedScenery.has(id) || owner === -1 || !world.factions[owner].alive) {
      // Elimination skips stored flags: neutralize before releasing, but keep a
      // surviving owner when its vehicle is merely destroyed.
      fl.owner = owner === -1 || !world.factions[owner].alive ? -1 : owner;
      const at = o ? sceneryServicePoint(world, o, fl.pos) ?? world.nav.nearestWalkable(o.x, o.z) : null;
      const x = at?.x ?? fl.pos.x, z = at?.z ?? fl.pos.z;
      dropLoose(world, fl.id, { x, y: world.collision.groundHeight(x, z), z });
    } else fl.owner = owner;
  }
}
