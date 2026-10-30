/**
 * Tutorial objective markers (Session.markers, written by the Training Burn director; the
 * list may change any frame). 'node': a breathing ring on the Ley Node with five turning
 * spokes and a swelling echo, under a soft column of light. 'entity': lock-on brackets and a
 * column riding above the entity, re-resolved through the world maps every frame (units use
 * the actors' smoothed anchors). 'point': a waypoint beacon (dashed reticle, inward chevrons,
 * tall column). 'area': a ring of marching dashes with a low curtain of light. Each may carry
 * a plaque label (labels.ts).
 *
 * Markers settle in when they appear and lift away when they leave. Every element draws
 * twice (XrayMeshes): normally, and faint and hatched where an opaque prop hides it. Rings and
 * columns keep a minimum on-screen size at range; all light follows the Survey night budget
 * (uGlow) and a per-material HDR cap, so a cluster of markers never clips to white.
 */
import * as THREE from 'three';
import { groundHeight } from '../../sim/terrain';
import type { ObjectiveMarker, Session } from '../../game/session';
import { BUILDING_HEIGHT, BUILDINGS, CRYSTAL_HEIGHT, FLAG_YELLOW, LEVEL_HEIGHT } from '../../sim/constants';
import type { EntityId } from '../../sim/types';
import type { World } from '../../sim/world';
import type { SharedRender } from '../context';
import { GLSL_COMMON, GLSL_FRAG, GLSL_OUTPUT, GLSL_VERT, cornerQuad, cornerGrid, surveyMaterial } from './glsl';
import type { SurveyMaterialOptions, SurveyUniforms } from './glsl';
import { InstanceSet, XrayMeshes } from './instances';
import { LABEL_LIFT_PX, LabelLayer, labelHeightPx } from './labels';
import type { SurveyData } from './surveyData';

type MarkerKind = ObjectiveMarker['kind'];

const MAX_MARKERS = 48;
/** Seconds a marker takes to settle in, and to lift away once the director drops it. */
const APPEAR = 0.7;
const LEAVE = 0.5;
const DEFAULT_AREA_RADIUS = 8;
/** Ground rings never grow past this multiple of their base radius to stay visible at range. */
const MAX_RING_GROWTH = 4;
const AREA_CURTAIN_HEIGHT = 1.4;

const KIND_ID: Record<MarkerKind, number> = { node: 0, entity: 1, point: 2, area: 3 };
/** Ground ring radius (m) before distance growth; entities use their own footprint. */
const RING_RADIUS: Record<MarkerKind, number> = { node: 1.35, entity: 1, point: 2.2, area: 0 };
/** Smallest on-screen ring radius (css px) before the ring starts growing with distance. */
const RING_MIN_PX: Record<MarkerKind, number> = { node: 15, entity: 12, point: 20, area: 0 };
/** Light column: height (m, 0 = none), half-width (m) and strength. */
const COLUMN: Record<MarkerKind, { height: number; halfWidth: number; strength: number }> = {
  node: { height: 13, halfWidth: 0.42, strength: 0.9 },
  entity: { height: 9, halfWidth: 0.34, strength: 0.75 },
  point: { height: 24, halfWidth: 0.62, strength: 1 },
  area: { height: 0, halfWidth: 0, strength: 0 },
};
/** Label height above the marker's base (m); entities place it above their own top. */
const LABEL_LIFT: Record<MarkerKind, number> = { node: 2.9, entity: 0.75, point: 3.3, area: 3 };

/** Entity footprint radius (m) and top height above its base (m) by map. */
const UNIT_RING = 0.9;
const AVATAR_TOP = 1.85;
const HIPPIE_TOP = 1.6;
const FLAG_TOP = 2.7;

const XRAY_HATCH = /* glsl */ `
#ifdef FH_OCCLUDED
  // Hidden behind something solid: a faint diagonal hatch of the same light.
  I *= 0.3 * (0.45 + 0.55 * step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) / (6.0 * uPx))));
#endif
`;

const GROUND_VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCorner;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iColor;
varying vec2 vM;
flat varying vec4 vB;
flat varying vec4 vColor;
flat varying float vR;

