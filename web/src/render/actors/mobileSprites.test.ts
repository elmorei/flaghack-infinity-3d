import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RenderContext } from '../context';
import atlas from './mobileSpriteAtlas.json';
import { HL } from './hippieModel';
import { CAST_SHEETS, MobileSprites, signifierBody, signifierHead, signifierLayers, spriteDirection, spriteFrame, supportsSignifierAnimation, type SpritePose } from './mobileSprites';
const pose = (id = 0, yaw = 0): SpritePose => ({id, x: 0, y: 0, z: 0, yaw, height: 2.24, moving: false});
let texture: THREE.Texture<HTMLImageElement>, loaded: (texture: THREE.Texture<HTMLImageElement>) => void, failed: () => void;
const instances: MobileSprites[] = [];
function setup(ready = true, maxTextureSize = 4096, ortho = false) {
  const camera = ortho ? new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 100) : new THREE.PerspectiveCamera(60, 1, .1, 100);
  camera.position.set(0, 8, 12); camera.lookAt(0, 0, 0);
  const ctx = {scene: new THREE.Scene(), camera, renderer: {capabilities: {maxTextureSize}}, time: 0} as unknown as RenderContext;
  const sprites = new MobileSprites(ctx); instances.push(sprites);
  if (ready) loaded(texture); sprites.begin(); return {sprites, ctx};
}
function expectCell(sprites: MobileSprites, index: number, key: keyof typeof atlas.sheets, column: number, row: number) {
  const s = atlas.sheets[key], a = sprites.mesh.geometry.getAttribute('aRect');
  const expected = [(s.x + column * s.cellWidth + .5) / atlas.width, 1 - (s.y + (row + 1) * s.cellHeight - .5) / atlas.height, (s.cellWidth - 1) / atlas.width, (s.cellHeight - 1) / atlas.height];
  [a.getX(index), a.getY(index), a.getZ(index), a.getW(index)].forEach((n, i) => expect(n).toBeCloseTo(expected[i], 6));
}
beforeEach(() => {
  texture = new THREE.Texture<HTMLImageElement>(); texture.image = {width: atlas.width, height: atlas.height} as HTMLImageElement;
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad, _progress, onError) => {
    loaded = onLoad!; failed = () => onError?.(new Error('decode failed')); return texture;
  });
});
afterEach(() => { for (const s of instances.splice(0)) s.dispose(); vi.restoreAllMocks(); });

