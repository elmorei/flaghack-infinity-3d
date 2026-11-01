import { buildingBaseHeight } from '../../buildingGeometry';
/** Strategic eye targets are independent of the giant's close-range hands and altar route. */
import { BOSS_EYE_BLAST_RADIUS, BOSS_EYE_MAX_RANGE, BOSS_RADIUS } from '../../boss';
import type { BossState } from '../../boss';
import { BOSS_GAMEPLAY_SCALE } from '../../bossDimensions';
import { AVATAR, BUILDINGS, BUILDING_HEIGHT, HIPPIE, LEVEL_HEIGHT } from '../../constants';
import { groundHeight } from '../../terrain';
import type { V3 } from '../../math';
import { footprintDistance } from '../../map/mapgen';
import type { World } from '../../world';
import { pieceBottom, pieceGroundHeight } from '../econ/pieceGeometry';
import { piecePosition } from '../pieces';
import { pieceClosest } from '../units/reach';
import { crystalFlagTargets } from './crystalTargets';
import { sampleBossHeadPose } from './hitRegions';
import { solveBossEyeAim } from '../../bossEyeRig';
import type { BossEyeQuaternion } from '../../bossEyeRig';
import { bossSceneryBrightness } from './sceneryBrightness';
import { BOSS_FLAG_THREAT_SECONDS, recentBossFlagThreats } from './eyeThreats';

/** Keep the entire five-meter blast beyond the giant's footprint, plus a half-meter margin. */
export const BOSS_EYE_MIN_TARGET_DISTANCE = BOSS_RADIUS + BOSS_EYE_BLAST_RADIUS + .5;
export const BOSS_EYE_MIN_GROUP = 3;
/** Crowd variants are approximately human height; no renderer imports in simulation. */
export const BOSS_EYE_HIPPIE_HEIGHT = 1.8;
const RETRY_SECONDS = .5;
const ORIGIN_ENVELOPE = 24 * BOSS_GAMEPLAY_SCALE;
interface Unit { id: number; x: number; z: number; y: number; height: number; radius: number; aim: V3; threat: number; }
const radius2 = BOSS_EYE_BLAST_RADIUS ** 2;
function bodyInside(at: V3, x: number, z: number, y: number, top: number, radius: number): boolean {
  // Conservative bounds only: retain the exact sphere test and its epsilon below.
  const reach = radius + BOSS_EYE_BLAST_RADIUS + 1e-9;
  if (Math.abs(at.x - x) > reach || Math.abs(at.z - z) > reach ||
      at.y < y - BOSS_EYE_BLAST_RADIUS - 1e-9 || at.y > top + BOSS_EYE_BLAST_RADIUS + 1e-9) return false;
  const horizontal = Math.max(0, Math.hypot(at.x - x, at.z - z) - radius);
  const vertical = Math.max(y - at.y, 0, at.y - top);
  return horizontal ** 2 + vertical ** 2 <= radius2 + 1e-9;
}

/** Deterministic utility: each actual blast victim +2, each live non-altar building +7,
 * each build piece +4, and each recent Flag attacker +12 fading to +6 over 12s.
 * A lone ordinary unit (or a pair) is never enough to spend the weapon. */
