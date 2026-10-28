/**
 * Survey planner: keeps the faction's plan (the Survey Pattern its hippies fill) in step with
 * the posture: mend the territory first, then the siege walls, the next lobe of territory or
 * a pentacle, never planning far more nodes than the camp has Flags for.
 * Owner: AI agent.
 */
import { pentacleOf } from '../sim/lattice/geometry';
import { planEnclosure } from '../sim/lattice/planner';
import { canPlantAt } from '../sim/systems/flags';
import type { World } from '../sim/world';
import type { Brain, RivalIntel } from './brain';
import { assaultCost, claimable, LOOP_MIN_RADIUS, newFlags } from './perception';
import type { Scheduler } from './perception';

/** Focus points within this of home are worth a pentacle. */
const PENTACLE_REACH = 45;
/** Plan at most this many nodes beyond the Flags in hand (hippies keep working while Flags come). */
const PLAN_SLACK = 4;
/** A replacement home ring keeps at least this far from the Hearth, may reach this far past the
 * old one, and is replanned at most this often. */
const HOME_MIN_RADIUS = 7;
const HOME_REPLAN_BAND = 12;
const HOME_REPLAN_EVERY = 6;
/** Planner cost of a home node a rival Flag squats on: pulling it, then a Flag of ours. */
const SQUATTER_COST = 3;
/**
 * Lobes grow the territory: loops centred LOBE_OUT beyond its edge in one of LOBE_DIRECTIONS
 * directions (the first towards the burn's centre, where the room is; camps sit in corners
 * against the fence), with nodes LOBE_MIN..LOBE_MAX from that centre, reusing our standing
 * Flags and asking at most LOBE_MAX_NEW new ones. Lobes keep LOBE_RIVAL_CLEAR from rival Hearths
 * (growing into a rival's threat radius is an attack, not an expansion).
 */
const LOBE_DIRECTIONS = 10;
const LOBE_OUT = 8;
const LOBE_MIN = 7;
const LOBE_MAX = 20;
const LOBE_MAX_NEW = 14;
const LOBE_RIVAL_CLEAR = 48;
/** After a full turn of directions found nothing, lobes rest this long (s). */
const LOBE_RETRY = 12;
/** Surplus Flags (or no room to build) let the territory outgrow its goal by this factor. */
const WIDE_TERRITORY = 2;
/** Second siege wall: Flags in hand to begin it, search band beyond the first, replan age (s),
 * and the longest it may be relative to the first. */
const OUTER_FLAGS = 24;
const OUTER_GAP = 5;
const OUTER_BAND = 30;
const OUTER_REPLAN = 10;
const OUTER_MAX_RATIO = 1.35;
/** Cost of borrowing a node of the first wall (it stays a single point of failure). */
const OUTER_SHARED = 4;
/** A siege whose walls are still not ready after this long closes with what it has (s). */
const SIEGE_PATIENCE = 100;
/** Keystones go in when the vexillomancer carries this many Flags within this of them. */
export const CLOSE_QUIVER = 5;
const CLOSE_RANGE = 35;

/** Record the home ring the camp starts with: our planted Flags around the Hearth. */
export function adoptHomeRing(b: Brain): void {
  const world = b.world;
  const v = b.view;
  const s = world.survey;
  const ring: number[] = [];
  let radius = 0;
  const lat = world.lattice;
  for (let n = 0; n < s.nodeFlagOwner.length; n++) {
    if (s.nodeFlagOwner[n] !== b.f) continue;
    const d = Math.hypot(lat.nodes[n].x - v.hx, lat.nodes[n].z - v.hz);
    if (d > 40) continue;
    ring.push(n);
    radius = Math.max(radius, d);
  }
  b.homeNodes = ring;
  b.homeRadius = radius;
}

/**
 * A broken home ring that re-planting cannot mend (a ring node pinned or flipped away, or
 * every node held yet the loop open after a phason flip): plan a fresh ring that reuses
 * every Flag still standing. Rival Flags squatting on it are not in the way: hippies pull
 * Flags off our plan nodes and plant ours.
 */
