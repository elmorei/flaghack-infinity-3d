/**
 * Instanced camera-facing beams for the Survey layer: containment beams from an enclosing
 * loop toward a captive Hearth, dashed ley previews for the throw arc and pentacle hover,
 * crystal light pillars and the overwrite column. Endpoints may be anchored to lattice nodes
 * (display positions), so previews follow flip glides.
 */
import * as THREE from 'three';
import { GLSL_COMMON, GLSL_FRAG, GLSL_VERT, GLSL_OUTPUT, cornerQuad, surveyMaterial } from './glsl';
import type { SurveyUniforms } from './glsl';
import { InstanceSet } from './instances';

export const BEAM = {
  /** Energy pulses flowing A → B (p0 speed). */
  flow: 0,
  /** Marching dashes (p0 speed). */
  dash: 1,
  /** Vertical light column fading upward (A = base). */
  pillar: 2,
  /** Containment: pulses converge on B and the beam thins toward it (p0 speed). */
  inflow: 3,
} as const;
export type BeamStyle = (typeof BEAM)[keyof typeof BEAM];

const VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCorner;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iColor;
attribute vec4 iParam;
attribute vec2 iAnchor;
varying vec2 vUv;
flat varying float vLen;
flat varying vec4 vColor;
flat varying vec4 vParam;
flat varying float vStyle;

void main() {
  vec3 A = iA.xyz;
  vec3 B = iB.xyz;
  int na = fhId(iAnchor.x);
  int nb = fhId(iAnchor.y);
  if (na >= 0) A.xz += fhNode(na).xy;
  if (nb >= 0) B.xz += fhNode(nb).xy;
  A.y += fhGround(A.xz);
  B.y += fhGround(B.xz);
  float t = aCorner.x;
  vec3 P = mix(A, B, t);
  vec3 axis = B - A;
  float len = length(axis);
  axis = len > 1e-4 ? axis / len : vec3(0.0, 1.0, 0.0);
  vec3 toCam = fhToCamera(P);
  vec3 sd = cross(axis, toCam);
  float sl = length(sd);
  sd = sl > 1e-4 ? sd / sl : vec3(1.0, 0.0, 0.0);
  float w = max(iA.w, 2.0 * uPx * fhPixelDepth(P) / fhProjScale());
  P += sd * aCorner.y * w * 0.5;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vUv = aCorner;
  vLen = len;
  vColor = iColor;
  vParam = iParam;
  vStyle = iB.w;
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vUv;
flat varying float vLen;
flat varying vec4 vColor;
flat varying vec4 vParam;
flat varying float vStyle;

void main() {
  float t = vUv.x;
  float s = vUv.y;
  int style = fhId(vStyle);
  float core = exp(-s * s * 14.0);
  float glow = exp(-s * s * 2.5);
  float x = t * vLen;
  float speed = vParam.x;
  float a = 0.0;
  vec3 col = vColor.rgb;
  if (style == 0) {
    float flow = pow(0.5 + 0.5 * sin(x * 0.9 - uTime * speed + vParam.y), 8.0);
    a = glow * 0.45 + core * (0.9 + flow * 1.8);
    a *= smoothstep(0.0, 0.08, t) * smoothstep(1.0, 0.9, t);
  } else if (style == 1) {
    float d = fract(x / 0.9 - uTime * speed);
    float dash = smoothstep(0.0, 0.1, d) * smoothstep(0.6, 0.5, d);
    a = (core * 1.3 + glow * 0.3) * dash;
  } else if (style == 3) {
    float flow = pow(0.5 + 0.5 * sin(x * 0.7 - uTime * speed + vParam.y), 10.0);
    a = (glow * 0.3 + core * (0.55 + flow * 1.6)) * (1.0 - t * 0.6);
    a *= smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.85, t);
  } else {
    float n = fhNoise(vec2(s * 2.0 + vParam.y, x * 0.12 - uTime * speed));
    a = (glow * 0.35 + core * 0.8) * (0.6 + 0.6 * n) * pow(1.0 - t, 1.6) * smoothstep(0.0, 0.03, t);
  }
  a *= vColor.a * fhFogKeep() * uGlow.w;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col * a, 0.0);
  ${GLSL_OUTPUT}
}
`;

export class BeamLayer {
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.Mesh;
  private readonly set: InstanceSet;
  private readonly mat: THREE.ShaderMaterial;
  private readonly arrA: Float32Array;
  private readonly arrB: Float32Array;
  private readonly arrColor: Float32Array;
  private readonly arrParam: Float32Array;
  private readonly arrAnchor: Float32Array;
  count = 0;

  constructor(scene: THREE.Scene, shared: SurveyUniforms, capacity: number, renderOrder: number) {
    this.scene = scene;
    this.set = new InstanceSet(cornerQuad([0, -1, 1, -1, 1, 1, 0, 1]), capacity);
    this.arrA = this.set.add('iA', 4);
    this.arrB = this.set.add('iB', 4);
    this.arrColor = this.set.add('iColor', 4);
    this.arrParam = this.set.add('iParam', 4);
    this.arrAnchor = this.set.add('iAnchor', 2, -1);
    this.mat = surveyMaterial(shared, { vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide });
    this.mat.forceSinglePass = true;
    this.mesh = new THREE.Mesh(this.set.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);
  }

  reset(): void {
    this.count = 0;
  }

  /** Append a beam of `width` metres; endpoint coords are offsets when anchored to nodes. */
  push(
    style: BeamStyle,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    width: number,
    color: THREE.Color,
    alpha: number,
    speed: number,
    phase = 0,
    anchorA = -1,
    anchorB = -1,
  ): void {
    if (this.count >= this.set.capacity) return;
    const i = this.count++;
    const o = i * 4;
    this.arrA[o] = ax;
    this.arrA[o + 1] = ay;
    this.arrA[o + 2] = az;
    this.arrA[o + 3] = width;
    this.arrB[o] = bx;
    this.arrB[o + 1] = by;
    this.arrB[o + 2] = bz;
    this.arrB[o + 3] = style;
    this.arrColor[o] = color.r;
    this.arrColor[o + 1] = color.g;
    this.arrColor[o + 2] = color.b;
    this.arrColor[o + 3] = alpha;
    this.arrParam[o] = speed;
    this.arrParam[o + 1] = phase;
    this.arrAnchor[i * 2] = anchorA;
    this.arrAnchor[i * 2 + 1] = anchorB;
  }

  commit(): void {
    this.set.commit(this.count);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.set.geo.dispose();
    this.mat.dispose();
  }
}
