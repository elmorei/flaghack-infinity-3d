import { buildingBaseHeight } from '../buildingGeometry';
/**
 * Crystal instability from overlapping Surveys: per-facet rise/decay, shimmer/discharge/
 * storm thresholds, Flag Psychosis and resonance effects on units inside.
 * Owner: SurveyRules agent.
 *
 * Every tick: instability rises on facets inside ≥ 2 Surveys and decays elsewhere; Stabilize
 * zones hold it at zero. Every SCAN_INTERVAL the unstable facets are grouped into connected
 * clusters, units standing in them are touched by Flag Psychosis / resonance, charged
 * clusters throw Crystal discharges and storm-level clusters flip unobserved nodes.
 */
import {
  DISCHARGE_DAMAGE,
  DISCHARGE_STUN,
  INSTABILITY_DECAY,
  INSTABILITY_DISCHARGE,
  INSTABILITY_RISE,
  INSTABILITY_SHIMMER,
  INSTABILITY_STORM,
  LEVEL_HEIGHT,
  PIECE,
} from '../constants';
import type { V3 } from '../math';
import { FACTION_IDS, NEUTRAL } from '../types';
import type { EntityId, FactionId, StatusEffect } from '../types';
import type { World } from '../world';
import { isAvatarDown } from './avatars';
import { isCollapsed } from './buildings';
import { damageEntity } from './combat';
import { applyEffect } from './effects';
import { applyFlip } from './tides';

const SCAN_INTERVAL = 0.25;
/** Psychosis/resonance last a little longer than a scan so they hold while a unit stays inside. */
const EFFECT_TIME = 0.6;
/** Flag Psychosis: attention drains twice as fast. */
const PSYCHOSIS_MAG = 2;
/** Resonance: +20% work speed (effects.speedMultiplier applies the factor). */
const RESONANCE_MAG = 1.2;
/** A charged cluster throws a discharge every ~2.5 s; the first comes soon after it charges. */
const DISCHARGE_GAP_MIN = 2;
const DISCHARGE_GAP_MAX = 3;
const FIRST_STRIKE_MIN = 0.6;
const FIRST_STRIKE_MAX = 1.6;
/** Storm flips: one attempt per storm cluster every few seconds, never faster than the global gap. */
const STORM_GAP_MIN = 3.5;
const STORM_GAP_MAX = 5.5;
const STORM_GLOBAL_GAP = 1.5;
/** Threshold events are announced once per area: same-or-higher level within this radius/time is muted. */
const ANNOUNCE_RADIUS = 30;
const ANNOUNCE_QUIET = 10;
const RECENT_ANNOUNCEMENTS = 8;
/** Discharges fall from this height onto their target. */
const STRIKE_HEIGHT = 18;
/** A point inside a rhombus lies within this of its centre (half the thin rhombus' long diagonal). */
const FACET_REACH = 8;

const LEVELS = ['shimmer', 'discharge', 'storm'] as const;

interface Affectable {
  id: EntityId;
  effects: StatusEffect[];
}

/** Cross-tick private state of the instability system (lives in world.scratch.instability). */
class InstabilityScratch {
  /**
   * Facets that are overlapped or still carry instability; only these are touched per tick.
   * activeList[0 .. activeCount) lists them, isActive flags membership.
   */
  readonly activeList: Int32Array;
  readonly isActive: Uint8Array;
  activeCount = 0;
  /** survey.version the overlap scan last ran for. */
  surveyVersion = -1;
  /** Per facet: 0 calm, 1 shimmer, 2 discharge, 3 storm (as of the previous tick). */
  readonly level: Uint8Array;
  /** Per facet: cluster index in the current scan, -1 when calm. */
  readonly label: Int32Array;
  /** Per unstable facet: faction holding most of its corners this scan (-1 on a tie). */
  readonly leader: Int8Array;
  readonly queue: Int32Array;
  /** Cluster k's facets are members[start[k] .. start[k + 1]). */
  readonly members: Int32Array;
  readonly start: number[] = [];
  readonly peak: number[] = [];
  /** Smallest facet id of each cluster: keys the cluster's timers across scans. */
  readonly rep: number[] = [];
  readonly dischargeAt: Float64Array;
  readonly stormAt: Float64Array;
  readonly repSeenAt: Float64Array;
  /** Bounding box (facet centres ± FACET_REACH) of every unstable facet this scan. */
  minX = 0;
  maxX = 0;
  minZ = 0;
  maxZ = 0;
  /** Units standing in unstable facets this scan, and their cluster. */
  readonly unitIds: EntityId[] = [];
  readonly unitCluster: number[] = [];
  readonly picks: number[] = [];
  readonly cornerCounts = new Int32Array(4);
  /** Active Stabilize zones this tick. */
  readonly zoneX: number[] = [];
  readonly zoneZ: number[] = [];
  readonly zoneR2: number[] = [];
  readonly recentX = new Float64Array(RECENT_ANNOUNCEMENTS);
  readonly recentZ = new Float64Array(RECENT_ANNOUNCEMENTS);
  readonly recentLevel = new Uint8Array(RECENT_ANNOUNCEMENTS);
  readonly recentAt = new Float64Array(RECENT_ANNOUNCEMENTS).fill(-Infinity);
  recentNext = 0;
  nextScanAt = 0;
  lastStormAt = -Infinity;

