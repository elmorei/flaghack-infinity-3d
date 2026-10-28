import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPanels } from './command';
import { ActionBar } from './actionbar';
import type { UiHost, UiLayout } from './core';
import { Session } from '../game/session';
import { newMatch } from '../sim/systems/econ/testkit';
import type { Command } from '../sim/commands';

/** Minimal DOM contract: live button callbacks and visibility, without a browser layout. */
class Node {
  className = ''; textContent = ''; innerHTML = ''; title = ''; type = '';
  children: Node[] = []; parentElement: Node | null = null;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>(); properties = new Map<string, string>();
  listeners = new Map<string, (event: { detail: number; stopPropagation(): void }) => void>();
  style = { setProperty: (key: string, value: string) => this.properties.set(key, value) };
  classList = {
    contains: (key: string) => this.className.split(' ').includes(key),
    toggle: (key: string, on: boolean) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (on) classes.add(key); else classes.delete(key); this.className = [...classes].join(' ');
    },
  };
  constructor(readonly tagName = 'div') {}
  appendChild(node: Node) { node.parentElement = this; this.children.push(node); return node; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  addEventListener(name: string, listener: (event: { detail: number; stopPropagation(): void }) => void) { this.listeners.set(name, listener); }
  click() { this.listeners.get('click')?.({ detail: 0, stopPropagation() {} }); }
  blur() {}
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
}

const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)];
const label = (node: Node): string => [node.textContent, node.innerHTML.replace(/<[^>]*>/g, ''), ...node.children.map(label)].join(' ').trim();
const visible = (node: Node): boolean => !node.classList.contains('is-off') && (!node.parentElement || visible(node.parentElement));

function setup() {
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) });
  const root = new Node();
  const layoutNodes = Object.fromEntries(['raw', 'colLeft', 'colRight', 'topCenter', 'center', 'bottomCenter', 'bottomLeft', 'bottomRight', 'overlay']
    .map(key => [key, root.appendChild(new Node())]));
  const { world } = newMatch('map-ui-cleanup');
  const session = new Session(); session.screen = 'playing'; session.view = 'command'; session.viewBlend = 1;
  const queue: Command[] = [];
  const host = { app: { session, world, submit: (command: Command) => queue.push(command) }, blocked: vi.fn() } as unknown as UiHost;
  const panels = new CommandPanels(host, layoutNodes as unknown as UiLayout);
  const bar = new ActionBar(host, layoutNodes.bottomCenter as unknown as HTMLElement);
  const update = () => { panels.update(world, 0); bar.update(world, 0); };
  const target = (id: string) => all(root).find(node => node.dataset.tutorial === id)!;
  const button = (text: string) => all(root).find(node => node.tagName === 'button' && label(node).startsWith(text))!;
  return { world, session, queue, root, panels, bar, update, target, button };
}

afterEach(() => vi.unstubAllGlobals());

describe('map command UI cleanup', () => {
  it('nests Expand home under Enclose while preserving both tool callbacks and selection state', () => {
    const { session, update, target, button } = setup(); update();
    const mainTools = target('plan-tools'), expand = target('plan-ring'), enclose = target('plan-enclose');
    expect(all(mainTools)).not.toContain(expand);
    expect(label(expand)).toContain('Expand home');
    expect(visible(expand)).toBe(false);
    for (let visit = 0; visit < 2; visit++) {
      enclose.click(); update();
      expect(session.planTool).toBe('enclose'); expect(visible(expand)).toBe(true);
      expect(enclose.classList.contains('on')).toBe(true);
      session.planPreview = [1, 2]; expand.click(); update();
      expect(session.planTool).toBe('ring'); expect(session.planPreview).toEqual([]);
      expect(enclose.classList.contains('on')).toBe(true); expect(expand.classList.contains('on')).toBe(true);
      button('At target').click(); update();
      expect(session.planTool).toBe('enclose'); expect(expand.classList.contains('on')).toBe(false);
      target('plan-node').click(); update();
      expect(session.planTool).toBe('node'); expect(visible(expand)).toBe(false);
    }
    // The keyboard can enter the same internal tool while the submenu is closed.
    session.planTool = 'ring'; update();
    expect(visible(expand)).toBe(true); expect(expand.classList.contains('on')).toBe(true);
  });

  it('keeps Hold position and Clear orders, removes Follow me and Hand Flag, and holds the selected-unit centroid', () => {
    const { world, session, queue, root, update, button } = setup();
    const own = [...world.hippies.values()].filter(h => h.faction === 0).slice(0, 2);
    expect(own).toHaveLength(2);
    own[0].pos = { x: 10, z: 20 }; own[1].pos = { x: 30, z: 40 };
    for (const unit of own) session.selection.add(unit.id);
    // A non-owned selection must not affect the target point or receive the order.
    const rival = [...world.hippies.values()].find(h => h.faction === 1)!; session.selection.add(rival.id);
    session.hover.point = { x: 99, y: 0, z: 99 };
    update();
    const orders = all(root).find(node => node.classList.contains('sel-orders'))!;
    expect(orders.children.map(label)).toEqual(['Hold position', 'Recruit…', 'Clear orders']);
    expect(label(orders)).not.toMatch(/Follow me|Hand Flag|Defend here/);
    session.tool = 'building'; session.planTool = 'enclose'; session.planPreview = [1, 2];
    button('Recruit…').click();
    expect(session.recruitTargeting).toBe(true); expect(queue).toEqual([]);
    expect(session.tool).toBe('flag'); expect(session.planTool).toBe('select'); expect(session.planPreview).toEqual([]);
    button('Hold position').click();
    expect(session.recruitTargeting).toBe(false);
    expect(queue).toEqual([{ t: 'order', faction: 0, hippies: own.map(unit => unit.id), order: { kind: 'defend', at: { x: 20, z: 30 } } }]);
    button('Clear orders').click();
    expect(queue[1]).toEqual({ t: 'order', faction: 0, hippies: own.map(unit => unit.id), order: null });
  });

  it('hides action-only build slots on the map and restores their actual callbacks after returning', () => {
    const { session, root, update, target } = setup();
    const tools = ['wall', 'floor', 'ramp', 'demolish'] as const;
    for (let visit = 0; visit < 2; visit++) {
      session.view = 'command'; update();
      for (const tool of tools) expect(visible(target(`tool-${tool}`))).toBe(false);
      expect(visible(all(root).find(node => node.classList.contains('tool') && label(node).includes('Flag'))!)).toBe(true);
      expect(visible(target('tool-building'))).toBe(true);
      session.view = 'action'; update();
      for (const tool of tools) {
        const slot = target(`tool-${tool}`);
        expect(visible(slot)).toBe(true); slot.click(); update();
        expect(session.tool).toBe(tool); expect(slot.classList.contains('on')).toBe(true);
      }
    }
  });
});
