'use strict';
const assert = require('node:assert/strict');

/** Serialized into native Chrome. Observe one production render, without changing
 * simulation, visibility, or animation. Capture callbacks rather than the bounded
 * debug sample list, which can be filled by scenery before rulers are submitted. */
function readThroneRender({faction, altarId, page}) {
  const a = window.flaghack, g = a.renderer, w = a.world, s = g.ctx.shared.mobileSprites;
  const altar = w.hearthOf(faction), calls = [], samples = [];
  if (!altar || altar.id !== altarId) throw Error('Expected owned throne altar is missing');
  if (s) {
    const cast = s.cast, sample = s.sample;
    s.cast = function(index, pose, clip) {
      const before = this.layerCount, accepted = cast.call(this, index, pose, clip);
      if (index === faction && clip === 'seated') calls.push({pose: {...pose}, accepted, layers: this.layerCount - before});
      return accepted;
    };
    s.sample = function(value) {
      if (value.id === -100000 - faction) samples.push({...value});
      return sample.call(this, value);
    };
    try { g.render(0); } finally { s.cast = cast; s.sample = sample; }
  } else g.render(0);
  const root = g.ctx.scene.getObjectByName(`rts-ruler-${faction}`);
  if (!root) throw Error('Throne presentation root is missing');
  const visible = o => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
  const meshes = [];
  root.traverse(o => { if (o.isMesh && visible(o)) meshes.push(o.name || o.type); });
  const ground = g.ctx.shared.groundOffset?.(altar.pos.x, altar.pos.z) ?? w.collision.groundHeight(altar.pos.x, altar.pos.z);
  const batch = s?.meshes.find(m => m.name === `mobile-sprite-actions-${page}`), instances = [];
  if (batch && visible(batch)) {
    const attrs = batch.geometry.attributes;
    for (let i = 0; i < batch.geometry.instanceCount; i++) {
      const center = Array.from(attrs.aCenter.array.slice(i * 3, i * 3 + 3));
      if (Math.hypot(center[0] - altar.pos.x, center[1] - ground, center[2] - altar.pos.z) < .001) {
        instances.push({center, rect: Array.from(attrs.aRect.array.slice(i * 4, i * 4 + 4)),
          size: Array.from(attrs.aSize.array.slice(i * 2, i * 2 + 2)), offset: Array.from(attrs.aOffset.array.slice(i * 3, i * 3 + 3))});
      }
    }
  }
  return {faction, altarId: altar.id, mode: w.factions[faction].controlMode, avatar: !!w.avatarOf(faction),
    mobile: !!s, ready: s?.actionAtlasReady ?? false, position: root.position.toArray(), yaw: root.rotation.y,
    altar: [altar.pos.x, ground, altar.pos.z], expectedYaw: Math.atan2(w.map.effigy.x - altar.pos.x, w.map.effigy.z - altar.pos.z),
    rootVisible: visible(root), meshes, calls, samples, instances};
}

/** Same strict positioning contract for mobile sprites and original desktop models. */
function assertThroneRender(proof, {faction, altarId, kind, clip, page, mobile}) {
  const near = (actual, expected, label, epsilon = 1e-4) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < epsilon, label);
  const point = (actual, expected, label) => { assert.equal(actual.length, expected.length); actual.forEach((n, i) => near(n, expected[i], `${label} axis ${i}`)); };
  const yaw = actual => near(Math.cos(actual - proof.expectedYaw), 1, 'Throne faces the actual effigy', 1e-8);
  assert.equal(proof.mobile, mobile, 'Expected renderer mode is active');
  assert.equal(proof.faction, faction); assert.equal(proof.altarId, altarId);
  assert.equal(proof.mode, 'rts'); assert.equal(proof.avatar, false, 'Seated ruler has no roaming avatar');
  point(proof.position, proof.altar, 'Throne root remains at exact altar ground'); yaw(proof.yaw);
  if (!mobile) {
    assert.equal(proof.rootVisible, true, 'Desktop throne remains visible');
    assert.ok(proof.meshes.length >= 5, 'Desktop retains ruler, platform and three furniture meshes');
    assert.equal(proof.calls.length, 0); return;
  }
  assert.equal(clip.includesFurniture, true, 'Seated art includes the whole throne');
  assert.equal(proof.ready, true); assert.equal(proof.rootVisible, false);
  assert.deepEqual(proof.meshes, [], 'Mobile must not expose any 3D throne furniture or ruler');
  assert.equal(proof.calls.length, 1, 'Production renderer submits one combined throne');
  const {pose, accepted, layers} = proof.calls[0];
  assert.equal(accepted, true); assert.equal(layers, 1);
  assert.equal(pose.id, -100000 - faction); point([pose.x, pose.y, pose.z], proof.altar, 'Sprite is anchored at exact altar ground');
  yaw(pose.yaw); near(pose.height, clip.worldHeight, 'Combined throne has full assembly height');
  assert.equal(proof.samples.length, 1);
  const sample = proof.samples[0];
  assert.equal(sample.kind, kind); assert.equal(sample.clip, 'seated'); assert.equal(sample.requestedClip, 'seated');
  assert.ok(!sample.placeholder, 'Loaded throne cannot silently use placeholder art');
  const row = clip.directionRows[sample.direction], foot = clip.footYByCell?.[row]?.[sample.frame] ?? clip.anchor[1];
  assert.ok(Number.isInteger(row) && sample.frame >= 0 && sample.frame < clip.columns, 'Real seated frame and facing selected');
  const rect = [(clip.x + sample.frame * clip.cellWidth) / page.width,
    1 - (clip.y + (row + 1) * clip.cellHeight) / page.height, clip.cellWidth / page.width, clip.cellHeight / page.height];
  const instance = proof.instances.find(i => i.rect.every((n, j) => Math.abs(n - rect[j]) < 1e-6));
  assert.ok(instance, 'Combined seated frame is uploaded to the visible GPU sprite batch');
  point(instance.center, proof.altar, 'GPU sprite center remains at altar ground');
  const scale = pose.height * 2 / clip.heightPixels;
  point(instance.size, [clip.cellWidth * scale, clip.cellHeight * scale], 'GPU throne uses exactly doubled artwork scale');
  near((clip.anchor[0] / clip.cellWidth - .5) * instance.size[0] + instance.offset[0], 0, 'Artwork anchor X remains on altar');
  near((1 - foot / clip.cellHeight) * instance.size[1] + instance.offset[1], 0, 'Artwork ground edge remains on altar');
}

module.exports = {readThroneRender, assertThroneRender};
