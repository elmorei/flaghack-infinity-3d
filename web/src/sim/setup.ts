import { matchSettings } from "./matchSettings";
/**
 * Match setup: map, lattice, physics, nav, factions, four corner camps (Hearth + GCC +
 * avatar + hippies + stock + home ring), lumber piles, neutral hippies.
 * Owner: SurveyRules agent (initial version by the orchestrator).
 *
 * Every camp starts with a closed home ring of planted Flags whose Survey encloses the Hearth
 * and the parked GCC. Ring candidates come from the shared planner (planRing, then
 * planEnclosure); each is verified with the real Survey geometry before planting, and the
 * outline of the facets around the Hearth is the last resort.
 */
import {
  AVATAR,
  BUILDINGS,
  CAMP_CENTERS,
  HIPPIE,
  IMPLIED_MAX_ORDER,
  PILE_MAX,
  PILE_MIN,
  START_CARRIED_FLAGS,
  START_HOME_RING_RADIUS,
  TIDE_INTERVAL,
} from './constants';
import { createFaction, spawnAvatar, spawnBuilding, spawnFlag, spawnHippie, spawnPile } from './factory';
import { computeEnclosure, computeHolders, computeLeyLines } from './lattice/geometry';
import { Lattice } from './lattice/lattice';
import { planEnclosure, planRing } from './lattice/planner';
import type { NodeCost } from './lattice/planner';
import { generateMap } from './map/mapgen';
import { dist2, distToSegment } from './math';
import { NavGrid } from './nav/navgrid';
import { CollisionWorld } from './physics/collision';
import { setupTrainingBurn } from './scenarios/tutorial';
import { registerBuildingShape } from './systems/buildings';
import { canPlantAt, plantFlag } from './systems/flags';
import { geometryOwners, updateSurvey } from './systems/survey';
import { FACTION_IDS } from './types';
import type { Building, FactionId, MatchOptions } from './types';
import { createSurveyState, World } from './world';

/**
 * The GCC parks this far from the Hearth toward the map centre, swung GCC_PARK_ANGLE aside so
 * the vexillomancer's opening shot down the centre line is not blocked by the cart.
 */
const GCC_PARK_DISTANCE = 8;
const GCC_PARK_ANGLE = Math.PI / 3;
/** Clearance between the Hearth's and the GCC's footprints. */
const GCC_CLEARANCE = 1.5;
/** The parked GCC keeps this much air between its footprint and the opening camera shot. */
const SHOT_CLEARANCE = 1.2;
/** Hippies gather on this circle around the Hearth, inside the ring. */
const HIPPIE_CIRCLE = 6.5;
/**
 * The vexillomancer starts this far from the Hearth toward the map centre, so the action
 * camera's boom (~6.5 m behind it) opens in front of the camp, not inside the Hearth's flagpole.
 */
const AVATAR_START_DISTANCE = 11;
/** Home ring radii tried in order (planner rings, then the facet-outline fallback). */
const RING_RADII = [START_HOME_RING_RADIUS, START_HOME_RING_RADIUS - 2, START_HOME_RING_RADIUS + 3, START_HOME_RING_RADIUS + 6];
/** planEnclosure fallback: loop between these distances from the Hearth. */
const RING_MIN_RADIUS = 8;
const RING_MAX_RADIUS = 30;

export function createMatch(options: MatchOptions): World {
  const world = new World(options);
  const map = generateMap(options.seed);
  world.map = map;
  world.lattice = Lattice.generate(options.seed, { isBlockedAt: map.isBlockedAt, edge: matchSettings(options).gridScale });
  world.collision = CollisionWorld.fromMap(map);
  world.nav = NavGrid.fromMap(map);
  world.survey = createSurveyState(world.lattice);
  world.tide.nextAt = TIDE_INTERVAL;

  for (const f of FACTION_IDS) {
    world.factions.push(createFaction(f, options.humans.includes(f), options.difficulty));
  }
  for (const f of FACTION_IDS) {
    if (matchSettings(options).active.includes(f)) setupCamp(world, f);
    else world.factions[f].alive = false;
  }

  for (const spot of map.pileSpots) {
    spawnPile(world, world.rng.chance(0.55) ? 'pallets' : 'moop', spot, world.rng.int(PILE_MIN, PILE_MAX));
  }
  const remaining = matchSettings(options).maxSignifiers - world.hippies.size;
  for (let i = 0; i < remaining; i++) {
    const at = map.neutralSpawns[i % map.neutralSpawns.length] ?? { x: 0, z: 0 };
    const spot = world.nav.nearestWalkable(at.x + world.rng.range(-3, 3), at.z + world.rng.range(-3, 3));
    spawnHippie(world, -1, spot);
  }
  if (options.mode === 'tutorial') setupTrainingBurn(world);
  updateSurvey(world, 0);
  // Setup is not play: renderers/UI build their first frame from World state, so the burst of
  // planting and ley-line events (and the planting stats) from the home rings is discarded.
  world.drainEvents();
  for (const fac of world.factions) fac.stats.flagsPlanted = 0;
  return world;
}

