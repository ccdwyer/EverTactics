/**
 * Procedural colour grading: author a grade as parameters, bake it to a 3D LUT.
 *
 * Why bake instead of evaluating the grade per-pixel? Because the grade then costs exactly
 * one trilinear 'texture()' fetch no matter how baroque it gets, it crossfades between two
 * moods for free (two LUTs + a mix), and it is the same artefact a colourist would hand us
 * as a .cube — so a real grade can be dropped in later without touching the shader.
 *
 * The grade chain runs in the display domain (sRGB-encoded), which is the standard .cube
 * convention, but the maths that wants to be linear (exposure, white balance, lift/gain)
 * is done in linear light after decoding.
 */

import {
  ClampToEdgeWrapping,
  Data3DTexture,
  LinearFilter,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

export interface GradeParams {
  /** Stops of exposure applied in linear light before anything else. */
  exposure: number;
  /** Kelvin-ish shift. Positive = warmer. Range roughly [-1, 1]. */
  temperature: number;
  /** Green <-> magenta. Positive = magenta. */
  tint: number;
  /** ASC-CDL slope, per channel. 1 = neutral. */
  gain: [number, number, number];
  /** ASC-CDL offset, per channel. 0 = neutral. Lifts the black point. */
  lift: [number, number, number];
  /** ASC-CDL power, per channel. 1 = neutral. >1 lifts midtones. */
  gamma: [number, number, number];
  /**
   * S-curve strength around 'pivot', in display space. 0 = off.
   *
   * 'pivot' matters more than it looks. The curve pushes everything above the pivot up and
   * everything below it down, so a pivot chosen for a well-exposed image (0.4-0.45) simply
   * crushes a dark one — measured on our own frame, a 0.44 pivot dropped median luminance
   * from 23/255 to 17/255 while the reference frames sit at 66-80. These presets therefore
   * pivot LOW, around the actual median of an HD-2D diorama, so the curve separates the
   * lit surfaces upward instead of dragging the whole frame into the floor.
   */
  contrast: number;
  pivot: number;
  /** Global saturation. 1 = neutral. */
  saturation: number;
  /** Extra saturation applied only to already-colourful pixels (vibrance). */
  vibrance: number;
  /** Colour pushed into the shadows / midtones / highlights. Multiplicative, 1 = neutral. */
  shadowTint: [number, number, number];
  midTint: [number, number, number];
  highlightTint: [number, number, number];
  /**
   * A FOURTH tonal family, keyed much tighter than 'shadowTint' — only the bottom of the
   * shadow range reaches it.
   *
   * Round-3 critics, repeatedly: "a two-hue lockup (navy + amber) with nothing between",
   * "shadows are pure blue with no colour separation", "LEFT holds deep near-black with a
   * reddish bounce ... three distinguishable value families". Three luminance bands can only
   * ever produce a three-hue image and, with 'midTint' near neutral, in practice a two-hue
   * one. Splitting the shadow end lets the upper shadows stay teal-blue while the deepest
   * values go somewhere else entirely — violet on a night map, warm brown on a torchlit one —
   * which is the tertiary hue the notes keep asking for.
   */
  deepShadowTint: [number, number, number];
  /**
   * Hue-vs-saturation secondary: multipliers at six anchors around the wheel, in the order
   * R, Y, G, C, B, M, interpolated smoothly between them.
   *
   * This is the only tool in the chain that can act on hue rather than on luminance, and it
   * is what stops material identity dissolving — "skin, foliage, cloth and stone all resolve
   * to the same two chroma values ... the grass on the tile tops and the moss on the wall are
   * indistinguishable". Pushing green and red up while holding the amber/navy axis flat keeps
   * foliage and banners as their own hues inside a committed warm/cool grade.
   */
  hueSat: [number, number, number, number, number, number];
  /** Hue-vs-hue secondary: rotation in DEGREES at the same six anchors. */
  hueRotate: [number, number, number, number, number, number];
  /**
   * Channel crosstalk, 0..1. Film stocks are not channel-independent: some red leaks into
   * green and blue. A little of this is the single biggest "this was graded" cue.
   */
  crosstalk: number;
  /**
   * Black crush, in display-domain code values. Everything below this is clipped and the
   * remaining range is stretched back out. This is what makes shadows read as *black*
   * rather than as dark grey — VISUAL_TARGET.md lists neutral grey as a fail condition and
   * both reference games clip their shadows hard.
   */
  crush: number;
  /**
   * The colour the crushed blacks actually land on, display domain. Never leave this
   * neutral: "blacks are blue, not neutral" is the single most repeated note in
   * VISUAL_TARGET.md's colour section. Triangle sits around [0.02, 0.03, 0.07];
   * FFT's night frames sit around [0.05, 0.03, 0.02].
   */
  blackPoint: [number, number, number];
  /** Shoulder: compresses the top so highlights roll off instead of clipping. */
  shoulder: number;
  /**
   * Colour the very top of the curve is pulled toward, display domain. Both references
   * push highlights warm — a pure white highlight next to a graded midtone is the other
   * half of the "this was never graded" tell.
   */
  highlightPoint: [number, number, number];
  /** How far highlights travel toward 'highlightPoint'. 0 = off. */
  highlightPull: number;
}

export const NEUTRAL_GRADE: GradeParams = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  gain: [1, 1, 1],
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  contrast: 0,
  pivot: 0.24,
  saturation: 1,
  vibrance: 0,
  shadowTint: [1, 1, 1],
  midTint: [1, 1, 1],
  highlightTint: [1, 1, 1],
  deepShadowTint: [1, 1, 1],
  hueSat: [1, 1, 1, 1, 1, 1],
  hueRotate: [0, 0, 0, 0, 0, 0],
  crosstalk: 0,
  crush: 0,
  blackPoint: [0, 0, 0],
  shoulder: 0,
  highlightPoint: [1, 1, 1],
  highlightPull: 0,
};

