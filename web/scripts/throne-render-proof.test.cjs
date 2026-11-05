'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {assertThroneRender, readThroneRender} = require('./throne-render-proof.cjs');
const atlas = JSON.parse(readFileSync(join(__dirname, '../src/render/actors/mobileSpriteActions.json'), 'utf8'));
const clip = atlas.clips['beelzebub-crow:seated'], page = atlas.pages[clip.page];
const options = {faction: 1, altarId: 42, kind: 'beelzebub-crow', clip, page, mobile: true};
function fixture(direction = 'front', frame = 0) {
  const row = clip.directionRows[direction], foot = clip.footYByCell?.[row]?.[frame] ?? clip.anchor[1];
  const height = clip.worldHeight, scale = height * 2 / clip.heightPixels, center = [22, 7, 33], yaw = Math.atan2(-22, -33);
  return {faction: 1, altarId: 42, mode: 'rts', avatar: false, mobile: true, ready: true,
    position: [...center], altar: [...center], yaw, expectedYaw: yaw, rootVisible: false, meshes: [],
    calls: [{pose: {id: -100001, x: 22, y: 7, z: 33, yaw, height}, accepted: true, layers: 1}],
    samples: [{id: -100001, kind: options.kind, direction, frame, clip: 'seated', requestedClip: 'seated'}],
    instances: [{center: [...center], rect: [(clip.x + frame * clip.cellWidth) / page.width,
      1 - (clip.y + (row + 1) * clip.cellHeight) / page.height, clip.cellWidth / page.width, clip.cellHeight / page.height],
      size: [clip.cellWidth * scale, clip.cellHeight * scale], offset: [(clip.cellWidth / 2 - clip.anchor[0]) * scale, (foot - clip.cellHeight) * scale, 0]}]};
}
test('all actual combined Crow frames verify exact ground, scale, yaw and uploaded artwork', () => {
  for (const direction of ['front', 'away']) for (let frame = 0; frame < clip.columns; frame++) assertThroneRender(fixture(direction, frame), options);
});
test('grounding and effigy-facing regressions cannot pass through hidden mobile root', () => {
  for (const change of [p => p.position[1] += .5, p => p.calls[0].pose.y += .5,
    p => p.instances[0].center[0] += .1, p => p.instances[0].offset[1] += .1,
    p => p.calls[0].pose.yaw += .1, p => p.yaw += .1, p => p.calls[0].pose.height = 2]) {
    const proof = fixture(); change(proof); assert.throws(() => assertThroneRender(proof, options));
  }
});
test('mobile proof rejects stale 3D furniture, fallback, unloaded or unsubmitted art', () => {
  for (const change of [p => p.rootVisible = true, p => p.meshes.push('throne-black-banners'),
    p => p.calls = [], p => p.calls[0].layers = 0, p => p.ready = false,
    p => p.samples[0].clip = 'idle', p => p.samples[0].placeholder = true,
    p => p.instances = [], p => p.instances[0].rect[0] += .1]) {
    const proof = fixture(); change(proof); assert.throws(() => assertThroneRender(proof, options));
  }
});
test('desktop still requires visible ruler, platform and all throne furniture at the same ground and yaw', () => {
  const proof = fixture(); Object.assign(proof, {mobile: false, rootVisible: true, calls: [],
    meshes: ['platform', 'throne-pipes', 'throne-black-banners', 'throne-faction-stripes', 'rts-seated-avatar-1']});
  assertThroneRender(proof, {...options, mobile: false});
  proof.rootVisible = false; assert.throws(() => assertThroneRender(proof, {...options, mobile: false}));
  proof.rootVisible = true; proof.meshes.pop(); assert.throws(() => assertThroneRender(proof, {...options, mobile: false}));
});
test('browser observation uses actual cast/sample callbacks and restores both even on render failure', () => {
  const cast = () => true, sample = () => {}, s = {cast, sample}, error = Error('fixture render failed');
  const previous = global.window;
  global.window = {flaghack: {world: {hearthOf: () => ({id: 42})}, renderer: {ctx: {shared: {mobileSprites: s}}, render: () => {throw error;}}}};
  try { assert.throws(() => readThroneRender({faction: 1, altarId: 42, page: 0}), e => e === error); assert.equal(s.cast, cast); assert.equal(s.sample, sample); }
  finally { if (previous === undefined) delete global.window; else global.window = previous; }
});

test('native throne proof rejects original size and accidental double scaling', () => {
  for (const factor of [.5, 2]) {
    const proof = fixture();
    proof.instances[0].size = proof.instances[0].size.map(value => value * factor);
    proof.instances[0].offset = proof.instances[0].offset.map(value => value * factor);
    assert.throws(() => assertThroneRender(proof, options));
  }
});
