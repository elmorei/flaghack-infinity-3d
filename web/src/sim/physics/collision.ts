/**
 * 2.5D collision world for avatars, thrown Flags, pieces, buildings and static obstacles.
 * Map terrain is domed; standalone worlds default to y = 0. Shapes are vertical extrusions (boxes/cylinders) or walkable slabs/ramps.
 *
 * - Boxes and cylinders span [y0, y1] and block a character whose body span
 *   [y + stepHeight, y + height] overlaps; their tops are walkable (cars, stages, roofs).
 * - Slabs (decks) are flat convex planks [top - thickness, top]; ramps are sloped convex
 *   planks rising linearly from their low edge. Both are walkable and also block sideways
 *   wherever the plank overlaps the body span, which is exactly the part of the polygon where
 *   y + stepHeight < surface < y + height + thickness: you walk UNDER a high deck, UP a ramp
 *   from its low edge, but not into its side.
 * - Broad phase: a uniform spatial hash (CELL m) over the map; shapes are pooled and ids are
 *   recycled after `remove`.
 *
 * Owner: MapPhysics agent. Consumers: avatars, projectiles, pieces, buildings, render (debug).
 */
import { groundHeight as terrainHeight } from '../terrain';
import { MAP_HALF } from '../constants';
import type { V3 } from '../math';
import type { MapLayout } from '../map/mapgen';

export type ShapeId = number;

/** RayHit.shape of a ground-plane hit. */
export const GROUND_SHAPE: ShapeId = -1;
/** RayHit.tag of a ground-plane hit: entity ids start at 1 and static obstacle tags are ≤ -1. */
export const GROUND_TAG = 0;

/** Stage deck height; the stage roof sits at the obstacle height. */
export const STAGE_DECK_HEIGHT = 1.1;

/** Transient actor hull, included only during this movement call, never in raycasts/nav. */
export interface MovementCylinder {
  x: number;
  z: number;
  radius: number;
  bottom: number;
  top: number;
  tag: number;
}

export interface MoveResult {
  onGround: boolean;
  hitWall: boolean;
  /** Absolute height of the supporting terrain or structure. */
  groundY: number;
}

export interface RayHit {
  dist: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  shape: ShapeId;
  /** Tag passed at registration (usually an entity id; static obstacles use -1 - obstacleId). */
  tag: number;
}

const BOX = 0;
const CYL = 1;
const SLAB = 2;
const RAMP = 3;

const CELL = 4; // broad-phase cell (m)
const SUBSTEP = 0.25; // max move per sub-step (m)
const SNAP_DOWN = 0.3; // ground snap distance while not rising (m)
const RESOLVE_ITERS = 4;
const EPS = 1e-6;
const TOUCH = 1e-4; // blockedCircle ignores contacts shallower than this

class Shape {
  kind = BOX;
  tag = 0;
  alive = false;
  /** Broad-phase dedupe stamp. */
  stamp = 0;
  minX = 0;
  maxX = 0;
  minZ = 0;
  maxZ = 0;
  /** Vertical extent (slab/ramp: lowest underside .. highest top). */
  y0 = 0;
  y1 = 0;
  // Box / cylinder.
  cx = 0;
  cz = 0;
  hx = 0;
  hz = 0;
  cos = 1;
  sin = 0;
  r = 0;
  // Slab / ramp: convex polygon with positive signed area Σ(x_i z_{i+1} − x_{i+1} z_i).
  n = 0;
  px = new Float64Array(4);
  pz = new Float64Array(4);
  // Top surface h(x, z) = ga·x + gb·z + gc clamped to [topMin, topMax]; plank thickness below.
  ga = 0;
  gb = 0;
  gc = 0;
  topMin = 0;
  topMax = 0;
  thick = 0;
}

export class CollisionWorld {
  readonly half: number;
  private readonly dim: number;
  private readonly cells: number[][] = [];
  private readonly shapes: Shape[] = [];
  private readonly free: number[] = [];
  /** Mast handles only: the effigy's pedestal keeps its original collision after burning. */
  private readonly effigyMasts = new Set<ShapeId>();
  /** Full effigy handles, retired together when the boss emerges. */
  private readonly effigyShapes = new Set<ShapeId>();
  private stamp = 0;
  private cand = new Int32Array(256);
  private readonly result: MoveResult = { onGround: false, hitWall: false, groundY: 0 };
  // Push-out direction written by the *Depth helpers.
  private dirX = 0;
  private dirZ = 0;
  // Ray-hit normal written by the ray helpers.
  private hitNx = 0;
  private hitNy = 0;
  private hitNz = 0;
  // Sutherland-Hodgman scratch for ramp strips.
  private clipAX = new Float64Array(16);
  private clipAZ = new Float64Array(16);
  private clipBX = new Float64Array(16);
  private clipBZ = new Float64Array(16);

  constructor(half = MAP_HALF, private readonly domed = false) {
    this.half = half;
    this.dim = Math.ceil((2 * half) / CELL);
    for (let i = 0; i < this.dim * this.dim; i++) this.cells.push([]);
  }

