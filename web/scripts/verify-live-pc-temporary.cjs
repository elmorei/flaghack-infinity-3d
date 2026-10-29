'use strict';
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { chromium } = require('playwright');
const OUT='host-release/public-smoke';
const URL='https://elmorei.github.io/flaghack-infinity-3d/';
const BUILD='1a3ecbd3b4efde599ab6aa978bfaaf730cd4ba49';
(async()=>{
 mkdirSync(OUT,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
 const context=await browser.newContext({viewport:{width:1280,height:720}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const result={build:BUILD,url:URL,checks:[],errors,completed:false};
 try{
  const metadata=await (await fetch(URL+'build.json')).json();assert.equal(metadata.build,BUILD);result.metadata=metadata;
  await page.goto(URL,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.flaghack?.startupPending===false||document.querySelector('#startup')?.dataset.ready==='true',null,{timeout:180000});
  const skip=page.getByRole('button',{name:'Skip',exact:true});
  if(await skip.isVisible())await skip.click({noWaitAfter:true});
  await page.locator('#startup').waitFor({state:'detached',timeout:180000});
  await page.getByRole('button',{name:'Begin the Survey',exact:true}).waitFor({timeout:30000});
  assert.equal(await page.evaluate(()=>window.flaghack.session.screen),'title');
  result.checks.push('Live cold startup reaches rendered title');
  await page.screenshot({path:OUT+'/live-title.png'});
  await page.getByRole('button',{name:'Begin the Survey',exact:true}).click({noWaitAfter:true});
  await page.getByRole('button',{name:'Light the burn',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.flaghack.session.screen),'lobby');
  result.checks.push('Begin the Survey opens local lobby');
  await page.getByRole('button',{name:'Light the burn',exact:true}).click({noWaitAfter:true});
  await page.waitForFunction(()=>window.flaghack.session.screen==='playing',null,{timeout:180000});
  const t=await page.evaluate(()=>window.flaghack.world.time);
  await page.waitForFunction(t=>window.flaghack.world.time>t+1,t,{timeout:30000});
  await page.screenshot({path:OUT+'/live-game.png'});
  result.checks.push('PC avatar match starts and simulation advances');
  assert.deepEqual(errors,[]);result.completed=true;
 }catch(e){result.error=e.stack;await page.screenshot({path:OUT+'/failure.png'}).catch(()=>{});throw e;}
 finally{writeFileSync(OUT+'/result.json',JSON.stringify(result,null,2));await browser.close();console.log(JSON.stringify(result));}
})().catch(e=>{console.error(e);process.exitCode=1;});
