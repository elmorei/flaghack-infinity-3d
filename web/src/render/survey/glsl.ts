/**
 * Shared GPU plumbing for the Survey layer: the uniform block every survey material
 * references (by object identity, so one write per frame updates all of them), GLSL helper
 * chunks (lattice data textures, faction palette, noise, fog fade) and the premultiplied
 * blend preset that lets one draw call mix glass (alpha) and glow (additive) output:
 * fragments write vec4(rgb * a, a * (1 - additive)).
 */
import * as THREE from 'three';
import { MAP_HALF } from '../../sim/constants';
import { TERRAIN_GLSL } from '../../sim/terrain';

/** Data textures are TEX_W texels wide; id → (id & 127, id >> 7). */
export const TEX_W = 128;

export function texRows(count: number): number {
  return Math.max(1, Math.ceil(count / TEX_W));
}

/** Lattice overlay heights above gameplay terrain. */
export const LIFT = {
  noise: 0.03,
  facet: 0.05,
  decal: 0.07,
  line: 0.09,
  marker: 0.1,
  leyGround: 0.11,
} as const;

/** Ley beam height: mid-pole between two planted Flags. */
export const BEAM_Y = 1.35;

/** Seconds a flipped node takes to slide to its new position. */
export const FLIP_TWEEN = 0.9;

/** Ring buffer of recent flips fed to the lattice/facet shaders. */
export const FLIP_SLOTS = 16;

export interface Uniform<T> {
  value: T;
}

export interface SurveyUniforms {
  [name: string]: Uniform<unknown>;
  uTime: Uniform<number>;
  uMapHalf: Uniform<number>;
  uViewBlend: Uniform<number>;
  /** Drawing-buffer size in device pixels. */
  uResolution: Uniform<THREE.Vector2>;
  /** Device pixel ratio (minimum line/marker widths scale with it). */
  uPx: Uniform<number>;
  uCameraNear: Uniform<number>;
  /** Per node: display x, display z, holder (-1..3), flags (bit0 blocked, bit1 real Flag, bits2-3 implied order). */
  uNodeTex: Uniform<THREE.DataTexture>;
  /** Per node: settle progress 0..1 (1 = not tweening), phason susceptibility, unused, unused. */
  uNodeAux: Uniform<THREE.DataTexture>;
  /** Per edge: ley owner, anim start, previous owner, anim kind (1 zip A→B, 2 zip B→A, -1 snap). */
  uEdgeTex: Uniform<THREE.DataTexture>;
  /** Per facet: cur | prev<<4 | boundary<<8, crystal cur+1 | (prev+1)<<3, instability, anim start. */
  uFacetTex: Uniform<THREE.DataTexture>;
  /** 0..3 faction colours, 4 = neutral (linear). */
  uFactionColor: Uniform<THREE.Color[]>;
  uAvatar: Uniform<THREE.Vector2>;
  /** Player's GCC: x, z, active (0/1). */
  uGcc: Uniform<THREE.Vector3>;
  /** x: action build-grid strength, y: Luminous Dust, z: build-grid radius, w: Acid Cop Vision. */
  uReveal: Uniform<THREE.Vector4>;
  /**
   * x: tide warning 0..1, y: sweep start time (-1e4 none), z: sweep duration s, w: reach m
   * (the front runs along uTideDir from projection -reach to +reach, in step with the sim).
   */
  uTide: Uniform<THREE.Vector4>;
  uTideDir: Uniform<THREE.Vector2>;
  /** Recent flips: x, z, start time, strength. */
  uFlips: Uniform<THREE.Vector4[]>;
  /**
   * Hovered node, edge, facet ids (-1 none); w = facet-highlight strength 0..1, on only while
   * facets are what the player points at (Command View, deck/ramp/building tools).
   */
  uHover: Uniform<THREE.Vector4>;
  /** The hovered facet's four edge ids. */
  uHoverEdges: Uniform<THREE.Vector4>;
  uSunDir: Uniform<THREE.Vector3>;
  uDaylight: Uniform<number>;
  /**
   * Night energy budget, set each frame by the orchestrator: x = 1 / tone-mapping exposure
   * (the night exposure lift must not brighten Survey emission), y = 0..1 how much of the
   * ground around the camera's view lies inside a Survey, z = ley-light scale, w = marker
   * scale (rings, sprites, beams, ghosts, Crystals, lattice).
   */
  uGlow: Uniform<THREE.Vector4>;
}

