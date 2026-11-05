'use strict';
/** Skip an optional startup animation, accepting only its confirmed natural completion.
 * A detached Skip button is not an application failure when the real title is ready. */
async function finishNativeStartup(page) {
  await page.waitForFunction(() => document.querySelector('#startup[data-ready="true"]') || window.flaghack && !window.flaghack.startupPending, null, { timeout: 180_000 });
  if (await page.locator('#startup').count()) {
    try {
      await page.getByRole('button', { name: 'Skip', exact: true }).click({ noWaitAfter: true, timeout: 2000 });
    } catch (error) {
      const finished = await page.evaluate(() => !document.querySelector('#startup') && window.flaghack?.session.screen === 'title' && !window.flaghack.startupPending);
      if (!finished) throw error;
    }
  }
  await page.locator('#startup').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.flaghack?.session.screen === 'title' && !window.flaghack.startupPending);
}
module.exports = { finishNativeStartup };
