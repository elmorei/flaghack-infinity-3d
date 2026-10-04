/**
 * Command dispatch: routes validated player/AI commands to the owning system handlers.
 * Commands from eliminated factions (or after match end) are rejected here.
 */
import type { Command } from '../commands';
import type { World } from '../world';
import { cmdAbility, cmdAlign } from './abilities';
import { cmdAvatarInput, cmdPlant, cmdPull, cmdPushGcc, cmdSwing, cmdThrow } from './avatars';
import { cmdPlaceBuilding } from './buildings';
import { cmdBrew, cmdDrug } from './drugs';
import { cmdJobWeights } from './economy';
import { cmdGcc } from './gcc';
import { cmdHandFlag } from './recruitment';
import { cmdOrder, cmdRally, cmdSendFollowers } from './hippies';
import { cmdBuild, cmdDemolish } from './pieces';
import { cmdPing, cmdRetransmit, cmdTapBeacon } from './pings';
import { cmdPlan } from './survey';

export function applyCommands(world: World): void {
  const cmds = world.takeCommands();
  if (world.phase !== 'playing') return;
  // Only the latest avatarInput per faction matters this tick.
  const latestInput = new Map<number, Command>();
  for (const c of cmds) if (c.t === 'avatarInput') latestInput.set(c.faction, c);
  for (const c of cmds) {
    const fac = world.factions[c.faction];
    if (!fac || !fac.alive) continue;
    if (c.t === 'avatarInput' && latestInput.get(c.faction) !== c) continue;
    dispatch(world, c);
  }
}

function dispatch(world: World, c: Command): void {
  switch (c.t) {
    case 'avatarInput':
      return cmdAvatarInput(world, c);
    case 'plant':
      return cmdPlant(world, c);
    case 'throw':
      return cmdThrow(world, c);
    case 'pull':
      return cmdPull(world, c);
    case 'handFlag':
      return cmdHandFlag(world, c);
    case 'swing':
      return cmdSwing(world, c);
    case 'pushGcc':
      return cmdPushGcc(world, c);
    case 'build':
      return cmdBuild(world, c);
    case 'demolish':
      return cmdDemolish(world, c);
    case 'placeBuilding':
      return cmdPlaceBuilding(world, c);
    case 'plan':
      return cmdPlan(world, c);
    case 'jobWeights':
      return cmdJobWeights(world, c);
    case 'order':
      return cmdOrder(world, c);
    case 'rally':
      return cmdRally(world, c);
    case 'sendFollowers':
      return cmdSendFollowers(world, c);
    case 'ability':
      return cmdAbility(world, c);
    case 'align':
      return cmdAlign(world, c);
    case 'drug':
      return cmdDrug(world, c);
    case 'brew':
      return cmdBrew(world, c);
    case 'gcc':
      return cmdGcc(world, c);
    case 'ping':
      return cmdPing(world, c);
    case 'retransmit':
      return cmdRetransmit(world, c);
    case 'tapBeacon':
      return cmdTapBeacon(world, c);
  }
}
