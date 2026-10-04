import { describe, expect, it } from 'vitest';
import type { Command, CommandType } from '../sim/commands';
import { MAX_CHAT_LENGTH, MAX_CLIENT_MESSAGE_BYTES, MAX_FRAME_COMMANDS, MAX_NAME_LENGTH, PROTOCOL_VERSION } from './protocol';
import type { ClientMessage } from './protocol';
import { fitsLattice, parseClientMessage, parseCommand } from './validate';
import { normalizeMatch } from '../sim/matchSettings';

const INPUT = { moveX: 0.5, moveZ: -1, jump: false, sprint: true, yaw: 1.25, pitch: -0.3 };
const AT = { x: 10.5, z: -20 };

/** At least one valid sample per Command variant (every HippieOrder kind, sentinel ids). */
const VALID: Command[] = [
  { t: 'avatarInput', faction: 0, input: INPUT },
  { t: 'avatarInput', faction: 0, input: { ...INPUT, throwMode: true } },
  { t: 'plant', faction: 1, node: 12 },
  { t: 'throw', faction: 2 },
  { t: 'pull', faction: 3, flagId: 44 },
  { t: 'pull', faction: 0, flagId: -1 },
  { t: 'swing', faction: 0 },
  { t: 'build', faction: 0, kind: 'wall', edge: 7, facet: -1, level: 0, rampEdge: 0 },
  { t: 'build', faction: 0, kind: 'ramp', edge: -1, facet: 9, level: 2, rampEdge: 3 },
  { t: 'build', faction: 0, kind: 'floor', edge: -1, facet: 9, level: 1, rampEdge: -1 },
  { t: 'demolish', faction: 0, pieceId: 101 },
  { t: 'placeBuilding', faction: 0, kind: 'drumcircle', facet: 33 },
  { t: 'plan', faction: 0, op: 'add', nodes: [1, 2, 3] },
  { t: 'plan', faction: 0, op: 'clear', nodes: [] },
  { t: 'jobWeights', faction: 0, weights: { survey: 3, raid: 0 } },
  { t: 'jobWeights', faction: 0, weights: {} },
  { t: 'order', faction: 0, hippies: [5, 6], order: { kind: 'move', to: AT } },
  { t: 'order', faction: 0, hippies: [5], order: { kind: 'pull', flagId: 8 } },
  { t: 'order', faction: 0, hippies: [5], order: { kind: 'plant', node: 3 } },
  { t: 'order', faction: 0, hippies: [5], order: { kind: 'gather', pileId: 70 } },
  { t: 'order', faction: 0, hippies: [5], order: { kind: 'defend', at: AT } },
  { t: 'order', faction: 0, hippies: [5], order: { kind: 'attack', target: 71 } },
  { t: 'order', faction: 0, hippies: [5], order: { kind: 'follow', avatarId: 2 } },
  { t: 'order', faction: 0, hippies: [5], order: { kind: 'push', gccId: 4, to: AT } },
  { t: 'order', faction: 0, hippies: [5], order: null },
  { t: 'rally', faction: 0 },
  { t: 'sendFollowers', faction: 0, at: AT, target: -1 },
  { t: 'ability', faction: 0, ability: 'phason', at: AT, node: 17 },
  { t: 'ability', faction: 0, ability: 'omega', at: AT, node: -1 },
  { t: 'align', faction: 0, chakra: 'canton' },
  { t: 'drug', faction: 0, drug: 'acidcop' },
  { t: 'brew', faction: 0, labId: 80, drug: 'dust' },
  { t: 'gcc', faction: 0, action: 'simulacra', target: -1, nodes: [4, 9] },
  { t: 'handFlag', faction: 0, hippieId: 52 },
  { t: 'pushGcc', faction: 0, on: true },
  { t: 'ping', faction: 0, kind: 'sos', at: AT },
  { t: 'retransmit', faction: 0 },
  { t: 'tapBeacon', faction: 0, beaconId: 66 },
];

/** Compiler-checked list of every Command type, so a new variant cannot go untested. */
const COMMAND_TYPES: Record<CommandType, true> = {
  avatarInput: true,
  plant: true,
  throw: true,
  pull: true,
  swing: true,
  handFlag: true,
  build: true,
  demolish: true,
  placeBuilding: true,
  plan: true,
  jobWeights: true,
  order: true,
  rally: true,
  sendFollowers: true,
  ability: true,
  align: true,
  drug: true,
  brew: true,
  gcc: true,
  pushGcc: true,
  ping: true,
  retransmit: true,
  tapBeacon: true,
};

