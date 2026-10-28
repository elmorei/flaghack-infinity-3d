import { afterEach, describe, expect, it } from 'vitest';
import { normalizeMatch } from '../src/sim/matchSettings';
import { cleanup, connect, hello, host, join } from './testkit';

afterEach(cleanup);
const keys = ['buildingCapture', 'crystalFlagProtection', 'crystalAttacks'] as const;

describe('host-authoritative optional rules', () => {
  it.each(Array.from({ length: 8 }, (_, mask) => [mask]))('replicates combination %s to both clients and late joins, rejecting guest and live edits', async mask => {
    const h = await host();
    const leader = await join(h, 'leader'), guest = await join(h, 'guest');
    leader.c.mirrored = guest.c.mirrored = true;
    for (const key of keys) expect(leader.me.lobby.settings.match?.[key]).toBe(true);
    const match = normalizeMatch({ ...Object.fromEntries(keys.map((key, bit) => [key, !!(mask & (1 << bit))])), maxSignifiers: 0 });
    leader.c.send({ t: 'settings', settings: { seed: `optional-rules-${mask}`, match } });
    for (const c of [leader.c, guest.c]) {
      const lobby = await c.next('lobby', m => m.lobby.settings.seed === `optional-rules-${mask}`);
      expect(lobby.lobby.settings.match).toEqual(match);
    }
    const opposite = { ...match, ...Object.fromEntries(keys.map(key => [key, !match[key]])) };
    guest.c.send({ t: 'settings', settings: { match: opposite } });
    guest.c.send({ t: 'ping', id: 1, clientTime: 0 });
    await guest.c.next('pong', m => m.id === 1);
    leader.c.send({ t: 'start' });
    for (const c of [leader.c, guest.c]) {
      expect((await c.next('matchStart', undefined, 15000)).options.match).toEqual(match);
      expect(c.mirror!.world.options.match).toEqual(match);
    }
    leader.c.send({ t: 'settings', settings: { match: opposite } });
    leader.c.send({ t: 'ping', id: 2, clientTime: 0 });
    await leader.c.next('pong', m => m.id === 2);
    const late = await connect(h); late.mirrored = true; hello(late, 'late watcher');
    await late.next('welcome');
    expect((await late.next('matchStart', undefined, 15000)).options.match).toEqual(match);
    expect(late.mirror!.world.options.match).toEqual(match);
  });
});
