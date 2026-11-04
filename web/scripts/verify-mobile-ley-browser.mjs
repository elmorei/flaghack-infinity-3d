/** Actual paired GPU shader comparison on seeded starting loops.
 * Mobile is browser emulation, not physical-device certification. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), {chromium}=require('playwright');
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/mobile-ley-smoke');
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
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Real seeded starting flag loops. Before/after captures swap only the old distance term in the actual LeyLayer vertex shader, synchronously at identical world/camera/time. Numeric pixel comparison isolates the production LeyLayer mesh on black; screenshots show the full production canvas.',scenarios:[]};
const specs=[
  {name:'phone-portrait',width:390,height:844,dpr:1,mobile:true},
  {name:'small-phone',width:320,height:568,dpr:2,mobile:true},
  {name:'phone-landscape',width:844,height:390,dpr:1,mobile:true},
  {name:'desktop-command',width:1280,height:800,dpr:1,mobile:false},
];
let browser,page;
async function compare(label,mobile){
  const result=await page.evaluate(()=>{
    const app=window.flaghack,r=app.renderer,renderer=r.renderer,ctx=r.ctx,camera=ctx.camera;
    const survey=r.modules.find(m=>m.ley&&m.u&&m.data),mesh=survey?.ley.mesh;
    if(!mesh?.visible)throw Error('Visible production LeyLayer required');
    const material=mesh.material,fixed=material.vertexShader;
    const newTerm='2.5 * uPx * pixelDepth / fhProjScale()',oldTerm='2.5 * uPx * dist / fhProjScale()';
    if(!fixed.includes(newTerm)||!fixed.includes('projectionMatrix[3][3] > 0.5'))throw Error('Projection-aware shader missing');
    const old=fixed.replace(newTerm,oldTerm),u=material.uniforms;
    const height=u.uResolution.value.y,width=u.uResolution.value.x,px=u.uPx.value,proj=camera.projectionMatrix.elements;
    const scale=proj[5]*.5*height,ortho=proj[15]>.5,edges=survey.data.edgeTex.image.data,nodes=survey.data.nodeTex.image.data,ends=mesh.geometry.getAttribute('iEnds');
    const samples=[];
    for(let i=0;i<survey.data.edgeCount;i++){
      if(edges[i*4]<0)continue;
      const a=Math.round(ends.getX(i)),b=Math.round(ends.getY(i));
      const x=(nodes[a*4]+nodes[b*4])*.5,z=(nodes[a*4+1]+nodes[b*4+1])*.5;
      const p=camera.position.clone().set(x,ctx.world.collision.groundHeight(x,z)+1.35,z),screen=p.clone().project(camera);
      if(Math.abs(screen.x)>.9||Math.abs(screen.y)>.9||screen.z< -1||screen.z>1)continue;
      const dist=camera.position.distanceTo(p),t=Math.max(0,Math.min(1,(dist-2)/14)),near=t*t*(3-2*t);
      const floor=.3*(1+u.uViewBlend.value*1.4)*(.4+.6*near),newMin=2.5*px*(ortho?1:dist)/scale,oldMin=2.5*px*dist/scale;
      samples.push({dist,floor,newMin,oldMin,newWidth:Math.max(floor,newMin),oldWidth:Math.max(floor,oldMin),cssMinimum:newMin*scale/(px*(ortho?1:dist))});
    }
    const scene=ctx.scene,target=renderer.getRenderTarget(),background=scene.background,alpha=renderer.getClearAlpha();
    const color=renderer.getClearColor(u.uFactionColor.value[0].clone());
    const visible=scene.children.map(o=>[o,o.visible]),shadowAuto=renderer.shadowMap.autoUpdate;
    const rt=r.warmTarget.clone();rt.setSize(width,height);
    const variants=[];
    const restoreScene=()=>{for(const [o,v]of visible)o.visible=v;scene.background=background;renderer.setClearColor(color,alpha);};
    try{
      renderer.shadowMap.autoUpdate=false;
      for(const shader of [old,fixed]){
        restoreScene();material.vertexShader=shader;material.needsUpdate=true;
        renderer.setRenderTarget(null);
        if(r.post)r.post.render(0);else renderer.render(scene,camera);
        const png=renderer.domElement.toDataURL('image/png');
        // Retain the actual beam and its ground strip, not a recreated shader fixture.
        for(const [o]of visible)o.visible=o===mesh;
        scene.background=null;renderer.setClearColor(0,1);renderer.setRenderTarget(rt);renderer.clear();renderer.render(scene,camera);
        const pixels=new Uint8Array(width*height*4);renderer.readRenderTargetPixels(rt,0,0,width,height,pixels);
        variants.push({png,pixels});
      }
      let beforeLit=0,afterLit=0,changedChannels=0,maxDifference=0;
      for(let i=0;i<variants[0].pixels.length;i+=4){
        if(Math.max(...variants[0].pixels.subarray(i,i+3))>80)beforeLit++;
        if(Math.max(...variants[1].pixels.subarray(i,i+3))>80)afterLit++;
        for(let j=0;j<3;j++){const d=Math.abs(variants[0].pixels[i+j]-variants[1].pixels[i+j]);if(d)changedChannels++;maxDifference=Math.max(maxDifference,d);}
      }
      return{ortho,width,height,px,projectionScale:scale,samples,beforeLit,afterLit,changedChannels,maxDifference,glError:renderer.getContext().getError(),before:variants[0].png,after:variants[1].png};
    }finally{material.vertexShader=fixed;material.needsUpdate=true;restoreScene();renderer.shadowMap.autoUpdate=shadowAuto;renderer.setRenderTarget(target);rt.dispose();}
  });
  for(const phase of ['before','after']){writeFileSync(join(OUT,`${label}-${phase}.png`),Buffer.from(result[phase].split(',')[1],'base64'));delete result[phase];}
  assert.equal(result.ortho,mobile);assert.ok(result.samples.length>0,'Real owned flag loops must be visible');assert.equal(result.glError,0);
  for(const sample of result.samples){
    assert.ok(Math.abs(sample.cssMinimum-2.5)<1e-6,'Minimum width is 2.5 CSS pixels, not total width');
    if(mobile){assert.ok(sample.oldWidth>sample.newWidth*3);assert.ok(sample.newWidth<1);}else assert.equal(sample.oldWidth,sample.newWidth);
  }
  if(mobile){assert.ok(result.beforeLit>result.afterLit*1.15,`Visible broad band removed: ${result.beforeLit} -> ${result.afterLit}`);assert.ok(result.afterLit>0);assert.ok(result.changedChannels>0);}
  else assert.equal(result.maxDifference,0,'Perspective before/after production shader pixels must match exactly');
  return{label,...result};
}
try{
  mkdirSync(OUT,{recursive:true});await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  for(const spec of specs){
    const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},isMobile:spec.mobile,hasTouch:spec.mobile,deviceScaleFactor:spec.dpr,...(spec.mobile?{userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'}:{})});
    page=await context.newPage();const entry={name:spec.name,requestedDpr:spec.dpr,errors:[],comparisons:[]};results.scenarios.push(entry);
    page.on('pageerror',e=>entry.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/WebGL|shader|GL_INVALID/i.test(m.text()))entry.errors.push(m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
    if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
    await page.locator('#startup').waitFor({state:'detached'});
    await page.evaluate(()=>{const a=window.flaghack;a.startMatch({seed:'mobile-hud-native',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0,1,2,3],bossMode:false,days:3,maxSignifiers:0}});});
    await page.waitForFunction(()=>{const a=window.flaghack;return a.session.screen==='playing'&&a.world.time>1&&a.session.viewBlend===1&&!a.controls.freshWorld&&a.renderer.ctx;});
    // A wall-clock delay can expire while the native renderer is still finishing
    // the title-to-command camera transition, especially on a high-DPR viewport.
    // Observe the production rig/projection instead of sampling a perspective frame.
    await page.waitForFunction(expected=>{
      const a=window.flaghack,c=a.renderer.ctx.camera,rig=a.controls.rig;
      return rig.mode==='play'&&rig.transT>=rig.transDur
        &&(c.projectionMatrix.elements[15]>.5)===expected;
    },spec.mobile,{timeout:30000});
    entry.comparisons.push(await compare(spec.name,spec.mobile));
    if(spec.name==='phone-portrait'){
      await page.setViewportSize({width:844,height:390});await page.waitForTimeout(900);
      const resized=await compare('phone-resized-landscape',true);entry.comparisons.push(resized);
      assert.ok(Math.abs(resized.samples[0].newMin-entry.comparisons[0].samples[0].newMin)<1e-6,'Orthographic CSS width floor survives resize');
    }
    if(!spec.mobile)for(const height of [30,260]){
      await page.evaluate(h=>{window.flaghack.session.camera.cmdHeight=h;},height);await page.waitForTimeout(1600);
      entry.comparisons.push(await compare(`desktop-zoom-${height}`,false));
    }
    assert.deepEqual(entry.errors,[]);await context.close();page=null;
  }
  results.completed=true;
}catch(error){results.error=String(error?.stack||error);if(page)await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});throw error;
}finally{writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));await browser?.close();server.close();}
