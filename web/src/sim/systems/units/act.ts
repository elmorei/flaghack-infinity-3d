/**
 * Hippie task execution: one tick of whatever the brain's task is. Every branch keeps the
 * public `status` / `statusTarget` truthful (the D.E.G.E.N. mesh shows them) and clears the
 * task (or the order) when it ends so the next tick decides afresh.
 */
import { BUILDINGS, DRUMMERS_PER_CIRCLE, GCC, HIPPIE, HIPPIE_AI, RECRUIT_RADIUS, RECRUIT_ATTRACT_RADIUS } from '../../constants';
import { TAU } from '../../math';
import type { V2 } from '../../math';
import { NEUTRAL } from '../../types';
import type { Building, FactionId, Hippie } from '../../types';
import type { World } from '../../world';
import { isFlagProtected } from '../abilities';
import { damageEntity } from '../combat';
import { nearestHearth } from '../economy';
import { isRecruiter } from '../recruitment';
import { speedMultiplier } from '../effects';
import { canPlantAt, depositToStock, dropLoose, plantFlag, pullFlag, takeFromStock } from '../flags';
import { beginTask, releaseTask, setStatus, setStatusAt } from './brain';
import type { Brain } from './brain';
import { moveCart } from './cart';
import { finishOrder, IDLE_R0, IDLE_R1, pickSpotAround, setRim, startEngage, startPlant, startTear } from './decide';
import { moveTo, routeExhausted } from './move';
import { buildingClosest, pieceClosest, pieceSpan } from './reach';
import type { ReachPoint, Span } from './reach';
import type { UnitsState } from './state';
import { atBuilding, HIPPIE_REACH_Y, nearestRivalUnit, needsRepair, rivalUnitPos, structureOwner } from './targets';

const ARRIVE_NODE = 0.7;
const ARRIVE_FLAG = 1.0;
const ARRIVE_PILE = 1.4;
const ARRIVE_RIM = 0.6;
const ARRIVE_ENGAGE = 0.9;
/** Tearing reaches this far from a structure's face; the hippie stands a bit closer. */
const TEAR_REACH = 2.5;
const TEAR_STAND = 0.9;
/** Pieces whose bottom is above this are out of a hippie's reach (decks overhead). */
const HIPPIE_HAND_Y = 2.2;
/** At a ping: arrival radius, search radius for trouble, and how long to look around. */
const PING_ARRIVE = 3;
const PING_SEARCH = 12;
const PING_HOLD = 2;
/** Unreachable nodes/Flags are skipped this long. */
const AVOID_TIME = 12;
/** How often a blocked hippie re-checks for a wall to tear down. */
const BLOCKED_THINK = 0.5;
/** Follower formation: rings behind the vexillomancer. */
const FOLLOW_RING = 2.6;
const FOLLOW_RING_STEP = 1.3;
const FOLLOW_ROW = 6;
const FOLLOW_SPREAD = 0.45;
const FOLLOW_SCAN = 0.4;
/**
 * Cart pushing: the pusher stands PUSH_STAND outside the cart's edge (clear of its nav padding)
 * and pushes while within PUSH_REACH of the edge and behind the cart (cosine ≥ PUSH_BEHIND).
 * Done within PUSH_DONE of the goal; gives up after PUSH_STUCK seconds wedged.
 */
const PUSH_STAND = 1.6;
const PUSH_REACH = 2.4;
const PUSH_BEHIND = 0.5;
const PUSH_ARRIVE = 0.6;
const PUSH_DONE = 1.2;
const PUSH_STUCK = 2;
/** Wandering: linger time at a spot and the ring for aimless (overstimulated) drifting. */
const LINGER_MIN = 4;
const LINGER_MAX = 12;
const WANDER_R0 = 6;
const WANDER_R1 = 20;
const NEUTRAL_SPREAD = 6;
const DANCE_ARRIVE = 2.5;