function replanHomeIfStuck(b: Brain, sched: Scheduler): void {
  const world = b.world;
  const v = b.view;
  let missing = 0;
  let stuck = false;
  for (const n of b.homeNodes) {
    if (held(world, b.f, n)) continue;
    if (claimable(world, b.f, n)) missing++;
    else stuck = true;
  }
  if ((!stuck && missing > 0) || world.time < b.homeReplanAt || !sched.take(world)) return;
  b.homeReplanAt = world.time + HOME_REPLAN_EVERY;
  const s = world.survey;
  const ring = planEnclosure(world.lattice, {
    x: v.hx,
    z: v.hz,
    minRadius: HOME_MIN_RADIUS,
    maxRadius: Math.max(b.homeRadius, HOME_MIN_RADIUS) + HOME_REPLAN_BAND,
    cost: (n) =>
      s.nodeFlagOwner[n] === b.f || (s.nodeFlag[n] < 0 && s.holder[n] === b.f) ? 0 : canPlantAt(world, n, b.f) ? 1 : claimable(world, b.f, n) ? SQUATTER_COST : Infinity,
  });
  if (!ring) return;
  b.homeNodes = ring;
  const lat = world.lattice;
  b.homeRadius = 0;
  for (const n of ring) b.homeRadius = Math.max(b.homeRadius, Math.hypot(lat.nodes[n].x - v.hx, lat.nodes[n].z - v.hz));
}

export function updatePlan(b: Brain, sched: Scheduler): void {
  const world = b.world;
  const f = b.f;
  const want: number[] = [];
  const add = (n: number): void => {
    if (!want.includes(n) && open(world, f, n)) want.push(n);
  };
  // Siege walls keep rival-held nodes in the plan: raiders pull the Flag, then hippies plant.
  const claim = (n: number): void => {
    if (!want.includes(n) && !held(world, f, n) && claimable(world, f, n)) want.push(n);
  };
  if (!b.view.homeIntact) replanHomeIfStuck(b, sched);
  for (const n of b.homeNodes) claim(n);

  // Hoarding is villainy (Tartaria fell to it): a stock past the camp's comfort drains every
  // hippie's attention, so surplus Flags go into the ground.
  const surplus = b.view.stock > b.persona.hoard;
  switch (b.posture) {
    case 'attack':
    case 'opportunist': {
      const r = b.target === null ? undefined : b.intel(b.target);
      if (r && r.loop) siegePlan(b, r, r.loop, sched, claim);
      break;
    }
    case 'expand':
      expansionNodes(b, sched, add, surplus);
      pentacleNodes(b, add);
      break;
    case 'economy':
      if (surplus) expansionNodes(b, sched, add, true);
      pentacleNodes(b, add);
      break;
    case 'defend':
      break;
  }

  const cap = Math.max(4, b.flagsInHand() + PLAN_SLACK);
  if (want.length > cap) want.length = cap;
  want.sort((a, c) => a - c);
  const sent = b.sentPlan;
  let same = sent.length === want.length && world.factions[f].plan.size === want.length;
  for (let i = 0; same && i < want.length; i++) if (sent[i] !== want[i]) same = false;
  if (same) return;
  b.sentPlan = want;
  world.submit({ t: 'plan', faction: f, op: 'set', nodes: want.slice() });
}

/** A node the camp should plant: not held by us yet (real or implied) and plantable now. */
function open(world: World, f: Brain['f'], n: number): boolean {
  const s = world.survey;
  return s.nodeFlagOwner[n] !== f && s.holder[n] !== f && canPlantAt(world, n, f);
}

function held(world: World, f: Brain['f'], n: number): boolean {
  return world.survey.nodeFlagOwner[n] === f || world.survey.holder[n] === f;
}

/** Does this node touch both our Survey and ground outside it (its Flag holds the edge)? */
export function onSurveyEdge(world: World, f: Brain['f'], n: number): boolean {
  let inside = false;
  let outside = false;
  for (const fc of world.lattice.nodes[n].facets) {
    if (world.inSurvey(fc, f)) inside = true;
    else outside = true;
  }
  return inside && outside;
}

/**
 * Siege plan: the first wall is built quietly with one keystone held back (the open node
 * nearest home, where the vexillomancer arrives first); once every other node stands and the
 * vexillomancer waits by it with Flags to mend the first breaks (or the siege has waited long
 * enough), it goes in. After the first closure every break is mended at once, and while the
 * first wall stands a second one rises behind it: two disjoint walls leave the defenders no
 * single critical Flag. A break in the first wall is always mended before the second gets
 * another Flag.
 */
