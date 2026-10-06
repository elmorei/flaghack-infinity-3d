/**
 * Avatar pilot: turns the brain's current errand into per-tick `avatarInput` (nav-grid path
 * following, sprint when far, jump when stuck) plus discrete commands: plant within reach,
 * throw at planned nodes with a solved ballistic arc when the line of fire is clear, hold a
 * pull on a critical rival Flag, swing at intruders and lumber, restock at the Hearth, align
 * chakras and work the Command Table. Every command is pre-checked so none is rejected.
 * Owner: AI agent.
 */
import { ALIGN_RADIUS, AVATAR, BUILDINGS, GCC, GCC_REACH, HIPPIE, LIGHTNING_PULL_MULT, SIM_DT } from '../sim/constants';
import { TAU } from '../sim/math';
import type { V2, V3 } from '../sim/math';
import { GROUND_SHAPE } from '../sim/physics/collision';
import { alignBlocker, isFlagProtected } from '../sim/systems/abilities';
import { throwOrigin, throwVelocity } from '../sim/systems/avatars';
import { nearestHearth, population, popCap, stockAt } from '../sim/systems/economy';
import { canPlantAt, flagPullDefender } from '../sim/systems/flags';
import { gccBlocker } from '../sim/systems/gcc';
import { canRecruit, handFlagBlocker } from '../sim/systems/recruitment';
import { NEUTRAL } from '../sim/types';
import type { Avatar, EntityId, GccAction } from '../sim/types';
import type { Brain, PilotTask } from './brain';
import { SIGHT } from './perception';
import { MAX_THROW_RANGE, solveThrow } from './ballistics';
import { CLOSE_QUIVER } from './plans';

/** Errands are re-chosen this often (s), or at once when the current one is finished. */
const RETHINK = 0.4;
/** Waypoint reached within this (m). */
const WAYPOINT = 1.1;
/** Replan when the goal moved this far, or the path is this old (s); never more often than REPATH_MIN. */
const REPATH_SHIFT = 2.5;
const REPATH_AGE = 3;
const REPATH_MIN = 0.5;
const PATH_ITER = 5000;
/** No progress over this window (s) means stuck: hop and replan. */
const STUCK_WINDOW = 0.8;
const STUCK_DIST = 0.5;
/** Sprint to goals farther than this (m). */
const SPRINT_FROM = 12;
/** Throws go to nodes between these distances (m); closer ones are planted by hand. */
const THROW_MIN = 4.5;
const THROW_MAX = MAX_THROW_RANGE - 1.5;
/** A node thrown at is left alone until the Flag has landed plus this (s). */
const THROW_SETTLE = 0.6;
/** Plant / pull / swing standing distances (a little inside the sim's reach). */
const PLANT_STAND = AVATAR.plantReach - 0.5;
const PULL_STAND = AVATAR.pullReach - 0.5;
const HARVEST_STAND = AVATAR.swingReach;
/** Idle spot: this far from the Hearth toward the burn. */
const HOME_STAND = 6;
/** Hold the Hearth from within this of it (the sim allows CAPTURE.holdRadius). */
const HOLD_STAND = 4.5;
/** Besieged: below this pressure, a critical Flag within QUICK_PULL of the Hearth is pulled
 * by the vexillomancer instead of holding. */
const HOLD_PRESSURE = 50;
const QUICK_PULL = 20;
/** A siege wall missing at most this many nodes is mended by the vexillomancer in person. */
const WALL_GAPS = 4;
/** Lumber below which an idle vexillomancer goes chopping, and how far from home it will go. */
const HARVEST_BELOW = 90;
const HARVEST_RANGE = 70;
/** Loop nodes farther than this from home are the avatar's business; hippies plant the rest. */
const FAR_FROM_HOME = 40;
/** Chakra alignment and Command Table errands only from this close to home (m). */
const ERRAND_RANGE = 45;
/** Rival Flags on our assault loop within this of the vexillomancer get pulled by hand (m). */
const SQUATTER_RANGE = 40;
/** Rival hippies this close to a critical loop Flag of ours get staffed. */
const GUARD_RADIUS = 9;

const origin: V3 = { x: 0, y: 0, z: 0 };
const vel: V3 = { x: 0, y: 0, z: 0 };
/** Scratch point: the front an assault restocks for. */
const front: V2 = { x: 0, z: 0 };