/** Thick facet nearest to a point whose corner nodes are all unblocked. */
export function nearestBuildableFacet(world: World, x: number, z: number, exclude: Set<number> = new Set()): number {
  const lat = world.lattice;
  let best = -1;
  let bestD = Infinity;
  for (const f of lat.facets) {
    if (!f.thick || f.boundary || exclude.has(f.id)) continue;
    if (f.nodes.some((n) => lat.nodes[n].blocked)) continue;
    const d = (f.cx - x) ** 2 + (f.cz - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = f.id;
    }
  }
  return best;
}

function setupCamp(world: World, f: FactionId): void {
  const fac = world.factions[f];
  const c = CAMP_CENTERS[f];
  fac.lumber = matchSettings(world.options).startingLumber;
  // Unit vector from the camp toward the map centre (the effigy).
  const toCentre = Math.hypot(c.x, c.z);
  const dirX = -c.x / toCentre;
  const dirZ = -c.z / toCentre;

  const hearth = spawnBuilding(world, 'hearth', f, nearestBuildableFacet(world, c.x, c.z), 1);

  // The ring is planted before the GCC parks, so the GCC can choose a facet inside it.
  const enclosed = plantHomeRing(world, f, hearth);
  const gcc = spawnBuilding(world, 'gcc', f, gccFacet(world, hearth, dirX, dirZ, enclosed), 1);
  registerBuildingShape(world, hearth);
  registerBuildingShape(world, gcc);

  const avatarAt = clearSpot(world, hearth, gcc, Math.atan2(dirZ, dirX), AVATAR_START_DISTANCE, AVATAR.radius);
  const av = spawnAvatar(world, f, avatarAt);
  // Face the effigy at the map centre (yaw 0 = +z).
  av.yaw = Math.atan2(-av.pos.x, -av.pos.z);
  av.input.yaw = av.yaw;

  for (let i = 0; i < matchSettings(world.options).startingFlags; i++) {
    spawnFlag(world, { state: 'stock', owner: f, holder: hearth.id, pos: { x: hearth.pos.x, y: 0, z: hearth.pos.z } });
  }
  for (let i = 0; i < START_CARRIED_FLAGS; i++) {
    const fl = spawnFlag(world, { state: 'carried', owner: f, holder: av.id, pos: { ...av.pos } });
    av.carried.push(fl.id);
  }

  // Hippies circle the Hearth inside the ring, starting half a step away from the GCC.
  const gccAngle = Math.atan2(gcc.pos.z - hearth.pos.z, gcc.pos.x - hearth.pos.x);
  for (let i = 0; i < matchSettings(world.options).startingSignifiers; i++) {
    const a = gccAngle + ((i + 0.5) / Math.max(1, matchSettings(world.options).startingSignifiers)) * Math.PI * 2;
    spawnHippie(world, f, clearSpot(world, hearth, gcc, a, HIPPIE_CIRCLE, HIPPIE.radius));
  }
}

/**
 * Plant a closed home ring for `f` around its Hearth with fresh Flags. Returns the facets the
 * ring encloses (per facet: 1 = inside), or null when no candidate ring encloses the Hearth.
 */
function plantHomeRing(world: World, f: FactionId, hearth: Building): Uint8Array | null {
  const lat = world.lattice;
  const { x, z } = hearth.pos;
  // Free nodes cost 1; blocked, occupied and building-corner nodes are impassable.
  const cost: NodeCost = (n) => (canPlantAt(world, n, f) ? 1 : Infinity);
  const candidates: (() => number[] | null)[] = [
    ...RING_RADII.map((r) => () => planRing(lat, x, z, r, cost)),
    () => planEnclosure(lat, { x, z, minRadius: RING_MIN_RADIUS, maxRadius: RING_MAX_RADIUS, cost }),
    ...RING_RADII.map((r) => () => facetOutline(world, x, z, r)),
  ];
  for (const candidate of candidates) {
    const ring = candidate();
    if (!ring || ring.length < 3 || !ring.every((n) => canPlantAt(world, n, f))) continue;
    const enclosed = enclosureWith(world, f, ring);
    if (enclosed[hearth.facet] !== 1) continue;
    for (const node of ring) {
      const n = lat.nodes[node];
      const fl = spawnFlag(world, { state: 'stock', owner: f, holder: hearth.id, pos: { x: n.x, y: 0, z: n.z } });
      // A Flag that cannot be planted simply stays in stock (conservation holds).
      plantFlag(world, fl.id, node, f, -1);
    }
    return enclosed;
  }
  return null;
}

