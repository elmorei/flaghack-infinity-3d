import { describe, it, expect } from 'vitest';
import { DEFAULT_MATCH, normalizeMatch, burnTime, endTime, dayClock } from './matchSettings';
import { createMatch } from './setup';
import { updateVictory } from './systems/victory';
import { Simulation } from './simulation';
import { createAi } from '../ai';
import { FACTION_IDS } from './types';
import type { MatchOptions } from './types';
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
