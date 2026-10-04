export const ACTIONS: Record<string, string> = {
  KeyW: 'Move forward',
  KeyS: 'Move backward',
  KeyA: 'Move left',
  KeyD: 'Move right',
  Space: 'Jump',
  ShiftLeft: 'Sprint',
  ControlLeft: 'Modifier / descend',
  KeyE: 'Interact / plant / pull',
  KeyQ: 'Quick throw',
  Mouse0: 'Attack / build / select',
  Mouse2: 'Aim / order',
  Mouse1: 'Ping / camera drag',
  Tab: 'Command view',
  Escape: 'Pause / close',
  KeyF: 'Flag tool',
  KeyZ: 'Wall',
  KeyX: 'Deck',
  KeyC: 'Ramp',
  KeyV: 'Demolish',
  KeyB: 'Camp building',
  KeyG: 'Rally',
  KeyH: 'Send followers',
  KeyP: 'Ping',
  KeyT: 'Retransmit',
  KeyK: 'Chakras',
  KeyJ: 'Liber HH',
  KeyL: 'Lattice overlay',
  KeyN: 'Node planner',
  KeyR: 'Ring planner',
  Digit1: 'Priority Beacon',
  Digit2: 'Forced March',
  Digit3: 'Stabilize Zone',
  Digit4: 'Phason Shift',
  Digit5: 'Omega Pulse',
  Digit6: 'Saffron',
  Digit7: 'Luminous Dust',
  Digit8: 'Acid Cop Vision',
  F1: 'Help',
  Backquote: 'Debug',
  Backspace: 'Cancel plan',
  BracketLeft: 'Previous spectator',
  BracketRight: 'Next spectator',
  ArrowUp: 'Camera forward',
  ArrowDown: 'Camera backward',
  ArrowLeft: 'Camera left',
  ArrowRight: 'Camera right',
};
export interface ControlSettings {
  bindings: Record<string, string[]>;
  deadzone: number;
  lookSpeed: number;
  invertPadY: boolean;
  swapSticks: boolean;
}
export function defaultControls(): ControlSettings {
  const bindings = Object.fromEntries(Object.keys(ACTIONS).map((k) => [k, [k]]));
  bindings.ShiftLeft.push('ShiftRight');
  bindings.ControlLeft.push('ControlRight');
  for (const [action, b] of Object.entries({
    Space: 0,
    KeyE: 2,
    KeyQ: 3,
    Tab: 8,
    Escape: 9,
    ShiftLeft: 10,
    Mouse0: 7,
    Mouse2: 6,
    KeyG: 4,
    KeyB: 5,
    Digit1: 12,
    Digit2: 13,
    KeyZ: 14,
    KeyX: 15,
  }))
    bindings[action].push(`Pad${b}`);
  return { bindings, deadzone: 0.18, lookSpeed: 1.5, invertPadY: false, swapSticks: false };
}
export function normalizeControls(raw: unknown): ControlSettings {
  const out = defaultControls();
  if (!raw || typeof raw !== 'object') return out;
  const v = raw as Partial<ControlSettings>;
  if (v.bindings && typeof v.bindings === 'object')
    for (const k of Object.keys(ACTIONS)) {
      const list = v.bindings[k];
      if (Array.isArray(list))
        out.bindings[k] = list
          .filter(
            (x) =>
              typeof x === 'string' &&
              /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Tab|Escape|Shift(Left|Right)|Control(Left|Right)|F([1-9]|1[0-2])|Backquote|Backspace|Bracket(Left|Right)|Mouse[0-2]|Pad([0-9]|1[0-6]))$/.test(
                x,
              ),
          )
          .slice(0, 8);
    }
  // Keep a guaranteed route out of gameplay and settings.
  if (!out.bindings.Escape.includes('Escape')) out.bindings.Escape.push('Escape');
  for (const k of ['deadzone', 'lookSpeed'] as const)
    if (typeof v[k] === 'number' && Number.isFinite(v[k]))
      out[k] = Math.max(k === 'deadzone' ? 0.05 : 0.2, Math.min(k === 'deadzone' ? 0.4 : 4, v[k]!));
  out.invertPadY = v.invertPadY === true;
  out.swapSticks = v.swapSticks === true;
  return out;
}
/** Radial deadzone preserves analog magnitude and diagonal direction. */
export function stick(x: number, y: number, deadzone: number): [number, number] {
  const n = Math.hypot(x, y);
  if (n <= deadzone) return [0, 0];
  const scale = Math.min(1, (n - deadzone) / (1 - deadzone)) / n;
  return [x * scale, y * scale];
}
