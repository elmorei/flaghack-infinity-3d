/** Native browser QA. Explicit public destruction-event fixtures, not an organic playthrough.
 * Live engine rendering and unmodified 1x browser footage; mobile is browser emulation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), {chromium}=require('playwright');
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/explosion-smoke');
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
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Public sceneryDestroyed, boss buildingDisabled and boss pieceDestroyed events staged through live renderer.onEvents. Camera positioned for visibility. Normal-speed engine-rendered footage, not an organic destruction playthrough.',scenarios:[]};
const specs=[{name:'desktop-high',width:1280,height:800,touch:false},{name:'phone-low',width:390,height:844,touch:true}];
let browser,page;
// Exact pre-change radius/random recipe, used only to compare actual GPU attributes.
function oldRecipe(id,size,density){
  let seed=Math.imul(id+1,0x9e3779b1)>>>0||0x9e3779b9;
  const next=()=>{seed=(seed+0x6d2b79f5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
  const shrink=Math.min(1,14/Math.max(size.x,size.z)),span=Math.sqrt(size.x*size.z)*shrink,height=Math.min(size.y,12),radius=Math.min(4.5,1.25+span*.2+height*.07),smoke=Math.ceil(6*density),count=smoke+Math.ceil(Math.min(15,8+span*.45)*density);
  return Array.from({length:count},(_,i)=>{const flame=i>=smoke;next();next();next();next();const puff=radius*(flame?.7+next()*.3:.5+next()*.2),vy=flame?2.8+next()*2.6:.8+next()*.8;next();next();return{size0:puff*(flame?.16:.4),size1:puff*(flame?1:1.35),vy};});
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<.00002,`${a} != ${b}`);
async function snapshot(){return page.evaluate(()=>{
  const r=window.flaghack.renderer,m=r.ctx.scene.getObjectByName('structure-destruction-flame-poofs'),g=m.geometry;
  const rows=Array.from({length:g.instanceCount},(_,i)=>Array.from({length:8},(_,j)=>{const a=g.getAttribute('a'+j);return[a.getX(i),a.getY(i),a.getZ(i),a.getW(i)];}));
  return{rows,visible:m.visible,count:g.instanceCount,capacity:g.getAttribute('a0').count,bytes:g.getAttribute('a0').data.array.byteLength,geometry:g.uuid,material:m.material.uuid,time:m.material.uniforms.uTime.value,quality:r.ctx.quality,calls:r.renderer.info.render.calls,triangles:r.renderer.info.render.triangles};
});}
async function fire(events){await page.evaluate(events=>{window.flaghack.renderer.onEvents(events);},events);await page.waitForTimeout(40);}
try{
  mkdirSync(OUT,{recursive:true});await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  for(const spec of specs){
    const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},isMobile:spec.touch,hasTouch:spec.touch,deviceScaleFactor:1,...(spec.touch?{userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'}:{}),recordVideo:{dir:join(OUT,'video'),size:{width:spec.width,height:spec.height}}});
    page=await context.newPage();const entry={name:spec.name,checks:[],events:[],errors:[]};results.scenarios.push(entry);page.on('pageerror',e=>entry.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|shader|GL_INVALID/i.test(m.text()))entry.errors.push(m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
    if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
    await page.locator('#startup').waitFor({state:'detached'});
    await page.evaluate(()=>{const a=window.flaghack;a.session.settings.quality='high';a.startMatch({seed:'upward-explosions-native',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0],bossMode:false,days:3,maxSignifiers:0}});});
    await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.renderer.ctx);
    await page.waitForTimeout(1800);
    const pos=await page.evaluate(()=>{const a=window.flaghack,w=a.world,h=w.hearthOf(0);const x=h.pos.x+15,z=h.pos.z;Object.assign(a.session.camera,{cmdX:x,cmdZ:z,cmdHeight:42});return{x,y:w.collision.groundHeight(x,z),z};});
    await page.waitForTimeout(1200);
    assert.equal((await snapshot()).quality,spec.touch?'low':'high');
    const fixtures=[
      {name:'small-prop',event:{t:'sceneryDestroyed',sceneryId:900001,pos,size:{x:3,y:4,z:3},yaw:.3}},
      {name:'large-prop',event:{t:'sceneryDestroyed',sceneryId:900002,pos,size:{x:18,y:12,z:14},yaw:.3}},
      {name:'building',event:{t:'buildingDisabled',buildingId:900003,kind:'hearth',faction:0,pos:{x:pos.x,z:pos.z},bossDestroyed:true}},
      {name:'piece',event:{t:'pieceDestroyed',pieceId:900004,kind:'wall',faction:0,pos,bossDestroyed:true}},
    ];
    for(const fixture of fixtures){
      await fire([fixture.event]);const initial=await snapshot();assert.ok(initial.visible&&initial.count>0);assert.equal(initial.capacity,2048);assert.ok(initial.calls>0&&initial.triangles>0);
      if(fixture.event.t==='sceneryDestroyed'){
        const old=oldRecipe(fixture.event.sceneryId,fixture.event.size,spec.touch?.45:1);assert.equal(initial.count,old.length);
        initial.rows.forEach((row,i)=>{near(row[2][0],old[i].size0*2);near(row[2][1],old[i].size1*2);near(row[1][1],old[i].vy*2);});
      }
      const rise=initial.rows.map(row=>{
        const at=age=>row[0][1]+row[1][1]*(1-Math.exp(-row[2][3]*age))/row[2][3]-.5*row[2][2]*age*age;
        return{shape:row[5][0],early:at(.12),late:at(.5),up:row[1][1],side:Math.hypot(row[1][0],row[1][2])};
      });
      assert.ok(rise.every(p=>p.late>p.early&&p.up>p.side*2),'Every lobe/smoke trajectory shoots upward');
      await page.waitForTimeout(100);await page.screenshot({path:join(OUT,`${spec.name}-${fixture.name}-early.png`)});
      await page.waitForTimeout(220);await page.screenshot({path:join(OUT,`${spec.name}-${fixture.name}-rise.png`)});
      await page.waitForTimeout(1600);const expired=await snapshot();assert.equal(expired.count,0);assert.equal(expired.visible,false);
      entry.events.push({name:fixture.name,initial,rise,expired});
    }
    entry.checks.push('Small/large scenery GPU size endpoints exactly 2x pre-change recipe; launch speed 2x; every plume upward; building/piece share live effect; all expire');
    const before=await snapshot();
    const mass=Array.from({length:400},(_,i)=>({t:'sceneryDestroyed',sceneryId:910000+i,pos:{...pos,x:pos.x+(i%9-4)*3,z:pos.z+(Math.floor(i/9)%9-4)*3},size:{x:3,y:4,z:3},yaw:0}));
    await page.evaluate(()=>{const q={gaps:[],done:false,last:performance.now()};window.__explosionFrameObservation=q;function tick(t){q.gaps.push(t-q.last);q.last=t;if(q.gaps.reduce((a,b)=>a+b,0)<1800)requestAnimationFrame(tick);else q.done=true;}requestAnimationFrame(tick);});
    await fire(mass);const peak=await snapshot();assert.equal(peak.count,2048);assert.equal(peak.capacity,2048);assert.equal(peak.bytes,before.bytes);assert.equal(peak.geometry,before.geometry);assert.equal(peak.material,before.material);
    const meshes=await page.evaluate(()=>{let n=0;window.flaghack.renderer.ctx.scene.traverse(o=>{if(o.name==='structure-destruction-flame-poofs')n++;});return n;});assert.equal(meshes,1);
    await page.screenshot({path:join(OUT,`${spec.name}-mass-destruction.png`)});await page.waitForTimeout(1900);assert.equal((await snapshot()).count,0);
    await page.waitForFunction(()=>window.__explosionFrameObservation.done);
    const performanceObservation=await page.evaluate(()=>{const gaps=window.__explosionFrameObservation.gaps.slice().sort((a,b)=>a-b);return{samples:gaps.length,p50:gaps[Math.floor(gaps.length*.5)],p95:gaps[Math.floor(gaps.length*.95)],max:gaps.at(-1),glError:window.flaghack.renderer.renderer.getContext().getError()};});
    assert.equal(performanceObservation.glError,0);entry.mass={before,peak,events:mass.length,meshes,performanceObservation,performanceDisclosure:'Frame gaps are observations on this runner, not a device FPS guarantee. Larger billboards increase fill rate despite fixed allocation.'};entry.checks.push('400 staged simultaneous destruction facts retain one 2048-instance pool, same GPU allocation and material, then clear');
    assert.deepEqual(entry.errors,[]);await context.close();
  }
  results.completed=true;
}catch(error){results.error=String(error?.stack||error);if(page)await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});throw error;
}finally{writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));await browser?.close();server.close();}
