import { MATCH_RANGES, normalizeMatch } from "../sim/matchSettings";
/**
 * Host-side validation of untrusted client messages: JSON parse, exact shape and type checks for
 * every ClientMessage and every Command variant (numbers finite and in range, ids integers,
 * strings bounded, arrays bounded, no missing or extra keys). Anything malformed returns null and
 * never reaches the simulation. Parsers build fresh objects, so the compiler checks every accepted
 * shape against the contract types. Faction fields are overwritten by the host with the sender's
 * seat after validation; names, chat and seeds are sanitized by the host (these checks only bound
 * the work).
 * Owner: HostServer agent.
 */
import type { Command, CommandOf, CommandType } from '../sim/commands';
import type { V2 } from '../sim/math';
import type {
  AbilityId,
  AvatarInput,
  BuildingKind,
  ChakraId,
  Difficulty,
  DrugId,
  FactionId,
  GccAction,
  HippieOrder,
  JobKind,
  PieceKind,
  PingKind,
} from '../sim/types';
import {
  MAX_CHAT_LENGTH,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_FRAME_COMMANDS,
  MAX_NAME_LENGTH,
  MAX_SEED_LENGTH,
  PROTOCOL_VERSION,
} from './protocol';
import type { ClientMessage, LobbySettings } from './protocol';

/** Raw text may carry whitespace and control characters the host strips: bound the input, not the result. */
const RAW_NAME = MAX_NAME_LENGTH * 4;
const RAW_CHAT = MAX_CHAT_LENGTH * 4;
const RAW_SEED = MAX_SEED_LENGTH * 4;
const MAX_PASSWORD = 256;
const MAX_TOKEN = 64;
/** Entity ids and lattice indices (nodes, edges, facets) are non-negative int32. */
const MAX_INDEX = 0x7fffffff;
/** Above the pile of every node on the map, so a whole-Survey 'set' always fits. */
const MAX_PLAN_NODES = 4096;
const MAX_ORDER_HIPPIES = 512;
/** A simulacrum names two nodes; dialectics names none. */
const MAX_GCC_NODES = 2;
const MAX_BUILD_LEVEL_INDEX = 64;

type Rec = Record<string, unknown>;

/** Lattice array sizes of the running match (see fitsLattice). */
export interface LatticeSizes {
  nodes: number;
  edges: number;
  facets: number;
}

// ── Primitive guards ────────────────────────────────────────────────────────
function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A plain object with exactly these own keys. */
function exact(v: unknown, keys: readonly string[]): v is Rec {
  if (!isRec(v)) return false;
  const own = Object.keys(v);
  if (own.length !== keys.length) return false;
  for (const k of keys) if (!Object.hasOwn(v, k)) return false;
  return true;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInt(v: unknown, min: number, max = MAX_INDEX): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max;
}

