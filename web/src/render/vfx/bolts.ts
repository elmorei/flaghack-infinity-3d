/**
 * Crystal discharge lightning: a fixed pool of bolts in one geometry. Each bolt is a main
 * channel plus two short branches, regenerated (~28 Hz) with smoothed midpoint jitter while
 * it flickers out. The CPU only rewrites path points on re-strikes; the vertex shader
 * expands every point sideways perpendicular to both the path and the view ray, so the
 * ribbon always faces the camera. The fragment shader draws a white-hot core inside a
 * wide electric glow.
 */
import * as THREE from 'three';
import { COLLAPSE_GLSL, FOG_FRAG_GLSL, OUTPUT_GLSL, fxMaterial } from './glsl';
import type { Prng } from './prng';
import { setLightningPalette, type LightningSource } from './lightningPalette';

const BOLTS = 8;
const MAIN = 22;
const BRANCH = 9;
const BRANCHES = 2;
const POINTS = MAIN + BRANCH * BRANCHES;
const VERTS = POINTS * 2;
const LIFE = 0.36;
const JITTER_INTERVAL = 1 / 28;
const MAIN_WIDTH = 1.0;
const BRANCH_WIDTH = 0.55;

const VERT = /* glsl */ `
uniform float uAlpha[${BOLTS}];
uniform vec3 uCore[${BOLTS}];
uniform vec3 uGlow[${BOLTS}];
attribute vec3 aNext;
attribute vec4 aInfo; // side, half width, bolt index, along
varying float vSide;
varying float vAlpha;
varying vec3 vCore;
varying vec3 vGlow;
#include <fog_pars_vertex>

void main() {
  float alpha = uAlpha[int(aInfo.z + 0.5)];
  if (alpha <= 0.0) { ${COLLAPSE_GLSL} }
  vec4 v0 = viewMatrix * vec4(position, 1.0);
  vec3 v1 = (viewMatrix * vec4(aNext, 1.0)).xyz;
  vec3 tdir = v1 - v0.xyz;
  float tl = length(tdir);
  tdir = tl > 0.0001 ? tdir / tl : vec3(1.0, 0.0, 0.0);
  vec3 view = -v0.xyz;
  float vl = length(view);
  vec3 side = cross(tdir, vl > 0.0001 ? view / vl : vec3(0.0, 0.0, 1.0));
  float sl = length(side);
  side = sl > 0.0001 ? side / sl : vec3(0.0, 1.0, 0.0);
  v0.xyz += side * aInfo.x * aInfo.y;
  gl_Position = projectionMatrix * v0;
  vSide = aInfo.x;
  vAlpha = alpha;
  vCore = uCore[int(aInfo.z + 0.5)];
  vGlow = uGlow[int(aInfo.z + 0.5)];
  #ifdef USE_FOG
  vFogDepth = -v0.z;
  #endif
}
`;

const FRAG = /* glsl */ `
varying float vSide;
varying float vAlpha;
varying vec3 vCore;
varying vec3 vGlow;
#include <fog_pars_fragment>

void main() {
  float s = abs(vSide);
  float core = exp(-s * s * 45.0);
  float glow = exp(-s * s * 3.5) * 0.55;
  gl_FragColor = vec4((vCore * core * 3.0 + vGlow * glow) * vAlpha, 0.0);
  ${FOG_FRAG_GLSL}
  ${OUTPUT_GLSL}
}
`;

interface Bolt {
  active: boolean;
  source?: LightningSource;
  born: number;
  nextStrike: number;
  strike: number;
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
}

export class Bolts {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly bolts: Bolt[] = [];
  private readonly alpha = new Float32Array(BOLTS);
  private readonly core = Array.from({ length: BOLTS }, () => new THREE.Color());
  private readonly glow = Array.from({ length: BOLTS }, () => new THREE.Color());
  private readonly pos: THREE.BufferAttribute;
  private readonly next: THREE.BufferAttribute;
  /** Scratch path points (x, y, z per point) for one bolt. */
  private readonly pts = new Float32Array(POINTS * 3);
  private readonly noiseU = new Float32Array(MAIN);
  private readonly noiseW = new Float32Array(MAIN);
  private readonly rng: Prng;

