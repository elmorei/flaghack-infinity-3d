import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BossImpactFx } from './impactFx';
import type { EnvContext } from '../../envTypes';
import type { GameEvent } from '../../../../sim/events';

function env(): EnvContext {
  return { ctx: { time: 100, world: { time: 100, boss: { id: 99 }, map: { effigy: { x: 20, z: -30 } }, factions: [{ color: 0x33ccff }] },
    renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280,720) }, camera: new THREE.PerspectiveCamera(60) } } as unknown as EnvContext;
}
const event: GameEvent = { t: 'bossImpact', bossId: 99, by: 12, flagId: 54, faction: 0, pos: { x: 44, y: 17, z: 8 }, headshot: true, amount: 300 };
describe('authoritative boss-impact fireworks', () => {
  it('bursts at the exact impact position and does not emit twice for the same destroyed flag', () => {
    const e = env(), fx = new BossImpactFx(e), before = JSON.stringify(e.ctx.world);
    fx.onEvent(event); fx.onEvent(event); fx.update(100.1);
    const shown = fx.group.children.filter((o) => o.visible) as THREE.Points<THREE.BufferGeometry,THREE.ShaderMaterial>[];
    expect(shown).toHaveLength(1); expect(shown[0].position.toArray()).toEqual([24,17,38]);
    expect(shown[0].material.uniforms.uPower.value).toBe(1.35);
    expect(shown[0].material.uniforms.uColor.value.getHex()).toBe(0x33ccff);
    expect(shown[0].geometry.getAttribute('position').count).toBe(176);
    expect(JSON.stringify(e.ctx.world)).toBe(before);
    fx.update(101.5); expect(fx.group.children.some((o) => o.visible)).toBe(false); fx.dispose();
  });
  it('ignores other bosses and ordinary hits; body-hit bursts are also colorful fireworks', () => {
    const e = env(), fx = new BossImpactFx(e);
    fx.onEvent({ ...event, bossId: 88 });
    fx.onEvent({ t: 'hit', target: 99, by: 12, amount: 50, pos: event.pos });
    expect(fx.group.children.some((o) => o.visible)).toBe(false);
    fx.onEvent({ ...event, headshot: false, amount: 50 });
    const shown = fx.group.children.find((o) => o.visible) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(shown.material.uniforms.uPower.value).toBe(1); fx.dispose();
  });
});

describe('small world-space melee fireworks', () => {
  it('uses the shared shader at smaller scale, deduplicates and bounds/culls the pool', async () => {
    const { ImpactFireworks } = await import('./impactFx');
    const e = env();
    e.ctx.world.time = 999; // Presentation clock may differ from authoritative sim time.
    const fx = new ImpactFireworks(e.ctx, true);
    const hit: GameEvent = { t: 'meleeImpact', impactId: 1, target: 7, by: 12, faction: 0, pos: { x: 2, y: 1.1, z: 3 } };
    fx.onEvent(hit); fx.onEvent(hit); fx.onEvent(event); fx.update(100.2);
    let shown = fx.group.children.filter(o => o.visible) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>[];
    expect(shown).toHaveLength(1); expect(shown[0].position.toArray()).toEqual([2,1.1,3]);
    expect(shown[0].material.uniforms.uPower.value).toBe(.38);
    expect(shown[0].geometry.getAttribute('position').count).toBe(80);
    expect(shown[0].frustumCulled).toBe(true); expect(shown[0].geometry.boundingSphere?.radius).toBe(7);
    e.ctx.shared = { groundOffset: () => .3 } as typeof e.ctx.shared;
    fx.onEvent({ ...hit, impactId: 200 });
    expect(fx.group.children.filter(o => o.visible)[1].position.y).toBeCloseTo(1.1);
    fx.onEvent({ ...hit, impactId: 2, pos: { x: 1000, y: 1, z: 0 } });
    expect(fx.group.children.filter(o => o.visible)).toHaveLength(2);
    for (let i = 3; i < 200; i++) fx.onEvent({ ...hit, impactId: i });
    expect(fx.group.children).toHaveLength(24); expect(fx.group.children.filter(o => o.visible)).toHaveLength(24);
    fx.update(101.5); expect(fx.group.children.some(o => o.visible)).toBe(false); fx.dispose();
  });
});
