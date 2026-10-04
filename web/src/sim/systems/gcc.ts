/**
 * Geomantic Command Center: passives (Geomantic Advice reveal/observe radius, Flag Repair),
 * actives (Flag Gifts, Flagellian Dialectics, Flag Simulacra), being pushed, destruction and
 * rebuild at the Hearth.
 * Owner: Economy agent.
 *
 * Geomantic Advice (reveal + Zeno observation within GCC.adviceRadius) is read from the GCC's
 * position by the survey/render systems; pushing is the avatar/hippie systems' job via
 * buildings.moveBuilding; collapse is buildings.collapseGcc.
 */
import type { CommandOf } from '../commands';
import { BUILDING_HEIGHT, BUILDINGS, GCC, GCC_REACH, GCC_REPAIR_SNAP, GCC_SIMULACRA_RANGE } from '../constants';
import { facetYaw } from '../factory';
import { matchSettings } from '../matchSettings';
import { FACTION_IDS } from '../types';
import type { AvatarAction, Building, FactionId, GccAction, Hippie } from '../types';
import type { World } from '../world';
import { isCollapsed, moveBuilding, repairBuilding } from './buildings';
import { econ } from './econ/state';
import { nearestHearth, popCap, population } from './economy';
import { canPlantAt, dropLoose, giveFlag, nearestPlantableNode, plantFlag, plantSimulacrum, takeFromStock } from './flags';
import { pieceAt, piecePosition, repairPiece } from './pieces';

export const GCC_ACTION_NAMES: Record<GccAction, string> = {
  gift: 'Flag Gifts',
  dialectics: 'Flagellian Dialectics',
  simulacra: 'Flag Simulacra',
};

const GCC_COOLDOWN: Record<GccAction, number> = {
  gift: GCC.giftCooldown,
  dialectics: GCC.dialecticsCooldown,
  simulacra: GCC.simulacraCooldown,
};

/** A rebuilt cart parks this far from its Hearth, toward the centre of the burn (as at the start). */
const PARK_DISTANCE = 9;
/** Facets considered for parking, around the preferred spot. */
const PARK_SEARCH = 24;
/** With nothing to repair, Flag Repair looks for loose Flags again after this long. */
const REPAIR_IDLE_RESCAN = 0.5;

/** Is the faction's GCC currently standing (not collapsed)? */
export function gccActive(world: World, f: FactionId): boolean {
  const g = world.gccOf(f);
  return !!g && g.gcc !== null && !isCollapsed(g);
}

/** Why the faction can't work its Command Table right now ('' = it can). UI and AI use this. */
export function gccBlocker(world: World, f: FactionId, action: GccAction): string {
  const fac = world.factions[f];
  if (!fac.alive) return 'Your camp has fallen.';
  const g = world.gccOf(f);
  if (!g || !g.gcc) return 'You have no Geomantic Command Center.';
  if (isCollapsed(g)) return 'The Command Center lies in pieces; it is being rebuilt at your Hearth.';
  const av = world.avatarOf(f);
  if (av.koUntil > world.time) return 'Flagless: wait for your vexillomancer to return.';
  const reach = GCC_REACH + BUILDINGS.gcc.radius;
  if ((av.pos.x - g.pos.x) ** 2 + (av.pos.z - g.pos.z) ** 2 > reach * reach) return `Stand at your Command Center (within ${GCC_REACH} m).`;
  // channelUntil is set for exactly as long as the Dialectics run (tendDialectics clears it),
  // and unlike economy scratch it replicates, so mirrors give the same answer.
  if (g.gcc.channelUntil > world.time) return 'The Dialectics are in session.';
  // Gifts and simulacra are instant; the Dialectics channel cannot start over another channel.
  if (action === 'dialectics' && (av.action.kind === 'align' || av.action.kind === 'channel')) return 'Already channelling: finish it first.';
  const ready = fac.cooldowns[action];
  if (ready > world.time) return `${GCC_ACTION_NAMES[action]} recharging (${Math.ceil(ready - world.time)} s).`;
  return '';
}

export function cmdGcc(world: World, c: CommandOf<'gcc'>): void {
  const f = c.faction;
  const g = world.gccOf(f);
  let why = gccBlocker(world, f, c.action);
  if (!why && g) {
    if (c.action === 'gift') why = giftFlag(world, f, g, c.target);
    else if (c.action === 'dialectics') why = beginDialectics(world, f, g);
    else why = castSimulacrum(world, f, g, c.nodes);
  }
  if (why) world.emit({ t: 'rejected', faction: f, reason: why });
}

