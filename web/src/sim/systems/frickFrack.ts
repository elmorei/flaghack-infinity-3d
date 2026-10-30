/** Host-owned Frick-frack economy and hand state. Never serialize this module's WeakMap. */
import type { World } from '../world';
import type { FactionId, Hippie } from '../types';
import type { CommandOf } from '../commands';
import { AVATAR } from '../constants';
import { Rng } from '../rng';
import { spawnFlag } from '../factory';
import { depositToStock, destroyFlag, dropLoose, giveFlag } from './flags';
import { breakChannel } from './units/channel';
import { beginTask, setStatusAt } from './units/brain';
import type { Brain } from './units/brain';
import { locomote, moveTo } from './units/move';
import type { UnitsState } from './units/state';
import { frickFrackDialogue, frickFrackDialogueVariant, FRICK_FRACK_DIALOGUE, FRICK_FRACK_EMPTY, FRICK_FRACK_DROP_CHANCE, FRICK_FRACK_SIDEBOARD_CAP, frickFrackTextDuration, frickFrackTotal, createFrickFrackDeck, createFrickFrackCheatCard, frickFrackParodyRemark } from '../frickFrack';
import type { FrickFrackCard, FrickFrackSession } from '../frickFrack';
import { applyFrickFrackArcana } from '../frickFrackArcana';
import type { FrickFrackHand } from '../frickFrackArcana';
import { resolveFrickFrackBattle } from '../frickFrackBattle';
import { setFrickFrackPrivateView } from '../frickFrackPrivate';
import { evaluateFrickFrackPoker } from '../frickFrackPoker';
import { resetWizardCircuit, wanderFrickFrackWizard } from './frickFrackWander';

