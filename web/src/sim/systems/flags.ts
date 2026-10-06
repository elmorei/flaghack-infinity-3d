/**
 * Flag lifecycle: stock → carried → planted/loose/flying → … Conservation: Flags are never
 * destroyed except by explicit design (none in v1). Every state change appends history,
 * updates SurveyState node arrays and marks the survey dirty.
 *
 * Inventories live here: every function that moves a Flag first detaches it from wherever it
 * was (avatar quiver, hippie hands, node, stock, projectile) and then attaches it to its new
 * place, so callers never splice `avatar.carried` or set `hippie.carryingFlag` themselves
 * (the throw, which hands a Flag to a projectile, is the one exception and lives in Units).
 * Owner: SurveyRules agent.
 */
import { AVATAR, BUILDING_HEIGHT, CRYSTAL_HEIGHT, LIGHTNING_PULL_MULT, PULL_LIGHTNING_INTERVAL, SIM_HZ, WARD_FLAG_RADIUS } from '../constants';
import { spawnFlag } from '../factory';
import type { V2, V3 } from '../math';
import { NEUTRAL } from '../types';
import type { Avatar, EntityId, FactionId, Flag, FlagState, Hippie, Owner } from '../types';
import type { World } from '../world';
import { isFlagProtected } from './abilities';
import { isCollapsed } from './buildings';
import { isFactionId } from './rules/factions';
import { markSurveyDirty } from './survey';

/** Flag.history keeps only the newest entries. */
const HISTORY_CAP = 16;

/** Reused output buffer for lattice radius queries (the sim is single-threaded). */
const nearScratch: number[] = [];

type Carrier = Avatar | Hippie;

/** Live enemy pull rate: Wards and fully manifested Crystals defend their Flags without stacking. */
export function defendedPullRate(world: World, fl: Flag, puller: FactionId, starting = false): number {
  if (fl.state !== 'planted' || fl.owner === NEUTRAL || fl.owner === puller) return 1;
  const lightning = starting || world.tick % Math.round(PULL_LIGHTNING_INTERVAL * SIM_HZ) === 0;
  // A Crystal protects only its five sustaining nodes, including either node of a simulacrum.
  for (const crystal of world.crystals.values()) {
    if (crystal.faction !== fl.owner || crystal.growth < 1) continue;
    if (!crystal.pentacle.includes(fl.node) && !(fl.altNode >= 0 && crystal.pentacle.includes(fl.altNode))) continue;
    const node = world.lattice.nodes[crystal.pentacle.includes(fl.node) ? fl.node : fl.altNode];
    if (lightning) {
      world.emit({ t: 'crystalLightning', crystalId: crystal.id, flagId: fl.id, faction: crystal.faction,
        from: { x: crystal.pos.x, y: CRYSTAL_HEIGHT, z: crystal.pos.z },
        to: { x: node.x, y: fl.pos.y + 2, z: node.z } });
    }
    return 1 / LIGHTNING_PULL_MULT;
  }
  for (const ward of world.buildings.values()) {
    if (ward.kind !== 'ward' || ward.faction !== fl.owner || ward.built < 1 || ward.disabled) continue;
    if ((ward.pos.x - fl.pos.x) ** 2 + (ward.pos.z - fl.pos.z) ** 2 > WARD_FLAG_RADIUS ** 2) continue;
    if (lightning) {
      world.emit({ t: 'wardLightning', buildingId: ward.id, flagId: fl.id, faction: ward.faction,
        from: { x: ward.pos.x, y: BUILDING_HEIGHT.ward, z: ward.pos.z },
        to: { x: fl.pos.x, y: fl.pos.y + 2, z: fl.pos.z } });
    }
    return 1 / LIGHTNING_PULL_MULT;
  }
  return 1;
}

/** Can `faction` plant here? Terrain, occupied nodes and crystals always block placement. */
export function canPlantAt(world: World, node: number, faction: FactionId): boolean {
  const lat = world.lattice;
  if (!Number.isInteger(node) || node < 0 || node >= lat.nodes.length) return false;
  if (!world.factions[faction].alive) return false;
  if (lat.nodes[node].blocked || world.survey.nodeFlag[node] >= 0) return false;
  for (const c of world.crystals.values()) if (c.node === node) return false;
  return world.options.match?.structuresBlockFlagPlacement !== true || !isBuildingCorner(world, node);
}

/**
 * Is `node` a corner of a facet hosting a standing building? Buildings pin their facet:
 * the Crystal never flips them, and optional structure blocking reserves them for planting.
 * A collapsed GCC no longer pins anything.
 */
