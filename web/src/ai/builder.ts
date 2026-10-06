/**
 * Builder: the temperament's build order on Sun facets inside our Survey, Drug Lab brewing,
 * and Fortnite walls: a fort around the front Flag of an assault loop, and (once a camp has
 * been contained) around the home-ring Flags facing the rival who did it.
 * Owner: AI agent.
 */
import { BREW_COST, BUILDINGS, HIPPIE, PIECE } from '../sim/constants';
import { canPlaceBuilding } from '../sim/systems/buildings';
import { brewBlocker } from '../sim/systems/drugs';
import { canBuildPiece } from '../sim/systems/pieces';
import { DRUGS } from '../sim/types';
import type { BuildingKind, DrugId } from '../sim/types';
import type { World } from '../sim/world';
import type { Brain } from './brain';
import { onSurveyEdge } from './plans';

/** Buildings go on facets within this of the Hearth. */
const CAMP_RADIUS = 34;
/** Lumber kept back for walls while fighting. */
const WAR_RESERVE = 30;
/** Extra Workshops beyond the build order, and the lumber that triggers them. */
const MAX_WORKSHOPS = 2;
const RICH = 320;
/** Walls per fortified node per decision, and the lumber floor for building them. */
const WALLS_PER_PASS = 2;
const WALL_LUMBER = 50;

export function manageBuilds(b: Brain): void {
  placeNext(b);
  brew(b);
  fortify(b);
}

function count(world: World, b: Brain, kind: BuildingKind): number {
  return world.buildingsOf(b.f, kind).length;
}

/** Next building the temperament wants, or null. */
function nextKind(b: Brain): BuildingKind | null {
  const world = b.world;
  // Capacity is now an attention budget: expand it before buying optional upgrades.
  const circles = world.buildingsOf(b.f, 'drumcircle');
  const plannedCapacity = HIPPIE.popCapBase + circles.filter(c => !c.disabled).length * HIPPIE.popCapPerDrumCircle;
  if (b.view.population >= plannedCapacity - 1) return 'drumcircle';
  const seen: Partial<Record<BuildingKind, number>> = {};
  for (const kind of b.persona.buildOrder) {
    const need = (seen[kind] ?? 0) + 1;
    seen[kind] = need;
    if (count(world, b, kind) < need) return kind;
  }
  const v = b.view;
  if (v.lumber >= RICH && count(world, b, 'workshop') < MAX_WORKSHOPS) return 'workshop';
  return null;
}

function placeNext(b: Brain): void {
  const world = b.world;
  const v = b.view;
  const kind = nextKind(b);
  b.needsRoom = false;
  if (!kind) return;
  const reserve = b.posture === 'attack' || b.posture === 'defend' ? WAR_RESERVE : 0;
  if (v.lumber < BUILDINGS[kind].cost + reserve) return;
  // Prefer facets on the burn side of the Hearth, close in.
  const len = Math.hypot(v.hx, v.hz) || 1;
  const ix = v.hx - (v.hx / len) * 9;
  const iz = v.hz - (v.hz / len) * 9;
  const lat = world.lattice;
  const facets = lat.facetsInRadius(v.hx, v.hz, CAMP_RADIUS);
  facets.sort((a, c) => {
    const fa = lat.facets[a];
    const fc = lat.facets[c];
    return (fa.cx - ix) ** 2 + (fa.cz - iz) ** 2 - ((fc.cx - ix) ** 2 + (fc.cz - iz) ** 2) || a - c;
  });
  const plan = world.factions[b.f].plan;
  for (const facet of facets) {
    const fc = lat.facets[facet];
    if (!fc.thick || !world.inSurvey(facet, b.f)) continue;
    // A building pins its corners: never on a node holding the edge of our Survey or a planned
    // one, or a pulled Flag there could never be planted back.
    let pinsLoop = false;
    for (const n of fc.nodes) if (plan.has(n) || onSurveyEdge(world, b.f, n)) pinsLoop = true;
    if ((pinsLoop && world.options.match?.structuresBlockFlagPlacement === true) || !canPlaceBuilding(world, b.f, kind, facet).ok) continue;
    world.submit({ t: 'placeBuilding', faction: b.f, kind, facet });
    return;
  }
  // Nowhere inside the Survey fits it: the camp has to grow first.
  b.needsRoom = true;
}

/** Keep each Drug Lab busy: the temperament's drug first, then whatever the shelf lacks. */
function brew(b: Brain): void {
  const world = b.world;
  if (b.view.lumber < BREW_COST + WAR_RESERVE) return;
  const fac = world.factions[b.f];
  for (const lab of world.buildingsOf(b.f, 'druglab')) {
    if (!lab.lab || lab.lab.queue.length > 0 || lab.lab.brewing) continue;
    const order: DrugId[] = b.persona.assaultDrug ? [b.persona.assaultDrug, ...DRUGS] : [...DRUGS];
    for (const d of order) {
      if (fac.drugs[d] >= 2 || brewBlocker(world, b.f, lab.id, d) !== '') continue;
      world.submit({ t: 'brew', faction: b.f, labId: lab.id, drug: d });
      return;
    }
  }
}

/**
 * Walls on the link of a node (the edges around it that do not touch it) on the side facing
 * (tx, tz): raiders coming from there must tear them down before they can pull the Flag.
 */
function fortify(b: Brain): void {
  const world = b.world;
  const v = b.view;
  if (v.lumber < WALL_LUMBER) return;
  const lat = world.lattice;
  let node = -1;
  let tx = 0;
  let tz = 0;
  const r = b.target === null ? undefined : b.intel(b.target);
  if ((b.posture === 'attack' || b.posture === 'opportunist') && r && r.loop && r.attacker === b.f) {
    // The loop Flag nearest their Hearth is the one their pullers reach first.
    let best = Infinity;
    for (const n of r.loop) {
      const d = (lat.nodes[n].x - r.hx) ** 2 + (lat.nodes[n].z - r.hz) ** 2;
      if (d < best && world.survey.nodeFlagOwner[n] === b.f) {
        best = d;
        node = n;
      }
    }
    tx = r.hx;
    tz = r.hz;
  } else if (b.timesContained > 0 && b.persona.defend >= 1.2 && b.posture !== 'attack') {
    // Wardens remember: fortify the home-ring Flag facing the burn's centre.
    let best = Infinity;
    for (const n of b.homeNodes) {
      const d = lat.nodes[n].x ** 2 + lat.nodes[n].z ** 2;
      if (d < best && world.survey.nodeFlagOwner[n] === b.f) {
        best = d;
        node = n;
      }
    }
  }
  if (node < 0) return;
  const nd = lat.nodes[node];
  const side = Math.hypot(tx - nd.x, tz - nd.z) || 1;
  let built = 0;
  for (const fc of nd.facets) {
    for (const e of lat.facets[fc].edges) {
      const ed = lat.edges[e];
      if (ed.a === node || ed.b === node) continue;
      const mx = (lat.nodes[ed.a].x + lat.nodes[ed.b].x) / 2;
      const mz = (lat.nodes[ed.a].z + lat.nodes[ed.b].z) / 2;
      // Only the half of the link facing the threat.
      if (((mx - nd.x) * (tx - nd.x) + (mz - nd.z) * (tz - nd.z)) / side < 0) continue;
      if (!canBuildPiece(world, b.f, 'wall', e, -1, 0, 0).ok) continue;
      world.submit({ t: 'build', faction: b.f, kind: 'wall', edge: e, facet: -1, level: 0, rampEdge: 0 });
      if (++built >= WALLS_PER_PASS || v.lumber - built * PIECE.cost < WALL_LUMBER) return;
    }
  }
}
