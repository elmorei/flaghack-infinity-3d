import { terrainHeight } from '../terrain';
/**
 * The Burn's live fire. Everything animates on the GPU from a handful of uniforms; the CPU
 * only writes those uniforms and drives the fire light each frame:
 *   flames  instanced view-facing flame sprites anchored on the plinth, legs, mast and crown,
 *           each looping through a lick (rise, swell, die) with noise-torn edges and an HDR
 *           temperature ramp, added together so the core blooms white-gold;
 *   smoke   a column of soft puffs that rises, widens and bends downwind, lit orange from
 *           below by the fire;
 *   embers  points spiralling up out of the flames and away on the wind;
 *   bed     a spreading disc of ash and breathing coals around the plinth;
 *   light   the env fire light, placed in the flames and flickering.
 * Hidden (no draw calls) until The Burn, apart from one warm-up frame at construction that
 * compiles the programs for the real render target with every particle collapsed.
 */
import * as THREE from 'three';
import { Rng } from '../../../sim/rng';
import type { RenderContext } from '../../context';
import type { EnvContext } from '../envTypes';
import type { BurnUniforms } from './charMaterial';
import { LATTICE_TOP, PLINTH_HEIGHT, PLINTH_RADIUS } from './burnTimeline';
import { LEGS, legPoint, mastRadius } from './effigyModel';

const COUNTS: Record<RenderContext['quality'], { flames: number; smoke: number; embers: number }> = {
  low: { flames: 44, smoke: 18, embers: 500 },
  medium: { flames: 68, smoke: 30, embers: 1200 },
  high: { flames: 100, smoke: 44, embers: 2400 },
};

/** Peak fire light intensity (candela; decays with distance^1.4, cut off at ~140 m). */
const FIRE_LIGHT_PEAK = 75;

/** Additive HDR: colour accumulates, destination alpha is left alone. */
function additive(mat: THREE.ShaderMaterial): THREE.ShaderMaterial {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  return mat;
}

const FLAME_VERT = /* glsl */ `
attribute vec3 aAnchor;
attribute vec2 aSize;
attribute vec4 aSeed;
uniform float uTime;
uniform float uFire;
uniform float uFlare;
uniform float uFireFront;
uniform float uFireCeil;
uniform vec2 uWind;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying float vHeat;
varying vec4 vSeed;
varying float vFade;

void main() {
  float period = mix(0.7, 1.45, aSeed.x);
  float ph = uTime / period + aSeed.y;
  float age = fract(ph);
  float cyc = floor(ph);
  float r1 = fract(sin(cyc * 17.13 + aSeed.z * 91.7) * 43758.5453);
  float r2 = fract(r1 * 13.37 + aSeed.w * 7.1);
  float y0 = aAnchor.y;
  // Lit once the flame front has passed this anchor, out again once the lattice above is gone.
  float live = smoothstep(y0 - 0.5, y0 + 1.5, uFireFront) * (1.0 - smoothstep(uFireCeil - 1.0, uFireCeil + 2.5, y0));
  float flare = uFlare * (1.0 - smoothstep(1.5, 6.0, y0));
  float amt = clamp(live * uFire + flare * 0.6, 0.0, 1.25);
  float grow = smoothstep(0.0, 0.2, age) * (1.0 - smoothstep(0.55, 1.0, age));
  float k = grow * amt * (0.6 + 0.4 * r1);
  vUv = vec2(position.x + 0.5, position.y);
  vHeat = amt * grow;
  vSeed = vec4(aSeed.xy + vec2(r1, r2) * 0.37, aSeed.zw);
  if (k < 0.02) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float w = aSize.x * (0.55 + 0.45 * k) * (1.0 + flare * 0.4);
  float h = aSize.y * k * (1.0 + flare * 0.35);
  vec3 base = aAnchor + vec3((r1 - 0.5) * 0.6, age * h * 0.25, (r2 - 0.5) * 0.6);
  // Flames lean downwind with height.
  base += vec3(uWind.x, 0.0, uWind.y) * position.y * h * 0.3;
  vec4 mv = modelViewMatrix * vec4(base, 1.0);
  // Upright on screen along projected world-up; facing the camera when seen from above.
  vec3 up = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  float l = length(up.xy);
  vec2 upMix = mix(vec2(0.0, 1.0), up.xy / max(l, 1e-4), smoothstep(0.05, 0.3, l));
  vec2 up2 = upMix / max(length(upMix), 1e-4);
  vec2 right2 = vec2(up2.y, -up2.x);
  mv.xy += right2 * position.x * w + up2 * position.y * h * mix(0.65, 1.0, l);
  gl_Position = projectionMatrix * mv;
  vFade = 1.0 - 0.7 * smoothstep(uFogNear, uFogFar, -mv.z);
}
`;