void main() {
  float R = iA.w;
  // Room around the ring for the arrival swell and the pulse echo; areas need none.
  float pad = fhId(iB.x) == 3 ? 1.08 : 1.9;
  vec2 m = aCorner * R * pad;
  vec4 mv = viewMatrix * vec4(iA.x + m.x, iA.y + fhGround(iA.xz + m) - fhGround(iA.xz) + 0.08, iA.z + m.y, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vM = m;
  vB = iB;
  vColor = iColor;
  vR = R;
}
`;

const GROUND_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vM;
flat varying vec4 vB;
flat varying vec4 vColor;
flat varying float vR;

/** Coverage of a stroke at distance d (m), half-width hw (m), never thinner than ~1.5 px
 * (~2.7 px on the Command View table, where the map grade would otherwise thin it out). */
float stroke(float d, float hw, float px) {
  float w = max(hw, px * (0.75 + 0.6 * uViewBlend));
  return clamp((w - abs(d)) / px + 0.5, 0.0, 1.0);
}

/** Lit share of a ring cut into n segments per turn, each a fraction fill long, at radius r. */
float segments(float ang, float n, float fill, float r, float px) {
  float u = fract(ang / FH_TAU * n);
  float d = (abs(u - 0.5) - 0.5 * fill) * FH_TAU * r / n;
  return clamp(-d / px + 0.5, 0.0, 1.0);
}

/** Radial spokes: n per turn, half-width hw (m). */
float spokes(float ang, float n, float r, float hw, float px) {
  float sector = FH_TAU / n;
  float da = abs(mod(ang + 0.5 * sector, sector) - 0.5 * sector);
  return stroke(da * r, hw, px);
}

void main() {
  float r = length(vM);
  float px = max(0.7071 * length(fwidth(vM)), 1e-4);
  int kind = fhId(vB.x);
  float appear = vB.y;
  float leave = vB.z;
  float seed = vB.w * FH_TAU;
  // Arrival: rings settle in from wider; departure: they draw in as they fade.
  float R = vR * (1.0 + 0.6 * (1.0 - appear) * (1.0 - appear) - 0.2 * leave);
  float ang = r > 1e-4 ? atan(vM.y, vM.x) : 0.0;
  float line = 0.0;
  float fill = 0.0;
  if (kind == 0) {
    // Ley Node: a breathing ring, an inner ring and five turning spokes (the five pentagrid
    // families meet at every node), and an echo swelling outward.
    float breathe = 1.0 + 0.05 * sin(uTime * 3.4 + seed);
    line = stroke(r - R * breathe, 0.07, px);
    line = max(line, 0.75 * stroke(r - R * 0.58, 0.035, px));
    float span = clamp((r - R * 0.62) / px + 0.5, 0.0, 1.0) * clamp((R * 0.92 - r) / px + 0.5, 0.0, 1.0);
    line = max(line, 0.8 * spokes(ang + uTime * 0.5 + seed, 5.0, r, 0.04, px) * span);
    float e = fract(uTime / 1.7 + vB.w);
    line = max(line, stroke(r - R * (1.0 + 0.7 * e), 0.05, px) * (1.0 - e) * (1.0 - e) * 0.9);
    fill = exp(-(r * r) / (R * R * 0.3)) * 0.22;
  } else if (kind == 1) {
    // Entity: four lock-on brackets turning around the target over a faint inner ring.
    line = stroke(r - R, 0.07, px) * segments(ang + uTime * 0.7 + seed, 4.0, 0.42, r, px);
    line = max(line, 0.4 * stroke(r - R * 0.82, 0.03, px));
    float e = fract(uTime / 2.2 + vB.w);
    line = max(line, stroke(r - R * (0.82 + 0.5 * e), 0.04, px) * (1.0 - e) * 0.6);
    fill = exp(-(r * r) / (R * R * 0.25)) * 0.12;
  } else if (kind == 2) {
    // Waypoint: a dashed reticle, an inner ring, three chevrons pointing in, a centre dot.
    float spin = uTime * 0.35 + seed;
    line = stroke(r - R, 0.06, px) * segments(ang - spin, 18.0, 0.55, r, px);
    line = max(line, stroke(r - R * 0.4, 0.05, px));
    float apex = R * (0.62 + 0.1 * sin(uTime * 3.0 + seed));
    for (int i = 0; i < 3; i++) {
      float th = spin * 0.5 + float(i) * FH_TAU / 3.0;
      vec2 dir = vec2(cos(th), sin(th));
      vec2 p = vec2(dot(vM, dir), dot(vM, vec2(-dir.y, dir.x)));
      // A V whose apex points at the centre: arms satisfy p.x - apex = 0.9 |p.y|.
      float d = ((p.x - apex) - abs(p.y) * 0.9) * 0.743;
      float arm = clamp((R * 0.22 - abs(p.y)) / px + 0.5, 0.0, 1.0) * step(0.0, p.x);
      line = max(line, stroke(d, 0.06, px) * arm);
    }
    line = max(line, clamp((R * 0.1 - r) / px + 0.5, 0.0, 1.0));
    fill = exp(-(r * r) / (R * R * 0.2)) * 0.15;
  } else {
    // Area: dashes of constant length march around the boundary; a soft band glows inside.
    float n = max(12.0, floor(FH_TAU * vR / 2.6 + 0.5));
    float off = uTime * 0.35 / max(vR, 1.0) + seed;
    line = stroke(r - R, 0.09, px) * segments(ang + off, n, 0.6, r, px);
    fill = smoothstep(R - 3.0, R, r) * clamp((R - r) / px + 0.5, 0.0, 1.0) * 0.14 + step(r, R) * 0.02;
  }
  float I = (line * 1.1 + fill) * vColor.a * uGlow.w * fhFogKeep();
  // By day a stroke also darkens the ground under it a little, for contrast on bright grass.
  float shade = line * vColor.a * 0.18 * fhDay();
  ${XRAY_HATCH}
#ifdef FH_OCCLUDED
  shade = 0.0;
#endif
  if (I < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb * I, shade);
  ${GLSL_OUTPUT}
}
`;

const COLUMN_VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCorner;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iColor;
varying vec2 vQ;
varying float vY;
flat varying vec4 vB;
flat varying vec4 vColor;
flat varying float vNear;

void main() {
  float grow = 1.0 - (1.0 - iB.y) * (1.0 - iB.y) * (1.0 - iB.y);
  float H = iB.x * max(grow, 0.02);
  vec3 P = iA.xyz + vec3(0.0, aCorner.y * H, 0.0);
  vec3 toCam = cameraPosition - P;
  vec2 side = vec2(toCam.z, -toCam.x);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : vec2(1.0, 0.0);
  // At range the column keeps ~3 px of width instead of vanishing.
  float hw = max(iA.w, 1.5 * uPx * length(toCam) / fhProjScale());
  P.xz += side * aCorner.x * hw;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vQ = aCorner;
  vY = aCorner.y * H;
  vB = vec4(H, iB.yzw);
  vColor = iColor;
  // Standing in the column must not wash out the screen.
  vNear = smoothstep(1.2, 7.0, length(cameraPosition.xz - iA.xz));
}
`;

const COLUMN_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vQ;
varying float vY;
flat varying vec4 vB;
flat varying vec4 vColor;
flat varying float vNear;

void main() {
  float s = vQ.x;
  float t = vQ.y;
  float H = vB.x;
  float appear = vB.y;
  float leave = vB.z;
  float core = exp(-s * s * 9.0);
  float glow = exp(-s * s * 2.2);
  float fall = pow(max(1.0 - t, 0.0), 1.4);
  float foot = exp(-vY / 0.9);
  float bands = 0.82 + 0.18 * sin(vY * 0.9 - uTime * 2.6 + vB.w * FH_TAU);
  // A bright tip leads the column up while it rises.
  float head = fhGauss((1.0 - t) * H / 1.4) * (1.0 - appear) * 1.6;
  // Departure: the column lifts off the ground and thins away.
  float lift = smoothstep(leave * 1.1 - 0.1, leave * 1.1 + 0.1, t) * (1.0 - leave);
  float I = ((glow * 0.25 + core * 0.7) * fall * bands + (foot * 0.8 + head) * core) * lift;
  I *= vColor.a * vNear * uGlow.w * fhFogKeep();
  ${XRAY_HATCH}
  if (I < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb * I, 0.0);
  ${GLSL_OUTPUT}
}
`;

const CURTAIN_VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCyl;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iColor;
varying vec2 vUV;
varying float vDist;
flat varying vec4 vB;
flat varying vec4 vColor;
flat varying float vR;

void main() {
  float ang = aCyl.x * FH_TAU;
  float rise = 1.0 - (1.0 - iB.y) * (1.0 - iB.y) * (1.0 - iB.y);
  float H = iB.x * rise * (1.0 - iB.z);
  vec3 P = vec3(iA.x + cos(ang) * iA.w, iA.y + aCyl.y * H, iA.z + sin(ang) * iA.w);
  P.y += fhGround(P.xz) - fhGround(iA.xz);
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vUV = aCyl;
  vDist = length(cameraPosition - P);
  vB = iB;
  vColor = iColor;
  vR = iA.w;
}
`;

const CURTAIN_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vUV;
varying float vDist;
flat varying vec4 vB;
flat varying vec4 vColor;
flat varying float vR;

void main() {
  // The same marching dashes as the ground ring, rising as a faint fence of light.
  float n = max(12.0, floor(FH_TAU * vR / 2.6 + 0.5));
  float off = uTime * 0.35 / max(vR, 1.0) + vB.w * FH_TAU;
  float u = fract((vUV.x * FH_TAU + off) / FH_TAU * n);
  float dash = 1.0 - smoothstep(0.27, 0.31, abs(u - 0.5));
  float v = vUV.y;
  float shimmer = 0.75 + 0.25 * sin(v * 7.0 - uTime * 2.4);
  float I = dash * (1.0 - v) * (1.0 - v) * shimmer * 0.24;
  I *= vColor.a * smoothstep(2.0, 8.0, vDist) * uGlow.w * fhFogKeep();
  ${XRAY_HATCH}
  if (I < 0.002) discard;
  gl_FragColor = vec4(vColor.rgb * I, 0.0);
  ${GLSL_OUTPUT}
}
`;

/** Open cylinder (radius 1, height 1) as (around 0..1, up 0..1) pairs for the area curtain. */
function curtainGeometry(segments: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const uv: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    uv.push(i / segments, 0, i / segments, 1);
    if (i < segments) {
      const k = i * 2;
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  g.setAttribute('aCyl', new THREE.Float32BufferAttribute(uv, 2));
  // three sizes the draw from position; the shader builds the ring from aCyl.
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((segments + 1) * 6), 3));
  g.setIndex(index);
  return g;
}

