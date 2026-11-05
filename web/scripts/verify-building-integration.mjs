/** Offline production-renderer fixture. No source imports or gameplay input changes. */
import assert from 'node:assert/strict';

export async function verifyBuildingIntegration(page) {
  const result = await page.evaluate(() => {
    const a = window.flaghack, w = a.world, g = a.renderer, s = g.ctx.shared.mobileSprites;
    if (a.net) throw new Error('Building render fixture is offline only.');
    if (!s?.worldAtlasReady) throw new Error('Building atlas must be ready before this fixture.');
    const renderer = g.modules.find(module => module.views instanceof Map && module.ghosts && module.pieces);
    if (!renderer) throw new Error('Structures renderer not found.');
    const saved = {nextId:w.nextEntityId,boss:w.boss,ghost:a.session.ghost,economy:w.scratch.economy,
      faction:w.factions.map(f => ({hearthIds:[...f.hearthIds],gccId:f.gccId,controlMode:f.controlMode,alive:f.alive})),
      stockTick:w.scratch.economy?.stockTick,hoarding:w.scratch.economy?.hoarding?.slice()};
    const created = [], flags = [], calls = [], flagCalls = [], samples = [], checks = [];
    const original = {building:s.building,flag:s.flag,sample:s.sample};
    s.building = function(kind, pose, style) { calls.push({kind,pose:{...pose},style:{...style,ownerColor:style.ownerColor?.getHex()}}); return original.building.call(this,kind,pose,style); };
    s.flag = function(pose, state, style) {flagCalls.push({pose:{...pose},state});return original.flag.call(this,pose,state,style);};
    s.sample = function(sample) {samples.push({...sample});return original.sample.call(this,sample);};
    const check = (ok, label, detail) => checks.push({ok:!!ok,label,...(detail === undefined ? {} : {detail})});
    const step = (dt = .14) => {calls.length=flagCalls.length=samples.length=0;s.begin();renderer.update(dt);s.end();};
    const call = b => calls.find(c => c.pose.id === -6000000-b.id);
    const stock = b => flagCalls.filter(c => c.pose.id <= -2000000000-b.id*64 && c.pose.id > -2000000000-b.id*64-64);
    try {
      const byKind = {};
      for (const kind of ['hearth','workshop','drumcircle','ward','druglab','gcc']) {
        const b = window.fh.factory.spawnBuilding(w,kind,0,0,1);created.push(b.id);byKind[kind]=b;
      }
      const hearth=byKind.hearth, workshop=byKind.workshop, gcc=byKind.gcc;
      w.factions[0].hearthIds=[hearth.id];w.factions[0].controlMode='avatar';w.factions[0].alive=true;
      step();
      for (const b of Object.values(byKind)) {
        const view=renderer.views.get(b.id), sample=samples.find(x=>x.id===-6000000-b.id);
        check(!!call(b) && !sample?.placeholder && sample?.clip==='idle',`${b.kind}: real idle sprite selected`,sample);
        check(view.body.visible===false && view.effects.visible===true && view.root.visible===true,`${b.kind}: hidden models and retained effects`);
        check(view.root.name===`building-${b.kind}-${b.id}`,`${b.kind}: root identity`);
      }
      workshop.built=.35;step();
      check(call(workshop).style.buildProgress===.35 && renderer.views.get(workshop.id).scaffold.group.visible===false,'construction reveal replaces scaffold');
      workshop.built=1;workshop.hp=workshop.maxHp*.2;workshop.disabled=true;step();
      check(call(workshop).style.disabled===true && Math.abs(call(workshop).style.damage-.6)<.0001,'disabled damage cue');
      workshop.hp=workshop.maxHp;workshop.disabled=false;workshop.faction=1;step();
      check(call(workshop).style.ownerColor===w.factions[1].color && call(workshop).style.damage===0,'repair and ownership refresh');
      workshop.progress=.1;step();check(call(workshop).style.state==='working','workshop production state');
      byKind.druglab.lab.brewing='saffron';step();check(call(byKind.druglab).style.state==='brewing','lab brewing state');
      const wardView=renderer.views.get(byKind.ward.id);wardView.onEvent({t:'wardPulse',buildingId:byKind.ward.id},renderer.frame);step();
      check(call(byKind.ward).style.state==='pulse','ward pulse state');
      const hearthView=renderer.views.get(hearth.id), capture=[];
      for(const stage of ['safe','threatened','contained','contested','overwritten','captured']) {
        hearth.hearth.stage=stage;hearth.hearth.attacker=1;hearth.hearth.pressure[1]=80;step();
        capture.push({stage,height:hearthView.fire.style.height,split:hearthView.fire.style.split,color:hearthView.fire.style.body.getHex()});
        check(hearthView.fire.mesh.parent===hearthView.effects && hearthView.fire.mesh.visible,'capture fire survives '+stage);
      }
      check(new Set(capture.map(x=>JSON.stringify([x.height,x.split,x.color]))).size===6,'capture stages retain live effects',capture);
      w.factions[0].controlMode='rts';step();
      check(call(hearth).style.state==='seated' && call(hearth).pose.height===2 && !hearthView.fire.mesh.visible,'occupied altar low base and no duplicate fire/pole');
      w.factions[0].controlMode='avatar';step();
      check(call(hearth).style.state==='idle' && hearthView.fire.mesh.visible,'altar restored after RTS exit');
      for(const [b,count] of [[hearth,40],[workshop,14]]) for(let i=0;i<count;i++) {
        const id=w.newId();flags.push(id);w.flags.set(id,{id,state:'stock',holder:b.id});
      }
      const economy=w.scratch.economy;economy.stockTick=w.tick;economy.hoarding[0]=true;step();
      check(stock(hearth).length===30 && stock(hearth).every(x=>!x.pose.moving),'hoarded rack freezes thirty real flags');
      check(stock(workshop).length===10,'workshop rack caps at ten real flags');
      economy.hoarding[0]=false;step();check(stock(hearth).every(x=>x.pose.moving),'rack resumes animation after hoarding');
      const dome=renderer.views.get(gcc.id).root.getObjectByName('gcc-recruitment-dome');
      gcc.gcc.channelUntil=w.time+10;step();check(call(gcc).style.state==='channel' && dome.visible,'GCC channel and recruitment dome');
      gcc.gcc.channelUntil=0;gcc.pos.x+=1;step();check(call(gcc).style.state==='moving','GCC moving');
      gcc.gcc.destroyedUntil=w.time+10;gcc.disabled=true;step();check(call(gcc).style.state==='wreck' && !dome.visible,'GCC wreck hides range');
      gcc.gcc.destroyedUntil=0;gcc.disabled=false;step();check(dome.visible,'GCC rebuild restores range');
      w.boss={held:{kind:'building',id:workshop.id}};step();
      check(!call(workshop) && stock(workshop).length===0 && !renderer.views.get(workshop.id).root.visible,'boss-held world building and stock suppressed');
      w.boss=saved.boss;
      for(const valid of [true,false]) {
        a.session.ghost={kind:'workshop',facet:0,edge:-1,level:2,rampEdge:0,valid};step();
        const preview=calls.find(x=>x.pose.id===-1800000000);
        check(preview?.style.ghost && preview.style.ownerColor===(valid?0x3df2ff:0xff3448),'building ghost '+(valid?'valid':'invalid'));
      }
      a.session.ghost=null;step();check(!calls.some(x=>x.pose.id===-1800000000),'building ghost cancel clears');
      return {checks,allPassed:checks.every(x=>x.ok),fixture:'Offline production StructuresRenderer updates; no physical-phone performance claim.'};
    } finally {
      s.building=original.building;s.flag=original.flag;s.sample=original.sample;
      for(const id of created)w.buildings.delete(id);for(const id of flags)w.flags.delete(id);
      w.nextEntityId=saved.nextId;w.boss=saved.boss;a.session.ghost=saved.ghost;
      w.factions.forEach((f,i)=>Object.assign(f,saved.faction[i]));w.scratch.economy=saved.economy;
      if(saved.economy){saved.economy.stockTick=saved.stockTick;saved.economy.hoarding.splice(0,4,...saved.hoarding);}
      g.render(0);
    }
  });
  for (const check of result.checks) assert.ok(check.ok, check.label+' '+JSON.stringify(check.detail ?? ''));
  return result;
}

