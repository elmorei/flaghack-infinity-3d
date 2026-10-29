import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { spawnBuilding } from '../../sim/factory';
import { captureHearth } from '../../sim/systems/capture';
import { consumeBuilding } from '../../sim/systems/boss';
import { createMatch } from '../../sim/setup';
import type { RenderContext } from '../context';
import { buildThrone, poseSeatedRuler, ThroneRenderer, THRONE_PLATFORM_HEIGHT, THRONE_SCALE } from './throneRenderer';
import { buildAvatarRig } from './avatarModels';
import type { FactionId } from '../../sim/types';

function fixture() {
  const world=createMatch({seed:'rts-throne-render',difficulty:'normal',humans:[0],mode:'standard'});
  const ctx={world,scene:new THREE.Scene(),shared:{groundOffset:()=>7},time:3} as unknown as RenderContext;
  return {world,ctx,renderer:new ThroneRenderer(ctx)};
}
describe('RTS throne presentation',()=>{
  it.each([0x20f0aa,0xf03040,0x4080ff,0xffd020])('keeps tall split black banners and the owner stripe color %i',color=>{
    const throne=buildThrone(color);
    expect(throne.children).toHaveLength(3); // merged pipes, cloth, paint; no mesh-per-coupling cost
    const black=throne.getObjectByName('throne-black-banners') as THREE.Mesh;
    black.geometry.computeBoundingBox();
    expect(black.geometry.boundingBox!.max.y).toBeCloseTo(3.9);
    expect(black.geometry.boundingBox!.max.x-black.geometry.boundingBox!.min.x).toBeCloseTo(1.36);
    const stripes=throne.getObjectByName('throne-faction-stripes') as THREE.Mesh;
    expect((stripes.material as THREE.MeshStandardMaterial).color.getHex()).toBe(color);
    expect((black.material as THREE.MeshStandardMaterial).side).toBe(THREE.DoubleSide);
    // Low desk extends forward, leaving the ruler and tall banner silhouette unobscured.
    expect(black.geometry.boundingBox!.max.z).toBeCloseTo(.955);
    expect(black.geometry.boundingBox!.max.y).toBeGreaterThan(3.8);
  });
  it.each([0,1,2,3] as FactionId[])('seats the actual faction %i rig without combat or locomotion animation',f=>{
    const rig=buildAvatarRig(f,new THREE.MeshStandardMaterial()); poseSeatedRuler(rig,3);
    expect(rig.bones.hips.position.y).toBe(.63);
    expect(rig.bones.thighL.rotation.x).toBe(-Math.PI/2);
    expect(rig.bones.shinL.rotation.x).toBe(Math.PI/2);
    expect(rig.bones.quiver.scale.x).toBe(0);
    expect(rig.bones.root.rotation.x).toBe(0);
    rig.geometry.dispose(); rig.mesh.skeleton.dispose();
  });
  it('is RTS-only, follows altar transform and does not mutate gameplay',()=>{
    const e=fixture(); e.renderer.update(); expect(e.renderer.group.children).toHaveLength(0);
    e.world.factions[0].controlMode='rts';
    const altar=e.world.hearthOf(0)!; altar.pos={x:22,z:33}; altar.yaw=.75;
    const before=JSON.stringify([...e.world.buildings.values()]); const nav=e.world.nav.version;
    e.world.drainEvents(); e.renderer.update();
    const throne=e.renderer.group.children[0]; expect(throne.position.toArray()).toEqual([22,7,33]); expect(throne.rotation.y).toBe(.75);
    const ruler=throne.getObjectByName('rts-seated-avatar-0')!; expect(ruler.position.y).toBe(THRONE_PLATFORM_HEIGHT); expect(ruler.scale.x).toBe(THRONE_SCALE);
    expect(JSON.stringify([...e.world.buildings.values()])).toBe(before); expect(e.world.nav.version).toBe(nav); expect(e.world.drainEvents()).toEqual([]);
    e.renderer.dispose(); expect(e.ctx.scene.children).toHaveLength(0);
  });
  it('renders all four rulers without any avatar entities and reconstructs a late-join scene',()=>{
    const e=fixture(); e.world.avatars.clear();
    e.world.factions.forEach(f=>f.controlMode='rts');
    const flags=JSON.stringify([...e.world.flags.values()]);
    e.renderer.update(); expect(e.renderer.group.children).toHaveLength(4);
    expect(e.world.avatars.size).toBe(0); expect(JSON.stringify([...e.world.flags.values()])).toBe(flags);
    e.renderer.dispose(); const late=new ThroneRenderer(e.ctx); late.update();
    expect(late.group.children).toHaveLength(4); expect(late.group.children.every(c=>c.visible)).toBe(true); late.dispose();
  });
  it.each(['eliminated','removed','disabled','captured','avatar'] as const)('hides stale rulers after %s and restores from current state without events',reason=>{
    const e=fixture(); const fac=e.world.factions[0]; fac.controlMode='rts'; e.renderer.update();
    const altar=e.world.hearthOf(0)!; const throne=e.renderer.group.children[0]; expect(throne.visible).toBe(true);
    if(reason==='eliminated')fac.alive=false;
    if(reason==='removed')e.world.buildings.delete(altar.id);
    if(reason==='disabled')altar.disabled=true;
    if(reason==='captured')altar.faction=1;
    if(reason==='avatar')fac.controlMode='avatar';
    e.renderer.update(); expect(throne.visible).toBe(false);
    fac.alive=true; fac.controlMode='rts'; altar.disabled=false; altar.faction=0; e.world.buildings.set(altar.id,altar);
    e.renderer.update(); expect(throne.visible).toBe(true); expect(e.renderer.group.children).toHaveLength(1);
    e.renderer.dispose();
  });
});


it.each(['capture', 'boss'] as const)('moves the existing ruler and desk to the next owned altar after %s', cause => {
  const e = fixture(); e.world.factions[0].controlMode = 'rts';
  const first = e.world.hearthOf(0)!;
  const second = spawnBuilding(e.world, 'hearth', 0, 0, 1); second.pos = { x: 40, z: 70 }; second.yaw = .8;
  e.renderer.update(); const throne = e.renderer.group.children[0];
  if (cause === 'capture') captureHearth(e.world, first, 1); else consumeBuilding(e.world, first);
  e.renderer.update();
  expect(e.renderer.group.children).toHaveLength(1); expect(e.renderer.group.children[0]).toBe(throne);
  expect(throne.visible).toBe(true); expect(throne.position.toArray()).toEqual([40, 7, 70]); expect(throne.rotation.y).toBe(.8);
  if (cause === 'capture') captureHearth(e.world, second, 1); else consumeBuilding(e.world, second);
  e.renderer.update(); expect(throne.visible).toBe(false); e.renderer.dispose();
});