/** An instanced marker element: shared geometry, attributes, and its x-ray twin meshes. */
class MarkerLayer {
  readonly set: InstanceSet;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly color: Float32Array;
  private readonly meshes: XrayMeshes;
  count = 0;

  constructor(
    scene: THREE.Scene,
    shared: SurveyUniforms,
    geo: THREE.InstancedBufferGeometry,
    shaders: Pick<SurveyMaterialOptions, 'vertexShader' | 'fragmentShader' | 'hdrCap'>,
    renderOrder: number,
  ) {
    this.set = new InstanceSet(geo, MAX_MARKERS);
    this.a = this.set.add('iA', 4);
    this.b = this.set.add('iB', 4);
    this.color = this.set.add('iColor', 4);
    const make = (occluded: boolean): THREE.ShaderMaterial => {
      const m = surveyMaterial(shared, { ...shaders, side: THREE.DoubleSide, defines: occluded ? { FH_OCCLUDED: 1 } : {} });
      m.forceSinglePass = true;
      return m;
    };
    this.meshes = new XrayMeshes(scene, geo, make(false), make(true), renderOrder);
  }

  /** Append one instance: A = (x, y, z, size), B = (param, appear, leave, seed). */
  push(ax: number, ay: number, az: number, aw: number, bx: number, appear: number, leave: number, seed: number, color: THREE.Color, strength: number): void {
    if (this.count >= this.set.capacity) return;
    const o = this.count++ * 4;
    this.a[o] = ax;
    this.a[o + 1] = ay;
    this.a[o + 2] = az;
    this.a[o + 3] = aw;
    this.b[o] = bx;
    this.b[o + 1] = appear;
    this.b[o + 2] = leave;
    this.b[o + 3] = seed;
    this.color[o] = color.r;
    this.color[o + 1] = color.g;
    this.color[o + 2] = color.b;
    this.color[o + 3] = strength;
  }

