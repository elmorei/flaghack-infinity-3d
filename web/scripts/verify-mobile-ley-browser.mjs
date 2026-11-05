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
const results={completed:false,physicalDeviceTest:false,fixtureDisclosure:'Real seeded starting flag loops. Before/after captures swap only the old distance term in the actual LeyLayer vertex shader, synchronously at identical world/camera/time. Numeric Ley comparison isolates the production LeyLayer mesh on black; its screenshots show the full production canvas. Pentagram fixtures select a real five-neighbor focus in Plan, temporarily reveal it with offline Dust state, and use the production FocusFeature to emit five rays and five star edges. An actual camera clone frames that constellation at zoom 0.5/1/2. Paired isolated BeamLayer captures change only the old distance width term; individual real instance draws measure native raster thickness. All fixture state is restored. Opacity fixtures switch production mode state at a fixed camera/time, verify visible dimmed output outside Plan, and compare full Plan pixels with the legacy fragment shader.',scenarios:[]};
const specs=[
  {name:'phone-portrait',width:390,height:844,dpr:1,mobile:true},
  {name:'small-phone',width:320,height:568,dpr:2,mobile:true},
  {name:'phone-landscape',width:844,height:390,dpr:1,mobile:true},
  {name:'desktop-command',width:1280,height:800,dpr:1,mobile:false},
];
let browser,page;
/** Fixed-camera production-mesh check: mode changes alone must control opacity. */
async function verifyModeOpacity(mobile){
  const result=await page.evaluate(mobile=>{
    const app=window.flaghack,r=app.renderer,renderer=r.renderer,ctx=r.ctx,s=app.session;
    const survey=r.modules.find(m=>m.ley&&m.u&&m.data),mesh=survey.ley.mesh,material=mesh.material;
    const shader=material.fragmentShader,opacityLine='gl_FragColor *= uLeyOpacity;';
    if(!shader.includes(opacityLine))throw Error('Production ley opacity multiplier missing');
    const saved={view:s.view,mobileMode:s.mobileMode,planTool:s.planTool,tool:s.tool};
    const scene=ctx.scene,target=renderer.getRenderTarget(),background=scene.background;
    const alpha=renderer.getClearAlpha(),color=renderer.getClearColor(survey.u.uFactionColor.value[0].clone());
    const visible=scene.children.map(o=>[o,o.visible]),shadowAuto=renderer.shadowMap.autoUpdate;
    const width=survey.u.uResolution.value.x,height=survey.u.uResolution.value.y;
    const rt=r.warmTarget.clone();rt.setSize(width,height);
    const draw=()=>{renderer.setRenderTarget(rt);renderer.clear();renderer.render(scene,ctx.camera);const pixels=new Uint8Array(width*height*4);renderer.readRenderTargetPixels(rt,0,0,width,height,pixels);return pixels;};
    try{
      renderer.shadowMap.autoUpdate=false;
      for(const [o]of visible)o.visible=o===mesh;
      scene.background=null;renderer.setClearColor(0,1);
      // Legacy shader baseline differs only by removing the new opacity multiplier.
      material.fragmentShader=shader.replace(opacityLine,'');material.needsUpdate=true;
      const baseline=draw();
      material.fragmentShader=shader;material.needsUpdate=true;
      const modes=mobile
        ?[{mobileMode:'units',expected:.5},{mobileMode:'build',expected:1},{mobileMode:'units',expected:.5},{mobileMode:'build',expected:1}]
        :[{planTool:'select',expected:.5},...['node','enclose','pentacle','ring'].map(planTool=>({planTool,expected:1})),{tool:'building',expected:1},{planTool:'select',expected:.5},{view:'action',planTool:'node',expected:.5}];
      const checks=[];
      for(const mode of modes){
        const {expected,...state}=mode;
        Object.assign(s,{view:'command',mobileMode:'units',planTool:'select',tool:'flag'},state);
        survey.ley.update(s,mobile);
        const pixels=draw();let baselineEnergy=0,energy=0,maxDifference=0;
        for(let i=0;i<pixels.length;i+=4)for(let j=0;j<3;j++){baselineEnergy+=baseline[i+j];energy+=pixels[i+j];maxDifference=Math.max(maxDifference,Math.abs(pixels[i+j]-baseline[i+j]));}
        checks.push({view:s.view,mobileMode:s.mobileMode,planTool:s.planTool,tool:s.tool,expected,opacity:material.uniforms.uLeyOpacity.value,visible:mesh.visible,baselineEnergy,energy,maxDifference});
      }
      return{checks,glError:renderer.getContext().getError()};
    }finally{
      Object.assign(s,saved);survey.ley.update(s,mobile);
      material.fragmentShader=shader;material.needsUpdate=true;
      for(const [o,v]of visible)o.visible=v;
      scene.background=background;renderer.setClearColor(color,alpha);renderer.shadowMap.autoUpdate=shadowAuto;renderer.setRenderTarget(target);rt.dispose();
    }
  },mobile);
  assert.equal(result.glError,0);
  for(const check of result.checks){
    assert.equal(check.opacity,check.expected);assert.equal(check.visible,true);assert.ok(check.energy>0,'Ley lines must remain visible outside Plan');
    if(check.expected===1)assert.equal(check.maxDifference,0,'Plan pixels must match the legacy shader exactly');
    else assert.ok(check.energy<check.baselineEnergy,'Non-plan ley contribution must dim');
  }
  return result;
}
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
/** Real focus selection and real BeamLayer pixels. Only the shader distance term
 * changes between paired frames; single-edge draws use unmodified production instances. */
