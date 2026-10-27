import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { EventOf } from '../../sim/events';
import { SCENERY_ERUPTION_MAX_LIFE, SCENERY_PARTICLE_CAPACITY, STRUCTURE_FLAME_MAX_LIFE, SceneryEruptions } from './sceneryEruptions';
import { Shape } from './particles';
import { VfxRenderer } from './vfxRenderer';

const event = (sceneryId = 7, size = { x: 2, y: 3, z: 2 }): EventOf<'sceneryDestroyed'> =>
  ({ t: 'sceneryDestroyed', sceneryId, pos: { x: 30, y: 6, z: -20 }, size, yaw: .7 });
const make = (density = 1) => new SceneryEruptions({ uTime: { value: 0 }, uViewportH: { value: 720 }, uLight: { value: 1 } }, 14, density);
const attr = (fx: SceneryEruptions, index: number) => fx.mesh.geometry.getAttribute(`a${index}`);
const rows = (fx: SceneryEruptions, index: number) => Array.from({ length: fx.mesh.geometry.instanceCount }, (_, i) =>
  [attr(fx, index).getX(i), attr(fx, index).getY(i), attr(fx, index).getZ(i), attr(fx, index).getW(i)]);

describe('large billowing destruction fireballs', () => {
  it('renders emissive flame lobes and a small smoke tail, with no lights or gameplay mutation', () => {
    const fx = make(), e = event(), before = JSON.stringify(e);
    fx.onEvent(e, 10); fx.update(10);
    expect(fx.mesh.visible).toBe(true);
    expect(fx.mesh.material.defines.ADDITIVE).toBeUndefined();
    expect(fx.mesh.material.depthWrite).toBe(false);
    const shapes = rows(fx, 5).map(r => r[0]);
    expect(shapes).toContain(Shape.Smoke); expect(shapes).toContain(Shape.Fireball);
    expect(shapes.filter(s => s === Shape.Fireball).length).toBeGreaterThan(shapes.filter(s => s === Shape.Smoke).length);
    expect(shapes).not.toContain(Shape.Chip);
    for (let i = 0; i < shapes.length; i++) if (shapes[i] === Shape.Fireball) {
      expect(attr(fx, 1).getW(i)).toBeLessThanOrEqual(STRUCTURE_FLAME_MAX_LIFE);
      expect(attr(fx, 2).getY(i)).toBeGreaterThan(attr(fx, 2).getX(i) * 5);
    }
    expect(fx.mesh.material.fragmentShader).toContain('fireColor : rgb * uLight');
    for (const [x, y, z, born] of rows(fx, 0)) {
      expect(Math.abs(x - e.pos.x)).toBeLessThan(1.2); expect(Math.abs(z - e.pos.z)).toBeLessThan(1.2);
      expect(y).toBeGreaterThan(e.pos.y); expect(y).toBeLessThan(e.pos.y + 2); expect(born).toBe(10);
    }
    for (const row of rows(fx, 3)) expect(row.every(Number.isFinite)).toBe(true);
    for (const [, , , life] of rows(fx, 1)) expect(life).toBeLessThanOrEqual(SCENERY_ERUPTION_MAX_LIFE + 1e-6);
    expect(JSON.stringify(e)).toBe(before); fx.dispose();
  });

  it('scales footprint and height independently, preserving orientation and capping giant artwork', () => {
    const small = make(), large = make(), tall = make();
    small.onEvent(event(1, { x: 1, y: 1, z: 1 }), 0);
    large.onEvent(event(1, { x: 12, y: 8, z: 10 }), 0);
    tall.onEvent(event(1, { x: 10000, y: 10000, z: 10 }), 0);
    for (const fx of [small, large, tall]) fx.update(0);
    expect(large.mesh.geometry.instanceCount).toBeGreaterThan(small.mesh.geometry.instanceCount);
    expect(attr(large, 2).getX(0)).toBeGreaterThan(attr(small, 2).getX(0));
    for (const fx of [small, large, tall]) {
      expect(fx.mesh.geometry.instanceCount).toBeLessThanOrEqual(38);
      for (const [start, end] of rows(fx, 2)) { expect(start).toBeLessThanOrEqual(1.3); expect(end).toBeLessThanOrEqual(4.5); }
      for (const [x, y, z] of rows(fx, 0)) {
        expect(Math.hypot(x - 30, z + 20)).toBeLessThan(7.6); expect(y).toBeLessThanOrEqual(8.3);
      }
      fx.dispose();
    }
    const rotated = make(); rotated.onEvent({ ...event(), size: { x: 10, y: 1, z: .01 }, yaw: Math.PI / 2 }, 0); rotated.update(0);
    for (const [x] of rows(rotated, 0)) expect(Math.abs(x - 30)).toBeLessThan(.005);
    expect(rows(rotated, 0).some(r => Math.abs(r[2] + 20) > 1)).toBe(true); rotated.dispose();
  });

  it('ignores duplicate IDs, malformed events and late reconstruction; expiry fully removes the draw', () => {
    const fx = make(); fx.update(20); expect(fx.mesh.visible).toBe(false);
    fx.onEvent(event(-7), 20); fx.update(20); const count = fx.mesh.geometry.instanceCount;
    fx.onEvent(event(-7), 20); fx.update(20); expect(fx.mesh.geometry.instanceCount).toBe(count);
    for (const bad of [event(NaN), event(.5), event(8, { x: 0, y: 3, z: 2 }), { ...event(9), yaw: Infinity }]) fx.onEvent(bad, 20);
    fx.update(20); expect(fx.mesh.geometry.instanceCount).toBe(count);
    fx.update(20 + SCENERY_ERUPTION_MAX_LIFE); expect(fx.mesh.geometry.instanceCount).toBe(0); expect(fx.mesh.visible).toBe(false);
    fx.onEvent(event(-7), 22); fx.update(22); expect(fx.mesh.visible).toBe(false); fx.dispose();
  });

  it('uses one fixed buffer/draw under simultaneous mass destruction, deterministically replacing oldest particles', () => {
    const a = make(), b = make(), buffer = (attr(a, 0) as THREE.InterleavedBufferAttribute).data.array;
    for (let id = 0; id < 1000; id++) for (const fx of [a, b]) fx.onEvent(event(id), 1);
    for (const fx of [a, b]) fx.update(1);
    expect(a.mesh.geometry.instanceCount).toBe(SCENERY_PARTICLE_CAPACITY);
    expect((attr(a, 0) as THREE.InterleavedBufferAttribute).data.array).toBe(buffer);
    expect((attr(b, 0) as THREE.InterleavedBufferAttribute).data.array).toEqual(buffer);
    expect(a.mesh.children).toHaveLength(0);
    a.update(3); expect(a.mesh.visible).toBe(false); expect(a.mesh.geometry.instanceCount).toBe(0); a.dispose(); b.dispose();
  });

  it('clears deduplication on explicit reset/clock rewind and disposes GPU resources and scene membership', () => {
    const fx = make(), scene = new THREE.Scene(); scene.add(fx.mesh);
    const buffer = (attr(fx, 0) as THREE.InterleavedBufferAttribute).data.array;
    fx.onEvent(event(), 10); fx.update(10); fx.reset(); fx.update(10);
    expect(fx.mesh.visible).toBe(false);
    fx.onEvent(event(), 11); fx.update(11); expect(fx.mesh.visible).toBe(true);
    fx.update(0); expect(fx.mesh.visible).toBe(false); fx.onEvent(event(), 0); fx.update(0); expect(fx.mesh.visible).toBe(true);
    expect((attr(fx, 0) as THREE.InterleavedBufferAttribute).data.array).toBe(buffer);
    const geometry = vi.spyOn(fx.mesh.geometry, 'dispose'), material = vi.spyOn(fx.mesh.material, 'dispose');
    fx.dispose(); expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce(); expect(scene.children).toHaveLength(0);
  });

  it('routes per-prop events directly, even when the routine VFX budget is exhausted', () => {
    const fx = make(), stub = { ctx: { time: 3 }, sceneryEruptions: fx, syncClock: vi.fn(), spend: () => false };
    VfxRenderer.prototype.onEvent.call(stub as unknown as VfxRenderer, event()); fx.update(3);
    expect(fx.mesh.visible).toBe(true); fx.dispose();
  });

  it('keeps structure and scenery IDs separate and deduplicates repeated structure facts', () => {
    const fx = make(), e = event();
    fx.onEvent(e, 0); fx.update(0); const n = fx.mesh.geometry.instanceCount;
    fx.onStructure(e.sceneryId, e.pos, e.size, 0); fx.update(0);
    expect(fx.mesh.geometry.instanceCount).toBe(n * 2);
    fx.onStructure(e.sceneryId, e.pos, e.size, 0); fx.update(0);
    expect(fx.mesh.geometry.instanceCount).toBe(n * 2); fx.dispose();
  });

  it('routes boss building/piece bursts outside the routine budget, leaving normal destruction alone', () => {
    const fx = make(), wreck = vi.fn(), splinters = vi.fn();
    const stub = { ctx: { time: 3, world: {} }, sceneryEruptions: fx, syncClock: vi.fn(),
      groundY: () => 6, spend: () => false, fx: { wreck, splinters }, shake: vi.fn() };
    const send = (e: Parameters<VfxRenderer['onEvent']>[0]) => VfxRenderer.prototype.onEvent.call(stub as unknown as VfxRenderer, e);
    send({ t: 'buildingDisabled', buildingId: 5, kind: 'workshop', faction: 0, pos: { x: 30, z: -20 }, bossDestroyed: true });
    send({ t: 'pieceDestroyed', pieceId: 6, kind: 'wall', faction: 0, pos: { x: 30, y: 6, z: -20 }, bossDestroyed: true });
    fx.update(3); expect(fx.mesh.visible).toBe(true); expect(wreck).not.toHaveBeenCalled();
    const count = fx.mesh.geometry.instanceCount;
    send({ t: 'buildingDisabled', buildingId: 8, kind: 'workshop', faction: 0, pos: { x: 30, z: -20 } });
    send({ t: 'pieceDestroyed', pieceId: 9, kind: 'wall', faction: 0, pos: { x: 30, y: 6, z: -20 } });
    fx.update(3); expect(fx.mesh.geometry.instanceCount).toBe(count); expect(wreck).toHaveBeenCalledOnce(); fx.dispose();
  });

  it('low quality reduces particle count without skipping any prop eruption', () => {
    const low = make(.45), high = make();
    for (const fx of [low, high]) { fx.onEvent(event(), 0); fx.update(0); }
    expect(low.mesh.geometry.instanceCount).toBeGreaterThan(0);
    expect(low.mesh.geometry.instanceCount).toBeLessThan(high.mesh.geometry.instanceCount); low.dispose(); high.dispose();
  });
});
