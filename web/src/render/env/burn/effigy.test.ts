import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { EnvContext } from '../envTypes';
import { createDayState } from '../timeOfDay';
import {
  CHAR_SECONDS, DISSOLVE_BOTTOM_AT, DISSOLVE_TOP_AT, FIRE_TOP, FLAG_BLACK_AT, FLAG_BOTTOM, FLAG_CONSUMED_AT,
  FLAG_HEIGHT, GUY_GRAVITY, GUY_HEIGHT, GUY_LANDED_AT, FLAG_RED_AT, FLAG_WHITE_AT, FLAG_WIDTH, FLAG_YELLOW_AT, GUY_BURN_END, GUY_BURN_START,
  LAST_SCAFFOLD_BURN_AT, DISSOLVE_MAX_DELAY, PLINTH_HEIGHT, burningScaffoldEnvelope, fireFront, fireIntensity, flagBurnBottom,
  flagBurnScale, flagIncandescence, guyLineBurn, guyLineFall, guyLineHeight, guyLineRestHeight, sampleFlagHeat,
} from './burnTimeline';
import { Effigy } from './effigy';

function environment(tutorial = false): EnvContext {
  const day = createDayState();
  return {
    ctx: {
      world: { options: { mode: tutorial ? 'tutorial' : 'skirmish', match: { bossMode: false } }, map: { half: 150, seed: 'effigy-test', effigy: { x: 0, z: 0 } } },
      quality: 'low', time: 0, session: { viewBlend: 0 }, camera: new THREE.PerspectiveCamera(60),
      renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280, 720) },
    } as unknown as EnvContext['ctx'],
    root: new THREE.Group(), day,
    burn: { active: false, startedAt: Infinity, elapsed: 0, progress: 0 },
    uniforms: {
      uTime: { value: 0 }, uNight: { value: 1 }, uBeat: { value: 0 }, uWind: { value: new THREE.Vector2(0.5, 0.1) },
      uBurn: { value: 0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(0.2, 0.2, 0.2) },
      uFogColor: { value: new THREE.Color(0, 0, 0) },
    },
    noise: new THREE.DataTexture(new Uint8Array([127, 127, 127, 255]), 1, 1),
    fireLight: new THREE.PointLight(),
  };
}

