/**
 * Target selection for hippie behaviours: Hearths, Flags to fetch or pull, plan nodes, the
 * rival Flags that matter (critical loop Flags, Hearth threats, Survey boundaries, intruders),
 * rival units, piles, Drum Circle slots and buildings that need hands. Lists derived from the
 * Survey are cached per survey version.
 */
import { BUILDINGS, CAPTURE, DRUMMERS_PER_CIRCLE, HIPPIE, HIPPIE_AI, IMPLIED_MAX_ORDER } from '../../constants';
import { criticalNodes } from '../../lattice/geometry';
import type { V2 } from '../../math';
import { FACTION_IDS, NEUTRAL } from '../../types';
import type { Building, EntityId, FactionId, Flag, Hippie, Owner, Pile } from '../../types';
import type { World } from '../../world';
import { isFlagProtected } from '../abilities';
import { canPlantAt } from '../flags';
import { activeScenery } from '../sceneryBenefits';
import { getDepot, depotHolder, depotStock, vehicleCapacity } from '../sceneryDepots';
import type { DepotTarget } from '../sceneryDepots';
export type LogisticsTarget = Building | DepotTarget;
export function logisticsTarget(world: World, id: number, at?: V2): LogisticsTarget | undefined { return world.buildings.get(id) ?? getDepot(world, id, at); }
export function logisticsRadius(b: LogisticsTarget): number { return b.kind === 'car' ? 0 : BUILDINGS[b.kind].radius; }
export function atLogistics(h: Hippie, b: LogisticsTarget, reach: number): boolean { return b.kind === 'car' ? Math.hypot(h.pos.x-b.servicePoint.x,h.pos.z-b.servicePoint.z) <= reach : atBuilding(h,b,reach); }
import { geometryOwners } from '../survey';
import { brainOf } from './brain';
import type { Brain } from './brain';
import type { UnitsState } from './state';

/** Loose Flags above this height (decks) are out of a hippie's reach. */
export const HIPPIE_REACH_Y = 1;
/** Rival vexillomancers standing higher than this (on decks) cannot be shoved or chased. */
const AVATAR_REACH_Y = 1.5;
/** Gatherers already on a pile count as this many metres of extra walk. */
const CROWD_PENALTY = 12;
const MAX_HELPERS = 2;
/** Buildings below this share of max HP get repair help. */
const REPAIR_BELOW = 0.98;

/** Nearest own Hearth whose stock is not already spoken for by hippies walking to it. */
export function hearthWithStock(world: World, sys: UnitsState, f: FactionId, x: number, z: number, brain?: Brain): LogisticsTarget | null {
  if (brain) pruneAvoidBuildings(world, brain);
  let best: LogisticsTarget | null = null;
  let bestD = Infinity;
  for (const hb of world.buildings.values()) {
    if (hb.faction !== f || (hb.kind !== 'hearth' && hb.kind !== 'workshop') || hb.built < 1) continue;
    const id = hb.id;
    if (world.time < (brain?.avoidBuildings.get(id) ?? 0)) continue;
    if ((sys.stockByHearth.get(id) ?? 0) - (sys.fetchers.get(id) ?? 0) <= 0) continue;
    const d2 = (hb.pos.x - x) * (hb.pos.x - x) + (hb.pos.z - z) * (hb.pos.z - z);
    if (d2 < bestD) {
      bestD = d2;
      best = hb;
    }
  }
  for (const o of activeScenery(world, 'car', f)) {
    const id = depotHolder(o.id);
    if (world.time < (brain?.avoidBuildings.get(id) ?? 0) || depotStock(world,id) - (sys.fetchers.get(id) ?? 0) <= 0) continue;
    const depot = getDepot(world,id,{x,z}); if (!depot) continue;
    const d2 = (depot.servicePoint.x-x)**2+(depot.servicePoint.z-z)**2;
    if (d2 < bestD) { bestD=d2; best=depot; }
  }
  return best;
}

/** Nearest completed own Hearth that has not recently proved unreachable. */
export function deliveryHearth(world: World, h: Hippie, b: Brain, f: FactionId): LogisticsTarget | undefined {
  pruneAvoidBuildings(world, b);
  let best: LogisticsTarget | undefined;
  let bestD = Infinity;
  for (const id of world.factions[f].hearthIds) {
    const home = world.buildings.get(id);
    if (!home || home.faction !== f || home.kind !== 'hearth' || home.built < 1 || world.time < (b.avoidBuildings.get(id) ?? 0)) continue;
    const d2 = (home.pos.x - h.pos.x) ** 2 + (home.pos.z - h.pos.z) ** 2;
    if (d2 < bestD) { best = home; bestD = d2; }
  }
  for (const o of activeScenery(world, 'car', f)) {
    const id=depotHolder(o.id);
    if (world.time < (b.avoidBuildings.get(id) ?? 0) || (h.carryingFlag !== -1 && depotStock(world,id) >= vehicleCapacity(o))) continue;
    const depot=getDepot(world,id,h.pos); if (!depot) continue;
    const d2=(depot.servicePoint.x-h.pos.x)**2+(depot.servicePoint.z-h.pos.z)**2;
    if(d2<bestD) {bestD=d2;best=depot;}
  }
  return best;
}

