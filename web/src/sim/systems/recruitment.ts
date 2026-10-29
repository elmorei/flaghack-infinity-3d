import { offerFrickFrackFlag } from './frickFrack';
/** Recruitment changes allegiance within the shared population; it never creates a hippie. */
import type { CommandOf } from '../commands';
import { AVATAR, BUILDINGS, RECRUIT_ATTRACT_RADIUS, RECRUIT_RADIUS } from '../constants';
import type { GameEvent } from '../events';
import { NEUTRAL } from '../types';
import type { Building, FactionId, Hippie } from '../types';
import type { World } from '../world';
import { isCollapsed } from './buildings';
import { hasEffect } from './effects';
import { dropLoose, giveFlag } from './flags';
import { breakChannel } from './units/channel';

type RecruitVia = Extract<GameEvent, { t: 'recruited' }>['via'];

export function canRecruit(h: Hippie): boolean {
  return !h.wizard && h.faction === NEUTRAL && h.status !== 'ko' && h.koUntil === 0 && h.hp > 0;
}

export function isRecruiter(world: World, b: Building): boolean {
  return (b.kind === 'drumcircle' || b.kind === 'gcc') && b.faction !== NEUTRAL &&
    world.factions[b.faction].alive && b.built >= 1 && !b.disabled && !isCollapsed(b);
}

/** Also used by Dialectics: a new allegiance gets a new place in the soft-cap queue. */
export function enlist(world: World, h: Hippie, f: FactionId, via: RecruitVia): void {
  if (h.wizard) return;
  h.faction = f;
  h.recruitedAt = world.time;
  h.order = null;
  h.job = null;
  h.status = 'idle';
  h.statusTarget = null;
  h.beacon = true;
  world.factions[f].stats.hippiesRecruited++;
  world.emit({ t: 'recruited', hippieId: h.id, faction: f, via });
}

/** A real carried or thrown Flag changes hands, preserving its identity and inventory. */
export function recruitWithFlag(world: World, h: Hippie, f: FactionId, flagId: number, via: 'hand' | 'throw'): boolean {
  if (h.wizard) return offerFrickFrackFlag(world, h, f, flagId);
  const flag = world.flags.get(flagId);
  if (!world.factions[f].alive || !canRecruit(h) || h.carryingFlag !== -1 || h.carryingLumber > 0 || !flag) return false;
  if (flag.state !== 'carried' && flag.state !== 'flying') return false;
  if (flag.state === 'flying') dropLoose(world, flag.id, { x: h.pos.x, y: 0, z: h.pos.z });
  // Flag inventories require an affiliated recipient. Validation above makes the transfer safe.
  h.faction = f;
  if (!giveFlag(world, flagId, h.id)) {
    h.faction = NEUTRAL;
    return false;
  }
  enlist(world, h, f, via);
  return true;
}

export function handFlagBlocker(world: World, f: FactionId, target: number): string {
  const av = world.avatarOf(f);
  const h = world.hippies.get(target);
  if (world.factions[f].controlMode === 'rts' || !world.factions[f].alive || !av || av.koUntil > 0 || hasEffect(world, av, 'stun')) return 'You cannot hand over a Flag right now.';
  if (av.action.kind === 'swing' || av.action.kind === 'plant') return 'Finish your current action first.';
  if (!h || (!canRecruit(h) && !(h.wizard && h.hp > 0 && h.koUntil === 0 && h.status !== 'ko'))) return 'Choose an awake neutral Signifier.';
  if (h.carryingFlag !== -1 || h.carryingLumber > 0) return 'That Signifier has its hands full.';
  if (!av.carried.length) return 'Your quiver is empty.';
  const dy = world.collision.groundHeight(h.pos.x, h.pos.z) + (h.airborne?.y ?? 0) - av.pos.y;
  if (Math.hypot(h.pos.x - av.pos.x, dy, h.pos.z - av.pos.z) > AVATAR.pullReach) return 'Move closer to hand over a Flag.';
  const dx = h.pos.x - av.pos.x, dz = h.pos.z - av.pos.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > 0 && world.collision.raycast(av.pos.x, av.pos.y + 1, av.pos.z, dx, dy, dz, distance)) return 'Something blocks the handoff.';
  return '';
}

