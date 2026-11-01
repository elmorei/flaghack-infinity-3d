import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LEVEL_HEIGHT, AVATAR, BUILDINGS }  from '../sim/constants';
import { newMatch } from '../sim/systems/econ/testkit';
import { spawnBuilding } from '../sim/factory';
import { BuildGhost, buildingLevelAtHit } from './buildMode';
import { Picker } from './picking';
import { BuildingView, type FrameInfo } from '../render/structures/buildingView';
import { updateAvatars } from '../sim/systems/avatars';
import { craftFlag, dropLoose } from '../sim/systems/flags';
import { atLogistics } from '../sim/systems/units/targets';
import { spawnHippie } from '../sim/factory';
import { meleeContact } from '../sim/systems/meleeImpact';

describe('elevated building presentation', () => {
  it('keeps ground and deck hit heights in the authoritative ghost level', () => {
    const { world } = newMatch('platform-view');
    const fc = world.lattice.facets.find(f=>f.thick&&!f.boundary)!;
    const y = world.collision.groundHeight(fc.cx,fc.cz), ghost = new BuildGhost();
    expect(buildingLevelAtHit(world,fc.id,y)).toBe(0);
    expect(buildingLevelAtHit(world,fc.id,y+LEVEL_HEIGHT)).toBe(1);
    expect(ghost.building(world,0,'ward',{x:fc.cx,y:y+2*LEVEL_HEIGHT,z:fc.cz})?.level).toBe(2);
    expect(ghost.ghost.valid).toBe(false);
  });
  it('positions the real building root on its deck and picks it at that height', () => {
    const { world } = newMatch('platform-view');
    world.buildings.clear(); world.hippies.clear(); world.avatars.clear(); world.flags.clear(); world.piles.clear(); world.beacons.clear();
    const b=spawnBuilding(world,'ward',0,0,1); b.level=2;
    const root=new THREE.Group();
    const frame={world,ctx:{shared:{groundOffset:()=>1.25}}} as unknown as FrameInfo;
    (BuildingView.prototype as any).place.call({root},b,frame);
    expect(root.position.y).toBeCloseTo(1.25+2*LEVEL_HEIGHT);
    const y=world.collision.groundHeight(b.pos.x,b.pos.z)+2*LEVEL_HEIGHT;
    const picker=new Picker();
    expect(picker.entityAlong(world,0,b.pos.x,y+1,b.pos.z-10,0,0,1,20,0,true)).toBe(b.id);
    expect(picker.entityAlong(world,0,b.pos.x,y-3,b.pos.z-10,0,0,1,20,0,true)).toBe(-1);
  });
  it('restocks an avatar on the same deck but not beneath the workshop', () => {
    const { world } = newMatch('platform-view'), av=world.avatarOf(0);
    const b=spawnBuilding(world,'workshop',0,0,1); b.level=2;
    for (const id of [...av.carried]) dropLoose(world,id,{x:100,y:0,z:100});
    const flag=craftFlag(world,b.id)!;
    av.pos={x:b.pos.x+BUILDINGS.workshop.radius+.1,y:world.collision.groundHeight(b.pos.x,b.pos.z),z:b.pos.z};
    updateAvatars(world,0); expect(av.carried).not.toContain(flag.id);
    world.time+=AVATAR.restockInterval+1; av.pos.y+=2*LEVEL_HEIGHT;
    updateAvatars(world,0); expect(av.carried).toContain(flag.id);
    const h=spawnHippie(world,0,{x:av.pos.x,z:av.pos.z});
    expect(atLogistics(world,h,b,2)).toBe(false);
    h.airborne={y:2*LEVEL_HEIGHT,vy:0};expect(atLogistics(world,h,b,2)).toBe(true);
  });
  it('keeps melee impact contacts on the raised building rather than below its floor', () => {
    const { world }=newMatch('platform-view');
    const b=spawnBuilding(world,'ward',1,0,1); b.level=2;
    const av=world.avatarOf(0); av.pos.y=0;
    expect(meleeContact(world,b.id,av.id)?.y).toBeCloseTo(world.collision.groundHeight(b.pos.x,b.pos.z)+2*LEVEL_HEIGHT);
  });
});
