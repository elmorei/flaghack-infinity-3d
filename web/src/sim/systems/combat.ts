/**
 * Damage and knockback for units, plus a dispatcher that routes structure damage to the
 * Economy systems. Every damage source in the game calls `damageEntity`.
 * Owner: Units agent.
 */
import { AVATAR, BEACON_DROP_CHANCE, BEACON_LIFETIME, HIPPIE, MAP_HALF } from '../constants';
import { spawnBeacon } from '../factory';
import { TAU } from '../math';
import type { V2 } from '../math';
import { NEUTRAL } from '../types';
import type { Avatar, EntityId, Hippie } from '../types';
import type { World } from '../world';
import { damageBuilding } from './buildings';
import { applyEffect } from './effects';
import { dropLoose } from './flags';
import { damagePiece } from './pieces';
import { sosFrom } from './pings';
import { brainOf, releaseTask } from './units/brain';
import { breakChannel, IDLE } from './units/channel';

/** Seconds a unit is flagged as being shoved around after a knockback impulse. */
const AVATAR_KNOCK_TIME = 0.3;
const HIPPIE_KNOCK_TIME = 0.35;
/** Share of a knockback impulse that lifts an avatar off the ground. */
const AVATAR_KNOCK_LIFT = 0.35;

/**
 * Apply damage to any damageable entity (avatar, hippie, piece, building). Emits hit and,
 * for units at 0 HP, ko (dropping carried Flags loose). Returns true if the target took damage.
 */
export function damageEntity(world: World, target: EntityId, amount: number, by: EntityId | -1): boolean {
  const piece = world.pieces.get(target);
  if (piece) return damagePiece(world, piece, amount, by);
  const b = world.buildings.get(target);
  if (b) return damageBuilding(world, b, amount, by);
  return damageUnit(world, target, amount, by);
}

/** Avatar/hippie damage, KO handling, SOS auto-ping for hippies. */
export function damageUnit(world: World, target: EntityId, amount: number, by: EntityId | -1): boolean {
  if (!(amount > 0)) return false;
  const av = world.avatars.get(target);
  if (av) return damageAvatar(world, av, amount, by);
  const h = world.hippies.get(target);
  if (h) return damageHippie(world, h, amount, by);
  return false;
}

function damageAvatar(world: World, av: Avatar, amount: number, by: EntityId | -1): boolean {
  if (av.koUntil > 0) return false;
  av.hp -= amount;
  av.lastHurtAt = world.time;
  world.emit({ t: 'hit', target: av.id, by, amount, pos: { x: av.pos.x, y: av.pos.y, z: av.pos.z } });
  // Pain breaks concentration: aligning and channelling stop; a pull channel survives.
  if (av.action.kind === 'align' || av.action.kind === 'channel') breakChannel(world, av);
  if (av.hp <= 0) koAvatar(world, av, by);
  return true;
}

function damageHippie(world: World, h: Hippie, amount: number, by: EntityId | -1): boolean {
  if (h.status === 'ko') return false;
  h.hp -= amount;
  const b = brainOf(h);
  b.lastHurtAt = world.time;
  b.lastHurtBy = by;
  b.hurt = true;
  world.emit({ t: 'hit', target: h.id, by, amount, pos: { x: h.pos.x, y: 0, z: h.pos.z } });
  if (h.faction !== NEUTRAL) sosFrom(world, h);
  if (h.hp <= 0) koHippie(world, h, by);
  return true;
}

/**
 * Flagless: the vexillomancer drops the whole quiver loose in a scatter, stops whatever it was
 * doing and waits to respawn at its Hearth (never, once the faction is eliminated).
 */
