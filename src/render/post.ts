/**
 * EverTactics post-processing stack.
 *
 * Hand-rolled on purpose. `three/examples/jsm/postprocessing` is unversioned, its import
 * paths move between releases, and EffectComposer's ping-pong model forces a full-res RGBA
 * round trip per effect. This stack owns its own targets, runs AO/bloom/DoF at half
 * resolution, and collapses tonemap + grade + vignette + grain + chromatic aberration into
 * a single dependent pass.
 *
 * Order (this is the order the brief specifies, and it is the physically motivated one):
 *   1. scene -> HDR target with a depth texture
 *   2. sprite mask (one extra draw of the sprite layer only)
 *   3. horizon-based AO, blurred, multiplied into the HDR colour
 *   4. bloom: threshold -> 6-mip downsample -> tent upsample
 *   5. depth of field / tilt-shift: half-res CoC -> spiral bokeh gather -> tent fill
 *   6. composite: DoF blend, bloom add, shockwave distortion, vignette, exposure,
 *      ACES tonemap, sRGB encode, 3D LUT grade, film grain, chromatic aberration
 *   7. FXAA with the sprite mask excluded, straight to the canvas
 *
 * Restraint is enforced by the defaults, not by hope: bloom threshold sits above diffuse
 * white, AO falls off inside one tile, chromatic aberration is zero for the middle 70%
 * of the frame, and grain is a fraction of a code value.
 *
 * Usage from stage.ts:
 *
 *   const post = new PostStack(renderer, { spriteLayer: SPRITE_LAYER });
 *   post.setSize(width, height, pixelRatio);
 *   post.setGrade('dusk-plains');
 *   // per frame, instead of renderer.render(scene, camera):
 *   post.render(scene, camera, dt);
 */

