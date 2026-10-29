/** Presentation only: all devices share the same game, protocol, invite and save state. */
export type DeviceLayout = 'mobile' | 'desktop';
export interface DeviceHints {
  url: string;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  mobileHint?: boolean;
  coarsePointer?: boolean;
  width?: number;
  height?: number;
}

/** Explicit links take precedence. Touchscreen PCs are not automatically treated as phones. */
export function deviceLayout(hints: DeviceHints): DeviceLayout {
  try {
    const requested = new URL(hints.url).searchParams.get('view');
    if (requested === 'mobile' || requested === 'desktop') return requested;
  } catch { /* A malformed URL must not prevent startup. */ }
  const ua = hints.userAgent ?? '';
  const touches = hints.maxTouchPoints ?? 0;
  if (/Android|iPhone|iPad|iPod/i.test(ua) || hints.mobileHint === true) return 'mobile';
  // iPadOS uses a desktop Safari UA, even in landscape and on larger iPads.
  if (/Mac/i.test(hints.platform ?? '') && touches > 1) return 'mobile';
  // Unknown phone browsers: require touch, coarse input and a narrow physical viewport.
  // Exclude recognizable desktops even when their browser window happens to be small.
  const shortSide = Math.min(hints.width ?? Infinity, hints.height ?? Infinity);
  if (!/Windows NT|Macintosh|X11|CrOS/i.test(ua) && touches > 0 &&
      hints.coarsePointer && shortSide <= 600) return 'mobile';
  return 'desktop';
}

export function browserDeviceLayout(): DeviceLayout {
  const nav = globalThis.navigator;
  return deviceLayout({
    url: location.href,
    userAgent: nav?.userAgent,
    platform: nav?.platform,
    maxTouchPoints: nav?.maxTouchPoints,
    mobileHint: (nav as Navigator & { userAgentData?: { mobile?: boolean } })?.userAgentData?.mobile,
    coarsePointer: globalThis.matchMedia?.('(pointer: coarse)').matches,
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  });
}

/** Select once per visit: rotating never restarts a playing intro or downloads a second movie. */
export function usePortraitIntro(layout: DeviceLayout, width: number, height: number): boolean {
  return layout === 'mobile' && width < height;
}
