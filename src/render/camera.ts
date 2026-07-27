/**
 * EverTactics — isometric camera rig.
 *
 * A tilted-orthographic camera in the Final Fantasy Tactics / Triangle Strategy
 * lineage: fixed pitch, four snapped yaw positions, discrete zoom levels, and —
 * critically — a frustum sized so that one sprite texel covers a whole number of
 * device pixels.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WORLD CONVENTION (shared contract — terrain.ts / sprites.ts / vfx.ts use this)
 * ─────────────────────────────────────────────────────────────────────────────
 *   grid.x  →  world +X   (east)
 *   grid.y  →  world +Z   (south)
 *   height  →  world +Y, in half-tile units (`HEIGHT_UNIT` world units each),
 *              matching the FFT convention documented in core/types.ts.
 *
 *   One tile is `TILE_SIZE` (= 1) world unit square and is CENTRED on its integer
 *   coordinate: tile (x, y) spans world X ∈ [x−0.5, x+0.5] and Z ∈ [y−0.5, y+0.5].
 *   `gridToWorld` returns the centre of the tile's walkable top surface.
 *
 *   `terrain.ts` is the authority on this layout — it is what actually emits the
 *   geometry — and re-exports the same `TILE_SIZE` / `HEIGHT_UNIT` / `gridToWorld`.
 *   The definitions here exist so the camera has no dependency on the terrain
 *   module; they must stay numerically identical.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PIXEL SNAPPING — why the maths below is the way it is
 * ─────────────────────────────────────────────────────────────────────────────
 * Pixel art shimmers when a source texel maps to a non-integer number of screen
 * pixels, or when it maps to an integer count but lands on a fractional pixel
 * boundary. Both have to be solved.
 *
 * 1. SCALE. We fix a global density: `TEXELS_PER_UNIT` sprite texels per world
 *    unit. Sprite quads must therefore be sized `texels / TEXELS_PER_UNIT` world
 *    units (see `texelsToWorld`). `pixelScale` is how many *device* pixels we
 *    want each of those texels to cover, and it is an integer at rest.
 *
 *      worldPerDevicePixel  w  = 1 / (TEXELS_PER_UNIT * pixelScale)
 *      frustumHeight           = drawingBufferHeight * w
 *      frustumWidth            = drawingBufferWidth  * w
 *
 *    An orthographic frustum of exactly that size makes the world→pixel scale
 *    exactly 1/w, so one texel is exactly `pixelScale` device pixels. Nothing is
 *    resampled, nothing beats.
 *
 * 2. CAMERA PHASE. Correct scale is not enough: if the camera itself moves by
 *    fractional pixels, the whole image crawls — every static edge in the
 *    diorama swims by a sub-pixel amount each frame. That is the single most
 *    recognisable "cheap HD-2D" tell.
 *
 *    So every frame we project the world origin into view space, convert to
 *    pixel coordinates
 *
 *      px = viewOrigin.x / w + bufferWidth  / 2
 *      py = viewOrigin.y / w + bufferHeight / 2
 *
 *    and translate the camera along its own right/up axes by whatever sub-pixel
 *    amount drives px, py to integers (translating the camera by −δ along right
 *    raises a point's view-space x by δ). The camera's screen-space position is
 *    then quantised to whole device pixels, so smooth follow and screen shake
 *    advance in whole-pixel steps — which is exactly how hand-authored pixel-art
 *    cameras behave — and nothing static ever crawls.
 *
 *    The snap is disabled automatically while a yaw or pitch tween is in flight
 *    (the texel grid is rotating anyway, so phase-locking it buys nothing) and
 *    re-engages the instant the rotation lands.
 *
 * 3. BILLBOARD PHASE. Camera snapping does NOT make an arbitrary world point
 *    land on a pixel boundary: at 45° yaw a 1/TEXELS_PER_UNIT step along world X
 *    projects to pixelScale·cos(45°) pixels, not a whole number. Only
 *    displacements along the camera's own right/up axes are whole pixels — which
 *    is precisely what a camera-facing billboard is made of. So a sprite quad is
 *    internally exact once its ANCHOR is snapped, and `snapToPixelGrid()` does
 *    that: it round-trips a world position through view space, rounding to the
 *    device-pixel lattice. `sprites.ts` / `vfx.ts` must run every billboard
 *    origin through it, every frame. Terrain, being solid geometry rather than
 *    texel art, does not need it — the camera snap is enough.
 *
 * The camera is orthographic, so its distance from the focus point is arbitrary;
 * it only sets the near/far window. `RIG_DISTANCE` is large enough to contain any
 * plausible diorama.
 */

import {
  Box3,
  Camera,
  MathUtils,
  Matrix4,
  OrthographicCamera,
  Quaternion,
  Ray,
  Raycaster,
  Vector2,
  Vector3,
  type Intersection,
  type Object3D,
} from 'three';

import type { Battlefield, SlopeKind, Vec3 } from '@core/types';

// ─────────────────────────────────────────────────────────────────────────────
// World constants (exported contract)
// ─────────────────────────────────────────────────────────────────────────────

/** Edge length of one grid tile, in world units. */
export const TILE_SIZE = 1;

/** World units per FFT half-tile of elevation. */
export const HEIGHT_UNIT = 0.5;

