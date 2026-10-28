/**
 * Camp buildings: placement validation (thick facet inside own Survey, no overlap, nodes
 * stay free), construction progress, collision + nav registration, damage/disable/repair,
 * Hearth Ward pulses, Drug Lab brewing queue.
 * Owner: Economy agent.
 */
import type { CommandOf } from '../commands';
import {
  BREW_COST,
  BREW_TIME,
  BUILD_HELP_MULT,
  BUILD_HELP_RADIUS,
  BUILD_TIME,
  BUILDING_HEIGHT,
  BUILDING_REPAIR_HPS,
  BUILDINGS,
  DRUG_MAX,
  GCC,
  MAX_BUILD_LEVEL,
  WARD_PULSE_DAMAGE,
  WARD_PULSE_INTERVAL,
  WARD_PULSE_RADIUS,
  WARD_PULSE_STUN,
} from '../constants';
import { spawnBuilding } from '../factory';
import type { Building, BuildingKind, EntityId, FactionId } from '../types';
import type { World } from '../world';
import { damageEntity } from './combat';
import { pickAutoBrew } from './drugs';
import { pieceBottom } from './econ/pieceGeometry';
import { econ } from './econ/state';
import { applyEffect } from './effects';
import { pieceAt } from './pieces';

export interface PlacementCheck {
  ok: boolean;
  reason: string;
}

/** Player-facing building names. */
export const BUILDING_NAMES: Record<BuildingKind, string> = {
  hearth: 'Flag Hearth',
  workshop: 'Flag Workshop',
  drumcircle: 'Drum Circle',
  ward: 'Hearth Ward',
  druglab: 'Drug Lab',
  gcc: 'Geomantic Command Center',
};

/** Clear ground kept between two building footprints. */
const BUILDING_GAP = 0.5;
/** Hippies marked 'building'/'repairing' help when within a building's radius plus this. */
const HELPER_REACH = 3;

const OK: PlacementCheck = Object.freeze({ ok: true, reason: '' });
const NO = {
  unique: { ok: false, reason: 'The Hearth and the Command Center are not raised by hand.' },
  facet: { ok: false, reason: 'No Ley facet there.' },
  thin: { ok: false, reason: 'Camp buildings need a Sun facet (a thick rhombus).' },
  boundary: { ok: false, reason: 'The Lattice frays at the edge of the burn: build further in.' },
  survey: { ok: false, reason: 'Build inside your own Survey.' },
  overlap: { ok: false, reason: 'Another building already holds this ground.' },
  pieces: { ok: false, reason: 'Decks or ramps hang too low over this facet.' },
  obstacle: { ok: false, reason: 'Something solid stands here.' },
} satisfies Record<string, PlacementCheck>;
for (const r of Object.values(NO)) Object.freeze(r);
const NO_LUMBER: Record<BuildingKind, PlacementCheck> = {
  hearth: Object.freeze({ ok: false, reason: `Not enough lumber (${BUILDINGS.hearth.cost} needed).` }),
  workshop: Object.freeze({ ok: false, reason: `Not enough lumber (${BUILDINGS.workshop.cost} needed).` }),
  drumcircle: Object.freeze({ ok: false, reason: `Not enough lumber (${BUILDINGS.drumcircle.cost} needed).` }),
  ward: Object.freeze({ ok: false, reason: `Not enough lumber (${BUILDINGS.ward.cost} needed).` }),
  druglab: Object.freeze({ ok: false, reason: `Not enough lumber (${BUILDINGS.druglab.cost} needed).` }),
  gcc: Object.freeze({ ok: false, reason: `Not enough lumber (${BUILDINGS.gcc.cost} needed).` }),
};

/**
 * Is this a GCC lying collapsed? destroyedUntil is its rebuild time while down and resets to 0
 * when the cart stands again (the rebuild may wait past that time for a free facet).
 */
export function isCollapsed(b: Building): boolean {
  return b.gcc !== null && b.gcc.destroyedUntil !== 0;
}

