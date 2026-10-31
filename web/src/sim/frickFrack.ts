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
  phase: 'chasing' | 'dialogue' | 'rolling' | 'betting' | 'playing' | 'result' | 'empty';
  /** Host-selected encounter script; never changes between hands in the same visit. */
  dialogueVariant?: number;
  dialogueIndex: number; dialogueStartedAt: number; readyAt: number;
  /** Host-authoritative die and timing; fixed for one hand, including Judgement replays. */
  dieResult?: number; target?: number; rollStartedAt?: number; rollEndsAt?: number; rollNumber?: number;
  wager: number; player: FrickFrackCard[]; dealer: (FrickFrackCard | null)[];
  result: 'win' | 'lose' | 'push' | null; message: string;
  /** Last public player-card remark, independent of outcome text and hidden dealer cards. */
  remark?: string;
  arcana?: FrickFrackArcanaState;
  /** Public combat tombstones only. Never included in active hands or scoring. */
  defeated?: { card: FrickFrackCard; side: 'player' | 'dealer' }[];
  /** Order of public reveals only; hidden dealer IDs must never enter this list. */
  revealedCardOrder?: number[];
}
export interface FrickFrackState {
  wizardId: number;
  /** Completed conversation starts per faction, retained after leaving/disconnecting. */
  visits?: Partial<Record<FactionId, number>>;
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
/** Return visits cycle deterministically through six scripts, independently per faction. */
export const FRICK_FRACK_RETURN_DIALOGUES = [
  [
    'Ah, you have returned. I was just reconciling the accounts. There is one flag in the column marked flags, and a drawing of a flag in the column marked concerns.',
    'You may notice the table is in precisely the same place. This is not a lack of ambition. Moving a metaphorical table requires an exceptionally practical permit.',
    'The accounts are now approximately reconciled. Your flag remains available to wager. Would you like to play Frick-frack?',
  ],
  [
    'Welcome back. Before we begin, an announcement: the hat has passed its annual inspection. I conducted the inspection myself, but stood on the other side of it for impartiality.',
    'There was one advisory note about the brim. Nothing serious. Merely that it was behaving rather more like a brim than the original application suggested.',
    'With that important matter settled, we can turn to cards. Your flag is still yours to wager. Would you like to play Frick-frack?',
  ],
  [
    'A familiar face. Excellent. I have introduced a loyalty scheme. Every visit earns you one visit, and after several visits you will have visited several times.',
    'Please do not confuse this with the rewards programme. That is a separate piece of paper, currently underneath the loyalty scheme to stop it blowing away.',
    'Your visit has been recorded with considerable satisfaction. The flag is available to wager as usual. Would you like to play Frick-frack?',
  ],
  [
    'There you are. I was making tea. Unfortunately, I had the kettle but not the water, and the water but not in a form the kettle was prepared to discuss.',
    'I considered offering biscuits instead. Then I remembered that the biscuit tin contains spare buttons. A regrettable but surprisingly common administrative overlap.',
    'We shall have to make do with cards, which are neither tea nor biscuits but are at least present. Would you like to play Frick-frack?',
  ],
  [
    'Welcome, returning participant. I have been asked to clarify the distinction between luck and probability. Luck is what happens to you. Probability has a smaller handwriting.',
    'I wrote the full explanation on the back of a card. Naturally, I can no longer find that card without compromising the solemn mystery of the shuffle.',
    'So we shall proceed with the usual amount of uncertainty. Your flag is ready to wager. Would you like to play Frick-frack?',
  ],
  [
    'Ah, another appointment. You did not need an appointment, of course, but I have written one down now, so it would be a shame not to have arrived for it.',
    'The schedule says cards, followed by a brief discussion of cards, followed by a discretionary period in which cards may also occur. We are comfortably on time.',
    'That concludes the introductory portion of your appointment. Your flag has not been charged as an admission fee. Would you like to play Frick-frack?',
  ],
] as const;
export function frickFrackDialogue(variant = 0): readonly string[] {
  return Number.isInteger(variant) && variant >= 1 && variant <= FRICK_FRACK_RETURN_DIALOGUES.length
    ? FRICK_FRACK_RETURN_DIALOGUES[variant - 1] : FRICK_FRACK_DIALOGUE;
}
export function frickFrackDialogueVariant(previousVisits: number): number {
  return Number.isSafeInteger(previousVisits) && previousVisits > 0
    ? 1 + (previousVisits - 1) % FRICK_FRACK_RETURN_DIALOGUES.length : 0;
}
export const FRICK_FRACK_EMPTY = 'You have no Flags left to bet. Come back when you have some more. I will be here, attending to the hat.';
export function frickFrackTextDuration(text: string): number { return text.length * FRICK_FRACK_LETTER_SECONDS + .25; }
export function createFrickFrackState(): FrickFrackState { return { wizardId: -1, visits: {}, sessions: {}, sideboards: { 0: [], 1: [], 2: [], 3: [] }, drops: [] }; }
export const FRICK_FRACK_ROLL_SECONDS = 1.25;
/** Legacy snapshots and isolated fixtures without dice retain the original target. */
export function frickFrackTarget(session: Pick<FrickFrackSession, 'target'>): number {
  return Number.isInteger(session.target) && session.target! >= 21 && session.target! <= 26 ? session.target! : 21;
}
export function frickFrackTotal(cards: readonly (FrickFrackCard | null)[], target = 21): number {
  let total = 0, aces = 0;
  for (const c of cards) if (c) {
    if (c.arcana !== undefined) continue;
    if (c.value !== undefined) total += c.value;
    else if (c.parody !== undefined) total += c.rank;
    else { total += c.rank === 1 ? 11 : Math.min(c.rank, 10); if (c.rank === 1) aces++; }
  }
  while (total > target && aces-- > 0) total -= 10;
  return total;
}
export const FRICK_FRACK_DROP_CHANCE = .035;
export const FRICK_FRACK_SIDEBOARD_CAP = 12;
