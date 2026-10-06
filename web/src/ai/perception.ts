/**
 * Perception: what one faction knows, refreshed at ≤ 2 Hz. Everything physical is public
 * (Flags, buildings, pieces, piles, Crystals, Hearth stages and pressure); rival units are
 * seen only within SIGHT of our own units and buildings, or anywhere while their D.E.G.E.N.
 * mesh is tapped. Rival enclosure loops are planned here, one per tick across all factions
 * (see Scheduler), and cached between Survey changes.
 * Owner: AI agent.
 */
import { ABILITY, CAPTURE, GCC, IMPLIED_MAX_ORDER, LIGHTNING_PULL_MULT, WARD_PULSE_RADIUS } from '../sim/constants';
import { criticalNodes } from '../sim/lattice/geometry';
import { planEnclosure } from '../sim/lattice/planner';
import type { NodeCost } from '../sim/lattice/planner';
import { isFlagProtected } from '../sim/systems/abilities';
import { popCap, population } from '../sim/systems/economy';
import { RECRUIT_RADIUS } from '../sim/constants';
import { canPlantAt, flagPullDefender, isBuildingCorner } from '../sim/systems/flags';
import { geometryOwners } from '../sim/systems/survey';
import { FACTION_IDS, NEUTRAL } from '../sim/types';
import type { Building, EntityId, FactionId, Hippie } from '../sim/types';
import type { World } from '../sim/world';
import type { Brain, RivalIntel } from './brain';

/** Rival units are visible within this of any own unit or building. */
export const SIGHT = 45;
/** Loose Flags this close to home count as Flags in hand. */
const LOOSE_RANGE = 60;
/** Intruders: rival hippies inside our Survey or this close to our Hearth. */
const INTRUDER_RADIUS = 26;
/**
 * Assault walls keep at least LOOP_MIN_RADIUS from the target Hearth (outside its buildings)
 * and at most LOOP_MAX_RADIUS. Nodes inside the target's threat radius (CAPTURE.threatRadius)
 * cost NEAR_COST more: Flags there are "threat Flags" for their raiders, so the planner only
 * comes that close when the long way round costs more.
 */
export const LOOP_MIN_RADIUS = 17;
const LOOP_MAX_RADIUS = 66;
const NEAR_COST = 0.25;
/** Fallback band for fortress camps where the usual one holds no loop (m). */
const WIDE_MIN_RADIUS = 10;
const WIDE_MAX_RADIUS = 100;
/** After planning found no loop at all, the rival is not planned again for this long (s). */
const LOOP_RETRY = 6;
/** Planner cost of a node touching the target's Survey: their home guards pull intruding Flags
 * there, but going all the way round a sprawling camp costs more than it saves. */
const IN_THEIR_SURVEY_COST = 0.25;
/**
 * Planner cost of a loop node held by a target (or ownerless) Flag: pulling it, then a Flag of
 * ours. Another rival's Flag costs more: tearing at a third camp's ring makes a second enemy.
 */
const BREACH_COST = 3;
const THIRD_PARTY_COST = 4;
/** Extra planner cost of a node a Phason Shift could flip out of the loop. */
const FLIPPABLE_COST = 0.3;
/** Loop refresh age (s): the current target is replanned more eagerly than the others. */
const TARGET_REPLAN = 3;
const RIVAL_REPLAN = 9;
/** A rival's home Hearth counts this much farther than its outposts; the Hearth already under
 * siege is kept until another scores better by this factor. */
const HOME_HEARTH_WEIGHT = 1.5;
const KEEP_TARGET = 1.3;
/** With one rival left its home Hearth counts this much nearer than its outposts. */
const LAST_HOME_WEIGHT = 0.5;
/** A Hearth no loop could be planned around is passed over for this long after the failure
 * (s), by counting this many times farther. */
const UNREACHABLE_FOR = 60;
const UNREACHABLE_WEIGHT = 10;

/**
 * One heavy planning job (an enclosure plan) per tick across every NPC brain of a world. The
 * host drives one controller per AI seat, so the budget lives with the world (world.scratch,
 * clean for every match) rather than with a controller: four single-seat controllers then
 * split it exactly like the brains of one four-seat controller do.
 */
export class Scheduler {
  private usedTick = -1;
  take(world: World): boolean {
    if (this.usedTick === world.tick) return false;
    this.usedTick = world.tick;
    return true;
  }
}

export function schedulerOf(world: World): Scheduler {
  const s = world.scratch.aiScheduler;
  if (s instanceof Scheduler) return s;
  const fresh = new Scheduler();
  world.scratch.aiScheduler = fresh;
  return fresh;
}

