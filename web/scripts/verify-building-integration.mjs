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
    const oldTime=ctx.time,oldBackground=ctx.scene.background,oldAlpha=g.renderer.getClearAlpha(),checks=[],captures={};
    const paint=color=>{pen.fillStyle=color;pen.fillRect(0,0,canvas.width,canvas.height);texture.needsUpdate=true;};
    try {
      for(const [o] of children)o.visible=p.meshes().includes(o);
      c.position.set(0,1.7,12);c.lookAt(0,1.7,0);c.left=-2.5;c.right=2.5;c.top=2.5*innerHeight/innerWidth;c.bottom=-c.top;c.updateProjectionMatrix();c.updateMatrixWorld();
      ctx.time=0;ctx.scene.background=null;g.renderer.setClearAlpha(0);
      for(const yaw of [0,Math.PI/2]) {
        const pose={id:0,x:0,y:0,z:0,yaw,height:3.4,moving:false};
        const render=()=>{s.begin();s.building('gcc',pose,{state:'idle'});s.end();return p.draw();};
        paint('#ff0000');const red=render();paint('#0000ff');const blue=render();
        const mesh=s.meshes.find(m=>m.visible),originalMaterial=mesh.material;
        // Rasterize the source semantic mask independently using the exact GPU
        // transform and target. CPU pixel centers do not reproduce all native
        // raster/sample behavior at scaled cutout edges.
        const sourceTexture=originalMaterial.uniforms.map.value,image=sourceTexture.image;
        const expectedCanvas=document.createElement('canvas');expectedCanvas.width=image.width;expectedCanvas.height=image.height;
        const expectedContext=expectedCanvas.getContext('2d');expectedContext.drawImage(image,0,0);
        const expectedImage=expectedContext.getImageData(0,0,image.width,image.height),expectedBytes=expectedImage.data;
        const linear=value=>{const v=value/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
        for(let at=0;at<expectedBytes.length;at+=4){
          if(expectedBytes[at+3]!==160){expectedBytes[at+3]=0;continue;}
          const x=linear(expectedBytes[at])*2-1,z=linear(expectedBytes[at+1])*2-1;
          const east=x*Math.cos(yaw)+z*Math.sin(yaw);
          expectedBytes[at]=east<0?255:0;expectedBytes[at+1]=0;expectedBytes[at+2]=east<0?0:255;
          expectedBytes[at+3]=Math.abs(east)<.07?0:255;
        }
        expectedContext.putImageData(expectedImage,0,0);
        // Texture.clone() shares its Source; allocate an independent source so
        // this expected-pattern fixture cannot replace the production atlas.
        const expectedTexture=new sourceTexture.constructor(expectedCanvas);
        for(const key of ['minFilter','magFilter','wrapS','wrapT','flipY','generateMipmaps','colorSpace'])expectedTexture[key]=sourceTexture[key];
        expectedTexture.needsUpdate=true;
        const probeMaterial=new originalMaterial.constructor({
          uniforms:{map:{value:sourceTexture},uMode:{value:0}},vertexShader:originalMaterial.vertexShader,
          fragmentShader:`uniform sampler2D map;uniform float uMode;varying vec2 vUv;
            void main(){vec4 source=texture2D(map,vUv);
              if(uMode<.5){if(source.a<159.5/255.||source.a>160.5/255.)discard;gl_FragColor=vec4(1.);}
              else{if(source.a<.5)discard;gl_FragColor=vec4(source.rgb,1.);}}`,
          depthTest:true,depthWrite:true,side:originalMaterial.side,toneMapped:false,
        });
        let mask,expectedCompass;
        try {mesh.material=probeMaterial;mask=p.draw();probeMaterial.uniforms.uMode.value=1;probeMaterial.uniforms.map.value=expectedTexture;expectedCompass=p.draw();}
        finally {mesh.material=originalMaterial;probeMaterial.dispose();expectedTexture.dispose();}
        let changed=0,outside=0;
        for(let at=0;at<red.length;at+=4){
          if(Math.abs(red[at]-blue[at])+Math.abs(red[at+1]-blue[at+1])+Math.abs(red[at+2]-blue[at+2])<=6)continue;
          changed++;if(mask[at+3]===0)outside++;
        }
        pen.fillStyle='#ff0000';pen.fillRect(0,0,canvas.width/2,canvas.height);pen.fillStyle='#0000ff';pen.fillRect(canvas.width/2,0,canvas.width/2,canvas.height);texture.needsUpdate=true;
        const oriented=render();let tested=0,incorrect=0;
        for(let at=0;at<oriented.length;at+=4){
          // Fully covered semantic pixels, excluding only the map's intentional
          // texture-filtering transition around its two-color central boundary.
          if(expectedCompass[at+3]!==255)continue;
          tested++;const expectedRed=expectedCompass[at]>expectedCompass[at+2],delta=oriented[at]-oriented[at+2];
          if(expectedRed?delta<20:delta>-20)incorrect++;
        }
        const label=yaw===0?'front':'side';captures[label+'-red']=p.png(red);captures[label+'-blue']=p.png(blue);captures[label+'-compass']=p.png(oriented);captures[label+'-semantic-mask']=p.png(mask);captures[label+'-expected-compass']=p.png(expectedCompass);
        checks.push({label,yaw,changedPixels:changed,outsideMapMask:outside,compassSamples:tested,incorrectCompassSamples:incorrect,sample:{...s.samples[0]}});
      }
      return {checks,captures,sourceTextureRestored:true,camera:{type:c.type,zoom:c.zoom,projectionMatrix:[...c.projectionMatrix.elements]}};
    } finally {
      pen.putImageData(savedPixels,0,0);texture.needsUpdate=true;ctx.time=oldTime;ctx.scene.background=oldBackground;g.renderer.setClearAlpha(oldAlpha);
      for(const [o,visible]of children)o.visible=visible;c.position.copy(camera.position);c.quaternion.copy(camera.quaternion);Object.assign(c,{left:camera.left,right:camera.right,top:camera.top,bottom:camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);
    }
  });
  if (!deferAssertions) for(const check of result.checks){assert.ok(check.changedPixels>10,'Live map contributes changed pixels: '+check.label);assert.equal(check.outsideMapMask,0,'Map edits must not repaint GCC body: '+check.label);assert.ok(check.compassSamples>10,'Map compass samples: '+check.label);assert.equal(check.incorrectCompassSamples,0,'Map stays compass-true: '+check.label);}
  return result;
}
