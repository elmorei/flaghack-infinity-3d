/**
 * GPU particle pools with analytic motion. A particle is written exactly once, at spawn,
 * into a ring buffer of instanced attributes; the vertex shader evaluates position, size,
 * colour and billboard orientation from (uTime - start). The CPU never touches a live
 * particle, so thousands of them cost one instanced draw per pool. Dead and unspawned
 * instances collapse to a clipped vertex.
 *
 * Motion models:
 * - Ballistic: p = p0 + v0 (1 - e^(-drag t)) / drag - ½ g t² ŷ   (linear drag, gravity).
 * - Orbit: circles `p0` with radius r0·e^(-shrink t); angular speed ω0·e^(2 shrink t) keeps
 *   angular momentum, so converging spirals whip faster as they close (capture vortex, KO
 *   stars, sparkles). Vertical: vy t - ½ g t².
 */
import * as THREE from 'three';
import { COLLAPSE_GLSL, FOG_FRAG_GLSL, NOISE_GLSL, OUTPUT_GLSL, fxMaterial, quadXY, type SharedUniforms } from './glsl';
import { InstanceBuffer } from './instanceBuffer';

export const Shape = {
  /** Soft glow dot (hot core + halo). */
  Dot: 0,
  /** Velocity-stretched spark streak. */
  Spark: 1,
  /** Five-point star. */
  Star: 2,
  /** Thin ring. */
  Ring: 3,
  /** Square chip / confetti (pair with spin + flutter). */
  Chip: 4,
  /** Noisy smoke / dust puff. */
  Smoke: 5,
  /** Sliver: glass shard or wood splinter. */
  Shard: 6,
  /** Digital glitch block with scanlines. */
  Glitch: 7,
  /** Emissive, turbulent fire lobe with a hot core and cooling rim. */
  Fireball: 8,
} as const;
export type ShapeId = (typeof Shape)[keyof typeof Shape];

export const Motion = { Ballistic: 0, Orbit: 1 } as const;
export type MotionId = (typeof Motion)[keyof typeof Motion];

/** vec4 attributes per particle (see the layout in the vertex shader). */
const VEC4S = 8;

/**
 * Mutable spawn description. Fill it with the chained setters and hand it to
 * ParticlePool.emit; reusing one spec keeps spawning allocation-free.
 */
export class ParticleSpec {
  x = 0;
  y = 0;
  z = 0;
  delay = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  life = 1;
  size0 = 1;
  size1 = 0;
  gravity = 0;
  drag = 0;
  r0 = 1;
  g0 = 1;
  b0 = 1;
  a0 = 1;
  r1 = 1;
  g1 = 1;
  b1 = 1;
  a1 = 0;
  shape: ShapeId = Shape.Dot;
  spin = 0;
  rot = 0;
  streak = 0;
  motion: MotionId = Motion.Ballistic;
  theta = 0;
  shrink = 0;
  flicker = 0;
  flutter = 0;
  fadeIn = 0.03;
  verticalScale = 1;
  groundY = 0;

  /** Reset to a 1 s white dot at the origin; every recipe starts here. */
  reset(): this {
    this.x = this.y = this.z = this.delay = 0;
    this.vx = this.vy = this.vz = 0;
    this.life = 1;
    this.size0 = 1;
    this.size1 = 0;
    this.gravity = this.drag = 0;
    this.r0 = this.g0 = this.b0 = this.a0 = 1;
    this.r1 = this.g1 = this.b1 = 1;
    this.a1 = 0;
    this.shape = Shape.Dot;
    this.spin = this.rot = this.streak = 0;
    this.motion = Motion.Ballistic;
    this.theta = this.shrink = 0;
    this.flicker = this.flutter = 0;
    this.fadeIn = 0.03;
    this.verticalScale = 1;
    this.groundY = 0;
    return this;
  }

