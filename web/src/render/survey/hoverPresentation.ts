import type { Session } from '../../game/session';
import type { World } from '../../sim/world';
import type { SurveyUniforms } from './glsl';

/** Picking remains active in Degen; only Plan paints finger-hover targets on the field. */
export function updateSurveyHover(u: SurveyUniforms, lattice: World['lattice'], s: Session, mobile: boolean): void {
  const show = !mobile || s.mobileMode === 'build';
  const hv = s.hover;
  const node = show && hv.node >= 0 && hv.node < lattice.nodes.length ? hv.node : -1;
  const edge = show && hv.edge >= 0 && hv.edge < lattice.edges.length ? hv.edge : -1;
  const facet = show && hv.facet >= 0 && hv.facet < lattice.facets.length ? hv.facet : -1;
  const facetTool = s.tool === 'floor' || s.tool === 'ramp' || s.tool === 'building';
  u.uHover.value.set(node, edge, facet, show ? Math.max(s.viewBlend, facetTool ? 1 : 0) : 0);
  if (facet >= 0) {
    const edges = lattice.facets[facet].edges;
    u.uHoverEdges.value.set(edges[0], edges[1], edges[2], edges[3]);
  } else u.uHoverEdges.value.set(-1, -1, -1, -1);
}
