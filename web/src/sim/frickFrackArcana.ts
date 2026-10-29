/** Shared Major Arcana rules. Majors are one-use sideboard effects, never numeric draw cards. */
import type { FrickFrackCard, FrickFrackSession } from './frickFrack';
import type { FrickFrackPrivateView } from './frickFrackPrivate';
export type ArcanaTarget = 'none' | 'one' | 'two' | 'value' | 'confirmOne';
export interface ArcanaDefinition { id: number; name: string; description: string; target: ArcanaTarget }
export const FRICK_FRACK_ARCANA: readonly ArcanaDefinition[] = [
  [0,'The Fool','Discard your latest card and draw a replacement.','none'],
  [1,'The Magician','Draw a card and choose its fixed value from 1 to 7.','value'],
  [2,'The High Priestess','Privately peek at the hidden dealer card for three seconds.','none'],
  [3,'The Empress','Gain a temporary one-use value-3 cheat for this hand.','none'],
  [4,'The Emperor','Set one of your cards to exactly 4.','one'],
  [5,'The Hierophant','Learn whether the dealer currently has a soft hand.','none'],
  [6,'The Lovers','Draw two cards, keep one, and discard the other.','none'],
  [7,'The Chariot','Take two cards, keep one, and discard the other.','none'],
  [8,'Strength','Discard your next draw if it would make you bust.','none'],
  [9,'The Hermit','Privately peek at the next three draw cards without reordering.','none'],
  [10,'Wheel of Fortune','Reroll your latest card to a fixed value from 1 to 10.','none'],
  [11,'Justice','A tied hand wins instead of pushing.','none'],
  [12,'The Hanged Man','Discard one of your cards, then immediately stand.','one'],
  [13,'Death','Discard your hand and receive two fresh cards at the same wager.','none'],
  [14,'Temperance','Set two different cards in your hand to exactly 5 each.','two'],
  [15,'The Devil','Pay the extra Flags to double your wager, then replace one card.','confirmOne'],
  [16,'The Tower','Discard the highest-value card from each hand.','none'],
  [17,'The Star','Recover one previously used numeric cheat, once this hand.','none'],
  [18,'The Moon','Replace the hidden dealer card without looking at it.','none'],
  [19,'The Sun','Permanently reveal the dealer’s hidden card.','none'],
  [20,'Judgement','Arm one free replay if this hand loses. Same committed wager.','none'],
  [21,'The World','If you win with exactly 21, win two stakes instead of one.','none'],
].map(([id,name,description,target]) => ({id:id as number,name:name as string,description:description as string,target:target as ArcanaTarget}));
export interface FrickFrackArcanaState {
  sun?: boolean; strength?: boolean; justice?: boolean; world?: boolean; judgement?: boolean;
  judgementUsed?: boolean; starUsed?: boolean; softDealer?: boolean; choices?: FrickFrackCard[];
}
export interface FrickFrackHand {
  deck: FrickFrackCard[]; dealer: FrickFrackCard[];
  usedNumeric: FrickFrackCard[]; temporaryIds: number[]; revealDealer: boolean;
  /** Cards are recorded in public reveal order; the hidden dealer card is absent until revealed. */
  revealedIds: number[]; holeId: number | null;
}
export interface ArcanaRequest { targetCardIds?: number[]; value?: number; confirmCost?: boolean }
export interface ArcanaContext {
  session: FrickFrackSession; hand: FrickFrackHand; sideboard: FrickFrackCard[];
  availableFlags: number; now: number; nextId(): number; randomInt(min:number,max:number):number;
  spendFlags(count:number): void; privateView(view:FrickFrackPrivateView): void;
}
export function frickFrackCardValue(c: FrickFrackCard): number {
  if (c.arcana !== undefined) return 0;
  return c.value ?? (c.parody !== undefined ? c.rank : c.rank === 1 ? 11 : Math.min(c.rank,10));
}
export function frickFrackDealerSoft(cards: readonly FrickFrackCard[]): boolean {
  let total = 0, aces = 0;
  for (const c of cards) { total += frickFrackCardValue(c); if (c.arcana === undefined && c.value === undefined && c.parody === undefined && c.rank === 1) aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return aces > 0;
}
const highest = (cards: FrickFrackCard[]) => cards.reduce((best,c,i) => frickFrackCardValue(c) > frickFrackCardValue(cards[best]) ? i : best,0);
/** Validate everything before applying; the caller consumes the major only after valid=true. */
export function applyFrickFrackArcana(ctx: ArcanaContext, id: number, request: ArcanaRequest): { valid: boolean; stand?: boolean } {
  const { session:s, hand:h, sideboard } = ctx;
  const definition = FRICK_FRACK_ARCANA[id];
  if (!definition || s.phase !== 'playing' || s.arcana?.choices?.length) return {valid:false};
  const targets = request.targetCardIds ?? [];
  const expected = definition.target === 'two' ? 2 : definition.target === 'one' || definition.target === 'confirmOne' ? 1 : 0;
  if (targets.length !== expected || new Set(targets).size !== targets.length || targets.some(id => !s.player.some(c => c.id === id))) return {valid:false};
  if (definition.target === 'value' ? !Number.isInteger(request.value) || request.value! < 1 || request.value! > 7 : request.value !== undefined) return {valid:false};
  if (definition.target === 'confirmOne' ? request.confirmCost !== true : request.confirmCost !== undefined) return {valid:false};
  if ([0,10,12,13,16].includes(id) && !s.player.length) return {valid:false};
  if ([2,18].includes(id) && (h.revealDealer || h.holeId === null || !h.dealer.some(c=>c.id===h.holeId))) return {valid:false};
  if ([5,16,19].includes(id) && !h.dealer.length) return {valid:false};
  if (id === 15 && (s.wager <= 0 || ctx.availableFlags < s.wager)) return {valid:false};
  if (id === 17 && (s.arcana?.starUsed || !h.usedNumeric.length)) return {valid:false};
  if (id === 20 && (s.arcana?.judgementUsed || s.arcana?.judgement)) return {valid:false};
  if ((id === 8 && s.arcana?.strength) || (id === 11 && s.arcana?.justice) || (id === 21 && s.arcana?.world) || (id === 19 && h.revealDealer)) return {valid:false};
  const need = [6,7,13].includes(id) ? 2 : [0,1,15,18].includes(id) ? 1 : 0;
  if ((id === 9 && !h.deck.length) || h.deck.length < need) return {valid:false};
  const effects = s.arcana ??= {};
  const draw = () => h.deck.pop()!;
  const replace = (i:number) => { s.player.splice(i,1,draw()); };
  const peek = (kind:'dealer'|'next',cards:FrickFrackCard[],seconds:number) => ctx.privateView({sessionId:s.id,revision:s.revision+1,expiresAt:ctx.now+seconds,kind,cards:cards.map(c=>({...c}))});
  switch (id) {
    case 0: replace(s.player.length-1); break;
    case 1: { const c=draw(); c.value=request.value!; s.player.push(c); break; }
    case 2: peek('dealer',[h.dealer.find(c=>c.id===h.holeId)!],3); break;
    case 3: { const c={id:ctx.nextId(),rank:3,suit:0,value:3,temporary:true}; sideboard.push(c);h.temporaryIds.push(c.id);break; }
    case 4: s.player.find(c=>c.id===targets[0])!.value=4;break;
    case 5: effects.softDealer=frickFrackDealerSoft(h.dealer);break;
    case 6: case 7: effects.choices=[draw(),draw()];break;
    case 8: effects.strength=true;break;
    case 9: peek('next',h.deck.slice(-3).reverse(),5);break;
    case 10: s.player.at(-1)!.value=ctx.randomInt(1,10);break;
    case 11: effects.justice=true;break;
    case 12: s.player.splice(s.player.findIndex(c=>c.id===targets[0]),1);return {valid:true,stand:true};
    case 13: s.player=[draw(),draw()];break;
    case 14: for (const target of targets) s.player.find(c=>c.id===target)!.value=5;break;
    case 15: ctx.spendFlags(s.wager);s.wager*=2;replace(s.player.findIndex(c=>c.id===targets[0]));break;
    case 16: s.player.splice(highest(s.player),1);h.dealer.splice(highest(h.dealer),1);delete effects.softDealer;break;
    case 17: { const c={...h.usedNumeric.at(-1)!,id:ctx.nextId(),temporary:true};sideboard.push(c);h.temporaryIds.push(c.id);effects.starUsed=true;break; }
    case 18: { const i=h.dealer.findIndex(c=>c.id===h.holeId);h.dealer[i]=draw();h.holeId=h.dealer[i].id;delete effects.softDealer;break; }
    case 19: h.revealDealer=true;effects.sun=true;break;
    case 20: effects.judgement=true;break;
    case 21: effects.world=true;break;
  }
  return {valid:true};
}
