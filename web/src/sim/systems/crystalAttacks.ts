/** Ordinary crystal PvP defense. Only the authoritative Simulation calls this system. */
import { CRYSTAL_HEIGHT } from '../constants';
import type { V3 } from '../math';
import type { Avatar, Crystal, Hippie } from '../types';
import type { World } from '../world';
import { bossEncounterActive } from './boss/damage';
import { damageEntity } from './combat';

export const CRYSTAL_ATTACK_RANGE = 16;
export const CRYSTAL_ATTACK_WARNING = 1;
export const CRYSTAL_ATTACK_DPS = 12;
export const CRYSTAL_ATTACK_OVERLAP_CAP = CRYSTAL_ATTACK_DPS * 1.5;
type Unit = Avatar | Hippie;
const clocks = new WeakMap<World, number>();

/** Presentation shares endpoints, but never target selection, raycasts or damage. */
export function crystalAttackOrigin(world: World, crystal: Crystal): V3 {
  return { x: crystal.pos.x, y: world.collision.groundHeight(crystal.pos.x, crystal.pos.z) + CRYSTAL_HEIGHT, z: crystal.pos.z };
}
export function crystalAttackAim(world: World, unit: Unit): V3 {
  return { x: unit.pos.x, y: (unit.type === 'avatar' ? unit.pos.y : world.collision.groundHeight(unit.pos.x, unit.pos.z) + (unit.airborne?.y ?? 0)) + 1, z: unit.pos.z };
}
function eligible(world: World, crystal: Crystal, unit: Unit): boolean {
  return unit.faction !== -1 && unit.faction !== crystal.faction && world.factions[unit.faction].alive && unit.hp > 0 &&
    (unit.type === 'avatar' ? unit.koUntil === 0 : unit.status !== 'ko') &&
    (unit.pos.x - crystal.pos.x) ** 2 + (unit.pos.z - crystal.pos.z) ** 2 <= CRYSTAL_ATTACK_RANGE ** 2;
}
function visible(world: World, crystal: Crystal, unit: Unit): boolean {
  const from = crystalAttackOrigin(world, crystal), to = crystalAttackAim(world, unit);
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  return !world.collision.raycast(from.x, from.y, from.z, dx, dy, dz, Math.max(0, Math.hypot(dx, dy, dz) - .05));
}
function nearest(world: World, crystal: Crystal): Unit | null {
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
  for (const crystal of world.crystals.values()) {
    if (!enabled || crystal.scale !== 1 || crystal.growth < 1 || !world.factions[crystal.faction].alive) {
      crystal.attack = null; continue;
    }
    let target: Unit | null | undefined = crystal.attack && (world.avatars.get(crystal.attack.target) ?? world.hippies.get(crystal.attack.target));
    if (!target || crystal.attack?.faction !== crystal.faction || !eligible(world, crystal, target) || !visible(world, crystal, target)) {
      crystal.attack = null;
      target = nearest(world, crystal);
      if (target) crystal.attack = { target: target.id, readyAt: end + CRYSTAL_ATTACK_WARNING, faction: crystal.faction };
    }
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
