/** Mobile presentation only. One cutout, depth-writing GPU batch; never writes World. */
import * as THREE from 'three';
import atlas from './mobileSpriteAtlas.json';
import type { RenderContext } from '../context';
import { HL } from './hippieModel';

export const CAST_SHEETS = ['dr-beef-supreme', 'beelzebub-crow', 'dj-scarecrow', 'president-jaguar', 'frick-frack-wizard', 'skeletal-boss'] as const;
export type SpriteDirection = 'front' | 'away';
export interface SpritePose { id: number; x: number; y: number; z: number; yaw: number; height: number; moving: boolean }
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
  return ['idle', 'walk', 'run', 'flee', 'carry', 'haul', 'guard'].includes(anim);
}
export function signifierLayers(direction: SpriteDirection, body: number, frame: number) {
  return [
    {sheet: `bodies-${direction}`, column: frame, row: body, dx: 0, dy: 0},
    {sheet: `heads-${direction}`, column: 0, row: 0, dx: direction === 'front' ? -3 : 0, dy: frame % 2 ? 2 : 4},
    ...(direction === 'away' && body === 6 ? [{sheet: 'flag-away', column: frame, row: 0, dx: 0, dy: 0}] : []),
  ];
}
interface Sheet { x: number; y: number; w: number; h: number; cellWidth: number; cellHeight: number; columns: number; rows: number; anchor: number[]; footYByCell?: number[][] }
const sheets: Record<string, Sheet> = atlas.sheets;

