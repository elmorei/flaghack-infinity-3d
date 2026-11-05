import { describe, expect, it } from 'vitest';
import { createMatch } from '../setup';
import { frickFrackDialogue } from '../frickFrack';
import { frickFrackFlags } from '../frickFrackInventory';
import type { CommandOf } from '../commands';
import { parseCommand } from '../../net/validate';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
import { applyCommands } from './commands';
import { cmdTalkWizard, cmdFrickFrack, updateFrickFrack } from './frickFrack';
import { destroyFlag } from './flags';

function setup() {
  const w = createMatch({ seed: 'mobile-wizard', humans: [0], difficulty: 'normal', mode: 'standard', rtsFactions: [0] });
  w.factions[0].controlMode = 'rts'; w.factions[0].isPlayer = true;
  const wizardId = w.frickFrack.wizardId;
  return { w, wizardId, talk: { t: 'talkWizard', faction: 0, wizardId } as CommandOf<'talkWizard'> };
}
function act(w: ReturnType<typeof setup>['w'], action: CommandOf<'frickFrack'>['action'], extras: Partial<CommandOf<'frickFrack'>> = {}) {
  const s = w.frickFrack.sessions[0]!;
  const cmd: CommandOf<'frickFrack'> = { t: 'frickFrack', faction: 0, sessionId: s.id, revision: s.revision, action, ...extras };
  w.submit(cmd); applyCommands(w); return cmd;
}
function play(w: ReturnType<typeof setup>['w']) {
  const s = w.frickFrack.sessions[0]!;
  const dialogue = frickFrackDialogue(s.dialogueVariant);
  for (let i = 0; i < dialogue.length; i++) { w.time = s.readyAt; act(w, i === dialogue.length - 1 ? 'play' : 'next'); }
}

describe('mobile wizard command, real stock and multiplayer', () => {
  it('initializes for a Degen-only player and starts once with no avatar body or entry fee', () => {
    const { w, talk, wizardId } = setup(); expect(wizardId).toBeGreaterThanOrEqual(0);
    w.avatars.clear(); const flags = frickFrackFlags(w, 0);
    w.submit(talk); w.submit(talk); applyCommands(w);
    expect(w.frickFrack.sessions[0]?.phase).toBe('dialogue'); expect(w.frickFrack.visits?.[0]).toBe(1);
    expect(frickFrackFlags(w, 0)).toEqual(flags); updateFrickFrack(w); expect(w.frickFrack.sessions[0]).toBeDefined();
  });
  it('spends real camp stock once, not dormant avatar flags, and mirrors the table privately', () => {
    const { w, talk } = setup();
    cmdTalkWizard(w, talk); play(w); const before = frickFrackFlags(w, 0).length;
    const bet = act(w, 'bet', { wager: 1 }); cmdFrickFrack(w, bet);
    expect(frickFrackFlags(w, 0)).toHaveLength(before - 1);
    expect(w.frickFrack.sessions[0]?.phase).toBe('rolling');
    const encoder = new SnapshotEncoder(w);
    const mirror = NetMirror.create(w.options, JSON.parse(JSON.stringify(encoder.full())));
    expect(mirror.world.frickFrack.sessions[0]).toEqual(w.frickFrack.sessions[0]);
    expect(frickFrackFlags(mirror.world, 0)).toHaveLength(before - 1);
    act(w, 'exit'); expect(w.frickFrack.sessions[0]).toBeUndefined(); expect(frickFrackFlags(w, 0)).toHaveLength(before - 1);
  });
  it('settles and pays into real stock without needing a roaming avatar', () => {
    const { w, talk } = setup(); w.avatars.clear();
    cmdTalkWizard(w, talk); play(w); act(w, 'bet', { wager: 1 });
    const s = w.frickFrack.sessions[0]!; w.time = s.rollEndsAt!; updateFrickFrack(w);
    if (s.phase === 'playing') act(w, 'stand');
    expect(['result', 'empty']).toContain(s.phase); expect(frickFrackFlags(w, 0).every(id => w.flags.get(id)?.state === 'stock')).toBe(true);
  });
  it('zero camp flags reaches the empty dialogue without spending another faction’s or carried flags', () => {
    const { w, talk } = setup(); for (const id of frickFrackFlags(w, 0)) destroyFlag(w, id);
    const before = [...w.flags.keys()]; cmdTalkWizard(w, talk); play(w);
    expect(w.frickFrack.sessions[0]?.phase).toBe('empty'); expect([...w.flags.keys()]).toEqual(before);
  });
  it('rejects stale, foreign, invalid and simultaneous requests without replacing a table', () => {
    const { w, talk } = setup();
    cmdTalkWizard(w, { ...talk, wizardId: w.factions[0].gccId! }); expect(w.frickFrack.sessions[0]).toBeUndefined();
    cmdTalkWizard(w, talk); const original = structuredClone(w.frickFrack.sessions[0]);
    w.factions[1].controlMode = 'rts'; w.factions[1].isPlayer = true; cmdTalkWizard(w, { ...talk, faction: 1 });
    expect(w.frickFrack.sessions[1]).toBeUndefined(); expect(w.frickFrack.sessions[0]).toEqual(original);
    w.factions[0].alive = false; updateFrickFrack(w); expect(w.frickFrack.sessions[0]).toBeUndefined();
    cmdTalkWizard(w, talk); expect(w.frickFrack.sessions[0]).toBeUndefined();
  });
  it('strictly validates the tap command and does not let avatar players talk across the map', () => {
    const { w, talk } = setup(); expect(parseCommand(talk)).toEqual(talk);
    for (const wizardId of [-1, .2, Infinity, '2']) expect(parseCommand({ ...talk, wizardId })).toBeNull();
    expect(parseCommand({ ...talk, wager: 1 })).toBeNull();
    w.factions[0].controlMode = 'avatar'; w.hippies.get(talk.wizardId)!.pos.x = 200;
    cmdTalkWizard(w, talk); expect(w.frickFrack.sessions[0]).toBeUndefined();
  });
});
