/**
 * Hippies (Signifiers): job assignment from faction job weights, direct orders, nav-grid
 * movement with separation steering, Survey/Gather/Defend/Raid/Ritual behaviours, attention
 * and distraction, shoving and tearing down pieces, KO/respawn, neutral wandering,
 * following the avatar, SOS response. Status/statusTarget always reflect what they do
 * (shared on the D.E.G.E.N. mesh).
 * The behaviour layers live in units/: jobs.ts (allocator), decide.ts (what next),
 * act.ts (doing it), move.ts (getting there), targets.ts (what matters).
 * Owner: Units agent.
 */
import { AVATAR, BUILDINGS, HIPPIE, HIPPIE_AI, MAP_HALF } from '../constants';
import type { CommandOf } from '../commands';
import type { V2 } from '../math';
import { FACTION_IDS, NEUTRAL } from '../types';
import type { EntityId, FactionId, Hippie, HippieOrder } from '../types';
import type { World } from '../world';
import { damageEntity, knockback } from './combat';
import { isDrugActive } from './drugs';
import { isHoarding, popCap } from './economy';
import { hasEffect, pruneEffects, speedMultiplier } from './effects';
import { canPlantAt } from './flags';
import { act, becomeDistracted, pickWanderSpot, wander } from './units/act';
import { beginTask, brainOf, releaseTask, setStatus } from './units/brain';
import type { Brain } from './units/brain';
import { decide, needsDecision, startEngage, startFlee } from './units/decide';
import { allocateJobs } from './units/jobs';
import { locomote, servicePathQueue, slide } from './units/move';
import { unitsState } from './units/state';
import type { UnitsState } from './units/state';
import { rivalUnitPos, structureOwner } from './units/targets';

/** Stale reservations/claims are swept this often. */
const SWEEP_INTERVAL = 1;
/** "Send followers" at a point snaps to a planned node this close. */
const PLANT_SNAP = 2.5;
/** Vexillomancers standing higher than this (on decks) are out of shoving reach. */
const SHOVE_Y = 1.2;
/** Scatter around a shared neutral spawn. */
const NEUTRAL_SCATTER = 3;

const scratch: V2 = { x: 0, z: 0 };

function reject(world: World, faction: FactionId, reason: string): void {
  world.emit({ t: 'rejected', faction, reason });
}

function inMap(p: V2): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.z) && Math.abs(p.x) <= MAP_HALF && Math.abs(p.z) <= MAP_HALF;
}

/** Can a hippie of `f` act on this order at all? */
function orderValid(world: World, f: FactionId, o: HippieOrder): boolean {
  switch (o.kind) {
    case 'move':
      return inMap(o.to);
    case 'defend':
      return inMap(o.at);
    case 'pull': {
      const fl = world.flags.get(o.flagId);
      return !!fl && (fl.state === 'planted' || fl.state === 'loose');
    }
    case 'plant':
      return Number.isInteger(o.node) && o.node >= 0 && o.node < world.lattice.nodes.length && !world.lattice.nodes[o.node].blocked;
    case 'gather':
      return world.piles.has(o.pileId);
    case 'attack': {
      const owner = structureOwner(world, o.target);
      if (owner !== undefined) return owner !== f;
      const fl = world.flags.get(o.target);
      if (fl) return fl.owner !== f;
      return rivalUnitPos(world, f, o.target, scratch);
    }
    case 'follow': {
      const av = world.avatars.get(o.avatarId);
      return !!av && av.faction === f;
    }
    case 'push': {
      const g = world.buildings.get(o.gccId);
      return !!g && g.kind === 'gcc' && g.faction === f && inMap(o.to);
    }
  }
}

/** Orders replace whatever the hippie was doing (a distracted one finishes dancing first). */
function giveOrder(world: World, h: Hippie, order: HippieOrder | null): void {
  h.order = order;
  const b = brainOf(h);
  if (b.task !== 'distracted') releaseTask(world, h, b);
}

