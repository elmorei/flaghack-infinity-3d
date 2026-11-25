import { afterEach, expect, it, vi } from 'vitest';
import { Room } from '../../server/room';
import type { Match } from '../../server/match';
import { bossFixture } from '../../tests/bossFixture';
import { eliminateByBoss } from '../sim/systems/victory';
import { NetClient } from './client';
import { browserClientSocket, browserRoomSocket, localWires } from './browserBurn';
import { BUILD_ID } from './build';
import { LOBBY_CHANGE_COOLDOWN_MS, PROTOCOL_VERSION } from './protocol';
import type { ServerMessage } from './protocol';

let current: Room | null = null;
let claimant: NetClient | null = null;
afterEach(async () => {
  claimant?.leave();
  claimant = null;
  await current?.shutdown('test complete');
  current = null;
});

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function endpoint(room: Room, name: string, token: string | null = null) {
  const [host, guest] = localWires();
  const messages: ServerMessage[] = [];
  guest.onmessage = (text) => messages.push(JSON.parse(text));
  room.connect(browserRoomSocket(host), { address: name, peer: name });
  const send = (message: object) => guest.send(JSON.stringify(message));
  send({ t: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_ID, name, password: '', token });
  return { guest, send, messages };
}

it('starts, pauses, and reclaims an authoritative browser room seat through the portable transport', async () => {
  const room = current = new Room({ serverName: 'Browser test', admit: (password) => password === '', addressKey: (key) => key, log: () => {} });
  const host = endpoint(room, 'host');
  const guest = endpoint(room, 'guest');
  await flush();
  const welcome = guest.messages.find((m) => m.t === 'welcome');
  expect(welcome).toBeDefined();
  guest.send({ t: 'ready', ready: true });
  await flush();
  host.send({ t: 'start' });
  await flush();
  const start = guest.messages.find((m) => m.t === 'matchStart');
  expect(start?.seat).not.toBeNull();
  expect(start?.snapshot.tick).toBe(0);
  room.setPaused(true);
  expect(room.isPaused).toBe(true);
  guest.guest.close();
  await flush();
  const reconnect = endpoint(room, 'guest', welcome!.token);
  await flush();
  const rejoin = reconnect.messages.find((m) => m.t === 'matchStart');
  expect(reconnect.messages.find((m) => m.t === 'welcome')?.playerId).toBe(welcome!.playerId);
  expect(rejoin?.seat).toBe(start!.seat);
  expect(rejoin?.snapshot.tick).toBeGreaterThanOrEqual(start!.snapshot.tick);
  room.setPaused(false);
  expect(room.isPaused).toBe(false);
}, 20_000);

it.each(['spectator', 'eliminated'] as const)('lets a paused %s retry a camp claim without reconnecting', async (role) => {
  const room = current = new Room({ serverName: 'Browser test', admit: () => true, addressKey: key => key, log: () => {} });
  const host = endpoint(room, 'host');
  if (role === 'spectator') {
    await flush();
    host.send({ t: 'start' });
    await vi.waitFor(() => expect(host.messages.some(m => m.t === 'matchStart')).toBe(true));
  }
  const [serverWire, clientWire] = localWires();
  room.connect(browserRoomSocket(serverWire), { address: 'p', peer: 'p' });
  const client = claimant = new NetClient({
    url: '', name: 'claimant', password: '', serverName: 'Browser test', connect: () => browserClientSocket(clientWire),
    manualReconnect: true, tokens: { load: () => null, save: () => {} },
    hooks: { lobby: () => {}, matchStart: () => {}, state: () => {}, closed: () => {} },
  });
  if (role === 'eliminated') {
    await vi.waitFor(() => expect(client.connected).toBe(true));
    client.setReady(true);
    await flush();
    host.send({ t: 'start' });
  }
  await vi.waitFor(() => expect(client.status).toBe('match'));
  const match = (room as unknown as { match: Match }).match;
  const world = match.world;
  world.effigyRevealedAt = world.time;
  world.boss = { ...bossFixture(), pos: { ...world.map.effigy }, action: 'emerge',
    target: null, held: null, barrier: null, actionAt: world.time };
  if (role === 'eliminated') {
    expect(client.seat).toBe(1);
    for (const id of world.factions[1].hearthIds) world.buildings.delete(id);
    world.factions[1].hearthIds = [];
    eliminateByBoss(world, 1);
  } else expect(client.seat).toBeNull();

  const id = client.playerId;
  if (role === 'spectator') {
    // Allow the hello/claim microtasks, but not another simulation frame. Pause crosses a
    // genuinely reserved request, before settlement would change who controls the camp.
    client.requestBossTakeover(2, 'avatar');
    await flush();
    const player = (room as unknown as { players: Map<string, { pendingBossSeat: number | null }> }).players.get(id!);
    expect(player?.pendingBossSeat).toBe(2);
  }
  room.setPaused(true);
  await flush();
  client.requestBossTakeover(2, 'rts');
  expect(client.pendingBossTakeover).toBe(2);
  await flush();
  expect(client.pendingBossTakeover).toBeNull();
  expect(client.bossTakeoverError).toMatch(/paused.*resumes/);
  expect(match.drivenByNpc(2)).toBe(true);

  if (role === 'eliminated') await new Promise(resolve => setTimeout(resolve, LOBBY_CHANGE_COOLDOWN_MS));
  room.setPaused(false);
  if (role === 'spectator') {
    // An old, uncommitted claim must not silently apply on the first resumed frame.
    const tick = world.tick;
    await vi.waitFor(() => expect(world.tick).toBeGreaterThan(tick));
    expect(client.seat).toBeNull();
    expect(match.drivenByNpc(2)).toBe(true);
  }
  client.requestBossTakeover(2, 'rts');
  await vi.waitFor(() => expect(client.seat).toBe(2), { timeout: 3_000 });
  expect(client.playerId).toBe(id);
  expect(client.bossTakeoverError).toBeNull();
  expect(world.factions[2].controlMode).toBe('rts');
}, 15_000);