  /** Registers every map obstacle with tag -1 - obstacleId (flat ones have nothing to hit). */
  static fromMap(map: MapLayout): CollisionWorld {
    const w = new CollisionWorld(map.half, true);
    for (const o of map.obstacles) {
      if (o.height < 0.05) continue;
      const tag = -1 - o.id;
      const base = w.groundHeight(o.x, o.z);
      const c = Math.cos(o.yaw);
      const s = Math.sin(o.yaw);
      // Local (lx, lz) → world, three.js rotation.y = yaw.
      const wx = (lx: number, lz: number): number => o.x + lx * c + lz * s;
      const wz = (lx: number, lz: number): number => o.z - lx * s + lz * c;
      switch (o.kind) {
        case 'shade':
        case 'stage': {
          if (o.kind === 'shade') {
            // Tarp canopy on four corner poles: walk under it, land on it.
            const ix = o.hx - 0.15;
            const iz = o.hz - 0.15;
            for (const [lx, lz] of [
              [-ix, -iz],
              [ix, -iz],
              [ix, iz],
              [-ix, iz],
            ]) {
              w.addCylinder(wx(lx, lz), wz(lx, lz), 0.12, base, base + o.height, tag);
            }
          } else {
            // Jumpable deck, back wall, two front posts; the front (+z) faces the dance floor.
            w.addBox(o.x, o.z, o.hx, o.hz, o.yaw, base, base + STAGE_DECK_HEIGHT, tag);
            w.addBox(wx(0, -o.hz + 0.2), wz(0, -o.hz + 0.2), o.hx, 0.2, o.yaw, base, base + o.height, tag);
            for (const lx of [-(o.hx - 0.2), o.hx - 0.2]) {
              w.addCylinder(wx(lx, o.hz - 0.2), wz(lx, o.hz - 0.2), 0.2, base, base + o.height, tag);
            }
          }
          // Canopy / roof over the whole footprint.
          w.addSlab(
            [wx(-o.hx, -o.hz), wx(o.hx, -o.hz), wx(o.hx, o.hz), wx(-o.hx, o.hz)],
            [wz(-o.hx, -o.hz), wz(o.hx, -o.hz), wz(o.hx, o.hz), wz(-o.hx, o.hz)],
            base + o.height,
            o.kind === 'shade' ? 0.2 : 0.3,
            tag,
          );
          break;
        }
        case 'dome': {
          // Squashed hemisphere as three stacked drums.
          w.addCylinder(o.x, o.z, o.radius, base, base + o.height * 0.5, tag);
          w.addCylinder(o.x, o.z, o.radius * 0.866, base + o.height * 0.5, base + o.height * 0.8, tag);
          w.addCylinder(o.x, o.z, o.radius * 0.6, base + o.height * 0.8, base + o.height, tag);
          break;
        }
        case 'effigy': {
          // Pedestal plus mast carrying The Flag.
          w.effigyShapes.add(w.addCylinder(o.x, o.z, o.radius, base, base + 3, tag));
          const mast = w.addCylinder(o.x, o.z, 0.7, base, base + o.height, tag);
          w.effigyMasts.add(mast);
          w.effigyShapes.add(mast);
          break;
        }
        default:
          if (o.shape === 'circle') w.addCylinder(o.x, o.z, o.radius, base, base + o.height, tag);
          else w.addBox(o.x, o.z, o.hx, o.hz, o.yaw, base, base + o.height, tag);
      }
    }
    return w;
  }

  /** Bare terrain elevation, excluding walkable structures. */
  groundHeight(x: number, z: number): number {
    return this.domed ? terrainHeight(x, z, this.half) : 0;
  }

  /** Vertical extrusion of an oriented rectangle (walls, buildings, tents). */
  addBox(cx: number, cz: number, hx: number, hz: number, yaw: number, y0: number, y1: number, tag: number): ShapeId {
    const id = this.alloc();
    const s = this.shapes[id];
    s.kind = BOX;
    s.tag = tag;
    s.cx = cx;
    s.cz = cz;
    s.hx = hx;
    s.hz = hz;
    s.cos = Math.cos(yaw);
    s.sin = Math.sin(yaw);
    s.y0 = Math.min(y0, y1);
    s.y1 = Math.max(y0, y1);
    const ex = Math.abs(s.cos) * hx + Math.abs(s.sin) * hz;
    const ez = Math.abs(s.sin) * hx + Math.abs(s.cos) * hz;
    s.minX = cx - ex;
    s.maxX = cx + ex;
    s.minZ = cz - ez;
    s.maxZ = cz + ez;
    this.insert(id);
    return id;
  }

  /** Vertical cylinder (trees, posts, round buildings). */
  addCylinder(cx: number, cz: number, r: number, y0: number, y1: number, tag: number): ShapeId {
    const id = this.alloc();
    const s = this.shapes[id];
    s.kind = CYL;
    s.tag = tag;
    s.cx = cx;
    s.cz = cz;
    s.r = r;
    s.y0 = Math.min(y0, y1);
    s.y1 = Math.max(y0, y1);
    s.minX = cx - r;
    s.maxX = cx + r;
    s.minZ = cz - r;
    s.maxZ = cz + r;
    this.insert(id);
    return id;
  }

  /** Flat walkable convex polygon whose top is at y (decks). Thickness extends downward. */
  addSlab(xs: number[], zs: number[], y: number, thickness: number, tag: number): ShapeId {
    const id = this.alloc();
    const s = this.shapes[id];
    s.kind = SLAB;
    s.tag = tag;
    this.setPolygon(s, xs, zs);
    s.ga = 0;
    s.gb = 0;
    s.gc = y;
    s.topMin = y;
    s.topMax = y;
    s.thick = thickness;
    s.y0 = y - thickness;
    s.y1 = y;
    this.insert(id);
    return id;
  }

