import { describe, expect, it } from 'vitest';
import { createMatch } from './setup';
import { Simulation } from './simulation';
import { createAi } from '../ai';
import { FACTION_IDS } from './types';
import { captureHearth, holdsHearth } from './systems/capture';
import { abilityBlocker, alignBlocker } from './systems/abilities';
import { handFlagBlocker } from './systems/recruitment';
import { consumeBuilding } from './systems/boss';
import { eliminate } from './systems/victory';
import { rtsThroneAltar } from './rts';
import { SnapshotEncoder } from '../net/codec';
import { NetMirror } from '../net/mirror';
import { drugBlocker, cmdDrug } from './systems/drugs';
import { cmdAvatarInput, cmdPlant, cmdThrow, cmdPull, cmdSwing, cmdPushGcc } from './systems/avatars';
import { cmdRally, cmdSendFollowers } from './systems/hippies';
import { cmdRetransmit, cmdTapBeacon } from './systems/pings';
import { cmdDemolish } from './systems/pieces';
import { spawnAvatar, spawnBuilding } from './factory';
import { normalizeMatch } from './matchSettings';

describe('RTS factions without roaming avatars', () => {
  it.each([{ seats: [0] as const }, { seats: [0, 1, 2, 3] as const }])('runs simulation and disconnect AI with RTS factions %j', ({ seats }) => {
    const w = createMatch({ seed: 'rts-absence', mode: 'standard', difficulty: 'normal', humans: [...FACTION_IDS], rtsFactions: [...seats], match: normalizeMatch({ maxSignifiers: 40 }) });
    for (const f of seats) {
      expect(w.factions[f].avatarId).toBe(-1); expect(w.avatarOf(f)).toBeUndefined();
      expect(holdsHearth(w, w.hearthOf(f)!, f)).toBe(false);
      expect(abilityBlocker(w, f, 'beacon')).not.toBe('');
      expect(alignBlocker(w, f, 'hoist')).not.toBe('');
      expect(handFlagBlocker(w, f, [...w.hippies.keys()][0])).not.toBe('');
    }
    const sim = new Simulation(w), ai = createAi(w, FACTION_IDS);
    for (let i = 0; i < 300; i++) { ai.update(); sim.step(); }
    for (const f of seats) expect(w.avatarOf(f)).toBeUndefined();
    expect(w.phase).toBe('playing');
  });
  it.each(['capture', 'boss', 'eliminate'] as const)('survives %s without a body, and snapshots never resurrect one', cause => {
    const w = createMatch({ seed: 'rts-outcome', mode: 'standard', difficulty: 'normal', humans: [...FACTION_IDS], rtsFactions: [0], match: normalizeMatch({ maxSignifiers: 40 }) });
    const altar = w.hearthOf(0)!;
    const encoder = new SnapshotEncoder(w), json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    const peer = NetMirror.create(w.options, json(encoder.full()));
    expect(peer.world.avatarOf(0)).toBeUndefined(); expect(peer.world.factions[0].controlMode).toBe('rts');
    if (cause === 'capture') captureHearth(w, altar, 1);
    if (cause === 'boss') consumeBuilding(w, altar);
    if (cause === 'eliminate') eliminate(w, 0, 1);
    expect(w.factions[0].alive).toBe(false); expect(rtsThroneAltar(w, 0)).toBeUndefined();
    const ai = createAi(w, [0]), sim = new Simulation(w);
    for (let i = 0; i < 10; i++) { ai.update(); sim.step(); }
    peer.push(json({ tick: w.tick, time: w.time, acks: {}, delta: encoder.delta([]), events: [] })); peer.catchUp();
    for (const mirror of [peer, NetMirror.create(w.options, json(encoder.full()))]) {
      expect(mirror.world.factions[0].alive).toBe(false); expect(mirror.world.avatarOf(0)).toBeUndefined();
      expect(rtsThroneAltar(mirror.world, 0)).toBeUndefined();
    }
  });
  it('blocks personal drugs at UI blocker and direct handler without spending inventory', () => {
    const w = createMatch({ seed: 'rts-no-powers', mode: 'standard', difficulty: 'normal', humans: [0], rtsFactions: [0] });
    w.factions[0].drugs.dust = 1;
    expect(drugBlocker(w, 0, 'dust')).not.toBe('');
    cmdDrug(w, { t: 'drug', faction: 0, drug: 'dust' });
    expect(w.factions[0].drugs.dust).toBe(1); expect(w.factions[0].drugActive.dust).toBe(0);
  });

  it('direct personal handlers are inert even with a stale avatar left in a malformed RTS world', () => {
    const w = createMatch({ seed: 'rts-stale-body', mode: 'standard', difficulty: 'normal', humans: [0], rtsFactions: [0] });
    const av = spawnAvatar(w, 0, { x: 0, z: 0 }); w.factions[0].avatarId = av.id;
    av.pos.x = w.hearthOf(0)!.pos.x; av.pos.z = w.hearthOf(0)!.pos.z;
    expect(holdsHearth(w, w.hearthOf(0)!, 0)).toBe(false);
    const state = JSON.stringify(av), lumber = w.factions[0].lumber, cooldown = w.factions[0].cooldowns.retransmit;
    const commands = () => {
      cmdAvatarInput(w, { t: 'avatarInput', faction: 0, input: { ...av.input, moveX: 1 } });
      cmdPlant(w, { t: 'plant', faction: 0, node: 0 }); cmdThrow(w, { t: 'throw', faction: 0 });
      cmdPull(w, { t: 'pull', faction: 0, flagId: -1 }); cmdSwing(w, { t: 'swing', faction: 0 });
      cmdPushGcc(w, { t: 'pushGcc', faction: 0, on: true }); cmdRally(w, { t: 'rally', faction: 0 });
      cmdSendFollowers(w, { t: 'sendFollowers', faction: 0, at: { x: 0, z: 0 }, target: -1 });
      cmdRetransmit(w, { t: 'retransmit', faction: 0 }); cmdTapBeacon(w, { t: 'tapBeacon', faction: 0, beaconId: -1 });
      cmdDemolish(w, { t: 'demolish', faction: 0, pieceId: -1 });
    };
    commands(); expect(JSON.stringify(av)).toBe(state); expect(w.factions[0].lumber).toBe(lumber);
    expect(w.factions[0].cooldowns.retransmit).toBe(cooldown);
    w.avatars.delete(av.id); w.factions[0].avatarId = -1; expect(commands).not.toThrow();
  });

});

