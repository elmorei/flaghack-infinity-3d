/** Captured scenery services use ordinary exterior navigation and interruptible queues.
 * Timers are host-only unit brain state, just like normal work channels and reservations.
 */
import { HIPPIE } from '../constants';
import type { Obstacle } from '../map/mapgen';
import type { V2 } from '../math';
import type { FactionId, Hippie } from '../types';
import type { World } from '../world';
import { activeScenery, sceneryServicePoint, sceneryBenefitActive, sceneryById } from './sceneryBenefits';
import { hasEffect } from './effects';
import { beginTask, brainOf, releaseTask, setStatusAt } from './units/brain';
import type { Brain } from './units/brain';
import { moveTo, routeExhausted } from './units/move';
import type { UnitsState } from './units/state';

export const SCENERY_SERVICE_TUNING = {
  domeHealPerSecond: 3,
  domeSafeSeconds: 5,
  domePatients: 4,
  shadeRecoverPerSecond: 4,
  shadePlaces: 4,
  portaAttention: 20,
  portaVisitSeconds: 3,
  portaCooldownSeconds: 45,
  seekRadius: 35,
  queueLimit: 8,
  retrySeconds: 5,
  arrivalRadius: 0.55,
  threatRadius: 8,
} as const;

type ServiceKind = 'dome' | 'shade' | 'porta';
interface ServiceSession {
  id: number;
  kind: ServiceKind;
  faction: FactionId;
  owner: number;
  joined: number;
  taskAt: number;
  work: number;
  phase: 'approach' | 'queue' | 'serving';
  point: V2;
}
interface ServiceMind {
  session: ServiceSession | null;
  reliefUntil: number;
  retryAt: number;
}

function mind(h: Hippie): ServiceMind {
  const found = h.brain.sceneryServices as ServiceMind | undefined;
  if (found) return found;
  const next: ServiceMind = { session: null, reliefUntil: -Infinity, retryAt: -Infinity };
  h.brain.sceneryServices = next;
  return next;
}

export function sceneryServiceOf(h: Hippie): Readonly<ServiceSession> | null {
  return (h.brain.sceneryServices as ServiceMind | undefined)?.session ?? null;
}

/** Reservations include approaching patients, so neither a crowded doorway nor a
 * simultaneous arrival can award more than the facility's allowed service capacity. */
export function sceneryServiceOccupancy(world: World, id: number): { serving: number; queued: number; approaching: number } {
  const out = { serving: 0, queued: 0, approaching: 0 };
  for (const h of world.hippies.values()) {
    const s = sceneryServiceOf(h);
    if (!s || s.id !== id || !sessionStillEligible(world, h, s)) continue;
    if (s.phase === 'serving') out.serving++;
    else if (s.phase === 'queue') out.queued++;
    else out.approaching++;
  }
  return out;
}

export function cancelSceneryService(world: World, h: Hippie, retry = false): void {
  const m = h.brain.sceneryServices as ServiceMind | undefined;
  if (!m?.session) return;
  const b = brainOf(h);
  if (b.task === 'idle' && b.taskAt === m.session.taskAt) releaseTask(world, h, b);
  m.session = null;
  if (retry) m.retryAt = world.time + SCENERY_SERVICE_TUNING.retrySeconds;
  // Public field is filled only while actually using a service.
  h.sceneryService = undefined;
}

function sessionStillEligible(world: World, h: Hippie, s: ServiceSession): boolean {
  const b = brainOf(h);
  return h.faction === s.faction && world.factions[s.faction].alive && h.hp > 0 && h.status !== 'ko' &&
    !h.order && !h.airborne && h.carryingFlag === -1 && h.carryingLumber === 0 &&
    !hasEffect(world, h, 'stun') && !hasEffect(world, h, 'knockback') && !hasEffect(world, h, 'overstimulated') &&
    b.task === 'idle' && b.taskAt === s.taskAt && !b.hurt &&
    world.sceneryCapture.get(s.id)?.faction === s.owner &&
    sceneryBenefitActive(world, s.id) && sceneryById(world, s.id)?.kind === s.kind;
}

function friends(world: World, owner: number, f: FactionId): boolean {
  return owner === f || (owner >= 0 && world.effigyRevealedAt !== null && world.factions[owner as FactionId].alive);
}
function capacity(kind: ServiceKind): number {
  return kind === 'dome' ? SCENERY_SERVICE_TUNING.domePatients : kind === 'shade' ? SCENERY_SERVICE_TUNING.shadePlaces : 1;
}
function queue(world: World, id: number): { h: Hippie; s: ServiceSession }[] {
  const q: { h: Hippie; s: ServiceSession }[] = [];
  for (const h of world.hippies.values()) {
    const s = sceneryServiceOf(h);
    if (s && s.id === id && sessionStillEligible(world, h, s)) q.push({ h, s: s as ServiceSession });
  }
  return q.sort((a, b) => a.s.joined - b.s.joined || a.h.id - b.h.id);
}
function threatNear(world: World, sys: UnitsState, h: Hippie, f: FactionId): boolean {
  if (world.boss && world.boss.hp > 0 && Math.hypot(world.boss.pos.x - h.pos.x, world.boss.pos.z - h.pos.z) < 24) return true;
  if (world.effigyRevealedAt !== null) return false;
  const r = SCENERY_SERVICE_TUNING.threatRadius;
  const n = sys.hash.query(h.pos.x, h.pos.z, r, sys.near);
  for (let i = 0; i < n; i++) {
    const other = sys.hash.items[sys.near[i]];
    if (other.faction >= 0 && other.faction !== f && world.factions[other.faction as FactionId].alive && other.hp > 0 && other.status !== 'ko') return true;
  }
  for (const av of world.avatars.values()) if (av.faction !== f && world.factions[av.faction].alive && av.hp > 0 && av.koUntil <= 0 &&
    Math.hypot(av.pos.x - h.pos.x, av.pos.z - h.pos.z) <= r) return true;
  return false;
}

