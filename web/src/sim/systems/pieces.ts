/**
 * Fortnite-speed build pieces snapped to the Ley Lattice: walls on edges, decks (floors) and
 * ramps on facets, levels 0..MAX_BUILD_LEVEL, support rules, lumber costs, collision + nav
 * registration, damage/destruction, demolish refunds. Also used by UI ghosts (canBuildPiece).
 * Owner: Economy agent.
 *
 * Heights and footprints live in econ/pieceGeometry.ts. Support (level 0 stands on the ground):
 * - wall (e, L): a wall on e at L-1, or a deck at L-1 (or a ramp at L-1 whose high edge is e)
 *   on a facet beside e: the wall stands on its top.
 * - deck/ramp (F, L): a deck or ramp at L-1 on F or an edge-adjacent facet. A ramp may also
 *   rest its low edge on a wall at L-1; a deck may also rest on walls of its own level along
 *   its edges, or on the high end of an adjacent ramp of its own level.
 * Same-level supports only point at walls/ramps, which themselves only lean on lower levels,
 * so the support graph is acyclic and destruction cascades upward deterministically.
 *
 * Floors and ramps share the facet slot of a level: one of them per (facet, level).
 */
import { leavePieceWreckage } from '../wreckage';
import type { CommandOf } from '../commands';
import { LEVEL_HEIGHT, MAX_BUILD_LEVEL, PIECE, PIECE_REACH } from '../constants';
import { spawnPiece } from '../factory';
import type { V3 } from '../math';
import type { EntityId, FactionId, Piece, PieceKind } from '../types';
import type { World } from '../world';
import type { PlacementCheck } from './buildings';
import { polygonClearance, polygonHitsBuilding, segmentClearance, segmentHitsBuilding } from './econ/clearance';
import {
  DECK_THICKNESS,
  facetInradius,
  facetPolygon,
  pieceBottom,
  pieceGroundHeight,
  RAMP_THICKNESS,
  rampHighEdge,
  slotCenter,
  slotKey,
  stiltFoot,
  STILT_RADIUS,
  wallSegment,
} from './econ/pieceGeometry';
import { econ } from './econ/state';
import type { EconState } from './econ/state';

/** Level-0 ramps block hippie navigation over this share of the facet's inradius. */
const RAMP_NAV_SHARE = 0.85;

const OK: PlacementCheck = Object.freeze({ ok: true, reason: '' });
/** Shared frozen rejections: UI ghosts call canBuildPiece every frame, so it allocates nothing. */
const NO = {
  level: { ok: false, reason: `Build levels run from 0 to ${MAX_BUILD_LEVEL}.` },
  edge: { ok: false, reason: 'No Ley edge under the crosshair.' },
  facet: { ok: false, reason: 'No Ley facet under the crosshair.' },
  rampEdge: { ok: false, reason: 'A ramp needs a low edge (0-3).' },
  ko: { ok: false, reason: 'Flagless vexillomancers cannot build.' },
  reach: { ok: false, reason: `Too far: build within ${PIECE_REACH} m of your vexillomancer.` },
  occupied: { ok: false, reason: 'Something is already built here.' },
  support: { ok: false, reason: 'Needs support: a wall, deck or ramp one level below.' },
  building: { ok: false, reason: 'A camp building stands in the way.' },
  obstacle: { ok: false, reason: 'The burn is in the way (tent, tree or art).' },
  water: { ok: false, reason: 'Tarps will not stand in the pond.' },
  lumber: { ok: false, reason: `Not enough lumber (${PIECE.cost} needed).` },
} satisfies Record<string, PlacementCheck>;
for (const r of Object.values(NO)) Object.freeze(r);

const SEG = [0, 0, 0, 0];
const POLY_X = [0, 0, 0, 0];
const POLY_Z = [0, 0, 0, 0];
const FOOT = [0, 0];
const CENTER: V3 = { x: 0, y: 0, z: 0 };

