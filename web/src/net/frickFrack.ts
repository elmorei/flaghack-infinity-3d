/** Explicit public Frick-frack wire format. Never serialize private shoe/escrow/RNG. */
import type { FrickFrackCard, FrickFrackState, FrickFrackSession } from '../sim/frickFrack';
import { FRICK_FRACK_RETURN_DIALOGUES } from '../sim/frickFrack';
import { FACTION_IDS } from '../sim/types';
import type { Wire } from './schema';

const phases = ['chasing', 'dialogue', 'rolling', 'betting', 'playing', 'result', 'empty'] as const;
const results = ['win', 'lose', 'push'] as const;
const integer = (v: Wire, lo = 0, hi = 0x7fffffff): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const finite = (v: Wire): v is number => typeof v === 'number' && Number.isFinite(v);
const cardWire = (c: FrickFrackCard): Wire => {
  if ([!!c.tarot,c.parody !== undefined,c.arcana !== undefined].filter(Boolean).length > 1) return null;
  const family: Wire = c.arcana !== undefined ? ['arcana',c.arcana] : c.parody !== undefined ? c.parody : c.tarot ? true : null;
  if (c.value !== undefined || c.temporary) return [c.id,c.rank,c.suit,family,c.value ?? null,c.temporary ?? false];
  return family === null ? [c.id,c.rank,c.suit] : [c.id,c.rank,c.suit,family];
};
function cardFrom(v: Wire): FrickFrackCard | null {
  if (!Array.isArray(v) || ![3,4,6].includes(v.length) || !integer(v[0])) return null;
  const tag = v.length > 3 ? v[3] : null;
  const tarot = tag === true;
  const parody = integer(tag,0,3) ? tag as 0|1|2|3 : undefined;
  const arcana = Array.isArray(tag) && tag.length === 2 && tag[0] === 'arcana' && integer(tag[1],0,21) ? tag[1] : undefined;
  if (tag !== null && !tarot && parody === undefined && arcana === undefined) return null;
  if (!integer(v[1],arcana !== undefined ? 0 : 1,arcana !== undefined ? 0 : parody !== undefined ? 7 : tarot ? 14 : 13) || !integer(v[2],0,arcana !== undefined || parody !== undefined ? 0 : 3)) return null;
  if (v.length === 6 && (!(v[4] === null || integer(v[4],1,10)) || typeof v[5] !== 'boolean' || (arcana !== undefined && v[4] !== null))) return null;
  return {id:v[0],rank:v[1],suit:v[2],...(tarot?{tarot:true}:{}),...(parody !== undefined?{parody}:{}),...(arcana !== undefined?{arcana}:{}),...(v.length===6 && typeof v[4]==='number'?{value:v[4]}:{}),...(v[5]===true?{temporary:true}:{})};
}
const effectKeys = ['sun','strength','justice','world','judgement','judgementUsed','starUsed','softDealer'] as const;
function effectsWire(s: FrickFrackSession): Wire {
  return s.arcana ? [...effectKeys.map(k=>s.arcana?.[k] ?? null),s.arcana.choices?.map(cardWire) ?? null] : null;
}
function effectsFrom(v: Wire): FrickFrackSession['arcana'] {
  if (!Array.isArray(v) || v.length !== 9 || v.slice(0,8).some(x=>x!==null && typeof x!=='boolean')) return undefined;
  const e: NonNullable<FrickFrackSession['arcana']> = {};
  effectKeys.forEach((k,i)=>{if(typeof v[i]==='boolean')e[k]=v[i] as boolean;});
  if (Array.isArray(v[8])) e.choices=cardsFrom(v[8]).slice(0,2);
  return e;
}
function cardsFrom(v: Wire): FrickFrackCard[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 64).map(cardFrom).filter((c): c is FrickFrackCard => c !== null);
}
export function frickFrackWire(state: FrickFrackState): Wire {
  return [state.wizardId, FACTION_IDS.map(f => {
    const s = state.sessions[f];
    if (!s) return null;
    return [s.id, s.revision, s.faction, s.phase, s.dialogueIndex, s.dialogueStartedAt, s.readyAt, s.wager,
      s.player.map(cardWire), s.dealer.map((c, i) => s.phase === 'playing' && !s.arcana?.sun && i > 0 ? null : c ? cardWire(c) : null), s.result, s.message, s.remark ?? '', effectsWire(s), s.dialogueVariant ?? null, s.defeated?.map(d => [d.side, cardWire(d.card)]) ?? null, s.revealedCardOrder ?? null, s.dieResult ?? null, s.target ?? null, s.rollStartedAt ?? null, s.rollEndsAt ?? null, s.rollNumber ?? null];
  }), FACTION_IDS.map(f => state.sideboards[f].map(cardWire)), state.drops.map(d => [d.id, cardWire(d.card), d.pos.x, d.pos.z, d.createdAt]), state.visits ? FACTION_IDS.map(f => state.visits?.[f] ?? null) : null];
}
export function frickFrackFromWire(v: Wire): FrickFrackState {
  const state: FrickFrackState = { wizardId: -1, sessions: {}, sideboards: {0:[],1:[],2:[],3:[]}, drops: [] };
  if (!Array.isArray(v) || ![4,5].includes(v.length)) return state;
  if (integer(v[0], -1)) state.wizardId = v[0];
  if (Array.isArray(v[1])) for (const f of FACTION_IDS) {
    const s = v[1][f];
    if (!Array.isArray(s) || ![12,13,14,15,17,22].includes(s.length) || !integer(s[0]) || !integer(s[1]) || s[2] !== f ||
      !phases.includes(s[3] as typeof phases[number]) || !integer(s[4], 0, 100) || !finite(s[5]) || !finite(s[6]) || !integer(s[7]) ||
      !Array.isArray(s[9]) || !(s[10] === null || results.includes(s[10] as typeof results[number])) || typeof s[11] !== 'string' || (s.length >= 13 && typeof s[12] !== 'string')) continue;
    const phase = s[3] as FrickFrackSession['phase'], arcana = effectsFrom(s[13]);
    const hasRoll = s.length === 22 && s.slice(17).some(x => x !== null);
    if ((hasRoll && (!integer(s[17],1,6) || !integer(s[18],21,26) || s[18] !== 20 + (s[17] as number) ||
        !finite(s[19]) || !finite(s[20]) || s[20] < s[19] || !integer(s[21],1))) || (phase === 'rolling' && !hasRoll)) continue;
    const roll = hasRoll ? { dieResult:s[17] as number,target:s[18] as number,rollStartedAt:s[19] as number,rollEndsAt:s[20] as number,rollNumber:s[21] as number } : {};
    const defeated: NonNullable<FrickFrackSession['defeated']> = [];
    if (Array.isArray(s[15])) for (const entry of s[15].slice(0,256)) {
      if (!Array.isArray(entry) || entry.length !== 2 || (entry[0] !== 'player' && entry[0] !== 'dealer')) continue;
      const card = cardFrom(entry[1]);
      if (card?.parody !== undefined && !defeated.some(d => d.card.id === card.id)) defeated.push({side:entry[0],card});
    }
    const revealedCardOrder = Array.isArray(s[16]) ? [...new Set(s[16].slice(0,256).filter((id): id is number => integer(id)))] : undefined;
    state.sessions[f] = { id: s[0], revision: s[1], faction: f, phase, ...roll, dialogueIndex:s[4], dialogueStartedAt:s[5], readyAt:s[6], wager:s[7],
      player:cardsFrom(s[8]), dealer:s[9].slice(0,64).map((c,i) => phase === 'playing' && !arcana?.sun && i > 0 ? null : cardFrom(c)), result:s[10] as FrickFrackSession['result'], message:s[11].slice(0,2000), ...(arcana ? {arcana} : {}), ...(Array.isArray(s[15]) ? {defeated} : {}), ...(revealedCardOrder ? {revealedCardOrder} : {}), ...(integer(s[14],0,FRICK_FRACK_RETURN_DIALOGUES.length) ? {dialogueVariant:s[14]} : {}), ...(typeof s[12] === 'string' && s[12] ? { remark: s[12].slice(0,400) } : {}) };
  }
  if (Array.isArray(v[2])) for (const f of FACTION_IDS) state.sideboards[f] = cardsFrom(v[2][f]);
  if (Array.isArray(v[3])) for (const d of v[3].slice(0,256)) {
    if (!Array.isArray(d) || d.length !== 5 || !integer(d[0]) || !finite(d[2]) || !finite(d[3]) || !finite(d[4])) continue;
    const card=cardFrom(d[1]);
    if (card) state.drops.push({id:d[0],card,pos:{x:d[2],z:d[3]},createdAt:d[4]});
  }
  if (Array.isArray(v[4])) {
    state.visits = {};
    for (const f of FACTION_IDS) if (integer(v[4][f])) state.visits[f] = v[4][f] as number;
  }
  return state;
}
