/**
 * All gameplay tuning lives here. Values mirror docs/design/2026-10-02-flaghack-infinity-3d.md.
 * Change numbers here, not inline in systems.
 */
import type { FactionId, Personality } from './types';

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

// ── World ─────────────────────────────────────────────────────────────────────
export const MAP_HALF = 150; // world x/z in [-MAP_HALF, MAP_HALF]
export const MAP_SIZE = MAP_HALF * 2;
export const LEY_EDGE = 8; // lattice edge length (m)
export const LATTICE_MARGIN = 3; // nodes closer than this to the map border are dropped
/**
 * Camp centres, 60 m in from both map edges: room for the obstacle-free conquest corridor
 * (mapgen CAMP_CLEAR_RADIUS) plus a tree line and camp clutter behind it.
 */
export const CAMP_CENTERS: Record<FactionId, { x: number; z: number }> = {
  0: { x: -90, z: 90 },
  1: { x: 90, z: 90 },
  2: { x: 90, z: -90 },
  3: { x: -90, z: -90 },
};
export const LEVEL_HEIGHT = 3.2; // build level height (m)
export const MAX_BUILD_LEVEL = 3;

// ── Factions ──────────────────────────────────────────────────────────────────
export interface FactionDef {
  name: string;
  title: string;
  color: number;
  css: string;
  personality: Personality;
  /** Short lore flavour shown on Hearth rail / defeat cards. */
  motto: string;
}
export const FACTION_DEFS: Record<FactionId, FactionDef> = {
  0: {
    name: 'Dr. Beef Supreme',
    title: 'Abstractor of the Quintessence',
    color: 0x29e3ff,
    css: '#29e3ff',
    personality: 'player',
    motto: 'It is not you who moves the Flag, it is the Flag who moves you.',
  },
  1: {
    name: 'Dr. Beelzebub Crow',
    title: 'Host of the Too Late Show',
    color: 0xff4058,
    css: '#ff4058',
    personality: 'surveyor',
    motto: 'Flags is the herpes of objects.',
  },
  2: {
    name: 'DJ Scarecrow',
    title: 'Sonic Weaponeer',
    color: 0x86ff4a,
    css: '#86ff4a',
    personality: 'raider',
    motto: 'The Acid Cops have an open file on him. It is mostly question marks.',
  },
  3: {
    name: 'President Jaguar',
    title: 'Re-elected Forever',
    color: 0xa45cff,
    css: '#a45cff',
    personality: 'warden',
    motto: 'We cannot yet risk the instability of a fully enlightened society.',
  },
};
export const FLAG_YELLOW = 0xffd400;
export const NEUTRAL_COLOR = 0xd8d2c0;
/**
 * Festival tempo (presentation only): the music's sound-camp kick, stage lights, dancers and
 * DJ Scarecrow's headphones all run at this BPM, phase-locked through RenderContext.beat.
 */
export const FESTIVAL_BPM = 124;

// ── Starting camp ─────────────────────────────────────────────────────────────
export const START_LUMBER = 150;
export const START_STOCK_FLAGS = 14;
export const START_CARRIED_FLAGS = 6;
export const START_HIPPIES = 6;
export const START_HOME_RING_RADIUS = 13; // home loop planted around the Hearth at t=0

