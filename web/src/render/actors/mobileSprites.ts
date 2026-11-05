/** Mobile presentation only. Screen-facing, foot-anchored cutout batches; never writes World. */
import * as THREE from 'three';
import atlas from './mobileSpriteAtlas.json';
import actionsData from './mobileSpriteActions.json';
import type { RenderContext } from '../context';
import { HL } from './hippieModel';

export const CAST_SHEETS = ['dr-beef-supreme', 'beelzebub-crow', 'dj-scarecrow', 'president-jaguar', 'frick-frack-wizard', 'skeletal-boss'] as const;
export type SpriteDirection = 'front' | 'away';
export type FlagSpriteState = 'planted' | 'ground' | 'thrown' | 'carried';
export interface SpritePose {
  id: number; x: number; y: number; z: number; yaw: number; height: number; moving: boolean;
  /** Seconds since a one-shot pose began; looping clips use the presentation clock. */
  animationTime?: number;
  /** Seated bodies keep screen-flat art but use a bounded upright depth plane. */
  depthProfile?: 'upright';
}
export interface FlagSpriteStyle { ribbon?: THREE.Color; highlight?: number; glitch?: number; rotation?: number }
export function spriteFrame(time: number, id: number, moving: boolean): number {
  return moving ? ((Math.floor(Math.max(0, time) / .14) + Math.abs(id * 17 % 4)) % 4) : 0;
}
/** Model forward is +Z. Hysteresis prevents a side-on camera from flickering rows. */
export function spriteDirection(yaw: number, toCameraX: number, toCameraZ: number, previous: SpriteDirection = 'front'): SpriteDirection {
  const length = Math.hypot(toCameraX, toCameraZ);
  if (length < .0001) return previous;
  const dot = (Math.sin(yaw) * toCameraX + Math.cos(yaw) * toCameraZ) / length;
  return dot > .12 ? 'front' : dot < -.12 ? 'away' : previous;
}
export function signifierHead(look: ArrayLike<number>): number {
  if (look[HL.hat] > 0) return 5 + look[HL.hat];
  if (look[HL.glasses] > 0) return 10 + look[HL.glasses];
  if (look[HL.beard] > .5) return 5;
  return Math.max(0, Math.min(4, Math.floor(look[HL.hairStyle])));
}
export function signifierBody(flag: boolean, lumber: boolean, status: string, faction: boolean): number {
  if (flag) return 6;
  if (lumber) return 4;
  if (status === 'chopping') return 1;
  if (status === 'building' || status === 'repairing') return 2;
  if (status === 'drumming') return 3;
  return faction ? 5 : 0;
}
export function supportsSignifierAnimation(anim: string): boolean {
  return ['idle', 'walk', 'run', 'flee', 'carry', 'haul', 'guard'].includes(anim) || !!actions.clips[`signifier:${anim}`];
}
export function signifierLayers(direction: SpriteDirection, body: number, frame: number) {
  return [
    {sheet: `bodies-${direction}`, column: frame, row: body, dx: 0, dy: 0},
    {sheet: `heads-${direction}`, column: 0, row: 0, dx: direction === 'front' ? -3 : 0, dy: frame % 2 ? 2 : 4},
    ...(direction === 'away' && body === 6 ? [{sheet: 'flag-away', column: frame, row: 0, dx: 0, dy: 0}] : []),
  ];
}
interface Sheet {
  x: number; y: number; w: number; h: number; cellWidth: number; cellHeight: number;
  columns: number; rows: number; anchor: number[]; footYByCell?: number[][];
}
interface ActionClip extends Sheet {
  page: number; frameDurationMs: number; loop: boolean; directionRows: {front: number; away: number};
  heightPixels: number; headAnchorByCell?: number[][][]; headRotationByCell?: number[][]; poleTipByCell?: number[][][]; includesFurniture?: boolean; includesFlag?: boolean;
}
interface ActionManifest { pages: {image: string; width: number; height: number}[]; clips: Record<string, ActionClip> }
const actions = actionsData as ActionManifest;
const sheets: Record<string, Sheet> = atlas.sheets;
const WHITE = new THREE.Color(1, 1, 1);
const HIGHLIGHT = new THREE.Color(1.2, 1.2, 1.2);

/** Depth-only coefficients for an upright body through the true foot anchor.
 * A perspective plane has affine window depth, so changing clip Z only preserves
 * the exact pixel footprint, UV interpolation and foot position. The profile is
 * capped to one body height and never disables normal terrain/building depth tests.
 */
