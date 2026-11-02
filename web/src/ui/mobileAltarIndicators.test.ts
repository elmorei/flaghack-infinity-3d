import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector4 } from 'three';
import type { World } from '../sim/world';
import type { Building } from '../sim/types';
import { enemyAltars, layoutAltarIndicators, MobileAltarIndicators, type AltarClipTarget } from './mobileAltarIndicators';

const target = (id: number, x: number, y = 0, z = 0, w = 1): AltarClipTarget => ({ id, x, y, z, w, color: '#ff0000' });
const portrait = { width: 390, height: 844 };
function project(camera: PerspectiveCamera | OrthographicCamera, x: number, y: number, z: number): AltarClipTarget {
  camera.updateMatrixWorld();
  const p = new Vector4(x, y, z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
  return target(1, p.x, p.y, p.z, p.w);
}

describe('mobile altar geometry', () => {
  it('hides on-screen targets and places cardinal arrows inside safe edges', () => {
    expect(layoutAltarIndicators([target(0, 0), target(1, 1, 1)], portrait)).toEqual([]);
    const points = layoutAltarIndicators([target(0, 2), target(1, -2), target(2, 0, 2), target(3, 0, -2)], portrait);
    expect(points[0].x).toBe(370); expect(points[1].x).toBe(20);
    expect(points[2].y).toBe(20); expect(points[3].y).toBe(824);
    [0, -Math.PI, -Math.PI / 2, Math.PI / 2].forEach((angle, i) => expect(points[i].angle).toBeCloseTo(angle));
  });
  it('uses actual perspective projection, pans, and keeps behind-camera bearings unmirrored', () => {
    const c = new PerspectiveCamera(60, 390 / 844, .1, 1000);
    expect(layoutAltarIndicators([project(c, 0, 0, -10)], portrait)).toEqual([]);
    expect(layoutAltarIndicators([project(c, 100, 0, -10)], portrait)[0].x).toBe(370);
    expect(layoutAltarIndicators([project(c, 100, 0, 10)], portrait)[0].x).toBe(370);
    c.position.x = 100;
    expect(layoutAltarIndicators([project(c, 100, 0, -10)], portrait)).toEqual([]);
    expect(layoutAltarIndicators([project(c, 0, 0, -10)], portrait)[0].x).toBe(20);
  });
  it('supports orthographic rotation, zoom, and landscape orientation', () => {
    const c = new OrthographicCamera(-10, 10, 10, -10, .1, 100);
    expect(layoutAltarIndicators([project(c, 9, 0, -10)], portrait)).toEqual([]);
    c.zoom = 2; c.updateProjectionMatrix();
    expect(layoutAltarIndicators([project(c, 9, 0, -10)], portrait)[0].x).toBe(370);
    c.rotation.z = Math.PI / 2;
    const p = layoutAltarIndicators([project(c, 9, 0, -10)], { width: 844, height: 390 })[0];
    expect(p.y).toBe(370); expect(p.angle).toBeCloseTo(Math.PI / 2);
  });
  it('keeps near-eye and directly behind targets finite; rejects invalid dimensions/coordinates', () => {
    for (const t of [target(1, 0, 0, -1, 0), target(1, 0, 0, 2, -1), target(1, 1, 0, -1, 1e-15)]) {
      expect(layoutAltarIndicators([t], portrait).every(p => [p.x, p.y, p.angle].every(Number.isFinite))).toBe(true);
    }
    expect(layoutAltarIndicators([target(1, NaN)], portrait)).toEqual([]);
    expect(layoutAltarIndicators([target(1, 2)], { width: 0, height: 0 })).toEqual([]);
  });
  it('avoids HUD footprints without excluding the whole top and separates same-bearing altars', () => {
    const reserved = [{ left: 240, top: 0, right: 390, bottom: 170 }, { left: 0, top: 704, right: 390, bottom: 844 }];
    const points = layoutAltarIndicators([target(1, 2, 10), target(2, 2, 10), target(3, 2, 10), target(4, 0, -3)], { ...portrait, reserved });
    expect(points).toHaveLength(4);
    for (const p of points) {
      for (const r of reserved) expect(p.x >= r.left - 13 && p.x <= r.right + 13 && p.y >= r.top - 13 && p.y <= r.bottom + 13).toBe(false);
      for (const other of points) if (other !== p) expect(Math.hypot(p.x - other.x, p.y - other.y)).toBeGreaterThanOrEqual(26);
    }
    expect(layoutAltarIndicators([target(1, 0, 3)], { ...portrait, reserved })[0].y).toBe(20);
  });
});

const altar = (id: number, faction: number, extra = {}): Building => ({ id, kind: 'hearth', faction, hp: 100, pos: { x: 100, z: -10 }, hearth: {}, ...extra } as Building);
const world = (): World => ({ buildings: new Map([[1, altar(1, 1)]]), factions: [
  { alive: true, css: '#aaa', hearthIds: [1] }, { alive: true, css: '#f00', hearthIds: [] }, { alive: false, css: '#0f0' },
], collision: { groundHeight: () => 0 } } as unknown as World);

class Node {
  style: Record<string, string> = {}; dataset: Record<string, string> = {};
  children: Node[] = []; parent: Node | null = null; className = ''; innerHTML = '';
  setAttribute() {}
  appendChild(n: Node) { this.children.push(n); n.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
}
afterEach(() => vi.unstubAllGlobals());
it('uses live ownership and excludes neutral, own, dead, missing-component and destroyed altars', () => {
  const w = world();
  for (const b of [altar(2, 0), altar(3, -1), altar(4, 2), altar(5, 1, { hp: 0 }), altar(6, 1, { hearth: null }), altar(7, 1, { kind: 'workshop' })]) w.buildings.set(b.id, b);
  expect(enemyAltars(w, 0).map(b => b.id)).toEqual([1]);
  w.buildings.get(1)!.faction = 0;
  expect(enemyAltars(w, 0)).toEqual([]);
});
it('updates colored, noninteractive DOM and removes stale arrows on capture/death/disposal', () => {
  vi.stubGlobal('document', { createElement: () => new Node() });
  const parent = new Node(), w = world(), c = new PerspectiveCamera(60, 390 / 844, .1, 1000);
  const ui = new MobileAltarIndicators(parent as unknown as HTMLElement);
  ui.update(w, c, 0, portrait);
  const root = parent.children[0];
  expect(root.style.pointerEvents).toBe('none');
  expect(root.children[0].style.color).toBe('#f00');
  expect(root.children[0].style.pointerEvents).toBe('none');
  w.buildings.get(1)!.faction = 0; ui.update(w, c, 0, portrait);
  expect(root.children).toHaveLength(0);
  w.buildings.get(1)!.faction = 1; ui.update(w, c, 0, portrait);
  expect(root.children).toHaveLength(1);
  w.buildings.clear(); ui.update(w, c, 0, portrait);
  expect(root.children).toHaveLength(0);
  ui.hide(); expect(root.style.display).toBe('none');
  ui.dispose(); expect(parent.children).toHaveLength(0);
});
