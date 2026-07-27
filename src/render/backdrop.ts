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
 *   flank   |depth| small, |x| beyond the board — fills the left/right void
 *   apron   depth  R+1 … R+9,  h 1–6  — outbuildings, walls, trees, lanterns
 *   ridge   depth  R+9 … R+22, h 4–14 — bell tower, keep wall, big roofs
 *   fore    depth  −16 … −5,   h 2–7  — out-of-focus foreground framing
 *
 * `fore` exists because both reference frames have a soft, dark foreground
 * element breaking into the bottom of the image, and because `post.ts`'s DoF
 * needs something in the near field to actually blur.
 *
 * Everything is merged per band, so the whole surround is five draw calls.
 */

import {
  AdditiveBlending,
  BackSide,
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
  albedo *= 0.78 + 0.44 * vTint;

  // Macro + detail noise. Two octave sets at different scales so neither the
  // silhouette band nor an individual face is ever one value.
  float macro = etFbm(vLocal.xz * 0.11 + vLocal.y * 0.05, 3);
  float detail = etFbm(vLocal.xz * 1.7 + vec2(vLocal.y * 2.3, 0.0), 3);
  albedo *= 0.74 + 0.34 * macro + 0.18 * detail;

  // Horizontal courses on vertical faces: cheap masonry banding.
  float courses = 0.5 + 0.5 * sin(vLocal.y * 7.3 + macro * 4.0);
  albedo *= mix(1.0, 0.90 + 0.12 * courses, 1.0 - up);

  // Dirt climbing the base — grime accumulates where the ground meets the wall.
  float base = clamp((vLocal.y - uGroundY) / 1.6, 0.0, 1.0);
  albedo *= mix(0.55, 1.0, pow(base, 0.7));

  vec3 lit = albedo * (0.16 + 0.84 * ndl);
  lit += uSunColor * albedo * ndl * 0.55;
  lit += uSkyColor * albedo * sky * 0.42;

  // Window practicals: a cell grid on vertical faces, a hash per cell decides
  // whether that room is occupied. This is the single cheapest "somebody lives
  // here" signal available and both references lean on it hard.
  float vertical = 1.0 - smoothstep(0.25, 0.6, abs(n.y));
  if (vWindow > 0.5 && vertical > 0.01) {
    vec2 face = abs(n.x) > abs(n.z) ? vec2(vLocal.z, vLocal.y) : vec2(vLocal.x, vLocal.y);
    vec2 cell = face / vec2(1.05, 1.25);
    vec2 id = floor(cell);
    vec2 f = fract(cell);
    float lit01 = step(0.52, etHash12(id + 11.7));
    float flick = 0.86 + 0.14 * sin(uTime * (1.7 + etHash12(id) * 2.3) + etHash12(id) * 6.28);
    vec2 rect = smoothstep(0.30, 0.36, f) * (1.0 - smoothstep(0.64, 0.70, f));
    float win = rect.x * rect.y * lit01 * vertical * flick;
    win *= step(uGroundY + 0.55, vLocal.y);
    lit += uWindowColor * win * uWindowGain;
  }

  // Distance haze. Depth here is −z in the yaw-local frame, i.e. "away from the
  // camera along the ground", which is exactly the axis that reads as distance
  // under an orthographic iso projection.
  float depth = -vLocal.z;
  float haze = smoothstep(uHazeNear, uHazeFar, depth) * uHazeMax;
  // Bases dissolve first: the ground fog is thickest at the bottom of a layer,
  // so nothing in the surround terminates on a hard line against the plate.
  haze = clamp(haze + (1.0 - base) * 0.30 * smoothstep(uHazeNear * 0.5, uHazeFar, depth), 0.0, 0.96);

  vec3 col = mix(lit, uHaze, haze) * uExposure;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
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
  float away = smoothstep(uBoardRadius * 0.9, uBoardRadius * 3.2, length(p));
  return (etFbm(p * 0.055, 4) - 0.5) * uUndulate * away
       + (etFbm(p * 0.21, 3) - 0.5) * uUndulate * 0.22 * away;
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
  // paths radiating from the board. Never one flat green.
  float clump = etFbm(vLocal.xz * 0.34, 4);
  float fine = etFbm(vLocal.xz * 2.6, 3);
  float worn = smoothstep(0.42, 0.0, abs(etFbm(vLocal.xz * 0.09 + 4.1, 3) - 0.5));
  vec3 albedo = mix(uNearColor, uFarColor, clamp(clump * 0.85 + fine * 0.25, 0.0, 1.0));
  albedo = mix(albedo, uFarColor * 1.22, worn * 0.5);
  albedo *= 0.80 + 0.40 * fine;

  vec3 lit = albedo * (0.18 + 0.82 * ndl);
  lit += uSunColor * albedo * ndl * 0.5;
  lit += uSkyColor * albedo * 0.34;

  // The diorama's own shadow on the surrounding ground. The fitted shadow map
  // in lighting.ts stops at the board bounds, so past that edge this stands in
  // for it — and it is what stops the board reading as a floating slab.
  vec2 rel = vLocal.xz - uShadowOffset;
  float sd = length(rel / vec2(uBoardRadius * 1.05, uBoardRadius * 1.05));
  lit *= 1.0 - uShadowStrength * (1.0 - smoothstep(0.62, 1.35, sd));
  // A tighter contact darkening hugging the base itself.
  float contact = 1.0 - smoothstep(uBoardRadius * 0.98, uBoardRadius * 1.45, length(vLocal.xz));
  lit *= 1.0 - 0.34 * contact;

  float depth = -vLocal.z;
  float haze = smoothstep(uHazeNear, uHorizonDepth, depth);
  vec3 col = mix(lit, uHaze, clamp(haze * 1.06, 0.0, 1.0));

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
  lateralMax: number;
  scale: number;
  haze: [number, number, number];
  windows: number;
  kinds: readonly ('house' | 'tower' | 'wall' | 'tree' | 'rock' | 'lantern')[];
}

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
    const horizon = layout.horizonDepth;
    const halfW = layout.halfW;

    this.buildGround(layout);

    // Bands are expressed relative to the board radius and the solved horizon
    // depth, so a 12-tile skirmish map and a 30-tile siege map both get a
    // correctly-scaled surround with no per-map authoring.
    const bands: BandSpec[] = [
      {
        name: 'flank',
        count: 26,
        depthMin: -R * 0.9,
        depthMax: R * 0.9,
        lateralMax: halfW * 1.9,
        scale: 1.0,
        haze: [R * 0.6, horizon * 1.5, 0.34],
        windows: 1,
        kinds: ['house', 'house', 'wall', 'tree', 'lantern', 'rock'],
      },
      {
        name: 'apron',
        count: 34,
        depthMin: R + 1.2,
        depthMax: R + horizon * 0.42,
        lateralMax: halfW * 1.85,
        scale: 1.0,
        haze: [R + 1.0, horizon * 1.05, 0.58],
        windows: 1,
        kinds: ['house', 'house', 'tree', 'wall', 'lantern', 'rock', 'tower'],
      },
      {
        name: 'ridge',
        count: 22,
        depthMin: R + horizon * 0.4,
        depthMax: R + horizon * 0.95,
        lateralMax: halfW * 1.8,
        scale: 1.35,
        haze: [R, horizon * 0.9, 0.82],
        windows: 1,
        kinds: ['tower', 'house', 'wall', 'tree', 'tower'],
      },
      {
        name: 'far',
        count: 16,
        depthMin: R + horizon * 0.95,
        depthMax: R + horizon * 1.5,
        lateralMax: halfW * 1.8,
        scale: 2.1,
        haze: [R, horizon * 0.7, 0.94],
        windows: 0,
        kinds: ['tower', 'house', 'tree'],
      },
      {
        name: 'fore',
        count: 9,
        depthMin: -(R + layout.halfH * 1.6),
        depthMax: -(R + layout.halfH * 0.55),
        lateralMax: halfW * 1.75,
        scale: 1.25,
        haze: [-999, -998, 0.0],
        windows: 0,
        kinds: ['tree', 'rock', 'wall', 'lantern'],
      },
    ];

    let bandIndex = 0;
    for (const band of bands) {
      const mesh = this.buildBand(band, layout, groundY, bandIndex);
      if (mesh) this.yawRig.add(mesh);
      bandIndex += 1;
    }

    this.applyPalette();
  }

  private buildBand(
    band: BandSpec,
    layout: BackdropLayout,
    groundY: number,
    index: number,
  ): Mesh | null {
    const rng = mulberry32(layout.seed * 7919 + index * 104729);
    const R = layout.boardRadius;
    const pieces: BufferGeometry[] = [];

    let attempts = 0;
    let placed = 0;
    while (placed < band.count && attempts < band.count * 24) {
      attempts += 1;
      const depth = band.depthMin + rng() * (band.depthMax - band.depthMin);
      const x = (rng() * 2 - 1) * band.lateralMax;

      // Keep the play space clear: nothing inside the board footprint, and a
      // little extra margin so a roof never crowds a playable tile.
      const clearance = R + 2.2;
      if (Math.hypot(x, depth) < clearance) continue;

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
        default:
          parts = lantern(rng);
          break;
      }

      const s = band.scale * (0.82 + rng() * 0.45);
      const rot = rng() * Math.PI * 2;
      const tint = rng();
      // Trees, rocks and lamp posts have no windows; buildings do.
      const win = band.windows > 0 && (kind === 'house' || kind === 'tower' || kind === 'wall') ? 1 : 0;

      for (const part of parts) {
        part.scale(s, s * (0.9 + rng() * 0.3), s);
        part.rotateY(rot);
        part.translate(x, groundY, -depth);
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
        uUndulate: { value: Math.max(1.2, layout.boardRadius * 0.18) },
        uExposure: { value: this.opts.exposure },
        uShadowStrength: { value: 0.5 },
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
    // Structures read as cool stone and warm tile, both sitting well under the
    // board's value so the play space stays the brightest thing in the frame.
    const wallBase = p.haze.clone().lerp(p.deep, 0.30).multiplyScalar(3.0);
    const roof = p.haze.clone().lerp(p.horizon, 0.45).multiplyScalar(2.1);
    const window = p.sun.clone().multiplyScalar(0.30);
    const sky = p.zenith.clone().multiplyScalar(2.2);
    const sunLight = p.sun.clone().multiplyScalar(0.55);

    for (const m of this.structMaterials) {
      (m.uniforms.uBase!.value as Color).copy(wallBase);
      (m.uniforms.uRoof!.value as Color).copy(roof);
      (m.uniforms.uHaze!.value as Color).copy(p.haze);
      (m.uniforms.uSunColor!.value as Color).copy(sunLight);
      (m.uniforms.uSkyColor!.value as Color).copy(sky);
      (m.uniforms.uWindowColor!.value as Color).copy(window);
    }
    if (this.groundMaterial) {
      const u = this.groundMaterial.uniforms;
      (u.uNearColor!.value as Color).copy(p.haze).lerp(p.deep, 0.45).multiplyScalar(2.6);
      (u.uFarColor!.value as Color).copy(p.haze).lerp(p.horizon, 0.35).multiplyScalar(2.4);
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

// Keep the tree-shaker honest about imports that only exist for future layers.
void BackSide;
void AdditiveBlending;
