import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { bossFixture } from '../../../../../tests/bossFixture';
import type { EnvContext } from '../../envTypes';
import type { SpritePose, FlagSpriteStyle } from '../../../actors/mobileSprites';
import { BossCombatFx } from './combatFx';

function fixture(mobile = true) {
  const model = new THREE.Group(); model.position.set(10, 2, -3); model.rotation.y = .6;
  for (const name of ['pelvis', 'spine', 'chest', 'head', 'thighL', 'thighR', 'handR']) {
    const bone = new THREE.Bone(); bone.name = name; model.add(bone);
  }
  model.getObjectByName('handR')!.position.set(1, 6, 2);
  const flag = vi.fn((_pose: SpritePose, _state: string, _style?: FlagSpriteStyle) => true);
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 10, 20); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const env = {noise: new THREE.DataTexture(new Uint8Array([127, 127, 127, 255]), 1, 1), ctx: {
    camera, shared: mobile ? {mobileSprites: {flag}} : {},
    world: {lattice: {version: 0, nodes: [], edges: []}, survey: {version: 0, edgeLey: new Int8Array()},
      map: {effigy: {x: 0, z: 0}}, factions: [{color: 0xdd2200}]},
  }} as unknown as EnvContext;
  const fx = new BossCombatFx(env, model);
  const boss = bossFixture(); boss.action = 'grab'; boss.actionAt = boss.spawnedAt = 0; boss.barrier = null;
  boss.held = {kind: 'flag', id: 12, faction: 0, x: 0, z: 0};
  return {model, flag, fx, boss};
}

describe('boss-held mobile flag', () => {
  it('replaces the hand-attached proxy at its transformed bottom, without changing gameplay', () => {
    const e = fixture(), before = JSON.stringify(e.boss);
    e.fx.update(e.boss, 2);
    expect(e.flag).toHaveBeenCalledTimes(1);
    const pole = e.model.getObjectByName('boss-held-flag-pole')!, proxy = pole.parent!;
    expect(proxy.visible).toBe(false);
    const bottom = new THREE.Vector3(0, -1.8, 0).applyMatrix4(proxy.matrixWorld);
    const [pose, state, style] = e.flag.mock.calls[0];
    expect(state).toBe('carried');
    expect(pose.x).toBeCloseTo(bottom.x); expect(pose.y).toBeCloseTo(bottom.y); expect(pose.z).toBeCloseTo(bottom.z);
    expect(style!.ribbon!.getHex()).toBe(0xdd2200); expect(Number.isFinite(style!.rotation)).toBe(true);
    expect(JSON.stringify(e.boss)).toBe(before);
    const fullHeight = pose.height;
    e.flag.mockClear(); e.fx.update(e.boss, 2.7);
    expect(e.flag.mock.calls[0][0].height).toBeLessThan(fullHeight);
    e.boss.held = null; e.flag.mockClear(); e.fx.update(e.boss, 3);
    expect(e.flag).not.toHaveBeenCalled(); expect(e.model.getObjectByName('boss-held-target')!.visible).toBe(false);
    e.fx.dispose();
  });

  it('leaves desktop carried geometry visible and does not duplicate other held props', () => {
    const desktop = fixture(false); desktop.fx.update(desktop.boss, 2);
    expect(desktop.flag).not.toHaveBeenCalled(); expect(desktop.model.getObjectByName('boss-held-flag-pole')!.parent!.visible).toBe(true);
    desktop.fx.dispose();
    const mobile = fixture(); mobile.boss.held!.kind = 'building'; mobile.fx.update(mobile.boss, 2);
    expect(mobile.flag).not.toHaveBeenCalled(); expect(mobile.model.getObjectByName('boss-held-building-body')!.parent!.visible).toBe(true);
    mobile.fx.dispose();
  });
});