/** Buildings can disappear during an unlimited match; failed-route memory stays bounded. */
function pruneAvoidBuildings(world: World, b: Brain): void {
  for (const [id, until] of b.avoidBuildings) {
    if (until <= world.time || logisticsTarget(world, id)?.faction !== b.faction) b.avoidBuildings.delete(id);
  }
}

/** Within `reach` metres of a building's edge. */
export function atBuilding(h: Hippie, b: Building, reach: number): boolean {
  const r = BUILDINGS[b.kind].radius + reach;
  const dx = h.pos.x - b.pos.x;
  const dz = h.pos.z - b.pos.z;
  return dx * dx + dz * dz <= r * r;
}

/** Nearest unclaimed loose own-or-neutral Flag on the ground within r (decohered ones too). */
export function nearestLooseFlag(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, r: number): Flag | null {
  let best: Flag | null = null;
  let bestD = r * r;
  for (const fl of sys.looseFlags) {
    if (fl.state !== 'loose' || (fl.owner !== f && fl.owner !== NEUTRAL) || fl.pos.y - world.collision.groundHeight(fl.pos.x, fl.pos.z) > HIPPIE_REACH_Y) continue;
    if (fl.id === b.avoidFlag && world.time < b.avoidUntil) continue;
    const claim = sys.flagClaims.get(fl.id);
    if (claim !== undefined && claim !== h.id) continue;
    const d2 = (fl.pos.x - h.pos.x) * (fl.pos.x - h.pos.x) + (fl.pos.z - h.pos.z) * (fl.pos.z - h.pos.z);
    if (d2 < bestD) {
      bestD = d2;
      best = fl;
    }
  }
  return best;
}

/** Nearest unfilled, unreserved, plantable node of the faction's Survey plan. */
export function pickPlanNode(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): number {
  const lat = world.lattice;
  const nodeFlag = world.survey.nodeFlag;
  let best = -1;
  let bestD = Infinity;
  for (const n of world.factions[f].plan) {
    if (n < 0 || n >= lat.nodes.length || nodeFlag[n] >= 0) continue;
    if (n === b.avoidNode && world.time < b.avoidUntil) continue;
    const r = sys.nodeReservations.get(n);
    if (r !== undefined && r !== h.id) continue;
    const node = lat.nodes[n];
    const d2 = (node.x - h.pos.x) * (node.x - h.pos.x) + (node.z - h.pos.z) * (node.z - h.pos.z);
    if (d2 >= bestD || !canPlantAt(world, n, f)) continue;
    bestD = d2;
    best = n;
  }
  return best;
}

/** Rival Flags on critical nodes of every loop enclosing one of our Hearths (cheapest first). */
export function criticalFlags(world: World, sys: UnitsState, f: FactionId): EntityId[] {
  const s = world.survey;
  const out = sys.criticalFlags[f];
  if (sys.criticalVersion[f] === s.version) return out;
  sys.criticalVersion[f] = s.version;
  out.length = 0;
  // Real owners with orphaned Flags marked, as the Survey itself computes implied Flags.
  let owners: Int8Array | null = null;
  for (const hid of world.factions[f].hearthIds) {
    const hb = world.buildings.get(hid);
    if (!hb || hb.faction !== f) continue;
    const facet = hb.hearth ? hb.hearth.facet : hb.facet;
    for (const e of FACTION_IDS) {
      if (e === f || !world.inSurvey(facet, e)) continue;
      owners ??= geometryOwners(world);
      for (const n of criticalNodes(world.lattice, owners, e, facet, IMPLIED_MAX_ORDER)) {
        const id = s.nodeFlag[n];
        if (id >= 0 && !out.includes(id)) out.push(id);
      }
    }
  }
  return out;
}