/** Number the followers of a vexillomancer for their formation slots. */
function assignFollowerSlots(world: World, avatarId: EntityId): void {
  let k = 0;
  for (const h of world.hippies.values()) {
    if (h.order && h.order.kind === 'follow' && h.order.avatarId === avatarId) brainOf(h).slot = k++;
  }
}

/**
 * The order a hippie of `f` takes for a point/entity: rival or loose Flag → pull, rival
 * structure or unit → attack, pile → gather, free planned node → plant, else defend there.
 */
function contextualOrder(world: World, f: FactionId, at: V2, target: EntityId | -1): HippieOrder {
  if (target >= 0) {
    const fl = world.flags.get(target);
    if (fl && (fl.state === 'loose' || (fl.state === 'planted' && fl.owner !== f))) return { kind: 'pull', flagId: fl.id };
    const owner = structureOwner(world, target);
    if ((owner !== undefined && owner !== f) || rivalUnitPos(world, f, target, scratch)) return { kind: 'attack', target };
    if (world.piles.has(target)) return { kind: 'gather', pileId: target };
  }
  const node = world.lattice.nearestNode(at.x, at.z, PLANT_SNAP);
  if (node >= 0 && world.factions[f].plan.has(node) && world.survey.nodeFlag[node] < 0 && canPlantAt(world, node, f)) {
    return { kind: 'plant', node };
  }
  return { kind: 'defend', at: { x: at.x, z: at.z } };
}

export function cmdOrder(world: World, c: CommandOf<'order'>): void {
  const order = c.order;
  if (order && !orderValid(world, c.faction, order)) {
    reject(world, c.faction, 'The Signifiers cannot make sense of that order.');
    return;
  }
  let n = 0;
  for (const id of c.hippies) {
    const h = world.hippies.get(id);
    if (!h || h.faction !== c.faction) continue;
    giveOrder(world, h, order);
    n++;
  }
  if (n === 0) {
    reject(world, c.faction, 'None of those Signifiers answer to you.');
    return;
  }
  if (order && order.kind === 'follow') assignFollowerSlots(world, order.avatarId);
}

export function cmdRally(world: World, c: CommandOf<'rally'>): void {
  const av = world.avatarOf(c.faction);
  if (av.koUntil > 0) return;
  const order: HippieOrder = { kind: 'follow', avatarId: av.id };
  const r2 = HIPPIE_AI.rallyRadius * HIPPIE_AI.rallyRadius;
  let n = 0;
  for (const h of world.hippies.values()) {
    if (h.faction !== c.faction || h.status === 'ko') continue;
    if ((h.pos.x - av.pos.x) ** 2 + (h.pos.z - av.pos.z) ** 2 > r2) continue;
    n++;
    if (h.order && h.order.kind === 'follow' && h.order.avatarId === av.id) continue;
    giveOrder(world, h, order);
  }
  if (n === 0) {
    reject(world, c.faction, 'No Signifiers within earshot.');
    return;
  }
  assignFollowerSlots(world, av.id);
  world.emit({ t: 'notify', faction: c.faction, text: `${n} Signifier${n === 1 ? '' : 's'} fall in behind you.`, severity: 'info' });
}

export function cmdSendFollowers(world: World, c: CommandOf<'sendFollowers'>): void {
  if (!inMap(c.at)) {
    reject(world, c.faction, 'The D.E.G.E.N. compass cannot point there.');
    return;
  }
  const avatarId = world.factions[c.faction].avatarId;
  const order = contextualOrder(world, c.faction, c.at, c.target);
  let n = 0;
  for (const h of world.hippies.values()) {
    if (h.faction !== c.faction || !h.order || h.order.kind !== 'follow' || h.order.avatarId !== avatarId) continue;
    giveOrder(world, h, order);
    n++;
  }
  if (n === 0) reject(world, c.faction, 'No Signifiers are following you.');
}

export function updateHippies(world: World, dt: number): void {
  const sys = unitsState(world);
  census(world, sys);
  servicePathQueue(world, sys);
  if (world.time >= sys.nextSweepAt) {
    sweepClaims(world, sys);
    sys.nextSweepAt = world.time + SWEEP_INTERVAL;
  }
  for (const f of FACTION_IDS) {
    if (world.time < sys.nextAllocAt[f]) continue;
    sys.nextAllocAt[f] = world.time + HIPPIE_AI.jobInterval;
    allocateJobs(world, sys, f);
  }
  for (const h of world.hippies.values()) updateHippie(world, sys, h, dt);
}

