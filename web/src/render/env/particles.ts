/**
 * Ambient particles in one additive Points draw: sunlit dust motes drifting on the wind by
 * day (they sparkle when you look toward the sun) and blinking fireflies over the grass at
 * night. Particles live in a box that wraps toroidally around the camera focus inside the
 * vertex shader: positions, drift, blinking and fading are all GPU-side, the CPU only moves
 * the focus uniform.
 */
import * as THREE from 'three';
import { TERRAIN_GLSL, groundHeight } from '../../sim/terrain';
import { hash01 } from '../../sim/rng';
import type { RenderContext } from '../context';
import type { EnvContext, EnvPart } from './envTypes';

const COUNT: Record<RenderContext['quality'], number> = { low: 450, medium: 900, high: 1500 };
/** Fraction of particles that are dust motes (the rest are fireflies). */
const DUST_SHARE = 0.45;
/** Side of the wrapping box (m) and how far ahead of the camera it is centred. */
const BOX = 72;
const LEAD = 22;

const VERT = /* glsl */ `
${TERRAIN_GLSL}
attribute vec4 aSeed;
attribute float aKind;
uniform vec2 uFocus;
uniform float uTime;
uniform vec2 uWind;
uniform float uHalf;
uniform float uDay;
uniform float uFireflies;
uniform float uPxScale;
uniform vec3 uSunDir;
uniform sampler2D uType;
varying vec3 vColor;
varying float vAlpha;

void main() {
  const float BOX_W = ${BOX.toFixed(1)};
  float ph = aSeed.w * 6.2831853;
  vec3 p;
  float size;
  vec3 col;
  float alpha;
  if (aKind < 0.5) {
    // Dust: rides the wind, bobs gently.
    vec2 anchor = aSeed.xy * BOX_W + uWind * uTime * 0.6;
    p.xz = uFocus + mod(anchor - uFocus + 0.5 * BOX_W, BOX_W) - 0.5 * BOX_W;
    p.y = 0.4 + aSeed.z * aSeed.z * 9.0 + sin(uTime * 0.6 + ph) * 0.35;
    p.xz += vec2(sin(uTime * 0.37 + ph), cos(uTime * 0.29 + ph * 1.3)) * 0.6;
    vec3 toP = normalize(p + vec3(0.0, groundHeight(p.xz, uHalf), 0.0) - cameraPosition);
    float scatter = pow(max(dot(toP, uSunDir), 0.0), 6.0);
    col = vec3(1.0, 0.86, 0.62) * (0.12 + 1.6 * scatter);
    alpha = uDay * (0.55 + 0.45 * sin(uTime * 2.0 + ph * 3.0));
    size = 0.022 + 0.02 * aSeed.z;
  } else {
    // Fireflies: hover low over the grass, wander, blink on their own rhythm.
    vec2 anchor = aSeed.xy * BOX_W;
    p.xz = uFocus + mod(anchor - uFocus + 0.5 * BOX_W, BOX_W) - 0.5 * BOX_W;
    p.xz += vec2(sin(uTime * 0.31 + ph), cos(uTime * 0.23 + ph * 1.7)) * 1.6;
    p.y = 0.3 + aSeed.z * 2.2 + sin(uTime * 0.8 + ph * 2.0) * 0.3;
    vec4 ty = textureLod(uType, (p.xz + uHalf) / (2.0 * uHalf), 0.0);
    float bare = clamp(ty.r + ty.g + ty.b + ty.a, 0.0, 1.0);
    float cycle = fract(uTime * (0.18 + aSeed.z * 0.22) + aSeed.w * 7.0);
    float blink = smoothstep(0.0, 0.08, cycle) * (1.0 - smoothstep(0.2, 0.42, cycle));
    col = mix(vec3(0.62, 1.0, 0.18), vec3(1.0, 0.86, 0.25), aSeed.w) * 4.0;
    alpha = uFireflies * blink * (1.0 - bare * 0.85);
    size = 0.05 + 0.03 * aSeed.z;
  }
  p.y += groundHeight(p.xz, uHalf);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  // Fade at the box rim (where particles recycle) and right in front of the lens.
  float rim = 1.0 - smoothstep(BOX_W * 0.32, BOX_W * 0.5, length(p.xz - uFocus));
  alpha *= rim * smoothstep(1.5, 4.0, dist);
  vColor = col;
  vAlpha = alpha;
  gl_PointSize = clamp(size * uPxScale / (projectionMatrix[2][3] == -1.0 ? max(dist, 0.1) : 1.0), 1.0, 14.0);
  gl_Position = projectionMatrix * mv;
  if (alpha < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = 1.0 - smoothstep(0.0, 0.5, r);
  gl_FragColor = vec4(vColor * a * a * vAlpha, 1.0);
}
`;

export class AmbientParticles implements EnvPart {
  private env: EnvContext;
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private focus = { value: new THREE.Vector2() };
  /** Dust and firefly strengths: time of day × how close the camera is to the meadow. */
  private day = { value: 1 };
  private fireflies = { value: 0 };
  private pxScale = { value: 600 };
  private fwd = new THREE.Vector3();
  private size = new THREE.Vector2();

  constructor(env: EnvContext, typeTexture: THREE.Texture) {
    this.env = env;
    const n = COUNT[env.ctx.quality];
    const seeds = new Float32Array(n * 4);
    const kinds = new Float32Array(n);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) seeds[i * 4 + k] = hash01(i * 4 + k + 7919);
      kinds[i] = i < n * DUST_SHARE ? 0 : 1;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.geo.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uFocus: this.focus,
        uTime: env.uniforms.uTime,
        uWind: env.uniforms.uWind,
        uHalf: { value: env.ctx.world.map.half },
        uDay: this.day,
        uFireflies: this.fireflies,
        uPxScale: this.pxScale,
        uSunDir: { value: env.day.sunDir },
        uType: { value: typeTexture },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.name = 'ambient-particles';
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    env.root.add(this.points);
  }

  update(_dt: number): void {
    const { ctx, day } = this.env;
    const cam = ctx.camera;
    cam.getWorldDirection(this.fwd);
    const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    this.focus.value.set(cam.position.x + (this.fwd.x / fl) * LEAD, cam.position.z + (this.fwd.z / fl) * LEAD);
    // Motes and fireflies are eye-level life: from the Command View camera (or any high
    // camera) they would be sub-pixel sparkles that read as noise on the map.
    const near = 1 - THREE.MathUtils.smoothstep(cam.position.y - groundHeight(cam.position.x, cam.position.z, ctx.world.map.half), 22, 40);
    this.day.value = day.daylight * (1 - day.night) * near;
    this.fireflies.value = day.night * near;
    ctx.renderer.getDrawingBufferSize(this.size);
    this.pxScale.value = this.size.y * cam.projectionMatrix.elements[5] / 2;
    this.points.visible = this.day.value > 0.01 || this.fireflies.value > 0.01;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
