import { normalizeMatch } from "../src/sim/matchSettings";
/**
 * The host over real sockets: startHost in-process on an ephemeral port, `ws` clients speaking the
 * protocol. The host ticks on wall time, so match tests wait on conditions with deadlines.
 */
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetMirror } from '../src/net/mirror';
import { MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION } from '../src/net/protocol';
import { AVATAR, FACTION_DEFS } from '../src/sim/constants';
import { canPlantAt } from '../src/sim/systems/flags';
import type { AvatarInput } from '../src/sim/types';
import { CHANGE_COOLDOWN_MS, CLOSE_DENIED, MAX_PLAYERS } from './room';
import { cleanup, connect, hello, host, join, PASSWORD, until } from './testkit';
import type { Client } from './testkit';

const STILL: AvatarInput = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };

afterEach(cleanup);

/** One input frame per sim tick (60 Hz, on an absolute schedule like the host's); returns the next seq. */
async function stream(c: Client, firstSeq: number, count: number, input: AvatarInput): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    c.send({ t: 'input', seq: firstSeq + i, input, cmds: [] });
    const wait = t0 + ((i + 1) * 1000) / 60 - performance.now();
    if (wait > 0) await sleep(wait);
  }
  return firstSeq + count;
}

async function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET') {
  const req = request({ host: '127.0.0.1', port, path, method, headers });
  req.end();
  const [res]: IncomingMessage[] = await once(req, 'response');
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  const out: { status: number; headers: IncomingHttpHeaders; body: Buffer } = {
    status: res.statusCode ?? 0,
    headers: res.headers,
    body: Buffer.concat(chunks),
  };
  return out;
}

/** Nearest node `faction 0` may plant on, `minD`..`maxD` m from `at` (on the `toward` side if given), or -1. */
function nearestPlantable(mirror: NetMirror, at: { x: number; z: number }, minD: number, maxD: number, toward?: { x: number; z: number }): number {
  const nodes = mirror.world.lattice.nodes;
  let best = -1;
  let bestD = Infinity;
  for (let n = 0; n < nodes.length; n++) {
    const dx = nodes[n].x - at.x;
    const dz = nodes[n].z - at.z;
    const d = Math.hypot(dx, dz);
    if (d < minD || d > maxD || d >= bestD) continue;
    if (toward && dx * toward.x + dz * toward.z <= 0) continue;
    if (!canPlantAt(mirror.world, n, 0)) continue;
    best = n;
    bestD = d;
  }
  return best;
}

describe('handshake', () => {
  it('denies a wrong password, then throttles the address even for the right one', async () => {
    const h = await host();
    for (let i = 0; i < 5; i++) {
      const c = await connect(h);
      hello(c, 'mallory', null, 'flags-are-sticky');
      expect((await c.next('denied')).reason).toBe('password');
      expect(await c.closed()).toBe(CLOSE_DENIED);
    }
    const c = await connect(h);
    hello(c, 'mallory');
    expect((await c.next('denied')).reason).toBe('throttled');
  });

  it('explains a protocol mismatch and refuses a blank handle', async () => {
    const h = await host();
    const old = await connect(h);
    hello(old, 'alice', null, PASSWORD, PROTOCOL_VERSION + 1);
    const denied = await old.next('denied');
    expect(denied.reason).toBe('protocol');
    expect(denied.message).toMatch(/reload/i);
    const blank = await connect(h);
    hello(blank, ' \u200b\t ');
    expect((await blank.next('denied')).reason).toBe('name');
  });

  it('welcomes with a token, seats newcomers in order, keeps handles unique and makes the first the leader', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    expect(alice.me.token).toMatch(/^[0-9a-f]{32}$/);
    expect(alice.me.lobby.leaderId).toBe(alice.me.playerId);
    expect(alice.me.lobby.seats[0].playerId).toBe(alice.me.playerId);
    const bob = await join(h, '  Bob\u0000\u202e\n ');
    const twin = await join(h, 'ALICE');
    expect(twin.me.lobby.players.map((p) => p.name)).toEqual(['alice', 'Bob', 'ALICE 2']);
    expect(twin.me.lobby.seats.map((s) => s.playerId)).toEqual([alice.me.playerId, bob.me.playerId, twin.me.playerId, null]);
    const seen = await alice.c.next('lobby', (m) => m.lobby.players.length === 3);
    expect(seen.lobby.leaderId).toBe(alice.me.playerId);
    expect((await get(h.port, '/api/info')).body.toString()).toBe(
      JSON.stringify({ serverName: 'Test burn', protocol: PROTOCOL_VERSION, phase: 'lobby', players: 3, seated: 3 }),
    );
  });

  it(`turns away player ${MAX_PLAYERS + 1}`, async () => {
    const h = await host();
    for (let i = 0; i < MAX_PLAYERS; i++) await join(h, `p${i}`);
    const late = await connect(h);
    hello(late, 'late');
    expect((await late.next('denied')).reason).toBe('full');
  });
});

