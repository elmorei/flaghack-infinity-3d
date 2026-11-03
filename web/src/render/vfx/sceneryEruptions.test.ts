import { LEVEL_HEIGHT } from '../../sim/constants';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { EventOf } from '../../sim/events';
import { SCENERY_ERUPTION_MAX_LIFE, SCENERY_PARTICLE_CAPACITY, STRUCTURE_FLAME_MAX_LIFE, STRUCTURE_FLAME_HEIGHT_SCALE, DESTRUCTION_EXPLOSION_SCALE, DESTRUCTION_EXPLOSION_HEIGHT_MULTIPLIER, SceneryEruptions } from './sceneryEruptions';
import { Motion, ParticlePool, ParticleSpec, Shape } from './particles';
import { Prng } from './prng';
import { VfxRenderer } from './vfxRenderer';

const event = (sceneryId = 7, size = { x: 2, y: 3, z: 2 }): EventOf<'sceneryDestroyed'> =>
  ({ t: 'sceneryDestroyed', sceneryId, pos: { x: 30, y: 6, z: -20 }, size, yaw: .7 });
const make = (density = 1) => new SceneryEruptions({ uTime: { value: 0 }, uViewportH: { value: 720 }, uLight: { value: 1 } }, 14, density);
const attr = (fx: SceneryEruptions, index: number) => fx.mesh.geometry.getAttribute(`a${index}`);
const rows = (fx: SceneryEruptions, index: number) => Array.from({ length: fx.mesh.geometry.instanceCount }, (_, i) =>
  [attr(fx, index).getX(i), attr(fx, index).getY(i), attr(fx, index).getZ(i), attr(fx, index).getW(i)]);