  /**
   * Sloped walkable convex polygon (ramps). The polygon edge (lowA → lowB) sits at y0, the
   * opposite side at y1, linear in between.
   */
  addRamp(xs: number[], zs: number[], lowA: number, lowB: number, y0: number, y1: number, thickness: number, tag: number): ShapeId {
    const id = this.alloc();
    const s = this.shapes[id];
    s.kind = RAMP;
    s.tag = tag;
    // Plane rises along the low edge's inward normal; the farthest vertex reaches y1.
    const ax = xs[lowA];
    const az = zs[lowA];
    const ex = xs[lowB] - ax;
    const ez = zs[lowB] - az;
    const el = Math.hypot(ex, ez) || 1;
    let ux = -ez / el;
    let uz = ex / el;
    let far = 0;
    let near = 0;
    for (let i = 0; i < xs.length; i++) {
      const d = (xs[i] - ax) * ux + (zs[i] - az) * uz;
      far = Math.max(far, d);
      near = Math.min(near, d);
    }
    if (-near > far) {
      ux = -ux;
      uz = -uz;
      far = -near;
    }
    const k = far > EPS ? (y1 - y0) / far : 0;
    s.ga = ux * k;
    s.gb = uz * k;
    s.gc = y0 - (ax * ux + az * uz) * k;
    s.topMin = Math.min(y0, y1);
    s.topMax = Math.max(y0, y1);
    s.thick = thickness;
    s.y0 = s.topMin - thickness;
    s.y1 = s.topMax;
    this.setPolygon(s, xs, zs);
    this.insert(id);
    return id;
  }

