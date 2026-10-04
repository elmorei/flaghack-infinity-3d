/**
 * Replication schema: which fields of every entity kind, faction and world scalar travel from
 * the host to clients, in which order, and how they are quantized. Only what clients read
 * replicates (render/, ui/, game/, audio/ and the sim helpers they call); host-only data never
 * leaves the host: hippie brains and last-SOS times, Flag histories and planting times, avatar
 * movement inputs (sprint/throw-mode intent does replicate), hearth craft progress, collision shape ids (mirrors register their own), system
 * scratch and the RNG. Hippie velocities are not sent either: mirrors derive them from the
 * interpolated motion.
 *
 * Wire values are plain JSON. Quantized numbers travel as integers: positions and velocities
 * in cm, angles in mrad, times in ms, hp/attention/lumber/ritual/stats in tenths, fractions
 * (growth, construction, brewing) in thousandths. ±Infinity travels as 'inf' / '-inf'.
 * A row is the list of a record's wire values in field order; updates name the fields that
 * changed with a bitmask (bit i = field i).
 * Owner: NetCore agent.
 */
import type { SurveyState, World } from '../sim/world';
import { econ } from '../sim/systems/econ/state';
import { isFactionId } from '../sim/systems/rules/factions';
import { CHAKRAS, DRUGS, FACTION_IDS, JOBS, NEUTRAL } from '../sim/types';
import type {
  AbilityId,
  Avatar,
  AvatarAction,
  Building,
  BuildingKind,
  CaptureStage,
  ChakraId,
  Crystal,
  Difficulty,
  DroppedBeacon,
  DrugId,
  EffectKind,
  EntityId,
  FactionId,
  FactionState,
  FactionStats,
  Flag,
  FlagState,
  GccAction,
  Hippie,
  HippieOrder,
  HippieStatus,
  JobKind,
  MatchPhase,
  Owner,
  Personality,
  Pile,
  Piece,
  PieceKind,
  Ping,
  PingKind,
  Projectile,
  StatusEffect,
  Zone,
  ZoneKind,
} from '../sim/types';

/** A JSON value on the wire. */
export type Wire = number | string | boolean | null | Wire[];

// ── Quantization ─────────────────────────────────────────────────────────────

/** Positions, velocities, radii, pressure: centimetres (0.01). */
export const CM = 100;
/** Angles: milliradians (0.001 rad). */
export const MRAD = 1000;
/** Times: milliseconds (0.001 s). */
export const MS = 1000;
/** hp, attention, lumber, ritual, stats: tenths. */
export const TENTH = 10;
/** Fractions in 0..1 (growth, construction, brewing): thousandths. */
export const MILLI = 1000;

const INF = 'inf';
const NEG_INF = '-inf';

/** Finite numbers become integers in units of 1/scale; ±Infinity become strings (JSON has no Infinity). */
export function quant(v: number, scale: number): number | string {
  if (Number.isFinite(v)) return Math.round(v * scale);
  if (v === Infinity) return INF;
  if (v === -Infinity) return NEG_INF;
  return 0;
}

export function dequant(v: Wire, scale: number): number {
  if (typeof v === 'number') return v / scale;
  if (v === INF) return Infinity;
  if (v === NEG_INF) return -Infinity;
  return 0;
}

function int(v: Wire, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

function owner(v: Wire): Owner {
  return typeof v === 'number' && isFactionId(v) ? v : NEUTRAL;
}

function faction(v: Wire): FactionId {
  return typeof v === 'number' && isFactionId(v) ? v : 0;
}

function optFaction(v: Wire): FactionId | null {
  return typeof v === 'number' && isFactionId(v) ? v : null;
}

function ints(v: Wire): number[] {
  const out: number[] = [];
  if (Array.isArray(v)) for (const x of v) if (typeof x === 'number') out.push(x);
  return out;
}

function list(v: Wire): Wire[] {
  return Array.isArray(v) ? v : [];
}

/** Every key of an exhaustive Record, typed (the Record makes the compiler check the key set). */
function keysOf<K extends string>(r: Record<K, true>): readonly K[] {
  return Object.keys(r).filter((k): k is K => k in r);
}

function oneOf<T extends string>(v: Wire, values: readonly T[]): v is T {
  return typeof v === 'string' && values.some((x) => x === v);
}

/** Deep equality of wire values. */
export function wireEqual(a: Wire, b: Wire): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!wireEqual(a[i], b[i])) return false;
  return true;
}

// ── Fields ───────────────────────────────────────────────────────────────────

/** One replicated field of a record type E (an entity, a faction or the world itself). */
export interface Field<E> {
  readonly key: string;
  /** Quantized wire value (compound fields allocate). */
  enc(e: E, world: World): Wire;
  /** Does the record still match the last-sent wire value? Never allocates. */
  same(e: E, prev: Wire, world: World): boolean;
  /** Write a wire value into the record (mirror side). */
  dec(e: E, v: Wire, world: World): void;
}

function num<E>(key: string, scale: number, get: (e: E) => number, put: (e: E, v: number) => void): Field<E> {
  return {
    key,
    enc: (e) => quant(get(e), scale),
    same: (e, prev) => quant(get(e), scale) === prev,
    dec: (e, v) => put(e, dequant(v, scale)),
  };
}

function idField<E>(key: string, get: (e: E) => number, put: (e: E, v: number) => void): Field<E> {
  return { key, enc: (e) => get(e), same: (e, prev) => get(e) === prev, dec: (e, v) => put(e, int(v, -1)) };
}

function bool<E>(key: string, get: (e: E) => boolean, put: (e: E, v: boolean) => void): Field<E> {
  return { key, enc: (e) => get(e), same: (e, prev) => get(e) === prev, dec: (e, v) => put(e, v === true) };
}

function text<E>(key: string, get: (e: E) => string, put: (e: E, v: string) => void): Field<E> {
  return { key, enc: (e) => get(e), same: (e, prev) => get(e) === prev, dec: (e, v) => put(e, typeof v === 'string' ? v : '') };
}

function choice<E, T extends string>(key: string, values: readonly T[], get: (e: E) => T, put: (e: E, v: T) => void): Field<E> {
  return {
    key,
    enc: (e) => get(e),
    same: (e, prev) => get(e) === prev,
    dec: (e, v) => {
      if (oneOf(v, values)) put(e, v);
    },
  };
}

