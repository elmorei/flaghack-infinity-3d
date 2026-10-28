import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, connect, hello, host, join } from './testkit';
afterEach(cleanup);
describe('host authoritative RTS seats', () => {
  it('lets each player choose only their own next-match mode; freezes mode through live edits and reconnects', async () => {
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
    guest.c.send({ t: 'ping', id: 45, clientTime: 0 }); await guest.c.next('pong', m => m.id === 45);
    const late = await connect(h); late.mirrored = true; hello(late, 'late'); await late.next('welcome');
    expect((await late.next('matchStart', undefined, 15000)).options.rtsFactions).toEqual([1]);
    const back = await connect(h); back.mirrored = true; hello(back, 'guest', guest.me.token); await back.next('welcome');
    const resumed = await back.next('matchStart', undefined, 15000);
    expect(resumed.seat).toBe(1); expect(back.mirror!.world.factions[1].controlMode).toBe('rts');
  });
});
