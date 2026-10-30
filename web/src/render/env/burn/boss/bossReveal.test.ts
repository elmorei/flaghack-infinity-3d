import * as fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { BOSS_GAMEPLAY_SCALE } from '../../../../sim/bossDimensions';
import { normalizeMatch } from '../../../../sim/matchSettings';
import { BOSS_HEIGHT, BOSS_SCALE, disposeBossModel, prepareBossModel } from './bossModel';
import { prepareBossRearDrapeSeam } from './rearFlapPose';
import { BOSS_ERUPTION_LIGHT_INTENSITY } from './bossReveal';
import { bossCharge, bossEmergence, bossFlash } from './revealTimeline';
import { Effigy } from '../effigy';
import { createDayState } from '../../timeOfDay';
import type { EnvContext } from '../../envTypes';

async function sourceModel() {
  const bytes = fs.readFileSync(new URL('../../../../../public/models/boss/skeletal-boss.glb', import.meta.url));
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
}
function env(bossMode = true, tutorial = false): EnvContext {
  return {
    ctx: {
      world: { options: { mode: tutorial ? 'tutorial' : 'standard', match: normalizeMatch({ bossMode }) }, time: 500, effigyRevealedAt: null,
        map: { half: 150, seed: 'boss-reveal-test', effigy: { x: 0, z: 0 } } }, quality: 'low', time: 0, session: { viewBlend: 0, screen: 'playing' }, camera: new THREE.PerspectiveCamera(60),
      renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280, 720) },
    } as unknown as EnvContext['ctx'],
    root: new THREE.Group(), day: createDayState(), burn: { active: true, startedAt: 500, elapsed: 0, progress: 0 },
    uniforms: { uTime: { value: 0 }, uNight: { value: 1 }, uBeat: { value: 0 }, uWind: { value: new THREE.Vector2(.5, .1) },
      uBurn: { value: 0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(.2, .2, .2) }, uFogColor: { value: new THREE.Color() } },
    noise: new THREE.DataTexture(new Uint8Array([127,127,127,255]), 1, 1), fireLight: new THREE.PointLight(),
  };
}
function at(environment: EnvContext, effect: Effigy, t: number, reveal: number | null = t >= 90 ? 590 : null): void {
  environment.burn.elapsed = t;
  environment.ctx.world.time = 500 + t;
  environment.ctx.world.effigyRevealedAt = reveal;
  effect.update(0);
  environment.root.updateMatrixWorld(true);
}
function geometrySignature(root: THREE.Object3D) {
  let triangles = 0, vertices = 0, pSum = 0, nSum = 0, wSum = 0, jSum = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry;
    triangles += (g.index?.count ?? g.getAttribute('position').count) / 3;
    vertices += g.getAttribute('position').count;
    for (const [name, set] of [['position', 0], ['normal', 1], ['skinWeight', 2], ['skinIndex', 3]] as const) {
      const a = g.getAttribute(name);
      let sum = 0;
      for (let i = 0; i < a.array.length; i++) sum += a.array[i];
      if (set === 0) pSum += sum; else if (set === 1) nSum += sum; else if (set === 2) wSum += sum; else jSum += sum;
    }
  });
  return { triangles, vertices, pSum, nSum, wSum, jSum };
}

describe('actual skeletal boss asset', () => {
  it('retains all 401386 triangles, every weighted vertex and all 109 bones while reducing 594 draws to 31', async () => {
    const original = await sourceModel();
    // The explicit no-skull-peek repair is a bounded rear-cloth-only exception.
    prepareBossRearDrapeSeam(original);
    const before = geometrySignature(original);
    const root = prepareBossModel(original);
    const after = geometrySignature(root);
    expect(after.triangles).toBe(401386);
    expect(after.vertices).toBe(before.vertices);
    expect(after.triangles).toBe(before.triangles);
    for (const key of ['pSum', 'nSum', 'wSum', 'jSum'] as const) expect(after[key]).toBeCloseTo(before[key], 5);
    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse((o) => { if (o instanceof THREE.SkinnedMesh) meshes.push(o); });
    expect(meshes).toHaveLength(31);
    expect(root.userData.originalDraws).toBe(594);
    expect(new Set(meshes.map((m) => m.skeleton)).size).toBe(1);
    expect(meshes[0].skeleton.bones).toHaveLength(109);
    expect(BOSS_SCALE).toBe(1);
    expect(root.scale.toArray()).toEqual([1, 1, 1]);
    const bounds = new THREE.Box3().setFromObject(root, true);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(BOSS_HEIGHT, 5);
    expect(bounds.min.y).toBeCloseTo(0, 5);
    disposeBossModel(root);
  });
});

