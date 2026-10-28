import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FACTION_IDS } from '../sim/types';
import { normalizeMatch } from '../sim/matchSettings';
import type { FactionId, MatchOptions } from '../sim/types';
import { NetClient } from './client';
import type { NetClientHooks, TokenStore } from './client';
import { PROTOCOL_VERSION } from './protocol';
import type { LobbyPhase, LobbyState } from './protocol';

/** Just enough of a browser WebSocket for NetClient, driven by the test. */
class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The network or host drops the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function lobby(phase: LobbyPhase, seat: FactionId | null = 2): LobbyState {
  return {
    serverName: 'Alchemy',
    phase,
    leaderId: 'p1',
    settings: { difficulty: 'normal', seed: null },
    seats: FACTION_IDS.map((f) => ({ faction: f, playerId: f === seat ? 'p1' : null })),
    players: [{ id: 'p1', name: 'alice', seat, ready: true, connected: true, ping: 0 }],
    match: phase === 'lobby' ? null : { time: 3, winner: null },
  };
}

const OPTIONS: MatchOptions = { seed: 'net-client', difficulty: 'normal', humans: [2], mode: 'standard' };

function setup(token: string | null = null) {
  FakeSocket.made = [];
  const calls: string[] = [];
  let saved: string | null = token;
  const tokens: TokenStore = {
    load: () => saved,
    save: (t) => {
      saved = t;
    },
  };
  const hooks: NetClientHooks = {
    lobby: (l) => calls.push(`lobby:${l.phase}`),
    matchStart: (_o, seat) => calls.push(`match:${seat}`),
    state: () => calls.push('state'),
    closed: (error) => calls.push(`closed:${error ?? 'voluntary'}`),
  };
  const client = new NetClient({
    url: 'ws://host/ws',
    name: '  alice  ',
    password: 'pw',
    serverName: 'the host',
    hooks,
    tokens,
    // The fake stands in for the browser socket; NetClient only uses the members it implements.
    connect: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  return { client, calls, savedToken: () => saved };
}

function socket(i: number): FakeSocket {
  const s = FakeSocket.made[i];
  if (!s) throw new Error(`no socket #${i}`);
  return s;
}

/** Joined and playing seat 2. */
function inMatch() {
  const t = setup();
  socket(0).open();
  socket(0).receive({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'development', playerId: 'p1', token: 'tok-1', lobby: lobby('lobby') });
  socket(0).receive({ t: 'matchStart', inputEpoch: 1, options: OPTIONS, seat: 2, snapshot: {} });
  return t;
}

describe('NetClient', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says hello with the stored token and keeps the new one', () => {
    const { client, calls, savedToken } = setup('old-token');
    expect(client.status).toBe('connecting');
    socket(0).open();
    expect(socket(0).sent[0]).toEqual({ t: 'hello', protocol: PROTOCOL_VERSION, build: 'development', name: 'alice', password: 'pw', token: 'old-token' });
    expect(client.status).toBe('joining');
    socket(0).receive({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'development', playerId: 'p1', token: 'tok-1', lobby: lobby('lobby') });
    expect(client.status).toBe('lobby');
    expect(client.serverName).toBe('Alchemy');
    expect(client.isLeader).toBe(true);
    expect(client.seat).toBe(2);
    expect(savedToken()).toBe('tok-1');
    expect(calls).toEqual(['lobby:lobby']);
  });

  it('rejects mismatched welcome protocol/build before saving a token or entering a lobby', () => {
    for (const mismatch of [{ protocol: PROTOCOL_VERSION - 1, build: 'development' }, { protocol: PROTOCOL_VERSION, build: 'other-release' }, { protocol: PROTOCOL_VERSION }]) {
      const { client, calls, savedToken } = setup('old-token');
      socket(0).open();
      socket(0).receive({ t: 'welcome', ...mismatch, playerId: 'p1', token: 'new-token', lobby: lobby('lobby') });
      expect(client.status).toBe('closed'); expect(client.error).toMatch(/different/);
      expect(savedToken()).toBe('old-token'); expect(calls).toHaveLength(1); expect(calls[0]).toMatch(/^closed:/);
    }
  });

  it('times out a silent WebSocket handshake, and cancellation prevents a late welcome', () => {
    const { client } = setup();
    socket(0).open(); vi.advanceTimersByTime(10_000);
    expect(client.status).toBe('closed'); expect(client.error).toMatch(/WebSocket/);
    socket(0).receive({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'development', playerId: 'p1', token: 'late', lobby: lobby('lobby') });
    expect(client.status).toBe('closed'); expect(client.playerId).toBeNull();
  });

  it('rides out a drop mid-match: backoff, hello with the token, no lobby flash', () => {
    const { client, calls } = inMatch();
    expect(client.status).toBe('match');
    socket(0).drop();
    expect(client.reconnecting).toBe(true);
    expect(client.status).toBe('match');
    expect(client.connected).toBe(false);
    vi.advanceTimersByTime(499);
    expect(FakeSocket.made.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.made.length).toBe(2);
    // The host is still down: the next try waits twice as long.
    socket(1).drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.made.length).toBe(2);
    vi.advanceTimersByTime(1);
    socket(2).open();
    expect(socket(2).sent[0]).toMatchObject({ t: 'hello', token: 'tok-1' });
    socket(2).receive({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'development', playerId: 'p1', token: 'tok-1', lobby: lobby('playing') });
    expect(client.reconnecting).toBe(false);
    expect(client.status).toBe('match');
    socket(2).receive({ t: 'matchStart', inputEpoch: 1, options: OPTIONS, seat: 2, snapshot: {} });
    expect(calls).toEqual(['lobby:lobby', 'match:2', 'lobby:playing', 'match:2']);
    expect(client.connected).toBe(true);
  });

  it('gives up a minute after the transmission dropped', () => {
    const { client, calls } = inMatch();
    socket(0).drop();
    let n = 1;
    for (let t = 0; t < 70_000 && client.status !== 'closed'; t += 100) {
      vi.advanceTimersByTime(100);
      while (FakeSocket.made.length > n) socket(n++).drop();
    }
    expect(client.status).toBe('closed');
    expect(client.error).toBe('Lost the transmission from the host.');
    expect(calls[calls.length - 1]).toBe('closed:Lost the transmission from the host.');
    // Backoff caps at 5 s: about 0.5 + 1 + 2 + 4 + 5×10 s of tries, not hundreds.
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(20);
  });

  it('stops for good on a wrong password, and retries a throttle while reconnecting', () => {
    const wrong = setup();
    socket(0).open();
    socket(0).receive({ t: 'denied', reason: 'password', message: 'Wrong password.' });
    socket(0).close(4001);
    vi.advanceTimersByTime(10_000);
    expect(wrong.client.status).toBe('closed');
    expect(wrong.client.error).toBe('Wrong password.');
    expect(FakeSocket.made.length).toBe(1);

    const { client } = inMatch();
    socket(0).drop();
    vi.advanceTimersByTime(500);
    socket(1).open();
    socket(1).receive({ t: 'denied', reason: 'throttled', message: 'Slow down.' });
    socket(1).close(4001);
    expect(client.status).toBe('match');
    expect(client.reconnecting).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made.length).toBe(3);
  });

  it('closes with a reason when another window takes the handle or the host shuts down', () => {
    const replaced = inMatch();
    socket(0).drop(4000);
    expect(replaced.client.status).toBe('closed');
    expect(replaced.client.error).toBe('This handle was claimed from another window.');

    const shutdown = inMatch();
    socket(0).receive({ t: 'notice', text: 'The host is shutting down.' });
    socket(0).drop(1001);
    expect(shutdown.client.error).toBe('The host is shutting down.');
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.made.length).toBe(1);
  });

  it('leaves voluntarily without an error and without retrying', () => {
    const { client, calls } = inMatch();
    client.leave();
    expect(client.status).toBe('closed');
    expect(client.error).toBeNull();
    expect(calls[calls.length - 1]).toBe('closed:voluntary');
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.made.length).toBe(1);
  });

  it('waits for the takeover snapshot, suppresses stale input, and reports rejected claims', () => {
    const { client, calls } = inMatch();
    const input = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
    client.sendInput(40, input, []);
    expect(socket(0).sent.at(-1)).toMatchObject({ t: 'input', inputEpoch: 1, seq: 40 });
    client.requestBossTakeover(3);
    client.requestBossTakeover(1);
    expect(socket(0).sent.at(-1)).toEqual({ t: 'bossTakeover', seat: 3 });
    const count = socket(0).sent.length;
    client.sendInput(41, input, []);
    expect(socket(0).sent).toHaveLength(count);
    socket(0).receive({ t: 'bossTakeoverResult', seat: 3, ok: true, reason: null });
    expect(client.pendingBossTakeover).toBe(3);
    expect(client.seat).toBe(2);
    socket(0).receive({ t: 'matchStart', options: { ...OPTIONS, humans: [3] }, seat: 3, inputEpoch: 2, snapshot: {} });
    expect(client.pendingBossTakeover).toBeNull();
    expect(client.seat).toBe(3);
    expect(calls.at(-1)).toBe('match:3');
    client.sendInput(1, input, []);
    expect(socket(0).sent.at(-1)).toMatchObject({ t: 'input', inputEpoch: 2, seq: 1 });
    client.requestBossTakeover(1);
    socket(0).receive({ t: 'bossTakeoverResult', seat: 1, ok: false, reason: 'That camp is reserved.' });
    expect(client.pendingBossTakeover).toBeNull();
    expect(client.bossTakeoverError).toBe('That camp is reserved.');
    expect(client.seat).toBe(3);
  });

  it('waits for the new snapshot before resuming input after reconnect, and clears pending claims', () => {
    const { client } = inMatch();
    client.requestBossTakeover(3);
    socket(0).drop();
    expect(client.pendingBossTakeover).toBeNull();
    vi.advanceTimersByTime(500);
    socket(1).open();
    socket(1).receive({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'development', playerId: 'p1', token: 'tok-1', lobby: lobby('playing', 3) });
    const input = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
    client.sendInput(42, input, []);
    expect(socket(1).sent).toHaveLength(1);
    socket(1).receive({ t: 'matchStart', options: OPTIONS, seat: 3, inputEpoch: 3, snapshot: {} });
    client.sendInput(1, input, []);
    expect(socket(1).sent.at(-1)).toMatchObject({ t: 'input', inputEpoch: 3, seq: 1 });
  });
});

