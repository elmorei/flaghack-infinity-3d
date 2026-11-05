import type { Camera } from 'three';

/** Screen-plane roll of the model's pole axis. Never tilts a billboard out of its plane. */
export function flagSpriteRotation(matrix: ArrayLike<number>, camera: Camera): number {
  const view = camera.matrixWorldInverse.elements;
  const x = view[0] * matrix[4] + view[4] * matrix[5] + view[8] * matrix[6];
  const y = view[1] * matrix[4] + view[5] * matrix[5] + view[9] * matrix[6];
  return x * x + y * y > 1e-10 ? Math.atan2(-x, y) : 0;
}
