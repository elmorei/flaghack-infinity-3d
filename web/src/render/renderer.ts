/**
 * Render orchestrator: owns the WebGLRenderer, scene and camera, constructs every render
 * module for a World, fans out GameEvents, derives post-processing drive values, renders.
 * Camera placement is owned by game/controls (it writes ctx.camera each frame).
 */
import * as THREE from 'three';
import type { Session } from '../game/session';
import { FESTIVAL_BPM } from '../sim/constants';
import type { GameEvent } from '../sim/events';
import type { World } from '../sim/world';
import { ActorsRenderer } from './actors/actorsRenderer';
import type { PostFxState, RenderContext, RenderModule } from './context';
import { EnvRenderer } from './env/envRenderer';
import { PostFx } from './post/postfx';
import { WreckageRenderer } from './structures/wreckageRenderer';
import { StructuresRenderer } from './structures/structuresRenderer';
import { SurveyRenderer } from './survey/surveyRenderer';
import { renderCommandOverlay } from './survey/markedNodes';
import { VfxRenderer } from './vfx/vfxRenderer';

/**
 * Longest the canvas holds its last frame while a new scene's programs compile (a hold longer
 * than this reads as a freeze); after it the scene draws anyway and any program still linking
 * is waited for on first use.
 */
const WARM_CAP_MS = 300;

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  ctx: RenderContext | null = null;
  /**
   * Audible beat position of the music (beats), or null while audio is not running. Set by
   * the app; the render clock falls back to presentation time at FESTIVAL_BPM.
   */
  beatSource: (() => number | null) | null = null;
  private modules: RenderModule[] = [];
  private post: PostFx | null = null;
  /**
   * The previous match's modules, kept until the new scene's materials have acquired their
   * programs: three keeps a linked program while any material uses it, so identical materials
   * of the new match reuse them instead of compiling everything again.
   */
  private retired: { modules: RenderModule[]; post: PostFx | null } | null = null;
  /** The scene's programs have not been requested yet (first render after attach). */
  private needsWarm = false;
  /** Programs are compiling in parallel: the canvas keeps its last frame until this time. */
  private warmUntil = 0;
  /** Surface an asynchronous compile failure through the next render/readiness check. */
  private warmError: Error | null = null;
  /**
   * Bound while compiling ahead: PostFx draws the scene into a render target, and three keys
   * programs on whether one is bound (tone mapping and output colour space are left to the
   * final pass), so precompiling for the canvas would build programs the scene never uses.
   */
  private readonly warmTarget = new THREE.WebGLRenderTarget(1, 1);
  private canvas: HTMLCanvasElement;
  private fx: PostFxState = { dust: 0, acid: 0, saffron: 0, crash: 0, damage: 0, command: 0, instability: 0, flash: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // PostFx renders the scene into its own multisampled target; the canvas only receives the
    // final full-screen pass, so default-framebuffer MSAA would be wasted fill rate.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    // The link check reads the GL info logs, which waits for every compile to finish on the
    // main thread: development only.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /**
   * Build all modules for a world (call again for a new match). The previous match's modules
   * are disposed on the new scene's first render, once its programs are requested.
   */
  attach(world: World, session: Session): void {
    this.disposeRetired();
    this.retired = { modules: this.modules, post: this.post };
    this.modules = [];
    this.post = null;
    const scene = new THREE.Scene();
    const ctx: RenderContext = {
      renderer: this.renderer,
      scene,
      camera: this.camera,
      world,
      session,
      quality: session.settings.quality,
      time: 0,
      sunDir: new THREE.Vector3(0.5, 0.8, 0.3).normalize(),
      daylight: 1,
      beat: 0,
      shared: { fx: this.fx },
    };
    this.ctx = ctx;
    this.modules = [
      new EnvRenderer(ctx),
      new SurveyRenderer(ctx),
      new StructuresRenderer(ctx),
      new WreckageRenderer(ctx),
      new ActorsRenderer(ctx),
      new VfxRenderer(ctx),
    ];
    this.post = new PostFx(ctx);
    this.resize();
    this.needsWarm = true;
    this.warmUntil = 0;
    this.warmError = null;
  }

  detach(): void {
    this.disposeRetired();
    for (const m of this.modules) m.dispose();
    this.modules = [];
    this.post?.dispose();
    this.post = null;
    this.ctx = null;
  }

  private disposeRetired(): void {
    if (!this.retired) return;
    for (const m of this.retired.modules) m.dispose();
    this.retired.post?.dispose();
    this.retired = null;
  }

  onEvents(events: GameEvent[]): void {
    for (const e of events) {
      for (const m of this.modules) m.onEvent?.(e);
      if (this.ctx && (e.t === 'captured' || e.t === 'burn')) this.fx.flash = 1;
      if (this.ctx && e.t === 'hit') {
        const av = this.ctx.world.avatarOf(this.ctx.session.playerFaction);
        if (e.target === av.id) this.fx.damage = Math.min(1, this.fx.damage + e.amount / 60);
      }
    }
  }

  /** True only when the scene was drawn to the canvas (shader warmup alone is not ready). */
  render(dt: number): boolean {
    const ctx = this.ctx;
    const post = this.post;
    if (!ctx || !post) return false;
    if (this.warmError) {
      const error = this.warmError;
      this.warmError = null;
      throw error;
    }
    ctx.time += dt;
    ctx.beat = this.beatSource?.() ?? (ctx.time * FESTIVAL_BPM) / 60;
    this.updateFx(dt);
    for (const m of this.modules) m.update(dt);
    if (this.needsWarm) {
      // After one update, so materials the modules create lazily are included. compileAsync
      // starts every link at once (KHR_parallel_shader_compile) and resolves when all are
      // done; meanwhile the canvas keeps its last frame and the page stays responsive.
      this.needsWarm = false;
      this.warmUntil = performance.now() + WARM_CAP_MS;
      const target = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.warmTarget);
      try {
        void this.renderer.compileAsync(ctx.scene, this.camera).then(() => {
          if (this.ctx === ctx) this.warmUntil = 0;
        }, (error: unknown) => {
          if (this.ctx !== ctx) return;
          this.warmUntil = 0;
          this.warmError = error instanceof Error ? error : new Error('Could not compile the game scene.', { cause: error });
        });
      } finally {
        this.renderer.setRenderTarget(target);
      }
      this.disposeRetired();
    }
    if (performance.now() < this.warmUntil) return false;
    post.render(dt);
    renderCommandOverlay(this.renderer, this.camera, ctx.shared.commandOverlay);
    return true;
  }

  private updateFx(dt: number): void {
    const ctx = this.ctx!;
    const w = ctx.world;
    const f = w.factions[ctx.session.playerFaction];
    const ease = (cur: number, target: number, rate: number) => cur + (target - cur) * Math.min(1, dt * rate);
    this.fx.dust = ease(this.fx.dust, f.drugActive.dust > w.time ? 1 : 0, 2);
    this.fx.acid = ease(this.fx.acid, f.drugActive.acidcop > w.time ? 1 : 0, 2);
    this.fx.saffron = ease(this.fx.saffron, f.drugActive.saffron > w.time ? 1 : 0, 2);
    this.fx.crash = ease(this.fx.crash, f.saffronCrashUntil > w.time ? 1 : 0, 2);
    this.fx.command = ctx.session.viewBlend;
    this.fx.damage = Math.max(0, this.fx.damage - dt * 1.5);
    this.fx.flash = Math.max(0, this.fx.flash - dt * 0.8);
    const av = w.avatarOf(ctx.session.playerFaction);
    const facet = w.lattice.facetAt(av.pos.x, av.pos.z);
    this.fx.instability = ease(this.fx.instability, facet >= 0 ? w.survey.facetInstability[facet] : 0, 3);
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h);
  }
}
