/**
 * Sprite atlas — the runtime half of the asset pipeline.
 *
 * Loads `public/assets/manifest.json` (produced by `tools/build-assets.mjs`) and
 * turns the raw FFT HD rips into GPU resources:
 *
 *   - a colour texture per sheet (NearestFilter, no mipmaps, correct alpha),
 *   - an *index* texture per sheet (one byte per pixel = the original FFT
 *     palette index), which is what makes GPU palette swapping possible,
 *   - 16x1 palette LUT textures per (family, slot).
 *
 * A sheet on disk is split across two PNG files — the second is the vertical
 * remainder of the same 512x976 image — so loading a sheet means stitching them
 * back together. See `docs/ASSETS.md` for the verified format facts.
 *
 * Texture orientation: both textures are uploaded bottom-up (the pipeline flips
 * the rows), which matches THREE's default `flipY` behaviour for image
 * textures. `getFrameUV`/`getPoseUV` therefore return conventional GL UVs where
 * `v0` is the *bottom* edge of the frame — feed them straight into a
 * PlaneGeometry's uv attribute.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearSRGBColorSpace,
  NearestFilter,
  RGBAFormat,
  RedFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import type { Texture } from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest shape (mirrors tools/build-assets.mjs output)
// ─────────────────────────────────────────────────────────────────────────────

/** `[cellIndex, x, y, w, h, pixels]` repeated; x/y are relative to the cell. */
export type CellBoxArray = number[];

/** `[bandIndex, column, x, y, w, h, feetX, feetY]` in sheet pixels. */
export type PoseArray = number[];

export interface SheetManifestEntry {
  key: string;
  id: number;
  name: string;
  /** Primary PNG, relative to the site root (e.g. `assets/sprites/1000_...png`). */
  url: string;
  /** Primary + optional continuation, in stacking order. */
  files: string[];
  /** Stitched dimensions (all files stacked vertically). */
  width: number;
  height: number;
  /** Y at which the second file begins, or null when there is only one file. */
  splitY: number | null;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  opaquePixels: number;
  /** True when the source rip is unusable (a few WotL sheets are 18px tall stubs). */
  broken: boolean;
  paletteFamily: string | null;
  paletteSlot: number | null;
  paletteAmbiguous?: boolean;
  /** base64 of the sheet's own 16-colour PLTE (48 bytes). Always present for sprites. */
  basePalette: string | null;
  /** Pairs of palette indices that share an RGB value (breaks exact inversion). */
  duplicatePaletteColours?: number[][];
  /** Offset from a pose frame's bottom-centre to the unit's feet, in pixels. */
  anchor: { x: number; y: number };
  occupiedCells: number;
  /** Hex string, one nibble per four cells, row-major, bit i = cell i of the group. */
  occupancy: string;
  cellBoxes: CellBoxArray;
  /** `[y, height]` per run of non-empty scanlines. */
  contentBands: number[][];
  /** `[y, height, figureCount]` for the bands that hold whole-body frames. */
  poseBands: number[][];
  poses: PoseArray;
}

export interface PaletteFamilyEntry {
  /** 8 battle slots; base64 of 48 bytes, or null when the slot file is missing. */
  battle: (string | null)[];
  /** 8 portrait slots, paired by slot with `battle`. */
  portrait: (string | null)[];
  /** How many battle slots are actually coloured (the rest are unused black). */
  battleUsed: number;
  portraitUsed: number;
}

export interface SimpleAssetEntry {
  key: string;
  url: string;
  width: number;
  height: number;
}

export interface GridAssetEntry extends SimpleAssetEntry {
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  palette?: string | null;
  id?: number | null;
}

