/** Authoritative control-mode changes preserve the camp, refund incompatible spell investment once. */
import { ALIGN_COST, AVATAR, BUILDINGS } from './constants';
import { spawnAvatar } from './factory';
import type { Avatar, ChakraId, FactionId, FactionState } from './types';
import type { World } from './world';
import { closeFrickFrackSession } from './systems/frickFrack';
import { dropLoose } from './systems/flags';
import { econ } from './systems/econ/state';

const parkedBodies = new WeakMap<World, Map<FactionId, Avatar>>();
/** These slots carry different spells in Avatar and RTS modes; shared AOE slots are retained. */
export const MODE_SPECIFIC_CHAKRAS: readonly ChakraId[] = ['hoist', 'fly', 'field'];

/** Paid upgrades removed by a mode change; shared unlocks and unfinished casts carry no refund. */
export function controlModeRefund(faction: Pick<FactionState, 'controlMode' | 'chakras'>, mode: 'avatar' | 'rts'): number {
  if (faction.controlMode === mode) return 0;
  let refund = 0;
  for (const chakra of MODE_SPECIFIC_CHAKRAS) {
    for (let level = 0; level < faction.chakras[chakra]; level++) refund += ALIGN_COST[level] ?? 0;
  }
  return refund;
}

export function setFactionControlMode(world: World, f: FactionId, mode: 'avatar' | 'rts'): boolean {
  const fac = world.factions[f];
  if (!fac?.alive || world.phase !== 'playing' || fac.controlMode === mode) return false;
  const cart = world.gccOf(f);
  // A failed transition must be inert, even for a malformed/legacy camp snapshot.
  if (mode === 'avatar' && !parkedBodies.get(world)?.has(f) && !world.hearthOf(f) && !cart) return false;
  closeFrickFrackSession(world, f);
  fac.ritual += controlModeRefund(fac, mode);
  for (const chakra of MODE_SPECIFIC_CHAKRAS) {
    fac.chakras[chakra] = 0;
  }
  econ(world).aligning[f] = null;
  for (const [id, zone] of world.zones) if (zone.faction === f && ['alignment', 'omegaCharge', 'redtape', 'patchwork'].includes(zone.kind)) world.zones.delete(id);
  if (cart?.gcc) { cart.gcc.moveTarget = null; cart.gcc.pushedBy = -1; }
  let parked = parkedBodies.get(world);
  if (!parked) { parked = new Map(); parkedBodies.set(world, parked); }
  if (mode === 'rts') {
    const avatar = world.avatars.get(fac.avatarId);
    if (avatar) {
      for (const flag of [...avatar.carried]) dropLoose(world, flag, avatar.pos);
      avatar.action = { kind: 'idle' }; avatar.pushing = -1;
      avatar.input = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: avatar.yaw, pitch: avatar.pitch };
      avatar.vel = { x: 0, y: 0, z: 0 };
      parked.set(f, avatar); world.avatars.delete(avatar.id);
    }
    fac.avatarId = -1;
  } else {
    let avatar = parked.get(f);
    if (avatar) { parked.delete(f); world.avatars.set(avatar.id, avatar); fac.avatarId = avatar.id; }
    else {
      const home = world.hearthOf(f) ?? cart;
      if (!home) return false;
      const radius = BUILDINGS[home.kind].radius + AVATAR.radius + 1;
      let at = { x: home.pos.x + radius, z: home.pos.z };
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16, distance = radius + Math.floor(i / 16) * 2;
        const p = { x: home.pos.x + Math.cos(angle) * distance, z: home.pos.z + Math.sin(angle) * distance };
        const y = world.collision.groundHeight(p.x, p.z);
        if (!world.collision.blockedCircle(p.x, p.z, AVATAR.radius, y + .05, y + AVATAR.height)) { at = p; break; }
      }
      avatar = spawnAvatar(world, f, at);
    }
  }
  fac.controlMode = mode;
  world.options.rtsFactions = world.factions.filter(c => c.controlMode === 'rts').map(c => c.id);
  for (const command of world.takeCommands()) if (command.faction !== f) world.submit(command);
  return true;
}
