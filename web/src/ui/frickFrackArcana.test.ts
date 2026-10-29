import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { MAJOR_ARCANA_NAMES, majorArcanaName, majorArcanaLabel, majorArcanaAsset } from './frickFrackArcana';
describe('Major Arcana cheat art', () => {
  it('provides every original major with provenance and no implicit numeric hand value', () => {
    const sources = JSON.parse(readFileSync(new URL('../../public/cards/rider-waite/major-sources.json', import.meta.url), 'utf8'));
    expect(sources).toHaveLength(22);
    for (let arcana = 0; arcana <= 21; arcana++) {
      const card = { id: 100 + arcana, rank: 0, suit: 0, arcana };
      expect(majorArcanaName(card)).toBe(MAJOR_ARCANA_NAMES[arcana]);
      expect(majorArcanaLabel(card)).toBe(`${MAJOR_ARCANA_NAMES[arcana]} · Major Arcana cheat`);
      const file = majorArcanaAsset(card)!.split('/').at(-1)!;
      expect(existsSync(new URL(`../../public/cards/rider-waite/${file}`, import.meta.url))).toBe(true);
      expect(sources.find((s: { file: string }) => s.file === file)?.license).toBe('Public domain');
    }
  });
  it('does not produce an image for ordinary or hidden cards', () => {
    expect(majorArcanaAsset(null)).toBeNull();
    expect(majorArcanaName({ id: 1, rank: 1, suit: 0 })).toBeNull();
    expect(majorArcanaName({ id: 1, rank: 0, suit: 0, arcana: 22 })).toBeNull();
  });
});
