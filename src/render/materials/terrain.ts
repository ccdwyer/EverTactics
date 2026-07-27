/**
 * EverTactics — procedural terrain materials.
 *
 * Every surface in the diorama is authored here from noise rather than shipped as a flat
 * colour or a stock texture. Each surface kind produces a tileable albedo / normal /
 * roughness triple (plus an emissive map for lava), and the resulting MeshStandardMaterial
 * is patched to:
 *
 *   - multiply the baked per-vertex ambient occlusion (`aAO`) into the albedo,
 *   - apply low-frequency world-space macro variation so a 20x20 map does not read as one
 *     texture stamped 400 times,
 *   - deepen crevice contact darkening slightly toward a cool shadow tint rather than
 *     plain black, which is what makes the crevices read as sculpted rather than dirty.
 *
 * UVs are baked per-face in `render/terrain.ts` using a world-space planar projection along
 * the face's dominant axis, so side faces never smear.
 */

import * as THREE from 'three';
import type { SurfaceKind } from '@core/types';

/** Surface kinds plus the two internal materials the terrain builder needs. */
export type TerrainMaterialKind = SurfaceKind | 'cliff' | 'bed';

/** World units of terrain covered by one repeat of a surface texture. */
export const TEXTURE_WORLD_SCALE = 2;

const TEX_SIZE = 256;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic noise
// ─────────────────────────────────────────────────────────────────────────────

