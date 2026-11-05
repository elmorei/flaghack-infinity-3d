import { CommandPanels } from '../ui/command';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CommandView } from './commandView';
import { Controls } from './controls';
import { MobileTouch } from './mobileTouch';
import { Session } from './session';
import { createMatch } from '../sim/setup';
import type { Command } from '../sim/commands';
import type { Input } from './input';
function fixture(rts=false) {
  vi.stubGlobal('document',{documentElement:{dataset:{deviceLayout:'mobile'}}});
  const world=createMatch({seed:'mobile-ownership-input',difficulty:'normal',mode:'standard',humans:[0],rtsFactions:rts?[0]:[]});
  const session=new Session(); session.screen='playing';session.view='command';
  const touch=new MobileTouch(); touch.enabled=true;
  const input={touch,width:390,height:844,shift:false,ctrl:false,setCursor(){}} as unknown as Input;
  const queue:Command[]=[], view=new CommandView(input,queue), camera=new PerspectiveCamera();
  const tap=(x=-10000,y=-10000)=>{touch.action={kind:'tap',x,y,startX:x,startY:y};view.frame(world,session,0,camera,null);touch.endFrame();};
  return {world,session,queue,tap,camera};
}
afterEach(()=>vi.unstubAllGlobals());
describe('mobile ownership controls',()=>{
  it('Hold position cancels selected cart and avatar movement without needing workers',()=>{
    const f=fixture(true),g=f.world.gccOf(0)!,submit=vi.fn();f.session.selection.add(g.id);
    const panel:any=Object.create(CommandPanels.prototype);Object.assign(panel,{host:{app:{world:f.world,session:f.session,submit}},mobileReturn:vi.fn()});
    panel.order('defend');expect(submit).toHaveBeenCalledWith({t:'moveGcc',faction:0,to:null});
    const other=fixture(),av=other.world.avatarOf(0);other.session.selection.add(av.id);other.session.mobileAvatarTarget={x:1,z:2};
    panel.host.app.world=other.world;panel.host.app.session=other.session;panel.order('clear');expect(other.session.mobileAvatarTarget).toBeNull();
  });
  it('does not let the selected avatar touch halo swallow an adjacent ground destination',()=>{
    const f=fixture(),av=f.world.avatarOf(0);f.world.hippies.clear();f.session.selection.add(av.id);
    f.camera.position.set(av.pos.x,av.pos.y+30,av.pos.z+30);f.camera.lookAt(av.pos.x,av.pos.y,av.pos.z);f.camera.updateMatrixWorld();
    const ground={x:av.pos.x+2,y:av.pos.y,z:av.pos.z};f.session.hover.entity=-1;f.session.hover.node=-1;f.session.hover.point=ground;
    const projected=new Vector3(ground.x,ground.y,ground.z).project(f.camera);
    f.tap((projected.x+1)*195,(1-projected.y)*422);
    expect(f.session.mobileAvatarTarget).toEqual({x:ground.x,z:ground.z});
  });
  it('selects the command center independently and sends a host-validated move command',()=>{
    const f=fixture(true),g=f.world.gccOf(0)!;
    f.session.hover.entity=g.id;f.tap();expect([...f.session.selection]).toEqual([g.id]);
    f.session.hover.entity=-1;f.session.hover.point={x:g.pos.x+4,y:0,z:g.pos.z};f.tap();
    expect(f.queue).toEqual([{t:'moveGcc',faction:0,to:{x:g.pos.x+4,z:g.pos.z}}]);
  });
  it('selects a roaming avatar and turns a ground tap into continuous input, not a teleport command',()=>{
    const f=fixture(),av=f.world.avatarOf(0);f.session.hover.entity=av.id;f.tap();
    f.session.hover.entity=-1;f.session.hover.point={x:av.pos.x+10,y:av.pos.y,z:av.pos.z};f.tap();
    expect(f.session.mobileAvatarTarget).toEqual({x:av.pos.x+10,z:av.pos.z});expect(f.queue).toEqual([]);
    const submit=vi.fn();
    const controls:any=Object.create(Controls.prototype);
    Object.assign(controls,{world:f.world,app:{world:f.world,session:f.session,submit},queue:[],input:{},inputCmd:{t:'avatarInput',faction:0,input:{moveX:0,moveZ:0,jump:false,sprint:false,yaw:0,pitch:0}},jumpLatch:false,throwQueued:false});
    controls.tick();expect(submit).toHaveBeenCalledWith(expect.objectContaining({t:'avatarInput',input:expect.objectContaining({moveX:1,moveZ:0})}));
    av.pos.x+=10;submit.mockClear();controls.tick();
    expect(f.session.mobileAvatarTarget).toBeNull();expect(submit).toHaveBeenCalledWith(expect.objectContaining({input:expect.objectContaining({moveX:0,moveZ:0})}));
  });
});
