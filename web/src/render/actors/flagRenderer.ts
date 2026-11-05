/**
 * Flags, the hero object. Every visible Flag is one instance of a wooden dowel pole with a
 * brass finial, a waving yellow cloth (vertex-shader wind with analytic finite-difference
 * normals, fabric weave texture, sun translucency and a night emissive lift) and a
 * faction-colour ribbon tied under the finial. Planted Flags pop up out of the ground on
 * flagPlanted, yanked Flags fly out on flagPulled, loose Flags topple and lie tilted, thrown
 * Flags spiral base-first along their velocity, Simulacra render on both nodes with a glitch
 * flicker. Avatars and hippies append their carried Flags (quiver bundles,
 * over-the-shoulder) through pushMatrix().
 *
 * Two levels of detail, each three InstancedMeshes sharing one InstanceSet: the full model in
 * view within FLAG_DETAIL_RANGE, and a coarse one (8×4 cloth, prism pole, short ribbon) for
 * the rest. Only Flags near the eye cast shadows; Flags off screen and far away are skipped.
 * Mobile presentation replaces each emitted Flag with an atlas sprite after culling.
 * MobileSprites supplies a flat placeholder while textures load; desktop keeps the model.
 */
import * as THREE from 'three';
import { FLAG_YELLOW } from '../../sim/constants';
import type { GameEvent } from '../../sim/events';
import { falseFlags } from '../../sim/systems/drugs';
import type { EntityId, FlagState, Owner } from '../../sim/types';
import type { RenderContext } from '../context';
import { InstanceSet, PLACE, castShadowPrefix, showInstances, type ActorView, type Placement } from './lod';
import { MeshBuilder, weld } from './meshBuilder';
import { flagSpriteRotation } from './flagSpriteTransform';
import { LIFT } from '../survey/glsl';
import { GLSL_COMMON, METAL_CAP, clamp01, easeOutBack, easeOutBounce, hash01, hash01b, writeTransform } from './util';

/** Pole length from ground to finial top (m). */
export const FLAG_POLE_HEIGHT = 2.6;
const CLOTH_W = 0.9;
const CLOTH_H = 0.58;
const CLOTH_TOP = 2.47;
const HOIST = 0.026;
const KNOT_Y = 2.545;

/** Full-detail Flags within this distance of the eye (beyond: a dozen pixels of cloth). */
const FLAG_DETAIL_RANGE = 30;
/** Bounding sphere about the pole's midpoint (local y), covering cloth and ribbons. */
const FLAG_MID_Y = 1.3;
const FLAG_RADIUS = 1.6;
const NEAR_CAPACITY = 512;
const FAR_CAPACITY = 2048;
const PART_NAMES = ['pole', 'cloth', 'ribbon'] as const;
const RISE_TIME = 0.7;
const FALL_TIME = 0.65;
const YANK_TIME = 0.42;
const VANISH_TIME = 0.6;
const DECOHERE_GLITCH_TIME = 0.9;
const TRANSIENTS = 48;
type FlagSpriteState = 'planted' | 'ground' | 'thrown' | 'carried';

interface FlagVis {
  state: FlagState;
  /** Presentation time the current state began (drives topple). */
  since: number;
  /** Presentation time of the last flagPlanted (drives the rise). */
  plantAt: number;
  decohereAt: number;
  phase: number;
  gust: number;
  fallYaw: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Frame stamp, for pruning entries of Flags that left the world. */
  seen: number;
  /** Drawn at full detail last frame (level-of-detail hysteresis). */
  detailed: boolean;
}

/** Short-lived Flag ghosts: yanked out of the ground (0) or a collapsed Simulacrum twin (1). */
interface Transient {
  active: boolean;
  kind: 0 | 1;
  start: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
  color: THREE.Color;
}

const FLAG_VERTEX_PARS = /* glsl */ `
uniform float uTime;
attribute vec4 aFlagA; // phase, wave, trail, droop
attribute vec4 aFlagB; // glitch, highlight, -, -
varying float vGlitch;
varying float vHighlight;
varying float vBurst;
${GLSL_COMMON}
float flagBurst(float phase) {
  float tt = floor(uTime * 14.0 + phase * 31.0);
  return step(0.8, fhHash12(vec2(tt, phase * 97.0)));
}
vec3 flagGlitch(vec3 p) {
  if (aFlagB.x <= 0.0) return p;
  float burst = flagBurst(aFlagA.x);
  float slice = floor(p.y * 7.0);
  float r = fhHash12(vec2(slice, floor(uTime * 14.0)));
  p.x += aFlagB.x * burst * (r - 0.5) * 0.32;
  p.z += aFlagB.x * burst * (fhHash12(vec2(r, slice)) - 0.5) * 0.1;
  return p;
}
`;

