/**
 * Crystals (world.crystals): tall translucent pentagonal prisms in the 2017 pink/blue,
 * tinted toward the owner, rising with crystal.growth; five glass shards orbit each one, a
 * light pillar climbs into the sky and a glow pool sits at the base. When a Crystal goes
 * (crystalShatter, or it vanishes from the world) its view lingers ~1.2 s: the prism cracks
 * white, swells and fades while the shards fly out and fall.
 */
import * as THREE from 'three';
import { CRYSTAL_HEIGHT } from '../../sim/constants';
import type { GameEvent } from '../../sim/events';
import type { Crystal } from '../../sim/types';
import type { World } from '../../sim/world';
import { BEAM } from './beams';
import type { BeamLayer } from './beams';
import { DECAL } from './decals';
import type { DecalLayer } from './decals';
import { GLSL_COMMON, GLSL_FRAG, GLSL_VERT, GLSL_OUTPUT, surveyMaterial } from './glsl';
import type { SurveyUniforms } from './glsl';
import { InstanceSet } from './instances';

const CAPACITY = 32;
const SHARDS = 5;
const SHATTER_TIME = 1.2;
const PRISM_H = CRYSTAL_HEIGHT;
const PRISM_R = 1.05;
const PINK = new THREE.Color(1.0, 0.38, 0.86);
const BLUE = new THREE.Color(0.3, 0.62, 1.0);

const PRISM_VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aFace;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iColor;
varying vec3 vN;
varying vec3 vWorld;
varying vec2 vFace;
flat varying vec4 vB;
flat varying vec4 vColor;

void main() {
  float grow = iB.y;
  float shatter = iB.z;
  float h = iA.z * (0.12 + 0.88 * grow) * (1.0 + shatter * 0.12);
  float rad = iA.w * (0.55 + 0.45 * grow) * (1.0 + shatter * 0.4);
  float rot = iB.x + uTime * 0.12;
  float cs = cos(rot);
  float sn = sin(rot);
  vec3 p = position;
  p.xz *= rad;
  p.y *= h;
  p.xz = vec2(p.x * cs - p.z * sn, p.x * sn + p.z * cs);
  vec3 n = normal;
  n.xz = vec2(n.x * cs - n.z * sn, n.x * sn + n.z * cs);
  vec3 wp = vec3(iA.x, 0.0, iA.y) + p;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vN = n;
  vWorld = wp;
  vFace = aFace;
  vB = iB;
  vColor = iColor;
}
`;

const PRISM_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec3 vN;
varying vec3 vWorld;
varying vec2 vFace;
flat varying vec4 vB;
flat varying vec4 vColor;

void main() {
  float shatter = vB.z;
  float seed = vB.w;
  vec3 N = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  float h = vFace.y;
  vec3 base = mix(vec3(0.3, 0.62, 1.0), vec3(1.0, 0.38, 0.86), smoothstep(0.05, 0.95, h));
  base = mix(base, vColor.rgb, vColor.a);
  float bands = pow(0.5 + 0.5 * sin(h * 16.0 - uTime * 2.5 + seed * 6.0), 6.0);
  float edge = exp(-min(vFace.x, 1.0 - vFace.x) * 22.0);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), 48.0) * (0.3 + 0.7 * uDaylight);
  float inner = 0.55 + 0.45 * fhNoise(vec2(vFace.x * 3.0 + seed * 10.0, h * 6.0 - uTime * 0.6));
  // No night boost on top of the exposure lift; dimmer up close, where a prism fills the frame.
  float night = uGlow.w * mix(0.45, 1.0, smoothstep(3.0, 22.0, length(cameraPosition - vWorld)));
  vec3 c = base * (0.5 * inner + bands * 0.9 + fres * 1.5 + edge * 1.5) * night + vec3(1.0) * spec * 1.6;
  float a = 0.36 + fres * 0.45 + edge * 0.3;
  if (!gl_FrontFacing) {
    c *= 0.5;
    a *= 0.6;
  }
  float cracks = pow(1.0 - abs(fhNoise(vec2(vFace.x * 7.0, h * 9.0) + seed * 13.0) * 2.0 - 1.0), 18.0);
  c += vec3(1.0, 0.95, 1.0) * cracks * shatter * 6.0;
  c += vec3(1.0) * (1.0 - smoothstep(0.0, 0.25, shatter)) * step(0.001, shatter) * 1.5;
  a *= 1.0 - smoothstep(0.35, 1.0, shatter);
  a *= fhFogKeep();
  gl_FragColor = vec4(c * a, a * 0.5);
  ${GLSL_OUTPUT}
}
`;

