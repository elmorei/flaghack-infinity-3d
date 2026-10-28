/** 24-second actual-game captured-scenery proof. Run from web/ with Vite serving.
 * Uses supported headed Chrome with its sandbox; no graphics/security overrides.
 * Stages ownership/needs, then calls unmodified production systems. Entire page is
 * captured so the real contextual HUD is visible; no custom overlays/compositing.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const out = resolve(process.env.CAPTURE_OUT || 'scenery-benefits-proof');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
const scenes = [], errors = [], pageErrors = [], responses = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { pageErrors.push(String(e)); errors.push(String(e)); });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) responses.push({ url: r.url(), status: r.status() }); });
  page.on('requestfailed', r => responses.push({ url: r.url(), failure: r.failure()?.errorText }));
  await page.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.captureFrozen = false; window.requestAnimationFrame = fn => raf(time => { if (!window.captureFrozen) fn(time); }); });
  await page.goto(process.env.CAPTURE_URL || 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.flaghack && !!window.fh, null, { polling: 100, timeout: 90000 });
  await page.evaluate(async () => { await window.flaghack.ready; document.querySelector('#startup-skip')?.click(); });
  await page.waitForFunction(() => !document.querySelector('#startup'), null, { polling: 100, timeout: 30000 });
  await page.evaluate(() => { window.captureFrozen = true; });
  const roles = ['tent', 'art', 'car', 'dome', 'shade', 'porta'];
  for (const [shot, kind] of roles.entries()) {
    const setup = await page.evaluate(async kind => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { spawnHippie, spawnFlag, spawnBuilding } = await import('/src/sim/factory.ts');
      const { sceneryServicePoint, sceneryLodging, sceneryRitualMultiplier, tentPlaces } = await import('/src/sim/systems/sceneryBenefits.ts');
      const { newStructureCapture } = await import('/src/sim/systems/structureCapture.ts');
      const { updateSceneryService } = await import('/src/sim/systems/sceneryServices.ts');
      const { depotHolder, depotStock, vehicleCapacity } = await import('/src/sim/systems/sceneryDepots.ts');
      const { depositToStock } = await import('/src/sim/systems/flags.ts');
      const { popCap, updateEconomy } = await import('/src/sim/systems/economy.ts');
      const { brainOf } = await import('/src/sim/systems/units/brain.ts');
      const { unitsState } = await import('/src/sim/systems/units/state.ts');
      const { DRUM_RITUAL_PER_SEC } = await import('/src/sim/constants.ts');
      const app = window.flaghack;
      app.session.settings.masterVolume = 0; app.session.settings.quality = 'medium';
      window.captureBeat = 0; app.renderer.beatSource = () => window.captureBeat;
      app.startMatch({ seed: 'scenery-benefits-proof', difficulty: 'normal', humans: [0,1,2,3], match: { days: -1, bossMode: false, maxSignifiers: 0 } });
      app.ai.clear();
      const w = app.world; w.time = 20; w.hippies.clear(); w.sceneryCapture.clear();
      for (const av of w.avatars.values()) av.pos = { x: -1000, y: 0, z: -1000 };
      const camera = app.renderer.camera; camera.fov = 45; camera.updateProjectionMatrix();
      app.renderer.render(0); await new Promise(r => setTimeout(r, 2500)); app.renderer.render(0);
      const scene = app.renderer.ctx.scene; scene.updateMatrixWorld(true);
      const opaque = [];
      scene.traverse(o => {
        if (!o.isMesh) return;
        for (let a = o; a; a = a.parent) if (!a.visible) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (!mats.some(m => m.transparent || m.isShaderMaterial)) opaque.push(o);
      });
      const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), direction = new THREE.Vector3();
      let prop, service, ground, framing;
      const candidates = w.map.obstacles.filter(o => o.kind === kind && sceneryServicePoint(w,o))
        .sort((a,b) => Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z));
      for (const o of candidates) {
        const y = w.collision.groundHeight(o.x,o.z), radius = o.shape === 'circle' ? o.radius : Math.hypot(o.hx,o.hz);
        const distance = Math.max(20, radius*3.3);
        for (let angle=0; angle<Math.PI*2; angle+=Math.PI/4) {
          origin.set(o.x+Math.sin(angle)*distance,y+distance*1.1,o.z+Math.cos(angle)*distance);
          let clear = true;
          for (const dx of [-1,0,1]) {
            direction.set(o.x+dx,y+Math.min(o.height*.5,3),o.z).sub(origin);
            ray.set(origin,direction.clone().normalize()); ray.near=.1; ray.far=Math.max(.2,direction.length()-radius*1.3);
            if (ray.intersectObjects(opaque,false).length) { clear=false; break; }
          }
          if (!clear) continue;
          prop=o; service=sceneryServicePoint(w,o); ground=y;
          framing={origin:origin.toArray(),angle,testedOpaqueMeshes:opaque.length};
          camera.position.copy(origin); camera.lookAt(o.x,y+1.5,o.z); camera.updateMatrixWorld(); break;
        }
        if (prop) break;
      }
      if (!prop) throw Error(`No clear real-geometry camera for ${kind}`);
      const beforeCap=popCap(w,0);
      w.sceneryCapture.set(prop.id,{...newStructureCapture(),faction:0});
      const sys=unitsState(w), people=[], stagedFlags=[];
      if (['dome','shade','porta'].includes(kind)) {
        const count=kind==='dome'?4:kind==='porta'?2:2;
        for(let slot=0;slot<count;slot++) {
          const p=sceneryServicePoint(w,prop,undefined,slot), h=spawnHippie(w,0,p);
          h.hp=kind==='dome'?50:100; h.attention=40; h.job='gather'; brainOf(h).lastHurtAt=-Infinity; people.push(h);
        }
      }
      if(kind==='art') {
        const facet=w.lattice.facets.filter(f=>f.thick&&!f.boundary&&Math.hypot(f.cx-prop.x,f.cz-prop.z)<20&&Math.hypot(f.cx-prop.x,f.cz-prop.z)>6&&!w.collision.blockedCircle(f.cx,f.cz,4,.1,12))
          .sort((a,b)=>Math.hypot(a.cx-prop.x,a.cz-prop.z)-Math.hypot(b.cx-prop.x,b.cz-prop.z))[0];
        if(!facet)throw Error('No clear nearby drum circle footprint');
        const b=spawnBuilding(w,'drumcircle',0,facet.id,1);
        for(let i=0;i<4;i++){const h=spawnHippie(w,0,{x:b.pos.x+Math.cos(i*Math.PI/2)*2,z:b.pos.z+Math.sin(i*Math.PI/2)*2});h.status='drumming';people.push(h);}
        if(sceneryRitualMultiplier(w,0,b.pos)!==1.25)throw Error('Art is not affecting staged staffed circle');
      }
      if(kind==='car')for(let i=0;i<vehicleCapacity(prop)+1;i++)stagedFlags.push(spawnFlag(w,{state:'loose',owner:0,pos:{x:service.x+i*.2,y:ground,z:service.z}}));
      const snapshot=()=>({hp:people.map(h=>h.hp),attention:people.map(h=>h.attention),service:people.map(h=>h.sceneryService??null),ritual:w.factions[0].ritual,lodging:sceneryLodging(w,0),popCap:popCap(w,0),stock:depotStock(w,depotHolder(prop.id)),flags:w.flags.size});
      const before=snapshot(); const phaseHistory=[];
      app.session.hover.point={x:prop.x,y:ground+Math.min(prop.height,.5),z:prop.z};app.session.hover.entity=-1;
      app.ui.update(0); app.renderer.render(0);await new Promise(r=>setTimeout(r,500));app.ui.update(0);
      window.sceneryFrame=i=>{
        w.time+=1/30;window.captureBeat+=1/15;
        if(['dome','shade','porta'].includes(kind))for(const h of people)updateSceneryService(w,sys,h,brainOf(h),0,1/30);
        if(kind==='art')updateEconomy(w,1/30);
        if(kind==='car'&&i===30)for(const fl of stagedFlags)depositToStock(w,fl.id,depotHolder(prop.id));
        if(i%30===0)phaseHistory.push(snapshot());
        app.renderer.onEvents(w.drainEvents());app.renderer.render(1/30);app.ui.update(1/30);
      };
      window.sceneryResult=()=>{
        const after=snapshot(), near=(a,b)=>Math.abs(a-b)<1e-6;
        if(kind==='tent'&&after.popCap-beforeCap!==tentPlaces(prop))throw Error('Lodging cap did not increase');
        if(kind==='dome'&&!after.hp.every(hp=>near(hp,62)))throw Error('Dome did not heal 3 HP/sec for four patients');
        if(kind==='shade'&&!after.attention.every(a=>near(a,56)))throw Error('Shade did not restore 4 attention/sec');
        if(kind==='porta'&&(!near(after.attention[0],60)||!near(after.attention[1],40)))throw Error('Porta must complete one three-second visit, not reward queue');
        if(kind==='art'&&!near(after.ritual-before.ritual,4*4*DRUM_RITUAL_PER_SEC*1.25))throw Error('Art ritual gain is not +25%');
        if(kind==='car'&&(after.stock!==vehicleCapacity(prop)||after.flags!==before.flags||stagedFlags.at(-1).state!=='loose'))throw Error('Depot capacity/conservation failed');
        const card=document.querySelector('.scenery-benefit');
        if(!card||card.getAttribute('aria-hidden')!=='false')throw Error('Actual benefit HUD is not visible');
        return {after,phaseHistory,card:card.textContent,assertions:'passed'};
      };
      return {kind,id:prop.id,variant:prop.variant,position:{x:prop.x,y:ground,z:prop.z},framing,before,beforeCap,staging:'Ownership, needs and optional circle/loose flags staged; production systems run for four seconds at 30 Hz.'};
    },kind);
    for(let i=0;i<120;i++) {
      await page.evaluate(i=>window.sceneryFrame(i),i);
      await page.screenshot({path:resolve(out,`${String(shot*120+i).padStart(4,'0')}.png`)});
    }
    const result=await page.evaluate(()=>window.sceneryResult());scenes.push({setup,result});
    await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,pageErrors,responses},null,2));
  }
  const hostFailures=responses.filter(r=>r.url==='http://127.0.0.1:5173/api/info'&&r.status===502);
  const optionalOnly=pageErrors.length===0&&hostFailures.length>0&&responses.length===hostFailures.length&&errors.length<=hostFailures.length&&errors.every(e=>e.startsWith('Failed to load resource:'));
  if(errors.length&&!optionalOnly)throw Error(errors.join('\n'));
  execFileSync('ffmpeg',['-y','-framerate','30','-i',resolve(out,'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-movflags','+faststart',resolve(out,'scenery-benefits.mp4')]);
  await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,pageErrors,responses,note:'Six staged actual-game production-system shots, full rendered page including real contextual HUD; no synthetic overlays, compositing, rule overrides or main publication.'},null,2));
} finally { await writeFile(resolve(out,'capture-diagnostics.json'),JSON.stringify({scenes,errors,pageErrors,responses},null,2)); await browser.close(); }