const CLOTH_FUNCS = /* glsl */ `
vec3 flagClothPos(vec2 c) {
  float k = c.x;
  float h = c.y;
  float ph = aFlagA.x * 6.2832;
  float wave = aFlagA.y;
  float trail = aFlagA.z;
  float droop = aFlagA.w;
  float t = uTime;
  float x = k * ${CLOTH_W.toFixed(3)};
  float y = (h - 1.0) * ${CLOTH_H.toFixed(3)};
  float speed = 3.2 + 4.5 * wave;
  // Main travelling wave with diagonal folds, a faster flutter, and a corner flick.
  float th = 4.8 * k - t * speed + ph + 1.6 * h;
  float amp = (0.035 + 0.22 * k * k) * wave;
  float z = amp * sin(th);
  z += 0.04 * wave * k * sin(11.0 * k - 2.4 * h - t * speed * 2.3 + ph * 1.3);
  z += 0.03 * wave * k * k * sin(6.0 * h + 2.0 * k - t * 2.7 + ph);
  // Billowing shortens the projected length; keep the cloth from stretching.
  x -= (0.05 * wave * wave + 0.03 * wave) * k * k * ${CLOTH_W.toFixed(3)};
  y += 0.025 * wave * k * sin(th * 0.5 + 1.0);
  // Weak wind lets the fly end hang toward the pole.
  float dk = droop * k * k;
  y -= dk * 0.5;
  x -= dk * 0.22;
  // Thrown Flags: the slipstream sweeps the cloth back along the pole like a pennant.
  y += trail * x * 0.95;
  x *= 1.0 - 0.55 * trail;
  return vec3(${HOIST.toFixed(3)} + x, ${CLOTH_TOP.toFixed(3)} + y, z);
}
`;

const RIBBON_FUNCS = /* glsl */ `
attribute vec2 aRibbonTail; // tail index, rigid knot
vec3 flagRibbonPos(vec2 c) {
  if (aRibbonTail.y > 0.5) return position;
  float tail = aRibbonTail.x;
  float len = mix(0.58, 0.45, tail);
  float u = c.x;
  float ph = aFlagA.x * 6.2832 + tail * 2.1;
  float wave = aFlagA.y;
  float t = uTime;
  float lift = clamp(wave * 0.8, 0.0, 1.0);
  float ang = mix(-1.35, -0.3, lift) - tail * 0.25
    + 0.2 * wave * u * sin(t * (5.0 + 6.0 * wave) + ph + u * 3.0)
    + 0.3 * u * sin(t * 7.0 + ph);
  vec2 d = vec2(cos(ang), sin(ang));
  float s = u * len;
  vec2 xy = vec2(0.0, ${KNOT_Y.toFixed(3)}) + d * s + vec2(-d.y, d.x) * c.y * 0.028;
  xy.y += aFlagA.z * s * 0.9;
  float z = (0.05 * wave + 0.01) * u * sin(u * 9.0 - t * (8.0 + 6.0 * wave) + ph);
  return vec3(${HOIST.toFixed(3)} + xy.x, xy.y, z);
}
`;

const FLAG_FRAGMENT_PARS = /* glsl */ `
uniform float uTime;
varying float vGlitch;
varying float vHighlight;
varying float vBurst;
${GLSL_COMMON}
`;

const FLAG_GLITCH_FRAGMENT = /* glsl */ `
if (vGlitch > 0.0) {
  float gn = fhHash12(floor(gl_FragCoord.xy * 0.5) + floor(uTime * 24.0));
  if (gn < vGlitch * (0.1 + 0.5 * vBurst)) discard;
  float gk = vGlitch * (0.25 + 0.6 * vBurst);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.35, 0.9, 1.0) * (0.4 + dot(diffuseColor.rgb, vec3(0.4))), gk * 0.5);
}
`;

const FLAG_EMISSIVE_FRAGMENT = /* glsl */ `
totalEmissiveRadiance += diffuseColor.rgb * vHighlight * (0.55 + 0.35 * sin(uTime * 7.0));
totalEmissiveRadiance += vec3(0.3, 0.8, 1.0) * vGlitch * vBurst * 0.6;
`;

interface FlagUniforms {
  uTime: THREE.IUniform<number>;
  uSunView: THREE.IUniform<THREE.Vector3>;
  uDaylight: THREE.IUniform<number>;
  uRibbonGlow: THREE.IUniform<number>;
}

type FlagPart = 'pole' | 'cloth' | 'ribbon';

