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
const server=createServer(async(req,res)=>{
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+'/'))throw Error('Not found');
    const data=await readFile(file);
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2'};
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data);
  } catch {res.writeHead(404);res.end('Not found');}
});
await new Promise(r=>server.listen(4175,'127.0.0.1',r));
let browser;
const errors=[];
try {
  browser=await chromium.launch({headless:false,chromiumSandbox:true,args:['--use-gl=angle','--use-angle=gl']});
  const context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:1});
  const page=await context.newPage();
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
      app.startMatch({seed:'flaghack-intro-20261022',difficulty:'normal',match:{days:shot===4?0:-1,dayLength:600,bossMode:shot===4,startingLumber:350,startingFlags:45,startingSignifiers:12,maxSignifiers:100}});
      const w=app.world;const s=app.session; s.view='action';s.viewBlend=0;s.showLattice=false;
      window.fh.advance(shot===4?90.15:shot===3?100:20);
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
      return {shot,time:w.time,phase:w.phase,avatars:w.avatars.size,hippies:w.hippies.size,flags:w.flags.size,buildings:w.buildings.size,boss:!!w.boss,avatar:{...av.pos}};
    };
    window.captureFrame=(i,advance=true)=>{
      const shot=window.captureShot,w=app.world,av=w.avatarOf(0),t=i/30,p=i/179,camera=app.renderer.camera;
      if(advance){
        for(let k=0;k<2;k++){
          const moving=shot===1||shot===2;const yaw=2.35;
          w.submit({t:'avatarInput',faction:0,input:{moveX:moving?Math.sin(yaw)*0.7:0,moveZ:moving?Math.cos(yaw)*0.7:0,jump:shot===1&&i===105,sprint:false,yaw,pitch:0.24,throwMode:shot===1}});
          if(shot===1&&k===0&&[24,70,125,160].includes(i)) w.submit({t:'throw',faction:0});
          if(shot===2&&k===0&&i===5)w.submit({t:'rally',faction:0});
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
        if(!w.boss)throw Error('Boss did not emerge through actual game simulation');
        const b=w.boss,a=0.6+p*0.18;camera.fov=60;camera.updateProjectionMatrix();
        camera.position.set(b.pos.x+Math.sin(a)*46,17,b.pos.z+Math.cos(a)*46);
        camera.lookAt(b.pos.x,14,b.pos.z);
      }
      camera.updateMatrixWorld();app.renderer.render(1/30);
      return document.querySelector('canvas#game').toDataURL('image/jpeg',0.94).split(',')[1];
    };
  });
  const scenes=[];
  for(let shot=0;shot<5;shot++){
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
  const video=resolve(out,'flaghack-gameplay-placeholder-30s.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','warning','-y','-framerate','30','-start_number','0','-i',resolve(frames,'%04d.jpg'),'-vf','fade=t=in:st=0:d=0.35,fade=t=out:st=29.55:d=0.45,format=yuv420p','-frames:v','900','-c:v','libx264','-preset','medium','-crf','23','-movflags','+faststart','-an',video],{stdio:'inherit'});
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',video],{encoding:'utf8'}));
  execFileSync('ffmpeg',['-v','error','-i',video,'-f','null','-'],{stdio:'inherit'});
  const info={baseSource:process.env.CAPTURE_BASE_SHA,captureCommit:process.env.GITHUB_SHA,provenance:'Staged actual gameplay captured from the unmodified production game simulation and WebGL renderer; offline test controls and cinematic camera framing. 900 fixed-timestep frames at30fps.',audio:'Muted; no invented music or external audio.',gpu,scenes,errors,probe};
  await writeFile(resolve(out,'capture-provenance.json'),JSON.stringify(info,null,2));
  console.log('COMPLETE',JSON.stringify({size:(await stat(video)).size,duration:probe.format.duration,width:probe.streams[0].width,height:probe.streams[0].height}));
} catch(e){await writeFile(resolve(out,'capture-error.txt'),String(e)+'\n'+errors.join('\n'));throw e;}
finally {await browser?.close();server.close();}
