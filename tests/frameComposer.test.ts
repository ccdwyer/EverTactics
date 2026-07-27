/**
 * Runtime SHP assembly — the plumbing that puts decoded animation on screen.
 *
 * `animation.test.ts` proves the decode. This proves the *wiring*: that the
 * composed buffer is a whole figure, that it lands where the ground line is, and
 * — the part that matters most — that a sheet which cannot be animated honestly
 * stays on the pose cells instead of drawing a partial one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SEQ_ANIM_INDEX,
  ShpLibrary,
  decodedAnimationSet,
  defaultAnimationSet,
  type DecodedAnimations,
  type ShpPart,
} from '../src/render/animation';
import { FrameComposer, measureComposite, partsFitSheet } from '../src/render/frameComposer';
import { SpriteSheet, decodedSpriteType, indexSpriteTypes } from '../src/render/sprites';
import { decodeIndexedPng, type IndexedImage } from '../src/render/materials/sprite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'public', 'assets');

const json = JSON.parse(
  fs.readFileSync(path.join(ASSETS, 'animations.json'), 'utf8'),
) as DecodedAnimations;
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8')) as {
  sheets: Record<string, { spriteType?: string | null; files: string[]; broken?: boolean }>;
};

/**
 * Load a sheet exactly as the runtime does — the **primary** file only.
 *
 * This is load-bearing, not incidental. A full unit sheet is two PNGs stacked
 * (docs/ASSETS.md §1.1) and `SpriteLayer` fetches the first, so a test that
 * stitched both halves would prove the composer works against art the game does
 * not have in memory.
 */
