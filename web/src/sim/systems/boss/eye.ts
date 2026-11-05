import { buildingBaseHeight, isIndestructibleBuilding } from '../../buildingGeometry';
/** Fixed-clock charge and a five-second gaze sweep. Mirrors only render the facts. */
import { BOSS_EYE_BLAST_RADIUS, BOSS_EYE_DAMAGE, BOSS_EYE_MAX_RANGE, BOSS_EYE_TIMING, clearBossEyeCharge } from '../../boss';
import type { BossState } from '../../boss';
import { solveBossEyeAim } from '../../bossEyeRig';
import type { BossEyeQuaternion, BossEyeRay } from '../../bossEyeRig';
import { AVATAR, BUILDING_HEIGHT, BUILDINGS, HIPPIE, LEVEL_HEIGHT } from '../../constants';
import { angleDiff, clamp } from '../../math';
import { groundHeight } from '../../terrain';
import type { V3 } from '../../math';
import type { Flag } from '../../types';
import type { World } from '../../world';
import { consumeBuilding } from '../boss';
import { damageEntity } from '../combat';
import { pieceBottom, pieceGroundHeight } from '../econ/pieceGeometry';
import { dropLoose } from '../flags';
import { destroySceneryBlast } from '../scenery';
import { captureBossBarrierBreak, recordBossBarrierBreak } from './barrierBreaks';
import { segmentPointDistanceSquared, sweptBodyDistanceSquared } from './blastGeometry';
import { updateSurvey } from '../survey';
import { brainOf, releaseTask } from '../units/brain';
import { breakChannel } from '../units/channel';
import { pieceClosest } from '../units/reach';
import { sampleBossHeadPose } from './hitRegions';
import { BOSS_EYE_HIPPIE_HEIGHT, chooseBossEyeTarget, planBossEyeSweep } from './eyeTargeting';
export { BOSS_EYE_HIPPIE_HEIGHT } from './eyeTargeting';

export const cancelBossEye = clearBossEyeCharge;
/** Exact actual pupil ray from the zero-breath idle head sample and shared offset-aware aim. */
export function bossEyeRay(world: World, boss: BossState): BossEyeRay {
  const head = sampleBossHeadPose(boss, boss.spawnedAt), c = Math.cos(boss.yaw), s = Math.sin(boss.yaw);
  const position = { x: boss.pos.x + c * head.position.x + s * head.position.z, y: groundHeight(boss.pos.x, boss.pos.z, world.map.half) + head.position.y,
    z: boss.pos.z - s * head.position.x + c * head.position.z };
  const half = boss.yaw / 2, sy = Math.sin(half), cy = Math.cos(half), q = head.quaternion;
  const rotation: BossEyeQuaternion = [cy * q[0] + sy * q[2], cy * q[1] + sy * q[3], cy * q[2] - sy * q[0], cy * q[3] - sy * q[1]];
  const target = boss.eye.target ?? { x: position.x + s * 50, y: groundHeight(position.x + s * 50, position.z + c * 50, world.map.half), z: position.z + c * 50 };
  return solveBossEyeAim(position, rotation, target);
}

/** Fixed 60 Hz attack samples, independent of render frames or the caller's step size. */
export const BOSS_EYE_SAMPLE_HZ = 60;
export function bossEyeSweepTarget(boss: BossState, progress: number): V3 {
  const route = boss.eye.route.length ? boss.eye.route : [boss.eye.target!];
  let length = 0;
  for (let i = 1; i < route.length; i++) length += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y, route[i].z - route[i - 1].z);
  let remaining = clamp(progress, 0, 1) * length;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (remaining <= distance && distance > 0) {
      const t = remaining / distance;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
    remaining -= distance;
  }
  return { ...route[route.length - 1] };
}

