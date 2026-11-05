import type { Vector3 } from 'three';
import { groundHeight } from '../../sim/terrain';
import { LIFT } from './glsl';
import type { SurveyData } from './surveyData';

/** Match LatticeLayer's marker center, including phason display tweens and depth lift. */
export function nodeMarkerPosition(data: Pick<SurveyData, 'dispX' | 'dispZ'>, half: number, node: number, out: Vector3): boolean {
  if (!Number.isInteger(node) || node < 0 || node >= data.dispX.length) return false;
  const x = data.dispX[node], z = data.dispZ[node];
  out.set(x, groundHeight(x, z, half) + LIFT.marker, z);
  return true;
}
