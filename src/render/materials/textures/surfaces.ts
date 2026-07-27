/**
 * EverTactics — per-surface procedural texel authoring.
 *
 * One function per surface kind. Each returns albedo, a height field (Sobel'd into a
 * normal map by the baker), roughness, and optionally emissive.
 *
 * The rule every one of these follows, taken straight from the reference frames:
 * **a surface needs at least four distinguishable features at four different scales.**
 * A flat colour plus one octave of noise is what a critic spots first. So:
 *
 *   - a *macro* feature that reads at tile scale (courses, flagstones, clumps, drifts),
 *   - a *meso* feature that varies element to element (per-block tone, per-clump colour),
 *   - a *wear* feature that is not symmetric (grime pooling in joints, streaks running
 *     downward, chipped corners, polish in the middle of a worn slab),
 *   - a *micro* feature that only shows up close (grit, speck, weave, capillary ripple).
 *
 * Colours are authored display-referred (sRGB-ish 0..1) and uploaded as an sRGB texture.
 */

import {
  clamp01,
  fbm,
  fbm2p,
  hash2,
  lerp,
  masonry,
  ridge,
  smoothstep,
  streak,
  warpedFbm,
  worley,
  worleyAniso,
} from './noise';

export interface Texel {
  r: number;
  g: number;
  b: number;
  /** Height for normal-map derivation, 0..1. */
  h: number;
  /** Roughness, 0..1. */
  rough: number;
  /** Emissive intensity, 0..1. */
  e?: number;
  er?: number;
  eg?: number;
  eb?: number;
}

export type TexelFn = (u: number, v: number) => Texel;

