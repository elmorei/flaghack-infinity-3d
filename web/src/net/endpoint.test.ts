import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserAllowsRemoteHosts, normalizeHostEndpoint, parseHostAddress, parseInviteFragment, takeLocationInvite, probeHost, hostCompatibilityError } from './endpoint';
import { BUILD_ID } from './build';
import { PROTOCOL_VERSION } from './protocol';
import { parseHostInfo, tabTokens } from './client';

const page = { protocol: 'https:', origin: 'https://player.github.io' };
const local = { protocol: 'http:', origin: 'http://localhost:5173' };
const info = { serverName: 'Burn', instanceId: 'abc123', build: BUILD_ID, protocol: PROTOCOL_VERSION, phase: 'lobby', players: 0, seated: 0 };
const target = normalizeHostEndpoint('https://host.example', page);
const response = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
afterEach(() => vi.useRealTimers());

describe('browser versus existing offline launcher capabilities', () => {
  it('disables the locked Electron shell while keeping ordinary loopback browsers available', () => {
    const browser = 'Mozilla/5.0 Chrome/132.0.0.0 Safari/537.36';
    expect(browserAllowsRemoteHosts({ protocol: 'https:', userAgent: browser })).toBe(true);
    expect(browserAllowsRemoteHosts({ protocol: 'http:', userAgent: browser })).toBe(true);
    expect(browserAllowsRemoteHosts({ protocol: 'http:', userAgent: `${browser} Electron/44.7.0` })).toBe(false);
    expect(browserAllowsRemoteHosts({ protocol: 'file:', userAgent: browser })).toBe(false);
  });
});

describe('remote host target boundary', () => {
  it('normalizes HTTPS origins and keeps the fixed root API/socket routes', () => {
    expect(normalizeHostEndpoint('  HTTPS://HOST.EXAMPLE:443/  ', page)).toEqual({ origin: 'https://host.example', infoUrl: 'https://host.example/api/info', socketUrl: 'wss://host.example/ws' });
    expect(normalizeHostEndpoint('https://host.example:9443', page).socketUrl).toBe('wss://host.example:9443/ws');
  });
  it.each(['https://user:password@host.example', 'https://@host.example', 'https://host.example/?', 'https://host.example/#', 'https://host.example/path', 'https://host.example/api/info', 'https://host.example/ws', 'https://host.example/?pw=secret', 'https://host.example/#x=secret', 'ws://host.example', 'wss://host.example', '//host.example', 'host.example', 'javascript:alert(1)', 'https://host.example\\evil'])('rejects non-origin or unsafe target %s', raw => {
    expect(() => normalizeHostEndpoint(raw, page)).toThrow();
  });
  it('rejects mixed content, while keeping localhost development and same-origin HTTP hosts', () => {
    expect(() => normalizeHostEndpoint('http://localhost:8787', page)).toThrow(/mixed content/);
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(normalizeHostEndpoint(`http://${host}:8787`, local).socketUrl).toBe(`ws://${host}:8787/ws`);
    expect(() => normalizeHostEndpoint('http://192.168.1.2:8787', local)).toThrow(/HTTPS/);
    expect(normalizeHostEndpoint('http://192.168.1.2:8787', { protocol: 'http:', origin: 'http://192.168.1.2:8787' }).origin).toBe('http://192.168.1.2:8787');
  });
  it('parses Pages fragments and old host invites without contacting either address', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(parseHostAddress('https://player.github.io/flaghack/#host=https%3A%2F%2FHOST.example%3A443%2F&pw=sword%26fish%2B', page)).toEqual({ endpoint: target, password: 'sword&fish+' });
    expect(parseHostAddress('https://host.example/#pw=sword%20fish', page)).toEqual({ endpoint: target, password: 'sword fish' });
    expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  });
  it.each(['#host=', '#host=https://host.example&extra=x', '#host=https://host.example&host=https://evil.example', '#pw=one&pw=two', '#pw=%GG'])('rejects malformed invite %s', hash => {
    expect(() => parseInviteFragment(hash)).toThrow();
  });
  it('strips secrets from the address bar before parsing, including invalid invites', () => {
    const loc = { hash: '#host=https%3A%2F%2Fhost.example&pw=secret', pathname: '/game/', search: '?predict=0' };
    const history = { state: { keep: 1 }, replaceState: vi.fn(() => { loc.hash = ''; }) };
    expect(takeLocationInvite(loc, history)).toEqual({ host: 'https://host.example', password: 'secret', error: null });
    expect(history.replaceState).toHaveBeenCalledWith(history.state, '', '/game/?predict=0');
    loc.hash = '#pw=%GG'; expect(takeLocationInvite(loc, history).error).toMatch(/invalid URL escaping/); expect(loc.hash).toBe('');
  });
  it('does not erase ordinary, non-invite fragments', () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(takeLocationInvite({ hash: '#help', pathname: '/', search: '' }, history).host).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
  it('scopes reclaim tokens to the actual target origin and survives denied storage', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const a = tabTokens('https://a.example', storage), b = tabTokens('https://b.example', storage);
    a.save('token-a'); b.save('token-b'); expect(a.load()).toBe('token-a'); expect(b.load()).toBe('token-b');
    expect(tabTokens('https://a.example', storage).load()).toBe('token-a');
    const disabled = tabTokens('https://a.example', { getItem() { throw new Error(); }, setItem() { throw new Error(); } });
    expect(disabled.load()).toBeNull(); expect(() => disabled.save('token')).not.toThrow();
  });
});

