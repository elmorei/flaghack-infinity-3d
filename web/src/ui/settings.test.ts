import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../game/session';
import { loadSettings, saveSettings } from './settings';

afterEach(() => vi.unstubAllGlobals());

function storage(initial: object) {
  let value = JSON.stringify(initial);
  vi.stubGlobal('localStorage', {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  });
}

describe('independent look inversion preferences', () => {
  it('migrates the old invert Y setting to the mouse while preserving the gamepad preference', () => {
    storage({ invertY: true, controls: { invertPadY: false } });
    const settings = new Session().settings;
    loadSettings(settings);
    expect(settings.invertMouseY).toBe(true);
    expect(settings.controls.invertPadY).toBe(false);
  });

  it('prefers the explicit mouse setting over a legacy value', () => {
    storage({ invertY: true, invertMouseY: false, controls: { invertPadY: true } });
    const settings = new Session().settings;
    loadSettings(settings);
    expect(settings.invertMouseY).toBe(false);
    expect(settings.controls.invertPadY).toBe(true);
  });

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('persists mouse %s and gamepad %s independently', (mouse, gamepad) => {
    storage({});
    const settings = new Session().settings;
    settings.invertMouseY = mouse;
    settings.controls.invertPadY = gamepad;
    saveSettings(settings);
    const restored = new Session().settings;
    loadSettings(restored);
    expect(restored.invertMouseY).toBe(mouse);
    expect(restored.controls.invertPadY).toBe(gamepad);
  });
});
