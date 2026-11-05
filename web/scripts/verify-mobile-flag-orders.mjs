/** Offline actor/stock staging followed by real touch orders and ordinary simulation.
 * No input handlers, orders under test, inventory movement or simulation ticks are replaced. */
import assert from 'node:assert/strict';
/** Shared deterministic staging, also exercised headlessly against the real Simulation. */
export function stageMobileFlagOrderFixture({mixed,kind}) {
      const a=window.flaghack;if(a.net)throw Error('Flag order fixture requires offline match');
      a.startMatch({seed:'recruitment-orders',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0],bossMode:false,crystalAttacks:false,days:3,startingSignifiers:0,maxSignifiers:20}});
      a.ai.clear();const w=a.world;w.hippies.clear();w.factions[0].plan.clear();w.factions[0].lumber=0;w.factions[0].jobWeights={survey:0,gather:0,defend:0,raid:0,ritual:0};
      const home=w.hearthOf(0),start=w.nav.nearestWalkable(home.pos.x+5,home.pos.z);
      const first=window.fh.factory.spawnHippie(w,0,start),second=mixed?window.fh.factory.spawnHippie(w,0,w.nav.nearestWalkable(start.x+2,start.z)):null;
      for(const h of [first,second].filter(Boolean))h.order={kind:'defend',at:{...h.pos}};
      // Keep the handoff away from working recruiters; GCC immunity must not be disabled for QA.
      const recruiters=[...w.buildings.values()].filter(b=>['gcc','workshop','drumcircle'].includes(b.kind));
      const targetSpot=w.lattice.nodes.filter(n=>!n.blocked&&!n.boundary&&w.nav.isWalkable(n.x,n.z)&&Math.hypot(n.x-start.x,n.z-start.z)>=24&&Math.hypot(n.x-start.x,n.z-start.z)<=45&&w.nav.lineOfSight(start.x,start.z,n.x,n.z)&&recruiters.every(b=>Math.hypot(b.pos.x-n.x,b.pos.z-n.z)>28)).sort((A,B)=>Math.hypot(A.x-start.x,A.z-start.z)-Math.hypot(B.x-start.x,B.z-start.z))[0];
      if(!targetSpot)throw Error('Clear neutral staging point outside passive recruitment range required');
      const target=window.fh.factory.spawnHippie(w,-1,{x:targetSpot.x,z:targetSpot.z});
      const stock=[...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).map(f=>f.id);
      if(stock.length<2)throw Error('Real initial camp stock required');const carried=mixed?stock[0]:-1;
      if(mixed){window.fh.flags.giveFlag(w,carried,second.id);const d=Math.hypot(home.pos.x,home.pos.z)||1;second.order={kind:'move',to:w.nav.nearestWalkable(start.x-home.pos.x/d*40,start.z-home.pos.z/d*40)};}
      const node=w.lattice.nodes.filter(n=>window.fh.flags.canPlantAt(w,n.id,0)&&w.nav.isWalkable(n.x,n.z)&&Math.hypot(n.x-start.x,n.z-start.z)>5&&Math.hypot(n.x-target.pos.x,n.z-target.pos.z)>5).sort((A,B)=>Math.hypot(A.x-start.x,A.z-start.z)-Math.hypot(B.x-start.x,B.z-start.z))[0];
      if(!node)throw Error('Free walkable node required');
      const q=window.__flagQA={kind,mixed,first:first.id,second:second?.id,target:target.id,node:node.id,carried,stock,stockBefore:stock.length-(mixed?1:0),flags:w.flags.size,people:w.hippies.size,carry:false,followerCarry:false,followerFetch:false,orders:[],raf:0};
      q.project=p=>{const c=a.renderer.camera;c.updateMatrixWorld();const v=c.position.clone().set(p.x,w.collision.groundHeight(p.x,p.z)+(p.raise??0),p.z).project(c);return{x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};};
      const observe=()=>{const lead=w.hippies.get(mixed?second.id:first.id),follower=mixed?w.hippies.get(first.id):null;q.carry ||= stock.includes(lead.carryingFlag);q.followerCarry ||= follower?.carryingFlag>=0;q.followerFetch ||= follower?.status==='fetching';if([first,second].filter(Boolean).some(h=>h.order?.kind===kind)&&!q.orders.length)q.orders=[first,second].filter(Boolean).map(h=>({id:h.id,kind:h.order?.kind}));q.raf=requestAnimationFrame(observe);};q.raf=requestAnimationFrame(observe);
      return{first:first.id,second:second?.id,firstAt:{...first.pos},at:kind==='recruit'?{...target.pos}:{x:node.x,z:node.z}};

}