function bump(m: Map<EntityId, number>, key: EntityId): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

/** Per-tick census: active hippies + spatial hash, task counters, Flag stock, camp drains. */
function census(world: World, sys: UnitsState): void {
  const active = sys.active;
  active.length = 0;
  sys.fetchers.clear();
  sys.helpers.clear();
  sys.choppers.clear();
  sys.responders.clear();
  sys.raiders.fill(0);
  sys.clearers.fill(0);
  sys.overCap.clear();
  for (const members of sys.campMembers) members.length = 0;
  for (const h of world.hippies.values()) {
    if (h.status === 'ko') continue;
    active.push(h);
    const b = brainOf(h);
    if (h.faction !== NEUTRAL) {
      sys.campMembers[h.faction].push(h);
      if (h.job === 'raid') sys.raiders[h.faction]++;
      if (b.clearing) sys.clearers[h.faction]++;
    }
    if (b.target < 0) continue;
    if (b.task === 'fetchStock') bump(sys.fetchers, b.target);
    else if (b.task === 'build' || b.task === 'repair') bump(sys.helpers, b.target);
    else if (b.task === 'chop') bump(sys.choppers, b.target);
    else if (b.task === 'respond') bump(sys.responders, b.target);
  }
  for (const f of FACTION_IDS) {
    const members = sys.campMembers[f];
    members.sort((a, b) => a.recruitedAt - b.recruitedAt || a.id - b.id);
    for (let i = popCap(world, f); i < members.length; i++) sys.overCap.add(members[i].id);
  }
  sys.hash.rebuild(active);

  sys.looseFlags.length = 0;
  sys.stockByHearth.clear();
  for (const fl of world.flags.values()) {
    if (fl.state === 'loose') sys.looseFlags.push(fl);
    else if (fl.state === 'stock') bump(sys.stockByHearth, fl.holder);
  }
  for (const f of FACTION_IDS) {
    let stock = 0;
    for (const id of world.factions[f].hearthIds) stock += sys.stockByHearth.get(id) ?? 0;
    sys.stockByFaction[f] = stock;
    // Hoarding is villainy (the cold is the lack of activity); Acid Cop paranoia doubles it.
    let drain = HIPPIE.attentionDrain;
    if (isHoarding(world, f)) drain *= HIPPIE_AI.hoardDrainMult;
    if (isDrugActive(world, f, 'acidcop')) drain *= HIPPIE_AI.paranoiaDrainMult;
    sys.attentionMult[f] = drain;
    sys.drumCircles[f].length = 0;
  }
  for (const b of world.buildings.values()) {
    if (b.kind === 'drumcircle' && b.faction !== NEUTRAL && b.built >= 1 && !b.disabled) sys.drumCircles[b.faction].push(b);
  }
}

/** Drop reservations / claims whose holder no longer holds them (KO, conversion, removal). */
function sweepClaims(world: World, sys: UnitsState): void {
  sys.nodeReservations.forEach((id, node) => {
    const h = world.hippies.get(id);
    if (!h || h.status === 'ko' || brainOf(h).node !== node) sys.nodeReservations.delete(node);
  });
  sys.flagClaims.forEach((id, flag) => {
    const h = world.hippies.get(id);
    if (!h || h.status === 'ko' || brainOf(h).flag !== flag) sys.flagClaims.delete(flag);
  });
  sys.drumSlots.forEach((_, circle) => {
    if (!world.buildings.has(circle)) sys.drumSlots.delete(circle);
  });
}

