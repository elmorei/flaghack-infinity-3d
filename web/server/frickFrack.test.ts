import { describe, expect, it } from 'vitest';
import { Match } from './match';
import { cmdFrickFrack, offerFrickFrackFlag, resetFrickFrackEntropy, updateFrickFrack } from '../src/sim/systems/frickFrack';
const options={seed:'frick-host',mode:'standard' as const,difficulty:'normal' as const,humans:[0 as const]};
const listener={frame:(_text:string)=>{},ended:()=>{},resync:()=>{},broken:()=>{}};
function open(match:Match) {
 const w=match.world, wizard=w.hippies.get(w.frickFrack.wizardId)!, av=w.avatarOf(0);
 const spot=w.nav.nearestWalkable(50,50); Object.assign(av.pos,{...spot,y:w.collision.groundHeight(spot.x,spot.z)});wizard.pos={x:spot.x,z:spot.z+1};
 expect(offerFrickFrackFlag(w,wizard,0,av.carried[0])).toBe(true);
 for(let i=0;i<3;i++) { const s=w.frickFrack.sessions[0]!;w.time=s.readyAt;
 cmdFrickFrack(w,{t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:i===2?'play':'next'}); }
 const s=w.frickFrack.sessions[0]!;
 expect(s.phase).toBe('rolling');w.time=s.rollEndsAt!;updateFrickFrack(w);
 expect(s.phase).toBe('betting');return s;
}
describe('host Frick-frack session lifecycle',()=>{
 it('disconnect and NPC takeover release locks without refunding committed wagers',()=>{
   const match=new Match(options,listener,()=>{}),w=match.world;
   match.driveHuman(0,'player',1);
   let s=open(match);
   // Preserve this legacy committed-wager scenario; dice targets have independent coverage.
   s.dieResult=1;s.target=21;resetFrickFrackEntropy(w,'frick-browser-0');
   cmdFrickFrack(w,{t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:'bet',wager:1});
   expect(s.phase).toBe('playing');
   const held=w.avatarOf(0).carried.length;
   match.holdStill(0);
   expect(w.frickFrack.sessions[0]).toBeUndefined();
   expect(w.avatarOf(0).carried.length).toBe(held);
   w.time+=2;s=open(match);match.driveNpc(0);
   expect(w.frickFrack.sessions[0]).toBeUndefined();
   expect(match.drivenByNpc(0)).toBe(true);
 });
 it('fresh hosts use different private shoes even with identical public map seeds',()=>{
   const signatures=new Set<string>();
   for(let i=0;i<4;i++) { const match=new Match(options,listener,()=>{}),w=match.world,s=open(match);
     cmdFrickFrack(w,{t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:'bet',wager:1});
     signatures.add(JSON.stringify([s.player.map(c=>[c.rank,c.suit]),s.dealer.map(c=>c&&[c.rank,c.suit])]));
   }
   expect(signatures.size).toBeGreaterThan(1);
 });
});
