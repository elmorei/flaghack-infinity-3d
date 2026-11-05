/** Any eliminated player or late spectator may atomically adopt an unreserved surviving NPC camp. */
import { hasSurvivingAltar } from './bossTakeover';
import { FACTION_DEFS } from './constants';
import { setFactionControlMode } from './controlMode';
import { matchSettings } from './matchSettings';
import { FACTION_IDS } from './types';
import type { FactionId } from './types';
import type { World } from './world';

export function npcTakeoverSeats(world: World, source: FactionId | null, aiSeats: readonly FactionId[]): FactionId[] {
  if (world.phase !== 'playing' || world.bossOutcome || (source !== null && (!world.factions[source] || world.factions[source].alive))) return [];
  const active = matchSettings(world.options).active;
  return FACTION_IDS.filter(f => f !== source && active.includes(f) && aiSeats.includes(f) && hasSurvivingAltar(world, f));
}

export function applyNpcTakeover(world: World, source: FactionId | null, target: FactionId, aiSeats: readonly FactionId[], mode?: 'avatar' | 'rts'): boolean {
  if (!npcTakeoverSeats(world, source, aiSeats).includes(target)) return false;
  const faction = world.factions[target];
  // A rejected conversion must not adopt the camp or discard either seat's queued input.
  if (mode && faction.controlMode !== mode && !setFactionControlMode(world, target, mode)) return false;
  world.options.humans = FACTION_IDS.filter(f => f === target || (f !== source && world.options.humans.includes(f)));
  if (source !== null) {
    world.factions[source].isPlayer = false;
    world.factions[source].personality = FACTION_DEFS[source].personality;
  }
  faction.isPlayer = true; faction.personality = 'player';
  for (const command of world.takeCommands()) if (command.faction !== source && command.faction !== target) world.submit(command);
  const avatar = world.avatars.get(faction.avatarId);
  if (avatar) avatar.input = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: avatar.input.yaw, pitch: avatar.input.pitch };
  return true;
}
