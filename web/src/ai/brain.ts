/**
 * Per-faction NPC state shared by the AI layers (perception, director, survey plans, labour,
 * builder, powers, avatar pilot). Plain data plus timers; the layers live in their own
 * modules and operate on a Brain.
 * Owner: AI agent.
 */
import { FACTION_DEFS, SIM_HZ } from '../sim/constants';
import type { CaptureStage, ChakraId, EntityId, FactionId, GccAction } from '../sim/types';
import type { World } from '../sim/world';
import type { ThrowAim } from './ballistics';
import { PERSONAS, SKILLS } from './persona';
import type { Persona, Skill } from './persona';

export type Posture = 'economy' | 'expand' | 'attack' | 'defend' | 'opportunist';

/** What this faction knows about one rival (all of it public or seen). */
export interface RivalIntel {
  id: FactionId;
  alive: boolean;
  hearthId: EntityId;
  hx: number;
  hz: number;
  facet: number;
  stage: CaptureStage;
  /** Leading attacker on their Hearth (public on the Hearth rail). */
  attacker: FactionId | null;
  /** Our pressure on their Hearth, 0..100. */
  ourPressure: number;
  /** Their Hearth sits inside their own Survey (attacks then only contest it). */
  homeIntact: boolean;
  /** Their planted Flags. */
  planted: number;
  /** Cheapest loop we could close around their Hearth, its new-Flag cost, and when it was planned. */
  loop: number[] | null;
  loopCost: number;
  loopAt: number;
  /** Their Flags critical to their own home loop (pull these to turn a contest into containment). */
  homeCritical: EntityId[];
  homeCriticalVersion: number;
  /** Our Flags whose loss would open our loop around their Hearth (guard these), and its version. */
  ourCritical: EntityId[];
  ourCriticalVersion: number;
  /** Second siege wall around their Hearth (two disjoint walls have no critical Flag). */
  outer: number[] | null;
  outerAt: number;
  /** Our walls stood closed around their Hearth at least once this assault (no more keystones). */
  closedOnce: boolean;
  /** Keystone nodes held back until the siege walls are ready to close (empty when not waiting). */
  keystones: number[];
  /** After planning found no loop, when to try again; the Hearth that failed, passed over
   * until unreachableUntil. */
  loopRetryAt: number;
  unreachableHearth: EntityId;
  unreachableUntil: number;
  /** Third camps' Flags standing where our siege wall would go (another besieger at work). */
  crowd: number;
  /** The usual band held no loop: plan in the wide band instead. */
  wide: boolean;
}

/** Perception snapshot (refreshed at ≤ 2 Hz). */
export interface View {
  at: number;
  hearthId: EntityId;
  hx: number;
  hz: number;
  facet: number;
  stage: CaptureStage;
  /** Highest rival pressure on our home Hearth (outposts are left to fend for themselves). */
  pressure: number;
  /** Rivals whose Survey encloses our home Hearth. */
  enclosers: FactionId[];
  /** Rival Flags critical to loops around our home Hearth, cheapest to break first. */
  critical: EntityId[];
  criticalVersion: number;
  /** Our main Hearth sits inside our own Survey. */
  homeIntact: boolean;
  stock: number;
  carried: number;
  /** Own or ownerless loose Flags lying near home (hippies fetch them). */
  looseNear: number;
  lumber: number;
  ritual: number;
  population: number;
  popCap: number;
  /** Visible rival hippies inside our Survey or near our Hearth. */
  intruders: EntityId[];
  /** Visible rival hippies around our Command Center, and neutral ones in recruitment range. */
  rivalsNearGcc: number;
  neutralsNearGcc: EntityId[];
  visibleNeutrals: EntityId[];
  /** Visible rival hippies within the Omega Pulse reach of our vexillomancer. */
  rivalsNearAvatar: number;
  rivals: RivalIntel[];
}

export type PilotTask =
  | { kind: 'pickup'; flagId: EntityId }
  | { kind: 'recruit'; hippieId: EntityId }
  | { kind: 'home' }
  | { kind: 'hold' }
  | { kind: 'plant'; node: number }
  | { kind: 'pull'; flagId: EntityId }
  | { kind: 'restock'; hearthId: EntityId }
  | { kind: 'harvest'; pileId: EntityId }
  | { kind: 'align' }
  | { kind: 'gcc' }
  | { kind: 'fight'; target: EntityId }
  | { kind: 'guard'; x: number; z: number };

export interface PilotState {
  task: PilotTask;
  taskAt: number;
  /** Current path (waypoints) and the goal it was planned for. */
  path: { x: number; z: number }[];
  pathIndex: number;
  goalX: number;
  goalZ: number;
  pathAt: number;
  /** Stuck detection: position sampled at stuckAt. */
  stuckX: number;
  stuckZ: number;
  stuckAt: number;
  jumpUntil: number;
  /** Throw being lined up (aim held for a tick before releasing). */
  aim: ThrowAim;
  aimNode: number;
  aimReadyAt: number;
  /** Nodes recently thrown at, so the quiver is not emptied at one spot in flight. */
  thrownAt: Map<number, number>;
  /** Last input sent, to skip identical resubmits. */
  sentMoveX: number;
  sentMoveZ: number;
  sentYaw: number;
  sentPitch: number;
  sentSprint: boolean;
  sentJump: boolean;
  sentThrowMode: boolean;
}

