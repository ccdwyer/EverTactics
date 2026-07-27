/**
 * EverTactics — sky / atmosphere gradient.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Round-2 blind A/B: critics identified our frame as the prototype in 6/6 pairs,
 * and the single most-cited tell was the *void*. Roughly half of a 1920×1080
 * frame was `renderer.clearColor` — one flat near-black navy — with the diorama
 * sitting in the middle of it terminating on a hard antialiased silhouette.
 *
 * Neither reference game ever does that. Open
 * `refs/curated/triangle/press_002_gematsu_1920x1080.jpg` or
 * `official_005_steam.jpg`: the world runs off all four frame edges. Even
 * `official_009_steam.jpg`, which is the darkest frame in the corpus, has the
 * mine dissolving into a warm glow rather than cutting against a flat colour.
 *
 * So: a graded sky, drawn behind everything, tuned from the map's own lighting
 * preset. Not a skybox — the rig is orthographic, so a cube/dome would project
 * to a single constant colour and buy us nothing. What actually reads is a
 * *screen-space* vertical grade with a horizon band, a sun bloom placed where
 * the key light is on screen, and low-frequency cloud banding so it is never a
 * flat wash. That is what a matte-painted backdrop plate does, and it is what an
 * orthographic HD-2D frame needs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COLOUR SPACE
 * ─────────────────────────────────────────────────────────────────────────────
 * `stage.ts` composes into a linear-working-space HDR target and lets
 * `post.ts` tone map at the end. Everything here therefore emits **linear**
 * values. `Color` uniforms are already in working space once built with
 * `setHex(hex, 'srgb')`, so the shader just mixes them and writes them out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPTH
 * ─────────────────────────────────────────────────────────────────────────────
 * The quad is emitted directly in clip space with `depthTest`/`depthWrite` off
 * and `renderOrder = -10000`, so it is always the first thing in the frame and
 * never fights the scene. It leaves depth at the far plane, which means
 * `post.ts`'s DoF treats sky pixels as maximally distant — correct, and it
 * softens the cloud banding for free.
 */

