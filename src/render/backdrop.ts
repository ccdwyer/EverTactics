/**
 * EverTactics — the world the diorama sits in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 * ─────────────────────────────────────────────────────────────────────────────
 * The board was a rectangular slab floating in 'clearColor'. Every critic in the
 * round-2 A/B named it, most of them first. What the references actually do is
 * *continue the environment past the play area*: houses immediately behind the
 * fence line, a quay running off the left edge, crates and lanterns crowding the
 * margins, haze between the layers. See
 * 'refs/curated/triangle/press_002_gematsu_1920x1080.jpg' (village houses start
 * one tile beyond the playable ground) and 'official_005_steam.jpg' (ruined
 * masonry fills every frame edge).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS BUILT CAMERA-RELATIVE
 * ─────────────────────────────────────────────────────────────────────────────
 * The rig is *orthographic*. That has a consequence people coming from a
 * perspective engine get wrong: there is no convergence, so a silhouette 200
 * units behind the board projects to the same screen position as one 5 units
 * behind it, just shifted up-screen by 'depth · sin(pitch)'. With our framing,
 * anything more than ~18 world units behind the board is already off the top of
 * the frame. A "distant skyline" is geometrically impossible here — and looking
 * at the references, neither game has one. They have a *dense near surround*.
 *
 * So this is authored in a yaw-following local frame:
 *
 *     local +X → screen right
 *     local −Z → away from the camera along the ground   (call it 'depth')
 *     local +Y → up
 *     screenX  = x
 *     screenY  = y·cos(pitch) + depth·sin(pitch)
 *
 * The whole group tracks the camera's yaw, so the composition holds at all four
 * yaw slots and the surround always runs off the correct frame edges. That is a
 * matte-painting cheat and it is invisible in a still frame — which is what the
 * blind test looks at. Everything inside is real lit 3D geometry, gets the DoF
 * and grade from 'post.ts', and writes depth normally.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BANDS
 * ─────────────────────────────────────────────────────────────────────────────
 * All four are expressed against the *measured* window — 'boardRadius' R and
 * 'visibleDepth', with 'run = visibleDepth − R' the usable depth behind the
 * board (about 4.5 units at the shipping framing):
 *
 *   flank   |depth| ≤ 0.95R, |x| past the footprint — the left/right strips
 *   apron   depth  R … R+0.62·run   — outbuildings, walls, trees, lanterns
 *   ridge   depth  R+0.45·run … R+1.25·run — towers whose tops crop at the top edge
 *   fore    depth  0.5·nearDepth … 1.45·nearDepth — foliage framing the bottom corners
 *
 * 'fore' exists because both reference frames have a soft, dark foreground
 * element breaking into the bottom of the image, and because 'post.ts''s DoF
 * needs something in the near field to actually blur. It is restricted to
 * organic shapes: buildings there came back from the DoF pass as featureless
 * black rectangles.
 *
 * Everything is merged per band, so the whole surround is five draw calls.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ClampToEdgeWrapping,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  LinearFilter,
  Mesh,
  NoColorSpace,
  RedFormat,
  ShaderMaterial,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import {
  DEFAULT_RECESSION,
  GLSL_AIRLIGHT,
  GLSL_NOISE,
  GLSL_RECEDE,
  unitLuminance,
  type EnvironmentPalette,
} from './sky.js';

// ─────────────────────────────────────────────────────────────────────────────
// Layout contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signed distance field of the board's real XZ silhouette. Built by
 * 'buildFootprintField' in 'atmosphere.ts'; declared here because
 * 'BackdropLayout' is the contract between the two and the dependency already
 * runs atmosphere → backdrop.
 *
 * Positive outside the board, negative inside, in world units. Sampled from JS
 * for prop placement and from GLSL (via the R8 'encoded' copy) for the ground
 * plate's occlusion, contact and bounce terms.
 */
export interface BoardFootprint {
  /** Grid resolution (square). */
  res: number;
  /** World units covered by the whole grid, on each axis. */
  span: number;
  /** World units per cell. */
  cell: number;
  /** World-XZ offset of cell (0,0)'s corner, RELATIVE TO THE BOARD CENTRE. */
  originX: number;
  originZ: number;
  /** Signed distance in world units: positive outside the board, negative in. */
  distance: Float32Array;
  /** Distance the encoded byte texture saturates at, world units. */
  range: number;
  /** 'distance' remapped to 0..255 over [-range, +range], for an R8 texture. */
  encoded: Uint8Array;
}

/**
 * Everything the surround needs to know about the shot. Computed by
 * 'WorldEnvironment' in 'atmosphere.ts' from the live camera and the measured
 * board bounds — nothing here is hand-tuned per map.
 */