describe('lobby', () => {
  it('replicates custom setup and refuses disabled seats', async()=>{
    const h=await host();const alice=await join(h,'alice');
    const match=normalizeMatch({active:[0],days:3,dayLength:300,gridScale:10});
    alice.c.send({t:'settings',settings:{match}});
    const changed=await alice.c.next('lobby',m=>m.lobby.settings.match?.days===3);
    expect(changed.lobby.settings.match).toEqual(match);
    await sleep(CHANGE_COOLDOWN_MS+50);
    alice.c.send({t:'seat',seat:1});
    alice.c.send({t:'start'});
    const start=await alice.c.next('matchStart',undefined,15000);
    expect(start.seat).toBe(0);expect(start.options.match).toEqual(match);
    expect(Object.values(start.snapshot.ents.avatars)).toHaveLength(1);
  });

  it('lets only the leader change settings and start; matchStart carries the options and a snapshot', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const bob = await join(h, 'bob');
    bob.c.send({ t: 'settings', settings: { difficulty: 'hard' } });
    bob.c.send({ t: 'start' });
    bob.c.send({ t: 'seat', seat: 3 });
    await alice.c.next('lobby', (m) => m.lobby.seats[3].playerId === bob.me.playerId);
    await sleep(CHANGE_COOLDOWN_MS + 50);
    bob.c.send({ t: 'ready', ready: true });
    const after = await alice.c.next('lobby', (m) => m.lobby.players.some((p) => p.id === bob.me.playerId && p.ready));
    expect(after.lobby.phase).toBe('lobby');
    expect(after.lobby.settings).toMatchObject({ difficulty: 'normal', seed: null });
    expect(after.lobby.seats.map((s) => s.playerId)).toEqual([alice.me.playerId, null, null, bob.me.playerId]);

    bob.c.send({ t: 'seat', seat: 0 });
    alice.c.send({ t: 'settings', settings: { difficulty: 'chill', seed: '  test \n seed ' } });
    const set = await bob.c.next('lobby', (m) => m.lobby.settings.difficulty === 'chill');
    expect(set.lobby.settings.seed).toBe('test seed');

    alice.c.send({ t: 'start' });
    const [a, b] = await Promise.all([alice.c.next('matchStart', undefined, 15_000), bob.c.next('matchStart', undefined, 15_000)]);
    expect(a.seat).toBe(0);
    expect(b.seat).toBe(3);
    expect(a.options).toEqual({ seed: 'test seed', difficulty: 'chill', humans: [0, 3], mode: 'standard', match: normalizeMatch() });
    expect(a.snapshot.tick).toBe(0);
    expect(b.snapshot).toEqual(a.snapshot);
    await alice.c.next('lobby', (m) => m.lobby.phase === 'playing');
    await until(() => alice.c.frames.length >= 3, 'state frames');
    const ticks = alice.c.frames.map((f) => f.tick);
    expect(ticks.slice(1).every((t, i) => t - ticks[i] === 2)).toBe(true);
  });

  it('passes five chat lines per five seconds and tells only the sender the mesh is jammed', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const bob = await join(h, 'bob');
    for (let i = 1; i <= 7; i++) alice.c.send({ t: 'chat', text: `line ${i}` });
    await alice.c.next('chat', (m) => m.line.from === null && m.line.text.includes('jammed'));
    alice.c.send({ t: 'ping', id: 9, clientTime: 1.5 });
    const pong = await alice.c.next('pong');
    expect(pong).toMatchObject({ id: 9, clientTime: 1.5 });
    await sleep(100);
    const heard = bob.c.take('chat');
    expect(heard.filter((m) => m.line.playerId === alice.me.playerId).map((m) => m.line.text)).toEqual([
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
    ]);
    expect(heard.some((m) => m.line.text.includes('jammed'))).toBe(false);
  });

  it('passes leadership to the longest-connected player; a returning leader keeps the seat, not the lead', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const bob = await join(h, 'bob');
    const carol = await join(h, 'carol');
    alice.c.ws.close();
    const after = await carol.c.next('lobby', (m) => m.lobby.leaderId !== alice.me.playerId);
    expect(after.lobby.leaderId).toBe(bob.me.playerId);
    await carol.c.next('chat', (m) => m.line.text === 'bob now leads the burn.');
    const back = await join(h, 'alice', alice.me.token);
    expect(back.me.playerId).toBe(alice.me.playerId);
    expect(back.me.lobby.leaderId).toBe(bob.me.playerId);
    expect(back.me.lobby.seats[0].playerId).toBe(alice.me.playerId);
  });

  it('lets one seat/settings/ready change through per cooldown however fast a player toggles', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const bob = await join(h, 'bob');
    await alice.c.next('lobby', (m) => m.lobby.players.length === 2);
    await sleep(50);
    bob.c.take('lobby');
    bob.c.take('chat');
    // A second and a half of toggling at ~200 messages/s (under the socket's own flood limit).
    const t0 = Date.now();
    for (let i = 0; Date.now() - t0 < 1500; i++) {
      alice.c.send({ t: 'seat', seat: i % 2 === 0 ? 3 : 2 });
      alice.c.send({ t: 'settings', settings: { seed: `flood-${i}` } });
      alice.c.send({ t: 'ready', ready: i % 2 === 0 });
      await sleep(15);
    }
    await sleep(300);
    expect(alice.c.closeCode).toBeNull();
    // One change per half second: three or four of them, each one lobby frame and at most one line.
    const frames = bob.c.take('lobby');
    const lines = bob.c.take('chat').filter((m) => m.line.text.startsWith('alice '));
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.length).toBeLessThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it('charges the system lines a player causes to their chat budget, reconnects included', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const bob = await join(h, 'bob');
    await alice.c.next('lobby', (m) => m.lobby.players.length === 2);
    bob.c.take('chat');
    // Five seat changes, each past the cooldown: five lines fill alice's five-second budget.
    for (let i = 0; i < 5; i++) {
      const seat = i % 2 === 0 ? 2 : 3;
      alice.c.send({ t: 'seat', seat });
      await bob.c.next('lobby', (m) => m.lobby.seats[seat].playerId === alice.me.playerId);
      await sleep(CHANGE_COOLDOWN_MS + 50);
    }
    // Past the budget the changes still happen, silently: leaving, returning, another seat.
    alice.c.ws.close();
    await bob.c.next('lobby', (m) => m.lobby.players.some((p) => p.id === alice.me.playerId && !p.connected));
    const back = await join(h, 'alice', alice.me.token);
    back.c.send({ t: 'seat', seat: 3 });
    await bob.c.next('lobby', (m) => m.lobby.seats[3].playerId === alice.me.playerId && m.lobby.players.every((p) => p.connected));
    back.c.send({ t: 'chat', text: 'still here?' });
    await back.c.next('chat', (m) => m.line.from === null && m.line.text.includes('jammed'));
    await sleep(100);
    // bob also hears the room's own line about the lead passing to him; only alice's lines count.
    const aboutAlice = bob.c.take('chat').map((m) => m.line.text).filter((text) => text.startsWith('alice'));
    expect(aboutAlice).toEqual([
      'alice takes up the Flags of DJ Scarecrow.',
      'alice takes up the Flags of President Jaguar.',
      'alice takes up the Flags of DJ Scarecrow.',
      'alice takes up the Flags of President Jaguar.',
      'alice takes up the Flags of DJ Scarecrow.',
    ]);
  });
});

