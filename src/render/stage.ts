/**
 * EverTactics — the Stage.
 *
 * Owns the WebGL renderer, the scene, the frame loop and the render-target
 * pipeline. Everything else in `render/` plugs into this.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COLOUR PIPELINE
 * ─────────────────────────────────────────────────────────────────────────────
 * The scene is *never* rendered straight to the canvas. It is rendered into a
 * half-float, linear-working-space render target (`sceneTarget`) that carries a
 * depth texture, and a present step converts that to display sRGB.
 *
 * three applies tone mapping and output colour conversion only when the render
 * destination is the canvas, so rendering into the target leaves us with clean
 * linear HDR — exactly what SSAO, bloom and a grade LUT need to work on. The
 * default present step is three's `OutputPass`, which reads
 * `renderer.toneMapping` / `renderer.outputColorSpace` and does the conversion
 * once, at the end. When `src/render/post.ts` installs a `PostPipeline` it takes
 * over that final step and is responsible for the same conversion.
 *
 * Textures loaded elsewhere must set their own colour space: colour maps
 * (albedo, sprite sheets) → `SRGBColorSpace`; data maps (normal, roughness,
 * palette LUTs, index textures) → `NoColorSpace`/linear. Getting a palette LUT
 * wrong is the single most common source of "why are the colours slightly off".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FRAME LOOP
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixed-step logic, free-running render.
 *
 *   real delta → clamped to `maxDelta` (a tab-switch must not fast-forward the
 *   battle) → accumulated → drained in `fixedStep` slices, at most `maxSubSteps`
 *   per frame (the rest is dropped rather than spiralling) → the leftover
 *   fraction is handed to render callbacks as `alpha` for interpolation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONVERGENCE / `window.__EVERTACTICS_READY__`
 * ─────────────────────────────────────────────────────────────────────────────
 * `tools/shoot.mjs` blocks on that flag, so it is load-bearing. The stage
 * declares convergence on the first frame where *all* of these hold:
 *
 *   • every registered load barrier has settled (`addLoadBarrier`, `hold`)
 *   • the camera reports `settled` (no rotate/zoom/follow/shake in flight)
 *   • the post pipeline reports `converged` (TAA/SSAO accumulation finished)
 *   • that has been true for `stableFrames` consecutive presented frames
 *
 * Barriers are *fail-open*: a rejected promise still releases, and an error is
 * logged. A broken loader must produce a diagnosable screenshot, not a hang.
 */

import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Clock,
  Color,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  NeutralToneMapping,
  NoColorSpace,
  PCFSoftShadowMap,
  Scene,
  SRGBColorSpace,
  UnsignedInt248Type,
  DepthStencilFormat,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
  type Camera,
  type ToneMapping,
} from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { WorldEnvironment, type WorldEnvironmentOptions } from './atmosphere.js';