function ownerField<E>(key: string, get: (e: E) => Owner, put: (e: E, v: Owner) => void): Field<E> {
  return { key, enc: (e) => get(e), same: (e, prev) => get(e) === prev, dec: (e, v) => put(e, owner(v)) };
}

function factionField<E>(key: string, get: (e: E) => FactionId, put: (e: E, v: FactionId) => void): Field<E> {
  return { key, enc: (e) => get(e), same: (e, prev) => get(e) === prev, dec: (e, v) => put(e, faction(v)) };
}

function optFactionField<E>(key: string, get: (e: E) => FactionId | null, put: (e: E, v: FactionId | null) => void): Field<E> {
  return { key, enc: (e) => get(e), same: (e, prev) => get(e) === prev, dec: (e, v) => put(e, optFaction(v)) };
}

/** An ordered list of ids (quiver, Hearths, pentacle, hallucinations). */
function idList<E>(key: string, get: (e: E, world: World) => readonly number[], put: (e: E, v: number[], world: World) => void): Field<E> {
  return {
    key,
    enc: (e, w) => get(e, w).slice(),
    same: (e, prev, w) => {
      const a = get(e, w);
      if (!Array.isArray(prev) || prev.length !== a.length) return false;
      for (let i = 0; i < a.length; i++) if (prev[i] !== a[i]) return false;
      return true;
    },
    dec: (e, v, w) => put(e, ints(v), w),
  };
}

/** A fixed-order tuple of quantized numbers read from a keyed record (cooldowns, drugs, stats…). */
function numTuple<E, K extends string>(
  key: string,
  keys: readonly K[],
  scale: number,
  get: (e: E) => Record<K, number>,
): Field<E> {
  return {
    key,
    enc: (e) => {
      const r = get(e);
      return keys.map((k) => quant(r[k], scale));
    },
    same: (e, prev) => {
      if (!Array.isArray(prev) || prev.length !== keys.length) return false;
      const r = get(e);
      for (let i = 0; i < keys.length; i++) if (prev[i] !== quant(r[keys[i]], scale)) return false;
      return true;
    },
    dec: (e, v) => {
      const r = get(e);
      const a = list(v);
      for (let i = 0; i < keys.length; i++) r[keys[i]] = dequant(a[i] ?? 0, scale);
    },
  };
}

function effectsField<E extends { effects: StatusEffect[] }>(): Field<E> {
  return {
    key: 'effects',
    enc: (e) => {
      const out: Wire[] = [];
      for (const fx of e.effects) out.push(fx.kind, quant(fx.until, MS), quant(fx.mag, MILLI), fx.source);
      return out;
    },
    same: (e, prev) => {
      const fxs = e.effects;
      if (!Array.isArray(prev) || prev.length !== fxs.length * 4) return false;
      for (let i = 0, k = 0; i < fxs.length; i++, k += 4) {
        const fx = fxs[i];
        if (prev[k] !== fx.kind || prev[k + 1] !== quant(fx.until, MS) || prev[k + 2] !== quant(fx.mag, MILLI) || prev[k + 3] !== fx.source) {
          return false;
        }
      }
      return true;
    },
    dec: (e, v) => {
      const a = list(v);
      e.effects.length = 0;
      for (let k = 0; k + 3 < a.length; k += 4) {
        const kind = a[k];
        if (oneOf(kind, EFFECT_KINDS)) e.effects.push({ kind, until: dequant(a[k + 1], MS), mag: dequant(a[k + 2], MILLI), source: int(a[k + 3], -1) });
      }
    },
  };
}

/** Write a decoded position into a {x, z} or {x, y, z} target. */
function xField<E>(get: (e: E) => { x: number }): Field<E> {
  return num('x', CM, (e) => get(e).x, (e, v) => {
    get(e).x = v;
  });
}

function zField<E>(get: (e: E) => { z: number }): Field<E> {
  return num('z', CM, (e) => get(e).z, (e, v) => {
    get(e).z = v;
  });
}

// ── Enumerations ─────────────────────────────────────────────────────────────

const FLAG_STATES = keysOf<FlagState>({ stock: true, carried: true, planted: true, loose: true, flying: true });
const EFFECT_KINDS = keysOf<EffectKind>({
  stun: true,
  knockback: true,
  march: true,
  exhausted: true,
  beacon: true,
  saffron: true,
  crash: true,
  overstimulated: true,
  wobble: true,
  psychosis: true,
  resonance: true,
});
const HIPPIE_STATUSES = keysOf<HippieStatus>({
  idle: true,
  walking: true,
  fetching: true,
  carrying: true,
  planting: true,
  pulling: true,
  stealing: true,
  chopping: true,
  hauling: true,
  building: true,
  repairing: true,
  fighting: true,
  tearing: true,
  drumming: true,
  defending: true,
  following: true,
  responding: true,
  distracted: true,
  fleeing: true,
  ko: true,
});
const BUILDING_KINDS = keysOf<BuildingKind>({ hearth: true, workshop: true, drumcircle: true, ward: true, druglab: true, gcc: true });
const PIECE_KINDS = keysOf<PieceKind>({ wall: true, floor: true, ramp: true });
const PILE_KINDS = keysOf<Pile['kind']>({ pallets: true, moop: true, lumber: true });
const ZONE_KINDS = keysOf<ZoneKind>({ stabilize: true, beacon: true, omega: true, phason: true });
const PING_KINDS = keysOf<PingKind>({ rally: true, attack: true, flag: true, sos: true, shot: true });
const CAPTURE_STAGES = keysOf<CaptureStage>({ safe: true, threatened: true, contained: true, contested: true, overwritten: true, captured: true });
const PERSONALITIES = keysOf<Personality>({ player: true, surveyor: true, raider: true, warden: true });
const DIFFICULTIES = keysOf<Difficulty>({ chill: true, normal: true, hard: true, vexillosaint: true });
const PHASES = keysOf<MatchPhase>({ playing: true, ended: true });
type CooldownKey = AbilityId | GccAction | 'retransmit';
const COOLDOWN_KEYS = keysOf<CooldownKey>({
  beacon: true,
  march: true,
  stabilize: true,
  phason: true,
  omega: true,
  gift: true,
  dialectics: true,
  simulacra: true,
  retransmit: true,
});
const STAT_KEYS = keysOf<keyof FactionStats>({
  flagsPlanted: true,
  flagsPulled: true,
  flagsStolen: true,
  facetsPeak: true,
  crystalsManifested: true,
  captures: true,
  hippiesRecruited: true,
  cmi: true,
});

