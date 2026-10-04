/**
 * Vexillomancer avatars: movement through CollisionWorld (run/sprint/jump/gravity/step),
 * actions (plant, throw, pull channel, staff swing, align/dialectics channels), quiver
 * restock at own Hearth, GCC pushing, KO (Flagless) and respawn, HP regen.
 * Player and AI avatars are identical; both are driven only by these commands.
 * Owner: Units agent.
 */
import { AVATAR, BUILDINGS, GCC, HIPPIE, MAP_HALF } from '../constants';
import type { CommandOf } from '../commands';
import { spawnProjectile } from '../factory';
import { matchSettings } from '../matchSettings';
import { angleDiff, clamp, TAU } from '../math';
import type { V3 } from '../math';
import { NEUTRAL } from '../types';
import type { Avatar, AvatarAction, AvatarInput, FactionId, Flag, Pile } from '../types';
import type { World } from '../world';
import { isFlagProtected } from './abilities';
import { damageEntity, knockback } from './combat';
import { hasEffect, pruneEffects, speedMultiplier } from './effects';
import { canPlantAt, plantFlag, pullFlag, takeFromStock } from './flags';
import { gccActive } from './gcc';
import { moveCart } from './units/cart';
import { breakChannel, IDLE, isRooted } from './units/channel';
import { BUILDING_HEIGHT, buildingClosest, pieceClosest, pieceSpan } from './units/reach';
import type { ReachPoint, Span } from './units/reach';
import { unitsState } from './units/state';
import type { AvatarMind } from './units/state';

/** Hand offset from the feet for throws (forward along yaw, to the right). */
const HAND_FORWARD = 0.35;
const HAND_RIGHT = 0.25;
/** Extra slack before a pull channel snaps when the puller drifts away. */
const PULL_SLACK = 0.5;
/** Melee reaches units within this height difference. */
const UNIT_VERTICAL_REACH = 1.6;
/** How far above the head the staff still connects with structures. */
const STAFF_OVERHEAD = 0.8;
/** Targets this close are hit regardless of the swing arc. */
const POINT_BLANK = 0.8;
const PILE_RADIUS = 1.2;
/** Gap kept between the vexillomancer and the pushed cart, and how far it may drift. */
const PUSH_GAP = 0.45;
const PUSH_LEASH = 2.5;
/** The cart swings round to the avatar's facing at this rate (rad/s). */
const PUSH_ORBIT_RATE = 2.4;
/** The cart may move slightly faster than pushSpeed to stay ahead of its pusher. */
const PUSH_CATCHUP = 1.25;
/** How far the pusher may sink into a wedged cart before letting go (two ticks of push pace). */
const PUSH_WEDGE_SLACK = 0.15;
/** Respawn ring distance from the Hearth's edge. */
const RESPAWN_GAP = 2.3;
/** After an empty-stock restock attempt, wait this long before trying again. */
const RESTOCK_BACKOFF = 0.5;
/** Ground friction applied while a knockback impulse carries the avatar. */
const KNOCK_FRICTION = 6;
/** Restocking works from the ground or a low deck, not from the roof of a tower. */
const LEVEL_REACH = 2;

const reachPt: ReachPoint = { x: 0, z: 0, dist: 0 };
const span: Span = { y0: 0, y1: 0 };

function reject(world: World, faction: FactionId, reason: string): void {
  world.emit({ t: 'rejected', faction, reason });
}

/** True while the avatar is KO'd (Flagless) awaiting respawn. */
export function isAvatarDown(world: World, av: Avatar): boolean {
  return av.koUntil > world.time;
}

/** Where a thrown Flag leaves the hand, for a vexillomancer at `pos` aiming along `yaw`. */
export function throwOrigin(pos: V3, yaw: number, out: V3): V3 {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  // Right of the facing direction is (-cos yaw, 0, sin yaw).
  out.x = pos.x + fx * HAND_FORWARD - fz * HAND_RIGHT;
  out.y = pos.y + AVATAR.throwHandHeight;
  out.z = pos.z + fz * HAND_FORWARD + fx * HAND_RIGHT;
  return out;
}