export function spriteUprightDepth(camera: THREE.Camera, p: SpritePose, radius: number): [number, number] {
  if (p.depthProfile !== 'upright' || !(p.height > 0) || !(radius > 0)) return [0, 0];
  const v = camera.matrixWorldInverse.elements, projection = camera.projectionMatrix.elements;
  const x = v[0] * p.x + v[4] * p.y + v[8] * p.z + v[12];
  const y = v[1] * p.x + v[5] * p.y + v[9] * p.z + v[13];
  const z = v[2] * p.x + v[6] * p.y + v[10] * p.z + v[14];
  if (z >= -.01) return [0, 0];
  // At almost top-down views, bound the otherwise singular upright-plane slope.
  const denominator = Math.max(.0625, v[4] * v[4] + v[5] * v[5]);
  const sx = v[4] * v[6] / denominator, sy = v[5] * v[6] / denominator;
  const plane = z - x * sx - y * sy;
  if (projection[15] === 0 && Math.abs(plane) < .01) return [0, 0];
  const factor = projection[15] === 0 ? projection[14] / (z * plane) : projection[10];
  const dx = sx * factor, dy = sy * factor;
  const depth = (at: number) => (projection[10] * at + projection[14]) / (projection[11] * at + projection[15]);
  const limit = Math.abs(depth(z + Math.min(p.height, -z * .5)) - depth(z));
  const bounded = Math.min(1, limit / Math.max(1e-12, Math.hypot(dx, dy) * radius));
  return [dx * bounded, dy * bounded];
}

/** Camera-space offsets keep the quads screen-parallel at every camera pitch and roll. */
export const SPRITE_VERTEX_SHADER = `attribute vec3 aCenter; attribute vec2 aSize; attribute vec4 aRect; attribute vec3 aOffset; attribute vec3 aTint; attribute float aRotation; attribute float aGlitch; attribute vec4 aRibbon; attribute vec2 aDepth;
  varying vec2 vUv; varying vec3 vTint; varying float vGlitch; varying vec4 vRibbon;
  void main(){vUv=aRect.xy+position.xy*aRect.zw;vTint=aTint;vGlitch=aGlitch;vRibbon=aRibbon;
    vec4 p=viewMatrix*vec4(aCenter,1.);
    vec2 q=vec2((position.x-.5)*aSize.x+aOffset.x,position.y*aSize.y+aOffset.y);
    float c=cos(aRotation),s=sin(aRotation);q=mat2(c,s,-s,c)*q;p.xy+=q;
    p.z+=aOffset.z;
    gl_Position=projectionMatrix*p;
    gl_Position.z+=dot(q,aDepth)*gl_Position.w;}`;