function isJob(v: Wire): v is JobKind {
  return oneOf(v, JOBS);
}

function isChakra(v: Wire): v is ChakraId {
  return oneOf(v, CHAKRAS);
}

function isDrug(v: Wire): v is DrugId {
  return oneOf(v, DRUGS);
}

// ── Compound values ──────────────────────────────────────────────────────────

/** Avatar action: [kind, …parameters]. */
function actionWire(a: AvatarAction): Wire {
  switch (a.kind) {
    case 'idle':
      return ['idle'];
    case 'swing':
      return ['swing', quant(a.t, MS), a.hit];
    case 'plant':
      return ['plant', a.node, quant(a.t, MS)];
    case 'pull':
      return ['pull', a.flagId, quant(a.t, MS), quant(a.dur, MS)];
    case 'align':
      return ['align', a.chakra, quant(a.t, MS)];
    case 'channel':
      return ['channel', quant(a.t, MS), quant(a.dur, MS)];
  }
}

function actionSame(a: AvatarAction, p: Wire): boolean {
  if (!Array.isArray(p) || p[0] !== a.kind) return false;
  switch (a.kind) {
    case 'idle':
      return p.length === 1;
    case 'swing':
      return p[1] === quant(a.t, MS) && p[2] === a.hit;
    case 'plant':
      return p[1] === a.node && p[2] === quant(a.t, MS);
    case 'pull':
      return p[1] === a.flagId && p[2] === quant(a.t, MS) && p[3] === quant(a.dur, MS);
    case 'align':
      return p[1] === a.chakra && p[2] === quant(a.t, MS);
    case 'channel':
      return p[1] === quant(a.t, MS) && p[2] === quant(a.dur, MS);
  }
}

export function actionFrom(v: Wire): AvatarAction {
  const a = list(v);
  switch (a[0]) {
    case 'swing':
      return { kind: 'swing', t: dequant(a[1], MS), hit: a[2] === true };
    case 'plant':
      return { kind: 'plant', node: int(a[1], -1), t: dequant(a[2], MS) };
    case 'pull':
      return { kind: 'pull', flagId: int(a[1], -1), t: dequant(a[2], MS), dur: dequant(a[3], MS) };
    case 'align': {
      const chakra = a[1];
      return isChakra(chakra) ? { kind: 'align', chakra, t: dequant(a[2], MS) } : { kind: 'idle' };
    }
    case 'channel':
      return { kind: 'channel', what: 'dialectics', t: dequant(a[1], MS), dur: dequant(a[2], MS) };
    default:
      return { kind: 'idle' };
  }
}

/** Hippie order: [kind, …parameters], or null. */
function orderWire(o: HippieOrder | null): Wire {
  if (!o) return null;
  switch (o.kind) {
    case 'move':
      return ['move', quant(o.to.x, CM), quant(o.to.z, CM)];
    case 'pull':
      return ['pull', o.flagId];
    case 'plant':
      return ['plant', o.node];
    case 'gather':
      return ['gather', o.pileId];
    case 'defend':
      return ['defend', quant(o.at.x, CM), quant(o.at.z, CM)];
    case 'attack':
      return ['attack', o.target];
    case 'follow':
      return ['follow', o.avatarId];
    case 'push':
      return ['push', o.gccId, quant(o.to.x, CM), quant(o.to.z, CM)];
  }
}

function orderSame(o: HippieOrder | null, p: Wire): boolean {
  if (!o) return p === null;
  if (!Array.isArray(p) || p[0] !== o.kind) return false;
  switch (o.kind) {
    case 'move':
      return p[1] === quant(o.to.x, CM) && p[2] === quant(o.to.z, CM);
    case 'pull':
      return p[1] === o.flagId;
    case 'plant':
      return p[1] === o.node;
    case 'gather':
      return p[1] === o.pileId;
    case 'defend':
      return p[1] === quant(o.at.x, CM) && p[2] === quant(o.at.z, CM);
    case 'attack':
      return p[1] === o.target;
    case 'follow':
      return p[1] === o.avatarId;
    case 'push':
      return p[1] === o.gccId && p[2] === quant(o.to.x, CM) && p[3] === quant(o.to.z, CM);
  }
}

function orderFrom(v: Wire): HippieOrder | null {
  if (!Array.isArray(v)) return null;
  const at = (i: number) => ({ x: dequant(v[i], CM), z: dequant(v[i + 1], CM) });
  switch (v[0]) {
    case 'move':
      return { kind: 'move', to: at(1) };
    case 'pull':
      return { kind: 'pull', flagId: int(v[1], -1) };
    case 'plant':
      return { kind: 'plant', node: int(v[1], -1) };
    case 'gather':
      return { kind: 'gather', pileId: int(v[1], -1) };
    case 'defend':
      return { kind: 'defend', at: at(1) };
    case 'attack':
      return { kind: 'attack', target: int(v[1], -1) };
    case 'follow':
      return { kind: 'follow', avatarId: int(v[1], -1) };
    case 'push':
      return { kind: 'push', gccId: int(v[1], -1), to: at(2) };
    default:
      return null;
  }
}

