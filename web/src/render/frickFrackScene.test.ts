import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { cardMotion, containedImageRect, faceSignature, FrickFrackScene, publicCardArtwork, type TableView } from './frickFrackScene';

const known = { id: 123, rank: 7, suit: 1 };
describe('engine card motion and public-only artwork', () => {
  it('never resolves artwork or an identity for a hidden card', () => {
    expect(publicCardArtwork(null)).toBeNull(); expect(faceSignature(null)).toBe('hidden');
  });
  it('starts physical known cards back-up, finishes both move and flip at330ms', () => {
    expect(cardMotion(0, false, false)).toEqual({ progress: 0, angle: Math.PI, lift: 0 });
    expect(cardMotion(330, false, false).progress).toBe(1);
    expect(cardMotion(330, false, false).angle).toBe(0);
    expect(cardMotion(330, false, false).lift).toBeCloseTo(0);
  });
  it('hidden cards stay back-up throughout a deal', () => {
    for (const t of [-10, 0, 120, 500]) expect(cardMotion(t, true, false).angle).toBe(Math.PI);
  });
  it('a reveal flips in place without re-dealing', () => {
    expect(cardMotion(0, false, false, true)).toEqual({ progress: 1, angle: Math.PI, lift: 0 });
    expect(cardMotion(250, false, false, true)).toEqual({ progress: 1, angle: 0, lift: 0 });
  });
  it('reduced motion jumps to authoritative face state', () => {
    expect(cardMotion(-100, false, true)).toEqual({ progress: 1, angle: 0, lift: 0 });
    expect(cardMotion(100, true, true)).toEqual({ progress: 1, angle: Math.PI, lift: 0 });
  });
  it('tracks value and defeated changes without altering underlying card', () => {
    expect(faceSignature(known)).not.toBe(faceSignature({ ...known, value: 4 }));
    expect(faceSignature(known)).not.toBe(faceSignature(known, true)); expect(known.rank).toBe(7);
  });
  it('contains artwork without stretching original aspect ratio', () => {
    const wide = containedImageRect(300, 200, 200, 300);
    expect(wide.width / wide.height).toBeCloseTo(1.5); expect(wide.width).toBe(200); expect(wide.y).toBeGreaterThan(0);
    const tall = containedImageRect(200, 400, 200, 300);
    expect(tall.width / tall.height).toBe(.5); expect(tall.height).toBe(300);
  });
});
function mockContext() {
  const gradient = { addColorStop: vi.fn() };
  return new Proxy({ createRadialGradient: () => gradient }, { get(target, key) { return key in target ? (target as any)[key] : () => {}; }, set() { return true; } });
}
function rendererMock() {
  const state = { target: { id: 'original' }, viewport: new THREE.Vector4(1, 2, 3, 4), scissor: new THREE.Vector4(5, 6, 7, 8), scissorTest: true, color: new THREE.Color('#123456'), alpha: .4 };
  const r = {
    domElement: { clientWidth: 800, clientHeight: 600 }, autoClear: true, toneMapping: THREE.ACESFilmicToneMapping,
    getRenderTarget: () => state.target, setRenderTarget: vi.fn((v: any) => { state.target = v; }),
    getViewport: (v: THREE.Vector4) => v.copy(state.viewport),
    setViewport: vi.fn((...args: any[]) => state.viewport.copy(args[0] instanceof THREE.Vector4 ? args[0] : new THREE.Vector4(...args as [number, number, number, number]))),
    getScissor: (v: THREE.Vector4) => v.copy(state.scissor),
    setScissor: vi.fn((...args: any[]) => state.scissor.copy(args[0] instanceof THREE.Vector4 ? args[0] : new THREE.Vector4(...args as [number, number, number, number]))),
    getScissorTest: () => state.scissorTest, setScissorTest: (v: boolean) => { state.scissorTest = v; },
    getClearColor: (v: THREE.Color) => v.copy(state.color), getClearAlpha: () => state.alpha,
    setClearColor: (v: THREE.ColorRepresentation, a: number) => { state.color.set(v); state.alpha = a; },
    clear: vi.fn(), render: vi.fn(),
  };
  return { r: r as unknown as THREE.WebGLRenderer, state, render: r.render };
}
const view = (card = known as typeof known | null): TableView => ({ sessionKey: 'hand1', panel: { x: 20, y: 20, width: 700, height: 550 }, reducedMotion: true,
  cards: [{ key: 'dealer:0', card, defeated: false, order: 0, rect: { x: 100, y: 100, width: 72, height: 108 } }] });