it.each([true, false])('guards a stalled browser host only when enabled (%s)', async (guarded) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const realNow = performance.now.bind(performance);
  let delay = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + delay);
  let pauses = 0;
  try {
    const room = current = new Room({
      serverName: 'Browser test', admit: () => true, addressKey: key => key, log: () => {},
      ...(guarded ? { onPerformancePause: () => { pauses++; } } : {}),
    });
    const host = endpoint(room, 'host'), guest = endpoint(room, 'guest');
    await flush();
    guest.send({ t: 'ready', ready: true });
    await flush();
    host.send({ t: 'start' });
    await flush();
    const match = (room as unknown as { match: Match }).match;
    expect(match).toBeDefined();
    const assertPauseMessage = () => expect(guest.messages.some(m =>
      m.t === 'chat' && m.line.text.includes('paused automatically'))).toBe(true);
    const wakeAfterHitch = (ms: number) => { delay += ms; vi.advanceTimersByTime(17); };

    wakeAfterHitch(250);
    expect(room.isPaused).toBe(false); // one brief hitch is not enough
    await vi.advanceTimersByTimeAsync(2_100);
    wakeAfterHitch(250);
    expect(room.isPaused).toBe(false); // old debt has expired
    wakeAfterHitch(250);
    expect(room.isPaused).toBe(guarded);
    await flush();
    if (!guarded) {
      const before = match.world.tick;
      wakeAfterHitch(1_600);
      expect(room.isPaused).toBe(false);
      expect(match.world.tick).toBeGreaterThan(before);
      expect(pauses).toBe(0);
      return;
    }

    expect(room.performancePaused).toBe(true);
    expect(pauses).toBe(1);
    assertPauseMessage();
    const pausedTick = match.world.tick;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(match.world.tick).toBe(pausedTick);
    expect(room.isPaused).toBe(true); // never resumes on its own

    room.setPaused(false);
    expect(room.performancePaused).toBe(false);
    await vi.advanceTimersByTimeAsync(34);
    expect(match.world.tick).toBeGreaterThan(pausedTick);
    wakeAfterHitch(250);
    expect(room.isPaused).toBe(false); // resume reset the missed-time window
    const beforeStall = match.world.tick;
    wakeAfterHitch(1_600);
    expect(room.performancePaused).toBe(true);
    expect(pauses).toBe(2);
    expect(match.world.tick).toBe(beforeStall); // no catch-up steps after a severe stall
  } finally {
    const shutdown = current?.shutdown('test complete');
    await vi.advanceTimersByTimeAsync(25);
    await shutdown;
    current = null;
    clock.mockRestore();
    vi.useRealTimers();
  }
}, 20_000);
