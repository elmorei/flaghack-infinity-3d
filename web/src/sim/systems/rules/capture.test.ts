import { describe, expect, it } from 'vitest';
import {
  CAPTURE,
  IMPLIED_MAX_ORDER,
  OUTPOST_PRESSURE_MULT,
  SUDDEN_DEATH_ESCALATE_EVERY,
  SUDDEN_DEATH_PRESSURE_MULT,
} from '../../constants';
import type { GameEvent } from '../../events';
import { spawnBuilding, spawnHippie } from '../../factory';
import { criticalNodes } from '../../lattice/geometry';
import { planEnclosure } from '../../lattice/planner';
import { NEUTRAL } from '../../types';
import { burnTime, normalizeMatch } from '../../matchSettings';
import type { CaptureStage, FactionId } from '../../types';
import type { World } from '../../world';
import { isCollapsed } from '../buildings';
import { captureHearth } from '../capture';
import { depositToStock, pullFlag } from '../flags';
import { geometryOwners } from '../survey';
import { suddenDeathMult } from '../victory';
import { eventsOf, flagProblems, freeCost, must, newMatch, plantFresh, runRules } from './testWorld';

/** Strip the victim's home ring into its stock and send its people to the far side of the burn. */
function exposeHearth(world: World, victim: FactionId): void {
  const hearth = must(world.hearthOf(victim), 'hearth');
  for (const fl of [...world.flags.values()]) {
    if (fl.state === 'planted' && fl.owner === victim) depositToStock(world, fl.id, hearth.id);
  }
  sendAway(world, victim);
}

function sendAway(world: World, f: FactionId): void {
  for (const h of world.hippiesOf(f)) {
    h.pos.x = 0;
    h.pos.z = -30;
  }
  const av = world.avatarOf(f);
  av.pos.x = 0;
  av.pos.z = -30;
}

/** Plant a fresh attacker loop around the victim's Hearth with the shared planner. */
function encircle(world: World, attacker: FactionId, victim: FactionId, minRadius: number): number[] {
  const hearth = must(world.hearthOf(victim), 'hearth');
  const loop = planEnclosure(world.lattice, { x: hearth.pos.x, z: hearth.pos.z, minRadius, cost: freeCost(world, attacker) });
  return plantFresh(world, attacker, must(loop, 'enclosure loop'));
}

function stagesOf(events: GameEvent[], hearthId: number): CaptureStage[] {
  return eventsOf(events, 'hearthStage')
    .filter((e) => e.hearthId === hearthId)
    .map((e) => e.stage);
}