export function perceive(b: Brain, sched: Scheduler): void {
  const world = b.world;
  const f = b.f;
  const v = b.view;
  const s = world.survey;
  v.at = world.time;
  const hearth = world.hearthOf(f);
  if (!hearth || !hearth.hearth) return;
  v.hearthId = hearth.id;
  v.hx = hearth.pos.x;
  v.hz = hearth.pos.z;
  v.facet = hearth.facet;
  v.homeIntact = world.inSurvey(hearth.facet, f);

  // Threats to the home Hearth. Outposts are expendable: the camp (buildings, stock, Drum
  // Circles) lives here, and a vexillomancer running to every outpost loses its own sieges;
  // a lost outpost is simply besieged back.
  const hs = hearth.hearth;
  let pressure = 0;
  v.enclosers.length = 0;
  for (const e of FACTION_IDS) {
    if (e === f) continue;
    pressure = Math.max(pressure, hs.pressure[e]);
    if (world.factions[e].alive && world.inSurvey(hearth.facet, e)) v.enclosers.push(e);
  }
  v.stage = hs.stage;
  v.pressure = pressure;
  // A loop that just closed around us takes a moment to notice (difficulty's reaction delay):
  // until then nobody knows which rival Flags hold it.
  const enclosed = v.enclosers.length > 0;
  if (enclosed && !b.wasEnclosed) b.noticeAt = world.time + b.skill.react;
  b.wasEnclosed = enclosed;
  if (!enclosed || world.time < b.noticeAt) {
    v.critical.length = 0;
    v.criticalVersion = -1;
  } else if (v.criticalVersion !== s.version) {
    v.criticalVersion = s.version;
    v.critical.length = 0;
    const owners = geometryOwners(world);
    for (const e of v.enclosers) {
      for (const n of criticalNodes(world.lattice, owners, e, hearth.facet, IMPLIED_MAX_ORDER)) {
        const id = s.nodeFlag[n];
        if (id >= 0 && !v.critical.includes(id)) v.critical.push(id);
      }
    }
  }

  // Economy.
  const fac = world.factions[f];
  const av = world.avatarOf(f);
  v.stock = world.stockCount(f);
  v.carried = av.carried.length;
  v.lumber = fac.lumber;
  v.ritual = fac.ritual;
  v.population = population(world, f);
  v.popCap = popCap(world, f);
  let loose = 0;
  for (const fl of world.flags.values()) {
    if (fl.state !== 'loose' || (fl.owner !== f && fl.owner !== NEUTRAL)) continue;
    if ((fl.pos.x - v.hx) ** 2 + (fl.pos.z - v.hz) ** 2 <= LOOSE_RANGE * LOOSE_RANGE) loose++;
  }
  v.looseNear = loose;

  senseUnits(b, world, hearth);
  senseRivals(b, world, sched);
}

/** Rival and neutral units this faction can see right now. */
function senseUnits(b: Brain, world: World, hearth: Building): void {
  const f = b.f;
  const v = b.view;
  const fac = world.factions[f];
  const av = world.avatarOf(f);
  const observers = b.observers;
  observers.length = 0;
  if (av.koUntil <= world.time) observers.push(av.pos);
  for (const h of world.hippies.values()) if (h.faction === f && h.koUntil <= world.time) observers.push(h.pos);
  for (const bd of world.buildings.values()) if (bd.faction === f) observers.push(bd.pos);

  const gcc = world.gccOf(f);
  const omegaR = ABILITY.omega.radius[Math.max(0, fac.chakras.finial - 1)];
  v.intruders.length = 0;
  v.neutralsNearGcc.length = 0;
  v.visibleNeutrals.length = 0;
  v.rivalsNearGcc = 0;
  v.rivalsNearAvatar = 0;
  for (const h of world.hippies.values()) {
    if (h.faction === f || h.koUntil > world.time) continue;
    if (h.faction === NEUTRAL) {
      if (visible(world, f, h, observers)) v.visibleNeutrals.push(h.id);
      if (gcc && (h.pos.x - gcc.pos.x) ** 2 + (h.pos.z - gcc.pos.z) ** 2 <= RECRUIT_RADIUS * RECRUIT_RADIUS) v.neutralsNearGcc.push(h.id);
      continue;
    }
    if (!visible(world, f, h, observers)) continue;
    const dh2 = (h.pos.x - hearth.pos.x) ** 2 + (h.pos.z - hearth.pos.z) ** 2;
    const facet = world.lattice.facetAt(h.pos.x, h.pos.z);
    if (dh2 <= INTRUDER_RADIUS * INTRUDER_RADIUS || world.inSurvey(facet, f)) v.intruders.push(h.id);
    if (gcc && (h.pos.x - gcc.pos.x) ** 2 + (h.pos.z - gcc.pos.z) ** 2 <= GCC.dialecticsRadius * GCC.dialecticsRadius) v.rivalsNearGcc++;
    if ((h.pos.x - av.pos.x) ** 2 + (h.pos.z - av.pos.z) ** 2 <= omegaR * omegaR) v.rivalsNearAvatar++;
  }
}

