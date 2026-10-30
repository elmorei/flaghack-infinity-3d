/**
 * Chakra alignment (ritual economy, 4 s channel from anywhere) and the five point-and-click
 * abilities: Priority Beacon, Forced March, Stabilize Zone, Phason Shift, Omega Pulse.
 * Zones live in world.zones; Phason Shift routes through tides.applyFlip(…, 'ability').
 * Owner: Economy agent.
 */
import type { CommandOf } from '../commands';
import { BOSS_OMEGA_DAMAGE } from '../boss';
import { ABILITY, ALIGN_COST, ALIGN_TIME, BUILDINGS, MAP_HALF } from '../constants';
import { spawnZone } from '../factory';
import { clamp, distToSegment } from '../math';
import type { V2 } from '../math';
import { FACTION_IDS } from '../types';
import type { AbilityId, Avatar, AvatarAction, ChakraId, EntityId, FactionId, Flag, HippieOrder } from '../types';
import type { World } from '../world';
import { isCollapsed } from './buildings';
import { interruptBossGrab } from './boss';
import { bossEncounterActive } from './boss/damage';
import { damageEntity, knockback } from './combat';
import { wallSegment } from './econ/pieceGeometry';
import { econ } from './econ/state';
import { applyEffect } from './effects';
import { canPlantAt, plantFlag, pullFlag } from './flags';
import { applyFlip } from './tides';

export const CHAKRA_NAMES: Record<ChakraId, string> = {
  hoist: 'Hoist',
  fly: 'Fly',
  canton: 'Canton',
  field: 'Field',
  finial: 'Finial',
};

export const ABILITY_NAMES: Record<AbilityId, string> = {
  beacon: 'Priority Beacon',
  march: 'Forced March',
  stabilize: 'Stabilize Zone',
  phason: 'Phason Shift',
  omega: 'Omega Pulse',
};

/** The chakra that powers each ability (inverse of CHAKRA_ABILITY). */
export const ABILITY_CHAKRA: Record<AbilityId, ChakraId> = {
  beacon: 'hoist',
  march: 'fly',
  stabilize: 'canton',
  phason: 'field',
  omega: 'finial',
};

/** Visual radius of a single-node Phason Shift glitch. */
const PHASON_SINGLE_RADIUS = 2.5;
/** Omega Pulse flings knocked-loose Flags this far outward. */
const OMEGA_FLING = 2.5;
/** Beacon target pick radius for units and walls (Flags use ABILITY.beacon.targetReach). */
const BEACON_UNIT_REACH = 2;
const BEACON_WALL_REACH = 1.5;
/** A beacon on a lumber pile sends hippies to gather it. */
const BEACON_PILE_REACH = 3;

const SEG = [0, 0, 0, 0];

// ── Alignment ────────────────────────────────────────────────────────────────

/** Why the chakra can't be aligned right now ('' = it can). UI and AI use this. */
export function alignBlocker(world: World, f: FactionId, chakra: ChakraId): string {
  const fac = world.factions[f];
  if (!fac.alive) return 'Your camp has fallen.';
  if (fac.controlMode === 'rts') return 'This action requires a roaming vexillomancer.';
  const av = world.avatarOf(f);
  if (av.koUntil > world.time) return 'Flagless: wait for your vexillomancer to return.';
  const level = fac.chakras[chakra];
  if (level >= ALIGN_COST.length) return `The ${CHAKRA_NAMES[chakra]} chakra is fully aligned.`;
  if (av.action.kind === 'align') return 'Already aligning a chakra.';
  if (av.action.kind === 'channel') return 'Already channelling: finish it first.';
  const cost = ALIGN_COST[level];
  if (fac.ritual < cost) return `Needs ${cost} Ritual (you have ${Math.floor(fac.ritual)}).`;
  return '';
}

/** Start the ALIGN_TIME channel; Ritual is only spent when it completes. */
export function cmdAlign(world: World, c: CommandOf<'align'>): void {
  const why = alignBlocker(world, c.faction, c.chakra);
  if (why) {
    world.emit({ t: 'rejected', faction: c.faction, reason: why });
    return;
  }
  const action: AvatarAction = { kind: 'align', chakra: c.chakra, t: world.time };
  world.avatarOf(c.faction).action = action;
  econ(world).aligning[c.faction] = { chakra: c.chakra, action };
  world.emit({ t: 'alignStart', faction: c.faction, chakra: c.chakra });
}

/**
 * Finish or drop alignment channels. A replaced action means avatars/combat already ended it
 * (and reported the interruption); a KO still holding the channel is ended here.
 */
