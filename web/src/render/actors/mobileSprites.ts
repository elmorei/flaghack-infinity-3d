/** Mobile presentation only. Screen-facing, foot-anchored cutout batches; never writes World. */
import * as THREE from 'three';
import atlas from './mobileSpriteAtlas.json';
import actionsData from './mobileSpriteActions.json';
import worldData from './mobileSpriteWorld.json';
import buildingsData from './mobileSpriteBuildings.json';
import type { RenderContext } from '../context';
import { HL, HIPPIE_SKIN_TONES } from './hippieModel';
import { GCC_TABLE_MAP_SIZE } from '../structures/tableMap';

export const MOBILE_CHARACTER_SCALE = 2;
/** Opaque cutouts follow opaque-pass ground ink; transparent gameplay effects remain later. */
export const MOBILE_SPRITE_ORDER = 13;

export const CAST_SHEETS = ['dr-beef-supreme', 'beelzebub-crow', 'dj-scarecrow', 'president-jaguar', 'frick-frack-wizard', 'skeletal-boss'] as const;
export type SpriteDirection = 'front' | 'away';
export type FlagSpriteState = 'planted' | 'ground' | 'thrown' | 'carried';
export interface SpritePose {
  id: number; x: number; y: number; z: number; yaw: number; height: number; moving: boolean;
  /** Seconds since a one-shot pose began; looping clips use the presentation clock. */
  animationTime?: number;
  /** Natural character height when an assembly clip falls back to default art. */
  fallbackHeight?: number;
  /** Seeded desktop palette index, applied only to authored skin-mask pixels. */
  skinTone?: number;
}
export interface ObjectSpriteStyle {
  state?: string; ownerColor?: THREE.Color; tint?: THREE.Color; heatColor?: THREE.Color; buildProgress?: number; progress?: number;
  damage?: number; disabled?: boolean; highlight?: number; rotation?: number; scaleX?: number;
  width?: number; opacity?: number; tableYaw?: number; ghost?: boolean; frame?: number; cropTop?: number;
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
  columns: number; rows: number; anchor: number[]; sourceCellWidth?: number; footYByCell?: number[][];
}
interface ActionClip extends Sheet {
  page: number; frameDurationMs: number; loop: boolean; directionRows: {front: number; away: number; right?: number; left?: number};
  heightPixels: number; worldHeight?: number; headAnchorByCell?: number[][][]; headRotationByCell?: number[][]; poleTipByCell?: number[][][]; includesFurniture?: boolean; includesFlag?: boolean;
}
interface ActionManifest { pages: {image: string; width: number; height: number}[]; clips: Record<string, ActionClip> }
const actions = actionsData as ActionManifest;
const worldSource = worldData as ActionManifest, buildingSource = buildingsData as ActionManifest;
const worldAtlas: ActionManifest = {
  pages: [...worldSource.pages, ...buildingSource.pages],
  clips: {...worldSource.clips, ...Object.fromEntries(Object.entries(buildingSource.clips)
    .map(([key, clip]) => [key, {...clip, page: clip.page + worldSource.pages.length}]))},
};
const sheets: Record<string, Sheet> = atlas.sheets;
const WHITE = new THREE.Color(1, 1, 1);
const HIGHLIGHT = new THREE.Color(1.2, 1.2, 1.2);
const SKIN_COLORS = HIPPIE_SKIN_TONES.map(color => new THREE.Color(color));
const SKIN_REFERENCE_LUMA = SKIN_COLORS[1].r * .2126 + SKIN_COLORS[1].g * .7152 + SKIN_COLORS[1].b * .0722;
export const SPRITE_SKIN_ALPHA = 192;