function updateHippie(world: World, sys: UnitsState, h: Hippie, dt: number): void {
  const b = brainOf(h);
  if (b.faction !== h.faction) convert(world, h, b);
  if (h.status === 'ko') {
    if (world.time >= h.koUntil) respawn(world, h, b);
    return;
  }
  // Excess recruits lose attention even while idle, resting or stunned. At zero they take
  // the normal distraction break; returning from it does not remove the excess penalty.
  if (sys.overCap.has(h.id) && b.task !== 'distracted') {
    h.attention = Math.max(0, h.attention - HIPPIE.overCapAttentionDrain * dt);
    if (h.attention === 0) becomeDistracted(world, h, b);
  }
  pruneEffects(world, h);
  if (hasEffect(world, h, 'knockback')) {
    slide(world, h, dt);
    return;
  }
  if (hasEffect(world, h, 'stun')) {
    // Stunned hippies do nothing; a channel in progress is lost.
    h.vel.x = 0;
    h.vel.z = 0;
    b.work = 0;
    b.moving = false;
    return;
  }
  const f = h.faction;
  if (f === NEUTRAL) {
    // Neutrals wander between sound camps and spawns; they never fight.
    if (b.task !== 'wander') {
      beginTask(world, h, b, 'wander');
      pickWanderSpot(world, h, b);
    }
    wander(world, sys, h, b);
  } else live(world, sys, h, b, f, dt);
  locomote(world, sys, h, b, dt);
}

function live(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, dt: number): void {
  attend(world, sys, h, b, f, dt);
  const overstim = b.task !== 'distracted' && hasEffect(world, h, 'overstimulated');
  if (overstim) {
    if (b.task !== 'wander') {
      beginTask(world, h, b, 'wander');
      pickWanderSpot(world, h, b);
    }
  } else if (b.hurt && b.task !== 'distracted') react(world, h, b, f);
  b.hurt = false;
  if (!overstim && needsDecision(world, b)) decide(world, sys, h, b, f);
  act(world, sys, h, b, f, dt);
  if (!overstim && b.task !== 'distracted') shove(world, sys, h, b, f);
}

/**
 * Attention drains while working (faster when hoarding, paranoid or in Flag Psychosis); at 0
 * the hippie is distracted. Idle hippies at home recover.
 */
function attend(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId, dt: number): void {
  switch (b.task) {
    case 'distracted':
    case 'flee':
    case 'wander':
      return;
    case 'none':
    case 'idle':
      if (!sys.overCap.has(h.id) && h.attention < 100 && restingAtHome(world, sys, h, f)) {
        h.attention = Math.min(100, h.attention + HIPPIE.attentionRecover * dt);
      }
      return;
    default: {
      let drain = sys.attentionMult[f];
      if (hasEffect(world, h, 'psychosis')) drain *= HIPPIE_AI.psychosisDrainMult;
      h.attention -= drain * dt;
      if (h.attention > 0) return;
      h.attention = 0;
      becomeDistracted(world, h, b);
    }
  }
}

function restingAtHome(world: World, sys: UnitsState, h: Hippie, f: FactionId): boolean {
  const rh = HIPPIE_AI.recoverHearthRadius;
  for (const id of world.factions[f].hearthIds) {
    const hb = world.buildings.get(id);
    if (hb && (hb.pos.x - h.pos.x) ** 2 + (hb.pos.z - h.pos.z) ** 2 <= rh * rh) return true;
  }
  const rd = HIPPIE_AI.recoverDrumRadius;
  for (const c of sys.drumCircles[f]) {
    if ((c.pos.x - h.pos.x) ** 2 + (c.pos.z - h.pos.z) ** 2 <= rd * rd) return true;
  }
  return false;
}

/**
 * Taking a hit: fighters with free hands hit back (unless mid-channel), fighters carrying loot
 * keep running it home, and badly hurt workers flee to the Hearth.
 */
function react(world: World, h: Hippie, b: Brain, f: FactionId): void {
  const order = h.order;
  const fighter =
    order !== null ? order.kind === 'follow' || order.kind === 'defend' || order.kind === 'attack' : h.job === 'defend' || h.job === 'raid';
  const handsFree = h.carryingFlag === -1 && h.carryingLumber === 0;
  if (fighter && handsFree) {
    if (b.work > 0 || b.task === 'engage' || b.foe >= 0 || !rivalUnitPos(world, f, b.lastHurtBy, scratch)) return;
    if (order !== null && order.kind === 'follow') b.foe = b.lastHurtBy;
    else startEngage(world, h, b, b.lastHurtBy, h.pos.x, h.pos.z);
    return;
  }
  if (fighter) return;
  if (h.hp < HIPPIE.maxHp * HIPPIE_AI.fleeHpFrac && b.task !== 'flee') startFlee(world, h, b);
}

