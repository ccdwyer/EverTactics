/**
 * EverTactics — diorama construction.
 *
 * `buildTerrain(field)` turns a `Battlefield` into the physical stage the battle happens on:
 *
 *   - one chamfered block per tile, with side faces emitted only where the neighbour is
 *     lower, so interior tiles cost nothing,
 *   - slopes as genuinely ramped, smooth-shaded geometry (not stair-stepped), with the
 *     ramp's edge heights matching the flat neighbours it connects,
 *   - a small chamfer around every top face, which is what catches the key light and stops
 *     the map reading as a pile of cubes,
 *   - per-vertex ambient occlusion baked by hemisphere ray-marching the tile column field,
 *     so crevices, inside corners and cliff bases darken,
 *   - rocky, displaced cliff walls with protruding shards wherever a drop is tall enough
 *     that a flat extruded quad would look like programmer art,
 *   - water tiles: a solid silt bed plus a separate shader-driven surface carrying baked
 *     water-column depth and shore distance,
 *   - a single-draw-call tile highlight overlay (movement / attack / AoE / cursor) with
 *     region outlines and a subtle pulse, plus an animated path ribbon.
 *
 * Everything is merged into one geometry per material, so a 20x20 map is a handful of
 * draw calls rather than 400.
 */

import * as THREE from 'three';
import type { Battlefield, SlopeKind, SurfaceKind, Tile, Vec3 } from '@core/types';
import {
  createSurfaceMaterial,
  isWaterSurface,
  TEXTURE_WORLD_SCALE,
  type TerrainMaterialKind,
} from './materials/terrain';
import { createWaterMaterial, WaterMaterial, type WaterOptions } from './materials/water';

// ─────────────────────────────────────────────────────────────────────────────
// World-space conventions (other subsystems build against these)
// ─────────────────────────────────────────────────────────────────────────────

/** One grid tile is one world unit square. Tile (x, y) is centred at world (x, *, y). */
export const TILE_SIZE = 1;

/** `Tile.height` is measured in half-tiles; this is one of those in world units. */
export const HEIGHT_UNIT = 0.5;

/** Inset of the top face, in tile fractions — the chamfer width. */
const CHAMFER = 0.062;
/** How far the chamfer ring drops below the top face, in world units. */
const CHAMFER_DROP = 0.052;
/** Subdivisions per tile edge on top faces (also used for ramps and AO resolution). */
const TOP_SUBDIV = 3;
/**
 * Drop, in world units, at which a side face becomes a sculpted cliff rather than a
 * flat extruded quad. One tile of elevation (two half-tiles) is already enough to
 * read as a cube if it is left flat, so the threshold sits just under it.
 */
const CLIFF_MIN_DROP = 0.85;
/**
 * How far the diorama's underside hangs below the **lowest point on its own rim**.
 *
 * This used to be measured from the deepest thing on the map — which meant one
 * ornamental pool sank the whole pedestal, and the repeated brick underside ended
 * up carrying about 40% of the object's mass. A diorama is a slice of a place, not
 * a plinth: the base sits just under the lowest edge you can actually see.
 */
const SKIRT = 0.55;
/** The base never rises above the waterline, or the pool would float over its own base. */
const WATERLINE_SKIRT = 0.3;
/** …nor above the lowest walkable ground, so every column keeps some thickness. */
const GROUND_SKIRT = 0.2;
/** Water column depth (in half-tiles) carved beneath each water surface. */
const WATER_BED_DEPTH = 3;
const DEEPWATER_BED_DEPTH = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Ground relief
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Natural ground is not a lid on a box. Grass, dirt, sand, swamp and snow tops get a
 * low-amplitude world-space undulation so an embankment rolls instead of stepping.
 *
 * The offset is a pure function of world XZ, so two neighbouring tiles agree exactly
 * along their shared edge: the lawn becomes one continuous surface (and the chamfer
 * logic, which compares tops across an edge, correctly decides not to groove it)
 * rather than a field of independently-wobbled lids.
 */
const RELIEF_SURFACES: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>([
  'grass',
  'dirt',
  'sand',
  'snow',
  'swamp',
]);
const RELIEF_AMPLITUDE = 0.075;

/** World-Y offset applied to natural ground tops at world (wx, wz). */
function groundRelief(surface: SurfaceKind, wx: number, wz: number): number {
  if (!RELIEF_SURFACES.has(surface)) return 0;
  // Two octaves at different world scales: a slow swell across the whole lawn plus a
  // finer hummock, biased downward so a unit's feet sink into the turf rather than
  // hovering over it.
  const broad = fbm3(wx * 0.29, 0, wz * 0.29, 913, 2) - 0.5;
  const fine = fbm3(wx * 1.15, 0, wz * 1.15, 2287, 2) - 0.5;
  return (broad * 1.35 + fine * 0.55) * RELIEF_AMPLITUDE - RELIEF_AMPLITUDE * 0.28;
}

/** Height of the walkable surface of a tile, in world units. */
export function tileSurfaceY(tile: Tile): number {
  return tile.height * HEIGHT_UNIT + groundRelief(tile.surface, tile.x, tile.y);
}

/**
 * World position of the centre of a tile's walkable surface. Sprites, cursors and VFX
 * should anchor here.
 */
export function tileWorldPosition(field: Battlefield, x: number, y: number): THREE.Vector3 {
  const tile = field.tileAt(x, y);
  const h = tile ? tile.height + slopeOffsetHalf(tile.slope, 0.5, 0.5) : 0;
  const relief = tile ? groundRelief(tile.surface, x * TILE_SIZE, y * TILE_SIZE) : 0;
  return new THREE.Vector3(x * TILE_SIZE, h * HEIGHT_UNIT + relief, y * TILE_SIZE);
}

/** Convenience for a `Vec3` grid coordinate (uses `z` as the authority on height). */
export function gridToWorld(pos: Vec3): THREE.Vector3 {
  return new THREE.Vector3(pos.x * TILE_SIZE, pos.z * HEIGHT_UNIT, pos.y * TILE_SIZE);
}

/** Upward normal of a tile's surface at its centre — useful for placing decals flush. */
export function tileSurfaceNormal(tile: Tile): THREE.Vector3 {
  const [du, dv] = slopeDerivativeHalf(tile.slope, 0.5, 0.5);
  return new THREE.Vector3(-du * HEIGHT_UNIT, 1, -dv * HEIGHT_UNIT).normalize();
}

// ─────────────────────────────────────────────────────────────────────────────
// Slope maths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Height offset (in half-tiles) added to `Tile.height` at local coordinate (u, v),
 * where u runs 0..1 west→east and v runs 0..1 north→south.
 *
 * An incline spans exactly two half-tiles across the tile, so a ramp at height h meets a
 * flat neighbour at h+1 on the high side and h-1 on the low side. That is FFT's convention
 * and it means ramps and steps stitch together with no gaps.
 */
function slopeOffsetHalf(slope: SlopeKind, u: number, v: number): number {
  switch (slope) {
    case 'incline-n':
      return (0.5 - v) * 2;
    case 'incline-s':
      return (v - 0.5) * 2;
    case 'incline-e':
      return (u - 0.5) * 2;
    case 'incline-w':
      return (0.5 - u) * 2;
    case 'convex': {
      const r2 = (u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5);
      return 0.7 * (1 - 4 * r2);
    }
    case 'concave': {
      const r2 = (u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5);
      return -0.7 * (1 - 4 * r2);
    }
    case 'flat':
    default:
      return 0;
  }
}

/** d(offset)/du, d(offset)/dv in half-tiles per tile. */
function slopeDerivativeHalf(slope: SlopeKind, u: number, v: number): [number, number] {
  switch (slope) {
    case 'incline-n':
      return [0, -2];
    case 'incline-s':
      return [0, 2];
    case 'incline-e':
      return [2, 0];
    case 'incline-w':
      return [-2, 0];
    case 'convex':
      return [-5.6 * (u - 0.5), -5.6 * (v - 0.5)];
    case 'concave':
      return [5.6 * (u - 0.5), 5.6 * (v - 0.5)];
    case 'flat':
    default:
      return [0, 0];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic noise for cliff displacement
// ─────────────────────────────────────────────────────────────────────────────

function hash3(xi: number, yi: number, zi: number, seed: number): number {
  let h = Math.imul(xi, 374761393) + Math.imul(yi, 668265263) + Math.imul(zi, 2147483647);
  h = Math.imul(h ^ seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  let acc = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const wx = dx === 0 ? 1 - u : u;
        const wy = dy === 0 ? 1 - v : v;
        const wz = dz === 0 ? 1 - w : w;
        acc += hash3(xi + dx, yi + dy, zi + dz, seed) * wx * wy * wz;
      }
    }
  }
  return acc;
}

function fbm3(x: number, y: number, z: number, seed: number, octaves = 3): number {
  let s = 0;
  let a = 0.5;
  let n = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    s += noise3(x * f, y * f, z * f, seed + o * 37) * a;
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return s / n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mesh accumulation
// ─────────────────────────────────────────────────────────────────────────────

interface Vtx {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

function v(x: number, y: number, z: number, nx: number, ny: number, nz: number): Vtx {
  return { x, y, z, nx, ny, nz };
}

class Bucket {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly idx: number[] = [];
  /** Per-vertex AO override; -1 means "ray-march it". Props supply their own. */
  readonly hints: number[] = [];

  /**
   * While non-negative, every vertex pushed gets this AO value instead of being
   * ray-marched. Props are thin, numerous and sit on top of the field, so marching
   * them costs a lot and buys almost nothing — a cheap analytic value keyed off
   * height above the ground reads identically.
   */
  hint = -1;

  private push(p: Vtx): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(p.nx, p.ny, p.nz);
    this.hints.push(this.hint);
    return i;
  }

  addTri(a: Vtx, b: Vtx, c: Vtx): void {
    // Winding is derived from the supplied vertex normals so callers never have to
    // reason about it; a face that came out backwards is silently flipped.
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const wx = c.x - a.x;
    const wy = c.y - a.y;
    const wz = c.z - a.z;
    const gx = uy * wz - uz * wy;
    const gy = uz * wx - ux * wz;
    const gz = ux * wy - uy * wx;
    const rx = a.nx + b.nx + c.nx;
    const ry = a.ny + b.ny + c.ny;
    const rz = a.nz + b.nz + c.nz;
    const ia = this.push(a);
    const ib = this.push(b);
    const ic = this.push(c);
    if (gx * rx + gy * ry + gz * rz >= 0) this.idx.push(ia, ib, ic);
    else this.idx.push(ia, ic, ib);
  }

  addQuad(a: Vtx, b: Vtx, c: Vtx, d: Vtx): void {
    this.addTri(a, b, c);
    this.addTri(a, c, d);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ambient occlusion baking
// ─────────────────────────────────────────────────────────────────────────────

/** 24 roughly uniform directions on the sphere (spherical Fibonacci). */
const AO_DIRS: Array<[number, number, number]> = (() => {
  const n = 24;
  const out: Array<[number, number, number]> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const yy = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - yy * yy));
    const th = golden * i;
    out.push([Math.cos(th) * r, yy, Math.sin(th) * r]);
  }
  return out;
})();

/**
 * Two occlusion scales in one march. The short radii produce the contact darkening in
 * tile crevices and inside corners; the long radii measure how much open sky a point
 * actually sees, which is what makes a sunken courtyard or a canyon floor read as sunken
 * instead of as flat ground that happens to have walls near it.
 */
const AO_RADII = [0.07, 0.16, 0.32, 0.58, 0.95, 1.7, 2.9, 4.4, 6.4];
const AO_STRENGTH = 1.15;
/** Occlusion weight for a hit at distance r — near hits dominate, far hits tint. */
function aoFalloff(r: number): number {
  return r <= 1 ? 1 - r / 1.35 : 0.3 * (1 - r / 7.4);
}

