import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector4 } from 'three';
import { layoutAltarIndicators, type AltarClipTarget } from './mobileAltarIndicators';

const target = (x: number, y: number, id = 1): AltarClipTarget => ({ id, color: '#f00', x, y, z: 0, w: 1 });
const sizes = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }];

describe('continuous mobile indicator perimeter', () => {
  it('tracks subpixel bearing changes without six-pixel stepping in every mobile orientation', () => {
    for (const viewport of sizes) {
      const { width, height } = viewport;
      const [a] = layoutAltarIndicators([target(2, .31)], viewport);
      const [b] = layoutAltarIndicators([target(2, .31001)], viewport);
      expect(a.x).toBe(width - 20); expect(b.x).toBe(width - 20);
      const expected = height / 2 - .31 * height / 2 * ((width / 2 - 20) / width);
      expect(a.y).toBeCloseTo(expected, 10);
      expect(b.y).toBeLessThan(a.y); expect(a.y - b.y).toBeLessThan(.01);
    }
  });
  it('intersects the exact boundary throughout a full rotation and crosses all corners continuously', () => {
    for (const viewport of sizes) {
      const { width, height } = viewport;
      const at = (angle: number) => layoutAltarIndicators([
        target(Math.cos(angle) * 10000 / width, -Math.sin(angle) * 10000 / height),
      ], viewport)[0];
      for (let degree = 0; degree < 360; degree++) {
        const angle = degree * Math.PI / 180, p = at(angle);
        expect(Math.min(Math.abs(p.x - 20), Math.abs(p.x - width + 20), Math.abs(p.y - 20), Math.abs(p.y - height + 20))).toBeLessThan(1e-9);
        expect(p.x).toBeGreaterThanOrEqual(20 - 1e-9); expect(p.x).toBeLessThanOrEqual(width - 20 + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(20 - 1e-9); expect(p.y).toBeLessThanOrEqual(height - 20 + 1e-9);
        // The exact hit remains collinear with the projected target.
        expect((p.x - width / 2) * Math.sin(angle) - (p.y - height / 2) * Math.cos(angle)).toBeCloseTo(0, 8);
      }
      for (const x of [20, width - 20]) for (const y of [20, height - 20]) {
        const angle = Math.atan2(y - height / 2, x - width / 2);
        const before = at(angle - 1e-7), after = at(angle + 1e-7), corner = at(angle);
        expect(corner.x).toBeCloseTo(x, 8); expect(corner.y).toBeCloseTo(y, 8);
        expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(.001);
      }
    }
  });
  it('slides only the minimum perimeter distance needed for HUD and other arrows', () => {
    const viewport = { width: 390, height: 844 };
    const [p] = layoutAltarIndicators([target(2, 0)], { ...viewport, reserved: [{ left: 350, top: 400, right: 390, bottom: 430 }] });
    expect(p.x).toBe(370); expect(p.y).toBeGreaterThan(446); expect(p.y).toBeLessThan(446.001);
    const pair = layoutAltarIndicators([target(2, 0, 2), target(2, 0, 1)], viewport);
    expect(pair[0].id).toBe(1); expect(pair[0].y).toBe(422);
    expect(Math.abs(pair[1].y - pair[0].y)).toBeGreaterThanOrEqual(32);
    expect(Math.abs(pair[1].y - pair[0].y)).toBeLessThan(32.001);
    const [corner] = layoutAltarIndicators([target(-350 / 390 * 10, 804 / 844 * 10)], {
      ...viewport, reserved: [{ left: 0, top: 0, right: 30, bottom: 30 }],
    });
    expect(Math.abs(corner.x - 20) + Math.abs(corner.y - 20)).toBeCloseTo(26, 4);
    expect(layoutAltarIndicators([target(2, 0)], { ...viewport, reserved: [{ left: 0, top: 0, right: 390, bottom: 844 }] })).toEqual([]);
  });
  it('keeps rotated arrow footprints outside both top panes, including wrapped 320px timing and corners', () => {
    for (const viewport of sizes) {
      const { width, height } = viewport;
      const reserved = [
        { left: 8, top: 8, right: Math.min(228, width - 192), bottom: width === 320 ? 190 : 150 },
        { left: width - 184, top: 8, right: width - 8, bottom: 145 },
      ];
      for (let degree = 0; degree < 360; degree += 5) {
        const angle = degree * Math.PI / 180;
        const points = layoutAltarIndicators(Array.from({ length: 5 }, (_, i) =>
          target(Math.cos(angle) * 10000 / width, -Math.sin(angle) * 10000 / height, i)), { ...viewport, reserved });
        expect(points).toHaveLength(5);
        for (const p of points) {
          // A 22px square's rotated bounding box never exceeds this radius.
          const radius = 11 * (Math.abs(Math.sin(p.angle)) + Math.abs(Math.cos(p.angle)));
          for (const r of reserved) expect(p.x + radius <= r.left || p.x - radius >= r.right || p.y + radius <= r.top || p.y - radius >= r.bottom).toBe(true);
          for (const other of points) if (other.id !== p.id) {
            expect(Math.abs(p.x - other.x) >= 32 || Math.abs(p.y - other.y) >= 32).toBe(true);
          }
        }
      }
    }
  });
  it('preserves finite bearings at the near plane and hides visible targets for both real camera types', () => {
    for (const camera of [new PerspectiveCamera(60, 390 / 844, .1, 1000), new OrthographicCamera(-10, 10, 10, -10, .1, 1000)]) {
      camera.updateMatrixWorld();
      const project = (x: number, z: number) => {
        const p = new Vector4(x, 0, z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
        return { ...target(p.x, p.y), z: p.z, w: p.w };
      };
      for (const z of [-.10001, -.1, -.09999, -1e-9, 0, 1e-9, .1]) {
        const [p] = layoutAltarIndicators([project(100, z)], sizes[1]);
        expect(p.x).toBe(370); expect([p.x, p.y, p.angle].every(Number.isFinite)).toBe(true);
      }
      expect(layoutAltarIndicators([project(0, -1)], sizes[1])).toEqual([]);
    }
    expect(layoutAltarIndicators([target(2, 0)], { ...sizes[1], inset: NaN })).toEqual([]);
  });
});
