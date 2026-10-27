/**
 * World: the single source of simulation truth. Plain data + tiny bookkeeping helpers.
 * Systems (sim/systems/*) mutate it during Simulation.step(); everyone else only reads it
 * and submits Commands.
 */
import type { Wreckage } from './wreckage';
import type { Command } from './commands';
import type { BossOutcome, BossState } from './boss';
import type { GameEvent } from './events';
import type { Lattice } from './lattice/lattice';
import type { MapLayout } from './map/mapgen';
import type { NavGrid } from './nav/navgrid';
import type { CollisionWorld } from './physics/collision';
import { Rng } from './rng';
import type {
  Avatar,
  Building,
  Crystal,
  DroppedBeacon,
  EntityId,
  FactionId,
  FactionState,
  Flag,
  Hippie,
  MatchOptions,
  MatchPhase,
  Owner,
  Pile,
  Piece,
  Ping,
  Projectile,
  Zone,
} from './types';

/** Derived Survey geometry. Recomputed by systems/survey.ts whenever `dirty` is set. */
export interface SurveyState {
  /** Bumped after every recompute (render/ai cache key). */
  version: number;
  dirty: boolean;
  /** Per node: owner of the real planted Flag (-1 none). Simulacra count on both nodes. */
  nodeFlagOwner: Int8Array;
  /** Per node: planted Flag id (-1 none). */
  nodeFlag: Int32Array;
  /** Per node: faction holding it as an implied Flag (-1 none). */
  impliedOwner: Int8Array;
  /** Per node: implied order 1..3 (0 = not implied). */
  impliedOrder: Uint8Array;
  /** Per node: effective holder (real or implied), -1 none. */
  holder: Int8Array;
  /** Per edge: faction whose Ley Line spans it, -1 none. */
  edgeLey: Int8Array;
  /** Per facet: faction holding all four corners, -1 none. */
  facetCrystal: Int8Array;
  /** Per facet: bitmask of factions whose Survey encloses it (bit f = 1 << f). */
  facetSurvey: Uint8Array;
  /** Per facet: instability 0..1 (overlap interference). */
  facetInstability: Float32Array;
  /** Per node: bitmask of factions observing it (Zeno). Recomputed each tick by tides/survey. */
  nodeObserved: Uint8Array;
  /** Survey size (enclosed facet count) per faction. */
  surveySize: [number, number, number, number];
  /** Current 5-fold focus nodes. */
  focusNodes: number[];
}

export interface TideState {
  nextAt: number;
  warned: boolean;
  count: number;
}

export class World {
  readonly options: MatchOptions;
  readonly seed: string;
  rng: Rng;
  tick = 0;
  time = 0;
  phase: MatchPhase = 'playing';
  winner: FactionId | null = null;
  suddenDeath = false;
  /** Authoritative start of the boss reveal, in match seconds. Null before the transition. */
  effigyRevealedAt: number | null = null;
  /** Durable authoritative encounter and result, including late joins. */
  boss: BossState | null = null;
  bossOutcome: BossOutcome | null = null;
  /** Canonical map obstacle IDs removed by direct boss beam hits; replicated for late joins. */
  destroyedScenery = new Set<number>();
  /** Durable cosmetic remnants of removed constructed structures, oldest first. */
  wreckage: Wreckage[] = [];

  lattice!: Lattice;
  map!: MapLayout;
  collision!: CollisionWorld;
  nav!: NavGrid;

  factions: FactionState[] = [];
  flags = new Map<EntityId, Flag>();
  avatars = new Map<EntityId, Avatar>();
  hippies = new Map<EntityId, Hippie>();
  buildings = new Map<EntityId, Building>();
  pieces = new Map<EntityId, Piece>();
  piles = new Map<EntityId, Pile>();
  crystals = new Map<EntityId, Crystal>();
  projectiles = new Map<EntityId, Projectile>();
  zones = new Map<EntityId, Zone>();
  pings = new Map<EntityId, Ping>();
  beacons = new Map<EntityId, DroppedBeacon>();

  survey!: SurveyState;
  tide: TideState = { nextAt: 0, warned: false, count: 0 };