function siegePlan(b: Brain, r: RivalIntel, inner: readonly number[], sched: Scheduler, claim: (n: number) => void): void {
  const world = b.world;
  const v = b.view;
  if (world.inSurvey(r.facet, b.f)) r.closedOnce = true;
  if (r.closedOnce) {
    r.keystones = [];
    for (const n of inner) claim(n);
    if (newFlags(world, b.f, inner) > 0) return;
    planSecondWall(b, r, inner, sched);
    if (r.outer) for (const n of r.outer) claim(n);
    return;
  }
  const lat = world.lattice;
  let key = -1;
  let best = Infinity;
  for (const n of inner) {
    // Breach nodes (a rival Flag still on them) cannot be the keystone.
    if (held(world, b.f, n) || !canPlantAt(world, n, b.f)) continue;
    const d = (lat.nodes[n].x - v.hx) ** 2 + (lat.nodes[n].z - v.hz) ** 2;
    if (d < best) {
      best = d;
      key = n;
    }
  }
  let waiting = 0;
  for (const n of inner) if (!held(world, b.f, n) && n !== key) waiting++;
  const av = world.avatarOf(b.f);
  let ready = !av || av.carried.length >= CLOSE_QUIVER;
  if (av && ready && key >= 0) ready = Math.hypot(lat.nodes[key].x - av.pos.x, lat.nodes[key].z - av.pos.z) <= CLOSE_RANGE;
  const closing = key < 0 || (waiting === 0 && ready) || world.time - b.assaultAt > SIEGE_PATIENCE;
  r.keystones = closing ? [] : [key];
  for (const n of inner) if (closing || n !== key) claim(n);
}

/**
 * A second wall around the target, ideally disjoint from the first (two disjoint walls leave
 * no critical Flag, so a raid must cut both). It may borrow a few nodes of the first where
 * the map leaves no room (a corner camp against the burn's fence), and is dropped when it
 * would be much longer than the first: a wall that never closes only feeds the defenders.
 */
function planSecondWall(b: Brain, r: RivalIntel, inner: readonly number[], sched: Scheduler): void {
  const world = b.world;
  if (b.flagsInHand() < OUTER_FLAGS) return;
  const stale =
    !r.outer ||
    r.outer.some((n) => !held(world, b.f, n) && !claimable(world, b.f, n)) ||
    (world.time - r.outerAt > OUTER_REPLAN && newFlags(world, b.f, r.outer) * 2 > r.outer.length);
  if (!stale || !sched.take(world)) return;
  const lat = world.lattice;
  let reach = 0;
  for (const n of inner) reach = Math.max(reach, Math.hypot(lat.nodes[n].x - r.hx, lat.nodes[n].z - r.hz));
  const innerSet = new Set(inner);
  const base = assaultCost(world, b.f, r);
  r.outerAt = world.time;
  const outer = planEnclosure(lat, {
    x: r.hx,
    z: r.hz,
    minRadius: LOOP_MIN_RADIUS,
    maxRadius: reach + OUTER_GAP + OUTER_BAND,
    cost: (n) => (innerSet.has(n) ? OUTER_SHARED : base(n)),
  });
  r.outer = outer && outer.length <= inner.length * OUTER_MAX_RATIO ? outer : null;
}

/**
 * Grow the territory one lobe at a time; a lobe fully held joins the territory the camp
 * mends. `wide` (Flags to burn) lets it outgrow the temperament's goal, as does a builder
 * with no room left.
 */
function expansionNodes(b: Brain, sched: Scheduler, add: (n: number) => void, wide: boolean): void {
  const world = b.world;
  const f = b.f;
  if (b.expansion) {
    if (newFlags(world, f, b.expansion) === 0) {
      for (const n of b.expansion) if (!b.homeNodes.includes(n)) b.homeNodes.push(n);
      b.expansion = null;
      // The lobe stands: the old edge it swallowed is now inside, and only Flags holding the
      // new edge are worth mending (or keeping buildings off). Judged only on whole ground.
      if (world.inSurvey(b.view.facet, f)) b.homeNodes = b.homeNodes.filter((n) => !held(world, f, n) || onSurveyEdge(world, f, n));
    } else if (b.expansion.some((n) => !held(world, f, n) && !canPlantAt(world, n, f))) {
      b.expansion = null;
    }
  }
  if (!b.expansion) {
    const goal = b.persona.territory * (wide || b.needsRoom ? WIDE_TERRITORY : 1);
    if (world.survey.surveySize[f] >= goal || world.time < b.lobeRetryAt || !sched.take(world)) return;
    b.expansion = planLobe(b);
    if (!b.expansion) return;
  }
  for (const n of b.expansion) add(n);
}

