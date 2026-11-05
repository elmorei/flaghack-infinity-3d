/** One physical Flag bearer per group order. Never allocate one fetch per selected unit. */
import type { FactionId, Hippie } from '../types';
import type { V2 } from '../math';
import type { World } from '../world';
import { HIPPIE_AI } from '../constants';
import { getDepot } from './sceneryDepots';

export function flagOrderBearer(world: World, faction: FactionId, selected: readonly Hippie[], at: V2, allowLoose: boolean): Hippie | null {
  const awake = selected.filter(h => h.hp > 0 && h.koUntil === 0 && !h.wizard);
  const distance = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.z - b.z);
  const carried = awake.filter(h => {
    const fl = world.flags.get(h.carryingFlag);
    return fl?.state === 'carried' && fl.holder === h.id;
  });
  if (carried.length) return carried.sort((a, b) => distance(a.pos, at) - distance(b.pos, at) || a.id - b.id)[0];
  const sources: { at: V2; loose: boolean }[] = [];
  for (const fl of world.flags.values()) {
    if (fl.state === 'stock' && fl.owner === faction) {
      const b = world.buildings.get(fl.holder) ?? getDepot(world, fl.holder);
      if (b && b.faction === faction && b.built >= 1 && ['hearth', 'workshop', 'car'].includes(b.kind)) sources.push({ at: b.pos, loose: false });
    } else if (allowLoose && fl.state === 'loose' && (fl.owner === faction || fl.owner === -1) && fl.pos.y - world.collision.groundHeight(fl.pos.x, fl.pos.z) <= 1) sources.push({ at: fl.pos, loose: true });
  }
  if (!sources.length) return null;
  const cost = (h: Hippie) => Math.min(...sources.map(p => p.loose && distance(h.pos, p.at) >= HIPPIE_AI.fetchRadius ? Infinity : distance(h.pos, p.at) + distance(p.at, at))) + (h.carryingLumber > 0 ? 100 : 0);
  return awake.filter(h => Number.isFinite(cost(h))).sort((a, b) => cost(a) - cost(b) || a.id - b.id)[0] ?? null;
}
