import { describe, expect, it } from 'vitest';
import { BOSS_TIMING } from '../boss';
import { SIM_DT } from '../constants';
import { spawnBuilding, spawnHippie, spawnPiece } from '../factory';
import { normalizeMatch } from '../matchSettings';
import { createMatch } from '../setup';
import type { BuildingKind, PieceKind } from '../types';
import { bossFocusAltar, consumeBuilding, spawnBoss, updateBoss } from './boss';
import { moveBuilding, registerBuildingShape } from './buildings';
import { captureHearth } from './capture';
import { attachPiece, piecePosition } from './pieces';

const BUILDINGS: BuildingKind[] = ['hearth', 'workshop', 'drumcircle', 'ward', 'druglab'];
const PIECES: PieceKind[] = ['wall', 'floor', 'ramp'];
const STRUCTURES = [...BUILDINGS, ...PIECES];

function opportunity(kind: BuildingKind | PieceKind, distance = 6) {
  const w = createMatch({ seed: 'boss-structure-selection', difficulty: 'normal', humans: [0, 1], mode: 'standard',
    match: normalizeMatch({ maxSignifiers: 0 }) });
  w.time = 1000;
  w.effigyRevealedAt = 990;
  const b = spawnBoss(w)!;
  b.eye.nextFireAt = Infinity;
  w.survey.edgeLey.fill(-1);
  w.survey.version++;
  for (const av of w.avatars.values()) av.pos = { x: -100, y: 0, z: -100 };
  for (const h of w.hippies.values()) h.pos = { x: -100, z: -100 };
  // Stage a deterministic, unobstructed path to the locked altar. The nearby
  // opportunity is a different faction's structure and never the strategic focus.
  for (const building of w.buildings.values()) moveBuilding(w, building, -100, -100);
  const facet = w.lattice.facets.filter(f => !f.boundary)
    .sort((a, c) => Math.hypot(a.cx, a.cz - 50) - Math.hypot(c.cx, c.cz - 50))[0];
  const building = BUILDINGS.includes(kind as BuildingKind);
  const s = building ? spawnBuilding(w, kind as BuildingKind, 0, facet.id, 1)
    : spawnPiece(w, kind as PieceKind, 0, kind === 'wall' ? facet.edges[0] : -1,
      kind === 'wall' ? -1 : facet.id, 0, kind === 'ramp' ? 0 : -1);
  if (s.type === 'building') registerBuildingShape(w, s);
  else attachPiece(w, s);
  const at = s.type === 'building' ? s.pos : piecePosition(w, s)!;
  const focus = w.hearthOf(3)!;
  moveBuilding(w, focus, at.x, at.z + 30);
  w.factions[3].stats.cmi = 100000;
  Object.assign(b, { pos: { x: at.x, z: at.z - distance }, yaw: 0, action: 'idle',
    actionAt: w.time, nextAttackAt: 0, crouched: true, actionSeq: 0, hitSeq: -1 });
  b.objectiveAltarId = focus.id;
  expect(bossFocusAltar(w)).toBe(focus);
  w.drainEvents();
  return { w, b, s, at, focus };
}

