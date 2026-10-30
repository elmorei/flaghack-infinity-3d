/** Dedicated wizard circuit; never enters ordinary recruitment or drum-circle AI. */
import { HIPPIE } from '../constants';
import { BOSS_GAMEPLAY_SCALE } from '../bossDimensions';
import { CRATER_OUTER_RADIUS } from '../effigyCrater';
import { PLAZA_RADIUS } from '../map/mapgen';
import type { V2 } from '../math';
import type { Hippie } from '../types';
import type { World } from '../world';
import { beginTask, setStatusAt, type Brain } from './units/brain';
import { locomote, moveTo, routeExhausted } from './units/move';
import type { UnitsState } from './units/state';
interface Circuit { goal: V2; selectedAt: number; navVersion: number; step: number }
const circuits = new WeakMap<World, Circuit>();
/** Same safe central circuit after the effigy disappears. */
export function wizardCircuitRadius(w: World): number {
  let radius = Math.max(PLAZA_RADIUS + 4, CRATER_OUTER_RADIUS * 1.07 * BOSS_GAMEPLAY_SCALE + 2);
  for (const o of w.map.obstacles) if (o.kind === 'effigy')
    radius = Math.max(radius, Math.hypot(o.x - w.map.effigy.x, o.z - w.map.effigy.z) +
      (o.shape === 'circle' ? o.radius : Math.hypot(o.hx, o.hz)) + HIPPIE.radius + 3);
  return radius;
}
function goal(w: World, h: Hippie, advance: boolean, from: V2 = h.pos): V2 | null {
  const center = w.map.effigy, angle = Math.atan2(from.z - center.z, from.x - center.x);
  // Small angular steps avoid cutting across the scaffold/crater. Expanded rows stay local.
  for (const offset of (advance ? [.32, .48, .64, -.32] : [0, .16, -.16, .32, -.32])) {
    for (let row = 0; row < 4; row++) {
      const radius = wizardCircuitRadius(w) + row * 1.5;
      const p = { x: center.x + Math.cos(angle + offset) * radius, z: center.z + Math.sin(angle + offset) * radius };
      const y = w.collision.groundHeight(p.x, p.z);
      if (w.nav.isWalkable(p.x, p.z) && !w.collision.blockedCircle(p.x, p.z, HIPPIE.radius, y + .1, y + 1.8)) return p;
    }
  }
  return null;
}
export function resetWizardCircuit(w: World): void { circuits.delete(w); }
export function wanderFrickFrackWizard(w: World, sys: UnitsState, h: Hippie, b: Brain, dt: number): void {
  if (b.task !== 'wander') { beginTask(w, h, b, 'wander'); circuits.delete(w); }
  if (w.time < b.waitUntil) {
    b.moving = false; h.vel.x = 0; h.vel.z = 0; setStatusAt(h, b, 'idle', w.map.effigy.x, w.map.effigy.z); return;
  }
  let state = circuits.get(w);
  if (!state || state.navVersion !== w.nav.version || w.time - state.selectedAt > 90 || routeExhausted(h, b)) {
    const p = goal(w, h, !!state, state && routeExhausted(h, b) ? state.goal : h.pos);
    if (!p) { b.waitUntil = w.time + 3; b.moving = false; h.vel.x = 0; h.vel.z = 0; setStatusAt(h, b, 'idle', w.map.effigy.x, w.map.effigy.z); return; }
    state = {goal:p,selectedAt:w.time,navVersion:w.nav.version,step:(state?.step ?? 0) + 1}; circuits.set(w, state);
    b.route = 'none'; b.px = p.x; b.pz = p.z;
  }
  b.pace = .65;
  const arrived = moveTo(w, sys, h, b, state.goal.x, state.goal.z, .5);
  setStatusAt(h, b, arrived ? 'idle' : 'walking', state.goal.x, state.goal.z);
  locomote(w, sys, h, b, dt);
  if (arrived) {
    const p = goal(w, h, true);
    if (p) { state.goal = p; state.selectedAt = w.time; state.step++; b.px = p.x; b.pz = p.z; b.route = 'none'; }
    b.waitUntil = w.time + 1.5 + (h.id + state.step) % 4 * .5;
  }
}