export function cmdHandFlag(world: World, c: CommandOf<'handFlag'>): void {
  const why = handFlagBlocker(world, c.faction, c.hippieId);
  if (why) {
    world.emit({ t: 'rejected', faction: c.faction, reason: why });
    return;
  }
  const av = world.avatarOf(c.faction);
  if (recruitWithFlag(world, world.hippies.get(c.hippieId)!, c.faction, av.carried.at(-1)!, 'hand')) breakChannel(world, av);
}

/** Clear, walkable approach samples outside the nav grid's conservative building padding. */
export function recruiterApproaches(world: World, b: Building, h: Hippie): { x: number; z: number }[] {
  const angle = Math.atan2(h.pos.z - b.pos.z, h.pos.x - b.pos.x);
  const out: { x: number; z: number }[] = [];
  for (const gap of [2 * world.nav.cell + 1, 2 * world.nav.cell + 4]) {
    const r = Math.min(RECRUIT_RADIUS * .8, BUILDINGS[b.kind].radius + gap);
    for (const offset of [0, 1, -1, 2, -2, 3, -3, 4]) {
      const a = angle + offset * Math.PI / 4;
      const p = { x: b.pos.x + Math.cos(a) * r, z: b.pos.z + Math.sin(a) * r };
      if (world.nav.isWalkable(p.x, p.z) && recruitmentLineClear(world, b, { ...h, pos: p })) out.push(p);
    }
  }
  return out;
}
export function recruiterApproach(world: World, b: Building, h: Hippie): { x: number; z: number } {
  const points = recruiterApproaches(world, b, h);
  return points.find(p => world.nav.lineOfSight(h.pos.x, h.pos.z, p.x, p.z)) ?? points[0] ?? { ...b.pos };
}

/** Physical line of sight ignores only the recruiter itself, not intervening walls.
 * Nav padding is NOT a wall: a unit at an actual clear cart rim can be recruited.
 */
export function recruitmentLineClear(world: World, b: Building, h: Hippie): boolean {
  const dx = b.pos.x - h.pos.x, dz = b.pos.z - h.pos.z;
  const y = world.collision.groundHeight(h.pos.x, h.pos.z) + 1;
  const dy = world.collision.groundHeight(b.pos.x, b.pos.z) + 1 - y;
  const distance = Math.hypot(dx, dy, dz);
  return distance < .001 || !world.collision.raycast(h.pos.x, y, h.pos.z, dx, dy, dz, distance, b.id);
}

/** Nearest eligible neutral, with stable id tie-breaking when two stand equally close. */
export function recruitNear(world: World, b: Building): boolean {
  if (!isRecruiter(world, b) || b.faction === NEUTRAL) return false;
  let best: Hippie | undefined;
  let bestD = RECRUIT_RADIUS * RECRUIT_RADIUS;
  for (const h of world.hippies.values()) {
    if (!canRecruit(h)) continue;
    const d = (h.pos.x - b.pos.x) ** 2 + (h.pos.z - b.pos.z) ** 2;
    if (d > bestD || (d === bestD && best && h.id > best.id) || !recruitmentLineClear(world, b, h)) continue;
    best = h;
    bestD = d;
  }
  if (!best) return false;
  enlist(world, best, b.faction, b.kind === 'gcc' ? 'gcc' : 'drumcircle');
  return true;
}

/** Wiped camps may call ONE unclaimed, reachable neutral, never create a replacement.
 * Calls are host-private navigation decisions; all visible movement/allegiance is replicated.
 * One bounded path attempt per empty GCC per second prevents a wipe causing path spikes.
 */
