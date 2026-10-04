import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../game/session';
import { SIM_DT } from '../sim/constants';
import { spawnHippie } from '../sim/factory';
import { TRAINING_CAMP, TRAINING_PLAYER } from '../sim/scenarios/tutorial';
import { popCap, population } from '../sim/systems/economy';
import { createMatch } from '../sim/setup';
import { Simulation } from '../sim/simulation';
import type { World } from '../sim/world';
import { COURSE } from './course';
import { createTutorial } from './director';
import { LESSONS } from './lessons';
import { readTrainingProgress, trainingStanding, TRAINING_KEY } from './progress';
import { Trainee } from './testTrainee';
import type { TutorialDriver } from './types';

/** The whole course must fit in this much burn time for a competent trainee. */
const COURSE_BUDGET = 18 * 60;
/** App frames run a couple of sim steps each before the frame's events reach the director. */
const STEPS_PER_FRAME = 2;

interface Burn {
  world: World;
  sim: Simulation;
  session: Session;
  driver: TutorialDriver;
  exits: number;
}

function newBurn(): Burn {
  const world = createMatch({ seed: 'training-burn', difficulty: 'normal', humans: [TRAINING_PLAYER], mode: 'tutorial' });
  const session = new Session();
  const burn: Burn = { world, sim: new Simulation(world), session, driver: createTutorial(world, session, { exitToTitle: () => burn.exits++ }), exits: 0 };
  return burn;
}

/** One App frame: `before` (the controls) and tick() ahead of every step, then update() with the frame's events. */
function frame(burn: Burn, before?: () => void): void {
  for (let i = 0; i < STEPS_PER_FRAME; i++) {
    before?.();
    burn.driver.tick();
    burn.sim.step();
  }
  burn.driver.update(STEPS_PER_FRAME * SIM_DT, burn.world.drainEvents());
}

function runFor(burn: Burn, seconds: number, before?: () => void): void {
  const frames = Math.round(seconds / (STEPS_PER_FRAME * SIM_DT));
  for (let i = 0; i < frames; i++) frame(burn, before);
}

