/**
 * Sound-camp stages (kind 'stage', box; local +z faces the dance floor): a black deck over
 * the whole footprint with an LED lip, the back wall at z = -hz carrying the camp's lettered
 * backdrop in an LED frame, box-truss towers on the front posts and a front truss under the
 * roof with moving-head fixtures, speaker stacks, a DJ booth with decks and a laptop, a disco
 * ball, PAR cans and feather banners. Returns the light-show rig of every stage.
 *
 * StageSigns draws every camp name into one CanvasTexture atlas (one draw call) whose
 * emissive strength follows the night.
 */
import * as THREE from 'three';
import { ownProp } from './kit';
import type { Obstacle, SoundCamp } from '../../../sim/map/mapgen';
import { GlowMode, PartsBuilder } from '../geom';
import { flat, frameOf, GeoWriter, toWorld, within } from './batch';
import { featherBanner } from './cloth';
import type { ClutterKit, PropBatches } from './kit';

const DECK_SKIRT = 0x141416;
const DECK_TOP = 0x2a2724;
const WALL = 0x1b1c22;
const ROOF = 0x202126;
const TRUSS = 0xb8bdc3;
const BLACK = 0x151517;
const CONE = 0x3a3b40;

export interface StageRig {
  obstacleId: number;
  /** World-space lens positions of the moving heads on the front truss. */
  fixtures: THREE.Vector3[];
  /** World axes of the stage: across (local +x) and toward the dance floor (local +z). */
  right: THREE.Vector3;
  forward: THREE.Vector3;
  /** Camp colour (linear). */
  color: THREE.Color;
  /** Front edge centre of the deck on the ground. */
  front: THREE.Vector3;
  hx: number;
  hz: number;
  /** Stage frame (for the dance-floor light quad). */
  frame: THREE.Matrix4;
}

interface SignSpec {
  obstacleId: number;
  /** World corners: bottom-left, bottom-right, top-right, top-left (seen from the front). */
  corners: THREE.Vector3[];
  normal: THREE.Vector3;
  name: string;
  color: THREE.Color;
}

/** Square box truss from a to c (chords on the corners, zigzag lacing on each face). */
function truss(w: GeoWriter, a: THREE.Vector3, c: THREE.Vector3, width: number): void {
  const axis = c.clone().sub(a);
  const len = axis.length();
  axis.normalize();
  const ref = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(axis, ref).normalize().multiplyScalar(width / 2);
  const v = new THREE.Vector3().crossVectors(axis, u).normalize().multiplyScalar(width / 2);
  const corners = [u.clone().add(v), u.clone().sub(v), u.clone().negate().sub(v), u.clone().negate().add(v)];
  w.paint(TRUSS);
  for (const k of corners) w.tube(a.clone().add(k), c.clone().add(k), 0.024, 0.024, 4);
  const n = Math.max(1, Math.round(len / (width * 1.5)));
  for (let f = 0; f < 4; f++) {
    const k0 = corners[f];
    const k1 = corners[(f + 1) % 4];
    for (let i = 0; i < n; i++) {
      const p = a.clone().addScaledVector(axis, (len * i) / n);
      const q = a.clone().addScaledVector(axis, (len * (i + 1)) / n);
      const [from, to] = i % 2 === 0 ? [k0, k1] : [k1, k0];
      w.tube(p.add(from), q.add(to), 0.011, 0.011, 3);
    }
  }
}

