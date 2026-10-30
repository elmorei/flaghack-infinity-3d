/**
 * Render orchestrator: owns the WebGLRenderer, scene and camera, constructs every render
 * module for a World, fans out GameEvents, derives post-processing drive values, renders.
 * Camera placement is owned by game/controls (it writes ctx.camera each frame).
 */
import * as THREE from 'three';
import type { Session } from '../game/session';
import { isMobileCommandLayout } from '../game/mobileTouch';
import { mobileCommandExtent } from '../game/cameraRig';
import type { WorldCamera } from './cameraProjection';
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
  camera: WorldCamera;
  private readonly perspective = new THREE.PerspectiveCamera(70, 1, .1, 1200);
  private readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 1200);
  ctx: RenderContext | null = null;
  /**
   * Audible beat position of the music (beats), or null while audio is not running. Set by
   * the app; the render clock falls back to presentation time at FESTIVAL_BPM.
   */
  beatSource: (() => number | null) | null = null;
  private modules: RenderModule[] = [];
  private post: PostFx | null = null;
  private readonly mobilePresentation = isMobileCommandLayout();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.mobilePresentation ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = this.perspective;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /**
   * Build all modules for a world (call again for a new match). The previous match's modules
   * are disposed on the new scene's first render, once its programs are requested.
   */
  attach(world: World, session: Session): void {
    this.setMobileOrthographic(false);
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
      quality: this.mobilePresentation ? 'low' : session.settings.quality,
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
    // Mobile keeps the actual world/telegraphs but skips bloom, grain, parchment and drug grading.
    if (!this.mobilePresentation) this.post = new PostFx(ctx);
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
        if (av && e.target === av.id) this.fx.damage = Math.min(1, this.fx.damage + e.amount / 60);
      }
    }
  }

  /** True only when the scene was drawn to the canvas (shader warmup alone is not ready). */
  render(dt: number, occluded = false): boolean {
    const ctx = this.ctx;
    const post = this.post;
    if (!ctx) return false;
    if (this.warmError) {
      const error = this.warmError;
      this.warmError = null;
      throw error;
    }
    ctx.time += dt;
    ctx.beat = this.beatSource?.() ?? (ctx.time * FESTIVAL_BPM) / 60;
    this.updateFx(dt);
    for (const m of this.modules) m.update(dt);
    // Hidden by a fully opaque DOM table: presentation/effect lifetimes still
    // advance, but shader warmup and GPU draws can wait until the world is visible.
    if (occluded) return false;
    if (this.needsWarm) {
      // After one update, so materials the modules create lazily are included. compileAsync
      // starts every link at once (KHR_parallel_shader_compile) and resolves when all are
      // done; meanwhile the canvas keeps its last frame and the page stays responsive.
      this.needsWarm = false;
      this.warmUntil = performance.now() + WARM_CAP_MS;
      const target = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(post ? this.warmTarget : null);
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
    if (post) post.render(dt);
    else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(ctx.scene, this.camera);
    }
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
    const at = av?.pos ?? w.hearthOf(ctx.session.playerFaction)?.pos;
    const facet = at ? w.lattice.facetAt(at.x, at.z) : -1;
    this.fx.instability = ease(this.fx.instability, facet >= 0 ? w.survey.facetInstability[facet] : 0, 3);
  }

  /** Controls selects before writing the pose, so every module and picker uses the same camera. */
  setMobileOrthographic(enabled: boolean): void {
    const next = enabled ? this.orthographic : this.perspective;
    if (next === this.camera) return;
    this.camera = next;
    if (this.ctx) this.ctx.camera = next;
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    const half = mobileCommandExtent(h) / 2;
    this.orthographic.left = -half * w / h; this.orthographic.right = half * w / h;
    this.orthographic.top = half; this.orthographic.bottom = -half;
    this.orthographic.userData.cssHeight = h;
    this.orthographic.updateProjectionMatrix();
    this.post?.setSize(w, h);
  }
}