/** Hearth: [stage, attacker, pressure 0..3 (cm units = hundredths), overwriteAt, founder, facet]. */
const hearthField: Field<Building> = {
  key: 'hearth',
  enc: (b) => {
    const h = b.hearth;
    if (!h) return null;
    const p = h.pressure;
    return [h.stage, h.attacker, quant(p[0], CM), quant(p[1], CM), quant(p[2], CM), quant(p[3], CM), quant(h.overwriteAt, MS), h.founder, h.facet];
  },
  same: (b, p) => {
    const h = b.hearth;
    if (!h) return p === null;
    if (!Array.isArray(p) || p.length !== 9) return false;
    const pr = h.pressure;
    return (
      p[0] === h.stage &&
      p[1] === h.attacker &&
      p[2] === quant(pr[0], CM) &&
      p[3] === quant(pr[1], CM) &&
      p[4] === quant(pr[2], CM) &&
      p[5] === quant(pr[3], CM) &&
      p[6] === quant(h.overwriteAt, MS) &&
      p[7] === h.founder &&
      p[8] === h.facet
    );
  },
  dec: (b, v) => {
    if (!Array.isArray(v)) {
      b.hearth = null;
      return;
    }
    const h = b.hearth ?? {
      stage: 'safe',
      attacker: null,
      pressure: { 0: 0, 1: 0, 2: 0, 3: 0 },
      overwriteAt: 0,
      founder: 0,
      craftProgress: 0,
      facet: -1,
    };
    const stage = v[0];
    if (oneOf(stage, CAPTURE_STAGES)) h.stage = stage;
    h.attacker = optFaction(v[1]);
    for (const f of FACTION_IDS) h.pressure[f] = dequant(v[2 + f], CM);
    h.overwriteAt = dequant(v[6], MS);
    h.founder = faction(v[7]);
    h.facet = int(v[8], -1);
    b.hearth = h;
  },
};

/** Drug Lab: [brewing, progress, queue]. */
const labField: Field<Building> = {
  key: 'lab',
  enc: (b) => (b.lab ? [b.lab.brewing, quant(b.lab.progress, MILLI), b.lab.queue.slice()] : null),
  same: (b, p) => {
    const lab = b.lab;
    if (!lab) return p === null;
    if (!Array.isArray(p) || p[0] !== lab.brewing || p[1] !== quant(lab.progress, MILLI)) return false;
    const q = p[2];
    if (!Array.isArray(q) || q.length !== lab.queue.length) return false;
    for (let i = 0; i < q.length; i++) if (q[i] !== lab.queue[i]) return false;
    return true;
  },
  dec: (b, v) => {
    if (!Array.isArray(v)) {
      b.lab = null;
      return;
    }
    const lab = b.lab ?? { brewing: null, progress: 0, queue: [] };
    const brewing = v[0];
    lab.brewing = isDrug(brewing) ? brewing : null;
    lab.progress = dequant(v[1], MILLI);
    lab.queue.length = 0;
    for (const d of list(v[2])) if (isDrug(d)) lab.queue.push(d);
    b.lab = lab;
  },
};

/** GCC: [destroyedUntil, channelUntil, pushedBy]. */
const gccField: Field<Building> = {
  key: 'gcc',
  enc: (b) => (b.gcc ? [quant(b.gcc.destroyedUntil, MS), quant(b.gcc.channelUntil, MS), b.gcc.pushedBy] : null),
  same: (b, p) => {
    const g = b.gcc;
    if (!g) return p === null;
    return Array.isArray(p) && p[0] === quant(g.destroyedUntil, MS) && p[1] === quant(g.channelUntil, MS) && p[2] === g.pushedBy;
  },
  dec: (b, v) => {
    if (!Array.isArray(v)) {
      b.gcc = null;
      return;
    }
    const g = b.gcc ?? { destroyedUntil: 0, channelUntil: 0, pushedBy: -1 };
    g.destroyedUntil = dequant(v[0], MS);
    g.channelUntil = dequant(v[1], MS);
    g.pushedBy = int(v[2], -1);
    b.gcc = g;
  },
};

// ── Entity kinds ─────────────────────────────────────────────────────────────

export type EntityKind =
  | 'flags'
  | 'avatars'
  | 'hippies'
  | 'buildings'
  | 'pieces'
  | 'piles'
  | 'crystals'
  | 'projectiles'
  | 'zones'
  | 'pings'
  | 'beacons';

/** Type-erased replication operations for one entity kind (rows are wire values in field order). */
export interface EntityCodec {
  readonly kind: EntityKind;
  readonly fieldCount: number;
  /** Field keys in row order (diagnostics). */
  readonly keys: readonly string[];
  /** Mask with every field set. */
  readonly all: number;
  /** Index of a field by key (throws on a typo: a programming error caught at module load). */
  index(key: string): number;
  ids(world: World): IterableIterator<EntityId>;
  has(world: World, id: EntityId): boolean;
  /** Host: every field of a live entity, quantized. */
  row(world: World, id: EntityId): Wire[];
  /**
   * Host: compare a live entity with its last-sent row; changed values are appended to `out`
   * (in field order) and written into `prev`. Returns the mask of changed fields (0: none).
   */
  diff(world: World, id: EntityId, prev: Wire[], out: Wire[]): number;
  /** Mirror: insert a blank entity (its fields are written next). */
  spawn(world: World, id: EntityId): void;
  /** Mirror: materialize the fields in `mask` from a wire row. */
  write(world: World, id: EntityId, row: readonly Wire[], mask: number): void;
  despawn(world: World, id: EntityId): void;
}

export function encodeRow<E>(fields: readonly Field<E>[], e: E, world: World): Wire[] {
  const row: Wire[] = [];
  for (const f of fields) row.push(f.enc(e, world));
  return row;
}

export function diffRow<E>(fields: readonly Field<E>[], e: E, world: World, prev: Wire[], out: Wire[]): number {
  let mask = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.same(e, prev[i], world)) continue;
    const v = f.enc(e, world);
    prev[i] = v;
    out.push(v);
    mask |= 1 << i;
  }
  return mask;
}

export function writeRow<E>(fields: readonly Field<E>[], e: E, world: World, row: readonly Wire[], mask: number): void {
  for (let i = 0; i < fields.length; i++) if (mask & (1 << i)) fields[i].dec(e, row[i] ?? null, world);
}

function fieldIndex<E>(fields: readonly Field<E>[], key: string, what: string): number {
  const i = fields.findIndex((f) => f.key === key);
  if (i < 0) throw new Error(`${what} has no replicated field '${key}'`);
  return i;
}