export interface AssetManifest {
  version: number;
  generator: string;
  generatedAt: string;
  grid: { cell: number; columns: number; sheetWidth: number };
  notes: Record<string, string>;
  stats: Record<string, number>;
  sheets: Record<string, SheetManifestEntry>;
  byNumber: Record<string, string>;
  palettes: Record<string, PaletteFamilyEntry>;
  summons: Record<string, GridAssetEntry>;
  portraits: Record<string, SimpleAssetEntry>;
  weapons: Record<string, GridAssetEntry>;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public value types
// ─────────────────────────────────────────────────────────────────────────────

/** GL UV rect. `v0` is the bottom edge, `v1` the top. */
export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface CellBox {
  cell: number;
  column: number;
  row: number;
  /** Tight bounds relative to the cell's top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: number;
}

/** A whole-body frame: a complete unit, not an SHP body part. */
export interface Pose {
  index: number;
  band: number;
  column: number;
  /** Tight bounds in sheet pixels, origin at the sheet's top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The unit's feet in sheet pixels — where the sprite meets the ground. */
  feetX: number;
  feetY: number;
}

export interface LoadedSheet {
  key: string;
  meta: SheetManifestEntry;
  /** RGBA, alpha 0 where the FFT palette index is 0. */
  colorTexture: DataTexture;
  /** Single-channel R8; the byte value is the original FFT palette index. */
  indexTexture: DataTexture;
  width: number;
  height: number;
  poses: Pose[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(input: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(input);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback so tools/tests can use this module without a DOM.
  const clean = input.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = BASE64_ALPHABET.indexOf(clean[i] ?? '');
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

function joinUrl(base: string, rel: string): string {
  if (/^(https?:)?\/\//.test(rel) || rel.startsWith('/')) return rel;
  return base.endsWith('/') ? base + rel : `${base}/${rel}`;
}

function defaultBase(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? '/';
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  return img;
}

/** Stitch a sheet's PNG files into one top-down RGBA buffer. */
async function readStitchedPixels(
  meta: SheetManifestEntry,
  base: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const images: HTMLImageElement[] = [];
  for (const file of meta.files) images.push(await loadImage(joinUrl(base, file)));

  const width = meta.width;
  const height = meta.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('spriteAtlas: 2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.naturalHeight;
  }
  const image = ctx.getImageData(0, 0, width, height);
  return { data: image.data, width, height };
}

// ─────────────────────────────────────────────────────────────────────────────
// SpriteAtlas
// ─────────────────────────────────────────────────────────────────────────────

export class SpriteAtlas {
  readonly manifest: AssetManifest;
  private readonly base: string;
  private readonly sheets = new Map<string, LoadedSheet>();
  private readonly pending = new Map<string, Promise<LoadedSheet>>();
  private readonly paletteCache = new Map<string, DataTexture>();

  private constructor(manifest: AssetManifest, base: string) {
    this.manifest = manifest;
    this.base = base;
  }

  /** Fetch and parse the manifest. Sheets are loaded lazily by `loadSheet`. */
  static async load(options: { base?: string; manifestUrl?: string } = {}): Promise<SpriteAtlas> {
    const base = options.base ?? defaultBase();
    const url = options.manifestUrl ?? joinUrl(base, 'assets/manifest.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`spriteAtlas: failed to fetch ${url} (${res.status})`);
    const manifest = (await res.json()) as AssetManifest;
    return new SpriteAtlas(manifest, base);
  }

  /** Build an atlas from an already-parsed manifest (tests, SSR, headless shots). */
  static fromManifest(manifest: AssetManifest, base = defaultBase()): SpriteAtlas {
    return new SpriteAtlas(manifest, base);
  }

  // ── metadata ───────────────────────────────────────────────────────────────

  sheetKeys(): string[] {
    return Object.keys(this.manifest.sheets);
  }

  /** Manifest entry for a sheet key, or for a raw FFT sprite number. */
  meta(key: string | number): SheetManifestEntry | undefined {
    if (typeof key === 'number') {
      const mapped = this.manifest.byNumber[String(key)];
      return mapped === undefined ? undefined : this.manifest.sheets[mapped];
    }
    return this.manifest.sheets[key];
  }

  has(key: string): boolean {
    return this.manifest.sheets[key] !== undefined;
  }

  private require(key: string): SheetManifestEntry {
    const meta = this.manifest.sheets[key];
    if (!meta) throw new Error(`spriteAtlas: unknown sheet '${key}'`);
    return meta;
  }

  // ── loading ────────────────────────────────────────────────────────────────

  /**
   * Load (or return the cached) GPU resources for a sheet. Safe to call
   * concurrently: in-flight loads are shared.
   */
  loadSheet(key: string): Promise<LoadedSheet> {
    const cached = this.sheets.get(key);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const meta = this.require(key);
    if (meta.broken) {
      return Promise.reject(new Error(`spriteAtlas: sheet '${key}' is a broken source rip`));
    }

    const promise = this.buildSheet(meta)
      .then((sheet) => {
        this.sheets.set(key, sheet);
        this.pending.delete(key);
        return sheet;
      })
      .catch((err: unknown) => {
        this.pending.delete(key);
        throw err;
      });
    this.pending.set(key, promise);
    return promise;
  }

  /** Load several sheets at once. */
  async loadSheets(keys: readonly string[]): Promise<LoadedSheet[]> {
    return Promise.all(keys.map((k) => this.loadSheet(k)));
  }

  /** The already-loaded sheet, or undefined. Never triggers I/O. */
  getSheet(key: string): LoadedSheet | undefined {
    return this.sheets.get(key);
  }

  private async buildSheet(meta: SheetManifestEntry): Promise<LoadedSheet> {
    const { data, width, height } = await readStitchedPixels(meta, this.base);

    // Invert the canvas RGB back to FFT palette indices using the sheet's own
    // PLTE. Exact matches only, with a nearest-colour fallback so a stray
    // resampled pixel can never produce a hole.
    const palette = meta.basePalette ? decodeBase64(meta.basePalette) : null;
    const exact = new Map<number, number>();
    if (palette) {
      for (let i = 15; i >= 0; i--) {
        const rgb = ((palette[i * 3] ?? 0) << 16) | ((palette[i * 3 + 1] ?? 0) << 8) | (palette[i * 3 + 2] ?? 0);
        exact.set(rgb, i); // lower indices win — index 0 is the transparent one
      }
    }

    const px = width * height;
    const color = new Uint8Array(px * 4);
    const indices = new Uint8Array(px);
    const misses = new Map<number, number>();

    for (let y = 0; y < height; y++) {
      const srcRow = y * width * 4;
      // Flip vertically so the textures are bottom-up, matching THREE's
      // flipY-for-images convention.
      const dstRow = (height - 1 - y) * width;
      for (let x = 0; x < width; x++) {
        const s = srcRow + x * 4;
        const r = data[s] ?? 0;
        const g = data[s + 1] ?? 0;
        const b = data[s + 2] ?? 0;
        const a = data[s + 3] ?? 0;
        let index: number;
        if (a === 0) {
          index = 0;
        } else {
          const rgb = (r << 16) | (g << 8) | b;
          const hit = exact.get(rgb);
          if (hit !== undefined) {
            index = hit;
          } else {
            let cached = misses.get(rgb);
            if (cached === undefined) {
              cached = palette ? nearestIndex(palette, r, g, b) : 0;
              misses.set(rgb, cached);
            }
            index = cached;
          }
        }
        const d = dstRow + x;
        indices[d] = index;
        const c = d * 4;
        if (index === 0) {
          color[c] = 0; color[c + 1] = 0; color[c + 2] = 0; color[c + 3] = 0;
        } else {
          color[c] = r; color[c + 1] = g; color[c + 2] = b; color[c + 3] = 255;
        }
      }
    }

    const colorTexture = new DataTexture(color, width, height, RGBAFormat, UnsignedByteType);
    colorTexture.colorSpace = SRGBColorSpace;
    configurePixelTexture(colorTexture);
    colorTexture.name = `${meta.key}:color`;

    const indexTexture = new DataTexture(indices, width, height, RedFormat, UnsignedByteType);
    indexTexture.colorSpace = LinearSRGBColorSpace;
    indexTexture.internalFormat = 'R8';
    configurePixelTexture(indexTexture);
    indexTexture.name = `${meta.key}:index`;

    return {
      key: meta.key,
      meta,
      colorTexture,
      indexTexture,
      width,
      height,
      poses: readPoses(meta),
    };
  }

  // ── frame geometry ─────────────────────────────────────────────────────────

  /**
   * UVs for a cell of the documented 64x64 grid, addressed row-major
   * (`cell = row * columns + column`).
   */
  getFrameUV(key: string, cell: number): UVRect {
    const meta = this.require(key);
    const column = cell % meta.columns;
    const row = Math.floor(cell / meta.columns);
    if (row < 0 || row >= meta.rows) {
      throw new Error(`spriteAtlas: cell ${cell} out of range for '${key}' (${meta.rows} rows)`);
    }
    return this.rectToUV(meta, column * meta.frameWidth, row * meta.frameHeight, meta.frameWidth, meta.frameHeight);
  }

  /** UVs for an arbitrary pixel rect in sheet space (origin top-left). */
  getRectUV(key: string, x: number, y: number, w: number, h: number): UVRect {
    return this.rectToUV(this.require(key), x, y, w, h);
  }

  /** UVs for a detected whole-body pose, tight to its bounding box. */
  getPoseUV(key: string, poseIndex: number): UVRect {
    const pose = this.getPose(key, poseIndex);
    return this.rectToUV(this.require(key), pose.x, pose.y, pose.w, pose.h);
  }

  /** All whole-body frames on a sheet, in top-to-bottom, left-to-right order. */
  getPoses(key: string): Pose[] {
    const loaded = this.sheets.get(key);
    return loaded ? loaded.poses : readPoses(this.require(key));
  }

  getPose(key: string, poseIndex: number): Pose {
    const poses = this.getPoses(key);
    const pose = poses[poseIndex];
    if (!pose) throw new Error(`spriteAtlas: pose ${poseIndex} out of range for '${key}' (${poses.length})`);
    return pose;
  }

  /** Occupied cells of the 64px grid with their tight bounds. */
  getCellBoxes(key: string): CellBox[] {
    const meta = this.require(key);
    const out: CellBox[] = [];
    const a = meta.cellBoxes;
    for (let i = 0; i + 5 < a.length; i += 6) {
      const cell = a[i] ?? 0;
      out.push({
        cell,
        column: cell % meta.columns,
        row: Math.floor(cell / meta.columns),
        x: a[i + 1] ?? 0,
        y: a[i + 2] ?? 0,
        w: a[i + 3] ?? 0,
        h: a[i + 4] ?? 0,
        pixels: a[i + 5] ?? 0,
      });
    }
    return out;
  }

  /** True when the given grid cell contains any opaque pixel. */
  isCellOccupied(key: string, cell: number): boolean {
    const meta = this.require(key);
    const nibble = meta.occupancy[cell >> 2];
    if (nibble === undefined) return false;
    return (parseInt(nibble, 16) & (1 << (cell & 3))) !== 0;
  }

  private rectToUV(meta: SheetManifestEntry, x: number, y: number, w: number, h: number): UVRect {
    const W = meta.width;
    const H = meta.height;
    return {
      u0: x / W,
      u1: (x + w) / W,
      // textures are stored bottom-up, so the frame's top edge is the high v
      v0: 1 - (y + h) / H,
      v1: 1 - y / H,
    };
  }

  // ── palettes ───────────────────────────────────────────────────────────────

  /**
   * A 16x1 RGBA lookup texture for GPU palette swapping. Texel 0 is fully
   * transparent (FFT's transparent index). Textures are cached and shared.
   *
   * @param family palette family from `SheetManifestEntry.paletteFamily`
   * @param index  slot 0-7. For generic classes: 0 blue/player, 1 red/enemy,
   *               2 green/ally, 3 yellow, 4 purple. For monsters these are
   *               colour variants; for story characters only slot 0 is used.
   */
  getPaletteTexture(family: string, index: number, kind: 'battle' | 'portrait' = 'battle'): DataTexture {
    const cacheKey = `${kind}:${family}:${index}`;
    const cached = this.paletteCache.get(cacheKey);
    if (cached) return cached;

    const entry = this.manifest.palettes[family];
    if (!entry) throw new Error(`spriteAtlas: unknown palette family '${family}'`);
    const slots = kind === 'battle' ? entry.battle : entry.portrait;
    const b64 = slots[index];
    if (b64 === undefined) throw new Error(`spriteAtlas: palette slot ${index} out of range for '${family}'`);
    if (b64 === null) throw new Error(`spriteAtlas: palette '${family}' has no ${kind} slot ${index}`);

    const tex = makePaletteTexture(decodeBase64(b64), cacheKey);
    this.paletteCache.set(cacheKey, tex);
    return tex;
  }

  /**
   * Palette LUT for a sheet, resolving its family automatically and falling
   * back to the sheet's own embedded palette when the family is unknown or the
   * requested slot is empty (unused slots in the source data are all black).
   */
  getSheetPalette(key: string, index: number, kind: 'battle' | 'portrait' = 'battle'): DataTexture {
    const meta = this.require(key);
    if (meta.paletteFamily) {
      const entry = this.manifest.palettes[meta.paletteFamily];
      const slots = entry ? (kind === 'battle' ? entry.battle : entry.portrait) : undefined;
      const b64 = slots?.[index];
      if (b64 && !isAllBlack(decodeBase64(b64))) {
        return this.getPaletteTexture(meta.paletteFamily, index, kind);
      }
    }
    const cacheKey = `base:${key}`;
    const cached = this.paletteCache.get(cacheKey);
    if (cached) return cached;
    if (!meta.basePalette) throw new Error(`spriteAtlas: sheet '${key}' has no palette`);
    const tex = makePaletteTexture(decodeBase64(meta.basePalette), cacheKey);
    this.paletteCache.set(cacheKey, tex);
    return tex;
  }

  /** How many palette slots of a family actually carry colour. */
  paletteSlotCount(family: string, kind: 'battle' | 'portrait' = 'battle'): number {
    const entry = this.manifest.palettes[family];
    if (!entry) return 0;
    return kind === 'battle' ? entry.battleUsed : entry.portraitUsed;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  dispose(): void {
    for (const sheet of this.sheets.values()) {
      sheet.colorTexture.dispose();
      sheet.indexTexture.dispose();
    }
    this.sheets.clear();
    this.pending.clear();
    for (const tex of this.paletteCache.values()) tex.dispose();
    this.paletteCache.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function configurePixelTexture(tex: Texture): void {
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.premultiplyAlpha = false;
  tex.unpackAlignment = 1;
  tex.flipY = false; // data is already stored bottom-up
  tex.needsUpdate = true;
}

function makePaletteTexture(rgb: Uint8Array, name: string): DataTexture {
  const data = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    data[i * 4] = rgb[i * 3] ?? 0;
    data[i * 4 + 1] = rgb[i * 3 + 1] ?? 0;
    data[i * 4 + 2] = rgb[i * 3 + 2] ?? 0;
    data[i * 4 + 3] = i === 0 ? 0 : 255;
  }
  const tex = new DataTexture(data, 16, 1, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  configurePixelTexture(tex);
  tex.name = `palette:${name}`;
  return tex;
}

function isAllBlack(rgb: Uint8Array): boolean {
  for (let i = 3; i < 48; i++) if ((rgb[i] ?? 0) !== 0) return false;
  return true;
}

function nearestIndex(palette: Uint8Array, r: number, g: number, b: number): number {
  let best = 1;
  let bestD = Infinity;
  for (let i = 1; i < 16; i++) {
    const dr = r - (palette[i * 3] ?? 0);
    const dg = g - (palette[i * 3 + 1] ?? 0);
    const db = b - (palette[i * 3 + 2] ?? 0);
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function readPoses(meta: SheetManifestEntry): Pose[] {
  const out: Pose[] = [];
  const a = meta.poses;
  for (let i = 0, n = 0; i + 7 < a.length; i += 8, n++) {
    out.push({
      index: n,
      band: a[i] ?? 0,
      column: a[i + 1] ?? 0,
      x: a[i + 2] ?? 0,
      y: a[i + 3] ?? 0,
      w: a[i + 4] ?? 0,
      h: a[i + 5] ?? 0,
      feetX: a[i + 6] ?? 0,
      feetY: a[i + 7] ?? 0,
    });
  }
  return out;
}

/**
 * GLSL for the palette-swap material. Sample the index texture, scale the byte
 * back to 0-15, and look the colour up in the 16x1 LUT.
 *
 * Kept here so `render/sprites.ts` and `render/materials/` share one definition
 * of how a palette swap is performed.
 */
export const PALETTE_SWAP_GLSL = /* glsl */ `
uniform sampler2D uIndexMap;
uniform sampler2D uPalette;

vec4 paletteSample(vec2 uv) {
  // R8 texture: value is index/255. 16 entries, sampled at texel centres.
  float index = texture2D(uIndexMap, uv).r * 255.0;
  vec4 texel = texture2D(uPalette, vec2((index + 0.5) / 16.0, 0.5));
  return texel;
}
`;