describe('mobile sprite mapping', () => {
  it('maps four leaders, wizard and boss to approved sheets', () => {
    expect([...CAST_SHEETS]).toEqual(['dr-beef-supreme', 'beelzebub-crow', 'dj-scarecrow', 'president-jaguar', 'frick-frack-wizard', 'skeletal-boss']);
    const {sprites} = setup();
    CAST_SHEETS.forEach((key, i) => {expect(sprites.cast(i, pose(i))).toBe(true); expectCell(sprites, i, key, 0, 0);});
    expect(sprites.spriteCount).toBe(6);
  });
  it('has deterministic, ID-offset walk frames and stable idle', () => {
    expect([0, .141, .281, .421, .561].map(t => spriteFrame(t, 0, true))).toEqual([0, 1, 2, 3, 0]);
    expect([0, 1, 2, 3].map(id => spriteFrame(0, id, true))).toEqual([0, 1, 2, 3]);
    expect(spriteFrame(5.32, 77, true)).toBe(spriteFrame(5.32, 77, true));
    expect(spriteFrame(12345, 3, false)).toBe(0); expect(spriteFrame(-1, 0, true)).toBe(0);
  });
  it('maps heads with hat, glasses and beard priority over hair', () => {
    const look = new Float32Array(16);
    for (let i = 0; i < 5; i++) {look[HL.hairStyle] = i; expect(signifierHead(look)).toBe(i);}
    look[HL.beard] = 1; expect(signifierHead(look)).toBe(5);
    look[HL.glasses] = 1; expect(signifierHead(look)).toBe(11);
    look[HL.glasses] = 2; expect(signifierHead(look)).toBe(12);
    for (let i = 1; i <= 5; i++) {look[HL.hat] = i; expect(signifierHead(look)).toBe(5 + i);}
  });
  it('maps equipment with flag and lumber priority', () => {
    expect(signifierBody(true, true, 'building', true)).toBe(6);
    expect(signifierBody(false, true, 'building', true)).toBe(4);
    for (const [status, body] of [['chopping', 1], ['building', 2], ['repairing', 2], ['drumming', 3]] as const) expect(signifierBody(false, false, status, true)).toBe(body);
    expect(signifierBody(false, false, 'idle', true)).toBe(5); expect(signifierBody(false, false, 'idle', false)).toBe(0);
  });
  it('supports locomotion and falls back for action or unknown animations', () => {
    for (const anim of ['idle', 'walk', 'run', 'flee', 'carry', 'haul', 'guard']) expect(supportsSignifierAnimation(anim)).toBe(true);
    for (const anim of ['attack', 'chop', 'build', 'drum', 'dance', 'death', 'unknown']) expect(supportsSignifierAnimation(anim)).toBe(false);
    const {sprites} = setup(); expect(sprites.signifier(pose(), 0, 0, false)).toBe(false); expect(sprites.cast(0, pose(), false)).toBe(false);
    expect(sprites.layerCount).toBe(0); expect(sprites.fallbackCount).toBe(2);
  });
});
describe('directions and layered composition', () => {
  it('uses camera-relative front/rear and side-on hysteresis', () => {
    expect(spriteDirection(0, 0, 1)).toBe('front'); expect(spriteDirection(0, 0, -1)).toBe('away');
    expect(spriteDirection(Math.PI / 2, 1, 0)).toBe('front'); expect(spriteDirection(Math.PI / 2, -1, 0)).toBe('away');
    expect(spriteDirection(0, 1, .05, 'away')).toBe('away'); expect(spriteDirection(0, 1, -.05, 'front')).toBe('front');
    expect(spriteDirection(0, 0, 0, 'away')).toBe('away');
  });
  it('uses parallel orthographic camera rays for every position', () => {
    const {sprites} = setup(true, 4096, true);
    sprites.cast(0, {...pose(1), z: 40}); sprites.cast(0, {...pose(2), z: -40});
    expectCell(sprites, 0, 'dr-beef-supreme', 0, 0); expectCell(sprites, 1, 'dr-beef-supreme', 0, 0);
  });
  it('preserves independent head bob and rear foreground order', () => {
    for (let frame = 0; frame < 4; frame++) {
      const front = signifierLayers('front', 6, frame), rear = signifierLayers('away', 6, frame);
      expect(front.map(l => l.sheet)).toEqual(['bodies-front', 'heads-front']);
      expect(rear.map(l => l.sheet)).toEqual(['bodies-away', 'heads-away', 'flag-away']);
      expect([front[1].dx, front[1].dy]).toEqual([-3, frame % 2 ? 2 : 4]);
      expect([rear[1].dx, rear[1].dy]).toEqual([0, frame % 2 ? 2 : 4]);
      expect([rear[2].dx, rear[2].dy]).toEqual([0, 0]);
    }
    expect(signifierLayers('away', 0, 0)).toHaveLength(2);
  });
  it('selects modular atlas cells and body-aligned foreground', () => {
    const {sprites} = setup(); sprites.signifier(pose(0, Math.PI), 17, 6);
    expectCell(sprites, 0, 'bodies-away', 0, 6); expectCell(sprites, 1, 'heads-away', 5, 2); expectCell(sprites, 2, 'flag-away', 0, 0);
    const a = sprites.mesh.geometry.getAttribute('aOffset');
    expect(a.getY(0)).toBeCloseTo((atlas.sheets['bodies-away'].footYByCell[6][0] - 160) * pose().height / 142);
    expect(a.getY(1)).toBeCloseTo((atlas.sheets['bodies-away'].footYByCell[6][0] - 160 - 4) * pose().height / 142);
    expect(a.getY(0)).toBeCloseTo(a.getY(2)); expect(a.getY(1)).toBeLessThan(a.getY(0));
    expect(a.getZ(0)).toBeLessThan(a.getZ(1)); expect(a.getZ(1)).toBeLessThan(a.getZ(2));
  });
});
describe('batch fallback and lifecycle', () => {
  it('keeps models until texture decode succeeds', () => {
    const {sprites} = setup(false);
    expect(sprites.cast(0, pose())).toBe(false); expect(sprites.signifier(pose(), 0, 0)).toBe(false); expect(sprites.layerCount).toBe(0);
    loaded(texture); expect(sprites.cast(0, pose())).toBe(true);
  });
  it('falls back on texture failure', () => {
    const {sprites} = setup(false); failed(); expect(sprites.atlasError).toBe(true); expect(sprites.atlasReady).toBe(false);
    expect(sprites.cast(0, pose())).toBe(false); expect(sprites.signifier(pose(), 0, 0)).toBe(false);
  });
  it.each([2048, 1024])('falls back on max texture size %i', size => {
    const {sprites} = setup(true, size); expect(sprites.atlasError).toBe(true); expect(sprites.cast(0, pose())).toBe(false);
  });
  it('rejects a decoded image of unexpected size', () => {
    const {sprites} = setup(false); texture.image = {width: 1024, height: 1024} as HTMLImageElement; loaded(texture);
    expect(sprites.atlasError).toBe(true); expect(sprites.atlasReady).toBe(false);
  });
  it('rejects invalid sheet, head and body indexes', () => {
    const {sprites} = setup(); expect(sprites.cast(6, pose())).toBe(false); expect(sprites.cast(-1, pose())).toBe(false);
    for (const [head, body] of [[18, 0], [0, 7], [-1, 0], [0, -1]]) expect(sprites.signifier(pose(), head, body)).toBe(false);
    expect(sprites.layerCount).toBe(0); expect(sprites.fallbackCount).toBe(6);
  });
  it('grows past 200 sprites and 600 layers, preserving all earlier attributes', () => {
    const {sprites} = setup(true, 4096, true), capacity = sprites.capacity;
    for (let id = 0; id < 500; id++) expect(sprites.signifier({...pose(id, Math.PI), x: id}, id % 18, 6)).toBe(true);
    sprites.end(); expect(sprites.spriteCount).toBe(500); expect(sprites.layerCount).toBe(1500);
    expect(sprites.capacity).toBeGreaterThan(capacity); expect(sprites.capacity).toBeGreaterThanOrEqual(1500);
    expect(sprites.mesh.geometry.instanceCount).toBe(1500); expect(sprites.batchCount).toBe(1);
    const a = sprites.mesh.geometry.getAttribute('aCenter'); expect(a.getX(0)).toBe(0); expect(a.getX(1499)).toBe(499);
    expectCell(sprites, 0, 'bodies-away', 0, 6); expectCell(sprites, 1499, 'flag-away', 0, 0);
  });
  it('resets counters and GPU instances on the next empty frame', () => {
    const {sprites} = setup(); sprites.cast(0, pose()); sprites.end(); sprites.begin(); sprites.end();
    expect(sprites.spriteCount).toBe(0); expect(sprites.layerCount).toBe(0); expect(sprites.fallbackCount).toBe(0);
    expect(sprites.batchCount).toBe(0); expect(sprites.mesh.geometry.instanceCount).toBe(0);
  });
  it('uses depth-writing cutout material, not always-on-top overlays', () => {
    const {sprites} = setup(), material = sprites.mesh.material;
    expect(material.depthTest).toBe(true); expect(material.depthWrite).toBe(true); expect(material.transparent).toBe(false);
    expect(material.fragmentShader).toContain('discard'); expect(texture.generateMipmaps).toBe(false);
    expect(texture.magFilter).toBe(THREE.NearestFilter); expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
  });
  it('disposes GPU/scene resources and ignores delayed load', () => {
    const {sprites, ctx} = setup(false);
    const t = vi.spyOn(texture, 'dispose'), g = vi.spyOn(sprites.mesh.geometry, 'dispose'), m = vi.spyOn(sprites.mesh.material, 'dispose');
    sprites.dispose(); loaded(texture); expect(ctx.scene.children).not.toContain(sprites.mesh); expect(sprites.atlasReady).toBe(false);
    expect(sprites.cast(0, pose())).toBe(false); expect(sprites.signifier(pose(), 0, 0)).toBe(false);
    expect(t).toHaveBeenCalled(); expect(g).toHaveBeenCalled(); expect(m).toHaveBeenCalled();
  });
  it('constructs the batch only behind the mobile presentation gate', () => {
    const source = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/if\s*\(this\.mobilePresentation\)\s*ctx\.shared\.mobileSprites\s*=\s*new MobileSprites\(ctx\)/);
    expect(source.match(/new MobileSprites\(/g)).toHaveLength(1);
  });
});


