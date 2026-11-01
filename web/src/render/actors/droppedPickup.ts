/** Shared ground-pickup cues: cards and D.E.G.E.N. radios use the same batched glow and pulse. */
import type * as THREE from 'three';
import { ICON_GLOW, RING, type StatusIcons, type UnitRings } from './overlays';

export const PICKUP_BLINK_HZ = 1.6;
export function pushDroppedPickup(
  rings: UnitRings, icons: StatusIcons, x: number, ground: number, z: number,
  color: THREE.Color, phase: number, time: number,
): void {
  const on = (time * PICKUP_BLINK_HZ + phase) % 1 < .5 ? .8 : .08;
  icons.push(x, ground + .12, z, .2, ICON_GLOW, on, 0, color, 1);
  rings.push(x, ground + .02, z, 1.1, color, .7, RING.pulse, phase);
}
