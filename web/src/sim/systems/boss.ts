import { leaveBuildingWreckage } from '../wreckage';
import { groundHeight } from '../terrain';
/** Host-only giant AI, movement and once-per-action impact windows. */
import { BOSS_DEATH_DURATION, BOSS_INTERRUPT_IMMUNITY, BOSS_RADIUS, BOSS_RECOIL_DURATION, BOSS_TIMING, createBossEyeState } from '../boss';
import { BOSS_GAMEPLAY_SCALE as SIZE } from '../bossDimensions';
import { bossFootContacts } from '../bossGait';
import type { BossAction, BossState, BossTarget } from '../boss';
import { BUILDINGS, MAP_HALF } from '../constants';
import { angleDiff, clamp, distToSegment } from '../math';
import { matchSettings } from '../matchSettings';
import { footprintDistance } from '../map/mapgen';
import type { V2 } from '../math';
import type { Building, EntityId, FactionId, Owner } from '../types';
import type { World } from '../world';
import { captureBossBarrierBreak, recordBossBarrierBreak } from './boss/barrierBreaks';
import { barrierFlags, bossLoopEdges, sweepBossLoops } from './boss/barriers';
import { registerBuildingShape } from './buildings';
import { damageEntity } from './combat';
import { applyEffect } from './effects';
import { destroyFlag } from './flags';
import { destroyPiece, piecePosition } from './pieces';
import { crushScenery } from './scenery';
import { eliminateByBoss } from './victory';
import { cancelBossEye, updateBossEye } from './boss/eye';
import { moveBossWithPlayerCollision } from './boss/playerCollision';
import { syncBossLightning, updateBossLightning } from './boss/lightning';

const WALK_SPEED = 4.3, CROUCH_SPEED = 2.0, GRAB_REACH = 8 * SIZE, SWIPE_REACH = 9 * SIZE;
const SWIPE_DAMAGE = 100, STOMP_DAMAGE = 140, STOMP_RADIUS = 4.6 * SIZE;
export const BOSS_FOOTFALL_RADIUS = 2.5, BOSS_FOOTFALL_PROP_SPAN = 5;
const HAND_HEIGHT = 12 * SIZE, CROUCH_DISTANCE = 15 * SIZE, SCENERY_STOMP_INTERVAL = 8 * SIZE;
const HAND_FACING = Math.PI / 12, WALK_FACING = Math.PI / 3;
export const BOSS_WEAVE_ANGLE = Math.PI / 12, BOSS_WEAVE_LEG = 10, BOSS_WEAVE_STRAIGHTEN = 25 * SIZE;

export function spawnBoss(world: World): BossState | null {
  if (world.boss || world.effigyRevealedAt === null || world.phase !== 'playing') return world.boss;
  const at = world.effigyRevealedAt;
  const hp = matchSettings(world.options).bossHp;
  world.boss = { id: world.newId(), pos: { x: world.map.effigy.x, z: world.map.effigy.z }, yaw: 0,
    hp, maxHp: hp, spawnedAt: at, action: 'emerge', crouched: false, actionAt: at,
    actionSeq: 0, hitSeq: -1, target: null, focusFaction: null, objectiveAltarId: null, routeStartStride: 0,
    nextSceneryStompStride: 0, opportunisticAfter: 0, retaliateId: null, retaliateUntil: 0,
    nextAttackAt: at + BOSS_TIMING.emerge, interruptImmuneUntil: 0, deathAt: null, barrier: null, stride: 0, held: null, eye: createBossEyeState(at), lightning: [] };
  world.emit({ t: 'notify', faction: 'all', text: 'The giant has awakened. Rival camps stand together. Protect your altars and bring it down!', severity: 'epic' });
  return world.boss;
}