describe('boss structural attack selection', () => {
  it.each(STRUCTURES)('selects and eats a nearby non-focus %s regardless of its HP', kind => {
    const { w, b, s } = opportunity(kind);
    s.hp = s.maxHp = 100000;
    updateBoss(w, SIM_DT);
    expect(b.focusFaction).toBe(3);
    expect(b.target).toEqual({ kind: s.type, id: s.id });
    expect(b.action).toBe('grab');
    const started = b.actionAt;
    w.time = started + BOSS_TIMING.grasp - .001;
    updateBoss(w, SIM_DT);
    expect(b.held).toBeNull();
    w.time = started + BOSS_TIMING.grasp;
    updateBoss(w, SIM_DT);
    expect(b.held).toMatchObject({ kind: s.type, id: s.id, faction: 0 });
    w.time = started + BOSS_TIMING.consume - .001;
    updateBoss(w, SIM_DT);
    expect((s.type === 'building' ? w.buildings : w.pieces).has(s.id)).toBe(true);
    expect(s.hp).toBe(100000);
    w.time = started + BOSS_TIMING.consume;
    updateBoss(w, SIM_DT);
    expect((s.type === 'building' ? w.buildings : w.pieces).has(s.id)).toBe(false);
    expect(w.factions[0].alive).toBe(true);
  });

  it.each(STRUCTURES.filter(kind => kind !== 'hearth'))('chooses a standing stomp and occasional crouched swipes against %s', kind => {
    const { w, b, s, at } = opportunity(kind, 3);
    b.crouched = false;
    updateBoss(w, SIM_DT);
    expect(b.target).toEqual({ kind: s.type, id: s.id });
    expect(b.action).toBe('stomp');
    expect(b.crouched).toBe(false);
    const choices: string[] = [];
    for (let sequence = 0; sequence < 6; sequence++) {
      Object.assign(b, { pos: { x: at.x, z: at.z - 6 }, action: 'idle', actionAt: w.time,
        actionSeq: sequence, crouched: true, nextAttackAt: w.time, held: null });
      updateBoss(w, SIM_DT);
      expect(b.target).toEqual({ kind: s.type, id: s.id });
      expect(b.crouched).toBe(true);
      expect(['grab', 'swipe']).toContain(b.action);
      choices.push(b.action);
    }
    expect(choices).toContain('grab');
    expect(choices).toContain('swipe');
    // Both selections use the same authoritative attack timing and respect cooldown.
    Object.assign(b, { action: 'idle', actionAt: w.time, nextAttackAt: w.time + 1 });
    updateBoss(w, SIM_DT);
    expect(b.action).toBe('idle');
  });

  it.each([false, true])('always crouches to eat a close altar instead of repeatedly stomping or swiping it (focus=%s)', focused => {
    const { w, b, s, at } = opportunity('hearth', 3);
    if (focused) w.factions[0].stats.cmi = 200000;
    for (let sequence = 0; sequence < 6; sequence++) {
      Object.assign(b, { pos: { x: at.x, z: at.z - 3 }, action: 'idle', actionAt: w.time,
        actionSeq: sequence, crouched: false, nextAttackAt: w.time, held: null });
      updateBoss(w, SIM_DT);
      expect(b.target).toEqual({ kind: 'building', id: s.id });
      expect(b.action).toBe('crouch');
      w.time = b.actionAt + BOSS_TIMING.transition;
      updateBoss(w, SIM_DT);
      expect(b.crouched).toBe(true);
      w.time += SIM_DT;
      updateBoss(w, SIM_DT);
      expect(b.action).toBe('grab');
      expect(b.target).toEqual({ kind: 'building', id: s.id });
    }
  });

  it.each([
    { label: 'disabled workshop', kind: 'workshop' as const, state: 'disabled' },
    { label: 'unfinished drug lab', kind: 'druglab' as const, state: 'unfinished' },
  ])('selects $label as an eat target', ({ kind, state }) => {
    const { w, b, s } = opportunity(kind);
    if (s.type !== 'building') throw new Error('Building fixture expected');
    if (state === 'disabled') { s.disabled = true; s.hp = 0; }
    else if (state === 'unfinished') { s.built = .05; s.hp = 100000; }
    updateBoss(w, SIM_DT);
    expect(b.target).toEqual({ kind: 'building', id: s.id });
    expect(b.action).toBe('grab');
    w.time = b.actionAt + BOSS_TIMING.consume;
    updateBoss(w, SIM_DT);
    expect(w.buildings.has(s.id)).toBe(false);
    expect(w.factions[0].alive).toBe(true);
    if (s.gcc) expect(w.factions[0].gccId).toBeNull();
  });
});

