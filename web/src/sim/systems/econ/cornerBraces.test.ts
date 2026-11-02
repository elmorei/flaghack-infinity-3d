import { describe, expect, it } from 'vitest';
import { LEVEL_HEIGHT } from '../../constants';
import { spawnPiece } from '../../factory';
import { CollisionWorld } from '../../physics/collision';
import { attachPiece, destroyPiece } from '../pieces';
import { cornerBraces, CORNER_BRACE_RUN, DECK_THICKNESS, facetPolygon, stiltFoot } from './pieceGeometry';
import { newMatch } from './testkit';

describe('platform corner knee braces', () => {
  it('has two sloping braces at every post without filling the space below the beam', () => {
    const { world } = newMatch('braced-platform');
    world.collision = new CollisionWorld();
    const f = world.lattice.facets.find(f => f.thick && !f.boundary)!;
    const xs: number[] = [], zs: number[] = [], foot: number[] = [];
    facetPolygon(world.lattice, f.id, xs, zs);
    const braces = cornerBraces(xs, zs);
    expect(braces).toHaveLength(8);
    const deck = spawnPiece(world, 'floor', 0, -1, f.id, 0, -1);
    attachPiece(world, deck);
    expect(deck.shapeIds).toHaveLength(13); // slab + eight diagonal beams + four posts
    for (let i = 0; i < 4; i++) {
      stiltFoot(world.lattice, f.id, i, foot);
      for (const b of braces.slice(i * 2, i * 2 + 2)) {
        expect(b.ax).toBeCloseTo(foot[0]); expect(b.az).toBeCloseTo(foot[1]);
        expect(Math.hypot(b.bx - b.ax, b.bz - b.az)).toBeCloseTo(CORNER_BRACE_RUN);
        expect(b.by).toBe(-DECK_THICKNESS);
        const x = (b.ax + b.bx) / 2, z = (b.az + b.bz) / 2, y = LEVEL_HEIGHT + (b.ay + b.by) / 2;
        expect(world.collision.blockedCircle(x, z, .01, y - .01, y + .01)).toBe(true);
        expect(world.collision.blockedCircle(x, z, .01, y - .25, y - .22)).toBe(false);
      }
    }
    destroyPiece(world, deck);
    expect(deck.shapeIds).toHaveLength(0);
  });
});
