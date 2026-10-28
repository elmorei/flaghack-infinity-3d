/**
 * Hippie decisions: what to do next given the hippie's order, what it carries and its job.
 * The start* helpers claim shared resources (node reservations, Flag claims, Drum slots) and
 * set the task; act.ts executes tasks and clears them when they end.
 */
import { BUILDINGS, HIPPIE, HIPPIE_AI } from '../../constants';
import { TAU } from '../../math';
import type { V2 } from '../../math';
import { FACTION_IDS } from '../../types';
import type { Building, EntityId, FactionId, Hippie, HippieOrder, Pile } from '../../types';
import type { World } from '../../world';
import type { LogisticsTarget } from './targets';
import { logisticsRadius } from './targets';
import { nearestHearth } from '../economy';
import { canRecruit } from '../recruitment';
import { canPlantAt } from '../flags';
import { beginTask, releaseTask } from './brain';
import type { Brain } from './brain';
import type { UnitsState } from './state';
import {
  boundaryFlags,
  buildingNeedingHands,
  claimDrumSlot,
  criticalFlags,
  deliveryHearth,
  findIntruder,
  hearthWithStock,
  intruderFlags,
  nearestLooseFlag,
  nearestRivalUnit,
  needsRepair,
  pickFlag,
  pickPile,
  pickPlanBlocker,
  pickPlanNode,
  rivalFlagNear,
  rivalUnitPos,
  structureOwner,
  threatFlags,
} from './targets';

/** Periodic re-think cadence for interruptible tasks (+ a per-hippie phase offset). */
const THINK_INTERVAL = 0.45;
const THINK_JITTER = 0.02;
/** Hearth approach spots sit this far outside the footprint. */
const RIM_GAP = 1.3;
/** Idle hippies mill around between these distances from their Hearth. */
export const IDLE_R0 = 5;
export const IDLE_R1 = 9;
/** Ordered "defend here" guards a tight ring and reacts within this radius. */
const ORDER_PATROL_R = 6;
const ORDER_GUARD_RADIUS = 14;
/** Defenders pull intruding Flags up to this far away; builders help within this range. */
const INTRUDER_FLAG_RANGE = 45;
const HELP_RANGE = 40;
/** Critical-list rank penalty: earlier entries are cheaper to break. */
const CRITICAL_RANK_PENALTY = 6;
/** Non-raiders a camp spares for pulling Flags off its plan when it has no raiders. */
const CLEARERS_PER_CAMP = 1;

const scratch: V2 = { x: 0, z: 0 };

/** Tasks that may be re-decided mid-way (to answer pings, intruders, new work). */
export function needsDecision(world: World, b: Brain, h: Hippie): boolean {
  switch (b.task) {
    case 'none':
    case 'wander':
      return true;
    case 'respond':
      return h.job === 'defend' && !h.order && world.time >= b.nextThinkAt;
    case 'idle':
    case 'patrol':
    case 'build':
    case 'repair':
      return world.time >= b.nextThinkAt;
    default:
      return false;
  }
}

export function decide(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  b.nextThinkAt = world.time + THINK_INTERVAL + (h.id % 7) * THINK_JITTER;
  const order = h.order;
  if (order) {
    decideOrder(world, sys, h, b, f, order);
    return;
  }
  // Hands first: anything the job cannot use goes home.
  if (h.carryingFlag !== -1 && h.job !== 'survey') {
    startDeliver(world, h, b, f, 'stow');
    return;
  }
  if (h.carryingLumber > 0) {
    startDeliver(world, h, b, f, 'haul');
    return;
  }
  switch (h.job) {
    case 'survey':
      decideSurvey(world, sys, h, b, f);
      return;
    case 'gather': {
      const pile = pickPile(world, sys, h);
      if (pile) startChop(world, sys, h, b, pile);
      else startIdle(world, h, b, f);
      return;
    }
    case 'defend': {
      const home = nearestHearth(world, f, h.pos);
      if (home) guard(world, sys, h, b, f, home.pos.x, home.pos.z, true);
      else startIdle(world, h, b, f);
      return;
    }
    case 'raid':
      decideRaid(world, sys, h, b, f);
      return;
    case 'ritual':
      startDrum(world, sys, h, b, f);
      return;
    case null: {
      const rally = pingToAnswer(world, sys, h, b, f, false);
      if (rally >= 0) startRespond(world, sys, h, b, rally);
      else startIdle(world, h, b, f);
      return;
    }
  }
}