describe('host discovery and release compatibility', () => {
  it('probes only the host info endpoint, with no credentials, redirects, secrets or referrer', async () => {
    const fetch = vi.fn(async () => response(info));
    expect(await probeHost(target, { fetch })).toEqual(info);
    expect(fetch).toHaveBeenCalledWith('https://host.example/api/info', expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', mode: 'cors' }));
  });
  it('requires exact build and protocol; old hosts are recognized and explained', async () => {
    expect(hostCompatibilityError(info)).toBeNull();
    // A disconnected human can retain a reserved seat while no players are connected.
    expect(parseHostInfo({ ...info, players: 0, seated: 1 })).toMatchObject({ players: 0, seated: 1 });
    expect(hostCompatibilityError({ ...info, build: 'other-release' })).toMatch(/different game builds/);
    expect(hostCompatibilityError({ ...info, protocol: PROTOCOL_VERSION - 1 })).toMatch(/different multiplayer versions/);
    expect(hostCompatibilityError({ protocol: PROTOCOL_VERSION })).toMatch(/different game builds/);
    expect(hostCompatibilityError({ protocol: PROTOCOL_VERSION, build: 'development' }, 'release')).not.toBeNull();
    const old = { ...info, protocol: 13, build: undefined, instanceId: undefined }; delete old.build; delete old.instanceId;
    expect(parseHostInfo(old)?.build).toBe('');
    await expect(probeHost(target, { fetch: async () => response(old) })).rejects.toThrow(/different multiplayer versions/);
    expect(await probeHost(target, { fetch: async () => response(old), checkCompatibility: false })).toMatchObject({ protocol: 13 });
  });
  it('explains HTTP, unreachable/CORS, non-JSON and invalid info failures', async () => {
    await expect(probeHost(target, { fetch: async () => ({ ok: false, status: 403 }) as Response })).rejects.toThrow(/HTTP 403/);
    await expect(probeHost(target, { fetch: async () => { throw new TypeError('Failed to fetch'); } })).rejects.toThrow(/CORS/);
    await expect(probeHost(target, { fetch: async () => ({ ok: true, json: async () => { throw new Error(); } }) as unknown as Response })).rejects.toThrow(/did not return FLAGHACK/);
    for (const value of [null, {}, { ...info, players: -1 }, { ...info, seated: 5 }, { ...info, protocol: 14.5 }, { ...info, build: 12 }]) {
      await expect(probeHost(target, { fetch: async () => response(value) })).rejects.toThrow(/not a valid FLAGHACK/);
    }
  });
  it('cancels existing requests and rejects pre-aborted requests without network traffic', async () => {
    const abort = new AbortController(); abort.abort();
    const fetch = vi.fn(async () => response(info));
    await expect(probeHost(target, { fetch, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    const next = new AbortController();
    const pending = probeHost(target, { signal: next.signal, fetch: (_url, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))) });
    next.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('bounds the wait and reports timeout separately from CORS/network errors', async () => {
    vi.useFakeTimers();
    const pending = probeHost(target, { timeoutMs: 250, fetch: (_url, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))) });
    const result = expect(pending).rejects.toThrow(/did not answer in time/);
    await vi.advanceTimersByTimeAsync(250); await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
