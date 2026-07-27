/**
 * Anti-aliasing, with pixel art protected.
 *
 * The problem: terrain silhouettes need AA badly (an aliased tile edge is the loudest
 * "hobby project" signal there is), but running any luma-based AA over a magnified 64px
 * FFT sprite destroys the thing that makes it look like FFT. A blended pixel-art edge is
 * instantly, viscerally wrong.
 *
 * The fix is a mask. `sprites.ts` puts its billboards on a dedicated layer; the PostStack
 * renders that layer alone into an alpha mask and this pass dilates it by a texel before
 * using it. Three policies:
 *   exclude    — no AA anywhere a sprite covers. Pixel art stays bit-exact. (default)
 *   silhouette — AA only where a sprite meets something at a different depth, so the
 *                outline is smoothed against terrain but interior texels are untouched.
 *   none       — AA everything. Use only if sprites are disabled.
 *
 * The algorithm is FXAA-family: luma edge detect, determine edge orientation, search along
 * the edge for its ends, and blend perpendicular by the subpixel offset. Subpixel aliasing
 * removal is deliberately weak (`uSubpix` default 0.4) because full-strength FXAA softens
 * fine terrain detail more than it helps.
 */

import { COLOR_CHUNK, DEPTH_CHUNK } from './glsl';

export const AA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${COLOR_CHUNK}
${DEPTH_CHUNK}

uniform sampler2D uColor;      // sRGB-encoded LDR
uniform sampler2D uSpriteMask;
uniform vec2 uTexel;
uniform float uSubpix;
uniform float uEdgeThreshold;
uniform float uEdgeThresholdMin;
uniform float uSpritePolicy;   // 0 exclude, 1 silhouette, 2 none
uniform float uSpriteMaskEnabled;

#ifndef AA_SEARCH_STEPS
#define AA_SEARCH_STEPS 8
#endif

float lumaAt(vec2 uv) { return luma(texture2D(uColor, uv).rgb); }

/** Max sprite coverage in a 3x3 neighbourhood: dilates the mask so silhouettes are inside it. */
float spriteCoverage(vec2 uv) {
  float m = texture2D(uSpriteMask, uv).a;
  m = max(m, texture2D(uSpriteMask, uv + vec2( uTexel.x, 0.0)).a);
  m = max(m, texture2D(uSpriteMask, uv + vec2(-uTexel.x, 0.0)).a);
  m = max(m, texture2D(uSpriteMask, uv + vec2(0.0,  uTexel.y)).a);
  m = max(m, texture2D(uSpriteMask, uv + vec2(0.0, -uTexel.y)).a);
  return clamp(m, 0.0, 1.0);
}

/** Depth discontinuity: 1 where this pixel sits on a geometric silhouette. */
float depthEdge(vec2 uv) {
  float d = rawDepth(uv);
  if (isBackground(d)) return 1.0;
  float z = viewDist(viewPosFromDepth(uv, d));
  float e = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = i == 0 ? vec2(uTexel.x, 0.0)
           : i == 1 ? vec2(-uTexel.x, 0.0)
           : i == 2 ? vec2(0.0, uTexel.y)
                    : vec2(0.0, -uTexel.y);
    float sd = rawDepth(uv + o);
    float sz = isBackground(sd) ? z + 1e3 : viewDist(viewPosFromDepth(uv + o, sd));
    e = max(e, abs(sz - z));
  }
  return smoothstep(0.02, 0.12, e / max(z, 1.0) * 40.0);
}

