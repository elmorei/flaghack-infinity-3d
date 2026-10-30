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
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.mp4':'video/mp4', '.woff2':'font/woff2', '.woff':'font/woff', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.json':'application/json' };
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
    return {time:w.time,session:g.sessions[f]??null,carried:[...av.carried],sideboard:g.sideboards[f].map(c=>({...c})),drops:g.drops.length,position:{...av.pos},alive:w.factions[f].alive,hover:a.session.hover.entity,wizardId:g.wizardId,wizardPosition:w.hippies.get(g.wizardId)?.pos,camera:{...a.session.camera},screen:a.session.screen,pointerLocked:!!document.pointerLockElement,throwStage:window.__frickQa?.throwStage,altarStock:[...w.flags.values()].filter(fl=>fl.state==='stock'&&fl.holder===w.hearthOf(f)?.id).length};
  });
  try{
    for(const spec of specs){
      const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},userAgent:spec.touch?ANDROID:DESKTOP,hasTouch:spec.touch,isMobile:spec.touch,deviceScaleFactor:1,recordVideo:process.env.RECORD_VIDEO==='1'&&spec.full?{dir:join(OUT,'video'),size:{width:1280,height:800}}:undefined});
      page=await context.newPage();
      const entry={name:spec.name,pageErrors:[],videoMarks:[]};results.scenarios.push(entry);
      const videoStart=Date.now();
      const mark=label=>entry.videoMarks.push({label,seconds:(Date.now()-videoStart)/1000});
      const holdForDemo=async(label,ms=1800)=>{if(spec.full&&process.env.RECORD_VIDEO==='1'){mark(label);await page.waitForTimeout(ms);}};
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
      // Locator actions already scroll and re-resolve after UI revisions; a separate
      // scrollIntoViewIfNeeded can retain a detached element across a normal rerender.
      const tap=async locator=>{if(spec.touch)await locator.tap({noWaitAfter:true});else await locator.click({noWaitAfter:true});};
      const dialog=page.locator('.ff-overlay');
      const button=name=>dialog.getByRole('button',{name,exact:true});
      async function stageGift(throwChase=false){
        const beforeGift=await state();
        await page.waitForFunction(t=>window.flaghack.world.time>=t+1.05,beforeGift.time,{timeout:15_000});
        await page.evaluate(()=>{
          const a=window.flaghack,w=a.world,av=w.avatarOf(0),h=w.hippies.get(w.frickFrack.wizardId);
          if(!h)throw Error('Missing wizard');
          // Find ordinary clear ground away from auto-restocking structures and other units.
          let at;
          for(let x=-35;x<35&&!at;x+=5)for(let z=-35;z<35&&!at;z+=5){
            if(![-4,-2,0,2,4,6,8].every(d=>w.nav.isWalkable(x,z+d)))continue;
            if([...w.buildings.values()].some(b=>Math.hypot(b.pos.x-x,b.pos.z-z)<18))continue;
            if(w.collision.raycast(x,w.collision.groundHeight(x,z)+1,z-3,0,0,1,12))continue;
            at={x,z};
          }
          if(!at)throw Error('No clear staging point');
          av.pos={x:at.x,y:w.collision.groundHeight(at.x,at.z),z:at.z};av.vel={x:0,y:0,z:0};av.koUntil=0;av.hp=200;av.action={kind:'idle'};
          h.pos={x:at.x+.6,z:at.z+2};h.vel={x:0,z:0};h.koUntil=0;h.hp=100;h.order={kind:'defend',at:{...h.pos}};if(h.brain.mind){h.brain.mind.task='wander';h.brain.mind.waitUntil=w.time+30;h.brain.mind.moving=false;}
          for(const other of w.hippies.values())if(other.id!==h.id&&Math.hypot(other.pos.x-at.x,other.pos.z-at.z)<10){other.pos.x+=40;other.pos.z+=40;}
          for(const id of av.carried){const fl=w.flags.get(id);if(fl)fl.pos={...av.pos};}
          if(!av.carried.length)window.fh.give({flags:1});
          a.session.camera.yaw=0;a.session.camera.pitch=-.12;a.session.camera.dist=4.5;a.session.view='action';a.session.viewBlend=0;
          a.controls.rig.resetFollow();
          window.__frickQa.giftCount=av.carried.length;
        });
        // Let the normal title-to-play camera transition finish before using its ray.
        await page.waitForTimeout(2500);
        // Resolve the actual production camera shoulder offset, rather than assuming its sign.
        await page.evaluate(({touch,throwChase})=>{
          const a=window.flaghack,w=a.world,av=w.avatarOf(0),h=w.hippies.get(w.frickFrack.wizardId),o=a.controls.rig.origin,d=a.controls.rig.dir;
          // Phone presentation intentionally keeps the tactical camera; its offer button
          // uses physical reach, not the distant command-camera centre ray.
          const depth=((av.pos.x-o.x)*d.x+(av.pos.z-o.z)*d.z)/(d.x*d.x+d.z*d.z)+(throwChase?7:1.8);
          h.pos=touch?{x:av.pos.x+.6,z:av.pos.z+1.8}:{x:o.x+d.x*depth,z:o.z+d.z*depth};h.vel={x:0,z:0};
          if(h.brain.mind){h.brain.mind.task='wander';h.brain.mind.waitUntil=w.time+30;h.brain.mind.moving=false;}
        },{touch:spec.touch,throwChase});
        if(throwChase){
          // Enter actual aiming input, then stage the stationary actor on the production
          // ballistic predictor. Hovering a wizard's hat alone aims at the ground behind him.
          await page.mouse.click(spec.width/2,spec.height/2);
          await page.waitForFunction(()=>window.flaghack.controls.input.locked||window.flaghack.controls.input.lockUnavailable);
          await page.evaluate(()=>{const a=window.flaghack;a.session.camera.pitch=.18;a.controls.rig.resetFollow();});
          await page.waitForTimeout(900);
          await page.mouse.down({button:'right'});
          await page.waitForFunction(()=>window.flaghack.session.aim.active&&window.flaghack.session.aim.arc.length>3);
          // Positive session pitch looks DOWN (actionPose negates it). 1.62m pivot /
          // tan(.18) places the ground crosshair about 9m ahead on level ground.
          // Let the normal RMB shoulder boom/FOV finish before sampling its arc.
          await page.waitForTimeout(1200);
          await page.evaluate(()=>{
            const a=window.flaghack,w=a.world,av=w.avatarOf(0),h=w.hippies.get(w.frickFrack.wizardId);
            window.__frickQa.throwStage={arc:a.session.aim.arc.map(p=>({...p,distance:Math.hypot(p.x-av.pos.x,p.z-av.pos.z),height:p.y-w.collision.groundHeight(p.x,p.z),walkable:w.nav.isWalkable(p.x,p.z)})),hover:a.session.hover.point?{...a.session.hover.point}:null,rigOrigin:{...a.controls.rig.origin},rigDir:{...a.controls.rig.dir}};
            const candidates=a.session.aim.arc.filter(p=>{const distance=Math.hypot(p.x-av.pos.x,p.z-av.pos.z),height=p.y-w.collision.groundHeight(p.x,p.z);return distance>=5&&distance<=14&&height>.35&&height<1.5&&w.nav.isWalkable(p.x,p.z);});
            const p=candidates.at(-1);if(!p)throw Error('No reachable wizard point on the normal throw trajectory: '+JSON.stringify(window.__frickQa.throwStage));
            h.pos={x:p.x,z:p.z};h.vel={x:0,z:0};if(h.brain.mind){h.brain.mind.waitUntil=w.time+30;h.brain.mind.moving=false;}
            window.__frickQa.throwStage.point={...p};
          });
        }
        await page.waitForTimeout(150);
        await page.evaluate(()=>{const a=window.flaghack;window.__frickQa.cameraBefore={...a.session.camera};window.__frickQa.viewBefore=a.session.view;});
        await holdForDemo('wizard-before-gift',2200);
        if(throwChase){
          const before=await state();
          mark('throw-to-wizard');
          await page.keyboard.press('KeyQ');
          await page.waitForTimeout(120);
          await page.mouse.up({button:'right'});
          await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='chasing',null,{timeout:10000});
          assert.equal(await dialog.isVisible(),false,'Thrown gift does not remotely open dialogue');
          mark('wizard-chasing');
          await page.keyboard.down('KeyS');await page.waitForTimeout(650);await page.keyboard.up('KeyS');
          const following=await state();
          assert.ok(Math.hypot(following.position.x-before.position.x,following.position.z-before.position.z)>.2,'Player remains mobile while wizard follows');
          await shot('desktop-wizard-chasing');
          await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='dialogue',null,{timeout:20000});
          check('desktop: real thrown flag starts visible pursuit; movement remains free until arrival');
        }else if(spec.touch){
          await tap(page.getByRole('button',{name:'Give Flag to wizard',exact:true}));
        }else{
          await page.waitForFunction(()=>window.flaghack.session.hover.entity===window.flaghack.world.frickFrack.wizardId,null,{timeout:5000});
          await page.keyboard.press('KeyE');
        }
        await dialog.waitFor();mark('dialogue-start');
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='dialogue');
      }
      async function verifyRestoredCamera(){
        await page.waitForTimeout(850);
        const restored=await page.evaluate(()=>({camera:{...window.flaghack.session.camera},before:window.__frickQa.cameraBefore,view:window.flaghack.session.view,beforeView:window.__frickQa.viewBefore}));
        assert.deepEqual(restored.camera,restored.before,'Conversation preserves the user camera state');
        assert.equal(restored.view,restored.beforeView,'Conversation restores the prior view');
      }
      async function dialogueToChoice(){
        for(let index=0;index<3;index++){
          await page.waitForFunction(i=>window.flaghack.world.frickFrack.sessions[0]?.dialogueIndex===i,index);
          if(index===0){
            await page.waitForTimeout(850);
            assert.equal(await dialog.evaluate(e=>e.classList.contains('ff-in-world')),true,'Dialogue is an in-world scene, not the card overlay');
            const framing=await page.evaluate(()=>{
              const a=window.flaghack,w=a.world,av=w.avatarOf(0),h=w.hippies.get(w.frickFrack.wizardId),camera=a.renderer.camera;
              const project=(x,y,z)=>{const p=camera.position.clone().set(x,y,z).project(camera);return{x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2,z:p.z};};
              return {player:project(av.pos.x,av.pos.y+1.3,av.pos.z),wizard:project(h.pos.x,w.collision.groundHeight(h.pos.x,h.pos.z)+1.3,h.pos.z),panelTop:document.querySelector('.ff-panel').getBoundingClientRect().top,width:innerWidth};
            });
            for(const [who,p] of [['player',framing.player],['wizard',framing.wizard]]){
              assert.ok(p.z>-1&&p.z<1&&p.x>8&&p.x<framing.width-8&&p.y>8&&p.y<framing.panelTop-5,`${who} visibly framed above dialogue panel`);
            }
            assert.ok(Math.abs(framing.player.x-framing.wizard.x)>20,'Two actors have distinct screen positions');
            const lockedPose=await page.evaluate(()=>({...window.flaghack.controls.rig.pose}));
            await page.mouse.move(spec.width*.2,spec.height*.2);
            await page.mouse.move(spec.width*.7,spec.height*.3);
            await page.mouse.wheel(0,120);
            await page.waitForTimeout(100);
            const afterLook=await page.evaluate(()=>({...window.flaghack.controls.rig.pose}));
            assert.ok(Math.abs(afterLook.yaw-lockedPose.yaw)<.001&&Math.abs(afterLook.pitch-lockedPose.pitch)<.001&&Math.abs(afterLook.dist-lockedPose.dist)<.001,'Conversation camera remains locked against look and zoom');
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
          await holdForDemo('dialogue-page-'+index,700);
          if(index<2)await tap(button('Continue'));
        }
        await shot(spec.name+'-dialogue-invitation');
      }
      await stageGift(spec.full);await dialogueToChoice();
      if(spec.name==='phone-landscape'){
        const beforeDecline=(await state()).carried.length;
        await tap(button('No, thank you'));await dialog.waitFor({state:'hidden'});
        assert.equal((await state()).session,null);assert.equal((await state()).carried.length,beforeDecline);
        await verifyRestoredCamera();
        check('phone-landscape: declining invitation restores field without consuming gifted flag');
        await stageGift();await dialogueToChoice();
      }
      await tap(button('Yes, play Frick-frack'));
      await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
      const held=await page.evaluate(()=>window.__frickQa.giftCount);
      assert.equal((await state()).carried.length,held,'Gift remains available for wagering');
      await button('Deal hand').waitFor({state:'visible'});
      assert.equal(await dialog.evaluate(e=>e.classList.contains('ff-in-world')),false,'Only accepted game opens fullscreen card table');
      await shot(spec.name+'-table');await holdForDemo('table-ready',2200);
      check(`${spec.name}: real flag gift, three typed screens, locked avatar/live world, gift retained and blackjack table`);
      const box=await dialog.boundingBox();assert.ok(box&&box.x>=-1&&box.x+box.width<=spec.width+1,'Overlay fits viewport horizontally');
      await tap(button('Leave table'));
      await dialog.waitFor({state:'hidden'});
      assert.equal((await state()).session,null);
      assert.equal((await state()).carried.length,held,'Immediate exit costs no flags');
      await verifyRestoredCamera();
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
        await seedAndQuiver('frick-136-25',10);
        // A physically present known card is picked up by the normal simulation before use.
        // This collection fixture is staged directly because the KO drop itself is deliberately rare.
        await tap(button('Leave table'));await dialog.waitFor({state:'hidden'});
        const card=await page.evaluate(()=>{
          const w=window.flaghack.world,av=w.avatarOf(0),id=w.newId(),sunId=w.newId();
          w.frickFrack.drops.push({id,card:{id,rank:1,suit:0},pos:{x:av.pos.x+4,z:av.pos.z},createdAt:w.time});
          w.frickFrack.drops.push({id:sunId,card:{id:sunId,rank:0,suit:0,arcana:19},pos:{x:av.pos.x+4,z:av.pos.z},createdAt:w.time});
          window.__frickQa.cardId=id;return{id,sunId,x:av.pos.x+4,z:av.pos.z};
        });
        await shot('desktop-dropped-card');
        await page.evaluate(p=>{const w=window.flaghack.world,av=w.avatarOf(0);av.pos.x=p.x;av.pos.z=p.z;av.pos.y=w.collision.groundHeight(p.x,p.z);},card);
        await page.waitForFunction(id=>window.flaghack.world.frickFrack.sideboards[0].some(c=>c.id===id),card.id);
        await page.waitForFunction(id=>window.flaghack.world.frickFrack.sideboards[0].some(c=>c.id===id),card.sunId);
        assert.equal(await page.evaluate(id=>window.flaghack.world.frickFrack.drops.some(d=>d.id===id),card.id),false);
        await page.waitForTimeout(1100);await stageGift();await dialogueToChoice();await tap(button('Yes, play Frick-frack'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-136-25',10);await deal(1);
        assert.equal((await state()).session.phase,'playing');
        assert.equal((await state()).session.player.reduce((n,c)=>n+Math.min(c.rank,10),0),11);
        assert.ok((await state()).session.player.some(c=>c.tarot),'Full 136-card deck deals a genuine Minor Arcana card');
        assert.equal((await state()).session.dealer[1],null,'Hole card remains concealed during play');
        await shot('desktop-hand-and-sideboard');await holdForDemo('dealt-hand',2200);
        const beforeHitRevision=(await state()).session.revision;
        await tap(button('Hit'));
        await page.waitForFunction(rev=>window.flaghack.world.frickFrack.sessions[0].revision>rev,beforeHitRevision);
        assert.equal((await state()).session.player.length,2,'Weaker drawn CCG dies instead of remaining as a numeric card');
        await page.waitForFunction(()=>document.querySelector('.ff-wizard-remark')?.textContent?.includes('The 4 defeats the 3'));
        await page.waitForFunction(()=>document.querySelectorAll('.ff-hand-player .ff-card-defeated .ff-defeated-cross').length===1);
        assert.equal(await dialog.locator('.ff-hand-player .ff-card').count(),3,'Defeated card stays visible beside two active cards');
        assert.match(await dialog.locator('.ff-hand-player .ff-card-defeated').getAttribute('aria-label'),/defeated, does not count/);
        assert.equal((await state()).session.defeated[0].card.rank,3);
        await shot('desktop-ccg-battle');await holdForDemo('ccg-battle-on-hit',2800);
        if(!await dialog.locator('.ff-sideboard').evaluate(e=>e.open))await tap(dialog.locator('.ff-sideboard summary'));
        await holdForDemo('sideboard-open',1800);
        await tap(button('Play A♠ once'));
        await page.waitForFunction(id=>!window.flaghack.world.frickFrack.sideboards[0].some(c=>c.id===id),card.id);
        assert.ok((await state()).session.player.some(c=>c.id===card.id),'Known card added to hand');
        await button('Play A♠ once').waitFor({state:'detached'});
        assert.equal(await button('Play A♠ once').count(),0,'Consumed card is unavailable for replay');
        await shot('desktop-cheat-played');await holdForDemo('cheat-played',2200);
        if(!await dialog.locator('.ff-sideboard').evaluate(e=>e.open))await tap(dialog.locator('.ff-sideboard summary'));
        await tap(button('Inspect The Sun'));
        await button('Use The Sun').waitFor({state:'visible'});
        await shot('desktop-sun-effect-inspection');await holdForDemo('sun-effect-inspection',2500);
        await tap(button('Use The Sun'));
        await page.waitForFunction(id=>!window.flaghack.world.frickFrack.sideboards[0].some(c=>c.id===id),card.sunId);
        assert.equal((await state()).session.dealer.includes(null),false,'The Sun permanently reveals the actual dealer hole card');
        assert.equal((await state()).session.player.some(c=>c.arcana!==undefined),false,'Major Arcana is an effect, not a numeric hand card');
        await button('Use The Sun').waitFor({state:'detached'});
        await dialog.locator('.ff-hand-dealer .ff-card-back').waitFor({state:'detached'});
        // Read the current DOM atomically rather than scrolling an element handle
        // captured immediately before the authoritative revision rerenders it.
        await page.evaluate(()=>document.querySelector('.ff-hand-dealer')?.scrollIntoView({block:'nearest',behavior:'instant'}));
        await page.waitForTimeout(150);
        await shot('desktop-sun-revealed');await holdForDemo('sun-revealed',2500);
        await tap(button('Stand'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');
        assert.equal((await state()).session.result,'win');
        assert.equal((await state()).session.dealer.includes(null),false,'Dealer revealed after settlement');
        await shot('desktop-winning-hand');await holdForDemo('winning-hand',2500);
        check('desktop: physical numeric/Major pickups, random Hit, one-use Ace, inspect/confirm Sun reveal, Stand and settled win');

        await tap(button('Another hand'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        // A known sideboard card still goes through the real Play button and combat resolver.
        await seedAndQuiver('frick-136-25',10);await deal(1);
        await page.evaluate(()=>{const w=window.flaghack.world,s=w.frickFrack.sessions[0];w.frickFrack.sideboards[0]=[{id:w.newId(),rank:4,suit:0,parody:3}];s.revision++;});
        if(!await dialog.locator('.ff-sideboard').evaluate(e=>e.open))await tap(dialog.locator('.ff-sideboard summary'));
        await tap(dialog.getByRole('button',{name:/^Play .* once$/}));
        await page.waitForFunction(()=>document.querySelectorAll('.ff-defeated-cross').length===2);
        assert.equal((await state()).session.player.length,2);
        assert.equal((await state()).session.dealer[0],null,'Tied visible dealer card dies without revealing hole');
        assert.equal(await dialog.locator('.ff-hand-player .ff-total').textContent(),'11');
        await shot('desktop-ccg-tie');await holdForDemo('both-cards-marked-defeated',2400);
        for(const viewport of [{width:320,height:568},{width:844,height:390}]) {
          await page.setViewportSize(viewport);await page.waitForTimeout(200);
          assert.equal(await dialog.locator('.ff-defeated-cross').count(),2);
          await shot(`ccg-tie-${viewport.width}x${viewport.height}`);
        }
        await page.setViewportSize({width:spec.width,height:spec.height});
        await tap(button('Stand'));await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');
        await tap(button('Another hand'));await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        assert.equal((await state()).session.defeated?.length??0,0,'Authoritative next hand clears combat history');
        // The simulation changes phase before the next UI render publishes that revision.
        await page.waitForFunction(()=>document.querySelectorAll('.ff-defeated-cross').length===0);
        assert.equal(await dialog.locator('.ff-defeated-cross').count(),0,'Next hand clears combat history');
        check('desktop and narrow layouts: tied CCG cards keep visible X marks, excluded from total; next hand clears history');
        await seedAndQuiver('frick-136-57',5);await deal(2);
        assert.equal((await state()).session.phase,'playing');
        assert.deepEqual((await state()).session.player.map(c=>c.rank),[10,10],'Authentic shuffled pair, not an injected outcome');
        await shot('desktop-pair-hand');await holdForDemo('pair-hand',2000);
        await tap(button('Stand'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');
        const pairWin=await state();
        assert.equal(pairWin.session.result,'win');
        assert.match(pairWin.session.message,/You win 4 Flags.*Pair/i);
        assert.equal(pairWin.carried.length,9,'Two-Flag stake returned once plus four-Flag pair profit');
        await shot('desktop-pair-profit');await holdForDemo('pair-profit',3000);
        check('desktop: pair doubles only winning profit, not returned stake');

        await tap(button('Another hand'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-136-1',10);
        // Observe settlement before the live world can consume stock again.
        await page.evaluate(()=>{
          const w=window.flaghack.world,s=w.frickFrack.sessions[0];
          const stock=()=>[...w.flags.values()].filter(fl=>fl.state==='stock'&&fl.holder===w.hearthOf(0)?.id).length;
          let phase=s.phase;window.__frickQa.overflow={};
          Object.defineProperty(s,'phase',{enumerable:true,configurable:true,get:()=>phase,set(value){
            phase=value;
            if(value==='playing')window.__frickQa.overflow.before=stock();
            if(value==='result')window.__frickQa.overflow.after=stock();
          }});
        });
        await deal(10);
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');
        const overflow=await state();assert.equal(overflow.session.result,'win');assert.equal(overflow.carried.length,10);
        const settlement=await page.evaluate(()=>window.__frickQa.overflow);
        assert.equal(settlement.after-settlement.before,10,'Ten overflow winnings are real altar-stock flags at settlement');
        await shot('desktop-overflow-win');await holdForDemo('overflow-win',2500);
        check('desktop: selectable all-in wager, 1:1 natural payout, quiver cap and altar overflow');

        await tap(button('Another hand'));await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-136-9',3);await deal(3);
        await tap(button('Hit'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='empty');
        assert.equal((await state()).carried.length,0);
        await page.waitForFunction(()=>{const w=window.flaghack.world;return w.time>=w.frickFrack.sessions[0].readyAt;});
        assert.match(await dialog.locator('.ff-dialogue').textContent(),/no Flags left to bet.*Come back/i);
        await shot('desktop-no-flags');await holdForDemo('no-flags',2500);
        await tap(button('Return to the burn'));await dialog.waitFor({state:'hidden'});
        await holdForDemo('returned-to-field',1800);
        check('desktop: losing last wager shows come-back dialogue and exits cleanly');

        await page.waitForTimeout(1100);await stageGift();await dialogueToChoice();await tap(button('Yes, play Frick-frack'));
        await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
        await seedAndQuiver('frick-136-9',5);await deal(2);
        await tap(button('Exit · forfeit wager'));await dialog.waitFor({state:'hidden'});
        assert.equal((await state()).carried.length,3,'Mid-hand exit forfeits committed wager once');
        await page.keyboard.press('Escape');
        // Native Chrome may deliver its pointer-unlock event after the key event.
        // Await the actual pause menu instead of sampling visibility while it is still opening.
        await page.waitForFunction(()=>window.flaghack.session.screen==='paused'&&!document.pointerLockElement);
        assert.equal((await state()).session,null,'Repeated Escape does not restore hand or wager');
        // Resume through the real menu, then stage the lifecycle interruption.
        const resume = page.getByRole('button',{name:'Resume',exact:true});
        await resume.waitFor({state:'visible'});await tap(resume);
        await page.waitForFunction(()=>window.flaghack.session.screen==='playing');
        await page.waitForTimeout(1100);await stageGift();
        await page.evaluate(()=>{const w=window.flaghack.world,av=w.avatarOf(0);av.hp=0;av.koUntil=w.time+6;});
        await dialog.waitFor({state:'hidden'});
        assert.equal((await state()).session,null,'KO cancels modal and releases session lock');
        // KO selects its own death camera, but the saved user camera state must not be lost.
        assert.deepEqual((await state()).camera,await page.evaluate(()=>window.__frickQa.cameraBefore));
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