/** Cooldown + presentation event for a completed Command Table action. */
function completeAction(world: World, f: FactionId, g: Building, action: GccAction): void {
  world.factions[f].cooldowns[action] = world.time + GCC_COOLDOWN[action];
  world.emit({ t: 'gccAction', faction: f, action, gccId: g.id, pos: { x: g.pos.x, z: g.pos.z } });
}

/** A hippie joins the camp: fresh orders, a D.E.G.E.N. beacon on the faction's mesh. */
function enlist(h: Hippie, f: FactionId): void {
  h.faction = f;
  h.order = null;
  h.job = null;
  h.status = 'idle';
  h.statusTarget = null;
  h.beacon = true;
}

function announceRecruit(world: World, h: Hippie, f: FactionId, via: 'gift' | 'dialectics'): void {
  world.factions[f].stats.hippiesRecruited++;
  world.emit({ t: 'recruited', hippieId: h.id, faction: f, via });
}

/** Flag Gifts: one Flag (Hearth stock first, else the quiver) into a neutral hippie's hands recruits it. */
function giftFlag(world: World, f: FactionId, g: Building, target: number): string {
  const h = world.hippies.get(target);
  if (!h || h.faction !== -1) return 'Flag Gifts go to unaffiliated Signifiers (neutral hippies).';
  if (h.koUntil > world.time) return 'That Signifier is out cold.';
  if (h.carryingFlag !== -1 || h.carryingLumber > 0) return 'That Signifier has its hands full.';
  if ((h.pos.x - g.pos.x) ** 2 + (h.pos.z - g.pos.z) ** 2 > GCC.giftRadius * GCC.giftRadius) {
    return `Too far: gifts reach ${GCC.giftRadius} m from the Command Center.`;
  }
  if (population(world, f) >= popCap(world, f)) return 'Your camp is full: raise a Drum Circle to make room.';
  const av = world.avatarOf(f);
  const hearth = nearestHearth(world, f, g.pos, true);
  if (!hearth && av.carried.length === 0) return 'No Flag to give: your quiver and stock are empty.';
  // A neutral hippie cannot hold a Flag: it joins first, then receives the gift.
  enlist(h, f);
  const given = hearth ? takeFromStock(world, hearth.id, h.id) !== null : giveFlag(world, av.carried[av.carried.length - 1], h.id);
  if (!given) {
    h.faction = -1;
    h.beacon = false;
    return 'The gift slipped: no Flag changed hands.';
  }
  announceRecruit(world, h, f, 'gift');
  completeAction(world, f, g, 'gift');
  return '';
}

/** Flagellian Dialectics: a rooted GCC.dialecticsChannel channel at the cart; converts on completion. */
function beginDialectics(world: World, f: FactionId, g: Building): string {
  const gc = g.gcc;
  if (!gc) return 'You have no Geomantic Command Center.';
  const action: AvatarAction = { kind: 'channel', what: 'dialectics', t: world.time, dur: GCC.dialecticsChannel };
  world.avatarOf(f).action = action;
  gc.channelUntil = world.time + GCC.dialecticsChannel;
  econ(world).dialectics[f] = { action, gccId: g.id };
  return '';
}

/** Up to GCC.dialecticsMax nearest enemy hippies around the cart change sides, dropping what they carry. */
function concludeDialectics(world: World, f: FactionId, g: Building): void {
  const ids = econ(world).idBuf;
  ids.length = 0;
  const r2 = GCC.dialecticsRadius * GCC.dialecticsRadius;
  for (const h of world.hippies.values()) {
    if (h.faction === f || h.faction === -1 || h.koUntil > world.time) continue;
    if ((h.pos.x - g.pos.x) ** 2 + (h.pos.z - g.pos.z) ** 2 <= r2) ids.push(h.id);
  }
  const d2 = (id: number): number => {
    const h = world.hippies.get(id);
    return h ? (h.pos.x - g.pos.x) ** 2 + (h.pos.z - g.pos.z) ** 2 : Infinity;
  };
  ids.sort((a, b) => d2(a) - d2(b) || a - b);
  let converted = 0;
  const capacity = Math.max(0, matchSettings(world.options).maxSignifiers - population(world, f));
  for (const id of ids) {
    if (converted >= Math.min(GCC.dialecticsMax, capacity)) break;
    const h = world.hippies.get(id);
    if (!h) continue;
    if (h.carryingFlag !== -1) dropLoose(world, h.carryingFlag, { x: h.pos.x, y: 0, z: h.pos.z });
    enlist(h, f);
    announceRecruit(world, h, f, 'dialectics');
    converted++;
  }
  ids.length = 0;
  if (converted > 0) completeAction(world, f, g, 'dialectics');
  else world.emit({ t: 'notify', faction: f, text: `The Dialectics found no enemy ears within ${GCC.dialecticsRadius} m.`, severity: 'info', pos: { x: g.pos.x, z: g.pos.z } });
}

