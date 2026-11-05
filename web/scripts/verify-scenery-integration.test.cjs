'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),THREE=require('three');
const snapshot=import('./verify-scenery-integration.mjs').then(module=>module.wreckageGeometrySnapshot);
function fixture(){
  const group=new THREE.Group();
  for(let i=0;i<3;i++){
    const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial(),2);mesh.name='wreckage-fragments-'+i;
    mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(i,.1,0));mesh.setColorAt(0,new THREE.Color(.2+i*.1,.3,.4));mesh.count=1;group.add(mesh);
  }
  return group;
}
function dispose(group){for(const mesh of group.children){mesh.geometry?.dispose();mesh.material?.dispose();mesh.dispose?.();}}
test('native wreckage probe reads only active real 3D instances, geometry and colors',async()=>{
  const read=await snapshot,group=fixture();
  try{const full=read(group);assert.equal(full.valid,true);assert.equal(full.fragments,3);assert.deepEqual(full.counts,[1,1,1]);assert.equal(full.palette.length,3);assert.deepEqual(read(group),full);
    for(const mesh of group.children)mesh.count=0;const empty=read(group);assert.equal(empty.valid,true);assert.equal(empty.fragments,0);assert.deepEqual(empty.palette,[]);
    for(const mesh of group.children)mesh.count=1;assert.deepEqual(read(group),full);
  }finally{dispose(group);}
});
test('wrong geometry, non-finite buffers and lost depth behavior fail the native wreckage probe',async()=>{
  const read=await snapshot;
  for(const damage of [g=>g.children[0].isInstancedMesh=false,g=>g.children[0].instanceMatrix.array[0]=NaN,g=>g.children[0].instanceColor.array[0]=Infinity,g=>g.children[0].material.depthTest=false,g=>g.children[0].material.depthWrite=false,g=>g.children[0].material.transparent=true,g=>g.children[0].count=3]){
    const group=fixture();try{damage(group);assert.equal(read(group).valid,false);}finally{dispose(group);}
  }
});
test('changed transforms or material colors change the deterministic wreckage signature',async()=>{
  const read=await snapshot,group=fixture();
  try{const before=read(group);group.children[0].instanceMatrix.array[12]+=1;assert.notEqual(read(group).checksum,before.checksum);group.children[0].instanceMatrix.array[12]-=1;group.children[0].instanceColor.array[0]+=.1;assert.notEqual(read(group).checksum,before.checksum);}finally{dispose(group);}
});
