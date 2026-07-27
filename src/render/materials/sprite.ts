/**
 * EverTactics — GPU palette-swapped unit sprite material.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Every sheet in `public/assets/sprites/` is an **8-bit colour-mapped PNG** (PNG
 * colour type 3) carrying a 16-entry PLTE and *no* tRNS chunk — palette index 0
 * is the FFT transparency slot. That is the original indexed art, undamaged, so
 * there is no quantisation step and no "nearest colour" guessing anywhere in this
 * file: we parse the PNG ourselves, keep the index bytes, and upload them as an
 * R8 texture. The fragment shader reads the index and looks it up in a 16 x N
 * palette LUT built from the matching `.act` files in `public/assets/palettes/`.
 *
 * Recolouring a unit for its team is therefore a single uniform write
 * (`uPaletteRow`), costs nothing, and is exactly how the original engine did it.
 *
 * Verified against the shipped assets:
 *   - 457/457 sheets are colour type 3, bit depth 8, non-interlaced, 16-entry PLTE.
 *   - 416/457 have a `.act` family whose `battle_pal1` is byte-identical to the
 *     PNG's own PLTE, which is what `SHEET_PALETTE_FAMILY` in `sprites.ts` records.
 *     The remaining 41 (Dark Knight, Onion Knight, the TWotL guests) have no `.act`
 *     family shipped; they render from their baked palette only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE MATERIAL DOES
 * ─────────────────────────────────────────────────────────────────────────────
 * It is a patched `MeshLambertMaterial`, not a from-scratch `ShaderMaterial`, so
 * the sprites sit inside three's real lighting/shadow/tone-mapping/fog pipeline
 * rather than a parallel one that drifts out of sync with the terrain. On top of
 * that we inject:
 *
 *   • palette lookup (replaces `map_fragment`),
 *   • hard alpha cut-off — `discard`, never blending, because pixel art with soft
 *     edges is the single most obvious "this is a cheap HD-2D knock-off" tell,
 *   • an *impostor normal* so a flat quad still turns with the key light,
 *   • full scene lighting — key, hemisphere, ambient **and every dynamic VFX
 *     point light** — with the direct term discounted (`uDirectGain`) because a
 *     billboard always faces the light and would otherwise out-expose the
 *     terrain it stands on,
 *   • ground bounce into the legs and a contact ramp at the feet, which is what
 *     actually welds a unit to its tile,
 *   • two silhouette rim lights derived from the 1-texel alpha gradient — warm
 *     on the key side, cool on the fill side — weighted so a light behind the
 *     *camera* rims nothing and a light behind the *subject* haloes evenly,
 *   • flash / tint / desaturation for damage, status and KO,
 *   • a chunky per-texel dissolve for the crystal effect,
 *   • a matching `MeshDepthMaterial` so the same alpha cut-out is respected when
 *     the unit casts into the shadow map, pushed back along the light so the
 *     card does not shadow itself.
 *
 * Uniform objects are shared by reference into `shader.uniforms`, so mutating
 * `bundle.uniforms.uFlash.value` takes effect immediately with no recompilation.
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Indexed PNG decoding
// ─────────────────────────────────────────────────────────────────────────────

/** A decoded colour-mapped image: raw palette indices plus the baked palette. */
export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  /**
   * One byte per pixel, **bottom-up** (row 0 of the array is the bottom row of
   * the image) so that texture V increases upward and frame rectangles can be
   * expressed without a flip anywhere else in the codebase.
   */
  readonly indices: Uint8Array;
  /** The PNG's own PLTE, 16 RGB triplets (48 bytes). */
  readonly palette: Uint8Array;
  /** Per-index alpha from tRNS, or the FFT default (index 0 transparent). */
  readonly alpha: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('sprite: DecompressionStream is unavailable; cannot decode PNG IDAT.');
  }
  // `data` is a view into the fetched buffer; Blob copies it, which is what we want.
  const blob = new Blob([data as unknown as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function readChunks(bytes: Uint8Array): PngChunk[] {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('sprite: not a PNG.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let p = 8;
  while (p + 8 <= bytes.length) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(
      bytes[p + 4] ?? 0,
      bytes[p + 5] ?? 0,
      bytes[p + 6] ?? 0,
      bytes[p + 7] ?? 0,
    );
    chunks.push({ type, data: bytes.subarray(p + 8, p + 8 + length) });
    if (type === 'IEND') break;
    p += 12 + length;
  }
  return chunks;
}

/** Reverse the PNG scanline filters in place-ish, producing raw index bytes. */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] ?? 0;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i] ?? 0;
      const a = i >= bpp ? (out[rowStart + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prevStart + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (out[prevStart + i - bpp] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const pred = a + b - c;
          const pa = Math.abs(pred - a);
          const pb = Math.abs(pred - b);
          const pc = Math.abs(pred - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`sprite: unsupported PNG filter ${filter}.`);
      }
      out[rowStart + i] = v & 0xff;
    }
    p += stride;
  }
  return out;
}

/** Expand sub-byte palette indices (bit depth 1/2/4) to one byte each. */
function expandBits(packed: Uint8Array, width: number, height: number, depth: number): Uint8Array {
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  const packedStride = Math.ceil(width / perByte);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = packed[y * packedStride + Math.floor(x / perByte)] ?? 0;
      const shift = 8 - depth * ((x % perByte) + 1);
      out[y * width + x] = (byte >> shift) & mask;
    }
  }
  return out;
}

/**
 * Decode a colour-mapped PNG to raw palette indices.
 *
 * Deliberately narrow: colour type 3 only, non-interlaced. Every sheet we ship
 * satisfies that, and silently accepting an RGB PNG here would mean silently
 * losing the index information the whole palette system depends on.
 */