import {
  ClampToEdgeWrapping,
  Color,
  Data3DTexture,
  DataTexture,
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type IUniform,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';

import { AA_FRAG } from './materials/post/aa';
import { AO_APPLY_FRAG, AO_BLUR_FRAG, AO_FRAG } from './materials/post/ao';
import { BLOOM_DOWN_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_UP_FRAG } from './materials/post/bloom';
import { COMPOSITE_FRAG, MAX_SHOCKWAVES } from './materials/post/composite';
import { DOF_COC_FRAG, DOF_FILL_FRAG, DOF_GATHER_FRAG } from './materials/post/dof';
import { FULLSCREEN_VERT } from './materials/post/glsl';
import { GRADE_PRESETS, LUT_SIZE, bakeGradeLUT, type GradeParams } from './materials/post/lut';

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

export type PostQuality = 'low' | 'medium' | 'high' | 'ultra';

/** Names the critic loop can toggle individually for an A/B. */
export type EffectName = 'ao' | 'bloom' | 'dof' | 'grade' | 'vignette' | 'grain' | 'chroma' | 'aa';

export type DebugView = 'off' | 'ao' | 'bloom' | 'coc' | 'dof' | 'sprite-mask' | 'no-grade';

export interface AoSettings {
  enabled: boolean;
  /** Master dial the A/B harness moves. Scales `strength`. */
  intensity: number;
  /** World-space radius. Sized so occlusion dies out within about one tile. */
  radius: number;
  /** Tangent-plane bias, in sine units. Removes self-occlusion banding on flat ground. */
  bias: number;
  thickness: number;
  /** Contrast of the raw occlusion term before it is applied. */
  power: number;
  strength: number;
  /** How aggressively AO backs off on bright pixels. 0 = none. */
  highlightGuard: number;
  /** Fraction of AO that still lands on sprites, for contact grounding. */
  spriteAO: number;
  /** Occlusion is tinted toward this colour rather than neutral grey. */
  tint: [number, number, number];
}

export interface BloomSettings {
  enabled: boolean;
  /** Additive strength. Anything above ~0.1 starts looking like a mobile game. */
  intensity: number;
  /** In linear HDR. 1.0 is diffuse white under the key light. */
  threshold: number;
  softKnee: number;
  /** Tent-filter spread on upsample. Bigger = wider, softer halo. */
  radius: number;
  /** Firefly clamp applied at prefilter. */
  clamp: number;
  tint: [number, number, number];
}

export interface DofSettings {
  enabled: boolean;
  /** Master dial: scales the maximum blur radius. */
  intensity: number;
  /** 0 = pure depth-of-field, 1 = pure screen-space tilt-shift band. */
  tiltMix: number;
  /**
   * Read the focal plane off the depth buffer at {@link DofSettings.tiltCenter} instead of
   * trusting {@link DofSettings.focusDistance}.
   *
   * On by default, and it is what makes the depth term usable at all: the rig is
   * orthographic and sits `RIG_DISTANCE` (160 world units) from its focus point, so no
   * authored constant here can be right. See `focalDistance()` in `materials/post/glsl.ts`.
   */
  focusAuto: boolean;
  /** View-space distance of the focal plane. Fallback when `focusAuto` finds background. */
  focusDistance: number;
  /** Distance either side of the focal plane that stays sharp. */
  focusRange: number;
  /** Scales how fast CoC grows outside the focus range. */
  cocScale: number;
  /** Centre of the tilt band, in UV. */
  tiltCenter: [number, number];
  /** Band angle in degrees. 0 = horizontal band. */
  tiltAngle: number;
  /** Half-height of the fully sharp band, in UV. */
  tiltBand: number;
  /** Falloff distance past the band, in UV. */
  tiltFalloff: number;
  /**
   * Weight of the elliptical corner term, 0..1. A pure horizontal band leaves the frame
   * corners razor sharp; both reference frames soften them. See COC_CHUNK.
   */
  tiltRadial: number;
  /** Normalised radius (1.0 = frame corner) at which the corner term starts. */
  tiltRadialStart: number;
  /**
   * Maximum blur radius, in pixels **at 1080p**. Scaled by the actual frame height at
   * render time so a 4K screenshot is blurred by the same visible fraction of the frame,
   * not by half as much.
   */
  maxCoCPixels: number;
  /** Superlinear boost applied to bright samples so highlights form discs. */
  bokehBoost: number;
  /** How strongly the near field bleeds over sharp background. */
  nearStrength: number;
  nearSpread: number;
}

/**
 * DoF values for the current frame: the authored settings after the reference floor and the
 * resolution rescale. Mutated in place each frame — the render loop must not allocate.
 */
type ResolvedDof = Omit<DofSettings, 'intensity' | 'maxCoCPixels'> & {
  /** Maximum blur radius in pixels of the CURRENT framebuffer. */
  cocPixelsThisFrame: number;
};

export interface GradeSettings {
  enabled: boolean;
  /** Blend between ungraded and graded. */
  amount: number;
  name: string;
}

export interface VignetteSettings {
  enabled: boolean;
  /** Fraction of the light removed where the falloff is complete. 1 = down to `color`. */
  amount: number;
  /** Where darkening starts, as a fraction of the way from centre to the frame CORNER. */
  radius: number;
  /** Width of the transition, in the same normalised units. */
  softness: number;
  /**
   * Weight of the extra rectangular edge darkening, 0..1. Both references carry a dark band
   * along the full width of the top and bottom edges, which a radial falloff cannot draw.
   */
  edge: number;
  /** The colour the darkened region multiplies toward. Never neutral. */
  color: [number, number, number];
}

export interface GrainSettings {
  enabled: boolean;
  amount: number;
  /** Grain cell size in device pixels. >1 keeps grain visible at high DPR. */
  size: number;
  /** 0 = uniform, 1 = shadows only. */
  shadowBias: number;
  /** Frozen grain (no time animation) — used by the screenshot harness. */
  animate: boolean;
}

export interface ChromaSettings {
  enabled: boolean;
  amount: number;
  /** Exponent on normalised radius. Higher = confined harder to the corners. */
  edge: number;
}

/**
 * How hard the sprite layer is pulled into the scene's tonal range before grading.
 *
 * See the block comment in `materials/post/composite.ts`. This is the post half of the
 * sprite-integration contract: `materials/sprite.ts` owns making units agree with the light
 * DIRECTION, this owns making them agree with the picture's value and chroma range so the
 * LUT lands on the whole frame from one starting point.
 */
export interface SpriteGradeSettings {
  enabled: boolean;
  /** Blend of the pull, 0..1. 0 leaves sprites exactly as the material drew them. */
  amount: number;
  /**
   * Fraction of sprite chroma removed. The atlas is authored far more saturated than a
   * graded HD-2D board; this is what stops the primaries popping off the picture.
   */
  desaturate: number;
  /** Linear multiplier applied to sprite pixels. Sub-1 seats them in the board's values. */
  tint: [number, number, number];
}

export type SpritePolicy = 'exclude' | 'silhouette' | 'none';

export interface AaSettings {
  enabled: boolean;
  subpix: number;
  threshold: number;
  thresholdMin: number;
  spritePolicy: SpritePolicy;
}

export interface PostSettings {
  ao: AoSettings;
  bloom: BloomSettings;
  dof: DofSettings;
  grade: GradeSettings;
  vignette: VignetteSettings;
  grain: GrainSettings;
  chroma: ChromaSettings;
  spriteGrade: SpriteGradeSettings;
  aa: AaSettings;
  /** Linear exposure multiplier applied just before the tonemapper. */
  exposure: number;
}

export interface PostStackOptions {
  quality?: PostQuality;
  grade?: string;
  /** three `Layers` channel that unit billboards live on. Enables sprite-aware AA and AO. */
  spriteLayer?: number;
  /** World units per tile — AO radius and DoF defaults scale off this. */
  tileSize?: number;
  settings?: DeepPartial<PostSettings>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

interface QualityProfile {
  aoScale: number;
  aoSlices: number;
  aoSteps: number;
  bloomMips: number;
  dofScale: number;
  dofTaps: number;
  aaSearchSteps: number;
  aoBlur: boolean;
  dofFill: boolean;
}

const QUALITY: Record<PostQuality, QualityProfile> = {
  low: { aoScale: 0.5, aoSlices: 2, aoSteps: 4, bloomMips: 4, dofScale: 0.5, dofTaps: 16, aaSearchSteps: 4, aoBlur: true, dofFill: false },
  medium: { aoScale: 0.5, aoSlices: 3, aoSteps: 5, bloomMips: 5, dofScale: 0.5, dofTaps: 24, aaSearchSteps: 6, aoBlur: true, dofFill: true },
  high: { aoScale: 0.5, aoSlices: 4, aoSteps: 6, bloomMips: 6, dofScale: 0.5, dofTaps: 32, aaSearchSteps: 8, aoBlur: true, dofFill: true },
  ultra: { aoScale: 0.75, aoSlices: 6, aoSteps: 8, bloomMips: 6, dofScale: 0.5, dofTaps: 48, aaSearchSteps: 12, aoBlur: true, dofFill: true },
};

/**
 * Measured bounds, from `refs/curated/triangle/official_005_steam.jpg` and
 * `official_019_se_screenshot.jpg`.
 *
 * These are not taste knobs, and — round 2 — they are not all floors either. Two of them
 * are ceilings, because "more" was the wrong instinct on the shape of the defocus.
 *
 * VISUAL_TARGET.md section 3 was rewritten after round 1 called out the earlier advice.
 * What the references actually blur is SCENERY: foreground props, background architecture,
 * distant terrain. The tiles a player has to count and the units standing on them are sharp
 * in both games. So the guarantees are:
 *
 *   - a real blur exists where the frame IS soft (`dofCoCPixels`, a floor — this is what
 *     stops "weak or absent depth of field", the listed fail condition);
 *   - the sharp band is wide enough to contain the whole playable board
 *     (`dofTiltBandMin`, a floor on SHARPNESS — a scenario may ask for more focus, never
 *     less);
 *   - the elliptical corner term never grows far enough to eat gameplay tiles at the left
 *     and right of the frame (`dofTiltRadialMax`, a ceiling).
 *
 * Vignette obeys the same logic — it frames, it does not darken the play space. Round 2
 * measured our own frame at mean luma 38/255 against the references' 66-80, with a 0.72
 * vignette on top of an already-dark grade. That is the vignette compounding, not framing.
 *
 * Set `respectReferenceFloor = false` on the stack to author outside these deliberately.
 */
export const REFERENCE_FLOOR = {
  /**
   * Blur radius at the softest part of the frame, in pixels at 1080p — a floor: wherever the
   * frame IS soft it must be genuinely soft. Raised from 20 once the board started filling
   * the frame: the only scenery left in shot is the near wall and the two outer corners, so
   * what little is defocused has to commit or the miniature read never fires.
   */
  dofCoCPixels: 26,
  /**
   * Minimum half-height of the fully sharp band, in UV — a floor on SHARPNESS.
   *
   * Round 1 applied this as a CAP at 0.28 with the band centred on v = 0.52, which defocused
   * everything above v = 0.80 and below v = 0.24: the top three tile rows and the bottom two.
   * That is precisely the "blurring pillars and gameplay-relevant tiles" defect section 3
   * names, so the clamp direction is flipped and the value is measured, not guessed.
   *
   * Measured on `shots/r2-l.png` at the framing `frameField` now produces: playable tiles
   * run from v = 0.19 to v = 0.90. Centre 0.55 (see `defaultPostSettings`) with a 0.34
   * half-band covers v ∈ [0.21, 0.89] — the whole board bar its last row of skirt — and
   * leaves the top ~10% and the bottom ~20% to fall off, which is the split VISUAL_TARGET.md
   * measures on the reference frame.
   */
  dofTiltBandMin: 0.34,
  /**
   * Minimum falloff distance past the band. Long enough that the transition is a ramp
   * rather than a visible seam across the board; the references have no hard focus edge.
   */
  dofTiltFalloffMin: 0.3,
  /**
   * MAXIMUM corner-term weight — the term that softens the frame corners, which a purely
   * horizontal band leaves razor sharp.
   *
   * Capped, not floored. At round 1's 0.7 starting from a normalised radius of 0.42 it
   * reached inward far enough to blur the left and right cloister walls, which are playable
   * geometry. The answer was not to weaken it but to move it outward: `tiltRadialStart` now
   * begins at 0.70 of the way to the corner, so the term is confined to the corners and can
   * afford to be strong there.
   */
  dofTiltRadialMax: 0.44,
  /** Fraction of light removed at the frame corner. */
  vignetteAmount: 0.34,
  /**
   * MINIMUM radius at which darkening may start, as a fraction of the way to the corner.
   * Below this the falloff is inside the play space rather than around it.
   */
  vignetteRadiusMin: 0.46,
  /**
   * Grain amplitude as a fraction of full scale. Measured against the reference frames at
   * 1:1 — 0.03 was still invisible in a screenshot, which fails the "clearly visible" note
   * in VISUAL_TARGET.md section 5.
   */
  grainAmount: 0.05,
} as const;

export function defaultPostSettings(tileSize = 1): PostSettings {
  return {
    exposure: 1.0,
    ao: {
      enabled: true,
      intensity: 1.0,
      radius: 1.15 * tileSize,
      bias: 0.08,
      thickness: 0.55,
      power: 2.1,
      strength: 0.85,
      highlightGuard: 0.55,
      spriteAO: 0.28,
      tint: [0.42, 0.47, 0.62],
    },
    bloom: {
      enabled: true,
      intensity: 0.055,
      threshold: 1.15,
      softKnee: 0.55,
      // Wide and soft. The references bloom torches and spell light into a halo several
      // times the size of the source; a tight radius at the same intensity reads as a
      // sharpened highlight instead of glow, which is the mobile-game tell.
      radius: 1.35,
      clamp: 12.0,
      tint: [1.0, 0.98, 0.94],
    },
    dof: {
      enabled: true,
      intensity: 1.0,
      // ROUND 3 FIX — the loudest DoF note the critics filed, three times over: "the blur
      // band cuts horizontally across the top and bottom of frame and blurs wall blocks that
      // sit at the same camera depth as sharp ones nearby — a fake tilt-shift".
      //
      // That was literally true: `tiltMix` was 1.0, so the CoC was a screen-space gradient
      // and nothing in it consulted the depth buffer. Two thirds of the CoC now comes from
      // real view-space distance to a focal plane measured at the composition centre
      // (`focusAuto`), which on a tilted-ortho rig produces the tilt-shift shape *for free*
      // and correctly — the far corner of the board at the top of frame and the near corner
      // at the bottom defocus because they ARE far and near, while the left and right walls
      // at the same depth as the subject stay sharp. The remaining third of screen-space
      // band is kept because it is what softens the frame corners and the sky, which have no
      // useful depth.
      tiltMix: 0.34,
      focusAuto: true,
      focusDistance: 160,
      // World units either side of the focal plane that stay sharp. Sized to the playable
      // board, not to taste: `battle-open` spans ~14 tiles, which at 32° pitch is ~17 world
      // units of view-space depth corner to corner, so ±9 keeps every countable tile inside
      // the sharp zone and puts the falloff on the skirt, the backdrop and the near rim.
      focusRange: 9 * tileSize,
      // Steeper than the old 0.55: past the sharp zone the blur has to actually arrive
      // within the couple of units of depth the scenery occupies, or the far city never
      // reaches the reference's degree of softness.
      cocScale: 1.15,
      // Slightly above centre: the reference frames put the sharp band on the action and
      // leave the negative space above it soft. Matches the camera's composition offset,
      // which lifts the subject the same way.
      tiltCenter: [0.5, 0.55],
      tiltAngle: 0,
      tiltBand: REFERENCE_FLOOR.dofTiltBandMin,
      tiltFalloff: REFERENCE_FLOOR.dofTiltFalloffMin,
      tiltRadial: REFERENCE_FLOOR.dofTiltRadialMax,
      // Pushed out from 0.42: the corner term now begins two thirds of the way to the
      // corner, so it is a corner softener rather than a second vignette.
      tiltRadialStart: 0.7,
      maxCoCPixels: REFERENCE_FLOOR.dofCoCPixels,
      bokehBoost: 1.6,
      nearStrength: 0.9,
      nearSpread: 0.4,
    },
    grade: { enabled: true, amount: 1.0, name: 'dusk-plains' },
    vignette: {
      enabled: true,
      amount: REFERENCE_FLOOR.vignetteAmount,
      radius: REFERENCE_FLOOR.vignetteRadiusMin,
      softness: 0.62,
      // Halved. The rectangular edge band is the letterbox darkening the references carry;
      // at 0.55 on top of a 0.72 radial it was the dominant tone in the outer third.
      edge: 0.3,
      color: [0.05, 0.06, 0.11],
    },
    grain: { enabled: true, amount: REFERENCE_FLOOR.grainAmount, size: 1.0, shadowBias: 0.4, animate: true },
    // Halved from 0.35. That value was authored when the frame corners were empty
    // background, where fringing costs nothing. Now the board runs off all four edges and
    // the corners carry pixel art, where 0.35 puts a visible red/cyan halo on the sprite
    // outlines — which is worse than no CA at all.
    chroma: { enabled: true, amount: 0.16, edge: 3.8 },
    // Measured against the same reference pair: in official_019 the crew sprites sit a
    // clear step below the lit deck in value and carry the scene's cool cast; ours were
    // rendering at full atlas albedo over a board a good 40% darker.
    spriteGrade: { enabled: true, amount: 1.0, desaturate: 0.24, tint: [0.82, 0.85, 0.95] },
    aa: { enabled: true, subpix: 0.4, threshold: 0.125, thresholdMin: 0.0312, spritePolicy: 'exclude' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fullscreen pass plumbing
// ─────────────────────────────────────────────────────────────────────────────

const QUAD_GEOMETRY = new PlaneGeometry(2, 2);

class FullScreenPass {
  readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly scene = new Scene();
  private static readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(fragmentShader: string, uniforms: Record<string, IUniform>, defines: Record<string, string | number> = {}) {
    this.material = new ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      defines: { ...defines },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.mesh = new Mesh(QUAD_GEOMETRY, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get uniforms(): Record<string, IUniform> {
    return this.material.uniforms;
  }

  setDefine(key: string, value: string | number): void {
    if (this.material.defines[key] === value) return;
    this.material.defines[key] = value;
    this.material.needsUpdate = true;
  }

  render(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, FullScreenPass.camera);
  }

  dispose(): void {
    this.material.dispose();
  }
}

function makeTarget(w: number, h: number, hdr: boolean, filter = LinearFilter): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    format: RGBAFormat,
    type: hdr ? HalfFloatType : UnsignedByteType,
    minFilter: filter,
    magFilter: filter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: NoColorSpace,
  });
  rt.texture.wrapS = ClampToEdgeWrapping;
  rt.texture.wrapT = ClampToEdgeWrapping;
  return rt;
}

interface Shockwave {
  /** World-space origin; projected to UV each frame so it tracks camera motion. */
  origin: Vector3;
  age: number;
  duration: number;
  amplitude: number;
  maxRadius: number;
}

/** Minimal surface `vfx.ts` needs, so it never depends on the whole PostStack. */
export interface PostEffectsHost {
  readonly depthTexture: Texture | null;
  addShockwave(origin: Vector3, opts?: { amplitude?: number; duration?: number; maxRadius?: number }): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// PostStack
// ─────────────────────────────────────────────────────────────────────────────

export class PostStack implements PostEffectsHost {
  readonly settings: PostSettings;

  private readonly renderer: WebGLRenderer;
  private readonly spriteLayer: number | undefined;

  private quality: PostQuality;
  private profile: QualityProfile;

  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  // Targets
  private sceneRT!: WebGLRenderTarget;
  private hdrRT!: WebGLRenderTarget;
  private maskRT!: WebGLRenderTarget;
  private aoRT!: WebGLRenderTarget;
  private aoTmpRT!: WebGLRenderTarget;
  private dofART!: WebGLRenderTarget;
  private dofBRT!: WebGLRenderTarget;
  private ldrRT!: WebGLRenderTarget;
  private bloomDown: WebGLRenderTarget[] = [];
  private bloomUp: WebGLRenderTarget[] = [];
  private depthTex!: DepthTexture;

  // Passes
  private readonly aoPass: FullScreenPass;
  private readonly aoBlurPass: FullScreenPass;
  private readonly aoApplyPass: FullScreenPass;
  private readonly bloomPrefilterPass: FullScreenPass;
  private readonly bloomDownPass: FullScreenPass;
  private readonly bloomUpPass: FullScreenPass;
  private readonly cocPass: FullScreenPass;
  private readonly gatherPass: FullScreenPass;
  private readonly fillPass: FullScreenPass;
  private readonly compositePass: FullScreenPass;
  private readonly aaPass: FullScreenPass;

  // Grade
  private readonly lutCache = new Map<string, Data3DTexture>();
  private lutA: Data3DTexture;
  private lutB: Data3DTexture;
  private lutMix = 0;
  private lutFadeSpeed = 0;
  private pendingGradeName: string;

  /** Reused by {@link resolveDof} so the per-frame path allocates nothing. */
  private readonly resolvedDof: ResolvedDof = {
    enabled: true,
    tiltMix: 0.34,
    focusAuto: true,
    focusDistance: 160,
    focusRange: 9,
    cocScale: 1.15,
    tiltCenter: [0.5, 0.55],
    tiltAngle: 0,
    tiltBand: REFERENCE_FLOOR.dofTiltBandMin,
    tiltFalloff: REFERENCE_FLOOR.dofTiltFalloffMin,
    tiltRadial: REFERENCE_FLOOR.dofTiltRadialMax,
    tiltRadialStart: 0.7,
    bokehBoost: 1.6,
    nearStrength: 0.9,
    nearSpread: 0.4,
    cocPixelsThisFrame: REFERENCE_FLOOR.dofCoCPixels,
  };

  private readonly waves: Shockwave[] = [];
  private readonly waveUniform: Vector4[] = [];

  private readonly projInv = new Matrix4();
  private readonly tmpVec3 = new Vector3();
  private readonly clearColor = new Color();
  private time = 0;

  /** Set to a value other than 'off' to inspect an individual buffer. */
  debugView: DebugView = 'off';

  /**
   * When true (the default) DoF, vignette and grain are clamped up to {@link REFERENCE_FLOOR}.
   * Turn it off to author deliberately below the measured reference look.
   */
  respectReferenceFloor = true;

  private whiteTexture: Texture;
  private disposed = false;

  constructor(renderer: WebGLRenderer, opts: PostStackOptions = {}) {
    this.renderer = renderer;
    this.spriteLayer = opts.spriteLayer;
    this.quality = opts.quality ?? 'high';
    const profile = QUALITY[this.quality];
    this.profile = profile;

    this.settings = mergeSettings(defaultPostSettings(opts.tileSize ?? 1), opts.settings);
    if (opts.grade) this.settings.grade.name = opts.grade;

    for (let i = 0; i < MAX_SHOCKWAVES; i++) this.waveUniform.push(new Vector4(0, 0, 0, 0));

    this.whiteTexture = makeWhiteTexture();

    const gradeName = this.settings.grade.name;
    this.lutA = this.lut(gradeName);
    this.lutB = this.lutA;
    this.pendingGradeName = gradeName;

    // ── AO ────────────────────────────────────────────────────────────────
    this.aoPass = new FullScreenPass(
      AO_FRAG,
      {
        uDepth: { value: null },
        uProjInv: { value: this.projInv },
        uOrtho: { value: 0 },
        uProjScaleY: { value: 1 },
        uTexel: { value: new Vector2() },
        uRadius: { value: this.settings.ao.radius },
        uIntensity: { value: 1 },
        uBias: { value: this.settings.ao.bias },
        uThickness: { value: this.settings.ao.thickness },
        uMaxPixelRadius: { value: 64 },
        uRotation: { value: 0 },
      },
      { AO_SLICES: profile.aoSlices, AO_STEPS: profile.aoSteps },
    );

    this.aoBlurPass = new FullScreenPass(AO_BLUR_FRAG, {
      uSrc: { value: null },
      uDepth: { value: null },
      uProjInv: { value: this.projInv },
      uOrtho: { value: 0 },
      uProjScaleY: { value: 1 },
      uTexel: { value: new Vector2() },
      uDirection: { value: new Vector2(1, 0) },
      uDepthSigma: { value: 0.4 },
    });

    this.aoApplyPass = new FullScreenPass(AO_APPLY_FRAG, {
      uScene: { value: null },
      uAO: { value: null },
      uSpriteMask: { value: this.whiteTexture },
      uStrength: { value: 0.7 },
      uHighlightGuard: { value: 0.5 },
      uSpriteMaskEnabled: { value: 0 },
      uSpriteAO: { value: 0.3 },
      uTint: { value: new Vector3(0.42, 0.47, 0.62) },
      uDebug: { value: 0 },
    });

    // ── Bloom ─────────────────────────────────────────────────────────────
    this.bloomPrefilterPass = new FullScreenPass(BLOOM_PREFILTER_FRAG, {
      uSrc: { value: null },
      uTexel: { value: new Vector2() },
      uThreshold: { value: this.settings.bloom.threshold },
      uSoftKnee: { value: this.settings.bloom.softKnee },
      uClamp: { value: this.settings.bloom.clamp },
    });

    this.bloomDownPass = new FullScreenPass(BLOOM_DOWN_FRAG, {
      uSrc: { value: null },
      uTexel: { value: new Vector2() },
    });

    this.bloomUpPass = new FullScreenPass(BLOOM_UP_FRAG, {
      uSrc: { value: null },
      uPrev: { value: null },
      uTexel: { value: new Vector2() },
      uRadius: { value: this.settings.bloom.radius },
    });

    // ── DoF ───────────────────────────────────────────────────────────────
    const cocUniforms = (): Record<string, IUniform> => ({
      uFocusDist: { value: this.settings.dof.focusDistance },
      uFocusRange: { value: this.settings.dof.focusRange },
      uCoCScale: { value: this.settings.dof.cocScale },
      uTiltMix: { value: this.settings.dof.tiltMix },
      uTiltCenter: { value: new Vector2(0.5, 0.52) },
      uTiltAxis: { value: new Vector2(0, 1) },
      uTiltBand: { value: this.settings.dof.tiltBand },
      uTiltFalloff: { value: this.settings.dof.tiltFalloff },
      uTiltRadial: { value: this.settings.dof.tiltRadial },
      uTiltRadialStart: { value: this.settings.dof.tiltRadialStart },
      uCoCAspect: { value: new Vector2(1, 1) },
      uFocusAuto: { value: this.settings.dof.focusAuto ? 1 : 0 },
    });

    this.cocPass = new FullScreenPass(DOF_COC_FRAG, {
      uScene: { value: null },
      uDepth: { value: null },
      uProjInv: { value: this.projInv },
      uOrtho: { value: 0 },
      uProjScaleY: { value: 1 },
      uTexel: { value: new Vector2() },
      ...cocUniforms(),
    });

    this.gatherPass = new FullScreenPass(
      DOF_GATHER_FRAG,
      {
        uSrc: { value: null },
        uTexel: { value: new Vector2() },
        uMaxCoCPixels: { value: 9 },
        uBokehBoost: { value: this.settings.dof.bokehBoost },
        uNearSpread: { value: this.settings.dof.nearSpread },
      },
      { DOF_TAPS: profile.dofTaps },
    );

    this.fillPass = new FullScreenPass(DOF_FILL_FRAG, {
      uSrc: { value: null },
      uTexel: { value: new Vector2() },
    });

    // ── Composite ─────────────────────────────────────────────────────────
    this.compositePass = new FullScreenPass(COMPOSITE_FRAG, {
      uScene: { value: null },
      uDoF: { value: null },
      uBloom: { value: null },
      uAO: { value: null },
      uSpriteMask: { value: this.whiteTexture },
      uLutA: { value: this.lutA },
      uLutB: { value: this.lutB },
      uDepth: { value: null },
      uProjInv: { value: this.projInv },
      uOrtho: { value: 0 },
      uProjScaleY: { value: 1 },
      uResolution: { value: new Vector2() },
      uTime: { value: 0 },
      uDoFEnabled: { value: 1 },
      uMaxCoCPixels: { value: 9 },
      uNearStrength: { value: this.settings.dof.nearStrength },
      uBloomIntensity: { value: this.settings.bloom.intensity },
      uBloomTint: { value: new Vector3(1, 1, 1) },
      uExposure: { value: 1 },
      uVignetteAmount: { value: this.settings.vignette.amount },
      uVignetteRadius: { value: this.settings.vignette.radius },
      uVignetteSoftness: { value: this.settings.vignette.softness },
      uVignetteEdge: { value: this.settings.vignette.edge },
      uVignetteColor: { value: new Vector3(0.06, 0.06, 0.1) },
      uGrainAmount: { value: this.settings.grain.amount },
      uGrainSize: { value: this.settings.grain.size },
      uGrainShadowBias: { value: this.settings.grain.shadowBias },
      uChromaAmount: { value: this.settings.chroma.amount },
      uChromaEdge: { value: this.settings.chroma.edge },
      uSpriteGradeAmount: { value: 0 },
      uSpriteDesat: { value: this.settings.spriteGrade.desaturate },
      uSpriteTint: { value: new Vector3(1, 1, 1) },
      uLutMix: { value: 0 },
      uLutAmount: { value: this.settings.grade.amount },
      uLutSize: { value: LUT_SIZE },
      uWaves: { value: this.waveUniform },
      uWaveCount: { value: 0 },
      uAspect: { value: 1 },
      uDebug: { value: 0 },
      ...cocUniforms(),
    });

    // ── AA ────────────────────────────────────────────────────────────────
    this.aaPass = new FullScreenPass(
      AA_FRAG,
      {
        uColor: { value: null },
        uSpriteMask: { value: this.whiteTexture },
        uDepth: { value: null },
        uProjInv: { value: this.projInv },
        uOrtho: { value: 0 },
        uProjScaleY: { value: 1 },
        uTexel: { value: new Vector2() },
        uSubpix: { value: this.settings.aa.subpix },
        uEdgeThreshold: { value: this.settings.aa.threshold },
        uEdgeThresholdMin: { value: this.settings.aa.thresholdMin },
        uSpritePolicy: { value: 0 },
        uSpriteMaskEnabled: { value: 0 },
      },
      { AA_SEARCH_STEPS: profile.aaSearchSteps },
    );

    const size = new Vector2();
    renderer.getSize(size);
    this.setSize(size.x, size.y, renderer.getPixelRatio());
  }

  // ── Sizing ──────────────────────────────────────────────────────────────

  setSize(width: number, height: number, pixelRatio = this.pixelRatio): void {
    const w = Math.max(1, Math.floor(width * pixelRatio));
    const h = Math.max(1, Math.floor(height * pixelRatio));
    if (w === this.width && h === this.height && this.sceneRT) return;

    this.width = w;
    this.height = h;
    this.pixelRatio = pixelRatio;

    this.disposeTargets();

    this.depthTex = new DepthTexture(w, h);
    this.depthTex.format = DepthFormat;
    this.depthTex.type = UnsignedIntType;
    this.depthTex.minFilter = NearestFilter;
    this.depthTex.magFilter = NearestFilter;

    this.sceneRT = new WebGLRenderTarget(w, h, {
      format: RGBAFormat,
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: NoColorSpace,
    });
    this.sceneRT.depthTexture = this.depthTex;
    this.sceneRT.texture.wrapS = ClampToEdgeWrapping;
    this.sceneRT.texture.wrapT = ClampToEdgeWrapping;

    this.hdrRT = makeTarget(w, h, true);
    this.ldrRT = makeTarget(w, h, false);

    const maskScale = 0.5;
    this.maskRT = new WebGLRenderTarget(Math.max(1, Math.round(w * maskScale)), Math.max(1, Math.round(h * maskScale)), {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: NoColorSpace,
    });

    const aoW = Math.max(1, Math.round(w * this.profile.aoScale));
    const aoH = Math.max(1, Math.round(h * this.profile.aoScale));
    this.aoRT = makeTarget(aoW, aoH, false);
    this.aoTmpRT = makeTarget(aoW, aoH, false);

    const dofW = Math.max(1, Math.round(w * this.profile.dofScale));
    const dofH = Math.max(1, Math.round(h * this.profile.dofScale));
    this.dofART = makeTarget(dofW, dofH, true);
    this.dofBRT = makeTarget(dofW, dofH, true);

    this.bloomDown = [];
    this.bloomUp = [];
    let bw = Math.max(1, Math.round(w * 0.5));
    let bh = Math.max(1, Math.round(h * 0.5));
    for (let i = 0; i < this.profile.bloomMips; i++) {
      if (bw < 4 || bh < 4) break;
      this.bloomDown.push(makeTarget(bw, bh, true));
      this.bloomUp.push(makeTarget(bw, bh, true));
      bw = Math.max(1, Math.floor(bw / 2));
      bh = Math.max(1, Math.floor(bh / 2));
    }
  }

  setQuality(quality: PostQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.profile = QUALITY[quality];
    this.aoPass.setDefine('AO_SLICES', this.profile.aoSlices);
    this.aoPass.setDefine('AO_STEPS', this.profile.aoSteps);
    this.gatherPass.setDefine('DOF_TAPS', this.profile.dofTaps);
    this.aaPass.setDefine('AA_SEARCH_STEPS', this.profile.aaSearchSteps);
    // Force target rebuild at the new internal scales.
    const w = this.width;
    const h = this.height;
    this.width = -1;
    this.setSize(w / this.pixelRatio, h / this.pixelRatio, this.pixelRatio);
  }

  getQuality(): PostQuality {
    return this.quality;
  }

  // ── Effect control (what the critic A/B loop drives) ─────────────────────

  setEffectEnabled(name: EffectName, enabled: boolean): void {
    switch (name) {
      case 'ao': this.settings.ao.enabled = enabled; break;
      case 'bloom': this.settings.bloom.enabled = enabled; break;
      case 'dof': this.settings.dof.enabled = enabled; break;
      case 'grade': this.settings.grade.enabled = enabled; break;
      case 'vignette': this.settings.vignette.enabled = enabled; break;
      case 'grain': this.settings.grain.enabled = enabled; break;
      case 'chroma': this.settings.chroma.enabled = enabled; break;
      case 'aa': this.settings.aa.enabled = enabled; break;
    }
  }

  isEffectEnabled(name: EffectName): boolean {
    switch (name) {
      case 'ao': return this.settings.ao.enabled;
      case 'bloom': return this.settings.bloom.enabled;
      case 'dof': return this.settings.dof.enabled;
      case 'grade': return this.settings.grade.enabled;
      case 'vignette': return this.settings.vignette.enabled;
      case 'grain': return this.settings.grain.enabled;
      case 'chroma': return this.settings.chroma.enabled;
      case 'aa': return this.settings.aa.enabled;
    }
  }

  /** Normalised 0..n intensity dial per effect, for A/B sweeps. */
  setEffectIntensity(name: EffectName, value: number): void {
    switch (name) {
      case 'ao': this.settings.ao.intensity = value; break;
      case 'bloom': this.settings.bloom.intensity = value; break;
      case 'dof': this.settings.dof.intensity = value; break;
      case 'grade': this.settings.grade.amount = value; break;
      case 'vignette': this.settings.vignette.amount = value; break;
      case 'grain': this.settings.grain.amount = value; break;
      case 'chroma': this.settings.chroma.amount = value; break;
      case 'aa': this.settings.aa.subpix = value; break;
    }
  }

  getEffectIntensity(name: EffectName): number {
    switch (name) {
      case 'ao': return this.settings.ao.intensity;
      case 'bloom': return this.settings.bloom.intensity;
      case 'dof': return this.settings.dof.intensity;
      case 'grade': return this.settings.grade.amount;
      case 'vignette': return this.settings.vignette.amount;
      case 'grain': return this.settings.grain.amount;
      case 'chroma': return this.settings.chroma.amount;
      case 'aa': return this.settings.aa.subpix;
    }
  }

  /** Turn everything off. Useful as the "before" frame in a critic A/B. */
  setAllEffects(enabled: boolean): void {
    (['ao', 'bloom', 'dof', 'grade', 'vignette', 'grain', 'chroma', 'aa'] as const).forEach((n) =>
      this.setEffectEnabled(n, enabled),
    );
  }

  // ── Grading ─────────────────────────────────────────────────────────────

  private lut(name: string): Data3DTexture {
    const cached = this.lutCache.get(name);
    if (cached) return cached;
    const params: GradeParams = GRADE_PRESETS[name] ?? GRADE_PRESETS['neutral']!;
    const tex = bakeGradeLUT(params);
    this.lutCache.set(name, tex);
    return tex;
  }

  /** Register (or replace) a named grade from raw parameters. */
  defineGrade(name: string, params: GradeParams): void {
    const old = this.lutCache.get(name);
    if (old) old.dispose();
    this.lutCache.set(name, bakeGradeLUT(params));
  }

  /** Switch grade, optionally crossfading. Cheap: two LUT fetches and a mix. */
  setGrade(name: string, fadeSeconds = 0): void {
    if (name === this.pendingGradeName && this.lutMix === 0) return;
    this.settings.grade.name = name;
    this.pendingGradeName = name;
    const next = this.lut(name);
    if (fadeSeconds <= 0) {
      this.lutA = next;
      this.lutB = next;
      this.lutMix = 0;
      this.lutFadeSpeed = 0;
    } else {
      // Freeze whatever we are showing now as A, fade to B.
      this.lutA = this.lutMix >= 0.5 ? this.lutB : this.lutA;
      this.lutB = next;
      this.lutMix = 0;
      this.lutFadeSpeed = 1 / fadeSeconds;
    }
    this.compositePass.uniforms['uLutA']!.value = this.lutA;
    this.compositePass.uniforms['uLutB']!.value = this.lutB;
  }

  getGrade(): string {
    return this.settings.grade.name;
  }

  // ── Impact hooks ────────────────────────────────────────────────────────

  /**
   * Screen-space distortion ring emanating from a world position. Driven by vfx.ts on
   * heavy impacts; the ring is projected fresh every frame so it stays welded to the
   * world point even while the camera rotates.
   */
  addShockwave(origin: Vector3, opts: { amplitude?: number; duration?: number; maxRadius?: number } = {}): void {
    if (this.waves.length >= MAX_SHOCKWAVES) this.waves.shift();
    this.waves.push({
      origin: origin.clone(),
      age: 0,
      duration: opts.duration ?? 0.45,
      amplitude: opts.amplitude ?? 0.012,
      maxRadius: opts.maxRadius ?? 0.42,
    });
  }

  get depthTexture(): Texture | null {
    return this.depthTex ?? null;
  }

  /** The HDR scene colour, before grading. Handy for anything that needs the raw frame. */
  get sceneTexture(): Texture {
    return this.sceneRT.texture;
  }

  // ── Frame ───────────────────────────────────────────────────────────────

  render(scene: Scene, camera: Camera, dt = 1 / 60): void {
    if (this.disposed) return;
    const renderer = this.renderer;
    this.time += dt;

    if (this.lutFadeSpeed > 0) {
      this.lutMix = Math.min(1, this.lutMix + dt * this.lutFadeSpeed);
      if (this.lutMix >= 1) {
        this.lutA = this.lutB;
        this.lutMix = 0;
        this.lutFadeSpeed = 0;
        this.compositePass.uniforms['uLutA']!.value = this.lutA;
      }
    }

    this.projInv.copy(camera.projectionMatrix).invert();
    const ortho = (camera as OrthographicCamera).isOrthographicCamera === true ? 1 : 0;
    const projScaleY = 0.5 * (camera.projectionMatrix.elements[5] ?? 1) * this.height;

    // 1 ── scene into HDR ---------------------------------------------------
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // 2 ── sprite mask ------------------------------------------------------
    // Half-res, sprite layer only, into its own depth buffer. It therefore does NOT depth
    // test against terrain: a sprite fully hidden behind a wall still marks those pixels,
    // which over-excludes them from AA. Sharing the scene's depth texture would let the
    // test work but is a read/write feedback loop on the attachment three just wrote, and
    // depth-writing sprites would fail an equal-depth test anyway. The cost of the
    // approximation is a few terrain pixels behind an occluded unit keeping their jaggies.
    const spriteGrade = this.settings.spriteGrade;
    const spriteGradeOn = spriteGrade.enabled && spriteGrade.amount > 0.001;
    const wantMask =
      this.spriteLayer !== undefined &&
      ((this.settings.aa.enabled && this.settings.aa.spritePolicy !== 'none') ||
        this.settings.ao.enabled ||
        spriteGradeOn);

    if (wantMask && this.spriteLayer !== undefined) {
      const prevMask = camera.layers.mask;
      const prevBackground = scene.background;
      renderer.getClearColor(this.clearColor);
      const prevAlpha = renderer.getClearAlpha();

      camera.layers.set(this.spriteLayer);
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.maskRT);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);

      camera.layers.mask = prevMask;
      scene.background = prevBackground;
      renderer.setClearColor(this.clearColor, prevAlpha);
    }
    renderer.autoClear = prevAutoClear;

    const maskTexture = wantMask ? this.maskRT.texture : this.whiteTexture;
    const maskEnabled = wantMask ? 1 : 0;

    // 3 ── AO ---------------------------------------------------------------
    let colorTarget = this.sceneRT;
    const ao = this.settings.ao;
    if (ao.enabled && ao.intensity > 0.001) {
      const u = this.aoPass.uniforms;
      u['uDepth']!.value = this.depthTex;
      u['uOrtho']!.value = ortho;
      // The AO pass marches in its own (half-res) pixels, so the world->pixel scale has to
      // be expressed at the AO target's resolution, not the framebuffer's.
      u['uProjScaleY']!.value = 0.5 * (camera.projectionMatrix.elements[5] ?? 1) * this.aoRT.height;
      (u['uTexel']!.value as Vector2).set(1 / this.aoRT.width, 1 / this.aoRT.height);
      u['uRadius']!.value = ao.radius;
      u['uBias']!.value = ao.bias;
      u['uThickness']!.value = ao.thickness;
      u['uIntensity']!.value = ao.power;
      u['uMaxPixelRadius']!.value = Math.max(8, this.aoRT.height * 0.08);
      this.aoPass.render(renderer, this.aoRT);

      if (this.profile.aoBlur) {
        const bu = this.aoBlurPass.uniforms;
        bu['uDepth']!.value = this.depthTex;
        bu['uOrtho']!.value = ortho;
        bu['uProjScaleY']!.value = projScaleY;
        (bu['uTexel']!.value as Vector2).set(1 / this.aoRT.width, 1 / this.aoRT.height);
        bu['uSrc']!.value = this.aoRT.texture;
        (bu['uDirection']!.value as Vector2).set(1, 0);
        this.aoBlurPass.render(renderer, this.aoTmpRT);
        bu['uSrc']!.value = this.aoTmpRT.texture;
        (bu['uDirection']!.value as Vector2).set(0, 1);
        this.aoBlurPass.render(renderer, this.aoRT);
      }

      const au = this.aoApplyPass.uniforms;
      au['uScene']!.value = this.sceneRT.texture;
      au['uAO']!.value = this.aoRT.texture;
      au['uSpriteMask']!.value = maskTexture;
      au['uSpriteMaskEnabled']!.value = maskEnabled;
      au['uStrength']!.value = ao.strength * ao.intensity;
      au['uHighlightGuard']!.value = ao.highlightGuard;
      au['uSpriteAO']!.value = ao.spriteAO;
      (au['uTint']!.value as Vector3).set(ao.tint[0], ao.tint[1], ao.tint[2]);
      this.aoApplyPass.render(renderer, this.hdrRT);
      colorTarget = this.hdrRT;
    }

    // 4 ── bloom ------------------------------------------------------------
    const bloom = this.settings.bloom;
    let bloomTexture: Texture = blackTexture();
    if (bloom.enabled && bloom.intensity > 0.0001 && this.bloomDown.length > 0) {
      const first = this.bloomDown[0]!;
      const pu = this.bloomPrefilterPass.uniforms;
      pu['uSrc']!.value = colorTarget.texture;
      (pu['uTexel']!.value as Vector2).set(1 / this.width, 1 / this.height);
      pu['uThreshold']!.value = bloom.threshold;
      pu['uSoftKnee']!.value = bloom.softKnee;
      pu['uClamp']!.value = bloom.clamp;
      this.bloomPrefilterPass.render(renderer, first);

      for (let i = 1; i < this.bloomDown.length; i++) {
        const src = this.bloomDown[i - 1]!;
        const dst = this.bloomDown[i]!;
        const du = this.bloomDownPass.uniforms;
        du['uSrc']!.value = src.texture;
        (du['uTexel']!.value as Vector2).set(1 / src.width, 1 / src.height);
        this.bloomDownPass.render(renderer, dst);
      }

      const last = this.bloomDown.length - 1;
      let current: WebGLRenderTarget = this.bloomDown[last]!;
      for (let i = last - 1; i >= 0; i--) {
        const finer = this.bloomDown[i]!;
        const dst = this.bloomUp[i]!;
        const uu = this.bloomUpPass.uniforms;
        uu['uSrc']!.value = current.texture;
        uu['uPrev']!.value = finer.texture;
        (uu['uTexel']!.value as Vector2).set(1 / current.width, 1 / current.height);
        uu['uRadius']!.value = bloom.radius;
        this.bloomUpPass.render(renderer, dst);
        current = dst;
      }
      bloomTexture = current.texture;
    }

    // 5 ── depth of field ---------------------------------------------------
    const dof = this.resolveDof();
    const dofOn = dof.enabled && dof.cocPixelsThisFrame > 0.5;
    const maxCoCHalf = dof.cocPixelsThisFrame * this.profile.dofScale;
    let dofTexture: Texture = colorTarget.texture;
    if (dofOn) {
      this.syncCoCUniforms(this.cocPass.uniforms);
      const cu = this.cocPass.uniforms;
      cu['uScene']!.value = colorTarget.texture;
      cu['uDepth']!.value = this.depthTex;
      cu['uOrtho']!.value = ortho;
      cu['uProjScaleY']!.value = projScaleY;
      (cu['uTexel']!.value as Vector2).set(1 / this.width, 1 / this.height);
      this.cocPass.render(renderer, this.dofART);

      const gu = this.gatherPass.uniforms;
      gu['uSrc']!.value = this.dofART.texture;
      (gu['uTexel']!.value as Vector2).set(1 / this.dofART.width, 1 / this.dofART.height);
      gu['uMaxCoCPixels']!.value = Math.max(1, maxCoCHalf);
      gu['uBokehBoost']!.value = dof.bokehBoost;
      gu['uNearSpread']!.value = dof.nearSpread;
      this.gatherPass.render(renderer, this.dofBRT);

      if (this.profile.dofFill) {
        const fu = this.fillPass.uniforms;
        fu['uSrc']!.value = this.dofBRT.texture;
        (fu['uTexel']!.value as Vector2).set(1 / this.dofBRT.width, 1 / this.dofBRT.height);
        this.fillPass.render(renderer, this.dofART);
        dofTexture = this.dofART.texture;
      } else {
        dofTexture = this.dofBRT.texture;
      }
    }

    // 6 ── composite --------------------------------------------------------
    this.updateShockwaves(dt, camera);
    this.syncCoCUniforms(this.compositePass.uniforms);
    const cu = this.compositePass.uniforms;
    cu['uScene']!.value = colorTarget.texture;
    cu['uDoF']!.value = dofTexture;
    cu['uBloom']!.value = bloomTexture;
    cu['uAO']!.value = this.aoRT.texture;
    cu['uSpriteMask']!.value = maskTexture;
    cu['uDepth']!.value = this.depthTex;
    cu['uOrtho']!.value = ortho;
    cu['uProjScaleY']!.value = projScaleY;
    (cu['uResolution']!.value as Vector2).set(this.width, this.height);
    cu['uTime']!.value = this.settings.grain.animate ? this.time : 0;
    cu['uDoFEnabled']!.value = dofOn ? 1 : 0;
    cu['uMaxCoCPixels']!.value = Math.max(1, dof.cocPixelsThisFrame);
    cu['uNearStrength']!.value = dof.nearStrength;
    cu['uBloomIntensity']!.value = bloom.enabled ? bloom.intensity : 0;
    (cu['uBloomTint']!.value as Vector3).set(bloom.tint[0], bloom.tint[1], bloom.tint[2]);
    cu['uExposure']!.value = this.settings.exposure;
    const vig = this.settings.vignette;
    const floor = this.respectReferenceFloor;
    cu['uVignetteAmount']!.value = vig.enabled
      ? floor
        ? Math.max(vig.amount, REFERENCE_FLOOR.vignetteAmount)
        : vig.amount
      : 0;
    cu['uVignetteRadius']!.value = floor ? Math.max(vig.radius, REFERENCE_FLOOR.vignetteRadiusMin) : vig.radius;
    cu['uVignetteSoftness']!.value = vig.softness;
    cu['uVignetteEdge']!.value = vig.edge;
    (cu['uVignetteColor']!.value as Vector3).set(vig.color[0], vig.color[1], vig.color[2]);
    cu['uGrainAmount']!.value = this.settings.grain.enabled
      ? floor
        ? Math.max(this.settings.grain.amount, REFERENCE_FLOOR.grainAmount)
        : this.settings.grain.amount
      : 0;
    cu['uGrainSize']!.value = Math.max(1, this.settings.grain.size * this.pixelRatio);
    cu['uGrainShadowBias']!.value = this.settings.grain.shadowBias;
    cu['uChromaAmount']!.value = this.settings.chroma.enabled ? this.settings.chroma.amount : 0;
    cu['uChromaEdge']!.value = this.settings.chroma.edge;
    // No mask means no way to tell a sprite pixel from a terrain pixel, so the pull has to
    // be off — otherwise it would grade the entire frame a second time.
    cu['uSpriteGradeAmount']!.value = spriteGradeOn && wantMask ? spriteGrade.amount : 0;
    cu['uSpriteDesat']!.value = spriteGrade.desaturate;
    (cu['uSpriteTint']!.value as Vector3).set(spriteGrade.tint[0], spriteGrade.tint[1], spriteGrade.tint[2]);
    cu['uLutMix']!.value = this.lutMix;
    cu['uLutAmount']!.value = this.settings.grade.enabled ? this.settings.grade.amount : 0;
    cu['uAspect']!.value = this.width / this.height;
    cu['uDebug']!.value = debugCode(this.debugView);

    const aaOn = this.settings.aa.enabled && this.debugView === 'off';
    this.compositePass.render(renderer, aaOn ? this.ldrRT : null);

    // 7 ── AA to the canvas -------------------------------------------------
    if (aaOn) {
      const au = this.aaPass.uniforms;
      au['uColor']!.value = this.ldrRT.texture;
      au['uSpriteMask']!.value = maskTexture;
      au['uDepth']!.value = this.depthTex;
      au['uOrtho']!.value = ortho;
      au['uProjScaleY']!.value = projScaleY;
      (au['uTexel']!.value as Vector2).set(1 / this.width, 1 / this.height);
      au['uSubpix']!.value = this.settings.aa.subpix;
      au['uEdgeThreshold']!.value = this.settings.aa.threshold;
      au['uEdgeThresholdMin']!.value = this.settings.aa.thresholdMin;
      au['uSpritePolicy']!.value = spritePolicyCode(this.settings.aa.spritePolicy);
      au['uSpriteMaskEnabled']!.value = maskEnabled;
      this.aaPass.render(renderer, null);
    }

    renderer.setRenderTarget(prevTarget);
  }

  private syncCoCUniforms(u: Record<string, IUniform>): void {
    const dof = this.resolveDof();
    u['uFocusDist']!.value = dof.focusDistance;
    u['uFocusRange']!.value = Math.max(dof.focusRange, 1e-3);
    u['uCoCScale']!.value = dof.cocScale;
    u['uTiltMix']!.value = dof.tiltMix;
    u['uFocusAuto']!.value = dof.focusAuto ? 1 : 0;
    (u['uTiltCenter']!.value as Vector2).set(dof.tiltCenter[0], dof.tiltCenter[1]);
    const rad = (dof.tiltAngle * Math.PI) / 180;
    (u['uTiltAxis']!.value as Vector2).set(-Math.sin(rad), Math.cos(rad));
    u['uTiltBand']!.value = dof.tiltBand;
    u['uTiltFalloff']!.value = Math.max(dof.tiltFalloff, 1e-3);
    u['uTiltRadial']!.value = dof.tiltRadial;
    u['uTiltRadialStart']!.value = dof.tiltRadialStart;
    (u['uCoCAspect']!.value as Vector2).set(this.width / Math.max(this.height, 1), 1);
  }

  /**
   * The DoF settings actually used this frame: authored values clamped up to
   * {@link REFERENCE_FLOOR}, and the CoC radius rescaled from its 1080p reference to the
   * current frame height.
   *
   * `intensity` scales the blur, but only down to the floor — see REFERENCE_FLOOR for why.
   */
  private resolveDof(): ResolvedDof {
    const d = this.settings.dof;
    const floor = this.respectReferenceFloor;
    const out = this.resolvedDof;

    const dialled = d.maxCoCPixels * d.intensity;
    const pixels1080 = floor ? Math.max(dialled, REFERENCE_FLOOR.dofCoCPixels) : dialled;

    out.enabled = d.enabled;
    out.tiltMix = d.tiltMix;
    out.focusAuto = d.focusAuto;
    out.focusDistance = d.focusDistance;
    out.focusRange = d.focusRange;
    out.cocScale = d.cocScale;
    out.tiltCenter = d.tiltCenter;
    out.tiltAngle = d.tiltAngle;
    out.nearStrength = d.nearStrength;
    out.nearSpread = d.nearSpread;
    out.bokehBoost = d.bokehBoost;
    out.tiltRadialStart = d.tiltRadialStart;
    // Band and falloff are floors on SHARPNESS: a scenario may ask for a wider sharp stripe
    // or a gentler ramp, never for a narrower one. Radial is a ceiling — see REFERENCE_FLOOR.
    out.tiltBand = floor ? Math.max(d.tiltBand, REFERENCE_FLOOR.dofTiltBandMin) : d.tiltBand;
    out.tiltFalloff = floor ? Math.max(d.tiltFalloff, REFERENCE_FLOOR.dofTiltFalloffMin) : d.tiltFalloff;
    out.tiltRadial = floor ? Math.min(d.tiltRadial, REFERENCE_FLOOR.dofTiltRadialMax) : d.tiltRadial;
    // Sized against the frame, not the framebuffer: `maxCoCPixels` is authored at 1080p.
    out.cocPixelsThisFrame = pixels1080 * (this.height / 1080);
    return out;
  }

  /** Put the sharp band on a world position — e.g. the acting unit. */
  focusOn(worldPoint: Vector3, camera: Camera): void {
    this.tmpVec3.copy(worldPoint).project(camera);
    this.settings.dof.tiltCenter = [this.tmpVec3.x * 0.5 + 0.5, this.tmpVec3.y * 0.5 + 0.5];
    const cam = camera as PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      this.settings.dof.focusDistance = worldPoint.distanceTo(cam.position);
    }
  }

  private updateShockwaves(dt: number, camera: Camera): void {
    let write = 0;
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]!;
      w.age += dt;
      if (w.age >= w.duration) {
        this.waves.splice(i, 1);
      }
    }
    for (const w of this.waves) {
      if (write >= MAX_SHOCKWAVES) break;
      const t = Math.min(1, w.age / w.duration);
      this.tmpVec3.copy(w.origin).project(camera);
      // Ease-out radius, quadratic amplitude decay: a real shockwave loses energy fast.
      const radius = w.maxRadius * (1 - Math.pow(1 - t, 2.2));
      const amp = w.amplitude * Math.pow(1 - t, 2.0);
      this.waveUniform[write]!.set(this.tmpVec3.x * 0.5 + 0.5, this.tmpVec3.y * 0.5 + 0.5, radius, amp);
      write++;
    }
    for (let i = write; i < MAX_SHOCKWAVES; i++) this.waveUniform[i]!.set(0, 0, 0, 0);
    this.compositePass.uniforms['uWaveCount']!.value = write;
  }

  // ── Teardown ────────────────────────────────────────────────────────────

  private disposeTargets(): void {
    const targets = [
      this.sceneRT, this.hdrRT, this.ldrRT, this.maskRT,
      this.aoRT, this.aoTmpRT, this.dofART, this.dofBRT,
      ...this.bloomDown, ...this.bloomUp,
    ];
    for (const t of targets) if (t) t.dispose();
    if (this.depthTex) this.depthTex.dispose();
    this.bloomDown = [];
    this.bloomUp = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeTargets();
    for (const p of [
      this.aoPass, this.aoBlurPass, this.aoApplyPass,
      this.bloomPrefilterPass, this.bloomDownPass, this.bloomUpPass,
      this.cocPass, this.gatherPass, this.fillPass,
      this.compositePass, this.aaPass,
    ]) p.dispose();
    for (const lut of this.lutCache.values()) lut.dispose();
    this.lutCache.clear();
    this.whiteTexture.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function debugCode(view: DebugView): number {
  switch (view) {
    case 'ao': return 1;
    case 'bloom': return 2;
    case 'coc': return 3;
    case 'dof': return 4;
    case 'sprite-mask': return 5;
    case 'no-grade': return 6;
    default: return 0;
  }
}

function spritePolicyCode(policy: SpritePolicy): number {
  return policy === 'exclude' ? 0 : policy === 'silhouette' ? 1 : 2;
}

function makeSolidTexture(r: number, g: number, b: number, a: number): DataTexture {
  const tex = new DataTexture(new Uint8Array([r, g, b, a]), 1, 1, RGBAFormat, UnsignedByteType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function makeWhiteTexture(): DataTexture {
  return makeSolidTexture(255, 255, 255, 255);
}

let _black: DataTexture | null = null;
function blackTexture(): DataTexture {
  if (!_black) _black = makeSolidTexture(0, 0, 0, 255);
  return _black;
}

function mergeSettings(base: PostSettings, patch?: DeepPartial<PostSettings>): PostSettings {
  if (!patch) return base;
  const out = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(cur as object, v);
    } else {
      out[k] = v;
    }
  }
  return base;
}