  commit(): void {
    this.set.commit(this.count);
    this.meshes.visible = this.count > 0;
  }

  dispose(): void {
    this.meshes.dispose();
    this.set.geo.dispose();
  }
}

/** Presentation state of one marker id (pooled). */
interface MarkerView {
  id: string;
  kind: MarkerKind;
  node: number;
  entity: EntityId;
  atX: number;
  atZ: number;
  hasAt: boolean;
  radius: number;
  label: string;
  colorHex: number;
  color: THREE.Color;
  seed: number;
  born: number;
  /** Presentation time the director dropped it (-1 while listed). */
  leaveAt: number;
  stamp: number;
  /** Resolved this frame, or last known: base position, top height, footprint radius. */
  x: number;
  y: number;
  z: number;
  top: number;
  footprint: number;
  placed: boolean;
}

function newView(): MarkerView {
  return {
    id: '',
    kind: 'point',
    node: -1,
    entity: -1,
    atX: 0,
    atZ: 0,
    hasAt: false,
    radius: DEFAULT_AREA_RADIUS,
    label: '',
    colorHex: -1,
    color: new THREE.Color(),
    seed: 0,
    born: 0,
    leaveAt: -1,
    stamp: 0,
    x: 0,
    y: 0,
    z: 0,
    top: 0,
    footprint: UNIT_RING,
    placed: false,
  };
}