/** Column occupancy of the map, used both for AO and for side-face culling. */
class ColumnField {
  private readonly solid: Uint8Array;
  private readonly heights: Float32Array;
  private readonly bottoms: Float32Array;
  private readonly slopes: SlopeKind[];
  readonly baseY: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    tiles: Array<Tile | undefined>,
  ) {
    this.solid = new Uint8Array(width * height);
    this.heights = new Float32Array(width * height);
    this.bottoms = new Float32Array(width * height);
    this.slopes = new Array<SlopeKind>(width * height).fill('flat');

    const at = (x: number, y: number): Tile | undefined => {
      if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
      const t = tiles[y * width + x];
      return t && t.surface !== 'void' ? t : undefined;
    };

    // The underside is measured from the diorama's own rim, not from the deepest
    // silt bed on the map: whatever is exposed to open air on at least one side is
    // what the viewer can see the bottom of.
    let minRim = Infinity;
    let minWater = Infinity;
    let minGround = Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const t = at(x, y);
        if (!t) continue;
        this.solid[i] = 1;
        this.heights[i] = solidTopHalf(t);
        this.slopes[i] = isWaterSurface(t.surface) ? 'flat' : t.slope;

        const surfaceY = t.height * HEIGHT_UNIT;
        if (isWaterSurface(t.surface)) minWater = Math.min(minWater, surfaceY);
        else minGround = Math.min(minGround, surfaceY);
        const exposed =
          !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1);
        if (exposed) minRim = Math.min(minRim, surfaceY);
      }
    }

    let base = Number.isFinite(minRim) ? minRim - SKIRT : -SKIRT;
    if (Number.isFinite(minWater)) base = Math.min(base, minWater - WATERLINE_SKIRT);
    if (Number.isFinite(minGround)) base = Math.min(base, minGround - GROUND_SKIRT);
    this.baseY = base;

    // A silt bed may still hang below the base (a river trench cuts deeper than the
    // island is thick). Each column remembers its own floor so occlusion and the
    // exposed side faces both stay watertight.
    for (let i = 0; i < this.solid.length; i++) {
      if (this.solid[i] === 0) continue;
      this.bottoms[i] = Math.min(base, this.heights[i]! * HEIGHT_UNIT);
    }
  }

  /** Top of the *solid* part of a column in world Y (the bed, for water tiles). */
  topAt(tx: number, ty: number, u: number, v: number): number {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return -Infinity;
    const i = ty * this.width + tx;
    if (this.solid[i] === 0) return -Infinity;
    return (this.heights[i]! + slopeOffsetHalf(this.slopes[i]!, u, v)) * HEIGHT_UNIT;
  }

  /** Underside of a column: the diorama base, or lower where a bed cuts past it. */
  bottomAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return this.baseY;
    const i = ty * this.width + tx;
    if (this.solid[i] === 0) return this.baseY;
    return this.bottoms[i]!;
  }

  solidAtWorld(wx: number, wy: number, wz: number): boolean {
    const tx = Math.round(wx / TILE_SIZE);
    const ty = Math.round(wz / TILE_SIZE);
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    const i = ty * this.width + tx;
    if (this.solid[i] === 0) return false;
    const u = wx / TILE_SIZE - tx + 0.5;
    const vv = wz / TILE_SIZE - ty + 0.5;
    const top = (this.heights[i]! + slopeOffsetHalf(this.slopes[i]!, u, vv)) * HEIGHT_UNIT;
    return wy <= top - 1e-4 && wy >= this.bottoms[i]!;
  }
}

/** Solid top of a tile in half-tiles — water tiles are solid only down at their bed. */
function solidTopHalf(t: Tile): number {
  if (t.surface === 'deepwater') return t.height - DEEPWATER_BED_DEPTH;
  if (t.surface === 'water') return t.height - WATER_BED_DEPTH;
  return t.height;
}

function bakeAO(bucket: Bucket, field: ColumnField): Float32Array {
  const count = bucket.pos.length / 3;
  const ao = new Float32Array(count);
  const cache = new Map<string, number>();
  const pos = bucket.pos;
  const nrm = bucket.nrm;

  for (let i = 0; i < count; i++) {
    const hinted = bucket.hints[i];
    if (hinted !== undefined && hinted >= 0) {
      ao[i] = hinted;
      continue;
    }
    const px = pos[i * 3]!;
    const py = pos[i * 3 + 1]!;
    const pz = pos[i * 3 + 2]!;
    const nx = nrm[i * 3]!;
    const ny = nrm[i * 3 + 1]!;
    const nz = nrm[i * 3 + 2]!;

    const key = `${Math.round(px * 512)},${Math.round(py * 512)},${Math.round(pz * 512)},${
      Math.round(nx * 8)
    },${Math.round(ny * 8)},${Math.round(nz * 8)}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      ao[i] = hit;
      continue;
    }

    // Nudge off the surface so the sample point is not inside its own column.
    const ox = px + nx * 0.012;
    const oy = py + ny * 0.012;
    const oz = pz + nz * 0.012;

    let occ = 0;
    let wsum = 0;
    for (const d of AO_DIRS) {
      const w = d[0] * nx + d[1] * ny + d[2] * nz;
      if (w <= 0.05) continue;
      wsum += w;
      for (const r of AO_RADII) {
        if (field.solidAtWorld(ox + d[0] * r, oy + d[1] * r, oz + d[2] * r)) {
          occ += w * aoFalloff(r);
          break;
        }
      }
    }
    const value = wsum > 0 ? Math.max(0, Math.min(1, 1 - (occ / wsum) * AO_STRENGTH)) : 1;
    cache.set(key, value);
    ao[i] = value;
  }
  return ao;
}

// ─────────────────────────────────────────────────────────────────────────────
// UV projection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * World-space triplanar-style UVs chosen per vertex by dominant normal axis. Baked at
 * build time rather than done in the shader: the geometry is static, so this is free and
 * the side faces never smear.
 */
function bakeUVs(bucket: Bucket): Float32Array {
  const count = bucket.pos.length / 3;
  const uv = new Float32Array(count * 2);
  const s = 1 / TEXTURE_WORLD_SCALE;
  for (let i = 0; i < count; i++) {
    const px = bucket.pos[i * 3]!;
    const py = bucket.pos[i * 3 + 1]!;
    const pz = bucket.pos[i * 3 + 2]!;
    const ax = Math.abs(bucket.nrm[i * 3]!);
    const ay = Math.abs(bucket.nrm[i * 3 + 1]!);
    const az = Math.abs(bucket.nrm[i * 3 + 2]!);
    let u: number;
    let vv: number;
    if (ay >= ax && ay >= az) {
      u = px * s;
      vv = pz * s;
    } else if (ax >= az) {
      u = pz * s;
      vv = -py * s;
    } else {
      u = px * s;
      vv = -py * s;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = vv;
  }
  return uv;
}

function finishGeometry(bucket: Bucket, field: ColumnField): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(bakeUVs(bucket), 2));
  geo.setAttribute('aAO', new THREE.BufferAttribute(bakeAO(bucket, field), 1));
  geo.setIndex(bucket.idx);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Highlights
// ─────────────────────────────────────────────────────────────────────────────

export type HighlightKind = 'move' | 'attack' | 'aoe' | 'heal' | 'danger' | 'cursor';

const HIGHLIGHT_ORDER: readonly HighlightKind[] = [
  'move',
  'attack',
  'aoe',
  'heal',
  'danger',
  'cursor',
];

const HIGHLIGHT_ID: Record<HighlightKind, number> = {
  move: 1,
  attack: 2,
  aoe: 3,
  heal: 4,
  danger: 5,
  cursor: 6,
};

const HIGHLIGHT_VERT = /* glsl */ `
attribute vec2 aTile;
attribute vec2 aLocal;
varying vec2 vTile;
varying vec2 vLocal;
void main() {
  vTile = aTile;
  vLocal = aLocal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HIGHLIGHT_FRAG = /* glsl */ `
uniform sampler2D uState;
uniform vec2 uGrid;
uniform float uTime;
varying vec2 vTile;
varying vec2 vLocal;

bool bitSet(float mask, float bit) {
  return mod(floor(mask / bit), 2.0) >= 1.0;
}

void main() {
  vec4 s = texture2D(uState, (vTile + 0.5) / uGrid);
  float kind = floor(s.r * 255.0 + 0.5);
  if (kind < 0.5) discard;
  float mask = floor(s.g * 255.0 + 0.5);
  float intensity = s.b;

  vec3 col;
  if (kind < 1.5)       col = vec3(0.20, 0.58, 1.00);   // movement
  else if (kind < 2.5)  col = vec3(1.00, 0.24, 0.20);   // attack
  else if (kind < 3.5)  col = vec3(1.00, 0.70, 0.16);   // area of effect
  else if (kind < 4.5)  col = vec3(0.32, 1.00, 0.52);   // beneficial
  else if (kind < 5.5)  col = vec3(0.76, 0.30, 1.00);   // danger
  else                  col = vec3(1.00, 0.95, 0.82);   // cursor

  // Outline only the boundary of the region, never the seams between tiles inside it.
  float d = 1.0;
  if (bitSet(mask, 1.0)) d = min(d, vLocal.y);
  if (bitSet(mask, 2.0)) d = min(d, 1.0 - vLocal.x);
  if (bitSet(mask, 4.0)) d = min(d, 1.0 - vLocal.y);
  if (bitSet(mask, 8.0)) d = min(d, vLocal.x);

  float rimSoft = 1.0 - smoothstep(0.0, 0.20, d);
  float rimCore = 1.0 - smoothstep(0.0, 0.06, d);

  float phase = uTime * 2.4 - (vTile.x + vTile.y) * 0.45;
  float pulse = 0.80 + 0.20 * sin(phase);
  // Slow diagonal shimmer keeps the fill from reading as a dead wash.
  float hatch = 0.5 + 0.5 * sin((vLocal.x + vLocal.y) * 22.0 - uTime * 1.6 + (vTile.x - vTile.y) * 3.0);

  float fill = 0.24 + 0.08 * hatch + rimSoft * 0.22;
  float a = mix(fill, 0.92, rimCore) * pulse * intensity;

  vec3 c = mix(col * 1.05, mix(col, vec3(1.0), 0.65), rimCore);
  c += col * rimSoft * 0.55;

  // Palette above is authored display-referred; convert before the sRGB encode.
  gl_FragColor = vec4(c * c, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

class HighlightLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly data: Uint8Array;
  private readonly texture: THREE.DataTexture;
  private readonly layers = new Map<HighlightKind, Set<number>>();
  private readonly intensities = new Map<HighlightKind, number>();
  private readonly present: Uint8Array;

  constructor(
    private readonly width: number,
    private readonly height: number,
    geometry: THREE.BufferGeometry,
  ) {
    this.data = new Uint8Array(width * height * 4);
    this.present = new Uint8Array(width * height);
    this.texture = new THREE.DataTexture(this.data, width, height, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      vertexShader: HIGHLIGHT_VERT,
      fragmentShader: HIGHLIGHT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      uniforms: {
        uState: { value: this.texture },
        uGrid: { value: new THREE.Vector2(width, height) },
        uTime: { value: 0 },
      },
    });
    this.material.toneMapped = false;
    this.material.name = 'tile-highlight';

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'tile-highlights';
    this.mesh.renderOrder = 20;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
  }

  set(kind: HighlightKind, tiles: Iterable<{ x: number; y: number }>, intensity = 1): void {
    const set = new Set<number>();
    for (const t of tiles) {
      if (t.x < 0 || t.y < 0 || t.x >= this.width || t.y >= this.height) continue;
      if (this.present[t.y * this.width + t.x] === 0) continue;
      set.add(t.y * this.width + t.x);
    }
    if (set.size === 0) this.layers.delete(kind);
    else this.layers.set(kind, set);
    this.intensities.set(kind, intensity);
    this.recompose();
  }

  clear(kind?: HighlightKind): void {
    if (kind) this.layers.delete(kind);
    else this.layers.clear();
    this.recompose();
  }

  has(kind: HighlightKind): boolean {
    return this.layers.has(kind);
  }

  /** Mark which tiles actually have overlay geometry (void tiles have none). */
  markPresent(index: number): void {
    this.present[index] = 1;
  }

  private recompose(): void {
    this.data.fill(0);
    let any = false;
    for (const kind of HIGHLIGHT_ORDER) {
      const set = this.layers.get(kind);
      if (!set || set.size === 0) continue;
      any = true;
      const id = HIGHLIGHT_ID[kind];
      const intensity = Math.round((this.intensities.get(kind) ?? 1) * 255);
      for (const idx of set) {
        const tx = idx % this.width;
        const ty = (idx - tx) / this.width;
        let mask = 0;
        if (!set.has(this.indexOf(tx, ty - 1))) mask |= 1; // north
        if (!set.has(this.indexOf(tx + 1, ty))) mask |= 2; // east
        if (!set.has(this.indexOf(tx, ty + 1))) mask |= 4; // south
        if (!set.has(this.indexOf(tx - 1, ty))) mask |= 8; // west
        this.data[idx * 4] = id;
        this.data[idx * 4 + 1] = mask;
        this.data[idx * 4 + 2] = intensity;
        this.data[idx * 4 + 3] = 255;
      }
    }
    this.texture.needsUpdate = true;
    this.mesh.visible = any;
  }

  private indexOf(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return y * this.width + x;
  }

  update(elapsed: number): void {
    this.material.uniforms.uTime!.value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Path ribbon
// ─────────────────────────────────────────────────────────────────────────────

const PATH_VERT = /* glsl */ `
attribute float aLen;
varying vec2 vUv;
varying float vLen;
void main() {
  vUv = uv;
  vLen = aLen;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PATH_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uTotal;
varying vec2 vUv;
varying float vLen;

void main() {
  // Chevrons marching toward the destination.
  float across = abs(vUv.x - 0.5) * 2.0;
  float march = fract(vLen * 1.6 - uTime * 1.15 - across * 0.28);
  float chev = smoothstep(0.42, 0.0, abs(march - 0.22));
  float body = smoothstep(1.0, 0.55, across);
  float edge = smoothstep(0.78, 1.0, across);

  float a = body * (0.20 + chev * 0.72) + edge * 0.35;
  // Fade the tail in so the ribbon does not start with a hard chop.
  a *= smoothstep(0.0, 0.35, vLen) * smoothstep(0.0, 0.25, uTotal - vLen + 0.25);

  vec3 c = mix(uColor * 0.7, vec3(1.0), chev * 0.7);
  gl_FragColor = vec4(c * c, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

class PathRibbon {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: PATH_VERT,
      fragmentShader: PATH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -12,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x7fd8ff) },
        uTotal: { value: 1 },
      },
    });
    this.material.toneMapped = false;
    this.material.name = 'path-ribbon';
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'path-ribbon';
    this.mesh.renderOrder = 22;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  set(points: readonly THREE.Vector3[]): void {
    this.mesh.geometry.dispose();
    if (points.length < 2) {
      this.mesh.geometry = new THREE.BufferGeometry();
      this.mesh.visible = false;
      return;
    }
    const half = 0.19;
    const pos: number[] = [];
    const uv: number[] = [];
    const len: number[] = [];
    const idx: number[] = [];
    let travelled = 0;

    // Averaged direction at each joint gives a mitre-free but continuous ribbon.
    const dirs: THREE.Vector3[] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = points[Math.max(0, i - 1)]!;
      const next = points[Math.min(points.length - 1, i + 1)]!;
      const d = new THREE.Vector3(next.x - prev.x, 0, next.z - prev.z);
      if (d.lengthSq() < 1e-8) d.set(0, 0, 1);
      dirs.push(d.normalize());
    }

    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (i > 0) {
        const q = points[i - 1]!;
        travelled += Math.hypot(p.x - q.x, p.z - q.z);
      }
      const d = dirs[i]!;
      const side = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(half);
      pos.push(p.x - side.x, p.y, p.z - side.z);
      pos.push(p.x + side.x, p.y, p.z + side.z);
      uv.push(0, travelled, 1, travelled);
      len.push(travelled, travelled);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    // Arrowhead at the destination.
    const end = points[points.length - 1]!;
    const dir = dirs[dirs.length - 1]!;
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(half * 2.05);
    const tip = new THREE.Vector3(end.x + dir.x * 0.42, end.y, end.z + dir.z * 0.42);
    const baseIdx = pos.length / 3;
    pos.push(end.x - side.x, end.y, end.z - side.z);
    pos.push(end.x + side.x, end.y, end.z + side.z);
    pos.push(tip.x, tip.y, tip.z);
    uv.push(0, travelled, 1, travelled, 0.5, travelled + 0.42);
    len.push(travelled, travelled, travelled + 0.42);
    idx.push(baseIdx, baseIdx + 1, baseIdx + 2);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aLen', new THREE.Float32BufferAttribute(len, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.mesh.geometry = geo;
    this.mesh.visible = true;
    this.material.uniforms.uTotal!.value = travelled + 0.42;
  }

  clear(): void {
    this.mesh.visible = false;
  }

  update(elapsed: number): void {
    this.material.uniforms.uTime!.value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrain group
// ─────────────────────────────────────────────────────────────────────────────

export interface TerrainOptions {
  /** Water look; defaults to a clear freshwater palette. */
  water?: WaterOptions;
  /** Disable the (expensive) AO bake — only for tooling. */
  skipAO?: boolean;
}

export class Terrain extends THREE.Group {
  readonly field: Battlefield;
  private readonly highlights: HighlightLayer;
  private readonly path: PathRibbon;
  private readonly waterMaterial: WaterMaterial | null;
  private readonly waterMesh: THREE.Mesh | null;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private elapsed = 0;

  private refractionTarget: THREE.WebGLRenderTarget | null = null;
  private refractionSize = new THREE.Vector2();
  private capturing = false;

  constructor(
    field: Battlefield,
    highlights: HighlightLayer,
    path: PathRibbon,
    waterMesh: THREE.Mesh | null,
    waterMaterial: WaterMaterial | null,
  ) {
    super();
    this.name = `terrain:${field.mapId}`;
    this.field = field;
    this.highlights = highlights;
    this.path = path;
    this.waterMesh = waterMesh;
    this.waterMaterial = waterMaterial;
  }

  /** @internal */
  trackGeometry(geo: THREE.BufferGeometry): void {
    this.ownedGeometries.push(geo);
  }

  /** @internal — materials created per-terrain rather than shared from the cache. */
  trackMaterial(mat: THREE.Material): void {
    this.ownedMaterials.push(mat);
  }

  /** Advance highlight pulses, path chevrons and water animation. `dt` in seconds. */
  update(dt: number): void {
    this.elapsed += dt;
    this.highlights.update(this.elapsed);
    this.path.update(this.elapsed);
    this.waterMaterial?.update(dt);
  }

  /** Paint a set of tiles with a highlight kind. Replaces any previous set of that kind. */
  setHighlight(
    kind: HighlightKind,
    tiles: Iterable<{ x: number; y: number }>,
    intensity = 1,
  ): void {
    this.highlights.set(kind, tiles, intensity);
  }

  /** Clear one highlight kind, or all of them. */
  clearHighlights(kind?: HighlightKind): void {
    this.highlights.clear(kind);
  }

  /** Draw a movement path. Pass `null` to hide it. */
  setPath(path: readonly Vec3[] | null): void {
    if (!path || path.length < 2) {
      this.path.clear();
      return;
    }
    const pts = path.map((p) => {
      const t = this.field.tileAt(p.x, p.y);
      const h = t
        ? (t.height + slopeOffsetHalf(t.slope, 0.5, 0.5)) * HEIGHT_UNIT
        : p.z * HEIGHT_UNIT;
      return new THREE.Vector3(p.x * TILE_SIZE, h + 0.045, p.y * TILE_SIZE);
    });
    this.path.set(pts);
  }

  /** The water material, if this map has any water. */
  get water(): WaterMaterial | null {
    return this.waterMaterial;
  }

  /**
   * Capture the scene behind the water so the water shader can refract it.
   * The stage should call this once per frame, immediately before its main render.
   * Cheap no-op on maps without water.
   */
  prepare(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.waterMesh || !this.waterMaterial || this.capturing) return;
    if (!this.waterMesh.visible) return;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x < 2 || size.y < 2) return;

    if (!this.refractionTarget || !this.refractionSize.equals(size)) {
      this.refractionTarget?.dispose();
      const depth = new THREE.DepthTexture(size.x, size.y);
      depth.format = THREE.DepthFormat;
      depth.type = THREE.UnsignedIntType;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
        type: THREE.HalfFloatType,
        depthTexture: depth,
        depthBuffer: true,
        stencilBuffer: false,
      });
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.generateMipmaps = false;
      this.refractionTarget = rt;
      this.refractionSize.copy(size);
    }

    const rt = this.refractionTarget;
    const waterVisible = this.waterMesh.visible;
    const hlVisible = this.highlights.mesh.visible;
    const pathVisible = this.path.mesh.visible;
    const prevTarget = renderer.getRenderTarget();

    this.capturing = true;
    this.waterMesh.visible = false;
    this.highlights.mesh.visible = false;
    this.path.mesh.visible = false;
    try {
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      this.waterMesh.visible = waterVisible;
      this.highlights.mesh.visible = hlVisible;
      this.path.mesh.visible = pathVisible;
      this.capturing = false;
    }

    this.waterMaterial.setSceneBuffers(rt.texture, rt.depthTexture, camera);
    this.waterMaterial.setResolution(size.x, size.y);
  }

  dispose(): void {
    for (const g of this.ownedGeometries) g.dispose();
    this.ownedGeometries.length = 0;
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.highlights.dispose();
    this.path.dispose();
    this.waterMaterial?.dispose();
    this.refractionTarget?.depthTexture?.dispose();
    this.refractionTarget?.dispose();
    this.refractionTarget = null;
    this.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surfaces whose tall drops read as natural rock. Built surfaces (masonry, planking,
 * roofing) keep their own material and stay flat-faced — a monastery wall must look like
 * a wall, not a crag.
 */
const NATURAL_ROCK: ReadonlySet<TerrainMaterialKind> = new Set<TerrainMaterialKind>([
  'grass',
  'dirt',
  'sand',
  'snow',
  'swamp',
  'bed',
]);

/** Surfaces that are architecture rather than landscape. */
const BUILT: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['stone', 'wood', 'roof', 'bridge']);

