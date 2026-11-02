/**
 * Fortnite pieces from world.pieces, built from the real lattice coordinates and drawn as
 * GPU instances:
 *
 * - Tarp Wall: a timber frame with a billowing festival tarp (grommets, faction tint) on the
 *   inset Ley edge segment, spanning [L·H, (L+1)·H].
 * - Deck: a rhombus plank platform (sheared planks, rim and inner joists) whose top sits at
 *   (L+1)·H; all decks stand on four ground-reaching scaffold posts exactly where the sim puts them.
 * - Ramp: a centered rectangular strip of slatted boards on straight stringers, rising
 *   one level from the rampEdge side (L·H) to the opposite edge ((L+1)·H); level-0 ramps
 *   get two posts under the rectangular high corners.
 *
 * Penrose rhombi come in four corner angles (36°, 72°, 108°, 144°), so each deck/ramp is a
 * rigid instance of one of four variant models placed in a frame anchored at a facet corner
 * (correct normals, no shear). Pop-in scales each new piece with an overshoot over
 * PIECE.popIn; damage darkens per instance; ownership tints the tarp and lightly the wood.
 */
import * as THREE from 'three';
import { platformLadders, PLATFORM_LADDER_WIDTH, PLATFORM_LADDER_RAIL_OFFSET } from '../../sim/platformLadders';
import { groundHeight } from '../../sim/terrain';
import { LEVEL_HEIGHT, MAP_HALF, NEUTRAL_COLOR, PIECE } from '../../sim/constants';
import type { Lattice } from '../../sim/lattice/lattice';
import { DECK_THICKNESS, CORNER_BRACE_WIDTH, CORNER_BRACE_HALF_Y, cornerBraces, RAMP_THICKNESS, STILT_RADIUS, rampPolygon, stiltFoot, wallSegment } from '../../sim/systems/econ/pieceGeometry';
import type { PieceKind } from '../../sim/types';
import type { FrameInfo } from './buildingView';
import { MaterialSet, type MatKey, type ModelBuilder, type ModelGeometry, type StructureKit } from './kit';
import { easeOutBack } from './util';

const H = LEVEL_HEIGHT;
const ANGLE_STEP = Math.PI / 5;
const WALL_LEN_INSET = PIECE.wallInset;
const PLANK = 0xd9b98b;
const PLANK_ALT = 0xc8a574;
const JOIST = 0x7d5838;
const FRAME = 0x8c6642;
const LASHING = 0xb59a6a;
const WHITE = new THREE.Color(1, 1, 1);

/** Rigid frame of a rhombus seen from one corner: anchor, unit edge direction, corner angle. */
export interface RhombusFrame {
  /** 0..3 for corner angles 36°, 72°, 108°, 144°. */
  variant: number;
  ax: number;
  az: number;
  /** Unit direction of the edge leaving the anchor (local +x). */
  ux: number;
  uz: number;
}

/** Frame of facet `facet` anchored at corner `anchor` (local +z points into the rhombus). */
export function rhombusFrame(lat: Lattice, facet: number, anchor: number, out: RhombusFrame): RhombusFrame {
  const ns = lat.facets[facet].nodes;
  const a = lat.nodes[ns[anchor]];
  const b = lat.nodes[ns[(anchor + 1) % 4]];
  const d = lat.nodes[ns[(anchor + 3) % 4]];
  const ul = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const vl = Math.hypot(d.x - a.x, d.z - a.z) || 1;
  out.ux = (b.x - a.x) / ul;
  out.uz = (b.z - a.z) / ul;
  const cos = (out.ux * (d.x - a.x) + out.uz * (d.z - a.z)) / vl;
  const theta = Math.acos(Math.max(-1, Math.min(1, cos)));
  out.variant = Math.max(0, Math.min(3, Math.round(theta / ANGLE_STEP) - 1));
  out.ax = a.x;
  out.az = a.z;
  return out;
}

/**
 * Hexahedron from 8 corners (bottom b0..b3 then top t0..t3, each ordered x0z0, x1z0, x1z1,
 * x0z1 in the local frame), with flat normals and grain running along +x.
 */
