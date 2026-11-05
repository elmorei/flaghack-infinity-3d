import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../sim/setup';
import type { Flag, FlagState } from '../../sim/types';
import type { RenderContext } from '../context';
import { FlagRenderer, FLAG_POLE_HEIGHT } from './flagRenderer';
import { flagSpriteRotation } from './flagSpriteTransform';
import { PLACE, type ActorView } from './lod';
import type { FlagSpriteStyle, SpritePose } from './mobileSprites';
import { LIFT } from '../survey/glsl';

const renderers: FlagRenderer[] = [];

beforeEach(() => {
  vi.stubGlobal('document', {createElement: () => ({
    width: 0, height: 0, getContext: () => ({fillRect() {}}),
  })});
});
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
  vi.unstubAllGlobals();
});

function fixture(mobile: boolean | 'desktop' = true, placement: number = PLACE.detailed) {
  const world = createMatch({seed: 'mobile-flag-presentation', difficulty: 'normal', humans: [0, 1, 2, 3], mode: 'standard'});
  world.flags.clear();
  const flag = vi.fn((_pose: SpritePose, _state: string, _style?: FlagSpriteStyle) => mobile === true);
  const camera = new THREE.PerspectiveCamera(); camera.updateMatrixWorld();
  const ctx = {
    world, scene: new THREE.Scene(), camera, time: 5, daylight: 1, sunDir: new THREE.Vector3(0, 1, 0),
    renderer: {capabilities: {getMaxAnisotropy: () => 1}},
    session: {playerFaction: 0, hover: {entity: -1}, selection: new Set()},
    shared: {mobileSprites: mobile === 'desktop' ? undefined : {flag}},
  } as unknown as RenderContext;
  const view = {shadows: true, place: vi.fn(() => placement)} as unknown as ActorView;
  const renderer = new FlagRenderer(ctx, view); renderers.push(renderer);
  return {ctx, world, flag, renderer, view};
}

function addFlag(e: ReturnType<typeof fixture>, id: number, state: FlagState): Flag {
  const flag: Flag = {
    id, type: 'flag', state, owner: 0, holder: -1, node: -1, altNode: -1,
    pos: {x: id, y: 4, z: -id}, plantedAt: 0, lastMovedAt: 0, history: [], tilt: 1,
  };
  e.world.flags.set(id, flag); return flag;
}

function models(e: ReturnType<typeof fixture>): THREE.InstancedMesh[] {
  return e.ctx.scene.children.filter(child => child.name.startsWith('actors-flags')) as THREE.InstancedMesh[];
}

