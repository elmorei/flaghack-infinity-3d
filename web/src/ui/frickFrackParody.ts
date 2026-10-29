import type { FrickFrackCard } from '../sim/frickFrack';
import { FRICK_FRACK_PARODY_FAMILIES as PARODY_FAMILIES, FRICK_FRACK_PARODY_NAMES as PARODY_NAMES } from '../sim/frickFrack';
export { PARODY_FAMILIES, PARODY_NAMES };
// Original concept-sheet rectangles. All art remains in one unmodified 1536×1024 atlas.
const COLUMNS = [[14, 212], [237, 210], [455, 211], [674, 204], [886, 203], [1098, 208], [1317, 208]] as const;
const ROWS = [[62, 284], [386, 297], [718, 279]] as const;
export function parodyCardName(card: FrickFrackCard | null): string | null {
  const family = card?.parody;
  if (family === undefined || !Number.isInteger(family) || family < 0 || family >= PARODY_NAMES.length || !Number.isInteger(card!.rank) || card!.rank < 1 || card!.rank > 7) return null;
  return PARODY_NAMES[family][card!.rank - 1];
}
export function parodyCardLabel(card: FrickFrackCard | null): string | null {
  const name = parodyCardName(card);
  return name && card ? `${name} · ${(card as FrickFrackCard & { value?: number }).value ?? card.rank}` : null;
}
export function parodyCardSprite(card: FrickFrackCard | null): { url: string; x: number; y: number; width: number; height: number } | null {
  if (!card || !parodyCardName(card) || card.parody === undefined) return null;
  if (card.parody === 3) {
    const index = card.rank - 1;
    return { url: `${import.meta.env.BASE_URL}cards/parody/bench-legends-atlas.webp`, x: index % 4 * 384 + 10, y: Math.floor(index / 4) * 512 + 8, width: 364, height: 486 };
  }
  const [x, width] = COLUMNS[card.rank - 1], [y, height] = ROWS[card.parody];
  return { url: `${import.meta.env.BASE_URL}cards/parody/frick-frack-cheat-card-atlas.webp`, x, y, width, height };
}
export function renderParodyCard(tile: HTMLElement, card: FrickFrackCard | null): void {
  const sprite = parodyCardSprite(card), label = parodyCardLabel(card);
  if (!sprite || !card || !label) return;
  tile.classList.add('ff-parody-card'); tile.replaceChildren();
  tile.setAttribute('aria-label', label); tile.title = `${label} · ${PARODY_FAMILIES[card.parody!]}`;
  const art = document.createElement('span'); art.className = 'ff-parody-art'; art.setAttribute('aria-hidden', 'true');
  art.style.backgroundImage = `url("${sprite.url}")`;
  art.style.backgroundSize = `${1536 / sprite.width * 100}% ${1024 / sprite.height * 100}%`;
  art.style.backgroundPosition = `${sprite.x / (1536 - sprite.width) * 100}% ${sprite.y / (1024 - sprite.height) * 100}%`;
  const value = document.createElement('span'); value.className = 'ff-parody-value'; value.textContent = String((card as FrickFrackCard & { value?: number }).value ?? card.rank); value.setAttribute('aria-hidden', 'true');
  tile.append(art, value);
}
