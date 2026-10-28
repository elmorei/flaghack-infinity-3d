import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../sim/setup';
import type { GameEvent } from '../../sim/events';
import type { Crystal, FactionId } from '../../sim/types';
import { Bolts } from './bolts';
import { lightningSourceColor, setLightningPalette, type LightningSource } from './lightningPalette';
import { Prng } from './prng';
import { VfxRenderer } from './vfxRenderer';

function fixture() {
  const world = createMatch({ seed: 'owner-lightning', difficulty: 'normal', mode: 'standard', humans: [0] });
  const fx = new Bolts(new Prng(1), 16, source => lightningSourceColor(world, source));
  return { world, fx };
}
function palette(fx: Bolts, slot: number) {
  return { core: fx.mesh.material.uniforms.uCore.value[slot] as THREE.Color, glow: fx.mesh.material.uniforms.uGlow.value[slot] as THREE.Color };
}
function expectColor(fx: Bolts, slot: number, color?: number) {
  const { core, glow } = palette(fx, slot), expectedCore = new THREE.Color(), expectedGlow = new THREE.Color();
  setLightningPalette(expectedCore, expectedGlow, color);
  expect(core).toEqual(expectedCore); expect(glow).toEqual(expectedGlow);
}
const source = (faction: FactionId, kind: LightningSource['kind'] = 'crystal'): LightningSource => ({ kind, id: 9000 + faction, faction });
const strike = (fx: Bolts, now: number, owner?: LightningSource) => fx.strike(now, 0, 7.5, 0, 10, 2, 0, owner);

describe('owner-colored pooled crystal and ward lightning', () => {
  it('keeps four simultaneous owner palettes separate, with a bright tinted core and saturated halo', () => {
    const { world, fx } = fixture();
    for (const faction of [0, 1, 2, 3] as const) strike(fx, 10, source(faction));
    fx.update(10);
    expect(fx.mesh.visible).toBe(true);
    for (const faction of [0, 1, 2, 3] as const) {
      expectColor(fx, faction, world.factions[faction].color);
      const tint = new THREE.Color(world.factions[faction].color), { core, glow } = palette(fx, faction);
      for (const channel of ['r', 'g', 'b'] as const) {
        expect(glow[channel]).toBeCloseTo(tint[channel] * 2.2);
        expect(core[channel]).toBeCloseTo((tint[channel] * .72 + .28) * 1.2);
      }
    }
    expect(new Set(fx.mesh.material.uniforms.uGlow.value.map((c: THREE.Color) => c.getHex())).size).toBe(5);
    // Palette selection is per bolt in the vertex shader, not one global fragment tint.
    expect(fx.mesh.material.vertexShader).toContain('vGlow = uGlow[int(aInfo.z + 0.5)]');
    expect(fx.mesh.material.fragmentShader).toContain('vCore * core * 3.0 + vGlow * glow');
    fx.dispose();
  });

  it('reads current source ownership and palette every frame without changing timing, geometry identity or simulation', () => {
    const { world, fx } = fixture(), owner = source(0);
    const crystal = { id: owner.id, faction: 0 } as Crystal; world.crystals.set(owner.id, crystal);
    strike(fx, 10, owner); fx.update(10); const geometry = fx.mesh.geometry;
    expectColor(fx, 0, world.factions[0].color);
    crystal.faction = 2; world.factions[2].color = 0xff8800;
    const before = JSON.stringify(crystal); world.drainEvents();
    fx.update(10.01); expectColor(fx, 0, 0xff8800); expect(fx.mesh.geometry).toBe(geometry);
    expect(JSON.stringify(crystal)).toBe(before); expect(world.drainEvents()).toEqual([]);
    fx.update(10.361); expect(fx.mesh.visible).toBe(false);
    expect([...fx.mesh.material.uniforms.uAlpha.value]).toEqual(Array(8).fill(0)); fx.dispose();
  });

  it('resets expired and overwritten slots, leaving ownerless instability lightning its original lilac', () => {
    const { world, fx } = fixture();
    for (let i = 0; i < 8; i++) strike(fx, 10 + i * .001, source(1, 'ward'));
    fx.update(10.01); expectColor(fx, 0, world.factions[1].color);
    strike(fx, 10.02); fx.update(10.02); expectColor(fx, 0);
    expectColor(fx, 1, world.factions[1].color);
    fx.update(11); strike(fx, 11, source(3)); fx.update(11); expectColor(fx, 0, world.factions[3].color);
    fx.update(12); strike(fx, 12); fx.update(12); expectColor(fx, 0);
    const scene = new THREE.Scene(); scene.add(fx.mesh);
    const geometry = vi.spyOn(fx.mesh.geometry, 'dispose'), material = vi.spyOn(fx.mesh.material, 'dispose');
    fx.dispose(); expect(scene.children).toHaveLength(0); expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce();
  });

  it('routes protection events with defender identity, not the target or local player, and leaves discharges ownerless', () => {
    const bolts = { strike: vi.fn() };
    const stub = { ctx: { world: {}, time: 7 }, syncClock: vi.fn(), bolts, fx: { dischargeImpact: vi.fn() }, shake: vi.fn(), meleeImpacts: { onEvent: vi.fn() } };
    const send = (e: GameEvent) => VfxRenderer.prototype.onEvent.call(stub as unknown as VfxRenderer, e);
    const endpoints = { from: { x: 1, y: 2, z: 3 }, to: { x: 4, y: 5, z: 6 } };
    send({ t: 'crystalLightning', crystalId: 91, flagId: 92, faction: 3, ...endpoints });
    expect(bolts.strike).toHaveBeenLastCalledWith(7, 1, 2, 3, 4, 5, 6, { kind: 'crystal', id: 91, faction: 3 });
    send({ t: 'wardLightning', buildingId: 94, flagId: 95, faction: 1, ...endpoints });
    expect(bolts.strike).toHaveBeenLastCalledWith(7, 1, 2, 3, 4, 5, 6, { kind: 'ward', id: 94, faction: 1 });
    send({ t: 'discharge', target: 96, ...endpoints });
    expect(bolts.strike).toHaveBeenLastCalledWith(7, 1, 2, 3, 4, 5, 6);
  });
});
