/**
 * EverTactics — sprite animation.
 *
 * Three things live here, and nothing in this file imports three.js so the whole
 * lot stays unit-testable:
 *
 *  1. **View resolution.** FFT sheets only ever draw a unit facing *screen-left*;
 *     the right-facing poses are horizontal mirrors. Combined with a camera that
 *     rotates in 90° steps, the correct pose is a function of
 *     'facing - cameraYaw', not of 'facing' alone. 'resolveView' is what makes a
 *     unit turn to keep its back to you when you rotate the camera behind it —
 *     the signature detail of the genre, and the thing that looks broken instantly
 *     if you get it wrong.
 *
 *  2. **The clip player.** 'SpriteAnimator' runs 'AnimName' states with per-frame
 *     durations, looping, one-shot-with-callback, an impact cue for attacks, and
 *     a *distance-locked* mode where the walk cycle is driven by how far the unit
 *     has actually travelled rather than by wall-clock time. That is the only way
 *     footfalls land on the ground instead of sliding.
 *
 *  3. **Procedural pose.** The shipped sheets only expose the whole-body idle
 *     poses (see 'sprites.ts' for the layout analysis); the attack/cast/hurt/KO
 *     frames are packed as body parts that need the SHP/SEQ binaries decoded.
 *     Until that lands, every clip carries a 'ProceduralPose' curve — lunge,
 *     recoil, cast-rise, collapse — which the renderer applies to the quad. When
 *     real frames arrive a clip simply sets 'procedural: false' and the curves
 *     stop being evaluated; nothing else changes.
 */

import type { AnimName, Facing, Vec3 } from '@core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Facings and view resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five distinct poses an FFT sheet draws. Everything else is a mirror.
 * 'side' is the pure profile; the two quarters are the 3/4 views that a 45°
 * isometric camera actually spends all its time looking at.
 */
export type ViewKey = 'front' | 'frontQuarter' | 'side' | 'backQuarter' | 'back';

export const VIEW_KEYS: readonly ViewKey[] = [
  'front',
  'frontQuarter',
  'side',
  'backQuarter',
  'back',
] as const;

/**
 * World-space heading of a grid facing, in radians, using the shared convention
 * from 'render/camera.ts': grid +x → world +X (east), grid +y → world +Z (south).
 * The angle is 'atan2(dirX, dirZ)', matching the camera's yaw parameterisation.
 */
export function facingAngle(facing: Facing): number {
  switch (facing) {
    case 'S':
      return 0; // +Z
    case 'E':
      return Math.PI / 2; // +X
    case 'N':
      return Math.PI; // -Z
    case 'W':
      return -Math.PI / 2; // -X
  }
}

const TWO_PI = Math.PI * 2;

/** Wrap to (-π, π]. */
function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TWO_PI;
  if (x <= 0) x += TWO_PI;
  return x - Math.PI;
}

/** Nearest grid facing to a world heading. */
export function facingFromAngle(angle: number): Facing {
  const a = wrapAngle(angle);
  if (a >= -Math.PI / 4 && a < Math.PI / 4) return 'S';
  if (a >= Math.PI / 4 && a < (3 * Math.PI) / 4) return 'E';
  if (a >= (-3 * Math.PI) / 4 && a < -Math.PI / 4) return 'W';
  return 'N';
}

/** Facing implied by a grid-space step. Ties break to the dominant axis. */
export function facingFromDelta(dx: number, dy: number): Facing | null {
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'E' : 'W';
  return dy > 0 ? 'S' : 'N';
}

export interface ViewSelection {
  view: ViewKey;
  /** True when the drawn pose must be flipped horizontally. */
  mirror: boolean;
}

const QUARTER = Math.PI / 8; // 22.5°

/**
 * Pick the drawn pose for a unit facing 'facing' seen from a camera at 'cameraYaw'.
 *
 * 'cameraYaw' follows 'IsoCamera.yawRadians': the camera *sits* in the direction
 * 'yaw' from its focus point, so a unit whose heading equals the yaw is looking
 * straight at the lens.
 *
 * The relative angle is signed: negative means the unit's nose points toward the
 * left of the screen, which is how the art is drawn, so 'mirror' is simply
 * 'relative > 0'. Continuous in 'cameraYaw', so an eased 90° rotation flips the
 * pose exactly halfway through instead of popping at the ends.
 */
