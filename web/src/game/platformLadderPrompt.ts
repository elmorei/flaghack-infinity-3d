import { platformLadders } from '../sim/platformLadders';
import type { V3 } from '../sim/math';
import type { World } from '../sim/world';

/** Shared directional wording works with keyboard, touch sticks and gamepads. */
export function platformLadderPrompt(world: World, at: V3): string | null {
  for (const ladder of platformLadders(world)) {
    if (at.y < ladder.bottomY - .2 || at.y > ladder.topY + .4) continue;
    if ((at.x - ladder.x) ** 2 + (at.z - ladder.z) ** 2 > 1.6 ** 2) continue;
    return 'Ladder: move toward to climb, away to descend. Look up to continue higher.';
  }
  return null;
}