/** Launch velocity for an aim (yaw 0 = +z, pitch + up), including the throw's upward bias. */
export function throwVelocity(yaw: number, pitch: number, out: V3): V3 {
  const p = clamp(pitch, -AVATAR.pitchLimit, AVATAR.pitchLimit) + AVATAR.throwPitchBias;
  const c = Math.cos(p) * AVATAR.throwSpeed;
  out.x = Math.sin(yaw) * c;
  out.y = Math.sin(p) * AVATAR.throwSpeed;
  out.z = Math.cos(yaw) * c;
  return out;
}

/**
 * Latest control state for the sender's vexillomancer. Remote humans are untrusted: non-finite
 * numbers keep the previous aim (or stop), and only literal `true` presses jump / sprint.
 * stepAvatarMotion normalizes move length and clamps pitch itself.
 */
export function cmdAvatarInput(world: World, c: CommandOf<'avatarInput'>): void {
  const dst = world.avatarOf(c.faction).input;
  const src = c.input;
  dst.moveX = Number.isFinite(src.moveX) ? src.moveX : 0;
  dst.moveZ = Number.isFinite(src.moveZ) ? src.moveZ : 0;
  dst.jump = src.jump === true;
  dst.throwMode = src.throwMode === true;
  dst.sprint = src.sprint === true && !dst.throwMode;
  if (Number.isFinite(src.yaw)) dst.yaw = src.yaw;
  if (Number.isFinite(src.pitch)) dst.pitch = src.pitch;
}

/**
 * Discrete actions are silently ignored while KO'd, stunned or mid swing/plant lockout:
 * those are input timing, not mistakes worth a feed line.
 */
function canAct(world: World, av: Avatar): boolean {
  if (av.koUntil > 0 || hasEffect(world, av, 'stun')) return false;
  return av.action.kind !== 'swing' && av.action.kind !== 'plant';
}

export function cmdPlant(world: World, c: CommandOf<'plant'>): void {
  const av = world.avatarOf(c.faction);
  if (!canAct(world, av)) return;
  const lat = world.lattice;
  if (!Number.isInteger(c.node) || c.node < 0 || c.node >= lat.nodes.length) {
    reject(world, c.faction, 'There is no Ley Node there.');
    return;
  }
  if (av.carried.length === 0) {
    reject(world, c.faction, 'Your quiver is empty.');
    return;
  }
  const n = lat.nodes[c.node];
  const dx = n.x - av.pos.x;
  const dz = n.z - av.pos.z;
  if (dx * dx + dz * dz + av.pos.y * av.pos.y > AVATAR.plantReach * AVATAR.plantReach) {
    reject(world, c.faction, 'That Ley Node is out of reach.');
    return;
  }
  if (!canPlantAt(world, c.node, c.faction)) {
    reject(world, c.faction, 'That Ley Node cannot hold a Flag.');
    return;
  }
  breakChannel(world, av);
  if (!plantFlag(world, av.carried[av.carried.length - 1], c.node, c.faction, av.id)) {
    reject(world, c.faction, 'The Flag would not take.');
    return;
  }
  av.action = { kind: 'plant', node: c.node, t: world.time };
}

export function cmdThrow(world: World, c: CommandOf<'throw'>): void {
  const av = world.avatarOf(c.faction);
  if (av.koUntil > 0 || hasEffect(world, av, 'stun') || world.time < av.throwReadyAt) return;
  if (av.input.sprint && !av.input.throwMode) {
    reject(world, c.faction, 'Stop sprinting or enter throw mode to throw a Flag.');
    return;
  }
  if (av.carried.length === 0) {
    reject(world, c.faction, 'Your quiver is empty.');
    return;
  }
  const flag = world.flags.get(av.carried[av.carried.length - 1]);
  if (!flag) return;
  // A throw breaks concentration (align, channels) but not a pull in progress.
  if (av.action.kind === 'align' || av.action.kind === 'channel') breakChannel(world, av);
  const from = throwOrigin(av.pos, av.input.yaw, { x: 0, y: 0, z: 0 });
  const vel = throwVelocity(av.input.yaw, av.input.pitch, { x: 0, y: 0, z: 0 });
  av.carried.pop();
  const proj = spawnProjectile(world, flag.id, av.id, av.faction, from, vel);
  // flags.ts has no launch transition: carried → flying bookkeeping lives with the throw.
  flag.state = 'flying';
  flag.holder = proj.id;
  flag.node = -1;
  flag.tilt = 0;
  flag.lastMovedAt = world.time;
  flag.pos.x = from.x;
  flag.pos.y = from.y;
  flag.pos.z = from.z;
  flag.history.push({ t: world.time, x: from.x, z: from.z, state: 'flying', by: av.id });
  if (flag.history.length > 16) flag.history.splice(0, flag.history.length - 16);
  av.throwReadyAt = world.time + AVATAR.throwCooldown;
  world.emit({ t: 'flagThrown', flagId: flag.id, faction: av.faction, from: { ...from }, vel: { ...vel } });
}

