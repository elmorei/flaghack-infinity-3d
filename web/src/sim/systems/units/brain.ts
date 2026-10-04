/**
 * Per-hippie private mind: the task state machine, locomotion route and timers. Lives in
 * `hippie.brain.mind` (the opaque scratch the Hippie contract reserves for this system).
 */
import type { V2 } from '../../math';
import type { EntityId, Hippie, HippieStatus, Owner } from '../../types';
import type { World } from '../../world';
import { unitsState } from './state';

/** What the hippie is doing right now (finer-grained than the public HippieStatus). */
export type TaskKind =
  | 'none' // needs a decision this tick
  | 'idle' // milling around its Hearth
  | 'goto' // move order
  | 'fetchStock' // walking to a Hearth to take a Flag from stock
  | 'pickup' // walking to / picking up a loose Flag
  | 'plant' // carrying a Flag to a node and planting it
  | 'pull' // walking to / pulling a planted Flag
  | 'stow' // returning a carried Flag to the Hearth stock
  | 'chop' // walking to / chopping a lumber pile
  | 'haul' // carrying lumber to the Hearth
  | 'drum' // Drum Circle slot
  | 'patrol' // guarding an anchor point
  | 'engage' // chasing an enemy unit
  | 'respond' // answering an SOS / rally ping
  | 'tear' // attacking a piece / building
  | 'build' // helping construction
  | 'repair' // repairing a damaged / disabled building
  | 'follow' // following the vexillomancer
  | 'push' // pushing the GCC
  | 'wander' // neutral drift / overstimulated
  | 'distracted' // attention ran out: off to a sound camp
  | 'flee'; // hurt worker running home

/**
 * Route to the current goal: straight line (in line of sight), waiting for the A* budget, an A*
 * path, or blocked (A* could not reach the goal; a partial path may still lead closer).
 */
export type RouteState = 'none' | 'direct' | 'queued' | 'path' | 'blocked';

export class Brain {
  /** Faction last seen; a change means recruitment, Dialectics or capture. */
  faction: Owner;
  jobSince = -Infinity;
  task: TaskKind = 'none';
  taskAt = 0;
  /** Task targets (-1 = unused). `target` is the building/piece/unit/pile/ping/GCC id. */
  node = -1;
  flag: EntityId = -1;
  target: EntityId = -1;
  /** Enemy unit a follower is currently chasing (-1 none). */
  foe: EntityId = -1;
  slot = -1;
  /** Task anchor: patrol centre or leash origin (NaN = no leash). */
  ax = 0;
  az = 0;
  /** Task point: approach spot, patrol / wander destination. */
  px = 0;
  pz = 0;
  /** Patrol radius around the anchor. */
  patrolR = 0;
  /** Seconds of base work accumulated on the current channel (plant, pull, chop). */
  work = 0;
  waitUntil = 0;
  /** The carried Flag was taken from a rival (status 'stealing' on the way home). */
  stolen = false;
  /** This pull clears a Flag off the camp's plan on behalf of a camp with no raiders. */
  clearing = false;
  nextThinkAt = 0;
  nextShoveAt = 0;
  nextTearAt = 0;
  /** Pings born at or before this were already answered. */
  answeredAt = -Infinity;
  danceUntil = 0;
  fleeUntil = 0;
  /** Set by combat when the hippie takes damage; consumed by the reaction step. */
  hurt = false;
  lastHurtBy: EntityId | -1 = -1;
  lastHurtAt = -Infinity;
  /** A node / Flag that proved unreachable, skipped until avoidUntil. */
  avoidNode = -1;
  avoidFlag: EntityId = -1;
  avoidUntil = 0;
  /** Movement speed fraction requested by the task (1 = full speed). */
  pace = 1;

  // ── Locomotion ──────────────────────────────────────────────────────────────
  moving = false;
  goalX = 0;
  goalZ = 0;
  route: RouteState = 'none';
  /** Goal the current route was planned for, and when. */
  routeX = 0;
  routeZ = 0;
  routeAt = 0;
  /** Fresh A* attempts for the current goal after getting stuck. */
  replans = 0;
  queued = false;
  path: V2[] | null = null;
  pathIdx = 0;
  stuckT = 0;
  inMud = false;
  mudCheckAt = 0;
  readonly statusTarget: V2 = { x: 0, z: 0 };

  constructor(faction: Owner) {
    this.faction = faction;
  }
}

export function brainOf(h: Hippie): Brain {
  const b = h.brain.mind;
  if (b instanceof Brain) return b;
  const created = new Brain(h.faction);
  h.brain.mind = created;
  return created;
}

export function setStatus(h: Hippie, s: HippieStatus): void {
  h.status = s;
  h.statusTarget = null;
}

/** Status with a target point; reuses the brain's V2 so status updates never allocate. */
export function setStatusAt(h: Hippie, b: Brain, s: HippieStatus, x: number, z: number): void {
  h.status = s;
  b.statusTarget.x = x;
  b.statusTarget.z = z;
  h.statusTarget = b.statusTarget;
}

/** Switch task: releases the previous task's shared claims and resets per-task state. */
export function beginTask(world: World, h: Hippie, b: Brain, task: TaskKind): void {
  releaseTask(world, h, b);
  b.task = task;
  b.taskAt = world.time;
}

/**
 * Drop every shared claim held by the hippie (node reservation, Flag claim, drum slot, GCC)
 * and clear the task, so the next tick decides afresh with a fresh route.
 */
export function releaseTask(world: World, h: Hippie, b: Brain): void {
  const sys = unitsState(world);
  if (b.node >= 0 && sys.nodeReservations.get(b.node) === h.id) sys.nodeReservations.delete(b.node);
  if (b.flag >= 0 && sys.flagClaims.get(b.flag) === h.id) sys.flagClaims.delete(b.flag);
  if (b.task === 'drum' && b.target >= 0 && b.slot >= 0) {
    const slots = sys.drumSlots.get(b.target);
    if (slots && slots[b.slot] === h.id) slots[b.slot] = -1;
  }
  if (b.task === 'push' && b.target >= 0) {
    const g = world.buildings.get(b.target);
    if (g && g.gcc && g.gcc.pushedBy === h.id) g.gcc.pushedBy = -1;
  }
  b.task = 'none';
  b.node = -1;
  b.flag = -1;
  b.target = -1;
  b.foe = -1;
  b.slot = -1;
  b.clearing = false;
  b.work = 0;
  b.waitUntil = 0;
  b.pace = 1;
  b.moving = false;
  b.route = 'none';
  b.path = null;
}
