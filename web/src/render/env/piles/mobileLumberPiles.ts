/** One authored cutout per resource pile; authoritative stock controls its shrinking size. */
import type { EnvContext, EnvPart } from '../envTypes';
import type { SpritePose } from '../../actors/mobileSprites';
import { terrainHeight } from '../terrain';
import { buildPileLayout } from './pileLayout';
import type { PileLayout } from './pileLayout';

export class MobileLumberPiles implements EnvPart {
  private readonly layouts = new Map<number, PileLayout>();
  private readonly pose: SpritePose = { id: 0, x: 0, y: 0, z: 0, yaw: 0, height: 1, moving: false };
  constructor(private readonly env: EnvContext) {}
  update(_dt: number): void {
    const { world, shared } = this.env.ctx, sprites = shared.mobileSprites;
    if (!sprites) return;
    for (const id of this.layouts.keys()) if (!world.piles.has(id)) this.layouts.delete(id);
    for (const pile of world.piles.values()) {
      if (pile.lumber <= 0) continue;
      let layout = this.layouts.get(pile.id);
      if (!layout) { layout = buildPileLayout(pile); this.layouts.set(pile.id, layout); }
      const remaining = Math.ceil(Math.min(1, pile.lumber / Math.max(1, pile.max)) * 24) / 24;
      const p = this.pose;
      p.id = -3000000 - pile.id; p.x = pile.pos.x; p.z = pile.pos.z;
      p.y = terrainHeight(p.x, p.z, world.map.half); p.yaw = layout.yaw;
      p.height = (pile.kind === 'pallets' ? 2.15 : pile.kind === 'lumber' ? 1.55 : 1.7) * (.25 + .75 * remaining);
      sprites.object(`pile:${pile.kind}`, p);
    }
  }
  dispose(): void { this.layouts.clear(); }
}