function tendAlignments(world: World): void {
  const st = econ(world);
  for (const f of FACTION_IDS) {
    const ch = st.aligning[f];
    if (!ch) continue;
    const av = world.avatarOf(f);
    if (!av) { st.aligning[f] = null; continue; }
    const act = av.action;
    if (act !== ch.action || act.kind !== 'align') {
      st.aligning[f] = null;
      continue;
    }
    if (av.koUntil > world.time) {
      st.aligning[f] = null;
      av.action = { kind: 'idle' };
      world.emit({ t: 'alignInterrupted', faction: f, chakra: ch.chakra });
      continue;
    }
    if (world.time - act.t < ALIGN_TIME) continue;
    st.aligning[f] = null;
    av.action = { kind: 'idle' };
    const fac = world.factions[f];
    const level = fac.chakras[ch.chakra];
    // Ritual may have been spent elsewhere during the channel.
    if (level >= ALIGN_COST.length || fac.ritual < ALIGN_COST[level]) {
      world.emit({ t: 'alignInterrupted', faction: f, chakra: ch.chakra });
      continue;
    }
    fac.ritual -= ALIGN_COST[level];
    fac.chakras[ch.chakra] = level + 1;
    world.emit({ t: 'aligned', faction: f, chakra: ch.chakra, level: level + 1 });
  }
}

// ── Abilities ────────────────────────────────────────────────────────────────

/** Why an ability can't be cast right now ('' = castable). UI and AI use this. */
export function abilityBlocker(world: World, f: FactionId, a: AbilityId): string {
  const fac = world.factions[f];
  if (!fac.alive) return 'Your camp has fallen.';
  if (fac.controlMode === 'rts') return 'This action requires a roaming vexillomancer.';
  const chakra = ABILITY_CHAKRA[a];
  if (fac.chakras[chakra] <= 0) return `Align the ${CHAKRA_NAMES[chakra]} chakra first.`;
  if (world.avatarOf(f).koUntil > world.time) return 'Flagless: wait for your vexillomancer to return.';
  const ready = fac.cooldowns[a];
  if (ready > world.time) return `${ABILITY_NAMES[a]} recharging (${Math.ceil(ready - world.time)} s).`;
  return '';
}

export function cmdAbility(world: World, c: CommandOf<'ability'>): void {
  const f = c.faction;
  const why = abilityBlocker(world, f, c.ability);
  if (why) {
    world.emit({ t: 'rejected', faction: f, reason: why });
    return;
  }
  const fac = world.factions[f];
  const level = fac.chakras[ABILITY_CHAKRA[c.ability]];
  const av = world.avatarOf(f);
  let result: V2 | string;
  switch (c.ability) {
    case 'beacon':
      result = castBeacon(world, f, level, c.at, c.node);
      break;
    case 'march':
      result = castMarch(world, f, av, level);
      break;
    case 'stabilize':
      result = castStabilize(world, f, av, level, c.at);
      break;
    case 'phason':
      result = castPhason(world, f, av, level, c.at, c.node);
      break;
    case 'omega':
      result = castOmega(world, f, av, level);
      break;
  }
  if (typeof result === 'string') {
    world.emit({ t: 'rejected', faction: f, reason: result });
    return;
  }
  fac.cooldowns[c.ability] = world.time + ABILITY[c.ability].cooldown;
  world.emit({ t: 'ability', faction: f, ability: c.ability, level, pos: result, by: av.id });
}

