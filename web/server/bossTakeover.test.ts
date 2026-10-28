/** Real host sockets exercise authoritative claims, frame-boundary races and token reconnects. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bossFixture } from '../tests/bossFixture';
import { Simulation } from '../src/sim/simulation';
import { eliminateByBoss } from '../src/sim/systems/victory';
import type { FactionId } from '../src/sim/types';
import type { World } from '../src/sim/world';
import { Match } from './match';
import { Room } from './room';
import { cleanup, connect, hello, host, join, until } from './testkit';

afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });
const STILL = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };

function removeAltars(world: World, faction: FactionId): void {
  for (const id of world.factions[faction].hearthIds) world.buildings.delete(id);
  world.factions[faction].hearthIds = [];
  eliminateByBoss(world, faction);
}

function stagedHost(eliminated: FactionId[], encounter = true) {
  let match: Match | null = null;
  let staged = false;
  const drive = Match.prototype.driveHuman;
  vi.spyOn(Match.prototype, 'driveHuman').mockImplementation(function(this: Match, f, playerId, epoch) {
    match = this;
    drive.call(this, f, playerId, epoch);
  });
  const step = Simulation.prototype.step;
  vi.spyOn(Simulation.prototype, 'step').mockImplementation(function(this: Simulation) {
    step.call(this);
    const w = this.world;
    if (!staged) {
      staged = true;
      if (encounter) {
        w.effigyRevealedAt = 0;
        w.boss = { ...bossFixture(), pos: { ...w.map.effigy }, action: 'emerge', target: null, held: null, barrier: null };
      }
      for (const f of eliminated) removeAltars(w, f);
    }
    // Keep the boss in its genuine emergence animation while testing the network race.
    // The normal sim, AI, inputs, snapshots and outcome rules all continue running.
    if (w.boss) w.boss.actionAt = w.time;
  });
  return { match: () => { if (!match) throw new Error('host did not start'); return match; } };
}

describe('authoritative boss camp handoff', () => {
  it('permits only one racing claimant, preserves the camp, resets input and retains ownership on reconnect/late join', async () => {
    const staged = stagedHost([0, 1]);
    const h = await host();
    const a = await join(h, 'alice');
    const b = await join(h, 'bob');
    a.c.mirrored = b.c.mirrored = true;
    a.c.send({ t: 'start' });
    const initial = await Promise.all([a.c.next('matchStart'), b.c.next('matchStart')]);
    await until(() => {
      a.c.mirror!.catchUp(); b.c.mirror!.catchUp();
      return [a.c, b.c].every((c) => !c.mirror!.world.factions[0].alive && !!c.mirror!.world.boss);
    }, 'eliminated humans and the active boss');
    const match = staged.match(), world = match.world;
    expect(world.phase).toBe('playing');
    const camp = world.factions[2];
    const avatar = world.avatars.get(camp.avatarId)!;
    avatar.hp = 0; avatar.koUntil = world.time + 60;
    camp.cooldowns.omega = world.time + 100;
    const existing = { avatarId: camp.avatarId, hearths: [...camp.hearthIds], flags: [...world.flags.keys()],
      hp: avatar.hp, koUntil: avatar.koUntil, carried: [...avatar.carried], omega: camp.cooldowns.omega };
    a.c.send({ t: 'bossTakeover', seat: 2 });
    // This old ownership frame is already in flight when the handoff is requested.
    a.c.send({ t: 'input', inputEpoch: initial[0].inputEpoch, seq: 100, input: { ...STILL, moveX: 1 }, cmds: [{ t: 'swing', faction: 2 }] });
    b.c.send({ t: 'bossTakeover', seat: 2 });
    const results = await Promise.all([a.c.next('bossTakeoverResult'), b.c.next('bossTakeoverResult')]);
    expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
    const winnerIndex = results[0].ok ? 0 : 1;
    const winner = [a, b][winnerIndex];
    const loser = [a, b][1 - winnerIndex];
    const takeover = await winner.c.next('matchStart');
    expect(takeover.seat).toBe(2);
    expect(takeover.inputEpoch).toBeGreaterThan(initial[winnerIndex].inputEpoch);
    expect(takeover.options.humans).toEqual([1 - winnerIndex, 2]);
    expect(match.drivenByNpc(2)).toBe(false);
    expect(match.drivenByNpc(3)).toBe(true);
    expect(world.factions[2]).toBe(camp);
    expect(world.avatars.get(camp.avatarId)).toBe(avatar);
    expect({ avatarId: camp.avatarId, hearths: camp.hearthIds, flags: [...world.flags.keys()], hp: avatar.hp,
      koUntil: avatar.koUntil, carried: avatar.carried, omega: camp.cooldowns.omega }).toEqual(existing);

    winner.c.send({ t: 'input', inputEpoch: initial[winnerIndex].inputEpoch, seq: 100, input: { ...STILL, moveX: 1 }, cmds: [] });
    winner.c.send({ t: 'input', inputEpoch: takeover.inputEpoch, seq: 1, input: STILL, cmds: [] });
    await until(() => winner.c.frames.some((frame) => frame.acks[winner.me.playerId] === 1), 'fresh epoch sequence 1');
    await until(() => {
      loser.c.mirror!.catchUp();
      return loser.c.mirror!.world.options.humans.includes(2) && !loser.c.mirror!.world.options.humans.includes(winnerIndex as FactionId);
    }, 'ownership metadata in an existing peer');
    const late = await connect(h); late.mirrored = true;
    hello(late, 'watcher'); await late.next('welcome'); await late.next('matchStart');
    expect(late.mirror!.world.options.humans).toEqual(takeover.options.humans);
    expect(late.mirror!.world.factions[2].avatarId).toBe(existing.avatarId);
    winner.c.ws.close(); await winner.c.closed();
    const back = await join(h, winnerIndex === 0 ? 'alice' : 'bob', winner.me.token);
    expect(back.me.playerId).toBe(winner.me.playerId);
    expect(back.me.lobby.seats[2].playerId).toBe(winner.me.playerId);
    const returned = await back.c.next('matchStart');
    expect(returned.seat).toBe(2);
    expect(returned.inputEpoch).toBeGreaterThan(takeover.inputEpoch);
  }, 20_000);

  it('blocks live humans, spectators, generic seat bypass and disconnected reserved camps even after AI takes over', async () => {
    const staged = stagedHost([0]);
    const h = await host();
    const a = await join(h, 'alice');
    const b = await join(h, 'bob');
    a.c.mirrored = true;
    a.c.send({ t: 'start' });
    await Promise.all([a.c.next('matchStart'), b.c.next('matchStart')]);
    await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'the active boss');
    b.c.send({ t: 'bossTakeover', seat: 2 });
    expect((await b.c.next('bossTakeoverResult')).ok).toBe(false);
    const watcher = await join(h, 'watcher'); await watcher.c.next('matchStart');
    watcher.c.send({ t: 'bossTakeover', seat: 2 });
    expect((await watcher.c.next('bossTakeoverResult')).ok).toBe(false);
    watcher.c.send({ t: 'seat', seat: 2 });
    a.c.send({ t: 'seat', seat: 2 });
    b.c.ws.close(); await b.c.closed();
    await a.c.next('chat', (m) => m.line.text.startsWith('An NPC steers'), 10_000);
    expect(staged.match().drivenByNpc(1)).toBe(true);
    a.c.send({ t: 'bossTakeover', seat: 1 });
    expect(await a.c.next('bossTakeoverResult')).toMatchObject({ ok: false, reason: 'That camp is reserved for another player.' });
    expect(watcher.c.take('matchStart')).toEqual([]);
    expect(a.c.take('matchStart')).toEqual([]);
    const back = await join(h, 'bob', b.me.token);
    expect((await back.c.next('matchStart')).seat).toBe(1);
    expect(back.me.lobby.seats[0].playerId).toBe(a.me.playerId);
    expect(back.me.lobby.seats[2].playerId).toBeNull();
  }, 20_000);

  it.each(['altar', 'outcome'] as const)('revalidates a reserved claim if the %s changes before its snapshot', async (change) => {
    const staged = stagedHost([0]);
    const h = await host();
    const a = await join(h, 'alice'); a.c.mirrored = true;
    a.c.send({ t: 'start' }); await a.c.next('matchStart');
    await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'the active boss');
    // Inject the condition after Room validates/reserves the request, before its frame commit.
    const prototype = Room.prototype as unknown as { takeBossSeat(player: unknown, seat: FactionId): void };
    const request = prototype.takeBossSeat;
    vi.spyOn(prototype, 'takeBossSeat').mockImplementation(function(this: Room, player, seat) {
      request.call(this, player, seat);
      const w = staged.match().world;
      if (change === 'altar') removeAltars(w, seat);
      else { w.phase = 'ended'; w.bossOutcome = { kind: 'victory', winners: [1, 2, 3], at: w.time }; }
    });
    a.c.send({ t: 'bossTakeover', seat: 2 });
    const result = await a.c.next('bossTakeoverResult');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/before the handoff/);
    expect(a.c.take('matchStart')).toEqual([]);
    expect(staged.match().world.options.humans).toEqual([0]);
    expect(staged.match().drivenByNpc(2)).toBe(true);
  });

  it('rejects the boss-only request before the boss and preserves ordinary mid-match seat behavior', async () => {
    stagedHost([0], false);
    const h = await host();
    const a = await join(h, 'alice'); a.c.mirrored = true;
    a.c.send({ t: 'start' }); await a.c.next('matchStart');
    await until(() => { a.c.mirror!.catchUp(); return !a.c.mirror!.world.factions[0].alive; }, 'ordinary elimination');
    a.c.send({ t: 'bossTakeover', seat: 2 });
    expect((await a.c.next('bossTakeoverResult')).ok).toBe(false);
    a.c.send({ t: 'seat', seat: 2 });
    expect((await a.c.next('matchStart')).seat).toBe(2);
  });
});

it('authoritatively refuses an RTS player taking an avatar camp', async () => {
  const staged = stagedHost([0]); const h = await host(); const a = await join(h, 'rts-ruler'); a.c.mirrored = true;
  a.c.send({ t: 'controlMode', mode: 'rts' });
  await a.c.next('lobby', m => m.lobby.players.find(p => p.id === a.me.playerId)?.controlMode === 'rts');
  a.c.send({ t: 'start' }); await a.c.next('matchStart');
  await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'active boss');
  a.c.send({ t: 'bossTakeover', seat: 1 });
  expect(await a.c.next('bossTakeoverResult')).toMatchObject({ ok: false, reason: expect.stringMatching(/RTS players can only/) });
  expect(staged.match().world.options.humans).toEqual([0]); expect(a.c.take('matchStart')).toEqual([]);
});

it('also refuses a generic mid-match seat request from an RTS player into an avatar camp', async () => {
  const staged = stagedHost([0], false); const h = await host(); const a = await join(h, 'rts-ruler'); a.c.mirrored = true;
  a.c.send({ t: 'controlMode', mode: 'rts' });
  await a.c.next('lobby', m => m.lobby.players.find(p => p.id === a.me.playerId)?.controlMode === 'rts');
  a.c.send({ t: 'start' }); await a.c.next('matchStart');
  await until(() => { a.c.mirror!.catchUp(); return !a.c.mirror!.world.factions[0].alive; }, 'ordinary elimination');
  a.c.send({ t: 'seat', seat: 1 }); a.c.send({ t: 'ping', id: 417, clientTime: 0 });
  await a.c.next('pong', m => m.id === 417);
  expect(staged.match().world.options.humans).toEqual([0]); expect(a.c.take('matchStart')).toEqual([]);
});