const SHARD_VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iColor;
varying vec3 vN;
varying vec3 vWorld;
flat varying vec4 vColor;
flat varying float vShatter;

void main() {
  float phase = iB.x;
  float speed = iB.y;
  float scale = iB.z;
  float shatter = iB.w;
  float ang = phase + uTime * speed;
  float rad = iA.z * (1.0 + shatter * 6.0);
  float y = iA.w + sin(uTime * 1.3 + phase * 3.0) * 0.35 + shatter * 3.0 - shatter * shatter * 7.0;
  vec3 c = vec3(iA.x + cos(ang) * rad, y, iA.y + sin(ang) * rad);
  float s = scale * (1.0 - shatter * 0.6);
  // Spin about a tilted axis: yaw then pitch.
  float a1 = uTime * 1.7 + phase * 5.0;
  float a2 = 0.6 + uTime * 0.9 + phase;
  vec3 p = position * vec3(s * 0.6, s * 1.4, s * 0.6);
  vec3 n = normal;
  float c1 = cos(a1);
  float s1 = sin(a1);
  float c2 = cos(a2);
  float s2 = sin(a2);
  p.xz = vec2(p.x * c1 - p.z * s1, p.x * s1 + p.z * c1);
  n.xz = vec2(n.x * c1 - n.z * s1, n.x * s1 + n.z * c1);
  p.xy = vec2(p.x * c2 - p.y * s2, p.x * s2 + p.y * c2);
  n.xy = vec2(n.x * c2 - n.y * s2, n.x * s2 + n.y * c2);
  vec3 wp = c + p;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vN = n;
  vWorld = wp;
  vColor = iColor;
  vShatter = shatter;
}
`;

const SHARD_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec3 vN;
varying vec3 vWorld;
flat varying vec4 vColor;
flat varying float vShatter;

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  float facet = 0.5 + 0.5 * dot(N, normalize(vec3(0.3, 1.0, 0.2)));
  float night = uGlow.w;
  vec3 c = vColor.rgb * (0.6 + facet * 0.8 + fres * 1.6) * night;
  float a = (0.55 + fres * 0.4) * vColor.a * (1.0 - smoothstep(0.5, 1.0, vShatter)) * fhFogKeep();
  gl_FragColor = vec4(c * a, a * 0.45);
  ${GLSL_OUTPUT}
}
`;

/** Pentagonal prism with a pyramid cap; aFace = (across-face 0..1, height 0..1). */
function prismGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const face: number[] = [];
  const shoulder = 0.8;
  const top = 0.86;
  const ring = (i: number, r: number): [number, number] => {
    const a = (i / 5) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  for (let i = 0; i < 5; i++) {
    const [x0, z0] = ring(i, 1);
    const [x1, z1] = ring(i + 1, 1);
    const [tx0, tz0] = ring(i, top);
    const [tx1, tz1] = ring(i + 1, top);
    // Side quad (two triangles), bottom slightly below ground.
    pos.push(x0, -0.03, z0, x1, -0.03, z1, tx1, shoulder, tz1, x0, -0.03, z0, tx1, shoulder, tz1, tx0, shoulder, tz0);
    face.push(0, 0, 1, 0, 1, shoulder, 0, 0, 1, shoulder, 0, shoulder);
    // Cap triangle to the apex.
    pos.push(tx0, shoulder, tz0, tx1, shoulder, tz1, 0, 1, 0);
    face.push(0, shoulder, 1, shoulder, 0.5, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 2));
  g.computeVertexNormals();
  return g;
}

