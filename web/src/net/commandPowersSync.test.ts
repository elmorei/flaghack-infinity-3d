import { describe, expect, it } from 'vitest';
import { CODECS, encodeRow, FACTION_FIELDS } from './schema';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
import { parseCommand } from './validate';
import { cmdAbility, cmdAlign } from '../sim/systems/abilities';
import { cmdRitual } from '../sim/systems/rituals';
import { cmdDrug, falseFlags, updateDrugs } from '../sim/systems/drugs';
import { spawnBuilding } from '../sim/factory';
import { commandPowersWorld, powerAdvance } from '../sim/systems/commandPowersTestkit';
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('Degen Powers replication', () => {
  it('replicates warning clocks, alignment levels/spend, cooldowns, rites and all drug state to two peers and late joins', () => {
    const w = commandPowersWorld('command-powers-network'), encoder = new SnapshotEncoder(w);
    const peers = [NetMirror.create(w.options, json(encoder.full())), NetMirror.create(w.options, json(encoder.full()))];
    const flush = () => {
      w.tick++; const frame = json({ tick: w.tick, time: w.time, acks: {}, delta: encoder.delta([]), events: w.drainEvents() });
      for (const p of peers) { p.push(frame); p.catchUp(); }
      const worlds = [...peers.map(p => p.world), NetMirror.create(w.options, json(encoder.full())).world];
      for (const m of worlds) {
        expect([...m.zones.keys()]).toEqual([...w.zones.keys()]);
        for (const id of w.zones.keys()) expect(CODECS.zones.row(m, id)).toEqual(CODECS.zones.row(w, id));
        expect(encodeRow(FACTION_FIELDS, m.factions[0], m)).toEqual(encodeRow(FACTION_FIELDS, w.factions[0], w));
        expect([...falseFlags(m, 0)]).toEqual([...falseFlags(w, 0)]); expect(m.avatarOf(0)).toBeUndefined();
      }
    };
    cmdAlign(w, { t: 'align', faction: 0, chakra: 'finial' }); flush(); powerAdvance(w, 4); flush();
    cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at: { x: 8, z: -12 }, node: -1 }); flush();
    powerAdvance(w, 1); flush(); powerAdvance(w, 1.01); flush();
    cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'redtape', at: { x: 30, z: 30 } });
    for (const drug of ['saffron', 'dust', 'acidcop'] as const) { w.factions[0].drugs[drug] = 1; cmdDrug(w, { t: 'drug', faction: 0, drug }); }
    updateDrugs(w, 0); flush(); powerAdvance(w, 10); updateDrugs(w, 0); flush(); powerAdvance(w, 40); updateDrugs(w, 0); flush();
  });
  it('replicates actual Patchwork HP changes rather than healing independently on clients', () => {
    const w = commandPowersWorld(), b = spawnBuilding(w, 'workshop', 0, w.hearthOf(0)!.facet, 1); b.hp = 100;
    const encoder = new SnapshotEncoder(w), peer = NetMirror.create(w.options, json(encoder.full()));
    cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'patchwork', at: b.pos }); powerAdvance(w, 1);
    peer.push(json({ tick: w.tick, time: w.time, acks: {}, delta: encoder.delta([]), events: [] })); peer.catchUp();
    expect(peer.world.buildings.get(b.id)?.hp).toBe(108); expect(peer.world.factions[0].ritual).toBe(280);
    expect(NetMirror.create(w.options, json(encoder.full())).world.buildings.get(b.id)?.hp).toBe(108);
  });
  it('strictly parses only known rites, exact fields, finite and in-bounds targets', () => {
    const good = { t: 'ritual', faction: 0, ritual: 'redtape', at: { x: 3, z: -5 } };
    expect(parseCommand(good)).toEqual(good);
    for (const bad of [{ ...good, ritual: 'newdrug' }, { ...good, faction: 4 }, { ...good, cost: 0 }, { ...good, at: { x: NaN, z: 0 } }, { ...good, at: { x: 0, z: 1000 } }, { ...good, at: { x: 0, y: 0, z: 0 } }]) expect(parseCommand(bad)).toBeNull();
  });
});