export async function decodeIndexedPng(buffer: ArrayBuffer): Promise<IndexedImage> {
  const bytes = new Uint8Array(buffer);
  const chunks = readChunks(bytes);

  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('sprite: PNG has no IHDR.');
  const header = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const bitDepth = ihdr.data[8] ?? 0;
  const colourType = ihdr.data[9] ?? 0;
  const interlace = ihdr.data[12] ?? 0;

  if (colourType !== 3) {
    throw new Error(
      `sprite: expected an indexed PNG (colour type 3), got ${colourType}. ` +
        'The palette swap needs the original index data.',
    );
  }
  if (interlace !== 0) throw new Error('sprite: interlaced PNGs are not supported.');

  const plteChunk = chunks.find((c) => c.type === 'PLTE');
  if (!plteChunk) throw new Error('sprite: indexed PNG has no PLTE.');

  const palette = new Uint8Array(16 * 3);
  palette.set(plteChunk.data.subarray(0, Math.min(48, plteChunk.data.length)));

  // No tRNS in the FFT sheets: index 0 is the transparency slot by convention.
  const alpha = new Uint8Array(16).fill(255);
  const trns = chunks.find((c) => c.type === 'tRNS');
  if (trns) {
    for (let i = 0; i < Math.min(16, trns.data.length); i++) alpha[i] = trns.data[i] ?? 255;
  } else {
    alpha[0] = 0;
  }

  const idat = chunks.filter((c) => c.type === 'IDAT');
  let total = 0;
  for (const c of idat) total += c.data.length;
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const c of idat) {
    compressed.set(c.data, offset);
    offset += c.data.length;
  }

  const inflated = await inflate(compressed);
  const perByte = 8 / bitDepth;
  const packedWidth = bitDepth === 8 ? width : Math.ceil(width / perByte);
  const filtered = unfilter(inflated, packedWidth, height, 1);
  const topDown = bitDepth === 8 ? filtered : expandBits(filtered, width, height, bitDepth);

  // Flip to bottom-up so texture V matches world up.
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    indices.set(topDown.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
  }

  return { width, height, indices, palette, alpha };
}

