import gameplayIntroUrl from './assets/flaghack-gameplay-intro-25s.mp4?url';

/** Self-hosted placeholder captured from the actual game; Vite fingerprints the MP4.
 * Replace this source with the owner's original intro when its playable file is supplied.
 * Never fall back to a video-provider iframe or make playback a prerequisite for the game.
 */
export const INTRO_VIDEO_URL: string | null = gameplayIntroUrl;
export const INTRO_VIDEO_HAS_AUDIO = false;
