import { MAX_SEED_LENGTH } from '../net/protocol';
import type { LobbySettings } from '../net/protocol';
import { DEFAULT_MATCH, MATCH_RANGES, normalizeMatch } from '../sim/matchSettings';
import type { MatchSettings } from '../sim/matchSettings';
import { DIFFICULTIES, DIFFICULTY_INFO } from './catalog';
import { button, el, setText, show } from './dom';
import { iconSvg } from './icons';

type NumericKey = keyof typeof MATCH_RANGES;
const FIELDS: { key: NumericKey; label: string; hint: string; group: string }[] = [
  { key: 'dayLength', label: 'Day length (seconds)', hint: 'Length of one complete day and night.', group: 'Time' },
  { key: 'gridScale', label: 'Grid scale (metres)', hint: 'Spacing between Ley Lattice nodes.', group: 'World' },
  { key: 'jumpHeight', label: 'Jump height multiplier', hint: '1.0 is the original height; 2.0 jumps twice as high.', group: 'Characters' },
  { key: 'maxSignifiers', label: 'Maximum Signifiers per camp', hint: 'Hard limit for starting workers, recruits and conversions. Drum Circle capacity still applies.', group: 'Characters' },
  { key: 'startingLumber', label: 'Starting lumber', hint: 'Lumber available to each active camp.', group: 'Starting camps' },
  { key: 'startingFlags', label: 'Hearth Flags', hint: 'Stock Flags in each Hearth at the start.', group: 'Starting camps' },
  { key: 'startingSignifiers', label: 'Starting Signifiers', hint: 'Workers accompanying each active character.', group: 'Starting camps' },
];

/** Lobby duration control and a separate, scrollable editor shared by local and hosted games. */
export class MatchSetup {
  private fields: { key: NumericKey | 'days'; input: HTMLInputElement | HTMLSelectElement }[] = [];
  private modal: HTMLElement;
  private box: HTMLElement;
  private opener: HTMLButtonElement;
  private reset: HTMLButtonElement;
  private difficulty: HTMLSelectElement;
  private seed: HTMLInputElement;
  private random: HTMLButtonElement;
  private structures: HTMLInputElement;
  private summary: HTMLElement;
  private note: HTMLElement;
  private enabled = false;
  private opened = false;
  private returnFocus: HTMLElement | null = null;
  private lobbyRoot: HTMLElement | null;

  constructor(
    parent: HTMLElement,
    overlay: HTMLElement,
    private read: () => LobbySettings,
    private write: (s: Partial<LobbySettings>) => void,
  ) {
    this.lobbyRoot = parent.closest('.lobby');
    const root = el('div', 'match-setup', parent);
    this.daysField(root);
    this.summary = el('p', 'panel-hint', root);
    this.opener = button('btn btn-gold', root, 'Advanced Game Settings', () => this.open());

    this.modal = el('div', 'modal advanced-settings ix is-off', overlay);
    this.box = el('div', 'modal-box frame advanced-box', this.modal);
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-modal', 'true');
    this.box.setAttribute('aria-labelledby', 'advanced-settings-title');
    this.box.tabIndex = -1;
    const head = el('div', 'modal-head', this.box);
    el('h2', '', head, 'Advanced Game Settings').id = 'advanced-settings-title';
    const close = button('panel-x', head, iconSvg('close'), () => this.close(), 'back');
    close.setAttribute('aria-label', 'Close advanced game settings');
    const scroll = el('div', 'advanced-scroll', this.box);
    this.note = el('p', 'panel-hint', scroll);

    const rules = el('section', 'advanced-section', scroll);
    el('h3', '', rules, 'Match');
    this.daysField(rules);
    const diffRow = el('label', 'setup-field', rules);
    el('span', '', diffRow, 'Rival difficulty');
    this.difficulty = el('select', 'field-in', diffRow);
    for (const d of DIFFICULTIES) el('option', '', this.difficulty, DIFFICULTY_INFO[d].name).value = d;
    this.difficulty.addEventListener('change', () => {
      const difficulty = DIFFICULTIES.find((d) => d === this.difficulty.value);
      if (this.enabled && difficulty) this.write({ difficulty });
    });
    const seedRow = el('label', 'setup-field', rules);
    el('span', '', seedRow, 'World seed');
    this.seed = el('input', 'field-in setup-seed', seedRow);
    this.seed.type = 'text';
    this.seed.maxLength = MAX_SEED_LENGTH;
    this.seed.placeholder = 'Random each match';
    this.seed.autocomplete = 'off';
    this.seed.spellcheck = false;
    this.seed.addEventListener('change', () => {
      if (this.enabled) this.write({ seed: this.seed.value.trim() || null });
    });
    this.random = button('btn btn-small', rules, 'Use random seed', () => {
      if (this.enabled) {
        this.seed.value = '';
        this.write({ seed: null });
      }
    });

    const structureRow = el('label', 'setup-field', rules);
    const structureLabel = el('span', '', structureRow, 'Structures block flag placement');
    el('small', 'setup-hint', structureLabel, 'Reserve the corner nodes of camp buildings. Off by default; terrain and crystals still block placement.');
    this.structures = el('input', '', structureRow);
    this.structures.type = 'checkbox';
    this.structures.addEventListener('change', () => {
      if (this.enabled) this.changeMatch({ structuresBlockFlagPlacement: this.structures.checked });
    });

    let group = '';
    let section = rules;
    for (const def of FIELDS) {
      if (def.group !== group) {
        group = def.group;
        section = el('section', 'advanced-section', scroll);
        el('h3', '', section, group);
      }
      const row = el('label', 'setup-field', section);
      const label = el('span', '', row, def.label);
      el('small', 'setup-hint', label, def.hint);
      const input = el('input', 'field-in', row);
      input.type = 'number';
      const [min, max, step] = MATCH_RANGES[def.key];
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.addEventListener('change', () => {
        if (!this.enabled) return;
        const value = input.valueAsNumber;
        if (Number.isFinite(value)) this.changeMatch({ [def.key]: value });
        else input.value = String(normalizeMatch(this.read().match)[def.key]);
      });
      input.addEventListener('blur', () => this.update(this.enabled));
      this.fields.push({ key: def.key, input });
    }

    const foot = el('div', 'modal-foot', this.box);
    this.reset = button('btn', foot, 'Reset defaults', () => {
      if (!this.enabled) return;
      this.write({ match: { ...DEFAULT_MATCH, active: [...normalizeMatch(this.read().match).active] }, difficulty: 'normal', seed: null });
    });
    button('btn btn-primary', foot, 'Done', () => this.close(), 'back');
    this.modal.addEventListener('click', (ev) => { if (ev.target === this.modal) this.close(); });
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('fh-menu-back', this.onMenuBack);
  }

