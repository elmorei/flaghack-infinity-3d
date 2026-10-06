/**
 * Labour: Camp Priorities per posture, plus direct orders where the job allocator would be
 * too slow or too vague: pull squads on the Flags that keep a loop around our Hearth, guards
 * on our own assault loop, and attack pings on the Flags that hold a target's home ring.
 * Owner: AI agent.
 */
import { CAPTURE, HOARD_THRESHOLD, LIGHTNING_PULL_MULT, WARD_PULSE_RADIUS } from '../sim/constants';
import { flagPullDefender } from '../sim/systems/flags';
import { isFlagProtected } from '../sim/systems/abilities';
import type { EntityId, Hippie, JobKind } from '../sim/types';
import type { World } from '../sim/world';
import type { Brain, Posture } from './brain';

const WEIGHTS: Record<Posture, Record<JobKind, number>> = {
  economy: { survey: 2, gather: 4, defend: 1, raid: 0, ritual: 2 },
  expand: { survey: 4, gather: 2, defend: 1, raid: 0, ritual: 1 },
  attack: { survey: 4, gather: 1, defend: 1, raid: 2, ritual: 1 },
  opportunist: { survey: 4, gather: 1, defend: 1, raid: 2, ritual: 1 },
  defend: { survey: 1, gather: 0, defend: 4, raid: 4, ritual: 0 },
};
/** Breach squads on the assault walls: Flags attacked at once, hands per Flag. Defence
 * squads are sized by difficulty (Skill.squads / Skill.pullers). */
const BREACH_SQUADS = 4;
const BREACH_PULLERS = 2;
/** Guards posted on a closed assault loop: at least this many, this share of the camp, at most this many. */
const LOOP_GUARDS = 3;
const GUARD_SHARE = 0.4;
const MAX_GUARDS = 12;
/** While the wall is still rising, this share of the camp guards its exposed stretches. */
const BUILD_GUARD_SHARE = 0.2;
/** Sort bias (m²) putting the wall's gaps ahead of every held stretch on the guard roster. */
const GAP_FIRST = 1e6;
/** Attack pings marking the target's home-ring Flags are refreshed this often (s). */
const PING_EVERY = 10;

const ids: EntityId[] = [];

export function manageLabour(b: Brain): void {
  setWeights(b);
  const assault = b.posture === 'attack' || b.posture === 'opportunist';
  // Defence first; otherwise clear the rival Flags standing on our assault loop. With no
  // targets the reconcile only calls off orders that lost their point.
  const defending = b.view.critical.length > 0;
  const rival = b.target === null ? undefined : b.intel(b.target);
  const targets = defending ? b.view.critical.slice() : assault ? breachFlags(b) : [];
  if (!defending && assault && rival?.attacker === b.f) {
    for (const id of rival.homeCritical) if (!targets.includes(id)) targets.push(id);
  }
  targets.sort((a, c) => pullCost(b, a) - pullCost(b, c) || a - c);
  suppressWards(b, targets);
  pullSquads(b, targets, defending ? b.skill.squads : BREACH_SQUADS, defending ? b.skill.pullers : BREACH_PULLERS);
  if (assault) assaultSupport(b);
}

/** Travel plus live pull difficulty: lightning changes the cheapest breach. */
function pullCost(b: Brain, id: EntityId): number {
  const fl = b.world.flags.get(id);
  if (!fl) return Infinity;
  const av = b.world.avatarOf(b.f);
  return Math.hypot(fl.pos.x - av.pos.x, fl.pos.z - av.pos.z) +
    (flagPullDefender(b.world, fl, b.f) ? LIGHTNING_PULL_MULT : 1) * 12;
}

/** A Ward pulse resets hippie work faster than a defended pull can finish: disable it first. */
function suppressWards(b: Brain, targets: readonly EntityId[]): void {
  const world = b.world;
  const wanted: EntityId[] = [];
  for (const w of world.buildings.values()) {
    if (w.kind !== 'ward' || w.faction === b.f || w.faction === -1 || w.built < 1 || w.disabled) continue;
    if (targets.some(id => {
      const fl = world.flags.get(id);
      return fl?.state === 'planted' &&
        (fl.pos.x - w.pos.x) ** 2 + (fl.pos.z - w.pos.z) ** 2 <= WARD_PULSE_RADIUS ** 2;
    })) wanted.push(w.id);
  }
  for (const [id, squad] of b.wardOrders) {
    const keep = squad.filter(workerId => {
      const h = world.hippies.get(workerId);
      return h && available(world, h, b.f) && h.order?.kind === 'attack' && h.order.target === id;
    });
    if (!wanted.includes(id)) {
      if (keep.length) world.submit({ t: 'order', faction: b.f, hippies: keep, order: null });
      b.wardOrders.delete(id);
    } else b.wardOrders.set(id, keep);
  }
  for (const id of wanted.slice(0, 2)) {
    const w = world.buildings.get(id)!;
    const squad = b.wardOrders.get(id) ?? [];
    const recruits: EntityId[] = [];
    nearestFree(b, w.pos.x, w.pos.z, 2 - squad.length, new Set(), recruits);
    if (!recruits.length) continue;
    b.wardOrders.set(id, [...squad, ...recruits]);
    world.submit({ t: 'order', faction: b.f, hippies: recruits, order: { kind: 'attack', target: id } });
  }
}