function hash2(xi: number, yi: number, seed: number): number {
  let h = Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function wrap(a: number, p: number): number {
  return ((a % p) + p) % p;
}

/** Tileable value noise with integer period `period`. */
function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = wrap(xi, period);
  const y0 = wrap(yi, period);
  const x1 = wrap(xi + 1, period);
  const y1 = wrap(yi + 1, period);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/** Tileable fBm. `period` is the lattice period at the base octave. */
function fbm(x: number, y: number, period: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, period * f, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Tileable ridged noise — good for cracks and veins. */
function ridge(x: number, y: number, period: number, seed: number, octaves = 3): number {
  return 1 - Math.abs(fbm(x, y, period, seed, octaves) * 2 - 1);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Texel authoring
// ─────────────────────────────────────────────────────────────────────────────

interface Texel {
  /** Linear-ish albedo, 0..1. */
  r: number;
  g: number;
  b: number;
  /** Height for normal-map derivation, 0..1. */
  h: number;
  /** Roughness, 0..1. */
  rough: number;
  /** Emissive intensity, 0..1 (lava). */
  e?: number;
  er?: number;
  eg?: number;
  eb?: number;
}

type TexelFn = (u: number, v: number) => Texel;

/* -- grass ----------------------------------------------------------------- */
const grassTexel: TexelFn = (u, v) => {
  // Clumping is deliberately mid-frequency and low-contrast: at 2 world units per
  // repeat, anything blobbier reads as a tiling pattern the moment two tiles sit
  // side by side.
  const clump = fbm(u * 11, v * 11, 11, 11, 4);
  const blade = fbm(u * 40, v * 112, 40, 23, 2);
  const fine = fbm(u * 96, v * 96, 96, 31, 2);
  const dry = smoothstep(0.62, 0.88, fbm(u * 4, v * 4, 4, 47, 3));

  const t = clamp01(clump * 0.42 + blade * 0.36 + fine * 0.22);
  let r = lerp(0.130, 0.290, t);
  let g = lerp(0.214, 0.428, t);
  let b = lerp(0.086, 0.150, t);
  r = lerp(r, 0.415, dry * 0.4);
  g = lerp(g, 0.400, dry * 0.4);
  b = lerp(b, 0.196, dry * 0.4);
  const bare = smoothstep(0.26, 0.10, clump);
  r = lerp(r, 0.20, bare * 0.35);
  g = lerp(g, 0.168, bare * 0.35);
  b = lerp(b, 0.108, bare * 0.35);

  return {
    r,
    g,
    b,
    h: clump * 0.35 + blade * 0.45 + fine * 0.2,
    rough: 0.86 + fine * 0.1,
  };
};

/* -- dirt ------------------------------------------------------------------ */
const dirtTexel: TexelFn = (u, v) => {
  const coarse = fbm(u * 7, v * 7, 7, 61, 4);
  const grit = fbm(u * 64, v * 64, 64, 71, 2);
  // pebbles on a jittered lattice
  const cell = 18;
  const cx = Math.floor(u * cell);
  const cy = Math.floor(v * cell);
  let pebble = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = wrap(cx + ox, cell);
      const gy = wrap(cy + oy, cell);
      const jx = (cx + ox + hash2(gx, gy, 3)) / cell;
      const jy = (cy + oy + hash2(gx, gy, 4)) / cell;
      const rad = (0.1 + hash2(gx, gy, 5) * 0.24) / cell;
      const d = Math.hypot(u - jx, v - jy);
      pebble = Math.max(pebble, smoothstep(rad, rad * 0.35, d) * (0.35 + hash2(gx, gy, 6) * 0.65));
    }
  }

  const t = clamp01(coarse * 0.7 + grit * 0.3);
  let r = lerp(0.135, 0.352, t);
  let g = lerp(0.096, 0.256, t);
  let b = lerp(0.066, 0.166, t);
  const pg = 0.38 + hash2(cx, cy, 9) * 0.18;
  r = lerp(r, pg, pebble * 0.75);
  g = lerp(g, pg * 0.94, pebble * 0.75);
  b = lerp(b, pg * 0.86, pebble * 0.75);

  return {
    r,
    g,
    b,
    h: coarse * 0.5 + grit * 0.2 + pebble * 0.3,
    rough: 0.92 - pebble * 0.18,
  };
};

/* -- stone ----------------------------------------------------------------- */
const stoneTexel: TexelFn = (u, v) => {
  const rows = 4;
  const cols = 4;
  const row = Math.floor(v * rows);
  const offset = (row % 2) * 0.5;
  const uu = wrap(u + offset, 1);
  const col = Math.floor(uu * cols);

  const fu = uu * cols - col;
  const fv = v * rows - row;
  // jitter each slab edge a little so it is not a perfect grid
  const jx = (hash2(col, row, 12) - 0.5) * 0.06;
  const jy = (hash2(col, row, 13) - 0.5) * 0.06;
  const edge = Math.min(
    Math.min(fu - 0.03 + jx, 1 - fu - 0.03 + jx),
    Math.min(fv - 0.05 + jy, 1 - fv - 0.05 + jy),
  );
  const mortar = 1 - smoothstep(0.0, 0.045, edge);

  const tone = hash2(col, row, 14);
  const grain = fbm(u * 40, v * 40, 40, 17, 3);
  const vein = ridge(u * 9, v * 9, 9, 19, 3);
  const speck = fbm(u * 128, v * 128, 128, 21, 1);

  const t = clamp01(0.42 + (tone - 0.5) * 0.42 + (grain - 0.5) * 0.24 + (speck - 0.5) * 0.1);
  let r = lerp(0.19, 0.62, t);
  let g = lerp(0.185, 0.605, t);
  let b = lerp(0.178, 0.575, t);
  // pale calcite veins
  const vm = smoothstep(0.82, 0.98, vein) * 0.4;
  r = lerp(r, 0.7, vm);
  g = lerp(g, 0.69, vm);
  b = lerp(b, 0.66, vm);
  // grime settles in the joints
  const grime = mortar * (0.55 + fbm(u * 22, v * 22, 22, 27, 2) * 0.45);
  r = lerp(r, 0.085, grime * 0.86);
  g = lerp(g, 0.082, grime * 0.86);
  b = lerp(b, 0.072, grime * 0.86);

  return {
    r,
    g,
    b,
    h: (1 - mortar) * (0.55 + grain * 0.35) + speck * 0.06,
    rough: 0.62 + grain * 0.2 + grime * 0.18,
  };
};

/* -- sand ------------------------------------------------------------------ */
const sandTexel: TexelFn = (u, v) => {
  const grain = fbm(u * 150, v * 150, 150, 33, 2);
  const drift = fbm(u * 4, v * 4, 4, 37, 3);
  const rippleP = Math.sin((v * 14 + drift * 3.2 + fbm(u * 6, v * 6, 6, 39, 2) * 2.4) * Math.PI * 2);
  const rip = rippleP * 0.5 + 0.5;

  const t = clamp01(0.5 + (drift - 0.5) * 0.5 + (rip - 0.5) * 0.16 + (grain - 0.5) * 0.3);
  const r = lerp(0.42, 0.845, t);
  const g = lerp(0.335, 0.762, t);
  const b = lerp(0.215, 0.565, t);

  return { r, g, b, h: rip * 0.42 + drift * 0.38 + grain * 0.2, rough: 0.94 - grain * 0.06 };
};

/* -- snow ------------------------------------------------------------------ */
const snowTexel: TexelFn = (u, v) => {
  const drift = fbm(u * 5, v * 5, 5, 41, 4);
  const fine = fbm(u * 110, v * 110, 110, 43, 2);
  const t = clamp01(drift * 0.7 + fine * 0.3);
  let r = lerp(0.62, 0.98, t);
  let g = lerp(0.67, 0.99, t);
  let b = lerp(0.79, 1.0, t);
  const sparkle = fine > 0.955 ? 1 : 0;
  r = lerp(r, 1, sparkle);
  g = lerp(g, 1, sparkle);
  b = lerp(b, 1, sparkle);
  return { r, g, b, h: drift * 0.75 + fine * 0.25, rough: 0.4 + drift * 0.3 - sparkle * 0.35 };
};

/* -- swamp ----------------------------------------------------------------- */
const swampTexel: TexelFn = (u, v) => {
  const murk = fbm(u * 6, v * 6, 6, 53, 4);
  const algae = smoothstep(0.52, 0.78, fbm(u * 12, v * 12, 12, 57, 3));
  const scum = fbm(u * 48, v * 48, 48, 59, 2);
  const t = clamp01(murk * 0.7 + scum * 0.3);
  let r = lerp(0.075, 0.208, t);
  let g = lerp(0.092, 0.216, t);
  let b = lerp(0.058, 0.128, t);
  r = lerp(r, 0.17, algae * 0.7);
  g = lerp(g, 0.3, algae * 0.7);
  b = lerp(b, 0.09, algae * 0.7);
  return { r, g, b, h: murk * 0.6 + scum * 0.4, rough: 0.55 + murk * 0.25 - algae * 0.2 };
};

/* -- wood / bridge --------------------------------------------------------- */
function woodTexel(planks: number, seedBase: number, dark: boolean): TexelFn {
  return (u, v) => {
    const idx = Math.floor(v * planks);
    const fv = v * planks - idx;
    const gap = 1 - smoothstep(0.0, 0.055, Math.min(fv, 1 - fv));
    // grain stretched along the plank
    const grain = fbm(u * 26 + idx * 3.7, v * planks * 5, 26, seedBase, 3);
    const knotN = fbm(u * 5 + idx * 2.3, v * planks * 1.4, 5, seedBase + 7, 2);
    const knot = smoothstep(0.78, 0.94, knotN);
    const tone = hash2(idx, 0, seedBase + 3);

    const t = clamp01(grain * 0.65 + tone * 0.25 + 0.1);
    const base = dark ? 0.72 : 1.0;
    let r = lerp(0.175, 0.462, t) * base;
    let g = lerp(0.112, 0.312, t) * base;
    let b = lerp(0.062, 0.176, t) * base;
    r = lerp(r, 0.1, knot * 0.7);
    g = lerp(g, 0.062, knot * 0.7);
    b = lerp(b, 0.035, knot * 0.7);
    r = lerp(r, 0.045, gap * 0.9);
    g = lerp(g, 0.032, gap * 0.9);
    b = lerp(b, 0.022, gap * 0.9);

    return { r, g, b, h: (1 - gap) * (0.5 + grain * 0.45) - knot * 0.1, rough: 0.7 + grain * 0.2 };
  };
}

/* -- roof shingles --------------------------------------------------------- */
const roofTexel: TexelFn = (u, v) => {
  const rows = 9;
  const row = Math.floor(v * rows);
  const fv = v * rows - row;
  const cols = 7;
  const uu = wrap(u + (row % 2) * 0.5, 1);
  const col = Math.floor(uu * cols);
  const fu = uu * cols - col;

  const lip = smoothstep(0.82, 1.0, fv);
  const sideGap = 1 - smoothstep(0.0, 0.05, Math.min(fu, 1 - fu));
  const tone = hash2(col, row, 63);
  const wear = fbm(u * 30, v * 30, 30, 67, 3);

  const t = clamp01(0.45 + (tone - 0.5) * 0.35 + (wear - 0.5) * 0.3 - fv * 0.18);
  let r = lerp(0.16, 0.42, t);
  let g = lerp(0.11, 0.235, t);
  let b = lerp(0.115, 0.215, t);
  const shade = Math.max(lip, sideGap);
  r = lerp(r, 0.05, shade * 0.85);
  g = lerp(g, 0.035, shade * 0.85);
  b = lerp(b, 0.038, shade * 0.85);
  // moss in the shingle gutters
  const moss = smoothstep(0.6, 0.9, wear) * lip;
  r = lerp(r, 0.14, moss * 0.5);
  g = lerp(g, 0.2, moss * 0.5);
  b = lerp(b, 0.09, moss * 0.5);

  return { r, g, b, h: (1 - fv) * 0.7 + (1 - sideGap) * 0.3, rough: 0.78 + wear * 0.16 };
};

/* -- lava ------------------------------------------------------------------ */
const lavaTexel: TexelFn = (u, v) => {
  const plates = fbm(u * 6, v * 6, 6, 73, 4);
  const crackN = ridge(u * 7, v * 7, 7, 79, 4);
  const crack = smoothstep(0.72, 0.97, crackN);
  const crust = fbm(u * 44, v * 44, 44, 83, 2);

  const t = clamp01(plates * 0.6 + crust * 0.4);
  let r = lerp(0.045, 0.135, t);
  let g = lerp(0.032, 0.098, t);
  let b = lerp(0.033, 0.09, t);
  // molten glow bleeding out of the fissures
  const glow = crack;
  r = lerp(r, 1.0, glow * 0.9);
  g = lerp(g, 0.38, glow * 0.9);
  b = lerp(b, 0.07, glow * 0.9);

  return {
    r,
    g,
    b,
    h: (1 - crack) * (0.55 + plates * 0.45),
    rough: 0.85 - glow * 0.4,
    e: glow,
    er: 1.0,
    eg: 0.34,
    eb: 0.06,
  };
};

/* -- cliff rock ------------------------------------------------------------ */
const cliffTexel: TexelFn = (u, v) => {
  // horizontal strata; v is world-up on a cliff face
  // Sedimentary bands run horizontally (v is world-up on a side face). The bands are
  // the readable feature; the noise only breaks their edges up.
  const warpU = fbm(u * 3, v * 3, 3, 91, 2) - 0.5;
  const bandCoord = v * 9 + warpU * 0.9;
  const bandIdx = Math.floor(bandCoord);
  const bandFrac = bandCoord - bandIdx;
  const bandTone = hash2(bandIdx, 0, 93);
  const bandEdge = 1 - smoothstep(0.0, 0.09, Math.min(bandFrac, 1 - bandFrac));

  const grain = fbm(u * 24, v * 34, 24, 97, 3);
  const chip = fbm(u * 72, v * 72, 72, 103, 2);
  const crack = smoothstep(0.91, 1.0, ridge(u * 7, v * 4.5, 7, 101, 3));

  const t = clamp01(
    0.52 + (bandTone - 0.5) * 0.3 + (grain - 0.5) * 0.26 + (chip - 0.5) * 0.12,
  );
  let r = lerp(0.20, 0.615, t);
  let g = lerp(0.183, 0.572, t);
  let b = lerp(0.163, 0.508, t);
  // iron staining varies band to band
  const stain = smoothstep(0.6, 0.95, bandTone);
  r = lerp(r, r * 1.2 + 0.045, stain * 0.5);
  g = lerp(g, g * 1.0, stain * 0.5);
  b = lerp(b, b * 0.78, stain * 0.5);
  // shadowed bedding planes
  const shade = Math.max(bandEdge * 0.55, crack * 0.8);
  r = lerp(r, 0.075, shade * 0.7);
  g = lerp(g, 0.068, shade * 0.7);
  b = lerp(b, 0.062, shade * 0.7);

  return {
    r,
    g,
    b,
    h: (1 - bandEdge) * (0.45 + grain * 0.35) + chip * 0.12 - crack * 0.3,
    rough: 0.74 + grain * 0.2,
  };
};

/* -- submerged bed --------------------------------------------------------- */
const bedTexel: TexelFn = (u, v) => {
  const base = dirtTexel(u, v);
  const silt = fbm(u * 10, v * 10, 10, 107, 3);
  const t = 0.45 + silt * 0.35;
  return {
    r: lerp(base.r * 0.62, 0.28, t * 0.4),
    g: lerp(base.g * 0.66, 0.25, t * 0.4),
    b: lerp(base.b * 0.72, 0.2, t * 0.4),
    h: base.h * 0.7 + silt * 0.3,
    rough: 0.9,
  };
};

const TEXELS: Record<TerrainMaterialKind, TexelFn> = {
  grass: grassTexel,
  dirt: dirtTexel,
  stone: stoneTexel,
  sand: sandTexel,
  water: bedTexel,
  deepwater: bedTexel,
  swamp: swampTexel,
  snow: snowTexel,
  lava: lavaTexel,
  wood: woodTexel(6, 111, false),
  roof: roofTexel,
  bridge: woodTexel(5, 127, true),
  void: dirtTexel,
  cliff: cliffTexel,
  bed: bedTexel,
};

/** Physical bump strength (world units) used when deriving the normal map. */
const BUMP_STRENGTH: Partial<Record<TerrainMaterialKind, number>> = {
  grass: 1.5,
  dirt: 1.8,
  stone: 2.6,
  sand: 1.0,
  snow: 0.9,
  swamp: 1.2,
  wood: 1.6,
  bridge: 1.8,
  roof: 2.8,
  lava: 2.4,
  cliff: 3.4,
  bed: 1.2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Texture baking
// ─────────────────────────────────────────────────────────────────────────────

interface BakedMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

function makeTexture(data: Uint8ClampedArray, size: number, srgb: boolean): THREE.Texture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function bake(kind: TerrainMaterialKind): BakedMaps {
  const size = TEX_SIZE;
  const fn = TEXELS[kind];
  const albedo = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  let emissive: Uint8ClampedArray | undefined;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const t = fn(x / size, y / size);
      albedo[i * 4] = t.r * 255;
      albedo[i * 4 + 1] = t.g * 255;
      albedo[i * 4 + 2] = t.b * 255;
      albedo[i * 4 + 3] = 255;
      const rv = clamp01(t.rough) * 255;
      rough[i * 4] = rv;
      rough[i * 4 + 1] = rv;
      rough[i * 4 + 2] = rv;
      rough[i * 4 + 3] = 255;
      height[i] = clamp01(t.h);
      if (t.e !== undefined && t.e > 0) {
        emissive ??= new Uint8ClampedArray(size * size * 4);
        emissive[i * 4] = (t.er ?? 1) * t.e * 255;
        emissive[i * 4 + 1] = (t.eg ?? 1) * t.e * 255;
        emissive[i * 4 + 2] = (t.eb ?? 1) * t.e * 255;
        emissive[i * 4 + 3] = 255;
      }
    }
  }
  if (emissive) {
    for (let i = 0; i < size * size; i++) {
      if (emissive[i * 4 + 3] === 0) emissive[i * 4 + 3] = 255;
    }
  }

  // Sobel the height field into a tangent-space normal map.
  const normal = new Uint8ClampedArray(size * size * 4);
  const strength = BUMP_STRENGTH[kind] ?? 1.5;
  const at = (x: number, y: number): number => height[wrap(y, size) * size + wrap(x, size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t0 = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l0 = at(x - 1, y);
      const r0 = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b0 = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const dx = tl + 2 * l0 + bl - (tr + 2 * r0 + br);
      const dy = tl + 2 * t0 + tr - (bl + 2 * b0 + br);
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      normal[i] = (nx * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i + 2] = (nz / len) * 0.5 * 255 + 127.5;
      normal[i + 3] = 255;
    }
  }

  const maps: BakedMaps = {
    map: makeTexture(albedo, size, true),
    normalMap: makeTexture(normal, size, false),
    roughnessMap: makeTexture(rough, size, false),
  };
  if (emissive) maps.emissiveMap = makeTexture(emissive, size, true);
  return maps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shader patch: vertex AO + world-space macro variation
// ─────────────────────────────────────────────────────────────────────────────

/** Shadow tint that AO drives toward — cool, never pure black. */
const AO_TINT = new THREE.Color(0.16, 0.19, 0.30);

const MACRO_CHUNK = /* glsl */ `
float etHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float etNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(etHash(i), etHash(i + vec2(1.0, 0.0)), u.x),
             mix(etHash(i + vec2(0.0, 1.0)), etHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float etFbm(vec2 p) {
  return etNoise(p) * 0.6 + etNoise(p * 2.17) * 0.28 + etNoise(p * 4.41) * 0.12;
}
`;

interface PatchOptions {
  aoStrength: number;
  macroStrength: number;
  macroScale: number;
}

function patchForVertexAO(mat: THREE.MeshStandardMaterial, opts: PatchOptions): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAoTint = { value: AO_TINT };
    shader.uniforms.uAoStrength = { value: opts.aoStrength };
    shader.uniforms.uMacroStrength = { value: opts.macroStrength };
    shader.uniforms.uMacroScale = { value: opts.macroScale };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aAO;
varying float vEtAO;
varying vec3 vEtWorld;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vEtAO = aAO;
vEtWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vEtAO;
varying vec3 vEtWorld;
uniform vec3 uAoTint;
uniform float uAoStrength;
uniform float uMacroStrength;
uniform float uMacroScale;
${MACRO_CHUNK}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  // Low-frequency world-space variation breaks up texture repetition.
  float m = etFbm(vEtWorld.xz * uMacroScale + vEtWorld.y * 0.07);
  float m2 = etFbm(vEtWorld.xz * uMacroScale * 3.7 + 11.3);
  // Two bands: a wide one that shifts hue and value across whole regions of the map,
  // and a tighter one that keeps adjacent tiles from matching exactly.
  float m3 = etFbm(vEtWorld.xz * uMacroScale * 0.31 + 47.1);
  vec3 macro = vec3(1.0 + (m - 0.5) * 1.10, 1.0 + (m - 0.5) * 0.86, 1.0 + (m - 0.5) * 0.62);
  diffuseColor.rgb *= mix(vec3(1.0), macro, uMacroStrength);
  diffuseColor.rgb *= 1.0 + (m2 - 0.5) * 0.14 * uMacroStrength;
  diffuseColor.rgb *= 1.0 + (m3 - 0.5) * 0.42 * uMacroStrength;

  // Baked crevice occlusion, tinted rather than crushed to black.
  float ao = clamp(vEtAO, 0.0, 1.0);
  float k = pow(1.0 - ao, 1.35) * uAoStrength;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uAoTint * 1.9, k);
  diffuseColor.rgb *= mix(1.0, 0.55, k);
}`,
      );

    // Occlude indirect light too, otherwise the hemisphere fill flattens the crevices out.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
{
  float aoV = clamp(vEtAO, 0.0, 1.0);
  float occ = mix(1.0, aoV, uAoStrength);
  reflectedLight.indirectDiffuse *= occ;
  reflectedLight.indirectSpecular *= occ * occ;
}`,
    );
  };
  // Force a distinct program per configuration.
  mat.customProgramCacheKey = () =>
    `et-terrain-${opts.aoStrength}-${opts.macroStrength}-${opts.macroScale}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

interface SurfaceTuning {
  /** Multiplier on the baked UVs — <1 makes one texture repeat cover more world. */
  uvScale?: number;
  roughness: number;
  metalness: number;
  color: number;
  emissive?: number;
  emissiveIntensity?: number;
  aoStrength: number;
  macroStrength: number;
  macroScale: number;
}

const TUNING: Record<TerrainMaterialKind, SurfaceTuning> = {
  grass: { uvScale: 1.0, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 0.95, macroStrength: 0.55, macroScale: 0.09 },
  dirt: { uvScale: 0.9, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 0.95, macroStrength: 0.5, macroScale: 0.11 },
  stone: { uvScale: 1.0, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 1.0, macroStrength: 0.62, macroScale: 0.13 },
  sand: { uvScale: 0.85, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 0.9, macroStrength: 0.42, macroScale: 0.08 },
  water: { roughness: 1, metalness: 0, color: 0x9fb0a8, aoStrength: 0.9, macroStrength: 0.35, macroScale: 0.1 },
  deepwater: { roughness: 1, metalness: 0, color: 0x8494a0, aoStrength: 0.9, macroStrength: 0.35, macroScale: 0.1 },
  swamp: { uvScale: 0.9, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 1.0, macroStrength: 0.5, macroScale: 0.1 },
  snow: { uvScale: 0.8, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 0.75, macroStrength: 0.3, macroScale: 0.08 },
  lava: { uvScale: 0.7, roughness: 1, metalness: 0, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.6, aoStrength: 0.8, macroStrength: 0.35, macroScale: 0.1 },
  wood: { uvScale: 0.62, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 0.95, macroStrength: 0.3, macroScale: 0.12 },
  roof: { uvScale: 0.75, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 1.0, macroStrength: 0.35, macroScale: 0.1 },
  bridge: { uvScale: 0.62, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 0.95, macroStrength: 0.3, macroScale: 0.12 },
  void: { roughness: 1, metalness: 0, color: 0x222222, aoStrength: 1.0, macroStrength: 0.2, macroScale: 0.1 },
  cliff: { uvScale: 0.6, roughness: 1, metalness: 0, color: 0xffffff, aoStrength: 1.0, macroStrength: 0.28, macroScale: 0.11 },
  bed: { uvScale: 0.7, roughness: 1, metalness: 0, color: 0x9aa89e, aoStrength: 0.85, macroStrength: 0.35, macroScale: 0.1 },
};

const mapCache = new Map<TerrainMaterialKind, BakedMaps>();
const matCache = new Map<TerrainMaterialKind, THREE.MeshStandardMaterial>();

/** Bake (once) and return the texture set for a surface kind. */
export function surfaceMaps(kind: TerrainMaterialKind): BakedMaps {
  let m = mapCache.get(kind);
  if (!m) {
    m = bake(kind);
    mapCache.set(kind, m);
  }
  return m;
}

/**
 * The material for a surface kind. Cached and shared — a 20x20 map therefore ends up with
 * one material (and one draw call) per distinct surface present.
 */
export function createSurfaceMaterial(kind: TerrainMaterialKind): THREE.MeshStandardMaterial {
  const cached = matCache.get(kind);
  if (cached) return cached;

  const maps = surfaceMaps(kind);
  const tune = TUNING[kind];
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: tune.roughness,
    metalness: tune.metalness,
    color: new THREE.Color(tune.color),
    dithering: true,
  });
  mat.name = `terrain-${kind}`;
  mat.normalScale.set(0.85, 0.85);
  const uvScale = tune.uvScale ?? 1;
  if (uvScale !== 1) {
    maps.map.repeat.setScalar(uvScale);
    maps.normalMap.repeat.setScalar(uvScale);
    maps.roughnessMap.repeat.setScalar(uvScale);
    maps.emissiveMap?.repeat.setScalar(uvScale);
  }
  if (maps.emissiveMap && tune.emissive !== undefined) {
    mat.emissiveMap = maps.emissiveMap;
    mat.emissive = new THREE.Color(tune.emissive);
    mat.emissiveIntensity = tune.emissiveIntensity ?? 1;
  }
  patchForVertexAO(mat, {
    aoStrength: tune.aoStrength,
    macroStrength: tune.macroStrength,
    macroScale: tune.macroScale,
  });
  matCache.set(kind, mat);
  return mat;
}

/** Release every cached material/texture. Call on scenario teardown. */
export function disposeTerrainMaterials(): void {
  for (const mat of matCache.values()) mat.dispose();
  matCache.clear();
  for (const maps of mapCache.values()) {
    maps.map.dispose();
    maps.normalMap.dispose();
    maps.roughnessMap.dispose();
    maps.emissiveMap?.dispose();
  }
  mapCache.clear();
}

/** Surfaces rendered by the water shader instead of a standard material. */
export function isWaterSurface(kind: SurfaceKind): boolean {
  return kind === 'water' || kind === 'deepwater';
}

export const __testing = { fbm, valueNoise, ridge };
