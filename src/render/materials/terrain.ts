/**
 * EverTactics — procedural terrain materials.
 *
 * Every surface in the diorama is authored from noise here rather than shipped as a flat
 * colour or a stock texture. The per-texel authoring lives in `textures/surfaces.ts`; this
 * file is the baking + shading half:
 *
 *   - bake each surface's albedo / normal / roughness (+ emissive) at `TEX_SIZE`,
 *   - patch the resulting `MeshStandardMaterial` so that every map read goes through a
 *     **stochastic triangle-grid tiling** blend. This is the fix for the single most
 *     obvious tell in a tile-based renderer: the same texture stamped once per tile.
 *     Each triangle of a world-space grid samples the texture at its own random offset
 *     (and, for isotropic surfaces, its own random rotation), so the pattern genuinely
 *     never repeats across the map,
 *   - multiply the baked per-vertex ambient occlusion (`aAO`) into the albedo and into
 *     indirect light, tinted toward a cool shadow rather than crushed to black,
 *   - apply low-frequency world-space macro variation on top, so whole regions of the
 *     map drift in hue and value the way hand-painted terrain does.
 *
 * UVs are baked per-face in `render/terrain.ts` using a world-space planar projection
 * along the face's dominant axis, so side faces never smear and the pattern crosses tile
 * boundaries instead of restarting at them.
 */

import * as THREE from 'three';
import type { SurfaceKind } from '@core/types';
import {
  bedTexel,
  cliffTexel,
  clothTexel,
  dirtTexel,
  foliageTexel,
  grassTexel,
  lavaTexel,
  metalTexel,
  roofTexel,
  rubbleTexel,
  sandTexel,
  snowTexel,
  stoneTexel,
  pillarTexel,
  stoneWallTexel,
  swampTexel,
  timberTexel,
  woodTexel,
  type TexelFn,
} from './textures/surfaces';
import { clamp01, wrap } from './textures/noise';

/**
 * Surface kinds plus the internal materials the terrain builder and the prop system
 * need. `stonewall` is the vertical face of masonry (coursed blocks) as distinct from
 * `stone`, the flagged floor — using one texture for both is what makes a courtyard
 * look like a texture-mapped box.
 */
export type TerrainMaterialKind =
  | SurfaceKind
  | 'cliff'
  | 'bed'
  | 'stonewall'
  | 'pillar'
  | 'timber'
  | 'foliage'
  | 'metal'
  | 'cloth'
  | 'rubble';

/** World units of terrain covered by one repeat of a surface texture. */
export const TEXTURE_WORLD_SCALE = 2;

const TEX_SIZE = 384;

// ─────────────────────────────────────────────────────────────────────────────
// Texel table
// ─────────────────────────────────────────────────────────────────────────────

const TEXELS: Record<TerrainMaterialKind, TexelFn> = {
  grass: grassTexel,
  dirt: dirtTexel,
  stone: stoneTexel,
  stonewall: stoneWallTexel,
  pillar: pillarTexel,
  sand: sandTexel,
  water: bedTexel,
  deepwater: bedTexel,
  swamp: swampTexel,
  snow: snowTexel,
  lava: lavaTexel,
  wood: woodTexel(6, 1111, false),
  roof: roofTexel,
  bridge: woodTexel(5, 1277, true),
  void: dirtTexel,
  cliff: cliffTexel,
  bed: bedTexel,
  timber: timberTexel,
  foliage: foliageTexel,
  metal: metalTexel,
  cloth: clothTexel,
  rubble: rubbleTexel,
};

/** Physical bump strength (world units) used when deriving the normal map. */
const BUMP_STRENGTH: Partial<Record<TerrainMaterialKind, number>> = {
  grass: 1.6,
  dirt: 1.8,
  stone: 2.1,
  stonewall: 2.3,
  pillar: 2.4,
  sand: 1.0,
  snow: 0.9,
  swamp: 1.2,
  wood: 1.5,
  bridge: 1.7,
  timber: 1.7,
  roof: 2.4,
  lava: 2.2,
  cliff: 2.8,
  bed: 1.2,
  foliage: 1.9,
  metal: 1.4,
  cloth: 1.1,
  rubble: 2.4,
};