export class Brain {
  readonly world: World;
  readonly f: FactionId;
  readonly persona: Persona;
  readonly skill: Skill;

  /** This faction's tick within every cadence (no two factions think on the same tick), and
   * the director's interval in ticks for its difficulty. */
  readonly phase: number;
  readonly decideTicks: number;
  /** Next sim tick of each cadence: perception, decisions, powers, builder. */
  nextPerceiveTick = 0;
  nextDecideTick = 0;
  nextPowersTick = 0;
  nextBuildTick = 0;
  /** The camp has been taken in hand (home ring adopted, a departed human's followers freed),
   * and the first decision has been made with every rival sized up. */
  adopted = false;
  briefed = false;
  /** Perception scratch: own units and buildings that can see rival hippies. */
  readonly observers: { x: number; z: number }[] = [];

  view: View;
  posture: Posture = 'economy';
  /** Rival under assault (attack/opportunist), else null. */
  target: FactionId | null = null;
  postureSince = 0;
  /** When the current assault began (0 = none). */
  assaultAt = 0;
  /** world.time until which a loop that just closed around us is still being "noticed" (reaction delay). */
  noticeAt = 0;
  wasEnclosed = false;
  /** Number of times our main Hearth was contained (wardens fortify after the first). */
  timesContained = 0;
  wasContained = false;
  /** Our overwrite of the target leads theirs on us: the assault goes on despite the siege. */
  racing = false;

  /** Territory the camp keeps planted (home ring plus completed lobes) and the home ring radius. */
  homeNodes: number[] = [];
  homeRadius = 0;
  /** Earliest time the home ring may be replanned again. */
  homeReplanAt = 0;
  /** Lobe being grown out of the territory (not yet complete), the direction to try next, and
   * when to try again after every direction failed. */
  expansion: number[] | null = null;
  lobeTurn = 0;
  lobeRetryAt = 0;
  pentacleFocus = -1;
  /** Last plan we sent (sorted), to avoid resubmitting an identical one. */
  sentPlan: number[] = [];

  /** Flags we ordered hippies to pull, flag id → hippie ids. */
  pullOrders = new Map<EntityId, EntityId[]>();
  wardOrders = new Map<EntityId, EntityId[]>();
  /** Last job weights sent (serialized) to skip identical resubmits. */
  sentWeights = '';
  /** Builder found no room for its next building: the director favours expanding. */
  needsRoom = false;
  /** Next time the assault may re-mark the target's home-ring Flags with attack pings. */
  nextPingAt = 0;
  /** Chakra alignment wanted next (null = none), and the GCC action the pilot is walking to. */
  alignWanted: ChakraId | null = null;
  gccWanted: { action: GccAction; target: EntityId | -1; nodes: number[] } | null = null;

  pilot: PilotState;

  constructor(world: World, f: FactionId, phase: number) {
    this.world = world;
    this.f = f;
    // A seat plays its faction's temperament whoever held it before: a human seat's
    // FactionState says 'player', but Jaguar taken over from a human is still the Warden.
    this.persona = PERSONAS[FACTION_DEFS[f].personality];
    this.skill = SKILLS[world.factions[f].difficulty];
    this.phase = phase;
    this.decideTicks = Math.max(1, Math.round(this.skill.decide * SIM_HZ));
    this.view = emptyView();
    this.pilot = {
      task: { kind: 'home' },
      taskAt: 0,
      path: [],
      pathIndex: 0,
      goalX: NaN,
      goalZ: NaN,
      pathAt: -Infinity,
      stuckX: 0,
      stuckZ: 0,
      stuckAt: 0,
      jumpUntil: 0,
      aim: { yaw: 0, pitch: 0, flight: 0 },
      aimNode: -1,
      aimReadyAt: 0,
      thrownAt: new Map(),
      sentMoveX: NaN,
      sentMoveZ: NaN,
      sentYaw: NaN,
      sentPitch: NaN,
      sentSprint: false,
      sentJump: false,
      sentThrowMode: false,
    };
  }

  /** Flags this camp can lay hands on soon (stock, quiver, loose ones near home). */
  flagsInHand(): number {
    return this.view.stock + this.view.carried + this.view.looseNear;
  }

  intel(e: FactionId): RivalIntel | undefined {
    return this.view.rivals.find((r) => r.id === e);
  }

  /** Every living rival's loop has been planned (or found impossible) at least once. */
  sizedUp(): boolean {
    for (const r of this.view.rivals) if (r.alive && r.loopAt === -Infinity) return false;
    return this.view.rivals.length > 0;
  }
}

function emptyView(): View {
  return {
    at: -Infinity,
    hearthId: -1,
    hx: 0,
    hz: 0,
    facet: -1,
    stage: 'safe',
    pressure: 0,
    enclosers: [],
    critical: [],
    criticalVersion: -1,
    homeIntact: true,
    stock: 0,
    carried: 0,
    looseNear: 0,
    lumber: 0,
    ritual: 0,
    population: 0,
    popCap: 0,
    intruders: [],
    rivalsNearGcc: 0,
    neutralsNearGcc: [],
    visibleNeutrals: [],
    rivalsNearAvatar: 0,
    rivals: [],
  };
}
