import { describe, expect, it } from 'vitest';
import {
  CRYSTAL_GROW_TIME,
  CRYSTAL_RITUAL_PER_SEC,
  HEARTH_OBSERVE_RADIUS,
  INSTABILITY_RISE,
  TIDE_INTERVAL,
  TIDE_WARNING,
} from '../../constants';
import { spawnZone } from '../../factory';
import type { World } from '../../world';
import { canPlantAt, defendedPullRate, isBuildingCorner, plantSimulacrum, pullFlag } from '../flags';
import { isObserved } from '../survey';
import { applyFlip } from '../tides';
import { campDistance, eventsOf, flagProblems, freeFocus, loopAround, must, newMatch, plantFresh, runRules } from './testWorld';

/** A flippable, plantable node far from every camp and unobserved by anyone. */
function remoteFlippable(world: World): number {
  const lat = world.lattice;
  for (const n of lat.nodes) {
    if (!lat.flippable(n.id) || !canPlantAt(world, n.id, 0) || world.survey.nodeObserved[n.id] !== 0) continue;
    if (campDistance(world, n.x, n.z) > 50) return n.id;
  }
  throw new Error('no remote flippable node');
}

describe('Phason tides and Zeno observation', () => {
  it('decohere a dangling unobserved Flag but skip Flags their owner observes', () => {
    const world = newMatch('tides-a');
    world.tide.nextAt = Infinity;
    runRules(world, 0.1);
    const lat = world.lattice;

    const lonely = remoteFlippable(world);
    const from = { x: lat.nodes[lonely].x, z: lat.nodes[lonely].z };
    const [id] = plantFresh(world, 0, [lonely]);
    runRules(world, 0.05);
    expect(isObserved(world, lonely, 0)).toBe(false);
    expect(applyFlip(world, lonely, 'tide')).toBe(true);
    const fl = must(world.flags.get(id), 'flag');
    expect(fl.state).toBe('loose');
    expect(fl.pos.x).toBeCloseTo(from.x, 9);
    expect(fl.pos.z).toBeCloseTo(from.z, 9);
    expect(world.survey.nodeFlag[lonely]).toBe(-1);
    const events = world.drainEvents();
    expect(eventsOf(events, 'flagDecohered')).toEqual([{ t: 'flagDecohered', flagId: id, node: lonely, pos: fl.pos }]);
    const flip = must(eventsOf(events, 'phasonFlip')[0], 'flip event');
    expect(flip.cause).toBe('tide');
    expect(flip.from).toEqual(from);
    expect(Math.hypot(flip.to.x - from.x, flip.to.z - from.z)).toBeGreaterThan(0.5);
    expect(world.survey.dirty).toBe(true);
    expect(flagProblems(world)).toEqual([]);

    // Near its Hearth a Flag is observed by its owner: tides and storms skip it, Phason Shift does not.
    const hearth = must(world.hearthOf(0), 'hearth');
    const near = lat
      .nodesInRadius(hearth.pos.x, hearth.pos.z, HEARTH_OBSERVE_RADIUS - 1)
      .find((n) => lat.flippable(n) && canPlantAt(world, n, 0));
    const watched = must(near, 'flippable node near the Hearth');
    plantFresh(world, 0, [watched]);
    runRules(world, 0.05);
    expect(isObserved(world, watched, 0)).toBe(true);
    expect(applyFlip(world, watched, 'tide')).toBe(false);
    expect(applyFlip(world, watched, 'storm')).toBe(false);
    expect(applyFlip(world, watched, 'ability')).toBe(true);

    // Buildings pin their facet: none of its corners ever flips.
    for (const n of lat.facets[hearth.facet].nodes) {
      expect(isBuildingCorner(world, n)).toBe(true);
      expect(applyFlip(world, n, 'ability')).toBe(false);
    }
    // Stabilize zones block every flip, abilities included.
    const shielded = remoteFlippable(world);
    const sn = lat.nodes[shielded];
    spawnZone(world, 'stabilize', 1, { x: sn.x, z: sn.z }, 16, 20, 1);
    expect(applyFlip(world, shielded, 'ability')).toBe(false);
    expect(lat.flippable(shielded)).toBe(true);
  });

  it('a flip under one half of a simulacrum collapses it onto the other', () => {
    const world = newMatch('tides-c');
    world.tide.nextAt = Infinity;
    runRules(world, 0.1);
    const lat = world.lattice;
    const a = remoteFlippable(world);
    const b = must(
      lat.nodes.find((n) => n.id !== a && canPlantAt(world, n.id, 1) && Math.hypot(n.x - lat.nodes[a].x, n.z - lat.nodes[a].z) > 40 && campDistance(world, n.x, n.z) > 50),
      'second node',
    ).id;
    const av = world.avatarOf(1);
    const id = av.carried[0];
    expect(plantSimulacrum(world, id, a, b, 1, av.id)).toBe(true);
    runRules(world, 0.05);
    expect(applyFlip(world, a, 'tide')).toBe(true);
    const fl = must(world.flags.get(id), 'simulacrum');
    expect(fl.state).toBe('planted');
    expect(fl.node).toBe(b);
    expect(fl.altNode).toBe(-1);
    const events = world.drainEvents();
    expect(eventsOf(events, 'simulacrumCollapsed')).toEqual([{ t: 'simulacrumCollapsed', flagId: id, kept: b, vanished: a, faction: 1 }]);
    expect(eventsOf(events, 'flagDecohered')).toEqual([]);
    expect(flagProblems(world)).toEqual([]);
  });

  it('Canon III: a closed loop observes itself and survives a full tide', () => {
    const world = newMatch('tides-b');
    world.tide.nextAt = Infinity;
    runRules(world, 0.1);
    const loop = loopAround(world, 2, 0, 100, 10);
    runRules(world, 0.05);
    const s = world.survey;
    for (const n of loop) expect(isObserved(world, n, 2)).toBe(true);
    const flippableLoop = loop.filter((n) => world.lattice.flippable(n));
    for (const n of flippableLoop) expect(applyFlip(world, n, 'tide')).toBe(false);
    const centre = world.lattice.facetAt(0, 100);
    expect(world.inSurvey(centre, 2)).toBe(true);

    // Tide schedule: warning TIDE_WARNING before, then ≈5% of flippable nodes are chosen and
    // turn as a front sweeps the burn.
    const breaksAt = world.time + TIDE_WARNING + 0.5;
    world.tide.nextAt = breaksAt;
    let events = runRules(world, 0.6);
    expect(eventsOf(events, 'tideWarning')).toHaveLength(1);
    expect(eventsOf(events, 'notify').some((n) => n.faction === 'all' && n.text === 'The Crystal is turning…')).toBe(true);
    events = runRules(world, TIDE_WARNING - 0.1);
    const tide = eventsOf(events, 'tide');
    expect(tide).toHaveLength(1);
    expect(tide[0].flips).toBeGreaterThan(5);
    expect(world.tide.count).toBe(1);
    expect(world.tide.nextAt).toBeCloseTo(breaksAt + TIDE_INTERVAL, 1);

    // The wave: flips arrive over the next seconds in pulses, ordered along the sweep direction.
    const dir = must(tide[0].dir, 'wave direction');
    const flips = eventsOf(events, 'phasonFlip').filter((e) => e.cause === 'tide');
    let ticksWithFlips = flips.length > 0 ? 1 : 0;
    for (let i = 0; i < 25; i++) {
      const batch = eventsOf(runRules(world, 0.1), 'phasonFlip').filter((e) => e.cause === 'tide');
      if (batch.length > 0) ticksWithFlips++;
      for (const e of batch) flips.push(e);
    }
    expect(flips.length).toBeGreaterThan(5);
    expect(flips.length).toBeLessThanOrEqual(tide[0].flips);
    expect(ticksWithFlips).toBeGreaterThan(5);
    for (let i = 1; i < flips.length; i++) {
      const prev = flips[i - 1].from.x * dir.x + flips[i - 1].from.z * dir.z;
      expect(flips[i].from.x * dir.x + flips[i].from.z * dir.z).toBeGreaterThanOrEqual(prev - 1e-9);
    }
    for (const n of loop) expect(world.flags.get(s.nodeFlag[n])?.owner).toBe(2);
    runRules(world, 0.05);
    expect(world.inSurvey(centre, 2)).toBe(true);
    expect(flagProblems(world)).toEqual([]);
  });
});