// ─────────────────────────────────────────────────────────────────────────────
// Texture baking
// ─────────────────────────────────────────────────────────────────────────────

interface BakedMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

function makeTexture(data: Uint8ClampedArray, size: number, srgb: boolean): THREE.Texture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function bake(kind: TerrainMaterialKind): BakedMaps {
  const size = TEX_SIZE;
  const fn = TEXELS[kind];
  const albedo = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  let emissive: Uint8ClampedArray | undefined;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const t = fn(x / size, y / size);
      albedo[i * 4] = clamp01(t.r) * 255;
      albedo[i * 4 + 1] = clamp01(t.g) * 255;
      albedo[i * 4 + 2] = clamp01(t.b) * 255;
      albedo[i * 4 + 3] = 255;
      const rv = clamp01(t.rough) * 255;
      rough[i * 4] = rv;
      rough[i * 4 + 1] = rv;
      rough[i * 4 + 2] = rv;
      rough[i * 4 + 3] = 255;
      height[i] = clamp01(t.h);
      if (t.e !== undefined && t.e > 0) {
        emissive ??= new Uint8ClampedArray(size * size * 4);
        emissive[i * 4] = (t.er ?? 1) * t.e * 255;
        emissive[i * 4 + 1] = (t.eg ?? 1) * t.e * 255;
        emissive[i * 4 + 2] = (t.eb ?? 1) * t.e * 255;
        emissive[i * 4 + 3] = 255;
      }
    }
  }
  if (emissive) {
    for (let i = 0; i < size * size; i++) {
      if (emissive[i * 4 + 3] === 0) emissive[i * 4 + 3] = 255;
    }
  }

  // Sobel the height field into a tangent-space normal map.
  const normal = new Uint8ClampedArray(size * size * 4);
  const strength = BUMP_STRENGTH[kind] ?? 1.5;
  const at = (x: number, y: number): number => height[wrap(y, size) * size + wrap(x, size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t0 = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l0 = at(x - 1, y);
      const r0 = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b0 = at(x, y + 1);
      const br = at(x + 1, y + 1);
      const dx = tl + 2 * l0 + bl - (tr + 2 * r0 + br);
      const dy = tl + 2 * t0 + tr - (bl + 2 * b0 + br);
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      normal[i] = (nx * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i + 2] = (nz / len) * 0.5 * 255 + 127.5;
      normal[i + 3] = 255;
    }
  }

  const maps: BakedMaps = {
    map: makeTexture(albedo, size, true),
    normalMap: makeTexture(normal, size, false),
    roughnessMap: makeTexture(rough, size, false),
  };
  if (emissive) maps.emissiveMap = makeTexture(emissive, size, true);
  return maps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shader patch: stochastic tiling + vertex AO + world-space macro variation
// ─────────────────────────────────────────────────────────────────────────────

/** Shadow tint that AO drives toward — cool, never pure black. */
const AO_TINT = new THREE.Color(0.16, 0.19, 0.30);

/**
 * Triangle-grid stochastic tiling (the Heitz/Neyret construction, with a simple
 * weight-sharpening blend instead of histogram-preserving variance correction —
 * at this camera distance the sharpened blend is indistinguishable and costs a
 * third of the instructions).
 *
 * Each vertex of the triangle grid picks a random offset and, when `uTileRotate`
 * is non-zero, a random rotation. Because the offset is constant across a triangle,
 * `dFdx(uv)` is unchanged and ordinary mip selection stays correct.
 */
