/**
 * Headless match harness for the Economy tests: a real createMatch world stepped by the real
 * Simulation, with every emitted event collected for assertions.
 */
import { BUILDINGS, SIM_HZ } from '../../constants';
import type { EventOf, GameEvent, GameEventType } from '../../events';
import { createMatch } from '../../setup';
import { Simulation } from '../../simulation';
import type { BuildingKind, FactionId } from '../../types';
import type { World } from '../../world';

export interface Harness {
  world: World;
  sim: Simulation;
  events: GameEvent[];
}

export function newMatch(seed = 'economy-tests'): Harness {
  // Explicit roaming Crow seat for tests that stage personal avatar actions.
  const world = createMatch({ seed, difficulty: 'normal', humans: [1], mode: 'standard' });
  return { world, sim: new Simulation(world), events: [] };
}

/** Advance the simulation by `seconds` of game time, collecting events. */
export function run(h: Harness, seconds: number): void {
  const steps = Math.round(seconds * SIM_HZ);
  for (let i = 0; i < steps; i++) {
    h.sim.step();
    for (const e of h.world.drainEvents()) h.events.push(e);
  }
}

export function eventsOf<T extends GameEventType>(h: Harness, t: T): EventOf<T>[] {
  return h.events.filter((e): e is EventOf<T> => e.t === t);
}

/** Remove a faction's hippies so nothing else touches its stock, lumber or buildings. */
export function dismissHippies(world: World, f: FactionId): void {
  for (const h of [...world.hippies.values()]) if (h.faction === f) world.hippies.delete(h.id);
}

/** Teleport a vexillomancer to the walkable spot nearest (x, z). */
export function placeAvatar(world: World, f: FactionId, x: number, z: number): void {
  const av = world.avatarOf(f);
  const at = world.nav.nearestWalkable(x, z);
  av.pos.x = at.x;
  av.pos.z = at.z;
  av.pos.y = world.collision.groundHeight(at.x, at.z);
  av.vel.x = 0;
  av.vel.y = 0;
  av.vel.z = 0;
}

/** Park a vexillomancer `dist` metres from its Hearth toward the map centre (no restock, no build help). */
export function parkAvatarAway(world: World, f: FactionId, dist = 40): void {
  const hearth = world.hearthOf(f);
  if (!hearth) throw new Error('faction has no Hearth');
  const len = Math.hypot(hearth.pos.x, hearth.pos.z) || 1;
  placeAvatar(world, f, hearth.pos.x - (hearth.pos.x / len) * dist, hearth.pos.z - (hearth.pos.z / len) * dist);
}

/**
 * Nearest Sun facet to (x, z), at least `minDist` from it, with unblocked corners and room for
 * a `kind` building next to every existing one.
 */
export function freeThickFacet(world: World, x: number, z: number, minDist: number, kind: BuildingKind): number {
  const lat = world.lattice;
  let best = -1;
  let bestD = Infinity;
  for (const fc of lat.facets) {
    if (!fc.thick || fc.boundary || fc.nodes.some((n) => lat.nodes[n].blocked)) continue;
    const d = Math.hypot(fc.cx - x, fc.cz - z);
    if (d < minDist || d >= bestD) continue;
    let clear = true;
    for (const b of world.buildings.values()) {
      const min = BUILDINGS[kind].radius + BUILDINGS[b.kind].radius + 1;
      if (Math.hypot(b.pos.x - fc.cx, b.pos.z - fc.cz) < min) clear = false;
    }
    if (!clear || world.collision.blockedCircle(fc.cx, fc.cz, BUILDINGS[kind].radius, 0.2, 3)) continue;
    best = fc.id;
    bestD = d;
  }
  if (best < 0) throw new Error('no free Sun facet');
  return best;
}
