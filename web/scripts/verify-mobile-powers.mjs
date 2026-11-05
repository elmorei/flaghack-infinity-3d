/** Native browser-emulated mobile QA. Only resources/targets are staged offline;
 * every alignment, dose and power cast goes through the real touch UI and simulation. */
import assert from 'node:assert/strict';

export async function verifyMobilePowers(page, {capture = async () => {}} = {}) {
  const checks=[];
  const tap=async locator=>{await locator.scrollIntoViewIfNeeded();await locator.tap({noWaitAfter:true});};
  const open=async()=>{
    if(await page.evaluate(()=>window.flaghack.session.mobileMenu===null))await tap(page.locator('.mc-top').getByRole('button',{name:'Menu',exact:true}));
    await tap(page.locator('.mc-tabs').getByRole('button',{name:'Powers',exact:true}));
  };
  const power=id=>page.locator(`[data-power="${id}"]`);
  const point=async target=>page.evaluate(target=>{
    const a=window.flaghack,c=a.renderer.camera;c.updateMatrixWorld();
    const mul=(m,v)=>[0,1,2,3].map(r=>m[r]*v[0]+m[4+r]*v[1]+m[8+r]*v[2]+m[12+r]*v[3]);
    const p=mul(c.projectionMatrix.elements,mul(c.matrixWorldInverse.elements,[target.x,a.world.collision.groundHeight(target.x,target.z),target.z,1]));
    return{x:(p[0]/p[3]+1)*innerWidth/2,y:(1-p[1]/p[3])*innerHeight/2};
  },target);
  await page.evaluate(()=>{
    const a=window.flaghack;if(a.net)throw Error('Powers QA requires an offline match');
    a.startMatch({seed:'mobile-powers-native-qa',humans:[0,1,2,3],rtsFactions:[0],match:{...a.session.settings.match,active:[0,1,2,3],bossMode:false,days:3,startingSignifiers:0,maxSignifiers:0}});
  });
  await page.waitForFunction(()=>{const a=window.flaghack;return a.session.screen==='playing'&&a.ui.world===a.world&&a.world.factions[0].controlMode==='rts';});
  await page.evaluate(()=>{const a=window.flaghack,f=a.world.factions[0];a.session.selection.clear();f.ritual=300;f.chakras.canton=0;f.chakras.finial=0;for(const id of ['saffron','dust','acidcop'])f.drugs[id]=0;});
  await open();
  await page.waitForFunction(()=>['omega','stabilize','redtape','patchwork'].every(id=>document.querySelector(`[data-power="${id}"]`)?.disabled));
  assert.equal(await page.locator('[data-use-drug="saffron"]').isDisabled(),true);
  checks.push('Missing alignment, Drum Circle and doses disable the correct buttons');await capture('powers-blocked');
  const fixture=await page.evaluate(()=>{
    const a=window.flaghack,w=a.world,f=w.factions[0],altar=w.hearthOf(0),drum=window.fh.factory.spawnBuilding(w,'drumcircle',0,altar.facet,1);f.lumber=1000;
    const build=w.lattice.facets.find(fc=>window.fh.buildings.canPlaceBuilding(w,0,'workshop',fc.id).ok);if(!build)throw Error('Seed needs a real buildable workshop facet');
    const damaged=window.fh.factory.spawnBuilding(w,'workshop',0,build.id,1);damaged.hp=damaged.maxHp*.5;
    const clear=w.lattice.facets.find(fc=>Math.hypot(fc.cx-damaged.pos.x,fc.cz-damaged.pos.z)<12&&window.fh.buildings.canPlaceBuilding(w,0,'workshop',fc.id).ok);if(!clear)throw Error('Seed needs clear ground within Patchwork range');
    const target={x:clear.cx,z:clear.cz};
    for(const id of ['saffron','dust','acidcop'])f.drugs[id]=1;
    a.session.camera.cmdX=target.x;a.session.camera.cmdZ=target.z;
    return{drum:drum.id,damaged:damaged.id,target};
  });
  for(const chakra of ['canton','finial']) {
    const b=page.locator(`[data-align="${chakra}"]`);await page.waitForFunction(id=>!document.querySelector(`[data-align="${id}"]`)?.disabled,chakra);
    await tap(b);await page.waitForFunction(()=>[...window.flaghack.world.zones.values()].some(z=>z.kind==='alignment'&&z.faction===0));
    assert.equal(await page.evaluate(id=>window.flaghack.world.factions[0].chakras[id],chakra),0,'Alignment is a timed channel');
    await page.waitForFunction(id=>window.flaghack.world.factions[0].chakras[id]===1,chakra,{timeout:15000});
  }
  checks.push('Canton and Finial align via real four-second channels without an avatar');await capture('powers-unlocked');
  for(const drug of ['saffron','dust','acidcop']) {
    await tap(page.locator(`[data-use-drug="${drug}"]`));
    await page.waitForFunction(id=>{const w=window.flaghack.world,f=w.factions[0];return f.drugs[id]===0&&f.drugActive[id]>w.time;},drug);
    assert.equal(await page.evaluate(()=>window.flaghack.session.selection.size),0);
  }
  checks.push('All three existing drugs consume one real dose and become active in Degen');
  // Cancel, reopen and mode changes must not spend or leave a latent next-tap cast.
  for(const cancel of ['button','menu','mode','home']) {
    await open();const before=await page.evaluate(()=>window.flaghack.world.factions[0].cooldowns.redtape);
    await tap(power('redtape'));await page.waitForFunction(()=>window.flaghack.session.mobileRitual==='redtape');
    if(cancel==='button')await tap(page.locator('.mc-placement').getByRole('button',{name:'Cancel',exact:true}));
    else if(cancel==='menu')await tap(page.locator('.mc-top').getByRole('button',{name:'Menu',exact:true}));
    else if(cancel==='mode')await tap(page.locator('.mc-modes').getByRole('button',{name:'Plan',exact:true}));
    else await tap(page.locator('.mc-home'));
    await page.waitForFunction(()=>window.flaghack.session.mobileRitual===null&&window.flaghack.session.mobileAbility===null);
    assert.equal(await page.evaluate(()=>window.flaghack.world.factions[0].cooldowns.redtape),before);
  }
  checks.push('Cancel, opening Menu, switching Plan and Home clear pending power without spending');
  const cdp=await page.context().newCDPSession(page);
  try {
    for(const cancelled of [false,true]) {
      await open();await tap(power('redtape'));await page.waitForFunction(()=>window.flaghack.session.mobileRitual==='redtape');
      const size=page.viewportSize(),x=size.width*.5,y=size.height*.55;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
      if(!cancelled)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+40,y:y+30,id:1}]});
      await cdp.send('Input.dispatchTouchEvent',{type:cancelled?'touchCancel':'touchEnd',touchPoints:[]});await page.waitForTimeout(200);
      assert.equal(await page.evaluate(()=>[...window.flaghack.world.zones.values()].filter(z=>z.kind==='redtape').length),0);
      assert.equal(await page.evaluate(()=>window.flaghack.session.mobileRitual),'redtape');
      await tap(page.locator('.mc-placement').getByRole('button',{name:'Cancel',exact:true}));
    }
  } finally {await cdp.detach();}
  checks.push('Native touch drag and touchCancel produce no accidental cast');
  const cast=async(id,kind,target)=>{
    await open();await tap(power(id));await page.waitForFunction(id=>{const s=window.flaghack.session;return(s.mobileAbility||s.mobileRitual)===id&&s.mobileMenu===null;},id);
    await page.evaluate(target=>{const s=window.flaghack.session;s.camera.cmdX=target.x;s.camera.cmdZ=target.z;},target);
    // Camera glide advances on rendered frames, not wall time. A fixed 700ms
    // delay can leave the target under the landscape placement panel. Wait for
    // the actual projection to settle at field center and verify the DOM hit.
    try {
      await page.waitForFunction(target=>{
        const a=window.flaghack,c=a.renderer.camera;c.updateMatrixWorld();
        const mul=(m,v)=>[0,1,2,3].map(r=>m[r]*v[0]+m[4+r]*v[1]+m[8+r]*v[2]+m[12+r]*v[3]);
        const v=mul(c.projectionMatrix.elements,mul(c.matrixWorldInverse.elements,[target.x,a.world.collision.groundHeight(target.x,target.z),target.z,1]));
        const x=(v[0]/v[3]+1)*innerWidth/2,y=(1-v[1]/v[3])*innerHeight/2;
        return Math.abs(x-innerWidth/2)<3&&Math.abs(y-innerHeight/2)<3&&document.elementFromPoint(x,y)===document.querySelector('canvas#game');
      },target);
    } catch(error) {
      const p=await point(target),hit=await page.evaluate(p=>({hit:document.elementFromPoint(p.x,p.y)?.outerHTML,viewport:{width:innerWidth,height:innerHeight},camera:window.flaghack.session.camera}),p);
      throw new Error('Power target did not settle on unobstructed canvas: '+JSON.stringify({id,target,p,...hit}),{cause:error});
    }
    const p=await point(target);
    assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)===document.querySelector('canvas#game'),p),true,'Power tap must hit the canvas, not a HUD panel');
    await page.touchscreen.tap(p.x,p.y);
    await page.waitForFunction(kind=>[...window.flaghack.world.zones.values()].some(z=>z.kind===kind&&z.faction===0),kind);
    const result=await page.evaluate(kind=>{const a=window.flaghack,z=[...a.world.zones.values()].find(z=>z.kind===kind&&z.faction===0);return{id:z.id,x:z.pos.x,z:z.pos.z,bornAt:z.bornAt,selection:a.session.selection.size,pending:!!(a.session.mobileAbility||a.session.mobileRitual)};},kind);
    assert.ok(Math.hypot(result.x-target.x,result.z-target.z)<1.5,id+' uses the tapped ground position');
    assert.equal(result.selection,0);assert.equal(result.pending,false);
    await page.touchscreen.tap(p.x,p.y);await page.waitForTimeout(150);
    assert.equal(await page.evaluate(kind=>[...window.flaghack.world.zones.values()].filter(z=>z.kind===kind&&z.faction===0).length,kind),1,'Repeated tap does not repeat a cast');
    return result;
  };
  const stabilize=await cast('stabilize','stabilize',fixture.target);await capture('powers-stabilize');
  const redtape=await cast('redtape','redtape',fixture.target);await capture('powers-redtape');
  const hp=await page.evaluate(id=>window.flaghack.world.buildings.get(id).hp,fixture.damaged);
  const patchwork=await cast('patchwork','patchwork',fixture.target);
  await page.waitForFunction(({id,hp})=>window.flaghack.world.buildings.get(id).hp>hp,{id:fixture.damaged,hp},{timeout:10000});
  await capture('powers-patchwork');
  const omega=await cast('omega','omegaCharge',fixture.target);
  await page.waitForFunction(()=>![...window.flaghack.world.zones.values()].some(z=>z.kind==='omegaCharge'&&z.faction===0),null,{timeout:8000});
  assert.ok(await page.evaluate(()=>{const w=window.flaghack.world;return w.factions[0].cooldowns.omega>w.time;}));
  checks.push('Stabilize, Red Tape, Patchwork and warned Omega cast by direct taps without selecting a Signifier; second taps do not repeat');
  await open();assert.equal(await power('omega').isDisabled(),true);assert.equal(await power('patchwork').isDisabled(),true);
  await tap(page.locator('.mc-menu-head').getByRole('button',{name:'Back to field',exact:true}));
  const gpu=await verifyPowerZonePixels(page);
  assert.ok(gpu.allPassed,JSON.stringify(gpu.checks));
  return{checks,fixture,casts:{stabilize,redtape,patchwork,omega},gpu,physicalPhoneTest:false};
}

