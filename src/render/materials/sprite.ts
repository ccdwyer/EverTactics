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
 *   • a silhouette rim light derived from the 1-texel alpha gradient and the key
 *     light's screen-plane direction (so the rim lands on the lit edge only),
 *   • flash / tint / desaturation for damage, status and KO,
 *   • a chunky per-texel dissolve for the crystal effect,
 *   • a matching `MeshDepthMaterial` so the same alpha cut-out is respected when
 *     the unit casts into the shadow map.
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
  /** Curvature of the impostor normal. 0 = flat card, 1 = strongly cylindrical. */
  uShadeBend: { value: number };
  /** Key light travel direction in world space, for the silhouette rim. */
  uKeyLightDir: { value: THREE.Vector3 };
  uRimColor: { value: THREE.Color };
  uRimStrength: { value: number };

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
  /** Defaults to a restrained 0.55 — pixel art dies under heavy shading. */
  lightInfluence?: number;
  shadeBend?: number;
  rimColor?: THREE.ColorRepresentation;
  rimStrength?: number;
  keyLightDirection?: THREE.Vector3;
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
uniform float uShadeBend;
uniform vec3  uKeyLightDir;
uniform vec3  uRimColor;
uniform float uRimStrength;
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
  vec3 spriteLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
  vec3 spriteColor = spriteAlbedo * mix(vec3(1.0), spriteLight, uLightInfluence);

  // Silhouette rim from the 1-texel alpha gradient, restricted to the edge that
  // faces the key light. Cheap (4 taps) and it is what welds the unit to the
  // scene lighting instead of looking like a decal.
  {
    vec2 step = vec2(uTexelStep.x / max(uFrameRect.z, 1e-6), uTexelStep.y / max(uFrameRect.w, 1e-6));
    float aL = spriteAlphaAt(spriteCellUv - vec2(step.x, 0.0));
    float aR = spriteAlphaAt(spriteCellUv + vec2(step.x, 0.0));
    float aD = spriteAlphaAt(spriteCellUv - vec2(0.0, step.y));
    float aU = spriteAlphaAt(spriteCellUv + vec2(0.0, step.y));
    float edge = 1.0 - min(min(aL, aR), min(aD, aU));
    vec2 grad = vec2(aR - aL, aU - aD);
    if (dot(grad, grad) > 1e-6 && edge > 0.0) {
      vec2 outward = -normalize(grad);
      vec3 lightView = normalize((viewMatrix * vec4(uKeyLightDir, 0.0)).xyz);
      vec2 lightPlane = vec2(dot(lightView, vQuadRight), dot(lightView, vQuadUp));
      if (dot(lightPlane, lightPlane) > 1e-6) {
        float facing = clamp(dot(outward, -normalize(lightPlane)), 0.0, 1.0);
        spriteColor += uRimColor * (uRimStrength * edge * facing * facing);
      }
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

    uLightInfluence: { value: options.lightInfluence ?? 0.55 },
    uShadeBend: { value: options.shadeBend ?? 0.55 },
    uKeyLightDir: { value: (options.keyLightDirection ?? new THREE.Vector3(-0.5, -1, -0.35)).clone().normalize() },
    uRimColor: { value: new THREE.Color(options.rimColor ?? 0xffe6b8) },
    uRimStrength: { value: options.rimStrength ?? 0.5 },

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
  });
  depthMaterial.name = 'UnitSpriteDepth';
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSpriteUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSpriteUv = uv;');
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
 * Palette slots are not laid out consistently across sheets: `knight_m` slot 2 is
 * teal and slot 3 is red, while `kuro_m` slot 4 is olive and slot 5 magenta. So
 * rather than hard-coding "enemy = slot 1" we score the *actual colours* in each
 * slot against a target hue and pick the closest non-empty one. Data driven, and
 * it degrades gracefully on story characters that only ship one slot.
 */
export function pickPaletteSlot(
  palettes: readonly Uint8Array[],
  targetHueDegrees: number,
  baseline?: Uint8Array,
  taken?: ReadonlySet<number>,
): number {
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let slot = 0; slot < palettes.length; slot++) {
    if (taken?.has(slot)) continue;
    const palette = palettes[slot];
    if (!palette || isPaletteEmpty(palette)) continue;
    const score = paletteHueScore(palette, targetHueDegrees, baseline);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = slot;
    }
  }
  return bestIndex;
}

/**
 * Score how strongly a palette leans toward `targetHue`.
 *
 * Only entries that actually *differ* from the baseline palette are considered
 * when a baseline is supplied: skin, hair and metal are shared across team
 * variants, and including them washes every slot toward the same average.
 */
function paletteHueScore(
  palette: Uint8Array,
  targetHueDegrees: number,
  baseline?: Uint8Array,
): number {
  const target = (targetHueDegrees * Math.PI) / 180;
  let score = 0;
  let weight = 0;
  for (let i = 1; i < 16; i++) {
    const r = (palette[i * 3] ?? 0) / 255;
    const g = (palette[i * 3 + 1] ?? 0) / 255;
    const b = (palette[i * 3 + 2] ?? 0) / 255;
    if (r + g + b === 0) continue;

    if (baseline) {
      const dr = r - (baseline[i * 3] ?? 0) / 255;
      const dg = g - (baseline[i * 3 + 1] ?? 0) / 255;
      const db = b - (baseline[i * 3 + 2] ?? 0) / 255;
      if (dr * dr + dg * dg + db * db < 0.0016) continue; // ~1/25 of the range
    }

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < 0.06) continue;

    let hue: number;
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue = (hue * Math.PI) / 3;

    // Cosine similarity on the hue circle, weighted by how saturated the entry is.
    score += Math.cos(hue - target) * chroma;
    weight += chroma;
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