function entityCodec<E extends { id: EntityId }>(
  kind: EntityKind,
  map: (w: World) => Map<EntityId, E>,
  blank: (id: EntityId) => E,
  fields: readonly Field<E>[],
): EntityCodec {
  if (fields.length > 30) throw new Error(`${kind}: too many replicated fields for a 31-bit mask`);
  return {
    kind,
    fieldCount: fields.length,
    keys: fields.map((f) => f.key),
    all: (1 << fields.length) - 1,
    index: (key) => fieldIndex(fields, key, kind),
    ids: (w) => map(w).keys(),
    has: (w, id) => map(w).has(id),
    row: (w, id) => {
      const e = map(w).get(id);
      return e ? encodeRow(fields, e, w) : [];
    },
    diff: (w, id, prev, out) => {
      const e = map(w).get(id);
      return e ? diffRow(fields, e, w, prev, out) : 0;
    },
    spawn: (w, id) => {
      map(w).set(id, blank(id));
    },
    write: (w, id, row, mask) => {
      const e = map(w).get(id);
      if (e) writeRow(fields, e, w, row, mask);
    },
    despawn: (w, id) => {
      map(w).delete(id);
    },
  };
}

const FLAG_FIELDS: readonly Field<Flag>[] = [
  choice('state', FLAG_STATES, (f) => f.state, (f, v) => {
    f.state = v;
  }),
  ownerField('owner', (f) => f.owner, (f, v) => {
    f.owner = v;
  }),
  idField('holder', (f) => f.holder, (f, v) => {
    f.holder = v;
  }),
  idField('node', (f) => f.node, (f, v) => {
    f.node = v;
  }),
  xField((f) => f.pos),
  num('y', CM, (f) => f.pos.y, (f, v) => {
    f.pos.y = v;
  }),
  zField((f) => f.pos),
  idField('altNode', (f) => f.altNode, (f, v) => {
    f.altNode = v;
  }),
  num('tilt', CM, (f) => f.tilt, (f, v) => {
    f.tilt = v;
  }),
];

const AVATAR_FIELDS: readonly Field<Avatar>[] = [
  factionField('faction', (a) => a.faction, (a, v) => {
    a.faction = v;
  }),
  xField((a) => a.pos),
  num('y', CM, (a) => a.pos.y, (a, v) => {
    a.pos.y = v;
  }),
  zField((a) => a.pos),
  num('vx', CM, (a) => a.vel.x, (a, v) => {
    a.vel.x = v;
  }),
  num('vy', CM, (a) => a.vel.y, (a, v) => {
    a.vel.y = v;
  }),
  num('vz', CM, (a) => a.vel.z, (a, v) => {
    a.vel.z = v;
  }),
  num('yaw', MRAD, (a) => a.yaw, (a, v) => {
    a.yaw = v;
  }),
  num('pitch', MRAD, (a) => a.pitch, (a, v) => {
    a.pitch = v;
  }),
  bool('onGround', (a) => a.onGround, (a, v) => {
    a.onGround = v;
  }),
  num('hp', TENTH, (a) => a.hp, (a, v) => {
    a.hp = v;
  }),
  num('lastHurtAt', MS, (a) => a.lastHurtAt, (a, v) => {
    a.lastHurtAt = v;
  }),
  num('koUntil', MS, (a) => a.koUntil, (a, v) => {
    a.koUntil = v;
  }),
  idList('carried', (a) => a.carried, (a, v) => {
    a.carried.length = 0;
    for (const id of v) a.carried.push(id);
  }),
  {
    key: 'action',
    enc: (a) => actionWire(a.action),
    same: (a, p) => actionSame(a.action, p),
    dec: (a, v) => {
      a.action = actionFrom(v);
    },
  },
  num('throwReadyAt', MS, (a) => a.throwReadyAt, (a, v) => {
    a.throwReadyAt = v;
  }),
  effectsField<Avatar>(),
  idField('pushing', (a) => a.pushing, (a, v) => {
    a.pushing = v;
  }),
  bool('sprint', (a) => a.input.sprint, (a, v) => {
    a.input.sprint = v;
  }),
  bool('throwMode', (a) => a.input.throwMode === true, (a, v) => {
    a.input.throwMode = v;
  }),
];

const HIPPIE_FIELDS: readonly Field<Hippie>[] = [
  ownerField('faction', (h) => h.faction, (h, v) => {
    h.faction = v;
  }),
  text('name', (h) => h.name, (h, v) => {
    h.name = v;
  }),
  idField('look', (h) => h.look, (h, v) => {
    h.look = v;
  }),
  xField((h) => h.pos),
  zField((h) => h.pos),
  num('facing', MRAD, (h) => h.facing, (h, v) => {
    h.facing = v;
  }),
  num('hp', TENTH, (h) => h.hp, (h, v) => {
    h.hp = v;
  }),
  num('attention', TENTH, (h) => h.attention, (h, v) => {
    h.attention = v;
  }),
  num('koUntil', MS, (h) => h.koUntil, (h, v) => {
    h.koUntil = v;
  }),
  {
    key: 'job',
    enc: (h) => h.job,
    same: (h, p) => h.job === p,
    dec: (h, v) => {
      h.job = isJob(v) ? v : null;
    },
  },
  {
    key: 'order',
    enc: (h) => orderWire(h.order),
    same: (h, p) => orderSame(h.order, p),
    dec: (h, v) => {
      h.order = orderFrom(v);
    },
  },
  choice('status', HIPPIE_STATUSES, (h) => h.status, (h, v) => {
    h.status = v;
  }),
  {
    key: 'statusTarget',
    enc: (h) => (h.statusTarget ? [quant(h.statusTarget.x, CM), quant(h.statusTarget.z, CM)] : null),
    same: (h, p) => {
      const t = h.statusTarget;
      if (!t) return p === null;
      return Array.isArray(p) && p[0] === quant(t.x, CM) && p[1] === quant(t.z, CM);
    },
    dec: (h, v) => {
      h.statusTarget = Array.isArray(v) ? { x: dequant(v[0], CM), z: dequant(v[1], CM) } : null;
    },
  },
  idField('carryingFlag', (h) => h.carryingFlag, (h, v) => {
    h.carryingFlag = v;
  }),
  num('carryingLumber', TENTH, (h) => h.carryingLumber, (h, v) => {
    h.carryingLumber = v;
  }),
  bool('beacon', (h) => h.beacon, (h, v) => {
    h.beacon = v;
  }),
  effectsField<Hippie>(),
];

