/**
 * Thrown Flags: ballistic flight (gravity), collision via CollisionWorld.raycast against
 * walls/buildings/obstacles, recruitment on neutral hits, stun on rival hits, landing → plant on nearest plantable node
 * within AVATAR.throwSnapRadius (or loose). Emits flagLanded.
 * Owner: Units agent.
 */
import { AVATAR, MAP_HALF, PROJECTILE } from '../constants';
import { clamp } from '../math';
import type { FactionId, Hippie, Projectile } from '../types';
import type { World } from '../world';
import { damageEntity } from './combat';
import { recruitWithFlag } from './recruitment';
import { isDrugActive } from './drugs';
import { applyEffect } from './effects';
import { dropLoose, nearestPlantableNode, plantFlag } from './flags';

/** Surfaces at least this flat (normal y) catch a Flag; steeper ones knock it down. */
const WALKABLE_NY = 0.7;
/** A Flag that hits a wall falls this far out from the face, at its foot. */
const WALL_STANDOFF = 0.3;

/** Landing snap radius for a thrower's faction (Luminous Dust widens it). */
export function throwSnapRadius(world: World, faction: FactionId): number {
  return isDrugActive(world, faction, 'dust') ? AVATAR.throwSnapRadiusDust : AVATAR.throwSnapRadius;
}

export function updateProjectiles(world: World, dt: number): void {
  for (const p of world.projectiles.values()) stepProjectile(world, p, dt);
}

function stepProjectile(world: World, p: Projectile, dt: number): void {
  const flag = world.flags.get(p.flagId);
  if (!flag || flag.state !== 'flying' || flag.holder !== p.id) {
    world.projectiles.delete(p.id);
    return;
  }
  if (world.time - p.bornAt >= PROJECTILE.lifetime) {
    settle(world, p, p.pos.x, p.pos.y, p.pos.z);
    return;
  }
  // Semi-implicit Euler, then sweep the tick's segment (the aim preview mirrors this).
  p.vel.y -= AVATAR.gravity * dt;
  const ox = p.pos.x;
  const oy = p.pos.y;
  const oz = p.pos.z;
  const dx = p.vel.x * dt;
  const dy = p.vel.y * dt;
  const dz = p.vel.z * dt;
  const len = Math.hypot(dx, dy, dz);
  const hit = len > 1e-9 ? world.collision.raycast(ox, oy, oz, dx, dy, dz, len) : null;
  let t = 1;
  let ground = false;
  if (hit) t = hit.dist / len;
  else if (oy + dy <= 0) {
    // Numerical graze past the ground plane: land where the segment crosses y = 0.
    ground = true;
    t = dy < 0 ? clamp(oy / -dy, 0, 1) : 1;
  }
  const victim = hippieOnSegment(world, p, ox, oy, oz, dx, dy, dz, t);
  if (victim) {
    bonk(world, p, victim);
    return;
  }
  if (hit) {
    if (hit.ny >= WALKABLE_NY) land(world, p, hit.x, Math.max(0, hit.y), hit.z);
    else {
      const fx = hit.x + hit.nx * WALL_STANDOFF;
      const fz = hit.z + hit.nz * WALL_STANDOFF;
      settle(world, p, fx, hit.y, fz);
    }
    return;
  }
  if (ground) {
    land(world, p, ox + dx * t, 0, oz + dz * t);
    return;
  }
  p.pos.x = ox + dx;
  p.pos.y = oy + dy;
  p.pos.z = oz + dz;
  const lim = MAP_HALF - 0.5;
  if (Math.abs(p.pos.x) > lim || Math.abs(p.pos.z) > lim) {
    // The burn's perimeter fence stops it.
    settle(world, p, clamp(p.pos.x, -lim, lim), p.pos.y, clamp(p.pos.z, -lim, lim));
    return;
  }
  flag.pos.x = p.pos.x;
  flag.pos.y = p.pos.y;
  flag.pos.z = p.pos.z;
}

/** First non-friendly hippie (by distance along the segment) within the hit radius, up to tMax. */
function hippieOnSegment(
  world: World,
  p: Projectile,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  tMax: number,
): Hippie | null {
  const r = PROJECTILE.hippieHitRadius;
  const ex = ox + dx * tMax;
  const ez = oz + dz * tMax;
  const minX = Math.min(ox, ex) - r;
  const maxX = Math.max(ox, ex) + r;
  const minZ = Math.min(oz, ez) - r;
  const maxZ = Math.max(oz, ez) + r;
  const l2 = dx * dx + dz * dz;
  let best: Hippie | null = null;
  let bestT = Infinity;
  for (const h of world.hippies.values()) {
    if (h.status === 'ko' || h.faction === p.faction) continue;
    const hx = h.pos.x;
    const hz = h.pos.z;
    if (hx < minX || hx > maxX || hz < minZ || hz > maxZ) continue;
    const t = clamp(l2 > 0 ? ((hx - ox) * dx + (hz - oz) * dz) / l2 : 0, 0, tMax);
    const cx = ox + dx * t - hx;
    const cz = oz + dz * t - hz;
    if (cx * cx + cz * cz > r * r) continue;
    const y = oy + dy * t;
    if (y < 0 || y > PROJECTILE.hippieHitHeight || t >= bestT) continue;
    bestT = t;
    best = h;
  }
  return best;
}

/** A neutral catches the Flag and joins; a rival takes damage and drops the Flag. */
function bonk(world: World, p: Projectile, h: Hippie): void {
  if (recruitWithFlag(world, h, p.faction, p.flagId, 'throw')) {
    finish(world, p, -1);
    return;
  }
  damageEntity(world, h.id, PROJECTILE.hippieDamage, p.thrower);
  if (h.status !== 'ko') applyEffect(world, h, 'stun', PROJECTILE.hippieStun, 1, p.thrower);
  dropLoose(world, p.flagId, { x: h.pos.x, y: 0, z: h.pos.z });
  finish(world, p, -1);
}

/** Ground or deck landing: snap-plant on the nearest plantable node, else lie loose. */
function land(world: World, p: Projectile, x: number, y: number, z: number): void {
  const node = nearestPlantableNode(world, { x, z }, throwSnapRadius(world, p.faction), p.faction);
  if (node >= 0 && plantFlag(world, p.flagId, node, p.faction, p.thrower)) {
    finish(world, p, node);
    return;
  }
  dropLoose(world, p.flagId, { x, y, z });
  finish(world, p, -1);
}

/** Fall loose onto whatever surface is below (wall foot, timeout, fence). */
function settle(world: World, p: Projectile, x: number, y: number, z: number): void {
  dropLoose(world, p.flagId, { x, y: world.collision.supportHeight(x, z, Math.max(0, y)), z });
  finish(world, p, -1);
}

function finish(world: World, p: Projectile, node: number): void {
  world.projectiles.delete(p.id);
  const fl = world.flags.get(p.flagId);
  const pos = fl ? { x: fl.pos.x, y: fl.pos.y, z: fl.pos.z } : { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  world.emit({ t: 'flagLanded', flagId: p.flagId, node, pos });
}