  constructor(world: World) {
    const n = world.lattice.facets.length;
    this.activeList = new Int32Array(n);
    this.isActive = new Uint8Array(n);
    this.level = new Uint8Array(n);
    this.label = new Int32Array(n).fill(-1);
    this.leader = new Int8Array(n).fill(-1);
    this.queue = new Int32Array(n);
    this.members = new Int32Array(n);
    this.dischargeAt = new Float64Array(n);
    this.stormAt = new Float64Array(n);
    this.repSeenAt = new Float64Array(n).fill(-Infinity);
  }
}

function scratchOf(world: World): InstabilityScratch {
  const s = world.scratch.instability;
  if (s instanceof InstabilityScratch) return s;
  const fresh = new InstabilityScratch(world);
  world.scratch.instability = fresh;
  return fresh;
}

export function updateInstability(world: World, dt: number): void {
  const sc = scratchOf(world);
  const s = world.survey;
  const facets = world.lattice.facets;
  if (sc.surveyVersion !== s.version) {
    sc.surveyVersion = s.version;
    for (let f = 0; f < facets.length; f++) {
      const mask = s.facetSurvey[f];
      // mask & (mask - 1) clears the lowest bit: non-zero means two or more Surveys overlap.
      if ((mask & (mask - 1)) === 0 || sc.isActive[f] === 1) continue;
      sc.isActive[f] = 1;
      sc.activeList[sc.activeCount++] = f;
    }
  }
  if (sc.activeCount === 0) return;
  collectZones(world, sc);

  let unstable = false;
  for (let i = 0; i < sc.activeCount; ) {
    const f = sc.activeList[i];
    const mask = s.facetSurvey[f];
    const overlapped = (mask & (mask - 1)) !== 0;
    let v = s.facetInstability[f];
    if (overlapped) v = Math.min(1, v + INSTABILITY_RISE * dt);
    else v = Math.max(0, v - INSTABILITY_DECAY * dt);
    if (v > 0 && inZone(sc, facets[f].cx, facets[f].cz)) v = 0;
    s.facetInstability[f] = v;
    const lvl = v >= INSTABILITY_STORM ? 3 : v >= INSTABILITY_DISCHARGE ? 2 : v >= INSTABILITY_SHIMMER ? 1 : 0;
    if (lvl > sc.level[f]) announce(world, sc, f, lvl);
    sc.level[f] = lvl;
    if (lvl > 0) unstable = true;
    if (v === 0 && !overlapped) {
      // Calm again: swap-remove from the active list.
      sc.isActive[f] = 0;
      sc.activeList[i] = sc.activeList[--sc.activeCount];
      continue;
    }
    i++;
  }
  if (!unstable || world.time < sc.nextScanAt) return;
  sc.nextScanAt = world.time + SCAN_INTERVAL;

  labelClusters(world, sc);
  touchUnits(world, sc);
  for (let k = 0; k < sc.rep.length; k++) {
    const rep = sc.rep[k];
    if (sc.repSeenAt[rep] < world.time - 2 * SCAN_INTERVAL) {
      // A cluster that was not here last scan (new, or renamed by a merge/split).
      sc.dischargeAt[rep] = world.time + world.rng.range(FIRST_STRIKE_MIN, FIRST_STRIKE_MAX);
      sc.stormAt[rep] = world.time + world.rng.range(FIRST_STRIKE_MIN, FIRST_STRIKE_MAX);
    }
    sc.repSeenAt[rep] = world.time;
    if (sc.peak[k] >= INSTABILITY_DISCHARGE && world.time >= sc.dischargeAt[rep]) {
      sc.dischargeAt[rep] = world.time + world.rng.range(DISCHARGE_GAP_MIN, DISCHARGE_GAP_MAX);
      discharge(world, sc, k);
    }
  }
  stormFlip(world, sc);
}

