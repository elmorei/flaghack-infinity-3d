import { expect, it } from 'vitest';
import { createMatch } from '../sim/setup';
import { spawnPiece } from '../sim/factory';
import { attachPiece, destroyPiece } from '../sim/systems/pieces';
import { platformLadders } from '../sim/platformLadders';
import { platformLadderPrompt } from './platformLadderPrompt';
it('shows device-neutral climbing guidance only near a live exposed ladder', () => {
  const world = createMatch({ seed: 'ladder-prompt', difficulty: 'normal', humans: [0], mode: 'standard' });
  const facet = world.lattice.facets.find(f => f.thick && !f.boundary)!;
  const deck = spawnPiece(world, 'floor', 0, -1, facet.id, 0, -1); attachPiece(world, deck);
  const ladder = platformLadders(world)[0];
  const at = { x: ladder.x + .6 * ladder.nx, y: ladder.bottomY, z: ladder.z + .6 * ladder.nz };
  expect(platformLadderPrompt(world, at)).toContain('move toward to climb');
  expect(platformLadderPrompt(world, { ...at, y: ladder.topY + 2 })).toBeNull();
  destroyPiece(world, deck); expect(platformLadderPrompt(world, at)).toBeNull();
});
