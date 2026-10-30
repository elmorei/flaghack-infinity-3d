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
const OUT = resolve(HERE, '../host-release/frick-animation-smoke');
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
  const results={completed:false,stagedPublicCards:true,scenarios:[]};
  try {
    for(const spec of specs){
      const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},reducedMotion:spec.reduced?'reduce':'no-preference',recordVideo:spec.name==='desktop'?{dir:join(OUT,'video'),size:{width:1280,height:900}}:undefined});
      const page=await context.newPage(), entry={name:spec.name,checks:[],errors:[]}; results.scenarios.push(entry);
      page.on('pageerror',error=>entry.errors.push(error.message));
      const check=label=>{entry.checks.push(label);console.log('PASS '+spec.name+' '+label);};
      await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
      if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
      await page.locator('#startup').waitFor({state:'detached'});
      await page.evaluate(()=>window.flaghack.startMatch({seed:'frick-picnic-animation-qa',humans:[0],rtsFactions:[],match:{...window.flaghack.session.settings.match,active:[0],bossMode:false,days:3}}));
      await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world?.frickFrack?.wizardId>=0);
      const stage=async mode=>page.evaluate(mode=>{
        const w=window.flaghack.world, ff=w.frickFrack;
        const c=(id,rank=3,suit=0)=>({id,rank,suit});
        if(mode==='empty')ff.sessions[0]={id:9100,revision:1,faction:0,phase:'betting',dialogueIndex:0,dialogueStartedAt:0,readyAt:0,wager:0,player:[],dealer:[],result:null,message:''};
        const s=ff.sessions[0];
        if(mode==='deal'){Object.assign(s,{revision:s.revision+1,phase:'playing',wager:1,player:[c(9101,4,1),{...c(9102,2,0),tarot:true}],dealer:[c(9103,5,3),null],revealedCardOrder:[9101,9103,9102]});}
        if(mode==='hit'){s.revision++;s.player.push(c(9104,2,2));s.revealedCardOrder.push(9104);}
        if(mode==='refresh')s.revision++;
        if(mode==='reveal'){s.revision++;s.dealer=[c(9103,5,3),c(9105,7,0)];s.revealedCardOrder.push(9105);}
        if(mode==='defeat'){s.revision++;s.player=s.player.filter(c=>c.id!==9104);s.defeated=[{side:'player',card:c(9104,2,2)}];}
        if(mode==='close')delete ff.sessions[0];
      },mode);
      await stage('empty');
      await page.locator('.ff-hands').waitFor({state:'visible'});
      assert.equal(await page.locator('.ff-deck-card').count(),1);check('picnic blanket and visible deck');
      await stage('deal');
      await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===4);
      const start=await page.evaluate(()=>({animations:document.querySelector('.ff-hands').getAnimations({subtree:true}).length,hidden:document.querySelector('.ff-card-back')?.getAttribute('data-card-id'),hiddenArt:document.querySelector('.ff-card-back img')!==null}));
      assert.equal(start.hidden,null);assert.equal(start.hiddenArt,false);
      if(spec.reduced)assert.equal(start.animations,0);else assert(start.animations>0);
      check('opening deal and hidden-card privacy');
      await page.screenshot({path:join(OUT,spec.name+'-deal.png'),animations:'allow'});
      await page.waitForTimeout(160);
      await stage('refresh');
      await page.waitForTimeout(1000);
      assert.equal(await page.locator('.ff-hands').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
      check('revision rerender does not restart deal');
      await page.screenshot({path:join(OUT,spec.name+'-settled.png'),animations:'allow'});
      await stage('hit');
      await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===5);
      if(!spec.reduced){assert(await page.locator('[data-card-id="9104"]').evaluate(el=>el.getAnimations().length)>0);assert.equal(await page.locator('[data-card-id="9101"]').evaluate(el=>el.getAnimations().length),0);}
      await page.waitForTimeout(900);check('only new hit animates');
      await stage('reveal');
      await page.waitForFunction(()=>document.querySelector('[data-card-id="9105"]'));
      if(!spec.reduced)assert(await page.locator('[data-card-id="9105"]').evaluate(el=>el.getAnimations().length)>0);
      await page.waitForTimeout(450);check('authoritative hole-card reveal flips');
      await stage('defeat');
      await page.waitForFunction(()=>document.querySelector('.ff-card-defeated'));
      assert.equal(await page.locator('.ff-defeated-cross').innerText(),'X');check('defeated card stays visible and marked');
      await page.screenshot({path:join(OUT,spec.name+'-defeated.png'),animations:'allow'});
      const layout=await page.locator('.ff-hands').evaluate(el=>({width:el.getBoundingClientRect().width,viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert(layout.width<=layout.viewport);assert(layout.scroll<=layout.viewport+1);check('no horizontal viewport overflow');
      await stage('empty');await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===0);
      await stage('deal');await page.waitForFunction(()=>document.querySelectorAll('.ff-card-slot').length===4);
      await stage('close');await page.waitForFunction(()=>document.querySelector('.ff-overlay').classList.contains('is-off'));
      assert.equal(await page.locator('.ff-overlay').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);check('exit cancels in-flight animation');
      assert.deepEqual(entry.errors,[]);
      await context.close();
    }
    results.completed=true;
  } finally {writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));await browser.close();server.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;server.close();});
