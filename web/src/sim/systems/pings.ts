/**
 * D.E.G.E.N. mesh: pings (rally/attack/flag/sos/shot), SOS auto-pings from hurt hippies,
 * Retransmit "TAKE A SHOT", dropped beacon pickup (mesh tap on a rival), expiry.
 * Owner: Units agent.
 */
import {
  AVATAR,
  HIPPIE_AI,
  MAP_HALF,
  MESH_TAP_DURATION,
  PING_DURATION,
  RETRANSMIT_ATTENTION,
  RETRANSMIT_COOLDOWN,
  SOS_COOLDOWN,
} from '../constants';
import type { CommandOf } from '../commands';
import { spawnPing } from '../factory';
import { clamp } from '../math';
import type { V2 } from '../math';
import { NEUTRAL } from '../types';
import type { FactionId, Hippie, PingKind } from '../types';
import type { World } from '../world';
import { applyEffect } from './effects';
import { brainOf, releaseTask } from './units/brain';

/** An SOS this close to a live SOS of the same camp repeats that ping instead of stacking. */
const SOS_MERGE_RADIUS = 8;
const RETRANSMIT_WOBBLE = 2;

/** Ping on the mesh: drops the faction's oldest ping beyond the cap, then emits 'ping'. */
function broadcast(world: World, kind: PingKind, faction: FactionId, at: V2, from: number): void {
  let live = 0;
  let oldest = -1;
  let oldestAt = Infinity;
  for (const p of world.pings.values()) {
    if (p.faction !== faction) continue;
    live++;
    if (p.bornAt < oldestAt) {
      oldestAt = p.bornAt;
      oldest = p.id;
    }
  }
  if (live >= HIPPIE_AI.maxActivePings && oldest >= 0) world.pings.delete(oldest);
  const lim = MAP_HALF - 1;
  const p = spawnPing(world, kind, faction, { x: clamp(at.x, -lim, lim), z: clamp(at.z, -lim, lim) }, from);
  world.emit({ t: 'ping', pingId: p.id, kind, faction, pos: { x: p.pos.x, z: p.pos.z } });
}

export function cmdPing(world: World, c: CommandOf<'ping'>): void {
  if (c.kind === 'shot') {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'TAKE A SHOT goes out over Retransmit, not as a ping.' });
    return;
  }
  if (!Number.isFinite(c.at.x) || !Number.isFinite(c.at.z)) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'The D.E.G.E.N. compass cannot point there.' });
    return;
  }
  broadcast(world, c.kind, c.faction, c.at, world.factions[c.faction].avatarId);
}

export function cmdRetransmit(world: World, c: CommandOf<'retransmit'>): void {
  if (world.factions[c.faction].controlMode === 'rts' || !world.avatarOf(c.faction)) return;
  const fac = world.factions[c.faction];
  if (fac.cooldowns.retransmit > world.time) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'The mesh is still ringing from the last shot.' });
    return;
  }
  fac.cooldowns.retransmit = world.time + RETRANSMIT_COOLDOWN;
  for (const h of world.hippies.values()) {
    if (h.faction !== c.faction || h.status === 'ko' || !h.beacon) continue;
    h.attention = Math.min(100, h.attention + RETRANSMIT_ATTENTION);
    applyEffect(world, h, 'wobble', RETRANSMIT_WOBBLE);
    // Attention is what distraction ran out of: the shot calls them back from the sound camp.
    const b = brainOf(h);
    if (b.task === 'distracted') releaseTask(world, h, b);
  }
  const av = world.avatarOf(c.faction);
  world.emit({ t: 'retransmit', faction: c.faction });
  broadcast(world, 'shot', c.faction, av.pos, av.id);
}

export function cmdTapBeacon(world: World, c: CommandOf<'tapBeacon'>): void {
  if (world.factions[c.faction].controlMode === 'rts' || !world.avatarOf(c.faction)) return;
  const bc = world.beacons.get(c.beaconId);
  if (!bc) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'That beacon has already been MOOPed.' });
    return;
  }
  if (bc.faction === c.faction) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'That beacon is already on your mesh.' });
    return;
  }
  const av = world.avatarOf(c.faction);
  const reach = AVATAR.beaconReach;
  const dx = av.pos.x - bc.pos.x;
  const dz = av.pos.z - bc.pos.z;
  if (av.koUntil > 0 || dx * dx + dz * dz > reach * reach || av.pos.y - world.collision.groundHeight(av.pos.x, av.pos.z) > reach) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'Get closer to pick up that beacon.' });
    return;
  }
  const fac = world.factions[c.faction];
  const until = Math.max(fac.meshTap[bc.faction] ?? 0, world.time + MESH_TAP_DURATION);
  fac.meshTap[bc.faction] = until;
  world.beacons.delete(bc.id);
  world.emit({ t: 'meshTapped', faction: c.faction, target: bc.faction, until });
}

/** Auto SOS from a hurt hippie (rate-limited by SOS_COOLDOWN). */
export function sosFrom(world: World, h: Hippie): void {
  const f = h.faction;
  if (f === NEUTRAL || world.time - h.lastSosAt < SOS_COOLDOWN) return;
  h.lastSosAt = world.time;
  // The D.E.G.E.N. SOS repeats: a fight already on the mesh is refreshed, not duplicated.
  const r2 = SOS_MERGE_RADIUS * SOS_MERGE_RADIUS;
  for (const p of world.pings.values()) {
    if (p.faction !== f || p.kind !== 'sos') continue;
    const dx = p.pos.x - h.pos.x;
    const dz = p.pos.z - h.pos.z;
    if (dx * dx + dz * dz > r2) continue;
    p.pos.x = h.pos.x;
    p.pos.z = h.pos.z;
    p.from = h.id;
    p.bornAt = world.time;
    p.until = world.time + PING_DURATION;
    return;
  }
  broadcast(world, 'sos', f, h.pos, h.id);
}

export function updatePings(world: World, dt: number): void {
  for (const p of world.pings.values()) if (p.until <= world.time) world.pings.delete(p.id);
  for (const b of world.beacons.values()) if (b.until <= world.time) world.beacons.delete(b.id);
}
