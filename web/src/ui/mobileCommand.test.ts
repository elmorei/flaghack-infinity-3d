import { describe, expect, it, vi } from 'vitest';
import { newMatch } from '../sim/systems/econ/testkit';
import { canPlaceBuilding } from '../sim/systems/buildings';
import { Session } from '../game/session';
import { cancelMobileTarget, chooseMobileBuilding, setMobileMode, mobileIndicatorReservedRects } from './mobileCommand';

describe('mobile command menu intent', () => {
  it('cancel clears incomplete actions while preserving the selected units', () => {
    const s = new Session(); s.selection.add(42);
    s.mobileMode = 'build'; s.tool = 'building'; s.mobileBuildFacet = 7;
    s.mobileBuildConfirm = true; s.mobileBoxSelect = true; s.recruitTargeting = true;
    s.planPreview = [1, 2]; const serial = s.mobileCancelSerial;
    cancelMobileTarget(s);
    expect(s.tool).toBe('flag'); expect(s.mobileBuildFacet).toBe(-1);
    expect(s.mobileBuildConfirm).toBe(false); expect(s.mobileBoxSelect).toBe(false);
    expect(s.recruitTargeting).toBe(false); expect(s.planPreview).toEqual([]);
    expect(s.planTool).toBe('node'); expect(s.selection.has(42)).toBe(true);
    expect(s.mobileCancelSerial).toBe(serial + 1);
  });
  it('mode changes close menus and cancel a previous placement without losing selection', () => {
    const s = new Session(); s.selection.add(42); s.mobileMenu = 'build'; s.mobileBuildFacet = 7;
    setMobileMode(s, 'build');
    expect(s.mobileMode).toBe('build'); expect(s.planTool).toBe('node');
    expect(s.mobileMenu).toBeNull(); expect(s.mobileBuildFacet).toBe(-1);
    setMobileMode(s, 'units');
    expect(s.mobileMode).toBe('units'); expect(s.planTool).toBe('select');
    expect([...s.selection]).toEqual([42]);
  });
  it('building choice immediately submits once for the locked space without confirmation', () => {
    const s = new Session(), { world } = newMatch('immediate-mobile-build'), submit = vi.fn(); s.mobileMenu = 'build';
    world.factions[0].lumber = 500;
    expect(chooseMobileBuilding(s, 'workshop', world, submit)).toBe(false);
    const facet = world.lattice.facets.find(fc => canPlaceBuilding(world, 0, 'workshop', fc.id).ok)!;
    s.mobileBuildFacet = facet.id;
    expect(chooseMobileBuilding(s, 'workshop', world, submit)).toBe(true);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ t: 'placeBuilding', faction: 0, kind: 'workshop', facet: facet.id });
    expect(s.mobileBuildFacet).toBe(-1); expect(s.buildingKind).toBe('workshop');
    expect(s.tool).toBe('flag'); expect(s.mobileMenu).toBeNull();
    expect(s.mobileBuildConfirm).toBe(false); expect(s.mobileMode).toBe('build');
    chooseMobileBuilding(s, 'workshop', world, submit); expect(submit).toHaveBeenCalledTimes(1);
  });
  it('unaffordable or stale locations do not submit or discard the selected space', () => {
    const s = new Session(), { world } = newMatch('immediate-mobile-build-poor'), submit = vi.fn();
    world.factions[0].lumber = 500;
    const facet = world.lattice.facets.find(fc => canPlaceBuilding(world, 0, 'workshop', fc.id).ok)!;
    s.mobileBuildFacet = facet.id; s.mobileMenu = 'build'; world.factions[0].lumber = 0;
    chooseMobileBuilding(s, 'workshop', world, submit);
    expect(submit).not.toHaveBeenCalled(); expect(s.mobileBuildFacet).toBe(facet.id); expect(s.mobileMenu).toBe('build');
    expect(s.feed.at(-1)?.text).toContain('Not enough lumber');
  });
});

it('refreshes bearings at rendered-frame cadence and hides them immediately behind menus', async () => {
  const { MobileCommandUI } = await import('./mobileCommand');
  const s = new Session(); s.screen = 'playing'; s.view = 'command'; s.mobileMenu = null;
  const world = { factions: [{ alive: true }] }, camera = {}, calls: string[] = [];
  const ui = Object.create(MobileCommandUI.prototype);
  Object.assign(ui, { host: { app: { world, session: s, renderer: { camera } } },
    indicatorViewport: { width: 390, height: 844 }, altars: { update: () => calls.push('update'), hide: () => calls.push('hide') } });
  const prior = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 390, innerHeight: 844 } });
  try {
    ui.frame(); ui.frame(); ui.frame();
    expect(calls).toEqual(['update', 'update', 'update']);
    s.mobileMenu = 'main'; ui.frame(); expect(calls.at(-1)).toBe('hide');
    s.mobileMenu = null; s.panels.chakras = true; ui.frame(); expect(calls.at(-1)).toBe('hide');
    s.panels.chakras = false; window.innerWidth = 844; ui.frame(); expect(calls.at(-1)).toBe('hide');
  } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: prior }); }
});


it('reserves sibling dialogue and original controls within only the same game root', () => {
  const top = { x: 220, y: 8, width: 160, height: 120 } as DOMRect;
  const panel = { x: 8, y: 500, width: 374, height: 200 } as DOMRect;
  const zero = { width: 0, height: 0 } as DOMRect;
  let visible = true;
  const root = { querySelectorAll: (selector: string) => {
    expect(selector).toBe('.mobile-announcements:not(.is-off) .mp-dialogue');
    return visible ? [{ getBoundingClientRect: () => panel }, { getBoundingClientRect: () => zero }] : [];
  } };
  const field = {
    querySelectorAll: (selector: string) => {
      expect(selector).toContain('.mc-status-left, .mc-resources, .mc-modes');
      expect(selector).toContain('.mc-placement:not(.is-off)');
      return [{ getBoundingClientRect: () => top }];
    },
    closest: (selector: string) => { expect(selector).toBe('.fh-root'); return root; },
  } as unknown as HTMLElement;
  expect(mobileIndicatorReservedRects(field)).toEqual([top, panel]);
  visible = false;
  expect(mobileIndicatorReservedRects(field)).toEqual([top]);
});