export class MobileSprites {
  readonly enabled = true;
  atlasReady = false;
  atlasError = false;
  spriteCount = 0;
  layerCount = 0;
  fallbackCount = 0;
  capacity = 0;
  readonly samples: {id: number; kind: string; direction: SpriteDirection; frame: number; layers: number; head?: number; body?: number}[] = [];
  get batchCount(): number { return this.layerCount > 0 ? 1 : 0; }
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly texture: THREE.Texture;
  private disposed = false;
  private readonly directions = new Map<number, SpriteDirection>();
  private readonly seen = new Set<number>();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private centers!: THREE.InstancedBufferAttribute;
  private sizes!: THREE.InstancedBufferAttribute;
  private rects!: THREE.InstancedBufferAttribute;
  private offsets!: THREE.InstancedBufferAttribute;
  constructor(private readonly ctx: RenderContext) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3));
    geometry.setIndex([0,1,2,0,2,3]); geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { map: {value: null}, uRight: {value: this.right}, uToward: {value: new THREE.Vector3()} },
      vertexShader: `attribute vec3 aCenter; attribute vec2 aSize; attribute vec4 aRect; attribute vec3 aOffset;
        uniform vec3 uRight; uniform vec3 uToward; varying vec2 vUv;
        void main(){vUv=aRect.xy+position.xy*aRect.zw;
          vec3 p=aCenter+uRight*((position.x-.5)*aSize.x+aOffset.x)+vec3(0.,position.y*aSize.y+aOffset.y,0.)+uToward*aOffset.z;
          gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);}`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv;
        void main(){vec4 c=texture2D(map,vUv);if(c.a<.5)discard;gl_FragColor=vec4(c.rgb,1.);
        #include <colorspace_fragment>
        }`,
      depthTest: true, depthWrite: true, side: THREE.DoubleSide, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material); this.mesh.name = 'mobile-sprite-batch'; this.mesh.frustumCulled = false;
    ctx.scene.add(this.mesh); this.grow(768);
    // No DOM overlays, canvases, or per-actor textures. Keep 3D until decode succeeds.
    this.texture = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}assets/mobile-sprites/atlas.png`, texture => {
      if (this.disposed) { texture.dispose(); return; }
      if (texture.image.width !== atlas.width || texture.image.height !== atlas.height || ctx.renderer.capabilities.maxTextureSize < atlas.height) {
        this.atlasError = true; return;
      }
      this.atlasReady = true;
    }, undefined, () => { if (!this.disposed) this.atlasError = true; });
    this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.magFilter = THREE.NearestFilter; this.texture.minFilter = THREE.NearestFilter;
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
    // Release old GPU buffers before replacing attributes after a capacity increase.
    if (this.capacity) geometry.dispose();
    this.centers = replace('aCenter', this.centers, 3); this.sizes = replace('aSize', this.sizes, 2);
    this.rects = replace('aRect', this.rects, 4); this.offsets = replace('aOffset', this.offsets, 3); this.capacity = capacity;
  }
  begin(): void {
    this.spriteCount = this.layerCount = this.fallbackCount = 0; this.seen.clear(); this.samples.length = 0;
    this.ctx.camera.updateMatrixWorld(); this.ctx.camera.getWorldDirection(this.cameraDirection);
    this.right.setFromMatrixColumn(this.ctx.camera.matrixWorld, 0); this.right.y = 0; this.right.normalize();
    this.mesh.material.uniforms.uToward.value.copy(this.cameraDirection).negate();
  }
  private direction(p: SpritePose): SpriteDirection {
    // Orthographic projection has parallel rays, regardless of the actor's location.
    const orthographic = (this.ctx.camera as THREE.OrthographicCamera).isOrthographicCamera;
    const dx = orthographic ? -this.cameraDirection.x : this.ctx.camera.position.x - p.x;
    const dz = orthographic ? -this.cameraDirection.z : this.ctx.camera.position.z - p.z;
    const direction = spriteDirection(p.yaw, dx, dz, this.directions.get(p.id));
    this.directions.set(p.id, direction); this.seen.add(p.id); return direction;
  }
  fallback(): false { this.fallbackCount++; return false; }
  cast(index: number, p: SpritePose, supported = true): boolean {
    this.seen.add(p.id);
    const sheet = sheets[CAST_SHEETS[index]];
    if (!supported || !this.atlasReady || !sheet) return this.fallback();
    const direction = this.direction(p), frame = spriteFrame(this.ctx.time, p.id, p.moving);
    if (this.samples.length < 32) this.samples.push({id: p.id, kind: CAST_SHEETS[index], direction, frame, layers: 1});
    const row = direction === 'front' ? 0 : 1;
    this.layer(sheet, frame, row, p, p.height / 224, 0, 0, 0, sheet.footYByCell?.[row]?.[frame]);
    this.spriteCount++; return true;
  }
  signifier(p: SpritePose, head: number, body: number, supported = true): boolean {
    this.seen.add(p.id);
    if (!supported || !this.atlasReady || head < 0 || head >= 18 || body < 0 || body >= 7) return this.fallback();
    const direction = this.direction(p), frame = spriteFrame(this.ctx.time, p.id, p.moving);
    const layers = signifierLayers(direction, body, frame);
    // Normalize source foot drift once per pose, never separately per modular layer.
    const footY = sheets[`bodies-${direction}`].footYByCell?.[body]?.[frame];
    if (this.samples.length < 32) this.samples.push({id: p.id, kind: 'signifier', direction, frame, layers: layers.length, head, body});
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      this.layer(sheets[l.sheet], i === 1 ? head % 6 : l.column, i === 1 ? Math.floor(head / 6) : l.row, p, p.height / 142, l.dx, l.dy, i, footY);
    }
    this.spriteCount++; return true;
  }
  private layer(s: Sheet, col: number, row: number, p: SpritePose, scale: number, dx: number, dy: number, order: number, footY = s.anchor[1]): void {
    this.grow(this.layerCount + 1); const i = this.layerCount++;
    this.centers.setXYZ(i, p.x, p.y, p.z); this.sizes.setXY(i, s.cellWidth * scale, s.cellHeight * scale);
    this.offsets.setXYZ(i, dx * scale, (footY - s.cellHeight - dy) * scale, order * .003);
    // TextureLoader flips PNG rows; atlas metadata is top-left origin.
    this.rects.setXYZW(i, (s.x + col * s.cellWidth + .5) / atlas.width,
      1 - (s.y + (row + 1) * s.cellHeight - .5) / atlas.height,
      (s.cellWidth - 1) / atlas.width, (s.cellHeight - 1) / atlas.height);
  }
  end(): void {
    this.mesh.geometry.instanceCount = this.layerCount;
    for (const a of [this.centers, this.sizes, this.rects, this.offsets]) { a.clearUpdateRanges(); a.addUpdateRange(0, this.layerCount * a.itemSize); a.needsUpdate = true; }
    for (const id of this.directions.keys()) if (!this.seen.has(id)) this.directions.delete(id);
  }
  dispose(): void { this.disposed = true; this.atlasReady = false; this.ctx.scene.remove(this.mesh); this.texture.dispose(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.directions.clear(); }
}