describe('host-acknowledged lobby setup', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());
  const messages = (kind: string, i = 0) => socket(i).sent.filter((m: any) => m.t === kind) as any[];
  function ready() {
    const t = setup(); socket(0).open();
    socket(0).receive({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'development', playerId: 'p1', token: 'tok-1', lobby: lobby('lobby') });
    return t;
  }
  function echo(settings: any, extra: Partial<LobbyState> = {}) {
    socket(0).receive({ t: 'lobby', lobby: { ...lobby('lobby'), settings, ...extra } });
  }

  it('coalesces three rapid independent toggles, keeps optimistic state through stale echoes, and starts only after final acknowledgment', () => {
    const { client } = ready();
    for (const key of ['buildingCapture', 'crystalFlagProtection', 'crystalAttacks'] as const) {
      client.setSettings({ match: { ...normalizeMatch(client.setupSettings?.match), [key]: false } });
      vi.advanceTimersByTime(80);
    }
    expect(client.setupSettings?.match).toMatchObject({ buildingCapture: false, crystalFlagProtection: false, crystalAttacks: false });
    expect(client.lobby?.settings.match).toBeUndefined(); // authoritative state is never optimistic
    echo(lobby('lobby').settings);
    expect(client.setupSettings?.match?.buildingCapture).toBe(false);
    client.start(); client.start();
    expect(client.startPending).toBe(true); expect(messages('start')).toHaveLength(0);
    vi.advanceTimersByTime(550);
    expect(messages('settings')).toHaveLength(1);
    expect(messages('settings')[0].settings.match).toMatchObject({ buildingCapture: false, crystalFlagProtection: false, crystalAttacks: false });
    expect(messages('start')).toHaveLength(0);
    echo(messages('settings')[0].settings);
    expect(client.settingsPending).toBe(false); expect(client.startPending).toBe(false);
    expect(messages('start')).toHaveLength(1);
  });

  it('does not confuse an older in-flight acknowledgment with newer changes or overwrite their cumulative settings', () => {
    const { client } = ready();
    client.setSettings({ match: normalizeMatch({ buildingCapture: false }) });
    vi.advanceTimersByTime(550);
    const first = messages('settings')[0].settings;
    client.setSettings({ match: { ...client.setupSettings!.match!, crystalFlagProtection: false } });
    client.setSettings({ match: { ...client.setupSettings!.match!, crystalAttacks: false } });
    client.start();
    vi.advanceTimersByTime(1500);
    expect(messages('settings')).toHaveLength(1); expect(messages('start')).toHaveLength(0);
    echo(first);
    expect(client.setupSettings!.match).toMatchObject({ buildingCapture: false, crystalFlagProtection: false, crystalAttacks: false });
    vi.advanceTimersByTime(549); expect(messages('settings')).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(messages('settings')).toHaveLength(2);
    expect(messages('start')).toHaveLength(0);
    echo(messages('settings')[1].settings);
    expect(messages('start')).toHaveLength(1);
  });

  it('paces setup after other lobby mutations and canonicalizes the seed like the host', () => {
    const { client } = ready();
    client.setSettings({ seed: '  a\n  b\u200b  ' });
    vi.advanceTimersByTime(400); client.setReady(true);
    vi.advanceTimersByTime(150); expect(messages('settings')).toHaveLength(0);
    vi.advanceTimersByTime(550); expect(messages('settings')).toHaveLength(1);
    expect(messages('settings')[0].settings.seed).toBe('a b');
    echo(messages('settings')[0].settings);
    expect(client.settingsPending).toBe(false);
  });

  it.each(['leader', 'phase'] as const)('cancels queued changes and Start on %s loss without sending them', reason => {
    const { client } = ready();
    client.setSettings({ match: normalizeMatch({ crystalAttacks: false }) }); client.start();
    echo(lobby('lobby').settings, reason === 'leader' ? { leaderId: 'other' } : { phase: 'playing' });
    vi.advanceTimersByTime(2000);
    expect(messages('settings')).toHaveLength(0); expect(messages('start')).toHaveLength(0);
    expect(client.settingsPending).toBe(false); expect(client.startPending).toBe(false);
    expect(client.settingsError).toMatch(/no longer editable/);
    client.setSettings({ match: normalizeMatch() }); client.start();
    vi.advanceTimersByTime(1000); expect(messages('settings')).toHaveLength(0); expect(messages('start')).toHaveLength(0);
  });

  it('cancels uncertain edits and Start on disconnect instead of replaying them after reconnection', () => {
    const { client } = ready();
    client.setSettings({ match: normalizeMatch({ buildingCapture: false }) });
    vi.advanceTimersByTime(550); client.start(); socket(0).drop();
    expect(client.settingsError).toMatch(/Connection interrupted/);
    expect(client.settingsPending).toBe(false); expect(client.startPending).toBe(false);
    vi.advanceTimersByTime(500); socket(1).open();
    const applied = { ...lobby('lobby'), settings: messages('settings')[0].settings };
    socket(1).receive({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'development', playerId: 'p1', token: 'tok-1', lobby: applied });
    vi.advanceTimersByTime(2000);
    expect(client.setupSettings!.match!.buildingCapture).toBe(false);
    expect(messages('settings', 1)).toHaveLength(0); expect(messages('start', 1)).toHaveLength(0);
  });

  it('fails visibly and never starts if the host does not acknowledge a rejected setup, and allows an explicit retry', () => {
    const { client } = ready();
    client.setSettings({ match: normalizeMatch({ buildingCapture: false }) }); client.start();
    vi.advanceTimersByTime(10_550);
    expect(messages('settings')).toHaveLength(1); expect(messages('start')).toHaveLength(0);
    expect(client.settingsPending).toBe(false); expect(client.startPending).toBe(false);
    expect(client.settingsError).toMatch(/did not confirm/);
    client.setSettings({ match: normalizeMatch({ crystalAttacks: false }) });
    expect(client.settingsError).toBeNull(); vi.advanceTimersByTime(550);
    echo(messages('settings')[1].settings);
    expect(client.settingsPending).toBe(false); expect(messages('start')).toHaveLength(0);
  });

  it('cancels timers on leave and does not mutate settings during a match', () => {
    const { client } = ready();
    client.setSettings({ match: normalizeMatch({ crystalAttacks: false }) }); client.start(); client.leave();
    vi.advanceTimersByTime(20_000);
    expect(messages('settings')).toHaveLength(0); expect(messages('start')).toHaveLength(0);
    const playing = inMatch().client;
    playing.setSettings({ match: normalizeMatch({ crystalAttacks: false }) }); playing.start();
    vi.advanceTimersByTime(2000);
    expect(messages('settings')).toHaveLength(0); expect(messages('start')).toHaveLength(0);
  });
});
