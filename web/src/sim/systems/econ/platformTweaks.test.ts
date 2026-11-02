import { describe, expect, it, vi } from 'vitest';
import { AVATAR, LEVEL_HEIGHT } from '../../constants';
import { spawnFlag, spawnPiece } from '../../factory';
import { canPlantAt, plantFlag } from '../flags';
import { cmdPlant } from '../avatars';
import { attachPiece, canBuildPiece, cmdBuild, destroyPiece, pieceAt } from '../pieces';
import { updateSurvey } from '../survey';
import { DECK_THICKNESS, stiltFoot } from './pieceGeometry';
import { newMatch } from './testkit';

function fixture() {
  const { world } = newMatch('tall-platform-ground-flags');
  world.factions[0].lumber = 1000;
  const av = world.avatarOf(0);
  const facet = world.lattice.facets.find(fc => {
    if (fc.boundary || !fc.thick || !fc.nodes.every(n => canPlantAt(world, n, 0))) return false;
    av.pos = { x: fc.cx, y: world.collision.groundHeight(fc.cx, fc.cz), z: fc.cz };
    return !world.collision.blockedCircle(fc.cx, fc.cz, 1, av.pos.y + .2, av.pos.y + AVATAR.height) && canBuildPiece(world, 0, 'floor', -1, fc.id, 0, -1).ok;
  })!;
  expect(facet).toBeDefined();
  return { world, facet };
}

describe('tall platforms preserve ground corner claims', () => {
  it('defaults to the minimum 5.77 m and leaves own and enemy planted flags in place when decks are built above', () => {
    const { world, facet } = fixture();
    expect(LEVEL_HEIGHT).toBe(5.77);
    const planted = facet.nodes.slice(0, 2).map((node, faction) => {
      const n = world.lattice.nodes[node];
      const flag = spawnFlag(world, { state: 'loose', owner: faction as 0 | 1, holder: -1, pos: { x: n.x, y: world.collision.groundHeight(n.x, n.z), z: n.z } });
      expect(plantFlag(world, flag.id, node, faction as 0 | 1, -1)).toBe(true);
      return { flag, y: flag.pos.y, node, faction };
    });
    cmdBuild(world, { t: 'build', faction: 0, kind: 'floor', edge: -1, facet: facet.id, level: 0, rampEdge: -1 });
    const deck = pieceAt(world, 'floor', -1, facet.id, 0)!;
    expect(deck).toBeDefined();
    const higher = spawnPiece(world, 'floor', 0, -1, facet.id, 1, -1); attachPiece(world, higher);
    updateSurvey(world, 0);
    for (const p of planted) {
      expect(p.flag.state).toBe('planted'); expect(p.flag.pos.y).toBe(p.y);
      expect(world.survey.nodeFlag[p.node]).toBe(p.flag.id);
      expect(world.survey.nodeFlagOwner[p.node]).toBe(p.faction);
      expect(world.survey.holder[p.node]).toBe(p.faction);
    }
    destroyPiece(world, deck); updateSurvey(world, 0);
    for (const p of planted) expect(p.flag).toMatchObject({ state: 'planted', node: p.node, pos: { y: p.y } });
  });

  it('still lets a ground-level avatar plant at an unclaimed corner beneath a platform', () => {
    const { world, facet } = fixture();
    const deck = spawnPiece(world, 'floor', 0, -1, facet.id, 0, -1); attachPiece(world, deck);
    const node = facet.nodes[0], n = world.lattice.nodes[node], av = world.avatarOf(0);
    const ground = world.collision.groundHeight(n.x, n.z);
    av.pos = { x: n.x + .5, y: ground, z: n.z }; av.action = { kind: 'idle' };
    expect(av.carried.length).toBeGreaterThan(0);
    cmdPlant(world, { t: 'plant', faction: 0, node }); updateSurvey(world, 0);
    const flag = world.flags.get(world.survey.nodeFlag[node]);
    expect(flag).toMatchObject({ state: 'planted', owner: 0, node, pos: { x: n.x, y: ground, z: n.z } });
    expect(world.survey.holder[node]).toBe(0);
  });

  it('registers four corner posts from actual ground to slab underside at every deck level', () => {
    const { world, facet } = fixture();
    const add = vi.spyOn(world.collision, 'addCylinder');
    for (const level of [0, 1, 2]) {
      add.mockClear();
      const deck = spawnPiece(world, 'floor', 0, -1, facet.id, level, -1); attachPiece(world, deck);
      const top = world.collision.groundHeight(facet.cx, facet.cz) + (level + 1) * LEVEL_HEIGHT;
      expect(add).toHaveBeenCalledTimes(4);
      for (let i = 0; i < 4; i++) {
        const n = world.lattice.nodes[facet.nodes[i]], foot = stiltFoot(world.lattice, facet.id, i, [0, 0]);
        expect(Math.hypot(foot[0] - n.x, foot[1] - n.z)).toBeCloseTo(.7);
        const call = add.mock.calls[i];
        expect(call[0]).toBe(foot[0]); expect(call[1]).toBe(foot[1]);
        expect(call[3]).toBe(world.collision.groundHeight(foot[0], foot[1]));
        expect(call[4]).toBeCloseTo(top - DECK_THICKNESS);
        expect(call[5]).toBe(deck.id);
        expect(world.collision.blockedCircle(foot[0], foot[1], .05, call[3] + .1, call[3] + .3)).toBe(true);
        expect(world.collision.blockedCircle(foot[0], foot[1], .05, top - 1, top - .5)).toBe(true);
      }
    }
    const ground = world.collision.groundHeight(facet.cx, facet.cz);
    expect(world.collision.blockedCircle(facet.cx, facet.cz, .3, ground + .2, ground + AVATAR.height)).toBe(false);
    destroyPiece(world, pieceAt(world, 'floor', -1, facet.id, 0)!);
    const foot = stiltFoot(world.lattice, facet.id, 0, [0, 0]), footY = world.collision.groundHeight(foot[0], foot[1]);
    expect(world.collision.blockedCircle(foot[0], foot[1], .05, footY + .1, footY + .3)).toBe(false);
  });
});