  /** Systems may stash cross-tick private state here, keyed by system name. */
  scratch: Record<string, unknown> = {};

  private nextEntityId = 1;
  private pending: Command[] = [];
  private events: GameEvent[] = [];
  private eventLog: GameEvent[] = [];

  constructor(options: MatchOptions) {
    this.options = options;
    this.seed = options.seed;
    this.rng = new Rng(`world:${options.seed}`);
  }

  newId(): EntityId {
    return this.nextEntityId++;
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  submit(cmd: Command): void {
    this.pending.push(cmd);
  }

  /** Called by the simulation at the start of a tick. */
  takeCommands(): Command[] {
    const cmds = this.pending;
    this.pending = [];
    return cmds;
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  emit(e: GameEvent): void {
    this.events.push(e);
  }

  /** Returns and clears events accumulated since the last drain (called once per frame). */
  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    if (this.eventLog.length > 4000) this.eventLog.splice(0, 2000);
    for (const e of out) this.eventLog.push(e);
    return out;
  }

  /** Recent event history (debug / end-of-match recap). */
  recentEvents(): readonly GameEvent[] {
    return this.eventLog;
  }

  // ── Lookups ────────────────────────────────────────────────────────────────
  faction(id: FactionId): FactionState {
    return this.factions[id];
  }

  avatarOf(f: FactionId): Avatar {
    return this.avatars.get(this.factions[f].avatarId)!;
  }

  /** Main (first) Hearth of a faction, or undefined if eliminated. */
  hearthOf(f: FactionId): Building | undefined {
    const id = this.factions[f].hearthIds[0];
    return id === undefined ? undefined : this.buildings.get(id);
  }

  gccOf(f: FactionId): Building | undefined {
    const id = this.factions[f].gccId;
    return id === null ? undefined : this.buildings.get(id);
  }

  /** Flags in a Hearth's stock. */
  stockOf(hearthId: EntityId): Flag[] {
    const out: Flag[] = [];
    for (const fl of this.flags.values()) if (fl.state === 'stock' && fl.holder === hearthId) out.push(fl);
    return out;
  }

  /** Total stock across all of a faction's Hearths and Workshops. */
  stockCount(f: FactionId): number {
    let n = 0;
    for (const fl of this.flags.values()) if (fl.state === 'stock' && this.buildings.get(fl.holder)?.faction === f) n++;
    return n;
  }

  hippiesOf(f: Owner): Hippie[] {
    const out: Hippie[] = [];
    for (const h of this.hippies.values()) if (h.faction === f) out.push(h);
    return out;
  }

  buildingsOf(f: Owner, kind?: Building['kind']): Building[] {
    const out: Building[] = [];
    for (const b of this.buildings.values()) if (b.faction === f && (!kind || b.kind === kind)) out.push(b);
    return out;
  }

  /** Bit test helper for SurveyState.facetSurvey. */
  inSurvey(facet: number, f: FactionId): boolean {
    return facet >= 0 && (this.survey.facetSurvey[facet] & (1 << f)) !== 0;
  }

  aliveFactions(): FactionId[] {
    return this.factions.filter((f) => f.alive).map((f) => f.id);
  }
}

/** Allocate survey arrays sized to the lattice. */
export function createSurveyState(lat: Lattice): SurveyState {
  const n = lat.nodes.length;
  const e = lat.edges.length;
  const f = lat.facets.length;
  return {
    version: 0,
    dirty: true,
    nodeFlagOwner: new Int8Array(n).fill(-1),
    nodeFlag: new Int32Array(n).fill(-1),
    impliedOwner: new Int8Array(n).fill(-1),
    impliedOrder: new Uint8Array(n),
    holder: new Int8Array(n).fill(-1),
    edgeLey: new Int8Array(e).fill(-1),
    facetCrystal: new Int8Array(f).fill(-1),
    facetSurvey: new Uint8Array(f),
    facetInstability: new Float32Array(f),
    nodeObserved: new Uint8Array(n),
    surveySize: [0, 0, 0, 0],
    focusNodes: [],
  };
}
