import { describe, expect, it } from 'vitest';
import { createMatch } from '../sim/setup';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
import { parseClientMessage, parseCommand } from './validate';
import { FACTION_FIELDS } from './schema';
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
describe('RTS wire contract', () => {
  it('accepts exact own-mode preferences and bounded recruit targets only', () => {
    for (const mode of ['avatar', 'rts']) expect(parseClientMessage(JSON.stringify({ t: 'controlMode', mode }))).toEqual({ t: 'controlMode', mode });
    for (const mode of ['admin', null, 1]) expect(parseClientMessage(JSON.stringify({ t: 'controlMode', mode }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'controlMode', mode: 'rts', faction: 1 }))).toBeNull();
    const command = { t: 'order', faction: 0, hippies: [1], order: { kind: 'recruit', target: 99 } };
    expect(parseCommand(command)).toEqual(command);
    for (const target of [-1, NaN, Infinity, 1.2, '99']) expect(parseCommand({ ...command, order: { kind: 'recruit', target } })).toBeNull();
  });
  it('replicates modes, recruit orders and durable throne locks for late joins and deltas', () => {
    const world = createMatch({ seed: 'rts-wire', mode: 'standard', difficulty: 'normal', humans: [0], rtsFactions: [0] });
    expect(FACTION_FIELDS.length).toBeLessThan(31);
    const h = [...world.hippies.values()].find(h => h.faction === 0)!;
    h.order = { kind: 'recruit', target: 999 };
    world.factions[0].throneAttack = { target: h.id, readyAt: 3.25, faction: 0 };
    const encoder = new SnapshotEncoder(world), mirror = NetMirror.create(world.options, wire(encoder.full()));
    expect(mirror.world.factions[0].controlMode).toBe('rts');
    expect(mirror.world.avatars.has(world.factions[0].avatarId)).toBe(false);
    expect(mirror.world.hippies.get(h.id)?.order).toEqual(h.order);
    expect(mirror.world.factions[0].throneAttack).toEqual(world.factions[0].throneAttack);
    world.factions[0].throneAttack = null; h.order = null; world.tick++; world.time += 1 / 60;
    mirror.push(wire({ tick: world.tick, time: world.time, acks: {}, delta: encoder.delta([]), events: [] })); mirror.catchUp();
    expect(mirror.world.factions[0].throneAttack).toBeNull();
    expect(mirror.world.hippies.get(h.id)?.order).toBeNull();
    expect(NetMirror.create(world.options, wire(encoder.full())).world.factions[0].controlMode).toBe('rts');
  });
});
