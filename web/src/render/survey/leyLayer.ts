/**
 * Ley Lines: one instance per lattice edge (gl_InstanceID = edge id), drawn only where the
 * edge texture says a faction's Ley Line spans it (or one is snapping out). Each instance is
 * a camera-facing additive beam at mid-pole height with energy pulses flowing along it, plus
 * a soft ground strip under it so the line reads from the Command View table.
 * Zip-in grows the beam from the established Flag toward the new one with a hot head;
 * snap-out breaks it at the middle and retracts the halves with a flicker.
 */
import * as THREE from 'three';
import { BEAM_Y, GLSL_COMMON, GLSL_FRAG, GLSL_VERT, GLSL_OUTPUT, LIFT, surveyMaterial } from './glsl';
import type { SurveyUniforms } from './glsl';
import type { SurveyData } from './surveyData';

export const LEY_ZIP = 0.38;
export const LEY_SNAP = 0.45;

const VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec3 aCorner;
attribute vec2 iEnds;
varying vec2 vUv;
varying float vLen;
varying float vVariant;
flat varying vec4 vState;
flat varying float vSeed;
varying float vNear;

void main() {
  int e = gl_InstanceID;
  vec4 st = fhEdge(e);
  int owner = fhId(st.x);
  float k = uTime - st.y;
  bool snapping = st.w < -0.5 && k < ${LEY_SNAP.toFixed(3)};
  if (owner < 0 && !snapping) FH_CULL
  if (owner < 0 && fhId(st.z) < 0) FH_CULL
  int a = fhId(iEnds.x);
  int b = fhId(iEnds.y);
  vec4 na = fhNode(a);
  vec4 nb = fhNode(b);
  float t = aCorner.x;
  float side = aCorner.y;
  vec3 P;
  vec3 A;
  vec3 B;
  if (aCorner.z < 0.5) {
    A = vec3(na.x, fhGround(na.xy) + ${BEAM_Y.toFixed(3)}, na.y);
    B = vec3(nb.x, fhGround(nb.xy) + ${BEAM_Y.toFixed(3)}, nb.y);
    P = mix(A, B, t);
    vec3 axis = normalize(B - A);
    vec3 toCam = cameraPosition - P;
    vec3 sd = cross(axis, toCam);
    float sl = length(sd);
    sd = sl > 1e-4 ? sd / sl : normalize(cross(axis, vec3(0.0, 1.0, 0.0)));
    float dist = length(toCam);
    // Up close one beam can fill the frame: it thins here (and dims below) near the camera.
    vNear = smoothstep(2.0, 16.0, dist);
    // Orthographic pixels already have a fixed world scale; multiplying by camera distance
    // would turn the 2.5 CSS-pixel minimum into a screen-filling band on phones.
    // Keep the original distance factor for desktop perspective views.
    float pixelDepth = projectionMatrix[3][3] > 0.5 ? 1.0 : dist;
    float w = max(0.3 * (1.0 + uViewBlend * 1.4) * mix(0.4, 1.0, vNear), 2.5 * uPx * pixelDepth / fhProjScale());
    P += sd * side * w * 0.5;
  } else {
    A = vec3(na.x, ${LIFT.leyGround}, na.y);
    B = vec3(nb.x, ${LIFT.leyGround}, nb.y);
    P = mix(A, B, t);
    vec2 ax = normalize(B.xz - A.xz);
    float w = 1.3 + uViewBlend * 1.5;
    P.xz += vec2(-ax.y, ax.x) * side * w * 0.5;
    P.y += fhGround(P.xz);
    vNear = smoothstep(3.0, 24.0, length(cameraPosition - P));
  }
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = -mv.z;
  vUv = vec2(t, side);
  vLen = length(B.xz - A.xz);
  vVariant = aCorner.z;
  vState = st;
  vSeed = fract(float(e) * 0.618034);
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vUv;
varying float vLen;
varying float vVariant;
flat varying vec4 vState;
flat varying float vSeed;
varying float vNear;

void main() {
  int owner = fhId(vState.x);
  int prev = fhId(vState.z);
  float kind = vState.w;
  float k = uTime - vState.y;
  float t = vUv.x;
  float s = vUv.y;
  vec3 col = fhFaction(owner >= 0 ? owner : prev);
  float vis = 1.0;
  float head = 0.0;
  if (owner >= 0 && kind > 0.5 && k < ${LEY_ZIP.toFixed(3)}) {
    float p = clamp(k / ${LEY_ZIP.toFixed(3)}, 0.0, 1.0);
    float tt = kind > 1.5 ? 1.0 - t : t;
    vis = smoothstep(p + 0.03, p - 0.01, tt);
    head = fhGauss((tt - p) * vLen / 0.5);
  } else if (owner < 0) {
    float p = clamp(k / ${LEY_SNAP.toFixed(3)}, 0.0, 1.0);
    float gap = 0.03 + p * 0.5;
    float dm = abs(t - 0.5);
    vis = smoothstep(gap, gap + 0.04, dm) * (1.0 - p);
    vis *= 0.55 + 0.45 * step(0.4, fhHash(vec2(floor(uTime * 30.0), vSeed * 91.0)));
    head = fhGauss((dm - gap) * vLen / 0.35) * (1.0 - p) * 1.5;
  }
  float x = t * vLen;
  float dirS = vSeed > 0.5 ? 1.0 : -1.0;
  float flow = pow(0.5 + 0.5 * sin(x * 1.15 - uTime * 7.5 * dirS + vSeed * 40.0), 10.0);
  float flicker = 0.9 + 0.1 * sin(uTime * 29.0 + vSeed * 100.0 + x * 1.7);
  float knot = fhGauss(min(t, 1.0 - t) * vLen / 0.4);
  float keep = fhFogKeep();
  // Ley light is the brightest Survey element: it keeps most of its energy at night (no
  // night boost on top of the exposure lift) and dims up close, where one beam fills the screen.
  float energy = uGlow.z * mix(0.5, 1.0, vNear);
  if (vVariant < 0.5) {
    float core = exp(-s * s * 20.0);
    float glow = exp(-s * s * 2.6);
    // Hue first: the hot centre only leans a little toward white so ACES keeps the colour.
    vec3 hotCol = mix(col, vec3(1.0), 0.22);
    vec3 c = (col * glow * 0.42 + hotCol * core * (0.95 + flow * 1.1)) * flicker;
    c += hotCol * head * 2.5 + col * knot * glow * 0.6;
    c *= (vis + head) * keep * energy;
    gl_FragColor = vec4(c, 0.0);
  } else {
    float g = exp(-s * s * 3.2) * (0.28 + 0.3 * uViewBlend);
    float ln = exp(-s * s * 45.0) * (0.35 + 0.4 * uViewBlend);
    // The ground glow is a lit strip by day and only a faint tint at night.
    float a = (g + ln) * (vis + head * 0.5) * keep * mix(0.4, 1.0, fhDay()) * mix(0.5, 1.0, vNear);
    vec3 c = col * (1.0 + flow * 0.8 + head) * uGlow.x;
    gl_FragColor = vec4(c * a, a * 0.25);
  }
  ${GLSL_OUTPUT}
}
`;

export class LeyLayer {
  private readonly scene: THREE.Scene;
  private readonly data: SurveyData;
  private readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly ends: THREE.InstancedBufferAttribute;
  private builtTopology = -1;

  constructor(scene: THREE.Scene, data: SurveyData, shared: SurveyUniforms) {
    this.scene = scene;
    this.data = data;
    const g = new THREE.InstancedBufferGeometry();
    // (t, side, variant): variant 0 = camera-facing beam, 1 = ground strip.
    const corners = [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0, 0, -1, 1, 1, -1, 1, 1, 1, 1, 0, 1, 1];
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 3));
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24), 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    this.ends = new THREE.InstancedBufferAttribute(new Float32Array(data.edgeCount * 2), 2);
    this.ends.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iEnds', this.ends);
    g.instanceCount = data.edgeCount;
    this.geo = g;
    this.mat = surveyMaterial(shared, { vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide });
    this.mat.forceSinglePass = true;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }

  update(): void {
    if (this.builtTopology === this.data.topology) return;
    this.builtTopology = this.data.topology;
    const edges = this.data.lat.edges;
    const arr = this.ends.array;
    for (let e = 0; e < edges.length; e++) {
      arr[e * 2] = edges[e].a;
      arr[e * 2 + 1] = edges[e].b;
    }
    this.ends.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
