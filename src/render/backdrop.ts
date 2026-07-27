/**
 * EverTactics — the world the diorama sits in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 * ─────────────────────────────────────────────────────────────────────────────
 * The board was a rectangular slab floating in `clearColor`. Every critic in the
 * round-2 A/B named it, most of them first. What the references actually do is
 * *continue the environment past the play area*: houses immediately behind the
 * fence line, a quay running off the left edge, crates and lanterns crowding the
 * margins, haze between the layers. See
 * `refs/curated/triangle/press_002_gematsu_1920x1080.jpg` (village houses start
 * one tile beyond the playable ground) and `official_005_steam.jpg` (ruined
 * masonry fills every frame edge).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS BUILT CAMERA-RELATIVE
 * ─────────────────────────────────────────────────────────────────────────────
 * The rig is *orthographic*. That has a consequence people coming from a
 * perspective engine get wrong: there is no convergence, so a silhouette 200
 * units behind the board projects to the same screen position as one 5 units
 * behind it, just shifted up-screen by `depth · sin(pitch)`. With our framing,
 * anything more than ~18 world units behind the board is already off the top of
 * the frame. A "distant skyline" is geometrically impossible here — and looking
 * at the references, neither game has one. They have a *dense near surround*.
 *
 * So this is authored in a yaw-following local frame:
 *
 *     local +X → screen right
 *     local −Z → away from the camera along the ground   (call it `depth`)
 *     local +Y → up
 *     screenX  = x
 *     screenY  = y·cos(pitch) + depth·sin(pitch)
 *
 * The whole group tracks the camera's yaw, so the composition holds at all four
 * yaw slots and the surround always runs off the correct frame edges. That is a
 * matte-painting cheat and it is invisible in a still frame — which is what the
 * blind test looks at. Everything inside is real lit 3D geometry, gets the DoF
 * and grade from `post.ts`, and writes depth normally.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BANDS
 * ─────────────────────────────────────────────────────────────────────────────
 * All four are expressed against the *measured* window — `boardRadius` R and
 * `visibleDepth`, with `run = visibleDepth − R` the usable depth behind the
 * board (about 4.5 units at the shipping framing):
 *
 *   flank   |depth| ≤ 0.95R, |x| past the footprint — the left/right strips
 *   apron   depth  R … R+0.62·run   — outbuildings, walls, trees, lanterns
 *   ridge   depth  R+0.45·run … R+1.25·run — towers whose tops crop at the top edge
 *   fore    depth  0.5·nearDepth … 1.45·nearDepth — foliage framing the bottom corners
 *
 * `fore` exists because both reference frames have a soft, dark foreground
 * element breaking into the bottom of the image, and because `post.ts`'s DoF
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
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { GLSL_NOISE, type EnvironmentPalette } from './sky.js';

// ─────────────────────────────────────────────────────────────────────────────
// Layout contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the surround needs to know about the shot. Computed by
 * `WorldEnvironment` in `atmosphere.ts` from the live camera and the measured
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG
// ─────────────────────────────────────────────────────────────────────────────

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
  // Indexed, because `mergeGeometries` refuses a mixed indexed/non-indexed set
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

/** Weathered boulder. Low-poly sphere squashed and jittered. */
function rock(rng: () => number, scale: number): BufferGeometry[] {
  const g = new ConeGeometry(scale * (0.7 + rng() * 0.6), scale * (0.6 + rng() * 0.7), 6, 2);
  const pos = g.attributes.position as BufferAttribute;
  for (let i = 0; i < pos.count; i += 1) {
    pos.setXYZ(
      i,
      pos.getX(i) * (0.8 + rng() * 0.5),
      pos.getY(i) * (0.7 + rng() * 0.4),
      pos.getZ(i) * (0.8 + rng() * 0.5),
    );
  }
  g.computeVertexNormals();
  g.translate(0, scale * 0.3, 0);
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
varying vec3  vLocal;
varying vec3  vNormalL;
varying float vTint;
varying float vWindow;
void main() {
  vLocal = position;
  vNormalL = normal;
  vTint = aTint;
  vWindow = aWindow;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Lighting here is deliberately *not* three's Lambert. These meshes sit outside
 * the fitted shadow frustum and mostly outside the practicals' falloff, so
 * routing them through the standard pipeline would give a flat ambient wash —
 * the exact fail condition in `VISUAL_TARGET.md`. Instead: a hand-rolled
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
uniform float uGroundY;
uniform float uWindowGain;
uniform float uTone;
uniform float uExposure;
uniform float uTime;

varying vec3  vLocal;
varying vec3  vNormalL;
varying float vTint;
varying float vWindow;

${GLSL_NOISE}

void main() {
  vec3 n = normalize(vNormalL);
  float ndl = max(dot(n, -uSunLocal), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  float up = max(n.y, 0.0);

  // Roofs read warmer/darker than walls; that separation is most of what makes
  // a cluster of buildings legible at this size.
  vec3 albedo = mix(uBase, uRoof, smoothstep(0.35, 0.85, up));
  albedo *= 0.55 + 0.78 * vTint;

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
  tex *= mix(1.0, masonry, 1.0 - up);

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
  tex *= mix(1.0, 0.50 + 0.42 * block, timber * (1.0 - up) * 0.9);

  // Roof: shingle courses running with the pitch, with a per-course value hash
  // so no two runs of tile match. Derived from world xz rather than the face
  // basis, because on a near-horizontal plane the face basis degenerates.
  vec2 roofFace = vLocal.xz;
  float courseId = roofFace.x * 1.35 + roofFace.y * 0.42;
  float course = fract(courseId);
  float shingle = 0.66 + 0.55 * smoothstep(0.04, 0.28, course) * (1.0 - smoothstep(0.68, 0.96, course));
  shingle *= 0.82 + 0.42 * etHash12(vec2(floor(courseId), floor(roofFace.y * 0.9)));
  tex *= mix(1.0, shingle, up);

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
  vec3 lit = albedo * (0.34 + 0.66 * ndl);
  lit += uSunColor * albedo * ndl * 0.65;
  lit += uSkyColor * albedo * sky * 0.62;

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

  // Distance haze. Depth here is −z in the yaw-local frame, i.e. "away from the
  // camera along the ground", which is exactly the axis that reads as distance
  // under an orthographic iso projection.
  float depth = -vLocal.z;
  float haze = smoothstep(uHazeNear, uHazeFar, depth) * uHazeMax;
  // Bases dissolve first: the ground fog is thickest at the bottom of a layer,
  // so nothing in the surround terminates on a hard line against the plate.
  haze = clamp(haze + (1.0 - base) * 0.30 * smoothstep(uHazeNear * 0.5, uHazeFar, depth), 0.0, 0.96);

  // Sky-side edge lift. Without it a low-tone band renders as a solid black
  // cut-out and the eye reads "missing texture" rather than "in shadow".
  float edge = pow(clamp(1.0 - abs(n.y), 0.0, 1.0), 3.0) * (0.5 + 0.5 * n.x);
  vec3 toned = lit * uTone + uSkyColor * edge * 0.16 * uTone * tex;
  vec3 col = mix(toned, uHaze, haze) * uExposure;
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
varying vec2  vOffset;
varying float vSeed;
varying float vWarm;
void main() {
  vOffset = position.xy;
  vSeed = aSeed;
  vWarm = aWarm;
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
varying vec2  vOffset;
varying float vSeed;
varying float vWarm;
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
  gl_FragColor = vec4(col * a * f * uGain, 1.0);
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
uniform float uBoardRadius;
uniform float uHazeNear;
uniform float uHorizonDepth;
uniform float uHalfW;
uniform float uExposure;
uniform float uShadowStrength;

varying vec3 vLocal;
varying vec3 vNormalL;

${GLSL_NOISE}

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
  float region = etFbm(vLocal.xz * 0.034 + 61.3, 3);
  float region2 = etFbm(vLocal.xz * 0.075 - 12.9, 3);
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

  vec3 lit = albedo * (0.30 + 0.70 * ndl);
  lit += uSunColor * albedo * ndl * 0.55;
  lit += uSkyColor * albedo * 0.30;

  // The diorama's own shadow on the surrounding ground. The fitted shadow map
  // in lighting.ts stops at the board bounds, so past that edge this stands in
  // for it — and it is what stops the board reading as a floating slab. Kept
  // shorter and softer than the first pass, which crushed the entire visible
  // apron to near-black.
  vec2 rel = vLocal.xz - uShadowOffset;
  float sd = length(rel) / (uBoardRadius * 0.92);
  lit *= 1.0 - uShadowStrength * (1.0 - smoothstep(0.75, 1.25, sd));
  // A tighter contact darkening hugging the base itself.
  float contact = 1.0 - smoothstep(uBoardRadius * 0.95, uBoardRadius * 1.22, length(vLocal.xz));
  lit *= 1.0 - 0.30 * contact;

  float depth = -vLocal.z;
  // Held back from a full mix so the ground keeps some of its own colour and
  // grain right up to the horizon — fog that erases texture is just a void
  // with a gradient on it.
  float haze = smoothstep(uHazeNear, uHorizonDepth, depth) * 0.72;
  vec3 col = mix(lit, uHaze, haze);

  // Ground fog pooling against the board's base. This is what dissolves the
  // pedestal's silhouette instead of letting it cut a hard line into the plate,
  // and it is the single thing in this shader doing the most work.
  float pool = 1.0 - smoothstep(uBoardRadius * 0.92, uBoardRadius * 1.55, length(vLocal.xz));
  float poolBreak = 0.55 + 0.45 * etFbm(vLocal.xz * 0.8 + 9.3, 3);
  col = mix(col, uHaze * 1.7, pool * poolBreak * 0.30);

  // Dissolve, rather than terminate. Alpha goes out just before the haze mix
  // completes, so the plate hands off to the sky gradient invisibly. Lateral
  // fade does the same job at the left/right frame edges.
  float aDepth = 1.0 - smoothstep(uHorizonDepth * 0.80, uHorizonDepth, depth);
  float aNear = smoothstep(-uHorizonDepth * 0.95, -uHorizonDepth * 0.62, depth);
  float aSide = 1.0 - smoothstep(uHalfW * 1.5, uHalfW * 2.05, abs(vLocal.x));
  float alpha = aDepth * aNear * aSide;

  gl_FragColor = vec4(max(col, 0.0) * uExposure, alpha);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Backdrop
// ─────────────────────────────────────────────────────────────────────────────

interface BandSpec {
  name: string;
  count: number;
  depthMin: number;
  depthMax: number;
  /** Minimum |x|. Used by `fore` to keep the near band out of frame centre. */
  lateralMin?: number;
  lateralMax: number;
  scale: number;
  haze: [number, number, number];
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
   * and stepping outward by `clearance … ringMax`, instead of by rejection
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
}

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
 * The surround. One `Group`; `layout()` rebuilds its contents, `update()` keeps
 * it aligned to the camera.
 */
export class Backdrop extends Group {
  /** Rotates with camera yaw so the composition holds at every yaw slot. */
  private readonly yawRig = new Group();
  private readonly bandMeshes: Mesh[] = [];
  private groundMesh: Mesh | null = null;

  private readonly structMaterials: ShaderMaterial[] = [];
  private groundMaterial: ShaderMaterial | null = null;

  /** Practical positions harvested while building the bands. Yaw-local. */
  private glowSites: { x: number; y: number; z: number; r: number; seed: number; warm: number }[] =
    [];
  private glowMesh: Mesh | null = null;
  private glowMaterial: ShaderMaterial | null = null;

  private palette: EnvironmentPalette;
  private readonly opts: Required<BackdropOptions>;
  private currentLayout: BackdropLayout | null = null;

  private readonly sunLocal = new Vector3();

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

  // ── build ────────────────────────────────────────────────────────────────

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
        // Measured, not chosen. At 0.62 the near flank house rendered at luma
        // 26/255 with its masonry invisible — a black mass with two lit windows
        // floating on it, which is the void again wearing a building's shape.
        // The equivalent surround band in the Triangle references sits at 60-110.
        tone: 0.95,
        windows: 1,
        kinds: ['house', 'wall', 'tree', 'tree', 'lantern', 'rock', 'bush', 'bush', 'crates', 'cart', 'fence', 'barrel', 'rubble'],
      },
      {
        // The ring hugging the board. This is the band that kills the hard
        // silhouette: `ringMax` confines it to the four world-units immediately
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
        scale: 0.78,
        haze: [R * 1.2, R + run * 2.4, 0.30],
        tone: 0.86,
        windows: 0,
        ringMax: 4.2,
        clearance: 0.35,
        tilt: 0.16,
        sink: 0.18,
        kinds: ['rubble', 'rubble', 'bush', 'bush', 'crates', 'barrel', 'rock', 'fence', 'cart', 'lantern'],
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
        tone: 0.72,
        windows: 0,
        clearance: 4.0,
        tilt: 0.14,
        sink: 0.14,
        kinds: ['bush', 'rubble', 'rock', 'bush', 'crates', 'fence', 'barrel', 'tree', 'cart', 'rubble'],
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
        tone: 1.0,
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
        tone: 1.15,
        windows: 1,
        kinds: ['tower', 'house', 'wall', 'tower', 'tree'],
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
        tone: 0.46,
        windows: 0,
        kinds: ['tree', 'tree', 'rock', 'lantern'],
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
    geo.setIndex(index);

    const material = new ShaderMaterial({
      name: 'env-glow',
      uniforms: {
        uWarmColor: { value: new Color() },
        uCoolColor: { value: new Color() },
        uGain: { value: this.opts.exposure },
        uTime: { value: 0 },
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
    const footprintDistance = (x: number, depth: number): number => {
      const wx = cy * x + sy * -depth;
      const wz = -sy * x + cy * -depth;
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
      const out = clearance + rng() * Math.max(0.1, (band.ringMax ?? 3) - clearance);
      // Jitter along the edge as well, so the run does not read as a hedge.
      const along = (rng() - 0.5) * 1.8;
      wx += nx * out - nz * along;
      wz += nz * out + nx * along;
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

      const kind = band.kinds[Math.floor(rng() * band.kinds.length)]!;
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
            // Near-camera lamps get a bigger card, which is both physically
            // right under a defocus and what keeps the near margins from being
            // dark: a 1.2-unit halo at three metres is a few pixels.
            r: (0.5 + rng() * 0.55) * (depth < 0 ? 1.3 : 1),
            seed: rng(),
            warm: 0.55 + rng() * 0.45,
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
        uHaze: { value: new Color() },
        uSunColor: { value: new Color() },
        uSkyColor: { value: new Color() },
        uSunLocal: { value: new Vector3(0, -1, 0) },
        uWindowColor: { value: new Color() },
        uHazeNear: { value: band.haze[0] },
        uHazeFar: { value: band.haze[1] },
        uHazeMax: { value: Math.min(0.96, band.haze[2] * this.opts.hazeStrength) },
        uGroundY: { value: groundY },
        uTone: { value: band.tone },
        uWindowGain: { value: (band.windows > 0 ? 1 : 0) * this.opts.windowGain },
        uExposure: { value: this.opts.exposure },
        uTime: { value: 0 },
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
        uBoardRadius: { value: layout.boardRadius },
        uHazeNear: { value: layout.boardRadius * 0.9 },
        uHorizonDepth: { value: layout.horizonDepth },
        uHalfW: { value: layout.halfW },
        uUndulate: { value: Math.min(3.2, Math.max(1.2, layout.boardRadius * 0.24)) },
        uExposure: { value: this.opts.exposure },
        uShadowStrength: { value: 0.34 },
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
    for (const m of this.structMaterials) {
      (m.uniforms.uSunLocal!.value as Vector3).copy(this.sunLocal);
      m.uniforms.uTime!.value = elapsed;
    }
    if (this.glowMaterial) this.glowMaterial.uniforms.uTime!.value = elapsed;
    if (this.groundMaterial) {
      (this.groundMaterial.uniforms.uSunLocal!.value as Vector3).copy(this.sunLocal);
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
   * Everything here mixes against `palette.horizon`, never against
   * `palette.sun`. The key colour is a *light* — its channels run to 1.0 — so
   * lerping a 0.03-linear albedo 30% toward it lands at 0.3 and blows out under
   * the tonemapper. `horizon` already carries the key's hue at a background
   * level, which is the value these surfaces want.
   */
  private applyPalette(): void {
    const p = this.palette;

    // Hue and level are set separately, for the same reason `sky.ts` does it:
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
    // `refs/curated/triangle/official_001_steam.jpg` puts its background
    // architecture at luma 86–165/255; the previous levels here (0.052 / 0.034)
    // rendered ours at luma 21–33, which is why `tools/metrics.mjs` scored a
    // third of the frame as void: near-black textured geometry is
    // indistinguishable from no geometry at all, and the corner-match test
    // counts it as background. Raising the albedo is not "brightening the
    // scene" — the board is still four stops above this — it is the difference
    // between a village behind the map and a hole behind the map.
    const wallBase = norm(hazeTint.clone().lerp(deepTint, 0.45)).multiplyScalar(0.148);
    // Warm tile. Darker than the walls: a roof plane faces the sky, so if it is
    // also the lightest albedo in the set every rooftop reads as a highlight.
    const roof = norm(sunTint.clone().lerp(hazeTint, 0.62)).multiplyScalar(0.094);
    const window = p.sun.clone().multiplyScalar(0.30);
    const sky = p.zenith.clone().multiplyScalar(2.2);
    // Halved from the first pass — a strong warm additive on a cool albedo is
    // what neutralised the walls.
    const sunLight = p.sun.clone().multiplyScalar(0.30);

    for (const m of this.structMaterials) {
      (m.uniforms.uBase!.value as Color).copy(wallBase);
      (m.uniforms.uRoof!.value as Color).copy(roof);
      (m.uniforms.uHaze!.value as Color).copy(p.haze);
      (m.uniforms.uSunColor!.value as Color).copy(sunLight);
      (m.uniforms.uSkyColor!.value as Color).copy(sky);
      (m.uniforms.uWindowColor!.value as Color).copy(window);
    }
    if (this.glowMaterial) {
      // Hearth-orange core, tallow-pale skirt. These are the only pixels the
      // environment is allowed to push over the bloom threshold.
      //
      // These levels are the third attempt and the only ones that are not a
      // disaster. `p.sun` is a LIGHT colour — its channels run to 1.0 — so an
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
    }
  }

  /** Live knob for iteration: overall brightness of the surround. */
  setExposure(v: number): void {
    this.opts.exposure = v;
    for (const m of this.structMaterials) m.uniforms.uExposure!.value = v;
    if (this.groundMaterial) this.groundMaterial.uniforms.uExposure!.value = v;
    if (this.glowMaterial) this.glowMaterial.uniforms.uGain!.value = v;
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
  }

  dispose(): void {
    this.clearContents();
  }
}

const UP = new Vector3(0, 1, 0);

/** The surround's tertiary hue: damp moss on the ground outside the walls. */
const MOSS = new Color().setHex(0x5d7a4a, 'srgb');
