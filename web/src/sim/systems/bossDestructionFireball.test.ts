import { describe, expect, it } from 'vitest';
import { createMatch } from '../setup';
import { spawnBuilding, spawnPiece } from '../factory';
import { consumeBuilding, spawnBoss } from './boss';
import { attachPiece, damagePiece, destroyPiece } from './pieces';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function fixture() {
  const w = createMatch({ seed: 'boss-fireball-facts', difficulty: 'normal', humans: [0], mode: 'standard' });
  w.time = 1000; w.effigyRevealedAt = 990;
  const boss = spawnBoss(w)!;
  const facet = w.lattice.facets.find(f => !f.boundary)!;
  const building = spawnBuilding(w, 'workshop', 0, facet.id, 1);
  const piece = spawnPiece(w, 'wall', 0, facet.edges[0], -1, 0, -1); attachPiece(w, piece);
  w.drainEvents(); return { w, boss, building, piece };
}
describe('cosmetic boss destruction facts', () => {
  it('marks destroyed camp buildings once, not eaten buildings or protected altars', () => {
    const { w, building } = fixture();
    consumeBuilding(w, building, true); consumeBuilding(w, building, true);
    const events = w.drainEvents().filter(e => e.t === 'buildingDisabled');
    expect(events).toHaveLength(1); expect(events[0].bossDestroyed).toBe(true);
    const altar = w.hearthOf(0)!;
    consumeBuilding(w, altar, true); expect(w.buildings.has(altar.id)).toBe(true); expect(w.drainEvents()).toEqual([]);
    consumeBuilding(w, altar);
    expect(w.drainEvents().filter(e => e.t === 'buildingDisabled').every(e => !e.bossDestroyed)).toBe(true);
  });
  it('marks lethal boss piece damage, not ordinary damage, demolition, or nonlethal hits', () => {
    for (const cause of ['boss', 'ordinary', 'demolition', 'stomp'] as const) {
      const { w, boss, piece } = fixture();
      if (cause === 'demolition') destroyPiece(w, piece);
      else if (cause === 'stomp') destroyPiece(w, piece, true);
      else {
        damagePiece(w, piece, 1, cause === 'boss' ? boss.id : w.avatarOf(0).id);
        expect(w.drainEvents().filter(e => e.t === 'pieceDestroyed')).toEqual([]);
        damagePiece(w, piece, 10000, cause === 'boss' ? boss.id : w.avatarOf(0).id);
      }
      const events = w.drainEvents().filter(e => e.t === 'pieceDestroyed');
      expect(events).toHaveLength(1);
      expect(!!events[0].bossDestroyed).toBe(cause === 'boss' || cause === 'stomp');
    }
  });
  it('replicates the cosmetic marker once live and never replays on late join', () => {
    const { w, building, piece } = fixture();
    const encoder = new SnapshotEncoder(w), mirror = NetMirror.create(w.options, wire(encoder.full()));
    consumeBuilding(w, building, true); destroyPiece(w, piece, true);
    const events = w.drainEvents(); w.tick++; w.time++;
    const frame = wire({ tick: w.tick, time: w.time, acks: {}, delta: encoder.delta(events), events });
    mirror.push(frame); mirror.catchUp(); expect(mirror.world.drainEvents()).toEqual(events);
    mirror.push(frame); mirror.catchUp(); expect(mirror.world.drainEvents()).toEqual([]);
    const late = NetMirror.create(w.options, wire(encoder.full())); expect(late.world.drainEvents()).toEqual([]);
  });
});
