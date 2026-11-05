import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import atlas from './mobileSpriteAtlas.json';
import type { RenderContext } from '../context';
import { MobileSprites, type SpritePose } from './mobileSprites';

vi.mock('./mobileSpriteActions.json', () => {
  const clip = {
    page: 0, x: 0, y: 0, w: 128, h: 64, cellWidth: 32, cellHeight: 32, columns: 4, rows: 2,
    anchor: [16, 30], footYByCell: [[30, 30, 30, 30], [30, 30, 30, 30]],
    directionRows: {front: 0, away: 1}, heightPixels: 28, frameDurationMs: 140, loop: false,
  };
  return {default: {schemaVersion: 1, pages: [{image: '/assets/mobile-sprites/test-actions.webp', width: 128, height: 128}], clips: {
    'signifier:ko': {...clip, headRotationByCell: [[0, 0, -.7, -Math.PI / 2], [0, 0, .7, Math.PI / 2]], headAnchorByCell: Array.from({length: 2}, () => Array.from({length: 4}, () => [18, 12]))},
    'dr-beef-supreme:swing': {...clip},
    'flag:planted': {...clip, loop: true, poleTipByCell: [[ [15.5,30],[16,30],[16.5,30],[15,30] ],[ [15.5,30],[16,30],[16.5,30],[15,30] ]]},
  }}};
});

const pending: {url: string; texture: THREE.Texture; load: () => void; fail: () => void}[] = [];
const all: MobileSprites[] = [];
const pose: SpritePose = {id: 0, x: 7, y: 2, z: -4, yaw: 0, height: 2.8, moving: false};
beforeEach(() => {
  pending.length = 0;
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((url, onLoad, _progress, onError) => {
    const base = url.endsWith('/atlas.webp'), texture = new THREE.Texture<HTMLImageElement>();
    texture.image = {width: base ? atlas.width : 128, height: base ? atlas.height : 128} as HTMLImageElement;
    pending.push({url, texture, load: () => onLoad?.(texture), fail: () => onError?.(new Error('unavailable'))}); return texture;
  });
});
afterEach(() => { all.splice(0).forEach(s => s.dispose()); vi.restoreAllMocks(); });
function setup(baseReady = true, actionReady = true) {
  const camera = new THREE.OrthographicCamera(-10,10,10,-10,.1,100); camera.position.set(7,8,10); camera.lookAt(7,2,-4);
  const ctx = {scene: new THREE.Scene(), camera, time: 100, renderer: {capabilities: {maxTextureSize: 4096}}} as unknown as RenderContext;
  const start = pending.length, sprites = new MobileSprites(ctx); all.push(sprites);
  if (baseReady) pending[start].load(); if (actionReady) pending[start + 1].load();
  sprites.begin(); return {ctx, sprites};
}