const tmp: V2 = { x: 0, z: 0 };
const reachPt: ReachPoint = { x: 0, z: 0, dist: 0 };
const span: Span = { y0: 0, y1: 0 };

function endTask(world: World, h: Hippie, b: Brain, ordered: boolean): void {
  if (ordered) finishOrder(world, h, b);
  else releaseTask(world, h, b);
}

function avoidNode(world: World, b: Brain, node: number): void {
  b.avoidNode = node;
  b.avoidUntil = world.time + AVOID_TIME;
}

function avoidFlag(world: World, b: Brain, flagId: number): void {
  b.avoidFlag = flagId;
  b.avoidUntil = world.time + AVOID_TIME;
}

export function act(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, dt: number): void {
  switch (b.task) {
    case 'none':
      b.moving = false;
      setStatus(h, 'idle');
      return;
    case 'idle':
      actIdle(world, sys, h, b, f);
      return;
    case 'goto':
      setStatusAt(h, b, 'walking', b.px, b.pz);
      if (moveTo(world, sys, h, b, b.px, b.pz, 1) || routeExhausted(h, b)) finishOrder(world, h, b);
      return;
    case 'fetchStock':
      actFetchStock(world, sys, h, b, f);
      return;
    case 'pickup':
      actPickup(world, sys, h, b, dt);
      return;
    case 'plant':
      actPlant(world, sys, h, b, f, dt);
      return;
    case 'pull':
      actPull(world, sys, h, b, f, dt);
      return;
    case 'stow':
    case 'haul':
      actDeliver(world, sys, h, b, f);
      return;
    case 'chop':
      actChop(world, sys, h, b, dt);
      return;
    case 'drum':
      actDrum(world, sys, h, b, f);
      return;
    case 'patrol':
      actPatrol(world, sys, h, b);
      return;
    case 'engage':
      actEngage(world, sys, h, b, f);
      return;
    case 'respond':
      actRespond(world, sys, h, b, f);
      return;
    case 'tear':
      actTear(world, sys, h, b, f);
      return;
    case 'build':
    case 'repair':
      actHelp(world, sys, h, b, f);
      return;
    case 'follow':
      actFollow(world, sys, h, b, f);
      return;
    case 'push':
      actPush(world, sys, h, b, f, dt);
      return;
    case 'wander':
      wander(world, sys, h, b);
      return;
    case 'distracted':
      actDistracted(world, sys, h, b);
      return;
    case 'flee':
      actFlee(world, sys, h, b, f);
      return;
  }
}

function actIdle(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  b.pace = HIPPIE_AI.idlePace;
  setStatus(h, 'idle');
  if (world.time < b.waitUntil) {
    b.moving = false;
    return;
  }
  if (!moveTo(world, sys, h, b, b.px, b.pz, 1) && b.route !== 'blocked') return;
  b.waitUntil = world.time + world.rng.range(2, 6);
  const home = nearestHearth(world, f, h.pos);
  if (home) pickSpotAround(world, b, home.pos.x, home.pos.z, IDLE_R0, IDLE_R1);
}

function actFetchStock(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const hb = world.buildings.get(b.target);
  if (!hb || hb.faction !== f) {
    releaseTask(world, h, b);
    return;
  }
  setStatusAt(h, b, 'fetching', hb.pos.x, hb.pos.z);
  if (!atBuilding(h, hb, HIPPIE.interactReach)) {
    moveTo(world, sys, h, b, b.px, b.pz, ARRIVE_RIM);
    if (routeExhausted(h, b)) releaseTask(world, h, b);
    return;
  }
  b.moving = false;
  const node = b.node;
  const fl = takeFromStock(world, hb.id, h.id);
  b.stolen = false;
  if (fl && node >= 0) startPlant(world, sys, h, b, node);
  else releaseTask(world, h, b);
}

