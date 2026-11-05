/** Offline production scenery integration checks. Restore every mutated input before returning. */
export async function verifySceneryIntegration(page,canonical) {
  return page.evaluate(canonical=>{
    const a=window.flaghack,w=a.world,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    if(a.net)throw Error('Scenery fixture is offline only');
    const module=g.modules.find(m=>m.env&&m.parts),env=module?.env,prop=module?.parts.find(p=>p.forest&&p.rotors),piles=module?.parts.find(p=>p.layouts),effigy=module?.parts.find(p=>p.burnU&&p.fx),wreck=g.modules.find(m=>m.group?.name==='persistent-structure-wreckage');
    if(!env||!prop||!piles||!effigy||!wreck)throw Error('Actual mobile scenery modules required');
    const saved={rotors:[...prop.rotors],destroyed:[...w.destroyedScenery],piles:[...w.piles],wreckage:w.wreckage,obstacles:w.map.obstacles.length,burn:{...env.burn},time:ctx.time,uniformTime:env.uniforms.uTime.value,night:env.day.night,beat:ctx.beat,revealed:w.effigyRevealedAt,nav:w.nav.version,camera:{position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom},children:ctx.scene.children.map(o=>[o,o.visible])};
    const original={object:s.object,sample:s.sample},checks=[],calls=[],samples=[],captures={};
    s.object=function(key,pose,style={}){calls.push({key,pose:{...pose},style:{...style,ownerColor:style.ownerColor?.getHex?.(),tint:style.tint?.getHex?.(),heatColor:style.heatColor?.getHex?.()}});return original.object.call(this,key,pose,style);};
    s.sample=function(sample){samples.push({...sample});return original.sample.call(this,sample);};
    const check=(ok,label,detail)=>checks.push({ok:!!ok,label,...(detail===undefined?{}:{detail})});
    const step=parts=>{calls.length=samples.length=0;s.begin();for(const part of parts)part.update(0);s.end();};
    const find=id=>calls.find(x=>x.pose.id===id);
    try {
      // Render every canonical variant through the real production prop loop,
      // without changing navigation/collisions or the online simulation.
      for(const o of canonical)if(!w.map.obstacles.some(x=>x.kind===o.kind&&x.variant===o.variant))w.map.obstacles.push({...o,id:800000+o.id,x:o.id*4,z:0});
      w.destroyedScenery.clear();step([prop]);
      const natural={props:calls.filter(x=>x.pose.id<=-1000000&&x.pose.id>-2000000).length,forest:calls.filter(x=>x.pose.id<=-2000000).length,variants:new Set(calls.map(x=>x.key)).size};
      for(const o of w.map.obstacles.filter(x=>x.kind!=='effigy')) {
        const call=find(-1000000-o.id),sample=samples.find(x=>x.id===-1000000-o.id);
        check(call?.key===`scenery:${o.kind}:${o.variant}`&&!sample?.placeholder,'variant '+o.kind+'/'+o.variant+' id '+o.id);
        check(call?.style.ownerColor===o.color&&Math.abs(call.pose.y-ctx.shared.groundOffset(o.x,o.z))<1e-6,'color and terrain origin '+o.id);
      }
      check(natural.forest>100,'peripheral forest remains sprite-only',natural);
      const forbidden=[];ctx.scene.traverse(o=>{if(['props','tree-canopies','forest-pines','forest-broadleaves','art-spirals','art-pinwheels','lumber-piles','effigy','effigy-lattice','effigy-solid','effigy-mast','effigy-finial'].includes(o.name)||/^props-(rough|gloss|low|lights)$/.test(o.name)||(/^wreckage-fragments-/.test(o.name)&&(o.count??1)>0))forbidden.push(o.name);});
      check(forbidden.length===0,'no corresponding scenery/forest/effigy/wreck models constructed',forbidden);
      check(wreck.group.children.length===0,'wreckage model group is empty');
      check(!!ctx.scene.getObjectByName('mobile-scenery-effects')&&!!ctx.scene.getObjectByName('stage-signs'),'stage sign/effects retained');
      const stage=w.map.obstacles.find(o=>o.kind==='stage');
      if(stage){w.destroyedScenery.add(stage.id);step([prop]);check(!find(-1000000-stage.id),'destroyed stage sprite removed');check(prop.show.removed.has(stage.id),'destroyed stage live lights removed');w.destroyedScenery.delete(stage.id);step([prop]);check(!!find(-1000000-stage.id)&&!prop.show.removed.has(stage.id),'stage sprite and effects restored after reset');}
      env.day.night=1;ctx.beat=1;step([prop]);check(!!ctx.scene.getObjectByName('stage-beams')&&!!ctx.scene.getObjectByName('stage-pools'),'live stage light geometry remains');
      for(const variant of [2,3]) {
        const o=w.map.obstacles.find(o=>o.kind==='art'&&o.variant===variant);if(!prop.rotors.has(o.id))prop.rotors.set(o.id,{speed:variant===2?.17:.9,phase:0});
        const frames=new Set();for(const t of [0,4,8,16,32,64]){env.uniforms.uTime.value=t;step([prop]);frames.add(find(-1000000-o.id)?.style.frame);}
        check(frames.size>1,'rotor phase advances '+variant,[...frames]);
      }
      w.piles.clear();for(const [i,kind] of ['pallets','lumber','moop'].entries())w.piles.set(800000+i,{id:800000+i,type:'pile',kind,pos:{x:i*2,z:0},lumber:100,max:100});
      step([piles]);const full=find(-3800000)?.pose.height;check(calls.length===3&&calls.every(x=>!samples.find(s=>s.id===x.pose.id)?.placeholder),'three resource kinds select actual art');
      w.piles.get(800000).lumber=20;w.piles.get(800001).lumber=0;w.piles.delete(800002);step([piles]);check(calls.length===1&&calls[0].pose.height<full,'depleted piles shrink and disappear');
      w.wreckage=['tent','car','wall','rock','unknown'].map((kind,i)=>({id:'qa-'+i,kind,pos:{x:i*3,y:2,z:0},size:{x:3,y:3,z:3},yaw:.2}));w.destroyedScenery.clear();step([wreck]);
      check(calls.length===5&&new Set(calls.map(x=>x.key)).size===5,'material-specific durable wreckage',calls.map(x=>x.key));check(samples.every(x=>!x.placeholder),'wreckage uses real atlas cells');
      w.wreckage=[];step([wreck]);check(calls.length===0,'wreckage reset removes all sprites');
      w.effigyRevealedAt=undefined;env.burn.active=false;env.burn.elapsed=0;step([effigy]);const fullFlag=find(-5000002)?.pose.height;
      check(['effigy:plinth','effigy:scaffold','effigy:flag'].every(key=>calls.some(x=>x.key===key)),'unburned split effigy remains complete');
      const flagFrames=[];for(const t of [0,.2]){ctx.time=t;step([effigy]);flagFrames.push(samples.find(x=>x.id===-5000002)?.frame);check(Math.abs(find(-5000002).pose.y-(effigy.root.position.y+3))<1e-6,'effigy flag ground+plinth origin '+t);}check(flagFrames[0]!==flagFrames[1],'effigy cloth frames visibly advance',flagFrames);
      env.burn.active=true;env.burn.elapsed=120;step([effigy]);check(find(-5000001)?.style.cropTop>0&&find(-5000002)?.pose.height<fullFlag,'burn independently crops scaffold and shrinks flag');check(find(-5000002)?.style.heatColor!==undefined,'burn flag heat tint retained');check(effigy.fx.group.visible,'burn fire effects retained');
      env.burn.elapsed=200;step([effigy]);check(calls.length===1&&calls[0].key==='effigy:plinth','fully consumed scaffold/flag disappear but plinth remains');
      // Real owner mask A/B, using an actual production prop pose and renderer.
      const o=w.map.obstacles.find(o=>o.kind==='tent');
      step([prop]);const record=find(-1000000-o.id);for(const [obj] of saved.children)obj.visible=p.meshes().includes(obj);
      c.position.set(record.pose.x,record.pose.y+3,record.pose.z+12);c.lookAt(record.pose.x,record.pose.y+1,record.pose.z);c.top=4;c.bottom=-4;c.left=-4*innerWidth/innerHeight;c.right=-c.left;c.updateProjectionMatrix();c.updateMatrixWorld();
      const owner=colorValue=>{s.begin();original.object.call(s,record.key,{...record.pose,height:3},{ownerColor:colorValue});s.end();return p.draw();};
      const red=owner({r:1,g:0,b:0}),blue=owner({r:0,g:0,b:1}),ownerPixels=p.diff(red,blue);check(ownerPixels>20,'owner color changes actual sprite pixels',ownerPixels);captures['scenery-owner-red']=p.png(red);captures['scenery-owner-blue']=p.png(blue);
      check(w.nav.version===saved.nav,'presentation leaves navigation revision unchanged');
      return {checks,allPassed:checks.every(x=>x.ok),natural,captures,description:'Offline real mobile scenery modules; source identities, ground origins, forest, color, rotor, removal/reset, piles, wreckage, stage and burn effects.'};
    } finally {
      s.object=original.object;s.sample=original.sample;prop.rotors.clear();for(const [id,rotor] of saved.rotors)prop.rotors.set(id,rotor);w.map.obstacles.length=saved.obstacles;w.destroyedScenery.clear();for(const id of saved.destroyed)w.destroyedScenery.add(id);w.piles.clear();for(const [id,pile] of saved.piles)w.piles.set(id,pile);w.wreckage=saved.wreckage;w.effigyRevealedAt=saved.revealed;Object.assign(env.burn,saved.burn);env.uniforms.uTime.value=saved.uniformTime;env.day.night=saved.night;ctx.time=saved.time;ctx.beat=saved.beat;
      for(const [o,v] of saved.children)o.visible=v;c.position.copy(saved.camera.position);c.quaternion.copy(saved.camera.quaternion);Object.assign(c,{left:saved.camera.left,right:saved.camera.right,top:saved.camera.top,bottom:saved.camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);
    }
  },canonical);
}
