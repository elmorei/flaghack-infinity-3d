import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CommandView } from './commandView';
import { MobileTouch } from './mobileTouch';
import { Session } from './session';
import type { Input } from './input';
import type { Command } from '../sim/commands';
import { newMatch } from '../sim/systems/econ/testkit';
function setup() {
  vi.stubGlobal('document', { documentElement: { dataset: { deviceLayout: 'mobile' } } });
  const { world } = newMatch('mobile-touch-command');
  const s = new Session(); s.screen = 'playing'; s.view = 'command'; s.viewBlend = 1;
  const touch = new MobileTouch(); touch.enabled = true;
  const input = { touch, width: 390, height: 844, shift: false, ctrl: false, setCursor() {} } as unknown as Input;
  const queue: Command[] = [], view = new CommandView(input,queue), camera = new PerspectiveCamera(50,390/844,.1,1000);
  const own = [...world.hippies.values()].find(h=>h.faction===0)!;
  camera.position.set(own.pos.x,world.collision.groundHeight(own.pos.x,own.pos.z)+50,own.pos.z+50);
  camera.lookAt(own.pos.x,world.collision.groundHeight(own.pos.x,own.pos.z)+1,own.pos.z); camera.updateMatrixWorld();
  const project = (x:number,y:number,z:number) => { const p = new Vector3(x,y,z).project(camera); return {x:(p.x+1)*195,y:(1-p.y)*422}; };
  const action = (kind:'tap'|'hold'|'drag',x=195,y=422) => { touch.action={kind,x,y,startX:x-50,startY:y-50}; };
  const frame = (ghost:any=null) => {view.frame(world,s,0,camera,ghost);touch.endFrame();};
  return {world,s,touch,input,queue,view,camera,own,project,action,frame};
}
afterEach(()=>vi.unstubAllGlobals());
describe('production mobile command actions',()=>{
  it('tap a friendly unit in Plan selects it and switches to Degen without ordering',()=>{
    const f=setup(); f.s.mobileMode='build'; f.s.planTool='node';
    const p=f.project(f.own.pos.x,f.world.collision.groundHeight(f.own.pos.x,f.own.pos.z)+1,f.own.pos.z);
    f.s.hover.entity=f.own.id;f.action('tap',p.x,p.y);f.frame();
    expect(f.s.mobileMode).toBe('units');expect([...f.s.selection]).toEqual([f.own.id]);expect(f.queue).toEqual([]);
  });
  it('contextual target tap recruits a neutral while preserving friendly selection',()=>{
    const f=setup(); const neutral=[...f.world.hippies.values()].find(h=>h.faction===-1)!;
    f.s.selection.add(f.own.id);f.s.hover.entity=neutral.id;f.s.hover.point={x:neutral.pos.x,y:0,z:neutral.pos.z};
    f.action('tap',-10000,-10000);f.frame();
    expect(f.queue).toEqual([{t:'order',faction:0,hippies:[f.own.id],order:{kind:'recruit',target:neutral.id}}]);
    expect(f.s.selection.has(f.own.id)).toBe(true);
  });
  it('pan release cannot change mode, selection, plan or issue an order',()=>{
    const f=setup(); f.s.selection.add(f.own.id);f.s.hover.entity=f.own.id;f.action('drag');f.frame();
    expect(f.queue).toEqual([]);expect(f.s.mobileMode).toBe('units');expect(f.s.selection.has(f.own.id)).toBe(true);
  });
  it('node hold only switches mode; later Plan tap toggles the original node target',()=>{
    const f=setup();const n=f.world.lattice.nodes.find(n=>!n.blocked)!;
    f.s.hover.node=n.id; const p=f.project(n.x,f.world.collision.groundHeight(n.x,n.z),n.z);
    f.action('hold',p.x,p.y);f.frame();expect(f.s.mobileMode).toBe('build');expect(f.s.planTool).toBe('node');expect(f.queue).toEqual([]);
    f.world.hippies.clear();f.world.avatars.clear();f.s.hover.entity=-1;f.action('tap',p.x,p.y);f.frame();
    expect(f.queue).toEqual([{t:'plan',faction:0,op:'add',nodes:[n.id]}]);
    f.queue.length=0;f.world.factions[0].plan.add(n.id);f.action('tap',p.x,p.y);f.frame();
    expect(f.queue).toEqual([{t:'plan',faction:0,op:'remove',nodes:[n.id]}]);
  });
  it('holding a surveyed thick-space center opens the picker without placing anything',()=>{
    const f=setup();const facet=f.world.lattice.facets.find(fc=>fc.thick&&!fc.boundary&&f.world.inSurvey(fc.id,0))!;
    expect(facet).toBeDefined();f.s.hover.facet=facet.id;f.s.hover.node=-1;
    const p=f.project(facet.cx,f.world.collision.groundHeight(facet.cx,facet.cz),facet.cz);
    f.action('hold',p.x,p.y);f.frame();expect(f.s.mobileMode).toBe('build');expect(f.s.mobileMenu).toBe('build');
    expect(f.s.mobileBuildFacet).toBe(facet.id);expect(f.queue).toEqual([]);
  });
  it('open menu cancels touch and blocks pending build confirmation',()=>{
    const f=setup();f.s.mobileMenu='build';f.s.mobileBuildFacet=5;f.s.mobileBuildConfirm=true;f.s.tool='building';
    f.touch.down(1,100,100,0);f.touch.poll(1000);f.frame({valid:true,facet:5});
    expect(f.queue).toEqual([]);expect(f.touch.active).toBe(false);expect(f.s.mobileBuildConfirm).toBe(false);
  });
  it('building requires explicit matching valid confirmation and consumes it once',()=>{
    const f=setup();f.s.mobileBuildFacet=5;f.s.tool='building';f.s.buildingKind='workshop';f.action('tap',-1000,-1000);f.frame({valid:true,facet:5});expect(f.queue).toEqual([]);
    f.s.mobileBuildConfirm=true;f.frame({valid:true,facet:6});expect(f.queue).toEqual([]);
    f.s.mobileBuildConfirm=true;f.frame({valid:true,facet:5});f.frame({valid:true,facet:5});
    expect(f.queue).toEqual([{t:'placeBuilding',faction:0,kind:'workshop',facet:5}]);expect(f.s.mobileBuildFacet).toBe(-1);
  });
});
