'use strict';
/** Production renderer on a staged, frozen local match. No shader or marker replacements. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { chromium } = require('playwright');
const DIST = resolve(__dirname, '../dist'), OUT = resolve(__dirname, '../host-release/capture-colors');
const PROJECT = '/flaghack-infinity-3d/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req,res) => {
  const path = new URL(req.url,'http://localhost').pathname;
  const file = resolve(DIST, decodeURIComponent(path.slice(PROJECT.length)) || 'index.html');
  if (!path.startsWith(PROJECT) || !file.startsWith(DIST+'/')) { res.writeHead(404); res.end(); return; }
  let body; try { body=readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}); res.end(body);
});
async function main() {
  mkdirSync(OUT,{recursive:true}); await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,args:[]});
  const context=await browser.newContext({viewport:{width:1200,height:800},hasTouch:true,isMobile:true,deviceScaleFactor:1,userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'});
  const page=await context.newPage(), result={checks:[],errors:[],scenarios:[],completed:false,physicalDeviceTest:false};
  page.on('pageerror',e=>result.errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}${PROJECT}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]')||window.flaghack&&!window.flaghack.startupPending,null,{timeout:180000});
    // Let the ordinary intro finish; capture QA does not test Skip interaction.
    await page.locator('#startup').waitFor({state:'detached',timeout:90000});
    await page.evaluate(()=>{ const a=window.flaghack; a.startMatch({seed:'native-capture-faction-colors',humans:[0,1,2,3],rtsFactions:[0,1,2,3],match:{...a.session.settings.match,active:[0,1,2,3],bossMode:false,days:3}}); });
    await page.waitForFunction(()=>window.flaghack.session.screen==='playing'&&window.flaghack.session.view==='command');
    await page.waitForTimeout(1500);
    const fixture=await page.evaluate(()=>{
      const a=window.flaghack,w=a.world,s=a.session;
      // Freeze authoritative progression only; all production renderer modules keep running.
      a.sim=null; a.ai.clear();
      // startMatch intentionally admits only one local human. This observer matrix
      // seats all fixture observers so switching faction does not enter attract-camera mode.
      w.options.humans=[0,1,2,3];
      const o=w.map.obstacles.filter(o=>o.kind==='tent').sort((x,y)=>Math.hypot(x.x,x.z)-Math.hypot(y.x,y.z))[0];
      if(!o) throw Error('No tent');
      const facet=w.lattice.facets.filter(f=>!f.boundary).sort((x,y)=>Math.hypot(x.cx-(o.x+12),x.cz-o.z)-Math.hypot(y.cx-(o.x+12),y.cz-o.z))[0];
      const b=window.fh.factory.spawnBuilding(w,'workshop',-1,facet.id,1);
      window.__captureQa={building:b.id,scenery:o.id};
      s.mobileMode='units';s.mobileMenu=null;s.camera.cmdX=(b.pos.x+o.x)/2;s.camera.cmdZ=(b.pos.z+o.z)/2;
      s.showLattice=false;
      return {building:{id:b.id,...b.pos},scenery:{id:o.id,x:o.x,z:o.z},colors:w.factions.map(f=>f.color)};
    });
    await page.waitForTimeout(1000);
    for (const faction of [0,1,2,3]) for(const stage of ['contained','safe']) {
      await page.evaluate(({faction,stage})=>{
        const a=window.flaghack,w=a.world,s=a.session,q=window.__captureQa;
        const state=()=>({stage,attacker:stage==='contained'?faction:null,pressure:{0:45,1:45,2:45,3:45},overwriteAt:0});
        const b=w.buildings.get(q.building); b.faction=stage==='contained'?-1:faction;b.capture=state();
        w.sceneryCapture.set(q.scenery,{...state(),faction:b.faction});
        // Changing observer must not change the marker's source faction colour.
        s.playerFaction=(faction+1)%4;
        s.view='command';s.viewBlend=1;
        a.controls.rig.setMode('play',0);
        a.controls.rig.snapCommand(s.camera);
      },{faction,stage});
      await page.waitForTimeout(500);
      const colors=await page.evaluate(()=>{
        const a=window.flaghack,q=window.__captureQa,w=a.world,b=w.buildings.get(q.building),o=w.map.obstacles.find(o=>o.id===q.scenery);
        const survey=a.renderer.modules.find(m=>m.decals&&m.hearths);
        if(!survey)throw Error('Production survey renderer absent');
        const all=[];
        for(const layer of [survey.decals,survey.decals.broad].filter(Boolean))for(let i=0;i<layer.count;i++){
          const off=i*4;
          if(layer.arrParam[off]!==4)continue;
          const x=layer.arrA[off],z=layer.arrA[off+1];
          if(Math.hypot(x-b.pos.x,z-b.pos.z)<.01||Math.hypot(x-o.x,z-o.z)<.01)all.push({x,z,color:Array.from(layer.arrColor.slice(off,off+3)),stage:layer.arrParam[off+1]});
        }
        return all;
      });
      const hex=fixture.colors[faction], linear=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
      const expected=[linear((hex>>16)&255),linear((hex>>8)&255),linear(hex&255)];
      assert.equal(colors.length,2,'Workshop and tent both have visible production capture decals');
      for(const marker of colors) {assert.equal(marker.stage,stage==='contained'?2:0);marker.color.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-5,`Faction ${faction} actual GPU instance channel${i}`));}
      const filename=`faction-${faction}-${stage}.png`;
      await page.screenshot({path:join(OUT,filename),animations:'disabled'});
      result.scenarios.push({faction,stage,viewer:(faction+1)%4,expectedHex:hex,colors,filename});
      result.checks.push(`Faction ${faction} ${stage}: workshop and scenery source color, different viewer`);
    }
    assert.deepEqual(result.errors,[]);result.completed=true;
  } catch(e){ result.error=e.stack||String(e);await page.screenshot({path:join(OUT,'failure.png')}).catch(()=>{});throw e; }
  finally {writeFileSync(join(OUT,'result.json'),JSON.stringify(result,null,2));await browser.close();server.close();}
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
