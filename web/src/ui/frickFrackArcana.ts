import type { FrickFrackCard } from '../sim/frickFrack';

export const MAJOR_ARCANA_NAMES = ['The Fool', 'The Magician', 'The High Priestess', 'The Empress', 'The Emperor', 'The Hierophant', 'The Lovers', 'The Chariot', 'Strength', 'The Hermit', 'Wheel of Fortune', 'Justice', 'The Hanged Man', 'Death', 'Temperance', 'The Devil', 'The Tower', 'The Star', 'The Moon', 'The Sun', 'Judgement', 'The World'] as const;
type ArcanaCard = FrickFrackCard & { arcana?: number };
export function majorArcanaName(card: ArcanaCard | null): string | null {
  const value = card?.arcana;
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 21 ? MAJOR_ARCANA_NAMES[value] : null;
}
export function majorArcanaLabel(card: ArcanaCard | null): string | null {
  const name = majorArcanaName(card);
  return name ? `${name} · Major Arcana cheat` : null;
}
export function majorArcanaAsset(card: ArcanaCard | null): string | null {
  return majorArcanaName(card) && card ? `${import.meta.env.BASE_URL}cards/rider-waite/Major${String(card.arcana).padStart(2, '0')}.webp` : null;
}
/** Arcana effects are sideboard-only. The CHEAT badge is deliberately not a hand value. */
export function renderMajorArcanaCard(tile: HTMLElement, card: ArcanaCard | null): void {
  const source = majorArcanaAsset(card), label = majorArcanaLabel(card);
  if (!source || !label) return;
  tile.classList.add('ff-arcana-card'); tile.replaceChildren(); tile.setAttribute('aria-label', label); tile.title = label;
  const image = document.createElement('img'); image.className = 'ff-arcana-art'; image.src = source; image.alt = majorArcanaName(card)!; image.draggable = false; image.decoding = 'async';
  const badge = document.createElement('span'); badge.className = 'ff-arcana-badge'; badge.textContent = 'CHEAT'; badge.setAttribute('aria-hidden', 'true');
  tile.append(image, badge);
}
