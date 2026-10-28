/** Native production renderer proof, staged entities on untouched real terrain/collision.
 * From web/: CAPTURE_OUT=/tmp/rts-proof node bench/capture-rts-recruitment.mjs
 * Requires Vite at CAPTURE_URL (default localhost:5173), Playwright, headed Chrome and ffmpeg.
 * No shipped gameplay overrides, fake geometry, boss spoilers or sandbox disabling.
 */
import { chromium } from 'playwright';
import { mkdir,writeFile,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const out=resolve(process.env.CAPTURE_OUT||'rts-recruitment-proof'), url=process.env.CAPTURE_URL||'http://127.0.0.1:5173/';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true});
const errors=[],pageErrors=[],responses=[],scenes=[],keepers=new Set(); let frame=0;
try {
 const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
 page.on('pageerror',e=>{pageErrors.push(String(e));errors.push(String(e));});
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 page.on('response',r=>{if(r.status()>=400)responses.push({url:r.url(),status:r.status()});});
 page.on('requestfailed',r=>responses.push({url:r.url(),failure:r.failure()?.errorText}));
 await page.addInitScript(()=>{const raf=window.requestAnimationFrame.bind(window);window.captureFrozen=false;window.requestAnimationFrame=fn=>raf(t=>{if(!window.captureFrozen)fn(t);});});
 await page.goto(url); await page.waitForFunction(()=>!!window.flaghack&&!!window.fh,null,{timeout:90000,polling:100});
 const introSkipped=await page.evaluate(async()=>{await window.flaghack.ready;const skip=document.querySelector('#startup-skip');skip?.click();return !!skip;});
 await page.waitForFunction(()=>!document.querySelector('#startup'),null,{timeout:30000,polling:100});
 await page.evaluate(()=>{window.captureFrozen=true;});
 for(const owner of [0,1,2,3]) {
  const setup=await page.evaluate(async owner=>{
   const THREE=await import('/node_modules/three/build/three.module.js');
   const {spawnHippie}=await import('/src/sim/factory.ts');
   const {normalizeMatch}=await import('/src/sim/matchSettings.ts');
   const {updateCrystalAttacks,throneAttackOrigin,crystalAttackAim}=await import('/src/sim/systems/crystalAttacks.ts');
   const {setLightningPalette}=await import('/src/render/vfx/lightningPalette.ts');
   const app=window.flaghack;app.session.settings.masterVolume=0;app.session.settings.quality='medium';
   window.captureBeat=0;app.renderer.beatSource=()=>window.captureBeat;
   app.load({mode:'standard',seed:'rts-throne-proof',difficulty:'normal',humans:[0,1,2,3],rtsFactions:[0,1,2,3],match:normalizeMatch({days:-1,bossMode:false,maxSignifiers:0,startingSignifiers:0,crystalAttacks:true})});
   app.enterPlay();app.session.playerFaction=typeof owner==='number'?owner:0;app.session.view='command';app.session.viewBlend=1;app.ai.clear();const w=app.world;w.time=470;w.hippies.clear();w.crystals.clear();
   if(w.avatars.size!==0)throw Error('RTS match must contain zero avatar entities');
   const altar=w.hearthOf(owner), target=spawnHippie(w,(owner+1)%4,{x:0,z:0});let found=false;
   // Test existing collision/LOS, never remove obstructions to manufacture a shot.
   for(let i=0;i<36;i++) {
    const a=altar.yaw+Math.PI/3+(i%2?-1:1)*Math.ceil(i/2)*Math.PI/18;
    const p={x:altar.pos.x+Math.sin(a)*10,z:altar.pos.z+Math.cos(a)*10};
    if(w.collision.blockedCircle(p.x,p.z,1,.1,5))continue;
    target.pos=p;const from=throneAttackOrigin(w,owner),to=crystalAttackAim(w,target);
    if(w.collision.raycast(from.x,from.y,from.z,to.x-from.x,to.y-from.y,to.z-from.z,Math.hypot(to.x-from.x,to.y-from.y,to.z-from.z)-.05,altar.id))continue;
    found=true;break;
   }
   if(!found)throw Error(`No real unobstructed throne shot for ${owner}`);
   const camera=app.renderer.camera,y=w.collision.groundHeight(altar.pos.x,altar.pos.z),yaw=altar.yaw;
   camera.fov=45;camera.updateProjectionMatrix();
   camera.position.set(altar.pos.x+Math.sin(yaw)*28+Math.cos(yaw)*8,y+13,altar.pos.z+Math.cos(yaw)*28-Math.sin(yaw)*8);
   camera.lookAt(altar.pos.x+(target.pos.x-altar.pos.x)*.25,y+3.1,altar.pos.z+(target.pos.z-altar.pos.z)*.25);camera.updateMatrixWorld();
   w.drainEvents();app.renderer.render(0);await new Promise(r=>setTimeout(r,1800));app.renderer.render(0);
   const rulers=app.renderer.ctx.scene.getObjectByName('rts-rulers');
   if(!rulers||rulers.children.filter(c=>c.visible).length!==4)throw Error('Expected all four live throne markers');
   const ruler=rulers.getObjectByName(`rts-ruler-${owner}`),stripe=ruler.getObjectByName('throne-faction-stripes');
   if(stripe.material.color.getHex()!==w.factions[owner].color)throw Error('Wrong throne ownership paint');
   const hp=target.hp,history=[];let disabledHp=null;updateCrystalAttacks(w,0);
   if(w.factions[owner].throneAttack?.target!==target.id)throw Error('Production throne solver did not acquire target');
   window.proofFrame=i=>{
    if(i===60){w.options.match.crystalAttacks=false;disabledHp=target.hp;}
    w.time+=1/30;w.tick++;window.captureBeat+=1/15;updateCrystalAttacks(w,1/30);
    app.renderer.onEvents(w.drainEvents());app.renderer.render(1/30);app.ui.update(1/30);
    const arc=app.renderer.ctx.scene.getObjectByName(`crystal-unit-lightning-${altar.id}`),ring=app.renderer.ctx.scene.getObjectByName(`crystal-unit-warning-${altar.id}`);
    if(i<29&&(!ring?.visible||target.hp!==hp))throw Error('Throne warning must be harmless and visible');
    if(i>=32&&i<60&&(ring?.visible||target.hp>=hp))throw Error('Throne attack must damage after warning');
    if(i>=60&&(arc||ring||w.factions[owner].throneAttack||target.hp!==disabledHp))throw Error('Lightning toggle must stop throne attacks');
    if(arc){const core=new THREE.Color(),glow=new THREE.Color();setLightningPalette(core,glow,w.factions[owner].color);const actual=arc.material.uniforms.uGlow.value;if(Math.abs(actual.r-glow.r)+Math.abs(actual.g-glow.g)+Math.abs(actual.b-glow.b)>1e-6)throw Error('Wrong lightning owner color');}
    if([0,28,32,59,60,89].includes(i))history.push({frame:i,hp:target.hp,warning:!!ring?.visible,arc:!!arc});
   };
   window.proofResult=()=>({history,avatarEntities:w.avatars.size,visibleRulers:rulers.children.filter(c=>c.visible).length,assertions:'passed'});
   return{owner,color:w.factions[owner].color,altar:altar.pos,target:target.pos,camera:camera.position.toArray(),staging:'Actual existing altar and real clear LOS; production warning/damage/toggle, no boss.'};
  },owner);
  const start=frame;
  for(let i=0;i<90;i++){await page.evaluate(i=>window.proofFrame(i),i);if([0,28,32,59,60,89].includes(i))keepers.add(frame);await page.screenshot({path:resolve(out,`${String(frame++).padStart(4,'0')}.png`)});}
  scenes.push({mode:'throne-lightning',start,end:frame-1,setup,result:await page.evaluate(()=>window.proofResult())});
  await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,pageErrors,responses},null,2));
 }
 for(const mode of ['commanded','passive']) {
  const setup=await page.evaluate(async mode=>{
   const {spawnHippie}=await import('/src/sim/factory.ts');
   const {normalizeMatch}=await import('/src/sim/matchSettings.ts');
   const {updateHippies}=await import('/src/sim/systems/hippies.ts');
   const {applyCommands}=await import('/src/sim/systems/commands.ts');
   const {updateEconomy}=await import('/src/sim/systems/economy.ts');
   const {brainOf}=await import('/src/sim/systems/units/brain.ts');
   const app=window.flaghack;
   app.load({mode:'standard',seed:'recruitment-orders',difficulty:'normal',humans:[0,1,2,3],rtsFactions:[0,1,2,3],match:normalizeMatch({days:3,bossMode:false,maxSignifiers:0,startingSignifiers:0,startingLumber:0})});
   app.enterPlay();app.session.playerFaction=typeof owner==='number'?owner:0;app.session.view='command';app.session.viewBlend=1;app.ai.clear();const w=app.world;w.time=470;w.hippies.clear();const gcc=w.gccOf(0),home=w.hearthOf(0),anchor=mode==='commanded'?home:gcc;
   // Disable other recruiters only for isolated provenance: no unseen passive enlistment can win the command race.
   for(const b of w.buildings.values())if(b.kind==='gcc'||b.kind==='drumcircle')b.disabled=mode==='commanded'||b.id!==gcc.id;
   w.factions.forEach(f=>f.lumber=0);
   const neutral=spawnHippie(w,-1,w.nav.nearestWalkable(anchor.pos.x+(mode==='commanded'?10:23),anchor.pos.z));
   let worker=null;
   if(mode==='commanded'){
    worker=spawnHippie(w,0,w.nav.nearestWalkable(home.pos.x+5,home.pos.z));
    const idle=brainOf(neutral);idle.task='wander';idle.waitUntil=Infinity;
    w.submit({t:'order',faction:0,hippies:[worker.id],order:{kind:'recruit',target:neutral.id}});applyCommands(w);
    if(worker.order?.kind!=='recruit')throw Error('Production command rejected');
   }
   const camera=app.renderer.camera,y=w.collision.groundHeight(anchor.pos.x,anchor.pos.z);
   camera.position.set(anchor.pos.x+14,y+22,anchor.pos.z+30);camera.lookAt(anchor.pos.x+8,y+1,anchor.pos.z);camera.updateMatrixWorld();
   w.drainEvents();app.renderer.render(0);await new Promise(r=>setTimeout(r,1800));app.renderer.render(0);
   const stock=new Set([...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).map(f=>f.id)),flags=w.flags.size,pop=w.hippies.size;
   let enlistedAt=null;const history=[];let fetched=false,conservedHandoff=false;
   window.proofFrame=i=>{
    w.time+=1/30;w.tick++;updateHippies(w,1/30);if(mode==='passive')updateEconomy(w,1/30);
    const events=w.drainEvents();app.renderer.onEvents(events);app.renderer.render(1/30);app.ui.update(1/30);
    if(worker&&stock.has(worker.carryingFlag))fetched=true;
    if(w.flags.size!==flags||w.hippies.size!==pop)throw Error('Recruitment duplicated a flag/person');
    if(neutral.faction===0&&enlistedAt===null){enlistedAt=i;conservedHandoff=stock.has(neutral.carryingFlag)&&w.flags.get(neutral.carryingFlag)?.holder===neutral.id;history.push({frame:i,event:'joined',id:neutral.id,flag:neutral.carryingFlag,via:events.find(e=>e.t==='recruited')?.via});}
    if(i%30===0)history.push({frame:i,neutral:{...neutral.pos},owner:neutral.faction,worker:worker?{...worker.pos}:null,carried:worker?.carryingFlag});
    return enlistedAt!==null&&i>=enlistedAt+45;
   };
   window.proofResult=()=>{
    if(enlistedAt===null)throw Error('No real enlistment completed within the capture window');
    if(mode==='commanded'&&(!fetched||!conservedHandoff))throw Error('Commanded recruit must receive the same real stocked flag');
    if(mode==='passive'&&w.factions[0].lumber!==0)throw Error('Passive recovery altered resource requirement');
    return{history,enlistedAt,fetched,conservedHandoff,flags,pop,avatarEntities:w.avatars.size,assertions:'passed'};
   };
   return{mode,anchor:anchor.pos,neutralStart:{...neutral.pos},workerStart:worker?{...worker.pos}:null,staging:mode==='commanded'?'One selected worker ordered through world.submit; waiting neutral. Stock pickup, walking and handoff run production systems. Other recruiters disabled.':'Zero workers and lumber; one real neutral23m from working GCC, other recruiters disabled. Production movement and economy at1/30s, no replacement spawn.'};
  },mode);
  const start=frame;let done=false;
  for(let i=0;i<1800&&!done;i++){done=await page.evaluate(i=>window.proofFrame(i),i);if(i%90===0||done)keepers.add(frame);await page.screenshot({path:resolve(out,`${String(frame++).padStart(4,'0')}.png`)});}
  scenes.push({mode,start,end:frame-1,setup,result:await page.evaluate(()=>window.proofResult())});
  await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,pageErrors,responses},null,2));
 }
 const info=new URL('/api/info',url).href,intro=new URL('/src/startup/assets/flaghack-gameplay-intro-25s.mp4',url).href;
 const hostFailures=responses.filter(r=>r.url===info&&(r.status===502||r.failure==='net::ERR_ABORTED'));
 const skippedIntro=responses.filter(r=>introSkipped&&r.url===intro&&r.failure==='net::ERR_ABORTED');
 const optionalOnly=pageErrors.length===0&&hostFailures.some(r=>r.status===502)&&responses.length===hostFailures.length+skippedIntro.length&&errors.length<=hostFailures.length&&errors.every(e=>e.startsWith('Failed to load resource:'));
 if(errors.length&&!optionalOnly)throw Error(errors.join('\n'));
 execFileSync('ffmpeg',['-y','-framerate','30','-i',resolve(out,'%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-movflags','+faststart',resolve(out,'rts-recruitment.mp4')]);
 for(let i=0;i<frame;i++)if(!keepers.has(i))await unlink(resolve(out,`${String(i).padStart(4,'0')}.png`));
 await writeFile(resolve(out,'provenance.json'),JSON.stringify({scenes,errors,pageErrors,responses,commit:process.env.GITHUB_SHA??null,frames:frame,fps:30,note:'Production game pixels; deliberately staged demonstration, not organic player-input footage. No boss encounter shown.'},null,2));
} finally {await writeFile(resolve(out,'capture-diagnostics.json'),JSON.stringify({scenes,errors,pageErrors,responses,frames:frame},null,2));await browser.close();}