describe('match', () => {
  it('consumes one input frame per tick, acks it, moves the avatar and applies a plant', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const id = alice.me.playerId;
    alice.c.mirrored = true;
    alice.c.send({ t: 'start' });
    await alice.c.next('matchStart', undefined, 15_000);
    const mirror = alice.c.mirror;
    if (!mirror) throw new Error('no mirror');
    const avatarId = mirror.world.factions[0].avatarId;
    const where = (): { x: number; z: number } => {
      const av = mirror.latestAvatar(avatarId);
      if (!av) throw new Error('avatar not replicated');
      return { x: av.pos.x, z: av.pos.z };
    };
    const from = where();
    // A free node 6-20 m out toward the burn's centre (the camps' clear corridor).
    const target = nearestPlantable(mirror, from, 6, 20, { x: -from.x, z: -from.z });
    expect(target).toBeGreaterThanOrEqual(0);
    const goal = mirror.world.lattice.nodes[target];

    // Steer there the way a player would: look at the replicated position, push the stick.
    let seq = 1;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const p = where();
      const d = Math.hypot(goal.x - p.x, goal.z - p.z);
      if (d < 1.5) break;
      if (Date.now() > deadline) throw new Error(`never reached node ${target} (${d.toFixed(1)} m short)`);
      seq = await stream(alice.c, seq, 6, { ...STILL, moveX: (goal.x - p.x) / d, moveZ: (goal.z - p.z) / d });
    }
    seq = await stream(alice.c, seq, 20, STILL);
    await until(() => mirror.latestAck(id) === seq - 1, `the host to ack seq ${seq - 1}`);
    const acks = alice.c.frames.map((f) => f.acks[id] ?? 0);
    expect(acks.slice(1).every((a, i) => a >= acks[i])).toBe(true);
    const to = where();
    expect(Math.hypot(to.x - from.x, to.z - from.z)).toBeGreaterThan(4);

    // Plant there (or next door if a Signifier beat us to it). The host stamps the seat's
    // faction (0) over the 3 the client claims.
    mirror.catchUp();
    const node = canPlantAt(mirror.world, target, 0) ? target : nearestPlantable(mirror, to, 0, AVATAR.plantReach - 0.3);
    expect(node).toBeGreaterThanOrEqual(0);
    alice.c.send({ t: 'input', seq, input: STILL, cmds: [{ t: 'plant', faction: 3, node }] });
    await until(
      () => alice.c.frames.some((f) => f.events.some((e) => e.t === 'flagPlanted' && e.node === node && e.faction === 0)),
      'the planted flag',
    );
  });

  it('hands a dropped seat to an NPC after the grace and back to the player who returns with the token', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const bob = await join(h, 'bob');
    const bobId = bob.me.playerId;
    alice.c.mirrored = true;
    alice.c.send({ t: 'start' });
    await Promise.all([alice.c.next('matchStart', undefined, 15_000), bob.c.next('matchStart', undefined, 15_000)]);
    await until(() => alice.c.frames.some((f) => bobId in f.acks), "bob's ack in the frames");
    const mirror = alice.c.mirror;
    if (!mirror) throw new Error('no mirror');
    const bobAvatar = mirror.world.factions[1].avatarId;
    const bobAt = (): { x: number; z: number } => {
      const av = mirror.latestAvatar(bobAvatar);
      if (!av) throw new Error('avatar not replicated');
      return { x: av.pos.x, z: av.pos.z };
    };

    bob.c.ws.close();
    await alice.c.next('chat', (m) => m.line.text === 'bob wandered off into the dust.');
    const droppedAt = Date.now();
    const left = bobAt();
    const takeover = await alice.c.next('chat', (m) => m.line.text.startsWith('An NPC steers'), 10_000);
    expect(Date.now() - droppedAt).toBeGreaterThan(4500);
    expect(takeover.line.text).toBe(`An NPC steers ${FACTION_DEFS[1].name} until bob returns.`);
    // The abandoned vexillomancer stood still through the grace; now the NPC walks it and nobody's
    // inputs are acked for that seat.
    const handed = bobAt();
    expect(Math.hypot(handed.x - left.x, handed.z - left.z)).toBeLessThan(0.5);
    const seen = alice.c.frames.length;
    await until(() => {
      const p = bobAt();
      return Math.hypot(p.x - handed.x, p.z - handed.z) > 1;
    }, 'the NPC to move the avatar', 10_000);
    expect(alice.c.frames.slice(seen).some((f) => bobId in f.acks)).toBe(false);

    const back = await join(h, 'bob', bob.me.token);
    expect(back.me.playerId).toBe(bobId);
    expect(back.me.lobby.seats[1].playerId).toBe(bobId);
    expect((await back.c.next('matchStart')).seat).toBe(1);
    await stream(back.c, 1, 10, STILL);
    await until(() => back.c.frames.some((f) => (f.acks[bobId] ?? 0) === 10), 'acks for the returned player');
    await alice.c.next('chat', (m) => m.line.text === 'bob found their way back.');
  });

  it('lets a late joiner watch, then take a seat only from the NPCs', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    alice.c.send({ t: 'start' });
    await alice.c.next('matchStart', undefined, 15_000);
    const carol = await join(h, 'carol');
    expect(carol.me.lobby.phase).toBe('playing');
    expect((await carol.c.next('matchStart')).seat).toBeNull();
    carol.c.send({ t: 'seat', seat: 0 });
    carol.c.send({ t: 'seat', seat: 2 });
    const seated = await carol.c.next('matchStart');
    expect(seated.seat).toBe(2);
    expect(seated.options.humans).toEqual([0, 2]);
    await stream(carol.c, 1, 6, STILL);
    await until(() => carol.c.frames.some((f) => (f.acks[carol.me.playerId] ?? 0) === 6), 'acks for the new seat');
  });

  it('holds mid-match seat swapping to the same cooldown: few handovers, snapshots and log lines', async () => {
    const logs: string[] = [];
    const h = await host({ log: (line) => logs.push(line) });
    const alice = await join(h, 'alice');
    alice.c.send({ t: 'start' });
    await alice.c.next('matchStart', undefined, 15_000);
    const carol = await join(h, 'carol');
    await carol.c.next('matchStart');
    const t0 = Date.now();
    for (let i = 0; Date.now() - t0 < 1200; i++) {
      carol.c.send({ t: 'seat', seat: i % 2 === 0 ? 2 : 3 });
      await sleep(10);
    }
    await sleep(300);
    // Changes land at ~0, ~0.5 and ~1.0 s: one fresh snapshot and at most two log lines each.
    const starts = carol.c.take('matchStart');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.length).toBeLessThanOrEqual(3);
    expect(logs.filter((line) => line.includes('takes over seat')).length).toBeLessThanOrEqual(2 * starts.length);
  });
});