function fireSample(world: World, boss: BossState, index: number): void {
  const eye = boss.eye;
  eye.target = bossEyeSweepTarget(boss, index / (BOSS_EYE_SAMPLE_HZ * BOSS_EYE_TIMING.beam));
  const yaw = Math.atan2(eye.target.x - boss.pos.x, eye.target.z - boss.pos.z);
  if (index > 0) boss.yaw += clamp(angleDiff(boss.yaw, yaw), -1.2 / BOSS_EYE_SAMPLE_HZ, 1.2 / BOSS_EYE_SAMPLE_HZ);
  const ray = bossEyeRay(world, boss), previous = eye.impact, previousTag = eye.impactTag;
  const hit = world.collision.raycast(ray.origin.x, ray.origin.y, ray.origin.z,
    ray.direction.x, ray.direction.y, ray.direction.z, BOSS_EYE_MAX_RANGE, boss.id);
  eye.origin = ray.origin; eye.direction = ray.direction;
  eye.impact = hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
  eye.impactTag = hit?.tag ?? null; eye.sample = index;
  if (!eye.impact) return;
  // A removed foreground prop can expose a distant surface. Do not burn a corridor
  // between those disconnected impacts; only continuous contact sweeps a sphere.
  const from = previous && previousTag === eye.impactTag &&
    Math.hypot(previous.x - eye.impact.x, previous.y - eye.impact.y, previous.z - eye.impact.z) <= 6 ? previous : null;
  blastBossEye(world, boss, eye.impact, from);
}

/** True while the eye owns the boss's action/movement slot. No render callback advances it. */
export function updateBossEye(world: World, boss: BossState, dt: number): boolean {
  if (boss.hp <= 0 || world.phase !== 'playing' || world.effigyRevealedAt === null) { cancelBossEye(boss); return false; }
  const eye = boss.eye;
  if (eye.firedAt !== null) {
    const end = eye.firedAt + BOSS_EYE_TIMING.beam;
    // A normal long simulation step catches every contact. A clock reset/jump well
    // past the complete firing window never replays an obsolete attack on new actors.
    if (world.time <= end + BOSS_EYE_TIMING.beam) {
      const sample = Math.min(BOSS_EYE_SAMPLE_HZ * BOSS_EYE_TIMING.beam,
        Math.floor((world.time - eye.firedAt + 1e-9) * BOSS_EYE_SAMPLE_HZ));
      for (let i = eye.sample + 1; i <= sample; i++) fireSample(world, boss, i);
    }
    if (world.time < end - 1e-9) return true;
    cancelBossEye(boss);
    boss.nextAttackAt = Math.max(boss.nextAttackAt, world.time + .25);
    return false;
  }
  if (eye.chargeAt === null) {
    if (world.time < eye.nextFireAt - BOSS_EYE_TIMING.charge - 1e-9 ||
        boss.action === 'emerge' || boss.action === 'crouch' || boss.action === 'rise' || boss.action === 'death' || boss.action === 'dead') return false;
    const target = chooseBossEyeTarget(world, boss);
    if (!target) return false;
    eye.chargeAt = world.time; eye.nextFireAt = world.time + BOSS_EYE_TIMING.charge; eye.target = target;
    eye.route = planBossEyeSweep(world, boss, target); eye.sample = -1; eye.damaged = []; eye.knockedFlags = [];
    eye.origin = null; eye.direction = null; eye.impact = null; eye.impactTag = null;
    boss.action = 'idle'; boss.actionAt = world.time; boss.actionSeq++; boss.held = null;
  }
  const target = eye.target!;
  const yaw = Math.atan2(target.x - boss.pos.x, target.z - boss.pos.z);
  boss.yaw += clamp(angleDiff(boss.yaw, yaw), -2.4 * dt, 2.4 * dt);
  if (world.time < eye.nextFireAt - 1e-9) return true;
  eye.firedAt = world.time; eye.nextFireAt = world.time + BOSS_EYE_TIMING.period;
  fireSample(world, boss, 0);
  return true;
}

