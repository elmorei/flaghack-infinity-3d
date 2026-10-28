import { describe, expect, it } from 'vitest';
import { crystalAttackFixture } from '../../tests/crystalAttackFixture';
import { CrystalAttackFx } from '../render/vfx/crystalAttackFx';
import { updateCrystalAttacks } from '../sim/systems/crystalAttacks';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
describe('crystal attack replication', () => {
  it('sends durable warning locks and damage, rebuilds late joins and clears ended links without mirror damage', () => {
    const e = crystalAttackFixture(), c = e.crystal(), h = e.unit(); updateCrystalAttacks(e.world, 0);
    const encoder = new SnapshotEncoder(e.world), peer = NetMirror.create(e.world.options, wire(encoder.full()));
    expect(peer.world.crystals.get(c.id)?.attack).toEqual(c.attack); expect(peer.world.hippies.get(h.id)?.hp).toBe(100);
    const fx = new CrystalAttackFx(), flat = () => 0;
    const push = () => { peer.push(wire({ tick: e.world.tick, time: e.world.time, acks: {}, delta: encoder.delta([]), events: [] })); peer.catchUp(); };
    const present = (mirror: NetMirror) => {
      const hp = mirror.world.hippies.get(h.id)!.hp;
      for (let i = 0; i < 120; i++) fx.update(mirror.world, i / 60, flat);
      expect(mirror.world.hippies.get(h.id)?.hp).toBe(hp); expect(mirror.world.drainEvents()).toEqual([]);
    };
    present(peer); expect(fx.group.getObjectByName(`crystal-unit-warning-${c.id}`)?.visible).toBe(true);
    e.step(2); push(); expect(peer.world.hippies.get(h.id)?.hp).toBe(88);
    const late = NetMirror.create(e.world.options, wire(encoder.full()));
    for (const mirror of [peer, late]) { expect(mirror.world.crystals.get(c.id)?.attack).toEqual(c.attack); present(mirror); expect(fx.group.getObjectByName(`crystal-unit-warning-${c.id}`)?.visible).toBe(false); }
    h.pos.x = 20; e.step(.1); push(); expect(peer.world.crystals.get(c.id)?.attack).toBeNull(); present(peer); expect(fx.group.visible).toBe(false);
    e.world.crystals.delete(c.id); e.step(.1); push(); expect(peer.world.crystals.has(c.id)).toBe(false);
    expect(NetMirror.create(e.world.options, wire(encoder.full())).world.crystals.has(c.id)).toBe(false); fx.dispose();
  });
});
