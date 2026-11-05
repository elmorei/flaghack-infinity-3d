import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Session } from '../../game/session';
import type { World } from '../../sim/world';
import { GLSL_VERT, createSurveyUniforms } from './glsl';
import { drawGroundInkBeforeSprites } from './groundInk';
import { updateSurveyHover } from './hoverPresentation';
const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('mobile field presentation', () => {
  it('clears every visual finger-hover in Degen without changing the actual picked target', () => {
    const texture = new THREE.DataTexture();
    const u = createSurveyUniforms({node:texture,aux:texture,edge:texture,facet:texture}, 100);
    const lattice = {nodes:[{}],edges:[{}],facets:[{edges:[2,3,4,5]}]} as unknown as World['lattice'];
    const s = new Session(); s.hover.node = s.hover.edge = s.hover.facet = 0; s.viewBlend = 1;
    s.mobileMode = 'build'; updateSurveyHover(u,lattice,s,true);
    expect(u.uHover.value.toArray()).toEqual([0,0,0,1]); expect(u.uHoverEdges.value.toArray()).toEqual([2,3,4,5]);
    s.mobileMode = 'units'; updateSurveyHover(u,lattice,s,true);
    expect(u.uHover.value.toArray()).toEqual([-1,-1,-1,0]); expect(u.uHoverEdges.value.toArray()).toEqual([-1,-1,-1,-1]);
    expect(s.hover.node).toBe(0); expect(s.hover.facet).toBe(0);
    updateSurveyHover(u,lattice,s,false); expect(u.uHover.value.toArray()).toEqual([0,0,0,1]);
    texture.dispose();
  });
  it('keeps the mobile grid visible and puts Plan marks into the same scene below sprites', () => {
    const renderer = source('./surveyRenderer.ts');
    expect(renderer).toContain('this.lattice.setTargetingVisible(true)');
    expect(renderer).toContain('if (ctx.shared.mobileSprites) scene.add(this.marked.scene)');
    expect(renderer).toContain('else ctx.shared.commandOverlay = this.marked.scene');
    expect(source('./markedNodes.ts')).toContain('this.mesh.renderOrder = 9');
  });
  it('restores 3D scenery without replacing the character and building sprite systems', () => {
    const env = source('../env/envRenderer.ts');
    expect(env).toContain('this.parts.push(new PropField(env), new Effigy(env), new LumberPiles(env),');
    expect(env).not.toContain('new MobilePropField'); expect(env).not.toContain('new MobileEffigy');
    expect(source('../actors/mobileSprites.ts')).toContain('building(kind: string');
    expect(source('../structures/wreckageRenderer.ts')).not.toContain('renderSprites');
  });
});

describe('projection-safe glowing borders', () => {
  const expression = GLSL_VERT.match(/float fhPixelDepth\(vec3 world\) \{ return ([^;]+);/)![1].replace('length(cameraPosition - world)', 'distance');
  const depth = new Function('projectionMatrix', 'distance', `return ${expression};`) as (matrix:number[][], distance:number)=>number;
  it.each(['./beams.ts','./objectives.ts','./bossVision.ts'])('uses shared pixel depth and parallel camera rays in %s', file => {
    const text = source(file); expect(text).toContain('fhPixelDepth(P) / fhProjScale()'); expect(text).toContain('fhToCamera(P)');
    expect(text).not.toMatch(/uPx \* length\((?:toCam|cameraPosition - P)\) \/ fhProjScale/);
  });
  it('keeps orthographic minimum widths fixed across viewports, distance, DPR and zoom', () => {
    for (const [w,h] of [[320,568],[390,844],[844,390]]) for (const dpr of [1,1.5,2,3]) for(const zoom of [.5,1,2]) {
      const camera = new THREE.OrthographicCamera(-w*.035,w*.035,h*.035,-h*.035,.1,1000); camera.zoom=zoom; camera.updateProjectionMatrix();
      const e=camera.projectionMatrix.elements, matrix=Array.from({length:4},(_,i)=>e.slice(i*4,i*4+4));
      for(const distance of [2,50,300]) for(const minPx of [2,2.6,3]) {
        const scale=e[5]*h*dpr*.5, width=minPx*dpr*depth(matrix,distance)/scale;
        expect(width).toBeCloseTo(minPx*.07/zoom,10);
      }
    }
  });
  it('preserves perspective scaling', () => {
    const camera = new THREE.PerspectiveCamera(70,1.5,.1,1000),e=camera.projectionMatrix.elements;
    const matrix=Array.from({length:4},(_,i)=>e.slice(i*4,i*4+4));
    for(const distance of [2,50,300]) expect(depth(matrix,distance)).toBe(distance);
  });
});

it('centers an accessible small house button between Degen and Plan', () => {
  const ui = source('../../ui/mobileCommand.ts'), css = source('../../ui/ui.css');
  expect(ui.indexOf("const degen = button")).toBeLessThan(ui.indexOf("const home = button"));
  expect(ui.indexOf("const home = button")).toBeLessThan(ui.indexOf("const plan = button"));
  expect(ui).toContain("home.setAttribute('aria-label', 'Home')");
  expect(ui).toContain('<svg viewBox="0 0 24 24" aria-hidden="true">');
  expect(ui).not.toContain("button('btn ix', top, 'Home'");
  expect(css).toContain('.mc-modes .btn { min-width: 100px; width: 100px; flex: 0 0 auto; }');
  expect(css).toContain('.mc-modes .mc-home { min-width: 44px; width: 44px;');
});

it('keeps ground ink blended without depth writes in the opaque pass, leaving actual VFX alone', () => {
  const ink = new THREE.ShaderMaterial({transparent:true,depthTest:true,depthWrite:true});
  drawGroundInkBeforeSprites(ink);
  expect(ink.transparent).toBe(false);expect(ink.depthWrite).toBe(false);expect(ink.depthTest).toBe(true);
  expect(ink.blending).toBe(THREE.CustomBlending);expect(ink.blendSrc).toBe(THREE.SrcAlphaFactor);
  const premultiplied=new THREE.ShaderMaterial({transparent:true,blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor});
  drawGroundInkBeforeSprites(premultiplied);expect(premultiplied.blendSrc).toBe(THREE.OneFactor);
  for(const file of ['./beams.ts','./bossVision.ts','./objectives.ts'])expect(source(file)).not.toContain('drawGroundInkBeforeSprites');
  ink.dispose();premultiplied.dispose();
});