function actPickup(world: World, sys: UnitsState, h: Hippie, b: Brain, dt: number): void {
  const fl = world.flags.get(b.flag);
  if (!fl || fl.state !== 'loose' || fl.pos.y > HIPPIE_REACH_Y) {
    releaseTask(world, h, b);
    return;
  }
  if (!moveTo(world, sys, h, b, fl.pos.x, fl.pos.z, ARRIVE_FLAG)) {
    b.work = 0;
    setStatusAt(h, b, 'fetching', fl.pos.x, fl.pos.z);
    if (routeExhausted(h, b)) {
      avoidFlag(world, b, fl.id);
      releaseTask(world, h, b);
    }
    return;
  }
  setStatusAt(h, b, 'pulling', fl.pos.x, fl.pos.z);
  b.work += dt * speedMultiplier(world, h);
  if (b.work < HIPPIE.pickupTime) return;
  const node = b.node;
  pullFlag(world, fl.id, h.id);
  b.stolen = false;
  if (h.carryingFlag === fl.id && node >= 0) startPlant(world, sys, h, b, node);
  else releaseTask(world, h, b);
}

function actPlant(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, dt: number): void {
  const ordered = h.order !== null && h.order.kind === 'plant';
  const flagId = h.carryingFlag;
  const node = b.node;
  // A job plant follows the live plan; an ordered one plants where it was told (and ends when
  // someone else fills the node).
  if (flagId === -1 || node < 0 || world.survey.nodeFlag[node] >= 0 || (!ordered && !world.factions[f].plan.has(node))) {
    endTask(world, h, b, ordered && node >= 0 && world.survey.nodeFlag[node] >= 0);
    return;
  }
  const n = world.lattice.nodes[node];
  if (!moveTo(world, sys, h, b, n.x, n.z, ARRIVE_NODE)) {
    b.work = 0;
    setStatusAt(h, b, 'carrying', n.x, n.z);
    if (routeExhausted(h, b)) {
      avoidNode(world, b, node);
      endTask(world, h, b, ordered);
    }
    return;
  }
  setStatusAt(h, b, 'planting', n.x, n.z);
  b.work += dt * speedMultiplier(world, h);
  if (b.work < HIPPIE.plantTime) return;
  if (!canPlantAt(world, node, f) || !plantFlag(world, flagId, node, f, h.id)) avoidNode(world, b, node);
  endTask(world, h, b, ordered);
}

function actPull(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, dt: number): void {
  const fl = world.flags.get(b.flag);
  const ordered = h.order !== null && (h.order.kind === 'pull' || (h.order.kind === 'attack' && h.order.target === b.flag));
  if (
    !fl ||
    (fl.state !== 'planted' && fl.state !== 'loose') ||
    (fl.owner !== f && isFlagProtected(world, fl)) ||
    (!ordered && fl.owner === f)
  ) {
    endTask(world, h, b, ordered);
    return;
  }
  if (!moveTo(world, sys, h, b, fl.pos.x, fl.pos.z, ARRIVE_FLAG)) {
    b.work = 0;
    setStatusAt(h, b, 'walking', fl.pos.x, fl.pos.z);
    if (b.route === 'blocked' && world.time >= b.nextThinkAt) {
      b.nextThinkAt = world.time + BLOCKED_THINK;
      if (tearBlocker(world, h, b, f, fl.pos.x, fl.pos.z)) return;
      if (routeExhausted(h, b)) {
        avoidFlag(world, b, fl.id);
        endTask(world, h, b, ordered);
      }
    }
    return;
  }
  setStatusAt(h, b, 'pulling', fl.pos.x, fl.pos.z);
  b.work += dt * speedMultiplier(world, h);
  const dur = fl.state === 'loose' ? HIPPIE.pickupTime : fl.owner === f ? HIPPIE.pullOwnTime : HIPPIE.pullEnemyTime;
  if (b.work < dur) return;
  const prev = fl.owner;
  // A rival Flag squatting on our plan goes straight back into its node as ours: the planner
  // priced that node as "pull, then plant", so there is no trip home and back.
  const plan = world.factions[f].plan;
  const spot = fl.state !== 'planted' || prev === f ? -1 : plan.has(fl.node) ? fl.node : plan.has(fl.altNode) ? fl.altNode : -1;
  pullFlag(world, fl.id, h.id);
  const got = h.carryingFlag === fl.id;
  if (got && spot >= 0 && canPlantAt(world, spot, f)) {
    if (ordered) h.order = null;
    startPlant(world, sys, h, b, spot);
    return;
  }
  endTask(world, h, b, ordered);
  b.stolen = got && prev !== f && prev !== NEUTRAL;
}

