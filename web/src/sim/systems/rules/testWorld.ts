/**
 * Headless test kit for the Survey & conquest rules: deterministic matches, a rules-only
 * stepper (no actors, so other systems' behaviour can't disturb a staged scenario), Flag
 * bookkeeping invariants and lattice scouting helpers. Test-only; gameplay never imports it.
 */
import { AVATAR, SIM_DT, SIM_HZ } from '../../constants';
import type { GameEvent, GameEventType } from '../../events';
import { spawnFlag } from '../../factory';
import { planEnclosure } from '../../lattice/planner';
import { createMatch } from '../../setup';
import type { FactionId } from '../../types';
import type { World } from '../../world';
import { updateCapture } from '../capture';
import { updateCrystals } from '../crystals';
import { canPlantAt, plantFlag } from '../flags';
import { updateInstability } from '../instability';
import { updateSurvey } from '../survey';
import { updateTides } from '../tides';
import { updateVictory } from '../victory';
import { depotSceneryId, depotStock, vehicleCapacity } from '../sceneryDepots';
import { sceneryById } from '../sceneryBenefits';

export function newMatch(seed: string): World {
  return createMatch({ seed, difficulty: 'normal', humans: [], mode: 'standard' });
}

/**
 * Advance `seconds` of sim time running only the geometry/consequence systems, in the same
 * order Simulation.step() runs them. Returns every event emitted meanwhile.
 */
export function runRules(world: World, seconds: number): GameEvent[] {
  const out: GameEvent[] = [];
  const steps = Math.max(1, Math.round(seconds * SIM_HZ));
  for (let i = 0; i < steps && world.phase === 'playing'; i++) {
    world.tick++;
    world.time += SIM_DT;
    updateSurvey(world, SIM_DT);
    updateCrystals(world, SIM_DT);
    updateInstability(world, SIM_DT);
    updateTides(world, SIM_DT);
    updateCapture(world, SIM_DT);
    updateVictory(world, SIM_DT);
    for (const e of world.drainEvents()) out.push(e);
  }
  return out;
}

export function eventsOf<T extends GameEventType>(events: GameEvent[], t: T): Extract<GameEvent, { t: T }>[] {
  const out: Extract<GameEvent, { t: T }>[] = [];
  for (const e of events) if (isEvent(e, t)) out.push(e);
  return out;
}

function isEvent<T extends GameEventType>(e: GameEvent, t: T): e is Extract<GameEvent, { t: T }> {
  return e.t === t;
}

/** Unwrap a value a scenario relies on, failing loudly instead of asserting non-null. */
export function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** Plant fresh Flags for `f` on `nodes` (each must be plantable). Returns the Flag ids. */
export function plantFresh(world: World, f: FactionId, nodes: number[]): number[] {
  const ids: number[] = [];
  for (const node of nodes) {
    const n = world.lattice.nodes[node];
    const fl = spawnFlag(world, { state: 'loose', owner: f, pos: { x: n.x, y: 0, z: n.z } });
    if (!plantFlag(world, fl.id, node, f, -1)) throw new Error(`node ${node} is not plantable for ${f}`);
    ids.push(fl.id);
  }
  return ids;
}

/** Plan-cost function: free plantable nodes cost 1, everything else is impassable. */
export function freeCost(world: World, f: FactionId): (n: number) => number {
  return (n) => (canPlantAt(world, n, f) ? 1 : Infinity);
}

/** Distance from (x, z) to the nearest camp building (Hearth or GCC) of any faction. */
export function campDistance(world: World, x: number, z: number): number {
  let best = Infinity;
  for (const b of world.buildings.values()) best = Math.min(best, Math.hypot(b.pos.x - x, b.pos.z - z));
  return best;
}

/** Plant a closed loop of fresh Flags for `f` around (x, z) with the shared planner. Returns its nodes. */
export function loopAround(world: World, f: FactionId, x: number, z: number, minRadius: number): number[] {
  const loop = must(planEnclosure(world.lattice, { x, z, minRadius, cost: freeCost(world, f) }), 'loop');
  plantFresh(world, f, loop);
  return loop;
}