/** What a Priority Beacon at `at` points hippies at: enemy Flag, structure or unit; -1 = the spot itself. */
function beaconTarget(world: World, f: FactionId, at: V2): EntityId | -1 {
  if (bossEncounterActive(world)) {
    const boss = world.boss;
    return boss && boss.hp > 0 && Math.hypot(at.x - boss.pos.x, at.z - boss.pos.z) <= 9 ? boss.id : -1;
  }
  let best: EntityId | -1 = -1;
  let bestD = ABILITY.beacon.targetReach ** 2;
  for (const fl of world.flags.values()) {
    if (fl.owner === f || (fl.state !== 'planted' && fl.state !== 'loose')) continue;
    const d = (fl.pos.x - at.x) ** 2 + (fl.pos.z - at.z) ** 2;
    if (d <= bestD) {
      best = fl.id;
      bestD = d;
    }
  }
  if (best !== -1) return best;
  for (const b of world.buildings.values()) {
    if (b.faction === f || isCollapsed(b)) continue;
    const r = BUILDINGS[b.kind].radius + 1;
    if ((b.pos.x - at.x) ** 2 + (b.pos.z - at.z) ** 2 <= r * r) return b.id;
  }
  const lat = world.lattice;
  let facet = -2;
  for (const p of world.pieces.values()) {
    if (p.faction === f) continue;
    if (p.kind === 'wall') {
      wallSegment(lat, p.edge, SEG);
      if (distToSegment(at.x, at.z, SEG[0], SEG[1], SEG[2], SEG[3]) <= BEACON_WALL_REACH) return p.id;
    } else {
      if (facet === -2) facet = lat.facetAt(at.x, at.z);
      if (p.facet === facet) return p.id;
    }
  }
  const unit2 = BEACON_UNIT_REACH * BEACON_UNIT_REACH;
  for (const h of world.hippies.values()) {
    if (h.faction === f || h.faction === -1 || h.koUntil > world.time) continue;
    if ((h.pos.x - at.x) ** 2 + (h.pos.z - at.z) ** 2 <= unit2) return h.id;
  }
  for (const av of world.avatars.values()) {
    if (av.faction === f || av.koUntil > world.time) continue;
    if ((av.pos.x - at.x) ** 2 + (av.pos.z - at.z) ** 2 <= unit2) return av.id;
  }
  return -1;
}

/** The contextual job a Priority Beacon calls for: pull, attack, plant a planned node, gather, or hold the spot. */
function beaconOrder(world: World, f: FactionId, at: V2, node: number, target: EntityId | -1): HippieOrder {
  if (target !== -1) return world.flags.has(target) ? { kind: 'pull', flagId: target } : { kind: 'attack', target };
  const lat = world.lattice;
  const plan = world.factions[f].plan;
  const planned = plan.has(node) ? node : lat.nearestNode(at.x, at.z, ABILITY.beacon.targetReach, (n) => plan.has(n.id));
  if (planned >= 0 && canPlantAt(world, planned, f)) return { kind: 'plant', node: planned };
  for (const p of world.piles.values()) {
    if (p.lumber > 0 && (p.pos.x - at.x) ** 2 + (p.pos.z - at.z) ** 2 <= BEACON_PILE_REACH * BEACON_PILE_REACH) {
      return { kind: 'gather', pileId: p.id };
    }
  }
  return { kind: 'defend', at: { x: at.x, z: at.z } };
}

/**
 * Priority Beacon: own hippies near the beacon drop work and rush the contextual job there,
 * through the same 'order' command the Command View issues (applied next tick).
 */
function castBeacon(world: World, f: FactionId, level: number, at: V2, node: number): V2 | string {
  const cfg = ABILITY.beacon;
  const radius = cfg.radius[level - 1];
  const r2 = radius * radius;
  const called: EntityId[] = [];
  for (const h of world.hippies.values()) {
    if (h.faction !== f || h.koUntil > world.time) continue;
    if ((h.pos.x - at.x) ** 2 + (h.pos.z - at.z) ** 2 <= r2) called.push(h.id);
  }
  if (called.length === 0) return 'No Signifiers within reach of the beacon.';
  const target = beaconTarget(world, f, at);
  const order = beaconOrder(world, f, at, node, target);
  const zoneTarget = target !== -1 ? target : order.kind === 'gather' ? order.pileId : -1;
  const zone = spawnZone(world, 'beacon', f, at, radius, cfg.duration, level, zoneTarget);
  for (const id of called) {
    const h = world.hippies.get(id);
    if (h) applyEffect(world, h, 'beacon', cfg.duration, 1, zone.id);
  }
  world.submit({ t: 'order', faction: f, hippies: called, order });
  return { x: at.x, z: at.z };
}

/** Forced March: nearby own hippies speed up; exhaustion follows when it lapses (tendMarches). */
function castMarch(world: World, f: FactionId, av: Avatar, level: number): V2 | string {
  const cfg = ABILITY.march;
  const duration = cfg.duration[level - 1];
  const until = world.time + duration;
  const marching = econ(world).marching;
  const r2 = cfg.radius * cfg.radius;
  let marched = 0;
  for (const h of world.hippies.values()) {
    if (h.faction !== f || h.koUntil > world.time) continue;
    if ((h.pos.x - av.pos.x) ** 2 + (h.pos.z - av.pos.z) ** 2 > r2) continue;
    applyEffect(world, h, 'march', duration, cfg.mag, av.id);
    const prev = marching.get(h.id);
    marching.set(h.id, { faction: f, until: Math.max(until, prev ? prev.until : 0) });
    marched++;
  }
  if (marched === 0) return `No Signifiers within ${cfg.radius} m to march.`;
  return { x: av.pos.x, z: av.pos.z };
}

