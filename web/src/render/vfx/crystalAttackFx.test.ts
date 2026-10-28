import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { crystalAttackFixture } from '../../../tests/crystalAttackFixture';
import { updateCrystalAttacks } from '../../sim/systems/crystalAttacks';
import { CrystalAttackFx } from './crystalAttackFx';
const flat = () => 0;
describe('ordinary crystal attack presentation', () => {
  it('shows the warning ring, then owner-colored lightning; reads current source colors and keeps stable buffers', () => {
    const e = crystalAttackFixture(), c = e.crystal(), h = e.unit(); updateCrystalAttacks(e.world, 0);
    const fx = new CrystalAttackFx(); fx.update(e.world, 10, flat);
    const arc = fx.group.getObjectByName(`crystal-unit-lightning-${c.id}`) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const ring = fx.group.getObjectByName(`crystal-unit-warning-${c.id}`) as THREE.Mesh;
    expect(ring.visible).toBe(true); expect(arc.material.uniforms.uFlicker.value).toBeLessThan(.15);
    const buffer = arc.geometry.getAttribute('position').array, before = JSON.stringify(c), hp = h.hp;
    for (let i = 0; i < 10; i++) fx.update(e.world, 10 + i / 10, flat);
    expect(JSON.stringify(c)).toBe(before); expect(h.hp).toBe(hp); expect(arc.geometry.getAttribute('position').array).toBe(buffer);
    e.world.time = 11; fx.update(e.world, 11, flat); expect(ring.visible).toBe(false); expect(arc.material.uniforms.uFlicker.value).toBeGreaterThan(.3);
    for (const faction of [0, 2, 3] as const) {
      c.faction = faction; c.attack!.faction = faction; fx.update(e.world, 12, flat);
      expect(arc.material.uniforms.uGlow.value).toEqual(new THREE.Color(e.world.factions[faction].color).multiplyScalar(2.2));
    }
    h.pos.x = 13; fx.update(e.world, 12, flat); const p = arc.geometry.getAttribute('position');
    expect(p.getX(0)).toBe(0); expect(p.getY(0)).toBe(7.5); expect(p.getX(48)).toBe(13); expect(p.getY(48)).toBe(1);
    const dispose = vi.spyOn(arc.geometry, 'dispose'); c.attack = null; fx.update(e.world, 12, flat);
    expect(fx.group.visible).toBe(false); expect(dispose).toHaveBeenCalledOnce(); fx.dispose();
  });
  it('uses authoritative simulation time for warning progress despite skewed or paused presentation clocks', () => {
    const e = crystalAttackFixture(), c = e.crystal(); e.unit(); updateCrystalAttacks(e.world, 0);
    const fx = new CrystalAttackFx(); fx.update(e.world, 10000, flat);
    const ring = fx.group.getObjectByName(`crystal-unit-warning-${c.id}`) as THREE.Mesh;
    expect(ring.visible).toBe(true); expect(ring.scale.x).toBeCloseTo(1.4);
    fx.update(e.world, 20000, flat);
    expect(ring.visible).toBe(true); expect(ring.scale.x).toBeCloseTo(1.4);
    e.world.time = 10.5; fx.update(e.world, 0, flat);
    expect(ring.visible).toBe(true); expect(ring.scale.x).toBeCloseTo(1.1);
    e.world.time = 11; fx.update(e.world, .1, flat);
    expect(ring.visible).toBe(false); fx.dispose();
  });
  it('immediately clears on disabled settings, shatter, alliance, missing target and match end', () => {
    for (const reason of ['disabled', 'shatter', 'alliance', 'target', 'ended'] as const) {
      const e = crystalAttackFixture(), c = e.crystal(), h = e.unit(); updateCrystalAttacks(e.world, 0);
      const fx = new CrystalAttackFx(); fx.update(e.world, 10, flat); expect(fx.group.visible).toBe(true);
      if (reason === 'disabled') e.world.options.match!.crystalAttacks = false;
      if (reason === 'shatter') e.world.crystals.delete(c.id);
      if (reason === 'alliance') e.world.effigyRevealedAt = 10;
      if (reason === 'target') e.world.hippies.delete(h.id);
      if (reason === 'ended') e.world.phase = 'ended';
      fx.update(e.world, 11, flat); expect(fx.group.children).toHaveLength(0); fx.dispose();
    }
  });
});

import { spawnBuilding } from '../../sim/factory';
import { THRONE_ATTACK_HEIGHT } from '../../sim/systems/crystalAttacks';
describe('seated ruler attack presentation', () => {
  it.each([0, 1, 2, 3] as const)('uses faction %s tint and seated origin without changing gameplay', faction => {
    const e = crystalAttackFixture(), f = e.world.factions[faction];
    const altar = spawnBuilding(e.world, 'hearth', faction, 0, 1);
    altar.pos = { x: 0, z: 0 }; f.hearthIds = [altar.id]; f.controlMode = 'rts';
    const h = e.unit(10, 0, faction === 0 ? 1 : 0); updateCrystalAttacks(e.world, 0);
    const before = JSON.stringify(f), hp = h.hp, fx = new CrystalAttackFx(); fx.update(e.world, 10000, flat);
    const arc = fx.group.getObjectByName(`crystal-unit-lightning-${altar.id}`) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const ring = fx.group.getObjectByName(`crystal-unit-warning-${altar.id}`) as THREE.Mesh;
    expect(arc).toBeTruthy(); expect(ring.visible).toBe(true);
    expect(arc.material.uniforms.uGlow.value).toEqual(new THREE.Color(f.color).multiplyScalar(2.2));
    expect(arc.geometry.getAttribute('position').getY(0)).toBeCloseTo(THRONE_ATTACK_HEIGHT);
    for (let i = 0; i < 10; i++) fx.update(e.world, 11000 + i, flat);
    expect(JSON.stringify(f)).toBe(before); expect(h.hp).toBe(hp); expect(ring.visible).toBe(true);
    e.world.buildings.delete(altar.id); fx.update(e.world, 12000, flat); expect(fx.group.visible).toBe(false); fx.dispose();
  });
});