function isFaction(v: unknown): v is FactionId {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

/** `v` names an own key of `table` (hasOwn: inherited names like 'constructor' never pass). */
function isKeyOf<T extends object>(table: T, v: unknown): v is keyof T & string {
  return typeof v === 'string' && Object.hasOwn(table, v);
}

// ── Union tables (Record keys: the compiler flags any member missing here) ──
const DIFFICULTIES: Record<Difficulty, true> = { chill: true, normal: true, hard: true, vexillosaint: true };
const PIECE_KINDS: Record<PieceKind, true> = { wall: true, floor: true, ramp: true };
const BUILDING_KINDS: Record<BuildingKind, true> = {
  hearth: true,
  workshop: true,
  drumcircle: true,
  ward: true,
  druglab: true,
  gcc: true,
};
const ABILITIES: Record<AbilityId, true> = { beacon: true, march: true, stabilize: true, phason: true, omega: true };
const CHAKRA_IDS: Record<ChakraId, true> = { hoist: true, fly: true, canton: true, field: true, finial: true };
const DRUG_IDS: Record<DrugId, true> = { saffron: true, dust: true, acidcop: true };
const GCC_ACTIONS: Record<GccAction, true> = { dialectics: true, simulacra: true };
const PING_KINDS: Record<PingKind, true> = { rally: true, attack: true, flag: true, sos: true, shot: true };
const JOB_KINDS: Record<JobKind, true> = { survey: true, gather: true, defend: true, raid: true, ritual: true };
const PLAN_OPS: Record<CommandOf<'plan'>['op'], true> = { add: true, remove: true, set: true, clear: true };

// ── Composite values ────────────────────────────────────────────────────────
function vec(v: unknown): V2 | null {
  if (!exact(v, ['x', 'z'])) return null;
  const { x, z } = v;
  return isNum(x) && isNum(z) ? { x, z } : null;
}

function intList(v: unknown, min: number, maxLength: number): number[] | null {
  if (!Array.isArray(v) || v.length > maxLength) return null;
  const out: number[] = [];
  for (const n of v) {
    if (!isInt(n, min)) return null;
    out.push(n);
  }
  return out;
}

const INPUT_KEYS = ['moveX', 'moveZ', 'jump', 'sprint', 'yaw', 'pitch'];
const THROW_INPUT_KEYS = [...INPUT_KEYS, 'throwMode'];

function avatarInput(v: unknown): AvatarInput | null {
  if (!exact(v, INPUT_KEYS) && !exact(v, THROW_INPUT_KEYS)) return null;
  const { moveX, moveZ, jump, sprint, yaw, pitch } = v;
  if (!isNum(moveX) || !isNum(moveZ) || !isNum(yaw) || !isNum(pitch)) return null;
  if (typeof jump !== 'boolean' || typeof sprint !== 'boolean') return null;
  if (Object.hasOwn(v, 'throwMode')) {
    if (typeof v.throwMode !== 'boolean') return null;
    return { moveX, moveZ, jump, sprint, yaw, pitch, throwMode: v.throwMode };
  }
  return { moveX, moveZ, jump, sprint, yaw, pitch };
}

function jobWeights(v: unknown): Partial<Record<JobKind, number>> | null {
  if (!isRec(v)) return null;
  const out: Partial<Record<JobKind, number>> = {};
  for (const k of Object.keys(v)) {
    const w = v[k];
    if (!isKeyOf(JOB_KINDS, k) || !isNum(w)) return null;
    out[k] = w;
  }
  return out;
}

function settingsPatch(v: unknown): Partial<LobbySettings> | null {
  if (!isRec(v)) return null;
  const out: Partial<LobbySettings> = {};
  for (const k of Object.keys(v)) {
    if (k === 'difficulty') {
      const d = v.difficulty;
      if (!isKeyOf(DIFFICULTIES, d)) return null;
      out.difficulty = d;
    } else if(k === 'match') {
      const m=v.match; if(!isRec(m))return null;
      if(!Array.isArray(m.active)||m.active.length<1||m.active.length>4||m.active.some(f=>!Number.isInteger(f)||f<0||f>3)||new Set(m.active).size!==m.active.length)return null;
      if(typeof m.days!=='number'||!Number.isInteger(m.days)||m.days<0||m.days>5)return null;
      for(const key of Object.keys(MATCH_RANGES) as (keyof typeof MATCH_RANGES)[]){const n=m[key];const [min,max]=MATCH_RANGES[key];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)return null;}
      if(typeof m.structuresBlockFlagPlacement !== 'boolean')return null;
      if(!Number.isInteger(m.maxSignifiers)||!Number.isInteger(m.startingSignifiers))return null;
      if(Object.keys(m).some(key=>!['active','days','structuresBlockFlagPlacement',...Object.keys(MATCH_RANGES)].includes(key)))return null;
      out.match=normalizeMatch(m);
    } else if (k === 'seed') {
      const s = v.seed;
      if (s !== null && !isText(s, RAW_SEED)) return null;
      out.seed = s;
    } else {
      return null;
    }
  }
  return out;
}

interface Entry<T> {
  keys: readonly string[];
  parse(m: Rec): T | null;
}