function decideSurvey(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  // Plan nodes under another camp's Flag are not plantable yet: pickPlanNode skips them.
  const node = pickPlanNode(world, sys, h, b, f);
  if (h.carryingFlag !== -1) {
    if (node >= 0) startPlant(world, sys, h, b, node);
    else startDeliver(world, h, b, f, 'stow');
    return;
  }
  if (node >= 0 && startFetch(world, sys, h, b, f, node)) return;
  if (clearPlanBlocker(world, sys, h, b, f)) return;
  // Recover spare Flags after the plan is complete, rather than leaving them on the ground.
  const loose = nearestLooseFlag(world, sys, h, b, f, HIPPIE_AI.fetchRadius);
  if (loose && deliveryHearth(world, h, b, f)) {
    beginTask(world, h, b, 'pickup');
    claimFlag(sys, h, b, loose.id);
  } else startIdle(world, h, b, f);
}

/**
 * A camp without raiders would never free plan nodes squatted by other camps' Flags, so one
 * otherwise idle Survey / Defend hippie pulls them (and plants each back as ours, see actPull).
 */
function clearPlanBlocker(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): boolean {
  if (sys.raiders[f] > 0 || sys.clearers[f] >= CLEARERS_PER_CAMP) return false;
  const fl = pickPlanBlocker(world, sys, h, b, f);
  if (fl < 0) return false;
  startPull(world, sys, h, b, fl);
  b.clearing = true;
  sys.clearers[f]++;
  return true;
}

/** Go for a Flag (Hearth stock or a nearby loose one, whichever is closer) for `node`. */
function startFetch(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, node: number): boolean {
  const hearth = hearthWithStock(world, sys, f, h.pos.x, h.pos.z, b);
  const loose = nearestLooseFlag(world, sys, h, b, f, HIPPIE_AI.fetchRadius);
  if (loose) {
    const dl = Math.hypot(loose.pos.x - h.pos.x, loose.pos.z - h.pos.z);
    const dh = hearth ? Math.hypot(hearth.pos.x - h.pos.x, hearth.pos.z - h.pos.z) - logisticsRadius(hearth) : Infinity;
    if (dl <= dh) {
      beginTask(world, h, b, 'pickup');
      claimFlag(sys, h, b, loose.id);
      reserveNode(sys, h, b, node);
      return true;
    }
  }
  if (!hearth) return false;
  beginTask(world, h, b, 'fetchStock');
  b.target = hearth.id;
  setRim(b, hearth, h);
  sys.fetchers.set(hearth.id, (sys.fetchers.get(hearth.id) ?? 0) + 1);
  reserveNode(sys, h, b, node);
  return true;
}

