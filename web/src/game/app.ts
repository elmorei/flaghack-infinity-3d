/**
 * App: owns the lifecycle and the frame loop. Local burns (title attract, single player, the
 * Training Burn) step the Simulation here. Online burns mirror the host's World (net/*): the
 * client never steps a Simulation, it sends one input per local tick, predicts its own
 * vexillomancer and renders the replicated world. GameEvents fan out to render, ui and audio
 * the same way in both modes.
 */
import { createAi, type AiController } from '../ai';
import { GameAudio } from '../audio/audio';
import { NetClient, hostSocketUrl } from '../net/client';
import type { NetClientHooks, TokenStore } from '../net/client';
import type { FullSnapshot } from '../net/codec';
import { NetMirror } from '../net/mirror';
import { AvatarPredictor } from '../net/predict';
import { MAX_FRAME_COMMANDS } from '../net/protocol';
import type { HostInfo, LobbyState } from '../net/protocol';
import type { NetSession } from '../net/session';
import { GameRenderer } from '../render/renderer';
import type { Command } from '../sim/commands';
import { SIM_DT } from '../sim/constants';
import type { GameEvent } from '../sim/events';
import { TRAINING_PLAYER } from '../sim/scenarios/tutorial';
import { createMatch } from '../sim/setup';
import { Simulation } from '../sim/simulation';
import { FACTION_IDS } from '../sim/types';
import type { AvatarInput, FactionId, MatchOptions } from '../sim/types';
import type { World } from '../sim/world';
import { createTutorial } from '../tutorial/director';
import type { TutorialDriver, TutorialRun } from '../tutorial/types';
import { GameUI } from '../ui/ui';
import { Controls } from './controls';
import { Session } from './session';

/** The surface UI, controls and audio use to drive the app. */
export interface AppApi {
  readonly session: Session;
  readonly world: World | null;
  readonly sim: Simulation | null;
  readonly fps: number;
  startMatch(opts?: Partial<MatchOptions>): void;
  readonly renderer: GameRenderer;
  /** Procedural audio; the UI calls its blips (uiClick, uiHover, uiConfirm, uiBack, uiToggle). */
  readonly audio: GameAudio;
  /** Local: back to the title. Online: leaves the host's burn for the local title. */
  quitToTitle(): void;
  /** Online: opens/closes the menu only (the host's burn keeps running). */
  setPaused(paused: boolean): void;
  submit(cmd: Command): void;
  /** This page was served by a FLAGHACK host (multiplayer available), probed at boot; else null. */
  readonly hostInfo: HostInfo | null;
  /** A `#pw=<password>` invite link opened this page: prefill the join form with it. */
  readonly invitePassword: string | null;
  /**
   * Online session with the host, or null when playing locally. A session that failed (bad
   * password, host gone) stays here with status 'closed' and its error until the next joinHost.
   */
  readonly net: NetSession | null;
  /** Open a session with the host that served this page and join with a handle + password. */
  joinHost(name: string, password: string): void;
  /** The Training Burn while it runs, else null. */
  readonly tutorial: TutorialRun | null;
  /** Start the Training Burn (tutorial mission). */
  startTutorial(): void;
}

/** What boot learned before the App started (main.ts). */
export interface AppBoot {
  hostInfo: HostInfo | null;
  invitePassword: string | null;
}

const MAX_STEPS_PER_FRAME = 6;

/** Local burns (single player, the Training Burn) always seat the player as faction 0. */
const LOCAL_SEAT: FactionId = 0;

/** Handles by faction seat, from a lobby state (AI seats have none). */
function seatNames(lobby: LobbyState): Partial<Record<FactionId, string>> {
  const out: Partial<Record<FactionId, string>> = {};
  for (const seat of lobby.seats) {
    if (seat.playerId === null) continue;
    const player = lobby.players.find((p) => p.id === seat.playerId);
    if (player) out[seat.faction] = player.name;
  }
  return out;
}

/**
 * The reclaim token lives per tab (sessionStorage): a reload keeps the seat, while a second tab
 * on the same machine joins as its own player instead of stealing the first one's seat.
 */