const ORDERS: { [K in HippieOrder['kind']]: Entry<Extract<HippieOrder, { kind: K }>> } = {
  move: {
    keys: ['kind', 'to'],
    parse: (m) => {
      const to = vec(m.to);
      return to && { kind: 'move', to };
    },
  },
  pull: {
    keys: ['kind', 'flagId'],
    parse: ({ flagId }) => (isInt(flagId, 0) ? { kind: 'pull', flagId } : null),
  },
  plant: {
    keys: ['kind', 'node'],
    parse: ({ node }) => (isInt(node, 0) ? { kind: 'plant', node } : null),
  },
  gather: {
    keys: ['kind', 'pileId'],
    parse: ({ pileId }) => (isInt(pileId, 0) ? { kind: 'gather', pileId } : null),
  },
  defend: {
    keys: ['kind', 'at'],
    parse: (m) => {
      const at = vec(m.at);
      return at && { kind: 'defend', at };
    },
  },
  attack: {
    keys: ['kind', 'target'],
    parse: ({ target }) => (isInt(target, 0) ? { kind: 'attack', target } : null),
  },
  follow: {
    keys: ['kind', 'avatarId'],
    parse: ({ avatarId }) => (isInt(avatarId, 0) ? { kind: 'follow', avatarId } : null),
  },
  push: {
    keys: ['kind', 'gccId', 'to'],
    parse: (m) => {
      const { gccId } = m;
      const to = vec(m.to);
      return to && isInt(gccId, 0) ? { kind: 'push', gccId, to } : null;
    },
  },
};

function hippieOrder(v: unknown): HippieOrder | null {
  if (!isRec(v)) return null;
  const kind = v.kind;
  if (!isKeyOf(ORDERS, kind)) return null;
  const entry = ORDERS[kind];
  return exact(v, entry.keys) ? entry.parse(v) : null;
}

/** Command parsers receive the already-validated faction (overwritten by the host later). */
interface CommandEntry<T> {
  keys: readonly string[];
  parse(m: Rec, faction: FactionId): T | null;
}