/**
 * Whether a tile's exposed sides should be sculpted rock.
 *
 * Stone is ambiguous — it is both a monastery floor and a bedrock outcrop — so it is
 * resolved from context: stone surrounded by other built surfaces stays masonry all the
 * way down, stone surrounded by grass and dirt becomes a crag.
 */
function isNaturalRock(
  tiles: Array<Tile | undefined>,
  width: number,
  height: number,
  tx: number,
  ty: number,
  kind: TerrainMaterialKind,
): boolean {
  if (NATURAL_ROCK.has(kind)) return true;
  if (kind !== 'stone') return false;
  let natural = 0;
  let built = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const x = tx + dx;
      const z = ty + dz;
      if (x < 0 || z < 0 || x >= width || z >= height) continue;
      const t = tiles[z * width + x];
      if (!t || t.surface === 'void') continue;
      if (BUILT.has(t.surface)) built++;
      else natural++;
    }
  }
  return natural > built;
}

/**
 * Material for a tile's vertical faces. Grass, snow and swamp are thin skins over soil —
 * showing a wall of grass is the single most common tell of an untextured tile engine — so
 * their sides fall back to dirt while the chamfer keeps the surface material and reads as
 * the turf rolling over the lip.
 */
function sideKindFor(kind: TerrainMaterialKind): TerrainMaterialKind {
  if (kind === 'grass' || kind === 'snow' || kind === 'swamp') return 'dirt';
  // A paved floor and the wall beneath it are not the same masonry: the floor is a few
  // big flagstones, the wall is many thin courses. Using one texture for both is the
  // clearest sign that a diorama is a texture-mapped box.
  if (kind === 'stone' || kind === 'roof') return 'stonewall';
  if (kind === 'wood' || kind === 'bridge') return 'timber';
  return kind;
}

/** Which material bucket a tile's solid geometry belongs to. */
function bucketKindFor(t: Tile): TerrainMaterialKind {
  if (isWaterSurface(t.surface)) return 'bed';
  return t.surface;
}

interface EdgeSpec {
  dx: number;
  dy: number;
  /** Local (u, v) of the edge's start and end, walked so the face is outward-facing. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  nx: number;
  nz: number;
  /** Local (u, v) of the *neighbour's* matching edge, for height stitching. */
  mu0: number;
  mv0: number;
  mu1: number;
  mv1: number;
}

const EDGES: readonly EdgeSpec[] = [
  // north (-y / -z)
  { dx: 0, dy: -1, u0: 0, v0: 0, u1: 1, v1: 0, nx: 0, nz: -1, mu0: 0, mv0: 1, mu1: 1, mv1: 1 },
  // east (+x)
  { dx: 1, dy: 0, u0: 1, v0: 0, u1: 1, v1: 1, nx: 1, nz: 0, mu0: 0, mv0: 0, mu1: 0, mv1: 1 },
  // south (+y / +z)
  { dx: 0, dy: 1, u0: 1, v0: 1, u1: 0, v1: 1, nx: 0, nz: 1, mu0: 1, mv0: 0, mu1: 0, mv1: 0 },
  // west (-x)
  { dx: -1, dy: 0, u0: 0, v0: 1, u1: 0, v1: 0, nx: -1, nz: 0, mu0: 1, mv0: 1, mu1: 1, mv1: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Prop geometry primitives
//
// The references are *full*: railings, balusters, stairs, pillars with real capitals,
// crates, barrels, braziers, banners, shrubs, rubble. An empty tile field reads as a
// test scene no matter how well textured, so the builder populates the map from the
// same `Battlefield` the tiles came from — deterministically, so a map looks the same
// every time it loads and a replay is bit-identical.
//
// Everything below emits into the *same* material buckets as the terrain, so props
// cost no extra draw calls and pick up the same baked UV projection.
// ─────────────────────────────────────────────────────────────────────────────

/** Emit a triangle with a single flat geometric normal. */
function flatTri(
  bucket: Bucket,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  ox = 0, oy = 0, oz = 0,
): void {
  let gx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  let gy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  let gz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const l = Math.hypot(gx, gy, gz) || 1;
  gx /= l;
  gy /= l;
  gz /= l;
  // Orient away from the supplied interior point so `addTri`'s auto-winding agrees.
  const mx = (ax + bx + cx) / 3 - ox;
  const my = (ay + by + cy) / 3 - oy;
  const mz = (az + bz + cz) / 3 - oz;
  if (gx * mx + gy * my + gz * mz < 0) {
    gx = -gx;
    gy = -gy;
    gz = -gz;
  }
  bucket.addTri(v(ax, ay, az, gx, gy, gz), v(bx, by, bz, gx, gy, gz), v(cx, cy, cz, gx, gy, gz));
}

function flatQuad(
  bucket: Bucket,
  p: readonly [number, number, number][],
  ox: number, oy: number, oz: number,
): void {
  flatTri(bucket, ...p[0]!, ...p[1]!, ...p[2]!, ox, oy, oz);
  flatTri(bucket, ...p[0]!, ...p[2]!, ...p[3]!, ox, oy, oz);
}

/** An axis-aligned box, optionally yawed about its own centre. */
function addBox(
  bucket: Bucket,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
  yaw = 0,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const pt = (sx: number, sy: number, sz: number): [number, number, number] => {
    const lx = sx * hx;
    const lz = sz * hz;
    return [cx + lx * c - lz * s, cy + sy * hy, cz + lx * s + lz * c];
  };
  const a = pt(-1, 1, -1);
  const b = pt(1, 1, -1);
  const d = pt(1, 1, 1);
  const e = pt(-1, 1, 1);
  const f = pt(-1, -1, -1);
  const g = pt(1, -1, -1);
  const h = pt(1, -1, 1);
  const i = pt(-1, -1, 1);
  flatQuad(bucket, [a, b, d, e], cx, cy, cz);
  flatQuad(bucket, [f, i, h, g], cx, cy, cz);
  flatQuad(bucket, [a, f, g, b], cx, cy, cz);
  flatQuad(bucket, [e, d, h, i], cx, cy, cz);
  flatQuad(bucket, [a, e, i, f], cx, cy, cz);
  flatQuad(bucket, [b, g, h, d], cx, cy, cz);
}

/**
 * An n-sided prism / frustum with smooth radial normals. `bulge` > 0 pushes the
 * mid-height outward, which is what turns a cylinder into a barrel.
 */
function addPrism(
  bucket: Bucket,
  cx: number, cz: number,
  y0: number, y1: number,
  r0: number, r1: number,
  sides: number,
  yaw = 0,
  bulge = 0,
  capTop = true,
  capBottom = false,
): void {
  const rings = bulge !== 0 ? 3 : 1;
  const ringY: number[] = [];
  const ringR: number[] = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    ringY.push(y0 + (y1 - y0) * t);
    ringR.push(r0 + (r1 - r0) * t + Math.sin(t * Math.PI) * bulge);
  }
  const ang = (i: number): number => yaw + (i / sides) * Math.PI * 2;
  for (let k = 0; k < rings; k++) {
    for (let i = 0; i < sides; i++) {
      const a0 = ang(i);
      const a1 = ang(i + 1);
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      const yA = ringY[k]!;
      const yB = ringY[k + 1]!;
      const rA = ringR[k]!;
      const rB = ringR[k + 1]!;
      const p0 = v(cx + c0 * rA, yA, cz + s0 * rA, c0, 0, s0);
      const p1 = v(cx + c1 * rA, yA, cz + s1 * rA, c1, 0, s1);
      const p2 = v(cx + c1 * rB, yB, cz + s1 * rB, c1, 0, s1);
      const p3 = v(cx + c0 * rB, yB, cz + s0 * rB, c0, 0, s0);
      bucket.addQuad(p0, p1, p2, p3);
    }
  }
  const cap = (y: number, r: number, up: number): void => {
    if (r <= 1e-4) return;
    for (let i = 0; i < sides; i++) {
      const a0 = ang(i);
      const a1 = ang(i + 1);
      bucket.addTri(
        v(cx, y, cz, 0, up, 0),
        v(cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r, 0, up, 0),
        v(cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r, 0, up, 0),
      );
    }
  };
  if (capTop) cap(y1, r1, 1);
  if (capBottom) cap(y0, r0, -1);
}

/**
 * An irregular lump. Used for boulders, rubble and leaf clusters — a sphere with
 * per-vertex noise radius, which is the cheapest thing that reads as organic mass.
 */
function addBlob(
  bucket: Bucket,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
  seed: number,
  roughness = 0.32,
  segU = 8,
  segV = 5,
): void {
  const grid: Vtx[][] = [];
  for (let j = 0; j <= segV; j++) {
    const phi = (j / segV) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    const row: Vtx[] = [];
    for (let i = 0; i <= segU; i++) {
      const th = (i / segU) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const ux = sp * ct;
      const uy = cp;
      const uz = sp * st;
      // Wrap the noise so the seam at i = segU matches i = 0.
      const wi = i % segU;
      const n =
        1 +
        (hash3(wi, j, 0, seed) - 0.5) * 2 * roughness +
        (hash3(wi * 3, j * 3, 1, seed) - 0.5) * roughness * 0.6;
      row.push(v(cx + ux * rx * n, cy + uy * ry * n, cz + uz * rz * n, ux, uy, uz));
    }
    grid.push(row);
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = grid[j]![i]!;
      const b = grid[j]![i + 1]!;
      const c = grid[j + 1]![i + 1]!;
      const d = grid[j + 1]![i]!;
      if (j === 0) bucket.addTri(a, c, d);
      else if (j === segV - 1) bucket.addTri(a, b, c);
      else bucket.addQuad(a, b, c, d);
    }
  }
}

