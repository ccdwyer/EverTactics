/**
 * EverTactics — sky / atmosphere gradient.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Round-2 blind A/B: critics identified our frame as the prototype in 6/6 pairs,
 * and the single most-cited tell was the *void*. Roughly half of a 1920×1080
 * frame was 'renderer.clearColor' — one flat near-black navy — with the diorama
 * sitting in the middle of it terminating on a hard antialiased silhouette.
 *
 * Neither reference game ever does that. Open
 * 'refs/curated/triangle/press_002_gematsu_1920x1080.jpg' or
 * 'official_005_steam.jpg': the world runs off all four frame edges. Even
 * 'official_009_steam.jpg', which is the darkest frame in the corpus, has the
 * mine dissolving into a warm glow rather than cutting against a flat colour.
 *
 * So: a graded sky, drawn behind everything, tuned from the map's own lighting
 * preset. Not a skybox — the rig is orthographic, so a cube/dome would project
 * to a single constant colour and buy us nothing. What actually reads is a
 * *screen-space* vertical grade with a horizon band, a sun bloom placed where
 * the key light is on screen, and low-frequency cloud banding so it is never a
 * flat wash. That is what a matte-painted backdrop plate does, and it is what an
 * orthographic HD-2D frame needs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COLOUR SPACE
 * ─────────────────────────────────────────────────────────────────────────────
 * 'stage.ts' composes into a linear-working-space HDR target and lets
 * 'post.ts' tone map at the end. Everything here therefore emits **linear**
 * values. 'Color' uniforms are already in working space once built with
 * 'setHex(hex, 'srgb')', so the shader just mixes them and writes them out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPTH
 * ─────────────────────────────────────────────────────────────────────────────
 * The quad is emitted directly in clip space with 'depthTest'/'depthWrite' off
 * and 'renderOrder = -10000', so it is always the first thing in the frame and
 * never fights the scene. It leaves depth at the far plane, which means
 * 'post.ts''s DoF treats sky pixels as maximally distant — correct, and it
 * softens the cloud banding for free.
 */

