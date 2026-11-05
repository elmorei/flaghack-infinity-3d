/**
 * Georgia trees.
 *
 * Map trees (kind 'tree': radius = trunk collision radius, height): 0 loblolly pine — a tall
 * straight bare trunk with clumpy needle pads high up; 1 live oak — a short thick trunk,
 * sprawling elbowed limbs, a broad clumpy crown hung with Spanish moss. Trunks go into the
 * static batch at their exact collision radius; canopies are instanced per species so each
 * tree sways with its own phase and casts shadows.
 *
 * Forest ring: a wall of loblollies and hardwoods (some already turning for October) on the
 * hills beyond the border, half+18 … half+140 m out on the terrain. Cheap smooth-shaded
 * indexed templates, no shadows; the count scales with quality.
 */
import * as THREE from 'three';
import { ownProp } from './kit';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Obstacle } from '../../../sim/map/mapgen';
import { hash01, Rng } from '../../../sim/rng';
import { PartsBuilder, placeMatrix } from '../geom';
import type { Place } from '../geom';
import { terrainHeight } from '../terrain';
import { flat, frameOf, paintFaces, shapeSway, taper, within } from './batch';
import type { PropBatches } from './kit';
import { obstacleRng } from './kit';

/** Heights the canopy templates are modelled at (instances scale by height / ref). */
const PINE_REF = 12;
const OAK_REF = 10;
const PINE_BARK = [0x6e4b36, 0x7a5238, 0x5f4231];
const OAK_BARK = [0x4f4538, 0x5a4e40, 0x463d33];
const BRANCH = 0x5a4030;
const SPANISH_MOSS = 0x9aa58a;

const UP = new THREE.Vector3(0, 1, 0);

/** Foliage facets: lit tops, dark undersides, a little per-facet variation. */
function shadeFoliage(geo: THREE.BufferGeometry, seed: number): void {
  paintFaces(geo, (f) => {
    if (f.tint < 0.5) return;
    const n = hash01(f.index * 131 + seed);
    f.color.setScalar((0.6 + 0.45 * (f.ny * 0.5 + 0.5)) * (0.92 + 0.16 * n));
  });
}

/** A flattened, faceted foliage pad (tinted per tree, swaying). */
function pad(b: PartsBuilder, geo: THREE.BufferGeometry, x: number, y: number, z: number, ry: number, squash: number, sway: number): void {
  b.add(flat(geo), 0xffffff, { x, y, z, ry, sx: 1.35, sy: squash, sz: 1.35 }, { tint: true, sway });
}

/** Loblolly crown at PINE_REF (trunk drawn separately, up to 0.93 of the height): ~150 tris. */
function pineCanopy(): THREE.BufferGeometry {
  const b = new PartsBuilder();
  // [angle, distance from trunk, height, size]: a lopsided crown in the top third.
  const tufts: [number, number, number, number][] = [
    [0.3, 1.45, 7.6, 1.35],
    [2.4, 1.4, 7.9, 1.3],
    [4.4, 1.5, 7.3, 1.25],
    [1.4, 1.0, 9.4, 1.4],
    [3.9, 0.9, 9.8, 1.3],
    [2.0, 0.2, 11.2, 1.25],
  ];
  tufts.forEach(([a, rad, y, size], i) => {
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    if (rad > 1.2) taper(b, new THREE.Vector3(0, y - 0.6, 0), new THREE.Vector3(x * 0.85, y - 0.1, z * 0.85), 0.1, 0.05, BRANCH, { sway: 0.3, segments: 3 });
    pad(b, new THREE.IcosahedronGeometry(size, 0), x, y, z, i * 1.7, 0.55, 1);
  });
  taper(b, new THREE.Vector3(0, 5.2, 0), new THREE.Vector3(0.75, 5.55, 0.2), 0.06, 0.03, BRANCH, { segments: 3 });
  const t = b.build();
  shadeFoliage(t, 1);
  shapeSway(t, (_x, y, _z, w) => w * Math.min(1, Math.max(0, (y - 5) / 7)));
  return t;
}

