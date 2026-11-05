/** Public inventory view; spending and settlement remain host-owned. */
import type { FactionId } from './types';
import type { World } from './world';
import { getDepot } from './systems/sceneryDepots';

export function frickFrackFlags(w: World, f: FactionId): number[] {
  if (w.factions[f]?.controlMode !== 'rts') return [...(w.avatarOf(f)?.carried ?? [])];
  const ids: number[] = [];
  for (const flag of w.flags.values()) {
    if (flag.state !== 'stock' || flag.owner !== f) continue;
    const holder = w.buildings.get(flag.holder) ?? getDepot(w, flag.holder);
    if (holder?.faction === f && holder.built >= 1 && ['hearth', 'workshop', 'car'].includes(holder.kind)) ids.push(flag.id);
  }
  return ids.sort((a, b) => a - b);
}
