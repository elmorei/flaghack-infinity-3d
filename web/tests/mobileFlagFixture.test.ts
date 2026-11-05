import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatch } from '../src/sim/setup';
import { Simulation } from '../src/sim/simulation';
import { normalizeMatch } from '../src/sim/matchSettings';
import * as factory from '../src/sim/factory';
import * as flags from '../src/sim/systems/flags';
import { brainOf } from '../src/sim/systems/units/brain';
import type { World } from '../src/sim/world';
// @ts-expect-error The native browser harness intentionally ships as unbundled JavaScript.
import { stageMobileFlagOrderFixture } from '../scripts/verify-mobile-flag-orders.mjs';

afterEach(() => vi.unstubAllGlobals());

describe('native physical Flag fixture with ordinary live simulation', () => {
  for (const mixed of [false, true]) for (const kind of ['recruit', 'plant'] as const) {
    it(`${mixed ? 'existing carrier group' : 'empty worker'} ${kind} remains isolated and consumes one real Flag`, () => {
      let world!: World;
      let observe = () => {};
      const host: any = {
        flaghack: {
          net: null,
          world: undefined as World | undefined,
          session: { settings: { match: normalizeMatch({}) } },
          ai: new Map(),
          startMatch(options: any) {
            world = createMatch({ difficulty: 'normal', mode: 'standard', ...options, match: normalizeMatch(options.match) });
            this.world = world;
          },
        },
        fh: { factory, flags },
      };
      vi.stubGlobal('window', host);
      vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { observe = fn; return 1; });
      stageMobileFlagOrderFixture({ mixed, kind });
      const q = host.__flagQA, sim = new Simulation(world);
      const first = world.hippies.get(q.first)!, second = mixed ? world.hippies.get(q.second)! : undefined;
      const target = world.hippies.get(q.target)!;
      sim.step(); world.drainEvents(); observe();
      const mind = brainOf(target); mind.task = 'wander'; mind.waitUntil = Infinity; mind.moving = false;
      target.vel = { x: 0, z: 0 };
      // Allow real walking and building systems during the native menu/selection interval.
      for (let i = 0; i < 120; i++) { sim.step(); world.drainEvents(); observe(); }
      expect(target.faction).toBe(-1);
      expect(world.gccOf(0)?.disabled).toBe(false);
      if (second) expect(second.carryingFlag).toBe(q.carried);
      const stockCount = () => [...world.flags.values()].filter(f => f.state === 'stock' && f.owner === 0).length;
      expect(stockCount()).toBe(q.stockBefore);
      world.submit({ t: 'order', faction: 0, hippies: [first.id, ...(second ? [second.id] : [])], order: kind === 'recruit' ? { kind, target: target.id } : { kind, node: q.node } });
      const complete = () => kind === 'recruit' ? target.faction === 0 : world.survey.nodeFlag[q.node] >= 0;
      for (let i = 0; i < 90 * 60 && !complete(); i++) { sim.step(); world.drainEvents(); observe(); }
      expect(complete()).toBe(true);
      const spent = kind === 'recruit' ? target.carryingFlag : world.survey.nodeFlag[q.node];
      expect(q.stock).toContain(spent);
      expect(q.carry).toBe(true);
      expect(world.factions[0].lumber).toBe(0);
      expect(stockCount()).toBe(q.stockBefore - (mixed ? 0 : 1));
      expect(world.flags.size).toBe(q.flags);
      expect(world.hippies.size).toBe(q.people);
      expect(world.flags.get(spent)).toMatchObject({ owner: 0, state: kind === 'recruit' ? 'carried' : 'planted' });
      if (kind === 'recruit') expect(world.recentEvents().filter(e => e.t === 'recruited' && e.hippieId === target.id && e.via === 'hand')).toHaveLength(1);
      if (second) {
        expect(spent).toBe(q.carried);
        expect(q.followerCarry).toBe(false);
        expect(q.followerFetch).toBe(false);
        expect(q.orders).toEqual([{ id: first.id, kind: 'move' }, { id: second.id, kind }]);
      }
    });
  }
});