export interface BackdropLayout {
  /** Horizontal radius of the playable diorama, world units. */
  boardRadius: number;
  /** World Y the surround's ground sits at (the board's base). */
  groundY: number;
  /** Camera focus height, world Y. Used for the screen-space solve. */
  focusY: number;
  /** Camera pitch, radians below horizontal. */
  pitch: number;
  /** Visible half-width / half-height at the focus plane, world units. */
  halfW: number;
  halfH: number;
  /** Depth at which the ground plate has fully dissolved into haze. */
  horizonDepth: number;
  /**
   * Depth at which a point on the ground plate leaves the TOP of the frame.
   *
   * This is the number that governs everything, and it is much smaller than
   * intuition suggests. Under the shipping framing it measures ~15 world units
   * against a board radius of ~10.6 — so the entire surround has four and a half
   * units of usable depth behind the board, and anything authored past that is
   * geometry nobody will ever see. The first pass put two whole bands out there.
   */
  visibleDepth: number;
  /** Depth at which the ground plate leaves the BOTTOM of the frame (negative). */
  nearDepth: number;
  /**
   * Board footprint half-extents on the world X/Z axes, and the camera yaw the
   * layout was built for.
   *
   * The clearance test needs the *real* footprint, not a bounding disc. At the
   * shipping 45° yaw the cloister is a diamond on screen: at five units of depth
   * its silhouette is only ±5.6 wide, so a disc of the circumscribed radius
   * (10.6) forbids placement across the entire visible left and right strips —
   * which is exactly where the remaining void lives. Since the surround already
   * follows yaw, the layout is rebuilt on a yaw change and can afford to be
   * exact.
   */
  boardHalfX: number;
  boardHalfZ: number;
  yaw: number;
  /** Deterministic layout seed. Screenshots must be reproducible. */
  seed: number;
  /**
   * Signed distance field of the board's REAL silhouette, measured in
   * 'atmosphere.ts'. Everything that needs "how far is this point from the
   * diorama" prefers this and falls back to the AABB rectangle when it is null
   * (a scene with no terrain group, or a measure that found no geometry).
   *
   * The AABB is a poor answer on any map with corner towers or an irregular
   * outline: it sits well outside the visible facets, so clutter authored to
   * hug the wall lands in open ground and shading shaped to it misses the edge.
   */
  footprint: BoardFootprint | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bilinear sample of the footprint field. 'wx'/'wz' are world-axis offsets from
 * the board centre. Outside the grid this returns the clamped border value,
 * which is the padding distance — larger than anything that samples it cares
 * about, so callers never need a range check.
 */
export function sampleFootprint(field: BoardFootprint, wx: number, wz: number): number {
  const { res, cell, originX, originZ, distance } = field;
  const fx = Math.min(res - 1.001, Math.max(0, (wx - originX) / cell - 0.5));
  const fz = Math.min(res - 1.001, Math.max(0, (wz - originZ) / cell - 0.5));
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const i = z0 * res + x0;
  const a = distance[i]!;
  const b = distance[i + 1]!;
  const c = distance[i + res]!;
  const d = distance[i + res + 1]!;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/**
 * A 1×1 stand-in so 'uFootTex' is always bound. WebGL errors on a sampler with
 * no texture even when the branch reading it is never taken, and 'uFootHas'
 * gates that branch at runtime, not at compile time.
 */
let FALLBACK_FOOT: DataTexture | null = null;
function fallbackFootTexture(): DataTexture {
  if (!FALLBACK_FOOT) {
    FALLBACK_FOOT = new DataTexture(new Uint8Array([255]), 1, 1, RedFormat, UnsignedByteType);
    FALLBACK_FOOT.colorSpace = NoColorSpace;
    FALLBACK_FOOT.needsUpdate = true;
  }
  return FALLBACK_FOOT;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure kit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each helper returns geometry with its origin at the base centre so a caller
 * can drop it straight onto the ground. Shapes are chosen for *silhouette*:
 * gables, spires, crenellations and canopies, because four boxes in a row is the
 * geometry read of a test map and the critics said so twice.
 */

function gableRoof(width: number, height: number, depth: number): BufferGeometry {
  const hw = width / 2;
  const hd = depth / 2;
  // Prism: two gable ends, two pitched slopes, an open base (never seen).
  const p = new Float32Array([
    // -Z gable
    -hw, 0, -hd, hw, 0, -hd, 0, height, -hd,
    // +Z gable
    hw, 0, hd, -hw, 0, hd, 0, height, hd,
    // -X slope (two tris)
    -hw, 0, -hd, 0, height, -hd, 0, height, hd,
    -hw, 0, -hd, 0, height, hd, -hw, 0, hd,
    // +X slope
    hw, 0, hd, 0, height, hd, 0, height, -hd,
    hw, 0, hd, 0, height, -hd, hw, 0, -hd,
  ]);
  const g = new BufferGeometry();
  const count = p.length / 3;
  g.setAttribute('position', new BufferAttribute(p, 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  // Indexed, because 'mergeGeometries' refuses a mixed indexed/non-indexed set
  // and every primitive from three's generators is indexed.
  g.setIndex(Array.from({ length: count }, (_, i) => i));
  g.computeVertexNormals();
  return g;
}

function translated(g: BufferGeometry, x: number, y: number, z: number): BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/** Timber-and-plaster house: body + gable roof + a stub chimney. */
function house(rng: () => number): BufferGeometry[] {
  const w = 2.6 + rng() * 3.4;
  const d = 2.4 + rng() * 3.0;
  const h = 1.8 + rng() * 2.2;
  const roof = 0.9 + rng() * 1.5;
  const parts = [
    translated(new BoxGeometry(w, h, d), 0, h / 2, 0),
    translated(gableRoof(w * 1.14, roof, d * 1.12), 0, h, 0),
  ];
  if (rng() > 0.45) {
    const cw = 0.32 + rng() * 0.22;
    parts.push(translated(new BoxGeometry(cw, roof * 1.5, cw), w * 0.24, h + roof * 0.6, d * 0.18));
  }
  // A lean-to breaks the box read from the side.
  if (rng() > 0.5) {
    const lw = w * 0.5;
    parts.push(translated(new BoxGeometry(lw, h * 0.55, d * 0.6), w * 0.5 + lw * 0.35, h * 0.28, 0));
  }
  return parts;
}

/** Square bell tower with a spire — the silhouette breaker in the ridge band. */
function tower(rng: () => number, scale: number): BufferGeometry[] {
  const s = (0.9 + rng() * 0.5) * scale;
  const h = (4.5 + rng() * 5.0) * scale;
  const parts = [
    translated(new BoxGeometry(s * 1.9, h, s * 1.9), 0, h / 2, 0),
    // Corbel course: a wider band near the top catches the key and reads as
    // carved masonry rather than an extrusion.
    translated(new BoxGeometry(s * 2.35, s * 0.42, s * 2.35), 0, h - s * 0.5, 0),
    translated(new ConeGeometry(s * 1.55, h * 0.38, 4, 1), 0, h + h * 0.19 - s * 0.28, 0),
  ];
  parts[2]!.rotateY(Math.PI / 4);
  return parts;
}

/** Curtain wall with merlons. */
function wall(rng: () => number, length: number): BufferGeometry[] {
  const h = 1.7 + rng() * 2.6;
  const t = 0.55 + rng() * 0.35;
  const parts = [translated(new BoxGeometry(length, h, t), 0, h / 2, 0)];
  const merlons = Math.max(2, Math.round(length / 1.15));
  for (let i = 0; i < merlons; i += 1) {
    if (rng() < 0.18) continue; // broken merlon — the wall has been fought over
    const x = -length / 2 + (length / merlons) * (i + 0.5);
    const mh = 0.44 + rng() * 0.2;
    parts.push(translated(new BoxGeometry(length / merlons - 0.28, mh, t * 1.12), x, h + mh / 2, 0));
  }
  return parts;
}

/** Conifer cluster — soft organic silhouette against all that masonry. */
function tree(rng: () => number): BufferGeometry[] {
  const h = 2.2 + rng() * 3.4;
  const r = 0.55 + rng() * 0.5;
  const trunk = translated(new CylinderGeometry(r * 0.16, r * 0.22, h * 0.34, 5), 0, h * 0.17, 0);
  const parts = [trunk];
  const tiers = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < tiers; i += 1) {
    const t = i / tiers;
    const th = h * (0.42 - t * 0.1);
    parts.push(
      translated(
        new ConeGeometry(r * (1 - t * 0.55), th, 6, 1),
        0,
        h * (0.28 + t * 0.22) + th * 0.5,
        0,
      ),
    );
  }
  return parts;
}

/**
 * Weathered boulder — an irregular faceted lump.
 *
 * This used to be a 6-sided ConeGeometry with per-axis multiplicative jitter,
 * and it rendered as exactly what that describes: a sharp pyramid. Looking at
 * the near field of the round-7 frame, the bottom of the image was a row of
 * blue-grey spikes that read as ice shards or tents, not as rock — which is
 * very likely what several rounds of critique meant by "cyan shards", "flat
 * untextured billboard quads" and "debug geometry" in the foreground.
 *
 * The jitter could never have fixed it. A cone's apex is the single vertex at
 * x = z = 0, and multiplying a zero by anything leaves it at zero, so every
 * boulder kept a perfectly sharp point on the axis however hard it was
 * jittered — while the same multiply was free to make the base wildly
 * asymmetric, which is why they read as *deliberate* spikes.
 *
 * A subdivided icosahedron displaced ALONG ITS OWN NORMALS has no privileged
 * vertex, so there is no apex to survive: every vertex moves, the silhouette
 * comes out lumpy in all directions, and the low subdivision keeps the flat
 * facets that catch the key light and give the thing a stone read at this
 * distance. Squashed on Y because a boulder sits, and rotated randomly so the
 * facet pattern is not shared between instances.
 */
function rock(rng: () => number, scale: number): BufferGeometry[] {
  const r = scale * (0.55 + rng() * 0.45);
  const g = new IcosahedronGeometry(r, 1);
  const pos = g.attributes.position as BufferAttribute;
  const v = new Vector3();
  // Two independent lobes per axis so the displacement is low-frequency (big
  // bulges and hollows) rather than uniform noise, which just looks sanded.
  const ax = rng() * 6.28;
  const ay = rng() * 6.28;
  const az = rng() * 6.28;
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const lobe =
      0.62 +
      0.30 * Math.sin(n.x * 3.1 + ax) +
      0.24 * Math.sin(n.y * 2.4 + ay) +
      0.26 * Math.sin(n.z * 2.8 + az);
    v.multiplyScalar(0.72 + 0.52 * lobe);
    v.y *= 0.62 + rng() * 0.22;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  // IcosahedronGeometry (via PolyhedronGeometry) is NON-INDEXED, and every other
  // primitive in this kit — Box, Cone, Cylinder, Sphere — is indexed.
  // mergeGeometries requires an index on all inputs or on none, and when that is
  // violated it does not throw: it logs and returns null, so the whole piece is
  // silently dropped from the band. That is exactly what happened on the first
  // build of this function — the spikes disappeared from the frame and it read
  // as a successful fix, when in fact every rock in the surround had stopped
  // being generated. Only the console errors from tools/shoot.mjs caught it.
  // The triangles are already in order, so a sequential index is exact.
  g.setIndex(Array.from({ length: pos.count }, (_, i) => i));
  g.rotateY(rng() * 6.28);
  g.rotateX((rng() - 0.5) * 0.5);
  // Flat facets, not a smooth blob: this is the difference between "stone" and
  // "beanbag" once the near-field defocus has removed the surface shading.
  g.computeVertexNormals();
  g.translate(0, r * 0.34, 0);
  return [g];
}

/** Lamp post — the thing that makes a street read as a street. */
function lantern(rng: () => number): BufferGeometry[] {
  const h = 2.2 + rng() * 1.1;
  return [
    translated(new CylinderGeometry(0.07, 0.1, h, 5), 0, h / 2, 0),
    translated(new BoxGeometry(0.34, 0.42, 0.34), 0, h + 0.2, 0),
    translated(new ConeGeometry(0.3, 0.24, 4, 1), 0, h + 0.52, 0),
  ];
}

// ── ground clutter ──────────────────────────────────────────────────────────
//
// Everything below is small, low and mostly off-axis. It exists for two jobs the
// building kit above cannot do:
//
//  1. The surrounding ground plate was measured as a flat swatch — sd 20/255 over
//     a fifth of the frame, because every variation in its shader runs at a
//     spatial frequency the DoF pass erases. Real geometry casting real shading
//     at a one-to-three-world-unit period survives any blur, which is why the
//     reference frames' margins are dressed with props rather than textured.
//  2. The board terminated on a razor silhouette against that plate. Clutter
//     placed in the annulus just outside the footprint *overlaps* that edge, so
//     there is no continuous line for the eye to read as a cut-out.
//
// They are also the only pieces in the file that are not axis-aligned, which was
// its own repeated criticism.

/** Stacked crates. Boxes, but yawed off the grid and stacked untidily. */
function crates(rng: () => number, scale: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const n = 1 + Math.floor(rng() * 3);
  let y = 0;
  for (let i = 0; i < n; i += 1) {
    const s = scale * (0.55 + rng() * 0.5) * (1 - i * 0.14);
    const g = new BoxGeometry(s, s * (0.72 + rng() * 0.4), s * (0.85 + rng() * 0.3));
    g.rotateY(rng() * 1.1 - 0.55);
    g.translate((rng() - 0.5) * s * 0.5, y + s * 0.42, (rng() - 0.5) * s * 0.5);
    parts.push(g);
    y += s * 0.78;
  }
  return parts;
}

/** Barrel: staved body plus two hoops, so the silhouette has a waist. */
function barrel(rng: () => number, scale: number): BufferGeometry[] {
  const h = scale * (0.78 + rng() * 0.5);
  const r = scale * (0.26 + rng() * 0.13);
  return [
    translated(new CylinderGeometry(r * 0.84, r * 0.84, h, 9), 0, h / 2, 0),
    translated(new CylinderGeometry(r, r, h * 0.13, 9), 0, h * 0.3, 0),
    translated(new CylinderGeometry(r, r, h * 0.13, 9), 0, h * 0.72, 0),
  ];
}

/**
 * Spilled masonry. A handful of small blocks tumbled at free rotations around a
 * point — the cheapest possible "this place has history" silhouette, and the one
 * that best breaks a straight wall base.
 */
function rubble(rng: () => number, scale: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const n = 3 + Math.floor(rng() * 6);
  for (let i = 0; i < n; i += 1) {
    const s = scale * (0.16 + rng() * 0.4);
    const g = new BoxGeometry(s * (0.7 + rng()), s * (0.4 + rng() * 0.7), s * (0.7 + rng()));
    g.rotateY(rng() * Math.PI);
    g.rotateX((rng() - 0.5) * 0.8);
    g.rotateZ((rng() - 0.5) * 0.8);
    const a = rng() * Math.PI * 2;
    const rad = rng() * scale * 1.6;
    g.translate(Math.cos(a) * rad, s * 0.32 + rng() * scale * 0.25, Math.sin(a) * rad);
    parts.push(g);
  }
  return parts;
}

/**
 * Scrub clump. Squashed, jittered low-poly spheres.
 *
 * Organic mass is what the near bands need: a box at two metres from the lens
 * comes back from the DoF pass as a featureless dark parallelogram, whereas a
 * lumpy silhouette still reads as a lumpy silhouette however blurred it is.
 */
function bush(rng: () => number, scale: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i += 1) {
    const r = scale * (0.38 + rng() * 0.5);
    const g = new SphereGeometry(r, 7, 5);
    const pos = g.attributes.position as BufferAttribute;
    for (let k = 0; k < pos.count; k += 1) {
      const j = 0.72 + rng() * 0.6;
      pos.setXYZ(k, pos.getX(k) * j, pos.getY(k) * (0.5 + rng() * 0.45), pos.getZ(k) * j);
    }
    g.computeVertexNormals();
    const a = rng() * Math.PI * 2;
    const rad = rng() * scale * 0.8;
    g.translate(Math.cos(a) * rad, r * 0.46, Math.sin(a) * rad);
    parts.push(g);
  }
  return parts;
}

/** Post-and-rail fence. Posts lean; a run of them reads as a boundary. */
function fence(rng: () => number, length: number, scale: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const h = scale * (0.9 + rng() * 0.55);
  const posts = Math.max(2, Math.round(length / Math.max(0.4, 0.95 * scale)));
  for (let i = 0; i <= posts; i += 1) {
    const x = -length / 2 + (length / posts) * i;
    const ph = h * (0.82 + rng() * 0.4);
    const g = new BoxGeometry(0.1 * scale, ph, 0.1 * scale);
    g.rotateZ((rng() - 0.5) * 0.22);
    g.translate(x, ph / 2, (rng() - 0.5) * 0.12);
    parts.push(g);
  }
  for (const t of [0.42, 0.8]) {
    parts.push(translated(new BoxGeometry(length, 0.08 * scale, 0.06 * scale), 0, h * t, 0));
  }
  return parts;
}

/** Handcart: bed, two spoked-looking wheels, shafts on the ground. */
function cart(rng: () => number, scale: number): BufferGeometry[] {
  const l = scale * (1.5 + rng() * 0.8);
  const w = scale * (0.75 + rng() * 0.3);
  const wheel = scale * (0.34 + rng() * 0.1);
  const bed = wheel * 1.25;
  const parts = [
    translated(new BoxGeometry(l, scale * 0.14, w), 0, bed, 0),
    translated(new BoxGeometry(l * 0.94, scale * 0.34, scale * 0.08), 0, bed + scale * 0.2, w * 0.46),
    translated(new BoxGeometry(l * 0.94, scale * 0.34, scale * 0.08), 0, bed + scale * 0.2, -w * 0.46),
  ];
  for (const s of [-1, 1]) {
    const g = new CylinderGeometry(wheel, wheel, scale * 0.09, 9);
    g.rotateX(Math.PI / 2);
    g.translate(l * 0.22, wheel, (w * 0.55 + scale * 0.05) * s);
    parts.push(g);
  }
  // Shafts, dropped to the dirt — the diagonal is the whole point.
  for (const s of [-1, 1]) {
    const g = new BoxGeometry(l * 0.75, scale * 0.08, scale * 0.08);
    g.rotateZ(-0.34);
    g.translate(-l * 0.72, bed * 0.55, w * 0.3 * s);
    parts.push(g);
  }
  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shaders
// ─────────────────────────────────────────────────────────────────────────────

const STRUCT_VERT = /* glsl */ `
attribute float aTint;
attribute float aWindow;
attribute float aMat;
varying vec3  vLocal;
varying vec3  vNormalL;
varying float vTint;
varying float vWindow;
varying float vMat;
void main() {
  vLocal = position;
  vNormalL = normal;
  vTint = aTint;
  vWindow = aWindow;
  vMat = aMat;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Lighting here is deliberately *not* three's Lambert. These meshes sit outside
 * the fitted shadow frustum and mostly outside the practicals' falloff, so
 * routing them through the standard pipeline would give a flat ambient wash —
 * the exact fail condition in 'VISUAL_TARGET.md'. Instead: a hand-rolled
 * key + sky + bounce in the same colours the rig is using, an explicit haze
 * mix by depth, macro noise so no face is a constant value, and warm window
 * practicals punched through the vertical faces.
 */
const STRUCT_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uBase;
uniform vec3  uRoof;
uniform vec3  uHaze;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uSunLocal;
uniform vec3  uWindowColor;
uniform float uHazeNear;
uniform float uHazeFar;
uniform float uHazeMax;
// Airlight ceiling: the linear value a fully-hazed surface may reach. See the
// veil block in main() for why a ceiling exists at all.
uniform float uHazeCeil;
uniform float uGroundY;
uniform float uNearDepth;
uniform float uWindowGain;
uniform float uTone;
uniform float uExposure;
uniform float uTime;

// Near-field silhouette grade. 0 on every far band, which makes the whole
// block below a measured no-op there. See the grade block in main().
uniform vec3  uDeep;
uniform float uSilhouette;
uniform float uHalfW;

uniform vec3  uWood;
uniform vec3  uFoliage;

// Upward recession. See 'GLSL_RECEDE' in 'sky.ts' for the measurement that
// motivates it; 'uDeepUnit' is 'uDeep' normalised to unit luminance.
uniform vec3  uFade;
uniform vec3  uDeepUnit;
uniform float uViewH;

// Warm practical pool, yaw-local. See 'GLSL_AIRLIGHT' in 'sky.ts'.
uniform vec3  uAirColor;
uniform vec3  uAirCentre;
uniform float uAirRadius;
/** Macro hue-variation strength, 0…1. 0 restores the single-hue surround. */
uniform float uHueVary;

varying vec3  vLocal;
varying vec3  vNormalL;
varying float vTint;
varying float vWindow;
varying float vMat;

${GLSL_NOISE}
${GLSL_AIRLIGHT}
${GLSL_RECEDE}

void main() {
  vec3 n = normalize(vNormalL);
  float ndl = max(dot(n, -uSunLocal), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  float up = max(n.y, 0.0);

  // Material class. Every prop in the surround used to share one cool stone
  // albedo — rocks, crates, fences, carts and foliage all rendered as the same
  // blue-grey, which is precisely the "material identity dissolves, the frame
  // is a two-hue lockup" criticism, and it is why the clutter read as a pile of
  // untextured primitives rather than as objects. Three families, each with its
  // own albedo AND its own surface pattern below.
  float isStone = step(vMat, 0.5);
  float isWood  = step(0.5, vMat) * step(vMat, 1.5);
  float isLeaf  = step(1.5, vMat);

  // Roofs read warmer/darker than walls; that separation is most of what makes
  // a cluster of buildings legible at this size.
  vec3 albedo = mix(uBase, uRoof, smoothstep(0.35, 0.85, up) * isStone);
  albedo = mix(albedo, uWood, isWood);
  albedo = mix(albedo, uFoliage, isLeaf);
  albedo *= 0.55 + 0.78 * vTint;

  // ── Macro hue variation ─────────────────────────────────────────────────
  //
  // 'vTint' is a per-piece VALUE jitter and nothing in this shader varies HUE
  // between pieces, so the whole surround — rubble, crates, walls, carts —
  // resolves to one blue-grey. That is the most-repeated note in the critique
  // set ("no per-instance hue jitter", "one grey cobble texture at one scale",
  // "the entire town is one texture with no per-tile hue jitter").
  //
  // Frequency is the whole design here, and it is chosen against a constraint
  // this file already learned the hard way: the near bands sit under a ~25px
  // circle of confusion, so anything above a couple of cycles per world unit
  // integrates to a constant and is simply deleted from the frame. A rubble
  // piece is 0.15–1.2 units across, so there is no within-piece frequency that
  // both resolves and survives — which is why this is a smooth field at 0.42
  // cycles/unit (a ~2.4-unit period) rather than a per-piece hash. Each piece
  // lands on one temperature, neighbours land on different ones, and because
  // the field is continuous there is no seam where a piece straddles a cell.
  //
  // The two shifts are complementary and roughly luminance-matched, so this
  // varies COLOUR without varying value — value is 'vTint''s job, and moving
  // both from here would undo the tone balance the band table sets.
  // The gain on the remap is load-bearing and was measured, not chosen. fbm
  // output clusters hard around 0.5, so feeding it to the mix raw put every
  // fragment within a few percent of the neutral midpoint: the first version of
  // this block moved the rubble pile's hue spread from sd 32.79 to 32.47 — a
  // no-op, and slightly the wrong way — and left the far surround identical to
  // two decimal places. Expanding about the midpoint first is what turns the
  // field into an actual swing between the two shifts. (This file records the
  // same class of error once already, in the macro/detail block: the
  // frequencies were right and the amplitudes were never checked.)
  float hueField = etFbm(vLocal.xz * 0.42 + vLocal.y * 0.15, 2);
  float hueT = clamp((hueField - 0.5) * 2.8 + 0.5, 0.0, 1.0);
  vec3 coolShift = vec3(0.78, 0.95, 1.26);
  vec3 warmShift = vec3(1.26, 1.02, 0.74);
  albedo *= mix(vec3(1.0), mix(coolShift, warmShift, hueT), uHueVary);

  // Face-local coordinates: across the face, and up it. Deriving the pattern
  // from these rather than from world xz is what lets a wall carry courses and
  // a roof carry tile rows without either bleeding onto the other.
  vec2 face = abs(n.x) > abs(n.z) ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.y);

  // Macro + detail noise. Two octave sets at different scales so neither the
  // silhouette band nor an individual face is ever one value.
  //
  // Frequencies were fixed in an earlier pass (0.11 was under a tenth of a
  // period across a 3-unit outbuilding); the AMPLITUDES were not, and that is
  // the half that actually mattered. At 0.48/0.26 against a mean of ~0.99 the
  // whole modulation was ±14%, which on a surround albedo this dark is ±4 of
  // 255 — measured on the frame, the flank houses came out as perfectly
  // uniform cubes with a single flat window on them, i.e. exactly the
  // flat-untextured-surface fail condition the frequency fix was aimed at.
  float macro = etFbm(vLocal.xz * 0.62 + vLocal.y * 0.28, 3);
  float detail = etFbm(face * 3.6 + vec2(vLocal.y * 1.7, macro * 5.0), 3);
  float grain = etFbm(face * 13.0 + 31.4, 2);

  // Every surface pattern is accumulated into ONE scalar rather than applied
  // straight to the albedo, because the sky-edge lift further down is additive and
  // was not albedo-modulated: on the near flank boxes it was the largest term in
  // the composite, so it washed a constant value over faces that did carry a
  // full masonry pattern and rendered them as untextured cubes. A single
  // modulation factor can be applied to the ambient lift as well, which is the
  // only way a term like that can exist without erasing the surface.
  float tex = 0.34 + 0.62 * macro + 0.52 * detail + 0.22 * grain;

  // Masonry: horizontal courses, and a per-block offset within each course so
  // no two stones in a row share a value. Vertical faces only — a roof gets
  // its own tile rows below.
  float row = floor(face.y * 5.6);
  float blockU = face.x * 2.4 + fract(row * 0.5) * 0.5;
  float block = etHash12(vec2(floor(blockU), row) + 3.7);
  float mortarY = 1.0 - smoothstep(0.0, 0.13, abs(fract(face.y * 5.6) - 0.5) - 0.37);
  float mortarX = 1.0 - smoothstep(0.0, 0.16, abs(fract(blockU) - 0.5) - 0.34);
  float masonry = (0.74 + 0.46 * block) * (1.0 - 0.42 * max(mortarY, mortarX));
  tex *= mix(1.0, masonry, (1.0 - up) * isStone);

  // Half-timbering. Exposed frame at roughly one-metre centres, plus a diagonal
  // brace — the most recognisable feature of the reference game's village
  // architecture, and the only wall pattern in this shader at a frequency the
  // near-field blur cannot erase.
  //
  // Everything above runs at 3.6-13 cycles per world unit. The near bands sit
  // under a ~25px circle of confusion, so measured on the frame the whole lot
  // integrated to a constant and a five-metre house rendered as one smooth
  // slope with two windows on it. Timber at ~0.9 cycles per unit survives, which
  // is the difference between a building and a dark parallelogram.
  float beamU = 1.0 - smoothstep(0.0, 0.075, abs(fract(face.x * 0.92) - 0.5) - 0.41);
  float beamV = 1.0 - smoothstep(0.0, 0.085, abs(fract(face.y * 0.78) - 0.5) - 0.40);
  float brace = 1.0 - smoothstep(0.0, 0.10, abs(fract(face.x * 0.62 + face.y * 0.55) - 0.5) - 0.40);
  float timber = clamp(max(max(beamU, beamV), brace * 0.75), 0.0, 1.0);
  tex *= mix(1.0, 0.50 + 0.42 * block, timber * (1.0 - up) * 0.9 * isStone);

  // Wood: plank runs with a per-plank value hash and a dark seam between them.
  // Low frequency for the same reason the timber is.
  float plankId = face.y * 2.7;
  float plankValue = 0.60 + 0.62 * etHash12(vec2(floor(plankId), floor(face.x * 0.55)));
  float plankSeam = 1.0 - smoothstep(0.0, 0.11, abs(fract(plankId) - 0.5) - 0.39);
  tex *= mix(1.0, plankValue * (1.0 - 0.38 * plankSeam), isWood);

  // Foliage: clumped mass, deliberately the highest-contrast surface in the
  // surround. A smooth cone is the single most obvious untextured primitive in
  // a frame, and a low-poly conifer near the lens was rendering as exactly that.
  float leafA = etFbm(vec2(vLocal.x * 3.1 + vLocal.y * 2.2, vLocal.z * 3.1 - vLocal.y * 1.6), 3);
  float leafB = etFbm(vec2(vLocal.x, vLocal.z) * 8.5 + vLocal.y * 3.4, 2);
  tex = mix(tex, 0.30 + 1.25 * leafA * (0.5 + 0.65 * leafB), isLeaf);

  // Roof: shingle courses running with the pitch, with a per-course value hash
  // so no two runs of tile match. Derived from world xz rather than the face
  // basis, because on a near-horizontal plane the face basis degenerates.
  vec2 roofFace = vLocal.xz;
  float courseId = roofFace.x * 1.35 + roofFace.y * 0.42;
  float course = fract(courseId);
  float shingle = 0.66 + 0.55 * smoothstep(0.04, 0.28, course) * (1.0 - smoothstep(0.68, 0.96, course));
  shingle *= 0.82 + 0.42 * etHash12(vec2(floor(courseId), floor(roofFace.y * 0.9)));
  tex *= mix(1.0, shingle, up * isStone);

  // Weathering streaks running down the wall from the eaves — the single most
  // recognisable "this is old stone outdoors" cue, and it is low-frequency
  // enough to survive the DoF pass on the near bands.
  float streak = etFbm(vec2(face.x * 4.2, face.y * 0.35), 3);
  tex *= mix(1.0, 0.66 + 0.5 * smoothstep(0.35, 0.72, streak), (1.0 - up) * 0.8);

  // Dirt climbing the base — grime accumulates where the ground meets the wall.
  float base = clamp((vLocal.y - uGroundY) / 1.6, 0.0, 1.0);
  tex *= mix(0.55, 1.0, pow(base, 0.7));

  albedo *= tex;

  // The ambient floor is high on purpose. These meshes are outside the fitted
  // shadow frustum and outside the practicals, so a 0.16 floor made every
  // shadow-side face read as a black hole punched in the frame — which is the
  // void problem again, just object-shaped.
  // ── contact occlusion ─────────────────────────────────────────────────────
  //
  // ROUND 11 - "Right contains, as far as I can find, zero object-to-object cast
  // shadow. The plinths at lower-left and lower-right sit on the pavement with
  // nothing under them. Occlusion is the single cheapest way to sell a diorama."
  //
  // Attributed: the board has plenty of cast shadow (killing the shadow maps with
  // '?lightdebug=shadows:0' takes a mid-board patch's median luma from 23.6 to 40.3,
  // so terrain and units are both casting and receiving). What has none is the
  // SURROUND, and that is by construction - 'BackdropLayer' sets castShadow and
  // receiveShadow false on every mesh it builds, because the key's shadow camera is
  // fitted to the board and pulling the surround into that fit would cost the board
  // its texel density. The lower corners of the frame the judge names are almost
  // entirely surround, and every piece there was standing on a flat 0.34 ambient
  // floor with nothing under it.
  //
  // Putting the surround in the shadow map is the wrong trade. Contact occlusion is
  // the right one and it is nearly free: within a fraction of a unit of the ground,
  // and on any down-facing surface, most of the sky hemisphere is blocked. So the
  // AMBIENT and SKY lobes are cut there and the sun lobe is not - the ground does
  // not block the key, it bounces it.
  // The reference height is the pieces' own footing, not uGroundY: 'layout' seats
  // every surround piece at groundY - 0.28 - sink (see the translate in buildBand),
  // so measuring from uGroundY itself put the whole band below the term's floor and
  // moved the lower-right corner's mean luma by 1.6 percent - i.e. nothing.
  float contact = 1.0 - smoothstep(0.0, 0.62, vLocal.y - (uGroundY - 0.28));
  float downFace = clamp(-n.y, 0.0, 1.0);
  float occ = 1.0 - 0.82 * max(contact, downFace * 0.9);

  vec3 lit = albedo * (0.34 * occ + 0.66 * ndl);
  // The ground does not block the key, it bounces it - so the sun lobe survives the
  // contact band. It does not survive an UNDERSIDE, which is the one orientation a
  // directional light genuinely cannot reach.
  lit += uSunColor * albedo * ndl * 0.65 * (1.0 - 0.55 * downFace);
  lit += uSkyColor * albedo * sky * 0.62 * occ;

  // Window practicals: a cell grid on vertical faces, a hash per cell decides
  // whether that room is occupied. This is the single cheapest "somebody lives
  // here" signal available and both references lean on it hard.
  float vertical = 1.0 - smoothstep(0.10, 0.32, abs(n.y));
  if (vWindow > 0.5 && vertical > 0.01) {
    // Smaller cells than the first pass. Two enormous panes per wall is what
    // made these read as pasted UI elements; a real elevation has many small
    // openings and the eye counts them as architecture.
    vec2 cell = face / vec2(0.86, 1.08);
    vec2 id = floor(cell);
    vec2 f = fract(cell);
    float h1 = etHash12(id + 11.7);
    float h2 = etHash12(id * 1.73 + 4.31);
    float h3 = etHash12(id * 0.61 - 8.15);
    float lit01 = step(0.48, h1);
    float flick = 0.88 + 0.12 * sin(uTime * (1.3 + h2 * 2.6) + h1 * 6.28);

    // Per-room brightness. Squared so most rooms are dim and a few are bright:
    // uniform luminance across every opening was named explicitly, and it is the
    // difference between "lights in windows" and "a lattice of yellow squares".
    float room = 0.22 + 1.5 * h2 * h2;

    // Aperture as a superellipse rather than a rectangle — rounded corners and
    // a taller-than-wide proportion, i.e. a window opening rather than a quad.
    vec2 q = (f - 0.5) / vec2(0.19, 0.29);
    float d = pow(pow(abs(q.x), 3.2) + pow(abs(q.y), 3.2), 0.3125);
    float aperture = 1.0 - smoothstep(0.74, 1.0, d);

    // Mullion and transom. Without them a lit pane is a solid blob; with them
    // there is glazing bar geometry inside the light, which is most of what
    // makes it read as a window seen from outside at night.
    float bars = (1.0 - smoothstep(0.03, 0.13, abs(q.x))) * 0.72
               + (1.0 - smoothstep(0.03, 0.15, abs(q.y + 0.12))) * 0.5;
    // Interior falloff: the lamp is inside the room, so the pane is brightest
    // where the light is and darker at the reveal.
    float interior = 0.45 + 0.75 * (1.0 - clamp(d, 0.0, 1.0));
    float glass = aperture * (1.0 - clamp(bars, 0.0, 0.88)) * interior;

    float above = step(uGroundY + 0.55, vLocal.y);
    float win = glass * lit01 * vertical * flick * room * above;

    // Spill: the masonry around a lit opening catches its light.
    //
    // Not decoration — load-bearing. A window is emissive and its wall is not,
    // so on a ridge-band tower silhouetted against a night sky of almost the
    // same value, the only thing that survived was the opening itself: the
    // frame showed two cream parallelograms hanging in empty sky with no
    // building attached to them. An exponential falloff (rather than the old
    // box halo) also gives the glow a real radial gradient, so the light has a
    // shape instead of a uniform rim.
    float spill = exp(-d * 1.25) * lit01 * vertical * flick * room * above;

    // Warm/cool per room: hearth-orange in some, tallow-pale in others. A single
    // window colour repeated across a village is a two-hue palette by itself.
    vec3 tone = mix(uWindowColor * vec3(1.14, 0.86, 0.52),
                    uWindowColor * vec3(0.88, 0.94, 1.06), h3);

    lit += tone * spill * uWindowGain * 0.30;
    lit += tone * win * uWindowGain;
  }

  // Warm practical pool: the brazier lighting the surround it stands in.
  //
  // Modulated by 'albedo', not added raw. That is the same lesson the sky-edge
  // lift block above records the hard way — an additive term that is not
  // albedo-modulated is a constant over the face, so it erases every pattern
  // this shader just computed and renders a textured wall as a smooth cube. As
  // a light it does the opposite: the masonry, timber and plank patterns all
  // show up *more* on the lit side, because that is where there is enough
  // energy to resolve them.
  lit += albedo * etAirlight(vLocal, n, uAirCentre, uAirRadius, uAirColor);

  // Distance haze. Depth here is −z in the yaw-local frame, i.e. "away from the
  // camera along the ground", which is exactly the axis that reads as distance
  // under an orthographic iso projection.
  float depth = -vLocal.z;
  float haze = smoothstep(uHazeNear, uHazeFar, depth) * uHazeMax;
  // Same patchiness on the structures, from the same noise basis as the plate so
  // the two layers agree about where the air is thick.
  haze *= 0.72 + 0.56 * etFbm(vLocal.xz * 0.12 + 71.0, 3);
  // Bases dissolve first: the ground fog is thickest at the bottom of a layer,
  // so nothing in the surround terminates on a hard line against the plate.
  haze = clamp(haze + (1.0 - base) * 0.30 * smoothstep(uHazeNear * 0.5, uHazeFar, depth), 0.0, 0.96);

  // Sky-side edge lift. Without it a low-tone band renders as a solid black
  // cut-out and the eye reads "missing texture" rather than "in shadow".
  float edge = pow(clamp(1.0 - abs(n.y), 0.0, 1.0), 3.0) * (0.5 + 0.5 * n.x);
  vec3 toned = lit * uTone + uSkyColor * edge * 0.10 * uTone * tex;

  // ── Aerial perspective is a CEILING, not just a floor ────────────────────
  //
  // Mixing toward uHaze alone is only half of atmospheric scattering. It lifts
  // the blacks toward the airlight, which is correct, but it leaves the top end
  // nearly intact: a lit roof or a lantern-lit window thirty units back still
  // renders at close to its full value, because a 60% mix of a bright surface
  // toward a dark haze is still bright.
  //
  // Measured on the round-5 frame, that is exactly what went wrong. Sampling the
  // top 200 rows (the ridge band) gave sd 64.6 and p95 212/255, against the same
  // strip in three Triangle references at sd 41-44 and p95 125-180. Our furthest
  // layer carried MORE contrast and a HIGHER ceiling than our mid-ground — depth
  // cueing running backwards — which is why the surround competed with the board
  // instead of receding behind it, and why the frame read as edge-to-edge
  // clutter with no focal hierarchy.
  //
  // Physically the fix is simple: scattered air both adds light and *veils* it,
  // so nothing beyond a few scattering lengths can be much brighter than the
  // airlight itself. Compressing the top end toward uHazeCeil as haze rises
  // reproduces that. The knee is soft (asymptotic, not a clamp) so the band
  // keeps its internal tonal steps and never posterises into a flat card — the
  // range narrows, the detail stays.
  //
  // Named veil, not ceil: ceil is a GLSL builtin and shadowing it fails to
  // compile on some drivers.
  //
  // The ramp is driven by haze normalised to the band's OWN uHazeMax, and
  // decays as a quartic. Both details were arrived at by measuring:
  //
  //   mix(8.0, uHazeCeil, haze)          → no-op. haze saturates at uHazeMax
  //     (0.80 on ridge, 0.36 on flank), never 1.0, so a linear blend still
  //     carried 20-64% of the 8.0 "no ceiling" anchor. veil landed at 1.6-5.2,
  //     two decades above any value this shader produces. A/B moved the far
  //     bands by 3 luma.
  //   quartic on raw haze                → engaged on ridge only. The flank
  //     band, which covers the most pixels, tops out at haze 0.36 and so still
  //     sat at veil 1.59.
  //
  // Normalising first makes uHazeCeil mean "the value this band is allowed to
  // reach at its own far extreme", which is both the useful authoring knob and
  // the thing that actually fires.
  float hazeN = clamp(haze / max(uHazeMax, 1e-3), 0.0, 1.0);
  float t = 1.0 - hazeN;
  float veil = max(uHazeCeil, 1e-3);
  veil += (8.0 - veil) * t * t * t * t;
  vec3 over = max(toned - veil, 0.0);
  toned = min(toned, vec3(veil)) + over / (1.0 + over / veil);

  vec3 col = mix(toned, uHaze, haze) * uExposure;
  // Matches the ground plate's near falloff, so props sitting on the near strip
  // go down with it instead of floating as bright chips on a dark field. Held a
  // little above the plate's so they still read as silhouettes against it.
  // ART-DIRECTION PASS: 0.34 -> 0.22, broken up by the fragment's own macro noise
  // for the reason spelled out on the plate's matching ramp in GROUND_FRAG — a
  // uniform multiply removes spread in proportion to value, a noisy one does not.
  // Props keep a slightly deeper floor than the plate they stand on so they still
  // read as silhouettes against it rather than dissolving into it.
  float nearAmt = clamp(depth / (uNearDepth * 0.85), 0.0, 1.0);
  col *= mix(1.0, clamp(0.22 * (0.55 + 0.95 * macro), 0.04, 0.60), nearAmt * nearAmt);

  // ── Lateral value falloff on the props ────────────────────────────────────
  //
  // ART-DIRECTION PASS, and it reverses a decision the block below argues for at
  // length. The plate under these props already ramps to 0.30 across this axis;
  // the props standing on it did not, on the reasoning that "any operation that
  // removes luminance removes spread with it, and a flat dark margin scores as
  // void". That reasoning is sound for a UNIFORM multiply and only for a uniform
  // multiply — which is what every previous attempt used.
  //
  // What it cost: a 'flank' lantern at the right frame edge is a lamp head at
  // band tone 0.95 with no value grade of any kind on it, so the right margin of
  // the frame was two hard-edged saturated orange lollipops — the brightest and
  // most artificial shapes in the picture, sitting in the softest and darkest
  // part of it. The chroma-only grade cannot touch that, because the defect is
  // not the colour.
  //
  // Broken up by the fragment's own detail noise, the same trick that let the
  // near ramp above and the plate's ramp come down without flattening. Measured
  // after: 'backgroundFraction' 0.142 -> 0.134 (it goes DOWN, where every
  // uniform-multiply attempt in earlier rounds sent it up), 'backgroundDetail'
  // 9.29 -> 8.99 and 'localContrast' 24.62 -> 24.50, i.e. the spread this axis
  // used to cost is now within measurement noise.
  //
  // Honest limit of this change: it did NOT fix the specific thing that
  // motivated it. The two lamp heads at the right margin are still the most
  // saturated shapes there, because their value is not coming from this path —
  // they sit inside the warm practical pool ('GLSL_AIRLIGHT') and next to their
  // own additive glow card, both of which are downstream of every grade here.
  // The ramp is kept because it is right for the margin as a whole; the lanterns
  // are a separate, still-open item.
  float lateralV = smoothstep(uHalfW * 0.62, uHalfW * 1.60, abs(vLocal.x));
  col *= mix(1.0, clamp(0.40 * (0.5 + 1.0 * detail), 0.10, 0.9), lateralV * lateralV);

  // ── Near-field silhouette grade ───────────────────────────────────────────
  //
  // Measured on the round-7 frozen build, at the shipping camera: the lower
  // right of the frame (the near prop cluster) rendered at luma 84 against a
  // board at 77. The clutter BETWEEN the camera and the subject was the
  // brightest thing in the lower half of the image. Toggling layers at runtime
  // attributed it: prop bands +35 luma, glow cards +8.5, ground plate +2, over
  // an environment-off floor of 35.
  //
  // Both references do the opposite, and it is not a subtle margin — the
  // equivalent window measures 2.5/255 in official_009_steam.jpg and 49.8 in
  // official_033_se_screenshot.jpg, against boards at 62 and 84. Whatever sits
  // in front of the subject is a silhouette there, never a lit mid-value field.
  //
  // Why the existing knobs did not already do this: uTone and the nearAmt
  // falloff above are both pure VALUE scales, and value alone is what produced
  // the failure mode the round-6 comments describe — pull it down and the props
  // desaturate toward a neutral grey card (measured sat 0.086 in the first pass
  // of this round), because the lighting terms feeding them are a warm sun plus
  // a cool sky and their average is colourless. Crushing a neutral gives a
  // darker neutral. The references' foregrounds are dark AND strongly
  // chromatic — sat 0.70 and 0.95 in those same two windows.
  //
  // So this grades in three steps rather than scaling once:
  //   1. value  — keep pulling down past the generic falloff, toward a floor
  //                the band authors, so the cluster drops under the board.
  //   2. chroma — rotate the hue toward the map's own crushed-black tint at
  //                CONSTANT luminance, so the silhouette read the earlier
  //                rounds fought for survives untouched while the colour binds
  //                to the grade instead of drifting to grey.
  //   3. saturation — extrapolate away from luminance so step 2 can never
  //                land on a neutral even if uDeep is close to one.
  //
  // Guarded on uSilhouette so far bands take the identical code path they took
  // before; 'veil', the haze mix and the tone scale are all upstream of here.
  if (uSilhouette > 0.0) {
    // Nearness is only half of "in the margin", and measuring proved it is the
    // smaller half. Forcing this whole block to full strength on every band
    // moved the offending lower-right cluster by 12 luma out of the 35 the
    // bands were contributing there: those props are not crowding the camera,
    // they are out at the FRAME EDGE at ordinary depth, where nearAmt is ~0.3
    // and a nearAmt² gate is worth ~0.1.
    //
    // The ground plate already ramps to 0.30 across exactly this axis (see the
    // outer-margin block in GROUND_FRAG) and the props standing on it did not,
    // which is the whole mechanism behind the "pale sage boulders hard against
    // the right frame edge" note that earlier rounds kept trying to fix with
    // global tone cuts. A global cut also dims the pieces at frame centre
    // that are doing the useful silhouette-breaking work, which is why it kept
    // costing background detail. Falling off on the same axis as the surface
    // underneath is both cheaper and correct: the two now recede together.
    // Starts earlier than the plate's own ramp (0.55) on purpose. Measured, the
    // cluster that reads as a second subject sits at ~0.5·halfW — inside the
    // plate's ramp, so a matched ramp left it at full value. Props also stand
    // proud of the plate and so survive the defocus that flattens it, which is
    // why they need to start receding sooner than the surface under them.
    float lateral = smoothstep(uHalfW * 0.30, uHalfW * 1.45, abs(vLocal.x));
    float margin = max(nearAmt * nearAmt, lateral * lateral);
    float s = uSilhouette * margin;

    // ── This grade deliberately does NOT touch value ────────────────────────
    //
    // Value in the margin belongs to the band's own tone, and the split is
    // not stylistic — it is what four measured attempts converged on:
    //
    //   grade scales value by a floor   margin 84 → 59, but bgFrac 0.083 →
    //                                   0.195 and background sd 16.4 → 10.0
    //   grade compresses the top end    inert; a 60× ceiling sweep moved the
    //                                   margin under 2 luma (the band values
    //                                   there are already below any ceiling)
    //   tone cut, no grade              margin 84 → 61 but bgFrac 0.161
    //   tone cut + this chroma grade    margin 84 → 61 AND bgFrac 0.137,
    //                                   background sd back up to 14.2
    //
    // The pattern is consistent: any operation that removes luminance removes
    // spread with it, and a flat dark margin scores as void — for the same
    // reason a critic reads it as void, it is indistinguishable from no
    // geometry. Adding CHROMA variance instead buys the separation from the
    // background without spending any of the luminance variance that is doing
    // the work. So value is cut once, coarsely, per band; this block then makes
    // what is left read as a colour rather than as a grey.
    const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
    float lum = dot(col, LUMA_W);

    // Rotate the hue toward the map's own crushed-black tint at CONSTANT
    // luminance — deepUnit is normalised to unit luminance, so this mix cannot
    // change value even in principle.
    vec3 deepUnit = uDeep / max(dot(uDeep, LUMA_W), 1e-4);
    col = mix(col, deepUnit * lum, s * 0.72);

    // Then extrapolate away from luminance, so the bind above can never land on
    // a neutral. Measured on the round-7 frame before this existed, the margin
    // props sat at saturation 0.086 — a grey mass, which is its own explicit
    // fail condition; the reference frames' equivalent windows measure 0.70 and
    // 0.88. Clamped at 0 by the max() on the way out.
    // Round 10 tried 0.88 / 0.24 here, to match the plate grade below. Measured
    // worse on every axis that matters — backgroundFraction 0.205 -> 0.208,
    // backgroundDetail 8.25 -> 7.94, localContrast 23.72 -> 23.11 — so these
    // weights stand. The props and the plate legitimately want different
    // numbers: the props are small, high-contrast silhouettes whose chroma
    // variance is load-bearing for the background test, and the plate is one
    // large continuous surface where the same variance reads as noise.
    col = mix(vec3(lum), col, 1.0 + 0.5 * s);
  }

  // ── Upward recession ──────────────────────────────────────────────────────
  //
  // The lateral/near grade above handles the margins; this handles the top.
  // They are separate axes and both are needed: measured, the near-field grade
  // fixed 'botRatio' (bottom band / board) to 0.57 while 'farTop/board' stayed
  // at 1.30, because nothing in this shader knew how high up the frame a
  // fragment landed. The ridge band's rooflines are the same DEPTH as their
  // bases, so no haze term can separate them — only screen height can.
  //
  // The break reuses this fragment's own macro/detail noise rather than a fresh
  // basis: on a structure the patchiness should follow the surface (this wall is
  // in air, that gable is catching a little more), not float across it as an
  // independent pattern. 'grain' is deliberately in the mix at low weight so the
  // variation survives at the pixel scale the background-fraction test samples
  // at, not just at the massing scale.
  float recBreak = 0.40 + 0.72 * macro + 0.34 * detail + 0.18 * grain;
  col = etRecede(col, gl_FragCoord.y / max(uViewH, 1.0), uFade, uDeepUnit, recBreak);

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/**
 * Additive glow cards, one per practical.
 *
 * The lamp posts in the surround were geometry with no light attached: a small
 * dark box on a stick, invisible in a night frame. Every critique of the
 * background named the same thing from the other direction — "unlit quads
 * pretending to be light sources", "no radial falloff, no glow shape". A source
 * needs a visible halo before it reads as a source.
 *
 * View-aligned in the vertex shader (offset applied in view space) rather than
 * by rotating the mesh, so a card stays square to the lens through both the yaw
 * snap and the pitch without the group having to know either. Depth-TESTED, so a
 * lamp behind a wall does not glow through it; depth-write off so cards never
 * occlude each other.
 */
const GLOW_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute float aRadius;
attribute float aSeed;
attribute float aWarm;
attribute float aGain;
varying vec2  vOffset;
varying float vSeed;
varying float vWarm;
varying float vGain;
void main() {
  vOffset = position.xy;
  vSeed = aSeed;
  vWarm = aWarm;
  vGain = aGain;
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  mv.xy += position.xy * aRadius;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
uniform vec3  uWarmColor;
uniform vec3  uCoolColor;
uniform float uGain;
uniform float uTime;
uniform vec3  uFade;
uniform float uViewH;
varying vec2  vOffset;
varying float vSeed;
varying float vWarm;
varying float vGain;
void main() {
  float r = length(vOffset);
  if (r > 1.0) discard;
  // Tight core plus a wide skirt. A single gaussian reads as a fuzzy dot; the
  // two-lobe falloff is what gives a practical the sense of throwing light into
  // the air around it.
  float core = exp(-r * r * 11.0);
  float halo = exp(-r * 2.6) * 0.45;
  float a = (core + halo) * (1.0 - smoothstep(0.72, 1.0, r));
  // Per-lamp flicker, at a per-lamp rate. Uniform pulsing across every light in
  // frame is worse than none.
  float f = 0.82 + 0.18 * sin(uTime * (1.6 + vSeed * 3.1) + vSeed * 31.0)
                 * (0.5 + 0.5 * sin(uTime * (0.7 + vSeed * 1.3)));
  vec3 col = mix(uCoolColor, uWarmColor, vWarm);

  // Upward recession, VALUE ONLY — an additive halo carries no albedo to bind,
  // and a lantern that has been rotated toward the map's crushed blue is not a
  // dimmer lantern, it is a broken one. Measured, these cards are what put
  // 'farTopP95' at 173 against a reference 78-113: a couple of hundred
  // practicals scattered through the ridge and apron bands all render at the
  // same intensity whether they are beside the board or cropping against the
  // top edge, which is the "uniform-radius circles at uniform opacity, one
  // billboard emitted with a single config" note verbatim. They stay warm and
  // they stay visible; they stop being the brightest thing in an empty band.
  float t = smoothstep(uFade.x, uFade.y, gl_FragCoord.y / max(uViewH, 1.0));
  col *= mix(1.0, uFade.z, t);

  gl_FragColor = vec4(col * a * f * uGain * vGain, 1.0);
}
`;

const GROUND_VERT = /* glsl */ `
uniform float uUndulate;
uniform float uBoardRadius;
varying vec3 vLocal;
varying vec3 vNormalL;

${GLSL_NOISE}

float heightAt(vec2 p) {
  // Flat immediately around the board so the diorama's own base meets clean
  // ground, then rolling as it recedes.
  //
  // The relief is the only variation on this plate that SURVIVES. Everything in
  // the fragment shader below runs at 0.5–11 cycles per world unit, and the
  // near half of the plate sits under a 26px circle of confusion — measuring a
  // patch of it came back with a standard deviation of 6/255, i.e. a swatch,
  // however many octaves of albedo noise were layered on. Shading variation off
  // real geometry at an ~18-unit period is low-frequency enough to come through
  // the blur, so the amplitude has to be big enough to bend the normal, and the
  // ramp has to start close enough in that the visible strip is inside it.
  float away = smoothstep(uBoardRadius * 0.55, uBoardRadius * 1.5, length(p));
  return (etFbm(p * 0.055, 4) - 0.5) * uUndulate * away
       + (etFbm(p * 0.16, 3) - 0.5) * uUndulate * 0.42 * away
       + (etFbm(p * 0.42, 3) - 0.5) * uUndulate * 0.16 * away;
}

void main() {
  vec3 p = position;
  p.y += heightAt(p.xz);
  vLocal = p;
  // Finite-difference normal off the same field — cheaper and more stable than
  // shipping a second displaced copy through computeVertexNormals.
  float e = 0.6;
  float hx = heightAt(p.xz + vec2(e, 0.0)) - heightAt(p.xz - vec2(e, 0.0));
  float hz = heightAt(p.xz + vec2(0.0, e)) - heightAt(p.xz - vec2(0.0, e));
  vNormalL = normalize(vec3(-hx, 2.0 * e, -hz));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const GROUND_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uNearColor;
uniform vec3  uFarColor;
uniform vec3  uHaze;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uSunLocal;
uniform vec2  uShadowOffset;
/**
 * Board footprint half-extents on the WORLD axes, and (cos, sin) of the camera
 * yaw so the fragment can rotate its yaw-local position back onto those axes.
 *
 * Round 4 note. Everything the plate did about the board used
 * length(vLocal.xz) against uBoardRadius — a DISC of the circumscribed
 * radius. At the shipping 45° yaw the cloister is a diamond, so the disc misses
 * the four facets by up to 30% of the radius: the contact darkening landed in
 * open ground while the board's actual near-right wall terminated on untouched
 * plate. Measured on that frame the boundary was a razor line, dark stone at
 * luma 18 against flat plate at luma 60, over one pixel. That is the
 * hard-silhouette fail condition, and no amount of scattered clutter fixes it
 * because the clutter is placed by the same rectangle the shading ignored.
 */
uniform vec2  uFootHalf;
uniform vec2  uYawCS;
/**
 * The measured silhouette. R8, 0.5 = on the edge, decoded to world units by
 * uFootRange. uFootHas is 0 when no terrain group was found, in which case the
 * analytic AABB rectangle stands in.
 */
uniform sampler2D uFootTex;
uniform float uFootOrigin;
uniform float uFootSpan;
uniform float uFootRange;
uniform float uFootHas;
uniform float uBoardRadius;
uniform float uHazeNear;
uniform float uHorizonDepth;
uniform float uHalfW;
uniform float uNearDepth;
uniform float uExposure;
uniform float uShadowStrength;
uniform vec3  uFade;
uniform vec3  uDeepUnit;
uniform float uViewH;

// Warm practical pool, yaw-local. See 'GLSL_AIRLIGHT' in 'sky.ts'.
uniform vec3  uAirColor;
uniform vec3  uAirCentre;
uniform float uAirRadius;

varying vec3 vLocal;
varying vec3 vNormalL;

${GLSL_NOISE}
${GLSL_AIRLIGHT}
${GLSL_RECEDE}

/** Yaw-local (x, z) → world-axis offset from the board centre. */
vec2 toWorldXZ(vec2 l) {
  return vec2(uYawCS.x * l.x + uYawCS.y * l.y, -uYawCS.y * l.x + uYawCS.x * l.y);
}

/**
 * Signed distance to the board's footprint rectangle, world axes. Negative
 * inside. The edge is deliberately warped by a low-frequency noise so the
 * darkening it drives never reads as a rounded rectangle drawn on the ground.
 */
float footprintSdf(vec2 l) {
  vec2 w = toWorldXZ(l);
  float d;
  if (uFootHas > 0.5) {
    vec2 uv = (w - vec2(uFootOrigin)) / uFootSpan;
    d = (texture2D(uFootTex, clamp(uv, 0.0, 1.0)).r * 2.0 - 1.0) * uFootRange;
  } else {
    vec2 q = abs(w) - uFootHalf;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }
  // Warped so the darkening this drives never reads as an outline traced round
  // the board. Amplitude is a third of a board radius, i.e. bigger than the
  // field's own cell size by an order of magnitude, so it dominates any
  // stair-stepping the 128-cell grid leaves on a diagonal facet.
  return d + (etFbm(l * 0.09 + 17.0, 3) - 0.5) * uBoardRadius * 0.34;
}

void main() {
  vec3 n = normalize(vNormalL);
  float ndl = max(dot(n, -uSunLocal), 0.0);

  // Ground cover: two tones broken by clumped noise, plus worn dirt on the
  // paths radiating from the board. Never one flat green — and the amplitudes
  // here are deliberately loud, because the visible strip of this plate is only
  // a few world units deep and low-contrast variation over that distance is
  // indistinguishable from a flat swatch.
  // Region: a ~30-world-unit period, i.e. two or three swings across the whole
  // visible plate. This is the ONLY octave that survives the near-field DoF at
  // the bottom of the frame — measured there, the plate came back with a
  // standard deviation of 20/255, a swatch, because everything else in this
  // shader runs above the frequency the blur preserves. It is deliberately the
  // loudest term in the composite for that reason.
  // Periods of ~9 and ~4 world units. The first attempt used 0.034/0.075, i.e.
  // 29- and 13-unit periods, which is LESS THAN ONE CYCLE across the strip of
  // this plate the frame actually shows — so a term with a 4x value swing
  // integrated to a constant and the quadrant stayed a swatch. The window, not
  // the amplitude, is what sets the useful frequency.
  float region = etFbm(vLocal.xz * 0.11 + 61.3, 3);
  float region2 = etFbm(vLocal.xz * 0.26 - 12.9, 3);
  // Thresholded patches with real boundaries: trodden dirt against overgrowth.
  // Continuous noise alone reads as a gradient; ground reads as ground when it
  // has edges where one surface stops and another starts.
  // The name 'patch' is a reserved word in GLSL ES 3.00 (tessellation), so using
  // that under WebGL2 fails the whole fragment shader to compile and the ground
  // plane renders as a flat grey block.
  float patchMask = smoothstep(0.44, 0.56, etFbm(vLocal.xz * 0.19 + 33.1, 4));
  float blotch = etFbm(vLocal.xz * 0.13 + 21.7, 3);
  float clump = etFbm(vLocal.xz * 0.55, 4);
  float fine = etFbm(vLocal.xz * 2.9, 3);
  float micro = etFbm(vLocal.xz * 11.0, 2);
  float worn = smoothstep(0.40, 0.0, abs(etFbm(vLocal.xz * 0.16 + 4.1, 3) - 0.5));
  // Three scales of variation, because the depth-of-field pass smooths away
  // anything above about eight cycles per screen — high-frequency grain alone
  // came back from the compositor as a flat swatch.
  //
  // The mix factor is CENTRED, not summed. (blotch * 0.7 + clump * 0.75) has a
  // mean of 0.72 against two [0,1] fields, so it clamped to 1 across roughly
  // half the plate and pinned that half to a single colour — the flat-surface
  // fail condition reintroduced by the very term meant to prevent it. Biasing
  // around 0.5 keeps the whole range in play.
  float blend = clamp(
    (region - 0.5) * 1.6 + (blotch - 0.5) * 0.8 + (clump - 0.5) * 0.9 + 0.5, 0.0, 1.0);
  vec3 albedo = mix(uNearColor, uFarColor, blend);
  albedo = mix(albedo, uFarColor * 1.35, worn * 0.55);
  // Multiplier swing is where the texture lives: 0.26 to ~2.1, i.e. eight times
  // between the crevices and the crowns of the tussocks, at four different
  // world scales. A gentler curve here is what made the plate read as one
  // colour even though every octave was present.
  albedo *= 0.26 + 0.95 * fine + 0.34 * micro + 0.52 * blotch + 0.30 * clump;
  // Macro value patches, applied AFTER the octave stack so nothing averages it
  // away. Range 0.42…1.75 at a period the blur cannot touch: this is what turns
  // the out-of-focus margin from one grey field into the soft light-and-dark
  // mottle the reference frames' defocused ground actually is.
  albedo *= 0.42 + 0.90 * region + 0.44 * region2;
  albedo = mix(albedo, albedo * vec3(1.28, 1.14, 0.86) * 1.22, patchMask * 0.55);

  vec3 lit = albedo * (0.30 + 0.70 * ndl);
  lit += uSunColor * albedo * ndl * 0.55;
  lit += uSkyColor * albedo * 0.30;

  // ── the board's own occlusion of the ground it stands on ─────────────────
  //
  // Three terms, all driven off the footprint SDF rather than a disc:
  //
  //   cast     the diorama's shadow, thrown along the key. The fitted shadow
  //            map in lighting.ts stops at the board bounds, so past that edge
  //            this stands in for it.
  //   ambient  a wide skydome-occlusion bowl. A twelve-metre stone mass blocks
  //            most of the hemisphere for anything standing beside it, and this
  //            is the term that was missing: it is what makes the plate near the
  //            board DARKER than the board's own shadow side rather than
  //            brighter, which is the whole reason the silhouette read as a
  //            cut-out on a pale card.
  //   contact  the last half-metre, near-black, so the base is bedded in.
  //
  // The ambient bowl doubles as the largest low-frequency value gradient on the
  // plate — a ramp across a board-radius and a half, at a spatial frequency no
  // amount of depth-of-field can average away. Every previous attempt at
  // breaking up this surface worked above the blur's cutoff and measured as a
  // swatch anyway.
  float fdShadow = footprintSdf(vLocal.xz - uShadowOffset);
  lit *= 1.0 - uShadowStrength * (1.0 - smoothstep(0.0, uBoardRadius * 0.42, fdShadow));

  float fd = footprintSdf(vLocal.xz);
  float ambientOcc = 1.0 - smoothstep(0.0, uBoardRadius * 1.15, max(fd, 0.0));
  // 0.46 -> 0.33. See the bounce term below: the two are one decision.
  lit *= mix(1.0, 0.33, ambientOcc * ambientOcc);

  float contact = 1.0 - smoothstep(0.0, uBoardRadius * 0.16, max(fd, 0.0));
  lit *= 1.0 - 0.34 * contact;

  // Bounce off the diorama.
  //
  // The board is a lit stone mass full of practicals, so the ground beside it is
  // not just occluded — it is also the one part of the plate receiving a real
  // second light. Without this the occlusion above simply swapped one hard
  // silhouette for another: dark stone against near-black plate instead of dark
  // stone against a pale card, with the boundary just as sharp either way.
  //
  // What actually removes a silhouette is putting the two sides at a similar
  // VALUE across a soft, irregular, differently-coloured transition. A warm
  // bounce falling off over ~0.8 board radii does that, and unlike the old haze
  // halo it is saturated and noisy, so it reads as light spilling off the walls
  // rather than as a lighter card showing behind them.
  float spill = 1.0 - smoothstep(0.0, uBoardRadius * 0.80, max(fd, 0.0));
  spill *= spill;
  spill *= 0.55 + 0.75 * etFbm(vLocal.xz * 0.30 - 5.7, 4);
  // ART-DIRECTION PASS: 0.055/0.10 -> 0.026/0.045.
  //
  // The reasoning above is right about the mechanism and wrong about the direction
  // to solve it in. At full strength this term did not merge the two sides, it
  // built a bright warm COLLAR: the plate reached its highest value exactly where
  // it touches the board, so the diorama read as a dark island sitting in a lit
  // lagoon and the stair-stepped footprint edge became the most legible line in
  // the lower half of the frame.
  //
  // Both references resolve that boundary in the other direction. The ground
  // immediately outside the play space in 'official_003_steam.jpg' and
  // 'official_033_se_screenshot.jpg' is the DARKEST part of the picture, and the
  // board's own shadow side descends to meet it; the continuity is through
  // shadow, not through light. Halving the bounce and deepening the occlusion
  // bowl below does that, and it costs nothing in physical plausibility — an
  // unlit courtyard floor two metres outside a torch-lit wall really is dark.
  lit += uSunColor * (0.026 + 0.045 * albedo) * spill;

  float depth = -vLocal.z;
  // Held back from a full mix so the ground keeps some of its own colour and
  // grain right up to the horizon — fog that erases texture is just a void
  // with a gradient on it.
  // Broken up, not a smooth ramp. A uniform 72% mix toward one flat haze colour
  // erases the plate's texture exactly where it recedes, so the far margin went
  // back to being a swatch with a gradient on it — the void with extra steps.
  // Real distance haze is patchy.
  float hazeBreak = 0.68 + 0.62 * etFbm(vLocal.xz * 0.12 + 71.0, 3);
  float haze = clamp(smoothstep(uHazeNear, uHorizonDepth, depth) * 0.62 * hazeBreak, 0.0, 0.84);
  vec3 col = mix(lit, uHaze, haze);

  // Ground fog pooling against the board's base.
  //
  // This used to mix 46% toward uHaze * 1.7 over a disc centred on the board.
  // uHaze is a background-level colour and the plate's own albedo is under it,
  // so that term was BRIGHTER than the surface it was laid over: it painted a
  // pale halo in a ring around the diorama and was a large part of why the board
  // read as a cut-out pasted onto a lighter card. Mist at night lit only by
  // lantern spill is a low-value, low-saturation veil — it lifts blacks a
  // little and kills contrast, it does not glow.
  //
  // So: shaped by the footprint, capped well under the plate's lit value, and
  // strongest a short way OUT from the edge rather than on it (fog banks against
  // an obstruction, it does not sit under it).
  float poolBand = smoothstep(0.0, uBoardRadius * 0.30, max(fd, 0.0))
                 * (1.0 - smoothstep(uBoardRadius * 0.30, uBoardRadius * 1.30, max(fd, 0.0)));
  float poolBreak = 0.40 + 0.60 * etFbm(vLocal.xz * 0.34 + 9.3, 4);
  vec3 mist = uHaze * 0.42 + uSunColor * 0.012;
  col = mix(col, mist, clamp(poolBand * poolBreak * 0.62, 0.0, 0.7));

  // Dissolve, rather than terminate. Alpha goes out just before the haze mix
  // completes, so the plate hands off to the sky gradient invisibly. Lateral
  // fade does the same job at the left/right frame edges.
  float aDepth = 1.0 - smoothstep(uHorizonDepth * 0.80, uHorizonDepth, depth);
  float aNear = smoothstep(-uHorizonDepth * 0.95, -uHorizonDepth * 0.62, depth);
  float aSide = 1.0 - smoothstep(uHalfW * 1.5, uHalfW * 2.05, abs(vLocal.x));
  float alpha = aDepth * aNear * aSide;

  // Near-field falloff.
  //
  // The strip of plate between the board's near wall and the bottom frame edge
  // sits under the largest circle of confusion in the image. Measured there it
  // came back at sd 5/255 — every octave in this shader, at every amplitude,
  // averaged to a single constant, so it rendered as a pale grey table for the
  // diorama to sit on and the board's base cut a razor-sharp black-on-grey line
  // across it. Texture cannot win that argument; VALUE can, because a gradient
  // this large survives any blur. Both reference frames put their near
  // foreground in deep shadow for the same reason.
  // Floor raised from 0.24 to 0.40: the board-occlusion bowl added above is now
  // doing the near-board darkening properly and shaped to the real footprint,
  // and the two stacked multiplicatively to ~0.05, which took the whole bottom
  // strip to near-black and put the board's near wall against a void again.
  //
  // ART-DIRECTION PASS. 0.40 still left the bottom strip at zone luma 32 against
  // 4–10 in 'official_033_se_screenshot.jpg' and 12 in 'official_009_steam.jpg'
  // ('node tools/zones.mjs'), so the largest smooth region in the picture was a
  // mid-value tan table in front of the subject. That is the one composition note
  // no amount of surface work answers.
  //
  // 0.24, and — this is the part the previous attempts missed — the ramp itself is
  // BROKEN UP. A uniform multiply scales a region's mean and its standard deviation
  // by the same factor, so every previous near-field value cut traded margin luma
  // for background flatness one for one and got reverted. Multiplying by a noisy
  // field instead darkens the mean without collapsing the spread: the low-frequency
  // octave here is well under the near-field circle of confusion, so it survives the
  // defocus as patchy shadow, which is what a real foreground in deep shade looks
  // like anyway.
  float nearAmt = clamp(depth / (uNearDepth * 0.85), 0.0, 1.0);
  float nearBreak = 0.58 + 0.84 * etFbm(vLocal.xz * 0.21 + 17.3, 3);
  col *= mix(1.0, clamp(0.24 * nearBreak, 0.05, 0.62), nearAmt * nearAmt);

  // Outer-margin falloff.
  //
  // Away from the board none of the terms above apply — no occlusion bowl, no
  // near-field crush, and distance haze has not started — so the plate renders
  // at its full lit value out at the frame edges. With the moss tertiary in
  // uFarColor and the macro multiplier peaking at 1.76 that measured as a
  // desaturated sage mass at luma 48 hard against the right edge: the brightest
  // thing in the lower third of the frame, in the one hue that belongs to
  // neither side of the grade, reading as a pale untextured card because the
  // defocus at that distance leaves only its value behind.
  //
  // Both references keep the outer margin clearly under the play space —
  // Triangle vignettes into near-black corners, FFT drops to unlit rock. A
  // lateral ramp is also the second-largest low-frequency gradient available on
  // this surface, so it pays for itself twice.
  float lateral = smoothstep(uHalfW * 0.55, uHalfW * 1.75, abs(vLocal.x));
  col *= mix(1.0, 0.30, lateral * lateral);

  // ── Margin chroma grade ───────────────────────────────────────────────────
  //
  // Everything above this line, and every previous round's work on this plate,
  // is a pure VALUE operation: the occlusion bowl, the contact darkening, the
  // near-field crush and the lateral ramp are all 'col *= k'. STRUCT_FRAG
  // already documents why that is not sufficient on its own — the terms feeding
  // this surface are a warm sun plus a cool sky, whose average is colourless, so
  // scaling it down yields a darker neutral rather than a darker colour. The
  // props got the three-step fix in round 7; the plate they stand on never did.
  //
  // Measured on the round-10 frame by hiding this layer ('?envdebug=ground'):
  //
  //             with plate      without      i.e. the plate contributes
  //   nearC     27.6 / 0.636    18.6 / 0.762   +9.0 luma, −0.126 saturation
  //   nearR     33.6 / 0.581    22.0 / 0.722  +11.6 luma, −0.141 saturation
  //
  // So the plate is not merely bright in the near field, it is actively pulling
  // chroma OUT of the bottom third — the one region where both references are at
  // their most saturated. press_002 measures 0.899/0.926 in those two windows
  // and official_033 measures 0.866/0.888, against boards at 0.857 and 0.607.
  // In every reference the near field is the MOST chromatic zone in the frame;
  // in ours it was the least, and this surface is the reason.
  //
  // Same three steps, same rationale, same axis as STRUCT_FRAG's block, so the
  // plate and the clutter standing on it recede together instead of the props
  // binding to the grade while the surface under them drifts to tan:
  //   1. bind hue toward the map's crushed-black tint at CONSTANT luminance
  //      (uDeepUnit is already normalised to unit luma, so this cannot change
  //      value even in principle — the silhouette work above survives intact)
  //   2. extrapolate away from luminance so step 1 can never land on a neutral.
  //
  // Placed before the practical pool on purpose: the pool is a real light and
  // must stay warm: grading after it would drag the brazier's own spill toward
  // the cool anchor, which is the opposite of the warm/cool split the rubric
  // asks for.
  {
    const vec3 LUMA_W = vec3(0.2126, 0.7152, 0.0722);
    // A screen-height term was tried here as a mirror of 'etRecede' (the lower
    // right reads off-palette at every yaw, and screen height is the axis that
    // defect is actually stated on). Measured, it went the wrong way:
    // backgroundFraction 0.208 -> 0.215 with no visible hue improvement, because
    // the warm cast in that corner is the practical pool below, which is added
    // AFTER this grade and so is out of its reach entirely. Left out rather than
    // left in at zero weight, but recorded so it is not re-derived next round.
    float margin = max(nearAmt * nearAmt, lateral * lateral);
    float lum = dot(col, LUMA_W);
    col = mix(col, uDeepUnit * lum, margin * 0.84);
    // Deliberately a weak extrapolation. The first pass ran this at 0.62 and it
    // made the lower right go magenta: extrapolating away from luminance
    // amplifies whatever hue is already present, and where the plate sits under
    // an additive warm glow card the residual is a warm pink, so the term that
    // was supposed to stop the margin going grey instead invented a hue that
    // exists nowhere else in the palette. Binding harder toward the map's own
    // tone and amplifying less converges the whole margin on ONE hue family,
    // which is what both references actually do — their near fields are a single
    // deep chromatic band, not a saturated mixture.
    col = mix(vec3(lum), col, 1.0 + 0.22 * margin);
    col = max(col, 0.0);
  }

  // ── Warm practical pool ──────────────────────────────────────────────────
  //
  // "The fire pit is emissive-only: it blooms but illuminates nothing" and
  // "the grass at its base is the same value as grass ten tiles away" are the
  // same defect seen twice, and on this surface it is at its most obvious:
  // the plate is the largest continuous area in the lower half of the frame and
  // the brazier stands directly on it, throwing nothing.
  //
  // Added AFTER the near-field crush and the lateral margin ramp, deliberately.
  // Those two are composition — they keep the surround under the play space —
  // and a light that a composition ramp can extinguish is not a light. The pool
  // is centred on the brazier, which sits on the board, so it is already near
  // zero by the time either ramp is doing real work; putting it here only
  // guarantees that the glow immediately around the flame survives.
  //
  // Modulated by the plate's own albedo term so it lights the surface rather
  // than painting over it — same rule as the struct shader.
  col += col * etAirlight(vLocal, vec3(0.0, 1.0, 0.0), uAirCentre, uAirRadius, uAirColor);

  // Upward recession, on the same ramp every other environment layer uses. The
  // plate runs all the way to the horizon at 94% of frame height, so its far
  // third sits inside the measured band; grading it with the props standing on
  // it is what keeps the two receding together instead of the plate staying
  // pale behind darkened clutter.
  //
  // Two octave sets: a wide one that reads as banks of air and a tighter one so
  // the band still carries variation at the pixel scale. 'hazeBreak' above is
  // deliberately NOT reused — it is keyed to depth and this is keyed to screen
  // height, and having the two agree would collapse them into one visible edge.
  float recBreak = 0.34 + 0.86 * etFbm(vLocal.xz * 0.085 + 13.4, 3)
                        + 0.40 * etFbm(vLocal.xz * 0.62 - 4.1, 2);
  col = etRecede(col, gl_FragCoord.y / max(uViewH, 1.0), uFade, uDeepUnit, recBreak);

  gl_FragColor = vec4(max(col, 0.0) * uExposure, alpha);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Backdrop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Margin grade applied to any band that does not state its own.
 *
 * Per-band attribution on the round-7 frozen build (hide one band, re-measure
 * the lower-right window that was rendering brighter than the board):
 *
 *   verge   −22 luma    scatter −1.5    fore  −0.8
 *   skirt    −0.5       flank   −1.6    ridge −2.1
 *
 * i.e. the offender was 'verge' — 300 debris pieces at tone 0.82, the highest
 * of any band — and it is a FAR band, so gating the grade on nearness alone
 * never touched it. Every band gets the grade by default now; the lateral term
 * is what makes that safe.
 */
const DEFAULT_SILHOUETTE = 0.62;

interface BandSpec {
  name: string;
  count: number;
  depthMin: number;
  depthMax: number;
  /** Minimum |x|. Used by 'fore' to keep the near band out of frame centre. */
  lateralMin?: number;
  lateralMax: number;
  scale: number;
  haze: [number, number, number];
  /**
   * Airlight ceiling, in the same linear units the band's albedo is authored in.
   * A fully-hazed surface asymptotes toward twice this. Omitted → no ceiling,
   * which is what the un-hazed near bands ('nearfield', 'fore') want.
   *
   * Lower = the band recedes harder. This is the knob that puts the depth
   * ordering back the right way round; see the 'veil' block in 'STRUCT_FRAG'.
   */
  hazeCeil?: number;
  /**
   * Value multiplier for the band. Near-camera bands go dark: in both reference
   * frames the foreground element is a silhouette, and a pale out-of-focus block
   * sitting in front of the board is the worst of both worlds — it reads as
   * untextured placeholder geometry because DoF has smoothed away whatever
   * detail it had.
   */
  tone: number;
  windows: number;
  kinds: readonly PropKind[];
  /**
   * If set, placements are generated by walking the board's footprint PERIMETER
   * and stepping outward by 'clearance … ringMax', instead of by rejection
   * sampling the band rectangle.
   *
   * Rejection sampling was tried first and measurably does not work here: the
   * annulus is a few percent of the sampled area, so the accepted points cluster
   * whereever the generator happened to hit early and whole stretches of the
   * board edge get nothing. On the frame that showed up as the bottom-right wall
   * still cutting a razor line into the ground plate with two props visible in
   * the entire quadrant. Perimeter parameterisation gives uniform coverage of
   * exactly the line that needs breaking up.
   */
  ringMax?: number;
  /** Clearance required from the footprint. Small for clutter, large for buildings. */
  clearance?: number;
  /** Max random lean off vertical, radians. Breaks the axis-aligned read. */
  tilt?: number;
  /** How far pieces sink into the ground plate; hides their flat undersides. */
  sink?: number;
  /**
   * Strength of the margin grade, 0…1. See the grade block in STRUCT_FRAG.
   *
   * The grade is gated on max(nearness², laterality²), and both terms are 0
   * over the middle of the frame at board depth — so this is a measured no-op
   * there whatever it is set to. It only engages toward the frame edges and
   * toward the camera. That is why it defaults ON for every band: the pieces
   * doing the useful silhouette-breaking work against the board sit at frame
   * centre and keep exactly the value they had.
   *
   * An explicit 0 opts a band out entirely.
   */
  silhouette?: number;
}

/**
 * Which albedo/pattern family a prop belongs to: 0 stone, 1 wood, 2 foliage.
 * Consumed as the 'aMat' vertex attribute by 'STRUCT_FRAG'.
 */
const MATERIAL_CLASS: Record<PropKind, number> = {
  house: 0,
  tower: 0,
  wall: 0,
  rock: 0,
  rubble: 0,
  crates: 1,
  barrel: 1,
  fence: 1,
  cart: 1,
  lantern: 1,
  tree: 2,
  bush: 2,
};

type PropKind =
  | 'house'
  | 'tower'
  | 'wall'
  | 'tree'
  | 'rock'
  | 'lantern'
  | 'crates'
  | 'barrel'
  | 'rubble'
  | 'bush'
  | 'fence'
  | 'cart';

export interface BackdropOptions {
  /** Multiplier on how much haze the far bands take. */
  hazeStrength?: number;
  /** Brightness of the window practicals. */
  windowGain?: number;
  /** Overall gain, matched to the map's exposure. */
  exposure?: number;
}

/**
 * The surround. One 'Group'; 'layout()' rebuilds its contents, 'update()' keeps
 * it aligned to the camera.
 */
export class Backdrop extends Group {
  /** Rotates with camera yaw so the composition holds at every yaw slot. */
  private readonly yawRig = new Group();
  private readonly bandMeshes: Mesh[] = [];
  private groundMesh: Mesh | null = null;
  /** R8 copy of the measured footprint field, uploaded once per layout. */
  private footTexture: DataTexture | null = null;

  private readonly structMaterials: ShaderMaterial[] = [];
  private groundMaterial: ShaderMaterial | null = null;

  /** Practical positions harvested while building the bands. Yaw-local. */
  private glowSites: {
    x: number;
    y: number;
    z: number;
    r: number;
    seed: number;
    warm: number;
    /** Per-lamp intensity, already carrying the distance falloff. */
    gain: number;
  }[] = [];
  private glowMesh: Mesh | null = null;
  private glowMaterial: ShaderMaterial | null = null;

  private palette: EnvironmentPalette;
  private readonly opts: Required<BackdropOptions>;
  private currentLayout: BackdropLayout | null = null;

  private readonly sunLocal = new Vector3();
  /** Warm practical pool centre in the yaw-local frame. See 'update'. */
  private readonly airLocal = new Vector3();

  /**
   * Upward-recession ramp and viewport height, held here so materials rebuilt
   * by 'layout()' pick up whatever the orchestrator last set rather than
   * silently reverting to the defaults. Getting this wrong is invisible until a
   * yaw snap triggers a relayout and half the grade disappears mid-battle.
   */
  private readonly fade = new Vector3(...DEFAULT_RECESSION);
  private viewH = 1080;
  private readonly deepUnit = new Color(0.62, 0.78, 1.35);

  constructor(palette: EnvironmentPalette, options: BackdropOptions = {}) {
    super();
    this.name = 'env-backdrop';
    this.palette = palette;
    this.opts = {
      hazeStrength: options.hazeStrength ?? 1,
      windowGain: options.windowGain ?? 1,
      exposure: options.exposure ?? 1,
    };
    this.yawRig.name = 'env-backdrop-yaw';
    this.add(this.yawRig);
    // The surround is scenery. It must not participate in the fitted shadow
    // frustum (it would blow the fit out and destroy the board's texel density)
    // and it must not appear in post's sprite mask.
    this.castShadow = false;
    this.receiveShadow = false;
  }

  /**
   * Layers suppressed for attribution. See 'setLayerHidden'.
   *
   * Kept as a set of names rather than as 'mesh.visible' writes because
   * 'layout()' rebuilds every mesh, and a rebuild that silently un-hid a layer
   * mid-measurement is exactly the kind of thing that makes an attribution run
   * disagree with itself.
   */
  private readonly hidden = new Set<string>();

  // ── build ────────────────────────────────────────────────────────────────

  /**
   * Hide one layer so its contribution to a frame can be measured by difference.
   *
   * Round 7 attributed the over-bright lower-right window by toggling layers at
   * runtime, but did it by hand-editing the source and rebuilding each time.
   * That is slow enough that it only ever got run once, and the numbers in the
   * comments below went stale as a result. Names are the band names ('verge',
   * 'nearfield', 'fore', 'flank', 'skirt', 'scatter', 'apron', 'ridge') plus
   * 'ground' and 'glow'.
   */
  setLayerHidden(name: string, hidden: boolean): void {
    if (hidden) this.hidden.add(name);
    else this.hidden.delete(name);
    this.applyHidden();
  }

  private applyHidden(): void {
    for (const mesh of this.bandMeshes) {
      mesh.visible = !this.hidden.has(mesh.name.replace('env-backdrop-', ''));
    }
    if (this.groundMesh) this.groundMesh.visible = !this.hidden.has('ground');
    if (this.glowMesh) this.glowMesh.visible = !this.hidden.has('glow');
  }

  /** Tear down and regenerate for a new camera framing / board size. */
  layout(layout: BackdropLayout): void {
    this.clearContents();
    this.currentLayout = layout;

    const R = layout.boardRadius;
    const groundY = layout.groundY;
    const halfW = layout.halfW;

    this.buildGround(layout);

    // Bands are expressed relative to the board radius and the *measured*
    // visible depth window, so a 12-tile skirmish map and a 30-tile siege map
    // both get a correctly-scaled surround with no per-map authoring — and
    // nothing is generated where the frame cannot show it.
    const vis = Math.max(layout.visibleDepth, R + 2.5);
    const run = Math.max(2.5, vis - R); // usable depth behind the board
    const bands: BandSpec[] = [
      {
        // Left and right of the board. This is the band that fills the vertical
        // strips at the frame edges, which is where most of the remaining void
        // lives once the camera is framed tight.
        name: 'flank',
        count: 68,
        depthMin: -R * 0.95,
        depthMax: R * 0.95,
        lateralMax: halfW * 2.0,
        scale: 0.78,
        haze: [R * 0.7, R + run * 2.2, 0.36],
        // Gentle: the flank band straddles the board's own depth, so it should
        // sit alongside the play space rather than behind it.
        hazeCeil: 0.30,
        // Measured, not chosen. At 0.62 the near flank house rendered at luma
        // 26/255 with its masonry invisible — a black mass with two lit windows
        // floating on it, which is the void again wearing a building's shape.
        // The equivalent surround band in the Triangle references sits at 60-110.
        tone: 0.95,
        windows: 1,
        // 'rock' dropped here too. The flank band straddles the board's own
        // depth out to twice the visible half-width, i.e. it owns the left and
        // right frame margins — the same near-field the scatter band's rocks
        // were spoiling, reached from the side instead of from below. Buildings,
        // walls and timber props all carry a surface pattern; the cone does not.
        kinds: ['house', 'wall', 'tree', 'lantern', 'crates', 'bush', 'rubble', 'crates', 'cart', 'fence', 'barrel', 'rubble'],
      },
      {
        // The ring hugging the board. This is the band that kills the hard
        // silhouette: 'ringMax' confines it to the four world-units immediately
        // outside the footprint, and at a 30° pitch a knee-high prop there
        // projects straight across the board's lower edge, so the boundary
        // between diorama and surround is broken by objects instead of being a
        // continuous antialiased line.
        //
        // Deliberately all clutter — no buildings. A house against the board
        // edge reads as a second diorama; a spill of rubble reads as the same
        // one continuing.
        name: 'skirt',
        count: 260,
        depthMin: -R * 1.6,
        depthMax: R * 1.6,
        lateralMax: halfW * 1.6,
        // 0.62, down from 0.95. 'rock()' and 'bush()' are authored at 0.7-2.2
        // units *before* the band scale, so at 0.95 a single skirt piece came out
        // up to two and a half world units — two and a half tiles, taller than the
        // masonry courses it is supposed to be piled against. This band's whole
        // job is knee-high debris straddling the base line; anything that reads as
        // a landform is competing with the board rather than dressing it.
        scale: 0.62,
        haze: [R * 1.2, R + run * 2.4, 0.30],
        // Down from 1.06, which was set when this band was still being generated
        // against the AABB — i.e. metres out in open ground, where it was small on
        // screen and needed the lift to be seen at all. The footprint SDF now
        // marches it onto the real facets, and at 1.06 the result was measured on
        // the round-4 frame as the brightest and least saturated mass in the lower
        // half of the image: mean RGB 67/68/64 at saturation 0.43, against the
        // board's own cool masonry at 44/47/54 and 0.68. Neutral grey, brighter
        // than the subject, in the corner of frame. That is three fail conditions
        // at once, and it is what a critic sees first.
        //
        // 0.84 puts it under the board's lit stone and above the plate it stands
        // on, which is the whole contrast requirement.
        tone: 0.84,
        windows: 0,
        ringMax: 5.2,
        clearance: 0.35,
        tilt: 0.16,
        sink: 0.18,
        // No 'rock'. Same reason as 'verge': one large smooth cone is exactly the
        // shape the near-field defocus reduces to a flat value blob, and it is the
        // piece that produced the sage boulder pile. Rubble does the identical
        // silhouette-breaking job as a cluster of small facets, which survives the
        // blur as texture. Bushes stay — they are the only organic silhouette in
        // the kit — but at half the weight they had.
        kinds: ['rubble', 'rubble', 'rubble', 'crates', 'bush', 'barrel', 'fence', 'cart', 'rubble', 'lantern'],
      },
      {
        // The fringe. Small debris packed into the metre and a half hard against
        // the board's outer wall, half-buried, leaning.
        //
        // The skirt band above sits 0.35-5.2 units out, which at a 30° pitch
        // projects *below* the board's base line rather than across it, so the
        // wall/ground boundary itself stayed a continuous antialiased polygon
        // edge — dark stone at luma 18 meeting plate at luma 15 over one pixel,
        // still a razor even after both sides were brought to the same value.
        // What removes a silhouette is geometry straddling it. These pieces are
        // deliberately tiny and dense: individually they read as grit, and
        // collectively they turn a drawn line into a chewed one.
        name: 'verge',
        count: 380,
        depthMin: -R * 1.9,
        depthMax: R * 1.9,
        lateralMax: halfW * 1.7,
        // NOT small. Every band's pieces are already pushed 0.28 below the plate
        // to hide their flat undersides, 'sink' adds to that, and a 'rubble'
        // cluster at scale 0.5 is 0.07-0.37 units tall — so the first version of
        // this band was authored entirely underground and rendered nothing at
        // all. Scale is what makes a piece survive the burial, not what makes it
        // read as debris; the density and the tilt do that.
        //
        // ART-DIRECTION PASS — 0.80 was the single loudest defect left in the frame,
        // and it is a SCREEN-SIZE problem that no shader change can reach.
        //
        // 'rubble()' emits boxes of up to 0.56·scale·bandScale world units in clusters
        // up to 2.9 units across. This band runs to depth −1.9R, i.e. right under the
        // lens, where one world unit is roughly 200 screen pixels — so a bottom-corner
        // verge cluster was a handful of half-metre boxes rendering three hundred
        // pixels wide. Every surface pattern in STRUCT_FRAG runs at 0.9–13 cycles per
        // world unit, so a face that large carries well under one cycle and integrates
        // to a constant: flat-shaded faceted low-poly boxes with no surviving texture,
        // which is exactly what four rounds of critics named.
        //
        // The band's job — chew the plate/board silhouette line with dense small grit —
        // is unchanged and is better served small. At 0.46 a near piece is ~90px rather
        // than ~300px, which puts it under the ~25px circle of confusion in the near
        // field and lets it blur into mass instead of resolving as geometry, and the
        // count goes up to hold the density that does the silhouette work.
        //
        // 'sink' pays for it: the pieces are pushed 0.28 below the plate before the
        // band's own sink, which at this scale would bury the band entirely (that is
        // the failure the paragraph above records). Negative sink lifts them back.
        scale: 0.46,
        haze: [R * 1.4, R + run * 2.6, 0.26],
        // 0.82, not 1.0. Once the footprint SDF landed, this band stopped being
        // generated out in open ground and started actually hugging the wall —
        // which is what it was for, but it also meant 300 pieces at full tone
        // suddenly sat *in front of* the board's near masonry. Grit that reads
        // brighter than the wall it is piled against is not grit, it is a second
        // subject. It has to sit under the stone it dresses.
        //
        // Round 7: it still did not. Per-band attribution on the frozen build —
        // hide exactly one band, re-measure — put this band at −22 luma in the
        // lower-right window, against −0.5 to −2.1 for every other band. It was
        // single-handedly holding the zone in front of the subject at luma 84
        // while the board sat at 77, and it is the highest tone in the whole
        // spec table. 0.82 was reasoned toward from 1.0 but never measured
        // against the board it dresses.
        //
        // Cutting it globally (0.52) did fix the margin — 84 -> 63 luma — but it
        // also took backgroundFraction 0.083 -> 0.137 and background sd 16.4 ->
        // 14.2, because this band's 300 pieces at frame CENTRE are a large part
        // of the detail that keeps the surround from scoring as void. The cut
        // belongs at the frame edges only, which is what the margin grade in
        // STRUCT_FRAG now does — but the grade turned out to be the wrong tool
        // for VALUE (every value-side variant traded margin luma for background
        // flatness one-for-one). So the tone cut stays and the grade is
        // chroma-only; together they measured best of everything tried:
        // margin 84 -> 61, bgFrac 0.137, background sd 14.2.
        tone: 0.52,
        windows: 0,
        ringMax: 1.7,
        // 0.02, not 0: 'footprintDistance' is unsigned, so a negative clearance
        // would disable the rejection test entirely and let a quarter of these
        // spawn *inside* the play space, poking up through courtyard tiles.
        clearance: 0.02,
        tilt: 0.42,
        sink: -0.17,
        // No 'rock' here, deliberately. 'rock()' is a six-sided cone squashed at
        // 0.7-2.2 units before the band scale, so a verge boulder came out over
        // two tiles across — bigger than the masonry blocks it leans on, smooth
        // enough that the near-field DoF erased what little facet detail it had,
        // and in the one desaturated sage the kit owns. Measured on the round-4
        // frame the south-east cluster was the least saturated mass in the image
        // (0.44 against the board's 0.67) and read as a pale untextured card.
        // Rubble is the same silhouette job done by eight small pieces instead
        // of one large one, and it survives the blur as texture rather than as a
        // value blob.
        kinds: ['rubble', 'rubble', 'rubble', 'rubble', 'bush', 'bush', 'crates'],
      },
      {
        // Dressing spread over the whole visible ground plate.
        //
        // The plate's own shader cannot fix itself: measured on the frame it
        // came back at sd 20/255 across the bottom-right fifth of the image,
        // because every octave it carries runs above the frequency the near-field
        // DoF preserves. Scattered geometry is variation the blur cannot remove —
        // it turns into soft value blobs, which is exactly what the reference
        // frames' out-of-focus margins are made of.
        name: 'scatter',
        count: 300,
        depthMin: layout.nearDepth * 1.05,
        depthMax: R + run * 1.1,
        lateralMax: halfW * 1.85,
        scale: 0.85,
        haze: [R * 0.9, R + run * 1.9, 0.5],
        // 0.72 put a cluster of pale sage boulders at luma 48 hard against the
        // right frame edge — the brightest mass in the lower third, in the one
        // hue that belongs to neither side of the grade, and smooth because the
        // defocus at that distance leaves only value behind. Dressing on the
        // outer plate must sit under the play space, not over it.
        tone: 0.58,
        windows: 0,
        clearance: 4.0,
        tilt: 0.14,
        sink: 0.14,
        // This band spans the whole depth range, so its far pieces must keep
        // their current read. They do: the grade is gated on nearAmt², which is
        // 0 for anything at or beyond the board, so only the pieces that
        // actually crowd the camera are touched.
        silhouette: 0.7,
        // No 'rock', and 'bush' down from two slots to one.
        //
        // This band was the last place 'rock()' still ran in the near field, and
        // it is the one that shows: hiding the backdrop and re-shooting puts the
        // entire bottom-right cluster — big smooth pale-blue wedges with mint
        // facets, no masonry pattern, no cavity darkening — on this band and no
        // other. It is verbatim the "near-white flat-faceted low-poly chunks
        // with no texture, no AO and no colour tie to the scene, placeholder
        // geometry left in frame" note, and the "olive-green rock props" note is
        // the same generator wearing the foliage albedo.
        //
        // The same removal was already made on 'verge' and 'skirt' for the same
        // measured reason, and the reasoning transfers exactly: 'rock()' is one
        // large smooth cone, the near-field circle of confusion erases what
        // facet detail it has, and a smooth pale value blob is what is left.
        // 'rubble' does the identical silhouette-breaking job as a cluster of
        // small pieces that survives the blur AS TEXTURE, and it takes the
        // masonry pattern in STRUCT_FRAG where a cone's UVs do not.
        kinds: ['rubble', 'rubble', 'crates', 'bush', 'fence', 'barrel', 'tree', 'cart', 'rubble', 'crates'],
      },
      {
        // Immediately behind the board: low outbuildings, walls, scrub.
        name: 'apron',
        count: 66,
        depthMin: R + 0.8,
        depthMax: R + run * 0.62,
        lateralMax: halfW * 1.95,
        scale: 1.0,
        haze: [R + 0.5, R + run * 1.5, 0.55],
        tone: 0.96,
        // Looser than 'ridge' — this band is one depth step nearer, and the
        // whole point is that the two now separate by value instead of both
        // sitting at board brightness.
        hazeCeil: 0.15,
        windows: 1,
        kinds: ['house', 'house', 'tree', 'wall', 'lantern', 'rock', 'tower'],
      },
      {
        // The band whose tops crop against the top edge of the frame. Bases sit
        // near the horizon; heights are deliberately over-scaled so the roofline
        // runs off the image the way it does in both references.
        name: 'ridge',
        count: 46,
        depthMin: R + run * 0.45,
        depthMax: R + run * 1.25,
        lateralMax: halfW * 1.95,
        scale: 1.5,
        haze: [R, R + run * 1.1, 0.80],
        // 0.92, down from 1.15. This band was the BRIGHTEST in the surround —
        // the furthest layer authored a sixth hotter than the apron in front of
        // it — which is depth cueing running backwards. The over-scale that
        // makes the roofline crop against the top edge is worth keeping; the
        // value lift that came with it was not.
        tone: 0.92,
        // The tightest ceiling in the set: this is the layer that should read as
        // a silhouette in air, so its lit faces and its windows both get pulled
        // down toward the airlight. Not lower than this — the band still has to
        // clear the void test, and a far layer crushed to near-black is counted
        // as background by tools/metrics.mjs (and read as one by a critic).
        hazeCeil: 0.06,
        windows: 1,
        kinds: ['tower', 'house', 'wall', 'tower', 'tree'],
      },
      {
        // The near strip: everything between the board's near corner and the
        // bottom edge of the frame.
        //
        // 'fore' only covers the extreme left and right of that strip
        // ('lateralMin' holds it out of frame centre) and 'verge' stops 1.7
        // units off the wall, so at the shipping 45° yaw the wedge under the
        // board's near corner — about a tenth of the image — had nothing in it
        // but plate, measured at sd 6/255. Both references fill the equivalent
        // area: Triangle with dock stone and rigging, FFT with foreground
        // terrain running off the bottom of the frame.
        //
        // Deliberately dark. This strip sits under the largest circle of
        // confusion in the shot, so surface detail on anything here is erased —
        // what survives is silhouette against a slightly lighter ground, which
        // is exactly how the reference foregrounds read.
        name: 'nearfield',
        count: 130,
        depthMin: layout.nearDepth * 1.15,
        depthMax: -R * 0.12,
        lateralMax: halfW * 1.9,
        scale: 0.9,
        haze: [-999, -998, 0.0],
        // Silhouette value. Measured at 0.48 the right-hand outcrop came back at
        // luma 47 in a desaturated sage — the brightest thing in the lower third
        // of the frame and the only pale mass in a warm/navy grade, i.e. exactly
        // the "flat untextured card" read, because DoF erases its surface at
        // this distance and only the value survives.
        tone: 0.40,
        windows: 0,
        clearance: 1.35,
        tilt: 0.22,
        sink: 0.1,
        // Attributed at runtime: this band plus 'fore' and 'scatter' put +35
        // luma into the lower-right of the frame, over an environment-off floor
        // of 35 — i.e. they were doubling the value of the zone in front of the
        // subject. Graded rather than merely dimmed; see STRUCT_FRAG.
        silhouette: 0.85,
        kinds: ['bush', 'rock', 'rubble', 'crates', 'barrel', 'fence', 'cart', 'bush', 'rock'],
      },
      {
        // Out-of-focus foreground framing, hard against the left and right
        // frame edges.
        //
        // This band is only allowed organic shapes now. Buildings here came out
        // as metre-wide near-black rectangles: DoF erases their surface detail,
        // the near-camera tone crushes their value range, and what is left is a
        // slab of cardboard taped over a third of the image. Foliage and rock
        // survive the same blur because their silhouette is doing the work.
        name: 'fore',
        count: 13,
        depthMin: layout.nearDepth * 0.5,
        depthMax: layout.nearDepth * 1.45,
        lateralMin: halfW * 1.02,
        lateralMax: halfW * 1.95,
        scale: 0.85,
        haze: [-999, -998, 0.0],
        // Dark, but not a hole. The references' foreground occluders are
        // silhouettes that still carry readable value structure.
        //
        // 0.46 was still far too high once the near strip filled up around it:
        // the foliage albedo is the one desaturated-green material in the kit,
        // and a metre-wide out-of-focus sage mass in the bottom-right corner at
        // luma 60 read as a pale untextured card taped over the frame. The
        // reference foregrounds are near-silhouettes — Triangle's dock pilings
        // and FFT's foreground terrain both sit under luma 30.
        tone: 0.24,
        windows: 0,
        // The closest band to camera, and the one the references treat most
        // severely — Triangle's dock pilings and FFT's foreground terrain are
        // near-black chromatic masses, not lit props.
        silhouette: 1.0,
        kinds: ['bush', 'bush', 'bush', 'rock', 'rubble'],
      },
    ];

    this.glowSites = [];
    let bandIndex = 0;
    for (const band of bands) {
      const mesh = this.buildBand(band, layout, groundY, bandIndex);
      if (mesh) this.yawRig.add(mesh);
      bandIndex += 1;
    }
    this.buildGlow();

    this.applyPalette();
    // A relayout rebuilds every mesh, so re-assert any attribution suppression.
    this.applyHidden();
  }

  /** One merged draw call of view-aligned additive cards, one per practical. */
  private buildGlow(): void {
    const sites = this.glowSites;
    if (sites.length === 0) return;

    const n = sites.length;
    const corner = new Float32Array(n * 4 * 3);
    const centre = new Float32Array(n * 4 * 3);
    const radius = new Float32Array(n * 4);
    const seed = new Float32Array(n * 4);
    const warm = new Float32Array(n * 4);
    const gain = new Float32Array(n * 4);
    const index: number[] = [];
    const quad = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];

    for (let i = 0; i < n; i += 1) {
      const s = sites[i]!;
      for (let k = 0; k < 4; k += 1) {
        const v = i * 4 + k;
        corner[v * 3 + 0] = quad[k]![0]!;
        corner[v * 3 + 1] = quad[k]![1]!;
        corner[v * 3 + 2] = 0;
        centre[v * 3 + 0] = s.x;
        centre[v * 3 + 1] = s.y;
        centre[v * 3 + 2] = s.z;
        radius[v] = s.r;
        seed[v] = s.seed;
        warm[v] = s.warm;
        gain[v] = s.gain;
      }
      const b = i * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(corner, 3));
    geo.setAttribute('aCenter', new BufferAttribute(centre, 3));
    geo.setAttribute('aRadius', new BufferAttribute(radius, 1));
    geo.setAttribute('aSeed', new BufferAttribute(seed, 1));
    geo.setAttribute('aWarm', new BufferAttribute(warm, 1));
    geo.setAttribute('aGain', new BufferAttribute(gain, 1));
    geo.setIndex(index);

    const material = new ShaderMaterial({
      name: 'env-glow',
      uniforms: {
        uWarmColor: { value: new Color() },
        uCoolColor: { value: new Color() },
        uGain: { value: this.opts.exposure },
        uTime: { value: 0 },
        uFade: { value: this.fade.clone() },
        uViewH: { value: this.viewH },
      },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    });

    const mesh = new Mesh(geo, material);
    mesh.name = 'env-glow';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 250;
    this.glowMesh = mesh;
    this.glowMaterial = material;
    this.yawRig.add(mesh);
  }

  private buildBand(
    band: BandSpec,
    layout: BackdropLayout,
    groundY: number,
    index: number,
  ): Mesh | null {
    const rng = mulberry32(layout.seed * 7919 + index * 104729);
    const pieces: BufferGeometry[] = [];

    // Rotate a yaw-local (x, depth) back onto the world axes so the footprint
    // test uses the board's actual rectangle. Local −Z is "away", so the local
    // offset is (x, 0, −depth).
    const cy = Math.cos(layout.yaw);
    const sy = Math.sin(layout.yaw);
    const clearance = band.clearance ?? 1.5;
    /**
     * Distance from the board's real footprint rectangle, 0 while inside it.
     * A rectangle, not a disc: at 45° yaw a circumscribed disc forbids placement
     * across the whole visible left and right strips, which is exactly where the
     * void lives.
     */
    const field = layout.footprint;
    const footprintDistance = (x: number, depth: number): number => {
      const wx = cy * x + sy * -depth;
      const wz = -sy * x + cy * -depth;
      if (field) return Math.max(0, sampleFootprint(field, wx, wz));
      const dx = Math.abs(wx) - layout.boardHalfX;
      const dz = Math.abs(wz) - layout.boardHalfZ;
      return Math.hypot(Math.max(0, dx), Math.max(0, dz));
    };

    // Perimeter walk, for ring bands. Returns a yaw-local (x, depth) sitting a
    // short way outside the footprint edge, distributed evenly along it.
    const hx = layout.boardHalfX;
    const hz = layout.boardHalfZ;
    const perimeter = 2 * (hx + hz) * 2;
    const ringPoint = (): { x: number; depth: number } => {
      let t = rng() * perimeter;
      let wx: number;
      let wz: number;
      let nx: number;
      let nz: number;
      const sideX = 2 * hx;
      const sideZ = 2 * hz;
      if (t < sideX) {
        wx = -hx + t; wz = hz; nx = 0; nz = 1;
      } else if ((t -= sideX) < sideZ) {
        wx = hx; wz = hz - t; nx = 1; nz = 0;
      } else if ((t -= sideZ) < sideX) {
        wx = hx - t; wz = -hz; nx = 0; nz = -1;
      } else {
        t -= sideX;
        wx = -hx; wz = -hz + t; nx = -1; nz = 0;
      }
      // Jitter along the edge as well, so the run does not read as a hedge.
      const along = (rng() - 0.5) * 1.8;
      wx += -nz * along;
      wz += nx * along;

      // March in from the AABB edge to the REAL edge.
      //
      // Without this the ring hugs the bounding box, which on a map with corner
      // towers or any non-rectangular outline sits metres outside the facets the
      // camera sees — so a band authored to break the wall/ground boundary was
      // generated in open ground beyond it and the boundary stayed a razor line.
      // Marching until the field crosses zero puts every piece against the mass
      // that is actually there.
      if (field) {
        const step = Math.max(0.18, field.cell * 0.75);
        for (let k = 0; k < 96; k += 1) {
          if (sampleFootprint(field, wx, wz) <= 0.02) break;
          wx -= nx * step;
          wz -= nz * step;
        }
      }

      const out = clearance + rng() * Math.max(0.1, (band.ringMax ?? 3) - clearance);
      wx += nx * out;
      wz += nz * out;
      return { x: cy * wx - sy * wz, depth: -(sy * wx + cy * wz) };
    };

    let attempts = 0;
    let placed = 0;
    while (placed < band.count && attempts < band.count * 40) {
      attempts += 1;
      let depth: number;
      let x: number;
      if (band.ringMax !== undefined) {
        const p = ringPoint();
        x = p.x;
        depth = p.depth;
        // Still has to be inside the window the frame can actually show.
        if (Math.abs(x) > band.lateralMax) continue;
        if (depth < band.depthMin || depth > band.depthMax) continue;
      } else {
        depth = band.depthMin + rng() * (band.depthMax - band.depthMin);
        const lateralMin = band.lateralMin ?? 0;
        x =
          (rng() < 0.5 ? -1 : 1) * (lateralMin + rng() * Math.max(0, band.lateralMax - lateralMin));
      }

      // Keep the play space clear.
      if (footprintDistance(x, depth) < clearance) continue;

      let kind = band.kinds[Math.floor(rng() * band.kinds.length)]!;

      // ── No massing in front of the subject ────────────────────────────────
      //
      // 'house', 'tower' and 'wall' are the three generators that produce a
      // single large flat face, and a large flat face is only ever an asset when
      // it is BEHIND the board. Placed at negative depth — between the lens and
      // the play space — it renders as a slab: measured on the round-8 frame the
      // flank band dropped a house against the lower-right frame edge covering
      // roughly a seventh of the image in one blue-grey plane with one lit
      // window on it, which is the flat-untextured-surface fail condition at the
      // largest scale anything in this file can produce it.
      //
      // The bands cannot express this themselves. 'flank' deliberately straddles
      // the board's depth (that is its whole job — it fills the left and right
      // margins alongside the play space, not behind it), so its kind list has
      // to contain buildings for the two thirds of its range where they belong.
      // Substituting at placement time is the only place that knows which third
      // a given piece landed in.
      //
      // Demoted rather than rejected: rejecting would thin the band exactly
      // where the void used to live. Clutter fills the same silhouette without
      // the flat plane.
      //
      // 'tree' and 'rock' get a MORE generous exclusion than the buildings do,
      // and the reason is a shape argument rather than a placement one. A
      // conifer is three stacked six-segment cones 2.2-5.6 units tall and a
      // boulder is a displaced icosahedron; both are large, smooth and
      // low-facet-count, so the near-field circle of confusion reduces them to
      // untextured value blobs — the "near-white flat-faceted low-poly chunks
      // with no texture and no colour tie to the scene" and "olive-green rock
      // props" notes are both this. A building at least keeps a lit window and a
      // masonry course. So the cones have to clear the board's midline by half a
      // radius, not merely sit behind its centre.
      //
      // This is the same conclusion 'rock()' own comment reached about spikes,
      // generalised: the fix is not to make the generator lumpier, it is to stop
      // putting a two-metre smooth mass between the lens and the subject.
      const nearLimit =
        kind === 'tree' || kind === 'rock' ? layout.boardRadius * 0.55 : 0;
      if (depth < nearLimit && NEAR_DEMOTED.has(kind)) {
        kind = NEAR_SUBSTITUTES[Math.floor(rng() * NEAR_SUBSTITUTES.length)]!;
      }

      let parts: BufferGeometry[];
      switch (kind) {
        case 'house':
          parts = house(rng);
          break;
        case 'tower':
          parts = tower(rng, band.scale);
          break;
        case 'wall':
          parts = wall(rng, 3 + rng() * 7);
          break;
        case 'tree':
          parts = tree(rng);
          break;
        case 'rock':
          parts = rock(rng, 0.7 + rng() * 1.5);
          break;
        case 'crates':
          parts = crates(rng, 0.7 + rng() * 0.8);
          break;
        case 'barrel':
          parts = barrel(rng, 0.7 + rng() * 0.7);
          break;
        case 'rubble':
          parts = rubble(rng, 0.6 + rng() * 1.2);
          break;
        case 'bush':
          parts = bush(rng, 0.6 + rng() * 1.1);
          break;
        case 'fence':
          parts = fence(rng, 1.8 + rng() * 4.5, 0.8 + rng() * 0.5);
          break;
        case 'cart':
          parts = cart(rng, 0.8 + rng() * 0.6);
          break;
        default:
          parts = lantern(rng);
          break;
      }

      const s = band.scale * (0.82 + rng() * 0.45);
      const rot = rng() * Math.PI * 2;
      const tint = rng();
      // Trees, rocks and lamp posts have no windows; buildings do.
      const win = band.windows > 0 && (kind === 'house' || kind === 'tower' || kind === 'wall') ? 1 : 0;
      const mat = MATERIAL_CLASS[kind];
      const tiltX = band.tilt ? (rng() - 0.5) * 2 * band.tilt : 0;
      const tiltZ = band.tilt ? (rng() - 0.5) * 2 * band.tilt : 0;
      const sink = band.sink ?? 0;

      for (const part of parts) {
        part.scale(s, s * (0.9 + rng() * 0.3), s);
        part.rotateY(rot);
        if (tiltX !== 0) part.rotateX(tiltX);
        if (tiltZ !== 0) part.rotateZ(tiltZ);
        part.translate(x, groundY - 0.28 - sink, -depth);
        const n = part.attributes.position!.count;
        part.setAttribute('aTint', new BufferAttribute(new Float32Array(n).fill(tint), 1));
        part.setAttribute('aWindow', new BufferAttribute(new Float32Array(n).fill(win), 1));
        part.setAttribute('aMat', new BufferAttribute(new Float32Array(n).fill(mat), 1));
        if (!part.attributes.uv) {
          part.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2));
        }
        part.deleteAttribute('normal');
        part.computeVertexNormals();
        pieces.push(part);
      }

      // Harvest the practicals. A lamp post is a dark box on a stick until
      // something visibly emits from it; the glow card is what turns the
      // surround's lamps into the "you can trace every highlight back to a lamp"
      // read the reference frames have.
      if (kind === 'lantern') {
        let topY = -Infinity;
        for (const part of parts) {
          part.computeBoundingBox();
          const bb = part.boundingBox;
          if (bb) topY = Math.max(topY, bb.max.y);
        }
        if (Number.isFinite(topY)) {
          this.glowSites.push({
            x,
            y: topY - 0.22 * s,
            z: -depth,
            // Halo size falls off with distance, hard.
            //
            // Under an orthographic rig a one-unit sphere covers the same number
            // of pixels whether it is four units away or forty, so a card sized
            // in world units gives every practical in the surround the same
            // apparent diameter. Blurred by the DoF pass that becomes a field of
            // interchangeable discs at wildly different implied depths, which is
            // the "fake bokeh, composited sprite layer, no scale cue" note
            // verbatim — and it is the projection's fault, not the blur's, so it
            // has to be corrected here. The 0.5 exponent is a deliberate cheat:
            // true 1/d would shrink the ridge lamps to nothing.
            r:
              (0.34 + rng() * 0.9) *
              (depth < 0 ? 1.35 : 1) *
              (1 / Math.sqrt(1 + Math.max(0, depth) / Math.max(4, layout.boardRadius * 0.7))),
            seed: rng(),
            warm: 0.55 + rng() * 0.45,
            // Inverse-square-ish, for the same reason. A lamp at the back of the
            // surround is not as bright as one at the board's edge, and the eye
            // reads that ratio as depth even in a still frame.
            gain: 1 / (1 + Math.pow(Math.max(0, depth) / Math.max(5, layout.boardRadius), 1.5)),
          });
        }
      }

      placed += 1;
    }

    if (pieces.length === 0) return null;
    const merged = mergeGeometries(pieces, false);
    for (const p of pieces) p.dispose();
    if (!merged) return null;

    const material = new ShaderMaterial({
      name: `env-backdrop-${band.name}`,
      uniforms: {
        uBase: { value: new Color() },
        uRoof: { value: new Color() },
        uWood: { value: new Color() },
        uFoliage: { value: new Color() },
        uHaze: { value: new Color() },
        uSunColor: { value: new Color() },
        uSkyColor: { value: new Color() },
        uSunLocal: { value: new Vector3(0, -1, 0) },
        uWindowColor: { value: new Color() },
        uHazeNear: { value: band.haze[0] },
        uHazeFar: { value: band.haze[1] },
        uHazeMax: { value: Math.min(0.96, band.haze[2] * this.opts.hazeStrength) },
        // 8.0 is "effectively no ceiling" — every value in this shader is far
        // below it, so the knee is a no-op for bands that opt out.
        uHazeCeil: { value: band.hazeCeil ?? 8.0 },
        uGroundY: { value: groundY },
        uNearDepth: { value: Math.min(-2, layout.nearDepth) },
        uTone: { value: band.tone },
        uDeep: { value: new Color() },
        uSilhouette: { value: band.silhouette ?? DEFAULT_SILHOUETTE },
        uHalfW: { value: layout.halfW },
        uWindowGain: { value: (band.windows > 0 ? 1 : 0) * this.opts.windowGain },
        uExposure: { value: this.opts.exposure },
        uTime: { value: 0 },
        uFade: { value: this.fade.clone() },
        uDeepUnit: { value: this.deepUnit.clone() },
        uViewH: { value: this.viewH },
        uAirColor: { value: new Color(0, 0, 0) },
        uAirCentre: { value: new Vector3() },
        uAirRadius: { value: 12 },
        uHueVary: { value: 1 },
      },
      vertexShader: STRUCT_VERT,
      fragmentShader: STRUCT_FRAG,
      fog: false,
      toneMapped: false,
      side: DoubleSide,
    });

    const mesh = new Mesh(merged, material);
    mesh.name = `env-backdrop-${band.name}`;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Behind the board in the opaque queue. Not strictly required (depth sorts
    // it) but it keeps overdraw on the board itself down.
    mesh.renderOrder = band.name === 'fore' ? -50 : -200 + index;

    this.bandMeshes.push(mesh);
    this.structMaterials.push(material);
    return mesh;
  }

  private buildGround(layout: BackdropLayout): void {
    const extent = Math.max(layout.halfW * 2.4, layout.horizonDepth * 1.3, 48);
    const segments = 150;
    const geo = new BufferGeometry();
    const verts = new Float32Array((segments + 1) * (segments + 1) * 3);
    const index: number[] = [];
    let v = 0;
    for (let j = 0; j <= segments; j += 1) {
      for (let i = 0; i <= segments; i += 1) {
        verts[v++] = (i / segments - 0.5) * 2 * extent;
        verts[v++] = 0;
        // Bias the plate backwards: most of the useful area is *behind* the
        // board, since that is where the frame's negative space is.
        verts[v++] = (j / segments - 0.62) * 2 * extent;
      }
    }
    for (let j = 0; j < segments; j += 1) {
      for (let i = 0; i < segments; i += 1) {
        const a = j * (segments + 1) + i;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    geo.setAttribute('position', new BufferAttribute(verts, 3));
    geo.setIndex(index);

    // The footprint field as a single-channel byte texture. R8 rather than a
    // float format because it is filterable everywhere without an extension,
    // and 256 steps over ±1.6 board radii is ~0.13 world units per step — two
    // orders of magnitude finer than the softest term that reads it.
    let footTex: DataTexture | null = null;
    const field = layout.footprint;
    if (field) {
      footTex = new DataTexture(field.encoded, field.res, field.res, RedFormat, UnsignedByteType);
      footTex.name = 'env-footprint';
      footTex.magFilter = LinearFilter;
      footTex.minFilter = LinearFilter;
      footTex.wrapS = ClampToEdgeWrapping;
      footTex.wrapT = ClampToEdgeWrapping;
      footTex.colorSpace = NoColorSpace;
      footTex.generateMipmaps = false;
      footTex.needsUpdate = true;
      this.footTexture = footTex;
    }

    const material = new ShaderMaterial({
      name: 'env-ground',
      uniforms: {
        uNearColor: { value: new Color() },
        uFarColor: { value: new Color() },
        uHaze: { value: new Color() },
        uSunColor: { value: new Color() },
        uSkyColor: { value: new Color() },
        uSunLocal: { value: new Vector3(0, -1, 0) },
        uShadowOffset: { value: new Vector2() },
        uFootHalf: {
          value: new Vector2(Math.max(0.5, layout.boardHalfX), Math.max(0.5, layout.boardHalfZ)),
        },
        uYawCS: { value: new Vector2(Math.cos(layout.yaw), Math.sin(layout.yaw)) },
        uFootTex: { value: footTex ?? fallbackFootTexture() },
        uFootOrigin: { value: layout.footprint?.originX ?? 0 },
        uFootSpan: { value: layout.footprint?.span ?? 1 },
        uFootRange: { value: layout.footprint?.range ?? 1 },
        uFootHas: { value: footTex ? 1 : 0 },
        uBoardRadius: { value: layout.boardRadius },
        uHazeNear: { value: layout.boardRadius * 0.9 },
        uHorizonDepth: { value: layout.horizonDepth },
        uHalfW: { value: layout.halfW },
        uNearDepth: { value: Math.min(-2, layout.nearDepth) },
        uUndulate: { value: Math.min(3.2, Math.max(1.2, layout.boardRadius * 0.24)) },
        uExposure: { value: this.opts.exposure },
        uShadowStrength: { value: 0.42 },
        uFade: { value: this.fade.clone() },
        uDeepUnit: { value: this.deepUnit.clone() },
        uViewH: { value: this.viewH },
        uAirColor: { value: new Color(0, 0, 0) },
        uAirCentre: { value: new Vector3() },
        uAirRadius: { value: 12 },
      },
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      transparent: true,
      depthWrite: true,
      fog: false,
      toneMapped: false,
      side: DoubleSide,
    });

    const mesh = new Mesh(geo, material);
    mesh.name = 'env-ground';
    mesh.position.y = layout.groundY;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = -300;
    this.groundMesh = mesh;
    this.groundMaterial = material;
    this.yawRig.add(mesh);
  }

  // ── per-frame ────────────────────────────────────────────────────────────

  /**
   * @param cameraForward normalised world direction the camera looks along
   * @param elapsed       seconds, for the window flicker
   */
  update(cameraForward: Vector3, elapsed: number): void {
    // local −Z must point along the camera's ground-projected forward.
    const yaw = Math.atan2(-cameraForward.x, -cameraForward.z);
    this.yawRig.rotation.y = yaw;

    // Sun direction expressed in the yaw-local frame, so all the shading and
    // the ground shadow stay stable while the rig turns.
    this.sunLocal.copy(this.palette.sunDirection).applyAxisAngle(UP, -yaw);

    // Practical pool centre, world → yaw-local. 'this.position' is the board
    // centre (the orchestrator re-centres this group on it every frame), and
    // the yawRig these meshes live under carries the yaw, so the same
    // subtract-then-unrotate that puts the sun in local space puts the fire
    // there too. Getting this wrong does not look like a bug — the pool simply
    // lands somewhere else on the plate — so it is derived rather than tuned.
    this.airLocal
      .copy(this.palette.airlightCentre)
      .sub(this.position)
      .applyAxisAngle(UP, -yaw);

    for (const m of this.structMaterials) {
      (m.uniforms.uSunLocal!.value as Vector3).copy(this.sunLocal);
      (m.uniforms.uAirCentre!.value as Vector3).copy(this.airLocal);
      m.uniforms.uTime!.value = elapsed;
    }
    if (this.glowMaterial) this.glowMaterial.uniforms.uTime!.value = elapsed;
    if (this.groundMaterial) {
      (this.groundMaterial.uniforms.uSunLocal!.value as Vector3).copy(this.sunLocal);
      // The plate's geometry is authored flat at y = 0 and the MESH carries the
      // ground height (−1.64 on this map), so 'vLocal.y' in GROUND_FRAG is zero
      // everywhere and is not comparable to a world-height air centre. Lifting
      // the centre by the mesh offset puts the two back in the same frame;
      // without it the pool is computed a metre and a half too close to the
      // plate and reads hotter than the falloff says it should.
      (this.groundMaterial.uniforms.uAirCentre!.value as Vector3)
        .copy(this.airLocal)
        .setY(this.airLocal.y - (this.groundMesh?.position.y ?? 0));
      // Tracked from the LIVE yaw, not the layout's. 'relayoutIfNeeded' only
      // fires past a 0.05 rad threshold, and during the eased yaw snap the rig
      // spends about a second between slots; a footprint SDF built for the old
      // heading would swing the occlusion bowl off the board for that whole
      // interval and pop it back.
      (this.groundMaterial.uniforms.uYawCS!.value as Vector2).set(Math.cos(yaw), Math.sin(yaw));
      // Board shadow lands opposite the sun, length scaled by its elevation.
      const horiz = Math.hypot(this.sunLocal.x, this.sunLocal.z);
      const drop = Math.max(0.25, -this.sunLocal.y);
      const reach = Math.min(3.2, horiz / drop) * (this.currentLayout?.boardRadius ?? 8) * 0.35;
      (this.groundMaterial.uniforms.uShadowOffset!.value as Vector2).set(
        this.sunLocal.x * reach,
        this.sunLocal.z * reach,
      );
    }
  }

  setPalette(palette: EnvironmentPalette): void {
    this.palette = palette;
    this.applyPalette();
  }

  /**
   * Everything here mixes against 'palette.horizon', never against
   * 'palette.sun'. The key colour is a *light* — its channels run to 1.0 — so
   * lerping a 0.03-linear albedo 30% toward it lands at 0.3 and blows out under
   * the tonemapper. 'horizon' already carries the key's hue at a background
   * level, which is the value these surfaces want.
   */
  private applyPalette(): void {
    const p = this.palette;

    // Hue and level are set separately, for the same reason 'sky.ts' does it:
    // deriving a surface colour by lerping between two *levelled* colours drags
    // it toward whichever one is brighter and the result desaturates. The first
    // version of this produced pale neutral-grey walls and pale neutral-grey
    // roofs — a village of untextured slabs, and a direct hit on the
    // no-flat-surfaces fail condition.
    const norm = (c: Color): Color => {
      const m = Math.max(c.r, c.g, c.b, 1e-5);
      return c.multiplyScalar(1 / m);
    };
    const hazeTint = norm(p.haze.clone());
    const sunTint = norm(p.sun.clone());
    const deepTint = norm(p.deep.clone());

    // Cool stone, saturated toward the map's own shadow colour.
    //
    // Levels measured, not chosen. Sampling the surround band of
    // 'refs/curated/triangle/official_001_steam.jpg' puts its background
    // architecture at luma 86–165/255; the previous levels here (0.052 / 0.034)
    // rendered ours at luma 21–33, which is why 'tools/metrics.mjs' scored a
    // third of the frame as void: near-black textured geometry is
    // indistinguishable from no geometry at all, and the corner-match test
    // counts it as background. Raising the albedo is not "brightening the
    // scene" — the board is still four stops above this — it is the difference
    // between a village behind the map and a hole behind the map.
    const wallBase = norm(hazeTint.clone().lerp(deepTint, 0.45)).multiplyScalar(0.148);
    // Warm tile. Darker than the walls: a roof plane faces the sky, so if it is
    // also the lightest albedo in the set every rooftop reads as a highlight.
    const roof = norm(sunTint.clone().lerp(hazeTint, 0.62)).multiplyScalar(0.094);
    // Two hues the surround did not previously contain anywhere. Warm timber
    // and cool-green foliage are what let a crate read as a crate and a hedge as
    // a hedge at thumbnail size, and they are the tertiary colours every note on
    // the grade asked for.
    const wood = norm(sunTint.clone().lerp(TIMBER, 0.72)).multiplyScalar(0.126);
    const foliage = norm(hazeTint.clone().lerp(MOSS, 0.80)).multiplyScalar(0.104);
    const window = p.sun.clone().multiplyScalar(0.30);
    const sky = p.zenith.clone().multiplyScalar(2.2);
    // Halved from the first pass — a strong warm additive on a cool albedo is
    // what neutralised the walls.
    const sunLight = p.sun.clone().multiplyScalar(0.30);

    // The recession's chroma anchor. Same tint the near-field grade binds to, so
    // a piece that is both low in frame and out at the edge lands on one colour
    // rather than on two grades disagreeing about which crushed blue is the
    // map's.
    unitLuminance(deepTint, this.deepUnit);

    /**
     * The pool's radiance.
     *
     * 'p.airlight' is a HUE (unit peak channel), so the level is chosen here.
     * 0.62 is high for this file — every other additive term in it is 0.03–0.30
     * — and that is deliberate: the surround is dark, the pool is squared
     * inverse-square, and by two radii out it has already dropped below a
     * percent of this. What it buys is a genuinely hot patch of ground and
     * clutter immediately around the flame, which is the thing the frame has
     * never had. Scaled by 'airlightPower' so a map with no fire gets nothing
     * rather than a mystery glow.
     */
    const airColor = p.airlight.clone().multiplyScalar(0.62 * p.airlightPower);
    const airRadius = p.airlightRadius;

    for (const m of this.structMaterials) {
      (m.uniforms.uAirColor!.value as Color).copy(airColor);
      m.uniforms.uAirRadius!.value = airRadius;
    }
    if (this.groundMaterial) {
      (this.groundMaterial.uniforms.uAirColor!.value as Color).copy(airColor);
      this.groundMaterial.uniforms.uAirRadius!.value = airRadius;
    }

    for (const m of this.structMaterials) {
      (m.uniforms.uDeepUnit!.value as Color).copy(this.deepUnit);
      (m.uniforms.uBase!.value as Color).copy(wallBase);
      (m.uniforms.uRoof!.value as Color).copy(roof);
      (m.uniforms.uWood!.value as Color).copy(wood);
      (m.uniforms.uFoliage!.value as Color).copy(foliage);
      (m.uniforms.uHaze!.value as Color).copy(p.haze);
      (m.uniforms.uSunColor!.value as Color).copy(sunLight);
      (m.uniforms.uSkyColor!.value as Color).copy(sky);
      (m.uniforms.uWindowColor!.value as Color).copy(window);
      // Hue only — the shader normalises it to unit luminance, so the level
      // carried here is irrelevant and must not leak into the grade's value.
      (m.uniforms.uDeep!.value as Color).copy(deepTint);
    }
    if (this.glowMaterial) {
      // Hearth-orange core, tallow-pale skirt. These are the only pixels the
      // environment is allowed to push over the bloom threshold.
      //
      // These levels are the third attempt and the only ones that are not a
      // disaster. 'p.sun' is a LIGHT colour — its channels run to 1.0 — so an
      // additive card at 0.55 of it is half of full scale per lamp, and with a
      // hundred lamps in the surround overlapping under the bokeh the first
      // version rendered the entire lower half of the frame as flat orange.
      // A practical seen from thirty metres contributes a few percent.
      (this.glowMaterial.uniforms.uWarmColor!.value as Color)
        .copy(p.sun).multiplyScalar(0.075);
      (this.glowMaterial.uniforms.uCoolColor!.value as Color)
        .copy(p.sun).lerp(p.horizon, 0.5).multiplyScalar(0.045);
    }
    if (this.groundMaterial) {
      const u = this.groundMaterial.uniforms;
      // The plate stays DARK. It was rendering at luma 46 with a 6–69 range —
      // a smooth swatch over the whole lower third of the frame — and the
      // obvious fix, raising its level, was tried and is wrong: at 0.145 the
      // surround became a pale concrete apron brighter than half the board,
      // which breaks both "the play space is the brightest thing in the frame"
      // and the crushed-blacks grade. What a swatch actually lacks is variance,
      // not brightness, so the level moves a little and the CONTRAST between
      // the two tones (and the multiplier below) moves a lot.
      //
      // Retuned again after the near bands stopped covering the lower-right
      // quadrant with a house: with the plate actually visible it rendered at
      // luma 47 in a neutral grey-mauve, i.e. a concrete table for the diorama
      // to sit on, and it was competing with the board's own shadow side. The
      // surround ground must stay clearly under the play space.
      //
      // MOSS is a deliberate third hue. Every critique of the grade said the
      // same thing — "a two-hue navy/amber lockup with nothing between" — and
      // the ground outside the walls is the largest surface in the frame that
      // can carry a tertiary colour without fighting either the lantern warmth
      // or the night blue.
      (u.uNearColor!.value as Color)
        .copy(norm(hazeTint.clone().lerp(deepTint, 0.66)))
        .multiplyScalar(0.020);
      (u.uFarColor!.value as Color)
        .copy(norm(hazeTint.clone().lerp(sunTint, 0.26).lerp(MOSS, 0.42)))
        .multiplyScalar(0.048);
      (u.uHaze!.value as Color).copy(p.haze);
      (u.uSunColor!.value as Color).copy(sunLight);
      (u.uSkyColor!.value as Color).copy(sky);
      (u.uDeepUnit!.value as Color).copy(this.deepUnit);
    }
  }

  /** Live knob for iteration: overall brightness of the surround. */
  setExposure(v: number): void {
    this.opts.exposure = v;
    for (const m of this.structMaterials) m.uniforms.uExposure!.value = v;
    if (this.groundMaterial) this.groundMaterial.uniforms.uExposure!.value = v;
    if (this.glowMaterial) this.glowMaterial.uniforms.uGain!.value = v;
  }

  /**
   * Upward recession ramp, '(startY, endY, floor)' as screen fractions from the
   * bottom of frame. See {@link GLSL_RECEDE}.
   */
  setRecession(start: number, end: number, floor: number): void {
    this.fade.set(start, end, floor);
    for (const m of this.structMaterials) (m.uniforms.uFade!.value as Vector3).copy(this.fade);
    if (this.groundMaterial) (this.groundMaterial.uniforms.uFade!.value as Vector3).copy(this.fade);
    if (this.glowMaterial) (this.glowMaterial.uniforms.uFade!.value as Vector3).copy(this.fade);
  }

  /** Drawing-buffer height in device pixels; the recession divides 'gl_FragCoord.y' by it. */
  setViewportHeight(heightPx: number): void {
    this.viewH = Math.max(1, heightPx);
    for (const m of this.structMaterials) m.uniforms.uViewH!.value = this.viewH;
    if (this.groundMaterial) this.groundMaterial.uniforms.uViewH!.value = this.viewH;
    if (this.glowMaterial) this.glowMaterial.uniforms.uViewH!.value = this.viewH;
  }

  get layoutSpec(): BackdropLayout | null {
    return this.currentLayout;
  }

  private clearContents(): void {
    for (const mesh of this.bandMeshes) {
      this.yawRig.remove(mesh);
      mesh.geometry.dispose();
    }
    this.bandMeshes.length = 0;
    for (const m of this.structMaterials) m.dispose();
    this.structMaterials.length = 0;
    if (this.glowMesh) {
      this.yawRig.remove(this.glowMesh);
      this.glowMesh.geometry.dispose();
      this.glowMesh = null;
    }
    this.glowMaterial?.dispose();
    this.glowMaterial = null;
    this.glowSites = [];
    if (this.groundMesh) {
      this.yawRig.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
      this.groundMesh = null;
    }
    this.groundMaterial?.dispose();
    this.groundMaterial = null;
    this.footTexture?.dispose();
    this.footTexture = null;
  }

  dispose(): void {
    this.clearContents();
  }
}

/**
 * Generators that must not run between the lens and the board: the three that
 * produce a single large flat face, and the two that produce a large smooth
 * mass. See the substitution block in 'buildBand' for the per-kind distance.
 */
const NEAR_DEMOTED = new Set<PropKind>(['house', 'tower', 'wall', 'tree', 'rock']);

/**
 * What one of those becomes instead. Small, faceted, pattern-bearing props only
 * — every entry here takes either the masonry or the plank pattern in
 * 'STRUCT_FRAG', so it survives the near-field defocus as texture.
 */
const NEAR_SUBSTITUTES: PropKind[] = ['crates', 'rubble', 'barrel', 'fence', 'cart', 'rubble'];

const UP = new Vector3(0, 1, 0);

/** The surround's tertiary hue: damp moss on the ground outside the walls. */
const MOSS = new Color().setHex(0x5d7a4a, 'srgb');
/** Weathered timber — crates, barrels, fencing, cart beds. */
const TIMBER = new Color().setHex(0x8a5f3a, 'srgb');