import {
  Color,
  DirectionalLight,
  Fog,
  FogExp2,
  Mesh,
  PlaneGeometry,
  PointLight,
  Scene,
  ShaderMaterial,
  SpotLight,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Shared GLSL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hash / value-noise / fbm, shared by 'sky.ts', 'backdrop.ts' and
 * 'atmosphere.ts' so every layer of the environment breaks up with the *same*
 * noise basis. Mismatched noise between a haze plane and the silhouettes in
 * front of it is one of those things nobody can name but everybody sees.
 */
export const GLSL_NOISE = /* glsl */ `
float etHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
float etHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 etHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float etNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(etHash12(i + vec2(0.0, 0.0)), etHash12(i + vec2(1.0, 0.0)), u.x),
    mix(etHash12(i + vec2(0.0, 1.0)), etHash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float etFbm(vec2 p, int octaves) {
  float a = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += a * etNoise(p);
    norm += a;
    p *= 2.03;
    p += 17.31;
    a *= 0.5;
  }
  return sum / max(norm, 1e-4);
}
`;

/**
 * The upward recession. Shared by every environment layer so they recede as one
 * surface rather than as four independently-tuned ones.
 *
 * ── Why a SCREEN-SPACE grade and not more depth haze ────────────────────────
 *
 * Measured on the round-7 frozen build with 'tools/_scratch/fartop.mjs':
 *
 *     farTop / board luminance      ours 1.30      references 0.34 - 0.57
 *     farTop p95                    ours 173       references  78 - 113
 *
 * The top fifteen percent of our frame — the band that carries no gameplay and
 * almost no subject — was the BRIGHTEST region in the image. A frame whose
 * brightest region is its emptiest has no focal hierarchy by construction, and
 * that is the composition axis in one number.
 *
 * Runtime layer attribution (see 'tools/_scratch/envprobe.mjs') put it on this
 * module rather than on terrain or post: hiding the sky plate left the band at
 * 70.8, hiding the backdrop left it at 70.2, hiding BOTH dropped it to 49.7.
 * Both layers independently fill the band at the same value, so neither shows
 * up when toggled alone and the defect looks unattributable. It is ours.
 *
 * Depth haze cannot fix it. Under a tilted-orthographic rig screen height is
 * *not* depth: a ridge tower's base and its roofline are the same distance from
 * the lens, so any purely depth-driven term grades them identically — and it is
 * the rooflines, cropping against the top edge, that carry the band. Height
 * above the horizon is the axis the defect actually lives on, so it is the axis
 * the grade has to run on.
 *
 * Open 'refs/curated/triangle/official_003_steam.jpg': the world runs to the
 * top edge (no sky at all), and the architecture up there is graded to near
 * black while the board two thirds down is the brightest thing in frame. That
 * is the target this reproduces.
 *
 * ── Why value AND chroma ────────────────────────────────────────────────────
 *
 * Cutting value alone is what round 7 established does not work: every
 * value-only variant of the near-field margin grade traded luminance for
 * 'backgroundFraction' one-for-one, because a flat dark region is
 * indistinguishable from no geometry — to the metric and to a critic. So value
 * is cut, and the remainder is bound toward the map's crushed tone at CONSTANT
 * luminance, which buys back the separation without spending any of the
 * variance that keeps the band reading as scenery.
 */
/**
 * In-scattered light from the warm practical pool. Shared by every environment
 * layer so they cannot disagree about where the fire is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ADDITIVE, AND WHY IT FALLS OFF
 * ─────────────────────────────────────────────────────────────────────────────
 * The global hue mix in 'deriveEnvironmentPalette' was measured on a same-build
 * A/B (toggling 'airlightGain' inside one page session, which is the only A/B
 * that means anything while five agents edit the repo at once). It moved the
 * frame's zone warmth by 1–2 units against a 30–60 unit gap to the reference
 * corpus: the haze and ground bands sit at 0.02–0.03 linear, so re-hueing them
 * cannot survive everything drawn on top. Scattered light physically ADDS
 * radiance, and adding it is also the only operation with enough authority to
 * register.
 *
 * The falloff is what keeps that honest. Two separate critiques name the same
 * failure from opposite sides:
 *
 *   "The brazier has no inverse-square falloff … warm rim light appears on
 *    tiles twelve-plus tiles away at roughly the same intensity as tiles
 *    adjacent to the flame. That is a global two-tone grade masquerading as
 *    light."
 *   "The fire pit is emissive-only: it blooms but illuminates nothing."
 *
 * A constant term is the first; no term at all is the second. An inverse-square
 * pool with an N·L factor is neither — it is brightest on surfaces facing the
 * flame and near it, and gone a few radii out, which is what the reference
 * frames show and what makes the surround belong to the same lit space as the
 * board rather than being a cold shell around it.
 *
 * 'centre' and 'p' must be in the same frame (both yaw-local for the backdrop
 * layers, both world for anything unrotated). 'n' may be a zero vector, in which
 * case the directional factor drops out and only the distance term applies —
 * correct for volumetric layers like haze cards, which have no meaningful
 * surface normal.
 */
export const GLSL_AIRLIGHT = /* glsl */ `
vec3 etAirlight(vec3 p, vec3 n, vec3 centre, float radius, vec3 colour) {
  vec3 toAir = centre - p;
  float d2 = dot(toAir, toAir);
  float r = max(radius, 1e-3);
  // Inverse-square with a softening core, so a fragment that lands almost on
  // the emitter does not divide by zero and blow out the plate under it.
  float fall = 1.0 / (1.0 + d2 / (r * r));
  // Square it. A single inverse-square still carries ~10% of peak at three
  // radii, which over a 40-unit surround is precisely the "same intensity
  // twelve tiles away" read. This puts the pool genuinely local.
  fall *= fall;
  float lambert = 1.0;
  if (dot(n, n) > 1e-6) {
    // 0.30 floor rather than 0: a surface facing away from a fire in real air
    // is still sitting in the glow it throws, and a hard terminator here would
    // reintroduce the black-shadow-side hole this module exists to remove.
    lambert = 0.30 + 0.70 * max(dot(normalize(n), normalize(toAir)), 0.0);
  }
  return colour * fall * lambert;
}
`;

export const GLSL_RECEDE = /* glsl */ `
/**
 * 'fade' = (startY, endY, floor) with Y as a 0..1 screen fraction from the
 * bottom; 'deepUnit' is the map's crushed tone normalised to unit luminance so
 * the chroma bind cannot move value; 'brk' is a per-layer patchiness factor,
 * nominally around 1, that modulates the FLOOR.
 *
 * ── Why 'brk' exists ────────────────────────────────────────────────────────
 *
 * The first version had no break: one smoothstep, one multiply. It fixed the
 * ratio (farTop/board 1.30 -> 0.61) and immediately re-created the defect it
 * was fixing, one axis over — 'backgroundFraction' went 0.139 -> 0.180 and
 * 'backgroundDetail' 14.08 -> 10.60, because a uniform multiply scales a
 * region's standard deviation by exactly the same factor it scales its mean.
 * Pull a textured band to a quarter of its value and you get a quarter of its
 * texture, which is to say a flat card, which is to say the void.
 *
 * That is the identical trap the near-field margin grade fell into in round 7
 * (see the measurement table in 'backdrop.ts'), and the answer is the same:
 * remove luminance without removing variance. A spatially varying floor does
 * that directly — the mean falls, the spread does not, because neighbouring
 * fragments are now being scaled by materially different factors.
 *
 * It is also physically the honest version. Distance haze is patchy; the
 * plate's own 'hazeBreak' already makes this argument for the same reason.
 */
vec3 etRecede(vec3 col, float screenY, vec3 fade, vec3 deepUnit, float brk) {
  float t = smoothstep(fade.x, fade.y, screenY);
  if (t <= 0.0) return col;
  vec3 c = col * mix(1.0, clamp(fade.z * brk, 0.03, 1.35), t);
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  float lum = dot(c, W);
  // 0.40, down from 0.55. The bind is what makes the receded band belong to the
  // map's grade rather than drifting to grey, but every point of it is a point
  // of per-pixel HUE variance spent, and hue variance is half of what keeps the
  // band from matching a single corner colour.
  return mix(c, deepUnit * lum, t * 0.40);
}
vec3 etRecede(vec3 col, float screenY, vec3 fade, vec3 deepUnit) {
  return etRecede(col, screenY, fade, deepUnit, 1.0);
}
`;

/** Normalise a colour to unit luminance; safe on black. Matches 'deepUnit' in GLSL. */
export function unitLuminance(c: Color, out = new Color()): Color {
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (lum < 1e-4) return out.setRGB(0.62, 0.78, 1.35);
  return out.copy(c).multiplyScalar(1 / lum);
}

/**
 * Default recession: (start, end, floor) in screen fractions from the bottom.
 *
 * 0.44 rather than "just the top band" on purpose. The grade has to be a ramp
 * the eye reads as air, not a bar across the top of the image; starting it below
 * the board's own upper edge means the transition happens *behind* geometry,
 * where there is no clean line for it to draw. Ends short of 1.0 so the very
 * top rows are not a separate flat plateau.
 */
export const DEFAULT_RECESSION: [number, number, number] = [0.44, 0.99, 0.26];

/**
 * The sky recedes HARDER than the geometry standing in front of it.
 *
 * Applying one floor to everything is the obvious reading of "the frame recedes
 * upward", and it is wrong in a way that is only visible once it is on screen:
 * a uniform multiply preserves the ratio between a roofline and the sky behind
 * it, so the whole upper band gets darker together and the architecture up there
 * stops being architecture and becomes one dark mass. Measured, that showed up
 * as 'backgroundDetail' 14.08 -> 10.60 and, in the frame, as a top-left quadrant
 * with nothing legible in it — the void again, now black instead of navy.
 *
 * Open 'refs/curated/triangle/press_002_gematsu_1920x1080.jpg': the top of that
 * frame is very dark AND completely legible, because the gap between the
 * buildings and the air behind them WIDENS as both go down. Biasing the sky's
 * floor under the geometry's reproduces that: silhouettes gain contrast exactly
 * where the grade is strongest, which is the opposite of what a single floor
 * does.
 */
export const SKY_RECESSION_BIAS = 0.55;

// ─────────────────────────────────────────────────────────────────────────────
// Palette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one palette every environment layer shares.
 *
 * It is *derived from the scene* rather than configured, which is the whole
 * coordination trick: 'lighting.ts' owns 'scene.background', 'scene.fog' and the
 * key 'DirectionalLight', and those three things already encode the map's mood.
 * Reading them back means the sky, the backdrop and the motes re-tune themselves
 * whenever the lighting fixer changes a preset, with no shared config file and
 * no cross-module call.
 *
 * All colours are LINEAR working space.
 */
export interface EnvironmentPalette {
  /** Top of frame. Deepest, coolest. */
  zenith: Color;
  /** The bright band the ground plane fades into. Carries the key's warmth. */
  horizon: Color;
  /** Distance haze — what far geometry is mixed toward. */
  haze: Color;
  /** Below the horizon line: earth/water tone under the haze. */
  ground: Color;
  /** Key-light colour, used for the sun bloom and for lighting the backdrop. */
  sun: Color;
  /** The map's crushed-black tint. Never neutral grey. */
  deep: Color;
  /** Normalised world-space direction the key light travels (sun → scene). */
  sunDirection: Vector3;
  /** Key intensity, so distant geometry can be lit in the same units. */
  sunIntensity: number;
  /**
   * False when the scene has no lighting rig yet, or none at all.
   *
   * The diagnostic scenes ('ui-only', 'sprites-only') run without one. With the
   * warm fallback key they were getting a full sepia sky complete with a sun
   * bloom, which is noise in a frame whose whole job is to isolate one
   * subsystem. When this is false the sky drops to a flat cool wash.
   */
  hasKey: boolean;

  // ── airlight: the scene's practicals scattering into the air ──────────────
  //
  // See 'surveyPracticals'. These four are consumed as a group: 'airlight' is
  // the colour, 'airlightPower' says how much of it there is, and the centre
  // and radius let each layer apply it with a real spatial falloff rather than
  // as a global grade.

  /** Aggregate practical colour, normalised to unit peak channel (a hue). */
  airlight: Color;
  /** 0…1, saturating. 0 on a map with no point lights at all. */
  airlightPower: number;
  /** World-space, intensity-weighted centroid of the practicals. */
  airlightCentre: Vector3;
  /** Mean effective reach of the practicals, in world units. */
  airlightRadius: number;
}

export interface PaletteTuning {
  /** Overall gain on the sky. 1 = as derived. */
  skyGain?: number;
  /** How far the horizon band is pushed toward the key colour. 0…1 */
  horizonWarmth?: number;
  /** Gain on the haze colour that distant geometry fades into. */
  hazeGain?: number;
  /**
   * Chroma floor applied to the cool bands (haze / zenith / ground) after the
   * tint mixing, 0…1. This is what keeps the aerial perspective a *colour*
   * rather than a grey; see 'saturateTo'. 0 restores the pre-round-6 behaviour.
   */
  coolSaturation?: number;
  /** Chroma floor for the warm horizon band. Held under 'coolSaturation' so the
   * split reads as "cool air, warm light" rather than as two equal poster tones. */
  warmSaturation?: number;
  /**
   * Gain on the practical airlight, 1 = as derived, 0 disables it entirely and
   * restores the pre-round-9 cold surround. See 'surveyPracticals'.
   */
  airlightGain?: number;
}

/**
 * Linear luminance targets for the environment, measured against the board.
 *
 * These are the numbers that took three render iterations to land, so they are
 * worth writing down. 'post.ts' multiplies by the preset exposure (1.5–1.75 on
 * the dawn maps) and then runs ACES, which has a knee well under 1.0 — so a
 * "reasonable-looking" linear 0.3 background comes out of the tonemapper as
 * cream-coloured blowout, and the board disappears into it. The lit board sits
 * around 0.10–0.30 linear. The references put the background a stop and a half
 * under that, which is where these land.
 */
const HAZE_LEVEL = 0.032;
const HORIZON_LEVEL = 0.075;
const ZENITH_LEVEL = 0.015;
const GROUND_LEVEL = 0.022;

/** Strip brightness off a colour, keeping only its hue/saturation. */
function tintOf(c: Color, out = new Color()): Color {
  const m = Math.max(c.r, c.g, c.b);
  if (m < 1e-5) return out.setRGB(0.5, 0.55, 0.7);
  return out.setRGB(c.r / m, c.g / m, c.b / m);
}

/** Max-channel saturation of a tint, i.e. '(max − min) / max'. */
function chromaOf(c: Color): number {
  const mx = Math.max(c.r, c.g, c.b);
  if (mx < 1e-5) return 0;
  return (mx - Math.min(c.r, c.g, c.b)) / mx;
}

/**
 * Push a tint away from the achromatic axis until it reaches 'target' chroma,
 * preserving hue. Never *desaturates* — a preset that already commits harder
 * than the floor keeps its own colour.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * 'tintOf' normalises by the max channel, which fixes brightness and does
 * nothing at all to saturation. That is fine on its own, but every band below
 * is built by *mixing* two tints, and the cool fog and the warm key sit on
 * opposite sides of the colour wheel — so the mix lands near grey and 'tintOf'
 * faithfully preserves the grey.
 *
 * Measured on the round-6 frame, that is exactly what shipped: the derived haze
 * came out '#303132' at chroma 0.075 — achromatic to three significant figures —
 * and haze is what *all* distant geometry is mixed toward in 'STRUCT_FRAG'. So
 * the entire surround was fading into neutral grey, against a 'scene.background'
 * that was a committed '#0a1424' at chroma 0.828. That is the "no neutral greys"
 * and "crush blacks toward the map's cool tone" rule in 'VISUAL_TARGET.md'
 * broken by arithmetic rather than by intent, and it measured as a far-field
 * saturation of 0.44–0.57 against 0.61–0.80 across the Triangle references.
 *
 * The fix is a floor, not a multiplier: multiplying chroma that is already ~0
 * still gives ~0. Restoring toward an absolute target is the only operation that
 * recovers a hue the mix destroyed.
 */
function saturateTo(c: Color, target: number, out = new Color()): Color {
  out.copy(c);
  const mx = Math.max(out.r, out.g, out.b);
  if (mx < 1e-5) return out;
  const mn = Math.min(out.r, out.g, out.b);
  const have = (mx - mn) / mx;
  if (have >= target || target <= 0) return out;
  // Scale the distance of each channel below the max. 'have → target' is exact:
  // the new min becomes mx * (1 − target), and hue (the ordering and the ratios
  // between the two non-max channels) is preserved because every channel is
  // moved by the same factor of its own deficit.
  const k = have > 1e-5 ? target / have : 0;
  if (k === 0) {
    // Fully achromatic input carries no hue to preserve. Fall back to the cool
    // anchor rather than inventing one, so the result is still the map's tone.
    return out.setRGB(mx * (1 - target), mx * (1 - target * 0.45), mx);
  }
  out.setRGB(mx - (mx - out.r) * k, mx - (mx - out.g) * k, mx - (mx - out.b) * k);
  return out;
}

const DEFAULT_DEEP = new Color().setHex(0x080d18, 'srgb');
const DEFAULT_HAZE = new Color().setHex(0x1b3050, 'srgb');
/** Cool, not warm: this is the no-lighting-rig fallback, not a sunrise. */
const DEFAULT_SUN = new Color().setHex(0x9fb6d8, 'srgb');

function firstKeyLight(scene: Scene): DirectionalLight | null {
  let best: DirectionalLight | null = null;
  scene.traverse((o: Object3D) => {
    const light = o as DirectionalLight;
    if (!light.isDirectionalLight) return;
    if (best === null || light.intensity > best.intensity) best = light;
  });
  return best;
}

/**
 * The practicals: every point/spot light on the scene, aggregated.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — measured, round 9
 * ─────────────────────────────────────────────────────────────────────────────
 * The palette above derives the whole surround from exactly two things: the
 * strongest 'DirectionalLight', and 'scene.background' / 'scene.fog'. On a
 * daylight map that is the entire lighting story and the derivation is right.
 * On 'battle-open' — a torch-lit night courtyard — it is the *wrong two things*,
 * because the directional is a cold moon and the background is crushed navy, so
 * every layer this module feeds comes out cold. Meanwhile the board itself is
 * lit almost entirely by a warm brazier that this function never looked at.
 *
 * That split is measurable. Per-zone mean (R − B) on the round-9 frame:
 *
 *            cornerTL  cornerTR  cornerBL  cornerBR  nearBand  farBand  centre
 *   ours       −12.2     −7.8      −1.4     −20.8     −17.2    −12.0    +16.1
 *   press_002  +24.9    +48.4     +16.5     +63.8     +49.8    +53.2    +80.3
 *   offic_033  +32.0    +34.2     +40.8     +13.4     +27.0    +31.6    +44.4
 *   offic_009  +20.1     +5.3      +0.2      +2.7      +6.3    +18.5     +6.9
 *
 * Every zone of every reference is warm-positive, including the far surround.
 * Ours is warm in the centre and cold in all six surrounding zones — i.e. a warm
 * diorama sitting inside a cold shell, with the boundary between them falling
 * exactly on the board's silhouette. That is the "sprites/board composited from
 * a different build" and "the surround is a separate layer" read, and no amount
 * of extra silhouette geometry fixes it, because the defect is chromatic.
 *
 * Physically the references are simply correct: a courtyard full of burning
 * torches scatters warm light into the air around it. Air is a participating
 * medium, so the haze near a fire is the colour of the fire. Reading the
 * practicals and letting them tint the airlight is that effect, and it is the
 * one term that can put warmth into the surround *without* warming the cold
 * complement that the shadow side depends on — because it falls off with
 * distance from the flames rather than being a global grade.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE WARM POOL ONLY, AND WHY IT IS SPATIAL
 * ─────────────────────────────────────────────────────────────────────────────
 * The first version of this aggregated *every* point light into one mean colour
 * and mixed that into the bands globally. Probing the live scene showed why that
 * is wrong on both counts. 'battle-open' carries seven practicals:
 *
 *   Practical0    4d90ff  i 3.6  d 7.5   at ( 7.0, 0.6,  7.7)
 *   Practical1    6aa4ff  i 9.8  d 12    at ( 7.0, 3.2, -0.7)
 *   Practical2    5c96f0  i 8.6  d 10    at (-0.7, 3.0,  8.9)
 *   BounceFill0   e0997a  i 3.0  d 13.2  at ( 5.0, 1.8, 10.0)
 *   BounceFill1   e09779  i 2.3  d 13.2  at ( 4.0, 1.3,  8.0)
 *   brazier-light ff893a  i 3.1  d 8.5   at ( 4.0, 2.2,  8.0)
 *   brazier-light ff8b3d  i 4.0  d 8.5   at ( 5.0, 2.8, 10.0)
 *
 * The cool group outweighs the warm one, so the aggregate came out at
 * (0.64, 0.50, 1.00) — *blue*. Mixing that into the haze made the surround
 * colder, and the measured per-zone warmth moved by about one unit in the wrong
 * direction. A mean over a deliberately complementary rig destroys exactly the
 * split it was supposed to carry.
 *
 * The two groups are also in different places: the warm one is a tight cluster
 * around (4.5, 2, 9) — the brazier — and the cool one is spread across the far
 * corners of the board. That is the actual structure of the scene, and it is
 * what a global mix throws away.
 *
 * So this returns the WARM pole only, with its real centroid and reach, and the
 * layers apply it as a distance-falloff pool rather than a grade. The cool
 * complement needs no help: it is already what every band derives from.
 *
 * That ordering also keeps this module out of 'lighting.ts''s way. It does not
 * decide the map's mood; it reports where the fire is and lets the air respond
 * to it, so a preset change moves the pool instead of fighting a hardcoded tint.
 *
 * Weighting is intensity × reach × chroma. Chroma matters because a broad
 * near-neutral source is modelling bounce, not a visible emitter, and only a
 * saturated one measurably tints the air around it.
 */
export interface PracticalPool {
  /** Aggregate hue of the warm practicals (unit peak channel). */
  colour: Color;
  /** 0…1, saturating. 0 when the map has no warm practicals at all. */
  power: number;
  /** World-space, weighted centroid of the warm practicals. */
  centre: Vector3;
  /** Effective reach in world units — how far the pool is allowed to carry. */
  radius: number;
}

function surveyPracticals(scene: Scene): PracticalPool {
  const colour = new Color(0, 0, 0);
  const centre = new Vector3();
  let total = 0;
  let spread = 0;
  let count = 0;

  const pos = new Vector3();
  scene.traverse((o: Object3D) => {
    const light = o as PointLight & SpotLight;
    if (!light.isPointLight && !light.isSpotLight) return;
    const c = light.color;
    // Warm pole only. A light whose blue channel leads is part of the cool
    // complement and must not be averaged into the fire's colour.
    const warmth = c.r - c.b;
    if (warmth <= 0.02) return;
    const peak = Math.max(c.r, c.g, c.b, 1e-5);
    const chroma = (peak - Math.min(c.r, c.g, c.b)) / peak;

    const reach = light.distance > 0 ? light.distance : 8;
    const weight = Math.max(0, light.intensity) * reach * chroma;
    if (weight <= 1e-4) return;

    light.updateWorldMatrix(true, false);
    pos.setFromMatrixPosition(light.matrixWorld);
    colour.r += c.r * weight;
    colour.g += c.g * weight;
    colour.b += c.b * weight;
    centre.addScaledVector(pos, weight);
    spread += reach * weight;
    total += weight;
    count += 1;
  });

  if (total <= 1e-4 || count === 0) {
    // No warm practical: the pool is off, not guessed. A map lit only by a cold
    // moon should stay cold — that is a legitimate mood, and inventing a fire
    // for it would be this module overriding the lighting fixer.
    return { colour: new Color(1, 0.62, 0.3), power: 0, centre: new Vector3(), radius: 12 };
  }

  colour.multiplyScalar(1 / total);
  centre.multiplyScalar(1 / total);
  tintOf(colour, colour);

  /**
   * Power saturates. Absolute preset intensity is owned by 'lighting.ts' and
   * moves between rounds; if the airlight scaled linearly with it this module
   * would re-grade the frame every time that fixer touched a number. What
   * matters here is only "is this map fire-lit at all", so the curve is flat
   * well before any plausible preset value.
   */
  const power = total / (total + 34);
  // Weighted mean reach, floored so a map of small lamps still pools readably.
  const radius = Math.max(7, spread / total);
  return { colour, power, centre, radius };
}

/**
 * Build the shared palette by reading back what 'lighting.ts' put on the scene.
 *
 * The lift factors here are the one place with real authored judgement in this
 * file. Preset fog/background colours are *very* dark — 'dawn' is '0x13253e',
 * which lands at about 0.02 linear. Rendered at that value the sky is still a
 * void; it is just a slightly different void. The reference frames put their
 * backgrounds roughly one and a half stops under the lit board, not eight, so
 * the haze is lifted hard and the horizon is lifted harder and pushed toward the
 * key colour.
 */
export function deriveEnvironmentPalette(scene: Scene, tuning: PaletteTuning = {}): EnvironmentPalette {
  const skyGain = tuning.skyGain ?? 1;
  const horizonWarmth = tuning.horizonWarmth ?? 0.36;
  const hazeGain = tuning.hazeGain ?? 1;
  const coolSaturation = tuning.coolSaturation ?? 0.52;
  const warmSaturation = tuning.warmSaturation ?? 0.38;
  const airlightGain = tuning.airlightGain ?? 1;

  const deep = new Color();
  if (scene.background instanceof Color) deep.copy(scene.background);
  else deep.copy(DEFAULT_DEEP);

  const fogColor = new Color();
  const fog = scene.fog;
  if (fog instanceof Fog || fog instanceof FogExp2) fogColor.copy(fog.color);
  else fogColor.copy(DEFAULT_HAZE);

  const key = firstKeyLight(scene);
  const sun = new Color();
  if (key) sun.copy(key.color);
  else sun.copy(DEFAULT_SUN);
  const sunIntensity = key ? key.intensity : 3;

  // Key travel direction. three's DirectionalLight shines from 'position'
  // toward 'target', so the direction light *travels* is target − position.
  const sunDirection = new Vector3(0, -1, 0);
  if (key) {
    key.updateWorldMatrix(true, false);
    key.target.updateWorldMatrix(true, false);
    const from = new Vector3().setFromMatrixPosition(key.matrixWorld);
    const to = new Vector3().setFromMatrixPosition(key.target.matrixWorld);
    sunDirection.copy(to).sub(from);
    if (sunDirection.lengthSq() < 1e-8) sunDirection.set(0, -1, 0);
    sunDirection.normalize();
  }

  // ── hue first, brightness second ────────────────────────────────────────
  //
  // Mixing a preset's fog colour toward the raw key colour does not do what it
  // looks like it does: a key of '0xffae55' is 1.0 in the red channel, so a 14%
  // mix into a 0.02-linear fog adds 0.14 of full-scale red and the "subtle
  // warm tint" arrives as a cream wash. Normalise both to hue, mix the hues,
  // then set the level explicitly.
  const fogTint = tintOf(fogColor);
  const sunTint = tintOf(sun);
  const deepTint = tintOf(deep);

  // ── keep the hue the mix throws away ────────────────────────────────────
  //
  // Order matters here. The warm mix happens first (it is what gives the air its
  // slight key-light contamination, which is real and worth keeping), and the
  // chroma floor is applied *after*, so the result is a saturated version of the
  // mixed hue rather than an unmixed one.
  //
  // The cool bands are anchored back toward 'deepTint' before saturating. The
  // preset's 'scene.background' is the one colour on the scene that was authored
  // as "this map's tone" — deriving the air from it is what makes the surround
  // belong to the same map as the crushed blacks, instead of being a grey the
  // fog colour happened to average to.
  const hazeTint = saturateTo(
    tintOf(fogTint.clone().lerp(sunTint, 0.16)).lerp(deepTint, 0.3),
    coolSaturation,
  );
  const horizonTint = saturateTo(
    tintOf(hazeTint.clone().lerp(sunTint, horizonWarmth)),
    warmSaturation,
  );
  const zenithTint = saturateTo(tintOf(hazeTint.clone().lerp(deepTint, 0.7)), coolSaturation);

  // ── airlight ────────────────────────────────────────────────────────────
  //
  // The warm practicals' contribution to the air. Applied as a HUE mix on the
  // bands, never as an additive lift: the bands' levels are the result of
  // several rounds of measurement against the reference corpus and adding
  // energy to them re-opens the "background brighter than the subject" problem
  // the ground plate comments describe at length.
  //
  // This is the GLOBAL half of the effect and it is deliberately the smaller
  // half — enough that the far frame edges are not a different colour world
  // from the board (every reference zone is warm-positive, including the
  // corners), while the pool term the layers apply from 'airlightCentre' does
  // the work that has to fall off. Global alone is the "two-tone grade
  // masquerading as light" failure; spatial alone leaves the frame edges cold.
  //
  // The mix weights are deliberately unequal, and the ordering is the whole
  // point of the effect:
  //
  //   haze    0.34 — the largest one. Haze is what every distant surface is
  //                  mixed toward, so this is the term that carries warmth out
  //                  to the frame edges where the measurement said it was
  //                  missing.
  //   ground  0.30 — the plate is the lower third of the frame; a cold plate
  //                  under a warm board is the near-band deficit directly.
  //   horizon 0.16 — already warm by construction ('horizonWarmth'), so it
  //                  needs the least help and over-mixing it collapses the
  //                  sky's own vertical gradient into one tone.
  //   zenith  0.07 — nearly untouched ON PURPOSE. The top of frame is the cool
  //                  complement; if the airlight reaches it there is no
  //                  warm/cool split left anywhere and the frame becomes the
  //                  single-hue sepia wash the critics flagged on the other
  //                  side of this exact axis.
  const air = surveyPracticals(scene);
  const airPower = Math.min(1, air.power * airlightGain);
  const warmAir = (c: Color, amount: number): Color =>
    // Hue-space mix, then restore the band's own level. Lerping a 0.03-linear
    // haze toward a 1.0-peak light colour would otherwise triple its value —
    // the same trap 'applyPalette' in 'backdrop.ts' documents.
    tintOf(tintOf(c.clone()).lerp(air.colour, amount * airPower)).multiplyScalar(
      Math.max(c.r, c.g, c.b, 1e-5),
    );

  /** Distance haze — what far geometry desaturates into. */
  const haze = warmAir(hazeTint.clone().multiplyScalar(HAZE_LEVEL * hazeGain), 0.34);

  /** The brightest band in the sky, where the ground plate dissolves. */
  const horizon = warmAir(horizonTint.clone().multiplyScalar(HORIZON_LEVEL * skyGain), 0.16);

  /** Top of frame: cool and deep, but never the flat clear colour. */
  const zenith = warmAir(zenithTint.clone().multiplyScalar(ZENITH_LEVEL * skyGain), 0.07);

  /** Only visible below the horizon where the ground plate has faded out. */
  const ground = warmAir(
    hazeTint.clone().lerp(deepTint, 0.45).multiplyScalar(GROUND_LEVEL * skyGain),
    0.3,
  );

  return {
    zenith,
    horizon,
    haze,
    ground,
    sun,
    deep,
    sunDirection,
    sunIntensity,
    hasKey: key !== null,
    airlight: air.colour,
    airlightPower: airPower,
    airlightCentre: air.centre,
    airlightRadius: air.radius,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sky
// ─────────────────────────────────────────────────────────────────────────────

export interface SkyOptions {
  /**
   * Screen-space height of the horizon band, 0 (bottom) … 1 (top). The
   * orchestrator recomputes this every frame from where the ground plate
   * actually vanishes, so sky and ground agree on where the world ends.
   */
  horizonY?: number;
  /** Strength of the sun bloom. */
  sunGlow?: number;
  /** Cloud-band contrast. Keep low — this is weather, not a feature. */
  bandStrength?: number;
}

const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Straight to clip space: this quad is the frame, not an object in the world.
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSun;
uniform vec2  uSunScreen;
uniform float uHorizonY;
uniform float uSunGlow;
uniform float uBandStrength;
uniform float uAspect;
uniform float uTime;
uniform vec3  uFade;
uniform vec3  uDeepUnit;

varying vec2 vUv;

${GLSL_NOISE}
${GLSL_RECEDE}

void main() {
  float y = vUv.y;
  float above = clamp((y - uHorizonY) / max(1.0 - uHorizonY, 1e-3), 0.0, 1.0);
  float below = clamp((uHorizonY - y) / max(uHorizonY, 1e-3), 0.0, 1.0);

  // Two grades meeting at the horizon. The exponents are asymmetric on purpose:
  // sky falls off slowly (big soft dome), earth falls off fast (haze eats it).
  vec3 col = y >= uHorizonY
    ? mix(uHorizon, uZenith, pow(above, 0.62))
    : mix(uHorizon, uGround, pow(below, 0.55));

  // Horizon glow — a thin bright band, the single strongest "there is a world
  // out there" cue in a still frame.
  //
  // Tightened from 26/0.28 to 44/0.17. The orchestrator puts uHorizonY at the
  // screen fraction where the ground plate vanishes, which on the shipping
  // camera is 0.94 — i.e. this band sits INSIDE the top-15% window that
  // 'fartop.mjs' measures, and at the old width it spread across most of it.
  // A horizon glow is a landscape-vista cue; at a 30-degree pitch over a
  // courtyard it is a thin line of town light, not a dawn.
  float band = exp(-abs(y - uHorizonY) * 44.0);
  col += uHorizon * band * 0.17;

  // Cloud banding. Stretched hard in x so it reads as strata, not as blobs, and
  // masked out near the horizon so it never fights the band.
  vec2 cp = vec2(vUv.x * 2.1 + uTime * 0.004, (y - uHorizonY) * 5.2 - uTime * 0.0015);
  float clouds = etFbm(cp, 4);
  clouds = smoothstep(0.42, 0.92, clouds);
  float cloudMask = smoothstep(0.02, 0.34, above) * (1.0 - smoothstep(0.55, 1.0, above));
  col = mix(col, mix(col, uHorizon, 0.55), clouds * cloudMask * uBandStrength);

  // Sun bloom, placed at the key light's screen position. Tight core, wide halo.
  vec2 d = (vUv - uSunScreen) * vec2(uAspect, 1.0);
  float r = length(d);
  col += uSun * (exp(-r * 7.5) * 0.85 + exp(-r * 1.9) * 0.22) * uSunGlow;

  // The upward recession, applied before the dither so the dither stays at full
  // amplitude in the darkened band — that is the whole reason it is last. A
  // graded region that has been pulled to a quarter of its value has a quarter
  // of its quantisation headroom too, and a flat plateau across the top of the
  // frame is the void by another name.
  //
  // The break runs on its own noise basis at a different scale from the cloud
  // banding above, so the two never line up into one visible feature. Wide in x,
  // because this is air over a town, and the eye reads horizontal strata as
  // depth and vertical ones as a curtain.
  float recBreak = 0.42 + 1.10 * etFbm(vec2(vUv.x * 2.2 - uTime * 0.002, y * 4.4) + 41.7, 4);
  col = etRecede(col, y, uFade, uDeepUnit, recBreak);

  // A very small amount of noise. An 8-bit display cannot resolve a smooth
  // gradient across 1080 rows and will band; the grain in post helps but the
  // sky is the one surface large enough to need its own dither.
  col += (etHash12(vUv * vec2(1927.0, 1081.0)) - 0.5) * 0.0022;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/**
 * The graded sky plate. Add it to the scene once; it never moves and never
 * needs resizing beyond the aspect uniform.
 */
export class Sky {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  constructor(palette: EnvironmentPalette, options: SkyOptions = {}) {
    this.material = new ShaderMaterial({
      name: 'env-sky',
      uniforms: {
        uZenith: { value: palette.zenith.clone() },
        uHorizon: { value: palette.horizon.clone() },
        uGround: { value: palette.ground.clone() },
        uSun: { value: palette.sun.clone() },
        uSunScreen: { value: new Vector2(0.5, 0.86) },
        uHorizonY: { value: options.horizonY ?? 0.62 },
        uSunGlow: { value: options.sunGlow ?? 0.16 },
        uBandStrength: { value: options.bandStrength ?? 0.42 },
        uAspect: { value: 16 / 9 },
        uTime: { value: 0 },
        uFade: { value: new Vector3(...DEFAULT_RECESSION) },
        uDeepUnit: { value: unitLuminance(palette.deep) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.name = 'env-sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10000;
    this.mesh.matrixAutoUpdate = false;
  }

  setPalette(palette: EnvironmentPalette): void {
    const u = this.material.uniforms;
    (u.uZenith!.value as Color).copy(palette.zenith);
    (u.uHorizon!.value as Color).copy(palette.horizon);
    (u.uGround!.value as Color).copy(palette.ground);
    (u.uSun!.value as Color).copy(palette.sun);
    unitLuminance(palette.deep, u.uDeepUnit!.value as Color);
  }

  /** '(startY, endY, floor)' screen fractions from the bottom. See {@link GLSL_RECEDE}. */
  setRecession(start: number, end: number, floor: number): void {
    (this.material.uniforms.uFade!.value as Vector3).set(start, end, floor);
  }

  /** Screen fraction, 0 = bottom of frame. */
  setHorizon(y: number): void {
    this.material.uniforms.uHorizonY!.value = y;
  }

  /** Screen fraction of the sun bloom centre. */
  setSunScreen(x: number, y: number): void {
    (this.material.uniforms.uSunScreen!.value as Vector2).set(x, y);
  }

  setAspect(aspect: number): void {
    this.material.uniforms.uAspect!.value = aspect;
  }

  setSunGlow(v: number): void {
    this.material.uniforms.uSunGlow!.value = v;
  }

  update(elapsed: number): void {
    this.material.uniforms.uTime!.value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
