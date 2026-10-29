import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../game/session';
import { CMD_HEIGHT_MIN, CMD_HEIGHT_MAX, CMD_PITCH, FOV_COMMAND } from '../../game/cameraRig';
import { spawnFlag } from '../../sim/factory';
import { createMatch } from '../../sim/setup';
import { plantFlag, pullFlag } from '../../sim/systems/flags';
import { cmdPlan, updateSurvey } from '../../sim/systems/survey';
import type { FactionId } from '../../sim/types';
import { GameRenderer } from '../renderer';
import { createSurveyUniforms } from './glsl';
import { MarkedNodeLayer, MARK, MARK_SIZE_PX, markedNodeOwner, renderCommandOverlay } from './markedNodes';
import { SurveyData } from './surveyData';
import { ImpliedPlanFeature } from './impliedPlan';
import { createDecalMaterial } from './decals';
import { GHOST, GhostFlagLayer } from './ghostFlags';
import { createGradeMaterial } from '../post/grade';
import { postInstability, SCENE_UV_GLSL } from '../post/uvWarp';

function fixture() {
  const world = createMatch({ seed: 'persistent-map-marks', mode: 'standard', difficulty: 'normal', humans: [0] });
  const session = new Session(); session.screen = 'playing'; session.view = 'command'; session.viewBlend = 1;
  const data = new SurveyData(world);
  const u = createSurveyUniforms({ node: data.nodeTex, aux: data.auxTex, edge: data.edgeTex, facet: data.facetTex });
  const fx = { acid: 0, instability: 0 };
  const layer = new MarkedNodeLayer(world, session, data, u, fx);
  const mesh = layer.scene.children[0] as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  const free = world.lattice.nodes.filter(n => !n.blocked && world.survey.holder[n.id] < 0);
  const n = free[Math.floor(free.length / 2)].id;
  const update = () => { updateSurvey(world, 0); data.update(world.time); layer.update(); };
  const mark = (nodes: number[], faction: FactionId = session.playerFaction) => cmdPlan(world, { t: 'plan', faction, op: 'add', nodes });
  const state = () => Array.from((mesh.geometry.getAttribute('iMark').array as Float32Array).slice(0, mesh.geometry.instanceCount * 4));
  const plant = (f: FactionId) => {
    const node = world.lattice.nodes[n];
    const flag = spawnFlag(world, { owner: f, state: 'loose', pos: { x: node.x, y: 0, z: node.z } });
    expect(plantFlag(world, flag.id, n, f, -1)).toBe(true); update(); return flag;
  };
  const cleanup = () => { layer.dispose(); data.dispose(); };
  return { world, session, data, u, fx, layer, mesh, free, n, mark, state, plant, update, cleanup };
}
const colour = (hex: number): number[] => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
function expectMark(state: number[], hex: number, kind: number) {
  expect(state).toHaveLength(4);
  colour(hex).forEach((c, i) => expect(state[i]).toBeCloseTo(c, 6));
  expect(state[3]).toBe(kind);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('persistent main-map marked nodes', () => {
  it('keeps marked intent through real capture, loss, rival capture and recapture', () => {
    const e = fixture(); e.mark([e.n]); e.update(); expectMark(e.state(), 0x000000, MARK.dot);
    const own = e.plant(0); expectMark(e.state(), e.world.factions[0].color, MARK.dot);
    expect(e.world.factions[0].plan.has(e.n)).toBe(true);
    expect(pullFlag(e.world, own.id, -1)).toBe(true); e.update(); expectMark(e.state(), 0x000000, MARK.dot);
    const rival = e.plant(2); expectMark(e.state(), e.world.factions[2].color, MARK.cross);
    expect(pullFlag(e.world, rival.id, -1)).toBe(true); e.update();
    e.plant(0); expectMark(e.state(), e.world.factions[0].color, MARK.dot);
    cmdPlan(e.world, { t: 'plan', faction: 0, op: 'remove', nodes: [e.n] }); e.update();
    expect(e.mesh.geometry.instanceCount).toBe(0); expect(e.layer.scene.visible).toBe(false); e.cleanup();
  });

  it.each([1, 2, 3] as const)('uses opponent %i actual colour for its X', f => {
    const e = fixture(); e.mark([e.n]); e.plant(f); expectMark(e.state(), e.world.factions[f].color, MARK.cross); e.cleanup();
  });

  it('uses implied ownership as possession and never labels a neutral flag as an opponent', () => {
    const e = fixture(); e.mark([e.n]);
    e.world.survey.holder[e.n] = 0; e.layer.update(); expectMark(e.state(), e.world.factions[0].color, MARK.dot);
    e.world.survey.holder[e.n] = 3; e.layer.update(); expectMark(e.state(), e.world.factions[3].color, MARK.cross);
    e.world.survey.nodeFlag[e.n] = 999; e.world.survey.nodeFlagOwner[e.n] = -1;
    expect(markedNodeOwner(e.world, e.n)).toBe(-1); e.layer.update(); expectMark(e.state(), 0x000000, MARK.dot);
    e.world.survey.nodeFlagOwner[e.n] = 0; e.layer.update(); expectMark(e.state(), e.world.factions[0].color, MARK.dot); e.cleanup();
  });

  it('only shows the viewed player’s plan, with no stale marks after changing faction or mode', () => {
    const e = fixture(); e.mark([e.n], 0); e.mark([e.free[0].id], 1); e.update();
    const anchors = () => Array.from(e.mesh.geometry.getAttribute('iNode').array).slice(0, e.mesh.geometry.instanceCount);
    expect(anchors()).toEqual([e.n]);
    for (let i = 0; i < 2; i++) {
      e.session.view = 'action'; e.update(); expect(e.layer.scene.visible).toBe(false); expect(anchors()).toEqual([]);
      e.session.view = 'command'; e.update(); expect(anchors()).toEqual([e.n]);
    }
    e.session.playerFaction = 1; e.update(); expect(anchors()).toEqual([e.free[0].id]);
    e.session.screen = 'title'; e.update(); expect(anchors()).toEqual([]);
    e.session.screen = 'paused'; e.update(); expect(anchors()).toEqual([e.free[0].id]);
    cmdPlan(e.world, { t: 'plan', faction: 1, op: 'clear', nodes: [] }); e.update(); expect(anchors()).toEqual([]); e.cleanup();
  });

  it('handles every valid marked node without a 1024-marker cap and ignores invalid/blocked ids', () => {
    const e = fixture(); const valid = e.world.lattice.nodes.filter(n => !n.blocked).map(n => n.id);
    expect(valid.length).toBeGreaterThan(1024);
    e.mark([...valid, -1, 1.5, NaN, e.data.nodeCount]);
    const blocked = e.world.lattice.nodes.find(n => n.blocked); if (blocked) e.mark([blocked.id]);
    e.update(); expect(e.mesh.geometry.instanceCount).toBe(valid.length); expect(e.world.factions[0].plan.has(e.n)).toBe(true); e.cleanup();
  });

  it('follows the live node texture and does not use glow, fog or tone mapping to wash out black', () => {
    const e = fixture(); e.mark([e.n]); e.update();
    expect(e.mesh.material.uniforms.uNodeTex).toBe(e.u.uNodeTex);
    expect(e.mesh.material.uniforms.uResolution).toBe(e.u.uResolution);
    expect(e.mesh.material.uniforms.uPx).toBe(e.u.uPx);
    expect(e.mesh.material.uniforms.uHover).toBe(e.u.uHover);
    expect(e.mesh.material.toneMapped).toBe(false); expect(e.mesh.material.depthTest).toBe(false); expect(e.mesh.material.depthWrite).toBe(false);
    expect(e.mesh.material.fragmentShader).not.toMatch(/uGlow|fhFogKeep|tonemapping_fragment/);
    expect(e.mesh.material.vertexShader).toContain('fhNode(id).xy');
    const geo = vi.spyOn(e.mesh.geometry, 'dispose'), mat = vi.spyOn(e.mesh.material, 'dispose');
    e.cleanup(); expect(e.layer.scene.children).toEqual([]); expect(geo).toHaveBeenCalledOnce(); expect(mat).toHaveBeenCalledOnce();
  });

  it('shares the exact map UV warp and normalization while preserving ungraded symbol colour', () => {
    const e = fixture(); const grade = createGradeMaterial();
    expect(e.mesh.material.vertexShader).toContain(SCENE_UV_GLSL);
    expect(grade.material.fragmentShader).toContain(SCENE_UV_GLSL);
    expect(grade.material.fragmentShader).toContain('uv = fhSceneUv(uv, uAspect, t, acid, instability)');
    for (const raw of [0, .25, .35, .475, .7, 1]) {
      e.fx.acid = .8; e.fx.instability = raw; e.update();
      const warp = e.mesh.material.uniforms.uMarkWarp.value as THREE.Vector2;
      expect(warp.x).toBe(.8); expect(warp.y).toBeCloseTo(THREE.MathUtils.smoothstep(raw, .25, .7));
      expect(warp.y).toBe(postInstability(raw));
    }
    grade.material.dispose(); e.cleanup();
  });

  it('replaces own committed ghosts only in Command View and keeps unsaved tool previews', () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, strokeText() {}, fillText() {} }) }) });
    const e = fixture(); e.mark([e.n]); e.session.view = 'action';
    const scene = new THREE.Scene(); const mat = createDecalMaterial(e.u);
    const feature = new ImpliedPlanFeature(scene, e.world, e.session, e.data, e.u, mat);
    const push = vi.spyOn(GhostFlagLayer.prototype, 'push');
    const plans = () => push.mock.calls.filter(c => c[0] === GHOST.plan).map(c => c[1]);
    for (let i = 0; i < 2; i++) {
      e.session.view = 'action'; push.mockClear(); feature.update(); expect(plans()).toEqual([e.n]);
      e.session.view = 'command'; push.mockClear(); feature.update(); expect(plans()).toEqual([]);
    }
    e.session.planPreview = [e.free[0].id]; push.mockClear(); feature.update(); expect(plans()).toEqual([e.free[0].id]);
    expect(e.world.factions[0].plan.has(e.n)).toBe(true);
    feature.dispose(); mat.dispose(); e.cleanup();
  });

  it.each([1, 2])('keeps an 18-CSS-pixel core at all supported zoom extremes at DPR %i', px => {
    const e = fixture(); const height = 900 * px, width = 1600 * px;
    for (const zoom of [CMD_HEIGHT_MIN, 120, CMD_HEIGHT_MAX]) {
      const camera = new THREE.PerspectiveCamera(FOV_COMMAND, width / height, .1, 1200);
      camera.position.set(0, zoom, -zoom / Math.sin(CMD_PITCH) * Math.cos(CMD_PITCH)); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      const clip = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      // Same screen-space extrusion as the shipped vertex shader, before perspective division.
      const left = clip.x - MARK_SIZE_PX / 2 * px * 2 / width * clip.w;
      const right = clip.x + MARK_SIZE_PX / 2 * px * 2 / width * clip.w;
      expect((right / clip.w - left / clip.w) * width / 2 / px).toBeCloseTo(18, 8);
      expect(e.mesh.material.vertexShader).toContain('uPx * 2.0 / uResolution * clip.w');
    }
    e.cleanup();
  });
});

