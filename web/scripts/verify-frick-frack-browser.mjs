/** Native Chrome checks of the real Frick-frack UI and simulation. Fixture staging is
 * offline only; actions are sent through actual rendered buttons/input handlers. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '../dist');
const OUT = resolve(HERE, '../host-release/frick-frack-smoke');
const PROJECT = '/flaghack-infinity-3d/';
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.mp4':'video/mp4', '.woff2':'font/woff2', '.woff':'font/woff', '.svg':'image/svg+xml', '.json':'application/json' };
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(!path.startsWith(PROJECT)){res.writeHead(404);res.end();return;}
  const file=resolve(DIST,decodeURIComponent(path.slice(PROJECT.length))||'index.html');
  if(!file.startsWith(DIST+'/')){res.writeHead(404);res.end();return;}
  let body;try{body=readFileSync(file);}catch{res.writeHead(404);res.end();return;}
  const headers={'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store','Accept-Ranges':'bytes'};
  const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
  if(range){const start=Number(range[1]),end=Math.min(body.length-1,range[2]?Number(range[2]):body.length-1);if(start>end||start>=body.length){res.writeHead(416);res.end();return;}headers['Content-Range']=`bytes ${start}-${end}/${body.length}`;body=body.subarray(start,end+1);}
  headers['Content-Length']=body.length;res.writeHead(range?206:200,headers);res.end(body);
});
const ANDROID='Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const DESKTOP='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const specs=[{name:'desktop',width:1280,height:800,touch:false,full:true},{name:'small-phone',width:320,height:568,touch:true},{name:'phone-landscape',width:844,height:390,touch:true}];
async function main(){
  mkdirSync(OUT,{recursive:true});
  if(!process.env.LIVE_URL)await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=process.env.LIVE_URL||`http://127.0.0.1:${server.address().port}${PROJECT}`;
  const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  const results={url,completed:false,physicalDeviceTest:false,checks:[],scenarios:[]};
  let page;
  const check=label=>{results.checks.push(label);console.log('PASS '+label);};
  const shot=name=>page.screenshot({path:join(OUT,name+'.png'),animations:'disabled'});
  const state=()=>page.evaluate(()=>{
    const a=window.flaghack,w=a.world,f=a.session.playerFaction,av=w.avatarOf(f),g=w.frickFrack;
    return {time:w.time,session:g.sessions[f]??null,carried:[...av.carried],sideboard:g.sideboards[f].map(c=>({...c})),drops:g.drops.length,position:{...av.pos},alive:w.factions[f].alive,screen:a.session.screen,pointerLocked:!!document.pointerLockElement,altarStock:[...w.flags.values()].filter(fl=>fl.state==='stock'&&fl.holder===w.hearthOf(f)?.id).length};
  });
  try{
    for(const spec of specs){
      const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},userAgent:spec.touch?ANDROID:DESKTOP,hasTouch:spec.touch,isMobile:spec.touch,deviceScaleFactor:1,recordVideo:process.env.RECORD_VIDEO==='1'&&spec.full?{dir:join(OUT,'video'),size:{width:1280,height:800}}:undefined});
      page=await context.newPage();
      const entry={name:spec.name,pageErrors:[]};results.scenarios.push(entry);
      page.on('pageerror',error=>entry.pageErrors.push(error.message));
      await page.goto(url,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180_000});
      if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
      await page.locator('#startup').waitFor({state:'detached'});
      await page.evaluate(()=>{
        const a=window.flaghack;
        a.startMatch({seed:'frick-frack-native-qa',humans:[0],rtsFactions:[],match:{...a.session.settings.match,active:[0],bossMode:false,days:3}});
        window.__frickQa={};
      });
      await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world?.frickFrack?.wizardId>=0);
      const tap=async locator=>{await locator.scrollIntoViewIfNeeded();if(spec.touch)await locator.tap({noWaitAfter:true});else await locator.click({noWaitAfter:true});};
      const dialog=page.locator('.ff-overlay');
      const button=name=>dialog.getByRole('button',{name,exact:true});
      async function stageGift(){
        const beforeGift=await state();
        await page.waitForFunction(t=>window.flaghack.world.time>=t+1.05,beforeGift.time,{timeout:15_000});
        await page.evaluate(()=>{
          const a=window.flaghack,w=a.world,av=w.avatarOf(0),h=w.hippies.get(w.frickFrack.wizardId);
          if(!h)throw Error('Missing wizard');
          // Find ordinary clear ground away from auto-restocking structures and other units.
          let at;
          for(let x=-35;x<35&&!at;x+=5)for(let z=-35;z<35&&!at;z+=5){
            if(!w.nav.isWalkable(x,z)||!w.nav.isWalkable(x,z+2))continue;
            if([...w.buildings.values()].some(b=>Math.hypot(b.pos.x-x,b.pos.z-z)<18))continue;
            if(w.collision.raycast(x,w.collision.groundHeight(x,z)+1,z,0,0,1,3))continue;
            at={x,z};
          }
          if(!at)throw Error('No clear staging point');
          av.pos={x:at.x,y:w.collision.groundHeight(at.x,at.z),z:at.z};av.vel={x:0,y:0,z:0};av.koUntil=0;av.hp=200;av.action={kind:'idle'};
          h.pos={x:at.x+.6,z:at.z+2};h.vel={x:0,z:0};h.koUntil=0;h.hp=100;h.order={kind:'defend',at:{...h.pos}};if(h.brain.mind){h.brain.mind.task='wander';h.brain.mind.waitUntil=w.time+30;h.brain.mind.moving=false;}
          for(const other of w.hippies.values())if(other.id!==h.id&&Math.hypot(other.pos.x-at.x,other.pos.z-at.z)<10){other.pos.x+=40;other.pos.z+=40;}
          for(const id of av.carried){const fl=w.flags.get(id);if(fl)fl.pos={...av.pos};}
          if(!av.carried.length)window.fh.give({flags:1});
          a.session.camera.yaw=0;a.session.camera.pitch=0;a.session.camera.dist=4.5;a.session.view='action';a.session.viewBlend=0;
          window.__frickQa.giftCount=av.carried.length;
        });
        await page.waitForTimeout(500);
        if(spec.touch){
          await tap(page.getByRole('button',{name:'Give Flag to wizard',exact:true}));
        }else{
          await page.waitForFunction(()=>window.flaghack.session.hover.entity===window.flaghack.world.frickFrack.wizardId,null,{timeout:5000});
          await page.keyboard.press('KeyE');
        }
        await dialog.waitFor();
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='dialogue');
      }
      async function dialogueToChoice(){
        for(let index=0;index<3;index++){
          await page.waitForFunction(i=>window.flaghack.world.frickFrack.sessions[0]?.dialogueIndex===i,index);
          if(index===0){
            const before=await state();
            const lettersBefore=await dialog.locator('.ff-dialogue').textContent();
            assert.equal(await button('Continue').isDisabled(),true,'Cannot advance before wizard finishes');
            await page.keyboard.down('KeyW');await page.waitForTimeout(350);await page.keyboard.up('KeyW');
            const after=await state();
            const lettersAfter=await dialog.locator('.ff-dialogue').textContent();
            assert.ok(lettersAfter.length>lettersBefore.length,'Dialogue reveals more letters over time');
            assert.ok(after.time>before.time,'World keeps running during conversation');
            assert.ok(Math.hypot(after.position.x-before.position.x,after.position.z-before.position.z)<.05,'Dialogue locks movement');
            assert.equal(after.pointerLocked,false,'Conversation releases pointer');
            await shot(spec.name+'-dialogue-typing');
          }
          await page.waitForFunction(()=>{const a=window.flaghack,s=a.world.frickFrack.sessions[0];return s&&a.world.time>=s.readyAt;},null,{timeout:15_000});
          if(index<2)await tap(button('Continue'));
        }
        await shot(spec.name+'-dialogue-invitation');
      }
      await stageGift();await dialogueToChoice();
      if(spec.name==='phone-landscape'){
        const beforeDecline=(await state()).carried.length;
        await tap(button('No, thank you'));await dialog.waitFor({state:'hidden'});
        assert.equal((await state()).session,null);assert.equal((await state()).carried.length,beforeDecline);
        check('phone-landscape: declining invitation restores field without consuming gifted flag');
        await stageGift();await dialogueToChoice();
      }
      await tap(button('Yes, play Frick-frack'));
      await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
      const held=await page.evaluate(()=>window.__frickQa.giftCount);
      assert.equal((await state()).carried.length,held,'Gift remains available for wagering');
      await shot(spec.name+'-table');
      check(`${spec.name}: real flag gift, three typed screens, locked avatar/live world, gift retained and blackjack table`);
      const box=await dialog.boundingBox();assert.ok(box&&box.x>=-1&&box.x+box.width<=spec.width+1,'Overlay fits viewport horizontally');
      await tap(button('Leave table'));
      await dialog.waitFor({state:'hidden'});
      assert.equal((await state()).session,null);
      assert.equal((await state()).carried.length,held,'Immediate exit costs no flags');
      check(`${spec.name}: immediate exit restores field without flag charge`);
      if(spec.full){
        // Re-enter via the actual gift action; fixture only resets deterministic RNG/resources.
        await page.waitForTimeout(1100);await stageGift();await dialogueToChoice();
        await tap(button('Yes, play Frick-frack'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        async function seedAndQuiver(seed,count){
          await page.evaluate(({seed,count})=>{
            const w=window.flaghack.world,av=w.avatarOf(0);
            for(const id of [...av.carried])window.fh.flags.destroyFlag(w,id);
            window.fh.give({flags:count});
            window.fh.frickFrack.resetEntropy(seed);
          },{seed,count});
          await page.waitForTimeout(100);
        }
        async function deal(amount){
          const input=dialog.getByLabel('Flags to wager');
          await input.fill(String(amount));await input.dispatchEvent('change');
          await tap(button('Deal hand'));
          await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase!=='betting');
        }
        await seedAndQuiver('frick-browser-107',10);
        // A physically present known card is picked up by the normal simulation before use.
        // This collection fixture is staged directly because the KO drop itself is deliberately rare.
        await tap(button('Leave table'));await dialog.waitFor({state:'hidden'});
        const card=await page.evaluate(()=>{
          const w=window.flaghack.world,av=w.avatarOf(0),id=w.newId();
          w.frickFrack.drops.push({id,card:{id,rank:1,suit:0},pos:{x:av.pos.x+4,z:av.pos.z},createdAt:w.time});
          window.__frickQa.cardId=id;return{id,x:av.pos.x+4,z:av.pos.z};
        });
        await shot('desktop-dropped-card');
        await page.evaluate(p=>{const w=window.flaghack.world,av=w.avatarOf(0);av.pos.x=p.x;av.pos.z=p.z;av.pos.y=w.collision.groundHeight(p.x,p.z);},card);
        await page.waitForFunction(id=>window.flaghack.world.frickFrack.sideboards[0].some(c=>c.id===id),card.id);
        assert.equal(await page.evaluate(id=>window.flaghack.world.frickFrack.drops.some(d=>d.id===id),card.id),false);
        await page.waitForTimeout(1100);await stageGift();await dialogueToChoice();await tap(button('Yes, play Frick-frack'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-browser-107',10);await deal(1);
        assert.equal((await state()).session.phase,'playing');
        assert.equal((await state()).session.player.reduce((n,c)=>n+Math.min(c.rank,10),0),6);
        assert.equal((await state()).session.dealer[1],null,'Hole card remains concealed during play');
        await shot('desktop-hand-and-sideboard');
        await tap(button('Hit'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0].player.length===3);
        await tap(button('Play A♠ once'));
        await page.waitForFunction(id=>!window.flaghack.world.frickFrack.sideboards[0].some(c=>c.id===id),card.id);
        assert.ok((await state()).session.player.some(c=>c.id===card.id),'Known card added to hand');
        assert.equal(await button('Play A♠ once').count(),0,'Consumed card is unavailable for replay');
        await shot('desktop-cheat-played');
        await tap(button('Stand'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');
        assert.equal((await state()).session.result,'win');
        assert.equal((await state()).session.dealer.includes(null),false,'Dealer revealed after settlement');
        await shot('desktop-winning-hand');
        check('desktop: physical card pickup, random Hit, one-use known card, Stand and settled win');

        await tap(button('Another hand'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-browser-29',10);
        const stockBefore=(await state()).altarStock;
        await deal(10);
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');
        const overflow=await state();assert.equal(overflow.session.result,'win');assert.equal(overflow.carried.length,10);
        assert.equal(overflow.altarStock-stockBefore,10,'Ten overflow winnings are real altar-stock flags');
        await shot('desktop-overflow-win');
        check('desktop: selectable all-in wager, 1:1 natural payout, quiver cap and altar overflow');

        await tap(button('Another hand'));await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-browser-0',3);await deal(3);
        await tap(button('Hit'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='empty');
        assert.equal((await state()).carried.length,0);
        await page.waitForFunction(()=>{const w=window.flaghack.world;return w.time>=w.frickFrack.sessions[0].readyAt;});
        assert.match(await dialog.locator('.ff-dialogue').textContent(),/no Flags left to bet.*Come back/i);
        await shot('desktop-no-flags');
        await tap(button('Return to the burn'));await dialog.waitFor({state:'hidden'});
        check('desktop: losing last wager shows come-back dialogue and exits cleanly');

        await page.waitForTimeout(1100);await stageGift();await dialogueToChoice();await tap(button('Yes, play Frick-frack'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-browser-0',5);await deal(2);
        await tap(button('Exit · forfeit wager'));await dialog.waitFor({state:'hidden'});
        assert.equal((await state()).carried.length,3,'Mid-hand exit forfeits committed wager once');
        await page.keyboard.press('Escape');await page.waitForTimeout(150);
        assert.equal((await state()).session,null,'Repeated Escape does not restore hand or wager');
        // Resume from ordinary pause if Escape opened it, then stage the lifecycle interruption.
        await page.evaluate(()=>{const a=window.flaghack;if(a.session.screen==='paused')a.setPaused(false);});
        await page.waitForTimeout(1100);await stageGift();
        await page.evaluate(()=>{const w=window.flaghack.world,av=w.avatarOf(0);av.hp=0;av.koUntil=w.time+6;});
        await dialog.waitFor({state:'hidden'});
        assert.equal((await state()).session,null,'KO cancels modal and releases session lock');
        check('desktop: active-hand exit cannot refund wager; KO cleans up locked dialogue');
      }
      assert.deepEqual(entry.pageErrors,[],spec.name+' has no browser page errors');
      await context.close();
    }
    results.completed=true;
  }catch(error){results.error=error.stack||String(error);if(page&&!page.isClosed()){results.failureState=await state().catch(()=>null);await shot('failure').catch(()=>{});}throw error;}
  finally{writeFileSync(join(OUT,'result.json'),JSON.stringify(results,null,2));await browser.close();server.close();}
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