/** Read-only objective lookup. Randomness belongs exclusively to host target selection. */
export function bossFocusAltar(world: World): Building | null {
  const boss = world.boss, locked = boss?.objectiveAltarId === null ? undefined : world.buildings.get(boss?.objectiveAltarId ?? -1);
  if (locked?.kind === 'hearth' && locked.faction >= 0 && world.factions[locked.faction].alive &&
      world.factions[locked.faction].hearthIds.includes(locked.id)) return locked;
  return null;
}

function distance(a: V2, b: V2): number { return Math.hypot(a.x - b.x, a.z - b.z); }
function face(b: BossState, to: V2, dt: number): number {
  const goal = Math.atan2(to.x - b.pos.x, to.z - b.pos.z);
  b.yaw += clamp(angleDiff(b.yaw, goal), -2.4 * dt, 2.4 * dt);
  return Math.abs(angleDiff(b.yaw, goal));
}
function action(world: World, b: BossState, next: BossAction): void {
  // Hand attacks may only begin from the settled crouch. Keep the full transition
  // even if another attack-selection path is added or the incoming stance is stale.
  if ((next === 'swipe' || next === 'grab') && !b.crouched) next = 'crouch';
  if (b.action === next) return;
  b.action = next; b.actionAt = world.time; b.actionSeq++; b.held = null;
}

/** A pulse can release a pending meal, but cannot undo a consumed target or stop the eye. */
export function interruptBossGrab(world: World): boolean {
  const b = world.boss;
  if (!b || b.hp <= 0 || b.deathAt !== null || world.phase !== 'playing' || world.effigyRevealedAt === null ||
      b.action !== 'grab' || b.hitSeq === b.actionSeq || world.time < b.interruptImmuneUntil ||
      b.eye.chargeAt !== null || b.eye.firedAt !== null) return false;
  b.crouched = true;
  b.interruptImmuneUntil = world.time + BOSS_INTERRUPT_IMMUNITY;
  b.nextAttackAt = Math.max(b.nextAttackAt, world.time + BOSS_RECOIL_DURATION);
  action(world, b, 'recoil');
  return true;
}
export function bossTargetPosition(world: World, t: BossTarget | null): V2 | null {
  if (!t) return null;
  if (t.kind === 'avatar') { const a = world.avatars.get(t.id); return a && a.koUntil === 0 && world.factions[a.faction].alive ? a.pos : null; }
  if (t.kind === 'hippie') { const h = world.hippies.get(t.id); return h && h.status !== 'ko' ? h.pos : null; }
  if (t.kind === 'building') return world.buildings.get(t.id)?.pos ?? null;
  if (t.kind === 'flag') { const f = world.flags.get(t.id); return f && (f.state === 'planted' || f.state === 'loose') ? f.pos : null; }
  const p = world.pieces.get(t.id); return p ? piecePosition(world, p) ?? null : null;
}

