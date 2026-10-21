import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { Session } from './session';
import { BUILD_ID } from '../net/build';
import { PROTOCOL_VERSION } from '../net/protocol';

const info = { serverName: 'Remote burn', instanceId: 'abc', build: BUILD_ID, protocol: PROTOCOL_VERSION, phase: 'lobby', players: 0, seated: 0 };
class Socket {
  static made: Socket[] = [];
  readyState = 0; sent: unknown[] = [];
  onopen: (() => void) | null = null; onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) { Socket.made.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
}
function fixture() {
  const app: any = Object.create(App.prototype);
  const session = new Session(); session.screen = 'title';
  Object.assign(app, { session, client: null, hostInfo: null, inviteHost: null, invitePassword: null, joiningHost: false, joinAbort: null, joinError: null, loadAttract: vi.fn(), onClosed: vi.fn() });
  return app as App;
}
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve: (value = info) => resolve({ ok: true, json: async () => value } as Response) };
}
beforeEach(() => {
  Socket.made = []; vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'https:', origin: 'https://player.github.io' });
  const store = new Map([['flaghack:token:https://a.example', 'token-for-a']]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('explicit App remote joining', () => {
  it('never probes or opens a remote socket inside the locked offline launcher', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/132.0.0.0 Electron/44.7.0' });
    const app = fixture(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(app.remoteHostsAvailable).toBe(false);
    await app.joinHost('Alice', 'secret', 'https://remote.example');
    expect(fetch).not.toHaveBeenCalled(); expect(Socket.made).toHaveLength(0);
    expect(app.joinError).toMatch(/solo games offline/);
  });

  it('deduplicates repeated Join and sends credentials/token only after a compatible probe', async () => {
    const app = fixture(), pending = deferred(), fetch = vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => pending.promise); vi.stubGlobal('fetch', fetch);
    expect(fetch).not.toHaveBeenCalled();
    const join = app.joinHost('Alice', 'secret', 'https://a.example');
    await app.joinHost('Alice', 'secret', 'https://a.example');
    expect(fetch).toHaveBeenCalledOnce(); expect(Socket.made).toHaveLength(0); expect(app.joiningHost).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://a.example/api/info');
    pending.resolve(); await join;
    expect(Socket.made).toHaveLength(1); expect(Socket.made[0].url).toBe('wss://a.example/ws');
    Socket.made[0].open();
    expect(Socket.made[0].sent).toEqual([{ t: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_ID, name: 'Alice', password: 'secret', token: 'token-for-a' }]);
    await app.joinHost('Alice', 'secret', 'https://b.example'); expect(Socket.made).toHaveLength(1);
    app.cancelJoin(); expect(Socket.made[0].readyState).toBe(3); expect(app.net).toBeNull();
  });
  it('does not forward one target’s token to another target or put invite secrets into HTTP requests', async () => {
    const app = fixture(), fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => ({ ok: true, json: async () => info } as Response)); vi.stubGlobal('fetch', fetch);
    await app.joinHost('Alice', '', 'https://player.github.io/game/#host=https%3A%2F%2Fb.example&pw=secret');
    expect(fetch.mock.calls[0][0]).toBe('https://b.example/api/info');
    Socket.made[0].open(); expect(Socket.made[0].sent[0]).toMatchObject({ password: 'secret', token: null });
    app.cancelJoin();
  });
  it('aborts an edited target and ignores its late success even if fetch ignores abort', async () => {
    const app = fixture(), first = deferred(), next = deferred();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise); vi.stubGlobal('fetch', fetch);
    const old = app.joinHost('Alice', 'old', 'https://a.example');
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    app.cancelJoin(); expect(signal.aborted).toBe(true);
    const current = app.joinHost('Alice', 'new', 'https://b.example');
    first.resolve(); await old; expect(Socket.made).toHaveLength(0); expect(app.joiningHost).toBe(true);
    next.resolve(); await current; expect(Socket.made.map(s => s.url)).toEqual(['wss://b.example/ws']); app.cancelJoin();
  });
  it('cancels on solo navigation and never lets stale discovery switch the screen back', async () => {
    const app = fixture(), pending = deferred(); vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, _options?: RequestInit) => pending.promise));
    const join = app.joinHost('Alice', 'pw', 'https://a.example');
    app.openLobby(); expect(app.session.screen).toBe('lobby'); expect(app.joiningHost).toBe(false);
    pending.resolve(); await join; expect(app.net).toBeNull(); expect(Socket.made).toHaveLength(0); expect(app.session.screen).toBe('lobby');
  });
  it('rejects invalid addresses and incompatible builds without opening a socket', async () => {
    const app = fixture(), fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ...info, build: 'other' }) } as Response)); vi.stubGlobal('fetch', fetch);
    await app.joinHost('Alice', 'pw', 'http://remote.example'); expect(app.joinError).toMatch(/mixed content/); expect(fetch).not.toHaveBeenCalled();
    await app.joinHost('Alice', 'pw', 'https://remote.example'); expect(app.joinError).toMatch(/different game builds/); expect(Socket.made).toHaveLength(0);
    app.cancelJoin(); expect(app.joinError).toBeNull();
  });
  it('does not join from a non-title screen and exposes actionable failed-probe errors', async () => {
    const app = fixture(), fetch = vi.fn(async () => { throw new TypeError('blocked'); }); vi.stubGlobal('fetch', fetch);
    app.session.screen = 'playing'; await app.joinHost('Alice', 'pw', 'https://a.example'); expect(fetch).not.toHaveBeenCalled();
    app.session.screen = 'title'; await app.joinHost('Alice', 'pw', 'https://a.example'); expect(app.joinError).toMatch(/CORS/); expect(app.joiningHost).toBe(false);
  });
});