function koAvatar(world: World, av: Avatar, by: EntityId | -1): void {
  av.hp = 0;
  av.koUntil = world.factions[av.faction].alive ? world.time + AVATAR.respawnTime : Infinity;
  breakChannel(world, av);
  av.action = IDLE;
  if (av.pushing >= 0) {
    const g = world.buildings.get(av.pushing);
    if (g && g.gcc && g.gcc.pushedBy === av.id) g.gcc.pushedBy = -1;
    av.pushing = -1;
  }
  av.vel.x = 0;
  av.vel.y = 0;
  av.vel.z = 0;
  av.effects.length = 0;
  world.emit({ t: 'ko', id: av.id, kind: 'avatar', faction: av.faction, by, pos: { x: av.pos.x, y: av.pos.y, z: av.pos.z } });
  const lim = MAP_HALF - 1;
  for (const id of av.carried.slice()) {
    const a = world.rng.range(0, TAU);
    const r = Math.sqrt(world.rng.next()) * AVATAR.koScatter;
    const x = Math.max(-lim, Math.min(lim, av.pos.x + Math.sin(a) * r));
    const z = Math.max(-lim, Math.min(lim, av.pos.z + Math.cos(a) * r));
    dropLoose(world, id, { x, y: world.collision.supportHeight(x, z, av.pos.y + 0.5), z });
  }
}

/**
 * A hippie at 0 vibes: drops its Flag loose (lumber is lost), may MOOP its D.E.G.E.N.
 * beacon, forgets one-shot orders and waits HIPPIE.respawnTime.
 */
function koHippie(world: World, h: Hippie, by: EntityId | -1): void {
  releaseTask(world, h, brainOf(h));
  if (h.carryingFlag !== -1) dropLoose(world, h.carryingFlag, { x: h.pos.x, y: 0, z: h.pos.z });
  h.carryingLumber = 0;
  // Knockouts break allegiance: no old camp orders survive the neutral respawn.
  h.order = null;
  h.job = null;
  if (h.faction !== NEUTRAL && h.beacon && world.rng.chance(BEACON_DROP_CHANCE)) {
    spawnBeacon(world, h.faction, h.pos, world.time + BEACON_LIFETIME);
    h.beacon = false;
  }
  h.hp = 0;
  h.status = 'ko';
  h.statusTarget = null;
  h.koUntil = world.time + HIPPIE.respawnTime;
  h.vel.x = 0;
  h.vel.z = 0;
  h.effects.length = 0;
  world.emit({ t: 'ko', id: h.id, kind: 'hippie', faction: h.faction, by, pos: { x: h.pos.x, y: 0, z: h.pos.z } });
}

/** Push a unit away from a point (adds 'knockback' effect and velocity). */
export function knockback(world: World, target: EntityId, from: V2, strength: number): void {
  const av = world.avatars.get(target);
  if (av) {
    if (av.koUntil > 0) return;
    const d = Math.hypot(av.pos.x - from.x, av.pos.z - from.z);
    // Point-blank pushes go along the avatar's own facing (deterministic, no RNG).
    const dx = d > 1e-3 ? (av.pos.x - from.x) / d : -Math.sin(av.yaw);
    const dz = d > 1e-3 ? (av.pos.z - from.z) / d : -Math.cos(av.yaw);
    av.vel.x += dx * strength;
    av.vel.z += dz * strength;
    av.vel.y = Math.max(av.vel.y, strength * AVATAR_KNOCK_LIFT);
    av.onGround = false;
    applyEffect(world, av, 'knockback', AVATAR_KNOCK_TIME, strength);
    return;
  }
  const h = world.hippies.get(target);
  if (!h || h.status === 'ko') return;
  const d = Math.hypot(h.pos.x - from.x, h.pos.z - from.z);
  const dx = d > 1e-3 ? (h.pos.x - from.x) / d : -Math.sin(h.facing);
  const dz = d > 1e-3 ? (h.pos.z - from.z) / d : -Math.cos(h.facing);
  h.vel.x = dx * strength;
  h.vel.z = dz * strength;
  applyEffect(world, h, 'knockback', HIPPIE_KNOCK_TIME, strength);
}