function visible(world: World, f: FactionId, h: Hippie, observers: readonly { x: number; z: number }[]): boolean {
  const owner = h.faction;
  if (owner !== NEUTRAL && (world.factions[f].meshTap[owner] ?? 0) > world.time) return true;
  for (const o of observers) if ((o.x - h.pos.x) ** 2 + (o.z - h.pos.z) ** 2 <= SIGHT * SIGHT) return true;
  return false;
}

/** Public facts about every rival, and (budgeted) the loop we would close around each. */
function senseRivals(b: Brain, world: World, sched: Scheduler): void {
  const f = b.f;
  const s = world.survey;
  const planted = [0, 0, 0, 0];
  for (let n = 0; n < s.nodeFlagOwner.length; n++) {
    const o = s.nodeFlagOwner[n];
    if (o >= 0) planted[o]++;
  }
  const prev = b.view.rivals;
  const next: RivalIntel[] = [];
  let rivalsAlive = 0;
  for (const e of FACTION_IDS) if (e !== f && world.factions[e].alive) rivalsAlive++;
  for (const e of FACTION_IDS) {
    if (e === f) continue;
    const fac = world.factions[e];
    const old = prev.find((r) => r.id === e);
    // A Hearth no loop could be planned around lately is passed over for another of theirs.
    const avoid = old && world.time < old.unreachableUntil ? old.unreachableHearth : -1;
    const h = targetHearth(world, e, b.view.hx, b.view.hz, old?.hearthId ?? -1, avoid, rivalsAlive === 1);
    const intel: RivalIntel = old ?? {
      id: e,
      alive: false,
      hearthId: -1,
      hx: 0,
      hz: 0,
      facet: -1,
      stage: 'safe',
      attacker: null,
      ourPressure: 0,
      homeIntact: true,
      planted: 0,
      loop: null,
      loopCost: Infinity,
      loopAt: -Infinity,
      homeCritical: [],
      homeCriticalVersion: -1,
      ourCritical: [],
      ourCriticalVersion: -1,
      outer: null,
      outerAt: -Infinity,
      closedOnce: false,
      keystones: [],
      loopRetryAt: 0,
      unreachableHearth: -1,
      unreachableUntil: 0,
      crowd: 0,
      wide: false,
    };
    intel.alive = fac.alive && !!h && !!h.hearth;
    intel.planted = planted[e];
    if (!h || !h.hearth || !intel.alive) {
      intel.loop = null;
      intel.outer = null;
      intel.loopCost = Infinity;
      next.push(intel);
      continue;
    }
    if (intel.hearthId !== h.id) {
      intel.loop = null;
      intel.outer = null;
      intel.loopAt = -Infinity;
    }
    intel.hearthId = h.id;
    intel.hx = h.pos.x;
    intel.hz = h.pos.z;
    intel.facet = h.facet;
    intel.stage = h.hearth.stage;
    intel.attacker = h.hearth.attacker;
    intel.ourPressure = h.hearth.pressure[f];
    intel.homeIntact = world.inSurvey(h.facet, e);
    // Flags of third camps in the band where a siege wall would stand: someone else is
    // already walling them in, and two walls on the same ground only fight each other.
    let crowd = 0;
    const lat = world.lattice;
    for (let n = 0; n < s.nodeFlagOwner.length; n++) {
      const o = s.nodeFlagOwner[n];
      if (o < 0 || o === f || o === e) continue;
      const d2 = (lat.nodes[n].x - h.pos.x) ** 2 + (lat.nodes[n].z - h.pos.z) ** 2;
      if (d2 >= LOOP_MIN_RADIUS * LOOP_MIN_RADIUS && d2 <= LOOP_MAX_RADIUS * LOOP_MAX_RADIUS) crowd++;
    }
    intel.crowd = crowd;
    next.push(intel);
  }
  b.view.rivals = next;

  // Refresh at most one rival loop per tick: an invalid target loop first, then the stalest.
  let pick: RivalIntel | null = null;
  let pickAge = 0;
  for (const r of next) {
    if (!r.alive) continue;
    const age = world.time - r.loopAt;
    const isTarget = r.id === b.target;
    let due: boolean;
    if (!r.loop) due = world.time >= r.loopRetryAt;
    else if (isTarget) {
      // A wall half built stays put while it can still be finished; it is replanned when it
      // cannot, or when every node stands yet the Hearth is open (a flip moved the line).
      const fresh = newFlags(world, f, r.loop);
      const open = fresh === 0 && !world.inSurvey(r.facet, f);
      due = !loopValid(world, f, r.loop) || (age >= TARGET_REPLAN && (open || fresh * 2 > r.loop.length));
    } else due = age >= RIVAL_REPLAN;
    if (!due) continue;
    const urgency = Math.min(age, 1e6) + (isTarget ? 1e7 : 0);
    if (!pick || urgency > pickAge) {
      pick = r;
      pickAge = urgency;
    }
  }
  if (pick && sched.take(world)) planLoop(b, pick);
  if (b.target !== null) refreshHomeCritical(b, world, b.target);
}

