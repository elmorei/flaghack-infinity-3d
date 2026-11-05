/** Runs inside native Chrome. Uses actual production GPU batches and textures. */
function verifySpriteSkinPixels({atlas,actions,palette}) {
  const a=window.flaghack,g=a.renderer,ctx=g.ctx,s=ctx.shared.mobileSprites,p=window.__spriteProbe,c=ctx.camera,r=g.renderer;
  if(a.net)throw Error('Skin fixtures are offline only');
  const children=ctx.scene.children.map(o=>[o,o.visible]);
  const saved={position:c.position.clone(),quaternion:c.quaternion.clone(),left:c.left,right:c.right,top:c.top,bottom:c.bottom,time:ctx.time,background:ctx.scene.background,alpha:r.getClearAlpha()};
  const records=p.meshes().map(mesh=>({mesh,map:mesh.material.uniforms.map.value,mask:null})),cases=[],captures={};
  const maskCount=data=>{let n=0;for(let i=3;i<data.length;i+=4)if(data[i]>127)n++;return n;};
  const hash=data=>{let h=2166136261;for(let i=0;i<data.length;i++)h=Math.imul(h^data[i],16777619);return h>>>0;};
  const isHead=(mesh,i)=>{
    if(mesh.name!=='mobile-sprite-batch')return false;
    const rect=mesh.geometry.getAttribute('aRect'),x=(rect.getX(i)+rect.getZ(i)/2)*atlas.width,y=(1-rect.getY(i)-rect.getW(i)/2)*atlas.height;
    return ['heads-front','heads-away'].some(name=>{const q=atlas.sheets[name];return x>=q.x&&x<q.x+q.w&&y>=q.y&&y<q.y+q.h;});
  };
  const drawMask=category=>{
    const sizes=records.map(({mesh})=>[mesh,mesh.geometry.getAttribute('aSize').array.slice()]);
    try {
      for(const rec of records){
        rec.mesh.material.uniforms.map.value=rec.mask;
        const attr=rec.mesh.geometry.getAttribute('aSize');
        for(let i=0;i<rec.mesh.geometry.instanceCount;i++)if(category!=='all'&&(isHead(rec.mesh,i)!==(category==='head')))attr.setXY(i,0,0);
        attr.needsUpdate=true;
      }
      return p.draw();
    } finally {for(const [mesh,data] of sizes){const attr=mesh.geometry.getAttribute('aSize');attr.array.set(data);attr.needsUpdate=true;}for(const rec of records)rec.mesh.material.uniforms.map.value=rec.map;}
  };
  const png=(data,width,height)=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const output=new Uint8ClampedArray(data.length);
    // Render targets contain linear RGB. Encode for a normal sRGB PNG display.
    const srgb=v=>Math.round(255*(v<=.0031308?12.92*v:1.055*Math.pow(v,1/2.4)-.055));
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const src=(y*width+x)*4,dst=((height-y-1)*width+x)*4;
      output[dst]=srgb(data[src]/255);output[dst+1]=srgb(data[src+1]/255);output[dst+2]=srgb(data[src+2]/255);output[dst+3]=data[src+3];
    }
    canvas.getContext('2d').putImageData(new ImageData(output,width,height),0,0);return canvas;
  };
  try {
    for(const [o] of children)o.visible=p.meshes().includes(o);
    ctx.scene.background=null;r.setClearAlpha(0);
    c.position.set(0,5,12);c.lookAt(0,1,0);c.top=4;c.bottom=-4;c.left=-4*innerWidth/innerHeight;c.right=-c.left;c.updateProjectionMatrix();c.updateMatrixWorld();
    for(const rec of records){
      const img=rec.map.image,canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      if(img.data)context.putImageData(new ImageData(new Uint8ClampedArray(img.data),img.width,img.height),0,0);else context.drawImage(img,0,0);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height);
      for(let i=0;i<pixels.data.length;i+=4){const mask=pixels.data[i+3]===192;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;pixels.data[i+3]=mask?255:0;}
      context.putImageData(pixels,0,0);rec.mask=rec.map.clone();
      // Texture.clone shares its Source. Give the probe a new source so making
      // a white mask can never overwrite the production atlas or its GPU cache.
      const maskImage=rec.map.isDataTexture?{data:new Uint8Array(pixels.data),width:img.width,height:img.height}:canvas;
      rec.mask.source=new rec.map.source.constructor(maskImage);rec.mask.needsUpdate=true;
      if(rec.mask.source===rec.map.source||rec.map.image!==img)throw Error('Skin mask probe must not mutate production textures');
    }
    const specs=[];
    for(const direction of ['front','away']){
      for(let head=0;head<18;head++)specs.push({kind:'head',head,body:0,clip:'idle',direction,frame:0});
      for(let body=0;body<7;body++)for(let frame=0;frame<4;frame++)specs.push({kind:'body',head:0,body,clip:'walk',direction,frame});
      for(const [key,clip] of Object.entries(actions.clips).filter(([key])=>key.startsWith('signifier:')))for(let frame=0;frame<clip.columns;frame++)specs.push({kind:'action',head:0,body:0,clip:key.split(':')[1],direction,frame,frameDurationMs:clip.frameDurationMs});
    }
    for(const spec of specs){
      const shots=[],samples=[],pose={id:0,x:0,y:0,z:0,yaw:spec.direction==='front'?0:Math.PI,height:3,moving:true,animationTime:spec.frame*(spec.frameDurationMs??atlas.frameDurationMs)/1000+.001};
      ctx.time=pose.animationTime;
      for(let tone=0;tone<6;tone++){s.begin();s.signifier({...pose,skinTone:tone},spec.head,spec.body,spec.clip);s.end();shots.push(p.draw());samples.push(s.samples[0]?.skinTone);}
      const allMask=drawMask('all'),headMask=drawMask('head'),bodyMask=drawMask('body');
      let outsideSkinChanges=0,alphaChanges=0,headChanges=0,bodyChanges=0;
      for(let tone=1;tone<6;tone++)for(let i=0;i<shots[0].length;i+=4){
        if(shots[0][i+3]!==shots[tone][i+3])alphaChanges++;
        const changed=shots[0][i]!==shots[tone][i]||shots[0][i+1]!==shots[tone][i+1]||shots[0][i+2]!==shots[tone][i+2];
        if(changed){if(allMask[i+3]<=127)outsideSkinChanges++;if(headMask[i+3]>127)headChanges++;if(bodyMask[i+3]>127)bodyChanges++;}
      }
      cases.push({...spec,samples,skinPixels:maskCount(allMask),headPixels:maskCount(headMask),bodyPixels:maskCount(bodyMask),outsideSkinChanges,alphaChanges,headChanges,bodyChanges,distinctTones:new Set(shots.map(hash)).size});
    }
    // A readable, labeled proof sheet is rendered as one scene, not recolored PNG art.
    const width=1200,height=1440,target=g.warmTarget.clone();target.setSize(width,height);
    const rows=[['idle',0,0],['carry',4,6],['hammer',8,2],['chop',10,1],['kneel',2,0],['ko',5,0]];
    c.position.set(0,7,20);c.lookAt(0,7,0);c.left=-6;c.right=6;c.top=7.2;c.bottom=-7.2;c.updateProjectionMatrix();c.updateMatrixWorld();ctx.time=.141;
    for(const direction of ['front','away']){
      s.begin();
      for(const [row,[clip,head,body]] of rows.entries())for(let tone=0;tone<6;tone++)s.signifier({id:(row*6+tone)*4,x:(tone-2.5)*2,y:12-row*2.3,z:0,yaw:direction==='front'?0:Math.PI,height:1.7,moving:true,animationTime:.141,skinTone:tone},head,body,clip);
      s.end();const previous=r.getRenderTarget(),data=new Uint8Array(width*height*4);
      try{r.setRenderTarget(target);r.clear();r.render(ctx.scene,c);r.readRenderTargetPixels(target,0,0,width,height,data);}finally{r.setRenderTarget(previous);}
      const raw=png(data,width,height),sheet=document.createElement('canvas');sheet.width=width;sheet.height=height+140;const d=sheet.getContext('2d');
      d.fillStyle='#dfe5e3';d.fillRect(0,0,sheet.width,sheet.height);d.drawImage(raw,0,110);d.fillStyle='#16252a';d.font='bold 30px sans-serif';d.fillText('Six original model skin tones · '+direction,28,38);d.font='20px sans-serif';d.fillText('Native renderer. Same head, clothing and action in each row.',28,72);
      for(let tone=0;tone<6;tone++){d.fillStyle='#'+palette[tone].toString(16).padStart(6,'0');d.fillRect(tone*200+62,86,76,14);}
      d.fillStyle='#16252a';d.font='18px sans-serif';rows.forEach(([clip],row)=>d.fillText(clip,8,110+row*230+22));
      captures[direction]=sheet.toDataURL('image/png').split(',')[1];
    }
    target.dispose();return {cases,captures,palette,description:'All eighteen heads, seven base bodies and every action frame in both directions across all six original model tones. Changed pixels must stay inside the encoded skin masks; silhouette, clothing and hair must not change.'};
  } finally {
    for(const rec of records){rec.mesh.material.uniforms.map.value=rec.map;rec.mask?.dispose();}
    ctx.time=saved.time;ctx.scene.background=saved.background;r.setClearAlpha(saved.alpha);for(const [o,v] of children)o.visible=v;c.position.copy(saved.position);c.quaternion.copy(saved.quaternion);Object.assign(c,{left:saved.left,right:saved.right,top:saved.top,bottom:saved.bottom});c.updateProjectionMatrix();c.updateMatrixWorld();g.render(0);
  }
}
module.exports={verifySpriteSkinPixels};
