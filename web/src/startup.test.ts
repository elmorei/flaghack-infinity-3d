import { afterEach, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const captured = vi.hoisted(() => ({ cache: vi.fn(), remember: vi.fn(), boot: vi.fn(), overlay: null as any }));
vi.mock('./startup/cache', () => ({ verifyStartupCache: captured.cache, rememberStartupCache: captured.remember }));
vi.mock('./startup/media', () => ({ INTRO_VIDEO_URL: '/test-only.mp4', INTRO_VIDEO_HAS_AUDIO: true }));
vi.mock('./main', () => ({ boot: captured.boot, GAME_MODULE_URL: 'https://example.github.io/game/assets/main-test.js' }));
vi.mock('./startup/overlay', () => ({ StartupOverlay: class { constructor() { return captured.overlay; } } }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(cached: boolean) {
  vi.resetModules(); captured.cache.mockReset(); captured.remember.mockReset(); captured.boot.mockReset();
  const readiness = deferred<void>(), intro = deferred<void>(), fontReady = deferred<void>(), cache = deferred<boolean>();
  const app = { ready: readiness.promise, finishStartup: vi.fn() };
  const overlay = { play: vi.fn(), ready: vi.fn(), setStatus: vi.fn(), finished: intro.promise, fail: vi.fn(), dispose: vi.fn() };
  captured.overlay = overlay; captured.cache.mockReturnValue(cache.promise); captured.boot.mockResolvedValue({ app, cacheable: true });
  const root = { inert: false, querySelectorAll: () => [] }, html = { dataset: {} as Record<string, string> }, entries: PerformanceEntry[] = [];
  vi.stubGlobal('document', { getElementById: (id: string) => id === 'app' ? root : {}, documentElement: html, querySelectorAll: () => [], fonts: Object.assign([], { ready: fontReady.promise }) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('location', { href: 'https://example.github.io/game/' });
  vi.stubGlobal('performance', { now: () => Date.now(), getEntriesByType: () => entries });
  await import('./startup');
  expect(root.inert).toBe(true); expect(captured.boot).not.toHaveBeenCalled();
  cache.resolve(cached);
  await vi.waitFor(() => expect(captured.boot).toHaveBeenCalledOnce());
  return { app, overlay, readiness, intro, fontReady, root, html, entries };
}

it('checks cache before game import, starts cold video in parallel, and releases only after ready AND intro completion', async () => {
  const f = await fixture(false);
  expect(f.overlay.play).toHaveBeenCalledWith('/test-only.mp4', true); expect(f.overlay.ready).not.toHaveBeenCalled();
  expect(f.html.dataset.startupCache).toBe('miss'); expect(f.app.finishStartup).not.toHaveBeenCalled();
  f.readiness.resolve(); await vi.waitFor(() => expect(f.overlay.ready).toHaveBeenCalledOnce());
  expect(f.app.finishStartup).not.toHaveBeenCalled(); expect(f.root.inert).toBe(true);
  f.fontReady.resolve(); await vi.waitFor(() => expect(captured.remember).toHaveBeenCalledOnce());
  f.intro.resolve(); await vi.waitFor(() => expect(f.app.finishStartup).toHaveBeenCalledOnce());
  expect(f.root.inert).toBe(false); expect(f.overlay.dispose).toHaveBeenCalledOnce();
});
it('never starts a video on verified warm cache and still waits for GPU/title readiness', async () => {
  const f = await fixture(true); f.intro.resolve();
  expect(f.overlay.play).not.toHaveBeenCalled(); expect(f.html.dataset.startupCache).toBe('hit');
  await Promise.resolve(); expect(f.app.finishStartup).not.toHaveBeenCalled();
  f.readiness.resolve(); await vi.waitFor(() => expect(f.app.finishStartup).toHaveBeenCalledOnce());
  // Cache remembering is optional and cannot hold up the game if additional fonts are slow.
  expect(captured.remember).not.toHaveBeenCalled(); expect(f.root.inert).toBe(false);
});
it('a video that fails/ends early cannot bypass actual readiness', async () => {
  const f = await fixture(false); f.intro.resolve();
  await Promise.resolve(); expect(f.app.finishStartup).not.toHaveBeenCalled();
  f.readiness.resolve(); await vi.waitFor(() => expect(f.app.finishStartup).toHaveBeenCalledOnce());
});
it('game startup failures keep the safe reload UI instead of exposing an unready game', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await fixture(false); f.readiness.reject(new Error('GPU failed'));
  await vi.waitFor(() => expect(f.overlay.fail).toHaveBeenCalledOnce());
  expect(f.app.finishStartup).not.toHaveBeenCalled(); expect(f.root.inert).toBe(true); expect(log).toHaveBeenCalledOnce();
});