describe('large billowing destruction fireballs', () => {
  it('doubles every lobe and spawn offset without increasing the original particle budget or lifetime', () => {
    expect(DESTRUCTION_EXPLOSION_SCALE).toBe(2);
    for (const size of [{ x: 2, y: 3, z: 2 }, { x: 12, y: 8, z: 10 }, { x: 10000, y: 10000, z: 10 }]) {
      const fx = make(), e = event(17, size), rng = new Prng(Math.imul(18, 0x9e3779b1));
      fx.onEvent(e, 4); fx.update(4);
      // Independently reconstruct the previous recipe's dimensions and random sequence.
      const shrink = Math.min(1, 14 / Math.max(size.x, size.z));
      const width = size.x * shrink, depth = size.z * shrink, height = Math.min(size.y, 12);
      const span = Math.sqrt(width * depth), radius = Math.min(4.5, 1.25 + span * .2 + height * .07);
      const lobes = Math.ceil(Math.min(15, 8 + span * .45)), c = Math.cos(e.yaw), s = Math.sin(e.yaw);
      expect(fx.mesh.geometry.instanceCount).toBe(6 + lobes);
      for (let i = 0; i < 6 + lobes; i++) {
        const flame = i >= 6; rng.next();
        const x = rng.signed() * width * .22, z = rng.signed() * depth * .22;
        const y = radius * .35 + rng.next() * Math.min(height * .15, .7);
        expect(attr(fx, 0).getX(i)).toBeCloseTo(e.pos.x + 2 * (x * c + z * s), 4);
        expect(attr(fx, 0).getY(i)).toBeCloseTo(e.pos.y + 2 * y, 4);
        expect(attr(fx, 0).getZ(i)).toBeCloseTo(e.pos.z + 2 * (-x * s + z * c), 4);
        const puff = radius * (flame ? rng.range(.7, 1) : rng.range(.5, .7));
        expect(attr(fx, 2).getX(i)).toBeCloseTo(2 * puff * (flame ? .16 : .4));
        expect(attr(fx, 2).getY(i)).toBeCloseTo(2 * puff * (flame ? 1 : 1.35));
        const oldUpwardSpeed = flame ? rng.range(2.8, 5.4) : rng.range(.8, 1.6);
        expect(attr(fx, 1).getY(i)).toBeCloseTo(oldUpwardSpeed * 2);
        const oldLife = flame ? rng.range(.7, .95) : rng.range(1.05, 1.65);
        expect(attr(fx, 1).getW(i)).toBeCloseTo(oldLife); rng.signed();
      }
      fx.dispose();
    }
  });

  it('shoots flame and smoke upward throughout their lives, with bounded sideways drift at every object scale', () => {
    for (const size of [{ x: 1, y: 1, z: 1 }, { x: 10000, y: 10000, z: 10000 }]) {
      const fx = make(); fx.onEvent(event(17, size), 0); fx.update(0);
      for (let i = 0; i < fx.mesh.geometry.instanceCount; i++) {
        const [vx, vy, vz, life] = rows(fx, 1)[i], [, , gravity, drag] = rows(fx, 2)[i];
        const horizontal = Math.hypot(vx, vz);
        expect(vy).toBeGreaterThan(horizontal * 2.5);
        expect(gravity).toBeLessThan(0);
        for (const age of [0, life * .25, life * .5, life * .99]) {
          const decay = Math.exp(-drag * age);
          expect(vy * decay - gravity * age).toBeGreaterThan(horizontal * decay * 2.5);
        }
      }
      fx.dispose();
    }
  });

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
      expect(attr(fx, 7).getW(i)).toBeCloseTo(STRUCTURE_FLAME_HEIGHT_SCALE);
      expect(attr(fx, 6).getZ(i)).toBe(e.pos.y);
      expect(attr(fx, 2).getY(i)).toBeGreaterThan(attr(fx, 2).getX(i) * 5);
    }
    expect(fx.mesh.material.fragmentShader).toContain('fireColor : rgb * uLight');
    for (const [x, y, z, born] of rows(fx, 0)) {
      expect(Math.abs(x - e.pos.x)).toBeLessThan(2.4); expect(Math.abs(z - e.pos.z)).toBeLessThan(2.4);
      expect(y).toBeGreaterThan(e.pos.y); expect(y).toBeLessThan(e.pos.y + 4); expect(born).toBe(10);
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
      for (const [start, end] of rows(fx, 2)) { expect(start).toBeLessThanOrEqual(2.6); expect(end).toBeLessThanOrEqual(9); }
      for (const [x, y, z] of rows(fx, 0)) {
        expect(Math.hypot(x - 30, z + 20)).toBeLessThan(15.2); expect(y).toBeLessThanOrEqual(10.6);
      }
      fx.dispose();
    }
    const rotated = make(); rotated.onEvent({ ...event(), size: { x: 10, y: 1, z: .01 }, yaw: Math.PI / 2 }, 0); rotated.update(0);
    for (const [x] of rows(rotated, 0)) expect(Math.abs(x - 30)).toBeLessThan(.01);
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
    const stub = { ctx: { time: 3, world: { buildings: new Map() } }, sceneryEruptions: fx, syncClock: vi.fn(),
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

  it('anchors surviving elevated building effects to their base and removed collapse effects to terrain', () => {
    const wreck = vi.fn(), confetti = vi.fn(), wardPulse = vi.fn();
    const buildings = new Map([[8, { id: 8, pos: { x: 30, z: -20 }, level: 2 }]]);
    const stub = { ctx: { time: 3, world: { buildings, collision: { groundHeight: () => 6 } } },
      syncClock: vi.fn(), groundY: () => 6, spend: () => true, color: () => 0xffcc00,
      fx: { wreck, confetti, wardPulse }, shake: vi.fn() };
    const send = (e: Parameters<VfxRenderer['onEvent']>[0]) => VfxRenderer.prototype.onEvent.call(stub as unknown as VfxRenderer, e);
    send({ t: 'buildingDone', buildingId: 8, kind: 'workshop', faction: 0, pos: { x: 30, z: -20 } });
    expect(confetti).toHaveBeenCalledWith(30, 6 + 2 * LEVEL_HEIGHT, -20, 0xffcc00);
    send({ t: 'buildingDisabled', buildingId: 8, kind: 'workshop', faction: 0, pos: { x: 30, z: -20 } });
    expect(wreck).toHaveBeenLastCalledWith(30, 6 + 2 * LEVEL_HEIGHT, -20, 1);
    buildings.clear();
    send({ t: 'buildingDisabled', buildingId: 8, kind: 'workshop', faction: 0, pos: { x: 30, z: -20 } });
    expect(wreck).toHaveBeenLastCalledWith(30, 6, -20, 1);
  });

  it('triples the prior fireball and smoke height in world vertical about their source base', () => {
    expect(DESTRUCTION_EXPLOSION_HEIGHT_MULTIPLIER).toBe(3);
    expect(STRUCTURE_FLAME_HEIGHT_SCALE).toBeCloseTo(1.45 * 3);
    const fx = make(), e = event(); fx.onEvent(e, 10); fx.update(10);
    const shapes = rows(fx, 5).map(r => r[0]);
    for (let i = 0; i < shapes.length; i++) {
      const oldScale = shapes[i] === Shape.Fireball ? 1.45 : 1;
      expect(attr(fx, 7).getW(i)).toBeCloseTo(oldScale * 3);
      const scale = attr(fx, 7).getW(i), ground = attr(fx, 6).getZ(i), initialY = attr(fx, 0).getY(i);
      expect(ground + (initialY - ground) * scale).toBeGreaterThan(initialY);
      expect(attr(fx, 0).getW(i)).toBe(10);
    }
    expect(fx.mesh.material.vertexShader).toContain('mv.xyz += worldUpInView');
    expect(fx.mesh.material.vertexShader).toContain('p.y - a6.z + offsetWorldY');
    fx.dispose();
  });

  it('low quality reduces particle count without skipping any prop eruption', () => {
    const low = make(.45), high = make();
    for (const fx of [low, high]) { fx.onEvent(event(), 0); fx.update(0); }
    expect(low.mesh.geometry.instanceCount).toBeGreaterThan(0);
    expect(low.mesh.geometry.instanceCount).toBeLessThan(high.mesh.geometry.instanceCount); low.dispose(); high.dispose();
  });

  it('triples every world-space lobe vertex height but never its XZ footprint, across camera tilts and ages', () => {
    const fx = make(), e = event(); fx.onEvent(e, 0); fx.update(0);
    for (const pitch of [.2, .8, 1.4]) {
      const camera = new THREE.PerspectiveCamera(55, 1, .1, 500);
      camera.position.set(30 + Math.sin(.4) * 30, 6 + Math.sin(pitch) * 30, -20 + Math.cos(.4) * 30);
      camera.lookAt(30, 6, -20); camera.updateMatrixWorld();
      const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorldInverse);
      for (let i = 0; i < fx.mesh.geometry.instanceCount; i++) {
        const a = Array.from({ length: 8 }, (_, j) => rows(fx, j)[i]);
        const baselineScale = a[5][0] === Shape.Fireball ? 1.45 : 1;
        for (const fraction of [.01, .2, .6, .95]) for (const corner of [-1, 1]) {
          const age = a[1][3] * fraction, k = (1 - Math.exp(-a[2][3] * age)) / a[2][3];
          const center = new THREE.Vector3(a[0][0] + a[1][0] * k, a[0][1] + a[1][1] * k - .5 * a[2][2] * age ** 2, a[0][2] + a[1][2] * k);
          const size = THREE.MathUtils.lerp(a[2][0], a[2][1], a[5][0] === Shape.Fireball ? 1 - Math.exp(-7 * fraction) : fraction);
          const offset = new THREE.Vector3(corner * size, -corner * size, 0);
          const view = center.clone().applyMatrix4(camera.matrixWorldInverse).add(offset);
          const height = center.y - e.pos.y + offset.dot(up);
          const previous = view.clone().addScaledVector(up, height * (baselineScale - 1)).applyMatrix4(camera.matrixWorld);
          const current = view.clone().addScaledVector(up, height * (a[7][3] - 1)).applyMatrix4(camera.matrixWorld);
          expect(current.x).toBeCloseTo(previous.x, 5);
          expect(current.z).toBeCloseTo(previous.z, 5);
          expect(current.y - e.pos.y).toBeCloseTo((previous.y - e.pos.y) * 3, 4);
        }
      }
    }
    fx.dispose();
  });

  it('keeps ordinary smoke, sparks and orbit shrink attributes unchanged unless ballistic height scaling is requested', () => {
    const pool = new ParticlePool(8, false, { uTime: { value: 0 }, uViewportH: { value: 720 }, uLight: { value: 1 } }, 14);
    const ordinary = new ParticleSpec().reset().look(Shape.Smoke);
    const spark = new ParticleSpec().reset().look(Shape.Spark);
    const orbit = new ParticleSpec().reset().look(Shape.Smoke).orbit(2, 3, 4, .5, .8).stretchVertical(3, 50);
    const plume = new ParticleSpec().reset().look(Shape.Smoke).stretchVertical(3, 50);
    for (const s of [ordinary, spark, orbit, plume]) pool.emit(s);
    pool.flush();
    const a6 = pool.mesh.geometry.getAttribute('a6'), a7 = pool.mesh.geometry.getAttribute('a7');
    for (const i of [0, 1, 2]) expect(a7.getW(i)).toBe(0);
    expect(a6.getX(2)).toBe(Motion.Orbit); expect(a6.getZ(2)).toBeCloseTo(.8);
    expect(a6.getX(3)).toBe(Motion.Ballistic); expect(a6.getZ(3)).toBe(50); expect(a7.getW(3)).toBe(3);
    expect(pool.mesh.material.vertexShader).toContain('if (a7.w > 0.0)');
    pool.dispose();
  });
});
