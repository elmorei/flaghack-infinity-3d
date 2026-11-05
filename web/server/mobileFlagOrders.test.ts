/** Commands traverse the real WebSocket server, authority checks and replicated world. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { spawnHippie } from '../src/sim/factory';
import { normalizeMatch } from '../src/sim/matchSettings';
import type { World } from '../src/sim/world';
import { cleanup, connect, hello, host, join, until } from './testkit';

const STILL = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); });
describe('group Flag orders over real host sockets', () => {
  it('assigns one real stock fetch, replicates it to both players and a late join, and refuses foreign workers', async () => {
    let live: World | null = null, staged = false, ids: number[] = [], target = -1;
    const original = Simulation.prototype.step;
    vi.spyOn(Simulation.prototype, 'step').mockImplementation(function(this: Simulation) {
      original.call(this); live = this.world;
      if (staged) return; staged = true;
      const w = this.world, home = w.hearthOf(0)!;
      for (let i = 0; i < 3; i++) {
        const p = w.nav.nearestWalkable(home.pos.x + 25 + i * 2, home.pos.z + 10);
        ids.push(spawnHippie(w, 0, p).id);
      }
      target = spawnHippie(w, -1, w.nav.nearestWalkable(home.pos.x + 70, home.pos.z + 45)).id;
    });
    const h = await host(), alice = await join(h, 'mobile commander'), bob = await join(h, 'other player');
    alice.c.mirrored = bob.c.mirrored = true;
    alice.c.send({ t: 'settings', settings: { seed: 'mobile-group-socket', match: normalizeMatch({ startingSignifiers: 0, maxSignifiers: 0, active: [0, 1], bossMode: false, days: 3 }) } });
    await alice.c.next('lobby', m => m.lobby.settings.seed === 'mobile-group-socket');
    alice.c.send({ t: 'start' });
    await Promise.all([alice.c.next('matchStart', undefined, 15000), bob.c.next('matchStart', undefined, 15000)]);
    await until(() => { alice.c.mirror!.catchUp(); return ids.length === 3 && alice.c.mirror!.world.hippies.has(target); }, 'staged workers on the client');
    const send = (client: typeof alice.c, seq: number, order: unknown) => client.send({ t: 'input', inputEpoch: client.inputEpoch, seq, input: STILL, cmds: [order] });
    // The server binds the supplied faction to the authenticated seat; Bob cannot command Alice's group.
    send(bob.c, 1, { t: 'order', faction: 0, hippies: ids, order: { kind: 'recruit', target } });
    bob.c.send({ t: 'ping', id: 801, clientTime: 0 }); await bob.c.next('pong', m => m.id === 801);
    expect(ids.every(id => live!.hippies.get(id)!.order === null)).toBe(true);
    send(alice.c, 1, { t: 'order', faction: 0, hippies: ids, order: { kind: 'recruit', target } });
    const checkOrders = (w: World) => ids.filter(id => w.hippies.get(id)?.order?.kind === 'recruit').length === 1 && ids.filter(id => w.hippies.get(id)?.order?.kind === 'move').length === 2;
    await until(() => { alice.c.mirror!.catchUp(); bob.c.mirror!.catchUp(); return checkOrders(alice.c.mirror!.world) && checkOrders(bob.c.mirror!.world); }, 'single bearer replicated on both clients');
    expect(checkOrders(live!)).toBe(true);
    const late = await connect(h); late.mirrored = true; hello(late, 'late observer'); await late.next('welcome'); await late.next('matchStart', undefined, 15000);
    expect(checkOrders(late.mirror!.world)).toBe(true);
    const bearer = ids.find(id => live!.hippies.get(id)!.order?.kind === 'recruit')!;
    expect(ids.filter(id => id !== bearer).every(id => live!.hippies.get(id)!.carryingFlag === -1)).toBe(true);
  }, 30000);
});
