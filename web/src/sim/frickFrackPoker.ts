/** End-of-hand poker bonuses for the mixed Frick-frack shoe.
 * Rank identity is PRINTED, not an Arcana-assigned blackjack value. CCG 1 is an
 * Ace for poker only (still blackjack value 1). Ordinary J and Tarot Page match;
 * Tarot Knight is distinct; ordinary Q/K match Tarot Queen/King.
 * Straights preserve ordinary poker order A,2..10,J/Page,Q,K,A; Knight is
 * ineligible for straights (but has its own group rank). Ace is low or high,
 * never wrapping, so A-2-3-4-5 and 10-J-Q-K-A both qualify.
 * Multipliers affect WIN PROFIT only, strongest group only, never the stake.
 * A non-bust straight awards its highest printed-rank card even on a loss.
 */
import { frickFrackTotal } from './frickFrack';
import type { FrickFrackCard } from './frickFrack';
export interface FrickFrackPokerBonus {
  profitMultiplier: 1 | 2 | 3 | 4;
  /** Original card identity, not a newly minted card; settlement must clone with a fresh id. */
  straightHigh: FrickFrackCard | null;
  label: string;
}
function pokerRank(card: FrickFrackCard): number | null {
  if (card.arcana !== undefined || !Number.isInteger(card.rank) || card.rank < 1) return null;
  if (card.parody !== undefined) return card.rank <= 7 ? card.rank : null;
  if (card.tarot) return card.rank <= 14 ? card.rank : null;
  if (card.rank > 13) return null;
  return card.rank >= 12 ? card.rank + 1 : card.rank;
}
export function evaluateFrickFrackPoker(cards: readonly FrickFrackCard[], target = 21): FrickFrackPokerBonus {
  const none: FrickFrackPokerBonus = { profitMultiplier: 1, straightHigh: null, label: '' };
  // All bonuses are disabled on a bust, using actual blackjack values/ace flexibility.
  if (frickFrackTotal(cards,target) > target) return none;
  const groups = new Map<number, FrickFrackCard[]>();
  for (const card of cards) {
    const rank = pokerRank(card); if (rank === null) continue;
    const group = groups.get(rank) ?? []; group.push(card); groups.set(rank, group);
  }
  const count = Math.max(0, ...[...groups.values()].map(group => group.length));
  const profitMultiplier = count >= 4 ? 4 : count === 3 ? 3 : count === 2 ? 2 : 1;
  let straightHigh: FrickFrackCard | null = null;
  // Group ranks retain Knight=12; straight ranks exclude it and normalize Q/K.
  const straightRanks = new Map<number, FrickFrackCard>();
  for (const [rank, group] of groups) if (rank !== 12)
    straightRanks.set(rank > 12 ? rank - 1 : rank, group[0]);
  // Search strongest five-card sequence first; duplicates never extend a sequence.
  for (let high = 14; high >= 5; high--) {
    if (Array.from({length:5}, (_,i) => high-i).every(rank => straightRanks.has(rank === 14 ? 1 : rank))) {
      straightHigh = straightRanks.get(high === 14 ? 1 : high)!; break;
    }
  }
  const groupLabel = profitMultiplier === 4 ? 'Four of a kind · 4× profit' : profitMultiplier === 3 ? 'Three of a kind · 3× profit' : profitMultiplier === 2 ? 'Pair · 2× profit' : '';
  return { profitMultiplier, straightHigh, label: [groupLabel, straightHigh ? 'Straight · highest card to sleeve' : ''].filter(Boolean).join(' + ') };
}
