import { burnTime, endTime, matchSettings } from "../matchSettings";
/**
 * Elimination, match end (conquest: the last camp standing; Dawn: the dominant camp once
 * DAWN_TIME arrives), The Burn (sudden death) timing.
 * Owner: SurveyRules agent.
 */
import {
  BURN_TIME,
  DAWN_TIME,
  DAWN_WARNING,
  SUDDEN_DEATH_ESCALATE_EVERY,
  SUDDEN_DEATH_PRESSURE_MULT,
  TIDE_INTERVAL_SUDDEN_DEATH,
} from '../constants';
import type { EventOf } from '../events';
import { NEUTRAL } from '../types';
import type { FactionId, Hippie } from '../types';
import type { World } from '../world';
import { collapseGcc, isCollapsed } from './buildings';
import { dropLoose, transferFlags } from './flags';
import { FACTION_SHORT } from './rules/factions';

/** Flags from a fallen quiver scatter this far around the vexillomancer. */
const QUIVER_SCATTER = 0.9;

/**
 * A hippie whose camp has fallen wanders off neutral: it drops any carried Flag where it
 * stands, forgets its job and orders, and loses its D.E.G.E.N. beacon (no longer on a mesh).
 * Neutral hippies can be recruited again by music or Flags.
 */
export function neutralizeHippie(world: World, h: Hippie): void {
  if (h.carryingFlag >= 0) dropLoose(world, h.carryingFlag, { x: h.pos.x, y: 0, z: h.pos.z });
  h.faction = NEUTRAL;
  h.recruitedAt = 0;
  h.job = null;
  h.order = null;
  if (h.status !== 'ko') h.status = 'idle';
  h.statusTarget = null;
  h.carryingLumber = 0;
  h.beacon = false;
}

/**
 * A faction with no Hearth is out: its vexillomancer falls Flagless for good (quiver
 * scattered), its Flags orphan (planted ones stand neutral, pullable by anyone), its hippies
 * wander off neutral, its plan is forgotten and its GCC collapses for ever.
 */
export function eliminate(world: World, faction: FactionId, by: FactionId | null): void {
  const fac = world.factions[faction];
  if (!fac.alive) return;
  fac.alive = false;
  fac.eliminatedAt = world.time;
  fac.eliminatedBy = by;
  fac.plan.clear();

  const av = world.avatars.get(fac.avatarId);
  if (av) {
    const wasUp = av.koUntil <= world.time;
    const quiver = av.carried.slice();
    for (let i = 0; i < quiver.length; i++) {
      const a = (i / quiver.length) * Math.PI * 2;
      const at = { x: av.pos.x + Math.cos(a) * QUIVER_SCATTER, y: av.pos.y, z: av.pos.z + Math.sin(a) * QUIVER_SCATTER };
      dropLoose(world, quiver[i], at);
    }
    av.koUntil = Infinity;
    av.hp = 0;
    av.action = { kind: 'idle' };
    av.pushing = -1;
    av.vel.x = 0;
    av.vel.z = 0;
    av.input = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: av.yaw, pitch: av.pitch };
    if (wasUp) world.emit({ t: 'ko', id: av.id, kind: 'avatar', faction, by: -1, pos: { ...av.pos } });
  }

  for (const h of world.hippies.values()) if (h.faction === faction) neutralizeHippie(world, h);

  transferFlags(world, faction, NEUTRAL);
  for (const fl of world.flags.values()) if (fl.owner === faction && fl.state !== 'stock') fl.owner = NEUTRAL;

  // The GCC collapses for ever (a cart already down simply never comes back).
  const gcc = world.gccOf(faction);
  if (gcc && gcc.gcc) {
    if (isCollapsed(gcc)) gcc.gcc.destroyedUntil = Infinity;
    else collapseGcc(world, gcc, Infinity);
  }
  fac.gccId = null;

  world.emit({ t: 'eliminated', faction, by });
  const overwriter = by !== null ? `, overwritten by ${FACTION_SHORT[by]}` : '';
  world.emit({
    t: 'notify',
    faction: 'all',
    text: `${fac.name} is Flagless${overwriter}. "Losing the flags is the first step to finding them."`,
    severity: 'epic',
  });
}

/**
 * Sudden-death pressure multiplier: 1 before The Burn, then SUDDEN_DEATH_PRESSURE_MULT, rising
 * by 1 every SUDDEN_DEATH_ESCALATE_EVERY seconds the Burn rages, so a stand-off always ends.
 */
export function suddenDeathMult(world: World): number {
  if (!world.suddenDeath) return 1;
  return SUDDEN_DEATH_PRESSURE_MULT + Math.max(0, Math.floor((world.time - burnTime(world.options)) / SUDDEN_DEATH_ESCALATE_EVERY));
}

