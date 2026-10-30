/** One deterministic explosion, reconstructed from seconds since the authoritative reveal. */
import * as THREE from 'three';
import { CRATER_SEGMENTS, CRATER_OUTER_RADIUS, craterRimVariation } from '../../../../sim/effigyCrater';
import { groundHeight } from '../../../../sim/terrain';
import { MAP_HALF } from '../../../../sim/constants';
import { groundBossGeometry } from './groundGeometry';
import { Rng } from '../../../../sim/rng';
import { BOSS_GAMEPLAY_SCALE } from '../../../../sim/bossDimensions';
import type { EnvContext } from '../../envTypes';
import { bossFlash, smooth } from './revealTimeline';
import { BOSS_AWAKENING_SECONDS, bossAwakeningLevel } from '../../../../sim/bossPresentation';

const ADDITIVE = {
  transparent: true, depthWrite: false, blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
};
const BURST_VERTEX = `varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); vNormal = normalize(normalMatrix * normal); vView = -p.xyz; vLocal = position; gl_Position = projectionMatrix * p; }`;
const BURST_FRAGMENT = `uniform float uAge; uniform float uAwakening; uniform sampler2D uNoise; varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal;
void main() {
 float facing = abs(dot(normalize(vNormal), normalize(vView)));
 float n = texture2D(uNoise, vLocal.xy * 1.6 + vec2(uAge * 0.2, -uAge * 0.45)).r;
 n = n * 0.65 + texture2D(uNoise, vLocal.yz * 3.2 + uAge * 0.25).g * 0.35;
 float edge = pow(facing, 3.5) * smoothstep(0.12, 0.66, n + facing * 0.32);
 float fade = max(pow(1.0 - smoothstep(0.0, 0.28, uAge), 2.0), uAwakening);
 vec3 c = mix(vec3(1.0), vec3(1.0, 0.36, 0.06), smoothstep(0.06, 0.25, uAge) * (1.0 - uAwakening));
 gl_FragColor = vec4(c * edge * fade * mix(3.2, 18.0, uAwakening), 1.0);
 #include <colorspace_fragment>
}`;
const SHOCK_VERTEX = `varying vec2 vXZ; void main() { vXZ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SHOCK_FRAGMENT = `uniform float uAge; varying vec2 vXZ;
void main() {
 float r = length(vXZ); float reach = 2.0 + 31.0 * pow(max(uAge, 0.0), 0.65);
 float band = exp(-pow((r - reach) / (0.3 + uAge * 0.7), 2.0));
 float fade = 1.0 - smoothstep(0.3, 1.8, uAge);
 gl_FragColor = vec4(mix(vec3(1.0), vec3(1.0, 0.35, 0.055), min(uAge, 1.0)) * band * fade * 2.2, 1.0);
 #include <colorspace_fragment>
}`;
const SMOKE_VERTEX = `attribute vec4 aSeed; uniform float uAge; uniform float uBossFxScale; varying vec2 vUv; varying float vAlpha; varying vec2 vSeed;
void main() {
 float t = max(0.0, uAge - aSeed.x * 0.45);
 float a = aSeed.y * 6.2831853;
 float r = (2.8 + t * mix(1.8, 3.4, aSeed.z)) * (0.8 + aSeed.w);
 vec3 c = vec3(cos(a) * r, 0.3 + aSeed.z * 5.0 + t * mix(1.0, 2.0, aSeed.w), sin(a) * r);
 vec4 mv = modelViewMatrix * vec4(c, 1.0);
 float size = (3.0 + t * 2.4) * mix(0.75, 1.25, aSeed.x);
 mv.xy += position.xy * size * uBossFxScale;
 gl_Position = projectionMatrix * mv;
 vUv = position.xy + 0.5; vSeed = aSeed.yz;
 vAlpha = smoothstep(0.0, 0.2, t) * (1.0 - smoothstep(0.6 + aSeed.x, 2.8 + aSeed.w * 1.2, t)) * 0.28;
}`;
const SMOKE_FRAGMENT = `uniform sampler2D uNoise; uniform float uAge; uniform vec3 uFogColor; varying vec2 vUv; varying float vAlpha; varying vec2 vSeed;
void main() {
 vec2 p = vUv - 0.5;
 float n = texture2D(uNoise, vUv * 0.7 + vSeed * 3.1).r * 0.6 + texture2D(uNoise, vUv * 1.7 + vSeed).g * 0.4;
 float d = (1.0 - smoothstep(0.15, 0.5, length(p) + (n - 0.5) * 0.24)) * (0.6 + n * 0.4);
 float a = d * vAlpha; if (a < 0.004) discard;
 vec3 ash = vec3(0.055, 0.052, 0.049) * (0.55 + 0.8 * n);
 vec3 hot = vec3(0.8, 0.17, 0.025) * exp(-uAge * 1.8) * (1.0 - vUv.y);
 gl_FragColor = vec4(ash + hot, a);
 #include <colorspace_fragment>
}`;
const EMBER_VERTEX = `attribute vec3 aVelocity; attribute float aSeed; uniform float uAge; uniform float uPointScale; uniform float uBossFxScale; varying float vHeat;
void main() {
 float t = max(0.0, uAge); vec3 p = position + aVelocity * t; p.y -= 4.8 * t * t; p.y = max(0.06, p.y);
 vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
 vHeat = (1.0 - smoothstep(1.2, 4.0 + aSeed * 2.0, t));
 gl_PointSize = clamp((0.045 + aSeed * 0.1) * uPointScale * uBossFxScale / (projectionMatrix[2][3] == -1.0 ? max(-mv.z, 0.1) : 1.0), 1.1, 14.0 * uBossFxScale);
}`;
const EMBER_FRAGMENT = `uniform float uAge; varying float vHeat; void main() {
 float a = 1.0 - smoothstep(0.0, 0.5, length(gl_PointCoord - 0.5));
 vec3 c = mix(vec3(1.0, 0.11, 0.012), vec3(1.0, 0.72, 0.22), vHeat * vHeat);
 c = mix(c, vec3(1.0), 1.0 - smoothstep(0.0, 0.25, uAge));
 gl_FragColor = vec4(c * a * vHeat * 3.0, 1.0);
 #include <colorspace_fragment>
}`;
const DEBRIS_TRANSFORM = `
attribute vec3 aOrigin; attribute vec3 aVelocity; attribute vec4 aSpin;
uniform float uAge;
mat3 debrisRotation() {
 float a = uAge * aSpin.w; float c = cos(a); float s = sin(a); vec3 k = aSpin.xyz;
 return mat3(c) + (1.0 - c) * outerProduct(k, k) + s * mat3(0.0, k.z, -k.y, -k.z, 0.0, k.x, k.y, -k.x, 0.0);
}
vec3 debrisPosition(vec3 p) {
 float land = (aVelocity.y + sqrt(aVelocity.y * aVelocity.y + 48.0 * max(aOrigin.y - 0.12, 0.0))) / 24.0;
 float t = min(max(uAge, 0.0), land);
 vec3 c = aOrigin + aVelocity * t; c.y = max(0.12, c.y - 12.0 * t * t);
 return debrisRotation() * p + c;
}`;

export function createCrater(rng: Rng): THREE.BufferGeometry {
  const radial = CRATER_SEGMENTS;
  const rings = [0, 2, 4.5, 6.2, 7.5, 8.8, CRATER_OUTER_RADIUS];
  const heights = [0.035, 0.05, 0.08, 0.17, 0.66, 0.29, 0.018];
  const p: number[] = [], c: number[] = [], indices: number[] = [];
  const irregular = craterRimVariation(rng);
  for (let j = 0; j < rings.length; j++) for (let i = 0; i <= radial; i++) {
    const angle = (i % radial) / radial * Math.PI * 2;
    const r = rings[j] * irregular[i % radial];
    const y = heights[j] * (j > 1 ? rng.range(0.7, 1.25) : 1);
    p.push(Math.cos(angle) * r, y, Math.sin(angle) * r);
    const tint = rng.range(0.6, 1.1) * (j < 3 ? 0.014 : 0.036);
    c.push(tint, tint * 0.9, tint * 0.8);
    if (j > 0 && i < radial) {
      const a = (j - 1) * (radial + 1) + i, b = j * (radial + 1) + i;
      indices.push(a, b + 1, b, a, a + 1, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

export class RevealFx {
  readonly group = new THREE.Group();
  readonly crater: THREE.Mesh;
  private burst: THREE.Mesh;
  private shock: THREE.Mesh;
  private smoke: THREE.Mesh;
  private embers: THREE.Points;
  private debris: THREE.Mesh;
  private uAge = { value: 0 };
  private uAwakening = { value: 0 };
  private uPointScale = { value: 600 };
  private size = new THREE.Vector2();
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  constructor(private env: EnvContext) {
    this.group.name = 'boss-reveal-fx'; this.group.scale.setScalar(BOSS_GAMEPLAY_SCALE);
    const rng = new Rng(`boss-reveal:${env.ctx.world.map.seed}`);
    const age = { uAge: this.uAge, uBossFxScale: { value: BOSS_GAMEPLAY_SCALE } };
    const add = <T extends THREE.Mesh | THREE.Points>(o: T, name: string, order = 0): T => {
      o.name = name; o.renderOrder = order; o.frustumCulled = false;
      this.geos.push(o.geometry); this.mats.push(o.material as THREE.Material); this.group.add(o); return o;
    };
    const craterMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const noise = env.noise;
    craterMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uRevealAge = this.uAge;
      shader.uniforms.uCraterNoise = { value: noise };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCrater;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCrater = position;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCrater; uniform float uRevealAge; uniform sampler2D uCraterNoise;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float coal = texture2D(uCraterNoise, vCrater.xz * 0.42).b;
          float cracks = pow(max(0.0, 1.0 - abs(coal - 0.3) * 28.0), 2.0);
          float hot = exp(-uRevealAge * 0.25) * (1.0 - smoothstep(5.5, 9.0, length(vCrater.xz)));
          totalEmissiveRadiance += vec3(1.0, 0.12, 0.012) * cracks * hot * 1.4;`);
    };
    craterMaterial.customProgramCacheKey = () => 'boss-crater-v1';
    this.crater = add(new THREE.Mesh(createCrater(rng), craterMaterial), 'boss-black-crater');
    this.crater.receiveShadow = true;
    const at = env.ctx.world.map.effigy, half = env.ctx.world.map.half ?? MAP_HALF;
    const ground = groundHeight(at.x, at.z, half) / BOSS_GAMEPLAY_SCALE;
    groundBossGeometry(this.crater.geometry, at, BOSS_GAMEPLAY_SCALE, half);
    this.burst = add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), new THREE.ShaderMaterial({
      // The back shell is behind the depth-writing boss from every viewing angle:
      // the explosion halo stays visible, while the model appears immediately in front.
      ...ADDITIVE, side: THREE.BackSide, uniforms: { ...age, uAwakening: this.uAwakening, uNoise: { value: env.noise } }, vertexShader: BURST_VERTEX, fragmentShader: BURST_FRAGMENT,
    })), 'boss-white-burst', 5);
    this.burst.position.y = ground + 14;
    this.shock = add(new THREE.Mesh(new THREE.RingGeometry(0, 50, 80, 24).rotateX(-Math.PI / 2).translate(0, 0.15, 0), new THREE.ShaderMaterial({
      ...ADDITIVE, uniforms: age, vertexShader: SHOCK_VERTEX, fragmentShader: SHOCK_FRAGMENT,
    })), 'boss-ground-shock', 2);
    groundBossGeometry(this.shock.geometry, at, BOSS_GAMEPLAY_SCALE, half);
    const count = env.ctx.quality === 'low' ? 24 : 42;
    const smokeGeometry = new THREE.InstancedBufferGeometry();
    smokeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0], 3));
    smokeGeometry.setIndex([0, 1, 2, 0, 2, 3]); smokeGeometry.instanceCount = count;
    smokeGeometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(Float32Array.from({ length: count * 4 }, () => rng.next()), 4));
    this.smoke = add(new THREE.Mesh(smokeGeometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { ...age, uNoise: { value: env.noise }, uFogColor: env.uniforms.uFogColor },
      vertexShader: SMOKE_VERTEX, fragmentShader: SMOKE_FRAGMENT,
    })), 'boss-explosion-smoke', 6);
    const emberCount = env.ctx.quality === 'low' ? 180 : 450;
    const positions: number[] = [], velocities: number[] = [];
    for (let i = 0; i < emberCount; i++) {
      const a = rng.next() * Math.PI * 2, r = rng.range(4, 20);
      positions.push(Math.cos(a) * 1.8, rng.range(0.5, 23), Math.sin(a) * 1.8);
      velocities.push(Math.cos(a) * r, rng.range(2, 15), Math.sin(a) * r);
    }
    const emberGeometry = new THREE.BufferGeometry();
    emberGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    emberGeometry.setAttribute('aVelocity', new THREE.Float32BufferAttribute(velocities, 3));
    emberGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(Float32Array.from({ length: emberCount }, () => rng.next()), 1));
    this.embers = add(new THREE.Points(emberGeometry, new THREE.ShaderMaterial({
      ...ADDITIVE, uniforms: { ...age, uPointScale: this.uPointScale }, vertexShader: EMBER_VERTEX, fragmentShader: EMBER_FRAGMENT,
    })), 'boss-explosion-embers', 7);
    const debrisPositions: number[] = [], normals: number[] = [], origins: number[] = [], speeds: number[] = [], spins: number[] = [];
    for (let i = 0; i < 88; i++) {
      const geo = new THREE.BoxGeometry(rng.range(0.09, 0.26), rng.range(0.35, 1.7), rng.range(0.07, 0.2)).toNonIndexed();
      const a = rng.next() * Math.PI * 2, r = rng.range(3.5, 10);
      const origin = [Math.cos(a) * 1.8, rng.range(1, 22), Math.sin(a) * 1.8];
      const speed = [Math.cos(a) * r, rng.range(2, 12), Math.sin(a) * r];
      const spin = new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize().toArray();
      const rate = rng.range(-5, 5), p = geo.getAttribute('position'), n = geo.getAttribute('normal');
      for (let j = 0; j < p.count; j++) {
        debrisPositions.push(p.getX(j), p.getY(j), p.getZ(j)); normals.push(n.getX(j), n.getY(j), n.getZ(j));
        origins.push(...origin); speeds.push(...speed); spins.push(...spin, rate);
      }
      geo.dispose();
    }
    const debrisGeometry = new THREE.BufferGeometry();
    for (const [key, array, width] of [['position', debrisPositions, 3], ['normal', normals, 3], ['aOrigin', origins, 3], ['aVelocity', speeds, 3], ['aSpin', spins, 4]] as const)
      debrisGeometry.setAttribute(key, new THREE.Float32BufferAttribute(array, width));
    const debrisMaterial = new THREE.MeshStandardMaterial({ color: 0x211a14, roughness: 1 });
    debrisMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, age);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + DEBRIS_TRANSFORM)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = debrisRotation() * normal;')
        .replace('#include <begin_vertex>', 'vec3 transformed = debrisPosition(position);');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uAge;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += mix(vec3(1.0, 0.16, 0.02), vec3(1.0), exp(-uAge * 7.0)) * exp(-uAge * 1.4) * 3.0;
          if (uAge > 7.0 && fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) < smoothstep(7.0, 10.0, uAge)) discard;`);
    };
    debrisMaterial.customProgramCacheKey = () => 'boss-charred-debris-v1';
    this.debris = add(new THREE.Mesh(debrisGeometry, debrisMaterial), 'boss-charred-timber');
    for (const effect of [this.smoke, this.embers, this.debris]) effect.position.y = ground;
    this.group.visible = false;
  }

  update(age: number): void {
    const { world, session } = this.env.ctx;
    this.uAwakening.value = session.screen === 'playing' || session.screen === 'paused' ? bossAwakeningLevel(world) : 0;
    this.group.visible = age >= 0;
    if (age < 0) return;
    this.uAge.value = age;
    this.burst.visible = age < 0.28 || (age < BOSS_AWAKENING_SECONDS && this.uAwakening.value > 0);
    // A narrow initial shell intersects the rig and paints additive white streaks
    // across its silhouette. Enclose the full rig from the first awakening frame.
    const expand = this.uAwakening.value > 0 ? 1 : smooth(0, 0.22, age);
    this.burst.scale.set(1.5 + 23 * expand, 14 + 6 * expand, 1.5 + 23 * expand);
    this.shock.visible = age < 1.8;
    this.smoke.visible = age < 4.5;
    this.embers.visible = age < 6;
    this.debris.visible = age < 10;
    this.env.ctx.renderer.getDrawingBufferSize(this.size);
    this.uPointScale.value = this.size.y / (2 / this.env.ctx.camera.projectionMatrix.elements[5]);
    if (this.env.ctx.shared?.fx) this.env.ctx.shared.fx.flash = Math.max(this.env.ctx.shared.fx.flash, bossFlash(age) * 0.12);
  }

  dispose(): void {
    for (const geometry of this.geos) geometry.dispose();
    for (const material of this.mats) material.dispose();
    this.group.removeFromParent();
  }
}
