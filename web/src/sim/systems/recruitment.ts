/** Recruitment changes allegiance within the shared population; it never creates a hippie. */
import type { CommandOf } from '../commands';
import { AVATAR, RECRUIT_RADIUS } from '../constants';
import type { GameEvent } from '../events';
import { NEUTRAL } from '../types';
import type { Building, FactionId, Hippie } from '../types';
import type { World } from '../world';
import { isCollapsed } from './buildings';
import { hasEffect } from './effects';
import { dropLoose, giveFlag } from './flags';
import { breakChannel } from './units/channel';

type RecruitVia = Extract<GameEvent, { t: 'recruited' }>['via'];

export function canRecruit(h: Hippie): boolean {
  return h.faction === NEUTRAL && h.status !== 'ko' && h.koUntil === 0 && h.hp > 0;
}

export function isRecruiter(world: World, b: Building): boolean {
  return (b.kind === 'drumcircle' || b.kind === 'gcc') && b.faction !== NEUTRAL &&
    world.factions[b.faction].alive && b.built >= 1 && !b.disabled && !isCollapsed(b);
}

/** Also used by Dialectics: a new allegiance gets a new place in the soft-cap queue. */
export function enlist(world: World, h: Hippie, f: FactionId, via: RecruitVia): void {
  h.faction = f;
  h.recruitedAt = world.time;
  h.order = null;
  h.job = null;
  h.status = 'idle';
  h.statusTarget = null;
  h.beacon = true;
  world.factions[f].stats.hippiesRecruited++;
  world.emit({ t: 'recruited', hippieId: h.id, faction: f, via });
}

/** A real carried or thrown Flag changes hands, preserving its identity and inventory. */
export function recruitWithFlag(world: World, h: Hippie, f: FactionId, flagId: number, via: 'hand' | 'throw'): boolean {
  const flag = world.flags.get(flagId);
  if (!world.factions[f].alive || !canRecruit(h) || h.carryingFlag !== -1 || h.carryingLumber > 0 || !flag) return false;
  if (flag.state !== 'carried' && flag.state !== 'flying') return false;
  if (flag.state === 'flying') dropLoose(world, flag.id, { x: h.pos.x, y: 0, z: h.pos.z });
  // Flag inventories require an affiliated recipient. Validation above makes the transfer safe.
  h.faction = f;
  if (!giveFlag(world, flagId, h.id)) {
    h.faction = NEUTRAL;
    return false;
  }
  enlist(world, h, f, via);
  return true;
}

export function handFlagBlocker(world: World, f: FactionId, target: number): string {
  const av = world.avatarOf(f);
  const h = world.hippies.get(target);
  if (!world.factions[f].alive || !av || av.koUntil > 0 || hasEffect(world, av, 'stun')) return 'You cannot hand over a Flag right now.';
  if (av.action.kind === 'swing' || av.action.kind === 'plant') return 'Finish your current action first.';
  if (!h || !canRecruit(h)) return 'Choose an awake neutral Signifier.';
  if (h.carryingFlag !== -1 || h.carryingLumber > 0) return 'That Signifier has its hands full.';
  if (!av.carried.length) return 'Your quiver is empty.';
  if (Math.hypot(h.pos.x - av.pos.x, av.pos.y, h.pos.z - av.pos.z) > AVATAR.pullReach) return 'Move closer to hand over a Flag.';
  const dx = h.pos.x - av.pos.x, dz = h.pos.z - av.pos.z;
  const distance = Math.hypot(dx, av.pos.y, dz);
  if (distance > 0 && world.collision.raycast(av.pos.x, av.pos.y + 1, av.pos.z, dx, -av.pos.y, dz, distance)) return 'Something blocks the handoff.';
  return '';
}

export function cmdHandFlag(world: World, c: CommandOf<'handFlag'>): void {
  const why = handFlagBlocker(world, c.faction, c.hippieId);
  if (why) {
    world.emit({ t: 'rejected', faction: c.faction, reason: why });
    return;
  }
  const av = world.avatarOf(c.faction);
  if (recruitWithFlag(world, world.hippies.get(c.hippieId)!, c.faction, av.carried.at(-1)!, 'hand')) breakChannel(world, av);
}

/** Nearest eligible neutral, with stable id tie-breaking when two stand equally close. */
export function recruitNear(world: World, b: Building): boolean {
  if (!isRecruiter(world, b) || b.faction === NEUTRAL) return false;
  let best: Hippie | undefined;
  let bestD = RECRUIT_RADIUS * RECRUIT_RADIUS;
  for (const h of world.hippies.values()) {
    if (!canRecruit(h)) continue;
    const d = (h.pos.x - b.pos.x) ** 2 + (h.pos.z - b.pos.z) ** 2;
    if (d > bestD || (d === bestD && best && h.id > best.id)) continue;
    best = h;
    bestD = d;
  }
  if (!best) return false;
  enlist(world, best, b.faction, b.kind === 'gcc' ? 'gcc' : 'drumcircle');
  return true;
}