// ── Thresholds ───────────────────────────────────────────────────────────────

function announce(world: World, sc: InstabilityScratch, f: number, lvl: number): void {
  const fc = world.lattice.facets[f];
  const r2 = ANNOUNCE_RADIUS * ANNOUNCE_RADIUS;
  for (let i = 0; i < RECENT_ANNOUNCEMENTS; i++) {
    if (sc.recentLevel[i] < lvl || world.time - sc.recentAt[i] >= ANNOUNCE_QUIET) continue;
    const dx = sc.recentX[i] - fc.cx;
    const dz = sc.recentZ[i] - fc.cz;
    if (dx * dx + dz * dz < r2) return;
  }
  const slot = sc.recentNext;
  sc.recentNext = (slot + 1) % RECENT_ANNOUNCEMENTS;
  sc.recentX[slot] = fc.cx;
  sc.recentZ[slot] = fc.cz;
  sc.recentLevel[slot] = lvl;
  sc.recentAt[slot] = world.time;
  const level = LEVELS[lvl - 1];
  world.emit({ t: 'instability', facet: f, level, pos: { x: fc.cx, z: fc.cz } });
  if (level === 'shimmer') return;
  const text =
    level === 'discharge'
      ? 'The overlapping Surveys charge the Crystal. Discharges strike!'
      : 'A Crystal storm: unobserved nodes are turning where the Surveys overlap.';
  const mask = world.survey.facetSurvey[f];
  for (const fid of FACTION_IDS) {
    if (mask & (1 << fid) && world.factions[fid].alive) {
      world.emit({ t: 'notify', faction: fid, text, severity: 'warn', pos: { x: fc.cx, z: fc.cz } });
    }
  }
}

function collectZones(world: World, sc: InstabilityScratch): void {
  sc.zoneX.length = 0;
  sc.zoneZ.length = 0;
  sc.zoneR2.length = 0;
  for (const z of world.zones.values()) {
    if (z.kind !== 'stabilize' || z.until <= world.time) continue;
    sc.zoneX.push(z.pos.x);
    sc.zoneZ.push(z.pos.z);
    sc.zoneR2.push(z.radius * z.radius);
  }
}

function inZone(sc: InstabilityScratch, x: number, z: number): boolean {
  for (let i = 0; i < sc.zoneX.length; i++) {
    const dx = sc.zoneX[i] - x;
    const dz = sc.zoneZ[i] - z;
    if (dx * dx + dz * dz <= sc.zoneR2[i]) return true;
  }
  return false;
}

// ── Clusters ─────────────────────────────────────────────────────────────────

/** Flood-fill facets at shimmer or above into connected clusters (facet adjacency). */
function labelClusters(world: World, sc: InstabilityScratch): void {
  const facets = world.lattice.facets;
  const inst = world.survey.facetInstability;
  sc.label.fill(-1);
  sc.start.length = 0;
  sc.peak.length = 0;
  sc.rep.length = 0;
  sc.minX = Infinity;
  sc.maxX = -Infinity;
  sc.minZ = Infinity;
  sc.maxZ = -Infinity;
  let m = 0;
  for (let f = 0; f < facets.length; f++) {
    if (sc.label[f] !== -1 || inst[f] < INSTABILITY_SHIMMER) continue;
    const k = sc.rep.length;
    sc.rep.push(f);
    sc.start.push(m);
    let peak = 0;
    let head = 0;
    let tail = 0;
    sc.queue[tail++] = f;
    sc.label[f] = k;
    while (head < tail) {
      const g = sc.queue[head++];
      sc.members[m++] = g;
      peak = Math.max(peak, inst[g]);
      sc.leader[g] = cornerLeader(world, sc, g);
      const fc = facets[g];
      sc.minX = Math.min(sc.minX, fc.cx - FACET_REACH);
      sc.maxX = Math.max(sc.maxX, fc.cx + FACET_REACH);
      sc.minZ = Math.min(sc.minZ, fc.cz - FACET_REACH);
      sc.maxZ = Math.max(sc.maxZ, fc.cz + FACET_REACH);
      for (let i = 0; i < 4; i++) {
        const h = fc.neighbors[i];
        if (h < 0 || sc.label[h] !== -1 || inst[h] < INSTABILITY_SHIMMER) continue;
        sc.label[h] = k;
        sc.queue[tail++] = h;
      }
    }
    sc.peak.push(peak);
  }
  sc.start.push(m);
}