interface RatedTarget { at: V3; score: number; distance: number; brightness: number; supports: number[]; }
function rankedBossEyeTargets(world: World, boss: BossState): RatedTarget[] {
  const threats = recentBossFlagThreats(world), units: Unit[] = [], candidates: V3[] = [];
  const farEnough = (x: number, z: number) => Math.hypot(x - boss.pos.x, z - boss.pos.z) >= BOSS_EYE_MIN_TARGET_DISTANCE;
  const unit = (id: number, x: number, z: number, y: number, height: number, radius: number, threat = 0) => {
    // Nearby bodies belong to the hand/stomp attacks, even if a crowd gathers at the feet.
    if (!farEnough(x, z)) return;
    const aim = { x, y: world.collision.supportHeight(x, z, y + .01), z };
    units.push({ id, x, z, y, height, radius, aim, threat }); candidates.push(aim);
  };
  for (const avatar of world.avatars.values()) if (avatar.hp > 0 && !avatar.koUntil && world.factions[avatar.faction].alive) {
    const at = threats.get(avatar.id), threat = at === undefined ? 0 : 12 - 6 * (world.time - at) / BOSS_FLAG_THREAT_SECONDS;
    unit(avatar.id, avatar.pos.x, avatar.pos.z, avatar.pos.y, AVATAR.height, AVATAR.radius, threat);
  }
  for (const hippie of world.hippies.values()) if (hippie.hp > 0 && hippie.status !== 'ko' &&
      (hippie.faction < 0 || world.factions[hippie.faction].alive)) {
    unit(hippie.id, hippie.pos.x, hippie.pos.z, groundHeight(hippie.pos.x, hippie.pos.z, world.map.half) + (hippie.airborne?.y ?? 0), BOSS_EYE_HIPPIE_HEIGHT, HIPPIE.radius);
  }
  // Include neighborhood centers so a real group spread around a five-meter circle
  // needn't have a unit standing exactly in its middle. Score only the bodies inside.
  for (const anchor of units) {
    const neighbors = units.filter(u =>
      Math.abs(u.x - anchor.x) <= BOSS_EYE_BLAST_RADIUS * 2 &&
      Math.abs(u.z - anchor.z) <= BOSS_EYE_BLAST_RADIUS * 2 &&
      Math.abs(u.aim.y - anchor.aim.y) <= BOSS_EYE_BLAST_RADIUS * 2 &&
      Math.hypot(u.x - anchor.x, u.z - anchor.z, u.aim.y - anchor.aim.y) <= BOSS_EYE_BLAST_RADIUS * 2);
    if (neighbors.length < BOSS_EYE_MIN_GROUP) continue;
    const point = neighbors.reduce((sum, u) => ({ x: sum.x + u.x, y: sum.y + u.aim.y, z: sum.z + u.z }), { x: 0, y: 0, z: 0 });
    point.x /= neighbors.length; point.y /= neighbors.length; point.z /= neighbors.length;
    point.y = world.collision.supportHeight(point.x, point.z, point.y + .01);
    candidates.push(point);
  }
  const buildings = [...world.buildings.values()].filter(b => b.kind !== 'hearth' && b.hp > 0);
  for (const b of buildings) candidates.push({ x: b.pos.x, y: buildingBaseHeight(world, b) + BUILDING_HEIGHT[b.kind] / 2, z: b.pos.z });
  const pieces = [...world.pieces.values()].filter(p => p.hp > 0);
  for (const p of pieces) { const at = piecePosition(world, p); if (at) candidates.push({ ...at }); }
  const crystalTargets = crystalFlagTargets(world, boss), crystalAims = new Map(crystalTargets.map(t => [t.at, t.supports]));
  candidates.push(...crystalAims.keys());
  const bright = world.map.obstacles.filter(o => !world.destroyedScenery.has(o.id) && bossSceneryBrightness(o) > 0);
  for (const o of bright) candidates.push({ x: o.x, y: groundHeight(o.x, o.z, world.map.half) + o.height / 2, z: o.z });
  const ranked: RatedTarget[] = [];
  const reach = { x: 0, z: 0, dist: 0 };
  for (const at of candidates) {
    const distance = Math.hypot(at.x - boss.pos.x, at.z - boss.pos.z);
    // Scale the pupil envelope with the giant (38.4 m at 32 m tall), never the 240 m ray limit.
    const supports = crystalAims.get(at) ?? [], crystal = supports.length > 0;
    // Crystal retaliation uses the exact future-idle pupil range, avoiding the ordinary
    // conservative origin envelope that would unnecessarily exclude a distant giant.
    if (crystal) {
      if (crystalAimDistance(world, boss, at) > BOSS_EYE_MAX_RANGE) continue;
    } else if (!farEnough(at.x, at.z) || Math.hypot(distance, at.y - groundHeight(boss.pos.x, boss.pos.z, world.map.half)) > BOSS_EYE_MAX_RANGE - ORIGIN_ENVELOPE) continue;
    let count = 0, aggression = 0, structure = 0;
    for (const u of units) if (bodyInside(at, u.x, u.z, u.y, u.y + u.height, u.radius)) { count++; aggression += u.threat; }
    for (const b of buildings) if (bodyInside(at, b.pos.x, b.pos.z, buildingBaseHeight(world, b), buildingBaseHeight(world, b) + BUILDING_HEIGHT[b.kind], BUILDINGS[b.kind].radius)) structure += 7;
    for (const p of pieces) {
      pieceClosest(world, p, at.x, at.z, reach);
      const ground = pieceGroundHeight(world, p);
      const dy = Math.max(ground + pieceBottom(p.kind, p.level) - at.y, 0, at.y - ground - (p.level + 1) * LEVEL_HEIGHT);
      if (reach.dist ** 2 + dy ** 2 <= radius2 + 1e-9) structure += 4;
    }
    let brightness = crystal ? 4 : 0;
    for (const o of bright) {
      const horizontal = footprintDistance(o, at.x, at.z), vertical = Math.max(groundHeight(o.x, o.z, world.map.half) - at.y, 0, at.y - groundHeight(o.x, o.z, world.map.half) - o.height);
      if (horizontal ** 2 + vertical ** 2 <= radius2 + 1e-9) brightness = Math.max(brightness, bossSceneryBrightness(o));
    }
    if (count < BOSS_EYE_MIN_GROUP && !aggression && !structure && !brightness) continue;
    const score = 2 * count + aggression + structure;
    ranked.push({ at, score, distance, brightness, supports });
  }
  return ranked.sort((a, b) => b.brightness - a.brightness || b.supports.length - a.supports.length || b.score - a.score || a.distance - b.distance ||
    a.at.x - b.at.x || a.at.z - b.at.z || a.at.y - b.at.y);
}