function hexa(c: readonly number[], uScale: number): THREE.BufferGeometry {
  const P = (i: number): [number, number, number] => [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
  // Faces as quads (outward winding verified per face), corners: b0..b3 = 0..3, t0..t3 = 4..7.
  const quads = [
    [4, 7, 6, 5], // top
    [0, 1, 2, 3], // bottom
    [0, 4, 5, 1], // front (z0)
    [2, 6, 7, 3], // back (z1)
    [3, 7, 4, 0], // left (x0)
    [1, 5, 6, 2], // right (x1)
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  for (const q of quads) {
    const [a, b, cc, d] = q.map(P);
    for (const p of [a, b, cc, a, cc, d]) {
      pos.push(p[0], p[1], p[2]);
      // Grain along x; v runs continuously over tops and edges.
      uv.push(p[0] * uScale, (p[1] + p[2]) * 0.25);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * A board between z0 and z1 across the rhombus (sheared ends follow the slanted sides),
 * top surface at y(z) = y0 + slope·z, `thick` deep.
 */
function board(
  mb: ModelBuilder,
  L: number,
  cot: number,
  z0: number,
  z1: number,
  y0: number,
  slope: number,
  thick: number,
  inset: number,
  color: number,
  xOffset = 0,
): void {
  const xa = (z: number): number => xOffset + z * cot + inset;
  const xb = (z: number): number => xOffset + L + z * cot - inset;
  const yt0 = y0 + slope * z0;
  const yt1 = y0 + slope * z1;
  const c = [
    xa(z0), yt0 - thick, z0,
    xb(z0), yt0 - thick, z0,
    xb(z1), yt1 - thick, z1,
    xa(z1), yt1 - thick, z1,
    xa(z0), yt0, z0,
    xb(z0), yt0, z0,
    xb(z1), yt1, z1,
    xa(z1), yt1, z1,
  ];
  mb.add('woodPaint', hexa(c, 0.35), 0, 0, 0, 0, 0, 0, 1, 1, 1, color);
}

/** Deck variant: rhombus with corner angle theta at the anchor; top at y = 0. */
function deckModel(mb: ModelBuilder, L: number, theta: number): void {
  const h = L * Math.sin(theta);
  const cot = Math.cos(theta) / Math.sin(theta);
  const n = 9;
  const gap = 0.035;
  for (let i = 0; i < n; i++) {
    const z0 = (i * h) / n + gap / 2;
    const z1 = ((i + 1) * h) / n - gap / 2;
    board(mb, L, cot, z0, z1, 0, 0, 0.065, 0.02, i % 2 === 0 ? PLANK : PLANK_ALT);
  }
  // Rim joists along all four edges, plus two inner joists along the slanted direction.
  const dx = L * Math.cos(theta);
  const y = -0.065 - (DECK_THICKNESS - 0.065) / 2;
  const jh = DECK_THICKNESS - 0.065;
  const corner = (s: number, t: number): [number, number, number] => [s * L + t * dx, y, t * h];
  const rims: [number, number, number, number][] = [
    [0.02, 0.02, 0.98, 0.02],
    [0.02, 0.98, 0.98, 0.98],
    [0.02, 0.02, 0.02, 0.98],
    [0.98, 0.02, 0.98, 0.98],
    [0.33, 0.04, 0.33, 0.96],
    [0.66, 0.04, 0.66, 0.96],
  ];
  for (const [s0, t0, s1, t1] of rims) mb.beam('woodPaint', corner(s0, t0), corner(s1, t1), 0.12, jh, JOIST);
  for (const brace of cornerBraces([0, L, L + dx, dx], [0, 0, h, h])) {
    const length = Math.hypot(brace.bx - brace.ax, brace.bz - brace.az);
    const px = (brace.bz - brace.az) / length * CORNER_BRACE_WIDTH / 2;
    const pz = -(brace.bx - brace.ax) / length * CORNER_BRACE_WIDTH / 2;
    const corners: number[] = [];
    for (const dy of [-CORNER_BRACE_HALF_Y, CORNER_BRACE_HALF_Y]) {
      corners.push(brace.ax - px, brace.ay + dy, brace.az - pz,
        brace.ax + px, brace.ay + dy, brace.az + pz,
        brace.bx + px, brace.by + dy, brace.bz + pz,
        brace.bx - px, brace.by + dy, brace.bz - pz);
    }
    mb.add('woodPaint', hexa(corners, .35), 0, 0, 0, 0, 0, 0, 1, 1, 1, JOIST);
  }
}

/** Largest centered rectangular strip joining the low (z = 0) and high (z = h) edges. */
function rampModel(mb: ModelBuilder, L: number, theta: number): void {
  const h = L * Math.sin(theta);
  const dx = L * Math.cos(theta);
  const x0 = Math.max(0, dx), x1 = Math.min(L, L + dx);
  const width = x1 - x0;
  const slope = H / h;
  const n = 13;
  const gap = 0.07;
  for (let i = 0; i < n; i++) {
    const z0 = (i * h) / n + gap / 2;
    const z1 = ((i + 1) * h) / n - gap / 2;
    board(mb, width, 0, z0, z1, 0, slope, 0.06, 0.04, i % 2 === 0 ? PLANK : PLANK_ALT, x0);
  }
  // Straight parallel stringers under the rectangular slats (no rhombus shear).
  const sh = RAMP_THICKNESS - 0.06;
  for (const s of [0.04, 0.5, 0.96]) {
    const a: [number, number, number] = [x0 + 0.08 + s * (width - 0.16), 0.03 * H - 0.06 - sh / 2, 0.03 * h];
    const b: [number, number, number] = [x0 + 0.08 + s * (width - 0.16), 0.97 * H - 0.06 - sh / 2, 0.97 * h];
    mb.beam('woodPaint', a, b, 0.12, sh, JOIST);
  }
  // Cleat battens for footing.
  for (let i = 1; i < n; i += 3) {
    const z = (i * h) / n + h / n / 2;
    board(mb, width, 0, z - 0.025, z + 0.025, 0.025, slope, 0.03, Math.min(0.4, width * 0.2), JOIST, x0);
  }
}

/** Tarp wall frame (x along the wall, centred; y from 0 to H). */
function wallFrame(mb: ModelBuilder, len: number): void {
  const hx = len / 2;
  for (const s of [-1, 1]) {
    mb.box('woodPaint', 0.18, H, 0.2, s * (hx - 0.09), H / 2, 0, 0, 0, 0, FRAME);
    // Rope lashings at the tarp grommets.
    for (let i = 1; i <= 4; i++) {
      const y = 0.14 + (i * (H - 0.28)) / 5;
      mb.rod('woodPaint', [s * (hx - 0.18), y, 0], [s * (hx - 0.3), y, 0], 0.012, 4, LASHING);
    }
  }
  mb.box('woodPaint', len, 0.14, 0.16, 0, H - 0.07, 0, 0, 0, 0, FRAME);
  mb.box('woodPaint', len, 0.14, 0.16, 0, 0.07, 0, 0, 0, 0, FRAME);
  // A diagonal brace behind the tarp.
  mb.beam('woodPaint', [-hx + 0.2, 0.2, -0.07], [hx - 0.2, H - 0.2, -0.07], 0.05, 0.09, JOIST);
}

/** Tarp panel with a slight billow, uv = whole tarp texture. */
function wallTarp(len: number): THREE.BufferGeometry {
  const w = len - 0.62;
  const hh = H - 0.3;
  const g = new THREE.PlaneGeometry(w, hh, 10, 5);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / w + 0.5;
    const v = pos.getY(i) / hh + 0.5;
    pos.setZ(i, Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * 0.08);
  }
  g.translate(0, H / 2, 0);
  g.computeVertexNormals();
  return g;
}

/** Growable instanced batch (one material, rebuilt wholesale when pieces change). */
class Batch {
  mesh: THREE.InstancedMesh;
  count = 0;
  private readonly geom: THREE.BufferGeometry;
  private readonly mats: MaterialSet;
  private readonly key: MatKey;
  private readonly parent: THREE.Object3D;

  constructor(geom: THREE.BufferGeometry, mats: MaterialSet, key: MatKey, parent: THREE.Object3D) {
    this.geom = geom;
    this.mats = mats;
    this.key = key;
    this.parent = parent;
    this.mesh = this.make(32);
  }

  private make(cap: number): THREE.InstancedMesh {
    const m = this.mats.instancedMesh(this.geom, this.key, cap, true);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    this.parent.add(m);
    return m;
  }

  push(matrix: THREE.Matrix4, color: THREE.Color): void {
    if (this.count >= this.mesh.instanceMatrix.count) {
      const old = this.mesh;
      const next = this.make(old.instanceMatrix.count * 2);
      next.instanceMatrix.array.set(old.instanceMatrix.array);
      if (old.instanceColor && next.instanceColor) next.instanceColor.array.set(old.instanceColor.array);
      this.parent.remove(old);
      old.dispose();
      this.mesh = next;
    }
    this.mesh.setMatrixAt(this.count, matrix);
    this.mesh.setColorAt(this.count, color);
    this.count++;
  }

  finish(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}

/** Cached variant models: wall frame + tarp, four decks, four ramps, the stilt/post unit. */
export function pieceModels(kit: StructureKit, L: number): { wall: ModelGeometry; decks: ModelGeometry[]; ramps: ModelGeometry[] } {
  const len = L - WALL_LEN_INSET * 2;
  const wall = kit.model('pieceWall', (mb) => {
    wallFrame(mb, len);
    mb.add('tarp', wallTarp(len));
  });
  const decks: ModelGeometry[] = [];
  const ramps: ModelGeometry[] = [];
  for (let v = 0; v < 4; v++) {
    const theta = (v + 1) * ANGLE_STEP;
    decks.push(kit.model(`pieceDeck${v}`, (mb) => deckModel(mb, L, theta)));
    ramps.push(kit.model(`pieceRamp${v}`, (mb) => rampModel(mb, L, theta)));
  }
  return { wall, decks, ramps };
}

const tmpFrame: RhombusFrame = { variant: 0, ax: 0, az: 0, ux: 1, uz: 0 };
const tmpSeg = [0, 0, 0, 0];
const vX = new THREE.Vector3();
const vY = new THREE.Vector3(0, 1, 0);
const vZ = new THREE.Vector3();
const vC = new THREE.Vector3();
const vS = new THREE.Vector3();

/**
 * Instance matrix of a piece slot at pop scale `s` (scaled about the piece's centre).
 * Returns the variant index (0..3 for decks/ramps, 0 for walls).
 */
export function pieceSlotMatrix(
  lat: Lattice,
  kind: PieceKind,
  edge: number,
  facet: number,
  level: number,
  rampEdge: number,
  s: number,
  out: THREE.Matrix4,
  half = MAP_HALF,
): number {
  let ox: number;
  let oy: number;
  let oz: number;
  let variant = 0;
  if (kind === 'wall') {
    const [ax, az, bx, bz] = wallSegment(lat, edge, tmpSeg);
    const len = Math.hypot(bx - ax, bz - az) || 1;
    vX.set((bx - ax) / len, 0, (bz - az) / len);
    ox = (ax + bx) / 2;
    oz = (az + bz) / 2;
    oy = level * H;
    vC.set(0, H / 2, 0);
  } else {
    const fr = rhombusFrame(lat, facet, kind === 'ramp' ? Math.max(0, rampEdge) : 0, tmpFrame);
    variant = fr.variant;
    vX.set(fr.ux, 0, fr.uz);
    ox = fr.ax;
    oz = fr.az;
    const theta = (variant + 1) * ANGLE_STEP;
    const L = lat.edge;
    oy = kind === 'floor' ? (level + 1) * H : level * H;
    vC.set((L + L * Math.cos(theta)) / 2, kind === 'floor' ? -DECK_THICKNESS / 2 : H / 2, (L * Math.sin(theta)) / 2);
  }
  const anchor = kind === 'wall' ? { x: ox, z: oz } : { x: lat.facets[facet].cx, z: lat.facets[facet].cz };
  oy += groundHeight(anchor.x, anchor.z, half);
  vZ.set(-vX.z, 0, vX.x);
  out.makeBasis(vX, vY, vZ);
  // Scale about the centre: t = origin + R·c·(1 - s).
  vC.applyMatrix4(out).multiplyScalar(1 - s);
  out.scale(vS.set(s, s, s));
  out.setPosition(ox + vC.x, oy + vC.y, oz + vC.z);
  return variant;
}

export class PieceRenderer {
  private readonly group = new THREE.Group();
  private readonly mats: MaterialSet;
  private readonly wallFrame: Batch;
  private readonly wallTarp: Batch;
  private readonly decks: Batch[] = [];
  private readonly ramps: Batch[] = [];
  private readonly posts: Batch;
  private readonly ladders: Batch;
  private readonly rungX = new THREE.Vector3();
  private readonly rungY = new THREE.Vector3();
  private readonly rungZ = new THREE.Vector3(0, -1, 0);
  private readonly m = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly owner = new THREE.Color();
  private readonly foot = [0, 0];
  private readonly rampXs: number[] = [];
  private readonly rampZs: number[] = [];
  private sig = Number.NaN;
  private popping = false;

  constructor(kit: StructureKit, scene: THREE.Scene, lat: Lattice) {
    this.mats = new MaterialSet(kit);
    const models = pieceModels(kit, lat.edge);
    const geo = (m: ModelGeometry, key: MatKey): THREE.BufferGeometry => {
      const g = m.get(key);
      if (!g) throw new Error(`piece model lacks ${key}`);
      return g;
    };
    this.wallFrame = new Batch(geo(models.wall, 'woodPaint'), this.mats, 'woodPaint', this.group);
    this.wallTarp = new Batch(geo(models.wall, 'tarp'), this.mats, 'tarp', this.group);
    for (let v = 0; v < 4; v++) {
      this.decks.push(new Batch(geo(models.decks[v], 'woodPaint'), this.mats, 'woodPaint', this.group));
      this.ramps.push(new Batch(geo(models.ramps[v], 'woodPaint'), this.mats, 'woodPaint', this.group));
    }
    const post = kit.geometry('piecePost', () => new THREE.CylinderGeometry(STILT_RADIUS * 0.8, STILT_RADIUS, 1, 8).translate(0, 0.5, 0));
    this.posts = new Batch(post, this.mats, 'iron', this.group);
    const ladderBar = kit.geometry('platformLadderBar', () => new THREE.CylinderGeometry(0.035, 0.035, 1, 6).translate(0, 0.5, 0));
    this.ladders = new Batch(ladderBar, this.mats, 'iron', this.group);
    scene.add(this.group);
  }

  update(f: FrameInfo): void {
    const w = f.world;
    const lat = w.lattice;
    // Cheap change signature: membership, hp, ownership, level, lattice turns.
    let sig = w.pieces.size * 1000003 + lat.version * 7919;
    sig += w.boss?.held?.kind === 'piece' ? w.boss.held.id * 1013 + 1 : 0;
    let popping = false;
    for (const p of w.pieces.values()) {
      sig = (sig * 31 + p.id * 17 + Math.round(p.hp) * 3 + p.level + (p.faction + 2) * 101) % 2147483647;
      if (w.time - p.builtAt < PIECE.popIn) popping = true;
    }
    if (sig === this.sig && !popping && !this.popping) return;
    this.sig = sig;
    this.popping = popping;

    this.wallFrame.count = 0;
    this.wallTarp.count = 0;
    this.posts.count = 0;
    this.ladders.count = 0;
    for (const b of this.decks) b.count = 0;
    for (const b of this.ramps) b.count = 0;
    const highestFloor = new Map<number, number>();
    for (const p of w.pieces.values()) if (p.kind === 'floor' && !(w.boss?.held?.kind === 'piece' && w.boss.held.id === p.id)) highestFloor.set(p.facet, Math.max(p.level, highestFloor.get(p.facet) ?? -1));
    for (const p of w.pieces.values()) {
      const age = (w.time - p.builtAt) / PIECE.popIn;
      if (w.boss?.held?.kind === 'piece' && w.boss.held.id === p.id) continue;
      const s = age >= 1 ? 1 : Math.max(0.02, easeOutBack(Math.max(0, age)));
      const dmg = 0.42 + 0.58 * Math.max(0, Math.min(1, p.hp / p.maxHp));
      this.owner.setHex(p.faction >= 0 ? w.factions[p.faction].color : NEUTRAL_COLOR);
      const variant = pieceSlotMatrix(lat, p.kind, p.edge, p.facet, p.level, p.rampEdge, s, this.m, w.map.half);
      if (p.kind === 'wall') {
        this.wallFrame.push(this.m, this.color.setScalar(dmg));
        this.wallTarp.push(this.m, this.color.copy(WHITE).lerp(this.owner, 0.42).multiplyScalar(dmg));
        continue;
      }
      this.color.copy(WHITE).lerp(this.owner, 0.12).multiplyScalar(dmg);
      (p.kind === 'floor' ? this.decks : this.ramps)[variant].push(this.m, this.color);
      if (p.level !== 0 && p.kind !== 'floor') continue;
      this.color.setScalar(dmg);
      const fcGround = lat.facets[p.facet];
      const baseY = groundHeight(fcGround.cx, fcGround.cz, w.map.half);
      if (p.kind === 'floor') {
        if (highestFloor.get(p.facet) !== p.level) continue; // Shared columns are drawn once, to the highest deck.
        for (let i = 0; i < 4; i++) {
          const [x, z] = stiltFoot(lat, p.facet, i, this.foot);
          const footY = groundHeight(x, z, w.map.half);
          this.m.makeScale(s, (baseY + (p.level + 1) * H - DECK_THICKNESS - footY) * s, s).setPosition(x, footY, z);
          this.posts.push(this.m, this.color);
        }
      } else {
        // The rectangular ramp's high corners, not the outer rhombus corners.
        rampPolygon(lat, p.facet, Math.max(0, p.rampEdge), this.rampXs, this.rampZs);
        for (const k of [2, 3]) {
          const x = this.rampXs[k];
          const z = this.rampZs[k];
          const footY = groundHeight(x, z, w.map.half);
          this.m.makeScale(s * 0.7, (baseY + H - RAMP_THICKNESS - footY) * s, s * 0.7).setPosition(x, footY, z);
          this.posts.push(this.m, this.color);
        }
      }
    }
    // Exposed edges share the same derived geometry as authoritative climbing.
    const visibleLadders = new Map<string, ReturnType<typeof platformLadders>[number]>();
    for (const ladder of platformLadders(w)) {
      const key = `${ladder.edge}:${ladder.facet}`;
      if ((visibleLadders.get(key)?.topY ?? -Infinity) < ladder.topY) visibleLadders.set(key, ladder);
    }
    for (const ladder of visibleLadders.values()) {
      const piece = w.pieces.get(ladder.pieceId);
      if (!piece || (w.boss?.held?.kind === 'piece' && w.boss.held.id === piece.id)) continue;
      const dmg = 0.42 + 0.58 * Math.max(0, Math.min(1, piece.hp / piece.maxHp));
      this.color.setScalar(dmg);
      const tx = -ladder.nz, tz = ladder.nx;
      const x = ladder.x + ladder.nx * PLATFORM_LADDER_RAIL_OFFSET;
      const z = ladder.z + ladder.nz * PLATFORM_LADDER_RAIL_OFFSET;
      for (const side of [-1, 1]) {
        const rx = x + tx * PLATFORM_LADDER_WIDTH * .5 * side;
        const rz = z + tz * PLATFORM_LADDER_WIDTH * .5 * side;
        const foot = w.collision.groundHeight(rx, rz);
        this.m.makeScale(1, ladder.topY + .7 - foot, 1).setPosition(rx, foot, rz);
        this.ladders.push(this.m, this.color);
      }
      this.rungX.set(ladder.nx, 0, ladder.nz);
      this.rungY.set(tx, 0, tz);
      const rise = ladder.topY - ladder.bottomY;
      const count = Math.max(1, Math.ceil(rise / .35));
      for (let i = 1; i <= count; i++) {
        this.m.makeBasis(this.rungX, this.rungY, this.rungZ);
        this.m.scale(vS.set(1, PLATFORM_LADDER_WIDTH, 1));
        this.m.setPosition(x - tx * PLATFORM_LADDER_WIDTH * .5, ladder.bottomY + rise * i / count, z - tz * PLATFORM_LADDER_WIDTH * .5);
        this.ladders.push(this.m, this.color);
      }
    }
    this.ladders.finish();
    this.wallFrame.finish();
    this.wallTarp.finish();
    this.posts.finish();
    for (const b of this.decks) b.finish();
    for (const b of this.ramps) b.finish();
  }

  dispose(): void {
    this.wallFrame.dispose();
    this.wallTarp.dispose();
    this.posts.dispose();
    this.ladders.dispose();
    for (const b of this.decks) b.dispose();
    for (const b of this.ramps) b.dispose();
    this.group.parent?.remove(this.group);
    this.mats.dispose();
  }
}
