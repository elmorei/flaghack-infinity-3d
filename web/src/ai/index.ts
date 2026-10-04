/**
 * NPC vexillomancers. createAi returns a controller the app calls once per sim tick (before
 * Simulation.step). AI may only read World state its faction could know and act through
 * world.submit(Command). Owner: AI agent.
 *
 * Each faction runs a Brain through layered passes at their own cadence: perception (2 Hz),
 * the director (decision interval by difficulty) followed by the Survey planner, labour and
 * builder, powers (abilities, drugs, Command Center), and the avatar pilot every tick.
 * Enclosure planning, the one heavy computation, is rationed to one plan per tick across all
 * brains of a world (Scheduler).
 *
 * A controller may be created for any faction at any moment, human seats included (the host
 * hands a disconnected player's seat to an NPC and takes it back on rejoin): the brain adopts
 * the camp as it stands. Dropping a controller is simply no longer calling update(): it holds
 * no timers and nothing outside it refers to it. Controllers share nothing but the per-world
 * planning budget, so one controller per seat plays exactly like one controller for all.
 */
import { SIM_HZ } from '../sim/constants';
import { FACTION_IDS } from '../sim/types';
import type { FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { Brain } from './brain';
import { manageBuilds } from './builder';
import { direct } from './director';
import { manageLabour, releaseFollowers, releaseGuards } from './labour';
import { perceive, schedulerOf } from './perception';
import type { Scheduler } from './perception';
import { pilotTick } from './pilot';
import { adoptHomeRing, updatePlan } from './plans';
import { usePowers } from './powers';

export interface AiController {
  /** Called once per simulation tick before step(). */
  update(): void;
  /** Read-only state of one faction's brain (debug overlays, tests), or undefined if not AI. */
  inspect(f: FactionId): Readonly<Brain> | undefined;
}

/** Cadences (sim ticks): perception at 2 Hz, powers every second, builder every 2 s. */
const PERCEIVE_TICKS = SIM_HZ / 2;
const POWERS_TICKS = SIM_HZ;
const BUILD_TICKS = 2 * SIM_HZ;
/**
 * Every faction thinks on its own fixed ticks of each cadence (perception on ticks 3, 10, 17
 * and 24 of every 30), so four brains never stack their passes on one tick, however the host
 * groups them into controllers and whenever one is created mid-match.
 */
const PHASE_BASE = 3;
const PHASE_STEP = Math.floor(PERCEIVE_TICKS / FACTION_IDS.length);

export function createAi(world: World, factions: readonly FactionId[]): AiController {
  const brains = factions.filter(f=>world.factions[f].alive).map((f) => {
    const b = new Brain(world, f, PHASE_BASE + f * PHASE_STEP);
    b.nextPerceiveTick = alignedTick(world.tick, PERCEIVE_TICKS, b.phase);
    b.nextDecideTick = alignedTick(world.tick, b.decideTicks, b.phase + 1);
    b.nextPowersTick = alignedTick(world.tick, POWERS_TICKS, b.phase + 2);
    b.nextBuildTick = alignedTick(world.tick, BUILD_TICKS, b.phase + 4);
    return b;
  });
  const sched = schedulerOf(world);
  return {
    update() {
      if (world.phase !== 'playing') return;
      for (const b of brains) think(b, sched);
    },
    inspect(f) {
      return brains.find((b) => b.f === f);
    },
  };
}

/** The first tick at or after `from` that falls on `phase` of a `period`-tick cadence. */
function alignedTick(from: number, period: number, phase: number): number {
  return from + ((((phase - from) % period) + period) % period);
}

function think(b: Brain, sched: Scheduler): void {
  const world = b.world;
  if (!world.factions[b.f].alive) return;
  const tick = world.tick;
  if (tick >= b.nextPerceiveTick) {
    b.nextPerceiveTick = alignedTick(tick + 1, PERCEIVE_TICKS, b.phase);
    perceive(b, sched);
    if (b.view.hearthId >= 0 && !b.adopted) {
      // Taking the camp in hand, at match start or from a departed human mid-match.
      b.adopted = true;
      releaseFollowers(b);
    }
    if (b.homeNodes.length === 0 && b.view.hearthId >= 0) adoptHomeRing(b);
  }
  // The first decision waits until every rival has been sized up once: a camp taken over
  // mid-match must see the siege it is in (or leading) before it picks what to do.
  if (!b.briefed && b.view.hearthId >= 0 && b.sizedUp()) b.briefed = true;
  if (tick >= b.nextDecideTick && b.briefed) {
    b.nextDecideTick = alignedTick(tick + 1, b.decideTicks, b.phase + 1);
    const before = b.posture;
    direct(b);
    if (before !== b.posture && (before === 'attack' || before === 'opportunist')) releaseGuards(b);
    updatePlan(b, sched);
    manageLabour(b);
  }
  if (tick >= b.nextBuildTick) {
    b.nextBuildTick = alignedTick(tick + 1, BUILD_TICKS, b.phase + 4);
    manageBuilds(b);
  }
  if (tick >= b.nextPowersTick) {
    b.nextPowersTick = alignedTick(tick + 1, POWERS_TICKS, b.phase + 2);
    usePowers(b);
  }
  pilotTick(b);
}