export function pilotTick(b: Brain): void {
  const world = b.world;
  const av = world.avatarOf(b.f);
  if (!world.factions[b.f].alive) return;
  if (av.koUntil > world.time) {
    b.pilot.path.length = 0;
    send(b, 0, 0, av.input.yaw, 0, false, false);
    return;
  }
  const p = b.pilot;
  const valid = taskValid(b, av, p.task);
  // A restock trip is finished with a full quiver (or an empty stock), not half way.
  const sticky = valid && ((p.task.kind === 'restock' && !besieged(b)) ||
    (p.task.kind === 'pull' && av.action.kind === 'pull' && av.action.flagId === p.task.flagId));
  if ((world.time >= p.taskAt + RETHINK && !sticky) || !valid) {
    p.task = chooseTask(b, av);
    p.taskAt = world.time;
  }
  run(b, av);
}

/** Force a fresh errand next tick. */
function done(b: Brain): void {
  b.pilot.taskAt = -Infinity;
}

/** Our Hearth is under a noticed siege and we are not racing our own overwrite home. */
function besieged(b: Brain): boolean {
  const st = b.view.stage;
  return (st === 'contained' || st === 'contested' || st === 'overwritten') && b.world.time >= b.noticeAt && !b.racing;
}

function taskValid(b: Brain, av: Avatar, t: PilotTask): boolean {
  const world = b.world;
  switch (t.kind) {
    case 'pickup': {
      const fl = world.flags.get(t.flagId);
      return !!fl && fl.state === 'loose' && av.carried.length < AVATAR.quiver;
    }
    case 'recruit': {
      const h = world.hippies.get(t.hippieId);
      return !!h && canRecruit(h) && av.carried.length > 0 && population(world, b.f) < popCap(world, b.f);
    }
    case 'pull': {
      const fl = world.flags.get(t.flagId);
      return !!fl && fl.state === 'planted' && fl.owner !== b.f && !isFlagProtected(world, fl);
    }
    case 'plant':
      return av.carried.length > 0 && canPlantAt(world, t.node, b.f) && !pending(b, t.node);
    case 'harvest': {
      const pile = world.piles.get(t.pileId);
      return !!pile && pile.lumber > 0;
    }
    case 'restock': {
      const depot = world.buildings.get(t.hearthId);
      return !!depot && depot.faction === b.f && av.carried.length < AVATAR.quiver && b.view.stock > 0;
    }
    case 'fight': {
      const foe = world.hippies.get(t.target) ?? world.avatars.get(t.target);
      return !!foe && foe.faction !== b.f && foe.faction !== NEUTRAL && foe.koUntil <= world.time;
    }
    default:
      return true;
  }
}

function pending(b: Brain, node: number): boolean {
  const until = b.pilot.thrownAt.get(node);
  return until !== undefined && until > b.world.time;
}