/** A rival wall/building in the way of (tx, tz): tear it down (the raid resumes afterwards). */
function tearBlocker(world: World, h: Hippie, b: Brain, f: FactionId, tx: number, tz: number): boolean {
  const id = world.nav.blockerOnSegment(h.pos.x, h.pos.z, tx, tz);
  if (id < 0) return false;
  const owner = structureOwner(world, id);
  if (owner === undefined || owner === f) return false;
  startTear(world, h, b, id);
  return true;
}

/** Stow a carried Flag in the Hearth stock, or haul lumber home. */
function actDeliver(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const stow = b.task === 'stow';
  if (stow ? h.carryingFlag === -1 : h.carryingLumber <= 0) {
    releaseTask(world, h, b);
    return;
  }
  let hb = world.buildings.get(b.target);
  if (!hb || hb.faction !== f) {
    hb = nearestHearth(world, f, h.pos);
    if (!hb) {
      if (stow) dropLoose(world, h.carryingFlag, { x: h.pos.x, y: 0, z: h.pos.z });
      else h.carryingLumber = 0;
      releaseTask(world, h, b);
      return;
    }
    b.target = hb.id;
    setRim(b, hb, h);
  }
  setStatusAt(h, b, stow && b.stolen ? 'stealing' : 'hauling', hb.pos.x, hb.pos.z);
  if (!atBuilding(h, hb, HIPPIE.interactReach)) {
    moveTo(world, sys, h, b, b.px, b.pz, ARRIVE_RIM);
    return;
  }
  b.moving = false;
  if (stow) {
    depositToStock(world, h.carryingFlag, hb.id);
    b.stolen = false;
  } else {
    const amount = h.carryingLumber;
    world.factions[f].lumber += amount;
    h.carryingLumber = 0;
    world.emit({ t: 'lumberDelivered', faction: f, amount, pos: { x: hb.pos.x, z: hb.pos.z } });
  }
  releaseTask(world, h, b);
}

function actChop(world: World, sys: UnitsState, h: Hippie, b: Brain, dt: number): void {
  const pile = world.piles.get(b.target);
  const ordered = h.order !== null && h.order.kind === 'gather';
  if (!pile || pile.lumber <= 0) {
    endTask(world, h, b, ordered);
    return;
  }
  if (!moveTo(world, sys, h, b, pile.pos.x, pile.pos.z, ARRIVE_PILE)) {
    b.work = 0;
    setStatusAt(h, b, 'walking', pile.pos.x, pile.pos.z);
    if (routeExhausted(h, b)) endTask(world, h, b, ordered);
    return;
  }
  setStatusAt(h, b, 'chopping', pile.pos.x, pile.pos.z);
  h.facing = Math.atan2(pile.pos.x - h.pos.x, pile.pos.z - h.pos.z);
  b.work += dt * speedMultiplier(world, h);
  if (b.work < HIPPIE.gatherTime) return;
  const amount = Math.min(HIPPIE.gatherAmount, pile.lumber);
  pile.lumber -= amount;
  h.carryingLumber = amount;
  world.emit({ t: 'harvest', pileId: pile.id, by: h.id, amount, pos: { x: pile.pos.x, z: pile.pos.z } });
  releaseTask(world, h, b);
}