/** A double-sided quad with a sag, used for hanging cloth. */
function addBannerCloth(
  bucket: Bucket,
  cx: number, cy: number, cz: number,
  nx: number, nz: number,
  width: number,
  height: number,
  seed: number,
): void {
  const sx = -nz;
  const sz = nx;
  const cols = 6;
  const rows = 5;
  const grid: Vtx[][] = [];
  for (let j = 0; j <= rows; j++) {
    const t = j / rows;
    const row: Vtx[] = [];
    for (let i = 0; i <= cols; i++) {
      const u = i / cols - 0.5;
      // Vertical folds, deepening toward the free bottom edge.
      const fold = Math.sin(u * Math.PI * 5 + hash3(i, 0, 0, seed) * 0.6) * 0.022 * (0.35 + t);
      const bow = Math.sin(t * Math.PI) * 0.02;
      const off = fold + bow;
      const x = cx + sx * u * width + nx * off;
      const z = cz + sz * u * width + nz * off;
      // Slight scalloped hem.
      const hem = j === rows ? Math.abs(Math.sin(u * Math.PI * 3)) * 0.06 : 0;
      const y = cy - t * height - hem;
      const dn = Math.cos(u * Math.PI * 5) * 0.55;
      const n = [nx + sx * dn * 0.5, 0.12, nz + sz * dn * 0.5];
      const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
      row.push(v(x, y, z, n[0]! / l, n[1]! / l, n[2]! / l));
    }
    grid.push(row);
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = grid[j]![i]!;
      const b = grid[j]![i + 1]!;
      const c = grid[j + 1]![i + 1]!;
      const d = grid[j + 1]![i]!;
      bucket.addQuad(a, b, c, d);
      // Back face, so the banner reads from either camera yaw.
      bucket.addQuad(
        v(d.x, d.y, d.z, -d.nx, -d.ny, -d.nz),
        v(c.x, c.y, c.z, -c.nx, -c.ny, -c.nz),
        v(b.x, b.y, b.z, -b.nx, -b.ny, -b.nz),
        v(a.x, a.y, a.z, -a.nx, -a.ny, -a.nz),
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A classical column: plinth, torus, tapered shaft, necking, echinus, abacus.
 * Six stacked elements is the minimum that reads as *architecture* rather than as a
 * cylinder — the reference frames never show a bare shaft.
 */
function addColumn(
  bucket: Bucket,
  shaftBucket: Bucket,
  cx: number, cz: number,
  y0: number, y1: number,
  radius: number,
  seed: number,
): void {
  const h = y1 - y0;
  if (h < 0.25) return;
  const yaw = hash3(Math.round(cx * 4), Math.round(cz * 4), 3, seed) * 0.4;
  const plinthH = Math.min(0.13, h * 0.11);
  const capH = Math.min(0.17, h * 0.15);
  const shaft0 = y0 + plinthH + 0.04;
  const shaft1 = y1 - capH;

  bucket.hint = 0.42;
  addBox(bucket, cx, y0 + plinthH / 2, cz, radius * 1.44, plinthH / 2, radius * 1.44, yaw);
  bucket.hint = 0.55;
  addPrism(bucket, cx, cz, y0 + plinthH, shaft0, radius * 1.26, radius * 1.10, 12, yaw, 0, false);

  // Shaft, gently tapered (entasis). It gets its own fluted material: masonry courses
  // wrapped around a cylinder read as a stack of discs, which is what a totem pole is.
  shaftBucket.hint = 0.88;
  addPrism(shaftBucket, cx, cz, shaft0, shaft1, radius * 1.06, radius * 0.88, 16, yaw, 0.014, false);

  // Necking ring + flared echinus + square abacus.
  bucket.hint = 0.82;
  addPrism(bucket, cx, cz, shaft1, shaft1 + capH * 0.20, radius * 0.96, radius * 0.96, 12, yaw, 0, false);
  addPrism(bucket, cx, cz, shaft1 + capH * 0.20, shaft1 + capH * 0.60, radius * 0.92, radius * 1.34, 12, yaw, 0, false);
  bucket.hint = 0.95;
  addBox(bucket, cx, shaft1 + capH * 0.80, cz, radius * 1.50, capH * 0.20, radius * 1.50, yaw);
  bucket.hint = -1;
  shaftBucket.hint = -1;
}

/** A balustrade run along one tile edge: end posts, a moulded rail, and balusters. */
function addBalustrade(
  bucket: Bucket,
  x0: number, z0: number,
  x1: number, z1: number,
  baseY: number,
  seed: number,
): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.2) return;
  const ux = dx / len;
  const uz = dz / len;
  const yaw = Math.atan2(uz, ux);
  const railH = 0.50;
  const postH = 0.64;

  bucket.hint = 0.62;
  // End posts.
  for (const t of [0, 1]) {
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    addBox(bucket, px, baseY + postH * 0.5, pz, 0.105, postH * 0.5, 0.105, yaw);
    addBox(bucket, px, baseY + postH + 0.04, pz, 0.128, 0.04, 0.128, yaw);
    addPrism(bucket, px, pz, baseY + postH + 0.08, baseY + postH + 0.19, 0.075, 0.02, 8, yaw, 0, true);
  }
  // Bottom plinth rail.
  bucket.hint = 0.5;
  addBox(bucket, x0 + dx * 0.5, baseY + 0.06, z0 + dz * 0.5, len * 0.5, 0.06, 0.078, yaw);
  // Balusters — little turned vases.
  const n = Math.max(2, Math.round(len / 0.21));
  bucket.hint = 0.72;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    const jitter = (hash3(Math.round(px * 8), Math.round(pz * 8), i, seed) - 0.5) * 0.012;
    addPrism(bucket, px + jitter, pz, baseY + 0.11, baseY + 0.20, 0.052, 0.030, 6, 0, 0, false);
    addPrism(bucket, px + jitter, pz, baseY + 0.20, baseY + 0.34, 0.030, 0.046, 6, 0, 0.014, false);
    addPrism(bucket, px + jitter, pz, baseY + 0.34, baseY + railH - 0.05, 0.046, 0.030, 6, 0, 0, false);
  }
  // Top rail, with a chamfered cap.
  bucket.hint = 0.94;
  addBox(bucket, x0 + dx * 0.5, baseY + railH - 0.025, z0 + dz * 0.5, len * 0.5, 0.045, 0.092, yaw);
  addBox(bucket, x0 + dx * 0.5, baseY + railH + 0.042, z0 + dz * 0.5, len * 0.5, 0.026, 0.112, yaw);
  bucket.hint = -1;
}

/** A low parapet wall with a coping course — used to frame the diorama's outer rim. */
function addParapet(
  bucket: Bucket,
  x0: number, z0: number,
  x1: number, z1: number,
  baseY: number,
  outX: number, outZ: number,
  seed: number,
): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.2) return;
  const yaw = Math.atan2(dz, dx);
  const mx = x0 + dx * 0.5 + outX * 0.36;
  const mz = z0 + dz * 0.5 + outZ * 0.36;
  const h = 0.40 + hash3(Math.round(mx * 4), Math.round(mz * 4), 7, seed) * 0.10;

  bucket.hint = 0.58;
  addBox(bucket, mx, baseY + h * 0.5, mz, len * 0.5, h * 0.5, 0.12, yaw);
  bucket.hint = 0.92;
  addBox(bucket, mx, baseY + h + 0.038, mz, len * 0.5 + 0.02, 0.038, 0.155, yaw);
  bucket.hint = -1;
}

/**
 * A pilaster buttress running down the outer face of the diorama's pedestal, with a
 * weathered sloping top and a spreading foot. Three or four of these per side turn a
 * blank retaining wall into architecture and, more importantly, break the silhouette
 * — a smooth extruded prism is what makes a diorama look like a box.
 */
function addButtress(
  bucket: Bucket,
  cx: number, cz: number,
  topY: number, baseY: number,
  outX: number, outZ: number,
  seed: number,
): void {
  const h = topY - baseY;
  if (h < 0.6) return;
  const yaw = Math.atan2(outZ, outX);
  const half = 0.30;
  const proud = 0.30;
  const px = cx + outX * (0.5 + proud * 0.5);
  const pz = cz + outZ * (0.5 + proud * 0.5);
  const along = (a: number): [number, number] =>
    outX === 0 ? [half * a, 0] : [0, half * a];
  void along;

  bucket.hint = 0.5;
  // Shaft, in two set-offs: the lower stage is wider, which is how a real buttress
  // is built and, more usefully here, doubles the number of silhouette edges.
  addBox(
    bucket, px, baseY + h * 0.72, pz,
    outX === 0 ? half : proud * 0.5 + 0.02, h * 0.28, outX === 0 ? proud * 0.5 + 0.02 : half,
    0,
  );
  bucket.hint = 0.44;
  const lowProud = proud * 1.45;
  addBox(
    bucket,
    cx + outX * (0.5 + lowProud * 0.5), baseY + h * 0.44, cz + outZ * (0.5 + lowProud * 0.5),
    outX === 0 ? half * 1.18 : lowProud * 0.5 + 0.02, h * 0.28,
    outX === 0 ? lowProud * 0.5 + 0.02 : half * 1.18,
    0,
  );
  // The offset between the two stages gets its own weathered slope.
  const offY = baseY + h * 0.72;
  const oa = 0.5 + proud;
  const ob = 0.5 + lowProud;
  const qa: [number, number, number] = [cx + outX * oa - (outX === 0 ? half : 0), offY, cz + outZ * oa - (outZ === 0 ? half : 0)];
  const qb: [number, number, number] = [cx + outX * oa + (outX === 0 ? half : 0), offY, cz + outZ * oa + (outZ === 0 ? half : 0)];
  const qc: [number, number, number] = [cx + outX * ob + (outX === 0 ? half * 1.18 : 0), offY - 0.24, cz + outZ * ob + (outZ === 0 ? half * 1.18 : 0)];
  const qd: [number, number, number] = [cx + outX * ob - (outX === 0 ? half * 1.18 : 0), offY - 0.24, cz + outZ * ob - (outZ === 0 ? half * 1.18 : 0)];
  bucket.hint = 0.9;
  flatQuad(bucket, [qa, qb, qc, qd], cx, offY, cz);
  // Spreading foot.
  bucket.hint = 0.30;
  addBox(
    bucket,
    cx + outX * (0.5 + lowProud * 0.62), baseY + 0.18, cz + outZ * (0.5 + lowProud * 0.62),
    outX === 0 ? half * 1.34 : lowProud * 0.62 + 0.03, 0.18,
    outX === 0 ? lowProud * 0.62 + 0.03 : half * 1.34,
    0,
  );
  // Weathered sloping cap, cut as a wedge so the top sheds water toward the wall.
  bucket.hint = 0.9;
  const capY = topY - 0.10;
  const o = 0.5 + proud;
  const a: [number, number, number] = [cx + outX * o - (outX === 0 ? half : 0), capY, cz + outZ * o - (outZ === 0 ? half : 0)];
  const b: [number, number, number] = [cx + outX * o + (outX === 0 ? half : 0), capY, cz + outZ * o + (outZ === 0 ? half : 0)];
  const c: [number, number, number] = [cx + outX * 0.5 + (outX === 0 ? half : 0), capY + 0.26, cz + outZ * 0.5 + (outZ === 0 ? half : 0)];
  const d: [number, number, number] = [cx + outX * 0.5 - (outX === 0 ? half : 0), capY + 0.26, cz + outZ * 0.5 - (outZ === 0 ? half : 0)];
  flatQuad(bucket, [a, b, c, d], cx, capY, cz);
  const e: [number, number, number] = [a[0], capY - 0.14, a[2]];
  const f: [number, number, number] = [b[0], capY - 0.14, b[2]];
  flatQuad(bucket, [e, f, b, a], cx, capY, cz);
  void seed;
  bucket.hint = -1;
}

