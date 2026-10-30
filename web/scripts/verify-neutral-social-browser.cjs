'use strict';
/** Production renderer on a staged, frozen local match. No shader or marker replacements. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { chromium } = require('playwright');
const DIST = resolve(__dirname, '../dist'), OUT = resolve(__dirname, '../host-release/neutral-social');
const PROJECT = '/flaghack-infinity-3d/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req,res) => {
  const path = new URL(req.url,'http://localhost').pathname;
  const file = resolve(DIST, decodeURIComponent(path.slice(PROJECT.length)) || 'index.html');
  if (!path.startsWith(PROJECT) || !file.startsWith(DIST+'/')) { res.writeHead(404); res.end(); return; }
  let body; try { body=readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}); res.end(body);
});
async function main() {
  mkdirSync(OUT,{recursive:true}); await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  const context=await browser.newContext({viewport:{width:1200,height:800},hasTouch:true,isMobile:true,deviceScaleFactor:1,userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'});
  const page=await context.newPage(), result={checks:[],errors:[],scenarios:[],completed:false,physicalDeviceTest:false};
  page.on('pageerror',e=>result.errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
    if(await page.locator('#startup').count()) await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
    await page.locator('#startup').waitFor({state:'detached'});
    await page.evaluate(()=>{ const a=window.flaghack; a.startMatch({seed:'native-capture-faction-colors',humans:[0,1,2,3],rtsFactions:[0,1,2,3],match:{...a.session.settings.match,active:[0,1,2,3],bossMode:false,days:3}}); });
    await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.session.view==='command');
    await page.waitForTimeout(1500);
    const fixture=await page.evaluate(()=>{
      const a=window.flaghack,w=a.world,s=a.session;
      window.__socialSim=a.sim;a.sim=null;a.ai.clear();
      w.hippies.clear();
      for(const b of w.buildings.values())if(b.kind==='gcc')b.disabled=true;
      const home=w.hearthOf(0);
      const facets=w.lattice.facets.filter(f=>!f.boundary && w.nav.isWalkable(f.cx,f.cz));
      facets.sort((a,b)=>Math.hypot(a.cx-home.pos.x-20,a.cz-home.pos.z)-Math.hypot(b.cx-home.pos.x-20,b.cz-home.pos.z));
      const c=window.fh.factory.spawnBuilding(w,'drumcircle',0,facets[0].id,1);
      window.fh.buildings.registerBuildingShape(w,c);
      const ids=[];
      for(let i=0;i<20;i++){
        const angle=i*Math.PI*2/20,p=w.nav.nearestWalkable(c.pos.x+Math.cos(angle)*12,c.pos.z+Math.sin(angle)*12);
        ids.push(window.fh.factory.spawnHippie(w,-1,p).id);
      }
      window.__socialQa={circle:c.id,ids};
      s.camera.cmdX=c.pos.x;s.camera.cmdZ=c.pos.z;s.view='command';s.viewBlend=1;
      a.controls.rig.setMode('play',0);a.controls.rig.snapCommand(s.camera);
      return {circle:c.id,pos:c.pos,ids};
    });
    for(const seconds of [0,10,20,40]){
      const sample=await page.evaluate(seconds=>{
        const a=window.flaghack,w=a.world,q=window.__socialQa;
        for(let i=0;i<seconds*60;i++)window.__socialSim.step();
        w.drainEvents();
        return {time:w.time,people:q.ids.map(id=>{const h=w.hippies.get(id);return {id,faction:h.faction,x:h.pos.x,z:h.pos.z,status:h.status,task:h.brain.mind?.task,px:h.brain.mind?.px,pz:h.brain.mind?.pz};})};
      },seconds);
      await page.waitForTimeout(500);
      sample.filename=`social-${Math.round(sample.time)}s.png`;
      await page.screenshot({path:join(OUT,sample.filename),animations:'disabled'});
      result.scenarios.push(sample);
    }
    const first=result.scenarios[0].people,last=result.scenarios.at(-1).people;
    const moved=last.filter(h=>{const old=first.find(o=>o.id===h.id);return Math.hypot(h.x-old.x,h.z-old.z)>3;});
    assert.ok(moved.length>=8,'Crowd circulates through actual simulation instead of remaining parked');
    assert.equal(last.length,20,'Fixture preserves the existing population');
    result.fixture=fixture;result.checks.push(`${moved.length}/20 original visitors moved over 3 metres in natural simulation`);
    assert.deepEqual(result.errors,[]);result.completed=true;
  } catch(e){ result.error=e.stack||String(e);await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});throw e; }
  finally {writeFileSync(join(OUT,'result.json'),JSON.stringify(result,null,2));await browser.close();server.close();}
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
