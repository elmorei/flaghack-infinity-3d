/** Independent command-center movement for command-only camps. The host owns the order. */
import type { CommandOf } from '../commands';
import { BUILDINGS, GCC, MAP_HALF } from '../constants';
import type { World } from '../world';
import { isCollapsed } from './buildings';
import { moveCart } from './units/cart';

export function cmdMoveGcc(world: World, c: CommandOf<'moveGcc'>): void {
  const faction = world.factions[c.faction], g = world.gccOf(c.faction);
  if (!faction?.alive || world.gccOf(faction.id) !== g || faction.controlMode !== 'rts' || !g?.gcc || g.disabled || isCollapsed(g)) return;
  if (c.to === null) { g.gcc.moveTarget = null; return; }
  const limit = MAP_HALF - BUILDINGS.gcc.radius;
  if (!Number.isFinite(c.to.x) || !Number.isFinite(c.to.z) || Math.abs(c.to.x) > limit || Math.abs(c.to.z) > limit) return;
  g.gcc.moveTarget = { ...c.to };
  g.gcc.pushedBy = -1;
  for (const av of world.avatars.values()) if (av.pushing === g.id) av.pushing = -1;
}

export function updateGccMovement(world: World, dt: number): void {
  for (const g of world.buildings.values()) {
    const target = g.gcc?.moveTarget;
    if (!target) continue;
    const faction = g.faction >= 0 ? world.factions[g.faction] : null;
    if (!faction?.alive || world.gccOf(faction.id) !== g || faction.controlMode !== 'rts' || g.disabled || isCollapsed(g)) { g.gcc!.moveTarget = null; continue; }
    const dx = target.x - g.pos.x, dz = target.z - g.pos.z, distance = Math.hypot(dx, dz);
    if (distance < .1) { g.gcc!.moveTarget = null; continue; }
    // Bounded substeps prevent a long frame from tunnelling through narrow obstacles.
    let remaining = Math.min(distance, GCC.pushSpeed * Math.max(0, dt));
    let blocked = false;
    while (remaining > 0) {
      const step = Math.min(.15, remaining), fraction = step / distance;
      if (!moveCart(world, g, g.pos.x + dx * fraction, g.pos.z + dz * fraction, Math.atan2(dx, dz), step / GCC.pushSpeed)) { blocked = true; break; }
      remaining -= step;
    }
    if (blocked || Math.hypot(target.x - g.pos.x, target.z - g.pos.z) < .1) g.gcc!.moveTarget = null;
  }
}
