import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera } from 'three';

const source = readFileSync(new URL('./leyLayer.ts', import.meta.url), 'utf8');
// Evaluate the production shader's scalar branch rather than a second implementation.
const expression = source.match(/float pixelDepth = ([^;]+);/)?.[1];
if (!expression) throw new Error('Missing projection-aware ley width');
const depth = new Function('projectionMatrix', 'dist', `return ${expression};`) as
  (matrix: number[][], distance: number) => number;
function measure(camera: OrthographicCamera | PerspectiveCamera, height: number, dpr: number, distance: number) {
  camera.updateProjectionMatrix();
  const e = camera.projectionMatrix.elements;
  const matrix = Array.from({ length: 4 }, (_, col) => e.slice(col * 4, col * 4 + 4));
  const scale = e[5] * 0.5 * height * dpr;
  const factor = depth(matrix, distance);
  const width = 2.5 * dpr * factor / scale;
  return { width, pixels: width * scale / factor / dpr, scale };
}
function ortho(width: number, height: number) {
  return new OrthographicCamera(-width * 0.035, width * 0.035, height * 0.035, -height * 0.035, 0.1, 1000);
}

describe('ley beam projection sizing', () => {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 800]]) {
    it(`keeps the pixel minimum stable at ${width}x${height} across DPR, zoom and distance`, () => {
      const camera = ortho(width, height);
      for (const zoom of [0.5, 1, 2]) for (const dpr of [1, 1.5, 2, 3]) for (const distance of [2, 16, 50, 300]) {
        camera.zoom = zoom;
        const result = measure(camera, height, dpr, distance);
        expect(result.pixels).toBeCloseTo(2.5, 10);
        expect(result.width).toBeCloseTo(0.175 / zoom, 10);
      }
    });
  }
  it('does not inflate orthographic width with camera altitude', () => {
    const camera = ortho(390, 844);
    expect(measure(camera, 844, 1.5, 300).width).toBeCloseTo(measure(camera, 844, 1.5, 2).width, 12);
  });
  it('preserves the exact perspective distance formula', () => {
    for (const fov of [50, 72, 90]) for (const zoom of [0.5, 1, 2]) for (const dpr of [1, 1.5, 2, 3]) for (const distance of [2, 16, 50, 300]) {
      const camera = new PerspectiveCamera(fov, 1280 / 800, 0.1, 1000);
      camera.zoom = zoom;
      const result = measure(camera, 800, dpr, distance);
      expect(result.width).toBe(2.5 * dpr * distance / result.scale);
    }
  });
  it('retains the artistic world-width floor and near fade', () => {
    expect(source).toContain('float w = max(0.3 * (1.0 + uViewBlend * 1.4) * mix(0.4, 1.0, vNear), 2.5 * uPx * pixelDepth / fhProjScale());');
    expect(source).toContain('vNear = smoothstep(2.0, 16.0, dist);');
  });
  it('leaves the independent ground glow unchanged', () => {
    expect(source).toContain('float w = 1.3 + uViewBlend * 1.5;');
  });
});