function castStabilize(world: World, f: FactionId, av: Avatar, level: number, at: V2): V2 | string {
  const cfg = ABILITY.stabilize;
  if ((at.x - av.pos.x) ** 2 + (at.z - av.pos.z) ** 2 > cfg.range * cfg.range) return `Out of range: cast within ${cfg.range} m.`;
  spawnZone(world, 'stabilize', f, at, cfg.radius[level - 1], cfg.duration, level);
  return { x: at.x, z: at.z };
}

/**
 * Phason Shift: L1 flips the targeted node (or the nearest flippable one within pickRadius),
 * L2/L3 every flippable node within the level radius, nearest first. Stabilize Zones (and
 * building corners) refuse in applyFlip; nothing turning costs no cooldown.
 */
function castPhason(world: World, f: FactionId, av: Avatar, level: number, at: V2, node: number): V2 | string {
  const cfg = ABILITY.phason;
  const lat = world.lattice;
  const validNode = Number.isInteger(node) && node >= 0 && node < lat.nodes.length;
  const cx = validNode ? lat.nodes[node].x : at.x;
  const cz = validNode ? lat.nodes[node].z : at.z;
  if ((cx - av.pos.x) ** 2 + (cz - av.pos.z) ** 2 > cfg.range * cfg.range) return `Out of range: cast within ${cfg.range} m.`;
  const nodes = econ(world).nodeBuf;
  nodes.length = 0;
  if (level === 1) {
    const pick = validNode && lat.flippable(node) ? node : lat.nearestNode(cx, cz, cfg.pickRadius, (n) => lat.flippable(n.id));
    if (pick < 0) return 'No Ley Node here can turn: only three-edge nodes flip.';
    nodes.push(pick);
  } else {
    lat.nodesInRadius(cx, cz, cfg.radius[level - 1], nodes);
    let kept = 0;
    for (const n of nodes) if (lat.flippable(n)) nodes[kept++] = n;
    nodes.length = kept;
    if (kept === 0) return 'Nothing within reach can turn: only three-edge nodes flip.';
    const d2 = (n: number): number => (lat.nodes[n].x - cx) ** 2 + (lat.nodes[n].z - cz) ** 2;
    nodes.sort((a, b) => d2(a) - d2(b) || a - b);
  }
  let turned = 0;
  for (const n of nodes) if (!phasonHurtsAlly(world, f, n) && applyFlip(world, n, 'ability')) turned++;
  nodes.length = 0;
  if (turned === 0) return 'The Crystal holds here: Stabilized, or anchored under a building.';
  const pos = { x: cx, z: cz };
  spawnZone(world, 'phason', f, pos, level === 1 ? PHASON_SINGLE_RADIUS : cfg.radius[level - 1], cfg.zoneTime, level);
  return pos;
}

/** Is a planted Flag (either node of a simulacrum) within r2 of (x, z)? */
function flagWithin(world: World, fl: Flag, x: number, z: number, r2: number): boolean {
  if ((fl.pos.x - x) ** 2 + (fl.pos.z - z) ** 2 <= r2) return true;
  if (fl.altNode < 0) return false;
  const n = world.lattice.nodes[fl.altNode];
  return (n.x - x) ** 2 + (n.z - z) ** 2 <= r2;
}

/**
 * Omega Pulse around the vexillomancer: enemy hippies take damage and are thrown back, enemy
 * planted Flags close in are knocked loose (Stabilized L3 Flags hold), and at L3 the quiver
 * plants itself on free nodes in the radius, planned nodes first.
 */
