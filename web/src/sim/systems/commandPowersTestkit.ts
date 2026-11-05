import { createMatch } from '../setup';
import { normalizeMatch } from '../matchSettings';
import { spawnBuilding } from '../factory';
import { updateAbilities } from './abilities';
import type { World } from '../world';
export function commandPowersWorld(seed = 'command-powers-recovery'): World {
  const w = createMatch({ seed, mode: 'standard', difficulty: 'normal', humans: [0, 1, 2, 3], rtsFactions: [0], match: normalizeMatch({ maxSignifiers: 0 }) });
  w.hippies.clear(); w.time = 100; w.factions[0].ritual = 300;
  spawnBuilding(w, 'drumcircle', 0, w.hearthOf(0)!.facet, 1);
  return w;
}
export function powerAdvance(w: World, seconds: number): void { w.time += seconds; w.tick++; updateAbilities(w, seconds); }
