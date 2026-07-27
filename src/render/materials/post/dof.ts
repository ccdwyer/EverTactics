/**
 * Depth of field / tilt-shift.
 *
 * This is the diorama tell. A shallow band of focus across the battlefield with a soft
 * falloff above and below is what makes a 40x40 tile map read as a tabletop model rather
 * than a landscape. The tilt term is authored in screen space (a band with an angle,
 * exactly like a tilt-shift lens) and can be crossfaded with a real depth-based CoC for
 * cutscene close-ups.
 *
 * Bokeh: a 2/3-ring golden-angle spiral gather at half resolution. Samples are weighted by
 * whether *their* CoC actually reaches the centre pixel (the standard scatter-as-gather
 * test), and bright samples get a superlinear boost so highlights form real discs instead
 * of smearing. Near-field coverage is tracked in alpha so foreground blur can bleed
 * outward over sharp background instead of showing a hard cutout edge.
 */

import { COC_CHUNK, COLOR_CHUNK, DEPTH_CHUNK } from './glsl';

/** Half-res prepass: colour + signed CoC packed into a half-float RGBA target. */
export const DOF_COC_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${DEPTH_CHUNK}
${COC_CHUNK}

uniform sampler2D uScene;
uniform vec2 uTexel;    // full-res texel size

void main() {
  // Box-downsample colour, but take the CoC that produces the *largest* blur among the
  // four so thin foreground elements do not vanish at half res.
  vec2 o = uTexel * 0.5;
  vec2 uvs[4];
  uvs[0] = vUv + vec2(-o.x, -o.y);
  uvs[1] = vUv + vec2( o.x, -o.y);
  uvs[2] = vUv + vec2(-o.x,  o.y);
  uvs[3] = vUv + vec2( o.x,  o.y);

  vec3 col = vec3(0.0);
  float coc = 0.0;
  for (int i = 0; i < 4; i++) {
    col += texture2D(uScene, uvs[i]).rgb;
    float c = computeCoC(uvs[i], rawDepth(uvs[i]));
    if (abs(c) > abs(coc)) coc = c;
  }

  gl_FragColor = vec4(col * 0.25, coc);
}
`;

export const DOF_GATHER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${COLOR_CHUNK}

uniform sampler2D uSrc;      // half-res colour + coc
uniform vec2 uTexel;         // half-res texel size
uniform float uMaxCoCPixels; // in half-res pixels
uniform float uBokehBoost;
uniform float uNearSpread;

#ifndef DOF_TAPS
#define DOF_TAPS 32
#endif

const float GOLDEN = 2.39996323;

void main() {
  vec4 center = texture2D(uSrc, vUv);
  float centerCoC = center.a;
  float centerRadius = abs(centerCoC) * uMaxCoCPixels;

  // The gather radius has to cover the largest *possible* contributor, not just the
  // centre pixel's own CoC, otherwise a blurred foreground has a hard edge.
  float radius = max(centerRadius, uMaxCoCPixels * uNearSpread);
  if (radius < 0.75) {
    gl_FragColor = vec4(center.rgb, 0.0);
    return;
  }

  vec3 acc = center.rgb;
  float wsum = 1.0;
  float nearCoverage = max(-centerCoC, 0.0);
  float nearWeight = 1.0;

  for (int i = 0; i < DOF_TAPS; i++) {
    float fi = float(i) + 0.5;
    float ang = fi * GOLDEN;
    float r = sqrt(fi / float(DOF_TAPS)) * radius;
    vec2 offset = vec2(cos(ang), sin(ang)) * r;

    vec4 s = texture2D(uSrc, vUv + offset * uTexel);
    float sRadius = abs(s.a) * uMaxCoCPixels;

    // Does this sample's disc actually cover us?
    float w = smoothstep(r - 1.0, r + 1.0, sRadius);

    // A far-field sample must not bleed onto a sharp foreground pixel.
    if (s.a > 0.0 && centerCoC < 0.0) w *= 0.15;

    float boost = 1.0 + max(luma(s.rgb) - 1.0, 0.0) * uBokehBoost;
    acc += s.rgb * w * boost;
    wsum += w * boost;

    float nw = smoothstep(r - 1.0, r + 1.0, max(-s.a, 0.0) * uMaxCoCPixels);
    nearCoverage += max(-s.a, 0.0) * nw;
    nearWeight += nw;
  }

  gl_FragColor = vec4(acc / max(wsum, 1e-4), clamp(nearCoverage / nearWeight * 2.0, 0.0, 1.0));
}
`;

/** 3x3 tent to fill the spiral's gaps. Cheap and it removes the last of the sample noise. */
export const DOF_FILL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec4 sum = vec4(0.0);
  sum += texture2D(uSrc, vUv + vec2(-uTexel.x, -uTexel.y)) * 1.0;
  sum += texture2D(uSrc, vUv + vec2( 0.0,      -uTexel.y)) * 2.0;
  sum += texture2D(uSrc, vUv + vec2( uTexel.x, -uTexel.y)) * 1.0;
  sum += texture2D(uSrc, vUv + vec2(-uTexel.x,  0.0)) * 2.0;
  sum += texture2D(uSrc, vUv) * 4.0;
  sum += texture2D(uSrc, vUv + vec2( uTexel.x,  0.0)) * 2.0;
  sum += texture2D(uSrc, vUv + vec2(-uTexel.x,  uTexel.y)) * 1.0;
  sum += texture2D(uSrc, vUv + vec2( 0.0,       uTexel.y)) * 2.0;
  sum += texture2D(uSrc, vUv + vec2( uTexel.x,  uTexel.y)) * 1.0;
  gl_FragColor = sum / 16.0;
}
`;
