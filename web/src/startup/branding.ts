import type { DeviceLayout } from './device';

/** Display names only. Keep protocol, storage, URLs and build identifiers shared. */
export function gameDisplayName(layout: DeviceLayout | undefined): string {
  return layout === 'mobile' ? 'Flaghack Gaiden' : 'FLAGHACK∞3D';
}

/** Run with the resolved layout, before loading the game or waiting for the cache. */
export function applyPageBranding(layout: DeviceLayout, page: Document = document): void {
  const name = gameDisplayName(layout);
  page.title = name;
  for (const label of page.querySelectorAll('[data-game-name]')) label.textContent = name;
  for (const overlay of page.querySelectorAll('#startup')) overlay.setAttribute('aria-label', `${name} startup`);
  // These are browser/home-screen label hints, not a separate installable PWA.
  for (const meta of page.querySelectorAll('meta[name="application-name"], meta[name="apple-mobile-web-app-title"]')) {
    meta.setAttribute('content', name);
  }
}