function target(world: World, b: BossState): BossTarget | null {
  let altar = bossFocusAltar(world);
  if (!altar) {
    const eligible = [...world.buildings.values()].filter(s => s.kind === 'hearth' && s.faction >= 0 &&
      world.factions[s.faction].alive && world.factions[s.faction].hearthIds.includes(s.id)).sort((a, c) => a.id - c.id);
    // One uniform seeded draw per new objective. Never reroll during a distraction,
    // approach, CMI change, or a presentation/mirror lookup.
    altar = eligible.length ? world.rng.pick(eligible) : null;
  }
  const focus = altar && altar.faction >= 0 ? altar.faction as FactionId : null;
  // A defense contacted on the previous camp's route is not a strategic target.
  // Re-sweep the new route instead of turning back to dismantle an irrelevant loop.
  if (b.objectiveAltarId !== (altar?.id ?? null)) {
    b.barrier = null; b.objectiveAltarId = altar?.id ?? null; b.routeStartStride = b.stride;
  }
  b.focusFaction = focus;
  if (b.retaliateId !== null && world.time < b.retaliateUntil) {
    const t: BossTarget = { kind: 'avatar', id: b.retaliateId };
    if (bossTargetPosition(world, t)) return t;
  } else b.retaliateId = null;
  // Once a boundary blocks us, eat its real supporting flags instead of stepping across.
  if (b.barrier && bossLoopEdges(world).includes(b.barrier.edge)) {
    const flags = barrierFlags(world, b.barrier.edge).sort((a, c) => distance(a.pos, b.pos) - distance(c.pos, b.pos) || a.id - c.id);
    if (flags[0]) return { kind: 'flag', id: flags[0].id };
  }
  // Once the strategic altar is within hand reach, finish the approach. Nearby
  // bystanders must not indefinitely postpone eating it; actual retaliation above
  // remains a bounded interrupt, and the hand sweep below still protects loops.
  if (altar && distance(altar.pos, b.pos) <= GRAB_REACH) return { kind: 'building', id: altar.id };
  // Keep a nearby selected body while lining up. Otherwise two surrounding units
  // can exchange nearest-place every tick and cancel the turn before either hit.
  if (world.time >= b.opportunisticAfter && (b.target?.kind === 'avatar' || b.target?.kind === 'hippie')) {
    const at = bossTargetPosition(world, b.target);
    const height = b.target.kind === 'avatar' ? world.avatars.get(b.target.id)?.pos.y : world.hippies.get(b.target.id)?.airborne?.y ?? 0;
    if (at && (height ?? 0) <= HAND_HEIGHT && distance(at, b.pos) < SWIPE_REACH - .5) return b.target;
  }
  // A nearby body is a brief opportunity, not a new long-range strategic priority.
  let nearest: BossTarget | null = null, best = SWIPE_REACH - 0.5;
  for (const a of world.avatars.values()) {
    if (a.koUntil || !world.factions[a.faction].alive || a.pos.y > HAND_HEIGHT) continue;
    const d = distance(a.pos, b.pos); if (d < best) { best = d; nearest = { kind: 'avatar', id: a.id }; }
  }
  for (const h of world.hippies.values()) {
    if (h.status === 'ko' || (h.airborne?.y ?? 0) > HAND_HEIGHT) continue;
    const d = distance(h.pos, b.pos); if (d < best) { best = d; nearest = { kind: 'hippie', id: h.id }; }
  }
  if (nearest && world.time >= b.nextAttackAt && world.time >= b.opportunisticAfter) return nearest;
  // Eat structures directly in our path; avoid wandering away from the locked altar.
  if (altar) {
    let obstacle: BossTarget | null = null, gap = GRAB_REACH - 0.5;
    for (const s of world.buildings.values()) {
      // Every gameplay structure is edible, including another altar, unfinished
      // construction and the remains of a collapsed GCC.
      if (s.id === altar.id) continue;
      const d = distance(s.pos, b.pos);
      if (d < gap && distToSegment(s.pos.x, s.pos.z, b.pos.x, b.pos.z, altar.pos.x, altar.pos.z) < 3 * SIZE) { gap = d; obstacle = { kind: 'building', id: s.id }; }
    }
    for (const p of world.pieces.values()) {
      const at = piecePosition(world, p); if (!at) continue;
      const d = distance(at, b.pos);
      if (d < gap && distToSegment(at.x, at.z, b.pos.x, b.pos.z, altar.pos.x, altar.pos.z) < 3 * SIZE) { gap = d; obstacle = { kind: 'piece', id: p.id }; }
    }
    if (obstacle) return obstacle;
    return { kind: 'building', id: altar.id };
  }
  return nearest;
}

export function updateBoss(world: World, dt: number): void {
  const b = spawnBoss(world);
  if (!b) return;
  if (world.phase !== 'playing') { b.lightning = []; return; }
  updateBossLightning(world, b, dt);
  try { advanceBoss(world, b, dt); } finally { syncBossLightning(world, b); }
}