function actDrum(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const c = world.buildings.get(b.target);
  const slots = sys.drumSlots.get(b.target);
  if (!c || c.faction !== f || c.built < 1 || c.disabled || !slots || slots[b.slot] !== h.id) {
    releaseTask(world, h, b);
    return;
  }
  const ring = BUILDINGS.drumcircle.radius + HIPPIE_AI.drumRing;
  const a = c.yaw + (b.slot / DRUMMERS_PER_CIRCLE) * TAU;
  const there = moveTo(world, sys, h, b, c.pos.x + Math.sin(a) * ring, c.pos.z + Math.cos(a) * ring, 0.35);
  const dx = c.pos.x - h.pos.x;
  const dz = c.pos.z - h.pos.z;
  if (there || dx * dx + dz * dz <= (ring + 0.8) * (ring + 0.8)) {
    setStatusAt(h, b, 'drumming', c.pos.x, c.pos.z);
    if (there) h.facing = Math.atan2(dx, dz);
  } else setStatusAt(h, b, 'walking', c.pos.x, c.pos.z);
}

function actPatrol(world: World, sys: UnitsState, h: Hippie, b: Brain): void {
  b.pace = HIPPIE_AI.patrolPace;
  setStatusAt(h, b, 'defending', b.ax, b.az);
  if (world.time < b.waitUntil) {
    b.moving = false;
    return;
  }
  if (!moveTo(world, sys, h, b, b.px, b.pz, 1) && b.route !== 'blocked') return;
  b.waitUntil = world.time + world.rng.range(1.5, 4);
  pickSpotAround(world, b, b.ax, b.az, b.patrolR * 0.4, b.patrolR);
}

function actEngage(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const ordered = h.order !== null && h.order.kind === 'attack' && h.order.target === b.target;
  if (!rivalUnitPos(world, f, b.target, tmp)) {
    endTask(world, h, b, ordered);
    return;
  }
  // Guards give up a chase once the intruder is led far from what they guard.
  if (Number.isFinite(b.ax) && (tmp.x - b.ax) ** 2 + (tmp.z - b.az) ** 2 > HIPPIE_AI.leash * HIPPIE_AI.leash) {
    releaseTask(world, h, b);
    return;
  }
  b.pace = 1;
  setStatusAt(h, b, 'fighting', tmp.x, tmp.z);
  moveTo(world, sys, h, b, tmp.x, tmp.z, ARRIVE_ENGAGE);
  if (b.route === 'blocked' && world.time >= b.nextThinkAt) {
    b.nextThinkAt = world.time + BLOCKED_THINK;
    if (!tearBlocker(world, h, b, f, tmp.x, tmp.z) && routeExhausted(h, b)) releaseTask(world, h, b);
  }
}

function actRespond(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const p = world.pings.get(b.target);
  if (!p || p.until <= world.time) {
    b.answeredAt = world.time;
    releaseTask(world, h, b);
    return;
  }
  b.pace = 1;
  setStatusAt(h, b, 'responding', p.pos.x, p.pos.z);
  if (!moveTo(world, sys, h, b, p.pos.x, p.pos.z, PING_ARRIVE)) {
    if (routeExhausted(h, b)) {
      b.answeredAt = world.time;
      releaseTask(world, h, b);
    }
    return;
  }
  // At the scene: take on whoever is there, else look around a moment.
  const foe = nearestRivalUnit(world, sys, f, p.pos.x, p.pos.z, PING_SEARCH);
  if (foe >= 0) {
    b.answeredAt = world.time;
    startEngage(world, h, b, foe, p.pos.x, p.pos.z);
    return;
  }
  if (b.waitUntil === 0) b.waitUntil = world.time + PING_HOLD;
  else if (world.time >= b.waitUntil) {
    b.answeredAt = world.time;
    releaseTask(world, h, b);
  }
}