const BUILDING_FIELDS: readonly Field<Building>[] = [
  choice('kind', BUILDING_KINDS, (b) => b.kind, (b, v) => {
    b.kind = v;
  }),
  ownerField('faction', (b) => b.faction, (b, v) => {
    b.faction = v;
  }),
  xField((b) => b.pos),
  zField((b) => b.pos),
  num('yaw', MRAD, (b) => b.yaw, (b, v) => {
    b.yaw = v;
  }),
  idField('facet', (b) => b.facet, (b, v) => {
    b.facet = v;
  }),
  num('hp', TENTH, (b) => b.hp, (b, v) => {
    b.hp = v;
  }),
  num('maxHp', TENTH, (b) => b.maxHp, (b, v) => {
    b.maxHp = v;
  }),
  num('built', MILLI, (b) => b.built, (b, v) => {
    b.built = v;
  }),
  bool('disabled', (b) => b.disabled, (b, v) => {
    b.disabled = v;
  }),
  num('progress', CM, (b) => b.progress, (b, v) => {
    b.progress = v;
  }),
  hearthField,
  labField,
  gccField,
];

const PIECE_FIELDS: readonly Field<Piece>[] = [
  choice('kind', PIECE_KINDS, (p) => p.kind, (p, v) => {
    p.kind = v;
  }),
  ownerField('faction', (p) => p.faction, (p, v) => {
    p.faction = v;
  }),
  idField('edge', (p) => p.edge, (p, v) => {
    p.edge = v;
  }),
  idField('facet', (p) => p.facet, (p, v) => {
    p.facet = v;
  }),
  idField('level', (p) => p.level, (p, v) => {
    p.level = v;
  }),
  idField('rampEdge', (p) => p.rampEdge, (p, v) => {
    p.rampEdge = v;
  }),
  num('hp', TENTH, (p) => p.hp, (p, v) => {
    p.hp = v;
  }),
  num('maxHp', TENTH, (p) => p.maxHp, (p, v) => {
    p.maxHp = v;
  }),
  num('builtAt', MS, (p) => p.builtAt, (p, v) => {
    p.builtAt = v;
  }),
];

const PILE_FIELDS: readonly Field<Pile>[] = [
  choice('kind', PILE_KINDS, (p) => p.kind, (p, v) => {
    p.kind = v;
  }),
  xField((p) => p.pos),
  zField((p) => p.pos),
  num('lumber', TENTH, (p) => p.lumber, (p, v) => {
    p.lumber = v;
  }),
  num('max', TENTH, (p) => p.max, (p, v) => {
    p.max = v;
  }),
];

const CRYSTAL_FIELDS: readonly Field<Crystal>[] = [
  idField('node', (c) => c.node, (c, v) => {
    c.node = v;
  }),
  factionField('faction', (c) => c.faction, (c, v) => {
    c.faction = v;
  }),
  xField((c) => c.pos),
  zField((c) => c.pos),
  num('bornAt', MS, (c) => c.bornAt, (c, v) => {
    c.bornAt = v;
  }),
  num('growth', MILLI, (c) => c.growth, (c, v) => {
    c.growth = v;
  }),
  idList('pentacle', (c) => c.pentacle, (c, v) => {
    c.pentacle = v;
  }),
];

const PROJECTILE_FIELDS: readonly Field<Projectile>[] = [
  idField('flagId', (p) => p.flagId, (p, v) => {
    p.flagId = v;
  }),
  idField('thrower', (p) => p.thrower, (p, v) => {
    p.thrower = v;
  }),
  factionField('faction', (p) => p.faction, (p, v) => {
    p.faction = v;
  }),
  xField((p) => p.pos),
  num('y', CM, (p) => p.pos.y, (p, v) => {
    p.pos.y = v;
  }),
  zField((p) => p.pos),
  num('vx', CM, (p) => p.vel.x, (p, v) => {
    p.vel.x = v;
  }),
  num('vy', CM, (p) => p.vel.y, (p, v) => {
    p.vel.y = v;
  }),
  num('vz', CM, (p) => p.vel.z, (p, v) => {
    p.vel.z = v;
  }),
  num('bornAt', MS, (p) => p.bornAt, (p, v) => {
    p.bornAt = v;
  }),
];

const ZONE_FIELDS: readonly Field<Zone>[] = [
  choice('kind', ZONE_KINDS, (z) => z.kind, (z, v) => {
    z.kind = v;
  }),
  factionField('faction', (z) => z.faction, (z, v) => {
    z.faction = v;
  }),
  xField((z) => z.pos),
  zField((z) => z.pos),
  num('radius', CM, (z) => z.radius, (z, v) => {
    z.radius = v;
  }),
  num('bornAt', MS, (z) => z.bornAt, (z, v) => {
    z.bornAt = v;
  }),
  num('until', MS, (z) => z.until, (z, v) => {
    z.until = v;
  }),
  idField('level', (z) => z.level, (z, v) => {
    z.level = v;
  }),
  idField('target', (z) => z.target, (z, v) => {
    z.target = v;
  }),
];

const PING_FIELDS: readonly Field<Ping>[] = [
  choice('kind', PING_KINDS, (p) => p.kind, (p, v) => {
    p.kind = v;
  }),
  factionField('faction', (p) => p.faction, (p, v) => {
    p.faction = v;
  }),
  xField((p) => p.pos),
  zField((p) => p.pos),
  idField('from', (p) => p.from, (p, v) => {
    p.from = v;
  }),
  num('bornAt', MS, (p) => p.bornAt, (p, v) => {
    p.bornAt = v;
  }),
  num('until', MS, (p) => p.until, (p, v) => {
    p.until = v;
  }),
];

const BEACON_FIELDS: readonly Field<DroppedBeacon>[] = [
  factionField('faction', (b) => b.faction, (b, v) => {
    b.faction = v;
  }),
  xField((b) => b.pos),
  zField((b) => b.pos),
  num('until', MS, (b) => b.until, (b, v) => {
    b.until = v;
  }),
];

// Blank mirror entities: every field the schema does not replicate keeps these defaults.

function blankFlag(id: EntityId): Flag {
  return {
    id,
    type: 'flag',
    state: 'stock',
    owner: NEUTRAL,
    holder: -1,
    node: -1,
    pos: { x: 0, y: 0, z: 0 },
    altNode: -1,
    plantedAt: 0,
    lastMovedAt: 0,
    history: [],
    tilt: 0,
  };
}

