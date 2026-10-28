/**
 * Drugs: brewing commands for Drug Labs, use (faction-wide timers in FactionState.drugActive),
 * per-tick effects and risks (Saffron crash/overstimulation, Luminous Dust hallucination
 * flags for the UI, Acid Cop Vision mesh tap + paranoia).
 * Owner: Economy agent.
 *
 * Effects owned elsewhere read isDrugActive: Acid Cop paranoia (attention ×2) and the Luminous
 * Dust 5 m throw snap live in the hippie/projectile systems; screen effects in render/ui.
 */
import type { CommandOf } from '../commands';
import { DRUG, DRUG_MAX } from '../constants';
import { DRUGS, FACTION_IDS } from '../types';
import type { DrugId, EntityId, FactionId } from '../types';
import type { World } from '../world';
import { econ } from './econ/state';
import { applyEffect, hasEffect } from './effects';

export const DRUG_NAMES: Record<DrugId, string> = {
  saffron: 'Saffron',
  dust: 'Luminous Dust',
  acidcop: 'Acid Cop Vision',
};

/** Hallucinated False Flags stay at least this far from the vexillomancer (seen, never underfoot). */
const FALSE_FLAG_MIN_DIST = 8;
const NO_FALSE_FLAGS: readonly number[] = Object.freeze([]);

export function isDrugActive(world: World, f: FactionId, d: DrugId): boolean {
  return world.factions[f].drugActive[d] > world.time;
}

/** Doses on the shelf plus doses queued or brewing in the faction's labs. */
export function dosesOwnedOrPending(world: World, f: FactionId, d: DrugId): number {
  let n = world.factions[f].drugs[d];
  for (const b of world.buildings.values()) {
    if (b.faction !== f || !b.lab) continue;
    if (b.lab.brewing === d) n++;
    for (const q of b.lab.queue) if (q === d) n++;
  }
  return n;
}

/**
 * Idle labs favor scarce drugs, without making the choice predictable. Each eligible drug
 * has weight 1 / (1 + doses owned or pending). Count the whole faction's shelves, queues
 * and active batches so other labs cannot reserve the same last shelf space. Only the
 * authoritative simulation calls this, once an idle lab can afford its next batch.
 */
export function pickAutoBrew(world: World, f: FactionId): DrugId | null {
  const choices: { drug: DrugId; weight: number }[] = [];
  let total = 0;
  for (const drug of DRUGS) {
    const doses = dosesOwnedOrPending(world, f, drug);
    if (doses >= DRUG_MAX) continue;
    const weight = 1 / (1 + doses);
    choices.push({ drug, weight });
    total += weight;
  }
  if (choices.length === 0) return null;
  let roll = world.rng.next() * total;
  for (const { drug, weight } of choices) {
    roll -= weight;
    if (roll < 0) return drug;
  }
  // Floating-point rounding at the top of the range still chooses an eligible dose.
  return choices[choices.length - 1].drug;
}

/** Why this brew can't be queued ('' = it can). */
export function brewBlocker(world: World, f: FactionId, labId: EntityId, d: DrugId): string {
  const b = world.buildings.get(labId);
  if (!b || !b.lab) return 'No Drug Lab there.';
  if (b.faction !== f) return 'That Drug Lab is not yours.';
  if (b.built < 1) return 'The Drug Lab is still being raised.';
  if (b.disabled) return 'The Drug Lab is disabled: repair it first.';
  if (b.lab.queue.length >= DRUG.queueMax) return `The brewing queue is full (${DRUG.queueMax}).`;
  if (dosesOwnedOrPending(world, f, d) >= DRUG_MAX) return `Your shelf holds only ${DRUG_MAX} doses of ${DRUG_NAMES[d]}.`;
  return '';
}

export function cmdBrew(world: World, c: CommandOf<'brew'>): void {
  const why = brewBlocker(world, c.faction, c.labId, c.drug);
  const lab = world.buildings.get(c.labId)?.lab;
  if (why || !lab) {
    world.emit({ t: 'rejected', faction: c.faction, reason: why });
    return;
  }
  lab.queue.push(c.drug);
}

/** Why the drug can't be taken right now ('' = it can). */
export function drugBlocker(world: World, f: FactionId, d: DrugId): string {
  const fac = world.factions[f];
  if (fac.controlMode === 'rts') return 'This action requires a roaming vexillomancer.';
  if (fac.drugs[d] <= 0) return `No ${DRUG_NAMES[d]} on the shelf: brew some at a Drug Lab.`;
  if (fac.drugActive[d] > world.time) return `${DRUG_NAMES[d]} is already in effect.`;
  return '';
}