function instanced(base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  if (base.index) g.index = base.index;
  for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.getAttribute(name));
  return g;
}

interface CrystalView {
  id: number;
  x: number;
  z: number;
  faction: number;
  seed: number;
  growth: number;
  /** Presentation time the shatter began, or -1 while alive. */
  shatterAt: number;
  /** Presentation time of the manifest flash. */
  flashAt: number;
  stamp: number;
}

export class CrystalLayer {
  private readonly scene: THREE.Scene;
  private readonly world: World;
  private readonly prisms: InstanceSet;
  private readonly shards: InstanceSet;
  private readonly prismMesh: THREE.Mesh;
  private readonly shardMesh: THREE.Mesh;
  private readonly prismMat: THREE.ShaderMaterial;
  private readonly shardMat: THREE.ShaderMaterial;
  private readonly prismBase: THREE.BufferGeometry;
  private readonly shardBase: THREE.BufferGeometry;
  private readonly pA: Float32Array;
  private readonly pB: Float32Array;
  private readonly pColor: Float32Array;
  private readonly sA: Float32Array;
  private readonly sB: Float32Array;
  private readonly sColor: Float32Array;
  private readonly views = new Map<number, CrystalView>();
  private readonly pool: CrystalView[] = [];
  private readonly live: CrystalView[] = [];
  private stamp = 0;
  private now = 0;
  private readonly tint = new THREE.Color();
  private readonly glow = new THREE.Color();
  private readonly syncCrystal = (c: Crystal): void => {
    let v = this.views.get(c.id);
    if (!v) {
      v = this.pool.pop() ?? { id: 0, x: 0, z: 0, faction: 0, seed: 0, growth: 0, shatterAt: -1, flashAt: -1e4, stamp: 0 };
      v.id = c.id;
      v.seed = ((c.id * 0.618034) % 1 + 1) % 1;
      v.shatterAt = -1;
      v.flashAt = -1e4;
      this.views.set(c.id, v);
      this.live.push(v);
    }
    v.x = c.pos.x;
    v.z = c.pos.z;
    v.faction = c.faction;
    v.growth = c.growth;
    v.stamp = this.stamp;
  };

  constructor(scene: THREE.Scene, world: World, shared: SurveyUniforms) {
    this.scene = scene;
    this.world = world;
    this.prismBase = prismGeometry();
    this.prisms = new InstanceSet(instanced(this.prismBase), CAPACITY);
    this.pA = this.prisms.add('iA', 4);
    this.pB = this.prisms.add('iB', 4);
    this.pColor = this.prisms.add('iColor', 4);
    this.prismMat = surveyMaterial(shared, { vertexShader: PRISM_VERT, fragmentShader: PRISM_FRAG, side: THREE.DoubleSide, hdrCap: 2.5 });
    this.prismMesh = new THREE.Mesh(this.prisms.geo, this.prismMat);
    this.prismMesh.frustumCulled = false;
    this.prismMesh.renderOrder = 8;

    // Detail-0 polyhedra are already non-indexed with flat normals.
    this.shardBase = new THREE.OctahedronGeometry(0.5, 0);
    this.shards = new InstanceSet(instanced(this.shardBase), CAPACITY * SHARDS);
    this.sA = this.shards.add('iA', 4);
    this.sB = this.shards.add('iB', 4);
    this.sColor = this.shards.add('iColor', 4);
    this.shardMat = surveyMaterial(shared, { vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG });
    this.shardMesh = new THREE.Mesh(this.shards.geo, this.shardMat);
    this.shardMesh.frustumCulled = false;
    this.shardMesh.renderOrder = 8;
    scene.add(this.prismMesh, this.shardMesh);
    world.crystals.forEach(this.syncCrystal);
  }

