import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Session } from '../../game/session';
import { createSurveyUniforms } from './glsl';
import { LeyLayer, leyOpacity } from './leyLayer';
import type { SurveyData } from './surveyData';

describe('ley line mode opacity', () => {
  it('keeps mobile Plan at full strength and Degen visible at half strength', () => {
    const session = new Session();
    session.view = 'command';
    session.viewBlend = 1;
    session.mobileMode = 'units';
    expect(leyOpacity(session, true)).toBe(0.5);
    // Mobile mode, not a lingering desktop tool or the shared command camera, is decisive.
    session.planTool = 'node';
    session.tool = 'building';
    expect(leyOpacity(session, true)).toBe(0.5);
    session.mobileMode = 'build';
    expect(leyOpacity(session, true)).toBe(1);
    session.planTool = 'select';
    session.tool = 'flag';
    expect(leyOpacity(session, true)).toBe(1);
  });

  it.each(['node', 'enclose', 'pentacle', 'ring'] as const)('preserves desktop %s planning appearance', planTool => {
    const session = new Session();
    session.view = 'command';
    session.planTool = planTool;
    expect(leyOpacity(session, false)).toBe(1);
    session.planTool = 'select';
    expect(leyOpacity(session, false)).toBe(0.5);
  });

  it('preserves desktop building placement and dims action mode regardless of stale tools', () => {
    const session = new Session();
    session.view = 'command';
    session.tool = 'building';
    expect(leyOpacity(session, false)).toBe(1);
    session.view = 'action';
    session.planTool = 'node';
    session.mobileMode = 'build';
    expect(leyOpacity(session, false)).toBe(0.5);
    expect(leyOpacity(session, true)).toBe(0.5);
  });

  it('updates the production uniform through repeated mode changes without hiding or rebuilding lines', () => {
    const scene = new THREE.Scene();
    const texture = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    const uniforms = createSurveyUniforms({ node: texture, aux: texture, edge: texture, facet: texture });
    const data = { edgeCount: 1, topology: 0, lat: { edges: [{ a: 0, b: 1 }] } } as unknown as SurveyData;
    const layer = new LeyLayer(scene, data, uniforms);
    const mesh = scene.children[0] as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
    const session = new Session();
    session.view = 'command';
    try {
      layer.update(session, true);
      const endpoints = mesh.geometry.getAttribute('iEnds');
      const version = (endpoints as THREE.InstancedBufferAttribute).version;
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const mode of ['build', 'units'] as const) {
          session.mobileMode = mode;
          layer.update(session, true);
          expect(mesh.material.uniforms.uLeyOpacity.value).toBe(mode === 'build' ? 1 : 0.5);
          expect(mesh.visible).toBe(true);
          expect(mesh.geometry.instanceCount).toBe(1);
          expect((endpoints as THREE.InstancedBufferAttribute).version).toBe(version);
        }
      }
      expect(mesh.material.transparent).toBe(true);
      expect(mesh.material.depthWrite).toBe(false);
      expect(mesh.material.blendSrc).toBe(THREE.OneFactor);
      expect(mesh.material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
      const shader = mesh.material.fragmentShader;
      expect(shader).toContain('uniform float uLeyOpacity;');
      // One common post-output multiplier covers both variants, including additive alpha=0.
      expect(shader.indexOf('gl_FragColor *= uLeyOpacity;')).toBeGreaterThan(shader.indexOf('#include <colorspace_fragment>'));
      expect(shader.match(/gl_FragColor \*= uLeyOpacity;/g)).toHaveLength(1);
      expect(shader).toContain('gl_FragColor = vec4(c, 0.0);');
      expect(shader).toContain('gl_FragColor = vec4(c * a, a * 0.25);');
    } finally {
      layer.dispose();
      texture.dispose();
    }
  });
});
