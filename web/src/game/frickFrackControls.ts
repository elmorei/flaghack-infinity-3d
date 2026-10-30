import type { World } from '../sim/world';
import type { Session } from './session';

/** A live table is a modal input boundary, never a paused simulation. */
export function frickFrackInputLocked(world: World | null, session: Session): boolean {
  if (!world || session.spectator || session.screen !== 'playing' || world.phase !== 'playing') return false;
  const faction = world.factions[session.playerFaction];
  const avatar = world.avatarOf(session.playerFaction);
  return !!faction?.alive && faction.controlMode !== 'rts' && !!avatar && avatar.koUntil <= world.time
    && !!world.frickFrack?.sessions[session.playerFaction]
    && world.frickFrack.sessions[session.playerFaction]?.phase !== 'chasing';
}

/** Only the card table is fully opaque; the wizard's in-world dialogue is not.
 * This is a draw-cost hint, never a simulation/input/audio pause. */
export function frickFrackTableOccludesWorld(world: World | null, session: Session): boolean {
  if (!frickFrackInputLocked(world, session)) return false;
  const phase = world!.frickFrack.sessions[session.playerFaction]?.phase;
  return phase === 'betting' || phase === 'playing' || phase === 'result';
}
