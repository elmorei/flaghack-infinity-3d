import { describe, expect, it } from 'vitest';
import { ALIGN_COST } from './constants';
import { setFactionControlMode } from './controlMode';
import { createMatch } from './setup';
import { SnapshotEncoder } from '../net/codec';
import { NetMirror } from '../net/mirror';

function fixture() { return createMatch({ seed: 'mode-switch-refund', difficulty: 'normal', mode: 'standard', humans: [0] }); }
describe('camp control mode', () => {
  it('leaves a malformed command-only camp untouched when no avatar anchor exists', () => {
    const w=fixture(),f=w.factions[1];
    for(const id of f.hearthIds) w.buildings.delete(id);f.hearthIds=[];
    if(f.gccId!==null)w.buildings.delete(f.gccId);f.gccId=null;
    f.ritual=7;f.chakras.hoist=2;const before=structuredClone(f);
    expect(setFactionControlMode(w,1,'avatar')).toBe(false);expect(f).toEqual(before);
  });
  it('refunds only incompatible chakra investments once and preserves shared spells and assets', () => {
    const w = fixture(), f = w.factions[0];
    f.chakras = { hoist: 3, fly: 2, field: 1, canton: 2, finial: 3 }; f.ritual = 7;
    const buildings = [...w.buildings.values()], hippies = [...w.hippies.values()], flags = [...w.flags.values()];
    const refund = ALIGN_COST.slice(0,3).reduce((a,b)=>a+b,0) + ALIGN_COST.slice(0,2).reduce((a,b)=>a+b,0) + ALIGN_COST[0];
    expect(setFactionControlMode(w, 0, 'rts')).toBe(true);
    expect(f.ritual).toBe(7 + refund); expect(f.chakras).toEqual({ hoist: 0, fly: 0, field: 0, canton: 2, finial: 3 });
    expect(setFactionControlMode(w, 0, 'rts')).toBe(false); expect(f.ritual).toBe(7 + refund);
    expect(w.avatarOf(0)).toBeUndefined(); expect([...w.buildings.values()]).toEqual(buildings);
    expect([...w.hippies.values()]).toEqual(hippies); expect([...w.flags.values()]).toEqual(flags);
    expect(setFactionControlMode(w, 0, 'avatar')).toBe(true); expect(f.ritual).toBe(7 + refund);
  });
  it('preserves avatar HP, KO and identity across toggles without a healing exploit', () => {
    const w = fixture(), av = w.avatarOf(0); av.hp = 0; av.koUntil = 123;
    setFactionControlMode(w, 0, 'rts'); setFactionControlMode(w, 0, 'avatar');
    expect(w.avatarOf(0)).toBe(av); expect(av.hp).toBe(0); expect(av.koUntil).toBe(123);
    w.factions[0].alive = false; expect(setFactionControlMode(w, 0, 'rts')).toBe(false);
  });
  it('creates a body for an originally command-only camp and replicates mode/body transitions', () => {
    const w = fixture(); expect(w.avatarOf(1)).toBeUndefined();
    expect(setFactionControlMode(w, 1, 'avatar')).toBe(true);
    const encoder = new SnapshotEncoder(w), mirror = NetMirror.create(w.options, encoder.full());
    expect(mirror.world.avatarOf(1).id).toBe(w.avatarOf(1).id);
    expect(mirror.world.factions[1].controlMode).toBe('avatar');
  });
});