export function canPlaceBuilding(world: World, f: FactionId, kind: BuildingKind, facet: number): PlacementCheck {
  if (kind === 'hearth' || kind === 'gcc') return NO.unique;
  const lat = world.lattice;
  if (!Number.isInteger(facet) || facet < 0 || facet >= lat.facets.length) return NO.facet;
  const fc = lat.facets[facet];
  if (!fc.thick) return NO.thin;
  if (fc.boundary) return NO.boundary;
  if (!world.inSurvey(facet, f)) return NO.survey;
  const r = BUILDINGS[kind].radius;
  for (const b of world.buildings.values()) {
    if (isCollapsed(b)) continue;
    const min = r + BUILDINGS[b.kind].radius + BUILDING_GAP;
    if ((b.pos.x - fc.cx) ** 2 + (b.pos.z - fc.cz) ** 2 < min * min) return NO.overlap;
  }
  const height = BUILDING_HEIGHT[kind];
  for (let level = 0; level <= MAX_BUILD_LEVEL; level++) {
    const p = pieceAt(world, 'floor', -1, facet, level);
    if (p && pieceBottom(p.kind, level) < height) return NO.pieces;
  }
  if (world.map.isBlockedAt(fc.cx, fc.cz) || world.collision.blockedCircle(fc.cx, fc.cz, r, world.collision.groundHeight(fc.cx, fc.cz) + 0.2, world.collision.groundHeight(fc.cx, fc.cz) + height)) return NO.obstacle;
  if (world.factions[f].lumber < BUILDINGS[kind].cost) return NO_LUMBER[kind];
  return OK;
}

export function cmdPlaceBuilding(world: World, c: CommandOf<'placeBuilding'>): void {
  const chk = canPlaceBuilding(world, c.faction, c.kind, c.facet);
  if (!chk.ok) {
    world.emit({ t: 'rejected', faction: c.faction, reason: chk.reason });
    return;
  }
  world.factions[c.faction].lumber -= BUILDINGS[c.kind].cost;
  const b = spawnBuilding(world, c.kind, c.faction, c.facet, 0);
  registerBuildingShape(world, b);
  world.emit({ t: 'buildingPlaced', buildingId: b.id, kind: b.kind, faction: b.faction, pos: { x: b.pos.x, z: b.pos.z } });
}

/**
 * Damage a building. The Hearth's HP floors at 1 and it never disables (it can only be
 * overwritten); a GCC at 0 collapses and is rebuilt at the Hearth after GCC.rebuildTime;
 * everything else is disabled at 0 until repaired. Returns true if damaged.
 */
export function damageBuilding(world: World, b: Building, amount: number, by: EntityId | -1): boolean {
  if (amount <= 0 || world.buildings.get(b.id) !== b || b.disabled || isCollapsed(b)) return false;
  if (b.kind === 'hearth' && b.hp <= 1) return false;
  b.hp = b.kind === 'hearth' ? Math.max(1, b.hp - amount) : b.hp - amount;
  // Sub-1 ticks (continuous tearing) stay silent so the event stream is not flooded.
  if (amount >= 1) world.emit({ t: 'hit', target: b.id, by, amount, pos: { x: b.pos.x, y: world.collision.groundHeight(b.pos.x, b.pos.z) + BUILDING_HEIGHT[b.kind] / 2, z: b.pos.z } });
  if (b.hp > 0) return true;
  b.hp = 0;
  if (b.kind === 'gcc') collapseGcc(world, b, world.time + GCC.rebuildTime);
  else disableBuilding(world, b);
  return true;
}

/** Disable a building (0 HP) until repaired to full; capture uses this for captured camps. */
export function disableBuilding(world: World, b: Building): void {
  if (b.kind === 'hearth' || b.disabled) return;
  b.hp = 0;
  b.disabled = true;
  world.emit({ t: 'buildingDisabled', buildingId: b.id, kind: b.kind, faction: b.faction, pos: { x: b.pos.x, z: b.pos.z } });
}

