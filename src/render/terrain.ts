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
/** Drop, in world units, at which a side face becomes a sculpted cliff. */
const CLIFF_MIN_DROP = 1.2;
/** How far the outermost side faces extend below the lowest tile. */
const SKIRT = 1.35;
/** Water column depth (in half-tiles) carved beneath each water surface. */
const WATER_BED_DEPTH = 3;
const DEEPWATER_BED_DEPTH = 7;

/** Height of the walkable surface of a tile, in world units. */
export function tileSurfaceY(tile: Tile): number {
  return tile.height * HEIGHT_UNIT;
}

/**
 * World position of the centre of a tile's walkable surface. Sprites, cursors and VFX
 * should anchor here.
 */
export function tileWorldPosition(field: Battlefield, x: number, y: number): THREE.Vector3 {
  const tile = field.tileAt(x, y);
  const h = tile ? tile.height + slopeOffsetHalf(tile.slope, 0.5, 0.5) : 0;
  return new THREE.Vector3(x * TILE_SIZE, h * HEIGHT_UNIT, y * TILE_SIZE);
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

  private push(p: Vtx): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(p.nx, p.ny, p.nz);
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
  private readonly slopes: SlopeKind[];
  readonly baseY: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    tiles: Array<Tile | undefined>,
  ) {
    this.solid = new Uint8Array(width * height);
    this.heights = new Float32Array(width * height);
    this.slopes = new Array<SlopeKind>(width * height).fill('flat');
    let minTop = Infinity;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t || t.surface === 'void') continue;
      this.solid[i] = 1;
      this.heights[i] = solidTopHalf(t);
      this.slopes[i] = isWaterSurface(t.surface) ? 'flat' : t.slope;
      minTop = Math.min(minTop, this.heights[i]! * HEIGHT_UNIT);
    }
    this.baseY = (Number.isFinite(minTop) ? minTop : 0) - SKIRT;
  }

  /** Top of the *solid* part of a column in world Y (the bed, for water tiles). */
  topAt(tx: number, ty: number, u: number, v: number): number {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return -Infinity;
    const i = ty * this.width + tx;
    if (this.solid[i] === 0) return -Infinity;
    return (this.heights[i]! + slopeOffsetHalf(this.slopes[i]!, u, v)) * HEIGHT_UNIT;
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
    return wy <= top - 1e-4 && wy >= this.baseY;
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

export function buildTerrain(field: Battlefield, opts: TerrainOptions = {}): Terrain {
  const { width, height } = field;
  const tiles: Array<Tile | undefined> = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) tiles[y * width + x] = field.tileAt(x, y);
  }
  const column = new ColumnField(width, height, tiles);

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

  /** Solid top surface Y of tile (tx, ty) at local (u, v). */
  const solidTopY = (t: Tile, u: number, vv: number): number =>
    (solidTopHalf(t) + slopeOffsetHalf(isWaterSurface(t.surface) ? 'flat' : t.slope, u, vv)) *
    HEIGHT_UNIT;

  /** Outer chamfer-ring Y at a tile's perimeter param. */
  const ringY = (t: Tile, u: number, vv: number): number => solidTopY(t, u, vv) - CHAMFER_DROP;

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
              solidTopY(tile, u, vv),
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

        // Outward-and-up normal for the chamfer facet.
        const eux = (pu1 - pu0) * TILE_SIZE;
        const euz = (pv1 - pv0) * TILE_SIZE;
        let cnx = -euz;
        let cnz = eux;
        const cl = Math.hypot(cnx, cnz) || 1;
        cnx = (cnx / cl) * 0.72;
        cnz = (cnz / cl) * 0.72;
        const surf = normalAt(tile, (pu0 + pu1) / 2, (pv0 + pv1) / 2);
        const bnx = cnx + surf[0] * 0.7;
        const bny = 0.7 * surf[1];
        const bnz = cnz + surf[2] * 0.7;
        const bl = Math.hypot(bnx, bny, bnz) || 1;

        const a = v(
          ox + (iu0 - 0.5) * TILE_SIZE,
          solidTopY(tile, iu0, iv0),
          oz + (iv0 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        const b = v(
          ox + (iu1 - 0.5) * TILE_SIZE,
          solidTopY(tile, iu1, iv1),
          oz + (iv1 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        const c = v(
          ox + (pu1 - 0.5) * TILE_SIZE,
          ringY(tile, pu1, pv1),
          oz + (pv1 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        const d = v(
          ox + (pu0 - 0.5) * TILE_SIZE,
          ringY(tile, pu0, pv0),
          oz + (pv0 - 0.5) * TILE_SIZE,
          bnx / bl,
          bny / bl,
          bnz / bl,
        );
        bucket.addQuad(a, b, c, d);
      }

      // ── side faces ──────────────────────────────────────────────────────
      for (const e of EDGES) {
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
            exposedWater ? tile.height * HEIGHT_UNIT - CHAMFER_DROP : ringY(tile, u, vv),
          );
          if (nbSolid && nb) {
            const mu = e.mu0 + (e.mu1 - e.mu0) * p;
            const mv = e.mv0 + (e.mv1 - e.mv0) * p;
            bottoms.push(ringY(nb, mu, mv));
          } else {
            bottoms.push(column.baseY);
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
            wDepth.push(Math.max(0, surfaceY - smoothSolidTop(tiles, width, height, wx, wz)));
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
): number {
  const fx = wx / TILE_SIZE;
  const fz = wz / TILE_SIZE;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tu = fx - x0;
  const tv = fz - z0;
  const sample = (x: number, z: number): number => {
    if (x < 0 || z < 0 || x >= width || z >= height) return -SKIRT;
    const t = tiles[z * width + x];
    if (!t || t.surface === 'void') return -SKIRT;
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
