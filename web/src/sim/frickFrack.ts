/** Public Frick-frack state. Deck order and dealer hole cards never belong here. */
import type { FactionId } from './types';
import type { V2 } from './math';
import type { FrickFrackArcanaState } from './frickFrackArcana';
export interface FrickFrackCard {
  id: number; rank: number; suit: number;
  /** Minor Arcana: ranks 11/12/13/14 are Page/Knight/Queen/King; all worth ten. */
  tarot?: boolean;
  /** Four original parody card families; ranks 1–7 are literal values, never aces. */
  parody?: 0 | 1 | 2 | 3;
  /** Major Arcana are sideboard effects only; rank and suit are zero. */
  arcana?: number;
  /** Effect-assigned fixed numeric value; unlike a natural ace, 1 stays 1. */
  value?: number;
  temporary?: boolean;
}
export const FRICK_FRACK_PARODY_FAMILIES = ['Mana Misfits', 'Pocket Problems', 'Duel Nonsense', 'Bench Legends'] as const;
export const FRICK_FRACK_PARODY_NAMES = [
  ['Lint Goblin', 'Puddle Squire', 'Moss Accountant', 'Toast Paladin', 'Tax Dragon', 'Bog Manager', 'Elder Nuisance'],
  ['Snoozle', 'Soggo', 'Crumbat', 'Plugslug', 'Moldillo', 'Flarehare', 'Chonkodon'],
  ['Tiny Omen', 'Grudge Urn', 'Cape Fiend', 'Debt Phantom', 'Lord of Spoons', 'Doom Rooster', 'Final Paperwork'],
  ['Bunt Bixby', 'Airball Ada', 'Fumble Finn', 'Offside Olive', 'Brick Baxter', 'Turf Tessa', 'Whiff Wally'],
] as const;
/** A wizard's public remark is generated only for a card revealed to the player. */
export function frickFrackParodyRemark(card: FrickFrackCard): string {
  if (card.parody === undefined) return '';
  const name = FRICK_FRACK_PARODY_NAMES[card.parody]?.[card.rank - 1];
  return name ? `Ah, ${name}. Despite the impressive paperwork, that card is worth exactly ${card.value ?? card.rank}.` : '';
}
/** Complete 52 ordinary + 56 Minor Arcana + 28 original parody/jersey cards. No replacements. */
export function createFrickFrackDeck(nextId: () => number): FrickFrackCard[] {
  const cards: FrickFrackCard[] = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 1; rank <= 13; rank++) cards.push({ id: nextId(), rank, suit });
  for (let suit = 0; suit < 4; suit++) for (let rank = 1; rank <= 14; rank++) cards.push({ id: nextId(), rank, suit, tarot: true });
  for (const parody of [0, 1, 2, 3] as const) for (let rank = 1; rank <= 7; rank++) cards.push({ id: nextId(), rank, suit: 0, parody });
  return cards;
}
/** Rare pickups include ordinary cards, parody cards, and all 22 effect-only Major Arcana. */
export function createFrickFrackCheatCard(id: number, index: number): FrickFrackCard {
  if (!Number.isInteger(index) || index < 0 || index >= 102) throw new RangeError('Invalid cheat card index');
  if (index < 52) return { id, rank: index % 13 + 1, suit: Math.floor(index / 13) };
  if (index < 80) return { id, rank: (index - 52) % 7 + 1, suit: 0, parody: Math.floor((index - 52) / 7) as 0 | 1 | 2 | 3 };
  return { id, rank: 0, suit: 0, arcana: index - 80 };
}
export interface FrickFrackDrop { id: number; card: FrickFrackCard; pos: V2; createdAt: number }
export interface FrickFrackSession {
  id: number; revision: number; faction: FactionId;
  phase: 'chasing' | 'dialogue' | 'betting' | 'playing' | 'result' | 'empty';
  dialogueIndex: number; dialogueStartedAt: number; readyAt: number;
  wager: number; player: FrickFrackCard[]; dealer: (FrickFrackCard | null)[];
  result: 'win' | 'lose' | 'push' | null; message: string;
  /** Last public player-card remark, independent of outcome text and hidden dealer cards. */
  remark?: string;
  arcana?: FrickFrackArcanaState;
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
  for (const c of cards) if (c) {
    if (c.arcana !== undefined) continue;
    if (c.value !== undefined) total += c.value;
    else if (c.parody !== undefined) total += c.rank;
    else { total += c.rank === 1 ? 11 : Math.min(c.rank, 10); if (c.rank === 1) aces++; }
  }
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}
export const FRICK_FRACK_DROP_CHANCE = .035;
export const FRICK_FRACK_SIDEBOARD_CAP = 12;