/** Wrong in exactly one way each. */
const INVALID: [string, unknown][] = [
  ['not an object', 'plant'],
  ['an array', [{ t: 'throw', faction: 0 }]],
  ['unknown type', { t: 'teleport', faction: 0 }],
  ['inherited name as type', { t: 'constructor', faction: 0 }],
  ['faction out of range', { t: 'swing', faction: 4 }],
  ['faction as string', { t: 'swing', faction: '0' }],
  ['missing faction', { t: 'swing' }],
  ['extra key', { t: 'throw', faction: 0, power: 9000 }],
  ['prototype key', JSON.parse('{"t":"throw","faction":0,"__proto__":{"x":1}}')],
  ['missing field', { t: 'plant', faction: 0 }],
  ['fractional node', { t: 'plant', faction: 0, node: 1.5 }],
  ['negative node', { t: 'plant', faction: 0, node: -1 }],
  ['node past int32', { t: 'plant', faction: 0, node: 2 ** 31 }],
  ['pull below the -1 sentinel', { t: 'pull', faction: 0, flagId: -2 }],
  ['infinite move', { t: 'avatarInput', faction: 0, input: { ...INPUT, moveX: Infinity } }],
  ['NaN yaw', { t: 'avatarInput', faction: 0, input: { ...INPUT, yaw: NaN } }],
  ['jump as string', { t: 'avatarInput', faction: 0, input: { ...INPUT, jump: 'yes' } }],
  ['throw mode as string', { t: 'avatarInput', faction: 0, input: { ...INPUT, throwMode: 'yes' } }],
  ['input missing pitch', { t: 'avatarInput', faction: 0, input: { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0 } }],
  ['input extra key', { t: 'avatarInput', faction: 0, input: { ...INPUT, fly: true } }],
  ['unknown piece', { t: 'build', faction: 0, kind: 'tower', edge: 1, facet: -1, level: 0, rampEdge: 0 }],
  ['ramp edge 4', { t: 'build', faction: 0, kind: 'ramp', edge: -1, facet: 1, level: 0, rampEdge: 4 }],
  ['negative level', { t: 'build', faction: 0, kind: 'floor', edge: -1, facet: 1, level: -1, rampEdge: 0 }],
  ['unknown building', { t: 'placeBuilding', faction: 0, kind: 'castle', facet: 1 }],
  ['inherited building name', { t: 'placeBuilding', faction: 0, kind: 'toString', facet: 1 }],
  ['unknown plan op', { t: 'plan', faction: 0, op: 'merge', nodes: [] }],
  ['plan nodes not an array', { t: 'plan', faction: 0, op: 'add', nodes: 5 }],
  ['plan node as string', { t: 'plan', faction: 0, op: 'add', nodes: [1, '2'] }],
  ['plan too long', { t: 'plan', faction: 0, op: 'set', nodes: Array.from({ length: 4097 }, (_, i) => i) }],
  ['unknown job', { t: 'jobWeights', faction: 0, weights: { dance: 2 } }],
  ['job weight as string', { t: 'jobWeights', faction: 0, weights: { survey: '2' } }],
  ['negative hippie id', { t: 'order', faction: 0, hippies: [-3], order: null }],
  ['unknown order', { t: 'order', faction: 0, hippies: [1], order: { kind: 'dance' } }],
  ['order extra key', { t: 'order', faction: 0, hippies: [1], order: { kind: 'pull', flagId: 2, now: true } }],
  ['order missing order', { t: 'order', faction: 0, hippies: [1] }],
  ['push without destination', { t: 'order', faction: 0, hippies: [1], order: { kind: 'push', gccId: 4 } }],
  ['point missing z', { t: 'ping', faction: 0, kind: 'flag', at: { x: 1 } }],
  ['point as array', { t: 'ping', faction: 0, kind: 'flag', at: [1, 2] }],
  ['point with extra key', { t: 'ping', faction: 0, kind: 'flag', at: { x: 1, z: 2, y: 3 } }],
  ['unknown ping kind', { t: 'ping', faction: 0, kind: 'hello', at: AT }],
  ['unknown ability', { t: 'ability', faction: 0, ability: 'fireball', at: AT, node: -1 }],
  ['unknown chakra', { t: 'align', faction: 0, chakra: 'heart' }],
  ['unknown drug', { t: 'drug', faction: 0, drug: 'coffee' }],
  ['brew lab as string', { t: 'brew', faction: 0, labId: '80', drug: 'dust' }],
  ['removed gift action', { t: 'gcc', faction: 0, action: 'gift', target: 52, nodes: [] }],
  ['invalid handoff target', { t: 'handFlag', faction: 0, hippieId: -1 }],
  ['unknown gcc action', { t: 'gcc', faction: 0, action: 'nuke', target: -1, nodes: [] }],
  ['three simulacrum nodes', { t: 'gcc', faction: 0, action: 'simulacra', target: -1, nodes: [1, 2, 3] }],
  ['pushGcc as number', { t: 'pushGcc', faction: 0, on: 1 }],
  ['negative beacon', { t: 'tapBeacon', faction: 0, beaconId: -1 }],
];

