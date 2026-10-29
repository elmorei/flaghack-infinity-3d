import type { World } from '../sim/world';
import type { Session } from './session';

/** A live table is a modal input boundary, never a paused simulation. */
export function frickFrackInputLocked(world: World | null, session: Session): boolean {
  if (!world || session.spectator || session.screen !== 'playing' || world.phase !== 'playing') return false;
  const faction = world.factions[session.playerFaction];
  const avatar = world.avatarOf(session.playerFaction);
  return !!faction?.alive && faction.controlMode !== 'rts' && !!avatar && avatar.koUntil <= world.time
    && !!world.frickFrack?.sessions[session.playerFaction];
}
