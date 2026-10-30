import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraRig, CMD_PITCH, FOV_COMMAND, MOBILE_COMMAND_PITCH, MOBILE_COMMAND_YAW, commandGroundPoint, mobileCommandHeight, mobileCommandExtent, newPose } from './cameraRig';
import { cameraPointerRay, worldUnitsPerPixel } from '../render/cameraProjection';
import { GameRenderer } from '../render/renderer';
import { ActorView, PLACE } from '../render/actors/lod';
import { Session } from './session';
const mobile = (angle = 60) => vi.stubGlobal('document', { documentElement: { dataset: { deviceLayout: 'mobile', mobileCameraElevation: String(angle) } } });
afterEach(() => vi.unstubAllGlobals());
function camera(height: number, viewportHeight: number, width: number, angle = 60) {
  const half = mobileCommandExtent(viewportHeight) / 2;
  const c = new THREE.OrthographicCamera(-half*width/viewportHeight, half*width/viewportHeight, half, -half, .1, 1200);
  const pitch = -angle * Math.PI / 180, dist = height / -Math.sin(pitch);
  c.position.set(-Math.sin(MOBILE_COMMAND_YAW) * Math.cos(pitch) * dist,
    height, -Math.cos(MOBILE_COMMAND_YAW) * Math.cos(pitch) * dist);
  c.lookAt(0, 0, 0); c.updateMatrixWorld(); return c;
}
describe('parallel mobile command camera', () => {
  it('keeps a selectable character scale across portrait and landscape windows', () => {
    mobile();
    for (const [width, height] of [[390,844],[844,390],[320,568],[820,1180]]) {
      const c = camera(mobileCommandHeight(height), height, width);
      const feet = new THREE.Vector3(0,0,0).project(c), head = new THREE.Vector3(0,2,0).project(c);
      expect(Math.abs(head.y-feet.y)*height/2).toBeCloseTo(28.57142857, 6);
      expect(worldUnitsPerPixel(c, height, 10)).toBeCloseTo(.035);
      expect(worldUnitsPerPixel(c, height, 100)).toBeCloseTo(.035);
    }
  });
  it('matches orthographic rendering, touch-pan ground points, and parallel picking at the fixed 60-degree angle', () => {
    for (const angle of [45,60,75]) {
      // Stale preview attributes cannot change the selected production angle.
      mobile(angle); const s = new Session(); s.camera.cmdHeight = mobileCommandHeight(844);
      s.camera.cmdX = 0; s.camera.cmdZ = 0;
      const c = camera(s.camera.cmdHeight,844,390);
      const centre = cameraPointerRay(c,0,0,new THREE.Ray());
      for (const [nx,ny] of [[0,0],[.5,.4],[-.6,-.3]]) {
        const out = {x:0,z:0}; expect(commandGroundPoint(s.camera,nx,ny,390/844,out)).toBe(true);
        const p = new THREE.Vector3(out.x,0,out.z).project(c);
        expect(p.x).toBeCloseTo(nx,8); expect(p.y).toBeCloseTo(ny,8);
        const ray = cameraPointerRay(c,nx,ny,new THREE.Ray());
        expect(ray.direction.distanceTo(centre.direction)).toBeLessThan(1e-10);
        const hit = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),new THREE.Vector3())!;
        expect(hit.x).toBeCloseTo(out.x,8); expect(hit.z).toBeCloseTo(out.z,8);
      }
    }
  });
  it('preserves parallel object size at different world depths, without perspective convergence', () => {
    mobile(); const c = camera(mobileCommandHeight(844),844,390);
    const span = (z:number) => new THREE.Vector3(2,0,z).project(c).distanceTo(new THREE.Vector3(0,0,z).project(c));
    expect(span(-10)).toBeCloseTo(span(10),10);
    expect(c.isOrthographicCamera).toBe(true);
    expect(c.projectionMatrix.elements[11]).toBe(0);
  });
  it('fixes angle and immediately preserves extent on resize; rejects arbitrary rotation values', () => {
    mobile(); const s = new Session(); s.camera.cmdHeight = mobileCommandHeight(844);
    const rig = new CameraRig(), pose = newPose(), world = {collision:{groundHeight:()=>0}};
    (rig as any).commandPose(world,s.camera,.016,pose);
    expect(pose.pitch).toBe(MOBILE_COMMAND_PITCH); expect(pose.yaw).toBe(MOBILE_COMMAND_YAW);
    s.camera.cmdHeight = mobileCommandHeight(390);
    (rig as any).commandPose(world,s.camera,.016,pose);
    expect(pose.dist * -Math.sin(pose.pitch)).toBeCloseTo(s.camera.cmdHeight,10);
    for (const angle of [42,45,75]) {
      mobile(angle); (rig as any).commandPose(world,s.camera,.016,pose);
      expect(pose.pitch).toBe(MOBILE_COMMAND_PITCH);
    }
  });
  it('limits orthographic use to settled mobile command view, not dialogue/action/title or emergence', () => {
    mobile(); const rig = new CameraRig();
    rig.setMode('play',0); expect(rig.useMobileOrthographic(1)).toBe(true);
    expect(rig.useMobileOrthographic(.5)).toBe(false);
    (rig as any).effigyLocked = true; expect(rig.useMobileOrthographic(1)).toBe(false);
    for (const mode of ['dialogue','title','ended'] as const) {rig.setMode(mode,0); expect(rig.useMobileOrthographic(1)).toBe(false);}
    vi.unstubAllGlobals(); rig.setMode('play',0); expect(rig.useMobileOrthographic(1)).toBe(false);
  });
  it('switches the actual renderer and shared context together, then restores its perspective camera', () => {
    const perspective = new THREE.PerspectiveCamera(), orthographic = new THREE.OrthographicCamera();
    const renderer:any = Object.create(GameRenderer.prototype);
    Object.assign(renderer,{perspective,orthographic,camera:perspective,ctx:{camera:perspective}});
    renderer.setMobileOrthographic(true);
    expect(renderer.camera).toBe(orthographic); expect(renderer.ctx.camera).toBe(orthographic);
    renderer.setMobileOrthographic(false);
    expect(renderer.camera).toBe(perspective); expect(renderer.ctx.camera).toBe(perspective);
  });
  it('holds actor detail constant between all angles and orientations at the same pixel scale', () => {
    for (const [width,height] of [[390,844],[844,390]]) for (const angle of [45,60,75]) {
      mobile(angle); const c = camera(mobileCommandHeight(height),height,width,angle); c.userData.cssHeight = height;
      const view = new ActorView(false); view.update(c);
      expect(view.place(0,0,0,2,40,false)).toBe(PLACE.detailed);
      expect(view.place(1000,0,1000,2,40,false)).toBe(PLACE.skip);
    }
  });
  it('leaves desktop command orientation and perspective picking unchanged', () => {
    const rig = new CameraRig(), s = new Session(), pose = newPose();
    (rig as any).commandPose({collision:{groundHeight:()=>0}},s.camera,.016,pose);
    expect(pose.pitch).toBe(CMD_PITCH); expect(pose.yaw).toBe(Math.PI);
    const c = new THREE.PerspectiveCamera(FOV_COMMAND,1,.1,1200); c.position.set(0,20,20);c.lookAt(0,0,0);c.updateMatrixWorld();
    const a = cameraPointerRay(c,0,0,new THREE.Ray()), b = cameraPointerRay(c,.5,.5,new THREE.Ray());
    expect(a.origin.equals(b.origin)).toBe(true); expect(a.direction.distanceTo(b.direction)).toBeGreaterThan(.1);
  });
});
