import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Session } from '../../game/session';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
import { NEUTRAL_COLOR } from '../../sim/constants';
import { spawnBuilding, spawnPiece } from '../../sim/factory';
import { createMatch } from '../../sim/setup';
import { capturePiece, captureStructure, newStructureCapture } from '../../sim/systems/structureCapture';
import { FACTION_IDS } from '../../sim/types';
import type { FactionId, Owner, StructureCaptureState } from '../../sim/types';
import type { World } from '../../sim/world';
import { BEAM } from './beams';
import type { BeamLayer } from './beams';
import { DECAL } from './decals';
import type { DecalLayer } from './decals';
import { HearthFeature } from './hearthRings';
import type { SpriteLayer } from './sprites';
import { SurveyData } from './surveyData';
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function recorder(w: World, viewer: FactionId) {
  const session = new Session(); session.playerFaction = viewer;
  const data = new SurveyData(w), feature = new HearthFeature(w, session, data);
  const rings: { color: number; second?: number; stage: number }[] = [], inflows: number[] = [];
  const decals = {
    push(...a: Parameters<DecalLayer['push']>) {
      rings.push({ color: a[5].getHex(), stage: a[0] === DECAL.hearth ? a[8] ?? 0 : -1 }); return rings.length - 1;
    },
    setColor2(i: number, c: THREE.Color) { rings[i].second = c.getHex(); },
  } as unknown as DecalLayer;
  const beams = { push(...a: Parameters<BeamLayer['push']>) { if (a[0] === BEAM.inflow) inflows.push(a[8].getHex()); } } as unknown as BeamLayer;
  return { data, rings, inflows, update() { rings.length = 0; inflows.length = 0; feature.update(w.time, decals, beams, { push() {} } as unknown as SpriteLayer); } };
}
function fixture() {
  const w = createMatch({ seed: 'capture-colour-all-seats', mode: 'standard', difficulty: 'normal', humans: [0, 1, 2, 3] });
  w.buildings.clear(); w.pieces.clear(); w.sceneryCapture.clear();
  const facet = w.lattice.facets.find(f => !f.boundary)!;
  const b = spawnBuilding(w, 'workshop', -1, facet.id, 1), p = spawnPiece(w, 'floor', -1, -1, facet.id, 1, 0);
  const o = w.map.obstacles.find(o => o.kind === 'tent')!;
  const set = (owner: Owner, attacker: FactionId | null, stage: StructureCaptureState['stage']) => {
    const state = (): StructureCaptureState => ({ ...newStructureCapture(), stage, attacker, pressure: { 0: 30, 1: 30, 2: 30, 3: 30 } });
    b.faction = owner; b.capture = state(); p.faction = owner; p.capture = state();
    w.sceneryCapture.set(o.id, { ...state(), faction: owner });
    w.survey.facetSurvey.fill(attacker === null ? 0 : 1 << attacker); w.survey.version++;
  };
  return { w, b, p, o, set };
}
describe('capture base colours identify every faction, not generic red', () => {
  it.each(FACTION_IDS)('shows capturing faction %i on buildings, pieces and scenery to all viewers', attacker => {
    const f = fixture();
    for (const owner of [-1, ...FACTION_IDS.filter(id => id !== attacker)] as Owner[]) {
      f.set(owner, attacker, 'contained');
      for (const viewer of FACTION_IDS) {
        const r = recorder(f.w, viewer); r.update();
        expect(r.rings.filter(x => x.stage === 2)).toHaveLength(3);
        for (const ring of r.rings.filter(x => x.stage === 2)) expect(ring.color).toBe(f.w.factions[attacker].color);
        expect(r.inflows.length).toBeGreaterThan(0);
        for (const colour of r.inflows) expect(colour).toBe(f.w.factions[attacker].color);
        r.data.dispose();
      }
    }
  });
  it.each(FACTION_IDS)('updates capture, recapture and contested colours for faction %i', faction => {
    const f = fixture(), enemy = ((faction + 1) % 4) as FactionId, r = recorder(f.w, faction);
    f.set(-1, null, 'safe'); r.update(); expect(r.rings.every(x => x.color === NEUTRAL_COLOR)).toBe(true);
    f.set(-1, faction, 'contained'); r.update(); expect(r.rings.every(x => x.color === f.w.factions[faction].color)).toBe(true);
    expect(captureStructure(f.w, f.b, faction)).toBe(true); expect(capturePiece(f.w, f.p, faction)).toBe(true);
    f.w.sceneryCapture.set(f.o.id, { ...newStructureCapture(), faction });
    r.update(); expect(r.rings.every(x => x.stage === 0 && x.color === f.w.factions[faction].color)).toBe(true);
    f.set(faction, enemy, 'contested'); r.update();
    for (const ring of r.rings.filter(x => x.stage === 3)) { expect(ring.color).toBe(f.w.factions[faction].color); expect(ring.second).toBe(f.w.factions[enemy].color); }
    f.set(faction, enemy, 'contained'); r.update(); expect(r.rings.filter(x => x.stage === 2).every(x => x.color === f.w.factions[enemy].color)).toBe(true);
    f.set(enemy, null, 'safe'); r.update(); expect(r.rings.every(x => x.color === f.w.factions[enemy].color)).toBe(true);
    f.set(enemy, faction, 'contained'); r.update(); expect(r.rings.filter(x => x.stage === 2).every(x => x.color === f.w.factions[faction].color)).toBe(true);
    r.data.dispose();
  });
  it('uses replicated identities on late joins and capture-owner deltas for every seat', () => {
    const f = fixture(); f.set(-1, 0, 'contained');
    const encoder = new SnapshotEncoder(f.w), peer = NetMirror.create(f.w.options, wire(encoder.full()));
    for (const faction of FACTION_IDS) {
      f.set(-1, faction, 'contained'); f.w.tick++; f.w.time++;
      peer.push(wire({ tick: f.w.tick, time: f.w.time, acks: {}, delta: encoder.delta([]), events: [] })); peer.catchUp();
      const late = NetMirror.create(f.w.options, wire(encoder.full()));
      for (const world of [peer.world, late.world]) for (const viewer of FACTION_IDS) {
        const r = recorder(world, viewer); r.update();
        expect(r.rings.filter(x => x.stage === 2)).toHaveLength(3);
        expect(r.rings.filter(x => x.stage === 2).every(x => x.color === world.factions[faction].color)).toBe(true); r.data.dispose();
      }
    }
  });
});