const radius2 = BOSS_EYE_BLAST_RADIUS ** 2;
function pointInside(at: V3, p: V3, from: V3 | null): boolean {
  return segmentPointDistanceSquared(from, at, p) <= radius2 + 1e-9;
}
function bodyInside(at: V3, x: number, z: number, y0: number, y1: number, radius: number, from: V3 | null): boolean {
  const first = from ?? at, reach = radius + BOSS_EYE_BLAST_RADIUS;
  if (x < Math.min(first.x, at.x) - reach || x > Math.max(first.x, at.x) + reach ||
      z < Math.min(first.z, at.z) - reach || z > Math.max(first.z, at.z) + reach ||
      y1 < Math.min(first.y, at.y) - BOSS_EYE_BLAST_RADIUS || y0 > Math.max(first.y, at.y) + BOSS_EYE_BLAST_RADIUS) return false;
  return sweptBodyDistanceSquared(from, at, (px, py, pz) => {
    const horizontal = Math.max(0, Math.hypot(px - x, pz - z) - radius), vertical = Math.max(y0 - py, 0, py - y1);
    return horizontal ** 2 + vertical ** 2;
  }) <= radius2 + 1e-9;
}
/** Return the affected representation, rather than a stale stored flag position. */
function flagInside(world: World, at: V3, flag: Flag, from: V3 | null): V3 | null {
  let pos: V3 = flag.pos;
  if (flag.state === 'stock') {
    const building = world.buildings.get(flag.holder);
    if (building) pos = { ...building.pos, y: buildingBaseHeight(world, building) };
  } else if (flag.state === 'carried') {
    const avatar = world.avatars.get(flag.holder), hippie = world.hippies.get(flag.holder);
    if (avatar) pos = avatar.pos;
    else if (hippie) pos = { ...hippie.pos, y: groundHeight(hippie.pos.x, hippie.pos.z, world.map.half) + (hippie.airborne?.y ?? 0) };
  } else if (flag.state === 'flying') {
    for (const projectile of world.projectiles.values()) if (projectile.flagId === flag.id) { pos = projectile.pos; break; }
  }
  if (pointInside(at, pos, from)) return { ...pos };
  if (flag.state !== 'planted' || flag.altNode < 0) return null;
  const twin = world.lattice.nodes[flag.altNode];
  const y = twin ? groundHeight(twin.x, twin.z, world.map.half) : 0;
  return twin && pointInside(at, { ...twin, y }, from) ? { x: twin.x, y, z: twin.z } : null;
}

/** One impact sphere (or continuous surface sweep). Each actor takes 1,000 once per beam;
 * flags fall recoverably and every intersecting static prop may shatter. */
