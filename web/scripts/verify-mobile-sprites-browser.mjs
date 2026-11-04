/** Native, sandboxed Chrome QA of the exact dist build. Never deploys.
 * Natural UI-started matches are tested first. Explicit offline render fixtures then
 * stage animation, composition, occlusion and a 256-unit crowd. They are not gameplay
 * captures. Browser mobile emulation and runner timings are NOT physical-phone QA.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { platform, arch, cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url), { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'host-release/mobile-sprites-smoke'), PROJECT = '/flaghack-infinity-3d/';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.woff2':'font/woff2','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'};
const result = {completed:false, physicalDeviceTest:false, fixtureDisclosure:'Natural production title/lobby starts precede explicitly staged offline renderer composition, occlusion and 256-unit crowd fixtures. Pixel checks read the real native WebGL scene render target, before post-processing. Timings measure this runner, not a phone. Separate real mixed-client protocol verifier is required by the workflow.',environment:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,commit:process.env.GITHUB_SHA ?? null},scenarios:[],errors:[]};
const server = createServer((req,res) => {
  const path = new URL(req.url,'http://localhost').pathname;
  if (!path.startsWith(PROJECT)) {res.writeHead(404).end();return;}
  const file = resolve(DIST,decodeURIComponent(path.slice(PROJECT.length)) || 'index.html');
  if (!file.startsWith(DIST+'/')) {res.writeHead(404).end();return;}
  try {const body=readFileSync(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(body);} catch {res.writeHead(404).end();}
});
let browser, activePage;
async function boot(spec) {
  const context=await browser.newContext({viewport:{width:spec.w,height:spec.h},isMobile:spec.mobile,hasTouch:spec.mobile,deviceScaleFactor:1,...(spec.name==='portrait'?{recordVideo:{dir:join(OUT,'video'),size:{width:390,height:844}}}:{}),...(spec.mobile?{userAgent:ANDROID}:{})});
  const started=Date.now(),page=await context.newPage();activePage=page;const atlasRequests=[];
  page.on('request',req=>{if(req.url().includes('/mobile-sprites/'))atlasRequests.push(req.url());});
  if(spec.blockAtlas)await page.route('**/assets/mobile-sprites/atlas.png',route=>route.abort());
  page.on('pageerror',error=>result.errors.push({scenario:spec.name,error:String(error)}));
  await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
  if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
  await page.locator('#startup').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Begin the Survey',exact:true}).click();
  await page.locator('.lobby').getByRole('button',{name:'Light the burn',exact:true}).click();
  await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world.time>1,null,{timeout:90000});
  return {page,context,atlasRequests,started};
}
async function installProbe(page) {
  await page.evaluate(()=>{
    const a=window.flaghack,g=a.renderer,ctx=g.ctx,r=g.renderer,s=ctx.shared.mobileSprites;
    const target=g.warmTarget.clone();target.setSize(innerWidth,innerHeight);
    const draw=()=>{const previous=r.getRenderTarget();try{r.setRenderTarget(target);r.clear();r.render(ctx.scene,ctx.camera);const data=new Uint8Array(innerWidth*innerHeight*4);r.readRenderTargetPixels(target,0,0,innerWidth,innerHeight,data);return data;}finally{r.setRenderTarget(previous);}};
    const diff=(a,b)=>{let changed=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>6)changed++;return changed;};
    const contribution=()=>{const visible=s.mesh.visible;try{s.mesh.visible=false;const without=draw();s.mesh.visible=true;return diff(without,draw());}finally{s.mesh.visible=visible;}};
    const png=data=>{const canvas=document.createElement('canvas');canvas.width=innerWidth;canvas.height=innerHeight;const flipped=new Uint8ClampedArray(data.length),row=innerWidth*4;for(let y=0;y<innerHeight;y++)flipped.set(data.subarray(y*row,(y+1)*row),(innerHeight-y-1)*row);canvas.getContext('2d').putImageData(new ImageData(flipped,innerWidth,innerHeight),0,0);return canvas.toDataURL('image/png').split(',')[1];};
    window.__spriteProbe={draw,diff,contribution,png,dispose:()=>target.dispose()};
  });
}
async function natural(page) {
  await page.waitForFunction(()=>window.flaghack.renderer.ctx.shared.mobileSprites?.atlasReady,null,{timeout:30000});
  await page.waitForFunction(()=>window.flaghack.renderer.ctx.shared.mobileSprites.spriteCount>0,null,{timeout:30000});
  await installProbe(page);
  return page.evaluate(()=>{
    const g=window.flaghack.renderer,s=g.ctx.shared.mobileSprites,gl=g.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    const actors=g.modules.find(m=>m.hippies&&m.avatars),quivers=[],original=actors.avatars.pushQuiver;actors.avatars.pushQuiver=function(v,av){let pushes=0;const push=actors.flags.pushMatrix;actors.flags.pushMatrix=function(...args){pushes++;return push.apply(this,args);};try{original.call(this,v,av);}finally{actors.flags.pushMatrix=push;}quivers.push({id:av.id,carried:av.carried.length,drawnFlags:pushes});};try{g.render(0);}finally{actors.avatars.pushQuiver=original;}for(const q of quivers)q.sprite=s.samples.some(v=>v.id===q.id);
    return {quivers,atlasReady:s.atlasReady,atlasError:s.atlasError,sprites:s.spriteCount,layers:s.layerCount,batches:s.batchCount,changedPixels:window.__spriteProbe.contribution(),gpu:{vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)},viewport:{width:innerWidth,height:innerHeight},depthTest:s.mesh.material.depthTest,depthWrite:s.mesh.material.depthWrite};
  });
}
// All fixture mutations are confined to an offline page and restored before return.
async function composition(page) {
  return page.evaluate(()=>{
    const a=window.flaghack,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    if(a.net)throw Error('Refusing fixture mutation online');
    const children=ctx.scene.children.map(o=>[o,o.visible]),camera={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom},time=ctx.time;
    try {
      for(const [o] of children)o.visible=o===s.mesh;
      c.position.set(0,5,12);c.lookAt(0,1,0);c.left=-4;c.right=4;c.top=4*innerHeight/innerWidth;c.bottom=-c.top;c.updateProjectionMatrix();c.updateMatrixWorld();
      const pose={id:0,x:0,y:0,z:0,yaw:0,height:3,moving:true};
      const render=(direction,frame,head=0,body=0)=>{ctx.time=frame*.14+.001;s.begin();s.signifier({...pose,yaw:direction==='front'?0:Math.PI},head,body);s.end();return {pixels:p.draw(),layers:s.layerCount,contribution:p.contribution()};};
      const captures={},frames={};for(const dir of ['front','away']){const shots=[0,1,2,3].map(f=>render(dir,f));shots.forEach((shot,i)=>captures[dir+'-'+i]=p.png(shot.pixels));frames[dir]={pixels:shots.map(x=>x.contribution),deltas:shots.slice(1).map((x,i)=>p.diff(shots[i].pixels,x.pixels))};}
      const front=render('front',0),back=render('away',0),head=render('front',0,7),flag=render('away',0,0,6);
      // Remove only the foreground Flag layer from the real GPU instance stream.
      s.mesh.geometry.instanceCount=2;const withoutFlag=p.draw();s.mesh.geometry.instanceCount=3;
      const flagPixels=p.diff(flag.pixels,withoutFlag);
      const idle=[];for(const t of [0,2]){ctx.time=t;s.begin();s.signifier({...pose,moving:false},0,0);s.end();idle.push(p.draw());}
      const casts=[];for(let i=0;i<6;i++){const rows=[];for(const yaw of [0,Math.PI]){const shots=[];for(let frame=0;frame<4;frame++){ctx.time=frame*.14+.001;s.begin();s.cast(i,{...pose,yaw});s.end();shots.push({pixels:p.draw(),contribution:p.contribution()});}captures['cast-'+i+'-'+(yaw?'away':'front')]=p.png(shots[0].pixels);rows.push(shots);}casts.push({pixels:rows.flat().map(x=>x.contribution),frontDeltas:rows[0].slice(1).map((x,j)=>p.diff(rows[0][j].pixels,x.pixels)),awayDeltas:rows[1].slice(1).map((x,j)=>p.diff(rows[1][j].pixels,x.pixels)),directionDelta:p.diff(rows[0][0].pixels,rows[1][0].pixels)});}
      captures['head-variant']=p.png(head.pixels);captures['rear-flag']=p.png(flag.pixels);return {captures,frames,directionDelta:p.diff(front.pixels,back.pixels),headDelta:p.diff(front.pixels,head.pixels),rearFlagLayers:flag.layers,rearFlagForegroundPixels:flagPixels,idleDelta:p.diff(idle[0],idle[1]),casts};
    } finally {ctx.time=time;for(const [o,v] of children)o.visible=v;c.position.copy(camera.position);c.quaternion.copy(camera.quaternion);Object.assign(c,{left:camera.left,right:camera.right,top:camera.top,bottom:camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);}
  });
}
async function occlusion(page) {
  return page.evaluate(()=>{
    const g=window.flaghack.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    const children=ctx.scene.children.map(o=>[o,o.visible]),saved={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom};
    const ground=ctx.scene.getObjectByName('ground');
    const structures=g.modules.find(m=>m.views instanceof Map&&m.kit&&m.table);
    const root=structures&&[...structures.views.values()].find(v=>v.root.visible)?.root;
    if(!ground||!root)throw Error('Real ground and building geometry required for occlusion proof');
    const cases=[];
    try {
      for(const [label,object] of [['terrain',ground],['building',root]]) {
        for(const [o] of children)o.visible=false;
        for(let o=object;o;o=o.parent)o.visible=true;
        s.mesh.visible=true;
        const origin=object.getWorldPosition(c.position.clone());
        // Place the sprite inside/below the actual rendered occluder, not a synthetic overlay.
        const y=label==='terrain'?(ctx.shared.groundOffset?.(0,0)??0)-4:origin.y-1;
        const x=label==='terrain'?0:origin.x,z=label==='terrain'?0:origin.z;
        c.position.set(x,y+10,z+12);c.lookAt(x,y+1,z);c.left=-4;c.right=4;c.top=4*innerHeight/innerWidth;c.bottom=-c.top;c.updateProjectionMatrix();c.updateMatrixWorld();
        s.begin();s.signifier({id:0,x,y,z,yaw:0,height:2,moving:false},0,0);s.end();
        const depthPixels=p.contribution();s.mesh.material.depthTest=false;const throughPixels=p.contribution();s.mesh.material.depthTest=true;
        cases.push({label,depthPixels,throughPixels});
      }
      return cases;
    } finally {s.mesh.material.depthTest=true;for(const [o,v] of children)o.visible=v;c.position.copy(saved.position);c.quaternion.copy(saved.quaternion);Object.assign(c,{left:saved.left,right:saved.right,top:saved.top,bottom:saved.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);}
  });
}
async function fallback(page) {
  return page.evaluate(()=>{
    const a=window.flaghack,w=a.world,g=a.renderer,s=g.ctx.shared.mobileSprites;
    if(a.net)throw Error('Offline fixture only');
    const original=new Map(w.hippies),screen=a.session.screen;a.setPaused(true);w.hippies.clear();
    const center=a.session.camera;
    const h=window.fh.factory.spawnHippie(w,0,{x:center.cmdX,z:center.cmdZ});
    const actors=g.modules.find(m=>m.hippies&&m.avatars),states=[];
    try {
      for(const status of ['idle','fighting','ko']) {
        h.status=status;h.koUntil=status==='ko'?w.time+10:0;g.render(0);
        states.push({status,sprite:s.samples.some(v=>v.id===h.id),fallbackCount:s.fallbackCount,modelInstances:actors.hippies.levels.reduce((n,l)=>n+l.mesh.count,0)});
      }
      return states;
    } finally {w.hippies.clear();for(const [id,h] of original)w.hippies.set(id,h);a.session.screen=screen;g.render(0);}
  });
}
async function crowd(page) {
  const staged=await page.evaluate(()=>{
    const a=window.flaghack,w=a.world;if(a.net)throw Error('Offline fixture only');a.setPaused(true);
    const center={x:a.session.camera.cmdX,z:a.session.camera.cmdZ};
    const ids=[];for(let i=0;i<256;i++){const h=window.fh.factory.spawnHippie(w,0,{x:center.x+(i%16-7.5)*.65,z:center.z+(Math.floor(i/16)-7.5)*.65});h.status='idle';ids.push(h.id);}
    window.__crowdIds=ids;return {count:ids.length,center};
  });
  await page.waitForTimeout(1500);
  const timing=await page.evaluate(async()=>{
    const g=window.flaghack.renderer,s=g.ctx.shared.mobileSprites,intervals=[],renderMs=[],calls=[],spriteCalls=[];const previousReset=g.renderer.info.autoReset,previousBefore=s.mesh.onBeforeRender;g.renderer.info.autoReset=false;
    let previous=performance.now();try{for(let i=0;i<121;i++){await new Promise(requestAnimationFrame);const now=performance.now();if(i)intervals.push(now-previous);previous=now;let draws=0;s.mesh.onBeforeRender=function(...args){draws++;previousBefore.apply(this,args);};g.renderer.info.reset();const t=performance.now();g.render(0);renderMs.push(performance.now()-t);calls.push(g.renderer.info.render.calls);spriteCalls.push(draws);}}finally{g.renderer.info.autoReset=previousReset;s.mesh.onBeforeRender=previousBefore;}
    const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))];
    return {sprites:s.spriteCount,layers:s.layerCount,batches:s.batchCount,capacity:s.capacity,frameMs:{median:percentile(intervals,.5),p95:percentile(intervals,.95),max:Math.max(...intervals)},renderCpuMs:{median:percentile(renderMs,.5),p95:percentile(renderMs,.95)},wholeFrameDrawCalls:{min:Math.min(...calls),max:Math.max(...calls)},spriteDrawCalls:{min:Math.min(...spriteCalls),max:Math.max(...spriteCalls)},sampleCount:intervals.length};
  });
  return {...staged,...timing};
}
mkdirSync(OUT,{recursive:true});
try {
  const expected=process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
  result.build=JSON.parse(readFileSync(join(DIST,'build.json'),'utf8'));assert.equal(result.build.build,expected,'Dist metadata must match the expected final commit');
  result.bundleHashes={};let embedded=false;for(const file of readdirSync(join(DIST,'assets')).filter(f=>f.endsWith('.js'))){const body=readFileSync(join(DIST,'assets',file));result.bundleHashes[file]=createHash('sha256').update(body).digest('hex');embedded ||= body.includes(Buffer.from(expected));}assert.ok(embedded,'Built JavaScript must embed the expected commit');
  result.sourceDirty=execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8'}).trim();if(process.env.CI)assert.equal(result.sourceDirty,'','CI must test the exact clean committed revision');
  result.distIndexSha256=createHash('sha256').update(readFileSync(join(DIST,'index.html'))).digest('hex');
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});result.environment.browser=browser.version();
  for(const spec of [{name:'portrait',w:390,h:844,mobile:true},{name:'small',w:320,h:568,mobile:true},{name:'landscape',w:844,h:390,mobile:true}]) {
    const {page,context,atlasRequests,started}=await boot(spec);const entry={name:spec.name};result.scenarios.push(entry);
    entry.naturalVideoStartSeconds=(Date.now()-started)/1000;entry.natural=await natural(page);assert.ok(entry.natural.quivers.some(q=>q.sprite&&q.carried>0&&q.drawnFlags===q.carried),'Natural sprite avatars retain actual 3D quiver inventory');assert.ok(entry.natural.changedPixels>4,'Naturally visible sprites must change actual framebuffer pixels');assert.equal(entry.natural.depthTest,true);assert.equal(entry.natural.depthWrite,true);assert.equal(entry.natural.batches,1);assert.ok(atlasRequests.length>0);
    await page.screenshot({path:join(OUT,spec.name+'-natural.png')});
    if(spec.name==='portrait')await page.waitForTimeout(4000);entry.fixtureStartSeconds=(Date.now()-started)/1000;entry.composition=await composition(page);for(const [name,data] of Object.entries(entry.composition.captures))writeFileSync(join(OUT,spec.name+'-fixture-'+name+'.png'),Buffer.from(data,'base64'));delete entry.composition.captures;for(const value of Object.values(entry.composition.frames)){assert.ok(value.pixels.every(n=>n>20));assert.ok(value.deltas.every(n=>n>0),'Each walking frame must visibly change');}assert.ok(entry.composition.directionDelta>0);assert.ok(entry.composition.headDelta>0);assert.equal(entry.composition.rearFlagLayers,3);assert.ok(entry.composition.rearFlagForegroundPixels>0);assert.equal(entry.composition.idleDelta,0);for(const cast of entry.composition.casts){assert.ok(cast.pixels.every(n=>n>20));assert.ok(cast.frontDeltas.every(n=>n>0));assert.ok(cast.awayDeltas.every(n=>n>0));assert.ok(cast.directionDelta>0);}
    entry.occlusion=await occlusion(page);for(const o of entry.occlusion){assert.ok(o.throughPixels>20,o.label+' control pixels');assert.ok(o.depthPixels<o.throughPixels*.8,o.label+' must genuinely occlude sprites');}
    entry.fallback=await fallback(page);assert.equal(entry.fallback[0].sprite,true,'Idle fixture uses atlas');for(const f of entry.fallback.slice(1)){assert.equal(f.sprite,false,f.status+' rejects sprite');assert.ok(f.modelInstances>0,f.status+' retains actual 3D instances');}
    entry.crowd=await crowd(page);assert.ok(entry.crowd.sprites>=200,'200+ actual integrated visible sprites');assert.equal(entry.crowd.batches,1);assert.equal(entry.crowd.spriteDrawCalls.max,1,'Crowd uses one real GPU sprite draw per frame');assert.ok(entry.crowd.layers<=entry.crowd.capacity);assert.ok(Number.isFinite(entry.crowd.frameMs.p95));
    await page.screenshot({path:join(OUT,spec.name+'-256-unit-fixture.png')});await context.close();
  }
  const desktop=await boot({name:'desktop',w:1440,h:900,mobile:false});result.desktop=await desktop.page.evaluate(()=>{const a=window.flaghack;return {layout:document.documentElement.dataset.deviceLayout,spriteSystem:!!a.renderer.ctx.shared.mobileSprites,spriteMesh:!!a.renderer.ctx.scene.getObjectByName('mobile-sprite-batch'),avatarMeshes:[...a.world.avatars.values()].length};});assert.equal(result.desktop.layout,'desktop');assert.equal(result.desktop.spriteSystem,false);assert.equal(result.desktop.spriteMesh,false);assert.deepEqual(desktop.atlasRequests,[],'Desktop must never load the atlas');assert.ok(result.desktop.avatarMeshes>0);await desktop.page.screenshot({path:join(OUT,'desktop-3d.png')});await desktop.context.close();
  const failed=await boot({name:'atlas-failure',w:390,h:844,mobile:true,blockAtlas:true});await failed.page.waitForFunction(()=>window.flaghack.renderer.ctx.shared.mobileSprites.atlasError);result.atlasFailure=await failed.page.evaluate(()=>{const g=window.flaghack.renderer,s=g.ctx.shared.mobileSprites,actors=g.modules.find(m=>m.hippies&&m.avatars);return {atlasReady:s.atlasReady,sprites:s.spriteCount,fallbacks:s.fallbackCount,modelInstances:actors.hippies.levels.reduce((n,l)=>n+l.mesh.count,0)};});assert.equal(result.atlasFailure.atlasReady,false);assert.equal(result.atlasFailure.sprites,0);assert.ok(result.atlasFailure.fallbacks>0);assert.ok(result.atlasFailure.modelInstances>0);await failed.page.screenshot({path:join(OUT,'atlas-failure-3d-fallback.png')});await failed.context.close();
  assert.deepEqual(result.errors,[]);result.completed=true;
} catch(error) {result.error=String(error.stack??error);console.error(error);process.exitCode=1;if(activePage&&!activePage.isClosed())await activePage.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});
} finally {await browser?.close();server.close();writeFileSync(join(OUT,'result.json'),JSON.stringify(result,null,2));}
