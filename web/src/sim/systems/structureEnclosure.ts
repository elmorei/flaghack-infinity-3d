/** Full-footprint Survey eligibility; a covered centre alone cannot capture a large prop. */
import type { Obstacle } from '../map/mapgen';
import { PIECE } from '../constants';
import { wallSegment } from './econ/pieceGeometry';
import type { FactionId, Piece } from '../types';
import type { World } from '../world';
const EPS = 1e-7;
interface Footprint { x:number; z:number; radius:number; shape:'circle'|'box'; hx:number; hz:number; yaw:number }
interface Coverage { valid:boolean; facets:number[]; surveyVersion:number; owners:number }
const caches = new WeakMap<World,{ topology:number; entries:Map<string,Coverage> }>();
export function sceneryCaptureEligible(o:Obstacle):boolean {
  return o.kind==='tent'||o.kind==='dome'||o.kind==='shade'||o.kind==='porta'||o.kind==='art'||o.kind==='car';
}
function circleTouches(xs:number[],zs:number[],radius:number):boolean {
  let inside=true;
  for(let i=0;i<xs.length;i++) {
    const j=(i+1)%xs.length,dx=xs[j]-xs[i],dz=zs[j]-zs[i];
    if(dx*-zs[i]-dz*-xs[i]<-EPS) inside=false;
    const len=dx*dx+dz*dz,t=len>0?Math.max(0,Math.min(1,-(xs[i]*dx+zs[i]*dz)/len)):0;
    const x=xs[i]+t*dx,z=zs[i]+t*dz;
    if(x*x+z*z<=radius*radius+EPS) return true;
  }
  return inside;
}
/** SAT uses box axes and all facet edge normals in box-local coordinates. */
function boxTouches(xs:number[],zs:number[],hx:number,hz:number):boolean {
  const separated=(ax:number,az:number):boolean=>{
    let lo=Infinity,hi=-Infinity;
    for(let i=0;i<xs.length;i++){const p=xs[i]*ax+zs[i]*az;lo=Math.min(lo,p);hi=Math.max(hi,p);}
    const extent=hx*Math.abs(ax)+hz*Math.abs(az);return lo>extent+EPS||hi<-extent-EPS;
  };
  if(separated(1,0)||separated(0,1))return false;
  for(let i=0;i<xs.length;i++){const j=(i+1)%xs.length;if(separated(-(zs[j]-zs[i]),xs[j]-xs[i]))return false;}
  return true;
}
function coverage(w:World,p:Footprint):Coverage {
  const lat=w.lattice;
  let c=caches.get(w);
  if(!c||c.topology!==lat.version){c={topology:lat.version,entries:new Map()};caches.set(w,c);}
  const key=`${p.shape}:${p.x}:${p.z}:${p.radius}:${p.hx}:${p.hz}:${p.yaw}:${w.map.half}`;
  const prior=c.entries.get(key);if(prior)return prior;
  const result:Coverage={valid:false,facets:[],surveyVersion:-1,owners:0};c.entries.set(key,result);
  if(![p.x,p.z,p.radius,p.hx,p.hz,p.yaw].every(Number.isFinite)||p.radius<=0||
    (p.shape==='box'&&(p.hx<=0||p.hz<=0))||lat.facetAt(p.x,p.z)<0)return result;
  const cosine=Math.cos(p.yaw),sine=Math.sin(p.yaw);
  const ex=p.shape==='circle'?p.radius:Math.abs(cosine)*p.hx+Math.abs(sine)*p.hz;
  const ez=p.shape==='circle'?p.radius:Math.abs(sine)*p.hx+Math.abs(cosine)*p.hz;
  if(Math.abs(p.x)+ex>=w.map.half-EPS||Math.abs(p.z)+ez>=w.map.half-EPS)return result;
  const bound=p.shape==='circle'?p.radius:Math.hypot(p.hx,p.hz);
  // Rhombus vertices are within two edge lengths of their centre, including after flips.
  for(const id of lat.facetsInRadius(p.x,p.z,bound+2*lat.edge)) {
    const f=lat.facets[id],xs:number[]=[],zs:number[]=[];
    for(const n of f.nodes){const dx=lat.nodes[n].x-p.x,dz=lat.nodes[n].z-p.z;
      // Inverse Three.js rotation.y, matching the map's obstacle convention.
      xs.push(cosine*dx-sine*dz);zs.push(sine*dx+cosine*dz);}
    if(!(p.shape==='circle'?circleTouches(xs,zs,p.radius):boxTouches(xs,zs,p.hx,p.hz)))continue;
    // A touched border or hole cannot be completely surrounded by a closed lattice loop.
    if(f.boundary||f.neighbors.some(n=>n<0))return result;
    result.facets.push(id);
  }
  result.valid=result.facets.length>0;return result;
}
function enclosed(w:World,p:Footprint,f:FactionId):boolean {
  const c=coverage(w,p);
  if(!c.valid)return false;
  if(c.surveyVersion!==w.survey.version){
    // Intersection, not union: the SAME faction must cover every touched facet.
    let owners=15;
    for(const id of c.facets)owners&=w.survey.facetSurvey[id];
    c.owners=owners;c.surveyVersion=w.survey.version;
  }
  return (c.owners&(1<<f))!==0;
}
export function circleEnclosed(w:World,x:number,z:number,radius:number,f:FactionId):boolean {
  return enclosed(w,{x,z,radius,shape:'circle',hx:radius,hz:radius,yaw:0},f);
}
export function sceneryEnclosed(w:World,o:Obstacle,f:FactionId):boolean {
  return sceneryCaptureEligible(o)&&!w.destroyedScenery.has(o.id)&&enclosed(w,o,f);
}

