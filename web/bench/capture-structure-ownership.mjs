/** Actual-game Survey capture proof: neutral dome, then functional workshop. No rule overrides. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const out = resolve('structure-capture-proof');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [], scenes = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.addInitScript(() => { window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {}; });
  await page.goto(process.env.CAPTURE_URL || 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.flaghack && !!window.fh);
  for (let shot = 0; shot < 2; shot++) {
    const setup = await page.evaluate(async shot => {
      const { spawnBuilding } = await import('/src/sim/factory.ts');
      const { registerBuildingShape } = await import('/src/sim/systems/buildings.ts');
      const { sceneryEnclosed, circleEnclosed } = await import('/src/sim/systems/structureEnclosure.ts');
      const app = window.flaghack;
      app.session.settings.masterVolume = 0;
      app.session.settings.quality = 'medium';
      window.captureBeat = 0; app.renderer.beatSource = () => window.captureBeat;
      app.startMatch({ seed: 'structure-capture-proof', difficulty: 'normal', humans: [0,1,2,3], match: { days: -1, bossMode: false, maxSignifiers: 0 } });
      app.ai.clear();
      const w = app.world;
      for (const av of w.avatars.values()) { av.pos.x = -1000; av.pos.z = -1000; av.pos.y = 0; }
      let prop, building, pos, radius;
      if (shot === 0) {
        const candidates = w.map.obstacles.filter(o => o.kind === 'dome' || o.kind === 'tent').sort((a,b) => Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z));
        for (const o of candidates) {
          const loop = window.fh.encircle(0,o.x,o.z,o.radius+6);
          window.fh.survey.updateSurvey(w,0);
          if (loop.length && sceneryEnclosed(w,o,0)) { prop=o; break; }
        }
        if (!prop) throw Error('No actually surroundable neutral structure');
        pos = { x: prop.x, z: prop.z }; radius=prop.radius;
      } else {
        const facet=w.lattice.facets.find(f => f.thick && !f.boundary && Math.hypot(f.cx,f.cz)<60 && Math.hypot(f.cx,f.cz)>20 && !w.collision.blockedCircle(f.cx,f.cz,5,.1,12));
        if (!facet) throw Error('No workshop staging footprint');
        building=spawnBuilding(w,'workshop',1,facet.id,1); registerBuildingShape(w,building);
        window.fh.encircle(0,building.pos.x,building.pos.z,16); window.fh.survey.updateSurvey(w,0);
        if (!circleEnclosed(w,building.pos.x,building.pos.z,4,0)) throw Error('Workshop footprint not enclosed');
        pos={...building.pos};radius=4;
      }
      const state=()=>prop?w.sceneryCapture.get(prop.id):building.capture;
      let steps=0;
      while ((!state() || state().pressure[0]<85) && steps++<1200) app.sim.step();
      if (!state() || state().pressure[0]<85 || state().stage==='overwritten') throw Error('Could not stage real pre-overwrite pressure');
      w.drainEvents();
      const camera=app.renderer.camera, y=w.collision.groundHeight(pos.x,pos.z), r=Math.max(24,radius*3.6);
      camera.fov=55;camera.updateProjectionMatrix();camera.position.set(pos.x+r*.65,y+Math.max(13,radius*2.2),pos.z+r*.75);camera.lookAt(pos.x,y+2,pos.z);camera.updateMatrixWorld();
      app.renderer.render(0);await new Promise(r=>setTimeout(r,2500));app.renderer.render(0);await new Promise(r=>setTimeout(r,500));
      window.ownershipFrame=i=>{
        for(let k=0;k<2;k++)app.sim.step();
        window.captureBeat+=1/15;app.renderer.onEvents(w.drainEvents());app.renderer.render(1/30);
        if(w.boss||w.effigyRevealedAt!==null)throw Error('Unexpected boss');
        return document.querySelector('canvas#game').toDataURL('image/png').split(',')[1];
      };
      window.ownershipResult=()=>({faction:prop?state()?.faction:building.faction,stage:state()?.stage,pressure:state()?.pressure[0]});
      return {shot,target:prop?prop.kind:building.kind,id:prop?prop.id:building.id,pos,pressure:state().pressure[0],stage:state().stage};
    },shot);
    for(let i=0;i<180;i++) {
      const data=await page.evaluate(i=>window.ownershipFrame(i),i);
      await writeFile(resolve(out,`${String(shot*180+i).padStart(4,'0')}.png`),Buffer.from(data,'base64'));
    }
    const result=await page.evaluate(()=>window.ownershipResult());
    if(result.faction!==0)throw Error('Capture did not complete: '+JSON.stringify(result));
    scenes.push({setup,result});
  }
  if(errors.length)throw Error(errors.join('\n'));
  execFileSync('ffmpeg',['-y','-framerate','30','-i',resolve(out,'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','21','-movflags','+faststart',resolve(out,'structure-capture.mp4')]);
  await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,note:'Staged actual-game enclosed neutral prop and rival workshop, real simulation pressure/overwrite, fixed cameras. No synthetic overlays or pressure overrides.'},null,2));
} finally {await browser.close();}
