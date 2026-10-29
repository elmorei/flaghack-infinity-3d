import type { FrickFrackCard } from '../sim/frickFrack';

const SUITS = ['Swords', 'Cups', 'Pentacles', 'Wands'] as const;
const FILE_SUITS = ['Swords', 'Cups', 'Pents', 'Wands'] as const;
const COURTS: Record<number, string> = { 11: 'Page', 12: 'Knight', 13: 'Queen', 14: 'King' };

/** Tarot is a separate 56-card family, never a reinterpretation of standard court ranks. */
export function tarotCardName(card: FrickFrackCard | null): string | null {
  if (!card?.tarot || !Number.isInteger(card.rank) || card.rank < 1 || card.rank > 14 || !SUITS[card.suit]) return null;
  return `${card.rank === 1 ? 'Ace' : COURTS[card.rank] ?? card.rank} of ${SUITS[card.suit]}`;
}
export function tarotCardLabel(card: FrickFrackCard | null): string | null {
  const name = tarotCardName(card);
  const override = (card as (FrickFrackCard & { value?: number }) | null)?.value;
  return name && card ? `${name} · ${override ?? (card.rank === 1 ? '1 or 11' : Math.min(card.rank, 10))}` : null;
}
export function tarotCardAsset(card: FrickFrackCard | null): string | null {
  if (!tarotCardName(card) || !card) return null;
  return `${import.meta.env.BASE_URL}cards/rider-waite/${FILE_SUITS[card.suit]}${String(card.rank).padStart(2, '0')}.webp`;
}
/** Render only known cards. A hidden dealer card must not cause an artwork request. */
export function renderFrickFrackCard(tile: HTMLElement, card: FrickFrackCard | null): void {
  const source = tarotCardAsset(card), label = tarotCardLabel(card);
  if (!card || !source || !label) return;
  tile.classList.add('ff-tarot-card');
  tile.replaceChildren();
  tile.setAttribute('aria-label', label);
  tile.title = label;
  const image = document.createElement('img');
  image.className = 'ff-tarot-art'; image.src = source; image.alt = tarotCardName(card)!;
  image.draggable = false; image.decoding = 'async';
  const value = document.createElement('span');
  const override = (card as FrickFrackCard & { value?: number }).value;
  value.className = 'ff-tarot-value'; value.textContent = override === undefined ? (card.rank === 1 ? '1 / 11' : String(Math.min(card.rank, 10))) : String(override);
  value.setAttribute('aria-hidden', 'true');
  tile.append(image, value);
}
