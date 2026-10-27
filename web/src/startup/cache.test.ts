import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_STARTUP_CACHE_ASSETS,
  STARTUP_CACHE_TIMEOUT_MS,
  rememberStartupCache,
  verifyStartupCache,
  type StartupCacheStorage,
  type StartupResourceEntry,
} from './cache';

const BUILD = 'a'.repeat(40);
const OTHER_BUILD = 'b'.repeat(40);
const BASE = 'https://player.example/flaghack/';
const ASSETS = [
  `${BASE}assets/game-abcd1234.js`,
  `${BASE}assets/game-abcd1234.css`,
  `${BASE}assets/rubik-latin-abcd1234.woff2`,
];

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

function resource(name: string, overrides: Partial<StartupResourceEntry> = {}): StartupResourceEntry {
  return {
    name, entryType: 'resource', initiatorType: name.endsWith('.js') ? 'script' : 'link',
    responseStatus: 200, responseEnd: 42, decodedBodySize: 512, ...overrides,
  };
}

function fixture() {
  const storage = memoryStorage();
  expect(rememberStartupCache(BUILD, BASE, ASSETS.map((name) => resource(name)), { storage })).toBe(true);
  const key = [...storage.values.keys()][0];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('complete cached body'));
  return { storage, key, fetch };
}

