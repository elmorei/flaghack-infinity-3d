/**
 * Entity constructors. Always create entities through these so defaults stay consistent.
 * They register the entity in the World and return it; they do not emit events.
 */
import { AVATAR, BUILDINGS, FACTION_DEFS, HIPPIE, PIECE, PING_DURATION } from './constants';
import type { V2, V3 } from './math';
import type {
  Avatar,
  Building,
  BuildingKind,
  Crystal,
  Difficulty,
  DroppedBeacon,
  EntityId,
  FactionId,
  FactionState,
  Flag,
  FlagState,
  Hippie,
  Owner,
  Pile,
  Piece,
  PieceKind,
  Ping,
  PingKind,
  Projectile,
  Zone,
  ZoneKind,
} from './types';
import type { World } from './world';

const HIPPIE_FIRST = [
  'Moonbeam', 'Sage', 'River', 'Juniper', 'Cosmo', 'Saffron', 'Indigo', 'Zephyr', 'Willow', 'Echo',
  'Lumen', 'Basil', 'Clover', 'Nebula', 'Pixel', 'Marigold', 'Dewdrop', 'Orbit', 'Fennel', 'Glimmer',
  'Tumbleweed', 'Kale', 'Sprocket', 'Wren', 'Quasar', 'Paisley', 'Mantra', 'Fern', 'Comet', 'Bramble',
];
const HIPPIE_LAST = [
  'Stardust', 'Flagwalker', 'Ley', 'Burnside', 'Ensign', 'Pentacle', 'Dome', 'Glitter', 'Mudfoot',
  'Signifier', 'Tarp', 'Ziptie', 'Playa', 'Drumkin', 'Moopwright', 'Halyard', 'Finial', 'Canton',
];

export function createFaction(id: FactionId, isPlayer: boolean, difficulty: Difficulty): FactionState {
  const def = FACTION_DEFS[id];
  return {
    id,
    name: def.name,
    title: def.title,
    color: def.color,
    css: def.css,
    personality: isPlayer ? 'player' : def.personality,
    isPlayer,
    alive: true,
    eliminatedAt: null,
    eliminatedBy: null,
    avatarId: -1,
    gccId: null,
    hearthIds: [],
    lumber: 0,
    ritual: 0,
    plan: new Set<number>(),
    jobWeights: { survey: 3, gather: 2, defend: 1, raid: 0, ritual: 1 },
    chakras: { hoist: 0, fly: 0, canton: 0, field: 0, finial: 0 },
    cooldowns: { beacon: 0, march: 0, stabilize: 0, phason: 0, omega: 0, dialectics: 0, simulacra: 0, retransmit: 0 },
    drugs: { saffron: 0, dust: 0, acidcop: 0 },
    drugActive: { saffron: 0, dust: 0, acidcop: 0 },
    saffronCrashUntil: 0,
    meshTap: {},
    stats: {
      flagsPlanted: 0,
      flagsPulled: 0,
      flagsStolen: 0,
      facetsPeak: 0,
      crystalsManifested: 0,
      captures: 0,
      hippiesRecruited: 0,
      cmi: 0,
    },
    difficulty,
  };
}

export function spawnFlag(
  world: World,
  init: { state: FlagState; owner: Owner; holder?: EntityId | -1; node?: number; pos: V3 },
): Flag {
  const flag: Flag = {
    id: world.newId(),
    type: 'flag',
    state: init.state,
    owner: init.owner,
    holder: init.holder ?? -1,
    node: init.node ?? -1,
    pos: { ...init.pos },
    altNode: -1,
    plantedAt: init.state === 'planted' ? world.time : 0,
    lastMovedAt: world.time,
    history: [{ t: world.time, x: init.pos.x, z: init.pos.z, state: init.state, by: init.holder ?? -1 }],
    tilt: init.state === 'loose' ? 1 : 0,
  };
  world.flags.set(flag.id, flag);
  return flag;
}