/** Common capture UI/modifier origin. Invalid geometry is explicitly marked facet=-1. */
export function pieceCaptureAnchor(w:World,p:Piece):{pos:{x:number;z:number};facet:number;radius:number} {
  if(p.kind==='wall'){
    if(!w.lattice.edges[p.edge])return{pos:{x:0,z:0},facet:-1,radius:0};
    const [ax,az,bx,bz]=wallSegment(w.lattice,p.edge,[]),x=(ax+bx)/2,z=(az+bz)/2;
    return{pos:{x,z},facet:w.lattice.facetAt(x,z),radius:Math.hypot((bx-ax)/2,(bz-az)/2,PIECE.wallThickness/2)};
  }
  const f=w.lattice.facets[p.facet];
  if(!f)return{pos:{x:0,z:0},facet:-1,radius:0};
  return{pos:{x:f.cx,z:f.cz},facet:f.id,radius:Math.max(...f.nodes.map(id=>Math.hypot(w.lattice.nodes[id].x-f.cx,w.lattice.nodes[id].z-f.cz)))};
}
export function pieceEnclosed(w:World,p:Piece,faction:FactionId):boolean {
  if(p.kind==='wall'){
    if(!w.lattice.edges[p.edge])return false;
    const [ax,az,bx,bz]=wallSegment(w.lattice,p.edge,[]),dx=bx-ax,dz=bz-az;
    const hx=Math.hypot(dx,dz)/2,hz=PIECE.wallThickness/2;
    return enclosed(w,{shape:'box',x:(ax+bx)/2,z:(az+bz)/2,hx,hz,radius:Math.hypot(hx,hz),yaw:-Math.atan2(dz,dx)},faction);
  }
  // A floor/ramp's footprint is EXACTLY its Ley facet. Neighboring facets only touch at
  // zero-area edges; requiring those would incorrectly demand an extra ring outside it.
  const f=w.lattice.facets[p.facet];
  if(!f||f.boundary||f.neighbors.some(n=>n<0))return false;
  for(const id of f.nodes){const n=w.lattice.nodes[id];if(Math.abs(n.x)>=w.map.half-EPS||Math.abs(n.z)>=w.map.half-EPS)return false;}
  return w.inSurvey(f.id,faction);
}
