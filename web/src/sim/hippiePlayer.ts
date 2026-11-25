import type { V2 } from './math';
import { AVATAR } from './constants';
import { spawnProjectile } from './factory';
import { NEUTRAL } from './types';
import type { EntityId, Hippie, JobKind } from './types';
import type { World } from './world';
import { brainOf, releaseTask } from './systems/units/brain';

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

export type HippieTask = JobKind | 'wander';
interface Progress { swag: number; active: HippieTask | null; complete: number; workSeconds?: number; startedAt?: V2 }
const progress = new WeakMap<World, Map<EntityId, Progress>>();

function stats(world: World, id: EntityId): Progress {
  let map = progress.get(world);
  if (!map) { map = new Map(); progress.set(world, map); }
  let state = map.get(id);
  if (!state) { state = { swag: 0, active: null, complete: 0 }; map.set(id, state); }
  return state;
}

export function resetHippieProgress(world: World, id: EntityId): void { progress.get(world)?.delete(id); }

export function hippieCurrentTask(h: Hippie): HippieTask | null { return h.faction === NEUTRAL ? 'wander' : h.job; }
export function hippieProgress(world: World, h: Hippie) {
  const state = stats(world, h.id);
  return { swag: state.swag, active: state.active !== null, task: state.active ?? hippieCurrentTask(h), completed: state.complete };
}
export function startHippieTask(world: World, h: Hippie): boolean {
  const state = stats(world, h.id);
  const kind = hippieCurrentTask(h);
  if (state.active || !kind || h.order || !humans.get(world)?.has(h.id)) return false;
  state.active = kind;
  state.startedAt = { ...h.pos };
  state.workSeconds = 0;
  releaseTask(world, h, brainOf(h));
  setHippiePlayer(world, h.id, null);
  return true;
}
export function cancelHippieTask(world: World, id: EntityId): void {
  const state = progress.get(world)?.get(id);
  if (state) state.active = null;
}
export function workingHippieTask(world: World, h: Hippie): boolean {
  const state = progress.get(world)?.get(h.id);
  if (!state?.active) return false;
  if (state.active !== hippieCurrentTask(h) || h.order) { state.active = null; return false; }
  return true;
}
/** Only the actor's successful AI action can pay, and only once for an accepted assignment. */
export function completeHippieTask(world: World, h: Hippie, ...kinds: HippieTask[]): void {
  const state = progress.get(world)?.get(h.id);
  if (!state?.active || !kinds.includes(state.active) || !workingHippieTask(world, h)) return;
  if (state.active === 'wander' && state.startedAt && Math.hypot(h.pos.x - state.startedAt.x, h.pos.z - state.startedAt.z) < 1) return;
  state.active = null;
  state.swag++;
  state.complete++;
}
export function serveHippieTask(world: World, h: Hippie, kind: HippieTask, dt: number, required: number): void {
  const state = progress.get(world)?.get(h.id);
  if (state?.active !== kind || !workingHippieTask(world, h)) return;
  state.workSeconds = (state.workSeconds ?? 0) + dt;
  if (state.workSeconds >= required) completeHippieTask(world, h, kind);
}
export function changeHippieSwag(world: World, id: EntityId, amount: number): boolean {
  const state = stats(world, id);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(state.swag + amount) || state.swag + amount < 0) return false;
  state.swag += amount;
  return true;
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