describe('hostile input', () => {
  it('drops garbage, cuts oversized frames and repeat offenders, and the burn goes on', async () => {
    const h = await host();
    const alice = await join(h, 'alice');
    const mallory = await join(h, 'mallory');
    const junk = ['', 'not json', '{"t":"plant"}', '{"t":"__proto__"}', '[]', 'null', '{"t":"input","seq":1}', '['.repeat(20_000)];
    for (const j of junk) mallory.c.ws.send(j);
    mallory.c.ws.send(Buffer.from([0xff, 0, 1, 2]));
    mallory.c.send({ t: 'chat', text: 'still here' });
    await alice.c.next('chat', (m) => m.line.text === 'still here');
    for (let i = 0; i < 20; i++) mallory.c.ws.send('garbage');
    expect(await mallory.c.closed()).toBe(1008);

    const big = await join(h, 'big');
    big.c.ws.send('x'.repeat(MAX_CLIENT_MESSAGE_BYTES + 1));
    expect(await big.c.closed()).toBe(1009);

    const rude = await connect(h);
    rude.send({ t: 'start' });
    expect(await rude.closed()).toBe(1008);

    alice.c.send({ t: 'chat', text: 'unbothered' });
    await alice.c.next('chat', (m) => m.line.text === 'unbothered');
  });
});