function advanceBoss(world: World, b: BossState, dt: number): void {
  if (b.hp <= 0) {
    cancelBossEye(b);
    if (b.deathAt === null) { b.deathAt = world.time; action(world, b, 'death'); }
    if (world.time - b.deathAt >= BOSS_DEATH_DURATION) action(world, b, 'dead');
    return;
  }
  const age = world.time - b.actionAt + 1e-9;
  if (b.action === 'emerge') { if (age >= BOSS_TIMING.emerge) action(world, b, 'idle'); return; }
  // A successful pulse owns exactly one second of recovery. Existing eye charge/fire
  // cannot enter this branch through a pulse; retain its priority if state is restored.
  if (b.action === 'recoil' && b.eye.chargeAt === null && b.eye.firedAt === null) {
    if (age >= BOSS_RECOIL_DURATION) action(world, b, 'idle');
    else return;
  }
  // Eye charge/fire is an authoritative interrupt: release any unconsumed grasp,
  // settle in the current stance and stop moving until the frozen beam expires.
  if (updateBossEye(world, b, dt)) return;
  if (b.action === 'crouch' || b.action === 'rise') {
    const at = bossTargetPosition(world, b.target);
    if (at) face(b, at, dt);
    if (age >= BOSS_TIMING.transition) { b.crouched = b.action === 'crouch'; action(world, b, 'idle'); }
    return;
  }
  if (b.action === 'swipe' || b.action === 'stomp' || b.action === 'grab') {
    // Swipe/grab clips stay low through recovery. Repair an older/stale stance
    // bit without restarting the action clock, held target or once-only impact.
    if (b.action === 'swipe' || b.action === 'grab') b.crouched = true;
    const hitAt = b.action === 'swipe' ? BOSS_TIMING.swipeHit : b.action === 'stomp' ? BOSS_TIMING.stompHit : BOSS_TIMING.consume;
    if (b.action === 'grab' && age >= BOSS_TIMING.grasp && age < BOSS_TIMING.consume && !b.held) holdTarget(world, b);
    if (age >= hitAt && b.hitSeq !== b.actionSeq) {
      b.hitSeq = b.actionSeq;
      if (b.action === 'swipe') swipe(world, b);
      else if (b.action === 'stomp') stomp(world, b);
      else consumeTarget(world, b);
    }
    if (age >= BOSS_TIMING[b.action]) {
      if (b.target?.kind === 'avatar' || b.target?.kind === 'hippie') b.opportunisticAfter = world.time + 8;
      b.nextAttackAt = world.time + (b.action === 'swipe' ? .275 : .55); action(world, b, 'idle');
    }
    return;
  }
  // Recovery is part of the attack. Do not briefly turn/rise toward the distant
  // altar only to crouch and turn back to the same body when the cooldown ends.
  if (world.time < b.nextAttackAt) { action(world, b, 'idle'); return; }
  b.target = target(world, b);
  const at = bossTargetPosition(world, b.target);
  if (!at || !b.target) { action(world, b, 'idle'); return; }
  const d = distance(at, b.pos), isUnit = b.target.kind === 'avatar' || b.target.kind === 'hippie';
  const isStructure = b.target.kind === 'building' || b.target.kind === 'piece';
  const isAltar = b.target.kind === 'building' && world.buildings.get(b.target.id)?.kind === 'hearth';
  const onRoute = isAltar && b.target.id === b.objectiveAltarId;
  // One local scenery stomp per size-scaled interval of progress, without changing or
  // chasing away from the altar objective. Ordinary underfoot crushes still apply.
  if (onRoute && !b.crouched && d > BOSS_WEAVE_STRAIGHTEN && b.stride >= b.nextSceneryStompStride) {
    const dx = (at.x - b.pos.x) / d, dz = (at.z - b.pos.z) / d;
    const scenery = world.map.obstacles.find(o => o.kind !== 'effigy' && !world.destroyedScenery.has(o.id) &&
      (o.x - b.pos.x) * dx + (o.z - b.pos.z) * dz >= 0 && footprintDistance(o, b.pos.x, b.pos.z) <= STOMP_RADIUS &&
      !sweepBossLoops(world, b.pos, o, .05));
    if (scenery) { b.nextSceneryStompStride = b.stride + SCENERY_STOMP_INTERVAL; face(b, at, dt); action(world, b, 'stomp'); return; }
  }
  // Bodies and structures under a standing foot can both provoke a stomp. Flags
  // still require the boundary-aware hand action; feet never bypass a forcefield.
  if ((isUnit || isStructure && !isAltar) && d < 4.2 * SIZE && !b.crouched && world.time >= b.nextAttackAt) { face(b, at, dt); action(world, b, 'stomp'); return; }
  const wantCrouch = d < CROUCH_DISTANCE;
  if (wantCrouch !== b.crouched) { face(b, at, dt); action(world, b, wantCrouch ? 'crouch' : 'rise'); return; }
  const reach = isUnit ? SWIPE_REACH : GRAB_REACH;
  if (d <= reach && world.time >= b.nextAttackAt) {
    const facing = face(b, at, dt);
    // A small loop must still protect its altar even when a long hand could reach across
    // from outside. The giant exposes and eats the contacted boundary before reaching in.
    const field = sweepBossLoops(world, b.pos, at, 0.05);
    const eatingThisBoundary = field && b.target.kind === 'flag' && barrierFlags(world, field.edge).some(f => f.id === b.target!.id);
    if (field && !eatingThisBoundary) {
      b.barrier = { edge: field.edge, faction: field.faction, x: field.x, z: field.z, at: world.time };
      const flags = barrierFlags(world, field.edge).sort((a, c) => distance(a.pos, b.pos) - distance(c.pos, b.pos));
      if (flags[0]) b.target = { kind: 'flag', id: flags[0].id };
      action(world, b, 'idle'); return;
    }
    // The attack clip owns yaw until recovery. Start it only after the actual
    // front of the boss faces the target, never eating behind its back or swiping air.
    if (facing > HAND_FACING) { action(world, b, 'idle'); return; }
    // Alternate some close structure encounters into a swipe, rather than making
    // structure damage depend on a conveniently adjacent player. Action sequence
    // is authoritative and replicated, so this choice needs no client RNG.
    const structureSwipe = isStructure && !isAltar && b.actionSeq % 3 === 1;
    action(world, b, isUnit || structureSwipe ? 'swipe' : 'grab'); return;
  }
  if (d <= reach) { action(world, b, 'idle'); return; }
  const speed = b.crouched ? CROUCH_SPEED : WALK_SPEED;
  const len = Math.min(speed * dt, Math.max(0, d - reach + 0.2));
  const lim = MAP_HALF - BOSS_RADIUS;
  const direct = Math.atan2(at.x - b.pos.x, at.z - b.pos.z);
  const weave = onRoute && !b.crouched && d > BOSS_WEAVE_STRAIGHTEN && !b.barrier;
  const side = Math.floor(Math.max(0, b.stride - b.routeStartStride) / BOSS_WEAVE_LEG) % 2 === 0 ? 1 : -1;
  const headingGoal = direct + (weave ? side * BOSS_WEAVE_ANGLE : 0);
  let next = { x: clamp(b.pos.x + Math.sin(headingGoal) * len, -lim, lim), z: clamp(b.pos.z + Math.cos(headingGoal) * len, -lim, lim) };
  // Straighten before a defended boundary rather than letting the decorative weave
  // discover an irrelevant side loop or make progress around a corner oscillate.
  if (weave && sweepBossLoops(world, b.pos, next, BOSS_RADIUS + 1)) {
    next = { x: clamp(b.pos.x + Math.sin(direct) * len, -lim, lim), z: clamp(b.pos.z + Math.cos(direct) * len, -lim, lim) };
  }
  const old = { ...b.pos }, oldYaw = b.yaw, hit = sweepBossLoops(world, old, next);
  let proposed = next;
  if (hit) {
    const t = Math.max(0, hit.fraction - 0.0001);
    proposed = { x: old.x + (next.x - old.x) * t, z: old.z + (next.z - old.z) * t };
    b.barrier = { edge: hit.edge, faction: hit.faction, x: hit.x, z: hit.z, at: world.time };
    // Implied endpoints can be sustained by real flags beyond arm's reach. Follow the
    // outside of the field toward those flags; every alternative is swept too, so corners,
    // nested loops and a topology edit cannot turn steering into a teleport.
    if (b.target.kind === 'flag' && d > GRAB_REACH && hit.fraction < 0.1) {
      const desired = Math.atan2(at.x - proposed.x, at.z - proposed.z);
      let alternative: V2 | null = null, score = Infinity;
      for (let turn = 15; turn <= 150; turn += 15) for (const side of [-1, 1]) {
        const yaw = desired + side * turn * Math.PI / 180;
        const remaining = len * (1 - t);
        const trial = { x: clamp(proposed.x + Math.sin(yaw) * remaining, -lim, lim), z: clamp(proposed.z + Math.cos(yaw) * remaining, -lim, lim) };
        if (sweepBossLoops(world, proposed, trial)) continue;
        const cost = distance(trial, at) + turn * 0.0001;
        if (cost < score) { score = cost; alternative = trial; }
      }
      if (alternative) proposed = alternative;
    }
  } else {
    if (b.barrier && !bossLoopEdges(world).includes(b.barrier.edge)) b.barrier = null;
  }
  // Turn toward the actual safe route (including a boundary detour), not just
  // the unreachable endpoint. Retaliation/expiry cannot make the rig walk backwards.
  const heading = face(b, distance(old, proposed) > 1e-6 ? proposed : at, dt);
  if (heading > WALK_FACING || distance(old, proposed) <= 1e-6) { action(world, b, 'idle'); return; }
  proposed = moveBossWithPlayerCollision(world, b, old, proposed);
  b.pos.x = proposed.x; b.pos.z = proposed.z;
  const traveled = distance(old, b.pos);
  b.stride += traveled;
  action(world, b, b.crouched ? 'crouchWalk' : 'walk');
  if (traveled > 1e-6) crushStep(world, b, old, oldYaw);
}

