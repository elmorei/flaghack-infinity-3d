/**
 * The bare Ley Lattice: anti-aliased constant-width lines (screen-space extrusion with
 * near-plane trimming) and node markers, both reading node display positions from the
 * shared node texture. In action mode it is the build grid around the vexillomancer; in
 * Command View the whole crisp map. Flip "spokes" (the old hexagon spokes of a flipped node)
 * ride in spare line instances and fade out while the node glides to its new position.
 */
import * as THREE from 'three';
import { FLIP_TWEEN, GLSL_COMMON, GLSL_FRAG, GLSL_VERT, GLSL_OUTPUT, LIFT, cornerQuad, surveyMaterial } from './glsl';
import type { SurveyUniforms } from './glsl';
import type { SurveyData } from './surveyData';

const SPOKE_SLOTS = 3 * 64;

const LINE_VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCorner;
attribute vec3 iEnds;
uniform float uEdgeCount;
varying vec2 vWorld;
varying float vSide;
varying float vHalf;
varying float vFade;
varying float vHot;

void main() {
  int a = fhId(iEnds.x);
  int b = fhId(iEnds.y);
  if (a < 0 || b < 0) FH_CULL
  bool spoke = float(gl_InstanceID) > uEdgeCount - 0.5;
  vec4 na = fhNode(a);
  vec4 nb = fhNode(b);
  float fade = 1.0;
  float hot = 0.0;
  if (spoke) {
    float k = (uTime - iEnds.z) / ${FLIP_TWEEN.toFixed(3)};
    if (k < 0.0 || k >= 1.0) FH_CULL
    fade = 1.0 - k * k;
    hot = 0.6 * (1.0 - k);
  } else {
    if (((int(na.w) | int(nb.w)) & 1) != 0) FH_CULL
    fade = min(fhNodeAux(a).x, fhNodeAux(b).x);
    int e = gl_InstanceID;
    int hn = fhId(uHover.x);
    if (e == fhId(uHover.y)) hot = 1.0;
    else if (uHover.w > 0.001 && (e == fhId(uHoverEdges.x) || e == fhId(uHoverEdges.y) || e == fhId(uHoverEdges.z) || e == fhId(uHoverEdges.w))) hot = 0.75 * uHover.w;
    else if (hn >= 0 && (a == hn || b == hn)) hot = 0.55;
  }
  vec3 A = vec3(na.x, fhGround(na.xy) + ${LIFT.line}, na.y);
  vec3 B = vec3(nb.x, fhGround(nb.xy) + ${LIFT.line}, nb.y);
  vec4 va = viewMatrix * vec4(A, 1.0);
  vec4 vb = viewMatrix * vec4(B, 1.0);
  // Trim the segment to the near plane so lines passing beside/behind the camera stay sane.
  float nz = -uCameraNear * 1.05;
  if (va.z > nz && vb.z > nz) FH_CULL
  if (va.z > nz) va.xyz += (vb.xyz - va.xyz) * ((nz - va.z) / (vb.z - va.z));
  if (vb.z > nz) vb.xyz += (va.xyz - vb.xyz) * ((nz - vb.z) / (va.z - vb.z));
  vec4 ca = projectionMatrix * va;
  vec4 cb = projectionMatrix * vb;
  vec2 sa = ca.xy / ca.w * uResolution * 0.5;
  vec2 sb = cb.xy / cb.w * uResolution * 0.5;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  bool atB = aCorner.x > 0.5;
  vec4 c = atB ? cb : ca;
  // Thin world-width lines near the camera, at least ~1.2 css px far away (crisp Command View).
  float wpx = max(1.2 * uPx, 0.032 * fhProjScale() / c.w) * (1.0 + hot * 1.8);
  float hw = wpx * 0.5 + uPx;
  c.xy += nrm * aCorner.y * hw * 2.0 / uResolution * c.w;
  gl_Position = c;
  vSide = aCorner.y * hw;
  vHalf = wpx * 0.5;
  vWorld = atB ? B.xz : A.xz;
  vFade = fade;
  vHot = hot;
  vFogDepth = -(atB ? vb.z : va.z);
}
`;

const LINE_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vWorld;
varying float vSide;
varying float vHalf;
varying float vFade;
varying float vHot;

void main() {
  float cover = clamp(vHalf + 0.5 * uPx - abs(vSide), 0.0, uPx) / uPx;
  float pulse = fhCrystalPulse(vWorld);
  float vis = max(fhLatticeReveal(vWorld), min(1.0, pulse));
  // "The Crystal is turning": the whole lattice surfaces and shivers before a tide.
  float warn = uTide.x * (0.3 + 0.3 * sin(uTime * 7.0 + fhNoise(vWorld * 0.08 + uTime * 0.3) * 9.0));
  vis = max(vis, max(warn, vHot));
  float a = cover * vis * vFade * mix(0.26, 0.5, uViewBlend) * fhFogKeep() * uGlow.w;
  vec3 col = mix(vec3(0.62, 0.92, 1.0), vec3(0.97, 0.98, 1.0), uViewBlend);
  col = mix(col, vec3(1.0, 0.86, 0.38), vHot);
  col += vec3(0.5, 0.85, 1.0) * pulse;
  // Luminous Dust tints the lattice prismatic.
  col = mix(col, 0.6 + 0.4 * cos(FH_TAU * (vec3(0.0, 0.33, 0.67) + vWorld.x * 0.01 + vWorld.y * 0.013 + uTime * 0.1)), uReveal.y * 0.6);
  gl_FragColor = vec4(col * a * (1.0 + vHot * 0.8 + pulse), a * 0.55);
  ${GLSL_OUTPUT}
}
`;

