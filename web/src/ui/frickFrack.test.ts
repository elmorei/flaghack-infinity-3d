import { describe, expect, it } from 'vitest';
import { FRICK_FRACK_TABLE_RULES, cardLabel, clampWager, revealedDialogue, activeFrickFrack, canConfirmMajor, majorPublicBlocker } from './frickFrack';
import { FRICK_FRACK_DIALOGUE, FRICK_FRACK_LETTER_SECONDS, createFrickFrackState } from '../sim/frickFrack';
import { newMatch } from '../sim/systems/econ/testkit';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('./frickFrack.css', import.meta.url), 'utf8');
import { Session } from '../game/session';
import { frickFrackInputLocked } from '../game/frickFrackControls';

function setup() {
  const { world } = newMatch('frick-ui'); const session = new Session(); session.screen = 'playing';
  world.frickFrack = createFrickFrackState();
  world.frickFrack.sessions[0] = { id: 1, revision: 0, faction: 0, phase: 'dialogue', dialogueIndex: 0, dialogueStartedAt: 0, readyAt: 5, wager: 0, player: [], dealer: [], result: null, message: '' };
  return { world, session };
}

describe('Frick-frack presentation model', () => {
  it('explains opponent-only combat and end-hand poker prizes without changing blackjack ranks', () => {
    const rules = FRICK_FRACK_TABLE_RULES.join(' ');
    expect(rules).toContain('opponent CCG cards only');
    expect(rules).toContain('Friendly cards coexist');
    expect(rules).toContain('equal values both die');
    expect(rules).toContain('base win profit by 2, 3, or 4');
    expect(rules).toContain('returned stake is not multiplied');
    expect(rules).toContain('extra stake is added separately');
    expect(rules).toContain('even on a blackjack loss or push');
    expect(rules).toContain('No straight prize for a bust');
    expect(rules).toContain('no mid-hand award');
    expect(rules).toContain('printed ranks, never effect-modified values');
    expect(rules).toContain('10–J–Q–K–A, with no wraparound');
    expect(rules).toContain('Knight is a distinct kind rank');
    expect(rules).toContain('printed 1 is an Ace for poker only');
  });
  it('has at least three real typewriter windows, with no immediate full-text reveal', () => {
    expect(FRICK_FRACK_DIALOGUE.length).toBeGreaterThanOrEqual(3);
    const text = FRICK_FRACK_DIALOGUE[0];
    expect(revealedDialogue(text, 0)).toBe('');
    expect(revealedDialogue(text, -5)).toBe('');
    expect(revealedDialogue(text, FRICK_FRACK_LETTER_SECONDS * 3.1)).toBe(text.slice(0, 3));
    expect(revealedDialogue(text, 1000)).toBe(text);
  });
  it('uses transparent lower dialogue chrome, with the table backdrop retained separately', () => {
    expect(css).toContain('.ff-overlay.ff-in-world { background: transparent');
    expect(css).toContain('max-height: 42dvh');
    expect(css).toContain('.ff-conversation-active .fh-ui { visibility: hidden; }');
  });
  it('leaves controls and camera available during wizard pursuit', () => {
    const app = setup(); app.world.frickFrack.sessions[0]!.phase = 'chasing';
    expect(frickFrackInputLocked(app.world, app.session)).toBe(false);
    expect(activeFrickFrack(app)).toBeNull();
  });
  it('wagers are whole held Flags and cannot use an invalid input as a larger bet', () => {
    expect(clampWager(3.9, 8)).toBe(3); expect(clampWager(99, 8)).toBe(8);
    expect(clampWager(-5, 8)).toBe(1); expect(clampWager(NaN, 8)).toBe(1);
    expect(clampWager(Infinity, 8)).toBe(1); expect(clampWager(1, 0)).toBe(0);
  });
  it('requires distinct owned targets and an explicit affordable Devil payment', () => {
    const hand = [{id: 1, rank: 10, suit: 0}, {id: 2, rank: 4, suit: 1}];
    expect(canConfirmMajor(14, [1,2], hand, 1, 3, 3)).toBe(true);
    expect(canConfirmMajor(14, [1,1], hand, 1, 3, 3)).toBe(false);
    expect(canConfirmMajor(4, [99], hand, 1, 3, 3)).toBe(false);
    expect(canConfirmMajor(15, [1], hand, 1, 3, 2)).toBe(false);
    expect(canConfirmMajor(15, [1], hand, 1, 3, 3)).toBe(true);
    expect(canConfirmMajor(1, [], hand, 0, 3, 3)).toBe(false);
    expect(canConfirmMajor(1, [], hand, 7, 3, 3)).toBe(true);
    expect(canConfirmMajor(1, [], hand, 8, 3, 3)).toBe(false);
    expect(canConfirmMajor(0, [], [], 1, 3, 3)).toBe(false);
  });
  it('keeps effect controls phase-gated and explains publicly known unavailable effects', () => {
    const s = setup().world.frickFrack.sessions[0]!;
    expect(majorPublicBlocker(0, s)).not.toBeNull();
    s.phase = 'playing'; s.dealer = [{id: 1,rank: 3,suit: 0},null];
    expect(majorPublicBlocker(19, s)).toBeNull();
    s.dealer.pop(); expect(majorPublicBlocker(19, s)).not.toBeNull();
    s.arcana = {justice: true}; expect(majorPublicBlocker(11, s)).not.toBeNull();
    s.arcana = {choices: [{id: 2,rank: 5,suit: 0}]}; expect(majorPublicBlocker(1, s)).not.toBeNull();
  });
  it('labels Major Arcana as effects and displays overridden numeric card values', () => {
    expect(cardLabel({id: 1, rank: 0, suit: 0, arcana: 15})).toContain('The Devil');
    expect(cardLabel({id: 2, rank: 13, suit: 0, value: 4})).toContain('→ 4');
    expect(cardLabel({id: 3, rank: 3, suit: 0, temporary: true})).toContain('temporary');
  });
  it('reveals rank and suit but never invents the dealer hole card', () => {
    expect(cardLabel({id: 1, rank: 1, suit: 0})).toBe('A♠');
    expect(cardLabel({id: 2, rank: 13, suit: 1})).toBe('K♥');
    expect(cardLabel(null)).toBe('Hidden card');
  });
  it('only a live Regular player session owns input and shows the table', () => {
    const app = setup(); expect(frickFrackInputLocked(app.world, app.session)).toBe(true);
    expect(activeFrickFrack(app)?.id).toBe(1);
    app.session.spectator = true; expect(activeFrickFrack(app)).toBeNull();
    app.session.spectator = false; app.world.factions[0].controlMode = 'rts'; expect(activeFrickFrack(app)).toBeNull();
  });
  it('removes the overlay/input lock after KO, defeat, exit, world change or match end', () => {
    const app = setup(), avatar = app.world.avatarOf(0);
    avatar.koUntil = app.world.time + 10; expect(frickFrackInputLocked(app.world, app.session)).toBe(false);
    avatar.koUntil = 0; app.world.factions[0].alive = false; expect(activeFrickFrack(app)).toBeNull();
    app.world.factions[0].alive = true; app.world.frickFrack.sessions = {}; expect(activeFrickFrack(app)).toBeNull();
    expect(activeFrickFrack({world: null, session: app.session})).toBeNull();
    const fresh = setup(); fresh.session.screen = 'ended'; expect(activeFrickFrack(fresh)).toBeNull();
  });
});