function holdTarget(world: World, b: BossState): void {
  const t = b.target, pos = bossTargetPosition(world, t);
  if (!t || !pos || distance(pos, b.pos) > GRAB_REACH + 0.5) return;
  if (t.kind !== 'flag' && !attackReaches(world, b, pos)) return;
  let faction: Owner = -1;
  if (t.kind === 'flag') faction = world.flags.get(t.id)?.owner ?? -1;
  else if (t.kind === 'building') faction = world.buildings.get(t.id)?.faction ?? -1;
  else if (t.kind === 'piece') faction = world.pieces.get(t.id)?.faction ?? -1;
  b.held = { ...t, faction, x: pos.x, z: pos.z };
}

function consumeTarget(world: World, b: BossState): void {
  if (!b.held) holdTarget(world, b); // safe when a diagnostic skips directly over the grasp frame
  const t = b.held;
  if (!t) return;
  if (t.kind === 'flag') consumeFlag(world, t.id);
  else if (t.kind === 'piece') { const p = world.pieces.get(t.id); if (p) destroyPiece(world, p); }
  else if (t.kind === 'building') {
    const building = world.buildings.get(t.id);
    if (building) consumeBuilding(world, building);
  }
  // Keep the held cue until the animation finishes swallowing.
}

export function consumeFlag(world: World, id: EntityId): void {
  const before = captureBossBarrierBreak(world, [id]);
  destroyFlag(world, id);
  recordBossBarrierBreak(world, before);
}

