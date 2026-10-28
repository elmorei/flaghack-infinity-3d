import { describe, expect, it } from 'vitest';
import { bossFixture } from '../../tests/bossFixture';
import { applyBossTakeover, bossTakeoverSeats, hasSurvivingAltar, isBossTakeoverActive } from './bossTakeover';
import { createMatch } from './setup';
import { normalizeMatch } from './matchSettings';
import { spawnHippie } from './factory';

function fixture() {
  const world = createMatch({ seed: 'boss-takeover-rules', mode: 'standard', difficulty: 'normal', humans: [0],
    match: normalizeMatch({ maxSignifiers: 2 }) });
  world.boss = bossFixture();
  world.effigyRevealedAt = 0;
  world.factions[0].alive = false;
  return world;
}

describe('boss camp takeover rules', () => {
  it('requires an actual active encounter and an eliminated seat, and respects caller-owned AI reservations', () => {
    const world = fixture();
    expect(bossTakeoverSeats(world, 0, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(bossTakeoverSeats(world, 0, [2])).toEqual([2]);
    expect(bossTakeoverSeats(world, null, [1, 2, 3])).toEqual([]);
    expect(bossTakeoverSeats(world, 1, [2, 3])).toEqual([]);
    world.boss = null;
    expect(isBossTakeoverActive(world)).toBe(false);
    expect(bossTakeoverSeats(world, 0, [1, 2, 3])).toEqual([]);
    world.boss = bossFixture();
    world.bossOutcome = { kind: 'victory', at: 0, winners: [1] };
    expect(bossTakeoverSeats(world, 0, [1, 2, 3])).toEqual([]);
    world.bossOutcome = null;
    world.phase = 'ended';
    expect(bossTakeoverSeats(world, 0, [1, 2, 3])).toEqual([]);
  });

  it('requires a real owned altar and avatar, excludes disabled factions, but permits repairable altars', () => {
    const world = fixture();
    const altar = world.buildings.get(world.factions[1].hearthIds[0])!;
    altar.hp = 0; altar.disabled = true;
    expect(hasSurvivingAltar(world, 1)).toBe(true);
    altar.faction = 2;
    expect(hasSurvivingAltar(world, 1)).toBe(false);
    world.buildings.delete(world.factions[2].hearthIds[0]);
    world.avatars.delete(world.factions[3].avatarId);
    expect(bossTakeoverSeats(world, 0, [1, 2, 3])).toEqual([]);
    altar.faction = 1;
    world.options.match = normalizeMatch({ active: [0, 2] });
    expect(bossTakeoverSeats(world, 0, [1])).toEqual([]);
  });

  it('inherits exact assets, orders, ammo, cooldowns and KO/action state; only changes ownership and input', () => {
    const world = fixture();
    const camp = world.factions[2];
    const avatar = world.avatars.get(camp.avatarId)!;
    avatar.hp = 0; avatar.koUntil = 123; avatar.action = { kind: 'swing', t: .2, hit: true };
    avatar.input = { moveX: 1, moveZ: -1, jump: true, sprint: true, yaw: 1.2, pitch: .4 };
    avatar.vel = { x: 3, y: 5, z: 2 };
    camp.cooldowns.omega = 234; camp.lumber = 345; camp.ritual = 12;
    const unit = spawnHippie(world, 2, { x: 10, z: 10 });
    unit.order = { kind: 'move', to: { x: 6, z: 7 } };
    const maps = [world.avatars, world.buildings, world.flags, world.hippies, world.pieces];
    const identities = maps.map((map) => [...map.entries()]);
    const inherited = structuredClone({ avatar, camp, unit });
    world.submit({ t: 'swing', faction: 0 });
    world.submit({ t: 'swing', faction: 2 });
    world.submit({ t: 'swing', faction: 3 });
    expect(applyBossTakeover(world, 0, 2, [1, 2, 3])).toBe(true);
    expect(world.options.humans).toEqual([2]);
    expect(world.factions[0].isPlayer).toBe(false);
    expect(camp.isPlayer).toBe(true);
    expect(camp.personality).toBe('player');
    expect({ ...camp, isPlayer: false, personality: inherited.camp.personality }).toEqual(inherited.camp);
    expect({ ...avatar, input: inherited.avatar.input }).toEqual(inherited.avatar);
    expect(avatar.input).toEqual({ moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 1.2, pitch: .4 });
    expect(unit).toEqual(inherited.unit);
    maps.forEach((map, i) => {
      expect([...map.keys()]).toEqual(identities[i].map(([id]) => id));
      for (const [id, entity] of identities[i]) expect(map.get(id)).toBe(entity);
    });
    expect(world.takeCommands()).toEqual([{ t: 'swing', faction: 3 }]);
    expect(applyBossTakeover(world, 0, 2, [1, 3])).toBe(false);
  });
});

it('keeps an RTS player command-only and permits compatible camps without creating a body', () => {
  const w = fixture(); w.factions[0].controlMode = 'rts';
  expect(bossTakeoverSeats(w, 0, [1, 2, 3])).toEqual([]);
  expect(applyBossTakeover(w, 0, 1, [1, 2, 3])).toBe(false);
  w.factions[2].controlMode = 'rts'; w.avatars.delete(w.factions[2].avatarId); w.factions[2].avatarId = -1;
  expect(bossTakeoverSeats(w, 0, [1, 2, 3])).toEqual([2]);
  expect(applyBossTakeover(w, 0, 2, [1, 2, 3])).toBe(true);
  expect(w.avatarOf(2)).toBeUndefined(); expect(w.factions[2].controlMode).toBe('rts');
});