  remove(id: ShapeId): void {
    const s = this.shapes[id];
    if (!s || !s.alive) return;
    const x0 = this.cellCoord(s.minX);
    const x1 = this.cellCoord(s.maxX);
    const z1 = this.cellCoord(s.maxZ);
    for (let cz = this.cellCoord(s.minZ); cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells[cz * this.dim + cx];
        const at = list.indexOf(id);
        if (at >= 0) {
          list[at] = list[list.length - 1];
          list.pop();
        }
      }
    }
    s.alive = false;
    this.effigyMasts.delete(id);
    this.effigyShapes.delete(id);
    this.free.push(id);
  }

  /** Remove every live shape belonging to one stable map obstacle tag. */
  removeObstacle(obstacleId: number): void {
    const tag = -1 - obstacleId;
    for (let id = 0; id < this.shapes.length; id++) {
      const shape = this.shapes[id];
      if (shape.alive && shape.tag === tag) this.remove(id);
    }
  }

  /** Retire consumed poles only; stable tags, pedestal shapes and other handles stay intact. */
  removeEffigyMasts(): void {
    for (const id of this.effigyMasts) this.remove(id);
  }

  /** Retire pedestal and mast only; dynamic shapes and recycled handles remain safe. */
  removeEffigy(): void {
    for (const id of this.effigyShapes) this.remove(id);
  }

  /**
   * Move a vertical-cylinder character by vel*dt with sliding, stepping (≤ stepHeight),
   * gravity-free (caller integrates gravity into vel.y). Mutates pos and vel.
   * Shapes tagged `ignoreTag` are skipped for push-out, ceilings and support (a vexillomancer
   * pushing the GCC cart passes through the cart's own shape).
   * Returns a shared result object, valid until the next call.
   */
  moveCharacter(
    pos: V3,
    vel: V3,
    dt: number,
    radius: number,
    height: number,
    stepHeight: number,
    ignoreTag?: number,
    cylinder?: MovementCylinder | null,
  ): MoveResult {
    // The live boss hull is deliberately scoped to this call. It cannot enlarge flag
    // hitboxes, affect navigation, survive death, or leave stale shapes on a mirror.
    const cylinderId = cylinder
      ? this.addCylinder(cylinder.x, cylinder.z, cylinder.radius, cylinder.bottom, cylinder.top, cylinder.tag)
      : -1;
    const res = this.result;
    res.hitWall = false;
    const tdx = vel.x * dt;
    const tdz = vel.z * dt;
    const tdy = vel.y * dt;
    const steps = Math.max(1, Math.ceil(Math.max(Math.hypot(tdx, tdz), Math.abs(tdy)) / SUBSTEP));
    // Margin covers the body plus push-outs that carry it slightly outside the swept box.
    const m = radius + 0.3;
    let count = this.gather(
      Math.min(pos.x, pos.x + tdx) - m,
      Math.min(pos.z, pos.z + tdz) - m,
      Math.max(pos.x, pos.x + tdx) + m,
      Math.max(pos.z, pos.z + tdz) + m,
    );
    if (ignoreTag !== undefined) {
      // Compact the candidates in place so push-out, ceiling and support all skip the tag.
      let kept = 0;
      for (let k = 0; k < count; k++) {
        const id = this.cand[k];
        if (this.shapes[id].tag !== ignoreTag) this.cand[kept++] = id;
      }
      count = kept;
    }
    const h = dt / steps;
    let onGround = false;
    // A spawn / authoritative correction can put a body inside the hull. Recover
    // gradually rather than teleporting it across the arena or injecting momentum.
    let recovery = Math.max(.2, Math.hypot(tdx, tdz));
    for (let step = 0; step < steps; step++) {
      // Spatial substeps sweep both axes at <= 25 cm, including high-speed impulses.
      // Keep the previous valid side of the hull when resolving a tight wall contact.
      const oldX = pos.x, oldZ = pos.z;
      const oldDepth = cylinderId < 0 ? 0 : this.bodyDepth(this.shapes[cylinderId], oldX, oldZ,
        radius, pos.y, pos.y + height);
      pos.x += vel.x * h;
      pos.z += vel.z * h;
      let hullContact = false;
      for (let iter = 0; iter < RESOLVE_ITERS; iter++) {
        let pushed = false;
        for (let k = 0; k < count; k++) {
          const s = this.shapes[this.cand[k]];
          const lo = this.cand[k] === cylinderId ? pos.y : s.kind === SLAB
            ? this.rampLandingStep(s, pos.x, pos.z, pos.y, stepHeight, count) : pos.y + stepHeight;
          // A walkable ramp supports the feet at the body's centre. Its uphill
          // strip can intersect the cylinder radius before the feet cross the low
          // edge; treating that strip as a wall traps bodies on taller ramps.
          // Only bypass ramp push-out when this centre-height is an ordinary step.
          let depth = s.kind === RAMP && this.surfaceAt(s, pos.x, pos.z) <= lo + TOUCH ? 0 :
            this.bodyDepth(s, pos.x, pos.z, radius, lo, pos.y + height);
          if (depth <= 0) continue;
          if (this.cand[k] === cylinderId) hullContact = true;
          if (this.cand[k] === cylinderId && oldDepth > TOUCH) {
            depth = Math.min(depth, recovery);
            recovery -= depth;
          }
          pos.x += this.dirX * depth;
          pos.z += this.dirZ * depth;
          const vn = vel.x * this.dirX + vel.z * this.dirZ;
          if (vn < 0) {
            vel.x -= vn * this.dirX;
            vel.z -= vn * this.dirZ;
          }
          pushed = true;
          res.hitWall = true;
        }
        if (!pushed) break;
      }
      if (hullContact || oldDepth > TOUCH) {
        // Never let competing wall/hull pushes tunnel into a wall. A previously
        // embedded body may retreat freely; valid outside contact stays outside.
        let unsafe = false;
        for (let k = 0; k < count; k++) {
          if (this.cand[k] === cylinderId && oldDepth > TOUCH) continue;
          const s = this.shapes[this.cand[k]];
          const lo = this.cand[k] === cylinderId ? pos.y : s.kind === SLAB
            ? this.rampLandingStep(s, pos.x, pos.z, pos.y, stepHeight, count) : pos.y + stepHeight;
          if (s.kind === RAMP && this.surfaceAt(s, pos.x, pos.z) <= lo + TOUCH) continue;
          if (this.bodyDepth(s, pos.x, pos.z, radius, lo, pos.y + height) > TOUCH) {
            unsafe = true; break;
          }
        }
        if (unsafe) { pos.x = oldX; pos.z = oldZ; vel.x = 0; vel.z = 0; res.hitWall = true; }
      }
      // Vertical: ceilings stop a rise; otherwise land, step up or snap down onto support.
      const dy = vel.y * h;
      if (dy > 0) {
        const ceiling = this.ceilingAbove(pos.x, pos.z, radius, pos.y + height, count);
        if (pos.y + dy + height > ceiling) {
          pos.y = Math.max(pos.y, ceiling - height);
          vel.y = 0;
        } else {
          pos.y += dy;
        }
        onGround = false;
      } else {
        const support = this.supportAmong(pos.x, pos.z, pos.y + stepHeight, count);
        if (pos.y + dy - support <= SNAP_DOWN) {
          pos.y = support;
          vel.y = 0;
          onGround = true;
        } else {
          pos.y += dy;
          onGround = false;
        }
      }
    }
    res.onGround = onGround;
    res.groundY = this.supportAmong(pos.x, pos.z, pos.y + stepHeight, count);
    if (cylinderId >= 0) this.remove(cylinderId);
    return res;
  }

  /** Highest eligible walkable surface, with bare terrain as the solid lower bound. */
  supportHeight(x: number, z: number, maxY: number): number {
    return this.supportAmong(x, z, maxY, this.gather(x, z, x, z));
  }

  /**
   * Ray cast against all shapes and the ground plane. Direction need not be normalized.
   * Shapes tagged `ignoreTag` are skipped. A ray starting inside a shape hits it at dist 0
   * with the normal facing back along the ray.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    ignoreTag?: number,
  ): RayHit | null {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < EPS || maxDist <= 0) return null;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    let best = maxDist;
    let bestShape = -2;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    // Sample and bracket the first terrain crossing, including horizontal rays into slopes.
    // Spatial steps are bounded independently of frame duration; refine contact by bisection.
    if (!this.domed) {
      if (uy < -EPS && oy >= 0 && -oy / uy <= best) {
        best = -oy / uy; bestShape = GROUND_SHAPE; ny = 1;
      }
    } else if (Math.abs(ux) < EPS && Math.abs(uz) < EPS) {
      const ground = this.groundHeight(ox, oz);
      if (oy < ground || (uy < -EPS && (ground - oy) / uy <= best)) {
        best = oy < ground ? 0 : Math.max(0, (ground - oy) / uy); bestShape = GROUND_SHAPE;
      }
    } else if (Math.min(oy, oy + uy * best) <= 2) {
      const clearance = (t: number): number => oy + uy * t - this.groundHeight(ox + ux * t, oz + uz * t);
      let previous = clearance(0);
      if (previous < -EPS || (previous <= EPS && clearance(Math.min(.001, best)) < previous)) {
        best = 0; bestShape = GROUND_SHAPE;
      } else {
        const steps = Math.max(1, Math.ceil(best / .5));
        let lo = 0;
        for (let i = 1; i <= steps; i++) {
          const hi = maxDist * i / steps;
          const next = clearance(hi);
          if (next <= 0 && previous >= 0 && (next < 0 || previous > EPS)) {
            let left = lo, right = hi;
            for (let j = 0; j < 36; j++) {
              const mid = (left + right) / 2;
              if (clearance(mid) > 0) left = mid; else right = mid;
            }
            best = (left + right) / 2; bestShape = GROUND_SHAPE; break;
          }
          lo = hi; previous = next;
        }
      }
    }
    if (bestShape === GROUND_SHAPE) {
      const x = ox + ux * best, z = oz + uz * best, e = .01;
      nx = (this.groundHeight(x - e, z) - this.groundHeight(x + e, z)) / (2 * e);
      nz = (this.groundHeight(x, z - e) - this.groundHeight(x, z + e)) / (2 * e);
      const normalLength = Math.hypot(nx, 1, nz);
      nx /= normalLength; ny = 1 / normalLength; nz /= normalLength;
    }
    // Walk the broad-phase cells along the ray's ground projection (Amanatides-Woo).
    const stamp = ++this.stamp;
    const dim = this.dim;
    let cx = Math.floor((ox + this.half) / CELL);
    let cz = Math.floor((oz + this.half) / CELL);
    const stepX = ux > 0 ? 1 : -1;
    const stepZ = uz > 0 ? 1 : -1;
    const tdx = Math.abs(ux) > EPS ? CELL / Math.abs(ux) : Infinity;
    const tdz = Math.abs(uz) > EPS ? CELL / Math.abs(uz) : Infinity;
    let tmx =
      Math.abs(ux) > EPS ? ((ux > 0 ? (cx + 1) * CELL - this.half - ox : ox + this.half - cx * CELL) / Math.abs(ux)) : Infinity;
    let tmz =
      Math.abs(uz) > EPS ? ((uz > 0 ? (cz + 1) * CELL - this.half - oz : oz + this.half - cz * CELL) / Math.abs(uz)) : Infinity;
    let enter = 0;
    for (let guard = 0; guard < 4 * dim + 8 && enter <= best; guard++) {
      const list = this.cells[Math.min(dim - 1, Math.max(0, cz)) * dim + Math.min(dim - 1, Math.max(0, cx))];
      for (let k = 0; k < list.length; k++) {
        const id = list[k];
        const s = this.shapes[id];
        if (s.stamp === stamp) continue;
        s.stamp = stamp;
        if (ignoreTag !== undefined && s.tag === ignoreTag) continue;
        const t =
          s.kind === BOX
            ? this.rayBox(s, ox, oy, oz, ux, uy, uz)
            : s.kind === CYL
              ? this.rayCylinder(s, ox, oy, oz, ux, uy, uz)
              : this.rayPlank(s, ox, oy, oz, ux, uy, uz);
        if (t < best) {
          best = t;
          bestShape = id;
          nx = this.hitNx;
          ny = this.hitNy;
          nz = this.hitNz;
        }
      }
      if (tmx === Infinity && tmz === Infinity) break;
      if (tmx < tmz) {
        enter = tmx;
        cx += stepX;
        tmx += tdx;
      } else {
        enter = tmz;
        cz += stepZ;
        tmz += tdz;
      }
    }
    if (bestShape === -2) return null;
    return {
      dist: best,
      x: ox + ux * best,
      y: oy + uy * best,
      z: oz + uz * best,
      nx,
      ny,
      nz,
      shape: bestShape,
      tag: bestShape === GROUND_SHAPE ? GROUND_TAG : this.shapes[bestShape].tag,
    };
  }

  /** True if a circle (x, z, r) over vertical span [y0, y1] overlaps any blocking shape. */
  blockedCircle(x: number, z: number, r: number, y0: number, y1: number, ignoreTag?: number): boolean {
    const count = this.gather(x - r, z - r, x + r, z + r);
    for (let k = 0; k < count; k++) {
      const s = this.shapes[this.cand[k]];
      if (ignoreTag !== undefined && s.tag === ignoreTag) continue;
      if (this.bodyDepth(s, x, z, r, y0, y1) > TOUCH) return true;
    }
    return false;
  }

  tagOf(id: ShapeId): number {
    const s = this.shapes[id];
    return s && s.alive ? s.tag : GROUND_TAG;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private alloc(): number {
    const id = this.free.pop();
    if (id !== undefined) {
      this.shapes[id].alive = true;
      return id;
    }
    const s = new Shape();
    s.alive = true;
    this.shapes.push(s);
    return this.shapes.length - 1;
  }

  private setPolygon(s: Shape, xs: number[], zs: number[]): void {
    const n = xs.length;
    if (s.px.length < n) {
      s.px = new Float64Array(n);
      s.pz = new Float64Array(n);
    }
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += xs[i] * zs[j] - xs[j] * zs[i];
    }
    s.minX = Infinity;
    s.maxX = -Infinity;
    s.minZ = Infinity;
    s.maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      // Store with positive signed area so outward edge normals are (ez, -ex).
      const src = area >= 0 ? i : n - 1 - i;
      s.px[i] = xs[src];
      s.pz[i] = zs[src];
      s.minX = Math.min(s.minX, xs[src]);
      s.maxX = Math.max(s.maxX, xs[src]);
      s.minZ = Math.min(s.minZ, zs[src]);
      s.maxZ = Math.max(s.maxZ, zs[src]);
    }
    s.n = n;
  }

  /** Broad-phase cell coordinate of a world x or z, clamped to the grid. */
  private cellCoord(v: number): number {
    return Math.min(this.dim - 1, Math.max(0, Math.floor((v + this.half) / CELL)));
  }

  private insert(id: number): void {
    const s = this.shapes[id];
    const x0 = this.cellCoord(s.minX);
    const x1 = this.cellCoord(s.maxX);
    const z1 = this.cellCoord(s.maxZ);
    for (let cz = this.cellCoord(s.minZ); cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) this.cells[cz * this.dim + cx].push(id);
    }
  }

  /** Collect live shapes whose AABB overlaps the query box into `cand`; returns the count. */
  private gather(minX: number, minZ: number, maxX: number, maxZ: number): number {
    const stamp = ++this.stamp;
    const x0 = this.cellCoord(minX);
    const x1 = this.cellCoord(maxX);
    const z1 = this.cellCoord(maxZ);
    let count = 0;
    for (let cz = this.cellCoord(minZ); cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells[cz * this.dim + cx];
        for (let k = 0; k < list.length; k++) {
          const id = list[k];
          const s = this.shapes[id];
          if (s.stamp === stamp) continue;
          s.stamp = stamp;
          if (s.maxX < minX || s.minX > maxX || s.maxZ < minZ || s.minZ > maxZ) continue;
          if (count === this.cand.length) {
            const grown = new Int32Array(count * 2);
            grown.set(this.cand);
            this.cand = grown;
          }
          this.cand[count++] = id;
        }
      }
    }
    return count;
  }

  /** A narrow ramp's centre can step higher before its cylinder clears the landing edge. */
  private rampLandingStep(slab: Shape, x: number, z: number, feet: number, step: number, count: number): number {
    let low = feet + step;
    if (step <= 0) return low;
    for (let k = 0; k < count; k++) {
      const ramp = this.shapes[this.cand[k]];
      if (ramp.kind !== RAMP || Math.abs(ramp.topMax - slab.y1) > step || !insidePolygon(ramp.px, ramp.pz, ramp.n, x, z)) continue;
      const support = this.surfaceAt(ramp, x, z);
      if (support >= feet - SNAP_DOWN && support <= feet + step) low = Math.max(low, support + step);
    }
    return low;
  }

  /**
   * Penetration depth of a vertical body (circle r at (x, z) spanning [lo, hi]) into a shape,
   * with the push-out direction in dirX/dirZ. ≤ 0 means no overlap.
   */
  private bodyDepth(s: Shape, x: number, z: number, r: number, lo: number, hi: number): number {
    if (x + r < s.minX || x - r > s.maxX || z + r < s.minZ || z - r > s.maxZ) return 0;
    if (s.y1 <= lo || s.y0 >= hi) return 0;
    switch (s.kind) {
      case BOX:
        return this.boxDepth(s, x, z, r);
      case CYL:
        return this.cylinderDepth(s, x, z, r);
      case SLAB:
        return this.polygonDepth(s.px, s.pz, s.n, x, z, r);
      default: {
        // The plank overlaps the body where lo < h(p) < hi + thick: clip the ramp to that strip.
        const n = this.rampStrip(s, lo, hi + s.thick);
        return n < 3 ? 0 : this.polygonDepth(this.clipAX, this.clipAZ, n, x, z, r);
      }
    }
  }

  private boxDepth(s: Shape, x: number, z: number, r: number): number {
    const dx = x - s.cx;
    const dz = z - s.cz;
    const lx = dx * s.cos - dz * s.sin;
    const lz = dx * s.sin + dz * s.cos;
    const ax = Math.abs(lx) - s.hx;
    const az = Math.abs(lz) - s.hz;
    const sx = lx < 0 ? -1 : 1;
    const sz = lz < 0 ? -1 : 1;
    let ldx: number;
    let ldz: number;
    let depth: number;
    if (ax > 0 || az > 0) {
      const qx = Math.max(ax, 0);
      const qz = Math.max(az, 0);
      const d = Math.sqrt(qx * qx + qz * qz);
      depth = r - d;
      if (depth <= 0) return depth;
      ldx = (sx * qx) / d;
      ldz = (sz * qz) / d;
    } else if (ax > az) {
      depth = r - ax;
      ldx = sx;
      ldz = 0;
    } else {
      depth = r - az;
      ldx = 0;
      ldz = sz;
    }
    this.dirX = ldx * s.cos + ldz * s.sin;
    this.dirZ = -ldx * s.sin + ldz * s.cos;
    return depth;
  }

  private cylinderDepth(s: Shape, x: number, z: number, r: number): number {
    const dx = x - s.cx;
    const dz = z - s.cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    const depth = r + s.r - d;
    if (depth <= 0) return depth;
    if (d > EPS) {
      this.dirX = dx / d;
      this.dirZ = dz / d;
    } else {
      this.dirX = 1;
      this.dirZ = 0;
    }
    return depth;
  }

  /** Circle vs convex polygon (positive signed area). */
  private polygonDepth(xs: Float64Array, zs: Float64Array, n: number, x: number, z: number, r: number): number {
    let inside = true;
    let maxSd = -Infinity;
    let mnx = 0;
    let mnz = 0;
    let best = Infinity;
    let qx = 0;
    let qz = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const ax = xs[i];
      const az = zs[i];
      const ex = xs[j] - ax;
      const ez = zs[j] - az;
      const l2 = ex * ex + ez * ez;
      if (l2 < EPS * EPS) continue;
      const l = Math.sqrt(l2);
      const enx = ez / l;
      const enz = -ex / l;
      const sd = (x - ax) * enx + (z - az) * enz;
      if (sd > 0) inside = false;
      if (sd > maxSd) {
        maxSd = sd;
        mnx = enx;
        mnz = enz;
      }
      let t = ((x - ax) * ex + (z - az) * ez) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + ex * t;
      const cz = az + ez * t;
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 < best) {
        best = d2;
        qx = cx;
        qz = cz;
      }
    }
    if (inside) {
      this.dirX = mnx;
      this.dirZ = mnz;
      return r - maxSd;
    }
    const d = Math.sqrt(best);
    const depth = r - d;
    if (depth <= 0) return depth;
    if (d > EPS) {
      this.dirX = (x - qx) / d;
      this.dirZ = (z - qz) / d;
    } else {
      this.dirX = mnx;
      this.dirZ = mnz;
    }
    return depth;
  }

  /** Clip a ramp polygon to lo < h(p) < hi into clipA*; returns the vertex count. */
  private rampStrip(s: Shape, lo: number, hi: number): number {
    if (s.topMax <= lo || s.topMin >= hi) return 0;
    if (s.px.length * 2 + 4 > this.clipAX.length) {
      const cap = s.px.length * 2 + 4;
      this.clipAX = new Float64Array(cap);
      this.clipAZ = new Float64Array(cap);
      this.clipBX = new Float64Array(cap);
      this.clipBZ = new Float64Array(cap);
    }
    // Keep ga·x + gb·z + gc - lo > 0, then hi - (ga·x + gb·z + gc) > 0.
    const n1 = clipHalfPlane(s.px, s.pz, s.n, this.clipBX, this.clipBZ, s.ga, s.gb, s.gc - lo);
    if (n1 < 3) return 0;
    return clipHalfPlane(this.clipBX, this.clipBZ, n1, this.clipAX, this.clipAZ, -s.ga, -s.gb, hi - s.gc);
  }

  private surfaceAt(s: Shape, x: number, z: number): number {
    const h = s.ga * x + s.gb * z + s.gc;
    return h < s.topMin ? s.topMin : h > s.topMax ? s.topMax : h;
  }

  /** Highest walkable top at the point (x, z) that is ≤ maxY, among the gathered shapes. */
  private supportAmong(x: number, z: number, maxY: number, count: number): number {
    let best = this.groundHeight(x, z);
    for (let k = 0; k < count; k++) {
      const s = this.shapes[this.cand[k]];
      if (s.y1 <= best || x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      let top: number;
      switch (s.kind) {
        case BOX: {
          const dx = x - s.cx;
          const dz = z - s.cz;
          if (Math.abs(dx * s.cos - dz * s.sin) > s.hx || Math.abs(dx * s.sin + dz * s.cos) > s.hz) continue;
          top = s.y1;
          break;
        }
        case CYL: {
          const dx = x - s.cx;
          const dz = z - s.cz;
          if (dx * dx + dz * dz > s.r * s.r) continue;
          top = s.y1;
          break;
        }
        default:
          if (!insidePolygon(s.px, s.pz, s.n, x, z)) continue;
          top = this.surfaceAt(s, x, z);
      }
      if (top <= maxY && top > best) best = top;
    }
    return best;
  }

  /** Lowest underside above `head` overlapping the circle footprint (Infinity if none). */
  private ceilingAbove(x: number, z: number, r: number, head: number, count: number): number {
    let best = Infinity;
    for (let k = 0; k < count; k++) {
      const s = this.shapes[this.cand[k]];
      if (s.y1 < head || x + r < s.minX || x - r > s.maxX || z + r < s.minZ || z - r > s.maxZ) continue;
      let bottom: number;
      let depth: number;
      switch (s.kind) {
        case BOX:
          bottom = s.y0;
          depth = this.boxDepth(s, x, z, r);
          break;
        case CYL:
          bottom = s.y0;
          depth = this.cylinderDepth(s, x, z, r);
          break;
        default: {
          const grad = Math.hypot(s.ga, s.gb);
          bottom = this.surfaceAt(s, x, z) - grad * r - s.thick;
          depth = this.polygonDepth(s.px, s.pz, s.n, x, z, r);
        }
      }
      if (depth > 0 && bottom >= head - 0.05 && bottom < best) best = bottom;
    }
    return best;
  }

  private rayBox(s: Shape, ox: number, oy: number, oz: number, ux: number, uy: number, uz: number): number {
    const dx = ox - s.cx;
    const dz = oz - s.cz;
    const lox = dx * s.cos - dz * s.sin;
    const loz = dx * s.sin + dz * s.cos;
    const ldx = ux * s.cos - uz * s.sin;
    const ldz = ux * s.sin + uz * s.cos;
    let tEnter = -Infinity;
    let tExit = Infinity;
    let axis = -1;
    let sign = 0;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? lox : a === 1 ? oy : loz;
      const d = a === 0 ? ldx : a === 1 ? uy : ldz;
      const lo = a === 0 ? -s.hx : a === 1 ? s.y0 : -s.hz;
      const hi = a === 0 ? s.hx : a === 1 ? s.y1 : s.hz;
      if (Math.abs(d) < EPS) {
        if (o < lo || o > hi) return Infinity;
        continue;
      }
      let t0 = (lo - o) / d;
      let t1 = (hi - o) / d;
      let sg = -1;
      if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
        sg = 1;
      }
      if (t0 > tEnter) {
        tEnter = t0;
        axis = a;
        sign = sg;
      }
      if (t1 < tExit) tExit = t1;
      if (tEnter > tExit) return Infinity;
    }
    if (tExit < 0) return Infinity;
    if (tEnter < 0 || axis < 0) {
      this.hitNx = -ux;
      this.hitNy = -uy;
      this.hitNz = -uz;
      return 0;
    }
    if (axis === 1) {
      this.hitNx = 0;
      this.hitNy = sign;
      this.hitNz = 0;
    } else {
      const lnx = axis === 0 ? sign : 0;
      const lnz = axis === 2 ? sign : 0;
      this.hitNx = lnx * s.cos + lnz * s.sin;
      this.hitNy = 0;
      this.hitNz = -lnx * s.sin + lnz * s.cos;
    }
    return tEnter;
  }

  private rayCylinder(s: Shape, ox: number, oy: number, oz: number, ux: number, uy: number, uz: number): number {
    const px = ox - s.cx;
    const pz = oz - s.cz;
    let t0 = -Infinity;
    let t1 = Infinity;
    const a = ux * ux + uz * uz;
    const c = px * px + pz * pz - s.r * s.r;
    if (a < EPS) {
      if (c > 0) return Infinity;
    } else {
      const b = px * ux + pz * uz;
      const disc = b * b - a * c;
      if (disc < 0) return Infinity;
      const sq = Math.sqrt(disc);
      t0 = (-b - sq) / a;
      t1 = (-b + sq) / a;
    }
    let side = true;
    let tEnter = t0;
    let tExit = t1;
    if (Math.abs(uy) < EPS) {
      if (oy < s.y0 || oy > s.y1) return Infinity;
    } else {
      let ty0 = (s.y0 - oy) / uy;
      let ty1 = (s.y1 - oy) / uy;
      if (ty0 > ty1) {
        const tmp = ty0;
        ty0 = ty1;
        ty1 = tmp;
      }
      if (ty0 > tEnter) {
        tEnter = ty0;
        side = false;
      }
      if (ty1 < tExit) tExit = ty1;
    }
    if (tEnter > tExit || tExit < 0) return Infinity;
    if (tEnter < 0) {
      this.hitNx = -ux;
      this.hitNy = -uy;
      this.hitNz = -uz;
      return 0;
    }
    if (side) {
      this.hitNx = (px + ux * tEnter) / s.r;
      this.hitNy = 0;
      this.hitNz = (pz + uz * tEnter) / s.r;
    } else {
      this.hitNx = 0;
      this.hitNy = uy > 0 ? -1 : 1;
      this.hitNz = 0;
    }
    return tEnter;
  }

  /** Slab/ramp as a convex prism: edge planes plus the top and underside planes (Cyrus-Beck). */
  private rayPlank(s: Shape, ox: number, oy: number, oz: number, ux: number, uy: number, uz: number): number {
    let tEnter = -Infinity;
    let tExit = Infinity;
    let enx = 0;
    let eny = 0;
    let enz = 0;
    const n = s.n;
    for (let i = 0; i < n + 2; i++) {
      let pnx: number;
      let pny: number;
      let pnz: number;
      let pd: number;
      if (i < n) {
        const j = i + 1 === n ? 0 : i + 1;
        const ex = s.px[j] - s.px[i];
        const ez = s.pz[j] - s.pz[i];
        const l = Math.hypot(ex, ez);
        if (l < EPS) continue;
        pnx = ez / l;
        pny = 0;
        pnz = -ex / l;
        pd = pnx * s.px[i] + pnz * s.pz[i];
      } else if (i === n) {
        // y ≤ h(x, z)
        pnx = -s.ga;
        pny = 1;
        pnz = -s.gb;
        pd = s.gc;
      } else {
        // y ≥ h(x, z) - thick
        pnx = s.ga;
        pny = -1;
        pnz = s.gb;
        pd = s.thick - s.gc;
      }
      const denom = pnx * ux + pny * uy + pnz * uz;
      const dist = pd - (pnx * ox + pny * oy + pnz * oz);
      if (Math.abs(denom) < EPS) {
        if (dist < 0) return Infinity;
        continue;
      }
      const t = dist / denom;
      if (denom < 0) {
        if (t > tEnter) {
          tEnter = t;
          enx = pnx;
          eny = pny;
          enz = pnz;
        }
      } else if (t < tExit) {
        tExit = t;
      }
      if (tEnter > tExit) return Infinity;
    }
    if (tExit < 0) return Infinity;
    if (tEnter < 0) {
      this.hitNx = -ux;
      this.hitNy = -uy;
      this.hitNz = -uz;
      return 0;
    }
    const l = Math.sqrt(enx * enx + eny * eny + enz * enz);
    this.hitNx = enx / l;
    this.hitNy = eny / l;
    this.hitNz = enz / l;
    return tEnter;
  }
}

