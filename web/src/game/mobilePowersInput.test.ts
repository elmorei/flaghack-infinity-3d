import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from './session';
import { PerspectiveCamera } from 'three';
import { MobileTouch } from './mobileTouch';
import type { Input } from './input';
import { CommandView, consumeMobilePowerTap } from './commandView';
import { armMobilePower } from '../ui/mobilePowers';
import { cancelMobileTarget, setMobileMode } from '../ui/mobileCommand';
import type { Command } from '../sim/commands';
import { commandPowersWorld } from '../sim/systems/commandPowersTestkit';

describe('mobile Powers direct point targeting', () => {
  it.each(['omega', 'stabilize', 'redtape', 'patchwork'] as const)('arms %s without a selected Signifier and submits exactly one direct tap', id => {
    const w = commandPowersWorld(), s = new Session(), queue: Command[] = [];
    w.factions[0].chakras.finial = 1; w.factions[0].chakras.canton = 1;
    s.mobileMenu = 'powers'; s.mobileMode = 'build'; s.tool = 'building'; s.mobileBuildFacet = 4; s.planPreview = [1];
    expect(armMobilePower(w, s, id)).toBe(''); expect(s.selection.size).toBe(0);
    expect(s.mobileMenu).toBeNull(); expect(s.mobileBuildFacet).toBe(-1); expect(s.planPreview).toEqual([]);
    s.hover.point = { x: 42, y: 4, z: -53 };
    expect(consumeMobilePowerTap(w, s, 0, queue)).toBe(true);
    expect(queue).toEqual([id === 'redtape' || id === 'patchwork' ? { t: 'ritual', faction: 0, ritual: id, at: { x: 42, z: -53 } } : { t: 'ability', faction: 0, ability: id, at: { x: 42, z: -53 }, node: -1 }]);
    expect(consumeMobilePowerTap(w, s, 0, queue)).toBe(false); expect(queue).toHaveLength(1);
    expect(w.factions[0].ritual).toBe(300); expect(w.factions[0].cooldowns[id]).toBe(0);
  });
  it('rechecks cooldown and resources after the menu closes and consumes stale taps without issuing orders', () => {
    const w = commandPowersWorld(), s = new Session(), queue: Command[] = []; s.hover.point = { x: 0, y: 0, z: 0 };
    armMobilePower(w, s, 'redtape'); w.factions[0].ritual = 0;
    expect(consumeMobilePowerTap(w, s, 0, queue)).toBe(true); expect(queue).toEqual([]); expect(s.mobileRitual).toBeNull();
    w.factions[0].chakras.finial = 1; armMobilePower(w, s, 'omega'); w.factions[0].cooldowns.omega = 200;
    expect(consumeMobilePowerTap(w, s, 0, queue)).toBe(true); expect(queue).toEqual([]); expect(s.mobileAbility).toBeNull();
  });
  it('Cancel and mode changes clear all spell intent but preserve selection', () => {
    const w = commandPowersWorld(), s = new Session(); s.selection.add(42); armMobilePower(w, s, 'redtape');
    cancelMobileTarget(s); expect(s.mobileRitual).toBeNull(); expect(s.selection.has(42)).toBe(true);
    armMobilePower(w, s, 'redtape'); setMobileMode(s, 'build'); expect(s.mobileRitual).toBeNull();
    w.factions[0].chakras.finial = 1; armMobilePower(w, s, 'omega'); cancelMobileTarget(s); expect(s.mobileAbility).toBeNull();
  });
  it('missing or invalid terrain rejects one tap and cannot fall through to a unit order', () => {
    const w = commandPowersWorld(), s = new Session(), queue: Command[] = [];
    for (const point of [null, { x: Infinity, y: 0, z: 0 }, { x: 0, y: 0, z: 999 }]) {
      armMobilePower(w, s, 'redtape'); s.hover.point = point;
      expect(consumeMobilePowerTap(w, s, 0, queue)).toBe(true); expect(queue).toHaveLength(0);
    }
  });
  it('does not arm new rites in Regular mode or locked abilities', () => {
    const w = commandPowersWorld(), s = new Session(); expect(armMobilePower(w, s, 'omega')).toMatch(/Align/);
    s.playerFaction = 1; expect(armMobilePower(w, s, 'redtape')).toMatch(/Degen/);
    expect(s.mobileRitual).toBeNull(); expect(s.mobileAbility).toBeNull();
  });
});


afterEach(() => vi.unstubAllGlobals());
it('production touch flow pans without casting, then casts the next real tap once; a hold cancels', () => {
  vi.stubGlobal('document', { documentElement: { dataset: { deviceLayout: 'mobile' } } });
  const world = commandPowersWorld(), s = new Session(), touch = new MobileTouch(), queue: Command[] = [];
  s.screen = 'playing'; s.view = 'command'; s.viewBlend = 1; touch.enabled = true;
  const input = { touch, width: 390, height: 844, shift: false, ctrl: false, setCursor() {} } as unknown as Input;
  const view = new CommandView(input, queue), camera = new PerspectiveCamera(50, 390 / 844, .1, 1000);
  camera.position.set(0, 80, 80); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const action = (kind: 'tap' | 'drag' | 'hold') => { touch.action = { kind, x: 195, y: 422, startX: 100, startY: 300 }; view.frame(world, s, 0, camera, null); touch.endFrame(); };
  s.hover.point = { x: 32, y: 0, z: -27 };
  expect(armMobilePower(world, s, 'redtape')).toBe(''); action('drag');
  expect(queue).toEqual([]); expect(s.mobileRitual).toBe('redtape');
  action('tap'); expect(queue).toEqual([{ t: 'ritual', faction: 0, ritual: 'redtape', at: { x: 32, z: -27 } }]);
  expect(s.mobileRitual).toBeNull(); queue.length = 0; armMobilePower(world, s, 'redtape'); action('hold');
  expect(s.mobileRitual).toBeNull(); expect(queue).toEqual([]);
});