/** An input frame carrying `cmds` (raw JSON). */
function input(cmds: unknown[], seq = 1): string {
  return JSON.stringify({ t: 'input', seq, input: INPUT, cmds });
}

describe('parseCommand', () => {
  it('has a valid sample for every Command type', () => {
    expect(new Set(VALID.map((c) => c.t))).toEqual(new Set(Object.keys(COMMAND_TYPES)));
  });

  it.each(VALID.map((c) => [`${c.t} ${JSON.stringify(c).slice(0, 60)}`, c] as const))('accepts %s', (_label, cmd) => {
    expect(parseCommand(JSON.parse(JSON.stringify(cmd)))).toEqual(cmd);
    expect(parseClientMessage(input([cmd]))).toEqual({ t: 'input', seq: 1, input: INPUT, cmds: [cmd] });
  });

  it.each(INVALID)('rejects %s', (_label, value) => {
    expect(parseCommand(value)).toBeNull();
  });

  it('returns fresh objects carrying only the declared fields', () => {
    const raw = { t: 'order', faction: 2, hippies: [1, 2], order: { kind: 'move', to: { x: 1, z: 2 } } };
    const cmd = parseCommand(raw);
    expect(cmd).toEqual(raw);
    expect(cmd).not.toBe(raw);
  });
});

