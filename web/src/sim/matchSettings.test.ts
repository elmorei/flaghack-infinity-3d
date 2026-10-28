import { describe, it, expect } from 'vitest';
import { DEFAULT_MATCH, UNLIMITED_DAYS, normalizeMatch, burnTime, endTime, dayClock } from './matchSettings';
import { createMatch } from './setup';
import { updateVictory } from './systems/victory';
import { Simulation } from './simulation';
import { createAi } from '../ai';
import { FACTION_IDS } from './types';
import type { MatchOptions } from './types';
import { canPlantAt, isBuildingCorner } from './systems/flags';
import { BURN_TIME, DAWN_TIME, SIM_DT, TIDE_INTERVAL_SUDDEN_DEATH } from './constants';
import { bossRevealTime } from './effigyBurn';
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
  it.each([UNLIMITED_DAYS, 0, 1, 2, 3, 4, 5])('preserves the explicit day setting %s', (days) => {
    expect(normalizeMatch({ days }).days).toBe(days);
  });
  it.each([-2, 6, 0.5, NaN, Infinity, '0', null])('rejects invalid day setting %s instead of treating it as zero', (days) => {
    expect(normalizeMatch({ days } as never).days).toBe(DEFAULT_MATCH.days);
  });
  it('defaults boss mode on and preserves explicit opt-out through normalization', () => {
    expect(normalizeMatch().bossMode).toBe(true);
    expect(normalizeMatch({ bossMode: false }).bossMode).toBe(false);
    expect(normalizeMatch({ bossMode: null } as never).bossMode).toBe(true);
  });
  it('defaults boss health to 50,000 and normalizes it to a bounded positive integer', () => {
    expect(normalizeMatch().bossHp).toBe(50000);
    expect(normalizeMatch({ bossHp: 72500 }).bossHp).toBe(72500);
    expect(normalizeMatch({ bossHp: 12345.9 }).bossHp).toBe(12345);
    expect(normalizeMatch({ bossHp: 0 }).bossHp).toBe(100);
    expect(normalizeMatch({ bossHp: -500 }).bossHp).toBe(100);
    expect(normalizeMatch({ bossHp: 1000001 }).bossHp).toBe(1000000);
  });
  it.each([NaN, Infinity, -Infinity, undefined, null, '50000'])('uses default boss health for invalid value %s', (bossHp) => {
    expect(normalizeMatch({ bossHp } as never).bossHp).toBe(50000);
  });
  it('defaults to triple jump height, 200 Signifiers, and no structure blocking', () => {
    expect(normalizeMatch()).toMatchObject({ jumpHeight: 3, maxSignifiers: 200, structuresBlockFlagPlacement: false });
    expect(normalizeMatch({ jumpHeight: -1, maxSignifiers: 2.9, startingSignifiers: 12 })).toMatchObject({
      jumpHeight: 0.1, maxSignifiers: 2, startingSignifiers: 0,
    });
    expect(normalizeMatch({ jumpHeight: 99, maxSignifiers: 999 })).toMatchObject({ jumpHeight: 5, maxSignifiers: 200 });
  });
  it('creates the default shared population without explicit match settings', () => {
    const w = createMatch({ seed: 'default-population', difficulty: 'normal', humans: [0], mode: 'standard' });
    expect(w.hippies.size).toBe(200);
    for (const f of FACTION_IDS) expect(w.hippiesOf(f)).toHaveLength(6);
    expect(normalizeMatch({ jumpHeight: 1, maxSignifiers: 40 })).toMatchObject({ jumpHeight: 1, maxSignifiers: 40 });
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
    const w = createMatch(options({ active: [0], days: 2, dayLength: 300, bossMode: false }));
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
    const w = createMatch(options({ active: [0], days: UNLIMITED_DAYS, dayLength: 300 }));
    w.time = 100000;
    updateVictory(w, 0);
    expect(w.phase).toBe('playing');
    expect(w.suddenDeath).toBe(false);
    expect(burnTime(w.options)).toBe(Infinity);
    expect(endTime(w.options)).toBe(Infinity);
    expect(dayClock(w.options, 310)).toBeCloseTo(60);
  });
  it('starts zero-day matches at ignition without skipping any of the 90-second boss reveal', () => {
    const w = createMatch(options({ active: [0], days: 0, dayLength: 300, maxSignifiers: 0 }));
    expect(w.time).toBe(0);
    expect(w.tick).toBe(0);
    expect(w.phase).toBe('playing');
    expect(w.suddenDeath).toBe(true);
    expect(w.tide.nextAt).toBe(TIDE_INTERVAL_SUDDEN_DEATH);
    expect(w.effigyRevealedAt).toBeNull();
    expect(w.boss).toBeNull();
    expect(w.collision.supportHeight(0, 0, 40)).toBe(28);
    expect(burnTime(w.options)).toBe(0);
    expect(bossRevealTime(w.options)).toBe(90);
    expect(dayClock(w.options, 0)).toBe(BURN_TIME);
    expect(w.drainEvents().filter((event) => event.t === 'burn')).toHaveLength(1);
    updateVictory(w, 0);
    expect(w.drainEvents().some((event) => event.t === 'burn')).toBe(false);
    w.time = 90 - SIM_DT / 2;
    updateVictory(w, 0);
    expect(w.effigyRevealedAt).toBeNull();
    expect(w.boss).toBeNull();
    w.tide.nextAt = Infinity;
    new Simulation(w).step();
    expect(w.effigyRevealedAt).toBe(90);
    expect(w.boss?.spawnedAt).toBe(90);
    expect(w.collision.supportHeight(0, 0, 40)).toBe(2);
    w.time = endTime(w.options);
    updateVictory(w, 0);
    expect(w.phase).toBe('playing');
  });
  it.each([300, 600, 1800, 7200])('keeps the entire non-boss Burn night with a %s-second zero-day cycle', (dayLength) => {
    const normal = options({ dayLength, bossMode: false });
    const zero = options({ active: [0], days: 0, dayLength, bossMode: false, maxSignifiers: 0 });
    expect(endTime(zero)).toBeCloseTo(endTime(normal) - burnTime(normal));
    expect(dayClock(zero, 0)).toBeCloseTo(BURN_TIME);
    expect(dayClock(zero, 1)).toBeGreaterThan(BURN_TIME);
    expect(dayClock(zero, endTime(zero))).toBe(DAWN_TIME);
    const w = createMatch(zero);
    w.time = endTime(zero) - 0.001;
    updateVictory(w, 0);
    expect(w.phase).toBe('playing');
    expect(w.effigyRevealedAt).toBeNull();
    w.time = endTime(zero);
    updateVictory(w, 0);
    expect(w.phase).toBe('ended');
    expect(w.winner).toBe(0);
  });
  it('restarts zero-day matches with a fresh ignition and leaves default and tutorial starts alone', () => {
    const o = options({ active: [0], days: 0, maxSignifiers: 0 });
    const first = createMatch(o);
    first.time = 90;
    updateVictory(first, 0);
    expect(first.effigyRevealedAt).toBe(90);
    const restarted = createMatch(o);
    expect(restarted.time).toBe(0);
    expect(restarted.suddenDeath).toBe(true);
    expect(restarted.effigyRevealedAt).toBeNull();
    expect(restarted.boss).toBeNull();
    expect(restarted.collision.supportHeight(0, 0, 40)).toBe(28);
    const defaults = createMatch(options(DEFAULT_MATCH));
    expect(defaults.time).toBe(0);
    expect(defaults.suddenDeath).toBe(false);
    expect(dayClock(defaults.options, 0)).toBe(0);
    const tutorial = createMatch({ ...o, mode: 'tutorial' });
    expect(tutorial.suddenDeath).toBe(false);
    expect(tutorial.effigyRevealedAt).toBeNull();
  });
  it('starts the Burn only during the last night and uses the ten-minute default cycle', () => {
    expect(DEFAULT_MATCH.dayLength).toBe(600);
    expect(normalizeMatch().dayLength).toBe(600);
    expect(burnTime(options())).toBe(280);
    expect(bossRevealTime(options())).toBe(370);
    expect(endTime(options())).toBe(600);
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


describe('independent optional match rules', () => {
  const keys = ['buildingCapture', 'crystalFlagProtection', 'crystalAttacks'] as const;
  it('defaults missing and malformed choices on, including older match options', () => {
    for (const key of keys) {
      expect(normalizeMatch()[key]).toBe(true);
      for (const value of [undefined, null, 0, 1, 'false', {}, []])
        expect(normalizeMatch({ [key]: value } as never)[key]).toBe(true);
      expect(normalizeMatch({ [key]: false })[key]).toBe(false);
    }
  });
  it.each(Array.from({ length: 8 }, (_, mask) => [mask]))('preserves all rule combinations %s at creation and restart', mask => {
    const match = normalizeMatch({ ...Object.fromEntries(keys.map((key, bit) => [key, !!(mask & (1 << bit))])), maxSignifiers: 0 });
    for (let restart = 0; restart < 2; restart++) {
      const world = createMatch(options(match));
      for (const key of keys) expect(world.options.match?.[key]).toBe(match[key]);
    }
  });
});