const MARKER_VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCorner;
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
varying float vKind;

void main() {
  int id = gl_InstanceID;
  vec4 n = fhNode(id);
  int flags = int(n.w);
  if ((flags & 1) != 0) FH_CULL
  int holder = fhId(n.z);
  bool hov = id == fhId(uHover.x);
  vec2 p = n.xy;
  float pulse = fhCrystalPulse(p);
  float vis = hov ? 1.0 : max(max(fhLatticeReveal(p), min(1.0, pulse)), uTide.x * 0.45);
  if (vis < 0.01) FH_CULL
  vec4 mv = viewMatrix * vec4(p.x, fhGround(p) + ${LIFT.marker}, p.y, 1.0);
  vec4 c = projectionMatrix * mv;
  float r = hov ? 0.6 : (holder >= 0 ? 0.26 : 0.17);
  float minPx = hov ? 8.0 : (holder >= 0 ? 3.2 : 2.4);
  float px = max(r * fhProjScale() / c.w, minPx * uPx);
  c.xy += aCorner * px * 2.0 / uResolution * c.w;
  gl_Position = c;
  vFogDepth = -mv.z;
  vQ = aCorner;
  float sus = fhNodeAux(id).y;
  vec3 base = holder >= 0 ? fhFaction(holder) * 1.3 : vec3(0.92, 0.98, 1.0);
  // Luminous Dust reveals phason strain: susceptible nodes burn magenta.
  base = mix(base, vec3(1.0, 0.25, 0.75) * 1.6, uReveal.y * smoothstep(0.2, 0.9, sus));
  vCol = hov ? vec3(1.0, 0.9, 0.45) : base + vec3(0.5, 0.85, 1.0) * pulse;
  vA = vis * (holder >= 0 ? 0.85 : 0.7) * fhNodeAux(id).x;
  vKind = hov ? 2.0 : (holder >= 0 ? 1.0 : 0.0);
}
`;

const MARKER_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
varying vec2 vQ;
varying vec3 vCol;
varying float vA;
varying float vKind;

void main() {
  float a;
  vec3 col = vCol;
  if (vKind > 1.5) {
    float r = length(vQ);
    float ring = smoothstep(0.12, 0.0, abs(r - 0.72 - 0.06 * sin(uTime * 6.0)));
    float dot_ = smoothstep(0.28, 0.18, r);
    float ticks = smoothstep(0.08, 0.0, min(abs(vQ.x), abs(vQ.y))) * step(0.82, r) * step(r, 1.0);
    a = max(max(ring, dot_), ticks);
  } else if (vKind > 0.5) {
    float r = length(vQ);
    a = smoothstep(1.0, 0.7, r);
    col *= mix(0.55, 1.15, smoothstep(0.75, 0.2, r));
  } else {
    float d = abs(vQ.x) + abs(vQ.y);
    a = smoothstep(1.0, 0.75, d);
    col *= mix(0.5, 1.0, smoothstep(0.85, 0.4, d));
  }
  a *= vA * fhFogKeep() * uGlow.w;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col * a, a * 0.75);
  ${GLSL_OUTPUT}
}
`;

