/**
 * EverTactics — CPU-side procedural noise toolkit for terrain texture authoring.
 *
 * Everything in here is **tileable**: every function takes a lattice `period` and wraps
 * its integer lattice at that period, so a texture baked by sampling `u,v in [0,1)` with
 * matching periods tiles seamlessly. That matters because the terrain projects textures
 * in world space across tile boundaries — a seam would show up as a grid line, which is
 * exactly the tell we are trying to kill.
 *
 * The set is deliberately richer than "one fbm": readable surfaces need
 *
 *   - value / fBm noise for broad tonal drift,
 *   - *worley* (cellular) noise for anything made of discrete lumps — stone blocks,
 *     grass clumps, gravel, lichen patches,
 *   - domain warping so features stop looking like a Perlin heightfield,
 *   - directional (anisotropic) noise for blade streaks and erosion runs,
 *   - a running-bond masonry lattice with jittered courses and per-block ids.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

export function hash2(xi: number, yi: number, seed: number): number {
  let h = Math.imul(xi | 0, 374761393) + Math.imul(yi | 0, 668265263) + Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function wrap(a: number, p: number): number {
  return ((a % p) + p) % p;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Signed remap of a 0..1 value around 0.5. */
export function bipolar(v: number): number {
  return v * 2 - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Value noise / fBm
// ─────────────────────────────────────────────────────────────────────────────

/** Tileable value noise with integer lattice period `period`. */
export function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  // quintic fade — smoother second derivative than smoothstep, which stops the
  // derived normal map from showing the lattice as a faint diamond grid.
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
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
export function fbm(x: number, y: number, period: number, seed: number, octaves = 4): number {
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

/** Ridged multifractal — sharp creases, good for cracks, veins and strata edges. */
export function ridge(x: number, y: number, period: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * f, y * f, period * f, seed + o * 79) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/**
 * fBm sampled through a noise-warped domain. This is the cheapest way to stop a
 * procedural surface reading as "Perlin": features stop being isotropic blobs and
 * start having flow, curl and pooling.
 */
export function warpedFbm(
  x: number,
  y: number,
  period: number,
  seed: number,
  strength: number,
  octaves = 4,
): number {
  const wx = fbm(x, y, period, seed + 911, 2) - 0.5;
  const wy = fbm(x + 5.2, y + 1.3, period, seed + 977, 2) - 0.5;
  return fbm(x + wx * strength, y + wy * strength, period, seed, octaves);
}

/**
 * Anisotropic noise: stretched `aniso`x along the `angle` direction. Blade streaks,
 * wood grain, erosion runs and brush strokes are all this.
 */
export function streak(
  u: number,
  v: number,
  period: number,
  seed: number,
  angle: number,
  aniso: number,
  octaves = 3,
): number {
  // NOTE: unlike `fbm`, this takes *normalised* u,v in 0..1 and scales by the period
  // itself — the anisotropy has to be applied to the lattice, not to the caller's
  // coordinates, or the two cancel out and the result is featureless.
  const px = Math.max(1, Math.round(period));
  const py = Math.max(1, Math.round(period * aniso));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const wu = u + (fbm(u * 5, v * 5, 5, seed + 33, 2) - 0.5) * 0.09 * c;
  const wv = v + (fbm(u * 5 + 3.1, v * 5 + 7.7, 5, seed + 37, 2) - 0.5) * 0.09 * s;
  return fbm2p(wu * px, wv * py, px, py, seed, octaves);
}

/** fBm with independent x/y lattice periods (for stretched features). */
export function fbm2p(
  x: number,
  y: number,
  px: number,
  py: number,
  seed: number,
  octaves = 3,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2p(x * f, y * f, px * f, py * f, seed + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function valueNoise2p(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const x0 = wrap(xi, px);
  const y0 = wrap(yi, py);
  const x1 = wrap(xi + 1, px);
  const y1 = wrap(yi + 1, py);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worley / cellular
// ─────────────────────────────────────────────────────────────────────────────

export interface WorleyResult {
  /** Distance to the nearest feature point, in cell units. */
  f1: number;
  /** Distance to the second nearest — `f2 - f1` gives clean cell borders. */
  f2: number;
  /** Deterministic 0..1 id of the owning cell, for per-cell tinting. */
  id: number;
  /** Integer cell coordinates of the owner, wrapped into the period. */
  cx: number;
  cy: number;
}

/**
 * Tileable Worley noise on a `cells`x`cells` lattice. `jitter` in 0..1 controls how
 * far each feature point wanders from its cell centre (1 = fully irregular Voronoi,
 * 0 = a regular grid).
 */
export function worley(
  x: number,
  y: number,
  cells: number,
  seed: number,
  jitter = 1,
): WorleyResult {
  const fx = x * cells;
  const fy = y * cells;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  let bx = 0;
  let by = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = ix + ox;
      const gy = iy + oy;
      const wx = wrap(gx, cells);
      const wy = wrap(gy, cells);
      const px = gx + 0.5 + (hash2(wx, wy, seed) - 0.5) * jitter;
      const py = gy + 0.5 + (hash2(wx, wy, seed + 7919) - 0.5) * jitter;
      const d = Math.hypot(fx - px, fy - py);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 104729);
        bx = wx;
        by = wy;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, id, cx: bx, cy: by };
}

/**
 * Anisotropic Worley — feature cells stretched by `ax`/`ay`. Used for grass clumps
 * (slightly elongated along the blade direction) and for flagstones.
 */
export function worleyAniso(
  x: number,
  y: number,
  cellsX: number,
  cellsY: number,
  seed: number,
  jitter = 1,
): WorleyResult {
  const fx = x * cellsX;
  const fy = y * cellsY;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;
  let bx = 0;
  let by = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const gx = ix + ox;
      const gy = iy + oy;
      const wx = wrap(gx, cellsX);
      const wy = wrap(gy, cellsY);
      const px = gx + 0.5 + (hash2(wx, wy, seed) - 0.5) * jitter;
      const py = gy + 0.5 + (hash2(wx, wy, seed + 7919) - 0.5) * jitter;
      const d = Math.hypot(fx - px, fy - py);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 104729);
        bx = wx;
        by = wy;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, id, cx: bx, cy: by };
}

// ─────────────────────────────────────────────────────────────────────────────
// Masonry lattice
// ─────────────────────────────────────────────────────────────────────────────

export interface Block {
  /** 0..1 across the block, x then y. */
  u: number;
  v: number;
  /** Distance to the nearest block edge, in *texture* units (not block units). */
  edge: number;
  /** Deterministic per-block randoms. */
  tone: number;
  rot: number;
  id: number;
  /** Row index (course) and column index within it. */
  row: number;
  col: number;
  /** Block extents in texture units, for aspect-correct detailing. */
  w: number;
  h: number;
}

/**
 * A running-bond masonry lattice with *irregular* course heights and per-course block
 * widths. Real walls are not a checkerboard: the courses vary in thickness, blocks
 * within a course vary in length, and the vertical joints wander.
 *
 * `rows` is the nominal number of courses across the 0..1 texture; `cols` the nominal
 * blocks per course. Both are jittered per index while keeping the total exactly
 * periodic, so the result still tiles.
 */
export function masonry(
  u: number,
  v: number,
  rows: number,
  cols: number,
  seed: number,
  courseJitter = 0.34,
  runJitter = 0.4,
): Block {
  // Course boundaries: cumulative jittered heights normalised to exactly 1.
  const heights: number[] = [];
  let total = 0;
  for (let i = 0; i < rows; i++) {
    const hgt = 1 + (hash2(i, 0, seed + 11) - 0.5) * 2 * courseJitter;
    heights.push(hgt);
    total += hgt;
  }
  let acc = 0;
  let row = 0;
  let v0 = 0;
  let v1 = 1;
  const vt = wrap(v, 1);
  for (let i = 0; i < rows; i++) {
    const next = acc + heights[i]! / total;
    if (vt < next || i === rows - 1) {
      row = i;
      v0 = acc;
      v1 = next;
      break;
    }
    acc = next;
  }
  const rowH = Math.max(1e-5, v1 - v0);
  const fv = (vt - v0) / rowH;

  // Column boundaries within the course, offset by a per-course running bond.
  const nCols = Math.max(1, Math.round(cols + (hash2(row, 1, seed + 23) - 0.5) * 2));
  const widths: number[] = [];
  let wTotal = 0;
  for (let i = 0; i < nCols; i++) {
    const w = 1 + (hash2(row, i, seed + 31) - 0.5) * 2 * runJitter;
    widths.push(w);
    wTotal += w;
  }
  const bond = hash2(row, 2, seed + 41);
  const ut = wrap(u + bond, 1);
  let uacc = 0;
  let col = 0;
  let u0 = 0;
  let u1 = 1;
  for (let i = 0; i < nCols; i++) {
    const next = uacc + widths[i]! / wTotal;
    if (ut < next || i === nCols - 1) {
      col = i;
      u0 = uacc;
      u1 = next;
      break;
    }
    uacc = next;
  }
  const colW = Math.max(1e-5, u1 - u0);
  const fu = (ut - u0) / colW;

  // Wobble the joint so it is a chiselled line, not a CAD line.
  const wob =
    (fbm(u * 26, v * 26, 26, seed + 53, 2) - 0.5) * 0.012 +
    (fbm(u * 90, v * 90, 90, seed + 59, 2) - 0.5) * 0.005;
  const du = Math.min(fu, 1 - fu) * colW + wob;
  const dv = Math.min(fv, 1 - fv) * rowH + wob;

  return {
    u: fu,
    v: fv,
    edge: Math.min(du, dv),
    tone: hash2(col, row, seed + 61),
    rot: hash2(col, row, seed + 67),
    id: hash2(col * 7 + 1, row * 13 + 3, seed + 71),
    row,
    col,
    w: colW,
    h: rowH,
  };
}
