import { expect, it } from 'vitest';
import { newMatch } from './econ/testkit';
import { spawnHippie } from '../factory';
import { cancelHippieTask, changeHippieSwag, completeHippieTask, hippieProgress, resetHippieProgress, serveHippieTask, setHippiePlayer, startHippieTask } from '../hippiePlayer';
import { frickFrackTarget, frickFrackTotal } from '../frickFrack';
import { NEUTRAL } from '../types';
import { cmdTalkWizard, initializeFrickFrack, playSwagTable, resetFrickFrackEntropy, swagTableView, updateFrickFrack } from './frickFrack';
import { act } from './units/act';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';

function scene() {
  const { world: w } = newMatch('swag-table');
  w.factions[0].isPlayer = true;
  initializeFrickFrack(w);
  const wizard = w.hippies.get(w.frickFrack.wizardId)!;
  const at = w.nav.nearestWalkable(50, 50);
  Object.assign(wizard.pos, at);
  const hippie = spawnHippie(w, NEUTRAL, at), other = spawnHippie(w, NEUTRAL, at);
  setHippiePlayer(w, hippie.id, null);
  setHippiePlayer(w, other.id, null);
  return { w, hippie, other, wizard };
}

it('awards one SWAG only after an accepted AI job succeeds, not on assignment, repeats or cancellation', () => {
  const { w, hippie: h } = scene();
  expect(hippieProgress(w, h)).toMatchObject({ swag: 0, active: false, task: 'wander' });
  expect(startHippieTask(w, h)).toBe(true);
  expect(startHippieTask(w, h)).toBe(false);
  completeHippieTask(w, h, 'wander'); // No travel.
  expect(hippieProgress(w, h).swag).toBe(0);
  h.pos.x += 2;
  completeHippieTask(w, h, 'wander');
  completeHippieTask(w, h, 'wander');
  expect(hippieProgress(w, h)).toMatchObject({ swag: 1, completed: 1, active: false });

  h.faction = 0;
  h.job = 'defend';
  expect(startHippieTask(w, h)).toBe(true);
  const brain = brainOf(h);
  brain.task = 'patrol';
  brain.px = h.pos.x; brain.pz = h.pos.z;
  act(w, unitsState(w), h, brain, 0, 1 / 60);
  expect(hippieProgress(w, h)).toMatchObject({ swag: 2, completed: 2, active: false, task: 'defend' });

  h.job = 'raid';
  expect(startHippieTask(w, h)).toBe(true);
  cancelHippieTask(w, h.id);
  completeHippieTask(w, h, 'raid');
  expect(hippieProgress(w, h).swag).toBe(2);

  h.job = 'ritual';
  expect(startHippieTask(w, h)).toBe(true);
  serveHippieTask(w, h, 'ritual', 1, 2);
  expect(hippieProgress(w, h).swag).toBe(2);
  serveHippieTask(w, h, 'ritual', 1, 2);
  expect(hippieProgress(w, h).swag).toBe(3);
  resetHippieProgress(w, h.id);
  expect(hippieProgress(w, h).swag).toBe(0);
});

it('uses the wizard and private card rules without touching faction flags or paying a hand twice', () => {
  const { w, hippie: h, other, wizard } = scene();
  expect(playSwagTable(w, h, 'open', 0, 0, 0)).toMatch(/Earn SWAG/);
  expect(changeHippieSwag(w, h.id, 20)).toBe(true);
  expect(playSwagTable(w, h, 'open', 0, 0, 0)).toBeNull();
  expect(playSwagTable(w, other, 'open', 0, 0, 0)).toMatch(/someone else/);
  expect(swagTableView(w, other.id)).toBeNull();
  cmdTalkWizard(w, { t: 'talkWizard', faction: 0, wizardId: wizard.id });
  expect(Object.values(w.frickFrack.sessions)).toEqual([]);
  const table = swagTableView(w, h.id)!;
  const flags = w.flags.size;
  resetFrickFrackEntropy(w, 'swag-shoe');
  expect(playSwagTable(w, h, 'bet', table.id, table.revision, 21)).toMatch(/available SWAG/);
  const old = table.revision;
  playSwagTable(w, h, 'bet', table.id, old, 4);
  playSwagTable(w, h, 'bet', table.id, old, 4);
  expect(hippieProgress(w, h).swag).toBe(16);
  expect(table.phase).toBe('rolling');
  w.time = table.rollEndsAt!;
  updateFrickFrack(w);
  if (table.phase === 'playing') {
    expect(table.dealer).toContain(null); // hole card not present in the public view
    const rev = table.revision;
    playSwagTable(w, h, 'stand', table.id, rev, 0);
    const paid = hippieProgress(w, h).swag;
    playSwagTable(w, h, 'stand', table.id, rev, 0);
    expect(hippieProgress(w, h).swag).toBe(paid);
  }
  expect(table.phase).toBe('result');
  expect(table.dealer).not.toContain(null);
  const score = hippieProgress(w, h).swag;
  if (table.result === 'win') expect(score).toBeGreaterThan(20);
  else if (table.result === 'push') expect(score).toBe(20);
  else expect(score).toBe(16);
  expect(w.flags.size).toBe(flags);

  playSwagTable(w, h, 'bet', table.id, table.revision, 1);
  playSwagTable(w, h, 'exit', table.id, table.revision, 0);
  expect(swagTableView(w, h.id)).toBeNull();
  expect(hippieProgress(w, h).swag).toBe(score - 1);
  expect(w.flags.size).toBe(flags);
});

it('can earn actual wins and ties in the SWAG game', () => {
  const { w, hippie: h } = scene();
  changeHippieSwag(w, h.id, 300);
  playSwagTable(w, h, 'open', 0, 0, 0);
  const table = swagTableView(w, h.id)!;
  const seen = new Set();
  for (let i = 0; i < 180 && seen.size < 3; i++) {
    const before = hippieProgress(w, h).swag;
    resetFrickFrackEntropy(w, 'swag-outcome-' + i);
    playSwagTable(w, h, 'bet', table.id, table.revision, 1);
    w.time = table.rollEndsAt!;
    updateFrickFrack(w);
    for (let draws = 0; draws < 6 && table.phase === 'playing' && frickFrackTotal(table.player, frickFrackTarget(table)) < frickFrackTarget(table) - 4; draws++)
      playSwagTable(w, h, 'hit', table.id, table.revision, 0);
    if (table.phase === 'playing') playSwagTable(w, h, 'stand', table.id, table.revision, 0);
    seen.add(table.result);
    if (table.result === 'win') expect(hippieProgress(w, h).swag).toBeGreaterThan(before);
    else expect(hippieProgress(w, h).swag).toBe(table.result === 'push' ? before : before - 1);
  }
  expect(seen).toEqual(new Set(['win', 'lose', 'push']));
});
