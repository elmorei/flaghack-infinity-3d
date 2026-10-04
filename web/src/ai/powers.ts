/**
 * Powers: chakra alignment by temperament, abilities aimed at what actually decides fights
 * (Phason Shift on a flippable critical Flag, Priority Beacon on the Flag to pull, Stabilize
 * over our assault loop, Forced March into an assault, Omega Pulse into a crowd), drugs at
 * the moment they pay, Command Center actions and the TAKE A SHOT retransmit.
 * Every action is checked with the sim's own blockers first, so nothing is rejected.
 * Owner: AI agent.
 */
import { ABILITY, ALIGN_COST, GCC_SIMULACRA_RANGE } from '../sim/constants';
import { abilityBlocker, inStabilizeZone } from '../sim/systems/abilities';
import { drugBlocker } from '../sim/systems/drugs';
import { gccActive } from '../sim/systems/gcc';
import { canPlantAt, isBuildingCorner } from '../sim/systems/flags';
import type { AbilityId, EntityId } from '../sim/types';
import type { Brain } from './brain';

/** Hippie attention below which the camp counts as flagging (TAKE A SHOT). */
const LOW_ATTENTION = 25;
/** The vexillomancer only walks to the Command Center for an action from this close. */
const GCC_ERRAND = 45;
/** A wall missing at most WALL_GAPS nodes gets the Beacon, when this many hands are in reach. */
const WALL_GAPS = 3;
const BEACON_HANDS = 3;
/**
 * Alignment schedule over the temperament's chakra order, as (rank, level) steps: the
 * favourite runs deep early (its level 3 is the camp's signature), the rest follow.
 */
const ALIGN_PLAN: readonly (readonly [number, number])[] = [
  [0, 1], [1, 1], [0, 2], [2, 1], [1, 2], [0, 3], [3, 1], [4, 1],
  [2, 2], [1, 3], [3, 2], [4, 2], [2, 3], [3, 3], [4, 3],
];

export function usePowers(b: Brain): void {
  planAlignment(b);
  if (b.world.rng.next() < b.skill.powers) castAbilities(b);
  takeDrugs(b);
  planGcc(b);
  retransmit(b);
}

/** Next step of the alignment schedule, wanted once the Ritual for it is in hand. */
function planAlignment(b: Brain): void {
  const fac = b.world.factions[b.f];
  b.alignWanted = null;
  if (b.posture === 'defend') return;
  for (const [rank, level] of ALIGN_PLAN) {
    const c = b.persona.chakraOrder[rank];
    const at = fac.chakras[c];
    if (at >= level) continue;
    if (fac.ritual >= ALIGN_COST[at]) b.alignWanted = c;
    return;
  }
}

function ready(b: Brain, a: AbilityId): boolean {
  return abilityBlocker(b.world, b.f, a) === '';
}

function castAbilities(b: Brain): void {
  const world = b.world;
  const v = b.view;
  const av = world.avatarOf(b.f);
  const fac = world.factions[b.f];
  const lat = world.lattice;
  const besieged = v.stage === 'contained' || v.stage === 'contested' || v.stage === 'overwritten';
  const r = b.target === null ? undefined : b.intel(b.target);
  const assault = (b.posture === 'attack' || b.posture === 'opportunist') && r !== undefined;
  const loopHolds = assault && r !== undefined && r.attacker === b.f;
  const near = (x: number, z: number, range: number): boolean => (x - av.pos.x) ** 2 + (z - av.pos.z) ** 2 <= range * range;

  // Phason Shift: turn a flippable Flag out from under the loop around us, or out of their home ring.
  if (ready(b, 'phason')) {
    const targets: EntityId[] = besieged ? v.critical : loopHolds && r ? r.homeCritical : [];
    for (const id of targets) {
      const fl = world.flags.get(id);
      if (!fl || fl.state !== 'planted' || !lat.flippable(fl.node) || isBuildingCorner(world, fl.node)) continue;
      const n = lat.nodes[fl.node];
      if (!near(n.x, n.z, ABILITY.phason.range - 1) || inStabilizeZone(world, n)) continue;
      cast(b, 'phason', n.x, n.z, fl.node);
      return;
    }
  }
  // Priority Beacon on the cheapest Flag holding the loop around us; on the attack, on the
  // last gap of our wall, so the hands nearby rush to pull and plant it.
  if (ready(b, 'beacon')) {
    const radius = ABILITY.beacon.radius[fac.chakras.hoist - 1];
    if (besieged && v.critical.length > 0) {
      const fl = world.flags.get(v.critical[0]);
      if (fl && fl.state === 'planted' && ownHippiesWithin(b, fl.pos.x, fl.pos.z, radius) > 0) {
        cast(b, 'beacon', fl.pos.x, fl.pos.z, fl.node);
        return;
      }
    } else if (assault && r && r.loop && r.keystones.length === 0) {
      const gap = lastGap(b, r.loop);
      if (gap >= 0 && ownHippiesWithin(b, lat.nodes[gap].x, lat.nodes[gap].z, radius) >= BEACON_HANDS) {
        cast(b, 'beacon', lat.nodes[gap].x, lat.nodes[gap].z, gap);
        return;
      }
    }
  }
  // Omega Pulse into a crowd of rival hippies, onto a critical Flag within its blast, or onto
  // the vexillomancer holding the Hearth our loop encloses.
  if (ready(b, 'omega')) {
    const radius = ABILITY.omega.radius[fac.chakras.finial - 1] * ABILITY.omega.looseFraction;
    let critNear = false;
    for (const id of v.critical) {
      const fl = world.flags.get(id);
      if (fl && near(fl.pos.x, fl.pos.z, radius)) critNear = true;
    }
    const holder = loopHolds && r && r.stage === 'contested' ? world.avatars.get(world.factions[r.id].avatarId) : undefined;
    const holderNear = !!holder && holder.koUntil <= world.time && near(holder.pos.x, holder.pos.z, radius);
    if (v.rivalsNearAvatar >= 4 || critNear || holderNear) {
      cast(b, 'omega', av.pos.x, av.pos.z, -1);
      return;
    }
  }
  // Stabilize Zone over the front of our closed loop.
  if (loopHolds && r && r.loop && ready(b, 'stabilize')) {
    let front = -1;
    let best = Infinity;
    for (const n of r.loop) {
      const d = (lat.nodes[n].x - r.hx) ** 2 + (lat.nodes[n].z - r.hz) ** 2;
      if (d < best) {
        best = d;
        front = n;
      }
    }
    if (front >= 0 && near(lat.nodes[front].x, lat.nodes[front].z, ABILITY.stabilize.range - 1)) {
      cast(b, 'stabilize', lat.nodes[front].x, lat.nodes[front].z, front);
      return;
    }
  }
  // Forced March: into an assault, or home to a siege.
  if ((assault || besieged) && ready(b, 'march') && ownHippiesWithin(b, av.pos.x, av.pos.z, ABILITY.march.radius) >= 3) {
    cast(b, 'march', av.pos.x, av.pos.z, -1);
  }
}

