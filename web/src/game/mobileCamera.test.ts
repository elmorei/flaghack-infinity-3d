import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraRig, CMD_PITCH, FOV_COMMAND, MOBILE_COMMAND_PITCH, MOBILE_COMMAND_YAW, commandGroundPoint, mobileCommandHeight, newPose } from './cameraRig';
import { Session } from './session';
const mobile = () => vi.stubGlobal('document', { documentElement: { dataset: { deviceLayout: 'mobile' } } });
afterEach(() => vi.unstubAllGlobals());
function camera(height: number, viewportHeight: number, width: number) {
  const c = new THREE.PerspectiveCamera(FOV_COMMAND, width / viewportHeight, 0.1, 1200);
  const dist = height / -Math.sin(MOBILE_COMMAND_PITCH);
  c.position.set(-Math.sin(MOBILE_COMMAND_YAW) * Math.cos(MOBILE_COMMAND_PITCH) * dist,
    height, -Math.cos(MOBILE_COMMAND_YAW) * Math.cos(MOBILE_COMMAND_PITCH) * dist);
  c.lookAt(0, 0, 0); c.updateMatrixWorld(); return c;
}
describe('fixed mobile command camera', () => {
  it('keeps a selectable character scale across portrait and landscape windows', () => {
    mobile();
    for (const [width, height] of [[390, 844], [844, 390], [320, 568], [820, 1180]]) {
      const c = camera(mobileCommandHeight(height), height, width);
      const feet = new THREE.Vector3(0, 0, 0).project(c), head = new THREE.Vector3(0, 2, 0).project(c);
      const pixels = Math.abs(head.y - feet.y) * height / 2;
      expect(pixels).toBeGreaterThan(28); expect(pixels).toBeLessThan(31);
    }
  });
  it('uses the same diagonal view for pan ground rays and rendered picking', () => {
    mobile(); const s = new Session(); s.camera.cmdHeight = mobileCommandHeight(844);
    s.camera.cmdX = 0; s.camera.cmdZ = 0;
    const c = camera(s.camera.cmdHeight, 844, 390);
    for (const [nx, ny] of [[0, 0], [.5, .4], [-.6, -.3]]) {
      const out = { x: 0, z: 0 };
      expect(commandGroundPoint(s.camera, nx, ny, c.aspect, out)).toBe(true);
      const p = new THREE.Vector3(out.x, 0, out.z).project(c);
      expect(p.x).toBeCloseTo(nx, 8); expect(p.y).toBeCloseTo(ny, 8);
    }
  });
  it('fixes mobile angle and immediately preserves scale on orientation resize', () => {
    mobile(); const s = new Session(); s.camera.cmdHeight = mobileCommandHeight(844);
    const rig = new CameraRig(), pose = newPose(), world = { collision: { groundHeight: () => 0 } };
    (rig as any).commandPose(world, s.camera, 0.016, pose);
    expect(pose.pitch).toBe(MOBILE_COMMAND_PITCH); expect(pose.yaw).toBe(MOBILE_COMMAND_YAW);
    s.camera.cmdHeight = mobileCommandHeight(390);
    (rig as any).commandPose(world, s.camera, 0.016, pose);
    expect(pose.dist * -Math.sin(pose.pitch)).toBeCloseTo(s.camera.cmdHeight, 10);
  });
  it('leaves desktop command orientation unchanged', () => {
    const rig = new CameraRig(), s = new Session(), pose = newPose();
    (rig as any).commandPose({ collision: { groundHeight: () => 0 } }, s.camera, 0.016, pose);
    expect(pose.pitch).toBe(CMD_PITCH); expect(pose.yaw).toBe(Math.PI);
  });
});