  at(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  vel(x: number, y: number, z: number): this {
    this.motion = Motion.Ballistic;
    this.vx = x;
    this.vy = y;
    this.vz = z;
    return this;
  }

  /**
   * Orbit around the spawn point: radius r0 (m), angular speed w (rad/s), vertical speed vy,
   * start angle theta, radial shrink rate (1/s; negative spirals outward).
   */
  orbit(r0: number, w: number, vy: number, theta: number, shrink: number): this {
    this.motion = Motion.Orbit;
    this.vx = r0;
    this.vy = vy;
    this.vz = w;
    this.theta = theta;
    this.shrink = shrink;
    return this;
  }

  time(life: number, delay = 0): this {
    this.life = life;
    this.delay = delay;
    return this;
  }

  size(start: number, end: number): this {
    this.size0 = start;
    this.size1 = end;
    return this;
  }

  /** Gravity (m/s², + pulls down, - is buoyancy) and linear drag (1/s). */
  phys(gravity: number, drag: number): this {
    this.gravity = gravity;
    this.drag = drag;
    return this;
  }

  /** Start colour × intensity (HDR, linear) and alpha. */
  from(c: THREE.Color, intensity: number, alpha: number): this {
    this.r0 = c.r * intensity;
    this.g0 = c.g * intensity;
    this.b0 = c.b * intensity;
    this.a0 = alpha;
    return this;
  }

  /** End colour × intensity and alpha. */
  to(c: THREE.Color, intensity: number, alpha: number): this {
    this.r1 = c.r * intensity;
    this.g1 = c.g * intensity;
    this.b1 = c.b * intensity;
    this.a1 = alpha;
    return this;
  }

  /** Fireball only: stretch in WORLD vertical about the ground, never horizontal width. */
  stretchVertical(scale: number, groundY: number): this {
    this.verticalScale = scale;
    this.groundY = groundY;
    return this;
  }

  /** Shape, spin (rad/s), start rotation, and streak time (s of motion blur, 0 = none). */
  look(shape: ShapeId, spin = 0, rot = 0, streak = 0): this {
    this.shape = shape;
    this.spin = spin;
    this.rot = rot;
    this.streak = streak;
    return this;
  }

  /** Flicker amount (0..1), flutter frequency (fake 3D flip, rad/s), fade-in time (s). */
  anim(flicker: number, flutter: number, fadeIn = 0.03): this {
    this.flicker = flicker;
    this.flutter = flutter;
    this.fadeIn = fadeIn;
    return this;
  }
}

const VERT = /* glsl */ `
uniform float uTime;
uniform float uViewportH;
attribute vec4 a0; // spawn pos xyz, start time
attribute vec4 a1; // velocity xyz (orbit: r0, vy, w), life
attribute vec4 a2; // size start, size end, gravity, drag
attribute vec4 a3; // colour start rgb, alpha start
attribute vec4 a4; // colour end rgb, alpha end
attribute vec4 a5; // shape, spin, rotation, streak time
attribute vec4 a6; // motion, theta0, shrink, seed
attribute vec4 a7; // flicker, flutter, fade-in, -
varying vec2 vUv;
varying vec4 vColor;
varying float vShape;
varying float vSeed;
varying float vT;
varying float vShade;
#include <fog_pars_vertex>

void main() {
  float age = uTime - a0.w;
  float life = a1.w;
  if (age < 0.0 || age >= life) { ${COLLAPSE_GLSL} }
  float t = age / life;
  vec3 p;
  vec3 vel;
  if (a6.x < 0.5) {
    float decay = exp(-a2.w * age);
    float k = a2.w > 0.0001 ? (1.0 - decay) / a2.w : age;
    p = a0.xyz + a1.xyz * k;
    p.y -= 0.5 * a2.z * age * age;
    vel = a1.xyz * decay;
    vel.y -= a2.z * age;
  } else {
    float k2 = 2.0 * a6.z;
    float spinUp = exp(k2 * age);
    float r = a1.x * exp(-a6.z * age);
    float theta = a6.y + (abs(k2) > 0.0001 ? a1.z * (spinUp - 1.0) / k2 : a1.z * age);
    float c = cos(theta);
    float s = sin(theta);
    p = a0.xyz + vec3(c * r, a1.y * age - 0.5 * a2.z * age * age, s * r);
    vel = vec3(-s, 0.0, c) * (r * a1.z * spinUp) - vec3(c, 0.0, s) * (a6.z * r);
    vel.y = a1.y - a2.z * age;
  }
  // Flame poofs inflate sharply, then billow rather than growing linearly.
  float growth = a5.x > 7.5 ? 1.0 - exp(-7.0 * t) : t;
  float size = mix(a2.x, a2.y, growth);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float depth = projectionMatrix[2][3] == -1.0 ? max(-mv.z, 0.05) : 1.0;
  // Keep far particles >= ~1.6 px, trading area for brightness so they do not shimmer away.
  float pxPerUnit = max(projectionMatrix[1][1] * 0.5 * uViewportH / depth, 0.0001);
  float minSize = 1.6 / pxPerUnit;
  float energy = 1.0;
  if (size < minSize) {
    energy = size / minSize;
    energy *= energy;
    size = minSize;
  }
  vec2 ax;
  vec2 center = mv.xy;
  float sx = size;
  float sy = size * (a5.x > 7.5 ? 1.18 : 1.0);
  if (a5.w > 0.0) {
    // Motion blur: stretch along the on-screen velocity, head at the particle.
    vec2 sv = (viewMatrix * vec4(vel, 0.0)).xy;
    float sp = length(sv);
    ax = sp > 0.0001 ? sv / sp : vec2(1.0, 0.0);
    sx = size + sp * a5.w;
    center -= ax * (sx - size);
  } else {
    float ang = a5.z + a5.y * age;
    ax = vec2(cos(ang), sin(ang));
  }
  vShade = 1.0;
  if (a7.y > 0.0) {
    // Flutter: fake a 3D flip by squashing one axis (confetti, tumbling shards).
    float flip = cos(a7.y * age + a6.w * 6.2831853);
    sy *= max(abs(flip), 0.15);
    vShade = 0.55 + 0.45 * abs(flip) + 0.6 * pow(max(flip, 0.0), 12.0);
  }
  vec2 ay = vec2(-ax.y, ax.x);
  mv.xy = center + ax * (position.x * sx) + ay * (position.y * sy);
  if (a5.x > 7.5) {
    // Stretch the entire lobe, including its rise, about ground in world Y. Scaling
    // screen Y would skew the shape sideways when the billboard spins or camera tilts.
    vec3 worldUpInView = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    vec2 offset = ax * (position.x * sx) + ay * (position.y * sy);
    float offsetWorldY = dot(offset, worldUpInView.xy);
    mv.xyz += worldUpInView * ((p.y - a6.z + offsetWorldY) * (a7.w - 1.0));
  }
  gl_Position = projectionMatrix * mv;
  vec4 col = mix(a3, a4, t);
  float fade = a7.z > 0.0 ? clamp(age / a7.z, 0.0, 1.0) : 1.0;
  float flick = 1.0 - a7.x * (0.5 + 0.5 * sin(age * 41.0 + a6.w * 97.0) * sin(age * 27.0 + a6.w * 13.0));
  col.a *= fade * flick * energy;
  vColor = col;
  vUv = position.xy;
  vShape = a5.x;
  vSeed = a6.w;
  vT = t;
  #ifdef USE_FOG
  vFogDepth = max(-mv.z, 0.05);
  #endif
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
varying float vShape;
varying float vSeed;
varying float vT;
varying float vShade;
uniform float uLight;
#include <fog_pars_fragment>
${NOISE_GLSL}

// Inigo Quilez, 2D SDF of a five-point star (points up).
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-0.809016994375, -0.587785252292);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

void main() {
  float r = length(vUv);
  float m;
  if (vShape < 0.5) {
    m = (exp(-r * r * 6.0) + 0.3 * exp(-r * r * 2.0)) * (1.0 - smoothstep(0.7, 1.0, r));
  } else if (vShape < 1.5) {
    float across = exp(-vUv.y * vUv.y * 7.0) * (1.0 - smoothstep(0.6, 1.0, abs(vUv.y)));
    float along = smoothstep(-1.0, 0.2, vUv.x) * (1.0 - smoothstep(0.7, 1.0, vUv.x));
    m = across * along;
  } else if (vShape < 2.5) {
    float d = sdStar5(vUv, 0.92, 0.45);
    m = 1.0 - smoothstep(-0.04, 0.04, d);
    m += 0.45 * exp(-max(d, 0.0) * 9.0) * (1.0 - smoothstep(0.8, 1.0, r));
  } else if (vShape < 3.5) {
    float x = (r - 0.72) / 0.12;
    m = exp(-x * x) * (1.0 - smoothstep(0.9, 1.0, r));
  } else if (vShape < 4.5) {
    vec2 a = abs(vUv);
    m = 1.0 - smoothstep(0.8, 0.92, max(a.x, a.y));
  } else if (vShape < 5.5) {
    float n = fxNoise(vUv * 2.3 + vSeed * 37.0 + vT * 0.9) * 0.65 + fxNoise(vUv * 5.1 - vSeed * 19.0) * 0.35;
    m = smoothstep(1.0, 0.15, r + (n - 0.5) * 0.75);
    m *= m;
  } else if (vShape < 6.5) {
    float w = 0.42 * (1.0 - abs(vUv.x)) * (1.0 + 0.45 * vUv.x);
    m = 1.0 - smoothstep(w * 0.7, w, abs(vUv.y));
    m *= 0.75 + 0.6 * smoothstep(0.75, 1.0, sin(vUv.x * 3.0 - vUv.y * 2.0 + vT * 16.0 + vSeed * 20.0));
  } else if (vShape < 7.5) {
    vec2 a = abs(vUv);
    float box = 1.0 - step(0.92, max(a.x, a.y));
    m = box * (0.55 + 0.45 * step(0.5, fract(vUv.y * 3.0 + vSeed * 5.0 + vT * 7.0)));
  }
  // Fire is a billowing, opaque/emissive volume, not stacked additive white disks.
  vec3 fireColor = vec3(0.0);
  if (vShape > 7.5) {
    vec2 flow = vUv * 3.0 + vec2(vSeed * 41.0, -vT * 2.8);
    float n = fxNoise(flow) * .65 + fxNoise(flow * 2.3 + vT) * .35;
    float contour = r + (n - .5) * .42;
    m = 1.0 - smoothstep(.62, 1.0, contour);
    float folds = fxNoise(flow * 1.7 - vec2(vT * 1.2, vT * 2.1));
    float heat = clamp(1.02 - contour * .65 - vT * .65 + (n - .5) * .65, 0.0, 1.0);
    fireColor = mix(vec3(.42, .025, .002), vec3(2.5, .32, .012), smoothstep(.08, .55, heat));
    fireColor = mix(fireColor, vec3(4.0, 3.0, .9), smoothstep(.48, .88, heat));
    // A soft rounded shaded rim makes overlapping lobes read as a volume.
    fireColor *= (.65 + .35 * max(0.0, 1.0 - r * r)) * mix(.22, 1.0, smoothstep(.22, .53, folds));
    m *= 1.0 - smoothstep(.5, 1.0, vT);
  }
  float alpha = vColor.a * m;
  if (alpha < 0.003) discard;
  vec3 rgb = vColor.rgb * vShade;
#ifdef ADDITIVE
  gl_FragColor = vec4(rgb * alpha, 0.0);
#else
  gl_FragColor = vec4((vShape > 7.5 ? fireColor : rgb * uLight) * alpha, alpha);
#endif
  ${FOG_FRAG_GLSL}
  ${OUTPUT_GLSL}
}
`;

export class ParticlePool {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** Spawn clock (s); the orchestrator keeps it at ctx.time. */
  now = 0;
  private readonly buf: InstanceBuffer;
  private cursor = 0;
  /** Highest slot ever written + 1: instances beyond it are never drawn. */
  private used = 0;
  private seedSeq = 0;