/** Point in convex polygon with positive signed area (boundary counts as inside). */
function insidePolygon(xs: Float64Array, zs: Float64Array, n: number, x: number, z: number): boolean {
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    if ((xs[j] - xs[i]) * (z - zs[i]) - (zs[j] - zs[i]) * (x - xs[i]) < -EPS) return false;
  }
  return true;
}

/**
 * Sutherland-Hodgman against the half plane a·x + b·z + c ≥ 0. Keeps the input orientation.
 * Returns the output vertex count.
 */
function clipHalfPlane(
  ix: Float64Array,
  iz: Float64Array,
  n: number,
  ox: Float64Array,
  oz: Float64Array,
  a: number,
  b: number,
  c: number,
): number {
  let m = 0;
  let px = ix[n - 1];
  let pz = iz[n - 1];
  let pd = a * px + b * pz + c;
  for (let i = 0; i < n; i++) {
    const cx = ix[i];
    const cz = iz[i];
    const cd = a * cx + b * cz + c;
    if (cd >= 0) {
      if (pd < 0) {
        const t = pd / (pd - cd);
        ox[m] = px + (cx - px) * t;
        oz[m] = pz + (cz - pz) * t;
        m++;
      }
      ox[m] = cx;
      oz[m] = cz;
      m++;
    } else if (pd >= 0) {
      const t = pd / (pd - cd);
      ox[m] = px + (cx - px) * t;
      oz[m] = pz + (cz - pz) * t;
      m++;
    }
    px = cx;
    pz = cz;
    pd = cd;
  }
  return m;
}
