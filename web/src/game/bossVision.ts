import { buildingBaseHeight } from '../sim/buildingGeometry';
/** Acid reads committed encounter facts. Never select targets, draw RNG, or mutate the sim. */
import { BOSS_EYE_MAX_RANGE, BOSS_EYE_TIMING } from '../sim/boss';
import type { BossTarget } from '../sim/boss';
import { AVATAR, BUILDINGS, BUILDING_HEIGHT, LEVEL_HEIGHT } from '../sim/constants';
import { bossRevealEnabled } from '../sim/effigyBurn';
import type { V3 } from '../sim/math';
import { bossFocusAltar, bossTargetPosition } from '../sim/systems/boss';
import { pieceGroundHeight } from '../sim/systems/econ/pieceGeometry';
import { groundHeight } from '../sim/terrain';
import type { Owner } from '../sim/types';
import type { World } from '../sim/world';
import type { Session } from './session';

export interface BossVisionTarget extends BossTarget {
  at: V3;
  radius: number;
  height: number;
  faction: Owner;
  name: string;
}
export interface BossVision {
  seconds: number;
  objective: BossVisionTarget | null;
  tactical: BossVisionTarget | null;
  eye: null | {
    phase: 'charging' | 'firing';
    /** Ordered intended aim points, NOT a prediction of unobstructed damage/impacts. */
    route: readonly V3[];
    /** Host ray and first collision (if any). No client raycasting or extrapolation. */
    ray: { from: V3; to: V3; impact: V3 | null } | null;
  };
}
type Viewer = Pick<Session, 'playerFaction' | 'spectator' | 'screen'>;

function resolveTarget(world: World, target: BossTarget | null): BossVisionTarget | null {
  const pos = bossTargetPosition(world, target);
  if (!target || !pos) return null;
  const base = groundHeight(pos.x, pos.z, world.map.half);
  const out: BossVisionTarget = { ...target, at: { x: pos.x, y: base, z: pos.z }, radius: 1, height: 2, faction: -1, name: 'Flag' };
  if (target.kind === 'building') {
    const b = world.buildings.get(target.id)!;
    out.at.y = buildingBaseHeight(world, b);
    out.radius = BUILDINGS[b.kind].radius; out.height = BUILDING_HEIGHT[b.kind]; out.faction = b.faction;
    out.name = { hearth: 'Altar', gcc: 'GCC', workshop: 'Workshop', drumcircle: 'Drum Circle', ward: 'Ward', druglab: 'Drug Lab' }[b.kind];
  } else if (target.kind === 'avatar') {
    const a = world.avatars.get(target.id)!;
    out.at.y = a.pos.y; out.height = AVATAR.height; out.faction = a.faction; out.name = 'Vexillomancer';
  } else if (target.kind === 'hippie') {
    const h = world.hippies.get(target.id)!;
    out.at.y += h.airborne?.y ?? 0; out.faction = h.faction; out.name = 'Signifier';
  } else if (target.kind === 'piece') {
    const p = world.pieces.get(target.id)!;
    out.at.y = pieceGroundHeight(world, p) + p.level * LEVEL_HEIGHT;
    out.height = LEVEL_HEIGHT; out.radius = 2; out.faction = p.faction;
    out.name = { wall: 'Wall', floor: 'Deck', ramp: 'Ramp' }[p.kind];
  } else {
    const f = world.flags.get(target.id)!;
    out.at.y = f.pos.y; out.faction = f.owner;
  }
  return out;
}

/** Strict, uneased gate shared by world markers and the HUD. A temporary KO does not
 * cancel faction-wide drugs; eliminated camps and seatless spectators never inherit them. */
export function bossVision(world: World | null, viewer: Viewer): BossVision | null {
  if (!world || viewer.screen !== 'playing' || viewer.spectator || world.phase !== 'playing' ||
      !world.options.humans.includes(viewer.playerFaction) ||
      !bossRevealEnabled(world.options) || world.effigyRevealedAt === null || world.time < world.effigyRevealedAt) return null;
  const faction = world.factions[viewer.playerFaction], boss = world.boss;
  if (!faction?.alive || !(faction.drugActive.acidcop > world.time) || !boss || boss.hp <= 0 ||
      boss.deathAt !== null || boss.action === 'death' || boss.action === 'dead' || world.time < boss.spawnedAt) return null;
  const objective = bossFocusAltar(world);
  const result: BossVision = {
    seconds: faction.drugActive.acidcop - world.time,
    objective: resolveTarget(world, objective ? { kind: 'building', id: objective.id } : null),
    tactical: resolveTarget(world, boss.target),
    eye: null,
  };
  const eye = boss.eye;
  // A retained route alone is not a commitment. Validate both timestamps so stale
  // snapshots, reset clocks and interrupted attacks never become future predictions.
  if (eye.chargeAt === null || eye.chargeAt < boss.spawnedAt || world.time < eye.chargeAt) return result;
  const firing = eye.firedAt !== null && eye.firedAt >= eye.chargeAt && world.time >= eye.firedAt && world.time < eye.firedAt + BOSS_EYE_TIMING.beam;
  const charging = eye.firedAt === null && world.time < eye.chargeAt + BOSS_EYE_TIMING.charge;
  if (!charging && !firing) return result;
  result.eye = { phase: firing ? 'firing' : 'charging', route: eye.route, ray: null };
  if (firing && eye.origin && eye.direction) {
    result.eye.ray = { from: eye.origin, impact: eye.impact, to: eye.impact ?? {
      x: eye.origin.x + eye.direction.x * BOSS_EYE_MAX_RANGE,
      y: eye.origin.y + eye.direction.y * BOSS_EYE_MAX_RANGE,
      z: eye.origin.z + eye.direction.z * BOSS_EYE_MAX_RANGE,
    } };
  }
  return result;
}