export function consumeBuilding(world: World, building: Building, destroyed = false): void {
  if (world.buildings.get(building.id) !== building) return;
  // Altars are consumed only by the eating path, never any destructive impact.
  if (destroyed && building.kind === 'hearth') return;
  for (const f of [...world.flags.values()]) if (f.holder === building.id) consumeFlag(world, f.id);
  if (destroyed) leaveBuildingWreckage(world, building);
  world.buildings.delete(building.id);
  registerBuildingShape(world, building);
  for (const av of world.avatars.values()) if (av.pushing === building.id) av.pushing = -1;
  if (building.faction >= 0) {
    const fac = world.factions[building.faction];
    if (building.kind === 'hearth') {
      fac.hearthIds = fac.hearthIds.filter(id => id !== building.id && world.buildings.has(id));
      if (fac.hearthIds.length === 0) eliminateByBoss(world, fac.id);
      else world.emit({ t: 'notify', faction: fac.id, text: `The giant ${destroyed ? 'destroyed' : 'swallowed'} an altar. Your remaining altars keep your camp alive.`, severity: 'danger' });
    }
    if (fac.gccId === building.id) fac.gccId = null;
  }
  world.emit({ t: 'buildingDisabled', buildingId: building.id, kind: building.kind, faction: building.faction, pos: { ...building.pos }, ...(destroyed ? { bossDestroyed: true as const } : {}) });
}