/** Stable 0..1 phase from a marker id, so neighbouring markers do not pulse in unison. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 997) / 997;
}

export class ObjectiveFeature {
  private readonly world: World;
  private readonly session: Session;
  private readonly data: SurveyData;
  private readonly shared: SharedRender;
  private readonly ground: MarkerLayer;
  private readonly columns: MarkerLayer;
  private readonly curtains: MarkerLayer;
  private readonly labels: LabelLayer;
  private readonly byId = new Map<string, MarkerView>();
  private readonly live: MarkerView[] = [];
  private readonly pool: MarkerView[] = [];
  private stamp = 0;
  /**
   * Label candidates of this frame (anchor, slot, colour, alpha), laid out on screen nearest
   * first so farther plaques step up instead of overlapping (device px, y up).
   */
  private labelCount = 0;
  private readonly lx = new Float32Array(MAX_MARKERS);
  private readonly ly = new Float32Array(MAX_MARKERS);
  private readonly lz = new Float32Array(MAX_MARKERS);
  private readonly lSlot = new Int32Array(MAX_MARKERS);
  private readonly lAlpha = new Float32Array(MAX_MARKERS);
  private readonly lColor: THREE.Color[] = [];
  private readonly lDepth = new Float32Array(MAX_MARKERS);
  private readonly lSx = new Float32Array(MAX_MARKERS);
  private readonly lSy = new Float32Array(MAX_MARKERS);
  private readonly lW = new Float32Array(MAX_MARKERS);
  private readonly lH = new Float32Array(MAX_MARKERS);
  private readonly lLift = new Float32Array(MAX_MARKERS);
  private readonly lOrder = new Int32Array(MAX_MARKERS);
  private readonly scratch = new THREE.Vector3();

  constructor(scene: THREE.Scene, world: World, session: Session, data: SurveyData, shared: SurveyUniforms, render: SharedRender) {
    this.world = world;
    this.session = session;
    this.data = data;
    this.shared = render;
    this.ground = new MarkerLayer(
      scene,
      shared,
      cornerGrid(24),
      { vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, hdrCap: 1.4 },
      6,
    );
    this.columns = new MarkerLayer(
      scene,
      shared,
      cornerQuad([-1, 0, 1, 0, 1, 1, -1, 1]),
      { vertexShader: COLUMN_VERT, fragmentShader: COLUMN_FRAG, hdrCap: 1.6 },
      12,
    );
    this.curtains = new MarkerLayer(
      scene,
      shared,
      curtainGeometry(128),
      { vertexShader: CURTAIN_VERT, fragmentShader: CURTAIN_FRAG, hdrCap: 0.8 },
      12,
    );
    this.labels = new LabelLayer(scene, shared, MAX_MARKERS, 20);
    const none = new THREE.Color();
    for (let i = 0; i < MAX_MARKERS; i++) this.lColor.push(none);
  }

  /**
   * Rebuild every marker element. `projScale` = pixels per metre at 1 m of view distance
   * (drawing-buffer pixels); `res` = drawing-buffer size; `pxRatio` = buffer px per css px.
   */
  update(now: number, camera: THREE.Camera, projScale: number, res: THREE.Vector2, pxRatio: number): void {
    this.stamp++;
    const list = this.session.markers;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      let v = this.byId.get(m.id);
      if (!v) {
        if (this.live.length >= MAX_MARKERS) continue;
        v = this.pool.pop() ?? newView();
        v.id = m.id;
        v.seed = seedOf(m.id);
        v.born = now;
        v.leaveAt = -1;
        v.placed = false;
        this.byId.set(m.id, v);
        this.live.push(v);
      } else if (v.leaveAt >= 0) {
        // Listed again while lifting away: settle back in from where the fade had reached.
        const left = Math.min(1, (now - v.leaveAt) / LEAVE);
        v.born = now - APPEAR * (1 - left);
        v.leaveAt = -1;
      }
      v.kind = m.kind;
      v.node = m.node ?? -1;
      v.entity = m.entity ?? -1;
      v.hasAt = m.at !== undefined;
      v.atX = m.at ? m.at.x : 0;
      v.atZ = m.at ? m.at.z : 0;
      v.radius = m.radius !== undefined && m.radius > 0 ? m.radius : DEFAULT_AREA_RADIUS;
      v.label = m.label ?? '';
      const hex = m.color ?? FLAG_YELLOW;
      if (hex !== v.colorHex) {
        v.colorHex = hex;
        v.color.setHex(hex);
      }
      v.stamp = this.stamp;
    }

    this.ground.count = 0;
    this.columns.count = 0;
    this.curtains.count = 0;
    this.labelCount = 0;
    const cam = camera.position;
    const command = this.session.viewBlend;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const v = this.live[i];
      if (v.stamp !== this.stamp && v.leaveAt < 0) v.leaveAt = now;
      const leave = v.leaveAt < 0 ? 0 : Math.min(1, (now - v.leaveAt) / LEAVE);
      if (leave >= 1) {
        this.byId.delete(v.id);
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        this.pool.push(v);
        continue;
      }
      // A marker whose anchor is gone keeps its last known spot while it fades.
      if (this.place(v)) v.placed = true;
      else if (!v.placed) continue;
      else if (v.leaveAt < 0) continue;

      const appear = Math.min(1, (now - v.born) / APPEAR);
      const fade = (1 - (1 - appear) * (1 - appear)) * (1 - leave);
      const kind = v.kind;
      const id = KIND_ID[kind];
      const dx = v.x - cam.x;
      const dy = v.y - cam.y;
      const dz = v.z - cam.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (kind === 'area') {
        this.ground.push(v.x, v.y, v.z, v.radius, id, appear, leave, v.seed, v.color, fade);
        this.curtains.push(v.x, v.y, v.z, v.radius, AREA_CURTAIN_HEIGHT, appear, leave, v.seed, v.color, fade * (1 - 0.7 * command));
      } else {
        const base = kind === 'entity' ? v.footprint : RING_RADIUS[kind];
        const minR = (RING_MIN_PX[kind] * pxRatio * ((camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : dist)) / Math.max(projScale, 1e-3);
        const ring = Math.min(base * MAX_RING_GROWTH, Math.max(base, minR));
        this.ground.push(v.x, v.y, v.z, ring, id, appear, leave, v.seed, v.color, fade);
        const col = COLUMN[kind];
        const y0 = kind === 'entity' ? v.top + 0.5 : v.y;
        this.columns.push(v.x, y0, v.z, col.halfWidth, col.height, appear, leave, v.seed, v.color, col.strength * fade * (1 - 0.4 * command));
      }
      if (v.label !== '' && this.labelCount < MAX_MARKERS) {
        const k = this.labelCount++;
        this.lx[k] = v.x;
        this.ly[k] = (kind === 'entity' ? v.top : v.y) + LABEL_LIFT[kind];
        this.lz[k] = v.z;
        this.lSlot[k] = this.labels.atlas.acquire(v.label, this.stamp);
        this.lColor[k] = v.color;
        this.lAlpha[k] = fade;
      }
    }
    this.ground.commit();
    this.columns.commit();
    this.curtains.commit();
    this.layoutLabels(camera, res, pxRatio);
    this.labels.reset();
    for (let k = 0; k < this.labelCount; k++) {
      this.labels.push(this.lx[k], this.ly[k], this.lz[k], this.lSlot[k], this.lColor[k], this.lAlpha[k], this.lLift[k]);
    }
    this.labels.commit();
  }

  /**
   * Screen layout of this frame's plaques: each is projected with the same size rule as the
   * shader, then, nearest first, any plaque that overlaps one already placed hops above it.
   */
  private layoutLabels(camera: THREE.Camera, res: THREE.Vector2, pxRatio: number): void {
    const n = this.labelCount;
    const view = this.session.viewBlend;
    camera.updateMatrixWorld();
    for (let k = 0; k < n; k++) {
      this.lLift[k] = 0;
      const p = this.scratch.set(this.lx[k], this.ly[k], this.lz[k]).applyMatrix4(camera.matrixWorldInverse);
      const depth = -p.z;
      this.lDepth[k] = depth;
      // Behind the camera or unpainted: drawn (or culled) as is, never pushes others around.
      if (depth <= 0.05 || this.lSlot[k] < 0) {
        this.lW[k] = 0;
      } else {
        p.applyMatrix4(camera.projectionMatrix);
        const h = labelHeightPx(depth, view) * pxRatio;
        this.lSx[k] = (p.x * 0.5 + 0.5) * res.x;
        this.lSy[k] = (p.y * 0.5 + 0.5) * res.y + LABEL_LIFT_PX * pxRatio;
        this.lH[k] = h;
        this.lW[k] = this.labels.atlas.aspect(this.lSlot[k]) * h;
      }
      // Insertion sort by depth, nearest first.
      let a = k;
      while (a > 0 && this.lDepth[this.lOrder[a - 1]] > depth) {
        this.lOrder[a] = this.lOrder[a - 1];
        a--;
      }
      this.lOrder[a] = k;
    }
    for (let a = 1; a < n; a++) {
      const k = this.lOrder[a];
      if (this.lW[k] === 0) continue;
      // Each hop clears one placed plaque; n hops always settle the stack.
      for (let hop = 0; hop < n; hop++) {
        let moved = false;
        for (let b = 0; b < a; b++) {
          const j = this.lOrder[b];
          if (this.lW[j] === 0) continue;
          const yk = this.lSy[k] + this.lLift[k];
          const yj = this.lSy[j] + this.lLift[j];
          const overlapX = Math.abs(this.lSx[k] - this.lSx[j]) * 2 < this.lW[k] + this.lW[j];
          if (overlapX && yk < yj + this.lH[j] && yj < yk + this.lH[k]) {
            this.lLift[k] = yj + this.lH[j] - this.lSy[k];
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
  }

  /** Resolve a marker's anchor to a world spot this frame; false when it cannot be found. */
  private place(v: MarkerView): boolean {
    switch (v.kind) {
      case 'node': {
        if (v.node < 0 || v.node >= this.data.nodeCount) return false;
        // Display positions follow phason flip glides.
        v.x = this.data.dispX[v.node];
        v.z = this.data.dispZ[v.node];
        v.y = groundHeight(v.x, v.z, this.world.map.half);
        v.top = FLAG_TOP;
        return true;
      }
      case 'point':
      case 'area':
        if (!v.hasAt) return false;
        v.x = v.atX;
        v.z = v.atZ;
        v.y = groundHeight(v.x, v.z, this.world.map.half);
        v.top = 0;
        return true;
      case 'entity':
        return v.entity >= 0 && this.placeEntity(v, v.entity, 0);
    }
  }

  /**
   * Resolve an entity through the world maps. Units ride the actors' smoothed head anchors;
   * a carried Flag follows its carrier and a stocked one its Hearth (depth guards that hop).
   */
  private placeEntity(v: MarkerView, id: EntityId, depth: number): boolean {
    const w = this.world;
    const anchor = this.shared.unitAnchors?.get(id);
    const av = w.avatars.get(id);
    if (av) {
      v.x = anchor ? anchor.x : av.pos.x;
      v.z = anchor ? anchor.z : av.pos.z;
      v.y = av.pos.y;
      v.top = anchor ? anchor.y : av.pos.y + AVATAR_TOP;
      v.footprint = UNIT_RING;
      return true;
    }
    const h = w.hippies.get(id);
    if (h) {
      v.x = anchor ? anchor.x : h.pos.x;
      v.z = anchor ? anchor.z : h.pos.z;
      v.y = groundHeight(v.x, v.z, this.world.map.half);
      v.top = anchor ? anchor.y : v.y + HIPPIE_TOP;
      v.footprint = UNIT_RING;
      return true;
    }
    const fl = w.flags.get(id);
    if (fl) {
      if ((fl.state === 'carried' || fl.state === 'stock') && fl.holder >= 0 && depth === 0) {
        if (!this.placeEntity(v, fl.holder, 1)) return false;
        v.top += 0.4;
        v.footprint = Math.min(v.footprint, 1.6);
        return true;
      }
      if (fl.state === 'planted' && fl.node >= 0 && fl.node < this.data.nodeCount) {
        v.x = this.data.dispX[fl.node];
        v.z = this.data.dispZ[fl.node];
      } else {
        v.x = fl.pos.x;
        v.z = fl.pos.z;
      }
      v.y = fl.state === 'flying' ? groundHeight(v.x, v.z, w.map.half) : fl.pos.y;
      v.top = fl.state === 'flying' ? fl.pos.y + 0.6 : v.y + (fl.state === 'planted' ? FLAG_TOP : 0.6);
      v.footprint = 1;
      return true;
    }
    const b = w.buildings.get(id);
    if (b) {
      v.x = b.pos.x;
      v.z = b.pos.z;
      v.y = groundHeight(v.x, v.z, this.world.map.half);
      v.top = v.y + BUILDING_HEIGHT[b.kind];
      v.footprint = BUILDINGS[b.kind].radius + 0.7;
      return true;
    }
    const pile = w.piles.get(id);
    if (pile) {
      v.x = pile.pos.x;
      v.z = pile.pos.z;
      v.y = groundHeight(v.x, v.z, this.world.map.half);
      v.top = v.y + 1.4;
      v.footprint = 2.2;
      return true;
    }
    const piece = w.pieces.get(id);
    if (piece) {
      const lat = this.data.lat;
      if (piece.edge >= 0 && piece.edge < lat.edges.length) {
        const e = lat.edges[piece.edge];
        v.x = (this.data.dispX[e.a] + this.data.dispX[e.b]) * 0.5;
        v.z = (this.data.dispZ[e.a] + this.data.dispZ[e.b]) * 0.5;
      } else if (piece.facet >= 0 && piece.facet < lat.facets.length) {
        v.x = lat.facets[piece.facet].cx;
        v.z = lat.facets[piece.facet].cz;
      } else return false;
      v.y = groundHeight(v.x, v.z, w.map.half) + piece.level * LEVEL_HEIGHT;
      v.top = groundHeight(v.x, v.z, w.map.half) + (piece.level + 1) * LEVEL_HEIGHT;
      v.footprint = 2.6;
      return true;
    }
    const crystal = w.crystals.get(id);
    if (crystal) {
      v.x = crystal.pos.x;
      v.z = crystal.pos.z;
      v.y = groundHeight(v.x, v.z, this.world.map.half);
      v.top = v.y + CRYSTAL_HEIGHT * crystal.scale * (0.12 + 0.88 * (1 - (1 - crystal.growth) ** 3));
      v.footprint = 1.8 * crystal.scale;
      return true;
    }
    const other = w.zones.get(id) ?? w.pings.get(id) ?? w.beacons.get(id);
    if (other) {
      v.x = other.pos.x;
      v.z = other.pos.z;
      v.y = groundHeight(v.x, v.z, this.world.map.half);
      v.top = v.y + 1.2;
      v.footprint = 1.2;
      return true;
    }
    const proj = w.projectiles.get(id);
    if (proj) {
      v.x = proj.pos.x;
      v.z = proj.pos.z;
      v.y = groundHeight(v.x, v.z, this.world.map.half);
      v.top = proj.pos.y + 0.6;
      v.footprint = 1;
      return true;
    }
    return false;
  }

  dispose(): void {
    this.ground.dispose();
    this.columns.dispose();
    this.curtains.dispose();
    this.labels.dispose();
  }
}
