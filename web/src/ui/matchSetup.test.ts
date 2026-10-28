import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MATCH, UNLIMITED_DAYS, normalizeMatch } from '../sim/matchSettings';
import type { LobbySettings } from '../net/protocol';
import { MatchSetup } from './matchSetup';
import { Session } from '../game/session';
import { SettingsPanel } from './settings';
import type { UiHost } from './core';

/** Small DOM contract: menu choices, mirrored controls, permissions and reset behavior. */
class Element extends EventTarget {
  className = ''; textContent = ''; innerHTML = ''; value = ''; disabled = false; checked = false;
  min = ''; max = ''; step = '';
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  dataset: Record<string, string> = {};
  children: Element[] = []; parentElement: Element | null = null;
  attributes = new Map<string, string>();
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, on: boolean) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (on) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    },
  };
  constructor(readonly tagName: string) { super(); }
  appendChild(node: Element) { node.parentElement = this; this.children.push(node); return node; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  closest() { return null; }
  focus() {}
  blur() {}
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); }
}

function descendants(node: Element): Element[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function menuText(...roots: Element[]): string {
  return roots.flatMap(descendants).flatMap(node => [node.textContent, node.innerHTML, ...node.attributes.values()]).join(' ');
}

function setup() {
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag), activeElement: null });
  vi.stubGlobal('window', new EventTarget());
  const root = new Element('div'), overlay = new Element('div');
  let settings: LobbySettings = { difficulty: 'hard', seed: 'fixed', match: normalizeMatch({ active: [0, 2] }) };
  const write = vi.fn((patch: Partial<LobbySettings>) => { settings = { ...settings, ...patch }; });
  const ui = new MatchSetup(root as unknown as HTMLElement, overlay as unknown as HTMLElement, () => settings, write);
  ui.update();
  const days = [...descendants(root), ...descendants(overlay)].filter((node) => node.tagName === 'select' && node.children.some((child) => child.value === String(UNLIMITED_DAYS)));
  return { ui, root, overlay, days, write, read: () => settings };
}

afterEach(() => vi.unstubAllGlobals());

describe('zero-day match setup', () => {
  it('offers distinct zero-day and Unlimited choices in the lobby and advanced settings', () => {
    const { ui, root, days, read } = setup();
    expect(days).toHaveLength(2);
    for (const field of days) {
      expect(field.children.map((option) => option.value)).toEqual(['0', '1', '2', '3', '4', '5', '-1']);
      expect(field.children[0].textContent).toBe('0 · Start at The Burn');
      expect(field.children[6].textContent).toBe('Unlimited');
    }
    days[0].value = '0';
    days[0].dispatchEvent(new Event('change'));
    ui.update();
    expect(read().match?.days).toBe(0);
    expect(days.map((field) => field.value)).toEqual(['0', '0']);
    expect(descendants(root).find((node) => node.className === 'panel-hint')?.textContent).toContain('Burn starts immediately.');
    days[1].value = String(UNLIMITED_DAYS);
    days[1].dispatchEvent(new Event('change'));
    ui.update();
    expect(read().match?.days).toBe(UNLIMITED_DAYS);
    expect(days.map((field) => field.value)).toEqual(['-1', '-1']);
    expect(descendants(root).find((node) => node.className === 'panel-hint')?.textContent).toContain('Unlimited · no scheduled Burn.');
    ui.dispose();
  });

  it('resets zero days to the default schedule while preserving enabled seats', () => {
    const { ui, overlay, days, read } = setup();
    days[0].value = '0';
    days[0].dispatchEvent(new Event('change'));
    const reset = descendants(overlay).find((node) => node.innerHTML === 'Reset defaults')!;
    reset.dispatchEvent(new Event('click'));
    ui.update();
    expect(read()).toEqual({ difficulty: 'normal', seed: null, match: { ...DEFAULT_MATCH, active: [0, 2] } });
    expect(days.map((field) => field.value)).toEqual(['1', '1']);
    ui.dispose();
  });

  it('keeps guest controls read-only even if a change event is dispatched', () => {
    const { ui, overlay, days, write } = setup();
    ui.update(false);
    for (const field of days) {
      expect(field.disabled).toBe(true);
      field.value = '0';
      field.dispatchEvent(new Event('change'));
    }
    const inputs = descendants(overlay).filter(node => node.tagName === 'input');
    expect(inputs.every(input => input.disabled)).toBe(true);
    for (const input of inputs) {
      input.value = '100';
      input.dispatchEvent(new Event('change'));
    }
    descendants(overlay).find((node) => node.innerHTML === 'Reset defaults')!.dispatchEvent(new Event('click'));
    expect(write).not.toHaveBeenCalled();
    ui.dispose();
  });
});


describe('Flag hoarding setting', () => {
  it('edits, validates, locks for guests and resets the base threshold', () => {
    const { ui, overlay, read } = setup();
    const field = descendants(overlay).find(node => node.tagName === 'label' && node.children.some(c => c.textContent === 'Flag hoarding threshold'))!.children.find(c => c.tagName === 'input')!;
    expect(field.value).toBe('24');
    expect([field.min, field.max, field.step]).toEqual(['0', '1000', '1']);
    field.value = '42.9'; field.dispatchEvent(new Event('change')); ui.update();
    expect(read().match?.hoardThreshold).toBe(42);
    field.value = ''; field.dispatchEvent(new Event('change'));
    expect(field.value).toBe('42');
    ui.update(false);
    field.value = '50'; field.dispatchEvent(new Event('change'));
    expect(read().match?.hoardThreshold).toBe(42);
    ui.update(true);
    descendants(overlay).find(node => node.innerHTML === 'Reset defaults')!.dispatchEvent(new Event('click')); ui.update();
    expect(read().match?.hoardThreshold).toBe(24);
    ui.dispose();
  });
});


