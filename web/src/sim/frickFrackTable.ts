import type { FrickFrackCard, FrickFrackSession } from './frickFrack';
export interface FrickFrackTableCard { card: FrickFrackCard | null; defeated: boolean }
/** Presentation-only merge. Tombstones never enter the authoritative playable hands. */
export function frickFrackTableCards(session: FrickFrackSession, side: 'player' | 'dealer'): FrickFrackTableCard[] {
  const active: readonly (FrickFrackCard | null)[] = session[side];
  const ids = new Set(active.filter((c): c is FrickFrackCard => c !== null).map(c => c.id));
  const cards: FrickFrackTableCard[] = active.map(card => ({card, defeated:false}));
  for (const entry of session.defeated ?? []) {
    if (entry.side !== side || ids.has(entry.card.id)) continue;
    ids.add(entry.card.id); cards.push({card:entry.card, defeated:true});
  }
  const order = new Map((session.revealedCardOrder ?? []).map((id, index) => [id,index]));
  return cards.sort((a,b) => (a.card ? order.get(a.card.id) ?? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER) -
    (b.card ? order.get(b.card.id) ?? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER));
}