/** A slatted crate. Plank gaps and a corner batten frame are what sell it. */
function addCrate(
  bucket: Bucket,
  cx: number, cy: number, cz: number,
  size: number,
  seed: number,
): void {
  const yaw = hash3(Math.round(cx * 8), Math.round(cz * 8), 11, seed) * 0.9 - 0.45;
  const h = size * (0.82 + hash3(Math.round(cx * 8), Math.round(cz * 8), 12, seed) * 0.3);
  bucket.hint = 0.7;
  addBox(bucket, cx, cy + h * 0.5, cz, size * 0.5, h * 0.5, size * 0.5, yaw);
  // Corner battens standing proud of the body.
  bucket.hint = 0.88;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const lx = sx * size * 0.5;
      const lz = sz * size * 0.5;
      addBox(
        bucket,
        cx + lx * c - lz * s,
        cy + h * 0.5,
        cz + lx * s + lz * c,
        0.028,
        h * 0.5,
        0.028,
        yaw,
      );
    }
  }
  // Lid rim.
  addBox(bucket, cx, cy + h + 0.018, cz, size * 0.52, 0.018, size * 0.52, yaw);
  bucket.hint = -1;
}

/** A hooped barrel. */
function addBarrel(
  bucket: Bucket,
  cx: number, cy: number, cz: number,
  radius: number,
  height: number,
  seed: number,
  hoopBucket: Bucket,
): void {
  const yaw = hash3(Math.round(cx * 8), Math.round(cz * 8), 13, seed) * 0.7;
  bucket.hint = 0.74;
  addPrism(bucket, cx, cz, cy, cy + height, radius * 0.86, radius * 0.86, 12, yaw, radius * 0.2, true, false);
  bucket.hint = -1;
  hoopBucket.hint = 0.86;
  for (const t of [0.16, 0.5, 0.86]) {
    const r = radius * (0.86 + Math.sin(t * Math.PI) * 0.2) + 0.012;
    addPrism(
      hoopBucket, cx, cz,
      cy + height * t - 0.024, cy + height * t + 0.024,
      r, r, 12, yaw, 0, false, false,
    );
  }
  hoopBucket.hint = -1;
}

/** A shrub: overlapping leaf lobes on a short woody stem. */
function addShrub(
  bucket: Bucket,
  woodBucket: Bucket,
  cx: number, cy: number, cz: number,
  scale: number,
  seed: number,
): void {
  woodBucket.hint = 0.42;
  addPrism(woodBucket, cx, cz, cy - 0.02, cy + scale * 0.30, scale * 0.055, scale * 0.038, 5, 0, 0, false);
  woodBucket.hint = -1;
  const lobes = 3 + Math.floor(hash3(Math.round(cx * 8), Math.round(cz * 8), 17, seed) * 3);
  for (let i = 0; i < lobes; i++) {
    const a = hash3(i, Math.round(cx * 8), Math.round(cz * 8), seed) * Math.PI * 2;
    const rad = scale * (0.10 + hash3(i * 3, 1, Math.round(cz * 8), seed) * 0.22);
    const lx = cx + Math.cos(a) * rad;
    const lz = cz + Math.sin(a) * rad;
    const ly = cy + scale * (0.28 + hash3(i * 5, 2, Math.round(cx * 8), seed) * 0.34);
    const r = scale * (0.20 + hash3(i * 7, 3, i, seed) * 0.14);
    bucket.hint = 0.5 + Math.min(0.42, (ly - cy) * 0.9);
    addBlob(bucket, lx, ly, lz, r * 1.15, r * 0.86, r * 1.15, seed + i * 97, 0.36, 7, 4);
  }
  bucket.hint = -1;
}

/** Tufts of tall grass / reeds: crossed blade quads, cheap and readable. */
function addTuft(
  bucket: Bucket,
  cx: number, cy: number, cz: number,
  scale: number,
  seed: number,
): void {
  const blades = 3;
  bucket.hint = 0.66;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI + hash3(i, Math.round(cx * 8), Math.round(cz * 8), seed) * 0.9;
    const w = scale * 0.16;
    const hgt = scale * (0.55 + hash3(i * 3, 1, Math.round(cz * 8), seed) * 0.55);
    const lean = scale * 0.16 * (hash3(i * 5, 2, 0, seed) - 0.5);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const px = -dz;
    const pz = dx;
    const a0: [number, number, number] = [cx - px * w, cy, cz - pz * w];
    const b0: [number, number, number] = [cx + px * w, cy, cz + pz * w];
    const tip: [number, number, number] = [cx + dx * lean, cy + hgt, cz + dz * lean];
    const mid0: [number, number, number] = [cx - px * w * 0.45 + dx * lean * 0.5, cy + hgt * 0.6, cz - pz * w * 0.45 + dz * lean * 0.5];
    const mid1: [number, number, number] = [cx + px * w * 0.45 + dx * lean * 0.5, cy + hgt * 0.6, cz + pz * w * 0.45 + dz * lean * 0.5];
    // A blade is a plane, so it has to be emitted from both sides or it vanishes
    // whenever the camera yaws past it.
    const face = (nsx: number, nsz: number): void => {
      const q = (
        p0: [number, number, number],
        p1: [number, number, number],
        p2: [number, number, number],
      ): void => {
        bucket.addTri(
          v(p0[0], p0[1], p0[2], nsx, 0.18, nsz),
          v(p1[0], p1[1], p1[2], nsx, 0.18, nsz),
          v(p2[0], p2[1], p2[2], nsx, 0.18, nsz),
        );
      };
      q(a0, b0, mid1);
      q(a0, mid1, mid0);
      q(mid0, mid1, tip);
    };
    face(px, pz);
    face(-px, -pz);
  }
  bucket.hint = -1;
}

/** Scattered broken masonry. */
function addRubblePile(
  bucket: Bucket,
  cx: number, cy: number, cz: number,
  scale: number,
  seed: number,
): void {
  const n = 2 + Math.floor(hash3(Math.round(cx * 8), Math.round(cz * 8), 19, seed) * 3);
  for (let i = 0; i < n; i++) {
    const a = hash3(i, Math.round(cx * 8), 5, seed) * Math.PI * 2;
    const rad = scale * hash3(i * 3, 1, Math.round(cz * 8), seed) * 0.5;
    const r = scale * (0.10 + hash3(i * 11, 2, i, seed) * 0.13);
    bucket.hint = 0.46 + i * 0.06;
    addBlob(
      bucket,
      cx + Math.cos(a) * rad,
      cy + r * 0.55,
      cz + Math.sin(a) * rad,
      r * 1.25, r * 0.75, r * 1.1,
      seed + i * 131,
      0.44,
      6, 4,
    );
  }
  bucket.hint = -1;
}

/**
 * A standing brazier: splayed iron legs, a stone bowl, and a bed of coals. The coals
 * go into a dedicated emissive mesh and get a real point light, because a fire that
 * glows but does not illuminate its surroundings is on the fail list.
 */
interface BrazierResult {
  x: number;
  y: number;
  z: number;
}

function addBrazier(
  stone: Bucket,
  iron: Bucket,
  ember: Bucket,
  cx: number, cy: number, cz: number,
  seed: number,
): BrazierResult {
  const legH = 0.34;
  iron.hint = 0.5;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const dx = Math.cos(a) * 0.13;
    const dz = Math.sin(a) * 0.13;
    // Splayed leg: a thin box leaning outward.
    const mx = cx + dx * 0.5;
    const mz = cz + dz * 0.5;
    flatQuad(
      iron,
      [
        [cx + dx, cy, cz + dz],
        [cx + dx + dz * 0.12, cy, cz + dz - dx * 0.12],
        [cx + dx * 0.18 + dz * 0.1, cy + legH, cz + dz * 0.18 - dx * 0.1],
        [cx + dx * 0.18, cy + legH, cz + dz * 0.18],
      ],
      mx, cy + legH * 0.5, mz,
    );
    addPrism(iron, cx + dx * 0.55, cz + dz * 0.55, cy, cy + legH, 0.026, 0.022, 4, a, 0, false);
  }
  iron.hint = 0.72;
  addPrism(iron, cx, cz, cy + legH, cy + legH + 0.05, 0.15, 0.19, 10, 0, 0, false);
  stone.hint = 0.8;
  addPrism(stone, cx, cz, cy + legH + 0.05, cy + legH + 0.24, 0.19, 0.28, 10, 0, 0, false);
  addPrism(stone, cx, cz, cy + legH + 0.24, cy + legH + 0.28, 0.28, 0.27, 10, 0, 0, false);
  stone.hint = -1;
  iron.hint = -1;
  // Coals.
  const bowlY = cy + legH + 0.20;
  ember.hint = 1;
  for (let i = 0; i < 5; i++) {
    const a = hash3(i, Math.round(cx * 8), Math.round(cz * 8), seed) * Math.PI * 2;
    const rad = hash3(i * 3, 1, 0, seed) * 0.15;
    addBlob(
      ember,
      cx + Math.cos(a) * rad,
      bowlY + 0.02 + hash3(i * 5, 2, 0, seed) * 0.05,
      cz + Math.sin(a) * rad,
      0.075, 0.05, 0.075,
      seed + i * 73,
      0.4,
      6, 3,
    );
  }
  ember.hint = -1;
  return { x: cx, y: bowlY + 0.08, z: cz };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prop placement
// ─────────────────────────────────────────────────────────────────────────────

interface ColumnSpec {
  tx: number;
  ty: number;
  /** Height (half-tiles) the surrounding floor sits at — where the plinth lands. */
  baseHalf: number;
  topHalf: number;
}

const PROP_SEED = 0x5eed1e;

function idx(width: number, x: number, y: number): number {
  return y * width + x;
}

function tileAtIn(
  tiles: Array<Tile | undefined>,
  width: number,
  height: number,
  x: number,
  y: number,
): Tile | undefined {
  if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
  const t = tiles[idx(width, x, y)];
  return t && t.surface !== 'void' ? t : undefined;
}

const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Surface Y at the centre of a tile, including the natural-ground relief. */
function centreY(t: Tile): number {
  return (
    (t.height + slopeOffsetHalf(t.slope, 0.5, 0.5)) * HEIGHT_UNIT +
    groundRelief(t.surface, t.x * TILE_SIZE, t.y * TILE_SIZE)
  );
}

/**
 * Free-standing pillars: impassable tiles that stand well above everything around them
 * and are not part of a run of wall. These stop being cubes and become real columns.
 */
function findColumns(
  tiles: Array<Tile | undefined>,
  width: number,
  height: number,
): ColumnSpec[] {
  const out: ColumnSpec[] = [];
  const tall = (x: number, y: number, ref: number): boolean => {
    const t = tileAtIn(tiles, width, height, x, y);
    return !!t && !t.passable && t.height >= ref - 1;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = tileAtIn(tiles, width, height, x, y);
      if (!t || t.passable) continue;
      if (!BUILT.has(t.surface)) continue;

      let neighbourRun = 0;
      let base = -Infinity;
      let lower = 0;
      for (const [dx, dy] of ORTHO) {
        if (tall(x + dx, y + dy, t.height)) neighbourRun++;
        const n = tileAtIn(tiles, width, height, x + dx, y + dy);
        if (n && n.height < t.height) {
          lower++;
          base = Math.max(base, n.height);
        }
      }
      // Part of a wall, or not actually raised: leave it as terrain.
      if (neighbourRun >= 2 || lower < 3) continue;
      if (!Number.isFinite(base) || t.height - base < 3) continue;
      out.push({ tx: x, ty: y, baseHalf: base, topHalf: t.height });
    }
  }
  return out;
}

interface PropPlacement {
  braziers: BrazierResult[];
}

/**
 * Populate the map. Everything is driven off the `Battlefield` itself — the edge a
 * balustrade guards is a real drop, a crate leans against a real wall, foliage grows
 * on the tiles that are actually soil — so a new map is furnished without any extra
 * authoring, and always the same way.
 */