const COMMANDS: { [K in CommandType]: CommandEntry<CommandOf<K>> } = {
  avatarInput: {
    keys: ['t', 'faction', 'input'],
    parse: (m, faction) => {
      const input = avatarInput(m.input);
      return input && { t: 'avatarInput', faction, input };
    },
  },
  plant: {
    keys: ['t', 'faction', 'node'],
    parse: ({ node }, faction) => (isInt(node, 0) ? { t: 'plant', faction, node } : null),
  },
  throw: {
    keys: ['t', 'faction'],
    parse: (_m, faction) => ({ t: 'throw', faction }),
  },
  pull: {
    // -1 releases the channel.
    keys: ['t', 'faction', 'flagId'],
    parse: ({ flagId }, faction) => (isInt(flagId, -1) ? { t: 'pull', faction, flagId } : null),
  },
  handFlag: {
    keys: ['t', 'faction', 'hippieId'],
    parse: ({ hippieId }, faction) => isInt(hippieId, 0) ? { t: 'handFlag', faction, hippieId } : null,
  },
  swing: {
    keys: ['t', 'faction'],
    parse: (_m, faction) => ({ t: 'swing', faction }),
  },
  build: {
    // Walls name an edge, floors and ramps a facet; the unused index is -1.
    keys: ['t', 'faction', 'kind', 'edge', 'facet', 'level', 'rampEdge'],
    parse: ({ kind, edge, facet, level, rampEdge }, faction) =>
      isKeyOf(PIECE_KINDS, kind) &&
      isInt(edge, -1) &&
      isInt(facet, -1) &&
      isInt(level, 0, MAX_BUILD_LEVEL_INDEX) &&
      isInt(rampEdge, -1, 3)
        ? { t: 'build', faction, kind, edge, facet, level, rampEdge }
        : null,
  },
  demolish: {
    keys: ['t', 'faction', 'pieceId'],
    parse: ({ pieceId }, faction) => (isInt(pieceId, 0) ? { t: 'demolish', faction, pieceId } : null),
  },
  placeBuilding: {
    keys: ['t', 'faction', 'kind', 'facet'],
    parse: ({ kind, facet }, faction) =>
      isKeyOf(BUILDING_KINDS, kind) && isInt(facet, 0) ? { t: 'placeBuilding', faction, kind, facet } : null,
  },
  plan: {
    keys: ['t', 'faction', 'op', 'nodes'],
    parse: (m, faction) => {
      const { op } = m;
      const nodes = intList(m.nodes, 0, MAX_PLAN_NODES);
      return nodes && isKeyOf(PLAN_OPS, op) ? { t: 'plan', faction, op, nodes } : null;
    },
  },
  jobWeights: {
    keys: ['t', 'faction', 'weights'],
    parse: (m, faction) => {
      const weights = jobWeights(m.weights);
      return weights && { t: 'jobWeights', faction, weights };
    },
  },
  order: {
    // order null clears standing orders.
    keys: ['t', 'faction', 'hippies', 'order'],
    parse: (m, faction) => {
      const hippies = intList(m.hippies, 0, MAX_ORDER_HIPPIES);
      if (!hippies) return null;
      if (m.order === null) return { t: 'order', faction, hippies, order: null };
      const order = hippieOrder(m.order);
      return order && { t: 'order', faction, hippies, order };
    },
  },
  rally: {
    keys: ['t', 'faction'],
    parse: (_m, faction) => ({ t: 'rally', faction }),
  },
  sendFollowers: {
    keys: ['t', 'faction', 'at', 'target'],
    parse: (m, faction) => {
      const { target } = m;
      const at = vec(m.at);
      return at && isInt(target, -1) ? { t: 'sendFollowers', faction, at, target } : null;
    },
  },
  ability: {
    // node -1: the ability targets the point only.
    keys: ['t', 'faction', 'ability', 'at', 'node'],
    parse: (m, faction) => {
      const { ability, node } = m;
      const at = vec(m.at);
      return at && isKeyOf(ABILITIES, ability) && isInt(node, -1) ? { t: 'ability', faction, ability, at, node } : null;
    },
  },
  align: {
    keys: ['t', 'faction', 'chakra'],
    parse: ({ chakra }, faction) => (isKeyOf(CHAKRA_IDS, chakra) ? { t: 'align', faction, chakra } : null),
  },
  drug: {
    keys: ['t', 'faction', 'drug'],
    parse: ({ drug }, faction) => (isKeyOf(DRUG_IDS, drug) ? { t: 'drug', faction, drug } : null),
  },
  brew: {
    keys: ['t', 'faction', 'labId', 'drug'],
    parse: ({ labId, drug }, faction) =>
      isInt(labId, 0) && isKeyOf(DRUG_IDS, drug) ? { t: 'brew', faction, labId, drug } : null,
  },
  gcc: {
    keys: ['t', 'faction', 'action', 'target', 'nodes'],
    parse: (m, faction) => {
      const { action, target } = m;
      const nodes = intList(m.nodes, 0, MAX_GCC_NODES);
      return nodes && isKeyOf(GCC_ACTIONS, action) && isInt(target, -1) ? { t: 'gcc', faction, action, target, nodes } : null;
    },
  },
  pushGcc: {
    keys: ['t', 'faction', 'on'],
    parse: ({ on }, faction) => (typeof on === 'boolean' ? { t: 'pushGcc', faction, on } : null),
  },
  ping: {
    keys: ['t', 'faction', 'kind', 'at'],
    parse: (m, faction) => {
      const { kind } = m;
      const at = vec(m.at);
      return at && isKeyOf(PING_KINDS, kind) ? { t: 'ping', faction, kind, at } : null;
    },
  },
  retransmit: {
    keys: ['t', 'faction'],
    parse: (_m, faction) => ({ t: 'retransmit', faction }),
  },
  tapBeacon: {
    keys: ['t', 'faction', 'beaconId'],
    parse: ({ beaconId }, faction) => (isInt(beaconId, 0) ? { t: 'tapBeacon', faction, beaconId } : null),
  },
};