export function grade(partial: Partial<GradeParams>): GradeParams {
  return { ...NEUTRAL_GRADE, ...partial };
}

/**
 * Per-map moods.
 *
 * These used to be deliberately gentle. That was the wrong call and the reference frames say
 * so: 'refs/curated/triangle/official_005_steam.jpg' is amber highlights against near-black
 * warm shadows with no neutral value anywhere in it, and 'official_019_se_screenshot.jpg'
 * runs cream highlights against a deep blue-teal floor. Both are graded far past "tasteful".
 * VISUAL_TARGET.md is explicit: "Neither uses neutral greys. Crush blacks toward the map's
 * cool tone and push highlights warm."
 *
 * So every preset here now commits: real contrast, a crushed and *tinted* black point, and a
 * warm highlight point. The test is not "would a viewer say this is doing too much" — it is
 * "can a critic pick our frame out of a Triangle Strategy pair".
 */
export const GRADE_PRESETS: Record<string, GradeParams> = {
  neutral: grade({ contrast: 0.08, saturation: 1.02 }),

  /**
   * Open plains and sunlit stone. Warm key against genuinely cool shadow.
   *
   * Round 2 note: this preset used to carry 'temperature: 0.2', a global warm white-balance
   * shift, on top of a lighting rig that is already a warm key. Rendered, the result was a
   * single amber wash — the critics' "no warm/cool separation, everything one temperature".
   * A grade cannot make a split by pushing the whole image one way; it makes one by pushing
   * the ENDS apart. So the global temperature is near neutral now and the work is done by
   * 'shadowTint' (hard toward blue-teal) against 'highlightTint' / 'highlightPoint' (hard
   * toward gold), which is what both reference frames measure as.
   */
  'ivalice-noon': grade({
    exposure: 0.03,
    temperature: 0.03,
    gamma: [1.2, 1.2, 1.2],
    contrast: 0.34,
    pivot: 0.26,
    saturation: 1.06,
    // Vibrance rather than saturation: it lifts the *unsaturated* stone and grass toward
    // colour without pushing the already-saturated sprite primaries further out.
    vibrance: 0.22,
    gain: [1.0, 1.0, 1.02],
    // ART-DIRECTION PASS — the shell was the wrong temperature, measured.
    //
    // 'tools/zones.mjs' over five curated frames: EVERY zone of EVERY reference is
    // warm-positive (mean red − blue), typically +15 to +30 in the corners and the far
    // band, and that holds even for 'official_003_steam.jpg', the coolest blue-grey
    // stone frame in the corpus, which measures +18.5 / +24.1 / +16.7 in the corners
    // and far band while its LIT CENTRE is the one cool zone at −4.1.
    //
    // Ours ran the opposite way round: centre +12.9, cornerTL −4.2, farBand −8.0 —
    // a warm diorama inside a cold shell. That is the single largest reason the frame
    // read as several systems rather than one picture: the board, the surround and the
    // sky were each individually defensible and belonged to different times of day.
    //
    // Both of the terms that produced it lived here. A shadowTint of [0.62,0.80,1.34]
    // is a hard blue-negative push over the whole lower two thirds of the range, and
    // the vast majority of this frame IS the lower two thirds. It is kept cool-relative
    // — 1.08 blue against 1.02 red still separates a shadow from a highlight — but it no
    // longer drags every unlit pixel across the neutral line into negative warmth.
    //
    // The warm/cool SPLIT is not lost by this: it moves to where it belongs, which is
    // the lighting rig (warm brazier key against cool sky fill) and the highlight end
    // below. A grade that manufactures the split by pushing the shadows blue applies it
    // to the sky, the surround, the near field and the UI backdrop equally, none of
    // which are lit by anything.
    shadowTint: [1.02, 0.97, 1.08],
    midTint: [1.02, 0.99, 1.0],
    highlightTint: [1.16, 1.04, 0.84],
    // The deepest family keeps a distinct identity from the shadow family above it —
    // that was the round-3 fix and it is still right — but it turns toward warm ember
    // rather than violet. A torch-lit courtyard's darkest corners are full of bounced
    // firelight; a violet floor is a moonlit assumption imposed on an amber scene.
    deepShadowTint: [1.34, 1.0, 0.86],
    // Hue secondary, anchors R Y G C B M. The scene's own light rig supplies the amber/navy
    // axis; this exists to keep everything that is NOT on that axis from collapsing into it.
    // Green hard up (garden, moss in the mortar), red up (the banner is the only saturated
    // object in frame and it should stay that way), blue DOWN — the navy was the dominant
    // chroma and pulling it back is what lets the tertiaries be seen at all.
    // ART-DIRECTION PASS — cyan and blue come down hard (C 1.18 -> 0.80,
    // B 0.86 -> 0.62). At 6x magnification the board's shadow side is not a dark
    // stone colour, it is near-black carrying saturated cyan SPECKLE: individual
    // pixels of high-chroma blue-green scattered through a black mass. That is
    // chroma noise reading as a material, and it is the last hue island left in
    // the frame now that the shell is warm — it makes the board look like it
    // belongs to a different scene from everything around it.
    //
    // The tertiaries this table exists to protect (green for moss and garden, red
    // for the banner) are untouched, so the "two-hue lockup" it was written
    // against does not come back; what goes is only the cool primary that the
    // lighting rig is already supplying in quantity.
    hueSat: [1.3, 1.02, 1.42, 0.8, 0.62, 1.14],
    // Negative rotation runs backwards around R->Y->G->C->B->M. Blues go toward cyan so the
    // shade reads blue-GREEN rather than the flat navy the critics measured; greens go
    // toward yellow so foliage is olive rather than emerald; magentas go toward violet so
    // the deep-shadow family lands somewhere the rest of the frame never visits.
    hueRotate: [4, -4, -8, -6, -11, 6],
    crosstalk: 0.08,
    // ROUND 4, three separate notes: "the blacks are lifted into a flat purple and the
    // midtones are compressed into a narrow band", "the blacks are lifted into blue so there
    // is no true anchor point", "let true blacks reach black (stop lifting shadows into
    // navy)". Measured on 'refs/curated/triangle/official_005_steam.jpg', the darkest
    // sixteenth of that frame sits at code 6-14 with a warm cast; ours sat at 17-22 blue
    // (0.064 * 255 = 16 before the vignette painted more on top).
    //
    // So: crush harder, and land what survives on a black point a third as bright. The hue
    // is kept — a neutral black is a listed fail condition — but at this level it reads as
    // "cold black" rather than as the flat violet plate the critics measured.
    // Same measurement as 'shadowTint' above. The round-4 note that motivated this
    // block quoted 'official_005_steam.jpg' as "code 6-14 with a WARM CAST" and then
    // landed the black point on [0.009, 0.014, 0.036] — a 4:1 blue-over-red ratio,
    // i.e. the cast is cool. The magnitude was measured and right; the hue was not
    // checked against the same file. Kept at the same luminance, turned warm.
    crush: 0.055,
    blackPoint: [0.032, 0.021, 0.020],
    // Raised from 0.18. "The highlights near the fire clip straight to white with no filmic
    // shoulder" — at 0.18 the curve still reached 1.0 with slope well above zero, so the
    // brazier core hit a flat plate. 0.32 rolls the top of the range off, which is what keeps
    // a readable flame core inside the bloom rather than a white disc.
    shoulder: 0.32,
    highlightPoint: [1.0, 0.965, 0.86],
    highlightPull: 0.45,
  }),

  /** Late-afternoon golden hour. The FFT battlefield default look. */
  'dusk-plains': grade({
    exposure: -0.04,
    temperature: 0.42,
    tint: 0.05,
    gamma: [1.22, 1.22, 1.22],
    contrast: 0.36,
    pivot: 0.22,
    saturation: 1.1,
    vibrance: 0.2,
    gain: [1.07, 1.0, 0.93],
    shadowTint: [0.8, 0.9, 1.24],
    midTint: [1.06, 1.0, 0.92],
    highlightTint: [1.12, 1.02, 0.85],
    crosstalk: 0.09,
    crush: 0.05,
    blackPoint: [0.03, 0.026, 0.052],
    shoulder: 0.22,
    highlightPoint: [1.0, 0.95, 0.82],
    highlightPull: 0.5,
  }),

  /**
   * Stone interiors lit by stained glass — the 'battle-open' look.
   *
   * Modelled on official_019: a cold blue-teal floor with warm practicals cutting through
   * it. The blue is carried by the black point, not by desaturating everything, so the
   * warm side of the split survives.
   */
  cathedral: grade({
    exposure: -0.08,
    temperature: -0.1,
    gamma: [1.26, 1.26, 1.26],
    contrast: 0.4,
    pivot: 0.20,
    saturation: 1.04,
    vibrance: 0.24,
    gain: [1.0, 1.0, 1.04],
    shadowTint: [0.72, 0.86, 1.3],
    midTint: [0.98, 0.99, 1.08],
    highlightTint: [1.16, 1.04, 0.86],
    crosstalk: 0.1,
    crush: 0.06,
    blackPoint: [0.016, 0.028, 0.062],
    shoulder: 0.2,
    highlightPoint: [1.0, 0.96, 0.85],
    highlightPull: 0.55,
  }),

  /** Snowfield under a full moon. Desaturated, blue, high key with protected highlights. */
  'moonlit-snow': grade({
    exposure: -0.18,
    temperature: -0.4,
    tint: -0.04,
    gamma: [1.18, 1.18, 1.18],
    contrast: 0.24,
    pivot: 0.26,
    saturation: 0.86,
    vibrance: 0.12,
    gain: [0.94, 0.99, 1.1],
    shadowTint: [0.78, 0.88, 1.28],
    midTint: [0.94, 0.98, 1.1],
    highlightTint: [1.02, 1.02, 1.04],
    crosstalk: 0.12,
    crush: 0.03,
    blackPoint: [0.02, 0.034, 0.072],
    shoulder: 0.3,
    highlightPoint: [1.0, 0.99, 0.96],
    highlightPull: 0.25,
  }),

  /** Volcanic. Hot core, crushed cyan shadows, strong shoulder so lava does not clip flat. */
  volcano: grade({
    exposure: -0.08,
    temperature: 0.5,
    gamma: [1.22, 1.22, 1.22],
    contrast: 0.44,
    pivot: 0.20,
    saturation: 1.18,
    vibrance: 0.14,
    gain: [1.12, 0.98, 0.88],
    shadowTint: [0.7, 0.86, 1.12],
    midTint: [1.08, 0.97, 0.9],
    highlightTint: [1.18, 1.0, 0.8],
    crosstalk: 0.09,
    crush: 0.06,
    blackPoint: [0.045, 0.022, 0.03],
    shoulder: 0.34,
    highlightPoint: [1.0, 0.92, 0.74],
    highlightPull: 0.6,
  }),

  /** Marsh. Sickly green midtones, muddy blacks, low saturation in the highlights. */
  'swamp-fog': grade({
    exposure: -0.06,
    temperature: -0.04,
    tint: -0.18,
    gamma: [1.2, 1.2, 1.2],
    contrast: 0.26,
    pivot: 0.24,
    saturation: 0.94,
    vibrance: 0.1,
    shadowTint: [0.84, 1.04, 0.92],
    midTint: [0.94, 1.06, 0.92],
    highlightTint: [1.02, 1.04, 0.94],
    crosstalk: 0.14,
    crush: 0.04,
    blackPoint: [0.022, 0.036, 0.03],
    shoulder: 0.24,
    highlightPoint: [1.0, 0.99, 0.88],
    highlightPull: 0.35,
  }),

  /** Night skirmish. Deep, cool, saturated only where torches are. */
  'night-battle': grade({
    exposure: -0.24,
    temperature: -0.34,
    gamma: [1.26, 1.26, 1.26],
    contrast: 0.42,
    pivot: 0.18,
    saturation: 0.94,
    vibrance: 0.3,
    gain: [0.92, 0.96, 1.14],
    shadowTint: [0.66, 0.82, 1.36],
    midTint: [0.92, 0.96, 1.14],
    highlightTint: [1.14, 1.0, 0.88],
    deepShadowTint: [1.24, 0.9, 1.08],
    hueSat: [1.24, 1.0, 1.34, 1.2, 0.88, 1.12],
    hueRotate: [4, -4, -8, -6, -12, 6],
    crosstalk: 0.12,
    crush: 0.07,
    blackPoint: [0.012, 0.022, 0.058],
    shoulder: 0.18,
    highlightPoint: [1.0, 0.94, 0.8],
    highlightPull: 0.6,
  }),

  /** Underground / mines. Almost monochrome, lit by a single warm source. */
  underground: grade({
    exposure: -0.2,
    temperature: 0.14,
    gamma: [1.26, 1.26, 1.26],
    contrast: 0.44,
    pivot: 0.18,
    saturation: 0.82,
    vibrance: 0.3,
    shadowTint: [0.84, 0.88, 1.1],
    midTint: [1.04, 0.98, 0.9],
    highlightTint: [1.16, 1.0, 0.8],
    crosstalk: 0.16,
    crush: 0.065,
    blackPoint: [0.034, 0.026, 0.024],
    shoulder: 0.14,
    highlightPoint: [1.0, 0.93, 0.76],
    highlightPull: 0.6,
  }),
};