describe('Crystals', () => {
  it('a full pentacle manifests a Crystal; pulling one pentacle Flag shatters it', () => {
    const world = newMatch('crystal-a');
    world.tide.nextAt = Infinity;
    runRules(world, 0.1);
    const lat = world.lattice;
    const star = freeFocus(world, 3);
    const ids = plantFresh(world, 3, lat.neighbors(star));
    let events = runRules(world, 0.05);
    const manifest = eventsOf(events, 'crystalManifest');
    expect(manifest).toHaveLength(1);
    expect(manifest[0].node).toBe(star);
    expect(manifest[0].faction).toBe(3);
    const crystal = must(world.crystals.get(manifest[0].crystalId), 'crystal');
    expect(crystal.growth).toBeLessThan(1);
    expect(defendedPullRate(world, world.flags.get(ids[0])!, 0)).toBe(1);
    expect(canPlantAt(world, star, 0)).toBe(false);

    // Income follows growth: while it grows (linearly over CRYSTAL_GROW_TIME) it pays about
    // half the full rate, then the full CRYSTAL_RITUAL_PER_SEC once grown.
    const ritual = world.factions[3].ritual;
    runRules(world, CRYSTAL_GROW_TIME + 0.1);
    expect(crystal.growth).toBe(1);
    for (const id of ids) {
      expect(defendedPullRate(world, world.flags.get(id)!, 0, true)).toBe(0.5);
      expect(defendedPullRate(world, world.flags.get(id)!, 3)).toBe(1);
    }
    const lightning = eventsOf(world.drainEvents(), 'crystalLightning');
    expect(lightning.map(e => e.flagId)).toEqual(ids);
    expect(lightning.every(e => e.crystalId === crystal.id)).toBe(true);
    const unrelated = [...world.flags.values()].find(f => f.owner === 3 && f.state === 'planted' && !crystal.pentacle.includes(f.node))!;
    expect(defendedPullRate(world, unrelated, 0)).toBe(1);
    const ramp = world.factions[3].ritual - ritual;
    expect(ramp).toBeGreaterThan(CRYSTAL_RITUAL_PER_SEC * (CRYSTAL_GROW_TIME / 2));
    expect(ramp).toBeLessThan(CRYSTAL_RITUAL_PER_SEC * (CRYSTAL_GROW_TIME / 2 + 0.2));
    const grown = world.factions[3].ritual;
    runRules(world, 1);
    expect(world.factions[3].ritual - grown).toBeCloseTo(CRYSTAL_RITUAL_PER_SEC, 6);
    expect(world.factions[3].stats.crystalsManifested).toBe(1);
    expect(world.factions[3].stats.cmi).toBe(100 + world.survey.surveySize[3]);
    expect(isObserved(world, star, 3)).toBe(true);

    expect(pullFlag(world, ids[2], -1)).toBe(true);
    events = runRules(world, 0.05);
    expect(eventsOf(events, 'crystalShatter').map((e) => e.crystalId)).toEqual([crystal.id]);
    expect(world.crystals.size).toBe(0);
    expect(defendedPullRate(world, world.flags.get(ids[0])!, 0)).toBe(1);
  });
});

