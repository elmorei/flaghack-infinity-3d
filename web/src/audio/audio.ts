/**
 * WebAudio with licensed cached boss vocals and procedural synthesis: festival soundscape, generative pentatonic music with
 * tension layers, positional event SFX (plant chimes, pulls, throws, swings, ley hums,
 * crystal choir, phason glass glitches, discharges, capture alarms, Burn fireworks, UI blips).
 * Owner: Audio agent.
 *
 * The AudioContext is created on the first user gesture (pointer/key) or by App.startMatch.
 * Per frame: listener = camera, bus volumes from Session settings, the Soundscape is measured
 * around the listener (5 Hz) and smoothed, music + ambience follow it, finished voices free.
 */
import type { AppApi } from '../game/app';
import type { NetSession, NetStatus } from '../net/session';
import type { ChatLine } from '../net/protocol';
import type { GameEvent } from '../sim/events';
import type { World } from '../sim/world';
import { Ambience } from './ambience';
import { BossAudio } from './boss';
import { Cues } from './cues';
import { AudioEngine } from './engine';
import { MENTOR_CHARS_PER_SEC, MentorVoice } from './mentor';
import { Music } from './music';
import { Sfx, type Perspective } from './sfx';
import { approach, createSoundscape, measure, type Soundscape } from './soundscape';

const MEASURE_INTERVAL = 0.2;
const ALARM_INTERVAL = 4;

export interface AudioStats {
  state: AudioContextState | 'locked';
  sampleRate: number;
  baseLatency: number;
  outputLatency: number;
  activeVoices: number;
  maxVoices: number;
  trackedGroups: number;
  started: number;
  rateDropped: number;
  stolen: number;
  capDropped: number;
  inaudible: number;
  /** Main-thread cost of audio per frame (ms, smoothed). */
  jsMs: number;
  soundscape: Soundscape;
}

interface Parts {
  engine: AudioEngine;
  sfx: Sfx;
  boss: BossAudio;
  music: Music;
  ambience: Ambience;
  mentor: MentorVoice;
  cues: Cues;
}

/** What the online watcher last saw of `app.net` (sounds fire on changes only). */
interface NetSeen {
  net: NetSession;
  version: number;
  status: NetStatus;
  reconnecting: boolean;
  inMatch: boolean;
  lastChat: ChatLine | null;
  /** Connected players other than us. */
  others: Set<string>;
}

export class GameAudio {
  private app: AppApi;
  private parts: Parts | null = null;
  private target = createSoundscape();
  private live = createSoundscape();
  private measureTimer = 0;
  private world: World | null = null;
  private perspective: Perspective = { me: -1, myAvatar: -1 };
  private alarmTimer = 0;
  private fireworkTimer = 0;
  /** Audio main-thread time accumulated this frame, and its smoothed average. */
  private jsMs = 0;
  private jsMsAvg = 0;
  private netSeen: NetSeen | null = null;
  /** Scratch set for the per-change player diff (swapped with NetSeen.others). */
  private othersScratch = new Set<string>();