export function spawnAvatar(world: World, faction: FactionId, at: V2): Avatar {
  const av: Avatar = {
    id: world.newId(),
    type: 'avatar',
    faction,
    pos: { x: at.x, y: 0, z: at.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    hp: AVATAR.maxHp,
    lastHurtAt: -999,
    koUntil: 0,
    carried: [],
    action: { kind: 'idle' },
    input: { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 },
    throwReadyAt: 0,
    effects: [],
    pushing: -1,
  };
  world.avatars.set(av.id, av);
  world.factions[faction].avatarId = av.id;
  return av;
}

export function spawnHippie(world: World, faction: Owner, at: V2): Hippie {
  const rng = world.rng;
  const h: Hippie = {
    id: world.newId(),
    type: 'hippie',
    faction,
    recruitedAt: world.time,
    name: `${rng.pick(HIPPIE_FIRST)} ${rng.pick(HIPPIE_LAST)}`,
    look: rng.int(0, 1 << 30),
    pos: { x: at.x, z: at.z },
    vel: { x: 0, z: 0 },
    facing: rng.range(-Math.PI, Math.PI),
    hp: HIPPIE.maxHp,
    attention: rng.range(70, 100),
    koUntil: 0,
    job: null,
    order: null,
    status: 'idle',
    statusTarget: null,
    carryingFlag: -1,
    carryingLumber: 0,
    beacon: faction !== -1,
    effects: [],
    lastSosAt: -999,
    brain: {},
  };
  world.hippies.set(h.id, h);
  return h;
}

export function spawnBuilding(world: World, kind: BuildingKind, faction: Owner, facet: number, built = 0): Building {
  const f = world.lattice.facets[facet];
  const def = BUILDINGS[kind];
  const b: Building = {
    id: world.newId(),
    type: 'building',
    kind,
    faction,
    pos: { x: f.cx, z: f.cz },
    yaw: facetYaw(world, facet),
    facet,
    hp: def.hp,
    maxHp: def.hp,
    built,
    disabled: false,
    progress: 0,
    hearth:
      kind === 'hearth'
        ? {
            stage: 'safe',
            attacker: null,
            pressure: { 0: 0, 1: 0, 2: 0, 3: 0 },
            overwriteAt: 0,
            founder: faction === -1 ? 0 : faction,
            craftProgress: 0,
            facet,
          }
        : null,
    lab: kind === 'druglab' ? { brewing: null, progress: 0, queue: [] } : null,
    gcc: kind === 'gcc' ? { destroyedUntil: 0, channelUntil: 0, pushedBy: -1 } : null,
  };
  world.buildings.set(b.id, b);
  if (faction !== -1) {
    if (kind === 'hearth') world.factions[faction].hearthIds.push(b.id);
    if (kind === 'gcc') world.factions[faction].gccId = b.id;
  }
  return b;
}

/** Yaw aligning a building with its facet's long diagonal (looks deliberate on the rhombus). */
export function facetYaw(world: World, facet: number): number {
  const lat = world.lattice;
  const f = lat.facets[facet];
  const a = lat.nodes[f.nodes[0]];
  const c = lat.nodes[f.nodes[2]];
  const b = lat.nodes[f.nodes[1]];
  const d = lat.nodes[f.nodes[3]];
  const ac = Math.hypot(c.x - a.x, c.z - a.z);
  const bd = Math.hypot(d.x - b.x, d.z - b.z);
  return ac >= bd ? Math.atan2(c.x - a.x, c.z - a.z) : Math.atan2(d.x - b.x, d.z - b.z);
}

export function spawnPile(world: World, kind: Pile['kind'], at: V2, lumber: number): Pile {
  const p: Pile = { id: world.newId(), type: 'pile', kind, pos: { ...at }, lumber, max: lumber };
  world.piles.set(p.id, p);
  return p;
}

export function spawnCrystal(world: World, node: number, faction: FactionId, pentacle: number[]): Crystal {
  const n = world.lattice.nodes[node];
  const c: Crystal = {
    id: world.newId(),
    type: 'crystal',
    node,
    faction,
    pos: { x: n.x, z: n.z },
    bornAt: world.time,
    growth: 0,
    pentacle: pentacle.slice(),
  };
  world.crystals.set(c.id, c);
  return c;
}

export function spawnProjectile(world: World, flagId: EntityId, thrower: EntityId, faction: FactionId, pos: V3, vel: V3): Projectile {
  const p: Projectile = { id: world.newId(), type: 'projectile', flagId, thrower, faction, pos: { ...pos }, vel: { ...vel }, bornAt: world.time };
  world.projectiles.set(p.id, p);
  return p;
}

export function spawnZone(
  world: World,
  kind: ZoneKind,
  faction: FactionId,
  at: V2,
  radius: number,
  duration: number,
  level: number,
  target: EntityId | -1 = -1,
): Zone {
  const z: Zone = {
    id: world.newId(),
    type: 'zone',
    kind,
    faction,
    pos: { ...at },
    radius,
    bornAt: world.time,
    until: world.time + duration,
    level,
    target,
  };
  world.zones.set(z.id, z);
  return z;
}

export function spawnPing(world: World, kind: PingKind, faction: FactionId, at: V2, from: EntityId | -1): Ping {
  const p: Ping = { id: world.newId(), type: 'ping', kind, faction, pos: { ...at }, from, bornAt: world.time, until: world.time + PING_DURATION };
  world.pings.set(p.id, p);
  return p;
}

/** A D.E.G.E.N. beacon dropped by a KO'd hippie; picking it up taps `faction`'s mesh. */
export function spawnBeacon(world: World, faction: FactionId, at: V2, until: number): DroppedBeacon {
  const b: DroppedBeacon = { id: world.newId(), type: 'beacon', faction, pos: { ...at }, until };
  world.beacons.set(b.id, b);
  return b;
}

/** A Fortnite-style build piece (wall on an edge, deck/ramp on a facet). Shapes are registered by pieces.ts. */
export function spawnPiece(
  world: World,
  kind: PieceKind,
  faction: Owner,
  edge: number,
  facet: number,
  level: number,
  rampEdge: number,
): Piece {
  const p: Piece = {
    id: world.newId(),
    type: 'piece',
    kind,
    faction,
    edge,
    facet,
    level,
    rampEdge,
    hp: PIECE.hp,
    maxHp: PIECE.hp,
    builtAt: world.time,
    shapeIds: [],
  };
  world.pieces.set(p.id, p);
  return p;
}