/**
 * Finish or drop dialectics channels. A replaced action means the avatar acted, was hit or fell
 * (the avatar systems ended it); a collapsed cart or KO still holding the channel ends it here.
 */
function tendDialectics(world: World): void {
  const st = econ(world);
  for (const f of FACTION_IDS) {
    const ch = st.dialectics[f];
    if (!ch) continue;
    const av = world.avatarOf(f);
    const g = world.buildings.get(ch.gccId);
    const act = av.action;
    const replaced = act !== ch.action || act.kind !== 'channel';
    if (replaced || !g || !g.gcc || isCollapsed(g) || av.koUntil > world.time) {
      st.dialectics[f] = null;
      if (g && g.gcc) g.gcc.channelUntil = 0;
      if (!replaced) av.action = { kind: 'idle' };
      continue;
    }
    if (world.time - act.t < act.dur) continue;
    st.dialectics[f] = null;
    g.gcc.channelUntil = 0;
    av.action = { kind: 'idle' };
    concludeDialectics(world, f, g);
  }
}

/**
 * Flag Simulacra: one Flag (quiver first, else Hearth stock) planted superposed on two free
 * nodes, both within GCC_SIMULACRA_RANGE of the cart. Collapse on observation is the survey's.
 */
function castSimulacrum(world: World, f: FactionId, g: Building, nodes: number[]): string {
  const lat = world.lattice;
  if (nodes.length !== 2) return 'Choose two Ley Nodes for the simulacrum.';
  const a = nodes[0];
  const b = nodes[1];
  for (const n of nodes) {
    if (!Number.isInteger(n) || n < 0 || n >= lat.nodes.length) return 'Choose two Ley Nodes for the simulacrum.';
  }
  if (a === b) return 'A simulacrum needs two different nodes.';
  const range2 = GCC_SIMULACRA_RANGE * GCC_SIMULACRA_RANGE;
  for (const n of nodes) {
    const node = lat.nodes[n];
    if ((node.x - g.pos.x) ** 2 + (node.z - g.pos.z) ** 2 > range2) return `Both nodes must lie within ${GCC_SIMULACRA_RANGE} m of the Command Center.`;
  }
  if (!canPlantAt(world, a, f) || !canPlantAt(world, b, f)) return 'Both nodes must be free and plantable.';
  const av = world.avatarOf(f);
  let flagId = av.carried.length > 0 ? av.carried[av.carried.length - 1] : -1;
  if (flagId === -1) {
    const hearth = nearestHearth(world, f, g.pos, true);
    const fl = hearth ? takeFromStock(world, hearth.id, av.id) : null;
    if (!fl) return 'No Flag to spend: your quiver and stock are empty.';
    flagId = fl.id;
  }
  if (!plantSimulacrum(world, flagId, a, b, f, av.id)) return 'The simulacrum would not take.';
  completeAction(world, f, g, 'simulacra');
  return '';
}

/** Flag Repair: re-plant the nearest own loose Flag in range that has a free node close by. */
function replantOne(world: World, f: FactionId, g: Building): boolean {
  const ids = econ(world).idBuf;
  ids.length = 0;
  const r2 = GCC.repairRadius * GCC.repairRadius;
  for (const fl of world.flags.values()) {
    if (fl.state !== 'loose' || fl.owner !== f) continue;
    if ((fl.pos.x - g.pos.x) ** 2 + (fl.pos.z - g.pos.z) ** 2 <= r2) ids.push(fl.id);
  }
  if (ids.length === 0) return false;
  const d2 = (id: number): number => {
    const fl = world.flags.get(id);
    return fl ? (fl.pos.x - g.pos.x) ** 2 + (fl.pos.z - g.pos.z) ** 2 : Infinity;
  };
  ids.sort((a, b) => d2(a) - d2(b) || a - b);
  let planted = false;
  for (const id of ids) {
    const fl = world.flags.get(id);
    if (!fl) continue;
    const node = nearestPlantableNode(world, fl.pos, GCC_REPAIR_SNAP, f);
    if (node >= 0 && plantFlag(world, id, node, f, g.id)) {
      planted = true;
      break;
    }
  }
  ids.length = 0;
  return planted;
}