function wants(kind: ServiceKind, world: World, sys: UnitsState, h: Hippie, b: Brain, m: ServiceMind, continuing = false): boolean {
  if (kind === 'dome') return h.hp < HIPPIE.maxHp && world.time - b.lastHurtAt >= SCENERY_SERVICE_TUNING.domeSafeSeconds;
  // These services never cancel excess-population decay or steal a distracted unit.
  if (sys.overCap.has(h.id)) return false;
  if (kind === 'shade') return h.attention < (continuing ? 95 : 60);
  return world.time >= m.reliefUntil && h.attention <= 100 - SCENERY_SERVICE_TUNING.portaAttention;
}

/** Called before ordinary work. Returns true only when this tick belongs to a service.
 * Job and orders are not overwritten: completing/canceling rest resumes normal decisions. */
export function updateSceneryService(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, dt: number): boolean {
  const m = mind(h);
  if (m.session && !sessionStillEligible(world, h, m.session)) cancelSceneryService(world, h, true);
  if (h.faction !== f || !world.factions[f].alive || h.hp <= 0 || h.status === 'ko' || h.order || h.carryingFlag !== -1 || h.carryingLumber > 0 ||
      b.hurt || h.airborne || hasEffect(world, h, 'overstimulated') || hasEffect(world, h, 'stun') ||
      hasEffect(world, h, 'knockback') || b.task === 'distracted' || b.task === 'wander' ||
      b.task === 'engage' || b.task === 'tear' || b.task === 'respond' || b.work > 0 || threatNear(world, sys, h, f)) {
    cancelSceneryService(world, h, true);
    return false;
  }
  let s = m.session;
  if (!s) {
    if (world.time < m.retryAt) return false;
    let best: { o: Obstacle; point: V2; score: number } | null = null;
    for (const o of activeScenery(world)) {
      if (o.kind !== 'dome' && o.kind !== 'shade' && o.kind !== 'porta') continue;
      const owner = world.sceneryCapture.get(o.id)!.faction;
      if (!friends(world, owner, f) || !wants(o.kind, world, sys, h, b, m)) continue;
      const q = queue(world, o.id);
      if (q.length >= SCENERY_SERVICE_TUNING.queueLimit) continue;
      const point = sceneryServicePoint(world, o, undefined, q.length);
      if (!point) continue;
      const distance = Math.hypot(point.x - h.pos.x, point.z - h.pos.z);
      if (distance > SCENERY_SERVICE_TUNING.seekRadius) continue;
      // Injury takes precedence; otherwise use the closest facility with shortest queue.
      const priority = o.kind === 'dome' ? (h.hp < 60 ? -30 : 12) : 0;
      const score = distance + Math.max(0, q.length - capacity(o.kind) + 1) * 5 + priority + (owner === f ? 0 : 5);
      if (!best || score < best.score || (score === best.score && o.id < best.o.id)) best = { o, point, score };
    }
    if (!best) { m.retryAt = world.time + 0.75; return false; }
    beginTask(world, h, b, 'idle');
    s = m.session = { id: best.o.id, kind: best.o.kind as ServiceKind, faction: f,
      owner: world.sceneryCapture.get(best.o.id)!.faction, joined: world.time, taskAt: b.taskAt,
      work: 0, phase: 'approach', point: best.point };
  }
  const o = sceneryById(world, s.id);
  if (!o || !wants(s.kind, world, sys, h, b, m, true)) { cancelSceneryService(world, h, true); return false; }
  const q = queue(world, s.id);
  const rank = q.findIndex(v => v.h.id === h.id);
  if (rank < 0) { cancelSceneryService(world, h, true); return false; }
  const point = sceneryServicePoint(world, o, undefined, rank);
  if (!point) { cancelSceneryService(world, h, true); return false; }
  s.point = point;
  b.pace = 1;
  const arrived = moveTo(world, sys, h, b, point.x, point.z, SCENERY_SERVICE_TUNING.arrivalRadius);
  if (!arrived && routeExhausted(h, b)) { cancelSceneryService(world, h, true); return false; }
  s.phase = !arrived ? 'approach' : rank >= capacity(s.kind) ? 'queue' : 'serving';
  h.sceneryService = { id: s.id, phase: s.phase };
  setStatusAt(h, b, arrived ? 'idle' : 'walking', point.x, point.z);
  if (!arrived || s.phase !== 'serving') { s.work = 0; return true; }
  // The unit is stationary at its exterior service point, not merely in an aura.
  h.vel.x = 0; h.vel.z = 0; b.moving = false;
  if (s.kind === 'dome') h.hp = Math.min(HIPPIE.maxHp, h.hp + SCENERY_SERVICE_TUNING.domeHealPerSecond * dt);
  else if (s.kind === 'shade') h.attention = Math.min(100, h.attention + SCENERY_SERVICE_TUNING.shadeRecoverPerSecond * dt);
  else {
    s.work += dt;
    if (s.work >= SCENERY_SERVICE_TUNING.portaVisitSeconds) {
      h.attention = Math.min(100, h.attention + SCENERY_SERVICE_TUNING.portaAttention);
      m.reliefUntil = world.time + SCENERY_SERVICE_TUNING.portaCooldownSeconds;
      cancelSceneryService(world, h, true);
    }
  }
  return true;
}
