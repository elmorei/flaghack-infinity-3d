import { describe, expect, it } from 'vitest';
import { spawnBeacon, spawnHippie } from '../sim/factory';
import { normalizeMatch } from '../sim/matchSettings';
import { createMatch } from '../sim/setup';
import { applyCommands } from '../sim/systems/commands';
import { giveFlag } from '../sim/systems/flags';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
import type { StateFrame } from './protocol';
import { parseCommand } from './validate';

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function fixture() {
  const host = createMatch({ seed: 'beacon-conversion-wire', mode: 'standard', difficulty: 'normal',
    humans: [0, 1, 2, 3], match: normalizeMatch({ maxSignifiers: 0 }) });
  host.hippies.clear();
  const avatar = host.avatarOf(0);
  avatar.pos.y = host.collision.groundHeight(avatar.pos.x, avatar.pos.z);
  const target = spawnHippie(host, 1, { x: avatar.pos.x + 50, z: avatar.pos.z + 50 });
  const excluded = spawnHippie(host, 2, { x: avatar.pos.x + 1, z: avatar.pos.z });
  const flagId = host.avatarOf(1).carried.at(-1)!;
  expect(giveFlag(host, flagId, target.id)).toBe(true);
  const beacon = spawnBeacon(host, 1, avatar.pos, host.time + 60);
  host.drainEvents();
  const encoder = new SnapshotEncoder(host);
  const peers = [NetMirror.create(host.options, wire(encoder.full())), NetMirror.create(host.options, wire(encoder.full()))];
  const command = parseCommand(wire({ t: 'tapBeacon', faction: 0, beaconId: beacon.id }));
  if (!command) throw new Error('valid beacon pickup rejected by command parser');
  const pickup = () => { host.submit(command); applyCommands(host); };
  const flush = () => {
    host.tick++; host.time += 1 / 30;
    const events = host.drainEvents();
    const frame: StateFrame = wire({ tick: host.tick, time: host.time, acks: {}, delta: encoder.delta(events), events });
    for (const peer of peers) { peer.push(frame); peer.catchUp(); }
    return frame;
  };
  return { host, target, excluded, flagId, beacon, encoder, peers, pickup, flush };
}

describe('authoritative beacon conversion replication', () => {
  it('replicates faction, carried Flag, pickup removal and recruit event to both peers and late join', () => {
    const { host, target, excluded, flagId, beacon, encoder, peers, pickup, flush } = fixture();
    expect(peers.every(peer => peer.world.beacons.has(beacon.id))).toBe(true);
    const counts = { hippies: host.hippies.size, flags: host.flags.size };
    const peerRandom = peers.map(peer => JSON.stringify(peer.world.rng));
    pickup();
    const frame = flush();
    expect(frame.events).toContainEqual({ t: 'recruited', hippieId: target.id, faction: 0, via: 'beacon' });
    expect(frame.events.some(event => event.t === 'meshTapped')).toBe(false);
    const late = NetMirror.create(host.options, wire(encoder.full()));
    for (const world of [host, ...peers.map(peer => peer.world), late.world]) {
      expect(world.hippies.get(target.id)).toMatchObject({ faction: 0, carryingFlag: flagId, beacon: true });
      expect(world.flags.get(flagId)).toMatchObject({ state: 'carried', holder: target.id, owner: 0 });
      expect(world.hippies.get(excluded.id)?.faction).toBe(2);
      expect(world.beacons.has(beacon.id)).toBe(false);
      expect(world.hippies.size).toBe(counts.hippies);
      expect(world.flags.size).toBe(counts.flags);
      expect(world.factions[0].meshTap[1] ?? 0).toBe(0);
    }
    for (const [i, peer] of peers.entries()) {
      expect(peer.world.drainEvents().filter(event => event.t === 'recruited')).toEqual([
        { t: 'recruited', hippieId: target.id, faction: 0, via: 'beacon' },
      ]);
      expect(JSON.stringify(peer.world.rng)).toBe(peerRandom[i]);
    }
    expect(late.world.drainEvents()).toEqual([]);
  });

  it('replaying a state frame or resending the consumed pickup cannot repeat recruitment', () => {
    const { host, target, beacon, peers, pickup, flush } = fixture();
    pickup();
    const first = flush();
    for (const peer of peers) peer.world.drainEvents();
    const stats = host.factions[0].stats.hippiesRecruited;
    const randomState = JSON.stringify(host.rng);
    for (const peer of peers) {
      peer.push(wire(first)); peer.catchUp();
      expect(peer.world.drainEvents()).toEqual([]);
      expect(peer.world.factions[0].stats.hippiesRecruited).toBe(stats);
    }
    pickup();
    const second = flush();
    expect(second.events.filter(event => event.t === 'recruited')).toEqual([]);
    expect(second.events.some(event => event.t === 'rejected')).toBe(true);
    expect(JSON.stringify(host.rng)).toBe(randomState);
    for (const world of [host, ...peers.map(peer => peer.world)]) {
      expect(world.beacons.has(beacon.id)).toBe(false);
      expect(world.hippies.get(target.id)?.faction).toBe(0);
      expect(world.factions[0].stats.hippiesRecruited).toBe(stats);
      expect(world.factions[0].meshTap[1] ?? 0).toBe(0);
    }
  });
});