/** Inject the shared Flag instancing/glitch code plus the part-specific deformation. */
function patchFlagMaterial(mat: THREE.Material, part: FlagPart, u: FlagUniforms, depth: boolean): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uSunView = u.uSunView;
    shader.uniforms.uDaylight = u.uDaylight;
    shader.uniforms.uRibbonGlow = u.uRibbonGlow;
    const deform = part === 'cloth' ? CLOTH_FUNCS : part === 'ribbon' ? RIBBON_FUNCS : '';
    const surfPars = part === 'pole' ? 'attribute vec2 aSurf;\nvarying vec2 vSurf;\n' : '';
    const ribbonPars = part === 'ribbon' ? 'attribute vec3 aRibbon;\nvarying vec3 vRibbon;\n' : '';
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${FLAG_VERTEX_PARS}${deform}${surfPars}${ribbonPars}`);
    const posFn = part === 'cloth' ? 'flagClothPos(uv)' : part === 'ribbon' ? 'flagRibbonPos(uv)' : 'position';
    if (!depth && part !== 'pole') {
      vs = vs.replace(
        '#include <beginnormal_vertex>',
        `vec3 flagP = ${posFn};
        vec3 flagPu = ${part === 'cloth' ? 'flagClothPos(uv + vec2(0.02, 0.0))' : 'flagRibbonPos(uv + vec2(0.02, 0.0))'};
        vec3 flagPv = ${part === 'cloth' ? 'flagClothPos(uv + vec2(0.0, 0.02))' : 'flagRibbonPos(uv + vec2(0.0, 0.2))'};
        // Rigid parts (the ribbon knot) have zero finite-difference tangents: normalize(0) is
        // NaN, so test the length first and fall back to the authored normal.
        vec3 flagN = cross(flagPu - flagP, flagPv - flagP);
        float flagL2 = dot(flagN, flagN);
        vec3 objectNormal = flagL2 > 1e-14 ? flagN * inversesqrt(flagL2) : (dot(normal, normal) > 0.5 ? normal : vec3(0.0, 0.0, 1.0));`,
      );
      vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = flagGlitch(flagP);');
    } else {
      vs = vs.replace('#include <begin_vertex>', `vec3 transformed = flagGlitch(${posFn});`);
    }
    vs = vs.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vGlitch = aFlagB.x;
      vHighlight = aFlagB.y;
      vBurst = flagBurst(aFlagA.x);
      ${part === 'pole' ? 'vSurf = aSurf;' : ''}
      ${part === 'ribbon' ? 'vRibbon = aRibbon;' : ''}`,
    );
    shader.vertexShader = vs;
    if (depth) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FLAG_FRAGMENT_PARS}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FLAG_GLITCH_FRAGMENT}`);
      return;
    }
    let fs = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      ${FLAG_FRAGMENT_PARS}
      uniform vec3 uSunView;
      uniform float uDaylight;
      uniform float uRibbonGlow;
      ${part === 'pole' ? 'varying vec2 vSurf;' : ''}
      ${part === 'ribbon' ? 'varying vec3 vRibbon;' : ''}`,
    );
    const colorExtra = part === 'ribbon' ? 'diffuseColor.rgb *= vRibbon;' : '';
    fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n${colorExtra}\n${FLAG_GLITCH_FRAGMENT}`);
    if (part === 'pole') {
      fs = fs
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurf.x;')
        .replace('#include <metalnessmap_fragment>', `float metalnessFactor = min(vSurf.y, ${METAL_CAP.toFixed(2)});`);
    }
    let emissive = FLAG_EMISSIVE_FRAGMENT;
    if (part === 'cloth') {
      // Thin fabric glows when the sun is behind it (golden-hour backlight).
      emissive += `
      vec3 flagView = normalize(vViewPosition);
      float flagBack = max(0.0, dot(-flagView, uSunView));
      totalEmissiveRadiance += diffuseColor.rgb * pow(flagBack, 3.0) * 0.7 * uDaylight;`;
    }
    if (part === 'ribbon') emissive += 'totalEmissiveRadiance += vRibbon * uRibbonGlow;';
    fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${emissive}`);
    if (part === 'cloth') {
      // ACES lifts blue out of bright yellows (pale lemon). Pre-cancel the input matrix's
      // blue cross-talk so the Flag keeps its saturated #ffd400 after tone mapping.
      fs = fs.replace(
        '#include <opaque_fragment>',
        'outgoingLight.b -= 0.034 * outgoingLight.r + 0.16 * outgoingLight.g;\n#include <opaque_fragment>',
      );
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `fh-flag-${part}-${depth ? 'depth' : 'color'}`;
}