export function blankAvatar(id: EntityId): Avatar {
  return {
    id,
    type: 'avatar',
    faction: 0,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    hp: 0,
    lastHurtAt: 0,
    koUntil: 0,
    carried: [],
    action: { kind: 'idle' },
    input: { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 },
    throwReadyAt: 0,
    effects: [],
    pushing: -1,
  };
}

function blankHippie(id: EntityId): Hippie {
  return {
    id,
    type: 'hippie',
    faction: NEUTRAL,
    name: '',
    look: 0,
    pos: { x: 0, z: 0 },
    vel: { x: 0, z: 0 },
    facing: 0,
    hp: 0,
    attention: 0,
    koUntil: 0,
    job: null,
    order: null,
    status: 'idle',
    statusTarget: null,
    carryingFlag: -1,
    carryingLumber: 0,
    beacon: false,
    effects: [],
    lastSosAt: -999,
    brain: {},
  };
}

function blankBuilding(id: EntityId): Building {
  return {
    id,
    type: 'building',
    kind: 'workshop',
    faction: NEUTRAL,
    pos: { x: 0, z: 0 },
    yaw: 0,
    facet: -1,
    hp: 0,
    maxHp: 0,
    built: 0,
    disabled: false,
    progress: 0,
    hearth: null,
    lab: null,
    gcc: null,
  };
}

function blankPiece(id: EntityId): Piece {
  return { id, type: 'piece', kind: 'wall', faction: NEUTRAL, edge: -1, facet: -1, level: 0, rampEdge: -1, hp: 0, maxHp: 0, builtAt: 0, shapeIds: [] };
}

function blankPile(id: EntityId): Pile {
  return { id, type: 'pile', kind: 'pallets', pos: { x: 0, z: 0 }, lumber: 0, max: 0 };
}

function blankCrystal(id: EntityId): Crystal {
  return { id, type: 'crystal', node: -1, faction: 0, pos: { x: 0, z: 0 }, bornAt: 0, growth: 0, pentacle: [] };
}

function blankProjectile(id: EntityId): Projectile {
  return { id, type: 'projectile', flagId: -1, thrower: -1, faction: 0, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, bornAt: 0 };
}

function blankZone(id: EntityId): Zone {
  return { id, type: 'zone', kind: 'stabilize', faction: 0, pos: { x: 0, z: 0 }, radius: 0, bornAt: 0, until: 0, level: 0, target: -1 };
}

function blankPing(id: EntityId): Ping {
  return { id, type: 'ping', kind: 'rally', faction: 0, pos: { x: 0, z: 0 }, from: -1, bornAt: 0, until: 0 };
}

function blankBeacon(id: EntityId): DroppedBeacon {
  return { id, type: 'beacon', faction: 0, pos: { x: 0, z: 0 }, until: 0 };
}

export const CODECS: Record<EntityKind, EntityCodec> = {
  flags: entityCodec('flags', (w) => w.flags, blankFlag, FLAG_FIELDS),
  avatars: entityCodec('avatars', (w) => w.avatars, blankAvatar, AVATAR_FIELDS),
  hippies: entityCodec('hippies', (w) => w.hippies, blankHippie, HIPPIE_FIELDS),
  buildings: entityCodec('buildings', (w) => w.buildings, blankBuilding, BUILDING_FIELDS),
  pieces: entityCodec('pieces', (w) => w.pieces, blankPiece, PIECE_FIELDS),
  piles: entityCodec('piles', (w) => w.piles, blankPile, PILE_FIELDS),
  crystals: entityCodec('crystals', (w) => w.crystals, blankCrystal, CRYSTAL_FIELDS),
  projectiles: entityCodec('projectiles', (w) => w.projectiles, blankProjectile, PROJECTILE_FIELDS),
  zones: entityCodec('zones', (w) => w.zones, blankZone, ZONE_FIELDS),
  pings: entityCodec('pings', (w) => w.pings, blankPing, PING_FIELDS),
  beacons: entityCodec('beacons', (w) => w.beacons, blankBeacon, BEACON_FIELDS),
};

/** Kinds in the order frames apply them. */
export const ENTITY_KINDS: readonly EntityKind[] = [
  'buildings',
  'pieces',
  'piles',
  'avatars',
  'hippies',
  'flags',
  'crystals',
  'projectiles',
  'zones',
  'pings',
  'beacons',
];

/** A record holding one value per entity kind. */
export function perKind<T>(make: (kind: EntityKind) => T): Record<EntityKind, T> {
  return {
    flags: make('flags'),
    avatars: make('avatars'),
    hippies: make('hippies'),
    buildings: make('buildings'),
    pieces: make('pieces'),
    piles: make('piles'),
    crystals: make('crystals'),
    projectiles: make('projectiles'),
    zones: make('zones'),
    pings: make('pings'),
    beacons: make('beacons'),
  };
}

/** Decode a full avatar row into `av` (client prediction reads the host's newest avatar state). */
export function readAvatarRow(av: Avatar, row: readonly Wire[], world: World): void {
  writeRow(AVATAR_FIELDS, av, world, row, CODECS.avatars.all);
}

// ── Factions ─────────────────────────────────────────────────────────────────

