/** A remembered visit is only a probe list, never evidence that the HTTP cache is warm. */
export const STARTUP_CACHE_TIMEOUT_MS = 250;
export const MAX_STARTUP_CACHE_ASSETS = 128;
const MAX_RECORD_LENGTH = 32_768;
const RECORD_VERSION = 1;
const STORAGE_PREFIX = 'flaghack.startup-cache.v1:';

export interface StartupCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StartupCacheOptions {
  /** Inject browser dependencies for tests; null disables the corresponding capability. */
  storage?: StartupCacheStorage | null;
  fetch?: typeof globalThis.fetch | null;
  /** Always capped at the production budget, including response-body consumption. */
  timeoutMs?: number;
  /** rememberStartupCache only: expected title assets must all have successful timing entries. */
  requiredAssets?: readonly string[];
}

/** Accepts PerformanceEntry[] without requiring resource timing support in every browser. */
export interface StartupResourceEntry {
  name: string;
  entryType?: string;
  initiatorType?: string;
  responseStatus?: number;
  responseEnd?: number;
  decodedBodySize?: number;
}

interface Scope {
  origin: string;
  assetsRoot: string;
  key: string;
}

interface CacheRecord {
  version: number;
  buildId: string;
  assets: string[];
}

type AssetKind = 'script' | 'style' | 'font' | 'image';

function productionBuild(buildId: string): boolean {
  return /^[a-f0-9]{40}$/.test(buildId);
}

function projectScope(baseUrl: string): Scope | null {
  try {
    // Accept the document URL or a project directory URL. Never retain an invite/query/hash.
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    const directory = new URL('.', base);
    return {
      origin: directory.origin,
      assetsRoot: `${directory.pathname}assets/`,
      key: `${STORAGE_PREFIX}${directory.origin}${directory.pathname}`,
    };
  } catch { return null; }
}

function storageFor(options: StartupCacheOptions): StartupCacheStorage | null {
  // Access itself can throw (blocked cookies, sandboxed documents, privacy settings).
  return options.storage === undefined ? globalThis.localStorage ?? null : options.storage;
}

function assetKind(value: unknown, scope: Scope): AssetKind | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.origin !== scope.origin || url.username || url.password || url.search || url.hash ||
      url.href !== value || !url.pathname.startsWith(scope.assetsRoot)) return null;
    const path = url.pathname.slice(scope.assetsRoot.length);
    // No percent-encoded traversal, escaped delimiters, query tokens, or arbitrary endpoints.
    if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|woff2?|svg)$/.test(path)) return null;
    if (path.endsWith('.js')) return 'script';
    if (path.endsWith('.css')) return 'style';
    if (/\.woff2?$/.test(path)) return 'font';
    return 'image';
  } catch { return null; }
}

function validAssetSet(assets: unknown, scope: Scope): assets is string[] {
  if (!Array.isArray(assets) || assets.length < 3 || assets.length > MAX_STARTUP_CACHE_ASSETS ||
    new Set(assets).size !== assets.length) return false;
  const kinds = assets.map((asset) => assetKind(asset, scope));
  return !kinds.includes(null) && kinds.includes('script') && kinds.includes('style') && kinds.includes('font');
}

function readRecord(storage: StartupCacheStorage, scope: Scope, buildId: string): CacheRecord | null {
  const text = storage.getItem(scope.key);
  if (!text || text.length > MAX_RECORD_LENGTH) return null;
  const record: unknown = JSON.parse(text);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const candidate = record as Partial<CacheRecord>;
  if (candidate.version !== RECORD_VERSION || candidate.buildId !== buildId ||
    !validAssetSet(candidate.assets, scope)) return null;
  return candidate as CacheRecord;
}

/**
 * Call BEFORE importing the game, so this navigation cannot warm its own cache probes.
 * A cache miss, unsupported cache mode, partial/empty body, or timeout keeps the normal intro.
 * No request may fall back to the network, including cached redirects.
 */