/** Subtle woven-fabric map with hems, stitching and the hoist sleeve (multiplied by yellow). */
function makeFabricTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Flag fabric: 2D canvas unavailable');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = 'rgba(90,60,0,0.05)';
  for (let y = 0; y < size; y += 2) g.fillRect(0, y, size, 1);
  g.fillStyle = 'rgba(90,60,0,0.04)';
  for (let x = 0; x < size; x += 2) g.fillRect(x, 0, 1, size);
  let s = 1234567;
  for (let i = 0; i < 900; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const x = s % size;
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const y = s % size;
    g.fillStyle = `rgba(80,50,0,${(0.03 + (s % 7) * 0.006).toFixed(3)})`;
    g.fillRect(x, y, 3 + (s % 5), 1);
  }
  const sleeve = Math.round(size * 0.07);
  g.fillStyle = 'rgba(110,70,0,0.13)';
  g.fillRect(0, 0, sleeve, size);
  g.fillStyle = 'rgba(110,70,0,0.1)';
  g.fillRect(0, 0, size, 5);
  g.fillRect(0, size - 5, size, 5);
  g.fillRect(size - 5, 0, 5, size);
  g.fillStyle = 'rgba(90,55,0,0.22)';
  for (let x = 0; x < size; x += 6) {
    g.fillRect(x, 7, 3, 1);
    g.fillRect(x, size - 8, 3, 1);
  }
  for (let y = 0; y < size; y += 6) {
    g.fillRect(sleeve + 2, y, 1, 3);
    g.fillRect(size - 8, y, 1, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function buildPoleGeometry(): THREE.BufferGeometry {
  const wood = new THREE.Color(0xb98a52);
  const tip = new THREE.Color(0x6d5236);
  const brass = new THREE.Color(0xe8c050);
  const b = new MeshBuilder([
    { name: 'color', size: 3 },
    { name: 'aSurf', size: 2 },
  ]);
  b.with({ color: [wood.r, wood.g, wood.b], aSurf: [0.72, 0] }).seg([0, 0, 0], [0, KNOT_Y + 0.01, 0], 0.024, 0.021, 6);
  b.with({ color: [tip.r, tip.g, tip.b], aSurf: [0.6, 0.1] }).cone([0, 0, 0], [0, -0.14, 0], 0.024, 6);
  b.with({ color: [brass.r, brass.g, brass.b], aSurf: [0.3, 0.85] })
    .seg([0, KNOT_Y + 0.005, 0], [0, KNOT_Y + 0.045, 0], 0.03, 0.03, 8)
    .ball([0, FLAG_POLE_HEIGHT + 0.03, 0], 0.05, 1);
  return weld(b.build(), ['uv']);
}

/** Distant pole: an open three-sided dowel and an octahedral finial (both about a pixel wide). */
function buildFarPoleGeometry(): THREE.BufferGeometry {
  const wood = new THREE.Color(0xb98a52);
  const brass = new THREE.Color(0xe8c050);
  const b = new MeshBuilder([
    { name: 'color', size: 3 },
    { name: 'aSurf', size: 2 },
  ]);
  b.with({ color: [wood.r, wood.g, wood.b], aSurf: [0.72, 0] }).seg([0, -0.12, 0], [0, KNOT_Y + 0.01, 0], 0.026, 0.022, 3, 1, true);
  b.with({ color: [brass.r, brass.g, brass.b], aSurf: [0.3, 0.85] }).add(
    new THREE.OctahedronGeometry(0.055),
    new THREE.Matrix4().makeTranslation(0, FLAG_POLE_HEIGHT + 0.03, 0),
  );
  return weld(b.build(), ['uv']);
}

function buildClothGeometry(widthSegments: number, heightSegments: number): THREE.BufferGeometry {
  // Positions are recomputed in the shader from uv; the rest shape keeps bounds sensible.
  const g = new THREE.PlaneGeometry(CLOTH_W, CLOTH_H, widthSegments, heightSegments);
  g.translate(HOIST + CLOTH_W / 2, CLOTH_TOP - CLOTH_H / 2, 0);
  return g;
}

/** Two ribbon tails of `segs` segments each, plus (detailed level) the knot round the pole. */
function buildRibbonGeometry(segs: number, knot: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const tail: number[] = [];
  const idx: number[] = [];
  for (let t = 0; t < 2; t++) {
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      for (let j = 0; j < 2; j++) {
        pos.push(HOIST + (i / segs) * 0.4, KNOT_Y - (i / segs) * 0.2, 0);
        nrm.push(0, 0, 1);
        uv.push(i / segs, j * 2 - 1);
        tail.push(t, 0);
      }
      if (i < segs) {
        const a = base + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  if (knot) {
    // A small rigid wrap around the pole in ribbon colour.
    const box = new THREE.BoxGeometry(0.06, 0.035, 0.06).translate(0, KNOT_Y, 0);
    const kp = box.getAttribute('position');
    const kn = box.getAttribute('normal');
    const kIndex = box.index;
    const base = pos.length / 3;
    for (let i = 0; i < kp.count; i++) {
      pos.push(kp.getX(i), kp.getY(i), kp.getZ(i));
      nrm.push(kn.getX(i), kn.getY(i), kn.getZ(i));
      uv.push(0, 0);
      tail.push(0, 1);
    }
    if (kIndex) for (let i = 0; i < kIndex.count; i++) idx.push(base + kIndex.getX(i));
    box.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aRibbonTail', new THREE.Float32BufferAttribute(tail, 2));
  g.setIndex(idx);
  return g;
}

/** One level of detail: pole, cloth and ribbon models sharing one set of instances. */
interface FlagLevel {
  /** Instance attributes: matrix (16), aFlagA (4), aFlagB (4), aRibbon (3). */
  set: InstanceSet;
  geometries: THREE.BufferGeometry[];
  meshes: THREE.InstancedMesh[];
  /** InstanceSet generation currently bound to the meshes. */
  bound: number;
}

export class FlagRenderer {
  private readonly ctx: RenderContext;
  private readonly view: ActorView;
  private frame = 0;
  private readonly levels: FlagLevel[];
  private readonly partMaterials: THREE.MeshStandardMaterial[];
  private readonly depthMaterials: THREE.MeshDepthMaterial[];
  private readonly fabric: THREE.CanvasTexture;
  private readonly clothMat: THREE.MeshStandardMaterial;
  private readonly uniforms: FlagUniforms;
  private readonly vis = new Map<EntityId, FlagVis>();
  /** Flags currently being pulled → channel progress 0..1 (set each frame by unit renderers). */
  private readonly pulling = new Map<EntityId, number>();
  private readonly transients: Transient[] = [];
  private nextTransient = 0;
  private readonly factionColors: THREE.Color[];
  private readonly neutralColor = new THREE.Color(0xffffff);
  private readonly fallbackWind = { x: 1, z: 0, strength: 0.7 };
  /** Downwind yaw (sim yaw convention) and gust strength for this frame; set by begin(). */
  windYaw = 0;
  windStrength = 0.7;
  /** The instance transform being placed (column-major), before it is copied to its level. */
  private readonly m16 = new Float32Array(16);
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpX = new THREE.Vector3();
  private readonly tmpY = new THREE.Vector3();
  private readonly tmpZ = new THREE.Vector3();
  private readonly tmpNode = new THREE.Vector3();

  constructor(ctx: RenderContext, view: ActorView) {
    this.ctx = ctx;
    this.view = view;
    this.factionColors = ctx.world.factions.map((f) => new THREE.Color(f.color));
    this.uniforms = {
      uTime: { value: 0 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uDaylight: { value: 1 },
      uRibbonGlow: { value: 0.2 },
    };
    this.fabric = makeFabricTexture(ctx.renderer);

    const poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 });
    // Part albedo, part self-light: the yellow stays rich in full sun (no ACES wash-out) and
    // still reads in shade; the emissive share rises at night for bloom.
    this.clothMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(FLAG_YELLOW).multiplyScalar(0.62),
      map: this.fabric,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
      emissive: FLAG_YELLOW,
      emissiveIntensity: 0.24,
    });
    const ribbonMat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.55 });
    patchFlagMaterial(poleMat, 'pole', this.uniforms, false);
    patchFlagMaterial(this.clothMat, 'cloth', this.uniforms, false);
    patchFlagMaterial(ribbonMat, 'ribbon', this.uniforms, false);
    const clothDepth = new THREE.MeshDepthMaterial();
    patchFlagMaterial(clothDepth, 'cloth', this.uniforms, true);
    this.partMaterials = [poleMat, this.clothMat, ribbonMat];
    // Every caster gets its own depth material: three's shared default would switch program
    // variants each time instanced and plain casters alternate in the shadow pass.
    this.depthMaterials = [new THREE.MeshDepthMaterial(), clothDepth];

    this.levels = [
      this.makeLevel([buildPoleGeometry(), buildClothGeometry(16, 8), buildRibbonGeometry(8, true)], NEAR_CAPACITY, 'actors-flags'),
      this.makeLevel([buildFarPoleGeometry(), buildClothGeometry(8, 4), buildRibbonGeometry(4, false)], FAR_CAPACITY, 'actors-flags-far'),
    ];

    for (let i = 0; i < TRANSIENTS; i++) {
      this.transients.push({ active: false, kind: 0, start: 0, x: 0, y: 0, z: 0, yaw: 0, phase: 0, color: new THREE.Color() });
    }
  }

  /** Ribbon colour for an owner (faction colour; NEUTRAL white). */
  ribbonColor(owner: Owner): THREE.Color {
    return owner >= 0 ? this.factionColors[owner] : this.neutralColor;
  }

  /** Report that a planted Flag is being pulled (progress 0..1) so it shakes this frame. */
  markPulling(flagId: EntityId, progress: number): void {
    this.pulling.set(flagId, Math.max(this.pulling.get(flagId) ?? 0, clamp01(progress) + 0.05));
  }

  /** Start a frame: reads wind and resets the instance batches. Call before units push Flags. */
  begin(): void {
    const ctx = this.ctx;
    const t = ctx.time;
    let wind = ctx.shared.wind;
    if (!wind) {
      const fw = this.fallbackWind;
      const a = 0.6 + 0.35 * Math.sin(t * 0.021) + 0.15 * Math.sin(t * 0.057);
      fw.x = Math.sin(a);
      fw.z = Math.cos(a);
      fw.strength = 0.68 + 0.18 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1) + 0.14 * Math.max(0, Math.sin(t * 0.9));
      wind = fw;
    }
    this.windYaw = Math.atan2(wind.x, wind.z);
    this.windStrength = wind.strength;
    for (const level of this.levels) level.set.begin();
    this.pulling.clear();
  }

  /** Append a Flag instance with an arbitrary transform (carried Flags). */
  pushMatrix(m: THREE.Matrix4, phase: number, wave: number, trail: number, droop: number, highlight: number, ribbon: THREE.Color): void {
    m.toArray(this.m16);
    this.commit(phase, wave, trail, droop, 0, highlight, ribbon, false, 'carried');
  }

  onEvent(e: GameEvent): void {
    const t = this.ctx.time;
    switch (e.t) {
      case 'flagPlanted': {
        const v = this.visFor(e.flagId);
        v.plantAt = t;
        v.state = 'planted';
        v.since = t;
        break;
      }
      case 'flagPulled': {
        const tr = this.takeTransient();
        tr.kind = 0;
        tr.start = t;
        tr.x = e.pos.x;
        tr.y = e.pos.y;
        tr.z = e.pos.z;
        tr.yaw = this.windYaw - Math.PI / 2;
        tr.phase = hash01(e.flagId);
        tr.color.copy(this.ribbonColor(e.prevOwner));
        break;
      }
      case 'flagDecohered':
        this.visFor(e.flagId).decohereAt = t;
        break;
      case 'simulacrumCollapsed': {
        const node = this.ctx.world.lattice.nodes[e.vanished];
        if (!node) break;
        const tr = this.takeTransient();
        tr.kind = 1;
        tr.start = t;
        tr.x = node.x;
        tr.y = this.ctx.world.collision.groundHeight(node.x, node.z);
        tr.z = node.z;
        tr.yaw = this.windYaw - Math.PI / 2;
        tr.phase = hash01(e.flagId);
        tr.color.copy(this.ribbonColor(e.faction));
        break;
      }
      default:
        break;
    }
  }

  /** Emit every world Flag that is not carried, plus transients, then upload. */
  end(): void {
    const ctx = this.ctx;
    const w = ctx.world;
    const t = ctx.time;
    const dt = Math.max(1e-3, Math.min(0.1, t - this.uniforms.uTime.value));
    this.frame++;
    const hover = ctx.session.hover.entity;
    const sel = ctx.session.selection;
    const windYaw = this.windYaw;
    const ws = this.windStrength;
    const plantedDroop = clamp01(0.85 - ws) * 0.7;
    const m16 = this.m16;

    for (const f of w.flags.values()) {
      if (w.boss?.held?.kind === 'flag' && w.boss.held.id === f.id) continue;
      if (f.state === 'stock' || f.state === 'carried') {
        const v = this.vis.get(f.id);
        if (v) {
          v.state = f.state;
          v.seen = this.frame;
        }
        continue;
      }
      const v = this.visFor(f.id);
      v.seen = this.frame;
      if (v.state !== f.state) {
        v.state = f.state;
        v.since = t;
      }
      const highlight = f.id === hover || sel.has(f.id) ? 1 : 0;
      const ribbon = this.ribbonColor(f.owner);
      const decohere = clamp01(1 - (t - v.decohereAt) / DECOHERE_GLITCH_TIME);
      // Superposed Flags shimmer subtly between bursts; decohering Flags glitch hard briefly.
      const glitch = f.altNode >= 0 ? Math.max(0.45, decohere) : decohere;
      const gy = 0; // Flag positions are absolute simulation coordinates.

      if (f.state === 'planted') {
        const node = w.lattice.nodes[f.node];
        // Mobile artwork is anchored by the pole's bottom tip. Keep that tip at the
        // displayed node even during rise/pull or a phason position tween; waving and
        // screen-plane rotation happen about this exact point.
        const spriteAnchor = node
          ? this.nodeSpriteAnchor(f.node, node.x, w.collision.groundHeight(node.x, node.z), node.z)
          : f.pos;
        const age = t - v.plantAt;
        let rise = 0;
        let wob = 0;
        if (age < RISE_TIME) {
          const k = age / RISE_TIME;
          rise = (easeOutBack(Math.min(1, k * 1.6)) - 1) * 1.3;
          wob = 0.32 * Math.exp(-5 * k) * Math.sin(k * 24);
        }
        const pull = this.pulling.get(f.id) ?? 0;
        if (pull > 0) {
          wob += Math.sin(t * 38 + v.phase * 10) * (0.04 + 0.1 * pull);
          rise += pull * 0.16 * (0.5 + 0.5 * Math.sin(t * 19));
        }
        const yaw = windYaw - Math.PI / 2 + (v.phase - 0.5) * 0.4 + 0.1 * Math.sin(t * 0.6 + v.phase * 9);
        const wave = ws * (0.8 + 0.4 * v.gust);
        writeTransform(m16, 0, f.pos.x, f.pos.y + gy + rise, f.pos.z, yaw, wob, wob * 0.6, 1);
        v.detailed = this.commit(v.phase, wave, 0, plantedDroop, glitch, highlight, ribbon, v.detailed, 'planted', spriteAnchor) === PLACE.detailed;
        if (f.altNode >= 0) {
          const twin = w.lattice.nodes[f.altNode];
          if (twin) {
            const ty = w.collision.groundHeight(twin.x, twin.z);
            writeTransform(m16, 0, twin.x, ty + rise, twin.z, yaw + 0.3, wob, -wob * 0.6, 1);
            this.commit((v.phase + 0.37) % 1, wave, 0, plantedDroop, glitch, highlight, ribbon, false, 'planted', this.nodeSpriteAnchor(f.altNode, twin.x, ty, twin.z));
          }
        }
      } else if (f.state === 'loose') {
        const k = (t - v.since) / FALL_TIME;
        const target = clamp01(f.tilt) * 1.5;
        const fall = k < 1 ? target * easeOutBounce(k) : target;
        writeTransform(m16, 0, f.pos.x, f.pos.y + gy + 0.045, f.pos.z, v.fallYaw, fall, 0, 1);
        v.detailed = this.commit(v.phase, 0.1 + 0.08 * ws, 0, 0, glitch, highlight, ribbon, v.detailed, 'ground') === PLACE.detailed;
      } else {
        this.writeFlying(f.holder, f.pos.x, f.pos.y, f.pos.z, v, dt);
        v.detailed = this.commit(v.phase, 1.6, 0.75, 0, 0, highlight, ribbon, v.detailed, 'thrown') === PLACE.detailed;
      }
    }

    // Luminous Dust hallucinations: planted-looking Flags with rival ribbons that only the
    // player sees; a faint shimmer gives them away on a close look.
    const pf = ctx.session.playerFaction;
    for (const node of falseFlags(w, pf)) {
      const n = w.lattice.nodes[node];
      if (!n) continue;
      const ph = hash01(node * 7919);
      writeTransform(m16, 0, n.x, w.collision.groundHeight(n.x, n.z), n.z, windYaw - Math.PI / 2 + (ph - 0.5) * 0.4, 0, 0, 1);
      this.commit(ph, ws * (0.8 + 0.4 * ph), 0, plantedDroop, 0.18, 0, this.factionColors[(pf + 1 + (node % 3)) % 4], false);
    }

    for (let j = 0; j < this.transients.length; j++) {
      const tr = this.transients[j];
      if (!tr.active) continue;
      const dur = tr.kind === 0 ? YANK_TIME : VANISH_TIME;
      const k = (t - tr.start) / dur;
      if (k >= 1) {
        tr.active = false;
        continue;
      }
      if (tr.kind === 0) {
        const up = 1 - (1 - k) * (1 - k) * (1 - k);
        writeTransform(m16, 0, tr.x, tr.y + up * 1.7, tr.z, tr.yaw + k * 5, 0.4 * k, 0, 1 - k * k * k);
        this.commit(tr.phase, 1.4, 0.5 * k, 0, 0, 0, tr.color, false, 'thrown');
      } else {
        const jx = (hash01(Math.floor(t * 30) + j) - 0.5) * 0.4 * k;
        writeTransform(m16, 0, tr.x + jx, tr.y, tr.z, tr.yaw, 0, 0, Math.max(0.01, 1 - k * k));
        this.commit(tr.phase, ws, 0, 0, 1.5, 0, tr.color, false);
      }
    }

    if (this.frame % 120 === 0) {
      for (const [id, v] of this.vis) if (v.seen < this.frame - 1 && !w.flags.has(id)) this.vis.delete(id);
    }
    for (const level of this.levels) {
      level.set.finish();
      if (level.bound !== level.set.generation) this.bind(level);
      // Ribbons are a few centimetres wide: their shadow is below a shadow-map texel.
      for (let i = 0; i < level.meshes.length; i++) showInstances(level.meshes[i], level.set, this.view.shadows && i !== 2);
    }
    this.updateUniforms(t);
  }

  dispose(): void {
    for (const level of this.levels) {
      for (const m of level.meshes) {
        this.ctx.scene.remove(m);
        m.dispose();
      }
      for (const g of level.geometries) g.dispose();
    }
    for (const m of this.partMaterials) m.dispose();
    for (const m of this.depthMaterials) m.dispose();
    this.fabric.dispose();
    this.vis.clear();
  }

  private makeLevel(geometries: THREE.BufferGeometry[], capacity: number, name: string): FlagLevel {
    const set = new InstanceSet([16, 4, 4, 3], capacity);
    const meshes = this.partMaterials.map((mat, i) => {
      const mesh = new THREE.InstancedMesh(geometries[i], mat, 1);
      mesh.name = `${name}-${PART_NAMES[i]}`;
      mesh.frustumCulled = false;
      mesh.receiveShadow = i !== 2;
      mesh.count = 0;
      castShadowPrefix(mesh, set);
      this.ctx.scene.add(mesh);
      return mesh;
    });
    meshes[0].customDepthMaterial = this.depthMaterials[0];
    meshes[1].customDepthMaterial = this.depthMaterials[1];
    const level: FlagLevel = { set, geometries, meshes, bound: -1 };
    this.bind(level);
    return level;
  }

  /** Point a level's meshes at its current instance attributes (after creation or growth). */
  private bind(level: FlagLevel): void {
    const attrs = level.set.attrs;
    for (const m of level.meshes) {
      m.dispose();
      m.instanceMatrix = attrs[0];
    }
    for (const g of level.geometries) {
      g.dispose();
      g.setAttribute('aFlagA', attrs[1]);
      g.setAttribute('aFlagB', attrs[2]);
    }
    level.geometries[2].setAttribute('aRibbon', attrs[3]);
    level.bound = level.set.generation;
  }

  /**
   * Place the Flag whose transform is in m16 (full or coarse model, shadow caster, or culled)
   * and copy it with its shader parameters into that level's instances.
   */
  private commit(
    phase: number,
    wave: number,
    trail: number,
    droop: number,
    glitch: number,
    highlight: number,
    ribbon: THREE.Color,
    wasDetailed: boolean,
    spriteState: FlagSpriteState = 'planted',
    spriteAnchor?: Readonly<{x: number; y: number; z: number}>,
  ): Placement {
    const m = this.m16;
    const scale = Math.hypot(m[4], m[5], m[6]);
    const mobile = !!this.ctx.shared.mobileSprites;
    const anchor = mobile ? spriteAnchor : undefined;
    const x = anchor?.x ?? m[12], y = anchor?.y ?? m[13], z = anchor?.z ?? m[14];
    const place = this.view.place(
      mobile ? x : m[4] * FLAG_MID_Y + x,
      mobile ? y : m[5] * FLAG_MID_Y + y,
      mobile ? z : m[6] * FLAG_MID_Y + z,
      // A screen-parallel Flag keeps full apparent height at steep camera pitch.
      // The old world-pole sphere could cull its visible upper half at the screen edge.
      (mobile ? FLAG_POLE_HEIGHT * 1.5 : FLAG_RADIUS) * scale,
      FLAG_DETAIL_RANGE,
      wasDetailed,
    );
    if (place === PLACE.skip) return place;
    // One replacement per visible Flag, including carried quiver entries and transient
    // copies. Use a negative deterministic key so direction history cannot collide with
    // actors. A loose Flag uses its own ground art at full pole scale, not a tiny upright
    // Flag; all modes keep the same simulation-grounded presentation anchor.
    if (this.ctx.shared.mobileSprites?.flag({
      id: -1 - Math.floor(phase * 0x7fffffff),
      x, y, z,
      yaw: Math.atan2(m[8], m[10]), height: FLAG_POLE_HEIGHT * scale, moving: true,
    }, spriteState, {ribbon, highlight, glitch,
      rotation: spriteState === 'ground' ? 0 : flagSpriteRotation(m, this.ctx.camera),
    })) return place;
    const set = this.levels[place === PLACE.detailed ? 0 : 1].set;
    const i = place === PLACE.coarse ? set.plain() : set.caster();
    const attrs = set.attrs;
    attrs[0].array.set(m, i * 16);
    const a = attrs[1].array;
    a[i * 4] = phase;
    a[i * 4 + 1] = wave;
    a[i * 4 + 2] = trail;
    a[i * 4 + 3] = droop;
    const b = attrs[2].array;
    b[i * 4] = glitch;
    b[i * 4 + 1] = highlight;
    const r = attrs[3].array;
    r[i * 3] = ribbon.r;
    r[i * 3 + 1] = ribbon.g;
    r[i * 3 + 2] = ribbon.b;
    return place;
  }

  private nodeSpriteAnchor(node: number, x: number, y: number, z: number): THREE.Vector3 {
    if (!this.ctx.shared.nodeMarkerPosition?.(node, this.tmpNode)) this.tmpNode.set(x, y + LIFT.marker, z);
    return this.tmpNode;
  }

  /** A thrown Flag's transform into m16: spike first along its velocity, spinning. */
  private writeFlying(holder: EntityId | -1, fx: number, fy: number, fz: number, v: FlagVis, dt: number): void {
    const w = this.ctx.world;
    const proj = holder >= 0 ? w.projectiles.get(holder) : undefined;
    const x = proj ? proj.pos.x : fx;
    const y = proj ? proj.pos.y : fy;
    const z = proj ? proj.pos.z : fz;
    let vx: number;
    let vy: number;
    let vz: number;
    if (proj) {
      vx = proj.vel.x;
      vy = proj.vel.y;
      vz = proj.vel.z;
    } else {
      // No projectile entity (staged / mid-handoff): estimate from motion, keep last heading.
      const ex = (x - v.px) / dt;
      const ey = (y - v.py) / dt;
      const ez = (z - v.pz) / dt;
      if (ex * ex + ey * ey + ez * ez > 0.25) {
        v.vx += (ex - v.vx) * 0.5;
        v.vy += (ey - v.vy) * 0.5;
        v.vz += (ez - v.vz) * 0.5;
      }
      vx = v.vx;
      vy = v.vy;
      vz = v.vz;
    }
    v.px = x;
    v.py = y;
    v.pz = z;
    const dir = this.tmpY.set(vx, vy, vz);
    if (dir.lengthSq() < 1e-6) dir.set(Math.sin(this.windYaw), -0.3, Math.cos(this.windYaw));
    dir.normalize().negate(); // pole axis points back: the spike leads
    const ref = Math.abs(dir.y) > 0.95 ? this.tmpV.set(1, 0, 0) : this.tmpV.set(0, 1, 0);
    const ax = this.tmpX.crossVectors(ref, dir).normalize();
    const az = this.tmpZ.crossVectors(ax, dir);
    const spin = this.ctx.time * 15 + v.phase * 6.28;
    const c = Math.cos(spin);
    const s = Math.sin(spin);
    const m = this.m16;
    const xx = ax.x * c + az.x * s;
    const xy = ax.y * c + az.y * s;
    const xz = ax.z * c + az.z * s;
    m[0] = xx;
    m[1] = xy;
    m[2] = xz;
    m[3] = 0;
    m[4] = dir.x;
    m[5] = dir.y;
    m[6] = dir.z;
    m[7] = 0;
    m[8] = dir.y * xz - dir.z * xy;
    m[9] = dir.z * xx - dir.x * xz;
    m[10] = dir.x * xy - dir.y * xx;
    m[11] = 0;
    // The pole's midpoint rides the projectile position.
    m[12] = x - dir.x * FLAG_POLE_HEIGHT * 0.5;
    m[13] = y - dir.y * FLAG_POLE_HEIGHT * 0.5;
    m[14] = z - dir.z * FLAG_POLE_HEIGHT * 0.5;
    m[15] = 1;
  }

  private visFor(id: EntityId): FlagVis {
    let v = this.vis.get(id);
    if (!v) {
      v = {
        state: 'stock',
        since: -1e9,
        plantAt: -1e9,
        decohereAt: -1e9,
        phase: hash01(id),
        gust: hash01b(id, 7),
        fallYaw: hash01b(id, 13) * Math.PI * 2,
        px: 0,
        py: 0,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        seen: this.frame,
        detailed: false,
      };
      const f = this.ctx.world.flags.get(id);
      if (f) {
        // First sighting is not a transition: no topple for Flags already lying around.
        v.state = f.state;
        v.px = f.pos.x;
        v.py = f.pos.y;
        v.pz = f.pos.z;
      }
      this.vis.set(id, v);
    }
    return v;
  }

  private takeTransient(): Transient {
    const tr = this.transients[this.nextTransient];
    this.nextTransient = (this.nextTransient + 1) % this.transients.length;
    tr.active = true;
    return tr;
  }

  private updateUniforms(t: number): void {
    const ctx = this.ctx;
    const night = 1 - ctx.daylight;
    this.uniforms.uTime.value = t;
    this.uniforms.uDaylight.value = ctx.daylight;
    this.uniforms.uRibbonGlow.value = 0.18 + 0.9 * night;
    this.uniforms.uSunView.value.copy(ctx.sunDir).transformDirection(ctx.camera.matrixWorldInverse);
    // Day: a touch of glow keeps the yellow the most saturated thing on screen; night: bloom.
    this.clothMat.emissiveIntensity = 0.24 + 1.4 * night;
  }
}