/** The faction holding strictly more of the facet's four corners than anyone else, or -1. */
function cornerLeader(world: World, sc: InstabilityScratch, f: number): number {
  const holder = world.survey.holder;
  const corners = world.lattice.facets[f].nodes;
  const counts = sc.cornerCounts;
  counts.fill(0);
  for (let i = 0; i < 4; i++) if (holder[corners[i]] >= 0) counts[holder[corners[i]]]++;
  let best = -1;
  let bestCount = 0;
  let tie = false;
  for (let i = 0; i < 4; i++) {
    if (counts[i] > bestCount) {
      best = i;
      bestCount = counts[i];
      tie = false;
    } else if (counts[i] === bestCount && bestCount > 0) {
      tie = true;
    }
  }
  return tie ? -1 : best;
}

// ── Units ────────────────────────────────────────────────────────────────────

/** Flag Psychosis for the faction holding fewer of a shimmering facet's corners, resonance for the one holding more. */
function touchUnits(world: World, sc: InstabilityScratch): void {
  sc.unitIds.length = 0;
  sc.unitCluster.length = 0;
  for (const av of world.avatars.values()) {
    if (!world.factions[av.faction].alive || isAvatarDown(world, av)) continue;
    const f = unstableFacetAt(world, sc, av.pos.x, av.pos.z);
    if (f >= 0) touch(world, sc, av, av.faction, f);
  }
  for (const h of world.hippies.values()) {
    if (h.faction === NEUTRAL || h.koUntil > world.time) continue;
    const f = unstableFacetAt(world, sc, h.pos.x, h.pos.z);
    if (f >= 0) touch(world, sc, h, h.faction, f);
  }
}

function touch(world: World, sc: InstabilityScratch, unit: Affectable, faction: FactionId, f: number): void {
  if (sc.leader[f] === faction) applyEffect(world, unit, 'resonance', EFFECT_TIME, RESONANCE_MAG);
  else applyEffect(world, unit, 'psychosis', EFFECT_TIME, PSYCHOSIS_MAG);
  sc.unitIds.push(unit.id);
  sc.unitCluster.push(sc.label[f]);
}

function unstableFacetAt(world: World, sc: InstabilityScratch, x: number, z: number): number {
  if (x < sc.minX || x > sc.maxX || z < sc.minZ || z > sc.maxZ) return -1;
  const f = world.lattice.facetAt(x, z);
  return f >= 0 && sc.label[f] >= 0 ? f : -1;
}

// ── Discharges ───────────────────────────────────────────────────────────────

/**
 * Crystal discharge: lightning onto a random unit, piece or building standing in cluster k
 * (stun for units, damage for structures), or into the ground when nothing is there.
 */