describe('shared engine scene lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => mockContext() }) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('creates actual front/back/shadow meshes and raycasts the actual card', () => {
    const s = new FrickFrackScene(), { r } = rendererMock(); s.draw(r, view(), 1000);
    const snapshot = s.snapshot(); expect(snapshot.cardCount).toBe(1); expect(snapshot.meshCount).toBe(8);
    expect(snapshot.cards[0].faceUp).toBe(true); expect(s.pick(136, 154)).toBe('dealer:0'); expect(s.pick(700, 500)).toBeNull(); s.dispose();
  });
  it('preserves hidden identity and uses only back when null', () => {
    const s = new FrickFrackScene(), { r } = rendererMock(); s.draw(r, view(null), 1000);
    expect(s.snapshot().cards[0]).toMatchObject({ hidden: true, textureKey: 'hidden', faceVisible: false, faceUp: false }); s.dispose();
  });
  it('restores shared renderer state even if draw throws', () => {
    const s = new FrickFrackScene(), { r, state, render } = rendererMock(); render.mockImplementation(() => { throw new Error('test draw'); });
    expect(() => s.draw(r, view(), 1000)).toThrow('test draw');
    expect(state.target).toEqual({ id: 'original' }); expect(state.viewport.toArray()).toEqual([1, 2, 3, 4]); expect(state.scissor.toArray()).toEqual([5, 6, 7, 8]);
    expect(state.scissorTest).toBe(true); expect(state.color.getHexString()).toBe('123456'); expect(state.alpha).toBe(.4);
    expect(r.autoClear).toBe(true); expect(r.toneMapping).toBe(THREE.ACESFilmicToneMapping); s.dispose();
  });
  it('prunes removed cards, resets session animations and disables picking after exit', () => {
    const s = new FrickFrackScene(), { r } = rendererMock(); s.draw(r, view(), 1000);
    s.draw(r, { ...view(), cards: [] }, 1200); expect(s.snapshot().cardCount).toBe(0);
    s.draw(r, view(), 1300); s.clear(); expect(s.snapshot().active).toBe(false); expect(s.pick(136, 154)).toBeNull(); s.dispose(); s.dispose();
  });
  it('shows sideboard cards immediately instead of dealing them from deck', () => {
    const s = new FrickFrackScene(), { r } = rendererMock();
    const v = view(); v.reducedMotion = false; v.cards[0].order = -1;
    s.draw(r, v, 1000); expect(s.snapshot().cards[0]).toMatchObject({ faceUp: true, animationProgress: 1 }); s.dispose();
  });
  it('does not pick geometry outside the clipped panel', () => {
    const s = new FrickFrackScene(), { r } = rendererMock();
    const v = view(); v.cards[0].rect.x = 750;
    s.draw(r, v, 1000); expect(s.pick(786, 154)).toBeNull(); s.dispose();
  });
  it('uses one physical clock when hidden card is revealed and no reflip on value updates', () => {
    const s = new FrickFrackScene(), { r } = rendererMock();
    const v = view(null); v.reducedMotion = false; s.draw(r, v, 0);
    v.cards[0].card = known; s.draw(r, v, 400); expect(s.snapshot().cards[0]).toMatchObject({ hidden: false, faceVisible: false, animationProgress: 1 });
    s.draw(r, v, 700); expect(s.snapshot().cards[0].faceUp).toBe(true);
    v.cards[0].card = { ...known, value: 4 }; s.draw(r, v, 710); expect(s.snapshot().cards[0].faceUp).toBe(true); s.dispose();
  });

});

describe('replicated physical die',()=>{
  beforeEach(()=>{vi.stubGlobal('window',{innerWidth:800,innerHeight:600});vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>mockContext()})});});
  afterEach(()=>vi.unstubAllGlobals());
  it.each([1,2,3,4,5,6])('renders selected face %s after roll without restarting on rerender',result=>{
    const s=new FrickFrackScene(),{r}=rendererMock(),v=view();v.reducedMotion=false;
    v.die={result,progress:.2,rollKey:'1:1',rect:{x:100,y:30,width:300,height:80}};
    s.draw(r,v,0);expect(s.snapshot().die).toMatchObject({result,progress:.2,rollKey:'1:1'});
    v.die.progress=1;s.draw(r,v,100);expect(s.snapshot().die).toMatchObject({result,face:result,progress:1});
    s.draw(r,{...v},900);expect(s.snapshot().die).toMatchObject({result,face:result,progress:1});
    s.clear();expect(s.snapshot().die).toBeNull();s.dispose();
  });
  it('renders late join at replicated progress rather than starting another roll',()=>{
    const s=new FrickFrackScene(),{r}=rendererMock(),v=view();v.reducedMotion=false;
    v.die={result:6,progress:.7,rollKey:'3:9',rect:{x:100,y:30,width:300,height:80}};
    s.draw(r,v,9999);expect(s.snapshot().die?.progress).toBe(.7);s.dispose();
  });
});

describe('clean yellow-flag scenery and live deck anchor', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => mockContext() }) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('loads only cosmetic scenery, preserves the live cards, and disposes its texture', () => {
    let img: any;
    vi.stubGlobal('Image', class { onload: null | (() => void) = null; onerror = null; src = ''; decoding = ''; constructor() { img = this; } });
    const s = new FrickFrackScene(), { r } = rendererMock();
    expect(img.src).toContain('cards/frick-frack-yellow-flags.webp');
    expect(s.snapshot().backdropReady).toBe(false);
    img.onload(); expect(s.snapshot().backdropReady).toBe(true);
    const texture = (s as any).sceneryTextures.landscape, dispose = vi.spyOn(texture, 'dispose');
    s.draw(r, view(null), 1000);
    expect(s.snapshot().cards[0]).toMatchObject({ hidden: true, textureKey: 'hidden', faceVisible: false });
    s.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(img.onload).toBeNull();
  });
  it('places the engine deck at its DOM layout anchor without changing card rules', () => {
    const s = new FrickFrackScene(), { r } = rendererMock();
    s.draw(r, { ...view(), deck: { x: 200, y: 250, width: 60, height: 90 } }, 1000);
    expect((s as any).deck.position.x).toBe(230);
    expect((s as any).deck.position.y).toBe(305);
    expect((s as any).deck.scale.x).toBe(60);
    expect(s.snapshot().cards[0].faceUp).toBe(true); s.dispose();
  });
});