/** Rival Flags within the Hearth threat radius of our Hearths. */
export function threatFlags(world: World, sys: UnitsState, f: FactionId): EntityId[] {
  const s = world.survey;
  const out = sys.threatFlags[f];
  if (sys.threatVersion[f] === s.version) return out;
  sys.threatVersion[f] = s.version;
  out.length = 0;
  const near = sys.nodeScratch;
  for (const hid of world.factions[f].hearthIds) {
    const hb = world.buildings.get(hid);
    if (!hb || hb.faction !== f) continue;
    near.length = 0;
    world.lattice.nodesInRadius(hb.pos.x, hb.pos.z, CAPTURE.threatRadius, near);
    for (const n of near) {
      const owner = s.nodeFlagOwner[n];
      const id = s.nodeFlag[n];
      if (owner >= 0 && owner !== f && id >= 0 && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Flags of faction `e` on the boundary of its own Survey (ley lines with outside on one side). */
export function boundaryFlags(world: World, sys: UnitsState, e: FactionId): EntityId[] {
  const s = world.survey;
  const out = sys.boundaryFlags[e];
  if (sys.boundaryVersion[e] === s.version) return out;
  sys.boundaryVersion[e] = s.version;
  out.length = 0;
  const lat = world.lattice;
  const bit = 1 << e;
  for (let n = 0; n < lat.nodes.length; n++) {
    const id = s.nodeFlag[n];
    if (s.nodeFlagOwner[n] !== e || id < 0) continue;
    for (const ed of lat.nodes[n].edges) {
      if (s.edgeLey[ed] !== e) continue;
      const fs = lat.edges[ed].facets;
      const inA = fs.length > 0 && (s.facetSurvey[fs[0]] & bit) !== 0;
      const inB = fs.length > 1 && (s.facetSurvey[fs[1]] & bit) !== 0;
      if (inA !== inB) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/** Rival Flags planted on nodes that touch our Survey. */
export function intruderFlags(world: World, sys: UnitsState, f: FactionId): EntityId[] {
  const s = world.survey;
  const out = sys.intruderFlags[f];
  if (sys.intruderVersion[f] === s.version) return out;
  sys.intruderVersion[f] = s.version;
  out.length = 0;
  const lat = world.lattice;
  for (let n = 0; n < lat.nodes.length; n++) {
    const owner = s.nodeFlagOwner[n];
    const id = s.nodeFlag[n];
    if (owner < 0 || owner === f || id < 0) continue;
    for (const fc of lat.nodes[n].facets) {
      if (world.inSurvey(fc, f)) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/**
 * Best pullable rival Flag from `list` within maxDist: nearest, with `rankPenalty` metres per
 * list position (lists are priority-ordered), unclaimed by others, not Stabilize-protected.
 */
export function pickFlag(
  world: World,
  sys: UnitsState,
  h: Hippie,
  b: Brain,
  f: FactionId,
  list: readonly EntityId[],
  maxDist: number,
  rankPenalty: number,
): EntityId {
  let best = -1;
  let bestScore = maxDist;
  for (let i = 0; i < list.length; i++) {
    const fl = world.flags.get(list[i]);
    if (!fl || fl.state !== 'planted' || fl.owner === f || fl.owner === NEUTRAL) continue;
    if (fl.id === b.avoidFlag && world.time < b.avoidUntil) continue;
    const claim = sys.flagClaims.get(fl.id);
    if (claim !== undefined && claim !== h.id) continue;
    const score = Math.hypot(fl.pos.x - h.pos.x, fl.pos.z - h.pos.z) + i * rankPenalty;
    if (score >= bestScore || isFlagProtected(world, fl)) continue;
    bestScore = score;
    best = fl.id;
  }
  return best;
}

/**
 * Pullable Flags of other camps (rival or orphaned) planted on nodes of `f`'s Survey plan.
 * Planners route loops through rival Flag chains ("pull, then plant"), so these must come out
 * before the plan can close. Stabilize-protected Flags are left out: nobody can pull them.
 */
export function planBlockers(world: World, sys: UnitsState, f: FactionId): EntityId[] {
  const out = sys.planBlockers[f];
  if (sys.planBlockersTick[f] === world.tick) return out;
  sys.planBlockersTick[f] = world.tick;
  out.length = 0;
  const nodeFlag = world.survey.nodeFlag;
  const count = world.lattice.nodes.length;
  for (const n of world.factions[f].plan) {
    if (n < 0 || n >= count) continue;
    const id = nodeFlag[n];
    if (id < 0 || out.includes(id)) continue;
    const fl = world.flags.get(id);
    if (fl && fl.owner !== f && !isFlagProtected(world, fl)) out.push(id);
  }
  return out;
}

/**
 * Plan blocker for this hippie to pull: least walk plus distance to the nearest other own
 * Survey hippie, so pulls unblock the front the camp is actually planting.
 */
export function pickPlanBlocker(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): EntityId {
  let best = -1;
  let bestScore = Infinity;
  for (const id of planBlockers(world, sys, f)) {
    const fl = world.flags.get(id);
    if (!fl || fl.state !== 'planted' || fl.owner === f) continue;
    if (fl.id === b.avoidFlag && world.time < b.avoidUntil) continue;
    const claim = sys.flagClaims.get(fl.id);
    if (claim !== undefined && claim !== h.id) continue;
    let front = Infinity;
    for (const o of sys.active) {
      if (o === h || o.faction !== f || o.job !== 'survey') continue;
      front = Math.min(front, (o.pos.x - fl.pos.x) ** 2 + (o.pos.z - fl.pos.z) ** 2);
    }
    const score = Math.hypot(fl.pos.x - h.pos.x, fl.pos.z - h.pos.z) + (front === Infinity ? 0 : Math.sqrt(front));
    if (score >= bestScore) continue;
    bestScore = score;
    best = fl.id;
  }
  return best;
}

/** Nearest unclaimed rival planted Flag within r of a point. */
export function rivalFlagNear(world: World, sys: UnitsState, h: Hippie, f: FactionId, x: number, z: number, r: number): EntityId {
  const s = world.survey;
  const near = sys.nodeScratch;
  near.length = 0;
  world.lattice.nodesInRadius(x, z, r, near);
  let best = -1;
  let bestD = Infinity;
  for (const n of near) {
    const owner = s.nodeFlagOwner[n];
    const id = s.nodeFlag[n];
    if (owner < 0 || owner === f || id < 0) continue;
    const claim = sys.flagClaims.get(id);
    if (claim !== undefined && claim !== h.id) continue;
    const node = world.lattice.nodes[n];
    const d2 = (node.x - x) * (node.x - x) + (node.z - z) * (node.z - z);
    if (d2 >= bestD) continue;
    const fl = world.flags.get(id);
    if (!fl || isFlagProtected(world, fl)) continue;
    bestD = d2;
    best = id;
  }
  return best;
}

/**
 * Write the position of a live rival unit (hippie of another camp or reachable vexillomancer)
 * into `out`. Returns false when `id` is not one.
 */
export function rivalUnitPos(world: World, f: FactionId, id: EntityId, out: V2): boolean {
  const h = world.hippies.get(id);
  if (h) {
    if (h.status === 'ko' || h.faction === f || h.faction === NEUTRAL) return false;
    out.x = h.pos.x;
    out.z = h.pos.z;
    return true;
  }
  const av = world.avatars.get(id);
  if (!av || av.faction === f || av.koUntil > 0 || av.pos.y - world.collision.groundHeight(av.pos.x, av.pos.z) > AVATAR_REACH_Y) return false;
  out.x = av.pos.x;
  out.z = av.pos.z;
  return true;
}

/** Nearest live rival unit within r of (x, z), or -1. */
export function nearestRivalUnit(world: World, sys: UnitsState, f: FactionId, x: number, z: number, r: number): EntityId {
  let best = -1;
  let bestD = r * r;
  const items = sys.hash.items;
  const n = sys.hash.query(x, z, r, sys.near);
  for (let i = 0; i < n; i++) {
    const o = items[sys.near[i]];
    if (o.faction === f || o.faction === NEUTRAL || o.status === 'ko') continue;
    const d2 = (o.pos.x - x) * (o.pos.x - x) + (o.pos.z - z) * (o.pos.z - z);
    if (d2 < bestD) {
      bestD = d2;
      best = o.id;
    }
  }
  for (const av of world.avatars.values()) {
    if (av.faction === f || av.koUntil > 0 || av.pos.y - world.collision.groundHeight(av.pos.x, av.pos.z) > AVATAR_REACH_Y) continue;
    const d2 = (av.pos.x - x) * (av.pos.x - x) + (av.pos.z - z) * (av.pos.z - z);
    if (d2 < bestD) {
      bestD = d2;
      best = av.id;
    }
  }
  return best;
}

/** Ground the camp defends: near one of our Hearths or inside our Survey. */
function guarded(world: World, f: FactionId, x: number, z: number): boolean {
  const r2 = HIPPIE_AI.intruderRadius * HIPPIE_AI.intruderRadius;
  for (const id of world.factions[f].hearthIds) {
    const hb = world.buildings.get(id);
    if (hb?.faction === f && (hb.pos.x - x) * (hb.pos.x - x) + (hb.pos.z - z) * (hb.pos.z - z) <= r2) return true;
  }
  return world.inSurvey(world.lattice.facetAt(x, z), f);
}

/** Nearest rival unit within sight that stands near our Hearth or inside our Survey. */
export function findIntruder(world: World, sys: UnitsState, h: Hippie, f: FactionId): EntityId {
  const sight = HIPPIE.sightRadius;
  let best = -1;
  let bestD = sight * sight;
  const items = sys.hash.items;
  const n = sys.hash.query(h.pos.x, h.pos.z, sight, sys.near);
  for (let i = 0; i < n; i++) {
    const o = items[sys.near[i]];
    if (o.faction === f || o.faction === NEUTRAL || o.status === 'ko') continue;
    const d2 = (o.pos.x - h.pos.x) * (o.pos.x - h.pos.x) + (o.pos.z - h.pos.z) * (o.pos.z - h.pos.z);
    if (d2 >= bestD || !guarded(world, f, o.pos.x, o.pos.z)) continue;
    bestD = d2;
    best = o.id;
  }
  for (const av of world.avatars.values()) {
    if (av.faction === f || av.koUntil > 0 || av.pos.y - world.collision.groundHeight(av.pos.x, av.pos.z) > AVATAR_REACH_Y) continue;
    const d2 = (av.pos.x - h.pos.x) * (av.pos.x - h.pos.x) + (av.pos.z - h.pos.z) * (av.pos.z - h.pos.z);
    if (d2 >= bestD || !guarded(world, f, av.pos.x, av.pos.z)) continue;
    bestD = d2;
    best = av.id;
  }
  return best;
}

/** Owner of a piece or building, or undefined when `id` is neither. */
export function structureOwner(world: World, id: EntityId): Owner | undefined {
  const p = world.pieces.get(id);
  if (p) return p.faction;
  return world.buildings.get(id)?.faction;
}

/** Nearest pile with lumber, avoiding crowded ones. */
export function pickPile(world: World, sys: UnitsState, h: Hippie): Pile | null {
  let best: Pile | null = null;
  let bestScore = Infinity;
  for (const p of world.piles.values()) {
    if (p.lumber <= 0) continue;
    const score = Math.hypot(p.pos.x - h.pos.x, p.pos.z - h.pos.z) + (sys.choppers.get(p.id) ?? 0) * CROWD_PENALTY;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

export function needsRepair(world: World, b: Building): boolean {
  if (b.built < 1 || (b.gcc && b.gcc.destroyedUntil > world.time)) return false;
  return b.disabled || b.hp < b.maxHp * REPAIR_BELOW;
}

/** Nearest own building (within reach of the camp) under construction or needing repair. */
export function buildingNeedingHands(world: World, sys: UnitsState, h: Hippie, f: FactionId, maxDist: number): Building | null {
  let best: Building | null = null;
  let bestD = maxDist * maxDist;
  for (const b of world.buildings.values()) {
    if (b.faction !== f || (b.built >= 1 && !needsRepair(world, b))) continue;
    if ((sys.helpers.get(b.id) ?? 0) >= MAX_HELPERS) continue;
    const d2 = (b.pos.x - h.pos.x) * (b.pos.x - h.pos.x) + (b.pos.z - h.pos.z) * (b.pos.z - h.pos.z);
    if (d2 < bestD) {
      bestD = d2;
      best = b;
    }
  }
  return best;
}

/**
 * Claim the nearest free Drum Circle slot for the hippie (slots whose drummer wandered off are
 * reclaimed). Sets b.target / b.slot; returns false when every circle is full.
 */
export function claimDrumSlot(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): boolean {
  let bestId = -1;
  let bestSlots: Int32Array | null = null;
  let bestSlot = -1;
  let bestD = Infinity;
  for (const c of sys.drumCircles[f]) {
    let slots = sys.drumSlots.get(c.id);
    if (!slots) {
      slots = new Int32Array(DRUMMERS_PER_CIRCLE).fill(-1);
      sys.drumSlots.set(c.id, slots);
    }
    for (let s = 0; s < slots.length; s++) {
      const occ = slots[s];
      if (occ !== -1 && occ !== h.id) {
        const o = world.hippies.get(occ);
        if (o && o.status !== 'ko' && brainOf(o).task === 'drum' && brainOf(o).target === c.id) continue;
        slots[s] = -1;
      }
      const d2 = (c.pos.x - h.pos.x) * (c.pos.x - h.pos.x) + (c.pos.z - h.pos.z) * (c.pos.z - h.pos.z);
      if (d2 < bestD) {
        bestD = d2;
        bestId = c.id;
        bestSlots = slots;
        bestSlot = s;
      }
      break;
    }
  }
  if (!bestSlots) return false;
  bestSlots[bestSlot] = h.id;
  b.target = bestId;
  b.slot = bestSlot;
  return true;
}