/** Heal a building; a disabled one comes back online when it reaches full HP. */
export function repairBuilding(world: World, b: Building, amount: number): void {
  if (amount <= 0 || isCollapsed(b) || (!b.disabled && b.hp >= b.maxHp)) return;
  b.hp = Math.min(b.maxHp, b.hp + amount);
  if (b.disabled && b.hp >= b.maxHp) {
    b.disabled = false;
    world.emit({ t: 'buildingRepaired', buildingId: b.id, kind: b.kind, faction: b.faction, pos: { x: b.pos.x, z: b.pos.z } });
  }
}

/**
 * Collapse a GCC: no body, no pushing, no channel, rebuilt at the Hearth at `rebuildAt`
 * (Infinity = never, e.g. when its camp is captured). Drops nothing.
 */
export function collapseGcc(world: World, b: Building, rebuildAt: number): void {
  const g = b.gcc;
  if (!g) return;
  b.hp = 0;
  g.destroyedUntil = rebuildAt;
  g.channelUntil = 0;
  g.pushedBy = -1;
  for (const av of world.avatars.values()) if (av.pushing === b.id) av.pushing = -1;
  registerBuildingShape(world, b);
  if (b.faction !== -1) world.emit({ t: 'gccDestroyed', faction: b.faction, gccId: b.id, pos: { x: b.pos.x, z: b.pos.z } });
}

/** Register collision + nav blocking for a building (also used by setup for Hearth/GCC). */
export function registerBuildingShape(world: World, b: Building): void {
  const st = econ(world);
  let ids = st.buildingShapes.get(b.id);
  if (ids) {
    for (const id of ids) world.collision.remove(id);
    ids.length = 0;
  } else {
    ids = [];
    st.buildingShapes.set(b.id, ids);
  }
  world.nav.unblock(b.id);
  if (world.buildings.get(b.id) !== b) { st.buildingShapes.delete(b.id); return; }
  if (isCollapsed(b)) return;
  const r = BUILDINGS[b.kind].radius;
  ids.push(world.collision.addCylinder(b.pos.x, b.pos.z, r, world.collision.groundHeight(b.pos.x, b.pos.z), world.collision.groundHeight(b.pos.x, b.pos.z) + BUILDING_HEIGHT[b.kind], b.id));
  world.nav.blockCircle(b.pos.x, b.pos.z, r, b.id);
}

/**
 * Move a (mobile) building, i.e. the GCC being pushed: updates pos/facet and re-registers its
 * collision shape and nav blocking. Units' avatar/hippie push logic calls this.
 */
export function moveBuilding(world: World, b: Building, x: number, z: number): void {
  b.pos.x = x;
  b.pos.z = z;
  const facet = world.lattice.facetAt(x, z);
  if (facet >= 0) b.facet = facet;
  registerBuildingShape(world, b);
}

/** Own vexillomancer within BUILD_HELP_RADIUS of the footprint, or a hippie building/repairing it. */
function isHelped(world: World, b: Building, f: FactionId): boolean {
  const r = BUILDINGS[b.kind].radius;
  const av = world.avatarOf(f);
  const reach = r + BUILD_HELP_RADIUS;
  if (av && av.koUntil <= world.time && (av.pos.x - b.pos.x) ** 2 + (av.pos.z - b.pos.z) ** 2 <= reach * reach) return true;
  const helperReach = r + HELPER_REACH;
  for (const h of world.hippies.values()) {
    if (h.faction !== f || (h.status !== 'building' && h.status !== 'repairing')) continue;
    if ((h.pos.x - b.pos.x) ** 2 + (h.pos.z - b.pos.z) ** 2 <= helperReach * helperReach) return true;
  }
  return false;
}