describe('parseClientMessage', () => {
  it('accepts new match options and rejects malformed or out-of-range values', () => {
    const match = normalizeMatch({ jumpHeight: 1.5, maxSignifiers: 9, structuresBlockFlagPlacement: true });
    const message = { t: 'settings', settings: { match } };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    for (const patch of [{ jumpHeight: 0 }, { maxSignifiers: 0.5 }, { maxSignifiers: 201 }, { structuresBlockFlagPlacement: 'off' }]) {
      expect(parseClientMessage(JSON.stringify({ t: 'settings', settings: { match: { ...match, ...patch } } }))).toBeNull();
    }
  });
  const VALID_MESSAGES: ClientMessage[] = [
    { t: 'hello', protocol: PROTOCOL_VERSION, name: 'alice', password: 'saffron-pentacle-42', token: null },
    { t: 'hello', protocol: PROTOCOL_VERSION, name: 'alice', password: '', token: 'ab12' },
    { t: 'seat', seat: 2 },
    { t: 'seat', seat: null },
    { t: 'ready', ready: true },
    { t: 'settings', settings: { difficulty: 'vexillosaint' } },
    { t: 'settings', settings: { seed: null } },
    { t: 'settings', settings: { difficulty: 'chill', seed: 'my burn' } },
    { t: 'start' },
    { t: 'backToLobby' },
    { t: 'chat', text: 'There ought to be flags' },
    { t: 'input', seq: 7, input: INPUT, cmds: [] },
    { t: 'ping', id: 3, clientTime: 1234.5 },
  ];

  it.each(VALID_MESSAGES.map((m) => [JSON.stringify(m).slice(0, 70), m] as const))('accepts %s', (_label, msg) => {
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });

  const INVALID_MESSAGES: [string, string][] = [
    ['empty', ''],
    ['not JSON', '{"t":"start"'],
    ['null', 'null'],
    ['a number', '42'],
    ['an array', '[{"t":"start"}]'],
    ['unknown type', '{"t":"teleport"}'],
    ['inherited name as type', '{"t":"hasOwnProperty"}'],
    ['extra key', '{"t":"start","now":true}'],
    ['hello without token', JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, name: 'a', password: 'b' })],
    ['hello token as number', JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, name: 'a', password: 'b', token: 5 })],
    ['hello name too long', JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, name: 'n'.repeat(MAX_NAME_LENGTH * 4 + 1), password: 'b', token: null })],
    ['hello fractional protocol', JSON.stringify({ t: 'hello', protocol: 1.5, name: 'a', password: 'b', token: null })],
    ['seat out of range', '{"t":"seat","seat":4}'],
    ['seat as string', '{"t":"seat","seat":"1"}'],
    ['ready as string', '{"t":"ready","ready":"true"}'],
    ['unknown setting', '{"t":"settings","settings":{"map":"desert"}}'],
    ['unknown difficulty', '{"t":"settings","settings":{"difficulty":"insane"}}'],
    ['seed as number', '{"t":"settings","settings":{"seed":42}}'],
    ['chat as number', '{"t":"chat","text":5}'],
    ['chat too long', JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_CHAT_LENGTH * 4 + 1) })],
    ['seq 0', input([], 0)],
    ['fractional seq', input([], 1.5)],
    ['cmds not an array', JSON.stringify({ t: 'input', seq: 1, input: INPUT, cmds: {} })],
    ['too many cmds', input(Array.from({ length: MAX_FRAME_COMMANDS + 1 }, () => ({ t: 'swing', faction: 0 })))],
    ['one bad cmd among good ones', input([{ t: 'swing', faction: 0 }, { t: 'swing', faction: 9 }])],
    ['infinite clientTime', '{"t":"ping","id":1,"clientTime":1e999}'],
    ['negative ping id', '{"t":"ping","id":-1,"clientTime":0}'],
    ['over the size cap', JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) })],
  ];

  it.each(INVALID_MESSAGES)('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('accepts exactly MAX_FRAME_COMMANDS commands in one frame', () => {
    const cmds = Array.from({ length: MAX_FRAME_COMMANDS }, () => ({ t: 'swing', faction: 0 }));
    expect(parseClientMessage(input(cmds))).not.toBeNull();
  });

  it('answers a hello from another protocol version whatever its shape, so the host can explain', () => {
    expect(parseClientMessage('{"t":"hello","protocol":0,"nick":"old client"}')).toEqual({
      t: 'hello',
      protocol: 0,
      name: '',
      password: '',
      token: null,
    });
  });
});

describe('fitsLattice', () => {
  const lat = { nodes: 100, edges: 200, facets: 90 };

  it('keeps lattice indices inside the match', () => {
    expect(fitsLattice({ t: 'plant', faction: 0, node: 99 }, lat)).toBe(true);
    expect(fitsLattice({ t: 'plant', faction: 0, node: 100 }, lat)).toBe(false);
    expect(fitsLattice({ t: 'ability', faction: 0, ability: 'beacon', at: AT, node: -1 }, lat)).toBe(true);
    expect(fitsLattice({ t: 'build', faction: 0, kind: 'wall', edge: 199, facet: -1, level: 0, rampEdge: 0 }, lat)).toBe(true);
    expect(fitsLattice({ t: 'build', faction: 0, kind: 'wall', edge: 200, facet: -1, level: 0, rampEdge: 0 }, lat)).toBe(false);
    expect(fitsLattice({ t: 'build', faction: 0, kind: 'floor', edge: -1, facet: 90, level: 0, rampEdge: 0 }, lat)).toBe(false);
    expect(fitsLattice({ t: 'placeBuilding', faction: 0, kind: 'ward', facet: 90 }, lat)).toBe(false);
    expect(fitsLattice({ t: 'plan', faction: 0, op: 'add', nodes: [3, 99] }, lat)).toBe(true);
    expect(fitsLattice({ t: 'plan', faction: 0, op: 'add', nodes: [3, 5000] }, lat)).toBe(false);
    expect(fitsLattice({ t: 'gcc', faction: 0, action: 'simulacra', target: -1, nodes: [1, 100] }, lat)).toBe(false);
    expect(fitsLattice({ t: 'order', faction: 0, hippies: [1], order: { kind: 'plant', node: 100 } }, lat)).toBe(false);
    expect(fitsLattice({ t: 'order', faction: 0, hippies: [1], order: { kind: 'attack', target: 100000 } }, lat)).toBe(true);
  });
});