export const LUT_SIZE = 33;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = Math.max(c, 0);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smooth, monotone weighting of shadows / mids / highlights by luminance. */
function toneMasks(l: number): [number, number, number] {
  const shadow = Math.pow(1 - clamp01(l), 2.2);
  const highlight = Math.pow(clamp01(l), 2.2);
  const mid = Math.max(0, 1 - shadow - highlight);
  return [shadow, mid, highlight];
}

/**
 * Weight of the fourth, deepest tonal family. Much tighter than 'toneMasks''s shadow term
 * (exponent 6 vs 2.2), so it lives entirely underneath it rather than fighting it: at
 * l = 0.5 the shadow mask is 0.22 and this is 0.016.
 */
function deepShadowMask(l: number): number {
  return Math.pow(1 - clamp01(l), 6.0);
}

/**
 * Sample a six-anchor colour wheel (R, Y, G, C, B, M) at hue 'h' ∈ [0,1).
 *
 * Smoothstep between anchors rather than linear: a linear ramp puts a visible crease at each
 * anchor once the table is baked into a 33³ LUT and then trilinearly filtered.
 */
function sampleWheel(table: readonly number[], h: number): number {
  const t = (h - Math.floor(h)) * 6;
  const i = Math.floor(t) % 6;
  const f = t - Math.floor(t);
  const a = table[i] ?? 1;
  const b = table[(i + 1) % 6] ?? 1;
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** RGB -> HSL. 'h' in [0,1), 's'/'l' in [0,1]. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) * 0.5;
  const d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / Math.max(2 - max - min, 1e-6) : d / Math.max(max + min, 1e-6);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hueToRgb(p: number, q: number, t: number): number {
  let u = t;
  if (u < 0) u += 1;
  if (u > 1) u -= 1;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}

