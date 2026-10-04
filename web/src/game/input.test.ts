import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from './input';
import { defaultControls } from './bindings';
function setup() {
  const listeners = new Map<string, (e: any) => void>();
  class Element {
    isContentEditable = false;
  }
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('HTMLInputElement', class extends Element {});
  vi.stubGlobal('HTMLTextAreaElement', class extends Element {});
  vi.stubGlobal('HTMLSelectElement', class extends Element {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('window', {
    addEventListener: (n: string, f: any) => listeners.set(n, f),
    removeEventListener: () => {},
  });
  vi.stubGlobal('document', {
    activeElement: null,
    pointerLockElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
  });
  let pad: any = {
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  vi.stubGlobal('navigator', { getGamepads: () => (pad ? [pad] : []) });
  const canvas = {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (n: string, f: any) => listeners.set(n, f),
    removeEventListener: () => {},
  };
  const input = new Input(canvas as unknown as HTMLCanvasElement);
  input.capturesKey = () => true;
  return {
    input,
    pad,
    listeners,
    disconnect: () => {
      pad = null;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('mapped input and gamepad lifecycle', () => {
  it('polls analog movement and turns controller buttons into action edges', () => {
    const { input, pad } = setup();
    pad.axes = [0.6, -0.4, 0.5, 0];
    pad.buttons[0].pressed = true;
    input.pollGamepad(1 / 60, true, false);
    expect(input.moveX).toBeGreaterThan(0);
    expect(input.moveY).toBeLessThan(0);
    expect(input.wasPressed('Space')).toBe(true);
    expect(input.dx).toBeGreaterThan(0);
    input.endFrame();
    input.pollGamepad(1 / 60, true, false);
    expect(input.wasPressed('Space')).toBe(false);
    expect(input.isDown('Space')).toBe(true);
    pad.buttons[0].pressed = false;
    input.pollGamepad(1 / 60, true, false);
    expect(input.wasReleased('Space')).toBe(true);
  });
  it('stops held movement and buttons on disconnect and blur', () => {
    const { input, pad, disconnect, listeners } = setup();
    pad.axes[0] = 1;
    pad.buttons[7].pressed = true;
    input.pollGamepad(1 / 60, true, false);
    expect(input.buttons[0]).toBe(true);
    listeners.get('blur')!({});
    input.pollGamepad(1 / 60, true, false);
    expect(input.buttons[0]).toBe(false);
    expect(input.moveX).toBe(0);
    listeners.get('focus')!({});
    disconnect();
    input.pollGamepad(1 / 60, true, false);
    expect(input.gamepadActive).toBe(false);
  });
  it('rebinds physical keyboard keys and mouse buttons to gameplay actions', () => {
    const { input, listeners } = setup();
    input.controls = defaultControls();
    input.controls.bindings.KeyW = ['KeyI'];
    input.controls.bindings.Mouse0 = ['KeyO'];
    const event = (code: string) => ({
      code,
      target: null,
      preventDefault: () => {},
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
    });
    listeners.get('keydown')!(event('KeyI'));
    listeners.get('keydown')!(event('KeyO'));
    expect(input.isDown('KeyW')).toBe(true);
    expect(input.buttons[0]).toBe(true);
    expect(input.buttonPressed(0)).toBe(true);
    listeners.get('keyup')!(event('KeyO'));
    expect(input.buttonReleased(0)).toBe(true);
  });
  it('moves the command cursor with the look stick', () => {
    const { input, pad } = setup();
    input.mx = 400;
    input.my = 300;
    pad.axes[2] = 1;
    input.pollGamepad(0.1, true, true);
    expect(input.mx).toBe(470);
    expect(input.dx).toBe(0);
  });
});
