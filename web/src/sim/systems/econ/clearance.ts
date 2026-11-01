/**
 * Clearance tests for build pieces against the burn's static obstacles, the pond and camp
 * buildings. Exact 2D tests (thick segment / convex polygon vs circle / oriented box) plus a
 * vertical-span overlap, so a deck may pass over a tent but not through a tree.
 *
 * Oriented boxes follow the three.js yaw convention used by the collision world and the
 * renderer: local +z points along (sin yaw, cos yaw), local +x along (cos yaw, -sin yaw).
 */
import { buildingBaseHeight } from '../../buildingGeometry';
import { BUILDING_HEIGHT, BUILDINGS } from '../../constants';
import type { MapLayout, Obstacle } from '../../map/mapgen';
import { distToSegment, pointInConvex } from '../../math';
import type { World } from '../../world';
import { isCollapsed } from '../buildings';

export type MapClearance = 'clear' | 'obstacle' | 'water';

/** Pieces whose bottom is below this stand in the pond if their footprint touches water. */
const WATER_CONTACT_Y = 0.5;

const BOX_X = [0, 0, 0, 0];
const BOX_Z = [0, 0, 0, 0];

/** Can a segment [a, b] cross the axis-aligned box [-hx, hx] × [-hz, hz]? (slab clipping) */
function segmentHitsAabb(ax: number, az: number, bx: number, bz: number, hx: number, hz: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) < 1e-9) {
    if (ax < -hx || ax > hx) return false;
  } else {
    const ta = (-hx - ax) / dx;
    const tb = (hx - ax) / dx;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
    if (t0 > t1) return false;
  }
  if (Math.abs(dz) < 1e-9) return az >= -hz && az <= hz;
  const ta = (-hz - az) / dz;
  const tb = (hz - az) / dz;
  return Math.max(t0, Math.min(ta, tb)) <= Math.min(t1, Math.max(ta, tb));
}

/** Separating-axis test over the edge normals of polygon P. */
function separatedByEdgesOf(
  px: ArrayLike<number>,
  pz: ArrayLike<number>,
  qx: ArrayLike<number>,
  qz: ArrayLike<number>,
): boolean {
  const pn = px.length;
  const qn = qx.length;
  for (let i = 0; i < pn; i++) {
    const j = (i + 1) % pn;
    const nx = pz[j] - pz[i];
    const nz = px[i] - px[j];
    let pMin = Infinity;
    let pMax = -Infinity;
    for (let k = 0; k < pn; k++) {
      const d = px[k] * nx + pz[k] * nz;
      if (d < pMin) pMin = d;
      if (d > pMax) pMax = d;
    }
    let qMin = Infinity;
    let qMax = -Infinity;
    for (let k = 0; k < qn; k++) {
      const d = qx[k] * nx + qz[k] * nz;
      if (d < qMin) qMin = d;
      if (d > qMax) qMax = d;
    }
    // Touching counts as clear: neighbouring pieces and props may share a boundary.
    if (pMax <= qMin + 1e-6 || qMax <= pMin + 1e-6) return true;
  }
  return false;
}

/** Circle (cx, cz, r) overlaps convex polygon? */
function circleHitsPolygon(cx: number, cz: number, r: number, xs: ArrayLike<number>, zs: ArrayLike<number>): boolean {
  if (pointInConvex(cx, cz, xs, zs)) return true;
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (distToSegment(cx, cz, xs[i], zs[i], xs[j], zs[j]) < r) return true;
  }
  return false;
}

function obstacleBound(o: Obstacle): number {
  return o.shape === 'circle' ? o.radius : Math.hypot(o.hx, o.hz);
}

function fillBoxCorners(o: Obstacle): void {
  const c = Math.cos(o.yaw);
  const s = Math.sin(o.yaw);
  for (let i = 0; i < 4; i++) {
    const lx = i === 1 || i === 2 ? o.hx : -o.hx;
    const lz = i >= 2 ? o.hz : -o.hz;
    BOX_X[i] = o.x + lx * c + lz * s;
    BOX_Z[i] = o.z - lx * s + lz * c;
  }
}

function inWater(map: MapLayout, x: number, z: number): boolean {
  for (const w of map.water) {
    const dx = (x - w.x) / w.rx;
    const dz = (z - w.z) / w.rz;
    if (dx * dx + dz * dz < 1) return true;
  }
  return false;
}

/**
 * A thick segment (a wall, or a stilt when a = b) over heights [y0, y1]: does it run into a
 * static obstacle, or stand in the pond?
 */