/** One Command from untrusted JSON, or null if anything about it is off. */
export function parseCommand(v: unknown): Command | null {
  if (!isRec(v)) return null;
  const { t, faction } = v;
  if (!isKeyOf(COMMANDS, t) || !isFaction(faction)) return null;
  const entry = COMMANDS[t];
  return exact(v, entry.keys) ? entry.parse(v, faction) : null;
}

type MessageType = ClientMessage['t'];

const MESSAGES: { [K in MessageType]: Entry<Extract<ClientMessage, { t: K }>> } = {
  hello: {
    keys: ['t', 'protocol', 'name', 'password', 'token'],
    parse: ({ protocol, name, password, token }) =>
      isInt(protocol, 0) &&
      isText(name, RAW_NAME) &&
      isText(password, MAX_PASSWORD) &&
      (token === null || isText(token, MAX_TOKEN))
        ? { t: 'hello', protocol, name, password, token }
        : null,
  },
  seat: {
    keys: ['t', 'seat'],
    parse: ({ seat }) => (seat === null || isFaction(seat) ? { t: 'seat', seat } : null),
  },
  ready: {
    keys: ['t', 'ready'],
    parse: ({ ready }) => (typeof ready === 'boolean' ? { t: 'ready', ready } : null),
  },
  settings: {
    keys: ['t', 'settings'],
    parse: (m) => {
      const settings = settingsPatch(m.settings);
      return settings && { t: 'settings', settings };
    },
  },
  start: {
    keys: ['t'],
    parse: () => ({ t: 'start' }),
  },
  backToLobby: {
    keys: ['t'],
    parse: () => ({ t: 'backToLobby' }),
  },
  chat: {
    keys: ['t', 'text'],
    parse: ({ text }) => (isText(text, RAW_CHAT) ? { t: 'chat', text } : null),
  },
  input: {
    keys: ['t', 'seq', 'input', 'cmds'],
    parse: (m) => {
      const { seq, cmds } = m;
      const input = avatarInput(m.input);
      if (!input || !isInt(seq, 1, Number.MAX_SAFE_INTEGER) || !Array.isArray(cmds) || cmds.length > MAX_FRAME_COMMANDS) {
        return null;
      }
      const out: Command[] = [];
      for (const c of cmds) {
        const cmd = parseCommand(c);
        if (!cmd) return null;
        out.push(cmd);
      }
      return { t: 'input', seq, input, cmds: out };
    },
  },
  ping: {
    keys: ['t', 'id', 'clientTime'],
    parse: ({ id, clientTime }) =>
      isInt(id, 0, Number.MAX_SAFE_INTEGER) && isNum(clientTime) ? { t: 'ping', id, clientTime } : null,
  },
};

/**
 * Parse one client text frame. A hello from another protocol version comes back with only its
 * `protocol` filled in (other fields blank), whatever its shape, so the host can answer with a
 * reload hint instead of silence.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRec(v)) return null;
  const { t, protocol } = v;
  if (!isKeyOf(MESSAGES, t)) return null;
  if (t === 'hello' && isInt(protocol, 0) && protocol !== PROTOCOL_VERSION) {
    return { t: 'hello', protocol, name: '', password: '', token: null };
  }
  const entry = MESSAGES[t];
  return exact(v, entry.keys) ? entry.parse(v) : null;
}

/**
 * Lattice indices inside the running match's arrays. The simulation guards most of them itself;
 * this also keeps a plan from filling up with node ids that do not exist.
 */
export function fitsLattice(cmd: Command, lat: LatticeSizes): boolean {
  switch (cmd.t) {
    case 'plant':
    case 'ability':
      return cmd.node < lat.nodes;
    case 'build':
      return cmd.edge < lat.edges && cmd.facet < lat.facets;
    case 'placeBuilding':
      return cmd.facet < lat.facets;
    case 'plan':
    case 'gcc':
      for (const n of cmd.nodes) if (n >= lat.nodes) return false;
      return true;
    case 'order':
      return cmd.order === null || cmd.order.kind !== 'plant' || cmd.order.node < lat.nodes;
    default:
      return true;
  }
}
