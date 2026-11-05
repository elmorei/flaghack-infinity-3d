/** Real host sockets exercise authoritative claims, frame-boundary races and token reconnects. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bossFixture } from '../tests/bossFixture';
import { BUILD_ID } from '../src/net/build';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { ALIGN_COST } from '../src/sim/constants';
import { Simulation } from '../src/sim/simulation';
import { eliminateByBoss } from '../src/sim/systems/victory';
import type { FactionId } from '../src/sim/types';
import type { World } from '../src/sim/world';
import { Match } from './match';
import { Room } from './room';
import { cleanup, connect, hello, host, join, PASSWORD, until } from './testkit';

afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });
const STILL = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
type ControlMode = 'avatar' | 'rts';
interface Claimant {
  seat: FactionId | null;
  controlMode: ControlMode;
  nextControlMode: ControlMode;
  pendingBossSeat: FactionId | null;
  pendingBossMode: ControlMode | null;
}
const claims = Room.prototype as unknown as {
  takeBossSeat(player: Claimant, seat: FactionId, mode?: ControlMode): void;
  settleBossTakeovers(): void;
};

function campInvestment(world: World, seat: FactionId) {
  const camp = world.factions[seat];
  return { mode: camp.controlMode, ritual: camp.ritual, chakras: { ...camp.chakras }, avatarId: camp.avatarId };
}

function playerClaim(player: Claimant) {
  return { seat: player.seat, controlMode: player.controlMode, nextControlMode: player.nextControlMode,
    pendingBossSeat: player.pendingBossSeat, pendingBossMode: player.pendingBossMode };
}

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

  it('allows late spectators but blocks live humans and disconnected reserved camps', async () => {
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
    expect((await watcher.c.next('bossTakeoverResult')).ok).toBe(true);
    expect((await watcher.c.next('matchStart')).seat).toBe(2);
    a.c.send({ t: 'seat', seat: 2 });
    expect((await a.c.next('bossTakeoverResult')).ok).toBe(false);
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
    expect(back.me.lobby.seats[2].playerId).toBe(watcher.me.playerId);
  }, 20_000);

  it.each(['altar', 'outcome'] as const)('revalidates a reserved claim if the %s changes before its snapshot', async (change) => {
    const staged = stagedHost([0]);
    const h = await host();
    const a = await join(h, 'alice'); a.c.mirrored = true;
    a.c.send({ t: 'start' }); await a.c.next('matchStart');
    await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'the active boss');
    // Inject the condition after Room validates/reserves the request, before its frame commit.
    const world = staged.match().world;
    world.factions[2].chakras = { hoist: 3, fly: 2, field: 1, canton: 2, finial: 3 };
    world.factions[2].ritual = 7;
    let reserved: Claimant | undefined;
    const transitions: { before: ReturnType<typeof campInvestment>; after: ReturnType<typeof campInvestment> }[] = [];
    const request = claims.takeBossSeat, settle = claims.settleBossTakeovers;
    vi.spyOn(claims, 'takeBossSeat').mockImplementation(function(this: Room, player, seat, mode) {
      request.call(this, player, seat, mode);
      reserved = player;
      const w = staged.match().world;
      if (change === 'altar') removeAltars(w, seat);
      else { w.phase = 'ended'; w.bossOutcome = { kind: 'victory', winners: [1, 2, 3], at: w.time }; }
    });
    vi.spyOn(claims, 'settleBossTakeovers').mockImplementation(function(this: Room) {
      const before = reserved?.pendingBossSeat === 2 ? campInvestment(world, 2) : null;
      settle.call(this);
      if (before) transitions.push({ before, after: campInvestment(world, 2) });
    });
    a.c.send({ t: 'bossTakeover', seat: 2, mode: 'rts' });
    const result = await a.c.next('bossTakeoverResult');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/before the handoff/);
    expect(a.c.take('matchStart')).toEqual([]);
    expect(staged.match().world.options.humans).toEqual([0]);
    expect(staged.match().drivenByNpc(2)).toBe(true);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].after).toEqual(transitions[0].before);
    expect(playerClaim(reserved!)).toEqual({ seat: 0, controlMode: 'avatar', nextControlMode: 'avatar', pendingBossSeat: null, pendingBossMode: null });
  });

  it('allows the same authoritative claim before the boss appears', async () => {
    stagedHost([0], false);
    const h = await host();
    const a = await join(h, 'alice'); a.c.mirrored = true;
    a.c.send({ t: 'start' }); await a.c.next('matchStart');
    await until(() => { a.c.mirror!.catchUp(); return !a.c.mirror!.world.factions[0].alive; }, 'ordinary elimination');
    a.c.send({ t: 'bossTakeover', seat: 2 });
    expect((await a.c.next('bossTakeoverResult')).ok).toBe(true);
    expect((await a.c.next('matchStart')).seat).toBe(2);
  });
});

it('converts an inherited avatar camp to the RTS player’s chosen mode', async () => {
  const staged = stagedHost([0]); const h = await host(); const a = await join(h, 'rts-ruler'); a.c.mirrored = true;
  a.c.send({ t: 'controlMode', mode: 'rts' });
  await a.c.next('lobby', m => m.lobby.players.find(p => p.id === a.me.playerId)?.controlMode === 'rts');
  a.c.send({ t: 'start' }); await a.c.next('matchStart');
  await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'active boss');
  a.c.send({ t: 'bossTakeover', seat: 2 });
  expect(await a.c.next('bossTakeoverResult')).toMatchObject({ ok: true });
  expect((await a.c.next('matchStart')).seat).toBe(2);
  expect(staged.match().world.options.humans).toEqual([2]);
  expect(staged.match().world.factions[2].controlMode).toBe('rts');
  expect(staged.match().world.avatarOf(2)).toBeUndefined();
});

it('routes generic mid-match claims through the same RTS conversion', async () => {
  const staged = stagedHost([0], false); const h = await host(); const a = await join(h, 'rts-ruler'); a.c.mirrored = true;
  a.c.send({ t: 'controlMode', mode: 'rts' });
  await a.c.next('lobby', m => m.lobby.players.find(p => p.id === a.me.playerId)?.controlMode === 'rts');
  a.c.send({ t: 'start' }); await a.c.next('matchStart');
  await until(() => { a.c.mirror!.catchUp(); return !a.c.mirror!.world.factions[0].alive; }, 'ordinary elimination');
  a.c.send({ t: 'seat', seat: 2 }); a.c.send({ t: 'ping', id: 417, clientTime: 0 });
  await a.c.next('pong', m => m.id === 417);
  expect((await a.c.next('matchStart')).seat).toBe(2);
  expect(staged.match().world.options.humans).toEqual([2]);
  expect(staged.match().world.factions[2].controlMode).toBe('rts');
});


it('lets a Degen human take over NPC Crow without creating an avatar', async () => {
  const staged = stagedHost([0]); const h = await host(); const a = await join(h, 'crow-ruler'); a.c.mirrored = true;
  a.c.send({ t: 'controlMode', mode: 'rts' });
  await a.c.next('lobby', m => m.lobby.players.find(p => p.id === a.me.playerId)?.controlMode === 'rts');
  a.c.send({ t: 'start' }); await a.c.next('matchStart');
  await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'active boss');
  expect(staged.match().world.factions[1].controlMode).toBe('rts');
  a.c.send({ t: 'bossTakeover', seat: 1 });
  expect(await a.c.next('bossTakeoverResult')).toMatchObject({ ok: true });
  expect((await a.c.next('matchStart')).seat).toBe(1);
  expect(staged.match().world.factions[1].controlMode).toBe('rts');
  expect(staged.match().world.avatarOf(1)).toBeUndefined();
  expect(staged.match().drivenByNpc(1)).toBe(false);
});

describe('selected camp control mode', () => {
  it.each([
    ['eliminated', 'avatar'], ['eliminated', 'rts'], ['newcomer', 'avatar'], ['newcomer', 'rts'],
  ] as const)('commits %s choice of %s once and replicates it through peers, late joins and reconnects', async (kind, mode) => {
    const previousMode: ControlMode = mode === 'avatar' ? 'rts' : 'avatar';
    const target: FactionId = mode === 'avatar' ? 1 : 2;
    const staged = stagedHost([0]);
    const h = await host(), leader = await join(h, 'leader');
    leader.c.mirrored = true;
    if (previousMode !== 'avatar') {
      leader.c.send({ t: 'controlMode', mode: previousMode });
      await leader.c.next('lobby', m => m.lobby.players.find(p => p.id === leader.me.playerId)?.controlMode === previousMode);
    }
    leader.c.send({ t: 'start' }); await leader.c.next('matchStart');
    await until(() => { leader.c.mirror!.catchUp(); return !!leader.c.mirror!.world.boss; }, 'the active encounter');
    let claimant = leader;
    if (kind === 'newcomer') {
      const c = await connect(h); c.mirrored = true;
      c.send({ t: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_ID, name: 'newcomer', password: PASSWORD, token: null, controlMode: previousMode });
      claimant = { c, me: await c.next('welcome') };
      expect((await c.next('matchStart')).seat).toBeNull();
    }
    const observer = await connect(h); observer.mirrored = true;
    hello(observer, 'observer'); await observer.next('welcome'); await observer.next('matchStart');
    const world = staged.match().world, camp = world.factions[target];
    expect(camp.controlMode).toBe(previousMode);
    camp.chakras = { hoist: 3, fly: 2, field: 1, canton: 2, finial: 3 };
    camp.ritual = 7;
    const refund = ALIGN_COST.slice(0, 3).reduce((a, b) => a + b, 0)
      + ALIGN_COST.slice(0, 2).reduce((a, b) => a + b, 0) + ALIGN_COST[0];
    let reserved: Claimant | null = null;
    const requests: { before: ReturnType<typeof campInvestment>; after: ReturnType<typeof campInvestment>; player: ReturnType<typeof playerClaim> }[] = [];
    const commits: { before: ReturnType<typeof campInvestment>; after: ReturnType<typeof campInvestment>; player: ReturnType<typeof playerClaim> }[] = [];
    const request = claims.takeBossSeat, settle = claims.settleBossTakeovers;
    vi.spyOn(claims, 'takeBossSeat').mockImplementation(function(this: Room, player, seat, selectedMode) {
      const before = campInvestment(world, target);
      request.call(this, player, seat, selectedMode);
      reserved = player;
      requests.push({ before, after: campInvestment(world, target), player: playerClaim(player) });
    });
    vi.spyOn(claims, 'settleBossTakeovers').mockImplementation(function(this: Room) {
      const player = reserved;
      const before = player?.pendingBossSeat === target ? campInvestment(world, target) : null;
      settle.call(this);
      if (before && player) commits.push({ before, after: campInvestment(world, target), player: playerClaim(player) });
    });
    claimant.c.send({ t: 'bossTakeover', seat: target, mode });
    expect(await claimant.c.next('bossTakeoverResult')).toMatchObject({ seat: target, ok: true });
    const adopted = await claimant.c.next('matchStart');
    expect(adopted.seat).toBe(target);
    expect(adopted.options.rtsFactions?.includes(target)).toBe(mode === 'rts');
    expect(requests[0].after).toEqual(requests[0].before);
    expect(requests[0].player).toMatchObject({ controlMode: previousMode, nextControlMode: previousMode, pendingBossSeat: target, pendingBossMode: mode });
    expect(commits).toHaveLength(1);
    expect(commits[0].after.ritual).toBe(commits[0].before.ritual + refund);
    expect(commits[0].after.chakras).toEqual({ hoist: 0, fly: 0, field: 0, canton: 2, finial: 3 });
    expect(commits[0].player).toMatchObject({ seat: target, controlMode: mode, nextControlMode: mode, pendingBossSeat: null, pendingBossMode: null });
    expect(claimant.c.mirror!.world.factions[target].controlMode).toBe(mode);
    expect(!!claimant.c.mirror!.world.avatarOf(target)).toBe(mode === 'avatar');
    await until(() => { observer.mirror!.catchUp(); return observer.mirror!.world.factions[target].controlMode === mode; }, 'mode in existing peer state');
    expect(!!observer.mirror!.world.avatarOf(target)).toBe(mode === 'avatar');
    const late = await connect(h); late.mirrored = true;
    hello(late, 'late'); await late.next('welcome'); await late.next('matchStart');
    expect(late.mirror!.world.factions[target].controlMode).toBe(mode);
    expect(late.mirror!.world.factions[target].chakras).toEqual(commits[0].after.chakras);
    const back = await connect(h); back.mirrored = true;
    // Device default on a resumed connection must not undo the explicitly chosen live mode.
    back.send({ t: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_ID, name: 'returned', password: PASSWORD, token: claimant.me.token, controlMode: previousMode });
    const welcome = await back.next('welcome');
    expect(welcome.lobby.players.find(p => p.id === claimant.me.playerId)?.controlMode).toBe(mode);
    expect((await back.next('matchStart')).seat).toBe(target);
    expect(back.mirror!.world.factions[target].controlMode).toBe(mode);
    expect(!!back.mirror!.world.avatarOf(target)).toBe(mode === 'avatar');
    back.send({ t: 'bossTakeover', seat: target, mode: previousMode });
    expect(await back.next('bossTakeoverResult')).toMatchObject({ ok: false, reason: 'Only an eliminated player or spectator can take over an AI camp.' });
    expect(requests.at(-1)!.after).toEqual(requests.at(-1)!.before);
    expect(requests.at(-1)!.player).toMatchObject({ controlMode: mode, nextControlMode: previousMode, pendingBossSeat: null, pendingBossMode: null });
    expect(commits).toHaveLength(1);
  }, 20_000);

  it('does not let duplicate claims or mode/seat messages overwrite a reserved mode', async () => {
    const staged = stagedHost([0]), h = await host(), a = await join(h, 'alice'); a.c.mirrored = true;
    a.c.send({ t: 'start' }); await a.c.next('matchStart');
    await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'the active encounter');
    let reserved: Claimant | undefined;
    const request = claims.takeBossSeat;
    vi.spyOn(claims, 'takeBossSeat').mockImplementation(function(this: Room, player, seat, mode) {
      request.call(this, player, seat, mode); reserved = player;
    });
    const paused = vi.spyOn(claims, 'settleBossTakeovers').mockImplementation(() => {});
    a.c.send({ t: 'bossTakeover', seat: 2, mode: 'rts' });
    a.c.send({ t: 'ping', id: 701, clientTime: 0 }); await a.c.next('pong', m => m.id === 701);
    expect(playerClaim(reserved!)).toEqual({ seat: 0, controlMode: 'avatar', nextControlMode: 'avatar', pendingBossSeat: 2, pendingBossMode: 'rts' });
    a.c.send({ t: 'bossTakeover', seat: 2, mode: 'avatar' });
    expect(await a.c.next('bossTakeoverResult')).toMatchObject({ ok: false, reason: 'Wait for your current camp handoff to finish.' });
    a.c.send({ t: 'controlMode', mode: 'rts' });
    a.c.send({ t: 'seat', seat: null });
    a.c.send({ t: 'ping', id: 702, clientTime: 0 }); await a.c.next('pong', m => m.id === 702);
    expect(playerClaim(reserved!)).toEqual({ seat: 0, controlMode: 'avatar', nextControlMode: 'avatar', pendingBossSeat: 2, pendingBossMode: 'rts' });
    expect(staged.match().world.factions[2].controlMode).toBe('avatar');
    paused.mockRestore();
    expect(await a.c.next('bossTakeoverResult')).toMatchObject({ ok: true });
    await a.c.next('matchStart');
    expect(staged.match().world.factions[2].controlMode).toBe('rts');
    expect(playerClaim(reserved!)).toEqual({ seat: 2, controlMode: 'rts', nextControlMode: 'rts', pendingBossSeat: null, pendingBossMode: null });
  });

  it.each(['disconnect', 'replacement'] as const)('clears a pending choice on socket %s and uses the unchanged preference on an omitted-mode retry', async (change) => {
    const staged = stagedHost([0]), h = await host(), a = await join(h, 'alice'); a.c.mirrored = true;
    a.c.send({ t: 'start' }); await a.c.next('matchStart');
    await until(() => { a.c.mirror!.catchUp(); return !!a.c.mirror!.world.boss; }, 'the active encounter');
    let reserved: Claimant | undefined;
    const request = claims.takeBossSeat;
    vi.spyOn(claims, 'takeBossSeat').mockImplementation(function(this: Room, player, seat, mode) {
      request.call(this, player, seat, mode); reserved = player;
    });
    const paused = vi.spyOn(claims, 'settleBossTakeovers').mockImplementation(() => {});
    a.c.send({ t: 'bossTakeover', seat: 2, mode: 'rts' });
    a.c.send({ t: 'ping', id: 711, clientTime: 0 }); await a.c.next('pong', m => m.id === 711);
    expect(reserved?.pendingBossMode).toBe('rts');
    if (change === 'disconnect') { a.c.ws.close(); await a.c.closed(); }
    const back = await join(h, 'alice', a.me.token); await back.c.next('matchStart');
    await until(() => reserved?.pendingBossSeat === null, 'claim released after socket change');
    expect(playerClaim(reserved!)).toEqual({ seat: 0, controlMode: 'avatar', nextControlMode: 'avatar', pendingBossSeat: null, pendingBossMode: null });
    expect(staged.match().world.factions[2].controlMode).toBe('avatar');
    paused.mockRestore();
    back.c.send({ t: 'bossTakeover', seat: 2 });
    expect(await back.c.next('bossTakeoverResult')).toMatchObject({ ok: true });
    await back.c.next('matchStart');
    expect(staged.match().world.factions[2].controlMode).toBe('avatar');
    expect(playerClaim(reserved!)).toEqual({ seat: 2, controlMode: 'avatar', nextControlMode: 'avatar', pendingBossSeat: null, pendingBossMode: null });
  });
});