export function isBuildingCorner(world: World, node: number): boolean {
  const facets = world.lattice.facets;
  for (const b of world.buildings.values()) {
    if (b.facet < 0 || isCollapsed(b)) continue;
    const ns = facets[b.facet].nodes;
    if (ns[0] === node || ns[1] === node || ns[2] === node || ns[3] === node) return true;
  }
  return false;
}

/**
 * Plant a held Flag (carried by `by`, or flying) on `node` for `owner`. Removes it from the
 * carrier's inventory, sets state 'planted', emits flagPlanted, marks survey dirty.
 * Returns false (and changes nothing) if invalid. Loose and stock Flags may be planted too
 * (GCC Flag Repair, setup).
 */
export function plantFlag(world: World, flagId: EntityId, node: number, owner: FactionId, by: EntityId | -1): boolean {
  const fl = world.flags.get(flagId);
  if (!fl || fl.state === 'planted' || !canPlantAt(world, node, owner)) return false;
  detach(world, fl);
  settle(world, fl, node, owner);
  record(world, fl, 'planted', by);
  world.factions[owner].stats.flagsPlanted++;
  world.emit({ t: 'flagPlanted', flagId, node, faction: owner, by, pos: { ...fl.pos } });
  markSurveyDirty(world);
  return true;
}

/**
 * Flag Simulacra: plant one Flag superposed on two free nodes at once. It counts as a real
 * Flag on both (`node` = a, `altNode` = b) until observed by an enemy, when it collapses
 * (see collapseSimulacrum). Emits flagPlanted for each node. Returns false if invalid.
 */
export function plantSimulacrum(
  world: World,
  flagId: EntityId,
  a: number,
  b: number,
  owner: FactionId,
  by: EntityId | -1,
): boolean {
  const fl = world.flags.get(flagId);
  if (!fl || fl.state === 'planted' || a === b) return false;
  if (!canPlantAt(world, a, owner) || !canPlantAt(world, b, owner)) return false;
  detach(world, fl);
  settle(world, fl, a, owner);
  fl.altNode = b;
  occupy(world, fl, b);
  record(world, fl, 'planted', by);
  world.factions[owner].stats.flagsPlanted++;
  const nb = world.lattice.nodes[b];
  world.emit({ t: 'flagPlanted', flagId, node: a, faction: owner, by, pos: { ...fl.pos } });
  world.emit({ t: 'flagPlanted', flagId, node: b, faction: owner, by, pos: { x: nb.x, y: 0, z: nb.z } });
  markSurveyDirty(world);
  return true;
}

/**
 * Collapse a superposed Flag onto `keep` (one of its two nodes); the twin vanishes with a
 * glitch. Happens when an enemy observes it, when one of its nodes flips, or when its
 * caster's Flags are neutralized.
 */
export function collapseSimulacrum(world: World, fl: Flag, keep: number): void {
  if (fl.state !== 'planted' || fl.altNode < 0 || (keep !== fl.node && keep !== fl.altNode)) return;
  const vanished = keep === fl.node ? fl.altNode : fl.node;
  vacate(world, fl, vanished);
  const n = world.lattice.nodes[keep];
  fl.node = keep;
  fl.altNode = -1;
  fl.pos.x = n.x;
  fl.pos.z = n.z;
  record(world, fl, 'planted', -1);
  if (fl.owner !== NEUTRAL) {
    world.emit({ t: 'simulacrumCollapsed', flagId: fl.id, kept: keep, vanished, faction: fl.owner });
  }
  markSurveyDirty(world);
}

/**
 * Pull a planted or loose Flag. If `carrier` (avatar or hippie id) can hold it, it becomes
 * carried by them (owner = carrier faction); otherwise it drops loose at its position (or at
 * `dropAt`, e.g. an Omega Pulse flinging it outward). Emits flagPulled. Counts flagsStolen
 * when prev owner differs. Enemy pulls (and knock-loose pulls with carrier -1) respect Stabilize
 * L3 protection. A loose Flag nobody can hold stays put (returns false).
 */