/** 3D reach from the avatar's feet to a Flag's base (simulacra count at both nodes). */
function inPullReach(world: World, av: Avatar, fl: Flag, reach: number): boolean {
  const r2 = reach * reach;
  const dy2 = (av.pos.y - fl.pos.y) * (av.pos.y - fl.pos.y);
  const dx = fl.pos.x - av.pos.x;
  const dz = fl.pos.z - av.pos.z;
  if (dx * dx + dz * dz + dy2 <= r2) return true;
  if (fl.altNode < 0) return false;
  const alt = world.lattice.nodes[fl.altNode];
  const ax = alt.x - av.pos.x;
  const az = alt.z - av.pos.z;
  return ax * ax + az * az + av.pos.y * av.pos.y <= r2;
}

export function cmdPull(world: World, c: CommandOf<'pull'>): void {
  const av = world.avatarOf(c.faction);
  if (c.flagId === -1) {
    // Releasing the pull key cancels the channel.
    if (av.action.kind === 'pull') av.action = IDLE;
    return;
  }
  if (!canAct(world, av)) return;
  if (av.action.kind === 'pull' && av.action.flagId === c.flagId) return;
  const fl = world.flags.get(c.flagId);
  if (!fl || (fl.state !== 'planted' && fl.state !== 'loose')) {
    reject(world, c.faction, 'That Flag is not in the ground.');
    return;
  }
  if (!inPullReach(world, av, fl, AVATAR.pullReach)) {
    reject(world, c.faction, 'That Flag is out of reach.');
    return;
  }
  if (fl.state === 'loose' && av.carried.length >= AVATAR.quiver) {
    reject(world, c.faction, 'Your quiver is full.');
    return;
  }
  if (fl.owner !== av.faction && isFlagProtected(world, fl)) {
    reject(world, c.faction, 'A Stabilize Zone holds that Flag fast.');
    return;
  }
  breakChannel(world, av);
  const dur = fl.state === 'loose' ? AVATAR.pullLooseTime : fl.owner === av.faction ? AVATAR.pullOwnTime : AVATAR.pullEnemyTime;
  av.action = { kind: 'pull', flagId: fl.id, t: world.time, dur };
}

export function cmdSwing(world: World, c: CommandOf<'swing'>): void {
  const av = world.avatarOf(c.faction);
  if (!canAct(world, av)) return;
  breakChannel(world, av);
  av.action = { kind: 'swing', t: world.time, hit: false };
  world.emit({ t: 'swing', by: av.id, pos: { x: av.pos.x, y: av.pos.y, z: av.pos.z }, yaw: av.input.yaw });
}

export function cmdPushGcc(world: World, c: CommandOf<'pushGcc'>): void {
  const av = world.avatarOf(c.faction);
  if (!c.on) {
    stopPushing(world, av);
    return;
  }
  if (av.koUntil > 0 || hasEffect(world, av, 'stun')) return;
  const g = world.gccOf(c.faction);
  if (!g || !g.gcc || !gccActive(world, c.faction)) {
    reject(world, c.faction, 'Your Geomantic Command Center is not standing.');
    return;
  }
  const edge = Math.hypot(g.pos.x - av.pos.x, g.pos.z - av.pos.z) - BUILDINGS.gcc.radius;
  if (edge > AVATAR.gccPushReach || av.pos.y > 1) {
    reject(world, c.faction, 'Get your hands on the Command Center to push it.');
    return;
  }
  breakChannel(world, av);
  av.pushing = g.id;
  g.gcc.pushedBy = av.id;
}