class SpriteBatch {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly texture: THREE.Texture;
  ready = false;
  error = false;
  count = 0;
  capacity = 0;
  private disposed = false;
  private centers!: THREE.InstancedBufferAttribute;
  private sizes!: THREE.InstancedBufferAttribute;
  private rects!: THREE.InstancedBufferAttribute;
  private offsets!: THREE.InstancedBufferAttribute;
  private ribbons!: THREE.InstancedBufferAttribute;
  private glitches!: THREE.InstancedBufferAttribute;
  private rotations!: THREE.InstancedBufferAttribute;
  private tints!: THREE.InstancedBufferAttribute;
  private depths!: THREE.InstancedBufferAttribute;
  constructor(private readonly ctx: RenderContext, readonly width: number, readonly height: number, source: string | THREE.Texture, name: string) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3));
    geometry.setIndex([0,1,2,0,2,3]); geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: {map: {value: null}, uTime: {value: 0}}, vertexShader: SPRITE_VERTEX_SHADER,
      fragmentShader: `uniform sampler2D map; uniform float uTime; varying vec2 vUv; varying vec3 vTint; varying float vGlitch; varying vec4 vRibbon;
        void main(){vec4 c=texture2D(map,vUv);if(c.a<.5)discard;
        float lo=min(c.r,min(c.g,c.b)),hi=max(c.r,max(c.g,c.b));
        float ribbon=step(.5,lo)*(1.-step(.15,hi-lo))*vRibbon.a;
        c.rgb=mix(c.rgb,vRibbon.rgb*hi,ribbon);
        float pulse=step(.72,sin(uTime*13.+vUv.y*20.));
        c.rgb=mix(c.rgb,vec3(.15,.95,1.),min(.7,vGlitch*.45)*pulse);gl_FragColor=vec4(c.rgb*vTint,1.);
        #include <colorspace_fragment>
        }`,
      depthTest: true, depthWrite: true, side: THREE.DoubleSide, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material); this.mesh.name = name; this.mesh.frustumCulled = false;
    ctx.scene.add(this.mesh); this.grow(768);
    if (typeof source === 'string') {
      this.texture = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}${source.replace(/^\//, '')}`, texture => {
        if (this.disposed) { texture.dispose(); return; }
        if (texture.image.width !== width || texture.image.height !== height || ctx.renderer.capabilities.maxTextureSize < Math.max(width, height)) {
          this.error = true; return;
        }
        this.ready = true;
      }, undefined, () => { if (!this.disposed) this.error = true; });
    } else { this.texture = source; this.ready = true; }
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false; material.uniforms.map.value = this.texture;
  }
  private grow(required: number): void {
    if (required <= this.capacity) return;
    let capacity = Math.max(256, this.capacity); while (capacity < required) capacity *= 2;
    const geometry = this.mesh.geometry;
    const replace = (name: string, old: THREE.InstancedBufferAttribute | undefined, size: number) => {
      const next = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
      if (old) next.array.set(old.array); geometry.setAttribute(name, next); return next;
    };
    if (this.capacity) geometry.dispose();
    this.depths = replace('aDepth', this.depths, 2);
    this.centers = replace('aCenter', this.centers, 3); this.sizes = replace('aSize', this.sizes, 2);
    this.rects = replace('aRect', this.rects, 4); this.offsets = replace('aOffset', this.offsets, 3);
    this.tints = replace('aTint', this.tints, 3); this.rotations = replace('aRotation', this.rotations, 1); this.glitches = replace('aGlitch', this.glitches, 1); this.ribbons = replace('aRibbon', this.ribbons, 4); this.capacity = capacity;
  }
  layer(s: Sheet, col: number, row: number, p: SpritePose, scale: number, dx = 0, dy = 0, order = 0, footY = s.anchor[1], tint = WHITE, rotation = 0, glitch = 0, ribbon?: THREE.Color): void {
    this.grow(this.count + 1); const i = this.count++;
    this.centers.setXYZ(i, p.x, p.y, p.z); this.sizes.setXY(i, s.cellWidth * scale, s.cellHeight * scale);
    this.offsets.setXYZ(i, (s.cellWidth / 2 - s.anchor[0] + dx) * scale, (footY - s.cellHeight - dy) * scale, order * .003);
    if (p.depthProfile === 'upright') {
      const radius = Math.hypot(s.cellWidth * scale / 2 + Math.abs(this.offsets.getX(i)),
        Math.max(Math.abs(this.offsets.getY(i)), Math.abs(s.cellHeight * scale + this.offsets.getY(i))));
      this.depths.setXY(i, ...spriteUprightDepth(this.ctx.camera, p, radius));
    } else this.depths.setXY(i, 0, 0);
    this.tints.setXYZ(i, tint.r, tint.g, tint.b); this.rotations.setX(i, rotation); this.glitches.setX(i, glitch); this.ribbons.setXYZW(i, ribbon?.r ?? 1, ribbon?.g ?? 1, ribbon?.b ?? 1, ribbon ? 1 : 0);
    // Exact cell edges preserve source pixel-edge anchors. With nearest sampling and
    // transparent cell borders, half-texel shrinking would move the visible pole tip.
    this.rects.setXYZW(i, (s.x + col * s.cellWidth) / this.width,
      1 - (s.y + (row + 1) * s.cellHeight) / this.height,
      s.cellWidth / this.width, s.cellHeight / this.height);
  }
  end(): void {
    this.mesh.material.uniforms.uTime.value = this.ctx.time;
    this.mesh.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    for (const a of [this.centers, this.sizes, this.rects, this.offsets, this.tints, this.rotations, this.glitches, this.ribbons, this.depths]) {
      a.clearUpdateRanges(); a.addUpdateRange(0, this.count * a.itemSize); a.needsUpdate = true;
    }
  }
  dispose(): void {
    this.disposed = true; this.ready = false; this.ctx.scene.remove(this.mesh);
    this.texture.dispose(); this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}