describe('Instability', () => {
  it('overlapping Surveys shimmer, then discharge; Stabilize zones calm them', () => {
    const world = newMatch('instab-a');
    world.tide.nextAt = Infinity;
    const x = -100;
    const z = 0;
    loopAround(world, 0, x, z, 8);
    loopAround(world, 3, x, z, 20);
    runRules(world, 0.05);
    const lat = world.lattice;
    const facet = lat.facetAt(x, z);
    expect(world.inSurvey(facet, 0)).toBe(true);
    expect(world.inSurvey(facet, 3)).toBe(true);
    const inst = world.survey.facetInstability;

    const hippie = world.hippiesOf(3)[0];
    hippie.pos.x = lat.facets[facet].cx;
    hippie.pos.z = lat.facets[facet].cz;
    let events = runRules(world, 5);
    expect(inst[facet]).toBeCloseTo(INSTABILITY_RISE * 5, 1);
    expect(eventsOf(events, 'instability').map((e) => e.level)).toEqual(['shimmer']);
    expect(hippie.effects.some((e) => e.kind === 'psychosis' || e.kind === 'resonance')).toBe(true);

    events = runRules(world, 4);
    expect(inst[facet]).toBeGreaterThan(0.65);
    expect(eventsOf(events, 'instability').map((e) => e.level)).toEqual(['discharge']);
    expect(eventsOf(events, 'discharge').length).toBeGreaterThan(0);

    spawnZone(world, 'stabilize', 0, { x, z }, 30, 20, 1);
    runRules(world, 0.05);
    expect(inst[facet]).toBe(0);
  });
});

