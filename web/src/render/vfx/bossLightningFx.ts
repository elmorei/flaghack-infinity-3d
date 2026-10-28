/** Persistent, snapshot-driven defensive arcs. This renderer never executes simulation. */
import * as THREE from 'three';
import type { BossLightning } from '../../sim/boss';
import type { World } from '../../sim/world';
import { FOG_FRAG_GLSL, OUTPUT_GLSL, fxMaterial } from './glsl';
import { lightningSourceColor, setLightningPalette } from './lightningPalette';

const MAIN = 25, BRANCH = 8, POINTS = MAIN + BRANCH * 2;
const JITTER_HZ = 28;
const VERT = /* glsl */ `
attribute vec3 aNext;
attribute vec2 aStrip;
varying float vSide;
#include <fog_pars_vertex>
void main() {
  vec4 p = viewMatrix * vec4(position, 1.0);
  vec3 q = (viewMatrix * vec4(aNext, 1.0)).xyz;
  vec3 tangent = normalize(q - p.xyz + vec3(0.000001));
  vec3 side = cross(tangent, normalize(-p.xyz + vec3(0.000001)));
  side = length(side) > 0.00001 ? normalize(side) : vec3(0.0, 1.0, 0.0);
  p.xyz += side * aStrip.x * aStrip.y;
  gl_Position = projectionMatrix * p;
  vSide = aStrip.x;
  #ifdef USE_FOG
  vFogDepth = -p.z;
  #endif
}`;
const FRAG = /* glsl */ `
uniform float uFlicker;
uniform vec3 uCore;
uniform vec3 uGlow;
varying float vSide;
#include <fog_pars_fragment>
void main() {
  float s = abs(vSide);
  vec3 core = uCore * exp(-s * s * 45.0) * 3.0;
  vec3 glow = uGlow * exp(-s * s * 3.5) * .55;
  gl_FragColor = vec4((core + glow) * uFlicker, 0.0);
  ${FOG_FRAG_GLSL}
  ${OUTPUT_GLSL}
}`;
function noise(seed: number, point: number, sample: number): number {
  let n = Math.imul(seed ^ Math.imul(point + 1, 19349663), 73856093) ^ Math.imul(sample, 83492791);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000 * 2 - 1;
}