// ── Avatar ────────────────────────────────────────────────────────────────────
export const AVATAR = {
  runSpeed: 8,
  sprintSpeed: 11.5,
  accel: 60,
  airControl: 0.35,
  jumpSpeed: 7.5,
  gravity: 24,
  radius: 0.45,
  height: 1.85,
  stepHeight: 0.55,
  maxHp: 200,
  regenDelay: 4,
  regenPerSec: 6,
  quiver: 10,
  restockRadius: 6,
  plantReach: 3.5,
  plantTime: 0.2,
  throwCooldown: 0.3,
  throwSpeed: 26,
  throwSnapRadius: 3,
  pullOwnTime: 0.35,
  pullEnemyTime: 1.0,
  pullReach: 3,
  swingTime: 0.45,
  swingReach: 2.6,
  swingDamage: 34,
  swingPieceDamage: 40,
  swingLumber: 14,
  respawnTime: 6,
  observeRadius: 12,
  pullLooseTime: 0.15,
  /** Aim pitch clamp (radians). */
  pitchLimit: 1.45,
  /** Upward bias added to every throw's launch pitch (radians). */
  throwPitchBias: 0.06,
  throwHandHeight: 1.45,
  throwSnapRadiusDust: 5,
  restockInterval: 0.15,
  /** Full staff-swing cone (degrees) and the fraction of swingTime at which it connects. */
  swingCone: 100,
  swingHitAt: 0.4,
  swingKnockback: 5,
  /** Radius of the scatter when a Flagless vexillomancer drops the quiver. */
  koScatter: 1.6,
  /** Max distance from the GCC cart's edge to start pushing it. */
  gccPushReach: 3,
  beaconReach: 3,
} as const;

// ── Thrown Flags ──────────────────────────────────────────────────────────────
export const PROJECTILE = {
  lifetime: 5,
  hippieHitRadius: 0.6,
  hippieHitHeight: 1.8,
  hippieStun: 1,
  hippieDamage: 8,
} as const;

// ── Hippies ───────────────────────────────────────────────────────────────────
export const HIPPIE = {
  speed: 5.5,
  radius: 0.4,
  maxHp: 100,
  plantTime: 0.9,
  pullOwnTime: 0.8,
  pullEnemyTime: 2.4,
  shoveDamage: 12,
  shoveInterval: 0.8,
  wallDps: 15,
  gatherTime: 3,
  gatherAmount: 10,
  respawnTime: 14,
  attentionDrain: 1,
  overCapAttentionDrain: 2,
  attentionRecover: 4,
  distractedTime: 10,
  distractedRecoverTo: 60,
  sightRadius: 18,
  sosRespondRadius: 60,
  popCapBase: 12,
  popCapPerDrumCircle: 6,
  pickupTime: 0.3,
  /** Reach from a building's edge for stock pickup, delivery and deposits. */
  interactReach: 2.5,
  shoveReach: 1.2,
  shoveKnockback: 3,
  mudSpeed: 0.7,
  carryLumberSpeed: 0.9,
} as const;

/** Hippie labour/AI tuning (job allocator, pathing budget, behaviour radii). */
export const HIPPIE_AI = {
  jobInterval: 0.5,
  jobHysteresis: 8,
  pathBudget: 8,
  pathMaxIter: 6000,
  fetchRadius: 40,
  patrolRadius: 14,
  intruderRadius: 22,
  leash: 32,
  rallyRadius: 25,
  followEngageRadius: 7,
  sosResponders: 4,
  pingTargetRadius: 14,
  tearInterval: 0.5,
  drumRing: 0.8,
  repairStand: 2,
  neutralPace: 0.55,
  idlePace: 0.45,
  patrolPace: 0.6,
  hoardDrainMult: 1.5,
  psychosisDrainMult: 2,
  paranoiaDrainMult: 2,
  recoverHearthRadius: 12,
  recoverDrumRadius: 7,
  distractedMaxWalk: 40,
  fleeTime: 3,
  fleeHpFrac: 0.5,
  wobbleSpeed: 0.6,
  maxActivePings: 8,
} as const;

// ── Building ──────────────────────────────────────────────────────────────────
export const PIECE = {
  cost: 10,
  hp: 150,
  refund: 5,
  wallHeight: 3.2,
  wallThickness: 0.35,
  wallInset: 0.5,
  popIn: 0.4,
} as const;