function actTear(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const id = b.target;
  const ordered = h.order !== null && h.order.kind === 'attack' && h.order.target === id;
  const piece = world.pieces.get(id);
  const bld = piece ? undefined : world.buildings.get(id);
  if (piece) {
    pieceSpan(piece, span);
    if (piece.faction === f || span.y0 > HIPPIE_HAND_Y) {
      endTask(world, h, b, ordered);
      return;
    }
    pieceClosest(world, piece, h.pos.x, h.pos.z, reachPt);
  } else if (bld) {
    // Hearths cannot be torn down (only overwritten); disabled buildings are already down.
    if (bld.faction === f || bld.kind === 'hearth' || bld.disabled || (bld.gcc && bld.gcc.destroyedUntil > world.time)) {
      endTask(world, h, b, ordered);
      return;
    }
    buildingClosest(bld, h.pos.x, h.pos.z, reachPt);
  } else {
    endTask(world, h, b, ordered);
    return;
  }
  if (reachPt.dist > TEAR_REACH) {
    const dx = h.pos.x - reachPt.x;
    const dz = h.pos.z - reachPt.z;
    const d = Math.hypot(dx, dz);
    setStatusAt(h, b, 'walking', reachPt.x, reachPt.z);
    moveTo(world, sys, h, b, reachPt.x + (dx / d) * TEAR_STAND, reachPt.z + (dz / d) * TEAR_STAND, 0.4);
    if (routeExhausted(h, b)) endTask(world, h, b, ordered);
    return;
  }
  b.moving = false;
  setStatusAt(h, b, 'tearing', reachPt.x, reachPt.z);
  h.facing = Math.atan2(reachPt.x - h.pos.x, reachPt.z - h.pos.z);
  if (world.time < b.nextTearAt) return;
  b.nextTearAt = world.time + HIPPIE_AI.tearInterval;
  damageEntity(world, id, HIPPIE.wallDps * HIPPIE_AI.tearInterval * speedMultiplier(world, h), h.id);
}

function actHelp(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const bld = world.buildings.get(b.target);
  const repair = b.task === 'repair';
  if (!bld || bld.faction !== f || (repair ? !needsRepair(world, bld) : bld.built >= 1)) {
    releaseTask(world, h, b);
    return;
  }
  if (!atBuilding(h, bld, HIPPIE_AI.repairStand)) {
    setStatusAt(h, b, 'walking', bld.pos.x, bld.pos.z);
    moveTo(world, sys, h, b, b.px, b.pz, ARRIVE_RIM);
    if (routeExhausted(h, b)) releaseTask(world, h, b);
    return;
  }
  b.moving = false;
  setStatusAt(h, b, repair ? 'repairing' : 'building', bld.pos.x, bld.pos.z);
  h.facing = Math.atan2(bld.pos.x - h.pos.x, bld.pos.z - h.pos.z);
}

function actFollow(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const order = h.order;
  const av = order !== null && order.kind === 'follow' ? world.avatars.get(order.avatarId) : undefined;
  if (!av || av.faction !== f) {
    finishOrder(world, h, b);
    return;
  }
  b.pace = 1;
  if (av.koUntil > 0) {
    // Wait for the vexillomancer to wake at the Hearth.
    b.moving = false;
    setStatusAt(h, b, 'following', av.pos.x, av.pos.z);
    return;
  }
  // Rivals who come at the vexillomancer get shoved.
  const leash = HIPPIE_AI.followEngageRadius + 4;
  if (b.foe >= 0 && (!rivalUnitPos(world, f, b.foe, tmp) || (tmp.x - av.pos.x) ** 2 + (tmp.z - av.pos.z) ** 2 > leash * leash)) {
    b.foe = -1;
  }
  if (b.foe < 0 && world.time >= b.nextThinkAt) {
    b.nextThinkAt = world.time + FOLLOW_SCAN;
    const foe = nearestRivalUnit(world, sys, f, av.pos.x, av.pos.z, HIPPIE_AI.followEngageRadius);
    if (foe >= 0 && rivalUnitPos(world, f, foe, tmp)) b.foe = foe;
  }
  if (b.foe >= 0) {
    setStatusAt(h, b, 'fighting', tmp.x, tmp.z);
    moveTo(world, sys, h, b, tmp.x, tmp.z, ARRIVE_ENGAGE);
    return;
  }
  // Loose formation behind the vexillomancer, rows of FOLLOW_ROW.
  const k = Math.max(0, b.slot);
  const a = av.yaw + Math.PI + ((k % FOLLOW_ROW) - (FOLLOW_ROW - 1) / 2) * FOLLOW_SPREAD;
  const r = FOLLOW_RING + Math.floor(k / FOLLOW_ROW) * FOLLOW_RING_STEP;
  setStatusAt(h, b, 'following', av.pos.x, av.pos.z);
  moveTo(world, sys, h, b, av.pos.x + Math.sin(a) * r, av.pos.z + Math.cos(a) * r, 0.8);
}

