import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameRenderer } from './renderer';

/** Exercise production warmup/draw ordering without needing a WebGL-capable test runtime. */
function fixture() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const compile = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const target = {};
  const gpu = { getRenderTarget: () => target, setRenderTarget: vi.fn(), compileAsync: vi.fn(() => compile) };
  const post = { render: vi.fn() };
  const renderer: any = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    ctx: { time: 0, scene: {}, shared: {} }, camera: {}, renderer: gpu, post, modules: [],
    warmTarget: {}, needsWarm: true, warmUntil: 0, warmError: null,
    disposeRetired: vi.fn(), updateFx: vi.fn(), beatSource: null,
  });
  return { renderer: renderer as GameRenderer, gpu, post, target, resolve, reject };
}
let now: number;
beforeEach(() => { now = 0; vi.stubGlobal('performance', { now: () => now }); });
afterEach(() => vi.unstubAllGlobals());

describe('renderer first-frame readiness', () => {
  it('reports false while compiling, then true only after the canvas draw', async () => {
    const { renderer, gpu, post, target, resolve } = fixture();
    expect(renderer.render(0)).toBe(false);
    expect(post.render).not.toHaveBeenCalled(); expect(gpu.compileAsync).toHaveBeenCalledOnce();
    expect(gpu.setRenderTarget).toHaveBeenLastCalledWith(target);
    now = 100; expect(renderer.render(0)).toBe(false);
    resolve(); await Promise.resolve();
    expect(renderer.render(0)).toBe(true); expect(post.render).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('retains the warmup cap, but reports ready only if the cap-triggered draw succeeds', () => {
    const { renderer, post } = fixture();
    expect(renderer.render(0)).toBe(false);
    now = 301;
    expect(renderer.render(0)).toBe(true); expect(post.render).toHaveBeenCalledOnce();
    post.render.mockImplementation(() => { throw new Error('draw failed'); });
    expect(() => renderer.render(0)).toThrow('draw failed');
  });

  it('surfaces asynchronous compile rejection on the next readiness check', async () => {
    const { renderer, post, reject } = fixture();
    expect(renderer.render(0)).toBe(false);
    const failure = new Error('shader compile failed'); reject(failure); await Promise.resolve();
    expect(() => renderer.render(0)).toThrow(failure);
    expect(post.render).not.toHaveBeenCalled();
  });

  it('restores the render target even when compilation throws synchronously', () => {
    const { renderer, gpu, target } = fixture();
    gpu.compileAsync.mockImplementation(() => { throw new Error('compile unavailable'); });
    expect(() => renderer.render(0)).toThrow('compile unavailable');
    expect(gpu.setRenderTarget).toHaveBeenLastCalledWith(target);
  });

  it('does not claim readiness when no scene is attached', () => {
    const { renderer } = fixture(); renderer.ctx = null;
    expect(renderer.render(0)).toBe(false);
  });
});
