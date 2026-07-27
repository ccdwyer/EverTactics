/**
 * EverTactics — SHP part assembly at runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A COMPOSITED INDEX BUFFER AND NOT ONE QUAD PER PART
 * ─────────────────────────────────────────────────────────────────────────────
 * An authentic FFT animation frame is 1-8 rectangles of the sheet placed at
 * signed offsets from the unit's origin (docs/ASSETS.md §5.2). The obvious
 * renderer draws one quad per part — and immediately loses everything the sprite
 * layer has been tuned to do. The unit material is not a texture blit: it carries
 * the GPU palette swap, the foot-contact darkening ramp, the ground bounce, the
 * rim, the dissolve, a custom depth material for the shadow map, and a
 * view-space pixel snap that assumes **one** quad whose half-width is a whole
 * number of texels. Eight quads means eight of each, eight snaps that disagree by
 * a subpixel, and a silhouette that shimmers apart as the camera turns.
 *
 * So the parts are composited on the CPU into a per-sprite **index buffer** —
 * palette indices, not colours — which is uploaded as the material's 'uIndexMap'
 * in place of the sheet. From the shader's point of view nothing has changed: it
 * is still sampling one rectangle of one R8 index texture, so the palette swap,
 * every ramp, the depth material and the pixel snap all keep working untouched.
 *
 * Cost is a memcpy of a few thousand bytes on the frames where the drawn frame
 * actually changes (7 frames a second at walking pace), against a per-sprite
 * texture of ~20 KB. Composed buffers are cached per SHP frame and shared by
 * every unit on the sheet, so the composite itself runs at most once per frame id.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COORDINATES
 * ─────────────────────────────────────────────────────────────────────────────
 * 'ShpPart' is in **original 256x488 SPR pixels**; the shipped sheets are a clean
 * 2x upscale of that canvas, so every field is multiplied by 'hdScale' before it
 * addresses a sheet texel. 'IndexedImage.indices' is stored **bottom-up** and the
 * composed buffer keeps that convention, so the two convert through
 * 'row = height - 1 - yTopDown' and nothing else in the pipeline has to care.
 */

import type { ShpPart } from './animation';
import type { IndexedImage } from './materials/sprite';

/**
 * Texels of slack left on every side of the measured part extent.
 *
 * The extent is measured from part *boxes*, which are already the outer bound of
 * the artwork, so this is not correcting for anything — it keeps the silhouette
 * off the buffer edge, where the material's edge taps (the outline and the rim
 * sample neighbouring texels) would otherwise clamp and smear the last column.
 */
const COMPOSITE_MARGIN = 4;

/** One assembled frame, ready to upload as an R8 index texture. */
export interface ComposedFrame {
  /** Palette indices, one byte per texel, **bottom-up**. Length = w * h. */
  readonly indices: Uint8Array;
  /** Opaque texel count. Zero means the assembly produced nothing drawable. */
  readonly opaque: number;
  /** Texels from the buffer's bottom edge up to the lowest opaque row. */
  readonly footBottomY: number;
  /** Texels from the buffer's bottom edge up to (and including) the top row. */
  readonly headTopY: number;
}

/**
 * The buffer geometry a set of SHP frames needs.
 *
 * Sized from the union of the part boxes of every frame that will ever be drawn,
 * so a frame can never be clipped — a half-drawn figure is exactly the failure
 * this feature was shelved for once already.
 */
export interface CompositeLayout {
  /** Buffer size in sheet texels (i.e. HD pixels). Both are even. */
  readonly width: number;
  readonly height: number;
  /** Texels from the left edge to the unit origin. */
  readonly originX: number;
  /**
   * Texels from the **bottom** edge up to the unit origin — the point the game
   * plants on the tile surface. This is the composite's 'groundOffset', in the
   * same sense as {@link SheetLayout.groundOffset}.
   */
  readonly originY: number;
}

/**
 * Measure the buffer a set of frames needs, in sheet texels.
 *
 * Returns null when the frames carry no parts at all, which is the caller's
 * signal to stay on the pose-cell path rather than allocate an empty texture.
 */
