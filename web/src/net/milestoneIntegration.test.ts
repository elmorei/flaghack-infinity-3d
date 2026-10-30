import { describe, expect, it } from 'vitest';
import { createMatch } from '../sim/setup';
import { normalizeMatch } from '../sim/matchSettings';
import { spawnBuilding, spawnPiece } from '../sim/factory';
import { capturePiece, captureStructure, updateStructureCapture } from '../sim/systems/structureCapture';
import { updateCapture } from '../sim/systems/capture';
import { consumeBuilding } from '../sim/systems/boss';
import { attachPiece, destroyPiece } from '../sim/systems/pieces';
import { destroySceneryHit } from '../sim/systems/scenery';
import { addWreckage, MAX_WRECKAGE } from '../sim/wreckage';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
import { PROTOCOL_VERSION } from './protocol';

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const make = () => createMatch({ seed: 'combined-capture-wreckage', difficulty: 'normal',
  humans: [0, 1, 2, 3], mode: 'standard', match: normalizeMatch({ maxSignifiers: 0 }) });

describe('combined structure capture and wreckage milestone', () => {
  it('uses a distinct protocol for the combined world schema', () => {
    expect(PROTOCOL_VERSION).toBe(21);
  });

  it('replicates captured objects becoming wreckage alongside surviving claims, without elimination or effect replay', () => {
    const host = make();
    const facet = host.lattice.facets.find(f => !f.boundary && Math.hypot(f.cx, f.cz) < 20)!;
    const building = spawnBuilding(host, 'workshop', 1, facet.id, 1);
    const piece = spawnPiece(host, 'wall', 1, facet.edges[0], -1, 0, -1);
    attachPiece(host, piece);
    const encoder = new SnapshotEncoder(host);
    const peer = NetMirror.create(host.options, wire(encoder.full()));
    const flush = () => {
      host.tick++; host.time++;
      host.drainEvents();
      const frame = wire({ tick: host.tick, time: host.time, acks: {}, delta: encoder.delta([]), events: [] });
      peer.push(frame); peer.catchUp();
      return frame;
    };
    expect(captureStructure(host, building, 0)).toBe(true);
    expect(capturePiece(host, piece, 0)).toBe(true);
    // Exercise the production neutral-structure capture state machine.
    host.survey.facetSurvey.fill(1); host.survey.version++;
    host.time += 20; updateStructureCapture(host, 20);
    host.time += 3; updateStructureCapture(host, 3);
    const claims = [...host.sceneryCapture].filter(([, state]) => state.faction === 0);
    expect(claims.length).toBeGreaterThan(1);
    const destroyedPropId = claims[0][0], survivingPropId = claims[1][0];
    flush();
    expect(peer.world.buildings.get(building.id)?.faction).toBe(0);
    expect(peer.world.pieces.get(piece.id)?.faction).toBe(0);
    expect(peer.world.sceneryCapture.get(destroyedPropId)?.faction).toBe(0);

    // Real boss encounter cancels capture progress, while allegiance remains until removal.
    host.effigyRevealedAt = host.time;
    consumeBuilding(host, building, true);
    destroyPiece(host, piece, true);
    expect(destroySceneryHit(host, -1 - destroyedPropId)).toBe(true);
    updateCapture(host, 1 / 60);
    const removal = flush();
    const late = NetMirror.create(host.options, wire(encoder.full()));
    for (const world of [host, peer.world, late.world]) {
      expect(world.buildings.has(building.id)).toBe(false);
      expect(world.pieces.has(piece.id)).toBe(false);
      expect(world.sceneryCapture.has(destroyedPropId)).toBe(false);
      expect(world.destroyedScenery.has(destroyedPropId)).toBe(true);
      expect(world.sceneryCapture.get(survivingPropId)?.faction).toBe(0);
      expect(world.wreckage.map(record => record.id)).toEqual([`building:${building.id}`, `piece:${piece.id}`]);
      expect(world.factions[0].alive).toBe(true);
      expect(world.factions[1].alive).toBe(true);
    }
    peer.push(removal); peer.catchUp();
    expect(peer.world.wreckage).toHaveLength(2);
    expect(late.world.wreckage).toEqual(peer.world.wreckage);
    expect(late.world.drainEvents()).toEqual([]);
  });

  it('evicts old wreckage identically on live and late peers without overwriting scenery claims', () => {
    const host = make();
    const prop = host.map.obstacles.find(o => o.kind === 'tent')!;
    host.sceneryCapture.set(prop.id, { faction: 1, stage: 'safe', attacker: null,
      pressure: { 0: 0, 1: 0, 2: 0, 3: 0 }, overwriteAt: 0 });
    const encoder = new SnapshotEncoder(host), peer = NetMirror.create(host.options, wire(encoder.full()));
    for (let id = 0; id < MAX_WRECKAGE + 2; id++) addWreckage(host,
      { id: `piece:${id}`, kind: 'wall', pos: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 2, z: 3 }, yaw: 0 });
    host.tick++; host.time++;
    peer.push(wire({ tick: host.tick, time: host.time, acks: {}, delta: encoder.delta([]), events: [] }));
    peer.catchUp();
    const late = NetMirror.create(host.options, wire(encoder.full()));
    for (const world of [host, peer.world, late.world]) {
      expect(world.wreckage).toHaveLength(MAX_WRECKAGE);
      expect(world.wreckage[0].id).toBe('piece:2');
      expect(world.sceneryCapture.get(prop.id)?.faction).toBe(1);
    }
    expect(late.world.wreckage).toEqual(peer.world.wreckage);
  });
});
