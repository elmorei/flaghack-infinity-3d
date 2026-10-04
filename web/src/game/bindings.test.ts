import { describe, it, expect } from 'vitest';
import { defaultControls, normalizeControls, stick } from './bindings';
describe('control settings', () => {
  it('preserves defaults and refuses malformed bindings', () => {
    const c = normalizeControls({
      bindings: { KeyW: ['KeyI', 'Mouse0', 'Pad2', 'evil', 42], Escape: [] },
      deadzone: 999,
      lookSpeed: -1,
    });
    expect(c.bindings.KeyW).toEqual(['KeyI', 'Mouse0', 'Pad2']);
    expect(c.bindings.Escape).toContain('Escape');
    expect(c.deadzone).toBe(0.4);
    expect(c.lookSpeed).toBe(0.2);
    expect(normalizeControls(null)).toEqual(defaultControls());
  });
  it('supports unbinding and independent profiles', () => {
    const a = defaultControls(),
      b = defaultControls();
    a.bindings.KeyW = [];
    expect(b.bindings.KeyW).toEqual(['KeyW']);
    expect(normalizeControls(a).bindings.KeyW).toEqual([]);
  });
  it('applies a radial deadzone without distorting diagonals', () => {
    expect(stick(0.1, 0.1, 0.18)).toEqual([0, 0]);
    expect(stick(1, 0, 0.18)).toEqual([1, 0]);
    const [x, y] = stick(1, 1, 0.18);
    expect(Math.hypot(x, y)).toBeCloseTo(1);
    expect(x).toBe(y);
  });
});
