import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEACON_DROP_CHANCE, CARD_DROP_CHANCE } from '../constants';
import { FRICK_FRACK_DROP_CHANCE } from '../frickFrack';
import { spawnHippie } from '../factory';
import { Rng } from '../rng';
import { damageEntity } from './combat';
import { newMatch } from './econ/testkit';
import { dropFrickFrackCard, resetFrickFrackEntropy } from './frickFrack';

afterEach(() => vi.restoreAllMocks());

describe('exclusive card and D.E.G.E.N. beacon loot', () => {
  it('sets 5% cards, 20% beacons, and 75% empty outcomes', () => {
    expect(CARD_DROP_CHANCE).toBe(.05);
    expect(FRICK_FRACK_DROP_CHANCE).toBe(CARD_DROP_CHANCE);
    expect(BEACON_DROP_CHANCE).toBe(.20);
    expect(BEACON_DROP_CHANCE / CARD_DROP_CHANCE).toBe(4);
    expect(CARD_DROP_CHANCE + BEACON_DROP_CHANCE).toBeLessThanOrEqual(.25);
    expect(1 - CARD_DROP_CHANCE - BEACON_DROP_CHANCE).toBe(.75);
  });

  it.each([[0, 'card'], [.049999, 'card'], [.05, 'beacon'], [.249999, 'beacon'], [.25, 'none'], [.999999, 'none']] as const)
  ('partitions one roll at %s into %s, never both and never rerolls a KO', (roll, expected) => {
    const { world: w } = newMatch('exclusive-loot-rate');
    const h = spawnHippie(w, 1, { x: 20, z: 20 }); h.beacon = true;
    const rng = vi.spyOn(w.rng, 'next').mockReturnValue(roll);
    damageEntity(w, h.id, 10000, -1);
    expect(w.frickFrack.drops.length).toBe(expected === 'card' ? 1 : 0);
    expect(w.beacons.size).toBe(expected === 'beacon' ? 1 : 0);
    expect(rng).toHaveBeenCalledTimes(1);
    damageEntity(w, h.id, 10000, -1);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(w.frickFrack.drops.length + w.beacons.size).toBe(expected === 'none' ? 0 : 1);
  });

  it.each([-1, 1] as const)('does not redistribute unavailable beacon loot into cards (faction %s)', faction => {
    const { world: w } = newMatch('ineligible-beacon-loot');
    const rng = vi.spyOn(w.rng, 'next').mockReturnValue(.1);
    const h = spawnHippie(w, faction, { x: 20, z: 20 }); h.beacon = false;
    damageEntity(w, h.id, 10000, -1);
    expect(w.frickFrack.drops).toHaveLength(0); expect(w.beacons.size).toBe(0);
    rng.mockReturnValue(.01);
    const cardHippie = spawnHippie(w, faction, { x: 22, z: 20 }); cardHippie.beacon = false;
    damageEntity(w, cardHippie.id, 10000, -1);
    expect(w.frickFrack.drops).toHaveLength(1); expect(w.beacons.size).toBe(0);
    const wizard = spawnHippie(w, -1, { x: 24, z: 20 }); wizard.wizard = true;
    dropFrickFrackCard(w, wizard);
    expect(w.frickFrack.drops).toHaveLength(1);
  });

  it('replays host loot and private card faces deterministically with fixed seeds', () => {
    function trial() {
      const { world: w } = newMatch('loot-replay');
      w.rng = new Rng('beacon-loot-seed');
      resetFrickFrackEntropy(w, 'card-loot-seed');
      const outcomes: Array<[boolean, boolean]> = [];
      for (let i = 0; i < 200; i++) {
        const h = spawnHippie(w, 1, { x: 20 + i * .01, z: 20 }); h.beacon = true;
        const cards = w.frickFrack.drops.length, beacons = w.beacons.size;
        damageEntity(w, h.id, 10000, -1);
        outcomes.push([w.frickFrack.drops.length > cards, w.beacons.size > beacons]);
      }
      return { outcomes, cards: w.frickFrack.drops.map(d => d.card) };
    }
    const first = trial(); expect(trial()).toEqual(first);
    expect(first.outcomes.some(([card]) => card)).toBe(true);
    expect(first.outcomes.some(([, beacon]) => beacon)).toBe(true);
    expect(first.outcomes.some(([card, beacon]) => !card && !beacon)).toBe(true);
    expect(first.outcomes.some(([card, beacon]) => card && beacon)).toBe(false);
  });
});