function decideRaid(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  // 1. Loops closing on our Hearth: their critical Flags.
  let fl = pickFlag(world, sys, h, b, f, criticalFlags(world, sys, f), Infinity, CRITICAL_RANK_PENALTY);
  // 2. Other camps' Flags squatting on our plan: the Survey cannot close until they come out.
  if (fl < 0) fl = pickPlanBlocker(world, sys, h, b, f);
  // 3. Any rival Flag within threat range of our Hearth.
  if (fl < 0) fl = pickFlag(world, sys, h, b, f, threatFlags(world, sys, f), Infinity, 0);
  if (fl >= 0) {
    startPull(world, sys, h, b, fl);
    return;
  }
  // 4. Attack pings on our mesh.
  if (raidPing(world, sys, h, b, f)) return;
  // 5. The nearest rival Survey boundary.
  let best = -1;
  let bestD = Infinity;
  for (const e of FACTION_IDS) {
    if (e === f || !world.factions[e].alive) continue;
    const cand = pickFlag(world, sys, h, b, f, boundaryFlags(world, sys, e), bestD, 0);
    if (cand < 0) continue;
    const cf = world.flags.get(cand);
    if (!cf) continue;
    best = cand;
    bestD = Math.hypot(cf.pos.x - h.pos.x, cf.pos.z - h.pos.z);
  }
  if (best >= 0) startPull(world, sys, h, b, best);
  else startIdle(world, h, b, f);
}

/** Attack pings bias raids: rival Flags there, else structures, else units, else go look. */
function raidPing(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): boolean {
  let ping = -1;
  let px = 0;
  let pz = 0;
  let bestD = Infinity;
  for (const p of world.pings.values()) {
    if (p.faction !== f || p.kind !== 'attack' || p.until <= world.time || p.bornAt <= b.answeredAt) continue;
    const d2 = (p.pos.x - h.pos.x) ** 2 + (p.pos.z - h.pos.z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      ping = p.id;
      px = p.pos.x;
      pz = p.pos.z;
    }
  }
  if (ping < 0) return false;
  const r = HIPPIE_AI.pingTargetRadius;
  const fl = rivalFlagNear(world, sys, h, f, px, pz, r);
  if (fl >= 0) {
    startPull(world, sys, h, b, fl);
    return true;
  }
  const structure = rivalStructureNear(world, f, px, pz, r);
  if (structure >= 0) {
    startTear(world, h, b, structure);
    return true;
  }
  const foe = nearestRivalUnit(world, sys, f, px, pz, r);
  if (foe >= 0) {
    startEngage(world, h, b, foe, px, pz);
    return true;
  }
  startRespond(world, sys, h, b, ping);
  return true;
}

function rivalStructureNear(world: World, f: FactionId, x: number, z: number, r: number): EntityId {
  const lat = world.lattice;
  let best = -1;
  let bestD = r * r;
  for (const p of world.pieces.values()) {
    if (p.faction === f || p.kind !== 'wall') continue;
    const e = lat.edges[p.edge];
    const cx = (lat.nodes[e.a].x + lat.nodes[e.b].x) / 2;
    const cz = (lat.nodes[e.a].z + lat.nodes[e.b].z) / 2;
    const d2 = (cx - x) ** 2 + (cz - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = p.id;
    }
  }
  for (const bd of world.buildings.values()) {
    if (bd.faction === f || bd.kind === 'hearth') continue;
    const d2 = (bd.pos.x - x) ** 2 + (bd.pos.z - z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = bd.id;
    }
  }
  return best;
}

/**
 * Guard duty around (ax, az): answer pings, engage intruders, pull rival Flags in our Survey
 * (home) or near the point (ordered), lend a hand on construction (home), clear a Flag off the
 * plan when the camp has no raiders (home), else patrol.
 */