/** Camera-space offsets keep the quads screen-parallel at every camera pitch and roll. */
export const SPRITE_VERTEX_SHADER = `attribute vec3 aCenter; attribute vec2 aSize; attribute vec4 aRect; attribute vec3 aOffset; attribute vec3 aTint; attribute float aRotation; attribute float aGlitch; attribute vec4 aRibbon; attribute vec4 aSkin; attribute vec4 aWorld; attribute vec4 aOwner; attribute vec4 aHeat; attribute vec2 aTable;
  varying vec2 vUv; varying vec3 vTint; varying float vGlitch; varying vec4 vRibbon; varying vec4 vSkin; varying vec4 vWorld; varying vec4 vOwner; varying float vLocalY; varying vec4 vHeat; varying vec2 vTable;
  void main(){vUv=aRect.xy+position.xy*aRect.zw;vTint=aTint;vGlitch=aGlitch;vRibbon=aRibbon;vSkin=aSkin;vWorld=aWorld;vOwner=aOwner;vLocalY=position.y;vHeat=aHeat;vTable=aTable;
    vec4 p=viewMatrix*vec4(aCenter,1.);
    vec2 q=vec2((position.x-.5)*aSize.x+aOffset.x,position.y*aSize.y+aOffset.y);
    float c=cos(aRotation),s=sin(aRotation);p.xy+=mat2(c,s,-s,c)*q;
    p.z+=aOffset.z;
    gl_Position=projectionMatrix*p;}`;

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
  private tables!: THREE.InstancedBufferAttribute;
  private heat!: THREE.InstancedBufferAttribute;
  private worldStyles!: THREE.InstancedBufferAttribute;
  private owners!: THREE.InstancedBufferAttribute;
  private skins!: THREE.InstancedBufferAttribute;
  private ribbons!: THREE.InstancedBufferAttribute;
  private glitches!: THREE.InstancedBufferAttribute;
  private rotations!: THREE.InstancedBufferAttribute;
  private tints!: THREE.InstancedBufferAttribute;
  constructor(private readonly ctx: RenderContext, readonly width: number, readonly height: number, source: string | THREE.Texture, name: string) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3));
    geometry.setIndex([0,1,2,0,2,3]); geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: {map: {value: null}, uTime: {value: 0}, uSkinReferenceLuma: {value: SKIN_REFERENCE_LUMA}, uTableMap: {value: null}, uTableReady: {value: 0}, uTableSpan: {value: GCC_TABLE_MAP_SIZE}}, vertexShader: SPRITE_VERTEX_SHADER,
      fragmentShader: `uniform sampler2D map; uniform float uTime; uniform float uSkinReferenceLuma; uniform sampler2D uTableMap; uniform float uTableReady; uniform float uTableSpan; varying vec2 vUv; varying vec3 vTint; varying float vGlitch; varying vec4 vRibbon; varying vec4 vSkin; varying vec4 vWorld; varying vec4 vOwner; varying float vLocalY; varying vec4 vHeat; varying vec2 vTable;
        void main(){vec4 c=texture2D(map,vUv);if(c.a<.5)discard;
        // Alpha160 carries sRGB-encoded local tabletop coordinates. Texture decode
        // restores linear RG, so this samples the existing live, heading-correct map.
        float table=1.-step(.5/255.,abs(c.a-160./255.));
        if(table>.5){
          vec2 local=c.rg*2.-1.;
          vec2 world=vec2(local.x*vTable.x+local.y*vTable.y,-local.x*vTable.y+local.y*vTable.x);
          c.rgb=uTableReady>.5?texture2D(uTableMap,vec2(.5+world.x/uTableSpan,.5-world.y/uTableSpan)).rgb:vec3(.12,.22,.16);
        }
        // Explicit alpha-encoded authoring mask: never recolor by hue or region guesses.
        float skin=(1.-step(.5/255.,abs(c.a-${SPRITE_SKIN_ALPHA}./255.)))*vSkin.a;
        float shade=clamp(dot(c.rgb,vec3(.2126,.7152,.0722))/uSkinReferenceLuma,.2,1.25);
        c.rgb=mix(c.rgb,vSkin.rgb*shade,skin);
        float owner=(1.-step(.5/255.,abs(c.a-224./255.)))*vOwner.a;
        c.rgb=mix(c.rgb,vOwner.rgb*max(c.r,max(c.g,c.b)),owner);
        c.rgb=mix(c.rgb,vHeat.rgb*max(c.r,max(c.g,c.b)),vHeat.a);
        if(vLocalY>vWorld.w)discard;
        float ghost=max(vWorld.z,step(vWorld.x,vLocalY));
        vec3 ghostColor=vWorld.z>.5?vOwner.rgb:vec3(.12,.8,1.);
        c.rgb=mix(c.rgb,ghostColor*(.35+.65*dot(c.rgb,vec3(.2126,.7152,.0722))),ghost);
        float opacity=vWorld.y*mix(1.,.4,ghost);
        float dither=mod(floor(gl_FragCoord.x)*3.+floor(gl_FragCoord.y)*5.,16.)/16.;
        if(dither>=opacity)discard;
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
    // Cutout pixels cover ground ink but remain depth-occluded by real scenery.
    this.mesh.renderOrder = MOBILE_SPRITE_ORDER;
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
    this.tables = replace('aTable', this.tables, 2);
    this.heat = replace('aHeat', this.heat, 4);
    this.worldStyles = replace('aWorld', this.worldStyles, 4); this.owners = replace('aOwner', this.owners, 4);
    this.skins = replace('aSkin', this.skins, 4);
    this.centers = replace('aCenter', this.centers, 3); this.sizes = replace('aSize', this.sizes, 2);
    this.rects = replace('aRect', this.rects, 4); this.offsets = replace('aOffset', this.offsets, 3);
    this.tints = replace('aTint', this.tints, 3); this.rotations = replace('aRotation', this.rotations, 1); this.glitches = replace('aGlitch', this.glitches, 1); this.ribbons = replace('aRibbon', this.ribbons, 4); this.capacity = capacity;
  }
  layer(s: Sheet, col: number, row: number, p: SpritePose, scale: number, dx = 0, dy = 0, order = 0, footY = s.anchor[1], tint = WHITE, rotation = 0, glitch = 0, ribbon?: THREE.Color, world?: ObjectSpriteStyle): void {
    this.grow(this.count + 1); const i = this.count++;
    this.centers.setXYZ(i, p.x, p.y, p.z); this.sizes.setXY(i, s.cellWidth * scale, s.cellHeight * scale);
    this.offsets.setXYZ(i, (s.cellWidth / 2 - s.anchor[0] + dx) * scale, (footY - s.cellHeight - dy) * scale, order * .003);
    const widthScale = world?.width === undefined ? world?.scaleX ?? 1 : world.width / ((s.sourceCellWidth ?? s.cellWidth) * scale);
    this.sizes.setX(i, s.cellWidth * scale * widthScale); this.offsets.setX(i, this.offsets.getX(i) * widthScale);
    const fraction = Math.max(0, Math.min(1, world?.buildProgress ?? world?.progress ?? 1));
    const visibleHeight = 'heightPixels' in s ? (s as ActionClip).heightPixels : s.cellHeight;
    const bottom = 1 - footY / s.cellHeight, range = visibleHeight / s.cellHeight;
    const crop = Math.max(0, Math.min(1, world?.cropTop ?? 0));
    this.worldStyles.setXYZW(i, fraction === 1 ? 2 : bottom + range * fraction,
      Math.max(0, Math.min(1, world?.opacity ?? 1)), world?.ghost ? 1 : 0, crop ? bottom + range * (1 - crop) : 2);
    const tableYaw = world?.tableYaw ?? p.yaw; this.tables.setXY(i, Math.cos(tableYaw), Math.sin(tableYaw));
    this.heat.setXYZW(i, world?.heatColor?.r ?? 1, world?.heatColor?.g ?? 1, world?.heatColor?.b ?? 1, world?.heatColor ? 1 : 0);
    this.owners.setXYZW(i, world?.ownerColor?.r ?? 1, world?.ownerColor?.g ?? 1, world?.ownerColor?.b ?? 1, world?.ownerColor ? 1 : 0);
    const skin = p.skinTone === undefined ? undefined : SKIN_COLORS[p.skinTone];
    this.skins.setXYZW(i, skin?.r ?? 1, skin?.g ?? 1, skin?.b ?? 1, skin ? 1 : 0);
    this.tints.setXYZ(i, tint.r, tint.g, tint.b); this.rotations.setX(i, rotation); this.glitches.setX(i, glitch); this.ribbons.setXYZW(i, ribbon?.r ?? 1, ribbon?.g ?? 1, ribbon?.b ?? 1, ribbon ? 1 : 0);
    // Exact cell edges preserve source pixel-edge anchors. With nearest sampling and
    // transparent cell borders, half-texel shrinking would move the visible pole tip.
    this.rects.setXYZW(i, (s.x + col * s.cellWidth) / this.width,
      1 - (s.y + (row + 1) * s.cellHeight) / this.height,
      s.cellWidth / this.width, s.cellHeight / this.height);
  }
  end(): void {
    this.mesh.material.uniforms.uTime.value = this.ctx.time;
    const table = this.ctx.shared?.gccTableTexture;
    this.mesh.material.uniforms.uTableMap.value = table ?? null; this.mesh.material.uniforms.uTableReady.value = table ? 1 : 0;
    this.mesh.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    for (const a of [this.centers, this.sizes, this.rects, this.offsets, this.tints, this.rotations, this.glitches, this.ribbons, this.skins, this.worldStyles, this.owners, this.heat, this.tables]) {
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
  const width = 128, height = 32, bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cell = Math.floor(x / 16), px = x % 16;
    const person = ((px - 7.5) ** 2 + (y - 5) ** 2 <= 15) || (y >= 10 && y <= 23 && px >= 3 && px <= 12) || (y >= 23 && y <= 30 && ((px >= 4 && px <= 6) || (px >= 9 && px <= 11)));
    const flag = (px >= 3 && px <= 4 && y >= 2 && y <= 30) || (px >= 5 && px <= 14 && y >= 2 && y <= 11);
    const marker = (px - 7.5) ** 2 + (y - 16) ** 2 <= 36;
    const ground = (y === 29 && px >= 1 && px <= 14) || (px >= 3 && px <= 9 && y >= 22 && y <= 28);
    const house = (y >= 12 && y <= 30 && px >= 2 && px <= 13) || (y >= 5 && y <= 12 && Math.abs(px - 7.5) <= y - 4);
    const tree = (y >= 2 && y <= 22 && Math.abs(px - 7.5) <= 1 + (y - 2) * .32) || (y >= 22 && y <= 30 && px >= 7 && px <= 8);
    const pile = y >= 21 && y <= 30 && Math.abs(px - 7.5) <= (y - 20) * .75;
    const scaffold = y >= 3 && y <= 30 && ((px >= 3 && px <= 4) || (px >= 11 && px <= 12) || ((y === 8 || y === 17 || y === 26) && px >= 3 && px <= 12));
    if (!(cell === 0 ? person : cell === 1 ? flag : cell === 2 ? marker : cell === 3 ? ground : cell === 4 ? house : cell === 5 ? tree : cell === 6 ? pile : scaffold)) continue;
    const i = ((height - 1 - y) * width + x) * 4;
    bytes[i] = (cell === 1 || cell === 3) ? 255 : 230; bytes[i + 1] = (cell === 1 || cell === 3) ? 222 : 230; bytes[i + 2] = (cell === 1 || cell === 3) ? 72 : 230; bytes[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(bytes, width, height); texture.needsUpdate = true; return texture;
}
const PLACEHOLDER_SHEET: Sheet = {x: 0, y: 0, w: 128, h: 32, cellWidth: 16, cellHeight: 32, columns: 8, rows: 1, anchor: [8, 31]};
interface SpriteSample {id: number; kind: string; direction: SpriteDirection | 'right' | 'left'; frame: number; layers: number; head?: number; body?: number; skinTone?: number; clip?: string; requestedClip?: string; placeholder?: boolean}

export class MobileSprites {
  readonly enabled = true;
  get atlasReady(): boolean { return this.base.ready; }
  get atlasError(): boolean { return this.base.error; }
  get actionAtlasReady(): boolean { return this.pages.every(page => page.ready); }
  get actionAtlasError(): boolean { return this.pages.some(page => page.error); }
  get worldAtlasReady(): boolean { return this.worldPages.every(page => page.ready); }
  get worldAtlasError(): boolean { return this.worldPages.some(page => page.error); }
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
  private readonly worldPages: SpriteBatch[];
  private readonly worldTint = new THREE.Color();
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
    this.worldPages = worldAtlas.pages.map((page, i) => new SpriteBatch(ctx, page.width, page.height, page.image, `mobile-sprite-world-${i}`));
    this.placeholders = new SpriteBatch(ctx, 128, 32, placeholderTexture(), 'mobile-sprite-placeholders');
    this.batches = [this.base, ...this.pages, ...this.worldPages, this.placeholders];
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
    this.placeholders.layer(PLACEHOLDER_SHEET, ground ? 3 : flag ? 1 : 0, 0, p, (p.fallbackHeight ?? p.height) / (ground ? 15 : 29), 0, 0, 0, ground ? 30 : 31, p.skinTone === undefined ? WHITE : SKIN_COLORS[p.skinTone] ?? WHITE, rotation);
    this.sample({id: p.id, kind, direction, frame: 0, layers: 1, skinTone: p.skinTone, placeholder: true});
    this.spriteCount++; this.layerCount++; this.fallbackCount++; return true;
  }
  private action(key: string, p: SpritePose, direction: SpriteDirection, manifest = actions, pages = this.pages, freeze = false): {clip: ActionClip; frame: number; row: number; batch: SpriteBatch} | null {
    const clip = manifest.clips[key], batch = clip && pages[clip.page];
    let state = this.animations.get(p.id);
    if (!state || state.key !== key) { state = {key, start: this.ctx.time}; this.animations.set(p.id, state); }
    if (!clip || !batch?.ready) return null;
    const time = clip.loop ? this.ctx.time : p.animationTime ?? this.ctx.time - state.start;
    const raw = Math.floor(Math.max(0, time) / (clip.frameDurationMs / 1000));
    const frame = freeze ? 0 : clip.loop ? (raw + Math.abs(p.id * 17 % clip.columns)) % clip.columns : Math.min(raw, clip.columns - 1);
    return {clip, frame, row: clip.directionRows[direction], batch};
  }
  /** Legacy false means use the default sprite, never expose the corresponding model. */
  cast(index: number, p: SpritePose, animation: string | boolean = true): boolean {
    if (this.disposed) return false;
    const key = CAST_SHEETS[index], sheet = sheets[key];
    if (!sheet) return false;
    p = {...p, height: p.height * MOBILE_CHARACTER_SCALE,
      fallbackHeight: p.fallbackHeight === undefined ? undefined : p.fallbackHeight * MOBILE_CHARACTER_SCALE};
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
    this.base.layer(sheet, frame, row, p, (p.fallbackHeight ?? p.height) / 224, 0, 0, 0, sheet.footYByCell?.[row]?.[frame]);
    this.sample({id: p.id, kind: key, direction, frame, layers: 1, clip: fallback ? 'idle' : requested, requestedClip: requested});
    if (fallback) this.fallbackCount++;
    this.spriteCount++; this.layerCount++; return true;
  }
  signifier(p: SpritePose, head: number, body: number, animation: string | boolean = true, carriedFlagColor?: THREE.Color): boolean {
    if (this.disposed || head < 0 || head >= 18 || body < 0 || body >= 7) return false;
    p = {...p, height: p.height * MOBILE_CHARACTER_SCALE,
      fallbackHeight: p.fallbackHeight === undefined ? undefined : p.fallbackHeight * MOBILE_CHARACTER_SCALE};
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
      this.sample({id: p.id, kind: 'signifier', direction, frame, layers: (neck ? 2 : 1) + (badge ? 1 : 0), head, body, skinTone: p.skinTone, clip: requested, requestedClip: requested});
      this.layerCount += neck ? 2 : 1; this.spriteCount++; return true;
    }
    if (!this.base.ready) return this.placeholder(p, 'signifier');
    const fallback = animation === false || !['idle', 'walk', 'run', 'flee', 'carry', 'haul', 'guard'].includes(requested);
    const frame = spriteFrame(this.ctx.time, p.id, fallback ? false : p.moving), layers = signifierLayers(direction, body, frame);
    const footY = sheets[`bodies-${direction}`].footYByCell?.[body]?.[frame];
    const badge = body === 6 && !!carriedFlagColor;
    this.sample({id: p.id, kind: 'signifier', direction, frame, layers: layers.length + (badge ? 1 : 0), head, body, skinTone: p.skinTone, clip: fallback ? 'idle' : requested, requestedClip: requested});
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
  building(kind: string, p: SpritePose, style: ObjectSpriteStyle = {}): boolean {
    return this.object(`building:${kind}`, p, style);
  }
  object(key: string, p: SpritePose, style: ObjectSpriteStyle = {}): boolean {
    if (this.disposed) return false;
    const requested = style.state ?? 'idle', direction = this.direction(p);
    let action = this.action(`${key}:${requested}`, p, direction, worldAtlas, this.worldPages, !p.moving);
    const fallback = !action;
    // An occupied Hearth's no-pole silhouette must never revert to the tall altar.
    if (!action && !(key === 'building:hearth' && requested === 'seated'))
      action = this.action(`${key}:idle`, p, direction, worldAtlas, this.worldPages, !p.moving);
    this.worldTint.copy(style.tint ?? WHITE).multiplyScalar((style.disabled ? .38 : 1) * (1 - Math.max(0, Math.min(1, style.damage ?? 0)) * .32) * (1 + .2 * Math.max(0, Math.min(1, style.highlight ?? 0))));
    if (action) {
      const {clip, batch} = action;
      let row = action.row, facing: SpriteSample['direction'] = direction;
      if (clip.directionRows.right !== undefined && clip.directionRows.left !== undefined) {
        const orthographic = (this.ctx.camera as THREE.OrthographicCamera).isOrthographicCamera;
        const dx = orthographic ? -this.cameraDirection.x : this.cameraPosition.x - p.x;
        const dz = orthographic ? -this.cameraDirection.z : this.cameraPosition.z - p.z;
        const quadrant = ((Math.round((Math.atan2(dx, dz) - p.yaw) / (Math.PI / 2)) % 4) + 4) % 4;
        facing = (['front', 'right', 'away', 'left'] as const)[quadrant]; row = clip.directionRows[facing]!;
      }
      const frame = style.frame === undefined ? action.frame : Math.max(0, Math.min(clip.columns - 1, Math.floor(style.frame)));
      batch.layer(clip, frame, row, p, p.height / clip.heightPixels, 0, 0, 0, clip.footYByCell?.[row]?.[frame],
        this.worldTint, style.rotation ?? 0, 0, undefined, style);
      this.sample({id: p.id, kind: key, direction: facing, frame, layers: 1, clip: fallback ? 'idle' : requested, requestedClip: requested});
      if (fallback) this.fallbackCount++;
    } else {
      // Recognizable flat silhouettes, never corresponding 3D models, while art loads.
      const cell = key.includes(':tree:') ? 5 : key.startsWith('pile:') || key.startsWith('wreckage:') ? 6 : key.startsWith('effigy:') ? 7 : 4;
      this.placeholders.layer(PLACEHOLDER_SHEET, cell, 0, p, p.height / 29, 0, 0, 0, 31,
        this.worldTint, style.rotation ?? 0, 0, undefined, style);
      this.sample({id: p.id, kind: key, direction, frame: 0, layers: 1, requestedClip: requested, placeholder: true});
      this.fallbackCount++;
    }
    this.spriteCount++; this.layerCount++; return true;
  }
  flag(p: SpritePose, state: FlagSpriteState, style: FlagSpriteStyle = {}): boolean {
    if (this.disposed) return false;
    const direction = this.direction(p);
    const action = this.action(`flag:${state}`, p, direction, actions, this.pages, !p.moving) ?? this.action('flag:planted', p, direction, actions, this.pages, !p.moving);
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