export function resolveView(facing: Facing, cameraYaw: number): ViewSelection {
  const relative = wrapAngle(facingAngle(facing) - cameraYaw);
  const magnitude = Math.abs(relative);
  const mirror = relative > 0;

  if (magnitude <= QUARTER) return { view: 'front', mirror: false };
  if (magnitude <= 3 * QUARTER) return { view: 'frontQuarter', mirror };
  if (magnitude <= 5 * QUARTER) return { view: 'side', mirror };
  if (magnitude <= 7 * QUARTER) return { view: 'backQuarter', mirror };
  return { view: 'back', mirror: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clips
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One blit in an authentic SHP frame: a rectangle of the sheet, placed at a
 * signed offset from the unit's origin. Mirrors the record 'tools/decode-shp-seq.mjs'
 * emits into 'public/assets/animations.json' — 'i8 dx, i8 dy, u16 desc', unpacked.
 *
 * All values are in **sheet texels at 1× (the original 256×512 SPR space)**; the
 * renderer scales by the sheet's 'hdScale' when sampling an HD sheet.
 */
export interface ShpPart {
  /** Placement offset from the unit origin, +x right, +y down. */
  dx: number;
  dy: number;
  /** Source rect on the sheet. */
  sx: number;
  sy: number;
  w: number;
  h: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** One drawn frame: a flat cell index into the sheet's frame grid. */
export interface AnimFrame {
  /** 'row * columns + column' in the sheet's frame grid. */
  cell: number;
  /** Flip on top of the view mirror — for poses drawn facing the other way. */
  flip?: boolean;
  /** Per-frame pixel nudge, in sheet texels. */
  offsetX?: number;
  offsetY?: number;
  /**
   * Authentic SHP frame assembly, when the sheet has decoded animation data.
   * Present *instead of* 'cell' being meaningful: a renderer that understands
   * parts must draw these and ignore 'cell'; one that does not can keep using
   * 'cell' and get the pose-frame fallback. See 'ShpLibrary'.
   */
  parts?: readonly ShpPart[];
}

/**
 * A quad-space pose applied on top of the drawn frame. Offsets are in sheet
 * texels so they stay pixel-locked at every zoom level.
 */
export interface ProceduralPose {
  offsetX: number;
  offsetY: number;
  /** Roll about the view axis, radians. */
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Multiplied into the material's brightness uniform. */
  brightness: number;
}

export function identityPose(): ProceduralPose {
  return { offsetX: 0, offsetY: 0, rotation: 0, scaleX: 1, scaleY: 1, brightness: 1 };
}

/** Evaluated at normalised clip time 't ∈ [0, 1]', writing into 'out'. */
export type PoseCurve = (t: number, out: ProceduralPose) => void;

export interface AnimClip {
  readonly name: AnimName;
  /** Frames per drawn view. Every view must be populated. */
  readonly views: Readonly<Record<ViewKey, readonly AnimFrame[]>>;
  /** Milliseconds per frame, parallel to the frame arrays. */
  readonly durations: readonly number[];
  readonly loop: boolean;
  /**
   * When true the clip does not advance on its own — the caller supplies a phase
   * from distance travelled. Used by 'walk' and 'run' so footfalls stay planted.
   */
  readonly distanceDriven?: boolean;
  /** Fraction of the clip at which an attack connects / a spell releases. */
  readonly impactAt?: number;
  /** Cycle phases (0..1) at which a foot hits the ground. */
  readonly footfalls?: readonly number[];
  /** Procedural pose curve, ignored once real drawn frames exist. */
  readonly pose?: PoseCurve;
  /** Set to false by the asset pipeline when the clip has authentic frames. */
  readonly procedural?: boolean;
}

export type AnimSet = Readonly<Record<AnimName, AnimClip>>;

/** Total duration of a clip in milliseconds. */
export function clipDuration(clip: AnimClip): number {
  let total = 0;
  for (const d of clip.durations) total += d;
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// The default clip table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which cell of the first band of an FFT sheet draws each view.
 *
 * Derived by measuring the shipped art rather than guessed: cells 2 and 4 are the
 * only two whose cape/skin mass is horizontally symmetric (they are the pure
 * front and pure back), cell 4 carries ~3x the cape pixels of cell 2 so it is the
 * one seen from behind, and cells 0/1/3 all place the cape to the right of the
 * silhouette centre and the face to the left — i.e. every asymmetric pose is
 * drawn facing screen-left, which is why 'resolveView' mirrors rather than
 * indexing more cells.
 */
export const DEFAULT_VIEW_CELL: Readonly<Record<ViewKey, number>> = {
  side: 0,
  frontQuarter: 1,
  front: 2,
  backQuarter: 3,
  back: 4,
};

function staticViews(cell: Readonly<Record<ViewKey, number>>): Record<ViewKey, AnimFrame[]> {
  return {
    front: [{ cell: cell.front }],
    frontQuarter: [{ cell: cell.frontQuarter }],
    side: [{ cell: cell.side }],
    backQuarter: [{ cell: cell.backQuarter }],
    back: [{ cell: cell.back }],
  };
}

/** Smooth 0→1→0 hump. */
function hump(t: number): number {
  return Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
}

function easeOutBack(t: number): number {
  const c = 2.2;
  const x = t - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}

/**
 * Build the fallback clip table for a sheet whose only decoded frames are the
 * whole-body idle poses in band 0.
 *
 * Every clip still has real, tuned motion — the movement is authored as pose
 * curves instead of as drawn frames. 'anticipate → strike → recover' on the
 * attack, a rise-and-settle on the cast, a hard recoil on hurt, a topple with a
 * bounce on the KO.
 */
export function defaultAnimationSet(
  viewCell: Readonly<Record<ViewKey, number>> = DEFAULT_VIEW_CELL,
): AnimSet {
  const views = () => staticViews(viewCell);

  const idle: AnimClip = {
    name: 'idle',
    views: views(),
    durations: [900],
    loop: true,
    procedural: true,
    // A single texel of breathing. Any more and it reads as a bobbing balloon.
    pose: (t, out) => {
      out.offsetY = Math.round(Math.sin(t * TWO_PI) * 0.6);
    },
  };

  const walk: AnimClip = {
    name: 'walk',
    views: views(),
    durations: [1],
    loop: true,
    distanceDriven: true,
    footfalls: [0, 0.5],
    procedural: true,
    // Two footfalls per cycle: the body rises between them and drops onto each
    // step, with a slight counter-sway. Phase 0 and 0.5 are contacts.
    pose: (t, out) => {
      out.offsetY = Math.abs(Math.sin(t * TWO_PI)) * 1.4;
      out.offsetX = Math.sin(t * TWO_PI) * 0.5;
      out.rotation = Math.sin(t * TWO_PI) * 0.02;
    },
  };

  const run: AnimClip = {
    ...walk,
    name: 'run',
    pose: (t, out) => {
      out.offsetY = Math.abs(Math.sin(t * TWO_PI)) * 2.4;
      out.offsetX = Math.sin(t * TWO_PI) * 0.9;
      out.rotation = Math.sin(t * TWO_PI) * 0.035;
    },
  };

  const attack: AnimClip = {
    name: 'attack',
    views: views(),
    durations: [420],
    loop: false,
    impactAt: 0.42,
    procedural: true,
    pose: (t, out) => {
      // 0.00–0.30 wind up away from the target, 0.30–0.45 snap forward, then settle.
      if (t < 0.3) {
        const k = t / 0.3;
        out.offsetX = -3.5 * k;
        out.offsetY = 1.5 * k;
        out.rotation = -0.06 * k;
      } else if (t < 0.45) {
        const k = (t - 0.3) / 0.15;
        out.offsetX = -3.5 + 10 * k;
        out.offsetY = 1.5 * (1 - k);
        out.rotation = -0.06 + 0.14 * k;
        out.scaleX = 1 + 0.05 * k;
      } else {
        const k = (t - 0.45) / 0.55;
        const ease = 1 - Math.pow(1 - k, 3);
        out.offsetX = 6.5 * (1 - ease);
        out.rotation = 0.08 * (1 - ease);
        out.scaleX = 1.05 - 0.05 * ease;
      }
    },
  };

  const punch: AnimClip = { ...attack, name: 'punch' };
  const kick: AnimClip = {
    ...attack,
    name: 'kick',
    durations: [460],
    pose: (t, out) => {
      const k = hump(t);
      out.offsetX = k * 5;
      out.offsetY = k * 3;
      out.rotation = k * 0.12;
    },
  };

  const cast: AnimClip = {
    name: 'cast',
    views: views(),
    durations: [820],
    loop: false,
    impactAt: 0.62,
    procedural: true,
    pose: (t, out) => {
      // Sink, then lift with the release, then drop back.
      const sink = Math.min(1, t / 0.35);
      const lift = t < 0.35 ? 0 : Math.min(1, (t - 0.35) / 0.3);
      const fall = t < 0.65 ? 0 : (t - 0.65) / 0.35;
      out.offsetY = -1.6 * sink + 3.6 * lift - 2.0 * fall;
      out.scaleY = 1 + 0.03 * lift - 0.02 * sink;
      out.brightness = 1 + 0.35 * hump(Math.min(1, Math.max(0, (t - 0.45) / 0.35)));
    },
  };

  const charge: AnimClip = {
    name: 'charge',
    views: views(),
    durations: [1200],
    loop: true,
    procedural: true,
    pose: (t, out) => {
      out.offsetY = Math.sin(t * TWO_PI) * 0.8;
      out.brightness = 1 + 0.18 * (0.5 + 0.5 * Math.sin(t * TWO_PI * 2));
    },
  };

  const sing: AnimClip = { ...charge, name: 'sing' };

  const item: AnimClip = {
    name: 'item',
    views: views(),
    durations: [600],
    loop: false,
    impactAt: 0.5,
    procedural: true,
    pose: (t, out) => {
      const k = hump(t);
      out.offsetY = k * 2.2;
      out.rotation = Math.sin(t * TWO_PI) * 0.03;
    },
  };

  const throwClip: AnimClip = { ...attack, name: 'throw', durations: [400], impactAt: 0.5 };
  const aim: AnimClip = {
    name: 'aim',
    views: views(),
    durations: [520],
    loop: false,
    impactAt: 0.7,
    procedural: true,
    pose: (t, out) => {
      // Draw back and hold, then a short release recoil.
      if (t < 0.7) {
        const k = t / 0.7;
        out.offsetX = -2.5 * (1 - Math.pow(1 - k, 2));
      } else {
        const k = (t - 0.7) / 0.3;
        out.offsetX = -2.5 + 4 * k;
        out.scaleX = 1 + 0.04 * (1 - k);
      }
    },
  };

  const hurt: AnimClip = {
    name: 'hurt',
    views: views(),
    durations: [320],
    loop: false,
    procedural: true,
    pose: (t, out) => {
      // Hard knock back on the first two frames, elastic return.
      const knock = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75;
      out.offsetX = -5 * knock;
      out.rotation = -0.1 * knock;
      out.scaleY = 1 - 0.06 * knock;
      out.scaleX = 1 + 0.06 * knock;
    },
  };

  const defend: AnimClip = {
    name: 'defend',
    views: views(),
    durations: [480],
    loop: false,
    procedural: true,
    pose: (t, out) => {
      const k = hump(t);
      out.offsetY = -1.5 * k;
      out.scaleY = 1 - 0.05 * k;
      out.scaleX = 1 + 0.04 * k;
    },
  };

  const ko: AnimClip = {
    name: 'ko',
    views: views(),
    durations: [640],
    loop: false,
    procedural: true,
    pose: (t, out) => {
      // Topple onto the back with a small bounce, then lie there desaturated.
      const fall = Math.min(1, t / 0.65);
      const settle = easeOutBack(fall);
      out.rotation = -1.35 * settle;
      out.offsetY = -14 * settle + 3 * hump(fall);
      out.offsetX = -6 * settle;
      out.scaleY = 1 - 0.08 * settle;
      out.brightness = 1 - 0.35 * fall;
    },
  };

  const crystal: AnimClip = {
    name: 'crystal',
    views: views(),
    durations: [1100],
    loop: false,
    procedural: true,
    pose: (t, out) => {
      // Rise and brighten as the body gives way; the dissolve uniform does the rest.
      out.offsetY = -14 + 6 * t;
      out.rotation = -1.35 * (1 - t * 0.35);
      out.brightness = 1 + 1.6 * t;
    },
  };

  const victory: AnimClip = {
    name: 'victory',
    views: views(),
    durations: [700],
    loop: true,
    procedural: true,
    pose: (t, out) => {
      out.offsetY = Math.abs(Math.sin(t * Math.PI)) * 4;
      out.rotation = Math.sin(t * TWO_PI) * 0.05;
    },
  };

  const dance: AnimClip = {
    name: 'dance',
    views: views(),
    durations: [900],
    loop: true,
    procedural: true,
    pose: (t, out) => {
      out.offsetX = Math.sin(t * TWO_PI) * 2.5;
      out.rotation = Math.sin(t * TWO_PI) * 0.08;
      out.offsetY = Math.abs(Math.sin(t * TWO_PI * 2)) * 1.5;
    },
  };

  const jump: AnimClip = {
    name: 'jump',
    views: views(),
    durations: [420],
    loop: false,
    procedural: true,
    pose: (t, out) => {
      out.scaleY = 1 + 0.1 * (1 - t);
      out.scaleX = 1 - 0.06 * (1 - t);
    },
  };

  const land: AnimClip = {
    name: 'land',
    views: views(),
    durations: [260],
    loop: false,
    procedural: true,
    pose: (t, out) => {
      const k = 1 - t;
      out.scaleY = 1 - 0.16 * k * k;
      out.scaleX = 1 + 0.12 * k * k;
      out.offsetY = -2 * k * k;
    },
  };

  return {
    idle,
    walk,
    run,
    attack,
    cast,
    charge,
    item,
    hurt,
    ko,
    crystal,
    victory,
    jump,
    land,
    defend,
    sing,
    dance,
    aim,
    throw: throwClip,
    punch,
    kick,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The player
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayOptions {
  /** Override the clip's own loop flag. */
  loop?: boolean;
  /** Playback rate multiplier. */
  speed?: number;
  /** Restart even if this clip is already playing. */
  restart?: boolean;
  /** Fired once when a non-looping clip reaches its end. */
  onComplete?: () => void;
  /** Fired once at 'clip.impactAt' — the moment a blow connects. */
  onImpact?: () => void;
  /** Fired at each of 'clip.footfalls', for step dust and sound. */
  onFootfall?: (index: number) => void;
}

const EMPTY_FRAME: AnimFrame = { cell: 0 };

/**
 * Plays one clip at a time. Deliberately not a blend tree: FFT-lineage sprite
 * animation is a hard state machine, and cross-fading pixel art looks like a
 * rendering bug.
 */
export class SpriteAnimator {
  private set: AnimSet;
  private clip: AnimClip;
  private clipName: AnimName = 'idle';

  private elapsedMs = 0;
  private totalMs = 0;
  private frameIndex = 0;
  private looping = true;
  private speed = 1;
  private finished = false;

  private onComplete: (() => void) | null = null;
  private onImpact: (() => void) | null = null;
  private onFootfall: ((index: number) => void) | null = null;
  private impactFired = false;

  /** Set while a distance-driven clip is being pushed by a path walk. */
  private cyclePhase: number | null = null;

  private readonly poseOut: ProceduralPose = identityPose();

  constructor(set: AnimSet) {
    this.set = set;
    const idle = set.idle;
    this.clip = idle;
    this.totalMs = clipDuration(idle);
    this.looping = idle.loop;
  }

  /** Swap in a richer clip table (e.g. once the SHP/SEQ pipeline has run). */
  setAnimationSet(set: AnimSet): void {
    this.set = set;
    this.play(this.clipName, { restart: true });
  }

  get name(): AnimName {
    return this.clipName;
  }

  get current(): AnimClip {
    return this.clip;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Progress through the clip, 0..1. Wraps for looping clips. */
  get normalizedTime(): number {
    if (this.clip.distanceDriven) return this.cyclePhase ?? 0;
    if (this.totalMs <= 0) return this.finished ? 1 : 0;
    return Math.min(1, this.elapsedMs / this.totalMs);
  }

  play(name: AnimName, options: PlayOptions = {}): void {
    const next = this.set[name] ?? this.set.idle;
    if (!options.restart && this.clipName === name && !this.finished) {
      // Refresh the callbacks so a repeated 'play' can still hook completion.
      if (options.onComplete) this.onComplete = options.onComplete;
      if (options.onImpact) this.onImpact = options.onImpact;
      if (options.onFootfall) this.onFootfall = options.onFootfall;
      return;
    }
    this.clipName = name;
    this.clip = next;
    this.totalMs = Math.max(1, clipDuration(next));
    this.looping = options.loop ?? next.loop;
    this.speed = options.speed ?? 1;
    this.elapsedMs = 0;
    this.frameIndex = 0;
    this.finished = false;
    this.impactFired = false;
    this.onComplete = options.onComplete ?? null;
    this.onImpact = options.onImpact ?? null;
    this.onFootfall = options.onFootfall ?? null;
  }

  /**
   * Drive a distance-driven clip. 'phase' is the walk cycle position in turns —
   * it may exceed 1 and is wrapped here, so callers can simply accumulate
   * 'distanceTravelled / strideLength'. Pass 'null' to release the lock.
   */
  setLocomotion(phase: number | null): void {
    if (phase === null) {
      this.cyclePhase = null;
      return;
    }
    const wrapped = phase - Math.floor(phase);
    const previous = this.cyclePhase;
    this.cyclePhase = wrapped;

    if (previous !== null && this.onFootfall) {
      const footfalls = this.clip.footfalls;
      if (footfalls) {
        // Handle wrap-around: treat the segment as [previous, previous + delta].
        let delta = wrapped - previous;
        if (delta < -0.5) delta += 1;
        else if (delta > 0.5) delta -= 1;
        if (delta > 0) {
          for (let i = 0; i < footfalls.length; i++) {
            const f = footfalls[i];
            if (f === undefined) continue;
            if (crossed(previous, delta, f)) this.onFootfall(i);
          }
        }
      }
    }
  }

  update(deltaSeconds: number): void {
    const clip = this.clip;
    if (clip.distanceDriven) {
      // Phase is supplied by setLocomotion; advance only the drawn frame index.
      this.frameIndex = frameForPhase(clip, this.cyclePhase ?? 0);
      return;
    }
    if (this.finished) return;

    this.elapsedMs += deltaSeconds * 1000 * this.speed;

    const impactAt = clip.impactAt;
    if (impactAt !== undefined && !this.impactFired && this.elapsedMs >= impactAt * this.totalMs) {
      this.impactFired = true;
      this.onImpact?.();
    }

    if (this.elapsedMs >= this.totalMs) {
      if (this.looping) {
        this.elapsedMs %= this.totalMs;
        this.impactFired = false;
      } else {
        this.elapsedMs = this.totalMs;
        this.finished = true;
        const done = this.onComplete;
        this.onComplete = null;
        done?.();
      }
    }

    // Locate the drawn frame for the current time.
    let acc = 0;
    let index = clip.durations.length - 1;
    for (let i = 0; i < clip.durations.length; i++) {
      acc += clip.durations[i] ?? 0;
      if (this.elapsedMs < acc) {
        index = i;
        break;
      }
    }
    this.frameIndex = index;
  }

  /** The drawn frame for a view, honouring the current time / cycle phase. */
  frame(view: ViewKey): AnimFrame {
    const frames = this.clip.views[view];
    if (!frames || frames.length === 0) return EMPTY_FRAME;
    const index = Math.min(this.frameIndex, frames.length - 1);
    return frames[index] ?? EMPTY_FRAME;
  }

  /**
   * The procedural pose for the current moment. Returns a shared, mutated object
   * — copy it if you need to keep it. Identity when the clip has real frames.
   */
  pose(): ProceduralPose {
    const out = this.poseOut;
    out.offsetX = 0;
    out.offsetY = 0;
    out.rotation = 0;
    out.scaleX = 1;
    out.scaleY = 1;
    out.brightness = 1;
    const clip = this.clip;
    if (clip.procedural === false || !clip.pose) return out;
    clip.pose(this.normalizedTime, out);
    return out;
  }
}

/** Did the interval '[from, from + delta)' (wrapping at 1) cross 'target'? */
function crossed(from: number, delta: number, target: number): boolean {
  const end = from + delta;
  if (end < 1) return target > from && target <= end;
  return target > from || target <= end - 1;
}

function frameForPhase(clip: AnimClip, phase: number): number {
  const count = clip.durations.length;
  if (count <= 1) return 0;
  let total = 0;
  for (const d of clip.durations) total += d;
  if (total <= 0) return 0;
  const target = phase * total;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += clip.durations[i] ?? 0;
    if (target < acc) return i;
  }
  return count - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path traversal
// ─────────────────────────────────────────────────────────────────────────────

export interface PathWalkOptions {
  /** Ground speed in tiles per second. FFT reads at roughly 3. */
  tilesPerSecond?: number;
  /**
   * Distance in tiles per full walk cycle (two footfalls). Setting this correctly
   * is what stops the feet sliding: the cycle is advanced by distance, never by
   * time, so slowing the unit down slows the legs by exactly the same factor.
   */
  tilesPerStride?: number;
  /** Half-tile height difference above which the step becomes an arced hop. */
  hopThreshold?: number;
  /** Peak of the hop arc, in half-tile units. */
  hopHeight?: number;
  /** Seconds spent turning in place before the first step. */
  turnTime?: number;
}

export interface PathWalkSample {
  /** Fractional grid position. 'z' is elevation in half-tile units. */
  x: number;
  y: number;
  z: number;
  facing: Facing;
  /** Walk cycle position in turns; accumulates past 1. */
  cycle: number;
  /** True while the unit is off the ground in a hop. */
  airborne: boolean;
  /**
   * Height of the tile the unit's *shadow* belongs on, in half-tile units. During
   * a hop 'z' arcs above this; the contact shadow stays down here.
   */
  groundZ: number;
  /** Progress along the whole path, 0..1. */
  progress: number;
}

/**
 * Walks a unit along a 'move' path.
 *
 * Height is *not* lerped linearly across a step: FFT units step up onto a block
 * and drop off the far edge, so a step with a height change plays as an arc whose
 * apex clears the taller of the two tiles. Small changes get a token lift, big
 * ones a real hop. The cycle phase always tracks horizontal distance, so the
 * footfalls stay on the ground through all of it.
 */
export class PathWalker {
  private readonly path: readonly Vec3[];
  private readonly tilesPerSecond: number;
  private readonly tilesPerStride: number;
  private readonly hopThreshold: number;
  private readonly hopHeight: number;
  private readonly turnTime: number;

  private segment = 0;
  private segmentT = 0;
  private turning: number;
  private distance = 0;
  private totalDistance = 0;
  private travelled = 0;

  private readonly sample: PathWalkSample;

  constructor(path: readonly Vec3[], options: PathWalkOptions = {}) {
    this.path = path;
    this.tilesPerSecond = options.tilesPerSecond ?? 3.2;
    this.tilesPerStride = options.tilesPerStride ?? 1;
    this.hopThreshold = options.hopThreshold ?? 1;
    this.hopHeight = options.hopHeight ?? 0.9;
    this.turnTime = options.turnTime ?? 0.08;
    this.turning = this.turnTime;

    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (!a || !b) continue;
      this.totalDistance += Math.hypot(b.x - a.x, b.y - a.y) || 1;
    }

    const start = path[0] ?? { x: 0, y: 0, z: 0 };
    const next = path[1];
    this.sample = {
      x: start.x,
      y: start.y,
      z: start.z,
      facing: (next && facingFromDelta(next.x - start.x, next.y - start.y)) ?? 'S',
      cycle: 0,
      airborne: false,
      groundZ: start.z,
      progress: 0,
    };
  }

  get done(): boolean {
    return this.segment >= this.path.length - 1;
  }

  get current(): PathWalkSample {
    return this.sample;
  }

  /** Advance. Returns false once the path has been consumed. */
  update(deltaSeconds: number): boolean {
    if (this.done) {
      this.sample.progress = 1;
      this.sample.airborne = false;
      return false;
    }

    // Turn in place before setting off, so a unit never moonwalks out of a tile.
    if (this.turning > 0) {
      this.turning -= deltaSeconds;
      if (this.turning > 0) return true;
      deltaSeconds = -this.turning;
      this.turning = 0;
    }

    let remaining = deltaSeconds * this.tilesPerSecond;

    while (remaining > 0 && !this.done) {
      const a = this.path[this.segment];
      const b = this.path[this.segment + 1];
      if (!a || !b) break;

      const horizontal = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const step = remaining / horizontal;
      this.segmentT += step;

      if (this.segmentT >= 1) {
        remaining = (this.segmentT - 1) * horizontal;
        this.travelled += horizontal * (1 - (this.segmentT - step));
        this.segment++;
        this.segmentT = 0;
        if (this.done) {
          const end = this.path[this.path.length - 1] ?? b;
          this.sample.x = end.x;
          this.sample.y = end.y;
          this.sample.z = end.z;
          this.sample.groundZ = end.z;
          this.sample.airborne = false;
          this.sample.progress = 1;
          return false;
        }
        continue;
      }

      this.travelled += remaining;
      remaining = 0;
    }

    const a = this.path[this.segment];
    const b = this.path[this.segment + 1];
    if (!a || !b) return !this.done;

    const t = this.segmentT;
    this.sample.x = a.x + (b.x - a.x) * t;
    this.sample.y = a.y + (b.y - a.y) * t;

    const drop = b.z - a.z;
    const magnitude = Math.abs(drop);
    if (magnitude >= this.hopThreshold) {
      // Real hop: clear the taller tile, land flat on the far side.
      // Parabola through (0, a.z) and (1, b.z) whose apex at t = 0.5 clears the
      // taller of the two tiles by 'hopHeight'.
      const apex = Math.max(a.z, b.z) + this.hopHeight;
      const rise = 4 * apex - 2 * (a.z + b.z);
      this.sample.z = a.z + drop * t + rise * t * (1 - t);
      this.sample.airborne = t > 0.08 && t < 0.94;
      this.sample.groundZ = t < 0.5 ? a.z : b.z;
    } else {
      // Step up / down: ease the height so the feet meet the new surface.
      const eased = t * t * (3 - 2 * t);
      this.sample.z = a.z + drop * eased + magnitude * hump(t) * 0.12;
      this.sample.airborne = false;
      this.sample.groundZ = t < 0.5 ? a.z : b.z;
    }

    const facing = facingFromDelta(b.x - a.x, b.y - a.y);
    if (facing) this.sample.facing = facing;

    this.sample.cycle = this.travelled / Math.max(1e-4, this.tilesPerStride);
    this.sample.progress = this.totalDistance > 0 ? this.travelled / this.totalDistance : 1;
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoded SHP/SEQ animation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 'ShpPart' is declared above, next to 'AnimFrame'. Its coordinates are in
 * **original 256x488 SPR pixels**: the HD rip is an exact 2x upscale of that
 * canvas (docs/ASSETS.md §1.1), so a renderer sampling the HD texture
 * multiplies every field by 'DecodedAnimations.hdScale'.
 *
 * '(sx, sy)' is the source rect's top-left on the sheet; '(dx, dy)' is where
 * that rect's top-left lands relative to the unit's origin — the point the game
 * places on the tile surface. Both are negative for a standing human, i.e. the
 * origin sits low and central inside the figure.
 */

/** One SHP frame: the parts that compose it, drawn in order. */
export interface ShpFrame {
  readonly index: number;
  readonly parts: readonly ShpPart[];
}

/** One SEQ animation reduced to what a player needs. */
export interface SeqClip {
  readonly index: number;
  /** SHP frame ids, in play order. */
  readonly frames: readonly number[];
  /** Milliseconds per frame, parallel to 'frames'. */
  readonly durations: readonly number[];
  /** Accumulated unit displacement at each frame, in original SPR pixels. */
  readonly offsets: readonly (readonly [number, number])[];
  readonly loop: boolean;
  /** Frame at which the blow connects, or null if the clip never strikes. */
  readonly impactAt: number | null;
}

/** The shape of 'public/assets/animations.json'. */
export interface DecodedAnimations {
  version: number;
  hdScale: number;
  tile: number;
  sizeTable: Record<string, [number, number]>;
  spriteTypes: Record<string, { shp: string; seq: string }>;
  shp: Record<string, { atk: number; frameCount: number; frames: { i: number; p: number[] }[] }>;
  seq: Record<
    string,
    { animCount: number; anims: { i: number; f: number[]; d: number[]; o: number[]; loop: boolean; impactAt: number | null }[] }
  >;
}

/** Numbers per part in the packed 'animations.json' encoding. */
const PART_STRIDE = 8;

/**
 * A decoded SHP + SEQ pair, ready to play.
 *
 * Constructed from 'animations.json' rather than owning any fetching, so it
 * stays unit-testable and this file keeps its no-three.js, no-DOM property.
 */
export class ShpLibrary {
  private readonly framesById = new Map<number, ShpFrame>();
  private readonly clipsByIndex = new Map<number, SeqClip>();

  private constructor(
    readonly shpKey: string,
    readonly seqKey: string,
    readonly hdScale: number,
    frames: ShpFrame[],
    clips: SeqClip[],
  ) {
    for (const f of frames) this.framesById.set(f.index, f);
    for (const c of clips) this.clipsByIndex.set(c.index, c);
  }

  /**
   * Build a library for one sprite type. Returns null when the requested type
   * is absent, so a caller can fall back to pose cells without special-casing.
   */
  static fromJson(data: DecodedAnimations, shpKey: string, seqKey: string): ShpLibrary | null {
    const shp = data.shp?.[shpKey];
    const seq = data.seq?.[seqKey];
    if (!shp || !seq) return null;

    const frames: ShpFrame[] = shp.frames.map((f) => {
      const parts: ShpPart[] = [];
      for (let o = 0; o + PART_STRIDE <= f.p.length; o += PART_STRIDE) {
        const flags = f.p[o + 6] ?? 0;
        parts.push({
          dx: f.p[o] ?? 0,
          dy: f.p[o + 1] ?? 0,
          sx: f.p[o + 2] ?? 0,
          sy: f.p[o + 3] ?? 0,
          w: f.p[o + 4] ?? 0,
          h: f.p[o + 5] ?? 0,
          flipX: (flags & 1) === 1,
          flipY: (flags & 2) === 2,
        });
      }
      return { index: f.i, parts };
    });

    const clips: SeqClip[] = seq.anims.map((a) => {
      const offsets: [number, number][] = [];
      for (let i = 0; i < a.f.length; i++) offsets.push([a.o[i * 2] ?? 0, a.o[i * 2 + 1] ?? 0]);
      return { index: a.i, frames: a.f, durations: a.d, offsets, loop: a.loop, impactAt: a.impactAt };
    });

    return new ShpLibrary(shpKey, seqKey, data.hdScale ?? 2, frames, clips);
  }

  get frameCount(): number {
    return this.framesById.size;
  }

  get clipCount(): number {
    return this.clipsByIndex.size;
  }

  frame(id: number): ShpFrame | null {
    return this.framesById.get(id) ?? null;
  }

  clip(index: number): SeqClip | null {
    return this.clipsByIndex.get(index) ?? null;
  }

  /**
   * Expand a SEQ animation into drawable frames. Frames the SHP does not define
   * are dropped rather than substituted — a missing frame is a data problem and
   * silently drawing the wrong body is worse than dropping one tick.
   */
  assemble(index: number): AnimFrame[] {
    const clip = this.clipsByIndex.get(index);
    if (!clip) return [];
    const out: AnimFrame[] = [];
    for (let i = 0; i < clip.frames.length; i++) {
      const id = clip.frames[i];
      const frame = id === undefined ? undefined : this.framesById.get(id);
      if (!frame) continue;
      const [ox, oy] = clip.offsets[i] ?? [0, 0];
      out.push({ cell: 0, parts: frame.parts, offsetX: ox, offsetY: oy });
    }
    return out;
  }

  /** True when every frame a clip references exists in the SHP. */
  isComplete(index: number): boolean {
    const clip = this.clipsByIndex.get(index);
    if (!clip || clip.frames.length === 0) return false;
    return clip.frames.every((f) => this.framesById.has(f));
  }
}

/**
 * SEQ animation index for each 'AnimName', for the human sprite types.
 *
 * **This mapping is inferred, not documented.** FFHacktics documents the SEQ
 * container and instruction set but the wiki's "Unit Animation Index" page —
 * which would name each slot — is not reachable and is not archived. What is
 * below was read off the decoded data itself:
 *
 * * 6 loops frames 10,9,10,11,12,13,12 with waits 6,8,10,8 — a symmetric
 *   seven-frame gait. 8 is the same frame list at waits 2,4,6,4 (faster) and 10
 *   at 10,12,14,12 (slower), which is what a walk / run / slow-walk triple looks
 *   like. Verified visually: 'tools/preview-anim.mjs --anim 6,7,8,9,10,11'
 *   renders a knight taking steps.
 * * 12 holds a single frame and alternates MoveUp1 / MoveDown1 — a one-pixel
 *   breathing bob, i.e. idle.
 * * 42 and 43 step monotonically through frames 1-8, which are the eight
 *   standing rotations, so they are turn-in-place rather than a named clip.
 *
 * Everything else is left null: the clips exist and are playable by index, but
 * naming them would be a guess, and a wrong 'attack' is worse than a procedural
 * one. Consumers get the fallback curve for any name that maps to null.
 */
export const SEQ_ANIM_INDEX: Readonly<Record<AnimName, number | null>> = {
  idle: 12,
  walk: 6,
  run: 8,
  attack: null,
  cast: null,
  charge: null,
  item: null,
  hurt: null,
  ko: null,
  crystal: null,
  victory: null,
  jump: null,
  land: null,
  defend: null,
  sing: null,
  dance: null,
  aim: null,
  throw: null,
  punch: null,
  kick: null,
};

/**
 * Overlay decoded clips onto a fallback set.
 *
 * Any 'AnimName' with a mapped, complete SEQ animation gets authentic drawn
 * frames and 'procedural: false'; everything else keeps the pose-cell clip and
 * its tuned pose curve. This is deliberately a merge rather than a replacement
 * so a sheet with partial data degrades one clip at a time instead of falling
 * off a cliff.
 *
 * The same assembled frames are used for every view: an FFT sheet draws each
 * facing as its own SHP frame, and which SEQ slot holds which facing is exactly
 * the thing 'SEQ_ANIM_INDEX' does not yet resolve. 'resolveView' therefore still
 * does the mirroring, as it does for the pose-cell path.
 */
export function decodedAnimationSet(
  library: ShpLibrary,
  fallback: AnimSet,
  mapping: Readonly<Record<AnimName, number | null>> = SEQ_ANIM_INDEX,
): AnimSet {
  const out: Record<string, AnimClip> = { ...fallback };
  for (const [name, index] of Object.entries(mapping) as [AnimName, number | null][]) {
    if (index === null || !library.isComplete(index)) continue;
    const clip = library.clip(index);
    const frames = library.assemble(index);
    if (!clip || frames.length === 0) continue;
    const base = fallback[name];
    out[name] = {
      ...base,
      views: {
        front: frames,
        frontQuarter: frames,
        side: frames,
        backQuarter: frames,
        back: frames,
      },
      durations: clip.durations,
      loop: clip.loop,
      impactAt:
        clip.impactAt !== null && frames.length > 0
          ? Math.min(1, clip.impactAt / frames.length)
          : base.impactAt,
      procedural: false,
      pose: undefined,
    };
  }
  return out as AnimSet;
}