/** Live-oak limbs, crown and Spanish moss at OAK_REF (trunk drawn separately to 0.32): ~240 tris. */
function oakCanopy(): THREE.BufferGeometry {
  const b = new PartsBuilder();
  const rng = new Rng('oak-canopy');
  const base = new THREE.Vector3(0, 2.6, 0);
  const limbs: [THREE.Vector3, THREE.Vector3][] = [];
  for (let k = 0; k < 5; k++) {
    const a = k * ((Math.PI * 2) / 5) + rng.range(-0.3, 0.3);
    const rad = rng.range(3.0, 4.2);
    const end = new THREE.Vector3(Math.cos(a) * rad, rng.range(4.4, 5.6), Math.sin(a) * rad);
    // Live-oak limbs run out low, then turn up.
    const elbow = new THREE.Vector3(Math.cos(a) * rad * 0.55, rng.range(3.4, 4.0), Math.sin(a) * rad * 0.55);
    taper(b, base, elbow, 0.3, 0.2, OAK_BARK[0], { sway: 0.05, segments: 3 });
    taper(b, elbow, end, 0.2, 0.1, OAK_BARK[0], { sway: 0.25, segments: 3 });
    limbs.push([elbow, end]);
    pad(b, new THREE.IcosahedronGeometry(rng.range(2.0, 2.4), 0), end.x * 0.95, end.y + rng.range(0.6, 1.0), end.z * 0.95, rng.range(0, 6), 0.55, 1);
  }
  pad(b, new THREE.IcosahedronGeometry(2.5, 0), 0.3, 7.6, -0.2, 0.4, 0.6, 1);
  pad(b, new THREE.IcosahedronGeometry(2.0, 0), -0.6, 6.0, 0.7, 1.3, 0.55, 0.8);
  // Spanish moss strands hanging from the limbs.
  for (let k = 0; k < 10; k++) {
    const [elbow, end] = limbs[k % limbs.length];
    const p = elbow.clone().lerp(end, rng.range(0.25, 1)).add(new THREE.Vector3(rng.range(-0.3, 0.3), -0.1, rng.range(-0.3, 0.3)));
    const len = rng.range(0.9, 1.8);
    b.add(flat(new THREE.ConeGeometry(rng.range(0.14, 0.24), len, 3, 1, true)), SPANISH_MOSS, { x: p.x, y: p.y - len / 2, z: p.z, rx: Math.PI, ry: rng.range(0, 3) }, { sway: 1.6 });
  }
  const t = b.build();
  shadeFoliage(t, 2);
  shapeSway(t, (_x, y, _z, w) => w * (0.35 + 0.65 * Math.min(1, Math.max(0, (y - 2.5) / 6))));
  return t;
}

/** Unit trunk (base radius 1, height 1) up to `top`, tapering to `topR`, with a root flare. */
function trunkTemplate(top: number, topR: number): THREE.BufferGeometry {
  const b = new PartsBuilder();
  b.add(flat(new THREE.CylinderGeometry(topR, 1, top, 7, 2, true)), 0xffffff, { y: top / 2 }, { tint: true });
  b.add(flat(new THREE.CylinderGeometry(1, 1.45, 0.05, 7, 1, true)), 0xffffff, { y: 0.025 }, { tint: true });
  return b.build();
}

