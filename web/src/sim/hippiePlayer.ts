import type { V2 } from './math';
import { AVATAR } from './constants';
import { spawnProjectile } from './factory';
import { NEUTRAL } from './types';
import type { EntityId, Hippie } from './types';
import type { World } from './world';

/** Host-local inputs. A claimed unit stays an ordinary Signifier on the replicated world. */
const humans = new WeakMap<World, Map<EntityId, V2 | null>>();

export function hippiePlayerGoal(world: World, id: EntityId): V2 | null | undefined {
  return humans.get(world)?.get(id);
}

export function setHippiePlayer(world: World, id: EntityId, goal: V2 | null | undefined): void {
  let controlled = humans.get(world);
  if (goal === undefined) { controlled?.delete(id); return; }
  if (!controlled) { controlled = new Map(); humans.set(world, controlled); }
  controlled.set(id, goal);
}

/** A physical toss, never an automatic faction plant or recruitment. */
export function tossHippieFlag(world: World, h: Hippie, target: V2): boolean {
  const flag = world.flags.get(h.carryingFlag);
  if (!flag || flag.state !== 'carried' || flag.holder !== h.id) return false;
  const dx = target.x - h.pos.x, dz = target.z - h.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) return false;
  const x = dx / d, z = dz / d;
  const range = Math.min(24, d);
  const time = Math.max(0.35, Math.sqrt(2 * range / AVATAR.gravity));
  const from = { x: h.pos.x, y: world.collision.groundHeight(h.pos.x, h.pos.z) + 1, z: h.pos.z };
  const vel = { x: x * range / time, y: Math.max(1, time * AVATAR.gravity / 2 - 1 / time), z: z * range / time };
  const projectile = spawnProjectile(world, flag.id, h.id, NEUTRAL, from, vel);
  h.carryingFlag = -1;
  h.facing = Math.atan2(dx, dz);
  flag.state = 'flying';
  flag.holder = projectile.id;
  flag.node = flag.altNode = -1;
  flag.lastMovedAt = world.time;
  flag.tilt = 0;
  flag.pos = { ...from };
  flag.history.push({ t: world.time, x: from.x, z: from.z, state: 'flying', by: h.id });
  if (flag.history.length > 16) flag.history.splice(0, flag.history.length - 16);
  world.emit({ t: 'flagThrown', flagId: flag.id, faction: NEUTRAL, from, vel });
  return true;
}