function chooseTask(b: Brain, av: Avatar): PilotTask {
  const world = b.world;
  const v = b.view;
  // Mid-channel: let it finish.
  if (av.action.kind === 'align' || (av.action.kind === 'channel' && av.action.what === 'dialectics')) return b.pilot.task;
  if (besieged(b)) {
    // Holding the Hearth contests the capture. A critical Flag close to home is worth the short
    // dash while the pressure is still low; pull squads and Phason Shift take the rest.
    if (v.pressure < HOLD_PRESSURE) {
      let best = -1;
      let bestD = QUICK_PULL * QUICK_PULL;
      for (const id of v.critical) {
        const fl = world.flags.get(id);
        if (!fl || fl.state !== 'planted' || isFlagProtected(world, fl)) continue;
        const d = ((fl.pos.x - v.hx) ** 2 + (fl.pos.z - v.hz) ** 2) * (flagPullDefender(world, fl, b.f) ? LIGHTNING_PULL_MULT : 1);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      if (best >= 0) return { kind: 'pull', flagId: best };
    }
    return { kind: 'hold' };
  }
  // Shared-population losses return neutral: rebuild with Flags instead of waiting for respawns.
  const recruiting = population(world, b.f) < popCap(world, b.f);
  if (recruiting && av.carried.length > 0) {
    let target = -1;
    let distance = v.population < 6 ? SIGHT ** 2 : 10 ** 2;
    for (const id of v.visibleNeutrals) {
      const h = world.hippies.get(id);
      if (!h || !canRecruit(h) || h.carryingFlag !== -1 || h.carryingLumber > 0) continue;
      const d = (h.pos.x - av.pos.x) ** 2 + (h.pos.z - av.pos.z) ** 2;
      if (d < distance) { distance = d; target = id; }
    }
    if (target >= 0) return { kind: 'recruit', hippieId: target };
  }
  if (recruiting && av.carried.length === 0 && v.population < 6 && v.visibleNeutrals.length > 0) {
    const depot = nearestHearth(world, b.f, av.pos, true);
    if (depot) return { kind: 'restock', hearthId: depot.id };
  }
  if (av.carried.length < AVATAR.quiver) {
    let pick = -1;
    let distance = (av.carried.length === 0 ? 20 : 4) ** 2;
    for (const fl of world.flags.values()) {
      if (fl.state !== 'loose' || Math.abs(fl.pos.y - av.pos.y) > 1) continue;
      const d = (fl.pos.x - av.pos.x) ** 2 + (fl.pos.z - av.pos.z) ** 2;
      if (d < distance) { distance = d; pick = fl.id; }
    }
    if (pick >= 0) return { kind: 'pickup', flagId: pick };
  }
  const homeD = Math.hypot(v.hx - av.pos.x, v.hz - av.pos.z);
  // Rituals and the Command Table wait until the vexillomancer is home anyway.
  if (b.alignWanted && homeD <= ERRAND_RANGE && alignBlocker(world, b.f, b.alignWanted) !== 'Already aligning a chakra.') {
    return { kind: 'align' };
  }
  if (b.gccWanted) return { kind: 'gcc' };
  // Holding a loop round their Hearth: the Flags it hangs on come first.
  const r = b.target === null ? undefined : b.intel(b.target);
  const holding = (b.posture === 'attack' || b.posture === 'opportunist') && r !== undefined && world.inSurvey(r.facet, b.f);
  if (holding && r) {
    const foe = raiderAt(b, r.ourCritical);
    if (foe >= 0) return { kind: 'fight', target: foe };
    // Contested: their vexillomancer is holding the Hearth (public on the rail); knock it off.
    const holder = world.avatars.get(world.factions[r.id].avatarId);
    if (r.stage === 'contested' && holder && holder.koUntil <= world.time) return { kind: 'fight', target: holder.id };
  }
  const planWork = world.factions[b.f].plan.size > 0;
  if (r && r.loop && (b.posture === 'attack' || b.posture === 'opportunist')) {
    // A wall a few nodes short of closing (or of standing again): the vexillomancer mends the
    // gaps itself wherever they are; hippies would walk all the way from home for each one.
    const gap = av.carried.length > 0 ? wallGap(b, av, r.loop, r.keystones) : -1;
    if (gap >= 0) {
      const squat = world.survey.nodeFlag[gap];
      if (squat < 0) return { kind: 'plant', node: gap };
      const fl = world.flags.get(squat);
      if (fl && !isFlagProtected(world, fl)) return { kind: 'pull', flagId: squat };
    }
    // A rival Flag squatting on our walls nearby: pull it, then the node is ours to plant.
    let squatter = squatterNear(b, av, r.loop);
    if (squatter < 0 && r.outer) squatter = squatterNear(b, av, r.outer);
    if (squatter >= 0) return { kind: 'pull', flagId: squatter };
  }
  const assault = (b.posture === 'attack' || b.posture === 'opportunist') && r !== undefined;
  // Flags are fetched from the stocked Hearth nearest where they go: in an assault a captured
  // outpost near the front saves a crossing of the burn per quiver.
  if (assault && r) {
    front.x = r.hx;
    front.z = r.hz;
  }
  const depot = v.stock > 0 ? nearestHearth(world, b.f, assault ? front : av.pos, true) : undefined;
  // Siege walls ready but for their keystones: come back with a full quiver and wait by them.
  const keystone = assault && r && r.keystones.length > 0 ? world.lattice.nodes[r.keystones[0]] : null;
  if (depot && keystone && av.carried.length < CLOSE_QUIVER) return { kind: 'restock', hearthId: depot.id };
  if (depot && av.carried.length === 0 && planWork && !holding) return { kind: 'restock', hearthId: depot.id };
  if (av.carried.length > 0) {
    const node = pickPlantNode(b, av);
    if (node >= 0) return { kind: 'plant', node };
  }
  // With Flags in the quiver an assault waits at the front to mend breaks, not at home.
  if (r && (holding || (assault && av.carried.length > 0))) {
    const spot = keystone ?? (holding ? frontFlag(b, r.ourCritical, r.hx, r.hz) : frontNode(b, r.loop, r.hx, r.hz));
    if (spot) return { kind: 'guard', x: spot.x, z: spot.z };
  }
  if (depot && av.carried.length === 0 && planWork) return { kind: 'restock', hearthId: depot.id };
  if (v.lumber < HARVEST_BELOW) {
    const pile = nearestPile(b, av);
    if (pile >= 0) return { kind: 'harvest', pileId: pile };
  }
  return { kind: 'home' };
}

/**
 * The missing wall node nearest the vexillomancer when only a few are missing (keystones held
 * back on purpose do not count), or -1.
 */
function wallGap(b: Brain, av: Avatar, wall: readonly number[], keystones: readonly number[]): number {
  const world = b.world;
  const s = world.survey;
  const lat = world.lattice;
  let best = -1;
  let bestD = Infinity;
  let missing = 0;
  for (const n of wall) {
    if (s.nodeFlagOwner[n] === b.f || s.holder[n] === b.f || keystones.includes(n)) continue;
    if (++missing > WALL_GAPS) return -1;
    const d = (lat.nodes[n].x - av.pos.x) ** 2 + (lat.nodes[n].z - av.pos.z) ** 2;
    if (d < bestD && (s.nodeFlag[n] >= 0 || (canPlantAt(world, n, b.f) && !pending(b, n)))) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** A visible rival hippie closing on one of the given Flags of ours, or -1. */
function raiderAt(b: Brain, flagIds: readonly EntityId[]): EntityId {
  const world = b.world;
  let best = -1;
  let bestD = GUARD_RADIUS * GUARD_RADIUS;
  for (const id of flagIds) {
    const fl = world.flags.get(id);
    if (!fl) continue;
    for (const h of world.hippies.values()) {
      if (h.faction === b.f || h.faction === NEUTRAL || h.koUntil > world.time) continue;
      const d = (h.pos.x - fl.pos.x) ** 2 + (h.pos.z - fl.pos.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = h.id;
      }
    }
  }
  return best;
}

/** The nearest rival (or orphaned) Flag standing on one of our wall nodes within reach, or -1. */
function squatterNear(b: Brain, av: Avatar, wall: readonly number[]): EntityId {
  const world = b.world;
  const s = world.survey;
  let best = -1;
  let bestD = SQUATTER_RANGE * SQUATTER_RANGE;
  for (const n of wall) {
    const id = s.nodeFlag[n];
    if (id < 0 || s.nodeFlagOwner[n] === b.f) continue;
    const fl = world.flags.get(id);
    if (!fl || fl.altNode >= 0 || isFlagProtected(world, fl)) continue;
    const d = (fl.pos.x - av.pos.x) ** 2 + (fl.pos.z - av.pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** The loop node nearest their Hearth, or null without a loop. */
function frontNode(b: Brain, loop: readonly number[] | null, hx: number, hz: number): { x: number; z: number } | null {
  if (!loop) return null;
  const lat = b.world.lattice;
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (const n of loop) {
    const node = lat.nodes[n];
    const d = (node.x - hx) ** 2 + (node.z - hz) ** 2;
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  return best;
}

/** Our critical loop Flag nearest their Hearth (where their pullers arrive first). */
function frontFlag(b: Brain, flagIds: readonly EntityId[], hx: number, hz: number): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (const id of flagIds) {
    const fl = b.world.flags.get(id);
    if (!fl) continue;
    const d = (fl.pos.x - hx) ** 2 + (fl.pos.z - hz) ** 2;
    if (d < bestD) {
      bestD = d;
      best = fl.pos;
    }
  }
  return best;
}

/** The world may have moved on while the vexillomancer walked to the cart. */
function gccStillWorth(b: Brain, action: GccAction, target: EntityId | -1, nodes: readonly number[]): boolean {
  const world = b.world;
  const g = world.gccOf(b.f);
  if (!g) return false;
  if (action === 'simulacra') return nodes.length === 2 && canPlantAt(world, nodes[0], b.f) && canPlantAt(world, nodes[1], b.f);
  return true;
}

/** The planned node the avatar should take next: assault-loop nodes far from home first. */
function pickPlantNode(b: Brain, av: Avatar): number {
  const world = b.world;
  const lat = world.lattice;
  const v = b.view;
  const assault = b.posture === 'attack' || b.posture === 'opportunist';
  let best = -1;
  let bestScore = Infinity;
  for (const n of world.factions[b.f].plan) {
    if (pending(b, n) || !canPlantAt(world, n, b.f)) continue;
    const node = lat.nodes[n];
    const d = Math.hypot(node.x - av.pos.x, node.z - av.pos.z);
    const fromHome = Math.hypot(node.x - v.hx, node.z - v.hz);
    // Hippies cover the home side; the vexillomancer takes the far, dangerous stretch.
    const score = d - (assault && fromHome > FAR_FROM_HOME ? 35 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

function nearestPile(b: Brain, av: Avatar): EntityId {
  const v = b.view;
  let best = -1;
  let bestD = Infinity;
  for (const p of b.world.piles.values()) {
    if (p.lumber <= 0) continue;
    if ((p.pos.x - v.hx) ** 2 + (p.pos.z - v.hz) ** 2 > HARVEST_RANGE * HARVEST_RANGE) continue;
    const d = (p.pos.x - av.pos.x) ** 2 + (p.pos.z - av.pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

function run(b: Brain, av: Avatar): void {
  const world = b.world;
  const v = b.view;
  const t = b.pilot.task;
  if (av.action.kind === 'align' || (av.action.kind === 'channel' && av.action.what === 'dialectics')) {
    stand(b, av);
    return;
  }
  if (swingAtIntruder(b, av, t)) return;
  switch (t.kind) {
    case 'pickup': {
      const fl = world.flags.get(t.flagId);
      if (!fl || fl.state !== 'loose') return done(b);
      // Throw mode ends sprinting and automatically collects grounded Flags.
      moveTo(b, av, fl.pos.x, fl.pos.z, Math.max(0.6, AVATAR.pullReach - 0.8), true);
      return;
    }
    case 'recruit': {
      const h = world.hippies.get(t.hippieId);
      if (!h || !canRecruit(h) || av.carried.length === 0) return done(b);
      if (handFlagBlocker(world, b.f, h.id) === '') {
        face(b, av, h.pos.x, h.pos.z);
        world.submit({ t: 'handFlag', faction: b.f, hippieId: h.id });
        return done(b);
      }
      moveTo(b, av, h.pos.x, h.pos.z, Math.max(0.6, AVATAR.pullReach - 0.8));
      return;
    }
    case 'pull': {
      const fl = world.flags.get(t.flagId);
      if (!fl) return done(b);
      if (dist3(av, fl.pos.x, fl.pos.y, fl.pos.z) <= PULL_STAND) {
        face(b, av, fl.pos.x, fl.pos.z);
        if (av.action.kind !== 'pull' && av.action.kind !== 'swing' && av.action.kind !== 'plant') {
          world.submit({ t: 'pull', faction: b.f, flagId: fl.id });
        }
        return;
      }
      moveTo(b, av, fl.pos.x, fl.pos.z, PULL_STAND - 0.3);
      return;
    }
    case 'plant': {
      const node = world.lattice.nodes[t.node];
      const d = Math.hypot(node.x - av.pos.x, node.z - av.pos.z);
      if (d <= PLANT_STAND && av.pos.y < 0.5) {
        face(b, av, node.x, node.z);
        if (av.action.kind === 'idle' || av.action.kind === 'channel') {
          world.submit({ t: 'plant', faction: b.f, node: t.node });
          done(b);
        }
        return;
      }
      if (d >= THROW_MIN && d <= THROW_MAX && tryThrow(b, av, t.node)) return;
      // On the way, lob at any other planned node already in range.
      if (throwAtAnyInRange(b, av)) return;
      moveTo(b, av, node.x, node.z, PLANT_STAND - 0.4);
      return;
    }
    case 'restock': {
      const depot = world.buildings.get(t.hearthId);
      if (!depot) return done(b);
      if (Math.hypot(depot.pos.x - av.pos.x, depot.pos.z - av.pos.z) <= BUILDINGS.hearth.radius + AVATAR.restockRadius - 1.5) {
        stand(b, av);
        // A full quiver, or this Hearth ran dry (another may still have Flags): choose again.
        if (av.carried.length >= AVATAR.quiver || stockAt(world, depot.id) === 0) done(b);
        return;
      }
      moveTo(b, av, depot.pos.x, depot.pos.z, BUILDINGS.hearth.radius + AVATAR.restockRadius - 2);
      return;
    }
    case 'harvest': {
      const pile = world.piles.get(t.pileId);
      if (!pile) return done(b);
      if (Math.hypot(pile.pos.x - av.pos.x, pile.pos.z - av.pos.z) <= HARVEST_STAND) {
        face(b, av, pile.pos.x, pile.pos.z);
        if (av.action.kind === 'idle') world.submit({ t: 'swing', faction: b.f });
        return;
      }
      moveTo(b, av, pile.pos.x, pile.pos.z, HARVEST_STAND - 0.6);
      return;
    }
    case 'align': {
      const chakra = b.alignWanted;
      if (!chakra) return done(b);
      const why = alignBlocker(world, b.f, chakra);
      if (why === '') {
        stand(b, av);
        world.submit({ t: 'align', faction: b.f, chakra });
        b.alignWanted = null;
        return;
      }
      if (Math.hypot(v.hx - av.pos.x, v.hz - av.pos.z) > ALIGN_RADIUS + BUILDINGS.hearth.radius - 1.5) {
        moveTo(b, av, v.hx, v.hz, ALIGN_RADIUS);
        return;
      }
      // At home and still blocked (Ritual spent, channel busy): give up this time.
      b.alignWanted = null;
      return done(b);
    }
    case 'gcc': {
      const want = b.gccWanted;
      const g = world.gccOf(b.f);
      if (!want || !g) return done(b);
      const why = gccBlocker(world, b.f, want.action);
      if (why === '') {
        stand(b, av);
        if (gccStillWorth(b, want.action, want.target, want.nodes)) {
          world.submit({ t: 'gcc', faction: b.f, action: want.action, target: want.target, nodes: want.nodes });
        }
        b.gccWanted = null;
        return done(b);
      }
      if (Math.hypot(g.pos.x - av.pos.x, g.pos.z - av.pos.z) > GCC_REACH + BUILDINGS.gcc.radius - 1) {
        moveTo(b, av, g.pos.x, g.pos.z, GCC_REACH);
        return;
      }
      b.gccWanted = null;
      return done(b);
    }
    case 'hold':
      if (Math.hypot(v.hx - av.pos.x, v.hz - av.pos.z) <= HOLD_STAND) stand(b, av);
      else moveTo(b, av, v.hx, v.hz, HOLD_STAND - 1);
      return;
    case 'fight': {
      // swingAtIntruder (above) strikes once in reach; until then, close in. A rival
      // vexillomancer out of sight is sought at its Hearth (the rail says it holds there).
      const foe = world.hippies.get(t.target) ?? world.avatars.get(t.target);
      if (!foe) return done(b);
      const home = world.hearthOf(foe.faction === NEUTRAL ? b.f : foe.faction);
      const seen = (foe.pos.x - av.pos.x) ** 2 + (foe.pos.z - av.pos.z) ** 2 <= SIGHT * SIGHT;
      if (seen || !home) moveTo(b, av, foe.pos.x, foe.pos.z, AVATAR.swingReach - 0.6);
      else moveTo(b, av, home.pos.x, home.pos.z, BUILDINGS.hearth.radius + 1);
      return;
    }
    case 'guard':
      if (Math.hypot(t.x - av.pos.x, t.z - av.pos.z) <= 3) stand(b, av);
      else moveTo(b, av, t.x, t.z, 2.5);
      return;
    case 'home': {
      const len = Math.hypot(v.hx, v.hz) || 1;
      const sx = v.hx - (v.hx / len) * HOME_STAND;
      const sz = v.hz - (v.hz / len) * HOME_STAND;
      if (Math.hypot(sx - av.pos.x, sz - av.pos.z) <= 2.5) stand(b, av);
      else moveTo(b, av, sx, sz, 2);
      return;
    }
  }
}

/** Staff the nearest rival hippie or vexillomancer within reach, when not mid-errand. */
function swingAtIntruder(b: Brain, av: Avatar, t: PilotTask): boolean {
  if (t.kind === 'plant' || t.kind === 'align' || t.kind === 'gcc') return false;
  if (av.action.kind !== 'idle') return false;
  const world = b.world;
  const reach = AVATAR.swingReach + HIPPIE.radius - 0.3;
  let tx = NaN;
  let tz = 0;
  let bestD = reach * reach;
  for (const h of world.hippies.values()) {
    if (h.faction === b.f || h.faction === NEUTRAL || h.koUntil > world.time) continue;
    const d = (h.pos.x - av.pos.x) ** 2 + (h.pos.z - av.pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      tx = h.pos.x;
      tz = h.pos.z;
    }
  }
  for (const o of world.avatars.values()) {
    if (o.faction === b.f || o.koUntil > world.time) continue;
    const d = (o.pos.x - av.pos.x) ** 2 + (o.pos.z - av.pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      tx = o.pos.x;
      tz = o.pos.z;
    }
  }
  if (Number.isNaN(tx)) return false;
  face(b, av, tx, tz);
  world.submit({ t: 'swing', faction: b.f });
  return true;
}

/** Throw at the best unfilled planned node within throwing range (nearest the far side first). */
function throwAtAnyInRange(b: Brain, av: Avatar): boolean {
  const world = b.world;
  if (world.time < av.throwReadyAt || av.carried.length === 0) return false;
  const lat = world.lattice;
  let best = -1;
  let bestD = -1;
  for (const n of world.factions[b.f].plan) {
    if (pending(b, n)) continue;
    const node = lat.nodes[n];
    const d = Math.hypot(node.x - av.pos.x, node.z - av.pos.z);
    if (d < THROW_MIN || d > THROW_MAX || !canPlantAt(world, n, b.f)) continue;
    if (d > bestD) {
      bestD = d;
      best = n;
    }
  }
  return best >= 0 && tryThrow(b, av, best);
}

/** Solve, check the line of fire, aim and release. */
function tryThrow(b: Brain, av: Avatar, n: number): boolean {
  const world = b.world;
  if (world.time < av.throwReadyAt || av.carried.length === 0 || !av.onGround) return false;
  if (av.action.kind === 'pull' || av.action.kind === 'align' || av.action.kind === 'channel') return false;
  const node = world.lattice.nodes[n];
  // Aim error grows with the difficulty's hand shake.
  const err = b.skill.aim * Math.sqrt(world.rng.next());
  const ang = world.rng.next() * TAU;
  const tx = node.x + Math.sin(ang) * err;
  const tz = node.z + Math.cos(ang) * err;
  const aim = b.pilot.aim;
  for (const high of [false, true]) {
    if (!solveThrow(av.pos, tx, 0, tz, high, aim)) continue;
    if (!clearFlight(b, av, aim.yaw, aim.pitch, tx, tz)) continue;
    send(b, 0, 0, aim.yaw, aim.pitch, false, false);
    world.submit({ t: 'throw', faction: b.f });
    b.pilot.thrownAt.set(n, world.time + aim.flight + THROW_SETTLE);
    if (b.pilot.thrownAt.size > 64) prune(b);
    done(b);
    return true;
  }
  return false;
}

function prune(b: Brain): void {
  for (const [n, until] of b.pilot.thrownAt) if (until <= b.world.time) b.pilot.thrownAt.delete(n);
}

/** Does the simulated flight reach the ground near the target without striking anything? */
function clearFlight(b: Brain, av: Avatar, yaw: number, pitch: number, tx: number, tz: number): boolean {
  const col = b.world.collision;
  throwOrigin(av.pos, yaw, origin);
  throwVelocity(yaw, pitch, vel);
  let x = origin.x;
  let y = origin.y;
  let z = origin.z;
  let vy = vel.y;
  const steps = Math.ceil(5 / SIM_DT);
  for (let i = 0; i < steps; i += 2) {
    // Two sim steps per probe segment.
    let nx = x;
    let ny = y;
    let nz = z;
    for (let k = 0; k < 2; k++) {
      vy -= AVATAR.gravity * SIM_DT;
      nx += vel.x * SIM_DT;
      ny += vy * SIM_DT;
      nz += vel.z * SIM_DT;
    }
    const dx = nx - x;
    const dy = ny - y;
    const dz = nz - z;
    const len = Math.hypot(dx, dy, dz);
    const hit = col.raycast(x, y, z, dx, dy, dz, len);
    if (hit) {
      const near = (hit.x - tx) ** 2 + (hit.z - tz) ** 2 <= AVATAR.throwSnapRadius * AVATAR.throwSnapRadius;
      return near && (hit.shape === GROUND_SHAPE || hit.ny >= 0.7);
    }
    if (ny <= 0) return (nx - tx) ** 2 + (nz - tz) ** 2 <= AVATAR.throwSnapRadius * AVATAR.throwSnapRadius;
    x = nx;
    y = ny;
    z = nz;
  }
  return false;
}

/** Path toward (gx, gz); returns true when within `arrive`. */
function moveTo(b: Brain, av: Avatar, gx: number, gz: number, arrive: number, throwMode = false): boolean {
  const world = b.world;
  const p = b.pilot;
  const now = world.time;
  const d = Math.hypot(gx - av.pos.x, gz - av.pos.z);
  if (d <= arrive) {
    if (throwMode) send(b, 0, 0, av.input.yaw, 0, false, false, true);
    else stand(b, av);
    return true;
  }
  const stale = p.path.length === 0 || Math.hypot(gx - p.goalX, gz - p.goalZ) > REPATH_SHIFT || now - p.pathAt > REPATH_AGE;
  if (stale && now - p.pathAt >= REPATH_MIN) {
    p.goalX = gx;
    p.goalZ = gz;
    p.pathAt = now;
    p.pathIndex = 0;
    const nav = world.nav;
    if (nav.lineOfSight(av.pos.x, av.pos.z, gx, gz)) p.path = [{ x: gx, z: gz }];
    else p.path = nav.findPath(av.pos.x, av.pos.z, gx, gz, { partial: true, maxIter: PATH_ITER }) ?? [{ x: gx, z: gz }];
  }
  while (p.pathIndex < p.path.length - 1 && Math.hypot(p.path[p.pathIndex].x - av.pos.x, p.path[p.pathIndex].z - av.pos.z) < WAYPOINT) {
    p.pathIndex++;
  }
  const wp = p.path.length > 0 ? p.path[Math.min(p.pathIndex, p.path.length - 1)] : { x: gx, z: gz };
  let wx = wp.x - av.pos.x;
  let wz = wp.z - av.pos.z;
  const wl = Math.hypot(wx, wz);
  if (wl < 1e-3) {
    wx = gx - av.pos.x;
    wz = gz - av.pos.z;
  }
  const l = Math.hypot(wx, wz) || 1;
  // Stuck: hop and replan.
  if (now - p.stuckAt >= STUCK_WINDOW) {
    if (Math.hypot(av.pos.x - p.stuckX, av.pos.z - p.stuckZ) < STUCK_DIST) {
      p.jumpUntil = now + 0.25;
      p.pathAt = -Infinity;
      p.path.length = 0;
    }
    p.stuckX = av.pos.x;
    p.stuckZ = av.pos.z;
    p.stuckAt = now;
  }
  send(b, wx / l, wz / l, Math.atan2(wx, wz), 0, d > SPRINT_FROM && !throwMode, now < p.jumpUntil, throwMode);
  return false;
}

function stand(b: Brain, av: Avatar): void {
  b.pilot.stuckAt = b.world.time;
  b.pilot.stuckX = av.pos.x;
  b.pilot.stuckZ = av.pos.z;
  send(b, 0, 0, av.input.yaw, 0, false, false);
}

function face(b: Brain, av: Avatar, x: number, z: number): void {
  send(b, 0, 0, Math.atan2(x - av.pos.x, z - av.pos.z), 0, false, false);
}

/** Submit the input if it differs from what the avatar already has. */
function send(b: Brain, mx: number, mz: number, yaw: number, pitch: number, sprint: boolean, jump: boolean, throwMode = false): void {
  const p = b.pilot;
  if (
    Math.abs(mx - p.sentMoveX) < 0.02 &&
    Math.abs(mz - p.sentMoveZ) < 0.02 &&
    Math.abs(yaw - p.sentYaw) < 0.01 &&
    Math.abs(pitch - p.sentPitch) < 0.002 &&
    sprint === p.sentSprint &&
    jump === p.sentJump &&
    throwMode === p.sentThrowMode
  ) {
    return;
  }
  p.sentMoveX = mx;
  p.sentMoveZ = mz;
  p.sentYaw = yaw;
  p.sentPitch = pitch;
  p.sentSprint = sprint;
  p.sentJump = jump;
  p.sentThrowMode = throwMode;
  b.world.submit({ t: 'avatarInput', faction: b.f, input: { moveX: mx, moveZ: mz, jump, sprint, yaw, pitch, throwMode } });
}

function dist3(av: Avatar, x: number, y: number, z: number): number {
  return Math.hypot(x - av.pos.x, y - av.pos.y, z - av.pos.z);
}
