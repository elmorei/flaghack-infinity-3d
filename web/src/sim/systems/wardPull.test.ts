import { describe, expect, it } from 'vitest';
import { AVATAR, HIPPIE, SIM_DT, WARD_FLAG_RADIUS } from '../constants';
import { spawnBuilding, spawnCrystal } from '../factory';
import { cmdPull, updateAvatars } from './avatars';
import { defendedPullRate } from './flags';
import { newMatch } from './rules/testWorld';
import { act } from './units/act';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';

function scenario(defense: 'ward' | 'crystal' = 'ward') {
  const world = newMatch('ward-pull');
  const flag = [...world.flags.values()].find(f => f.owner === 1 && f.state === 'planted')!;
  const ward = spawnBuilding(world, 'ward', 1, world.hearthOf(1)!.facet, 1);
  ward.pos = { x: flag.pos.x + 5, z: flag.pos.z };
  if (defense === 'crystal') {
    ward.disabled = true;
    const crystal = spawnCrystal(world, flag.node, 1, [flag.node]);
    crystal.growth = 1;
    crystal.pos = { ...ward.pos };
  }
  return { world, flag, ward };
}

describe('Ward lightning protecting Flags', () => {
  it.each(['ward', 'crystal'] as const)('%s doubles an enemy avatar pull and sends lightning to the Flag', defense => {
    const { world, flag, ward } = scenario(defense);
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
    const lightning = world.drainEvents().filter(e => e.t === 'wardLightning' || e.t === 'crystalLightning');
    expect(lightning.length).toBeGreaterThan(1);
    expect(lightning[0]).toMatchObject({ flagId: flag.id,
      from: { x: ward.pos.x, z: ward.pos.z }, to: { x: flag.pos.x, z: flag.pos.z } });
    step(AVATAR.pullEnemyTime * 0.5 + SIM_DT);
    expect(flag.state).toBe('carried');
    expect(flag.holder).toBe(av.id);
  });

  it.each(['ward', 'crystal'] as const)('%s doubles an enemy hippie pull', defense => {
    const { world, flag } = scenario(defense);
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
    expect(defendedPullRate(world, flag, 0)).toBe(0.5);
    expect(defendedPullRate(world, flag, 1)).toBe(1);
    ward.disabled = true;
    expect(defendedPullRate(world, flag, 0)).toBe(1);
    ward.disabled = false;
    ward.built = 0.5;
    expect(defendedPullRate(world, flag, 0)).toBe(1);
    ward.built = 1;
    ward.faction = 0;
    expect(defendedPullRate(world, flag, 0)).toBe(1);
    ward.faction = 1;
    ward.pos.x = flag.pos.x + WARD_FLAG_RADIUS + 0.01;
    expect(defendedPullRate(world, flag, 0)).toBe(1);
    ward.pos.x = flag.pos.x + WARD_FLAG_RADIUS;
    expect(defendedPullRate(world, flag, 0)).toBe(0.5);
    flag.state = 'loose';
    expect(defendedPullRate(world, flag, 0)).toBe(1);
  });

  it('Crystal and Ward lightning do not stack, and growing or shattered Crystals do not defend', () => {
    const { world, flag, ward } = scenario();
    const crystal = spawnCrystal(world, flag.node, 1, [flag.node]);
    crystal.growth = 1;
    expect(defendedPullRate(world, flag, 0, true)).toBe(0.5);
    expect(world.drainEvents().filter(e => e.t === 'crystalLightning' || e.t === 'wardLightning')).toHaveLength(1);
    ward.disabled = true;
    crystal.growth = 0.5;
    expect(defendedPullRate(world, flag, 0)).toBe(1);
    crystal.growth = 1;
    world.crystals.delete(crystal.id);
    expect(defendedPullRate(world, flag, 0)).toBe(1);
  });

  it('overlapping Wards do not stack and protection stops immediately when disabled', () => {
    const { world, flag, ward } = scenario();
    const second = spawnBuilding(world, 'ward', 1, ward.facet, 1);
    second.pos = { ...ward.pos };
    expect(defendedPullRate(world, flag, 0)).toBe(0.5);
    ward.disabled = true;
    expect(defendedPullRate(world, flag, 0)).toBe(0.5);
    second.disabled = true;
    expect(defendedPullRate(world, flag, 0)).toBe(1);
  });
});
