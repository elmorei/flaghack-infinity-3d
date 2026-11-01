/**
 * Build ghosts: snap the crosshair (or Command View cursor) to the Ley Lattice slot a piece or
 * camp building would occupy, with the sim's own validity (pieces.canBuildPiece /
 * buildings.canPlaceBuilding), so the ghost can never promise what the command would reject.
 */
import { LEVEL_HEIGHT, MAX_BUILD_LEVEL } from '../sim/constants';
import { clamp, distToSegment } from '../sim/math';
import type { V3 } from '../sim/math';
import { canPlaceBuilding } from '../sim/systems/buildings';
import { canBuildPiece } from '../sim/systems/pieces';
import type { Avatar, BuildingKind, FactionId, PieceKind } from '../sim/types';
import type { World } from '../sim/world';
import type { GhostInfo } from './session';

/** A wall's edge must lie within this distance of the vexillomancer. */
const WALL_REACH = 12;
/**
 * Aim points farther than this (horizontally) fold back to this distance along the view ray,
 * so aiming long still builds right in front of you and looking up builds higher.
 */
const QUERY_REACH = 10;
/** Facet slots read the aim point this far back toward you, landing on your side of a wall. */
const NEAR_SIDE = 0.3;

export class BuildGhost {
  readonly ghost: GhostInfo = { kind: 'wall', edge: -1, facet: -1, level: 0, rampEdge: -1, valid: false, reason: '' };
  // Query point of the latest `aimPoint` call.
  private qx = 0;
  private qy = 0;
  private qz = 0;

  /**
   * Snap a piece slot for `kind` from the view ray (origin o, unit dir d) and its surface hit
   * (null when aiming at the sky). Returns null when no lattice slot is near.
   */
  piece(
    world: World,
    f: FactionId,
    kind: PieceKind,
    av: Avatar,
    hit: V3 | null,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
  ): GhostInfo | null {
    const lat = world.lattice;
    this.aimPoint(av, hit, ox, oy, oz, dx, dy, dz);
    // The level you stand on is the floor: from a deck you keep building at deck height.
    const standLevel = Math.floor((av.pos.y - world.collision.groundHeight(av.pos.x, av.pos.z) + 0.4) / LEVEL_HEIGHT);
    this.qy -= world.collision.groundHeight(this.qx, this.qz);
    const g = this.ghost;
    g.kind = kind;
    g.edge = -1;
    g.facet = -1;
    g.rampEdge = -1;
    if (kind === 'wall') {
      const edge = lat.nearestEdge(this.qx, this.qz, lat.edge);
      if (edge < 0) return null;
      g.edge = edge;
      g.level = clamp(Math.max(standLevel, Math.floor((this.qy + 0.05) / LEVEL_HEIGHT)), 0, MAX_BUILD_LEVEL);
      const e = lat.edges[edge];
      const a = lat.nodes[e.a];
      const b = lat.nodes[e.b];
      if (distToSegment(av.pos.x, av.pos.z, a.x, a.z, b.x, b.z) > WALL_REACH) {
        g.valid = false;
        g.reason = 'Out of reach';
        return g;
      }
    } else {
      let fx = this.qx;
      let fz = this.qz;
      const hx = fx - av.pos.x;
      const hz = fz - av.pos.z;
      const hl = Math.hypot(hx, hz);
      if (hl > NEAR_SIDE) {
        fx -= (hx / hl) * NEAR_SIDE;
        fz -= (hz / hl) * NEAR_SIDE;
      }
      const facet = lat.facetAt(fx, fz);
      if (facet < 0) return null;
      g.facet = facet;
      g.level = clamp(Math.max(standLevel, Math.round(this.qy / LEVEL_HEIGHT)), 0, MAX_BUILD_LEVEL);
      if (kind === 'ramp') g.rampEdge = this.lowSide(world, facet, av, dx, dz);
    }
    const check = canBuildPiece(world, f, kind, g.edge, g.facet, g.level, g.rampEdge);
    g.valid = check.ok;
    g.reason = check.reason;
    return g;
  }

  /** Snap a camp building to the thick facet under the aim (or the nearest thick neighbour). */
  building(world: World, f: FactionId, kind: BuildingKind, hit: V3 | null): GhostInfo | null {
    if (!hit) return null;
    const lat = world.lattice;
    let facet = lat.facetAt(hit.x, hit.z);
    if (facet < 0) return null;
    if (!lat.facets[facet].thick) {
      let best = -1;
      let bestD = Infinity;
      for (const n of lat.facets[facet].neighbors) {
        if (n < 0 || !lat.facets[n].thick) continue;
        const d = (lat.facets[n].cx - hit.x) ** 2 + (lat.facets[n].cz - hit.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best < 0) return null;
      facet = best;
    }
    const g = this.ghost;
    g.kind = kind;
    g.edge = -1;
    g.facet = facet;
    g.level = buildingLevelAtHit(world, facet, hit.y);
    g.rampEdge = -1;
    const check = canPlaceBuilding(world, f, kind, facet, g.level);
    g.valid = check.ok;
    g.reason = check.reason;
    return g;
  }

  /** Aim point folded back to QUERY_REACH from the avatar along the view ray when it is beyond. */
  private aimPoint(av: Avatar, hit: V3 | null, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
    if (hit && Math.hypot(hit.x - av.pos.x, hit.z - av.pos.z) <= QUERY_REACH) {
      this.qx = hit.x;
      this.qy = hit.y;
      this.qz = hit.z;
      return;
    }
    // Ray parameter where the ray is QUERY_REACH (horizontally) past the avatar's own depth.
    const h2 = dx * dx + dz * dz;
    const hl = Math.sqrt(h2);
    let t = hl > 1e-4 ? ((av.pos.x - ox) * dx + (av.pos.z - oz) * dz) / h2 + QUERY_REACH / hl : QUERY_REACH;
    if (hit) t = Math.min(t, Math.hypot(hit.x - ox, hit.y - oy, hit.z - oz));
    this.qx = ox + dx * t;
    this.qy = Math.max(0, oy + dy * t);
    this.qz = oz + dz * t;
  }

  /** Ramp low side: the facet edge whose outward direction points most toward the avatar. */
  private lowSide(world: World, facet: number, av: Avatar, dx: number, dz: number): number {
    const lat = world.lattice;
    const fc = lat.facets[facet];
    let tx = av.pos.x - fc.cx;
    let tz = av.pos.z - fc.cz;
    const tl = Math.hypot(tx, tz);
    if (tl < 1) {
      // Standing on it: the low side faces back the way you look from.
      tx = -dx;
      tz = -dz;
    } else {
      tx /= tl;
      tz /= tl;
    }
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < 4; i++) {
      const a = lat.nodes[fc.nodes[i]];
      const b = lat.nodes[fc.nodes[(i + 1) % 4]];
      const mx = (a.x + b.x) / 2 - fc.cx;
      const mz = (a.z + b.z) / 2 - fc.cz;
      const dot = (mx * tx + mz * tz) / (Math.hypot(mx, mz) || 1);
      if (dot > bestDot) {
        bestDot = dot;
        best = i;
      }
    }
    return best;
  }
}

/** Surface height snapped to the same lattice level sent to the authoritative placement check. */
export function buildingLevelAtHit(world: World, facet: number, y: number): number {
  const fc = world.lattice.facets[facet];
  if (!fc) return 0;
  return clamp(Math.round((y - world.collision.groundHeight(fc.cx, fc.cz)) / LEVEL_HEIGHT), 0, MAX_BUILD_LEVEL + 1);
}