/** HSL -> RGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

/**
 * Hue-selective secondary. Rotates and re-saturates by hue, leaving luminance alone.
 *
 * Guarded by saturation so it cannot introduce colour into near-neutral pixels — a hue
 * multiplier applied to a grey pixel would amplify whatever rounding noise it happens to
 * carry, which bakes into the LUT as blotching.
 */
function hueSecondary(
  p: GradeParams,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s < 1e-3) return [r, g, b];

  const rot = sampleWheel(p.hueRotate, h) / 360;
  const satMul = sampleWheel(p.hueSat, h);
  // Ramp the effect in over the first few percent of saturation.
  const guard = Math.min(1, s * 8);
  const h2 = h + rot * guard;
  const s2 = clamp01(s * (1 + (satMul - 1) * guard));
  return hslToRgb(h2 - Math.floor(h2), s2, l);
}

/** White balance as a linear-light RGB gain. Approximates a Kelvin shift well enough. */
function whiteBalanceGain(temperature: number, tint: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, temperature));
  const g = Math.max(-1, Math.min(1, tint));
  return [1 + 0.22 * t + 0.06 * g, 1 - 0.05 * t - 0.14 * g, 1 - 0.24 * t + 0.06 * g];
}

/** Apply the full grade to one sRGB-domain triplet. Returns an sRGB-domain triplet. */
export function applyGrade(p: GradeParams, rIn: number, gIn: number, bIn: number): [number, number, number] {
  // --- linear-light section -------------------------------------------------
  let r = srgbToLinear(rIn);
  let g = srgbToLinear(gIn);
  let b = srgbToLinear(bIn);

  const ev = Math.pow(2, p.exposure);
  r *= ev;
  g *= ev;
  b *= ev;

  const wb = whiteBalanceGain(p.temperature, p.tint);
  r *= wb[0];
  g *= wb[1];
  b *= wb[2];

  // ASC CDL: out = (in * slope + offset) ^ power
  r = Math.max(0, r * p.gain[0] + p.lift[0]);
  g = Math.max(0, g * p.gain[1] + p.lift[1]);
  b = Math.max(0, b * p.gain[2] + p.lift[2]);
  r = Math.pow(r, 1 / Math.max(p.gamma[0], 1e-3));
  g = Math.pow(g, 1 / Math.max(p.gamma[1], 1e-3));
  b = Math.pow(b, 1 / Math.max(p.gamma[2], 1e-3));

  // --- display-domain section ----------------------------------------------
  r = linearToSrgb(r);
  g = linearToSrgb(g);
  b = linearToSrgb(b);

  // Log-space S-curve. Contrast in display space around a pivot is what a film print does.
  if (p.contrast !== 0) {
    const pivot = Math.max(p.pivot, 1e-3);
    const c = 1 + p.contrast;
    r = clamp01(Math.pow(Math.max(r, 1e-5) / pivot, c) * pivot);
    g = clamp01(Math.pow(Math.max(g, 1e-5) / pivot, c) * pivot);
    b = clamp01(Math.pow(Math.max(b, 1e-5) / pivot, c) * pivot);
  }

  // Tonal tinting. Four families: deep shadow, shadow, mid, highlight.
  let l = r * LUMA_R + g * LUMA_G + b * LUMA_B;
  const [ms, mm, mh] = toneMasks(l);
  const rest = 1 - ms - mm - mh;
  const tr = p.shadowTint[0] * ms + p.midTint[0] * mm + p.highlightTint[0] * mh + rest;
  const tg = p.shadowTint[1] * ms + p.midTint[1] * mm + p.highlightTint[1] * mh + rest;
  const tb = p.shadowTint[2] * ms + p.midTint[2] * mm + p.highlightTint[2] * mh + rest;
  // The deep family multiplies on TOP of the shadow tint rather than competing for the same
  // mask budget, so it reads as a second hue underneath the first instead of diluting it.
  const md = deepShadowMask(l);
  r = clamp01(r * tr * (1 + (p.deepShadowTint[0] - 1) * md));
  g = clamp01(g * tg * (1 + (p.deepShadowTint[1] - 1) * md));
  b = clamp01(b * tb * (1 + (p.deepShadowTint[2] - 1) * md));

  // Channel crosstalk.
  if (p.crosstalk > 0) {
    const k = p.crosstalk;
    const nr = r * (1 - k) + (g * 0.6 + b * 0.4) * k;
    const ng = g * (1 - k) + (r * 0.5 + b * 0.5) * k;
    const nb = b * (1 - k) + (r * 0.35 + g * 0.65) * k;
    r = nr;
    g = ng;
    b = nb;
  }

  // Saturation + vibrance.
  l = r * LUMA_R + g * LUMA_G + b * LUMA_B;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const chroma = maxc - minc;
  const sat = p.saturation + p.vibrance * (1 - Math.min(chroma * 2, 1));
  r = l + (r - l) * sat;
  g = l + (g - l) * sat;
  b = l + (b - l) * sat;

  // Hue-selective secondary. Runs after crosstalk and global saturation, both of which pull
  // every hue toward the same two chroma values; this is what puts the tertiaries back.
  [r, g, b] = hueSecondary(p, clamp01(r), clamp01(g), clamp01(b));

  // Crush and shoulder. Applied last so they always own the extremes.
  const KNEE = 0.6;
  const shape = (v: number): number => {
    let o = clamp01(v);
    // Crush: clip the bottom of the range and rescale. Shadows become genuinely black
    // instead of dark grey, which is what lets the tinted black point below be seen at all.
    if (p.crush > 0) o = clamp01((o - p.crush) / Math.max(1 - p.crush, 1e-3));
    // Shoulder: above the knee, a monotone rational curve whose slope falls below 1 as it
    // approaches white. Highlights roll off instead of clipping to a flat plate.
    if (p.shoulder > 0 && o > KNEE) {
      const s = p.shoulder;
      const u = (o - KNEE) / (1 - KNEE);
      const c = (u * (1 + s)) / (1 + s * u);
      o = KNEE + (1 - KNEE) * c;
    }
    return clamp01(o);
  };

  r = shape(r);
  g = shape(g);
  b = shape(b);

  // Tinted black and white points. The curve now runs blackPoint -> highlightPoint rather
  // than 0 -> 1, so there is no neutral value anywhere in the output range.
  const l2 = r * LUMA_R + g * LUMA_G + b * LUMA_B;
  const hw = p.highlightPull * Math.pow(clamp01(l2), 2.0);
  const place = (v: number, bp: number, hp: number): number => {
    const lifted = bp + (1 - bp) * v;
    // Highlights slide toward highlightPoint, weighted by luminance so midtones are untouched.
    return clamp01(lifted * (1 - hw) + lifted * hp * hw);
  };

  return [
    place(r, p.blackPoint[0], p.highlightPoint[0]),
    place(g, p.blackPoint[1], p.highlightPoint[1]),
    place(b, p.blackPoint[2], p.highlightPoint[2]),
  ];
}

/** Bake a grade into a trilinear-filtered 3D LUT texture. */
export function bakeGradeLUT(params: GradeParams, size: number = LUT_SIZE): Data3DTexture {
  const n = size;
  const data = new Uint8Array(n * n * n * 4);
  const inv = 1 / (n - 1);

  let i = 0;
  for (let z = 0; z < n; z++) {
    const bIn = z * inv;
    for (let y = 0; y < n; y++) {
      const gIn = y * inv;
      for (let x = 0; x < n; x++) {
        const rIn = x * inv;
        const [r, g, b] = applyGrade(params, rIn, gIn, bIn);
        data[i++] = Math.round(clamp01(r) * 255);
        data[i++] = Math.round(clamp01(g) * 255);
        data[i++] = Math.round(clamp01(b) * 255);
        data[i++] = 255;
      }
    }
  }

  const tex = new Data3DTexture(data, n, n, n);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.wrapR = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Name of every grade the PostStack can be asked for. */
export type GradeName = keyof typeof GRADE_PRESETS | (string & {});
