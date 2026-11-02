import { describe, expect, it, vi } from 'vitest';
import { createMatch } from '../setup';
import { normalizeMatch } from '../matchSettings';
import { BOSS_MAX_HP, BOSS_RADIUS, BOSS_TIMING } from '../boss';
import { AVATAR, SIM_DT } from '../constants';
import { spawnBuilding, spawnHippie } from '../factory';
import { Simulation } from '../simulation';
import { createAi } from '../../ai';
import { cmdSwing, updateAvatars } from './avatars';
import { bossFocusAltar, consumeBuilding, spawnBoss, updateBoss } from './boss';
import { damageEntity } from './combat';
import { updateHippies } from './hippies';
import { pullFlag } from './flags';
import { bossLoopEdges, sweepBossLoops, sweepCircleSegment } from './boss/barriers';
import type { World } from '../world';

function encounter(bossHp?: number): World {
  const w = createMatch({ seed: 'boss-combat', difficulty: 'normal', humans: [0, 1], mode: 'standard', match: normalizeMatch({ bossHp }) });
  w.time = 1000; w.effigyRevealedAt = 1000; w.suddenDeath = true;
  spawnBoss(w); w.boss!.action = 'idle'; w.boss!.nextAttackAt = 0;
  for (const h of w.hippies.values()) { h.pos.x = 90; h.pos.z = 90; }
  for (const a of w.avatars.values()) { a.pos.x = 85; a.pos.z = 85; }
  return w;
}
function tick(w: World, seconds: number): void { for (let i = 0; i < Math.ceil(seconds / SIM_DT); i++) { w.time += SIM_DT; updateBoss(w, SIM_DT); } }

function handAttackEncounter(attack: 'swipe' | 'grab') {
  const w = encounter(), b = w.boss!;
  b.pos = { x: 0, z: 0 }; b.yaw = 0;
  // Isolate stance selection from boundary detours; boundary interception has its own tests.
  w.survey.edgeLey.fill(-1); w.survey.version++;
  const target = attack === 'swipe' ? w.avatarOf(0) : w.hearthOf(1)!;
  target.pos.x = 0; target.pos.z = 9;
  if (attack === 'swipe') { b.retaliateId = target.id; b.retaliateUntil = w.time + 100; }
  else { w.factions[1].stats.cmi = 10000; b.objectiveAltarId = target.id; }
  return { w, b, target };
}