describe('surprise encounter menu privacy', () => {
  it('omits encounter controls, hints and accessibility spoilers for every schedule, seat count and host permission', () => {
    const { ui, root, overlay, write, read } = setup();
    const fields = descendants(overlay).filter(node => node.tagName === 'label' && node.className === 'setup-field');
    expect(fields.flatMap(node => node.children.map(child => child.textContent))).not.toContain('Boss HP');
    expect(fields.flatMap(node => node.children.map(child => child.textContent))).not.toContain('Boss mode');
    expect(read().match).toMatchObject({ bossMode: true, bossHp: 50000 });
    for (const days of [0, 1, 2, 3, 4, 5, UNLIMITED_DAYS]) {
      for (const active of [[0], [0, 2]] as const) {
        for (const bossMode of [true, false]) {
          write({ match: normalizeMatch({ days, active: [...active], bossMode }) });
          for (const enabled of [true, false]) {
            ui.update(enabled);
            expect(menuText(root, overlay)).not.toMatch(/boss|encounter|giant|effigy|reveal|allies|90 seconds|shared victory/i);
          }
        }
      }
    }
    // Current explicit options remain intact even though the menu no longer edits them.
    write({ match: normalizeMatch({ days: 1, bossMode: false, bossHp: 72500 }) });
    const days = descendants(root).find(node => node.tagName === 'select')!;
    ui.update(true);
    days.value = '0'; days.dispatchEvent(new Event('change'));
    expect(read().match).toMatchObject({ days: 0, bossMode: false, bossHp: 72500 });
    descendants(overlay).find(node => node.innerHTML === 'Reset defaults')!.dispatchEvent(new Event('click'));
    expect(read().match).toMatchObject({ bossMode: true, bossHp: 50000 });
    ui.dispose();
  });

  it.each(['title', 'paused'] as const)('keeps the general settings panel spoiler-free on %s', screen => {
    const { ui, overlay } = setup();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
    const session = new Session(); session.screen = screen; session.panels.settings = true;
    const panel = new SettingsPanel({ app: { session } } as UiHost, overlay as unknown as HTMLElement);
    panel.update(null, 0);
    expect(menuText(overlay)).not.toMatch(/boss|encounter|giant|effigy|reveal|allies|90 seconds|shared victory/i);
    expect(menuText(overlay)).toContain('Master volume');
    expect(menuText(overlay)).toContain('Customize controls');
    panel.dispose(); ui.dispose();
  });
});


describe('population and jump setup', () => {
  it('shows editable new defaults, honors custom choices, and resets on request', () => {
    const { ui, overlay, read } = setup();
    const field = (label: string) => descendants(overlay).find(node => node.tagName === 'label' && node.children.some(c => c.textContent === label))!.children.find(c => c.tagName === 'input')!;
    const jump = field('Jump height multiplier'), population = field('Maximum Signifiers (whole world)');
    expect([jump.value, population.value]).toEqual(['3.0', '200']);
    jump.value = '1'; jump.dispatchEvent(new Event('change'));
    population.value = '40'; population.dispatchEvent(new Event('change'));
    ui.update();
    expect(read().match).toMatchObject({ jumpHeight: 1, maxSignifiers: 40 });
    expect([jump.value, population.value]).toEqual(['1.0', '40']);
    descendants(overlay).find(node => node.innerHTML === 'Reset defaults')!.dispatchEvent(new Event('click'));
    ui.update();
    expect([jump.value, population.value]).toEqual(['3.0', '200']);
    ui.dispose();
  });
});


describe('optional rule setup', () => {
  const labels = ['Building Capture', 'Crystal Flag Protection', 'Defense Lightning'];
  const keys = ['buildingCapture', 'crystalFlagProtection', 'crystalAttacks'] as const;
  it('edits all combinations independently, mirrors read-only choices, and resets all on without changing seats', () => {
    const { ui, overlay, root, read, write } = setup();
    const fields = labels.map(label => descendants(overlay).find(node => node.tagName === 'label' && node.children.some(c => c.textContent === label))!.children.find(c => c.tagName === 'input')!);
    expect(fields.map(f => f.checked)).toEqual([true, true, true]);
    for (let mask = 0; mask < 8; mask++) {
      fields.forEach((f, bit) => { f.checked = !!(mask & (1 << bit)); f.dispatchEvent(new Event('change')); });
      ui.update();
      fields.forEach((f, bit) => expect(f.checked).toBe(read().match?.[keys[bit]]));
      expect(keys.map(k => read().match?.[k])).toEqual(fields.map(f => f.checked));
    }
    ui.update(false); write.mockClear();
    fields.forEach(f => { expect(f.disabled).toBe(true); f.checked = false; f.dispatchEvent(new Event('change')); });
    expect(write).not.toHaveBeenCalled();
    ui.update(false); expect(fields.every(f => f.checked)).toBe(true);
    ui.update(true);
    fields.forEach(f => { f.checked = false; f.dispatchEvent(new Event('change')); });
    // Closing and reopening must preserve the chosen values, not reset them.
    const open = descendants(root).find(n => n.innerHTML === 'Advanced Game Settings')!;
    open.dispatchEvent(new Event('click')); ui.close(); open.dispatchEvent(new Event('click'));
    expect(fields.every(f => !f.checked)).toBe(true);
    descendants(overlay).find(n => n.innerHTML === 'Reset defaults')!.dispatchEvent(new Event('click')); ui.update();
    expect(fields.every(f => f.checked)).toBe(true);
    expect(read().match?.active).toEqual([0, 2]);
    ui.dispose();
  });
});
