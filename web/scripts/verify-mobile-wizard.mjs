/** Native touch proof of the production wizard path. Only the offline fixture is staged. */
import assert from 'node:assert/strict';

/** Read-only readiness probe: simulation acknowledgements can precede the throttled DOM render. */
export function mobileWizardReadyAction() {
  const w = window.flaghack.world, session = w.frickFrack.sessions[0];
  if (!session) return false;
  if (session.phase === 'betting') return { phase: session.phase, revision: session.revision };
  if (session.phase !== 'dialogue' || w.time < session.readyAt) return false;
  const overlay = document.querySelector('.ff-overlay');
  const number = overlay?.querySelector('.ff-page-number')?.textContent?.match(/·\s*(\d+)\s*\/\s*(\d+)/);
  if (!number || Number(number[1]) !== session.dialogueIndex + 1) return false;
  const action = Number(number[1]) === Number(number[2]) ? 'play' : 'next';
  const control = overlay.querySelector(`button[data-action="${action}"]`);
  if (!control || control.disabled || !control.getClientRects().length) return false;
  return { phase: session.phase, revision: session.revision, dialogueIndex: session.dialogueIndex, action };
}

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
    // Keep unrelated crafting from obscuring the no-entry-fee inventory proof.
    a.ai.clear(); w.factions[0].lumber = 0;
    // Isolate the tap target, not its input handler or dialogue state.
    for (const id of [...w.hippies.keys()]) if (id !== h.id) w.hippies.delete(id);
    a.session.selection.clear(); a.session.mobileMenu = null; a.session.mobileMode = 'units'; a.session.planTool = 'select';
    a.session.camera.cmdX = h.pos.x; a.session.camera.cmdZ = h.pos.z;
    return { wizardId: h.id, workers: [...w.hippies.values()].filter(unit => unit.faction === 0).length,
      flags: [...w.flags.values()].filter(flag => flag.state === 'stock' && flag.owner === 0).length,
      stockIds: [...w.flags.values()].filter(flag => flag.state === 'stock' && flag.owner === 0).map(flag => flag.id) };
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
  const dialogueTaps = [];
  for (let i = 0; i < 8; i++) {
    const ready = await page.waitForFunction(mobileWizardReadyAction, null, { timeout: 30000 });
    const current = await ready.jsonValue(); await ready.dispose();
    if (current.phase === 'betting') break;
    assert.equal(current.dialogueIndex, dialogueTaps.length, 'Every dialogue page is presented and tapped exactly once');
    const name = current.action === 'next' ? 'Continue' : 'Yes, play Frick-frack';
    await overlay.getByRole('button', { name, exact: true }).tap({ noWaitAfter: true, timeout: 30000 });
    await page.waitForFunction(revision => window.flaghack.world.frickFrack.sessions[0]?.revision > revision, current.revision);
    dialogueTaps.push({ index: current.dialogueIndex, action: current.action, revision: current.revision });
  }
  await page.waitForFunction(() => window.flaghack.world.frickFrack.sessions[0]?.phase === 'betting');
  assert.ok(dialogueTaps.length >= 3); assert.equal(dialogueTaps.at(-1).action, 'play');
  assert.equal(await page.evaluate(() => [...window.flaghack.world.flags.values()].filter(flag => flag.state === 'stock' && flag.owner === 0).length), initial.flags, 'Talking charges no entry fee');
  await capture('wizard-table');
  await overlay.getByRole('button', { name: 'Deal', exact: true }).tap({ noWaitAfter: true });
  await page.waitForFunction(() => ['rolling', 'playing', 'result', 'empty'].includes(window.flaghack.world.frickFrack.sessions[0]?.phase));
  const wager = await page.evaluate(() => window.flaghack.world.frickFrack.sessions[0].wager);
  assert.equal(wager, 1, 'The actual Deal button commits a camp-stock wager');
  assert.equal(await page.evaluate(ids => ids.filter(id => !window.flaghack.world.flags.has(id)).length, initial.stockIds), 1, 'Deal consumes exactly one original camp-stock Flag even if the hand has already settled');
  const exit = overlay.getByRole('button', { name: /Exit.*forfeit wager|Leave table|Return to the burn/ });
  await exit.tap({ noWaitAfter: true });
  await page.waitForFunction(() => !window.flaghack.world.frickFrack.sessions[0]);
  await overlay.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ff-conversation-active')), false);
  return { ...initial, dialogueTaps, wager, portraitAnimated: true, nativeTap: true };
}