/** Existing piece occupying a slot, or undefined. Floors and ramps share the facet slot. */
export function pieceAt(world: World, kind: PieceKind, edge: number, facet: number, level: number): Piece | undefined {
  if (level < 0 || level > MAX_BUILD_LEVEL) return undefined;
  const st = econ(world);
  const id = kind === 'wall' ? st.edgeSlots.get(slotKey(edge, level)) : st.facetSlots.get(slotKey(facet, level));
  return id === undefined ? undefined : world.pieces.get(id);
}

function wallAt(world: World, st: EconState, edge: number, level: number): boolean {
  const id = st.edgeSlots.get(slotKey(edge, level));
  return id !== undefined && world.pieces.has(id);
}

function facetPieceAt(world: World, st: EconState, facet: number, level: number): Piece | undefined {
  const id = st.facetSlots.get(slotKey(facet, level));
  return id === undefined ? undefined : world.pieces.get(id);
}

/** Would a piece in this slot be supported right now? (Level 0 always is.) */
export function isSupported(world: World, kind: PieceKind, edge: number, facet: number, level: number, rampEdge: number): boolean {
  if (level <= 0) return true;
  const lat = world.lattice;
  const st = econ(world);
  const below = level - 1;
  if (kind === 'wall') {
    if (!lat.edges[edge]) return false;
    if (wallAt(world, st, edge, below)) return true;
    for (const f of lat.edges[edge].facets) {
      const p = facetPieceAt(world, st, f, below);
      if (p && (p.kind === 'floor' || rampHighEdge(lat, p.facet, p.rampEdge) === edge)) return true;
    }
    return false;
  }
  const fc = lat.facets[facet];
  if (!fc) return false;
  if (facetPieceAt(world, st, facet, below)) return true;
  for (const n of fc.neighbors) if (n >= 0 && facetPieceAt(world, st, n, below)) return true;
  if (kind === 'ramp') return wallAt(world, st, fc.edges[rampEdge], below);
  for (let i = 0; i < 4; i++) {
    if (wallAt(world, st, fc.edges[i], level)) return true;
    const n = fc.neighbors[i];
    if (n < 0) continue;
    const p = facetPieceAt(world, st, n, level);
    if (p && p.kind === 'ramp' && rampHighEdge(lat, n, p.rampEdge) === fc.edges[i]) return true;
  }
  return false;
}

export function canBuildPiece(
  world: World,
  f: FactionId,
  kind: PieceKind,
  edge: number,
  facet: number,
  level: number,
  rampEdge: number,
): PlacementCheck {
  const lat = world.lattice;
  if (!Number.isInteger(level) || level < 0 || level > MAX_BUILD_LEVEL) return NO.level;
  if (kind === 'wall') {
    if (!Number.isInteger(edge) || edge < 0 || edge >= lat.edges.length) return NO.edge;
  } else {
    if (!Number.isInteger(facet) || facet < 0 || facet >= lat.facets.length) return NO.facet;
    if (kind === 'ramp' && (!Number.isInteger(rampEdge) || rampEdge < 0 || rampEdge > 3)) return NO.rampEdge;
  }
  const av = world.avatarOf(f);
  if (!av || av.koUntil > world.time) return NO.ko;
  slotCenter(lat, kind, edge, facet, level, CENTER);
  if ((av.pos.x - CENTER.x) ** 2 + (av.pos.z - CENTER.z) ** 2 > PIECE_REACH * PIECE_REACH) return NO.reach;
  if (pieceAt(world, kind, edge, facet, level)) return NO.occupied;
  if (!isSupported(world, kind, edge, facet, level, rampEdge)) return NO.support;

  const y0 = pieceBottom(kind, level);
  if (kind === 'wall') {
    wallSegment(lat, edge, SEG);
    const hw = PIECE.wallThickness / 2;
    if (segmentHitsBuilding(world, SEG[0], SEG[1], SEG[2], SEG[3], hw, y0)) return NO.building;
    const clear = segmentClearance(world, SEG[0], SEG[1], SEG[2], SEG[3], hw, y0);
    if (clear !== 'clear') return NO[clear];
  } else {
    facetPolygon(lat, facet, POLY_X, POLY_Z);
    if (polygonHitsBuilding(world, POLY_X, POLY_Z, y0)) return NO.building;
    const clear = polygonClearance(world, POLY_X, POLY_Z, y0);
    if (clear !== 'clear') return NO[clear];
    if (kind === 'floor' && level === 0) {
      // Level-0 decks stand on stilts reaching the ground.
      for (let i = 0; i < 4; i++) {
        stiltFoot(lat, facet, i, FOOT);
        const stilt = segmentClearance(world, FOOT[0], FOOT[1], FOOT[0], FOOT[1], STILT_RADIUS, 0);
        if (stilt !== 'clear') return NO[stilt];
      }
    }
  }
  if (world.factions[f].lumber < PIECE.cost) return NO.lumber;
  return OK;
}

