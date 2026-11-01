/**
 * Client-side replicated World. Built from createMatch(options) (static map, lattice, collision,
 * nav) plus the host's full snapshot; then advanced by state frames on a playback clock a little
 * behind the host so remote movement interpolates smoothly. Applying a frame keeps client-side
 * structures in sync (collision/nav for pieces and buildings, lattice flips, survey arrays) and
 * re-emits the frame's GameEvents through world.emit so render/ui/audio consume them unchanged.
 * The client never steps a Simulation on a mirror.
 *
 * The mirror keeps the host's wire rows (net/schema.ts) as its authoritative replica and
 * materializes them into the world's entities. Between frames, net/interp.ts blends the poses
 * of moving entities; before the next frame applies, they snap back to the replica values.
 * Owner: NetCore agent.
 */
import { createMatch } from '../sim/setup';
import type { BossState } from '../sim/boss';
import { registerBuildingShape } from '../sim/systems/buildings';
import { syncEffigy } from '../sim/systems/effigy';
import { syncScenery } from '../sim/systems/scenery';
import { attachPiece, detachPiece } from '../sim/systems/pieces';
import type { Avatar, EntityId, MatchOptions } from '../sim/types';
import type { World } from '../sim/world';
import type { EntityDelta, FullSnapshot, SurveyDelta, SurveySnapshot } from './codec';
import { Motion, PlaybackClock } from './interp';
import type { StateFrame } from './protocol';
import {
  blankAvatar,
  bossFromWire,
  CODECS,
  ENTITY_KINDS,
  FACTION_FIELDS,
  FACTION_MASK_ALL,
  perKind,
  readAvatarRow,
  SURVEY_ARRAYS,
  WORLD_FIELDS,
  WORLD_MASK_ALL,
  writeRow,
} from './schema';
import type { EntityCodec, EntityKind, Wire } from './schema';

/** What client-side prediction needs from the host's latest word on an avatar. */
export type AvatarKinematics = Pick<
  Avatar,
  'pos' | 'vel' | 'yaw' | 'pitch' | 'onGround' | 'koUntil' | 'action' | 'effects' | 'pushing'
>;

const AVATARS = CODECS.avatars;
const BOSS_FIELD = WORLD_FIELDS.findIndex(field => field.key === 'boss');

function maskOf(codec: EntityCodec, keys: readonly string[]): number {
  let m = 0;
  for (const k of keys) m |= 1 << codec.index(k);
  return m;
}

/** Avatar fields that client prediction owns on the predicted avatar. */
const PREDICTED_MASK = maskOf(AVATARS, ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'onGround']);
/** Building fields whose change moves or (un)registers its collision/nav shape. */
const SHAPE_MASK = maskOf(CODECS.buildings, ['kind', 'x', 'z', 'gcc', 'level']);

const NO_FLIPS: readonly number[] = [];
const NO_ROWS: readonly Wire[][] = [];

/** Local clock in ms, the same one the caller passes to advance(). */
export type LocalClock = () => number;

function performanceNow(): number {
  return performance.now();
}

export class NetMirror {
  readonly world: World;
  /** Authoritative wire rows as of the last applied frame. */
  private readonly rows = perKind(() => new Map<EntityId, Wire[]>());
  private readonly factionRows: Wire[][] = [];
  private worldRow: Wire[] = [];
  /** Frames received and not yet applied, oldest first. */
  private readonly queue: StateFrame[] = [];
  /** Avatar rows as of the newest pushed frame (prediction runs ahead of playback). */
  private readonly newestAvatars = new Map<EntityId, Wire[]>();
  private newestAcks: Record<string, number> = {};
  /** Prediction collides with the latest host body, not the delayed render pose. */
  private newestBoss: BossState | null = null;
  private newestTick: number;
  private newestTime: number;
  private appliedTick: number;
  private appliedTime: number;
  private predicted: EntityId | null = null;
  private readonly clock = new PlaybackClock();
  private readonly motion = new Motion();
  /** Stamps frame arrivals (ms). */
  private readonly clockMs: LocalClock;
  /** Reused decode target for latestAvatar(). */
  private readonly kinematics = blankAvatar(-1);
  /** Pieces a frame adds, by id, until their pieceBuilt event places them (reused per frame). */
  private readonly newPieces = new Map<EntityId, Wire[]>();

  private constructor(world: World, snapshot: FullSnapshot, clockMs: LocalClock) {
    this.world = world;
    this.clockMs = clockMs;
    this.newestTick = this.appliedTick = snapshot.tick;
    this.newestTime = this.appliedTime = snapshot.time;
    this.load(snapshot);
    this.newestBoss = bossFromWire(snapshot.w[BOSS_FIELD]);
    for (const [id, row] of this.rows.avatars) this.newestAvatars.set(id, row.slice());
    this.clock.note(snapshot.time, clockMs() / 1000);
    this.settle();
  }

