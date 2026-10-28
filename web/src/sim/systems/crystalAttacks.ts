/** Ordinary crystal and seated-ruler PvP defense. Only the authoritative Simulation calls this system. */
import { CRYSTAL_HEIGHT } from '../constants';
import type { V3 } from '../math';
import type { Avatar, Crystal, FactionId, Hippie } from '../types';
import type { World } from '../world';
import { bossEncounterActive } from './boss/damage';
import { damageEntity } from './combat';
import { rtsThroneAltar } from '../rts';

export const CRYSTAL_ATTACK_RANGE = 16;
export const CRYSTAL_ATTACK_WARNING = 1;
export const CRYSTAL_ATTACK_DPS = 12;
export const CRYSTAL_ATTACK_OVERLAP_CAP = CRYSTAL_ATTACK_DPS * 1.5;
type Unit = Avatar | Hippie;
type Emitter = Pick<Crystal, 'id' | 'pos' | 'faction' | 'attack'> & { origin: V3 };

/** Seated hand/chest height, shared with the purely visual throne model. */
export const THRONE_ATTACK_HEIGHT = 2.2;
export function throneAttackOrigin(world: World, faction: FactionId): V3 {
  const altar = world.hearthOf(faction);
  const pos = altar?.pos ?? { x: 0, z: 0 };
  return { x: pos.x, y: world.collision.groundHeight(pos.x, pos.z) + THRONE_ATTACK_HEIGHT, z: pos.z };
}
const clocks = new WeakMap<World, number>();
const throneSources = new WeakMap<World, Map<FactionId, number>>();

/** Presentation shares endpoints, but never target selection, raycasts or damage. */
export function crystalAttackOrigin(world: World, crystal: Crystal): V3 {
  return { x: crystal.pos.x, y: world.collision.groundHeight(crystal.pos.x, crystal.pos.z) + CRYSTAL_HEIGHT, z: crystal.pos.z };
}
export function crystalAttackAim(world: World, unit: Unit): V3 {
  return { x: unit.pos.x, y: (unit.type === 'avatar' ? unit.pos.y : world.collision.groundHeight(unit.pos.x, unit.pos.z) + (unit.airborne?.y ?? 0)) + 1, z: unit.pos.z };
}
function eligible(world: World, crystal: Emitter, unit: Unit): boolean {
  return unit.faction !== -1 && unit.faction !== crystal.faction && world.factions[unit.faction].alive && unit.hp > 0 &&
    (unit.type === 'avatar' ? unit.koUntil === 0 && world.factions[unit.faction].controlMode !== 'rts' : unit.status !== 'ko') &&
    (unit.pos.x - crystal.pos.x) ** 2 + (unit.pos.z - crystal.pos.z) ** 2 <= CRYSTAL_ATTACK_RANGE ** 2;
}
function visible(world: World, crystal: Emitter, unit: Unit): boolean {
  const from = crystal.origin, to = crystalAttackAim(world, unit);
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  return !world.collision.raycast(from.x, from.y, from.z, dx, dy, dz, Math.max(0, Math.hypot(dx, dy, dz) - .05), crystal.id);
}
function nearest(world: World, crystal: Emitter): Unit | null {
  // Cheap range/faction filtering first. Stable ids break exact distance ties.
  const candidates: Unit[] = [];
  for (const unit of world.avatars.values()) if (eligible(world, crystal, unit)) candidates.push(unit);
  for (const unit of world.hippies.values()) if (eligible(world, crystal, unit)) candidates.push(unit);
  const distance = (u: Unit) => (u.pos.x - crystal.pos.x) ** 2 + (u.pos.z - crystal.pos.z) ** 2;
  candidates.sort((a, b) => distance(a) - distance(b) || a.id - b.id);
  return candidates.find(u => visible(world, crystal, u)) ?? null;
}

export function updateCrystalAttacks(world: World, dt: number): void {
  const previous = clocks.get(world), end = world.time;
  const start = Math.max(end - (Number.isFinite(dt) ? Math.max(0, dt) : 0), previous ?? -Infinity);
  clocks.set(world, end);
  const enabled = world.phase === 'playing' && world.options.mode !== 'tutorial' &&
    world.options.match?.crystalAttacks !== false && !bossEncounterActive(world);
  const incoming = new Map<number, { by: number; starts: number[] }>();
  const emitters: Emitter[] = [];
  for (const crystal of world.crystals.values()) {
    if (!enabled || crystal.scale !== 1 || crystal.growth < 1 || !world.factions[crystal.faction].alive) {
      crystal.attack = null; continue;
    }
    emitters.push({ ...crystal, origin: crystalAttackOrigin(world, crystal) });
  }
  let sources = throneSources.get(world);
  if (!sources) { sources = new Map(); throneSources.set(world, sources); }
  for (const faction of Object.values(world.factions)) {
    const altar = enabled ? rtsThroneAltar(world, faction.id) : undefined;
    if (!altar) { faction.throneAttack = null; sources.delete(faction.id); continue; }
    // A replacement main altar is a new emitter and must give its own warning.
    if (sources.has(faction.id) && sources.get(faction.id) !== altar.id) faction.throneAttack = null;
    sources.set(faction.id, altar.id);
    emitters.push({ id: altar.id, pos: altar.pos, faction: faction.id, attack: faction.throneAttack,
      origin: throneAttackOrigin(world, faction.id) });
  }
  for (const crystal of emitters) {
    let target: Unit | null | undefined = crystal.attack && (world.avatars.get(crystal.attack.target) ?? world.hippies.get(crystal.attack.target));
    if (!target || crystal.attack?.faction !== crystal.faction || !eligible(world, crystal, target) || !visible(world, crystal, target)) {
      crystal.attack = null;
      target = nearest(world, crystal);
      if (target) crystal.attack = { target: target.id, readyAt: end + CRYSTAL_ATTACK_WARNING, faction: crystal.faction };
    }
    const source = world.crystals.get(crystal.id);
    if (source) source.attack = crystal.attack;
    else world.factions[crystal.faction].throneAttack = crystal.attack;
    if (!target || !crystal.attack) continue;
    const activeAt = Math.max(start, crystal.attack.readyAt);
    if (activeAt >= end) continue;
    let entry = incoming.get(target.id);
    if (!entry) { entry = { by: crystal.id, starts: [] }; incoming.set(target.id, entry); }
    entry.by = Math.min(entry.by, crystal.id); entry.starts.push(activeAt);
  }
  // Integrate the overlap cap over warning expiries, including coarse/debug timesteps.
  // Each target receives one damage operation per tick: never a stun or pull-channel reset.
  for (const [target, hit] of incoming) {
    hit.starts.sort((a, b) => a - b);
    let amount = 0;
    for (let i = 0; i < hit.starts.length; i++) amount +=
      ((hit.starts[i + 1] ?? end) - hit.starts[i]) * Math.min(CRYSTAL_ATTACK_OVERLAP_CAP, (i + 1) * CRYSTAL_ATTACK_DPS);
    damageEntity(world, target, amount, hit.by);
  }
}
