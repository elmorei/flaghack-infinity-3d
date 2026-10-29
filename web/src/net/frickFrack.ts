/** Explicit public Frick-frack wire format. Never serialize private shoe/escrow/RNG. */
import type { FrickFrackCard, FrickFrackState, FrickFrackSession } from '../sim/frickFrack';
import { FACTION_IDS } from '../sim/types';
import type { Wire } from './schema';

const phases = ['dialogue', 'betting', 'playing', 'result', 'empty'] as const;
const results = ['win', 'lose', 'push'] as const;
const integer = (v: Wire, lo = 0, hi = 0x7fffffff): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const finite = (v: Wire): v is number => typeof v === 'number' && Number.isFinite(v);
const cardWire = (c: FrickFrackCard): Wire => [c.id, c.rank, c.suit];
function cardFrom(v: Wire): FrickFrackCard | null {
  if (!Array.isArray(v) || v.length !== 3 || !integer(v[0]) || !integer(v[1], 1, 13) || !integer(v[2], 0, 3)) return null;
  return { id: v[0], rank: v[1], suit: v[2] };
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
      s.player.map(cardWire), s.dealer.map((c, i) => s.phase === 'playing' && i > 0 ? null : c ? cardWire(c) : null), s.result, s.message];
  }), FACTION_IDS.map(f => state.sideboards[f].map(cardWire)), state.drops.map(d => [d.id, cardWire(d.card), d.pos.x, d.pos.z, d.createdAt])];
}
export function frickFrackFromWire(v: Wire): FrickFrackState {
  const state: FrickFrackState = { wizardId: -1, sessions: {}, sideboards: {0:[],1:[],2:[],3:[]}, drops: [] };
  if (!Array.isArray(v) || v.length !== 4) return state;
  if (integer(v[0], -1)) state.wizardId = v[0];
  if (Array.isArray(v[1])) for (const f of FACTION_IDS) {
    const s = v[1][f];
    if (!Array.isArray(s) || s.length !== 12 || !integer(s[0]) || !integer(s[1]) || s[2] !== f ||
      !phases.includes(s[3] as typeof phases[number]) || !integer(s[4], 0, 100) || !finite(s[5]) || !finite(s[6]) || !integer(s[7]) ||
      !Array.isArray(s[9]) || !(s[10] === null || results.includes(s[10] as typeof results[number])) || typeof s[11] !== 'string') continue;
    const phase = s[3] as FrickFrackSession['phase'];
    state.sessions[f] = { id: s[0], revision: s[1], faction: f, phase, dialogueIndex:s[4], dialogueStartedAt:s[5], readyAt:s[6], wager:s[7],
      player:cardsFrom(s[8]), dealer:s[9].slice(0,64).map((c,i) => phase === 'playing' && i > 0 ? null : cardFrom(c)), result:s[10] as FrickFrackSession['result'], message:s[11].slice(0,2000) };
  }
  if (Array.isArray(v[2])) for (const f of FACTION_IDS) state.sideboards[f] = cardsFrom(v[2][f]);
  if (Array.isArray(v[3])) for (const d of v[3].slice(0,256)) {
    if (!Array.isArray(d) || d.length !== 5 || !integer(d[0]) || !finite(d[2]) || !finite(d[3]) || !finite(d[4])) continue;
    const card=cardFrom(d[1]);
    if (card) state.drops.push({id:d[0],card,pos:{x:d[2],z:d[3]},createdAt:d[4]});
  }
  return state;
}
