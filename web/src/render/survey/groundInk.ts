import * as THREE from 'three';

/**
 * The grid is ink on the ground, not a light in front of an actor. Keep its normal
 * blending and depth tests, but submit it in the opaque pass before cutout sprites.
 * It never writes depth, so later sprites and genuine foreground effects remain visible.
 */
export function drawGroundInkBeforeSprites(material: THREE.Material): void {
  if (material.blending === THREE.NormalBlending) {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  }
  material.transparent = false;
  material.depthWrite = false;
  material.needsUpdate = true;
}