describe('mobile flag presentation', () => {
  it('replaces planted, loose and flying models, leaving stock and unrendered carried flags alone', () => {
    const e = fixture();
    for (const [id, state] of [[1, 'planted'], [2, 'loose'], [3, 'flying'], [4, 'stock'], [5, 'carried']] as const) addFlag(e, id, state);
    const before = JSON.stringify([...e.world.flags.values()]);
    e.renderer.begin(); e.renderer.end();
    expect(e.flag.mock.calls.map(call => call[1])).toEqual(['planted', 'ground', 'thrown']);
    expect(e.flag.mock.calls.every(call => call[0].moving)).toBe(true);
    const planted = e.flag.mock.calls[0][0], ground = e.flag.mock.calls[1][0];
    expect(planted).toMatchObject({x: 1, y: 4, z: -1});
    expect(ground.x).toBe(2); expect(ground.y).toBeCloseTo(4.045); expect(ground.z).toBe(-2);
    expect(planted.height).toBeCloseTo(FLAG_POLE_HEIGHT);
    expect(ground.height).toBeCloseTo(FLAG_POLE_HEIGHT);
    expect(e.flag.mock.calls[1][2]?.rotation).toBe(0);
    expect(models(e).every(mesh => mesh.count === 0 && !mesh.visible)).toBe(true);
    expect(JSON.stringify([...e.world.flags.values()])).toBe(before);
  });

  it('replaces each carried transform exactly once at its presentation scale and anchor', () => {
    const e = fixture(); addFlag(e, 1, 'carried');
    const matrix = new THREE.Matrix4().makeRotationY(.7).scale(new THREE.Vector3(.6, .6, .6)).setPosition(7, 8, 9);
    const before = matrix.elements.slice();
    e.renderer.begin();
    e.renderer.pushMatrix(matrix, .25, 1, .2, 0, 0, e.renderer.ribbonColor(0));
    e.renderer.end();
    expect(e.flag).toHaveBeenCalledTimes(1);
    const [pose, state] = e.flag.mock.calls[0];
    expect(state).toBe('carried'); expect(pose).toMatchObject({x: 7, y: 8, z: 9});
    expect(pose.yaw).toBeCloseTo(.7); expect(pose.height).toBeCloseTo(FLAG_POLE_HEIGHT * .6);
    expect(matrix.elements).toEqual(before); expect(models(e).every(mesh => !mesh.visible)).toBe(true);
  });

  it('forwards faction ribbon, selection and decoherence cues without changing the flag', () => {
    const e = fixture(); const flag = addFlag(e, 1, 'planted'); flag.owner = 2;
    e.ctx.session.selection.add(flag.id);
    e.renderer.onEvent({t: 'flagDecohered', flagId: flag.id} as Parameters<FlagRenderer['onEvent']>[0]);
    e.renderer.begin(); e.renderer.end();
    const style = e.flag.mock.calls[0][2]!;
    expect(style.ribbon!.getHex()).toBe(new THREE.Color(e.world.factions[2].color).getHex());
    expect(style.highlight).toBe(1); expect(style.glitch).toBe(1);
    const id = e.flag.mock.calls[0][0].id;
    expect(id).toBeLessThan(0);
    e.flag.mockClear(); e.ctx.time += .2; e.renderer.begin(); e.renderer.end();
    expect(e.flag.mock.calls[0][0].id).toBe(id); expect(flag.owner).toBe(2);
  });

  it('pins every planted animation/camera frame to the exact node center, including rise and pull', () => {
    const e = fixture(); const flag = addFlag(e, 1, 'planted'); flag.node = 0;
    const node = e.world.lattice.nodes[0], ground = e.world.collision.groundHeight(node.x, node.z);
    flag.pos = {x: node.x + .2, y: ground + .3, z: node.z - .1};
    e.renderer.onEvent({t: 'flagPlanted', flagId: flag.id} as Parameters<FlagRenderer['onEvent']>[0]);
    const before = JSON.stringify(flag);
    for (const cameraYaw of [0, .7, Math.PI, -2.1]) for (const age of [0, .14, .28, .42, .7, 1.4]) {
      e.ctx.camera.rotation.set(-.9, cameraYaw, .12); e.ctx.camera.updateMatrixWorld(); e.ctx.time = 5 + age;
      e.flag.mockClear(); e.renderer.begin(); e.renderer.markPulling(flag.id, .6); e.renderer.end();
      const pose = e.flag.mock.calls[0][0];
      expect(pose.x).toBe(node.x); expect(pose.y).toBe(ground + LIFT.marker); expect(pose.z).toBe(node.z);
    }
    expect(JSON.stringify(flag)).toBe(before);
  });

  it('tracks the marker display tween and uses billboard-safe culling without changing desktop bounds', () => {
    const e = fixture(); const flag = addFlag(e, 1, 'planted'); flag.node = 0;
    e.ctx.shared.nodeMarkerPosition = (_node, out) => {out.set(12.5, 7.1, -19.25); return true;};
    e.renderer.begin(); e.renderer.end();
    expect(e.flag.mock.calls[0][0]).toMatchObject({x: 12.5, y: 7.1, z: -19.25});
    const call = vi.mocked(e.view.place).mock.calls[0];
    expect(call.slice(0, 3)).toEqual([12.5, 7.1, -19.25]); expect(call[3]).toBeCloseTo(FLAG_POLE_HEIGHT * 1.5);
    const desktop = fixture('desktop'); addFlag(desktop, 1, 'planted');
    desktop.renderer.begin(); desktop.renderer.end();
    expect(vi.mocked(desktop.view.place).mock.calls[0][1]).toBeCloseTo(4 + 1.3);
    expect(vi.mocked(desktop.view.place).mock.calls[0][3]).toBeCloseTo(1.6);
  });

  it.each([false, 'desktop'] as const)('retains desktop/unreplaced 3D flags (mobile = %s)', mobile => {
    const e = fixture(mobile); addFlag(e, 1, 'planted'); addFlag(e, 2, 'loose');
    e.renderer.begin(); e.renderer.end();
    const near = models(e).filter(mesh => !mesh.name.includes('-far-'));
    expect(near).toHaveLength(3); expect(near.every(mesh => mesh.count === 2 && mesh.visible)).toBe(true);
    expect(e.flag).toHaveBeenCalledTimes(mobile === 'desktop' ? 0 : 2);
  });

  it('does not emit off-screen sprites or hide a model before its individual replacement is accepted', () => {
    const e = fixture(); addFlag(e, 1, 'planted'); addFlag(e, 2, 'loose');
    e.flag.mockReturnValueOnce(false).mockReturnValueOnce(true);
    e.renderer.begin(); e.renderer.end();
    expect(models(e).filter(mesh => !mesh.name.includes('-far-')).every(mesh => mesh.count === 1)).toBe(true);
    vi.mocked(e.view.place).mockReturnValue(PLACE.skip);
    e.flag.mockClear(); e.renderer.begin(); e.renderer.end();
    expect(e.flag).not.toHaveBeenCalled(); expect(models(e).every(mesh => !mesh.visible)).toBe(true);
  });

  it('preserves world anchors for simulacrum twins and removes stale instances on the next frame', () => {
    const e = fixture(); const flag = addFlag(e, 1, 'planted'); flag.altNode = 0;
    const twin = e.world.lattice.nodes[0];
    e.renderer.begin(); e.renderer.end();
    expect(e.flag).toHaveBeenCalledTimes(2);
    const pose = e.flag.mock.calls[1][0];
    expect(pose.x).toBeCloseTo(twin.x); expect(pose.z).toBeCloseTo(twin.z);
    expect(pose.y).toBeCloseTo(e.world.collision.groundHeight(twin.x, twin.z) + LIFT.marker);
    e.world.flags.clear(); e.flag.mockClear(); e.renderer.begin(); e.renderer.end();
    expect(e.flag).not.toHaveBeenCalled(); expect(models(e).every(mesh => mesh.count === 0)).toBe(true);
  });

  it('uses animated transient sprites for a pulled flag, then retires the ghost', () => {
    const e = fixture();
    e.renderer.onEvent({t: 'flagPulled', flagId: 123, pos: {x: 1, y: 4, z: 2}, prevOwner: 0} as Parameters<FlagRenderer['onEvent']>[0]);
    e.ctx.time += .1; e.renderer.begin(); e.renderer.end();
    expect(e.flag).toHaveBeenCalledTimes(1); expect(e.flag.mock.calls[0][1]).toBe('thrown');
    expect(e.flag.mock.calls[0][0].y).toBeGreaterThan(4);
    e.ctx.time += 1; e.flag.mockClear(); e.renderer.begin(); e.renderer.end();
    expect(e.flag).not.toHaveBeenCalled(); expect(models(e).every(mesh => mesh.count === 0)).toBe(true);
  });
});

describe('flag screen-plane rotation', () => {
  it.each([0, .6, -1.2, Math.PI])('preserves pole roll %s without tilting the quad', angle => {
    const camera = new THREE.PerspectiveCamera(); camera.updateMatrixWorld();
    const matrix = new THREE.Matrix4().makeRotationZ(angle);
    expect(flagSpriteRotation(matrix.elements, camera)).toBeCloseTo(angle);
  });

  it('projects through camera pitch and roll, and handles a pole aimed at the eye', () => {
    const camera = new THREE.PerspectiveCamera(); camera.rotation.set(-.7, .3, .4); camera.updateMatrixWorld();
    const matrix = new THREE.Matrix4().makeRotationX(.9).multiply(new THREE.Matrix4().makeRotationZ(-.5));
    const pole = new THREE.Vector3(0, 1, 0).transformDirection(matrix).transformDirection(camera.matrixWorldInverse);
    expect(flagSpriteRotation(matrix.elements, camera)).toBeCloseTo(Math.atan2(-pole.x, pole.y));
    const facing = new THREE.PerspectiveCamera(); facing.updateMatrixWorld();
    expect(flagSpriteRotation(new THREE.Matrix4().makeRotationX(Math.PI / 2).elements, facing)).toBe(0);
  });
});
