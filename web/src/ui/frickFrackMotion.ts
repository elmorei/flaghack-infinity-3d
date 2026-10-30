/** Cosmetic choreography from PUBLIC table state only. Never draws or scores cards. */
import type { FrickFrackSession } from '../sim/frickFrack';
import { frickFrackTableCards } from '../sim/frickFrackTable';
export type TableSide = 'player' | 'dealer';
export interface MotionCard { key: string; side: TableSide; index: number; hidden: boolean }
export interface TableSnapshot { sessionId: number; cards: MotionCard[] }
export interface CardMotion { key: string; kind: 'deal' | 'reveal'; delay: number; hidden: boolean }
export const DEAL_MS = 430;
export const FLIP_MS = 260;
export const DEAL_STAGGER_MS = 105;
export function tableSnapshot(s: FrickFrackSession): TableSnapshot {
  return { sessionId: s.id, cards: (['dealer', 'player'] as const).flatMap(side =>
    frickFrackTableCards(s, side).map(({card}, index, row) => ({
      key: card ? `card:${card.id}` : `${side}:hidden:${row.slice(0, index).filter(entry => entry.card === null).length}`, side, index, hidden: card === null,
    }))) };
}
/** Hole-card identity only enters the presentation after the authority reveals it. */
export function planCardMotion(previous: TableSnapshot | null, next: TableSnapshot): CardMotion[] {
  const before = previous?.sessionId === next.sessionId ? previous.cards : [];
  const known = new Set(before.map(c => c.key));
  const fresh = next.cards.filter(c => !known.has(c.key));
  let revealSlots = Math.max(0, before.filter(c => c.side === 'dealer' && c.hidden).length - next.cards.filter(c => c.side === 'dealer' && c.hidden).length);
  const firstDeal = before.length === 0;
  // Alternate hands for the opening deal; later draws retain each hand's public order.
  fresh.sort((a,b) => firstDeal ? a.index - b.index || (a.side === 'player' ? -1 : 1) :
    (a.side === b.side ? a.index - b.index : a.side === 'dealer' ? -1 : 1));
  return fresh.map((card, order) => {
    const reveal = !firstDeal && card.side === 'dealer' && !card.hidden && revealSlots > 0;
    if (reveal) revealSlots--;
    return { key: card.key, kind: reveal ? 'reveal' : 'deal', hidden: card.hidden, delay: order * DEAL_STAGGER_MS };
  });
}
export function motionDuration(motion: CardMotion): number {
  return motion.kind === 'reveal' ? FLIP_MS : DEAL_MS + (motion.hidden ? 0 : FLIP_MS);
}