class Arc {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly path = new Float32Array(POINTS * 3);
  private readonly position = new THREE.BufferAttribute(new Float32Array(POINTS * 6), 3).setUsage(THREE.DynamicDrawUsage);
  private readonly next = new THREE.BufferAttribute(new Float32Array(POINTS * 6), 3).setUsage(THREE.DynamicDrawUsage);
  seen = 0;
  constructor(readonly id: number, order: number) {
    const geometry = new THREE.BufferGeometry(), strips = new Float32Array(POINTS * 4), indices: number[] = [];
    for (const [first, count, branch] of [[0, MAIN, 0], [MAIN, BRANCH, 1], [MAIN + BRANCH, BRANCH, 1]]) {
      for (let i = 0; i < count; i++) {
        const width = branch ? .38 * (1 - .8 * i / (count - 1)) : .75;
        const p = first + i; strips.set([-1, width, 1, width], p * 4);
        if (i < count - 1) indices.push(p * 2, p * 2 + 1, p * 2 + 2, p * 2 + 1, p * 2 + 3, p * 2 + 2);
      }
    }
    geometry.setAttribute('position', this.position); geometry.setAttribute('aNext', this.next);
    geometry.setAttribute('aStrip', new THREE.BufferAttribute(strips, 2)); geometry.setIndex(indices);
    const material = fxMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { uFlicker: { value: 1 }, uCore: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() } }, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geometry, material); this.mesh.name = `boss-defensive-lightning-${id}`;
    this.mesh.frustumCulled = false; this.mesh.renderOrder = order;
  }
  update(link: BossLightning, sample: number, _groundY: (x: number, z: number) => number): void {
    const f = link.from, t = link.to, fy = f.y, ty = t.y; // Authoritative absolute endpoints.
    const dx = t.x - f.x, dy = ty - fy, dz = t.z - f.z, length = Math.max(.001, Math.hypot(dx, dy, dz));
    const horizontal = Math.hypot(dx, dz), ux = horizontal > .001 ? -dz / horizontal : 1, uz = horizontal > .001 ? dx / horizontal : 0;
    const wx = dy / length * uz, wy = dz / length * ux - dx / length * uz, wz = -dy / length * ux;
    const amplitude = Math.min(3.5, length * .1) + .25, path = this.path;
    for (let i = 0; i < MAIN; i++) {
      const s = i / (MAIN - 1), envelope = i === 0 || i === MAIN - 1 ? 0 : Math.sin(Math.PI * s);
      const u = noise(this.id, i, sample) * amplitude * envelope, v = noise(this.id + 97, i, sample) * amplitude * envelope;
      path[i * 3] = f.x + dx * s + ux * u + wx * v;
      path[i * 3 + 1] = fy + dy * s + wy * v;
      path[i * 3 + 2] = f.z + dz * s + uz * u + wz * v;
    }
    for (let branch = 0; branch < 2; branch++) {
      const anchor = branch ? 15 : 7, direction = branch ? -1 : 1, span = Math.min(8, length * .2), first = MAIN + branch * BRANCH;
      for (let i = 0; i < BRANCH; i++) {
        const s = i / (BRANCH - 1), jitter = noise(this.id + branch * 193, i + MAIN, sample) * s;
        path[(first + i) * 3] = path[anchor * 3] + (dx / length * .45 + ux * direction) * span * s + wx * jitter;
        path[(first + i) * 3 + 1] = path[anchor * 3 + 1] + (dy / length * .45 - .25) * span * s + wy * jitter;
        path[(first + i) * 3 + 2] = path[anchor * 3 + 2] + (dz / length * .45 + uz * direction) * span * s + wz * jitter;
      }
    }
    this.writeStrip(0, MAIN); this.writeStrip(MAIN, BRANCH); this.writeStrip(MAIN + BRANCH, BRANCH);
    this.position.needsUpdate = true; this.next.needsUpdate = true;
    this.mesh.material.uniforms.uFlicker.value = .78 + .2 * noise(this.id, 97, sample);
  }
  private writeStrip(first: number, count: number): void {
    const out = this.position.array, next = this.next.array, p = this.path;
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) {
      const source = (first + i) * 3 + k, target = (first + i) * 6 + k;
      out[target] = out[target + 3] = p[source];
      next[target] = next[target + 3] = i < count - 1 ? p[source + 3] : p[source] * 2 - p[source - 3];
    }
  }
  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

export class BossLightningFx {
  readonly group = new THREE.Group();
  private readonly arcs = new Map<number, Arc>();
  private frame = 0;
  constructor(private readonly renderOrder = 16) { this.group.name = 'boss-defensive-lightning'; }
  update(world: World, now: number, groundY: (x: number, z: number) => number): void {
    const boss = world.boss, frame = ++this.frame;
    if (world.phase === 'playing' && boss && boss.hp > 0) {
      const sample = Math.floor(now * JITTER_HZ);
      for (const link of boss.lightning) {
        let arc = this.arcs.get(link.id);
        if (!arc) { arc = new Arc(link.id, this.renderOrder); this.arcs.set(link.id, arc); this.group.add(arc.mesh); }
        setLightningPalette(arc.mesh.material.uniforms.uCore.value, arc.mesh.material.uniforms.uGlow.value, lightningSourceColor(world, link));
        arc.seen = frame; arc.update(link, sample, groundY);
      }
    }
    for (const [id, arc] of this.arcs) if (arc.seen !== frame) { arc.dispose(); this.arcs.delete(id); }
    this.group.visible = this.arcs.size > 0;
  }
  dispose(): void { for (const arc of this.arcs.values()) arc.dispose(); this.arcs.clear(); this.group.removeFromParent(); }
}
