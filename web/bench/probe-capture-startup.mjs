/** Small diagnostic only: observe startup requests without video capture or network overrides. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out=resolve('startup-network-probe');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true});
const result={responses:[],failures:[],console:[],pageErrors:[],ready:false};
try {
 const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
 page.on('response',r=>result.responses.push({url:r.url(),status:r.status(),resource:r.request().resourceType()}));
 page.on('requestfailed',r=>result.failures.push({url:r.url(),resource:r.resourceType(),error:r.failure()?.errorText}));
 page.on('console',m=>{if(m.type()==='error')result.console.push({text:m.text(),location:m.location()});});
 page.on('pageerror',e=>result.pageErrors.push(String(e)));
 await page.goto(process.env.CAPTURE_URL||'http://127.0.0.1:5173/');
 await page.waitForFunction(()=>!!window.flaghack&&!!window.fh,null,{timeout:60000});
 result.ready=true;
 await page.waitForTimeout(3000);
 result.failedResponses=result.responses.filter(r=>r.status>=400);
 result.optionalHostProbe=result.failedResponses.filter(r=>new URL(r.url).pathname==='/api/info');
 result.otherFailedResponses=result.failedResponses.filter(r=>new URL(r.url).pathname!=='/api/info');
 console.log(JSON.stringify({ready:result.ready,failedResponses:result.failedResponses,failures:result.failures,pageErrors:result.pageErrors,console:result.console},null,2));
} finally {
 await writeFile(resolve(out,'startup-network.json'),JSON.stringify(result,null,2));
 await browser.close();
}
