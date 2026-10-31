import type { FrickFrackCard } from '../sim/frickFrack';
import { FRICK_FRACK_PARODY_FAMILIES } from '../sim/frickFrack';
import { FRICK_FRACK_ARCANA, frickFrackCardValue } from '../sim/frickFrackArcana';
import { tarotCardName } from './frickFrackTarot';
import { parodyCardName } from './frickFrackParody';

export interface SleeveCardDetails { name: string; family: string; description: string }
const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const RANKS: Record<number, string> = { 1: 'Ace', 11: 'Jack', 12: 'Queen', 13: 'King' };

/** Presentation of an already-entitled sleeve card. No deck/private-hand access,
 * invented artwork abilities, command submission, or eligibility inference. */
export function sleeveCardDetails(card: FrickFrackCard): SleeveCardDetails {
  const lifetime = card.temporary
    ? 'One use. This temporary card expires at the end of this hand.'
    : 'One use. Playing it removes this copy from your sleeve.';
  if (card.arcana !== undefined) {
    const spec = FRICK_FRACK_ARCANA[card.arcana];
    return {
      name: spec?.name ?? 'Unknown Major Arcana',
      family: 'Major Arcana · One-use effect',
      description: `${spec?.description ?? 'This card has no supported effect.'} This is an effect, not a numeric card added to your hand. ${lifetime}`,
    };
  }
  const naturalAce = card.value === undefined && card.parody === undefined && card.rank === 1;
  const value = naturalAce ? '1 or 11 (automatically reduced to 1 to avoid busting)' : String(frickFrackCardValue(card));
  const base = `Add this card to your hand. It counts as ${value} toward the rolled target.`;
  if (card.parody !== undefined) {
    return {
      name: parodyCardName(card) ?? 'Unknown CCG card',
      family: `${FRICK_FRACK_PARODY_FAMILIES[card.parody] ?? 'CCG'} · ${card.parody === 3 ? 'Sports card' : 'CCG card'}`,
      description: `${base} On reveal, it fights opposing CCG and sports cards: the lower value is defeated; equal values defeat both. Friendly cards, ordinary cards, and tarot cards do not fight. Defeated cards stop counting. Artwork stats and flavor text do not add abilities. ${lifetime}`,
    };
  }
  return {
    name: tarotCardName(card) ?? `${RANKS[card.rank] ?? card.rank} of ${SUITS[card.suit] ?? 'Unknown suit'}`,
    family: card.tarot ? 'Minor Arcana · Numeric card' : 'Standard · Numeric card',
    description: `${base} It does not fight CCG cards.${card.value !== undefined ? ' Its assigned value is fixed.' : ''} ${lifetime}`,
  };
}