/** Rival (or orphaned) Flags planted on nodes of our siege walls, in wall order. */
function breachFlags(b: Brain): EntityId[] {
  const r = b.target === null ? undefined : b.intel(b.target);
  const out: EntityId[] = [];
  if (!r || !r.loop) return out;
  const world = b.world;
  const s = world.survey;
  for (const wall of [r.loop, r.outer ?? []]) {
    for (const n of wall) {
      const id = s.nodeFlag[n];
      if (id < 0 || s.nodeFlagOwner[n] === b.f || out.includes(id)) continue;
      const fl = world.flags.get(id);
      if (fl && !isFlagProtected(world, fl)) out.push(id);
    }
  }
  return out;
}

function setWeights(b: Brain): void {
  const w = { ...WEIGHTS[b.posture] };
  const v = b.view;
  // Broke: send hands to the piles. A chest above the temperament's comfort feeds the Survey
  // instead, and past the hoarding line nobody chops: every log would only become another
  // Flag nobody carries out (the Workshops craft whatever lumber comes in).
  const hoarding = v.stock > b.persona.hoard && b.posture !== 'defend';
  if (v.lumber < 40 && !hoarding && b.posture !== 'defend') w.gather = Math.max(w.gather, 3);
  if (hoarding) w.survey = 4;
  if (v.stock > HOARD_THRESHOLD) w.gather = 0;
  const key = `${w.survey}${w.gather}${w.defend}${w.raid}${w.ritual}`;
  if (key === b.sentWeights) return;
  b.sentWeights = key;
  b.world.submit({ t: 'jobWeights', faction: b.f, weights: w });
}

/** Free hands: own, awake, not carrying anything we would make them drop. */
function available(world: World, h: Hippie, f: Brain['f']): boolean {
  if (h.faction !== f || h.koUntil > world.time || h.status === 'distracted' || h.status === 'ko') return false;
  return h.carryingFlag === -1 && h.carryingLumber === 0;
}

/** `pullers` hands on each of the first `squads` target Flags (cheapest-to-break / wall order). */
function pullSquads(b: Brain, targets: readonly EntityId[], squads: number, pullers: number): void {
  const world = b.world;
  const f = b.f;
  // Forget finished or abandoned orders; hands still on one are called off (a Flag that
  // became ours in the meantime must not be pulled by its own camp).
  for (const [flagId, squad] of b.pullOrders) {
    for (let i = squad.length - 1; i >= 0; i--) {
      const h = world.hippies.get(squad[i]);
      if (!h || h.faction !== f || !h.order || h.order.kind !== 'pull' || h.order.flagId !== flagId) squad.splice(i, 1);
    }
    const fl = world.flags.get(flagId);
    if (!fl || fl.state !== 'planted' || fl.owner === f || !targets.includes(flagId)) {
      if (squad.length > 0) world.submit({ t: 'order', faction: f, hippies: squad.slice(), order: null });
      b.pullOrders.delete(flagId);
    }
  }
  const busy = new Set<EntityId>();
  for (const squad of b.pullOrders.values()) for (const id of squad) busy.add(id);
  let flags = 0;
  for (const flagId of targets) {
    if (flags++ >= squads) break;
    const fl = world.flags.get(flagId);
    if (!fl || fl.state !== 'planted' || isFlagProtected(world, fl)) continue;
    const squad = b.pullOrders.get(flagId) ?? [];
    const need = pullers - squad.length;
    if (need <= 0) continue;
    ids.length = 0;
    nearestFree(b, fl.pos.x, fl.pos.z, need, busy, ids);
    if (ids.length === 0) continue;
    for (const id of ids) {
      squad.push(id);
      busy.add(id);
    }
    b.pullOrders.set(flagId, squad);
    world.submit({ t: 'order', faction: f, hippies: ids.slice(), order: { kind: 'pull', flagId } });
  }
}

