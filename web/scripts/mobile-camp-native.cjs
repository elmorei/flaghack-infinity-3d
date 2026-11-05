'use strict';
/** Real touch UI checks. Offline authority is real; network pending/rejection presentation is explicitly staged. */
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
  const assertHeld=async(kind)=>{
    // Allow the already-submitted frame to settle, then observe actual position across sim ticks.
    const begin=await page.evaluate(()=>window.flaghack.world.time);
    await page.waitForFunction(t=>window.flaghack.world.time>=t+.15,begin);
    const before=await page.evaluate(kind=>{const w=window.flaghack.world,e=kind==='cart'?w.gccOf(0):w.avatarOf(0);return{time:w.time,x:e.pos.x,z:e.pos.z};},kind);
    await page.waitForFunction(t=>window.flaghack.world.time>=t+.6,before.time);
    const after=await page.evaluate(kind=>{const w=window.flaghack.world,e=kind==='cart'?w.gccOf(0):w.avatarOf(0);return{x:e.pos.x,z:e.pos.z};},kind);
    assert.ok(Math.hypot(after.x-before.x,after.z-before.z)<.05,`${kind} still displaced after Hold: ${JSON.stringify({before,after})}`);
  };
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
  await assertHeld('cart');
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
  await page.waitForFunction(()=>window.flaghack.session.mobileAvatarTarget===null);
  await assertHeld('avatar');
  result.checks.push('Avatar Hold prevents subsequent displacement across real simulation ticks');
  const loose=await page.evaluate(()=>{const w=window.flaghack.world,a=w.avatarOf(0),p={x:a.pos.x+1.6,y:w.collision.groundHeight(a.pos.x+1.6,a.pos.z),z:a.pos.z};const f=window.fh.factory.spawnFlag(w,{state:'loose',owner:0,pos:p});return{id:f.id,...p};});
  await touchPoint(loose);
  await page.waitForFunction(id=>{const w=window.flaghack.world;return w.flags.get(id)?.holder===w.avatarOf(0)?.id;},loose.id);
  result.checks.push('Nearby loose Flag tap executes the real Avatar pull interaction');await capture('avatar-interaction');
  // Set an incompatible paid level in the fixture, then exercise the actual mode button.
  const income=await page.evaluate(()=>{const w=window.flaghack.world,f=w.factions[0];f.ritual=7;f.chakras.hoist=1;f.drugActive.saffron=0;return{hippies:w.hippies.size,saffronActive:f.drugActive.saffron>w.time,ownedCrystals:[...w.crystals.values()].filter(c=>c.faction===0).length};});
  assert.equal(income.hippies,0);assert.equal(income.saffronActive,false);assert.equal(income.ownedCrystals,0);
  await openSettings();await tap(page.getByRole('button',{name:/Switch to .*RTS/}));
  await page.waitForFunction(()=>window.flaghack.world.factions[0].controlMode==='rts');
  const refund=await page.evaluate(()=>{const w=window.flaghack.world,f=w.factions[0];return{ritual:f.ritual,hoist:f.chakras.hoist,canton:f.chakras.canton,finial:f.chakras.finial,body:!!w.avatarOf(0)};});
  assert.ok(Math.abs(refund.ritual-37)<1e-6,`Expected exact 30 Ritual refund: ${JSON.stringify(refund)}`);assert.equal(refund.hoist,0);assert.equal(refund.canton,1);assert.equal(refund.finial,1);assert.equal(refund.body,false);
  result.checks.push('Mode change refunds removed Hoist upgrade and preserves shared AOE unlocks');
  await page.evaluate(()=>{const a=window.flaghack;a.world.factions[0].alive=false;});
  await page.getByRole('dialog',{name:'Choose a camp'}).waitFor();
  const choices=page.locator('.seat-row:visible .sr-take');assert.ok(await choices.count()>0);
  await tap(choices.first());
  await tap(page.locator('.sc-modes').getByRole('button',{name:'Regular (Avatar)',exact:true}));
  await tap(page.locator('.seats-confirm').getByRole('button',{name:'Take over',exact:true}));
  await page.waitForFunction(()=>window.flaghack.session.playerFaction!==0);
  assert.equal(await page.evaluate(()=>{const a=window.flaghack;return a.world.factions[a.session.playerFaction].controlMode;}),'avatar');
  result.checks.push('Eliminated local player chooses an existing NPC camp in Avatar mode through touch UI');await capture('camp-takeover');
  // Newcomer chooser presentation is staged independently of network authority. Real socket
  // race, rejection and reconnect behavior is tested in server/bossTakeover.test.ts.
  const staged=await page.evaluate(()=>{
    const a=window.flaghack,w=a.world,s=a.session;
    window.__qaOriginalCampAlive=w.factions[s.playerFaction].alive;
    s.spectator=true;s.campChoiceOpen=false;s.screen='playing';
    const seats=[0,1,2,3].map(faction=>({faction,playerId:w.options.humans.includes(faction)?'existing-'+faction:null}));
    for(const seat of seats) if(seat.playerId===null){const f=w.factions[seat.faction];f.chakras.hoist=1;f.ritual=7;f.drugActive.saffron=0;}
    const net={status:'match',error:null,version:1,serverName:'Staged newcomer presentation',lobby:{serverName:'QA',phase:'playing',leaderId:'existing-1',settings:{difficulty:'normal',seed:'qa'},seats,players:[{id:'newcomer',controlMode:'rts'}],match:{time:w.time,winner:null}},setupSettings:null,settingsPending:false,settingsError:null,startPending:false,playerId:'newcomer',seat:null,isLeader:false,chat:[],ping:0,reconnecting:false,notices:[],pendingBossTakeover:null,bossTakeoverError:null,setSeat(){throw Error('Newcomer must use acknowledged takeover');},setControlMode(){},requestBossTakeover(){},setReady(){},setSettings(){},start(){},backToLobby(){},sendChat(){},leave(){}};
    Object.defineProperty(a,'net',{configurable:true,get:()=>net});window.__qaNewcomerRequests=[];
    Object.defineProperty(a,'takeBossCamp',{configurable:true,value:(seat,mode)=>{
      if(net.pendingBossTakeover!==null)return false;
      window.__qaNewcomerRequests.push({seat,mode});net.pendingBossTakeover=seat;net.bossTakeoverError=null;net.version++;return true;
    }});
    const candidate=seats.find(slot=>slot.playerId===null&&w.factions[slot.faction].alive&&w.hearthOf(slot.faction));
    if(!candidate)throw Error('No free camp for staged mode/refund presentation');
    return{currentMode:w.factions[candidate.faction].controlMode};
  });
  const currentMode=staged.currentMode, changedMode=currentMode==='avatar'?'rts':'avatar';
  const modeLabel=mode=>mode==='avatar'?'Regular (Avatar)':'Degen (RTS)';
  try {
    await tap(page.locator('.spectate:visible').getByRole('button',{name:'Play a camp',exact:true}));
    await page.getByRole('dialog',{name:'Choose a camp'}).waitFor();
    const rows=page.locator('.seat-row:visible .sr-take');assert.ok(await rows.count()>0);
    await tap(rows.first());
    await tap(page.locator('.sc-modes').getByRole('button',{name:modeLabel(changedMode),exact:true}));
    assert.match(await page.locator('.sc-refund').innerText(),/Refund: 30 Ritual/);
    await capture('newcomer-camp-choice');
    await tap(page.locator('.seats-confirm').getByRole('button',{name:'Take over',exact:true}));
    await page.waitForFunction(()=>window.__qaNewcomerRequests.length===1);
    const asking=page.locator('.seats-confirm').getByRole('button',{name:'Asking the host…',exact:true});
    const otherMode=page.locator('.sc-modes').getByRole('button',{name:modeLabel(currentMode),exact:true});
    const back=page.locator('.seats-confirm').getByRole('button',{name:'Back',exact:true});
    assert.equal(await asking.isDisabled(),true);assert.equal(await otherMode.isDisabled(),true);assert.equal(await back.isDisabled(),true);
    // Raw touches exercise disabled controls without Playwright waiting for them to enable.
    for(const control of [asking,otherMode,back]){await control.scrollIntoViewIfNeeded();const box=await control.boundingBox();assert.ok(box);await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);}
    assert.deepEqual(await page.evaluate(()=>window.__qaNewcomerRequests.map(r=>r.mode)),[changedMode]);
    assert.equal(await page.locator('.sc-modes').getByRole('button',{name:modeLabel(changedMode),exact:true}).getAttribute('aria-pressed'),'true');
    await capture('newcomer-camp-pending');
    const rejection='That camp is reserved for another player.';
    await page.evaluate(reason=>{const net=window.flaghack.net;net.pendingBossTakeover=null;net.bossTakeoverError=reason;net.version++;},rejection);
    await page.waitForFunction(reason=>document.querySelector('.seats-note')?.textContent===reason,rejection);
    await capture('newcomer-camp-rejected');
    await tap(page.locator('.seat-row:visible .sr-take').first());
    await tap(page.locator('.sc-modes').getByRole('button',{name:modeLabel(currentMode),exact:true}));
    assert.match(await page.locator('.sc-refund').innerText(),/Refund: 0 Ritual/);
    assert.equal(await back.isDisabled(),false);await tap(back);
    await tap(page.locator('.seat-row:visible .sr-take').first());
    await tap(page.locator('.seats-confirm').getByRole('button',{name:'Take over',exact:true}));
    await page.waitForFunction(()=>window.__qaNewcomerRequests.length===2);
    assert.deepEqual(await page.evaluate(()=>window.__qaNewcomerRequests.map(r=>r.mode)),[changedMode,currentMode]);
    // Repeat the lock/rejection presentation for an eliminated seated player, not just a newcomer.
    await page.evaluate(reason=>{const net=window.flaghack.net;net.pendingBossTakeover=null;net.bossTakeoverError=reason;net.version++;},rejection);
    await page.waitForFunction(reason=>document.querySelector('.seats-note')?.textContent===reason,rejection);
    await tap(page.locator('button.seats-watch'));
    await page.evaluate(()=>{const a=window.flaghack;a.session.spectator=false;a.net.seat=a.session.playerFaction;a.world.factions[a.session.playerFaction].alive=false;});
    await page.getByRole('dialog',{name:'Choose a camp'}).waitFor();
    await tap(page.locator('.seat-row:visible .sr-take').first());
    await tap(page.locator('.sc-modes').getByRole('button',{name:modeLabel(changedMode),exact:true}));
    assert.match(await page.locator('.sc-refund').innerText(),/Refund: 30 Ritual/);
    await tap(page.locator('.seats-confirm').getByRole('button',{name:'Take over',exact:true}));
    await page.waitForFunction(()=>window.__qaNewcomerRequests.length===3);
    assert.equal(await asking.isDisabled(),true);assert.equal(await otherMode.isDisabled(),true);assert.equal(await back.isDisabled(),true);
    for(const control of [asking,otherMode,back]){await control.scrollIntoViewIfNeeded();const box=await control.boundingBox();assert.ok(box);await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);}
    assert.deepEqual(await page.evaluate(()=>window.__qaNewcomerRequests.map(r=>r.mode)),[changedMode,currentMode,changedMode]);
    await capture('eliminated-camp-pending');
    await page.evaluate(reason=>{const net=window.flaghack.net;net.pendingBossTakeover=null;net.bossTakeoverError=reason;net.version++;},rejection);
    await page.waitForFunction(reason=>document.querySelector('.seats-note')?.textContent===reason,rejection);
    await capture('eliminated-camp-rejected');
    await tap(page.locator('.seat-row:visible .sr-take').first());
    await tap(page.locator('.sc-modes').getByRole('button',{name:modeLabel(currentMode),exact:true}));
    assert.equal(await back.isDisabled(),false);await tap(back);
    await tap(page.locator('.seat-row:visible .sr-take').first());
    await tap(page.locator('.seats-confirm').getByRole('button',{name:'Take over',exact:true}));
    await page.waitForFunction(()=>window.__qaNewcomerRequests.length===4);
    assert.deepEqual(await page.evaluate(()=>window.__qaNewcomerRequests.map(r=>r.mode)),[changedMode,currentMode,changedMode,currentMode]);
    result.newcomerUi='Staged NetSession and request capture only; real socket authority verified separately';
    result.checks.push('Newcomer and eliminated players choose mode with exact refund preview; pending disables duplicate/mode/Back, rejection shows host reason and permits Back/retry');
  } finally { await page.evaluate(()=>{const a=window.flaghack;delete a.net;delete a.takeBossCamp;a.world.factions[a.session.playerFaction].alive=window.__qaOriginalCampAlive;a.session.spectator=false;a.session.campChoiceOpen=false;delete window.__qaNewcomerRequests;delete window.__qaOriginalCampAlive;}); }
  return result;
}
module.exports={verifyMobileCampControls};
