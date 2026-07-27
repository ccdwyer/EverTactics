/**
 * Progressive dual-filter bloom (Jimenez / "Next Generation Post Processing" lineage).
 *
 * Physically motivated: the threshold sits above diffuse white so only genuine emitters
 * bloom — a lantern, a spell core, sun on water — never a lit stone wall. Six mip levels
 * with a tent upsample give a wide, soft falloff that reads as lens glare instead of the
 * doughnut-shaped ring a single gaussian produces.
 */

import { COLOR_CHUNK } from './glsl';

export const BLOOM_PREFILTER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${COLOR_CHUNK}

uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uSoftKnee;
uniform float uClamp;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float rq = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  rq = rq * rq / (4.0 * knee + 1e-5);
  float w = max(rq, br - uThreshold) / max(br, 1e-5);
  return min(c * w, vec3(uClamp));
}

void main() {
  // 4-tap box with a Karis average: weighting by inverse luma kills single-pixel
  // fireflies that would otherwise pump and flicker as the camera rotates.
  vec2 o = uTexel;
  vec3 a = texture2D(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
  vec3 b = texture2D(uSrc, vUv + vec2( o.x, -o.y)).rgb;
  vec3 c = texture2D(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
  vec3 d = texture2D(uSrc, vUv + vec2( o.x,  o.y)).rgb;

  float wa = 1.0 / (1.0 + luma(a));
  float wb = 1.0 / (1.0 + luma(b));
  float wc = 1.0 / (1.0 + luma(c));
  float wd = 1.0 / (1.0 + luma(d));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);

  gl_FragColor = vec4(prefilter(col), 1.0);
}
`;

/** 13-tap downsample — stable under camera motion, unlike a naive 2x2 box. */
export const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec2 o = uTexel;

  vec3 a = texture2D(uSrc, vUv + vec2(-2.0 * o.x,  2.0 * o.y)).rgb;
  vec3 b = texture2D(uSrc, vUv + vec2( 0.0,        2.0 * o.y)).rgb;
  vec3 c = texture2D(uSrc, vUv + vec2( 2.0 * o.x,  2.0 * o.y)).rgb;
  vec3 d = texture2D(uSrc, vUv + vec2(-2.0 * o.x,  0.0)).rgb;
  vec3 e = texture2D(uSrc, vUv).rgb;
  vec3 f = texture2D(uSrc, vUv + vec2( 2.0 * o.x,  0.0)).rgb;
  vec3 g = texture2D(uSrc, vUv + vec2(-2.0 * o.x, -2.0 * o.y)).rgb;
  vec3 h = texture2D(uSrc, vUv + vec2( 0.0,       -2.0 * o.y)).rgb;
  vec3 i = texture2D(uSrc, vUv + vec2( 2.0 * o.x, -2.0 * o.y)).rgb;

  vec3 j = texture2D(uSrc, vUv + vec2(-o.x,  o.y)).rgb;
  vec3 k = texture2D(uSrc, vUv + vec2( o.x,  o.y)).rgb;
  vec3 l = texture2D(uSrc, vUv + vec2(-o.x, -o.y)).rgb;
  vec3 m = texture2D(uSrc, vUv + vec2( o.x, -o.y)).rgb;

  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;

  gl_FragColor = vec4(col, 1.0);
}
`;

/** 9-tap tent upsample, additively combined with the finer mip already in 'uPrev'. */
export const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uSrc;   // coarser mip
uniform sampler2D uPrev;  // finer mip at this resolution
uniform vec2 uTexel;      // texel size of uSrc
uniform float uRadius;

void main() {
  vec2 o = uTexel * uRadius;

  vec3 col = texture2D(uSrc, vUv + vec2(-o.x,  o.y)).rgb * 1.0;
  col += texture2D(uSrc, vUv + vec2( 0.0,   o.y)).rgb * 2.0;
  col += texture2D(uSrc, vUv + vec2( o.x,   o.y)).rgb * 1.0;
  col += texture2D(uSrc, vUv + vec2(-o.x,   0.0)).rgb * 2.0;
  col += texture2D(uSrc, vUv).rgb * 4.0;
  col += texture2D(uSrc, vUv + vec2( o.x,   0.0)).rgb * 2.0;
  col += texture2D(uSrc, vUv + vec2(-o.x, -o.y)).rgb * 1.0;
  col += texture2D(uSrc, vUv + vec2( 0.0,  -o.y)).rgb * 2.0;
  col += texture2D(uSrc, vUv + vec2( o.x, -o.y)).rgb * 1.0;
  col /= 16.0;

  gl_FragColor = vec4(col + texture2D(uPrev, vUv).rgb, 1.0);
}
`;