export interface CanopyInstance {
  obstacleId?: number;
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

export interface TreeCanopies {
  pine: THREE.BufferGeometry;
  oak: THREE.BufferGeometry;
  pines: CanopyInstance[];
  oaks: CanopyInstance[];
}

/** Trunks into the static batch; canopy templates + per-tree instances for the caller. */
export function buildTrees(trees: Obstacle[], out: PropBatches): TreeCanopies {
  const pineTrunk = trunkTemplate(0.93, 0.3);
  const oakTrunk = trunkTemplate(0.32, 0.8);
  const result: TreeCanopies = { pine: pineCanopy(), oak: oakCanopy(), pines: [], oaks: [] };
  for (const o of trees) {
    ownProp(out, o.id);
    const rng = obstacleRng(o, 'tree');
    const oak = o.variant === 1;
    const frame = frameOf(o.x, o.z, o.yaw);
    out.solid.add(oak ? oakTrunk : pineTrunk, within(frame, { sx: o.radius, sy: o.height, sz: o.radius }), rng.pick(oak ? OAK_BARK : PINE_BARK));
    const s = o.height / (oak ? OAK_REF : PINE_REF);
    const matrix = within(frame, { sx: s * rng.range(0.9, 1.1), sy: s, sz: s * rng.range(0.9, 1.1) });
    const color = new THREE.Color(o.color).multiplyScalar(rng.range(0.9, 1.12));
    (oak ? result.oaks : result.pines).push({ matrix, color, obstacleId: o.id });
  }
  pineTrunk.dispose();
  oakTrunk.dispose();
  return result;
}

// ── Forest ring ───────────────────────────────────────────────────────────────

const FOREST_INNER = 18;
const FOREST_OUTER = 140;
const FOREST: Record<PropBatches['quality'], { cell: number; max: number }> = {
  low: { cell: 9, max: 1100 },
  medium: { cell: 7.2, max: 1900 },
  high: { cell: 6, max: 2800 },
};
const FOREST_PINE_REF = 20;
const FOREST_BROAD_REF = 12;
const PINE_GREENS = [0x2c5228, 0x33602d, 0x27482a, 0x3a5d2c];
const BROAD_GREENS = [0x4c7431, 0x587f37, 0x456b2c, 0x5f7f3a];
/** Sweetgum and hickory just starting to turn in October (muted so they don't read as props). */
const AUTUMN = [0x9a6a2e, 0x8a4f2c, 0xa38a3a, 0x7f5a2a];

/** Indexed smooth part with env attributes: shared vertices keep the far forest cheap. */
function smoothPart(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, tint: boolean, sway: number, place: Place): THREE.BufferGeometry {
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  const g = mergeVertices(geo);
  geo.dispose();
  g.applyMatrix4(placeMatrix(place));
  g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(col, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(n).fill(sway), 1));
  g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(n).fill(tint ? 1 : 0), 1));
  return g;
}

/** Merge smooth parts; foliage darkens toward the bottom of the crown (cheap ambient occlusion). */
function forestTemplate(parts: THREE.BufferGeometry[], crownLow: number, crownHigh: number): THREE.BufferGeometry {
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('forest template merge failed');
  const pos = g.getAttribute('position');
  const col = g.getAttribute('color');
  const tint = g.getAttribute('aTint');
  for (let i = 0; i < pos.count; i++) {
    if (tint.getX(i) < 0.5) continue;
    const t = Math.min(1, Math.max(0, (pos.getY(i) - crownLow) / (crownHigh - crownLow)));
    const v = 0.58 + 0.5 * t;
    col.setXYZ(i, v, v, v);
  }
  return g;
}

/** Far loblolly: bare trunk and a three-clump crown (~70 triangles, ~45 shared vertices). */
function forestPine(): THREE.BufferGeometry {
  return forestTemplate(
    [
      smoothPart(new THREE.CylinderGeometry(0.16, 0.34, 15, 4, 1, true), 0x4a3626, false, 0, { y: 7.5 }),
      smoothPart(new THREE.IcosahedronGeometry(2.8, 0), 0xffffff, true, 0.45, { y: 15.4, sx: 1.25, sy: 0.62, sz: 1.25 }),
      smoothPart(new THREE.IcosahedronGeometry(2.3, 0), 0xffffff, true, 0.55, { x: 0.6, y: 17.5, z: -0.3, sx: 1.15, sy: 0.65, sz: 1.15 }),
      smoothPart(new THREE.IcosahedronGeometry(1.6, 0), 0xffffff, true, 0.65, { x: -0.3, y: 19.1, z: 0.2, sy: 0.8 }),
    ],
    13,
    20,
  );
}

