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
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/mobile-pixel-smoke');
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
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Real local matches with staged existing Tide/Burn event payloads for a repeatable UI demonstration; production event handlers and browser taps are exercised. Video is normal speed.',scenarios:[]};
let browser,page;
async function boot(context,mobile=true,errors=[]){
  page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
  if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
  await page.locator('#startup').waitFor({state:'detached'});
  await page.evaluate(mobile=>{const a=window.flaghack;a.startMatch({seed:'mobile-pixel-preview',humans:[0],rtsFactions:mobile?[0]:[],match:{...a.session.settings.match,active:[0,1,2,3],bossMode:false,days:3,maxSignifiers:0}});},mobile);
  await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world.time>1);
  await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(800);
}
async function tide(){await page.evaluate(()=>window.flaghack.ui.onEvents([{t:'tide',flips:12,duration:8,dir:{x:1,z:0}}]));}
async function bounds(selector){return page.locator(selector).evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {cls:el.className,x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom,overflow:el.scrollWidth>el.clientWidth+1,font:getComputedStyle(el).fontFamily,pointer:getComputedStyle(el).pointerEvents};}));}
function fit(rs,w,h){assert.ok(rs.length>0,'Expected visible layout elements');for(const r of rs){assert.ok(r.w>0&&r.h>0,JSON.stringify(r));assert.ok(r.x>=-1&&r.y>=-1&&r.right<=w+1&&r.bottom<=h+1,JSON.stringify(r));}}
try{
 mkdirSync(OUT,{recursive:true});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
 for(const spec of [{name:'portrait',w:390,h:844},{name:'small',w:320,h:568},{name:'landscape',w:844,h:390}]){
  const context=await browser.newContext({viewport:{width:spec.w,height:spec.h},userAgent:MOBILE_UA,isMobile:true,hasTouch:true,deviceScaleFactor:1,recordVideo:spec.name==='portrait'?{dir:join(OUT,'video'),size:{width:390,height:844}}:undefined});
  const entry={name:spec.name,checks:[],errors:[]};results.scenarios.push(entry);const recordingStartedAt=Date.now();
  await boot(context,true,entry.errors);entry.demoStartSeconds=(Date.now()-recordingStartedAt)/1000;
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.deviceLayout),'mobile');
  fit(await bounds('.mc-resources,.mc-timing,.mc-top button,.mc-modes button'),spec.w,spec.h);
  await page.screenshot({path:join(OUT,`${spec.name}-field.png`)});
  await tide();await page.locator('.mp-dialogue').waitFor({state:'visible'});
  await page.locator('.mp-advance').tap();
  await page.waitForFunction(()=>document.querySelector('.mp-ghost')?.textContent==='');
  assert.match(await page.locator('.mp-text').innerText(),/12 nodes turning/);
  const panel=await bounds('.mp-dialogue,.mp-title,.mp-text,.mp-actions button');assert.equal(panel.length,5);fit(panel,spec.w,spec.h);
  assert.ok(await page.locator('.mp-actions button').evaluateAll(buttons=>buttons.every(b=>{const r=b.getBoundingClientRect(),p=b.closest('.mp-dialogue').getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.x>=p.x&&r.y>=p.y&&r.right<=p.right&&r.bottom<=p.bottom&&(hit===b||b.contains(hit));})), 'Both dialogue actions are visible and receive touches without scrolling');
  assert.ok(panel.slice(-2).every(r=>r.h>=44),'Dialogue actions have touch-safe heights');
  entry.dialogue=panel;
  const arrowClear=await page.locator('.mc-altar-arrow').evaluateAll(arrows=>{const p=document.querySelector('.mp-dialogue').getBoundingClientRect();return arrows.every(a=>{const r=a.getBoundingClientRect();return r.right<=p.left||r.left>=p.right||r.bottom<=p.top||r.top>=p.bottom;});});assert.ok(arrowClear,'Perimeter arrows avoid the dialogue panel');
  const before=await page.evaluate(()=>window.flaghack.world.time);await page.waitForTimeout(500);
  assert.ok(await page.evaluate(()=>window.flaghack.world.time)>before,'Announcements do not pause simulation');
  await page.screenshot({path:join(OUT,`${spec.name}-dialogue.png`)});if(spec.name==='portrait')await page.waitForTimeout(2500);
  await page.locator('.mc-top').getByRole('button',{name:'Menu',exact:true}).tap();
  await page.locator('.mc-menu').waitFor({state:'visible'});await page.locator('.mobile-announcements').waitFor({state:'hidden'});
  await page.screenshot({path:join(OUT,`${spec.name}-menu.png`)});if(spec.name==='portrait')await page.waitForTimeout(2200);
  fit(await bounds('.mc-menu,.mc-menu-head,.mc-tabs'),spec.w,spec.h);const tabs=await bounds('.mc-tabs .btn');assert.equal(tabs.length,5);fit(tabs,spec.w,spec.h);
  await page.getByRole('button',{name:'Back to field',exact:true}).tap();
  await page.evaluate(()=>window.flaghack.ui.banners.reset(window.flaghack.world));await tide();
  await page.locator('.mp-dialogue').waitFor({state:'visible'});
  await page.getByRole('button',{name:'Close announcements',exact:true}).tap();
  await page.locator('.mobile-announcements').waitFor({state:'hidden'});
  await page.evaluate(()=>window.flaghack.ui.onEvents([{t:'notify',faction:'all',text:'Routine resource notice',severity:'info'}]));
  await page.waitForTimeout(300);assert.equal(await page.locator('.mp-dialogue').count(),0,'Routine feed stays compact');
  await page.emulateMedia({reducedMotion:'reduce'});await tide();await page.locator('.mp-dialogue').waitFor({state:'visible'});
  assert.equal(await page.locator('.mp-ghost').textContent(),'','Reduced motion reveals immediately');
  await page.getByRole('button',{name:'Close announcements',exact:true}).tap();
  entry.checks.push('Mobile pixel HUD and dialogue fit viewport; reveal/close work; menu suppresses dialogue; world runs; routine feed stays compact; reduced motion reveals immediately');
  entry.demoEndSeconds=(Date.now()-recordingStartedAt)/1000;assert.deepEqual(entry.errors,[]);await context.close();
 }
 const desktop=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});const desktopErrors=[];await boot(desktop,false,desktopErrors);
 assert.notEqual(await page.evaluate(()=>document.documentElement.dataset.deviceLayout),'mobile');
 await tide();await page.locator('.banner').waitFor({state:'visible'});
 assert.equal(await page.locator('.mobile-announcements').count(),0,'Desktop keeps original banner implementation');
 const snapshot=()=>page.evaluate(()=>[...document.querySelectorAll('.res,.banner,.banner-title,.clock,.btn')].filter(e=>e.getBoundingClientRect().width).map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {cls:e.className,font:s.fontFamily,color:s.color,background:s.background,border:s.border,borderImage:s.borderImage,width:r.width,height:r.height};}));
 const original=await snapshot();
 // Removing only explicitly mobile-scoped rules must not affect desktop presentation.
 await page.evaluate(()=>{function strip(sheet){try{for(let i=sheet.cssRules.length-1;i>=0;i--){const r=sheet.cssRules[i];if(r.selectorText?.includes('[data-device-layout="mobile"]'))sheet.deleteRule(i);else if(r.cssRules)strip(r);}}catch{}}for(const sheet of document.styleSheets)strip(sheet);});
 assert.deepEqual(await snapshot(),original,'Mobile stylesheet does not change desktop computed appearance');
 await page.screenshot({path:join(OUT,'desktop-unchanged.png')});results.desktop=original;
 assert.deepEqual(desktopErrors,[]);await desktop.close();results.completed=true;
}catch(error){results.error=String(error?.stack||error);if(page)await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});throw error;
}finally{writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));await browser?.close();server.close();}