/** Try the next direction around the Hearth: a lobe that grows the territory there, or null. */
function planLobe(b: Brain): number[] | null {
  const world = b.world;
  const lat = world.lattice;
  const s = world.survey;
  const v = b.view;
  const f = b.f;
  const k = b.lobeTurn;
  b.lobeTurn = (k + 1) % LOBE_DIRECTIONS;
  // A full turn without a lobe: rest before trying again.
  if (b.lobeTurn === 0) b.lobeRetryAt = world.time + LOBE_RETRY;
  // Directions alternate either side of the burn's centre: 0, +1, -1, +2, -2, ...
  const step = (k + 1) >> 1;
  const a = Math.atan2(-v.hz, -v.hx) + (k % 2 === 1 ? step : -step) * ((2 * Math.PI) / LOBE_DIRECTIONS);
  const dx = Math.cos(a);
  const dz = Math.sin(a);
  let d = 4;
  for (; ; d += 2) {
    const facet = lat.facetAt(v.hx + dx * d, v.hz + dz * d);
    // The fence comes before the edge of our ground in this direction.
    if (facet < 0) return null;
    if (!world.inSurvey(facet, f)) break;
  }
  const cx = v.hx + dx * (d + LOBE_OUT);
  const cz = v.hz + dz * (d + LOBE_OUT);
  const centre = lat.facetAt(cx, cz);
  if (centre < 0 || world.inSurvey(centre, f)) return null;
  for (const r of v.rivals) if (r.alive && (r.hx - cx) ** 2 + (r.hz - cz) ** 2 < LOBE_RIVAL_CLEAR * LOBE_RIVAL_CLEAR) return null;
  const lobe = planEnclosure(lat, {
    x: cx,
    z: cz,
    minRadius: LOBE_MIN,
    maxRadius: LOBE_MAX,
    cost: (n) => (s.nodeFlagOwner[n] === f || s.holder[n] === f ? 0 : canPlantAt(world, n, f) ? 1 : Infinity),
  });
  if (!lobe) return null;
  const fresh = newFlags(world, f, lobe);
  if (fresh === 0 || fresh > LOBE_MAX_NEW) return null;
  // Found one: the next lobe starts a fresh turn of directions from here.
  b.lobeRetryAt = 0;
  return lobe;
}

/** The cheapest pentacle near home: a focus whose five neighbours we hold or can plant. */
function pentacleNodes(b: Brain, add: (n: number) => void): void {
  const world = b.world;
  const v = b.view;
  const lat = world.lattice;
  const s = world.survey;
  if (b.persona.crystals <= 0) return;
  let best = -1;
  let bestMissing = Infinity;
  for (const focus of s.focusNodes) {
    const node = lat.nodes[focus];
    if ((node.x - v.hx) ** 2 + (node.z - v.hz) ** 2 > PENTACLE_REACH * PENTACLE_REACH) continue;
    if (s.nodeFlag[focus] >= 0 && s.nodeFlagOwner[focus] !== b.f) continue;
    let crystal = false;
    for (const c of world.crystals.values()) if (c.node === focus) crystal = true;
    if (crystal) continue;
    let missing = 0;
    let feasible = true;
    for (const n of pentacleOf(lat, focus)) {
      if (held(world, b.f, n)) continue;
      if (!canPlantAt(world, n, b.f)) {
        feasible = false;
        break;
      }
      missing++;
    }
    if (!feasible || missing === 0) continue;
    if (missing < bestMissing) {
      best = focus;
      bestMissing = missing;
    }
  }
  b.pentacleFocus = best;
  if (best < 0 || bestMissing > 2 + Math.round(b.persona.crystals * 3)) return;
  for (const n of pentacleOf(lat, best)) add(n);
}
