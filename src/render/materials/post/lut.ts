/**
 * Procedural colour grading: author a grade as parameters, bake it to a 3D LUT.
 *
 * Why bake instead of evaluating the grade per-pixel? Because the grade then costs exactly
 * one trilinear `texture()` fetch no matter how baroque it gets, it crossfades between two
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
   * S-curve strength around `pivot`, in display space. 0 = off.
   *
   * `pivot` matters more than it looks. The curve pushes everything above the pivot up and
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
  /** How far highlights travel toward `highlightPoint`. 0 = off. */
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
 * so: `refs/curated/triangle/official_005_steam.jpg` is amber highlights against near-black
 * warm shadows with no neutral value anywhere in it, and `official_019_se_screenshot.jpg`
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

  /** Open plains at midday. Warm key, cool shadows, gentle film contrast. */
  'ivalice-noon': grade({
    exposure: 0.04,
    temperature: 0.2,
    gamma: [1.2, 1.2, 1.2],
    contrast: 0.3,
    pivot: 0.24,
    saturation: 1.12,
    vibrance: 0.14,
    shadowTint: [0.86, 0.95, 1.18],
    midTint: [1.03, 1.0, 0.96],
    highlightTint: [1.07, 1.02, 0.92],
    crosstalk: 0.06,
    crush: 0.035,
    blackPoint: [0.018, 0.028, 0.056],
    shoulder: 0.16,
    highlightPoint: [1.0, 0.98, 0.9],
    highlightPull: 0.3,
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
   * Stone interiors lit by stained glass — the `battle-open` look.
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

  // Tonal tinting.
  let l = r * LUMA_R + g * LUMA_G + b * LUMA_B;
  const [ms, mm, mh] = toneMasks(l);
  const tr = p.shadowTint[0] * ms + p.midTint[0] * mm + p.highlightTint[0] * mh + (1 - ms - mm - mh);
  const tg = p.shadowTint[1] * ms + p.midTint[1] * mm + p.highlightTint[1] * mh + (1 - ms - mm - mh);
  const tb = p.shadowTint[2] * ms + p.midTint[2] * mm + p.highlightTint[2] * mh + (1 - ms - mm - mh);
  r = clamp01(r * tr);
  g = clamp01(g * tg);
  b = clamp01(b * tb);

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