describe('boss swipe damage boundaries', () => {
  it.each(BUILDINGS.filter(kind => kind !== 'hearth'))('deals 110 damage to %s, then permanently removes the last HP on a later swipe', kind => {
    const { w, b, s } = opportunity(kind);
    if (s.type !== 'building') throw new Error('Building fixture expected');
    s.hp = s.maxHp = 111;
    Object.assign(b, { action: 'swipe', actionAt: w.time, actionSeq: 10, hitSeq: 9 });
    w.time += BOSS_TIMING.swipeHit;
    updateBoss(w, SIM_DT);
    expect(s.hp).toBe(1);
    expect(s.disabled).toBe(false);
    expect(w.buildings.has(s.id)).toBe(true);
    updateBoss(w, SIM_DT);
    expect(s.hp).toBe(1);
    Object.assign(b, { actionAt: w.time, actionSeq: 11 });
    w.time += BOSS_TIMING.swipeHit;
    updateBoss(w, SIM_DT);
    expect(w.buildings.has(s.id)).toBe(false);
    expect(w.factions[0].alive).toBe(true);
  });

  it('deals exactly 100 once to an avatar and hippie, including lethal launch', () => {
    const { w, b, at } = opportunity('workshop');
    const avatar = w.avatarOf(1);
    avatar.pos = { ...at, y: 0 };
    avatar.hp = 101;
    const hippie = spawnHippie(w, 1, { x: at.x + 1, z: at.z });
    hippie.hp = 100;
    Object.assign(b, { action: 'swipe', actionAt: w.time, actionSeq: 10, hitSeq: 9 });
    w.time += BOSS_TIMING.swipeHit;
    updateBoss(w, SIM_DT);
    updateBoss(w, SIM_DT);
    expect(avatar.hp).toBe(1);
    expect(hippie.hp).toBe(0);
    expect(hippie.status).toBe('ko');
    expect(avatar.vel.y).toBe(12);
    expect(hippie.airborne?.vy).toBe(15);
    const hits = w.drainEvents().filter(e => e.t === 'hit' && (e.target === avatar.id || e.target === hippie.id));
    expect(hits).toHaveLength(2);
    expect(hits.every(e => e.t === 'hit' && e.amount === 100 && e.by === b.id)).toBe(true);
  });

  it.each(['stomp', 'swipe'] as const)('%s damages an altar but cannot remove it or reduce HP below one', attack => {
    const { w, b, s } = opportunity('hearth');
    if (s.type !== 'building') throw new Error('Building fixture expected');
    for (const hp of [100000, 250, 110, 2, 1]) {
      s.hp = hp;
      Object.assign(b, { pos: { x: s.pos.x, z: s.pos.z - 2 }, action: attack,
        actionAt: w.time, actionSeq: b.actionSeq + 1, held: null });
      const hitAt = attack === 'stomp' ? BOSS_TIMING.stompHit : BOSS_TIMING.swipeHit;
      w.time = b.actionAt + hitAt - .001;
      updateBoss(w, SIM_DT);
      expect(s.hp).toBe(hp);
      w.time = b.actionAt + hitAt;
      updateBoss(w, SIM_DT);
      updateBoss(w, SIM_DT);
      expect(s.hp).toBe(Math.max(1, hp - (attack === 'stomp' ? 250 : 110)));
      expect(w.buildings.get(s.id)).toBe(s);
      expect(s.disabled).toBe(false);
      expect(w.factions[0].hearthIds).toContain(s.id);
      expect(w.factions[0].alive).toBe(true);
      expect(w.drainEvents().some(e => e.t === 'buildingDisabled' && e.buildingId === s.id || e.t === 'eliminated')).toBe(false);
    }
  });

  it('walking foot impacts and defensive destroy calls preserve an altar down to one HP', () => {
    const { w, b, s } = opportunity('hearth', 3);
    if (s.type !== 'building') throw new Error('Building fixture expected');
    const distant = w.avatarOf(2);
    distant.pos = { x: s.pos.x, y: 0, z: s.pos.z + 35 };
    for (const hp of [1000, 2, 1]) {
      s.hp = hp;
      Object.assign(b, { pos: { x: s.pos.x, z: s.pos.z - 3 }, action: 'idle', actionAt: w.time,
        crouched: false, stride: 3.89, retaliateId: distant.id, retaliateUntil: w.time + 100 });
      updateBoss(w, SIM_DT); // Cross the actual right-foot contact at half the7.8m stride.
      expect(b.action).toBe('walk');
      expect(b.stride).toBeGreaterThan(3.9);
      expect(s.hp).toBe(Math.max(1, hp - 250));
      expect(w.buildings.get(s.id)).toBe(s);
      consumeBuilding(w, s, true);
      expect(w.buildings.get(s.id)).toBe(s);
      expect(w.factions[0].hearthIds).toContain(s.id);
      expect(w.factions[0].alive).toBe(true);
    }
  });

  it('counts a captured altar for its current owner, not its founder, until the final owned altar is eaten', () => {
    const { w, b, s } = opportunity('hearth');
    if (s.type !== 'building') throw new Error('Building fixture expected');
    const original = w.hearthOf(0)!;
    // A real capture updates ownership/indices before the encounter begins.
    w.effigyRevealedAt = null;
    captureHearth(w, s, 1);
    w.effigyRevealedAt = 990;
    expect(s.faction).toBe(1);
    expect(s.hearth!.founder).toBe(0);
    const firstOwned = w.hearthOf(1)!;
    moveBuilding(w, firstOwned, s.pos.x + 30, s.pos.z);
    for (const [index, altar] of [firstOwned, s].entries()) {
      Object.assign(b, { pos: { x: altar.pos.x, z: altar.pos.z - 6 }, action: 'grab',
        actionAt: w.time, actionSeq: b.actionSeq + 1, target: { kind: 'building', id: altar.id }, held: null });
      w.time += BOSS_TIMING.consume;
      updateBoss(w, SIM_DT);
      expect(w.factions[1].alive).toBe(index === 0);
      expect(w.factions[0].alive).toBe(true);
      expect(w.buildings.has(original.id)).toBe(true);
    }
  });
});