export function pullFlag(world: World, flagId: EntityId, carrier: EntityId | -1, dropAt?: V3): boolean {
  const fl = world.flags.get(flagId);
  if (!fl || (fl.state !== 'planted' && fl.state !== 'loose')) return false;
  const c = carrier >= 0 ? carrierOf(world, carrier) : undefined;
  const puller: Owner = c ? c.faction : NEUTRAL;
  const prevOwner = fl.owner;
  const wasPlanted = fl.state === 'planted';
  if (wasPlanted && prevOwner !== puller && isFlagProtected(world, fl)) return false;
  const taker = c ? holdingFaction(world, c) : null;
  if (taker === null && !wasPlanted) return false;
  const node = fl.node;
  detach(world, fl);
  if (c && taker !== null) {
    attach(world, fl, c, taker);
  } else {
    if (dropAt) layDown(world, fl, dropAt);
    else fl.tilt = 1;
    record(world, fl, 'loose', carrier);
  }
  if (isFactionId(puller)) {
    const stats = world.factions[puller].stats;
    if (wasPlanted) stats.flagsPulled++;
    if (taker !== null && isFactionId(prevOwner) && prevOwner !== taker) stats.flagsStolen++;
  }
  world.emit({ t: 'flagPulled', flagId, node, faction: fl.owner, prevOwner, by: carrier, pos: { ...fl.pos } });
  return true;
}

/** Drop a Flag loose at a world position (KO, overflow, decoherence). Works from any state. */
export function dropLoose(world: World, flagId: EntityId, at: V3): void {
  const fl = world.flags.get(flagId);
  if (!fl) return;
  const by = fl.state === 'carried' || fl.state === 'flying' ? fl.holder : -1;
  detach(world, fl);
  layDown(world, fl, at);
  record(world, fl, 'loose', by);
}

/** Move one Flag from a Hearth's stock into a carrier's hands. Returns the Flag or null. */
export function takeFromStock(world: World, hearthId: EntityId, carrier: EntityId): Flag | null {
  const hearth = world.buildings.get(hearthId);
  const c = carrierOf(world, carrier);
  if (!hearth || hearth.kind !== 'hearth' || !c) return null;
  const taker = holdingFaction(world, c);
  if (taker === null || taker !== hearth.faction) return null;
  for (const fl of world.flags.values()) {
    if (fl.state !== 'stock' || fl.holder !== hearthId) continue;
    detach(world, fl);
    attach(world, fl, c, taker);
    return fl;
  }
  return null;
}

/**
 * Hand a Flag that is not planted or in flight (quiver, hands, stock, loose) to a carrier,
 * e.g. Flag recruitment. The carrier's faction becomes the owner. Returns false if it can't hold it.
 */
export function giveFlag(world: World, flagId: EntityId, carrier: EntityId): boolean {
  const fl = world.flags.get(flagId);
  const c = carrierOf(world, carrier);
  if (!fl || !c || fl.state === 'planted' || fl.state === 'flying') return false;
  if (fl.state === 'carried' && fl.holder === carrier) return false;
  const taker = holdingFaction(world, c);
  if (taker === null) return false;
  detach(world, fl);
  attach(world, fl, c, taker);
  return true;
}

/** Put a carried/loose Flag into a Hearth's stock (owner becomes the Hearth's faction). */
export function depositToStock(world: World, flagId: EntityId, hearthId: EntityId): void {
  const fl = world.flags.get(flagId);
  const hearth = world.buildings.get(hearthId);
  if (!fl || !hearth || hearth.kind !== 'hearth' || hearth.faction === NEUTRAL) return;
  const by = fl.state === 'carried' ? fl.holder : -1;
  detach(world, fl);
  fl.owner = hearth.faction;
  fl.holder = hearth.id;
  fl.pos.x = hearth.pos.x;
  fl.pos.y = 0;
  fl.pos.z = hearth.pos.z;
  fl.tilt = 0;
  record(world, fl, 'stock', by);
}

/** Create a brand-new Flag in a Hearth's stock (crafting). Emits flagCrafted. */
export function craftFlag(world: World, hearthId: EntityId): Flag | null {
  const hearth = world.buildings.get(hearthId);
  if (!hearth || hearth.kind !== 'hearth') return null;
  const f = hearth.faction;
  if (f === NEUTRAL) return null;
  const fl = spawnFlag(world, { state: 'stock', owner: f, holder: hearth.id, pos: { x: hearth.pos.x, y: 0, z: hearth.pos.z } });
  world.emit({ t: 'flagCrafted', flagId: fl.id, faction: f, at: hearth.id });
  return fl;
}

