const {test}=require('node:test');const assert=require('node:assert/strict');const specs=require('./scenery-bake-specs.json');
test('canonical bake specs cover every scenery variant without depending on map seed',()=>{
 const expected={tent:3,tree:2,car:3,art:6,dome:1,porta:1,rock:1,stage:1,shade:1};
 assert.equal(specs.length,19);const keys=new Set(specs.map(o=>`${o.kind}:${o.variant}`));assert.equal(keys.size,19);
 for(const[kind,count]of Object.entries(expected))for(let v=0;v<count;v++)assert(keys.has(`${kind}:${v}`));
 for(const o of specs){assert(o.height>0&&o.hx>0&&o.hz>0&&o.radius>0);assert.equal(o.x,0);assert.equal(o.z,0);assert.equal(o.yaw,0);assert.equal(o.color,0xffffff);}
 const bus=specs.find(o=>o.kind==='car'&&o.variant===2);assert.deepEqual([bus.hx,bus.hz,bus.height],[1.25,4.3,3]);
 const cabin=specs.find(o=>o.kind==='tent'&&o.variant===2);assert.equal(cabin.shape,'box');
});
