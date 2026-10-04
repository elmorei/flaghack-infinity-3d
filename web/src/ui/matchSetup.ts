import { DEFAULT_MATCH, MATCH_RANGES, normalizeMatch } from '../sim/matchSettings';
import type { MatchSettings } from '../sim/matchSettings';
import { FACTION_DEFS } from '../sim/constants';
import type { FactionId } from '../sim/types';
import { el } from './dom';
/** Shared offline setup and authoritative online lobby editor. */
export class MatchSetup {
  private fields: { key: keyof MatchSettings; input: HTMLInputElement | HTMLSelectElement }[] = [];
  private camps: HTMLInputElement[] = [];
  constructor(
    parent: HTMLElement,
    private read: () => MatchSettings,
    private write: (s: MatchSettings) => void,
  ) {
    const root = el('div', 'match-setup', parent);
    el('h3', '', root, 'Game setup');
    for (let f = 0; f < 4; f++) {
      const label = el('label', 'setup-field', root);
      const input = el('input', '', label);
      input.type = 'checkbox';
      el('span', '', label, FACTION_DEFS[f as FactionId].name);
      input.addEventListener('change', () => {
        const s = normalizeMatch(this.read());
        const active = this.camps.flatMap((c, i) => (c.checked ? [i as FactionId] : []));
        if (!active.length) {
          input.checked = true;
          return;
        }
        this.write({ ...s, active });
      });
      this.camps.push(input);
    }
    const label = el('label', 'setup-field', root);
    el('span', '', label, 'Number of days');
    const days = el('select', 'field-in', label);
    for (const n of [1, 2, 3, 4, 5, 0]) {
      const o = el('option', '', days, n === 0 ? 'Unlimited' : String(n));
      o.value = String(n);
    }
    days.addEventListener('change', () => this.write({ ...normalizeMatch(this.read()), days: Number(days.value) }));
    this.fields.push({ key: 'days', input: days });
    el('p', 'panel-hint', root, 'One camp: creative / solo, ends on time. Unlimited: no scheduled Burn.');
    const advanced = el('details', '', root);
    el('summary', 'btn', advanced, 'Advanced game settings');
    const names = {
      dayLength: 'Day length (seconds)',
      gridScale: 'Lattice spacing (metres)',
      startingLumber: 'Starting lumber',
      startingFlags: 'Flags in each Hearth',
      startingSignifiers: 'Starting Signifiers',
    };
    for (const key of Object.keys(MATCH_RANGES) as (keyof typeof MATCH_RANGES)[]) {
      const row = el('label', 'setup-field', advanced);
      el('span', '', row, names[key]);
      const input = el('input', 'field-in', row);
      input.type = 'number';
      const [min, max, step] = MATCH_RANGES[key];
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.addEventListener('change', () =>
        this.write(normalizeMatch({ ...this.read(), [key]: Number(input.value) })),
      );
      this.fields.push({ key, input });
    }
    this.update();
  }
  update(enabled = true): void {
    const s = normalizeMatch(this.read() ?? DEFAULT_MATCH);
    this.camps.forEach((c, i) => {
      c.checked = s.active.includes(i as FactionId);
      c.disabled = !enabled;
    });
    for (const { key, input } of this.fields) {
      if (document.activeElement !== input) input.value = String(s[key]);
      input.disabled = !enabled;
    }
  }
}