/** Nearest node within radius where `faction` could plant, or -1. */
export function nearestPlantableNode(world: World, at: V2, radius: number, faction: FactionId): number {
  const nodes = world.lattice.nodes;
  nearScratch.length = 0;
  world.lattice.nodesInRadius(at.x, at.z, radius, nearScratch);
  let best = -1;
  let bestD = Infinity;
  for (const id of nearScratch) {
    const dx = nodes[id].x - at.x;
    const dz = nodes[id].z - at.z;
    const d = dx * dx + dz * dz;
    if (d < bestD && canPlantAt(world, id, faction)) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/**
 * Re-own every planted Flag of `from` as `to` (capture/elimination); `only` narrows it to
 * some of them (the camp of a captured outpost). Superposition cannot outlive its caster:
 * simulacra collapse (seeded 50/50) before turning neutral.
 */
export function transferFlags(world: World, from: FactionId, to: Owner, only?: (fl: Flag) => boolean): void {
  const s = world.survey;
  let changed = false;
  for (const fl of world.flags.values()) {
    if (fl.state !== 'planted' || fl.owner !== from || (only && !only(fl))) continue;
    if (to === NEUTRAL && fl.altNode >= 0) collapseSimulacrum(world, fl, world.rng.chance(0.5) ? fl.node : fl.altNode);
    fl.owner = to;
    s.nodeFlagOwner[fl.node] = to;
    if (fl.altNode >= 0) s.nodeFlagOwner[fl.altNode] = to;
    changed = true;
  }
  if (changed) markSurveyDirty(world);
}

// ── Internals ────────────────────────────────────────────────────────────────

function carrierOf(world: World, id: EntityId): Carrier | undefined {
  return world.avatars.get(id) ?? world.hippies.get(id);
}

/** Faction that would take a Flag into `c`'s hands, or null if it cannot hold another one. */
function holdingFaction(world: World, c: Carrier): FactionId | null {
  if (c.koUntil > world.time) return null;
  if (c.type === 'avatar') {
    return world.factions[c.faction].alive && c.carried.length < AVATAR.quiver ? c.faction : null;
  }
  const f = c.faction;
  if (f === NEUTRAL || !world.factions[f].alive) return null;
  // Hippies carry one Flag or one load of lumber, never both.
  return c.carryingFlag === -1 && c.carryingLumber === 0 ? f : null;
}

/** Remove a Flag from wherever it currently is (inventory, node, stock, projectile). */
function detach(world: World, fl: Flag): void {
  if (fl.state === 'carried') {
    const av = world.avatars.get(fl.holder);
    if (av) {
      const i = av.carried.indexOf(fl.id);
      if (i >= 0) av.carried.splice(i, 1);
    }
    const h = world.hippies.get(fl.holder);
    if (h && h.carryingFlag === fl.id) h.carryingFlag = -1;
  } else if (fl.state === 'planted') {
    vacate(world, fl, fl.node);
    vacate(world, fl, fl.altNode);
    markSurveyDirty(world);
  }
  fl.holder = -1;
  fl.node = -1;
  fl.altNode = -1;
}

function attach(world: World, fl: Flag, c: Carrier, f: FactionId): void {
  fl.owner = f;
  fl.holder = c.id;
  fl.tilt = 0;
  fl.pos.x = c.pos.x;
  fl.pos.z = c.pos.z;
  if (c.type === 'avatar') {
    c.carried.push(fl.id);
    fl.pos.y = c.pos.y;
  } else {
    c.carryingFlag = fl.id;
    fl.pos.y = 0;
  }
  record(world, fl, 'carried', c.id);
}

/** Stand a detached Flag upright on `node` for `owner`, claiming the node in the survey arrays. */
function settle(world: World, fl: Flag, node: number, owner: FactionId): void {
  const n = world.lattice.nodes[node];
  fl.owner = owner;
  fl.node = node;
  fl.pos.x = n.x;
  fl.pos.y = 0;
  fl.pos.z = n.z;
  fl.tilt = 0;
  fl.plantedAt = world.time;
  occupy(world, fl, node);
}

/** Lay a Flag on the highest walkable surface under `at` (decks catch falling Flags). */
function layDown(world: World, fl: Flag, at: V3): void {
  fl.pos.x = at.x;
  fl.pos.z = at.z;
  fl.pos.y = world.collision.supportHeight(at.x, at.z, Math.max(0, at.y) + 0.1);
  fl.tilt = 1;
}

function occupy(world: World, fl: Flag, node: number): void {
  world.survey.nodeFlag[node] = fl.id;
  world.survey.nodeFlagOwner[node] = fl.owner;
}

function vacate(world: World, fl: Flag, node: number): void {
  const s = world.survey;
  if (node < 0 || s.nodeFlag[node] !== fl.id) return;
  s.nodeFlag[node] = -1;
  s.nodeFlagOwner[node] = -1;
}

/** Commit a state change: state, timestamp and a capped history entry. */
function record(world: World, fl: Flag, state: FlagState, by: EntityId | -1): void {
  fl.state = state;
  fl.lastMovedAt = world.time;
  fl.history.push({ t: world.time, x: fl.pos.x, z: fl.pos.z, state, by });
  if (fl.history.length > HISTORY_CAP) fl.history.splice(0, fl.history.length - HISTORY_CAP);
}