function cast(b: Brain, ability: AbilityId, x: number, z: number, node: number): void {
  b.world.submit({ t: 'ability', faction: b.f, ability, at: { x, z }, node });
}

function ownHippiesWithin(b: Brain, x: number, z: number, r: number): number {
  let n = 0;
  for (const h of b.world.hippies.values()) {
    if (h.faction === b.f && h.koUntil <= b.world.time && (h.pos.x - x) ** 2 + (h.pos.z - z) ** 2 <= r * r) n++;
  }
  return n;
}

/** The first missing node of a wall with at most WALL_GAPS missing, or -1. */
function lastGap(b: Brain, wall: readonly number[]): number {
  const s = b.world.survey;
  let gap = -1;
  let missing = 0;
  for (const n of wall) {
    if (s.nodeFlagOwner[n] === b.f || s.holder[n] === b.f) continue;
    if (++missing > WALL_GAPS) return -1;
    if (gap < 0) gap = n;
  }
  return gap;
}

/** The temperament's drug when an assault is under way; Luminous Dust for crystal hunts. */
function takeDrugs(b: Brain): void {
  const world = b.world;
  const r = b.target === null ? undefined : b.intel(b.target);
  const assault = (b.posture === 'attack' || b.posture === 'opportunist') && r !== undefined;
  const d = b.persona.assaultDrug;
  if (assault && d && drugBlocker(world, b.f, d) === '') {
    world.submit({ t: 'drug', faction: b.f, drug: d });
    return;
  }
  if (b.posture === 'expand' && b.pentacleFocus >= 0 && drugBlocker(world, b.f, 'dust') === '' && b.persona.crystals >= 1) {
    world.submit({ t: 'drug', faction: b.f, drug: 'dust' });
  }
}

/** Command Center errands: convert rival crowds with Dialectics; neutral recruitment is passive. */
function planGcc(b: Brain): void {
  const world = b.world;
  const v = b.view;
  b.gccWanted = null;
  if (!gccActive(world, b.f) || b.posture === 'attack') return;
  const g = world.gccOf(b.f);
  const av = world.avatarOf(b.f);
  if (!g || (av.pos.x - g.pos.x) ** 2 + (av.pos.z - g.pos.z) ** 2 > GCC_ERRAND * GCC_ERRAND) return;
  const fac = world.factions[b.f];
  if (v.rivalsNearGcc >= 2 && fac.cooldowns.dialectics <= world.time) {
    b.gccWanted = { action: 'dialectics', target: -1, nodes: [] };
    return;
  }
  // Flag Simulacra: superpose one Flag over two unfilled plan nodes in the cart's reach.
  if (fac.cooldowns.simulacra <= world.time && v.stock > 0) {
    const lat = world.lattice;
    const picks: number[] = [];
    for (const n of fac.plan) {
      const node = lat.nodes[n];
      if ((node.x - g.pos.x) ** 2 + (node.z - g.pos.z) ** 2 > (GCC_SIMULACRA_RANGE - 2) ** 2) continue;
      if (!canPlantAt(world, n, b.f)) continue;
      picks.push(n);
      if (picks.length === 2) break;
    }
    if (picks.length === 2) b.gccWanted = { action: 'simulacra', target: -1, nodes: picks };
  }
}

/** TAKE A SHOT when the camp's attention is flagging. */
function retransmit(b: Brain): void {
  const world = b.world;
  const fac = world.factions[b.f];
  if (fac.cooldowns.retransmit > world.time) return;
  let low = 0;
  let total = 0;
  for (const h of world.hippies.values()) {
    if (h.faction !== b.f || h.koUntil > world.time || !h.beacon) continue;
    total++;
    if (h.attention < LOW_ATTENTION || h.status === 'distracted') low++;
  }
  if (total >= 4 && low / total >= 0.4) world.submit({ t: 'retransmit', faction: b.f });
}
