import { describe, expect, it } from 'vitest';
import { SnapshotEncoder } from '../../../net/codec';
import { NetMirror } from '../../../net/mirror';
import type { StateFrame } from '../../../net/protocol';
import { spawnBuilding, spawnHippie } from '../../factory';
import { normalizeMatch } from '../../matchSettings';
import { createMatch } from '../../setup';
import type { FactionId, MatchMode } from '../../types';
import { aboveAttentionCap, popCap, updateEconomy } from '../economy';
import { freeThickFacet } from './testkit';

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const recruiters = [['workshop', 5], ['gcc', 5], ['drumcircle', 14]] as const;
type RecruiterKind = typeof recruiters[number][0];

function fixture(kind: RecruiterKind, mode: MatchMode = 'standard', control: 'avatar' | 'rts' | 'npc' = 'avatar') {
  const world = createMatch({ seed: 'recruitment-cadence', mode, difficulty: 'normal',
    humans: control === 'npc' ? [] : [0, 1, 2, 3], rtsFactions: control === 'rts' ? [0, 1, 2, 3] : [],
    match: normalizeMatch({ bossMode: false, maxSignifiers: 0, startingSignifiers: 0 }) });
  world.hippies.clear();
  const faction: FactionId = control === 'npc' ? 1 : 0;
  const hearth = world.hearthOf(faction)!;
  const building = kind === 'gcc' ? world.gccOf(faction)!
    : spawnBuilding(world, kind, faction, freeThickFacet(world, hearth.pos.x, hearth.pos.z, 12, kind), 1);
  for (const b of world.buildings.values()) if (b.kind === 'gcc' && b !== building) b.disabled = true;
  for (const f of world.factions) f.lumber = 0;
  world.drainEvents();
  return { world, building, faction };
}

describe('passive recruitment cadence', () => {
  it.each(recruiters)('%s stays ready with an empty pool, but never banks a burst', (kind, interval) => {
    const { world, building, faction } = fixture(kind);
    updateEconomy(world, interval * 10);
    const first = spawnHippie(world, -1, building.pos);
    const second = spawnHippie(world, -1, building.pos);
    updateEconomy(world, .25);
    expect(first.faction).toBe(faction);
    expect(second.faction).toBe(-1);
    updateEconomy(world, interval - .25);
    expect(second.faction).toBe(-1);
    updateEconomy(world, .25);
    expect(second.faction).toBe(faction);
    expect(world.hippies.size).toBe(2);
  });

  it.each(recruiters)('%s pauses rather than charging its clock when unavailable', (kind, interval) => {
    const { world, building, faction } = fixture(kind);
    const target = spawnHippie(world, -1, building.pos);
    updateEconomy(world, interval / 2);
    building.disabled = true; updateEconomy(world, interval * 2);
    building.disabled = false; building.built = .5; updateEconomy(world, interval * 2);
    building.built = 1; world.factions[faction].alive = false; updateEconomy(world, interval * 2);
    world.factions[faction].alive = true;
    updateEconomy(world, interval / 2 - .25);
    expect(target.faction).toBe(-1);
    updateEconomy(world, .25);
    expect(target.faction).toBe(faction);
  });

  it.each(recruiters)('%s preserves neutral eligibility and the soft attention cap', (kind, interval) => {
    const { world, building, faction } = fixture(kind);
    for (let i = 0; i < popCap(world, faction); i++) spawnHippie(world, faction, building.pos);
    const target = spawnHippie(world, -1, building.pos);
    const enemy = spawnHippie(world, 2, building.pos);
    const ko = spawnHippie(world, -1, building.pos); ko.status = 'ko'; ko.koUntil = 100;
    const wizard = spawnHippie(world, -1, building.pos); wizard.wizard = true;
    const far = spawnHippie(world, -1, { x: building.pos.x + 16, z: building.pos.z });
    const counts = { people: world.hippies.size, flags: world.flags.size };
    updateEconomy(world, interval);
    expect(target.faction).toBe(faction);
    expect(aboveAttentionCap(world, target)).toBe(true);
    updateEconomy(world, interval);
    expect(enemy.faction).toBe(2);
    for (const h of [ko, wizard, far]) expect(h.faction).toBe(-1);
    expect(world.hippies.size).toBe(counts.people);
    expect(world.flags.size).toBe(counts.flags);
    expect(world.factions[faction].lumber).toBe(0);
  });

  it.each(['avatar', 'rts', 'npc', 'tutorial'] as const)('uses the same five-second cadence for %s play', control => {
    for (const kind of ['workshop', 'gcc'] as const) {
      const { world, building, faction } = fixture(kind, control === 'tutorial' ? 'tutorial' : 'standard', control === 'tutorial' ? 'avatar' : control);
      const first = spawnHippie(world, -1, building.pos), second = spawnHippie(world, -1, building.pos);
      updateEconomy(world, 4.75);
      expect(first.faction).toBe(-1);
      updateEconomy(world, .25);
      expect(first.faction).toBe(faction);
      expect(second.faction).toBe(-1);
      updateEconomy(world, 5);
      expect(second.faction).toBe(faction);
    }
  });

  it.each(recruiters)('%s replicates each timed recruit once to two peers and late joins', (kind, interval) => {
    const { world: host, building, faction } = fixture(kind);
    const first = spawnHippie(host, -1, building.pos), second = spawnHippie(host, -1, building.pos);
    const encoder = new SnapshotEncoder(host);
    const peers = [NetMirror.create(host.options, wire(encoder.full())), NetMirror.create(host.options, wire(encoder.full()))];
    const peerRandom = peers.map(peer => JSON.stringify(peer.world.rng));
    const flush = (dt: number) => {
      host.tick++; host.time += dt; updateEconomy(host, dt);
      const events = host.drainEvents();
      const frame: StateFrame = wire({ tick: host.tick, time: host.time, acks: {}, delta: encoder.delta(events), events });
      for (const peer of peers) { peer.push(frame); peer.catchUp(); }
      return frame;
    };
    expect(flush(interval - .25).events.filter(e => e.t === 'recruited')).toEqual([]);
    for (const [target, dt] of [[first, .25], [second, interval]] as const) {
      const frame = flush(dt);
      const expected = [{ t: 'recruited', hippieId: target.id, faction, via: kind }];
      expect(frame.events.filter(e => e.t === 'recruited')).toEqual(expected);
      const late = NetMirror.create(host.options, wire(encoder.full()));
      for (const world of [host, ...peers.map(peer => peer.world), late.world]) {
        expect(world.hippies.get(target.id)?.faction).toBe(faction);
        expect(world.hippies.size).toBe(2);
        expect(world.factions[faction].stats.hippiesRecruited).toBe(host.factions[faction].stats.hippiesRecruited);
      }
      for (const [i, peer] of peers.entries()) {
        expect(peer.world.drainEvents().filter(e => e.t === 'recruited')).toEqual(expected);
        expect(JSON.stringify(peer.world.rng)).toBe(peerRandom[i]);
        peer.push(wire(frame)); peer.catchUp();
        expect(peer.world.drainEvents()).toEqual([]);
      }
      expect(late.world.drainEvents()).toEqual([]);
    }
  });
});