/** Facets `f` would enclose if it also held `ring` (real Survey geometry, implied Flags included). */
function enclosureWith(world: World, f: FactionId, ring: number[]): Uint8Array {
  const lat = world.lattice;
  const owner = Int8Array.from(geometryOwners(world));
  for (const n of ring) owner[n] = f;
  const holder = new Int8Array(lat.nodes.length);
  const impliedOwner = new Int8Array(lat.nodes.length);
  const impliedOrder = new Uint8Array(lat.nodes.length);
  const ley = new Int8Array(lat.edges.length);
  const enclosed = new Uint8Array(lat.facets.length);
  computeHolders(lat, owner, holder, impliedOwner, impliedOrder, IMPLIED_MAX_ORDER);
  computeLeyLines(lat, holder, ley);
  computeEnclosure(lat, ley, f, enclosed);
  return enclosed;
}

/**
 * Last-resort ring: the outline nodes of the patch of facets whose centres lie within `r` of
 * (x, z). Holding every outline node puts a Ley Line on each outline edge, sealing the patch.
 */
function facetOutline(world: World, x: number, z: number, r: number): number[] {
  const lat = world.lattice;
  const inside = new Uint8Array(lat.facets.length);
  for (const fc of lat.facets) if (dist2(fc.cx, fc.cz, x, z) <= r * r) inside[fc.id] = 1;
  const outline = new Set<number>();
  for (const e of lat.edges) {
    let n = 0;
    for (const id of e.facets) n += inside[id];
    if (n === 1) {
      outline.add(e.a);
      outline.add(e.b);
    }
  }
  return [...outline];
}

/**
 * Thick facet for the GCC, as near as possible to the parking point GCC_PARK_DISTANCE out
 * along (toX, toZ) swung GCC_PARK_ANGLE aside, with free corners and clear of the Hearth's
 * footprint. It should also sit inside the home Survey and off the opening camera shot (the
 * line from the Hearth out to where the vexillomancer stands); when no facet manages both,
 * the camera wish gives way first, then the Survey wish.
 */
function gccFacet(world: World, hearth: Building, toX: number, toZ: number, enclosed: Uint8Array | null): number {
  const lat = world.lattice;
  const s = world.survey;
  const { x: hx, z: hz } = hearth.pos;
  const cos = Math.cos(GCC_PARK_ANGLE);
  const sin = Math.sin(GCC_PARK_ANGLE);
  const tx = hx + (toX * cos - toZ * sin) * GCC_PARK_DISTANCE;
  const tz = hz + (toX * sin + toZ * cos) * GCC_PARK_DISTANCE;
  const minSep = BUILDINGS.hearth.radius + BUILDINGS.gcc.radius + GCC_CLEARANCE;
  const shotClear = BUILDINGS.gcc.radius + SHOT_CLEARANCE;
  const shotFar = AVATAR_START_DISTANCE + 1;
  for (const [inside, offShot] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    let best = -1;
    let bestD = Infinity;
    for (const fc of lat.facets) {
      if (!fc.thick || fc.boundary || fc.id === hearth.facet) continue;
      if (inside && enclosed && enclosed[fc.id] !== 1) continue;
      if (dist2(fc.cx, fc.cz, hx, hz) < minSep * minSep) continue;
      if (offShot && distToSegment(fc.cx, fc.cz, hx, hz, hx + toX * shotFar, hz + toZ * shotFar) < shotClear) continue;
      if (fc.nodes.some((n) => lat.nodes[n].blocked || s.nodeFlag[n] >= 0)) continue;
      const d = dist2(fc.cx, fc.cz, tx, tz);
      if (d < bestD) {
        bestD = d;
        best = fc.id;
      }
    }
    if (best >= 0) return best;
  }
  return nearestBuildableFacet(world, tx, tz, new Set([hearth.facet]));
}

/**
 * A walkable spot `dist` from the Hearth at roughly `angle` (radians, x/z plane) whose circle
 * of `radius` overlaps no building or obstacle; sweeps around in 30° steps if the first is
 * taken, and falls back to the nearest walkable cell.
 */
function clearSpot(world: World, hearth: Building, gcc: Building, angle: number, dist: number, radius: number): { x: number; z: number } {
  const clearGcc = BUILDINGS.gcc.radius + radius + 0.6;
  for (let i = 0; i < 12; i++) {
    const a = angle + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 6);
    const x = hearth.pos.x + Math.cos(a) * dist;
    const z = hearth.pos.z + Math.sin(a) * dist;
    if (dist2(x, z, gcc.pos.x, gcc.pos.z) < clearGcc * clearGcc || !world.nav.isWalkable(x, z)) continue;
    if (world.collision.blockedCircle(x, z, radius, 0.1, AVATAR.height)) continue;
    return { x, z };
  }
  return world.nav.nearestWalkable(hearth.pos.x + Math.cos(angle) * dist, hearth.pos.z + Math.sin(angle) * dist);
}