import {
  Color,
  DirectionalLight,
  Fog,
  FogExp2,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Shared GLSL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hash / value-noise / fbm, shared by `sky.ts`, `backdrop.ts` and
 * `atmosphere.ts` so every layer of the environment breaks up with the *same*
 * noise basis. Mismatched noise between a haze plane and the silhouettes in
 * front of it is one of those things nobody can name but everybody sees.
 */
export const GLSL_NOISE = /* glsl */ `
float etHash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
float etHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 etHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float etNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(etHash12(i + vec2(0.0, 0.0)), etHash12(i + vec2(1.0, 0.0)), u.x),
    mix(etHash12(i + vec2(0.0, 1.0)), etHash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float etFbm(vec2 p, int octaves) {
  float a = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += a * etNoise(p);
    norm += a;
    p *= 2.03;
    p += 17.31;
    a *= 0.5;
  }
  return sum / max(norm, 1e-4);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Palette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one palette every environment layer shares.
 *
 * It is *derived from the scene* rather than configured, which is the whole
 * coordination trick: `lighting.ts` owns `scene.background`, `scene.fog` and the
 * key `DirectionalLight`, and those three things already encode the map's mood.
 * Reading them back means the sky, the backdrop and the motes re-tune themselves
 * whenever the lighting fixer changes a preset, with no shared config file and
 * no cross-module call.
 *
 * All colours are LINEAR working space.
 */
export interface EnvironmentPalette {
  /** Top of frame. Deepest, coolest. */
  zenith: Color;
  /** The bright band the ground plane fades into. Carries the key's warmth. */
  horizon: Color;
  /** Distance haze — what far geometry is mixed toward. */
  haze: Color;
  /** Below the horizon line: earth/water tone under the haze. */
  ground: Color;
  /** Key-light colour, used for the sun bloom and for lighting the backdrop. */
  sun: Color;
  /** The map's crushed-black tint. Never neutral grey. */
  deep: Color;
  /** Normalised world-space direction the key light travels (sun → scene). */
  sunDirection: Vector3;
  /** Key intensity, so distant geometry can be lit in the same units. */
  sunIntensity: number;
}

export interface PaletteTuning {
  /** Overall gain on the sky. 1 = as derived. */
  skyGain?: number;
  /** How far the horizon band is pushed toward the key colour. 0…1 */
  horizonWarmth?: number;
  /** Gain on the haze colour that distant geometry fades into. */
  hazeGain?: number;
}

/**
 * Linear luminance targets for the environment, measured against the board.
 *
 * These are the numbers that took three render iterations to land, so they are
 * worth writing down. `post.ts` multiplies by the preset exposure (1.5–1.75 on
 * the dawn maps) and then runs ACES, which has a knee well under 1.0 — so a
 * "reasonable-looking" linear 0.3 background comes out of the tonemapper as
 * cream-coloured blowout, and the board disappears into it. The lit board sits
 * around 0.10–0.30 linear. The references put the background a stop and a half
 * under that, which is where these land.
 */
const HAZE_LEVEL = 0.032;
const HORIZON_LEVEL = 0.075;
const ZENITH_LEVEL = 0.015;
const GROUND_LEVEL = 0.022;

/** Strip brightness off a colour, keeping only its hue/saturation. */
function tintOf(c: Color, out = new Color()): Color {
  const m = Math.max(c.r, c.g, c.b);
  if (m < 1e-5) return out.setRGB(0.5, 0.55, 0.7);
  return out.setRGB(c.r / m, c.g / m, c.b / m);
}

const DEFAULT_DEEP = new Color().setHex(0x080d18, 'srgb');
const DEFAULT_HAZE = new Color().setHex(0x1b3050, 'srgb');
const DEFAULT_SUN = new Color().setHex(0xffc07a, 'srgb');

function firstKeyLight(scene: Scene): DirectionalLight | null {
  let best: DirectionalLight | null = null;
  scene.traverse((o: Object3D) => {
    const light = o as DirectionalLight;
    if (!light.isDirectionalLight) return;
    if (best === null || light.intensity > best.intensity) best = light;
  });
  return best;
}

/**
 * Build the shared palette by reading back what `lighting.ts` put on the scene.
 *
 * The lift factors here are the one place with real authored judgement in this
 * file. Preset fog/background colours are *very* dark — `dawn` is `0x13253e`,
 * which lands at about 0.02 linear. Rendered at that value the sky is still a
 * void; it is just a slightly different void. The reference frames put their
 * backgrounds roughly one and a half stops under the lit board, not eight, so
 * the haze is lifted hard and the horizon is lifted harder and pushed toward the
 * key colour.
 */
export function deriveEnvironmentPalette(scene: Scene, tuning: PaletteTuning = {}): EnvironmentPalette {
  const skyGain = tuning.skyGain ?? 1;
  const horizonWarmth = tuning.horizonWarmth ?? 0.36;
  const hazeGain = tuning.hazeGain ?? 1;

  const deep = new Color();
  if (scene.background instanceof Color) deep.copy(scene.background);
  else deep.copy(DEFAULT_DEEP);

  const fogColor = new Color();
  const fog = scene.fog;
  if (fog instanceof Fog || fog instanceof FogExp2) fogColor.copy(fog.color);
  else fogColor.copy(DEFAULT_HAZE);

  const key = firstKeyLight(scene);
  const sun = new Color();
  if (key) sun.copy(key.color);
  else sun.copy(DEFAULT_SUN);
  const sunIntensity = key ? key.intensity : 3;

  // Key travel direction. three's DirectionalLight shines from `position`
  // toward `target`, so the direction light *travels* is target − position.
  const sunDirection = new Vector3(0, -1, 0);
  if (key) {
    key.updateWorldMatrix(true, false);
    key.target.updateWorldMatrix(true, false);
    const from = new Vector3().setFromMatrixPosition(key.matrixWorld);
    const to = new Vector3().setFromMatrixPosition(key.target.matrixWorld);
    sunDirection.copy(to).sub(from);
    if (sunDirection.lengthSq() < 1e-8) sunDirection.set(0, -1, 0);
    sunDirection.normalize();
  }

  // ── hue first, brightness second ────────────────────────────────────────
  //
  // Mixing a preset's fog colour toward the raw key colour does not do what it
  // looks like it does: a key of `0xffae55` is 1.0 in the red channel, so a 14%
  // mix into a 0.02-linear fog adds 0.14 of full-scale red and the "subtle
  // warm tint" arrives as a cream wash. Normalise both to hue, mix the hues,
  // then set the level explicitly.
  const fogTint = tintOf(fogColor);
  const sunTint = tintOf(sun);
  const deepTint = tintOf(deep);

  const hazeTint = tintOf(fogTint.clone().lerp(sunTint, 0.16));
  const horizonTint = tintOf(hazeTint.clone().lerp(sunTint, horizonWarmth));
  const zenithTint = tintOf(hazeTint.clone().lerp(deepTint, 0.7));

  /** Distance haze — what far geometry desaturates into. */
  const haze = hazeTint.clone().multiplyScalar(HAZE_LEVEL * hazeGain);

  /** The brightest band in the sky, where the ground plate dissolves. */
  const horizon = horizonTint.clone().multiplyScalar(HORIZON_LEVEL * skyGain);

  /** Top of frame: cool and deep, but never the flat clear colour. */
  const zenith = zenithTint.clone().multiplyScalar(ZENITH_LEVEL * skyGain);

  /** Only visible below the horizon where the ground plate has faded out. */
  const ground = hazeTint.clone().lerp(deepTint, 0.45).multiplyScalar(GROUND_LEVEL * skyGain);

  return { zenith, horizon, haze, ground, sun, deep, sunDirection, sunIntensity };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sky
// ─────────────────────────────────────────────────────────────────────────────

export interface SkyOptions {
  /**
   * Screen-space height of the horizon band, 0 (bottom) … 1 (top). The
   * orchestrator recomputes this every frame from where the ground plate
   * actually vanishes, so sky and ground agree on where the world ends.
   */
  horizonY?: number;
  /** Strength of the sun bloom. */
  sunGlow?: number;
  /** Cloud-band contrast. Keep low — this is weather, not a feature. */
  bandStrength?: number;
}

const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Straight to clip space: this quad is the frame, not an object in the world.
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSun;
uniform vec2  uSunScreen;
uniform float uHorizonY;
uniform float uSunGlow;
uniform float uBandStrength;
uniform float uAspect;
uniform float uTime;

varying vec2 vUv;

${GLSL_NOISE}

void main() {
  float y = vUv.y;
  float above = clamp((y - uHorizonY) / max(1.0 - uHorizonY, 1e-3), 0.0, 1.0);
  float below = clamp((uHorizonY - y) / max(uHorizonY, 1e-3), 0.0, 1.0);

  // Two grades meeting at the horizon. The exponents are asymmetric on purpose:
  // sky falls off slowly (big soft dome), earth falls off fast (haze eats it).
  vec3 col = y >= uHorizonY
    ? mix(uHorizon, uZenith, pow(above, 0.62))
    : mix(uHorizon, uGround, pow(below, 0.55));

  // Horizon glow — a thin bright band, the single strongest "there is a world
  // out there" cue in a still frame.
  float band = exp(-abs(y - uHorizonY) * 26.0);
  col += uHorizon * band * 0.28;

  // Cloud banding. Stretched hard in x so it reads as strata, not as blobs, and
  // masked out near the horizon so it never fights the band.
  vec2 cp = vec2(vUv.x * 2.1 + uTime * 0.004, (y - uHorizonY) * 5.2 - uTime * 0.0015);
  float clouds = etFbm(cp, 4);
  clouds = smoothstep(0.42, 0.92, clouds);
  float cloudMask = smoothstep(0.02, 0.34, above) * (1.0 - smoothstep(0.55, 1.0, above));
  col = mix(col, mix(col, uHorizon, 0.55), clouds * cloudMask * uBandStrength);

  // Sun bloom, placed at the key light's screen position. Tight core, wide halo.
  vec2 d = (vUv - uSunScreen) * vec2(uAspect, 1.0);
  float r = length(d);
  col += uSun * (exp(-r * 7.5) * 0.85 + exp(-r * 1.9) * 0.22) * uSunGlow;

  // A very small amount of noise. An 8-bit display cannot resolve a smooth
  // gradient across 1080 rows and will band; the grain in post helps but the
  // sky is the one surface large enough to need its own dither.
  col += (etHash12(vUv * vec2(1927.0, 1081.0)) - 0.5) * 0.0022;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

/**
 * The graded sky plate. Add it to the scene once; it never moves and never
 * needs resizing beyond the aspect uniform.
 */
export class Sky {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  constructor(palette: EnvironmentPalette, options: SkyOptions = {}) {
    this.material = new ShaderMaterial({
      name: 'env-sky',
      uniforms: {
        uZenith: { value: palette.zenith.clone() },
        uHorizon: { value: palette.horizon.clone() },
        uGround: { value: palette.ground.clone() },
        uSun: { value: palette.sun.clone() },
        uSunScreen: { value: new Vector2(0.5, 0.86) },
        uHorizonY: { value: options.horizonY ?? 0.62 },
        uSunGlow: { value: options.sunGlow ?? 0.16 },
        uBandStrength: { value: options.bandStrength ?? 0.42 },
        uAspect: { value: 16 / 9 },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.name = 'env-sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10000;
    this.mesh.matrixAutoUpdate = false;
  }

  setPalette(palette: EnvironmentPalette): void {
    const u = this.material.uniforms;
    (u.uZenith!.value as Color).copy(palette.zenith);
    (u.uHorizon!.value as Color).copy(palette.horizon);
    (u.uGround!.value as Color).copy(palette.ground);
    (u.uSun!.value as Color).copy(palette.sun);
  }

  /** Screen fraction, 0 = bottom of frame. */
  setHorizon(y: number): void {
    this.material.uniforms.uHorizonY!.value = y;
  }

  /** Screen fraction of the sun bloom centre. */
  setSunScreen(x: number, y: number): void {
    (this.material.uniforms.uSunScreen!.value as Vector2).set(x, y);
  }

  setAspect(aspect: number): void {
    this.material.uniforms.uAspect!.value = aspect;
  }

  setSunGlow(v: number): void {
    this.material.uniforms.uSunGlow!.value = v;
  }

  update(elapsed: number): void {
    this.material.uniforms.uTime!.value = elapsed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
