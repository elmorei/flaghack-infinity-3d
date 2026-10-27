/** Capture only. No production/gameplay source modifications.
 * Actual compiled game simulation and WebGL renderer, deterministically stepped at30fps.
 * Camera and offline commands are staged with the existing fh developer/test API.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
const out=resolve('montage-output'), frames=resolve('montage-frames');
await mkdir(out,{recursive:true}); await mkdir(frames,{recursive:true});
const root=resolve('dist');
let initScript='';
const server=createServer(async(req,res)=>{
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+'/'))throw Error('Not found');
    let data=await readFile(file);
    if(process.env.CAPTURE_BROWSER==='firefox'&&extname(file)==='.html')data=Buffer.from(data.toString().replace('<head>',`<head><script>${initScript}</script>`));
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2'};
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data);
  } catch {res.writeHead(404);res.end('Not found');}
});
await new Promise(r=>server.listen(4175,'127.0.0.1',r));
let browser;
const errors=[];
try {
  let page;
  if(process.env.CAPTURE_BROWSER==='firefox'){
    const {Builder}=await import('selenium-webdriver');
    const firefox=(await import('selenium-webdriver/firefox.js')).default;
    const driver=await new Builder().forBrowser('firefox').setFirefoxOptions(new firefox.Options().setAcceptInsecureCerts(false)).build();
    browser={close:()=>driver.quit()};
    await driver.manage().setTimeouts({script:120000,pageLoad:120000});
    await driver.manage().window().setRect({width:1280,height:850});
    const dims=await driver.executeScript('return {dw:outerWidth-innerWidth,dh:outerHeight-innerHeight}');
    await driver.manage().window().setRect({width:1280+dims.dw,height:720+dims.dh});
    page={
      async evaluate(fn,arg){
        const r=await driver.executeAsyncScript(`const done=arguments[arguments.length-1];Promise.resolve((${fn.toString()})(arguments[0])).then(result=>done({ok:true,result:result??null}),e=>done({ok:false,error:String(e)+'\\n'+e.stack}));`,arg??null);
        if(!r.ok)throw Error(r.error);return r.result;
      },
      async addInitScript(fn){initScript=`(${fn.toString()})();window.capturePageErrors=[];window.addEventListener('error',e=>window.capturePageErrors.push(e.message));`;},
      async goto(url){await driver.get(url);},
      async waitForFunction(fn,_arg,{timeout}){await driver.wait(()=>page.evaluate(fn),timeout,undefined,100);},
      on(){}
    };
  } else {
    browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
    const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1});
    page=await context.newPage();
  }
  const preflight=await page.evaluate(()=>{const c=document.createElement('canvas');const gl=c.getContext('webgl2');if(!gl)return null;const e=gl.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
  console.log('WEBGL PREFLIGHT',preflight);
  if(!preflight)throw Error('Default browser WebGL2 is unavailable; no override of graphics security applied');
  page.on('pageerror',e=>{errors.push(String(e));console.error('PAGE ERROR:',e);});
  page.on('console',m=>{if(m.type()==='error')console.error('BROWSER:',m.text());});
  // Prevent only the app's automatic frame scheduling so each recorded frame advances
  // exactly two ordinary60Hz simulation ticks. No game rules or rendering are replaced.
  await page.addInitScript(()=>{window.requestAnimationFrame=()=>1;window.cancelAnimationFrame=()=>{};});
  await page.goto('http://127.0.0.1:4175/',{waitUntil:'load'});
  await page.waitForFunction(()=>!!window.flaghack&&!!window.fh,null,{timeout:60000,polling:100});
  const gpu=await page.evaluate(()=>{
    const gl=window.flaghack.renderer.renderer.getContext();const ex=gl.getExtension('WEBGL_debug_renderer_info');
    return {renderer:ex?gl.getParameter(ex.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION)};
  });
  console.log('GRAPHICS',JSON.stringify(gpu));
  await page.evaluate(()=>{
    const app=window.flaghack;
    app.session.settings.quality='medium';app.session.settings.masterVolume=0;
    app.renderer.renderer.setPixelRatio(1);
    window.captureSetup=async(shot)=>{
      app.startMatch({seed:'flaghack-intro-20261022',difficulty:'normal',match:{days:-1,dayLength:600,bossMode:false,startingLumber:350,startingFlags:45,startingSignifiers:12,maxSignifiers:100}});
      const w=app.world;const s=app.session; s.view='action';s.viewBlend=0;s.showLattice=false;
      window.fh.advance(shot===4?240:shot===3?100:20);
      if(w.boss || w.effigyRevealedAt !== null) throw Error('Spoiler guard: boss state is forbidden');
      if(shot===4){
        // Stage an ordinary contested Hearth through existing offline debug/game systems.
        // The production simulation derives the contested state; do not assign it manually.
        const hearth=w.hearthOf(1), defender=w.avatarOf(1);
        if(!hearth) throw Error('Missing defender altar');
        for(const fl of [...w.flags.values()]) {
          if(fl.state==='planted'&&fl.owner===1) window.fh.flags.depositToStock(w,fl.id,hearth.id);
        }
        window.fh.survey.updateSurvey(w,0);
        const loop=window.fh.encircle(2,hearth.pos.x,hearth.pos.z,15);
        if(!loop.length)throw Error('Could not stage attacker enclosure');
        defender.pos.x=hearth.pos.x+2;defender.pos.z=hearth.pos.z;
        defender.pos.y=w.collision.groundHeight(defender.pos.x,defender.pos.z);
        defender.koUntil=0;
        for(const faction of [1,2])w.submit({t:'order',faction,hippies:[...w.hippies.values()].filter(h=>h.faction===faction).map(h=>h.id),order:{kind:'follow',avatarId:w.avatarOf(faction).id}});
        const attacker=w.avatarOf(2);
        attacker.pos.x=hearth.pos.x+18;attacker.pos.z=hearth.pos.z+2;
        window.fh.survey.updateSurvey(w,0);
        window.fh.capture.updateCapture(w,1/60);
        if(hearth.hearth.stage!=='contested')throw Error('Altar is not contested: '+hearth.hearth.stage);
        window.captureAltarId=hearth.id;
        // Actors still run all normal simulation systems. Disable strategy planning only,
        // preserving the staged defender position and enclosure for this six-second shot.
        app.ai.clear();
      }
      const av=w.avatarOf(0);window.captureShot=shot;
      window.captureStart={x:av.pos.x,z:av.pos.z};
      if(shot===2){
        const ids=[...w.hippies.values()].filter(h=>h.faction===0).map(h=>h.id);
        w.submit({t:'order',faction:0,hippies:ids,order:{kind:'follow',avatarId:av.id}});
      }
      const camera=app.renderer.camera;camera.fov=55;camera.updateProjectionMatrix();
      window.captureFrame(0,false);
      await new Promise(r=>setTimeout(r,1000));
      app.renderer.render(0);
      await new Promise(r=>setTimeout(r,1000));
      return {shot,time:w.time,phase:w.phase,avatars:w.avatars.size,hippies:w.hippies.size,flags:w.flags.size,buildings:w.buildings.size,boss:!!w.boss,altar:shot===4?{id:window.captureAltarId,stage:w.buildings.get(window.captureAltarId).hearth.stage}:null,avatar:{...av.pos}};
    };
    window.captureFrame=(i,advance=true)=>{
      const shot=window.captureShot,w=app.world,av=w.avatarOf(0),t=i/30,p=i/179,camera=app.renderer.camera;
      if(advance){
        for(let k=0;k<2;k++){
          const moving=shot===1||shot===2;const yaw=2.35;
          w.submit({t:'avatarInput',faction:0,input:{moveX:moving?Math.sin(yaw)*0.7:0,moveZ:moving?Math.cos(yaw)*0.7:0,jump:shot===1&&i===105,sprint:false,yaw,pitch:0.24,throwMode:shot===1}});
          if(shot===1&&k===0&&[24,70,125,160].includes(i)) w.submit({t:'throw',faction:0});
          if(shot===2&&k===0&&i===5)w.submit({t:'rally',faction:0});
          if(shot===4)w.submit({t:'avatarInput',faction:1,input:{moveX:0,moveZ:0,jump:false,sprint:false,yaw:0,pitch:0,throwMode:false}});
          for(const ai of app.ai.values())ai.update();app.sim.step();
        }
        app.renderer.onEvents(w.drainEvents());
      }
      if(shot===0){
        const hearth=[...w.buildings.values()].find(b=>b.kind==='hearth'&&b.faction===0);
        const a=-0.75+p*0.45,r=42-p*8;
        camera.position.set(hearth.pos.x+Math.sin(a)*r,24-p*4,hearth.pos.z+Math.cos(a)*r);
        camera.lookAt(hearth.pos.x,2,hearth.pos.z);
      } else if(shot===1){
        const yaw=2.35;camera.position.set(av.pos.x-Math.sin(yaw)*11,6.2,av.pos.z-Math.cos(yaw)*11);
        camera.lookAt(av.pos.x+Math.sin(yaw)*4,1.7,av.pos.z+Math.cos(yaw)*4);
      } else if(shot===2){
        camera.position.set(av.pos.x+13,9,av.pos.z+8);
        camera.lookAt(av.pos.x-2,1.5,av.pos.z+2);
      } else if(shot===3){
        const gcc=[...w.buildings.values()].find(b=>b.kind==='gcc'&&b.faction===0);
        const a=-0.9+p*0.6;camera.position.set(gcc.pos.x+Math.sin(a)*17,8.5,gcc.pos.z+Math.cos(a)*17);
        camera.lookAt(gcc.pos.x,3,gcc.pos.z);
      } else {
        if(w.boss || w.effigyRevealedAt!==null)throw Error('Spoiler guard failed');
        const altar=w.buildings.get(window.captureAltarId);
        if(altar.hearth.stage!=='contested')throw Error('Contested state lost: '+altar.hearth.stage);
        const a=-0.75+p*0.5;
        camera.position.set(altar.pos.x+Math.sin(a)*27,12,altar.pos.z+Math.cos(a)*27);
        camera.lookAt(altar.pos.x,2.5,altar.pos.z);
      }
      camera.updateMatrixWorld();app.renderer.render(1/30);
      return document.querySelector('canvas#game').toDataURL('image/jpeg',0.94).split(',')[1];
    };
  });
  const scenes=[];
  for(let shot=4;shot<5;shot++){
    const scene=await page.evaluate(shot=>window.captureSetup(shot),shot);scenes.push(scene);console.log('SCENE',JSON.stringify(scene));
    for(let i=0;i<180;i++){
      const encoded=await page.evaluate(i=>window.captureFrame(i),i);
      const bytes=Buffer.from(encoded,'base64');
      if(bytes.length<7000)throw Error('Suspicious empty game frame');
      await writeFile(resolve(frames,`${String(shot*180+i).padStart(4,'0')}.jpg`),bytes);
      if(i===90)await writeFile(resolve(out,`scene-${shot+1}.jpg`),bytes);
      if(i%60===0)console.log(`Captured scene${shot+1}, frame${i+1}/180`);
    }
  }
  const video=resolve(out,'flaghack-night-contested-altar-6s.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','warning','-y','-framerate','30','-start_number','720','-i',resolve(frames,'%04d.jpg'),'-vf','format=yuv420p','-frames:v','180','-c:v','libx264','-preset','medium','-crf','23','-movflags','+faststart','-an',video],{stdio:'inherit'});
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',video],{encoding:'utf8'}));
  execFileSync('ffmpeg',['-v','error','-i',video,'-f','null','-'],{stdio:'inherit'});
  errors.push(...await page.evaluate(()=>window.capturePageErrors||[]));
  const info={baseSource:process.env.CAPTURE_BASE_SHA,captureCommit:process.env.GITHUB_SHA,provenance:'Staged actual gameplay captured from the unmodified production game simulation and WebGL renderer; offline test controls and cinematic camera framing. 180 fixed-timestep frames at 30 fps. Boss mode disabled; actual contested state asserted throughout.',audio:'Muted; no invented music or external audio.',gpu,scenes,errors,probe};
  await writeFile(resolve(out,'capture-provenance.json'),JSON.stringify(info,null,2));
  console.log('COMPLETE',JSON.stringify({size:(await stat(video)).size,duration:probe.format.duration,width:probe.streams[0].width,height:probe.streams[0].height}));
} catch(e){await writeFile(resolve(out,'capture-error.txt'),String(e)+'\n'+errors.join('\n'));throw e;}
finally {await browser?.close();server.close();}
