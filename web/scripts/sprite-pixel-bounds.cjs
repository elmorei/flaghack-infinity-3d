/** Opaque geometry coverage on a transparent WebGL target, independent of RGB. */
function spritePixelBounds(before, after, width, height) {
  let minX=width,minY=height,maxX=-1,maxY=-1,count=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;
    if(after[i+3]>127&&before[i+3]<=127){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);count++;}
  }
  return {minX,minY,maxX,maxY,width:count?maxX-minX+1:0,height:count?maxY-minY+1:0,count};
}
module.exports={spritePixelBounds};
