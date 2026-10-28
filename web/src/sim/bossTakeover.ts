/** Shared boss takeover rules. Seat ownership/permission is supplied by the authoritative caller. */
import { FACTION_DEFS } from './constants';
import { matchSettings } from './matchSettings';
import { FACTION_IDS } from './types';
import type { FactionId } from './types';
import type { World } from './world';

/** A disabled but repairable altar still belongs to its camp; a removed or captured one does not. */
export function hasSurvivingAltar(world: World, faction: FactionId): boolean {
  const camp = world.factions[faction];
  return !!camp?.alive && camp.hearthIds.some((id) => {
    const altar = world.buildings.get(id);
    return altar?.kind === 'hearth' && altar.faction === faction;
  });
}

/** The reveal timer alone is insufficient: a real, unresolved encounter must exist. */
export function isBossTakeoverActive(world: World): boolean {
  return world.phase === 'playing' && world.boss !== null && world.bossOutcome === null;
}

/** `aiSeats` excludes human reservations, including disconnected humans currently driven by AI. */
export function bossTakeoverSeats(world: World, sourceSeat: FactionId | null, aiSeats: readonly FactionId[]): FactionId[] {
  if (!isBossTakeoverActive(world) || sourceSeat === null || !world.factions[sourceSeat] || world.factions[sourceSeat].alive) return [];
  const active = matchSettings(world.options).active;
  return FACTION_IDS.filter((f) => f !== sourceSeat && active.includes(f) && aiSeats.includes(f) &&
    (world.factions[sourceSeat].controlMode !== 'rts' || world.factions[f].controlMode === 'rts') &&
    hasSurvivingAltar(world, f) && (world.factions[f].controlMode === 'rts' || world.avatars.has(world.factions[f].avatarId)));
}

/**
 * Adopt the existing camp without spawning/replacing anything. Callers first establish exclusive
 * ownership, then stop its AI controller and reset their input/prediction state. Unrelated queued
 * commands, unit orders, flags, buildings, stats and the avatar's physical/action state survive.
 */
export function applyBossTakeover(world: World, sourceSeat: FactionId, targetSeat: FactionId, aiSeats: readonly FactionId[]): boolean {
  if (!bossTakeoverSeats(world, sourceSeat, aiSeats).includes(targetSeat)) return false;
  world.options.humans = FACTION_IDS.filter((f) => f === targetSeat || (f !== sourceSeat && world.options.humans.includes(f)));
  const source = world.factions[sourceSeat];
  source.isPlayer = false;
  source.personality = FACTION_DEFS[sourceSeat].personality;
  const target = world.factions[targetSeat];
  target.isPlayer = true;
  target.personality = 'player';
  for (const command of world.takeCommands()) {
    if (command.faction !== sourceSeat && command.faction !== targetSeat) world.submit(command);
  }
  const avatar = world.avatars.get(target.avatarId);
  if (avatar) avatar.input = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: avatar.input.yaw, pitch: avatar.input.pitch };
  return true;
}
