/**
 * Camp economy: Hearth/Workshop Flag crafting, passive recruitment from the shared population, ritual
 * income from drummers and Saffron, lumber pile depletion and respawn, hoarding flag.
 * Owner: Economy agent.
 */
import type { CommandOf } from '../commands';
import {
  BUILDINGS,
  DRUG,
  DRUM_REACH,
  DRUM_RITUAL_PER_SEC,
  DRUMMERS_PER_CIRCLE,
  HEARTH_FLAG_COST,
  HEARTH_FLAG_INTERVAL,
  HIPPIE,
  HOARD_THRESHOLD,
  PILE_COUNT,
  PILE_MAX,
  PILE_MIN,
  PILE_RESPAWN_INTERVAL,
  RECRUIT_INTERVAL,
  WORKSHOP_FLAG_COST,
  WORKSHOP_FLAG_INTERVAL,
} from '../constants';
import { spawnPile } from '../factory';
import type { V2 } from '../math';
import { FACTION_IDS, JOBS } from '../types';
import type { Building, EntityId, FactionId } from '../types';
import type { World } from '../world';
import { econ } from './econ/state';
import type { EconState } from './econ/state';
import { craftFlag } from './flags';
import { isRecruiter, recruitNear } from './recruitment';

/** A respawned pile keeps this much clear ground from other piles and buildings. */
const PILE_SPACING = 4;

export function cmdJobWeights(world: World, c: CommandOf<'jobWeights'>): void {
  const w = world.factions[c.faction].jobWeights;
  for (const j of JOBS) {
    const v = c.weights[j];
    if (v !== undefined) w[j] = Math.max(0, Math.min(4, Math.round(v)));
  }
}

/** Soft attention capacity. Recruitment can exceed it; newest excess recruits lose attention. */
export function popCap(world: World, f: FactionId): number {
  let circles = 0;
  for (const b of world.buildings.values()) {
    if (b.faction === f && b.kind === 'drumcircle' && b.built >= 1 && !b.disabled) circles++;
  }
  return HIPPIE.popCapBase + circles * HIPPIE.popCapPerDrumCircle;
}

/** Active affiliated hippies; knocked-out workers will return neutral. */
export function population(world: World, f: FactionId): number {
  let n = 0;
  for (const h of world.hippies.values()) if (h.faction === f && h.status !== 'ko') n++;
  return n;
}

/**
 * Hearth stock above HOARD_THRESHOLD: the faction's hippies lose attention faster. The economy
 * system tallies it every tick (hippies, which run first, read the previous tick's tally); a
 * replicated mirror never steps the economy, so a tally older than that is retaken here.
 */
export function isHoarding(world: World, f: FactionId): boolean {
  const st = econ(world);
  if (st.stockTick < world.tick - 1) tallyStock(world, st);
  return st.hoarding[f];
}

/** Stock per faction (Flags held at its Hearths) and the hoarding flags derived from it. */
function tallyStock(world: World, st: EconState): void {
  st.stock.fill(0);
  for (const fl of world.flags.values()) {
    if (fl.state !== 'stock') continue;
    const hearth = world.buildings.get(fl.holder);
    if (hearth && hearth.faction !== -1) st.stock[hearth.faction]++;
  }
  for (const f of FACTION_IDS) st.hoarding[f] = st.stock[f] > HOARD_THRESHOLD;
  st.stockTick = world.tick;
}

/** Flags in one Hearth's stock. */
export function stockAt(world: World, hearthId: EntityId): number {
  let n = 0;
  for (const fl of world.flags.values()) if (fl.state === 'stock' && fl.holder === hearthId) n++;
  return n;
}

/** Nearest own Hearth to a point (any Hearth when `withStock` is false, else one with stock). */
export function nearestHearth(world: World, f: FactionId, at: V2, withStock = false): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const id of world.factions[f].hearthIds) {
    const h = world.buildings.get(id);
    if (!h || h.faction !== f) continue;
    const d = (h.pos.x - at.x) ** 2 + (h.pos.z - at.z) ** 2;
    if (d >= bestD || (withStock && stockAt(world, h.id) === 0)) continue;
    best = h;
    bestD = d;
  }
  return best;
}

function craftAtHearth(world: World, b: Building, f: FactionId, dt: number): void {
  const hs = b.hearth;
  if (!hs) return;
  hs.craftProgress = Math.min(HEARTH_FLAG_INTERVAL, hs.craftProgress + dt);
  if (hs.craftProgress < HEARTH_FLAG_INTERVAL) return;
  const fac = world.factions[f];
  if (fac.lumber < HEARTH_FLAG_COST || !craftFlag(world, b.id)) return;
  fac.lumber -= HEARTH_FLAG_COST;
  hs.craftProgress -= HEARTH_FLAG_INTERVAL;
}

