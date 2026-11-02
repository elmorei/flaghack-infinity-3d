import { describe, expect, it } from 'vitest';
import { MobileFieldStatus } from './mobileFieldStatus';

class Node {
  children: Node[] = [];
  parentElement: Node | null = null;
  textContent = '';
  moves = 0;
  constructor(readonly cls = '') {}
  appendChild(node: Node) {
    if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(x => x !== node);
    this.children.push(node); node.parentElement = this; this.moves++; return node;
  }
  querySelector(selector: string): Node | null {
    return this.cls === selector.slice(1) ? this : this.children.map(x => x.querySelector(selector)).find(Boolean) ?? null;
  }
}

describe('mobile field resource and timer portals', () => {
  it('reuses live HUD nodes instead of copying counts or clock rules', () => {
    const source = new Node(), overview = new Node(), resources = new Node(), timing = new Node();
    const res = new Node('res'), clock = new Node('clock'), boss = new Node('boss-hud');
    source.appendChild(overview); for (const node of [res, clock, boss]) overview.appendChild(node);
    const status = new MobileFieldStatus(source as unknown as HTMLElement, resources as unknown as HTMLElement,
      timing as unknown as HTMLElement, overview as unknown as HTMLElement);
    expect(resources.children).toEqual([res]); expect(timing.children).toEqual([clock, boss]);
    res.textContent = 'Camp stock 20 · Lumber 778 · Ritual 0 · Signifiers 2/12 · Attention 69';
    clock.textContent = 'Day 1 · 0:32 · Tide 0:43 · Burn 24:08';
    expect(resources.children[0].textContent).toContain('Attention 69');
    status.setField(false);
    expect(overview.children).toEqual([res, clock, boss]); expect(resources.children).toEqual([]);
    clock.textContent = 'Day 2 · 10:32'; boss.textContent = 'THE EFFIGY 40,000 / 50,000';
    status.setField(true);
    expect(timing.children[0].textContent).toBe('Day 2 · 10:32');
    expect(timing.children[1].textContent).toContain('40,000');
    expect(source.querySelector('.res')).toBeNull(); // Exactly one instance, not a stale menu duplicate.
  });
  it('does not reparent every tick and tolerates absent optional nodes', () => {
    const source = new Node(), overview = new Node(), resources = new Node(), timing = new Node();
    const clock = new Node('clock'); source.appendChild(clock);
    const status = new MobileFieldStatus(source as unknown as HTMLElement, resources as unknown as HTMLElement,
      timing as unknown as HTMLElement, overview as unknown as HTMLElement);
    const moves = timing.moves;
    for (let i = 0; i < 100; i++) status.setField(true);
    expect(timing.moves).toBe(moves);
    for (let i = 0; i < 5; i++) { status.setField(false); status.setField(true); }
    expect(timing.children).toEqual([clock]); expect(overview.children).toEqual([]);
    status.restoreOriginal();
    expect(source.children).toEqual([clock]); expect(timing.children).toEqual([]);
    status.setField(true); expect(timing.children).toEqual([clock]);
    status.setField(false); status.restoreOriginal();
    expect(source.children).toEqual([clock]); expect(overview.children).toEqual([]);
  });
});