/** Fetch and decode an indexed sprite sheet. */
export async function loadIndexedImage(url: string): Promise<IndexedImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`sprite: failed to load ${url} (${response.status}).`);
  const buffer = await response.arrayBuffer();
  try {
    return await decodeIndexedPng(buffer);
  } catch (error) {
    throw new Error(`sprite: ${url} — ${(error as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// .act palettes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an Adobe Color Table. The FFT toolkit writes 256 triplets padded to 768
 * bytes (+4 trailing bytes); only the first 16 entries are the sprite palette.
 */
export function parseActPalette(buffer: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 48) throw new Error('sprite: .act file is shorter than 16 colours.');
  return bytes.slice(0, 48);
}

/** Load one `.act` palette. */
export async function loadActPalette(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`sprite: failed to load ${url} (${response.status}).`);
  return parseActPalette(await response.arrayBuffer());
}

/**
 * Unused palette slots in the shipped `.act` set are all-black rather than
 * absent, so they must be filtered out before a team colour is chosen.
 */
export function isPaletteEmpty(palette: Uint8Array): boolean {
  // Ignore index 0 — it is the transparency slot and legitimately black.
  for (let i = 3; i < 48; i++) {
    if ((palette[i] ?? 0) !== 0) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Textures
// ─────────────────────────────────────────────────────────────────────────────

/** Upload palette indices as a single-channel R8 texture. */
export function createIndexTexture(image: IndexedImage): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    image.indices,
    image.width,
    image.height,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build the palette LUT: 16 columns (one per index) x N rows (one per slot).
 * Alpha comes from the source image's transparency mask so index 0 stays cut out
 * no matter which slot is selected.
 */
export function createPaletteTexture(
  palettes: readonly Uint8Array[],
  alpha: Uint8Array,
): THREE.DataTexture {
  const rows = Math.max(1, palettes.length);
  const data = new Uint8Array(16 * rows * 4);
  for (let row = 0; row < rows; row++) {
    const palette = palettes[row] ?? palettes[0];
    for (let i = 0; i < 16; i++) {
      const o = (row * 16 + i) * 4;
      data[o] = palette?.[i * 3] ?? 0;
      data[o + 1] = palette?.[i * 3 + 1] ?? 0;
      data[o + 2] = palette?.[i * 3 + 2] ?? 0;
      data[o + 3] = alpha[i] ?? 255;
    }
  }
  const texture = new THREE.DataTexture(data, 16, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// ─────────────────────────────────────────────────────────────────────────────
// Material
// ─────────────────────────────────────────────────────────────────────────────

export interface SpriteUniforms {
  uIndexMap: { value: THREE.Texture | null };
  uPalette: { value: THREE.Texture | null };
  uPaletteRow: { value: number };
  uPaletteRows: { value: number };
  /** (u0, v0, du, dv) of the current frame inside the sheet. */
  uFrameRect: { value: THREE.Vector4 };
  /** Size of the frame in texels — drives the dissolve grain and edge taps. */
  uFrameTexels: { value: THREE.Vector2 };
  /** 1 / sheet size, in UV units. */
  uTexelStep: { value: THREE.Vector2 };
  /** 1 when the frame is drawn mirrored (the sheets only draw left-facing art). */
  uMirror: { value: number };

  /** How much scene light modulates the art. 1 = fully lit, 0 = flat. */
  uLightInfluence: { value: number };
  /** Scales the Lambert accumulation before it is applied to the art. */
  uLightGain: { value: number };
  /**
   * Reflectance of the art, treated as a real albedo.
   *
   * FFT palettes are authored as *finished display colours* — a white mage's
   * robe is 0.95 because that is how bright it should look on a CRT, not
   * because linen reflects 95% of the light hitting it. Feeding that straight
   * into a lighting model whose key runs at 6 candela produces a figure two
   * stops above the stone it stands on, which is precisely the "pasted GIF"
   * read. Scaling the palette down to a plausible reflectance puts the unit
   * back in the terrain's value range without touching a single texel of art.
   */
  uAlbedoScale: { value: number };
  /**
   * Shoulder on the *albedo*, not on the light. See {@link SPRITE_ALBEDO_SHOULDER}.
   *
   * A flat `uAlbedoScale` is the wrong tool on its own: dividing every palette
   * entry by the same number darkens a black leather boot as hard as it darkens
   * a white robe, and the boot was already sitting under the terrain. Measured
   * on the round-3 frame, the white-robed mage read luma 154 against grass at
   * 40 — 3.8x — while the knight two tiles away read 59, i.e. correct. The
   * defect lives entirely at the top of the palette, so the correction has to
   * live there too: a Reinhard-shaped roll-off pinned so mid reflectances pass
   * through unchanged and only the near-white entries come down.
   */
  uAlbedoShoulder: { value: number };
  /** Reflectance the shoulder leaves untouched. Everything below it lifts slightly. */
  uAlbedoPivot: { value: number };
  /**
   * Highlight shoulder on the accumulated light. Above `uShadeKnee` the shade
   * term compresses instead of climbing, so a billboard that catches the key
   * dead-on cannot out-expose a terrain surface at the same orientation.
   *
   * **Round-3 measurement.** At knee 0.85 / compress 1.6 this was not a shoulder,
   * it was a clamp. Rendering `spriteShade` straight to the framebuffer, every
   * unit in `battle-open` came back at 230–242/255 — the mage standing in the
   * shaded garden, the knight in the lantern pool and the archer on the sunlit
   * ledge were within 5% of each other, even though their *direct* terms
   * differed by 3.5x. That is precisely the critics' "sprites carry flat baked
   * shading; a unit in shadow and a unit in a warm pool have identical internal
   * contrast". The knee now sits above the range the terrain works in, so the
   * spread survives and only a genuine over-exposure gets compressed.
   */
  uShadeKnee: { value: number };
  uShadeCompress: { value: number };
  /**
   * Weight on the *indirect* term (hemisphere + ambient probe).
   *
   * The rig runs hemi 1.25 plus ambient 0.42 so the terrain's crevices do not
   * crush; a billboard, presenting a full hemisphere to that fill, collects
   * essentially all of it, and the resulting floor was high enough on its own to
   * saturate the shade term with the key completely occluded. Discounting the
   * indirect term is what lets a shadowed unit actually go dark, and it is the
   * counterpart to `uDirectGain` doing the same job for the key.
   */
  uIndirectGain: { value: number };
  /**
   * How much indirect light the *feet* lose relative to the *head*. See the sky
   * occlusion block in the fragment shader: a flat card collects the hemisphere
   * uniformly down its whole height, which is why a unit with the key occluded
   * renders as one value from crown to boot.
   */
  uSkyOcclusion: { value: number };
  /**
   * Chroma pull toward the scene. Shipped HD-2D never leaves a sprite at 100%
   * palette saturation over a graded map — the FFT night frames desaturate and
   * cool every unit until it belongs to the light. `uSceneTint` is multiplied
   * in and `uGradeSaturation` pulls the art toward its own luma; both are
   * subtle by design, because overdoing it turns pixel art to mud.
   */
  uSceneTint: { value: THREE.Color };
  uGradeSaturation: { value: number };
  /**
   * Extra weight on the *direct* term only. A billboard always turns to face the
   * camera, so it presents a near-perfect normal to any key light on the camera's
   * side and soaks up more of it than any terrain surface ever does — which is
   * precisely what makes a sprite read as brighter than the world it stands in.
   * Discounting the direct term (and only the direct term) puts a unit back at
   * the same exposure as the stone under its feet, without flattening the
   * shading the way a global influence cut would.
   */
  uDirectGain: { value: number };
  /**
   * Light the art still receives when the key is fully occluded. Keeps a unit in
   * shadow sitting in the map's cool tone instead of crushing to black — the FFT
   * reference never has a silhouette that reads as a hole.
   */
  uAmbientFloor: { value: THREE.Color };
  /** Curvature of the impostor normal. 0 = flat card, 1 = strongly cylindrical. */
  uShadeBend: { value: number };
  /** Key light travel direction in world space, for the silhouette rim. */
  uKeyLightDir: { value: THREE.Vector3 };
  /** Fill/back light travel direction — drives the cool counter-rim. */
  uFillLightDir: { value: THREE.Vector3 };
  uRimColor: { value: THREE.Color };
  uRimStrength: { value: number };
  uBackRimColor: { value: THREE.Color };
  uBackRimStrength: { value: number };

  /**
   * Ground bounce. Terrain-coloured light rising into the lower half of the
   * figure — the cheapest, most convincing "this unit is standing *in* the
   * scene" cue there is, and the thing that keeps legs from reading as cut-out.
   */
  uBounceColor: { value: THREE.Color };
  uBounceStrength: { value: number };

  /** Occlusion baked into the lowest texels of the art, where it meets the tile. */
  uFootShade: { value: number };
  /** Height of that ramp, in texels. */
  uFootShadeTexels: { value: number };
  /** 0 while the unit is airborne, so the feet contact term lifts with the hop. */
  uGrounded: { value: number };

  /** Damage / heal flash. */
  uFlashColor: { value: THREE.Color };
  uFlash: { value: number };
  /** Multiplicative status tint (poison green, petrify grey…). */
  uTint: { value: THREE.Color };
  /** 1 = full colour, 0 = greyscale (KO, petrify). */
  uSaturation: { value: number };
  /** Overall brightness scale — used to sink KO'd units into the dark. */
  uBrightness: { value: number };

  /** 0 = solid, 1 = fully dissolved. Chunky per-texel, not a smooth fade. */
  uDissolve: { value: number };
  uDissolveColor: { value: THREE.Color };
  uDissolveGlow: { value: number };

  /** Fade for transparent/stealth. Applied by cutting texels, not by blending. */
  uOpacity: { value: number };
  /** Palette alpha below this is discarded. */
  uAlphaCut: { value: number };

  /**
   * How far, in world units, the quad is pushed away from the key light **in the
   * shadow pass only**. See {@link DEPTH_PROJECT_VERTEX} — this is what stops a
   * billboard from casting a shadow onto itself.
   */
  uShadowPush: { value: number };
}

export interface SpriteMaterialBundle {
  readonly material: THREE.MeshLambertMaterial;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  readonly uniforms: SpriteUniforms;
  /** Point the material at one cell of the sheet. */
  setFrame(u0: number, v0: number, du: number, dv: number, mirror: boolean): void;
  dispose(): void;
}

export interface SpriteMaterialOptions {
  indexMap: THREE.Texture;
  palette: THREE.DataTexture;
  paletteRows: number;
  sheetWidth: number;
  sheetHeight: number;
  frameWidth: number;
  frameHeight: number;
  /** Defaults to 1 — the sprites live in the same light as the terrain. */
  lightInfluence?: number;
  lightGain?: number;
  directGain?: number;
  albedoScale?: number;
  albedoShoulder?: number;
  albedoPivot?: number;
  shadeKnee?: number;
  shadeCompress?: number;
  indirectGain?: number;
  skyOcclusion?: number;
  sceneTint?: THREE.ColorRepresentation;
  gradeSaturation?: number;
  ambientFloor?: THREE.ColorRepresentation;
  shadeBend?: number;
  rimColor?: THREE.ColorRepresentation;
  rimStrength?: number;
  backRimColor?: THREE.ColorRepresentation;
  backRimStrength?: number;
  bounceColor?: THREE.ColorRepresentation;
  bounceStrength?: number;
  keyLightDirection?: THREE.Vector3;
  fillLightDirection?: THREE.Vector3;
}

const SPRITE_DECLARATIONS = /* glsl */ `
uniform sampler2D uIndexMap;
uniform sampler2D uPalette;
uniform float uPaletteRow;
uniform float uPaletteRows;
uniform vec4  uFrameRect;
uniform vec2  uFrameTexels;
uniform vec2  uTexelStep;
uniform float uMirror;
uniform float uLightInfluence;
uniform float uLightGain;
uniform float uDirectGain;
uniform float uAlbedoScale;
uniform float uAlbedoShoulder;
uniform float uAlbedoPivot;
uniform float uShadeKnee;
uniform float uShadeCompress;
uniform float uIndirectGain;
uniform float uSkyOcclusion;
uniform vec3  uSceneTint;
uniform float uGradeSaturation;
uniform vec3  uAmbientFloor;
uniform float uShadeBend;
uniform vec3  uKeyLightDir;
uniform vec3  uFillLightDir;
uniform vec3  uRimColor;
uniform float uRimStrength;
uniform vec3  uBackRimColor;
uniform float uBackRimStrength;
uniform vec3  uBounceColor;
uniform float uBounceStrength;
uniform float uFootShade;
uniform float uFootShadeTexels;
uniform float uGrounded;
uniform vec3  uFlashColor;
uniform float uFlash;
uniform vec3  uTint;
uniform float uSaturation;
uniform float uBrightness;
uniform float uDissolve;
uniform vec3  uDissolveColor;
uniform float uDissolveGlow;
uniform float uOpacity;
uniform float uAlphaCut;

varying vec2 vSpriteUv;
varying vec3 vQuadRight;
varying vec3 vQuadUp;

/** Quad UV (already mirrored) -> sheet UV, clamped to the frame so cells never bleed. */
vec2 spriteSheetUv(vec2 cellUv) {
  vec2 c = clamp(cellUv, vec2(0.0), vec2(1.0));
  return uFrameRect.xy + c * uFrameRect.zw;
}

float spriteIndex(vec2 cellUv) {
  return floor(texture2D(uIndexMap, spriteSheetUv(cellUv)).r * 255.0 + 0.5);
}

vec4 spritePalette(float index) {
  return texture2D(
    uPalette,
    vec2((index + 0.5) / 16.0, (uPaletteRow + 0.5) / uPaletteRows)
  );
}

float spriteAlphaAt(vec2 cellUv) {
  // Outside the cell there is nothing, so the silhouette closes at the border.
  if (cellUv.x < 0.0 || cellUv.x > 1.0 || cellUv.y < 0.0 || cellUv.y > 1.0) return 0.0;
  return spritePalette(spriteIndex(cellUv)).a;
}

float spriteHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/**
 * How strongly a light rims the silhouette at a point whose outward edge normal
 * (in the quad's screen plane) is \`outward\`.
 *
 * \`lightView\` is the light's *travel* direction in view space. Its z component
 * says where the light stands relative to the camera: positive means it is
 * travelling toward the lens, i.e. it is behind the subject and backlights it;
 * negative means it is behind the camera and can produce no rim at all. The xy
 * component is the lateral part that picks an edge.
 */
float spriteRimTerm(vec3 lightView, vec2 outward) {
  vec2 plane = vec2(dot(lightView, vQuadRight), dot(lightView, vQuadUp));
  float lateral = length(plane);
  float side = 0.0;
  if (lateral > 1e-4) {
    float facing = clamp(dot(outward, -plane / lateral), 0.0, 1.0);
    side = facing * facing * facing * lateral;
  }
  // A pure backlight haloes the whole silhouette evenly; weight it well below
  // the directional term. This used to be 0.3, and once the art was graded down
  // to the terrain's value range that constant alone was enough to trace a hard
  // saturated keyline round every unit — including the interior gaps between an
  // arm and a torso, where nothing physical could produce one. The reference
  // halo is a soft bloom off the silhouette, not a stroke.
  float halo = clamp(lightView.z, 0.0, 1.0) * 0.12;
  return clamp(side + halo, 0.0, 1.0);
}
`;

const SPRITE_VERTEX_TAIL = /* glsl */ `
  vSpriteUv = uv;
  vQuadRight = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  vQuadUp    = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
`;

/**
 * Palette lookup. `diffuseColor` is deliberately left white so that the Lambert
 * accumulation downstream produces *pure incoming light*, which we then apply to
 * the art ourselves with a controllable influence. Multiplying the art into
 * `diffuseColor` instead would make the sprites obey three's full BRDF and read
 * as plastic.
 */
const SPRITE_MAP_FRAGMENT = /* glsl */ `
  vec2 spriteCellUv = vSpriteUv;
  if (uMirror > 0.5) spriteCellUv.x = 1.0 - spriteCellUv.x;

  float spriteIdx = spriteIndex(spriteCellUv);
  vec4 spriteTexel = spritePalette(spriteIdx);
  vec3 spriteAlbedo = spriteTexel.rgb;
  diffuseColor.rgb = vec3(1.0);
  diffuseColor.a = spriteTexel.a;
`;

const SPRITE_ALPHATEST_FRAGMENT = /* glsl */ `
  if (diffuseColor.a < uAlphaCut) discard;

  // Chunky texel-quantised dissolve. Smooth noise here would look like a fade,
  // and the crystal effect has to read as the art breaking apart.
  vec2 spriteTexelId = floor(spriteCellUv * uFrameTexels);
  float spriteNoise = spriteHash(spriteTexelId);
  if (uDissolve > 0.0 && spriteNoise < uDissolve) discard;

  // Stealth / transparency also cuts texels rather than blending, so the art
  // keeps hard edges and still writes depth.
  if (uOpacity < 1.0 && spriteHash(spriteTexelId + 17.0) > uOpacity) discard;
`;

/**
 * Impostor normal: bend the flat card into a soft cylinder (plus a gentler
 * vertical dome) expressed in the quad's own view-space basis. Without this every
 * unit is lit identically no matter where the key light is, which is the thing
 * that makes billboards look pasted on.
 */
const SPRITE_NORMAL_FRAGMENT = /* glsl */ `
  vec3 normal = normalize(vNormal);
  {
    vec2 nq = spriteCellUv * 2.0 - 1.0;
    vec3 bent = normal
      + vQuadRight * (nq.x * uShadeBend)
      + vQuadUp * (nq.y * uShadeBend * 0.45);
    normal = normalize(bent);
  }
  vec3 nonPerturbedNormal = normal;
`;

const SPRITE_OUTPUT_FRAGMENT = /* glsl */ `
  // ── scene light ────────────────────────────────────────────────────────────
  // diffuseColor was left white above, so this accumulation is *pure incoming
  // light* including the key, the hemisphere fill, the ambient bounce and every
  // dynamic VFX point light in range. Applying it at full influence is what puts
  // the unit inside the diorama instead of on top of it; uAmbientFloor is the
  // only thing keeping a fully shadowed unit from crushing to black.
  vec3 spriteDirect = reflectedLight.directDiffuse * uDirectGain;
  vec3 spriteLight = spriteDirect + reflectedLight.indirectDiffuse * uIndirectGain;
  vec3 spriteShade = uAmbientFloor + spriteLight * uLightGain;

  // Highlight shoulder. A billboard turns to face the camera, so it presents a
  // near-perfect normal to the key and collects more of it than any terrain
  // surface ever does; uDirectGain discounts that, but on a 6-candela key the
  // remainder still climbs past 1.5 and the art clips white. Everything above
  // the knee is compressed rather than clamped, which keeps a lit unit reading
  // brighter than a shadowed one without letting it leave the frame's range.
  {
    vec3 over = max(spriteShade - vec3(uShadeKnee), vec3(0.0));
    spriteShade = min(spriteShade, vec3(uShadeKnee)) + over / (1.0 + over * uShadeCompress);
  }

  float spriteUp = clamp(spriteCellUv.y, 0.0, 1.0);

  // ── sky occlusion down the body ────────────────────────────────────────────
  // A billboard presents one horizontal normal for its whole height, so three's
  // hemisphere light hands the boots exactly as much sky as the crown — and with
  // the key occluded (which, in a walled cloister at 54 degrees, is most units
  // most of the time) that leaves the figure a single flat value. Real standing
  // figures do not work that way: the head sees the whole upper hemisphere, the
  // shins see the ground and the wall opposite. Ramping the indirect term down
  // the body is one multiply and it is what gives a unit internal modelling in
  // shadow, which is the difference between the FFT reference's units and a
  // silhouette. Ground bounce (below) then lifts the very bottom back up in the
  // terrain's colour, so the legs read as lit *by the floor* rather than as dark.
  spriteShade *= mix(1.0 - uSkyOcclusion, 1.0, smoothstep(0.0, 0.8, spriteUp));

  // Ground bounce: terrain-coloured light rising into the lower body. Grounding
  // is mostly this plus the contact darkening below — a figure whose legs are as
  // bright as its shoulders always reads as a sticker.
  float bounceK = 1.0 - smoothstep(0.0, 0.62, spriteUp);
  spriteShade += uBounceColor * (uBounceStrength * bounceK * bounceK);

  // Contact occlusion in the art itself, ramping over the lowest few texels.
  // Lifts away with the unit during a hop so it never detaches from the tile.
  float footRamp = 1.0 - smoothstep(0.0, max(uFootShadeTexels, 1.0) / max(uFrameTexels.y, 1.0), spriteUp);
  spriteShade *= 1.0 - uFootShade * footRamp * uGrounded;

  // Grade the art into the scene *before* it is lit: pull chroma toward the
  // palette's own luma and multiply the map's tone through it, so a unit shares
  // the frame's colour identity instead of importing the sheet's.
  {
    float gradeLuma = dot(spriteAlbedo, vec3(0.2126, 0.7152, 0.0722));
    spriteAlbedo = mix(vec3(gradeLuma), spriteAlbedo, uGradeSaturation) * uSceneTint;

    // Reflectance roll-off. Pinned at uAlbedoPivot so a mid-value tunic passes
    // through untouched and only the near-white entries — the white mage's robe,
    // a cream cape, the highlight ramp on steel — come down into the range the
    // stone under the unit's feet actually occupies. Reference frames measured:
    // in refs/curated/fft/press-...-mediakit-03 the brightest texel inside a unit
    // is 208 against a floor whose brightest is 134, i.e. ~1.5x. Ours was 230
    // against grass whose brightest was ~90.
    float shoulderGain = 1.0 + uAlbedoShoulder * uAlbedoPivot;
    spriteAlbedo = spriteAlbedo / (1.0 + uAlbedoShoulder * spriteAlbedo) * shoulderGain;
    spriteAlbedo *= uAlbedoScale;
  }

  vec3 spriteColor = spriteAlbedo * mix(vec3(1.0), spriteShade, uLightInfluence);

  // ── silhouette rims ────────────────────────────────────────────────────────
  // A warm rim on the key side and a cool one on the fill side, both read off
  // the 1-texel alpha gradient. Four texture taps, and it is the thing that
  // stops a billboard reading as a decal — the FFT reference does exactly this,
  // warm down one edge of the Squire and cool down the other.
  //
  // The weighting matters more than the colours. A light is only capable of
  // rimming at all when it is *behind the subject*; one sitting behind the
  // camera front-lights and rims nothing. So each light is split into
  //   • a lateral part (its projection into the quad's screen plane), which
  //     lights one edge and needs a direction, and
  //   • a backlight part (how much it travels toward the lens), which haloes the
  //     whole silhouette and needs none,
  // and anything travelling away from the camera contributes neither. Without
  // that split a key sitting near the view axis normalises a near-zero vector
  // and paints a hard, arbitrarily-placed keyline down one side of every unit.
  {
    vec2 step = vec2(uTexelStep.x / max(uFrameRect.z, 1e-6), uTexelStep.y / max(uFrameRect.w, 1e-6));
    float aL = spriteAlphaAt(spriteCellUv - vec2(step.x, 0.0));
    float aR = spriteAlphaAt(spriteCellUv + vec2(step.x, 0.0));
    float aD = spriteAlphaAt(spriteCellUv - vec2(0.0, step.y));
    float aU = spriteAlphaAt(spriteCellUv + vec2(0.0, step.y));

    // Two rings, not one.
    //
    // A single-texel ring makes the edge term exactly 1 on every boundary texel
    // and 0 one texel in, so whatever colour is added lands as a *stroke*: a hard,
    // uniform, fully saturated line tracing the whole silhouette, interior
    // gaps included. That is what a cel outline looks like, not what light
    // wrapping round a figure looks like. Weighting a second ring at half
    // strength spreads the term over two texels and turns the same energy into
    // a falloff, which is what the FFT frames actually show: a soft bloom off
    // the silhouette that fades inward.
    float aL2 = spriteAlphaAt(spriteCellUv - vec2(step.x * 2.0, 0.0));
    float aR2 = spriteAlphaAt(spriteCellUv + vec2(step.x * 2.0, 0.0));
    float aD2 = spriteAlphaAt(spriteCellUv - vec2(0.0, step.y * 2.0));
    float aU2 = spriteAlphaAt(spriteCellUv + vec2(0.0, step.y * 2.0));
    float edge1 = 1.0 - min(min(aL, aR), min(aD, aU));
    float edge2 = 1.0 - min(min(aL2, aR2), min(aD2, aU2));
    float edge = max(edge1 * 0.62, edge2 * 0.38);

    vec2 grad = vec2(aR - aL + (aR2 - aL2) * 0.5, aU - aD + (aU2 - aD2) * 0.5);
    if (dot(grad, grad) > 1e-6 && edge > 0.0) {
      vec2 outward = -normalize(grad);

      vec3 keyView = normalize((viewMatrix * vec4(uKeyLightDir, 0.0)).xyz);
      vec3 fillView = normalize((viewMatrix * vec4(uFillLightDir, 0.0)).xyz);

      // Fade the rim out at the feet: light wrapping round a silhouette is a
      // property of the parts standing clear of the ground, and a bright edge
      // on the boots un-does the contact darkening directly above it.
      float rimFoot = 1.0 - footRamp * 0.85;

      // Gate the key-side rim on the key actually reaching this unit. A figure
      // standing in the wall's shadow that still carries a bright warm edge is
      // the per-object fake rim the critics named — the rim has to be a
      // consequence of the same light everything else obeys.
      float directLuma = dot(spriteDirect, vec3(0.2126, 0.7152, 0.0722));
      float keyVisible = clamp(directLuma * 2.4, 0.0, 1.0);

      // Tint the rim by the light that is actually falling on this unit rather
      // than by the map preset's authored hue. A billboard standing beside a
      // lantern collects that lantern in the direct sum, so dividing out its
      // luma leaves the incident *chromaticity* — orange next to a brazier, cold
      // blue out under the moon — and a unit two tiles apart from another no
      // longer carries the same edge colour. This is the cheap half of "sprites
      // must take the dynamic VFX point lights": the lights already reach the
      // Lambert sum, but until now every rim in the frame was the same swatch.
      vec3 incident = directLuma > 1e-4
        ? mix(vec3(1.0), spriteDirect / directLuma, 0.7)
        : vec3(1.0);

      spriteColor += uRimColor * incident *
        (uRimStrength * edge * rimFoot * (0.25 + 0.75 * keyVisible) * spriteRimTerm(keyView, outward));
      spriteColor += uBackRimColor * (uBackRimStrength * edge * rimFoot * spriteRimTerm(fillView, outward));
    }
  }

  // Status colouring, then damage flash on top so a flash always reads.
  float spriteLuma = dot(spriteColor, vec3(0.2126, 0.7152, 0.0722));
  spriteColor = mix(vec3(spriteLuma), spriteColor, uSaturation) * uTint * uBrightness;
  spriteColor = mix(spriteColor, uFlashColor, clamp(uFlash, 0.0, 1.0));

  if (uDissolve > 0.0) {
    float band = 1.0 - smoothstep(uDissolve, uDissolve + 0.18, spriteNoise);
    spriteColor = mix(spriteColor, uDissolveColor, band * 0.85);
    spriteColor += uDissolveColor * (band * uDissolveGlow);
  }

  gl_FragColor = vec4(spriteColor, 1.0);
`;

/**
 * Depth-pass vertex push — the other half of the billboard shadow problem.
 *
 * Once the quad casts into the shadow map (see `shadowSide` above) it is also a
 * *receiver* of that same map, and a flat card sitting exactly on top of its own
 * recorded depth shadows itself completely: every unit renders as a black
 * silhouette. Global `shadow.bias` would fix it by destroying the terrain's own
 * self-shadowing, so the offset is applied here, to this material only.
 *
 * The light is orthographic, so translating along its view −Z is a **pure depth
 * change**: the silhouette written into the map does not move by a single texel,
 * it is merely recorded slightly further away. The unit therefore sits in front
 * of its own shadow, while ground more than `uShadowPush` further along the
 * light ray is still occluded normally.
 *
 * The cost is a small band of unshadowed floor right at the feet — the ground
 * there is less than `uShadowPush` behind the caster. That band is exactly what
 * the contact-darkening decal in `sprites.ts` covers, which is why both exist.
 */
const DEPTH_PROJECT_VERTEX = /* glsl */ `
  #include <project_vertex>
  mvPosition.z -= uShadowPush;
  gl_Position = projectionMatrix * mvPosition;
`;

const DEPTH_DECLARATIONS = /* glsl */ `
uniform sampler2D uIndexMap;
uniform sampler2D uPalette;
uniform float uPaletteRow;
uniform float uPaletteRows;
uniform vec4  uFrameRect;
uniform vec2  uFrameTexels;
uniform float uMirror;
uniform float uDissolve;
uniform float uOpacity;
uniform float uAlphaCut;
varying vec2 vSpriteUv;

float spriteHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
`;

const DEPTH_ALPHATEST_FRAGMENT = /* glsl */ `
  {
    vec2 cellUv = vSpriteUv;
    if (uMirror > 0.5) cellUv.x = 1.0 - cellUv.x;
    vec2 sheetUv = uFrameRect.xy + clamp(cellUv, vec2(0.0), vec2(1.0)) * uFrameRect.zw;
    float idx = floor(texture2D(uIndexMap, sheetUv).r * 255.0 + 0.5);
    float a = texture2D(uPalette, vec2((idx + 0.5) / 16.0, (uPaletteRow + 0.5) / uPaletteRows)).a;
    if (a < uAlphaCut) discard;
    vec2 texelId = floor(cellUv * uFrameTexels);
    if (uDissolve > 0.0 && spriteHash(texelId) < uDissolve) discard;
    if (uOpacity < 1.0 && spriteHash(texelId + 17.0) > uOpacity) discard;
  }
`;

let programCacheSalt = 0;

/**
 * Build the material pair for one sprite instance.
 *
 * One instance per unit: the per-unit state (frame, palette row, flash, tint,
 * dissolve) all lives in uniforms, and `customProgramCacheKey` keeps every
 * instance sharing a single compiled program.
 */
export function createSpriteMaterial(options: SpriteMaterialOptions): SpriteMaterialBundle {
  const uniforms: SpriteUniforms = {
    uIndexMap: { value: options.indexMap },
    uPalette: { value: options.palette },
    uPaletteRow: { value: 0 },
    uPaletteRows: { value: Math.max(1, options.paletteRows) },
    uFrameRect: {
      value: new THREE.Vector4(
        0,
        0,
        options.frameWidth / options.sheetWidth,
        options.frameHeight / options.sheetHeight,
      ),
    },
    uFrameTexels: { value: new THREE.Vector2(options.frameWidth, options.frameHeight) },
    uTexelStep: { value: new THREE.Vector2(1 / options.sheetWidth, 1 / options.sheetHeight) },
    uMirror: { value: 0 },

    uLightInfluence: { value: options.lightInfluence ?? 1 },
    uLightGain: { value: options.lightGain ?? 1 },
    uDirectGain: { value: options.directGain ?? 0.5 },
    uAlbedoScale: { value: options.albedoScale ?? 0.94 },
    uAlbedoShoulder: { value: options.albedoShoulder ?? 2.1 },
    uAlbedoPivot: { value: options.albedoPivot ?? 0.22 },
    uShadeKnee: { value: options.shadeKnee ?? 1.45 },
    uShadeCompress: { value: options.shadeCompress ?? 0.55 },
    uIndirectGain: { value: options.indirectGain ?? 0.72 },
    uSkyOcclusion: { value: options.skyOcclusion ?? 0.26 },
    uSceneTint: { value: new THREE.Color(options.sceneTint ?? 0xffffff) },
    uGradeSaturation: { value: options.gradeSaturation ?? 0.9 },
    uAmbientFloor: { value: new THREE.Color(options.ambientFloor ?? 0x2e3c5c) },
    uShadeBend: { value: options.shadeBend ?? 0.7 },
    uKeyLightDir: { value: (options.keyLightDirection ?? new THREE.Vector3(-0.5, -1, -0.35)).clone().normalize() },
    uFillLightDir: {
      value: (options.fillLightDirection ?? new THREE.Vector3(0.5, -0.6, 0.35)).clone().normalize(),
    },
    uRimColor: { value: new THREE.Color(options.rimColor ?? 0xffe6b8) },
    uRimStrength: { value: options.rimStrength ?? 0.28 },
    uBackRimColor: { value: new THREE.Color(options.backRimColor ?? 0x8fb0d8) },
    uBackRimStrength: { value: options.backRimStrength ?? 0.07 },

    uBounceColor: { value: new THREE.Color(options.bounceColor ?? 0x6d5b46) },
    uBounceStrength: { value: options.bounceStrength ?? 0.42 },

    uFootShade: { value: 0.42 },
    uFootShadeTexels: { value: 7 },
    uGrounded: { value: 1 },

    uFlashColor: { value: new THREE.Color(0xffffff) },
    uFlash: { value: 0 },
    uTint: { value: new THREE.Color(0xffffff) },
    uSaturation: { value: 1 },
    uBrightness: { value: 1 },

    uDissolve: { value: 0 },
    uDissolveColor: { value: new THREE.Color(0x9fe8ff) },
    uDissolveGlow: { value: 1.6 },

    uOpacity: { value: 1 },
    uAlphaCut: { value: 0.5 },

    uShadowPush: { value: 0.1 },
  };

  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    alphaTest: 0.5,
    side: THREE.FrontSide,
    fog: true,
  });
  material.name = 'UnitSprite';
  // ── why this line exists ───────────────────────────────────────────────────
  // three derives the shadow pass's cull side from the *object* material:
  // `side = material.shadowSide ?? shadowSide[material.side]`, and
  // `shadowSide[FrontSide]` is BackSide. That is right for closed solids (it
  // hides acne inside the mesh) and catastrophic for a single-sided billboard:
  // the quad turns to face the camera, so whenever the key light is on the
  // camera's side of the unit the light sees the quad's *front*, back-face
  // culling throws it away, and the unit casts no shadow at all. Which is
  // exactly what was happening — not one sprite had a shadow. A flat card has no
  // interior to protect, so render both faces into the map.
  material.shadowSide = THREE.DoubleSide;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vSpriteUv;\nvarying vec3 vQuadRight;\nvarying vec3 vQuadUp;',
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SPRITE_VERTEX_TAIL}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SPRITE_DECLARATIONS}`)
      .replace('#include <map_fragment>', SPRITE_MAP_FRAGMENT)
      .replace('#include <alphatest_fragment>', SPRITE_ALPHATEST_FRAGMENT)
      .replace('#include <normal_fragment_begin>', SPRITE_NORMAL_FRAGMENT)
      .replace('#include <opaque_fragment>', SPRITE_OUTPUT_FRAGMENT);
  };
  material.customProgramCacheKey = () => `evertactics-unit-sprite-${programCacheSalt}`;

  const depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  depthMaterial.name = 'UnitSpriteDepth';
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uShadowPush;\nvarying vec2 vSpriteUv;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSpriteUv = uv;')
      .replace('#include <project_vertex>', DEPTH_PROJECT_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DEPTH_DECLARATIONS}`)
      .replace('#include <alphatest_fragment>', DEPTH_ALPHATEST_FRAGMENT);
  };
  depthMaterial.customProgramCacheKey = () => `evertactics-unit-sprite-depth-${programCacheSalt}`;

  return {
    material,
    depthMaterial,
    uniforms,
    setFrame(u0, v0, du, dv, mirror) {
      uniforms.uFrameRect.value.set(u0, v0, du, dv);
      uniforms.uMirror.value = mirror ? 1 : 0;
    },
    dispose() {
      material.dispose();
      depthMaterial.dispose();
    },
  };
}

/**
 * Force every sprite program to recompile. Only useful for hot-reloading shader
 * source during development; `programCacheSalt` is otherwise constant so all
 * sprite instances share one program.
 */
export function invalidateSpritePrograms(): void {
  programCacheSalt++;
}

// ─────────────────────────────────────────────────────────────────────────────
// Team colour selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which of the 16 palette indices carry a sheet's **team colour ramp**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASURED, ROUND 3
 * ─────────────────────────────────────────────────────────────────────────────
 * Dumping `battle_knight_m_battle_pal1..5` byte-for-byte, the eight `.act` slots
 * of a generic class are not eight recolours of the whole figure — they are the
 * same figure with **one or two colour ramps swapped**:
 *
 *   knight_m idx 3,4:  384098/5870d8 (blue)  305068/4890a0 (teal)
 *                      783028/e04820 (red)   706828/c0b028 (gold)
 *   knight_m idx 11-15 (skin, leather, gold trim): near-identical in every slot.
 *
 * The previous scorer averaged the hue of *every* entry that differed from
 * `pal1` by more than ~1/25 of the range. On the shipped files that filter keeps
 * 10-14 of the 15 entries, because the toolkit nudges the skin and leather ramps
 * a few units between slots too — so the score was dominated by skin, every slot
 * measured 4-55 degrees, and **`ally` resolved to an orange slot on 6 of the 8
 * families sampled**. An ally and an enemy standing side by side were the same
 * colour, which is a gameplay-legibility bug, not just a look one.
 *
 * The ramp is instead identified by *variance across the slot set*: an index
 * whose colour is nearly constant in all eight palettes is skin or steel; an
 * index that swings from navy to scarlet is the team ramp. That is a property of
 * the data rather than of any one sheet's layout, so it works on `siro_w` (whose
 * ramp is indices 7-9) exactly as well as on `knight_m` (indices 3-6).
 */
function teamRampMask(palettes: readonly Uint8Array[]): Float64Array {
  const variance = new Float64Array(16);
  const usable = palettes.filter((p) => p && !isPaletteEmpty(p));
  if (usable.length < 2) return variance.fill(1);

  for (let i = 1; i < 16; i++) {
    let mr = 0;
    let mg = 0;
    let mb = 0;
    for (const p of usable) {
      mr += (p[i * 3] ?? 0) / 255;
      mg += (p[i * 3 + 1] ?? 0) / 255;
      mb += (p[i * 3 + 2] ?? 0) / 255;
    }
    mr /= usable.length;
    mg /= usable.length;
    mb /= usable.length;
    let sum = 0;
    for (const p of usable) {
      const dr = (p[i * 3] ?? 0) / 255 - mr;
      const dg = (p[i * 3 + 1] ?? 0) / 255 - mg;
      const db = (p[i * 3 + 2] ?? 0) / 255 - mb;
      sum += dr * dr + dg * dg + db * db;
    }
    variance[i] = Math.sqrt(sum / usable.length);
  }

  // Normalise to the loudest index and keep a soft ramp rather than a hard
  // cutoff: a sheet whose second garment also shifts slightly should still
  // contribute, just less than the ramp that swings the furthest.
  let peak = 0;
  for (let i = 1; i < 16; i++) peak = Math.max(peak, variance[i] ?? 0);
  if (peak < 1e-4) return variance.fill(1);
  for (let i = 1; i < 16; i++) {
    const t = Math.max(0, ((variance[i] ?? 0) / peak - 0.28) / 0.72);
    variance[i] = t * t;
  }
  variance[0] = 0; // transparency slot
  return variance;
}

/**
 * Palette slots are not laid out consistently across sheets: `knight_m` slot 1 is
 * teal and slot 2 is red, while `siro_w` puts blue at slot 1 and green at slot 3.
 * So rather than hard-coding "enemy = slot 1" we score the *actual colours* of
 * each slot's team ramp against a target hue and pick the closest non-empty one.
 * Data driven, and it degrades gracefully on story characters that only ship one
 * slot.
 */
export function pickPaletteSlot(
  palettes: readonly Uint8Array[],
  targetHueDegrees: number,
  taken?: ReadonlySet<number>,
): number {
  const mask = teamRampMask(palettes);

  // How much *ramp chroma* each slot carries at all. `isPaletteEmpty` only
  // rejects an all-zero table, and the shipped set contains slots that are
  // almost — but not quite — that: `battle_yumi_m_battle_pal8` and
  // `battle_thief_w_battle_pal7` have a black team ramp with a couple of stray
  // non-zero bytes elsewhere. Both were being handed to `ally` once the good
  // slots were taken, which would render that unit's garment solid black. A slot
  // has to carry a real ramp before it can represent a team.
  const chroma = new Float64Array(palettes.length);
  let peakChroma = 0;
  for (let slot = 0; slot < palettes.length; slot++) {
    const palette = palettes[slot];
    if (!palette || isPaletteEmpty(palette)) continue;
    chroma[slot] = rampChroma(palette, mask);
    peakChroma = Math.max(peakChroma, chroma[slot] ?? 0);
  }
  const floor = peakChroma * 0.3;

  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let slot = 0; slot < palettes.length; slot++) {
    if (taken?.has(slot)) continue;
    const palette = palettes[slot];
    if (!palette || isPaletteEmpty(palette)) continue;
    if ((chroma[slot] ?? 0) < floor) continue;
    const score = paletteHueScore(palette, targetHueDegrees, mask);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = slot;
    }
  }
  return bestIndex;
}

/** Total chroma a palette carries across its team ramp. See {@link pickPaletteSlot}. */
function rampChroma(palette: Uint8Array, mask: Float64Array): number {
  let total = 0;
  for (let i = 1; i < 16; i++) {
    const w = mask[i] ?? 0;
    if (w <= 1e-3) continue;
    const r = (palette[i * 3] ?? 0) / 255;
    const g = (palette[i * 3 + 1] ?? 0) / 255;
    const b = (palette[i * 3 + 2] ?? 0) / 255;
    total += (Math.max(r, g, b) - Math.min(r, g, b)) * w;
  }
  return total;
}

/**
 * Score how strongly a palette's team ramp leans toward `targetHue`.
 *
 * `mask` weights each of the 16 indices by how much that index varies across the
 * sheet's whole slot set — see {@link teamRampMask}. Skin, hair and steel are
 * shared between team variants and score ~0, so they can no longer wash every
 * slot toward the same warm average.
 */
function paletteHueScore(
  palette: Uint8Array,
  targetHueDegrees: number,
  mask: Float64Array,
): number {
  const target = (targetHueDegrees * Math.PI) / 180;
  let score = 0;
  let weight = 0;
  for (let i = 1; i < 16; i++) {
    const rampWeight = mask[i] ?? 0;
    if (rampWeight <= 1e-3) continue;
    const r = (palette[i * 3] ?? 0) / 255;
    const g = (palette[i * 3 + 1] ?? 0) / 255;
    const b = (palette[i * 3 + 2] ?? 0) / 255;
    if (r + g + b === 0) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < 0.06) continue;

    let hue: number;
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue = (hue * Math.PI) / 3;

    // Cosine similarity on the hue circle, weighted by how saturated the entry
    // is *and* by how strongly it belongs to the team ramp.
    const w = chroma * rampWeight;
    score += Math.cos(hue - target) * w;
    weight += w;
  }
  // Normalise: without this a palette simply carrying *more* colour beats one
  // whose colour is actually the right hue, and every team resolves to the same
  // gaudiest slot.
  return weight > 1e-4 ? score / weight : -Infinity;
}

/** Target hues used by {@link pickPaletteSlot} for the four teams. */
export const TEAM_TARGET_HUE: Readonly<Record<'player' | 'enemy' | 'ally' | 'neutral', number>> = {
  player: 225, // blue
  enemy: 8, // red
  ally: 135, // green
  neutral: 45, // yellow / gold
};