/** Mix a colour triple toward another by `t`, in place on a scratch object. */
function tint(
  c: { r: number; g: number; b: number },
  r: number,
  g: number,
  b: number,
  t: number,
): void {
  c.r = lerp(c.r, r, t);
  c.g = lerp(c.g, g, t);
  c.b = lerp(c.b, b, t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turf, not a green plane. Worley clumps give discrete tussocks with real gaps; the
 * gaps darken toward wet soil (that is the "darker roots between blades" note), the
 * crowns catch light, blades streak along a per-clump direction, and scattered dry
 * straw, bare soil and tiny flowers stop the field from reading as one hue.
 */
export const grassTexel: TexelFn = (u, v) => {
  // Two clump scales, both low-contrast. A single high-contrast Worley reads as a
  // mosaic of lily pads, which is the exact opposite of turf.
  const clump = worley(u, v, 13, 401, 0.95);
  const micro = worley(u, v, 40, 409, 1.0);
  // Only the *interior* of a tussock is used; the cell border term is deliberately
  // not fed back into the albedo, because a Worley border network reads as crazy
  // paving rather than as grass.
  const crown = smoothstep(0.05, 0.42, clump.f1);
  const microCrown = smoothstep(0.02, 0.30, micro.f1);

  // Blades are the dominant feature: fine, directional, and re-oriented per clump.
  const dir = clump.id * Math.PI;
  // `streak` stretches features along x by making the y lattice `aniso` times finer,
  // so the base period has to stay coarse or the blades alias into mush.
  const blades = streak(u, v, 22, 419, dir, 4.2, 3);
  const blades2 = streak(u, v, 44, 423, dir + 1.1, 2.6, 2);
  const fine = fbm(u * 170, v * 170, 170, 421, 2);

  const lush = warpedFbm(u * 3.5, v * 3.5, 4, 431, 1.4, 3);
  const dry = smoothstep(0.60, 0.90, warpedFbm(u * 5, v * 5, 5, 433, 1.1, 3));

  const t = clamp01(
    0.10 +
      crown * 0.14 +
      microCrown * 0.07 +
      blades * 0.52 +
      blades2 * 0.24 +
      fine * 0.07 +
      (lush - 0.5) * 0.28,
  );

  const c = {
    r: lerp(0.056, 0.268, t),
    g: lerp(0.100, 0.394, t),
    b: lerp(0.046, 0.126, t),
  };
  const hueShift = clump.id - 0.5;
  c.r *= 1 + hueShift * 0.22;
  c.g *= 1 + hueShift * 0.08;
  c.b *= 1 - hueShift * 0.16;

  tint(c, 0.418, 0.372, 0.186, dry * 0.46);

  // Soil showing through only where the turf is genuinely thin.
  const bare = smoothstep(0.10, 0.0, clump.f1) * smoothstep(0.46, 0.74, 1 - lush);
  tint(c, 0.140, 0.104, 0.070, bare * 0.6);

  // Root shadow between blades — the darker roots note from the reference — but kept
  // as a gentle gradient, not a cell outline.
  tint(c, 0.030, 0.050, 0.026, (1 - blades) * 0.26 + (1 - lush) * 0.10);

  // The odd pebble. Dark and rare: a bright speck field reads as dandruff.
  const stone = smoothstep(0.09, 0.03, micro.f1) * smoothstep(0.90, 0.99, micro.id);
  tint(c, 0.176, 0.166, 0.146, stone * 0.7);

  // Tiny flowers, very sparse.
  const flowerCell = worley(u, v, 26, 443, 1.0);
  const flower =
    smoothstep(0.07, 0.02, flowerCell.f1) * smoothstep(0.955, 0.995, flowerCell.id);
  const warm = hash2(flowerCell.cx, flowerCell.cy, 447);
  tint(c, lerp(0.78, 0.86, warm), lerp(0.74, 0.58, warm), lerp(0.50, 0.32, warm), flower * 0.85);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: crown * 0.14 + microCrown * 0.08 + blades * 0.50 + blades2 * 0.16 + fine * 0.06,
    rough: 0.90 + fine * 0.08 - flower * 0.08,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Dirt / earth
// ─────────────────────────────────────────────────────────────────────────────

export const dirtTexel: TexelFn = (u, v) => {
  const base = warpedFbm(u * 6, v * 6, 6, 501, 1.6, 4);
  const grit = fbm(u * 96, v * 96, 96, 503, 2);
  const gravel = worley(u, v, 30, 509, 1.0);
  // Gravel is *earth-coloured* earth. Tinting it toward pale grey turns a dirt path
  // into a field of polka dots the moment a key light hits it.
  const pebbleMask = smoothstep(0.16, 0.05, gravel.f1) * smoothstep(0.55, 0.85, gravel.id);
  const bigStone = worley(u, v, 11, 511, 0.9);
  const cobble = smoothstep(0.17, 0.07, bigStone.f1) * smoothstep(0.88, 0.98, bigStone.id);

  const crack = smoothstep(0.60, 0.90, ridge(u * 8, v * 8, 8, 513, 3));
  const rut = smoothstep(0.42, 0.78, warpedFbm(u * 3, v * 3, 3, 517, 2.0, 3));
  // Dry scuffed streaks running with the traffic direction.
  const scuff = fbm2p(u * 40, v * 5, 40, 6, 519, 3);

  const t = clamp01(base * 0.56 + grit * 0.22 + scuff * 0.14 + (1 - crack) * 0.10);
  const c = {
    r: lerp(0.126, 0.402, t),
    g: lerp(0.090, 0.292, t),
    b: lerp(0.062, 0.186, t),
  };
  const iron = smoothstep(0.55, 0.85, base);
  tint(c, c.r * 1.22 + 0.02, c.g * 0.96, c.b * 0.78, iron * 0.5);

  const pg = 0.24 + gravel.id * 0.14;
  tint(c, pg, pg * 0.92, pg * 0.80, pebbleMask * 0.55);
  const cg = 0.28 + bigStone.id * 0.16;
  tint(c, cg, cg * 0.93, cg * 0.82, cobble * 0.6);

  tint(c, 0.048, 0.036, 0.026, crack * 0.5);
  tint(c, 0.082, 0.060, 0.042, rut * 0.30);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: base * 0.44 + grit * 0.14 + scuff * 0.12 + pebbleMask * 0.14 + cobble * 0.22 - crack * 0.22,
    rough: 0.94 - pebbleMask * 0.12 - cobble * 0.14,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Stone — flagged floor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A paved floor: large irregular flagstones, wide grouted joints, the middle of each
 * slab polished smooth by traffic, corners chipped away, and moss creeping out of the
 * joints. Deliberately *warm* limestone rather than neutral grey — the fail list calls
 * neutral grey out by name.
 */
export const stoneTexel: TexelFn = (u, v) => {
  const b = masonry(u, v, 4, 4, 601, 0.34, 0.40);

  // Chipped corners: bite worley cells out of the slab wherever they straddle an edge.
  const chipCell = worley(u, v, 22, 607, 1.0);
  const chipHere = smoothstep(0.30, 0.10, chipCell.f1) * smoothstep(0.45, 0.80, chipCell.id);
  const jointRaw = 1 - smoothstep(0.0, 0.020, b.edge);
  const joint = clamp01(jointRaw + chipHere * smoothstep(0.055, 0.012, b.edge));
  const bevel = 1 - smoothstep(0.018, 0.062, b.edge);

  // Per-slab internal character. Rotating the grain per slab is what stops a masonry
  // texture from looking like one stone photocopied.
  const rot = b.rot * Math.PI;
  const grain = streak(u, v, 16, 613, rot, 2.4, 3);
  const vein = smoothstep(0.62, 0.93, ridge(u * 11, v * 11, 11, 617, 3));
  const speck = fbm(u * 170, v * 170, 170, 619, 2);
  const pit = worley(u, v, 44, 623, 1.0);
  // Pitting is a *tonal* feature, not a relief one: sharp little dents catch the key
  // light as white pinpricks, which reads as dandruff rather than as worn stone.
  const pitting = smoothstep(0.20, 0.07, pit.f1) * smoothstep(0.70, 0.94, pit.id);

  const t = clamp01(
    0.44 + (b.tone - 0.5) * 0.52 + (grain - 0.5) * 0.28 + (speck - 0.5) * 0.10,
  );
  // Warm ochre limestone. The fail list names neutral grey explicitly.
  const c = {
    r: lerp(0.206, 0.760, t),
    g: lerp(0.178, 0.678, t),
    b: lerp(0.140, 0.532, t),
  };
  // Some slabs are a different quarry batch: cooler and bluer.
  const cool = smoothstep(0.68, 0.94, b.id);
  tint(c, c.r * 0.86, c.g * 0.92, c.b * 1.06, cool * 0.7);

  // Calcite veins.
  tint(c, 0.780, 0.756, 0.690, vein * 0.42);

  // Traffic polish in the slab centre — lighter, smoother, slightly warmer.
  const centre = smoothstep(0.18, 0.42, b.edge) * (0.6 + b.tone * 0.4);
  tint(c, c.r * 1.13 + 0.02, c.g * 1.10 + 0.018, c.b * 1.04 + 0.012, centre * 0.45);

  // Grime that has washed into the joints and pooled at the slab edges.
  const grimeN = fbm(u * 24, v * 24, 24, 631, 3);
  const grime = clamp01(joint * (0.6 + grimeN * 0.4) + bevel * 0.35);
  tint(c, 0.072, 0.064, 0.052, grime * 0.86);

  // Moss creeping out of the joints where it is damp.
  const damp = smoothstep(0.52, 0.84, warpedFbm(u * 4, v * 4, 4, 641, 1.5, 3));
  const moss = clamp01(bevel * 1.2 + joint * 0.6) * damp;
  tint(c, 0.118, 0.176, 0.078, moss * 0.72);

  tint(c, 0.16, 0.144, 0.116, pitting * 0.18);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h:
      (1 - joint) * (0.52 + grain * 0.26 + b.tone * 0.14) -
      bevel * 0.22 -
      pitting * 0.10,
    rough: 0.74 - centre * 0.30 + grime * 0.18 + moss * 0.1,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Stone — coursed wall
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The vertical faces of masonry. Different lattice from the floor (many thin courses
 * rather than a few big slabs) and, critically, **weathering runs downward**: dirt
 * streaks below every joint, lichen on the upward-facing ledges. That asymmetry is the
 * single strongest cue that a wall is a wall and not a texture.
 *
 * `v` increases downward on side faces (the terrain builder projects `-y`), so "down"
 * in texture space is +v.
 */
export const stoneWallTexel: TexelFn = (u, v) => {
  const b = masonry(u, v, 8, 5, 701, 0.38, 0.48);

  const chipCell = worley(u, v, 34, 707, 1.0);
  const chip = smoothstep(0.32, 0.08, chipCell.f1) * smoothstep(0.5, 0.85, chipCell.id);
  const jointRaw = 1 - smoothstep(0.0, 0.014, b.edge);
  const joint = clamp01(jointRaw + chip * smoothstep(0.04, 0.008, b.edge));
  const bevel = 1 - smoothstep(0.012, 0.048, b.edge);

  const rot = b.rot * Math.PI;
  const tool = streak(u, v, 22, 709, rot, 3.0, 3);
  const speck = fbm(u * 160, v * 160, 160, 719, 2);
  const pit = worley(u, v, 48, 727, 1.0);
  const pitting = smoothstep(0.20, 0.07, pit.f1) * smoothstep(0.70, 0.94, pit.id);

  const t = clamp01(
    0.45 + (b.tone - 0.5) * 0.54 + (tool - 0.5) * 0.26 + (speck - 0.5) * 0.10,
  );
  const c = {
    r: lerp(0.196, 0.766, t),
    g: lerp(0.176, 0.688, t),
    b: lerp(0.142, 0.542, t),
  };
  const cool = smoothstep(0.66, 0.95, b.id);
  tint(c, c.r * 0.84, c.g * 0.91, c.b * 1.08, cool * 0.65);

  // Rain streaks running *down* from the joints. Sampling the joint field a little
  // above and smearing it downward is enough to read as decades of runoff.
  const runN = fbm2p(u * 30, v * 3.2, 30, 4, 733, 3);
  const runoff =
    smoothstep(0.42, 0.95, runN) * smoothstep(0.0, 0.55, b.v) * (0.45 + b.tone * 0.55);
  tint(c, c.r * 0.62, c.g * 0.62, c.b * 0.66, runoff * 0.42);

  // Lichen on the upward ledge of each course, brightest at the top of a block.
  const lichenN = warpedFbm(u * 9, v * 9, 9, 739, 1.6, 3);
  const ledge = smoothstep(0.34, 0.0, b.v);
  const lichen = smoothstep(0.54, 0.82, lichenN) * clamp01(ledge * 0.8 + bevel * 0.5);
  tint(c, 0.336, 0.352, 0.192, lichen * 0.5);

  // Grime pooled in the mortar.
  const grime = clamp01(joint * (0.62 + fbm(u * 22, v * 22, 22, 743, 2) * 0.38) + bevel * 0.30);
  tint(c, 0.062, 0.056, 0.048, grime * 0.90);

  tint(c, 0.15, 0.136, 0.110, pitting * 0.20);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h:
      (1 - joint) * (0.50 + tool * 0.28 + b.tone * 0.16) -
      bevel * 0.26 -
      pitting * 0.12,
    rough: 0.78 + grime * 0.16 + lichen * 0.1 - (1 - joint) * 0.08,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Cliff rock
// ─────────────────────────────────────────────────────────────────────────────

export const cliffTexel: TexelFn = (u, v) => {
  // Sedimentary bands, warped so they are not ruled lines.
  const warpU = warpedFbm(u * 3, v * 3, 3, 801, 1.8, 3) - 0.5;
  const bandCoord = v * 11 + warpU * 1.9;
  const bandIdx = Math.floor(bandCoord);
  const bandFrac = bandCoord - bandIdx;
  const bandTone = hash2(bandIdx, 0, 803);
  const bandEdge = 1 - smoothstep(0.0, 0.10, Math.min(bandFrac, 1 - bandFrac));

  // Broken blocky faces along the bedding planes.
  const blocks = worleyAniso(u, v, 5, 13, 809, 0.85);
  const blockEdge = 1 - smoothstep(0.0, 0.045, blocks.f2 - blocks.f1);

  // Vertical erosion runnels.
  const runnel = fbm2p(u * 22, v * 2.6, 22, 3, 811, 3);
  const gully = smoothstep(0.55, 0.92, runnel);

  const grain = fbm(u * 40, v * 52, 40, 821, 3);
  const chip = fbm(u * 110, v * 110, 110, 823, 2);
  const crack = smoothstep(0.72, 0.97, ridge(u * 9, v * 6, 9, 827, 3));

  const t = clamp01(
    0.50 +
      (bandTone - 0.5) * 0.30 +
      (blocks.id - 0.5) * 0.24 +
      (grain - 0.5) * 0.24 +
      (chip - 0.5) * 0.10,
  );
  const c = {
    r: lerp(0.176, 0.640, t),
    g: lerp(0.158, 0.586, t),
    b: lerp(0.136, 0.494, t),
  };
  // Iron staining varies band to band and bleeds downward.
  const stain = smoothstep(0.58, 0.94, bandTone) * (0.4 + gully * 0.6);
  tint(c, c.r * 1.30 + 0.05, c.g * 1.02, c.b * 0.72, stain * 0.55);
  // Damp, dark runnels.
  tint(c, c.r * 0.58, c.g * 0.60, c.b * 0.66, gully * 0.42);
  // Lichen crusts on the exposed noses.
  const lichen =
    smoothstep(0.60, 0.86, warpedFbm(u * 12, v * 12, 12, 829, 1.4, 3)) *
    smoothstep(0.22, 0.6, blocks.f2 - blocks.f1);
  tint(c, 0.318, 0.336, 0.196, lichen * 0.42);

  const shade = clamp01(Math.max(bandEdge * 0.75, crack * 0.7) + blockEdge * 0.35);
  tint(c, 0.062, 0.054, 0.046, shade * 0.72);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h:
      (1 - bandEdge) * (0.44 + grain * 0.28 + blocks.id * 0.20) +
      chip * 0.10 -
      crack * 0.26 -
      blockEdge * 0.18 -
      gully * 0.14,
    rough: 0.80 + grain * 0.16 - lichen * 0.08,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Sand
// ─────────────────────────────────────────────────────────────────────────────

export const sandTexel: TexelFn = (u, v) => {
  const drift = warpedFbm(u * 4, v * 4, 4, 901, 1.5, 3);
  const grain = fbm(u * 190, v * 190, 190, 903, 2);
  const rippleP = Math.sin(
    (v * 15 + drift * 3.6 + fbm(u * 7, v * 7, 7, 907, 2) * 2.6) * Math.PI * 2,
  );
  const rip = rippleP * 0.5 + 0.5;
  const shells = worley(u, v, 30, 911, 1.0);
  const shell = smoothstep(0.16, 0.04, shells.f1) * smoothstep(0.86, 0.98, shells.id);

  const t = clamp01(0.5 + (drift - 0.5) * 0.5 + (rip - 0.5) * 0.20 + (grain - 0.5) * 0.30);
  const c = {
    r: lerp(0.372, 0.868, t),
    g: lerp(0.288, 0.780, t),
    b: lerp(0.176, 0.574, t),
  };
  // Damp patches read cooler and darker.
  const damp = smoothstep(0.62, 0.9, warpedFbm(u * 2.5, v * 2.5, 3, 913, 1.2, 3));
  tint(c, c.r * 0.66, c.g * 0.68, c.b * 0.76, damp * 0.5);
  tint(c, 0.93, 0.90, 0.85, shell * 0.85);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: rip * 0.40 + drift * 0.36 + grain * 0.14 + shell * 0.1,
    rough: 0.95 - grain * 0.06 - shell * 0.25,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Snow
// ─────────────────────────────────────────────────────────────────────────────

export const snowTexel: TexelFn = (u, v) => {
  const drift = warpedFbm(u * 4.5, v * 4.5, 5, 1001, 1.7, 4);
  const wind = fbm2p(u * 30, v * 4, 30, 4, 1003, 3);
  const fine = fbm(u * 150, v * 150, 150, 1007, 2);
  const crust = worley(u, v, 14, 1009, 0.9);
  const crustEdge = 1 - smoothstep(0.0, 0.12, crust.f2 - crust.f1);

  const t = clamp01(drift * 0.52 + wind * 0.24 + fine * 0.24);
  const c = {
    r: lerp(0.560, 0.985, t),
    g: lerp(0.616, 0.992, t),
    b: lerp(0.742, 1.000, t),
  };
  // Blue shadow in the lee of every drift.
  tint(c, 0.42, 0.50, 0.68, crustEdge * 0.40);
  const sparkle = fine > 0.962 ? 1 : 0;
  tint(c, 1, 1, 1, sparkle);
  // A little exposed grass/rock poking through the thin spots.
  const bare = smoothstep(0.16, 0.03, drift);
  tint(c, 0.20, 0.19, 0.16, bare * 0.6);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: drift * 0.60 + wind * 0.22 + fine * 0.18 - crustEdge * 0.2,
    rough: 0.46 + drift * 0.28 - sparkle * 0.4,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Swamp
// ─────────────────────────────────────────────────────────────────────────────

export const swampTexel: TexelFn = (u, v) => {
  const murk = warpedFbm(u * 5, v * 5, 5, 1101, 2.0, 4);
  const mats = worley(u, v, 8, 1103, 1.0);
  const algae = smoothstep(0.30, 0.05, mats.f1) * smoothstep(0.30, 0.65, mats.id);
  const scum = fbm(u * 52, v * 52, 52, 1107, 2);
  const bubbles = worley(u, v, 40, 1109, 1.0);
  const bubble = smoothstep(0.13, 0.03, bubbles.f1) * smoothstep(0.78, 0.95, bubbles.id);
  const reed = fbm2p(u * 60, v * 6, 60, 6, 1113, 2);
  const reeds = smoothstep(0.70, 0.94, reed);

  const t = clamp01(murk * 0.66 + scum * 0.34);
  const c = {
    r: lerp(0.060, 0.216, t),
    g: lerp(0.074, 0.222, t),
    b: lerp(0.046, 0.132, t),
  };
  tint(c, 0.150, 0.302, 0.086, algae * 0.78);
  tint(c, 0.232, 0.276, 0.128, reeds * 0.35);
  tint(c, 0.30, 0.33, 0.24, bubble * 0.5);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: murk * 0.5 + scum * 0.26 + algae * 0.16 + bubble * 0.08,
    rough: 0.52 + murk * 0.26 - algae * 0.22 - bubble * 0.2,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Wood
// ─────────────────────────────────────────────────────────────────────────────

/** Planking — decks, bridges, floors. `planks` courses across the repeat. */
export function woodTexel(planks: number, seedBase: number, dark: boolean): TexelFn {
  return (u, v) => {
    const idx = Math.floor(v * planks);
    const fv = v * planks - idx;
    const gap = 1 - smoothstep(0.0, 0.055, Math.min(fv, 1 - fv));
    const bevel = 1 - smoothstep(0.03, 0.16, Math.min(fv, 1 - fv));

    // Grain stretched hard along the plank, with a per-plank phase.
    const phase = hash2(idx, 0, seedBase + 3) * 10;
    const grain = fbm2p(u * 34 + phase, v * planks * 4.5, 34, 5, seedBase, 3);
    const fineGrain = fbm2p(u * 130 + phase, v * planks * 9, 130, 9, seedBase + 5, 2);
    // Knots: rings of tight grain.
    const knotCell = worley(u, v * (planks / 6), 5, seedBase + 11, 1.0);
    const knotCore = smoothstep(0.22, 0.05, knotCell.f1) * smoothstep(0.72, 0.9, knotCell.id);
    const knotRing = Math.sin(knotCell.f1 * 46) * 0.5 + 0.5;
    // Splits running along the grain.
    const split = smoothstep(0.86, 0.98, ridge(u * 18 + phase, v * planks * 2, 18, seedBase + 13, 2));
    const tone = hash2(idx, 1, seedBase + 17);
    // Scuffed wear along the middle of the plank where feet land.
    const wear = smoothstep(0.6, 0.15, Math.abs(fv - 0.5)) * fbm(u * 9, v * 9, 9, seedBase + 19, 3);

    const t = clamp01(grain * 0.52 + fineGrain * 0.20 + tone * 0.24 + 0.06);
    const base = dark ? 0.70 : 1.0;
    const c = {
      r: lerp(0.156, 0.502, t) * base,
      g: lerp(0.096, 0.336, t) * base,
      b: lerp(0.052, 0.188, t) * base,
    };
    // Weathered silver-grey on the exposed faces.
    const weather = smoothstep(0.55, 0.9, fbm(u * 6, v * 6, 6, seedBase + 23, 3));
    tint(c, c.r * 0.78 + 0.09, c.g * 0.80 + 0.085, c.b * 0.86 + 0.078, weather * 0.45);

    tint(c, 0.086, 0.050, 0.026, knotCore * 0.8);
    tint(c, c.r * 0.72, c.g * 0.70, c.b * 0.68, smoothstep(0.35, 0.9, knotRing) * knotCore * 0.5);
    tint(c, 0.040, 0.026, 0.016, split * 0.7);
    tint(c, c.r * 1.14 + 0.02, c.g * 1.12 + 0.016, c.b * 1.08 + 0.012, wear * 0.35);
    tint(c, 0.034, 0.024, 0.016, gap * 0.92);
    tint(c, 0.070, 0.048, 0.030, bevel * 0.35);

    // Iron nail heads near the plank ends.
    const nailU = Math.abs(((u * 3) % 1) - 0.5);
    const nail =
      smoothstep(0.46, 0.42, nailU) *
      smoothstep(0.30, 0.16, Math.abs(fv - 0.22)) *
      0.9;
    tint(c, 0.19, 0.19, 0.20, nail);

    return {
      r: c.r,
      g: c.g,
      b: c.b,
      h: (1 - gap) * (0.46 + grain * 0.40 + fineGrain * 0.12) - knotCore * 0.12 - split * 0.25 + nail * 0.2,
      rough: 0.76 + grain * 0.16 - wear * 0.2 - nail * 0.3,
    };
  };
}

/** Structural timber seen end-on / edge-on: darker, rougher, saw-marked. */
export const timberTexel: TexelFn = (u, v) => {
  const grain = fbm2p(u * 12, v * 60, 12, 60, 1201, 3);
  const saw = fbm2p(u * 4, v * 150, 4, 150, 1203, 2);
  const knot = worley(u, v, 6, 1207, 1.0);
  const knotCore = smoothstep(0.20, 0.04, knot.f1) * smoothstep(0.66, 0.88, knot.id);
  const split = smoothstep(0.84, 0.98, ridge(u * 6, v * 20, 6, 1211, 2));

  const t = clamp01(grain * 0.6 + saw * 0.2 + 0.1);
  const c = {
    r: lerp(0.108, 0.362, t),
    g: lerp(0.070, 0.240, t),
    b: lerp(0.042, 0.140, t),
  };
  tint(c, 0.062, 0.038, 0.022, knotCore * 0.85);
  tint(c, 0.030, 0.020, 0.013, split * 0.75);
  const weather = smoothstep(0.55, 0.88, fbm(u * 7, v * 7, 7, 1213, 3));
  tint(c, c.r * 0.80 + 0.07, c.g * 0.82 + 0.066, c.b * 0.88 + 0.060, weather * 0.42);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: grain * 0.55 + saw * 0.2 - knotCore * 0.15 - split * 0.3,
    rough: 0.84 + grain * 0.12,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Roof shingles
// ─────────────────────────────────────────────────────────────────────────────

export const roofTexel: TexelFn = (u, v) => {
  const rows = 10;
  const row = Math.floor(v * rows);
  const fv = v * rows - row;
  const cols = 7;
  const bond = (row % 2) * 0.5 + (hash2(row, 0, 1301) - 0.5) * 0.12;
  const uu = ((u + bond) % 1 + 1) % 1;
  const col = Math.floor(uu * cols);
  const fu = uu * cols - col;

  // Each shingle sits proud of the one below, and its lower lip casts a hard shadow.
  const lip = smoothstep(0.80, 1.0, fv);
  const sideGap = 1 - smoothstep(0.0, 0.045, Math.min(fu, 1 - fu));
  const tone = hash2(col, row, 1303);
  const sag = (hash2(col, row, 1307) - 0.5) * 0.5;
  const wear = warpedFbm(u * 26, v * 26, 26, 1309, 1.2, 3);
  const crackEdge = smoothstep(0.72, 0.95, ridge(u * 40, v * 14, 40, 1311, 2)) * smoothstep(0.5, 1.0, fv);

  const t = clamp01(0.44 + (tone - 0.5) * 0.40 + (wear - 0.5) * 0.32 - fv * 0.16 + sag * 0.1);
  const c = {
    r: lerp(0.136, 0.436, t),
    g: lerp(0.094, 0.244, t),
    b: lerp(0.098, 0.226, t),
  };
  const shade = Math.max(lip, sideGap);
  tint(c, 0.034, 0.026, 0.030, shade * 0.88);
  // Moss in the gutters between courses.
  const moss = smoothstep(0.58, 0.9, wear) * Math.max(lip * 0.9, sideGap * 0.6);
  tint(c, 0.126, 0.192, 0.084, moss * 0.6);
  tint(c, 0.05, 0.04, 0.04, crackEdge * 0.5);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: (1 - fv) * 0.66 + (1 - sideGap) * 0.24 + sag * 0.1 - crackEdge * 0.2,
    rough: 0.80 + wear * 0.14 + moss * 0.06,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Lava
// ─────────────────────────────────────────────────────────────────────────────

export const lavaTexel: TexelFn = (u, v) => {
  const plates = worley(u, v, 7, 1401, 1.0);
  const plateEdge = 1 - smoothstep(0.0, 0.14, plates.f2 - plates.f1);
  const crackN = ridge(u * 8, v * 8, 8, 1403, 4);
  const crack = clamp01(smoothstep(0.70, 0.96, crackN) + plateEdge * 0.85);
  const crust = warpedFbm(u * 40, v * 40, 40, 1407, 1.0, 3);
  const ember = worley(u, v, 34, 1409, 1.0);
  const emberDot = smoothstep(0.14, 0.03, ember.f1) * smoothstep(0.80, 0.95, ember.id);

  const t = clamp01(plates.id * 0.4 + crust * 0.6);
  const c = {
    r: lerp(0.038, 0.128, t),
    g: lerp(0.028, 0.092, t),
    b: lerp(0.030, 0.086, t),
  };
  const glow = clamp01(crack * 0.9 + emberDot * 0.8);
  tint(c, 1.0, 0.36, 0.06, glow * 0.92);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: (1 - crack) * (0.5 + crust * 0.4 + plates.id * 0.2),
    rough: 0.88 - glow * 0.45,
    e: glow,
    er: 1.0,
    eg: 0.32,
    eb: 0.05,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Submerged bed
// ─────────────────────────────────────────────────────────────────────────────

export const bedTexel: TexelFn = (u, v) => {
  const silt = warpedFbm(u * 9, v * 9, 9, 1501, 1.4, 4);
  const cobble = worley(u, v, 15, 1503, 1.0);
  const stones = smoothstep(0.28, 0.08, cobble.f1) * smoothstep(0.35, 0.7, cobble.id);
  const weed = smoothstep(0.60, 0.88, warpedFbm(u * 6, v * 6, 6, 1507, 2.0, 3));
  const grit = fbm(u * 110, v * 110, 110, 1511, 2);

  const t = clamp01(silt * 0.6 + grit * 0.4);
  const c = {
    r: lerp(0.104, 0.286, t),
    g: lerp(0.106, 0.276, t),
    b: lerp(0.090, 0.226, t),
  };
  const sg = 0.28 + cobble.id * 0.24;
  tint(c, sg, sg * 1.0, sg * 0.94, stones * 0.8);
  tint(c, 0.086, 0.150, 0.078, weed * 0.6);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: silt * 0.4 + stones * 0.4 + grit * 0.2,
    rough: 0.90 - stones * 0.15,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Prop materials
// ─────────────────────────────────────────────────────────────────────────────

/** Leaf mass — clustered lobes, dark interior, lighter sunlit rims, visible veins. */
export const foliageTexel: TexelFn = (u, v) => {
  const cluster = worley(u, v, 7, 1601, 1.0);
  const leaf = worley(u, v, 22, 1603, 1.0);
  const crown = smoothstep(0.01, 0.30, leaf.f2 - leaf.f1);
  const bigCrown = smoothstep(0.03, 0.40, cluster.f2 - cluster.f1);
  const vein = smoothstep(0.62, 0.92, ridge(u * 46, v * 46, 46, 1607, 2));
  const fine = fbm(u * 120, v * 120, 120, 1609, 2);

  const t = clamp01(0.16 + crown * 0.38 + bigCrown * 0.26 + fine * 0.14 + (leaf.id - 0.5) * 0.28);
  const c = {
    r: lerp(0.038, 0.232, t),
    g: lerp(0.066, 0.318, t),
    b: lerp(0.040, 0.146, t),
  };
  // Some leaves have turned.
  const turn = smoothstep(0.88, 0.99, leaf.id);
  tint(c, 0.386, 0.310, 0.128, turn * 0.45);
  tint(c, c.r * 0.55, c.g * 0.58, c.b * 0.55, vein * 0.35);
  // Deep shadow between clusters.
  tint(c, 0.016, 0.032, 0.018, (1 - bigCrown) * 0.36);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: crown * 0.5 + bigCrown * 0.34 + fine * 0.16,
    rough: 0.72 + fine * 0.14,
  };
};

/** Wrought iron / banded steel: hammer facets, pitting, rust bleeding downward. */
export const metalTexel: TexelFn = (u, v) => {
  const facet = worley(u, v, 16, 1701, 0.85);
  const facetEdge = 1 - smoothstep(0.0, 0.12, facet.f2 - facet.f1);
  const pit = worley(u, v, 60, 1703, 1.0);
  const pitting = smoothstep(0.20, 0.04, pit.f1) * smoothstep(0.55, 0.85, pit.id);
  const rustN = warpedFbm(u * 8, v * 8, 8, 1707, 1.8, 4);
  const run = fbm2p(u * 26, v * 3, 26, 4, 1709, 3);
  const rust = clamp01(smoothstep(0.52, 0.84, rustN) + smoothstep(0.62, 0.92, run) * 0.6);
  const fine = fbm(u * 140, v * 140, 140, 1711, 2);

  const t = clamp01(0.42 + (facet.id - 0.5) * 0.34 + (fine - 0.5) * 0.22);
  const c = {
    r: lerp(0.062, 0.288, t),
    g: lerp(0.064, 0.296, t),
    b: lerp(0.072, 0.318, t),
  };
  tint(c, 0.024, 0.024, 0.028, facetEdge * 0.55);
  tint(c, 0.286, 0.126, 0.048, rust * 0.62);
  tint(c, 0.018, 0.016, 0.016, pitting * 0.6);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: (1 - facetEdge) * (0.5 + facet.id * 0.3) - pitting * 0.35 + fine * 0.1,
    rough: 0.34 + rust * 0.52 + pitting * 0.2,
  };
};

/** Woven banner cloth: warp/weft threads, a dyed border, fold shading, fraying. */
export const clothTexel: TexelFn = (u, v) => {
  const warpTh = Math.sin(u * Math.PI * 2 * 96) * 0.5 + 0.5;
  const weftTh = Math.sin(v * Math.PI * 2 * 96) * 0.5 + 0.5;
  const weave = warpTh * 0.5 + weftTh * 0.5;
  const slub = fbm(u * 44, v * 44, 44, 1801, 2);
  const dye = warpedFbm(u * 5, v * 5, 5, 1803, 1.4, 3);

  // A woven damask lozenge, not a striped band. Anything with a hard edge running
  // along one texture axis turns into a barber pole once the UVs are world-projected
  // onto arbitrarily oriented cloth.
  const lozU = Math.abs(((u * 7) % 1) - 0.5) * 2;
  const lozV = Math.abs(((v * 7) % 1) - 0.5) * 2;
  const loz = 1 - smoothstep(0.55, 0.95, lozU + lozV);
  const pip = 1 - smoothstep(0.0, 0.24, Math.hypot(lozU - 0.0, lozV - 0.0));

  const wearN = smoothstep(0.62, 0.92, fbm(u * 14, v * 14, 14, 1811, 3));

  const t = clamp01(0.44 + (dye - 0.5) * 0.30 + (weave - 0.5) * 0.12 + (slub - 0.5) * 0.14);
  const c = {
    r: lerp(0.196, 0.548, t),
    g: lerp(0.040, 0.132, t),
    b: lerp(0.062, 0.176, t),
  };
  // Gold thread picked out in the damask.
  tint(c, 0.560, 0.428, 0.152, loz * 0.42);
  tint(c, 0.700, 0.556, 0.212, pip * 0.55);
  tint(c, c.r * 0.72, c.g * 0.72, c.b * 0.78, wearN * 0.35);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: weave * 0.34 + loz * 0.4 + slub * 0.26,
    rough: 0.88 + slub * 0.1,
  };
};

/** Broken masonry rubble and loose fieldstone. */
export const rubbleTexel: TexelFn = (u, v) => {
  const chunks = worley(u, v, 9, 1901, 1.0);
  const edge = 1 - smoothstep(0.0, 0.12, chunks.f2 - chunks.f1);
  const small = worley(u, v, 28, 1903, 1.0);
  const smallEdge = 1 - smoothstep(0.0, 0.16, small.f2 - small.f1);
  const grain = fbm(u * 60, v * 60, 60, 1907, 3);
  const dust = warpedFbm(u * 5, v * 5, 5, 1909, 1.5, 3);

  const t = clamp01(0.42 + (chunks.id - 0.5) * 0.44 + (grain - 0.5) * 0.26 + (dust - 0.5) * 0.14);
  const c = {
    r: lerp(0.166, 0.652, t),
    g: lerp(0.152, 0.598, t),
    b: lerp(0.130, 0.508, t),
  };
  tint(c, 0.050, 0.046, 0.040, clamp01(edge * 0.9 + smallEdge * 0.4) * 0.75);
  const moss = smoothstep(0.66, 0.9, dust);
  tint(c, 0.140, 0.180, 0.086, moss * 0.4);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: (1 - edge) * (0.45 + chunks.id * 0.3) + (1 - smallEdge) * 0.2 + grain * 0.1,
    rough: 0.86 + grain * 0.12,
  };
};