/**
 * Sprite texels per world unit. A 64px FFT cell is therefore 2 world units tall,
 * putting a ~48px humanoid at 1.5 tiles — the FFT proportion.
 */
export const TEXELS_PER_UNIT = 32;

/** Convert a count of sprite texels into world units. */
export function texelsToWorld(texels: number): number {
  return texels / TEXELS_PER_UNIT;
}

/**
 * Height of the drawn figure *inside* a unit's billboard quad, in sprite texels.
 *
 * The quad itself is 80 texels tall (2.5 world units at `TEXELS_PER_UNIT`), but it is mostly
 * transparent above the head and below the feet — measured on a rendered frame, a standing
 * humanoid occupies about 48 of those texels. Framing maths wants the figure, not the quad.
 */
export const HUMANOID_TEXEL_HEIGHT = 48;

/**
 * Target on-screen height of a character, as a fraction of frame height.
 *
 * Measured, per VISUAL_TARGET.md "Camera and framing": a Triangle Strategy character is
 * ~130px in a 1080p frame (12%), an FFT character ~180px (17%). Sitting a little under the
 * Triangle number keeps the whole diorama in shot while staying well clear of the failure
 * the brief calls out ("if our units fill a third of the screen the composition is wrong")
 * *and* clear of the opposite failure, which is what we actually had: at 7% the battlefield
 * read as a distant map floating in dead space.
 */
export const REFERENCE_CHARACTER_FRAME_FRACTION = 0.115;

/**
 * The largest a character may get. FFT's own frames measure ~17% of frame height
 * (VISUAL_TARGET.md), so a hair above that is the outer edge of shipped-game practice and
 * well short of the stated failure ("units fill a third of the screen").
 */
export const MAX_CHARACTER_FRAME_FRACTION = 0.18;

/** Ceiling on `frameField`'s breathing room, as a fraction of the board's on-screen span. */
export const MAX_FRAME_MARGIN_FRACTION = 0.15;

/** Centre of the walkable top surface of a grid cell, in world space. */
export function gridToWorld(
  cell: { x: number; y: number; z?: number },
  out: Vector3 = new Vector3(),
): Vector3 {
  return out.set(
    cell.x * TILE_SIZE,
    (cell.z ?? 0) * HEIGHT_UNIT,
    cell.y * TILE_SIZE,
  );
}

/** Inverse of {@link gridToWorld}; returns the containing cell. */
export function worldToGrid(world: Vector3): Vec3 {
  return {
    x: Math.round(world.x / TILE_SIZE),
    y: Math.round(world.z / TILE_SIZE),
    z: Math.round(world.y / HEIGHT_UNIT),
  };
}

/** The four snapped yaw positions, in radians. Index 0 looks from the south-east. */
export const YAW_ANGLES: readonly number[] = [
  MathUtils.degToRad(45),
  MathUtils.degToRad(135),
  MathUtils.degToRad(225),
  MathUtils.degToRad(315),
];

export type YawIndex = 0 | 1 | 2 | 3;

/**
 * How far back the ortho camera sits from its focus point. For an orthographic
 * projection this does not affect framing at all — only the near/far window and,
 * importantly, anything measured in camera distance (scene fog, depth writes).
 * `lighting.ts` uses it as the fog reference plane.
 */
export const RIG_DISTANCE = 160;

// ─────────────────────────────────────────────────────────────────────────────
// Easing
// ─────────────────────────────────────────────────────────────────────────────

