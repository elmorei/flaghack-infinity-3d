import { describe, expect, it } from 'vitest';
import { newMatch } from './econ/testkit';
import { AVATAR } from '../constants';
import { spawnFlag } from '../factory';
import { frickFrackTotal } from '../frickFrack';
import type { World } from '../world';
import type { CommandOf } from '../commands';
import { cmdFrickFrack, closeFrickFrackSession, initializeFrickFrack, offerFrickFrackFlag, resetFrickFrackEntropy, updateFrickFrack } from './frickFrack';
import { canRecruit, cmdHandFlag, enlist } from './recruitment';
import { applyCommands } from './commands';
import { damageEntity } from './combat';
import { giveFlag } from './flags';
import { cmdThrow, updateAvatars } from './avatars';
function arena() {
  const { world: w } = newMatch('frick-frack-suite'); w.factions[0].isPlayer = true; initializeFrickFrack(w);
  const av = w.avatarOf(0), wizard = w.hippies.get(w.frickFrack.wizardId)!;
  const spot = w.nav.nearestWalkable(50, 50);
  Object.assign(av.pos, { ...spot, y: w.collision.groundHeight(spot.x, spot.z) });
  wizard.pos = { x: spot.x, z: spot.z + 1 }; return { w, av, wizard };
}
function command(w: World, action: CommandOf<'frickFrack'>['action'], rest: Partial<CommandOf<'frickFrack'>> = {}) {
  const s = w.frickFrack.sessions[0]!;
  cmdFrickFrack(w, { t: 'frickFrack', faction: 0, sessionId: s.id, revision: s.revision, action, ...rest });
}
function start(w: World) {
  expect(offerFrickFrackFlag(w, w.hippies.get(w.frickFrack.wizardId)!, 0, w.avatarOf(0).carried[0])).toBe(true);
  for (let i = 0; i < 3; i++) { w.time = w.frickFrack.sessions[0]!.readyAt; command(w, i < 2 ? 'next' : 'play'); }
}
function fill(w: World) { const av = w.avatarOf(0); while (av.carried.length < AVATAR.quiver) { const f = spawnFlag(w, { state: 'loose', owner: 0, pos: { ...av.pos } }); giveFlag(w, f.id, av.id); } }
describe('Frick-frack authoritative minigame', () => {
  it('keeps one wizard within existing population, not normally recruitable', () => {
    const { w, wizard } = arena(), count = w.hippies.size; initializeFrickFrack(w);
    expect(w.hippies.size).toBe(count); expect([...w.hippies.values()].filter(h => h.wizard)).toHaveLength(1);
    expect(canRecruit(wizard)).toBe(false); enlist(w, wizard, 0, 'hand'); expect(wizard.faction).toBe(-1);
  });
  it('gift locks three dialogue screens without fee or recruitment', () => {
    const { w, av, wizard } = arena(), before = [...av.carried]; cmdHandFlag(w, { t: 'handFlag', faction: 0, hippieId: wizard.id });
    expect(w.frickFrack.sessions[0]?.phase).toBe('dialogue'); expect(av.carried).toEqual(before); expect(wizard.faction).toBe(-1);
    command(w, 'play'); command(w, 'next'); command(w, 'exit'); expect(w.frickFrack.sessions[0]?.dialogueIndex).toBe(0);
    for (let i = 0; i < 2; i++) { w.time = w.frickFrack.sessions[0]!.readyAt; command(w, 'play'); expect(w.frickFrack.sessions[0]!.phase).toBe('dialogue'); command(w, 'next'); }
    expect(w.frickFrack.sessions[0]?.dialogueIndex).toBe(2); w.time = w.frickFrack.sessions[0]!.readyAt; command(w, 'decline'); expect(w.frickFrack.sessions[0]).toBeUndefined(); expect(av.carried).toEqual(before);
  });
  it('locks actual motion and rejects other commands', () => {
    const { w, av, wizard } = arena(); offerFrickFrackFlag(w, wizard, 0, av.carried[0]); const before = { ...av.pos }, flags = av.carried.length;
    w.submit({ t: 'avatarInput', faction: 0, input: { moveX: 1, moveZ: 1, jump: true, sprint: true, yaw: 0, pitch: 0 } }); w.submit({ t: 'throw', faction: 0 }); applyCommands(w); updateAvatars(w, .1);
    expect(av.carried).toHaveLength(flags); expect(av.pos.x).toBe(before.x); expect(av.pos.z).toBe(before.z);
  });
  it('accepts a real thrown gift, returns exactly its Flag and removes its projectile', () => {
    const { w, av, wizard } = arena(), before = [...av.carried];
    cmdThrow(w, { t: 'throw', faction: 0 }); const projectile = [...w.projectiles.values()].find(p => p.thrower === av.id)!;
    expect(projectile).toBeDefined(); const id = projectile.flagId;
    expect(w.flags.get(id)!.holder).toBe(projectile.id);
    expect(offerFrickFrackFlag(w, wizard, 0, id)).toBe(true);
    expect(av.carried.slice().sort()).toEqual(before.slice().sort());
    expect(w.flags.get(id)).toMatchObject({ state: 'carried', holder: av.id });
    expect(w.projectiles.has(projectile.id)).toBe(false);
    expect(offerFrickFrackFlag(w, wizard, 0, id)).toBe(false);
  });
  it.each([true, false])('keeps a thrown gift wagerable after the quiver refills (altar=%s)', hasAltar => {
    const { w, av, wizard } = arena(); fill(w); cmdThrow(w, { t: 'throw', faction: 0 });
    const projectile = [...w.projectiles.values()].find(p => p.thrower === av.id)!, gift = projectile.flagId;
    fill(w); const displaced = av.carried.at(-1)!, altar = w.hearthOf(0)!;
    if (!hasAltar) w.factions[0].hearthIds = [];
    const allFlags = new Set(w.flags.keys());
    expect(offerFrickFrackFlag(w, wizard, 0, gift)).toBe(true);
    expect(av.carried).toHaveLength(AVATAR.quiver); expect(av.carried).toContain(gift); expect(av.carried).not.toContain(displaced);
    expect(w.flags.get(displaced)).toMatchObject(hasAltar ? { state: 'stock', holder: altar.id, owner: 0 } : { state: 'loose', owner: 0 });
    expect(w.flags.get(gift)).toMatchObject({ state: 'carried', holder: av.id, owner: 0 });
    expect(new Set(w.flags.keys())).toEqual(allFlags); expect(new Set(av.carried).size).toBe(AVATAR.quiver);
    expect(w.projectiles.has(projectile.id)).toBe(false);
  });
  it('rejects Degen and invalid wagers', () => {
    const { w, av, wizard } = arena(); w.factions[0].controlMode = 'rts'; expect(offerFrickFrackFlag(w, wizard, 0, av.carried[0])).toBe(false); w.factions[0].controlMode = 'avatar'; start(w); const flags = av.carried.length;
    for (const wager of [0, -1, .5, Infinity, flags + 1]) command(w, 'bet', { wager }); expect(av.carried).toHaveLength(flags); expect(w.frickFrack.sessions[0]!.phase).toBe('betting');
  });
  it('masks hole card and prevents replayed bets/hits', () => {
    const { w, av } = arena(); start(w); resetFrickFrackEntropy(w, 'normal'); const s = w.frickFrack.sessions[0]!;
    const bet: CommandOf<'frickFrack'> = { t: 'frickFrack', faction: 0, sessionId: s.id, revision: s.revision, action: 'bet', wager: 1 };
    const initial = av.carried.length; cmdFrickFrack(w, bet); cmdFrickFrack(w, bet); expect(av.carried.length).toBe(initial - 1); expect(s.phase).toBe('playing'); expect(s.dealer[1]).toBeNull();
    const hit: CommandOf<'frickFrack'> = { ...bet, revision: s.revision, action: 'hit' }; cmdFrickFrack(w, hit); const len = s.player.length; cmdFrickFrack(w, hit); expect(s.player.length).toBe(len);
  });
  it('allows exit and forfeits only active wager', () => {
    const { w, av } = arena(); start(w); const initial = av.carried.length; command(w, 'exit'); expect(av.carried).toHaveLength(initial);
    w.time += 2; start(w); resetFrickFrackEntropy(w, 'normal'); command(w, 'bet', { wager: 2 }); command(w, 'exit'); expect(av.carried).toHaveLength(initial - 2); expect(w.frickFrack.sessions[0]).toBeUndefined();
  });
  it('consumes one known sideboard card exactly once', () => {
    const { w } = arena(); start(w); resetFrickFrackEntropy(w, 'normal'); command(w, 'bet', { wager: 1 }); const s = w.frickFrack.sessions[0]!, card = { id: 999999, rank: 1, suit: 2 }; w.frickFrack.sideboards[0].push(card);
    const c: CommandOf<'frickFrack'> = { t: 'frickFrack', faction: 0, sessionId: s.id, revision: s.revision, action: 'cheat', cardId: card.id }; cmdFrickFrack(w, c); cmdFrickFrack(w, c);
    expect(s.player.filter(x => x.id === card.id)).toHaveLength(1); expect(w.frickFrack.sideboards[0]).toHaveLength(0); expect(s.wager).toBe(1);
  });
  it('settles once and sends quiver overflow to own altar', () => {
    const { w, av } = arena(); fill(w); start(w); resetFrickFrackEntropy(w, 'normal'); command(w, 'bet', { wager: 1 }); const s = w.frickFrack.sessions[0]!;
    s.player = [{ id: 99999, rank: 10, suit: 0 }, { id: 99998, rank: 1, suit: 0 }]; fill(w); const altar = w.hearthOf(0)!;
    const before = [...w.flags.values()].filter(f => f.state === 'stock' && f.holder === altar.id).length; command(w, 'stand'); expect(s.result).toBe('win'); expect(av.carried).toHaveLength(AVATAR.quiver);
    expect([...w.flags.values()].filter(f => f.state === 'stock' && f.holder === altar.id)).toHaveLength(before + 2); const count = w.flags.size; command(w, 'stand'); expect(w.flags.size).toBe(count); command(w, 'again'); expect(s.phase).toBe('betting');
  });
  it('shows no-flags dialogue after losing held bankroll, not altar stock', () => {
    const { w, av } = arena(); start(w); resetFrickFrackEntropy(w, 'normal'); command(w, 'bet', { wager: av.carried.length }); const s = w.frickFrack.sessions[0]!;
    s.player = [10, 10, 10].map((rank, id) => ({ id: 99990 + id, rank, suit: 0 })); command(w, 'hit'); expect(s.phase).toBe('empty'); expect(s.message).toContain('no Flags left to bet'); expect(av.carried).toHaveLength(0); command(w, 'exit'); expect(w.frickFrack.sessions[0]).toBeUndefined();
  });
  it('cleans sessions on KO, defeat, wizard removal and end', () => {
    for (const cause of ['ko', 'defeat', 'wizard', 'end']) { const { w, av, wizard } = arena(); start(w);
      if (cause === 'ko') av.koUntil = w.time + 10; else if (cause === 'defeat') w.factions[0].alive = false; else if (cause === 'wizard') w.hippies.delete(wizard.id); else w.phase = 'ended';
      updateFrickFrack(w); expect(w.frickFrack.sessions[0]).toBeUndefined(); }
  });
  it('rejects stale requests after disconnect/reentry', () => {
    const { w } = arena(); start(w); const old = { ...w.frickFrack.sessions[0]! }; closeFrickFrackSession(w, 0); w.time += 2; start(w);
    cmdFrickFrack(w, { t: 'frickFrack', faction: 0, sessionId: old.id, revision: old.revision, action: 'exit' }); expect(w.frickFrack.sessions[0]).toBeDefined();
  });
  it('drops rarely once per KO, pickups unique and Regular-only', () => {
    const { w, av } = arena(); resetFrickFrackEntropy(w, 'drop-test'); for (const h of w.hippies.values()) if (!h.wizard) { damageEntity(w, h.id, 10000, av.id); damageEntity(w, h.id, 10000, av.id); }
    const count = w.frickFrack.drops.length; expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(w.hippies.size * .15); const drop = w.frickFrack.drops[0]; Object.assign(av.pos, { ...drop.pos, y: w.collision.groundHeight(drop.pos.x, drop.pos.z) });
    w.factions[0].controlMode = 'rts'; updateFrickFrack(w); expect(w.frickFrack.sideboards[0]).toHaveLength(0); w.factions[0].controlMode = 'avatar'; updateFrickFrack(w); updateFrickFrack(w);
    expect(w.frickFrack.sideboards[0].filter(c => c.id === drop.id)).toHaveLength(1); expect(w.frickFrack.drops.some(d => d.id === drop.id)).toBe(false);
  });
  it('pays a real natural at even money and overflows the real quiver limit', () => {
    const { w, av } = arena(); fill(w); start(w); resetFrickFrackEntropy(w, 'qa-28');
    const altar = w.hearthOf(0)!, before = [...w.flags.values()].filter(f => f.state === 'stock' && f.holder === altar.id).length;
    command(w, 'bet', { wager: AVATAR.quiver });
    expect(w.frickFrack.sessions[0]!.result).toBe('win'); expect(av.carried).toHaveLength(AVATAR.quiver);
    expect([...w.flags.values()].filter(f => f.state === 'stock' && f.holder === altar.id)).toHaveLength(before + AVATAR.quiver);
    expect(new Set(av.carried).size).toBe(AVATAR.quiver);
  });
  it('leaves overflow as real loose Flags if no owned altar remains', () => {
    const { w, av } = arena(); fill(w); start(w); resetFrickFrackEntropy(w, 'qa-28');
    w.factions[0].hearthIds = []; const before = [...w.flags.values()].filter(f => f.state === 'loose').length;
    command(w, 'bet', { wager: AVATAR.quiver }); expect(av.carried).toHaveLength(AVATAR.quiver);
    expect([...w.flags.values()].filter(f => f.state === 'loose')).toHaveLength(before + AVATAR.quiver);
  });
  it('isolates concurrent wizard sessions, wagers, revisions and cheat sideboards', () => {
    const { w, av, wizard } = arena(); w.factions[1].isPlayer = true;
    const other = w.avatarOf(1), initial0 = av.carried.length, initial1 = other.carried.length;
    start(w);
    expect(offerFrickFrackFlag(w, wizard, 1, other.carried[0])).toBe(true);
    const s0 = w.frickFrack.sessions[0]!, s1 = w.frickFrack.sessions[1]!;
    expect(s0.id).not.toBe(s1.id);
    for (let i = 0; i < 3; i++) {
      w.time = s1.readyAt;
      cmdFrickFrack(w, { t: 'frickFrack', faction: 1, sessionId: s1.id, revision: s1.revision, action: i < 2 ? 'next' : 'play' });
    }
    const untouched = JSON.stringify(s1);
    resetFrickFrackEntropy(w, 'normal'); command(w, 'bet', { wager: 1 });
    expect(JSON.stringify(s1)).toBe(untouched); expect(other.carried).toHaveLength(initial1);
    resetFrickFrackEntropy(w, 'normal');
    cmdFrickFrack(w, { t: 'frickFrack', faction: 1, sessionId: s1.id, revision: s1.revision, action: 'bet', wager: 2 });
    expect(av.carried).toHaveLength(initial0 - 1); expect(other.carried).toHaveLength(initial1 - 2);
    expect(s0.wager).toBe(1); expect(s1.wager).toBe(2);
    const before0 = JSON.stringify(s0), before1 = JSON.stringify(s1);
    cmdFrickFrack(w, { t: 'frickFrack', faction: 0, sessionId: s1.id, revision: s1.revision, action: 'exit' });
    cmdFrickFrack(w, { t: 'frickFrack', faction: 1, sessionId: s0.id, revision: s0.revision, action: 'hit' });
    expect(JSON.stringify(s0)).toBe(before0); expect(JSON.stringify(s1)).toBe(before1);
    const card0 = { id: 900001, rank: 1, suit: 0 }, card1 = { id: 900002, rank: 1, suit: 1 };
    w.frickFrack.sideboards[0].push(card0); w.frickFrack.sideboards[1].push(card1);
    command(w, 'cheat', { cardId: card1.id });
    expect(JSON.stringify(s0)).toBe(before0); expect(w.frickFrack.sideboards[1]).toEqual([card1]);
    command(w, 'cheat', { cardId: card0.id });
    expect(s0.player.some(c => c.id === card0.id)).toBe(true); expect(w.frickFrack.sideboards[0]).toHaveLength(0);
    expect(w.frickFrack.sideboards[1]).toEqual([card1]); expect(JSON.stringify(s1)).toBe(before1);
  });
  it.each(['exit', 'ko'] as const)('one player %s leaves another wizard conversation active', cause => {
    const { w, av, wizard } = arena(); w.factions[1].isPlayer = true; start(w);
    const other = w.avatarOf(1);
    expect(offerFrickFrackFlag(w, wizard, 1, other.carried[0])).toBe(true);
    const before = JSON.stringify(w.frickFrack.sessions[1]), otherFlags = [...other.carried];
    if (cause === 'exit') command(w, 'exit'); else { av.koUntil = w.time + 10; updateFrickFrack(w); }
    expect(w.frickFrack.sessions[0]).toBeUndefined();
    expect(JSON.stringify(w.frickFrack.sessions[1])).toBe(before); expect(other.carried).toEqual(otherFlags);
  });
  it('scores aces and face cards', () => { const c = (rs: number[]) => rs.map((rank, id) => ({ id, rank, suit: 0 })); expect(frickFrackTotal(c([1, 1, 9]))).toBe(21); expect(frickFrackTotal(c([1, 13]))).toBe(21); expect(frickFrackTotal(c([10, 12, 2]))).toBe(22); });
});
