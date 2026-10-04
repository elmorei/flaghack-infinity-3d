import { ACTIONS, defaultControls } from '../game/bindings';
import type { Settings } from '../game/session';
import { button, el } from './dom';
export function controlSettings(parent: HTMLElement, settings: Settings, save: () => void): void {
  const details = el('details', 'control-settings', parent);
  el('summary', 'btn', details, 'Customize controls — keyboard, mouse & gamepad');
  el(
    'p',
    'panel-hint',
    details,
    'Click a keyboard field and press a key. Escape always closes menus. Standard gamepads: left stick moves, right stick looks; in Command View the right stick moves the cursor.',
  );
  const table = el('table', 'control-table', details);
  const head = el('tr', '', table);
  for (const text of ['Action', 'Keyboard', 'Mouse', 'Gamepad']) el('th', '', head, text);
  for (const [action, name] of Object.entries(ACTIONS)) {
    const row = el('tr', '', table);
    el('td', '', row, name);
    const cell = el('td', '', row);
    const key = el('input', 'field-in', cell);
    key.readOnly = true;
    key.value = settings.controls.bindings[action]
      .filter((x) => !x.startsWith('Mouse') && !x.startsWith('Pad'))
      .join(', ');
    key.setAttribute('aria-label', `${name} keyboard`);
    const replace = (prefix: string, values: string[]) => {
      settings.controls.bindings[action] = settings.controls.bindings[action]
        .filter((x) => (prefix === 'Key' ? x.startsWith('Mouse') || x.startsWith('Pad') : !x.startsWith(prefix)))
        .concat(values);
      save();
    };
    key.addEventListener('keydown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (action === 'Escape') return;
      replace('Key', ev.code === 'Delete' ? [] : [ev.code]);
      key.value = ev.code === 'Delete' ? 'Unbound' : ev.code;
    });
    for (const [prefix, count, labels] of [
      ['Mouse', 3, ['Left', 'Middle', 'Right']],
      [
        'Pad',
        17,
        [
          'A / Cross',
          'B / Circle',
          'X / Square',
          'Y / Triangle',
          'LB / L1',
          'RB / R1',
          'LT / L2',
          'RT / R2',
          'View / Select',
          'Menu / Start',
          'Left stick click',
          'Right stick click',
          'D-pad up',
          'D-pad down',
          'D-pad left',
          'D-pad right',
          'Guide',
        ],
      ],
    ] as const) {
      const c = el('td', '', row),
        select = el('select', 'field-in', c);
      select.setAttribute('aria-label', `${name} ${prefix === 'Pad' ? 'gamepad' : 'mouse'}`);
      const none = el('option', '', select, 'Unbound');
      none.value = '';
      for (let i = 0; i < count; i++) {
        const o = el('option', '', select, labels[i]);
        o.value = prefix + i;
      }
      select.value = settings.controls.bindings[action].find((x) => x.startsWith(prefix)) ?? '';
      select.addEventListener('change', () => replace(prefix, select.value ? [select.value] : []));
    }
  }
  for (const [key, name, min, max, step] of [
    ['deadzone', 'Gamepad deadzone', 0.05, 0.4, 0.01],
    ['lookSpeed', 'Gamepad look sensitivity', 0.2, 4, 0.1],
  ] as const) {
    const row = el('label', 'setup-field', details);
    el('span', '', row, name);
    const i = el('input', 'field-in', row);
    i.type = 'number';
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.value = String(settings.controls[key]);
    i.addEventListener('change', () => {
      settings.controls[key] = Math.max(min, Math.min(max, Number(i.value) || min));
      save();
    });
  }
  for (const [key, name] of [
    ['invertPadY', 'Invert gamepad look Y'],
    ['swapSticks', 'Swap gamepad sticks'],
  ] as const) {
    const l = el('label', 'setup-field', details);
    const i = el('input', '', l);
    i.type = 'checkbox';
    i.checked = settings.controls[key];
    el('span', '', l, name);
    i.addEventListener('change', () => {
      settings.controls[key] = i.checked;
      save();
    });
  }
  button('btn', details, 'Reset controls', () => {
    settings.controls = defaultControls();
    save();
    details.remove();
    controlSettings(parent, settings, save);
  });
}
