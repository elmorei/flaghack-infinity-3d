import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_ID } from '../src/net/build';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { cleanup, connect, hello, host, join, PASSWORD } from './testkit';
afterEach(cleanup);
describe('host authoritative RTS seats', () => {
  it.each([['avatar', 'rts'], ['rts', 'avatar']] as const)('assigns %s leader and %s guest independently in the initial handshake', async (leaderMode, guestMode) => {
    const h = await host();
    const leader = await connect(h), guest = await connect(h);
    const greet = (c: typeof leader, name: string, controlMode: 'avatar' | 'rts', token: string | null = null) =>
      c.send({ t: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_ID, password: PASSWORD, name, token, controlMode });
    greet(leader, 'leader', leaderMode); const me = await leader.next('welcome');
    greet(guest, 'guest', guestMode); const other = await guest.next('welcome');
    expect(other.lobby.players.map(p => p.controlMode)).toEqual([leaderMode, guestMode]);
    // Reclaiming a saved lobby seat uses the current device, not the old selector preference.
    const back = await connect(h);
    const changed = leaderMode === 'avatar' ? 'rts' : 'avatar';
    greet(back, 'leader', changed, me.token);
    const welcome = await back.next('welcome');
    expect(welcome.lobby.players.find(p => p.id === me.playerId)?.controlMode).toBe(changed);
    expect(welcome.lobby.players.find(p => p.id === other.playerId)?.controlMode).toBe(guestMode);
    // A second reclaim restores the original device before starting, without touching guest or AI.
    const current = await connect(h); greet(current, 'leader', leaderMode, me.token); await current.next('welcome');
    current.send({ t: 'start' });
    const started = await current.next('matchStart', undefined, 15000);
    expect(started.options.rtsFactions).toEqual([leaderMode, guestMode].flatMap((mode, i) => mode === 'rts' ? [i] : []));
    const live = await connect(h); greet(live, 'leader', changed, me.token); await live.next('welcome');
    const resumed = await live.next('matchStart', undefined, 15000);
    expect(resumed.options.rtsFactions).toEqual(started.options.rtsFactions);
    expect(resumed.seat).toBe(0);
  });

  it('lets each player change only their own live mode and preserves it through reconnects', async () => {
    const h = await host();
    const leader = await join(h, 'leader'), guest = await join(h, 'guest');
    leader.c.mirrored = guest.c.mirrored = true;
    guest.c.send({ t: 'controlMode', mode: 'rts' });
    const lobby = await leader.c.next('lobby', m => m.lobby.players.find(p => p.id === guest.me.playerId)?.controlMode === 'rts');
    expect(lobby.lobby.players.find(p => p.id === leader.me.playerId)?.controlMode).toBe('avatar');
    guest.c.send({ t: 'controlMode', mode: 'rts', faction: 0 });
    leader.c.send({ t: 'start' });
    const start = await guest.c.next('matchStart', undefined, 15000);
    await leader.c.next('matchStart', undefined, 15000);
    expect(start.options.rtsFactions).toEqual([1]);
    expect(guest.c.mirror!.world.factions[1].controlMode).toBe('rts');
    expect(guest.c.mirror!.world.avatarOf(1)).toBeUndefined();
    guest.c.send({ t: 'controlMode', mode: 'avatar' });
    const switched = await guest.c.next('matchStart', undefined, 15000);
    expect(switched.inputEpoch).toBeGreaterThan(start.inputEpoch);
    expect(guest.c.mirror!.world.avatarOf(1)).toBeDefined();
    guest.c.send({ t: 'ping', id: 45, clientTime: 0 }); await guest.c.next('pong', m => m.id === 45);
    const late = await connect(h); late.mirrored = true; hello(late, 'late'); await late.next('welcome');
    expect((await late.next('matchStart', undefined, 15000)).options.rtsFactions).toEqual([]);
    const back = await connect(h); back.mirrored = true; hello(back, 'guest', guest.me.token); await back.next('welcome');
    const resumed = await back.next('matchStart', undefined, 15000);
    expect(resumed.seat).toBe(1); expect(back.mirror!.world.factions[1].controlMode).toBe('avatar');
  });
});