/** Vibe-check pulse: ready every WARD_PULSE_INTERVAL, fires the moment an enemy hippie is in range. */
function pulseWard(world: World, b: Building, f: FactionId, dt: number): void {
  b.progress = Math.min(WARD_PULSE_INTERVAL, b.progress + dt);
  if (b.progress < WARD_PULSE_INTERVAL) return;
  const r2 = WARD_PULSE_RADIUS * WARD_PULSE_RADIUS;
  let fired = false;
  for (const h of world.hippies.values()) {
    if (h.faction === f || h.faction === -1 || h.koUntil > world.time) continue;
    if ((h.pos.x - b.pos.x) ** 2 + (h.pos.z - b.pos.z) ** 2 > r2) continue;
    fired = true;
    applyEffect(world, h, 'stun', WARD_PULSE_STUN, 1, b.id);
    damageEntity(world, h.id, WARD_PULSE_DAMAGE, b.id);
  }
  if (!fired) return;
  b.progress = 0;
  world.emit({ t: 'wardPulse', buildingId: b.id, faction: f, pos: { x: b.pos.x, z: b.pos.z } });
}

/**
 * Drug Lab: finish the current batch, then prioritize explicit queued orders. An empty
 * queue automatically picks a stock-weighted random dose. Both modes pay BREW_COST at
 * the start and finish after BREW_TIME. Full-shelf orders are dropped unpaid; automatic
 * production also reserves room for every batch already queued or brewing in the camp.
 */
function brew(world: World, b: Building, f: FactionId, dt: number): void {
  const lab = b.lab;
  if (!lab) return;
  const fac = world.factions[f];
  if (!fac.alive) return;
  while (lab.brewing === null && lab.queue.length > 0) {
    const next = lab.queue[0];
    if (fac.drugs[next] >= DRUG_MAX) {
      lab.queue.shift();
      continue;
    }
    if (fac.lumber < BREW_COST) return;
    fac.lumber -= BREW_COST;
    lab.queue.shift();
    lab.brewing = next;
    lab.progress = 0;
  }
  if (lab.brewing === null && fac.lumber >= BREW_COST && !hasReadyBrewOrder(world, f)) {
    const next = pickAutoBrew(world, f);
    if (next !== null) {
      fac.lumber -= BREW_COST;
      lab.brewing = next;
      lab.progress = 0;
    }
  }
  if (lab.brewing === null) return;
  lab.progress += dt / BREW_TIME;
  if (lab.progress < 1) return;
  const drug = lab.brewing;
  fac.drugs[drug] = Math.min(DRUG_MAX, fac.drugs[drug] + 1);
  lab.brewing = null;
  lab.progress = 0;
  world.emit({ t: 'brewed', faction: f, drug });
}

/** An earlier automatic lab must not spend the lumber needed by a later explicit order. */
function hasReadyBrewOrder(world: World, f: FactionId): boolean {
  const stock = world.factions[f].drugs;
  for (const b of world.buildings.values()) {
    if (b.faction !== f || b.built < 1 || b.disabled || !b.lab || b.lab.brewing !== null) continue;
    if (b.lab.queue.some(drug => stock[drug] < DRUG_MAX)) return true;
  }
  return false;
}

export function updateBuildings(world: World, dt: number): void {
  for (const b of world.buildings.values()) {
    const f = b.faction;
    if (f === -1 || isCollapsed(b)) continue;
    // Captured buildings arrive disabled: their repair always starts from 0 HP.
    if (b.disabled && b.hp >= b.maxHp) b.hp = 0;
    const needsWork = b.built < 1 || b.disabled || b.hp < b.maxHp;
    const helped = needsWork && isHelped(world, b, f);
    if (b.built < 1 && !b.disabled) {
      b.built = Math.min(1, b.built + (dt / BUILD_TIME) * (helped ? BUILD_HELP_MULT : 1));
      if (b.built >= 1) world.emit({ t: 'buildingDone', buildingId: b.id, kind: b.kind, faction: f, pos: { x: b.pos.x, z: b.pos.z } });
    }
    if (helped) repairBuilding(world, b, BUILDING_REPAIR_HPS * dt);
    if (b.built < 1 || b.disabled) continue;
    if (b.kind === 'ward') pulseWard(world, b, f, dt);
  }
  // Settle every lab's availability before spending: an earlier automatic lab must also
  // defer to explicit orders in a later lab that finishes repair/construction this tick.
  for (const b of world.buildings.values()) {
    if (b.kind !== 'druglab' || b.faction === -1 || b.built < 1 || b.disabled) continue;
    brew(world, b, b.faction, dt);
  }
}