export function cmdDrug(world: World, c: CommandOf<'drug'>): void {
  const f = c.faction;
  const why = drugBlocker(world, f, c.drug);
  if (why) {
    world.emit({ t: 'rejected', faction: f, reason: why });
    return;
  }
  const fac = world.factions[f];
  fac.drugs[c.drug]--;
  const until = world.time + DRUG.duration[c.drug];
  fac.drugActive[c.drug] = until;
  if (c.drug === 'acidcop') {
    for (const r of FACTION_IDS) {
      if (r === f || !world.factions[r].alive) continue;
      const tap = Math.max(fac.meshTap[r] ?? 0, until);
      fac.meshTap[r] = tap;
      world.emit({ t: 'meshTapped', faction: f, target: r, until: tap });
    }
  }
  if (c.drug === 'dust') rollFalseFlags(world, f);
  world.emit({ t: 'drugUsed', faction: f, drug: c.drug });
}

/** Luminous Dust hallucinations for the faction's view: node ids that look planted but are not. */
export function falseFlags(world: World, f: FactionId): readonly number[] {
  return isDrugActive(world, f, 'dust') ? econ(world).falseFlags[f] : NO_FALSE_FLAGS;
}

/** Pick DRUG.falseFlagsMin..Max empty nodes around the vexillomancer to hallucinate Flags on. */
function rollFalseFlags(world: World, f: FactionId): void {
  const st = econ(world);
  const out = st.falseFlags[f];
  out.length = 0;
  st.falseFlagsRollAt[f] = world.time + DRUG.falseFlagReroll;
  const av = world.avatarOf(f);
  if (!av) return;
  const lat = world.lattice;
  const cand = st.nodeBuf;
  cand.length = 0;
  lat.nodesInRadius(av.pos.x, av.pos.z, DRUG.falseFlagRadius, cand);
  let kept = 0;
  for (const n of cand) {
    const node = lat.nodes[n];
    if (node.blocked || world.survey.nodeFlag[n] >= 0) continue;
    if ((node.x - av.pos.x) ** 2 + (node.z - av.pos.z) ** 2 < FALSE_FLAG_MIN_DIST * FALSE_FLAG_MIN_DIST) continue;
    cand[kept++] = n;
  }
  cand.length = kept;
  const count = world.rng.int(DRUG.falseFlagsMin, DRUG.falseFlagsMax);
  for (let i = 0; i < count && cand.length > 0; i++) {
    const j = world.rng.int(0, cand.length - 1);
    out.push(cand[j]);
    cand[j] = cand[cand.length - 1];
    cand.length--;
  }
  cand.length = 0;
}

/** Saffron wears off: a faction-wide crash, and some hippies wander off overstimulated. */
function crash(world: World, f: FactionId): void {
  world.factions[f].saffronCrashUntil = world.time + DRUG.crashTime;
  for (const h of world.hippies.values()) {
    if (h.faction !== f) continue;
    applyEffect(world, h, 'crash', DRUG.crashTime, DRUG.crashMag);
    if (world.rng.chance(DRUG.overstimChance)) {
      applyEffect(world, h, 'overstimulated', world.rng.range(DRUG.overstimMin, DRUG.overstimMax));
    }
  }
}

export function updateDrugs(world: World, dt: number): void {
  const st = econ(world);
  for (const f of FACTION_IDS) {
    const fac = world.factions[f];
    const was = st.drugWasActive[f];
    for (const d of DRUGS) {
      const active = fac.drugActive[d] > world.time;
      if (was[d] && !active) {
        if (d === 'saffron') crash(world, f);
        if (d === 'dust') st.falseFlags[f].length = 0;
        world.emit({ t: 'drugExpired', faction: f, drug: d });
      }
      was[d] = active;
    }
    // Faction-wide states also reach hippies that join mid-effect.
    const saffronUntil = fac.drugActive.saffron;
    const crashUntil = fac.saffronCrashUntil;
    if (saffronUntil > world.time || crashUntil > world.time) {
      for (const h of world.hippies.values()) {
        if (h.faction !== f) continue;
        if (saffronUntil > world.time && !hasEffect(world, h, 'saffron')) {
          applyEffect(world, h, 'saffron', saffronUntil - world.time, DRUG.saffronMag);
        }
        if (crashUntil > world.time && !hasEffect(world, h, 'crash')) {
          applyEffect(world, h, 'crash', crashUntil - world.time, DRUG.crashMag);
        }
      }
    }
    if (fac.drugActive.dust > world.time && world.time >= st.falseFlagsRollAt[f]) rollFalseFlags(world, f);
  }
}
