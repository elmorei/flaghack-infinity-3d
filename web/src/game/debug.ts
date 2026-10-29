/**
 * Browser-console debug API (window.fh). Lets developers and automated smoke tests stage
 * scenarios: fast-forward the sim, grant resources, call sim systems directly.
 * Presentation/dev only; gameplay code never imports this module. Online the host owns the
 * burn: the mutators refuse (the mirror would silently drift from the host).
 */
import * as factory from '../sim/factory';
import * as geometry from '../sim/lattice/geometry';
import * as planner from '../sim/lattice/planner';
import * as abilities from '../sim/systems/abilities';
import * as buildings from '../sim/systems/buildings';
import * as capture from '../sim/systems/capture';
import * as flags from '../sim/systems/flags';
import * as pieces from '../sim/systems/pieces';
import * as survey from '../sim/systems/survey';
import { resetFrickFrackEntropy } from '../sim/systems/frickFrack';
import * as tides from '../sim/systems/tides';
import type { FactionId } from '../sim/types';
import type { App } from './app';

/** Mutating the mirror of a host's burn would only desync this screen from the truth. */
function refuseOnline(app: App): boolean {
  if (!app.online) return false;
  console.warn('fh: the host owns this burn; local mutators are disabled online.');
  return true;
}

export function installDebug(app: App): void {
  const fh = {
    app,
    get world() {
      return app.world;
    },
    get session() {
      return app.session;
    },
    /** Online session (null offline), its mirror and the local avatar predictor. */
    get net() {
      return app.net;
    },
    get mirror() {
      return app.mirror;
    },
    get predictor() {
      return app.predictor;
    },
    factory,
    geometry,
    planner,
    flags,
    survey,
    tides,
    capture,
    abilities,
    buildings,
    pieces,
    /** Offline fixture control only; online decks remain host-private. */
    frickFrack: {
      resetEntropy(seed: string): void {
        if (!app.world || refuseOnline(app)) return;
        resetFrickFrackEntropy(app.world, seed);
      },
    },
    /** Run AI + simulation synchronously for `seconds` of game time (events discarded). */
    advance(seconds: number): void {
      if (refuseOnline(app)) return;
      app.fastForward(seconds);
    },
    /** Grant resources to a faction (default: player). */
    give(res: { lumber?: number; ritual?: number; flags?: number }, faction: FactionId = 0): void {
      const w = app.world;
      if (!w || refuseOnline(app)) return;
      const f = w.factions[faction];
      f.lumber += res.lumber ?? 0;
      f.ritual += res.ritual ?? 0;
      const av = w.avatarOf(faction);
      for (let i = 0; i < (res.flags ?? 0); i++) {
        const fl = factory.spawnFlag(w, { state: 'carried', owner: faction, holder: av.id, pos: { ...av.pos } });
        av.carried.push(fl.id);
      }
    },
    /**
     * Plant a loop of fresh Flags for `faction` enclosing (x, z) at ≥ radius, using the shared
     * planner. Nodes the faction already holds are reused for free. Returns the loop's node ids.
     */
    encircle(faction: FactionId, x: number, z: number, radius: number): number[] {
      const w = app.world;
      if (!w || refuseOnline(app)) return [];
      const lat = w.lattice;
      const held = (n: number) => w.survey.nodeFlagOwner[n] === faction;
      const loop = planner.planEnclosure(lat, {
        x,
        z,
        minRadius: radius,
        cost: (n) => (held(n) ? 0 : flags.canPlantAt(w, n, faction) ? 1 : Infinity),
      });
      if (!loop) return [];
      for (const node of loop) {
        if (held(node)) continue;
        const n = lat.nodes[node];
        // Loose (not carried) so a rejected plant leaves an ordinary pickup, not a holderless carried Flag.
        const fl = factory.spawnFlag(w, { state: 'loose', owner: faction, holder: -1, pos: { x: n.x, y: 0, z: n.z } });
        flags.plantFlag(w, fl.id, node, faction, -1);
      }
      return loop;
    },
  };
  window.fh = fh;
}

declare global {
  interface Window {
    /** Debug console API (see game/debug.ts). */
    fh?: unknown;
  }
}