export function cmdBuild(world: World, c: CommandOf<'build'>): void {
  const chk = canBuildPiece(world, c.faction, c.kind, c.edge, c.facet, c.level, c.rampEdge);
  if (!chk.ok) {
    world.emit({ t: 'rejected', faction: c.faction, reason: chk.reason });
    return;
  }
  world.factions[c.faction].lumber -= PIECE.cost;
  const isWall = c.kind === 'wall';
  const p = spawnPiece(world, c.kind, c.faction, isWall ? c.edge : -1, isWall ? -1 : c.facet, c.level, c.kind === 'ramp' ? c.rampEdge : -1);
  const info = indexPiece(world, p);
  registerPieceShapes(world, p);
  world.emit({ t: 'pieceBuilt', pieceId: p.id, kind: p.kind, faction: p.faction, pos: { x: info.x, y: info.y, z: info.z } });
}

export function cmdDemolish(world: World, c: CommandOf<'demolish'>): void {
  if (world.factions[c.faction].controlMode === 'rts' || !world.avatarOf(c.faction)) return;
  const p = world.pieces.get(c.pieceId);
  if (!p) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'That piece is already gone.' });
    return;
  }
  if (p.faction !== c.faction) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'Only your own pieces can be demolished.' });
    return;
  }
  world.factions[c.faction].lumber += PIECE.refund;
  destroyPiece(world, p);
}

export function damagePiece(world: World, p: Piece, amount: number, by: EntityId | -1): boolean {
  if (amount <= 0 || world.pieces.get(p.id) !== p) return false;
  p.hp -= amount;
  // Sub-1 ticks (continuous tearing) stay silent so the event stream is not flooded.
  if (amount >= 1) {
    const info = econ(world).pieceInfo.get(p.id);
    if (info) world.emit({ t: 'hit', target: p.id, by, amount, pos: { x: info.x, y: info.y, z: info.z } });
  }
  if (p.hp <= 0) destroyPiece(world, p, world.boss?.id === by);
  return true;
}

/** Heal a piece (GCC Flag Repair); never above max HP. */
export function repairPiece(p: Piece, amount: number): void {
  p.hp = Math.min(p.maxHp, p.hp + amount);
}

/** World position of a standing piece (its slot centre when built), or undefined. */
export function piecePosition(world: World, p: Piece): Readonly<V3> | undefined {
  return econ(world).pieceInfo.get(p.id);
}

/**
 * Remove a piece (collision, nav, slot index), emit pieceDestroyed, then destroy every piece
 * above that lost its support, breadth-first in lattice order.
 */
export function destroyPiece(world: World, p: Piece, bossDestroyed = false): void {
  const queue: Piece[] = [p];
  const deps: Piece[] = [];
  for (let qi = 0; qi < queue.length; qi++) {
    const q = queue[qi];
    if (world.pieces.get(q.id) !== q) continue;
    removePiece(world, q, bossDestroyed);
    deps.length = 0;
    collectDependents(world, q, deps);
    for (const d of deps) {
      if (!queue.includes(d) && !isSupported(world, d.kind, d.edge, d.facet, d.level, d.rampEdge)) queue.push(d);
    }
  }
}

