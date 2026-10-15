/** Local presentation only: sample the replicated encounter, never change simulation state. */
import { BOSS_HEIGHT } from '../sim/bossDimensions';
import { BOSS_WHITEOUT_SECONDS } from '../sim/bossPresentation';
import { bossRevealEnabled, bossRevealTime, EFFIGY_BOSS_RISE_SECONDS } from '../sim/effigyBurn';
import { smoothstep } from '../sim/math';
import type { V3 } from '../sim/math';
import type { World } from '../sim/world';

/** Half-open interval, including late joins, and bounded even if a reveal snapshot is missing. */
export function effigyCameraTarget(world: World): V3 | null {
  if (world.phase !== 'playing' || !world.suddenDeath || !bossRevealEnabled(world.options)) return null;
  const reveal = world.effigyRevealedAt ?? bossRevealTime(world.options);
  const start = reveal - EFFIGY_BOSS_RISE_SECONDS;
  if (!Number.isFinite(reveal) || !Number.isFinite(world.time) || world.time < start ||
      world.time >= reveal + BOSS_WHITEOUT_SECONDS || (world.boss && (world.boss.hp <= 0 || world.boss.deathAt !== null))) return null;
  const at = world.map.effigy;
  const rise = smoothstep(start, reveal, world.time);
  // Follow the visible upper body as it clears the ground, then frame its torso/head.
  return { x: at.x, y: world.collision.groundHeight(at.x, at.z) + 2 + rise * (BOSS_HEIGHT * 0.65 - 2), z: at.z };
}
