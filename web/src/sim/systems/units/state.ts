/**
 * Private cross-tick state of the unit systems (avatars, hippies), stored in
 * world.scratch.units: spatial hash, path request queue, Survey reservations, Flag claims,
 * Drum Circle slots, allocator timers and per-tick / per-Survey-version caches.
 */
import { MAP_HALF } from '../../constants';
import type { Building, EntityId, Flag, Hippie } from '../../types';
import type { World } from '../../world';
import { SpatialHash } from './spatial';

/** Avatar bookkeeping that is not part of the shared Avatar contract. */
export interface AvatarMind {
  /** world.time when the next quiver restock may happen. */
  restockAt: number;
}

const SCRATCH_KEY = 'units';
const QUERY_CAPACITY = 512;

export class UnitsState {
  readonly hash = new SpatialHash(MAP_HALF, 4);
  /** Newest recruits beyond each camp's soft capacity. */
  readonly overCap = new Set<EntityId>();
  readonly campMembers: Hippie[][] = [[], [], [], []];
  /** Non-KO hippies this tick (the hash's items). */
  readonly active: Hippie[] = [];
  /** Shared spatial query result buffer (valid until the next query). */
  readonly near = new Int32Array(QUERY_CAPACITY);
  readonly avatarMinds = new Map<EntityId, AvatarMind>();

  /** Hippie ids waiting for an A* path; drained FIFO under the per-tick budget. */
  readonly pathQueue: EntityId[] = [];
  pathHead = 0;

  /** Survey reservations: planned node → hippie id walking a Flag to it. */
  readonly nodeReservations = new Map<number, EntityId>();
  /** Flag claims (pickup / pull targets): Flag id → hippie id. */
  readonly flagClaims = new Map<EntityId, EntityId>();
  /** Drum Circle slots: building id → hippie id per slot (-1 = free). */
  readonly drumSlots = new Map<EntityId, Int32Array>();
  /** Job allocator schedule per faction (staggered so factions don't share a tick). */
  readonly nextAllocAt = new Float64Array([0, 0.125, 0.25, 0.375]);
  /** When stale reservations/claims are next swept. */
  nextSweepAt = 0;

  // ── Per-tick caches (rebuilt by the hippie system each tick) ────────────────
  readonly looseFlags: Flag[] = [];
  readonly stockByHearth = new Map<EntityId, number>();
  readonly stockByFaction = new Int32Array(4);
  /** Base attention drain per faction (hoarding, Acid Cop paranoia). */
  readonly attentionMult = new Float64Array(4);
  /** Own built, enabled Drum Circles per faction. */
  readonly drumCircles: Building[][] = [[], [], [], []];
  /** Hippies heading to each Hearth for stock / building for work / pile / ping this tick. */
  readonly fetchers = new Map<EntityId, number>();
  readonly helpers = new Map<EntityId, number>();
  readonly choppers = new Map<EntityId, number>();
  readonly responders = new Map<EntityId, number>();
  /** Per faction: hippies on the Raid job, and non-raiders pulling Flags off the plan. */
  readonly raiders = new Int32Array(4);
  readonly clearers = new Int32Array(4);
  /**
   * Other camps' planted Flags squatting on each faction's plan nodes. Plans change at any
   * moment (not tied to the Survey version), so this is rebuilt at most once per tick.
   */
  readonly planBlockers: EntityId[][] = [[], [], [], []];
  readonly planBlockersTick = new Float64Array(4).fill(-1);

  // ── Survey-version caches (recomputed when world.survey.version changes) ────
  /** Rival Flags on critical nodes of loops enclosing our Hearths (per own faction). */
  readonly criticalFlags: EntityId[][] = [[], [], [], []];
  readonly criticalVersion = new Int32Array(4).fill(-1);
  /** Rival Flags within the Hearth threat radius (per own faction). */
  readonly threatFlags: EntityId[][] = [[], [], [], []];
  readonly threatVersion = new Int32Array(4).fill(-1);
  /** Flags of a faction on the boundary of its own Survey (per owning faction). */
  readonly boundaryFlags: EntityId[][] = [[], [], [], []];
  readonly boundaryVersion = new Int32Array(4).fill(-1);
  /** Rival Flags on nodes touching our Survey (per own faction). */
  readonly intruderFlags: EntityId[][] = [[], [], [], []];
  readonly intruderVersion = new Int32Array(4).fill(-1);

  // ── Allocator scratch ───────────────────────────────────────────────────────
  readonly pool: Hippie[] = [];
  readonly free: Hippie[] = [];
  readonly jobCap = new Float64Array(5);
  readonly jobTarget = new Int32Array(5);
  readonly jobCount = new Int32Array(5);
  readonly jobFrac = new Float64Array(5);
  readonly nodeScratch: number[] = [];
}

export function unitsState(world: World): UnitsState {
  const s = world.scratch[SCRATCH_KEY];
  if (s instanceof UnitsState) return s;
  const created = new UnitsState();
  world.scratch[SCRATCH_KEY] = created;
  return created;
}
