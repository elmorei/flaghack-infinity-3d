/** Native headed Chrome sleeve-viewer QA. Explicit fixtures only for table setup and
 * owned inventory; gameplay uses real production controls. Raw video is 1x speed.
 * Mobile cases are browser-emulated, not physical-device certification. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), {chromium}=require('playwright');
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/frick-sleeve-smoke');
const PROJECT='/flaghack-infinity-3d/';
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
const specs=[{name:'desktop',width:1280,height:800},{name:'phone-portrait',width:390,height:844,touch:true},{name:'small-phone',width:320,height:568,touch:true},{name:'phone-landscape',width:844,height:390,touch:true},{name:'reduced-motion',width:1280,height:800,reduced:true}];
const results={completed:false,physicalDeviceTest:false,recordingSpeed:1,fixtureDisclosure:'Regular-mode table/resources/owned inventory are explicitly staged on every layout, including mobile whose lobby defaults to Degen. Real Deal rolls and deals automatically; Play Card and Exit use production commands. Duplicate faces have separate unique card IDs. No synthetic video frames.',scenarios:[]};
let browser,page;
const state=()=>page.evaluate(()=>{const a=window.flaghack,w=a.world,s=w.frickFrack.sessions[0];return {phase:s?.phase,revision:s?.revision,time:w.time,fxTime:a.renderer.ctx?.time,board:w.frickFrack.sideboards[0],arcana:s?.arcana,snapshot:a.renderer.frickScene.snapshot()};});
async function enter(context,spec,url){
  page=await context.newPage();
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
  if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
  await page.locator('#startup').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.deviceLayout),spec.touch?'mobile':'desktop','QA must exercise actual selected device layout, not only a narrow viewport');
  await page.evaluate(()=>window.flaghack.startMatch({seed:'engine-frick-native',humans:[0],rtsFactions:[],match:{...window.flaghack.session.settings.match,active:[0],bossMode:false,days:3}}));
  await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world?.frickFrack?.wizardId>=0);
  assert.equal(await page.evaluate(()=>window.flaghack.world.factions[0].controlMode),'avatar','Explicit Regular fixture preserves Frick coverage on mobile layout');
  await page.waitForTimeout(1800);
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
const viewer=()=>page.locator('.ff-sleeve-viewer');
const control=name=>viewer().getByRole('button',{name,exact:true});
async function inventory(kind='all'){
  await page.evaluate(kind=>{
    const w=window.flaghack.world;
    const cards=[{id:w.newId(),rank:2,suit:1},{id:w.newId(),rank:2,suit:1},
      {id:w.newId(),rank:3,suit:2,tarot:true},{id:w.newId(),rank:1,suit:0,parody:0},
      {id:w.newId(),rank:0,suit:0,arcana:8}];
    w.frickFrack.sideboards[0]=kind==='empty'?[]:kind==='single'?[cards[4]]:cards;
  },kind);
}
async function deal(){
  await page.locator('[data-action="bet"]').click();
  await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='rolling');
  await page.evaluate(()=>{const s=window.flaghack.world.frickFrack.sessions[0];window.fh.frickFrack.resetEntropy('frick-136-25');s.dieResult=1;s.target=21;});
  await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='playing');
  await page.waitForTimeout(600);
}
async function open(){await page.locator('[data-action="sleeve"]').click();await viewer().waitFor({state:'visible'});}
async function card(){
  await page.waitForFunction(()=>{
    const key=document.querySelector('.ff-sleeve-card')?.dataset.engineKey;
    const a=window.flaghack,board=a.world.frickFrack.sideboards[a.session.playerFaction];
    return key && board.some(c=>key===`sleeve-viewer:${c.id}`) && a.renderer.frickScene.snapshot().cards.some(c=>c.key===key&&c.faceUp);
  });
  return (await state()).snapshot.cards.find(c=>c.key.startsWith('sleeve-viewer:'));
}
async function geometry(){
  // Readiness and capture must be one browser turn: the table can rerender
  // between a boolean readiness poll and a separate evaluateAll call.
  const sample=await page.waitForFunction(()=>{
    const rects=[...document.querySelectorAll('.ff-table-stage,.ff-main-actions,.ff-flag-counter')].map(e=>{
      const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};
    });
    return rects.length===3&&rects.every(r=>r.width>0&&r.height>0)?rects:false;
  },null,{timeout:30000});
  try{return await sample.jsonValue();}finally{await sample.dispose();}
}
async function scenario(spec,url){
  const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},hasTouch:!!spec.touch,isMobile:!!spec.touch,...(spec.touch?{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'}:{}),deviceScaleFactor:1,reducedMotion:spec.reduced?'reduce':'no-preference',recordVideo:{dir:join(OUT,'video'),size:{width:spec.width,height:spec.height}}});
  const entry={name:spec.name,checks:[],errors:[]};results.scenarios.push(entry);
  const check=s=>{entry.checks.push(s);console.log(`PASS ${spec.name}: ${s}`);};
  try{
    await enter(context,spec,url);page.on('pageerror',e=>entry.errors.push(e.message));
    assert.equal(await page.locator('[data-action="sleeve"]').isDisabled(),true);
    await deal();await inventory();const before=await state(), table=await geometry();
    await open();let selected=await card();
    assert.equal(await viewer().locator('img,canvas').count(),0,'No fake DOM card renderer');
    assert.equal(selected.key,`sleeve-viewer:${before.board[0].id}`);
    assert.ok(selected.height>=140&&selected.width>=90,'Prominent actual engine card');
    assert.equal(selected.z,110);assert.ok((await state()).snapshot.sleeveOverlay);
    assert.deepEqual(await geometry(),table,'Viewer does not reflow table, controls or HUD');
    assert.equal(await control('Previous sleeve card').isDisabled(),true);
    assert.equal(await page.locator('.ff-body').evaluate(e=>e.inert),true);
    await viewer().locator('.ff-sleeve-card').click();
    assert.deepEqual((await state()).board,before.board,'Card inspection does not consume');
    const seen=[];
    for(let i=0;i<before.board.length;i++){
      if(i)await control('Next sleeve card').click();
      selected=await card();assert.equal(selected.key,`sleeve-viewer:${before.board[i].id}`);
      assert.match(await viewer().locator('.ff-sleeve-index').innerText(),new RegExp(`${i+1} of 5`));
      assert.ok((await viewer().locator('.ff-sleeve-description').innerText()).length>20);
      seen.push(await viewer().locator('.ff-sleeve-family').innerText());
      await page.waitForTimeout(spec.name==='desktop'?1100:100);
      const bounds=await viewer().evaluate(root=>{
        const selectors=['.ff-sleeve-header','.ff-sleeve-showcase','.ff-sleeve-card','.ff-sleeve-arrow','.ff-sleeve-details'];
        return {width:innerWidth,height:innerHeight,items:selectors.flatMap(selector=>[...root.querySelectorAll(selector)].map(el=>{
          const r=el.getBoundingClientRect();return {selector,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};
        }))};
      });
      for(const b of bounds.items){
        assert.ok(b.width>0&&b.height>0,`${spec.name}: ${b.selector} has visible bounds`);
        assert.ok(b.x>=-1&&b.y>=-1&&b.right<=bounds.width+1&&b.bottom<=bounds.height+1,`${spec.name}: ${b.selector} stays within viewport: ${JSON.stringify(b)}`);
        if(b.selector==='.ff-sleeve-details')assert.ok(b.scrollWidth<=b.clientWidth+1,`${spec.name}: description has no horizontal clipping`);
      }
      await page.screenshot({path:join(OUT,`${spec.name}-card-${i+1}.png`)});
    }
    assert.equal(await control('Next sleeve card').isDisabled(),true);
    assert.deepEqual((await state()).board,before.board);
    assert.equal(new Set(seen).size,4,'Standard, minor, parody, major families');
    check('Four families and duplicate faces navigated by unique ID; inspection never consumes; ends disabled');
    const clock=await state();await page.waitForTimeout(650);const later=await state();
    assert.ok(later.time>clock.time&&later.fxTime>clock.fxTime);check('Simulation and effect clocks continue');
    // Double dispatched clicks exercise the explicit synchronous pending guard.
    await page.evaluate(()=>{const a=window.flaghack,submit=a.submit.bind(a);window.__sleeveCheats=0;a.submit=cmd=>{if(cmd.t==='frickFrack'&&cmd.action==='cheat')window.__sleeveCheats++;return submit(cmd);};});
    await control('Play Card').evaluate(e=>{e.click();e.click();});
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sideboards[0].length===4);
    assert.ok((await state()).arcana?.strength,'Real Major Arcana effect applied');
    assert.equal(await page.evaluate(()=>window.__sleeveCheats),1,'Double click submits exactly one gameplay command');
    assert.equal((await state()).board.filter(c=>c.arcana===8).length,0);
    await card();check('Play Card consumes exactly once and selection reconciles');
    await page.keyboard.press('ArrowLeft');assert.equal((await card()).key,`sleeve-viewer:${before.board[2].id}`);
    await page.keyboard.press('Escape');await viewer().waitFor({state:'detached'});
    assert.equal(await page.locator('[data-action="sleeve"]').evaluate(e=>e===document.activeElement),true);
    assert.deepEqual(await geometry(),table);check('Keyboard navigation/Escape restore Sleeve focus and table geometry');
    await open();await control('Close sleeve and return to table').click();await viewer().waitFor({state:'detached'});
    assert.equal(await page.locator('[data-action="sleeve"]').evaluate(e=>e===document.activeElement),true);
    await inventory('single');await open();await card();
    assert.equal(await control('Previous sleeve card').isDisabled(),true);assert.equal(await control('Next sleeve card').isDisabled(),true);
    assert.equal(await control('Play Card').isDisabled(),true,'Already active Strength explains unavailable play');
    assert.match(await viewer().innerText(),/already active/i);
    await inventory('empty');await page.waitForFunction(()=>document.querySelector('.ff-sleeve-index')?.textContent?.includes('No cards'));
    await page.waitForFunction(()=>!window.flaghack.renderer.frickScene.snapshot().cards.some(c=>c.key.startsWith('sleeve-viewer:')));
    assert.equal(await control('Previous sleeve card').isDisabled(),true);assert.equal(await control('Next sleeve card').isDisabled(),true);
    check('Single/empty/dynamic inventory and illegal active effect handled without stale mesh');
    await page.screenshot({path:join(OUT,`${spec.name}-empty.png`)});
    await page.evaluate(()=>window.dispatchEvent(new Event('fh-menu-back',{cancelable:true})));
    await viewer().waitFor({state:'detached'});
    await inventory();await open();await card();
    await page.evaluate(()=>{const w=window.flaghack.world,a=w.avatarOf(0);a.hp=0;a.koUntil=w.time+6;});
    await page.locator('.ff-overlay').waitFor({state:'hidden'});
    await page.waitForFunction(()=>!window.flaghack.renderer.frickScene.snapshot().active);
    assert.equal(await viewer().count(),0);check('Back closes viewer; KO clears both viewer and engine without pausing world');
    assert.deepEqual(entry.errors,[]);entry.completed=true;
  }catch(e){entry.error=e.stack||String(e);entry.failureState=await state().catch(()=>null);await page.screenshot({path:join(OUT,`${spec.name}-failure.png`)}).catch(()=>{});throw e;}
  finally{if(page&&!page.isClosed())entry.videoPath=await page.video()?.path();await context.close();}
}
async function cleanDemo(url){
  const spec=specs[0],context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,recordVideo:{dir:join(OUT,'clean-demo'),size:{width:1280,height:800}}});
  const demo={recordingSpeed:1,marks:[],fixtureDisclosure:results.fixtureDisclosure};results.demo=demo;
  const started=Date.now(),mark=label=>demo.marks.push({label,seconds:(Date.now()-started)/1000});
  try{
    await enter(context,spec,url);await inventory();mark('ready');await page.waitForTimeout(800);
    mark('one-press-deal');await deal();await page.waitForTimeout(1200);
    mark('open-sleeve');await open();await card();await page.waitForTimeout(1800);
    for(let i=1;i<5;i++){mark(`next-card-${i+1}`);await control('Next sleeve card').click();await card();await page.waitForTimeout(1800);}
    mark('explicit-play-strength');await control('Play Card').click();
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sideboards[0].length===4);await page.waitForTimeout(1500);
    mark('return-to-table');await control('Close sleeve and return to table').click();await page.waitForTimeout(1500);mark('end');
  }finally{demo.videoPath=await page.video()?.path();await context.close();}
}
async function main(){
  mkdirSync(OUT,{recursive:true});await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}${PROJECT}`;
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  try{for(const spec of specs)await scenario(spec,url);await cleanDemo(url);results.completed=true;}
  catch(e){results.error=e.stack||String(e);throw e;}
  finally{writeFileSync(join(OUT,'result.json'),JSON.stringify(results,null,2));await browser.close();server.close();}
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
