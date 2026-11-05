/** Native GPU proof for every shipped scenery/building cell, plus readable equal-size galleries. */
function verifyWorldSpritePixels({world,buildings,boundsSource}) {
  const a=window.flaghack,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera,r=g.renderer;
  if(a.net)throw Error('World sprite fixtures are offline only');
  const children=ctx.scene.children.map(o=>[o,o.visible]),saved={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom,time:ctx.time,background:ctx.scene.background,alpha:r.getClearAlpha()};
  const cells=[],camera=[],missing=[],captures={},clips={...world.clips,...buildings.clips},bounds=Function('return ('+boundsSource+')')();
  const count=pixels=>{let n=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>127)n++;return n;};
  const pose=(clip,yaw=0)=>({id:0,x:0,y:0,z:0,yaw,height:Math.min(3,3*clip.heightPixels/Math.max(clip.cellWidth,clip.cellHeight)),moving:true});
  const emit=(key,clip,direction,frame)=>{const split=key.lastIndexOf(':'),kind=key.slice(0,split),state=key.slice(split+1);ctx.time=frame*clip.frameDurationMs/1000+.001;s.begin();const accepted=s.object(kind,{...pose(clip,-direction*Math.PI/2),animationTime:ctx.time},{state,frame});s.end();return {accepted,state,sample:s.samples[0],pixels:p.draw()};};
  const ownerFor=key=>{
    const type=key.split(':'),o=type[0]==='scenery'?ctx.world.map.obstacles.find(o=>o.kind===type[1]&&(type[2]===undefined||o.variant===Number(type[2]))):null;
    const color=o?.color??(type[0]==='building'?ctx.world.factions[0].color:0xffffff),linear=n=>n<=.04045?n/12.92:Math.pow((n+.055)/1.055,2.4);
    return {r:linear((color>>16&255)/255),g:linear((color>>8&255)/255),b:linear((color&255)/255)};
  };
  const savePNG=(data,width,height)=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const out=new Uint8ClampedArray(data.length),srgb=v=>Math.round(255*(v<=.0031308?12.92*v:1.055*Math.pow(v,1/2.4)-.055));
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,j=((height-y-1)*width+x)*4;out[j]=srgb(data[i]/255);out[j+1]=srgb(data[i+1]/255);out[j+2]=srgb(data[i+2]/255);out[j+3]=data[i+3];}
    canvas.getContext('2d').putImageData(new ImageData(out,width,height),0,0);return canvas;
  };
  try {
    for(const [o] of children)o.visible=p.meshes().includes(o);
    ctx.scene.background=null;r.setClearAlpha(0);c.position.set(0,0,12);c.lookAt(0,0,0);c.top=4;c.bottom=-4;c.left=-4*innerWidth/innerHeight;c.right=-c.left;c.updateProjectionMatrix();c.updateMatrixWorld();
    for(const [key,clip] of Object.entries(clips)) {
      for(let direction=0;direction<4;direction++)for(let frame=0;frame<clip.columns;frame++) {
        const shot=emit(key,clip,direction,frame),mesh=s.meshes.find(m=>m.visible),size=mesh.geometry.getAttribute('aSize'),offset=mesh.geometry.getAttribute('aOffset'),foot=clip.footYByCell?.[direction]?.[frame]??clip.anchor[1],anchorResidual=Math.hypot((clip.anchor[0]/clip.cellWidth-.5)*size.getX(0)+offset.getX(0),(1-foot/clip.cellHeight)*size.getY(0)+offset.getY(0));cells.push({key,direction:['front','right','away','left'][direction],frame,state:shot.state,accepted:shot.accepted,sample:shot.sample,pixels:count(shot.pixels),anchorResidual});
      }
      const views=[];
      for(const [name,pitch,roll] of [['level',0,0],['pitch',1.05,0],['roll',.65,.5]]){
        c.position.set(0,Math.sin(pitch)*20,Math.cos(pitch)*20);c.lookAt(0,0,0);c.rotateZ(roll);c.updateMatrixWorld();s.begin();s.end();const empty=p.draw();const shot=emit(key,clip,0,0);views.push({name,...bounds(empty,shot.pixels,innerWidth,innerHeight)});
      }
      camera.push({key,views});c.position.set(0,0,12);c.lookAt(0,0,0);c.updateMatrixWorld();
    }
    for(const key of ['scenery:tent:0','building:workshop','effigy:scaffold','unknown-object']) {
      s.begin();const accepted=s.object(key,{id:0,x:0,y:0,z:0,yaw:0,height:2,moving:false},{state:'unknown-qa-state'});s.end();missing.push({key,accepted,fallbacks:s.fallbackCount,sample:s.samples[0],pixels:count(p.draw())});
    }
    // Every object is rendered with the production shader, normalized to fit a labeled cell.
    // This gallery intentionally does not imply that all objects have the same in-game size.
    for(const [title,source] of [['world',world],['building',buildings]]) {
      const entries=Object.entries(source.clips),columns=title==='world'?6:4,rows=Math.ceil(entries.length/columns),width=columns*240,height=rows*250;
      const target=g.warmTarget.clone();target.setSize(width,height);c.position.set(0,0,20);c.lookAt(0,0,0);c.left=0;c.right=columns*2.4;c.top=rows*2.5;c.bottom=0;c.updateProjectionMatrix();c.updateMatrixWorld();
      for(const direction of [0,1]) {
        s.begin();entries.forEach(([key,clip],i)=>{const col=i%columns,row=Math.floor(i/columns),split=key.lastIndexOf(':'),scale=1.85/Math.max(clip.cellWidth,clip.cellHeight),y=rows*2.5-row*2.5-2.25+Math.max(0,clip.cellHeight-clip.anchor[1])*scale;
          s.object(key.slice(0,split),{id:i*4,x:col*2.4+1.2,y,z:0,yaw:-direction*Math.PI/2,height:clip.heightPixels*scale,moving:false},{state:key.slice(split+1),frame:0,ownerColor:ownerFor(key)});});s.end();
        const data=new Uint8Array(width*height*4),previous=r.getRenderTarget();try{r.setRenderTarget(target);r.clear();r.render(ctx.scene,c);r.readRenderTargetPixels(target,0,0,width,height,data);}finally{r.setRenderTarget(previous);}
        const sheet=document.createElement('canvas');sheet.width=width;sheet.height=height+100;const d=sheet.getContext('2d');d.fillStyle='#dfe5e3';d.fillRect(0,0,sheet.width,sheet.height);d.drawImage(savePNG(data,width,height),0,100);d.fillStyle='#16252a';d.font='bold 26px sans-serif';d.fillText('Native '+title+' sprites · '+(direction?'side':'front'),20,35);d.font='17px sans-serif';d.fillText('Actual game renderer. Equal-size gallery, not world scale.',20,67);
        entries.forEach(([key],i)=>{d.fillStyle='#16252a';d.font='14px sans-serif';d.fillText(key.replace(/^scenery:/,'').replace(/^building:/,''),i%columns*240+8,100+Math.floor(i/columns)*250+22,226);});captures[title+'-sprites-'+(direction?'side':'front')]=sheet.toDataURL('image/png').split(',')[1];
      }
      target.dispose();
    }
    return {cells,camera,missing,captures,description:'Real native GPU selection of every scenery/building cell; camera pitch/roll shape invariance; unknown state and unknown object stay flat. Gallery is normalized for comparison, not a gameplay screenshot.'};
  } finally {ctx.time=saved.time;ctx.scene.background=saved.background;r.setClearAlpha(saved.alpha);for(const [o,v] of children)o.visible=v;c.position.copy(saved.position);c.quaternion.copy(saved.quaternion);Object.assign(c,{left:saved.left,right:saved.right,top:saved.top,bottom:saved.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);}
}
module.exports={verifyWorldSpritePixels};
