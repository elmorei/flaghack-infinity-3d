import { describe, expect, it } from 'vitest';
import { cardLabel, clampWager, revealedDialogue, activeFrickFrack } from './frickFrack';
import { FRICK_FRACK_DIALOGUE, FRICK_FRACK_LETTER_SECONDS, createFrickFrackState } from '../sim/frickFrack';
import { newMatch } from '../sim/systems/econ/testkit';
import { Session } from '../game/session';
import { frickFrackInputLocked } from '../game/frickFrackControls';

function setup() {
  const { world } = newMatch('frick-ui'); const session = new Session(); session.screen = 'playing';
  world.frickFrack = createFrickFrackState();
  world.frickFrack.sessions[0] = { id: 1, revision: 0, faction: 0, phase: 'dialogue', dialogueIndex: 0, dialogueStartedAt: 0, readyAt: 5, wager: 0, player: [], dealer: [], result: null, message: '' };
  return { world, session };
}

describe('Frick-frack presentation model', () => {
  it('has at least three real typewriter windows, with no immediate full-text reveal', () => {
    expect(FRICK_FRACK_DIALOGUE.length).toBeGreaterThanOrEqual(3);
    const text = FRICK_FRACK_DIALOGUE[0];
    expect(revealedDialogue(text, 0)).toBe('');
    expect(revealedDialogue(text, -5)).toBe('');
    expect(revealedDialogue(text, FRICK_FRACK_LETTER_SECONDS * 3.1)).toBe(text.slice(0, 3));
    expect(revealedDialogue(text, 1000)).toBe(text);
  });
  it('wagers are whole held Flags and cannot use an invalid input as a larger bet', () => {
    expect(clampWager(3.9, 8)).toBe(3); expect(clampWager(99, 8)).toBe(8);
    expect(clampWager(-5, 8)).toBe(1); expect(clampWager(NaN, 8)).toBe(1);
    expect(clampWager(Infinity, 8)).toBe(1); expect(clampWager(1, 0)).toBe(0);
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