  /** `clockMs` stamps frame arrivals; it must be the clock advance() is driven by. */
  static create(options: MatchOptions, snapshot: FullSnapshot, clockMs: LocalClock = performanceNow): NetMirror {
    return new NetMirror(createMatch(options), snapshot, clockMs);
  }

  /** Queue a received frame (decoded immediately for latestAvatar/latestAck; applied on the playback clock). */
  push(frame: StateFrame): void {
    const d = frame.delta;
    if (d.tick <= this.newestTick) return;
    this.newestTick = d.tick;
    this.newestTime = d.time;
    this.newestAcks = frame.acks;
    const fields = d.w;
    if (fields && typeof fields[0] === 'number' && (fields[0] & (1 << BOSS_FIELD))) {
      let at = 1;
      for (let i = 0; i < BOSS_FIELD; i++) if (fields[0] & (1 << i)) at++;
      this.newestBoss = bossFromWire(fields[at]);
    }
    const avatars = d.ents?.avatars;
    if (avatars) applyRows(this.newestAvatars, AVATARS.fieldCount, avatars);
    this.queue.push(frame);
    this.clock.note(d.time, this.clockMs() / 1000);
    if (this.queue.length === 1) this.motion.aim(d);
  }

  /**
   * Once per render frame (`nowMs`: performance.now()): apply frames due on the playback clock,
   * then interpolate remote positions.
   */
  advance(nowMs: number): void {
    const pt = this.clock.time(nowMs / 1000);
    const q = this.queue;
    if (q.length > 0 && q[0].delta.time <= pt) {
      this.motion.restore(this.world);
      while (q.length > 0 && q[0].delta.time <= pt) {
        const frame = q.shift();
        if (frame) this.apply(frame);
      }
      this.settle();
    }
    this.world.time = this.motion.blend(this.world, pt);
  }

  /**
   * Apply every queued frame now, without interpolation: after the tab was hidden for a while,
   * or headless (tests, tools) where no render clock exists.
   */
  catchUp(): void {
    if (this.queue.length === 0) return;
    this.motion.restore(this.world);
    for (const frame of this.queue) this.apply(frame);
    this.queue.length = 0;
    this.settle();
    this.world.time = this.appliedTime;
  }

  /** The locally predicted avatar (skipped by interpolation; its transform is the predictor's), or null. */
  setPredicted(avatarId: EntityId | null): void {
    if (avatarId === this.predicted) return;
    const prev = this.predicted;
    this.predicted = avatarId;
    if (avatarId !== null) this.motion.forget('avatars', avatarId);
    // Handing an avatar back to replication: snap it to the host's pose.
    const row = prev === null ? undefined : this.rows.avatars.get(prev);
    if (prev !== null && row) AVATARS.write(this.world, prev, row, PREDICTED_MASK);
  }

  /** Authoritative kinematics of an avatar as of the newest pushed frame, or null if never seen. */
  latestAvatar(id: EntityId): AvatarKinematics | null {
    const row = this.newestAvatars.get(id);
    if (!row) return null;
    readAvatarRow(this.kinematics, row, this.world);
    return this.kinematics;
  }

  /** Latest authoritative boss for local collision, ahead of visual playback. */
  latestBoss(): BossState | null { return this.newestBoss; }

  /** Last input seq the host consumed for a player as of the newest pushed frame (0 if none). */
  latestAck(playerId: string): number {
    return this.newestAcks[playerId] ?? 0;
  }

  /** Host world.time of the newest pushed frame (the snapshot's before any frame). */
  latestTime(): number {
    return this.newestTime;
  }