/** Weighty in-out. Slow to commit, slow to land — reads as mass, not as lag. */
function easeInOutQuart(t: number): number {
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Frame-rate independent exponential smoothing toward a target. */
function damp(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

// ─────────────────────────────────────────────────────────────────────────────
// Options / tween bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

export interface IsoCameraOptions {
  /** Downward tilt in degrees. FFT reads at ~30°. */
  pitchDegrees?: number;
  /** Starting yaw slot. */
  yawIndex?: YawIndex;
  /** Device pixels per sprite texel at start. */
  pixelScale?: number;
  /** Selectable zoom levels, in device pixels per texel. Must be integers. */
  zoomLevels?: readonly number[];
  /** Seconds for a 90° yaw snap. */
  rotateDuration?: number;
  /** Seconds for a zoom step. */
  zoomDuration?: number;
  /** Smoothing time constant for follow, in seconds. Lower = snappier. */
  followTau?: number;
  /** Disable phase snapping (debug only — the picture will crawl). */
  pixelSnap?: boolean;
  /** Near/far padding around the rig distance. */
  depthRange?: number;
}

interface Tween {
  from: number;
  to: number;
  t: number;
  duration: number;
  ease: (t: number) => number;
  resolve: (() => void) | null;
}

function stepTween(tw: Tween, dt: number): number {
  tw.t = Math.min(1, tw.t + dt / Math.max(1e-4, tw.duration));
  return MathUtils.lerp(tw.from, tw.to, tw.ease(tw.t));
}

interface ShakeState {
  amplitude: number; // world units
  elapsed: number;
  duration: number;
  frequency: number;
  seedX: number;
  seedY: number;
}

export interface FrameFieldOptions {
  /**
   * Ignore the composition floor and honour the contain-fit, so no part of the
   * battlefield is cropped. Costs on-screen character size; use for overview
   * shots and map-wide critique, not for normal play.
   */
  fitWholeField?: boolean;
}

export interface FocusOptions {
  /** Jump immediately instead of easing. */
  immediate?: boolean;
  /** Override the follow time constant for this move. */
  tau?: number;
}

export interface RotateOptions {
  immediate?: boolean;
  duration?: number;
}

export interface CinematicOptions {
  /** Point to push in on. */
  focus?: Vector3 | Vec3;
  /** Device pixels per texel to push to. Fractional is allowed here. */
  pixelScale?: number;
  /** Optional pitch override, degrees. */
  pitchDegrees?: number;
  /** Seconds. */
  duration?: number;
}

export interface ScreenPoint {
  /** CSS pixels from the left of the canvas. */
  x: number;
  /** CSS pixels from the top of the canvas. */
  y: number;
  /** NDC depth, −1 (near) … 1 (far). */
  depth: number;
  /** False when the point is outside the frustum. */
  visible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// IsoCamera
// ─────────────────────────────────────────────────────────────────────────────

export class IsoCamera {
  readonly camera: OrthographicCamera;

  /** Point the rig is looking at, in world space. */
  readonly focusPoint = new Vector3();

  private readonly desiredFocus = new Vector3();

  private pitch: number;
  private basePitch: number;
  private yaw: number;
  private yawSlot: YawIndex;

  private pixelScale: number;
  private basePixelScale: number;
  private readonly zoomLevels: readonly number[];
  private zoomIndex = 0;

  private readonly rotateDuration: number;
  private readonly zoomDuration: number;
  private readonly followTau: number;
  private readonly depthRange: number;
  private pixelSnapEnabled: boolean;

  private yawTween: Tween | null = null;
  private zoomTween: Tween | null = null;
  private pitchTween: Tween | null = null;
  private shakeState: ShakeState | null = null;
  private cinematicActive = false;
  private cinematicSaved: { pixelScale: number; pitch: number; focus: Vector3 } | null = null;

  /** Drawing-buffer size in DEVICE pixels. */
  private bufferWidth = 1;
  private bufferHeight = 1;
  private pixelRatio = 1;

  private followSnap = true;

  // scratch
  private readonly tmpMatrix = new Matrix4();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpVecA = new Vector3();
  private readonly tmpVecB = new Vector3();
  private readonly tmpVecC = new Vector3();
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly up = new Vector3(0, 1, 0);

  constructor(options: IsoCameraOptions = {}) {
    this.basePitch = MathUtils.degToRad(options.pitchDegrees ?? 30);
    this.pitch = this.basePitch;
    this.yawSlot = options.yawIndex ?? 0;
    this.yaw = YAW_ANGLES[this.yawSlot] ?? YAW_ANGLES[0] ?? Math.PI / 4;

    this.zoomLevels = options.zoomLevels ?? [2, 3, 4, 6];
    const startScale = options.pixelScale ?? this.zoomLevels[1] ?? 3;
    this.pixelScale = startScale;
    this.basePixelScale = startScale;
    this.zoomIndex = Math.max(0, this.zoomLevels.indexOf(startScale));

    this.rotateDuration = options.rotateDuration ?? 0.45;
    this.zoomDuration = options.zoomDuration ?? 0.28;
    this.followTau = options.followTau ?? 0.09;
    this.pixelSnapEnabled = options.pixelSnap ?? true;
    this.depthRange = options.depthRange ?? 320;

    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, this.depthRange);
    this.camera.name = 'IsoCamera';
    this.camera.up.copy(this.up);
    this.camera.matrixAutoUpdate = false;

    this.rebuild();
  }

  // ── viewport ──────────────────────────────────────────────────────────────

  /**
   * @param widthPx  drawing-buffer width in device pixels
   * @param heightPx drawing-buffer height in device pixels
   * @param pixelRatio device pixel ratio actually in use
   */
  setViewport(widthPx: number, heightPx: number, pixelRatio: number): void {
    this.bufferWidth = Math.max(1, Math.round(widthPx));
    this.bufferHeight = Math.max(1, Math.round(heightPx));
    this.pixelRatio = pixelRatio > 0 ? pixelRatio : 1;
    this.rebuild();
  }

  /** World units covered by one device pixel at the current zoom. */
  get worldPerDevicePixel(): number {
    return 1 / (TEXELS_PER_UNIT * this.pixelScale);
  }

  /** Device pixels per sprite texel. Integer whenever the rig is at rest. */
  get devicePixelsPerTexel(): number {
    return this.pixelScale;
  }

  get yawIndex(): YawIndex {
    return this.yawSlot;
  }

  get yawRadians(): number {
    return this.yaw;
  }

  get pitchRadians(): number {
    return this.pitch;
  }

  /** True when no tween, shake or follow is in flight — used for convergence. */
  get settled(): boolean {
    if (this.yawTween || this.zoomTween || this.pitchTween || this.shakeState) return false;
    return this.focusPoint.distanceToSquared(this.desiredFocus) < 1e-8;
  }

  // ── focus / follow ────────────────────────────────────────────────────────

  /** Move the look-at point. Eased by default, quantised to whole device pixels. */
  focus(target: Vector3 | Vec3, options: FocusOptions = {}): void {
    if (target instanceof Vector3) this.desiredFocus.copy(target);
    else gridToWorld(target, this.desiredFocus);

    if (options.immediate) {
      this.focusPoint.copy(this.desiredFocus);
      this.rebuild();
    }
    this.followTauOverride = options.tau ?? null;
  }

  private followTauOverride: number | null = null;

  /** Focus a grid cell's surface centre. */
  focusTile(cell: Vec3, options: FocusOptions = {}): void {
    this.focus(gridToWorld(cell, this.tmpVecA.clone()), options);
  }

  /**
   * On-screen height of a standing character at the current zoom, as a fraction of the
   * frame. Compare against {@link REFERENCE_CHARACTER_FRAME_FRACTION}.
   */
  get characterFrameFraction(): number {
    return (HUMANOID_TEXEL_HEIGHT * this.pixelScale) / this.bufferHeight;
  }

  /**
   * The smallest whole pixels-per-texel that keeps a character at the reference size.
   * Resolution-relative, so a 4K frame composes the same as a 1080p one.
   */
  get compositionFloorPixelScale(): number {
    const ideal = (REFERENCE_CHARACTER_FRAME_FRACTION * this.bufferHeight) / HUMANOID_TEXEL_HEIGHT;
    return Math.max(1, Math.round(ideal));
  }

  /**
   * The largest whole pixels-per-texel that still keeps a character no bigger than the FFT
   * reference measurement. This is the hard stop on the cover bias below — VISUAL_TARGET.md
   * calls a unit filling a third of the screen a composition failure, and FFT's own 17% is
   * the outer edge of what a shipped game does.
   */
  get compositionCeilingPixelScale(): number {
    const ideal = (MAX_CHARACTER_FRAME_FRACTION * this.bufferHeight) / HUMANOID_TEXEL_HEIGHT;
    return Math.max(1, Math.floor(ideal));
  }

  /**
   * Frame an entire battlefield: centre on it and pick the largest zoom that fits.
   *
   * "Fits" is not the only constraint. A pure contain-fit with a generous margin pulls back
   * until the map is a postage stamp in an empty frame — which is what it was doing, and it
   * is a composition failure, not a safe default. Neither reference game shows the whole
   * playfield: they crop, and the character size stays constant. So the contain-fit result
   * is clamped up to {@link compositionFloorPixelScale}; the edges of a large map fall
   * outside the frame rather than the subject shrinking out of readability.
   */
  frameField(field: Battlefield, margin = 2, options: FrameFieldOptions = {}): void {
    const bounds = new Box3();
    let any = false;
    for (const tile of field.tiles) {
      if (tile.surface === 'void') continue;
      any = true;
      const top = tile.height * HEIGHT_UNIT;
      bounds.expandByPoint(
        this.tmpVecA.set((tile.x - 0.5) * TILE_SIZE, 0, (tile.y - 0.5) * TILE_SIZE),
      );
      bounds.expandByPoint(
        this.tmpVecB.set((tile.x + 0.5) * TILE_SIZE, top, (tile.y + 0.5) * TILE_SIZE),
      );
    }
    if (!any) {
      bounds.set(
        new Vector3(-0.5, 0, -0.5),
        new Vector3(field.width - 0.5, 1, field.height - 0.5),
      );
    }
    const centre = bounds.getCenter(new Vector3());
    this.focus(centre, { immediate: true });

    // Extent of the bounds when projected onto the camera plane.
    const size = bounds.getSize(this.tmpVecC);
    const spanH = Math.hypot(size.x, size.z);
    const spanV = spanH * Math.sin(this.pitch) + size.y * Math.cos(this.pitch);
    // Margin is breathing room, not a reason to give away a third of the frame. A caller
    // asking for 4 tiles around a 12-tile board is asking for 33% padding on every side,
    // which by itself costs a whole zoom step and is most of why the diorama used to float
    // in a void. Cap it at a fraction of the board so the request scales with the map.
    const cappedMargin = Math.max(0, Math.min(margin, spanH * MAX_FRAME_MARGIN_FRACTION));
    const horizontal = spanH + cappedMargin;
    const vertical = spanV + cappedMargin;

    let best = this.zoomLevels[0] ?? 2;
    for (const level of this.zoomLevels) {
      const wpp = 1 / (TEXELS_PER_UNIT * level);
      if (this.bufferWidth * wpp >= horizontal && this.bufferHeight * wpp >= vertical) {
        best = Math.max(best, level);
      }
    }

    // Composition floor. Never zoom out past the point where a character stops
    // reading — unless the caller explicitly wants the whole board in shot, which
    // is what an overview screenshot and the tactical "show me everything" key
    // both want. The floor is the default precisely because it is right for play.
    const ceiling = this.zoomLevels[this.zoomLevels.length - 1] ?? best;
    const floor = options.fitWholeField === true ? (this.zoomLevels[0] ?? best) : this.compositionFloorPixelScale;
    best = Math.min(Math.max(best, floor), ceiling);

    if (options.fitWholeField !== true) {
      // Cover bias.
      //
      // Contain-fitting a small map leaves the diorama swimming in empty background, and an
      // empty background is the one thing no reference frame has: every frame in
      // refs/curated/triangle is filled corner to corner with scene. So push toward the zoom
      // at which the field actually reaches the frame edges (no margin — margin is breathing
      // room for a map that already fills the frame, not a reason to shrink one that does
      // not), stopping at the character-size ceiling so this can never run away.
      const coverW = this.bufferWidth / (TEXELS_PER_UNIT * Math.max(spanH, 1e-3));
      const coverH = this.bufferHeight / (TEXELS_PER_UNIT * Math.max(spanV, 1e-3));
      const cover = Math.round(Math.max(coverW, coverH));
      best = Math.min(Math.max(best, Math.min(cover, this.compositionCeilingPixelScale)), ceiling);
    }

    this.setPixelScale(best, true);
  }

  // ── rotation ──────────────────────────────────────────────────────────────

  /** Rotate one 90° snap. `direction` +1 turns the world clockwise on screen. */
  rotate(direction: 1 | -1, options: RotateOptions = {}): Promise<void> {
    const next = (((this.yawSlot + direction) % 4) + 4) % 4;
    return this.setYawIndex(next as YawIndex, options);
  }

  setYawIndex(index: YawIndex, options: RotateOptions = {}): Promise<void> {
    const to = YAW_ANGLES[index];
    if (to === undefined) return Promise.resolve();
    this.yawSlot = index;

    if (options.immediate) {
      this.finishYawTween();
      this.yaw = to;
      this.rebuild();
      return Promise.resolve();
    }

    // Take the short way round.
    let target = to;
    while (target - this.yaw > Math.PI) target -= Math.PI * 2;
    while (target - this.yaw < -Math.PI) target += Math.PI * 2;

    this.finishYawTween();
    return new Promise<void>((resolve) => {
      this.yawTween = {
        from: this.yaw,
        to: target,
        t: 0,
        duration: options.duration ?? this.rotateDuration,
        ease: easeInOutQuart,
        resolve,
      };
    });
  }

  private finishYawTween(): void {
    const tw = this.yawTween;
    this.yawTween = null;
    tw?.resolve?.();
  }

  // ── zoom ──────────────────────────────────────────────────────────────────

  zoomIn(): Promise<void> {
    return this.setZoomIndex(this.zoomIndex + 1);
  }

  zoomOut(): Promise<void> {
    return this.setZoomIndex(this.zoomIndex - 1);
  }

  setZoomIndex(index: number): Promise<void> {
    const clamped = MathUtils.clamp(index, 0, this.zoomLevels.length - 1);
    const level = this.zoomLevels[clamped];
    if (level === undefined) return Promise.resolve();
    this.zoomIndex = clamped;
    return this.setPixelScale(level);
  }

  /**
   * Set device-pixels-per-texel. Integers keep the picture perfectly crisp; the
   * tween passes through fractional values for a few frames, which is invisible
   * in motion and always lands on the integer.
   */
  setPixelScale(scale: number, immediate = false): Promise<void> {
    const target = Math.max(0.25, scale);
    if (immediate) {
      this.finishZoomTween();
      this.pixelScale = target;
      if (!this.cinematicActive) this.basePixelScale = target;
      this.rebuild();
      return Promise.resolve();
    }
    this.finishZoomTween();
    if (!this.cinematicActive) this.basePixelScale = target;
    return new Promise<void>((resolve) => {
      this.zoomTween = {
        from: this.pixelScale,
        to: target,
        t: 0,
        duration: this.zoomDuration,
        ease: easeOutCubic,
        resolve,
      };
    });
  }

  private finishZoomTween(): void {
    const tw = this.zoomTween;
    this.zoomTween = null;
    tw?.resolve?.();
  }

  // ── shake ─────────────────────────────────────────────────────────────────

  /**
   * Screen shake. Amplitude is in sprite texels so it scales with zoom exactly
   * like the art does; the pixel snap then quantises it to whole device pixels.
   */
  shake(amplitudeTexels = 3, durationSeconds = 0.35, frequencyHz = 26): void {
    const amplitude = texelsToWorld(amplitudeTexels);
    // Re-triggering keeps the stronger of the two shakes rather than resetting.
    const existing = this.shakeState;
    if (existing && existing.amplitude > amplitude && existing.elapsed < existing.duration) {
      existing.duration = Math.max(existing.duration - existing.elapsed, durationSeconds);
      existing.elapsed = 0;
      return;
    }
    this.shakeState = {
      amplitude,
      elapsed: 0,
      duration: Math.max(0.016, durationSeconds),
      frequency: frequencyHz,
      seedX: Math.random() * 100,
      seedY: Math.random() * 100,
    };
  }

  // ── cinematic ─────────────────────────────────────────────────────────────

  /** Push in for an ability animation. Resolves when the push-in has landed. */
  async cinematic(options: CinematicOptions = {}): Promise<void> {
    if (!this.cinematicActive) {
      this.cinematicActive = true;
      this.cinematicSaved = {
        pixelScale: this.basePixelScale,
        pitch: this.basePitch,
        focus: this.desiredFocus.clone(),
      };
    }
    const duration = options.duration ?? 0.6;
    const jobs: Promise<void>[] = [];

    if (options.focus) this.focus(options.focus, { tau: duration * 0.35 });
    const targetScale = options.pixelScale;
    if (targetScale !== undefined) {
      this.finishZoomTween();
      jobs.push(
        new Promise<void>((resolve) => {
          this.zoomTween = {
            from: this.pixelScale,
            to: targetScale,
            t: 0,
            duration,
            ease: easeInOutCubic,
            resolve,
          };
        }),
      );
    }
    if (options.pitchDegrees !== undefined) {
      jobs.push(this.tweenPitch(MathUtils.degToRad(options.pitchDegrees), duration));
    }
    await Promise.all(jobs);
  }

  /** Return from cinematic framing to the gameplay rig. */
  async endCinematic(duration = 0.5): Promise<void> {
    const saved = this.cinematicSaved;
    this.cinematicActive = false;
    this.cinematicSaved = null;
    if (!saved) return;

    this.focus(saved.focus, { tau: duration * 0.35 });
    this.finishZoomTween();
    const jobs: Promise<void>[] = [
      new Promise<void>((resolve) => {
        this.zoomTween = {
          from: this.pixelScale,
          to: saved.pixelScale,
          t: 0,
          duration,
          ease: easeInOutCubic,
          resolve,
        };
      }),
      this.tweenPitch(saved.pitch, duration),
    ];
    this.basePixelScale = saved.pixelScale;
    await Promise.all(jobs);
  }

  private tweenPitch(to: number, duration: number): Promise<void> {
    const tw = this.pitchTween;
    this.pitchTween = null;
    tw?.resolve?.();
    if (!this.cinematicActive) this.basePitch = to;
    return new Promise<void>((resolve) => {
      this.pitchTween = {
        from: this.pitch,
        to,
        t: 0,
        duration,
        ease: easeInOutCubic,
        resolve,
      };
    });
  }

  // ── per-frame ─────────────────────────────────────────────────────────────

  update(dt: number): void {
    const step = MathUtils.clamp(dt, 0, 0.1);

    if (this.yawTween) {
      this.yaw = stepTween(this.yawTween, step);
      if (this.yawTween.t >= 1) {
        const slot = YAW_ANGLES[this.yawSlot];
        if (slot !== undefined) this.yaw = slot;
        this.finishYawTween();
      }
    }

    if (this.zoomTween) {
      this.pixelScale = stepTween(this.zoomTween, step);
      if (this.zoomTween.t >= 1) {
        this.pixelScale = this.zoomTween.to;
        this.finishZoomTween();
      }
    }

    if (this.pitchTween) {
      this.pitch = stepTween(this.pitchTween, step);
      if (this.pitchTween.t >= 1) {
        this.pitch = this.pitchTween.to;
        const tw = this.pitchTween;
        this.pitchTween = null;
        tw.resolve?.();
      }
    }

    // Follow: exponential damp, then let the pixel snap quantise it.
    if (this.focusPoint.distanceToSquared(this.desiredFocus) > 1e-8) {
      const tau = this.followTauOverride ?? this.followTau;
      this.focusPoint.set(
        damp(this.focusPoint.x, this.desiredFocus.x, tau, step),
        damp(this.focusPoint.y, this.desiredFocus.y, tau, step),
        damp(this.focusPoint.z, this.desiredFocus.z, tau, step),
      );
      // Snap out of the asymptote once we are inside a tenth of a texel.
      if (this.focusPoint.distanceToSquared(this.desiredFocus) < texelsToWorld(0.1) ** 2) {
        this.focusPoint.copy(this.desiredFocus);
        this.followTauOverride = null;
      }
    }

    if (this.shakeState) {
      this.shakeState.elapsed += step;
      if (this.shakeState.elapsed >= this.shakeState.duration) this.shakeState = null;
    }

    this.followSnap = this.yawTween === null && this.pitchTween === null;
    this.rebuild();
  }

  /**
   * Recompute frustum, orientation, position and the sub-pixel phase correction.
   * Cheap enough to run unconditionally every frame; there is no hidden state.
   */
  private rebuild(): void {
    const w = this.worldPerDevicePixel;

    // 1 — frustum sized in whole device pixels (see header, step 1).
    const halfW = (this.bufferWidth * w) / 2;
    const halfH = (this.bufferHeight * w) / 2;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.near = 0.1;
    this.camera.far = RIG_DISTANCE * 2 + this.depthRange;
    this.camera.updateProjectionMatrix();

    // 2 — orientation from yaw/pitch.
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const dir = this.tmpVecA.set(cp * Math.sin(this.yaw), sp, cp * Math.cos(this.yaw));

    const eye = this.tmpVecB.copy(this.focusPoint).addScaledVector(dir, RIG_DISTANCE);
    this.tmpMatrix.lookAt(eye, this.focusPoint, this.up);
    this.tmpQuat.setFromRotationMatrix(this.tmpMatrix);
    this.camera.quaternion.copy(this.tmpQuat);
    this.camera.position.copy(eye);

    // 3 — shake, applied in the camera's own screen plane.
    const shake = this.shakeState;
    if (shake) {
      const k = 1 - shake.elapsed / shake.duration;
      const falloff = k * k; // quadratic decay reads as an impact, not a wobble
      const phase = shake.elapsed * shake.frequency;
      const ox =
        Math.sin(phase * 1.0 + shake.seedX) * Math.sin(phase * 0.37 + shake.seedY) *
        shake.amplitude * falloff;
      const oy =
        Math.sin(phase * 1.31 + shake.seedY) * Math.cos(phase * 0.53 + shake.seedX) *
        shake.amplitude * falloff;
      const right = this.tmpVecC.setFromMatrixColumn(this.tmpMatrix, 0);
      this.camera.position.addScaledVector(right, ox);
      const camUp = this.tmpVecA.setFromMatrixColumn(this.tmpMatrix, 1);
      this.camera.position.addScaledVector(camUp, oy);
    }

    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);

    // 4 — phase correction: force the world origin onto a whole device pixel.
    if (this.pixelSnapEnabled && this.followSnap) {
      const viewOrigin = this.tmpVecA.set(0, 0, 0).applyMatrix4(this.camera.matrixWorldInverse);
      const px = viewOrigin.x / w + this.bufferWidth / 2;
      const py = viewOrigin.y / w + this.bufferHeight / 2;
      const dxView = (Math.round(px) - px) * w;
      const dyView = (Math.round(py) - py) * w;
      if (dxView !== 0 || dyView !== 0) {
        // Moving the camera −δ along its right axis raises a point's view x by δ.
        const right = this.tmpVecB.setFromMatrixColumn(this.camera.matrixWorld, 0);
        const camUp = this.tmpVecC.setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.camera.position.addScaledVector(right, -dxView);
        this.camera.position.addScaledVector(camUp, -dyView);
        this.camera.updateMatrix();
        this.camera.updateMatrixWorld(true);
      }
    }
  }

  // ── projection helpers ────────────────────────────────────────────────────

  /**
   * Round a world position onto the device-pixel lattice as seen by this camera.
   *
   * Billboards must call this on their anchor every frame (the lattice moves
   * with the camera). Depth along the view axis is untouched, so sorting is
   * unaffected. With `TEXELS_PER_UNIT` texels per unit and an even texel size,
   * a quad centred on the returned point has all four edges on pixel
   * boundaries; for an odd texel width pass `halfPixelX`/`halfPixelY` to bias
   * the lattice by half a pixel so the quad's edges — not its centre — align.
   */
  snapToPixelGrid(
    world: Vector3,
    out: Vector3 = new Vector3(),
    halfPixelX = false,
    halfPixelY = false,
  ): Vector3 {
    const w = this.worldPerDevicePixel;
    const halfW = this.bufferWidth / 2;
    const halfH = this.bufferHeight / 2;
    out.copy(world).applyMatrix4(this.camera.matrixWorldInverse);

    const biasX = halfPixelX ? 0.5 : 0;
    const biasY = halfPixelY ? 0.5 : 0;
    const px = out.x / w + halfW - biasX;
    const py = out.y / w + halfH - biasY;
    out.x = (Math.round(px) + biasX - halfW) * w;
    out.y = (Math.round(py) + biasY - halfH) * w;

    return out.applyMatrix4(this.camera.matrixWorld);
  }

  /** World → canvas CSS pixels. */
  worldToScreen(world: Vector3, out?: ScreenPoint): ScreenPoint {
    const v = this.tmpVecA.copy(world).project(this.camera);
    const cssW = this.bufferWidth / this.pixelRatio;
    const cssH = this.bufferHeight / this.pixelRatio;
    const point: ScreenPoint = out ?? { x: 0, y: 0, depth: 0, visible: false };
    point.x = (v.x * 0.5 + 0.5) * cssW;
    point.y = (-v.y * 0.5 + 0.5) * cssH;
    point.depth = v.z;
    point.visible = v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1 && v.z >= -1 && v.z <= 1;
    return point;
  }

  /** Canvas CSS pixels → a world-space ray. */
  screenToRay(cssX: number, cssY: number, out: Ray = new Ray()): Ray {
    const cssW = this.bufferWidth / this.pixelRatio;
    const cssH = this.bufferHeight / this.pixelRatio;
    this.ndc.set((cssX / cssW) * 2 - 1, -(cssY / cssH) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    out.copy(this.raycaster.ray);
    return out;
  }

  /** Raycast against arbitrary scene objects (terrain meshes, sprite quads…). */
  raycast(cssX: number, cssY: number, objects: Object3D[], recursive = true): Intersection[] {
    const cssW = this.bufferWidth / this.pixelRatio;
    const cssH = this.bufferHeight / this.pixelRatio;
    this.ndc.set((cssX / cssW) * 2 - 1, -(cssY / cssH) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObjects(objects, recursive);
  }

  /**
   * Pick a battlefield tile under the cursor without needing the terrain meshes.
   *
   * Terrain is a heightfield of solid columns: tile (x, y) occupies the square
   * [x−½, x+½] × [y−½, y+½] and is solid from `floorY` up to its walkable
   * surface, which for a sloped tile varies across the square. So this marches
   * the pick ray forward in sub-tile steps, testing "is this sample inside a
   * column?" at each one, then bisects the first inside/outside straddle to land
   * on the surface. That reproduces `terrain.ts`'s geometry — ramps included —
   * which a flat per-tile box test does not: on an incline a flat box picks the
   * neighbouring tile along the whole uphill edge.
   *
   * The result is the tile whose column the ray first enters, so a tall block
   * correctly occludes what is behind it and clicking a visible side face selects
   * the block that owns it.
   *
   * `floorY` must reach at least as low as the bottom of the skirt `terrain.ts`
   * generates (2.5 world units below the lowest tile) or clicks on the skirt
   * return `undefined`. The default is deliberately generous.
   *
   * Sub-tile bevels are not modelled — expect the chamfer-width band at a tile
   * border (~1/16 tile) to resolve to whichever tile owns the majority of the
   * pixel. Use `raycast()` against the terrain mesh if you need the exact
   * surface point rather than the tile identity.
   */
  screenToTile(
    cssX: number,
    cssY: number,
    field: Battlefield,
    floorY = -8,
  ): Vec3 | undefined {
    const ray = this.screenToRay(cssX, cssY, this.pickRay);
    const o = ray.origin;
    const d = ray.direction;

    // Clip the ray to the field's bounding box so we never march empty space.
    const minX = -0.5 * TILE_SIZE;
    const minZ = -0.5 * TILE_SIZE;
    const maxX = (field.width - 0.5) * TILE_SIZE;
    const maxZ = (field.height - 0.5) * TILE_SIZE;
    let maxTop = floorY;
    for (const tile of field.tiles) {
      if (tile.surface === 'void') continue;
      const top = (tile.height + 1) * HEIGHT_UNIT;
      if (top > maxTop) maxTop = top;
    }
    const span = rayBoxSpan(o, d, minX, floorY, minZ, maxX, maxTop, maxZ);
    if (!span) return undefined;

    const [tEnter, tExit] = span;
    // An eighth of a tile is finer than the steepest ramp's rise per step, so we
    // cannot step over a thin sliver of surface.
    const step = TILE_SIZE / 8;
    const probe = this.tmpVecC;

    let prevT = Math.max(0, tEnter);
    if (this.sampleSolid(field, o, d, prevT, floorY, probe)) {
      return this.tileAtRay(field, o, d, prevT, probe);
    }

    for (let t = prevT + step; t <= tExit; t += step) {
      if (this.sampleSolid(field, o, d, t, floorY, probe)) {
        // Bisect the straddle so the hit lands on the surface, not a step in.
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          if (this.sampleSolid(field, o, d, mid, floorY, probe)) hi = mid;
          else lo = mid;
        }
        return this.tileAtRay(field, o, d, hi, probe);
      }
      prevT = t;
    }
    return undefined;
  }

  /** True when the point `t` along the ray is inside a terrain column. */
  private sampleSolid(
    field: Battlefield,
    origin: Vector3,
    dir: Vector3,
    t: number,
    floorY: number,
    scratch: Vector3,
  ): boolean {
    scratch.copy(dir).multiplyScalar(t).add(origin);
    if (scratch.y < floorY) return false;
    const tx = Math.round(scratch.x / TILE_SIZE);
    const ty = Math.round(scratch.z / TILE_SIZE);
    const tile = field.tileAt(tx, ty);
    if (!tile || tile.surface === 'void') return false;
    const u = scratch.x / TILE_SIZE - tx + 0.5;
    const v = scratch.z / TILE_SIZE - ty + 0.5;
    return scratch.y <= (tile.height + slopeOffsetHalf(tile.slope, u, v)) * HEIGHT_UNIT;
  }

  private tileAtRay(
    field: Battlefield,
    origin: Vector3,
    dir: Vector3,
    t: number,
    scratch: Vector3,
  ): Vec3 | undefined {
    scratch.copy(dir).multiplyScalar(t).add(origin);
    const tx = Math.round(scratch.x / TILE_SIZE);
    const ty = Math.round(scratch.z / TILE_SIZE);
    const tile = field.tileAt(tx, ty);
    if (!tile) return undefined;
    return { x: tile.x, y: tile.y, z: tile.height };
  }

  private readonly pickRay = new Ray();

  /** The underlying three.js camera, for anything that needs a plain `Camera`. */
  get three(): Camera {
    return this.camera;
  }
}

/**
 * Ray/AABB slab test. Returns `[tEnter, tExit]` along `d` (clamped so tEnter is
 * never negative), or `null` when the ray misses the box entirely.
 */
function rayBoxSpan(
  o: Vector3,
  d: Vector3,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): [number, number] | null {
  let tMin = -Infinity;
  let tMax = Infinity;

  if (!slab(o.x, d.x, minX, maxX)) return null;
  if (!slab(o.y, d.y, minY, maxY)) return null;
  if (!slab(o.z, d.z, minZ, maxZ)) return null;
  if (tMax < 0) return null;
  return [Math.max(0, tMin), tMax];

  function slab(origin: number, dir: number, lo: number, hi: number): boolean {
    if (Math.abs(dir) < 1e-9) return origin >= lo && origin <= hi;
    const inv = 1 / dir;
    let t1 = (lo - origin) * inv;
    let t2 = (hi - origin) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    return tMin <= tMax;
  }
}

/**
 * Height offset above `Tile.height`, in half-tiles, at local tile coordinate
 * (u, v) — u west→east, v north→south, both 0..1.
 *
 * This MUST match `slopeOffsetHalf` in `terrain.ts`, which is what actually
 * generates the surface; picking that disagrees with the mesh is worse than no
 * picking at all. An incline spans exactly two half-tiles across the tile, the
 * FFT convention, so ramps stitch to their flat neighbours with no gap.
 */
function slopeOffsetHalf(slope: SlopeKind, u: number, v: number): number {
  switch (slope) {
    case 'incline-n':
      return (0.5 - v) * 2;
    case 'incline-s':
      return (v - 0.5) * 2;
    case 'incline-e':
      return (u - 0.5) * 2;
    case 'incline-w':
      return (0.5 - u) * 2;
    case 'convex': {
      const r2 = (u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5);
      return 0.7 * (1 - 4 * r2);
    }
    case 'concave': {
      const r2 = (u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5);
      return -0.7 * (1 - 4 * r2);
    }
    case 'flat':
    default:
      return 0;
  }
}
