import { beforeAll,describe,expect,it } from 'vitest';
import { createMatch } from '../setup';
import { normalizeMatch } from '../matchSettings';
import type { World } from '../world';
import type { Obstacle } from '../map/mapgen';
import { circleEnclosed,sceneryEnclosed } from './structureEnclosure';
let w:World;
beforeAll(()=>{w=createMatch({seed:'structure-footprints',difficulty:'normal',mode:'standard',humans:[0,1,2,3],match:normalizeMatch({maxSignifiers:0})});});
function all(){w.survey.facetSurvey.fill(1);w.destroyedScenery.clear();w.survey.version++;}
function prop(p:Partial<Obstacle>={}):Obstacle{return{id:999999,kind:'dome',x:20,z:20,shape:'circle',radius:12,hx:12,hz:12,yaw:0,height:8,seed:1,color:0xffffff,variant:0,...p};}
describe('whole structure Survey enclosure',()=>{
 it('accepts a fully covered circle',()=>{all();expect(sceneryEnclosed(w,prop(),0)).toBe(true);});
 it('rejects centre-only coverage',()=>{all();w.survey.facetSurvey.fill(0);const o=prop();w.survey.facetSurvey[w.lattice.facetAt(o.x,o.z)]=1;expect(sceneryEnclosed(w,o,0)).toBe(false);});
 it('requires edge facets and reads live coverage after caching',()=>{all();const o=prop();expect(sceneryEnclosed(w,o,0)).toBe(true);const at=w.lattice.facetAt(o.x+o.radius-1,o.z);expect(at).toBeGreaterThanOrEqual(0);w.survey.facetSurvey[at]=0;w.survey.version++;expect(sceneryEnclosed(w,o,0)).toBe(false);w.survey.facetSurvey[at]=1;w.survey.version++;expect(sceneryEnclosed(w,o,0)).toBe(true);});
 it('handles rotated rectangular footprints',()=>{all();const o=prop({shape:'box',hx:13,hz:2,yaw:Math.PI/4,radius:Math.hypot(13,2),kind:'shade'});expect(sceneryEnclosed(w,o,0)).toBe(true);const at=w.lattice.facetAt(o.x+Math.cos(o.yaw)*12,o.z-Math.sin(o.yaw)*12);w.survey.facetSurvey[at]=0;w.survey.version++;expect(sceneryEnclosed(w,o,0)).toBe(false);});
 it('rejects border-crossing footprints',()=>{all();expect(sceneryEnclosed(w,prop({x:w.map.half-10}),0)).toBe(false);});
 it('rejects points outside lattice',()=>{all();expect(circleEnclosed(w,10000,10000,2,0)).toBe(false);});
 it('rejects touched hole boundary and invalidates topology cache',()=>{all();const o=prop();expect(sceneryEnclosed(w,o,0)).toBe(true);const f=w.lattice.facets[w.lattice.facetAt(o.x,o.z)],old=f.neighbors[0];try{f.neighbors[0]=-1;w.lattice.version++;expect(sceneryEnclosed(w,o,0)).toBe(false);}finally{f.neighbors[0]=old;w.lattice.version++;}expect(sceneryEnclosed(w,o,0)).toBe(true);});
 it('does not reuse cache after size or position changes',()=>{all();const o=prop();expect(sceneryEnclosed(w,o,0)).toBe(true);o.radius=w.map.half;expect(sceneryEnclosed(w,o,0)).toBe(false);o.radius=12;o.x=w.map.half;expect(sceneryEnclosed(w,o,0)).toBe(false);});
 it.each(['stage','effigy','tree','rock']as const)('keeps %s immune',kind=>{all();expect(sceneryEnclosed(w,prop({kind}),0)).toBe(false);});
 it('excludes destroyed scenery',()=>{all();const o=prop();w.destroyedScenery.add(o.id);expect(sceneryEnclosed(w,o,0)).toBe(false);});
 it('requires the specific faction Survey',()=>{all();expect(sceneryEnclosed(w,prop(),1)).toBe(false);});
 it('does not combine different factions into one complete enclosure',()=>{all();const o=prop();const at=w.lattice.facetAt(o.x+o.radius-1,o.z);w.survey.facetSurvey[at]=2;w.survey.version++;expect(sceneryEnclosed(w,o,0)).toBe(false);expect(sceneryEnclosed(w,o,1)).toBe(false);});
 it('rejects invalid dimensions',()=>{all();expect(circleEnclosed(w,20,20,NaN,0)).toBe(false);expect(sceneryEnclosed(w,prop({shape:'box',hx:0}),0)).toBe(false);});
});

import { pieceEnclosed,pieceCaptureAnchor } from './structureEnclosure';
import type { Piece } from '../types';
function piece(kind:Piece['kind'],facet:number,edge=-1):Piece{return{id:999999,type:'piece',kind,faction:1,edge,facet,level:0,rampEdge:0,hp:150,maxHp:150,builtAt:0,shapeIds:[]};}
describe('modular piece enclosure',()=>{
 it.each(['floor','ramp']as const)('uses the exact %s rhombus, not its larger bounding circle',kind=>{
  all();w.survey.facetSurvey.fill(0);const f=w.lattice.facets[w.lattice.facetAt(20,20)];w.survey.facetSurvey[f.id]=1;w.survey.version++;
  const p=piece(kind,f.id);expect(pieceEnclosed(w,p,0)).toBe(true);expect(pieceEnclosed(w,p,1)).toBe(false);
  expect(pieceCaptureAnchor(w,p).pos).toEqual({x:f.cx,z:f.cz});
 });
 it('requires coverage on BOTH sides of an inset wall',()=>{
  all();const f=w.lattice.facets[w.lattice.facetAt(20,20)],e=w.lattice.edges[f.edges[0]],p=piece('wall',-1,e.id);
  expect(e.facets.length).toBe(2);expect(pieceEnclosed(w,p,0)).toBe(true);
  w.survey.facetSurvey[e.facets[1]]=0;w.survey.version++;expect(pieceEnclosed(w,p,0)).toBe(false);
  expect(pieceCaptureAnchor(w,p).radius).toBeGreaterThan(0);
 });
 it('rejects boundary and invalid pieces',()=>{
  all();const boundary=w.lattice.facets.find(f=>f.boundary)!;
  expect(pieceEnclosed(w,piece('floor',boundary.id),0)).toBe(false);
  expect(pieceEnclosed(w,piece('wall',-1,-999),0)).toBe(false);
  expect(pieceCaptureAnchor(w,piece('floor',-999)).facet).toBe(-1);
 });
});