/** Up to `n` free own hippies nearest (x, z), skipping `busy`. */
function nearestFree(b: Brain, x: number, z: number, n: number, busy: Set<EntityId>, out: EntityId[]): void {
  const pick: { id: EntityId; d: number }[] = [];
  const suppressors = new Set([...b.wardOrders.values()].flat());
  for (const h of b.world.hippies.values()) {
    if (busy.has(h.id) || !available(b.world, h, b.f)) continue;
    if (h.order && h.order.kind === 'pull') continue;
    if (suppressors.has(h.id)) continue;
    pick.push({ id: h.id, d: (h.pos.x - x) ** 2 + (h.pos.z - z) ** 2 });
  }
  pick.sort((p, q) => p.d - q.d || p.id - q.id);
  for (let i = 0; i < n && i < pick.length; i++) out.push(pick[i].id);
}

/**
 * While our loop stands around the target: guards on the Flags it hangs on (nearest their
 * Hearth first, where their pullers come from), and attack pings on the Flags of their home
 * ring so our raiders turn their contest into containment.
 */
function assaultSupport(b: Brain): void {
  const world = b.world;
  const f = b.f;
  const r = b.target === null ? undefined : b.intel(b.target);
  if (!r || !r.loop) return;
  const closed = r.attacker === f || r.ourPressure > 0;

  // Posts: our critical loop Flags (or the loop's front), nearest their Hearth first. While
  // the wall is still rising, the stretches their defenders reach first (inside their Survey
  // or their threat radius): a guard there shoves pullers off before the pull completes.
  const lat = world.lattice;
  const s = world.survey;
  const posts: { x: number; z: number; d: number }[] = [];
  if (closed) {
    for (const id of r.ourCritical) {
      const fl = world.flags.get(id);
      if (fl) posts.push({ x: fl.pos.x, z: fl.pos.z, d: (fl.pos.x - r.hx) ** 2 + (fl.pos.z - r.hz) ** 2 });
    }
  }
  if (posts.length === 0) {
    const bit = 1 << r.id;
    for (const n of r.loop) {
      const node = lat.nodes[n];
      let d = (node.x - r.hx) ** 2 + (node.z - r.hz) ** 2;
      if (!closed) {
        const ours = s.nodeFlagOwner[n] === f || s.holder[n] === f;
        let exposed = !ours || d < CAPTURE.threatRadius * CAPTURE.threatRadius;
        for (const fc of node.facets) if (s.facetSurvey[fc] & bit) exposed = true;
        if (!exposed) continue;
        // The gaps come first: that is where their hands pull and replant against ours.
        if (!ours) d -= GAP_FIRST;
      }
      posts.push({ x: node.x, z: node.z, d });
    }
  }
  posts.sort((p, q) => p.d - q.d || p.x - q.x);
  let guards = 0;
  let total = 0;
  for (const h of world.hippies.values()) {
    if (h.faction !== f) continue;
    total++;
    if (h.order && h.order.kind === 'defend') guards++;
  }
  const want = posts.length === 0 ? 0 : Math.min(MAX_GUARDS, Math.max(LOOP_GUARDS, Math.round(total * (closed ? GUARD_SHARE : BUILD_GUARD_SHARE))));
  const busy = new Set<EntityId>();
  for (let i = guards; i < want && posts.length > 0; i++) {
    const post = posts[i % Math.min(posts.length, want)];
    ids.length = 0;
    nearestFree(b, post.x, post.z, 1, busy, ids);
    if (ids.length === 0) break;
    busy.add(ids[0]);
    world.submit({ t: 'order', faction: f, hippies: ids.slice(), order: { kind: 'defend', at: { x: post.x, z: post.z } } });
  }

  // Raid pings on their home ring's critical Flags.
  if (!r.homeIntact || r.homeCritical.length === 0) return;
  if (world.time < b.nextPingAt) return;
  b.nextPingAt = world.time + PING_EVERY;
  for (let i = 0; i < Math.min(2, r.homeCritical.length); i++) {
    const fl = world.flags.get(r.homeCritical[i]);
    if (fl) world.submit({ t: 'ping', faction: f, kind: 'attack', at: { x: fl.pos.x, z: fl.pos.z } });
  }
}

/** Release loop guards when the assault ends. */
export function releaseGuards(b: Brain): void {
  ids.length = 0;
  for (const h of b.world.hippies.values()) if (h.faction === b.f && h.order && h.order.kind === 'defend') ids.push(h.id);
  if (ids.length > 0) b.world.submit({ t: 'order', faction: b.f, hippies: ids.slice(), order: null });
}

/**
 * A camp taken over from a departed human: hippies rallied to follow the vexillomancer would
 * trail the NPC pilot for good, so they go back to the camp's jobs. Every other order (pull,
 * plant, gather, defend, attack, move, push) finishes on its own and is left to do so.
 */
export function releaseFollowers(b: Brain): void {
  ids.length = 0;
  for (const h of b.world.hippies.values()) if (h.faction === b.f && h.order && h.order.kind === 'follow') ids.push(h.id);
  if (ids.length > 0) b.world.submit({ t: 'order', faction: b.f, hippies: ids.slice(), order: null });
}