function discharge(world: World, sc: InstabilityScratch, k: number): void {
  const lat = world.lattice;
  const picks = sc.picks;
  picks.length = 0;
  for (let i = 0; i < sc.unitIds.length; i++) if (sc.unitCluster[i] === k) picks.push(sc.unitIds[i]);
  for (const b of world.buildings.values()) {
    if (b.facet >= 0 && sc.label[b.facet] === k && !isCollapsed(b)) picks.push(b.id);
  }
  for (const p of world.pieces.values()) {
    if (p.facet >= 0 ? sc.label[p.facet] === k : p.edge >= 0 && edgeInCluster(world, sc, p.edge, k)) picks.push(p.id);
  }

  let target: EntityId | -1 = -1;
  let to: V3;
  if (picks.length > 0) {
    target = picks[world.rng.int(0, picks.length - 1)];
    to = strikePoint(world, target);
  } else {
    const from = sc.start[k];
    const g = sc.members[from + world.rng.int(0, sc.start[k + 1] - from - 1)];
    to = { x: lat.facets[g].cx, y: world.collision.groundHeight(lat.facets[g].cx, lat.facets[g].cz), z: lat.facets[g].cz };
  }
  const sky: V3 = { x: to.x + world.rng.range(-3, 3), y: STRIKE_HEIGHT, z: to.z + world.rng.range(-3, 3) };
  world.emit({ t: 'discharge', from: sky, to, target });

  const av = world.avatars.get(target);
  const h = world.hippies.get(target);
  if (av) applyEffect(world, av, 'stun', DISCHARGE_STUN);
  else if (h) applyEffect(world, h, 'stun', DISCHARGE_STUN);
  else if (target >= 0) damageEntity(world, target, DISCHARGE_DAMAGE, -1);
}

function edgeInCluster(world: World, sc: InstabilityScratch, edge: number, k: number): boolean {
  const fs = world.lattice.edges[edge].facets;
  for (let i = 0; i < fs.length; i++) if (sc.label[fs[i]] === k) return true;
  return false;
}

/** Where a discharge lands on an entity (chest height for units, roof for structures). */
function strikePoint(world: World, id: EntityId): V3 {
  const lat = world.lattice;
  const av = world.avatars.get(id);
  if (av) return { x: av.pos.x, y: av.pos.y + 1.2, z: av.pos.z };
  const h = world.hippies.get(id);
  if (h) return { x: h.pos.x, y: world.collision.groundHeight(h.pos.x, h.pos.z) + (h.airborne?.y ?? 0) + 1, z: h.pos.z };
  const b = world.buildings.get(id);
  if (b) return { x: b.pos.x, y: buildingBaseHeight(world, b) + 2, z: b.pos.z };
  const p = world.pieces.get(id);
  if (p && p.facet >= 0) {
    const fc = lat.facets[p.facet];
    return { x: fc.cx, y: world.collision.groundHeight(fc.cx, fc.cz) + p.level * LEVEL_HEIGHT + 0.2, z: fc.cz };
  }
  if (p && p.edge >= 0) {
    const e = lat.edges[p.edge];
    const a = lat.nodes[e.a];
    const bn = lat.nodes[e.b];
    return { x: (a.x + bn.x) / 2, y: world.collision.groundHeight((a.x + bn.x) / 2, (a.z + bn.z) / 2) + p.level * LEVEL_HEIGHT + PIECE.wallHeight / 2, z: (a.z + bn.z) / 2 };
  }
  return { x: 0, y: 0, z: 0 };
}

// ── Storms ───────────────────────────────────────────────────────────────────

/**
 * Storm-level clusters turn the Crystal: a random flippable, unobserved corner of a storm
 * facet flips. At most one storm flip per scan (topology changes invalidate the clusters).
 */
function stormFlip(world: World, sc: InstabilityScratch): void {
  if (world.time < sc.lastStormAt + STORM_GLOBAL_GAP) return;
  const lat = world.lattice;
  const s = world.survey;
  const picks = sc.picks;
  for (let k = 0; k < sc.rep.length; k++) {
    const rep = sc.rep[k];
    if (sc.peak[k] < INSTABILITY_STORM || world.time < sc.stormAt[rep]) continue;
    sc.stormAt[rep] = world.time + world.rng.range(STORM_GAP_MIN, STORM_GAP_MAX);
    picks.length = 0;
    for (let i = sc.start[k]; i < sc.start[k + 1]; i++) {
      const g = sc.members[i];
      if (s.facetInstability[g] < INSTABILITY_STORM) continue;
      for (const n of lat.facets[g].nodes) {
        if (s.nodeObserved[n] === 0 && lat.flippable(n) && !picks.includes(n)) picks.push(n);
      }
    }
    if (picks.length === 0) continue;
    if (applyFlip(world, picks[world.rng.int(0, picks.length - 1)], 'storm')) {
      sc.lastStormAt = world.time;
      return;
    }
  }
}