function speakerStack(b: PartsBuilder, x: number, y: number, z: number, ry: number): void {
  const boxes: [number, number, number, number][] = [
    [1.1, 0.75, 0.85, 0],
    [0.82, 0.55, 0.65, 0.75],
    [0.82, 0.55, 0.65, 1.3],
  ];
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  for (const [w, h, d, y0] of boxes) {
    b.box(w, h, d, BLACK, { x, y: y + y0 + h / 2, z, ry });
    const cones = w > 1 ? [0] : [-0.18, 0.18];
    const r = w > 1 ? 0.28 : 0.15;
    for (const off of cones) {
      // Cone discs on the front face, turned with the cabinet.
      const fx = x + off * c + (d / 2 + 0.01) * s;
      const fz = z - off * s + (d / 2 + 0.01) * c;
      // Euler XYZ: rz = -ry turns the disc axis to the cabinet's facing (sin ry, 0, cos ry).
      b.cylinder(r, r, 0.03, CONE, { x: fx, y: y + y0 + h / 2, z: fz, rx: Math.PI / 2, rz: -ry }, { segments: 10 });
      b.cylinder(r * 0.3, r * 0.3, 0.05, 0x55575d, { x: fx, y: y + y0 + h / 2, z: fz, rx: Math.PI / 2, rz: -ry }, { segments: 8 });
    }
  }
}

