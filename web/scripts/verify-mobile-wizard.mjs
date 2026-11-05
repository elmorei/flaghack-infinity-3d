/** Native touch proof of the production wizard path. Only the offline fixture is staged. */
import assert from 'node:assert/strict';

export async function verifyMobileWizard(page, { capture = async () => {} } = {}) {
  await page.evaluate(() => {
    const a = window.flaghack;
    if (a.net) throw Error('Wizard verification requires an offline fixture');
    a.startMatch({ seed: 'wizard-native', humans: [0], rtsFactions: [0], match: { ...a.session.settings.match, active: [0], bossMode: false, days: 3, startingSignifiers: 0, maxSignifiers: 24 } });
  });
  await page.waitForFunction(() => {
    const a = window.flaghack;
    return a.session.screen === 'playing' && a.ui.world === a.world && a.world.frickFrack.wizardId >= 0;
  }, null, { timeout: 30000 });
  const initial = await page.evaluate(() => {
    const a = window.flaghack, w = a.world, h = w.hippies.get(w.frickFrack.wizardId);
    if (!h) throw Error('RTS match did not create the wizard');
    // Isolate the tap target, not its input handler or dialogue state.
    for (const id of [...w.hippies.keys()]) if (id !== h.id) w.hippies.delete(id);
    a.session.selection.clear(); a.session.mobileMenu = null; a.session.mobileMode = 'units'; a.session.planTool = 'select';
    a.session.camera.cmdX = h.pos.x; a.session.camera.cmdZ = h.pos.z;
    return { wizardId: h.id, workers: [...w.hippies.values()].filter(unit => unit.faction === 0).length,
      flags: [...w.flags.values()].filter(flag => flag.state === 'stock' && flag.owner === 0).length };
  });
  assert.equal(initial.workers, 0); assert.ok(initial.flags > 0);
  await page.waitForTimeout(1800);
  const point = await page.evaluate(() => {
    const a = window.flaghack, w = a.world, h = w.hippies.get(w.frickFrack.wizardId), cam = a.renderer.camera;
    cam.updateMatrixWorld();
    const mul = (m, v) => [0, 1, 2, 3].map(r => m[r] * v[0] + m[r + 4] * v[1] + m[r + 8] * v[2] + m[r + 12] * v[3]);
    const clip = mul(cam.projectionMatrix.elements, mul(cam.matrixWorldInverse.elements, [h.pos.x, w.collision.groundHeight(h.pos.x, h.pos.z) + 1, h.pos.z, 1]));
    return { x: (clip[0] / clip[3] + 1) * innerWidth / 2, y: (1 - clip[1] / clip[3]) * innerHeight / 2 };
  });
  const viewport = page.viewportSize();
  assert.ok(point.x > 0 && point.y > 0 && point.x < viewport.width && point.y < viewport.height, 'The actual wizard projects inside the touch viewport');
  await page.touchscreen.tap(point.x, point.y);
  await page.waitForFunction(() => window.flaghack.world.frickFrack.sessions[0]?.phase === 'dialogue');
  const portrait = page.locator('.ff-overlay.ff-in-world .ff-wizard-portrait');
  await portrait.waitFor({ state: 'visible' });
  const animated = await portrait.evaluate(node => ({
    svg: !!node.querySelector('svg'),
    animations: node.getAnimations({ subtree: true }).map(animation => ({ state: animation.playState, time: animation.currentTime })),
    fits: node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0,
  }));
  assert.ok(animated.svg && animated.fits); assert.ok(animated.animations.some(animation => animation.state === 'running'), 'Wizard portrait animates in the real mobile dialogue');
  await capture('wizard-dialogue');
  const overlay = page.locator('.ff-overlay');
  for (let i = 0; i < 8; i++) {
    const phase = await page.evaluate(() => window.flaghack.world.frickFrack.sessions[0]?.phase);
    if (phase !== 'dialogue') break;
    const current = await page.evaluate(() => window.flaghack.world.frickFrack.sessions[0].revision);
    const continueButton = overlay.getByRole('button', { name: 'Continue', exact: true });
    const next = await continueButton.count() ? continueButton : overlay.getByRole('button', { name: 'Yes, play Frick-frack', exact: true });
    await next.tap({ noWaitAfter: true, timeout: 30000 });
    await page.waitForFunction(revision => window.flaghack.world.frickFrack.sessions[0]?.revision > revision, current);
  }
  await page.waitForFunction(() => window.flaghack.world.frickFrack.sessions[0]?.phase === 'betting');
  assert.equal(await page.evaluate(() => [...window.flaghack.world.flags.values()].filter(flag => flag.state === 'stock' && flag.owner === 0).length), initial.flags, 'Talking charges no entry fee');
  await capture('wizard-table');
  await overlay.getByRole('button', { name: 'Deal', exact: true }).tap({ noWaitAfter: true });
  await page.waitForFunction(() => ['rolling', 'playing', 'result', 'empty'].includes(window.flaghack.world.frickFrack.sessions[0]?.phase));
  const wager = await page.evaluate(() => window.flaghack.world.frickFrack.sessions[0].wager);
  assert.equal(wager, 1, 'The actual Deal button commits a camp-stock wager');
  const exit = overlay.getByRole('button', { name: /Exit.*forfeit wager|Leave table|Return to the burn/ });
  await exit.tap({ noWaitAfter: true });
  await page.waitForFunction(() => !window.flaghack.world.frickFrack.sessions[0]);
  await overlay.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ff-conversation-active')), false);
  return { ...initial, wager, portraitAnimated: true, nativeTap: true };
}
