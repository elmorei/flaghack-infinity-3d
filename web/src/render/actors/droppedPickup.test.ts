import {describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import {PICKUP_BLINK_HZ, pushDroppedPickup} from './droppedPickup';
import {ICON_GLOW, RING} from './overlays';

describe('shared dropped-beacon/card cues', () => {
  it('uses the same pulse radius, ground lift, blink cadence and sprite batch for every pickup', () => {
    const rings = {push: vi.fn()}, icons = {push: vi.fn()}, color = new THREE.Color(0xe8c364);
    pushDroppedPickup(rings as any, icons as any, 2, 8, 3, color, 0, 0);
    expect(rings.push).toHaveBeenLastCalledWith(2, 8.02, 3, 1.1, color, .7, RING.pulse, 0);
    expect(icons.push).toHaveBeenLastCalledWith(2, 8.12, 3, .2, ICON_GLOW, .8, 0, color, 1);
    pushDroppedPickup(rings as any, icons as any, 2, 8, 3, color, 0, .75 / PICKUP_BLINK_HZ);
    expect(icons.push).toHaveBeenLastCalledWith(2, 8.12, 3, .2, ICON_GLOW, .08, 0, color, 1);
  });
});
