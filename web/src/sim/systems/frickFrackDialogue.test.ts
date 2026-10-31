import { describe, expect, it } from 'vitest';
import { newMatch } from './econ/testkit';
import { cmdFrickFrack, closeFrickFrackSession, initializeFrickFrack, offerFrickFrackFlag, updateFrickFrack } from './frickFrack';
import { cmdThrow } from './avatars';
import { FRICK_FRACK_DIALOGUE, FRICK_FRACK_RETURN_DIALOGUES, frickFrackDialogue, frickFrackDialogueVariant, frickFrackTextDuration } from '../frickFrack';
import { frickFrackFromWire, frickFrackWire } from '../../net/frickFrack';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
import type { FactionId } from '../types';
import type { World } from '../world';
function arena() {
  const { world: w } = newMatch('frick-frack-suite');
  w.factions[0].isPlayer = true; initializeFrickFrack(w);
  const wizard = w.hippies.get(w.frickFrack.wizardId)!;
  const spot = w.nav.nearestWalkable(50, 50); wizard.pos = { x: spot.x, z: spot.z + 1 };
  for (const f of [0, 1] as const) {
    w.factions[f].isPlayer = true; w.factions[f].controlMode = 'avatar';
    Object.assign(w.avatarOf(f).pos, { ...spot, y: w.collision.groundHeight(spot.x, spot.z) });
  }
  return { w, wizard };
}
function visit(w: World, f: FactionId = 0) {
  expect(offerFrickFrackFlag(w, w.hippies.get(w.frickFrack.wizardId)!, f, w.avatarOf(f).carried[0])).toBe(true);
  const s = w.frickFrack.sessions[f]!; expect(s.phase).toBe('dialogue'); return s;
}
function advanceToTable(w: World, f: FactionId = 0) {
  const s = w.frickFrack.sessions[f]!;
  for (let i = 0; i < 3; i++) { w.time = s.readyAt; cmdFrickFrack(w, { t: 'frickFrack', faction: f, sessionId: s.id, revision: s.revision, action: i < 2 ? 'next' : 'play' }); }
  w.time=s.rollEndsAt!; updateFrickFrack(w);
}
describe('Frick-frack return-visit dialogue', () => {
  it('retains the original introduction and cycles six distinct three-page scripts without immediate repeats', () => {
    expect(frickFrackDialogue(0)).toBe(FRICK_FRACK_DIALOGUE); expect(FRICK_FRACK_RETURN_DIALOGUES).toHaveLength(6);
    expect(new Set(FRICK_FRACK_RETURN_DIALOGUES.map(script => script.join(' '))).size).toBe(6);
    for (const script of FRICK_FRACK_RETURN_DIALOGUES) { expect(script).toHaveLength(3); expect(script[2]).toContain('Would you like to play Frick-frack?'); expect(script.every(text => frickFrackTextDuration(text) > 2)).toBe(true); }
    expect(Array.from({ length: 14 }, (_, n) => frickFrackDialogueVariant(n))).toEqual([0,1,2,3,4,5,6,1,2,3,4,5,6,1]);
    expect(frickFrackDialogue(-1)).toBe(FRICK_FRACK_DIALOGUE); expect(frickFrackDialogue(99)).toBe(FRICK_FRACK_DIALOGUE);
  });
  it('counts conversation starts once and uses the selected script’s actual text duration', () => {
    const { w } = arena();
    for (let n = 0; n < 8; n++) {
      const s = visit(w); expect(s.dialogueVariant).toBe(frickFrackDialogueVariant(n)); expect(w.frickFrack.visits?.[0]).toBe(n + 1);
      const dialogue = frickFrackDialogue(s.dialogueVariant); expect(s.readyAt - s.dialogueStartedAt).toBeCloseTo(frickFrackTextDuration(dialogue[0]));
      w.time = s.readyAt; cmdFrickFrack(w, { t:'frickFrack', faction:0, sessionId:s.id, revision:s.revision, action:'next' });
      expect(s.readyAt - s.dialogueStartedAt).toBeCloseTo(frickFrackTextDuration(dialogue[1])); expect(w.frickFrack.visits?.[0]).toBe(n + 1);
      closeFrickFrackSession(w, 0); w.time += 2;
    }
  });
  it('tracks factions independently and resets only in a new match', () => {
    const { w } = arena(); visit(w); closeFrickFrackSession(w,0); w.time += 2;
    expect(visit(w).dialogueVariant).toBe(1); closeFrickFrackSession(w,0); w.time += 2;
    expect(visit(w,1).dialogueVariant).toBe(0); expect(w.frickFrack.visits).toEqual({0:2,1:1}); expect(arena().w.frickFrack.visits).toEqual({});
  });
  it('does not count abandoned pursuit or restart dialogue for the next hand', () => {
    const { w, wizard } = arena(); cmdThrow(w, {t:'throw', faction:0});
    const projectile = [...w.projectiles.values()].find(p => p.thrower === w.avatarOf(0).id)!;
    expect(offerFrickFrackFlag(w, wizard, 0, projectile.flagId)).toBe(true); expect(w.frickFrack.sessions[0]?.phase).toBe('chasing'); expect(w.frickFrack.visits).toEqual({});
    closeFrickFrackSession(w,0); w.time += 2; const s = visit(w); advanceToTable(w); expect(s.phase).toBe('betting'); expect(s.dialogueVariant).toBe(0);
    s.phase = 'result'; s.result = 'push'; cmdFrickFrack(w, {t:'frickFrack', faction:0, sessionId:s.id, revision:s.revision, action:'again'});
    expect(s.phase).toBe('rolling'); w.time=s.rollEndsAt!; updateFrickFrack(w); expect(s.phase).toBe('betting'); expect(s.dialogueVariant).toBe(0); expect(w.frickFrack.visits?.[0]).toBe(1);
  });
  it('replicates host-selected scripts and retained visit counters through snapshots, deltas and reconnects', () => {
    const { w } = arena(); visit(w); closeFrickFrackSession(w,0); w.time += 2; const s = visit(w);
    const encoder = new SnapshotEncoder(w), copy = <T>(v:T):T => JSON.parse(JSON.stringify(v));
    const mirror = NetMirror.create(w.options, copy(encoder.full())); expect(mirror.world.frickFrack.sessions[0]?.dialogueVariant).toBe(1); expect(mirror.world.frickFrack.visits?.[0]).toBe(2);
    closeFrickFrackSession(w,0); w.tick++; w.time += 2; mirror.push(copy({tick:w.tick,time:w.time,acks:{},delta:encoder.delta([]),events:[]})); mirror.catchUp();
    expect(mirror.world.frickFrack.sessions[0]).toBeUndefined(); expect(mirror.world.frickFrack.visits?.[0]).toBe(2);
    const restored = frickFrackFromWire(copy(frickFrackWire(w.frickFrack))); expect(restored.visits?.[0]).toBe(2); expect(frickFrackDialogueVariant(restored.visits?.[0] ?? 0)).toBe(2); expect(s.dialogueVariant).toBe(1);
  });
});
