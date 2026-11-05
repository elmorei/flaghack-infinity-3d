'use strict';
/** Real touch UI checks with explicit offline fixture staging. No fake multiplayer transport. */
const assert = require('node:assert/strict');
async function verifyMobileCampControls(page, { capture = async () => {} } = {}) {
  const result = { offlineFixture: true, realSocketAuthority: 'server/bossTakeover.test.ts + server/rtsMode.test.ts', checks: [] };
  const tap = async locator => { await locator.scrollIntoViewIfNeeded(); await locator.tap({ noWaitAfter: true }); };
  const project = pos => page.evaluate(p => {
    const a=window.flaghack,c=a.renderer.camera;c.updateMatrixWorld();
    const mul=(m,v)=>[0,1,2,3].map(r=>m[r]*v[0]+m[4+r]*v[1]+m[8+r]*v[2]+m[12+r]*v[3]);
    const y=p.y??a.world.collision.groundHeight(p.x,p.z),v=mul(c.projectionMatrix.elements,mul(c.matrixWorldInverse.elements,[p.x,y,p.z,1]));
    return{x:(v[0]/v[3]+1)*innerWidth/2,y:(1-v[1]/v[3])*innerHeight/2};
  },pos);
  const center = async p => { await page.evaluate(p=>{const s=window.flaghack.session;s.camera.cmdX=p.x;s.camera.cmdZ=p.z;},p);await page.waitForTimeout(400); };
  const touchPoint=async p=>{const point=await project(p);await page.touchscreen.tap(point.x,point.y);};
  await page.evaluate(()=>{
    const a=window.flaghack;a.startMatch({seed:'mobile-camp-native-qa',humans:[0],rtsFactions:[0],match:{...a.session.settings.match,active:[0,1,2,3],bossMode:false,days:3}});
    a.ai.clear(); a.world.hippies.clear();
    const f=a.world.factions[0];f.ritual=7;f.chakras.hoist=1;f.chakras.canton=1;f.chakras.finial=1;
  });
  await page.waitForFunction(()=>{const a=window.flaghack;return a.session.screen==='playing'&&a.session.view==='command'&&a.ui.world===a.world;});
  const cart=await page.evaluate(()=>{
    const w=window.flaghack.world,g=w.gccOf(0),h=w.hearthOf(0),dx=g.pos.x-h.pos.x,dz=g.pos.z-h.pos.z,d=Math.hypot(dx,dz);
    return{id:g.id,x:g.pos.x,z:g.pos.z,to:{x:g.pos.x+dx/d*2,z:g.pos.z+dz/d*2}};
  });
  await center(cart);await touchPoint({...cart,y:await page.evaluate(p=>window.flaghack.world.collision.groundHeight(p.x,p.z)+.7,cart)});
  await page.waitForFunction(id=>window.flaghack.session.selection.has(id),cart.id);
  await touchPoint(cart.to);
  await page.waitForFunction(p=>{const g=window.flaghack.world.gccOf(0);return Math.hypot(g.pos.x-p.x,g.pos.z-p.z)>.5;},cart);
  result.checks.push('Independent GCC selection and movement through real taps');await capture('gcc-moving');
  await tap(page.locator('.mc-selected').getByRole('button',{name:'Orders',exact:true}));
  await tap(page.locator('.sel-orders').getByRole('button',{name:'Hold position',exact:true}));
  await page.waitForFunction(()=>window.flaghack.world.gccOf(0).gcc.moveTarget===null);
  result.checks.push('Orders → Hold position stops the independently selected cart');
  const openSettings=async()=>{
    await tap(page.locator('.mc-top').getByRole('button',{name:'Menu',exact:true}));await tap(page.locator('.mc-tabs').getByRole('button',{name:'Settings',exact:true}));
  };
  await openSettings();await tap(page.getByRole('button',{name:/Switch to .*Avatar/}));
  await page.waitForFunction(()=>window.flaghack.world.factions[0].controlMode==='avatar');
  const avatar=await page.evaluate(()=>{const a=window.flaghack.world.avatarOf(0);return{id:a.id,x:a.pos.x,y:a.pos.y+1,z:a.pos.z};});
  await center(avatar);await touchPoint(avatar);
  await page.waitForFunction(id=>window.flaghack.session.selection.has(id),avatar.id);
  await touchPoint({x:avatar.x+3,z:avatar.z});
  await page.waitForFunction(p=>{const a=window.flaghack.world.avatarOf(0);return Math.hypot(a.pos.x-p.x,a.pos.z-p.z)>.5;},avatar);
  result.checks.push('Avatar switch and touch-to-walk use real continuous input');await capture('avatar-moving');
  // Halt with the actual selection menu, then put an ordinary loose Flag within reach.
  await tap(page.locator('.mc-selected').getByRole('button',{name:'Orders',exact:true}));
  await tap(page.locator('.sel-orders').getByRole('button',{name:'Hold position',exact:true}));
  const loose=await page.evaluate(()=>{const w=window.flaghack.world,a=w.avatarOf(0),p={x:a.pos.x+1.6,y:w.collision.groundHeight(a.pos.x+1.6,a.pos.z),z:a.pos.z};const f=window.fh.factory.spawnFlag(w,{state:'loose',owner:0,pos:p});return{id:f.id,...p};});
  await touchPoint(loose);
  await page.waitForFunction(id=>{const w=window.flaghack.world;return w.flags.get(id)?.holder===w.avatarOf(0)?.id;},loose.id);
  result.checks.push('Nearby loose Flag tap executes the real Avatar pull interaction');await capture('avatar-interaction');
  // Set an incompatible paid level in the fixture, then exercise the actual mode button.
  await page.evaluate(()=>{const f=window.flaghack.world.factions[0];f.ritual=7;f.chakras.hoist=1;});
  await openSettings();await tap(page.getByRole('button',{name:/Switch to .*RTS/}));
  await page.waitForFunction(()=>window.flaghack.world.factions[0].controlMode==='rts');
  const refund=await page.evaluate(()=>{const w=window.flaghack.world,f=w.factions[0];return{ritual:f.ritual,hoist:f.chakras.hoist,canton:f.chakras.canton,finial:f.chakras.finial,body:!!w.avatarOf(0)};});
  assert.ok(refund.ritual>=37);assert.equal(refund.hoist,0);assert.equal(refund.canton,1);assert.equal(refund.finial,1);assert.equal(refund.body,false);
  result.checks.push('Mode change refunds removed Hoist upgrade and preserves shared AOE unlocks');
  await page.evaluate(()=>{const a=window.flaghack;a.world.factions[0].alive=false;});
  await page.getByRole('dialog',{name:'Choose a camp'}).waitFor();
  const choices=page.locator('.seat-row:visible .sr-take');assert.ok(await choices.count()>0);
  await tap(choices.first());await tap(page.locator('.seats-confirm').getByRole('button',{name:'Take over',exact:true}));
  await page.waitForFunction(()=>window.flaghack.session.playerFaction!==0);
  result.checks.push('Eliminated local player chooses an existing NPC camp through touch UI');await capture('camp-takeover');
  // Newcomer chooser presentation is staged independently of network authority. Real socket
  // race, rejection and reconnect behavior is tested in server/bossTakeover.test.ts.
  await page.evaluate(()=>{
    const a=window.flaghack,w=a.world,s=a.session;
    s.spectator=true;s.campChoiceOpen=false;s.screen='playing';
    const seats=[0,1,2,3].map(faction=>({faction,playerId:w.options.humans.includes(faction)?'existing-'+faction:null}));
    const net={status:'match',error:null,version:1,serverName:'Staged newcomer presentation',lobby:{serverName:'QA',phase:'playing',leaderId:'existing-1',settings:{difficulty:'normal',seed:'qa'},seats,players:[],match:{time:w.time,winner:null}},setupSettings:null,settingsPending:false,settingsError:null,startPending:false,playerId:'newcomer',seat:null,isLeader:false,chat:[],ping:0,reconnecting:false,notices:[],pendingBossTakeover:null,bossTakeoverError:null,setSeat:seat=>{window.__qaNewcomerRequest=seat;},setControlMode(){},requestBossTakeover(){},setReady(){},setSettings(){},start(){},backToLobby(){},sendChat(){},leave(){}};
    Object.defineProperty(a,'net',{configurable:true,get:()=>net});window.__qaNewcomerRequest=null;
  });
  try {
    await tap(page.locator('.spectate:visible').getByRole('button',{name:'Play a camp',exact:true}));
    await page.getByRole('dialog',{name:'Choose a camp'}).waitFor();
    const rows=page.locator('.seat-row:visible .sr-take');assert.ok(await rows.count()>0);
    await tap(rows.first());await capture('newcomer-camp-choice');
    await tap(page.locator('.seats-confirm').getByRole('button',{name:'Take over',exact:true}));
    await page.waitForFunction(()=>window.__qaNewcomerRequest!==null);
    result.newcomerUi='Staged NetSession presentation only; real socket authority verified separately';
    result.checks.push('Newcomer spectator can choose a camp and submit its seat request');
  } finally { await page.evaluate(()=>{const a=window.flaghack;delete a.net;a.session.spectator=false;a.session.campChoiceOpen=false;}); }
  return result;
}
module.exports={verifyMobileCampControls};