export function measureComposite(
  frames: readonly (readonly ShpPart[])[],
  hdScale: number,
): CompositeLayout | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const parts of frames) {
    for (const part of parts) {
      if (part.w <= 0 || part.h <= 0) continue;
      if (part.dx < x0) x0 = part.dx;
      if (part.dy < y0) y0 = part.dy;
      if (part.dx + part.w > x1) x1 = part.dx + part.w;
      if (part.dy + part.h > y1) y1 = part.dy + part.h;
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;

  const left = x0 * hdScale - COMPOSITE_MARGIN;
  const top = y0 * hdScale - COMPOSITE_MARGIN;
  const right = x1 * hdScale + COMPOSITE_MARGIN;
  const bottom = y1 * hdScale + COMPOSITE_MARGIN;

  // Even dimensions keep the quad's half-width a whole number of texels, which
  // is what the view-space pixel snap in 'UnitSprite.update' relies on.
  const width = Math.ceil((right - left) / 2) * 2;
  const height = Math.ceil((bottom - top) / 2) * 2;
  return { width, height, originX: -left, originY: height + top };
}

/**
 * Does every part read art the sheet actually carries?
 *
 * Two real reasons it would not. The runtime loads a sheet's **primary** file
 * only — 512 of the 976 stitched rows for a full unit sheet (docs/ASSETS.md
 * §1.1) — so a frame at or past the SHP's 'atk' split, which adds 256 SPR rows to
 * reach the sheet's second half, addresses texels that are not in memory. And the
 * 22 broken rips (§1.2) are 18-pixel noise strips that contain nothing at all.
 *
 * Either way the answer has to be "do not animate this sheet", not "draw what
 * fits": the caller uses this to decide before a single frame is shown, so the
 * unit stays whole rather than losing a leg on frame four.
 */
export function partsFitSheet(
  frames: readonly (readonly ShpPart[])[],
  image: IndexedImage,
  hdScale: number,
): boolean {
  for (const parts of frames) {
    for (const part of parts) {
      if (part.sx < 0 || part.sy < 0) return false;
      if ((part.sx + part.w) * hdScale > image.width) return false;
      if ((part.sy + part.h) * hdScale > image.height) return false;
    }
  }
  return true;
}

/**
 * Assembles SHP frames of one sheet into index buffers.
 *
 * One per sheet, shared by every unit drawn from it: the composite depends only
 * on the frame and the sheet, never on the unit, so the cache is a pure win.
 */
export class FrameComposer {
  readonly layout: CompositeLayout;

  private readonly cache = new Map<readonly ShpPart[], ComposedFrame>();

  constructor(
    private readonly image: IndexedImage,
    layout: CompositeLayout,
    readonly hdScale: number,
  ) {
    this.layout = layout;
  }

  /** Composed byte length — what a per-sprite texture has to allocate. */
  get byteLength(): number {
    return this.layout.width * this.layout.height;
  }

  /**
   * Assemble one frame, memoised on the part list's identity.
   *
   * 'ShpLibrary' hands out the same frozen array for a given frame id every time,
   * so identity is a sound cache key and costs nothing to compute.
   */
  compose(parts: readonly ShpPart[]): ComposedFrame {
    const hit = this.cache.get(parts);
    if (hit) return hit;
    const composed = this.build(parts);
    this.cache.set(parts, composed);
    return composed;
  }

  private build(parts: readonly ShpPart[]): ComposedFrame {
    const { width, height, originX, originY } = this.layout;
    const scale = this.hdScale;
    const out = new Uint8Array(width * height);
    const src = this.image.indices;
    const sw = this.image.width;
    const sh = this.image.height;

    let opaque = 0;
    for (const part of parts) {
      const pw = part.w * scale;
      const ph = part.h * scale;
      const sx0 = part.sx * scale;
      const sy0 = part.sy * scale;
      const dx0 = originX + part.dx * scale;
      // Destination rows run downward from the origin; the buffer runs upward.
      const dyTop = originY - part.dy * scale - 1;
      for (let j = 0; j < ph; j++) {
        const sv = part.flipY ? ph - 1 - j : j;
        const syTopDown = sy0 + sv;
        if (syTopDown < 0 || syTopDown >= sh) continue;
        const srcRow = (sh - 1 - syTopDown) * sw;
        const dstY = dyTop - j;
        if (dstY < 0 || dstY >= height) continue;
        const dstRow = dstY * width;
        for (let i = 0; i < pw; i++) {
          const su = part.flipX ? pw - 1 - i : i;
          const sx = sx0 + su;
          if (sx < 0 || sx >= sw) continue;
          const index = src[srcRow + sx] ?? 0;
          // Index 0 is the transparency slot: a part never overwrites with it,
          // which is what lets a later part (an arm) sit over an earlier one.
          if (index === 0) continue;
          const x = dx0 + i;
          if (x < 0 || x >= width) continue;
          const o = dstRow + x;
          if (out[o] === 0) opaque++;
          out[o] = index;
        }
      }
    }

    return { indices: out, opaque, ...measureExtents(out, width, height) };
  }
}

/**
 * Where the art's feet and head landed in a composed buffer.
 *
 * Same definitions as 'measureCellExtents' in 'sprites.ts', and better
 * information than that table can carry: these are per *frame*, so the contact
 * ramp and the overhead furniture follow the figure through the gait instead of
 * keying off one static cell.
 *
 * There is deliberately no foot-*centre* here, unlike the pose path. A pose cell
 * is arbitrary art inside a 64-texel box and has to be recentred on its stance; an
 * assembled frame already has an authoritative anchor — the SHP origin is the
 * point the game plants on the tile. Re-deriving a centre from the boots would
 * also cancel the stride, since the whole of a walk cycle is the feet moving while
 * the origin holds still, and on a sheet with a detached part low in the frame
 * (the chocobo's tail feather) it snaps the figure sideways by 30 texels between
 * frames.
 */
function measureExtents(
  buffer: Uint8Array,
  width: number,
  height: number,
): { footBottomY: number; headTopY: number } {
  const rowHasArt = (y: number): boolean => {
    const row = y * width;
    for (let x = 0; x < width; x++) if ((buffer[row + x] ?? 0) !== 0) return true;
    return false;
  };

  let lowest = -1;
  for (let y = 0; y < height; y++) {
    if (rowHasArt(y)) {
      lowest = y;
      break;
    }
  }
  if (lowest < 0) return { footBottomY: 0, headTopY: 0 };

  let highest = lowest;
  for (let y = height - 1; y >= lowest; y--) {
    if (rowHasArt(y)) {
      highest = y;
      break;
    }
  }

  return { footBottomY: lowest, headTopY: highest + 1 };
}