const TILING_CHUNK = /* glsl */ `
uniform float uTileGrid;
uniform float uTileRotate;
uniform float uTileSharpen;

vec3 etTileW;
vec2 etTileU1;
vec2 etTileU2;
vec2 etTileU3;

vec2 etHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec2 etVariant(vec2 uv, vec2 h) {
  float a = (h.x - 0.5) * 6.2831853 * uTileRotate;
  float s = sin(a);
  float c = cos(a);
  vec2 r = mat2(c, -s, s, c) * uv;
  return r + h * 37.13 + vec2(h.y * 11.7, h.x * 7.3);
}

void etPrepareTiling(vec2 uv) {
  vec2 g = uv * uTileGrid;
  vec2 skewed = vec2(g.x - g.y * 0.57735027, g.y * 1.15470054);
  vec2 base = floor(skewed);
  vec3 t = vec3(fract(skewed), 0.0);
  t.z = 1.0 - t.x - t.y;

  vec2 n1, n2, n3;
  if (t.z > 0.0) {
    etTileW = vec3(t.z, t.y, t.x);
    n1 = base;
    n2 = base + vec2(0.0, 1.0);
    n3 = base + vec2(1.0, 0.0);
  } else {
    etTileW = vec3(-t.z, 1.0 - t.y, 1.0 - t.x);
    n1 = base + vec2(1.0, 1.0);
    n2 = base + vec2(1.0, 0.0);
    n3 = base + vec2(0.0, 1.0);
  }

  // Sharpening keeps most of the surface a single tap; only a thin seam cross-fades,
  // which is what stops the blend from reading as a soft, washed-out average.
  etTileW = pow(max(etTileW, vec3(0.0)), vec3(uTileSharpen));
  etTileW /= max(etTileW.x + etTileW.y + etTileW.z, 1e-5);

  etTileU1 = etVariant(uv, etHash22(n1));
  etTileU2 = etVariant(uv, etHash22(n2));
  etTileU3 = etVariant(uv, etHash22(n3));
}

vec4 etSampleTiled(sampler2D tex) {
  return texture2D(tex, etTileU1) * etTileW.x
       + texture2D(tex, etTileU2) * etTileW.y
       + texture2D(tex, etTileU3) * etTileW.z;
}
`;

const MACRO_CHUNK = /* glsl */ `
float etHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float etNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(etHash(i), etHash(i + vec2(1.0, 0.0)), u.x),
             mix(etHash(i + vec2(0.0, 1.0)), etHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float etFbm(vec2 p) {
  return etNoise(p) * 0.6 + etNoise(p * 2.17) * 0.28 + etNoise(p * 4.41) * 0.12;
}
`;

interface PatchOptions {
  aoStrength: number;
  macroStrength: number;
  macroScale: number;
  tileGrid: number;
  tileRotate: number;
  tileSharpen: number;
  hasNormal: boolean;
  hasRough: boolean;
  hasEmissive: boolean;
}

function patchTerrainShader(mat: THREE.MeshStandardMaterial, opts: PatchOptions): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAoTint = { value: AO_TINT };
    shader.uniforms.uAoStrength = { value: opts.aoStrength };
    shader.uniforms.uMacroStrength = { value: opts.macroStrength };
    shader.uniforms.uMacroScale = { value: opts.macroScale };
    shader.uniforms.uTileGrid = { value: opts.tileGrid };
    shader.uniforms.uTileRotate = { value: opts.tileRotate };
    shader.uniforms.uTileSharpen = { value: opts.tileSharpen };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aAO;