/** The sound camp a stage plays to: the nearest camp in front of it. */
function campFor(o: Obstacle, camps: SoundCamp[]): SoundCamp | null {
  let best: SoundCamp | null = null;
  let bestD = Infinity;
  for (const c of camps) {
    const d = Math.hypot(c.x - o.x, c.z - o.z);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export interface StageBuild {
  rigs: StageRig[];
  signs: SignSpec[];
}

const FIXTURES = { low: 3, medium: 4, high: 6 };

/** Presentation-only light rigs and name boards, with no stage model construction. */
export function stagePresentation(stages: readonly Obstacle[], camps: SoundCamp[], quality: PropBatches['quality']): StageBuild {
  const result: StageBuild = { rigs: [], signs: [] };
  for (const o of stages) {
    const camp = campFor(o, camps), color = new THREE.Color(camp ? camp.color : o.color);
    const frame = frameOf(o.x, o.z, o.yaw), hx = o.hx, hz = o.hz, H = o.height;
    const sw = hx * 2 * .86, sh = (H - 1.1) * .62, sy = 1.1 + (H - 1.1) * .53, sz = -hz + .425;
    result.signs.push({ obstacleId: o.id,
      corners: [toWorld(frame, -sw / 2, sy - sh / 2, sz), toWorld(frame, sw / 2, sy - sh / 2, sz),
        toWorld(frame, sw / 2, sy + sh / 2, sz), toWorld(frame, -sw / 2, sy + sh / 2, sz)],
      normal: new THREE.Vector3(Math.sin(o.yaw), 0, Math.cos(o.yaw)), name: camp?.name ?? 'Sound Camp', color });
    const px = hx - .2, pz = hz - .2;
    const count = Math.max(3, Math.min(FIXTURES[quality], Math.round(hx * 2 / 2.2)));
    const fixtures = Array.from({ length: count }, (_, k) => toWorld(frame,
      -px + .7 + (px * 2 - 1.4) * k / Math.max(1, count - 1), H - .7, pz + .17));
    result.rigs.push({ obstacleId: o.id, fixtures,
      right: new THREE.Vector3(Math.cos(o.yaw), 0, -Math.sin(o.yaw)),
      forward: new THREE.Vector3(Math.sin(o.yaw), 0, Math.cos(o.yaw)),
      color, front: toWorld(frame, 0, 0, hz), hx, hz, frame });
  }
  return result;
}

export function buildStages(stages: Obstacle[], camps: SoundCamp[], kit: ClutterKit, out: PropBatches): StageBuild {
  const result: StageBuild = { rigs: [], signs: [] };
  for (const o of stages) {
    ownProp(out, o.id);
    const camp = campFor(o, camps);
    const color = new THREE.Color(camp ? camp.color : o.color);
    const hx = o.hx;
    const hz = o.hz;
    const H = o.height;
    const frame = frameOf(o.x, o.z, o.yaw);
    const b = new PartsBuilder();
    const g = new PartsBuilder();
    const steel = new GeoWriter();

    // Deck and LED lip.
    b.box(hx * 2, 1.06, hz * 2 - 0.4, DECK_SKIRT, { y: 0.53, z: 0.2 });
    b.box(hx * 2 + 0.04, 0.05, hz * 2 - 0.36, DECK_TOP, { y: 1.085, z: 0.2 });
    b.box(hx * 2, 0.06, 0.05, color, { y: 1.04, z: hz + 0.01 }, { glow: 3, glowMode: GlowMode.beat });

    // Back wall with the LED-framed backdrop.
    b.box(hx * 2, H, 0.4, WALL, { y: H / 2, z: -hz + 0.2 });
    const sw = hx * 2 * 0.86;
    const sh = (H - 1.1) * 0.62;
    const sy = 1.1 + (H - 1.1) * 0.53;
    const sz = -hz + 0.42;
    for (const dy of [-1, 1]) b.box(sw + 0.16, 0.08, 0.04, color, { y: sy + dy * (sh / 2 + 0.04), z: sz }, { glow: 2.4, glowMode: GlowMode.beat });
    for (const dx of [-1, 1]) b.box(0.08, sh + 0.16, 0.04, color, { x: dx * (sw / 2 + 0.04), y: sy, z: sz }, { glow: 2.4, glowMode: GlowMode.beat });
    result.signs.push({
      obstacleId: o.id,
      corners: [
        toWorld(frame, -sw / 2, sy - sh / 2, sz + 0.005),
        toWorld(frame, sw / 2, sy - sh / 2, sz + 0.005),
        toWorld(frame, sw / 2, sy + sh / 2, sz + 0.005),
        toWorld(frame, -sw / 2, sy + sh / 2, sz + 0.005),
      ],
      normal: new THREE.Vector3(Math.sin(o.yaw), 0, Math.cos(o.yaw)),
      name: camp ? camp.name : 'Sound Camp',
      color,
    });

    // Truss towers on the front posts, front truss, side beams, roof with fascia.
    const px = hx - 0.2;
    const pz = hz - 0.2;
    for (const sx of [-1, 1]) {
      truss(steel, new THREE.Vector3(sx * px, 0, pz), new THREE.Vector3(sx * px, H - 0.04, pz), 0.32);
      g.box(0.5, 0.06, 0.5, 0x3a3d42, { x: sx * px, y: 0.03, z: pz });
      g.box(0.12, 0.12, hz * 2 - 0.6, TRUSS, { x: sx * px, y: H - 0.2, z: 0.1 });
    }
    truss(steel, new THREE.Vector3(-px + 0.16, H - 0.2, pz), new THREE.Vector3(px - 0.16, H - 0.2, pz), 0.3);
    b.box(hx * 2 + 0.3, 0.14, hz * 2 + 0.15, ROOF, { y: H + 0.07, z: 0.02 });
    b.box(hx * 2 + 0.3, 0.38, 0.06, color, { y: H - 0.05, z: hz + 0.1 });
    b.box(hx * 2 + 0.3, 0.05, 0.05, color, { y: H - 0.27, z: hz + 0.13 }, { glow: 3, glowMode: GlowMode.beat });

    // Speakers, booth, decks, laptop, disco ball.
    for (const sx of [-1, 1]) speakerStack(b, sx * (hx - 0.95), 1.11, hz - 0.75, -sx * 0.14);
    const bz = -hz + 0.4 + 1.25;
    b.box(2.0, 1.0, 0.75, BLACK, { y: 1.6, z: bz });
    b.box(1.9, 0.55, 0.02, color, { y: 1.62, z: bz + 0.385 }, { glow: 1.4, glowMode: GlowMode.beat });
    for (const sx of [-1, 1]) {
      b.cylinder(0.17, 0.17, 0.03, 0x222222, { x: sx * 0.55, y: 2.115, z: bz }, { segments: 12 });
      b.cylinder(0.15, 0.15, 0.012, 0x8a8d93, { x: sx * 0.55, y: 2.135, z: bz }, { segments: 12 });
    }
    b.box(0.36, 0.06, 0.3, 0x1a1a1a, { y: 2.13, z: bz });
    b.box(0.3, 0.012, 0.22, 0xffffff, { y: 2.165, z: bz }, { glow: 1.6, glowMode: GlowMode.rainbow });
    b.box(0.34, 0.02, 0.24, 0x9a9da3, { x: 0.25, y: 2.12, z: bz - 0.25 });
    b.box(0.34, 0.22, 0.012, 0x9ecbff, { x: 0.25, y: 2.24, z: bz - 0.37, rx: -0.3 }, { glow: 1.3 });
    g.add(flat(new THREE.IcosahedronGeometry(0.33, 1)), 0xe9eef3, { y: H - 1.0, z: hz - 1.4 }, { glow: 1.5, glowMode: GlowMode.twinkle });
    b.box(0.012, 0.75, 0.012, 0x222222, { y: H - 0.3, z: hz - 1.4 });

    // Moving heads hanging from the front truss: the beams start at their lenses.
    const count = Math.max(3, Math.min(FIXTURES[out.quality], Math.round((hx * 2) / 2.2)));
    const fixtures: THREE.Vector3[] = [];
    for (let k = 0; k < count; k++) {
      const x = -px + 0.7 + ((px * 2 - 1.4) * k) / Math.max(1, count - 1);
      b.box(0.32, 0.06, 0.2, BLACK, { x, y: H - 0.38, z: pz });
      for (const dx of [-0.14, 0.14]) b.box(0.035, 0.24, 0.05, BLACK, { x: x + dx, y: H - 0.52, z: pz });
      b.cylinder(0.13, 0.15, 0.3, BLACK, { x, y: H - 0.62, z: pz + 0.02, rx: Math.PI / 2 + 0.5 }, { segments: 10 });
      b.cylinder(0.11, 0.11, 0.02, 0xffffff, { x, y: H - 0.69, z: pz + 0.15, rx: Math.PI / 2 + 0.5 }, { segments: 10, glow: 2.5, glowMode: GlowMode.beat });
      fixtures.push(toWorld(frame, x, H - 0.7, pz + 0.17));
    }
    // PAR cans on the deck lip washing the backdrop.
    for (let k = 0; k < 4; k++) {
      const x = -hx * 0.6 + (hx * 1.2 * k) / 3;
      b.cylinder(0.09, 0.11, 0.22, BLACK, { x, y: 1.22, z: hz - 0.25, rx: -0.6 }, { segments: 8 });
      b.cylinder(0.085, 0.085, 0.015, color, { x, y: 1.28, z: hz - 0.3, rx: -0.6 }, { segments: 8, glow: 2.2, glowMode: GlowMode.beat });
    }
    out.solid.add(b.build(), frame);
    out.gloss.add(g.build(), frame);
    out.gloss.add(steel.build(), frame);

    // Feather banners beside the stage.
    for (const sx of [-1, 1]) {
      out.solid.add(kit.pole, within(frame, { x: sx * (hx + 0.7), z: hz - 0.4, sy: 1.5 }));
      const base = toWorld(frame, sx * (hx + 0.7), 0, hz - 0.4);
      const outward = new THREE.Vector3(Math.cos(o.yaw) * sx, 0, -Math.sin(o.yaw) * sx);
      featherBanner(out.strings, base, outward, 3.7, color);
    }

    result.rigs.push({
      obstacleId: o.id,
      fixtures,
      right: new THREE.Vector3(Math.cos(o.yaw), 0, -Math.sin(o.yaw)),
      forward: new THREE.Vector3(Math.sin(o.yaw), 0, Math.cos(o.yaw)),
      color,
      front: toWorld(frame, 0, 0, hz),
      hx,
      hz,
      frame,
    });
  }
  return result;
}

// ── Signs ─────────────────────────────────────────────────────────────────────

const ROW_W = 1024;
const ROW_H = 256;

function drawStar(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
    const rad = k % 2 === 0 ? r : r * 0.42;
    g.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
  }
  g.closePath();
  g.fill();
}

function drawSign(g: CanvasRenderingContext2D, y0: number, name: string, color: THREE.Color): void {
  const css = `#${color.getHexString()}`;
  const bg = g.createLinearGradient(0, y0, 0, y0 + ROW_H);
  bg.addColorStop(0, '#160f22');
  bg.addColorStop(1, '#060509');
  g.fillStyle = bg;
  g.fillRect(0, y0, ROW_W, ROW_H);
  // Sunburst behind the lettering.
  g.save();
  g.beginPath();
  g.rect(0, y0, ROW_W, ROW_H);
  g.clip();
  g.globalAlpha = 0.16;
  g.fillStyle = css;
  for (let k = 0; k < 24; k += 2) {
    const a0 = (k / 24) * Math.PI * 2;
    const a1 = ((k + 1) / 24) * Math.PI * 2;
    g.beginPath();
    g.moveTo(ROW_W / 2, y0 + ROW_H / 2);
    g.lineTo(ROW_W / 2 + Math.cos(a0) * ROW_W, y0 + ROW_H / 2 + Math.sin(a0) * ROW_W);
    g.lineTo(ROW_W / 2 + Math.cos(a1) * ROW_W, y0 + ROW_H / 2 + Math.sin(a1) * ROW_W);
    g.closePath();
    g.fill();
  }
  g.restore();
  g.strokeStyle = css;
  g.lineWidth = 8;
  g.strokeRect(14, y0 + 14, ROW_W - 28, ROW_H - 28);
  g.lineWidth = 2;
  g.strokeRect(28, y0 + 28, ROW_W - 56, ROW_H - 56);
  // Lettering: white core with a glow in the camp colour, shrunk to fit.
  const text = name.toUpperCase();
  let size = 112;
  g.font = `400 ${size}px "Bungee", Impact, sans-serif`;
  const maxW = ROW_W - 240;
  const w = g.measureText(text).width;
  if (w > maxW) {
    size = Math.floor((size * maxW) / w);
    g.font = `400 ${size}px "Bungee", Impact, sans-serif`;
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = css;
  g.shadowBlur = 30;
  g.fillStyle = '#ffffff';
  g.fillText(text, ROW_W / 2, y0 + ROW_H / 2 + 4);
  g.shadowBlur = 0;
  g.lineWidth = 3;
  g.strokeStyle = css;
  g.strokeText(text, ROW_W / 2, y0 + ROW_H / 2 + 4);
  g.fillStyle = css;
  drawStar(g, 70, y0 + ROW_H / 2, 34);
  drawStar(g, ROW_W - 70, y0 + ROW_H / 2, 34);
}

export class StageSigns {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshStandardMaterial;
  private texture: THREE.CanvasTexture;

  constructor(private readonly specs: SignSpec[]) {
    const canvas = document.createElement('canvas');
    canvas.width = ROW_W;
    canvas.height = ROW_H * specs.length;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d canvas unavailable');
    specs.forEach((s, i) => drawSign(g, i * ROW_H, s.name, s.color));
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      emissiveMap: this.texture,
      emissive: 0xffffff,
      emissiveIntensity: 0.3,
      roughness: 0.55,
    });
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    specs.forEach((s, i) => {
      const v0 = 1 - (i + 1) / specs.length;
      const v1 = 1 - i / specs.length;
      const base = i * 4;
      const uvs = [0, v0, 1, v0, 1, v1, 0, v1];
      s.corners.forEach((c, k) => {
        pos.push(c.x, c.y, c.z);
        nor.push(s.normal.x, s.normal.y, s.normal.z);
        uv.push(uvs[k * 2], uvs[k * 2 + 1]);
      });
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'stage-signs';
    this.mesh.receiveShadow = true;
  }

  removeScenery(id: number): void {
    const index = this.mesh.geometry.index!;
    this.specs.forEach((spec, i) => {
      if (spec.obstacleId !== id) return;
      for (let k = 0; k < 6; k++) index.setX(i * 6 + k, i * 4);
      index.addUpdateRange(i * 6, 6); index.needsUpdate = true;
    });
  }

  /** LED backdrops: readable by day, glowing at night. */
  update(night: number): void {
    // The white lettering must stay under the night bloom threshold's blow-out to stay legible.
    this.material.emissiveIntensity = 0.3 + 0.45 * night;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