  onEvent(e: GameEvent, now: number): void {
    if (e.t === 'crystalManifest') {
      const c = this.world.crystals.get(e.crystalId);
      if (c) this.syncCrystal(c);
      const v = this.views.get(e.crystalId);
      if (v) v.flashAt = now;
    } else if (e.t === 'crystalShatter') {
      const v = this.views.get(e.crystalId);
      if (v && v.shatterAt < 0) v.shatterAt = now;
    }
  }

  update(now: number, decals: DecalLayer, beams: BeamLayer): void {
    this.now = now;
    this.stamp++;
    this.world.crystals.forEach(this.syncCrystal);
    let np = 0;
    let ns = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const v = this.live[i];
      if (v.stamp !== this.stamp && v.shatterAt < 0) v.shatterAt = now;
      const shatter = v.shatterAt < 0 ? 0 : (now - v.shatterAt) / SHATTER_TIME;
      if (shatter >= 1) {
        this.views.delete(v.id);
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        this.pool.push(v);
        continue;
      }
      if (np >= CAPACITY) continue;
      const fc = this.world.factions[v.faction];
      this.tint.setHex(fc ? fc.color : 0xffffff);
      const grow = v.shatterAt < 0 ? v.growth : 1;
      const eased = 1 - Math.pow(1 - Math.min(1, grow), 3);
      let o = np * 4;
      this.pA[o] = v.x;
      this.pA[o + 1] = v.z;
      this.pA[o + 2] = PRISM_H;
      this.pA[o + 3] = PRISM_R;
      this.pB[o] = v.seed * 6.283;
      this.pB[o + 1] = eased;
      this.pB[o + 2] = shatter;
      this.pB[o + 3] = v.seed;
      this.pColor[o] = this.tint.r;
      this.pColor[o + 1] = this.tint.g;
      this.pColor[o + 2] = this.tint.b;
      this.pColor[o + 3] = 0.32;
      np++;
      for (let k = 0; k < SHARDS; k++) {
        o = ns * 4;
        this.sA[o] = v.x;
        this.sA[o + 1] = v.z;
        this.sA[o + 2] = 2.0 + 0.35 * k;
        this.sA[o + 3] = 1.6 + (PRISM_H - 2.4) * eased * ((k + 0.5) / SHARDS);
        this.sB[o] = v.seed * 20 + (k * Math.PI * 2) / SHARDS;
        this.sB[o + 1] = (k % 2 === 0 ? 0.55 : -0.42) * (1 + v.seed * 0.3);
        this.sB[o + 2] = 0.38 * eased;
        this.sB[o + 3] = shatter;
        this.glow.copy(k % 2 === 0 ? PINK : BLUE).lerp(this.tint, 0.25);
        this.sColor[o] = this.glow.r;
        this.sColor[o + 1] = this.glow.g;
        this.sColor[o + 2] = this.glow.b;
        this.sColor[o + 3] = 1;
        ns++;
      }
      const fade = 1 - shatter;
      const flash = Math.max(0, 1 - (now - v.flashAt) / 1.4);
      this.glow.copy(BLUE).lerp(PINK, 0.5).lerp(this.tint, 0.3);
      beams.push(BEAM.pillar, v.x, 0, v.z, v.x, 46 * (0.3 + 0.7 * eased), v.z, 2.4 + flash * 3, this.glow, (0.3 + flash * 1.2) * eased * fade, 6, v.seed * 10);
      decals.push(DECAL.halo, v.x, v.z, 3.6 + flash * 4, 0, this.glow, (0.75 + flash) * fade * (0.4 + 0.6 * eased), 0.75, 0.6, 0.7, v.seed);
    }
    this.prisms.commit(np);
    this.shards.commit(ns);
  }

  dispose(): void {
    this.scene.remove(this.prismMesh, this.shardMesh);
    this.prisms.geo.dispose();
    this.shards.geo.dispose();
    this.prismBase.dispose();
    this.shardBase.dispose();
    this.prismMat.dispose();
    this.shardMat.dispose();
  }
}
