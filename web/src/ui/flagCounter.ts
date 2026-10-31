import { el, html } from './dom';
import { iconSvg } from './icons';
/** Shared gameplay resource typography, icon and number format. */
export function flagCounter(parent: HTMLElement): { root: HTMLElement; value: HTMLElement } {
  const root = el('div', 'res-flags', parent);
  html('span', 'res-flag-ic', iconSvg('flag'), root).setAttribute('aria-hidden', 'true');
  const value = el('span', 'res-flags-n num', root, '0');
  el('span', 'res-flags-l', root, 'FLAGS');
  return { root, value };
}
