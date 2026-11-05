import { describe, expect, it } from 'vitest';
import { createMatch } from '../setup';
import { cmdMoveGcc, updateGccMovement } from './gccMovement';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
function fixture() { return createMatch({ seed: 'mobile-cart-movement', difficulty: 'normal', mode: 'standard', humans: [0], rtsFactions: [0] }); }
describe('independent GCC movement', () => {
  it('moves an owned command-only cart without a worker and accepts stop', () => {
    const w = fixture(), g = w.gccOf(0)!; const at = { ...g.pos };
    const h = w.hearthOf(0)!, dx=g.pos.x-h.pos.x, dz=g.pos.z-h.pos.z, d=Math.hypot(dx,dz);
    cmdMoveGcc(w,{t:'moveGcc',faction:0,to:{x:g.pos.x+dx/d*2,z:g.pos.z+dz/d*2}});
    for(let i=0;i<60;i++) updateGccMovement(w, 1/60);
    expect(Math.hypot(g.pos.x-at.x,g.pos.z-at.z)).toBeGreaterThan(.5);
    expect(g.gcc!.pushedBy).toBe(-1);
    cmdMoveGcc(w,{t:'moveGcc',faction:0,to:null}); expect(g.gcc!.moveTarget).toBeNull();
  });
  it('rejects malformed coordinates and avatar camps, cancels after elimination', () => {
    const w = fixture(), g = w.gccOf(0)!;
    cmdMoveGcc(w,{t:'moveGcc',faction:0,to:{x:Infinity,z:0}}); expect(g.gcc!.moveTarget).toBeUndefined();
    w.factions[0].controlMode='avatar'; cmdMoveGcc(w,{t:'moveGcc',faction:0,to:{x:0,z:0}}); expect(g.gcc!.moveTarget).toBeUndefined();
    w.factions[0].controlMode='rts'; cmdMoveGcc(w,{t:'moveGcc',faction:0,to:{x:0,z:0}});
    w.factions[0].alive=false; updateGccMovement(w,1/60); expect(g.gcc!.moveTarget).toBeNull();
  });
  it('replicates the destination and cart without sharing client authority', () => {
    const w=fixture(), g=w.gccOf(0)!; cmdMoveGcc(w,{t:'moveGcc',faction:0,to:{x:5,z:8}});
    const mirror=NetMirror.create(w.options,new SnapshotEncoder(w).full());
    expect(mirror.world.gccOf(0)!.gcc!.moveTarget).toEqual({x:5,z:8});
  });
});
