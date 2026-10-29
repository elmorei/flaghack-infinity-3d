import { describe, expect, it } from 'vitest';
import type { FrickFrackCard } from './frickFrack';
import { resolveFrickFrackBattle } from './frickFrackBattle';
const ccg = (id: number, rank: number, parody: 0 | 1 | 2 | 3 = 0): FrickFrackCard => ({id, rank, suit: 0, parody});
describe('Frick-frack public CCG battles', () => {
  it('removes weaker opponent across hands and families', () => {
    const p = [ccg(1, 5)], d = [ccg(2, 3, 2)];
    expect(resolveFrickFrackBattle(p, d, 1, [2, 1]).removedIds).toEqual([2]);
    expect(p).toHaveLength(1); expect(d).toHaveLength(0);
  });
  it('never fights friendly cards on the same side', () => {
    const p = [ccg(1, 6), ccg(2, 2, 1)], d: FrickFrackCard[] = [];
    expect(resolveFrickFrackBattle(p, d, 2).removedIds).toEqual([]);
    expect(p.map(c => c.id)).toEqual([1, 2]);
    expect(resolveFrickFrackBattle([], p, 2).removedIds).toEqual([]);
  });
  it('both die on a tie and the reveal chain ends', () => {
    const p = [ccg(1, 4), ccg(3, 1)], d = [ccg(2, 4)];
    expect(resolveFrickFrackBattle(p, d, 2, [1, 3, 2]).removedIds).toEqual([2, 1]);
    expect(p.map(c => c.id)).toEqual([3]); expect(d).toHaveLength(0);
  });
  it('resolves older visible cards in reveal order, not hand order', () => {
    const p = [ccg(3, 5)], d = [ccg(2, 6), ccg(1, 2, 3)];
    expect(resolveFrickFrackBattle(p, d, 3, [1, 2, 3]).removedIds).toEqual([1, 3]);
    expect(d.map(c => c.id)).toEqual([2]);
  });
  it('does not fight standard or Tarot cards or a hidden/not-present card', () => {
    const p: FrickFrackCard[] = [{id: 1, rank: 10, suit: 1}, {id: 2, rank: 10, suit: 2, tarot: true}, ccg(3, 2)];
    expect(resolveFrickFrackBattle(p, [], 1).removedIds).toEqual([]);
    expect(resolveFrickFrackBattle(p, [], 2).removedIds).toEqual([]);
    expect(resolveFrickFrackBattle(p, [], 999).removedIds).toEqual([]);
    expect(resolveFrickFrackBattle(p, [], 3).removedIds).toEqual([]);
    expect(p).toHaveLength(3);
  });
  it('uses current explicit values after effects rather than printed ranks', () => {
    const p = [{...ccg(1, 7), value: 4}], d = [ccg(2, 5)];
    expect(resolveFrickFrackBattle(p, d, 2).removedIds).toEqual([1]);
  });
});
