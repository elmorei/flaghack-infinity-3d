import { describe, expect, it } from 'vitest';
import { crystalAttackFixture } from '../../../tests/crystalAttackFixture';
import { spawnBuilding } from '../factory';
import { THRONE_ATTACK_HEIGHT, throneAttackOrigin, updateCrystalAttacks } from './crystalAttacks';

function fixture() {
  const e = crystalAttackFixture(), f = e.world.factions[0];
  const altar = spawnBuilding(e.world, 'hearth', 0, 0, 1);
  altar.pos = { x: 0, z: 0 }; f.hearthIds = [altar.id]; f.controlMode = 'rts';
  return { ...e, altar, faction: f };
}
describe('seated ruler defensive lightning', () => {
  it('warns once then damages a stable hostile, sharing the 18 HP/s total budget with any crystals', () => {
    const e = fixture(), h = e.unit(); e.crystal(); e.crystal(0, 1);
    updateCrystalAttacks(e.world, 0);
    expect(e.faction.throneAttack).toEqual({ target: h.id, readyAt: 11, faction: 0 });
    e.step(1); expect(h.hp).toBe(100);
    e.step(2); expect(h.hp).toBeCloseTo(64);
    updateCrystalAttacks(e.world, 2); expect(h.hp).toBeCloseTo(64);
  });
  it('a lone throne deals 12 HP/s without stunning and ignores neutrals, allies and seated rival marker avatars', () => {
    const e = fixture(), h = e.unit(), ally = e.unit(1, 0, 0), neutral = e.unit(2, 0, -1);
    const avatar = e.world.avatarOf(1); avatar.pos = { x: 1, y: 0, z: 0 }; e.world.factions[1].controlMode = 'rts';
    updateCrystalAttacks(e.world, 0); e.step(3);
    expect(h.hp).toBeCloseTo(76); expect(h.effects).toEqual([]);
    expect(ally.hp).toBe(100); expect(neutral.hp).toBe(100); expect(avatar.hp).toBe(200);
  });
  it.each(['avatar', 'dead', 'missing', 'foreign', 'unfinished', 'disabled', 'destroyed', 'toggle', 'alliance', 'ended'] as const)(
    'clears and cannot fire with %s state', reason => {
      const e = fixture(), h = e.unit(); updateCrystalAttacks(e.world, 0);
      if (reason === 'avatar') e.faction.controlMode = 'avatar';
      if (reason === 'dead') e.faction.alive = false;
      if (reason === 'missing') e.world.buildings.delete(e.altar.id);
      if (reason === 'foreign') e.altar.faction = 1;
      if (reason === 'unfinished') e.altar.built = .99;
      if (reason === 'disabled') e.altar.disabled = true;
      if (reason === 'destroyed') e.altar.hp = 0;
      if (reason === 'toggle') e.world.options.match!.crystalAttacks = false;
      if (reason === 'alliance') e.world.effigyRevealedAt = e.world.time;
      if (reason === 'ended') e.world.phase = 'ended';
      e.step(3); expect(e.faction.throneAttack).toBeNull(); expect(h.hp).toBe(100);
    });
  it('respects cover and 16m range while ignoring only its own altar collision hull', () => {
    const e = fixture(), h = e.unit();
    e.world.collision.addCylinder(0, 0, 3.2, 0, 2.2, e.altar.id);
    updateCrystalAttacks(e.world, 0); expect(e.faction.throneAttack?.target).toBe(h.id);
    const wall = e.world.collision.addBox(5, 0, .2, 3, 0, 0, 10, 999);
    e.step(2); expect(e.faction.throneAttack).toBeNull(); expect(h.hp).toBe(100);
    e.world.collision.remove(wall); h.pos.x = 16.001; e.step(1); expect(e.faction.throneAttack).toBeNull();
    h.pos.x = 16; e.step(1); expect(e.faction.throneAttack?.readyAt).toBe(e.world.time + 1);
    e.step(2); expect(h.hp).toBeCloseTo(88);
  });
  it('tracks its own altar position and never grants captured outposts extra ruler emitters', () => {
    const e = fixture(), h = e.unit();
    const outpost = spawnBuilding(e.world, 'hearth', 0, 1, 1); outpost.pos = { x: 0, z: 0 }; e.faction.hearthIds.push(outpost.id);
    e.altar.pos = { x: 5, z: 2 };
    expect(throneAttackOrigin(e.world, 0)).toEqual({ x: 5, y: THRONE_ATTACK_HEIGHT, z: 2 });
    updateCrystalAttacks(e.world, 0); e.step(3); expect(h.hp).toBeCloseTo(76);
  });
  it('warns anew if the primary altar is replaced rather than inheriting an active lock', () => {
    const e = fixture(), h = e.unit(); updateCrystalAttacks(e.world, 0); e.step(2);
    const hp = h.hp, next = spawnBuilding(e.world, 'hearth', 0, 1, 1); next.pos = { x: 0, z: 0 };
    e.faction.hearthIds = [next.id]; e.step(.1);
    expect(e.faction.throneAttack?.readyAt).toBeCloseTo(e.world.time + 1); expect(h.hp).toBe(hp);
  });

});