function actPush(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, dt: number): void {
  const order = h.order;
  if (order === null || order.kind !== 'push') {
    releaseTask(world, h, b);
    return;
  }
  const g = world.buildings.get(order.gccId);
  if (!g || !g.gcc || g.faction !== f || g.gcc.destroyedUntil > world.time) {
    finishOrder(world, h, b);
    return;
  }
  const dx = order.to.x - g.pos.x;
  const dz = order.to.z - g.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < PUSH_DONE) {
    finishOrder(world, h, b);
    return;
  }
  const ux = dx / d;
  const uz = dz / d;
  // The cart is a nav blocker, so the pusher works from just outside its padded footprint.
  const back = BUILDINGS.gcc.radius + PUSH_STAND;
  const bx = g.pos.x - ux * back;
  const bz = g.pos.z - uz * back;
  b.pace = 1;
  if (g.gcc.pushedBy !== -1 && g.gcc.pushedBy !== h.id) {
    // Someone else (usually the vexillomancer) has the cart: keep close and wait.
    setStatusAt(h, b, 'walking', g.pos.x, g.pos.z);
    moveTo(world, sys, h, b, bx, bz, PUSH_STAND);
    return;
  }
  // Pushing from behind: close enough to the cart and on the far side from the goal.
  const hx = g.pos.x - h.pos.x;
  const hz = g.pos.z - h.pos.z;
  const hd = Math.hypot(hx, hz);
  const behind = hd <= BUILDINGS.gcc.radius + PUSH_REACH && hd > 1e-3 && (hx * ux + hz * uz) / hd >= PUSH_BEHIND;
  moveTo(world, sys, h, b, bx, bz, PUSH_ARRIVE);
  if (!behind) {
    if (g.gcc.pushedBy === h.id) g.gcc.pushedBy = -1;
    setStatusAt(h, b, 'walking', g.pos.x, g.pos.z);
    if (routeExhausted(h, b)) finishOrder(world, h, b);
    return;
  }
  g.gcc.pushedBy = h.id;
  setStatusAt(h, b, 'hauling', order.to.x, order.to.z);
  const step = Math.min(d, GCC.pushSpeed * speedMultiplier(world, h) * dt);
  if (moveCart(world, g, g.pos.x + ux * step, g.pos.z + uz * step, Math.atan2(ux, uz), dt)) {
    b.waitUntil = 0;
    return;
  }
  // Wedged against something: give up after a moment.
  if (b.waitUntil === 0) b.waitUntil = world.time + PUSH_STUCK;
  else if (world.time >= b.waitUntil) finishOrder(world, h, b);
}

/** Next wandering spot: neutrals drift between sound camps and spawns, others nearby. */
export function pickWanderSpot(world: World, h: Hippie, b: Brain): void {
  const map = world.map;
  const n = h.faction === NEUTRAL ? map.soundCamps.length + map.neutralSpawns.length : 0;
  if (n === 0) {
    pickSpotAround(world, b, h.pos.x, h.pos.z, WANDER_R0, WANDER_R1);
    return;
  }
  const i = world.rng.int(0, n - 1);
  if (i < map.soundCamps.length) {
    const c = map.soundCamps[i];
    pickSpotAround(world, b, c.x, c.z, 0, c.radius * 0.7);
  } else {
    const s = map.neutralSpawns[i - map.soundCamps.length];
    pickSpotAround(world, b, s.x, s.z, 0, NEUTRAL_SPREAD);
  }
}