export async function verifyStartupCache(
  buildId: string,
  baseUrl: string,
  options: StartupCacheOptions = {},
): Promise<boolean> {
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const scope = projectScope(baseUrl);
    if (!productionBuild(buildId) || !scope) return false;
    const storage = storageFor(options);
    if (!storage) return false;
    const record = readRecord(storage, scope, buildId);
    if (!record) return false;
    const fetchResource = options.fetch === undefined ? globalThis.fetch?.bind(globalThis) : options.fetch;
    if (!fetchResource || typeof Request !== 'function' || typeof AbortController !== 'function') return false;
    // Some older implementations reject or ignore this mode. Do not substitute force-cache.
    const capability = new Request(record.assets[0], { cache: 'only-if-cached', mode: 'same-origin' });
    if (capability.cache !== 'only-if-cached' || capability.mode !== 'same-origin') return false;
    controller = new AbortController();
    const signal = controller.signal;
    const requestedBudget = options.timeoutMs ?? STARTUP_CACHE_TIMEOUT_MS;
    const budget = Number.isFinite(requestedBudget) && requestedBudget > 0
      ? Math.min(requestedBudget, STARTUP_CACHE_TIMEOUT_MS) : STARTUP_CACHE_TIMEOUT_MS;
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(() => { controller?.abort(); resolve(false); }, budget);
    });
    const probes = Promise.all(record.assets.map(async (url) => {
      const response = await fetchResource(url, {
        method: 'GET',
        cache: 'only-if-cached',
        mode: 'same-origin',
        redirect: 'error',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        signal,
      });
      if (!response.ok || response.status !== 200 || response.redirected ||
        (response.url && response.url !== url)) throw new Error('Startup asset is not cached');
      // A header-only hit is insufficient: evicted/truncated bodies must not skip the intro.
      const body = await response.arrayBuffer();
      if (body.byteLength === 0 || signal.aborted) throw new Error('Incomplete cached startup asset');
    })).then(() => true, () => false);
    return await Promise.race([probes, expired]);
  } catch {
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    // Also cancel remaining probes as soon as any sibling fails; their rejections are handled.
    controller?.abort();
  }
}

/**
 * Call only after the title is ready AND startup fonts have settled. This saves metadata only;
 * it does not fetch/cache anything, and the next navigation must still verify every asset.
 * Missing status/size timing support intentionally means no remembered warm startup.
 * Pass the game module, title stylesheets, and decoded title images as requiredAssets so an
 * unrelated successful resource of the same kind cannot hide a pending or failed title asset.
 */
export function rememberStartupCache(
  buildId: string,
  baseUrl: string,
  resourceEntries: readonly StartupResourceEntry[],
  options: StartupCacheOptions = {},
): boolean {
  try {
    const scope = projectScope(baseUrl);
    if (!productionBuild(buildId) || !scope) return false;
    const storage = storageFor(options);
    if (!storage) return false;
    const requiredAssets = options.requiredAssets ?? [];
    if (!Array.isArray(requiredAssets) || requiredAssets.length > MAX_STARTUP_CACHE_ASSETS ||
      requiredAssets.some((asset) => !assetKind(asset, scope))) return false;
    const assets = new Set<string>();
    for (const entry of resourceEntries) {
      const kind = assetKind(entry.name, scope);
      if (!kind || entry.entryType !== 'resource' || entry.responseStatus !== 200 ||
        !Number.isFinite(entry.responseEnd) || entry.responseEnd! <= 0 ||
        !Number.isFinite(entry.decodedBodySize) || entry.decodedBodySize! <= 0) continue;
      // In particular, never remember our own fetch probes as successfully loaded resources.
      const initiators = kind === 'script' ? ['script', 'link']
        : kind === 'image' ? ['img', 'image', 'css', 'link'] : ['css', 'link'];
      if (!initiators.includes(entry.initiatorType ?? '')) continue;
      assets.add(entry.name);
      if (assets.size > MAX_STARTUP_CACHE_ASSETS) return false;
    }
    if (requiredAssets.some((asset) => !assets.has(asset))) return false;
    const urls = [...assets].sort();
    if (!validAssetSet(urls, scope)) return false;
    const record: CacheRecord = { version: RECORD_VERSION, buildId, assets: urls };
    const text = JSON.stringify(record);
    if (text.length > MAX_RECORD_LENGTH) return false;
    storage.setItem(scope.key, text);
    return true;
  } catch {
    return false;
  }
}
