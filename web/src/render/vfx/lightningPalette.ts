/** Shared owner tint for crystal/ward protection and their persistent boss attacks. */
import * as THREE from 'three';
import { NEUTRAL_COLOR } from '../../sim/constants';
import type { Owner } from '../../sim/types';
import type { World } from '../../sim/world';

export interface LightningSource { kind: 'crystal' | 'ward'; id: number; faction: Owner; }
const WHITE = new THREE.Color(0xffffff);

/** Read the source, never the target or local player's faction. Re-read after captures. */
export function lightningSourceColor(world: World, source: LightningSource): number {
  const owner = (source.kind === 'crystal' ? world.crystals.get(source.id) : world.buildings.get(source.id))?.faction ?? source.faction;
  return world.factions[owner]?.color ?? NEUTRAL_COLOR;
}

/** Bright readable core, saturated owner halo. Ownerless storm discharges stay unchanged. */
export function setLightningPalette(core: THREE.Color, glow: THREE.Color, ownerColor?: number): void {
  if (ownerColor === undefined) {
    core.set(0xf4ecff).multiplyScalar(1.2);
    glow.set(0x7d6bff).multiplyScalar(2.2);
  } else {
    glow.set(ownerColor);
    core.copy(glow).lerp(WHITE, .28).multiplyScalar(1.2);
    glow.multiplyScalar(2.2);
  }
}
