import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSurveyUniforms } from './glsl';
import { GroundLayer } from './groundLayer';

afterEach(() => vi.unstubAllGlobals());

function fixture(layout: 'mobile' | 'desktop') {
  vi.stubGlobal('document', { documentElement: { dataset: { deviceLayout: layout } } });
  const texture = new THREE.DataTexture();
  const uniforms = createSurveyUniforms({ node: texture, aux: texture, edge: texture, facet: texture });
  const scene = new THREE.Scene();
  const layer = new GroundLayer(scene, uniforms, 150);
  const mesh = scene.getObjectByName('command-ground-static') as THREE.Mesh;
  return { uniforms, scene, layer, mesh, dispose() { layer.dispose(); texture.dispose(); } };
}

describe('Command View decorative ground static', () => {
  it('stays hidden on mobile through every map-view blend and animation time', () => {
    const f = fixture('mobile');
    try {
      expect(f.mesh.visible).toBe(false);
      for (const blend of [0, 0.001, 0.003, 0.5, 1, 0.5, 0, 1]) {
        f.uniforms.uViewBlend.value = blend;
        f.uniforms.uTime.value += 0.37;
        f.layer.update();
        expect(f.mesh.visible).toBe(false);
      }
    } finally { f.dispose(); }
    expect(f.scene.children).toHaveLength(0);
  });

  it('preserves the desktop action/map visibility threshold in both directions', () => {
    const f = fixture('desktop');
    try {
      expect(f.mesh.visible).toBe(false);
      for (const blend of [0, 0.001, 0.002, 0.003, 0.5, 1, 0.5, 0.002, 0, 1]) {
        f.uniforms.uViewBlend.value = blend;
        f.layer.update();
        expect(f.mesh.visible).toBe(blend > 0.002);
      }
    } finally { f.dispose(); }
    expect(f.scene.children).toHaveLength(0);
  });
});