  get isOpen(): boolean { return this.opened; }

  private daysField(parent: HTMLElement): void {
    const row = el('label', 'setup-field', parent);
    el('span', '', row, 'Number of days');
    const input = el('select', 'field-in', row);
    for (const n of [1, 2, 3, 4, 5, 0]) el('option', '', input, n === 0 ? 'Unlimited' : String(n)).value = String(n);
    input.addEventListener('change', () => { if (this.enabled) this.changeMatch({ days: Number(input.value) }); });
    this.fields.push({ key: 'days', input });
  }

  private changeMatch(patch: Partial<MatchSettings>): void {
    this.write({ match: normalizeMatch({ ...this.read().match, ...patch }) });
  }

  private open(): void {
    this.opened = true;
    this.returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : this.opener;
    this.update(this.enabled);
    show(this.modal, true);
    if (this.lobbyRoot) this.lobbyRoot.inert = true;
    this.box.focus();
  }

  close(restoreFocus = true): void {
    if (!this.opened) return;
    if (document.activeElement instanceof HTMLElement && this.box.contains(document.activeElement)) document.activeElement.blur();
    this.opened = false;
    show(this.modal, false);
    if (this.lobbyRoot) this.lobbyRoot.inert = false;
    if (restoreFocus) this.returnFocus?.focus();
  }

  private onKey = (ev: KeyboardEvent): void => {
    if (!this.opened) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.close();
    } else if (ev.key === 'Tab') {
      const focusable = Array.from(this.box.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (ev.shiftKey && (document.activeElement === first || document.activeElement === this.box)) {
        ev.preventDefault(); last?.focus();
      } else if (!ev.shiftKey && (document.activeElement === last || document.activeElement === this.box)) {
        ev.preventDefault(); first?.focus();
      }
    } else if (ev.key === 'Enter' && document.activeElement instanceof HTMLInputElement) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      document.activeElement.blur();
      this.box.focus();
    }
  };

  private onMenuBack = (ev: Event): void => {
    if (!this.opened) return;
    ev.preventDefault();
    this.close();
  };

  update(enabled = true): void {
    this.enabled = enabled;
    const settings = this.read();
    const s = normalizeMatch(settings.match);
    this.structures.checked = s.structuresBlockFlagPlacement;
    this.structures.disabled = !enabled;
    for (const { key, input } of this.fields) {
      if (document.activeElement !== input || !enabled) input.value = key === 'jumpHeight' ? s[key].toFixed(1) : String(s[key]);
      if (key === 'startingSignifiers') (input as HTMLInputElement).max = String(Math.min(MATCH_RANGES.startingSignifiers[1], s.maxSignifiers));
      input.disabled = !enabled;
    }
    if (document.activeElement !== this.difficulty || !enabled) this.difficulty.value = settings.difficulty;
    if (document.activeElement !== this.seed || !enabled) this.seed.value = settings.seed ?? '';
    this.difficulty.disabled = this.seed.disabled = this.reset.disabled = this.random.disabled = !enabled;
    setText(this.note, enabled ? 'Changes apply to the next match. Player seats are set in the lobby.' : 'View only. The lobby leader can change settings before the match starts.');
    const duration = s.days === 0 ? 'Unlimited · no scheduled Burn.' : `${s.days} ${s.days === 1 ? 'day' : 'days'} · ${Math.round(s.days * s.dayLength / 60)} minutes · Burn on the last night.`;
    const solo = s.days === 0 ? 'solo / creative, no time limit' : 'solo / creative, ends on time';
    setText(this.summary, `${s.active.length} ${s.active.length === 1 ? `camp · ${solo}` : 'active camps'}. ${duration}`);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('fh-menu-back', this.onMenuBack);
    this.modal.remove();
  }
}
