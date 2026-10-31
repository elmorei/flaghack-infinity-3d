/** Native Chrome proof of the engine-rendered Frick-frack table.
 * Fixture resources/session setup are explicitly staged; deals, hits, Sun reveals,
 * settlement and exits use production buttons and authoritative commands.
 * The clean demo is normal-speed captured browser footage, never synthetic frames.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), {chromium}=require('playwright');
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/frick-dice-smoke');
const PROJECT='/flaghack-infinity-3d/';
const SEEDS={1:'roll-11',2:'roll-0',3:'roll-5',4:'roll-3',5:'roll-2',6:'roll-13'};
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.woff2':'font/woff2','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'};
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
const specs=[{name:'desktop',width:1280,height:800,touch:false},{name:'small-phone',width:320,height:568,touch:true},{name:'phone-landscape',width:844,height:390,touch:true},{name:'reduced-motion',width:1280,height:800,touch:false,reduced:true}];
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Regular-mode simulation is explicitly staged on all layouts, including mobile (whose real lobby defaults to Degen). Staged last dialogue page, resources and deterministic seed. Real Play, wager selection, single Deal, host-owned roll and automatic deal, Stand, next-hand single Deal and Exit. Card entropy is staged during rolling; real die results are not overridden. Normal-speed browser capture.',checks:[],scenarios:[]};
let browser,page;
const check=label=>{results.checks.push(label);console.log('PASS '+label);};
const state=()=>page.evaluate(()=>{
  const a=window.flaghack,w=a.world,s=w.frickFrack.sessions[0];
  return {phase:s?.phase??null,revision:s?.revision,session:s?JSON.parse(JSON.stringify(s)):null,time:w.time,fxTime:a.renderer.ctx?.time,screen:a.session.screen,snapshot:a.renderer.frickScene.snapshot(),gpuCalls:a.renderer.renderer.info.render.calls};
});
// Geometry/readiness probe runs in the actual browser, including synthetic dispatch
// against disabled controls (native disabled alone must not be the command guard).
async function installStableProbe(){
  await page.evaluate(()=>{
    window.__readStableTable=()=>{
      const root=document.querySelector('.ff-overlay'),rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
      const app=window.flaghack,s=app.world.frickFrack.sessions[0];
      const controls=[...root.querySelectorAll('.ff-main-actions button')].map(b=>({action:b.dataset.action,disabled:b.disabled,ariaDisabled:b.getAttribute('aria-disabled'),rect:rect(b),filter:getComputedStyle(b).filter,display:getComputedStyle(b).display}));
      const number=root.querySelector('.ff-flag-counter .res-flags-n.num');
      const main=[...document.querySelectorAll('.res-flags-n.num')].find(e=>!root.contains(e));
      const style=e=>{const c=getComputedStyle(e);return {fontFamily:c.fontFamily,fontWeight:c.fontWeight,color:c.color,textShadow:c.textShadow};};
      const counter=root.querySelector('.ff-flag-counter'),wager=root.querySelector('.ff-wager');
      const frameStyle=e=>{const c=getComputedStyle(e);return Object.fromEntries(['backgroundImage','backgroundColor','borderImageSource','borderImageSlice','borderImageWidth','borderImageRepeat','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderTopStyle','borderRadius','boxShadow','paddingTop','paddingRight','paddingBottom','paddingLeft'].map(k=>[k,c[k]]));};
      const counterFrame=frameStyle(counter),mainFrame=frameStyle(main.closest('.res.frame'));
      // DOM-only digit fixtures; restore the authoritative displayed value in the
      // same browser turn. Never mutate simulation resources to test typography.
      const original=number.textContent,fit=[];
      try{for(const digits of ['9','10','100']){
        number.textContent=digits;
        const row=number.parentElement,cs=getComputedStyle(counter),rs=getComputedStyle(row),num=x=>parseFloat(x)||0;
        const scale=counter.getBoundingClientRect().width/counter.offsetWidth;
        const natural=[...row.children].reduce((n,e)=>n+e.getBoundingClientRect().width/scale,0)+num(rs.columnGap)*(row.children.length-1)+num(rs.paddingLeft)+num(rs.paddingRight)+num(cs.paddingLeft)+num(cs.paddingRight)+num(cs.borderLeftWidth)+num(cs.borderRightWidth);
        fit.push({digits,width:counter.getBoundingClientRect().width,natural:natural*scale});
      }}finally{number.textContent=original;}

      const calls=[],focusFailures=[],submit=app.submit;app.submit=(...args)=>{calls.push(args);};
      try{for(const b of root.querySelectorAll('button:disabled')){b.focus({preventScroll:true});if(document.activeElement===b)focusFailures.push(b.dataset.action||b.textContent);b.click();b.dispatchEvent(new MouseEvent('click',{bubbles:true}));}}finally{app.submit=submit;}
      return {phase:s.phase,viewport:{width:innerWidth,height:innerHeight},panel:rect(root.querySelector('.ff-panel')),stage:rect(root.querySelector('.ff-table-stage')),controls,
        counter:rect(counter),counterFramed:counter.matches('.res.frame'),counterFrame,mainFrame,fit,removedControls:root.querySelectorAll('.ff-rules,[data-action="again"]').length,counterText:number.textContent,available:app.world.avatarOf(s.faction).carried.length,counterStyle:style(number),mainStyle:style(main),
        icon:counter.querySelector('.res-flag-ic')?.innerHTML,mainIcon:main.parentElement.querySelector('.res-flag-ic')?.innerHTML,
        wager:rect(wager),wagerDisabled:[...wager.querySelectorAll('button,input')].map(e=>e.disabled),
        sleeveOpen:root.querySelector('[data-action="sleeve"]').getAttribute('aria-expanded')==='true',disabledCalls:calls.length,focusFailures,snapshot:app.renderer.frickScene.snapshot()};
    };
  });
}
function assertStableTable(value,baseline,phase){
  assert.equal(value.phase,phase);
  assert.deepEqual(value.controls.map(b=>b.action),['bet','hit','stand','sleeve','exit'],'All five main controls remain in stable order');
  const enabled=phase==='betting'?['bet','exit']:phase==='playing'?['hit','stand','sleeve','exit']:phase==='result'?['bet','exit']:['exit'];
  for(const b of value.controls){
    assert.equal(b.disabled,!enabled.includes(b.action),phase+': '+b.action+' readiness');
    assert.ok(b.rect.width>0&&b.rect.height>=40,phase+': '+b.action+' visible touch target');
    assert.ok(b.rect.x>=-1&&b.rect.y>=-1&&b.rect.x+b.rect.width<=value.viewport.width+1&&b.rect.y+b.rect.height<=value.viewport.height+1,phase+': '+b.action+' wholly on screen');
    if(b.disabled)assert.match(b.filter,/grayscale|saturate/,'Unavailable plaque is visibly desaturated');
  }
  assert.ok(value.snapshot.backdropAspect>0,'Natural background aspect is available');
  assert.ok(Math.abs(value.snapshot.backdropRect.width/value.snapshot.backdropRect.height-value.snapshot.backdropAspect)<.001,'Background maintains source image proportions');
  assert.deepEqual(value.focusFailures,[],'Disabled controls cannot receive keyboard focus');
  assert.equal(value.disabledCalls,0,'Disabled clicks and synthetic dispatch never reach submit');
  assert.equal(value.counterText,String(value.available),'Bottom-left count shows authoritative available Flags');
  assert.deepEqual(value.counterStyle,value.mainStyle,'Counter reuses actual main gameplay font, color and shadow');
  assert.equal(value.removedControls,0,'Rules bar and Again button are absent');
  assert.equal(value.counterFramed,true,'Flag count uses the main res frame classes');
  const borderWidths=['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'];
  // The main HUD uses CSS zoom: Chromium snaps used border widths to device
  // pixels (e.g. shared 13px CSS becomes 12.2222px at .9 zoom). Keep exact
  // artwork/background/padding checks; allow only one CSS pixel of this rounding.
  for(const key of Object.keys(value.mainFrame)) {
    if(borderWidths.includes(key))assert.ok(Math.abs(parseFloat(value.counterFrame[key])-parseFloat(value.mainFrame[key]))<=1,'Shared frame border width '+key);
    else assert.equal(value.counterFrame[key],value.mainFrame[key],'Shared frame style '+key);
  }
  value.fit.forEach(f=>assert.ok(Math.abs(f.width-f.natural)<=3,'Flag plate hugs '+f.digits+' text rather than fixed empty width'));
  assert.ok(value.fit[1].width>value.fit[0].width&&value.fit[2].width>value.fit[1].width,'Flag plate grows naturally for added digits');
  assert.equal(value.icon,value.mainIcon,'Counter reuses main Flag icon');
  assert.ok(value.counter.x<value.viewport.width/2&&value.counter.y>value.viewport.height/2,'Flag count is bottom-left');
  assert.ok(value.counter.x>=-1&&value.counter.y+value.counter.height<=value.viewport.height+1,'Flag count remains on screen');
  assert.equal(value.wagerDisabled.length,4,'Wager decrement/input/increment/all remain present');
  if(!['betting','result'].includes(phase))assert.ok(value.wagerDisabled.every(Boolean),'Wager controls disabled during committed hand');
  if(baseline){
    const near=(a,b,label)=>{for(const key of ['x','y','width','height'])assert.ok(Math.abs(a[key]-b[key])<=1,phase+': invariant '+label+' '+key+' '+a[key]+' vs '+b[key]);};
    near(value.snapshot.backdropRect,baseline.snapshot.backdropRect,'background');near(value.panel,baseline.panel,'scene frame');near(value.stage,baseline.stage,'table/card zones');near(value.wager,baseline.wager,'wager zone');
    assert.ok(Math.abs(value.counter.x-baseline.counter.x)<=1&&Math.abs(value.counter.y+value.counter.height-baseline.counter.y-baseline.counter.height)<=1,'Flag counter stays anchored at bottom-left as digits change');
    value.controls.forEach((b,i)=>near(b.rect,baseline.controls[i].rect,b.action));
  }
}
async function enter(context,spec,url){
  page=await context.newPage();
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
  if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
  await page.locator('#startup').waitFor({state:'detached'});
  await page.evaluate(()=>window.flaghack.startMatch({seed:'engine-frick-native',humans:[0],rtsFactions:[],match:{...window.flaghack.session.settings.match,active:[0],bossMode:false,days:3}}));
  await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world?.frickFrack?.wizardId>=0);
  assert.equal(await page.evaluate(()=>window.flaghack.world.factions[0].controlMode),'avatar','Explicit Regular fixture preserves Frick coverage on mobile layout');
  await page.waitForTimeout(1800);
  await installStableProbe();
  await stageBetting();
  await page.getByRole('button',{name:'Deal',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>window.flaghack.renderer.frickScene.snapshot().active && window.flaghack.renderer.frickScene.snapshot().backdropReady);
}
async function stageBetting(){
  await page.evaluate(()=>{
    const a=window.flaghack,w=a.world,av=w.avatarOf(0),h=w.hippies.get(w.frickFrack.wizardId);
    if(!h)throw Error('Wizard missing');
    let at;
    for(let x=-35;x<35&&!at;x+=5)for(let z=-35;z<35&&!at;z+=5){
      if(![-2,0,2,4].every(d=>w.nav.isWalkable(x,z+d)))continue;
      if([...w.buildings.values()].some(b=>Math.hypot(b.pos.x-x,b.pos.z-z)<18))continue;
      if(w.collision.raycast(x,w.collision.groundHeight(x,z)+1,z,0,0,1,3))continue;
      at={x,z};
    }
    if(!at)throw Error('No clear fixture position');
    av.pos={x:at.x,y:w.collision.groundHeight(at.x,at.z),z:at.z};av.vel={x:0,y:0,z:0};av.hp=200;av.koUntil=0;av.action={kind:'idle'};
    h.pos={x:at.x,z:at.z+1.5};h.vel={x:0,z:0};h.hp=100;h.koUntil=0;
    if(h.brain.mind){h.brain.mind.task='wander';h.brain.mind.waitUntil=w.time+120;h.brain.mind.moving=false;}
    for(const other of w.hippies.values())if(other.id!==h.id&&Math.hypot(other.pos.x-at.x,other.pos.z-at.z)<10){other.pos.x+=40;other.pos.z+=40;}
    for(const id of [...av.carried])window.fh.flags.destroyFlag(w,id);
    window.fh.give({flags:10});window.fh.frickFrack.resetEntropy('frick-136-25');
    const id=w.newId();w.frickFrack.sideboards[0]=[{id,rank:0,suit:0,arcana:19}];
    w.frickFrack.sessions[0]={id:w.newId(),revision:0,faction:0,phase:'betting',dialogueIndex:0,dialogueStartedAt:w.time,readyAt:w.time,wager:0,player:[],dealer:[],result:null,message:''};
    window.__engineSun=id;
  });
}
const button=name=>page.locator('.ff-overlay').getByRole('button',{name,exact:true});
const act=async(name,spec)=>{const b=button(name);if(spec.touch)await b.tap({noWaitAfter:true});else await b.click({noWaitAfter:true});};

async function invite(seed){
  await stageBetting();
  await page.evaluate(seed=>{
    const w=window.flaghack.world,s=w.frickFrack.sessions[0];
    s.phase='dialogue';s.dialogueIndex=2;s.dialogueStartedAt=w.time-30;s.readyAt=0;s.revision++;
    window.fh.frickFrack.resetEntropy(seed);
  },seed);
  await button('Yes, play Frick-frack').waitFor({state:'visible'});
}
async function roll(spec, seed, expected){
  await invite(seed);
  const before=await state();await act('Yes, play Frick-frack',spec);
  await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting'&&!document.querySelector('.ff-main-actions [data-action="bet"]')?.disabled);
  const initial=await state();assert.equal(initial.session.dieResult,undefined,'Invitation does not start an extra roll');
  const initialLayout=await page.evaluate(()=>window.__readStableTable());assertStableTable(initialLayout,null,'betting');
  const available=await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length);
  const input=page.locator('.ff-overlay').getByLabel('Flags to wager');await input.fill('1');await input.dispatchEvent('change');
  await act('Deal',spec);
  await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling'&&document.querySelector('.ff-target-title')?.textContent==='Rolling the target');
  // Sample and inject in one browser turn, so slow test-driver roundtrips cannot turn an early bet into a legal settled bet.
  const gate=await page.evaluate(()=>{
    const a=window.flaghack,s=a.world.frickFrack.sessions[0];
    if(s.phase!=='rolling')throw Error('Harness missed the 1.25-second rolling sample window');
    const sampled={dieResult:s.dieResult,target:s.target,quiver:a.world.avatarOf(0).carried.length,
      dealDisabled:document.querySelector('.ff-overlay [data-action="bet"]')?.disabled,layout:window.__readStableTable()};
    a.submit({t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:'bet',wager:1});
    // Deterministic card fixture only, after the real die result has been drawn.
    window.fh.frickFrack.resetEntropy('frick-136-25');return sampled;
  });
  assert.equal(gate.dieResult,expected,'Host seeded result matches expected face');
  assert.equal(gate.target,20+expected);assert.equal(gate.dealDisabled,true,'Deal stays visible but cannot bet while rolling');
  assertStableTable(gate.layout, initialLayout, 'rolling');
  const quiver=gate.quiver;assert.equal(quiver,available-1,'Single Deal charges selected wager at roll start');
  await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='playing'&&!document.querySelector('.ff-main-actions [data-action="stand"]')?.disabled);
  await page.waitForFunction(()=>window.flaghack.renderer.frickScene.snapshot().die?.progress===1);
  const settled=await state();
  assert.equal(settled.session.dieResult,expected);assert.equal(settled.session.target,20+expected);
  assert.equal(settled.snapshot.die.face,expected,'Actual cube mesh face equals authoritative result');
  assert.equal(settled.snapshot.die.result,expected);assert.equal(settled.snapshot.die.progress,1);
  assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length),quiver,'Repeated wager rejected without spending twice');
  assert.ok(settled.time>before.time,'World continues while die rolls');
  assert.match(await page.locator('.ff-die-label').textContent(),new RegExp(String(20+expected)));
  const key=settled.snapshot.die.rollKey;
  await page.evaluate(()=>{window.flaghack.world.frickFrack.sessions[0].revision++;});
  await page.waitForTimeout(120);
  assert.equal((await state()).snapshot.die.rollKey,key,'Rerender retains die result/roll identity');
  assert.equal((await state()).snapshot.die.face,expected);
  const settledLayout=await page.evaluate(()=>window.__readStableTable());
  assertStableTable(settledLayout,gate.layout,'playing');
  settled.layout=settledLayout;
  return settled;
}
async function verifyDice(spec,url){
  const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},hasTouch:spec.touch,isMobile:spec.touch,userAgent:spec.touch?ANDROID:DESKTOP,deviceScaleFactor:1,reducedMotion:spec.reduced?'reduce':'no-preference'});
  const entry={name:spec.name,rolls:[],errors:[]};results.scenarios.push(entry);
  try{
    await enter(context,spec,url);page.on('pageerror',e=>entry.errors.push(e.message));
    const seeds=SEEDS;
    for(const result of spec.name==='desktop'?[1,2,3,4,5,6]:[6]){
      const settled=await roll(spec,seeds[result],result);entry.rolls.push(settled);
      assert.equal(settled.snapshot.backdropReady,true,'Approved clean scenery loaded');
      assert.equal(settled.snapshot.backdropKind,spec.name==='small-phone'?'portrait':'landscape','Responsive scenery uses the appropriate composition');
      await page.locator('.ff-die-stage').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(OUT,spec.name+'-die-'+result+'.png')});
      await act('Exit · forfeit wager',spec);await page.locator('.ff-overlay').waitFor({state:'hidden'});
    }
    // One press per hand: retain target while playing, then commit/roll/deal the next hand.
    const layoutStart=await roll(spec,seeds[6],6);
    const old=await state();
    const playingLayout=await page.evaluate(()=>window.__readStableTable());assertStableTable(playingLayout,layoutStart.layout,'playing');
    assert.equal(playingLayout.available,layoutStart.layout.available,'Automatic deal does not charge the wager again');
    const sleeve=page.locator('.ff-main-actions [data-action="sleeve"]');if(spec.touch)await sleeve.tap();else await sleeve.click();
    const openLayout=await page.evaluate(()=>window.__readStableTable());assertStableTable(openLayout,playingLayout,'playing');assert.equal(openLayout.sleeveOpen,true);
    await page.screenshot({path:join(OUT,spec.name+'-stable-sleeve.png')});
    await page.locator('.ff-extras').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    assertStableTable(await page.evaluate(()=>window.__readStableTable()),playingLayout,'playing');
    if(spec.touch)await sleeve.tap();else await sleeve.click();assertStableTable(await page.evaluate(()=>window.__readStableTable()),playingLayout,'playing');
    await sleeve.focus(); await page.keyboard.press('Enter');
    assert.equal(await sleeve.getAttribute('aria-expanded'),'true','Keyboard opens Sleeve');
    assert.equal(await sleeve.evaluate(e=>document.activeElement===e),true,'Sleeve keeps keyboard focus after rerender');
    await page.keyboard.press('Enter');
    assert.equal(await sleeve.getAttribute('aria-expanded'),'false','Second Enter closes Sleeve rather than hitting');
    const playing=await state();assert.equal(playing.session.target,26);assert.equal(playing.snapshot.die.face,6);
    assert.equal(playing.session.dealer[1],null,'Dealer hole privacy retained');
    await act('Stand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result'&&!document.querySelector('.ff-main-actions [data-action="bet"]')?.disabled);
    assertStableTable(await page.evaluate(()=>window.__readStableTable()),playingLayout,'result');
    await page.screenshot({path:join(OUT,spec.name+'-stable-result.png')});
    const resultAvailable=await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length);
    const nextWager=2;const input=page.locator('.ff-overlay').getByLabel('Flags to wager');
    await input.fill(String(nextWager));await input.dispatchEvent('change');
    await page.evaluate(()=>window.fh.frickFrack.resetEntropy('roll-13'));
    await act('Deal',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling'&&document.querySelector('.ff-target-title')?.textContent==='Rolling the target');
    await page.evaluate(()=>window.fh.frickFrack.resetEntropy('frick-136-25'));
    const nextRoll=await state();
    assert.equal(nextRoll.session.wager,nextWager,'Result Deal binds selected wager once');
    assert.equal(nextRoll.session.player.length+nextRoll.session.dealer.length,0,'Cards wait for die settlement');
    assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length),resultAvailable-nextWager,'Result Deal charges once without repeating settlement payout');
    assertStableTable(await page.evaluate(()=>window.__readStableTable()),playingLayout,'rolling');
    assert.equal(await button('Deal').count(),1);assert.equal(await button('Deal').isDisabled(),true);
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='playing'&&document.querySelector('.ff-main-actions [data-action="stand"]')?.disabled===false);
    await page.waitForFunction(()=>window.flaghack.renderer.frickScene.snapshot().die?.progress===1);
    assertStableTable(await page.evaluate(()=>window.__readStableTable()),playingLayout,'playing');
    await page.waitForTimeout(300);
    const again=await state();
    assert.equal(again.phase,'playing','One Deal automatically rolls and deals the next hand');
    assert.equal(again.session.wager,nextWager);assert.equal(again.session.player.length+again.session.dealer.length,4);
    assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length),resultAvailable-nextWager,'Auto deal never double charges');
    assert.equal(again.session.rollNumber,old.session.rollNumber+1);
    assert.equal(again.snapshot.die.face,again.session.dieResult);assert.equal(again.session.target,20+again.session.dieResult);
    await act('Exit · forfeit wager',spec);await page.locator('.ff-overlay').waitFor({state:'hidden'});
    assert.equal((await state()).snapshot.active,false);
    // Exiting during the committed roll cannot refund, restart, or deal later.
    await invite(SEEDS[6]);await act('Yes, play Frick-frack',spec);
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting'&&document.querySelector('.ff-main-actions [data-action="bet"]')?.disabled===false);
    const funds=await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length);
    const stake=page.locator('.ff-overlay').getByLabel('Flags to wager');await stake.fill('2');await stake.dispatchEvent('change');
    await act('Deal',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling'&&document.querySelector('.ff-main-actions [data-action="exit"]')?.disabled===false);
    assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length),funds-2);
    const exit=page.locator('.ff-main-actions [data-action="exit"]');if(spec.touch)await exit.tap({noWaitAfter:true});else await exit.click({noWaitAfter:true});
    await page.locator('.ff-overlay').waitFor({state:'hidden'});await page.waitForTimeout(1500);
    assert.equal((await state()).session,null,'Exit during roll never auto deals later');
    assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length),funds-2,'Committed roll exit forfeits exactly one stake');
    assert.deepEqual(entry.errors,[]);check(spec.name+': physical die, all host gating, stable scene/control bounds, HUD Flag styling/count, disabled actions, physical die and another-hand lifecycle');
  }catch(error){entry.error=error.stack||String(error);entry.failureState=await state().catch(()=>null);await page.screenshot({path:join(OUT,spec.name+'-failure.png')}).catch(()=>{});throw error;}
  finally{await context.close();}
}
async function diceDemo(url){
  const spec=specs[0],context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,userAgent:DESKTOP,recordVideo:{dir:join(OUT,'video'),size:{width:1280,height:800}}});
  const marks=[],start=Date.now(),mark=label=>marks.push({label,seconds:(Date.now()-start)/1000});
  try{
    await enter(context,spec,url);await invite(SEEDS[6]);
    mark('ready');await page.waitForTimeout(350);await act('Yes, play Frick-frack',spec);
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');await page.waitForTimeout(700);
    mark('deal-roll');await act('Deal',spec);
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling');
    await page.evaluate(()=>window.fh.frickFrack.resetEntropy('frick-136-25'));
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='playing');mark('auto-dealt');await page.waitForTimeout(1700);
    mark('stand');await act('Stand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');await page.waitForTimeout(1200);
    await page.evaluate(()=>window.fh.frickFrack.resetEntropy('roll-13'));
    mark('next-deal-roll');await act('Deal',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling');
    await page.evaluate(()=>window.fh.frickFrack.resetEntropy('frick-136-25'));
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='playing');mark('next-auto-dealt');await page.waitForTimeout(1700);mark('end');
    results.demo={marks,videoPath:await page.video().path(),recordingSpeed:1,fixtureDisclosure:results.fixtureDisclosure};
  }finally{await context.close();}
}
async function main(){
  mkdirSync(OUT,{recursive:true});await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url='http://127.0.0.1:'+server.address().port+PROJECT;
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  try{for(const spec of specs)await verifyDice(spec,url);await diceDemo(url);results.completed=true;}
  catch(e){results.error=e.stack||String(e);throw e;}
  finally{writeFileSync(join(OUT,'result.json'),JSON.stringify(results,null,2));await browser.close();server.close();}
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