type PrivateHand = FrickFrackHand;
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
export function isFrickFrackLocked(w: World, f: FactionId): boolean {
  const s = w.frickFrack.sessions[f]; return !!s && s.phase !== 'chasing';
}
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
/** Close enough to converse, with no wall or elevated platform between the two actors. */
function withinConversationReach(w: World, h: Hippie, f: FactionId, reach = 2.3): boolean {
  const av = w.avatarOf(f), ground = w.collision.groundHeight(h.pos.x, h.pos.z) + (h.airborne?.y ?? 0);
  const dx = av.pos.x - h.pos.x, dz = av.pos.z - h.pos.z, dy = av.pos.y - ground;
  const distance = Math.hypot(dx, dy, dz);
  return distance <= reach && Math.abs(dy) <= 1.2 && w.nav.lineOfSight(h.pos.x, h.pos.z, av.pos.x, av.pos.z) &&
    (distance < .01 || !w.collision.raycast(h.pos.x, ground + 1, h.pos.z, dx, dy, dz, distance));
}
function startConversation(w: World, h: Hippie, s: FrickFrackSession): void {
  if (s.dialogueVariant === undefined) {
    const visits = w.frickFrack.visits ??= {};
    const count = visits[s.faction] ?? 0;
    s.dialogueVariant = frickFrackDialogueVariant(count);
    visits[s.faction] = count + 1;
  }
  s.phase = 'dialogue'; s.dialogueStartedAt = w.time;
  s.readyAt = w.time + frickFrackTextDuration(frickFrackDialogue(s.dialogueVariant)[0]);
  s.revision++;
  h.vel.x = 0; h.vel.z = 0;
  h.facing = Math.atan2(w.avatarOf(s.faction).pos.x - h.pos.x, w.avatarOf(s.faction).pos.z - h.pos.z);
  const av = w.avatarOf(s.faction); av.yaw = Math.atan2(h.pos.x - av.pos.x, h.pos.z - av.pos.z);
  clearControl(w, s.faction);
}
/** Giving is not an entry fee. Thrown gifts reserve a pursuit without locking the giver. */
export function offerFrickFrackFlag(w: World, h: Hippie, f: FactionId, flagId: number): boolean {
  if (!h.wizard || h.id !== w.frickFrack.wizardId || h.hp <= 0 || h.status === 'ko' || !canPlay(w, f)) return false;
  const av = w.avatarOf(f), flag = w.flags.get(flagId), secret = privateState(w);
  const existing = w.frickFrack.sessions[f];
  if ((secret.cooldown.get(f) ?? 0) > w.time || !flag || flag.owner !== f ||
      !['carried', 'flying'].includes(flag.state) ||
      (flag.state === 'carried' ? flag.holder !== av.id : w.projectiles.get(flag.holder)?.thrower !== av.id)) return false;
  const thrown = flag.state === 'flying';
  if ((!thrown && existing) || (!thrown && !withinConversationReach(w, h, f, AVATAR.pullReach))) return false;
  // A quiver may refill between throw and impact. Keep the gifted Flag in the wagerable
  // quiver and relocate an existing carried Flag, preserving both identities and capacity.
  if (flag.state === 'flying') {
    const projectileId = flag.holder;
    if (av.carried.length >= AVATAR.quiver) {
      const displaced = av.carried.at(-1)!, altar = ownedAltar(w, f);
      if (!altar || !depositToStock(w, displaced, altar.id)) dropLoose(w, displaced, { ...av.pos });
    }
    dropLoose(w, flag.id, { ...av.pos }); w.projectiles.delete(projectileId);
    giveFlag(w, flag.id, av.id);
  }
  // Additional real throws are caught safely, but cannot restart the pursuit or duplicate a session.
  if (existing) return true;
  const queued = thrown || Object.values(w.frickFrack.sessions).some(Boolean);
  const s: FrickFrackSession = { id: secret.nextSession++, revision: 0, faction: f, phase: queued ? 'chasing' : 'dialogue', dialogueIndex: 0,
    dialogueStartedAt: w.time, readyAt: w.time + frickFrackTextDuration(FRICK_FRACK_DIALOGUE[0]), wager: 0, player: [], dealer: [], result: null, message: '' };
  w.frickFrack.sessions[f] = s;
  if (!queued) startConversation(w, h, s);
  return true;
}
/** Active wagers are forfeited, never refunded by quitting, KO, or reconnect. */
export function closeFrickFrackSession(w: World, f: FactionId): void {
  const s = w.frickFrack.sessions[f]; if (!s) return;
  cleanupTemporary(w, f); setFrickFrackPrivateView(w, f, null);
  delete w.frickFrack.sessions[f]; privateState(w).hands.delete(f); privateState(w).cooldown.set(f, w.time + 1);
  if (s.phase !== 'chasing') clearControl(w, f);
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
function cleanupTemporary(w: World, f: FactionId): void {
  w.frickFrack.sideboards[f] = w.frickFrack.sideboards[f].filter(c => !c.temporary);
}
function syncDealer(s: FrickFrackSession, hand: PrivateHand): void {
  if (!hand.dealer.some(c => c.id === hand.holeId)) hand.holeId = null;
  s.dealer = hand.dealer.map(c => !hand.revealDealer && c.id === hand.holeId ? null : { ...c });
}
/** Reveal order, not array position, controls CCG battles. Private peeks never call this. */
function revealCard(s: FrickFrackSession, hand: PrivateHand, id: number): void {
  if (hand.revealedIds.includes(id)) return;
  const allowed = new Set([...hand.revealedIds,id]);
  const player = s.player.filter(c => allowed.has(c.id));
  const dealer = hand.dealer.filter(c => allowed.has(c.id) && (hand.revealDealer || c.id !== hand.holeId));
  const battle = resolveFrickFrackBattle(player, dealer, id, hand.revealedIds);
  hand.revealedIds.push(id);
  s.revealedCardOrder = [...hand.revealedIds];
  if (battle.removedIds.length) {
    const removed = new Set(battle.removedIds);
    const defeated = s.defeated ?? (s.defeated = []);
    for (const side of ['player', 'dealer'] as const) {
      for (const card of side === 'player' ? s.player : hand.dealer) {
        if (removed.has(card.id) && !defeated.some(d => d.card.id === card.id)) defeated.push({ side, card: { ...card } });
      }
    }
    if (hand.dealer.some(c=>removed.has(c.id)) && s.arcana) delete s.arcana.softDealer;
    s.player = s.player.filter(c => !removed.has(c.id)); hand.dealer = hand.dealer.filter(c => !removed.has(c.id));
    s.remark = battle.remark;
  }
  syncDealer(s, hand);
}
function revealPlayerCard(s: FrickFrackSession, hand: PrivateHand, card: FrickFrackCard): void {
  const remark = frickFrackParodyRemark(card); if (remark) s.remark = remark;
  revealCard(s, hand, card.id);
  // Strength protects a draw that is still present after its CCG battle, not a transformed old card.
  if (s.arcana?.strength && s.player.some(c=>c.id===card.id) && frickFrackTotal(s.player.filter(c=>hand.revealedIds.includes(c.id))) > 21) {
    s.player = s.player.filter(c=>c.id!==card.id); s.arcana.strength=false;
    s.remark = 'Strength discards that draw before it can make you bust.';
  }
}
function revealDealer(s: FrickFrackSession, hand: PrivateHand): void {
  hand.revealDealer = true;
  for (const c of [...hand.dealer]) revealCard(s,hand,c.id);
  syncDealer(s,hand);
}
function dealFresh(w: World, s: FrickFrackSession, hand: PrivateHand): void {
  const deck=createFrickFrackDeck(()=>w.newId()); privateState(w).rng.shuffle(deck);
  hand.deck=deck;hand.dealer=[];hand.revealedIds=[];hand.revealDealer=false;
  delete s.defeated; delete s.revealedCardOrder;
  if (s.arcana) { delete s.arcana.sun; delete s.arcana.choices; delete s.arcana.softDealer; }
  const p1=draw(hand),d1=draw(hand),p2=draw(hand),d2=draw(hand);
  s.player=[p1];hand.dealer=[d1,d2];hand.holeId=d2.id;
  revealPlayerCard(s,hand,p1);revealCard(s,hand,d1.id);s.player.push(p2);revealPlayerCard(s,hand,p2);syncDealer(s,hand);
}
function result(w: World, s: FrickFrackSession, outcome: 'win' | 'lose' | 'push'): void {
  const hand = privateState(w).hands.get(s.faction);
  if (outcome === 'lose' && hand && s.arcana?.judgement && !s.arcana.judgementUsed) {
    s.arcana.judgement=false;s.arcana.judgementUsed=true;s.result=null;s.message='Judgement grants one replay at your already committed wager.';
    setFrickFrackPrivateView(w,s.faction,null);dealFresh(w,s,hand);s.phase='playing';
    if (frickFrackTotal(s.player) === 21 || frickFrackTotal(hand.dealer) === 21) stand(w,s);
    return;
  }
  if (hand) s.dealer = hand.dealer.map(c => ({ ...c }));
  const poker = frickFrackTotal(s.player) <= 21 ? evaluateFrickFrackPoker(s.player) : null;
  const multiplier = poker?.profitMultiplier ?? 1;
  const extra = outcome === 'win' && s.arcana?.world && frickFrackTotal(s.player) === 21 ? s.wager : 0;
  const profit = outcome === 'win' ? s.wager * multiplier + extra : 0;
  const payout = outcome === 'win' ? s.wager + profit : outcome === 'push' ? s.wager : 0;
  awardFlags(w, s.faction, payout);
  s.phase = 'result'; s.result = outcome;
  s.message = outcome === 'win' ? `You win ${profit} Flags.${multiplier > 1 ? ` ${poker!.label} multiplies your profit by ${multiplier}.` : ''} Winnings beyond your quiver go to altar stock.` : outcome === 'push' ? 'A tie. Your wager is returned.' : `The wizard wins ${s.wager} Flags.`;
  if (poker?.straightHigh) {
    const source=poker.straightHigh;
    const bonus:FrickFrackCard={id:w.newId(),rank:source.rank,suit:source.suit,...(source.tarot?{tarot:true}:{}),...(source.parody!==undefined?{parody:source.parody}:{})};
    // Clear hand-only effects first; a freshly earned real card is not temporary.
    cleanupTemporary(w,s.faction);
    if(w.frickFrack.sideboards[s.faction].length < FRICK_FRACK_SIDEBOARD_CAP) {
      w.frickFrack.sideboards[s.faction].push(bonus);s.message+=' Straight bonus: its highest card goes into your sleeve.';
    } else {
      const av=w.avatarOf(s.faction);w.frickFrack.drops.push({id:bonus.id,card:bonus,pos:{x:av.pos.x,z:av.pos.z},createdAt:w.time});
      if(w.frickFrack.drops.length>128)w.frickFrack.drops.shift();
      s.message+=' Straight bonus: your sleeve is full, so its highest card waits on the ground.';
    }
  }
  cleanupTemporary(w,s.faction);setFrickFrackPrivateView(w,s.faction,null);privateState(w).hands.delete(s.faction);
  if (w.avatarOf(s.faction).carried.length === 0) empty(w, s);
}
function draw(hand: PrivateHand): FrickFrackCard { return hand.deck.pop()!; }
function stand(w: World, s: FrickFrackSession): void {
  const hand = privateState(w).hands.get(s.faction); if (!hand) return;
  revealDealer(s,hand);
  // A revealed CCG can remove cards from either hand; recompute after every draw/battle.
  while (frickFrackTotal(hand.dealer) < 17 && hand.deck.length) { const c=draw(hand);hand.dealer.push(c);if(s.arcana)delete s.arcana.softDealer;revealCard(s,hand,c.id); }
  const player = frickFrackTotal(s.player), dealer = frickFrackTotal(hand.dealer);
  result(w, s, player > 21 ? 'lose' : dealer > 21 || player > dealer || (player === dealer && s.arcana?.justice) ? 'win' : player === dealer ? 'push' : 'lose');
}
function finishPlayerChange(w: World, s: FrickFrackSession, hand: PrivateHand): void {
  if (s.arcana?.choices?.length) return;
  if (frickFrackTotal(s.player) > 21) { revealDealer(s,hand);if(frickFrackTotal(s.player)>21)result(w,s,'lose');else stand(w,s); }
  else if (frickFrackTotal(s.player) === 21) stand(w,s);
}
export function cmdFrickFrack(w: World, c: CommandOf<'frickFrack'>): void {
  const s = w.frickFrack.sessions[c.faction];
  if (!s || !canPlay(w, c.faction) || !Number.isInteger(c.sessionId) || !Number.isInteger(c.revision) || s.id !== c.sessionId || s.revision !== c.revision) return;
  if (s.phase === 'chasing') return;
  const av = w.avatarOf(c.faction);
  if (s.phase === 'dialogue') {
    const dialogue = frickFrackDialogue(s.dialogueVariant);
    if (w.time < s.readyAt) return;
    if (c.action === 'next' && s.dialogueIndex < dialogue.length - 1) {
      s.dialogueIndex++; s.dialogueStartedAt = w.time; s.readyAt = w.time + frickFrackTextDuration(dialogue[s.dialogueIndex]); s.revision++; return;
    }
    if (s.dialogueIndex !== dialogue.length - 1) return;
    if (c.action === 'decline' || c.action === 'exit') { closeFrickFrackSession(w, c.faction); return; }
    if (c.action === 'play') { s.phase = 'betting'; if (!av.carried.length) empty(w, s); s.revision++; } return;
  }
  if (c.action === 'exit' || c.action === 'decline') { closeFrickFrackSession(w, c.faction); return; }
  if (s.phase === 'empty') return;
  if (s.phase === 'result' && c.action === 'again') {
    s.phase='betting';s.player=[];s.dealer=[];delete s.defeated;delete s.revealedCardOrder;s.wager=0;s.result=null;s.message='';delete s.remark;delete s.arcana;s.revision++;
    if (!av.carried.length) empty(w,s);return;
  }
  if (s.phase === 'betting' && c.action === 'bet') {
    const wager=c.wager;if (!Number.isInteger(wager)||wager!<1||wager!>av.carried.length) return;
    for (const id of av.carried.slice(-wager!)) destroyFlag(w,id);
    const hand:PrivateHand={deck:[],dealer:[],usedNumeric:[],temporaryIds:[],revealDealer:false,revealedIds:[],holeId:null};
    privateState(w).hands.set(c.faction,hand);s.wager=wager!;s.phase='playing';delete s.arcana;delete s.remark;s.revision++;
    dealFresh(w,s,hand);
    if (frickFrackTotal(s.player)===21||frickFrackTotal(hand.dealer)===21) stand(w,s);
    return;
  }
  if (s.phase !== 'playing') return;
  const hand=privateState(w).hands.get(c.faction);if(!hand)return;
  if(s.arcana?.choices?.length) {
    if(c.action!=='choose'||!Number.isInteger(c.choiceIndex)||c.choiceIndex!<0||c.choiceIndex!>=s.arcana.choices.length)return;
    const chosen=s.arcana.choices[c.choiceIndex!];delete s.arcana.choices;s.player.push(chosen);s.revision++;
    revealPlayerCard(s,hand,chosen);finishPlayerChange(w,s,hand);return;
  }
  if(c.action==='stand'){s.revision++;stand(w,s);return;}
  if(c.action==='hit') {
    if(!hand.deck.length)return;const card=draw(hand);s.player.push(card);s.revision++;
    revealPlayerCard(s,hand,card);finishPlayerChange(w,s,hand);return;
  }
  if(c.action!=='cheat')return;
  const sideboard=w.frickFrack.sideboards[c.faction],index=sideboard.findIndex(card=>card.id===c.cardId);if(index<0)return;
  const card=sideboard[index];
  if(card.arcana===undefined) {
    if(c.targetCardIds!==undefined||c.value!==undefined||c.confirmCost!==undefined)return;
    sideboard.splice(index,1);hand.usedNumeric.push({...card});s.player.push(card);s.revision++;
    revealPlayerCard(s,hand,card);finishPlayerChange(w,s,hand);return;
  }
  const before=new Set(s.player.map(c=>c.id)), wasRevealed=hand.revealDealer;
  const effect=applyFrickFrackArcana({session:s,hand,sideboard,availableFlags:av.carried.length,now:w.time,nextId:()=>w.newId(),
    randomInt:(min,max)=>privateState(w).rng.int(min,max),spendFlags:count=>{for(const id of av.carried.slice(-count))destroyFlag(w,id);},
    privateView:view=>setFrickFrackPrivateView(w,c.faction,view)},card.arcana,c);
  if(!effect.valid){s.remark='That card cannot be used with those choices right now. It stays in your sideboard.';s.revision++;return;}
  // A successful effect consumes only its own physical sideboard card, exactly once.
  const consumed=sideboard.findIndex(c=>c.id===card.id);if(consumed>=0)sideboard.splice(consumed,1);s.revision++;
  for(const added of [...s.player])if(!before.has(added.id))revealPlayerCard(s,hand,added);
  if(!wasRevealed&&hand.revealDealer)revealDealer(s,hand);else syncDealer(s,hand);
  if(effect.stand)stand(w,s);else finishPlayerChange(w,s,hand);
}
/** Called once from the KO transition, never from each frame of the KO animation. */
export function dropFrickFrackCard(w: World, h: Hippie): void {
  if (h.wizard || !privateState(w).rng.chance(FRICK_FRACK_DROP_CHANCE)) return;
  const rng = privateState(w).rng, id = w.newId();
  w.frickFrack.drops.push({ id, card: createFrickFrackCheatCard(id, rng.int(0, 101)), pos: { ...h.pos }, createdAt: w.time });
  // Physical cards persist for ten minutes, with a hard bound for unlimited matches.
  if (w.frickFrack.drops.length > 128) w.frickFrack.drops.shift();
}
/** A physical interruption ends the encounter instead of keeping a distant avatar locked.
 * Small pushes remain harmless; boss launches and large knockbacks release both actors.
 */
function conversationSeparated(w: World, h: Hippie, f: FactionId): boolean {
  const av = w.avatarOf(f);
  return Math.hypot(av.pos.x - h.pos.x, av.pos.z - h.pos.z) > 6 ||
    Math.abs(av.pos.y - w.collision.groundHeight(h.pos.x, h.pos.z) - (h.airborne?.y ?? 0)) > 2.5;
}
export function updateFrickFrack(w: World): void {
  const wizard = w.hippies.get(w.frickFrack.wizardId);
  for (const f of [0, 1, 2, 3] as const) {
    const s = w.frickFrack.sessions[f];
    if (s && (!canPlay(w, f) || !wizard || wizard.hp <= 0 || wizard.status === 'ko' ||
        (s.phase !== 'chasing' && conversationSeparated(w, wizard, f)) ||
        (s.phase === 'chasing' && w.time - s.dialogueStartedAt > 120))) closeFrickFrackSession(w, f);
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

/** Runs in the ordinary Hippie movement pass, after KO, stun and knockback handling.
 * The same budgeted navigation and collision-constrained locomotion as other units is used.
 * Active conversations anchor the wizard; pending pursuits are served FIFO, never teleporting.
 */
export function stepFrickFrackWizard(w: World, sys: UnitsState, h: Hippie, b: Brain, dt: number): boolean {
  if (!h.wizard || h.id !== w.frickFrack.wizardId) return false;
  const sessions = Object.values(w.frickFrack.sessions).filter((s): s is FrickFrackSession => !!s && canPlay(w, s.faction)).sort((a, c) => a.id - c.id);
  if (!sessions.length) { wanderFrickFrackWizard(w, sys, h, b, dt); return true; }
  resetWizardCircuit(w);
  const active = sessions.find(s => s.phase !== 'chasing');
  const s = active ?? sessions[0], av = w.avatarOf(s.faction);
  if (active) {
    b.moving = false; h.vel.x = 0; h.vel.z = 0; h.status = 'idle'; h.statusTarget = null;
    h.facing = Math.atan2(av.pos.x - h.pos.x, av.pos.z - h.pos.z);
    return true;
  }
  if (withinConversationReach(w, h, s.faction)) {
    b.moving = false; startConversation(w, h, s); h.status = 'idle'; h.statusTarget = null; return true;
  }
  if (b.task !== 'follow' || b.target !== av.id) { beginTask(w, h, b, 'follow'); b.target = av.id; }
  b.pace = 1.25;
  setStatusAt(h, b, 'following', av.pos.x, av.pos.z);
  // A small arrival radius prevents stopping across a thin wall inside the dialogue radius.
  moveTo(w, sys, h, b, av.pos.x, av.pos.z, .8);
  locomote(w, sys, h, b, dt);
  return true;
}