function populateProps(
  tiles: Array<Tile | undefined>,
  width: number,
  height: number,
  columns: readonly ColumnSpec[],
  pedestalBaseY: number,
  bucketFor: (k: TerrainMaterialKind) => Bucket,
  ember: Bucket,
): PropPlacement {
  const stone = bucketFor('stonewall');
  const pillar = bucketFor('pillar');
  const timber = bucketFor('timber');
  const foliage = bucketFor('foliage');
  const metal = bucketFor('metal');
  const cloth = bucketFor('cloth');
  const rubble = bucketFor('rubble');
  const braziers: BrazierResult[] = [];

  const rnd = (x: number, y: number, salt: number): number =>
    hash3(x, y, salt, PROP_SEED);

  // ── columns ─────────────────────────────────────────────────────────────
  for (const c of columns) {
    addColumn(
      stone,
      pillar,
      c.tx * TILE_SIZE,
      c.ty * TILE_SIZE,
      c.baseHalf * HEIGHT_UNIT,
      c.topHalf * HEIGHT_UNIT,
      0.35,
      PROP_SEED ^ (c.tx * 31 + c.ty),
    );
  }
  const columnSet = new Set(columns.map((c) => idx(width, c.tx, c.ty)));

  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const t = tileAtIn(tiles, width, height, tx, ty);
      if (!t) continue;
      const here = idx(width, tx, ty);
      if (columnSet.has(here)) continue;
      const ox = tx * TILE_SIZE;
      const oz = ty * TILE_SIZE;
      const built = BUILT.has(t.surface);
      const y = centreY(t);

      // ── edge treatments ───────────────────────────────────────────────
      for (const [dx, dy] of ORTHO) {
        const n = tileAtIn(tiles, width, height, tx + dx, ty + dy);
        const offMap =
          tx + dx < 0 || ty + dy < 0 || tx + dx >= width || ty + dy >= height || !n;
        const drop = n ? t.height - n.height : Infinity;
        // Half-edge endpoints, pulled in slightly so runs from adjacent tiles meet.
        const ex = dx === 0 ? 0 : dx * 0.5;
        const ez = dy === 0 ? 0 : dy * 0.5;
        const ax = ox + ex + (dx === 0 ? -0.5 : 0);
        const az = oz + ez + (dy === 0 ? -0.5 : 0);
        const bx = ox + ex + (dx === 0 ? 0.5 : 0);
        const bz = oz + ez + (dy === 0 ? 0.5 : 0);

        if (!t.passable) {
          // Coping course along the exposed top edge of a wall or plinth.
          if ((offMap || drop >= 2) && built) {
            stone.hint = 0.9;
            const mx = (ax + bx) / 2 + dx * 0.045;
            const mz = (az + bz) / 2 + dy * 0.045;
            const len = Math.hypot(bx - ax, bz - az);
            addBox(
              stone,
              mx,
              y + 0.055,
              mz,
              dx === 0 ? len / 2 + 0.05 : 0.075,
              0.055,
              dx === 0 ? 0.075 : len / 2 + 0.05,
            );
            stone.hint = -1;
          }
          continue;
        }

        if (t.slope !== 'flat') continue;
        if (n && n.slope !== 'flat') continue;

        if (offMap) {
          if (built) {
            addParapet(stone, ax, az, bx, bz, y, dx, dy, PROP_SEED ^ (tx * 7 + ty * 13 + dx));
            // A string course two thirds of the way down, and a buttress every third
            // bay. Both are what stop the pedestal reading as one extruded prism.
            const drop = y - pedestalBaseY;
            if (drop > 1.2) {
              stone.hint = 0.62;
              const bandY = y - drop * 0.55;
              const mxb = (ax + bx) / 2 + dx * 0.53;
              const mzb = (az + bz) / 2 + dy * 0.53;
              addBox(
                stone, mxb, bandY, mzb,
                dx === 0 ? 0.5 : 0.085, 0.10, dx === 0 ? 0.085 : 0.5,
              );
              stone.hint = -1;
              if ((tx * 3 + ty * 5 + dx + dy) % 3 === 0) {
                addButtress(
                  stone, ox, oz, y, pedestalBaseY, dx, dy,
                  PROP_SEED ^ (tx * 23 + ty * 41 + dx),
                );
              }
            }
          } else if (rnd(tx, ty, dx * 3 + dy * 5 + 40) > 0.55) {
            // A rustic post-and-rail fence at the rim of natural ground.
            addBalustrade(timber, ax, az, bx, bz, y, PROP_SEED ^ (tx * 17 + ty * 5 + dy));
          }
          continue;
        }
        if (drop >= 3) {
          const seed = PROP_SEED ^ (tx * 11 + ty * 3 + dx);
          if (built) addBalustrade(stone, ax, az, bx, bz, y, seed);
          else if (rnd(tx, ty, dx * 3 + dy * 7 + 50) > 0.45) {
            addBalustrade(timber, ax, az, bx, bz, y, seed);
          }
        }
      }

      if (!t.passable) {
        // A finial urn on a free-standing plinth.
        let lower = 0;
        for (const [dx, dy] of ORTHO) {
          const n = tileAtIn(tiles, width, height, tx + dx, ty + dy);
          if (!n || n.height < t.height - 1) lower++;
        }
        if (lower >= 2 && built && rnd(tx, ty, 61) > 0.15) {
          stone.hint = 0.72;
          addPrism(stone, ox, oz, y + 0.09, y + 0.20, 0.20, 0.14, 10, 0, 0, false);
          addPrism(stone, ox, oz, y + 0.20, y + 0.46, 0.14, 0.19, 10, 0, 0.06, false);
          addPrism(stone, ox, oz, y + 0.46, y + 0.54, 0.21, 0.17, 10, 0, 0, true);
          stone.hint = -1;
          // Something growing out of it.
          if (rnd(tx, ty, 62) > 0.35) {
            addShrub(foliage, timber, ox, y + 0.52, oz, 0.75, PROP_SEED ^ (tx * 29 + ty));
          }
        }
        // Hanging banner on a tall wall face that overlooks lower ground.
        for (const [dx, dy] of ORTHO) {
          const n = tileAtIn(tiles, width, height, tx + dx, ty + dy);
          if (!n || t.height - n.height < 3) continue;
          if (rnd(tx, ty, dx * 9 + dy * 4 + 70) < 0.80) continue;
          const bx = ox + dx * 0.52;
          const bz = oz + dy * 0.52;
          metal.hint = 0.9;
          addBox(
            metal,
            bx, y - 0.10, bz,
            dx === 0 ? 0.34 : 0.028, 0.028, dx === 0 ? 0.028 : 0.34,
          );
          metal.hint = -1;
          cloth.hint = 0.86;
          addBannerCloth(
            cloth, bx, y - 0.14, bz, dx, dy, 0.58, 1.15,
            PROP_SEED ^ (tx * 53 + ty * 7 + dx),
          );
          cloth.hint = -1;
        }
        continue;
      }

      // ── things standing on walkable ground ────────────────────────────
      // Props are pushed out to a tile corner so the centre, where a unit stands,
      // stays clear.
      const cornerA = rnd(tx, ty, 101);
      const cq = Math.floor(cornerA * 4);
      const qx = cq === 0 || cq === 3 ? -1 : 1;
      const qz = cq < 2 ? -1 : 1;
      const px = ox + qx * (0.24 + rnd(tx, ty, 102) * 0.14);
      const pz = oz + qz * (0.24 + rnd(tx, ty, 103) * 0.14);

      // Is this tile up against something solid? Crates lean on walls.
      let againstWall = false;
      for (const [dx, dy] of ORTHO) {
        const n = tileAtIn(tiles, width, height, tx + dx, ty + dy);
        if (!n || n.height >= t.height + 2) againstWall = true;
      }

      const roll = rnd(tx, ty, 200);

      if (built) {
        if (againstWall && roll > 0.86) {
          const hoops = metal;
          if (rnd(tx, ty, 201) > 0.5) {
            addCrate(timber, px, y, pz, 0.30 + rnd(tx, ty, 202) * 0.10, PROP_SEED ^ here);
            if (rnd(tx, ty, 203) > 0.55) {
              addCrate(timber, px + 0.16, y + 0.30, pz - 0.10, 0.22, PROP_SEED ^ (here * 3));
            }
          } else {
            addBarrel(timber, px, y, pz, 0.19, 0.42, PROP_SEED ^ here, hoops);
          }
        } else if (againstWall && roll > 0.80) {
          addRubblePile(rubble, px, y, pz, 0.5, PROP_SEED ^ (here * 7));
        } else if (roll > 0.965) {
          braziers.push(
            addBrazier(stone, metal, ember, ox, y, oz, PROP_SEED ^ (here * 13)),
          );
        } else if (againstWall && roll > 0.70) {
          addShrub(foliage, timber, px, y, pz, 0.62, PROP_SEED ^ (here * 11));
        }
      } else if (t.surface === 'grass' || t.surface === 'dirt' || t.surface === 'swamp') {
        if (roll > 0.80) {
          addShrub(foliage, timber, px, y, pz, 0.72 + rnd(tx, ty, 204) * 0.4, PROP_SEED ^ here);
        } else if (roll > 0.50) {
          addTuft(foliage, px, y - 0.02, pz, 0.42 + rnd(tx, ty, 205) * 0.34, PROP_SEED ^ here);
          if (rnd(tx, ty, 206) > 0.6) {
            addTuft(
              foliage,
              ox - qx * 0.26, y - 0.02, oz - qz * 0.18,
              0.34, PROP_SEED ^ (here * 5),
            );
          }
        } else if (roll > 0.38) {
          addRubblePile(rubble, px, y, pz, 0.42, PROP_SEED ^ (here * 3));
        }
      } else if (t.surface === 'sand' || t.surface === 'snow') {
        if (roll > 0.88) addRubblePile(rubble, px, y, pz, 0.46, PROP_SEED ^ here);
      }

      // Reeds crowd the waterline.
      for (const [dx, dy] of ORTHO) {
        const n = tileAtIn(tiles, width, height, tx + dx, ty + dy);
        if (!n || !isWaterSurface(n.surface)) continue;
        if (rnd(tx, ty, dx * 6 + dy * 2 + 300) < 0.45) continue;
        addTuft(
          foliage,
          ox + dx * 0.42 + (rnd(tx, ty, 301) - 0.5) * 0.3,
          y - 0.03,
          oz + dy * 0.42 + (rnd(tx, ty, 302) - 0.5) * 0.3,
          0.62,
          PROP_SEED ^ (here * 17 + dx),
        );
      }
    }
  }

  return { braziers };
}

