/** Native Chrome mobile HUD QA. Explicit fixtures stage public camp state;
 * menu navigation uses real browser touch input. Raw video is 1x speed.
 * Mobile cases are browser-emulated, not physical-device certification. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), {chromium}=require('playwright');
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/mobile-hud-smoke');
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
const MOBILE_UA='Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Real local Degen matches; resources, clock and altar ownership are staged for visibility. Menu buttons use browser taps. Camera locations are staged for deterministic direction checks.',scenarios:[]};
let browser,page;
const specs=[{name:'phone-portrait',width:390,height:844},{name:'small-phone',width:320,height:568},{name:'phone-landscape',width:844,height:390}];
async function geometry(){return page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom,overflow:e.scrollWidth>e.clientWidth+1};};
  return {width:innerWidth,height:innerHeight,resources:rect(document.querySelector('.mc-resources .res')),timing:rect(document.querySelector('.mc-timing')),buttons:[...document.querySelectorAll('.mc-top button')].map(rect),reserved:[...document.querySelectorAll('.mc-status-left,.mc-resources,.mc-modes,.mc-selected:not(.is-off),.mc-placement:not(.is-off),.mc-alert:not(.is-off),.mc-pickup:not(.is-off)')].map(rect).filter(r=>r.w&&r.h),rows:[...document.querySelectorAll('.mc-resources .res-row,.mc-resources .attn')].map(e=>({text:e.textContent,...rect(e)})),arrows:[...document.querySelectorAll('.mc-altar-arrow')].map(e=>({id:Number(e.dataset.altarId??e.dataset.bossId),kind:e.dataset.targetKind,allegiance:e.dataset.allegiance,cx:parseFloat(e.style.left),cy:parseFloat(e.style.top),color:e.style.color,expectedColor:(()=>{const b=window.flaghack.world.buildings.get(Number(e.dataset.altarId)),n=document.createElement('i');n.style.color=e.dataset.targetKind==='boss'?'#fff0d0':window.flaghack.world.factions[b.faction].css;return n.style.color;})(),pointer:getComputedStyle(e).pointerEvents,...rect(e)}))};
});}
function checkLayout(g){
  assert.ok(g.resources.x+g.resources.w/2>g.width/2,'Camp resources occupy upper right');
  assert.ok(g.resources.y>=0&&g.resources.right<=g.width&&g.resources.bottom<g.height/2,'Camp resources stay inside viewport');
  assert.equal(g.rows.length,5,'Camp stock, lumber, ritual, signifiers and attention are all present');
  for(const r of [g.resources,g.timing,...g.rows,...g.buttons,...g.arrows])assert.ok(r.x>=-1&&r.y>=-1&&r.right<=g.width+1&&r.bottom<=g.height+1,JSON.stringify(r));
  assert.ok(g.buttons.every(r=>r.h>=44),'Touch controls retain 44px targets');
  assert.ok(g.rows.every(r=>!r.overflow),'Camp labels and values do not overflow');
  assert.ok(g.arrows.length>0,'Offscreen enemy altars have arrows');
  for(const r of g.arrows){assert.ok(Math.min(Math.abs(r.cx-20),Math.abs(r.cx-(g.width-20)),Math.abs(r.cy-20),Math.abs(r.cy-(g.height-20)))<.05,'Arrow center remains on the exact safe perimeter');assert.equal(r.pointer,'none');assert.equal(r.color,r.expectedColor,'Arrow uses the live owner color');for(const o of g.reserved)assert.ok(r.right<=o.x||r.x>=o.right||r.bottom<=o.y||r.y>=o.bottom,'Arrows avoid HUD panels and controls');for(const o of g.arrows)if(o.id!==r.id)assert.ok(r.right<=o.x||r.x>=o.right||r.bottom<=o.y||r.y>=o.bottom,'Arrows remain separate');}
}
try{
  mkdirSync(OUT,{recursive:true});await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  for(const spec of specs){
    const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},userAgent:MOBILE_UA,isMobile:true,hasTouch:true,deviceScaleFactor:1,recordVideo:spec.name==='phone-portrait'?{dir:join(OUT,'video'),size:{width:390,height:844}}:undefined});
    page=await context.newPage();const entry={name:spec.name,checks:[],errors:[]};results.scenarios.push(entry);
    page.on('pageerror',e=>entry.errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
    if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
    await page.locator('#startup').waitFor({state:'detached'});
    await page.evaluate(()=>{const a=window.flaghack;a.startMatch({seed:'mobile-hud-native',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0,1,2,3],bossMode:false,days:3,maxSignifiers:0}});});
    await page.locator('.mc-resources .res').waitFor({state:'visible'});await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.deviceLayout),'mobile');
    await page.evaluate(()=>{const w=window.flaghack.world;w.factions[0].lumber=778;w.factions[0].ritual=42;});
    await page.waitForFunction(()=>document.querySelector('.mc-resources [data-tutorial="hud-lumber"] .res-val').textContent===String(Math.floor(window.flaghack.world.factions[0].lumber))&&document.querySelector('.mc-resources [data-tutorial="hud-ritual"] .res-val').textContent===String(Math.floor(window.flaghack.world.factions[0].ritual)));
    assert.equal(await page.locator('[data-target-kind="boss"]').count(),0,'No boss location before emergence');
    let g=await geometry();checkLayout(g);entry.geometry=g;entry.checks.push('Five live camp resources, compact day/Tide/Burn clock and faction-colored noninteractive arrows fit mobile field');
    assert.match(await page.locator('.mc-timing .clock').innerText(),/Day 1/);
    assert.ok(await page.locator('.mc-timing .tide').isVisible());assert.ok(await page.locator('.mc-timing .burn').isVisible());
    assert.ok(g.timing.w>0&&g.timing.h>0);
    await page.screenshot({path:join(OUT,`${spec.name}-field.png`)});
    const beforePan=await page.evaluate(()=>({x:window.flaghack.session.camera.cmdX,z:window.flaghack.session.camera.cmdZ}));
    const cdp=await context.newCDPSession(page),touch={x:g.resources.x+g.resources.w/2,y:g.resources.y+g.resources.h/2,radiusX:2,radiusY:2,force:1,id:1};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
    for(let step=1;step<=4;step++){await page.waitForTimeout(45);await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...touch,x:touch.x-step*8,y:touch.y+step*5}]});}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
    await page.waitForFunction(p=>Math.hypot(window.flaghack.session.camera.cmdX-p.x,window.flaghack.session.camera.cmdZ-p.z)>.05,beforePan);
    entry.checks.push('Resource panel passes real touch drags through to field camera input');
    const motion=await page.evaluate(async()=>{
      const a=window.flaghack,s=a.session.camera,frames=[];
      for(let i=0;i<36;i++){
        s.cmdX+=.4;s.cmdZ+=.25;
        await new Promise(requestAnimationFrame);
        frames.push([...document.querySelectorAll('.mc-altar-arrow')].map(e=>({id:e.dataset.altarId,x:parseFloat(e.style.left),y:parseFloat(e.style.top)})));
      }
      return frames;
    });
    assert.ok(motion.some((frame,i)=>i&&frame.some(p=>{const old=motion[i-1].find(o=>o.id===p.id);return old&&Math.hypot(p.x-old.x,p.y-old.y)>.01;})),'Indicators move with continuously panned rendered camera');
    const movedFrames=motion.filter((frame,i)=>i&&frame.some(p=>{const old=motion[i-1].find(o=>o.id===p.id);return old&&Math.hypot(p.x-old.x,p.y-old.y)>.01;})).length;
    assert.ok(movedFrames>=12,`Per-frame camera tracking, not 10Hz HUD snapshots: ${movedFrames}/36 moved`);
    checkLayout(await geometry());entry.checks.push('Actual rendered camera pan moves arrows continuously along the exact perimeter outside HUD panes');
    for(let i=0;i<3;i++){
      await page.locator('.mc-top').getByRole('button',{name:'Menu',exact:true}).tap();
      await page.locator('.mc-page[data-tab="main"] .res').waitFor({state:'visible'});
      assert.equal(await page.locator('.res:not(.ff-flag-counter)').count(),1);assert.equal(await page.locator('.clock').count(),1);
      assert.ok(await page.locator('.mc-page[data-tab="main"] .clock .tod-l').isVisible(),'Full phase label retained in Overview');
      if(i===0)await page.screenshot({path:join(OUT,`${spec.name}-overview.png`)});
      await page.getByRole('button',{name:'Back to field',exact:true}).tap();await page.locator('.mc-resources .res').waitFor({state:'visible'});
    }
    entry.checks.push('Repeated menu/back restores identical live HUD nodes and full timer detail without duplicates');
    const target=await page.evaluate(()=>{const a=window.flaghack,w=a.world,b=[...w.buildings.values()].find(b=>b.kind==='hearth'&&b.faction===1&&b.hp>0);a.session.camera.cmdX=b.pos.x;a.session.camera.cmdZ=b.pos.z;return{id:b.id,faction:b.faction};});
    await page.waitForTimeout(1800);assert.equal(await page.locator(`.mc-altar-arrow[data-altar-id="${target.id}"]`).count(),0,'Onscreen altar needs no edge arrow');
    const throne=await page.evaluate(()=>{
      const a=window.flaghack,w=a.world,root=a.renderer.ctx.scene.getObjectByName('rts-ruler-1');
      if(!root?.visible)throw Error('Crow throne must be rendered at its altar');
      const forward=root.position.clone().set(0,0,1).applyQuaternion(root.quaternion),toward=root.position.clone().set(w.map.effigy.x-root.position.x,0,w.map.effigy.z-root.position.z).normalize();
      return{mode:w.factions[1].controlMode,avatar:!!w.avatarOf(1),facing:forward.dot(toward)};
    });
    assert.equal(throne.mode,'rts');assert.equal(throne.avatar,false);assert.ok(throne.facing>.9999);
    await page.locator('.mc-altar-arrow[data-allegiance="own"]').waitFor({state:'visible'});
    checkLayout(await geometry());
    await page.screenshot({path:join(OUT,`${spec.name}-crow-throne.png`)});
    entry.checks.push('NPC Dr. Crow has no roaming body and the actual rendered throne faces the effigy');
    await page.locator('.mc-top').getByRole('button',{name:'Home',exact:true}).tap();
    await page.locator(`.mc-altar-arrow[data-altar-id="${target.id}"]`).waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('.mc-altar-arrow[data-allegiance="own"]'));
    await page.evaluate(id=>{window.flaghack.world.buildings.get(id).faction=0;},target.id);
    await page.waitForFunction(id=>document.querySelector(`.mc-altar-arrow[data-altar-id="${id}"]`)?.dataset.allegiance==='own',target.id);
    checkLayout(await geometry());
    await page.evaluate(id=>{window.flaghack.world.buildings.get(id).hp=0;},target.id);
    await page.waitForFunction(id=>!document.querySelector(`.mc-altar-arrow[data-altar-id="${id}"]`),target.id);
    entry.checks.push('Own altar appears offscreen, enemy capture changes to own color, destroyed altar disappears');
    await page.evaluate(()=>{const a=window.flaghack;a.session.panels.settings=true;});
    await page.locator('.mc-field').waitFor({state:'hidden'});await page.evaluate(()=>{window.flaghack.session.panels.settings=false;});await page.locator('.mc-resources .res').waitFor({state:'visible'});
    await page.evaluate(()=>{window.flaghack.session.spectator=true;});await page.locator('.fh-hud .clock').waitFor({state:'visible'});
    await page.evaluate(()=>{window.flaghack.session.spectator=false;});await page.locator('.mc-timing .clock').waitFor({state:'visible'});
    entry.checks.push('Nested settings and spectator transitions restore the appropriate field or original HUD');
    if(spec.name==='phone-portrait'){
      await page.setViewportSize({width:844,height:390});await page.waitForTimeout(500);checkLayout(await geometry());
      await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);checkLayout(await geometry());
      entry.checks.push('Orientation changes recompute HUD and altar arrows without overflow');
    }
    if(spec.name==='phone-portrait'){
      await page.evaluate(()=>{const a=window.flaghack;a.startMatch({seed:'mobile-hud-boss',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0],bossMode:true,days:0,maxSignifiers:0}});window.fh.advance(96);});
      await page.locator('.mc-timing .boss-hud').waitFor({state:'visible',timeout:30000});
      assert.ok(await page.locator('.mc-timing .clock').isHidden(),'Boss health replaces, not duplicates, the compact timer');
      const boss=await page.locator('.mc-timing .boss-hud').boundingBox();assert.ok(boss.x>=0&&boss.x+boss.width<=390);
      await page.screenshot({path:join(OUT,'phone-boss-health.png')});
      entry.checks.push('Actual awakening switches the shared compact clock to bounded authoritative boss health');
      await page.evaluate(()=>{const a=window.flaghack,b=a.world.boss;a.session.camera.cmdX=b.pos.x+120;a.session.camera.cmdZ=b.pos.z+100;});
      await page.locator('.mc-altar-arrow[data-target-kind="boss"]').waitFor({state:'visible'});
      await page.waitForTimeout(500);checkLayout(await geometry());
      await page.screenshot({path:join(OUT,'phone-boss-perimeter.png')});
      await page.evaluate(()=>{const a=window.flaghack,b=a.world.boss;a.session.camera.cmdX=b.pos.x;a.session.camera.cmdZ=b.pos.z;});
      await page.waitForFunction(()=>!document.querySelector('.mc-altar-arrow[data-target-kind="boss"]'));
      await page.evaluate(()=>{const a=window.flaghack,b=a.world.boss;a.session.camera.cmdX=b.pos.x+120;a.session.camera.cmdZ=b.pos.z+100;});
      await page.locator('.mc-altar-arrow[data-target-kind="boss"]').waitFor({state:'visible'});
      await page.evaluate(()=>{window.flaghack.world.boss.hp=0;window.flaghack.world.boss.action='dead';});
      await page.waitForFunction(()=>!document.querySelector('.mc-altar-arrow[data-target-kind="boss"]'));
      entry.checks.push('Distinct emerged boss marker tracks offscreen, hides onscreen and disappears when dead');
    }
    assert.deepEqual(entry.errors,[]);await context.close();
  }
  results.completed=true;
}catch(error){results.error=String(error?.stack||error);if(page)await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});throw error;
}finally{writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));await browser?.close();server.close();}