export const BUILDINGS = {
  hearth: { cost: 0, hp: 1500, radius: 3.2 },
  workshop: { cost: 80, hp: 500, radius: 2.8 },
  drumcircle: { cost: 80, hp: 500, radius: 3.0 },
  ward: { cost: 120, hp: 700, radius: 2.2 },
  druglab: { cost: 100, hp: 500, radius: 2.8 },
  gcc: { cost: 0, hp: 600, radius: 1.6 },
} as const;
/** Collision/visual body height of each camp building (m); footprint radius is BUILDINGS[kind].radius. */
export const BUILDING_HEIGHT = {
  hearth: 2.2,
  workshop: 3.0,
  drumcircle: 1.0,
  ward: 4.5,
  druglab: 3.0,
  gcc: 1.3,
} as const;
export const BUILD_TIME = 8;
export const HEARTH_FLAG_INTERVAL = 8;
export const HEARTH_FLAG_COST = 4;
export const WORKSHOP_FLAG_INTERVAL = 5;
export const WORKSHOP_FLAG_COST = 3;
export const RECRUIT_INTERVAL = 14;
export const RECRUIT_RADIUS = 15;
export const RECRUIT_ATTRACT_RADIUS = 60;
export const HOARD_THRESHOLD = 24;
export const WARD_RADIUS = 30;
export const WARD_OBSERVE_RADIUS = 26;
export const WARD_PULSE_INTERVAL = 4;
export const WARD_PULSE_RADIUS = 14;
export const HEARTH_OBSERVE_RADIUS = 22;
export const DRUM_RITUAL_PER_SEC = 0.1; // per drummer: a full circle (4) earns a level-1 alignment in ~75 s
export const DRUMMERS_PER_CIRCLE = 4;
/** Drummers count when within a Drum Circle's radius plus this. */
export const DRUM_REACH = 4;
/** Own vexillomancer (or a helping hippie) within this of a building speeds construction and repairs it. */
export const BUILD_HELP_RADIUS = 6;
export const BUILD_HELP_MULT = 1.5;
export const BUILDING_REPAIR_HPS = 10;
export const WARD_PULSE_STUN = 1;
export const WARD_PULSE_DAMAGE = 10;
/** Max distance from the vexillomancer to a piece being built. */
export const PIECE_REACH = 16;

// ── GCC ───────────────────────────────────────────────────────────────────────
export const GCC = {
  pushSpeed: 4,
  adviceRadius: 30,
  repairRadius: 20,
  repairInterval: 3,
  repairHps: 15,
  dialecticsRadius: 14,
  dialecticsCooldown: 40,
  dialecticsChannel: 3,
  dialecticsMax: 3,
  simulacraCooldown: 20,
  simulacraObserveRadius: 10,
  rebuildTime: 45,
} as const;
/** The vexillomancer must stand within this of its GCC to work the Command Table. */
export const GCC_REACH = 6;
/** Both simulacrum nodes must lie within this of the GCC. */
export const GCC_SIMULACRA_RANGE = 60;
/** Flag Repair re-plants a loose Flag onto a free node within this of where it lies. */
export const GCC_REPAIR_SNAP = 6;

// ── Survey / Crystal ──────────────────────────────────────────────────────────
export const IMPLIED_MAX_ORDER = 3;
export const INSTABILITY_RISE = 0.08;
export const INSTABILITY_DECAY = 0.15;
export const INSTABILITY_SHIMMER = 0.35;
export const INSTABILITY_DISCHARGE = 0.65;
export const INSTABILITY_STORM = 0.9;
export const DISCHARGE_STUN = 1.2;
export const DISCHARGE_DAMAGE = 25;
export const TIDE_INTERVAL = 75;
export const TIDE_INTERVAL_SUDDEN_DEATH = 40;
export const TIDE_WARNING = 10;
export const TIDE_FRACTION = 0.05;
export const CRYSTAL_GROW_TIME = 3;
export const CRYSTAL_RITUAL_PER_SEC = 0.08;
export const CRYSTAL_PRESSURE_RADIUS = 45;
export const CRYSTAL_PRESSURE_BONUS = 1.15;
export const CRYSTAL_OBSERVE_RADIUS = 10;