export class LatticeLayer {
  private readonly scene: THREE.Scene;
  private readonly data: SurveyData;
  private readonly lines: THREE.Mesh;
  private readonly markers: THREE.Mesh;
  private readonly lineGeo: THREE.InstancedBufferGeometry;
  private readonly markerGeo: THREE.InstancedBufferGeometry;
  private readonly lineMat: THREE.ShaderMaterial;
  private readonly markerMat: THREE.ShaderMaterial;
  private readonly ends: THREE.InstancedBufferAttribute;
  private builtTopology = -1;
  private spokeCursor = 0;

  constructor(scene: THREE.Scene, data: SurveyData, shared: SurveyUniforms) {
    this.scene = scene;
    this.data = data;
    const edgeCount = data.edgeCount;

    this.lineGeo = cornerQuad([0, -1, 1, -1, 1, 1, 0, 1]);
    this.ends = new THREE.InstancedBufferAttribute(new Float32Array((edgeCount + SPOKE_SLOTS) * 3).fill(-1), 3);
    this.ends.setUsage(THREE.DynamicDrawUsage);
    this.lineGeo.setAttribute('iEnds', this.ends);
    this.lineGeo.instanceCount = edgeCount + SPOKE_SLOTS;
    this.lineMat = surveyMaterial(shared, {
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: { uEdgeCount: { value: edgeCount } },
    });
    this.lines = new THREE.Mesh(this.lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;

    this.markerGeo = cornerQuad([-1, -1, 1, -1, 1, 1, -1, 1]);
    this.markerGeo.instanceCount = data.nodeCount;
    this.markerMat = surveyMaterial(shared, { vertexShader: MARKER_VERT, fragmentShader: MARKER_FRAG });
    this.markers = new THREE.Mesh(this.markerGeo, this.markerMat);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 4;

    scene.add(this.lines, this.markers);
  }

  /**
   * A node flipped: its three old spokes (to the hexagon corners it no longer touches) fade
   * out while the node glides. Each re-tiled facet's corner opposite the node is one of them.
   */
  addFlipSpokes(node: number, now: number): void {
    const lat = this.data.lat;
    const facets = lat.nodes[node].facets;
    const arr = this.ends.array;
    const base = this.data.edgeCount;
    for (let i = 0; i < facets.length; i++) {
      const ns = lat.facets[facets[i]].nodes;
      const k = ns.indexOf(node);
      if (k < 0) continue;
      const opposite = ns[(k + 2) % 4];
      const slot = base + this.spokeCursor;
      this.spokeCursor = (this.spokeCursor + 1) % SPOKE_SLOTS;
      arr[slot * 3] = node;
      arr[slot * 3 + 1] = opposite;
      arr[slot * 3 + 2] = now;
      this.ends.addUpdateRange(slot * 3, 3);
    }
    this.ends.needsUpdate = true;
  }

  /** Bare planning grid only; ownership/borders live in independent layers. */
  setTargetingVisible(visible: boolean): void {
    this.lines.visible = visible;
    this.markers.visible = visible;
  }

  update(): void {
    if (this.builtTopology === this.data.topology) return;
    this.builtTopology = this.data.topology;
    const edges = this.data.lat.edges;
    const arr = this.ends.array;
    for (let e = 0; e < edges.length; e++) {
      arr[e * 3] = edges[e].a;
      arr[e * 3 + 1] = edges[e].b;
      arr[e * 3 + 2] = 0;
    }
    this.ends.clearUpdateRanges();
    this.ends.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.lines, this.markers);
    this.lineGeo.dispose();
    this.markerGeo.dispose();
    this.lineMat.dispose();
    this.markerMat.dispose();
  }
}