export function buildTerrain(field: Battlefield, opts: TerrainOptions = {}): Terrain {
  const { width, height } = field;
  const srcTiles: Array<Tile | undefined> = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) srcTiles[y * width + x] = field.tileAt(x, y);
  }
  // AO marches against the *real* column field, so a pillar still occludes its
  // surroundings even though its box is replaced by turned stone.
  const column = new ColumnField(width, height, srcTiles);

  // Free-standing pillars stop being extruded cubes: the box is clipped back to the
  // surrounding floor level and a real column is built on top of it.
  const columnSpecs = findColumns(srcTiles, width, height);
  const tiles: Array<Tile | undefined> = srcTiles.slice();
  for (const c of columnSpecs) {
    const t = srcTiles[c.ty * width + c.tx];
    if (!t) continue;
    tiles[c.ty * width + c.tx] = { ...t, height: c.baseHalf, slope: 'flat' };
  }

  const buckets = new Map<TerrainMaterialKind, Bucket>();
  const bucketFor = (k: TerrainMaterialKind): Bucket => {
    let b = buckets.get(k);
    if (!b) {
      b = new Bucket();
      buckets.set(k, b);
    }
    return b;
  };

  // Overlay geometry accumulators (built alongside the solid geometry).
  const hlPos: number[] = [];
  const hlNrm: number[] = [];
  const hlTile: number[] = [];
  const hlLocal: number[] = [];
  const hlIdx: number[] = [];

  // Water surface accumulators.
  const wPos: number[] = [];
  const wNrm: number[] = [];
  const wUv: number[] = [];
  const wDepth: number[] = [];
  const wShore: number[] = [];
  const wIdx: number[] = [];

  const S = TOP_SUBDIV;
  const C = CHAMFER;

  /**
   * Solid top surface Y of a tile at local (u, v).
   *
   * `tx`/`ty` are needed because natural ground carries a world-space relief term —
   * two neighbouring lawn tiles must agree exactly along their shared edge, so the
   * offset has to be evaluated at the world position, not per tile.
   */
  const solidTopY = (t: Tile, tx: number, ty: number, u: number, vv: number): number => {
    const half =
      solidTopHalf(t) + slopeOffsetHalf(isWaterSurface(t.surface) ? 'flat' : t.slope, u, vv);
    const relief = isWaterSurface(t.surface)
      ? 0
      : groundRelief(t.surface, (tx + u - 0.5) * TILE_SIZE, (ty + vv - 0.5) * TILE_SIZE);
    return half * HEIGHT_UNIT + relief;
  };

  /**
   * How much of a chamfer an edge gets, 0..1.
   *
   * A chamfer on *every* tile edge is the single loudest "this is a grid of cubes"
   * signal there is: a continuous paved floor ends up with a dark groove ruled across
   * it every metre. Real paving has no such thing. So the chamfer is emitted only
   * where the edge is a genuine lip — the neighbour is missing, lower, higher, or a
   * different material — and suppressed entirely where two tiles of the same surface
   * meet flush. The flagstone texture then carries across the join, which is exactly
   * what FFT's hand-painted terrain does.
   */
  const edgeChamfer = new Float32Array(width * height * 4);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const t = tiles[ty * width + tx];
      const base = (ty * width + tx) * 4;
      if (!t || t.surface === 'void') {
        edgeChamfer[base] = 1;
        edgeChamfer[base + 1] = 1;
        edgeChamfer[base + 2] = 1;
        edgeChamfer[base + 3] = 1;
        continue;
      }
      for (let e = 0; e < 4; e++) {
        const spec = EDGES[e]!;
        const nx2 = tx + spec.dx;
        const ny2 = ty + spec.dy;
        const nb =
          nx2 < 0 || ny2 < 0 || nx2 >= width || ny2 >= height
            ? undefined
            : tiles[ny2 * width + nx2];
        if (!nb || nb.surface === 'void') {
          edgeChamfer[base + e] = 1;
          continue;
        }
        // Compare the surfaces at both ends of the shared edge, not just the centre:
        // a ramp meeting a flat tile matches at one end and not the other.
        let maxDiff = 0;
        for (const p of [0, 0.5, 1]) {
          const u = spec.u0 + (spec.u1 - spec.u0) * p;
          const vv = spec.v0 + (spec.v1 - spec.v0) * p;
          const mu = spec.mu0 + (spec.mu1 - spec.mu0) * p;
          const mv = spec.mv0 + (spec.mv1 - spec.mv0) * p;
          maxDiff = Math.max(
            maxDiff,
            Math.abs(solidTopY(t, tx, ty, u, vv) - solidTopY(nb, nx2, ny2, mu, mv)),
          );
        }
        if (maxDiff > 0.02) {
          edgeChamfer[base + e] = 1;
        } else if (bucketKindFor(nb) !== bucketKindFor(t)) {
          // Flush but a different material: keep a shallow lip so the join reads as
          // a deliberate transition rather than a texture change mid-slab.
          edgeChamfer[base + e] = 0.5;
        } else {
          edgeChamfer[base + e] = 0;
        }
      }
    }
  }

  const chamferAt = (tx: number, ty: number, e: number): number => {
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return 1;
    return edgeChamfer[(ty * width + tx) * 4 + e]!;
  };

  /** Chamfer factor at an arbitrary point on a tile's perimeter. */
  const chamferAtPerim = (tx: number, ty: number, pu: number, pv: number): number => {
    let f = 0;
    if (pv <= 1e-6) f = Math.max(f, chamferAt(tx, ty, 0));
    if (pu >= 1 - 1e-6) f = Math.max(f, chamferAt(tx, ty, 1));
    if (pv >= 1 - 1e-6) f = Math.max(f, chamferAt(tx, ty, 2));
    if (pu <= 1e-6) f = Math.max(f, chamferAt(tx, ty, 3));
    return f;
  };

  /** Outer chamfer-ring Y at a tile's perimeter param. */
  const ringY = (t: Tile, tx: number, ty: number, u: number, vv: number): number =>
    solidTopY(t, tx, ty, u, vv) - CHAMFER_DROP * chamferAtPerim(tx, ty, u, vv);

  /** Ring Y along one specific edge, used by the side-face stitcher. */
  const ringYEdge = (
    t: Tile,
    tx: number,
    ty: number,
    e: number,
    u: number,
    vv: number,
  ): number => solidTopY(t, tx, ty, u, vv) - CHAMFER_DROP * chamferAt(tx, ty, e);

  const normalAt = (t: Tile, u: number, vv: number): [number, number, number] => {
    const slope = isWaterSurface(t.surface) ? 'flat' : t.slope;
    const [du, dv] = slopeDerivativeHalf(slope, u, vv);
    const nx = -du * HEIGHT_UNIT;
    const nz = -dv * HEIGHT_UNIT;
    const len = Math.hypot(nx, 1, nz);
    return [nx / len, 1 / len, nz / len];
  };

  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const tile = tiles[ty * width + tx];
      if (!tile || tile.surface === 'void') continue;

      const kind = bucketKindFor(tile);
      const bucket = bucketFor(kind);
      const naturalRock = isNaturalRock(tiles, width, height, tx, ty, kind);
      const sideKind = sideKindFor(kind);
      const ox = tx * TILE_SIZE;
      const oz = ty * TILE_SIZE;

      // ── top face (inset by the chamfer) ─────────────────────────────────
      const inner = (p: number): number => C + (1 - 2 * C) * p;
      const grid: Vtx[][] = [];
      for (let j = 0; j <= S; j++) {
        const row: Vtx[] = [];
        const vv = inner(j / S);
        for (let i = 0; i <= S; i++) {
          const u = inner(i / S);
          const n = normalAt(tile, u, vv);
          row.push(
            v(
              ox + (u - 0.5) * TILE_SIZE,
              solidTopY(tile, tx, ty, u, vv),
              oz + (vv - 0.5) * TILE_SIZE,
              n[0],
              n[1],
              n[2],
            ),
          );
        }
        grid.push(row);
      }
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          bucket.addQuad(grid[j]![i]!, grid[j]![i + 1]!, grid[j + 1]![i + 1]!, grid[j + 1]![i]!);
        }
      }

      // ── chamfer ring ────────────────────────────────────────────────────
      // Walk the perimeter of the grid once; each step emits a quad joining the inset
      // top edge to the full-width outer edge one CHAMFER_DROP below.
      const perim: Array<[number, number]> = [];
      for (let i = 0; i <= S; i++) perim.push([i / S, 0]);
      for (let j = 1; j <= S; j++) perim.push([1, j / S]);
      for (let i = S - 1; i >= 0; i--) perim.push([i / S, 1]);
      for (let j = S - 1; j >= 1; j--) perim.push([0, j / S]);
      perim.push([0, 0]);

      for (let k = 0; k < perim.length - 1; k++) {
        const [pu0, pv0] = perim[k]!;
        const [pu1, pv1] = perim[k + 1]!;
        const iu0 = inner(pu0);
        const iv0 = inner(pv0);
        const iu1 = inner(pu1);
        const iv1 = inner(pv1);

        // Outward-and-up normal for the chamfer facet, faded out where the edge is
        // flush with its neighbour so the strip stays coplanar with the top face.
        const cf = Math.max(
          chamferAtPerim(tx, ty, pu0, pv0),
          chamferAtPerim(tx, ty, pu1, pv1),
        );
        const eux = (pu1 - pu0) * TILE_SIZE;
        const euz = (pv1 - pv0) * TILE_SIZE;
        let cnx = -euz;
        let cnz = eux;
        const cl = Math.hypot(cnx, cnz) || 1;
        cnx = (cnx / cl) * 0.72 * cf;
        cnz = (cnz / cl) * 0.72 * cf;
        const surf = normalAt(tile, (pu0 + pu1) / 2, (pv0 + pv1) / 2);
        const bnx = cnx + surf[0] * (0.7 + 0.3 * (1 - cf));
        const bny = (0.7 + 0.3 * (1 - cf)) * surf[1];
        const bnz = cnz + surf[2] * (0.7 + 0.3 * (1 - cf));
        const bl = Math.hypot(bnx, bny, bnz) || 1;

        const a = v(
          ox + (iu0 - 0.5) * TILE_SIZE,
          solidTopY(tile, tx, ty, iu0, iv0),
          oz + (iv0 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        const b = v(
          ox + (iu1 - 0.5) * TILE_SIZE,
          solidTopY(tile, tx, ty, iu1, iv1),
          oz + (iv1 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        const c = v(
          ox + (pu1 - 0.5) * TILE_SIZE,
          ringY(tile, tx, ty, pu1, pv1),
          oz + (pv1 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        const d = v(
          ox + (pu0 - 0.5) * TILE_SIZE,
          ringY(tile, tx, ty, pu0, pv0),
          oz + (pv0 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        bucket.addQuad(a, b, c, d);
      }

      // ── side faces ──────────────────────────────────────────────────────
      for (let ei = 0; ei < EDGES.length; ei++) {
        const e = EDGES[ei]!;
        const nb = tiles[(ty + e.dy) * width + (tx + e.dx)];
        const nbSolid = nb && nb.surface !== 'void' && tx + e.dx >= 0 && tx + e.dx < width
          && ty + e.dy >= 0 && ty + e.dy < height;

        // Sample the drop across the edge.
        const tops: number[] = [];
        const bottoms: number[] = [];
        // A water tile's solid top is its bed, which would leave the water sheet
        // overhanging a void wherever the tile sits on the map boundary. Raise the
        // exposed face to the waterline so the bank closes the section.
        const exposedWater = isWaterSurface(tile.surface) && !nbSolid;
        for (let i = 0; i <= S; i++) {
          const p = i / S;
          const u = e.u0 + (e.u1 - e.u0) * p;
          const vv = e.v0 + (e.v1 - e.v0) * p;
          tops.push(
            exposedWater
              ? tile.height * HEIGHT_UNIT - CHAMFER_DROP
              : ringYEdge(tile, tx, ty, ei, u, vv),
          );
          if (nbSolid && nb) {
            const mu = e.mu0 + (e.mu1 - e.mu0) * p;
            const mv = e.mv0 + (e.mv1 - e.mv0) * p;
            bottoms.push(ringYEdge(nb, tx + e.dx, ty + e.dy, (ei + 2) % 4, mu, mv));
          } else {
            // Down to the diorama's underside — or past it, where this column's own
            // silt bed cuts deeper than the base, so the section never opens a hole.
            bottoms.push(column.bottomAt(tx, ty));
          }
        }
        let maxDrop = 0;
        for (let i = 0; i <= S; i++) maxDrop = Math.max(maxDrop, tops[i]! - bottoms[i]!);
        if (maxDrop <= 0.006) continue;

        const isCliff = maxDrop >= CLIFF_MIN_DROP && naturalRock;
        // The outer skirt is the diorama's pedestal, not a landscape cliff: it gets the
        // rock material and gentle relief, but no shards and no heavy displacement.
        const isPedestal = !nbSolid;
        const target = bucketFor(isCliff ? 'cliff' : sideKind);
        const rows = isCliff ? Math.min(8, Math.max(3, Math.round(maxDrop / 0.55))) : 1;
        const cols = S;

        // Rocky displacement, tapered to zero at every shared border so neighbouring
        // faces stay watertight.
        const displace = (
          wx: number,
          wy: number,
          wz: number,
          p: number,
          q: number,
        ): [number, number, number] => {
          if (!isCliff) return [wx, wy, wz];
          const taper =
            Math.min(1, p * 5) * Math.min(1, (1 - p) * 5) * Math.min(1, q * 4.5);
          const n1 = fbm3(wx * 0.62, wy * 0.48, wz * 0.62, 17, 3) - 0.5;
          const n2 = fbm3(wx * 1.9, wy * 1.4, wz * 1.9, 29, 3) - 0.5;
          const scale = isPedestal ? 0.4 : 1;
          const amt = (n1 * 0.32 + n2 * 0.1) * taper * scale;
          return [wx + e.nx * amt, wy + n2 * 0.09 * taper * scale, wz + e.nz * amt];
        };

        const pts: Vtx[][] = [];
        for (let r = 0; r <= rows; r++) {
          const q = r / rows; // 0 at top, 1 at bottom
          const row: Vtx[] = [];
          for (let i = 0; i <= cols; i++) {
            const p = i / cols;
            const u = e.u0 + (e.u1 - e.u0) * p;
            const vv = e.v0 + (e.v1 - e.v0) * p;
            const ti = p * S;
            const i0 = Math.min(S, Math.floor(ti));
            const i1 = Math.min(S, i0 + 1);
            const ft = ti - i0;
            const tY = tops[i0]! + (tops[i1]! - tops[i0]!) * ft;
            const bY = Math.min(bottoms[i0]! + (bottoms[i1]! - bottoms[i0]!) * ft, tY);
            const y = tY + (bY - tY) * q;
            const wx = ox + (u - 0.5) * TILE_SIZE;
            const wz = oz + (vv - 0.5) * TILE_SIZE;
            const [dx, dy, dz] = displace(wx, y, wz, p, q);
            row.push(v(dx, dy, dz, e.nx, 0, e.nz));
          }
          pts.push(row);
        }

        // Recompute smooth normals for cliff walls so the displacement actually shades.
        if (isCliff) {
          for (let r = 0; r <= rows; r++) {
            for (let i = 0; i <= cols; i++) {
              const cur = pts[r]![i]!;
              const left = pts[r]![Math.max(0, i - 1)]!;
              const right = pts[r]![Math.min(cols, i + 1)]!;
              const up = pts[Math.max(0, r - 1)]![i]!;
              const down = pts[Math.min(rows, r + 1)]![i]!;
              const t1 = new THREE.Vector3(right.x - left.x, right.y - left.y, right.z - left.z);
              const t2 = new THREE.Vector3(down.x - up.x, down.y - up.y, down.z - up.z);
              const n = new THREE.Vector3().crossVectors(t2, t1);
              if (n.lengthSq() < 1e-10) n.set(e.nx, 0, e.nz);
              n.normalize();
              if (n.x * e.nx + n.z * e.nz < 0) n.negate();
              cur.nx = n.x;
              cur.ny = n.y;
              cur.nz = n.z;
            }
          }
        }

        for (let r = 0; r < rows; r++) {
          for (let i = 0; i < cols; i++) {
            const a = pts[r]![i]!;
            const b = pts[r]![i + 1]!;
            const c = pts[r + 1]![i + 1]!;
            const d = pts[r + 1]![i]!;
            if (
              Math.abs(a.y - d.y) < 1e-5 &&
              Math.abs(b.y - c.y) < 1e-5 &&
              Math.abs(a.y - b.y) < 1e-5
            ) {
              continue; // degenerate strip
            }
            target.addQuad(a, b, c, d);
          }
        }

        // Protruding shards break the cliff silhouette.
        if (isCliff && !isPedestal) {
          const shardCount = maxDrop > 3.2 ? 2 : maxDrop > 1.6 ? 1 : 0;
          for (let s = 0; s < shardCount; s++) {
            const seed = (tx * 73856093) ^ (ty * 19349663) ^ ((e.dx + 2) * 83492791) ^
              ((e.dy + 2) * 2654435761) ^ (s * 40503);
            const rp = hash3(tx, ty, s * 7 + e.dx * 3 + e.dy, seed);
            const rq = hash3(ty, tx, s * 11 + e.dy * 3 - e.dx, seed ^ 0x9e3779b9);
            const p = 0.18 + rp * 0.64;
            const q = 0.2 + rq * 0.6;
            const u = e.u0 + (e.u1 - e.u0) * p;
            const vv = e.v0 + (e.v1 - e.v0) * p;
            const ti = p * S;
            const i0 = Math.min(S, Math.floor(ti));
            const i1 = Math.min(S, i0 + 1);
            const ft = ti - i0;
            const tY = tops[i0]! + (tops[i1]! - tops[i0]!) * ft;
            const bY = Math.min(bottoms[i0]! + (bottoms[i1]! - bottoms[i0]!) * ft, tY);
            const y = tY + (bY - tY) * q;
            const wx = ox + (u - 0.5) * TILE_SIZE;
            const wz = oz + (vv - 0.5) * TILE_SIZE;
            addRockShard(
              bucketFor('cliff'),
              wx,
              y,
              wz,
              e.nx,
              e.nz,
              0.24 + hash3(tx + s, ty, s, seed) * 0.26,
              seed,
            );
          }
        }
      }

      // ── highlight overlay quad ──────────────────────────────────────────
      {
        const surfaceH = tile.height;
        const hy = (u: number, vv: number): number =>
          (surfaceH + slopeOffsetHalf(isWaterSurface(tile.surface) ? 'flat' : tile.slope, u, vv)) *
          HEIGHT_UNIT;
        const base = hlPos.length / 3;
        for (let j = 0; j <= S; j++) {
          const vv = inner(j / S);
          for (let i = 0; i <= S; i++) {
            const u = inner(i / S);
            const n = normalAt(tile, u, vv);
            hlPos.push(
              ox + (u - 0.5) * TILE_SIZE + n[0] * 0.022,
              hy(u, vv) + n[1] * 0.022,
              oz + (vv - 0.5) * TILE_SIZE + n[2] * 0.022,
            );
            hlNrm.push(n[0], n[1], n[2]);
            hlTile.push(tx, ty);
            hlLocal.push(i / S, j / S);
          }
        }
        for (let j = 0; j < S; j++) {
          for (let i = 0; i < S; i++) {
            const a = base + j * (S + 1) + i;
            const b = a + 1;
            const c = a + (S + 1) + 1;
            const d = a + (S + 1);
            hlIdx.push(a, c, b, a, d, c);
          }
        }
      }

      // ── water surface ───────────────────────────────────────────────────
      if (isWaterSurface(tile.surface)) {
        const surfaceY = tile.height * HEIGHT_UNIT;
        const W = 4; // finer grid: the vertex waves need it
        const base = wPos.length / 3;
        for (let j = 0; j <= W; j++) {
          for (let i = 0; i <= W; i++) {
            const u = i / W;
            const vv = j / W;
            const wx = ox + (u - 0.5) * TILE_SIZE;
            const wz = oz + (vv - 0.5) * TILE_SIZE;
            wPos.push(wx, surfaceY, wz);
            wNrm.push(0, 1, 0);
            wUv.push(wx, wz);
            wDepth.push(
              Math.max(0, surfaceY - smoothSolidTop(tiles, width, height, wx, wz, column.baseY)),
            );
            wShore.push(shoreDistance(tiles, width, height, wx, wz));
          }
        }
        for (let j = 0; j < W; j++) {
          for (let i = 0; i < W; i++) {
            const a = base + j * (W + 1) + i;
            const b = a + 1;
            const c = a + (W + 1) + 1;
            const d = a + (W + 1);
            wIdx.push(a, c, b, a, d, c);
          }
        }
      }
    }
  }

  // ── props ───────────────────────────────────────────────────────────────
  const emberBucket = new Bucket();
  const placement = populateProps(
    srcTiles, width, height, columnSpecs, column.baseY, bucketFor, emberBucket,
  );

  // ── assemble ────────────────────────────────────────────────────────────
  const highlightGeo = new THREE.BufferGeometry();
  highlightGeo.setAttribute('position', new THREE.Float32BufferAttribute(hlPos, 3));
  highlightGeo.setAttribute('normal', new THREE.Float32BufferAttribute(hlNrm, 3));
  highlightGeo.setAttribute('aTile', new THREE.Float32BufferAttribute(hlTile, 2));
  highlightGeo.setAttribute('aLocal', new THREE.Float32BufferAttribute(hlLocal, 2));
  highlightGeo.setIndex(hlIdx);
  highlightGeo.computeBoundingSphere();

  const highlights = new HighlightLayer(width, height, highlightGeo);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const t = tiles[ty * width + tx];
      if (t && t.surface !== 'void') highlights.markPresent(ty * width + tx);
    }
  }

  let waterMesh: THREE.Mesh | null = null;
  let waterMaterial: WaterMaterial | null = null;
  if (wIdx.length > 0) {
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    wgeo.setAttribute('normal', new THREE.Float32BufferAttribute(wNrm, 3));
    wgeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUv, 2));
    wgeo.setAttribute('aDepth', new THREE.Float32BufferAttribute(wDepth, 1));
    wgeo.setAttribute('aShore', new THREE.Float32BufferAttribute(wShore, 1));
    wgeo.setIndex(wIdx);
    wgeo.computeBoundingSphere();
    waterMaterial = createWaterMaterial(opts.water);
    waterMesh = new THREE.Mesh(wgeo, waterMaterial);
    waterMesh.name = 'water';
    waterMesh.renderOrder = 10;
    waterMesh.receiveShadow = false;
    waterMesh.castShadow = false;
  }

  const path = new PathRibbon();
  const terrain = new Terrain(field, highlights, path, waterMesh, waterMaterial);

  const solid = new THREE.Group();
  solid.name = 'terrain-solid';
  for (const [kind, bucket] of buckets) {
    if (bucket.empty) continue;
    const geo = opts.skipAO
      ? (() => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
          g.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.nrm, 3));
          g.setAttribute('uv', new THREE.Float32BufferAttribute(bakeUVs(bucket), 2));
          g.setAttribute(
            'aAO',
            new THREE.BufferAttribute(new Float32Array(bucket.pos.length / 3).fill(1), 1),
          );
          g.setIndex(bucket.idx);
          g.computeBoundingSphere();
          return g;
        })()
      : finishGeometry(bucket, column);
    const mesh = new THREE.Mesh(geo, createSurfaceMaterial(kind));
    mesh.name = `terrain-${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    solid.add(mesh);
    terrain.trackGeometry(geo);
  }

  // Glowing coals + the light they actually cast. A fire that does not illuminate its
  // surroundings is one of the named fail conditions, so every brazier carries a small
  // point light with an aggressive falloff.
  if (!emberBucket.empty) {
    const geo = finishGeometry(emberBucket, column);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a0a04,
      emissive: new THREE.Color(0xff6a1e),
      emissiveIntensity: 4.2,
      roughness: 0.85,
      metalness: 0,
    });
    mat.name = 'brazier-coals';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'brazier-coals';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    solid.add(mesh);
    terrain.trackGeometry(geo);
    terrain.trackMaterial(mat);
  }
  for (const b of placement.braziers.slice(0, 4)) {
    const light = new THREE.PointLight(0xff8a3c, 9, 5.2, 2);
    light.name = 'brazier-light';
    light.position.set(b.x, b.y + 0.12, b.z);
    light.castShadow = false;
    terrain.add(light);
  }

  terrain.add(solid);
  if (waterMesh) {
    terrain.add(waterMesh);
    terrain.trackGeometry(waterMesh.geometry);
  }
  terrain.add(highlights.mesh);
  terrain.add(path.mesh);
  return terrain;
}

/**
 * Bilinearly-sampled solid top height at an arbitrary world XZ. Used to give water a
 * continuous depth field instead of a per-tile staircase, which is what makes the
 * shallow-to-deep colour ramp read as a gradient rather than a checkerboard.
 */
function smoothSolidTop(
  tiles: Array<Tile | undefined>,
  width: number,
  height: number,
  wx: number,
  wz: number,
  openY: number,
): number {
  const fx = wx / TILE_SIZE;
  const fz = wz / TILE_SIZE;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tu = fx - x0;
  const tv = fz - z0;
  const sample = (x: number, z: number): number => {
    if (x < 0 || z < 0 || x >= width || z >= height) return openY;
    const t = tiles[z * width + x];
    if (!t || t.surface === 'void') return openY;
    return solidTopHalf(t) * HEIGHT_UNIT;
  };
  const a = sample(x0, z0);
  const b = sample(x0 + 1, z0);
  const c = sample(x0, z0 + 1);
  const d = sample(x0 + 1, z0 + 1);
  return (a + (b - a) * tu) + ((c + (d - c) * tu) - (a + (b - a) * tu)) * tv;
}

/** Distance in world units from a point to the nearest non-water tile. */
function shoreDistance(
  tiles: Array<Tile | undefined>,
  width: number,
  height: number,
  wx: number,
  wz: number,
): number {
  const cx = Math.round(wx / TILE_SIZE);
  const cz = Math.round(wz / TILE_SIZE);
  let best = 3;
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = cx + dx;
      const z = cz + dz;
      let blocks: boolean;
      if (x < 0 || z < 0 || x >= width || z >= height) {
        blocks = false; // open map edge — water spills off, no foam line
      } else {
        const t = tiles[z * width + x];
        blocks = !t || t.surface === 'void' ? false : !isWaterSurface(t.surface);
      }
      if (!blocks) continue;
      const minX = x * TILE_SIZE - TILE_SIZE / 2;
      const maxX = x * TILE_SIZE + TILE_SIZE / 2;
      const minZ = z * TILE_SIZE - TILE_SIZE / 2;
      const maxZ = z * TILE_SIZE + TILE_SIZE / 2;
      const ddx = Math.max(minX - wx, 0, wx - maxX);
      const ddz = Math.max(minZ - wz, 0, wz - maxZ);
      best = Math.min(best, Math.hypot(ddx, ddz));
    }
  }
  return best;
}

/**
 * A small irregular boulder jutting out of a cliff face. Eight triangles, jittered radii —
 * enough to break the extruded-cube silhouette without meaningful cost.
 */
function addRockShard(
  bucket: Bucket,
  x: number,
  y: number,
  z: number,
  nx: number,
  nz: number,
  size: number,
  seed: number,
): void {
  const r = (i: number): number => 0.55 + hash3(i, seed & 0xffff, i * 3 + 1, seed) * 0.85;
  // Local frame: outward = face normal, up = world up, side = cross.
  const ox = nx;
  const oz = nz;
  const sx = -nz;
  const sz = nx;
  const P = (o: number, s: number, up: number, i: number): Vtx => {
    const k = r(i) * size;
    return v(
      x + (ox * o + sx * s) * k,
      y + up * k,
      z + (oz * o + sz * s) * k,
      0,
      0,
      0,
    );
  };
  // Octahedron pushed outward from the wall.
  const tip = P(1.0, 0, 0.1, 1);
  const top = P(0.3, 0, 0.95, 2);
  const bot = P(0.3, 0, -0.95, 3);
  const lft = P(0.25, 1.25, 0, 4);
  const rgt = P(0.25, -1.25, 0, 5);
  const back = P(-0.35, 0, 0, 6);

  const tri = (a: Vtx, b: Vtx, c: Vtx): void => {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const wx2 = c.x - a.x;
    const wy2 = c.y - a.y;
    const wz2 = c.z - a.z;
    let gx = uy * wz2 - uz * wy2;
    let gy = uz * wx2 - ux * wz2;
    let gz = ux * wy2 - uy * wx2;
    // Orient outward from the shard centre.
    const mx = (a.x + b.x + c.x) / 3 - x;
    const my = (a.y + b.y + c.y) / 3 - y;
    const mz = (a.z + b.z + c.z) / 3 - z;
    if (gx * mx + gy * my + gz * mz < 0) {
      gx = -gx;
      gy = -gy;
      gz = -gz;
    }
    const gl = Math.hypot(gx, gy, gz) || 1;
    const na = { ...a, nx: gx / gl, ny: gy / gl, nz: gz / gl };
    const nb = { ...b, nx: gx / gl, ny: gy / gl, nz: gz / gl };
    const nc = { ...c, nx: gx / gl, ny: gy / gl, nz: gz / gl };
    bucket.addTri(na, nb, nc);
  };

  tri(tip, top, lft);
  tri(tip, lft, bot);
  tri(tip, bot, rgt);
  tri(tip, rgt, top);
  tri(back, lft, top);
  tri(back, bot, lft);
  tri(back, rgt, bot);
  tri(back, top, rgt);
}