/** Drive the avatar with plain input for a moment (a player at the keyboard). */
function hold(burn: Burn, seconds: number, input: { moveX?: number; moveZ?: number; jump?: boolean; sprint?: boolean; yaw?: number }): void {
  const av = burn.world.avatarOf(TRAINING_PLAYER);
  const cmd = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: av.yaw, pitch: 0, ...input };
  runFor(burn, seconds, () => burn.world.submit({ t: 'avatarInput', faction: TRAINING_PLAYER, input: cmd }));
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Training Burn', () => {
  it('lists the same lessons in the course and the scripts', () => {
    expect(LESSONS.map((l) => l.id)).toEqual(COURSE.map((l) => l.id));
  });

  it('a trainee completes every lesson in order within the time budget', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const burn = newBurn();
    const trainee = new Trainee(burn.world, burn.session, burn.driver);
    const started: Record<string, number> = {};
    const finished: Record<string, number> = {};
    let versions = burn.driver.state.version;
    while (burn.driver.state.phase !== 'graduated' && burn.world.time < COURSE_BUDGET) {
      frame(burn, () => trainee.tick());
      const now = burn.driver.state;
      expect(now.version).toBeGreaterThanOrEqual(versions);
      versions = now.version;
      started[now.lesson.id] ??= burn.world.time;
      for (const id of now.sealsEarned) finished[id] ??= burn.world.time;
    }
    const timings = COURSE.map((l) => `${l.id} ${((finished[l.id] ?? NaN) - (started[l.id] ?? NaN)).toFixed(1)}s`);
    console.info(`Training Burn: graduated at ${burn.world.time.toFixed(1)} s sim time; ${timings.join(', ')}`);
    const st = burn.driver.state;
    expect(st.phase).toBe('graduated');
    expect(st.sealsEarned).toEqual(COURSE.map((l) => l.id));
    expect(st.lessons.every((l) => l.status === 'done')).toBe(true);
    expect(burn.world.phase).toBe('playing');
    // Conquest overwrote the training camp; the trainee's own camp never fell.
    expect(burn.world.factions[TRAINING_CAMP].alive).toBe(false);
    expect(burn.world.suddenDeath).toBe(true);
    expect(trainingStanding(readTrainingProgress())).toBe('whole');
    // Every staged drill really ran (a failed staging would let its lesson through at once).
    for (const id of ['survey', 'implied', 'phason', 'command', 'crystal', 'defense', 'conquest']) {
      expect(finished[id] - started[id]).toBeGreaterThan(1);
    }
  });

  it('objectives only count once they are current, and never during the briefing', () => {
    const burn = newBurn();
    const av = burn.world.avatarOf(TRAINING_PLAYER);
    // Walking and jumping while the mentor is still talking.
    hold(burn, 1.5, { moveX: 1, sprint: true, jump: true });
    expect(burn.driver.state.phase).toBe('briefing');
    expect(burn.driver.state.objectives).toEqual([]);
    burn.driver.continue();
    expect(burn.driver.state.objectives.map((o) => o.done)).toEqual([false, false, false, false, false]);
    // A jump while "walk" is current is not the jump objective (and is not walking either).
    hold(burn, 0.6, { jump: true });
    expect(burn.driver.state.objectives.map((o) => o.done)).toEqual([false, false, false, false, false]);
    hold(burn, 1.2, { moveX: 1 });
    expect(burn.driver.state.objectives[0].done).toBe(true);
    hold(burn, 0.6, { yaw: av.yaw + 1.2 });
    hold(burn, 0.6, { yaw: av.yaw - 1.2 });
    expect(burn.driver.state.objectives[1].done).toBe(true);
    hold(burn, 1.2, { moveX: -1, sprint: true });
    expect(burn.driver.state.objectives[2].done).toBe(true);
    // Jump is current now: standing still does nothing, a fresh jump counts.
    hold(burn, 0.5, {});
    expect(burn.driver.state.objectives[3].done).toBe(false);
    hold(burn, 0.3, { jump: true });
    expect(burn.driver.state.objectives[3].done).toBe(true);
    expect(burn.driver.state.phase).toBe('active');
  });

  it('skips, restarts and jumps between reached lessons', () => {
    const burn = newBurn();
    const st0 = burn.driver.state;
    expect(st0.lesson.id).toBe('arrival');
    expect(st0.lessons.map((l) => l.status)).toEqual(['current', ...COURSE.slice(1).map(() => 'locked')]);
    burn.driver.skipLesson();
    const st1 = burn.driver.state;
    expect(st1.version).toBeGreaterThan(st0.version);
    expect(st1.lesson.id).toBe('flag');
    expect(st1.phase).toBe('briefing');
    expect(st1.lessons[0].status).toBe('done');
    expect(st1.sealsEarned).toEqual([]);
    // Locked lessons cannot be jumped to.
    burn.driver.goToLesson('conquest');
    expect(burn.driver.state.lesson.id).toBe('flag');
    // Restart from a half-done lesson: back to its briefing, staging and markers gone.
    burn.driver.continue();
    expect(burn.session.markers.length).toBeGreaterThan(0);
    burn.driver.restartLesson();
    expect(burn.driver.state.phase).toBe('briefing');
    expect(burn.driver.state.objectives).toEqual([]);
    expect(burn.session.markers).toEqual([]);
    burn.driver.goToLesson('arrival');
    expect(burn.driver.state.lesson.id).toBe('arrival');
    expect(burn.driver.state.lessons[1].status).toBe('done');
    burn.driver.exit();
    expect(burn.exits).toBe(1);
  });

  it('remembers earned seals and resumes at the first unsealed lesson', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const burn = newBurn();
    const trainee = new Trainee(burn.world, burn.session, burn.driver);
    while (burn.driver.state.lesson.id === 'arrival' && burn.world.time < 60) frame(burn, () => trainee.tick());
    expect(JSON.parse(localStorage.getItem(TRAINING_KEY) ?? '{}')).toEqual({ seals: ['arrival'], graduated: false });
    const again = newBurn();
    expect(again.driver.state.lesson.id).toBe('flag');
    expect(again.driver.state.sealsEarned).toEqual(['arrival']);
    expect(again.driver.state.lessons[0].status).toBe('done');
  });

  it('a course walked with skipped lessons graduates without making the Seal whole', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const burn = newBurn();
    for (let i = 0; i < COURSE.length; i++) burn.driver.skipLesson();
    expect(burn.driver.state.phase).toBe('graduated');
    expect(burn.driver.state.sealsEarned).toEqual([]);
    const progress = readTrainingProgress();
    expect(progress).toEqual({ graduated: true, seals: 0, total: COURSE.length });
    expect(trainingStanding(progress)).toBe('walked');
  });

  it('graduation still completes when the camp is already at its population cap', () => {
    const burn = newBurn();
    for (let i = 0; i < COURSE.length - 1; i++) burn.driver.skipLesson();
    expect(burn.driver.state.lesson.id).toBe('graduation');
    const hearth = burn.world.hearthOf(TRAINING_PLAYER);
    if (!hearth) throw new Error('the trainee has a Hearth');
    const cap = popCap(burn.world, TRAINING_PLAYER);
    while (population(burn.world, TRAINING_PLAYER) < cap) spawnHippie(burn.world, TRAINING_PLAYER, { x: hearth.pos.x + 5, z: hearth.pos.z });
    const trainee = new Trainee(burn.world, burn.session, burn.driver);
    while (burn.driver.state.phase !== 'graduated' && burn.world.time < 120) frame(burn, () => trainee.tick());
    expect(burn.driver.state.phase).toBe('graduated');
    expect(burn.driver.state.sealsEarned).toContain('graduation');
    // The recruit joined even though the camp already occupied all of its soft capacity.
    expect(popCap(burn.world, TRAINING_PLAYER)).toBe(cap);
    expect(population(burn.world, TRAINING_PLAYER)).toBeGreaterThan(cap);
  });
});
