import { buildingBaseHeight } from '../sim/buildingGeometry';
/**
 * Crosshair / cursor picking. A view ray is resolved against the collision world, including terrain, then the nearest relevant entity is chosen by 3D distance between
 * the ray segment and each entity's vertical extent, normalized by its pick radius: aim near a
 * Flag's cloth or a hippie's head and it counts, even though the ray hits the ground behind it.
 */
import { BUILDINGS } from '../sim/constants';
import type { V3 } from '../sim/math';
import { bossEncounterActive } from '../sim/systems/boss/damage';
import { bossPlayerHull } from '../sim/systems/boss/playerCollision';
import { isCollapsed } from '../sim/systems/buildings';
import type { EntityId, FactionId } from '../sim/types';
import type { World } from '../sim/world';

/** Pick radii (m); Command View widens small targets to a pixel-sized minimum. */
const R_FLAG = 1.5;
const R_UNIT = 1.2;
const R_PILE = 2;
const R_BEACON = 1.5;
/** A shape the ray actually struck scores as if it were this close (normalized). */
const DIRECT_HIT_SCORE = 0.3;
/** Normalized scores closer than this count as a tie, broken by distance from the eye. */
const TIE = 0.05;

export class Picker {
  /** Surface point of the last successful cast. */
  readonly point: V3 = { x: 0, y: 0, z: 0 };
  /** Distance along the ray from the cast origin to the surface. */
  dist = 0;
  /** Collision tag of the struck shape (entity id for pieces/buildings), or -1 for open ground. */
  tag = -1;

  // Current entity query (kept in fields so the per-frame scan allocates nothing).
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private ex = 0;
  private ey = 0;
  private ez = 0;
  private minRadius = 0;
  private best: EntityId | -1 = -1;
  private bestScore = 1;
  private bestAlong = Infinity;
  private along = 0;

  /**
   * Cast a unit ray from (ox, oy, oz); false when it meets neither a shape nor the ground
   * within maxDist.
   */
  cast(world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): boolean {
    this.tag = -1;
    const hit = world.collision.raycast(ox, oy, oz, dx, dy, dz, maxDist);
    if (hit) {
      this.point.x = hit.x;
      this.point.y = hit.y;
      this.point.z = hit.z;
      this.dist = hit.dist;
      this.tag = hit.tag;
      return true;
    }
    return false;
  }

  /**
   * Best entity near the ray segment origin → origin + dir·tEnd for player `f`: planted or loose
   * Flags, hippies, vexillomancers (your own only with `includeSelf`), buildings, lumber piles,
   * dropped beacons/cards, plus whatever piece/building the last cast struck. `minRadius` widens small
   * targets (Command View).
   */
  entityAlong(
    world: World,
    f: FactionId,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    tEnd: number,
    minRadius: number,
    includeSelf: boolean,
  ): EntityId | -1 {
    this.ox = ox;
    this.oy = oy;
    this.oz = oz;
    this.ex = dx * tEnd;
    this.ey = dy * tEnd;
    this.ez = dz * tEnd;
    this.minRadius = minRadius;
    this.best = -1;
    this.bestScore = 1;
    this.bestAlong = Infinity;
    if (this.tag > 0 && (world.pieces.has(this.tag) || world.buildings.has(this.tag))) {
      this.best = this.tag;
      this.bestScore = DIRECT_HIT_SCORE;
      this.bestAlong = 1;
    }
    // Command View targets the live physical body, with the same terrain/stance height as movement.
    if (includeSelf && bossEncounterActive(world)) {
      const hull = bossPlayerHull(world.boss, world.time, world.map.half);
      if (hull) this.consider(hull.tag, hull.x, hull.z, hull.bottom, hull.top, hull.radius);
    }
    for (const fl of world.flags.values()) {
      if (fl.state === 'planted') this.consider(fl.id, fl.pos.x, fl.pos.z, fl.pos.y, fl.pos.y + 2.7, R_FLAG);
      else if (fl.state === 'loose') this.consider(fl.id, fl.pos.x, fl.pos.z, fl.pos.y, fl.pos.y + 0.5, R_FLAG);
    }
    for (const h of world.hippies.values()) {
      const y = (h.airborne?.y ?? 0) + world.collision.groundHeight(h.pos.x, h.pos.z);
      this.consider(h.id, h.pos.x, h.pos.z, y, y + 1.75, R_UNIT);
    }
    for (const av of world.avatars.values()) {
      if ((av.faction === f && !includeSelf) || av.koUntil > world.time) continue;
      this.consider(av.id, av.pos.x, av.pos.z, av.pos.y, av.pos.y + 1.9, R_UNIT);
    }
    for (const b of world.buildings.values()) {
      if (isCollapsed(b)) continue;
      const y = buildingBaseHeight(world, b);
      this.consider(b.id, b.pos.x, b.pos.z, y, y + (b.kind === 'hearth' ? 4 : 2.6), BUILDINGS[b.kind].radius);
    }
    for (const p of world.piles.values()) if (p.lumber > 0) {
      const y = world.collision.groundHeight(p.pos.x, p.pos.z);
      this.consider(p.id, p.pos.x, p.pos.z, y, y + 1.6, R_PILE);
    }
    for (const bc of world.beacons.values()) {
      const y = world.collision.groundHeight(bc.pos.x, bc.pos.z);
      this.consider(bc.id, bc.pos.x, bc.pos.z, y, y + 0.6, R_BEACON);
    }
    for (const drop of world.frickFrack?.drops ?? []) {
      const y = world.collision.groundHeight(drop.pos.x, drop.pos.z);
      this.consider(drop.id, drop.pos.x, drop.pos.z, y, y + .6, R_BEACON);
    }
    return this.best;
  }

  private consider(id: EntityId, px: number, pz: number, y0: number, y1: number, r: number): void {
    const score = this.segDist(px, pz, y0, y1) / Math.max(r, this.minRadius);
    if (score > 1) return;
    if (score < this.bestScore - TIE || (score < this.bestScore + TIE && this.along < this.bestAlong)) {
      this.best = id;
      this.bestScore = score;
      this.bestAlong = this.along;
    }
  }

  /**
   * Distance between the query ray segment and the vertical segment (px, y0..y1, pz): closest
   * points of two segments (Ericson, Real-Time Collision Detection §5.1.9). Leaves the ray
   * fraction of the closest point in `along`.
   */
  private segDist(px: number, pz: number, y0: number, y1: number): number {
    const { ex, ey, ez } = this;
    const h = Math.max(1e-3, y1 - y0);
    const rx = this.ox - px;
    const ry = this.oy - y0;
    const rz = this.oz - pz;
    const a = ex * ex + ey * ey + ez * ez;
    const e = h * h;
    const f = h * ry;
    const c = ex * rx + ey * ry + ez * rz;
    const b = ey * h;
    const denom = a * e - b * b;
    let s = denom > 1e-9 ? (b * f - c * e) / denom : 0;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    let t = (b * s + f) / e;
    if (t < 0) {
      t = 0;
      s = -c / a;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
    } else if (t > 1) {
      t = 1;
      s = (b - c) / a;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
    }
    this.along = s;
    const qx = rx + ex * s;
    const qy = ry + ey * s - h * t;
    const qz = rz + ez * s;
    return Math.sqrt(qx * qx + qy * qy + qz * qz);
  }
}
