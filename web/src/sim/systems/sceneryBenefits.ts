/** Shared, read-only rules for the benefits of captured scenery. */
import { HIPPIE } from '../constants';
import type { Obstacle, ObstacleKind } from '../map/mapgen';
import type { V2 } from '../math';
import type { FactionId } from '../types';
import type { World } from '../world';

export const SCENERY_BENEFITS = Object.freeze({ tentSmall: 2, tentLarge: 3, lodgingMax: 12,
  artRange: 25, artRitualMultiplier: 1.25 });
const lookup = new WeakMap<World, { obstacles: Obstacle[]; count: number; byId: Map<number, Obstacle> }>();
const servicePoints = new WeakMap<World, Map<number, { signature: string; points: V2[] }>>();
export function sceneryById(world: World, id: number): Obstacle | undefined {
  let cache = lookup.get(world);
  if (!cache || cache.obstacles !== world.map.obstacles || cache.count !== world.map.obstacles.length) {
    cache = { obstacles: world.map.obstacles, count: world.map.obstacles.length,
      byId: new Map(world.map.obstacles.map(o => [o.id, o])) }; lookup.set(world, cache);
  }
  return cache.byId.get(id);
}
export function sceneryBenefitActive(world: World, id: number, faction?: FactionId): boolean {
  const state = world.sceneryCapture.get(id);
  return !!state && state.faction !== -1 && world.factions[state.faction].alive &&
    (faction === undefined || state.faction === faction) && !world.destroyedScenery.has(id) &&
    state.stage !== 'contained' && state.stage !== 'contested' && state.stage !== 'overwritten';
}
export function activeScenery(world: World, kind?: ObstacleKind, faction?: FactionId): Obstacle[] {
  const result: Obstacle[] = [];
  for (const [id] of world.sceneryCapture) {
    if (!sceneryBenefitActive(world, id, faction)) continue;
    const o = sceneryById(world, id);
    if (o && (kind === undefined || o.kind === kind)) result.push(o);
  }
  return result;
}
export function tentPlaces(o: Obstacle): number { return o.variant === 0 ? SCENERY_BENEFITS.tentSmall : SCENERY_BENEFITS.tentLarge; }
export function sceneryLodging(world: World, faction: FactionId): number {
  let count = 0;
  for (const o of activeScenery(world, 'tent', faction)) count += tentPlaces(o);
  return Math.min(SCENERY_BENEFITS.lodgingMax, count);
}
export function sceneryRitualMultiplier(world: World, faction: FactionId, at: V2): number {
  const range2 = SCENERY_BENEFITS.artRange ** 2;
  return activeScenery(world, 'art', faction).some(o => (o.x-at.x)**2 + (o.z-at.z)**2 <= range2)
    ? SCENERY_BENEFITS.artRitualMultiplier : 1;
}

/** Deterministic exterior service slots, never a solid prop's centre or interior.
 * Sampling only nearby walkable cells avoids snapping services across walls/ponds.
 * Callers still route through the normal navigation system to the chosen point. */
export function sceneryServicePoint(world: World, o: Obstacle, at?: V2, slot = 0): V2 | null {
  let cache = servicePoints.get(world);
  if (!cache) { cache = new Map(); servicePoints.set(world, cache); }
  const signature = `${world.nav.version}:${o.shape}:${o.x}:${o.z}:${o.radius}:${o.hx}:${o.hz}:${o.yaw}`;
  let record = cache.get(o.id);
  if (!record || record.signature !== signature) {
    record = { signature, points: exteriorPoints(world,o) }; cache.set(o.id,record);
  }
  const candidates = record.points;
  if (!candidates.length) return null;
  if (at) {
    // Keep canonical FIFO slots stable; nearest-side users get a sorted copy.
    const sorted = [...candidates].sort((a,b) => ((a.x-at.x)**2+(a.z-at.z)**2)-((b.x-at.x)**2+(b.z-at.z)**2));
    return sorted[Math.abs(slot) % sorted.length];
  }
  return candidates[Math.abs(slot) % candidates.length];
}
function exteriorPoints(world: World, o: Obstacle): V2[] {
  const candidates: V2[] = [];
  const pad = HIPPIE.radius + world.nav.cell * 1.5 + .5;
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    const dx = Math.cos(a), dz = Math.sin(a);
    const radius = o.shape === 'circle' ? o.radius + pad :
      Math.min((o.hx+pad)/Math.max(1e-6,Math.abs(dx)), (o.hz+pad)/Math.max(1e-6,Math.abs(dz)));
    const x = o.x + (c*dx+s*dz)*radius, z = o.z + (-s*dx+c*dz)*radius;
    const p = world.nav.nearestWalkable(x,z);
    if (!world.nav.isWalkable(p.x,p.z) || Math.hypot(p.x-x,p.z-z) > world.nav.cell*2) continue;
    const lx = c*(p.x-o.x)-s*(p.z-o.z), lz = s*(p.x-o.x)+c*(p.z-o.z);
    if (o.shape === 'circle' ? Math.hypot(lx,lz) < o.radius+HIPPIE.radius :
      Math.abs(lx) < o.hx+HIPPIE.radius && Math.abs(lz) < o.hz+HIPPIE.radius) continue;
    if (!candidates.some(q => Math.hypot(q.x-p.x,q.z-p.z)<.5)) candidates.push(p);
  }
  return candidates;
}

export function sceneryBenefitDescription(o: Obstacle): string {
  switch(o.kind) {
    case 'tent': return `Lodging: +${tentPlaces(o)} sustainable Signifiers (maximum +12 from tents).`;
    case 'dome': return 'Recovery: 3 health/sec for up to 4 idle Signifiers after 5 seconds out of combat.';
    case 'shade': return 'Rest: stationary Signifiers recover 4 attention/sec. Excess population still loses attention.';
    case 'porta': return 'Relief: +20 attention after a 3-second visit; one user, 45-second personal cooldown.';
    case 'art': return 'Inspiration: +25% ritual from staffed drum circles within 25m; does not stack.';
    case 'car': return `Supply depot: ${[3,6,10][Math.max(0,Math.min(2,o.variant))]} real flag slots and lumber deliveries. No free production.`;
    default: return '';
  }
}