  constructor(capacity: number, additive: boolean, shared: SharedUniforms, renderOrder: number) {
    const geometry = quadXY();
    this.buf = new InstanceBuffer(capacity, VEC4S);
    this.buf.attach(geometry, 'a');
    // Unspawned slots must read as dead: start far in the past with zero life.
    const d = this.buf.data;
    for (let i = 0; i < capacity; i++) d[i * this.buf.stride + 3] = -1e6;
    geometry.instanceCount = 0;
    const material = fxMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: shared.uTime, uViewportH: shared.uViewportH, uLight: shared.uLight },
      defines: additive ? { ADDITIVE: '' } : {},
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  emit(s: ParticleSpec): void {
    const i = this.cursor;
    const d = this.buf.data;
    let o = i * this.buf.stride;
    // Golden-ratio sequence: well spread per-particle seeds without an RNG call.
    this.seedSeq = (this.seedSeq + 0.6180339887) % 1;
    d[o++] = s.x;
    d[o++] = s.y;
    d[o++] = s.z;
    d[o++] = this.now + s.delay;
    d[o++] = s.vx;
    d[o++] = s.vy;
    d[o++] = s.vz;
    d[o++] = s.life;
    d[o++] = s.size0;
    d[o++] = s.size1;
    d[o++] = s.gravity;
    d[o++] = s.drag;
    d[o++] = s.r0;
    d[o++] = s.g0;
    d[o++] = s.b0;
    d[o++] = s.a0;
    d[o++] = s.r1;
    d[o++] = s.g1;
    d[o++] = s.b1;
    d[o++] = s.a1;
    d[o++] = s.shape;
    d[o++] = s.spin;
    d[o++] = s.rot;
    d[o++] = s.streak;
    d[o++] = s.motion;
    d[o++] = s.theta;
    d[o++] = s.shape === Shape.Fireball ? s.groundY : s.shrink;
    d[o++] = this.seedSeq;
    d[o++] = s.flicker;
    d[o++] = s.flutter;
    d[o++] = s.fadeIn;
    d[o] = s.shape === Shape.Fireball ? s.verticalScale : 0;
    this.buf.mark(i, i + 1);
    this.cursor = i + 1 === this.buf.capacity ? 0 : i + 1;
    if (i + 1 > this.used) this.used = i + 1;
  }

  /** Queue this frame's spawns for upload and size the draw. */
  flush(): void {
    this.buf.flush();
    this.mesh.geometry.instanceCount = this.used;
    this.mesh.visible = this.used > 0;
  }

  /** Empty a dedicated pool on reset/expiry without allocating new GPU resources. */
  clear(): void {
    const d = this.buf.data;
    for (let i = 0; i < this.used; i++) {
      d[i * this.buf.stride + 3] = -1e6;
      d[i * this.buf.stride + 7] = 0;
    }
    this.buf.mark(0, this.used);
    this.cursor = this.used = this.seedSeq = 0;
    this.mesh.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
