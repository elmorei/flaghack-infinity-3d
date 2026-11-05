import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { groundHeight } from '../../sim/terrain';
import { LIFT } from './glsl';
import { nodeMarkerPosition } from './nodeMarkerPosition';

describe('shared displayed node center', () => {
  it('matches the marker shader lift and the current tween coordinates on terrain', () => {
    const data = {dispX: new Float32Array([12, 20]), dispZ: new Float32Array([-5, 9])};
    const out = new THREE.Vector3();
    expect(nodeMarkerPosition(data, 220, 0, out)).toBe(true);
    expect(out.toArray()).toEqual([12, groundHeight(12, -5, 220) + LIFT.marker, -5]);
    data.dispX[0] = 14.25; data.dispZ[0] = -2.5;
    expect(nodeMarkerPosition(data, 220, 0, out)).toBe(true);
    expect(out.toArray()).toEqual([14.25, groundHeight(14.25, -2.5, 220) + LIFT.marker, -2.5]);
  });
  it.each([-1, 1, 0.5, NaN])('rejects unavailable node %s without modifying the output', node => {
    const out = new THREE.Vector3(1, 2, 3);
    expect(nodeMarkerPosition({dispX: new Float32Array(1), dispZ: new Float32Array(1)}, 220, node, out)).toBe(false);
    expect(out.toArray()).toEqual([1, 2, 3]);
  });
});
