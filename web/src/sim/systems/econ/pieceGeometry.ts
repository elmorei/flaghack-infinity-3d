/**
 * Geometry of Fortnite-style pieces on the Ley Lattice: wall segments inset along Ley edges,
 * deck/ramp polygons on facets, vertical extents per build level, and slot keys.
 *
 * Heights (H = LEVEL_HEIGHT): a wall of level L spans [L·H, (L+1)·H]; a deck of level L is a
 * slab whose top is at (L+1)·H; a ramp of level L rises from L·H on its low edge to (L+1)·H
 * on the opposite edge.
 */
import { LEVEL_HEIGHT, MAX_BUILD_LEVEL, PIECE } from '../../constants';
import type { Lattice } from '../../lattice/lattice';
import type { V3 } from '../../math';
import type { World } from '../../world';
import type { Piece, PieceKind } from '../../types';

export const DECK_THICKNESS = 0.25;
export const RAMP_THICKNESS = 0.25;
export const STILT_RADIUS = 0.12;
/** Stilts stand this far in from the facet corners so the Ley Node itself stays reachable. */
export const STILT_INSET = 0.7;

/** Slot key for an edge or facet id at a build level (one piece per slot). */
export function slotKey(id: number, level: number): number {
  return id * (MAX_BUILD_LEVEL + 1) + level;
}

/** Lowest point of a piece: walls and ramps start at their level floor, decks are a thin slab at the level top. */
export function pieceBottom(kind: PieceKind, level: number): number {
  return kind === 'floor' ? (level + 1) * LEVEL_HEIGHT - DECK_THICKNESS : level * LEVEL_HEIGHT;
}

/** Wall segment along an edge, inset PIECE.wallInset from both nodes: out = [ax, az, bx, bz]. */
export function wallSegment(lat: Lattice, edge: number, out: number[]): number[] {
  const e = lat.edges[edge];
  const a = lat.nodes[e.a];
  const b = lat.nodes[e.b];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const t = len > 0 ? PIECE.wallInset / len : 0;
  out[0] = a.x + dx * t;
  out[1] = a.z + dz * t;
  out[2] = b.x - dx * t;
  out[3] = b.z - dz * t;
  return out;
}

/** Facet corners in CCW order (polygon index i..i+1 is facet edge i). */
export function facetPolygon(lat: Lattice, facet: number, xs: number[], zs: number[]): void {
  const ns = lat.facets[facet].nodes;
  for (let i = 0; i < 4; i++) {
    const n = lat.nodes[ns[i]];
    xs[i] = n.x;
    zs[i] = n.z;
  }
}

/**
 * Largest rectangular strip inside a rhombus joining the chosen low edge to its
 * opposite high edge. Unlike a full facet, its sides run perpendicular to both
 * landings. Output stays CCW: indices 0/1 are low, 2/3 high.
 */
export function rampPolygon(lat: Lattice, facet: number, rampEdge: number, xs: number[], zs: number[]): void {
  const ns = lat.facets[facet].nodes;
  const a = lat.nodes[ns[rampEdge]], b = lat.nodes[ns[(rampEdge + 1) % 4]];
  const d = lat.nodes[ns[(rampEdge + 3) % 4]];
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
  const shift = (d.x - a.x) * ux + (d.z - a.z) * uz;
  const vx = d.x - a.x - shift * ux, vz = d.z - a.z - shift * uz;
  const lo = Math.max(0, shift), hi = Math.min(length, length + shift);
  xs[0] = a.x + lo * ux; zs[0] = a.z + lo * uz;
  xs[1] = a.x + hi * ux; zs[1] = a.z + hi * uz;
  xs[2] = xs[1] + vx; zs[2] = zs[1] + vz;
  xs[3] = xs[0] + vx; zs[3] = zs[0] + vz;
}

/** Inradius of a rhombus facet (area / perimeter·2). */
export function facetInradius(lat: Lattice, facet: number): number {
  const ns = lat.facets[facet].nodes;
  let twiceArea = 0;
  for (let i = 0; i < 4; i++) {
    const p = lat.nodes[ns[i]];
    const q = lat.nodes[ns[(i + 1) % 4]];
    twiceArea += p.x * q.z - q.x * p.z;
  }
  const a = lat.nodes[ns[0]];
  const b = lat.nodes[ns[1]];
  const side = Math.hypot(b.x - a.x, b.z - a.z);
  return side > 0 ? Math.abs(twiceArea) / (4 * side) : 0;
}

/** Edge id of a ramp's high side: the facet edge opposite its low edge. */
export function rampHighEdge(lat: Lattice, facet: number, rampEdge: number): number {
  return lat.facets[facet].edges[(rampEdge + 2) % 4];
}

/** Ground position of a deck's post under facet corner i: the corner moved STILT_INSET toward the centre. */
export function stiltFoot(lat: Lattice, facet: number, corner: number, out: number[]): number[] {
  const f = lat.facets[facet];
  const n = lat.nodes[f.nodes[corner]];
  const dx = f.cx - n.x;
  const dz = f.cz - n.z;
  const len = Math.hypot(dx, dz);
  const t = len > 0 ? STILT_INSET / len : 0;
  out[0] = n.x + dx * t;
  out[1] = n.z + dz * t;
  return out;
}

/** World-space centre of a piece slot (reach checks, events, repair range). */
export function slotCenter(lat: Lattice, kind: PieceKind, edge: number, facet: number, level: number, out: V3): V3 {
  if (kind === 'wall') {
    const e = lat.edges[edge];
    const a = lat.nodes[e.a];
    const b = lat.nodes[e.b];
    out.x = (a.x + b.x) / 2;
    out.z = (a.z + b.z) / 2;
    out.y = (level + 0.5) * LEVEL_HEIGHT;
  } else {
    const f = lat.facets[facet];
    out.x = f.cx;
    out.z = f.cz;
    out.y = kind === 'floor' ? (level + 1) * LEVEL_HEIGHT : (level + 0.5) * LEVEL_HEIGHT;
  }
  return out;
}

/** Rigid piece base, shared by collision, hit tests and contact effects. */
export function pieceGroundHeight(world: World, piece: Piece): number {
  const anchor = slotCenter(world.lattice, piece.kind, piece.edge, piece.facet, piece.level, { x: 0, y: 0, z: 0 });
  return world.collision.groundHeight(anchor.x, anchor.z);
}
