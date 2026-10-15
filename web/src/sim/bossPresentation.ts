/** Presentation sampled from the replicated reveal clock; no events, timers, or RNG. */
import { bossRevealEnabled } from './effigyBurn';
import type { World } from './world';

// The announcement retains its full duration; visuals and camera release share the whiteout endpoint.
export const BOSS_AWAKENING_SECONDS = 5;
export const BOSS_WHITEOUT_SECONDS = 1;
export const BOSS_AWAKENING_FADE = 0.6;
type AwakeningWorld = Pick<World, 'time' | 'effigyRevealedAt' | 'options'> & Partial<Pick<World, 'phase'>>;

export function bossAwakeningAge(world: AwakeningWorld | null | undefined): number | null {
  if (!world || world.phase === 'ended' || world.effigyRevealedAt == null) return null;
  const age = world.time - world.effigyRevealedAt;
  if (!Number.isFinite(age) || age < 0 || age >= BOSS_AWAKENING_SECONDS) return null;
  return bossRevealEnabled(world.options) ? age : null;
}

/** A single sustained plateau, then a smooth recovery. Never flickers or repeats. */
export function bossAwakeningLevel(world: AwakeningWorld | null | undefined): number {
  const age = bossAwakeningAge(world);
  if (age === null || age >= BOSS_WHITEOUT_SECONDS) return 0;
  const t = Math.max(0, (age - (BOSS_WHITEOUT_SECONDS - BOSS_AWAKENING_FADE)) / BOSS_AWAKENING_FADE);
  return 1 - t * t * (3 - 2 * t);
}

/** Cancel the camera exposure lift on the excluded silhouette's own radiance. */
export const bossAwakeningExposure = (level: number): number => 1 + 3 * level;