const FLAME_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
varying vec2 vUv;
varying float vHeat;
varying vec4 vSeed;
varying float vFade;

// Flame temperature to linear colour: a red-orange body, gold only in the hottest core.
vec3 fireRamp(float t) {
  vec3 c = mix(vec3(0.25, 0.012, 0.0), vec3(1.0, 0.16, 0.012), smoothstep(0.0, 0.35, t));
  c = mix(c, vec3(1.0, 0.36, 0.04), smoothstep(0.3, 0.65, t));
  c = mix(c, vec3(1.0, 0.6, 0.16), smoothstep(0.62, 0.88, t));
  return mix(c, vec3(1.0, 0.8, 0.45), smoothstep(0.88, 1.0, t));
}

void main() {
  float y = vUv.y;
  float t = uTime;
  float n1 = texture2D(uNoise, vec2(vUv.x * 0.42 + vSeed.x, y * 0.36 - t * 0.5 + vSeed.y)).r;
  float n2 = texture2D(uNoise, vec2(vUv.x * 0.95 + vSeed.z, y * 0.8 - t * 1.15 + vSeed.w)).g;
  float x = vUv.x - 0.5 + ((n1 - 0.5) * 0.55 + (n2 - 0.5) * 0.3) * smoothstep(0.0, 0.9, y);
  float halfW = mix(0.44, 0.05, pow(max(y, 0.0), 0.75));
  float body = 1.0 - smoothstep(halfW * 0.2, halfW, abs(x));
  float tip = 1.0 - smoothstep(0.3, 0.95, y + (n2 - 0.5) * 0.5 - (n1 - 0.5) * 0.3);
  float d = body * tip * smoothstep(0.0, 0.12, y) * (0.6 + 0.8 * n2);
  float T = clamp(d * (1.2 - 0.6 * y) * (0.55 + 0.5 * vHeat), 0.0, 1.0);
  // Per-sprite HDR stays modest: overlapping licks add up to a core of ~5-7, not a flashbulb.
  vec3 col = fireRamp(T) * (0.45 + 1.5 * T * T);
  float a = smoothstep(0.02, 0.3, d) * min(vHeat, 1.0) * vFade;
  gl_FragColor = vec4(col * a, 1.0);
  #include <colorspace_fragment>
}
`;

const SMOKE_VERT = /* glsl */ `
attribute vec4 aSeed;
attribute vec4 aSeed2;
uniform float uTime;
uniform float uSmoke;
uniform float uFire;
uniform float uSmokeBase;
uniform float uFireTop;
uniform float uViewFade;
uniform vec2 uWind;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uSunDir;
varying vec2 vUv;
varying float vAlpha;
varying float vGlow;
varying float vFog;
varying float vScatter;
varying vec2 vRot;
varying vec2 vSeed;

