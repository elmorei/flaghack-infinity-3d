/** Offline actor/stock staging followed by real touch orders and ordinary simulation.
 * No input handlers, orders under test, inventory movement or simulation ticks are replaced. */
import assert from 'node:assert/strict';
export async function verifyMobileFlagOrders(page,{capture=async()=>{}}={}) {
  const checks=[];
  const center=async at=>{await page.evaluate(at=>{const s=window.flaghack.session;s.camera.cmdX=at.x;s.camera.cmdZ=at.z;},at);await page.waitForTimeout(500);};
  for(const mixed of [false,true]) for(const kind of ['recruit','plant']) {
    const fixture=await page.evaluate(({mixed,kind})=>{
      const a=window.flaghack;if(a.net)throw Error('Flag order fixture requires offline match');
      a.startMatch({seed:'recruitment-orders',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0],bossMode:false,crystalAttacks:false,days:3,startingSignifiers:0,maxSignifiers:20}});
      a.ai.clear();const w=a.world;w.hippies.clear();w.factions[0].plan.clear();for(const b of w.buildings.values())if(b.kind==='gcc'||b.kind==='drumcircle')b.disabled=true;
      const home=w.hearthOf(0),start=w.nav.nearestWalkable(home.pos.x+5,home.pos.z);
      const first=window.fh.factory.spawnHippie(w,0,start),second=mixed?window.fh.factory.spawnHippie(w,0,w.nav.nearestWalkable(start.x+2,start.z)):null;
      for(const h of [first,second].filter(Boolean))h.order={kind:'defend',at:{...h.pos}};
      const target=window.fh.factory.spawnHippie(w,-1,w.nav.nearestWalkable(home.pos.x+12,home.pos.z));
      const stock=[...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).map(f=>f.id);
      if(stock.length<2)throw Error('Real initial camp stock required');const carried=mixed?stock[0]:-1;
      if(mixed){window.fh.flags.giveFlag(w,carried,second.id);const d=Math.hypot(home.pos.x,home.pos.z)||1;second.order={kind:'move',to:w.nav.nearestWalkable(start.x-home.pos.x/d*40,start.z-home.pos.z/d*40)};}
      const node=w.lattice.nodes.filter(n=>window.fh.flags.canPlantAt(w,n.id,0)&&w.nav.isWalkable(n.x,n.z)&&Math.hypot(n.x-start.x,n.z-start.z)>5&&Math.hypot(n.x-target.pos.x,n.z-target.pos.z)>5).sort((A,B)=>Math.hypot(A.x-start.x,A.z-start.z)-Math.hypot(B.x-start.x,B.z-start.z))[0];
      if(!node)throw Error('Free walkable node required');
      const q=window.__flagQA={kind,mixed,first:first.id,second:second?.id,target:target.id,node:node.id,carried,stock,stockBefore:stock.length-(mixed?1:0),flags:w.flags.size,people:w.hippies.size,carry:false,followerCarry:false,followerFetch:false,orders:[],raf:0};
      q.project=p=>{const c=a.renderer.camera,v=c.position.clone().set(p.x,w.collision.groundHeight(p.x,p.z)+(p.raise??0),p.z).project(c);return{x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};};
      const observe=()=>{const lead=w.hippies.get(mixed?second.id:first.id),follower=mixed?w.hippies.get(first.id):null;q.carry ||= stock.includes(lead.carryingFlag);q.followerCarry ||= follower?.carryingFlag>=0;q.followerFetch ||= follower?.status==='fetching';if(lead.order?.kind===kind&&!q.orders.length)q.orders=[first,second].filter(Boolean).map(h=>({id:h.id,kind:h.order?.kind}));q.raf=requestAnimationFrame(observe);};q.raf=requestAnimationFrame(observe);
      return{first:first.id,second:second?.id,firstAt:{...first.pos},at:kind==='recruit'?{...target.pos}:{x:node.x,z:node.z}};
    },{mixed,kind});
    try {
      await page.waitForFunction(()=>{const a=window.flaghack;return a.session.screen==='playing'&&a.session.view==='command'&&a.ui.world===a.world&&!a.controls.freshWorld;});
      await page.locator('.mc-modes').getByRole('button',{name:'Degen',exact:true}).tap();await center(fixture.firstAt);
      if(mixed){
        await page.locator('.mc-top').getByRole('button',{name:'Menu',exact:true}).tap();await page.locator('.mc-tabs').getByRole('button',{name:'Units',exact:true}).tap();
        await page.locator('.mc-page[data-tab="units"]').getByRole('button',{name:'Select all units',exact:true}).tap();
        await page.waitForFunction(({first,second})=>{const s=window.flaghack.session;return s.mobileMenu===null&&s.selection.size===2&&s.selection.has(first)&&s.selection.has(second);},fixture);
      }else{
        const p=await page.evaluate(()=>{const q=window.__flagQA,h=window.flaghack.world.hippies.get(q.first);return q.project({...h.pos,raise:1});});await page.touchscreen.tap(p.x,p.y);
        await page.waitForFunction(id=>window.flaghack.session.selection.has(id),fixture.first);
      }
      await center(fixture.at);
      const p=await page.evaluate(()=>{const q=window.__flagQA,w=window.flaghack.world,at=q.kind==='recruit'?w.hippies.get(q.target).pos:w.lattice.nodes[q.node];return q.project({...at,raise:q.kind==='recruit'?1:0});});
      assert.ok(await page.evaluate(p=>p.x>0&&p.y>0&&p.x<innerWidth&&p.y<innerHeight&&!document.elementFromPoint(p.x,p.y)?.closest('.ix'),p),'Native target clear of HUD');
      await page.touchscreen.tap(p.x,p.y);await page.waitForFunction(()=>window.__flagQA.orders.length>0);
      await capture(`${mixed?'carrier-group':'empty-worker'}-${kind}-ordered`);
      await page.waitForFunction(()=>{const q=window.__flagQA,w=window.flaghack.world;return q.kind==='recruit'?w.hippies.get(q.target).faction===0:w.survey.nodeFlag[q.node]>=0;},null,{timeout:90000});
      const proof=await page.evaluate(()=>{
        const q=window.__flagQA,w=window.flaghack.world;const spent=q.kind==='recruit'?w.hippies.get(q.target).carryingFlag:w.survey.nodeFlag[q.node];
        return{kind:q.kind,mixed:q.mixed,first:q.first,second:q.second,stockBefore:q.stockBefore,stockAfter:[...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).length,flagsBefore:q.flags,flagsAfter:w.flags.size,peopleBefore:q.people,peopleAfter:w.hippies.size,spent,carried:q.carried,fromStock:q.stock.includes(spent),state:w.flags.get(spent)?.state,owner:w.flags.get(spent)?.owner,carry:q.carry,followerCarry:q.followerCarry,followerFetch:q.followerFetch,orders:q.orders};
      });
      checks.push(proof);await capture(`${mixed?'carrier-group':'empty-worker'}-${kind}-complete`);
      assert.ok(proof.fromStock&&proof.carry);assert.equal(proof.stockAfter,proof.stockBefore-(mixed?0:1));assert.equal(proof.flagsAfter,proof.flagsBefore);assert.equal(proof.peopleAfter,proof.peopleBefore);assert.equal(proof.owner,0);assert.equal(proof.state,kind==='recruit'?'carried':'planted');
      if(mixed){assert.equal(proof.spent,proof.carried);assert.equal(proof.followerCarry,false);assert.equal(proof.followerFetch,false);assert.equal(proof.orders.filter(o=>o.kind===kind).length,1);assert.equal(proof.orders.find(o=>o.id===proof.second)?.kind,kind);assert.equal(proof.orders.find(o=>o.id===proof.first)?.kind,'move');}
    }finally{await page.evaluate(()=>cancelAnimationFrame(window.__flagQA.raf));}
  }
  return{completed:true,checks,disclosure:'Offline stock/actor fixture. Real native unit selection and objective taps, ordinary navigation/simulation and real initial Flag inventory. No physical device certification.'};
}