function stopPushing(world: World, av: Avatar): void {
  if (av.pushing < 0) return;
  const g = world.buildings.get(av.pushing);
  if (g && g.gcc && g.gcc.pushedBy === av.id) g.gcc.pushedBy = -1;
  av.pushing = -1;
}

export function updateAvatars(world: World, dt: number): void {
  const minds = unitsState(world).avatarMinds;
  for (const av of world.avatars.values()) {
    let mind = minds.get(av.id);
    if (!mind) {
      mind = { restockAt: 0 };
      minds.set(av.id, mind);
    }
    updateAvatar(world, av, mind, dt);
  }
}

function updateAvatar(world: World, av: Avatar, mind: AvatarMind, dt: number): void {
  const alive = world.factions[av.faction].alive;
  if (alive && av.koUntil > 0 && world.time >= av.koUntil) respawnAvatar(world, av, mind);
  if (av.koUntil > 0 || !alive) {
    // Flagless (for good once eliminated): no control or actions, but the body still settles.
    stepAvatarMotion(world, av, av.input, dt);
    return;
  }
  pruneEffects(world, av);
  const stunned = hasEffect(world, av, 'stun');
  // The cart moves first so the pusher walks into the space it just left.
  updatePush(world, av, dt, stunned);
  stepAvatarMotion(world, av, av.input, dt);
  progressAction(world, av, stunned);
  if (av.input.throwMode && !stunned && canAct(world, av)) collectLooseFlags(world, av);
  restock(world, av, mind);
  if (av.hp < AVATAR.maxHp && world.time - av.lastHurtAt >= AVATAR.regenDelay) {
    av.hp = Math.min(AVATAR.maxHp, av.hp + AVATAR.regenPerSec * dt);
  }
}

/**
 * The avatar fields the motion step reads or writes. Client prediction keeps a copy of these
 * filled from the host's latest snapshot (net/mirror's AvatarKinematics is assignable).
 */
export type AvatarMotionState = Pick<
  Avatar,
  'pos' | 'vel' | 'yaw' | 'pitch' | 'onGround' | 'koUntil' | 'action' | 'effects' | 'pushing'
>;

/**
 * One tick of vexillomancer movement: THE motion code path, shared by the host sim
 * (updateAvatars) and client-side prediction (which replays unacked inputs through it), so the
 * two cannot drift. Identical inputs on identical state give bit-identical results in one engine.
 *
 * Reads `input` (never copied into av.input), and from `av`: pos, vel, onGround; koUntil (down:
 * input and aim are ignored, the body still falls); action (align / channel root it); effects
 * (stun roots it, knockback slides it, speed effects scale it, expiry judged at world.time);
 * pushing (speed capped to the cart's pace, the pushed cart's own shape is passed through).
 * From `world`: `time`, `collision`, and the match's jump-height setting.
 * Writes only av.pos, av.vel, av.onGround, av.yaw and av.pitch: no events or RNG.
 */