export const FACTION_FIELDS: readonly Field<FactionState>[] = [
  text('name', (f) => f.name, (f, v) => {
    f.name = v;
  }),
  text('title', (f) => f.title, (f, v) => {
    f.title = v;
  }),
  idField('color', (f) => f.color, (f, v) => {
    f.color = v;
  }),
  text('css', (f) => f.css, (f, v) => {
    f.css = v;
  }),
  choice('personality', PERSONALITIES, (f) => f.personality, (f, v) => {
    f.personality = v;
  }),
  bool('isPlayer', (f) => f.isPlayer, (f, v) => {
    f.isPlayer = v;
  }),
  choice('difficulty', DIFFICULTIES, (f) => f.difficulty, (f, v) => {
    f.difficulty = v;
  }),
  bool('alive', (f) => f.alive, (f, v) => {
    f.alive = v;
  }),
  {
    key: 'eliminatedAt',
    enc: (f) => (f.eliminatedAt === null ? null : quant(f.eliminatedAt, MS)),
    same: (f, p) => (f.eliminatedAt === null ? p === null : quant(f.eliminatedAt, MS) === p),
    dec: (f, v) => {
      f.eliminatedAt = v === null ? null : dequant(v, MS);
    },
  },
  optFactionField('eliminatedBy', (f) => f.eliminatedBy, (f, v) => {
    f.eliminatedBy = v;
  }),
  idField('avatarId', (f) => f.avatarId, (f, v) => {
    f.avatarId = v;
  }),
  {
    key: 'gccId',
    enc: (f) => f.gccId,
    same: (f, p) => f.gccId === p,
    dec: (f, v) => {
      f.gccId = typeof v === 'number' ? v : null;
    },
  },
  idList('hearthIds', (f) => f.hearthIds, (f, v) => {
    f.hearthIds.length = 0;
    for (const id of v) f.hearthIds.push(id);
  }),
  num('lumber', TENTH, (f) => f.lumber, (f, v) => {
    f.lumber = v;
  }),
  num('ritual', TENTH, (f) => f.ritual, (f, v) => {
    f.ritual = v;
  }),
  {
    // The plan is a set: sent sorted, compared without regard to insertion order.
    key: 'plan',
    enc: (f) => Array.from(f.plan).sort((a, b) => a - b),
    same: (f, p) => {
      if (!Array.isArray(p) || p.length !== f.plan.size) return false;
      for (const n of p) if (typeof n !== 'number' || !f.plan.has(n)) return false;
      return true;
    },
    dec: (f, v) => {
      f.plan.clear();
      for (const n of ints(v)) f.plan.add(n);
    },
  },
  numTuple('jobWeights', JOBS, 1, (f) => f.jobWeights),
  numTuple('chakras', CHAKRAS, 1, (f) => f.chakras),
  numTuple('cooldowns', COOLDOWN_KEYS, MS, (f) => f.cooldowns),
  numTuple('drugs', DRUGS, 1, (f) => f.drugs),
  numTuple('drugActive', DRUGS, MS, (f) => f.drugActive),
  num('saffronCrashUntil', MS, (f) => f.saffronCrashUntil, (f, v) => {
    f.saffronCrashUntil = v;
  }),
  {
    // Partial record: [until or null per faction id].
    key: 'meshTap',
    enc: (f) => FACTION_IDS.map((r) => {
      const t = f.meshTap[r];
      return t === undefined ? null : quant(t, MS);
    }),
    same: (f, p) => {
      if (!Array.isArray(p) || p.length !== FACTION_IDS.length) return false;
      for (const r of FACTION_IDS) {
        const t = f.meshTap[r];
        if ((t === undefined ? null : quant(t, MS)) !== p[r]) return false;
      }
      return true;
    },
    dec: (f, v) => {
      const a = list(v);
      for (const r of FACTION_IDS) {
        const t = a[r] ?? null;
        if (t === null) delete f.meshTap[r];
        else f.meshTap[r] = dequant(t, MS);
      }
    },
  },
  numTuple('stats', STAT_KEYS, TENTH, (f) => f.stats),
  // Luminous Dust hallucinations are rolled by the host's drug system into economy scratch,
  // which drugs.falseFlags() reads; mirrors receive them into their own scratch.
  idList(
    'falseFlags',
    (f, w) => econ(w).falseFlags[f.id],
    (f, v, w) => {
      const out = econ(w).falseFlags[f.id];
      out.length = 0;
      for (const n of v) out.push(n);
    },
  ),
];

export const FACTION_MASK_ALL = (1 << FACTION_FIELDS.length) - 1;

// ── World scalars ────────────────────────────────────────────────────────────

export const WORLD_FIELDS: readonly Field<World>[] = [
  choice('phase', PHASES, (w) => w.phase, (w, v) => {
    w.phase = v;
  }),
  optFactionField('winner', (w) => w.winner, (w, v) => {
    w.winner = v;
  }),
  bool('suddenDeath', (w) => w.suddenDeath, (w, v) => {
    w.suddenDeath = v;
  }),
  num('tideNextAt', MS, (w) => w.tide.nextAt, (w, v) => {
    w.tide.nextAt = v;
  }),
  bool('tideWarned', (w) => w.tide.warned, (w, v) => {
    w.tide.warned = v;
  }),
  idField('tideCount', (w) => w.tide.count, (w, v) => {
    w.tide.count = v;
  }),
];

export const WORLD_MASK_ALL = (1 << WORLD_FIELDS.length) - 1;

// ── Survey arrays ────────────────────────────────────────────────────────────

/** Survey arrays clients read (nodeObserved is host-only: Zeno observation drives tides). */
export type SurveyArrayKey =
  | 'nodeFlagOwner'
  | 'nodeFlag'
  | 'impliedOwner'
  | 'impliedOrder'
  | 'holder'
  | 'edgeLey'
  | 'facetCrystal'
  | 'facetSurvey'
  | 'facetInstability';

export interface SurveyArraySpec {
  readonly key: SurveyArrayKey;
  /** Wire value = round(value × scale). */
  readonly scale: number;
  /** Fill value of a fresh match (full snapshots send only entries that differ from it). */
  readonly fill: number;
  get(s: SurveyState): Int8Array | Uint8Array | Int32Array | Float32Array;
}

export const SURVEY_ARRAYS: readonly SurveyArraySpec[] = [
  { key: 'nodeFlagOwner', scale: 1, fill: -1, get: (s) => s.nodeFlagOwner },
  { key: 'nodeFlag', scale: 1, fill: -1, get: (s) => s.nodeFlag },
  { key: 'impliedOwner', scale: 1, fill: -1, get: (s) => s.impliedOwner },
  { key: 'impliedOrder', scale: 1, fill: 0, get: (s) => s.impliedOrder },
  { key: 'holder', scale: 1, fill: -1, get: (s) => s.holder },
  { key: 'edgeLey', scale: 1, fill: -1, get: (s) => s.edgeLey },
  { key: 'facetCrystal', scale: 1, fill: -1, get: (s) => s.facetCrystal },
  { key: 'facetSurvey', scale: 1, fill: 0, get: (s) => s.facetSurvey },
  { key: 'facetInstability', scale: 100, fill: 0, get: (s) => s.facetInstability },
];