/**
 * The rival Hearth worth besieging: outposts before the home camp (its buildings lie broken
 * and their vexillomancer can only hold one Hearth), nearer before farther. With one rival
 * left (`last`) the home camp comes first: outposts only change hands back and forth while it
 * stands. The one we are already working on is kept unless another is clearly better;
 * `avoid` (no loop could be planned around it lately) is only chosen when it is their last.
 */
function targetHearth(world: World, e: FactionId, x: number, z: number, current: EntityId, avoid: EntityId, last: boolean): Building | undefined {
  const ids = world.factions[e].hearthIds;
  let best: Building | undefined;
  let bestScore = Infinity;
  let kept: Building | undefined;
  let keptScore = Infinity;
  const home = last ? LAST_HOME_WEIGHT : HOME_HEARTH_WEIGHT;
  for (let i = 0; i < ids.length; i++) {
    const h = world.buildings.get(ids[i]);
    if (!h || !h.hearth) continue;
    const score = Math.hypot(h.pos.x - x, h.pos.z - z) * (i === 0 ? home : 1) * (h.id === avoid ? UNREACHABLE_WEIGHT : 1);
    if (score < bestScore) {
      best = h;
      bestScore = score;
    }
    if (h.id === current && h.id !== avoid) {
      kept = h;
      keptScore = score;
    }
  }
  return kept && keptScore <= bestScore * KEEP_TARGET ? kept : best;
}

/** Can every node of this loop still be ours (held already, free to plant, or breachable)? */
function loopValid(world: World, f: FactionId, loop: readonly number[]): boolean {
  const s = world.survey;
  for (const n of loop) if (s.nodeFlagOwner[n] !== f && s.holder[n] !== f && !claimable(world, f, n)) return false;
  return true;
}

/**
 * Could `f` get a Flag onto this node: plant it now, or pull the rival (or orphaned) Flag
 * standing there first? Stabilize-held Flags and Crystal nodes are out; building corners
 * follow the match placement setting.
 */
export function claimable(world: World, f: FactionId, n: number): boolean {
  if (canPlantAt(world, n, f)) return true;
  const s = world.survey;
  const id = s.nodeFlag[n];
  if (id < 0 || s.nodeFlagOwner[n] === f || world.lattice.nodes[n].blocked || (world.options.match?.structuresBlockFlagPlacement === true && isBuildingCorner(world, n))) return false;
  const fl = world.flags.get(id);
  if (!fl || fl.altNode >= 0 || isFlagProtected(world, fl)) return false;
  for (const c of world.crystals.values()) if (c.node === n) return false;
  return true;
}

/**
 * Plan (or replan) our cheapest loop around a rival's Hearth. When the usual band holds no
 * loop (a fortress of buildings and Stabilized Flags), the next slot tries a wide band; when
 * that fails too the Hearth is passed over for a while and the rival rests for LOOP_RETRY. A
 * replan that finds nothing keeps the old loop while it can still be finished.
 */