/**
 * Standing camps (alive, holding a Hearth), most dominant first: most Hearths, then the
 * largest Survey (facets enclosed now), then the highest C.M.I., then the lowest faction id so
 * the order is always total. Dawn crowns the first; the end screen explains the call with it.
 */
export function dominanceOrder(world: World): FactionId[] {
  const out: FactionId[] = [];
  for (const fac of world.factions) if (fac.alive && fac.hearthIds.length > 0) out.push(fac.id);
  return out.sort((a, b) => {
    const fa = world.factions[a];
    const fb = world.factions[b];
    return (
      fb.hearthIds.length - fa.hearthIds.length ||
      world.survey.surveySize[b] - world.survey.surveySize[a] ||
      fb.stats.cmi - fa.stats.cmi ||
      a - b
    );
  });
}

/**
 * Burn/sudden-death trigger at BURN_TIME and match end: the last faction with Hearths wins by
 * conquest; if several camps still stand at DAWN_TIME, Dawn crowns the dominant one and the
 * others are simply out-surveyed (not eliminated).
 */
export function updateVictory(world: World, dt: number): void {
  if (world.phase !== 'playing') return;
  // The Training Burn runs on its lessons' clock; the director stages its Burn and never crowns anyone.
  if (world.options.mode === 'tutorial') return;
  if (!world.suddenDeath && world.time >= burnTime(world.options)) startBurn(world);
  if (world.suddenDeath) announceEscalation(world);

  let survivor: FactionId | null = null;
  let survivors = 0;
  for (const fac of world.factions) {
    if (!fac.alive || fac.hearthIds.length === 0) continue;
    survivors++;
    survivor = fac.id;
  }
  if (survivors === 1 && survivor !== null && matchSettings(world.options).active.length > 1) {
    crown(
      world,
      survivor,
      'conquest',
      `${world.factions[survivor].name} completes the Survey. Flags are the end of Flags, and the beginning of 10 thousand Flags.`,
    );
    return;
  }
  if (survivors === 0) return;
  if (world.time >= endTime(world.options)) {
    const dominant = dominanceOrder(world)[0];
    const name = world.factions[dominant].name;
    crown(world, dominant, 'dawn', `Dawn breaks over the burn. The Survey is completed: ${name}'s Survey stands dominant.`);
    return;
  }
  if (world.time >= endTime(world.options) - DAWN_WARNING && world.scratch.dawnWarned !== true) {
    world.scratch.dawnWarned = true;
    world.emit({
      t: 'notify',
      faction: 'all',
      text: 'One minute to dawn: the camp holding the most Hearths will complete the Survey.',
      severity: 'warn',
    });
  }
}

/** End the match with `winner` crowned. Nobody else is eliminated by the crowning itself. */
function crown(world: World, winner: FactionId, reason: NonNullable<EventOf<'victory'>['reason']>, text: string): void {
  world.phase = 'ended';
  world.winner = winner;
  world.emit({ t: 'victory', faction: winner, reason });
  world.emit({ t: 'notify', faction: 'all', text, severity: 'epic' });
}

/** The Burn: the effigy burns and sudden death begins (pressure multiplied and rising, faster tides). */
function startBurn(world: World): void {
  world.suddenDeath = true;
  const soonest = world.time + TIDE_INTERVAL_SUDDEN_DEATH;
  if (world.tide.nextAt > soonest) {
    world.tide.nextAt = soonest;
    world.tide.warned = false;
  }
  world.emit({ t: 'burn' });
  world.emit({
    t: 'notify',
    faction: 'all',
    text:
      `THE BURN. The man burns away but flag remains. Surveys overwrite ×${SUDDEN_DEATH_PRESSURE_MULT}, ` +
      `rising every ${SUDDEN_DEATH_ESCALATE_EVERY} s; the Crystal turns every ${TIDE_INTERVAL_SUDDEN_DEATH} s.`,
    severity: 'epic',
  });
}

/**
 * Announce each step of the Burn's escalation exactly once, so players can read the clock.
 * The first multiplier seen is the one The Burn's own notice already announced.
 */
function announceEscalation(world: World): void {
  const mult = suddenDeathMult(world);
  const last = world.scratch.burnMult;
  if (typeof last === 'number' && mult <= last) return;
  world.scratch.burnMult = mult;
  if (typeof last !== 'number') return;
  world.emit({ t: 'notify', faction: 'all', text: `The Burn rages: Surveys overwrite ×${mult}.`, severity: 'epic' });
}
