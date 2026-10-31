import { describe, expect, it, vi } from 'vitest';
import { newMatch } from './econ/testkit';
import { cmdThrow, updateAvatars } from './avatars';
import { updateHippies } from './hippies';
import { applyCommands } from './commands';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';
import { frickFrackFromWire, frickFrackWire } from '../../net/frickFrack';
import { initializeFrickFrack, isFrickFrackLocked, offerFrickFrackFlag, updateFrickFrack, closeFrickFrackSession, cmdFrickFrack, stepFrickFrackWizard, resetFrickFrackEntropy } from './frickFrack';
import type { World } from '../world';
function arena() {
  const { world: w } = newMatch('wizard-chase'); w.factions[0].isPlayer = true; initializeFrickFrack(w);
  const av = w.avatarOf(0), wizard = w.hippies.get(w.frickFrack.wizardId)!;
  for (const h of [...w.hippies.values()]) if (h !== wizard) w.hippies.delete(h.id);
  let pair: { x: number; z: number; tx: number; tz: number } | undefined;
  for (let x = 30; x < 90 && !pair; x += 6) for (let z = 30; z < 90 && !pair; z += 6) {
    if (w.nav.lineOfSight(x, z, x + 14, z) && !w.collision.blockedCircle(x, z, 1, .2, 3) && !w.collision.blockedCircle(x + 14, z, 1, .2, 3)) pair = { x, z, tx: x + 14, tz: z };
  }
  if (!pair) throw new Error('No clear test route');
  wizard.pos = { x: pair.x, z: pair.z }; wizard.vel = { x: 0, z: 0 };
  Object.assign(av.pos, { x: pair.tx, z: pair.tz, y: w.collision.groundHeight(pair.tx, pair.tz) });
  return { w, av, wizard };
}
function thrown(w: World, f: 0 | 1 = 0) {
  const av = w.avatarOf(f); cmdThrow(w, { t: 'throw', faction: f });
  const p = [...w.projectiles.values()].find(p => p.thrower === av.id)!;
  expect(p).toBeDefined();
  expect(offerFrickFrackFlag(w, w.hippies.get(w.frickFrack.wizardId)!, f, p.flagId)).toBe(true);
  return p.flagId;
}
function step(w: World, seconds: number) {
  for (let i = 0; i < Math.ceil(seconds * 30); i++) { w.time += 1 / 30; updateFrickFrack(w); updateHippies(w, 1 / 30); }
}
describe('Wizard thrown-Flag pursuit', () => {
  it('keeps gifts and movement unlocked until physical arrival, then starts dialogue exactly once', () => {
    const { w, av, wizard } = arena(), start = { ...wizard.pos }, flags = [...av.carried];
    const gifted = thrown(w), session = w.frickFrack.sessions[0]!;
    expect(session.phase).toBe('chasing'); expect(isFrickFrackLocked(w, 0)).toBe(false);
    expect(av.carried.slice().sort()).toEqual(flags.slice().sort()); expect(av.carried).toContain(gifted);
    const initial = { ...av.pos };
    w.submit({ t: 'avatarInput', faction: 0, input: { moveX: .5, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 } });
    applyCommands(w); updateAvatars(w, .1);
    expect(Math.hypot(av.pos.x - initial.x, av.pos.z - initial.z)).toBeGreaterThan(0);
    cmdFrickFrack(w, { t: 'frickFrack', faction: 0, sessionId: session.id, revision: session.revision, action: 'play' });
    expect(session.phase).toBe('chasing');
    step(w, .8); expect(Math.hypot(wizard.pos.x - start.x, wizard.pos.z - start.z)).toBeGreaterThan(1);
    step(w, 8); expect(session.phase).toBe('dialogue'); expect(isFrickFrackLocked(w, 0)).toBe(true);
    expect(Math.hypot(wizard.pos.x - av.pos.x, wizard.pos.z - av.pos.z)).toBeLessThanOrEqual(2.3);
    expect(session.dialogueStartedAt).toBeGreaterThan(.8); expect(session.readyAt).toBeGreaterThan(session.dialogueStartedAt);
    const revision = session.revision; step(w, 1); expect(session.revision).toBe(revision);
    expect(wizard.facing).toBeCloseTo(Math.atan2(av.pos.x - wizard.pos.x, av.pos.z - wizard.pos.z));
    expect(av.yaw).toBeCloseTo(Math.atan2(wizard.pos.x - av.pos.x, wizard.pos.z - av.pos.z));
  });
  it('catches repeated gifts without restarting the pursuit or duplicating Flags', () => {
    const { w, av } = arena(); const first = thrown(w), old = { ...w.frickFrack.sessions[0]! };
    w.time += 1; const second = thrown(w);
    expect(w.frickFrack.sessions[0]).toEqual(old); expect(av.carried).toContain(first); expect(av.carried).toContain(second);
    expect(new Set(av.carried).size).toBe(av.carried.length); expect(w.projectiles.size).toBe(0);
    expect(offerFrickFrackFlag(w, w.hippies.get(w.frickFrack.wizardId)!, 0, first)).toBe(false);
  });
  it('tracks a moving player with budgeted navigation and cannot talk across a wall', () => {
    const { w, av, wizard } = arena(); thrown(w); const b = brainOf(wizard), sys = unitsState(w);
    step(w, .5); av.pos.z += 5; stepFrickFrackWizard(w, sys, wizard, b, 1 / 30);
    expect(b.goalX).toBe(av.pos.x); expect(b.goalZ).toBe(av.pos.z);
    Object.assign(av.pos, { x: wizard.pos.x + 1, z: wizard.pos.z, y: w.collision.groundHeight(wizard.pos.x + 1, wizard.pos.z) });
    const los = vi.spyOn(w.nav, 'lineOfSight').mockReturnValue(false);
    stepFrickFrackWizard(w, sys, wizard, b, 1 / 30);
    expect(w.frickFrack.sessions[0]?.phase).toBe('chasing'); expect(isFrickFrackLocked(w, 0)).toBe(false);
    expect(b.route).toBe('queued'); expect(sys.pathQueue.filter(id => id === wizard.id)).toHaveLength(1);
    stepFrickFrackWizard(w, sys, wizard, b, 1 / 30); expect(sys.pathQueue.filter(id => id === wizard.id)).toHaveLength(1);
    los.mockRestore();
  });
  it('routes around an actual blocking wall without crossing it', () => {
    const { w, av, wizard } = arena();
    const midX = (wizard.pos.x + av.pos.x) / 2, midZ = wizard.pos.z;
    w.nav.blockSegment(midX, midZ - 2, midX, midZ + 2, .5, 999999);
    w.collision.addBox(midX, midZ, .5, 2, 0, 0, 8, 999999);
    expect(w.nav.lineOfSight(wizard.pos.x, wizard.pos.z, av.pos.x, av.pos.z)).toBe(false);
    thrown(w);
    let wentAround = false;
    for (let i = 0; i < 900 && w.frickFrack.sessions[0]?.phase === 'chasing'; i++) {
      step(w, 1 / 30);
      expect(Math.abs(wizard.pos.x - midX) < .45 && Math.abs(wizard.pos.z - midZ) < 1.95).toBe(false);
      if (Math.abs(wizard.pos.z - midZ) > 2) wentAround = true;
    }
    expect(wentAround).toBe(true); expect(w.frickFrack.sessions[0]?.phase).toBe('dialogue');
  });
  it('does not talk to a player on an unreachable elevated platform', () => {
    const { w, av, wizard } = arena(); thrown(w);
    Object.assign(av.pos, { x: wizard.pos.x + .1, z: wizard.pos.z, y: w.collision.groundHeight(wizard.pos.x, wizard.pos.z) + 5 });
    stepFrickFrackWizard(w, unitsState(w), wizard, brainOf(wizard), .1);
    expect(w.frickFrack.sessions[0]?.phase).toBe('chasing'); expect(isFrickFrackLocked(w, 0)).toBe(false);
  });
  it.each(['ko', 'defeat', 'wizard', 'end', 'disconnect', 'timeout'] as const)('cleans pursuit on %s without consuming the gifted Flag', cause => {
    const { w, av, wizard } = arena(), gifted = thrown(w);
    if (cause === 'ko') av.koUntil = w.time + 10;
    else if (cause === 'defeat') w.factions[0].alive = false;
    else if (cause === 'wizard') wizard.status = 'ko';
    else if (cause === 'end') w.phase = 'ended';
    else if (cause === 'disconnect') closeFrickFrackSession(w, 0);
    else w.time += 121;
    updateFrickFrack(w); expect(w.frickFrack.sessions[0]).toBeUndefined(); expect(av.carried).toContain(gifted);
  });
  it('queues pursuits without pulling the wizard away from an active conversation', () => {
    const { w, av, wizard } = arena(); thrown(w); step(w, 9); expect(w.frickFrack.sessions[0]?.phase).toBe('dialogue');
    w.factions[1].isPlayer = true; const other = w.avatarOf(1); Object.assign(other.pos, { ...av.pos, x: av.pos.x + 12 });
    thrown(w, 1); const before = { ...wizard.pos }; step(w, 1);
    expect(wizard.pos).toEqual(before); expect(w.frickFrack.sessions[1]?.phase).toBe('chasing');
    closeFrickFrackSession(w, 0); step(w, .5);
    expect(Math.hypot(wizard.pos.x - before.x, wizard.pos.z - before.z)).toBeGreaterThan(.2); expect(isFrickFrackLocked(w, 1)).toBe(false);
  });
  it.each(['wizard-horizontal', 'wizard-airborne', 'avatar-horizontal', 'avatar-airborne'] as const)('releases a dialogue interrupted by %s without consuming Flags', cause => {
    const { w, av, wizard } = arena(); wizard.pos = { x: av.pos.x, z: av.pos.z + 1 };
    const flags = [...av.carried]; expect(offerFrickFrackFlag(w, wizard, 0, av.carried[0])).toBe(true);
    if (cause === 'wizard-horizontal') wizard.pos.x += 7;
    else if (cause === 'wizard-airborne') wizard.airborne = { y: 3, vy: 10 };
    else if (cause === 'avatar-horizontal') av.pos.x += 7;
    else av.pos.y += 3;
    updateFrickFrack(w);
    expect(w.frickFrack.sessions[0]).toBeUndefined(); expect(isFrickFrackLocked(w, 0)).toBe(false); expect(av.carried).toEqual(flags);
  });
  it('forfeits only an already committed wager when a table is physically interrupted', () => {
    const { w, av, wizard } = arena(); wizard.pos = { x: av.pos.x, z: av.pos.z + 1 };
    const before = av.carried.length; offerFrickFrackFlag(w, wizard, 0, av.carried[0]); const s = w.frickFrack.sessions[0]!;
    for (let i = 0; i < 3; i++) { w.time = s.readyAt; cmdFrickFrack(w, {t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:i<2?'next':'play'}); }
    s.target=21;s.dieResult=1;w.time=s.rollEndsAt!;updateFrickFrack(w);
    resetFrickFrackEntropy(w, 'frick-tarot-3'); cmdFrickFrack(w, {t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:'bet',wager:2});
    expect(s.phase).toBe('playing'); expect(av.carried.length).toBe(before - 2);
    wizard.pos.x += 7; updateFrickFrack(w); updateFrickFrack(w);
    expect(w.frickFrack.sessions[0]).toBeUndefined(); expect(av.carried.length).toBe(before - 2);
    cmdFrickFrack(w, {t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:'stand'});
    expect(av.carried.length).toBe(before - 2);
  });
  it('keeps minor displacement within the conversation tolerance, and distant pursuit remains unlocked', () => {
    const { w, av, wizard } = arena(); thrown(w); updateFrickFrack(w);
    expect(w.frickFrack.sessions[0]?.phase).toBe('chasing'); expect(isFrickFrackLocked(w,0)).toBe(false);
    step(w, 9); expect(w.frickFrack.sessions[0]?.phase).toBe('dialogue');
    wizard.pos = {x:av.pos.x+4,z:av.pos.z}; wizard.airborne={y:1,vy:0};
    updateFrickFrack(w); expect(w.frickFrack.sessions[0]?.phase).toBe('dialogue');
  });
  it('rejects handoff outside reach and replicates chasing without private cards', () => {
    const { w, av, wizard } = arena(); expect(offerFrickFrackFlag(w, wizard, 0, av.carried[0])).toBe(false);
    expect(w.frickFrack.sessions[0]).toBeUndefined(); thrown(w);
    const state = frickFrackFromWire(frickFrackWire(w.frickFrack));
    expect(state.sessions[0]).toEqual(w.frickFrack.sessions[0]); expect(state.sessions[0]?.phase).toBe('chasing'); expect(state.sessions[0]?.dealer).toEqual([]);
  });
});
