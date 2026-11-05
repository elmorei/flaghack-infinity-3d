import * as THREE from 'three';
import { expect, it } from 'vitest';
import { Session } from '../../game/session';
import { normalizeMatch } from '../../sim/matchSettings';
import { createMatch } from '../../sim/setup';
import { BeamLayer } from './beams';
import { DecalLayer, createDecalMaterial } from './decals';
import { FocusFeature } from './focusPoints';
import { createSurveyUniforms } from './glsl';
import { SurveyData } from './surveyData';

it('the exact native Ley seed produces five real focus rays and five anchored pentagram edges', () => {
  const world = createMatch({ seed: 'mobile-hud-native', mode: 'standard', difficulty: 'normal', humans: [0], rtsFactions: [0], match: normalizeMatch({ active: [0, 1, 2, 3], bossMode: false, days: 3, maxSignifiers: 0 }) });
  const at = world.gccOf(0)?.pos ?? world.hearthOf(0)!.pos;
  const focus = world.survey.focusNodes.filter(n => world.lattice.nodes[n].edges.length === 5).sort((a, b) => Math.hypot(world.lattice.nodes[a].x - at.x, world.lattice.nodes[a].z - at.z) - Math.hypot(world.lattice.nodes[b].x - at.x, world.lattice.nodes[b].z - at.z))[0];
  expect(focus).toBeDefined();
  const neighbors = world.lattice.nodes[focus].edges.map(e => world.lattice.other(e, focus));
  const data = new SurveyData(world), session = new Session(), scene = new THREE.Scene();
  const uniforms = createSurveyUniforms({ node: data.nodeTex, aux: data.auxTex, edge: data.edgeTex, facet: data.facetTex }, world.map.half);
  const material = createDecalMaterial(uniforms), decals = new DecalLayer(scene, material, 1024, 5), beams = new BeamLayer(scene, uniforms, 512, 10);
  const feature = new FocusFeature(world, session, data);
  Object.assign(session, { view: 'command', viewBlend: 1, mobileMode: 'build', planTool: 'pentacle', tool: 'flag' });
  session.hover.node = focus; world.factions[0].plan = new Set(neighbors); world.factions[0].drugActive.dust = world.time + 60;
  data.update(world.time); feature.update(.25, decals, beams); beams.commit();
  const mesh = scene.children.find(o => (o as THREE.Mesh).geometry?.getAttribute('iB')) as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  expect(mesh.geometry.instanceCount).toBe(10); expect(mesh.material.transparent).toBe(true);
  const anchor = mesh.geometry.getAttribute('iAnchor'), a = mesh.geometry.getAttribute('iA'), b = mesh.geometry.getAttribute('iB');
  const rays = [], star = [];
  for (let i = 0; i < mesh.geometry.instanceCount; i++) {
    const pair = [anchor.getX(i), anchor.getY(i)];
    if (b.getW(i) === 1) { rays.push(pair); expect(a.getW(i)).toBeCloseTo(.12); }
    else { star.push(pair); expect(b.getW(i)).toBe(0); expect(a.getW(i)).toBeCloseTo(.1); }
  }
  expect(rays).toEqual(neighbors.map(n => [focus, n]));
  expect(star).toEqual(neighbors.map((n, i) => [n, neighbors[(i + 2) % 5]]));
  expect(mesh.material.vertexShader).toContain('2.0 * uPx * fhPixelDepth(P) / fhProjScale()');
  expect(mesh.material.vertexShader).toContain('vec3 toCam = fhToCamera(P)');
  beams.dispose(); decals.dispose(); material.dispose(); data.dispose();
});
