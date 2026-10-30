/**
 * Camera-facing atlas billboards: floating ping icons and the "OVERWRITTEN" / "TAKE A SHOT"
 * banners. Rebuilt every frame by the orchestrator (a few dozen at most). Drawn without
 * depth test and with a minimum on-screen size: these are markers and must stay legible
 * through walls, smoke and distance.
 */
import * as THREE from 'three';
import { ATLAS_FONTS, ATLAS_SIZE, paintAtlas, type AtlasRect } from './atlas';
import { OUTPUT_GLSL, fxMaterial, quadXY, type SharedUniforms } from './glsl';
import { InstanceBuffer } from './instanceBuffer';

const VEC4S = 4;

const VERT = /* glsl */ `
uniform float uViewportH;
attribute vec4 b0; // centre xyz, world height
attribute vec4 b1; // uv rect u0 v0 u1 v1
attribute vec4 b2; // rgb (HDR tint), alpha
attribute vec4 b3; // aspect, min height px, white mix, rotation
varying vec2 vUv;
varying vec4 vColor;
varying float vWhite;

void main() {
  vec4 mv = viewMatrix * vec4(b0.xyz, 1.0);
  float depth = projectionMatrix[2][3] == -1.0 ? max(-mv.z, 0.05) : 1.0;
  float pxPerUnit = max(projectionMatrix[1][1] * 0.5 * uViewportH / depth, 0.0001);
  float h = max(b0.w, b3.y / pxPerUnit);
  vec2 q = position.xy * vec2(h * b3.x, h) * 0.5;
  float c = cos(b3.w);
  float s = sin(b3.w);
  mv.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  gl_Position = projectionMatrix * mv;
  vUv = mix(b1.xy, b1.zw, position.xy * 0.5 + 0.5);
  vColor = b2;
  vWhite = b3.z;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
varying float vWhite;

void main() {
  vec4 tex = texture2D(uAtlas, vUv); // premultiplied
  float a = tex.a * vColor.a;
  if (a < 0.003) discard;
  float peak = max(max(vColor.r, vColor.g), vColor.b);
  vec3 tint = mix(vColor.rgb, vec3(peak), vWhite);
  gl_FragColor = vec4(tex.rgb * tint * vColor.a, a);
  ${OUTPUT_GLSL}
}
`;

export class Billboards {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly buf: InstanceBuffer;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private count = 0;
  private disposed = false;

  constructor(capacity: number, shared: SharedUniforms, renderer: THREE.WebGLRenderer, renderOrder: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    paintAtlas(this.canvas);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.premultiplyAlpha = true;
    this.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    // 'Cinzel Decorative' is imported by main.ts but only fetched on first use: repaint once
    // the banner fonts are really available.
    void Promise.all(ATLAS_FONTS.map((f) => document.fonts.load(f))).then(() => {
      if (this.disposed) return;
      paintAtlas(this.canvas);
      this.texture.needsUpdate = true;
    });
    const geometry = quadXY();
    this.buf = new InstanceBuffer(capacity, VEC4S);
    this.buf.attach(geometry, 'b');
    geometry.instanceCount = 0;
    const material = fxMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uViewportH: shared.uViewportH, uAtlas: { value: this.texture } },
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  begin(): void {
    this.count = 0;
  }

  /**
   * One billboard this frame. `height` is world metres (floored at `minPx` pixels on screen),
   * `white` 0..1 pushes the tint toward white (flash), `rotation` spins it in screen space.
   */
  add(rect: AtlasRect, x: number, y: number, z: number, height: number, minPx: number, color: THREE.Color, intensity: number, alpha: number, white: number, rotation: number): void {
    if (this.count >= this.buf.capacity || alpha <= 0.001) return;
    const d = this.buf.data;
    let o = this.count++ * this.buf.stride;
    d[o++] = x;
    d[o++] = y;
    d[o++] = z;
    d[o++] = height;
    d[o++] = rect.u0;
    d[o++] = rect.v0;
    d[o++] = rect.u1;
    d[o++] = rect.v1;
    d[o++] = color.r * intensity;
    d[o++] = color.g * intensity;
    d[o++] = color.b * intensity;
    d[o++] = alpha;
    d[o++] = rect.aspect;
    d[o++] = minPx;
    d[o++] = white;
    d[o] = rotation;
  }

  flush(): void {
    this.buf.mark(0, this.count);
    this.buf.flush();
    this.mesh.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
