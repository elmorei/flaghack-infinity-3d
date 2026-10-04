/**
 * Core simulation entity contracts. Every module reads these; keep them plain data
 * (no methods, no three.js, no DOM). Adding optional fields is fine; renaming/removing
 * fields breaks other modules: coordinate first.
 */
import type { V2, V3 } from './math';

export type EntityId = number;
export type FactionId = 0 | 1 | 2 | 3;
/** Faction id or NEUTRAL (-1). */
export type Owner = FactionId | -1;
export const NEUTRAL = -1 as const;
export const FACTION_IDS: readonly FactionId[] = [0, 1, 2, 3];

export type Personality = 'player' | 'surveyor' | 'raider' | 'warden';
export type Difficulty = 'chill' | 'normal' | 'hard' | 'vexillosaint';

export type ChakraId = 'hoist' | 'fly' | 'canton' | 'field' | 'finial';
export type AbilityId = 'beacon' | 'march' | 'stabilize' | 'phason' | 'omega';
export const CHAKRAS: readonly ChakraId[] = ['hoist', 'fly', 'canton', 'field', 'finial'];
export const CHAKRA_ABILITY: Record<ChakraId, AbilityId> = {
  hoist: 'beacon',
  fly: 'march',
  canton: 'stabilize',
  field: 'phason',
  finial: 'omega',
};
export type DrugId = 'saffron' | 'dust' | 'acidcop';
export const DRUGS: readonly DrugId[] = ['saffron', 'dust', 'acidcop'];

export type JobKind = 'survey' | 'gather' | 'defend' | 'raid' | 'ritual';
export const JOBS: readonly JobKind[] = ['survey', 'gather', 'defend', 'raid', 'ritual'];

export type BuildingKind = 'hearth' | 'workshop' | 'drumcircle' | 'ward' | 'druglab' | 'gcc';
export type PieceKind = 'wall' | 'floor' | 'ramp';
export type GccAction = 'dialectics' | 'simulacra';
export type PingKind = 'rally' | 'attack' | 'flag' | 'sos' | 'shot';

// ── Status effects ───────────────────────────────────────────────────────────
export type EffectKind =
  | 'stun' // cannot act or move
  | 'knockback' // being pushed (vel set by source)
  | 'march' // Forced March speed buff
  | 'exhausted' // post-march / crash slow
  | 'beacon' // Priority Beacon rush (+speed, forced target)
  | 'saffron' // Saffron buff
  | 'crash' // Saffron crash
  | 'overstimulated' // wanders off
  | 'wobble' // TAKE A SHOT stumble
  | 'psychosis' // Flag Psychosis (instability)
  | 'resonance'; // overlap resonance work buff
export interface StatusEffect {
  kind: EffectKind;
  until: number; // world.time when it ends
  mag: number; // magnitude (multiplier or amount, effect-specific)
  source: EntityId | -1;
}

// ── Factions ─────────────────────────────────────────────────────────────────
export interface FactionStats {
  flagsPlanted: number;
  flagsPulled: number;
  flagsStolen: number;
  facetsPeak: number;
  crystalsManifested: number;
  captures: number;
  hippiesRecruited: number;
  cmi: number;
}

export interface FactionState {
  id: FactionId;
  name: string;
  title: string;
  color: number;
  css: string;
  personality: Personality;
  isPlayer: boolean;
  alive: boolean;
  eliminatedAt: number | null;
  eliminatedBy: FactionId | null;
  avatarId: EntityId;
  gccId: EntityId | null;
  /** Hearths currently owned (main + captured outposts). */
  hearthIds: EntityId[];
  lumber: number;
  ritual: number;
  /** Personal Survey Pattern: planned node ids hippies fill. */
  plan: Set<number>;
  jobWeights: Record<JobKind, number>; // 0..4
  chakras: Record<ChakraId, number>; // level 0..3
  cooldowns: Record<AbilityId | GccAction | 'retransmit', number>; // world.time when ready
  drugs: Record<DrugId, number>; // doses in inventory
  /** Faction-wide drug timers: world.time when the effect ends (0 = inactive). */
  drugActive: Record<DrugId, number>;
  saffronCrashUntil: number;
  /** world.time until which this faction can see the given rival's mesh (DEGEN tap / Acid Cop Vision). */
  meshTap: Partial<Record<FactionId, number>>;
  stats: FactionStats;
  difficulty: Difficulty;
}