export function createSurveyUniforms(textures: {
  node: THREE.DataTexture;
  aux: THREE.DataTexture;
  edge: THREE.DataTexture;
  facet: THREE.DataTexture;
}, half = MAP_HALF): SurveyUniforms {
  const flips: THREE.Vector4[] = [];
  for (let i = 0; i < FLIP_SLOTS; i++) flips.push(new THREE.Vector4(0, 0, -1e4, 0));
  return {
    uTime: { value: 0 },
    uMapHalf: { value: half },
    uViewBlend: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uPx: { value: 1 },
    uCameraNear: { value: 0.1 },
    uNodeTex: { value: textures.node },
    uNodeAux: { value: textures.aux },
    uEdgeTex: { value: textures.edge },
    uFacetTex: { value: textures.facet },
    uFactionColor: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] },
    uAvatar: { value: new THREE.Vector2() },
    uGcc: { value: new THREE.Vector3() },
    uReveal: { value: new THREE.Vector4(1, 0, 40, 0) },
    uTide: { value: new THREE.Vector4(0, -1e4, 1, 1) },
    uTideDir: { value: new THREE.Vector2(1, 0) },
    uFlips: { value: flips },
    uHover: { value: new THREE.Vector4(-1, -1, -1, 0) },
    uHoverEdges: { value: new THREE.Vector4(-1, -1, -1, -1) },
    uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
    uDaylight: { value: 1 },
    uGlow: { value: new THREE.Vector4(1, 0, 1, 1) },
  };
}

/** Uniform declarations + helpers shared by every survey shader (vertex and fragment). */
export const GLSL_COMMON = /* glsl */ `
uniform float uMapHalf;
${TERRAIN_GLSL}
float fhGround(vec2 p) { return groundHeight(p, uMapHalf); }
uniform float uTime;
uniform float uViewBlend;
uniform vec2 uResolution;
uniform float uPx;
uniform float uCameraNear;
uniform highp sampler2D uNodeTex;
uniform highp sampler2D uNodeAux;
uniform highp sampler2D uEdgeTex;
uniform highp sampler2D uFacetTex;
uniform vec3 uFactionColor[5];
uniform vec2 uAvatar;
uniform vec3 uGcc;
uniform vec4 uReveal;
uniform vec4 uTide;
uniform vec2 uTideDir;
uniform vec4 uFlips[${FLIP_SLOTS}];
uniform vec4 uHover;
uniform vec4 uHoverEdges;
uniform vec3 uSunDir;
uniform float uDaylight;
uniform vec4 uGlow;

#define FH_PI 3.14159265
#define FH_TAU 6.28318531
#define FH_CULL { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

int fhId(float f) { return int(floor(f + 0.5)); }
ivec2 fhTexel(int id) { return ivec2(id & 127, id >> 7); }
vec4 fhNode(int id) { return texelFetch(uNodeTex, fhTexel(id), 0); }
vec4 fhNodeAux(int id) { return texelFetch(uNodeAux, fhTexel(id), 0); }
vec4 fhEdge(int id) { return texelFetch(uEdgeTex, fhTexel(id), 0); }
vec4 fhFacet(int id) { return texelFetch(uFacetTex, fhTexel(id), 0); }
vec3 fhFaction(int f) { return uFactionColor[f < 0 || f > 3 ? 4 : f]; }
/** exp(-x²). Never pow(x, 2.0): pow is undefined for x < 0 and yields NaN on ANGLE/D3D. */
float fhGauss(float x) { return exp(-x * x); }

/** 0 at night .. 1 by day (the same ramp the grade uses for its night look). */
float fhDay() { return smoothstep(0.05, 0.6, uDaylight); }

float fhHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float fhNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fhHash(i), fhHash(i + vec2(1.0, 0.0)), u.x), mix(fhHash(i + vec2(0.0, 1.0)), fhHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fhFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * fhNoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

/**
 * How strongly the bare lattice is revealed at a ground point: the action-mode build grid
 * around the vexillomancer, Geomantic Advice around the GCC, Luminous Dust, Command View.
 */
float fhLatticeReveal(vec2 p) {
  float grid = uReveal.x * (1.0 - smoothstep(uReveal.z * 0.45, uReveal.z, length(p - uAvatar)));
  float advice = uGcc.z * (1.0 - smoothstep(22.0, 30.0, length(p - uGcc.xy)));
  return max(max(grid, advice), max(uReveal.y, uViewBlend));
}

/** Tide sweep band (straight front along uTideDir) and recent flip ripples at a ground point. */
float fhCrystalPulse(vec2 p) {
  float band = 0.0;
  float k = uTime - uTide.y;
  if (k > 0.0 && k < uTide.z) {
    float front = uTide.w * (2.0 * k / uTide.z - 1.0);
    band = fhGauss((dot(p, uTideDir) - front) / 7.0);
  }
  float rip = 0.0;
  for (int i = 0; i < ${FLIP_SLOTS}; i++) {
    vec4 f = uFlips[i];
    float t = uTime - f.z;
    if (t >= 0.0 && t < 1.6) {
      float d = length(p - f.xy);
      rip += fhGauss((d - t * 9.0) / 1.4) * (1.0 - t / 1.6) * f.w;
    }
  }
  return band + rip;
}
`;