/** Drift between spots, lingering at each (neutral life; overstimulated hippies). */
export function wander(world: World, sys: UnitsState, h: Hippie, b: Brain): void {
  b.pace = HIPPIE_AI.neutralPace;
  // The music draws unaligned hippies toward working recruiters. They wait in recruitment
  // range instead of endlessly wandering past the camp; the GCC can be pushed to meet them.
  if (h.faction === NEUTRAL && b.waitUntil !== Infinity) {
    let nearest: Building | undefined;
    let distance = RECRUIT_ATTRACT_RADIUS * RECRUIT_ATTRACT_RADIUS;
    for (const recruiter of world.buildings.values()) {
      if (!isRecruiter(world, recruiter)) continue;
      const d = (recruiter.pos.x - h.pos.x) ** 2 + (recruiter.pos.z - h.pos.z) ** 2;
      if (d < distance || (d === distance && nearest && recruiter.id < nearest.id)) {
        nearest = recruiter;
        distance = d;
      }
    }
    if (nearest) {
      if (distance <= (RECRUIT_RADIUS * 0.8) ** 2) {
        b.moving = false;
        setStatus(h, 'idle');
      } else {
        moveTo(world, sys, h, b, nearest.pos.x, nearest.pos.z, RECRUIT_RADIUS * 0.8);
        setStatusAt(h, b, 'walking', nearest.pos.x, nearest.pos.z);
      }
      return;
    }
  }
  if (world.time < b.waitUntil) {
    b.moving = false;
    setStatus(h, 'idle');
    return;
  }
  if (moveTo(world, sys, h, b, b.px, b.pz, 2) || routeExhausted(h, b)) {
    b.waitUntil = world.time + world.rng.range(LINGER_MIN, LINGER_MAX);
    pickWanderSpot(world, h, b);
    setStatus(h, 'idle');
    return;
  }
  setStatusAt(h, b, 'walking', b.px, b.pz);
}

/** Attention ran out: off to the nearest sound camp to dance it back. */
export function becomeDistracted(world: World, h: Hippie, b: Brain): void {
  beginTask(world, h, b, 'distracted');
  b.danceUntil = 0;
  const camps = world.map.soundCamps;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < camps.length; i++) {
    const d2 = (camps[i].x - h.pos.x) ** 2 + (camps[i].z - h.pos.z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  if (best >= 0) pickSpotAround(world, b, camps[best].x, camps[best].z, 0, camps[best].radius * 0.6);
  else {
    b.px = h.pos.x;
    b.pz = h.pos.z;
  }
  world.emit({ t: 'distracted', hippieId: h.id, faction: h.faction });
}

function actDistracted(world: World, sys: UnitsState, h: Hippie, b: Brain): void {
  setStatusAt(h, b, 'distracted', b.px, b.pz);
  if (b.danceUntil === 0) {
    if (
      moveTo(world, sys, h, b, b.px, b.pz, DANCE_ARRIVE) ||
      routeExhausted(h, b) ||
      world.time - b.taskAt > HIPPIE_AI.distractedMaxWalk
    ) {
      b.moving = false;
      b.danceUntil = world.time + HIPPIE.distractedTime;
    }
    return;
  }
  b.moving = false;
  if (world.time < b.danceUntil) return;
  h.attention = Math.max(h.attention, HIPPIE.distractedRecoverTo);
  b.danceUntil = 0;
  releaseTask(world, h, b);
}

function actFlee(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  const home = nearestHearth(world, f, h.pos);
  if (!home || world.time >= b.fleeUntil) {
    releaseTask(world, h, b);
    return;
  }
  b.pace = 1;
  setStatusAt(h, b, 'fleeing', home.pos.x, home.pos.z);
  if (moveTo(world, sys, h, b, home.pos.x, home.pos.z, BUILDINGS.hearth.radius + HIPPIE.interactReach)) releaseTask(world, h, b);
}
