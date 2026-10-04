import { describe, it, expect } from 'vitest';
import { DEFAULT_MATCH, normalizeMatch, burnTime, endTime, dayClock } from './matchSettings';
import { createMatch } from './setup';
import { updateVictory } from './systems/victory';
import { Simulation } from './simulation';
import { createAi } from '../ai';
import { FACTION_IDS } from './types';
import type { MatchOptions } from './types';
import { canPlantAt, isBuildingCorner } from './systems/flags';
const options = (patch = {}): MatchOptions => ({
  seed: 'fork-settings',
  difficulty: 'normal',
  humans: [0],
  mode: 'standard',
  match: normalizeMatch(patch),
});
describe('configurable matches', () => {
  it.each([[0], [2], [1, 3], [0, 2, 3], [0, 1, 2, 3]])('spawns only enabled seats: %j', (...active) => {
    const w = createMatch(options({ active }));
    expect(w.aliveFactions()).toEqual(active);
    for (const f of FACTION_IDS) {
      expect(!!w.avatarOf(f)).toBe(active.includes(f));
      expect(!!w.hearthOf(f)).toBe(active.includes(f));
      if (active.includes(f)) continue;
      expect(w.buildingsOf(f)).toHaveLength(0);
      expect(w.hippiesOf(f)).toHaveLength(0);
      expect([...w.flags.values()].filter((flag) => flag.owner === f)).toHaveLength(0);
    }
  });
  it('clamps invalid settings and always leaves an active camp', () => {
    expect(normalizeMatch({ active: [], gridScale: 999, dayLength: NaN, days: 9 })).toEqual({
      ...DEFAULT_MATCH,
      gridScale: 12,
    });
    expect(normalizeMatch(null as never)).toEqual(DEFAULT_MATCH);
  });
  it('defaults to original jump height, 40 Signifiers, and no structure blocking', () => {
    expect(normalizeMatch()).toMatchObject({ jumpHeight: 1, maxSignifiers: 40, structuresBlockFlagPlacement: false });
    expect(normalizeMatch({ jumpHeight: -1, maxSignifiers: 2.9, startingSignifiers: 12 })).toMatchObject({
      jumpHeight: 0.1, maxSignifiers: 2, startingSignifiers: 0,
    });
    expect(normalizeMatch({ jumpHeight: 99, maxSignifiers: 999 })).toMatchObject({ jumpHeight: 5, maxSignifiers: 200 });
  });
  it.each([0, 2, 40, 60, 200])('keeps all camps and neutrals within one shared population of %i', (maxSignifiers) => {
    const w = createMatch(options({ maxSignifiers, startingSignifiers: 12 }));
    expect(w.hippies.size).toBe(maxSignifiers);
    for (const f of FACTION_IDS) expect(w.hippiesOf(f)).toHaveLength(Math.min(12, Math.floor(maxSignifiers / 4)));
  });
  it('allows building corners by default and reserves them when structure blocking is on', () => {
    const w = createMatch(options());
    const node = w.lattice.nodes.find((n) => isBuildingCorner(w, n.id) && canPlantAt(w, n.id, 0));
    expect(node).toBeDefined();
    w.options.match = normalizeMatch({ structuresBlockFlagPlacement: true });
    expect(canPlantAt(w, node!.id, 0)).toBe(false);
    w.options.match.structuresBlockFlagPlacement = false;
    expect(canPlantAt(w, node!.id, 0)).toBe(true);
    node!.blocked = true;
    expect(canPlantAt(w, node!.id, 0)).toBe(false);
  });
  it('creates only active camps and runs a solo game until its deadline', () => {
    const w = createMatch(options({ active: [0], days: 2, dayLength: 300 }));
    expect(w.aliveFactions()).toEqual([0]);
    expect(w.avatars.size).toBe(1);
    expect(w.buildingsOf(1)).toHaveLength(0);
    updateVictory(w, 0);
    expect(w.phase).toBe('playing');
    w.time = burnTime(w.options) - 1;
    updateVictory(w, 0);
    expect(w.suddenDeath).toBe(false);
    w.time = burnTime(w.options);
    updateVictory(w, 0);
    expect(w.suddenDeath).toBe(true);
    w.time = endTime(w.options);
    updateVictory(w, 0);
    expect(w.phase).toBe('ended');
    expect(w.winner).toBe(0);
  });
  it('unlimited solo cycles without a Burn or time victory', () => {
    const w = createMatch(options({ active: [0], days: 0, dayLength: 300 }));
    w.time = 100000;
    updateVictory(w, 0);
    expect(w.phase).toBe('playing');
    expect(w.suddenDeath).toBe(false);
    expect(dayClock(w.options, 310)).toBeCloseTo(60);
  });
  it('starts the Burn only during the last night and preserves default timing', () => {
    expect(burnTime(options())).toBe(840);
    expect(endTime(options())).toBe(1800);
    expect(burnTime(options({ days: 3, dayLength: 600 }))).toBe(1480);
    expect(endTime(options({ days: 3, dayLength: 600 }))).toBe(1800);
  });
  it('keeps inactive AI seats inert and custom lattice replicas deterministic', () => {
    const o = options({ active: [0, 2], gridScale: 10, startingLumber: 500, startingSignifiers: 2, startingFlags: 8 });
    const a = createMatch(o),
      b = createMatch(o);
    expect(a.lattice.nodes.map((n) => [n.x, n.z])).toEqual(b.lattice.nodes.map((n) => [n.x, n.z]));
    expect(a.factions[0].lumber).toBe(500);
    expect(a.hippiesOf(0)).toHaveLength(2);
    const ai = createAi(a, FACTION_IDS);
    const sim = new Simulation(a);
    for (let i = 0; i < 120; i++) {
      ai.update();
      sim.step();
    }
    expect(a.aliveFactions()).toEqual([0, 2]);
  });
  it('supports the extremes of bounded lattice spacing', () => {
    for (const gridScale of [6, 12]) {
      const w = createMatch(options({ gridScale }));
      expect(w.aliveFactions()).toHaveLength(4);
      for (const f of FACTION_IDS) {
        expect(w.hearthOf(f)).toBeDefined();
        expect(w.avatarOf(f)).toBeDefined();
      }
    }
  });
});
