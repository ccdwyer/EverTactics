/**
 * EverTactics — *role* materials.
 *
 * `surfaces.ts` authors one texture per **surface kind** (what the tile is made of).
 * This file authors the textures a tile needs because of the **role a particular face
 * plays** in the architecture — which is a different axis entirely, and the one the
 * round-5 critics named:
 *
 *   > "one brick/plank motif tiled at a single UV scale across walls, floors, roofs and
 *   >  stairs, with no wear, no decals, and no material change between surface types"
 *
 * A real building never uses one stone for everything. A cloister has:
 *
 *   - **paving** underfoot: a few big flags, worn smooth in the middle, grime in the
 *     joints (that is `stoneTexel` in `surfaces.ts`, used at a deliberately large scale),
 *   - **coursed rubble or ashlar** in the wall below it: many small stones, weathering
 *     that runs downward,
 *   - and a **dressed coping / kerb** capping every exposed edge: a single-piece stone,
 *     essentially jointless, paler than everything around it because it is the bit that
 *     gets rained on and walked over, with the arris rounded off by two centuries of feet.
 *
 * That third one is the piece we were missing, and it is the one that does the most work
 * per pixel: it draws a light line along every terrace lip, stair nosing and parapet in
 * the frame, so the eye reads *edges* — the thing that tells you a mass has shape — rather
 * than reading a continuous field of the same brick.
 *
 * `stairTreadTexel` is the same idea applied to a step: a tread is polished in a band
 * where feet land and filthy at its back corners, which no wall texture ever is.
 */

import {
  clamp01,
  fbm,
  hash2,
  lerp,
  masonry,
  ridge,
  smoothstep,
  streak,
  warpedFbm,
  worley,
} from './noise';
import type { Texel } from './surfaces';