function tabTokens(origin: string): TokenStore {
  const key = `flaghack:token:${origin}`;
  return {
    load() {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save(token) {
      try {
        sessionStorage.setItem(key, token);
      } catch {
        // Storage disabled: the token still holds for this page's lifetime (reconnects work).
      }
    },
  };
}

export class App implements AppApi {
  readonly session = new Session();
  world: World | null = null;
  sim: Simulation | null = null;
  fps = 60;
  readonly renderer: GameRenderer;
  readonly controls: Controls;
  readonly ui: GameUI;
  readonly audio: GameAudio;
  readonly hostInfo: HostInfo | null;
  readonly invitePassword: string | null;
  tutorial: TutorialDriver | null = null;
  /** Online match replica (null offline and in the lobby). */
  mirror: NetMirror | null = null;
  /** Local vexillomancer prediction while seated online (null with ?predict=0). */
  predictor: AvatarPredictor | null = null;
  private client: NetClient | null = null;
  private ai: AiController | null = null;
  private acc = 0;
  private last = performance.now();
  private fpsAcc = 0;
  private fpsFrames = 0;
  private readonly predictionOn: boolean;
  /** Online: input sequence of the current match (restarts at 1 after every matchStart). */
  private seq = 0;
  /** Online: this tick's avatar input as Controls submitted it, and whether it did this tick. */
  private readonly tickInput: AvatarInput = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
  private tickFresh = false;
  /** Online: discrete commands waiting for the next input message. */
  private tickCmds: Command[] = [];

  constructor(root: HTMLElement, boot: AppBoot = { hostInfo: null, invitePassword: null }) {
    const canvas = root.querySelector('canvas#game') as HTMLCanvasElement;
    const uiRoot = root.querySelector('#ui') as HTMLElement;
    this.hostInfo = boot.hostInfo;
    this.invitePassword = boot.invitePassword;
    this.predictionOn = new URLSearchParams(location.search).get('predict') !== '0';
    this.renderer = new GameRenderer(canvas);
    this.controls = new Controls(this, canvas);
    this.ui = new GameUI(uiRoot, this);
    this.audio = new GameAudio(this);
    // Stage lights, dancers and DJ Scarecrow's headphones pulse on the music's audible kick.
    this.renderer.beatSource = () => this.audio.beat();
    this.loadAttract();
    this.session.screen = 'title';
    // A hidden tab stops requestAnimationFrame, and the host repeats the last input it got:
    // tell it to stand still before the frames stop. Coming back, jump the mirror to the
    // present instead of replaying the queued frames.
    window.addEventListener('blur', this.standStill);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.standStill();
      else this.mirror?.catchUp();
    });
    requestAnimationFrame(this.frame);
  }

  get net(): NetSession | null {
    return this.client;
  }

  /** Connected (or reconnecting) to a host: local-only tools stand down. */
  get online(): boolean {
    return this.client !== null && this.client.status !== 'closed';
  }

  startMatch(opts: Partial<MatchOptions> = {}): void {
    this.dropClient();
    const seed = opts.seed ?? `burn-${Date.now().toString(36)}`;
    const difficulty = opts.difficulty ?? this.session.settings.difficulty;
    const match = opts.match ?? this.session.settings.match;
    const seat = match.active[0] ?? LOCAL_SEAT;
    this.load({ seed, difficulty, humans: [seat], mode: 'standard', match });
    this.session.playerFaction = seat;
    this.enterPlay();
  }

  startTutorial(): void {
    this.dropClient();
    this.load({ seed: 'training-burn', difficulty: 'normal', humans: [TRAINING_PLAYER], mode: 'tutorial' });
    const world = this.world;
    if (!world) return;
    this.tutorial = createTutorial(world, this.session, { exitToTitle: () => this.quitToTitle() });
    this.enterPlay();
  }

  joinHost(name: string, password: string): void {
    this.dropClient();
    let client: NetClient | null = null;
    // Callbacks only count for the session that is current (a replaced one may still close late).
    const mine = (): NetClient | null => (client !== null && client === this.client ? client : null);
    const hooks: NetClientHooks = {
      lobby: (lobby) => {
        if (mine()) this.onLobby(lobby);
      },
      matchStart: (options, seat, snapshot) => {
        const c = mine();
        if (c) this.enterOnline(c, options, seat, snapshot);
      },
      state: (frame) => {
        if (mine()) this.mirror?.push(frame);
      },
      closed: (error) => {
        if (mine()) this.onClosed(error);
      },
    };
    client = new NetClient({
      url: hostSocketUrl(location),
      name,
      password,
      serverName: this.hostInfo?.serverName ?? 'the host',
      hooks,
      tokens: tabTokens(location.origin),
    });
    this.client = client;
  }

  quitToTitle(): void {
    const client = this.client;
    if (client && client.status !== 'closed') {
      // The closed hook brings the title back.
      client.leave();
      return;
    }
    this.loadAttract();
    this.session.screen = 'title';
  }

  setPaused(paused: boolean): void {
    if (this.session.screen === 'playing' && paused) this.session.screen = 'paused';
    else if (this.session.screen === 'paused' && !paused) this.session.screen = 'playing';
  }

  submit(cmd: Command): void {
    if (!this.mirror) {
      this.world?.submit(cmd);
      return;
    }
    // Online the host stamps the faction and applies it; everything rides the next input message.
    if (cmd.t === 'avatarInput') {
      const src = cmd.input;
      const dst = this.tickInput;
      dst.moveX = src.moveX;
      dst.moveZ = src.moveZ;
      dst.jump = src.jump;
      dst.sprint = src.sprint;
      dst.yaw = src.yaw;
      dst.pitch = src.pitch;
      this.tickFresh = true;
    } else this.tickCmds.push(cmd);
  }

  /**
   * Debug/eval fast-forward: run AI + simulation for `seconds` of game time synchronously.
   * Events produced meanwhile are discarded (presentation would otherwise replay minutes of
   * one-shot effects at once). Local burns only: online the host owns time.
   */
  fastForward(seconds: number): void {
    if (!this.sim || !this.world || this.mirror) return;
    const steps = Math.round(seconds / SIM_DT);
    for (let i = 0; i < steps && this.world.phase === 'playing'; i++) {
      this.ai?.update();
      this.sim.step();
      if ((i & 255) === 255) this.world.drainEvents();
    }
    this.world.drainEvents();
  }

  /** Title screen and online lobby: an all-AI burn plays out behind the menus. */
  private loadAttract(): void {
    this.load({ seed: `attract-${Math.floor(Math.random() * 1e6)}`, difficulty: 'normal', humans: [], mode: 'standard' });
  }

  private enterPlay(): void {
    this.session.screen = 'playing';
    this.session.view = 'action';
    this.session.viewBlend = 0;
    this.session.selection.clear();
    this.session.feed = [];
    this.audio.unlock();
  }

  private load(options: MatchOptions): void {
    this.leaveOnline();
    this.tutorial?.dispose();
    this.tutorial = null;
    this.session.markers = [];
    const world = createMatch(options);
    this.session.playerFaction = options.humans[0] ?? LOCAL_SEAT;
    this.world = world;
    this.sim = new Simulation(world);
    // The Training Burn's rivals are scripted by the tutorial director, not the AI.
    const aiFactions: FactionId[] =
      options.mode === 'tutorial' ? [] : FACTION_IDS.filter((f) => !options.humans.includes(f));
    this.ai = createAi(world, aiFactions);
    this.renderer.attach(world, this.session);
    this.acc = 0;
  }

  // ── Online ─────────────────────────────────────────────────────────────────

  /** Forget the current session without its hooks firing (a new local burn or join replaces it). */
  private dropClient(): void {
    const client = this.client;
    this.client = null;
    if (client && client.status !== 'closed') client.leave();
  }

  /** Tear down the online match replica (the caller loads whatever comes next). */
  private leaveOnline(): void {
    this.mirror = null;
    this.predictor = null;
    this.seq = 0;
    this.tickCmds = [];
    this.tickFresh = false;
    const s = this.session;
    s.playerFaction = this.world?.options.humans[0] ?? LOCAL_SEAT;
    s.spectator = false;
    s.followFaction = null;
    s.playerNames = {};
  }

  private onLobby(lobby: LobbyState): void {
    if (this.mirror) {
      // The leader sent everyone back to the waiting room after the match.
      if (lobby.phase === 'lobby') {
        this.loadAttract();
        this.session.screen = 'lobby';
      } else this.session.playerNames = seatNames(lobby);
      return;
    }
    // The waiting room plays over an attract burn, never over a local match.
    if (!this.world || this.world.options.humans.length > 0) this.loadAttract();
    this.session.screen = 'lobby';
  }

  private onClosed(error: string | null): void {
    // A failed session stays readable (status 'closed' + error) for the join panel.
    if (error === null) this.client = null;
    if (this.mirror || (this.world && this.world.options.humans.length > 0)) this.loadAttract();
    this.session.screen = 'title';
  }

  private enterOnline(client: NetClient, options: MatchOptions, seat: FactionId | null, snapshot: FullSnapshot): void {
    this.tutorial?.dispose();
    this.tutorial = null;
    this.ai = null;
    this.sim = null;
    const mirror = NetMirror.create(options, snapshot);
    const world = mirror.world;
    this.leaveOnline();
    this.mirror = mirror;
    this.world = world;
    const s = this.session;
    s.markers = [];
    s.playerFaction = seat ?? options.match?.active[0] ?? 0;
    s.spectator = seat === null;
    s.playerNames = client.lobby ? seatNames(client.lobby) : {};
    this.acc = 0;
    const playerId = client.playerId;
    if (seat !== null) {
      const avatarId = world.factions[seat].avatarId;
      const av = world.avatars.get(avatarId);
      this.tickInput.yaw = av ? av.yaw : 0;
      this.tickInput.pitch = 0;
      if (this.predictionOn && playerId !== null) this.predictor = new AvatarPredictor(world, avatarId, playerId);
    }
    mirror.setPredicted(this.predictor ? this.predictor.avatarId : null);
    this.renderer.attach(world, s);
    this.enterPlay();
    // Building the mirror blocks for a few hundred ms: that is not play time. Counting it would
    // send a burst of inputs the host then has to queue (standing input latency).
    this.last = performance.now();
  }

  /** Seated in a running online burn with a live socket: one input message per local tick. */
  private sendsInput(client: NetClient): boolean {
    return client.connected && client.status === 'match' && !this.session.spectator && this.world?.phase === 'playing';
  }

  private stepOnline(mirror: NetMirror, now: number, dt: number): void {
    const client = this.client;
    if (client && this.sendsInput(client)) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
        this.netTick(client);
        this.acc -= SIM_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.acc = 0;
    } else {
      this.acc = 0;
      this.tickCmds.length = 0;
    }
    mirror.advance(now);
    // Show the local vexillomancer between its last two ticks: smooth on screens faster than 60 Hz.
    this.predictor?.frame(mirror, dt, this.acc / SIM_DT);
  }

  private netTick(client: NetClient): void {
    this.tickFresh = false;
    this.controls.tick();
    const input = this.tickInput;
    // Menu open, typing, between submissions: stand still (facing kept) rather than repeat a key.
    if (!this.tickFresh || this.session.screen !== 'playing') {
      input.moveX = 0;
      input.moveZ = 0;
      input.jump = false;
      input.sprint = false;
    }
    this.seq++;
    // The host drops a frame carrying more than MAX_FRAME_COMMANDS whole: surplus rides the next tick.
    const cmds = this.tickCmds;
    if (cmds.length <= MAX_FRAME_COMMANDS) {
      client.sendInput(this.seq, input, cmds);
      cmds.length = 0;
    } else client.sendInput(this.seq, input, cmds.splice(0, MAX_FRAME_COMMANDS));
    this.predictor?.tick(this.seq, input);
  }

  /** One neutral input right now (facing kept, no commands), outside the frame loop. */
  private standStill = (): void => {
    const client = this.client;
    if (!this.mirror || !client || !this.sendsInput(client)) return;
    const input = this.tickInput;
    input.moveX = 0;
    input.moveZ = 0;
    input.jump = false;
    input.sprint = false;
    this.seq++;
    client.sendInput(this.seq, input, []);
    this.predictor?.tick(this.seq, input);
  };

  // ── Frame loop ─────────────────────────────────────────────────────────────

  private stepLocal(dt: number): void {
    const screen = this.session.screen;
    const running = screen === 'playing' || screen === 'title' || screen === 'lobby';
    if (!running || !this.sim || !this.world) return;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.controls.tick();
      this.tutorial?.tick();
      this.ai?.update();
      this.sim.step();
      this.acc -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.acc = 0;
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    this.controls.update(dt);
    if (this.mirror) this.stepOnline(this.mirror, now, dt);
    else this.stepLocal(dt);
    let events: GameEvent[] = [];
    if (this.world) events = this.world.drainEvents();
    if (this.world && this.world.phase === 'ended' && this.session.screen === 'playing') this.session.screen = 'ended';
    this.tutorial?.update(dt, events);
    this.renderer.onEvents(events);
    this.ui.onEvents(events);
    this.audio.onEvents(events);
    this.renderer.render(dt);
    this.ui.update(dt);
    this.audio.update(dt);
  };
}
