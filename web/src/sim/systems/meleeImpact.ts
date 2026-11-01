import { buildingBaseHeight } from '../buildingGeometry';
/** Contact-only presentation facts. Never changes targeting or damage/protection rules. */
import { AVATAR, BUILDING_HEIGHT, HIPPIE } from '../constants';
import { BOSS_RADIUS } from '../boss';
import type { V3 } from '../math';
import type { World } from '../world';
import { pieceGroundHeight } from './econ/pieceGeometry';
import { damageEntity } from './combat';
import { buildingClosest, pieceClosest, pieceSpan } from './units/reach';

const sequences = new WeakMap<World, number>();

/** Closest point on the existing melee target's footprint at the attacker's hand height. */
export function meleeContact(world: World, target: number, by: number): V3 | null {
  const source = world.avatars.get(by) ?? world.hippies.get(by);
  if (!source) return null;
  const y = (source.type === 'avatar' ? source.pos.y : world.collision.groundHeight(source.pos.x, source.pos.z) + (source.airborne?.y ?? 0)) + 1.1;
  const piece = world.pieces.get(target), building = world.buildings.get(target);
  const out = { x: 0, z: 0, dist: 0 };
  if (piece) {
    pieceClosest(world, piece, source.pos.x, source.pos.z, out);
    const span = { y0: 0, y1: 0 }; pieceSpan(piece, span);
    const base = pieceGroundHeight(world, piece);
    return { x: out.x, y: Math.max(base + span.y0, Math.min(base + span.y1, y)), z: out.z };
  }
  if (building) {
    buildingClosest(building, source.pos.x, source.pos.z, out);
    const base = buildingBaseHeight(world, building);
    return { x: out.x, y: Math.max(base, Math.min(base + BUILDING_HEIGHT[building.kind], y)), z: out.z };
  }
  const boss = world.boss?.id === target ? world.boss : null;
  const avatar = world.avatars.get(target), hippie = world.hippies.get(target), pile = world.piles.get(target);
  const entity = boss ?? avatar ?? hippie ?? pile;
  if (!entity) return null;
  const radius = boss ? BOSS_RADIUS : avatar ? AVATAR.radius : hippie ? HIPPIE.radius : 1.2;
  const dx = source.pos.x - entity.pos.x, dz = source.pos.z - entity.pos.z, d = Math.hypot(dx, dz);
  const r = Math.min(d, radius);
  return { x: entity.pos.x + (d > 0 ? dx / d * r : 0), y: pile ? world.collision.groundHeight(pile.pos.x, pile.pos.z) + .6 : y,
    z: entity.pos.z + (d > 0 ? dz / d * r : 0) };
}

export function emitMeleeImpact(world: World, target: number, by: number, pos = meleeContact(world, target, by)): void {
  const source = world.avatars.get(by) ?? world.hippies.get(by);
  if (!source || !pos) return;
  const impactId = (sequences.get(world) ?? 0) + 1; sequences.set(world, impactId);
  world.emit({ t: 'meleeImpact', impactId, target, by, faction: source.faction, pos });
}

/** Snapshot contact before a lethal hit removes its structure, then emit only on success. */
export function damageMelee(world: World, target: number, amount: number, by: number): boolean {
  const pos = meleeContact(world, target, by);
  if (!damageEntity(world, target, amount, by)) return false;
  emitMeleeImpact(world, target, by, pos);
  return true;
}
