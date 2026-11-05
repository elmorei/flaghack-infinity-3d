/** Offline production 3D scenery integration checks. Restore every mutated input. */
export async function verifySceneryIntegration(page) {
  return page.evaluate(() => {
    const a=window.flaghack,w=a.world,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera;
    if(a.net)throw Error('Scenery fixture is offline only');
    const module=g.modules.find(m=>m.env&&m.parts),env=module?.env;
    const prop=module?.parts.find(part=>part.group?.name==='props'),piles=module?.parts.find(part=>part.mesh?.name==='lumber-piles'),effigy=module?.parts.find(part=>part.group?.name==='effigy');
    const wreck=g.modules.find(m=>m.group?.name==='persistent-structure-wreckage');
    if(!env||!prop||!piles||!effigy||!wreck)throw Error('Actual 3D scenery modules required on mobile');
    const saved={destroyed:[...w.destroyedScenery],piles:[...w.piles],wreckage:w.wreckage,burn:{...env.burn},time:ctx.time,uniformTime:env.uniforms.uTime.value,night:env.day.night,beat:ctx.beat,revealed:w.effigyRevealedAt,nav:w.nav.version,camera:{position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom}};
    const original={object:s.object,sample:s.sample},checks=[],calls=[],samples=[],captures={};
    s.object=function(key,...args){calls.push(key);return original.object.call(this,key,...args);};
    s.sample=function(sample){samples.push({...sample});return original.sample.call(this,sample);};
    const check=(ok,label,detail)=>checks.push({ok:!!ok,label,...(detail===undefined?{}:{detail})});
    const step=parts=>{calls.length=samples.length=0;s.begin();for(const part of parts)part.update(0);s.end();};
    const named=name=>ctx.scene.getObjectByName(name);
    try {
      w.destroyedScenery.clear();step([prop,piles,effigy]);
      const natural={props:w.map.obstacles.filter(o=>o.kind!=='effigy').length,forest:0,models:[]};
      ctx.scene.traverse(o=>{if(['props','tree-canopies','forest-pines','forest-broadleaves','art-spirals','art-pinwheels','lumber-piles','effigy','effigy-lattice','effigy-solid','effigy-mast','effigy-finial'].includes(o.name)){natural.models.push(o.name);if(o.name.startsWith('forest-'))natural.forest+=o.count??0;}});
      check(calls.length===0,'scenery, piles and effigy emit no billboard substitutes',calls);
      for(const name of ['props','tree-canopies','lumber-piles','effigy','effigy-lattice','effigy-solid','effigy-mast','effigy-finial'])check(!!named(name),'original 3D model constructed: '+name);
      check(natural.forest>100,'peripheral forest remains actual 3D instances',natural.forest);
      for(const o of w.map.obstacles.filter(o=>o.kind!=='effigy'))check(prop.sceneryRanges.has(o.id)||prop.sceneryInstances.has(o.id)||prop.spinners.some(spinner=>spinner.rotors.some(rotor=>rotor.obstacleId===o.id)),'actual obstacle geometry retained '+o.kind+'/'+o.variant+' id '+o.id);
      check(!named('mobile-scenery-effects'),'no duplicate mobile scenery effects');
      check(!!named('stage-signs'),'stage sign geometry retained');
      const stage=w.map.obstacles.find(o=>o.kind==='stage');
      if(stage){w.destroyedScenery.add(stage.id);step([prop]);check(prop.removed.has(stage.id),'destroyed stage geometry removed');check(prop.show.removed.has(stage.id),'destroyed stage lights removed');w.destroyedScenery.delete(stage.id);step([prop]);check(!prop.removed.has(stage.id)&&!prop.show.removed.has(stage.id),'stage geometry and lights restored after reset');}
      env.day.night=1;ctx.beat=1;step([prop]);check(!!named('stage-beams')&&!!named('stage-pools'),'live stage light geometry remains');
      for(const spinner of prop.spinners.filter(item=>item.rotors.length)){
        env.uniforms.uTime.value=0;step([prop]);const first=[...spinner.mesh.instanceMatrix.array];env.uniforms.uTime.value=4;step([prop]);check(spinner.mesh.instanceMatrix.array.some((value,index)=>value!==first[index]),'3D rotor animation advances '+spinner.mesh.name);
      }
      w.piles.clear();for(const [i,kind] of ['pallets','lumber','moop'].entries())w.piles.set(800000+i,{id:800000+i,type:'pile',kind,pos:{x:i*2,z:0},lumber:100,max:100});
      step([piles]);const full=piles.used;check(full>3&&piles.layouts.size===3,'all three resource kinds use 3D piece geometry');
      w.piles.get(800000).lumber=20;w.piles.get(800001).lumber=0;w.piles.delete(800002);step([piles]);check(piles.used>0&&piles.used<full,'depleted resource piles shrink and disappear');
      w.wreckage=['tent','car','wall','rock','unknown'].map((kind,i)=>({id:'qa-'+i,kind,pos:{x:i*3,y:2,z:0},size:{x:3,y:3,z:3},yaw:.2}));step([wreck]);
      check(calls.length===5&&new Set(calls).size===5,'existing material-specific mobile wreckage stays intact',calls);
      check(samples.every(sample=>!sample.placeholder),'wreckage uses real atlas cells');
      w.wreckage=[];step([wreck]);check(calls.length===0,'wreckage reset removes old sprites');
      w.effigyRevealedAt=undefined;env.burn.active=false;env.burn.elapsed=0;step([effigy]);const fullFlag=effigy.flagAssembly.scale.y;
      check(effigy.group.visible&&effigy.flagAssembly.visible&&fullFlag===1,'unburned 3D effigy and cloth remain complete');
      check(Math.abs(effigy.group.position.y-ctx.shared.groundOffset(w.map.effigy.x,w.map.effigy.z))<1e-6,'3D effigy stays grounded');
      env.burn.active=true;env.burn.elapsed=120;step([effigy]);check(effigy.burnU.uBurnTime.value===120&&effigy.flagAssembly.scale.y<fullFlag,'burn still chars scaffold and shrinks flag');check(effigy.fx.group.visible,'burn fire effects retained');
      env.burn.elapsed=200;step([effigy]);check(!effigy.flagAssembly.visible&&effigy.group.visible,'consumed flag disappears while 3D effigy base remains');
      env.burn.active=false;env.burn.elapsed=0;step([effigy]);
      // A/B the actual geometry in the native framebuffer, never a billboard substitute.
      for(const [name,obj,at,height] of [['props',prop.group,w.map.obstacles.find(o=>o.kind==='tent'),6],['effigy',effigy.group,w.map.effigy,36]]){
        if(!at)throw Error('Actual '+name+' geometry required for pixel proof');
        const y=ctx.shared.groundOffset(at.x,at.z);c.position.set(at.x,y+height,at.z+height*1.5);c.lookAt(at.x,y+height*.35,at.z);c.top=height*.6;c.bottom=-c.top;c.left=-c.top*innerWidth/innerHeight;c.right=-c.left;c.updateProjectionMatrix();c.updateMatrixWorld();
        const visible=obj.visible;let withModels,without;
        try{obj.visible=true;withModels=p.draw();obj.visible=false;without=p.draw();}finally{obj.visible=visible;}
        const pixels=p.diff(withModels,without);check(pixels>20,'actual '+name+' geometry contributes visible pixels',pixels);captures['scenery-3d-'+name]=p.png(withModels);
      }
      check(w.nav.version===saved.nav,'presentation leaves navigation revision unchanged');
      return {checks,allPassed:checks.every(item=>item.ok),natural,captures,description:'Offline production 3D scenery on mobile; real obstacles, forest, rotors, removal/reset, resource pieces, effigy burn, stage lights and native framebuffer contributions.'};
    } finally {
      s.object=original.object;s.sample=original.sample;w.destroyedScenery.clear();for(const id of saved.destroyed)w.destroyedScenery.add(id);w.piles.clear();for(const [id,pile] of saved.piles)w.piles.set(id,pile);w.wreckage=saved.wreckage;w.effigyRevealedAt=saved.revealed;Object.assign(env.burn,saved.burn);env.uniforms.uTime.value=saved.uniformTime;env.day.night=saved.night;ctx.time=saved.time;ctx.beat=saved.beat;
      c.position.copy(saved.camera.position);c.quaternion.copy(saved.camera.quaternion);Object.assign(c,{left:saved.camera.left,right:saved.camera.right,top:saved.camera.top,bottom:saved.camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);
    }
  });
}