/** Far hardwood: short trunk and a rounded three-clump crown. */
function forestBroadleaf(): THREE.BufferGeometry {
  return forestTemplate(
    [
      smoothPart(new THREE.CylinderGeometry(0.2, 0.36, 5.5, 4, 1, true), 0x4d4034, false, 0, { y: 2.75 }),
      smoothPart(new THREE.IcosahedronGeometry(3.5, 0), 0xffffff, true, 0.35, { y: 7.4, sx: 1.15, sy: 0.85, sz: 1.15 }),
      smoothPart(new THREE.IcosahedronGeometry(2.6, 0), 0xffffff, true, 0.45, { x: 1.7, y: 9.0, z: -0.9 }),
      smoothPart(new THREE.IcosahedronGeometry(2.4, 0), 0xffffff, true, 0.3, { x: -1.9, y: 6.4, z: 1.0 }),
    ],
    4,
    11,
  );
}

/** Angular sectors of the ring: each is its own pair of instanced meshes so the camera culls
 * the woods behind it (one ring-wide mesh would never be culled). */
export const FOREST_SECTORS = 8;

export interface ForestSector {
  pines: CanopyInstance[];
  broadleaves: CanopyInstance[];
}

export interface Forest {
  pine: THREE.BufferGeometry;
  broadleaf: THREE.BufferGeometry;
  sectors: ForestSector[];
}

/** Trees on a jittered grid over the ring, dense at the border and thinning up the hills. */
export function buildForest(half: number, seed: string, quality: PropBatches['quality']): Forest {
  return { pine: forestPine(), broadleaf: forestBroadleaf(), sectors: buildForestPlacements(half, seed, quality) };
}

/** Shared placement-only layout: mobile never builds the corresponding 3D tree models. */
export function buildForestPlacements(half: number, seed: string, quality: PropBatches['quality']): ForestSector[] {
  const tier = FOREST[quality];
  const rng = new Rng(`${seed}:forest`);
  const outer = half + FOREST_OUTER;
  const spots: { x: number; z: number }[] = [];
  for (let gx = -outer; gx <= outer; gx += tier.cell) {
    for (let gz = -outer; gz <= outer; gz += tier.cell) {
      const x = gx + rng.range(-0.45, 0.45) * tier.cell;
      const z = gz + rng.range(-0.45, 0.45) * tier.cell;
      // Same rounded-square distance as the terrain relief.
      const e = Math.sqrt(Math.sqrt(x * x * x * x + z * z * z * z)) - half;
      if (e < FOREST_INNER || e > FOREST_OUTER) continue;
      const keep = e < 45 ? 1 : 1 - (0.55 * (e - 45)) / (FOREST_OUTER - 45);
      if (rng.next() < keep) spots.push({ x, z });
    }
  }
  const sectors: ForestSector[] = [];
  for (let i = 0; i < FOREST_SECTORS; i++) sectors.push({ pines: [], broadleaves: [] });
  const p = Math.min(1, tier.max / Math.max(1, spots.length));
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (const s of spots) {
    if (rng.next() > p) continue;
    const pine = rng.chance(0.6);
    const h = pine ? rng.range(15, 26) : rng.range(8, 14.5);
    const k = h / (pine ? FOREST_PINE_REF : FOREST_BROAD_REF);
    pos.set(s.x, terrainHeight(s.x, s.z, half) - 0.4, s.z);
    quat.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
    scale.set(k * rng.range(0.85, 1.15), k, k * rng.range(0.85, 1.15));
    const color = new THREE.Color(pine ? rng.pick(PINE_GREENS) : rng.chance(0.08) ? rng.pick(AUTUMN) : rng.pick(BROAD_GREENS));
    color.multiplyScalar(rng.range(0.82, 1.1));
    const angle = Math.atan2(s.z, s.x) + Math.PI;
    const sector = sectors[Math.min(FOREST_SECTORS - 1, Math.floor((angle / (Math.PI * 2)) * FOREST_SECTORS))];
    (pine ? sector.pines : sector.broadleaves).push({ matrix: new THREE.Matrix4().compose(pos, quat, scale), color });
  }
  return sectors;
}