// ── Flags ────────────────────────────────────────────────────────────────────
export type FlagState = 'stock' | 'carried' | 'planted' | 'loose' | 'flying';
export interface FlagMove {
  t: number;
  x: number;
  z: number;
  state: FlagState;
  by: EntityId | -1;
}
export interface Flag {
  id: EntityId;
  type: 'flag';
  state: FlagState;
  /** Controlling faction: planter / carrier / stock holder. NEUTRAL for orphaned Flags. */
  owner: Owner;
  /** Entity holding the Flag (avatar/hippie when carried, hearth when stock, projectile id when flying). */
  holder: EntityId | -1;
  /** Node id when planted, else -1. */
  node: number;
  pos: V3;
  /** Superposed twin node (Flag Simulacra) or -1. A simulacrum is planted on `node` and `altNode`. */
  altNode: number;
  plantedAt: number;
  lastMovedAt: number;
  /** Movement history, newest last, capped at 16 entries. */
  history: FlagMove[];
  /** Presentation: fallen tilt (loose Flags lie at an angle). */
  tilt: number;
}

// ── Units ────────────────────────────────────────────────────────────────────
export interface AvatarInput {
  /** Desired horizontal move direction in world space (not normalized beyond length 1). */
  moveX: number;
  moveZ: number;
  jump: boolean;
  sprint: boolean;
  /** Held throw/aim mode. Scripted inputs may omit it (false). Takes priority over sprint. */
  throwMode?: boolean;
  /** Facing / aim yaw (0 = +z) and pitch (radians, + up). */
  yaw: number;
  pitch: number;
}

export type AvatarAction =
  | { kind: 'idle' }
  | { kind: 'swing'; t: number; hit: boolean }
  | { kind: 'plant'; node: number; t: number }
  | { kind: 'pull'; flagId: EntityId; t: number; dur: number }
  | { kind: 'align'; chakra: ChakraId; t: number }
  | { kind: 'channel'; what: 'dialectics'; t: number; dur: number };

export interface Avatar {
  id: EntityId;
  type: 'avatar';
  faction: FactionId;
  pos: V3;
  vel: V3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  hp: number;
  lastHurtAt: number;
  /** world.time when the avatar respawns; 0 when alive. */
  koUntil: number;
  /** Flag ids in the quiver. */
  carried: EntityId[];
  action: AvatarAction;
  input: AvatarInput;
  throwReadyAt: number;
  effects: StatusEffect[];
  /** GCC being pushed, or -1. */
  pushing: EntityId;
}

/** What a hippie is visibly doing (shared over the D.E.G.E.N. mesh). */
export type HippieStatus =
  | 'idle'
  | 'walking'
  | 'fetching' // going to get a Flag
  | 'carrying' // carrying a Flag to a node
  | 'planting'
  | 'pulling'
  | 'stealing' // carrying an enemy Flag home
  | 'chopping'
  | 'hauling'
  | 'building'
  | 'repairing'
  | 'fighting'
  | 'tearing' // attacking a piece/building
  | 'drumming'
  | 'defending'
  | 'following'
  | 'responding' // answering SOS / rally
  | 'distracted'
  | 'fleeing'
  | 'ko';

export type HippieOrder =
  | { kind: 'move'; to: V2 }
  | { kind: 'pull'; flagId: EntityId }
  | { kind: 'plant'; node: number }
  | { kind: 'gather'; pileId: EntityId }
  | { kind: 'defend'; at: V2 }
  | { kind: 'attack'; target: EntityId }
  | { kind: 'follow'; avatarId: EntityId }
  | { kind: 'push'; gccId: EntityId; to: V2 };

export interface Hippie {
  id: EntityId;
  type: 'hippie';
  faction: Owner;
  name: string;
  /** Time of joining the current camp; newest recruits occupy excess soft-cap places. */
  recruitedAt: number;
  /** Appearance seed (presentation only). */
  look: number;
  pos: V2;
  vel: V2;
  facing: number;
  hp: number;
  attention: number;
  koUntil: number;
  job: JobKind | null;
  order: HippieOrder | null;
  status: HippieStatus;
  /** Where the hippie is headed / working (for DEGEN display and debug). */
  statusTarget: V2 | null;
  carryingFlag: EntityId | -1;
  carryingLumber: number;
  /** Has a D.E.G.E.N. beacon (dropped beacons are gone until respawn). */
  beacon: boolean;
  effects: StatusEffect[];
  lastSosAt: number;
  /** Opaque per-hippie scratch owned by the hippie system (paths, timers, reservations). */
  brain: Record<string, unknown>;
}