/** Prove live map updates affect only semantic map pixels and remain compass-true. */
export async function verifyBuildingLiveMap(page, {deferAssertions = false} = {}) {
  const result = await page.evaluate(() => {
    const a=window.flaghack,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    if(a.net)throw Error('Live map pixel fixture is offline only.');
    const texture=ctx.shared.gccTableTexture,canvas=texture?.image,pen=canvas?.getContext('2d');
    if(!pen||!p)throw Error('Live map texture and render probe required.');
    const savedPixels=pen.getImageData(0,0,canvas.width,canvas.height), children=ctx.scene.children.map(o=>[o,o.visible]);
    const camera={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom};
    const oldTime=ctx.time,checks=[],captures={};
    const toLinear=value=>{const v=value/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
    const paint=color=>{pen.fillStyle=color;pen.fillRect(0,0,canvas.width,canvas.height);texture.needsUpdate=true;};
    try {
      for(const [o] of children)o.visible=p.meshes().includes(o);
      c.position.set(0,1.7,12);c.lookAt(0,1.7,0);c.left=-2.5;c.right=2.5;c.top=2.5*innerHeight/innerWidth;c.bottom=-c.top;c.updateProjectionMatrix();c.updateMatrixWorld();
      ctx.time=0;
      for(const yaw of [0,Math.PI/2]) {
        const pose={id:0,x:0,y:0,z:0,yaw,height:3.4,moving:false};
        const render=()=>{s.begin();s.building('gcc',pose,{state:'idle'});s.end();return p.draw();};
        paint('#ff0000');const red=render();paint('#0000ff');const blue=render();
        const mesh=s.meshes.find(m=>m.visible),geometry=mesh.geometry;
        const map=mesh.material.uniforms.map.value.image,atlas=document.createElement('canvas');atlas.width=map.width;atlas.height=map.height;
        const atlasCtx=atlas.getContext('2d');atlasCtx.drawImage(map,0,0);const pixels=atlasCtx.getImageData(0,0,atlas.width,atlas.height).data;
        const size=geometry.getAttribute('aSize'),offset=geometry.getAttribute('aOffset'),rect=geometry.getAttribute('aRect');
        const center=c.position.clone().set(0,0,0).applyMatrix4(c.matrixWorldInverse);
        const sampleAt=(x,y)=>{
          const qx=c.left+(x+.5)/innerWidth*(c.right-c.left)-center.x;
          const qy=c.bottom+(y+.5)/innerHeight*(c.top-c.bottom)-center.y;
          const lx=(qx-offset.getX(0))/size.getX(0)+.5,ly=(qy-offset.getY(0))/size.getY(0);
          if(lx<0||lx>=1||ly<0||ly>=1)return null;
          const u=rect.getX(0)+lx*rect.getZ(0),v=rect.getY(0)+ly*rect.getW(0);
          const ax=Math.max(0,Math.min(atlas.width-1,Math.floor(u*atlas.width))),ay=Math.max(0,Math.min(atlas.height-1,Math.floor((1-v)*atlas.height)));
          return pixels.subarray((ay*atlas.width+ax)*4,(ay*atlas.width+ax)*4+4);
        };
        let changed=0,outside=0;
        for(let y=0;y<innerHeight;y++)for(let x=0;x<innerWidth;x++){
          const at=(y*innerWidth+x)*4;
          if(Math.abs(red[at]-blue[at])+Math.abs(red[at+1]-blue[at+1])+Math.abs(red[at+2]-blue[at+2])<=6)continue;
          changed++;if(sampleAt(x,y)?.[3]!==160)outside++;
        }
        pen.fillStyle='#ff0000';pen.fillRect(0,0,canvas.width/2,canvas.height);pen.fillStyle='#0000ff';pen.fillRect(canvas.width/2,0,canvas.width/2,canvas.height);texture.needsUpdate=true;
        const oriented=render();let tested=0,incorrect=0;
        for(let y=0;y<innerHeight;y++)for(let x=0;x<innerWidth;x++){
          const pixel=sampleAt(x,y);if(pixel?.[3]!==160)continue;
          const localX=toLinear(pixel[0])*2-1,localZ=toLinear(pixel[1])*2-1,wx=localX*Math.cos(yaw)+localZ*Math.sin(yaw);
          if(Math.abs(wx)<.07)continue;
          const at=(y*innerWidth+x)*4,delta=oriented[at]-oriented[at+2];tested++;if(wx<0?delta<20:delta>-20)incorrect++;
        }
        const label=yaw===0?'front':'side';captures[label+'-red']=p.png(red);captures[label+'-blue']=p.png(blue);captures[label+'-compass']=p.png(oriented);
        checks.push({label,yaw,changedPixels:changed,outsideMapMask:outside,compassSamples:tested,incorrectCompassSamples:incorrect,sample:{...s.samples[0]}});
      }
      return {checks,captures,sourceTextureRestored:true};
    } finally {
      pen.putImageData(savedPixels,0,0);texture.needsUpdate=true;ctx.time=oldTime;
      for(const [o,visible]of children)o.visible=visible;c.position.copy(camera.position);c.quaternion.copy(camera.quaternion);Object.assign(c,{left:camera.left,right:camera.right,top:camera.top,bottom:camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);
    }
  });
  if (!deferAssertions) for(const check of result.checks){assert.ok(check.changedPixels>10,'Live map contributes changed pixels: '+check.label);assert.equal(check.outsideMapMask,0,'Map edits must not repaint GCC body: '+check.label);assert.ok(check.compassSamples>10,'Map compass samples: '+check.label);assert.equal(check.incorrectCompassSamples,0,'Map stays compass-true: '+check.label);}
  return result;
}
