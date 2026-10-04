/**
 * Training Burn (tutorial mission) contract. The director (tutorial/director.ts, Tutorial agent)
 * runs the lessons against a local World; the mentor UI (ui/tutorial/, TutorialUI agent) renders
 * `state` and calls the TutorialRun controls; world markers travel through Session.markers.
 */
import type { GameEvent } from '../sim/events';

/**
 * UI elements a lesson can point at. The main UI tags them with `data-tutorial="<id>"`; the
 * tutorial UI pulses whichever ids `state.highlights` lists. Keep this list and the attributes in
 * lockstep.
 */
export const TUTORIAL_TARGETS = [
  'hud-flags',
  'hud-stock',
  'hud-lumber',
  'hud-ritual',
  'hud-signifiers',
  'hud-attention',
  'clock',
  'minimap',
  'rail',
  'rail-own',
  'feed',
  'cmi',
  'prompt',
  'tools',
  'tool-wall',
  'tool-floor',
  'tool-ramp',
  'tool-demolish',
  'tool-building',
  'ability-1',
  'ability-2',
  'ability-3',
  'ability-4',
  'ability-5',
  'drug-6',
  'drug-7',
  'drug-8',
  'plan-tools',
  'plan-node',
  'plan-enclose',
  'plan-pentacle',
  'plan-ring',
  'priorities',
  'priority-survey',
  'priority-gather',
  'priority-defend',
  'priority-raid',
  'priority-ritual',
  'buildings-panel',
  'gcc-panel',
  'hand-flag',
  'gcc-dialectics',
  'gcc-simulacra',
  'degen-roster',
  'chakras-panel',
  'align-button',
] as const;
export type TutorialTarget = (typeof TUTORIAL_TARGETS)[number];

export interface TutorialLessonInfo {
  id: string;
  /** 1-based position in the course. */
  index: number;
  title: string;
  /** The Seal of Flagistan fragment this lesson awards. */
  seal: string;
}

export interface TutorialObjective {
  id: string;
  /** Plain text; `**bold**` and `{key:E}` (rendered as a keycap) are the only markup. */
  text: string;
  done: boolean;
  progress?: { value: number; target: number };
}

export interface TutorialLine {
  speaker: 'vexillosaint' | 'narrator';
  /** Same markup as objectives. */
  text: string;
}

export type TutorialPhase =
  /** Mentor dialog; objectives hidden until the player continues. */
  | 'briefing'
  /** Objectives live; the burn runs. */
  | 'active'
  /** Lesson done: seal awarded, short debrief, continue to the next lesson. */
  | 'complete'
  /** Every lesson done: the Seal of Flagistan is whole. */
  | 'graduated';

export interface TutorialState {
  /** Increments on every change (UI polls and compares). */
  readonly version: number;
  readonly phase: TutorialPhase;
  readonly lesson: TutorialLessonInfo;
  readonly lessons: readonly (TutorialLessonInfo & { status: 'locked' | 'current' | 'done' })[];
  /** Mentor lines for the current beat (briefing, mid-lesson remarks, debrief). */
  readonly lines: readonly TutorialLine[];
  readonly objectives: readonly TutorialObjective[];
  /** A hint the player asked for or earned by waiting, else null. */
  readonly hint: string | null;
  readonly highlights: readonly TutorialTarget[];
  /** Seal fragments earned so far (lesson ids). */
  readonly sealsEarned: readonly string[];
}

/** Controls the mentor UI calls. */
export interface TutorialRun {
  readonly state: TutorialState;
  /** Briefing → active, complete → next lesson's briefing, graduated → no-op. */
  continue(): void;
  requestHint(): void;
  skipLesson(): void;
  restartLesson(): void;
  /** Jump to a lesson already reached (lesson select). */
  goToLesson(id: string): void;
  /** Leave the Training Burn for the title screen. */
  exit(): void;
}

/** What the App drives (local matches only). */
export interface TutorialDriver extends TutorialRun {
  /** Before every Simulation.step: staging, scripted rivals, objective checks. */
  tick(): void;
  /** Once per render frame with that frame's drained events. */
  update(dt: number, events: readonly GameEvent[]): void;
  dispose(): void;
}