function removePiece(world: World, p: Piece, bossDestroyed: boolean): void {
  const info = econ(world).pieceInfo.get(p.id);
  const pos = info ? { x: info.x, y: info.y, z: info.z } : { x: 0, y: 0, z: 0 };
  if (bossDestroyed) leavePieceWreckage(world, p);
  detachPiece(world, p);
  world.emit({ t: 'pieceDestroyed', pieceId: p.id, kind: p.kind, faction: p.faction, pos, ...(bossDestroyed ? { bossDestroyed: true as const } : {}) });
}

/**
 * Take a piece out of the world: collision, nav blocking, slot index and the pieces map. No
 * event, no cascade, no refund. Replicated mirrors (net/mirror.ts) use it to follow the host,
 * which already decided what fell.
 */
export function detachPiece(world: World, p: Piece): void {
  const st = econ(world);
  for (const id of p.shapeIds) world.collision.remove(id);
  p.shapeIds.length = 0;
  world.nav.unblock(p.id);
  if (p.kind === 'wall') {
    const key = slotKey(p.edge, p.level);
    if (st.edgeSlots.get(key) === p.id) st.edgeSlots.delete(key);
  } else {
    const key = slotKey(p.facet, p.level);
    if (st.facetSlots.get(key) === p.id) st.facetSlots.delete(key);
  }
  st.pieceInfo.delete(p.id);
  world.pieces.delete(p.id);
}

/**
 * Put a piece into the world as the host built it: pieces map, slot index and collision/nav
 * shapes on the current lattice. No lumber, no support check, no event (net/mirror.ts).
 */
export function attachPiece(world: World, p: Piece): void {
  world.pieces.set(p.id, p);
  indexPiece(world, p);
  registerPieceShapes(world, p);
}

/** Pieces whose support may have depended on `p` (same slot ids; may include still-supported ones). */
function collectDependents(world: World, p: Piece, out: Piece[]): void {
  const lat = world.lattice;
  const st = econ(world);
  const push = (piece: Piece | undefined): void => {
    if (piece && !out.includes(piece)) out.push(piece);
  };
  const wall = (edge: number, level: number): void => {
    const id = st.edgeSlots.get(slotKey(edge, level));
    if (id !== undefined) push(world.pieces.get(id));
  };
  const L = p.level;
  if (p.kind === 'wall') {
    wall(p.edge, L + 1);
    for (const f of lat.edges[p.edge].facets) {
      push(facetPieceAt(world, st, f, L));
      push(facetPieceAt(world, st, f, L + 1));
    }
    return;
  }
  const fc = lat.facets[p.facet];
  for (const e of fc.edges) wall(e, L + 1);
  push(facetPieceAt(world, st, p.facet, L + 1));
  for (const n of fc.neighbors) {
    if (n < 0) continue;
    push(facetPieceAt(world, st, n, L + 1));
    push(facetPieceAt(world, st, n, L));
  }
}

/** Record the piece in the slot index with its anchor nodes and centre. */
function indexPiece(world: World, p: Piece): V3 {
  const lat = world.lattice;
  const st = econ(world);
  const centre = slotCenter(lat, p.kind, p.edge, p.facet, p.level, { x: 0, y: 0, z: 0 });
  centre.y += world.collision.groundHeight(centre.x, centre.z);
  if (p.kind === 'wall') {
    st.edgeSlots.set(slotKey(p.edge, p.level), p.id);
    const e = lat.edges[p.edge];
    st.pieceInfo.set(p.id, { nodes: [e.a, e.b], x: centre.x, y: centre.y, z: centre.z });
  } else {
    st.facetSlots.set(slotKey(p.facet, p.level), p.id);
    st.pieceInfo.set(p.id, { nodes: lat.facets[p.facet].nodes.slice(), x: centre.x, y: centre.y, z: centre.z });
  }
  return centre;
}