export async function verifyPowerZonePixels(page) {
  return page.evaluate(()=>{
    const a=window.flaghack,g=a.renderer,ctx=g.ctx,w=a.world,s=a.session,r=g.renderer,c=ctx.camera;
    if(a.net)throw Error('Power shader fixture is offline only');
    const fx=g.modules.find(m=>m.ritualZones)?.ritualZones;if(!fx)throw Error('Production RitualZoneFx required');
    const zones=[...w.zones],vis=[];ctx.scene.traverse(o=>vis.push([o,o.visible]));
    const saved={camera:{position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom},background:ctx.scene.background,alpha:r.getClearAlpha(),ability:s.mobileAbility,ritual:s.mobileRitual,menu:s.mobileMenu,point:s.hover.point};
    const target=g.warmTarget.clone();target.setSize(innerWidth,innerHeight);const checks=[],captures={};
    const draw=()=>{const old=r.getRenderTarget();try{r.setRenderTarget(target);r.clear();r.render(ctx.scene,c);const pixels=new Uint8Array(innerWidth*innerHeight*4);r.readRenderTargetPixels(target,0,0,innerWidth,innerHeight,pixels);return pixels;}finally{r.setRenderTarget(old);}};
    const png=data=>{const canvas=document.createElement('canvas');canvas.width=innerWidth;canvas.height=innerHeight;const flipped=new Uint8ClampedArray(data.length),row=innerWidth*4;for(let y=0;y<innerHeight;y++)flipped.set(data.subarray(y*row,(y+1)*row),(innerHeight-y-1)*row);canvas.getContext('2d').putImageData(new ImageData(flipped,innerWidth,innerHeight),0,0);return canvas.toDataURL('image/png').split(',')[1];};
    const only=mesh=>{for(const[o]of vis)o.visible=false;ctx.scene.visible=true;for(const child of fx.group.children)child.visible=child===mesh;for(let p=mesh;p;p=p.parent)p.visible=true;};
    try {
      w.zones.clear();ctx.scene.background=null;r.setClearAlpha(0);s.mobileMenu=null;s.mobileAbility=null;s.mobileRitual=null;
      const at={x:s.camera.cmdX,z:s.camera.cmdZ},y=w.collision.groundHeight(at.x,at.z);c.position.set(at.x,y+34.64,at.z+20);c.lookAt(at.x,y,at.z);c.top=Math.max(20,20*innerHeight/innerWidth);c.bottom=-c.top;c.right=c.top*innerWidth/innerHeight;c.left=-c.right;c.updateProjectionMatrix();c.updateMatrixWorld();
      for(const[i,kind]of ['redtape','patchwork','omegaCharge','alignment'].entries()) {
        const id=-9000-i;w.zones.set(id,{id,type:'zone',kind,faction:s.playerFaction,pos:{...at},radius:kind==='alignment'?5:14,bornAt:w.time-.5,until:w.time+10,level:1,target:-1});
        fx.update(w,s,ctx.time);const mesh=ctx.scene.getObjectByName(`power-zone-${kind}-${id}`);if(!mesh)throw Error('Missing production mesh '+kind);only(mesh);
        mesh.visible=false;const empty=draw();mesh.visible=true;const pixels=draw();let changed=0;for(let j=0;j<pixels.length;j+=4)if(Math.abs(pixels[j]-empty[j])+Math.abs(pixels[j+1]-empty[j+1])+Math.abs(pixels[j+2]-empty[j+2])>6)changed++;
        checks.push({kind,pixels:changed,ok:changed>20&&!mesh.material.transparent&&mesh.material.depthTest&&!mesh.material.depthWrite});captures[kind]=png(pixels);
        w.zones.delete(id);
      }
      s.mobileRitual='redtape';s.hover.point={x:at.x,y,z:at.z};fx.update(w,s,ctx.time);const preview=ctx.scene.getObjectByName('mobile-power-radius-preview');only(preview);preview.visible=false;const blank=draw();preview.visible=true;const pixels=draw();let count=0;for(let i=0;i<pixels.length;i+=4)if(Math.abs(pixels[i]-blank[i])+Math.abs(pixels[i+1]-blank[i+1])+Math.abs(pixels[i+2]-blank[i+2])>6)count++;
      checks.push({kind:'radius-preview',pixels:count,radius:preview.material.uniforms.uRadius.value,ok:preview.visible&&count>20&&preview.material.uniforms.uRadius.value===14});captures.preview=png(pixels);
      const error=r.getContext().getError();checks.push({kind:'WebGL error',error,ok:error===0});
      return{checks,allPassed:checks.every(x=>x.ok),captures,description:'Isolated native GPU renders of actual production shader materials; negative-ID offline zones only.'};
    }finally{
      w.zones.clear();for(const[id,z]of zones)w.zones.set(id,z);s.mobileAbility=saved.ability;s.mobileRitual=saved.ritual;s.mobileMenu=saved.menu;s.hover.point=saved.point;
      fx.update(w,s,ctx.time);for(const[o,v]of vis)o.visible=v;ctx.scene.background=saved.background;r.setClearAlpha(saved.alpha);c.position.copy(saved.camera.position);c.quaternion.copy(saved.camera.quaternion);Object.assign(c,{left:saved.camera.left,right:saved.camera.right,top:saved.camera.top,bottom:saved.camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();target.dispose();g.render(0);
    }
  });
}
