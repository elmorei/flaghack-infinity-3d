/** Host-private, bounded neutral visits. Recruitment itself remains a separate economy rule. */
import { BUILDINGS, RECRUIT_ATTRACT_RADIUS } from '../../constants';
import type { Building, Hippie } from '../../types';
import type { World } from '../../world';
import { canRecruit, isRecruiter, recruitmentLineClear } from '../recruitment';
import { brainOf, type Brain } from './brain';
import { effigyAudienceActive } from './effigySpectators';

export const SOCIAL_CAPACITY = 8;
interface Visit { building: number; faction: number; slot: number; x: number; z: number; nav: number; until: number; arrived: boolean }
interface Social { visits: Map<number, Visit>; cooldown: Map<number, number>; nextTry: Map<number, number>; sweptAt: number }
const states = new WeakMap<World, Social>();
function state(world: World): Social {
  let s = states.get(world);
  if (!s) { s = { visits: new Map(), cooldown: new Map(), nextTry: new Map(), sweptAt: -Infinity }; states.set(world, s); }
  if (world.time >= s.sweptAt + 1) {
    s.sweptAt = world.time;
    for (const [id, v] of s.visits) {
      const h = world.hippies.get(id), b = world.buildings.get(v.building);
      if (!h || !canRecruit(h) || h.order || !b || !socialCircle(world, b) || b.faction !== v.faction || v.until <= world.time) finish(world, s, id);
    }
    for (const [id, t] of s.cooldown) if (t <= world.time || !world.hippies.has(id)) s.cooldown.delete(id);
    for (const [id] of s.nextTry) if (!world.hippies.has(id)) s.nextTry.delete(id);
  }
  return s;
}
function socialCircle(world: World, b: Building): boolean {
  return b.kind === 'drumcircle' && b.hp > 0 && isRecruiter(world, b) &&
    !(b.capture?.attacker != null && b.capture.attacker !== b.faction && ['contained', 'contested', 'overwritten'].includes(b.capture.stage));
}
function finish(world: World, s: Social, id: number): void {
  s.visits.delete(id);
  s.cooldown.set(id, world.time + world.rng.range(30, 60));
  const h = world.hippies.get(id);
  if (h && canRecruit(h) && !h.order) { const b = brainOf(h); b.task = 'none'; b.route = 'none'; b.waitUntil = 0; }
}
export function leaveNeutralSocial(world: World, h: Hippie): void {
  const s = state(world); if (s.visits.has(h.id)) finish(world, s, h.id);
}
/** At most eight reserved approach/dance slots, and one local candidate scan per second. */
export function neutralSocialVisit(world: World, h: Hippie, brain: Brain): Visit | undefined {
  const s = state(world);
  if (!canRecruit(h) || h.order || effigyAudienceActive(world)) { if (s.visits.has(h.id)) finish(world, s, h.id); return; }
  let v = s.visits.get(h.id);
  if (v && (v.nav !== world.nav.version || v.until <= world.time)) { finish(world, s, h.id); v = undefined; }
  if (v) return v;
  if ((s.cooldown.get(h.id) ?? 0) > world.time || (s.nextTry.get(h.id) ?? 0) > world.time) return;
  s.nextTry.set(h.id, world.time + 1);
  const candidates = [...world.buildings.values()].filter(b => socialCircle(world, b) &&
    (brain.avoidBuildings.get(b.id) ?? 0) <= world.time && Math.hypot(b.pos.x - h.pos.x, b.pos.z - h.pos.z) <= RECRUIT_ATTRACT_RADIUS)
    .sort((a, b) => Math.hypot(a.pos.x - h.pos.x, a.pos.z - h.pos.z) - Math.hypot(b.pos.x - h.pos.x, b.pos.z - h.pos.z) || a.id - b.id);
  for (const b of candidates) {
    const used = new Set([...s.visits.values()].filter(v => v.building === b.id).map(v => v.slot));
    for (let n = 0; n < SOCIAL_CAPACITY; n++) {
      const slot = (n + h.id) % SOCIAL_CAPACITY;
      if (used.has(slot)) continue;
      const angle = slot * Math.PI * 2 / SOCIAL_CAPACITY;
      const radius = BUILDINGS.drumcircle.radius + 2 * world.nav.cell + 1;
      const x = b.pos.x + Math.cos(angle) * radius, z = b.pos.z + Math.sin(angle) * radius;
      if (!world.nav.isWalkable(x, z) || !recruitmentLineClear(world, b, { ...h, pos: { x, z } })) continue;
      v = { building: b.id, faction: b.faction, slot, x, z, nav: world.nav.version, arrived: false, until: world.time + 30 };
      s.visits.set(h.id, v); return v;
    }
  }
}
export function arriveNeutralSocial(world: World, visit: Visit): void {
  if (!visit.arrived) { visit.arrived = true; visit.until = world.time + world.rng.range(15, 30); }
}