function guard(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, ax: number, az: number, home: boolean): void {
  // A live capture threat at home takes priority over distant pings and maintenance.
  // An explicit defend order still guards only its ordered anchor.
  if (home) {
    const critical = pickFlag(world, sys, h, b, f, criticalFlags(world, sys, f), Infinity, CRITICAL_RANK_PENALTY);
    if (critical >= 0) {
      startPull(world, sys, h, b, critical);
      return;
    }
  }
  const foe = home ? findIntruder(world, sys, h, f) : nearestRivalUnit(world, sys, f, ax, az, ORDER_GUARD_RADIUS);
  if (foe >= 0) {
    startEngage(world, h, b, foe, ax, az);
    return;
  }
  const ping = home ? pingToAnswer(world, sys, h, b, f, true) : -1;
  if (ping >= 0) {
    if (b.task === 'respond' && b.target === ping) return;
    startRespond(world, sys, h, b, ping);
    return;
  }
  const fl = home
    ? pickFlag(world, sys, h, b, f, intruderFlags(world, sys, f), INTRUDER_FLAG_RANGE, 0)
    : rivalFlagNear(world, sys, h, f, ax, az, ORDER_PATROL_R + 4);
  if (fl >= 0) {
    startPull(world, sys, h, b, fl);
    return;
  }
  if (home) {
    if (b.task === 'build' || b.task === 'repair') {
      const cur = world.buildings.get(b.target);
      if (cur && cur.faction === f && (cur.built < 1 || needsRepair(world, cur))) return;
    }
    const bld = buildingNeedingHands(world, sys, h, f, HELP_RANGE);
    if (bld) {
      beginTask(world, h, b, bld.built >= 1 ? 'repair' : 'build');
      b.target = bld.id;
      setRim(b, bld, h);
      sys.helpers.set(bld.id, (sys.helpers.get(bld.id) ?? 0) + 1);
      return;
    }
  }
  if (home && clearPlanBlocker(world, sys, h, b, f)) return;
  if (b.task === 'patrol' && b.ax === ax && b.az === az) return;
  beginTask(world, h, b, 'patrol');
  b.ax = ax;
  b.az = az;
  // Home patrols stay inside the capture defender radius.
  b.patrolR = home ? HIPPIE_AI.patrolRadius - 3 : ORDER_PATROL_R;
  pickSpotAround(world, b, ax, az, b.patrolR * 0.4, b.patrolR);
}

/** Nearest unanswered SOS (if allowed, with room for responders) or rally ping in range. */
function pingToAnswer(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, sos: boolean): EntityId {
  let best = -1;
  let bestD = HIPPIE.sosRespondRadius * HIPPIE.sosRespondRadius;
  for (const p of world.pings.values()) {
    if (p.faction !== f || p.until <= world.time || p.bornAt <= b.answeredAt) continue;
    if (p.kind === 'sos') {
      if (!sos || p.from === h.id || ((sys.responders.get(p.id) ?? 0) >= HIPPIE_AI.sosResponders &&
          !(b.task === 'respond' && b.target === p.id))) continue;
    } else if (p.kind !== 'rally') continue;
    const d2 = (p.pos.x - h.pos.x) ** 2 + (p.pos.z - h.pos.z) ** 2;
    if (d2 < bestD) {
      bestD = d2;
      best = p.id;
    }
  }
  return best;
}