describe('Hearth capture', () => {
  it('contains, overwrites, captures and eliminates in 100 / baseRate + overwriteTime seconds', () => {
    const world = newMatch('capture-a');
    world.tide.nextAt = Infinity;
    exposeHearth(world, 1);
    const hearth = must(world.hearthOf(1), 'hearth');
    const hs = must(hearth.hearth, 'hearth state');
    runRules(world, 0.5);
    expect(hs.stage).toBe('safe');

    // Bare pressure (no defenders, Ward, Crystals or contest; the founder holds it): 100 after
    // 100 / baseRate seconds, then the unstoppable overwrite.
    const overwriteIn = 100 / CAPTURE.baseRate;
    const capturedIn = overwriteIn + CAPTURE.overwriteTime;
    encircle(world, 0, 1, 15);
    const total = world.flags.size;
    const t0 = world.time;
    const events = runRules(world, 0.1);
    expect(hs.stage).toBe('contained');
    expect(hs.attacker).toBe(0);
    for (const e of runRules(world, overwriteIn / 2)) events.push(e);
    expect(hs.pressure[0]).toBeCloseTo(CAPTURE.baseRate * (world.time - t0), 0);

    let capturedAt = -1;
    while (capturedAt < 0 && world.time - t0 < capturedIn + 5) {
      const batch = runRules(world, 0.1);
      for (const e of batch) events.push(e);
      if (eventsOf(batch, 'captured').length > 0) capturedAt = world.time;
    }
    expect(capturedAt - t0).toBeGreaterThan(capturedIn - 0.1);
    expect(capturedAt - t0).toBeLessThan(capturedIn + 0.3);
    // Acceptance: an undefended Hearth falls within ~40 s.
    expect(capturedAt - t0).toBeLessThanOrEqual(40);
    // …and the outpost starts over, safe, under its new owner.
    expect(stagesOf(events, hearth.id)).toEqual(['contained', 'overwritten', 'captured', 'safe']);
    expect(eventsOf(events, 'captured')).toEqual([{ t: 'captured', hearthId: hearth.id, from: 1, to: 0, pos: hearth.pos }]);
    expect(eventsOf(events, 'eliminated')).toEqual([{ t: 'eliminated', faction: 1, by: 0 }]);

    const notes = eventsOf(events, 'notify');
    expect(notes.some((n) => n.faction === 1 && n.text.includes('CONTAINED') && n.text.includes('Pull a loop Flag'))).toBe(true);
    expect(notes.some((n) => n.faction === 0 && n.text.includes('Hold the loop'))).toBe(true);

    // The Hearth is the captor's outpost now; the loser is gone.
    expect(hearth.faction).toBe(0);
    expect(hs.founder).toBe(1);
    expect(hs.stage).toBe('safe');
    expect(world.factions[0].hearthIds).toContain(hearth.id);
    expect(world.factions[0].stats.captures).toBe(1);
    const loser = world.factions[1];
    expect(loser.alive).toBe(false);
    expect(loser.hearthIds).toEqual([]);
    expect(loser.eliminatedBy).toBe(0);
    expect(world.avatarOf(1).koUntil).toBe(Infinity);
    expect(world.hippiesOf(1)).toEqual([]);
    for (const fl of world.flags.values()) {
      expect(fl.owner).not.toBe(1);
      if (fl.state === 'stock' && fl.holder === hearth.id) expect(fl.owner).toBe(0);
    }
    expect(loser.gccId).toBeNull();
    for (const b of world.buildings.values()) {
      if (b.kind === 'gcc' && b.gcc && b.faction === 1) {
        expect(b.gcc.destroyedUntil).toBe(0);
        expect(b.hp).toBe(b.maxHp);
        expect(b.disabled).toBe(false);
      }
    }
    expect(world.flags.size).toBe(total);
    expect(flagProblems(world)).toEqual([]);
    expect(world.phase).toBe('playing');
  });

  it('AE3: pulling one critical loop Flag lifts the containment and pressure decays', () => {
    const world = newMatch('capture-b');
    world.tide.nextAt = Infinity;
    exposeHearth(world, 2);
    const hearth = must(world.hearthOf(2), 'hearth');
    const hs = must(hearth.hearth, 'hearth state');
    encircle(world, 3, 2, 15);
    // Half-way to the overwrite.
    runRules(world, 50 / CAPTURE.baseRate);
    expect(hs.stage).toBe('contained');
    const peak = hs.pressure[3];
    expect(peak).toBeCloseTo(50, 0);

    const critical = criticalNodes(world.lattice, geometryOwners(world), 3, hearth.facet, IMPLIED_MAX_ORDER);
    expect(critical.length).toBeGreaterThan(0);
    const defender = world.avatarOf(2);
    expect(pullFlag(world, world.survey.nodeFlag[critical[0]], defender.id)).toBe(true);
    const events = runRules(world, 0.1);
    expect(['threatened', 'safe']).toContain(hs.stage);
    expect(stagesOf(events, hearth.id)).toHaveLength(1);
    expect(eventsOf(events, 'notify').some((n) => n.faction === 2 && n.text.includes('loop is broken'))).toBe(true);
    const after = hs.pressure[3];
    expect(after).toBeLessThan(peak);
    runRules(world, 2);
    expect(hs.pressure[3]).toBeCloseTo(after - CAPTURE.decay * 2, 0);
    // It drains at CAPTURE.decay per second and the attacker lets go at zero.
    runRules(world, hs.pressure[3] / CAPTURE.decay + 0.1);
    expect(hs.pressure[3]).toBe(0);
    expect(hs.attacker).toBeNull();
  });

  it('contests (slower) only while the owner stands at the Hearth in person', () => {
    const world = newMatch('capture-c');
    world.tide.nextAt = Infinity;
    exposeHearth(world, 1);
    const hearth = must(world.hearthOf(1), 'hearth');
    const hs = must(hearth.hearth, 'hearth state');
    encircle(world, 2, 1, 15);
    const av = world.avatarOf(1);
    av.pos.x = hearth.pos.x + CAPTURE.holdRadius - 1;
    av.pos.z = hearth.pos.z;
    const t0 = world.time;
    const events = runRules(world, 50 / (CAPTURE.baseRate * CAPTURE.contestedMult));
    expect(hs.stage).toBe('contested');
    expect(hs.pressure[2]).toBeCloseTo(CAPTURE.baseRate * CAPTURE.contestedMult * (world.time - t0), 1);
    const notes = eventsOf(events, 'notify');
    expect(notes.some((n) => n.faction === 1 && n.text.includes('Hold the Hearth'))).toBe(true);
    expect(notes.some((n) => n.faction === 2 && n.text.includes('Holds the Hearth'))).toBe(true);
    // Stepping beyond holdRadius lifts the contest; so does falling Flagless at the Hearth.
    av.pos.x = hearth.pos.x + CAPTURE.holdRadius + 1;
    runRules(world, 0.1);
    expect(hs.stage).toBe('contained');
    av.pos.x = hearth.pos.x + 2;
    runRules(world, 0.1);
    expect(hs.stage).toBe('contested');
    av.koUntil = world.time + 5;
    runRules(world, 0.1);
    expect(hs.stage).toBe('contained');

    // A home ring that still stands does not contest an outer enemy loop: the two Surveys just
    // overlap on the Hearth and the Crystal grows unstable there.
    const other = newMatch('capture-d');
    other.tide.nextAt = Infinity;
    sendAway(other, 3);
    const home = must(other.hearthOf(3), 'hearth');
    const homeState = must(home.hearth, 'hearth state');
    // Any loop that avoids the home ring's nodes (inside or outside it) encloses the Hearth too.
    encircle(other, 0, 3, 0);
    const o0 = other.time;
    runRules(other, 1);
    expect(other.inSurvey(home.facet, 3)).toBe(true);
    expect(other.inSurvey(home.facet, 0)).toBe(true);
    expect(homeState.stage).toBe('contained');
    expect(homeState.pressure[0]).toBeCloseTo(CAPTURE.baseRate * (other.time - o0), 1);
    expect(other.survey.facetInstability[home.facet]).toBeGreaterThan(0);
  });

  it('applies defender (floored), Ward and escalating sudden-death modifiers to the pressure rate', () => {
    const world = newMatch('capture-e');
    world.options.match = normalizeMatch({ bossMode: false });
    world.tide.nextAt = Infinity;
    exposeHearth(world, 0);
    const hearth = must(world.hearthOf(0), 'hearth');
    const hs = must(hearth.hearth, 'hearth state');
    encircle(world, 1, 0, 15);
    runRules(world, 0.1);
    /** Pressure gained per second over a short window, from zero each time (never near 100). */
    const rate = (): number => {
      hs.pressure[1] = 0;
      const t = world.time;
      runRules(world, 2);
      return hs.pressure[1] / (world.time - t);
    };
    expect(rate()).toBeCloseTo(CAPTURE.baseRate, 3);

    for (const h of world.hippiesOf(0).slice(0, 3)) {
      h.pos.x = hearth.pos.x + 5;
      h.pos.z = hearth.pos.z;
    }
    expect(rate()).toBeCloseTo(CAPTURE.baseRate * Math.max(CAPTURE.defenderFloor, CAPTURE.defenderMult ** 3), 3);

    // Past the floor, more defenders add nothing.
    const pastFloor = Math.ceil(Math.log(CAPTURE.defenderFloor) / Math.log(CAPTURE.defenderMult)) + 1;
    while (world.hippiesOf(0).length < pastFloor) spawnHippie(world, 0, hearth.pos);
    for (const h of world.hippiesOf(0)) {
      h.pos.x = hearth.pos.x + 5;
      h.pos.z = hearth.pos.z;
    }
    const defended = CAPTURE.baseRate * CAPTURE.defenderFloor;
    expect(rate()).toBeCloseTo(defended, 3);

    const lat = world.lattice;
    const wardFacet = lat.facetsInRadius(hearth.pos.x, hearth.pos.z, 25).find((f) => f !== hearth.facet && lat.facets[f].thick);
    spawnBuilding(world, 'ward', 0, must(wardFacet, 'ward facet'), 1);
    const warded = defended * CAPTURE.wardMult;
    expect(rate()).toBeCloseTo(warded, 3);

    // The Burn multiplies it, and burns hotter by one every SUDDEN_DEATH_ESCALATE_EVERY seconds.
    world.suddenDeath = true;
    expect(rate()).toBeCloseTo(warded * SUDDEN_DEATH_PRESSURE_MULT, 3);
    world.time = burnTime(world.options) + 2 * SUDDEN_DEATH_ESCALATE_EVERY + 1;
    expect(suddenDeathMult(world)).toBe(SUDDEN_DEATH_PRESSURE_MULT + 2);
    expect(rate()).toBeCloseTo(warded * (SUDDEN_DEATH_PRESSURE_MULT + 2), 3);
  });

  it('a captured outpost takes pressure ×OUTPOST_PRESSURE_MULT', () => {
    const world = newMatch('capture-g');
    world.tide.nextAt = Infinity;
    const outpost = must(world.hearthOf(2), 'hearth 2');
    const hs = must(outpost.hearth, 'hearth state');
    captureHearth(world, outpost, 1);
    expect(outpost.faction).toBe(1);
    expect(hs.founder).toBe(2);
    // Faction 3 encloses the outpost while its captor's people are home at their own camp.
    const loop = planEnclosure(world.lattice, { x: outpost.pos.x, z: outpost.pos.z, minRadius: 0, cost: freeCost(world, 3) });
    plantFresh(world, 3, must(loop, 'enclosure loop'));
    runRules(world, 0.1);
    expect(hs.stage).toBe('contained');
    hs.pressure[3] = 0;
    const t = world.time;
    runRules(world, 2);
    expect(hs.pressure[3] / (world.time - t)).toBeCloseTo(CAPTURE.baseRate * OUTPOST_PRESSURE_MULT, 3);
  });

  it('a captured outpost changes hands without taking the loser’s home camp', () => {
    const world = newMatch('capture-f');
    world.tide.nextAt = Infinity;
    const outpost = must(world.hearthOf(1), 'hearth 1');
    captureHearth(world, outpost, 0);
    expect(world.factions[1].alive).toBe(false);
    expect(world.factions[0].hearthIds).toEqual([must(world.hearthOf(0), 'hearth 0').id, outpost.id]);
    const homeRing = [...world.flags.values()].filter((fl) => fl.state === 'planted' && fl.owner === 0).length;
    expect(homeRing).toBeGreaterThan(0);
    // Faction 1's ring stands on as orphaned (neutral) Flags: they occupy their nodes, so no
    // implied Flag may appear on one, and they hold nothing for anyone.
    runRules(world, 0.05);
    const neutral = [...world.flags.values()].filter((fl) => fl.state === 'planted' && fl.owner === NEUTRAL);
    expect(neutral.length).toBeGreaterThan(0);
    for (const fl of neutral) {
      expect(world.survey.impliedOwner[fl.node]).toBe(-1);
      expect(world.survey.holder[fl.node]).toBe(-1);
    }

    // Faction 2 takes the outpost back from faction 0: faction 0 survives with its home camp.
    const gcc0 = must(world.gccOf(0), 'gcc 0');
    world.drainEvents();
    captureHearth(world, outpost, 2);
    const events = world.drainEvents();
    expect(world.factions[0].alive).toBe(true);
    expect(world.factions[0].hearthIds).toHaveLength(1);
    expect(world.factions[2].hearthIds).toContain(outpost.id);
    expect(eventsOf(events, 'eliminated')).toEqual([]);
    expect([...world.flags.values()].filter((fl) => fl.state === 'planted' && fl.owner === 0)).toHaveLength(homeRing);
    expect(isCollapsed(gcc0)).toBe(false);
    expect(world.hippiesOf(0).length).toBeGreaterThan(0);
    expect(flagProblems(world)).toEqual([]);
    // Neutral Flags never linger with a dead owner.
    for (const fl of world.flags.values()) expect(fl.owner === NEUTRAL || world.factions[fl.owner].alive).toBe(true);
  });

  it('a fallen outpost’s Signifiers scatter neutral while the survivor’s home camp stays loyal', () => {
    const world = newMatch('capture-g');
    world.tide.nextAt = Infinity;
    const outpost = must(world.hearthOf(1), 'hearth 1');
    captureHearth(world, outpost, 0);
    const home = must(world.hearthOf(0), 'hearth 0');

    // Station one of faction 0's Signifiers at the outpost, holding a Flag from home stock.
    const [stationed, ...homeCrew] = world.hippiesOf(0);
    stationed.pos = { x: outpost.pos.x + 2, z: outpost.pos.z + 2 };
    const carried = must(world.stockOf(home.id)[0], 'stock Flag');
    carried.state = 'carried';
    carried.holder = stationed.id;
    stationed.carryingFlag = carried.id;
    for (const h of homeCrew) h.pos = { x: home.pos.x + 3, z: home.pos.z + 3 };

    captureHearth(world, outpost, 2);
    expect(world.factions[0].alive).toBe(true);
    expect(stationed.faction).toBe(NEUTRAL);
    expect(stationed.carryingFlag).toBe(-1);
    expect(carried.state).toBe('loose');
    for (const h of homeCrew) expect(h.faction).toBe(0);
    expect(flagProblems(world)).toEqual([]);
  });
});