/** A 5-fold focus far from every camp, free itself, whose whole pentacle `f` can plant. */
export function freeFocus(world: World, f: FactionId): number {
  const lat = world.lattice;
  const focus = world.survey.focusNodes.find(
    (n) =>
      campDistance(world, lat.nodes[n].x, lat.nodes[n].z) > 50 &&
      world.survey.nodeFlag[n] < 0 &&
      lat.neighbors(n).every((p) => canPlantAt(world, p, f)),
  );
  return must(focus, 'free focus node');
}

/**
 * Flag bookkeeping invariants: every Flag is in exactly one place and the survey node arrays
 * agree with the planted Flags. Returns human-readable problems (empty = consistent).
 */
export function flagProblems(world: World): string[] {
  const problems: string[] = [];
  const s = world.survey;
  const inHands = new Map<number, number>();
  for (const av of world.avatars.values()) {
    if (av.carried.length > AVATAR.quiver) problems.push(`avatar ${av.id} carries ${av.carried.length}`);
    for (const id of av.carried) inHands.set(id, (inHands.get(id) ?? 0) + 1);
  }
  for (const h of world.hippies.values()) {
    if (h.carryingFlag >= 0) inHands.set(h.carryingFlag, (inHands.get(h.carryingFlag) ?? 0) + 1);
  }
  for (const fl of world.flags.values()) {
    const held = inHands.get(fl.id) ?? 0;
    if (fl.state === 'carried') {
      const av = world.avatars.get(fl.holder);
      const hp = world.hippies.get(fl.holder);
      const ok = (av && av.carried.includes(fl.id)) || (hp && hp.carryingFlag === fl.id);
      if (!ok || held !== 1) problems.push(`flag ${fl.id} carried by ${fl.holder} but held ${held}x`);
    } else if (held !== 0) {
      problems.push(`flag ${fl.id} is ${fl.state} but held ${held}x`);
    }
    if (fl.state === 'planted') {
      for (const node of [fl.node, fl.altNode]) {
        if (node < 0) continue;
        if (s.nodeFlag[node] !== fl.id) problems.push(`flag ${fl.id} planted on ${node} but nodeFlag=${s.nodeFlag[node]}`);
        if (s.nodeFlagOwner[node] !== fl.owner) problems.push(`flag ${fl.id} owner ${fl.owner} vs nodeFlagOwner ${s.nodeFlagOwner[node]}`);
      }
      if (fl.node < 0) problems.push(`flag ${fl.id} planted without a node`);
    } else if (fl.node !== -1 || fl.altNode !== -1) {
      problems.push(`flag ${fl.id} is ${fl.state} but keeps node ${fl.node}/${fl.altNode}`);
    }
    if (fl.state === 'stock') {
      const id = depotSceneryId(fl.holder);
      if (id === null) {
        if (!['hearth', 'workshop'].includes(world.buildings.get(fl.holder)?.kind ?? '')) problems.push(`stock flag ${fl.id} not at valid storage`);
      } else {
        // Contested service is paused, not invalid inventory.
        const o = sceneryById(world, id), owner = world.sceneryCapture.get(id)?.faction ?? -1;
        if (!o || o.kind !== 'car' || world.destroyedScenery.has(id) || owner === -1 || !world.factions[owner].alive) problems.push(`stock flag ${fl.id} not at a living owned depot`);
        else {
          if (fl.owner !== owner) problems.push(`stock flag ${fl.id} owner differs from depot ${id}`);
          if (depotStock(world, fl.holder) > vehicleCapacity(o)) problems.push(`depot ${id} over capacity`);
        }
      }
    }
    if (fl.history.length > 16) problems.push(`flag ${fl.id} history ${fl.history.length}`);
  }
  for (let n = 0; n < s.nodeFlag.length; n++) {
    const id = s.nodeFlag[n];
    if (id < 0) {
      if (s.nodeFlagOwner[n] !== -1) problems.push(`node ${n} has an owner but no flag`);
      continue;
    }
    const fl = world.flags.get(id);
    if (!fl || fl.state !== 'planted' || (fl.node !== n && fl.altNode !== n)) problems.push(`node ${n} points at flag ${id} which is not planted there`);
  }
  return problems;
}