export function stepAvatarMotion(world: World, av: AvatarMotionState, input: AvatarInput, dt: number): void {
  const down = av.koUntil > 0;
  if (!down) {
    av.yaw = input.yaw;
    av.pitch = clamp(input.pitch, -AVATAR.pitchLimit, AVATAR.pitchLimit);
  }
  const held = down || isRooted(av) || hasEffect(world, av, 'stun');
  let wx = 0;
  let wz = 0;
  if (!held) {
    wx = input.moveX;
    wz = input.moveZ;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
  }
  if (!hasEffect(world, av, 'knockback')) {
    let speed = (input.sprint && !input.throwMode ? AVATAR.sprintSpeed : AVATAR.runSpeed) * speedMultiplier(world, av);
    if (av.pushing >= 0) speed = Math.min(speed, GCC.pushSpeed);
    const a = AVATAR.accel * (av.onGround ? 1 : AVATAR.airControl) * dt;
    let dvx = wx * speed - av.vel.x;
    let dvz = wz * speed - av.vel.z;
    const dl = Math.hypot(dvx, dvz);
    if (dl > a) {
      dvx *= a / dl;
      dvz *= a / dl;
    }
    av.vel.x += dvx;
    av.vel.z += dvz;
  } else if (av.onGround) {
    const k = Math.max(0, 1 - KNOCK_FRICTION * dt);
    av.vel.x *= k;
    av.vel.z *= k;
  }
  if (input.jump && av.onGround && !held) {
    // Apex height is proportional to launch velocity squared; 2.0 means twice the height.
    av.vel.y = AVATAR.jumpSpeed * Math.sqrt(matchSettings(world.options).jumpHeight);
    av.onGround = false;
  }
  av.vel.y -= AVATAR.gravity * dt;
  // The pushed cart leads its pusher; a client's copy of it lags, so it never blocks the pusher.
  const ignore = av.pushing >= 0 ? av.pushing : undefined;
  const res = world.collision.moveCharacter(av.pos, av.vel, dt, AVATAR.radius, AVATAR.height, AVATAR.stepHeight, ignore);
  av.onGround = res.onGround;
  const lim = MAP_HALF - AVATAR.radius;
  if (av.pos.x > lim || av.pos.x < -lim) {
    av.pos.x = clamp(av.pos.x, -lim, lim);
    av.vel.x = 0;
  }
  if (av.pos.z > lim || av.pos.z < -lim) {
    av.pos.z = clamp(av.pos.z, -lim, lim);
    av.vel.z = 0;
  }
}

function progressAction(world: World, av: Avatar, stunned: boolean): void {
  const a = av.action;
  switch (a.kind) {
    case 'swing': {
      const el = world.time - a.t;
      if (!a.hit && el >= AVATAR.swingTime * AVATAR.swingHitAt) {
        a.hit = true;
        if (!stunned) resolveSwing(world, av);
      }
      if (el >= AVATAR.swingTime) av.action = IDLE;
      return;
    }
    case 'plant':
      if (world.time - a.t >= AVATAR.plantTime) av.action = IDLE;
      return;
    case 'pull':
      progressPull(world, av, a, stunned);
      return;
    default:
      return;
  }
}

function progressPull(world: World, av: Avatar, a: Extract<AvatarAction, { kind: 'pull' }>, stunned: boolean): void {
  const fl = world.flags.get(a.flagId);
  if (
    stunned ||
    !fl ||
    (fl.state !== 'planted' && fl.state !== 'loose') ||
    !inPullReach(world, av, fl, AVATAR.pullReach + PULL_SLACK) ||
    (fl.owner !== av.faction && isFlagProtected(world, fl))
  ) {
    av.action = IDLE;
    return;
  }
  if (world.time - a.t < a.dur) return;
  av.action = IDLE;
  // Into the quiver when there is room; a planted Flag otherwise falls loose (flags.ts).
  pullFlag(world, fl.id, av.id);
}

function inCone(ax: number, az: number, fx: number, fz: number, cosHalf: number, tx: number, tz: number, maxDist: number): boolean {
  const dx = tx - ax;
  const dz = tz - az;
  const d2 = dx * dx + dz * dz;
  if (d2 > maxDist * maxDist) return false;
  if (d2 < POINT_BLANK * POINT_BLANK) return true;
  return (dx * fx + dz * fz) / Math.sqrt(d2) >= cosHalf;
}

/**
 * The staff connects: every rival unit in the arc takes swingDamage and a shove, the single
 * nearest rival structure takes swingPieceDamage, and the nearest pile yields lumber.
 */
