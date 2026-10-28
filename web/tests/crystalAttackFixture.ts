import { spawnCrystal, spawnHippie } from '../src/sim/factory';
import { normalizeMatch } from '../src/sim/matchSettings';
import { CollisionWorld } from '../src/sim/physics/collision';
import { createMatch } from '../src/sim/setup';
import { updateCrystalAttacks } from '../src/sim/systems/crystalAttacks';
import type { FactionId, Owner } from '../src/sim/types';
export function crystalAttackFixture() {
  const world = createMatch({ seed: 'ordinary-crystal-attacks', mode: 'standard', difficulty: 'normal', humans: [0, 1, 2, 3], match: normalizeMatch() });
  world.collision = new CollisionWorld(); world.map.obstacles = []; world.hippies.clear(); world.crystals.clear();
  world.buildings.clear(); world.pieces.clear(); world.time = 10;
  for (const a of world.avatars.values()) a.pos = { x: 100, y: 0, z: 100 + a.faction * 10 };
  const crystal = (x = 0, z = 0, faction: FactionId = 0) => {
    const c = spawnCrystal(world, 0, faction, []); c.pos = { x, z }; c.growth = 1; c.scale = 1; return c;
  };
  const unit = (x = 10, z = 0, faction: Owner = 1) => spawnHippie(world, faction, { x, z });
  const step = (dt: number) => { world.time += dt; world.tick++; updateCrystalAttacks(world, dt); };
  world.drainEvents(); return { world, crystal, unit, step };
}