function mixTo(
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
// Coping — the dressed stone that caps an exposed edge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A coping stone is long, so the joints across it are *rare*: a 2×1 lattice over the
 * whole repeat rather than the 8×5 of a wall. The rest of the character comes from
 * wear, not from a pattern — which is exactly why it does not read as "more brick".
 *
 * It is authored a stop and a half brighter than `stoneTexel` so that, under any key
 * direction, it separates from the paving it borders by value rather than only by hue.
 * That is what makes the terrace lips legible when the whole frame is graded to one
 * warm note.
 */
export const copingTexel = (u: number, v: number): Texel => {
  const b = masonry(u, v, 2, 3, 811, 0.22, 0.5);

  // Joints exist but are thin and clean — a coping is cut, not laid.
  const jointRaw = 1 - smoothstep(0.0, 0.008, b.edge);
  const bevel = 1 - smoothstep(0.006, 0.038, b.edge);

  // Saw / chisel dressing across the face, at a per-stone angle.
  const tool = streak(u, v, 26, 821, b.rot * Math.PI, 2.2, 3);
  const grit = fbm(u * 150, v * 150, 150, 823, 2);
  const vein = smoothstep(0.66, 0.95, ridge(u * 8, v * 8, 8, 827, 3));

  // Chips knocked off the arris. Sparse — a few per stone, not a crumbling ruin.
  const chipCell = worley(u, v, 15, 829, 1.0);
  const chip = smoothstep(0.24, 0.06, chipCell.f1) * smoothstep(0.62, 0.9, chipCell.id);

  // Per-stone tone spread is deliberately *wide* (±0.25 rather than the ±0.15 a wall
  // gets). A coping run whose stones all match reads as a drawn outline round the model
  // — which is the "shader-constant edge highlight" the critics called out — whereas a
  // run where one stone in four is noticeably darker reads as separately quarried pieces.
  const t = clamp01(0.5 + (b.tone - 0.5) * 0.5 + (tool - 0.5) * 0.2 + (grit - 0.5) * 0.08);
  // Warm, sun-bleached limestone. Only about a stop lighter than the paving it caps: any
  // more and the kerb stops being stone and becomes a highlight pass.
  const c = {
    r: lerp(0.268, 0.812, t),
    g: lerp(0.248, 0.766, t),
    b: lerp(0.208, 0.652, t),
  };

  mixTo(c, 0.882, 0.866, 0.812, vein * 0.35);

  // The polish a coping gets from hands and boots: brighter and smoother mid-stone.
  const polish = smoothstep(0.10, 0.34, b.edge) * (0.55 + b.tone * 0.45);
  mixTo(c, c.r * 1.06 + 0.02, c.g * 1.04 + 0.018, c.b * 1.0 + 0.014, polish * 0.4);

  // Weathering that is *not* symmetric about the stone. A coping sheds water off one
  // face, so one long side is bleached and the other stained; without this the band is
  // uniform along its whole length and the eye reads a line rather than a course.
  const shed = smoothstep(0.55, 1.0, v) * (0.4 + fbm(u * 7, v * 7, 7, 857, 3) * 0.6);
  mixTo(c, c.r * 0.68, c.g * 0.7, c.b * 0.74, shed * 0.38);

  // Dirt does not sit on a coping's crown; it collects in the joints and the chips.
  const grimeN = fbm(u * 20, v * 20, 20, 839, 3);
  const grime = clamp01(jointRaw * (0.55 + grimeN * 0.45) + bevel * 0.22 + chip * 0.7);
  mixTo(c, 0.140, 0.122, 0.096, grime * 0.72);

  // A thread of moss only where two joints meet — damp corners, nothing else.
  const damp = smoothstep(0.6, 0.9, warpedFbm(u * 5, v * 5, 5, 853, 1.4, 3));
  mixTo(c, 0.150, 0.204, 0.098, clamp01(jointRaw * 1.1) * damp * 0.55);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: (1 - jointRaw) * (0.62 + tool * 0.2) - bevel * 0.2 - chip * 0.34,
    rough: 0.66 - polish * 0.26 + grime * 0.2,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Stair tread — paving that is walked *across* rather than stood on
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The give-away of a real step is that its wear is *directional*: a bright, smooth,
 * slightly dished band down the middle where every foot has landed for a century, and
 * black filth banked up in the two back corners where a broom never reaches.
 *
 * `v` runs along the direction of travel (the terrain builder projects world Z on top
 * faces), so the polished band is a function of `u` alone.
 */
export const stairTreadTexel = (u: number, v: number): Texel => {
  const b = masonry(u, v, 3, 2, 857, 0.2, 0.36);

  const jointRaw = 1 - smoothstep(0.0, 0.011, b.edge);
  const bevel = 1 - smoothstep(0.010, 0.044, b.edge);

  const grain = streak(u, v, 20, 859, b.rot * Math.PI, 2.6, 3);
  const grit = fbm(u * 140, v * 140, 140, 863, 2);
  const pit = worley(u, v, 30, 877, 1.0);
  const pitting = smoothstep(0.18, 0.06, pit.f1) * smoothstep(0.72, 0.95, pit.id);

  const t = clamp01(0.46 + (b.tone - 0.5) * 0.42 + (grain - 0.5) * 0.24 + (grit - 0.5) * 0.1);
  const c = {
    r: lerp(0.226, 0.792, t),
    g: lerp(0.202, 0.716, t),
    b: lerp(0.166, 0.578, t),
  };

  // The traffic band. Wanders a little so it is not a printed stripe.
  const wander = (fbm(v * 3.1, 0.5, 8, 881, 2) - 0.5) * 0.16;
  const band = smoothstep(0.42, 0.1, Math.abs(u - 0.5 - wander));
  mixTo(c, c.r * 1.18 + 0.045, c.g * 1.14 + 0.04, c.b * 1.06 + 0.03, band * 0.55);

  // Filth banked at the ends of the tread, away from the traffic.
  const corner = clamp01(1 - band) * smoothstep(0.35, 0.85, fbm(u * 9, v * 9, 9, 883, 3));
  mixTo(c, 0.106, 0.094, 0.074, corner * 0.5);

  const grime = clamp01(jointRaw * 0.85 + bevel * 0.3);
  mixTo(c, 0.112, 0.098, 0.078, grime * 0.8);
  mixTo(c, 0.15, 0.136, 0.11, pitting * 0.18);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    // The dish: the middle of the tread is genuinely lower than its ends.
    h: (1 - jointRaw) * (0.56 + grain * 0.22) - band * 0.16 - bevel * 0.2,
    rough: 0.76 - band * 0.34 + grime * 0.16,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Timber nosing — the same role, in wood
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The edge board of a plank deck. Runs *along* the edge, so it is one continuous
 * member with end grain only where two boards butt — again, deliberately far coarser
 * than the planking it caps, so a deck lip reads as a lip.
 */
export const nosingTexel = (u: number, v: number): Texel => {
  const along = u;
  const across = v;
  // Butt joints are rare.
  const seg = Math.floor(along * 2 + hash2(Math.floor(across * 2), 0, 887) * 0.5);
  const segRand = hash2(seg, Math.floor(across * 2), 891);
  const butt = smoothstep(0.014, 0.0, Math.abs(along * 2 - Math.round(along * 2)) * 0.5);

  const grain = streak(u, v, 40, 893, 0, 5.5, 3);
  const rings = smoothstep(0.5, 0.95, ridge(along * 30, across * 5, 30, 899, 3));
  const grit = fbm(u * 120, v * 120, 120, 907, 2);

  const t = clamp01(0.48 + (segRand - 0.5) * 0.3 + (grain - 0.5) * 0.4 + (grit - 0.5) * 0.1);
  const c = {
    r: lerp(0.206, 0.660, t),
    g: lerp(0.146, 0.470, t),
    b: lerp(0.096, 0.288, t),
  };
  mixTo(c, 0.148, 0.106, 0.070, rings * 0.4);

  // Bleached, splintered upper arris — the bit the weather gets at.
  const weather = smoothstep(0.62, 1.0, across) * (0.5 + grit * 0.5);
  mixTo(c, 0.520, 0.470, 0.392, weather * 0.42);

  const grime = clamp01(butt * 0.8 + smoothstep(0.16, 0.0, across) * 0.7);
  mixTo(c, 0.086, 0.062, 0.044, grime * 0.72);

  return {
    r: c.r,
    g: c.g,
    b: c.b,
    h: 0.55 + grain * 0.3 - butt * 0.4 - rings * 0.12,
    rough: 0.84 + grime * 0.12 - weather * 0.1,
  };
};
