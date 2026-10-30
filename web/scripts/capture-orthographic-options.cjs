'use strict';
/** Actual rendered match + trusted browser touch events. Deterministic local staging only;
 * no replacement input handlers or simulated command submissions. Not physical-phone QA. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, join, extname } = require('node:path');
const { chromium } = require('playwright');
const DIST = resolve(__dirname, '../dist');
const OUT = resolve(__dirname, '../host-release/orthographic-comparison');
const PROJECT = '/flaghack-infinity-3d/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!path.startsWith(PROJECT)) { res.writeHead(404); res.end(); return; }
  const relative = decodeURIComponent(path.slice(PROJECT.length)) || 'index.html';
  const file = resolve(DIST, relative);
  if (!file.startsWith(DIST + '/')) { res.writeHead(404); res.end(); return; }
  let body; try { body = readFileSync(file); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
});
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
async function main() {
  mkdirSync(OUT, { recursive: true });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}${PROJECT}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: false, chromiumSandbox: true });
  const results = { completed: false, errors: [], options: [], fixedWorld: true, physicalDeviceTest: false };
  try {
    for (const viewport of [{width:390,height:844}, {width:844,height:390}]) {
      const context = await browser.newContext({ viewport, userAgent: MOBILE_UA, hasTouch:true, isMobile:true, deviceScaleFactor:2 });
      const page=await context.newPage();
      page.on('pageerror', e=>results.errors.push(e.message));
      await page.goto(url, {waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.querySelector('#startup[data-ready="true"]') || window.flaghack && !window.flaghack.startupPending,null,{timeout:180000});
      if(await page.locator('#startup').count()) await page.getByRole('button',{name:'Skip',exact:true}).click({noWaitAfter:true});
      await page.locator('#startup').waitFor({state:'detached'});
      await page.evaluate(()=>{
        const a=window.flaghack;
        a.startMatch({seed:'orthographic-angle-options',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0],bossMode:false,days:3}});
      });
      await page.waitForFunction(()=>window.flaghack.session.screen==='playing' && window.flaghack.session.view==='command');
      await page.waitForFunction(()=>window.flaghack.renderer.camera.isOrthographicCamera===true);
      await page.waitForTimeout(1000);
      await page.evaluate(()=>{
        const a=window.flaghack,w=a.world,s=a.session;
        // Preserve identical scene and time across options, using the production renderer.
        a.sim.step=()=>{};
        const render=a.renderer.render.bind(a.renderer);
        a.renderer.render=dt=>{ if(a.renderer.ctx) a.renderer.ctx.time=12-dt; return render(dt); };
        const altar=[...w.buildings.values()].find(b=>b.faction===0 && b.kind==='gcc') || [...w.buildings.values()].find(b=>b.faction===0);
        const x=altar?.pos?.x ?? -90,z=altar?.pos?.z ?? 90;
        s.camera.cmdX=x+3;s.camera.cmdZ=z+3;s.mobileMode='build';
        for(const [i,dx,dz] of [[0,4,5],[1,7,3],[2,2,8],[3,-2,5]]) {
          const h=window.fh.factory.spawnHippie(w,0,{x:x+dx,z:z+dz});
          h.order={kind:'defend',at:{x:x+dx,z:z+dz}};
        }
        window.__orthoScene={x,z,time:w.time};
      });
      for(const angle of [45,60,75]) {
        await page.evaluate(angle=>{document.documentElement.dataset.mobileCameraElevation=String(angle)},angle);
        await page.waitForTimeout(900);
        const snapshot=await page.evaluate(()=>{
          const a=window.flaghack,c=a.renderer.camera;
          return {isOrthographic:c.isOrthographicCamera,position:c.position.toArray(),projection:c.projectionMatrix.toArray(),left:c.left,right:c.right,top:c.top,bottom:c.bottom,scene:window.__orthoScene,time:a.world.time,pose:{...a.rig?.pose},cameraType:c.type};
        });
        assert.equal(snapshot.isOrthographic,true,'Actual orthographic camera required');
        assert.equal(snapshot.time,snapshot.scene.time,'Comparison simulation remains identical');
        const file=`${viewport.width<viewport.height?'portrait':'landscape'}-${angle}.png`;
        await page.screenshot({path:join(OUT,file),animations:'disabled'});
        results.options.push({angle,viewport,file,...snapshot});
        console.log('Captured '+file);
      }
      await context.close();
    }
    assert.deepEqual(results.errors,[]);results.completed=true;
  } finally {
    writeFileSync(join(OUT,'results.json'),JSON.stringify(results,null,2));
    await browser.close();server.close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;server.close()});