declare global {
  interface Window {
    __EVERTACTICS_READY__?: boolean;
    __EVERTACTICS_STAGE__?: Stage;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contracts other render modules code against
// ─────────────────────────────────────────────────────────────────────────────

/** What the Stage needs from a camera rig. `IsoCamera` satisfies this. */
export interface StageCamera {
  readonly camera: Camera;
  /** Called on every resize with the DEVICE-pixel drawing buffer size. */
  setViewport(widthPx: number, heightPx: number, pixelRatio: number): void;
  update(dt: number): void;
  /** False while any camera motion is in flight; gates convergence. */
  readonly settled: boolean;
}

/** Everything a post pipeline is handed for its final composite. */
export interface PostRenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  /**
   * The composed scene: half-float, LINEAR working colour space, no tone
   * mapping applied. `source.depthTexture` is a full-precision depth buffer for
   * SSAO / DoF / fog reconstruction.
   */
  source: WebGLRenderTarget;
  /** Same as `source.depthTexture`, hoisted for convenience. */
  depth: DepthTexture;
  /** Drawing-buffer size in device pixels. */
  width: number;
  height: number;
  pixelRatio: number;
  /** Seconds since the previous presented frame, already clamped. */
  deltaSeconds: number;
  /** Seconds since `start()`. */
  elapsedSeconds: number;
  /** Monotonic presented-frame counter. */
  frame: number;
}

/**
 * Implemented by `src/render/post.ts`.
 *
 * The pipeline OWNS the final present: it must end with the canvas
 * (`renderer.setRenderTarget(null)`) containing tone-mapped, display-sRGB
 * pixels. Everything it receives is linear HDR.
 */
export interface PostPipeline {
  /** Device-pixel drawing-buffer size. Called on install and on every resize. */
  setSize(widthPx: number, heightPx: number, pixelRatio: number): void;
  render(ctx: PostRenderContext): void;
  /** False while temporal accumulation is still settling. Gates convergence. */
  readonly converged: boolean;
  /**
   * Set by a pipeline that composes the scene itself (it needs its own colour
   * target plus a sprite-only mask pass, which cannot be reconstructed from a
   * flattened buffer). Stage then skips its own scene→`sceneTarget` render and
   * hands `ctx.source` over purely as a spare target. `src/render/post.ts`'s
   * `PostStack` works this way; see `createPostPipeline` in `src/state/render.ts`.
   */
  readonly rendersScene?: boolean;
  dispose(): void;
}

export type ToneMappingName = 'aces' | 'agx' | 'neutral';

export interface StageOptions {
  /** Element the canvas is appended to. Defaults to `#app`, then `document.body`. */
  container?: HTMLElement;
  /** Use an existing canvas instead of creating one. */
  canvas?: HTMLCanvasElement;
  /** Upper bound on device pixel ratio. 2 is plenty for pixel art. */
  maxPixelRatio?: number;
  /** MSAA sample count on the scene target. 0 disables. */
  samples?: number;
  toneMapping?: ToneMappingName;
  /** Initial exposure. `LightingRig` overrides this per preset when bound. */
  exposure?: number;
  /** Fixed logic step, in seconds. */
  fixedStep?: number;
  /** Max fixed steps drained per frame before the remainder is dropped. */
  maxSubSteps?: number;
  /** Real-time delta clamp, in seconds. */
  maxDelta?: number;
  /** Consecutive good frames required before declaring convergence. */
  stableFrames?: number;
  /** Keep presenting frames while paused (needed for screenshots). */
  renderWhilePaused?: boolean;
  /** Auto-start the rAF loop in the constructor. */
  autoStart?: boolean;
  /** Expose the stage on `window.__EVERTACTICS_STAGE__` for tooling. */
  exposeGlobal?: boolean;
  /**
   * Sky / backdrop / atmosphere. Pass `{ enabled: false }` for diagnostic
   * scenes that want to look at geometry against a flat colour.
   * See `src/render/atmosphere.ts`.
   */
  environment?: WorldEnvironmentOptions | false;
}

type TickCallback = (dt: number, tick: number) => void;
type RenderCallback = (dt: number, alpha: number) => void;
type ResizeCallback = (widthPx: number, heightPx: number, pixelRatio: number) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Stage
// ─────────────────────────────────────────────────────────────────────────────

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;

  /** Linear HDR colour+depth target the scene is composed into. */
  readonly sceneTarget: WebGLRenderTarget;

  /**
   * The world the diorama sits in: graded sky, distance haze, the surrounding
   * architecture layer, the ground plate and the airborne particulate.
   *
   * Stage owns it because Stage owns the scene and the frame loop, and because
   * the alternative — making every caller remember to install it — is exactly
   * how the board ended up floating in `clearColor` for two rounds. It
   * self-configures by reading `scene.background`, `scene.fog`, the key
   * `DirectionalLight` and the `terrain:*` group, so nothing else has to call
   * anything. See `src/render/atmosphere.ts` for the escape hatches.
   */
  readonly environment: WorldEnvironment | null;

  private cameraRig: StageCamera | null = null;
  private post: PostPipeline | null = null;
  private readonly outputPass = new OutputPass();

  private readonly clock = new Clock(false);
  private readonly fixedStep: number;
  private readonly maxSubSteps: number;
  private readonly maxDelta: number;
  private readonly maxPixelRatio: number;
  private readonly renderWhilePaused: boolean;
  private readonly stableFramesRequired: number;

  private accumulator = 0;
  private tickCount = 0;
  private frameCount = 0;
  private elapsed = 0;
  private lastDelta = 0;
  private fpsEma = 0;

  private running = false;
  private pausedFlag = false;
  private rafHandle = 0;
  private disposed = false;

  private widthPx = 1;
  private heightPx = 1;
  private pixelRatio = 1;

  private readonly tickCallbacks = new Set<TickCallback>();
  private readonly renderCallbacks = new Set<RenderCallback>();
  private readonly resizeCallbacks = new Set<ResizeCallback>();
  private readonly convergedCallbacks = new Set<() => void>();

  private pendingBarriers = 0;
  private convergedFlag = false;
  private stableFrames = 0;

  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.resize();

  constructor(options: StageOptions = {}) {
    this.container =
      options.container ??
      (document.getElementById('app') as HTMLElement | null) ??
      document.body;

    this.canvas = options.canvas ?? document.createElement('canvas');
    if (!this.canvas.parentElement) this.container.appendChild(this.canvas);

    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    this.fixedStep = options.fixedStep ?? 1 / 60;
    this.maxSubSteps = options.maxSubSteps ?? 5;
    this.maxDelta = options.maxDelta ?? 0.1;
    this.renderWhilePaused = options.renderWhilePaused ?? true;
    this.stableFramesRequired = Math.max(1, options.stableFrames ?? 3);

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      // The scene target does the antialiasing; a multisampled default
      // framebuffer would only cost fill rate on a surface we never draw to.
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      // Required so tools/shoot.mjs can screenshot the composited canvas.
      preserveDrawingBuffer: true,
    });

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = resolveToneMapping(options.toneMapping ?? 'aces');
    this.renderer.toneMappingExposure = options.exposure ?? 1;
    this.renderer.shadowMap.enabled = true;
    // PCFSoft over a tightly fitted shadow frustum: crisp contact, soft falloff.
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.autoClear = true;
    this.renderer.setClearColor(new Color(0x05060a), 1);
    this.renderer.info.autoReset = true;

    this.outputPass.renderToScreen = true;

    // ── scene target ────────────────────────────────────────────────────────
    // Half-float is enough headroom for bloom thresholds and costs half the
    // bandwidth of full float. Depth is packed 24/8 so the depth texture is
    // sampleable while still giving the driver a real depth-stencil format.
    const depthTexture = new DepthTexture(1, 1, UnsignedInt248Type);
    depthTexture.format = DepthStencilFormat;

    this.sceneTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      colorSpace: NoColorSpace, // linear working space — post operates here
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: true,
      depthTexture,
      samples: options.samples ?? 4,
    });
    this.sceneTarget.texture.name = 'Stage.sceneColor';
    depthTexture.name = 'Stage.sceneDepth';

    // The environment must exist before the first resize so it gets a viewport.
    this.environment =
      options.environment === false ? null : new WorldEnvironment(options.environment ?? {});
    this.environment?.addTo(this.scene);

    this.installResizeHandling();
    this.resize();

    if (options.exposeGlobal !== false && typeof window !== 'undefined') {
      window.__EVERTACTICS_STAGE__ = this;
    }
    if (typeof window !== 'undefined') window.__EVERTACTICS_READY__ = false;

    if (options.autoStart !== false) this.start();
  }

  // ── camera ────────────────────────────────────────────────────────────────

  setCamera(rig: StageCamera): void {
    this.cameraRig = rig;
    rig.setViewport(this.widthPx, this.heightPx, this.pixelRatio);
  }

  get camera(): StageCamera | null {
    return this.cameraRig;
  }

  // ── post pipeline ─────────────────────────────────────────────────────────

  /**
   * Install (or clear) the post stack. The pipeline owns the final present; see
   * {@link PostPipeline}. Passing `null` restores the built-in tone-map/encode
   * present, so the game is always renderable with or without post.
   */
  setPostPipeline(pipeline: PostPipeline | null): void {
    if (this.post === pipeline) return;
    this.post?.dispose();
    this.post = pipeline;
    pipeline?.setSize(this.widthPx, this.heightPx, this.pixelRatio);
    // A new stack has to re-converge before we call the frame settled.
    this.stableFrames = 0;
  }

  get postPipeline(): PostPipeline | null {
    return this.post;
  }

  // ── loop control ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clock.start();
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  /** Stop the rAF driver entirely. `start()` resumes with a fresh delta. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clock.stop();
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  /** Freeze logic (and optionally rendering) while keeping the driver alive. */
  pause(): void {
    this.pausedFlag = true;
  }

  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    // Swallow the wall-clock gap so nothing fast-forwards.
    this.clock.getDelta();
    this.accumulator = 0;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Render exactly one frame without the rAF driver (tests, offline capture). */
  renderOnce(deltaSeconds = this.fixedStep): void {
    this.step(deltaSeconds);
  }

  // ── subscriptions ─────────────────────────────────────────────────────────

  /** Fixed-step logic callback. Returns an unsubscribe function. */
  onTick(cb: TickCallback): () => void {
    this.tickCallbacks.add(cb);
    return () => this.tickCallbacks.delete(cb);
  }

  /** Per-frame callback, given the real delta and the fixed-step remainder. */
  onRender(cb: RenderCallback): () => void {
    this.renderCallbacks.add(cb);
    return () => this.renderCallbacks.delete(cb);
  }

  onResize(cb: ResizeCallback): () => void {
    this.resizeCallbacks.add(cb);
    cb(this.widthPx, this.heightPx, this.pixelRatio);
    return () => this.resizeCallbacks.delete(cb);
  }

  /**
   * Fires once, on the first converged frame. Registering after convergence
   * still fires (on a microtask), so callers never miss the edge.
   */
  onConverged(cb: () => void): () => void {
    if (this.convergedFlag) {
      queueMicrotask(cb);
      return () => undefined;
    }
    this.convergedCallbacks.add(cb);
    return () => this.convergedCallbacks.delete(cb);
  }

  get converged(): boolean {
    return this.convergedFlag;
  }

  // ── convergence barriers ──────────────────────────────────────────────────

  /**
   * Hold off `__EVERTACTICS_READY__` until `promise` settles. Rejection releases
   * the barrier and logs — a broken loader yields a diagnosable frame, not a
   * hang.
   */
  addLoadBarrier<T>(promise: Promise<T>, label = 'asset'): Promise<T> {
    this.pendingBarriers += 1;
    this.stableFrames = 0;
    promise
      .catch((err: unknown) => {
        console.error(`[stage] load barrier "${label}" failed:`, err);
      })
      .finally(() => {
        this.pendingBarriers = Math.max(0, this.pendingBarriers - 1);
        this.stableFrames = 0;
      });
    return promise;
  }

  /** Manual barrier. Call the returned function to release it. */
  hold(label = 'hold'): () => void {
    this.pendingBarriers += 1;
    this.stableFrames = 0;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      void label;
      this.pendingBarriers = Math.max(0, this.pendingBarriers - 1);
      this.stableFrames = 0;
    };
  }

  get pendingBarrierCount(): number {
    return this.pendingBarriers;
  }

  // ── sizing ────────────────────────────────────────────────────────────────

  private installResizeHandling(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
    window.addEventListener('resize', this.onWindowResize);
  }

  /** Re-read the container size and rebuild anything size-dependent. */
  resize(): void {
    if (this.disposed) return;
    const rect = this.container.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width || window.innerWidth));
    const cssHeight = Math.max(1, Math.floor(rect.height || window.innerHeight));
    const dpr = Math.min(this.maxPixelRatio, Math.max(1, window.devicePixelRatio || 1));

    this.pixelRatio = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssWidth, cssHeight, true);

    const buffer = this.renderer.getDrawingBufferSize(scratchSize);
    this.widthPx = Math.max(1, Math.round(buffer.x));
    this.heightPx = Math.max(1, Math.round(buffer.y));

    this.sceneTarget.setSize(this.widthPx, this.heightPx);
    this.environment?.setViewport(this.widthPx, this.heightPx, this.pixelRatio);
    this.post?.setSize(this.widthPx, this.heightPx, this.pixelRatio);
    this.outputPass.setSize(this.widthPx, this.heightPx);
    this.cameraRig?.setViewport(this.widthPx, this.heightPx, this.pixelRatio);

    for (const cb of this.resizeCallbacks) cb(this.widthPx, this.heightPx, this.pixelRatio);
    // Geometry moved under any temporal accumulation; re-converge.
    this.stableFrames = 0;
  }

  get drawingBufferWidth(): number {
    return this.widthPx;
  }

  get drawingBufferHeight(): number {
    return this.heightPx;
  }

  get devicePixelRatioInUse(): number {
    return this.pixelRatio;
  }

  get fps(): number {
    return this.fpsEma;
  }

  get frameNumber(): number {
    return this.frameCount;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  private readonly frame = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.frame);
    const raw = this.clock.getDelta();
    this.step(raw);
  };

  private step(rawDelta: number): void {
    if (this.disposed) return;

    const dt = Math.min(Math.max(rawDelta, 0), this.maxDelta);
    this.lastDelta = dt;
    if (dt > 0) this.fpsEma = this.fpsEma === 0 ? 1 / dt : this.fpsEma * 0.9 + (1 / dt) * 0.1;

    if (this.pausedFlag) {
      if (!this.renderWhilePaused) return;
      this.present(0);
      return;
    }

    this.elapsed += dt;

    // Fixed-step logic. Drop the remainder rather than spiral on a slow frame.
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this.accumulator -= this.fixedStep;
      this.tickCount += 1;
      steps += 1;
      for (const cb of this.tickCallbacks) cb(this.fixedStep, this.tickCount);
    }
    if (steps === this.maxSubSteps && this.accumulator > this.fixedStep) this.accumulator = 0;

    this.present(dt);
  }

  /** Camera update → render callbacks → scene into target → present. */
  private present(dt: number): void {
    const rig = this.cameraRig;
    if (!rig) return;

    rig.update(dt);

    const alpha = this.accumulator / this.fixedStep;
    for (const cb of this.renderCallbacks) cb(dt, alpha);

    // After the render callbacks: terrain and lighting may have just been
    // rebuilt this frame, and the environment measures both.
    this.environment?.update(rig.camera, this.elapsed);

    const postOwnsScene = this.post !== null && this.post.rendersScene === true;

    if (!postOwnsScene) {
      // Scene → linear HDR target. three skips tone mapping / output encoding
      // whenever the destination is a render target, which is what we want.
      this.renderer.setRenderTarget(this.sceneTarget);
      this.renderer.clear();
      this.renderer.render(this.scene, rig.camera);
      this.renderer.setRenderTarget(null);
    }

    const depth = this.sceneTarget.depthTexture;
    if (this.post && depth) {
      this.post.render({
        renderer: this.renderer,
        scene: this.scene,
        camera: rig.camera,
        source: this.sceneTarget,
        depth,
        width: this.widthPx,
        height: this.heightPx,
        pixelRatio: this.pixelRatio,
        deltaSeconds: dt,
        elapsedSeconds: this.elapsed,
        frame: this.frameCount,
      });
    } else {
      // Built-in present: tone map + sRGB encode straight to the canvas.
      this.outputPass.render(this.renderer, this.sceneTarget, this.sceneTarget, dt, false);
    }

    this.frameCount += 1;
    this.evaluateConvergence();
  }

  private evaluateConvergence(): void {
    if (this.convergedFlag) return;

    const rig = this.cameraRig;
    const good =
      this.pendingBarriers === 0 &&
      rig !== null &&
      rig.settled &&
      (this.post === null || this.post.converged);

    this.stableFrames = good ? this.stableFrames + 1 : 0;
    if (this.stableFrames < this.stableFramesRequired) return;

    this.convergedFlag = true;
    if (typeof window !== 'undefined') window.__EVERTACTICS_READY__ = true;
    const callbacks = [...this.convergedCallbacks];
    this.convergedCallbacks.clear();
    for (const cb of callbacks) {
      try {
        cb();
      } catch (err) {
        console.error('[stage] onConverged callback threw:', err);
      }
    }
  }

  /**
   * Force a re-converge (clears the ready flag). Use when the scene is torn down
   * and rebuilt — e.g. loading a different battle — so the screenshot harness
   * waits for the new content rather than the old.
   */
  invalidateConvergence(): void {
    this.convergedFlag = false;
    this.stableFrames = 0;
    if (typeof window !== 'undefined') window.__EVERTACTICS_READY__ = false;
  }

  get lastFrameDelta(): number {
    return this.lastDelta;
  }

  // ── teardown ──────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.onWindowResize);

    this.tickCallbacks.clear();
    this.renderCallbacks.clear();
    this.resizeCallbacks.clear();
    this.convergedCallbacks.clear();

    this.environment?.dispose();
    this.post?.dispose();
    this.post = null;
    this.outputPass.dispose();
    this.sceneTarget.depthTexture?.dispose();
    this.sceneTarget.dispose();
    this.renderer.dispose();

    if (typeof window !== 'undefined' && window.__EVERTACTICS_STAGE__ === this) {
      delete window.__EVERTACTICS_STAGE__;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const scratchSize = new Vector2();

function resolveToneMapping(name: ToneMappingName): ToneMapping {
  switch (name) {
    case 'agx':
      return AgXToneMapping;
    case 'neutral':
      return NeutralToneMapping;
    case 'aces':
    default:
      return ACESFilmicToneMapping;
  }
}

/** Re-exported so the whole render layer can pull the world contract from here. */
export {
  TILE_SIZE,
  HEIGHT_UNIT,
  TEXELS_PER_UNIT,
  texelsToWorld,
  gridToWorld,
  worldToGrid,
} from './camera.js';
