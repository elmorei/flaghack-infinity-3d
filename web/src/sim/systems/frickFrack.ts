/** Host-owned Frick-frack economy and hand state. Never serialize this module's WeakMap. */
import type { World } from '../world';
import type { FactionId, Hippie } from '../types';
import type { CommandOf } from '../commands';
import { AVATAR } from '../constants';
import { Rng } from '../rng';
import { spawnFlag } from '../factory';
import { depositToStock, destroyFlag, dropLoose, giveFlag } from './flags';
import { breakChannel } from './units/channel';
import { FRICK_FRACK_DIALOGUE, FRICK_FRACK_EMPTY, FRICK_FRACK_DROP_CHANCE, FRICK_FRACK_SIDEBOARD_CAP, frickFrackTextDuration, frickFrackTotal } from '../frickFrack';
import type { FrickFrackCard, FrickFrackSession } from '../frickFrack';

interface PrivateHand { deck: FrickFrackCard[]; dealer: FrickFrackCard[] }
interface PrivateState { rng: Rng; hands: Map<FactionId, PrivateHand>; nextSession: number; cooldown: Map<FactionId, number> }
const secrets = new WeakMap<World, PrivateState>();
function privateState(w: World): PrivateState {
  let s = secrets.get(w);
  if (!s) { s = { rng: new Rng(`frick-frack:${w.seed}`), hands: new Map(), nextSession: 1, cooldown: new Map() }; secrets.set(w, s); }
  return s;
}
/** Host injects private entropy before play; reproducible seeds are available for deterministic tests. */
export function resetFrickFrackEntropy(w: World, seed: string): void { privateState(w).rng = new Rng(seed); }
export function initializeFrickFrack(w: World): void {
  if (w.options.mode === 'tutorial' || w.frickFrack.wizardId >= 0 ||
      !w.factions.some(f => f.alive && f.isPlayer && f.controlMode !== 'rts')) return;
  const neutrals = [...w.hippies.values()].filter(h => h.faction === -1);
  const h = neutrals.length >= 2 ? neutrals.at(-1) : undefined;
  if (!h) return; // Never reserve the last recruit needed by a wiped faction.
  h.wizard = true; h.name = 'Frick-frack the Wizard'; h.order = null; h.job = null;
  w.frickFrack.wizardId = h.id;
}
export function isFrickFrackLocked(w: World, f: FactionId): boolean { return !!w.frickFrack.sessions[f]; }
function canPlay(w: World, f: FactionId): boolean {
  const fac = w.factions[f], av = fac && w.avatars.get(fac.avatarId);
  return w.phase === 'playing' && !!fac?.alive && fac.isPlayer && fac.controlMode !== 'rts' && !!av && av.hp > 0 && av.koUntil === 0;
}
function clearControl(w: World, f: FactionId): void {
  const av = w.avatars.get(w.factions[f]?.avatarId);
  if (!av) return;
  breakChannel(w, av); av.action = { kind: 'idle' };
  av.input = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: av.yaw, pitch: av.pitch };
  av.vel.x = 0; av.vel.z = 0;
  if (av.pushing >= 0) { const g = w.buildings.get(av.pushing); if (g?.gcc?.pushedBy === av.id) g.gcc.pushedBy = -1; av.pushing = -1; }
}
/** Giving starts a conversation, not an entry fee. A thrown Flag returns to its actual thrower. */
export function offerFrickFrackFlag(w: World, h: Hippie, f: FactionId, flagId: number): boolean {
  if (!h.wizard || h.id !== w.frickFrack.wizardId || h.hp <= 0 || h.status === 'ko' || !canPlay(w, f)) return false;
  const av = w.avatarOf(f), flag = w.flags.get(flagId), secret = privateState(w);
  if (w.frickFrack.sessions[f] || (secret.cooldown.get(f) ?? 0) > w.time || !flag || flag.owner !== f ||
      !['carried', 'flying'].includes(flag.state) ||
      (flag.state === 'carried' ? flag.holder !== av.id : w.projectiles.get(flag.holder)?.thrower !== av.id)) return false;
  // Flying flags remain represented in the projectile until canonical detach clears them.
  if (flag.state === 'flying') { const projectileId = flag.holder; dropLoose(w, flag.id, { ...av.pos }); w.projectiles.delete(projectileId); if (!giveFlag(w, flag.id, av.id)) {
    const altar = ownedAltar(w, f); if (altar) depositToStock(w, flag.id, altar.id);
  } }
  const s: FrickFrackSession = { id: secret.nextSession++, revision: 0, faction: f, phase: 'dialogue', dialogueIndex: 0,
    dialogueStartedAt: w.time, readyAt: w.time + frickFrackTextDuration(FRICK_FRACK_DIALOGUE[0]), wager: 0, player: [], dealer: [], result: null, message: '' };
  w.frickFrack.sessions[f] = s; clearControl(w, f); return true;
}
/** Active wagers are forfeited, never refunded by quitting, KO, or reconnect. */
export function closeFrickFrackSession(w: World, f: FactionId): void {
  if (!w.frickFrack.sessions[f]) return;
  delete w.frickFrack.sessions[f]; privateState(w).hands.delete(f); privateState(w).cooldown.set(f, w.time + 1);
  clearControl(w, f);
}
function ownedAltar(w: World, f: FactionId) { return w.factions[f].hearthIds.map(id => w.buildings.get(id)).find(b => b?.kind === 'hearth' && b.faction === f && b.built >= 1); }
function awardFlags(w: World, f: FactionId, count: number): void {
  const av = w.avatarOf(f), altar = ownedAltar(w, f);
  for (let i = 0; i < count; i++) {
    const fl = spawnFlag(w, { state: 'loose', owner: f, pos: { ...av.pos } });
    if (av.hp > 0 && av.koUntil === 0 && av.carried.length < AVATAR.quiver && giveFlag(w, fl.id, av.id)) continue;
    if (altar) depositToStock(w, fl.id, altar.id); // No altar: leave the real flag safely loose rather than delete it.
  }
}
function empty(w: World, s: FrickFrackSession): void {
  s.phase = 'empty'; s.message = FRICK_FRACK_EMPTY; s.dialogueStartedAt = w.time; s.readyAt = w.time + frickFrackTextDuration(s.message);
}
function result(w: World, s: FrickFrackSession, outcome: 'win' | 'lose' | 'push'): void {
  const hand = privateState(w).hands.get(s.faction);
  if (hand) s.dealer = hand.dealer.map(c => ({ ...c }));
  const payout = outcome === 'win' ? s.wager * 2 : outcome === 'push' ? s.wager : 0;
  awardFlags(w, s.faction, payout);
  s.phase = 'result'; s.result = outcome;
  s.message = outcome === 'win' ? `You win ${s.wager} Flags. Winnings beyond your quiver go to altar stock.` : outcome === 'push' ? 'A tie. Your wager is returned.' : `The wizard wins ${s.wager} Flags.`;
  privateState(w).hands.delete(s.faction);
  if (w.avatarOf(s.faction).carried.length === 0) empty(w, s);
}
function draw(hand: PrivateHand): FrickFrackCard { return hand.deck.pop()!; }
function stand(w: World, s: FrickFrackSession): void {
  const hand = privateState(w).hands.get(s.faction); if (!hand) return;
  while (frickFrackTotal(hand.dealer) < 17) hand.dealer.push(draw(hand));
  const player = frickFrackTotal(s.player), dealer = frickFrackTotal(hand.dealer);
  result(w, s, dealer > 21 || player > dealer ? 'win' : player === dealer ? 'push' : 'lose');
}
export function cmdFrickFrack(w: World, c: CommandOf<'frickFrack'>): void {
  const s = w.frickFrack.sessions[c.faction];
  if (!s || !canPlay(w, c.faction) || !Number.isInteger(c.sessionId) || !Number.isInteger(c.revision) || s.id !== c.sessionId || s.revision !== c.revision) return;
  const av = w.avatarOf(c.faction);
  // The initial three-screen conversation cannot be skipped through forged commands.
  if (s.phase === 'dialogue') {
    if (w.time < s.readyAt) return;
    if (c.action === 'next' && s.dialogueIndex < FRICK_FRACK_DIALOGUE.length - 1) {
      s.dialogueIndex++; s.dialogueStartedAt = w.time; s.readyAt = w.time + frickFrackTextDuration(FRICK_FRACK_DIALOGUE[s.dialogueIndex]); s.revision++; return;
    }
    if (s.dialogueIndex !== FRICK_FRACK_DIALOGUE.length - 1) return;
    if (c.action === 'decline' || c.action === 'exit') { closeFrickFrackSession(w, c.faction); return; }
    if (c.action === 'play') { s.phase = 'betting'; if (!av.carried.length) empty(w, s); s.revision++; } return;
  }
  if (c.action === 'exit' || c.action === 'decline') { closeFrickFrackSession(w, c.faction); return; }
  if (s.phase === 'empty') return;
  if (s.phase === 'result' && c.action === 'again') {
    s.phase = 'betting'; s.player = []; s.dealer = []; s.wager = 0; s.result = null; s.message = ''; s.revision++;
    if (!av.carried.length) empty(w, s); return;
  }
  if (s.phase === 'betting' && c.action === 'bet') {
    const wager = c.wager;
    if (!Number.isInteger(wager) || wager! < 1 || wager! > av.carried.length) return;
    const deck: FrickFrackCard[] = [];
    for (let suit = 0; suit < 4; suit++) for (let rank = 1; rank <= 13; rank++) deck.push({ id: w.newId(), rank, suit });
    privateState(w).rng.shuffle(deck);
    // Casino settlement is an explicit, bounded resource sink/source. No spendable flag remains in escrow.
    for (const id of av.carried.slice(-wager!)) destroyFlag(w, id);
    const hand: PrivateHand = { deck, dealer: [] }; privateState(w).hands.set(c.faction, hand);
    s.wager = wager!; s.player = [draw(hand)]; hand.dealer.push(draw(hand)); s.player.push(draw(hand)); hand.dealer.push(draw(hand));
    s.dealer = [{ ...hand.dealer[0] }, null]; s.phase = 'playing'; s.revision++;
    const pn = frickFrackTotal(s.player) === 21, dn = frickFrackTotal(hand.dealer) === 21;
    if (pn || dn) result(w, s, pn && dn ? 'push' : pn ? 'win' : 'lose'); return;
  }
  if (s.phase !== 'playing') return;
  if (c.action === 'stand') { s.revision++; stand(w, s); return; }
  if (c.action === 'hit' || c.action === 'cheat') {
    const hand = privateState(w).hands.get(c.faction); if (!hand) return;
    if (c.action === 'cheat') {
      const sideboard = w.frickFrack.sideboards[c.faction], i = sideboard.findIndex(card => card.id === c.cardId);
      if (i < 0) return;
      s.player.push(sideboard.splice(i, 1)[0]);
    } else s.player.push(draw(hand));
    s.revision++;
    if (frickFrackTotal(s.player) > 21) result(w, s, 'lose'); else if (frickFrackTotal(s.player) === 21) stand(w, s);
  }
}
/** Called once from the KO transition, never from each frame of the KO animation. */
export function dropFrickFrackCard(w: World, h: Hippie): void {
  if (h.wizard || !privateState(w).rng.chance(FRICK_FRACK_DROP_CHANCE)) return;
  const rng = privateState(w).rng, id = w.newId();
  w.frickFrack.drops.push({ id, card: { id, rank: rng.int(1, 13), suit: rng.int(0, 3) }, pos: { ...h.pos }, createdAt: w.time });
  // Physical cards persist for ten minutes, with a hard bound for unlimited matches.
  if (w.frickFrack.drops.length > 128) w.frickFrack.drops.shift();
}
export function updateFrickFrack(w: World): void {
  const wizard = w.hippies.get(w.frickFrack.wizardId);
  for (const f of [0, 1, 2, 3] as const) {
    if (w.frickFrack.sessions[f] && (!canPlay(w, f) || !wizard || wizard.hp <= 0 || wizard.status === 'ko')) closeFrickFrackSession(w, f);
    if (!canPlay(w, f) || isFrickFrackLocked(w, f)) continue;
    const av = w.avatarOf(f), cards = w.frickFrack.sideboards[f];
    for (let i = w.frickFrack.drops.length - 1; i >= 0 && cards.length < FRICK_FRACK_SIDEBOARD_CAP; i--) {
      const drop = w.frickFrack.drops[i], ground = w.collision.groundHeight(drop.pos.x, drop.pos.z);
      if (Math.hypot(av.pos.x - drop.pos.x, av.pos.y - ground, av.pos.z - drop.pos.z) > 1.8) continue;
      cards.push(drop.card); w.frickFrack.drops.splice(i, 1);
    }
  }
  w.frickFrack.drops = w.frickFrack.drops.filter(d => w.time - d.createdAt < 600);
}