void main() {
  float life = mix(15.0, 24.0, aSeed.x);
  float age = fract(uTime / life + aSeed.y);
  float tt = age * life;
  float y = uSmokeBase + aSeed.w * 4.0 + mix(48.0, 80.0, aSeed.z) * (1.0 - pow(1.0 - age, 1.6));
  // The column bends downwind and widens as it rises.
  vec2 drift = uWind * tt * mix(1.3, 2.3, aSeed2.x) * smoothstep(0.0, 0.3, age);
  vec2 spread = (aSeed2.yz - 0.5) * (2.0 + 20.0 * age);
  vec3 c = vec3(drift.x + spread.x, y, drift.y + spread.y);
  float size = mix(5.0, 26.0, pow(age, 0.65)) * mix(0.75, 1.3, aSeed2.w);
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  float alpha = uSmoke * uViewFade * smoothstep(0.0, 0.07, age) * (1.0 - smoothstep(0.42, 1.0, age));
  // Thin out puffs the camera is inside of (and spare their overdraw).
  alpha *= smoothstep(size * 0.2, size * 1.0, -mv.z);
  vAlpha = alpha;
  if (alpha < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float rot = aSeed.x * 6.2831853 + uTime * (aSeed2.x - 0.5) * 0.12;
  float cr = cos(rot);
  float sr = sin(rot);
  mv.xy += vec2(cr * position.x - sr * position.y, sr * position.x + cr * position.y) * size;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy + 0.5;
  vRot = vec2(cr, sr);
  vGlow = uFire * exp(-max(0.0, y - uFireTop) / 15.0);
  vFog = smoothstep(uFogNear, uFogFar, -mv.z);
  vSeed = aSeed2.yz;
  // Forward scattering: a puff between the camera and the sun (or moon) lights up at its thin
  // edges, the silver lining of a smoke column against the dawn.
  vec3 toPuff = normalize((modelMatrix * vec4(c, 1.0)).xyz - cameraPosition);
  vScatter = pow(max(dot(toPuff, uSunDir), 0.0), 8.0);
}
`;

const SMOKE_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uAmbient;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
varying vec2 vUv;
varying float vAlpha;
varying float vGlow;
varying float vFog;
varying float vScatter;
varying vec2 vRot;
varying vec2 vSeed;

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  vec2 nuv = vUv * 0.5 + vSeed * 3.7 + vec2(0.0, -uTime * 0.012);
  float n = texture2D(uNoise, nuv).r * 0.6 + texture2D(uNoise, nuv * 2.3 + 0.17).g * 0.4;
  float dens = (1.0 - smoothstep(0.3, 1.0, r + (n - 0.5) * 0.9)) * smoothstep(0.2, 0.65, n + 0.2);
  float a = dens * vAlpha;
  if (a < 0.004) discard;
  // Screen-space underside of the puff: that is where the fire below lights it.
  float below = clamp(0.5 - (vRot.y * p.x + vRot.x * p.y), 0.0, 1.0);
  vec3 lit = vec3(0.075, 0.07, 0.066) * (uAmbient + uSunColor * 0.25) * (0.75 + 0.5 * n);
  lit += uSunColor * (0.3 * vScatter * (1.0 - 0.6 * dens) * (0.6 + 0.4 * n));
  vec3 glow = vec3(1.0, 0.3, 0.07) * vGlow * (0.35 + 1.1 * below) * (0.5 + 0.7 * n);
  gl_FragColor = vec4(mix(lit + glow, uFogColor, vFog), a * (1.0 - 0.5 * vFog));
  #include <colorspace_fragment>
}
`;

const EMBER_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uRate;
uniform float uFireTop;
uniform float uPointScale;
uniform vec2 uWind;
uniform float uFogNear;
uniform float uFogFar;
varying float vHeat;
varying float vAlpha;

void main() {
  float life = mix(2.2, 6.0, aSeed.x);
  float ph = uTime / life + aSeed.y;
  float age = fract(ph);
  // Each life cycle draws a fresh lottery ticket against the current emission rate.
  float gate = fract(sin(floor(ph) * 91.7 + aSeed.z * 47.3) * 43758.5453);
  float on = step(gate, uRate);
  float y0 = mix(0.4, max(1.5, uFireTop), position.y);
  float rad = mix(0.2, mix(3.0, 1.2, clamp(y0 / 20.0, 0.0, 1.0)), position.z);
  float ang = position.x * 6.2831853;
  float tt = age * life;
  vec3 p = vec3(cos(ang) * rad, y0 + mix(2.0, 6.5, aSeed.z) * tt * (1.0 - 0.18 * age), sin(ang) * rad);
  p.xz += uWind * tt * mix(1.2, 3.6, aSeed.w);
  float sw = uTime * mix(1.6, 4.2, aSeed.z) + aSeed.w * 40.0;
  p.xz += vec2(cos(sw), sin(sw * 1.3)) * (0.15 + 1.1 * age);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vHeat = 1.0 - age;
  vAlpha = on * smoothstep(0.0, 0.05, age) * (1.0 - age) * (0.7 + 0.3 * sin(uTime * mix(9.0, 21.0, aSeed.x) + aSeed.y * 31.0));
  vAlpha *= 1.0 - 0.7 * smoothstep(uFogNear, uFogFar, -mv.z);
  float size = mix(0.05, 0.13, aSeed.w) * (1.0 - 0.45 * age);
  gl_PointSize = on * clamp(size * uPointScale / (projectionMatrix[2][3] == -1.0 ? max(-mv.z, 0.1) : 1.0), 1.2, 18.0);
}
`;

const EMBER_FRAG = /* glsl */ `
varying float vHeat;
varying float vAlpha;

void main() {
  float a = 1.0 - smoothstep(0.05, 0.5, length(gl_PointCoord - 0.5));
  vec3 col = mix(vec3(1.0, 0.13, 0.015), vec3(1.0, 0.62, 0.22), vHeat * vHeat);
  gl_FragColor = vec4(col * a * vAlpha * (1.5 + 3.5 * vHeat), 1.0);
  #include <colorspace_fragment>
}
`;

const BED_VERT = /* glsl */ `
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vXZ;
varying float vFade;

void main() {
  vXZ = position.xz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vFade = 1.0 - smoothstep(uFogNear, uFogFar, -mv.z);
}
`;

const BED_FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uTime;
uniform float uBed;
uniform float uFire;
uniform vec3 uFogColor;
varying vec2 vXZ;
varying float vFade;

void main() {
  float r = length(vXZ);
  float n = texture2D(uNoise, vXZ * 0.045 + 0.5).r;
  float reach = mix(${PLINTH_RADIUS.toFixed(2)}, 7.5, uBed) * (0.8 + 0.4 * n);
  float mask = (1.0 - smoothstep(reach - 1.8, reach, r)) * step(0.001, uBed);
  if (mask <= 0.003) discard;
  float c1 = texture2D(uNoise, vXZ * 0.15).b;
  float c2 = texture2D(uNoise, vXZ * 0.43 + 0.3).b;
  float coals = (1.0 - smoothstep(0.1, 0.35, c1)) * (0.4 + 0.6 * (1.0 - smoothstep(0.15, 0.4, c2)));
  float heat = (1.0 - 0.85 * smoothstep(${PLINTH_RADIUS.toFixed(2)}, max(reach, ${PLINTH_RADIUS.toFixed(2)}) + 0.5, r)) * (0.3 + 0.7 * uFire);
  float pulse = 0.55 + 0.45 * sin(uTime * 1.6 + n * 25.0 + c2 * 7.0);
  vec3 ash = vec3(0.03, 0.028, 0.026) * (0.7 + 0.6 * texture2D(uNoise, vXZ * 0.9).g);
  vec3 hot = mix(vec3(1.0, 0.1, 0.01), vec3(1.0, 0.42, 0.07), coals * pulse) * coals * heat * pulse * 3.5;
  gl_FragColor = vec4(mix(uFogColor, ash, vFade) + hot * vFade, mask * 0.94);
  #include <colorspace_fragment>
}
`;

export interface BurnFxDrive {
  /** 0..1 ignition fireball. */
  flare: number;
  smoke: number;
  emberRate: number;
  emberBed: number;
}

export class BurnFx {
  readonly group = new THREE.Group();
  private env: EnvContext;
  private burn: BurnUniforms;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.ShaderMaterial[] = [];
  private warmup = 2;
  // Uniforms owned here (the rest are shared env/burn uniform objects).
  private uFlare = { value: 0 };
  private uSmoke = { value: 0 };
  private uSmokeBase = { value: PLINTH_HEIGHT };
  private uFireTop = { value: PLINTH_HEIGHT };
  private uViewFade = { value: 1 };
  private uRate = { value: 0 };
  private uBed = { value: 0 };
  private uPointScale = { value: 600 };
  private uAmbient = { value: new THREE.Color() };
  private drawSize = new THREE.Vector2();

  constructor(env: EnvContext, burn: BurnUniforms) {
    this.env = env;
    this.burn = burn;
    this.group.name = 'burn-fx';
    const counts = COUNTS[env.ctx.quality];
    const rng = new Rng(`burn:${env.ctx.world.map.seed}`);
    const u = env.uniforms;
    const fog = { uFogNear: burn.uFogNear, uFogFar: burn.uFogFar };

    const bed = new THREE.CircleGeometry(9, 56).rotateX(-Math.PI / 2).translate(0, 0.03, 0);
    const bedMat = new THREE.ShaderMaterial({
      vertexShader: BED_VERT,
      fragmentShader: BED_FRAG,
      uniforms: { ...fog, uNoise: burn.uNoise, uTime: u.uTime, uBed: this.uBed, uFire: burn.uFire, uFogColor: u.uFogColor },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.add(bed, bedMat, new THREE.Mesh(bed, bedMat), 1);

    const smoke = this.quads(counts.smoke, -0.5);
    const s1 = new Float32Array(counts.smoke * 4);
    const s2 = new Float32Array(counts.smoke * 4);
    for (let i = 0; i < s1.length; i++) {
      s1[i] = rng.next();
      s2[i] = rng.next();
    }
    smoke.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s1, 4));
    smoke.setAttribute('aSeed2', new THREE.InstancedBufferAttribute(s2, 4));
    const smokeMat = new THREE.ShaderMaterial({
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      uniforms: {
        ...fog,
        uTime: u.uTime,
        uWind: u.uWind,
        uNoise: burn.uNoise,
        uFire: burn.uFire,
        uSmoke: this.uSmoke,
        uSmokeBase: this.uSmokeBase,
        uFireTop: this.uFireTop,
        uViewFade: this.uViewFade,
        uAmbient: this.uAmbient,
        uSunColor: u.uSunColor,
        uSunDir: u.uSunDir,
        uFogColor: u.uFogColor,
      },
      transparent: true,
      depthWrite: false,
    });
    this.add(smoke, smokeMat, new THREE.Mesh(smoke, smokeMat), 2);

    const flames = this.quads(counts.flames, 0);
    const anchor = new Float32Array(counts.flames * 3);
    const size = new Float32Array(counts.flames * 2);
    const seed = new Float32Array(counts.flames * 4);
    const p = new THREE.Vector3();
    for (let i = 0; i < counts.flames; i++) {
      const f = i / counts.flames;
      let w: number;
      let h: number;
      if (f < 0.24) {
        // Around and against the plinth.
        const th = rng.next() * Math.PI * 2;
        const r = PLINTH_RADIUS * (0.55 + rng.next() * 0.55);
        p.set(Math.cos(th) * r, 0.2 + rng.next() * 2.4, Math.sin(th) * r);
        w = 2.2 + rng.next() * 1.2;
        h = 4.2 + rng.next() * 3.0;
      } else if (f < 0.86) {
        // Up the legs and the mast.
        const y = PLINTH_HEIGHT + rng.next() * (LATTICE_TOP - PLINTH_HEIGHT);
        if (rng.chance(0.6)) {
          legPoint(rng.int(0, LEGS - 1), y, p);
          p.x += (rng.next() - 0.5) * 0.5;
          p.z += (rng.next() - 0.5) * 0.5;
        } else {
          const th = rng.next() * Math.PI * 2;
          const r = mastRadius(y) + 0.25 + rng.next() * 0.3;
          p.set(Math.cos(th) * r, y, Math.sin(th) * r);
        }
        const shrink = 1 - 0.3 * ((y - PLINTH_HEIGHT) / (LATTICE_TOP - PLINTH_HEIGHT));
        w = (1.7 + rng.next() * 1.2) * shrink;
        h = (3.4 + rng.next() * 2.8) * shrink;
      } else {
        // The crown: tongues licking up at the Flag.
        const th = rng.next() * Math.PI * 2;
        const r = 0.3 + rng.next() * 0.9;
        p.set(Math.cos(th) * r, LATTICE_TOP - 2 + rng.next() * 3, Math.sin(th) * r);
        w = 2.0 + rng.next() * 1.2;
        h = 4.5 + rng.next() * 3.0;
      }
      p.toArray(anchor, i * 3);
      size[i * 2] = w;
      size[i * 2 + 1] = h;
      for (let k = 0; k < 4; k++) seed[i * 4 + k] = rng.next();
    }
    flames.setAttribute('aAnchor', new THREE.InstancedBufferAttribute(anchor, 3));
    flames.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2));
    flames.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    const flameMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: FLAME_VERT,
        fragmentShader: FLAME_FRAG,
        uniforms: {
          ...fog,
          uTime: u.uTime,
          uWind: u.uWind,
          uNoise: burn.uNoise,
          uFire: burn.uFire,
          uFireFront: burn.uFireFront,
          uFireCeil: burn.uFireCeil,
          uFlare: this.uFlare,
        },
      }),
    );
    this.add(flames, flameMat, new THREE.Mesh(flames, flameMat), 3);

    const embers = new THREE.BufferGeometry();
    const spawn = new Float32Array(counts.embers * 3);
    const eSeed = new Float32Array(counts.embers * 4);
    for (let i = 0; i < spawn.length; i++) spawn[i] = rng.next();
    for (let i = 0; i < eSeed.length; i++) eSeed[i] = rng.next();
    embers.setAttribute('position', new THREE.BufferAttribute(spawn, 3));
    embers.setAttribute('aSeed', new THREE.BufferAttribute(eSeed, 4));
    const emberMat = additive(
      new THREE.ShaderMaterial({
        vertexShader: EMBER_VERT,
        fragmentShader: EMBER_FRAG,
        uniforms: { ...fog, uTime: u.uTime, uWind: u.uWind, uRate: this.uRate, uFireTop: this.uFireTop, uPointScale: this.uPointScale },
      }),
    );
    this.add(embers, emberMat, new THREE.Points(embers, emberMat), 4);
  }

  /** Instanced unit quads: x in [-0.5, 0.5], y in [y0, y0 + 1]. */
  private quads(count: number, y0: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, y0, 0, 0.5, y0, 0, 0.5, y0 + 1, 0, -0.5, y0 + 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = count;
    return g;
  }

  private add(geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial, obj: THREE.Mesh | THREE.Points, order: number): void {
    // Shader-animated: the static bounds mean nothing, so never frustum-cull.
    obj.frustumCulled = false;
    obj.renderOrder = order;
    this.geos.push(geo);
    this.mats.push(mat);
    this.group.add(obj);
  }

  update(active: boolean, drive: BurnFxDrive): void {
    const env = this.env;
    const light = env.fireLight;
    if (!active) {
      // Warm-up frames draw everything collapsed so the programs compile for the real target.
      this.group.visible = this.warmup > 0;
      if (this.warmup > 0) this.warmup--;
      light.intensity = 0;
      return;
    }
    this.group.visible = true;
    const burn = this.burn;
    const day = env.day;
    const ctx = env.ctx;
    const top = Math.min(burn.uFireFront.value, burn.uFireCeil.value);
    this.uFlare.value = drive.flare;
    this.uSmoke.value = drive.smoke;
    this.uRate.value = drive.emberRate;
    this.uBed.value = drive.emberBed;
    this.uFireTop.value = top;
    this.uSmokeBase.value = Math.max(PLINTH_HEIGHT, top - 3);
    // Command View looks straight down the column: thin the smoke there.
    this.uViewFade.value = 1 - 0.75 * ctx.session.viewBlend;
    this.uAmbient.value.copy(day.hemiSky).multiplyScalar(day.hemiIntensity * 0.9);
    ctx.renderer.getDrawingBufferSize(this.drawSize);
    this.uPointScale.value = this.drawSize.y / (2 / ctx.camera.projectionMatrix.elements[5]);

    // Fire light: sits in the flames, flickers, warms as it swells.
    const t = ctx.time;
    const flick = 0.82 + 0.09 * Math.sin(t * 9.1) + 0.06 * Math.sin(t * 15.7 + 1.3) + 0.03 * Math.sin(t * 27.3 + 0.4);
    const strength = Math.min(1.2, burn.uFire.value + drive.flare * 0.5);
    const origin = ctx.world.map.effigy;
    light.position.set(origin.x + Math.sin(t * 3.3) * 0.3, terrainHeight(origin.x, origin.z, ctx.world.map.half) + Math.max(2.5, Math.min(10, top * 0.45)), origin.z + Math.cos(t * 2.9) * 0.3);
    light.intensity = FIRE_LIGHT_PEAK * strength * flick;
    light.color.setRGB(1, 0.36 + 0.5 * (flick - 0.82), 0.1 + 0.2 * (flick - 0.82));
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.env.fireLight.intensity = 0;
  }
}
