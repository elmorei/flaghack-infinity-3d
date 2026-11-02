/** Reuse the authoritative HUD nodes on the field and in Overview, never a stale copy. */
export class MobileFieldStatus {
  private readonly placements: { node: HTMLElement; original: HTMLElement; menu: HTMLElement; field: HTMLElement }[] = [];
  private onField: boolean | null = null;

  constructor(source: HTMLElement, resources: HTMLElement, timing: HTMLElement, overview: HTMLElement) {
    for (const [selector, field] of [['.res', resources], ['.clock', timing], ['.boss-hud', timing]] as const) {
      const node = source.querySelector<HTMLElement>(selector);
      if (node?.parentElement) this.placements.push({ node, original: node.parentElement, menu: overview, field });
    }
    this.setField(true);
  }

  setField(on: boolean): void {
    if (this.onField === on) return;
    this.onField = on;
    for (const { node, menu, field } of this.placements) (on ? field : menu).appendChild(node);
  }

  /** Spectators still use the normal HUD; do not strand their clock/boss bar in a hidden menu. */
  restoreOriginal(): void {
    if (this.onField === null) return;
    this.onField = null;
    for (const { node, original } of this.placements) original.appendChild(node);
  }
}
