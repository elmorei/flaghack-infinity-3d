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
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/frick-engine-smoke');
const PROJECT='/flaghack-infinity-3d/';
const DIAGNOSTIC=process.env.ENGINE_DIAGNOSTIC==='1';
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
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Staged betting session, resources, seed and Sun card. Real production Deal/Hit/Sun/Stand/Again/Exit commands. Normal-speed browser video.',checks:[],scenarios:[]};
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
async function armMetrics(name,diagnostic=false){
  await page.evaluate(({name,diagnostic})=>{
    const q={name,start:null,last:null,gaps:[],raw:[],visibility:[],longTasks:[],loaf:[],done:false};window.__enginePerf=q;
    let long,loaf;
    try{long=new PerformanceObserver(list=>{for(const e of list.getEntries())if(q.start!==null&&e.startTime>=q.start&&e.startTime<=q.start+650)q.longTasks.push({start:e.startTime-q.start,duration:e.duration});});long.observe({type:'longtask',buffered:false});}catch{}
    try{loaf=new PerformanceObserver(list=>{for(const e of list.getEntries())if(q.start!==null&&e.startTime>=q.start&&e.startTime<=q.start+650)q.loaf.push({start:e.startTime-q.start,duration:e.duration,blockingDuration:e.blockingDuration,...(diagnostic?{renderStart:e.renderStart,styleAndLayoutStart:e.styleAndLayoutStart,scripts:Array.from(e.scripts??[],s=>({sourceURL:s.sourceURL,sourceFunctionName:s.sourceFunctionName,invoker:s.invoker,duration:s.duration,forcedStyleAndLayoutDuration:s.forcedStyleAndLayoutDuration}))}:{})});});loaf.observe({type:'long-animation-frame',buffered:false});}catch{}
    const start=()=>{q.start=performance.now();q.last=q.start;requestAnimationFrame(tick);};
    function finish(){long?.disconnect();loaf?.disconnect();document.removeEventListener('visibilitychange',visibility);q.done=true;}
    function visibility(){q.visibility.push({at:performance.now()-q.start,state:document.visibilityState});}
    if(diagnostic)document.addEventListener('visibilitychange',visibility);
    function tick(now){if(q.start===null)return;const elapsed=now-q.start;q.gaps.push(now-q.last);if(diagnostic)q.raw.push({raf:now-q.start,callback:performance.now()-q.start,gap:now-q.last});q.last=now;if(elapsed<650)requestAnimationFrame(tick);else if(diagnostic)setTimeout(finish,300);else finish();}
    document.querySelector('.ff-overlay').addEventListener('pointerdown',start,{once:true,capture:true});
  },{name,diagnostic});
}
async function metrics(){
  await page.waitForFunction(()=>window.__enginePerf?.done,null,{timeout:15000});
  return page.evaluate(()=>{const q=window.__enginePerf,g=[...q.gaps].sort((a,b)=>a-b);return{name:q.name,activeWindowMs:650,gapDefinition:'rAF intervals intersecting the active 650ms window, including a closing long interval',frames:g.length,maxGapMs:g.at(-1)??null,p95GapMs:g.length?g[Math.min(g.length-1,Math.ceil(g.length*.95)-1)]:null,longTasks:q.longTasks,loaf:q.loaf,...(q.raw.length?{raw:q.raw,visibility:q.visibility}: {})};});
}
async function ensureSettled(){await page.waitForTimeout(850);}
async function verify(spec,url){
  const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},hasTouch:spec.touch,isMobile:spec.touch,userAgent:spec.touch?ANDROID:DESKTOP,deviceScaleFactor:1,reducedMotion:spec.reduced?'reduce':'no-preference'});
  const entry={name:spec.name,errors:[],metrics:[],requests:[]};results.scenarios.push(entry);
  try{
    await enter(context,spec,url);
    page.on('pageerror',e=>entry.errors.push(e.message));
    page.on('request',r=>{if(/\/cards\//.test(r.url()))entry.requests.push(r.url());});
    const initial=await state();
    assert.equal(initial.snapshot.active,true,'Actual engine table active');
    assert.ok(initial.gpuCalls>0,'Shared renderer issues real draw calls');
    await armMetrics('opening-deal');await act('Deal hand',spec);
    await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='playing');
    entry.metrics.push(await metrics());await ensureSettled();
    const dealt=await state();entry.dealt=dealt;
    assert.equal(dealt.session.dealer[1],null,'Hole card remains public null');
    assert.ok(dealt.snapshot.cards.length>=4,'Actual engine card meshes exist');
    assert.ok(dealt.snapshot.meshCount>=dealt.snapshot.cards.length*2,'Faces and backs are actual scene meshes');
    if(spec.reduced)assert.ok(dealt.snapshot.cards.every(c=>c.animationProgress===1),'Reduced motion settles all meshes immediately');
    assert.equal(dealt.snapshot.cards.filter(c=>c.hidden).length,1,'Exactly one hidden engine card');
    for(const c of dealt.snapshot.cards.filter(c=>c.hidden)){assert.equal(c.faceUp,false);assert.ok(c.textureKey==='hidden','Hidden card contains no face artwork identity');}
    assert.equal(await page.locator('.ff-hands img').count(),0,'Cards are not HTML artwork images');
    assert.ok(dealt.time>initial.time&&dealt.fxTime>initial.fxTime,'Simulation and effect clocks continue');
    assert.ok(dealt.snapshot.drawCount>initial.snapshot.drawCount,'Engine table draws while authoritative simulation advances');
    for(const c of dealt.snapshot.cards){assert.ok(Number.isFinite(c.x)&&Number.isFinite(c.y));assert.ok(c.width>0&&c.height>0);}
    const picked=await page.evaluate(()=>{const scene=window.flaghack.renderer.frickScene;return scene.snapshot().cards.filter(c=>c.visible&&c.y>0&&c.y<innerHeight&&c.x>0&&c.x<innerWidth).map(c=>({key:c.key,picked:scene.pick(c.x,c.y)}));});
    assert.ok(picked.length>0,'Visible meshes available for pointer picking');
    for(const p of picked)assert.equal(p.picked,p.key,'Raycast selects actual card at its engine center');
    await page.screenshot({path:join(OUT,spec.name+'-engine-deal.png')});
    check(spec.name+': actual shared WebGL cards, hidden-card privacy, live simulation/effect clocks');
    const prior=dealt.revision;await armMetrics('hit');await act('Hit',spec);
    await page.waitForFunction(r=>window.flaghack.world.frickFrack.sessions[0]?.revision>r,prior);
    entry.metrics.push(await metrics());await ensureSettled();
    const hit=await state();entry.hit=hit;
    assert.ok(hit.session.defeated?.length,'Seeded real Hit produces actual CCG combat');
    assert.ok(hit.snapshot.cards.some(c=>c.defeated),'Engine retains defeated card with marker');
    await page.screenshot({path:join(OUT,spec.name+'-engine-defeated.png')});
    if(spec.name==='desktop'){
      await page.locator('.ff-sideboard summary').click({noWaitAfter:true});
      await act('Inspect The Sun',spec);await act('Use The Sun',spec);
      await page.waitForFunction(()=>!window.flaghack.world.frickFrack.sessions[0].dealer.includes(null));
      await ensureSettled();const revealed=await state();entry.revealed=revealed;
      assert.equal(revealed.snapshot.cards.filter(c=>c.hidden).length,0,'Production Sun effect reveals mesh identity only after authoritative reveal');
      assert.ok(revealed.snapshot.cards.every(c=>c.faceUp),'Known settled cards are face up');
      await page.locator('.ff-hand-dealer').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(OUT,'desktop-engine-reveal.png')});
      // Closing an expanded sleeve restores table layout before the remaining controls.
      if(await page.locator('.ff-sideboard').evaluate(e=>e.open))await page.locator('.ff-sideboard summary').click({noWaitAfter:true});
    }
    await act('Stand',spec);await page.waitForFunction(()=>['result','empty'].includes(window.flaghack.world.frickFrack.sessions[0]?.phase));
    if((await state()).phase==='result'){
      await act('Another hand',spec);await page.waitForFunction(()=>window.flaghack.world.frickFrack.sessions[0]?.phase==='betting');
      await ensureSettled();assert.equal((await state()).snapshot.cards.length,0,'New hand clears previous meshes');
      await act('Leave table',spec);
    }else await act('Return to the burn',spec);
    await page.locator('.ff-overlay').waitFor({state:'hidden'});await ensureSettled();
    const exited=await state();entry.exited=exited;
    assert.equal(exited.snapshot.active,false,'Exit releases engine scene');assert.ok(exited.gpuCalls>0,'World draws after table exit');
    check(spec.name+': real Hit combat, reveal/settlement/again/exit, no stale engine table');
    if(spec.name==='desktop'){
      await stageBetting();await page.waitForFunction(()=>window.flaghack.renderer.frickScene.snapshot().active && window.flaghack.renderer.frickScene.snapshot().backdropReady);
      await page.setViewportSize({width:844,height:390});await ensureSettled();assert.equal((await state()).snapshot.active,true);
      await page.evaluate(()=>{const w=window.flaghack.world,av=w.avatarOf(0);av.hp=0;av.koUntil=w.time+6;});
      await page.locator('.ff-overlay').waitFor({state:'hidden'});await ensureSettled();assert.equal((await state()).snapshot.active,false);
      check('desktop: resize and KO cleanup return world renderer');
    }
    assert.deepEqual(entry.errors,[],spec.name+' has no page errors');
  }catch(error){entry.error=error.stack||String(error);entry.failureState=await state().catch(()=>null);if(page&&!page.isClosed())await page.screenshot({path:join(OUT,spec.name+'-failure.png')}).catch(()=>{});throw error;}finally{await context.close();}
}
async function cleanDemo(url){
  const spec=specs[0],context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,userAgent:DESKTOP,recordVideo:{dir:join(OUT,'video'),size:{width:1280,height:800}}});
  const marks=[];const start=Date.now();
  try{
    await enter(context,spec,url);
    const mark=label=>marks.push({label,seconds:(Date.now()-start)/1000});
    // Use a separately staged public scene for clean demonstration, with no screenshots,
    // traces or frame-profiling observers running during the animation itself.
    mark('ready');await page.waitForTimeout(700);
    mark('deal');await act('Deal hand',spec);await page.waitForTimeout(1700);
    mark('hit');await act('Hit',spec);await page.waitForTimeout(1700);
    mark('sun-inspect');await page.locator('.ff-sideboard summary').click({noWaitAfter:true});await act('Inspect The Sun',spec);await page.waitForTimeout(600);
    mark('sun-reveal');await act('Use The Sun',spec);await page.waitForTimeout(700);
    if(await page.locator('.ff-sideboard').evaluate(e=>e.open))await page.locator('.ff-sideboard summary').click({noWaitAfter:true});
    await page.locator('.ff-hand-dealer').scrollIntoViewIfNeeded();await page.waitForTimeout(1700);
    mark('stand');await act('Stand',spec);await page.waitForTimeout(1600);mark('end');
    results.demo={marks,fixtureDisclosure:results.fixtureDisclosure,recordingSpeed:1,videoPath:await page.video().path()};
  }finally{await context.close();}
}
/** One focused attribution run; never mixed with the original QA/demo result. */
async function diagnosticRun(url){
  const report={completed:false,scope:'Two fresh-browser cold desktop baselines plus one separately instrumented cold desktop sample. No screenshots/video. Not a physical device test.',interpretation:'Fresh browser processes do not reset OS/driver caches. Attribution durations are inclusive/nested and must not be summed. GL calls measure CPU submission/blocking, not GPU elapsed time. Image request-to-load includes loading and is not decode-only timing.',samples:[]};
  try{
    for(const instrumented of [false,false,true]){
      browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
      const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,userAgent:DESKTOP});
      try{
        await enter(context,specs[0],url);
        if(instrumented)await page.evaluate(()=>{
          const a=window.flaghack,records=[];window.__engineAttribution=records;window.__engineWrapped=[];
          const save=(label,start,extra={})=>{const q=window.__enginePerf;if(q?.start!=null&&start>=q.start&&start<=q.start+650)records.push({label,start:start-q.start,duration:performance.now()-start,...extra});};
          const wrap=(object,key,label)=>{if(!object||typeof object[key]!=='function')return;window.__engineWrapped.push(label);const original=object[key];object[key]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{save(label,start);}};};
          wrap(a.sim,'step','simulation.step');wrap(a.ui,'update','ui.update');
          wrap(a.ui?.frickFrack,'render','table.dom-rebuild');wrap(a.ui?.frickFrack,'publishEngineView','table.layout-reads');
          wrap(a.renderer,'render','game.render');wrap(a.renderer.frickScene,'draw','table.draw-total');
          wrap(a.renderer.renderer,'render','three.render');
          wrap(CanvasRenderingContext2D.prototype,'drawImage','canvas.drawImage');
          const gl=a.renderer.renderer.getContext();
          for(const name of ['compileShader','linkProgram','texImage2D','texSubImage2D'])wrap(gl,name,'gl.'+name);
          // Image URLs here are requests already made by public renderer code; no deck inspection or preloading.
          const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
          if(descriptor?.set)Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(value){const started=performance.now();this.addEventListener('load',()=>save('image.request-to-load',started,{url:String(value),width:this.naturalWidth,height:this.naturalHeight}),{once:true});return descriptor.set.call(this,value);}});
        });
        await armMetrics('cold-opening-deal',true);await act('Deal hand',specs[0]);
        const sample={instrumented,metrics:await metrics()};
        sample.state=await state();
        assert.equal(sample.state.session.dealer[1],null,'Diagnostic does not reveal hole card');
        if(instrumented){sample.attribution=await page.evaluate(()=>window.__engineAttribution);sample.wrapped=await page.evaluate(()=>window.__engineWrapped);}
        report.samples.push(sample);
      }finally{await context.close();await browser.close();browser=null;}
    }
    report.completed=true;
  }catch(error){report.error=error.stack||String(error);throw error;}
  finally{writeFileSync(join(OUT,'diagnostic-result.json'),JSON.stringify(report,null,2));}
}
async function main(){
  mkdirSync(OUT,{recursive:true});await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}${PROJECT}`;results.url=url;
  if(DIAGNOSTIC){try{await diagnosticRun(url);}finally{server.close();}return;}
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  try{for(const spec of specs)await verify(spec,url);await cleanDemo(url);results.completed=true;}
  catch(error){results.error=error.stack||String(error);if(page&&!page.isClosed()){results.failureState=await state().catch(()=>null);await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});}throw error;}
  finally{writeFileSync(join(OUT,'result.json'),JSON.stringify(results,null,2));await browser.close();server.close();}
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
