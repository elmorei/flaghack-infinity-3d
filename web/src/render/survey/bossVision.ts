/** Private Acid encounter overlay: solid target reticles, dashed committed aim plan,
 * and a separate solid authoritative eye ray/impact. Nothing is predicted here. */
import * as THREE from 'three';
import { bossVision } from '../../game/bossVision';
import type { BossVisionTarget } from '../../game/bossVision';
import type { Session } from '../../game/session';
import type { V3 } from '../../sim/math';
import { groundHeight } from '../../sim/terrain';
import type { World } from '../../sim/world';
import { cornerQuad, GLSL_COMMON, GLSL_FRAG, GLSL_OUTPUT, GLSL_VERT, surveyMaterial } from './glsl';
import type { SurveyUniforms } from './glsl';
import { InstanceSet, XrayMeshes } from './instances';
import { LabelLayer, labelHeightPx } from './labels';

const COLORS = { objective: new THREE.Color(0x50ffd6), tactical: new THREE.Color(0xffb65c), plan: new THREE.Color(0xf599ff), actual: new THREE.Color(0xe5faff) };
const VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCorner;
attribute vec4 iA;
attribute vec4 iB;
attribute vec3 iColor;
varying vec2 vUv;
flat varying vec3 vColor;
flat varying float vLength;
flat varying float vDash;
void main() {
  vec3 axis = iB.xyz - iA.xyz;
  float len = length(axis);
  vec3 P = mix(iA.xyz, iB.xyz, aCorner.x);
  vec3 side = cross(axis, fhToCamera(P));
  float sl = length(side);
  side = sl > 0.0001 ? side / sl : vec3(1.0, 0.0, 0.0);
  float width = max(iA.w, 2.6 * uPx * fhPixelDepth(P) / fhProjScale());
  P += side * aCorner.y * width * 0.5;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vUv = aCorner;
  vColor = iColor;
  vLength = len;
  vDash = iB.w;
}
`;
const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vUv;
flat varying vec3 vColor;
flat varying float vLength;
flat varying float vDash;
void main() {
  float a = (1.0 - smoothstep(0.4, 1.0, abs(vUv.y))) * 0.9;
  if (vDash > 0.5) a *= 1.0 - smoothstep(0.57, 0.67, fract(vUv.x * vLength / 2.2 - uTime * 0.45));
#ifdef FH_OCCLUDED
  a *= 0.52;
#endif
  if (a < 0.004) discard;
  // Information stays readable at night without exposure-driven bloom blowout.
  gl_FragColor = vec4(vColor * a * uGlow.x, a * 0.45);
  ${GLSL_OUTPUT}
}
`;

interface LabelCandidate { at: V3; slot: number; color: THREE.Color; }
export class BossVisionFeature {
  private readonly set = new InstanceSet(cornerQuad([0, -1, 1, -1, 1, 1, 0, 1]), 256);
  private readonly a = this.set.add('iA', 4);
  private readonly b = this.set.add('iB', 4);
  private readonly color = this.set.add('iColor', 3);
  private readonly meshes: XrayMeshes;
  private readonly labels: LabelLayer;
  private readonly candidates: LabelCandidate[] = [];
  private readonly projected = new THREE.Vector3();
  private count = 0;
  private stamp = 0;

  constructor(scene: THREE.Scene, private readonly world: World, private readonly session: Session, private readonly uniforms: SurveyUniforms) {
    const material = (occluded: boolean) => {
      const mat = surveyMaterial(uniforms, {
        vertexShader: VERT, fragmentShader: FRAG, hdrCap: 1.4, side: THREE.DoubleSide,
        defines: occluded ? { FH_OCCLUDED: 1 } : {},
      });
      mat.forceSinglePass = true;
      return mat;
    };
    this.meshes = new XrayMeshes(scene, this.set.geo, material(false), material(true), 31);
    this.labels = new LabelLayer(scene, uniforms, 10, 32);
  }