function inSwipe(b: BossState, p: V2): boolean {
  const dx = p.x - b.pos.x, dz = p.z - b.pos.z, d = Math.hypot(dx, dz);
  return d <= SWIPE_REACH && (d < 2 * SIZE || (dx * Math.sin(b.yaw) + dz * Math.cos(b.yaw)) / d >= -0.25);
}
function launch(world: World, b: BossState, id: number): void {
  const h = world.hippies.get(id), av = world.avatars.get(id), unit = h ?? av;
  if (!unit) return;
  const d = Math.hypot(unit.pos.x - b.pos.x, unit.pos.z - b.pos.z);
  const dx = d > 1e-6 ? (unit.pos.x - b.pos.x) / d : Math.sin(b.yaw);
  const dz = d > 1e-6 ? (unit.pos.z - b.pos.z) / d : Math.cos(b.yaw);
  // Even a knockout gets launched. KO teardown happens before this impulse, so it
  // cannot zero the velocity and leave a fatal swipe's victim stuck under the hand.
  unit.vel.x = dx * 30; unit.vel.z = dz * 30;
  if (h) {
    h.airborne = { y: h.airborne?.y ?? 0, vy: 15 };
    applyEffect(world, h, 'knockback', 2.2, 30, b.id);
  }
  if (av) { av.vel.y = 12; av.onGround = false; applyEffect(world, av, 'knockback', 1.6, 30, b.id); }
}

