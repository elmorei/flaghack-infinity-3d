/** Reproducible transparent mobile cutouts from actual game models, with four views and paint masks. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = spawn(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'--port','5196','--host','127.0.0.1','--strictPort'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser;
try {
  await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{if(b.toString().includes('5196'))resolve();});server.stderr.on('data',b=>console.error(b.toString()));server.on('exit',c=>reject(new Error(`Vite stopped ${c}`)));setTimeout(()=>reject(new Error('Vite startup timeout')),20000).unref();});
  browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  const page=await browser.newPage();page.on('pageerror',e=>console.error(e));
  await page.route('**/sprite-bake',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));await page.goto('http://127.0.0.1:5196/sprite-bake');
  const result=await page.evaluate(async()=>{
    const THREE=await import('/node_modules/three/build/three.module.js');
    const canonical=await (await fetch('/scripts/scenery-bake-specs.json')).json();
    const {createBatches,createClutterKit,disposeClutterKit}=await import('/src/render/env/props/kit.ts');
    const modules={};for(const name of ['tents','domes','shades','portas','cars','rocks','art','trees','stages'])modules[name]=await import(`/src/render/env/props/${name}.ts`);
    const {buildPileLayout}=await import('/src/render/env/piles/pileLayout.ts');
    const {buildPieceGeometry}=await import('/src/render/env/piles/pileModels.ts');
    const {wreckageFragments}=await import('/src/render/structures/wreckageRenderer.ts');
    const {buildEffigyGeometry}=await import('/src/render/env/burn/effigyModel.ts');
    const {Rng}=await import('/src/sim/rng.ts');
    const {FlagCloth}=await import('/src/render/env/burn/flagCloth.ts');
    const {createNoiseTexture}=await import('/src/render/env/noise.ts');
    const {FLAG_BOTTOM,FLAG_HEIGHT,FLAG_WIDTH,MAST_TOP,PLINTH_HEIGHT,LATTICE_TOP}=await import('/src/render/env/burn/burnTimeline.ts');
    const CELL=256,PAGE=2048,pages=[],clips={},reference={};
    const renderer=new THREE.WebGLRenderer({alpha:true,antialias:false,preserveDrawingBuffer:true});renderer.setSize(CELL,CELL);renderer.setPixelRatio(1);renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,1000),scene=new THREE.Scene();scene.add(new THREE.HemisphereLight(0xffffff,0x69687b,2));const sun=new THREE.DirectionalLight(0xfff1d4,2.5);sun.position.set(-15,25,20);scene.add(sun);
    const clothNoise=createNoiseTexture(renderer,1);
    const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.85,metalness:.05,side:THREE.DoubleSide});
    const add=(group,source,matrix,color)=>{if(!source)return;const geo=source.clone();if(color!==undefined){const a=geo.getAttribute('color'),mask=geo.getAttribute('aTint'),c=new THREE.Color(color);for(let i=0;i<a.count;i++)if(!mask||mask.getX(i)>.5)a.setXYZ(i,a.getX(i)*c.r,a.getY(i)*c.g,a.getZ(i)*c.b);}const mesh=new THREE.Mesh(geo,material);if(matrix){mesh.matrix.copy(matrix);mesh.matrixAutoUpdate=false;}group.add(mesh);};
    function propModel(o,phase=0){const out=createBatches('high'),kit=createClutterKit(),g=new THREE.Group(),items=[o];
      if(o.kind==='tent')modules.tents.buildTents(items,[],kit,out);if(o.kind==='shade')modules.shades.buildShades(items,kit,out);if(o.kind==='dome')modules.domes.buildDomes(items,kit,out);if(o.kind==='porta')modules.portas.buildPortas(items,out);if(o.kind==='car')modules.cars.buildCars(items,kit,out);if(o.kind==='rock')modules.rocks.buildRocks(items,out);if(o.kind==='stage')modules.stages.buildStages(items,[],kit,out);
      if(o.kind==='tree'){const t=modules.trees.buildTrees(items,out);for(const it of t.pines)add(g,t.pine,it.matrix,it.color);for(const it of t.oaks)add(g,t.oak,it.matrix,it.color);t.pine.dispose();t.oak.dispose();}
      if(o.kind==='art'){const r=modules.art.buildArt(items,out),t=modules.art.createRotorTemplates();for(const it of r.spiral)add(g,t.spiral,it.matrix.clone().multiply(new THREE.Matrix4().makeRotationY(phase)),it.color);for(const it of r.pinwheel)add(g,t.pinwheel,it.matrix.clone().multiply(new THREE.Matrix4().makeRotationZ(phase)),it.color);t.spiral.dispose();t.pinwheel.dispose();}
      for(const batch of [out.solid,out.gloss,out.low,out.cloth,out.lights]){const geo=batch.build();if(geo){add(g,geo);geo.dispose();}}const strings=out.strings.build();add(g,strings);strings.dispose();disposeClutterKit(kit);return g;}
    function pileModel(kind){const g=new THREE.Group(),layout=buildPileLayout({id:71,kind,pos:{x:0,z:0},lumber:100,max:100});for(const it of layout.items){const geo=buildPieceGeometry(it.piece);add(g,geo,new THREE.Matrix4().compose(new THREE.Vector3(it.x,it.y,it.z),new THREE.Quaternion().setFromEuler(new THREE.Euler(it.rx,it.ry,it.rz)),new THREE.Vector3().setScalar(it.scale)),it.color);geo.dispose();}return g;}
    // Exact fragment templates from wreckageRenderer.ts, kept local so baking does not
    // require changing runtime code on the isolated artifact branch.
    function brokenSlab(){const shape=new THREE.Shape();shape.moveTo(-.5,-.5);shape.lineTo(.28,-.5);shape.lineTo(.5,-.26);shape.lineTo(.43,.08);shape.lineTo(.5,.42);shape.lineTo(.06,.5);shape.lineTo(-.16,.36);shape.lineTo(-.5,.45);shape.closePath();const g=new THREE.ExtrudeGeometry(shape,{depth:1,bevelEnabled:false,steps:1});g.translate(0,0,-.5);g.rotateX(-Math.PI/2);return g;}
    function foldedFabric(){const g=new THREE.PlaneGeometry(1,1,3,3);g.rotateX(-Math.PI/2);const p=g.getAttribute('position');for(let i=0;i<p.count;i++)p.setY(i,Math.sin(i*2.7)*.22);g.computeVertexNormals();return g;}
    function wreckModel(kind){const g=new THREE.Group(),r={id:'sprite',kind,pos:{x:0,y:0,z:0},size:{x:5,y:3,z:5},yaw:0};for(const f of wreckageFragments(r,'sprite')){const geo=f.shape===1?new THREE.IcosahedronGeometry(.65,0):f.shape===2?foldedFabric():brokenSlab(),a=new Float32Array(geo.getAttribute('position').count*3),c=new THREE.Color(f.color);for(let i=0;i<a.length;i+=3)c.toArray(a,i);geo.setAttribute('color',new THREE.BufferAttribute(a,3));add(g,geo,new THREE.Matrix4().compose(f.pos,new THREE.Quaternion().setFromEuler(f.rotation),f.scale));geo.dispose();}return g;}
    function effigyModel(kind,frame=0){const g=new THREE.Group(),geo=buildEffigyGeometry(new Rng('effigy:mobile-scenery'));
      if(kind==='scaffold')add(g,geo.lattice,new THREE.Matrix4().makeTranslation(0,-PLINTH_HEIGHT,0));
      if(kind==='plinth'){const solid=geo.solid.clone(),p=solid.getAttribute('position'),keep=[];for(let i=0;i<p.count;i+=3)if(Math.max(p.getY(i),p.getY(i+1),p.getY(i+2))<=PLINTH_HEIGHT+.01)keep.push(i,i+1,i+2);solid.setIndex(keep);add(g,solid);add(g,geo.offerings);solid.dispose();}
      if(kind==='flag'){
        // Capture the existing shader-driven cloth, including gold/saffron faces,
        // pinned hoist, folds, droop and flutter. The obsolete finial is omitted.
        add(g,geo.mast,new THREE.Matrix4().makeTranslation(0,-PLINTH_HEIGHT,0));
        const clothEnv={ctx:{quality:'high'},noise:clothNoise,uniforms:{uTime:{value:frame*.14},uNight:{value:0},
          uWind:{value:new THREE.Vector2(.65,0)},uSunDir:{value:sun.position.clone().normalize()},uSunColor:{value:new THREE.Color(1,1,1)}}};
        const cloth=new FlagCloth(clothEnv);cloth.update(1,{updraft:0,incandescence:0,uplight:0,heat:{active:false,color:[0,0,0],emissive:0}});
        cloth.mesh.position.y=FLAG_BOTTOM-PLINTH_HEIGHT;g.add(cloth.mesh);g.userData.cloth=cloth;
      }
      for(const value of Object.values(geo))if(value?.isBufferGeometry)value.dispose();return g;}
    const specs=canonical.map(o=>({key:`scenery:${o.kind}:${o.variant}`,height:o.height,columns:o.kind==='art'&&(o.variant===2||o.variant===3)?4:1,build:(color,frame=0)=>propModel({...o,color},frame*Math.PI/2),reference:o}));
    for(const kind of ['pallets','lumber','moop'])specs.push({key:`pile:${kind}`,height:kind==='pallets'?2.15:kind==='lumber'?1.55:1.7,build:()=>pileModel(kind)});
    for(const[style,kind]of Object.entries({cloth:'tent',metal:'car',wood:'wall',stone:'rock',mixed:'hearth'}))specs.push({key:`wreckage:${style}`,height:.96,build:()=>wreckModel(kind)});
    for(const kind of ['scaffold','flag','plinth'])specs.push({key:`effigy:${kind}`,height:kind==='scaffold'?LATTICE_TOP+1.1-PLINTH_HEIGHT:kind==='flag'?MAST_TOP-PLINTH_HEIGHT:PLINTH_HEIGHT,columns:kind==='flag'?4:1,build:(_color,frame)=>effigyModel(kind,frame)});
    const capture=new OffscreenCanvas(CELL,CELL),cg=capture.getContext('2d',{willReadFrequently:true});
    let pageIndex=0,cellX=0,cellY=0;
    for(let index=0;index<specs.length;index++){
      const spec=specs[index],columns=spec.columns||1;
      if(cellX+columns>8){cellX=0;cellY+=4;}if(cellY+4>8){pageIndex++;cellX=cellY=0;}
      const x=cellX*CELL,y=cellY*CELL;cellX+=columns;
      const frames=Array.from({length:columns},(_,i)=>[spec.build(0xffffff,i),spec.build(0x000000,i)]);
      // Fit actual transformed vertices, including off-center clutter and below-origin
      // ladders. Cached geometry bounds are insufficient for these procedural models.
      let maxX=0,minY=Infinity,maxY=-Infinity;const vertex=new THREE.Vector3(),pitch=.27;
      for(const [normal]of frames){normal.updateMatrixWorld(true);normal.traverse(mesh=>{
        if(!mesh.isMesh)return;const p=mesh.geometry.getAttribute('position');
        for(let i=0;i<p.count;i++){vertex.fromBufferAttribute(p,i).applyMatrix4(mesh.matrixWorld);
          for(let view=0;view<4;view++){const yaw=view*Math.PI/2;
            const px=vertex.x*Math.cos(yaw)-vertex.z*Math.sin(yaw);
            const py=vertex.y*Math.cos(pitch)-(vertex.x*Math.sin(yaw)+vertex.z*Math.cos(yaw))*Math.sin(pitch);
            maxX=Math.max(maxX,Math.abs(px));minY=Math.min(minY,py);maxY=Math.max(maxY,py);
          }
        }
      });}
      // FlagCloth displaces in its vertex shader, so allow its documented 1.5m
      // off-plane fold bound while retaining the same origin for every frame.
      if(spec.key==='effigy:flag'){maxX+=1.6;minY-=.5;maxY+=.5;}
      const extent=Math.max(maxX*2,maxY-minY)*1.12,pixelScale=CELL/extent,centerY=(minY+maxY)/2;
      const anchorY=CELL*(.5+centerY/extent),targetY=centerY/Math.cos(pitch);
      if(!pages[pageIndex]){const canvas=new OffscreenCanvas(PAGE,PAGE);pages[pageIndex]={canvas,ctx:canvas.getContext('2d')};}
      for(let direction=0;direction<4;direction++)for(let frame=0;frame<columns;frame++){
        const [normal,black]=frames[frame],yaw=direction*Math.PI/2,pitch=.27;
        camera.left=-extent/2;camera.right=extent/2;camera.top=extent/2;camera.bottom=-extent/2;
        const target=new THREE.Vector3(0,targetY,0);camera.position.copy(target).add(new THREE.Vector3(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(yaw)*Math.cos(pitch)).multiplyScalar(100));camera.lookAt(target);camera.updateProjectionMatrix();
        scene.add(normal);renderer.render(scene,camera);cg.clearRect(0,0,CELL,CELL);cg.drawImage(renderer.domElement,0,0);const pixels=cg.getImageData(0,0,CELL,CELL);scene.remove(normal);
        scene.add(black);renderer.render(scene,camera);cg.clearRect(0,0,CELL,CELL);cg.drawImage(renderer.domElement,0,0);const mask=cg.getImageData(0,0,CELL,CELL);scene.remove(black);
        for(let i=0;i<pixels.data.length;i+=4){if(pixels.data[i+3]<128){pixels.data[i+3]=0;continue;}const delta=Math.max(...[0,1,2].map(k=>Math.abs(pixels.data[i+k]-mask.data[i+k])));pixels.data[i+3]=delta>8?224:255;}
        let occupied=0,touching=0;
        for(let py=0;py<CELL;py++)for(let px=0;px<CELL;px++)if(pixels.data[(py*CELL+px)*4+3]){
          occupied++;if(px===0||py===0||px===CELL-1||py===CELL-1)touching++;
        }
        if(!occupied||touching)throw new Error(`Clipped or empty sprite ${spec.key} direction${direction} frame${frame}: occupied${occupied} edge${touching}`);
        pages[pageIndex].ctx.putImageData(pixels,x+frame*CELL,y+direction*CELL);
      }
      clips[`${spec.key}:idle`]={page:pageIndex,x,y,w:CELL*columns,h:CELL*4,cellWidth:CELL,cellHeight:CELL,columns,rows:4,anchor:[CELL/2,anchorY],footYByCell:Array.from({length:4},()=>Array(columns).fill(anchorY)),heightPixels:spec.height*pixelScale,frameDurationMs:spec.key==='effigy:flag'?140:columns>1?650:140,loop:true,directionRows:{front:0,right:1,away:2,left:3}};
      if(spec.reference)reference[spec.key]=spec.reference;
      for(const pair of frames)for(const group of pair){group.userData.cloth?.dispose();group.traverse(o=>{if(o.isMesh)o.geometry.dispose();});}
    }
    const images=[];for(const p of pages){const blob=await p.canvas.convertToBlob({type:'image/png'}),bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);images.push(btoa(binary));}clothNoise.dispose();renderer.dispose();material.dispose();return{images,manifest:{schemaVersion:1,pages:pages.map((_,i)=>({image:`/assets/mobile-sprites/world-${i}.png`,width:PAGE,height:PAGE})),clips},reference};
  });
  mkdirSync(resolve(root,'public/assets/mobile-sprites'),{recursive:true});for(let i=0;i<result.images.length;i++)writeFileSync(resolve(root,`public/assets/mobile-sprites/world-${i}.png`),Buffer.from(result.images[i],'base64'));
  writeFileSync(resolve(root,'src/render/actors/mobileSpriteWorld.json'),JSON.stringify(result.manifest,null,2)+'\n');writeFileSync(resolve(root,'../art/mobile-sprites/scenery-reference.json'),JSON.stringify({source:'Game procedural models. Four orthographic views, exact paint mask alpha224.',references:result.reference,anchorConvention:'Every clip anchor is the pixel-edge projection of model-local (0,0,0), not the lowest opaque row or image center. Near-footprint geometry may project below this ground-center anchor. The same anchor is used in every direction and frame.',capturePitchRadians:.27,worldScale:'heightPixels = canonical world height * pixels per world meter; runtime height/heightPixels restores the original physical scale. Scaffold and flag origins are translated down by PLINTH_HEIGHT in the bake and placed at ground + PLINTH_HEIGHT at runtime.'},null,2)+'\n');console.log(`Baked ${Object.keys(result.manifest.clips).length} clips on ${result.images.length} transparent PNG pages.`);
}finally{await browser?.close();server.kill('SIGTERM');}