function resolveSwing(world: World, av: Avatar): void {
  const fx = Math.sin(av.yaw);
  const fz = Math.cos(av.yaw);
  const cosHalf = Math.cos((AVATAR.swingCone * Math.PI) / 360);
  const reach = AVATAR.swingReach;
  const ax = av.pos.x;
  const ay = av.pos.y;
  const az = av.pos.z;
  for (const o of world.avatars.values()) {
    if (o.faction === av.faction || o.koUntil > 0 || Math.abs(o.pos.y - ay) > UNIT_VERTICAL_REACH) continue;
    if (!inCone(ax, az, fx, fz, cosHalf, o.pos.x, o.pos.z, reach + AVATAR.radius)) continue;
    damageEntity(world, o.id, AVATAR.swingDamage, av.id);
    knockback(world, o.id, av.pos, AVATAR.swingKnockback);
  }
  if (ay < UNIT_VERTICAL_REACH) {
    for (const h of world.hippies.values()) {
      if (h.faction === av.faction || h.faction === NEUTRAL || h.status === 'ko') continue;
      if (!inCone(ax, az, fx, fz, cosHalf, h.pos.x, h.pos.z, reach + HIPPIE.radius)) continue;
      damageEntity(world, h.id, AVATAR.swingDamage, av.id);
      knockback(world, h.id, av.pos, AVATAR.swingKnockback);
    }
  }

  const lat = world.lattice;
  const top = ay + AVATAR.height + STAFF_OVERHEAD;
  // Pieces are at most one rhombus long diagonal (~2 edges) across.
  const coarse = reach + lat.edge * 2;
  let target = -1;
  let bestD = Infinity;
  for (const p of world.pieces.values()) {
    if (p.faction === av.faction) continue;
    let cx: number;
    let cz: number;
    if (p.kind === 'wall') {
      const e = lat.edges[p.edge];
      cx = (lat.nodes[e.a].x + lat.nodes[e.b].x) / 2;
      cz = (lat.nodes[e.a].z + lat.nodes[e.b].z) / 2;
    } else {
      cx = lat.facets[p.facet].cx;
      cz = lat.facets[p.facet].cz;
    }
    if ((cx - ax) * (cx - ax) + (cz - az) * (cz - az) > coarse * coarse) continue;
    pieceSpan(p, span);
    if (span.y1 < ay || span.y0 > top) continue;
    pieceClosest(world, p, ax, az, reachPt);
    if (reachPt.dist > reach || reachPt.dist >= bestD) continue;
    if (!inCone(ax, az, fx, fz, cosHalf, reachPt.x, reachPt.z, Infinity)) continue;
    target = p.id;
    bestD = reachPt.dist;
  }
  if (ay < BUILDING_HEIGHT) {
    for (const b of world.buildings.values()) {
      if (b.faction === av.faction) continue;
      buildingClosest(b, ax, az, reachPt);
      if (reachPt.dist > reach || reachPt.dist >= bestD) continue;
      if (!inCone(ax, az, fx, fz, cosHalf, reachPt.x, reachPt.z, Infinity)) continue;
      target = b.id;
      bestD = reachPt.dist;
    }
  }
  if (target >= 0) damageEntity(world, target, AVATAR.swingPieceDamage, av.id);

  if (ay >= UNIT_VERTICAL_REACH) return;
  let pile: Pile | null = null;
  let pileD = Infinity;
  for (const p of world.piles.values()) {
    if (p.lumber <= 0) continue;
    const d2 = (p.pos.x - ax) * (p.pos.x - ax) + (p.pos.z - az) * (p.pos.z - az);
    if (d2 >= pileD || !inCone(ax, az, fx, fz, cosHalf, p.pos.x, p.pos.z, reach + PILE_RADIUS)) continue;
    pile = p;
    pileD = d2;
  }
  if (!pile) return;
  const amount = Math.min(AVATAR.swingLumber, pile.lumber);
  pile.lumber -= amount;
  world.factions[av.faction].lumber += amount;
  world.emit({ t: 'harvest', pileId: pile.id, by: av.id, amount, pos: { x: pile.pos.x, z: pile.pos.z } });
}

/** Throw mode gathers loose Flags in normal pickup reach, never pulling planted Flags. */
function collectLooseFlags(world: World, av: Avatar): void {
  for (const flag of world.flags.values()) {
    if (av.carried.length >= AVATAR.quiver) break;
    if (flag.state === 'loose' && inPullReach(world, av, flag, AVATAR.pullReach)) pullFlag(world, flag.id, av.id);
  }
}