describe('post-grade marker overlay routing', () => {
  function rendererFixture() {
    const target = new THREE.WebGLRenderTarget(1, 1); let current: THREE.WebGLRenderTarget | null = target;
    const renderer = { autoClear: true, getRenderTarget: () => current, setRenderTarget: vi.fn(t => { current = t; }), render: vi.fn() } as unknown as THREE.WebGLRenderer;
    return { target, renderer };
  }
  it('renders the actual overlay after PostFx without clearing or regrading the map', () => {
    const { target, renderer } = rendererFixture(); const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(); const order: string[] = [];
    vi.mocked(renderer.render).mockImplementation(() => { expect(renderer.autoClear).toBe(false); expect(renderer.getRenderTarget()).toBe(null); order.push('marks'); });
    const state = { ctx: { time: 0, shared: { commandOverlay: scene } }, camera, renderer, modules: [], needsWarm: false, warmUntil: 0,
      updateFx() {}, post: { render() { order.push('post'); } } };
    GameRenderer.prototype.render.call(state as unknown as GameRenderer, 1 / 60);
    expect(order).toEqual(['post', 'marks']); expect(renderer.autoClear).toBe(true); expect(renderer.getRenderTarget()).toBe(target); target.dispose();
  });
  it('skips hidden overlays and restores renderer state even on a failed draw', () => {
    const { target, renderer } = rendererFixture(); const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera();
    scene.visible = false; renderCommandOverlay(renderer, camera, scene); expect(renderer.render).not.toHaveBeenCalled();
    scene.visible = true; vi.mocked(renderer.render).mockImplementation(() => { throw new Error('context lost'); });
    expect(() => renderCommandOverlay(renderer, camera, scene)).toThrow('context lost'); expect(renderer.autoClear).toBe(true); expect(renderer.getRenderTarget()).toBe(target); target.dispose();
  });
});

it('mobile hides targeting markers in Units and restores Build markers without post-process warp', () => {
  vi.stubGlobal('document', { documentElement: { dataset: { deviceLayout: 'mobile' } } });
  const f = fixture();
  f.mark([f.n]); f.session.mobileMode = 'units'; f.update();
  expect(f.layer.scene.visible).toBe(false);
  expect(f.mesh.geometry.instanceCount).toBe(0);
  f.session.mobileMode = 'build'; f.fx.acid = 1; f.fx.instability = 1; f.update();
  expect(f.layer.scene.visible).toBe(true);
  expect(f.mesh.geometry.instanceCount).toBe(1);
  expect(f.mesh.material.uniforms.uMarkWarp.value.toArray()).toEqual([0, 0]);
  f.session.mobileMode = 'units'; f.update();
  expect(f.layer.scene.visible).toBe(false);
  f.cleanup();
});