/** Built-in flat sprites keep entities visible if art requests fail, without revealing models. */
function placeholderTexture(): THREE.DataTexture {
  const width = 64, height = 32, bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cell = Math.floor(x / 16), px = x % 16;
    const person = ((px - 7.5) ** 2 + (y - 5) ** 2 <= 15) || (y >= 10 && y <= 23 && px >= 3 && px <= 12) || (y >= 23 && y <= 30 && ((px >= 4 && px <= 6) || (px >= 9 && px <= 11)));
    const flag = (px >= 3 && px <= 4 && y >= 2 && y <= 30) || (px >= 5 && px <= 14 && y >= 2 && y <= 11);
    const marker = (px - 7.5) ** 2 + (y - 16) ** 2 <= 36;
    const ground = (y === 29 && px >= 1 && px <= 14) || (px >= 3 && px <= 9 && y >= 22 && y <= 28);
    if (!(cell === 0 ? person : cell === 1 ? flag : cell === 2 ? marker : ground)) continue;
    const i = ((height - 1 - y) * width + x) * 4;
    bytes[i] = (cell === 1 || cell === 3) ? 255 : 230; bytes[i + 1] = (cell === 1 || cell === 3) ? 222 : 230; bytes[i + 2] = (cell === 1 || cell === 3) ? 72 : 230; bytes[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(bytes, width, height); texture.needsUpdate = true; return texture;
}
const PLACEHOLDER_SHEET: Sheet = {x: 0, y: 0, w: 64, h: 32, cellWidth: 16, cellHeight: 32, columns: 4, rows: 1, anchor: [8, 31]};
interface SpriteSample {id: number; kind: string; direction: SpriteDirection; frame: number; layers: number; head?: number; body?: number; clip?: string; requestedClip?: string; placeholder?: boolean}

export class MobileSprites {
  readonly enabled = true;
  get atlasReady(): boolean { return this.base.ready; }
  get atlasError(): boolean { return this.base.error; }
  get actionAtlasReady(): boolean { return this.pages.every(page => page.ready); }
  get actionAtlasError(): boolean { return this.pages.some(page => page.error); }
  spriteCount = 0;
  layerCount = 0;
  /** Missing-clip/default or built-in placeholder substitutions; never 3D substitutions. */
  fallbackCount = 0;
  get capacity(): number { return this.batches.reduce((total, batch) => total + batch.capacity, 0); }
  readonly samples: SpriteSample[] = [];
  get batchCount(): number { return this.batches.filter(batch => batch.count > 0).length; }
  readonly mesh: SpriteBatch['mesh'];
  readonly meshes: SpriteBatch['mesh'][];
  private readonly base: SpriteBatch;
  private readonly pages: SpriteBatch[];
  private readonly placeholders: SpriteBatch;
  private readonly batches: SpriteBatch[];
  private disposed = false;
  private readonly directions = new Map<number, SpriteDirection>();
  private readonly seen = new Set<number>();
  private readonly animations = new Map<number, {key: string; start: number}>();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  constructor(private readonly ctx: RenderContext) {
    this.base = new SpriteBatch(ctx, atlas.width, atlas.height, atlas.image, 'mobile-sprite-batch');
    this.pages = actions.pages.map((page, i) => new SpriteBatch(ctx, page.width, page.height, page.image, `mobile-sprite-actions-${i}`));
    this.placeholders = new SpriteBatch(ctx, 64, 32, placeholderTexture(), 'mobile-sprite-placeholders');
    this.batches = [this.base, ...this.pages, this.placeholders];
    this.mesh = this.base.mesh; this.meshes = this.batches.map(batch => batch.mesh);
  }
  begin(): void {
    this.spriteCount = this.layerCount = this.fallbackCount = 0; this.seen.clear(); this.samples.length = 0;
    for (const batch of this.batches) batch.count = 0;
    this.ctx.camera.updateMatrixWorld(); this.ctx.camera.getWorldDirection(this.cameraDirection); this.ctx.camera.getWorldPosition(this.cameraPosition);
  }
  private direction(p: SpritePose): SpriteDirection {
    const orthographic = (this.ctx.camera as THREE.OrthographicCamera).isOrthographicCamera;
    const dx = orthographic ? -this.cameraDirection.x : this.cameraPosition.x - p.x;
    const dz = orthographic ? -this.cameraDirection.z : this.cameraPosition.z - p.z;
    const direction = spriteDirection(p.yaw, dx, dz, this.directions.get(p.id));
    this.directions.set(p.id, direction); this.seen.add(p.id); return direction;
  }
  private sample(sample: SpriteSample): void { if (this.samples.length < 32) this.samples.push(sample); }
  private placeholder(p: SpritePose, kind: string, flag = false, rotation = 0, ground = false): true {
    const direction = this.direction(p);
    this.placeholders.layer(PLACEHOLDER_SHEET, ground ? 3 : flag ? 1 : 0, 0, p, p.height / (ground ? 15 : 29), 0, 0, 0, ground ? 30 : 31, WHITE, rotation);
    this.sample({id: p.id, kind, direction, frame: 0, layers: 1, placeholder: true});
    this.spriteCount++; this.layerCount++; this.fallbackCount++; return true;
  }
  private action(key: string, p: SpritePose, direction: SpriteDirection): {clip: ActionClip; frame: number; row: number; batch: SpriteBatch} | null {
    const clip = actions.clips[key], batch = clip && this.pages[clip.page];
    let state = this.animations.get(p.id);
    if (!state || state.key !== key) { state = {key, start: this.ctx.time}; this.animations.set(p.id, state); }
    if (!clip || !batch?.ready) return null;
    const time = clip.loop ? this.ctx.time : p.animationTime ?? this.ctx.time - state.start;
    const raw = Math.floor(Math.max(0, time) / (clip.frameDurationMs / 1000));
    const frame = clip.loop ? (raw + Math.abs(p.id * 17 % clip.columns)) % clip.columns : Math.min(raw, clip.columns - 1);
    return {clip, frame, row: clip.directionRows[direction], batch};
  }
  /** Legacy false means use the default sprite, never expose the corresponding model. */
  cast(index: number, p: SpritePose, animation: string | boolean = true): boolean {
    if (this.disposed) return false;
    const key = CAST_SHEETS[index], sheet = sheets[key];
    if (!sheet) return false;
    const requested = typeof animation === 'string' ? animation : p.moving && animation ? 'walk' : 'idle';
    const direction = this.direction(p), action = this.action(`${key}:${requested}`, p, direction);
    if (action) {
      const {clip, frame, row, batch} = action;
      batch.layer(clip, frame, row, p, p.height / clip.heightPixels, 0, 0, 0, clip.footYByCell?.[row]?.[frame]);
      this.sample({id: p.id, kind: key, direction, frame, layers: 1, clip: requested, requestedClip: requested});
      this.layerCount++; this.spriteCount++; return true;
    }
    if (!this.base.ready) return this.placeholder(p, key);
    const fallback = animation === false || !['idle', 'walk'].includes(requested);
    const frame = spriteFrame(this.ctx.time, p.id, fallback ? false : p.moving), row = direction === 'front' ? 0 : 1;
    this.base.layer(sheet, frame, row, p, p.height / 224, 0, 0, 0, sheet.footYByCell?.[row]?.[frame]);
    this.sample({id: p.id, kind: key, direction, frame, layers: 1, clip: fallback ? 'idle' : requested, requestedClip: requested});
    if (fallback) this.fallbackCount++;
    this.spriteCount++; this.layerCount++; return true;
  }
  signifier(p: SpritePose, head: number, body: number, animation: string | boolean = true, carriedFlagColor?: THREE.Color): boolean {
    if (this.disposed || head < 0 || head >= 18 || body < 0 || body >= 7) return false;
    const requested = typeof animation === 'string' ? animation : p.moving && animation ? 'walk' : 'idle';
    const direction = this.direction(p), action = this.action(`signifier:${requested}`, p, direction);
    if (action && (!action.clip.headAnchorByCell || this.base.ready)) {
      const {clip, frame, row, batch} = action, scale = p.height / clip.heightPixels;
      const foot = clip.footYByCell?.[row]?.[frame] ?? clip.anchor[1];
      batch.layer(clip, frame, row, p, scale, 0, 0, 0, foot);
      const neck = clip.headAnchorByCell?.[row]?.[frame];
      if (neck) {
        const headSheet = sheets[`heads-${direction}`], headScale = p.height / 142;
        const rotation = clip.headRotationByCell?.[row]?.[frame] ?? 0;
        const nx = (neck[0] - clip.anchor[0]) * scale, ny = (foot - neck[1]) * scale;
        // Inverse-rotate the neck offset so rotating the head never dislocates its neck.
        const c = Math.cos(rotation), s = Math.sin(rotation);
        const dx = (c * nx + s * ny) / headScale, dy = -78 - (-s * nx + c * ny) / headScale;
        this.base.layer(headSheet, head % 6, Math.floor(head / 6), p, headScale, dx, dy, 1, 0, WHITE, rotation);
      }
      const badge = body === 6 && !!clip.includesFlag && !!carriedFlagColor;
      if (badge) this.carriedFlagBadge(p, carriedFlagColor!, direction);
      this.sample({id: p.id, kind: 'signifier', direction, frame, layers: (neck ? 2 : 1) + (badge ? 1 : 0), head, body, clip: requested, requestedClip: requested});
      this.layerCount += neck ? 2 : 1; this.spriteCount++; return true;
    }
    if (!this.base.ready) return this.placeholder(p, 'signifier');
    const fallback = animation === false || !['idle', 'walk', 'run', 'flee', 'carry', 'haul', 'guard'].includes(requested);
    const frame = spriteFrame(this.ctx.time, p.id, fallback ? false : p.moving), layers = signifierLayers(direction, body, frame);
    const footY = sheets[`bodies-${direction}`].footYByCell?.[body]?.[frame];
    const badge = body === 6 && !!carriedFlagColor;
    this.sample({id: p.id, kind: 'signifier', direction, frame, layers: layers.length + (badge ? 1 : 0), head, body, clip: fallback ? 'idle' : requested, requestedClip: requested});
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      this.base.layer(sheets[l.sheet], i === 1 ? head % 6 : l.column, i === 1 ? Math.floor(head / 6) : l.row, p, p.height / 142, l.dx, l.dy, i, footY);
    }
    if (badge) this.carriedFlagBadge(p, carriedFlagColor!, direction);
    if (fallback) this.fallbackCount++;
    this.spriteCount++; this.layerCount += layers.length; return true;
  }
  private carriedFlagBadge(p: SpritePose, color: THREE.Color, direction: SpriteDirection): void {
    // Separate owner mark beside the carried flag, not a recolor of the person's clothing.
    this.placeholders.layer(PLACEHOLDER_SHEET, 2, 0, p, p.height / 105, direction === 'front' ? -26 : 26, 0, 2, 91, color);
    this.layerCount++;
  }
  /** Base carrier art includes its flag; action bodies and placeholders may need equipment. */
  signifierNeedsFlag(animation: string): boolean {
    const clip = actions.clips[`signifier:${animation}`];
    const actionReady = !!clip && this.pages[clip.page]?.ready && (!clip.headAnchorByCell || this.base.ready);
    return actionReady ? !clip.includesFlag : !this.base.ready;
  }
  flag(p: SpritePose, state: FlagSpriteState, style: FlagSpriteStyle = {}): boolean {
    if (this.disposed) return false;
    const direction = this.direction(p);
    const action = this.action(`flag:${state}`, p, direction) ?? this.action('flag:planted', p, direction);
    if (action) {
      const {clip, frame, row, batch} = action;
      const tint = style.highlight ? HIGHLIGHT : WHITE;
      const tip = clip.poleTipByCell?.[row]?.[frame];
      batch.layer(clip, frame, row, p, p.height / clip.heightPixels,
        tip ? clip.anchor[0] - tip[0] : 0, 0, 0, tip?.[1] ?? clip.footYByCell?.[row]?.[frame],
        tint, style.rotation ?? 0, style.glitch ?? 0, style.ribbon);
      this.sample({id: p.id, kind: 'flag', direction, frame, layers: 1, clip: state});
      this.spriteCount++; this.layerCount++;
    } else this.placeholder(p, 'flag', true, style.rotation ?? 0, state === 'ground');
    if (style.ribbon) {
      this.placeholders.layer(PLACEHOLDER_SHEET, 2, 0, p, p.height / 150, 0, 0, 2, 22, style.ribbon);
      this.layerCount++;
    }
    return true;
  }
  end(): void {
    for (const batch of this.batches) batch.end();
    for (const id of this.directions.keys()) if (!this.seen.has(id)) { this.directions.delete(id); this.animations.delete(id); }
  }
  dispose(): void { this.disposed = true; this.batches.forEach(batch => batch.dispose()); this.directions.clear(); this.animations.clear(); }
}