// ── Structures ───────────────────────────────────────────────────────────────
export type CaptureStage = 'safe' | 'threatened' | 'contained' | 'contested' | 'overwritten' | 'captured';
export interface HearthState {
  stage: CaptureStage;
  /** Leading attacker (highest pressure) or null. */
  attacker: FactionId | null;
  /** Pressure 0..100 per attacking faction. */
  pressure: Record<FactionId, number>;
  /** world.time when the overwrite completes (stage 'overwritten'); 0 otherwise. */
  overwriteAt: number;
  /** Original owner when the camp was founded (for outposts). */
  founder: FactionId;
  craftProgress: number;
  /** Cached: hearth facet id (stable unless a flip moves it). */
  facet: number;
}

export interface Building {
  id: EntityId;
  type: 'building';
  kind: BuildingKind;
  faction: Owner;
  pos: V2;
  yaw: number;
  facet: number;
  hp: number;
  maxHp: number;
  /** Construction 0..1; functional at 1. */
  built: number;
  /** Disabled at 0 HP (or after capture) until repaired to full. */
  disabled: boolean;
  /** Generic production accumulator (flags, recruits, pulses). */
  progress: number;
  hearth: HearthState | null;
  lab: { brewing: DrugId | null; progress: number; queue: DrugId[] } | null;
  gcc: { destroyedUntil: number; channelUntil: number; pushedBy: EntityId | -1 } | null;
}

export interface Piece {
  id: EntityId;
  type: 'piece';
  kind: PieceKind;
  faction: Owner;
  /** Wall: edge id; else -1. */
  edge: number;
  /** Floor/ramp: facet id; else -1. */
  facet: number;
  level: number;
  /** Ramp: index 0..3 of the facet edge that is the LOW side. */
  rampEdge: number;
  hp: number;
  maxHp: number;
  builtAt: number;
  /** Collision shape id(s) registered with the physics world. */
  shapeIds: number[];
}

export interface Pile {
  id: EntityId;
  type: 'pile';
  kind: 'pallets' | 'moop' | 'lumber';
  pos: V2;
  lumber: number;
  max: number;
}

export interface Crystal {
  id: EntityId;
  type: 'crystal';
  node: number;
  faction: FactionId;
  pos: V2;
  bornAt: number;
  /** 0..1 growth. */
  growth: number;
  /** The five pentacle nodes that sustain it. */
  pentacle: number[];
}

export interface Projectile {
  id: EntityId;
  type: 'projectile';
  flagId: EntityId;
  thrower: EntityId;
  faction: FactionId;
  pos: V3;
  vel: V3;
  bornAt: number;
}

export type ZoneKind = 'stabilize' | 'beacon' | 'omega' | 'phason';
export interface Zone {
  id: EntityId;
  type: 'zone';
  kind: ZoneKind;
  faction: FactionId;
  pos: V2;
  radius: number;
  bornAt: number;
  until: number;
  level: number;
  /** Optional target entity (Priority Beacon). */
  target: EntityId | -1;
}

export interface Ping {
  id: EntityId;
  type: 'ping';
  kind: PingKind;
  faction: FactionId;
  pos: V2;
  from: EntityId | -1;
  bornAt: number;
  until: number;
}

/** A dropped D.E.G.E.N. beacon lying on the ground (enemy intel pickup). */
export interface DroppedBeacon {
  id: EntityId;
  type: 'beacon';
  faction: FactionId; // whose mesh it taps
  pos: V2;
  until: number;
}

export type Entity =
  | Flag
  | Avatar
  | Hippie
  | Building
  | Piece
  | Pile
  | Crystal
  | Projectile
  | Zone
  | Ping
  | DroppedBeacon;

// ── Match ────────────────────────────────────────────────────────────────────
/**
 * 'standard': the four-camp burn. 'tutorial': the Training Burn scenario (single player,
 * local only; built by sim/scenarios/tutorial.ts and driven by the tutorial director).
 */
export type MatchMode = 'standard' | 'tutorial';

/** Plain data (serializable): the host sends it to every client to rebuild the static world. */
export interface MatchOptions {
  match?: import("./matchSettings").MatchSettings;
  seed: string;
  difficulty: Difficulty;
  /** Human-controlled factions. Every other faction is AI (empty: attract mode / headless tests). */
  humans: FactionId[];
  mode: MatchMode;
}

export type MatchPhase = 'playing' | 'ended';