describe('http', () => {
  it('serves the built client with types and caching, answers INFO_PATH and never leaves its root', async () => {
    const dir = await mkdtemp(joinPath(tmpdir(), 'flaghack-host-'));
    const dist = joinPath(dir, 'dist');
    await mkdir(joinPath(dist, 'assets'), { recursive: true });
    await writeFile(joinPath(dist, 'index.html'), '<!doctype html><title>burn</title>');
    const js = `console.log(${JSON.stringify('flag '.repeat(1000))});`;
    await writeFile(joinPath(dist, 'assets', 'index-abc123.js'), js);
    await writeFile(joinPath(dist, '.env'), 'hidden');
    await writeFile(joinPath(dir, 'secret.txt'), 'outside the root');
    try {
      const h = await host({ staticDir: dist });
      const index = await get(h.port, '/');
      expect(index.status).toBe(200);
      expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(index.headers['cache-control']).toBe('no-cache');

      const asset = await get(h.port, '/assets/index-abc123.js', { 'accept-encoding': 'gzip, deflate, br' });
      expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(asset.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(asset.body).toString()).toBe(js);
      expect((await get(h.port, '/assets/index-abc123.js', { 'if-none-match': String(asset.headers.etag) })).status).toBe(304);

      const info = await get(h.port, '/api/info');
      expect(info.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(info.body.toString())).toEqual({ serverName: 'Test burn', protocol: PROTOCOL_VERSION, phase: 'lobby', players: 0, seated: 0 });

      for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2f..%2fsecret.txt', '/..%5csecret.txt', '/.env', '/%00', '/assets/']) {
        const res = await get(h.port, path);
        expect(res.status, path).toBe(404);
        expect(res.body.toString(), path).not.toMatch(/outside|hidden/);
      }
      expect((await get(h.port, '/', {}, 'POST')).status).toBe(405);
      const stray = await connect(h, { path: '/not-the-socket' });
      expect(await stray.closed()).toBe(1006);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
