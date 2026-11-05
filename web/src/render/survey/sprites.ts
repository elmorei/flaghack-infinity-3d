/**
 * Instanced camera-facing sprites for the Survey layer: throw-arc dots, implied-Flag order
 * glyphs (I, II, III from a Cinzel canvas atlas), critical-Flag reticles. A SpriteLayer may
 * be "x-ray" (no depth test, drawn last) so threat markers read through walls.
 */
import * as THREE from 'three';
import { drawGroundInkBeforeSprites } from './groundInk';
import { GLSL_COMMON, GLSL_FRAG, GLSL_VERT, GLSL_OUTPUT, cornerQuad, surveyMaterial } from './glsl';
import type { SurveyUniforms, Uniform } from './glsl';
import { InstanceSet } from './instances';

export const SPRITE = {
  dot: 0,
  glyph: 1,
  reticle: 2,
  ring: 3,
  /** Chevrons rising off a Flag that must be pulled (p0 = phase). */
  yank: 4,
} as const;
export type SpriteShape = (typeof SPRITE)[keyof typeof SPRITE];

/** Atlas cells: Roman implied-Flag orders and an alarm mark. */
export const GLYPH = { one: 0, two: 1, three: 2, alarm: 3 } as const;
const GLYPH_TEXT = ['I', 'II', 'III', '!'];
const CELL = 128;

const VERT = /* glsl */ `
${GLSL_COMMON}
${GLSL_VERT}
attribute vec2 aCorner;
attribute vec4 iPos;
attribute vec4 iColor;
attribute vec4 iParam;
attribute float iAnchor;
varying vec2 vQ;
flat varying vec4 vColor;
flat varying vec4 vParam;

void main() {
  vec3 p = iPos.xyz;
  int an = fhId(iAnchor);
  if (an >= 0) {
    vec4 n = fhNode(an);
    p.x += n.x;
    p.z += n.y;
    p.y += fhGround(p.xz);
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec4 c = projectionMatrix * mv;
  float px = max(iPos.w * fhProjScale() / c.w, iParam.w * uPx);
  float cs = cos(iParam.z);
  float sn = sin(iParam.z);
  vec2 rq = vec2(aCorner.x * cs - aCorner.y * sn, aCorner.x * sn + aCorner.y * cs);
  c.xy += rq * px * 2.0 / uResolution * c.w;
  gl_Position = c;
  vFogDepth = -mv.z;
  vQ = aCorner;
  vColor = iColor;
  vParam = iParam;
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_FRAG}
uniform sampler2D uAtlas;
uniform float uCells;
varying vec2 vQ;
flat varying vec4 vColor;
flat varying vec4 vParam;

void main() {
  int shape = fhId(vParam.x);
  float r = length(vQ);
  vec3 col = vColor.rgb;
  float a = 0.0;
  float add = 0.7;
  if (shape == 0) {
    a = exp(-r * r * 6.0) + smoothstep(0.35, 0.15, r) * 0.6;
    col *= 1.0 + smoothstep(0.35, 0.0, r);
  } else if (shape == 1) {
    vec2 uv = vec2((vQ.x * 0.5 + 0.5 + vParam.y) / uCells, vQ.y * 0.5 + 0.5);
    vec4 t = texture2D(uAtlas, uv);
    a = t.a;
    col = mix(vec3(0.02, 0.02, 0.05), col, t.r);
    add = 0.15;
  } else if (shape == 2) {
    float pulse = 0.7 + 0.3 * sin(uTime * 8.0 + vParam.y);
    vec2 q = abs(vQ);
    float corner = step(0.62, max(q.x, q.y)) * step(max(q.x, q.y), 0.86) * step(0.5, min(q.x, q.y));
    float ring = smoothstep(0.1, 0.0, abs(r - 0.42 - 0.08 * sin(uTime * 8.0)));
    float dot_ = smoothstep(0.14, 0.08, r);
    a = (corner + ring * 0.8 + dot_) * pulse;
    col *= 1.3;
  } else if (shape == 4) {
    // Two upward chevrons climbing off the Flag top: yank it out of the ground.
    for (int i = 0; i < 2; i++) {
      float o = fract(uTime * 1.1 + vParam.y + float(i) * 0.5);
      vec2 p = vQ - vec2(0.0, -0.55 + o);
      float d = abs(p.y + abs(p.x) * 0.9) * 0.743;
      a += smoothstep(0.13, 0.06, d) * step(abs(p.x), 0.48) * sin(o * FH_PI);
    }
    col *= 1.25;
    add = 0.55;
  } else {
    a = smoothstep(0.12, 0.0, abs(r - 0.8));
  }
  if (r > 1.0) a = 0.0;
  a *= vColor.a * fhFogKeep() * uGlow.w;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col * a, a * (1.0 - add));
  ${GLSL_OUTPUT}
}
`;

function makeAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL * GLYPH_TEXT.length;
  canvas.height = CELL;
  const g = canvas.getContext('2d');
  if (g) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < GLYPH_TEXT.length; i++) {
      const text = GLYPH_TEXT[i];
      const size = text.length > 2 ? 64 : 84;
      g.font = `700 ${size}px "Cinzel", "Cinzel Decorative", serif`;
      const x = CELL * i + CELL / 2;
      const y = CELL / 2 + 4;
      // Dark keyline in the alpha so glyphs read over bright glass; white fill in red channel.
      g.lineWidth = 14;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.lineJoin = 'round';
      g.strokeText(text, x, y);
      g.fillStyle = '#ffffff';
      g.fillText(text, x, y);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export class SpriteLayer {
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.Mesh;
  private readonly set: InstanceSet;
  private readonly mat: THREE.ShaderMaterial;
  private readonly atlas: THREE.CanvasTexture;
  private readonly ownsAtlas: boolean;
  private readonly arrPos: Float32Array;
  private readonly arrColor: Float32Array;
  private readonly arrParam: Float32Array;
  private readonly arrAnchor: Float32Array;
  count = 0;

  constructor(
    scene: THREE.Scene,
    shared: SurveyUniforms,
    capacity: number,
    renderOrder: number,
    xray: boolean,
    atlas?: THREE.CanvasTexture,
    spriteForeground = false,
  ) {
    this.scene = scene;
    this.ownsAtlas = atlas === undefined;
    this.atlas = atlas ?? makeAtlas();
    this.set = new InstanceSet(cornerQuad([-1, -1, 1, -1, 1, 1, -1, 1]), capacity);
    this.arrPos = this.set.add('iPos', 4);
    this.arrColor = this.set.add('iColor', 4);
    this.arrParam = this.set.add('iParam', 4);
    this.arrAnchor = this.set.add('iAnchor', 1, -1);
    const atlasUniforms: Record<string, Uniform<unknown>> = {
      uAtlas: { value: this.atlas },
      uCells: { value: GLYPH_TEXT.length },
    };
    this.mat = surveyMaterial(shared, { vertexShader: VERT, fragmentShader: FRAG, uniforms: atlasUniforms, depthTest: !xray });
    if (spriteForeground) drawGroundInkBeforeSprites(this.mat);
    this.mesh = new THREE.Mesh(this.set.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);
  }

  /** The glyph atlas, shareable with a second layer. */
  get glyphAtlas(): THREE.CanvasTexture {
    return this.atlas;
  }

  reset(): void {
    this.count = 0;
  }

  /**
   * Append a sprite of half-size `size` metres (at least `minPx` css pixels). (x, y, z) is an
   * offset from the anchor node's display position when `anchor` ≥ 0.
   */
  push(
    shape: SpriteShape,
    x: number,
    y: number,
    z: number,
    size: number,
    color: THREE.Color,
    alpha: number,
    p0 = 0,
    rot = 0,
    minPx = 0,
    anchor = -1,
  ): void {
    if (this.count >= this.set.capacity) return;
    const i = this.count++;
    const o = i * 4;
    this.arrPos[o] = x;
    this.arrPos[o + 1] = y;
    this.arrPos[o + 2] = z;
    this.arrPos[o + 3] = size;
    this.arrColor[o] = color.r;
    this.arrColor[o + 1] = color.g;
    this.arrColor[o + 2] = color.b;
    this.arrColor[o + 3] = alpha;
    this.arrParam[o] = shape;
    this.arrParam[o + 1] = p0;
    this.arrParam[o + 2] = rot;
    this.arrParam[o + 3] = minPx;
    this.arrAnchor[i] = anchor;
  }

  commit(): void {
    this.set.commit(this.count);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.set.geo.dispose();
    this.mat.dispose();
    if (this.ownsAtlas) this.atlas.dispose();
  }
}