describe('boss reveal presentation', () => {
  it('finishes the white-phase rise exactly at90 and keeps the explosion flash brief', () => {
    expect(bossCharge(85)).toBe(0); expect(bossCharge(89)).toBeGreaterThan(.8); expect(bossCharge(90)).toBe(1);
    expect(bossFlash(-1)).toBe(0); expect(bossFlash(0)).toBe(1); expect(bossFlash(.28)).toBe(0);
    expect(bossEmergence(85)).toBe(0); expect(bossEmergence(87.5)).toBe(.5); expect(bossEmergence(90)).toBe(1);
  });
  it('requires authoritative state, clears old art, and reconstructs a late-joined standing rig and crater', async () => {
    const environment = env();
    const effect = new Effigy(environment, async () => prepareBossModel(await sourceModel()));
    await effect.ready;
    at(environment, effect, 91, null);
    expect(environment.root.getObjectByName('effigy')!.visible).toBe(true);
    expect(environment.root.getObjectByName('boss-model-32m')!.visible).toBe(true);
    expect(environment.root.getObjectByName('boss-model-32m')!.position.y).toBe(2);
    expect(environment.ctx.world.effigyRevealedAt).toBeNull();
    at(environment, effect, 90);
    expect(environment.root.getObjectByName('effigy')!.visible).toBe(false);
    expect(environment.root.getObjectByName('boss-reveal-fx')!.visible).toBe(true);
    expect(environment.root.getObjectByName('boss-white-burst')!.visible).toBe(true);
    at(environment, effect, 94);
    const model = environment.root.getObjectByName('boss-model-32m')!;
    expect(model.position.y).toBe(2);
    expect(model.scale.toArray()).toEqual([1, 1, 1]);
    expect(model.userData.height).toBe(32);
    expect(environment.root.getObjectByName('boss-reveal-fx')!.scale.toArray()).toEqual([BOSS_GAMEPLAY_SCALE, BOSS_GAMEPLAY_SCALE, BOSS_GAMEPLAY_SCALE]);
    at(environment, effect, 190);
    expect(model.visible).toBe(true);
    expect(environment.root.getObjectByName('boss-black-crater')!.visible).toBe(true);
    expect(environment.root.getObjectByName('boss-white-burst')!.visible).toBe(false);
    expect(environment.root.getObjectByName('boss-explosion-smoke')!.visible).toBe(false);
    expect(environment.root.getObjectByName('boss-charred-timber')!.visible).toBe(false);
    effect.dispose();
  });
  it('rises white from85–90, switches every original material back instantly, and never rises after the explosion', async () => {
    const environment = env();
    const materials: THREE.MeshStandardMaterial[] = [];
    let original: unknown;
    const values = () => materials.map((m) => ({ name: m.name, color: m.color.toArray(), emissive: m.emissive.toArray(),
      emissiveIntensity: m.emissiveIntensity, roughness: m.roughness, metalness: m.metalness, opacity: m.opacity }));
    const effect = new Effigy(environment, async () => {
      const root = prepareBossModel(await sourceModel());
      root.traverse((o) => { if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) materials.push(o.material); });
      original = values();
      return root;
    });
    await effect.ready;
    const shaders = materials.map((m) => {
      const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader,
        uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms) } as Parameters<THREE.Material['onBeforeCompile']>[0];
      m.onBeforeCompile(shader, {} as THREE.WebGLRenderer); return shader;
    });
    const model = environment.root.getObjectByName('boss-model-32m')!;
    at(environment, effect, 85);
    expect(model.visible).toBe(false); expect(model.position.y).toBe(2 - BOSS_HEIGHT);
    at(environment, effect, 87.5);
    expect(model.visible).toBe(true); expect(model.position.y).toBe(2 - BOSS_HEIGHT / 2);
    expect(shaders.every((s) => s.uniforms.uBossCharge.value === 1)).toBe(true);
    expect(environment.ctx.world.effigyRevealedAt).toBeNull();
    expect(values()).toEqual(original);
    at(environment, effect, 89.999);
    expect(model.position.y).toBeLessThan(2);
    expect(model.position.y).toBeGreaterThan(2 - .00001);
    expect(shaders.every((s) => s.uniforms.uBossCharge.value === 1)).toBe(true);
    at(environment, effect, 90);
    expect(model.position.y).toBe(2);
    expect(shaders.every((s) => s.uniforms.uBossCharge.value === 0)).toBe(true);
    expect(values()).toEqual(original);
    expect((environment.root.getObjectByName('boss-white-burst') as THREE.Mesh).material).toMatchObject({ side: THREE.BackSide });
    for (const t of [90.05, 90.3, 91, 94, 100, 190]) {
      at(environment, effect, t);
      expect(model.position.y).toBe(2);
      expect(shaders.every((s) => s.uniforms.uBossCharge.value === 0)).toBe(true);
      expect(values()).toEqual(original);
    }
    at(environment, effect, 90.3);
    expect(environment.root.getObjectByName('boss-white-burst')!.visible).toBe(true);
    at(environment, effect, 95);
    expect(environment.root.getObjectByName('boss-white-burst')!.visible).toBe(false);
    // Reverse/skip sampling also reconstructs the visual phase without mutating authority.
    at(environment, effect, 89.999);
    expect(shaders.every((s) => s.uniforms.uBossCharge.value === 1)).toBe(true);
    at(environment, effect, 91, null);
    expect(shaders.every((s) => s.uniforms.uBossCharge.value === 1)).toBe(true);
    expect(environment.ctx.world.effigyRevealedAt).toBeNull();
    at(environment, effect, 190);
    expect(model.position.y).toBe(2);
    expect(shaders.every((s) => s.uniforms.uBossCharge.value === 0)).toBe(true);
    effect.dispose();
  });
  it('reuses the fire light for a sustained white eruption and restores its state on recovery/reset/disposal', async () => {
    const environment = env(), light = environment.fireLight;
    light.distance = 140; light.decay = 1.4;
    const effect = new Effigy(environment, async () => new THREE.Group()); await effect.ready;
    const children = [...environment.root.children];
    at(environment, effect, 89.999); expect(light.intensity).toBeLessThan(BOSS_ERUPTION_LIGHT_INTENSITY);
    for (const t of [90, 90.1, 90.4, 90.2]) {
      at(environment, effect, t);
      expect(light.color.toArray()).toEqual([1, 1, 1]);
      expect(light.intensity).toBeGreaterThanOrEqual(BOSS_ERUPTION_LIGHT_INTENSITY);
      expect(light.distance).toBe(900); expect(light.decay).toBe(0);
      expect(environment.root.getObjectByName('boss-white-burst')!.visible).toBe(true);
      expect(environment.root.getObjectByName('boss-white-burst')!.scale.toArray()).toEqual([24.5, 20, 24.5]);
    }
    at(environment, effect, 90.7); expect(light.intensity).toBeCloseTo(BOSS_ERUPTION_LIGHT_INTENSITY * .5 + 24 * Math.exp(-.7 * .9));
    at(environment, effect, 91); expect(light.distance).toBe(140); expect(light.decay).toBe(1.4);
    expect(light.intensity).toBeCloseTo(24 * Math.exp(-.9));
    expect(environment.root.getObjectByName('boss-white-burst')!.visible).toBe(false);
    at(environment, effect, 90.2); environment.ctx.session.screen = 'title'; effect.update(0);
    expect(light.intensity).toBeLessThan(BOSS_ERUPTION_LIGHT_INTENSITY);
    environment.ctx.session.screen = 'playing'; at(environment, effect, 0, null);
    expect(light.distance).toBe(140); expect(light.decay).toBe(1.4);
    expect(environment.root.children).toEqual(children);
    at(environment, effect, 90); effect.dispose();
    expect(light.intensity).toBe(0); expect(light.distance).toBe(140); expect(light.decay).toBe(1.4);
  });
  it('preserves the off-mode plinth and never loads the boss in tutorial or off-mode', async () => {
    for (const [bossMode, tutorial] of [[false, false], [true, true]]) {
      const environment = env(bossMode, tutorial);
      let loads = 0;
      const effect = new Effigy(environment, async () => { loads++; return new THREE.Group(); });
      await effect.ready; at(environment, effect, 190, null);
      expect(loads).toBe(0);
      expect(environment.root.getObjectByName('boss-reveal')).toBeUndefined();
      expect(environment.root.getObjectByName('effigy')!.visible).toBe(true);
      expect(environment.root.getObjectByName('effigy-solid')!.visible).toBe(true);
      effect.dispose();
    }
  });
  it('disposes a slow-loading rig after the scene was replaced without attaching it', async () => {
    let resolve!: (model: THREE.Group) => void;
    const environment = env();
    const effect = new Effigy(environment, () => new Promise((r) => { resolve = r; }));
    effect.dispose();
    const model = new THREE.Group(); resolve(model); await effect.ready;
    expect(model.parent).toBeNull();
    expect(environment.root.children).toHaveLength(0);
  });
});