  update(camera: THREE.Camera, resolution: THREE.Vector2, pxRatio: number): void {
    this.count = 0; this.stamp++; this.labels.reset(); this.candidates.length = 0;
    const vision = bossVision(this.world, this.session);
    if (vision) {
      const same = vision.objective && vision.tactical?.kind === 'building' && vision.objective.id === vision.tactical.id;
      if (vision.objective) this.target(vision.objective, same ? 'CHOSEN ALTAR + TACTICAL TARGET' : 'CHOSEN ALTAR', COLORS.objective);
      if (vision.tactical && !same) this.target(vision.tactical, `TACTICAL · ${vision.tactical.name.toUpperCase()}`, COLORS.tactical);
      const eye = vision.eye;
      if (eye) {
        for (let i = 0; i < eye.route.length; i++) {
          const at = eye.route[i];
          if (i > 0) this.segment(eye.route[i - 1], at, COLORS.plan, true);
          this.ring(at, 1.2, COLORS.plan, false);
          this.label(at, `AIM PLAN ${i + 1}`, COLORS.plan);
        }
        if (eye.ray) {
          this.segment(eye.ray.from, eye.ray.to, COLORS.actual, false, .18);
          if (eye.ray.impact) {
            this.ring(eye.ray.impact, 1.7, COLORS.actual, false);
            this.label(eye.ray.impact, 'ACTUAL IMPACT', COLORS.actual);
          }
        }
      }
    }
    // No departure fade: expiry, interrupted attacks, death, title and resets clear on this frame.
    this.set.commit(this.count); this.meshes.visible = this.count > 0;
    this.layoutLabels(camera, resolution, pxRatio); this.labels.commit();
  }

  private segment(from: V3, to: V3, color: THREE.Color, dashed = false, width = .14): void {
    if (this.count >= this.set.capacity) return;
    const i = this.count++, k = i * 4;
    this.a.set([from.x, from.y, from.z, width], k);
    this.b.set([to.x, to.y, to.z, dashed ? 1 : 0], k);
    this.color.set([color.r, color.g, color.b], i * 3);
  }

  private ring(at: V3, radius: number, color: THREE.Color, grounded: boolean): void {
    const point = (angle: number): V3 => {
      const x = at.x + Math.sin(angle) * radius, z = at.z + Math.cos(angle) * radius;
      return { x, y: (grounded ? groundHeight(x, z, this.world.map.half) : at.y) + .12, z };
    };
    for (let i = 0; i < 24; i++) this.segment(point(i * Math.PI / 12), point((i + 1) * Math.PI / 12), color);
  }

  private target(target: BossVisionTarget, text: string, color: THREE.Color): void {
    const top = { ...target.at, y: target.at.y + target.height + .8 };
    this.ring(target.at, target.radius + .35, color, target.kind === 'building');
    this.segment(target.at, top, color, false, .12);
    this.label(top, text, color);
  }

  private label(at: V3, text: string, color: THREE.Color): void {
    this.candidates.push({ at, slot: this.labels.atlas.acquire(text, this.stamp), color });
  }

  private layoutLabels(camera: THREE.Camera, resolution: THREE.Vector2, pxRatio: number): void {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const label of this.candidates) {
      this.projected.set(label.at.x, label.at.y, label.at.z).applyMatrix4(camera.matrixWorldInverse);
      if (this.projected.z >= -.1 || label.slot < 0) continue;
      const height = labelHeightPx(-this.projected.z, this.uniforms.uViewBlend.value) * pxRatio;
      const width = this.labels.atlas.aspect(label.slot) * height;
      this.projected.applyMatrix4(camera.projectionMatrix);
      const x = this.projected.x * resolution.x * .5, y = this.projected.y * resolution.y * .5;
      let lift = 0;
      for (let pass = 0; pass < placed.length; pass++) {
        let bumped = false;
        for (const other of placed) if (Math.abs(other.x - x) < (width + other.w) * .5 + 5 * pxRatio &&
            y + lift < other.y + other.h + 4 * pxRatio && y + lift + height > other.y - 4 * pxRatio) {
          lift = Math.max(lift, other.y + other.h + 4 * pxRatio - y); bumped = true;
        }
        if (!bumped) break;
      }
      placed.push({ x, y: y + lift, w: width, h: height });
      this.labels.push(label.at.x, label.at.y, label.at.z, label.slot, label.color, 1, lift);
    }
  }

  dispose(): void { this.meshes.dispose(); this.set.geo.dispose(); this.labels.dispose(); }
}
