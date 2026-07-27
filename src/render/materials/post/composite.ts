/**
 * Final composite: DoF blend, bloom, impact distortion, vignette, tonemap, LUT grade,
 * chromatic aberration and grain — one pass, one dependent-texture chain.
 *
 * Ordering is not arbitrary. Anything that models the *lens* (distortion, CA, vignette)
 * happens on linear HDR light before the tonemapper, because that is where it physically
 * occurs. Anything that models the *print* (LUT, grain) happens after, in display space.
 * Getting this backwards is the difference between "graded" and "filtered".
 */

import { COC_CHUNK, COLOR_CHUNK, DEPTH_CHUNK, NOISE_CHUNK } from './glsl';

export const MAX_SHOCKWAVES = 4;

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;

varying vec2 vUv;

${COLOR_CHUNK}
${DEPTH_CHUNK}
${COC_CHUNK}
${NOISE_CHUNK}

uniform sampler2D uScene;
uniform sampler2D uDoF;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform sampler2D uSpriteMask;
uniform sampler3D uLutA;
uniform sampler3D uLutB;

uniform vec2  uResolution;
uniform float uTime;

uniform float uDoFEnabled;
uniform float uMaxCoCPixels;
uniform float uNearStrength;

uniform float uBloomIntensity;
uniform vec3  uBloomTint;

uniform float uExposure;

uniform float uVignetteAmount;
uniform float uVignetteRadius;
uniform float uVignetteSoftness;
uniform vec3  uVignetteColor;

uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uGrainShadowBias;

uniform float uChromaAmount;
uniform float uChromaEdge;

uniform float uLutMix;
uniform float uLutAmount;
uniform float uLutSize;

uniform vec4  uWaves[${MAX_SHOCKWAVES}];   // xy = centre in uv, z = radius, w = amplitude
uniform float uWaveCount;
uniform float uAspect;

uniform int uDebug;   // 0 off, 1 ao, 2 bloom, 3 coc, 4 dof, 5 mask, 6 grade-off

vec2 applyShockwaves(vec2 uv) {
  if (uWaveCount < 0.5) return uv;
  vec2 result = uv;
  for (int i = 0; i < ${MAX_SHOCKWAVES}; i++) {
    if (float(i) >= uWaveCount) break;
    vec4 w = uWaves[i];
    if (w.w <= 0.0) continue;
    vec2 d = (uv - w.xy) * vec2(uAspect, 1.0);
    float r = length(d);
    // A single travelling ring: a narrow band of displacement at radius w.z.
    float band = w.z * 0.22 + 0.004;
    float ring = exp(-pow((r - w.z) / band, 2.0));
    // Push outward on the leading edge, pull inward behind it.
    float push = ring * sin((r - w.z) / band * 2.2);
    result += normalize(d + 1e-6) * push * w.w / vec2(uAspect, 1.0);
  }
  return result;
}

/** Scene colour with depth-of-field resolved. */
vec3 beauty(vec2 uv) {
  vec3 sharp = texture2D(uScene, uv).rgb;
  if (uDoFEnabled < 0.5) return sharp;

  vec4 blurred = texture2D(uDoF, uv);
  float coc = computeCoC(uv, rawDepth(uv));
  float radius = abs(coc) * uMaxCoCPixels;

  float farBlend = smoothstep(0.4, 2.0, max(coc, 0.0) * uMaxCoCPixels);
  vec3 col = mix(sharp, blurred.rgb, farBlend);

  // Near field bleeds outward: coverage from the gather pass, not the centre pixel's CoC,
  // so a blurred foreground fades over sharp background with no cut-out silhouette.
  float nearBlend = clamp(max(blurred.a, smoothstep(0.4, 2.0, max(-coc, 0.0) * uMaxCoCPixels)) * uNearStrength, 0.0, 1.0);
  col = mix(col, blurred.rgb, nearBlend);
  return col;
}

vec3 applyLUT(vec3 c) {
  float n = uLutSize;
  vec3 uvw = clamp(c, 0.0, 1.0) * ((n - 1.0) / n) + (0.5 / n);
  vec3 a = texture(uLutA, uvw).rgb;
  vec3 b = texture(uLutB, uvw).rgb;
  return mix(a, b, uLutMix);
}

void main() {
  vec2 uv = applyShockwaves(vUv);

  vec2 centred = (uv - 0.5) * vec2(uAspect, 1.0);
  float r2 = dot(centred, centred);

  vec3 color;
  if (uChromaAmount > 0.0005) {
    // Transverse chromatic aberration: zero at the optical centre, ramping hard at the
    // very edge of the frame. r^uChromaEdge keeps the middle of the screen perfectly clean.
    float amount = uChromaAmount * pow(clamp(r2 * 2.0, 0.0, 1.0), uChromaEdge);
    vec2 dir = centred * amount * 0.012;
    color.r = beauty(uv - dir / vec2(uAspect, 1.0)).r;
    color.g = beauty(uv).g;
    color.b = beauty(uv + dir / vec2(uAspect, 1.0)).b;
  } else {
    color = beauty(uv);
  }

  color += texture2D(uBloom, uv).rgb * uBloomIntensity * uBloomTint;

  // Vignette — optical falloff, so it multiplies scene light before the tonemapper.
  float vig = 1.0 - uVignetteAmount * smoothstep(uVignetteRadius, uVignetteRadius + uVignetteSoftness, sqrt(r2));
  color *= mix(uVignetteColor, vec3(1.0), vig);

  color *= uExposure;
  color = tonemapACES(color);
  color = srgbEncode(color);

  if (uDebug != 6) {
    color = mix(color, applyLUT(color), uLutAmount);
  }

  if (uGrainAmount > 0.0) {
    vec2 gp = floor(gl_FragCoord.xy / max(uGrainSize, 1.0)) + floor(uTime * 24.0) * 17.0;
    float n = hash12(gp) - 0.5;
    // Real film grain lives in the midtones and shadows, not the highlights.
    float l = luma(color);
    float weight = mix(1.0, 1.0 - l, uGrainShadowBias) * (1.0 - smoothstep(0.75, 1.0, l));
    color += n * uGrainAmount * weight;
  }

  if (uDebug == 1) {
    color = vec3(texture2D(uAO, vUv).r);
  } else if (uDebug == 2) {
    color = srgbEncode(texture2D(uBloom, vUv).rgb * uBloomIntensity);
  } else if (uDebug == 3) {
    float coc = computeCoC(vUv, rawDepth(vUv));
    color = vec3(max(coc, 0.0), max(-coc, 0.0), 0.0);
  } else if (uDebug == 4) {
    color = srgbEncode(texture2D(uDoF, vUv).rgb);
  } else if (uDebug == 5) {
    color = vec3(texture2D(uSpriteMask, vUv).a);
  }

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