export async function verifyMobileFlagOrders(page,{capture=async()=>{}}={}) {
  const checks=[];
  const center=async at=>{await page.evaluate(at=>{const s=window.flaghack.session;s.camera.cmdX=at.x;s.camera.cmdZ=at.z;},at);await page.waitForTimeout(500);};
  for(const mixed of [false,true]) for(const kind of ['recruit','plant']) {
    const fixture=await page.evaluate(stageMobileFlagOrderFixture,{mixed,kind});
    try {
      await page.waitForFunction(()=>{const a=window.flaghack;return a.session.screen==='playing'&&a.session.view==='command'&&a.ui.world===a.world&&!a.controls.freshWorld;});
      // One ordinary frame creates the neutral's normal mind. Stage an idle neutral once,
      // rather than suppressing recruitment/movement systems on every simulation tick.
      await page.evaluate(()=>{const q=window.__flagQA,w=window.flaghack.world,h=w.hippies.get(q.target),b=h.brain.mind;if(!b)throw Error('Neutral mind was not initialized');b.task='wander';b.waitUntil=Infinity;b.moving=false;h.vel={x:0,z:0};});
      await page.locator('.mc-modes').getByRole('button',{name:'Degen',exact:true}).tap();await center(fixture.firstAt);
      if(mixed){
        await page.locator('.mc-top').getByRole('button',{name:'Menu',exact:true}).tap();await page.locator('.mc-tabs').getByRole('button',{name:'Units',exact:true}).tap();
        await page.locator('.mc-page[data-tab="units"]').getByRole('button',{name:'Select all units',exact:true}).tap();
        await page.waitForFunction(({first,second})=>{const s=window.flaghack.session;return s.mobileMenu===null&&s.selection.size===2&&s.selection.has(first)&&s.selection.has(second);},fixture);
      }else{
        const p=await page.evaluate(()=>{const q=window.__flagQA,h=window.flaghack.world.hippies.get(q.first);return q.project({...h.pos,raise:1});});await page.touchscreen.tap(p.x,p.y);
        await page.waitForFunction(id=>window.flaghack.session.selection.has(id),fixture.first);
      }
      await center(await page.evaluate(()=>{const q=window.__flagQA,w=window.flaghack.world;return q.kind==='recruit'?{...w.hippies.get(q.target).pos}:{x:w.lattice.nodes[q.node].x,z:w.lattice.nodes[q.node].z};}));
      const p=await page.evaluate(()=>{const q=window.__flagQA,w=window.flaghack.world;if(q.kind==='recruit'&&w.hippies.get(q.target).faction!==-1)throw Error('Fixture neutral was recruited before the native objective tap');if(q.mixed&&w.hippies.get(q.second).carryingFlag!==q.carried)throw Error('Fixture carrier lost its Flag before the native objective tap');const at=q.kind==='recruit'?w.hippies.get(q.target).pos:w.lattice.nodes[q.node];return q.project({...at,raise:q.kind==='recruit'?1:0});});
      assert.ok(await page.evaluate(p=>p.x>0&&p.y>0&&p.x<innerWidth&&p.y<innerHeight&&!document.elementFromPoint(p.x,p.y)?.closest('.ix'),p),'Native target clear of HUD');
      await page.touchscreen.tap(p.x,p.y);
      // A carrier already within reach can complete recruitment in the same simulation
      // tick that assigns its order. RAF must accept that terminal handoff, not wait for
      // a transient 'recruit' order that correctly no longer exists.
      await page.waitForFunction(()=>{const q=window.__flagQA,w=window.flaghack.world,h=w.hippies.get(q.target);return q.orders.length>0||(q.kind==='recruit'&&h.faction===0&&q.stock.includes(h.carryingFlag)&&w.recentEvents().some(e=>e.t==='recruited'&&e.hippieId===q.target&&e.via==='hand'));});
      await capture(`${mixed?'carrier-group':'empty-worker'}-${kind}-ordered`);
      await page.waitForFunction(()=>{const q=window.__flagQA,w=window.flaghack.world;return q.kind==='recruit'?w.hippies.get(q.target).faction===0:w.survey.nodeFlag[q.node]>=0;},null,{timeout:90000});
      const proof=await page.evaluate(()=>{
        const q=window.__flagQA,w=window.flaghack.world;const spent=q.kind==='recruit'?w.hippies.get(q.target).carryingFlag:w.survey.nodeFlag[q.node];
        return{kind:q.kind,mixed:q.mixed,first:q.first,second:q.second,stockBefore:q.stockBefore,stockAfter:[...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).length,flagsBefore:q.flags,flagsAfter:w.flags.size,peopleBefore:q.people,peopleAfter:w.hippies.size,spent,carried:q.carried,fromStock:q.stock.includes(spent),state:w.flags.get(spent)?.state,owner:w.flags.get(spent)?.owner,carry:q.carry,followerCarry:q.followerCarry,followerFetch:q.followerFetch,orders:q.orders,marker:window.flaghack.session.orderMarker?.kind,handEvents:w.recentEvents().filter(e=>e.t==='recruited'&&e.hippieId===q.target&&e.via==='hand').length,productionLumber:w.factions[0].lumber};
      });
      checks.push(proof);await capture(`${mixed?'carrier-group':'empty-worker'}-${kind}-complete`);
      assert.ok(proof.fromStock&&proof.carry);assert.equal(proof.marker,kind);if(kind==='recruit')assert.equal(proof.handEvents,1);assert.equal(proof.productionLumber,0);assert.equal(proof.stockAfter,proof.stockBefore-(mixed?0:1));assert.equal(proof.flagsAfter,proof.flagsBefore);assert.equal(proof.peopleAfter,proof.peopleBefore);assert.equal(proof.owner,0);assert.equal(proof.state,kind==='recruit'?'carried':'planted');
      if(mixed){assert.equal(proof.spent,proof.carried);assert.equal(proof.followerCarry,false);assert.equal(proof.followerFetch,false);if(proof.orders.length){assert.equal(proof.orders.filter(o=>o.kind===kind).length,1);assert.equal(proof.orders.find(o=>o.id===proof.second)?.kind,kind);assert.equal(proof.orders.find(o=>o.id===proof.first)?.kind,'move');}else{assert.equal(kind,'recruit');assert.equal(proof.handEvents,1,'Same-tick completion retains a real handoff event instead of a transient order');}}
    }catch(error){
      const diagnostic=await page.evaluate(()=>{const q=window.__flagQA,a=window.flaghack,w=a.world;return{time:w.time,kind:q.kind,mixed:q.mixed,selection:[...a.session.selection],marker:a.session.orderMarker,orders:q.orders,units:[q.first,q.second,q.target].filter(id=>id!==undefined).map(id=>{const h=w.hippies.get(id);return{id,faction:h?.faction,pos:h?.pos,flag:h?.carryingFlag,order:h?.order,status:h?.status};}),stock:[...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).length,lumber:w.factions[0].lumber,events:w.recentEvents().filter(e=>e.t==='recruited'||e.t==='rejected').slice(-12)};});
      throw new Error(`${error.message}\nFlag fixture state: ${JSON.stringify(diagnostic)}`,{cause:error});
    }finally{await page.evaluate(()=>cancelAnimationFrame(window.__flagQA.raf));}
  }
  return{completed:true,checks,disclosure:'Offline stock/actor fixture. Real native unit selection and objective taps, ordinary navigation/simulation and real initial Flag inventory. No physical device certification.'};
}