function replaceRecord(storage: ReturnType<typeof memoryStorage>, key: string, changes: Record<string, unknown>) {
  storage.values.set(key, JSON.stringify({ ...JSON.parse(storage.values.get(key)!), ...changes }));
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('verifyStartupCache', () => {
  it('does not equate a visit flag, absent record, or another build with a warm cache', async () => {
    const { storage, key, fetch } = fixture();
    expect(await verifyStartupCache(OTHER_BUILD, BASE, { storage, fetch })).toBe(false);
    storage.values.set(key, 'true');
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    storage.values.clear();
    storage.values.set('visited', 'true');
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires all current-build bodies, using only same-origin HTTP cache without referrer data', async () => {
    const { storage, fetch } = fixture();
    expect(await verifyStartupCache(BUILD, `${BASE}?invite=secret#pw=secret`, { storage, fetch })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([...ASSETS].sort());
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', cache: 'only-if-cached', mode: 'same-origin',
        redirect: 'error', credentials: 'same-origin', referrerPolicy: 'no-referrer' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([504, 404, 206, 204, 500])('keeps the intro if one asset returns HTTP %s', async (status) => {
    const { storage, fetch } = fixture();
    fetch.mockImplementation(async (url) => url === ASSETS[1]
      ? new Response(status === 204 ? null : 'not a complete hit', { status }) : new Response('cached'));
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, options]) => options?.cache === 'only-if-cached')).toBe(true);
    expect(fetch.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
  });

  it('fails open on unsupported cache-only fetch without retrying or fetching missing bytes', async () => {
    const { storage, fetch } = fixture();
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, options]) => options?.cache === 'only-if-cached')).toBe(true);
  });

  it('does not probe when Request silently ignores the cache mode', async () => {
    const { storage, fetch } = fixture();
    vi.stubGlobal('Request', class { cache = 'default'; mode = 'same-origin'; });
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not consider headers without a readable, nonempty body a cache hit', async () => {
    const { storage, fetch } = fixture();
    fetch.mockResolvedValue(new Response(''));
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    fetch.mockImplementation(async () => ({ ok: true, status: 200,
      arrayBuffer: async () => { throw new Error('cache body evicted'); } }) as unknown as Response);
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
  });

  it('refuses cached redirects and unexpected response URLs', async () => {
    const { storage, fetch } = fixture();
    fetch.mockImplementation(async () => ({ ok: true, status: 200, redirected: true }) as Response);
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    fetch.mockImplementation(async () => ({ ok: true, status: 200, url: `${BASE}login` }) as Response);
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
  });

  it.each([
    { version: 2 }, { buildId: OTHER_BUILD }, { assets: null }, { assets: {} },
    { assets: [] }, { assets: ASSETS.slice(0, 2) }, { assets: [ASSETS[0], ASSETS[0], ASSETS[2]] },
    { assets: [...ASSETS, 123] },
    { assets: [...ASSETS, ...Array.from({ length: MAX_STARTUP_CACHE_ASSETS }, (_, n) => `${BASE}assets/extra-${n}.js`)] },
  ])('rejects malformed/stale/incomplete metadata before any fetch: %j', async (changes) => {
    const { storage, key, fetch } = fixture();
    replaceRecord(storage, key, changes);
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://remote.example/assets/main.js',
    'https://player.example/other/assets/main.js',
    'https://player.example/assets/main.js',
    `${BASE}assets-evil/main.js`, `${BASE}api/info.js`, `${BASE}assets/main.js?invite=secret`,
    `${BASE}assets/main.js#secret`, `${BASE}assets/../main.js`, `${BASE}assets/%2e%2e/main.js`,
    `${BASE}assets/private%2fmain.js`, `${BASE}assets/main.json`, `${BASE}assets/main.mp4`,
    'https://user:secret@player.example/flaghack/assets/main.js',
    '/flaghack/assets/main.js', 'data:text/javascript,secret', 'not a URL',
  ])('rejects unsafe or out-of-project URL %s without contacting it', async (url) => {
    const { storage, key, fetch } = fixture();
    replaceRecord(storage, key, { assets: [...ASSETS, url] });
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['development', 'abc123', 'A'.repeat(40), '', 'a'.repeat(41)])('never claims warm for nonproduction build %s', async (build) => {
    const { storage, fetch } = fixture();
    expect(await verifyStartupCache(build, BASE, { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('handles absent APIs, denied storage, oversized records, and invalid JSON', async () => {
    const { storage, key, fetch } = fixture();
    expect(await verifyStartupCache(BUILD, BASE, { storage: null, fetch })).toBe(false);
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch: null })).toBe(false);
    const denied: StartupCacheStorage = { getItem: () => { throw new Error('SecurityError'); }, setItem: vi.fn() };
    expect(await verifyStartupCache(BUILD, BASE, { storage: denied, fetch })).toBe(false);
    storage.values.set(key, '{');
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    storage.values.set(key, ' '.repeat(32_769));
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds the entire preflight and aborts pending requests even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const { storage, fetch } = fixture();
    fetch.mockImplementation(() => new Promise(() => {}));
    const result = verifyStartupCache(BUILD, BASE, { storage, fetch, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(STARTUP_CACHE_TIMEOUT_MS);
    expect(await result).toBe(false);
    expect(fetch.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes hung body reads in the same deadline, not just response headers', async () => {
    vi.useFakeTimers();
    const { storage, fetch } = fixture();
    fetch.mockImplementation(async () => ({ ok: true, status: 200,
      arrayBuffer: () => new Promise(() => {}) }) as unknown as Response);
    const result = verifyStartupCache(BUILD, BASE, { storage, fetch, timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toBe(false);
    expect(fetch.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the preflight deadline immediately on success or failure', async () => {
    vi.useFakeTimers();
    const { storage, fetch } = fixture();
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fetch.mockRejectedValue(new Error('evicted'));
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('rememberStartupCache', () => {
  it.each([
    `${BASE}assets/title-wordmark-abcd1234.svg`,
    `${BASE}assets/main-module-abcd1234.js`,
    `${BASE}assets/title-style-abcd1234.css`,
  ])('does not let generic JS/CSS/font success hide missing, pending, or failed required asset %s', (required) => {
    const storage = memoryStorage();
    const complete = ASSETS.map((url) => resource(url));
    const initiatorType = required.endsWith('.svg') ? 'img' : required.endsWith('.js') ? 'script' : 'link';
    const options = { storage, requiredAssets: [required] };
    expect(rememberStartupCache(BUILD, BASE, complete, options)).toBe(false);
    for (const failure of [
      { responseEnd: 0 }, { responseStatus: 404 }, { responseStatus: undefined },
      { decodedBodySize: 0 }, { initiatorType: 'fetch' },
    ]) {
      const entries = [...complete, resource(required, { initiatorType, ...failure })];
      expect(rememberStartupCache(BUILD, BASE, entries, options)).toBe(false);
    }
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    'https://other.example/assets/title.svg',
    'https://player.example/other/assets/title.svg',
    `${BASE}api/title.svg`, `${BASE}assets/title.svg?secret=invite`, `${BASE}assets/title.svg#secret`,
    `${BASE}assets/title.png`, `${BASE}assets/../title.svg`, '/flaghack/assets/title.svg', 'not a URL',
  ])('refuses an invalid or out-of-scope required asset %s', (required) => {
    const storage = memoryStorage();
    const entries = [...ASSETS.map((url) => resource(url)), resource(required, { initiatorType: 'img' })];
    expect(rememberStartupCache(BUILD, BASE, entries, { storage, requiredAssets: [required] })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('records a complete required title asset set and still probes every saved asset next time', async () => {
    const storage = memoryStorage();
    const image = `${BASE}assets/title-wordmark-abcd1234.svg`;
    const main = `${BASE}assets/main-module-abcd1234.js`;
    const style = `${BASE}assets/title-style-abcd1234.css`;
    const requiredAssets = [image, main, style];
    const entries = [...ASSETS.map((url) => resource(url)),
      resource(image, { initiatorType: 'img' }), resource(main), resource(style)];
    expect(rememberStartupCache(BUILD, BASE, entries, { storage, requiredAssets })).toBe(true);
    const record = JSON.parse([...storage.values.values()][0]);
    expect(record.assets).toEqual([...ASSETS, ...requiredAssets].sort());
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('cached'));
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(record.assets);
  });

  it('does not relax the generic JS/CSS/font requirement when requiredAssets are all present', () => {
    const storage = memoryStorage();
    const image = `${BASE}assets/title-wordmark-abcd1234.svg`;
    expect(rememberStartupCache(BUILD, BASE, [resource(image, { initiatorType: 'img' })],
      { storage, requiredAssets: [image] })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('rejects an oversized required-asset list rather than truncating it', () => {
    const storage = memoryStorage();
    const requiredAssets = Array.from({ length: MAX_STARTUP_CACHE_ASSETS + 1 }, () => ASSETS[0]);
    expect(rememberStartupCache(BUILD, BASE, ASSETS.map((url) => resource(url)),
      { storage, requiredAssets })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('stores only completed, successful project assets, without invite data or probe requests', () => {
    const storage = memoryStorage();
    const svg = `${BASE}assets/icon-abcd1234.svg`;
    const entries = [
      ...ASSETS.map((url) => resource(url)), resource(ASSETS[0]), resource(svg, { initiatorType: 'img' }),
      resource(`${BASE}assets/probe.js`, { initiatorType: 'fetch' }),
      resource(`${BASE}assets/missing.js`, { responseStatus: 404 }),
      resource(`${BASE}assets/unknown.js`, { responseStatus: undefined }),
      resource(`${BASE}assets/loading.js`, { responseEnd: 0 }),
      resource(`${BASE}assets/empty.js`, { decodedBodySize: 0 }),
      resource(`${BASE}assets/not-resource.js`, { entryType: 'navigation' }),
      resource(`${BASE}assets/invite.js?pw=secret`), resource(`${BASE}assets/invite.js#pw=secret`),
      resource('https://remote.example/assets/main.js'), resource(`${BASE}api/info.js`),
    ];
    expect(rememberStartupCache(BUILD, `${BASE}index.html?invite=secret#pw=secret`, entries, { storage })).toBe(true);
    const [[key, raw]] = [...storage.values];
    expect(key).toContain(BASE);
    expect(`${key}${raw}`).not.toMatch(/secret|invite|probe|missing|loading|unknown|empty|not-resource|remote|api/);
    expect(JSON.parse(raw)).toEqual({ version: 1, buildId: BUILD, assets: [...ASSETS, svg].sort() });
  });

  it('cannot record a warm startup without a successfully loaded JS, CSS, and font', () => {
    for (let omit = 0; omit < ASSETS.length; omit++) {
      const storage = memoryStorage();
      expect(rememberStartupCache(BUILD, BASE, ASSETS.filter((_, n) => n !== omit).map((url) => resource(url)), { storage })).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  });

  it('treats resource timing with unknown response status as unverified, not successful', () => {
    const storage = memoryStorage();
    const entries = ASSETS.map((url) => resource(url, { responseStatus: undefined }));
    expect(rememberStartupCache(BUILD, BASE, entries, { storage })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('does not write an oversized, truncated set of startup resources', () => {
    const storage = memoryStorage();
    const entries = [...ASSETS, ...Array.from({ length: MAX_STARTUP_CACHE_ASSETS }, (_, n) => `${BASE}assets/extra-${n}.js`)]
      .map((url) => resource(url));
    expect(rememberStartupCache(BUILD, BASE, entries, { storage })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('ignores denied storage, development builds, and unsupported document schemes', () => {
    const entries = ASSETS.map((url) => resource(url));
    const storage = memoryStorage();
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(rememberStartupCache(BUILD, BASE, entries, { storage })).toBe(false);
    storage.setItem.mockClear();
    expect(rememberStartupCache('development', BASE, entries, { storage })).toBe(false);
    expect(rememberStartupCache(BUILD, 'file:///game/index.html', entries, { storage })).toBe(false);
    expect(rememberStartupCache(BUILD, 'not a URL', entries, { storage })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('metadata alone is insufficient after partial eviction and a new build cannot reuse it', async () => {
    const { storage, fetch } = fixture();
    fetch.mockResolvedValue(new Response('evicted', { status: 504 }));
    expect(await verifyStartupCache(BUILD, BASE, { storage, fetch })).toBe(false);
    fetch.mockClear();
    expect(await verifyStartupCache(OTHER_BUILD, BASE, { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not share a record between different Pages projects on the same origin', async () => {
    const { storage, fetch } = fixture();
    expect(await verifyStartupCache(BUILD, 'https://player.example/other/', { storage, fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