  constructor(rng: Prng, renderOrder: number, private readonly sourceColor?: (source: LightningSource) => number) {
    this.rng = rng;
    for (let i = 0; i < BOLTS; i++) {
      setLightningPalette(this.core[i], this.glow[i]);
      this.bolts.push({ active: false, born: 0, nextStrike: 0, strike: 1, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0 });
    }
    const geometry = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(BOLTS * VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.next = new THREE.BufferAttribute(new Float32Array(BOLTS * VERTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const info = new Float32Array(BOLTS * VERTS * 4);
    const index: number[] = [];
    for (let b = 0; b < BOLTS; b++) {
      const base = b * VERTS;
      this.stripInfo(info, base, 0, MAIN, MAIN_WIDTH, b, false, index);
      for (let k = 0; k < BRANCHES; k++) this.stripInfo(info, base, MAIN + k * BRANCH, BRANCH, BRANCH_WIDTH, b, true, index);
    }
    geometry.setAttribute('position', this.pos);
    geometry.setAttribute('aNext', this.next);
    geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    geometry.setIndex(index);
    const material = fxMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uAlpha: { value: this.alpha },
        uCore: { value: this.core },
        uGlow: { value: this.glow },
      },
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'crystal-protection-lightning';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  /** Static per-vertex data and triangle indices for one strip of `n` points. */
  private stripInfo(info: Float32Array, base: number, first: number, n: number, width: number, bolt: number, taper: boolean, index: number[]): void {
    for (let j = 0; j < n; j++) {
      const along = j / (n - 1);
      const w = taper ? width * (1 - along * 0.75) : width * (1 - along * 0.25);
      const v = base + (first + j) * 2;
      info.set([-1, w, bolt, along, 1, w, bolt, along], v * 4);
      if (j < n - 1) index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }

  strike(now: number, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, source?: LightningSource): void {
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < BOLTS; i++) {
      const b = this.bolts[i];
      if (!b.active) {
        slot = i;
        break;
      }
      if (b.born < oldest) {
        oldest = b.born;
        slot = i;
      }
    }
    const b = this.bolts[slot];
    b.active = true;
    b.source = source;
    // Every pooled slot resets its palette, including ownerless instability discharges.
    setLightningPalette(this.core[slot], this.glow[slot], source && this.sourceColor?.(source));
    b.born = now;
    b.nextStrike = now;
    b.fx = fx;
    b.fy = fy;
    b.fz = fz;
    b.tx = tx;
    b.ty = ty;
    b.tz = tz;
  }

  update(now: number): void {
    let any = false;
    let dirty = false;
    for (let i = 0; i < BOLTS; i++) {
      const b = this.bolts[i];
      if (!b.active) {
        this.alpha[i] = 0;
        continue;
      }
      const t = (now - b.born) / LIFE;
      if (t >= 1) {
        b.active = false;
        b.source = undefined;
        this.alpha[i] = 0;
        continue;
      }
      if (b.source) setLightningPalette(this.core[i], this.glow[i], this.sourceColor?.(b.source));
      if (now >= b.nextStrike) {
        this.build(i, b);
        b.nextStrike = now + JITTER_INTERVAL;
        b.strike = this.rng.range(0.55, 1);
        dirty = true;
      }
      this.alpha[i] = (1 - t * t) * b.strike;
      any = true;
    }
    if (dirty) {
      this.pos.needsUpdate = true;
      this.next.needsUpdate = true;
    }
    this.mesh.visible = any;
  }

  /** Regenerate bolt `index`'s jagged path and write it into the vertex buffers. */
  private build(index: number, b: Bolt): void {
    const rng = this.rng;
    const pts = this.pts;
    const dx = b.tx - b.fx;
    const dy = b.ty - b.fy;
    const dz = b.tz - b.fz;
    const len = Math.max(Math.hypot(dx, dy, dz), 0.001);
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    // u ⟂ path and ⟂ up (falls back to x for vertical bolts), w = n × u.
    let ux = -nz;
    let uz = nx;
    let ul = Math.hypot(ux, uz);
    if (ul < 0.05) {
      ux = 1;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const wx = ny * uz;
    const wy = nz * ux - nx * uz;
    const wz = -ny * ux;
    const amp = Math.min(len * 0.11, 3.5) + 0.25;
    for (let i = 0; i < MAIN; i++) {
      this.noiseU[i] = rng.signed();
      this.noiseW[i] = rng.signed();
    }
    for (let i = 0; i < MAIN; i++) {
      const s = i / (MAIN - 1);
      const env = Math.sin(Math.PI * s);
      const prev = i > 0 ? i - 1 : 0;
      const nxt = i < MAIN - 1 ? i + 1 : MAIN - 1;
      // Low-frequency wander plus a little raw jag.
      const ou = ((this.noiseU[prev] + 2 * this.noiseU[i] + this.noiseU[nxt]) * 0.25 * 0.75 + this.noiseU[i] * 0.25) * amp * env;
      const ow = ((this.noiseW[prev] + 2 * this.noiseW[i] + this.noiseW[nxt]) * 0.25 * 0.75 + this.noiseW[i] * 0.25) * amp * env;
      pts[i * 3] = b.fx + dx * s + ux * ou + wx * ow;
      pts[i * 3 + 1] = b.fy + dy * s + wy * ow;
      pts[i * 3 + 2] = b.fz + dz * s + uz * ou + wz * ow;
    }
    for (let k = 0; k < BRANCHES; k++) {
      const si = 3 + rng.int(MAIN - 8);
      let bx = nx * 0.55 + ux * rng.signed() + wx * rng.signed() * 0.7;
      let by = ny * 0.55 + wy * rng.signed() * 0.7 - 0.25;
      let bz = nz * 0.55 + uz * rng.signed() + wz * rng.signed() * 0.7;
      const bl = Math.max(Math.hypot(bx, by, bz), 0.001);
      const blen = len * rng.range(0.15, 0.3) + 1;
      bx = (bx / bl) * blen;
      by = (by / bl) * blen;
      bz = (bz / bl) * blen;
      const first = MAIN + k * BRANCH;
      for (let j = 0; j < BRANCH; j++) {
        const s = j / (BRANCH - 1);
        const jag = amp * 0.4 * s;
        pts[(first + j) * 3] = pts[si * 3] + bx * s + rng.signed() * jag;
        pts[(first + j) * 3 + 1] = pts[si * 3 + 1] + by * s + rng.signed() * jag;
        pts[(first + j) * 3 + 2] = pts[si * 3 + 2] + bz * s + rng.signed() * jag;
      }
    }
    const base = index * VERTS;
    this.writeStrip(base, 0, MAIN);
    for (let k = 0; k < BRANCHES; k++) this.writeStrip(base, MAIN + k * BRANCH, BRANCH);
  }

  private writeStrip(base: number, first: number, n: number): void {
    const pts = this.pts;
    const pos = this.pos.array;
    const next = this.next.array;
    for (let j = 0; j < n; j++) {
      const p = (first + j) * 3;
      const px = pts[p];
      const py = pts[p + 1];
      const pz = pts[p + 2];
      let qx: number;
      let qy: number;
      let qz: number;
      if (j < n - 1) {
        qx = pts[p + 3];
        qy = pts[p + 4];
        qz = pts[p + 5];
      } else {
        // Extrapolate past the last point so its side vector matches the final segment.
        qx = px * 2 - pts[p - 3];
        qy = py * 2 - pts[p - 2];
        qz = pz * 2 - pts[p - 1];
      }
      const v = (base + (first + j) * 2) * 3;
      pos[v] = pos[v + 3] = px;
      pos[v + 1] = pos[v + 4] = py;
      pos[v + 2] = pos[v + 5] = pz;
      next[v] = next[v + 3] = qx;
      next[v + 1] = next[v + 4] = qy;
      next[v + 2] = next[v + 5] = qz;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
