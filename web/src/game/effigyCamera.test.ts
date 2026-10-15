import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CameraRig } from './cameraRig';
import { effigyCameraTarget } from './effigyCamera';
import { Session } from './session';
import { newMatch } from '../sim/systems/econ/testkit';
import { normalizeMatch } from '../sim/matchSettings';
import { bossRevealTime } from '../sim/effigyBurn';
import { bossAwakeningAge, bossAwakeningLevel } from '../sim/bossPresentation';

function fixture() {
  const { world } = newMatch('effigy-camera');
  world.options.match = normalizeMatch({ bossMode: true, days: 0 });
  world.suddenDeath = true;
  const reveal = bossRevealTime(world.options);
  world.time = reveal - 6;
  const session = new Session(), rig = new CameraRig(), camera = new PerspectiveCamera();
  const avatar = world.avatarOf(0);
  const frame = (dt = 1 / 60, blend = 0) => {
    rig.updatePlay(world, avatar, 0, session.camera, blend, null, false, false, dt);
    rig.apply(camera, 0, dt);
  };
  rig.setMode('play', 0);
  return { world, reveal, session, rig, camera, avatar, frame };
}

describe('local effigy emergence camera', () => {
  it('locks only for the five-second rise and one-second whiteout', () => {
    const { world, reveal } = fixture();
    for (const offset of [-6, -5.001, 1, 1.001, 5, 100]) {
      world.time = reveal + offset;
      expect(effigyCameraTarget(world)).toBeNull();
    }
    for (const offset of [-5, -2.5, 0, 0.4, 0.999]) {
      world.time = reveal + offset;
      expect(effigyCameraTarget(world)).not.toBeNull();
    }
    world.effigyRevealedAt = reveal + 0.25;
    world.time = reveal + 1.1;
    expect(effigyCameraTarget(world)).not.toBeNull();
    world.time = reveal + 1.25;
    expect(effigyCameraTarget(world)).toBeNull();
  });

  it.each([90, 90.25, 370])('releases at the actual whiteout endpoint %s, while keeping the announcement', revealAt => {
    const { world } = fixture();
    world.effigyRevealedAt = revealAt;
    world.time = revealAt + 0.999;
    expect(bossAwakeningLevel(world)).toBeGreaterThan(0);
    expect(effigyCameraTarget(world)).not.toBeNull();
    world.time = revealAt + 1;
    expect(bossAwakeningLevel(world)).toBe(0);
    expect(effigyCameraTarget(world)).toBeNull();
    expect(bossAwakeningAge(world)).toBe(1);
  });

  it('uses authoritative late-join timing without replaying a completed reveal', () => {
    const { world, reveal, frame, camera } = fixture();
    world.effigyRevealedAt = reveal;
    world.time = reveal + 0.3;
    for (let i = 0; i < 75; i++) frame();
    const target = effigyCameraTarget(world)!;
    expect(camera.getWorldDirection(new Vector3()).dot(new Vector3(target.x, target.y, target.z).sub(camera.position).normalize())).toBeCloseTo(1, 8);
    world.time = reveal + 1;
    expect(effigyCameraTarget(world)).toBeNull();
    frame();
  });

  it.each([1, 1.001, 3, 5])('does not relock on a late join or reconnect at reveal + %s', age => {
    const { world, reveal, rig, frame, session } = fixture();
    world.effigyRevealedAt = reveal;
    world.time = reveal + age;
    rig.resetFollow();
    session.camera.yaw = 1.4;
    frame();
    expect(effigyCameraTarget(world)).toBeNull();
    expect(session.camera.yaw).toBe(1.4);
    expect(rig.pose.yaw).toBeCloseTo(1.4);
  });

  it('turns smoothly, tracks the rising target, then retains the new action heading', () => {
    const { world, reveal, frame, session, rig, camera } = fixture();
    frame();
    const initial = rig.pose.yaw;
    world.time = reveal - 5;
    frame();
    expect(Math.abs(rig.pose.yaw - initial)).toBeLessThan(0.01);
    for (let i = 1; i <= 350; i++) {
      world.time = reveal - 5 + i / 60;
      frame();
      if (i > 70) {
        const target = effigyCameraTarget(world)!;
        expect(camera.getWorldDirection(new Vector3()).dot(new Vector3(target.x, target.y, target.z).sub(camera.position).normalize())).toBeCloseTo(1, 8);
      }
    }
    const heading = session.camera.yaw;
    expect(Math.abs(heading - initial)).toBeGreaterThan(0.1);
    world.time = reveal + 1;
    for (let i = 0; i < 90; i++) frame();
    expect(session.camera.yaw).toBe(heading);
    expect(rig.pose.yaw).toBeCloseTo(heading);
    session.camera.yaw += 0.2;
    frame();
    expect(rig.pose.yaw).toBeCloseTo(heading + 0.2);
  });

  it.each(['command', 'flagless'] as const)('preserves and restores %s camera mode', mode => {
    const { world, reveal, frame, rig, avatar, session } = fixture();
    const blend = mode === 'command' ? 1 : 0;
    if (mode === 'flagless') avatar.koUntil = Infinity;
    rig.snapCommand(session.camera);
    frame(1 / 60, blend);
    const originalPitch = rig.pose.pitch;
    world.time = reveal;
    for (let i = 0; i < 75; i++) frame(1 / 60, blend);
    expect(rig.pose.pitch).not.toBeCloseTo(originalPitch);
    world.time = reveal + 1;
    for (let i = 0; i < 90; i++) frame(1 / 60, blend);
    expect(rig.pose.pitch).toBeCloseTo(originalPitch);
    if (mode === 'command') expect(rig.pose.yaw).toBe(Math.PI);
  });

  it('focuses every local seat independently without changing avatar or simulation state', () => {
    const { world, reveal } = fixture();
    world.time = reveal + 0.5;
    world.effigyRevealedAt = reveal;
    const before = [...world.avatars.values()].map(a => ({ pos: { ...a.pos }, yaw: a.yaw, pitch: a.pitch }));
    const headings: number[] = [];
    for (const faction of [0, 1, 2, 3] as const) {
      const rig = new CameraRig(), session = new Session(), camera = new PerspectiveCamera();
      for (let i = 0; i < 75; i++) rig.updatePlay(world, world.avatarOf(faction), faction, session.camera, 0, null, false, false, 1 / 60);
      rig.apply(camera, 0, 0);
      const target = effigyCameraTarget(world)!;
      expect(camera.getWorldDirection(new Vector3()).dot(new Vector3(target.x, target.y, target.z).sub(camera.position).normalize())).toBeCloseTo(1, 8);
      headings.push(session.camera.yaw);
    }
    expect(new Set(headings.map(yaw => yaw.toFixed(2))).size).toBe(4);
    expect([...world.avatars.values()].map(a => ({ pos: { ...a.pos }, yaw: a.yaw, pitch: a.pitch }))).toEqual(before);
    expect(world.time).toBe(reveal + 0.5);
  });

  it('cancels on reset, end, tutorial, disabled encounter and invalid clocks', () => {
    const { world, reveal, rig, frame, session } = fixture();
    world.time = reveal;
    frame();
    world.phase = 'ended'; expect(effigyCameraTarget(world)).toBeNull();
    world.phase = 'playing'; world.options.mode = 'tutorial'; expect(effigyCameraTarget(world)).toBeNull();
    world.options.mode = 'standard'; world.options.match!.bossMode = false; expect(effigyCameraTarget(world)).toBeNull();
    world.options.match!.bossMode = true;
    for (const time of [NaN, Infinity, -Infinity]) { world.time = time; expect(effigyCameraTarget(world)).toBeNull(); }
    world.time = 0; world.suddenDeath = false;
    rig.resetFollow(); session.camera.yaw = 1.4;
    frame(); expect(rig.pose.yaw).toBeCloseTo(1.4);
  });
});
