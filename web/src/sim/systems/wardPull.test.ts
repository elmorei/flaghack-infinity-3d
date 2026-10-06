import { describe, expect, it } from 'vitest';
import { AVATAR, HIPPIE, SIM_DT, WARD_FLAG_RADIUS } from '../constants';
import { spawnBuilding } from '../factory';
import { cmdPull, updateAvatars } from './avatars';
import { wardPullRate } from './flags';
import { newMatch } from './rules/testWorld';
import { act } from './units/act';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';

function scenario() {
  const world = newMatch('ward-pull');
  const flag = [...world.flags.values()].find(f => f.owner === 1 && f.state === 'planted')!;
  const ward = spawnBuilding(world, 'ward', 1, world.hearthOf(1)!.facet, 1);
  ward.pos = { x: flag.pos.x + 5, z: flag.pos.z };
  return { world, flag, ward };
}

describe('Ward lightning protecting Flags', () => {
  it('doubles an enemy avatar pull and sends lightning from the Ward to the Flag', () => {
    const { world, flag, ward } = scenario();
    const av = world.avatarOf(0);
    av.pos = { x: flag.pos.x, y: 0, z: flag.pos.z };
    cmdPull(world, { t: 'pull', faction: 0, flagId: flag.id });
    const step = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
        world.time += SIM_DT;
        world.tick++;
        updateAvatars(world, SIM_DT);
      }
    };
    step(AVATAR.pullEnemyTime * 1.5);
    expect(flag.state).toBe('planted');
    const lightning = world.drainEvents().filter(e => e.t === 'wardLightning');
    expect(lightning.length).toBeGreaterThan(1);
    expect(lightning[0]).toMatchObject({ buildingId: ward.id, flagId: flag.id,
      from: { x: ward.pos.x, z: ward.pos.z }, to: { x: flag.pos.x, z: flag.pos.z } });
    step(AVATAR.pullEnemyTime * 0.5 + SIM_DT);
    expect(flag.state).toBe('carried');
    expect(flag.holder).toBe(av.id);
  });

  it('doubles an enemy hippie pull', () => {
    const { world, flag } = scenario();
    const h = world.hippiesOf(0)[0];
    h.pos = { x: flag.pos.x, z: flag.pos.z };
    h.order = { kind: 'pull', flagId: flag.id };
    const b = brainOf(h);
    b.task = 'pull';
    b.flag = flag.id;
    const step = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
        world.time += SIM_DT;
        world.tick++;
        act(world, unitsState(world), h, b, 0, SIM_DT);
      }
    };
    step(HIPPIE.pullEnemyTime * 1.5);
    expect(flag.state).toBe('planted');
    step(HIPPIE.pullEnemyTime * 0.5 + SIM_DT);
    expect(flag.state).toBe('carried');
    expect(flag.holder).toBe(h.id);
  });

  it('requires a working friendly Ward in range; leaves own and loose Flags alone', () => {
    const { world, flag, ward } = scenario();
    expect(wardPullRate(world, flag, 0)).toBe(0.5);
    expect(wardPullRate(world, flag, 1)).toBe(1);
    ward.disabled = true;
    expect(wardPullRate(world, flag, 0)).toBe(1);
    ward.disabled = false;
    ward.built = 0.5;
    expect(wardPullRate(world, flag, 0)).toBe(1);
    ward.built = 1;
    ward.faction = 0;
    expect(wardPullRate(world, flag, 0)).toBe(1);
    ward.faction = 1;
    ward.pos.x = flag.pos.x + WARD_FLAG_RADIUS + 0.01;
    expect(wardPullRate(world, flag, 0)).toBe(1);
    ward.pos.x = flag.pos.x + WARD_FLAG_RADIUS;
    expect(wardPullRate(world, flag, 0)).toBe(0.5);
    flag.state = 'loose';
    expect(wardPullRate(world, flag, 0)).toBe(1);
  });

  it('overlapping Wards do not stack and protection stops immediately when disabled', () => {
    const { world, flag, ward } = scenario();
    const second = spawnBuilding(world, 'ward', 1, ward.facet, 1);
    second.pos = { ...ward.pos };
    expect(wardPullRate(world, flag, 0)).toBe(0.5);
    ward.disabled = true;
    expect(wardPullRate(world, flag, 0)).toBe(0.5);
    second.disabled = true;
    expect(wardPullRate(world, flag, 0)).toBe(1);
  });
});
