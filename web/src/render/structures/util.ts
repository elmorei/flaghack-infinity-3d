/**
 * Small presentation helpers shared by the structure views: a seeded PRNG for stable
 * procedural art (render code must not flicker between frames or matches), the easing
 * curves every pop-in shares, frame-rate independent damping, and flicker noise.
 */

import { BACK_EASE_OVERSHOOT } from '../../sim/constants';

/** mulberry32: tiny deterministic PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Overshooting ease used for every pop-in (pieces, buildings, GCC rebuild). */
export function easeOutBack(t: number): number {
  const c1 = BACK_EASE_OVERSHOOT;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

/** Decelerating cubic ease (construction reveal, collapses). */
export function easeOutCubic(t: number): number {
  const x = 1 - t;
  return 1 - x * x * x;
}

/** Exponential approach of `cur` toward `target` at `rate` per second (frame-rate independent). */
export function damp(cur: number, target: number, rate: number, dt: number): number {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Smooth pseudo-noise in [-1, 1] for flame/lamp flicker (incommensurate sines, no allocation). */
export function flickerNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 7.13 + seed) * 0.5 +
    Math.sin(t * 13.7 + seed * 1.7) * 0.3 +
    Math.sin(t * 29.3 + seed * 2.3) * 0.2
  );
}
