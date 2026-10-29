/** Public Frick-frack state. Deck order and dealer hole cards never belong here. */
import type { FactionId } from './types';
import type { V2 } from './math';
export interface FrickFrackCard { id: number; rank: number; suit: number }
export interface FrickFrackDrop { id: number; card: FrickFrackCard; pos: V2; createdAt: number }
export interface FrickFrackSession {
  id: number; revision: number; faction: FactionId;
  phase: 'dialogue' | 'betting' | 'playing' | 'result' | 'empty';
  dialogueIndex: number; dialogueStartedAt: number; readyAt: number;
  wager: number; player: FrickFrackCard[]; dealer: (FrickFrackCard | null)[];
  result: 'win' | 'lose' | 'push' | null; message: string;
}
export interface FrickFrackState {
  wizardId: number;
  sessions: Partial<Record<FactionId, FrickFrackSession>>;
  sideboards: Record<FactionId, FrickFrackCard[]>;
  drops: FrickFrackDrop[];
}
export const FRICK_FRACK_LETTER_SECONDS = .025;
export const FRICK_FRACK_DIALOGUE = [
  'Ah. A flag. Excellent. Before we proceed, I should explain that this is not a hat. It is a professional wizarding silhouette. The distinction is rather important to me.',
  'Now, where was I? Cards, yes. Each card has a number, except the cards that have people, who also have a number. I have prepared a very short explanation. That was most of it.',
  'Your flag is still yours to wager, naturally. The cards are shuffled, the table is metaphorical, and I have finished explaining the hat. Would you like to play Frick-frack?',
] as const;
export const FRICK_FRACK_EMPTY = 'You have no Flags left to bet. Come back when you have some more. I will be here, attending to the hat.';
export function frickFrackTextDuration(text: string): number { return text.length * FRICK_FRACK_LETTER_SECONDS + .25; }
export function createFrickFrackState(): FrickFrackState { return { wizardId: -1, sessions: {}, sideboards: { 0: [], 1: [], 2: [], 3: [] }, drops: [] }; }
export function frickFrackTotal(cards: readonly (FrickFrackCard | null)[]): number {
  let total = 0, aces = 0;
  for (const c of cards) if (c) { total += c.rank === 1 ? 11 : Math.min(c.rank, 10); if (c.rank === 1) aces++; }
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}
export const FRICK_FRACK_DROP_CHANCE = .035;
export const FRICK_FRACK_SIDEBOARD_CAP = 12;