describe('authoritative boss encounter', () => {
  it('spawns once with the 50,000 HP default', () => {
    const w = encounter(), b = w.boss!;
    expect(b.hp).toBe(50000); expect(b.maxHp).toBe(BOSS_MAX_HP);
    expect(spawnBoss(w)).toBe(b); expect(w.drainEvents().filter(e => e.t === 'notify' && e.text.includes('awakened'))).toHaveLength(1);
  });
  it.each([100, 12345, 1000000])('reads configured HP %s at spawn and never heals from a later settings edit', hp => {
    const w = encounter(hp), b = w.boss!;
    expect(b.hp).toBe(hp); expect(b.maxHp).toBe(hp);
    damageEntity(w, b.id, 25, w.avatarOf(0).id);
    w.options.match = normalizeMatch({ bossHp: 50000 });
    expect(spawnBoss(w)).toBe(b); expect(b.hp).toBe(hp - 25); expect(b.maxHp).toBe(hp);
  });
  it('chooses a random altar independently of CMI and only draws once until it is gone', () => {
    const w = encounter(), b = w.boss!; w.factions[0].stats.cmi = 100000;
    const rng = vi.spyOn(w.rng, 'next').mockReturnValue(.75);
    expect(bossFocusAltar(w)).toBeNull(); expect(rng).not.toHaveBeenCalled();
    tick(w, .1); expect(b.objectiveAltarId).toBe(w.hearthOf(3)!.id); expect(rng).toHaveBeenCalledTimes(1);
    w.factions[1].stats.cmi = 200000;
    for (let i = 0; i < 100; i++) bossFocusAltar(w);
    tick(w, 1); expect(b.objectiveAltarId).toBe(w.hearthOf(3)!.id); expect(rng).toHaveBeenCalledTimes(1);
  });
  it('retaliates briefly then returns to its locked altar', () => {
    const w = encounter(), b = w.boss!; w.factions[3].stats.cmi = 900; b.objectiveAltarId = w.hearthOf(3)!.id;
    const a = w.avatarOf(0); a.pos = { x: b.pos.x + 25, y: 0, z: b.pos.z };
    damageEntity(w, b.id, 22, a.id); tick(w, .05);
    expect(b.target).toEqual({ kind: 'avatar', id: a.id });
    w.time = b.retaliateUntil + 1; b.action = 'idle'; updateBoss(w, SIM_DT);
    expect(b.target).toEqual({ kind: 'building', id: w.hearthOf(3)!.id });
  });
  for (const attack of ['swipe', 'grab'] as const) {
    it(`${attack} waits for the full crouch transition and stays crouched through recovery`, () => {
      const { w, b, target } = handAttackEncounter(attack);
      const start = w.time;
      updateBoss(w, SIM_DT);
      expect(b.action).toBe('crouch'); expect(b.crouched).toBe(false);
      expect(b.actionAt).toBe(start);
      w.time = start + BOSS_TIMING.transition - .001; updateBoss(w, SIM_DT);
      expect(b.action).toBe('crouch'); expect(b.crouched).toBe(false);
      w.time = start + BOSS_TIMING.transition; updateBoss(w, SIM_DT);
      expect(b.action).toBe('idle'); expect(b.crouched).toBe(true);
      w.time += SIM_DT; updateBoss(w, SIM_DT);
      expect(b.action).toBe(attack); expect(b.crouched).toBe(true);
      const attackAt = b.actionAt, attackSeq = b.actionSeq;
      // A target leaving during windup must not interrupt the low attack or recovery.
      target.pos.z = 40;
      for (const age of [.1, BOSS_TIMING[attack] - .001]) {
        w.time = attackAt + age; updateBoss(w, SIM_DT);
        expect(b.action).toBe(attack); expect(b.crouched).toBe(true);
        expect(b.actionAt).toBe(attackAt); expect(b.actionSeq).toBe(attackSeq);
      }
      w.time = attackAt + BOSS_TIMING[attack]; updateBoss(w, SIM_DT);
      expect(b.action).toBe('idle'); expect(b.crouched).toBe(true);
      expect(b.nextAttackAt).toBeCloseTo(w.time + (attack === 'swipe' ? .275 : .55));
      w.time += SIM_DT; updateBoss(w, SIM_DT);
      expect(b.action).toBe('idle'); expect(b.crouched).toBe(true);
      w.time = b.nextAttackAt; updateBoss(w, SIM_DT);
      expect(b.action).toBe('rise'); expect(b.crouched).toBe(true);
      w.time = b.actionAt + BOSS_TIMING.transition - .001; updateBoss(w, SIM_DT);
      expect(b.action).toBe('rise'); expect(b.crouched).toBe(true);
      w.time = b.actionAt + BOSS_TIMING.transition; updateBoss(w, SIM_DT);
      expect(b.action).toBe('idle'); expect(b.crouched).toBe(false);
    });
    it(`${attack} can start directly from crouch-walk without another stance transition`, () => {
      const { w, b } = handAttackEncounter(attack);
      b.action = 'crouchWalk'; b.crouched = true;
      updateBoss(w, SIM_DT);
      expect(b.action).toBe(attack); expect(b.crouched).toBe(true);
      expect(b.actionAt).toBe(w.time);
    });
    it(`${attack} repairs a stale stance bit without restarting its timing or held target`, () => {
      const { w, b } = handAttackEncounter(attack);
      b.action = attack; b.crouched = false; b.actionAt = w.time - .2;
      b.actionSeq = 40; b.hitSeq = 39;
      b.held = { kind: 'flag', id: 123456, faction: -1, x: 0, z: 6 };
      const at = b.actionAt, held = b.held;
      updateBoss(w, SIM_DT);
      expect(b.crouched).toBe(true); expect(b.action).toBe(attack);
      expect(b.actionAt).toBe(at); expect(b.actionSeq).toBe(40); expect(b.hitSeq).toBe(39);
      expect(b.held).toBe(held);
      b.crouched = false;
      w.time = at + BOSS_TIMING[attack]; updateBoss(w, SIM_DT);
      expect(b.action).toBe('idle'); expect(b.crouched).toBe(true);
    });
  }
  it('swipe damage happens once at its hit window and launches both kinds of unit', () => {
    const w = encounter(), b = w.boss!; b.pos = { x: 0, z: 0 }; b.yaw = 0;
    const a = w.avatarOf(0); a.pos = { x: 0, y: 0, z: 6 };
    const h = spawnHippie(w, 0, { x: 1, z: 6 });
    b.crouched = true; b.action = 'swipe'; b.actionAt = w.time; b.actionSeq = 20;
    expect(BOSS_TIMING.swipe).toBe(1.2); expect(BOSS_TIMING.swipeHit).toBe(.55);
    w.time += BOSS_TIMING.swipeHit - .01; updateBoss(w, SIM_DT); expect(a.hp).toBe(AVATAR.maxHp);
    w.time += .01; updateBoss(w, SIM_DT); expect(a.hp).toBe(AVATAR.maxHp - 100); expect(h.hp).toBe(0);
    expect(a.vel.y).toBeGreaterThan(10); expect(h.airborne?.vy).toBe(15);
    for (let i = 0; i < 12; i++) updateBoss(w, SIM_DT);
    expect(a.hp).toBe(AVATAR.maxHp - 100); expect(h.hp).toBe(0); expect(h.status).toBe('ko');
    const x = h.pos.x; w.time += SIM_DT; updateHippies(w, SIM_DT);
    expect(h.airborne!.y).toBeGreaterThan(0); expect(h.pos.x).toBeGreaterThan(x);
  });
  it('stomp does at least a 100-HP hippie knockout', () => {
    const w = encounter(), b = w.boss!; const h = spawnHippie(w, -1, { x: b.pos.x + 1, z: b.pos.z });
    b.action = 'stomp'; b.actionAt = w.time - BOSS_TIMING.stompHit; b.actionSeq = 7;
    updateBoss(w, SIM_DT); expect(h.hp).toBe(0); expect(h.status).toBe('ko');
  });
  it('holds a structure at grasp and consumes once later on the host clock', () => {
    const w = encounter(), b = w.boss!, altar = w.hearthOf(1)!;
    b.pos = { x: altar.pos.x, z: altar.pos.z - 6 }; b.target = { kind: 'building', id: altar.id };
    b.action = 'grab'; b.actionAt = w.time; b.actionSeq = 40;
    w.time += BOSS_TIMING.grasp; updateBoss(w, SIM_DT);
    expect(b.held?.id).toBe(altar.id); expect(w.buildings.has(altar.id)).toBe(true);
    w.time = b.actionAt + BOSS_TIMING.consume; updateBoss(w, SIM_DT);
    expect(w.buildings.has(altar.id)).toBe(false); expect(w.factions[1].alive).toBe(false);
    updateBoss(w, SIM_DT); expect(w.drainEvents().filter(e => e.t === 'eliminated' && e.faction === 1)).toHaveLength(1);
  });
  it('only the final owned altar loss eliminates its camp', () => {
    const w = encounter(), first = w.hearthOf(0)!;
    const other = spawnBuilding(w, 'hearth', 0, first.facet, 1);
    w.factions[0].hearthIds.push(other.id);
    consumeBuilding(w, first); expect(w.factions[0].alive).toBe(true); expect(w.hearthOf(0)).toBe(other);
    consumeBuilding(w, other); expect(w.factions[0].alive).toBe(false);
  });
  it('death cancels attacks and remains playing until the full burn ends', () => {
    const w = encounter(), b = w.boss!; damageEntity(w, b.id, BOSS_MAX_HP, w.avatarOf(0).id);
    expect(b.action).toBe('death'); const at = b.deathAt!;
    tick(w, 11.5); expect(b.action).toBe('death'); expect(w.phase).toBe('playing');
    w.time = at + 12.01; updateBoss(w, SIM_DT); expect(b.action).toBe('dead');
  });
  it('blocks friendly damage after reveal but allows flag pulling and preboss combat', () => {
    const w = encounter(), a = w.avatarOf(0), ally = w.avatarOf(1), b = w.boss!;
    ally.pos = { x: 0, y: 0, z: 2 }; a.pos = { x: 0, y: 0, z: 0 }; b.pos = { x: 40, z: 40 };
    expect(damageEntity(w, ally.id, 25, a.id)).toBe(false); expect(ally.hp).toBe(AVATAR.maxHp);
    const flag = [...w.flags.values()].find(f => f.owner === 1 && f.state === 'planted')!;
    expect(pullFlag(w, flag.id, a.id)).toBe(true);
    w.effigyRevealedAt = null; expect(damageEntity(w, ally.id, 25, a.id)).toBe(true); expect(ally.hp).toBe(AVATAR.maxHp - 25);
  });
  it('a configured 5,000 HP baseline still takes about 137 seconds at the unchanged held staff cadence', () => {
    const w = encounter(5000), b = w.boss!, a = w.avatarOf(0); b.pos = { x: 0, z: 3 }; a.pos = { x: 0, y: 0, z: 0 };
    a.yaw = 0; a.input.yaw = 0;
    // Continuous contact baseline excludes evasion, walking and boss damage, just like the approved diagnostic.
    w.collision = { moveCharacter: () => ({ onGround: true }), supportHeight: () => 2, groundHeight: () => 2 } as unknown as World['collision'];
    w.time = 0;
    while (w.time < 852.5) w.time += SIM_DT;
    let last = -Infinity, accumulator = 0, queued = false; const start = w.time;
    for (let frame = 0; frame < 260 * 60 && b.hp > 0; frame++) {
      const heldCommand = w.time - last >= AVATAR.swingTime;
      if (heldCommand) last = w.time;
      accumulator += 1 / 60;
      queued ||= heldCommand;
      while (accumulator >= SIM_DT) {
        w.time += SIM_DT;
        if (queued) cmdSwing(w, { t: 'swing', faction: 0 });
        queued = false;
        updateAvatars(w, SIM_DT);
        accumulator -= SIM_DT;
      }
    }
    console.log(JSON.stringify({ bossStaffTestingHP: b.maxHp, elapsed: w.time - start }));
    expect(b.hp).toBe(0); expect(w.time - start).toBeGreaterThan(134); expect(w.time - start).toBeLessThan(141);
  });
  it('NPC rival issues allied movement and damages the boss through ordinary staff commands', () => {
    const w = encounter(), b = w.boss!; b.pos = { x: 0, z: 0 };
    const a = w.avatarOf(1); a.pos = { x: 0, y: 0, z: -4 }; const ai = createAi(w, [1]), sim = new Simulation(w);
    b.action = 'emerge'; b.actionAt = w.time + 100;
    for (let i = 0; i < 40; i++) { ai.update(); sim.step(); }
    expect(b.hp).toBeLessThan(BOSS_MAX_HP); expect(a.input.yaw).toBeCloseTo(0, 1);
  });

});