export function planLoop(b: Brain, r: RivalIntel): void {
  const world = b.world;
  r.loopAt = world.time;
  const loop = planEnclosure(world.lattice, {
    x: r.hx,
    z: r.hz,
    minRadius: r.wide ? WIDE_MIN_RADIUS : LOOP_MIN_RADIUS,
    maxRadius: r.wide ? WIDE_MAX_RADIUS : LOOP_MAX_RADIUS,
    cost: assaultCost(world, b.f, r),
  });
  if (loop) {
    r.loop = loop;
    r.loopCost = newFlags(world, b.f, loop);
    return;
  }
  if (r.loop && !loopValid(world, b.f, r.loop)) {
    r.loop = null;
    r.loopCost = Infinity;
  }
  if (!r.wide) {
    r.wide = true;
    r.loopRetryAt = world.time;
    return;
  }
  r.wide = false;
  r.loopRetryAt = world.time + LOOP_RETRY;
  r.unreachableHearth = r.hearthId;
  r.unreachableUntil = world.time + UNREACHABLE_FOR;
}

/** Loop nodes we still have to plant. */
export function newFlags(world: World, f: FactionId, loop: readonly number[]): number {
  const s = world.survey;
  let n = 0;
  for (const node of loop) if (s.nodeFlagOwner[node] !== f && s.holder[node] !== f) n++;
  return n;
}

/**
 * Node cost for an assault wall: our Flags are free, free plantable nodes cost a Flag plus a
 * risk premium (nodes a Phason Shift could flip, rival Ward pulses, their Survey where home
 * guards pull intruding Flags). A rival Flag in the way costs a pull and a Flag (rival rings
 * often run from the target's home out to the burn's fence, so blocking on them would leave
 * no loop at all); protected Flags and blocked nodes are impassable.
 */
export function assaultCost(world: World, f: FactionId, r: RivalIntel): NodeCost {
  const s = world.survey;
  const lat = world.lattice;
  const wards: Building[] = [];
  for (const bd of world.buildings.values()) if (bd.kind === 'ward' && bd.faction !== f && bd.faction !== NEUTRAL && bd.built >= 1 && !bd.disabled) wards.push(bd);
  const wardR2 = (WARD_PULSE_RADIUS + 3) ** 2;
  const bit = 1 << r.id;
  const near2 = CAPTURE.threatRadius * CAPTURE.threatRadius;
  return (n) => {
    if (s.nodeFlagOwner[n] === f) return 0;
    if (s.nodeFlag[n] < 0 && s.holder[n] === f) return 0;
    if (!claimable(world, f, n)) return Infinity;
    const node = lat.nodes[n];
    const owner = s.nodeFlagOwner[n];
    let c = s.nodeFlag[n] < 0 ? 1 : owner === r.id || owner < 0 ? BREACH_COST : THIRD_PARTY_COST;
    const flag = world.flags.get(s.nodeFlag[n]);
    if (flag && flagPullDefender(world, flag, f)) c += (BREACH_COST - 1) * (LIGHTNING_PULL_MULT - 1);
    // Three-edge nodes can be Phason Shifted out from under the loop.
    if (lat.flippable(n)) c += FLIPPABLE_COST;
    for (const w of wards) if ((w.pos.x - node.x) ** 2 + (w.pos.z - node.z) ** 2 <= wardR2) c += 0.6;
    if ((node.x - r.hx) ** 2 + (node.z - r.hz) ** 2 < near2) c += NEAR_COST;
    for (const fc of node.facets) {
      if (s.facetSurvey[fc] & bit) {
        c += IN_THEIR_SURVEY_COST;
        break;
      }
    }
    return c;
  };
}

/**
 * For the rival under assault: their Flags holding their own home loop (pull them to turn a
 * contest into containment), and ours holding the loop around their Hearth (guard them).
 */
function refreshHomeCritical(b: Brain, world: World, e: FactionId): void {
  const r = b.intel(e);
  const s = world.survey;
  if (!r || !r.alive || r.homeCriticalVersion === s.version) return;
  r.homeCriticalVersion = s.version;
  r.ourCriticalVersion = s.version;
  r.homeCritical.length = 0;
  r.ourCritical.length = 0;
  const owners = geometryOwners(world);
  if (r.homeIntact) {
    for (const n of criticalNodes(world.lattice, owners, e, r.facet, IMPLIED_MAX_ORDER)) {
      const id = s.nodeFlag[n];
      if (id >= 0) r.homeCritical.push(id);
    }
  }
  if (world.inSurvey(r.facet, b.f)) {
    for (const n of criticalNodes(world.lattice, owners, b.f, r.facet, IMPLIED_MAX_ORDER)) {
      const id = s.nodeFlag[n];
      if (id >= 0) r.ourCritical.push(id);
    }
  }
}
