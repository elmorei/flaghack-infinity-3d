/** Lightweight startup UI. This module deliberately imports no game/render/audio code. */
const MEDIA_STALL_MS = 8_000;

export class StartupOverlay {
  readonly finished: Promise<void>;
  private finish!: () => void;
  private readyToPlay = false;
  private videoDone = true;
  private closed = false;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private lastMediaTime = -1;
  private readonly video: HTMLVideoElement;
  private readonly status: HTMLElement;
  private readonly skip: HTMLButtonElement;
  private readonly sound: HTMLButtonElement;
  private readonly reload: HTMLButtonElement;
  private readonly events = new AbortController();

  constructor(private readonly root: HTMLElement) {
    this.finished = new Promise((resolve) => { this.finish = resolve; });
    root.tabIndex = -1;
    root.focus({ preventScroll: true });
    this.video = root.querySelector<HTMLVideoElement>('#startup-video')!;
    this.status = root.querySelector<HTMLElement>('#startup-status')!;
    this.skip = root.querySelector<HTMLButtonElement>('#startup-skip')!;
    this.sound = root.querySelector<HTMLButtonElement>('#startup-sound')!;
    this.reload = root.querySelector<HTMLButtonElement>('#startup-reload')!;
    const options = { signal: this.events.signal };
    this.skip.addEventListener('click', () => {
      if (this.readyToPlay) this.endVideo();
    }, options);
    this.sound.addEventListener('click', () => this.toggleSound(), options);
    this.reload.addEventListener('click', () => location.reload(), options);
    this.video.addEventListener('ended', () => this.endVideo(true), options);
    this.video.addEventListener('error', () => this.endVideo(), options);
    this.video.addEventListener('waiting', () => this.watchForStall(), options);
    this.video.addEventListener('stalled', () => this.watchForStall(), options);
    this.video.addEventListener('playing', () => this.watchForStall(), options);
    this.video.addEventListener('timeupdate', () => this.watchForStall(), options);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.readyToPlay) {
        event.preventDefault();
        this.endVideo();
      }
    }, options);
  }

  setStatus(message: string): void {
    if (!this.closed && !this.readyToPlay) this.status.textContent = message;
  }

  /** Call only on a cold start. A verified cached start never sets a video src. */
  play(url: string, hasAudio = true): void {
    if (this.closed) return;
    this.videoDone = false;
    this.lastMediaTime = -1;
    this.video.muted = true;
    this.video.defaultMuted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.src = url;
    this.root.dataset.video = 'playing';
    this.sound.hidden = !hasAudio;
    this.watchForStall();
    try {
      void this.video.play().catch(() => this.endVideo());
    } catch {
      this.endVideo();
    }
  }

  ready(): void {
    if (this.closed) return;
    this.readyToPlay = true;
    this.root.setAttribute('aria-busy', 'false');
    this.status.textContent = 'Ready to play';
    this.skip.textContent = 'Skip';
    this.skip.disabled = false;
    this.root.dataset.ready = 'true';
    this.maybeFinish();
  }

  fail(): void {
    if (this.closed) return;
    this.readyToPlay = false;
    this.stopMedia();
    this.status.textContent = 'The game could not start. Check your connection and try reloading.';
    this.skip.hidden = true;
    this.reload.hidden = false;
    this.root.setAttribute('aria-busy', 'false');
    this.root.dataset.ready = 'error';
    this.reload.focus();
  }

  dispose(): void {
    this.closed = true;
    this.stopMedia();
    this.events.abort();
    this.root.remove();
  }

  private toggleSound(): void {
    if (this.videoDone || this.closed || this.sound.hidden) return;
    this.video.muted = !this.video.muted;
    this.updateSound();
    // Keep this operation inside the user's click; autoplay with sound is not assumed.
    try {
      void this.video.play().catch(() => {
        this.video.muted = true;
        this.updateSound();
      });
    } catch {
      this.video.muted = true;
      this.updateSound();
    }
  }

  private updateSound(): void {
    this.sound.textContent = this.video.muted ? 'Sound on' : 'Mute';
    this.sound.setAttribute('aria-pressed', String(!this.video.muted));
  }

  private watchForStall(): void {
    if (this.videoDone || this.closed) return;
    const time = Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
    // Repeated waiting/timeupdate events are not progress. A stalled stream must fail open.
    if (this.watchdog !== undefined && time === this.lastMediaTime) return;
    this.lastMediaTime = time;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      // GPU compilation may have delayed JS while the decoder continued normally.
      if (this.video.currentTime !== this.lastMediaTime) this.watchForStall();
      else this.endVideo();
    }, MEDIA_STALL_MS);
  }

  private stopMedia(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.videoDone = true;
    this.root.dataset.video = 'off';
    this.sound.hidden = true;
    this.video.pause();
    // Drop pending downloads/decoders. No src is assigned on a cache hit, even temporarily.
    if (this.video.hasAttribute('src')) {
      this.video.removeAttribute('src');
      this.video.load();
    }
  }

  private endVideo(holdLastFrame = false): void {
    if (holdLastFrame) {
      // Natural ending on a slow first load keeps the last decoded frame under Loading….
      // Keep its src until readiness; disposal then releases the media as usual.
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
      this.videoDone = true;
      this.sound.hidden = true;
    } else {
      this.stopMedia();
    }
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.readyToPlay && this.videoDone && !this.closed) this.finish();
  }
}
