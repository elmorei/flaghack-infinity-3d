/** Runs inside page.evaluate. Emit once, then observe the real engine's next published frame.
 * Do not manually flush particles or change engine time: both would hide rendering bugs. */
export function captureExplosionFrame(events) {
  const r = window.flaghack.renderer;
  const capture = () => {
    const m = r.ctx.scene.getObjectByName('structure-destruction-flame-poofs'), g = m.geometry;
    const rows = Array.from({ length: g.instanceCount }, (_, i) => Array.from({ length: 8 }, (_, j) => {
      const a = g.getAttribute('a' + j); return [a.getX(i), a.getY(i), a.getZ(i), a.getW(i)];
    }));
    return { rows, visible: m.visible, count: g.instanceCount, capacity: g.getAttribute('a0').count,
      bytes: g.getAttribute('a0').data.array.byteLength, geometry: g.uuid, material: m.material.uuid,
      time: m.material.uniforms.uTime.value, quality: r.ctx.quality,
      calls: r.renderer.info.render.calls, triangles: r.renderer.info.render.triangles };
  };
  if (!events) return capture();
  const startTime = r.ctx.time;
  r.onEvents(events);
  return new Promise((resolve, reject) => {
    let settled = false, frames = 0;
    const timeout = setTimeout(() => {
      settled = true;
      const last = capture();
      reject(new Error(`Explosion never reached a visible rendered frame: ${JSON.stringify({ frames, startTime, time: last.time, count: last.count, visible: last.visible })}`));
    }, 5000);
    const observe = () => {
      if (settled) return;
      frames++;
      const sample = capture();
      if (sample.visible && sample.count > 0 && sample.calls > 0 && sample.triangles > 0) {
        settled = true; clearTimeout(timeout); resolve(sample);
      } else requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  });
}