  /** Host world.tick of the newest pushed frame (the snapshot's before any frame). */
  latestTick(): number {
    return this.newestTick;
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  /** Replace createMatch's own dynamic state with the snapshot's. Emits nothing. */
  private load(snap: FullSnapshot): void {
    const w = this.world;
    // Shapes go first, while economy scratch still lists the ids createMatch registered.
    for (const p of Array.from(w.pieces.values())) detachPiece(w, p);
    for (const b of Array.from(w.buildings.values())) {
      w.buildings.delete(b.id);
      registerBuildingShape(w, b);
    }
    for (const kind of ENTITY_KINDS) {
      const codec = CODECS[kind];
      for (const id of Array.from(codec.ids(w))) codec.despawn(w, id);
    }
    // Systems never step on a mirror: only replicated state (and what it registers) remains.
    w.scratch = {};
    w.drainEvents();

    for (const node of snap.flips) w.lattice.flip(node);
    for (const kind of ENTITY_KINDS) for (const row of snap.ents[kind]) this.add(kind, row);
    snap.fac.forEach((row, f) => {
      const fac = w.factions[f];
      if (!fac) return;
      this.factionRows[f] = row.slice();
      writeRow(FACTION_FIELDS, fac, w, row, FACTION_MASK_ALL);
    });
    this.syncHumanSeats();
    this.worldRow = snap.w.slice();
    writeRow(WORLD_FIELDS, w, w, this.worldRow, WORLD_MASK_ALL);
    this.loadSurvey(snap.survey);
    w.tick = snap.tick;
    w.time = snap.time;
    syncEffigy(w);
    syncScenery(w);
  }

  private loadSurvey(sv: SurveySnapshot): void {
    const s = this.world.survey;
    s.dirty = false;
    s.version = sv.version;
    for (let f = 0; f < s.surveySize.length; f++) s.surveySize[f] = sv.sizes[f] ?? 0;
    s.focusNodes.length = 0;
    for (const n of sv.focus) s.focusNodes.push(n);
    // Zeno observation is host-only; clear what createMatch computed so nothing stale lingers.
    for (let i = 0; i < s.nodeObserved.length; i++) s.nodeObserved[i] = 0;
    for (const spec of SURVEY_ARRAYS) {
      const arr = spec.get(s);
      const fill = spec.fill / spec.scale;
      for (let i = 0; i < arr.length; i++) arr[i] = fill;
      const pairs = sv.arr[spec.key] ?? [];
      for (let k = 0; k + 1 < pairs.length; k += 2) arr[pairs[k]] = pairs[k + 1] / spec.scale;
    }
  }

  // ── Frames ─────────────────────────────────────────────────────────────────

  private apply(frame: StateFrame): void {
    const d = frame.delta;
    if (d.tick <= this.appliedTick) return;
    const w = this.world;

    // Flips and new pieces in event order: a piece's shapes stand on the lattice it was built
    // on, which a flip later in the same frame must not move under it.
    const flips = d.flips ?? NO_FLIPS;
    let fi = 0;
    const newPieces = this.newPieces;
    newPieces.clear();
    for (const row of d.ents?.pieces?.a ?? NO_ROWS) {
      const id = row[0];
      if (typeof id === 'number') newPieces.set(id, row);
    }
    for (const e of frame.events) {
      if (e.t === 'phasonFlip' && fi < flips.length) w.lattice.flip(flips[fi++]);
      else if (e.t === 'pieceBuilt') {
        const row = newPieces.get(e.pieceId);
        if (!row) continue;
        newPieces.delete(e.pieceId);
        this.add('pieces', row);
      }
    }
    while (fi < flips.length) w.lattice.flip(flips[fi++]);

    for (const kind of ENTITY_KINDS) {
      const ed = d.ents?.[kind];
      if (ed) this.applyKind(kind, ed, newPieces);
    }
    if (d.fac) {
      this.applyFactions(d.fac);
      this.syncHumanSeats();
    }
    if (d.w) this.applyWorld(d.w);
    if (d.survey) this.applySurvey(d.survey);

    this.appliedTick = d.tick;
    this.appliedTime = d.time;
    w.tick = d.tick;
    w.time = d.time;
    syncEffigy(w);
    syncScenery(w);
    for (const e of frame.events) w.emit(e);
  }

  /** Durable faction ownership updates controls/visibility on existing peers as well as late joiners. */
  private syncHumanSeats(): void {
    this.world.options.humans = this.world.factions.filter((f) => f.isPlayer).map((f) => f.id);
  }

  /** Segment bookkeeping after frames applied (entities hold authoritative values). */
  private settle(): void {
    this.motion.capture(this.world, this.predicted, this.appliedTime);
    this.motion.aim(this.queue.length > 0 ? this.queue[0].delta : null);
  }

  private applyKind(kind: EntityKind, ed: EntityDelta, newPieces: Map<EntityId, Wire[]>): void {
    const w = this.world;
    if (ed.r) for (const id of ed.r) this.remove(kind, id);
    // Pieces announced by pieceBuilt were added in event order already.
    if (kind === 'pieces') for (const row of newPieces.values()) this.add(kind, row);
    else if (ed.a) for (const row of ed.a) this.add(kind, row);
    const u = ed.u;
    if (!u) return;
    const codec = CODECS[kind];
    const rows = this.rows[kind];
    for (let k = 0; k + 1 < u.length; ) {
      const id = u[k];
      const mask = u[k + 1];
      if (typeof id !== 'number' || typeof mask !== 'number') return;
      k += 2;
      const row = rows.get(id);
      for (let i = 0; i < codec.fieldCount; i++) {
        if ((mask & (1 << i)) === 0) continue;
        if (row) row[i] = u[k] ?? null;
        k++;
      }
      if (!row) continue;
      codec.write(w, id, row, mask & ~this.skip(kind, id));
      if (kind === 'buildings' && (mask & SHAPE_MASK) !== 0) {
        const b = w.buildings.get(id);
        if (b) registerBuildingShape(w, b);
      }
    }
  }

  private add(kind: EntityKind, row: readonly Wire[]): void {
    const id = row[0];
    if (typeof id !== 'number') return;
    if (this.rows[kind].has(id)) this.remove(kind, id);
    const w = this.world;
    const codec = CODECS[kind];
    const fields = row.slice(1);
    this.rows[kind].set(id, fields);
    codec.spawn(w, id);
    codec.write(w, id, fields, codec.all & ~this.skip(kind, id));
    if (kind === 'pieces') {
      const p = w.pieces.get(id);
      if (p) attachPiece(w, p);
    } else if (kind === 'buildings') {
      const b = w.buildings.get(id);
      if (b) registerBuildingShape(w, b);
    }
  }

  private remove(kind: EntityKind, id: EntityId): void {
    const w = this.world;
    if (kind === 'pieces') {
      const p = w.pieces.get(id);
      if (p) detachPiece(w, p);
    } else if (kind === 'buildings') {
      const b = w.buildings.get(id);
      w.buildings.delete(id);
      if (b) registerBuildingShape(w, b);
    } else {
      CODECS[kind].despawn(w, id);
    }
    this.rows[kind].delete(id);
  }

  /** Fields client prediction owns, which replication must not write. */
  private skip(kind: EntityKind, id: EntityId): number {
    return kind === 'avatars' && id === this.predicted ? PREDICTED_MASK : 0;
  }

  private applyFactions(fac: readonly Wire[]): void {
    const w = this.world;
    for (let k = 0; k + 1 < fac.length; ) {
      const f = fac[k];
      const mask = fac[k + 1];
      if (typeof f !== 'number' || typeof mask !== 'number') return;
      k += 2;
      const row = this.factionRows[f];
      for (let i = 0; i < FACTION_FIELDS.length; i++) {
        if ((mask & (1 << i)) === 0) continue;
        if (row) row[i] = fac[k] ?? null;
        k++;
      }
      const state = w.factions[f];
      if (row && state) writeRow(FACTION_FIELDS, state, w, row, mask);
    }
  }

  private applyWorld(values: readonly Wire[]): void {
    const mask = values[0];
    if (typeof mask !== 'number') return;
    let k = 1;
    for (let i = 0; i < WORLD_FIELDS.length; i++) {
      if ((mask & (1 << i)) === 0) continue;
      this.worldRow[i] = values[k++] ?? null;
    }
    writeRow(WORLD_FIELDS, this.world, this.world, this.worldRow, mask);
  }

  private applySurvey(sv: SurveyDelta): void {
    const s = this.world.survey;
    s.version = sv.version;
    if (sv.sizes) for (let f = 0; f < s.surveySize.length; f++) s.surveySize[f] = sv.sizes[f] ?? 0;
    if (sv.focus) {
      s.focusNodes.length = 0;
      for (const n of sv.focus) s.focusNodes.push(n);
    }
    if (!sv.arr) return;
    for (const spec of SURVEY_ARRAYS) {
      const ch = sv.arr[spec.key];
      if (!ch || ch.length === 0) continue;
      const arr = spec.get(s);
      if (ch[0] === 1) {
        const n = Math.min(arr.length, ch.length - 1);
        for (let i = 0; i < n; i++) arr[i] = ch[i + 1] / spec.scale;
      } else {
        for (let k = 1; k + 1 < ch.length; k += 2) arr[ch[k]] = ch[k + 1] / spec.scale;
      }
    }
  }
}

/** Apply an entity delta to a bare row table (removals, additions, then updates). */
function applyRows(rows: Map<EntityId, Wire[]>, fieldCount: number, ed: EntityDelta): void {
  if (ed.r) for (const id of ed.r) rows.delete(id);
  if (ed.a) {
    for (const row of ed.a) {
      const id = row[0];
      if (typeof id === 'number') rows.set(id, row.slice(1));
    }
  }
  const u = ed.u;
  if (!u) return;
  for (let k = 0; k + 1 < u.length; ) {
    const id = u[k];
    const mask = u[k + 1];
    if (typeof id !== 'number' || typeof mask !== 'number') return;
    k += 2;
    const row = rows.get(id);
    for (let i = 0; i < fieldCount; i++) {
      if ((mask & (1 << i)) === 0) continue;
      if (row) row[i] = u[k] ?? null;
      k++;
    }
  }
}
