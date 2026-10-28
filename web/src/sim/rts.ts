/** Command-only faction state. The ruler is presentation, not a targetable avatar. */
import type { FactionId } from './types';
import type { World } from './world';

export function rtsThroneAltar(world: World, faction: FactionId) {
  const fac = world.factions[faction];
  if (!fac?.alive || fac.controlMode !== 'rts') return undefined;
  const altar = world.hearthOf(faction);
  return altar && altar.kind === 'hearth' && altar.faction === faction && altar.hp > 0 && altar.built >= 1 && !altar.disabled ? altar : undefined;
}
