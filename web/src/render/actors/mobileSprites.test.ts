import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RenderContext } from '../context';
import atlas from './mobileSpriteAtlas.json';
import actionAtlas from './mobileSpriteActions.json';
import { HL } from './hippieModel';
import { CAST_SHEETS, MobileSprites, signifierBody, signifierHead, signifierLayers, spriteDirection, spriteFrame, spriteUprightDepth, supportsSignifierAnimation, type SpritePose } from './mobileSprites';
const pose = (id = 0, yaw = 0): SpritePose => ({id, x: 0, y: 0, z: 0, yaw, height: 2.24, moving: false});
let texture: THREE.Texture<HTMLImageElement>, loaded: (texture: THREE.Texture<HTMLImageElement>) => void, failed: () => void;
const instances: MobileSprites[] = [];
const loads: {texture: THREE.Texture<HTMLImageElement>; loaded: () => void}[] = [];
function setup(ready = true, maxTextureSize = 4096, ortho = false) {
  const camera = ortho ? new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 100) : new THREE.PerspectiveCamera(60, 1, .1, 100);
  camera.position.set(0, 8, 12); camera.lookAt(0, 0, 0);
  const ctx = {scene: new THREE.Scene(), camera, renderer: {capabilities: {maxTextureSize}}, time: 0} as unknown as RenderContext;
  const sprites = new MobileSprites(ctx); instances.push(sprites);
  if (ready) loads.forEach(load => load.loaded()); sprites.begin(); return {sprites, ctx};
}
function expectCell(sprites: MobileSprites, index: number, key: keyof typeof atlas.sheets, column: number, row: number) {
  const s = atlas.sheets[key], a = sprites.mesh.geometry.getAttribute('aRect');
  const expected = [(s.x + column * s.cellWidth) / atlas.width, 1 - (s.y + (row + 1) * s.cellHeight) / atlas.height, s.cellWidth / atlas.width, s.cellHeight / atlas.height];
  [a.getX(index), a.getY(index), a.getZ(index), a.getW(index)].forEach((n, i) => expect(n).toBeCloseTo(expected[i], 6));
}
beforeEach(() => {
  loads.length = 0;
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((url, onLoad, _progress, onError) => {
    const base = url.endsWith('/atlas.webp');
    const page = (actionAtlas.pages as {image: string; width: number; height: number}[]).find(page => url.endsWith(page.image));
    const next = new THREE.Texture<HTMLImageElement>();
    next.image = {width: base ? atlas.width : page?.width, height: base ? atlas.height : page?.height} as HTMLImageElement;
    if (base) { texture = next; loaded = onLoad!; failed = () => onError?.(new Error('decode failed')); }
    loads.push({texture: next, loaded: () => onLoad?.(next)}); return next;
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
  it('keeps a default sprite for unknown and legacy unsupported animations', () => {
    for (const anim of ['idle', 'walk', 'run', 'flee', 'carry', 'haul', 'guard']) expect(supportsSignifierAnimation(anim)).toBe(true);
    expect(supportsSignifierAnimation('unknown')).toBe(false);
    const {sprites} = setup(); expect(sprites.signifier(pose(), 0, 0, false)).toBe(true); expect(sprites.cast(0, pose(), false)).toBe(true);
    expect(sprites.layerCount).toBe(3); expect(sprites.fallbackCount).toBe(2);
    expect(sprites.cast(0, pose(), 'future-unknown-action')).toBe(true);
    expect(sprites.samples.at(-1)).toMatchObject({clip: 'idle', requestedClip: 'future-unknown-action'});
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
  it('uses flat placeholders until texture decode succeeds', () => {
    const {sprites} = setup(false);
    expect(sprites.cast(0, pose())).toBe(true); expect(sprites.signifier(pose(), 0, 0)).toBe(true); expect(sprites.layerCount).toBe(2);
    expect(sprites.samples.every(s => s.placeholder)).toBe(true);
    loaded(texture); expect(sprites.cast(0, pose())).toBe(true);
  });
  it('keeps flat placeholders on texture failure, never revealing models', () => {
    const {sprites} = setup(false); failed(); expect(sprites.atlasError).toBe(true); expect(sprites.atlasReady).toBe(false);
    expect(sprites.cast(0, pose())).toBe(true); expect(sprites.signifier(pose(), 0, 0)).toBe(true);
    expect(sprites.samples.every(s => s.placeholder)).toBe(true);
  });
  it.each([2048, 1024])('falls back on max texture size %i', size => {
    const {sprites} = setup(true, size); expect(sprites.atlasError).toBe(true); expect(sprites.cast(0, pose())).toBe(true);
    expect(sprites.samples.at(-1)?.placeholder).toBe(true);
  });
  it('rejects a decoded image of unexpected size', () => {
    const {sprites} = setup(false); texture.image = {width: 1024, height: 1024} as HTMLImageElement; loaded(texture);
    expect(sprites.atlasError).toBe(true); expect(sprites.atlasReady).toBe(false);
  });
  it('rejects invalid sheet, head and body indexes', () => {
    const {sprites} = setup(); expect(sprites.cast(6, pose())).toBe(false); expect(sprites.cast(-1, pose())).toBe(false);
    for (const [head, body] of [[18, 0], [0, 7], [-1, 0], [0, -1]]) expect(sprites.signifier(pose(), head, body)).toBe(false);
    expect(sprites.layerCount).toBe(0); expect(sprites.fallbackCount).toBe(0);
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


it('ships a compact lossless WebP atlas at the exact runtime URL', () => {
  const bytes = readFileSync(new URL('../../../public/assets/mobile-sprites/atlas.webp', import.meta.url));
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
  expect(bytes.includes(Buffer.from('VP8L'))).toBe(true);
  expect(bytes.length).toBeLessThan(2_100_000);
  expect(atlas.image).toBe('/assets/mobile-sprites/atlas.webp');
  expect(atlas.sampling.alphaThreshold).toBe(.5);
  setup();
  expect(THREE.TextureLoader.prototype.load).toHaveBeenCalledWith(expect.stringContaining('assets/mobile-sprites/atlas.webp'), expect.any(Function), undefined, expect.any(Function));
});


describe('screen-facing foot anchors', () => {
  it.each([false, true])('keeps source feet on the exact world anchor at all camera angles (orthographic=%s)', ortho => {
    const {sprites, ctx} = setup(true, 4096, ortho);
    const point = new THREE.Vector3(4, 2, -3);
    for (const pitch of [.05, .65, 1.53]) for (const roll of [0, .7, -1.2]) {
      ctx.camera.position.set(point.x + 9, point.y + Math.tan(pitch) * 9, point.z + 7);
      ctx.camera.lookAt(point); ctx.camera.rotateZ(roll); ctx.camera.updateMatrixWorld();
      sprites.begin();
      for (let i = 0; i < CAST_SHEETS.length; i++) {
        sprites.cast(i, {...pose(i), x: point.x, y: point.y, z: point.z});
        const sample = sprites.samples[i], sheet = atlas.sheets[CAST_SHEETS[i]];
        const row = sample.direction === 'front' ? 0 : 1, footY = sheet.footYByCell[row][sample.frame];
        const geometry = sprites.mesh.geometry, size = geometry.getAttribute('aSize'), offset = geometry.getAttribute('aOffset');
        // The visible source foot, rather than the padded cell edge, is the zero offset.
        expect((sheet.anchor[0] / sheet.cellWidth - .5) * size.getX(i) + offset.getX(i)).toBeCloseTo(0, 6);
        expect((1 - footY / sheet.cellHeight) * size.getY(i) + offset.getY(i)).toBeCloseTo(0, 6);
        const viewAnchor = point.clone().applyMatrix4(ctx.camera.matrixWorldInverse);
        const top = viewAnchor.clone().add(new THREE.Vector3(0, size.getY(i), 0));
        const right = viewAnchor.clone().add(new THREE.Vector3(size.getX(i), 0, 0));
        const projected = viewAnchor.clone().applyMatrix4(ctx.camera.projectionMatrix);
        const projectedTop = top.applyMatrix4(ctx.camera.projectionMatrix), projectedRight = right.applyMatrix4(ctx.camera.projectionMatrix);
        expect(projectedTop.x).toBeCloseTo(projected.x, 8);
        expect(projectedRight.y).toBeCloseTo(projected.y, 8);
        expect(point.clone().project(ctx.camera).distanceTo(projected)).toBeLessThan(1e-10);
      }
    }
    expect(sprites.mesh.material.vertexShader).toContain('vec4 p=viewMatrix*vec4(aCenter,1.)');
    expect(sprites.mesh.material.vertexShader).not.toContain('vec3(0.');
  });
  it('always emits a flat flag placeholder before flag art is ready', () => {
    const {sprites} = setup(false);
    for (const state of ['planted', 'ground', 'thrown', 'carried'] as const) expect(sprites.flag(pose(), state)).toBe(true);
    sprites.end();
    expect(sprites.spriteCount).toBe(4); expect(sprites.layerCount).toBe(4);
    expect(sprites.meshes.some(mesh => mesh.visible && mesh.name === 'mobile-sprite-placeholders')).toBe(true);
  });
});

it('selects every shipped action, alias, frame and facing without model fallback', () => {
  const {sprites, ctx} = setup();
  expect(Object.keys(actionAtlas.clips).length).toBeGreaterThan(0);
  expect(sprites.actionAtlasReady).toBe(true);
  for (const [key, clip] of Object.entries(actionAtlas.clips)) {
    const [kind, animation] = key.split(':');
    for (const direction of ['front', 'away'] as const) for (let frame = 0; frame < clip.columns; frame++) {
      const time = frame * clip.frameDurationMs / 1000 + .001;
      const p = {...pose(0, direction === 'front' ? 0 : Math.PI), moving: true, animationTime: time};
      ctx.time = time; sprites.begin();
      const accepted = kind === 'signifier' ? sprites.signifier(p, 7, 0, animation)
        : kind === 'flag' ? sprites.flag(p, animation as 'planted' | 'ground' | 'carried' | 'thrown')
        : sprites.cast(CAST_SHEETS.indexOf(kind as typeof CAST_SHEETS[number]), p, animation);
      expect(accepted, key).toBe(true); expect(sprites.fallbackCount, key).toBe(0);
      expect(sprites.samples[0], key).toMatchObject({clip: animation, frame, direction});
      const page = actionAtlas.pages[clip.page], rect = sprites.meshes[clip.page + 1].geometry.getAttribute('aRect');
      expect(rect.getX(0), key).toBeCloseTo((clip.x + frame * clip.cellWidth) / page.width, 7);
      expect(rect.getY(0), key).toBeCloseTo(1 - (clip.y + (clip.directionRows[direction] + 1) * clip.cellHeight) / page.height, 7);
    }
  }
});


describe('seated upright depth profile', () => {
  it.each([false, true])('keeps screen art and its true foot fixed with bounded depth at all views (orthographic=%s)', ortho => {
    const {sprites, ctx} = setup(true, 4096, ortho);
    const p: SpritePose = {...pose(0), x: 4, y: 2, z: -3, height: 3, depthProfile: 'upright'};
    for (const pitch of [0, .55, 1.2, 1.56]) for (const roll of [0, .7, -1.2]) {
      ctx.camera.position.set(p.x, p.y + 30 * Math.sin(pitch), p.z + 30 * Math.cos(pitch));
      ctx.camera.lookAt(p.x, p.y + .4, p.z); ctx.camera.rotateZ(roll); ctx.camera.updateMatrixWorld();
      const anchor = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(ctx.camera.matrixWorldInverse);
      const radius = Math.hypot(2, 4), depth = spriteUprightDepth(ctx.camera, p, radius);
      const projectDepth = (z: number) => { const v = new THREE.Vector4(0, 0, z, 1).applyMatrix4(ctx.camera.projectionMatrix); return v.z / v.w; };
      const maxShift = Math.abs(projectDepth(anchor.z + p.height) - projectDepth(anchor.z));
      for (const [x, y] of [[0, 0], [-2, -.2], [2, 4], [0, 2]]) {
        const original = anchor.clone().add(new THREE.Vector4(x, y, 0, 0)).applyMatrix4(ctx.camera.projectionMatrix);
        const adjusted = original.clone(); adjusted.z += (x * depth[0] + y * depth[1]) * adjusted.w;
        expect(adjusted.x / adjusted.w).toBe(original.x / original.w);
        expect(adjusted.y / adjusted.w).toBe(original.y / original.w);
        expect(Number.isFinite(adjusted.z)).toBe(true);
        expect(Math.abs((adjusted.z - original.z) / original.w)).toBeLessThanOrEqual(maxShift + 1e-12);
        if (x === 0 && y === 0) expect(adjusted.toArray()).toEqual(original.toArray());
      }
      sprites.begin(); sprites.cast(0, p, 'seated'); sprites.end();
      const batch = sprites.meshes.find(m => m.visible)!;
      const size = batch.geometry.getAttribute('aSize'), offset = batch.geometry.getAttribute('aOffset');
      const boundsRadius = Math.hypot(size.getX(0) / 2 + Math.abs(offset.getX(0)),
        Math.max(Math.abs(offset.getY(0)), Math.abs(size.getY(0) + offset.getY(0))));
      expect(batch.geometry.getAttribute('aDepth').getY(0)).toBeCloseTo(spriteUprightDepth(ctx.camera, p, boundsRadius)[1], 7);
      expect(batch.material.depthTest).toBe(true); expect(batch.material.depthWrite).toBe(true);
      expect((batch.geometry.getAttribute('aDepth') as THREE.InstancedBufferAttribute).version).toBeGreaterThan(0);
      expect((batch.geometry.getAttribute('aDepth') as THREE.InstancedBufferAttribute).updateRanges).toEqual([{start: 0, count: 2}]);
    }
    expect(sprites.mesh.material.vertexShader).toContain('gl_Position.z+=dot(q,aDepth)*gl_Position.w');
  });
  it.each([false, true])('places a raised body before rear furniture but behind real foreground occluders (orthographic=%s)', ortho => {
    const {ctx} = setup(true, 4096, ortho), camera = ctx.camera;
    const p: SpritePose = {...pose(), height: 3, depthProfile: 'upright'};
    camera.position.set(0, 15, 24); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const anchor = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(camera.matrixWorldInverse);
    const q = new THREE.Vector2(0, 1.7), coeff = spriteUprightDepth(camera, p, 3.2);
    const pixel = anchor.clone().add(new THREE.Vector4(q.x, q.y, 0, 0)).applyMatrix4(camera.projectionMatrix);
    const spriteDepth = pixel.z / pixel.w + q.x * coeff[0] + q.y * coeff[1];
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(pixel.x / pixel.w, pixel.y / pixel.w), camera);
    const depthAtWorldZ = (z: number) => {
      const point = ray.ray.at((z - ray.ray.origin.z) / ray.ray.direction.z, new THREE.Vector3());
      return point.project(camera).z;
    };
    expect(spriteDepth).toBeLessThan(depthAtWorldZ(-.6)); // Back banners stay behind the raised body.
    expect(spriteDepth).toBeGreaterThan(depthAtWorldZ(1.4)); // The actual front desk/walls still hide it.
    expect(spriteUprightDepth(camera, {...p, depthProfile: undefined}, 3.2)).toEqual([0, 0]);
  });
  it('applies the profile to seated defaults/placeholders but never ordinary sprites', () => {
    const {sprites} = setup(false), p: SpritePose = {...pose(), depthProfile: 'upright'};
    sprites.cast(0, p, 'seated'); sprites.cast(0, pose(1), 'idle'); sprites.end();
    const depth = sprites.meshes.find(m => m.visible)!.geometry.getAttribute('aDepth');
    expect(depth.getY(0)).toBeLessThan(0); expect(depth.getX(1)).toBe(0); expect(depth.getY(1)).toBe(0);
  });
});
