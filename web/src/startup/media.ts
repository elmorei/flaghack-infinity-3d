import mobileIntroUrl from './assets/flaghack-improved-intro-mobile.mp4?url';
import desktopIntroUrl from './assets/flaghack-improved-intro.mp4?url';
/** Owner-supplied film, original speed/duration and audio, fingerprinted by Vite. */
export const INTRO_VIDEO_URL: string | null = desktopIntroUrl;
export const INTRO_VIDEO_HAS_AUDIO = true;
/** Square mobile crop, selected once per visit in either orientation. */
export const MOBILE_INTRO_VIDEO_URL: string | null = mobileIntroUrl;
