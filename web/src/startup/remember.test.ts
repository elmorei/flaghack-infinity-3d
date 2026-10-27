import { afterEach, expect, it, vi } from 'vitest';
import { rememberReadyAssets } from './remember';
const capture = vi.hoisted(() => ({ remember: vi.fn() }));
vi.mock('./cache', () => ({ rememberStartupCache: capture.remember }));
afterEach(() => { vi.unstubAllGlobals(); capture.remember.mockReset(); });
function fixture(decode: () => Promise<void>, fontStatuses: string[] = ['loaded', 'unloaded']) {
  const image = { currentSrc: 'https://game.test/play/assets/wordmark.svg', src: '', decode };
  const root = { querySelectorAll: () => [image] } as unknown as HTMLElement;
  const entries: PerformanceEntry[] = [];
  vi.stubGlobal('document', { fonts: Object.assign(fontStatuses.map((status) => ({ status })), { ready: Promise.resolve() }), querySelectorAll: () => [{ href: 'https://game.test/play/assets/main.css' }] });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal('location', { href: 'https://game.test/play/' });
  vi.stubGlobal('performance', { getEntriesByType: () => entries });
  return { root, entries };
}
it('waits for title images and requires game, stylesheet and wordmark in the cache proof', async () => {
  let done!: () => void;
  const f = fixture(() => new Promise<void>((resolve) => { done = resolve; }));
  const recording = rememberReadyAssets('a'.repeat(40), 'https://game.test/play/assets/main.js', f.root);
  await Promise.resolve(); expect(capture.remember).not.toHaveBeenCalled();
  done(); await recording;
  expect(capture.remember).toHaveBeenCalledWith('a'.repeat(40), 'https://game.test/play/', f.entries, { requiredAssets: [
    'https://game.test/play/assets/main.js', 'https://game.test/play/assets/main.css', 'https://game.test/play/assets/wordmark.svg',
  ] });
});
it('a missing title image never records a partial cache or throws into startup', async () => {
  const f = fixture(async () => { throw new Error('missing'); });
  await expect(rememberReadyAssets('a'.repeat(40), 'https://game.test/play/assets/main.js', f.root)).resolves.toBeUndefined();
  expect(capture.remember).not.toHaveBeenCalled();
});
it('optional metadata exceptions cannot break a ready game', async () => {
  const f = fixture(async () => {}); capture.remember.mockImplementationOnce(() => { throw new Error('blocked storage'); });
  await expect(rememberReadyAssets('a'.repeat(40), 'https://game.test/play/assets/main.js', f.root)).resolves.toBeUndefined();
});

it.each(['error', 'loading'])('does not remember a partial title after an extra CSS font is %s', async (status) => {
  // Primary canvas fonts succeeded, but Cinzel 400 requested by the title did not.
  const f = fixture(async () => {}, ['loaded', 'loaded', status, 'unloaded']);
  await rememberReadyAssets('a'.repeat(40), 'https://game.test/play/assets/main.js', f.root);
  expect(capture.remember).not.toHaveBeenCalled();
});
