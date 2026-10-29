import { isMobileCommandLayout } from '../../game/mobileTouch';
/**
 * Persistent Command View marks for the player's Survey plan. The plan survives planting:
 * unheld = black dot, held by the player = their dot, held by a rival = that rival's X.
 * Drawn AFTER the map grade so black stays black and faction colours are not re-tinted.
 * Every symbol is screen-sized, anchored to the same moving node texture as the lattice.
 */
import * as THREE from 'three';
import type { Session } from '../../game/session';
import type { World } from '../../sim/world';
import type { PostFxState } from '../context';
import { postInstability, SCENE_UV_GLSL } from '../post/uvWarp';
import { cornerQuad, GLSL_COMMON, LIFT } from './glsl';
import type { SurveyUniforms } from './glsl';
import { InstanceSet } from './instances';
import type { SurveyData } from './surveyData';

/** Solid core diameter / X extent in CSS pixels, independent of zoom and device pixel ratio. */
export const MARK_SIZE_PX = 18;
const RADIUS = MARK_SIZE_PX / 2;
const BOUND = RADIUS + 8;

export const MARK = { dot: 0, cross: 1 } as const;

/** Physical Flags take precedence; otherwise implied possession counts just as in the Survey. */
export function markedNodeOwner(world: World, node: number): number {
  const s = world.survey;
  return s.nodeFlag[node] >= 0 ? s.nodeFlagOwner[node] : s.holder[node];
}

const VERT = /* glsl */ `
${GLSL_COMMON}
uniform vec2 uMarkWarp;
${SCENE_UV_GLSL}
attribute vec2 aCorner;
attribute float iNode;
attribute vec4 iMark;
varying vec2 vPoint;
flat varying vec4 vMark;
flat varying float vHover;
void main() {
  int id = fhId(iNode);
  vec2 p = fhNode(id).xy;
  vec4 mv = viewMatrix * vec4(p.x, fhGround(p) + ${LIFT.marker}, p.y, 1.0);
  if (mv.z >= -uCameraNear) FH_CULL
  vec4 clip = projectionMatrix * mv;
  // The grade samples the world at warped UVs. Invert the same small mapping so the
  // marker follows the node even during Acid/instability, without re-tinting its ink.
  vec2 sourceUv = clip.xy / clip.w * 0.5 + 0.5;
  vec2 displayUv = sourceUv;
  for (int i = 0; i < 5; i++) {
    displayUv += sourceUv - fhSceneUv(displayUv, uResolution.x / uResolution.y, uTime, uMarkWarp.x, uMarkWarp.y);
  }
  clip.xy = (displayUv * 2.0 - 1.0) * clip.w;
  // Fixed CSS size, even at CMD_HEIGHT_MAX; the anchor alone uses world projection.
  clip.xy += aCorner * ${(BOUND).toFixed(1)} * uPx * 2.0 / uResolution * clip.w;
  gl_Position = clip;
  vPoint = aCorner * ${(BOUND).toFixed(1)};
  vMark = iMark;
  vHover = id == fhId(uHover.x) ? 1.0 : 0.0;
}
`;

const FRAG = /* glsl */ `
varying vec2 vPoint;
flat varying vec4 vMark;
flat varying float vHover;
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  return length(p - a - ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0));
}
void main() {
  float d = length(vPoint) - ${RADIUS.toFixed(1)};
  if (vMark.w > 0.5) {
    // 4 px coloured strokes: an X, not a diagonal square or a plus.
    d = min(segment(vPoint, vec2(-7.0, -7.0), vec2(7.0, 7.0)),
            segment(vPoint, vec2(-7.0, 7.0), vec2(7.0, -7.0))) - 2.0;
  }
  float aa = max(fwidth(d), 0.35);
  float core = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
  float dark = 1.0 - smoothstep(0.8 - aa * 0.5, 0.8 + aa * 0.5, d);
  float edge = 1.0 - smoothstep(1.7 - aa * 0.5, 1.7 + aa * 0.5, d);
  // A fine two-tone keyline reads on both bright parchment and dark structures.
  vec3 col = mix(vec3(0.95), vec3(0.0), dark);
  col = mix(col, vMark.rgb, core);
  float hover = vHover * (1.0 - smoothstep(0.6, 1.4, abs(length(vPoint) - 15.0)));
  if (hover > edge) col = vec3(1.0, 0.78, 0.16);
  float alpha = max(edge, hover);
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

export class MarkedNodeLayer {
  readonly scene = new THREE.Scene();
  private readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly set: InstanceSet;
  private readonly nodes: Float32Array;
  private readonly marks: Float32Array;
  private readonly color = new THREE.Color();
  private readonly warp = { value: new THREE.Vector2() };

  constructor(
    private readonly world: World,
    private readonly session: Session,
    private readonly data: SurveyData,
    shared: SurveyUniforms,
    private readonly fx?: Pick<PostFxState, 'acid' | 'instability'>,
  ) {
    const geo = cornerQuad([-1, -1, 1, -1, 1, 1, -1, 1]);
    this.set = new InstanceSet(geo, data.nodeCount);
    this.nodes = this.set.add('iNode', 1);
    this.marks = this.set.add('iMark', 4);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { ...shared, uMarkWarp: this.warp },
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.scene.visible = false;
  }

  update(): void {
    const s = this.session;
    const mobile = isMobileCommandLayout();
    this.warp.value.set(mobile ? 0 : this.fx?.acid ?? 0, mobile ? 0 : postInstability(this.fx?.instability ?? 0));
    this.scene.visible = (!mobile || s.mobileMode === 'build') && s.view === 'command' && (s.screen === 'playing' || s.screen === 'paused');
    let count = 0;
    if (this.scene.visible) {
      // Only the player's marked intent belongs here. Never inspect unrevealed rival plans.
      for (const n of this.world.factions[s.playerFaction].plan) {
        if (!Number.isInteger(n) || n < 0 || n >= this.data.nodeCount || this.data.lat.nodes[n].blocked) continue;
        const owner = markedNodeOwner(this.world, n);
        const held = owner >= 0 && owner < this.world.factions.length;
        this.color.setHex(held ? this.world.factions[owner].color : 0x000000);
        this.nodes[count] = n;
        const offset = count * 4;
        this.marks[offset] = this.color.r;
        this.marks[offset + 1] = this.color.g;
        this.marks[offset + 2] = this.color.b;
        this.marks[offset + 3] = held && owner !== s.playerFaction ? MARK.cross : MARK.dot;
        count++;
      }
    }
    this.set.commit(count);
    this.scene.visible &&= count > 0;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.set.geo.dispose();
    this.mesh.material.dispose();
  }
}

/** Keep the overlay outside bloom, parchment, drugs and the emergence whiteout. */
export function renderCommandOverlay(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene?: THREE.Scene): void {
  if (!scene?.visible) return;
  const clear = renderer.autoClear;
  const target = renderer.getRenderTarget();
  renderer.autoClear = false;
  try {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(target);
    renderer.autoClear = clear;
  }
}
