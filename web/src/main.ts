import '@fontsource/cinzel/400.css';
import '@fontsource/cinzel/700.css';
import '@fontsource/cinzel-decorative/700.css';
import '@fontsource/rubik/400.css';
import '@fontsource/rubik/500.css';
import '@fontsource/rubik/700.css';
import '@fontsource/stardos-stencil/700.css';
import '@fontsource/bungee/400.css';
import './styles/main.css';
import { App } from './game/app';
import { installDebug } from './game/debug';
import { browserAllowsRemoteHosts, normalizeHostEndpoint, probeHost, takeLocationInvite } from './net/endpoint';
import type { HostInfo } from './net/protocol';

declare global {
  interface Window {
    /** Debug handle for the browser console and automated smoke tests. */
    flaghack?: App;
  }
}

/** A host answers at once; anything slower is not a FLAGHACK host worth waiting for. */
const PROBE_TIMEOUT_MS = 1500;

/** Same-origin discovery preserves host-served pages; invite targets are never contacted here. */
async function discoverHost(): Promise<HostInfo | null> {
  if (!browserAllowsRemoteHosts()) return null;
  try {
    return await probeHost(normalizeHostEndpoint(location.origin, location), { timeoutMs: PROBE_TIMEOUT_MS, checkCompatibility: false });
  } catch { return null; }
}

async function boot(): Promise<void> {
  const invite = takeLocationInvite(location, history);
  // Canvas-lettered textures (GCC banner, signage) need the fonts before first draw.
  const fonts = Promise.all(
    ['700 32px "Stardos Stencil"', '700 32px "Cinzel"', '400 32px "Bungee"', '500 16px "Rubik"'].map((f) =>
      document.fonts.load(f),
    ),
  );
  const [hostInfo] = await Promise.all([discoverHost(), fonts]);
  const root = document.getElementById('app')!;
  const app = new App(root, { hostInfo, invitePassword: invite.password, inviteHost: invite.host, inviteError: invite.error });
  window.flaghack = app;
  installDebug(app);
}

void boot();
