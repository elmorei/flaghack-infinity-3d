'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {finishNativeStartup}=require('./finish-native-startup.cjs');
function fixture({present=true,clickError=null,finished=false}={}) {
  const calls=[];return {calls,page:{
    waitForFunction:async()=>calls.push('ready'),
    locator:()=>({count:async()=>+present,waitFor:async()=>calls.push('detached')}),
    getByRole:()=>({click:async()=>{calls.push('click');if(clickError)throw clickError;}}),
    evaluate:async()=>{calls.push('confirmed-title');return finished;},
  }};
}
test('optional startup Skip still uses a real click and verifies title',async()=>{
  const {page,calls}=fixture();await finishNativeStartup(page);assert.deepEqual(calls,['ready','click','detached','ready']);
});
test('a self-completed startup is accepted only after confirmed detached title',async()=>{
  const {page,calls}=fixture({clickError:new Error('detached'),finished:true});await finishNativeStartup(page);assert.deepEqual(calls,['ready','click','confirmed-title','detached','ready']);
});
test('a genuine click or startup failure is preserved',async()=>{
  const error=new Error('button blocked'),{page}=fixture({clickError:error});await assert.rejects(finishNativeStartup(page),e=>e===error);
});
test('already completed startup needs no click',async()=>{
  const {page,calls}=fixture({present:false});await finishNativeStartup(page);assert.deepEqual(calls,['ready','detached','ready']);
});
