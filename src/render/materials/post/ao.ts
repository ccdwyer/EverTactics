/**
 * Horizon-based ambient occlusion, depth-only.
 *
 * Depth-only means the pass needs nothing from the scene materials — no MRT, no override
 * material, no normal buffer — which keeps it decoupled from terrain.ts / sprites.ts.
 * Normals come from a nearest-neighbour depth derivative, which on the blocky diorama
 * geometry we render is effectively exact.
 *
 * Halo avoidance is the whole game here. Three things do it:
 *   1. per-sample distance attenuation (a sample far away can never fully occlude),
 *   2. an "infinite thickness" reject so a foreground silhouette does not darken the
 *      background behind it,
 *   3. a tight world radius (default ~0.55 tiles) so occlusion only lives in crevices.
 */

import { COLOR_CHUNK, DEPTH_CHUNK, NOISE_CHUNK } from './glsl';

export const AO_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;

varying vec2 vUv;

${DEPTH_CHUNK}
${NOISE_CHUNK}

uniform vec2  uTexel;        // 1 / AO target resolution
uniform float uRadius;       // world units
uniform float uIntensity;
uniform float uBias;         // tangent-plane bias, sin units
uniform float uThickness;    // 0..1, larger = occluders treated as thicker
uniform float uMaxPixelRadius;
uniform float uRotation;     // static per-config rotation offset (kept deterministic)

#ifndef AO_SLICES
#define AO_SLICES 4
#endif
#ifndef AO_STEPS
#define AO_STEPS 6
#endif

void main() {
  float d = rawDepth(vUv);
  if (isBackground(d)) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    return;
  }

  vec3 P = viewPosFromDepth(vUv, d);
  vec3 N = normalFromDepth(vUv, P, uTexel);

  float pixelRadius = min(worldRadiusToPixels(uRadius, P.z), uMaxPixelRadius);
  if (pixelRadius < 1.0) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
    return;
  }

  // Deterministic per-pixel rotation + radial jitter. No frame index: screenshots of the
  // same scene must be byte-identical for the critic loop.
  // A plain hash decorrelates better than interleaved-gradient noise here: IGN is tuned
  // for temporal accumulation, and without TAA its structure shows up as column banding
  // on the large flat side faces of the diorama.
  float rot = hash12(gl_FragCoord.xy) * 6.2831853 + uRotation;
  float jitter = 0.35 + 0.65 * ign(gl_FragCoord.xy);

  float occlusion = 0.0;
  float sliceStep = 3.14159265 / float(AO_SLICES);

  for (int s = 0; s < AO_SLICES; s++) {
    float phi = rot + float(s) * sliceStep;
    vec2 dir = vec2(cos(phi), sin(phi));

    // Both halves of the slice, marched together.
    for (int side = 0; side < 2; side++) {
      vec2 sdir = side == 0 ? dir : -dir;
      float best = 0.0;

      for (int i = 0; i < AO_STEPS; i++) {
        float t = (float(i) + jitter) / float(AO_STEPS);
        // Quadratic ramp (dense near the centre) but never closer than MIN_STEP_PX.
        // Sub-pixel taps divide a near-zero height difference by a near-zero distance,
        // which turns depth-buffer quantisation into full-strength occlusion — that is
        // what makes a naive HBAO cover flat ground in grey noise.
        float px = max(2.0, t * t * pixelRadius);
        vec2 suv = vUv + sdir * px * uTexel;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;

        float sd = rawDepth(suv);
        if (isBackground(sd)) continue;

        vec3 S = viewPosFromDepth(suv, sd);
        vec3 diff = S - P;
        float dist = length(diff);
        // Reject anything closer than a small fraction of the radius for the same reason.
        if (dist < uRadius * 0.06) continue;

        // Elevation of the sample above the tangent plane.
        float sinE = dot(diff, N) / dist;

        // Distance attenuation. A smooth quadratic falloff to zero at the radius keeps
        // distant silhouettes from occluding at full strength, which is what produces
        // the classic dark halo around foreground objects.
        float dr = dist / uRadius;
        float att = clamp(1.0 - dr * dr, 0.0, 1.0);

        // Thickness reject: something *much* further behind is not an occluder.
        float behind = clamp((dist - uRadius) / (uRadius * max(uThickness, 1e-3)), 0.0, 1.0);
        att *= 1.0 - behind;

        best = max(best, (sinE - uBias) * att);
      }

      occlusion += clamp(best, 0.0, 1.0);
    }
  }

  occlusion /= float(AO_SLICES * 2);
  float ao = clamp(1.0 - occlusion * uIntensity, 0.0, 1.0);

  // Keep a linear response; the perceptual shaping happens at apply time.
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

