import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LEVEL_HEIGHT } from '../../sim/constants';
import { createMatch } from '../../sim/setup';
import { rampPolygon, DECK_THICKNESS, CORNER_BRACE_DROP, CORNER_BRACE_HALF_Y } from '../../sim/systems/econ/pieceGeometry';
import { pieceModels, pieceSlotMatrix, rhombusFrame } from './pieces';
import { StructureKit } from './kit';

function kit() {
  return new StructureKit({ capabilities: { getMaxAnisotropy: () => 1 } } as unknown as THREE.WebGLRenderer, 'low');
}

describe('rectangular ramp render geometry', () => {
  it.each([0, 1, 2, 3])('includes corner knee braces in the shared live/ghost deck variant %i', variant => {
    const resources = kit();
    const geometry = pieceModels(resources, 8).decks[variant].get('woodPaint')!;
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBeCloseTo(-DECK_THICKNESS - CORNER_BRACE_DROP - CORNER_BRACE_HALF_Y, 5);
    expect(geometry.boundingBox!.max.y).toBeCloseTo(0, 5);
    resources.dispose();
  });

  it.each([0, 1, 2, 3])('keeps variant %i slats and stringers within the centered rectangular strip', variant => {
    const resources = kit(), L = 8;
    const model = pieceModels(resources, L).ramps[variant].get('woodPaint')!;
    const theta = (variant + 1) * Math.PI / 5;
    const dx = L * Math.cos(theta), h = L * Math.sin(theta);
    const x0 = Math.max(0, dx), x1 = Math.min(L, L + dx);
    const p = model.attributes.position;
    for (let i = 0; i < p.count; i++) {
      expect(p.getX(i)).toBeGreaterThanOrEqual(x0 - 1e-5);
      expect(p.getX(i)).toBeLessThanOrEqual(x1 + 1e-5);
    }
    // The first thirteen hexahedra are the slats: each has identical x boundaries
    // at its low and high ends, and still follows the exact rising surface.
    for (let board = 0; board < 13; board++) {
      const start = board * 36;
      const xs = [], zs = [];
      for (let i = start; i < start + 36; i++) {
        xs.push(p.getX(i)); zs.push(p.getZ(i));
        expect(p.getY(i) - LEVEL_HEIGHT * p.getZ(i) / h).toBeLessThan(1e-5);
        expect(p.getY(i) - LEVEL_HEIGHT * p.getZ(i) / h).toBeGreaterThan(-0.06001);
      }
      expect(Math.min(...xs)).toBeCloseTo(x0 + .04, 5);
      expect(Math.max(...xs)).toBeCloseTo(x1 - .04, 5);
      expect(Math.min(...zs)).toBeCloseTo(board * h / 13 + .035, 5);
      expect(Math.max(...zs)).toBeCloseTo((board + 1) * h / 13 - .035, 5);
    }
    resources.dispose();
  });

  it('uses the same unchanged piece frame for live and ghost models and the rectangular high posts', () => {
    const w = createMatch({ seed: 'rect-ramp-render', difficulty: 'normal', humans: [0], mode: 'standard' });
    const lat = w.lattice, xs: number[] = [], zs: number[] = [];
    const variants = new Set<number>();
    for (const facet of lat.facets) for (let edge = 0; edge < 4; edge++) {
      const frame = rhombusFrame(lat, facet.id, edge, { variant: 0, ax: 0, az: 0, ux: 1, uz: 0 });
      variants.add(frame.variant);
      const matrix = new THREE.Matrix4();
      expect(pieceSlotMatrix(lat, 'ramp', -1, facet.id, 0, edge, 1, matrix, w.map.half)).toBe(frame.variant);
      const theta = (frame.variant + 1) * Math.PI / 5;
      const dx = lat.edge * Math.cos(theta), h = lat.edge * Math.sin(theta);
      const x0 = Math.max(0, dx), x1 = Math.min(lat.edge, lat.edge + dx);
      rampPolygon(lat, facet.id, edge, xs, zs);
      for (const [index, x] of [[2, x1], [3, x0]]) {
        const corner = new THREE.Vector3(x, LEVEL_HEIGHT, h).applyMatrix4(matrix);
        expect(corner.x).toBeCloseTo(xs[index], 5);
        expect(corner.z).toBeCloseTo(zs[index], 5);
      }
    }
    expect(variants.size).toBe(4);
  });
});
