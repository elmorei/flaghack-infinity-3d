import { describe, expect, it } from 'vitest';
import { FRICK_FRACK_PARODY_NAMES, createFrickFrackDeck } from '../sim/frickFrack';
import { FRICK_FRACK_ARCANA } from '../sim/frickFrackArcana';
import { sleeveCardDetails } from './frickFrackSleeve';

describe('sleeve card explanations', () => {
  it('names every standard and minor card and explains numeric cards without invented effects', () => {
    let id = 0;
    for (const card of createFrickFrackDeck(() => ++id).filter(c => c.parody === undefined)) {
      const details = sleeveCardDetails(card);
      expect(details.name).not.toMatch(/Unknown|undefined/);
      expect(details.description).toContain('Add this card to your hand.');
      expect(details.description).toContain('does not fight CCG cards');
      expect(details.description).toContain('One use.');
    }
    expect(sleeveCardDetails({ id: 1, rank: 12, suit: 1, tarot: true })).toMatchObject({ name: 'Knight of Cups', family: 'Minor Arcana · Numeric card' });
    expect(sleeveCardDetails({ id: 1, rank: 12, suit: 1, tarot: true }).description).toContain('counts as 10');
    expect(sleeveCardDetails({ id: 1, rank: 12, suit: 1 }).name).toBe('Queen of Hearts');
  });
  it('distinguishes natural aces from fixed values, including temporary cards', () => {
    expect(sleeveCardDetails({ id: 1, rank: 1, suit: 0 }).description).toContain('1 or 11');
    const fixed = sleeveCardDetails({ id: 1, rank: 1, suit: 0, value: 4, temporary: true });
    expect(fixed.description).toContain('counts as 4');
    expect(fixed.description).not.toContain('1 or 11');
    expect(fixed.description).toContain('assigned value is fixed');
    expect(fixed.description).toContain('expires at the end of this hand');
  });
  it('uses authoritative names and actual combat rules for all 28 CCG/sports cards', () => {
    for (const parody of [0, 1, 2, 3] as const) for (let rank = 1; rank <= 7; rank++) {
      const details = sleeveCardDetails({ id: 1, rank, suit: 0, parody });
      expect(details.name).toBe(FRICK_FRACK_PARODY_NAMES[parody][rank - 1]);
      expect(details.description).toContain(`counts as ${rank} toward`);
      expect(details.description).not.toContain('1 or 11');
      expect(details.description).toContain('equal values defeat both');
      expect(details.description).toContain('Artwork stats and flavor text do not add abilities');
    }
    expect(sleeveCardDetails({ id: 1, rank: 1, suit: 0, parody: 3, value: 6 }).description).toContain('counts as 6 toward');
  });
  it('reuses all 22 authoritative major effect descriptions verbatim', () => {
    for (const spec of FRICK_FRACK_ARCANA) {
      const details = sleeveCardDetails({ id: 1, rank: 0, suit: 0, arcana: spec.id });
      expect(details.name).toBe(spec.name);
      expect(details.description).toContain(spec.description);
      expect(details.description).toContain('not a numeric card');
      expect(details.description).toContain('One use.');
    }
  });
  it('is pure and distinguishes copies only through caller-owned identity', () => {
    const card = Object.freeze({ id: 1, rank: 7, suit: 1 });
    expect(sleeveCardDetails(card)).toEqual(sleeveCardDetails({ ...card, id: 2 }));
    expect(card).toEqual({ id: 1, rank: 7, suit: 1 });
  });
});