/** Workshops craft into the nearest own Hearth's stock (Flags live at the Hearth). */
function craftAtWorkshop(world: World, b: Building, f: FactionId, dt: number): void {
  b.progress = Math.min(WORKSHOP_FLAG_INTERVAL, b.progress + dt);
  if (b.progress < WORKSHOP_FLAG_INTERVAL) return;
  const fac = world.factions[f];
  if (fac.lumber < WORKSHOP_FLAG_COST) return;
  const hearth = nearestHearth(world, f, b.pos);
  if (!hearth || !craftFlag(world, hearth.id)) return;
  fac.lumber -= WORKSHOP_FLAG_COST;
  b.progress -= WORKSHOP_FLAG_INTERVAL;
}

/** Every recruiter periodically enlists an existing nearby neutral, without creating units. */
function recruitAtBuilding(world: World, b: Building, dt: number): void {
  if (!isRecruiter(world, b)) return;
  b.progress = Math.min(RECRUIT_INTERVAL, b.progress + dt);
  if (b.progress >= RECRUIT_INTERVAL && recruitNear(world, b)) b.progress -= RECRUIT_INTERVAL;
}

/** Ritual: DRUM_RITUAL_PER_SEC per drumming hippie at a working own circle (≤ DRUMMERS_PER_CIRCLE each), plus Saffron. */
function gainRitual(world: World, st: EconState, dt: number): void {
  const reach2 = (BUILDINGS.drumcircle.radius + DRUM_REACH) ** 2;
  for (const f of FACTION_IDS) {
    const fac = world.factions[f];
    if (!fac.alive) continue;
    if (fac.drugActive.saffron > world.time) fac.ritual += DRUG.saffronRitualPerSec * dt;
    const circles = st.circles;
    const counts = st.circleDrummers;
    circles.length = 0;
    counts.length = 0;
    for (const b of world.buildings.values()) {
      if (b.faction !== f || b.kind !== 'drumcircle' || b.built < 1 || b.disabled) continue;
      circles.push(b);
      counts.push(0);
    }
    if (circles.length === 0) continue;
    let drummers = 0;
    for (const h of world.hippies.values()) {
      if (h.faction !== f || h.status !== 'drumming') continue;
      // Each drummer plays at its nearest circle only.
      let best = -1;
      let bestD = reach2;
      for (let i = 0; i < circles.length; i++) {
        const d = (circles[i].pos.x - h.pos.x) ** 2 + (circles[i].pos.z - h.pos.z) ** 2;
        if (d <= bestD) {
          best = i;
          bestD = d;
        }
      }
      if (best >= 0 && counts[best] < DRUMMERS_PER_CIRCLE) {
        counts[best]++;
        drummers++;
      }
    }
    fac.ritual += drummers * DRUM_RITUAL_PER_SEC * dt;
  }
  st.circles.length = 0;
}

function freePileSpot(world: World): V2 | undefined {
  const free: V2[] = [];
  for (const s of world.map.pileSpots) {
    let taken = false;
    for (const p of world.piles.values()) {
      if ((p.pos.x - s.x) ** 2 + (p.pos.z - s.z) ** 2 < PILE_SPACING * PILE_SPACING) {
        taken = true;
        break;
      }
    }
    if (taken) continue;
    for (const b of world.buildings.values()) {
      const r = BUILDINGS[b.kind].radius + PILE_SPACING;
      if ((b.pos.x - s.x) ** 2 + (b.pos.z - s.z) ** 2 < r * r) {
        taken = true;
        break;
      }
    }
    if (!taken && !world.collision.blockedCircle(s.x, s.z, 1, 0.1, 1.5)) free.push(s);
  }
  return free.length > 0 ? world.rng.pick(free) : undefined;
}

/** Depleted piles vanish; a fresh heap appears at a free pile spot every PILE_RESPAWN_INTERVAL while below PILE_COUNT. */
function tendPiles(world: World, st: EconState, dt: number): void {
  for (const p of world.piles.values()) if (p.lumber <= 0) world.piles.delete(p.id);
  if (world.piles.size >= PILE_COUNT) {
    st.pileTimer = 0;
    return;
  }
  st.pileTimer += dt;
  if (st.pileTimer < PILE_RESPAWN_INTERVAL) return;
  st.pileTimer = 0;
  const spot = freePileSpot(world);
  if (spot) spawnPile(world, world.rng.chance(0.55) ? 'pallets' : 'moop', spot, world.rng.int(PILE_MIN, PILE_MAX));
}

export function updateEconomy(world: World, dt: number): void {
  const st = econ(world);
  tallyStock(world, st);

  for (const b of world.buildings.values()) {
    const f = b.faction;
    if (f === -1) continue;
    if (b.kind === 'hearth') craftAtHearth(world, b, f, dt);
    else if (b.built >= 1 && !b.disabled) {
      if (b.kind === 'workshop') craftAtWorkshop(world, b, f, dt);
      else if (b.kind === 'drumcircle' || b.kind === 'gcc') recruitAtBuilding(world, b, dt);
    }
  }
  gainRitual(world, st, dt);
  tendPiles(world, st, dt);
}