async function verifyFocusedPentagram(label,mobile){
  const result=await page.evaluate(()=>{
    const app=window.flaghack,r=app.renderer,renderer=r.renderer,ctx=r.ctx,s=app.session,w=app.world;
    if(app.net)throw Error('Pentagram shader fixture is offline only');
    const survey=r.modules.find(m=>m.focus&&m.beams&&m.u&&m.data),beams=survey?.beams,mesh=beams?.mesh;
    if(!mesh)throw Error('Production FocusFeature and BeamLayer required');
    const material=mesh.material,fixed=material.vertexShader;
    const newTerm='2.0 * uPx * fhPixelDepth(P) / fhProjScale()',oldTerm='2.0 * uPx * length(cameraPosition - P) / fhProjScale()';
    if(!fixed.includes(newTerm))throw Error('Projection-aware BeamLayer width missing');
    const old=fixed.replace(newTerm,oldTerm),pf=w.factions[s.playerFaction],at=w.gccOf(s.playerFaction)?.pos??w.hearthOf(s.playerFaction).pos;
    const focus=w.survey.focusNodes.filter(n=>w.lattice.nodes[n].edges.length===5).sort((a,b)=>Math.hypot(w.lattice.nodes[a].x-at.x,w.lattice.nodes[a].z-at.z)-Math.hypot(w.lattice.nodes[b].x-at.x,w.lattice.nodes[b].z-at.z))[0];
    if(focus===undefined)throw Error('A real five-neighbor focus is required');
    const neighbors=w.lattice.nodes[focus].edges.map(e=>w.lattice.other(e,focus));
    const scene=ctx.scene,target=renderer.getRenderTarget(),background=scene.background,clearAlpha=renderer.getClearAlpha(),clearColor=renderer.getClearColor(survey.u.uFactionColor.value[0].clone());
    const visibility=scene.children.map(o=>[o,o.visible]),shadowAuto=renderer.shadowMap.autoUpdate;
    const saved={view:s.view,viewBlend:s.viewBlend,mobileMode:s.mobileMode,planTool:s.planTool,tool:s.tool,hover:{...s.hover},plan:pf.plan,dust:pf.drugActive.dust,focusAlpha:survey.focus.alpha.slice()};
    const camera=ctx.camera.clone(),width=survey.u.uResolution.value.x,height=survey.u.uResolution.value.y,px=survey.u.uPx.value;
    const rt=r.warmTarget.clone();rt.setSize(width,height);
    const project=p=>{const q=p.clone().project(camera);return{x:(q.x+1)*width/2,y:(q.y+1)*height/2,z:q.z};};
    const draw=()=>{renderer.setRenderTarget(rt);renderer.clear();renderer.render(scene,camera);const pixels=new Uint8Array(width*height*4);renderer.readRenderTargetPixels(rt,0,0,width,height,pixels);return pixels;};
    const png=pixels=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d'),im=context.createImageData(width,height);for(let y=0;y<height;y++)im.data.set(pixels.subarray(y*width*4,(y+1)*width*4),(height-1-y)*width*4);context.putImageData(im,0,0);return canvas.toDataURL('image/png');};
    const lit=pixels=>{let n=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>12)n++;return n;};
    const comparisons=[],captures={};
    try{
      Object.assign(s,{view:'command',viewBlend:1,mobileMode:'build',planTool:'pentacle',tool:'flag'});s.hover.node=focus;s.hover.edge=s.hover.facet=-1;
      pf.plan=new Set(neighbors);pf.drugActive.dust=w.time+60;
      survey.u.uViewBlend.value=1;survey.decals.reset();
      // Use the actual feature to generate only the selected focus. No synthetic beams.
      beams.reset();survey.focus.update(.25,survey.decals,beams);beams.commit();
      const geometry=mesh.geometry,attributes=Object.entries(geometry.attributes).filter(([,a])=>a.isInstancedBufferAttribute).map(([name,attribute])=>({name,attribute,values:attribute.array.slice()}));
      const count=geometry.instanceCount,a=geometry.getAttribute('iA'),b=geometry.getAttribute('iB'),anchor=geometry.getAttribute('iAnchor'),nodes=survey.data.nodeTex.image.data;
      const instances=[];
      const endpoint=(attr,i,n)=>{const p=camera.position.clone().set(attr.getX(i),attr.getY(i),attr.getZ(i));if(n>=0){p.x+=nodes[n*4];p.z+=nodes[n*4+1];}p.y+=ctx.shared.groundOffset(p.x,p.z);return p;};
      for(let i=0;i<count;i++)instances.push({index:i,style:Math.round(b.getW(i)),from:Math.round(anchor.getX(i)),to:Math.round(anchor.getY(i)),worldWidth:a.getW(i),a:endpoint(a,i,Math.round(anchor.getX(i))),b:endpoint(b,i,Math.round(anchor.getY(i)))});
      const rays=instances.filter(i=>i.style===1&&i.from===focus&&neighbors.includes(i.to)),star=instances.filter(i=>i.style===0&&neighbors.includes(i.from)&&neighbors.includes(i.to));
      if(count!==10||rays.length!==5||star.length!==5)throw Error(`Focused pentagram must produce exactly five rays and five star edges: ${JSON.stringify({focus,count,rays:rays.length,star:star.length})}`);
      for(let j=0;j<5;j++)if(!star.some(i=>i.from===neighbors[j]&&i.to===neighbors[(j+2)%5]))throw Error('Star must join every second angular neighbor');
      renderer.shadowMap.autoUpdate=false;for(const[o]of visibility)o.visible=o===mesh;scene.background=null;renderer.setClearColor(0,1);
      const center=camera.position.clone().set(nodes[focus*4],ctx.shared.groundOffset(nodes[focus*4],nodes[focus*4+1]),nodes[focus*4+1]);
      const radius=Math.max(...instances.flatMap(i=>[i.a.distanceTo(center),i.b.distanceTo(center)]));
      const direction=camera.getWorldDirection(center.clone()),aspect=width/height;
      const halfHeight=Math.max(radius*3,radius*3/aspect,height/px*.06);
      if(camera.isOrthographicCamera){camera.top=halfHeight;camera.bottom=-halfHeight;camera.left=-halfHeight*aspect;camera.right=halfHeight*aspect;}
      const distance=camera.isOrthographicCamera?Math.max(100,radius*8):Math.max(150,radius*8);
      camera.position.copy(center).addScaledVector(direction,-distance);camera.lookAt(center);
      const restoreInstances=()=>{for(const{attribute,values}of attributes){attribute.array.set(values);attribute.clearUpdateRanges();attribute.needsUpdate=true;}geometry.instanceCount=count;};
      for(const zoom of [.5,1,2]){
        camera.zoom=zoom;camera.updateProjectionMatrix();camera.updateMatrixWorld();restoreInstances();
        material.vertexShader=old;material.needsUpdate=true;const before=draw();
        material.vertexShader=fixed;material.needsUpdate=true;const after=draw();
        let changedChannels=0,maxDifference=0;for(let i=0;i<before.length;i+=4)for(let j=0;j<3;j++){const d=Math.abs(before[i+j]-after[i+j]);if(d)changedChannels++;maxDifference=Math.max(maxDifference,d);}
        const scale=camera.projectionMatrix.elements[5]*height*.5,ortho=camera.projectionMatrix.elements[15]>.5;
        const samples=[];
        for(const instance of star){
          // Isolate one of the actual ten feature-produced instances, retaining its exact
          // attributes/material. This prevents intersecting star lines from inflating width.
          for(const{attribute,values}of attributes){const size=attribute.itemSize;attribute.array.set(values.subarray(instance.index*size,(instance.index+1)*size),0);attribute.clearUpdateRanges();attribute.needsUpdate=true;}geometry.instanceCount=1;
          const pixels=draw(),p=project(instance.a),q=project(instance.b),dx=q.x-p.x,dy=q.y-p.y,len=Math.hypot(dx,dy);
          if(len<8)throw Error('Selected star edge must span at least eight physical pixels');
          const mid=instance.a.clone().add(instance.b).multiplyScalar(.5),dist=camera.position.distanceTo(mid),newMin=2*px*(ortho?1:dist)/scale,oldMin=2*px*dist/scale;
          const expectedDeviceWidth=Math.max(instance.worldWidth,newMin)*scale/(ortho?1:dist);
          let maxNormal=0,interiorPixels=0;
          for(let y=0;y<height;y++)for(let x=0;x<width;x++){
            const k=(y*width+x)*4;if(Math.max(pixels[k],pixels[k+1],pixels[k+2])<=12)continue;
            const vx=x+.5-p.x,vy=y+.5-p.y,t=(vx*dx+vy*dy)/(len*len);if(t<.15||t>.85)continue;
            interiorPixels++;maxNormal=Math.max(maxNormal,Math.abs(vx*dy-vy*dx)/len);
          }
          samples.push({from:instance.from,to:instance.to,worldWidth:instance.worldWidth,projectedLength:len,dist,newMin,oldMin,cssMinimum:newMin*scale/(px*(ortho?1:dist)),expectedCssWidth:expectedDeviceWidth/px,observedCssWidth:2*maxNormal/px,interiorPixels,insideViewport:[p,q].every(p=>p.x>2&&p.x<width-2&&p.y>2&&p.y<height-2&&p.z> -1&&p.z<1)});
        }
        restoreInstances();
        if(zoom===1){captures.before=png(before);captures.after=png(after);}
        comparisons.push({zoom,ortho,beforeLit:lit(before),afterLit:lit(after),changedChannels,maxDifference,samples});
      }
      return{focus,neighbors,count,rays:rays.length,starEdges:star.length,width,height,actualDpr:px,comparisons,captures,glError:renderer.getContext().getError()};
    }finally{
      Object.assign(s,{view:saved.view,viewBlend:saved.viewBlend,mobileMode:saved.mobileMode,planTool:saved.planTool,tool:saved.tool});Object.assign(s.hover,saved.hover);pf.plan=saved.plan;pf.drugActive.dust=saved.dust;survey.focus.alpha.set(saved.focusAlpha);
      material.vertexShader=fixed;material.needsUpdate=true;for(const[o,v]of visibility)o.visible=v;
      scene.background=background;renderer.setClearColor(clearColor,clearAlpha);renderer.shadowMap.autoUpdate=shadowAuto;renderer.setRenderTarget(target);rt.dispose();survey.update(0);
    }
  });
  for(const[phase,png]of Object.entries(result.captures))writeFileSync(join(OUT,`${label}-pentagram-${phase}.png`),Buffer.from(png.split(',')[1],'base64'));
  delete result.captures;
  writeFileSync(join(OUT,`${label}-pentagram.json`),JSON.stringify(result,null,2));
  assert.equal(result.glError,0,'Actual pentagram shader compiles and renders without GL errors');
  assert.equal(result.neighbors.length,5);assert.equal(result.count,10);assert.equal(result.starEdges,5);assert.equal(result.rays,5);
  for(const c of result.comparisons){
    assert.equal(c.ortho,mobile);assert.ok(c.afterLit>20,'Focused pentagram has nonempty native pixels');
    for(const sample of c.samples){
      assert.equal(sample.insideViewport,true,'Entire real star edge stays inside the raster measurement');
      assert.ok(sample.interiorPixels>3,'Each of the five pentagram edges has real interior pixels');
      assert.ok(Math.abs(sample.cssMinimum-2)<1e-6,'BeamLayer retains a two CSS-pixel minimum');
      if(mobile){
        assert.ok(sample.oldMin>sample.newMin*20,'Old orthographic distance inflation is exercised');
        assert.ok(sample.expectedCssWidth<=2.01,'All tested zooms keep the real star width at its two-pixel floor');
        assert.ok(sample.observedCssWidth<=sample.expectedCssWidth+2/result.actualDpr,'Native raster remains within the projected width plus one-pixel edge coverage per side');
      }
    }
    if(mobile){assert.ok(c.beforeLit>c.afterLit*3,'Old pentagram halo is measurably broader than the fixed native pixels');assert.ok(c.changedChannels>0);}
    else assert.equal(c.maxDifference,0,'Perspective BeamLayer shader pixels are unchanged');
  }
  return result;
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
    entry.opacity=await verifyModeOpacity(spec.mobile);
    if(spec.mobile){await page.locator('.mc-modes').getByRole('button',{name:'Plan',exact:true}).tap();await page.waitForFunction(()=>window.flaghack.session.mobileMode==='build');}
    entry.pentagram=await verifyFocusedPentagram(spec.name,spec.mobile);
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
  assert.ok(new Set(results.scenarios.filter(s=>s.pentagram&&s.name!=='desktop-command').map(s=>s.pentagram.actualDpr)).size>=2,'Native pentagram proof exercises more than one actual renderer DPR');
  results.completed=true;
}catch(error){results.error=String(error?.stack||error);if(page)await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});throw error;
}finally{writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));await browser?.close();server.close();}
