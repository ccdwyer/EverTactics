/**
 * Shared GLSL building blocks for the EverTactics post stack.
 *
 * All post materials are plain `THREE.ShaderMaterial`s. three r180 compiles those to
 * `#version 300 es` and injects `#define varying in/out`, `#define texture2D texture`,
 * plus `layout(location=0) out highp vec4 pc_fragColor; #define gl_FragColor pc_fragColor`.
 * So we may write r120-style GLSL *and* still use ESSL3-only features (`sampler3D`,
 * `texture()`, `textureLod()`), which is exactly what the LUT pass needs.
 *
 * Do NOT redeclare these — three's fragment prefix already provides them:
 *   viewMatrix, cameraPosition, isOrthographic
 * Hence our own orthographic flag is called `uOrtho`.
 */

/** Fullscreen pass vertex shader. Used with a 2x2 PlaneGeometry. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Colour-space + luminance helpers. */
export const COLOR_CHUNK = /* glsl */ `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 srgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 srgbDecode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

// ACES fitted (Stephen Hill / sRGB in-out). Cheap, and far better hue behaviour
// than the Narkowicz approximation, which skews reds toward orange.
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 tonemapACES(vec3 color) {
  color = ACES_IN * color;
  color = rrtOdtFit(color);
  color = ACES_OUT * color;
  return clamp(color, 0.0, 1.0);
}
`;

/**
 * Depth sampling + view-space reconstruction.
 *
 * Requires uniforms: `uDepth` (DepthTexture), `uProjInv` (mat4), `uOrtho` (float 0/1),
 * `uProjScaleY` (float: 0.5 * projectionMatrix[1][1] * viewportHeightPx).
 *
 * The inverse-projection reconstruction is correct for both the tilted-orthographic rig
 * and the "perspective cheat" camera, so the whole stack has a single code path.
 */
export const DEPTH_CHUNK = /* glsl */ `
uniform sampler2D uDepth;
uniform mat4 uProjInv;
uniform float uOrtho;
uniform float uProjScaleY;

float rawDepth(vec2 uv) { return texture2D(uDepth, uv).x; }

bool isBackground(float d) { return d >= 0.999999; }

vec3 viewPosFromDepth(vec2 uv, float d) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = uProjInv * clip;
  return v.xyz / v.w;
}

vec3 viewPosAt(vec2 uv) { return viewPosFromDepth(uv, rawDepth(uv)); }

/** Positive distance from the camera plane. */
float viewDist(vec3 vp) { return -vp.z; }

/** World radius -> radius in pixels, unified for ortho and perspective. */
float worldRadiusToPixels(float worldRadius, float vz) {
  float denom = mix(max(-vz, 1e-3), 1.0, uOrtho);
  return worldRadius * uProjScaleY / denom;
}

/**
 * Normal from depth. Four taps, keeping the nearer neighbour on each axis so the
 * normal does not smear across silhouettes (which is what produces AO halos).
 */
vec3 normalFromDepth(vec2 uv, vec3 P, vec2 texel) {
  vec3 l = viewPosAt(uv - vec2(texel.x, 0.0));
  vec3 r = viewPosAt(uv + vec2(texel.x, 0.0));
  vec3 d = viewPosAt(uv - vec2(0.0, texel.y));
  vec3 u = viewPosAt(uv + vec2(0.0, texel.y));

  vec3 dx = abs(r.z - P.z) < abs(P.z - l.z) ? (r - P) : (P - l);
  vec3 dy = abs(u.z - P.z) < abs(P.z - d.z) ? (u - P) : (P - d);

  vec3 n = cross(dx, dy);
  float len = length(n);
  return len > 1e-8 ? n / len : vec3(0.0, 0.0, 1.0);
}
`;

/** Cheap deterministic hashes and value noise for grain / dithering. */
export const NOISE_CHUNK = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** Interleaved-gradient noise: the right choice for per-pixel sample rotation. */
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

/**
 * Circle-of-confusion evaluation, shared by the CoC prepass and the final composite so
 * the half-res gather and the full-res blend agree exactly.
 *
 * The tilt term is a band PLUS a radial corner term. That second half is measured, not
 * invented: in `refs/curated/triangle/official_005_steam.jpg` and `official_019_se_screenshot.jpg`
 * the left and right edges at mid-height are soft as well as the top and bottom, so the
 * in-focus region is a lens-shaped island, not an infinite horizontal stripe. A pure band
 * leaves the frame corners sharp and the miniature illusion collapses there.
 *
 * Uniforms: uFocusDist, uFocusRange, uCoCScale, uTiltMix, uTiltCenter, uTiltAxis,
 *           uTiltBand, uTiltFalloff, uTiltRadial, uTiltRadialStart, uCoCAspect
 */
export const COC_CHUNK = /* glsl */ `
uniform float uFocusDist;
uniform float uFocusRange;
uniform float uCoCScale;
uniform float uTiltMix;
uniform vec2  uTiltCenter;
uniform vec2  uTiltAxis;
uniform float uTiltBand;
uniform float uTiltFalloff;
uniform float uTiltRadial;      // 0..1 weight of the corner term
uniform float uTiltRadialStart; // normalised radius (1.0 = frame corner) where it begins
uniform vec2  uCoCAspect;       // vec2(width/height, 1.0)

/** Signed CoC in [-1,1]: negative = in front of focus (near field), positive = behind. */
float computeCoC(vec2 uv, float d) {
  float coc = 0.0;

  if (uTiltMix < 1.0) {
    vec3 vp = viewPosFromDepth(uv, d);
    float dist = isBackground(d) ? uFocusDist + uFocusRange * 8.0 : viewDist(vp);
    float signedDelta = dist - uFocusDist;
    float dead = max(abs(signedDelta) - uFocusRange, 0.0);
    coc += (1.0 - uTiltMix) * sign(signedDelta) * (dead / max(uFocusRange, 1e-3)) * uCoCScale;
  }

  if (uTiltMix > 0.0) {
    // Classic tilt-shift: a band across the frame, angle defined by uTiltAxis.
    float band = dot(uv - uTiltCenter, uTiltAxis);
    float mag = smoothstep(uTiltBand, uTiltBand + uTiltFalloff, abs(band));
    // Below the band reads as "closer to camera" in an isometric diorama.
    float bandSign = band < 0.0 ? -1.0 : 1.0;
    coc += uTiltMix * bandSign * mag;

    if (uTiltRadial > 0.0) {
      // Corner term. Elliptical distance from the band centre, normalised so 1.0 lands on
      // the frame corner. Combined by magnitude so it never cancels the band, and it
      // inherits the band's sign — the bottom corners of an isometric frame are foreground.
      vec2 c = (uv - uTiltCenter) * uCoCAspect;
      float rn = length(c) / max(0.5 * length(uCoCAspect), 1e-4);
      float radial = uTiltMix * uTiltRadial * smoothstep(uTiltRadialStart, 1.0, rn);
      float s = coc < 0.0 ? -1.0 : 1.0;
      coc = s * max(abs(coc), radial);
    }
  }

  return clamp(coc, -1.0, 1.0);
}
`;
