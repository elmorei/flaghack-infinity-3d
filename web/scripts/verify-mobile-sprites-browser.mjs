/** Native, sandboxed Chrome QA of the exact dist build. Never deploys.
 * Natural UI-started matches are tested first. Explicit offline render fixtures then
 * stage animation, composition, occlusion and a 256-unit neutral crowd. They are not gameplay
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
const {spritePixelBounds}=require('./sprite-pixel-bounds.cjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), DIST = join(ROOT, 'dist');
const ACTIONS=JSON.parse(readFileSync(join(ROOT,'src/render/actors/mobileSpriteActions.json'),'utf8'));
const OUT = join(ROOT, 'host-release/mobile-sprites-smoke'), PROJECT = '/flaghack-infinity-3d/';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4','.woff2':'font/woff2','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'};
const result = {completed:false, physicalDeviceTest:false, fixtureDisclosure:'Natural production title/lobby starts precede explicitly staged offline renderer composition, occlusion and 256-unit neutral crowd fixtures. Pixel checks read the real native WebGL scene render target, before post-processing. Timings measure this runner, not a phone. Separate real mixed-client protocol verifier is required by the workflow.',environment:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,commit:process.env.GITHUB_SHA ?? null},scenarios:[],errors:[]};
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
  if(spec.blockAtlas)await page.route(/\/assets\/mobile-sprites\/.*\.webp(?:\?.*)?$/,route=>route.abort());
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
    const meshes=()=>s.meshes??[s.mesh];
    const contribution=()=>{const saved=meshes().map(m=>[m,m.visible]);try{for(const [m] of saved)m.visible=false;const without=draw();for(const [m] of saved)m.visible=true;return diff(without,draw());}finally{for(const [m,v] of saved)m.visible=v;}};
    const models=()=>{const actors=g.modules.find(m=>m.hippies&&m.avatars),visible=o=>{for(let n=o;n;n=n.parent)if(!n.visible)return false;return true;},names=[];ctx.scene.traverse(o=>{if((/^actors-avatar-\d+(?:-xray)?$/.test(o.name)||/^rts-seated-avatar-\d+$/.test(o.name)||o.name==='frick-frack-wizard'||o.name==='boss-model-32m')&&visible(o))names.push(o.name);});return {visibleMappedModels:names,hippieInstances:actors.hippies.levels.reduce((n,l)=>n+l.mesh.count,0),flagInstances:actors.flags.levels.reduce((n,l)=>n+l.meshes.reduce((v,m)=>v+m.count,0),0)};};
    const png=data=>{const canvas=document.createElement('canvas');canvas.width=innerWidth;canvas.height=innerHeight;const flipped=new Uint8ClampedArray(data.length),row=innerWidth*4;for(let y=0;y<innerHeight;y++)flipped.set(data.subarray(y*row,(y+1)*row),(innerHeight-y-1)*row);canvas.getContext('2d').putImageData(new ImageData(flipped,innerWidth,innerHeight),0,0);return canvas.toDataURL('image/png').split(',')[1];};
    window.__spriteProbe={draw,diff,contribution,png,meshes,models,dispose:()=>target.dispose()};
  });
}
async function natural(page) {
  await page.waitForFunction(()=>window.flaghack.renderer.ctx.shared.mobileSprites?.atlasReady,null,{timeout:30000});
  await page.waitForFunction(()=>window.flaghack.renderer.ctx.shared.mobileSprites.actionAtlasReady,null,{timeout:60000});
  await page.waitForFunction(()=>window.flaghack.renderer.ctx.shared.mobileSprites.spriteCount>0,null,{timeout:30000});
  await installProbe(page);
  return page.evaluate(()=>{
    const g=window.flaghack.renderer,s=g.ctx.shared.mobileSprites,gl=g.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    const actors=g.modules.find(m=>m.hippies&&m.avatars),quivers=[],seated=[],originalCast=s.cast,original=actors.avatars.pushQuiver;s.cast=function(index,pose,clip){const value=originalCast.call(this,index,pose,clip);if(clip==='seated')seated.push({faction:index,sprite:value});return value;};actors.avatars.pushQuiver=function(v,av){let pushes=0;const push=actors.flags.pushMatrix;actors.flags.pushMatrix=function(...args){pushes++;return push.apply(this,args);};try{original.call(this,v,av);}finally{actors.flags.pushMatrix=push;}quivers.push({id:av.id,carried:av.carried.length,drawnFlags:pushes});};try{g.render(0);}finally{actors.avatars.pushQuiver=original;s.cast=originalCast;}for(const q of quivers)q.sprite=s.samples.some(v=>v.id===q.id);
    return {quivers,seated,groundStatic:g.ctx.scene.getObjectByName('command-ground-static')?.visible,models:window.__spriteProbe.models(),atlasReady:s.atlasReady,atlasError:s.atlasError,sprites:s.spriteCount,layers:s.layerCount,batches:s.batchCount,changedPixels:window.__spriteProbe.contribution(),gpu:{vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)},viewport:{width:innerWidth,height:innerHeight},depthTest:s.mesh.material.depthTest,depthWrite:s.mesh.material.depthWrite};
  });
}
// Fixtures run only offline. Composition/occlusion restore camera and scene state;
// action-state fixtures restore world actors/RNG/IDs. The paused crowd page is closed after capture.
async function composition(page) {
  return page.evaluate(()=>{
    const a=window.flaghack,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    if(a.net)throw Error('Refusing fixture mutation online');
    const children=ctx.scene.children.map(o=>[o,o.visible]),camera={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom},time=ctx.time;
    try {
      for(const [o] of children)o.visible=p.meshes().includes(o);
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
// This checks the pixels, not only the uniforms: camera pitch and roll must not
// compress/tilt a sprite, and the lowest opaque source foot stays on its world anchor.
async function screenFacingFeet(page) {
  return page.evaluate(boundsSource=>{
    const a=window.flaghack,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    if(a.net)throw Error('Offline fixture only');
    const children=ctx.scene.children.map(o=>[o,o.visible]),saved={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom,time:ctx.time,background:ctx.scene.background,clearAlpha:g.renderer.getClearAlpha()};
    const checks=[],captures={};
    try {
      for(const [o] of children)o.visible=p.meshes().includes(o);
      // Near-black opaque boot outlines disappear from an RGB difference against
      // black, especially in the linear target. Measure actual alpha coverage.
      ctx.scene.background=null;g.renderer.setClearAlpha(0);
      c.top=4;c.bottom=-4;c.left=-4*innerWidth/innerHeight;c.right=-c.left;c.updateProjectionMatrix();
      const bounds=Function('return ('+boundsSource+')')();
      for(const kind of ['signifier',0,1,2,3,4,5])for(const direction of ['front','away'])for(let frame=0;frame<4;frame++) {
        const views=[];
        for(const [name,pitch,roll] of [['level',0,0],['pitched',1.05,0],['rolled',.65,.5]]) {
          c.position.set(0,Math.sin(pitch)*20,Math.cos(pitch)*20);c.lookAt(0,0,0);c.rotateZ(roll);c.updateMatrixWorld();ctx.time=frame*.14+.001;
          s.begin();s.end();const blank=p.draw(),pose={id:0,x:0,y:0,z:0,yaw:direction==='front'?0:Math.PI,height:3,moving:true};
          if(kind==='signifier')s.signifier(pose,0,0);else s.cast(kind,pose);s.end();
          if(blank.some((v,i)=>i%4===3&&v!==0))throw Error('Foot fixture requires a transparent empty target');
          const pixels=p.draw(),box=bounds(blank,pixels,innerWidth,innerHeight),anchor=c.position.clone().set(0,0,0).project(c);
          views.push({name,...box,footError:box.minY-(anchor.y+1)*innerHeight*.5});
          if(kind==='signifier'&&direction==='front'&&frame===0)captures[name]=p.png(pixels);
        }
        checks.push({kind,direction,frame,views});
      }
      return {checks,captures};
    } finally {ctx.time=saved.time;ctx.scene.background=saved.background;g.renderer.setClearAlpha(saved.clearAlpha);for(const [o,v] of children)o.visible=v;c.position.copy(saved.position);c.quaternion.copy(saved.quaternion);Object.assign(c,{left:saved.left,right:saved.right,top:saved.top,bottom:saved.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);}
  },spritePixelBounds.toString());
}
// Verify every shipped action clip is selected and really contributes both facing
// rows and every frame. Missing-clip behavior is tested separately below.
async function actionClips(page) {
  return page.evaluate(manifest=>{
    const g=window.flaghack.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    if(window.flaghack.net)throw Error('Offline fixture only');
    const children=ctx.scene.children.map(o=>[o,o.visible]),saved={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom,time:ctx.time};
    const casts=['dr-beef-supreme','beelzebub-crow','dj-scarecrow','president-jaguar','frick-frack-wizard','skeletal-boss'],clips=[],captures={};
    try {
      for(const [o] of children)o.visible=p.meshes().includes(o);
      c.position.set(0,6,12);c.lookAt(0,0,0);c.top=4;c.bottom=-4;c.left=-4*innerWidth/innerHeight;c.right=-c.left;c.updateProjectionMatrix();c.updateMatrixWorld();
      for(const [key,clip] of Object.entries(manifest.clips)) {
        const split=key.lastIndexOf(':'),kind=key.slice(0,split),name=key.slice(split+1),rows=[];
        for(const direction of ['front','away']) {
          const shots=[];
          for(let frame=0;frame<clip.columns;frame++) {
            const t=frame*clip.frameDurationMs/1000+.001,pose={id:0,x:0,y:0,z:0,yaw:direction==='front'?0:Math.PI,height:3,moving:true,animationTime:t};ctx.time=t;s.begin();
            const accepted=kind==='signifier'?s.signifier(pose,0,0,name):kind==='flag'?s.flag(pose,name):s.cast(casts.indexOf(kind),pose,name);s.end();
            const pixels=p.draw();shots.push({pixels,accepted,contribution:p.contribution(),sample:s.samples[0],fallbacks:s.fallbackCount});
          }
          captures[key.replace(':','-')+'-'+direction]=p.png(shots[0].pixels);
          rows.push({direction,shots:shots.map(({pixels,...shot})=>shot),frameDeltas:shots.slice(1).map((shot,i)=>p.diff(shots[i].pixels,shot.pixels)),first:shots[0].pixels});
        }
        clips.push({key,rows:rows.map(({first,...row})=>row),directionDelta:p.diff(rows[0].first,rows[1].first)});
      }
      const missing=[];for(const kind of ['signifier',0,1,2,3,4,5]){s.begin();const pose={id:0,x:0,y:0,z:0,yaw:0,height:3,moving:false},name='unknown-qa-action';const accepted=kind==='signifier'?s.signifier(pose,0,0,name):s.cast(kind,pose,name);s.end();missing.push({kind,accepted,pixels:p.contribution(),sample:s.samples[0],fallbacks:s.fallbackCount});}
      return {clips,missing,captures};
    } finally {ctx.time=saved.time;for(const [o,v] of children)o.visible=v;c.position.copy(saved.position);c.quaternion.copy(saved.quaternion);Object.assign(c,{left:saved.left,right:saved.right,top:saved.top,bottom:saved.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);}
  },ACTIONS);
}
async function occlusion(page) {
  return page.evaluate(()=>{
    const g=window.flaghack.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    const renderOrders=p.meshes().map(m=>[m,m.renderOrder]),children=ctx.scene.children.map(o=>[o,o.visible]),saved={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom};
    const ground=ctx.scene.getObjectByName('ground');
    const structures=g.modules.find(m=>m.views instanceof Map&&m.kit&&m.table);
    const root=structures&&[...structures.views.values()].find(v=>v.kind==='gcc'&&v.root.visible)?.root;
    if(!ground||!root)throw Error('Real ground and command-cart geometry required for occlusion proof');
    const cases=[];
    try {
      // Draw after opaque occluders in BOTH passes. Without this, the depth-disabled
      // control can be overwritten by subsequently drawn geometry and is not a control.
      for(const [m] of renderOrders)m.renderOrder=10000;
      for(const [label,object] of [['terrain',ground],['building',root]])for(const kind of ['signifier','seated']) {
        for(const [o] of children)o.visible=false;
        for(let o=object;o;o=o.parent)o.visible=true;
        for(const m of p.meshes())m.visible=true;
        const origin=object.getWorldPosition(c.position.clone());
        // Place the sprite inside/below the actual rendered occluder, not a synthetic overlay.
        // GCC has a solid body from local y=.3 to .96. A small probe inside it
        // avoids mistaking the open centre of a Hearth for an opaque building.
        const y=label==='terrain'?(ctx.shared.groundOffset?.(0,0)??0)-4:origin.y+.32;
        const height=label==='terrain'?2:.6,extent=label==='terrain'?4:1.5;
        const x=label==='terrain'?0:origin.x,z=label==='terrain'?0:origin.z;
        c.position.set(x,y+10,z+12);c.lookAt(x,y+height*.5,z);c.left=-extent;c.right=extent;c.top=extent*innerHeight/innerWidth;c.bottom=-c.top;c.updateProjectionMatrix();c.updateMatrixWorld();
        s.begin();
        if(kind==='seated')s.cast(0,{id:0,x,y,z,yaw:0,height,moving:false,depthProfile:'upright'},'seated');
        else s.signifier({id:0,x,y,z,yaw:0,height,moving:false},0,0);
        s.end();
        const depthPixels=p.contribution();for(const m of p.meshes())m.material.depthTest=false;const throughPixels=p.contribution();for(const m of p.meshes())m.material.depthTest=true;
        cases.push({label,kind,depthPixels,throughPixels});
      }
      return cases;
    } finally {for(const [m,order] of renderOrders){m.renderOrder=order;m.material.depthTest=true;}for(const [o,v] of children)o.visible=v;c.position.copy(saved.position);c.quaternion.copy(saved.quaternion);Object.assign(c,{left:saved.left,right:saved.right,top:saved.top,bottom:saved.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);}
  });
}
// Readable user demo, rendered by the actual production game and post-processing.
// This is explicitly staged offline: camera framing and a few nearby actors/Flags only.
async function demoRender(page) {
  const info=await page.evaluate(()=>{
    const a=window.flaghack,w=a.world,g=a.renderer,c=g.ctx.camera;
    if(a.net)throw Error('Offline demo only');
    const altar=w.hearthOf(a.session.playerFaction);if(!altar)throw Error('Demo requires a live throne altar');
    const saved={controls:a.controls.update,step:a.stepLocal,camera:{position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom},rng:{...w.rng},nextEntityId:w.nextEntityId};
    a.controls.update=()=>{};a.stepLocal=()=>{};
    const units=[],flags=[],x=altar.pos.x,z=altar.pos.z;
    // The throne faces the effigy. Frame its front rather than its opaque back
    // banners, and arrange the offline demonstration along that same local axis.
    const yaw=Math.atan2(w.map.effigy.x-x,w.map.effigy.z-z),sn=Math.sin(yaw),cs=Math.cos(yaw);
    const local=(dx,dz)=>({x:x+dx*cs+dz*sn,z:z-dx*sn+dz*cs});
    for(const [i,status] of ['idle','chopping','building','fighting','drumming','distracted'].entries()){
      const h=window.fh.factory.spawnHippie(w,-1,local((i%3-1)*2.3,4+Math.floor(i/3)*3));h.status=status;h.facing=yaw;units.push(h.id);
    }
    for(const [dx,dz,state] of [[-3.1,2,'planted'],[3.1,2,'planted'],[2.7,6.5,'loose']]){
      const pos=local(dx,dz),f=window.fh.factory.spawnFlag(w,{state,owner:a.session.playerFaction,pos:{...pos,y:w.collision.groundHeight(pos.x,pos.z)}});flags.push(f.id);
    }
    const gy=w.collision.groundHeight(x,z),eye=local(0,24),look=local(0,2.5);c.position.set(eye.x,gy+18,eye.z);c.lookAt(look.x,gy+1.5,look.z);c.top=8;c.bottom=-8;c.left=-8*innerWidth/innerHeight;c.right=-c.left;c.updateProjectionMatrix();c.updateMatrixWorld();g.render(.1);
    window.__restoreSpriteDemo=()=>{for(const id of units)w.hippies.delete(id);for(const id of flags)w.flags.delete(id);Object.assign(w.rng,saved.rng);w.nextEntityId=saved.nextEntityId;a.controls.update=saved.controls;a.stepLocal=saved.step;c.position.copy(saved.camera.position);c.quaternion.copy(saved.camera.quaternion);Object.assign(c,{left:saved.camera.left,right:saved.camera.right,top:saved.camera.top,bottom:saved.camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);delete window.__restoreSpriteDemo;};
    return {stagedOffline:true,actualGameRenderer:true,productionPostProcessing:true,description:'Close-up offline demo of a real throne, six action-state signifiers and three sprite Flags. Camera/actors staged for readability; mobile HUD and production renderer are unchanged.',units:units.length,flags:flags.length,throneFaction:a.session.playerFaction};
  });
  try {
    await page.waitForTimeout(1800);
    const proof=await page.evaluate(()=>{
      const a=window.flaghack,g=a.renderer,s=g.ctx.shared.mobileSprites,p=window.__spriteProbe,id=-100000-a.session.playerFaction;
      const furniture=g.ctx.scene.getObjectByName('rts-ruler-'+a.session.playerFaction);
      if(!furniture)throw Error('Demo requires the actual throne furniture for visibility comparison');
      const seated=s.samples.filter(sample=>sample.requestedClip==='seated'),original=s.cast,before=p.draw(),furnitureVisible=furniture.visible;let seatedPixels,seatedUnoccludedPixels,unoccluded;
      try {
        furniture.visible=false;unoccluded=p.draw();furniture.visible=furnitureVisible;
        s.cast=function(index,pose,clip){return pose.id===id&&clip==='seated'?true:original.call(this,index,pose,clip);};
        g.render(0);seatedPixels=p.diff(before,p.draw());
        furniture.visible=false;seatedUnoccludedPixels=p.diff(unoccluded,p.draw());
      } finally {furniture.visible=furnitureVisible;s.cast=original;g.render(0);}
      return {models:p.models(),groundStatic:g.ctx.scene.getObjectByName('command-ground-static')?.visible,seated,seatedPixels,seatedUnoccludedPixels,seatedVisibleFraction:seatedPixels/Math.max(1,seatedUnoccludedPixels),seatedId:id,captures:{furniture:p.png(before),unoccluded:p.png(unoccluded)}};
    });
    for(const [name,data] of Object.entries(proof.captures))writeFileSync(join(OUT,'demo-seated-'+name+'.png'),Buffer.from(data,'base64'));delete proof.captures;
    await page.screenshot({path:join(OUT,'mobile-flat-sprites-demo.png')});
    writeFileSync(join(OUT,'demo-proof.json'),JSON.stringify({...info,...proof},null,2));
    assert.equal(proof.groundStatic,false);assert.deepEqual(proof.models.visibleMappedModels,[]);assert.equal(proof.models.hippieInstances,0);assert.equal(proof.models.flagInstances,0);
    assert.ok(proof.seated.some(s=>s.id===proof.seatedId&&s.clip==='seated'&&s.direction==='front'),'Demo must show real front-facing seated sprite art');
    assert.ok(proof.seatedPixels>20,'Seated sprite must contribute visible scene pixels, not only submit a hidden draw');
    assert.ok(proof.seatedUnoccludedPixels>50&&proof.seatedVisibleFraction>.6,'A clear majority of the front-facing seated character must remain visible around its furniture');
    return {...info,...proof};
  }
  finally {await page.evaluate(()=>window.__restoreSpriteDemo?.());}
}
async function actionStates(page) {
  return page.evaluate(()=>{
    const a=window.flaghack,w=a.world,g=a.renderer,s=g.ctx.shared.mobileSprites;
    if(a.net)throw Error('Offline fixture only');
    const original=new Map(w.hippies),screen=a.session.screen,rng={...w.rng},nextEntityId=w.nextEntityId;a.setPaused(true);w.hippies.clear();
    const center=a.session.camera;
    const h=window.fh.factory.spawnHippie(w,0,{x:center.cmdX,z:center.cmdZ});
    const actors=g.modules.find(m=>m.hippies&&m.avatars),states=[],originalSignifier=s.signifier;let drawn=false;
    s.signifier=function(p,...args){const value=originalSignifier.call(this,p,...args);if(p.id===h.id)drawn=value;return value;};
    try {
      for(const status of ['idle','responding','hauling','chopping','planting','pulling','building','repairing','fighting','tearing','drumming','defending','distracted','ko','unknown-qa-state']) {
        h.status=status;h.koUntil=status==='ko'?w.time+10:0;drawn=false;g.render(0);
        states.push({status,sprite:drawn,fallbackCount:s.fallbackCount,modelInstances:actors.hippies.levels.reduce((n,l)=>n+l.mesh.count,0),sample:s.samples.find(v=>v.id===h.id)});
      }
      return states;
    } finally {s.signifier=originalSignifier;w.hippies.clear();for(const [id,h] of original)w.hippies.set(id,h);Object.assign(w.rng,rng);w.nextEntityId=nextEntityId;a.session.screen=screen;g.render(0);}
  });
}
async function crowd(page,faction=-1) {
  const staged=await page.evaluate(faction=>{
    const a=window.flaghack,w=a.world;if(a.net)throw Error('Offline fixture only');a.setPaused(true);
    const center={x:a.session.camera.cmdX,z:a.session.camera.cmdZ};
    for(const id of window.__crowdIds??[])w.hippies.delete(id);
    // Use the real neutral-unit factory: a dense grid of recruited units stacks
    // 256 always-visible D.E.G.E.N. status badges over the sprites being measured.
    // Neutral units are an ordinary gameplay state with no beacon badge.
    const ids=[];for(let i=0;i<256;i++){const h=window.fh.factory.spawnHippie(w,faction,{x:center.x+(i%16-7.5)*.65,z:center.z+(Math.floor(i/16)-7.5)*.65});h.status='idle';ids.push(h.id);}
    window.__crowdIds=ids;return {count:ids.length,center,faction:faction===-1?'neutral':'friendly',beaconBadges:faction!==-1};
  },faction);
  await page.waitForTimeout(1500);
  const timing=await page.evaluate(async()=>{
    const g=window.flaghack.renderer,s=g.ctx.shared.mobileSprites,intervals=[],renderMs=[],calls=[],spriteCalls=[];
    const previousReset=g.renderer.info.autoReset,previousBefore=(s.meshes??[s.mesh]).map(m=>[m,m.onBeforeRender]),previousRender=g.render;
    let previousStart,activeDraws=0,timer;
    try {
      g.renderer.info.autoReset=false;
      for(const [mesh,before] of previousBefore)mesh.onBeforeRender=function(...args){activeDraws++;return before.apply(this,args);};
      // Observe the app's one real render per frame. Calling render again from a rAF
      // probe would double GPU/CPU work and misrepresent ordinary frame intervals.
      await new Promise((done,reject)=>{
        timer=setTimeout(()=>reject(Error('Timed out collecting 120 actual app frame intervals')),90000);
        g.render=function(...args){
          activeDraws=0;g.renderer.info.reset();const start=performance.now();
          try {
            const drawn=previousRender.apply(this,args);
            if(drawn){
              if(previousStart!==undefined)intervals.push(start-previousStart);
              previousStart=start;renderMs.push(performance.now()-start);
              calls.push(g.renderer.info.render.calls);spriteCalls.push(activeDraws);
              if(intervals.length>=120)done();
            }
            return drawn;
          }catch(error){reject(error);throw error;}
        };
      });
    } finally {clearTimeout(timer);g.render=previousRender;g.renderer.info.autoReset=previousReset;for(const [mesh,before] of previousBefore)mesh.onBeforeRender=before;}
    const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))];
    return {sprites:s.spriteCount,layers:s.layerCount,batches:s.batchCount,meshCount:(s.meshes??[s.mesh]).length,capacity:s.capacity,frameMs:{median:percentile(intervals,.5),p95:percentile(intervals,.95),max:Math.max(...intervals)},renderCpuMs:{median:percentile(renderMs,.5),p95:percentile(renderMs,.95)},wholeFrameDrawCalls:{min:Math.min(...calls),max:Math.max(...calls)},spriteDrawCalls:{min:Math.min(...spriteCalls),max:Math.max(...spriteCalls)},sampleCount:intervals.length};
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
    entry.naturalVideoStartSeconds=(Date.now()-started)/1000;entry.natural=await natural(page);assert.ok(entry.natural.quivers.some(q=>q.sprite&&q.carried>0&&q.drawnFlags===q.carried),'Natural sprite avatars retain exact Flag inventory');assert.ok(entry.natural.changedPixels>4,'Naturally visible sprites must change actual framebuffer pixels');assert.equal(entry.natural.groundStatic,false,'Mobile decorative static stays hidden');assert.equal(entry.natural.depthTest,true);assert.equal(entry.natural.depthWrite,true);assert.ok(entry.natural.batches>=1);assert.ok(entry.natural.seated.length>0&&entry.natural.seated.every(r=>r.sprite),'Seated rulers use sprites while furniture may remain 3D');assert.deepEqual(entry.natural.models.visibleMappedModels,[]);assert.equal(entry.natural.models.hippieInstances,0);assert.equal(entry.natural.models.flagInstances,0);assert.ok(atlasRequests.length>0);
    await page.screenshot({path:join(OUT,spec.name+'-natural.png')});
    if(spec.name==='portrait'){await page.waitForTimeout(4000);entry.demo=await demoRender(page);}entry.fixtureStartSeconds=(Date.now()-started)/1000;entry.composition=await composition(page);for(const [name,data] of Object.entries(entry.composition.captures))writeFileSync(join(OUT,spec.name+'-fixture-'+name+'.png'),Buffer.from(data,'base64'));delete entry.composition.captures;for(const value of Object.values(entry.composition.frames)){assert.ok(value.pixels.every(n=>n>20));assert.ok(value.deltas.every(n=>n>0),'Each walking frame must visibly change');}assert.ok(entry.composition.directionDelta>0);assert.ok(entry.composition.headDelta>0);assert.equal(entry.composition.rearFlagLayers,3);assert.ok(entry.composition.rearFlagForegroundPixels>0);assert.equal(entry.composition.idleDelta,0);for(const cast of entry.composition.casts){assert.ok(cast.pixels.every(n=>n>20));assert.ok(cast.frontDeltas.every(n=>n>0));assert.ok(cast.awayDeltas.every(n=>n>0));assert.ok(cast.directionDelta>0);}
    entry.screenFacingFeet=await screenFacingFeet(page);for(const [name,data] of Object.entries(entry.screenFacingFeet.captures))writeFileSync(join(OUT,spec.name+'-screen-facing-'+name+'.png'),Buffer.from(data,'base64'));delete entry.screenFacingFeet.captures;for(const check of entry.screenFacingFeet.checks){const baseline=check.views[0];for(const v of check.views){assert.ok(v.count>20,check.kind+' '+v.name+' contributes pixels');assert.ok(Math.abs(v.footError)<=3,check.kind+' '+check.direction+' frame '+check.frame+' foot remains at projected anchor');assert.ok(Math.abs(v.width-baseline.width)<=2&&Math.abs(v.height-baseline.height)<=2,check.kind+' remains screen-facing through camera pitch and roll');}}
    if(spec.name==='portrait'){entry.actionClips=await actionClips(page);assert.equal(entry.actionClips.clips.length,Object.keys(ACTIONS.clips).length);assert.ok(entry.actionClips.clips.length>0,'Supplemental actions must ship');for(const [name,data] of Object.entries(entry.actionClips.captures))writeFileSync(join(OUT,'action-'+name+'.png'),Buffer.from(data,'base64'));delete entry.actionClips.captures;for(const clip of entry.actionClips.clips){const name=clip.key.slice(clip.key.lastIndexOf(':')+1);for(const row of clip.rows)for(const [frame,shot] of row.shots.entries()){assert.equal(shot.accepted,true,clip.key);assert.ok(shot.contribution>20,clip.key+' has real pixels');assert.equal(shot.fallbacks,0,clip.key+' selects generated action');assert.equal(shot.sample?.clip,name,clip.key+' selects requested clip');assert.equal(shot.sample?.frame,frame,clip.key+' advances every animation frame');}}for(const missing of entry.actionClips.missing){assert.equal(missing.accepted,true);assert.ok(missing.pixels>20);assert.equal(missing.sample?.clip,'idle');assert.ok(missing.fallbacks>0);}}
    entry.occlusion=await occlusion(page);for(const o of entry.occlusion){assert.ok(o.throughPixels>20,o.label+' control pixels');assert.ok(o.depthPixels<o.throughPixels*.8,o.label+' must genuinely occlude sprites');}
    entry.actionStates=await actionStates(page);for(const f of entry.actionStates){assert.equal(f.sprite,true,f.status+' remains a sprite');assert.equal(f.modelInstances,0,f.status+' never restores 3D body instances');}
    entry.crowd=await crowd(page);assert.ok(entry.crowd.sprites>=200,'200+ actual integrated visible sprites');assert.ok(entry.crowd.batches>=1);assert.ok(entry.crowd.spriteDrawCalls.max<=entry.crowd.meshCount,'Crowd uses at most one GPU draw per atlas page');assert.ok(entry.crowd.layers<=entry.crowd.capacity);assert.ok(Number.isFinite(entry.crowd.frameMs.p95));
    const crowdCapture=await page.evaluate(()=>{
      const g=window.flaghack.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
      const captures={scene:p.png(p.draw())},changedPixels=p.contribution();
      const children=ctx.scene.children.map(o=>[o,o.visible]),depth=p.meshes().map(m=>[m,m.material.depthTest]);
      let spriteOnlyPixels,throughPixels;
      try {
        for(const [m] of depth)m.material.depthTest=false;throughPixels=p.contribution();captures.through=p.png(p.draw());for(const [m,v] of depth)m.material.depthTest=v;
        for(const [o] of children)o.visible=p.meshes().includes(o);
        spriteOnlyPixels=p.contribution();captures.sprites=p.png(p.draw());
      } finally {for(const [m,v] of depth)m.material.depthTest=v;for(const [o,v] of children)o.visible=v;}
      const projected=window.__crowdIds.map(id=>{const h=ctx.world.hippies.get(id),v=c.position.clone().set(h.pos.x,ctx.shared.groundOffset(h.pos.x,h.pos.z)+1,h.pos.z).project(c);return {x:v.x,y:v.y,z:v.z};});
      return {changedPixels,spriteOnlyPixels,throughPixels,captures,camera:{type:c.type,position:c.position.toArray(),quaternion:c.quaternion.toArray(),left:c.left,right:c.right,top:c.top,bottom:c.bottom},projected};
    });
    for(const [name,png] of Object.entries(crowdCapture.captures))writeFileSync(join(OUT,spec.name+'-256-unit-fixture-'+name+'.png'),Buffer.from(png,'base64'));
    delete crowdCapture.captures;Object.assign(entry.crowd,crowdCapture);
    assert.ok(crowdCapture.changedPixels>500,'Crowd must contribute actual framebuffer pixels');
    await page.screenshot({path:join(OUT,spec.name+'-crowd-paused-ui.png')});
    // Also retain the actual friendly/beacon workload. Dense badges intentionally
    // overlap; prove their full-scene contribution rather than require hidden pixels.
    entry.beaconCrowd=await crowd(page,0);
    assert.ok(entry.beaconCrowd.sprites>=200);assert.ok(entry.beaconCrowd.batches>=1);
    assert.ok(entry.beaconCrowd.spriteDrawCalls.max<=entry.beaconCrowd.meshCount);assert.ok(Number.isFinite(entry.beaconCrowd.frameMs.p95));
    const beaconCapture=await page.evaluate(()=>{
      const g=window.flaghack.renderer,p=window.__spriteProbe,icons=g.ctx.scene.getObjectByName('actors-status-icons');
      const pixels=p.draw(),visible=icons.visible;let badgePixels;
      try{icons.visible=false;badgePixels=p.diff(pixels,p.draw());}finally{icons.visible=visible;}
      return {badges:icons.geometry.instanceCount,badgePixels,png:p.png(pixels),spritePixels:p.contribution()};
    });
    writeFileSync(join(OUT,spec.name+'-256-friendly-beacon-fixture.png'),Buffer.from(beaconCapture.png,'base64'));
    delete beaconCapture.png;Object.assign(entry.beaconCrowd,beaconCapture);
    assert.ok(beaconCapture.badges>=256);assert.ok(beaconCapture.badgePixels>500,'Friendly crowd retains visible status badges');
    await page.evaluate(()=>window.__spriteProbe.dispose());await context.close();
  }
  const desktop=await boot({name:'desktop',w:1440,h:900,mobile:false});result.desktop=await desktop.page.evaluate(()=>{const a=window.flaghack;return {layout:document.documentElement.dataset.deviceLayout,spriteSystem:!!a.renderer.ctx.shared.mobileSprites,spriteMesh:!!a.renderer.ctx.scene.getObjectByName('mobile-sprite-batch'),avatarMeshes:[...a.world.avatars.values()].length};});assert.equal(result.desktop.layout,'desktop');assert.equal(result.desktop.spriteSystem,false);assert.equal(result.desktop.spriteMesh,false);assert.deepEqual(desktop.atlasRequests,[],'Desktop must never load the atlas');assert.ok(result.desktop.avatarMeshes>0);await desktop.page.screenshot({path:join(OUT,'desktop-3d.png')});await desktop.context.close();
  const failed=await boot({name:'atlas-failure',w:390,h:844,mobile:true,blockAtlas:true});await failed.page.waitForFunction(()=>window.flaghack.renderer.ctx.shared.mobileSprites.atlasError);await installProbe(failed.page);result.atlasFailure=await failed.page.evaluate(()=>{const s=window.flaghack.renderer.ctx.shared.mobileSprites,p=window.__spriteProbe;return {atlasReady:s.atlasReady,sprites:s.spriteCount,fallbacks:s.fallbackCount,models:p.models(),changedPixels:p.contribution()};});assert.equal(result.atlasFailure.atlasReady,false);assert.ok(result.atlasFailure.sprites>0,'Failed texture keeps visible sprite placeholders');assert.ok(result.atlasFailure.fallbacks>0);assert.ok(result.atlasFailure.changedPixels>4);assert.deepEqual(result.atlasFailure.models.visibleMappedModels,[]);assert.equal(result.atlasFailure.models.hippieInstances,0);assert.equal(result.atlasFailure.models.flagInstances,0);await failed.page.screenshot({path:join(OUT,'atlas-failure-sprite-placeholders.png')});await failed.context.close();
  assert.deepEqual(result.errors,[]);result.completed=true;
} catch(error) {result.error=String(error.stack??error);console.error(error);process.exitCode=1;if(activePage&&!activePage.isClosed())await activePage.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});
} finally {await browser?.close();server.close();writeFileSync(join(OUT,'result.json'),JSON.stringify(result,null,2));}