function castOmega(world: World, f: FactionId, av: Avatar, level: number): V2 {
  const cfg = ABILITY.omega;
  const radius = cfg.radius[level - 1];
  const cx = av.pos.x;
  const cz = av.pos.z;
  const centre = { x: cx, z: cz };
  spawnZone(world, 'omega', f, centre, radius, cfg.zoneTime, level);
  const r2 = radius * radius;
  const boss = world.boss;
  if (boss && (boss.pos.x - cx) ** 2 + (boss.pos.z - cz) ** 2 <= r2 && damageEntity(world, boss.id, BOSS_OMEGA_DAMAGE, av.id)) {
    interruptBossGrab(world);
  }
  for (const h of world.hippies.values()) {
    if (h.faction === f || h.faction === -1 || h.koUntil > world.time) continue;
    if ((h.pos.x - cx) ** 2 + (h.pos.z - cz) ** 2 > r2) continue;
    if (damageEntity(world, h.id, cfg.damage, av.id) && h.koUntil <= world.time) knockback(world, h.id, centre, cfg.knockback);
  }

  const st = econ(world);
  const loose = st.idBuf;
  loose.length = 0;
  const loose2 = (radius * cfg.looseFraction) ** 2;
  for (const fl of world.flags.values()) {
    // pullFlag itself refuses Flags held by an L3 Stabilize Zone.
    if (fl.state === 'planted' && fl.owner !== f && !(bossEncounterActive(world) && fl.owner >= 0) && flagWithin(world, fl, cx, cz, loose2)) loose.push(fl.id);
  }
  const edge = MAP_HALF - 1;
  for (const id of loose) {
    const fl = world.flags.get(id);
    if (!fl) continue;
    const dx = fl.pos.x - cx;
    const dz = fl.pos.z - cz;
    const d = Math.hypot(dx, dz) || 1;
    const dropAt = { x: clamp(fl.pos.x + (dx / d) * OMEGA_FLING, -edge, edge), y: 0, z: clamp(fl.pos.z + (dz / d) * OMEGA_FLING, -edge, edge) };
    pullFlag(world, id, -1, dropAt);
  }
  loose.length = 0;

  if (level >= 3 && av.carried.length > 0) {
    const nodes = st.nodeBuf;
    nodes.length = 0;
    world.lattice.nodesInRadius(cx, cz, radius, nodes);
    const plan = world.factions[f].plan;
    const lat = world.lattice;
    const rank = (n: number): number => (plan.has(n) ? 0 : 1e6) + (lat.nodes[n].x - cx) ** 2 + (lat.nodes[n].z - cz) ** 2;
    nodes.sort((a, b) => rank(a) - rank(b) || a - b);
    for (const n of nodes) {
      if (av.carried.length === 0) break;
      if (canPlantAt(world, n, f)) plantFlag(world, av.carried[av.carried.length - 1], n, f, av.id);
    }
    nodes.length = 0;
  }
  return centre;
}

/** Forced March lapses: −attention and a short exhaustion slow. */
function tendMarches(world: World): void {
  const marching = econ(world).marching;
  if (marching.size === 0) return;
  const cfg = ABILITY.march;
  for (const [id, m] of marching) {
    if (m.until > world.time) continue;
    marching.delete(id);
    const h = world.hippies.get(id);
    if (!h || h.faction !== m.faction) continue;
    h.attention = Math.max(0, h.attention - cfg.attentionCost);
    applyEffect(world, h, 'exhausted', cfg.exhaustTime, cfg.exhaustMag, -1);
  }
}

/** Is (x, z) inside an active Stabilize Zone (any faction)? Used by tides/flags. */
export function inStabilizeZone(world: World, at: V2): boolean {
  for (const z of world.zones.values()) {
    if (z.kind !== 'stabilize' || z.until <= world.time) continue;
    if ((z.pos.x - at.x) ** 2 + (z.pos.z - at.z) ** 2 <= z.radius * z.radius) return true;
  }
  return false;
}

/**
 * Stabilize Zone L3 makes the caster's planted Flags inside it unpullable. Every pull path
 * (avatars, hippies, Omega Pulse) must check this before pulling.
 */
export function isFlagProtected(world: World, flag: Flag): boolean {
  if (flag.state !== 'planted' || flag.owner === -1) return false;
  for (const z of world.zones.values()) {
    if (z.kind !== 'stabilize' || z.level < 3 || z.faction !== flag.owner || z.until <= world.time) continue;
    if (flagWithin(world, flag, z.pos.x, z.pos.z, z.radius * z.radius)) return true;
  }
  return false;
}

export function updateAbilities(world: World, dt: number): void {
  tendAlignments(world);
  tendMarches(world);
  for (const z of world.zones.values()) if (z.until <= world.time) world.zones.delete(z.id);
}

/** A targeted topology edit must not dismantle a cooperative camp's flags or structures. */
function phasonHurtsAlly(world: World, f: FactionId, node: number): boolean {
  if (!bossEncounterActive(world)) return false;
  const lat = world.lattice, n = lat.nodes[node], touched = new Set<number>([node]);
  for (const facet of n.facets) for (const k of lat.facets[facet].nodes) touched.add(k);
  for (const k of touched) {
    const owner = world.survey.holder[k];
    if (owner >= 0 && owner !== f) return true;
  }
  for (const p of world.pieces.values()) {
    if (p.faction < 0 || p.faction === f) continue;
    if (p.kind === 'wall' ? n.edges.includes(p.edge) : n.facets.includes(p.facet)) return true;
  }
  return false;
}