/** Collision (tag = piece id) and, for ground-level walls/ramps, hippie nav blocking. */
function registerPieceShapes(world: World, p: Piece): void {
  const lat = world.lattice;
  const col = world.collision;
  const base = pieceGroundHeight(world, p);
  const y0 = base + p.level * LEVEL_HEIGHT;
  const top = base + (p.level + 1) * LEVEL_HEIGHT;
  if (p.kind === 'wall') {
    const [ax, az, bx, bz] = wallSegment(lat, p.edge, SEG);
    const len = Math.hypot(bx - ax, bz - az);
    const yaw = Math.atan2(bx - ax, bz - az);
    p.shapeIds.push(col.addBox((ax + bx) / 2, (az + bz) / 2, PIECE.wallThickness / 2, len / 2, yaw, y0, top, p.id));
    if (p.level === 0) world.nav.blockSegment(ax, az, bx, bz, PIECE.wallThickness, p.id);
    return;
  }
  // The collision world may keep the polygon arrays, so each shape gets its own copy.
  const xs = [0, 0, 0, 0];
  const zs = [0, 0, 0, 0];
  facetPolygon(lat, p.facet, xs, zs);
  const fc = lat.facets[p.facet];
  if (p.kind === 'floor') {
    p.shapeIds.push(col.addSlab(xs, zs, top, DECK_THICKNESS, p.id));
    if (p.level === 0) {
      for (let i = 0; i < 4; i++) {
        const [sx, sz] = stiltFoot(lat, p.facet, i, FOOT);
        p.shapeIds.push(col.addCylinder(sx, sz, STILT_RADIUS, col.groundHeight(sx, sz), top - DECK_THICKNESS, p.id));
      }
    }
    return;
  }
  p.shapeIds.push(col.addRamp(xs, zs, p.rampEdge, (p.rampEdge + 1) % 4, y0, top, RAMP_THICKNESS, p.id));
  if (p.level === 0) world.nav.blockCircle(fc.cx, fc.cz, facetInradius(lat, p.facet) * RAMP_NAV_SHARE, p.id);
}

/** Has the lattice re-tiled the edge/facet under this piece (phason flip)? */
function anchorMoved(world: World, p: Piece, nodes: readonly number[]): boolean {
  const lat = world.lattice;
  if (p.kind === 'wall') {
    const e = lat.edges[p.edge];
    return !((e.a === nodes[0] && e.b === nodes[1]) || (e.a === nodes[1] && e.b === nodes[0]));
  }
  const now = lat.facets[p.facet].nodes;
  for (const n of nodes) if (!now.includes(n)) return true;
  return false;
}

/**
 * Pieces only change through commands and damage, except when the Crystal turns: a phason
 * flip re-tiles three facets and three edges in place, so anything standing on them
 * collapses, and anything whose support changed with the new adjacency follows.
 */
export function updatePieces(world: World, dt: number): void {
  const st = econ(world);
  const version = world.lattice.version;
  if (version === st.pieceLatticeVersion) return;
  st.pieceLatticeVersion = version;
  if (world.pieces.size === 0) return;
  const stale: Piece[] = [];
  for (const p of world.pieces.values()) {
    const info = st.pieceInfo.get(p.id);
    if (!info || anchorMoved(world, p, info.nodes)) stale.push(p);
  }
  for (const p of stale) destroyPiece(world, p);
  for (let level = 1; level <= MAX_BUILD_LEVEL; level++) {
    stale.length = 0;
    for (const p of world.pieces.values()) {
      if (p.level === level && !isSupported(world, p.kind, p.edge, p.facet, p.level, p.rampEdge)) stale.push(p);
    }
    for (const p of stale) destroyPiece(world, p);
  }
}
