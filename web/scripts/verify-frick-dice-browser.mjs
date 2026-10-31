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
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Staged last dialogue page, resources and deterministic seed. Real Play, host-owned roll, betting, Deal, Stand, Again and Exit. Normal-speed browser capture.',checks:[],scenarios:[]};
let browser,page;
const check=label=>{results.checks.push(label);console.log('PASS '+label);};
const state=()=>page.evaluate(()=>{
  const a=window.flaghack,w=a.world,s=w.frickFrack.sessions[0];
  return {phase:s?.phase??null,revision:s?.revision,session:s?JSON.parse(JSON.stringify(s)):null,time:w.time,fxTime:a.renderer.ctx?.time,screen:a.session.screen,snapshot:a.renderer.frickScene.snapshot(),gpuCalls:a.renderer.renderer.info.render.calls};
});
async function enter(context,spec,url){
  page=await context.newPage();
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
  if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
  await page.locator('#startup').waitFor({state:'detached'});
  await page.evaluate(()=>window.flaghack.startMatch({seed:'engine-frick-native',humans:[0],rtsFactions:[],match:{...window.flaghack.session.settings.match,active:[0],bossMode:false,days:3}}));
  await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world?.frickFrack?.wizardId>=0);
  await page.waitForTimeout(1800);
  await stageBetting();
  await page.getByRole('button',{name:'Deal hand',exact:true}).waitFor({state:'visible'});
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
  await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling');
  // Sample and inject in one browser turn, so slow test-driver roundtrips cannot turn an early bet into a legal settled bet.
  const gate=await page.evaluate(()=>{
    const a=window.flaghack,s=a.world.frickFrack.sessions[0];
    if(s.phase!=='rolling')throw Error('Harness missed the 1.25-second rolling sample window');
    const sampled={dieResult:s.dieResult,target:s.target,quiver:a.world.avatarOf(0).carried.length,
      hasDeal:[...document.querySelectorAll('.ff-overlay button')].some(b=>b.textContent==='Deal hand')};
    a.submit({t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action:'bet',wager:1});return sampled;
  });
  assert.equal(gate.dieResult,expected,'Host seeded result matches expected face');
  assert.equal(gate.target,20+expected);assert.equal(gate.hasDeal,false,'No betting controls while die is rolling');
  const quiver=gate.quiver;
  await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
  await page.waitForFunction(()=>window.flaghack.renderer.frickScene.snapshot().die?.progress===1);
  const settled=await state();
  assert.equal(settled.session.dieResult,expected);assert.equal(settled.session.target,20+expected);
  assert.equal(settled.snapshot.die.face,expected,'Actual cube mesh face equals authoritative result');
  assert.equal(settled.snapshot.die.result,expected);assert.equal(settled.snapshot.die.progress,1);
  assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).carried.length),quiver,'Premature wager rejected without spending');
  assert.ok(settled.time>before.time,'World continues while die rolls');
  assert.match(await page.locator('.ff-die-label').textContent(),new RegExp(String(20+expected)));
  const key=settled.snapshot.die.rollKey;
  await page.evaluate(()=>{window.flaghack.world.frickFrack.sessions[0].revision++;});
  await page.waitForTimeout(120);
  assert.equal((await state()).snapshot.die.rollKey,key,'Rerender retains die result/roll identity');
  assert.equal((await state()).snapshot.die.face,expected);
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
      await act('Leave table',spec);await page.locator('.ff-overlay').waitFor({state:'hidden'});
    }
    // Real hand and next-hand flow: retain target while playing and roll anew before any next stake.
    await roll(spec,seeds[6],6);
    await page.evaluate(()=>window.fh.frickFrack.resetEntropy('frick-136-25'));
    const old=await state();await act('Deal hand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='playing');
    const playing=await state();assert.equal(playing.session.target,26);assert.equal(playing.snapshot.die.face,6);
    assert.equal(playing.session.dealer[1],null,'Dealer hole privacy retained');
    await act('Stand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');
    await act('Another hand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling');
    assert.equal(await button('Deal hand').count(),0);
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
    await page.waitForFunction(()=>window.flaghack.renderer.frickScene.snapshot().die?.progress===1);
    const again=await state();assert.equal(again.session.rollNumber,old.session.rollNumber+1);
    assert.equal(again.snapshot.die.face,again.session.dieResult);assert.equal(again.session.target,20+again.session.dieResult);
    await act('Leave table',spec);await page.locator('.ff-overlay').waitFor({state:'hidden'});
    assert.equal((await state()).snapshot.active,false);
    assert.deepEqual(entry.errors,[]);check(spec.name+': physical die, all host gating, stable result, target and another-hand lifecycle');
  }catch(error){entry.error=error.stack||String(error);entry.failureState=await state().catch(()=>null);await page.screenshot({path:join(OUT,spec.name+'-failure.png')}).catch(()=>{});throw error;}
  finally{await context.close();}
}
async function diceDemo(url){
  const spec=specs[0],context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,userAgent:DESKTOP,recordVideo:{dir:join(OUT,'video'),size:{width:1280,height:800}}});
  const marks=[],start=Date.now(),mark=label=>marks.push({label,seconds:(Date.now()-start)/1000});
  try{
    await enter(context,spec,url);await invite(SEEDS[6]);
    mark('ready');await page.waitForTimeout(350);mark('roll');await act('Yes, play Frick-frack',spec);
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');await page.waitForTimeout(1400);
    await page.evaluate(()=>window.fh.frickFrack.resetEntropy('frick-136-25'));
    mark('deal');await act('Deal hand',spec);await page.waitForTimeout(1500);
    mark('stand');await act('Stand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='result');await page.waitForTimeout(1200);
    mark('again');await act('Another hand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');await page.waitForTimeout(1700);mark('end');
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
