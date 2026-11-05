/** Small touch-avatar controller: tap the selected avatar's destination, no hidden auto-combat. */
import type { AvatarInput } from '../sim/types';
import type { V2 } from '../sim/math';
export function mobileAvatarMotion(position: V2, target: V2 | null, out: AvatarInput): boolean {
  if (!target) return false;
  const dx=target.x-position.x, dz=target.z-position.z, distance=Math.hypot(dx,dz);
  if (!Number.isFinite(distance) || distance < .35) return false;
  out.moveX=dx/distance; out.moveZ=dz/distance;
  out.yaw=Math.atan2(dx,dz); out.pitch=0;
  return true;
}
