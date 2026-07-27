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
  /** ASC-CDL power, per channel. 1 = neutral. */
  gamma: [number, number, number];
  /** S-curve strength around `pivot`, in log space. 0 = off. */
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
  /** Toe lift: raises the very bottom of the curve so blacks are milky, not crushed. */
  toe: number;
  /** Shoulder: compresses the top so highlights roll off instead of clipping. */
  shoulder: number;
}

export const NEUTRAL_GRADE: GradeParams = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  gain: [1, 1, 1],
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  contrast: 0,
  pivot: 0.42,
  saturation: 1,
  vibrance: 0,
  shadowTint: [1, 1, 1],
  midTint: [1, 1, 1],
  highlightTint: [1, 1, 1],
  crosstalk: 0,
  toe: 0,
  shoulder: 0,
};

export function grade(partial: Partial<GradeParams>): GradeParams {
  return { ...NEUTRAL_GRADE, ...partial };
}

/**
 * Per-map moods. These are deliberately gentle — the reference games grade for *readability*
 * first. Every one of these should survive an A/B against `neutral` without a viewer saying
 * "that one is doing too much".
 */
export const GRADE_PRESETS: Record<string, GradeParams> = {
  neutral: grade({ contrast: 0.08, saturation: 1.02, toe: 0.006 }),

  /** Open plains at midday. Warm key, cool shadows, gentle film contrast. */
  'ivalice-noon': grade({
    exposure: 0.05,
    temperature: 0.16,
    contrast: 0.18,
    pivot: 0.44,
    saturation: 1.06,
    vibrance: 0.1,
    shadowTint: [0.93, 0.97, 1.09],
    midTint: [1.02, 1.0, 0.98],
    highlightTint: [1.04, 1.01, 0.95],
    crosstalk: 0.05,
    toe: 0.008,
    shoulder: 0.12,
  }),

  /** Late-afternoon golden hour. The FFT battlefield default look. */
  'dusk-plains': grade({
    exposure: -0.05,
    temperature: 0.34,
    tint: 0.04,
    contrast: 0.22,
    pivot: 0.4,
    saturation: 1.04,
    vibrance: 0.14,
    gain: [1.05, 1.0, 0.95],
    shadowTint: [0.88, 0.94, 1.14],
    midTint: [1.04, 1.0, 0.95],
    highlightTint: [1.09, 1.02, 0.9],
    crosstalk: 0.08,
    toe: 0.012,
    shoulder: 0.18,
  }),

  /** Stone interiors lit by stained glass. Cool with warm practicals. */
  cathedral: grade({
    exposure: -0.12,
    temperature: -0.14,
    contrast: 0.26,
    pivot: 0.36,
    saturation: 0.95,
    vibrance: 0.16,
    lift: [0.008, 0.01, 0.018],
    shadowTint: [0.86, 0.92, 1.16],
    midTint: [0.98, 0.99, 1.04],
    highlightTint: [1.08, 1.03, 0.94],
    crosstalk: 0.1,
    toe: 0.016,
    shoulder: 0.16,
  }),

  /** Snowfield under a full moon. Desaturated, blue, high key with protected highlights. */
  'moonlit-snow': grade({
    exposure: -0.2,
    temperature: -0.36,
    tint: -0.04,
    contrast: 0.14,
    pivot: 0.46,
    saturation: 0.8,
    gain: [0.95, 0.99, 1.08],
    shadowTint: [0.84, 0.9, 1.2],
    midTint: [0.95, 0.98, 1.08],
    highlightTint: [1.0, 1.01, 1.04],
    crosstalk: 0.12,
    toe: 0.02,
    shoulder: 0.26,
  }),

  /** Volcanic. Hot core, crushed cyan shadows, strong shoulder so lava does not clip flat. */
  volcano: grade({
    exposure: -0.1,
    temperature: 0.44,
    contrast: 0.3,
    pivot: 0.34,
    saturation: 1.1,
    vibrance: 0.1,
    gain: [1.1, 0.98, 0.9],
    shadowTint: [0.8, 0.9, 1.05],
    midTint: [1.06, 0.98, 0.92],
    highlightTint: [1.12, 1.0, 0.86],
    crosstalk: 0.09,
    toe: 0.01,
    shoulder: 0.3,
  }),

  /** Marsh. Sickly green midtones, muddy blacks, low saturation in the highlights. */
  'swamp-fog': grade({
    exposure: -0.08,
    temperature: -0.06,
    tint: -0.14,
    contrast: 0.12,
    pivot: 0.42,
    saturation: 0.88,
    lift: [0.012, 0.018, 0.012],
    shadowTint: [0.9, 1.02, 0.94],
    midTint: [0.96, 1.04, 0.94],
    highlightTint: [1.0, 1.02, 0.97],
    crosstalk: 0.14,
    toe: 0.024,
    shoulder: 0.2,
  }),

  /** Night skirmish. Deep, cool, saturated only where torches are. */
  'night-battle': grade({
    exposure: -0.28,
    temperature: -0.3,
    contrast: 0.24,
    pivot: 0.32,
    saturation: 0.86,
    vibrance: 0.22,
    gain: [0.94, 0.97, 1.1],
    shadowTint: [0.8, 0.88, 1.22],
    midTint: [0.94, 0.97, 1.1],
    highlightTint: [1.06, 1.0, 0.95],
    crosstalk: 0.12,
    toe: 0.014,
    shoulder: 0.14,
  }),

  /** Underground / mines. Almost monochrome, lit by a single warm source. */
  underground: grade({
    exposure: -0.24,
    temperature: 0.1,
    contrast: 0.3,
    pivot: 0.3,
    saturation: 0.74,
    vibrance: 0.24,
    lift: [0.006, 0.006, 0.01],
    shadowTint: [0.9, 0.9, 1.02],
    midTint: [1.03, 0.99, 0.93],
    highlightTint: [1.1, 1.0, 0.85],
    crosstalk: 0.16,
    toe: 0.018,
    shoulder: 0.1,
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

  // Toe and shoulder. Applied last so they always own the extremes.
  const KNEE = 0.6;
  const shape = (v: number): number => {
    let o = clamp01(v);
    // Toe: raise the floor so blacks are film-black, not void-black.
    if (p.toe > 0) o = p.toe + (1 - p.toe) * o;
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

  return [shape(r), shape(g), shape(b)];
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
