import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { PARODY_NAMES, parodyCardName, parodyCardLabel, parodyCardSprite } from './frickFrackParody';
describe('Original parody card atlas', () => {
  it('maps all 28 unique card names and literal values to bounded sprite rectangles', () => {
    const names = new Set<string>();
    for (const parody of [0, 1, 2, 3] as const) for (let rank = 1; rank <= 7; rank++) {
      const card = { id: parody * 7 + rank, rank, suit: 0, parody };
      const sprite = parodyCardSprite(card)!;
      expect(parodyCardName(card)).toBe(PARODY_NAMES[parody][rank - 1]);
      expect(parodyCardLabel(card)).toBe(`${PARODY_NAMES[parody][rank - 1]} · ${rank}`);
      expect(sprite.x + sprite.width).toBeLessThanOrEqual(1536);
      expect(sprite.y + sprite.height).toBeLessThanOrEqual(1024);
      names.add(parodyCardName(card)!);
    }
    expect(names.size).toBe(28);
    expect(existsSync(new URL('../../public/cards/parody/frick-frack-cheat-card-atlas.webp', import.meta.url))).toBe(true);
  });
  it('uses the original sports atlas for jersey values one through seven', () => {
    expect(existsSync(new URL('../../public/cards/parody/bench-legends-atlas.webp', import.meta.url))).toBe(true);
    for (let rank = 1; rank <= 7; rank++) {
      const card = { id: rank, rank, suit: 0, parody: 3 as const };
      expect(parodyCardSprite(card)?.url).toContain('bench-legends-atlas.webp');
      expect(parodyCardLabel(card)).toContain(` · ${rank}`);
    }
  });
  it('does not reveal hidden cards or treat a normal ace as a parody one', () => {
    expect(parodyCardSprite(null)).toBeNull();
    expect(parodyCardLabel({ id: 1, rank: 1, suit: 0 })).toBeNull();
    expect(parodyCardLabel({ id: 1, rank: 1, suit: 0, parody: 0 })).toBe('Lint Goblin · 1');
    expect(parodyCardLabel({ id: 1, rank: 1, suit: 0, parody: 0, value: 4 } as Parameters<typeof parodyCardLabel>[0])).toBe('Lint Goblin · 4');
    expect(parodyCardLabel({ id: 1, rank: 8, suit: 0, parody: 0 })).toBeNull();
  });
});
