/** Native GPU proof using production cutouts, ground-ink materials, beams and scenery.
 * Offline fixture only. No production render order is changed except the explicit
 * negative-control draw, and all state is restored before returning. */
export async function verifyMobileGroundInk(page) {
  // The natural start can still be in its perspective arrival transition at world.time > 1.
  // Wait for the real controls to settle into the mobile projection, never force the camera.
  await page.waitForFunction(() => window.flaghack?.session.screen === 'playing' && window.flaghack.renderer.camera.isOrthographicCamera === true, null, { timeout: 30000 });
  return page.evaluate(() => {
    const app=window.flaghack,g=app.renderer,ctx=g.ctx,c=ctx.camera,s=ctx.shared.mobileSprites,p=window.__spriteProbe,w=app.world;
    if(app.net)throw Error('Ground-ink fixture is offline only');
    const survey=g.modules.find(m=>m.lattice&&m.marked&&m.beams);
    if(!survey||!s||!p||!c.isOrthographicCamera)throw Error('Production mobile scene and native pixel probe required: '+JSON.stringify({survey:!!survey,sprites:!!s,probe:!!p,camera:c.type,orthographic:!!c.isOrthographicCamera}));
    const objects=[];ctx.scene.traverse(o=>objects.push([o,o.visible]));
    const saved={camera:{position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom},
      background:ctx.scene.background,alpha:g.renderer.getClearAlpha(),time:ctx.time,view:app.session.view,screen:app.session.screen,mode:app.session.mobileMode,
      depth:s.meshes.map(m=>[m,m.material.depthTest]),blend:app.session.viewBlend,plan:w.factions[app.session.playerFaction].plan,uView:survey.u.uViewBlend.value,reveal:survey.u.uReveal.value.clone()};
    const checks=[],captures={},transparentCutouts={signifier:0,flag:0};
    const check=(ok,label,detail)=>checks.push({ok:!!ok,label,...detail});
    const show=o=>{for(let n=o;n;n=n.parent)n.visible=true;};
    const only=extras=>{for(const [o]of objects)o.visible=false;ctx.scene.visible=true;for(const m of s.meshes)if(m.geometry.instanceCount)show(m);for(const o of extras)show(o);};
    const rgbChanged=(a,b,i)=>Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>6;
    const maskedDiff=(a,b,mask)=>{let count=0;for(let i=0;i<a.length;i+=4)if(mask[i+3]>250&&rgbChanged(a,b,i))count++;return count;};
    const maskCount=mask=>{let count=0;for(let i=3;i<mask.length;i+=4)if(mask[i]>250)count++;return count;};
    // Count genuine cutout texels inside the actor's opaque bounding box, not empty
    // background beside the billboard. Ink must be visible and equal its isolated draw.
    const cutoutInkPixels=(sprite,ink,combined)=>{
      const width=innerWidth; // installProbe draws a CSS-pixel-sized target at every DPR.
      const height=sprite.length/4/width;
      let minX=width,minY=height,maxX=-1,maxY=-1,count=0;
      for(let i=0;i<sprite.length;i+=4)if(sprite[i+3]>250){const x=i/4%width,y=Math.floor(i/4/width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
      for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const i=(y*width+x)*4;if(sprite[i+3]<5&&ink[i+3]>8&&rgbChanged(sprite,combined,i)&&!rgbChanged(ink,combined,i))count++;}
      return count;
    };
    const nodeId=Array.from(w.survey.edgeLey).findIndex(owner=>owner>=0);
    const edge=nodeId>=0?w.lattice.edges[nodeId]:w.lattice.edges.find(e=>!w.lattice.nodes[e.a].blocked&&!w.lattice.nodes[e.b].blocked);
    if(!edge)throw Error('A real lattice edge is required');
    const node=w.lattice.nodes[edge.a],ground=ctx.shared.groundOffset(node.x,node.z);
    const center=c.position.clone().set(node.x,ground+.15,node.z);
    const cameraAt=(point,extent=3)=>{c.position.set(point.x,point.y+10.392,point.z+6);c.lookAt(point);c.left=-extent;c.right=extent;c.top=extent*innerHeight/innerWidth;c.bottom=-c.top;c.updateProjectionMatrix();c.updateMatrixWorld();};
    const poseAt=(point,height,offset)=>{const up=c.up.clone().setFromMatrixColumn(c.matrixWorld,1),foot=point.clone().addScaledVector(up,-offset);return{id:911,x:foot.x,y:foot.y,z:foot.z,yaw:0,height,moving:false};};
    const emit=(kind,point,offset=1.4,height=1.4)=>{s.begin();const pose=poseAt(point,height,offset);if(kind==='signifier')s.signifier(pose,0,0,'idle');else s.flag({...pose,height:2.8},'planted');s.end();};
    try {
      ctx.scene.background=null;g.renderer.setClearAlpha(0);app.session.view='command';app.session.screen='playing';app.session.mobileMode='build';app.session.viewBlend=1;
      survey.u.uViewBlend.value=1;survey.u.uReveal.value.set(1,0,1000,0);
      w.factions[app.session.playerFaction].plan=new Set([node.id]);survey.data.update(ctx.time);survey.marked.update();
      cameraAt(center);
      const layers=[['lattice-lines',survey.lattice.lines],['lattice-dots',survey.lattice.markers],['Plan-dots',survey.marked.mesh],['ley-lines',survey.ley.mesh],['implied-glyphs',survey.implied.glyphs.mesh]];
      // Actual implied glyphs can be absent in a seeded match. Stage one in its production batch.
      survey.implied.glyphs.reset();survey.implied.glyphs.push(0,0,.15,0,.65,survey.u.uFactionColor.value[0],1,0,0,10,node.id);survey.implied.glyphs.commit();
      for(const [label,mesh]of layers)for(const kind of ['signifier','flag']) {
        const far=w.lattice.nodes[edge.b],inkCenter=label==='ley-lines'?center.clone().set((node.x+far.x)/2,ctx.shared.groundOffset((node.x+far.x)/2,(node.z+far.z)/2)+1.35,(node.z+far.z)/2):center;
        cameraAt(inkCenter);
        const mat=mesh.material, state={transparent:mat.transparent,depthTest:mat.depthTest,order:mesh.renderOrder};
        let overlap=0,changed=0,pixels=0;
        try {
          for(const fraction of [.2,.5,.8]) {
            emit(kind,inkCenter,2.8*fraction);only([]);const baseline=p.draw();pixels=Math.max(pixels,maskCount(baseline));
            only([mesh]);const combined=p.draw();changed+=maskedDiff(baseline,combined,baseline);
            if(label==='lattice-lines'||label==='lattice-dots'){
              for(const m of s.meshes)m.visible=false;const inkOnly=p.draw();for(const m of s.meshes)if(m.geometry.instanceCount)show(m);
              transparentCutouts[kind]+=cutoutInkPixels(baseline,inkOnly,combined);
            }
            // Positive overlap control: draw the same real ink over the cutout.
            mat.transparent=true;mat.depthTest=false;mesh.renderOrder=10000;mat.needsUpdate=true;
            const legacy=p.draw();overlap+=maskedDiff(baseline,legacy,baseline);
            mat.transparent=state.transparent;mat.depthTest=state.depthTest;mesh.renderOrder=state.order;mat.needsUpdate=true;
            if(label==='Plan-dots'&&kind==='signifier'&&fraction===.5){captures['ground-ink-fixed']=p.png(combined);captures['ground-ink-overlap-control']=p.png(legacy);}
          }
        } finally {mat.transparent=state.transparent;mat.depthTest=state.depthTest;mesh.renderOrder=state.order;mat.needsUpdate=true;}
        check(!mat.transparent&&!mat.depthWrite&&mesh.renderOrder<s.mesh.renderOrder,label+' uses ground ink before '+kind,{pixels,overlap,changed});
        check(pixels>20&&overlap>0&&changed===0,label+' cannot paint over '+kind,{pixels,overlap,changed});
      }
      for(const kind of ['signifier','flag'])check(transparentCutouts[kind]>0,'grid remains visible through '+kind+' transparent cutouts',{pixels:transparentCutouts[kind]});
      // The same foreground combat beam must still draw over actors, not be moved under them.
      cameraAt(center);emit('signifier',center);only([]);const baseline=p.draw();
      const right=c.up.clone().setFromMatrixColumn(c.matrixWorld,0),front=c.up.clone().setFromMatrixColumn(c.matrixWorld,2),a=center.clone().addScaledVector(right,-2).addScaledVector(front,.7),b=center.clone().addScaledVector(right,2).addScaledVector(front,.7);
      survey.beams.reset();survey.beams.push(0,a.x,a.y-ctx.shared.groundOffset(a.x,a.z),a.z,b.x,b.y-ctx.shared.groundOffset(b.x,b.z),b.z,.65,survey.u.uFactionColor.value[0].clone().setRGB(0,1,1),1,1);survey.beams.commit();only([survey.beams.mesh]);
      const beamPixels=maskedDiff(baseline,p.draw(),baseline);
      check(survey.beams.mesh.material.transparent&&beamPixels>3,'genuine foreground beam remains in front',{beamPixels});
      // Real terrain and the real batched tent must still depth-occlude cutouts.
      const env=g.modules.find(m=>m.env&&m.parts),props=env?.parts.find(part=>part.sceneryInstances),tent=w.map.obstacles.find(o=>o.kind==='tent');
      for(const kind of ['terrain','tent']) {
        const at=kind==='tent'&&tent?center.clone().set(tent.x,ctx.shared.groundOffset(tent.x,tent.z),tent.z):center.clone();
        const occluders=kind==='terrain'?[ctx.scene.getObjectByName('ground')]:tent?(props?.sceneryInstances.get(tent.id)??[]).map(entry=>entry.mesh):[];
        if(!occluders.length||occluders.some(o=>!o))throw Error('Actual '+kind+' geometry required');
        cameraAt(at,kind==='tent'?Math.max(3,tent.height):3);
        s.begin();s.signifier({id:922,x:at.x,y:at.y-(kind==='terrain'?4:0),z:at.z,yaw:0,height:kind==='terrain'?1.4:.4,moving:false},0,0);s.end();only(occluders);
        const active=s.meshes.filter(m=>m.geometry.instanceCount>0),contribution=()=>{for(const m of active)m.visible=false;const without=p.draw();for(const m of active)show(m);return p.diff(without,p.draw());};
        const depthPixels=contribution();for(const m of active)m.material.depthTest=false;const throughPixels=contribution();for(const m of active)m.material.depthTest=true;
        check(throughPixels>20&&depthPixels<throughPixels*.8,'real '+kind+' occludes cutouts',{depthPixels,throughPixels});
      }
      return{checks,allPassed:checks.every(x=>x.ok),captures,description:'Real native WebGL production materials: ground-ink negative/positive controls, foreground combat beam, actual terrain and tent depth.'};
    } finally {
      for(const [mesh,depth]of saved.depth)mesh.material.depthTest=depth;
      for(const [o,visible]of objects)o.visible=visible;ctx.scene.background=saved.background;g.renderer.setClearAlpha(saved.alpha);ctx.time=saved.time;
      Object.assign(app.session,{view:saved.view,screen:saved.screen,mobileMode:saved.mode,viewBlend:saved.blend});w.factions[app.session.playerFaction].plan=saved.plan;
      survey.u.uViewBlend.value=saved.uView;survey.u.uReveal.value.copy(saved.reveal);
      c.position.copy(saved.camera.position);c.quaternion.copy(saved.camera.quaternion);Object.assign(c,{left:saved.camera.left,right:saved.camera.right,top:saved.camera.top,bottom:saved.camera.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();
      // The fixture overwrites the cached implied-glyph batch without changing survey state.
      // Force its normal rebuild during restoration so no fixture glyph remains in the game.
      survey.implied.lastStamp=-Infinity;g.render(0);
    }
  });
}