describe('supplemental sprite state runtime', () => {
  it('starts, advances and restarts one-shot clips late in a match, including a default-idle transition', () => {
    const {ctx, sprites} = setup();
    const sample = (time: number, clip: string) => {
      ctx.time = time; sprites.begin(); expect(sprites.signifier(pose, 0, 0, clip)).toBe(true); sprites.end(); return sprites.samples[0];
    };
    expect(sample(100, 'ko')).toMatchObject({clip: 'ko', frame: 0});
    expect(sample(100.15, 'ko').frame).toBe(1);
    expect(sample(101, 'ko').frame).toBe(3);
    expect(sample(101.1, 'idle').clip).toBe('idle');
    expect(sample(102, 'ko')).toMatchObject({clip: 'ko', frame: 0});
  });
  it('uses explicit elapsed action time rather than the global clock for authoritative actions', () => {
    const {sprites} = setup();
    sprites.cast(0, {...pose, animationTime: .29}, 'swing');
    expect(sprites.samples[0]).toMatchObject({clip: 'swing', frame: 2});
  });
  it.each([0, .29, .43])('aligns the personalized head neck even when prone at %s seconds', animationTime => {
    const {sprites} = setup(); sprites.signifier({...pose, animationTime}, 7, 0, 'ko');
    const head = sprites.mesh.geometry, body = sprites.meshes[1].geometry;
    const hs = head.getAttribute('aSize'), ho = head.getAttribute('aOffset');
    const bs = body.getAttribute('aSize'), bo = body.getAttribute('aOffset');
    const headNeckX = (80 / 160 - .5) * hs.getX(0) + ho.getX(0);
    const headNeckY = (1 - 78 / 160) * hs.getY(0) + ho.getY(0);
    const bodyNeckX = (18 / 32 - .5) * bs.getX(0) + bo.getX(0);
    const bodyNeckY = (1 - 12 / 32) * bs.getY(0) + bo.getY(0);
    const angle = head.getAttribute('aRotation').getX(0), c = Math.cos(angle), s = Math.sin(angle);
    expect(c * headNeckX - s * headNeckY).toBeCloseTo(bodyNeckX, 6);
    expect(s * headNeckX + c * headNeckY).toBeCloseTo(bodyNeckY, 6);
    expect(ho.getZ(0)).toBeGreaterThan(bo.getZ(0));
    expect(sprites.layerCount).toBe(2); expect(sprites.batchCount).toBe(2);
    expect(sprites.signifierNeedsFlag('ko')).toBe(true); expect(sprites.signifierNeedsFlag('carry')).toBe(false);
  });
  it('uses default art if an action page fails and placeholders if both sources fail', () => {
    const {sprites} = setup(true, false); pending[1].fail();
    expect(sprites.actionAtlasError).toBe(true); expect(sprites.cast(0, pose, 'swing')).toBe(true);
    expect(sprites.samples[0]).toMatchObject({clip: 'idle', requestedClip: 'swing'});
    const e = setup(false, false); expect(e.sprites.cast(0, pose, 'swing')).toBe(true);
    expect(e.sprites.samples[0].placeholder).toBe(true);
  });
  it('renders independent action art even if the base atlas cannot load', () => {
    const {sprites} = setup(false, true);
    expect(sprites.cast(0, pose, 'swing')).toBe(true); expect(sprites.samples[0].clip).toBe('swing');
    expect(sprites.signifier(pose, 0, 0, 'ko')).toBe(true); expect(sprites.samples[1].placeholder).toBe(true);
  });
  it('maps the visible flag pole tip to the exact anchor across every frame, facing and rotation', () => {
    const {sprites, ctx} = setup();
    for (const yaw of [0, Math.PI]) for (let frame = 0; frame < 4; frame++) for (const rotation of [0, .6, -1.2]) {
      ctx.time = frame * .14 + .001; sprites.begin(); sprites.flag({...pose, yaw}, 'planted', {rotation});
      const geometry = sprites.meshes[1].geometry, uv = geometry.getAttribute('aRect');
      const size = geometry.getAttribute('aSize'), offset = geometry.getAttribute('aOffset');
      const row = sprites.samples[0].direction === 'front' ? 0 : 1;
      // Per-frame odd/even pole widths use exact fractional pixel-edge centers, with bottom edge y30.
      const tipX = [15.5, 16, 16.5, 15][frame];
      const u = (frame * 32 + tipX) / 128, v = 1 - (row * 32 + 30) / 128;
      const qx = ((u - uv.getX(0)) / uv.getZ(0) - .5) * size.getX(0) + offset.getX(0);
      const qy = (v - uv.getY(0)) / uv.getW(0) * size.getY(0) + offset.getY(0);
      expect(Math.hypot(qx, qy)).toBeLessThan(1e-6);
      expect(geometry.getAttribute('aCenter').getX(0)).toBe(pose.x);
      expect(geometry.getAttribute('aCenter').getY(0)).toBe(pose.y);
      expect(geometry.getAttribute('aCenter').getZ(0)).toBe(pose.z);
    }
  });
  it('animates flag cloth independently of movement and retains rotation, highlight and glitch cues', () => {
    const {ctx, sprites} = setup(); ctx.time = .29;
    const ribbon = new THREE.Color(0xe43a52);
    sprites.flag(pose, 'planted', {rotation: .5, highlight: 1, glitch: .8, ribbon});
    expect(sprites.samples[0]).toMatchObject({clip: 'planted', frame: 2});
    const geometry = sprites.meshes[1].geometry;
    expect(geometry.getAttribute('aRotation').getX(0)).toBeCloseTo(.5);
    expect(geometry.getAttribute('aGlitch').getX(0)).toBeCloseTo(.8);
    expect(geometry.getAttribute('aTint').getX(0)).toBeGreaterThan(1);
    expect(geometry.getAttribute('aRibbon').getX(0)).toBeCloseTo(ribbon.r);
    expect(geometry.getAttribute('aRibbon').getW(0)).toBe(1);
    expect(sprites.meshes[1].material.fragmentShader).toContain('vGlitch');
  });
});
