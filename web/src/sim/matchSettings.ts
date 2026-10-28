import { BURN_TIME, DAWN_TIME, HOARD_THRESHOLD } from './constants';
import { BOSS_MAX_HP } from './boss';
import type { MatchOptions, FactionId } from './types';
export interface MatchSettings {
  active: FactionId[];
  days: number; // 0 = begin at The Burn; UNLIMITED_DAYS = no scheduled Burn or Dawn
  dayLength: number; // seconds per complete day/night cycle
  gridScale: number;
  startingLumber: number;
  startingFlags: number;
  hoardThreshold: number; // base soft stock limit; completed Workshops add their storage capacity
  startingSignifiers: number;
  jumpHeight: number; // multiplier of the original jump apex; 1 = original height
  maxSignifiers: number; // fixed shared world population (alive and knocked out)
  structuresBlockFlagPlacement: boolean;
  buildingCapture: boolean; // independent non-altar buildings, pieces and scenery capture
  crystalFlagProtection: boolean; // crystal pull slowdown only; Wards are unchanged
  crystalAttacks: boolean; // ordinary-unit crystal defense; separate from boss lightning
  bossMode: boolean; // reveal the boss 90 seconds after The Burn
  bossHp: number; // starting and maximum boss health, sampled once at encounter creation
}
/** A distinct, JSON-safe value so zero days can start at ignition. */
export const UNLIMITED_DAYS = -1;
export const DEFAULT_MATCH: MatchSettings = {
  active: [0, 1, 2, 3],
  days: 1,
  dayLength: 600,
  gridScale: 8,
  startingLumber: 150,
  startingFlags: 14,
  hoardThreshold: HOARD_THRESHOLD,
  startingSignifiers: 6,
  jumpHeight: 3,
  maxSignifiers: 200,
  structuresBlockFlagPlacement: false,
  buildingCapture: true,
  crystalFlagProtection: true,
  crystalAttacks: true,
  bossMode: true,
  bossHp: BOSS_MAX_HP,
};
export const MATCH_BOOLEAN_KEYS = ['bossMode', 'structuresBlockFlagPlacement', 'buildingCapture', 'crystalFlagProtection', 'crystalAttacks'] as const;
export const MATCH_RANGES = {
  dayLength: [300, 7200, 60],
  bossHp: [100, 1000000, 100],
  gridScale: [6, 12, 0.5],
  startingLumber: [0, 1000, 25],
  startingFlags: [0, 100, 1],
  hoardThreshold: [0, 1000, 1],
  startingSignifiers: [0, 12, 1],
  jumpHeight: [0.1, 5, 0.1],
  maxSignifiers: [0, 200, 1],
} as const;
export function normalizeMatch(value: Partial<MatchSettings> = {}): MatchSettings {
  const out: MatchSettings = { ...DEFAULT_MATCH, active: [...DEFAULT_MATCH.active] };
  if (!value || typeof value !== 'object') return out;
  const a = value.active;
  if (Array.isArray(a)) {
    const active = [0, 1, 2, 3].filter((f) => a.includes(f as FactionId)) as FactionId[];
    if (active.length) out.active = active;
  }
  if (isMatchDays(value.days)) out.days = value.days;
  for (const key of MATCH_BOOLEAN_KEYS) if (typeof value[key] === 'boolean') out[key] = value[key];
  for (const k of Object.keys(MATCH_RANGES) as (keyof typeof MATCH_RANGES)[]) {
    const v = value[k];
    const [min, max] = MATCH_RANGES[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(min, Math.min(max, v));
  }
  out.maxSignifiers = Math.floor(out.maxSignifiers);
  out.bossHp = Math.floor(out.bossHp);
  out.hoardThreshold = Math.floor(out.hoardThreshold);
  out.startingSignifiers = Math.min(Math.floor(out.startingSignifiers), Math.floor(out.maxSignifiers / out.active.length));
  return out;
}
export function isMatchDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= UNLIMITED_DAYS && value <= 5;
}
export function matchSettings(options: MatchOptions): MatchSettings {
  return normalizeMatch(options.match);
}
export function endTime(options: MatchOptions): number {
  const s = matchSettings(options);
  if (s.days === UNLIMITED_DAYS) return Infinity;
  // Zero days skips the pre-Burn daylight, not the remaining normal-mode night.
  return s.days === 0 ? s.dayLength * (1 - BURN_TIME / DAWN_TIME) : s.days * s.dayLength;
}
export function burnTime(options: MatchOptions): number {
  const s = matchSettings(options);
  if (s.days === 0) return 0;
  return endTime(options) - s.dayLength * (1 - BURN_TIME / DAWN_TIME);
}
export function dayClock(options: MatchOptions, time: number): number {
  const s = matchSettings(options);
  if (time >= endTime(options)) return DAWN_TIME;
  const offset = s.days === 0 ? s.dayLength * BURN_TIME / DAWN_TIME : 0;
  return (((time + offset) % s.dayLength) / s.dayLength) * DAWN_TIME;
}
