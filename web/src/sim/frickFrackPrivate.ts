/** Recipient-only Arcana knowledge. Never a field on World or its public snapshot. */
import type { World } from './world';
import type { FactionId } from './types';
import type { FrickFrackCard } from './frickFrack';

export interface FrickFrackPrivateView {
  sessionId: number;
  revision: number;
  kind: 'dealer' | 'next';
  cards: FrickFrackCard[];
  expiresAt: number;
}
interface Stored { view: FrickFrackPrivateView | null; sessionId: number; revision: number }
const knowledge = new WeakMap<World, Map<FactionId, Stored>>();

/** May precede its delayed public frame on a mirror; getter waits for exact revision. */
export function setFrickFrackPrivateView(w: World, f: FactionId, view: FrickFrackPrivateView | null): void {
  let map = knowledge.get(w);
  if (!map) { map = new Map(); knowledge.set(w, map); }
  const previous = map.get(f);
  if (!view) {
    if (previous) map.set(f, { ...previous, view: null });
    return;
  }
  if (!Number.isInteger(view.sessionId) || view.sessionId < 0 || !Number.isInteger(view.revision) || view.revision < 0 ||
      !Number.isFinite(view.expiresAt) || (view.kind !== 'dealer' && view.kind !== 'next') ||
      !Array.isArray(view.cards) || view.cards.length > 3) return;
  if (previous && (view.sessionId < previous.sessionId || (view.sessionId === previous.sessionId &&
      (view.revision < previous.revision || (view.revision === previous.revision && previous.view === null))))) return;
  map.set(f, { sessionId: view.sessionId, revision: view.revision, view: { ...view, cards: view.cards.map(c => ({ ...c })) } });
}

export function getFrickFrackPrivateView(w: World, f: FactionId): FrickFrackPrivateView | null {
  const view = knowledge.get(w)?.get(f)?.view, session = w.frickFrack?.sessions[f];
  if (!view || !session || session.id !== view.sessionId || session.revision !== view.revision ||
      session.phase !== 'playing' || w.phase !== 'playing' || w.time >= view.expiresAt || !w.factions[f]?.alive) return null;
  return { ...view, cards: view.cards.map(c => ({ ...c })) };
}

export function clearFrickFrackPrivateViews(w: World): void { knowledge.delete(w); }