function decideOrder(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, order: HippieOrder): void {
  switch (order.kind) {
    case 'recruit': {
      const target = world.hippies.get(order.target);
      if (!target || !canRecruit(target) || target.carryingFlag !== -1 || target.carryingLumber > 0) finishOrder(world, h, b);
      else if (h.carryingLumber > 0) startDeliver(world, h, b, f, 'haul');
      else if (h.carryingFlag !== -1) {
        beginTask(world, h, b, 'recruit');
        b.target = target.id;
      } else {
        // Recruitment uses real owned stock, not an enemy Flag or a virtual token.
        const hearth = hearthWithStock(world, sys, f, h.pos.x, h.pos.z, b);
        if (!hearth) finishOrder(world, h, b);
        else {
          beginTask(world, h, b, 'fetchStock');
          b.target = hearth.id;
          setRim(b, hearth, h);
          sys.fetchers.set(hearth.id, (sys.fetchers.get(hearth.id) ?? 0) + 1);
        }
      }
      return;
    }
    case 'move':
      beginTask(world, h, b, 'goto');
      b.px = order.to.x;
      b.pz = order.to.z;
      return;
    case 'pull': {
      const fl = world.flags.get(order.flagId);
      if (!fl || (fl.state !== 'planted' && fl.state !== 'loose')) finishOrder(world, h, b);
      else if (h.carryingLumber > 0) startDeliver(world, h, b, f, 'haul');
      else if (h.carryingFlag !== -1) startDeliver(world, h, b, f, 'stow');
      else if (claimedByOther(sys.flagClaims, fl.id, h.id)) startIdle(world, h, b, f);
      else startPull(world, sys, h, b, fl.id);
      return;
    }
    case 'plant': {
      const node = order.node;
      if (world.survey.nodeFlag[node] >= 0 || !canPlantAt(world, node, f)) finishOrder(world, h, b);
      else if (claimedByOther(sys.nodeReservations, node, h.id)) startIdle(world, h, b, f);
      else if (h.carryingLumber > 0) startDeliver(world, h, b, f, 'haul');
      else if (h.carryingFlag !== -1) startPlant(world, sys, h, b, node);
      else if (!startFetch(world, sys, h, b, f, node)) finishOrder(world, h, b);
      return;
    }
    case 'gather': {
      const pile = world.piles.get(order.pileId);
      if (h.carryingLumber > 0) startDeliver(world, h, b, f, 'haul');
      else if (h.carryingFlag !== -1) startDeliver(world, h, b, f, 'stow');
      else if (!pile || pile.lumber <= 0) finishOrder(world, h, b);
      else startChop(world, sys, h, b, pile);
      return;
    }
    case 'defend':
      if (h.carryingFlag !== -1) startDeliver(world, h, b, f, 'stow');
      else if (h.carryingLumber > 0) startDeliver(world, h, b, f, 'haul');
      else guard(world, sys, h, b, f, order.at.x, order.at.z, false);
      return;
    case 'attack': {
      const id = order.target;
      const owner = structureOwner(world, id);
      const fl = world.flags.get(id);
      if (owner !== undefined) {
        if (owner === f) finishOrder(world, h, b);
        else startTear(world, h, b, id);
      } else if (fl) {
        if ((fl.state === 'planted' || fl.state === 'loose') && fl.owner !== f) {
          if (h.carryingLumber > 0) startDeliver(world, h, b, f, 'haul');
          else if (h.carryingFlag !== -1) startDeliver(world, h, b, f, 'stow');
          else if (claimedByOther(sys.flagClaims, fl.id, h.id)) startIdle(world, h, b, f);
          else startPull(world, sys, h, b, fl.id);
        }
        else finishOrder(world, h, b);
      } else if (rivalUnitPos(world, f, id, scratch)) startEngage(world, h, b, id, NaN, NaN);
      else finishOrder(world, h, b);
      return;
    }
    case 'follow':
      if (b.task !== 'follow') beginTask(world, h, b, 'follow');
      return;
    case 'push':
      beginTask(world, h, b, 'push');
      b.target = order.gccId;
      return;
  }
}

/** The order is done (or impossible): back to the job pool. */
export function finishOrder(world: World, h: Hippie, b: Brain): void {
  h.order = null;
  releaseTask(world, h, b);
}

function claimedByOther(claims: Map<number, EntityId>, target: number, id: EntityId): boolean {
  const claim = claims.get(target);
  return claim !== undefined && claim !== id;
}

function claimFlag(sys: UnitsState, h: Hippie, b: Brain, flagId: EntityId): void {
  b.flag = flagId;
  sys.flagClaims.set(flagId, h.id);
}

function reserveNode(sys: UnitsState, h: Hippie, b: Brain, node: number): void {
  if (node < 0) return;
  b.node = node;
  sys.nodeReservations.set(node, h.id);
}

/** Approach spot on a building's rim, on the hippie's side. */
export function setRim(b: Brain, bld: LogisticsTarget, h: Hippie): void {
  if (bld.kind === 'car') { b.px=bld.servicePoint.x; b.pz=bld.servicePoint.z; return; }
  const dx = h.pos.x - bld.pos.x;
  const dz = h.pos.z - bld.pos.z;
  const d = Math.hypot(dx, dz);
  const r = BUILDINGS[bld.kind].radius + RIM_GAP;
  b.px = bld.pos.x + (d > 1e-3 ? dx / d : 0) * r;
  b.pz = bld.pos.z + (d > 1e-3 ? dz / d : 1) * r;
}

