/** Native Chrome dropped-card/beacon QA. Explicit fixtures stage public pickups
 * and camps; desktop movement and beacon pickup use production keyboard input. Raw video is 1x speed.
 * Mobile cases are browser-emulated, not physical-device certification. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), {chromium}=require('playwright');
const HERE=dirname(fileURLToPath(import.meta.url)), DIST=resolve(HERE,'../dist'), OUT=resolve(HERE,'../host-release/beacon-card-smoke');
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
const results={completed:false,physicalDeviceTest:false,recordingSpeed:1,fixtureDisclosure:'Public dropped cards, enemy beacons, resources and camp affiliations are staged deterministically for close-up visibility. Desktop card pickup uses real W movement, beacon pickup real E; deck pieces/resources are staged, then real desktop clicks and mobile long-press/menu/Confirm place workshops and wards. A ground Ward is placed by real mouse click and completes naturally under a staged roof; actual finished body including completion bounce is measured, excluding the temporary scaffold. Rectangular thick/thin ramps, adjoining decks and low-edge avatar starts are staged; real desktop W ascends onto the decks and collision rays verify empty side corners. Ladder starting position and neighboring floor are staged; desktop ascent/descent use real keyboard and disclosed emulated standard-controller axes through production polling, never injected avatar movement. Mobile remains command-only and an emulated standard controller is checked not to move its staged Regular avatar. Mobile is emulated Regular-mode, not physical-device, touch-joystick or Degen pickup certification.',scenarios:[]};
let browser,page;
async function stage(){
  return page.evaluate(()=>{
    const a=window.flaghack,w=a.world,av=w.avatarOf(0);let at;
    for(let x=-35;x<35&&!at;x+=5)for(let z=-35;z<35&&!at;z+=5){
      if(![-3,0,3,5].every(d=>w.nav.isWalkable(x,z+d)&&w.nav.isWalkable(x+d,z)))continue;
      if([...w.buildings.values()].some(b=>Math.hypot(b.pos.x-x,b.pos.z-z)<18))continue;
      at={x,z};
    }
    if(!at)throw Error('No clear pickup fixture position');
    av.pos={x:at.x,y:w.collision.groundHeight(at.x,at.z),z:at.z};av.vel={x:0,y:0,z:0};av.hp=200;av.koUntil=0;av.action={kind:'idle'};
    for(const flag of [...w.flags.values()])if(flag.holder===av.id||Math.hypot(flag.pos.x-at.x,flag.pos.z-at.z)<10)window.fh.flags.destroyFlag(w,flag.id);
    for(const h of w.hippies.values()){if(!h.wizard)h.faction=-1;h.pos={x:at.x+60,z:at.z+60};}
    const ids=[];
    for(const faction of [1,1,1,2,2,-1]){
      const h=window.fh.factory.spawnHippie(w,faction,{x:at.x+20+ids.length*3,z:at.z+20});h.attention=100;ids.push({id:h.id,faction});
    }
    const cards=[{id:w.newId(),rank:12,suit:2},{id:w.newId(),rank:0,suit:0,arcana:19},{id:w.newId(),rank:1,suit:0,parody:0}];
    const offsets=[[0,2.6],[2.8,0],[-2.8,0]];
    w.frickFrack.drops=cards.map((card,i)=>({id:card.id,card,pos:{x:at.x+offsets[i][0],z:at.z+offsets[i][1]},createdAt:w.time}));
    w.frickFrack.sideboards[0]=[];w.beacons.clear();
    const beacon=window.fh.factory.spawnBeacon(w,1,{x:at.x+1.6,z:at.z+2.4},w.time+120);
    a.session.camera.yaw=0;a.session.camera.pitch=.72;a.session.camera.dist=7;
    a.session.camera.cmdX=at.x;a.session.camera.cmdZ=at.z;a.session.camera.cmdHeight=32;
    const fixture={at,cards,beacon:beacon.id,hippies:ids,meshTap:structuredClone(w.factions[0].meshTap)};window.__dropFixture=fixture;
    return fixture;
  });
}
async function renderState(){return page.evaluate(()=>{
  const a=window.flaghack,w=a.world,ctx=a.renderer.ctx,fixture=window.__dropFixture;
  const cards=fixture.cards.map(c=>{const m=ctx.scene.getObjectByName(`frick-frack-card-${c.id}`);return m?{id:c.id,name:m.userData.cardLabel,x:m.position.x,y:m.position.y,z:m.position.z,ground:ctx.shared.groundOffset(m.position.x,m.position.z),tilt:m.rotation.x,textureVersion:m.material.map.version,imageWidth:m.material.map.image?.width}:null;});
  const ring=ctx.scene.getObjectByName('actors-rings'),glow=ctx.scene.getObjectByName('actors-status-icons');
  const ringA=ring.geometry.getAttribute('aRingA'),ringB=ring.geometry.getAttribute('aRingB'),ringC=ring.geometry.getAttribute('aRingC');
  const glowA=glow.geometry.getAttribute('aIconA'),glowB=glow.geometry.getAttribute('aIconB');
  const glows=[];for(let i=0;i<glow.geometry.instanceCount;i++)if(glowB.getW(i)===1)glows.push({x:glowA.getX(i),z:glowA.getZ(i),size:glowA.getW(i)});
  const pulses=[];for(let i=0;i<ring.geometry.instanceCount;i++)if(ringC.getX(i)===3)pulses.push({x:ringA.getX(i),z:ringA.getZ(i),radius:ringA.getW(i),intensity:ringB.getW(i)});
  return {cards,pulses,glows,glowAttributes:Object.keys(glow.geometry.attributes),prompt:a.session.prompt,sideboard:w.frickFrack.sideboards[0],beaconExists:w.beacons.has(fixture.beacon),hippies:fixture.hippies.map(h=>({id:h.id,was:h.faction,now:w.hippies.get(h.id)?.faction})),meshTap:w.factions[0].meshTap,view:a.session.view,deviceLayout:document.documentElement.dataset.deviceLayout};
});}
async function platformScenario(spec,context,check){
  await page.evaluate(()=>{const a=window.flaghack;a.session.view='command';a.session.tool='flag';a.world.factions[0].lumber=1000;});
  await page.waitForTimeout(1100);
  for(const kind of ['workshop','ward']){
    const target=await page.evaluate(kind=>{
      const a=window.flaghack,w=a.world,f=window.fh;
      const fc=w.lattice.facets.find(fc=>f.buildings.canPlaceBuilding(w,0,kind,fc.id).ok&&!Array.from(w.pieces.values()).some(p=>p.facet===fc.id));
      if(!fc)throw Error(`No owned buildable ${kind} fixture facet`);
      const p=f.factory.spawnPiece(w,'floor',0,-1,fc.id,0,-1);f.pieces.attachPiece(w,p);
      const valid=f.buildings.canPlaceBuilding(w,0,kind,fc.id,1);if(!valid.ok)throw Error(`Platform fixture rejected: ${valid.reason}`);
      a.session.camera.cmdX=fc.cx;a.session.camera.cmdZ=fc.cz;a.session.camera.cmdHeight=32;
      const target={facet:fc.id,x:fc.cx,z:fc.cz,y:w.collision.groundHeight(fc.cx,fc.cz)+5.77,kind};window.__platformTarget=target;
      return target;
    },kind);
    await page.waitForTimeout(1500);
    const point=await page.evaluate(()=>{const a=window.flaghack,t=window.__platformTarget,c=a.renderer.camera,p=c.position.clone().set(t.x,t.y,t.z).project(c),r=a.renderer.renderer.domElement.getBoundingClientRect();return{x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2};});
    assert.ok(point.x>0&&point.x<spec.width&&point.y>0&&point.y<spec.height,'Deck target is on screen');
    if(spec.mobile){
      await page.locator('.mc-modes').getByRole('button',{name:'Plan',exact:true}).click();
      const cdp=await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,radiusX:2,radiusY:2,force:1,id:1}]});
      await page.waitForTimeout(800);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
      await page.waitForFunction(()=>window.flaghack.session.mobileMenu==='build'&&window.flaghack.session.mobileBuildLevel===1);
      await page.locator('.mc-page[data-tab="build"] .build-btn').filter({hasText:kind==='workshop'?/Workshop/:/Ward/}).click();
    }else{
      await page.evaluate(kind=>{window.flaghack.session.tool='building';window.flaghack.session.buildingKind=kind;},kind);
      await page.mouse.move(point.x,point.y);
    }
    await page.waitForFunction(()=>{const s=window.flaghack.session,t=window.__platformTarget;return s.ghost?.valid&&s.ghost.facet===t.facet&&s.ghost.level===1;});
    await page.screenshot({path:join(OUT,`${spec.name}-${kind}-deck-ghost.png`)});
    if(spec.mobile)await page.locator('.mc-placement').getByRole('button',{name:'Confirm',exact:true}).click();
    else await page.mouse.click(point.x,point.y,{delay:80});
    await page.waitForFunction(()=>{const w=window.flaghack.world,t=window.__platformTarget;return Array.from(w.buildings.values()).some(b=>b.kind===t.kind&&b.facet===t.facet&&b.level===1);});
    await page.waitForTimeout(600);
    const placed=await page.evaluate(()=>{
      const a=window.flaghack,w=a.world,t=window.__platformTarget,b=Array.from(w.buildings.values()).find(b=>b.kind===t.kind&&b.facet===t.facet);
      const module=a.renderer.modules.find(m=>m.views?.has(b.id)),root=module?.views.get(b.id).root;
      return{level:b.level,rootY:root?.position.y,ground:a.renderer.ctx.shared.groundOffset(b.pos.x,b.pos.z)};
    });
    assert.equal(placed.level,1);assert.ok(Math.abs(placed.rootY-placed.ground-5.77)<.001,'Building model remains on its deck');
    await page.screenshot({path:join(OUT,`${spec.name}-${kind}-on-deck.png`)});
    await page.waitForFunction(()=>{const w=window.flaghack.world,t=window.__platformTarget;return Array.from(w.buildings.values()).some(b=>b.kind===t.kind&&b.facet===t.facet&&b.level===1&&b.built>=1);},null,{timeout:60000});
    await page.waitForTimeout(900);
    await page.screenshot({path:join(OUT,`${spec.name}-${kind}-completed-on-deck.png`)});
    check(`${kind} deck-level ghost agrees with actual ${spec.mobile?'long-press/menu/Confirm':'mouse-click'} placement and raised model`);
    await page.evaluate(()=>{window.flaghack.session.tool='flag';});
  }
}
async function ladderScenario(spec,context,check){
  const fixture=await page.evaluate(()=>{
    const a=window.flaghack,w=a.world,f=window.fh;
    const fc=w.lattice.facets.find(fc=>Math.abs(fc.cx)<35&&Math.abs(fc.cz)<35&&fc.edges.every(e=>w.lattice.edges[e].facets.length===2)&&
      fc.nodes.every(n=>w.nav.isWalkable(w.lattice.nodes[n].x,w.lattice.nodes[n].z))&&
      ![...w.pieces.values()].some(p=>{const c=w.lattice.facets[p.facet];return c&&Math.hypot(c.cx-fc.cx,c.cz-fc.cz)<20;})&&
      ![...w.buildings.values()].some(b=>Math.hypot(b.pos.x-fc.cx,b.pos.z-fc.cz)<20));
    if(!fc)throw Error('No unobstructed ladder fixture facet');
    const edge=w.lattice.edges[fc.edges[0]],n0=w.lattice.nodes[edge.a],n1=w.lattice.nodes[edge.b];
    const x=(n0.x+n1.x)/2,z=(n0.z+n1.z)/2,length=Math.hypot(n1.x-n0.x,n1.z-n0.z);
    let nx=(n1.z-n0.z)/length,nz=-(n1.x-n0.x)/length;if((x-fc.cx)*nx+(z-fc.cz)*nz<0){nx=-nx;nz=-nz;}
    const floor=f.factory.spawnPiece(w,'floor',0,-1,fc.id,0,-1);f.pieces.attachPiece(w,floor);
    const av=w.avatarOf(0),bottom=w.collision.groundHeight(x+nx*.63,z+nz*.63),top=w.collision.groundHeight(fc.cx,fc.cz)+5.77;
    av.pos={x:x+nx*.63,y:bottom,z:z+nz*.63};av.vel={x:0,y:0,z:0};av.hp=200;av.koUntil=0;av.action={kind:'idle'};
    a.session.view='action';a.session.tool='flag';a.session.camera.yaw=Math.atan2(-nx,-nz);a.session.camera.pitch=.2;a.session.camera.dist=11;
    const t={facet:fc.id,piece:floor.id,neighbor:edge.facets.find(id=>id!==fc.id),x,z,nx,nz,bottom,top};window.__ladderFixture=t;return t;
  });
  await page.waitForTimeout(1300);
  const geometry=()=>page.evaluate(()=>{
    const a=window.flaghack,t=window.__ladderFixture,p=a.renderer.modules.find(m=>m.pieces?.ladders)?.pieces;
    if(!p)throw Error('Actual instanced platform renderer missing');
    const read=mesh=>{const m=a.renderer.camera.matrixWorld.clone(),out=[];for(let i=0;i<mesh.count;i++){mesh.getMatrixAt(i,m);const e=m.elements;out.push({x:e[12],y:e[13],z:e[14],height:Math.hypot(e[4],e[5],e[6])});}return out;};
    const rails=read(p.ladders.mesh).filter(m=>m.height>2&&Math.hypot(m.x-(t.x+t.nx*.08),m.z-(t.z+t.nz*.08))<.5);
    const fc=a.world.lattice.facets[t.facet];
    const posts=read(p.posts.mesh).filter(m=>Math.hypot(m.x-fc.cx,m.z-fc.cz)<a.world.lattice.edge);
    return{rails,posts,allRails:p.ladders.mesh.count};
  });
  let rendered=await geometry();assert.equal(rendered.rails.length,2,'Both exposed-edge ladder rails are rendered');
  assert.equal(rendered.posts.length,4,'Four corner posts support the isolated platform');
  for(const post of rendered.posts){const ground=await page.evaluate(({x,z})=>window.flaghack.world.collision.groundHeight(x,z),post);assert.ok(Math.abs(post.y-ground)<.001,'Post reaches terrain');assert.ok(post.height>5.0,'Post reaches the raised deck');}
  await page.screenshot({path:join(OUT,`${spec.name}-ladder-exposed-posts.png`)});
  await page.evaluate(()=>{const w=window.flaghack.world,t=window.__ladderFixture,f=window.fh;t.joined=f.factory.spawnPiece(w,'floor',0,-1,t.neighbor,0,-1);f.pieces.attachPiece(w,t.joined);});
  await page.waitForTimeout(900);assert.equal((await geometry()).rails.length,0,'Same-height adjacent floor removes the shared-edge ladder');
  await page.screenshot({path:join(OUT,`${spec.name}-ladder-joined-edge.png`)});
  await page.evaluate(()=>{const w=window.flaghack.world,t=window.__ladderFixture;window.fh.pieces.detachPiece(w,t.joined);});
  await page.waitForTimeout(500);assert.equal((await geometry()).rails.length,2,'Removing neighbor restores the exposed ladder');
  let controller=!!spec.mobile;
  const drive=async direction=>{
    if(controller)await page.evaluate(direction=>{window.__ladderPad.axes[1]=-direction;},direction);
    else if(direction)await page.keyboard.down(direction>0?'KeyW':'KeyS');
    else{await page.keyboard.up('KeyW');await page.keyboard.up('KeyS');}
  };
  const installPad=async()=>{
    // Poll the normal browser Gamepad API; never assign gamepadActive, moveY or avatar input.
    await page.evaluate(()=>{window.__ladderPad={id:'QA emulated standard controller',index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,touched:false,value:0})),timestamp:performance.now()};Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.__ladderPad]});});
    await page.waitForTimeout(250);
  };
  if(spec.mobile)await installPad();
  try{
    if(spec.mobile){
      // Mobile deliberately forces command view even in this Regular fixture;
      // controller axes must not be misrepresented as supported avatar climbing.
      const before=await page.evaluate(()=>({...window.flaghack.world.avatarOf(0).pos}));
      await drive(1);await page.waitForTimeout(600);await drive(0);
      const blocked=await page.evaluate(()=>{const a=window.flaghack,av=a.world.avatarOf(0);return{view:a.session.view,pos:av.pos,input:av.input};});
      assert.equal(blocked.view,'command');assert.deepEqual(blocked.pos,before);
      assert.equal(blocked.input.moveX,0);assert.equal(blocked.input.moveZ,0);
      check('Mobile renders tall posts and exposed-edge ladders with live adjacency; command-only layout does not enable avatar climbing via controller');
      return;
    }
    await drive(1);
    await page.waitForFunction(()=>{const av=window.flaghack.world.avatarOf(0),t=window.__ladderFixture;return av.pos.y>=t.top-.05&&(av.pos.x-t.x)*t.nx+(av.pos.z-t.z)*t.nz<-.12;},null,{timeout:15000,polling:16});
    await drive(0);
    const atop=await page.evaluate(()=>{const av=window.flaghack.world.avatarOf(0);return{y:av.pos.y,jump:av.input.jump};});
    assert.ok(Math.abs(atop.y-fixture.top)<.15,'Normal movement climbs and boards the 5.77m deck');assert.equal(atop.jump,false);
    await page.screenshot({path:join(OUT,`${spec.name}-ladder-climbed-onto-deck.png`)});
    await drive(-1);
    await page.waitForFunction(()=>window.flaghack.world.avatarOf(0).pos.y<=window.__ladderFixture.bottom+.08,null,{timeout:15000,polling:16});
    await drive(0);
    await page.screenshot({path:join(OUT,`${spec.name}-ladder-descended.png`)});
    check('Exposed-edge ladders update on adjacency; ground-reaching posts and real keyboard W/S climb/board/descend without jump');
    controller=true;await installPad();await drive(1);
    await page.waitForFunction(()=>{const av=window.flaghack.world.avatarOf(0),t=window.__ladderFixture;return av.pos.y>=t.top-.05&&(av.pos.x-t.x)*t.nx+(av.pos.z-t.z)*t.nz<-.12;},null,{timeout:15000,polling:16});
    await drive(0);assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).input.jump),false);
    await page.screenshot({path:join(OUT,`${spec.name}-controller-ladder-climbed.png`)});
    await drive(-1);
    await page.waitForFunction(()=>window.flaghack.world.avatarOf(0).pos.y<=window.__ladderFixture.bottom+.08,null,{timeout:15000,polling:16});
    await drive(0);
    check('Desktop Regular emulated standard-controller axes climb and descend via production Gamepad polling without jump');
  }finally{await drive(0);if(controller)await page.evaluate(()=>{delete navigator.getGamepads;delete window.__ladderPad;});}
}

async function rampScenario(spec,check){
  for(const thick of [true,false]){
    const target=await page.evaluate(({thick,specMobile})=>{
      const a=window.flaghack,w=a.world,f=window.fh,lat=w.lattice;
      let chosen;
      for(const fc of lat.facets){
        if(fc.thick!==thick||fc.boundary||Math.abs(fc.cx)>60||Math.abs(fc.cz)>60)continue;
        if([...w.pieces.values()].some(p=>{const c=lat.facets[p.facet];return c&&Math.hypot(c.cx-fc.cx,c.cz-fc.cz)<20;})||[...w.buildings.values()].some(b=>Math.hypot(b.pos.x-fc.cx,b.pos.z-fc.cz)<20))continue;
        for(let side=0;side<4&&!chosen;side++){
          const n=fc.nodes.map(id=>lat.nodes[id]),p=n[side],q=n[(side+1)%4],d=n[(side+3)%4];
          const length=Math.hypot(q.x-p.x,q.z-p.z),ux=(q.x-p.x)/length,uz=(q.z-p.z)/length;
          const shift=(d.x-p.x)*ux+(d.z-p.z)*uz,vx=d.x-p.x-shift*ux,vz=d.z-p.z-shift*uz;
          const lo=Math.max(0,shift),hi=Math.min(length,length+shift);
          const xs=[p.x+lo*ux,p.x+hi*ux,p.x+hi*ux+vx,p.x+lo*ux+vx],zs=[p.z+lo*uz,p.z+hi*uz,p.z+hi*uz+vz,p.z+lo*uz+vz];
          const low={x:(xs[0]+xs[1])/2,z:(zs[0]+zs[1])/2},high={x:(xs[2]+xs[3])/2,z:(zs[2]+zs[3])/2};
          const run=Math.hypot(high.x-low.x,high.z-low.z),dx=(high.x-low.x)/run,dz=(high.z-low.z)/run;
          const neighbor=lat.facets[fc.neighbors[(side+2)%4]];if(!neighbor)continue;
          const base=w.collision.groundHeight(fc.cx,fc.cz),top=w.collision.groundHeight(neighbor.cx,neighbor.cz)+5.77;
          if(Math.abs(top-base-5.77)>.12||Math.abs(w.collision.groundHeight(low.x-dx,low.z-dz)-base)>.12)continue;
          if(![...n,low,high].every(v=>w.nav.isWalkable(v.x,v.z)))continue;
          const inside=(x,z)=>xs.every((v,i)=>{const j=(i+1)%4;return(xs[j]-v)*(z-zs[i])-(zs[j]-zs[i])*(x-v)>=-1e-7;});
          const gaps=n.map(v=>({x:v.x*.85+fc.cx*.15,z:v.z*.85+fc.cz*.15})).filter(v=>!inside(v.x,v.z));
          if(!gaps.length||gaps.some(v=>w.collision.raycast(v.x,base+8.4,v.z,0,-1,0,8)))continue;
          chosen={facet:fc.id,neighbor:neighbor.id,side,xs,zs,low,high,dx,dz,run,base,top,gaps,thick};
        }
        if(chosen)break;
      }
      if(!chosen)throw Error(`No clear near-level ${thick?'thick':'thin'} ramp fixture`);
      const t=chosen,r=f.factory.spawnPiece(w,'ramp',0,-1,t.facet,0,t.side),floor=f.factory.spawnPiece(w,'floor',0,-1,t.neighbor,0,-1);f.pieces.attachPiece(w,r);f.pieces.attachPiece(w,floor);t.ramp=r.id;
      const av=w.avatarOf(0);av.pos={x:t.low.x-t.dx,y:w.collision.groundHeight(t.low.x-t.dx,t.low.z-t.dz),z:t.low.z-t.dz};av.vel={x:0,y:0,z:0};av.hp=200;av.koUntil=0;av.action={kind:'idle'};
      a.session.view=specMobile?'command':'action';a.session.tool='flag';a.session.camera.yaw=Math.atan2(t.dx,t.dz);a.session.camera.pitch=.45;a.session.camera.dist=14;
      a.session.camera.cmdX=(t.low.x+t.high.x)/2;a.session.camera.cmdZ=(t.low.z+t.high.z)/2;a.session.camera.cmdHeight=25;
      window.__rampFixture=t;return t;
    },{thick,specMobile:!!spec.mobile});
    const label=thick?'thick':'thin';await page.waitForTimeout(1200);
    const rays=await page.evaluate(()=>{const w=window.flaghack.world,t=window.__rampFixture,fc=w.lattice.facets[t.facet];return{center:w.collision.raycast(fc.cx,t.base+8.4,fc.cz,0,-1,0,8)?.tag??null,gaps:t.gaps.map(v=>w.collision.raycast(v.x,t.base+8.4,v.z,0,-1,0,8)?.tag??null)};});
    assert.equal(rays.center,target.ramp,'Ramp center has real sloped collision');assert.ok(rays.gaps.every(tag=>tag===null),'Removed triangular corners have no invisible ramp collision');
    for(let i=0;i<4;i++){const j=(i+1)%4,k=(i+2)%4;assert.ok(Math.abs((target.xs[j]-target.xs[i])*(target.xs[k]-target.xs[j])+(target.zs[j]-target.zs[i])*(target.zs[k]-target.zs[j]))<1e-6,'Ramp strip corners are rectangular');}
    await page.screenshot({path:join(OUT,`${spec.name}-${label}-rectangular-ramp.png`)});
    if(!spec.mobile){
      try{
        await page.keyboard.down('KeyW');
        await page.waitForFunction(()=>{const a=window.flaghack.world.avatarOf(0),t=window.__rampFixture;return(a.pos.x-t.low.x)*t.dx+(a.pos.z-t.low.z)*t.dz>t.run+.2&&a.pos.y>=t.top-.15;},null,{timeout:15000,polling:16});
        await page.keyboard.up('KeyW');
        assert.equal(await page.evaluate(()=>window.flaghack.world.avatarOf(0).input.jump),false);
        await page.screenshot({path:join(OUT,`${spec.name}-${label}-ramp-walked-onto-deck.png`)});
      }finally{await page.keyboard.up('KeyW');}
    }
    check(`${label} rectangular ramp has empty noncolliding side corners${spec.mobile?' and renders in mobile command view':'; real W walks onto its high deck without jump'}`);
  }
}

async function completedWardClearance(spec,check){
  if(spec.mobile)return; // Desktop real placement supplies the completion/bounce proof.
  // Entering command view recenters on the avatar; finish that transition before aiming the fixture.
  await page.evaluate(()=>{window.flaghack.session.view='command';window.flaghack.session.tool='flag';});
  await page.waitForTimeout(1100);
  await page.evaluate(()=>{
    const a=window.flaghack,w=a.world,f=window.fh;
    const fc=w.lattice.facets.find(fc=>f.buildings.canPlaceBuilding(w,0,'ward',fc.id).ok&&![...w.pieces.values()].some(p=>{const at=w.lattice.facets[p.facet];return at&&Math.hypot(at.cx-fc.cx,at.cz-fc.cz)<15;})&&![...w.buildings.values()].some(b=>Math.hypot(b.pos.x-fc.cx,b.pos.z-fc.cz)<15));
    if(!fc)throw Error('No ground Ward clearance fixture');
    w.factions[0].lumber=1000;a.session.view='command';a.session.tool='building';a.session.buildingKind='ward';
    a.session.camera.cmdX=fc.cx;a.session.camera.cmdZ=fc.cz;a.session.camera.cmdHeight=28;
    window.__underDeck={facet:fc.id,x:fc.cx,z:fc.cz,y:w.collision.groundHeight(fc.cx,fc.cz)};
  });
  await page.waitForTimeout(1200);
  const point=await page.evaluate(()=>{const a=window.flaghack,t=window.__underDeck,c=a.renderer.camera,p=c.position.clone().set(t.x,t.y,t.z).project(c),r=a.renderer.renderer.domElement.getBoundingClientRect();return{x:r.x+(p.x+1)*r.width/2,y:r.y+(1-p.y)*r.height/2};});
  await page.mouse.move(point.x,point.y);
  await page.waitForFunction(()=>{const s=window.flaghack.session,t=window.__underDeck;return s.ghost?.valid&&s.ghost.facet===t.facet&&s.ghost.level===0;},null,{timeout:15000});
  await page.mouse.click(point.x,point.y,{delay:80});
  await page.waitForFunction(()=>{const w=window.flaghack.world,t=window.__underDeck;return[...w.buildings.values()].some(b=>b.kind==='ward'&&b.facet===t.facet&&b.level===0);},null,{timeout:15000});
  // Stage only the roof. The Ward completes naturally; temporary construction
  // scaffold clearance is deliberately excluded by the user's finished-model choice.
  await page.evaluate(()=>{const a=window.flaghack,w=a.world,t=window.__underDeck,f=window.fh;const p=f.factory.spawnPiece(w,'floor',0,-1,t.facet,0,-1);f.pieces.attachPiece(w,p);a.session.tool='flag';});
  const fit=await page.evaluate(()=>new Promise((resolve,reject)=>{
    const start=performance.now(),tops=[];let completedAt=null,maxScale=0;
    function tick(){
      const a=window.flaghack,w=a.world,t=window.__underDeck,b=[...w.buildings.values()].find(b=>b.kind==='ward'&&b.facet===t.facet&&b.level===0);
      const view=b&&a.renderer.modules.find(m=>m.views?.has(b.id))?.views.get(b.id);
      if(b?.built>=1&&view){
        completedAt??=performance.now();view.root.updateMatrixWorld(true);let top=-Infinity;
        view.body.traverseVisible(mesh=>{if(!mesh.geometry)return;mesh.geometry.computeBoundingBox();const box=mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);top=Math.max(top,box.max.y);});
        tops.push(top);maxScale=Math.max(maxScale,view.body.scale.y);
        if(performance.now()-completedAt>1100){resolve({maximum:Math.max(...tops),samples:tops.length,maxScale,underside:view.root.position.y+5.77-.25});return;}
      }
      if(performance.now()-start>20000){reject(Error('Ward did not complete naturally within clearance sample'));return;}
      requestAnimationFrame(tick);
    }requestAnimationFrame(tick);
  }));
  assert.ok(fit.samples>5&&Number.isFinite(fit.maximum));assert.ok(fit.maxScale>1,'Actual completion overshoot was observed');
  assert.ok(fit.maximum<fit.underside,'Completed Ward including completion bounce fits below 5.77m platform slab');
  await page.evaluate(()=>{const a=window.flaghack,t=window.__underDeck,av=a.world.avatarOf(0);av.pos={x:t.x,y:t.y,z:t.z-9};av.vel={x:0,y:0,z:0};a.session.view='action';a.session.camera.yaw=0;a.session.camera.pitch=.15;a.session.camera.dist=10;});
  await page.waitForTimeout(900);await page.screenshot({path:join(OUT,'desktop-completed-ward-under-braced-deck.png')});
  check(`Completed Ward fits under braced5.77m deck, including actual completion bounce (${fit.samples} samples); scaffold intentionally excluded`);
}

async function scenario(spec,url){
  const context=await browser.newContext({viewport:{width:spec.width,height:spec.height},hasTouch:!!spec.mobile,isMobile:!!spec.mobile,...(spec.mobile?{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'}:{}),deviceScaleFactor:1,recordVideo:{dir:join(OUT,'video'),size:{width:spec.width,height:spec.height}}});
  const entry={name:spec.name,checks:[],errors:[]};results.scenarios.push(entry);
  const check=text=>{entry.checks.push(text);console.log(`PASS ${spec.name}: ${text}`);};
  try{
    page=await context.newPage();page.on('pageerror',e=>entry.errors.push(e.message));
    await page.goto(url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
    if(await page.locator('#startup').count())await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
    await page.locator('#startup').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.deviceLayout),spec.mobile?'mobile':'desktop','QA must exercise actual selected device layout, not only a narrow viewport');
    await page.evaluate(()=>window.flaghack.startMatch({seed:'beacon-card-preview',humans:[0,1,2],rtsFactions:[],match:{...window.flaghack.session.settings.match,active:[0,1,2],bossMode:false,days:3}}));
    await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world?.frickFrack?.wizardId>=0);
    await page.waitForTimeout(1500);const fixture=await stage();
    await page.waitForFunction(()=>{const a=window.flaghack;return window.__dropFixture.cards.every(c=>a.renderer.ctx.scene.getObjectByName(`frick-frack-card-${c.id}`)?.material.map.version>=(c.arcana!==undefined||c.parody!==undefined?3:2));});
    await page.waitForTimeout(1500);let state=await renderState();entry.before=state;
    assert.equal(state.cards.length,3);assert.ok(state.cards.every(Boolean));
    for(const c of state.cards){assert.ok(Math.abs(c.y-c.ground-.035)<.001);assert.equal(c.tilt,-Math.PI/2);assert.equal(c.imageWidth,256);}
    assert.equal(state.cards[0].name,'Queen of Diamonds');assert.equal(state.cards[1].name,'The Sun');assert.ok(!state.cards[2].name.includes('?'));
    assert.ok(state.pulses.length>=4,'All three cards and beacon have shared ground pulse');
    for(const card of state.cards){const pulse=state.pulses.find(p=>Math.hypot(p.x-card.x,p.z-card.z)<.01);assert.ok(pulse);assert.ok(Math.abs(pulse.radius-1.1)<.001);assert.ok(Math.abs(pulse.intensity-.7)<.001);const glow=state.glows.find(g=>Math.hypot(g.x-card.x,g.z-card.z)<.01);assert.ok(glow);assert.ok(Math.abs(glow.size-.2)<.001);}
    assert.match(state.prompt,/Queen of Diamonds.*Walk over to collect/);check('Three actual engine card faces are grounded, use shared beacon pulses and have named pickup prompt');
    const tag=page.locator(spec.mobile?'.mc-pickup':'.prompt');await tag.waitFor({state:'visible'});
    assert.match(await tag.innerText(),/Queen of Diamonds/);
    const bounds=await tag.evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:e.scrollWidth,width:e.clientWidth,pointerEvents:getComputedStyle(e).pointerEvents};});
    assert.ok(bounds.x>=0&&bounds.right<=spec.width&&bounds.y>=0&&bounds.bottom<=spec.height);assert.ok(bounds.scroll<=bounds.width+1);
    if(spec.mobile){assert.equal(bounds.pointerEvents,'none');const modes=await page.locator('.mc-modes').boundingBox();assert.ok(bounds.bottom<modes.y);}
    await page.screenshot({path:join(OUT,`${spec.name}-grounded-pickups.png`)});
    if(!spec.mobile){
      await page.keyboard.down('KeyW');
      try{await page.waitForFunction(()=>window.flaghack.world.frickFrack.sideboards[0].some(c=>c.id===window.__dropFixture.cards[0].id),null,{timeout:8000});}finally{await page.keyboard.up('KeyW');}
      await page.waitForTimeout(350);state=await renderState();
      assert.equal(state.sideboard.filter(c=>c.id===fixture.cards[0].id).length,1);assert.equal(state.cards[0],null);
      check('Real W movement auto-collects the card exactly once and removes its mesh');
      await page.screenshot({path:join(OUT,`${spec.name}-card-collected.png`)});
      await page.waitForFunction(()=>window.flaghack.session.prompt?.includes('D.E.G.E.N.'));
      await page.keyboard.press('KeyE');await page.waitForFunction(()=>!window.flaghack.world.beacons.has(window.__dropFixture.beacon));
      await page.waitForTimeout(400);state=await renderState();const converted=state.hippies.filter(h=>h.was===1&&h.now===0);
      assert.ok(converted.length===1||converted.length===2);assert.ok(state.hippies.filter(h=>h.was!==1).every(h=>h.was===h.now));assert.deepEqual(state.meshTap,fixture.meshTap);
      await page.keyboard.press('KeyE');await page.waitForTimeout(300);assert.deepEqual((await renderState()).hippies,state.hippies);
      check(`Real E pickup converts ${converted.length} source-camp hippie(s), leaves other camps alone, gives no mesh tap, and cannot repeat`);
      await page.screenshot({path:join(OUT,`${spec.name}-beacon-collected.png`)});
    }else check('Mobile-emulated Regular-mode pickup plaque is visible, wraps within viewport and does not intercept touch or overlap field controls');
    await completedWardClearance(spec,check);
    await platformScenario(spec,context,check);
    await ladderScenario(spec,context,check);
    await rampScenario(spec,check);
    entry.after=await renderState();
    if(spec.mobile){
      await page.evaluate(()=>window.flaghack.startMatch({seed:'beacon-card-degen',humans:[0],rtsFactions:[0],match:{...window.flaghack.session.settings.match,active:[0],bossMode:false,days:3}}));
      await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.world.factions[0].controlMode==='rts');
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(()=>!!window.flaghack.world.avatarOf(0)),false);
      assert.equal(await page.locator('.mc-pickup').isVisible(),false);
      check('Actual Degen match has no avatar and shows no false pickup action plaque');
    }
    assert.deepEqual(entry.errors,[]);entry.completed=true;await page.waitForTimeout(1000);
  }catch(e){entry.error=e.stack||String(e);entry.failureState=await renderState().catch(()=>null);entry.clearanceFailure=await page?.evaluate(()=>({target:window.__underDeck,ghost:window.flaghack?.session.ghost,camera:window.flaghack?.session.camera})).catch(()=>null);entry.rampFailure=await page?.evaluate(()=>({fixture:window.__rampFixture,position:window.flaghack?.world?.avatarOf(0)?.pos})).catch(()=>null);entry.ladderFailure=await page?.evaluate(()=>{const a=window.flaghack,av=a?.world?.avatarOf(0);return{fixture:window.__ladderFixture,position:av?.pos,input:av?.input,view:a?.session.view};}).catch(()=>null);await page?.screenshot({path:join(OUT,`${spec.name}-failure.png`)}).catch(()=>{});throw e;}
  finally{if(page&&!page.isClosed())entry.videoPath=await page.video()?.path();await context.close();}
}
async function main(){
  mkdirSync(OUT,{recursive:true});await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}${PROJECT}`;
  try{
    browser=await chromium.launch(process.platform==='darwin'?{channel:'chrome',headless:false,chromiumSandbox:true,args:[]}:{executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true,chromiumSandbox:true,args:[]});
    for(const spec of [{name:'desktop',width:1280,height:800},{name:'phone-portrait',width:390,height:844,mobile:true}])await scenario(spec,url);
    results.completed=true;
  }catch(e){results.error=e.stack||String(e);throw e;}
  finally{writeFileSync(join(OUT,'result.json'),JSON.stringify(results,null,2));await browser?.close();server.close();}
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
