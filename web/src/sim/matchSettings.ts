import { BURN_TIME, DAWN_TIME, HIPPIE } from './constants';
import type { MatchOptions, FactionId } from './types';
export interface MatchSettings {
  active: FactionId[];
  days: number; // 0 = unlimited
  dayLength: number; // seconds per complete day/night cycle
  gridScale: number;
  startingLumber: number;
  startingFlags: number;
  startingSignifiers: number;
  jumpHeight: number; // multiplier of the original jump apex; 1 = original height
  maxSignifiers: number; // fixed shared world population (alive and knocked out)
  structuresBlockFlagPlacement: boolean;
}
export const DEFAULT_MATCH: MatchSettings = {
  active: [0, 1, 2, 3],
  days: 1,
  dayLength: DAWN_TIME,
  gridScale: 8,
  startingLumber: 150,
  startingFlags: 14,
  startingSignifiers: 6,
  jumpHeight: 1,
  maxSignifiers: HIPPIE.popCapMax,
  structuresBlockFlagPlacement: false,
};
export const MATCH_RANGES = {
  dayLength: [300, 7200, 60],
  gridScale: [6, 12, 0.5],
  startingLumber: [0, 1000, 25],
  startingFlags: [0, 100, 1],
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
  if (Number.isInteger(value.days) && value.days! >= 0 && value.days! <= 5) out.days = value.days!;
  if (typeof value.structuresBlockFlagPlacement === 'boolean') out.structuresBlockFlagPlacement = value.structuresBlockFlagPlacement;
  for (const k of Object.keys(MATCH_RANGES) as (keyof typeof MATCH_RANGES)[]) {
    const v = value[k];
    const [min, max] = MATCH_RANGES[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(min, Math.min(max, v));
  }
  out.maxSignifiers = Math.floor(out.maxSignifiers);
  out.startingSignifiers = Math.min(Math.floor(out.startingSignifiers), Math.floor(out.maxSignifiers / out.active.length));
  return out;
}
export function matchSettings(options: MatchOptions): MatchSettings {
  return normalizeMatch(options.match);
}
export function endTime(options: MatchOptions): number {
  const s = matchSettings(options);
  return s.days === 0 ? Infinity : s.days * s.dayLength;
}
export function burnTime(options: MatchOptions): number {
  const s = matchSettings(options);
  return endTime(options) - s.dayLength * (1 - BURN_TIME / DAWN_TIME);
}
export function dayClock(options: MatchOptions, time: number): number {
  const s = matchSettings(options);
  return time >= endTime(options) ? DAWN_TIME : ((time % s.dayLength) / s.dayLength) * DAWN_TIME;
}