/** Shove the nearest rival unit within reach, once per shoveInterval (never mid-channel). */
function shove(world: World, sys: UnitsState, h: Hippie, b: Brain, f: FactionId): void {
  if (world.time < b.nextShoveAt || b.work > 0) return;
  const reach = HIPPIE.shoveReach;
  let target = -1;
  let bestD: number = reach;
  let tx = 0;
  let tz = 0;
  const items = sys.hash.items;
  const n = sys.hash.query(h.pos.x, h.pos.z, reach, sys.near);
  for (let i = 0; i < n; i++) {
    const o = items[sys.near[i]];
    if (o.faction === f || o.faction === NEUTRAL || o.status === 'ko') continue;
    const d = Math.hypot(o.pos.x - h.pos.x, o.pos.z - h.pos.z);
    if (d < bestD) {
      bestD = d;
      target = o.id;
      tx = o.pos.x;
      tz = o.pos.z;
    }
  }
  for (const av of world.avatars.values()) {
    if (av.faction === f || av.koUntil > 0 || av.pos.y > SHOVE_Y) continue;
    const d = Math.hypot(av.pos.x - h.pos.x, av.pos.z - h.pos.z) - AVATAR.radius;
    if (d < bestD) {
      bestD = d;
      target = av.id;
      tx = av.pos.x;
      tz = av.pos.z;
    }
  }
  if (target < 0) return;
  b.nextShoveAt = world.time + HIPPIE.shoveInterval / Math.max(0.25, speedMultiplier(world, h));
  h.facing = Math.atan2(tx - h.pos.x, tz - h.pos.z);
  damageEntity(world, target, HIPPIE.shoveDamage, h.id);
  knockback(world, target, h.pos, HIPPIE.shoveKnockback);
}

/** Recruitment, Dialectics or capture changed the hippie's faction: it starts over with the new camp. */
function convert(world: World, h: Hippie, b: Brain): void {
  releaseTask(world, h, b);
  b.faction = h.faction;
  b.jobSince = -Infinity;
  b.answeredAt = world.time;
  b.stolen = false;
  b.hurt = false;
  h.job = null;
  h.order = null;
  h.beacon = h.faction !== NEUTRAL;
  if (h.status !== 'ko') setStatus(h, 'idle');
}

/** Every knockout returns the same individual to the shared neutral population. */
function respawn(world: World, h: Hippie, b: Brain): void {
  h.faction = NEUTRAL;
  h.recruitedAt = 0;
  h.job = null;
  h.order = null;
  let x = h.pos.x;
  let z = h.pos.z;
  if (world.map.neutralSpawns.length > 0) {
    const s = world.rng.pick(world.map.neutralSpawns);
    x = s.x + world.rng.range(-NEUTRAL_SCATTER, NEUTRAL_SCATTER);
    z = s.z + world.rng.range(-NEUTRAL_SCATTER, NEUTRAL_SCATTER);
  }
  if (!world.nav.isWalkable(x, z)) {
    const p = world.nav.nearestWalkable(x, z);
    x = p.x;
    z = p.z;
  }
  h.pos.x = x;
  h.pos.z = z;
  h.vel.x = 0;
  h.vel.z = 0;
  h.hp = HIPPIE.maxHp;
  h.koUntil = 0;
  h.attention = Math.max(h.attention, HIPPIE.distractedRecoverTo);
  h.beacon = h.faction !== NEUTRAL;
  b.faction = h.faction;
  releaseTask(world, h, b);
  setStatus(h, 'idle');
  world.emit({ t: 'respawn', id: h.id, kind: 'hippie', faction: h.faction, pos: { x, y: 0, z } });
}
