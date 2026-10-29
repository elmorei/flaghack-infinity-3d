import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CameraRig, dialoguePose, newPose } from './cameraRig';
import { Session } from './session';
import type { World } from '../sim/world';
import type { Avatar } from '../sim/types';

const world = { collision: { groundHeight: () => 0, raycast: () => null } } as unknown as World;
const player = { pos: { x: 0, y: 0, z: 0 } } as Avatar;
const wizard = { pos: { x: 0, z: 2.5 } };
function camera(p: ReturnType<typeof newPose>, aspect: number) {
  const c = new THREE.PerspectiveCamera(p.fov, aspect, .1, 1000);
  const cp = Math.cos(p.pitch);
  c.position.set(p.tx - Math.sin(p.yaw) * cp * p.dist, p.ty - Math.sin(p.pitch) * p.dist, p.tz - Math.cos(p.yaw) * cp * p.dist);
  c.lookAt(p.tx, p.ty, p.tz); c.updateMatrixWorld(); return c;
}
describe('Frick-frack in-world two-shot', () => {
  it('keeps both heads and bodies inside the unobscured upper field in desktop and phone orientations', () => {
    for (const [width, height] of [[1280,800], [320,568], [844,390]]) {
      const pose = dialoguePose(world, player.pos, { ...wizard.pos, y: 0 }, width / height);
      const c = camera(pose, width / height);
      for (const [x,z] of [[0,0],[0,2.5]]) {
        const chest = new THREE.Vector3(x, 1.2, z).project(c);
        const head = new THREE.Vector3(x, z ? 2.57 : 1.9, z).project(c);
        expect(Math.abs(chest.x)).toBeLessThan(.85); expect(Math.abs(head.x)).toBeLessThan(.85);
        expect(chest.y).toBeGreaterThan(.08); expect(head.y).toBeLessThan(.98);
      }
    }
  });
  it('rotates to an alternative clear side when the preferred side is blocked', () => {
    let calls = 0;
    const blocked = { collision: {groundHeight: () => 0, raycast: () => ++calls <= 2 ? {dist:.2} : null} } as unknown as World;
    expect(dialoguePose(blocked, player.pos, {...wizard.pos,y:0},1.6).yaw).not.toBe(dialoguePose(world, player.pos, {...wizard.pos,y:0},1.6).yaw);
  });
  it('keeps camera above raised terrain and produces finite poses for coincident subjects', () => {
    const hill = {collision: {groundHeight: () => 4, raycast: () => null}} as unknown as World;
    const p = dialoguePose(hill, player.pos, player.pos, .5);
    expect(p.ty - Math.sin(p.pitch) * p.dist).toBeGreaterThanOrEqual(5.1);
    expect(Object.values(p).every(Number.isFinite)).toBe(true);
  });
  it('locks the scene pose without mutating saved camera and restores normal view after release', () => {
    const rig = new CameraRig(), s = new Session(); const saved = {...s.camera};
    rig.setMode('dialogue', .7); rig.updateDialogue(world, player, wizard, 1.6, 1);
    const locked = {...rig.pose};
    rig.updateDialogue(world, {...player,pos:{x:30,y:0,z:10}}, wizard, 1.6, 1);
    expect(rig.pose).toEqual(locked); expect(s.camera).toEqual(saved);
    rig.setMode('play', .7);
    // The normal camera path owns the exact original Session target again after release.
    (rig as any).commandPose(world, s.camera, 1, (rig as any).base);
    (rig as any).finish(1);
    expect(rig.pose.yaw).not.toBe(locked.yaw); expect(s.camera).toEqual(saved);
  });
});