async function loadPrimary(key: string): Promise<IndexedImage> {
  const file = manifest.sheets[key]!.files[0]!.replace(/^assets\//, '');
  const buf = fs.readFileSync(path.join(ASSETS, file));
  return decodeIndexedPng(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function libraryFor(key: string): ShpLibrary {
  const type = manifest.sheets[key]!.spriteType!;
  const pair = json.spriteTypes[type]!;
  return ShpLibrary.fromJson(json, pair.shp, pair.seq)!;
}

function walkParts(library: ShpLibrary): (readonly ShpPart[])[] {
  return library
    .assemble(SEQ_ANIM_INDEX.walk!)
    .map((f) => f.parts!)
    .filter(Boolean);
}

describe('measureComposite', () => {
  const parts = walkParts(libraryFor('knight_male'));

  it('sizes the buffer to hold every frame it will ever draw', () => {
    const layout = measureComposite(parts, 2)!;
    for (const frame of parts) {
      for (const part of frame) {
        expect(layout.originX + part.dx * 2).toBeGreaterThanOrEqual(0);
        expect(layout.originX + (part.dx + part.w) * 2).toBeLessThanOrEqual(layout.width);
        // 'originY' counts up from the bottom; parts hang downward from it.
        expect(layout.originY - part.dy * 2).toBeLessThanOrEqual(layout.height);
        expect(layout.originY - (part.dy + part.h) * 2).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps the quad half-width whole so the pixel snap stays sound', () => {
    const layout = measureComposite(parts, 2)!;
    expect(layout.width % 2).toBe(0);
    expect(layout.height % 2).toBe(0);
  });

  it('returns null rather than an empty buffer when there are no parts', () => {
    expect(measureComposite([], 2)).toBeNull();
    expect(measureComposite([[]], 2)).toBeNull();
  });
});

describe('FrameComposer', () => {
  it('assembles a complete figure from the primary sheet alone', async () => {
    const image = await loadPrimary('knight_male');
    const library = libraryFor('knight_male');
    const parts = walkParts(library);
    const layout = measureComposite(parts, library.hdScale)!;
    const composer = new FrameComposer(image, layout, library.hdScale);

    for (const frame of parts) {
      const composed = composer.compose(frame);
      expect(composed.opaque).toBeGreaterThan(800);
      // The same guard `animation.test.ts` puts on the decode, now measured on
      // the pixels actually uploaded: 32 SPR pixels, i.e. 64 sheet texels. A
      // real figure clears it; the `other` table's fragments cannot.
      expect(composed.headTopY - composed.footBottomY).toBeGreaterThanOrEqual(64);
    }
  });

  it('plants the figure on the ground line the quad is built around', async () => {
    const image = await loadPrimary('knight_male');
    const library = libraryFor('knight_male');
    const parts = walkParts(library);
    const layout = measureComposite(parts, library.hdScale)!;
    const composer = new FrameComposer(image, layout, library.hdScale);

    // The SHP origin is the point the game plants on the tile, so the boots have
    // to sit within a few texels of it — never below the quad, never floating.
    for (const frame of parts) {
      const composed = composer.compose(frame);
      expect(composed.footBottomY).toBeLessThanOrEqual(layout.originY);
      expect(layout.originY - composed.footBottomY).toBeLessThanOrEqual(12);
    }
  });

  it('memoises on the frame, so a gait composes once per distinct pose', async () => {
    const image = await loadPrimary('knight_male');
    const library = libraryFor('knight_male');
    const parts = walkParts(library);
    const composer = new FrameComposer(image, measureComposite(parts, 2)!, 2);
    // 10, 9, 10, 11, 12, 13, 12 — three of the seven are repeats.
    expect(composer.compose(parts[0]!)).toBe(composer.compose(parts[2]!));
  });

  it('assembles the chocobo, which has no whole-body pose cell to fall back on', async () => {
    const image = await loadPrimary('chocobo');
    const library = libraryFor('chocobo');
    const parts = walkParts(library);
    const composer = new FrameComposer(image, measureComposite(parts, 2)!, 2);
    for (const frame of parts) expect(composer.compose(frame).opaque).toBeGreaterThan(1000);
  });
});

describe('partsFitSheet', () => {
  const parts = walkParts(libraryFor('knight_male'));
  const stub = (width: number, height: number): IndexedImage => ({
    width,
    height,
    indices: new Uint8Array(width * height),
    palette: new Uint8Array(48),
    alpha: new Uint8Array(16),
  });

  it('accepts the art the runtime actually loads', () => {
    expect(partsFitSheet(parts, stub(512, 512), 2)).toBe(true);
  });

  it('rejects a broken 18-pixel rip rather than assembling from noise', () => {
    // The 22 stubs of docs/ASSETS.md §1.2 are 512x18 grey strips.
    expect(partsFitSheet(parts, stub(512, 18), 2)).toBe(false);
  });
});

describe('SpriteSheet animation selection', () => {
  it('animates a sheet whose manifest sprite type resolves', async () => {
    const image = await loadPrimary('knight_male');
    const sheet = new SpriteSheet('knight_male', image, [image.palette], {
      shp: libraryFor('knight_male'),
    });
    expect(sheet.composer).not.toBeNull();
    expect(sheet.compositeGeometry).not.toBeNull();
    expect(sheet.animations.walk.procedural).toBe(false);
    expect(sheet.animations.walk.views.side[0]!.parts).toBeDefined();
    // Only walk / run / idle are named honestly; the rest keep the pose curve.
    expect(sheet.animations.attack.procedural).toBe(true);
    expect(sheet.animations.ko.procedural).toBe(true);
  });

  it('keeps a sheet with no decoded type wholly on pose cells', async () => {
    const image = await loadPrimary('knight_male');
    const sheet = new SpriteSheet('knight_male', image, [image.palette]);
    expect(sheet.composer).toBeNull();
    expect(sheet.compositeGeometry).toBeNull();
    expect(sheet.animations.walk.procedural).toBe(true);
    expect(sheet.animations.walk.views.side[0]!.parts).toBeUndefined();
  });

  /**
   * The failure this feature was shelved for. If a sheet cannot supply every
   * texel a clip references, it must not animate *at all* — a unit that loses a
   * leg on frame four reads as a rendering fault, which is worse on screen than
   * the static pose it replaced.
   */
  it('refuses decoded animation outright when the art cannot supply it', async () => {
    const full = await loadPrimary('knight_male');
    const truncated: IndexedImage = {
      width: full.width,
      height: 18,
      indices: full.indices.slice(0, full.width * 18),
      palette: full.palette,
      alpha: full.alpha,
    };
    const sheet = new SpriteSheet('broken', truncated, [full.palette], {
      shp: libraryFor('knight_male'),
    });
    expect(sheet.composer).toBeNull();
    expect(sheet.animations.walk.procedural).toBe(true);
    for (const clip of Object.values(sheet.animations)) {
      for (const view of Object.values(clip.views)) {
        for (const frame of view) expect(frame.parts).toBeUndefined();
      }
    }
  });

  it('every sheet the manifest types can actually be animated', async () => {
    // A sample rather than all 153: one per sprite type, which is what varies.
    const types = indexSpriteTypes(manifest as never);
    const perType = new Map<string, string>();
    for (const key of Object.keys(manifest.sheets)) {
      const type = decodedSpriteType(types, key, 2);
      if (type && !perType.has(type)) perType.set(type, key);
    }
    expect(perType.size).toBeGreaterThanOrEqual(3);
    for (const [type, key] of perType) {
      const image = await loadPrimary(key);
      const sheet = new SpriteSheet(key, image, [image.palette], { shp: libraryFor(key) });
      expect(sheet.composer, `${key} (${type}) should animate`).not.toBeNull();
      expect(sheet.animations.walk.procedural, `${key} (${type}) walk`).toBe(false);
    }
  });

  it('never assembles a clip the SEQ index leaves unnamed', async () => {
    const image = await loadPrimary('knight_male');
    const sheet = new SpriteSheet('knight_male', image, [image.palette], {
      shp: libraryFor('knight_male'),
    });
    for (const [name, index] of Object.entries(SEQ_ANIM_INDEX)) {
      if (index !== null) continue;
      const clip = sheet.animations[name as keyof typeof sheet.animations];
      expect(clip.procedural, name).toBe(true);
    }
  });
});

describe('decodedSpriteType', () => {
  const types = indexSpriteTypes(manifest as never);
  const resolve = (key: string) => decodedSpriteType(types, key, 2);

  it('resolves a sheet under the raw filename stem the scenarios use', () => {
    // 'Unit.sprite.sheet' in the shipped content is '1000_Knight_Male_hd', not
    // 'knight_male'. Keying on the manifest key alone silently disables the
    // whole feature, which is exactly how it looked before this alias existed.
    expect(resolve('knight_male')).toBe('type1');
    expect(resolve('1000_Knight_Male_hd')).toBe('type1');
    expect(resolve('1001_Knight_Male_hd')).toBe('type1');
    expect(resolve('chocobo')).toBe('cyoko');
    expect(resolve('1074_Coeurl_hd')).toBe('mon');
  });

  it('refuses the 22 broken rips', () => {
    for (const [key, entry] of Object.entries(manifest.sheets)) {
      if (entry.broken) expect(resolve(key), key).toBeNull();
    }
  });

  /**
   * The 512x512 single-file class: the 15 '*_2' monster variants plus
   * 'alma_dead' and 'ajora'. 'resolveSpriteType' in 'tools/build-assets.mjs'
   * falls through to 'type1' for every one of them, and a coeurl assembled out
   * of the human SHP is shards. They are a smaller canvas than the coordinates
   * describe, so they must not animate.
   */
  it('refuses sheets that are not the 256x488 canvas the SHP addresses', () => {
    let refused = 0;
    for (const [key, entry] of Object.entries(manifest.sheets)) {
      if (entry.broken || (entry as { height?: number }).height !== 512) continue;
      if (!entry.spriteType) continue;
      expect(resolve(key), key).toBeNull();
      refused++;
    }
    expect(refused).toBe(17);
    // …and specifically the one a shipped scenario uses.
    expect(manifest.sheets['coeurl_2']!.spriteType).toBe('type1');
    expect(resolve('1137_Coeurl_2_hd')).toBeNull();
  });

  it('still animates every full-canvas typed sheet', () => {
    let animated = 0;
    for (const [key, entry] of Object.entries(manifest.sheets)) {
      if (entry.broken || !entry.spriteType) continue;
      if ((entry as { height?: number }).height !== 976) continue;
      expect(resolve(key), key).toBe(entry.spriteType);
      animated++;
    }
    expect(animated).toBe(136);
  });

  it('is null for a key the manifest has never heard of', () => {
    expect(resolve('not_a_sheet')).toBeNull();
  });
});

describe('decoded clips keep the locomotion contract', () => {
  const library = ShpLibrary.fromJson(json, 'type1', 'type1')!;
  const merged = decodedAnimationSet(library, defaultAnimationSet());

  it('leaves walk and run driven by distance, not by time', () => {
    // The whole point of 'distanceDriven': the cycle advances with the ground the
    // unit covers, so slowing a unit down slows its legs by the same factor and
    // the feet never skate.
    expect(merged.walk.distanceDriven).toBe(true);
    expect(merged.run.distanceDriven).toBe(true);
    expect(merged.walk.footfalls).toEqual([0, 0.5]);
  });

  it('carries no per-frame translation on the gaits the walker owns', () => {
    // 'PathWalker' owns the unit's position while it traverses. A SEQ offset on a
    // distance-driven clip would double-count the step.
    for (const name of ['walk', 'run'] as const) {
      const clip = json.seq.type1!.anims.find((a) => a.i === SEQ_ANIM_INDEX[name])!;
      expect(clip.o.every((v) => v === 0)).toBe(true);
    }
  });
});
