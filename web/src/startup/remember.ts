import { rememberStartupCache } from './cache';

/** Optional bookkeeping must never hold the loader open or make a valid game fail. */
export async function rememberReadyAssets(build: string, gameModuleUrl: string, root: HTMLElement): Promise<void> {
  try {
    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
    const styles = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
    const requiredAssets = [gameModuleUrl, ...styles.map((style) => style.href),
      ...images.map((image) => image.currentSrc || image.src).filter((url) => !url.startsWith('data:'))];
    // A first rendered frame may precede the title wordmark's download. Do not silently omit
    // that image (or the real game module/styles) and later mistake a partial cache for warm.
    // Let the newly inserted title UI complete a layout before taking FontFaceSet.ready,
    // so CSS-only title faces have actually been requested (ready may already be fulfilled).
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all([document.fonts.ready, ...images.map((image) => image.decode())]);
    // FontFaceSet.ready also resolves after errors. Additional title fonts are requested
    // by CSS beyond boot's explicit canvas fonts; do not omit a failed face from the proof.
    if ([...document.fonts].some((face) => face.status === 'error' || face.status === 'loading')) return;
    rememberStartupCache(build, location.href, performance.getEntriesByType('resource'), { requiredAssets });
  } catch {
    // Missing images, old browser APIs, blocked storage or timing metadata: cold next time.
  }
}