describe('boss loop footprint sweep', () => {
  it('stops before the center crosses an edge, including a whole-tick crossing and endpoints', () => {
    const a = { x: -5, z: 0 }, b = { x: 5, z: 0 };
    expect(sweepCircleSegment({ x: 0, z: -10 }, { x: 0, z: 10 }, a, b, 2)).toBeCloseTo(.4);
    expect(sweepCircleSegment({ x: 6, z: -10 }, { x: 6, z: 10 }, a, b, 2)).toBeCloseTo((10 - Math.sqrt(3)) / 20);
    expect(sweepCircleSegment({ x: 0, z: -1 }, { x: 0, z: 1 }, a, b, 2)).toBe(0);
    expect(sweepCircleSegment({ x: 0, z: -1 }, { x: 0, z: -3 }, a, b, 2)).toBeNull();
  });
  it('every initial home loop blocks the boss footprint and pulling a flag invalidates cache', () => {
    const w = encounter(), edges = bossLoopEdges(w); expect(edges.length).toBeGreaterThan(8);
    const edge = w.lattice.edges[edges[0]], a = w.lattice.nodes[edge.a], b = w.lattice.nodes[edge.b];
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    const hit = sweepBossLoops(w, { x: mx - nx * 10, z: mz - nz * 10 }, { x: mx + nx * 10, z: mz + nz * 10 });
    expect(hit).not.toBeNull(); expect(hit!.fraction).toBeLessThan(.5);
    w.survey.edgeLey.fill(-1); w.survey.version++;
    expect(bossLoopEdges(w)).toHaveLength(0);
  });
});