/** Flag Repair passives: a Flag re-planted every GCC.repairInterval, +GCC.repairHps to own pieces/buildings in range. */
function flagRepair(world: World, f: FactionId, g: Building, dt: number): void {
  const st = econ(world);
  // A charged repair fires as soon as a loose Flag turns up (rescanning twice a second), then waits the interval.
  const timer = Math.min(GCC.repairInterval, st.gccRepairTimer[f] + dt);
  st.gccRepairTimer[f] = timer;
  if (timer >= GCC.repairInterval) st.gccRepairTimer[f] = replantOne(world, f, g) ? 0 : GCC.repairInterval - REPAIR_IDLE_RESCAN;
  const heal = GCC.repairHps * dt;
  const r2 = GCC.repairRadius * GCC.repairRadius;
  for (const p of world.pieces.values()) {
    if (p.faction !== f || p.hp >= p.maxHp) continue;
    const pos = piecePosition(world, p);
    if (pos && (pos.x - g.pos.x) ** 2 + (pos.z - g.pos.z) ** 2 <= r2) repairPiece(p, heal);
  }
  for (const b of world.buildings.values()) {
    if (b === g || b.faction !== f || (!b.disabled && b.hp >= b.maxHp)) continue;
    const reach = GCC.repairRadius + BUILDINGS[b.kind].radius;
    if ((b.pos.x - g.pos.x) ** 2 + (b.pos.z - g.pos.z) ** 2 <= reach * reach) repairBuilding(world, b, heal);
  }
}

/** Where a rebuilt cart parks: a free Sun facet near the spot beside the Hearth, or -1 if the camp is packed. */
function parkingFacet(world: World, hearth: Building, g: Building): number {
  const lat = world.lattice;
  const toCentre = Math.hypot(hearth.pos.x, hearth.pos.z) || 1;
  const px = hearth.pos.x - (hearth.pos.x / toCentre) * PARK_DISTANCE;
  const pz = hearth.pos.z - (hearth.pos.z / toCentre) * PARK_DISTANCE;
  const r = BUILDINGS.gcc.radius;
  let best = -1;
  let bestD = Infinity;
  for (const id of lat.facetsInRadius(px, pz, PARK_SEARCH)) {
    const fc = lat.facets[id];
    if (!fc.thick || fc.boundary) continue;
    const d = (fc.cx - px) ** 2 + (fc.cz - pz) ** 2;
    if (d >= bestD) continue;
    if (fc.nodes.some((n) => lat.nodes[n].blocked) || pieceAt(world, 'floor', -1, id, 0)) continue;
    let clear = true;
    for (const b of world.buildings.values()) {
      if (b === g || isCollapsed(b)) continue;
      const min = r + BUILDINGS[b.kind].radius + 0.5;
      if ((b.pos.x - fc.cx) ** 2 + (b.pos.z - fc.cz) ** 2 < min * min) {
        clear = false;
        break;
      }
    }
    if (!clear || world.collision.blockedCircle(fc.cx, fc.cz, r, 0.2, BUILDING_HEIGHT.gcc)) continue;
    best = id;
    bestD = d;
  }
  return best;
}

/** The cart is rebuilt beside the Hearth once its rebuild time (finite) has passed. */
function rebuild(world: World, f: FactionId, g: Building): void {
  const gc = g.gcc;
  if (!gc || gc.destroyedUntil === 0 || gc.destroyedUntil > world.time) return;
  const hearth = world.hearthOf(f);
  if (!hearth) return;
  const facet = parkingFacet(world, hearth, g);
  if (facet < 0) return;
  gc.destroyedUntil = 0;
  gc.channelUntil = 0;
  gc.pushedBy = -1;
  g.hp = g.maxHp;
  g.disabled = false;
  g.built = 1;
  g.yaw = facetYaw(world, facet);
  const fc = world.lattice.facets[facet];
  moveBuilding(world, g, fc.cx, fc.cz);
  world.emit({ t: 'gccRebuilt', faction: f, gccId: g.id, pos: { x: g.pos.x, z: g.pos.z } });
}

export function updateGcc(world: World, dt: number): void {
  tendDialectics(world);
  for (const f of FACTION_IDS) {
    if (!world.factions[f].alive) continue;
    const g = world.gccOf(f);
    if (!g || !g.gcc) continue;
    if (isCollapsed(g)) rebuild(world, f, g);
    if (!isCollapsed(g)) flagRepair(world, f, g, dt);
  }
}
