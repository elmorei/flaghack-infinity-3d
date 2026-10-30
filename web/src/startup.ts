import { BUILD_ID } from './net/build';
import { verifyStartupCache } from './startup/cache';
import { rememberReadyAssets } from './startup/remember';
import { INTRO_VIDEO_URL, MOBILE_INTRO_VIDEO_URL, INTRO_VIDEO_HAS_AUDIO } from './startup/media';
import { StartupOverlay } from './startup/overlay';

import { browserDeviceLayout, useMobileIntro } from './startup/device';

/** Small entry point: paints before the game bundle, fonts, world and GPU are prepared. */
async function start(): Promise<void> {
  const layout = browserDeviceLayout();
  document.documentElement.dataset.deviceLayout = layout;
  const introUrl = useMobileIntro(layout)
    ? MOBILE_INTRO_VIDEO_URL : INTRO_VIDEO_URL;
  const root = document.getElementById('app')!;
  const overlay = new StartupOverlay(document.getElementById('startup')!);
  root.inert = true;
  try {
    // Check before importing, so this visit's new downloads cannot masquerade as a cache hit.
    // Cache availability is not readiness: even warm bytes need CPU/GPU initialization.
    const cached = await verifyStartupCache(BUILD_ID, location.href);
    document.documentElement.dataset.startupCache = cached ? 'hit' : 'miss';
    if (!cached && introUrl) overlay.play(introUrl, INTRO_VIDEO_HAS_AUDIO);
    overlay.setStatus('Loading game code…');
    const { boot, GAME_MODULE_URL } = await import('./main');
    const { app, cacheable } = await boot((message) => overlay.setStatus(message));
    await app.ready;
    overlay.ready();
    if (cacheable) {
      void rememberReadyAssets(BUILD_ID, GAME_MODULE_URL, root);
    }
    // A cold start plays the whole intro unless Skip is chosen after the actual ready signal.
    await overlay.finished;
    app.finishStartup();
    root.inert = false;
    overlay.dispose();
  } catch (error) {
    console.error('FLAGHACK could not start', error);
    overlay.fail();
  }
}

void start();