/** Vertex-stage helpers (projectionMatrix is only declared for vertex shaders). */
export const GLSL_VERT = /* glsl */ `
varying float vFogDepth;
/** Pixels per world unit at view distance 1. */
float fhProjScale() { return projectionMatrix[1][1] * 0.5 * uResolution.y; }
// Orthographic pixels have a fixed world scale, independent of camera altitude.
float fhPixelDepth(vec3 world) { return projectionMatrix[3][3] > 0.5 ? 1.0 : length(cameraPosition - world); }
// All orthographic rays are parallel, including at the edges of the field.
vec3 fhToCamera(vec3 world) {
  return projectionMatrix[3][3] > 0.5 ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : cameraPosition - world;
}
`;

export const GLSL_FRAG = /* glsl */ `
varying float vFogDepth;
#ifdef USE_FOG
uniform vec3 fogColor;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
#endif
/** 1 - fog factor: overlays fade out with distance instead of tinting toward fog colour. */
float fhFogKeep() {
#ifdef USE_FOG
#ifdef FOG_EXP2
  return exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
#else
  return 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
#endif
#else
  return 1.0;
#endif
}
`;

/**
 * Standard fragment epilogue (tone mapping + output colour space, as built-in materials do).
 * The HDR output is capped per material (FH_HDR_CAP) by scaling the colour so its brightest
 * channel fits, which keeps the hue (clipping single channels turns faction purple pink),
 * and NaN/negative output is zeroed so it can never poison the bloom pyramid.
 */
export const GLSL_OUTPUT = /* glsl */ `
float fhPeak = max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b);
if (!(fhPeak >= 0.0) || !(gl_FragColor.a >= 0.0)) gl_FragColor = vec4(0.0);
else if (fhPeak > FH_HDR_CAP) gl_FragColor.rgb *= FH_HDR_CAP / fhPeak;
gl_FragColor = clamp(gl_FragColor, vec4(0.0), vec4(vec3(FH_HDR_CAP), 1.0));
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;

export interface SurveyMaterialOptions {
  vertexShader: string;
  fragmentShader: string;
  uniforms?: Record<string, Uniform<unknown>>;
  depthTest?: boolean;
  side?: THREE.Side;
  defines?: Record<string, string | number>;
  /** Largest linear HDR value any output channel may carry (default 3). */
  hdrCap?: number;
}

/**
 * A survey ShaderMaterial: shared uniform block by reference, fog uniforms, premultiplied
 * blending (src ONE, dst ONE_MINUS_SRC_ALPHA), no depth writes.
 */
export function surveyMaterial(shared: SurveyUniforms, opts: SurveyMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: opts.vertexShader,
    fragmentShader: opts.fragmentShader,
    uniforms: { ...shared, ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...(opts.uniforms ?? {}) },
    defines: { FH_HDR_CAP: (opts.hdrCap ?? 3).toFixed(2), ...(opts.defines ?? {}) },
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest ?? true,
    side: opts.side ?? THREE.FrontSide,
    fog: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

/** A unit quad with a 2-component corner attribute, used as the base of instanced layers. */
export function cornerQuad(corners: readonly number[]): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
  // three needs a position attribute to size the draw; the shaders ignore it.
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((corners.length / 2) * 3), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Subdivided upward-facing decal sheet so broad rings follow the shared dome. */
export function cornerGrid(segments: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry(), corners: number[] = [], indices: number[] = [];
  for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) corners.push(x / segments * 2 - 1, z / segments * 2 - 1);
  for (let z = 0; z < segments; z++) for (let x = 0; x < segments; x++) {
    const a = z * (segments + 1) + x, b = a + segments + 1;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(corners.length / 2 * 3), 3));
  g.setIndex(indices); return g;
}