/** Recheck barriers at impact: a loop completed during the wind-up is already protective. */
function attackReaches(world: World, b: BossState, pos: V2): boolean {
  const hit = sweepBossLoops(world, b.pos, pos, .05);
  if (!hit) return true;
  b.barrier = { edge: hit.edge, faction: hit.faction, x: hit.x, z: hit.z, at: world.time };
  return false;
}
function swipe(world: World, b: BossState): void {
  for (const av of world.avatars.values()) if (!av.koUntil && av.pos.y < groundHeight(b.pos.x, b.pos.z, world.map.half) + HAND_HEIGHT && inSwipe(b, av.pos) && attackReaches(world, b, av.pos)) {
    damageEntity(world, av.id, SWIPE_DAMAGE, b.id); launch(world, b, av.id);
  }
  for (const h of world.hippies.values()) if (h.status !== 'ko' && groundHeight(h.pos.x, h.pos.z, world.map.half) + (h.airborne?.y ?? 0) < groundHeight(b.pos.x, b.pos.z, world.map.half) + HAND_HEIGHT && inSwipe(b, h.pos) && attackReaches(world, b, h.pos)) {
    damageEntity(world, h.id, SWIPE_DAMAGE, b.id); launch(world, b, h.id);
  }
  for (const s of [...world.buildings.values()]) if (inSwipe(b, s.pos) && attackReaches(world, b, s.pos)) {
    // Ordinary building damage disables/rebuilds and floors altar HP at one.
    // A lethal giant swipe removes non-altars and all owned references. Altars must be eaten.
    if (s.kind !== 'hearth' && s.hp <= 110) consumeBuilding(world, s, true);
    else damageEntity(world, s.id, 110, b.id);
  }
  for (const p of [...world.pieces.values()]) { const at = piecePosition(world, p); if (at && inSwipe(b, at) && attackReaches(world, b, at)) damageEntity(world, p.id, 150, b.id); }
}
function stomp(world: World, b: BossState): void {
  footImpact(world, b, b.pos, STOMP_RADIUS, true);
}
function footImpact(world: World, b: BossState, at: V2, radius: number, heavy: boolean): void {
  world.emit({ t: 'bossFootfall', bossId: b.id, pos: { ...at }, heavy });
  for (const av of world.avatars.values()) if (!av.koUntil && av.pos.y < groundHeight(at.x, at.z, world.map.half) + 2.8 * SIZE && distance(av.pos, at) <= radius && attackReaches(world, b, av.pos)) damageEntity(world, av.id, STOMP_DAMAGE, b.id);
  for (const h of world.hippies.values()) if (h.status !== 'ko' && groundHeight(h.pos.x, h.pos.z, world.map.half) + (h.airborne?.y ?? 0) < groundHeight(at.x, at.z, world.map.half) + 2.8 * SIZE && distance(h.pos, at) <= radius && attackReaches(world, b, h.pos)) damageEntity(world, h.id, STOMP_DAMAGE, b.id);
  crushObjects(world, b, at, radius, heavy);
}
function crushObjects(world: World, b: BossState, at: V2, radius: number, heavy: boolean): void {
  crushScenery(world, at, at, radius, obstacle => attackReaches(world, b, obstacle), heavy ? Infinity : BOSS_FOOTFALL_PROP_SPAN);
  for (const s of [...world.buildings.values()]) if (distance(s.pos, at) < radius + BUILDINGS[s.kind].radius && attackReaches(world, b, s.pos)) {
    if (s.kind === 'hearth') damageEntity(world, s.id, 250, b.id);
    else consumeBuilding(world, s, true);
  }
  for (const p of [...world.pieces.values()]) { const pos = piecePosition(world, p); if (pos && distance(pos, at) < radius + 1.5 && attackReaches(world, b, pos)) destroyPiece(world, p, true); }
  // Boundary flags are dismantled by the grab/eat action; foot impacts cannot bypass a field.
  const protectedIds = new Set<number>();
  for (const edge of bossLoopEdges(world)) for (const f of barrierFlags(world, edge)) protectedIds.add(f.id);
  for (const f of [...world.flags.values()]) if ((f.state === 'planted' || f.state === 'loose') && !protectedIds.has(f.id) && distance(f.pos, at) <= radius) consumeFlag(world, f.id);
}
function crushStep(world: World, b: BossState, from: V2, oldYaw: number): void {
  const traveled = distance(from, b.pos), gait = b.crouched ? 'crouchWalk' : 'walk';
  for (const contact of bossFootContacts(gait, b.stride - traveled, b.stride)) {
    const t = contact.fraction, yaw = oldYaw + angleDiff(oldYaw, b.yaw) * t;
    const c = Math.cos(yaw), s = Math.sin(yaw), p = contact.local;
    const at = { x: from.x + (b.pos.x - from.x) * t + p.x * c + p.z * s,
      z: from.z + (b.pos.z - from.z) * t - p.x * s + p.z * c };
    footImpact(world, b, at, BOSS_FOOTFALL_RADIUS, false);
  }
}
