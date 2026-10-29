import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { tarotCardAsset, tarotCardLabel, tarotCardName } from './frickFrackTarot';
describe('Rider–Waite minor arcana presentation', () => {
  it('keeps standard and hidden cards out of the artwork resolver', () => {
    expect(tarotCardAsset(null)).toBeNull();
    expect(tarotCardLabel({ id: 1, rank: 12, suit: 1 })).toBeNull();
  });
  it('names every tarot court explicitly with the unchanged ten value', () => {
    for (const [rank, name] of [[11, 'Page'], [12, 'Knight'], [13, 'Queen'], [14, 'King']] as const)
      expect(tarotCardLabel({ id: rank, rank, suit: 1, tarot: true })).toBe(`${name} of Cups · 10`);
    expect(tarotCardLabel({ id: 1, rank: 1, suit: 0, tarot: true })).toBe('Ace of Swords · 1 or 11');
    expect(tarotCardLabel({ id: 3, rank: 3, suit: 2, tarot: true })).toBe('3 of Pentacles · 3');
    expect(tarotCardLabel({ id: 3, rank: 3, suit: 2, tarot: true, value: 4 } as Parameters<typeof tarotCardLabel>[0])).toBe('3 of Pentacles · 4');
  });
  it('contains all 56 authentic minor-card assets and their provenance', () => {
    const sources = JSON.parse(readFileSync(new URL('../../public/cards/rider-waite/sources.json', import.meta.url), 'utf8'));
    expect(sources).toHaveLength(56);
    for (let suit = 0; suit < 4; suit++) for (let rank = 1; rank <= 14; rank++) {
      const card = { id: 100 + suit * 14 + rank, rank, suit, tarot: true };
      expect(tarotCardName(card)).not.toBeNull();
      const filename = tarotCardAsset(card)!.split('/').at(-1)!;
      expect(existsSync(new URL(`../../public/cards/rider-waite/${filename}`, import.meta.url))).toBe(true);
      expect(sources.find((s: { file: string }) => s.file === filename)?.license).toBe('Public domain');
    }
  });
});