export function blastBossEye(world: World, boss: BossState, at: V3, from: V3 | null = null): void {
  const active = boss.eye.firedAt !== null;
  const damaged = new Set(active ? boss.eye.damaged : []), knocked = new Set(active ? boss.eye.knockedFlags : []);
  // Capture contents before KO scatter or structure removal changes their positions.
  const hitFlags = new Map<number, V3>();
  for (const flag of world.flags.values()) { if (knocked.has(flag.id)) continue; const pos = flagInside(world, at, flag, from); if (pos) hitFlags.set(flag.id, pos); }
  const buildings = [...world.buildings.values()].filter(b => !isIndestructibleBuilding(b) && b.hp > 0 && !damaged.has(b.id) && bodyInside(at, b.pos.x, b.pos.z, buildingBaseHeight(world, b), buildingBaseHeight(world, b) + BUILDING_HEIGHT[b.kind], BUILDINGS[b.kind].radius, from));
  // A destroyed storage structure spills recoverable Flags as well. Detach before
  // consumeBuilding's ordinary eating lifecycle would remove the held contents.
  for (const b of buildings) if (b.kind !== 'hearth' && b.hp <= BOSS_EYE_DAMAGE) {
    for (const flag of world.flags.values()) if (flag.holder === b.id) hitFlags.set(flag.id, { ...b.pos, y: buildingBaseHeight(world, b) });
  }
  const brokenBarriers = captureBossBarrierBreak(world, hitFlags.keys(), boss);
  for (const [id, pos] of hitFlags) { dropLoose(world, id, pos); knocked.add(id); }
  recordBossBarrierBreak(world, brokenBarriers);
  for (const projectile of [...world.projectiles.values()]) if (hitFlags.has(projectile.flagId)) world.projectiles.delete(projectile.id);
  for (const avatar of world.avatars.values()) if (avatar.action.kind === 'pull' && hitFlags.has(avatar.action.flagId)) breakChannel(world, avatar);
  for (const hippie of world.hippies.values()) {
    const brain = brainOf(hippie);
    if (hitFlags.has(brain.flag)) {
      releaseTask(world, hippie, brain);
      if (hippie.status !== 'ko') { hippie.status = 'idle'; hippie.statusTarget = null; }
    }
    if (hippie.order?.kind === 'pull' && hitFlags.has(hippie.order.flagId) || hippie.order?.kind === 'attack' && hitFlags.has(hippie.order.target)) hippie.order = null;
  }
  for (const a of world.avatars.values()) if (!a.koUntil && !damaged.has(a.id) && bodyInside(at, a.pos.x, a.pos.z, a.pos.y, a.pos.y + AVATAR.height, AVATAR.radius, from)) {
    damaged.add(a.id);
    damageEntity(world, a.id, BOSS_EYE_DAMAGE, boss.id);
  }
  for (const h of world.hippies.values()) {
    const y = groundHeight(h.pos.x, h.pos.z, world.map.half) + (h.airborne?.y ?? 0);
    if (h.status !== 'ko' && !damaged.has(h.id) && bodyInside(at, h.pos.x, h.pos.z, y, y + BOSS_EYE_HIPPIE_HEIGHT, HIPPIE.radius, from)) { damaged.add(h.id); damageEntity(world, h.id, BOSS_EYE_DAMAGE, boss.id); }
  }
  for (const building of buildings) {
    damaged.add(building.id);
    // Altars can only be eaten: beam damage keeps their ordinary 1 HP floor.
    // Other buildings are permanently removed only when this 1,000-damage hit is lethal.
    building.hp = Math.max(building.kind === 'hearth' ? 1 : 0, building.hp - BOSS_EYE_DAMAGE);
    world.emit({ t: 'hit', target: building.id, by: boss.id, amount: BOSS_EYE_DAMAGE,
      pos: { ...building.pos, y: buildingBaseHeight(world, building) + BUILDING_HEIGHT[building.kind] / 2 } });
    if (building.hp <= 0) consumeBuilding(world, building, true);
  }
  const reach = { x: 0, z: 0, dist: 0 };
  for (const piece of [...world.pieces.values()]) {
    if (damaged.has(piece.id)) continue;
    const distance = sweptBodyDistanceSquared(from, at, (x, y, z) => {
      pieceClosest(world, piece, x, z, reach);
      const ground = pieceGroundHeight(world, piece);
      const dy = Math.max(ground + pieceBottom(piece.kind, piece.level) - y, 0, y - ground - (piece.level + 1) * LEVEL_HEIGHT);
      return reach.dist ** 2 + dy ** 2;
    });
    if (distance <= radius2 + 1e-9) { damaged.add(piece.id); damageEntity(world, piece.id, BOSS_EYE_DAMAGE, boss.id); }
  }
  destroySceneryBlast(world, at, BOSS_EYE_BLAST_RADIUS, from);
  if (active) { boss.eye.damaged = [...damaged]; boss.eye.knockedFlags = [...knocked]; }
  // Re-ground after destroyed decks/buildings retire their collision shapes.
  for (const id of hitFlags.keys()) {
    const flag = world.flags.get(id);
    if (flag) flag.pos.y = world.collision.supportHeight(flag.pos.x, flag.pos.z, flag.pos.y + .1);
  }
  // The boss runs after Survey in a normal tick. Refresh broken loops now so
  // mirrors and the following Crystal system see the changed topology immediately.
  if (world.survey.dirty) updateSurvey(world, 0);
  // Piles have no HP. Crystals follow their normal sustaining-pentacle lifecycle.
}
