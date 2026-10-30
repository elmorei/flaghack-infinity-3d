import * as THREE from 'three';

/** Active world projection. Cinematics/action remain perspective; mobile field is parallel. */
export type WorldCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
export function isOrthographic(camera: WorldCamera): camera is THREE.OrthographicCamera {
  return (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
}
export function cameraAspect(camera: WorldCamera): number {
  return isOrthographic(camera) ? (camera.right - camera.left) / (camera.top - camera.bottom) : camera.aspect;
}
export function worldUnitsPerPixel(camera: WorldCamera, height: number, depth: number): number {
  return isOrthographic(camera) ? (camera.top - camera.bottom) / (camera.zoom * height)
    : 2 * depth / (camera.projectionMatrix.elements[5] * height);
}
/** No camera-position subtraction for orthographic views: every cursor ray is parallel. */
export function cameraPointerRay(camera: WorldCamera, nx: number, ny: number, out: THREE.Ray): THREE.Ray {
  if (isOrthographic(camera)) {
    out.origin.set(nx, ny, (camera.near + camera.far) / (camera.near - camera.far)).unproject(camera);
    out.direction.set(0, 0, -1).transformDirection(camera.matrixWorld);
  } else {
    out.origin.copy(camera.position);
    out.direction.set(nx, ny, .5).unproject(camera).sub(out.origin).normalize();
  }
  return out;
}