/** Rainbow installations outrank other bright scenery, then ordinary crowd/structure utility. */
export function chooseBossEyeTarget(world: World, boss: BossState): V3 | null {
  const retry = world.scratch.bossEyeRetry as { bossId: number; at: number } | undefined;
  if (retry?.bossId === boss.id && world.time < retry.at) return null;
  const best = rankedBossEyeTargets(world, boss)[0]?.at ?? null;
  if (!best) world.scratch.bossEyeRetry = { bossId: boss.id, at: world.time + RETRY_SECONDS };
  else delete world.scratch.bossEyeRetry;
  return best ? { ...best } : null;
}

/** Up to five distinct useful blast centers make a finite, deterministic five-second sweep.
 * Nearby candidate duplicates never waste the route on the same crowd/installation. */
export function planBossEyeSweep(world: World, boss: BossState, first: V3): V3[] {
  const route = [{ ...first }], candidates = rankedBossEyeTargets(world, boss);
  const covered = new Set(candidates.find(c => c.at.x === first.x && c.at.y === first.y && c.at.z === first.z)?.supports ?? []);
  const newSupports = (c: RatedTarget) => c.supports.reduce((n, id) => n + (covered.has(id) ? 0 : 1), 0);
  while (route.length < 5) {
    const last = route[route.length - 1];
    const remaining = candidates.filter(c => c.supports.length ? newSupports(c) > 0 :
      route.every(p => Math.hypot(c.at.x - p.x, c.at.y - p.y, c.at.z - p.z) >= BOSS_EYE_BLAST_RADIUS * 1.6));
    remaining.sort((a, b) => b.brightness - a.brightness || newSupports(b) - newSupports(a) ||
      (b.score / (1 + Math.hypot(b.at.x - last.x, b.at.y - last.y, b.at.z - last.z) / 40)) -
      (a.score / (1 + Math.hypot(a.at.x - last.x, a.at.y - last.y, a.at.z - last.z) / 40)) ||
      Math.hypot(a.at.x - last.x, a.at.y - last.y, a.at.z - last.z) - Math.hypot(b.at.x - last.x, b.at.y - last.y, b.at.z - last.z) ||
      a.at.x - b.at.x || a.at.z - b.at.z || a.at.y - b.at.y);
    if (!remaining.length) break;
    route.push({ ...remaining[0].at });
    for (const id of remaining[0].supports) covered.add(id);
  }
  return route;
}

function crystalAimDistance(world: World, boss: BossState, target: V3): number {
  const head = sampleBossHeadPose({ ...boss, action: 'idle', actionAt: boss.spawnedAt }, boss.spawnedAt);
  const c = Math.cos(boss.yaw), s = Math.sin(boss.yaw), sy = Math.sin(boss.yaw / 2), cy = Math.cos(boss.yaw / 2), q = head.quaternion;
  const position = { x: boss.pos.x + c * head.position.x + s * head.position.z, y: groundHeight(boss.pos.x, boss.pos.z, world.map.half) + head.position.y,
    z: boss.pos.z - s * head.position.x + c * head.position.z };
  const rotation: BossEyeQuaternion = [cy * q[0] + sy * q[2], cy * q[1] + sy * q[3], cy * q[2] - sy * q[0], cy * q[3] - sy * q[1]];
  const ray = solveBossEyeAim(position, rotation, target);
  return Math.hypot(target.x - ray.origin.x, target.y - ray.origin.y, target.z - ray.origin.z);
}
