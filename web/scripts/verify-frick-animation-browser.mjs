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
const OUT = process.env.FRICK_ANIMATION_OUT ? resolve(process.env.FRICK_ANIMATION_OUT) : resolve(HERE, '../host-release/frick-animation-smoke');
const BASELINE = process.env.FRICK_PACING_BASELINE === '1';
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
const specs=[{name:'desktop',width:1280,height:900},{name:'small-phone',width:320,height:640},{name:'landscape',width:844,height:390},{name:'reduced-motion',width:1280,height:900,reduced:true}];
async function main(){
  mkdirSync(OUT,{recursive:true});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true});
  const results={completed:false,stagedPublicCards:true,baseline:BASELINE,recordingNominalFps:25,scenarios:[]};
  let page;
  try {
    for(const spec of specs){
      const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},reducedMotion:spec.reduced?'reduce':'no-preference',recordVideo:spec.name==='desktop'?{dir:join(OUT,'video'),size:{width:1280,height:900}}:undefined});
      const pageCreatedWallMs=Date.now();
      page=await context.newPage(); const entry={name:spec.name,pageCreatedWallMs,checks:[],errors:[],pacing:[]}; results.scenarios.push(entry);
      page.on('pageerror',error=>entry.errors.push(error.message));
      const check=label=>{entry.checks.push(label);console.log('PASS '+spec.name+' '+label);};
      await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
      if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
      await page.locator('#startup').waitFor({state:'detached'});
      await page.evaluate(()=>window.flaghack.startMatch({seed:'frick-picnic-animation-qa',humans:[0],rtsFactions:[],match:{...window.flaghack.session.settings.match,active:[0],bossMode:false,days:3}}));
      await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world?.frickFrack?.wizardId>=0);
      await page.evaluate(()=>{
        const renderer=window.flaghack.renderer, original=renderer.render.bind(renderer);
        window.__ffRenderProbe={calls:0,updates:0};
        renderer.render=(...args)=>{window.__ffRenderProbe.updates++;const drew=original(...args);if(drew===true)window.__ffRenderProbe.calls++;return drew;};
      });
      // rAF reports actual main-thread presentation opportunities, not the video's
      // nominal FPS. Do not take screenshots during these windows: capture itself
      // can perturb pacing. Long-task/DOM counts expose work rather than assuming
      // that any repeated video frames come from the recorder.
      const startPacing=async label=>page.evaluate(label=>{
        const began=performance.now(), frames=[], longTasks=[], initialDraws=window.__ffRenderProbe.calls, initialUpdates=window.__ffRenderProbe.updates, initialWorldTime=window.flaghack.world.time, initialRenderTime=window.flaghack.renderer.ctx?.time;
        let raf=0, bodyReplacements=0, mutations=0, finished=false;
        const body=document.querySelector('.ff-body');
        const observer=new MutationObserver(records=>{
          mutations+=records.length;
          for(const record of records)if(record.target===body&&[...record.removedNodes].some(node=>node.nodeType===1&&node.matches('.ff-hands')))bodyReplacements++;
        });
        observer.observe(body,{childList:true,subtree:true});
        let taskObserver;
        if(PerformanceObserver.supportedEntryTypes.includes('longtask')){
          taskObserver=new PerformanceObserver(list=>{for(const task of list.getEntries())longTasks.push({start:task.startTime-began,duration:task.duration});});
          taskObserver.observe({type:'longtask',buffered:false});
        }
        const tick=time=>{frames.push({time:time-began,callbackLag:performance.now()-time});if(!finished)raf=requestAnimationFrame(tick);};
        raf=requestAnimationFrame(tick);
        window.__ffPacing={label,began,frames,longTasks,markers:[],done:new Promise(resolve=>setTimeout(()=>{
          finished=true;cancelAnimationFrame(raf);observer.disconnect();taskObserver?.disconnect();
          const summarize=limit=>{
            const subset=frames.filter(frame=>frame.time<=limit), intervals=subset.slice(1).map((frame,i)=>frame.time-subset[i].time), ordered=[...intervals].sort((a,b)=>a-b);
            const percentile=p=>ordered.length?ordered[Math.min(ordered.length-1,Math.ceil(ordered.length*p)-1)]:null;
            return {windowMs:limit,frames:subset.length,meanMs:intervals.length?intervals.reduce((a,b)=>a+b,0)/intervals.length:null,p50Ms:percentile(.5),p95Ms:percentile(.95),maxMs:ordered.at(-1)??null,over25Ms:intervals.filter(n=>n>25).length,over50Ms:intervals.filter(n=>n>50).length};
          };
          resolve({label,elapsedMs:performance.now()-began,renderCalls:window.__ffRenderProbe.calls-initialDraws,renderUpdateCalls:window.__ffRenderProbe.updates-initialUpdates,renderClockAdvancedSeconds:initialRenderTime==null?null:window.flaghack.renderer.ctx.time-initialRenderTime,simulationAdvancedSeconds:window.flaghack.world.time-initialWorldTime,activeWindow:summarize(650),fullWindow:summarize(1200),frames,longTasks,bodyReplacements,mutationRecords:mutations,markers:window.__ffPacing.markers});
        },1200))};
      },label);
      const finishPacing=async()=>{const metric=await page.evaluate(()=>window.__ffPacing.done);entry.pacing.push(metric);console.log('PACING '+spec.name+' '+JSON.stringify(metric));};
      await page.evaluate(()=>{window.__ffStage=mode=>{
        if(window.__ffPacing)window.__ffPacing.markers.push({mode,time:performance.now()-window.__ffPacing.began});
        const w=window.flaghack.world, ff=w.frickFrack;
        const c=(id,rank=3,suit=0)=>({id,rank,suit});
        if(mode==='empty'){
          const av=w.avatarOf(0),wizard=w.hippies.get(ff.wizardId);
          wizard.pos={x:av.pos.x,z:av.pos.z+1};wizard.vel={x:0,z:0};wizard.hp=100;wizard.koUntil=0;wizard.status='idle';delete wizard.airborne;
          ff.sessions[0]={id:9100,revision:1,faction:0,phase:'betting',dialogueIndex:0,dialogueStartedAt:0,readyAt:0,wager:0,player:[],dealer:[],result:null,message:''};
        }
        const s=ff.sessions[0];
        if(mode==='deal'){Object.assign(s,{revision:s.revision+1,phase:'playing',wager:1,player:[c(9101,4,1),{...c(9102,2,0),tarot:true}],dealer:[c(9103,5,3),null],revealedCardOrder:[9101,9103,9102]});}
        if(mode==='hit'){s.revision++;s.player.push({...c(9104,2,2),parody:0});s.revealedCardOrder.push(9104);}
        if(mode==='refresh')s.revision++;
        if(mode==='reveal'){s.revision++;s.dealer=[c(9103,5,3),c(9105,7,0)];s.revealedCardOrder.push(9105);}
        if(mode==='defeat'){s.revision++;s.player=s.player.filter(c=>c.id!==9104);s.defeated=[{side:'player',card:{...c(9104,2,2),parody:0}}];}
        if(mode==='close')delete ff.sessions[0];
      };});
      const stage=async mode=>page.evaluate(mode=>window.__ffStage(mode),mode);
      await stage('empty');
      await page.locator('.ff-hands').waitFor({state:'visible'});
      assert.equal(await page.locator('.ff-deck-card').count(),1);check('picnic blanket and visible deck');
      await startPacing('opening-deal-with-revision-refresh');
      await stage('deal');
      await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===4);
      const start=await page.evaluate(()=>({animations:document.querySelector('.ff-hands').getAnimations({subtree:true}).length,hidden:document.querySelector('.ff-card-slot .ff-card-back')?.getAttribute('data-card-id'),hiddenArt:document.querySelector('.ff-card-slot .ff-card-back img')!==null}));
      assert.equal(start.hidden,null);assert.equal(start.hiddenArt,false);
      if(spec.reduced)assert.equal(start.animations,0);else assert(start.animations>0);
      check('opening deal and hidden-card privacy');
      await page.waitForTimeout(160);
      await stage('refresh');
      await finishPacing();
      const remainingAnimations=await page.locator('.ff-hands').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length);
      entry.remainingAnimationsAfterOpening=remainingAnimations;
      if(!BASELINE)assert.equal(remainingAnimations,0);
      check('revision rerender does not restart deal');
      await page.screenshot({path:join(OUT,spec.name+'-settled.png'),animations:'allow'});
      await startPacing('new-hit');
      await stage('hit');
      await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===5);
      if(!spec.reduced&&!BASELINE){assert(await page.locator('[data-card-id="9104"]').evaluate(el=>el.getAnimations().length)>0);assert.equal(await page.locator('[data-card-id="9101"]').evaluate(el=>el.getAnimations().length),0);}
      await finishPacing();check('only new hit animates');
      const hitPacing=entry.pacing.at(-1);
      assert(hitPacing.simulationAdvancedSeconds>0,'opaque table must not pause simulation');
      assert(hitPacing.renderUpdateCalls>0,'opaque table must keep renderer effects/modules updating');
      if(hitPacing.renderClockAdvancedSeconds!==null)assert(hitPacing.renderClockAdvancedSeconds>0,'opaque table must keep renderer clock advancing');
      if(!BASELINE)assert.equal(hitPacing.renderCalls,0,'fully opaque stable table should skip invisible world drawing');
      check(BASELINE?'simulation advances under table (baseline draw count recorded)':'simulation advances while invisible world drawing is suppressed');
      await stage('reveal');
      await page.waitForFunction(()=>document.querySelector('[data-card-id="9105"]'));
      if(!spec.reduced&&!BASELINE)assert(await page.locator('[data-card-id="9105"]').evaluate(el=>el.getAnimations().length)>0);
      await page.waitForTimeout(450);check('authoritative hole-card reveal flips');
      await stage('defeat');
      await page.waitForFunction(()=>document.querySelector('.ff-card-defeated'));
      assert.equal(await page.locator('.ff-defeated-cross').innerText(),'X');check('defeated card stays visible and marked');
      await page.screenshot({path:join(OUT,spec.name+'-defeated.png'),animations:'allow'});
      const slotSizes=await page.locator('.ff-card-slot').evaluateAll(slots=>slots.map(slot=>{const a=slot.getBoundingClientRect(),b=slot.querySelector('.ff-card').getBoundingClientRect();return{slotWidth:a.width,slotHeight:a.height,cardWidth:b.width,cardHeight:b.height};}));
      assert(slotSizes.every(s=>s.cardWidth<=s.slotWidth+.5&&s.cardHeight<=s.slotHeight+.5));check('mixed card families fit their layout slots');
      const layout=await page.locator('.ff-hands').evaluate(el=>({width:el.getBoundingClientRect().width,viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert(layout.width<=layout.viewport);assert(layout.scroll<=layout.viewport+1);check('no horizontal viewport overflow');
      // Resize while occluded; then closing must resume drawing at the new size.
      const resized={width:spec.width-17,height:spec.height-19};
      await page.setViewportSize(resized);
      await stage('empty');await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===0);
      await stage('deal');await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===4);
      const beforeCloseDraws=await page.evaluate(()=>window.__ffRenderProbe.calls);
      await stage('close');await page.waitForFunction(()=>document.querySelector('.ff-overlay').classList.contains('is-off'));
      await page.waitForFunction(before=>window.__ffRenderProbe.calls>before,beforeCloseDraws);
      const canvasSize=await page.evaluate(()=>{const app=window.flaghack,rect=app.renderer.renderer.domElement.getBoundingClientRect();return{width:rect.width,height:rect.height,aspect:app.renderer.camera.aspect};});
      assert(Math.abs(canvasSize.width-resized.width)<1&&Math.abs(canvasSize.height-resized.height)<1);
      assert(Math.abs(canvasSize.aspect-resized.width/resized.height)<.01);
      check('world drawing resumes after close and uses resized viewport');
      await page.setViewportSize({width:spec.width,height:spec.height});
      assert.equal(await page.locator('.ff-overlay').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);check('exit cancels in-flight animation');
      // A real KO invalidates the authoritative session; the canvas cannot remain
      // frozen just because the UI has not processed that transition yet.
      await stage('empty');await page.waitForFunction(()=>document.querySelector('.ff-overlay:not(.is-off) .ff-hands')&&document.querySelectorAll('.ff-card-slot').length===0);
      await stage('deal');await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===4);
      const beforeKoDraws=await page.evaluate(()=>{const app=window.flaghack;app.world.avatarOf(0).koUntil=app.world.time+10;return window.__ffRenderProbe.calls;});
      await page.waitForFunction(before=>document.querySelector('.ff-overlay').classList.contains('is-off')&&window.__ffRenderProbe.calls>before,beforeKoDraws);
      check('KO closes table and resumes world drawing');
      await page.evaluate(()=>{const avatar=window.flaghack.world.avatarOf(0);avatar.koUntil=0;avatar.hp=100;});
      assert.deepEqual(entry.errors,[]);
      if(!BASELINE&&spec.name==='desktop'){
        // Separate clean demonstration: real-speed page-side timing, no screenshot,
        // assertion RPC, or deliberate revision rerender during animation. The
        // simulation/render loop and normal recording continue unchanged.
        entry.demo=await page.evaluate(async()=>{
          const startedWallMs=Date.now(),began=performance.now(),phases=[];
          const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          const show=mode=>{phases.push({mode,elapsedMs:performance.now()-began,wallMs:Date.now()});window.__ffStage(mode);};
          show('empty');await wait(500);
          show('deal');await wait(1200);
          show('hit');await wait(1000);
          show('reveal');await wait(700);
          show('defeat');await wait(1100);
          return{startedWallMs,endedWallMs:Date.now(),elapsedMs:performance.now()-began,phases};
        });
        console.log('DEMO '+JSON.stringify(entry.demo));
      }
      await context.close();
    }
    results.completed=true;
  } catch(error) {
    results.failure=String(error.stack||error);
    if(page&&!page.isClosed()){await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});results.failureState=await page.evaluate(()=>({screen:window.flaghack?.session.screen,table:window.flaghack?.world?.frickFrack.sessions[0]})).catch(()=>null);}
    throw error;
  } finally {writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));await browser.close();server.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;server.close();});