void main() {
  vec4 centre = texture2D(uColor, vUv);

  float allow = 1.0;
  if (uSpriteMaskEnabled > 0.5 && uSpritePolicy < 1.5) {
    float cov = spriteCoverage(vUv);
    if (uSpritePolicy < 0.5) {
      allow = 1.0 - cov;                       // exclude
    } else {
      allow = 1.0 - cov * (1.0 - depthEdge(vUv)); // silhouette only
    }
  }
  if (allow <= 0.001) {
    gl_FragColor = centre;
    return;
  }

  float lM = luma(centre.rgb);
  float lN = lumaAt(vUv + vec2(0.0,  uTexel.y));
  float lS = lumaAt(vUv + vec2(0.0, -uTexel.y));
  float lE = lumaAt(vUv + vec2( uTexel.x, 0.0));
  float lW = lumaAt(vUv + vec2(-uTexel.x, 0.0));

  float lMin = min(lM, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lM, max(max(lN, lS), max(lE, lW)));
  float range = lMax - lMin;

  if (range < max(uEdgeThresholdMin, lMax * uEdgeThreshold)) {
    gl_FragColor = centre;
    return;
  }

  float lNW = lumaAt(vUv + vec2(-uTexel.x,  uTexel.y));
  float lNE = lumaAt(vUv + vec2( uTexel.x,  uTexel.y));
  float lSW = lumaAt(vUv + vec2(-uTexel.x, -uTexel.y));
  float lSE = lumaAt(vUv + vec2( uTexel.x, -uTexel.y));

  float edgeH = abs(lNW + lNE - 2.0 * lN) * 2.0 + abs(lW + lE - 2.0 * lM) * 4.0 + abs(lSW + lSE - 2.0 * lS) * 2.0;
  float edgeV = abs(lNW + lSW - 2.0 * lW) * 2.0 + abs(lN + lS - 2.0 * lM) * 4.0 + abs(lNE + lSE - 2.0 * lE) * 2.0;
  bool horizontal = edgeH >= edgeV;

  float l1 = horizontal ? lS : lW;
  float l2 = horizontal ? lN : lE;
  float g1 = abs(l1 - lM);
  float g2 = abs(l2 - lM);
  bool steepest1 = g1 >= g2;
  float gradient = max(g1, g2) * 0.25;

  float stepLength = horizontal ? uTexel.y : uTexel.x;
  float lLocal;
  if (steepest1) {
    stepLength = -stepLength;
    lLocal = 0.5 * (l1 + lM);
  } else {
    lLocal = 0.5 * (l2 + lM);
  }

  vec2 uvEdge = vUv;
  if (horizontal) uvEdge.y += stepLength * 0.5; else uvEdge.x += stepLength * 0.5;

  vec2 offset = horizontal ? vec2(uTexel.x, 0.0) : vec2(0.0, uTexel.y);
  vec2 uv1 = uvEdge - offset;
  vec2 uv2 = uvEdge + offset;

  float lEnd1 = lumaAt(uv1) - lLocal;
  float lEnd2 = lumaAt(uv2) - lLocal;
  bool done1 = abs(lEnd1) >= gradient;
  bool done2 = abs(lEnd2) >= gradient;
  if (!done1) uv1 -= offset;
  if (!done2) uv2 += offset;

  for (int i = 0; i < AA_SEARCH_STEPS; i++) {
    if (done1 && done2) break;
    float quality = i < 3 ? 1.0 : (i < 5 ? 1.5 : 2.0);
    if (!done1) {
      lEnd1 = lumaAt(uv1) - lLocal;
      done1 = abs(lEnd1) >= gradient;
      if (!done1) uv1 -= offset * quality;
    }
    if (!done2) {
      lEnd2 = lumaAt(uv2) - lLocal;
      done2 = abs(lEnd2) >= gradient;
      if (!done2) uv2 += offset * quality;
    }
  }

  float dist1 = horizontal ? (vUv.x - uv1.x) : (vUv.y - uv1.y);
  float dist2 = horizontal ? (uv2.x - vUv.x) : (uv2.y - vUv.y);
  bool near1 = dist1 < dist2;
  float distFinal = min(dist1, dist2);
  float edgeLength = dist1 + dist2;
  float pixelOffset = -distFinal / max(edgeLength, 1e-5) + 0.5;

  bool lMLess = lM < lLocal;
  bool correct = ((near1 ? lEnd1 : lEnd2) < 0.0) != lMLess;
  float finalOffset = correct ? pixelOffset : 0.0;

  // Subpixel term: catches the single-pixel sparkle that edge search cannot.
  float lAvg = (2.0 * (lN + lS + lE + lW) + lNW + lNE + lSW + lSE) / 12.0;
  float subpix = clamp(abs(lAvg - lM) / max(range, 1e-5), 0.0, 1.0);
  subpix = (-2.0 * subpix + 3.0) * subpix * subpix;
  subpix = subpix * subpix * uSubpix;
  finalOffset = max(finalOffset, subpix);

  vec2 finalUv = vUv;
  if (horizontal) finalUv.y += finalOffset * stepLength; else finalUv.x += finalOffset * stepLength;

  vec3 aa = texture2D(uColor, finalUv).rgb;
  gl_FragColor = vec4(mix(centre.rgb, aa, allow), centre.a);
}
`;
