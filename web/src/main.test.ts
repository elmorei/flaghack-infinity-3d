import { afterEach, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ boots: [] as unknown[] }));
vi.mock('./game/app', () => ({ App: class { constructor(_root: unknown, options: unknown) { captured.boots.push(options); } } }));
vi.mock('./game/debug', () => ({ installDebug: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it('boots a Pages invite as a prefilled form and never probes its remote host until Join', async () => {
  vi.resetModules(); captured.boots.length = 0;
  const loc = { protocol: 'https:', origin: 'https://player.github.io', pathname: '/flaghack/', search: '', hash: '#host=https%3A%2F%2Fprivate-host.example&pw=secret' };
  vi.stubGlobal('location', loc);
  const history = { state: null, replaceState: vi.fn(() => { loc.hash = ''; }) }; vi.stubGlobal('history', history);
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { fonts: { load: async () => [] }, getElementById: () => ({}) });
  const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => {
    expect(loc.hash).toBe('');
    return { ok: false, status: 404 } as Response;
  });
  vi.stubGlobal('fetch', fetch);
  await import('./main');
  await vi.waitFor(() => expect(captured.boots).toHaveLength(1));
  expect(captured.boots[0]).toEqual({ hostInfo: null, inviteHost: 'https://private-host.example', invitePassword: 'secret', inviteError: null });
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toBe('https://player.github.io/api/info');
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/flaghack/');
});

it('boots the existing offline Electron launcher without any host discovery request', async () => {
  vi.resetModules(); captured.boots.length = 0;
  vi.stubGlobal('location', { protocol: 'http:', origin: 'http://127.0.0.1:49321', pathname: '/', search: '', hash: '' });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/132.0.0.0 Electron/44.7.0' });
  vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { fonts: { load: async () => [] }, getElementById: () => ({}) });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await import('./main');
  await vi.waitFor(() => expect(captured.boots).toHaveLength(1));
  expect(captured.boots[0]).toMatchObject({ hostInfo: null, inviteHost: null, invitePassword: null });
  expect(fetch).not.toHaveBeenCalled();
});