interface RecoveryApproach { x: number; z: number; sourceX: number; sourceZ: number; faction: number; navVersion: number }
interface RecoveryCalls { nextAt: number; claims: Map<number, number>; failed: Map<string, number>; approaches: Map<number, RecoveryApproach>; trials: Map<string, number> }
const recoveryCalls = new WeakMap<World, RecoveryCalls>();
export function updateRecoveryCalls(world: World): void {
  let state = recoveryCalls.get(world);
  if (!state) { state = { nextAt: 0, claims: new Map(), failed: new Map(), approaches: new Map(), trials: new Map() }; recoveryCalls.set(world, state); }
  if (world.time < state.nextAt) return;
  state.nextAt = world.time + 1;
  const occupied = new Set([...world.hippies.values()].filter(h => h.faction !== NEUTRAL && h.hp > 0 && h.status !== 'ko' && h.koUntil === 0).map(h => h.faction));
  const recruiters = [...world.buildings.values()].filter(b => isRecruiter(world, b));
  const eligible = recruiters.filter(b => b.kind === 'gcc' && !occupied.has(b.faction));
  const ordered = new Set([...world.hippies.values()].flatMap(h => h.order?.kind === 'recruit' ? [h.order.target] : []));
  const locallyClaimed = (h: Hippie, own: number) => recruiters.some(b => b.id !== own &&
    (h.pos.x - b.pos.x) ** 2 + (h.pos.z - b.pos.z) ** 2 <= RECRUIT_ATTRACT_RADIUS ** 2 &&
    (recruitmentLineClear(world, b, h) || (h.statusTarget?.x === b.pos.x && h.statusTarget.z === b.pos.z)));
  for (const [id, target] of state.claims) {
    const b = eligible.find(b => b.id === id), h = world.hippies.get(target);
    if (!b || !h || !validRecoveryApproach(world, b, state.approaches.get(id)) || !canRecruit(h) || ordered.has(target) || locallyClaimed(h, id)) {
      state.claims.delete(id); state.approaches.delete(id);
    }
  }
  for (const b of eligible.sort((a, b) => a.id - b.id)) {
    if (state.claims.has(b.id)) continue;
    const reserved = new Set(state.claims.values());
    const candidates = [...world.hippies.values()].filter(h => canRecruit(h) && !reserved.has(h.id) && !ordered.has(h.id) &&
      !locallyClaimed(h, b.id) && (state!.failed.get(`${b.id}:${h.id}`) ?? 0) <= world.time)
      .sort((a, c) => Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) - Math.hypot(c.pos.x - b.pos.x, c.pos.z - b.pos.z) || a.id - c.id);
    const h = candidates[0];
    if (!h) continue;
    const points = recruiterApproaches(world, b, h);
    const key = `${b.id}:${h.id}`, trial = state.trials.get(key) ?? 0;
    const p = points[trial % points.length];
    if (!p) { state.failed.set(key, world.time + 30); continue; }
    const path = world.nav.findPath(h.pos.x, h.pos.z, p.x, p.z, { partial: false, maxIter: 6000 });
    const end = path?.at(-1);
    if (end && Math.hypot(end.x - b.pos.x, end.z - b.pos.z) <= RECRUIT_RADIUS && recruitmentLineClear(world, b, { ...h, pos: end })) {
      state.claims.set(b.id, h.id); state.approaches.set(b.id, { ...p, sourceX: b.pos.x, sourceZ: b.pos.z, faction: b.faction, navVersion: world.nav.version }); state.trials.delete(key);
    } else {
      state.trials.set(key, trial + 1);
      state.failed.set(key, world.time + ((trial + 1) % points.length === 0 ? 30 : 1));
    }
  }
  for (const [key, until] of state.failed) if (until <= world.time) state.failed.delete(key);
}
export function recoveryRecruiter(world: World, h: Hippie): Building | undefined {
  for (const [id, target] of recoveryCalls.get(world)?.claims ?? []) {
    if (target !== h.id) continue;
    const b = world.buildings.get(id);
    if (b && isRecruiter(world, b) && validRecoveryApproach(world, b, recoveryCalls.get(world)?.approaches.get(id))) return b;
  }
  return undefined;
}

/** A newly blocked journey releases the global claim so another reachable survivor can answer. */
export function failRecoveryCall(world: World, h: Hippie, recruiter: Building): void {
  const state = recoveryCalls.get(world);
  if (state?.claims.get(recruiter.id) !== h.id) return;
  state.claims.delete(recruiter.id);
  state.failed.set(`${recruiter.id}:${h.id}`, world.time + 30);
}

export function recoveryApproach(world: World, h: Hippie, b: Building): { x: number; z: number } | undefined {
  const state = recoveryCalls.get(world);
  const p = state?.approaches.get(b.id);
  return state?.claims.get(b.id) === h.id && validRecoveryApproach(world, b, p) ? p : undefined;
}

function validRecoveryApproach(world: World, b: Building, p: RecoveryApproach | undefined): boolean {
  return !!p && p.sourceX === b.pos.x && p.sourceZ === b.pos.z && p.faction === b.faction && p.navVersion === world.nav.version;
}