export function segmentClearance(
  world: World,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  halfWidth: number,
  y0: number,
): MapClearance {
  const map = world.map;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const reach = Math.hypot(bx - ax, bz - az) / 2 + halfWidth;
  for (const o of map.obstacles) {
    if (world.destroyedScenery.has(o.id)) continue;
    if (o.kind === 'effigy' && world.effigyRevealedAt !== null) continue;
    if (world.collision.groundHeight(o.x, o.z) + o.height <= world.collision.groundHeight(mx, mz) + y0) continue;
    const bound = obstacleBound(o) + reach;
    if ((o.x - mx) ** 2 + (o.z - mz) ** 2 > bound * bound) continue;
    if (o.shape === 'circle') {
      if (distToSegment(o.x, o.z, ax, az, bx, bz) < o.radius + halfWidth) return 'obstacle';
      continue;
    }
    // Into the box frame: local x = d·(cos, -sin), local z = d·(sin, cos).
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    const ux = ax - o.x;
    const uz = az - o.z;
    const vx = bx - o.x;
    const vz = bz - o.z;
    if (segmentHitsAabb(ux * c - uz * s, ux * s + uz * c, vx * c - vz * s, vx * s + vz * c, o.hx + halfWidth, o.hz + halfWidth)) {
      return 'obstacle';
    }
  }
  if (y0 < WATER_CONTACT_Y && map.water.length > 0) {
    const steps = Math.max(1, Math.ceil(reach * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (inWater(map, ax + (bx - ax) * t, az + (bz - az) * t)) return 'water';
    }
  }
  return 'clear';
}

/** A convex footprint (deck slab, ramp) over heights [y0, ∞): static obstacle or pond in the way? */
export function polygonClearance(world: World, xs: number[], zs: number[], y0: number): MapClearance {
  const map = world.map;
  const n = xs.length;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i];
    cz += zs[i];
  }
  cx /= n;
  cz /= n;
  let reach = 0;
  for (let i = 0; i < n; i++) reach = Math.max(reach, Math.hypot(xs[i] - cx, zs[i] - cz));
  for (const o of map.obstacles) {
    if (world.destroyedScenery.has(o.id)) continue;
    if (o.kind === 'effigy' && world.effigyRevealedAt !== null) continue;
    if (world.collision.groundHeight(o.x, o.z) + o.height <= world.collision.groundHeight(cx, cz) + y0) continue;
    const bound = obstacleBound(o) + reach;
    if ((o.x - cx) ** 2 + (o.z - cz) ** 2 > bound * bound) continue;
    if (o.shape === 'circle') {
      if (circleHitsPolygon(o.x, o.z, o.radius, xs, zs)) return 'obstacle';
      continue;
    }
    fillBoxCorners(o);
    if (!separatedByEdgesOf(xs, zs, BOX_X, BOX_Z) && !separatedByEdgesOf(BOX_X, BOX_Z, xs, zs)) return 'obstacle';
  }
  if (y0 < WATER_CONTACT_Y && map.water.length > 0) {
    if (inWater(map, cx, cz)) return 'water';
    for (let i = 0; i < n; i++) {
      // Corners pulled 30% inward: a footprint merely grazing the shore still counts as dry.
      if (inWater(map, xs[i] + (cx - xs[i]) * 0.3, zs[i] + (cz - zs[i]) * 0.3)) return 'water';
    }
  }
  return 'clear';
}

/** Does a thick segment starting at height y0 cut into a standing camp building? */
export function segmentHitsBuilding(world: World, ax: number, az: number, bx: number, bz: number, halfWidth: number, y0: number, y1 = Infinity): boolean {
  for (const b of world.buildings.values()) {
    if (isCollapsed(b)) continue;
    const ground = world.collision.groundHeight((ax + bx) / 2, (az + bz) / 2);
    const base = buildingBaseHeight(world, b);
    if (base + BUILDING_HEIGHT[b.kind] <= ground + y0 || base >= ground + y1) continue;
    if (distToSegment(b.pos.x, b.pos.z, ax, az, bx, bz) < BUILDINGS[b.kind].radius + halfWidth) return true;
  }
  return false;
}

/** Does a convex footprint starting at height y0 cut into a standing camp building? */
export function polygonHitsBuilding(world: World, xs: number[], zs: number[], y0: number, y1 = Infinity): boolean {
  for (const b of world.buildings.values()) {
    if (isCollapsed(b)) continue;
    const ground = world.collision.groundHeight(xs.reduce((a, x) => a + x, 0) / xs.length, zs.reduce((a, z) => a + z, 0) / zs.length);
    const base = buildingBaseHeight(world, b);
    if (base + BUILDING_HEIGHT[b.kind] <= ground + y0 || base >= ground + y1) continue;
    if (circleHitsPolygon(b.pos.x, b.pos.z, BUILDINGS[b.kind].radius, xs, zs)) return true;
  }
  return false;
}
