const test=require('node:test');
const assert=require('node:assert/strict');
const {spritePixelBounds}=require('./sprite-pixel-bounds.cjs');
test('opaque black soles count as coverage even with no RGB difference',()=>{
  const before=new Uint8Array(3*4*4),after=before.slice();
  after[(1*3+1)*4+3]=255;
  after[(2*3+1)*4]=1;after[(2*3+1)*4+3]=255;
  assert.deepEqual(spritePixelBounds(before,after,3,4),{minX:1,minY:1,maxX:1,maxY:2,width:1,height:2,count:2});
});
test('transparent bright RGB and unchanged opaque background do not create geometry',()=>{
  const before=new Uint8Array([0,0,0,0,0,0,0,255]),after=new Uint8Array([255,255,255,0,200,200,200,255]);
  assert.equal(spritePixelBounds(before,after,2,1).count,0);
});
