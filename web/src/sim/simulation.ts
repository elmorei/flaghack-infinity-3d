/**
 * Fixed-step simulation orchestrator. One call to step() = one SIM_DT tick.
 * System order matters: commands → actors → economy → geometry → consequences.
 */
import { SIM_DT } from './constants';
import { updateAbilities } from './systems/abilities';
import { updateAvatars } from './systems/avatars';
import { spawnBoss, updateBoss } from './systems/boss';
import { updateBuildings } from './systems/buildings';
import { applyCommands } from './systems/commands';
import { updateCapture } from './systems/capture';
import { updateCrystals } from './systems/crystals';
import { updateCrystalAttacks } from './systems/crystalAttacks';
import { updateDrugs } from './systems/drugs';
import { updateEconomy } from './systems/economy';
import { updateSceneryDepots } from './systems/sceneryDepots';
import { updateEffigy } from './systems/effigy';
import { updateGcc } from './systems/gcc';
import { updateHippies } from './systems/hippies';
import { updateInstability } from './systems/instability';
import { updatePieces } from './systems/pieces';
import { updatePings } from './systems/pings';
import { updateProjectiles } from './systems/projectiles';
import { updateSurvey } from './systems/survey';
import { updateTides } from './systems/tides';
import { updateVictory } from './systems/victory';
import type { World } from './world';

export class Simulation {
  readonly world: World;
  /** Per-system wall-clock cost of the last step (ms), for the perf overlay/eval. */
  readonly timings: Record<string, number> = {};

  constructor(world: World) {
    this.world = world;
  }

  step(): void {
    const w = this.world;
    const dt = SIM_DT;
    w.tick++;
    w.time += dt;
    // Direct calls with a running timestamp: wrapping each system in a closure would
    // allocate ~17 functions per tick (~1.5M per match) just to measure them.
    let t = performance.now();
    updateEffigy(w);
    spawnBoss(w);
    applyCommands(w);
    t = this.lap('commands', t);
    if (w.phase !== 'playing') return;
    updateAvatars(w, dt);
    t = this.lap('avatars', t);
    updateHippies(w, dt);
    t = this.lap('hippies', t);
    updateProjectiles(w, dt);
    t = this.lap('projectiles', t);
    updatePings(w, dt);
    t = this.lap('pings', t);
    updateEconomy(w, dt);
    t = this.lap('economy', t);
    updateBuildings(w, dt);
    t = this.lap('buildings', t);
    updatePieces(w, dt);
    t = this.lap('pieces', t);
    updateGcc(w, dt);
    t = this.lap('gcc', t);
    updateAbilities(w, dt);
    t = this.lap('abilities', t);
    updateDrugs(w, dt);
    t = this.lap('drugs', t);
    updateSurvey(w, dt);
    t = this.lap('survey', t);
    updateBoss(w, dt);
    t = this.lap('boss', t);
    updateCrystals(w, dt);
    updateCrystalAttacks(w, dt);
    t = this.lap('crystals', t);
    updateInstability(w, dt);
    t = this.lap('instability', t);
    updateTides(w, dt);
    t = this.lap('tides', t);
    updateCapture(w, dt);
    updateSceneryDepots(w);
    t = this.lap('capture', t);
    updateVictory(w, dt);
    this.lap('victory', t);
  }

  /** Record the time since `t0` under `name`; returns now as the next lap's start. */
  private lap(name: string, t0: number): number {
    const t1 = performance.now();
    this.timings[name] = t1 - t0;
    return t1;
  }
}