/** Random walkable spot in the ring [r0, r1] around (cx, cz), written to b.px/b.pz. */
export function pickSpotAround(world: World, b: Brain, cx: number, cz: number, r0: number, r1: number): void {
  for (let i = 0; i < 4; i++) {
    const a = world.rng.range(0, TAU);
    const r = world.rng.range(r0, r1);
    b.px = cx + Math.sin(a) * r;
    b.pz = cz + Math.cos(a) * r;
    if (world.nav.isWalkable(b.px, b.pz)) return;
  }
}

export function startPlant(world: World, sys: UnitsState, h: Hippie, b: Brain, node: number): void {
  beginTask(world, h, b, 'plant');
  reserveNode(sys, h, b, node);
}

function startPull(world: World, sys: UnitsState, h: Hippie, b: Brain, flagId: EntityId): void {
  beginTask(world, h, b, 'pull');
  claimFlag(sys, h, b, flagId);
}

/** Head home to stow a carried Flag ('stow') or deliver lumber ('haul'). */
function startDeliver(world: World, h: Hippie, b: Brain, f: FactionId, task: 'stow' | 'haul'): void {
  beginTask(world, h, b, task);
  const home = deliveryHearth(world, h, b, f);
  if (!home) {
    // Keep the cargo while routes are unavailable; retry after the failed home's cooldown.
    if (nearestHearth(world, f, h.pos)) {
      startIdle(world, h, b, f);
      let retryAt = Infinity;
      for (const id of world.factions[f].hearthIds) {
        const until = b.avoidBuildings.get(id);
        if (until !== undefined && until > world.time) retryAt = Math.min(retryAt, until);
      }
      b.waitUntil = b.nextThinkAt = Number.isFinite(retryAt) ? retryAt : world.time + 1;
    }
    return;
  }
  b.target = home.id;
  setRim(b, home, h);
}

function startChop(world: World, sys: UnitsState, h: Hippie, b: Brain, pile: Pile): void {
  beginTask(world, h, b, 'chop');
  b.target = pile.id;
  sys.choppers.set(pile.id, (sys.choppers.get(pile.id) ?? 0) + 1);
}

function startDrum(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  beginTask(world, h, b, 'drum');
  if (!claimDrumSlot(world, sys, h, b, f)) startIdle(world, h, b, f);
}

export function startEngage(world: World, h: Hippie, b: Brain, foe: EntityId, ax: number, az: number): void {
  beginTask(world, h, b, 'engage');
  b.target = foe;
  b.ax = ax;
  b.az = az;
}

function startRespond(world: World, sys: UnitsState, h: Hippie, b: Brain, ping: EntityId): void {
  beginTask(world, h, b, 'respond');
  b.target = ping;
  sys.responders.set(ping, (sys.responders.get(ping) ?? 0) + 1);
}

export function startTear(world: World, h: Hippie, b: Brain, structure: EntityId): void {
  beginTask(world, h, b, 'tear');
  b.target = structure;
}

function startIdle(world: World, h: Hippie, b: Brain, f: FactionId): void {
  if (b.task === 'idle') return;
  beginTask(world, h, b, 'idle');
  const home = nearestHearth(world, f, h.pos);
  if (home) pickSpotAround(world, b, home.pos.x, home.pos.z, IDLE_R0, IDLE_R1);
  else {
    b.px = h.pos.x;
    b.pz = h.pos.z;
  }
}

export function startFlee(world: World, h: Hippie, b: Brain): void {
  beginTask(world, h, b, 'flee');
  b.fleeUntil = world.time + HIPPIE_AI.fleeTime;
}