/** One Flag per restockInterval from any own Hearth's stock within restockRadius of its edge. */
function restock(world: World, av: Avatar, mind: AvatarMind): void {
  if (av.carried.length >= AVATAR.quiver || world.time < mind.restockAt || av.pos.y > LEVEL_REACH) return;
  const reach = BUILDINGS.hearth.radius + AVATAR.restockRadius;
  for (const hid of world.factions[av.faction].hearthIds) {
    const h = world.buildings.get(hid);
    if (!h) continue;
    const dx = h.pos.x - av.pos.x;
    const dz = h.pos.z - av.pos.z;
    if (dx * dx + dz * dz > reach * reach) continue;
    if (takeFromStock(world, hid, av.id)) {
      mind.restockAt = world.time + AVATAR.restockInterval;
      return;
    }
  }
  mind.restockAt = world.time + RESTOCK_BACKOFF;
}

function updatePush(world: World, av: Avatar, dt: number, stunned: boolean): void {
  if (av.pushing < 0) return;
  const g = world.buildings.get(av.pushing);
  if (!g || !g.gcc || g !== world.gccOf(av.faction) || !gccActive(world, av.faction) || stunned || isRooted(av)) {
    stopPushing(world, av);
    return;
  }
  const standoff = BUILDINGS.gcc.radius + AVATAR.radius + PUSH_GAP;
  const dx = g.pos.x - av.pos.x;
  const dz = g.pos.z - av.pos.z;
  const d = Math.hypot(dx, dz);
  // The pusher passes through the cart's shape (stepAvatarMotion), so a cart wedged against
  // something is let go once the pusher has walked into it, and the cart blocks the pusher again.
  if (d > standoff + PUSH_LEASH || d < BUILDINGS.gcc.radius + AVATAR.radius - PUSH_WEDGE_SLACK) {
    stopPushing(world, av);
    return;
  }
  // The vexillomancer outranks a hippie pusher.
  g.gcc.pushedBy = av.id;
  // The cart orbits round to the aim (the motion step sets av.yaw after this) and is held at
  // arm's length in front.
  const face = av.input.yaw;
  const cur = d > 1e-3 ? Math.atan2(dx, dz) : face;
  const turn = PUSH_ORBIT_RATE * dt;
  const ang = cur + clamp(angleDiff(cur, face), -turn, turn);
  let mx = av.pos.x + Math.sin(ang) * standoff - g.pos.x;
  let mz = av.pos.z + Math.cos(ang) * standoff - g.pos.z;
  const ml = Math.hypot(mx, mz);
  if (ml < 1e-3) return;
  const step = GCC.pushSpeed * PUSH_CATCHUP * dt;
  if (ml > step) {
    mx *= step / ml;
    mz *= step / ml;
  }
  moveCart(world, g, g.pos.x + mx, g.pos.z + mz, ang, dt);
}

function respawnAvatar(world: World, av: Avatar, mind: AvatarMind): void {
  const hearth = world.hearthOf(av.faction);
  if (!hearth) {
    av.koUntil = Infinity;
    return;
  }
  // Wake on the side of the Hearth facing the burn, rotating round if that spot is built over.
  const toCentre = Math.atan2(-hearth.pos.x, -hearth.pos.z);
  const r = BUILDINGS.hearth.radius + RESPAWN_GAP;
  let x = hearth.pos.x + Math.sin(toCentre) * r;
  let z = hearth.pos.z + Math.cos(toCentre) * r;
  for (let i = 1; i < 8 && world.collision.blockedCircle(x, z, AVATAR.radius, 0.05, AVATAR.height); i++) {
    const a = toCentre + (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2) * (TAU / 8);
    x = hearth.pos.x + Math.sin(a) * r;
    z = hearth.pos.z + Math.cos(a) * r;
  }
  av.pos.x = x;
  av.pos.y = 0;
  av.pos.z = z;
  av.vel.x = 0;
  av.vel.y = 0;
  av.vel.z = 0;
  av.onGround = true;
  av.hp = AVATAR.maxHp;
  av.koUntil = 0;
  av.lastHurtAt = -Infinity;
  av.action = IDLE;
  av.effects.length = 0;
  av.throwReadyAt = 0;
  mind.restockAt = 0;
  world.emit({ t: 'respawn', id: av.id, kind: 'avatar', faction: av.faction, pos: { x, y: 0, z } });
}