varying float vEtAO;
varying vec3 vEtWorld;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vEtAO = aAO;
vEtWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vEtAO;
varying vec3 vEtWorld;
uniform vec3 uAoTint;
uniform float uAoStrength;
uniform float uMacroStrength;
uniform float uMacroScale;
${TILING_CHUNK}
${MACRO_CHUNK}`,
      )
      // Prepare the stochastic tiling before the first map read of the frame.
      .replace('#include <map_fragment>', `etPrepareTiling(vMapUv);\n#include <map_fragment>`)
      .replace('texture2D( map, vMapUv )', 'etSampleTiled( map )');

    if (opts.hasRough) {
      shader.fragmentShader = shader.fragmentShader.replace(
        'texture2D( roughnessMap, vRoughnessMapUv )',
        'etSampleTiled( roughnessMap )',
      );
    }
    if (opts.hasNormal) {
      shader.fragmentShader = shader.fragmentShader.replaceAll(
        'texture2D( normalMap, vNormalMapUv )',
        'etSampleTiled( normalMap )',
      );
    }
    if (opts.hasEmissive) {
      shader.fragmentShader = shader.fragmentShader.replace(
        'texture2D( emissiveMap, vEmissiveMapUv )',
        'etSampleTiled( emissiveMap )',
      );
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
{
  // Low-frequency world-space variation on top of the stochastic tiling: this is the
  // band that makes whole *regions* of the map differ, not just adjacent tiles.
  float m = etFbm(vEtWorld.xz * uMacroScale + vEtWorld.y * 0.07);
  float m2 = etFbm(vEtWorld.xz * uMacroScale * 3.7 + 11.3);
  float m3 = etFbm(vEtWorld.xz * uMacroScale * 0.31 + 47.1);
  vec3 macro = vec3(1.0 + (m - 0.5) * 0.46, 1.0 + (m - 0.5) * 0.38, 1.0 + (m - 0.5) * 0.28);
  diffuseColor.rgb *= mix(vec3(1.0), macro, uMacroStrength);
  diffuseColor.rgb *= 1.0 + (m2 - 0.5) * 0.10 * uMacroStrength;
  diffuseColor.rgb *= 1.0 + (m3 - 0.5) * 0.24 * uMacroStrength;

  // Baked crevice occlusion, tinted rather than crushed to black.
  float ao = clamp(vEtAO, 0.0, 1.0);
  float k = pow(1.0 - ao, 1.30) * uAoStrength;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uAoTint * 1.9, k);
  diffuseColor.rgb *= mix(1.0, 0.50, k);
}`,
    );

    // Occlude indirect light too, otherwise the hemisphere fill flattens the crevices out.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
{
  float aoV = clamp(vEtAO, 0.0, 1.0);
  float occ = mix(1.0, aoV, uAoStrength);
  reflectedLight.indirectDiffuse *= occ;
  reflectedLight.indirectSpecular *= occ * occ;
}`,
    );
  };
  // Force a distinct program per configuration.
  mat.customProgramCacheKey = () =>
    `et-terrain-${opts.aoStrength}-${opts.macroStrength}-${opts.macroScale}-${
      opts.tileGrid
    }-${opts.tileRotate}-${opts.tileSharpen}-${opts.hasNormal}-${opts.hasRough}-${
      opts.hasEmissive
    }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

interface SurfaceTuning {
  /** Multiplier on the baked UVs — <1 makes one texture repeat cover more world. */
  uvScale?: number;
  roughness: number;
  metalness: number;
  color: number;
  emissive?: number;
  emissiveIntensity?: number;
  aoStrength: number;
  macroStrength: number;
  macroScale: number;
  /**
   * Density of the stochastic tiling grid, in triangles per texture repeat. Lower =
   * larger patches of a single variant (better for strongly structured patterns like
   * masonry courses, where a mid-block cross-fade would show).
   */
  tileGrid?: number;
  /** How much each variant is rotated. Must be 0 for anything with a grain direction. */
  tileRotate?: number;
  /** Blend sharpness; higher = narrower cross-fade seams. */
  tileSharpen?: number;
  normalScale?: number;
}

const TUNING: Record<TerrainMaterialKind, SurfaceTuning> = {
  grass: {
    uvScale: 1.0, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.95, macroStrength: 0.40, macroScale: 0.09,
    tileGrid: 0.9, tileRotate: 1, tileSharpen: 2.6, normalScale: 0.95,
  },
  dirt: {
    uvScale: 0.9, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.95, macroStrength: 0.5, macroScale: 0.11,
    tileGrid: 0.85, tileRotate: 1, tileSharpen: 2.6, normalScale: 0.95,
  },
  stone: {
    uvScale: 0.78, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 1.0, macroStrength: 0.26, macroScale: 0.13,
    tileGrid: 0.45, tileRotate: 0, tileSharpen: 2.2, normalScale: 1.0,
  },
  stonewall: {
    uvScale: 0.95, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 1.0, macroStrength: 0.24, macroScale: 0.12,
    tileGrid: 0.42, tileRotate: 0, tileSharpen: 2.2, normalScale: 0.95,
  },
  pillar: {
    uvScale: 1.65, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.9, macroStrength: 0.18, macroScale: 0.14,
    tileGrid: 0.5, tileRotate: 0, tileSharpen: 2.4, normalScale: 0.95,
  },
  sand: {
    uvScale: 0.85, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.9, macroStrength: 0.42, macroScale: 0.08,
    tileGrid: 0.8, tileRotate: 0, tileSharpen: 2.6,
  },
  water: {
    roughness: 1, metalness: 0, color: 0x9fb0a8,
    aoStrength: 0.9, macroStrength: 0.35, macroScale: 0.1,
    tileGrid: 0.85, tileRotate: 1, tileSharpen: 2.6,
  },
  deepwater: {
    roughness: 1, metalness: 0, color: 0x8494a0,
    aoStrength: 0.9, macroStrength: 0.35, macroScale: 0.1,
    tileGrid: 0.85, tileRotate: 1, tileSharpen: 2.6,
  },
  swamp: {
    uvScale: 0.9, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 1.0, macroStrength: 0.5, macroScale: 0.1,
    tileGrid: 0.85, tileRotate: 1, tileSharpen: 2.6,
  },
  snow: {
    uvScale: 0.8, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.75, macroStrength: 0.3, macroScale: 0.08,
    tileGrid: 0.8, tileRotate: 1, tileSharpen: 2.6,
  },
  lava: {
    uvScale: 0.7, roughness: 1, metalness: 0, color: 0xffffff,
    emissive: 0xffffff, emissiveIntensity: 2.6,
    aoStrength: 0.8, macroStrength: 0.35, macroScale: 0.1,
    tileGrid: 0.8, tileRotate: 1, tileSharpen: 2.6,
  },
  wood: {
    uvScale: 0.62, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.95, macroStrength: 0.3, macroScale: 0.12,
    tileGrid: 0.42, tileRotate: 0, tileSharpen: 2.4,
  },
  roof: {
    uvScale: 0.75, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 1.0, macroStrength: 0.35, macroScale: 0.1,
    tileGrid: 0.42, tileRotate: 0, tileSharpen: 2.4,
  },
  bridge: {
    uvScale: 0.62, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.95, macroStrength: 0.3, macroScale: 0.12,
    tileGrid: 0.42, tileRotate: 0, tileSharpen: 2.4,
  },
  void: {
    roughness: 1, metalness: 0, color: 0x222222,
    aoStrength: 1.0, macroStrength: 0.2, macroScale: 0.1,
    tileGrid: 0.85, tileRotate: 1, tileSharpen: 2.6,
  },
  cliff: {
    uvScale: 0.55, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 1.0, macroStrength: 0.24, macroScale: 0.11,
    tileGrid: 0.5, tileRotate: 0, tileSharpen: 2.4, normalScale: 1.0,
  },
  bed: {
    uvScale: 0.7, roughness: 1, metalness: 0, color: 0x9aa89e,
    aoStrength: 0.85, macroStrength: 0.35, macroScale: 0.1,
    tileGrid: 0.85, tileRotate: 1, tileSharpen: 2.6,
  },
  timber: {
    uvScale: 1.6, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.9, macroStrength: 0.28, macroScale: 0.14,
    tileGrid: 0.6, tileRotate: 0, tileSharpen: 2.4,
  },
  foliage: {
    uvScale: 1.5, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.85, macroStrength: 0.45, macroScale: 0.16,
    tileGrid: 1.1, tileRotate: 1, tileSharpen: 2.6, normalScale: 1.0,
  },
  metal: {
    uvScale: 2.2, roughness: 1, metalness: 0.75, color: 0xffffff,
    aoStrength: 0.9, macroStrength: 0.2, macroScale: 0.2,
    tileGrid: 1.0, tileRotate: 1, tileSharpen: 2.6,
  },
  cloth: {
    uvScale: 1.7, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.7, macroStrength: 0.18, macroScale: 0.18,
    tileGrid: 0.5, tileRotate: 0, tileSharpen: 2.4, normalScale: 0.7,
  },
  rubble: {
    uvScale: 1.4, roughness: 1, metalness: 0, color: 0xffffff,
    aoStrength: 0.95, macroStrength: 0.35, macroScale: 0.16,
    tileGrid: 1.1, tileRotate: 1, tileSharpen: 2.6,
  },
};

const mapCache = new Map<TerrainMaterialKind, BakedMaps>();
const matCache = new Map<TerrainMaterialKind, THREE.MeshStandardMaterial>();

/** Bake (once) and return the texture set for a surface kind. */
export function surfaceMaps(kind: TerrainMaterialKind): BakedMaps {
  let m = mapCache.get(kind);
  if (!m) {
    m = bake(kind);
    mapCache.set(kind, m);
  }
  return m;
}

/**
 * The material for a surface kind. Cached and shared — a 20x20 map therefore ends up with
 * one material (and one draw call) per distinct surface present.
 */
export function createSurfaceMaterial(kind: TerrainMaterialKind): THREE.MeshStandardMaterial {
  const cached = matCache.get(kind);
  if (cached) return cached;

  const maps = surfaceMaps(kind);
  const tune = TUNING[kind];
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: tune.roughness,
    metalness: tune.metalness,
    color: new THREE.Color(tune.color),
    dithering: true,
  });
  mat.name = `terrain-${kind}`;
  const ns = tune.normalScale ?? 0.9;
  mat.normalScale.set(ns, ns);
  const uvScale = tune.uvScale ?? 1;
  if (uvScale !== 1) {
    maps.map.repeat.setScalar(uvScale);
    maps.normalMap.repeat.setScalar(uvScale);
    maps.roughnessMap.repeat.setScalar(uvScale);
    maps.emissiveMap?.repeat.setScalar(uvScale);
  }
  const hasEmissive = maps.emissiveMap !== undefined && tune.emissive !== undefined;
  if (maps.emissiveMap && tune.emissive !== undefined) {
    mat.emissiveMap = maps.emissiveMap;
    mat.emissive = new THREE.Color(tune.emissive);
    mat.emissiveIntensity = tune.emissiveIntensity ?? 1;
  }
  patchTerrainShader(mat, {
    aoStrength: tune.aoStrength,
    macroStrength: tune.macroStrength,
    macroScale: tune.macroScale,
    tileGrid: tune.tileGrid ?? 1,
    tileRotate: tune.tileRotate ?? 0,
    tileSharpen: tune.tileSharpen ?? 5,
    hasNormal: true,
    hasRough: true,
    hasEmissive,
  });
  matCache.set(kind, mat);
  return mat;
}

/** Release every cached material/texture. Call on scenario teardown. */
export function disposeTerrainMaterials(): void {
  for (const mat of matCache.values()) mat.dispose();
  matCache.clear();
  for (const maps of mapCache.values()) {
    maps.map.dispose();
    maps.normalMap.dispose();
    maps.roughnessMap.dispose();
    maps.emissiveMap?.dispose();
  }
  mapCache.clear();
}

/** Surfaces rendered by the water shader instead of a standard material. */
export function isWaterSurface(kind: SurfaceKind): boolean {
  return kind === 'water' || kind === 'deepwater';
}

export const __testing = { TEXELS };