describe('avatar equipment source contract', () => {
  it('does not exclude carried flags from sprites and pushes exactly the carried count', () => {
    const source = readFileSync(new URL('./avatarRenderer.ts', import.meta.url), 'utf8');
    const selection = source.slice(source.indexOf('const sprite = !hidden'), source.indexOf('v.rig.mesh.visible = !hidden'));
    expect(selection).toContain('mobileSprites?.cast'); expect(selection).not.toContain('carried');
    expect(source).toMatch(/if \(!hidden\) \{[\s\S]*?this\.pushQuiver\(v, av\)/);
    const quiver = source.slice(source.indexOf('private pushQuiver'));
    expect(quiver).toContain('const n = av.carried.length'); expect(quiver).toContain('for (let i = 0; i < n; i++)');
    expect(quiver).toContain('const id = av.carried[i]'); expect(quiver.match(/this\.flags\.pushMatrix\(/g)).toHaveLength(1);
  });
});


it('reports CPU-only 256/512-unit batch preparation diagnostics without FPS claims', () => {
  const {sprites} = setup(true, 4096, true);
  for (const count of [256, 512]) {
    const frames = 30, started = performance.now();
    for (let frame = 0; frame < frames; frame++) {
      sprites.begin();
      for (let id = 0; id < count; id++) sprites.signifier({...pose(id, Math.PI), x: id}, id % 18, 6);
      sprites.end();
    }
    const millisecondsPerFrame = (performance.now() - started) / frames;
    console.info(`CPU-only sprite preparation: ${count} units / ${count * 3} layers, ${millisecondsPerFrame.toFixed(3)} ms/frame (no GPU render, not device FPS)`);
    expect(sprites.spriteCount).toBe(count); expect(sprites.layerCount).toBe(count * 3);
    expect(Number.isFinite(millisecondsPerFrame)).toBe(true);
  }
});