/** Depth-aware separable blur. Run twice (horizontal, then vertical). */
export const AO_BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${DEPTH_CHUNK}

uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uDepthSigma;

void main() {
  float d0 = rawDepth(vUv);
  if (isBackground(d0)) {
    gl_FragColor = vec4(1.0);
    return;
  }
  float z0 = viewDist(viewPosFromDepth(vUv, d0));

  const float weights[5] = float[5](0.2270270, 0.1945946, 0.1216216, 0.0540541, 0.0162162);

  float sum = texture2D(uSrc, vUv).r * weights[0];
  float wsum = weights[0];

  for (int i = 1; i < 5; i++) {
    for (int s = 0; s < 2; s++) {
      float o = float(i) * (s == 0 ? 1.0 : -1.0);
      vec2 suv = vUv + uDirection * uTexel * o;
      float sd = rawDepth(suv);
      if (isBackground(sd)) continue;
      float z = viewDist(viewPosFromDepth(suv, sd));
      float w = weights[i] * exp(-abs(z - z0) / max(uDepthSigma, 1e-3));
      sum += texture2D(uSrc, suv).r * w;
      wsum += w;
    }
  }

  float ao = sum / max(wsum, 1e-5);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

/**
 * Multiply AO into the HDR scene colour before bloom.
 *
 * Applying AO to already-shaded colour is an approximation (it dims direct light too),
 * so we bias it away from bright pixels: a lit rooftop keeps its highlight while the
 * crevice between two tile blocks still gets its contact darkening. Sprites are excluded
 * via the sprite mask — a billboard quad has no meaningful depth gradient and would
 * otherwise occlude itself into a grey smear.
 */
export const AO_APPLY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${COLOR_CHUNK}

uniform sampler2D uScene;
uniform sampler2D uAO;
uniform sampler2D uSpriteMask;
uniform float uStrength;
uniform float uHighlightGuard;
uniform float uSpriteMaskEnabled;
uniform float uSpriteAO;       // how much AO sprites still receive (contact grounding)
uniform vec3  uTint;           // AO is tinted, never neutral grey: bounce light is coloured
uniform float uDebug;

void main() {
  vec4 scene = texture2D(uScene, vUv);
  float ao = texture2D(uAO, vUv).r;

  float sprite = uSpriteMaskEnabled > 0.5 ? texture2D(uSpriteMask, vUv).a : 0.0;
  float strength = mix(uStrength, uStrength * uSpriteAO, clamp(sprite, 0.0, 1.0));

  float guard = 1.0 - clamp(luma(scene.rgb) * uHighlightGuard, 0.0, 0.85);
  float k = clamp(1.0 - (1.0 - ao) * strength * guard, 0.0, 1.0);

  vec3 occluded = scene.rgb * mix(uTint, vec3(1.0), k);
  vec3 outColor = mix(scene.rgb, occluded, 1.0);

  if (uDebug > 0.5) {
    outColor = vec3(mix(k, 1.0, 0.0));
  }

  gl_FragColor = vec4(outColor, scene.a);
}
`;
