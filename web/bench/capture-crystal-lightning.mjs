/** Actual-game owner-color proof. Stages source ownership/positions, then uses the
 * production defensive-link and protected-pull presentation paths. No damage,
 * timing, shader, camera controls, or game rules are overridden in shipped code.
 * Run from web/ with Vite serving and supported headed Chrome (sandbox enabled).
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const out = resolve(process.env.CAPTURE_OUT || 'crystal-lightning-proof');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
const errors = [], pageErrors = [], responses = [], scenes = [];
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
  for (const [shot, mode] of ['boss', 'crystal-protection', 'ward-protection'].entries()) {
    const setup = await page.evaluate(async mode => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { spawnCrystal, spawnBuilding, spawnFlag } = await import('/src/sim/factory.ts');
      const { spawnBoss } = await import('/src/sim/systems/boss.ts');
      const { syncBossLightning } = await import('/src/sim/systems/boss/lightning.ts');
      const { defendedPullRate } = await import('/src/sim/systems/flags.ts');
      const { setLightningPalette } = await import('/src/render/vfx/lightningPalette.ts');
      const app = window.flaghack;
      app.session.settings.masterVolume = 0; app.session.settings.quality = 'medium';
      window.captureBeat = 0; app.renderer.beatSource = () => window.captureBeat;
      app.startMatch({ seed: 'crystal-owner-color-proof', difficulty: 'normal', humans: [0], match: { days: -1, bossMode: false, maxSignifiers: 0 } });
      app.ai.clear();
      const w = app.world; w.time = 470; w.hippies.clear(); w.crystals.clear();
      for (const av of w.avatars.values()) av.pos = { x: -1000, y: 0, z: -1000 };
      const camera = app.renderer.camera; camera.fov = 48; camera.updateProjectionMatrix();
      // Pick a real open map footprint; keep scenery and lighting unmodified.
      const centers = [{x:0,z:0},{x:0,z:65},{x:65,z:0},{x:-65,z:0},{x:0,z:-65},{x:65,z:65},{x:-65,z:65}];
      let center = centers.find(p => [-24,-8,8,24].every(x => !w.collision.blockedCircle(p.x+x,p.z,2,.1,12)) && !w.collision.blockedCircle(p.x,p.z-23,5,.1,35));
      center ??= centers[0];
      const nearest = p => w.lattice.nodes.filter(n=>!n.blocked).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];
      const sources = [], flags = [];
      for (let faction=0; faction<4; faction++) {
        const x=center.x+(faction-1.5)*16, z=center.z, n=nearest({x,z}), fn=nearest({x:x+3,z:z+10});
        const source=mode==='ward-protection'?spawnBuilding(w,'ward',faction,0,1):spawnCrystal(w,n.id,faction,[fn.id]);
        source.pos={x:n.x,z:n.z};
        if(source.type==='crystal'){source.scale=1;source.growth=1;}
        const fl=spawnFlag(w,{state:'planted',owner:faction,node:fn.id,pos:{x:fn.x,y:w.collision.groundHeight(fn.x,fn.z),z:fn.z}});
        sources.push(source); flags.push(fl);
      }
      let boss=null;
      if(mode==='boss'){
        w.effigyRevealedAt=w.time-10;boss=spawnBoss(w);boss.action='idle';boss.actionAt=w.time-10;boss.pos={x:center.x,z:center.z-23};boss.yaw=0;syncBossLightning(w,boss);
        if(boss.lightning.length!==4)throw Error('All four crystals must link to boss');
      }
      const y=w.collision.groundHeight(center.x,center.z), targetY=mode==='boss'?12:4;
      camera.position.set(center.x,y+(mode==='boss'?33:29),center.z+(mode==='boss'?82:66));camera.lookAt(center.x,y+targetY,center.z-4);camera.updateMatrixWorld();
      w.drainEvents();app.renderer.render(0);await new Promise(r=>setTimeout(r,2500));app.renderer.render(0);await new Promise(r=>setTimeout(r,500));
      const scene=app.renderer.ctx.scene, vfx=app.renderer.modules.find(m=>m.bolts&&m.bossLightning);
      if(!vfx)throw Error('Production VFX module not available');
      const hp=boss?.hp, history=[], initialMeshes=boss?[...vfx.bossLightning.group.children]:[];
      const expectedGlow=owner=>{const core=new THREE.Color(),glow=new THREE.Color();setLightningPalette(core,glow,w.factions[owner].color);return glow;};
      const close=(a,b)=>a.distanceToSquared? a.distanceToSquared(b)<1e-8:Math.abs(a.r-b.r)+Math.abs(a.g-b.g)+Math.abs(a.b-b.b)<1e-6;
      const snapshot=()=>({owners:sources.map(s=>s.faction),colors:sources.map(s=>w.factions[s.faction].color),bossHp:boss?.hp??null,persistentLinks:boss?.lightning.map(l=>({id:l.id,faction:l.faction}))??[],activeBolts:Array.from(vfx.bolts.mesh.material.uniforms.uAlpha.value).filter(a=>a>0).length});
      window.lightningFrame=i=>{
        w.time+=1/30;window.captureBeat+=1/15;
        if(i===60){for(let k=0;k<4;k++){sources[k].faction=(k+1)%4;flags[k].owner=sources[k].faction;}}
        if(boss)syncBossLightning(w,boss);
        else if(i%15===0)for(let k=0;k<4;k++){
          const rate=defendedPullRate(w,flags[k],(sources[k].faction+1)%4,true);
          if(rate>=1)throw Error('Production protected pull did not emit lightning');
        }
        const events=w.drainEvents();app.renderer.onEvents(events);app.renderer.render(1/30);app.ui.update(1/30);
        if(boss){
          if(boss.hp!==hp)throw Error('Presentation capture changed boss HP');
          for(let k=0;k<4;k++){
            const mesh=scene.getObjectByName(`boss-defensive-lightning-${sources[k].id}`);
            if(mesh!==initialMeshes[k])throw Error('Ownership transition replaced persistent mesh');
            if(!close(mesh.material.uniforms.uGlow.value,expectedGlow(sources[k].faction)))throw Error('Persistent owner halo is incorrect');
          }
        }else if(i%15===0){
          const active=vfx.bolts.bolts.map((b,index)=>({b,index})).filter(({b})=>b.active);
          if(active.length!==4)throw Error('Expected four active protected-pull bolts');
          for(const {b,index} of active){const source=sources.find(s=>s.id===b.source?.id);if(!source||!close(vfx.bolts.mesh.material.uniforms.uGlow.value[index],expectedGlow(source.faction)))throw Error('Transient owner halo is incorrect');}
        }
        if([0,59,60,119].includes(i))history.push({frame:i,...snapshot()});
      };
      window.lightningResult=()=>{
        const before=snapshot();
        if(boss){w.boss=null;app.renderer.render(0);if(vfx.bossLightning.group.children.length)throw Error('Persistent cleanup failed');}
        else {app.renderer.render(1);if(vfx.bolts.mesh.visible)throw Error('Expired transient bolts stayed visible');}
        return {before,history,cleanup:'passed',assertions:'passed'};
      };
      return {mode,center,sources:sources.map(s=>({id:s.id,kind:s.type,pos:s.pos,faction:s.faction})),camera:camera.position.toArray(),staging:'Four source entities and protected flags staged at real lattice positions. Production syncBossLightning / defendedPullRate called without damage or rule overrides. Owner changes after frame 59.'};
    },mode);
    for(let i=0;i<120;i++){
      await page.evaluate(i=>window.lightningFrame(i),i);
      await page.screenshot({path:resolve(out,`${String(shot*120+i).padStart(4,'0')}.png`)});
    }
    const result=await page.evaluate(()=>window.lightningResult());scenes.push({setup,result});
    await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,pageErrors,responses},null,2));
  }
  const hostFailures=responses.filter(r=>r.url==='http://127.0.0.1:5173/api/info'&&(r.status===502||r.failure==='net::ERR_ABORTED'));
  const optionalOnly=pageErrors.length===0&&hostFailures.some(r=>r.status===502)&&responses.length===hostFailures.length&&errors.length<=hostFailures.length&&errors.every(e=>e.startsWith('Failed to load resource:'));
  if(errors.length&&!optionalOnly)throw Error(errors.join('\n'));
  execFileSync('ffmpeg',['-y','-framerate','30','-i',resolve(out,'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-movflags','+faststart',resolve(out,'crystal-owner-lightning.mp4')]);
  const keep=new Set([0,59,60,119,120,179,180,239,240,299,300,359]);
  for(let i=0;i<360;i++)if(!keep.has(i))await unlink(resolve(out,`${String(i).padStart(4,'0')}.png`));
  await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,pageErrors,responses,commit:process.env.GITHUB_SHA??null,note:'Three staged actual-game shots: persistent boss arcs, crystal protection, ward protection. Cyan/red/green/purple simultaneously, then live ownership rotation. No synthetic overlays or shipped simulation changes.'},null,2));
} finally {await writeFile(resolve(out,'capture-diagnostics.json'),JSON.stringify({scenes,errors,pageErrors,responses},null,2));await browser.close();}