it('keeps initial flag supply equal by putting the RTS personal quiver in altar stock', () => {
  const base = { seed: 'rts-starting-parity', mode: 'standard' as const, difficulty: 'normal' as const, humans: [0] as [0] };
  const action = createMatch(base), rts = createMatch({ ...base, rtsFactions: [0] });
  const ownFlags = (w: typeof action) => [...w.flags.values()].filter(f => f.owner === 0).length;
  expect(ownFlags(rts)).toBe(ownFlags(action));
  expect(rts.stockCount(0)).toBe(action.stockCount(0) + action.avatarOf(0).carried.length);
  expect([...rts.flags.values()].filter(f => f.owner === 0 && f.state === 'carried')).toHaveLength(0);
});


describe('RTS owned-altar fallback', () => {
  it.each(['capture', 'boss'] as const)('relocates after primary %s and falls only after the last altar, including mirrors', cause => {
    const w = createMatch({ seed: 'rts-owned-altar-fallback', mode: 'standard', difficulty: 'normal',
      humans: [...FACTION_IDS], rtsFactions: [0], match: normalizeMatch({ maxSignifiers: 0 }) });
    const first = w.hearthOf(0)!;
    const facet = w.lattice.facets.find(f => !f.boundary && f.id !== first.facet)!;
    const second = spawnBuilding(w, 'hearth', 0, facet.id, 1);
    const encoder = new SnapshotEncoder(w), json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
    const peer = NetMirror.create(w.options, json(encoder.full()));
    const flush = () => {
      w.tick++; w.time++;
      peer.push(json({ tick: w.tick, time: w.time, acks: {}, delta: encoder.delta([]), events: [] })); peer.catchUp();
      return [w, peer.world, NetMirror.create(w.options, json(encoder.full())).world];
    };
    if (cause === 'capture') captureHearth(w, first, 1); else consumeBuilding(w, first);
    for (const state of flush()) {
      expect(state.factions[0].alive).toBe(true);
      expect(state.factions[0].hearthIds).toEqual([second.id]);
      expect(rtsThroneAltar(state, 0)?.id).toBe(second.id);
      expect(state.avatarOf(0)).toBeUndefined();
    }
    if (cause === 'capture') captureHearth(w, second, 1); else consumeBuilding(w, second);
    for (const state of flush()) {
      expect(state.factions[0].alive).toBe(false);
      expect(rtsThroneAltar(state, 0)).toBeUndefined();
      expect(state.avatarOf(0)).toBeUndefined();
    }
  });
});