// ── Capture ───────────────────────────────────────────────────────────────────
export const CAPTURE = {
  threatRadius: 30,
  baseRate: 6, // a held loop must convert before defenders break it (~17 s bare, ~50 s held+defended+warded)
  decay: 3, // a broken loop costs tempo (~33 s to drain), not the whole siege (all-AI playtests)
  contestedMult: 0.6,
  defenderMult: 0.93,
  defenderFloor: 0.8,
  defenderRadius: 12,
  wardMult: 0.7,
  overwriteTime: 3,
  holdRadius: 8,
} as const;
export const BURN_TIME = 14 * 60;
export const SUDDEN_DEATH_PRESSURE_MULT = 2;
/** After The Burn, the sudden-death pressure multiplier rises by 1 every this many seconds. */
export const SUDDEN_DEATH_ESCALATE_EVERY = 120;
/** Pressure multiplier on a captured outpost (a Hearth held by anyone but its founder). */
export const OUTPOST_PRESSURE_MULT = 1.5;
/**
 * Dawn: if more than one camp still stands at this time, the dominant one wins (most Hearths,
 * then largest Survey, then C.M.I.). Requirements R4/R5: matches end within 30 minutes and a
 * "dominant Flag Hearth" may win. Only the ~10% of matches that stall in a Hearth-trading
 * duel ever reach it (32-seed all-AI sweep).
 */
export const DAWN_TIME = 30 * 60;
/** Seconds before DAWN_TIME that every camp is warned ("One minute to dawn"). */
export const DAWN_WARNING = 60;

// ── Chakras / abilities ──────────────────────────────────────────────────────
export const ALIGN_COST = [30, 70, 130] as const; // cost to reach level 1, 2, 3
export const ALIGN_TIME = 4;
/** Must stand within this of an own Hearth to align a chakra. */
export const ALIGN_RADIUS = 8;
/** Ability tuning (design §11). Arrays are indexed by chakra level - 1. */
export const ABILITY = {
  beacon: { cooldown: 20, radius: [40, 70, MAP_SIZE * 1.5], duration: 12, targetReach: 2.5 },
  march: { cooldown: 30, radius: 25, duration: [10, 15, 20], mag: 0.6, attentionCost: 40, exhaustMag: 0.3, exhaustTime: 6 },
  stabilize: { cooldown: 35, duration: 20, radius: [16, 20, 24], range: 60 },
  phason: { cooldown: 24, range: 60, radius: [0, 7, 11], pickRadius: 5, zoneTime: 1.2 },
  omega: { cooldown: 75, radius: [12, 16, 20], damage: 40, knockback: 14, looseFraction: 0.8, zoneTime: 1 },
} as const;

// ── Drugs ─────────────────────────────────────────────────────────────────────
export const BREW_TIME = 22;
export const BREW_COST = 25;
export const DRUG_MAX = 3;
/** Drug tuning (design §12). */
export const DRUG = {
  duration: { saffron: 40, dust: 30, acidcop: 30 },
  queueMax: 3,
  saffronMag: 0.5,
  saffronRitualPerSec: 0.3,
  crashTime: 20,
  crashMag: 0.3,
  overstimChance: 0.25,
  overstimMin: 8,
  overstimMax: 15,
  falseFlagsMin: 3,
  falseFlagsMax: 5,
  falseFlagRadius: 45,
  falseFlagReroll: 10,
} as const;

// ── DEGEN mesh ────────────────────────────────────────────────────────────────
export const PING_DURATION = 12;
export const SOS_COOLDOWN = 6;
export const RETRANSMIT_COOLDOWN = 60;
export const RETRANSMIT_ATTENTION = 35;
export const MESH_TAP_DURATION = 30;
export const BEACON_DROP_CHANCE = 0.35;
/** Seconds a dropped D.E.G.E.N. beacon lies in the dirt before it is MOOP-swept. */
export const BEACON_LIFETIME = 60;

// ── Lumber piles ──────────────────────────────────────────────────────────────
export const PILE_COUNT = 44;
export const PILE_MIN = 80;
export const PILE_MAX = 200;
export const PILE_RESPAWN_INTERVAL = 25;
