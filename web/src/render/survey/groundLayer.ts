/**
 * Desktop Command View ground tint: an homage to the 2017 Survey Flags board — a drifting cyan/red
 * noise field with twinkling speckle, laid under the fine white lattice and kept translucent
 * so the burn still reads beneath it. Fades in with session.viewBlend.
 */
import * as THREE from 'three';
import { isMobileCommandLayout } from '../../game/mobileTouch';
import { GLSL_COMMON, GLSL_FRAG, GLSL_VERT, GLSL_OUTPUT, LIFT, surveyMaterial } from './glsl';
import type { SurveyUniforms } from './glsl';

const VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
varying vec2 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y += fhGround(wp.xz);
  vWorld = wp.xz;
  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
uniform float uHalf;
varying vec2 vWorld;
void main() {
  vec2 p = vWorld;
  float n1 = fhFbm(p * 0.032 + vec2(uTime * 0.021, -uTime * 0.013));
  float n2 = fhFbm(p * 0.041 + vec2(-uTime * 0.016, uTime * 0.019) + 31.7);
  // Pixel-noise grain at ~0.4 m, re-rolled a few times per second like old CRT static.
  vec2 cell = floor(p * 2.5);
  float g = fhHash(cell + floor(uTime * 4.0) * 0.173);
  float cyan = smoothstep(0.42, 0.72, n1) * (0.55 + 0.45 * g);
  float red = smoothstep(0.44, 0.74, n2) * (0.55 + 0.45 * (1.0 - g));
  vec3 cCyan = vec3(0.05, 0.85, 1.0);
  vec3 cRed = vec3(1.0, 0.12, 0.2);
  vec3 col = cCyan * cyan + cRed * red;
  // Twinkling specks by day only: at night they would just be single-pixel noise.
  float speck = step(0.955, fhHash(cell + 3.1 + floor(uTime * 2.0) * 0.71)) * fhDay();
  col += speck * mix(cCyan, cRed, step(0.5, fhHash(cell + 7.7)));
  float a = (cyan + red) * 0.32 + speck * 0.3 + 0.07;
  // Soft vignette at the burn's edge.
  float edge = smoothstep(uHalf, uHalf - 18.0, max(abs(p.x), abs(p.y)));
  a *= uViewBlend * edge * fhFogKeep() * mix(0.8, 1.0, fhDay());
  gl_FragColor = vec4((col + vec3(0.02, 0.03, 0.06)) * a, a * 0.55);
  ${GLSL_OUTPUT}
}
`;

export class GroundLayer {
  private readonly mobilePresentation = isMobileCommandLayout();
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.Mesh;
  private readonly geo: THREE.PlaneGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly shared: SurveyUniforms;

  constructor(scene: THREE.Scene, shared: SurveyUniforms, half: number) {
    this.scene = scene;
    this.shared = shared;
    this.geo = new THREE.PlaneGeometry(half * 2, half * 2, 128, 128);
    this.geo.rotateX(-Math.PI / 2);
    this.geo.translate(0, LIFT.noise, 0);
    this.mat = surveyMaterial(shared, { vertexShader: VERT, fragmentShader: FRAG, uniforms: { uHalf: { value: half } }, hdrCap: 0.8 });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'command-ground-static';
    this.mesh.frustumCulled = false; // Vertex shader lifts the sheet above its flat CPU bounds.
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(): void {
    // Mobile keeps the terrain and tactical markers without this decorative noise sheet.
    this.mesh.visible = !this.mobilePresentation && this.shared.uViewBlend.value > 0.002;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