  constructor(app: AppApi) {
    this.app = app;
    const onGesture = (event: Event): void => {
      // Holding Enter to skip the intro must not unlock audio when that press repeats
      // after startup releases. Require a fresh key press (pointer gestures are unchanged).
      if (event.type === 'keydown' && (event as KeyboardEvent).repeat) return;
      // Browser interruptions and rejected autoplay resumes can suspend audio again.
      // Keep the gesture path available; unlock is a no-op while already running.
      this.unlock();
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  /** Create/resume the AudioContext (must follow a user gesture). */
  unlock(): void {
    // The intro's Sound/Skip buttons own their gestures, not the game's global listeners.
    if (this.app.startupPending) return;
    if (!this.parts) {
      const engine = new AudioEngine();
      this.parts = {
        engine,
        sfx: new Sfx(engine),
        boss: new BossAudio(engine),
        music: new Music(engine),
        ambience: new Ambience(engine),
        mentor: new MentorVoice(engine),
        cues: new Cues(engine),
      };
    }
    const ctx = this.parts.engine.ctx;
    if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => { /* Retry on the next gesture. */ });
  }

  onEvents(events: GameEvent[]): void {
    if (this.app.startupPending) return;
    const parts = this.parts;
    const w = this.app.world;
    if (!parts || !w || parts.engine.ctx.state !== 'running' || events.length === 0) return;
    const t0 = performance.now();
    this.syncWorld(w, parts);
    for (const e of events) parts.sfx.play(e, w, this.perspective);
    const screen = this.app.session.screen;
    if (screen === 'playing' || screen === 'ended') parts.boss.onEvents(events);
    this.jsMs += performance.now() - t0;
  }

  update(dt: number): void {
    if (this.app.startupPending) return;
    const parts = this.parts;
    if (!parts || parts.engine.ctx.state !== 'running') return;
    const t0 = performance.now();
    const { engine, music, ambience, sfx } = parts;
    const session = this.app.session;
    // The lobby gets the calm title variant of the music too.
    const title = session.screen === 'title' || session.screen === 'lobby';
    engine.setVolumes(session.settings, session.screen === 'paused', title ? 0.55 : 1);
    this.watchNet(parts.cues);
    const cam = this.app.renderer.camera;
    engine.setListener(cam.position.x, cam.position.y, cam.position.z, cam.matrixWorld.elements);

    const w = this.app.world;
    if (!w || session.screen === 'title' || session.screen === 'lobby' || session.screen === 'paused') parts.boss.tracker.reset();
    if (w) {
      this.syncWorld(w, parts);
      if (!title && session.screen !== 'paused') parts.boss.tracker.update(w.boss, w.time, w.phase === 'playing');
      this.measureTimer -= dt;
      if (this.measureTimer <= 0) {
        this.measureTimer = MEASURE_INTERVAL;
        const rctx = this.app.renderer.ctx;
        measure(w, session, engine, rctx ? rctx.daylight : null, this.target);
      }
      this.smooth(dt);
      music.update(this.live, dt);
      ambience.update(this.live, dt);

      const running = session.screen === 'playing';
      if (running && this.live.alarm) {
        this.alarmTimer -= dt;
        if (this.alarmTimer <= 0) {
          this.alarmTimer = ALARM_INTERVAL;
          sfx.alarm(0.4);
        }
      } else this.alarmTimer = ALARM_INTERVAL;

      if (w.suddenDeath && (running || title)) {
        this.fireworkTimer -= dt;
        if (this.fireworkTimer <= 0) {
          this.fireworkTimer = 0.5 + Math.random() * 1.6;
          const eff = w.map.effigy;
          const a = Math.random() * Math.PI * 2;
          const r = 10 + Math.random() * 45;
          sfx.firework({ x: eff.x + Math.cos(a) * r, z: eff.z + Math.sin(a) * r }, 0);
        }
      }
    }
    engine.prune();
    this.jsMs += performance.now() - t0;
    // Smoothed per-frame cost (events + update) for stats().
    this.jsMsAvg = this.jsMsAvg * 0.95 + this.jsMs * 0.05;
    this.jsMs = 0;
  }

  /** New match or back to title: per-match musical state resets, perspective follows the player. */
  private syncWorld(w: World, parts: Parts): void {
    const screen = this.app.session.screen;
    const title = screen === 'title' || screen === 'lobby';
    if (w !== this.world) {
      this.world = w;
      parts.music.reset();
      parts.boss.tracker.reset();
      this.measureTimer = 0;
      this.fireworkTimer = 2;
    }
    const me = this.app.session.playerFaction;
    const fs = w.factions[me];
    this.perspective.me = title ? -1 : me;
    this.perspective.myAvatar = title || !fs ? -1 : fs.avatarId;
  }

  private smooth(dt: number): void {
    const s = this.live;
    const g = this.target;
    s.mode = g.mode;
    s.alarm = g.alarm;
    s.tension = approach(s.tension, g.tension, 0.6, dt);
    s.night = approach(s.night, g.night, 0.4, dt);
    s.burn = approach(s.burn, g.burn, 0.5, dt);
    s.fest = approach(s.fest, g.fest, 2, dt);
    s.festPan = approach(s.festPan, g.festPan, 3, dt);
    s.drum = approach(s.drum, g.drum, 2, dt);
    s.drumPan = approach(s.drumPan, g.drumPan, 3, dt);
    s.flags = approach(s.flags, g.flags, 2, dt);
    s.crowd = approach(s.crowd, g.crowd, 1, dt);
    s.fire = approach(s.fire, g.fire, 0.5, dt);
    s.firePan = approach(s.firePan, g.firePan, 3, dt);
  }

  /**
   * Audible festival beat (beats at FESTIVAL_BPM; integer = a sound-camp kick), or null while
   * audio is locked/suspended. The renderer phase-locks RenderContext.beat to this.
   */
  beat(): number | null {
    if (this.app.startupPending) return null;
    return this.parts ? this.parts.music.beat() : null;
  }

  /** Engine diagnostics for the debug overlay / perf evals. */
  stats(): AudioStats {
    const p = this.parts;
    const ctx = p?.engine.ctx;
    return {
      state: ctx ? ctx.state : 'locked',
      sampleRate: ctx ? ctx.sampleRate : 0,
      baseLatency: ctx ? ctx.baseLatency : 0,
      outputLatency: ctx ? ctx.outputLatency : 0,
      activeVoices: p ? p.engine.activeVoices : 0,
      maxVoices: p ? p.engine.maxVoices : 0,
      trackedGroups: p ? p.engine.trackedCount : 0,
      started: p ? p.engine.stats.started : 0,
      rateDropped: p ? p.engine.stats.rateDropped : 0,
      stolen: p ? p.engine.stats.stolen : 0,
      capDropped: p ? p.engine.stats.capDropped : 0,
      inaudible: p ? p.engine.stats.inaudible : 0,
      jsMs: this.jsMsAvg,
      soundscape: { ...this.live },
    };
  }

  /** Parts when audio is unlocked and running, else null (every cue is a no-op then). */
  private ready(): Parts | null {
    if (this.app.startupPending) return null;
    return this.parts && this.parts.engine.ctx.state === 'running' ? this.parts : null;
  }

  /**
   * Online sounds come from `app.net` changes, so the UI never has to call them: chat lines
   * from others, players connecting/leaving, the link dropping/returning, the burn starting.
   * The first look at a session only records state (joining a full lobby is silent).
   */
  private watchNet(cues: Cues): void {
    const net = this.app.net;
    if (!net) {
      this.netSeen = null;
      return;
    }
    const seen = this.netSeen;
    if (seen && seen.net === net && seen.version === net.version) return;
    const others = this.othersScratch;
    others.clear();
    for (const p of net.lobby?.players ?? []) if (p.connected && p.id !== net.playerId) others.add(p.id);
    const inMatch = net.lobby?.phase === 'playing';
    const lastChat = net.chat.length ? net.chat[net.chat.length - 1] : null;
    if (!seen || seen.net !== net) {
      this.othersScratch = new Set<string>();
      this.netSeen = { net, version: net.version, status: net.status, reconnecting: net.reconnecting, inMatch, lastChat, others };
      return;
    }
    let chatFromOthers = false;
    for (let i = net.chat.length - 1; i >= 0 && net.chat[i] !== seen.lastChat; i--) {
      const line = net.chat[i];
      if (line.from !== null && line.playerId !== net.playerId) chatFromOthers = true;
    }
    let joined = false;
    for (const id of others) if (!seen.others.has(id)) joined = true;
    let left = false;
    for (const id of seen.others) if (!others.has(id)) left = true;

    const dropped = (net.reconnecting && !seen.reconnecting) || (net.status === 'closed' && seen.status !== 'closed' && net.error !== null && !seen.reconnecting);
    if (dropped) cues.connectionLost();
    else if (!net.reconnecting && seen.reconnecting && net.status !== 'closed') cues.reconnected();
    if (inMatch && !seen.inMatch) cues.matchStarting();
    if (joined) cues.playerJoined();
    if (left && !dropped) cues.playerLeft();
    if (chatFromOthers) cues.chatBlip();

    this.othersScratch = seen.others;
    seen.others = others;
    seen.version = net.version;
    seen.status = net.status;
    seen.reconnecting = net.reconnecting;
    seen.inMatch = inMatch;
    seen.lastChat = lastChat;
  }

  // ── Training Burn (for ui/tutorial and tutorial/*) ─────────────────────────
  /**
   * The Vexillosaint speaks `text` (markup ignored) as warm procedural babble, one syllable
   * per ~2.5 visible characters, timed to a typewriter revealing `charsPerSecond` visible
   * characters per second. Replaces any line still being spoken; the music dips under it.
   * Returns the spoken length in seconds (0 before unlock or when there are no words).
   */
  mentorSpeak(text: string, charsPerSecond = MENTOR_CHARS_PER_SEC): number {
    return this.ready()?.mentor.speak(text, charsPerSecond) ?? 0;
  }

  /** Cut the Vexillosaint off (line skipped, lesson changed, tutorial closed). */
  mentorStop(): void {
    this.parts?.mentor.stop();
  }

  /** A Seal of Flagistan is earned for lesson `index` (0-based; the fanfare climbs with it). */
  sealAwarded(index: number): void {
    this.ready()?.cues.sealAwarded(index);
  }

  /** The Seal of Flagistan is whole: the Training Burn is complete. */
  graduation(): void {
    this.ready()?.cues.graduation();
  }

  // ── Online burn (played automatically from app.net; public for other callers) ──
  chatBlip(): void {
    this.ready()?.cues.chatBlip();
  }

  playerJoined(): void {
    this.ready()?.cues.playerJoined();
  }

  playerLeft(): void {
    this.ready()?.cues.playerLeft();
  }

  connectionLost(): void {
    this.ready()?.cues.connectionLost();
  }

  reconnected(): void {
    this.ready()?.cues.reconnected();
  }

  matchStarting(): void {
    this.ready()?.cues.matchStarting();
  }

  // ── UI blips (for ui/*) ────────────────────────────────────────────────────
  uiHover(): void {
    this.ready()?.sfx.uiHover();
  }

  uiClick(): void {
    this.ready()?.sfx.uiClick();
  }

  uiConfirm(): void {
    this.ready()?.sfx.uiConfirm();
  }

  uiBack(): void {
    this.ready()?.sfx.uiBack();
  }

  uiToggle(on: boolean): void {
    this.ready()?.sfx.uiToggle(on);
  }

  uiError(): void {
    this.ready()?.sfx.uiError();
  }
}