function shaderOf(material: THREE.Material) {
  const source = material instanceof THREE.MeshDepthMaterial ? THREE.ShaderLib.depth : THREE.ShaderLib.standard;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(source.uniforms), vertexShader: source.vertexShader, fragmentShader: source.fragmentShader,
  } as Parameters<THREE.Material['onBeforeCompile']>[0];
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('original scaffold with exposed shrinking Flag and pole', () => {
  it('preserves the original climb, char, dissolve and lasting fire curves', () => {
    expect(fireFront(12.5)).toBe(FIRE_TOP);
    expect(CHAR_SECONDS).toBe(55);
    expect(DISSOLVE_TOP_AT).toBe(85);
    expect(DISSOLVE_BOTTOM_AT).toBe(140);
    expect(fireIntensity(60)).toBe(1);
    expect(fireIntensity(200)).toBeCloseTo(0.38);
    expect(flagIncandescence(89)).toBeGreaterThan(0);
  });

  it('releases guy wires at 20, free-falls under game gravity, then burns grounded remnants by 30', () => {
    expect(GUY_BURN_START).toBe(20);
    expect(GUY_BURN_END).toBe(30);
    expect(guyLineBurn(19.999)).toBe(0);
    expect(guyLineBurn(20)).toBe(0);
    expect(GUY_GRAVITY).toBe(24);
    expect(guyLineFall(20)).toBe(0);
    expect(guyLineFall(20.5)).toBe(3);
    expect(guyLineFall(21)).toBe(12);
    expect(guyLineFall(21)).toBe(4 * guyLineFall(20.5));
    expect(GUY_LANDED_AT - 20).toBeCloseTo(Math.sqrt(2 * GUY_HEIGHT / GUY_GRAVITY));
    expect(guyLineBurn(GUY_LANDED_AT)).toBe(0);
    expect(guyLineBurn((GUY_LANDED_AT + 30) / 2)).toBeCloseTo(0.5);
    expect(guyLineHeight(18.4, 20.5)).toBeCloseTo(15.4);
    expect(guyLineHeight(18.4, 22)).toBeCloseTo(0.03);
    expect(guyLineHeight(18.4, 22, 0.6, 0)).toBeCloseTo(3.03);
    for (let t = 20; t <= 30; t += 0.1) for (const x of [0.6, 5, 14])
      expect(guyLineHeight(18.4, t, x, 0)).toBeGreaterThanOrEqual(guyLineRestHeight(x, 0));
    expect(guyLineBurn(30)).toBe(1);
    expect(guyLineBurn(200)).toBe(1);
  });

  it('starts the Flag colour sequence at 90, then cools white → yellow → red → black', () => {
    expect(sampleFlagHeat(89.999).active).toBe(false);
    for (const [t, color, emissive] of [
      [FLAG_WHITE_AT, [1, 1, 1], 4], [FLAG_YELLOW_AT, [1, 1, 0], 3],
      [FLAG_RED_AT, [1, 0, 0], 1], [FLAG_BLACK_AT, [0, 0, 0], 0],
    ] as const) expect(sampleFlagHeat(t)).toEqual({ active: true, color, emissive });
    let previous = sampleFlagHeat(90);
    for (let t = 90.1; t < 200; t += 0.1) {
      const current = sampleFlagHeat(t);
      current.color.forEach((c, i) => expect(c).toBeLessThanOrEqual(previous.color[i] + 1e-12));
      expect(current.emissive).toBeLessThanOrEqual(previous.emissive + 1e-12);
      previous = current;
    }
  });

  it('starts uniform shrink at 90 and keeps the cloth above the original noisy burning scaffold', () => {
    expect(DISSOLVE_MAX_DELAY).toBe(28);
    expect(LAST_SCAFFOLD_BURN_AT).toBe(168);
    expect(FLAG_CONSUMED_AT).toBe(176);
    expect(flagBurnScale(90)).toBe(1);
    expect(flagBurnScale(91)).toBeLessThan(1);
    expect(flagBurnScale(176)).toBe(0);
    let previous = 1;
    for (let t = 0; t <= 200; t += 0.25) {
      const scale = flagBurnScale(t);
      expect(scale).toBeGreaterThanOrEqual(0);
      expect(scale).toBeLessThanOrEqual(previous + 1e-12);
      if (t >= 90 && t < 168) expect(flagBurnBottom(t)).toBeGreaterThan(burningScaffoldEnvelope(t));
      previous = scale;
    }
    for (let y = 3; y <= 19.6; y += 0.1) {
      const last = DISSOLVE_BOTTOM_AT + DISSOLVE_MAX_DELAY
        - (DISSOLVE_BOTTOM_AT - DISSOLVE_TOP_AT) * Math.min(1, (y - 3) / 15.6);
      expect(burningScaffoldEnvelope(last - 1e-6)).toBeGreaterThanOrEqual(y - 1e-5);
    }
  });

  it('shares pole/cloth heat and one attachment pivot without changing the original scaffold', () => {
    const env = environment();
    const effigy = new Effigy(env);
    const mesh = (name: string) => env.root.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    const flag = mesh('the-flag');
    const assembly = env.root.getObjectByName('effigy-flag-assembly')!;
    const mast = mesh('effigy-mast');
    const finial = mesh('effigy-finial');
    const crown = mesh('effigy-lattice').geometry.boundingBox!.max.y;
    const flagShader = shaderOf(flag.material);
    for (const pole of [mast, finial]) {
      const shader = shaderOf(pole.material);
      for (const key of ['uFlagHeatActive', 'uFlagHeatColor', 'uFlagHeatEmissive'])
        expect(shader.uniforms[key]).toBe(flagShader.uniforms[key]);
      expect(shader.fragmentShader).toContain('totalEmissiveRadiance = uFlagHeatColor * uFlagHeatEmissive;');
      expect(pole.parent).toBe(assembly);
    }
    expect(flag.parent).toBe(assembly);
    const guy = mesh('effigy-guylines');
    const guyShader = shaderOf(guy.material);
    const guyDepth = shaderOf(guy.customDepthMaterial!);
    expect(guyShader.uniforms.uGuyBurn).toBe(guyDepth.uniforms.uGuyBurn);
    expect(guyShader.uniforms.uGuyFall).toBe(guyDepth.uniforms.uGuyFall);
    for (const shader of [guyShader, guyDepth])
      expect(shader.vertexShader).toContain('transformed.y = max(floorY, transformed.y - uGuyFall);');
    expect(guyShader.fragmentShader).toContain('if (uGuyBurn > guyBurnFront()) discard;');
    expect(guyDepth.fragmentShader).toContain('if (uGuyBurn > guyBurnFront()) discard;');
    const lattice = shaderOf(mesh('effigy-lattice').material);
    expect(lattice.uniforms.uFlagHeatColor).toBeUndefined();
    const flagVertexCount = flag.geometry.attributes.position.count;
    // Deliberately out of order: late joins, time jumps and resets sample pure sim time.
    for (const t of [0, 20, 20.5, 21, 21.24, 25, 30, 89, 90, 100, 116, 142, 168, 175.9, 176, 200, 20.5, 90]) {
      env.burn.active = true;
      env.burn.elapsed = t;
      effigy.update(1 / 60);
      env.root.updateMatrixWorld(true);
      const heat = sampleFlagHeat(t);
      expect(flagShader.uniforms.uFlagHeatActive.value).toBe(heat.active ? 1 : 0);
      expect(flagShader.uniforms.uFlagHeatColor.value.toArray()).toEqual(heat.color);
      expect(flagShader.uniforms.uFlagHeatEmissive.value).toBe(heat.emissive);
      expect(flagShader.uniforms.uIncandescence.value).toBe(flagIncandescence(t));
      expect(assembly.scale.toArray()).toEqual(Array(3).fill(flagBurnScale(t, crown)));
      expect(assembly.visible).toBe(t < FLAG_CONSUMED_AT);
      expect(assembly.position.toArray()).toEqual([0, PLINTH_HEIGHT, 0]);
      expect(flag.scale.toArray()).toEqual([1, 1, 1]);
      expect(flag.position.toArray()).toEqual([0, FLAG_BOTTOM - PLINTH_HEIGHT, 0]);
      expect(flag.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(2 + flagBurnBottom(t, crown));
      for (const pole of [mast, finial]) {
        expect(pole.scale.toArray()).toEqual([1, 1, 1]);
        expect(pole.position.toArray()).toEqual([0, -PLINTH_HEIGHT, 0]);
        expect([0, 5, 10].map(i => pole.matrixWorld.elements[i])).toEqual(assembly.scale.toArray());
      }
      expect(flag.geometry.attributes.position.count).toBe(flagVertexCount);
      expect(guyShader.uniforms.uGuyBurn.value).toBe(guyLineBurn(t));
      expect(guyShader.uniforms.uGuyFall.value).toBe(guyLineFall(t));
      expect(guy.visible).toBe(t < 30);
      for (const name of ['effigy-lattice', 'effigy-solid', 'effigy-offerings']) {
        expect(mesh(name).scale.toArray()).toEqual([1, 1, 1]);
        expect(mesh(name).position.toArray()).toEqual([0, 0, 0]);
        expect(mesh(name).visible).toBe(true);
      }

    }
    expect(env.root.getObjectByName('effigy-crater')).toBeUndefined();
    effigy.dispose();
    expect(env.root.children).toHaveLength(0);
  });

  it('leaves the tutorial pole and Flag on their original burn appearance', () => {
    const env = environment(true);
    env.burn.active = true;
    env.burn.elapsed = 200;
    const effigy = new Effigy(env);
    effigy.update(1 / 60);
    const assembly = env.root.getObjectByName('effigy-flag-assembly')!;
    expect(assembly.visible).toBe(true);
    expect(assembly.scale.toArray()).toEqual([1, 1, 1]);
    const shader = shaderOf((env.root.getObjectByName('the-flag') as THREE.Mesh).material as THREE.Material);
    expect(shader.uniforms.uFlagHeatActive.value).toBe(0);
    effigy.dispose();
  });

  it('first renders after consumption with Flag, pole and guys absent, but original plinth and fire intact', () => {
    const env = environment();
    env.burn.active = true;
    env.burn.elapsed = 200;
    const effigy = new Effigy(env);
    effigy.update(1 / 60);
    expect(env.root.getObjectByName('effigy-flag-assembly')!.visible).toBe(false);
    expect(env.root.getObjectByName('effigy-guylines')!.visible).toBe(false);
    expect(env.root.getObjectByName('effigy-solid')!.visible).toBe(true);
    expect(env.fireLight.intensity).toBeGreaterThan(0);
    effigy.dispose();
  });
});
