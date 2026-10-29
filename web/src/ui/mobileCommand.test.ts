import { describe, expect, it } from 'vitest';
import { Session } from '../game/session';
import { cancelMobileTarget, chooseMobileBuilding, setMobileMode } from './mobileCommand';

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
  it('building choice requires a locked space and never implicitly confirms', () => {
    const s = new Session(); s.mobileMenu = 'build';
    expect(chooseMobileBuilding(s, 'workshop')).toBe(false);
    expect(s.mobileMenu).toBe('build'); expect(s.tool).toBe('flag');
    s.mobileBuildFacet = 8; s.mobileBuildConfirm = true;
    expect(chooseMobileBuilding(s, 'workshop')).toBe(true);
    expect(s.mobileBuildFacet).toBe(8); expect(s.buildingKind).toBe('workshop');
    expect(s.tool).toBe('building'); expect(s.mobileMenu).toBeNull();
    expect(s.mobileBuildConfirm).toBe(false); expect(s.mobileMode).toBe('build');
  });
});
